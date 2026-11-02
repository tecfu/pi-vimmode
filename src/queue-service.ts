import type { PromptQueue } from "./prompt-queue.ts";
import type {
  QueueAuthor,
  QueueAuthorVia,
  QueueDirection,
  QueueDraft,
  QueueEntry,
  QueueLog,
  QueueOp,
  QueueOpRecord,
} from "./queue-model.ts";
import type { PeerKnocker } from "./queue-peer.ts";
import type { QueueIdentity, QueuePaths, QueueSummary } from "./queue-store.ts";

import { applyOp, makeOpRecord, pendingEntries } from "./queue-model.ts";
import { resolvePeer, sessionsFromQueues, wakeMessage } from "./queue-peer.ts";
import {
  claimDeadOwner,
  claimOf,
  dropOp,
  listArchive,
  listQueues,
  sweepStore,
  newEnvelope,
  postOp,
  readArchive,
  readEnvelope,
  readOps,
  writeArchive,
  writeEnvelope,
} from "./queue-store.ts";

/** How the queue changed hands. `delegated` is the normal answer for a peer. */
export type AppliedVia = "direct" | "delegated" | "refused";

export type QueueActionResult = {
  applied: AppliedVia;
  reason?: string;
  /** Whose queue moved, which differs from the caller when the call targeted a peer. */
  session?: string;
  revision?: number;
  entryId?: string;
  count?: number;
};

export type CheckpointCapture = {
  /** Session-branch snapshot: what the agent was actually looking at. */
  branch: Array<{ entryId: string; role: string; text: string }>;
  leafId: string | null;
};

export interface QueueServiceDeps {
  paths: QueuePaths;
  /** This session's live queue. It owns the log and the write-through to disk. */
  queue: PromptQueue;
  identity: () => QueueIdentity;
  /** Who this session's changes are attributed to; the same author the queue itself uses. */
  author: (via: QueueAuthorVia) => QueueAuthor;
  now?: () => number;
  /** Null when pi-intercom is not loaded; posting then still works, without a knock. */
  knocker?: () => PeerKnocker | null;
  /** Auto lets peers both post and mutate; manual makes any delegated op refuse. */
  peerTrust: "auto" | "manual";
  /** Hours before a dropped entry or an unread inbox op is archived; see `sweep`. */
  ttlHours?: number;
  takeoverAfterMs?: number;
  /** Nudge this session's delivery loop; a no-op while the agent is busy. */
  flush?: () => void;
  /** Snapshot the session branch, for a checkpoint. Absent means checkpoints refuse. */
  captureBranch?: () => CheckpointCapture | undefined;
}

const DEFAULT_TAKEOVER_AFTER_MS = 60_000;
/** One day: long enough to change your mind, short enough that the archive is the history. */
const DEFAULT_TTL_HOURS = 24;

type PeerAddress = { sessionId: string; name: string; claim: string };

/**
 * The queue as the fleet sees it.
 *
 * One session's queue is the live `PromptQueue` — this class never keeps a second copy of
 * it. What it adds is *addressing*: the same `QueueOp` that the human's keypresses produce
 * is applied in place when it targets this session and posted to another session's inbox
 * when it targets theirs. Reading a peer is direct (a file read cannot corrupt anything);
 * writing a peer goes through delegation, or through takeover when the peer's process is
 * provably gone. See docs/adr/0005-prompt-queue-owns-its-store.md.
 */
export class QueueService {
  private readonly deps: Required<Pick<QueueServiceDeps, "now" | "takeoverAfterMs">> &
    QueueServiceDeps;

