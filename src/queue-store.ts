/**
 * The prompt queue's durable store: three directories under one root, one
 * writer per file, atomic replace, and a TTL sweep that keeps it from turning
 * into a journal.
 *
 * `live/<sessionId>.json` is the queue of record and only its owning session
 * writes it; `inbox/<claim>/<opId>.json` is where anybody may leave a request
 * for the owner to apply; `archive/` holds dropped history and branch
 * checkpoints, which are append-only. ADR 0005 records why this is ours to
 * build rather than something rented from the message broker.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { QueueDraft, QueueEntry, QueueLog, QueueOp, QueueOpRecord } from "./queue-model.ts";

import { emptyQueueLog } from "./queue-model.ts";

export const ENVELOPE_VERSION = 1;
/** How long a takeover claim is held before another process may take it. */
export const CLAIM_TIMEOUT_MS = 5_000;

export type QueuePaths = {
  readonly root: string;
  readonly live: string;
  readonly inbox: string;
  readonly archive: string;
};

/** What a session publishes so peers can address it by something shorter than an id. */
export type QueueIdentity = {
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
  readonly pid: number;
  /** Resuming rewrites the id, so the file path is what ties one queue to its successor. */
  readonly sessionFile?: string;
};

export type QueueEnvelope = QueueIdentity & {
  readonly formatVersion: 1;
  readonly updatedAt: number;
  readonly log: QueueLog;
};

export type QueueSummary = QueueIdentity & {
  readonly revision: number;
  readonly updatedAt: number;
  readonly alive: boolean;
  readonly pending: number;
  /** Held notes: not deliverable, but still waiting to be seen. */
  readonly held: number;
  readonly path: string;
};
export function defaultQueueDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_VIMMODE_QUEUE_DIR;
  if (typeof override === "string" && override.trim().length > 0) return override.trim();
  return join(homedir(), ".pi", "agent", "queues");
}

export function queuePaths(root: string): QueuePaths {
  return {
    root,
    live: join(root, "live"),
    inbox: join(root, "inbox"),
    archive: join(root, "archive"),
  };
}

export function ensureStore(root: string): QueuePaths {
  const paths = queuePaths(root);
  for (const directory of [paths.live, paths.inbox, paths.archive])
    mkdirSync(directory, { recursive: true });
  return paths;
}

/** Claim names are filesystem path segments, so they are encoded, never interpolated. */
export function claimOf(identity: { sessionId?: string; name?: string; cwd?: string }): string[] {
  const claims = [identity.sessionId, identity.name, identity.cwd]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => encodeURIComponent(value.trim()));
  return [...new Set(claims)];
}

export function livePath(root: string, sessionId: string): string {
  return join(queuePaths(root).live, `${encodeURIComponent(sessionId)}.json`);
}

