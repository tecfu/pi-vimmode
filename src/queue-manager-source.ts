import {
  queuedPromptPreview,
  type PromptQueueFacade,
  type QueueDirection,
} from "./prompt-queue.ts";
import { queueAgeLabel, type QueueAuthorVia, type QueueEntry } from "./queue-model.ts";

/**
 * What the manager overlay displays and edits. One interface, two implementations:
 * `facadeQueueSource` reads the queue this session holds in memory, and
 * `QueueManagerView` adds the durable store — another session's file, and the
 * delegated ops that edit it.
 */
export type QueueManagerRow = {
  readonly id: string;
  readonly preview: string;
  /** The whole prompt, newlines included: what `e` opens. */
  readonly text: string;
  readonly author: string;
  readonly via: QueueAuthorVia;
  readonly kind: QueueEntry["kind"];
  readonly age: string;
  /** True when the row lives in another session's queue file. */
  readonly peer: boolean;
};

/** A queue another session owns, as the manager lists them. */
export type QueueManagerSession = {
  readonly sessionId: string;
  readonly label: string;
  readonly pending: number;
  readonly alive: boolean;
  readonly self: boolean;
};

/** The outcome of an edit, phrased for the manager's status line. */
export type QueueManagerOutcome = {
  readonly ok: boolean;
  readonly reason?: string;
};

export interface QueueManagerSource {
  rows(): readonly QueueManagerRow[];
  /** The queue being shown: undefined is this session's own. */
  focused(): string | undefined;
  focus(session: string | undefined): void;
  /** Other sessions with a queue file, this one first. */
  sessions(): readonly QueueManagerSession[];
  move(index: number, direction: QueueDirection): QueueManagerOutcome;
  remove(index: number): QueueManagerOutcome;
  undo(): QueueManagerOutcome;
  deliver(index: number): QueueManagerOutcome;
  replace(index: number, text: string): QueueManagerOutcome;
}

export function accepted(): QueueManagerOutcome {
  return { ok: true };
}

export function declined(reason: string): QueueManagerOutcome {
  return { ok: false, reason };
}

/**
 * How an entry got here, in the few words a row has room for. `self` is whether the
 * queue being shown belongs to the session looking at it: a keystroke in somebody
 * else's queue is still *their* keystroke, so it reads as a message from them.
 */
export function originLabel(via: QueueAuthorVia, author: string, self: boolean): string {
  if (via === "checkpoint") return "checkpoint";
  if (via === "peer") return `from ${author}`;
  if (!self) return via === "tool" ? `agent · ${author}` : `from ${author}`;
  return via === "key" || via === "ex" ? "you" : "agent";
}

/** Provenance for a row comes from the entry, not the trimmed `QueuedPrompt` view. */
export function managerRowFor(entry: QueueEntry, now: number, peer: boolean): QueueManagerRow {
  return {
    id: entry.id,
    preview: queuedPromptPreview({ id: entry.id, text: entry.text }),
    text: entry.text,
    author: entry.author.session,
    via: entry.author.via,
    kind: entry.kind,
    age: queueAgeLabel(entry.createdAt, now),
    peer,
  };
}

/**
 * A source over the in-memory queue alone: no store, no peers. This is what a
 * harness or an editor without session context shows, and it keeps the manager
 * working when `piVimMode.queueDir` points nowhere.
 */
export function facadeQueueSource(
  queue: PromptQueueFacade,
  now: () => number = Date.now,
): QueueManagerSource {
  return {
    rows: () => queue.details().map((entry) => managerRowFor(entry, now(), false)),
    focused: () => undefined,
    focus: () => {},
    sessions: () => [{ sessionId: "", label: "this session", pending: 0, alive: true, self: true }],
    move: (index, direction) =>
      queue.move(index, direction) ? accepted() : declined("cannot move"),
    remove: (index) => (queue.remove(index) ? accepted() : declined("nothing to delete")),
    undo: () => (queue.undoRemove() ? accepted() : declined("nothing to restore")),
    deliver: (index) => (queue.deliverNow(index) ? accepted() : declined("nothing to send")),
    replace: (index, text) => (queue.edit(index, text) ? accepted() : declined("nothing to edit")),
  };
}
