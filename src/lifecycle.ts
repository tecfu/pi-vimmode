import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ResolvedVimEditorOptions } from "./types.ts";

import {
  createVimConfigPlan,
  DEFAULT_VIM_OPTIONS,
  loadVimOptions,
  type VimConfigLoadResult,
  type VimConfigPaths,
  type VimRuntimeConfiguration,
} from "./config.ts";
import { PromptQueue, type PromptQueueFacade, type QueuedPrompt } from "./prompt-queue.ts";
import { type QueueAuthor, type QueueAuthorVia } from "./queue-model.ts";
import { connectIntercom, type PeerKnocker } from "./queue-peer.ts";
import { QueueService, type CheckpointCapture } from "./queue-service.ts";
import { type QueueIdentity, defaultQueueDir, QueueFile } from "./queue-store.ts";
import { queuePaths } from "./queue-store.ts";
import { registerQueueTool } from "./queue-tool.ts";
import { type ResetTerminalCursorStyleOptions, VimEditor } from "./vim-editor.ts";

type VimEditorFactory = (
  tui: ConstructorParameters<typeof VimEditor>[0],
  theme: ConstructorParameters<typeof VimEditor>[1],
  keybindings: ConstructorParameters<typeof VimEditor>[2],
) => VimEditor;

/** Callback type for shutdown requests from VimEditor. */
export type VimShutdownCallback = () => void;

type EditorComponentFactory = ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
type TrackedEditor = Pick<
  VimEditor,
  "reconfigure" | "resetTerminalCursorStyle" | "setAgentBusy" | "setQueueMode" | "updateDiagnostics"
>;
type CreateEditor = (
  tui: ConstructorParameters<typeof VimEditor>[0],
  theme: ConstructorParameters<typeof VimEditor>[1],
  keybindings: ConstructorParameters<typeof VimEditor>[2],
  configuration: VimRuntimeConfiguration,
  vimOptions?: {
    onShutdown?: () => void;
    onQueueMessage?: (text: string) => void;
    onQueueModeChange?: (active: boolean) => void;
    queue?: PromptQueueFacade;
  },
) => TrackedEditor;
type Schedule = (callback: () => void) => void;

export type VimLifecycleDependencies = {
  defaultOptions?: ResolvedVimEditorOptions;
  loadOptions?: (paths: VimConfigPaths) => VimConfigLoadResult | Promise<VimConfigLoadResult>;
  createEditor?: CreateEditor;
  schedule?: Schedule;
  /** Where queue files live; defaults to the agent's queue directory. */
  queueDir?: string;
};

type ConfigState = {
  configuration: () => VimRuntimeConfiguration;
  refresh: (ctx: ExtensionContext) => boolean | Promise<boolean>;
  invalidate: () => void;
};

function serializePlan(configuration: VimRuntimeConfiguration): string {
  return JSON.stringify([configuration.plan.options, configuration.plan.scopes]);
}

function serializeDiagnostics(configuration: VimRuntimeConfiguration): string {
  return JSON.stringify(configuration.diagnostics);
}

function createConfigState(
  dependencies: VimLifecycleDependencies,
  onUpdate: (configuration: VimRuntimeConfiguration, committed: boolean) => void,
): ConfigState {
  const initialPlan = createVimConfigPlan(dependencies.defaultOptions ?? DEFAULT_VIM_OPTIONS, []);
  let currentConfiguration: VimRuntimeConfiguration = {
    plan: initialPlan,
    diagnostics: initialPlan.diagnostics,
  };
  let hasCommittedLoad = false;
  let refreshGeneration = 0;
  const loadOptions = dependencies.loadOptions ?? loadVimOptions;

  const apply = (ctx: ExtensionContext, loaded: VimConfigLoadResult) => {
    const previousPlan = serializePlan(currentConfiguration);
    const previousDiagnostics = serializeDiagnostics(currentConfiguration);
    const committed = !loaded.fatal || !hasCommittedLoad;
    const plan = committed ? loaded.plan : currentConfiguration.plan;
    if (committed) hasCommittedLoad = true;
    currentConfiguration = {
      plan,
      diagnostics: loaded.fatal ? loaded.plan.diagnostics : plan.diagnostics,
    };
    const planChanged = serializePlan(currentConfiguration) !== previousPlan;
    const diagnosticsChanged = serializeDiagnostics(currentConfiguration) !== previousDiagnostics;
    if (planChanged || diagnosticsChanged) onUpdate(currentConfiguration, planChanged);
    ctx.ui.setStatus(
      "pi-vimmode",
      currentConfiguration.diagnostics.warnings.length > 0 ? "vim ⚠" : "vim",
    );
  };
  const applyFailure = (ctx: ExtensionContext, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const warnings = [`global JS config: failed to load (${message})`];
    apply(ctx, {
      plan: createVimConfigPlan(currentConfiguration.plan.options, warnings),
      options: currentConfiguration.plan.options,
      warnings,
      fatal: true,
    });
  };
  const refresh = (ctx: ExtensionContext): boolean | Promise<boolean> => {
    const generation = ++refreshGeneration;
    try {
      const loaded = loadOptions({ cwd: ctx.cwd });
      if (loaded instanceof Promise) {
        return loaded.then(
          (result) => {
            if (generation !== refreshGeneration) return false;
            apply(ctx, result);
            return true;
          },
          (error) => {
            if (generation !== refreshGeneration) return false;
            applyFailure(ctx, error);
            return true;
          },
        );
      }
      apply(ctx, loaded);
    } catch (error) {
      applyFailure(ctx, error);
    }
    return true;
  };

  return {
    configuration: () => currentConfiguration,
    refresh,
    invalidate: () => {
      refreshGeneration += 1;
    },
  };
}

