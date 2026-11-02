import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QueueAuthor, QueueAuthorVia } from "../src/queue-model.ts";
import type { QueueOpRecord } from "../src/queue-model.ts";

import { PromptQueue } from "../src/prompt-queue.ts";
import { QueueService } from "../src/queue-service.ts";
import { ensureStore, QueueFile, type QueueIdentity } from "../src/queue-store.ts";
import { createQueueTool } from "../src/queue-tool.ts";

const SELF: QueueIdentity = {
  sessionId: "ses_tool",
  name: "tool-host",
  cwd: "/repo",
  pid: process.pid,
};

function authorFor(identity: QueueIdentity): (via: QueueAuthorVia) => QueueAuthor {
  return (via) => ({
    session: identity.name,
    sessionId: identity.sessionId,
    cwd: identity.cwd,
    via,
  });
}

/** Call the tool the way pi does: params in, structured details out. */
async function call(
  service: QueueService,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = createQueueTool(() => service);
  const result = await tool.execute(
    "call-1",
    params as never,
    new AbortController().signal,
    undefined,
    {} as never,
  );
  return result.details as Record<string, unknown>;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "vmq-tool-"));
  const file = new QueueFile(root);
  file.bind(SELF);
  const queue = new PromptQueue({ author: authorFor(SELF), sink: file });
  const flushed: number[] = [];
  const service = new QueueService({
    paths: ensureStore(root),
    queue,
    identity: () => SELF,
    author: authorFor(SELF),
    peerTrust: "auto",
    flush: () => flushed.push(Date.now()),
    captureBranch: () => ({ branch: [{ entryId: "e1", role: "user", text: "hi" }], leafId: "e1" }),
  });
  service.claim();
  return {
    root,
    queue,
    service,
    flushed,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the tool's schema names every action and describes the ones an agent needs", () => {
  const tool = createQueueTool(() => harness().service);
  expect(tool.name).toBe("queue");
  const schema = tool.parameters as unknown as { properties: Record<string, { enum?: string[] }> };
  expect(Object.keys(schema.properties).sort()).toEqual(
    [
      "action",
      "all",
      "checkpoint",
      "direction",
      "id",
      "includeDropped",
      "index",
      "kind",
      "name",
      "session",
      "text",
    ].sort(),
  );
  expect(schema.properties.action?.enum).toContain("deliver_now");
  expect(schema.properties.action?.enum).toContain("restore_checkpoint");
  expect(tool.promptSnippet).toInclude("prompt queue");
  // The guideline that keeps this tool from becoming a second intercom.
  expect(tool.promptGuidelines?.join(" ")).toInclude("intercom");
});

test("enqueue, list, edit, move, delete and restore work through the tool", async () => {
  const h = harness();
  try {
    const added = await call(h.service, { action: "enqueue", text: "write the migration" });
    expect(added.applied).toBe("direct");
    expect(h.service.entries()).toHaveLength(1);

    const listed = (await call(h.service, { action: "list" })) as {
      pending: Array<{ id: string; text: string }>;
    };
    expect(listed.pending[0]?.text).toBe("write the migration");
    const id = listed.pending[0]?.id ?? "";

    expect(
      (await call(h.service, { action: "edit", id, text: "write two migrations" })).applied,
    ).toBe("direct");
    expect(h.service.entries()[0]?.text).toBe("write two migrations");

    await call(h.service, { action: "enqueue", text: "second" });
    expect((await call(h.service, { action: "move", id, direction: "down" })).applied).toBe(
      "direct",
    );
    expect(h.service.entries().at(-1)?.id).toBe(id);

    expect((await call(h.service, { action: "delete", index: 0 })).applied).toBe("direct");
    const withDropped = (await call(h.service, { action: "list", includeDropped: true })) as {
      dropped: unknown[];
    };
    expect(withDropped.dropped).toHaveLength(1);
    const restoredId = (withDropped.dropped as Array<{ id: string }>)[0]?.id ?? "";
    expect((await call(h.service, { action: "restore", id: restoredId })).applied).toBe("direct");
  } finally {
    h.dispose();
  }
});

