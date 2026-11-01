import { expect, test } from "bun:test";

import { PromptQueue, queuedPromptPreview } from "../src/prompt-queue.ts";
import { QueueManagerOverlayComponent } from "../src/queue-manager-overlay.ts";

function stubTui() {
  const state = { renders: 0 };
  return {
    tui: {
      requestRender() {
        state.renders += 1;
      },
    },
    state,
  };
}

function managerFor(queue: PromptQueue, deliver = (_text: string) => true) {
  const { tui, state } = stubTui();
  const closed: boolean[] = [];
  const component = new QueueManagerOverlayComponent(
    tui as never,
    queue.facade((prompt) => deliver(prompt.text)),
    {},
    () => closed.push(true),
  );
  return { component, closed, state };
}

test("prompt queue keeps submit order and ignores blank input", () => {
  const queue = new PromptQueue();
  queue.enqueue("  first \n");
  queue.enqueue("   ");
  queue.enqueue("second");

  expect(queue.list().map((item) => item.text)).toEqual(["first", "second"]);
  expect(queue.size).toBe(2);
});

test("takeNext drains from the head without undo history", () => {
  const queue = new PromptQueue();
  queue.enqueue("one");
  queue.enqueue("two");

  expect(queue.takeNext()?.text).toBe("one");
  expect(queue.takeNext()?.text).toBe("two");
  expect(queue.takeNext()).toBeUndefined();
  expect(queue.undoRemove()).toBeUndefined();
});

test("moving an item reorders it and refuses at the edges", () => {
  const queue = new PromptQueue();
  for (const text of ["a", "b", "c"]) queue.enqueue(text);

  expect(queue.moveAt(0, "up")).toBe(false);
  expect(queue.list().map((item) => item.text)).toEqual(["a", "b", "c"]);

  expect(queue.moveAt(0, "down")).toBe(true);
  expect(queue.list().map((item) => item.text)).toEqual(["b", "a", "c"]);

  expect(queue.moveAt(2, "down")).toBe(false);
});

test("deleting records one undo step and restoring puts it back in place", () => {
  const queue = new PromptQueue();
  for (const text of ["a", "b", "c"]) queue.enqueue(text);

  expect(queue.removeAt(1)?.text).toBe("b");
  expect(queue.list().map((item) => item.text)).toEqual(["a", "c"]);

  expect(queue.undoRemove()?.text).toBe("b");
  expect(queue.list().map((item) => item.text)).toEqual(["a", "b", "c"]);
  expect(queue.undoRemove()).toBeUndefined();
});

test("delivering sends the prompt and keeps it out of undo", () => {
  const queue = new PromptQueue();
  const sent: string[] = [];
  const facade = queue.facade((prompt) => {
    sent.push(prompt.text);
    return true;
  });
  queue.enqueue("keep");
  queue.enqueue("send");

  expect(facade.deliverNow(1)).toBe(true);
  expect(sent).toEqual(["send"]);
  expect(queue.list().map((item) => item.text)).toEqual(["keep"]);
  expect(queue.undoRemove()).toBeUndefined();
});

test("a refused delivery leaves the prompt queued", () => {
  const queue = new PromptQueue();
  const facade = queue.facade(() => false);
  queue.enqueue("stuck");

  expect(facade.deliverNow(0)).toBe(false);
  expect(queue.list().map((item) => item.text)).toEqual(["stuck"]);
});

test("the facade reports the queue for the manager", () => {
  const queue = new PromptQueue();
  const facade = queue.facade(() => true);
  queue.enqueue("one");
  queue.enqueue("two");

  expect(facade.size()).toBe(2);
  expect(facade.list().map((item) => item.text)).toEqual(["one", "two"]);
  expect(facade.move(0, "down")).toBe(true);
  expect(facade.remove(0)).toBe(true);
  expect(facade.remove(9)).toBe(false);
});

test("preview collapses multi-line prompts to one row", () => {
  const prompt = { id: 1, text: "line one\nline two" };
  expect(queuedPromptPreview(prompt)).toBe("line one ⏎");
});

test("manager navigates, reorders, deletes and restores with Vim keys", () => {
  const queue = new PromptQueue();
  for (const text of ["first", "second", "third"]) queue.enqueue(text);
  const { component } = managerFor(queue);

  expect(component.render(60).join("\n")).toContain("second");

  component.handleInput("j");
  component.handleInput("J");
  expect(queue.list().map((item) => item.text)).toEqual(["first", "third", "second"]);

  component.handleInput("K");
  expect(queue.list().map((item) => item.text)).toEqual(["first", "second", "third"]);

  component.handleInput("d");
  expect(queue.list().map((item) => item.text)).toEqual(["first", "third"]);
  component.handleInput("u");
  expect(queue.list().map((item) => item.text)).toEqual(["first", "second", "third"]);
});

test("manager sends the selected prompt and closes on Escape", () => {
  const queue = new PromptQueue();
  const sent: string[] = [];
  const { component, closed } = managerFor(queue, (text) => {
    sent.push(text);
    return true;
  });
  queue.enqueue("alpha");
  queue.enqueue("beta");

  component.handleInput("j");
  component.handleInput("\r");
  expect(sent).toEqual(["beta"]);
  expect(queue.list().map((item) => item.text)).toEqual(["alpha"]);

  component.handleInput("\x1b");
  expect(closed).toEqual([true]);
});

test("manager reports an empty queue instead of failing on keys", () => {
  const queue = new PromptQueue();
  const { component, closed } = managerFor(queue);

  component.handleInput("d");
  component.handleInput("j");
  component.handleInput("\r");
  expect(component.render(60).join("\n")).toContain("no prompts queued");

  component.handleInput("q");
  expect(closed).toEqual([true]);
});
