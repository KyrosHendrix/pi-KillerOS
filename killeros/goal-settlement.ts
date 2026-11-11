import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoCompactionGoalHandlers } from "./auto-compaction.ts";
import { errorMessage, reportError } from "./errors.ts";
import { isAutomationMode, wasAborted } from "./pi-context.ts";
import {
  isSavedSession,
  pauseGoal,
  pauseGoalAfterFailure,
  pauseGoalUnsaved,
  pauseGoalWithoutDecision,
  pauseGoalAtTurnLimit,
  resumeInterruptedGoalTurn,
  scheduleGoalContinuation,
  syncGoalUpdateTool,
  transitionGoal,
} from "./goal-runtime.ts";
import { boundGoalText } from "./goal-state.ts";
import type { GoalRuntime, GoalState } from "./goal-model.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

function pauseGoalForPossibleManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
): void {
  if (runtime.state?.status !== "active") return;
  const safeReason = boundGoalText(reason) || "the agent turn was aborted";
  pauseGoal(pi, runtime, "error", safeReason, {
    hold: "manual-compaction",
  });
  ctx.ui.notify(
    "Goal paused because the turn was aborted. If /compact is running, KillerOS will resume the same goal turn after Pi saves the summary. Run /goal pause to keep it paused.",
    "warning",
  );
}

function recoverGoalAfterManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): boolean {
  if (runtime.state?.status !== "paused"
    || runtime.state.resumeAfterManualCompaction !== true) return false;
  const state = runtime.state;
  const sameTurn = state.turnDecision === undefined;
  const turn = runtime.goalTurn?.turn ?? state.turns;
  const generation = runtime.lifecycleGeneration;
  let resumed: GoalState;
  try {
    resumed = transitionGoal(pi, runtime, "resume", "active", undefined, { resume: sameTurn ? "same-turn" : "next-turn" });
  } catch (error) {
    runtime.persistenceRetryNeeded = true;
    reportError(ctx, "Manual compaction succeeded, but the goal could not be resumed", error);
    return false;
  }
  runtime.automaticCompaction = undefined;
  if (sameTurn) {
    runtime.goalTurn = { turn, revision: runtime.state?.revision ?? state.revision };
    runtime.goalTurnInFlight = true;
    runtime.agentEndObserved = false;
    if (ctx.mode !== "tui") ctx.ui.notify("Manual compaction complete. The interrupted goal turn resumed.", "info");
    setImmediate(() => {
      if (runtime.lifecycleGeneration !== generation || runtime.state !== resumed) return;
      resumeInterruptedGoalTurn(pi, runtime, ctx);
    });
  } else {
    if (scheduleGoalContinuation(pi, runtime, ctx) && ctx.mode !== "tui") ctx.ui.notify("Manual compaction complete. Goal resumed.", "info");
  }
  return true;
}

/** Ends a command's continuation hold if it still owns it, then lets any parked compaction recovery resume. Returns whether it released the hold. */
export function releaseContinuationHold(pi: ExtensionAPI, runtime: GoalRuntime, ctx: ExtensionContext, hold: symbol): boolean {
  if (runtime.continuationHeld !== hold) return false;
  runtime.continuationHeld = undefined;
  finalizeAutomaticCompaction(pi, runtime, ctx);
  return true;
}

