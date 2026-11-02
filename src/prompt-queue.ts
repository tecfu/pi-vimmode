/**
 * Prompt queue owned by queue mode, backed by the durable model.
 *
 * Pi's own follow-up queue is not reachable from an extension (only
 * `hasPendingMessages()` is), so queue mode keeps its own ordered list and
 * hands one prompt to Pi when the session settles. The manager overlay edits
 * that list: delete, reorder, undo a delete, edit, or deliver an item now.
 *
 * Everything waiting lives in a `QueueLog` (src/queue-model.ts) and, when a
 * sink is attached, is written through to the session's queue file on every
 * change — which is what lets a queue outlive the process that filled it.
 */

import type {
  QueueAuthor,
  QueueAuthorVia,
  QueueDraft,
  QueueEntry,
  QueueLog,
  QueueOp,
} from "./queue-model.ts";
import type { QueueOpRecord } from "./queue-model.ts";

import {
  addDraft,
  alreadyApplied,
  applyOp,
  deleteEntry,
  editText,
  emptyQueueLog,
  markDelivered,
  moveEntry,
  nextDeliverable,
  pendingEntries,
  recordAppliedOp,
  restoreEntry,
  rollBackDelivery,
  sweepDropped,
} from "./queue-model.ts";

export type QueuedPrompt = {
  readonly id: string;
  readonly text: string;
};

export type QueueDirection = "up" | "down";

/** Where a queue's durable home is, if it has one. */
export type QueueSink = {
  save(log: QueueLog): void;
};

export type PromptQueueOptions = {
  /** Whose doing each change is, recorded per entry. */
  author?: (via: QueueAuthorVia) => QueueAuthor;
  sink?: QueueSink;
  now?: () => number;
};

/** Operations the queue manager overlay performs against the live queue. */
export type PromptQueueFacade = {
  list(): readonly QueuedPrompt[];
  /** The same pending view, with provenance: what the manager renders per row. */
  details(): readonly QueueEntry[];
  size(): number;
  remove(index: number): boolean;
  move(index: number, direction: QueueDirection): boolean;
  edit(index: number, text: string): boolean;
  undoRemove(): boolean;
  deliverNow(index: number): boolean;
};

function firstLine(text: string, limit = 120): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** One-line preview used by the manager overlay and status reporting. */
export function queuedPromptPreview(prompt: QueuedPrompt): string {
  const rest = prompt.text.includes("\n") ? " ⏎" : "";
  return `${firstLine(prompt.text)}${rest}`;
}

function asPrompt(entry: QueueEntry): QueuedPrompt {
  return { id: entry.id, text: entry.text };
}

export class PromptQueue {
  private log: QueueLog = emptyQueueLog();
  private lastRemovedId: string | undefined;
  private sink?: QueueSink;
  private readonly authorFor: (via: QueueAuthorVia) => QueueAuthor;
  private readonly clock: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(options: PromptQueueOptions = {}) {
    this.sink = options.sink;
    this.authorFor = options.author ?? ((via) => anonymousAuthor(via));
    this.clock = options.now ?? (() => Date.now());
  }

  /** Add a prompt, ignoring blank input. Returns the item, or nothing skipped. */
  enqueue(text: string, via: QueueAuthorVia = "key"): QueuedPrompt | undefined {
    const result = addDraft(
      this.log,
      { text, author: this.authorFor(via), createdAt: this.clock() },
      this.clock(),
    );
    if (!result.ok) return undefined;
    this.commit(result.log);
    const added = result.log.entries.at(-1);
    return added === undefined ? undefined : asPrompt(added);
  }

  list(): readonly QueuedPrompt[] {
    return pendingEntries(this.log).map(asPrompt);
  }

  /** Every entry, history included — what the agent-facing tool reads. */
  entries(): readonly QueueEntry[] {
    return this.log.entries;
  }

  get size(): number {
    return pendingEntries(this.log).length;
  }

  get revision(): number {
    return this.log.revision;
  }

  /** Remove and hand off the head without undo history (delivery path). */
  takeNext(): QueuedPrompt | undefined {
    const head = nextDeliverable(this.log);
    if (head === undefined) return undefined;
    const delivered = markDelivered(this.log, head.id, this.clock());
    if (!delivered.ok) return undefined;
    this.commit(delivered.log);
    return asPrompt(head);
  }

  removeAt(index: number): QueuedPrompt | undefined {
    const entry = pendingEntries(this.log)[index];
    if (entry === undefined) return undefined;
    const dropped = deleteEntry(this.log, entry.id);
    if (!dropped.ok) return undefined;
    this.lastRemovedId = entry.id;
    this.commit(dropped.log);
    return asPrompt(entry);
  }

  moveAt(index: number, direction: QueueDirection): boolean {
    const entry = pendingEntries(this.log)[index];
    if (entry === undefined) return false;
    const moved = moveEntry(this.log, entry.id, direction);
    if (!moved.ok) return false;
    this.commit(moved.log);
    return true;
  }

  editTextAt(index: number, text: string): boolean {
    const entry = pendingEntries(this.log)[index];
    if (entry === undefined) return false;
    const edited = editText(this.log, entry.id, text);
    if (!edited.ok) return false;
    this.commit(edited.log);
    return true;
  }