function tempPath(path: string, nonce: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${nonce}.tmp`);
}

/**
 * Write, flush, rename, and keep the previous file: the same discipline the
 * broker's own state manager uses, so a crash mid-write costs one commit and
 * not the queue.
 */
function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const nonce = createHash("sha256")
    .update(`${path}${Date.now()}${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
  const temp = tempPath(path, nonce);
  try {
    writeFileSync(temp, text, { encoding: "utf8", flush: true });
    if (existsSync(path)) {
      try {
        renameSync(path, `${path}.bak`);
      } catch {
        // A lost .bak costs a fallback copy, never the new write.
      }
    }
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function newEnvelope(
  identity: QueueIdentity,
  log: QueueLog = emptyQueueLog(),
  now = Date.now(),
): QueueEnvelope {
  return { ...identity, formatVersion: ENVELOPE_VERSION, updatedAt: now, log };
}

export function readEnvelope(
  root: string,
  sessionId: string,
  now = Date.now(),
): QueueEnvelope | undefined {
  const path = livePath(root, sessionId);
  const parsed = asEnvelope(readJson(path), now) ?? asEnvelope(readJson(`${path}.bak`), now);
  if (parsed === undefined || parsed.formatVersion !== ENVELOPE_VERSION) return undefined;
  return parsed;
}

export function writeEnvelope(root: string, envelope: QueueEnvelope): void {
  atomicWrite(livePath(root, envelope.sessionId), `${JSON.stringify(envelope, null, 2)}\n`);
}

export function updateEnvelope(
  root: string,
  sessionId: string,
  identity: Partial<QueueIdentity>,
  change: (envelope: QueueEnvelope) => QueueEnvelope,
  now = Date.now(),
): QueueEnvelope {
  const held =
    readEnvelope(root, sessionId) ??
    newEnvelope({ sessionId, name: "", cwd: "", pid: process.pid });
  const next = { ...held, ...identity, ...change(held), updatedAt: now };
  writeEnvelope(root, next);
  return next;
}

export function ownerIsAlive(envelope: QueueEnvelope): boolean {
  if (envelope.pid <= 0) return false;
  try {
    process.kill(envelope.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take ownership of a queue whose owner is gone. The claim file is held with
 * O_EXCL semantics (rename onto a path no one else can create) and expires, so
 * a takeover can never straddle a session that is merely slow to write.
 */
export function claimDeadOwner(
  root: string,
  sessionId: string,
  takeoverAfterMs: number,
  now = Date.now(),
): { ok: true; envelope: QueueEnvelope } | { ok: false; reason: string } {
  const held = readEnvelope(root, sessionId);
  if (held === undefined) return { ok: false, reason: "no queue for that session" };
  if (ownerIsAlive(held)) return { ok: false, reason: `owner pid ${held.pid} is alive` };
  if (now - held.updatedAt < takeoverAfterMs) {
    return { ok: false, reason: `owner died less than ${Math.round(takeoverAfterMs / 1000)}s ago` };
  }
  const claimFile = join(queuePaths(root).live, `${encodeURIComponent(sessionId)}.claim`);
  if (!tryClaim(claimFile, now)) return { ok: false, reason: "another process holds the claim" };
  try {
    const current = readEnvelope(root, sessionId) ?? held;
    if (ownerIsAlive(current)) return { ok: false, reason: "an owner reappeared while claiming" };
    const next = { ...current, pid: process.pid, updatedAt: now };
    writeEnvelope(root, next);
    return { ok: true, envelope: next };
  } finally {
    rmSync(claimFile, { force: true });
  }
}

function tryClaim(claimFile: string, now: number): boolean {
  const held = readJson(claimFile) as { at?: number } | undefined;
  if (held !== undefined && now - (held.at ?? 0) < CLAIM_TIMEOUT_MS) return false;
  try {
    writeFileSync(claimFile, `${JSON.stringify({ pid: process.pid, at: now })}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A claim that exists and is older than the timeout is a crashed holder.
    const age = statSync(claimFile, { throwIfNoEntry: false })?.mtimeMs ?? now;
    if (now - age < CLAIM_TIMEOUT_MS) return false;
    rmSync(claimFile, { force: true });
    try {
      writeFileSync(claimFile, `${JSON.stringify({ pid: process.pid, at: now })}\n`, {
        flag: "wx",
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function postOp(root: string, claim: string, record: QueueOpRecord): string {
  const directory = join(queuePaths(root).inbox, claim);
  const path = join(directory, `${record.opId}.json`);
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function readOps(root: string, claims: readonly string[]): QueueOpRecord[] {
  const found: QueueOpRecord[] = [];
  for (const claim of claims) {
    const directory = join(queuePaths(root).inbox, claim);
    let names: string[] = [];
    try {
      names = readdirSync(directory)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const record = asOpRecord(readJson(join(directory, name)));
      if (record !== undefined) found.push(record);
    }
  }
  return found.sort((left, right) => left.at - right.at || left.opId.localeCompare(right.opId));
}

export function dropOp(root: string, claims: readonly string[], opId: string): void {
  for (const claim of claims) {
    const path = join(queuePaths(root).inbox, claim, `${opId}.json`);
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

/** Deliverable-now items: a held note is waiting, but it is not a turn waiting. */
function pendingDeliverable(entries: readonly QueueEntry[]): number {
  return entries.filter((entry) => entry.state === "pending" && entry.kind === "prompt").length;
}

export function listQueues(root: string): QueueSummary[] {
  const directory = queuePaths(root).live;
  let names: string[] = [];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const summaries: QueueSummary[] = [];
  for (const name of names) {
    const envelope = asEnvelope(readJson(join(directory, name)), 0);
    if (envelope === undefined) continue;
    summaries.push({
      sessionId: envelope.sessionId,
      name: envelope.name,
      cwd: envelope.cwd,
      pid: envelope.pid,
      ...(envelope.sessionFile === undefined ? {} : { sessionFile: envelope.sessionFile }),
      revision: envelope.log.revision,
      updatedAt: envelope.updatedAt,
      alive: ownerIsAlive(envelope),
      pending: pendingDeliverable(envelope.log.entries),
      held: envelope.log.entries.filter(
        (entry) => entry.state === "pending" && entry.kind === "note",
      ).length,
      path: join(directory, name),
    });
  }
  return summaries;
}
/**
 * Age out dropped entries and undelivered op records. Deletes are history, not
 * garbage — they only become garbage when they stop being recent.
 */
export function sweepStore(
  root: string,
  ttlMs: number,
  now = Date.now(),
): { archivedEntries: QueueEntry[]; archivedOps: QueueOpRecord[] } {
  const archivedEntries = sweepDroppedFiles(root, ttlMs, now);
  const archivedOps = sweepInbox(root, ttlMs, now);
  return { archivedEntries, archivedOps };
}

function archiveFile(root: string, name: string, payload: unknown): string {
  const paths = queuePaths(root);
  mkdirSync(paths.archive, { recursive: true });
  const path = join(paths.archive, `${name}.json`);
  atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

/** Checkpoints and sweeps both land here; the name is the durable handle. */
export function writeArchive(root: string, kind: string, id: string, payload: unknown): string {
  return archiveFile(root, `${kind}-${encodeURIComponent(id)}`, payload);
}

export function readArchive(root: string, kind: string, id: string): unknown {
  return readJson(join(queuePaths(root).archive, `${kind}-${encodeURIComponent(id)}.json`));
}

export function listArchive(root: string, kind: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(queuePaths(root).archive).sort();
  } catch {
    return [];
  }
  const prefix = `${kind}-`;
  // What this lists must be what readArchive accepts, so the names come back as ids: a
  // checkpoint listed by an agent and restored a turn later has to resolve.
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => decodeURIComponent(name.slice(prefix.length, -5)));
}

function sweepDroppedFiles(root: string, ttlMs: number, now: number): QueueEntry[] {
  const cutoff = now - ttlMs;
  const swept: QueueEntry[] = [];
  for (const summary of listQueues(root)) {
    const envelope = readEnvelope(root, summary.sessionId, now);
    if (envelope === undefined) continue;
    const stale = envelope.log.entries.filter(
      (entry) => entry.state === "dropped" && entry.createdAt < cutoff,
    );
    if (stale.length === 0) continue;
    const log: QueueLog = {
      entries: envelope.log.entries.filter((entry) => !stale.some((gone) => gone.id === entry.id)),
      revision: envelope.log.revision + 1,
      appliedOps: envelope.log.appliedOps,
    };
    writeEnvelope(root, { ...envelope, log, updatedAt: now });
    archiveFile(root, `dropped-${encodeURIComponent(summary.sessionId)}-${now}`, {
      entries: stale,
    });
    swept.push(...stale);
  }
  return swept;
}

function sweepInbox(root: string, ttlMs: number, now: number): QueueOpRecord[] {
  const cutoff = now - ttlMs;
  const swept: QueueOpRecord[] = [];
  for (const claim of claimNames(root)) {
    swept.push(...sweepClaim(root, join(queuePaths(root).inbox, claim), cutoff, now));
  }
  return swept;
}

function claimNames(root: string): string[] {
  try {
    return readdirSync(queuePaths(root).inbox);
  } catch {
    return [];
  }
}

function sweepClaim(root: string, directory: string, cutoff: number, now: number): QueueOpRecord[] {
  const swept: QueueOpRecord[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  } catch {
    return swept;
  }
  for (const name of names) {
    const path = join(directory, name);
    const payload = readJson(path);
    const record = asOpRecord(payload, now);
    if (!isAged(path, record, cutoff, now)) continue;
    if (record === undefined) archiveFile(root, `corrupt-${name.slice(0, -5)}`, { raw: payload });
    else {
      archiveFile(root, `op-${record.opId}`, record);
      swept.push(record);
    }
    rmSync(path, { force: true });
  }
  return swept;
}

/** A record's own timestamp is authoritative; a broken one falls back to its age on disk. */
function isAged(
  path: string,
  record: QueueOpRecord | undefined,
  cutoff: number,
  now: number,
): boolean {
  const born = record?.at ?? statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? now;
  return born < cutoff;
}

/**
 * One session's queue file, with the two moves a queue makes that outlive a
 * process: load what was there, and take over the file of the session this one
 * was resumed from. Resuming rewrites the session id, so the thread's history
 * is the only handle back to owed prompts.
 */
export class QueueFile {
  readonly root: string;
  private current?: QueueIdentity;

  constructor(root: string = defaultQueueDir()) {
    this.root = ensureStore(root).root;
  }

  bind(identity: QueueIdentity): void {
    this.current = identity;
  }

  /** The session this file belongs to, once a session has claimed it. */
  identity(): QueueIdentity | undefined {
    return this.current;
  }

  get sessionId(): string | undefined {
    return this.current?.sessionId;
  }

  load(): QueueLog | undefined {
    if (this.current === undefined) return undefined;
    return readEnvelope(this.root, this.current.sessionId)?.log;
  }

  save(log: QueueLog, now = Date.now()): void {
    if (this.current === undefined) return;
    writeEnvelope(this.root, newEnvelope(this.current, log, now));
  }

  /** Adopt the queue of a dead session that shares this session's file. */
  adopt(sessionFile: string, now = Date.now()): { log: QueueLog; adopted: number } {
    for (const summary of listQueues(this.root)) {
      if (summary.sessionFile !== sessionFile || summary.alive) continue;
      const held = readEnvelope(this.root, summary.sessionId, now);
      if (held === undefined) continue;
      const adopted = held.log.entries.filter((entry) => entry.state === "pending").length;
      writeArchive(this.root, "adopted", summary.sessionId, held);
      rmSync(livePath(this.root, summary.sessionId), { force: true });
      rmSync(`${livePath(this.root, summary.sessionId)}.bak`, { force: true });
      return { log: held.log, adopted };
    }
    return { log: emptyQueueLog(), adopted: 0 };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asEnvelope(value: unknown, now: number): QueueEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const log = asQueueLog(value.log);
  if (log === undefined || typeof value.sessionId !== "string" || typeof value.pid !== "number") {
    return undefined;
  }
  return {
    sessionId: value.sessionId,
    name: typeof value.name === "string" ? value.name : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    pid: value.pid,
    formatVersion: ENVELOPE_VERSION,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
    log,
  };
}

function asQueueLog(value: unknown): QueueLog | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
  const entries = value.entries.filter(isRecord).map(normalizeEntry);
  if (entries.length !== value.entries.length) return undefined;
  const appliedOps = Array.isArray(value.appliedOps)
    ? value.appliedOps.filter(isRecord).map(normalizeApplied)
    : [];
  return { entries, revision: typeof value.revision === "number" ? value.revision : 0, appliedOps };
}

function normalizeEntry(entry: Record<string, unknown>): QueueEntry {
  const author = isRecord(entry.author) ? entry.author : {};
  return {
    id: typeof entry.id === "string" ? entry.id : "",
    text: typeof entry.text === "string" ? entry.text : "",
    kind: entry.kind === "note" ? "note" : "prompt",
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : 0,
    author: {
      session: typeof author.session === "string" ? author.session : "",
      sessionId: typeof author.sessionId === "string" ? author.sessionId : "",
      cwd: typeof author.cwd === "string" ? author.cwd : "",
      via: typeof author.via === "string" ? (author.via as QueueEntry["author"]["via"]) : "key",
    },
    state: entry.state === "delivered" || entry.state === "dropped" ? entry.state : "pending",
    attempts: typeof entry.attempts === "number" ? entry.attempts : 0,
    ...(typeof entry.deliveredAt === "number" ? { deliveredAt: entry.deliveredAt } : {}),
    ...(typeof entry.replyTo === "string" ? { replyTo: entry.replyTo } : {}),
  };
}

function normalizeApplied(applied: Record<string, unknown>): QueueLog["appliedOps"][number] {
  return {
    opId: typeof applied.opId === "string" ? applied.opId : "",
    at: typeof applied.at === "number" ? applied.at : 0,
    origin: typeof applied.origin === "string" ? applied.origin : "",
    kind: kindName(applied.kind),
  };
}

function kindName(value: unknown): QueueOp["kind"] {
  const kinds: readonly string[] = ["add", "delete", "restore", "release", "edit", "move"];
  return kinds.includes(typeof value === "string" ? value : "")
    ? (value as QueueOp["kind"])
    : "add";
}

function asOpRecord(value: unknown, now = Date.now()): QueueOpRecord | undefined {
  if (!isRecord(value) || !isRecord(value.op) || !isRecord(value.origin) || !isRecord(value.target))
    return undefined;
  const kind = value.op.kind;
  if (typeof kind !== "string") return undefined;
  const origin = {
    session: typeof value.origin.session === "string" ? value.origin.session : "",
    sessionId: typeof value.origin.sessionId === "string" ? value.origin.sessionId : "",
    cwd: typeof value.origin.cwd === "string" ? value.origin.cwd : "",
  };
  const op = normalizeOp(value.op);
  if (op === undefined) return undefined;
  return {
    formatVersion: 1,
    opId: typeof value.opId === "string" ? value.opId : opIdForRecord(origin, value.at, op),
    at: typeof value.at === "number" ? value.at : now,
    origin,
    target: {
      sessionId: typeof value.target.sessionId === "string" ? value.target.sessionId : "",
      revision: typeof value.target.revision === "number" ? value.target.revision : -1,
    },
    op,
  };
}

function normalizeOp(op: Record<string, unknown>): QueueOp | undefined {
  const id = typeof op.id === "string" ? op.id : "";
  switch (op.kind) {
    case "delete":
    case "restore":
    case "release":
      return id.length > 0 ? { kind: op.kind, id } : undefined;
    case "edit":
      return id.length > 0 && typeof op.text === "string"
        ? { kind: "edit", id, text: op.text }
        : undefined;
    case "move":
      return id.length > 0 && (op.direction === "up" || op.direction === "down")
        ? { kind: "move", id, direction: op.direction }
        : undefined;
    case "add":
      return isRecord(op.draft) ? { kind: "add", draft: normalizeDraft(op.draft) } : undefined;
    default:
      return undefined;
  }
}

function normalizeDraft(draft: Record<string, unknown>): QueueDraft {
  const author = isRecord(draft.author) ? draft.author : {};
  return {
    text: typeof draft.text === "string" ? draft.text : "",
    kind: draft.kind === "note" ? "note" : "prompt",
    createdAt: typeof draft.createdAt === "number" ? draft.createdAt : 0,
    ...(typeof draft.replyTo === "string" ? { replyTo: draft.replyTo } : {}),
    author: {
      session: typeof author.session === "string" ? author.session : "",
      sessionId: typeof author.sessionId === "string" ? author.sessionId : "",
      cwd: typeof author.cwd === "string" ? author.cwd : "",
      via:
        author.via === "checkpoint" || author.via === "tool" || author.via === "ex"
          ? author.via
          : "peer",
    },
  };
}

function opIdForRecord(origin: QueueOpRecord["origin"], at: unknown, op: QueueOp): string {
  return createHash("sha256")
    .update(JSON.stringify([origin.sessionId, typeof at === "number" ? at : 0, op]))
    .digest("hex")
    .slice(0, 12);
}
