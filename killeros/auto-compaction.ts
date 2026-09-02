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
/** Pi's exact rejection when a session has no eligible history to summarize; an expected skip, not a failure. */
export const SESSION_TOO_SMALL_COMPACTION_ERROR = "Nothing to compact (session too small)";

export interface AutoCompactionPreference {
  enabled: boolean;
  percentRemaining: number;
}

export interface AutoCompactionGoalHandlers {
  isActive(ctx: ExtensionContext): boolean;
  onRequested(): void;
  onCompleted(ctx: ExtensionContext): void;
  onFailed(ctx: ExtensionContext, error: unknown): void;
  /** Recovers the goal paused for a request Pi rejected as session-too-small, without claiming success. */
  onSkipped(ctx: ExtensionContext): void;
}

export interface AutoCompactionDependencies {
  loadPreference?: (ctx: ExtensionContext) => AutoCompactionPreference;
  getCompactionSettings?: (ctx: ExtensionContext) => CompactionSettings;
  goal?: AutoCompactionGoalHandlers;
}

type AutoCompactionRequest = {
  phase: "compacting";
  goal: boolean;
  token: symbol;
  turnSettled: boolean;
  compactionCompleted: boolean;
} | {
  phase: "continuation-dispatched";
  goal: false;
};

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

/** Matches only Pi's exact rejection text on a real Error; near-matches and stringified values stay failures. */
export function isSessionTooSmallCompactionError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_TOO_SMALL_COMPACTION_ERROR;
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

  const finishFailure = (ctx: ExtensionContext, goal: boolean, error: unknown): void => {
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

  /** Ends a request with Pi's expected eligibility rejection: silent, rearmed, and never a failure. */
  const finishSkip = (ctx: ExtensionContext, goal: boolean): void => {
    request = undefined;
    armed = true;
    if (!goal) return;
    try {
      dependencies.goal?.onSkipped(ctx);
    } catch (callbackError) {
      notifyFailure(ctx, callbackError);
    }
  };

  /** Single entry point for rejected requests: classifies before any sanitization, stale tokens stay inert. */
  const finishRequestError = (
    ctx: ExtensionContext,
    token: symbol,
    goal: boolean,
    error: unknown,
  ): void => {
    if (request?.phase !== "compacting" || request.token !== token) return;
    if (isSessionTooSmallCompactionError(error)) {
      finishSkip(ctx, goal);
      return;
    }
    finishFailure(ctx, goal, error);
  };

  /** Dispatches one ordinary continuation after compaction and the interrupted run have both finished. */
  const finalizeOrdinaryContinuation = (ctx: ExtensionContext, token: symbol): void => {
    if (request?.phase !== "compacting"
      || request.token !== token
      || request.goal
      || !request.turnSettled
      || !request.compactionCompleted) return;
    request = { phase: "continuation-dispatched", goal: false };
    try {
      pi.sendMessage({
        customType: AUTO_COMPACTION_MESSAGE_TYPE,
        content: AUTO_COMPACTION_MESSAGE,
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      request = undefined;
      notifyFailure(ctx, error);
    }
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
    request = {
      phase: "compacting",
      goal,
      token,
      turnSettled: false,
      compactionCompleted: false,
    };
    if (goal && dependencies.goal) {
      try {
        dependencies.goal.onRequested();
      } catch (error) {
        finishFailure(ctx, true, error);
        return;
      }
    }

    try {
      ctx.compact({
        onComplete: () => {
          if (request?.phase !== "compacting" || request.token !== token) return;
          if (goal && dependencies.goal) {
            request = undefined;
            try {
              dependencies.goal.onCompleted(ctx);
            } catch (error) {
              notifyFailure(ctx, error);
            }
            return;
          }
          request.compactionCompleted = true;
          finalizeOrdinaryContinuation(ctx, token);
        },
        onError: (error) => finishRequestError(ctx, token, goal, error),
      });
    } catch (error) {
      finishRequestError(ctx, token, goal, error);
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (request?.phase === "continuation-dispatched") {
      request = undefined;
      notifyFailure(ctx, new Error("continuation was not accepted"));
      return;
    }
    if (request?.phase !== "compacting" || request.goal) return;
    request.turnSettled = true;
    finalizeOrdinaryContinuation(ctx, request.token);
  });
  pi.on("message_start", (event) => {
    if (request?.phase === "continuation-dispatched"
      && event.message.role === "custom"
      && event.message.customType === AUTO_COMPACTION_MESSAGE_TYPE) request = undefined;
  });

  pi.on("session_start", resetForLifecycle);
  pi.on("session_shutdown", resetForLifecycle);
  pi.on("session_tree", resetForLifecycle);
  pi.on("session_before_switch", resetForLifecycle);
  pi.on("session_before_fork", resetForLifecycle);
}