type EditorState = {
  config: ConfigState;
  createEditor: CreateEditor;
  schedule: Schedule;
  editors: Set<TrackedEditor>;
  editorFactory: VimEditorFactory;
  currentShutdown?: () => void;
  queueMessage?: (text: string) => void;
  queueModeChange?: (active: boolean) => void;
  /** Prompts entered while queue mode is on; Pi only ever sees the head. */
  queue: PromptQueue;
  queueFile: QueueFile;
  /** The same queue, addressed across sessions: what the `queue` tool drives. Built on
   first use, because it closes over state and cannot be constructed inside its literal. */
  queueService?: QueueService;
  /** Session manager snapshot, captured from the last context pi handed us. */
  queueBranch?: () => CheckpointCapture | undefined;
  /** Cached because connecting to pi-intercom is a handshake, not a per-call probe. */
  peerKnocker?: PeerKnocker | null;
  queueFacade?: PromptQueueFacade;
  deliverPrompt?: (prompt: QueuedPrompt) => boolean;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  enabled: boolean;
  agentBusy: boolean;
  queueMode: boolean;
  previousEditorFactory?: EditorComponentFactory;
  hasInstalledFactory: boolean;
  installGeneration: number;
};

function finishInstall(state: EditorState, ctx: ExtensionContext, force = false): void {
  state.currentShutdown = () => ctx.shutdown();
  state.notify = (message, level = "info") => ctx.ui.notify(message, level);
  const current = ctx.ui.getEditorComponent();
  if (current === state.editorFactory) {
    state.hasInstalledFactory = true;
    return;
  }
  if (
    !force &&
    state.hasInstalledFactory &&
    current !== undefined &&
    current !== state.previousEditorFactory
  ) {
    return;
  }
  state.previousEditorFactory = current;
  ctx.ui.setEditorComponent(state.editorFactory);
  state.hasInstalledFactory = true;
}

function installEditor(
  state: EditorState,
  ctx: ExtensionContext,
  force = false,
  generation = state.installGeneration,
): void | Promise<void> {
  if (generation !== state.installGeneration) return;
  if (!state.enabled) {
    ctx.ui.setStatus("pi-vimmode", "vim off");
    return;
  }
  const refreshed = state.config.refresh(ctx);
  if (refreshed instanceof Promise) {
    return refreshed.then((applied) => {
      if (!applied || generation !== state.installGeneration) return;
      if (state.enabled) finishInstall(state, ctx, force);
      else ctx.ui.setStatus("pi-vimmode", "vim off");
    });
  }
  finishInstall(state, ctx, force);
}

function resetKnownEditors(state: EditorState, options?: ResetTerminalCursorStyleOptions): void {
  for (const editor of state.editors) editor.resetTerminalCursorStyle(options);
  state.editors.clear();
}

