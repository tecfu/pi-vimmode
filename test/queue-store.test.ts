import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { QueueDraft, QueueLog } from "../src/queue-model.ts";

import { addDraft, emptyQueueLog, makeOpRecord } from "../src/queue-model.ts";
import {
  claimDeadOwner,
  defaultQueueDir,
  dropOp,
  ensureStore,
  listArchive,
  listQueues,
  livePath,
  newEnvelope,
  ownerIsAlive,
  postOp,
  queuePaths,
  readArchive,
  readEnvelope,
  readOps,
  sweepStore,
  writeArchive,
  writeEnvelope,
} from "../src/queue-store.ts";

const NOW = 1_700_000_000_000;
const DEAD_PID = 2 ** 30;

function store(): string {
  return ensureStore(mkdtempSync(join(tmpdir(), "pi-vimmode-queue-"))).root;
}

function baseIdentity(sessionId: string) {
  return { sessionId, name: `name-of-${sessionId}`, cwd: `/repo/${sessionId}`, pid: process.pid };
}

function draftFrom(sessionId: string, text: string, createdAt = NOW): QueueDraft {
  return { text, author: { session: "peer", sessionId, cwd: "/other", via: "peer" }, createdAt };
}

function fill(texts: readonly string[], sessionId = "session-a"): QueueLog {
  return texts.reduce(
    (log, text) => addDraft(log, draftFrom(sessionId, text), NOW).log,
    emptyQueueLog(),
  );
}

function put(root: string, sessionId: string, log: QueueLog, at = NOW, pid = process.pid): void {
  writeEnvelope(root, { ...newEnvelope(baseIdentity(sessionId), log, at), pid });
}

test("the store root is overridable for tests and defaults under the agent dir", () => {
  expect(defaultQueueDir({ PI_VIMMODE_QUEUE_DIR: " /tmp/queues " })).toBe("/tmp/queues");
  expect(defaultQueueDir({})).toBe(join(homedir(), ".pi", "agent", "queues"));
  const paths = queuePaths("/tmp/queues");
  expect(paths.live).toBe(join("/tmp/queues", "live"));
  expect(paths.inbox).toBe(join("/tmp/queues", "inbox"));
});

test("an envelope round-trips and records who owns it", () => {
  const root = store();
  writeEnvelope(root, newEnvelope(baseIdentity("session-a"), emptyQueueLog(), NOW));
  const held = readEnvelope(root, "session-a", NOW);
  expect(held?.name).toBe("name-of-session-a");
  expect(held?.log.entries).toEqual([]);
  expect(held?.log.revision).toBe(0);
  expect(readEnvelope(root, "never-written", NOW)).toBeUndefined();
});

test("a torn write falls back to the backup copy", () => {
  const root = store();
  put(root, "session-a", fill(["one", "two", "third"]));
  const path = livePath(root, "session-a");
  expect(existsSync(`${path}.bak`)).toBe(false);
  put(root, "session-a", fill(["one", "two", "third", "fourth"]));
  writeFileSync(path, "{ this is not json", "utf8");
  const held = readEnvelope(root, "session-a", NOW);
  expect(held?.log.entries.map((entry) => entry.text)).toEqual(["one", "two", "third"]);
});

test("an unreadable queue reads as absent, not as a crash", () => {
  const root = store();
  writeFileSync(livePath(root, "session-junk"), "{{{", "utf8");
  expect(readEnvelope(root, "session-junk", NOW)).toBeUndefined();
  expect(listQueues(root)).toEqual([]);
});

test("a foreign envelope shape is skipped instead of poisoning the listing", () => {
  const root = store();
  put(root, "good", emptyQueueLog());
  writeFileSync(
    join(queuePaths(root).live, "garbage.json"),
    JSON.stringify({ sessionId: 5 }),
    "utf8",
  );
  expect(listQueues(root).map((summary) => summary.sessionId)).toEqual(["good"]);
});

test("ownership is a process, and a dead pid is not an owner", () => {
  const envelope = newEnvelope(baseIdentity("session-a"), emptyQueueLog(), NOW);
  expect(ownerIsAlive(envelope)).toBe(true);
  expect(ownerIsAlive({ ...envelope, pid: DEAD_PID })).toBe(false);
  expect(ownerIsAlive({ ...envelope, pid: 0 })).toBe(false);
});

test("claiming a dead owner's queue waits out the takeover window", () => {
  const root = store();
  put(root, "dead", emptyQueueLog(), NOW, DEAD_PID);
  const fresh = claimDeadOwner(root, "dead", 60_000, NOW + 1_000);
  expect(fresh.ok).toBe(false);
  if (!fresh.ok) expect(fresh.reason).toContain("less than");
  const stale = claimDeadOwner(root, "dead", 60_000, NOW + 600_000);
  expect(stale.ok).toBe(true);
  expect(readEnvelope(root, "dead", NOW)?.pid).toBe(process.pid);
  expect(claimDeadOwner(root, "session-a", 0, NOW).ok).toBe(false);
  expect(claimDeadOwner(root, "absent", 0, NOW).ok).toBe(false);
});

test("a takeover claim does not outlive the process that took it", () => {
  const root = store();
  put(root, "dead", emptyQueueLog(), NOW, DEAD_PID);
  expect(claimDeadOwner(root, "dead", 0, NOW + 600_000).ok).toBe(true);
  expect(readdirSync(queuePaths(root).live).filter((name) => name.endsWith(".claim"))).toEqual([]);
});

