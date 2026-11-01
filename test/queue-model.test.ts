import { expect, test } from "bun:test";

import type { QueueAuthor, QueueDraft, QueueLog } from "../src/queue-model.ts";

import {
  addDraft,
  alreadyApplied,
  applyOp,
  deleteEntry,
  editText,
  emptyQueueLog,
  entryIdFor,
  findEntry,
  makeEntry,
  makeOpRecord,
  markDelivered,
  MAX_APPLIED_OPS,
  moveEntry,
  nextDeliverable,
  opIdFor,
  pendingEntries,
  queueAgeLabel,
  recordAppliedOp,
  restoreEntry,
  rollBackDelivery,
  sweepDropped,
} from "../src/queue-model.ts";

const NOW = 1_700_000_000_000;

function author(overrides: Partial<QueueAuthor> = {}): QueueAuthor {
  return { session: "worker", sessionId: "session-alpha", cwd: "/repo", via: "key", ...overrides };
}

function draft(text: string, overrides: Partial<QueueDraft> = {}): QueueDraft {
  return { text, author: author(), createdAt: NOW, ...overrides };
}

function logWith(...texts: string[]): QueueLog {
  return texts.reduce((log, text) => addDraft(log, draft(text), NOW).log, emptyQueueLog());
}

function idsOf(log: QueueLog): string[] {
  return log.entries.map((entry) => entry.id);
}

function onlyId(log: QueueLog, index = 0): string {
  const id = log.entries[index]?.id ?? "";
  return id;
}

test("entry ids are content addressed, so the same ask is the same entry", () => {
  expect(entryIdFor(draft("run the tests"))).toBe(entryIdFor(draft("run the tests")));
  expect(entryIdFor(draft("run the tests"))).not.toBe(
    entryIdFor(draft("run the tests", { createdAt: NOW + 1 })),
  );
  expect(entryIdFor(draft("run the tests"))).not.toBe(
    entryIdFor(draft("run the tests", { author: author({ sessionId: "session-beta" }) })),
  );
});

test("adding trims blank input and refuses to repeat an entry", () => {
  const started = addDraft(emptyQueueLog(), draft("  fix the flake  "), NOW);
  expect(started.ok).toBe(true);
  expect(started.log.entries[0]?.text).toBe("fix the flake");
  expect(addDraft(started.log, draft("fix the flake"), NOW).ok).toBe(false);
  expect(addDraft(started.log, draft("   "), NOW)).toEqual({
    log: started.log,
    ok: false,
    reason: "empty prompt",
  });
});

test("a change bumps the revision and a refusal does not", () => {
  const started = logWith("one");
  const edited = editText(started, onlyId(started), "one, but later");
  expect(edited.log.revision).toBe(started.revision + 1);
  // A peer preconditions on this, so a no-op must not move it.
  const refused = moveEntry(edited.log, onlyId(edited.log), "down");
  expect(refused.ok).toBe(false);
  expect(refused.log.revision).toBe(edited.log.revision);
  expect(deleteEntry(edited.log, "ffffffffffff").log.revision).toBe(edited.log.revision);
});

test("deleting keeps history and undo restores it", () => {
  const started = logWith("one", "two");
  const target = onlyId(started);
  const dropped = deleteEntry(started, target);
  expect(dropped.log.entries).toHaveLength(2);
  expect(dropped.log.entries[0]?.state).toBe("dropped");
  expect(pendingEntries(dropped.log).map((entry) => entry.text)).toEqual(["two"]);
  expect(deleteEntry(dropped.log, target).ok).toBe(false);
  expect(restoreEntry(dropped.log, target).log.entries[0]?.state).toBe("pending");
  expect(restoreEntry(started, target).ok).toBe(false);
});

test("unknown ids are a reason, not an exception", () => {
  const started = logWith("one");
  expect(deleteEntry(started, "ffffffffffff").ok).toBe(false);
  expect(editText(started, "ffffffffffff", "x").ok).toBe(false);
  expect(moveEntry(started, "ffffffffffff", "up").ok).toBe(false);
});

test("moving reorders the pending view and refuses at the ends", () => {
  const started = logWith("one", "two", "three");
  const moved = moveEntry(started, onlyId(started, 2), "up");
  expect(moved.log.entries.map((entry) => entry.text)).toEqual(["one", "three", "two"]);
  expect(moveEntry(moved.log, onlyId(started, 0), "up").ok).toBe(false);
  expect(
    moveEntry(started, onlyId(started, 1), "up").log.entries.map((entry) => entry.text),
  ).toEqual(["two", "one", "three"]);
});

test("delivery is recorded before the send and rolled back after a throw", () => {
  const started = logWith("one");
  const id = onlyId(started);
  const sent = markDelivered(started, id, NOW + 10);
  expect(sent.log.entries[0]?.state).toBe("delivered");
  expect(sent.log.entries[0]?.deliveredAt).toBe(NOW + 10);
  expect(pendingEntries(sent.log)).toHaveLength(0);
  const rolled = rollBackDelivery(sent.log, id);
  expect(rolled.log.entries[0]?.state).toBe("pending");
  expect(rolled.log.entries[0]?.attempts).toBe(1);
  expect(markDelivered(sent.log, id, NOW).ok).toBe(false);
});

