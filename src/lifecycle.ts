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
  },
) => TrackedEditor;
type Schedule = (callback: () => void) => void;

export type VimLifecycleDependencies = {
  defaultOptions?: ResolvedVimEditorOptions;
  loadOptions?: (paths: VimConfigPaths) => VimConfigLoadResult | Promise<VimConfigLoadResult>;
  createEditor?: CreateEditor;
  schedule?: Schedule;
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
    hasInstalledFactory: false,
    installGeneration: 0,
  };
  state.editorFactory = (tui, theme, keybindings) => {
    const editor = state.createEditor(tui, theme, keybindings, state.config.configuration(), {
      onShutdown: state.currentShutdown,
      onQueueMessage: state.queueMessage,
      onQueueModeChange: state.queueModeChange,
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
    ctx.ui.notify(`pi-vimmode queue mode ${state.queueMode ? "enabled" : "disabled"}`, "info");
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
  state.queueMessage = (text) => pi.sendUserMessage(text, { deliverAs: "followUp" });
  state.queueModeChange = (active) => applyQueueMode(state, active, state.notify);
  registerVimCommand(pi, state);
  pi.on("session_start", (_event, ctx) => installEditorSoon(state, ctx));
  pi.on("resources_discover", (_event, ctx) => installEditorSoon(state, ctx));
  pi.on("agent_start", () => {
    state.agentBusy = true;
    for (const editor of state.editors) editor.setAgentBusy(true);
  });
  pi.on("agent_end", (_event, ctx) => {
    state.agentBusy = false;
    for (const editor of state.editors) editor.setAgentBusy(false);
    observeInstall(installEditor(state, ctx), ctx);
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
