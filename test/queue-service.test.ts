import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QueueIdentity } from "../src/queue-store.ts";

import { PromptQueue } from "../src/prompt-queue.ts";
import {
  makeOpRecord,
  type QueueAuthor,
  type QueueAuthorVia,
  type QueueOp,
} from "../src/queue-model.ts";
import { QueueService, type CheckpointCapture } from "../src/queue-service.ts";
import {
  claimOf,
  newEnvelope,
  postOp,
  QueueFile,
  queuePaths,
  writeEnvelope,
  ensureStore,
} from "../src/queue-store.ts";

const SELF: QueueIdentity = { sessionId: "ses_self", name: "self", cwd: "/repo", pid: process.pid };
const PEER: QueueIdentity = { sessionId: "ses_peer", name: "peer", cwd: "/other", pid: 999_999 };
const DEAD: QueueIdentity = { sessionId: "ses_dead", name: "dead", cwd: "/gone", pid: 999_998 };

function authorFor(identity: QueueIdentity): (via: QueueAuthorVia) => QueueAuthor {
  return (via) => ({
    session: identity.name,
    sessionId: identity.sessionId,
    cwd: identity.cwd,
    via,
  });
}

/** A store with a peer and a dead session already on disk, plus a fresh in-memory queue. */
function harness(
  options: {
    peerTrust?: "auto" | "manual";
    branch?: CheckpointCapture | undefined;
    knockerWake?: (to: string, message: string) => void;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "vmq-"));
  const paths = ensureStore(root);
  // The queue writes through, exactly as it does under a live session: what the tool
  // reports must be what a peer reading the file would see.
  const file = new QueueFile(root);
  file.bind(SELF);
  const queue = new PromptQueue({ author: authorFor(SELF), sink: file });
  const wakeTargets: string[] = [];
  const service = new QueueService({
    paths,
    queue,
    identity: () => SELF,
    author: authorFor(SELF),
    peerTrust: options.peerTrust ?? "auto",
    knocker: () => ({
      present: () => true,
      wake: (to, message) => {
        wakeTargets.push(to);
        options.knockerWake?.(to, message);
        return "sent";
      },
    }),
    ...(options.branch === undefined ? {} : { captureBranch: () => options.branch }),
  });
  // A peer's queue exists on disk; that is all addressing needs to see.
  // A session claims its file when it starts, which is what makes it addressable.
  service.claim();
  writeEnvelope(root, newEnvelope(PEER));
  writeEnvelope(
    root,
    newEnvelope(DEAD, { entries: [], revision: 3, appliedOps: [] }, Date.now() - 600_000),
  );
  return {
    root,
    paths,
    queue,
    service,
    wakeTargets,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const branch: CheckpointCapture = {
  branch: [{ entryId: "e1", role: "user", text: "start the rewrite" }],
  leafId: "e1",
};

test("an agent's own enqueue lands in the live queue with tool provenance", () => {
  const h = harness();
  try {
    const result = h.service.enqueue({ text: "  add the retry test  " });
    expect(result.applied).toBe("direct");
    const entry = h.service.entries().at(-1);
    expect(entry?.text).toBe("add the retry test");
    expect(entry?.author.via).toBe("tool");
    expect(entry?.author.session).toBe("self");
  } finally {
    h.dispose();
  }
});

test("a note is held until released, and releasing it makes it deliverable", () => {
  const h = harness();
  try {
    h.service.enqueue({ text: "context: the flaky spec is #412", kind: "note" });
    const id = h.service.entries().at(-1)?.id ?? "";
    expect(h.service.pending().find((entry) => entry.id === id)?.kind).toBe("note");
    expect(h.service.deliverNow().applied).toBe("direct");
    expect(h.service.release(id).applied).toBe("direct");
    expect(h.service.pending().find((entry) => entry.id === id)?.kind).toBe("prompt");
  } finally {
    h.dispose();
  }
});

test("an op addressed to a peer is posted, not applied, and knocks", () => {
  const h = harness();
  try {
    const result = h.service.enqueue({ text: "rebase when you settle", session: "peer" });
    expect(result.applied).toBe("delegated");
    expect(h.service.entries()).toHaveLength(0);
    // A peer's ask must survive the target never having queued anything itself.
    expect(h.service.pendingOpsFor(claimOf(SELF))).toHaveLength(0);
    const claims = claimOf(PEER);
    const ops = h.service.pendingOpsFor(claims);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op.kind).toBe("add");
    expect(h.wakeTargets).toEqual(["ses_peer"]);
  } finally {
    h.dispose();
  }
});