/** Resumes the paused revision after compaction, settlement, and any owning command's continuation hold. */
function finalizeAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): void {
  const recovery = runtime.automaticCompaction;
  if (!recovery || recovery.outcome === "pending" || !recovery.turnSettled || runtime.continuationHeld) return;
  if (runtime.state?.status !== "paused"
    || runtime.state.revision !== recovery.pausedRevision) {
    runtime.automaticCompaction = undefined;
    return;
  }
  const state = runtime.state;
  const sameTurn = recovery.resumeSameTurn;
  const generation = runtime.lifecycleGeneration;
  runtime.automaticCompaction = undefined;
  let resumed: GoalState;
  try {
    resumed = transitionGoal(pi, runtime, "resume", "active", undefined, { resume: sameTurn ? "same-turn" : "next-turn" });
  } catch (error) {
    runtime.persistenceRetryNeeded = true;
    reportError(ctx, sameTurn
      ? "Automatic compaction succeeded, but the interrupted goal turn could not be resumed"
      : "Automatic compaction succeeded, but the goal could not be resumed", error);
    return;
  }
  if (sameTurn) {
    runtime.goalTurn = { turn: recovery.turn, revision: runtime.state?.revision ?? state.revision };
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    setImmediate(() => {
      if (runtime.lifecycleGeneration !== generation
        || runtime.state !== resumed
        || runtime.goalTurn?.turn !== recovery.turn) return;
      runtime.goalTurnInFlight = true;
      resumeInterruptedGoalTurn(pi, runtime, ctx);
    });
    return;
  }
  if (pauseGoalAtTurnLimit(pi, runtime, ctx)) return;
  setImmediate(() => scheduleGoalContinuation(pi, runtime, ctx, { generation, state: resumed }));
}

function completeAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): void {
  if (!runtime.automaticCompaction) return;
  runtime.automaticCompaction.outcome = "completed";
  finalizeAutomaticCompaction(pi, runtime, ctx);
}

function skipAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): void {
  if (!runtime.automaticCompaction) return;
  runtime.automaticCompaction.outcome = "skipped";
  finalizeAutomaticCompaction(pi, runtime, ctx);
}

function stopAutomaticCompactionRecovery(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
): void {
  const recovery = runtime.automaticCompaction;
  runtime.automaticCompaction = undefined;
  const safeReason = boundGoalText(reason) || "automatic compaction failed";
  if (runtime.state?.status !== "paused" || runtime.state.revision !== recovery?.pausedRevision) return;
  pauseGoal(pi, runtime, "error", safeReason);
  ctx.ui.notify(
    `Goal paused: ${safeReason}\nAutomatic continuation is stopped. Run /goal resume after resolving the compaction problem.`,
    "error",
  );
}

function failAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  error: unknown,
): void {
  const reason = errorMessage(error);
  if (!runtime.automaticCompaction) {
    if (runtime.persistenceRetryNeeded) {
      ctx.ui.notify(`Automatic compaction did not start: ${reason}`, "error");
    }
    return;
  }
  stopAutomaticCompactionRecovery(pi, runtime, ctx, `automatic compaction failed: ${reason}`);
}

function settleGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  settledTurn: number,
): void {
  const state = runtime.state;
  if (state?.status !== "active") return;
  const decision = state.turnDecision;
  if (!decision || decision.turn !== settledTurn) {
    pauseGoalWithoutDecision(pi, runtime, ctx);
    return;
  }
  if (pauseGoalAtTurnLimit(pi, runtime, ctx)) return;
  scheduleGoalContinuation(pi, runtime, ctx);
}

