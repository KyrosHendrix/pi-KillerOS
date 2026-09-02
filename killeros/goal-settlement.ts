import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutoCompactionGoalHandlers } from "./auto-compaction.ts";
import { reportError } from "./errors.ts";
import { isGoalModeSupported, isSavedSession, pauseGoalAfterFailure, pauseGoalAtTurnLimit, scheduleGoalContinuation, syncGoalUpdateTool, transitionGoal } from "./goal-runtime.ts";
import { pauseGoalState } from "./goal-state.ts";
import type { GoalRuntime, InitRuntime } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

function pauseGoalForPossibleManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
): void {
  if (runtime.state?.status !== "active") return;
  const safeReason = safeTerminalText(reason);
  try {
    transitionGoal(pi, runtime, "error", "paused", safeReason, {
      resumeAfterManualCompaction: true,
    });
  } catch {
    const current = runtime.state;
    runtime.state = current ? pauseGoalState(current, safeReason, Date.now(), true) : undefined;
    syncGoalUpdateTool(pi, runtime);
    runtime.persistenceRetryNeeded = true;
    runtime.continuationScheduled = false;
    runtime.automaticCompaction = undefined;
    runtime.requestRender?.();
  }
  ctx.ui.notify(
    "Goal paused because the turn was aborted. If /compact is running, KillerOS will resume after Pi saves the summary. Run /goal pause to keep it paused.",
    "warning",
  );
}

function recoverGoalAfterManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): boolean {
  if (runtime.state?.status !== "paused"
    || runtime.state.resumeAfterManualCompaction !== true
    || initState.active) return false;
  try {
    transitionGoal(pi, runtime, "resume", "active", undefined, { resetBlockedAudit: true });
  } catch (error) {
    runtime.persistenceRetryNeeded = true;
    reportError(ctx, "Manual compaction succeeded, but the goal could not be resumed", error);
    return false;
  }
  runtime.continuationScheduled = false;
  runtime.automaticCompaction = undefined;
  ctx.ui.notify("Manual compaction complete. Goal resumed.", "info");
  setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
  return true;
}

/** Resumes the paused revision after both compaction and goal-turn settlement report an outcome. */
function finalizeAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): void {
  const recovery = runtime.automaticCompaction;
  if (!recovery || recovery.outcome === "pending" || !recovery.turnSettled) return;
  const skipped = recovery.outcome === "skipped";
  runtime.automaticCompaction = undefined;
  if (runtime.state?.status !== "paused"
    || runtime.state.revision !== recovery.pausedRevision
    || initState.active) return;
  try {
    transitionGoal(pi, runtime, "resume", "active", undefined, { resetBlockedAudit: true });
  } catch (error) {
    runtime.persistenceRetryNeeded = true;
    reportError(ctx, skipped
      ? "Automatic compaction was skipped, but the goal could not be resumed"
      : "Automatic compaction succeeded, but the goal could not be resumed", error);
    return;
  }
  runtime.continuationScheduled = false;
  setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
}

/** Records Pi's successful compaction callback and attempts guarded recovery. */
function completeAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): void {
  if (!runtime.automaticCompaction) return;
  runtime.automaticCompaction.outcome = "completed";
  finalizeAutomaticCompaction(pi, runtime, initState, ctx);
}

/** Records Pi's expected session-too-small rejection and resumes without claiming compaction succeeded. */
function skipAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): void {
  if (!runtime.automaticCompaction) return;
  runtime.automaticCompaction.outcome = "skipped";
  finalizeAutomaticCompaction(pi, runtime, initState, ctx);
}