  /** Put the most recently deleted prompt back where it was. */
  undoRemove(): QueuedPrompt | undefined {
    const id = this.lastRemovedId;
    if (id === undefined) return undefined;
    const restored = restoreEntry(this.log, id);
    this.lastRemovedId = undefined;
    if (!restored.ok) return undefined;
    this.commit(restored.log);
    const entry = restored.log.entries.find((held) => held.id === id);
    return entry === undefined ? undefined : asPrompt(entry);
  }

  /** Drop everything that waits, keeping it as history the sweep will age out. */
  clear(): readonly QueuedPrompt[] {
    const waiting = pendingEntries(this.log);
    if (waiting.length === 0) return [];
    let log = this.log;
    for (const entry of waiting) log = deleteEntry(log, entry.id).log;
    this.lastRemovedId = undefined;
    this.commit(log);
    return waiting.map(asPrompt);
  }

  /** Age out deleted history so the file stays a queue and not a journal. */
  sweep(olderThan: number): QueueEntry[] {
    const { log, swept } = sweepDropped(this.log, olderThan);
    if (swept.length > 0) this.commit(log);
    return swept;
  }

  /**
   * Take a queue from disk (restart) or from another session (resume, peer
   * delegation). Entries keep their author, so provenance survives the move.
   */
  restore(log: QueueLog): void {
    this.log = log;
    this.lastRemovedId = undefined;
    this.notify();
  }

  getLog(): QueueLog {
    return this.log;
  }

  /**
   * Apply one operation to this queue, write-through and notifying. This is the only
   * mutation path: the human's keypress, the agent's tool call, and a peer's delegated op
   * all arrive here, so ordering, dedupe and the revision bump cannot diverge between them.
   */
  apply(op: QueueOp): { ok: boolean; reason?: string; revision: number } {
    const result = applyOp(this.log, op, this.clock());
    if (!result.ok) {
      return {
        ok: false,
        revision: this.log.revision,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      };
    }
    this.commit(result.log);
    return { ok: true, revision: result.log.revision };
  }

  /** Add an entry whose author came from somewhere else (a peer, a checkpoint). */
  add(draft: QueueDraft): { ok: boolean; reason?: string; id?: string } {
    const result = addDraft(this.log, draft, this.clock());
    if (!result.ok)
      return { ok: false, ...(result.reason === undefined ? {} : { reason: result.reason }) };
    this.commit(result.log);
    const added = result.log.entries.at(-1);
    return { ok: true, ...(added === undefined ? {} : { id: added.id }) };
  }

  /** Route a change that arrives as an operation record (peer post, checkpoint). */
  applyRecord(record: QueueOpRecord): "applied" | "satisfied" | "refused" {
    // Idempotence comes before anything else: a record the inbox hands over twice must land
    // once however far this queue has moved since, so the revision it was posted against is
    // deliberately not re-checked here. appliedOps is bounded, but a re-delivery after the
    // window would be caught by the content-addressed id anyway for an add.
    if (alreadyApplied(this.log, record.opId)) return "satisfied";
    if (record.op.kind === "add") {
      const added = addDraft(this.log, record.op.draft, record.at);
      if (!added.ok) return "refused";
      this.commit(recordAppliedOp(added.log, record));
      return "applied";
    }
    const result = applyOp(this.log, record.op, record.at);
    if (!result.ok) return "refused";
    this.commit(recordAppliedOp(result.log, record));
    return "applied";
  }

  attach(sink: QueueSink | undefined): void {
    this.sink = sink;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** View over the queue for the manager overlay (Pi delivery stays in lifecycle). */
  facade(deliver: (prompt: QueuedPrompt) => boolean): PromptQueueFacade {
    return {
      list: () => this.list(),
      details: () => pendingEntries(this.log),
      size: () => this.size,
      remove: (index) => this.removeAt(index) !== undefined,
      move: (index, direction) => this.moveAt(index, direction),
      edit: (index, text) => this.editTextAt(index, text),
      undoRemove: () => this.undoRemove() !== undefined,
      deliverNow: (index) => this.deliverIndex(index, deliver),
    };
  }

  /**
   * Send one entry now. The record is marked delivered and written before the
   * send: a duplicate that a crash makes visible is recoverable, an endless
   * retry loop is not.
   */
  private deliverIndex(index: number, deliver: (prompt: QueuedPrompt) => boolean): boolean {
    const entry = pendingEntries(this.log)[index];
    if (entry === undefined) return false;
    const delivered = markDelivered(this.log, entry.id, this.clock());
    if (!delivered.ok) return false;
    this.commit(delivered.log);
    let sent = false;
    try {
      sent = deliver(asPrompt(entry));
    } catch {
      sent = false;
    }
    if (sent) {
      this.lastRemovedId = undefined;
      return true;
    }
    this.commit(rollBackDelivery(this.log, entry.id).log);
    return false;
  }

  private commit(log: QueueLog): void {
    this.log = log;
    this.sink?.save(log);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function anonymousAuthor(via: QueueAuthorVia): QueueAuthor {
  return { session: "human", sessionId: "", cwd: "", via };
}

export type { QueueAuthor, QueueAuthorVia, QueueEntry, QueueLog, QueueOp };
