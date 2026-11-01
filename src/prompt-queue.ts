/**
 * Prompt queue owned by queue mode.
 *
 * Pi's own follow-up queue is not reachable from an extension (only
 * `hasPendingMessages()` is), so queue mode keeps its own ordered list and
 * hands one prompt to Pi when the session settles. The manager overlay edits
 * this list: delete, reorder, undo a delete, or deliver an item immediately.
 */

export type QueuedPrompt = {
  readonly id: number;
  readonly text: string;
};

export type QueueDirection = "up" | "down";

/** Operations the queue manager overlay performs against the live queue. */
export type PromptQueueFacade = {
  list(): readonly QueuedPrompt[];
  size(): number;
  remove(index: number): boolean;
  move(index: number, direction: QueueDirection): boolean;
  undoRemove(): boolean;
  deliverNow(index: number): boolean;
};

function firstLine(text: string, limit = 120): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** One-line preview used by the manager overlay and status reporting. */
export function queuedPromptPreview(prompt: QueuedPrompt): string {
  const rest = prompt.text.includes("\n") ? " ⏎" : "";
  return `${firstLine(prompt.text)}${rest}`;
}

export class PromptQueue {
  private items: QueuedPrompt[] = [];
  private nextId = 1;
  private lastRemoved: { index: number; prompt: QueuedPrompt } | undefined;
  private readonly listeners = new Set<() => void>();

  /** Add a prompt, ignoring blank input. Returns the item, or nothing skipped. */
  enqueue(text: string): QueuedPrompt | undefined {
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    const prompt: QueuedPrompt = { id: this.nextId++, text: trimmed };
    this.items.push(prompt);
    this.lastRemoved = undefined;
    this.notify();
    return prompt;
  }

  list(): readonly QueuedPrompt[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /** Remove and return the head without undo history (delivery path). */
  takeNext(): QueuedPrompt | undefined {
    const [head] = this.items;
    if (head === undefined) return undefined;
    this.items = this.items.slice(1);
    this.notify();
    return head;
  }

  removeAt(index: number): QueuedPrompt | undefined {
    const [prompt] = this.items.splice(index, 1);
    if (prompt === undefined) return undefined;
    this.lastRemoved = { index: Math.min(index, this.items.length), prompt };
    this.notify();
    return prompt;
  }

  /** Swap the item at `index` with its neighbour. Reports whether it moved. */
  moveAt(index: number, direction: QueueDirection): boolean {
    const target = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || index >= this.items.length) return false;
    if (target < 0 || target >= this.items.length) return false;
    const items = [...this.items];
    const moved = items[index]!;
    items[index] = items[target]!;
    items[target] = moved;
    this.items = items;
    this.notify();
    return true;
  }

  /** Put the most recently deleted prompt back where it was. */
  undoRemove(): QueuedPrompt | undefined {
    const removed = this.lastRemoved;
    if (removed === undefined) return undefined;
    this.lastRemoved = undefined;
    this.items.splice(Math.min(removed.index, this.items.length), 0, removed.prompt);
    this.notify();
    return removed.prompt;
  }

  clear(): readonly QueuedPrompt[] {
    const dropped = this.items;
    this.items = [];
    this.lastRemoved = undefined;
    if (dropped.length > 0) this.notify();
    return dropped;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** View over the queue for the manager overlay (Pi delivery stays in lifecycle). */
  facade(deliver: (prompt: QueuedPrompt) => boolean): PromptQueueFacade {
    return {
      list: () => this.list(),
      size: () => this.size,
      remove: (index) => this.removeAt(index) !== undefined,
      move: (index, direction) => this.moveAt(index, direction),
      undoRemove: () => this.undoRemove() !== undefined,
      deliverNow: (index) => {
        const [prompt] = this.items.slice(index, index + 1);
        if (prompt === undefined) return false;
        if (!deliver(prompt)) return false;
        // Delivered prompts must not be restorable by `u` - they already ran.
        this.items = this.items.filter((item) => item.id !== prompt.id);
        this.lastRemoved = undefined;
        this.notify();
        return true;
      },
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