export function registerGoalSettlement(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
): AutoCompactionGoalHandlers {
  pi.on("agent_settled", (event, ctx) => {
    runtime.blockedCompletion = undefined;
    syncGoalUpdateTool(pi, runtime);
    const wasGoalTurn = runtime.goalTurnInFlight;
    const continuationWasScheduled = runtime.continuationScheduled;
    const agentEndObserved = runtime.agentEndObserved;
    const settledTurn = runtime.goalTurn?.turn;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.continuationScheduled = false;

    // ctx.compact() also aborts the request. An owned compaction must settle through
    // its success/error callback; its cancellation cannot authorize recovery.
    if (wasAborted(event) && !runtime.automaticCompaction
      && runtime.lastStopReason !== "aborted") {
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      if (runtime.state?.status === "active") {
        pauseGoalAfterFailure(pi, runtime, ctx, "the agent request was cancelled");
      }
      return;
    }

    if (runtime.automaticCompaction) {
      const stopReason = runtime.lastStopReason;
      const error = safeTerminalText(runtime.lastError ?? "");
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      if (runtime.automaticCompaction.turnSettled
        && (settledTurn === undefined || settledTurn === runtime.automaticCompaction.turn)) {
        // The interrupted turn already settled; a repeated settlement carries no new
        // information, so keep waiting for compaction instead of failing the recovery.
        return;
      }
      const expectedInterruption = stopReason === "aborted"
        || stopReason === "error" && error === "This operation was aborted";
      if (!wasGoalTurn || !agentEndObserved) {
        stopAutomaticCompactionRecovery(pi, runtime, ctx, "the goal turn ended without an agent result");
        return;
      }
      if ((stopReason === "error" || stopReason === "aborted") && !expectedInterruption) {
        stopAutomaticCompactionRecovery(
          pi,
          runtime,
          ctx,
          error || "the agent turn failed",
        );
        return;
      }
      if (!expectedInterruption && runtime.automaticCompaction.resumeSameTurn) {
        stopAutomaticCompactionRecovery(pi, runtime, ctx, "no turn decision");
        return;
      }
      if (settledTurn !== undefined && runtime.automaticCompaction.turn === settledTurn) {
        runtime.automaticCompaction.turnSettled = true;
      } else {
        stopAutomaticCompactionRecovery(pi, runtime, ctx, "the goal turn identity changed during compaction");
        return;
      }
      finalizeAutomaticCompaction(pi, runtime, ctx);
      return;
    }

    if (!wasGoalTurn || runtime.state?.status !== "active") {
      if (continuationWasScheduled && runtime.state?.status === "active") {
        pauseGoalAfterFailure(pi, runtime, ctx, "the goal continuation ended before an agent turn started");
      } else if (runtime.state?.status === "active"
        && (runtime.state.turnPhase === "ready" || runtime.state.turnPhase === "authorized")) {
        scheduleGoalContinuation(pi, runtime, ctx);
      }
      return;
    }
    if (settledTurn === undefined) {
      pauseGoalAfterFailure(pi, runtime, ctx, "the goal turn identity was lost");
      return;
    }
    if (!agentEndObserved) {
      pauseGoalAfterFailure(pi, runtime, ctx, "the goal turn ended without an agent result");
      return;
    }
    if (runtime.lastStopReason === "aborted") {
      const reason = runtime.lastError || "the agent turn was aborted";
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      pauseGoalForPossibleManualCompaction(pi, runtime, ctx, reason);
      return;
    }
    if (runtime.lastStopReason === "error") {
      const reason = runtime.lastError || "the agent turn failed";
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      pauseGoalAfterFailure(pi, runtime, ctx, reason);
      return;
    }
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    settleGoalTurn(pi, runtime, ctx, settledTurn);
  });

  pi.on("session_compact", (event, ctx) => {
    if (runtime.automaticCompaction !== undefined) return;
    if (event.reason !== "manual") return;
    recoverGoalAfterManualCompaction(pi, runtime, ctx);
  });

  return {
    hasAcceptedTerminalDecision: (): boolean => runtime.blockedCompletion?.kind === "accepted"
      && runtime.blockedCompletion.generation === runtime.lifecycleGeneration,
    isActive: (ctx: ExtensionContext): boolean => isAutomationMode(ctx)
      && isSavedSession(ctx)
      && runtime.state?.status === "active",
    onRequested: (): void => {
      if (runtime.state?.status !== "active") return;
      const current = runtime.state;
      // A turn that already accepted continue or a blocker audit owns a pending
      // authorization; recovery must take the next-turn path, never resume the decided turn.
      const resumeSameTurn = runtime.goalTurnInFlight && current.turnDecision === undefined;
      try {
        const paused = transitionGoal(pi, runtime, "pause", "paused", undefined, {
          hold: "automatic-compaction",
        });
        runtime.automaticCompaction = {
          pausedRevision: paused.revision,
          outcome: "pending",
          turnSettled: false,
          turn: current.turns,
          resumeSameTurn,
        };
      } catch (error) {
        pauseGoalUnsaved(pi, runtime, boundGoalText(`automatic compaction pause could not be saved: ${errorMessage(error)}`));
        throw error;
      }
    },
    onCompleted: (ctx: ExtensionContext): void => completeAutomaticCompaction(pi, runtime, ctx),
    onFailed: (ctx: ExtensionContext, error: unknown): void => failAutomaticCompaction(pi, runtime, ctx, error),
    onSkipped: (ctx: ExtensionContext): void => skipAutomaticCompaction(pi, runtime, ctx),
  };
}
