import {
  getAgentDir,
  SettingsManager,
  type CompactionSettings,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";
import { createKillerosSettingsStore } from "./settings.ts";

export const DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING = 15;
export const AUTO_COMPACTION_MESSAGE_TYPE = "killeros-auto-compaction";
export const AUTO_COMPACTION_MESSAGE = "Continue the interrupted task from the compacted context.";

export interface AutoCompactionPreference {
  enabled: boolean;
  percentRemaining: number;
}

export interface AutoCompactionGoalHandlers {
  isActive(ctx: ExtensionContext): boolean;
  onRequested(): void;
  onCompleted(ctx: ExtensionContext): void;
  onFailed(ctx: ExtensionContext, error: unknown): void;
}

export interface AutoCompactionDependencies {
  loadPreference?: (ctx: ExtensionContext) => AutoCompactionPreference;
  getCompactionSettings?: (ctx: ExtensionContext) => CompactionSettings;
  goal?: AutoCompactionGoalHandlers;
}

interface AutoCompactionRequest {
  goal: boolean;
  token: symbol;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readAutoCompactionPreference(
  settings: Readonly<Record<string, unknown>>,
): AutoCompactionPreference {
  const raw = isRecord(settings.autoCompaction) ? settings.autoCompaction : {};
  const percentRemaining = typeof raw.percentRemaining === "number"
    && Number.isFinite(raw.percentRemaining)
    && raw.percentRemaining >= 0
    && raw.percentRemaining <= 100
    ? raw.percentRemaining
    : DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    percentRemaining,
  };
}

function defaultPreference(): AutoCompactionPreference {
  return readAutoCompactionPreference(createKillerosSettingsStore().load());
}

function defaultCompactionSettings(ctx: ExtensionContext): CompactionSettings {
  return SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  }).getCompactionSettings();
}

function reserveTokens(settings: Pick<CompactionSettings, "reserveTokens">): number {
  return typeof settings.reserveTokens === "number" && Number.isFinite(settings.reserveTokens)
    ? Math.max(0, settings.reserveTokens)
    : 0;
}

/** Triggers at the stricter of the user's percentage and Pi's token reserve. */
export function shouldTriggerAutoCompaction(
  usage: Pick<ContextUsage, "tokens" | "contextWindow"> | undefined,
  preference: AutoCompactionPreference,
  compactionSettings: Pick<CompactionSettings, "enabled" | "reserveTokens">,
): boolean {
  if (!preference.enabled || !compactionSettings.enabled || usage?.tokens === undefined || usage.tokens === null) {
    return false;
  }
  if (!Number.isFinite(usage.tokens) || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
    return false;
  }
  const remainingTokens = usage.contextWindow - usage.tokens;
  const threshold = Math.max(
    usage.contextWindow * preference.percentRemaining / 100,
    reserveTokens(compactionSettings),
  );
  return remainingTokens <= threshold;
}

function supportedMode(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function registerAutoCompaction(
  pi: ExtensionAPI,
  dependencies: AutoCompactionDependencies = {},
): void {
  const loadPreference = dependencies.loadPreference ?? (() => defaultPreference());
  const getCompactionSettings = dependencies.getCompactionSettings ?? defaultCompactionSettings;
  let request: AutoCompactionRequest | undefined;
  let armed = true;
  let settingsErrorReported = false;

  const resetForLifecycle = (): void => {
    request = undefined;
    armed = true;
    settingsErrorReported = false;
  };

  const notifyFailure = (ctx: ExtensionContext, error: unknown): void => {
    ctx.ui.notify(`Automatic compaction failed: ${errorMessage(error)}`, "error");
  };

  const finishFailure = (
    ctx: ExtensionContext,
    token: symbol,
    goal: boolean,
    error: unknown,
  ): void => {
    if (!request || request.token !== token) return;
    request = undefined;
    if (goal && dependencies.goal) {
      try {
        dependencies.goal.onFailed(ctx, error);
      } catch (callbackError) {
        notifyFailure(ctx, callbackError);
      }
      return;
    }
    notifyFailure(ctx, error);
  };

  pi.on("turn_end", (_event, ctx) => {
    if (!supportedMode(ctx) || request) return;

    let preference: AutoCompactionPreference;
    let compactionSettings: CompactionSettings;
    let usage: ContextUsage | undefined;
    try {
      preference = loadPreference(ctx);
      compactionSettings = getCompactionSettings(ctx);
    } catch (error) {
      if (!settingsErrorReported) {
        settingsErrorReported = true;
        ctx.ui.notify(`Automatic compaction settings could not be read: ${errorMessage(error)}`, "error");
      }
      return;
    }
    try {
      usage = ctx.getContextUsage();
    } catch {
      return;
    }
    if (!usage) return;
    if (usage.tokens !== null && usage.tokens !== undefined && Number.isFinite(usage.tokens)
      && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
      const remainingTokens = usage.contextWindow - usage.tokens;
      const threshold = Math.max(
        usage.contextWindow * preference.percentRemaining / 100,
        reserveTokens(compactionSettings),
      );
      if (remainingTokens > threshold) {
        armed = true;
      }
    }
    if (!armed) return;
    if (!shouldTriggerAutoCompaction(usage, preference, compactionSettings)) return;

    armed = false;
    const token = Symbol();
    const goal = dependencies.goal?.isActive(ctx) === true;
    request = { goal, token };
    if (goal && dependencies.goal) {
      try {
        dependencies.goal.onRequested();
      } catch (error) {
        finishFailure(ctx, token, true, error);
        return;
      }
    }

    try {
      ctx.compact({
        onComplete: () => {
          if (!request || request.token !== token) return;
          request = undefined;
          if (goal && dependencies.goal) {
            try {
              dependencies.goal.onCompleted(ctx);
            } catch (error) {
              notifyFailure(ctx, error);
            }
            return;
          }
          try {
            pi.sendMessage({
              customType: AUTO_COMPACTION_MESSAGE_TYPE,
              content: AUTO_COMPACTION_MESSAGE,
              display: false,
            }, { triggerTurn: true, deliverAs: "followUp" });
          } catch (error) {
            notifyFailure(ctx, error);
          }
        },
        onError: (error) => finishFailure(ctx, token, goal, error),
      });
    } catch (error) {
      finishFailure(ctx, token, goal, error);
    }
  });

  pi.on("session_start", resetForLifecycle);
  pi.on("session_shutdown", resetForLifecycle);
  pi.on("session_tree", resetForLifecycle);
  pi.on("session_before_switch", resetForLifecycle);
  pi.on("session_before_fork", resetForLifecycle);
}