  constructor(deps: QueueServiceDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      takeoverAfterMs: deps.takeoverAfterMs ?? DEFAULT_TAKEOVER_AFTER_MS,
    };
  }

  /** Where this service's store lives. Tests post into the inbox through it. */
  get root(): string {
    return this.deps.paths.root;
  }

  entries(): readonly QueueEntry[] {
    return this.deps.queue.entries();
  }

  log(): QueueLog {
    return this.deps.queue.getLog();
  }

  /**
   * Put this session's file on disk if it is not there yet. Without it the session is not
   * merely empty to its peers, it is unaddressable — posting routes by what the store lists.
   * Lifecycle calls this where a session starts; the mutation paths call it too, because a
   * queue that has never been touched has nothing to route to.
   */
  claim(): void {
    const identity = this.deps.identity();
    if (identity.sessionId.length === 0) return;
    if (readEnvelope(this.deps.paths.root, identity.sessionId, this.deps.now()) === undefined) {
      writeEnvelope(this.deps.paths.root, newEnvelope(identity, this.log(), this.deps.now()));
    }
  }

  /**
   * Age out what stopped being a decision: entries deleted before the window closed, and ops
   * posted to a session that never woke up to read them. Both land in `archive/`, so
   * `restore_checkpoint` and `list_checkpoints` still find them; `ttlHours` is the only knob.
   */
  sweep(now = this.deps.now()): { archivedEntries: number; archivedOps: number } {
    const ttlMs = (this.deps.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000;
    const swept = sweepStore(this.deps.paths.root, ttlMs, now);
    this.deps.queue.sweep(now - ttlMs);
    return { archivedEntries: swept.archivedEntries.length, archivedOps: swept.archivedOps.length };
  }

  /** The pending view, in delivery order — what an index addresses. */
  pending(): QueueEntry[] {
    return pendingEntries(this.log());
  }

  /**
   * Ids are canonical and work across sessions. An index is a pointer into *this* session's
   * pending view, because an index into a peer's queue races with everything else that
   * touches it; a peer address with an index refuses rather than guessing.
   */
  resolveId(
    id: string | undefined,
    index: number | undefined,
    session?: string,
  ): string | undefined {
    if (typeof id === "string" && id.trim().length > 0) return id.trim();
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
    if (session !== undefined && !this.isSelf(session)) return undefined;
    return this.pending()[index]?.id;
  }

  list(options: { includeDropped?: boolean; session?: string } = {}): unknown {
    if (options.session !== undefined && !this.isSelf(options.session))
      return this.inspect(options.session);
    const identity = this.deps.identity();
    const log = this.log();
    const rows = (entries: readonly QueueEntry[]) =>
      entries.map((entry) => describe(entry, this.deps.now()));
    return {
      session: identity.name,
      sessionId: identity.sessionId,
      revision: log.revision,
      alive: true,
      pending: rows(pendingEntries(log)),
      delivered: rows(log.entries.filter((entry) => entry.state === "delivered")),
      ...(options.includeDropped === true
        ? { dropped: rows(log.entries.filter((entry) => entry.state === "dropped")) }
        : {}),
    };
  }

  sessions(): unknown {
    return {
      self: this.deps.identity().name,
      sessions: sessionsFromQueues(
        listQueues(this.deps.paths.root),
        this.deps.identity().sessionId,
      ),
    };
  }

  /** Read a peer's queue file. Direct, because a read cannot corrupt anything. */
  inspect(session: string): unknown {
    const target = resolvePeer(this.peers(), session).found;
    if (target === undefined) {
      return refused(
        this.peers().some((peer) => peer.name === session)
          ? "session name is ambiguous"
          : "no queue for that session",
      );
    }
    const envelope = readEnvelope(this.deps.paths.root, target.sessionId, this.deps.now());
    if (envelope === undefined) return refused(`no queue file for ${target.name ?? session}`);
    return {
      applied: "direct" as AppliedVia,
      session: envelope.name,
      sessionId: envelope.sessionId,
      revision: envelope.log.revision,
      alive: target.alive,
      pending: pendingEntries(envelope.log).map((entry) => describe(entry, this.deps.now())),
      lastSeen: envelope.updatedAt,
    };
  }

  enqueue(input: { text: string; kind?: "prompt" | "note"; session?: string }): QueueActionResult {
    const draft: QueueDraft = {
      text: input.text,
      author: this.deps.author("tool"),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      createdAt: this.deps.now(),
    };
    return this.mutate({ kind: "add", draft }, input.session);
  }

  delete(id: string, session?: string): QueueActionResult {
    return this.mutate({ kind: "delete", id }, session);
  }

  restore(id: string, session?: string): QueueActionResult {
    return this.mutate({ kind: "restore", id }, session);
  }

  release(id: string, session?: string): QueueActionResult {
    return this.mutate({ kind: "release", id }, session);
  }

  edit(id: string, text: string, session?: string): QueueActionResult {
    return this.mutate({ kind: "edit", id, text }, session);
  }

  move(id: string, direction: QueueDirection, session?: string): QueueActionResult {
    return this.mutate({ kind: "move", id, direction }, session);
  }

  /**
   * Try to deliver the head now. Only ever this session's queue: pushing a turn into
   * another session would be the steer path the design rules out — a peer that wants to be
   * read now posts an op and waits to be woken, like everything else.
   */
  deliverNow(session?: string): QueueActionResult {
    if (session !== undefined && !this.isSelf(session)) {
      return refused(
        "deliver_now applies to this session only; post an op to that session instead",
      );
    }
    this.deps.flush?.();
    return { applied: "direct", session: this.deps.identity().name };
  }

  /** Freeze the queue and the session branch together, under one name. */
  checkpoint(name: string): QueueActionResult & { checkpoint?: string } {
    const capture = this.deps.captureBranch?.();
    if (capture === undefined) return refused("no session context to checkpoint");
    const identity = this.deps.identity();
    const id = `${sanitize(name)}-${identity.sessionId.slice(0, 8)}`;
    const log = this.log();
    writeArchive(this.deps.paths.root, "checkpoint", id, {
      formatVersion: 1,
      id,
      name,
      at: this.deps.now(),
      session: identity,
      entries: log.entries,
      branch: capture.branch,
      leafId: capture.leafId,
    });
    return { applied: "direct", checkpoint: id, count: pendingEntries(log).length };
  }

  /** Checkpoint names this store holds, newest first as the archive lists them. */
  checkpoints(): unknown {
    return {
      applied: "direct",
      session: this.deps.identity().name,
      checkpoints: listArchive(this.deps.paths.root, "checkpoint"),
    };
  }

  /**
   * Bring a checkpoint's entries back. Restoring a still-queued entry is a no-op, because
   * the id is content-addressed — which is what makes `all: true` always safe.
   */
  restoreCheckpoint(checkpoint: string, all: boolean): QueueActionResult {
    const payload = readArchive(this.deps.paths.root, "checkpoint", checkpoint) as
      | { entries?: QueueEntry[] }
      | undefined;
    const entries = payload?.entries;
    if (!Array.isArray(entries)) return refused(`no checkpoint named ${checkpoint}`);
    // "Not everything" means what is not *still* waiting here, not what the archive
    // happened to record: an entry pending when the checkpoint was taken and dropped
    // since must come back, and one still pending must not.
    const waiting = new Set(pendingEntries(this.log()).map((entry) => entry.id));
    const chosen = all ? entries : entries.filter((entry) => !waiting.has(entry.id));
    let applied = 0;
    for (const entry of chosen) {
      // An entry the queue still holds — dropped or delivered — comes back through
      // `restore`, which is the op that flips its state without inventing a second row
      // with the same id. Only an entry the sweep already aged out needs re-adding.
      const held = this.log().entries.find((candidate) => candidate.id === entry.id);
      const op: QueueOp =
        held === undefined
          ? {
              kind: "add",
              draft: {
                text: entry.text,
                author: entry.author,
                kind: entry.kind,
                createdAt: entry.createdAt,
              },
            }
          : { kind: "restore", id: entry.id };
      if (this.mutate(op).applied === "direct") applied += 1;
    }
    return { applied: "direct", count: applied, session: this.deps.identity().name };
  }

  /** Unapplied ops addressed to this session by any of its claims. */
  pendingOps(): QueueOpRecord[] {
    return this.pendingOpsFor(claimOf(this.deps.identity()));
  }

  /** Ops waiting under particular claims — exposed so a drain's effect is inspectable. */
  pendingOpsFor(claims: readonly string[]): QueueOpRecord[] {
    return readOps(this.deps.paths.root, claims);
  }

  /**
   * Apply the inbox, oldest first, through the same queue object the human drives. A
   * refused record is dropped as well as answered: leaving it would make every later drain
   * reconsider a dead request.
   */
  drainOps(): { applied: number; refused: number } {
    const claims = claimOf(this.deps.identity());
    const ops = readOps(this.deps.paths.root, claims);
    let applied = 0;
    let refusedCount = 0;
    for (const record of ops) {
      // Under manual trust nothing is applied and nothing is dropped: the record stays in
      // the inbox for a human to release, and is counted as refused for this drain only.
      if (this.deps.peerTrust === "manual") {
        refusedCount += 1;
        continue;
      }
      // A duplicate is satisfied, not refused: the work it asked for is already in the log.
      if (this.deps.queue.applyRecord(record) === "refused") refusedCount += 1;
      else applied += 1;
      dropOp(this.deps.paths.root, claims, record.opId);
    }
    if (applied > 0) this.deps.flush?.();
    return { applied, refused: refusedCount };
  }

  /** Read a peer queue's summary, for reporting only. */
  summary(session: string): QueueSummary | undefined {
    const target = resolvePeer(this.peers(), session).found;
    if (target === undefined) return undefined;
    return listQueues(this.deps.paths.root).find((queue) => queue.sessionId === target.sessionId);
  }

  /**
   * Claim a queue whose owner is gone and apply an op to it directly. This is the only path
   * that writes another session's file, and it refuses unless the owner's pid is dead and
   * its last write is older than the takeover window.
   */
  takeover(session: string, op: QueueOp): QueueActionResult {
    const target = resolvePeer(this.peers(), session).found;
    if (target === undefined) return refused("no queue for that session");
    const claimed = claimDeadOwner(
      this.deps.paths.root,
      target.sessionId,
      this.deps.takeoverAfterMs,
      this.deps.now(),
    );
    if (!claimed.ok) return refused(claimed.reason);
    // A dead session's log is applied here and only here: the owner's own queue object never
    // sees it, because there is no owner left to see it with.
    const now = this.deps.now();
    const result = applyOp(claimed.envelope.log, op, now);
    if (!result.ok) return refused(result.reason ?? "refused");
    writeEnvelope(this.deps.paths.root, { ...claimed.envelope, log: result.log, updatedAt: now });
    return {
      applied: "direct",
      session: target.name ?? target.sessionId,
      revision: result.log.revision,
    };
  }

  private mutate(op: QueueOp, session?: string): QueueActionResult {
    const identity = this.deps.identity();
    this.claim();
    if (session === undefined || this.isSelf(session)) {
      const outcome = this.deps.queue.apply(op);
      return {
        applied: outcome.ok ? "direct" : "refused",
        revision: outcome.revision,
        session: identity.name,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
      };
    }
    if (this.deps.peerTrust === "manual") {
      return refused(
        "queue.peerTrust is manual: this session applies peer ops only through its own queue manager",
      );
    }
    const peer = this.peerFor(session);
    if (!("claim" in peer)) return peer;
    const target = readEnvelope(this.deps.paths.root, peer.sessionId, this.deps.now());
    const record = makeOpRecord(
      { session: identity.name, sessionId: identity.sessionId, cwd: identity.cwd },
      { sessionId: peer.sessionId, revision: target?.log.revision ?? 0 },
      op,
      this.deps.now(),
    );
    postOp(this.deps.paths.root, peer.claim, record);
    const knock = this.deps.knocker?.()?.wake(peer.sessionId, wakeMessage(1)) ?? "no-intercom";
    return {
      applied: "delegated",
      session: peer.name,
      count: 1,
      ...(knock === "sent" || knock === "unknown"
        ? {}
        : { reason: `posted without a wake signal (${knock})` }),
    };
  }

  private isSelf(ref: string): boolean {
    const identity = this.deps.identity();
    return ref === identity.sessionId || ref === identity.name;
  }

  private peers() {
    return sessionsFromQueues(listQueues(this.deps.paths.root), this.deps.identity().sessionId);
  }

  private peerFor(ref: string): PeerAddress | QueueActionResult {
    const target = resolvePeer(this.peers(), ref);
    if (target.found === undefined) {
      return refused(
        target.ambiguous
          ? `session name ${ref} is ambiguous`
          : `no session named ${ref} has a queue`,
      );
    }
    const sessionId = target.found.sessionId;
    // The claim comes from the target's own identity, so its ops land in a directory it
    // will actually read — a session that never set a name is still reachable by id.
    const envelope = readEnvelope(this.deps.paths.root, sessionId, this.deps.now());
    const claims = envelope === undefined ? [sessionId] : claimOf(envelope);
    return {
      sessionId,
      name:
        envelope?.name === undefined || envelope.name === ""
          ? (target.found.name ?? sessionId)
          : envelope.name,
      claim: claims[0] ?? sessionId,
    };
  }
}

function describe(entry: QueueEntry, now: number): Record<string, unknown> {
  return {
    id: entry.id,
    text: entry.text,
    kind: entry.kind,
    state: entry.state,
    createdAt: entry.createdAt,
    age: ageLabel(entry.createdAt, now),
    author: entry.author.session,
    via: entry.author.via,
    attempts: entry.attempts,
  };
}

function refused(reason: string): QueueActionResult {
  return { applied: "refused", reason };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "checkpoint";
}

/** Same wording the manager shows, so both views agree on how old something is. */
function ageLabel(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