test("only pending prompts deliver on their own; notes wait for a release", () => {
  const mixed = addDraft(logWith("context"), draft("read this first", { kind: "note" }), NOW).log;
  expect(nextDeliverable(mixed)?.text).toBe("context");
  const drained = markDelivered(mixed, onlyId(mixed), NOW);
  expect(nextDeliverable(drained.log)).toBeUndefined();
});

test("applyOp dispatches every op kind through the same rules", () => {
  const started = emptyQueueLog();
  const added = applyOp(started, { kind: "add", draft: draft("from a peer") }, NOW);
  expect(added.ok).toBe(true);
  const id = onlyId(added.log);
  expect(
    applyOp(added.log, { kind: "edit", id, text: "corrected" }, NOW).log.entries[0]?.text,
  ).toBe("corrected");
  expect(applyOp(added.log, { kind: "move", id, direction: "down" }, NOW).ok).toBe(false);
  expect(applyOp(added.log, { kind: "delete", id }, NOW).log.entries[0]?.state).toBe("dropped");
  expect(applyOp(added.log, { kind: "restore", id }, NOW).ok).toBe(false);
  expect(applyOp(added.log, { kind: "release", id }, NOW).ok).toBe(false);
  const noted = addDraft(added.log, draft("context only", { kind: "note" }), NOW).log;
  const noteId = noted.entries[1]?.id ?? "";
  expect(nextDeliverable(noted)?.text).toBe("from a peer");
  const released = applyOp(noted, { kind: "release", id: noteId }, NOW);
  expect(released.ok).toBe(true);
  expect(released.log.entries[1]?.kind).toBe("prompt");
  expect(applyOp(started, { kind: "delete", id: "abc" }, NOW).ok).toBe(false);
});

test("an operation id is stable for a retry and records once", () => {
  const origin = { session: "peer", sessionId: "session-beta", cwd: "/other" };
  const op = { kind: "delete", id: "deadbeef0000" } as const;
  expect(opIdFor(origin, NOW, op)).toBe(opIdFor(origin, NOW, op));
  expect(opIdFor(origin, NOW, op)).not.toBe(opIdFor(origin, NOW + 1, op));
  const record = makeOpRecord(origin, { sessionId: "session-alpha", revision: 3 }, op, NOW);
  const applied = recordAppliedOp(logWith("one"), record);
  expect(alreadyApplied(applied, record.opId)).toBe(true);
  expect(alreadyApplied(applied, "000000000000")).toBe(false);
});

test("the audit log is bounded, oldest first out", () => {
  const origin = { session: "peer", sessionId: "session-beta", cwd: "/other" };
  let log = emptyQueueLog();
  const firstOpIds: string[] = [];
  for (let index = 0; index < MAX_APPLIED_OPS + 20; index += 1) {
    const record = makeOpRecord(
      origin,
      { sessionId: "s", revision: index },
      { kind: "restore", id: `id-${index}` },
      NOW + index,
    );
    if (index < 20) firstOpIds.push(record.opId);
    log = recordAppliedOp(log, record);
  }
  expect(log.appliedOps).toHaveLength(MAX_APPLIED_OPS);
  for (const opId of firstOpIds) expect(alreadyApplied(log, opId)).toBe(false);
  expect(alreadyApplied(log, log.appliedOps.at(-1)?.opId ?? "")).toBe(true);
  expect(log.appliedOps.at(-1)?.kind).toBe("restore");
});

test("dropped history ages out and nothing else does", () => {
  const started = logWith("fresh", "stale");
  const staleId = idsOf(started)[1] ?? "";
  const dropped = deleteEntry(started, staleId).log;
  const swept = sweepDropped(dropped, NOW + 1);
  expect(swept.swept.map((entry) => entry.text)).toEqual(["stale"]);
  expect(swept.log.entries).toHaveLength(1);
  expect(sweepDropped(dropped, NOW - 1).swept).toEqual([]);
  expect(sweepDropped(dropped, NOW + 1).log.revision).toBe(dropped.revision + 1);
});

test("makeEntry keeps provenance and reports a remembered entry", () => {
  const entry = makeEntry(draft("hello"), NOW);
  expect(entry.author.via).toBe("key");
  expect(entry.state).toBe("pending");
  expect(entry.attempts).toBe(0);
  expect(makeEntry(draft("hello", { replyTo: "session-gamma" }), NOW).replyTo).toBe(
    "session-gamma",
  );
  const log = addDraft(emptyQueueLog(), draft("hello"), NOW).log;
  expect(findEntry(log, entry.id)?.text).toBe("hello");
  expect(findEntry(log, "nope")).toBeUndefined();
});

test("ages read the way a queue label needs them to", () => {
  expect(queueAgeLabel(NOW, NOW)).toBe("0s");
  expect(queueAgeLabel(NOW - 59_000, NOW)).toBe("59s");
  expect(queueAgeLabel(NOW - 60_000, NOW)).toBe("1m");
  expect(queueAgeLabel(NOW - 3_600_000, NOW)).toBe("1h");
  expect(queueAgeLabel(NOW - 86_400_000 * 2, NOW)).toBe("2d");
  expect(queueAgeLabel(NOW + 10, NOW)).toBe("0s");
});