test("op records post to any of a session's claims and read back in order", () => {
  const root = store();
  const origin = { session: "peer", sessionId: "peer-1", cwd: "/other" };
  const first = makeOpRecord(
    origin,
    { sessionId: "session-a", revision: 1 },
    { kind: "add", draft: draftFrom("peer-1", "first") },
    NOW,
  );
  const second = makeOpRecord(
    origin,
    { sessionId: "session-a", revision: 1 },
    { kind: "add", draft: draftFrom("peer-1", "second") },
    NOW + 5,
  );
  postOp(root, encodeURIComponent("session-a"), first);
  postOp(root, encodeURIComponent("name-of-session-a"), second);
  writeFileSync(
    join(queuePaths(root).inbox, encodeURIComponent("session-a"), "not-json.json"),
    "{",
    "utf8",
  );
  const claims = [encodeURIComponent("session-a"), encodeURIComponent("name-of-session-a")];
  expect(readOps(root, claims).map((record) => record.opId)).toEqual([first.opId, second.opId]);
  dropOp(root, claims, first.opId);
  expect(readOps(root, claims).map((record) => record.opId)).toEqual([second.opId]);
  expect(readOps(root, [encodeURIComponent("no-such-session")])).toEqual([]);
});

test("a posted mutation round-trips through the store without losing its shape", () => {
  const root = store();
  const origin = { session: "peer", sessionId: "peer-1", cwd: "/other" };
  const ops = [
    { kind: "delete", id: "aabbccddeeff" },
    { kind: "restore", id: "aabbccddeeff" },
    { kind: "edit", id: "aabbccddeeff", text: "corrected" },
    { kind: "move", id: "aabbccddeeff", direction: "up" },
    { kind: "add", draft: draftFrom("peer-1", "posted") },
  ] as const;
  for (const op of ops)
    postOp(
      root,
      "session-a",
      makeOpRecord(origin, { sessionId: "session-a", revision: 2 }, op, NOW),
    );
  const read = readOps(root, ["session-a"]);
  const kinds: string[] = read.map((record) => record.op.kind).sort();
  expect(kinds).toEqual(["add", "delete", "edit", "move", "restore"].sort());
  expect(read.find((record) => record.op.kind === "move")?.op).toEqual({
    kind: "move",
    id: "aabbccddeeff",
    direction: "up",
  });
  expect(read.find((record) => record.op.kind === "add")?.op).toMatchObject({
    kind: "add",
    draft: { kind: "prompt" },
  });
  expect(read.every((record) => record.target.revision === 2)).toBe(true);
  writeFileSync(
    join(queuePaths(root).inbox, "session-a", "nonsense.json"),
    JSON.stringify({ kind: "walrus" }),
    "utf8",
  );
  expect(readOps(root, ["session-a"])).toHaveLength(ops.length);
});

test("a listing answers who has a queue, what is waiting, and whether they are here", () => {
  const root = store();
  put(root, "session-a", fill(["one", "two"]));
  put(root, "session-dead", emptyQueueLog(), NOW, DEAD_PID);
  expect(
    listQueues(root).map((summary) => [summary.sessionId, summary.pending, summary.alive]),
  ).toEqual([
    ["session-a", 2, true],
    ["session-dead", 0, false],
  ]);
  expect(listQueues(join(root, "missing"))).toEqual([]);
});

test("the TTL sweep ages dropped entries into the archive and leaves live work", () => {
  const root = store();
  const log = fill(["keep", "drop"]);
  const dropId = log.entries[1]?.id ?? "";
  put(root, "session-a", {
    ...log,
    entries: log.entries.map((entry) =>
      entry.id === dropId ? { ...entry, state: "dropped" as const } : entry,
    ),
  });
  const sweptAt = NOW + 10_000;
  expect(sweepStore(root, 1_000, sweptAt).archivedEntries.map((entry) => entry.text)).toEqual([
    "drop",
  ]);
  expect(readEnvelope(root, "session-a", NOW)?.log.entries.map((entry) => entry.text)).toEqual([
    "keep",
  ]);
  expect(sweepStore(root, 1_000, sweptAt).archivedEntries).toEqual([]);
  expect(listArchive(root, "dropped")).toEqual([`dropped-session-a-${String(sweptAt)}.json`]);
});

test("the sweep also retires op records nobody ever claimed", () => {
  const root = store();
  const origin = { session: "peer", sessionId: "peer-1", cwd: "/other" };
  const record = makeOpRecord(
    origin,
    { sessionId: "ghost", revision: 0 },
    { kind: "add", draft: draftFrom("peer-1", "post") },
    NOW,
  );
  postOp(root, encodeURIComponent("ghost"), record);
  expect(sweepStore(root, 1_000, NOW + 60_000).archivedOps.map((aged) => aged.opId)).toEqual([
    record.opId,
  ]);
  expect(readOps(root, [encodeURIComponent("ghost")])).toEqual([]);
  expect(existsSync(join(queuePaths(root).archive, `op-${record.opId}.json`))).toBe(true);
});

test("checkpoints land in the archive under a name the session can hand back", () => {
  const root = store();
  const payload = { sessionId: "session-a", entries: [], at: NOW };
  expect(writeArchive(root, "checkpoint", "cp-1", payload)).toBe(
    join(queuePaths(root).archive, "checkpoint-cp-1.json"),
  );
  expect(readArchive(root, "checkpoint", "cp-1")).toEqual(payload);
  expect(listArchive(root, "checkpoint")).toEqual(["checkpoint-cp-1.json"]);
  expect(listArchive(root, "none")).toEqual([]);
  expect(listArchive(join(root, "missing"), "checkpoint")).toEqual([]);
});
