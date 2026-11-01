/**
 * The prompt queue's data model: entries that know who wrote them and when,
 * plus the pure operations the manager overlay, the agent-facing tool, and
 * delegated peer edits all share.
 *
 * Nothing here touches the filesystem — `src/queue-store.ts` owns persistence,
 * and every shape is deliberately plain JSON so an entry can be written to a
 * file, posted into another session's inbox, or returned from a tool call
 * unchanged. See
 * docs/plans/2026-11-01-001-feat-agent-visible-prompt-queue-plan.md.
 */

import { createHash } from "node:crypto";

export type QueueEntryKind = "prompt" | "note";
export type QueueEntryState = "pending" | "delivered" | "dropped";
/** What created the entry: a keypress, a tool call, a peer, a checkpoint, Ex. */
export type QueueAuthorVia = "key" | "tool" | "peer" | "checkpoint" | "ex";
export type QueueDirection = "up" | "down";

/** How many applied operation ids a queue remembers for idempotence. */
export const MAX_APPLIED_OPS = 256;

export type QueueAuthor = {
  readonly session: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly via: QueueAuthorVia;
};

export type QueueEntry = {
  readonly id: string;
  readonly text: string;
  readonly kind: QueueEntryKind;
  readonly createdAt: number;
  readonly author: QueueAuthor;
  readonly state: QueueEntryState;
  readonly deliveredAt?: number;
  readonly attempts: number;
  readonly replyTo?: string;
};

/** An entry that has not been given an id yet — what a caller supplies. */
export type QueueDraft = {
  readonly text: string;
  readonly author: QueueAuthor;
  readonly kind?: QueueEntryKind;
  readonly createdAt?: number;
  readonly replyTo?: string;
};

/** One mutation. Everything a peer may ask the owner to do, and nothing more. */
export type QueueOp =
  | { readonly kind: "add"; readonly draft: QueueDraft }
  | { readonly kind: "delete"; readonly id: string }
  | { readonly kind: "restore"; readonly id: string }
  | { readonly kind: "release"; readonly id: string }
  | { readonly kind: "edit"; readonly id: string; readonly text: string }
  | { readonly kind: "move"; readonly id: string; readonly direction: QueueDirection };

/** The on-disk/inbox form of an op: who asked, against which revision. */
export type QueueOpRecord = {
  readonly formatVersion: 1;
  readonly opId: string;
  readonly at: number;
  readonly origin: { readonly session: string; readonly sessionId: string; readonly cwd: string };
  readonly target: { readonly sessionId: string; readonly revision: number };
  readonly op: QueueOp;
};

/** Audit entry: a delegated op this queue applied. */
export type AppliedOp = {
  readonly opId: string;
  readonly at: number;
  readonly origin: string;
  readonly kind: QueueOp["kind"];
};

export type QueueLog = {
  readonly entries: readonly QueueEntry[];
  readonly revision: number;
  readonly appliedOps: readonly AppliedOp[];
};

export type OpResult = { readonly log: QueueLog; readonly ok: boolean; readonly reason?: string };

/**
 * The delivery unit. A `note` is context a human or the model releases by hand,
 * so it is never picked up by the drain on its own.
 */
export function emptyQueueLog(): QueueLog {
  return { entries: [], revision: 0, appliedOps: [] };
}

/**
 * Content-addressed id. It is what makes an entry that arrives twice — by file
 * and by wake message — change the queue once, and what makes rehydrating a
 * session after a restart not invent duplicates. Surrounding whitespace is not
 * part of the ask, so it is trimmed here exactly as it is stored.
 */