test("manual peer trust refuses a peer mutation before writing anything", () => {
  const h = harness({ peerTrust: "manual" });
  try {
    const result = h.service.enqueue({ text: "do my bidding", session: "peer" });
    expect(result.applied).toBe("refused");
    expect(h.service.pendingOpsFor(claimOf(PEER))).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test("an unknown session refuses instead of guessing at an inbox directory", () => {
  const h = harness();
  try {
    expect(h.service.enqueue({ text: "anyone?", session: "nope" }).applied).toBe("refused");
  } finally {
    h.dispose();
  }
});

test("the target's own drain applies a posted op once and clears the record", () => {
  const h = harness();
  try {
    const record = makeOpRecord(
      { session: "self", sessionId: "ses_self", cwd: "/repo" },
      { sessionId: PEER.sessionId, revision: 0 },
      { kind: "add", draft: { text: "from the planner", author: authorFor(SELF)("tool") } },
      1,
    );
    const target = new PromptQueue({ author: authorFor(PEER) });
    const claims = claimOf(PEER);
    // One post per op, into one of the target's claim directories: the writer picks an
    // alias, the reader checks them all.
    postOp(h.root, claims[0] ?? PEER.sessionId, record);
    // The peer drains its own inbox — the path a live session takes, not a hand-applied op.
    const peer = new QueueService({
      paths: ensureStore(h.root),
      queue: target,
      identity: () => PEER,
      author: authorFor(PEER),
      peerTrust: "auto",
    });
    expect(peer.drainOps()).toEqual({ applied: 1, refused: 0 });
    expect(target.entries()).toHaveLength(1);
    expect(target.entries()[0]?.text).toBe("from the planner");
    // The record is cleared, so the next drain finds nothing to reconsider.
    expect(peer.pendingOps()).toHaveLength(0);
    // Re-posting the same op must satisfy, not duplicate: appliedOps is the guard.
    postOp(h.root, claims[0] ?? PEER.sessionId, record);
    expect(peer.drainOps()).toEqual({ applied: 1, refused: 0 });
    expect(target.entries()).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test("draining this session's inbox applies and drops every record", () => {
  const h = harness();
  try {
    const foreignQueue = new PromptQueue({ author: authorFor(PEER) });
    const foreignFile = new QueueFile(h.root);
    foreignFile.bind(PEER);
    foreignQueue.attach(foreignFile);
    const foreign = new QueueService({
      paths: h.paths,
      queue: foreignQueue,
      identity: () => PEER,
      author: authorFor(PEER),
      peerTrust: "auto",
    });
    void foreign.enqueue({ text: "a delegated ask", session: "self" });
    const counts = h.service.drainOps();
    expect(counts.applied).toBe(1);
    expect(h.service.entries().some((entry) => entry.text === "a delegated ask")).toBe(true);
    expect(h.service.pendingOps()).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test("index addressing works locally and refuses for a peer", () => {
  const h = harness();
  try {
    h.service.enqueue({ text: "first" });
    h.service.enqueue({ text: "second" });
    const byIndex = h.service.resolveId(undefined, 0);
    expect(byIndex).toBe(h.service.entries()[0]?.id);
    expect(h.service.resolveId(undefined, 0, "peer")).toBeUndefined();
    expect(h.service.delete("nope").reason).toContain("no queued entry");
  } finally {
    h.dispose();
  }
});

test("a checkpoint captures queue and branch together, and restore is idempotent", () => {
  const h = harness({ branch });
  try {
    h.service.enqueue({ text: "queued before branching" });
    const made = h.service.checkpoint("before-rewrite");
    expect(made.applied).toBe("direct");
    const id = made.checkpoint ?? "";
    expect(id.startsWith("before-rewrite-")).toBe(true);
    // Branch away: the queue is still pending, so restoring everything adds nothing new.
    expect(h.service.restoreCheckpoint(id, true).count).toBe(0);
    h.service.delete(h.service.entries()[0]?.id ?? "");
    expect(h.service.restoreCheckpoint(id, false).count).toBe(1);
    expect(h.service.entries().some((entry) => entry.text === "queued before branching")).toBe(
      true,
    );
  } finally {
    h.dispose();
  }
});

test("a checkpoint without session context refuses rather than archiving a half truth", () => {
  const h = harness({ branch: undefined });
  try {
    expect(h.service.checkpoint("blind").applied).toBe("refused");
  } finally {
    h.dispose();
  }
});

test("deliver_now never reaches into another session's turn", () => {
  const h = harness();
  try {
    expect(h.service.deliverNow("peer").applied).toBe("refused");
  } finally {
    h.dispose();
  }
});

test("a dead owner's queue is editable directly, and a living one is not", () => {
  const h = harness();
  try {
    const op: QueueOp = {
      kind: "add",
      draft: { text: "cleaned up after the crash", author: authorFor(SELF)("tool") },
    };
    expect(h.service.takeover("peer", op).applied).toBe("refused");
    const taken = h.service.takeover("dead", op);
    expect(taken.applied).toBe("direct");
    expect(h.service.inspect("dead")).toMatchObject({
      pending: [{ text: "cleaned up after the crash" }],
    });
  } finally {
    h.dispose();
  }
});

test("list reports rows with age, author and via, and inspect reads a peer's file", () => {
  const h = harness();
  try {
    h.service.enqueue({ text: "mine" });
    const listed = h.service.list() as { pending: Array<Record<string, unknown>>; session: string };
    expect(listed.session).toBe("self");
    expect(listed.pending[0]).toMatchObject({ via: "tool", author: "self" });
    expect(typeof listed.pending[0]?.age).toBe("string");
    expect(h.service.sessions()).toMatchObject({ self: "self" });
    expect(h.service.inspect("peer")).toMatchObject({ applied: "direct", sessionId: "ses_peer" });
  } finally {
    h.dispose();
  }
});

test("the store root is honoured so tests never touch the real agent queue dir", () => {
  const root = mkdtempSync(join(tmpdir(), "vmq-root-"));
  try {
    const paths = queuePaths(root);
    expect(paths.live.endsWith("live")).toBe(true);
    expect(ensureStore(root).root).toBe(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
