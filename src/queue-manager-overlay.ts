import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type KeyId,
  type TUI,
} from "@earendil-works/pi-tui";

import type { QueueManagerRow, QueueManagerSource } from "./queue-manager-source.ts";

import { originLabel } from "./queue-manager-source.ts";

const LEFT = "│ ";
const RIGHT = " │";
const BORDER_OVERHEAD = visibleWidth(LEFT) + visibleWidth(RIGHT);
const BODY_ROWS = 12;
/** Below this the row drops its provenance columns and keeps only the text. */
const PROVENANCE_MIN_WIDTH = 64;

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

/**
 * Interactive manager for the prompts the queue holds: who wrote each one and how long
 * ago, in what order they will fire, and — with `[` and `]` — the queues other sessions
 * own, which it edits by asking them.
 */
export type QueueManagerAction =
  | "close"
  | "next"
  | "previous"
  | "moveDown"
  | "moveUp"
  | "delete"
  | "undo"
  | "send"
  | "edit"
  | "focusNext"
  | "focusPrevious";

/** Everything except closing acts on the list and reports a status line. */
type QueueManagerEditAction = Exclude<QueueManagerAction, "close">;

export class QueueManagerOverlayComponent implements Component {
  private selected = 0;
  private message: string | undefined;
  /** Set while `e` has the selected prompt open for typing. */
  private draft: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly source: QueueManagerSource,
    private readonly theme: unknown,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (this.draft !== undefined) {
      this.handleDraftInput(data);
      return;
    }
    const action = managerActionFor(data);
    if (action === undefined) return;
    if (action === "close") {
      this.onClose();
      return;
    }
    if (action === "focusNext" || action === "focusPrevious") {
      this.cycleFocus(action === "focusNext" ? 1 : -1);
      this.tui.requestRender();
      return;
    }
    if (this.source.rows().length === 0) {
      this.message = this.emptyLabel();
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
    moveDown: () =>
      this.mutate(
        (row) => this.source.move(row, "down"),
        (at) => `moved #${at + 2}`,
        +1,
      ),
    moveUp: () =>
      this.mutate(
        (row) => this.source.move(row, "up"),
        (at) => `moved #${at}`,
        -1,
      ),
    delete: () =>
      this.mutate(
        (row) => this.source.remove(row),
        (at) => `deleted #${at + 1}`,
      ),
    undo: () =>
      this.mutate(
        () => this.source.undo(),
        () => "restored last deleted prompt",
      ),
    send: () =>
      this.mutate(
        (row) => this.source.deliver(row),
        (at) => `sent #${at + 1} now`,
      ),
    edit: () => {
      this.draft = this.rowAt(this.selected)?.text ?? "";
    },
    focusNext: () => {},
    focusPrevious: () => {},
  };

  /**
   * One mutation, one status line. A refusal says why; a change made while a peer's
   * queue is focused says who has to apply it. `tracks` moves the cursor with the item,
   * which is what makes `JJ` move one line twice.
   */
  private mutate(
    act: (index: number) => { ok: boolean; reason?: string },
    label: (index: number) => string,
    tracks = 0,
  ): void {
    const before = this.selected;
    const result = act(before);
    const peer = this.source.focused();
    this.message = result.ok
      ? peer === undefined
        ? label(before)
        : `${label(before)} · asked to change`
      : (result.reason ?? "refused");
    if (result.ok && tracks !== 0) this.selected = before + tracks;
    this.clampSelection();
  }