/** Consumes automatic recovery and records its failure on the eligible paused goal. */
function stopAutomaticCompactionRecovery(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
): void {
  const recovery = runtime.automaticCompaction;
  runtime.automaticCompaction = undefined;
  const safeReason = safeTerminalText(reason);
  if (runtime.state?.status !== "paused" || runtime.state.revision !== recovery?.pausedRevision) return;
  try {
    transitionGoal(pi, runtime, "error", "paused", safeReason);
  } catch {
    runtime.state = { ...runtime.state, result: safeReason };
    runtime.persistenceRetryNeeded = true;
    runtime.requestRender?.();
  }
  ctx.ui.notify(
    `Goal paused: ${safeReason}\nAutomatic continuation is stopped. Run /goal resume after resolving the compaction problem.`,
    "error",
  );
}

/** Leaves the goal paused when Pi rejects automatic compaction. */
function failAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  if (!runtime.automaticCompaction) {
    if (runtime.persistenceRetryNeeded) {
      ctx.ui.notify(`Automatic compaction did not start: ${safeTerminalText(reason)}`, "error");
    }
    return;
  }
  stopAutomaticCompactionRecovery(pi, runtime, ctx, `automatic compaction failed: ${reason}`);
}

export function registerGoalSettlement(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
): AutoCompactionGoalHandlers {
  pi.on("agent_settled", (_event, ctx) => {
    const wasGoalTurn = runtime.goalTurnInFlight;
    const continuationWasScheduled = runtime.continuationScheduled;
    const agentEndObserved = runtime.agentEndObserved;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.continuationScheduled = false;

    if (runtime.automaticCompaction) {
      const stopReason = runtime.lastStopReason;
      const error = safeTerminalText(runtime.lastError ?? "");
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
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
      runtime.automaticCompaction.turnSettled = true;
      finalizeAutomaticCompaction(pi, runtime, initState, ctx);
      return;
    }

    if (!wasGoalTurn || runtime.state?.status !== "active" || initState.active) {
      if (continuationWasScheduled && runtime.state?.status === "active" && !initState.active) {
        pauseGoalAfterFailure(pi, runtime, ctx, "the goal continuation ended before an agent turn started");
      } else if (runtime.state?.status === "active" && !initState.active) {
        scheduleGoalContinuation(pi, runtime, initState, ctx);
      }
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
    if (pauseGoalAtTurnLimit(pi, runtime, ctx)) return;
    scheduleGoalContinuation(pi, runtime, initState, ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    if (runtime.automaticCompaction !== undefined) return;
    if (event.reason !== "manual") return;
    recoverGoalAfterManualCompaction(pi, runtime, initState, ctx);
  });

  const resetAutomaticRecovery = (): void => { runtime.automaticCompaction = undefined; };
  pi.on("session_before_switch", resetAutomaticRecovery);
  pi.on("session_before_fork", resetAutomaticRecovery);

  return {
    isActive: (ctx: ExtensionContext): boolean => isGoalModeSupported(ctx)
      && isSavedSession(ctx)
      && runtime.state?.status === "active"
      && !initState.active,
    onRequested: (): void => {
      if (runtime.state?.status !== "active") return;
      try {
        const paused = transitionGoal(pi, runtime, "pause", "paused");
        runtime.automaticCompaction = {
          pausedRevision: paused.revision,
          outcome: "pending",
          turnSettled: false,
        };
      } catch (error) {
        const current = runtime.state;
        const reason = safeTerminalText(`automatic compaction pause could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        runtime.state = current ? pauseGoalState(current, reason, Date.now()) : undefined;
        syncGoalUpdateTool(pi, runtime);
        runtime.persistenceRetryNeeded = true;
        runtime.continuationScheduled = false;
        runtime.automaticCompaction = undefined;
        runtime.requestRender?.();
        throw error;
      }
    },
    onCompleted: (ctx: ExtensionContext): void => completeAutomaticCompaction(pi, runtime, initState, ctx),
    onFailed: (ctx: ExtensionContext, error: unknown): void => failAutomaticCompaction(pi, runtime, ctx, error),
    onSkipped: (ctx: ExtensionContext): void => skipAutomaticCompaction(pi, runtime, initState, ctx),
  };
}
