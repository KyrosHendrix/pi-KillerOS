import {
  getAgentDir,
  SettingsManager,
  type CompactionSettings,
  type ContextUsage,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";
import { GOAL_CONTINUATION_TYPE } from "./goal-model.ts";
import { isAutomationMode, readContextUsage, wasAborted } from "./pi-context.ts";
import { createKillerosSettingsStore } from "./settings.ts";
import { isRecord } from "./guards.ts";

export const DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING = 15;
/** Shown by slash-command autocomplete next to /auto-compact. */
export const AUTO_COMPACT_COMMAND_SYNTAX = "/auto-compact [status|on|off|<percent>]";
const AUTO_COMPACTION_MESSAGE_TYPE = "killeros-auto-compaction";
const AUTO_COMPACTION_MESSAGE = "Continue the interrupted task from the compacted context.";
/** Pi's exact rejection when a session has no eligible history to summarize; an expected skip, not a failure. */
const SESSION_TOO_SMALL_COMPACTION_ERROR = "Nothing to compact (session too small)";

export interface AutoCompactionPreference {
  enabled: boolean;
  percentRemaining: number;
}

export interface AutoCompactionGoalHandlers {
  isActive(ctx: ExtensionContext): boolean;
  hasAcceptedTerminalDecision(): boolean;
  onRequested(): void;
  onCompleted(ctx: ExtensionContext): void;
  onFailed(ctx: ExtensionContext, error: unknown): void;
  /** Recovers the goal paused for a request Pi rejected as session-too-small, without claiming success. */
  onSkipped(ctx: ExtensionContext): void;
}

interface AutoCompactionDependencies {
  /** Receives the current preference, or undefined when killeros.json cannot be read. */
  onPreferenceChange: (preference: AutoCompactionPreference | undefined) => void;
  goal: AutoCompactionGoalHandlers;
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

function readAutoCompactionPreference(
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

function compactionSettings(ctx: ExtensionContext): CompactionSettings {
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
function isSessionTooSmallCompactionError(error: unknown): boolean {
  return error instanceof Error && error.message === SESSION_TOO_SMALL_COMPACTION_ERROR;
}

/** Whether remaining context is at or below the stricter of the user's percentage and Pi's token reserve; undefined without a usable reading. */
function isAtThreshold(
  usage: Pick<ContextUsage, "tokens" | "contextWindow"> | undefined,
  preference: AutoCompactionPreference,
  settings: Pick<CompactionSettings, "reserveTokens">,
): boolean | undefined {
  if (usage?.tokens === undefined || usage.tokens === null || !Number.isFinite(usage.tokens)
    || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return undefined;
  const threshold = Math.max(usage.contextWindow * preference.percentRemaining / 100, reserveTokens(settings));
  return usage.contextWindow - usage.tokens <= threshold;
}

function shouldTriggerAutoCompaction(
  usage: Pick<ContextUsage, "tokens" | "contextWindow"> | undefined,
  preference: AutoCompactionPreference,
  settings: Pick<CompactionSettings, "enabled" | "reserveTokens">,
): boolean {
  return preference.enabled && settings.enabled === true && isAtThreshold(usage, preference, settings) === true;
}

function describePreference(preference: AutoCompactionPreference): string {
  return preference.enabled
    ? `Automatic compaction: on at ${preference.percentRemaining}% remaining`
    : `Automatic compaction: off (threshold ${preference.percentRemaining}%)`;
}

export function registerAutoCompaction(
  pi: ExtensionAPI,
  { onPreferenceChange, goal: goalHandlers }: AutoCompactionDependencies,
): void {
  const settingsStore = createKillerosSettingsStore();
  let request: AutoCompactionRequest | undefined;
  let goalRequestOwned = false;
  let armed = true;
  let rearmOnNextLogicalRequest = false;
  let settingsErrorReported = false;

  /** Reads the saved preference and publishes it, or publishes undefined and rethrows when killeros.json cannot be read. */
  const loadPreference = (): AutoCompactionPreference => {
    try {
      const preference = readAutoCompactionPreference(settingsStore.load());
      onPreferenceChange(preference);
      return preference;
    } catch (error) {
      onPreferenceChange(undefined);
      throw error;
    }
  };

  const resetForLifecycle = (): void => {
    request = undefined;
    goalRequestOwned = false;
    armed = true;
    rearmOnNextLogicalRequest = false;
    settingsErrorReported = false;
  };

  pi.registerCommand("auto-compact", {
    description: "Inspect or change automatic compaction",
    handler: async (args, ctx) => {
      const argument = args.trim();
      if (!argument || argument === "status") {
        try {
          ctx.ui.notify(describePreference(loadPreference()), "info");
        } catch (error) {
          ctx.ui.notify(`Automatic compaction setting could not be read: ${errorMessage(error)}`, "error");
        }
        return;
      }

      const percent = /^\d+$/u.test(argument) ? Number(argument) : undefined;
      if (argument !== "on" && argument !== "off" && (percent === undefined || percent > 100)) {
        ctx.ui.notify("Usage: /auto-compact [status|on|off|<percent 0-100>]", "error");
        return;
      }

      try {
        let updated: AutoCompactionPreference | undefined;
        settingsStore.update((current) => {
          const preference = readAutoCompactionPreference(current);
          updated = percent === undefined
            ? { ...preference, enabled: argument === "on" }
            : { ...preference, percentRemaining: percent };
          return { autoCompaction: updated };
        });
        if (!updated) throw new Error("Settings update did not apply the preference");
        onPreferenceChange(updated);
        ctx.ui.notify(percent === undefined
          ? describePreference(updated)
          : `Automatic compaction threshold: ${percent}% remaining (${updated.enabled ? "on" : "off"})`, "info");
      } catch (error) {
        ctx.ui.notify(`Automatic compaction setting could not be saved: ${errorMessage(error)}`, "error");
      }
    },
  });

  const notifyFailure = (ctx: ExtensionContext, error: unknown): void => {
    ctx.ui.notify(`Automatic compaction failed: ${errorMessage(error)}`, "error");
  };

  const finishFailure = (ctx: ExtensionContext, goal: boolean, error: unknown): void => {
    request = undefined;
    if (goal) {
      try {
        goalHandlers.onFailed(ctx, error);
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
      goalHandlers.onSkipped(ctx);
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

  pi.on("agent_start", (_event, ctx) => {
    // Terminal decisions clear active status before turn_end, but still own this run.
    goalRequestOwned = goalHandlers.isActive(ctx);
  });

  // Capture later blocked completion before goal settlement discards its permission.
  // A compaction already pending as ordinary work must also stop after that decision.
  const observeTerminalDecision = (): void => {
    if (!goalHandlers.hasAcceptedTerminalDecision()) return;
    goalRequestOwned = true;
    if (request?.phase === "compacting") {
      request.goal = true;
      if (request.compactionCompleted) request = undefined;
    }
  };
  pi.on("agent_end", observeTerminalDecision);

  pi.on("turn_end", (_event, ctx) => {
    observeTerminalDecision();
    if (!isAutomationMode(ctx) || request) return;

    let preference: AutoCompactionPreference;
    let settings: CompactionSettings;
    try {
      preference = loadPreference();
      settings = compactionSettings(ctx);
    } catch (error) {
      onPreferenceChange(undefined);
      if (!settingsErrorReported) {
        settingsErrorReported = true;
        ctx.ui.notify(`Automatic compaction settings could not be read: ${errorMessage(error)}`, "error");
      }
      return;
    }
    const usage = readContextUsage(ctx);
    if (!usage) return;
    if (isAtThreshold(usage, preference, settings) === false) armed = true;
    if (!armed || !shouldTriggerAutoCompaction(usage, preference, settings)) return;

    armed = false;
    const token = Symbol();
    const activeGoal = goalHandlers.isActive(ctx);
    const goal = goalRequestOwned || activeGoal;
    request = {
      phase: "compacting",
      goal,
      token,
      turnSettled: false,
      compactionCompleted: false,
    };
    if (activeGoal) {
      try {
        goalHandlers.onRequested();
      } catch (error) {
        finishFailure(ctx, true, error);
        return;
      }
    }

    try {
      ctx.compact({
        onComplete: () => {
          observeTerminalDecision();
          if (request?.phase !== "compacting" || request.token !== token) return;
          rearmOnNextLogicalRequest = preference.percentRemaining === 100;
          if (goal || request.goal) {
            request = undefined;
            if (activeGoal) {
              try {
                goalHandlers.onCompleted(ctx);
              } catch (error) {
                notifyFailure(ctx, error);
              }
            }
            return;
          }
          request.compactionCompleted = true;
          finalizeOrdinaryContinuation(ctx, token);
        },
        onError: (error) => finishRequestError(ctx, token, activeGoal, error),
      });
    } catch (error) {
      finishRequestError(ctx, token, activeGoal, error);
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    goalRequestOwned = false;
    // Pi aborts the agent when our pending compaction starts. Its callback owns
    // recovery, including cancellation; the settlement flag alone is ambiguous.
    if (wasAborted(event) && request?.phase !== "compacting") {
      request = undefined;
      return;
    }
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
    const isOrdinaryContinuation = event.message.role === "custom"
      && event.message.customType === AUTO_COMPACTION_MESSAGE_TYPE;
    if (request?.phase === "continuation-dispatched" && isOrdinaryContinuation) request = undefined;
    const startsNewLogicalRequest = event.message.role === "user"
      || (event.message.role === "custom" && event.message.customType === GOAL_CONTINUATION_TYPE);
    if (rearmOnNextLogicalRequest && startsNewLogicalRequest) {
      armed = true;
      rearmOnNextLogicalRequest = false;
    }
  });

  pi.on("session_start", (_event, ctx) => {
    resetForLifecycle();
    if (ctx.mode !== "tui") return;
    try {
      loadPreference();
    } catch {
      // loadPreference already published the unreadable state; turn_end reports the error.
    }
  });
  pi.on("session_shutdown", resetForLifecycle);
  pi.on("session_tree", resetForLifecycle);
}
