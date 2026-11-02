import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QueueIdentity } from "../src/queue-store.ts";

import { PromptQueue } from "../src/prompt-queue.ts";
import { originLabel } from "../src/queue-manager-source.ts";
import { QueueManagerView } from "../src/queue-manager-view.ts";
import {
  addDraft,
  emptyQueueLog,
  type QueueAuthor,
  type QueueAuthorVia,
} from "../src/queue-model.ts";
import { QueueService } from "../src/queue-service.ts";
import { claimOf, ensureStore, newEnvelope, QueueFile, writeEnvelope } from "../src/queue-store.ts";

const SELF: QueueIdentity = { sessionId: "ses_self", name: "self", cwd: "/repo", pid: process.pid };
const PEER: QueueIdentity = { sessionId: "ses_peer", name: "peer", cwd: "/other", pid: 999_999 };

function authorFor(identity: QueueIdentity): (via: QueueAuthorVia) => QueueAuthor {
  return (via) => ({
    session: identity.name,
    sessionId: identity.sessionId,
    cwd: identity.cwd,
    via,
  });
}

/**
 * A store holding this session's queue and one peer's, with the manager's view over both.
 * The peer's entries live only in its file, which is exactly what the manager must read.
 */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "vmm-"));
  const paths = ensureStore(root);
  const file = new QueueFile(root);
  file.bind(SELF);
  const queue = new PromptQueue({ author: authorFor(SELF), sink: file });
  const service = new QueueService({
    paths,
    queue,
    identity: () => SELF,
    author: authorFor(SELF),
    peerTrust: "auto",
    knocker: () => ({ present: () => true, wake: () => "sent" }),
  });
  service.claim();

  let peerLog = emptyQueueLog();
  for (const draft of [
    { text: "rebase the branch when you settle", kind: "prompt" as const },
    { text: "context: their CI is red", kind: "note" as const },
  ]) {
    const added = addDraft(
      peerLog,
      { text: draft.text, kind: draft.kind, author: authorFor(PEER)("key") },
      Date.now(),
    );
    peerLog = added.log;
  }
  writeEnvelope(root, newEnvelope(PEER, peerLog));

  const view = new QueueManagerView({
    service: () => service,
    local: queue.facade(() => true),
    selfLabel: () => "self",
  });
  return {
    root,
    queue,
    service,
    view,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("rows carry who wrote each prompt, from where, what kind it is and its age", () => {
  const h = harness();
  try {
    h.queue.enqueue("add the retry test");
    const row = h.view.rows()[0];
    expect(row?.author).toBe("self");
    expect(row?.via).toBe("key");
    expect(row?.kind).toBe("prompt");
    expect(row?.age).toBe("0s");
    expect(row?.preview).toBe("add the retry test");
    expect(row?.peer).toBe(false);
    expect(originLabel("key", "self", true)).toBe("you");
  } finally {
    h.dispose();
  }
});

test("a note and an agent entry are labelled by origin, not just by author", () => {
  const h = harness();
  try {
    h.service.enqueue({ text: "context: the flaky spec is #412", kind: "note" });
    const [note] = h.view.rows();
    expect(note?.kind).toBe("note");
    expect(originLabel(note?.via ?? "key", note?.author ?? "", true)).toBe("agent");
    expect(h.view.rows().every((row) => row.age.length > 0)).toBe(true);
  } finally {
    h.dispose();
  }
});

test("focusing a peer reads its file, and the rows are marked as not ours", () => {
  const h = harness();
  try {
    const peer = h.view.sessions().find((session) => !session.self);
    expect(peer?.label).toBe("peer");
    h.view.focus(peer?.sessionId);
    expect(h.view.focused()).toBe(PEER.sessionId);
    const rows = h.view.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.preview).toContain("rebase");
    expect(rows.every((row) => row.peer)).toBe(true);
    expect(originLabel(rows[1]?.via ?? "peer", rows[1]?.author ?? "", false)).toBe("from peer");
    h.view.focus(undefined);
    expect(h.view.rows()).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test("editing a peer's prompt asks instead of writing, and sending one refuses", () => {
  const h = harness();
  try {
    h.view.focus(PEER.sessionId);
    const edited = h.view.replace(0, "rebase on main, not on the stale branch");
    expect(edited.ok).toBe(true);
    // The ask is in the peer's inbox; its file still holds the original words.
    expect(h.service.pendingOpsFor(claimOf(PEER))).toHaveLength(1);
    expect(h.view.rows()[0]?.preview).toContain("rebase the branch");
    expect(h.view.deliver(0).ok).toBe(false);
    expect(h.view.undo().ok).toBe(false);
    expect(h.view.undo().reason).toContain("your own");
  } finally {
    h.dispose();
  }
});

test("the peer's own drain applies what the manager asked for", () => {
  const h = harness();
  try {
    h.view.focus(PEER.sessionId);
    h.view.remove(0);
    const peerFile = new QueueFile(h.root);
    peerFile.bind(PEER);
    const peerQueue = new PromptQueue({ author: authorFor(PEER), sink: peerFile });
    const loaded = peerFile.load();
    if (loaded !== undefined) peerQueue.restore(loaded);
    const drained = new QueueService({
      paths: ensureStore(h.root),
      queue: peerQueue,
      identity: () => PEER,
      author: authorFor(PEER),
      peerTrust: "auto",
    }).drainOps();
    expect(drained.applied).toBe(1);
    expect(h.view.rows()).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test("deleting and reordering our own rows go through the live queue, not an ask", () => {
  const h = harness();
  try {
    h.queue.enqueue("one");
    h.queue.enqueue("two");
    expect(h.view.move(0, "down").ok).toBe(true);
    expect(h.view.rows().map((row) => row.preview)).toEqual(["two", "one"]);
    expect(h.view.remove(0).ok).toBe(true);
    expect(h.view.rows().map((row) => row.preview)).toEqual(["one"]);
    expect(h.view.undo().ok).toBe(true);
    expect(h.view.rows()).toHaveLength(2);
    expect(h.service.pendingOpsFor(claimOf(SELF))).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test("an unknown focus leaves the view where it was", () => {
  const h = harness();
  try {
    h.view.focus("ses_nobody");
    expect(h.view.focused()).toBe(undefined);
    const sessions = h.view.sessions();
    expect(sessions[0]?.self).toBe(true);
    expect(sessions.some((session) => session.label === "peer" && session.pending === 2)).toBe(
      true,
    );
  } finally {
    h.dispose();
  }
});