export function entryIdFor(draft: QueueDraft): string {
  const createdAt = draft.createdAt ?? 0;
  const key = `${draft.author.sessionId}\n${createdAt}\n${draft.text.trim()}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function makeEntry(draft: QueueDraft, now: number): QueueEntry {
  const createdAt = draft.createdAt ?? now;
  return {
    id: entryIdFor({ ...draft, createdAt }),
    text: draft.text.trim(),
    kind: draft.kind ?? "prompt",
    createdAt,
    author: draft.author,
    state: "pending",
    attempts: 0,
    ...(draft.replyTo === undefined ? {} : { replyTo: draft.replyTo }),
  };
}

export function pendingEntries(log: QueueLog): QueueEntry[] {
  return log.entries.filter((entry) => entry.state === "pending");
}

/** The head of the pending prompts — what the next settle should deliver. */
export function nextDeliverable(log: QueueLog): QueueEntry | undefined {
  return pendingEntries(log).find((entry) => entry.kind === "prompt");
}

export function findEntry(log: QueueLog, id: string): QueueEntry | undefined {
  return log.entries.find((entry) => entry.id === id);
}

function replace(log: QueueLog, entries: readonly QueueEntry[]): QueueLog {
  return { entries, revision: log.revision + 1, appliedOps: log.appliedOps };
}

function mapEntry(
  log: QueueLog,
  id: string,
  transform: (entry: QueueEntry) => QueueEntry,
): OpResult {
  if (!log.entries.some((entry) => entry.id === id)) {
    return { log, ok: false, reason: `no queued entry with id ${id}` };
  }
  return {
    log: replace(
      log,
      log.entries.map((entry) => (entry.id === id ? transform(entry) : entry)),
    ),
    ok: true,
  };
}

/** Add an entry, ignoring blank text and an id this queue already holds. */
export function addDraft(log: QueueLog, draft: QueueDraft, now: number): OpResult {
  if (draft.text.trim().length === 0) return { log, ok: false, reason: "empty prompt" };
  const entry = makeEntry(draft, now);
  if (log.entries.some((held) => held.id === entry.id))
    return { log, ok: false, reason: "duplicate" };
  return { log: replace(log, [...log.entries, entry]), ok: true };
}

/** Deletes keep the entry as history (R2's audit trail); `u` restores one. */
export function deleteEntry(log: QueueLog, id: string): OpResult {
  const entry = findEntry(log, id);
  if (entry === undefined) return { log, ok: false, reason: `no queued entry with id ${id}` };
  if (entry.state !== "pending")
    return { log, ok: false, reason: `entry ${id} is already ${entry.state}` };
  return mapEntry(log, id, (held) => ({ ...held, state: "dropped" }));
}

export function restoreEntry(log: QueueLog, id: string): OpResult {
  const entry = findEntry(log, id);
  if (entry === undefined) return { log, ok: false, reason: `no queued entry with id ${id}` };
  if (entry.state !== "dropped") return { log, ok: false, reason: `entry ${id} is not dropped` };
  return mapEntry(log, id, (held) => ({ ...held, state: "pending" }));
}

export function editText(log: QueueLog, id: string, text: string): OpResult {
  if (text.trim().length === 0) return { log, ok: false, reason: "empty prompt" };
  const entry = findEntry(log, id);
  if (entry === undefined) return { log, ok: false, reason: `no queued entry with id ${id}` };
  if (entry.state !== "pending") return { log, ok: false, reason: `entry ${id} is ${entry.state}` };
  return mapEntry(log, id, (held) => ({ ...held, text: text.trim() }));
}

/**
 * Swap an entry with its neighbour in the *pending* view, so a queue holding
 * delivered history still reorders the way the manager displays it.
 */
export function moveEntry(log: QueueLog, id: string, direction: QueueDirection): OpResult {
  const pendingAt = log.entries.findIndex((entry) => entry.id === id && entry.state === "pending");
  if (pendingAt < 0) return { log, ok: false, reason: `entry ${id} is not pending` };
  const pendingIndices = log.entries
    .map((entry, index) => (entry.state === "pending" ? index : -1))
    .filter((index) => index >= 0);
  const view = pendingIndices.indexOf(pendingAt);
  const swapWith = pendingIndices[direction === "up" ? view - 1 : view + 1];
  if (swapWith === undefined) return { log, ok: false, reason: "already at that end" };
  const entries = [...log.entries];
  const held = entries[pendingAt];
  const other = entries[swapWith];
  if (held === undefined || other === undefined)
    return { log, ok: false, reason: "already at that end" };
  entries[pendingAt] = other;
  entries[swapWith] = held;
  return { log: replace(log, entries), ok: true };
}

/** Record the send before performing it, so a crash cannot loop delivery. */
export function markDelivered(log: QueueLog, id: string, at: number): OpResult {
  const entry = findEntry(log, id);
  if (entry === undefined) return { log, ok: false, reason: `no queued entry with id ${id}` };
  if (entry.state !== "pending")
    return { log, ok: false, reason: `entry ${id} is already ${entry.state}` };
  return mapEntry(log, id, (held) => ({ ...held, state: "delivered", deliveredAt: at }));
}

/** A send that threw puts the entry back, but counted, and it is not retried again. */
export function rollBackDelivery(log: QueueLog, id: string): OpResult {
  return mapEntry(log, id, (held) => ({
    ...held,
    state: "pending",
    attempts: held.attempts + 1,
    deliveredAt: undefined,
  }));
}

/**
 * Release a held note: it becomes a deliverable prompt, so the next settle (or
 * an immediate `deliver_now`) sends it. This is the only way a note starts a
 * turn on its own, which is what makes it safe to post one into a busy queue.
 */
export function releaseNote(log: QueueLog, id: string): OpResult {
  const entry = findEntry(log, id);
  if (entry === undefined) return { log, ok: false, reason: `no queued entry with id ${id}` };
  if (entry.kind === "prompt") return { log, ok: false, reason: `entry ${id} is already a prompt` };
  return mapEntry(log, id, (held) => ({ ...held, kind: "prompt" }));
}

export function applyOp(log: QueueLog, op: QueueOp, now: number): OpResult {
  switch (op.kind) {
    case "add":
      return addDraft(log, op.draft, now);
    case "delete":
      return deleteEntry(log, op.id);
    case "restore":
      return restoreEntry(log, op.id);
    case "edit":
      return editText(log, op.id, op.text);
    case "move":
      return moveEntry(log, op.id, op.direction);
    case "release":
      return releaseNote(log, op.id);
  }
}

/**
 * Idempotence key for a request. Retrying the same ask from the same session
 * produces the same id, so a record that is read twice changes the queue once.
 */
export function opIdFor(origin: QueueOpRecord["origin"], at: number, op: QueueOp): string {
  return createHash("sha256")
    .update(JSON.stringify([origin.sessionId, at, op]))
    .digest("hex")
    .slice(0, 12);
}

export function makeOpRecord(
  origin: QueueOpRecord["origin"],
  target: QueueOpRecord["target"],
  op: QueueOp,
  at: number,
): QueueOpRecord {
  return { formatVersion: 1, opId: opIdFor(origin, at, op), at, origin, target, op };
}

export function alreadyApplied(log: QueueLog, opId: string): boolean {
  return log.appliedOps.some((applied) => applied.opId === opId);
}

export function recordAppliedOp(log: QueueLog, record: QueueOpRecord): QueueLog {
  const applied: AppliedOp = {
    opId: record.opId,
    at: record.at,
    origin: record.origin.session || record.origin.sessionId.slice(0, 8),
    kind: record.op.kind,
  };
  return {
    entries: log.entries,
    revision: log.revision,
    appliedOps: [...log.appliedOps, applied].slice(-MAX_APPLIED_OPS),
  };
}

/** Age out dropped history so the file stays a queue and not a journal. */
export function sweepDropped(
  log: QueueLog,
  olderThan: number,
): { log: QueueLog; swept: QueueEntry[] } {
  const swept = log.entries.filter(
    (entry) => entry.state === "dropped" && entry.createdAt < olderThan,
  );
  if (swept.length === 0) return { log, swept: [] };
  const entries = log.entries.filter((entry) => !swept.some((gone) => gone.id === entry.id));
  return { log: { entries, revision: log.revision + 1, appliedOps: log.appliedOps }, swept };
}

export function queueAgeLabel(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
