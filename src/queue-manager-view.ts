import type {
  QueueManagerRow,
  QueueManagerSession,
  QueueManagerSource,
} from "./queue-manager-source.ts";
import type { QueueRow, QueueService } from "./queue-service.ts";

import {
  queuedPromptPreview,
  type PromptQueueFacade,
  type QueueDirection,
} from "./prompt-queue.ts";
import { accepted, declined } from "./queue-manager-source.ts";

/**
 * The manager's view over every queue this machine has files for: the session's own,
 * and each peer's. Reading a peer is direct — a read cannot corrupt anything. Editing
 * one is not: a peer mutation is posted as an op the peer applies to its own file, so
 * one writer per file holds even while the manager appears to edit somebody else's
 * queue. `peerTrust: "manual"` leaves that posted edit unread, which is the point.
 */
export class QueueManagerView implements QueueManagerSource {
  private peer: string | undefined;

  constructor(
    private readonly deps: {
      service: () => QueueService;
      local: PromptQueueFacade;
      selfLabel?: () => string;
    },
  ) {}

  rows(): readonly QueueManagerRow[] {
    const focused = this.peer;
    return this.deps
      .service()
      .rowsFor(focused)
      .map((row) => toRow(row, focused !== undefined));
  }

  focused(): string | undefined {
    return this.peer;
  }

  /** Naming a session the store does not know keeps the current focus. */
  focus(session: string | undefined): void {
    if (session === undefined) {
      this.peer = undefined;
      return;
    }
    const known = this.sessions().find((entry) => entry.sessionId === session);
    if (known !== undefined && !known.self) this.peer = session;
  }

  /** This session first, then the rest: the order `[/]` cycles through. */
  sessions(): readonly QueueManagerSession[] {
    const rows = this.deps
      .service()
      .queueSessions()
      .map((queue) => ({
        sessionId: queue.sessionId,
        label: queue.self
          ? (this.deps.selfLabel?.() ?? "this session")
          : queueLabel(queue.sessionId, queue.name),
        pending: queue.pending,
        alive: queue.alive,
        self: queue.self,
      }));
    return [...rows.filter((row) => row.self), ...rows.filter((row) => !row.self)];
  }

  move(index: number, direction: QueueDirection) {
    const row = this.rows()[index];
    if (row === undefined) return declined("nothing to move");
    if (this.peer === undefined)
      return outcome(this.deps.local.move(index, direction), "cannot move");
    return outcome(this.deps.service().move(row.id, direction, this.peer), "cannot move");
  }

  remove(index: number) {
    const row = this.rows()[index];
    if (row === undefined) return declined("nothing to delete");
    if (this.peer === undefined) return outcome(this.deps.local.remove(index), "nothing to delete");
    return outcome(this.deps.service().delete(row.id, this.peer), "nothing to delete");
  }

  undo() {
    if (this.peer !== undefined) return declined("undo restores your own deletions");
    return outcome(this.deps.local.undoRemove(), "nothing to restore");
  }

  deliver(index: number) {
    const row = this.rows()[index];
    if (row === undefined) return declined("nothing to send");
    if (this.peer !== undefined) return declined(`${row.id} belongs to another session`);
    return outcome(this.deps.local.deliverNow(index), "nothing to send");
  }

  replace(index: number, text: string) {
    const row = this.rows()[index];
    if (row === undefined) return declined("nothing to edit");
    if (this.peer === undefined)
      return outcome(this.deps.local.edit(index, text), "nothing to edit");
    return outcome(this.deps.service().edit(row.id, text, this.peer), "nothing to edit");
  }
}

/** A queue's name, or its id's head, or its directory: whichever the store knows. */
function queueLabel(sessionId: string, name: string | undefined): string {
  return name !== undefined && name.length > 0 ? name : sessionId.slice(0, 8);
}

function toRow(row: QueueRow, peer: boolean): QueueManagerRow {
  return {
    id: row.id,
    preview: queuedPromptPreview({ id: row.id, text: row.text }),
    text: row.text,
    author: row.author,
    via: row.via,
    kind: row.kind,
    age: row.age,
    peer,
  };
}

function outcome(
  result: boolean | { applied?: string; reason?: string },
  fallback: string,
): ReturnType<typeof accepted> {
  if (typeof result === "boolean") return result ? accepted() : declined(fallback);
  if (result.applied === "refused") return declined(result.reason ?? fallback);
  return accepted();
}