function createEditorState(dependencies: VimLifecycleDependencies): EditorState {
  let state: EditorState;
  const config = createConfigState(dependencies, (configuration, planChanged) => {
    if (!state?.enabled) return;
    for (const editor of state.editors) {
      if (planChanged) editor.reconfigure(configuration.plan, configuration.diagnostics);
      else editor.updateDiagnostics(configuration.diagnostics);
    }
  });
  state = {
    config,
    createEditor:
      dependencies.createEditor ??
      ((tui, theme, keybindings, configuration, vimOptions) =>
        new VimEditor(tui, theme, keybindings, configuration, vimOptions)),
    schedule: dependencies.schedule ?? ((callback) => setTimeout(callback, 0)),
    editors: new Set<TrackedEditor>(),
    editorFactory: undefined as unknown as VimEditorFactory,
    enabled: true,
    agentBusy: false,
    queueMode: false,
    queueFile: new QueueFile(dependencies.queueDir ?? defaultQueueDir()),
    queue: new PromptQueue({ author: (via) => queueAuthor(state.queueFile, via) }),
    hasInstalledFactory: false,
    installGeneration: 0,
  };
  state.editorFactory = (tui, theme, keybindings) => {
    const editor = state.createEditor(tui, theme, keybindings, state.config.configuration(), {
      onShutdown: state.currentShutdown,
      onQueueMessage: state.queueMessage,
      onQueueModeChange: state.queueModeChange,
      queue: state.queueFacade,
    });
    state.editors.add(editor);
    if (state.agentBusy) editor.setAgentBusy(true);
    if (state.queueMode) editor.setQueueMode(true);
    return editor as VimEditor;
  };
  return state;
}

function observeInstall(install: void | Promise<void>, ctx: ExtensionContext): void {
  if (!(install instanceof Promise)) return;
  void install.catch((error: unknown) => {
    try {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`pi-vimmode install failed: ${message}`, "error");
    } catch {
      // Context went stale while reporting the original failure.
    }
  });
}

function installEditorSoon(state: EditorState, ctx: ExtensionContext): void {
  const generation = state.installGeneration;
  observeInstall(installEditor(state, ctx, false, generation), ctx);
  state.schedule(() => {
    if (generation !== state.installGeneration) return;
    try {
      observeInstall(installEditor(state, ctx, false, generation), ctx);
    } catch {
      // Context can go stale during reload/session switch. Next session_start will reinstall.
    }
  });
}

function disableEditor(state: EditorState, ctx: ExtensionContext): void {
  state.enabled = false;
  state.agentBusy = false;
  resetKnownEditors(state);
  if (ctx.ui.getEditorComponent() === state.editorFactory) {
    ctx.ui.setEditorComponent(state.previousEditorFactory);
    state.hasInstalledFactory = false;
  }
  ctx.ui.setStatus("pi-vimmode", "vim off");
}

/**
 * Who a queued prompt is attributed to. A peer reading the file needs an answer
 * that is not "the machine", so the session's own name is what is recorded.
 */
function queueAuthor(file: QueueFile, via: QueueAuthorVia): QueueAuthor {
  const identity = file.identity();
  if (identity === undefined) return { session: "human", sessionId: "", cwd: "", via };
  return { session: identity.name, sessionId: identity.sessionId, cwd: identity.cwd, via };
}

function sessionIdentity(ctx: ExtensionContext): QueueIdentity | undefined {
  const manager = ctx.sessionManager;
  const sessionId = typeof manager?.getSessionId === "function" ? manager.getSessionId() : "";
  if (sessionId.length === 0) return undefined;
  const named =
    typeof manager?.getSessionName === "function" ? manager.getSessionName() : undefined;
  const file = typeof manager?.getSessionFile === "function" ? manager.getSessionFile() : undefined;
  return {
    sessionId,
    name: named ?? sessionId.slice(0, 8),
    cwd: typeof manager?.getCwd === "function" ? manager.getCwd() : "",
    pid: process.pid,
    ...(file === undefined ? {} : { sessionFile: file }),
  };
}

/**
 * The queue as the fleet sees it. Built late and once: it closes over the live queue and the
 * bound identity, both of which only exist after the first session_start.
 */
function queueServiceFor(state: EditorState, pi: ExtensionAPI): QueueService {
  state.queueService ??= new QueueService({
    paths: queuePaths(state.queueFile.root),
    queue: state.queue,
    identity: () => state.queueFile.identity() ?? anonymousIdentity(),
    author: (via) => queueAuthor(state.queueFile, via),
    knocker: () => {
      state.peerKnocker ??= connectIntercom((pi as { events?: unknown }).events);
      return state.peerKnocker;
    },
    peerTrust: "auto",
    flush: () => deliverQueueHead(state),
    captureBranch: () => state.queueBranch?.(),
  });
  return state.queueService;
}

function anonymousIdentity(): QueueIdentity {
  return { sessionId: "", name: "this session", cwd: process.cwd(), pid: process.pid };
}