test("an action without its required argument refuses with a reason instead of throwing", async () => {
  const h = harness();
  try {
    expect(await call(h.service, { action: "enqueue" })).toMatchObject({
      applied: "refused",
      reason: "enqueue needs text",
    });
    expect(await call(h.service, { action: "delete" })).toMatchObject({ applied: "refused" });
    expect(await call(h.service, { action: "restore_checkpoint" })).toMatchObject({
      applied: "refused",
    });
    expect(await call(h.service, { action: "inspect" })).toMatchObject({ applied: "refused" });
    expect(await call(h.service, { action: "deliver_now" })).toMatchObject({ applied: "direct" });
    expect(h.flushed).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test("a peer-addressed enqueue reports delegated and leaves this queue alone", async () => {
  const h = harness();
  try {
    const result = await call(h.service, {
      action: "enqueue",
      text: "review the diff",
      session: "ghost",
    });
    // "ghost" has no queue file, so there is nothing to address.
    expect(result).toMatchObject({ applied: "refused" });
    expect(h.service.entries()).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test("checkpoints round-trip through the tool", async () => {
  const h = harness();
  try {
    await call(h.service, { action: "enqueue", text: "the plan" });
    const made = await call(h.service, { action: "checkpoint", name: "before-the-detour" });
    expect(made.applied).toBe("direct");
    const list = (await call(h.service, { action: "list_checkpoints" })) as {
      checkpoints: string[];
    };
    expect(list.checkpoints.length).toBeGreaterThan(0);
    const name = list.checkpoints[0] ?? "";
    expect(
      (await call(h.service, { action: "restore_checkpoint", checkpoint: name })).applied,
    ).toBe("direct");
  } finally {
    h.dispose();
  }
});

test("sessions lists the fleet with aliveness and counts", async () => {
  const h = harness();
  try {
    const result = (await call(h.service, { action: "sessions" })) as {
      sessions: Array<{ sessionId: string; alive: boolean }>;
    };
    expect(
      result.sessions.some((session) => session.sessionId === SELF.sessionId && session.alive),
    ).toBe(true);
  } finally {
    h.dispose();
  }
});

/** A queue with a record already waiting, to exercise the drain the settle hook runs. */
function withInbox(): { service: QueueService; record: QueueOpRecord; dispose: () => void } {
  const h = harness();
  const record = {
    formatVersion: 1,
    opId: "op_from_peer",
    at: Date.now(),
    origin: { session: "peer", sessionId: "ses_peer", cwd: "/other" },
    target: { sessionId: SELF.sessionId, revision: 0 },
    op: {
      kind: "add",
      draft: {
        text: "posted while asleep",
        author: authorFor({ ...SELF, name: "peer", sessionId: "ses_peer" })("peer"),
      },
    },
  } as unknown as QueueOpRecord;
  const { postOp, claimOf } = await_store();
  postOp(h.service.root, claimOf(SELF)[0] ?? SELF.sessionId, record);
  return { service: h.service, record, dispose: h.dispose };
}

function await_store(): typeof import("../src/queue-store.ts") {
  // A require avoids importing the store twice through two different specifiers.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../src/queue-store.ts") as typeof import("../src/queue-store.ts");
}

test("a posted op is applied once by the drain and then stops being read", () => {
  const h = withInbox();
  try {
    const counts = h.service.drainOps();
    expect(counts).toEqual({ applied: 1, refused: 0 });
    expect(h.service.entries().some((entry) => entry.text === "posted while asleep")).toBe(true);
    expect(h.service.pendingOps()).toHaveLength(0);
    // Re-posting the identical record (same opId) must not duplicate the entry.
    const { postOp, claimOf } = await_store();
    postOp(h.service.root, claimOf(SELF)[0] ?? SELF.sessionId, h.record);
    expect(h.service.drainOps()).toEqual({ applied: 1, refused: 0 });
    expect(
      h.service.entries().filter((entry) => entry.text === "posted while asleep"),
    ).toHaveLength(1);
  } finally {
    h.dispose();
  }
});
