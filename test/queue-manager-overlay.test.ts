import { expect, test } from "bun:test";

import { PromptQueue } from "../src/prompt-queue.ts";
import { QueueManagerOverlayComponent } from "../src/queue-manager-overlay.ts";
import {
  facadeQueueSource,
  type QueueManagerRow,
  type QueueManagerSession,
  type QueueManagerSource,
} from "../src/queue-manager-source.ts";

const stubTui = { requestRender() {} } as never;

function managerFor(source: QueueManagerSource) {
  const closed: boolean[] = [];
  const component = new QueueManagerOverlayComponent(stubTui, source, {}, () => closed.push(true));
  return { component, closed, text: (width = 90) => component.render(width).join("\n") };
}

/** A source that reports what it is told to, so the overlay's own behaviour is what is tested. */
function fakeSource(options: {
  rows: readonly QueueManagerRow[];
  sessions?: readonly QueueManagerSession[];
  onEdit?: (index: number, text: string) => void;
  onFocus?: (session: string | undefined) => void;
}) {
  let focused: string | undefined;
  const calls: string[] = [];
  const source: QueueManagerSource = {
    rows: () => options.rows,
    focused: () => focused,
    focus: (session) => {
      focused = session;
      calls.push(`focus:${session ?? "self"}`);
      options.onFocus?.(session);
    },
    sessions: () =>
      options.sessions ?? [
        { sessionId: "ses_a", label: "alpha", pending: 1, alive: true, self: true },
      ],
    move: () => ({ ok: true }),
    remove: () => ({ ok: true }),
    undo: () => ({ ok: true }),
    deliver: () => ({ ok: true }),
    replace: (index, text) => {
      calls.push(`edit:${text}`);
      options.onEdit?.(index, text);
      return { ok: true };
    },
  };
  return { source, calls };
}

function row(overrides: Partial<QueueManagerRow> = {}): QueueManagerRow {
  return {
    id: "abc123",
    preview: "add the retry test",
    text: "add the retry test",
    author: "self",
    via: "key",
    kind: "prompt",
    age: "3m",
    peer: false,
    ...overrides,
  };
}

test("a wide manager shows author, age, kind and origin beside the prompt", () => {
  const { source } = fakeSource({
    rows: [row(), row({ id: "d", preview: "note", kind: "note", via: "tool", age: "1h" })],
  });
  const { text } = managerFor(source);
  const rendered = text(100);
  expect(rendered).toContain("3m");
  expect(rendered).toContain("prompt");
  expect(rendered).toContain("note");
  expect(rendered).toContain("you");
  expect(rendered).toContain("agent");
  expect(rendered).toContain("add the retry test");
});

test("a narrow manager keeps the prompt and drops the provenance columns", () => {
  const { source } = fakeSource({ rows: [row()] });
  const { text } = managerFor(source);
  const rendered = text(52);
  expect(rendered).toContain("add the retry test");
  expect(rendered).not.toContain("prompt");
  expect(rendered).not.toContain("3m");
});

test("the manager's keys are in its footer, including the queue switch", () => {
  const { source } = fakeSource({ rows: [row()] });
  const { text } = managerFor(source);
  const footer = text(100);
  for (const key of ["e edit", "[/] queues", "Enter send now", "u undo"]) {
    expect(footer).toContain(key);
  }
});

test("e opens the selected prompt and typing then Enter rewrites it", () => {
  const queue = new PromptQueue();
  queue.enqueue("fix the flaky spec\nand note why");
  const { component, text } = managerFor(facadeQueueSource(queue.facade(() => true)));

  component.handleInput("j");
  component.handleInput("e");
  const opened = text(100);
  expect(opened).toContain("edit");
  expect(opened).toContain("fix the flaky spec");

  component.handleInput(" before landing");
  component.handleInput("\r");
  expect(queue.list()[0]?.text).toBe("fix the flaky spec\nand note why before landing");
  expect(text(100)).toContain("edited #1");
});

test("Escape during an edit leaves the prompt untouched", () => {
  const queue = new PromptQueue();
  queue.enqueue("keep this wording");
  const { component, text } = managerFor(facadeQueueSource(queue.facade(() => true)));

  component.handleInput("e");
  component.handleInput(" but change it");
  component.handleInput("\x1b");
  expect(queue.list()[0]?.text).toBe("keep this wording");
  expect(text(100)).toContain("edit cancelled");

  component.handleInput("q");
  expect(text(100)).toContain("QUEUE");
});

test("] switches to the next session's queue and the title says whose it is", () => {
  const { source, calls } = fakeSource({
    rows: [row({ peer: true, author: "peer", via: "key", preview: "their prompt" })],
    sessions: [
      { sessionId: "ses_a", label: "alpha", pending: 0, alive: true, self: true },
      { sessionId: "ses_b", label: "beta", pending: 2, alive: true, self: false },
    ],
  });
  const { component, closed, text } = managerFor(source);

  component.handleInput("]");
  expect(calls).toContain("focus:ses_b");
  const peerView = text(100);
  expect(peerView).toContain("beta (peer)");
  expect(peerView).toContain("asked, not applied");
  expect(peerView).not.toContain("Enter send now");

  component.handleInput("d");
  expect(text(100)).toContain("asked to change");

  component.handleInput("[");
  expect(calls).toContain("focus:self");

  component.handleInput("q");
  expect(closed).toEqual([true]);
});

test("a peer's empty queue reads as theirs, not as yours", () => {
  const { source } = fakeSource({
    rows: [],
    sessions: [
      { sessionId: "ses_a", label: "alpha", pending: 0, alive: true, self: true },
      { sessionId: "ses_b", label: "beta", pending: 0, alive: true, self: false },
    ],
  });
  const { component, text } = managerFor(source);
  component.handleInput("]");
  expect(text(90)).toContain("nothing queued in beta");
  component.handleInput("d");
  expect(text(90)).toContain("nothing queued there");
});