/**
 * What the agent was looking at, in the form a checkpoint archives. Only message entries
 * carry context worth keeping, and a non-message entry still gets a row so the branch's shape
 * survives — a checkpoint that silently drops half the tree would misreport what it captured.
 */
function captureBranchFrom(ctx: ExtensionContext): CheckpointCapture | undefined {
  const manager = ctx.sessionManager as unknown as
    | {
        getBranch?: () => Array<{
          id: string;
          type: string;
          message?: { role?: string; content?: unknown };
        }>;
        getLeafId?: () => string | null;
      }
    | undefined;
  if (manager === undefined || typeof manager.getBranch !== "function") return undefined;
  const branch = manager.getBranch().map((entry) => ({
    entryId: entry.id,
    role: entry.message?.role ?? entry.type,
    text: firstText(entry.message?.content),
  }));
  return {
    branch,
    leafId: typeof manager.getLeafId === "function" ? (manager.getLeafId() ?? null) : null,
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) return text;
    }
  }
  return "";
}

/**
 * A queue's durable home is found at session start, not at construction: the
 * same session restarts with its own file, a resumed session inherits the file
 * of the thread it was resumed from, and a session with no identity (a test
 * harness, a headless probe) simply stays in memory.
 */
function hydrateQueue(
  state: EditorState,
  event: unknown,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  const identity = sessionIdentity(ctx);
  if (identity === undefined) {
    state.queue.attach(undefined);
    return;
  }
  state.queueFile.bind(identity);
  state.queue.attach(state.queueFile);
  queueServiceFor(state, pi).claim();
  const held = state.queueFile.load();
  if (held !== undefined) {
    state.queue.restore(held);
    return;
  }
  const previous = (event as { previousSessionFile?: unknown }).previousSessionFile;
  if (typeof previous !== "string" || previous.length === 0) return;
  const adopted = state.queueFile.adopt(previous);
  if (adopted.adopted > 0) state.queue.restore(adopted.log);
}

/**
 * Keep a way to read the session branch without holding a stale context: the closure asks pi
 * for the branch at checkpoint time, and it is re-taken whenever pi hands us a fresh context.
 */
function observeSessionBranch(state: EditorState, ctx: ExtensionContext): void {
  state.queueBranch = () => captureBranchFrom(ctx);
}

function notifyVimStatus(state: EditorState, ctx: ExtensionContext): void {
  ctx.ui.notify(`pi-vimmode ${state.enabled ? "enabled" : "disabled"}`, "info");
}

async function reloadVim(state: EditorState, ctx: ExtensionContext): Promise<void> {
  if (!(await state.config.refresh(ctx))) return;
  if (state.enabled) finishInstall(state, ctx);
  ctx.ui.notify(`pi-vimmode ${state.enabled ? "reloaded" : "config reloaded (disabled)"}`, "info");
}

async function handleVimCommand(
  input: string,
  state: EditorState,
  ctx: ExtensionContext,
): Promise<void> {
  const [action = "toggle", ...rest] = input.split(/\s+/).filter(Boolean);
  if (action === "queue") return handleQueueCommand(rest[0] ?? "toggle", state, ctx);
  if (action === "status") return notifyVimStatus(state, ctx);
  if (action === "reload") return reloadVim(state, ctx);
  if (!new Set(["toggle", "on", "off"]).has(action)) {
    ctx.ui.notify(
      "Usage: /vimmode [on|off|toggle|status|reload] | /vimmode queue [on|off|toggle|status]",
      "warning",
    );
    return;
  }
  const enable = action === "on" || (action === "toggle" && !state.enabled);
  if (enable) {
    state.enabled = true;
    await installEditor(state, ctx, true);
  } else {
    disableEditor(state, ctx);
  }
  notifyVimStatus(state, ctx);
}

const QUEUE_MODE_ENABLED_MESSAGE =
  "pi-vimmode queue mode enabled: submits during a running turn are queued as follow-ups";
const QUEUE_MODE_DISABLED_MESSAGE = "pi-vimmode queue mode disabled";

function deliverPromptAsFollowUp(pi: ExtensionAPI, prompt: QueuedPrompt): boolean {
  try {
    pi.sendUserMessage(prompt.text, { deliverAs: "followUp" });
    return true;
  } catch {
    return false;
  }
}

/** Hand the oldest queued prompt to Pi; the rest wait for later settles. */
function deliverQueueHead(state: EditorState): void {
  if (state.queue.size === 0) return;
  state.queueFacade?.deliverNow(0);
}