  private handleDraftInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.draft = undefined;
      this.message = "edit cancelled";
    } else if (matchesKey(data, "enter")) {
      const text = (this.draft ?? "").trim();
      const result = this.source.replace(this.selected, text);
      this.message = result.ok ? this.describeEdit(text) : (result.reason ?? "edit refused");
      this.draft = undefined;
    } else if (matchesKey(data, "backspace")) {
      this.draft = (this.draft ?? "").slice(0, -1);
    } else if (data === "\t") {
      // Tabs belong to the editor underneath, not to this buffer.
    } else if (data.length > 0 && !data.startsWith("\x1b")) {
      this.draft = (this.draft ?? "") + data;
    }
    this.tui.requestRender();
  }

  private describeEdit(text: string): string {
    if (this.source.focused() !== undefined)
      return `asked that prompt #${this.selected + 1} be rewritten`;
    return text.length === 0 ? `emptied #${this.selected + 1}` : `edited #${this.selected + 1}`;
  }

  private cycleFocus(step: number): void {
    const sessions = this.sessionsInOrder();
    const current = Math.max(
      0,
      sessions.findIndex((session) => session.sessionId === (this.source.focused() ?? "")),
    );
    const next = sessions[(current + step + sessions.length) % sessions.length];
    if (next === undefined) return;
    this.source.focus(next.self ? undefined : next.sessionId);
    this.selected = 0;
    this.message = next.self ? "your queue" : `${next.label} · ${next.pending} pending`;
  }

  /** Own queue first, then every other queue file, in store order. */
  private sessionsInOrder() {
    const sessions = this.source.sessions();
    return [
      ...sessions.filter((session) => session.self),
      ...sessions.filter((session) => !session.self),
    ];
  }

  /** What keys report when there is nothing to act on. */
  private emptyLabel(): string {
    const peer = this.source.focused();
    return peer === undefined ? "queue is empty" : "nothing queued there";
  }

  /** What the body shows in place of rows. */
  private emptyBody(): string {
    const peer = this.source.focused();
    if (peer === undefined) return "no prompts queued";
    return `nothing queued in ${this.labelOf(peer)}`;
  }

  private rowAt(index: number): QueueManagerRow | undefined {
    return this.source.rows()[index];
  }

  private size(): number {
    return this.source.rows().length;
  }

  private clampSelection(): void {
    this.selected = Math.max(0, Math.min(this.selected, this.size() - 1));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(40, width);
    const style = styleForTheme(this.theme);
    const rows = this.source.rows();
    const lines: string[] = [];

    if (rows.length === 0) {
      lines.push(borderedRow(style.dim(` ${this.emptyBody()} `), safeWidth, style));
    } else {
      const first = Math.max(0, Math.min(this.selected - 2, rows.length - BODY_ROWS));
      const visible = rows.slice(first, first + BODY_ROWS);
      visible.forEach((row: QueueManagerRow, offset: number) => {
        const index = first + offset;
        lines.push(this.lineFor(row, index, safeWidth, style));
      });
      if (rows.length > visible.length) {
        lines.push(
          borderedRow(
            style.dim(`  … ${rows.length - visible.length} more (j/k to scroll)`),
            safeWidth,
            style,
          ),
        );
      }
    }

    const horizontal = "─".repeat(Math.max(0, safeWidth - 2));
    return [
      style.accent(`╭${horizontal}╮`),
      borderedRow(style.bold(this.title(rows.length)), safeWidth, style),
      ...lines,
      ...this.hint(style, safeWidth),
      borderedRow(style.dim(this.footer()), safeWidth, style),
      style.accent(`╰${horizontal}╯`),
    ];
  }

  private lineFor(row: QueueManagerRow, index: number, width: number, style: OverlayStyle): string {
    const selected = index === this.selected;
    if (selected && this.draft !== undefined) {
      const editing = `  edit › ${this.draft}▏`;
      return borderedRow(style.bold(editing), width, style);
    }
    const marker = selected ? "›" : " ";
    const number = `${index + 1}`.padStart(2, " ");
    const provenance = `${row.age.padStart(4)}  ${row.kind.padEnd(6)}  ${originLabel(row.via, row.author, !row.peer)}`;
    const head = `${marker} ${number}  `;
    const body =
      width - BORDER_OVERHEAD > PROVENANCE_MIN_WIDTH
        ? `${head}${provenance}  ${row.preview}`
        : `${head}${row.preview}`;
    return borderedRow(
      selected ? style.selected(body) : row.peer ? style.dim(body) : body,
      width,
      style,
    );
  }

  private title(count: number): string {
    const peer = this.source.focused();
    const where = peer === undefined ? "" : ` · ${this.labelOf(peer)} (peer)`;
    return ` QUEUE · ${count} pending${where} `;
  }

  /** A peer's queue needs its own caveat: nothing here is applied by this session. */
  private hint(style: OverlayStyle, width: number): string[] {
    const peer = this.source.focused();
    if (peer === undefined) return [];
    return [
      borderedRow(
        style.dim(` ${this.labelOf(peer)}: deletes, moves and edits are asked, not applied`),
        width,
        style,
      ),
    ];
  }

  private labelOf(sessionId: string): string {
    return (
      this.source.sessions().find((session) => session.sessionId === sessionId)?.label ??
      sessionId.slice(0, 8)
    );
  }

  private footer(): string {
    if (this.message !== undefined) return ` ${this.message} `;
    const keys =
      this.source.focused() === undefined
        ? "j/k move · J/K reorder · d delete · u undo · e edit · Enter send now · [/] queues · Esc close"
        : "j/k move · d delete · e edit · [/] queues · Esc close";
    return ` ${keys} `;
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
  e: "edit",
  "[": "focusPrevious",
  "]": "focusNext",
  "\r": "send",
};

const QUEUE_MANAGER_NAMED_KEYS: ReadonlyArray<readonly [KeyId, QueueManagerAction]> = [
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
