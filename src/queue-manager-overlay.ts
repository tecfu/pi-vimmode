import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import { queuedPromptPreview, type PromptQueueFacade, type QueuedPrompt } from "./prompt-queue.ts";

const LEFT = "│ ";
const RIGHT = " │";
const BORDER_OVERHEAD = visibleWidth(LEFT) + visibleWidth(RIGHT);
const BODY_ROWS = 12;

type OverlayTheme = {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

type OverlayStyle = {
  dim: (text: string) => string;
  accent: (text: string) => string;
  bold: (text: string) => string;
  selected: (text: string) => string;
};

function styleForTheme(theme: OverlayTheme | unknown): OverlayStyle {
  const maybeTheme = theme as OverlayTheme;
  return {
    dim: (text) => maybeTheme.fg?.("dim", text) ?? text,
    accent: (text) => maybeTheme.fg?.("cyan", text) ?? text,
    bold: (text) => maybeTheme.bold?.(text) ?? text,
    selected: (text) => maybeTheme.fg?.("black", maybeTheme.fg?.("bgCyan", text) ?? text) ?? text,
  };
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const truncated = truncateToWidth(text, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function borderedRow(text: string, width: number, style: OverlayStyle): string {
  const innerWidth = Math.max(0, width - BORDER_OVERHEAD);
  return `${style.accent(LEFT)}${fit(text, innerWidth)}${style.accent(RIGHT)}`;
}

function footerFor(message: string | undefined): string {
  const keys = "j/k move · J/K reorder · d delete · u undo · Enter send now · Esc close";
  return message === undefined ? ` ${keys} ` : ` ${message} `;
}

/**
 * Interactive manager for the prompts queue mode is holding: view them in
 * order, delete, reorder, or send one immediately.
 */
export type QueueManagerAction =
  | "close"
  | "next"
  | "previous"
  | "moveDown"
  | "moveUp"
  | "delete"
  | "undo"
  | "send";

/** Everything except closing acts on the list and reports a status line. */
type QueueManagerEditAction = Exclude<QueueManagerAction, "close">;

export class QueueManagerOverlayComponent implements Component {
  private selected = 0;
  private message: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly queue: PromptQueueFacade,
    private readonly theme: unknown,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    const action = managerActionFor(data);
    if (action === undefined) return;
    if (action === "close") {
      this.onClose();
      return;
    }
    if (this.queue.list().length === 0) {
      this.message = "queue is empty";
      this.tui.requestRender();
      return;
    }
    this.clampSelection();
    this.runners[action]();
    this.tui.requestRender();
  }

  private readonly runners: Record<QueueManagerEditAction, () => void> = {
    next: () => {
      this.selected = Math.min(this.size() - 1, this.selected + 1);
    },
    previous: () => {
      this.selected = Math.max(0, this.selected - 1);
    },
    moveDown: () => {
      const moved = this.queue.move(this.selected, "down");
      this.message = moved ? `moved #${this.selected + 2}` : undefined;
      if (moved) this.selected += 1;
    },
    moveUp: () => {
      const moved = this.queue.move(this.selected, "up");
      this.message = moved ? `moved #${this.selected}` : undefined;
      if (moved) this.selected -= 1;
    },
    delete: () => {
      this.message = this.queue.remove(this.selected) ? `deleted #${this.selected + 1}` : undefined;
      this.clampSelection();
    },
    undo: () => {
      this.message = this.queue.undoRemove() ? "restored last deleted prompt" : undefined;
      this.clampSelection();
    },
    send: () => {
      this.message = this.queue.deliverNow(this.selected)
        ? `sent #${this.selected + 1} now`
        : "nothing to send";
      this.clampSelection();
    },
  };

  private size(): number {
    return this.queue.list().length;
  }

  private clampSelection(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.size() - 1));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(40, width);
    const style = styleForTheme(this.theme);
    const items = this.queue.list();
    const lines: string[] = [];

    if (items.length === 0) {
      lines.push(borderedRow(style.dim(" no prompts queued "), safeWidth, style));
    } else {
      const first = Math.max(0, Math.min(this.selected - 2, items.length - BODY_ROWS));
      const visible = items.slice(first, first + BODY_ROWS);
      visible.forEach((prompt: QueuedPrompt, offset: number) => {
        const index = first + offset;
        const number = `${index + 1}`.padStart(2, " ");
        const marker = index === this.selected ? "›" : " ";
        const row = `${marker} ${number}  ${queuedPromptPreview(prompt)}`;
        lines.push(
          borderedRow(index === this.selected ? style.selected(row) : row, safeWidth, style),
        );
      });
      if (items.length > visible.length) {
        lines.push(
          borderedRow(
            style.dim(`  … ${items.length - visible.length} more (j/k to scroll)`),
            safeWidth,
            style,
          ),
        );
      }
    }

    const horizontal = "─".repeat(Math.max(0, safeWidth - 2));
    const title = ` QUEUE · ${items.length} pending `;
    return [
      style.accent(`╭${horizontal}╮`),
      borderedRow(style.bold(title), safeWidth, style),
      ...lines,
      borderedRow(style.dim(footerFor(this.message)), safeWidth, style),
      style.accent(`╰${horizontal}╯`),
    ];
  }
}

/** The keys the manager answers, as a lookup so input handling stays flat. */
const QUEUE_MANAGER_LITERAL_KEYS: Record<string, QueueManagerAction> = {
  j: "next",
  k: "previous",
  J: "moveDown",
  K: "moveUp",
  d: "delete",
  u: "undo",
  "\r": "send",
};

const QUEUE_MANAGER_NAMED_KEYS: ReadonlyArray<readonly [string, QueueManagerAction]> = [
  ["down", "next"],
  ["up", "previous"],
  ["enter", "send"],
  ["escape", "close"],
  ["ctrl+c", "close"],
];

function managerActionFor(data: string): QueueManagerAction | undefined {
  if (data === "q") return "close";
  const literal = QUEUE_MANAGER_LITERAL_KEYS[data];
  if (literal) return literal;
  return QUEUE_MANAGER_NAMED_KEYS.find(([key]) => matchesKey(data, key))?.[1];
}