/**
 * `agent_settled` exists in Pi's runtime API but not in the extension typings
 * this repo pins, so the event name is widened here rather than everywhere.
 */
function onAgentSettled(pi: ExtensionAPI, handler: () => void): void {
  const register = pi.on as unknown as (event: string, handler: () => void) => () => void;
  register("agent_settled", handler);
}

function applyQueueMode(
  state: EditorState,
  enable: boolean,
  notify?: (message: string, level?: "info" | "warning" | "error") => void,
): void {
  state.queueMode = enable;
  for (const editor of state.editors) editor.setQueueMode(enable);
  notify?.(enable ? QUEUE_MODE_ENABLED_MESSAGE : QUEUE_MODE_DISABLED_MESSAGE);
}

function handleQueueCommand(subaction: string, state: EditorState, ctx: ExtensionContext): void {
  if (!new Set(["toggle", "on", "off", "status"]).has(subaction)) {
    ctx.ui.notify("Usage: /vimmode queue [on|off|toggle|status]", "warning");
    return;
  }
  if (subaction === "status") {
    const pending = state.queue.size;
    ctx.ui.notify(
      `pi-vimmode queue mode ${state.queueMode ? "enabled" : "disabled"}` +
        (pending > 0 ? ` (${pending} queued)` : ""),
      "info",
    );
    return;
  }
  const enable = subaction === "on" || (subaction === "toggle" && !state.queueMode);
  applyQueueMode(state, enable, (message, level) => ctx.ui.notify(message, level));
}

function registerVimCommand(pi: ExtensionAPI, state: EditorState): void {
  pi.registerCommand("vimmode", {
    description: "Toggle pi-vimmode editor on/off; 'queue' toggles follow-up queue mode",
    handler: (args, ctx) => handleVimCommand(args.trim().toLowerCase() || "toggle", state, ctx),
  });
}

export function registerVimLifecycle(
  pi: ExtensionAPI,
  dependencies: VimLifecycleDependencies = {},
): void {
  const state = createEditorState(dependencies);
  state.queueFacade = state.queue.facade((prompt) => state.deliverPrompt?.(prompt) ?? false);
  state.deliverPrompt = (prompt) => deliverPromptAsFollowUp(pi, prompt);
  // Queue mode owns the list: submits land here, and one prompt per settle goes
  // to Pi as a follow-up, so the manager can delete or reorder before delivery.
  state.queueMessage = (text) => {
    state.queue.enqueue(text);
    if (!state.agentBusy) deliverQueueHead(state);
  };
  state.queueModeChange = (active) => applyQueueMode(state, active, state.notify);
  registerVimCommand(pi, state);
  // The agent's view of the same queue. Registered once, at setup: pi has no
  // unregisterTool, so it lives or dies with the extension, not with a session.
  registerQueueTool(pi, () => queueServiceFor(state, pi));
  pi.on("session_start", (event, ctx) => {
    hydrateQueue(state, event, ctx, pi);
    observeSessionBranch(state, ctx);
    // A session that was asleep while peers posted to it reads its mail the moment it wakes,
    // before anyone can type: an op nobody acted on is not allowed to look like an empty queue.
    queueServiceFor(state, pi).drainOps();
    installEditorSoon(state, ctx);
  });
  pi.on("resources_discover", (_event, ctx) => {
    observeSessionBranch(state, ctx);
    installEditorSoon(state, ctx);
  });
  pi.on("agent_start", () => {
    state.agentBusy = true;
    for (const editor of state.editors) editor.setAgentBusy(true);
  });
  pi.on("agent_end", (_event, ctx) => {
    state.agentBusy = false;
    for (const editor of state.editors) editor.setAgentBusy(false);
    observeInstall(installEditor(state, ctx), ctx);
  });
  onAgentSettled(pi, () => {
    // Mail first, then the head of what is now waiting: a peer's prompt that arrived during
    // the turn is part of the queue the settle is supposed to drain, not a later event.
    queueServiceFor(state, pi).drainOps();
    if (state.enabled) deliverQueueHead(state);
  });
  pi.on("session_shutdown", (event) => {
    state.agentBusy = false;
    state.config.invalidate();
    state.installGeneration += 1;
    state.currentShutdown = undefined;
    state.previousEditorFactory = undefined;
    state.hasInstalledFactory = false;
    resetKnownEditors(state, {
      restoreHardwareCursorVisibility: event.reason !== "quit",
    });
  });
}
