import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { type Static, Type } from "typebox";

import type { QueueDirection } from "./queue-model.ts";
import type { QueueActionResult, QueueService } from "./queue-service.ts";

/**
 * The agent-facing `queue` tool.
 *
 * Pi's own follow-up queue is invisible to extensions: there is no API to read it and
 * `hasPendingMessages()` is only a boolean. This tool is what makes the queue legible — the
 * same log the manager overlay shows, addressed by id, with provenance on every row. An
 * agent can put work on its own queue, correct or drop a queued ask, reorder it, checkpoint
 * before branching, and reach another session's queue; where a change belongs to somebody
 * else it is posted as an op for that session to apply, and the result says so
 * (`applied: "delegated"`).
 *
 * The shape deliberately mirrors intercom — `session` addresses the queue *of* a session, not
 * a session itself — so cross-session conversation stays intercom's job and this stays the
 * queue's.
 */

const ACTIONS = {
  list: "list",
  enqueue: "enqueue",
  edit: "edit",
  delete: "delete",
  restore: "restore",
  release: "release",
  move: "move",
  deliver_now: "deliver_now",
  checkpoint: "checkpoint",
  list_checkpoints: "list_checkpoints",
  restore_checkpoint: "restore_checkpoint",
  sessions: "sessions",
  inspect: "inspect",
} as const;

type QueueToolAction = keyof typeof ACTIONS;

const Parameters = Type.Object({
  action: Type.Enum(ACTIONS, {
    description: "What to do with the queue.",
  }),
  id: Type.Optional(
    Type.String({
      description: "Entry id from a previous list. For edit/delete/restore/release/move.",
    }),
  ),
  index: Type.Optional(
    Type.Number({
      description: "0-based position in the pending view, instead of id (this session only).",
    }),
  ),
  text: Type.Optional(Type.String({ description: "Prompt text. Required for enqueue and edit." })),
  kind: Type.Optional(
    Type.Enum(
      { prompt: "prompt", note: "note" },
      {
        description:
          "A note waits to be released by hand; a prompt delivers on its own. Default prompt.",
      },
    ),
  ),
  direction: Type.Optional(Type.Enum({ up: "up", down: "down" }, { description: "For move." })),
  session: Type.Optional(
    Type.String({
      description: "Address another session's queue by name or id. Omit for this session's.",
    }),
  ),
  includeDropped: Type.Optional(
    Type.Boolean({
      description: "For list: also return entries the queue dropped but still remembers.",
    }),
  ),
  name: Type.Optional(Type.String({ description: "Checkpoint name, for checkpoint." })),
  checkpoint: Type.Optional(Type.String({ description: "Checkpoint id, for restore_checkpoint." })),
  all: Type.Optional(
    Type.Boolean({
      description:
        "For restore_checkpoint: re-add everything in it, including still-pending entries (they dedupe by id).",
    }),
  ),
});

type Params = Static<typeof Parameters>;

function ok<T>(value: T): AgentToolResult<T> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** One handler per action, so `execute` stays a lookup rather than a branch tree. */
type Handler = (queue: QueueService, params: Params) => unknown;

const HANDLERS: Record<QueueToolAction, Handler> = {
  list: (queue, params) =>
    queue.list({
      ...(params.includeDropped === undefined ? {} : { includeDropped: params.includeDropped }),
      ...optSession(params),
    }),
  sessions: (queue) => queue.sessions(),
  inspect: (queue, params) => {
    const target = text(params.session);
    return target === undefined ? refusedOn("inspect needs a session") : queue.inspect(target);
  },
  enqueue: (queue, params) => {
    const body = text(params.text);
    if (body === undefined) return refusedOn("enqueue needs text");
    const kind = text(params.kind);
    return queue.enqueue({
      text: body,
      ...(kind === undefined ? {} : { kind: kind as "note" | "prompt" }),
      ...optSession(params),
    });
  },
  edit: (queue, params) => {
    const body = text(params.text);
    const id = target(queue, params);
    if (body === undefined) return refusedOn("edit needs text");
    if (typeof id !== "string") return id;
    return queue.edit(id, body, session(params));
  },
  delete: (queue, params) => {
    const id = target(queue, params);
    return typeof id === "string" ? queue.delete(id, session(params)) : id;
  },
  restore: (queue, params) => {
    const id = target(queue, params);
    return typeof id === "string" ? queue.restore(id, session(params)) : id;
  },
  release: (queue, params) => {
    const id = target(queue, params);
    return typeof id === "string" ? queue.release(id, session(params)) : id;
  },
  move: (queue, params) => {
    const id = target(queue, params);
    if (typeof id !== "string") return id;
    const direction = (text(params.direction) ?? "down") as QueueDirection;
    return queue.move(id, direction, session(params));
  },
  deliver_now: (queue, params) => queue.deliverNow(session(params)),
  checkpoint: (queue, params) =>
    queue.checkpoint(text(params.name) ?? `checkpoint-${Math.floor(Date.now() / 1000)}`),
  list_checkpoints: (queue) => queue.checkpoints(),
  restore_checkpoint: (queue, params) => {
    const id = text(params.checkpoint);
    return id === undefined
      ? refusedOn("restore_checkpoint needs checkpoint")
      : queue.restoreCheckpoint(id, params.all === true);
  },
};

function session(params: Params): string | undefined {
  return params.session;
}

function optSession(params: Params): { session?: string } {
  return params.session === undefined ? {} : { session: params.session };
}

/** Resolve id-or-index once, so every mutating action reports the same refusal. */
function target(queue: QueueService, params: Params): string | QueueActionResult {
  const id = queue.resolveId(
    text(params.id),
    typeof params.index === "number" ? params.index : undefined,
    session(params),
  );
  return id ?? refusedOn("this action needs an id, or an index into this session's pending queue");
}

function refusedOn(reason: string): QueueActionResult {
  return { applied: "refused", reason };
}

/** Build the tool over a service, kept free of pi's context so the contract is testable. */
export function createQueueTool(service: () => QueueService): ToolDefinition<typeof Parameters> {
  return {
    name: "queue",
    label: "Queue",
    description:
      "View and manage this agent's prompt queue: prompts waiting to be run, in order, " +
      "each with who authored it and when. Enqueue work for later, correct or drop a " +
      "queued prompt, reorder it, checkpoint the queue before changing course, or address " +
      "another session's queue by name. Talking to another agent is intercom's job; this " +
      "tool is about prompts waiting to be run.",
    promptSnippet:
      "Inspect and manage the prompt queue (waiting prompts, provenance, checkpoints).",
    promptGuidelines: [
      "Use the queue tool for prompts waiting to be run; use intercom to talk to another agent.",
      "Every queue entry records its author and time; cite that provenance when you explain why something is waiting.",
      "Before changing course in a way that would lose context, take a checkpoint of the queue.",
      "An op addressed to another session is posted for that session to apply and reports 'delegated'; it does not change your own queue.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, params) {
      const handler = HANDLERS[params.action as QueueToolAction];
      if (handler === undefined) return ok(refusedOn(`unknown action ${String(params.action)}`));
      return ok(handler(service(), params as Params));
    },
  };
}

/** Register the tool. `as never` bridges the host's generic ToolDefinition parameter list. */
export function registerQueueTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  service: () => QueueService,
): void {
  // A host without registerTool (older than the tool API) simply keeps the queue
  // human-facing; the manager, delivery and file store all work without it.
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool(createQueueTool(service) as never);
}
