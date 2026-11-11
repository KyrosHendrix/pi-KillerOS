import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTime, formatTokens } from "./display.ts";
import { errorMessage, reportError } from "./errors.ts";
import type { GoalRuntime, GoalState, GoalStatus } from "./goal-model.ts";
import {
  clearGoalState,
  endGoalTurn,
  holdUnsavedGoal,
  isSavedSession,
  pauseFailedGoal,
  pauseGoalAfterFailure,
  persistGoalState,
  scheduleGoalContinuation,
  stopGoalRun,
  sumGoalTokens,
  transitionGoal,
} from "./goal-runtime.ts";
import { releaseContinuationHold } from "./goal-settlement.ts";
import {
  checkpointPausedGoalState,
  createNewGoalState,
  DEFAULT_GOAL_MAX_TURNS,
  editGoalState,
  GOAL_MAX_TURNS,
  goalElapsedMilliseconds,
  inferGoalVerification,
  validateGoalObjective,
} from "./goal-state.ts";
import { isAutomationMode } from "./pi-context.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

/** Shown by slash-command autocomplete next to /goal. */
export const GOAL_COMMAND_SYNTAX = "/goal [objective|edit|pause|resume|clear]";

type GoalCommand =
  | { kind: "status" }
  | { kind: "objective"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

/** Parses raw text as a plain objective, or reports why it cannot be one. */
function parseGoalObjectiveText(input: string): Extract<GoalCommand, { kind: "objective" } | { kind: "invalid" }> {
  const objective = validateGoalObjective(input);
  if (objective) return { kind: "objective", objective };
  if (safeTerminalText(input) !== input) {
    return { kind: "invalid", message: "A goal objective contains unsupported content" };
  }
  return { kind: "invalid", message: "A goal objective may not exceed 4,000 characters" };
}

/** Parses one raw /goal argument string into a closed command variant; the handler decides whether "edit" applies to the current goal. */
function parseGoalCommand(args: string): GoalCommand {
  const input = args.trim();
  if (!input) return { kind: "status" };
  const lowered = input.toLowerCase();
  if (lowered === "pause") return { kind: "pause" };
  if (lowered === "resume") return { kind: "resume" };
  if (lowered === "clear") return { kind: "clear" };
  if (lowered === "edit") return { kind: "invalid", message: "Provide the new objective: /goal edit <objective>" };
  if (/^edit\s/ui.test(input)) {
    const objective = validateGoalObjective(input.replace(/^edit\s+/ui, ""));
    if (objective) return { kind: "edit", objective };
  }
  return parseGoalObjectiveText(input);
}

function goalPanelActions(status: GoalStatus): Array<{ label: string; control: "pause" | "resume" | "clear" }> {
  if (status === "active") return [{ label: "Pause goal", control: "pause" }, { label: "Clear goal", control: "clear" }];
  if (status === "paused" || status === "blocked") {
    return [{ label: "Resume goal", control: "resume" }, { label: "Clear goal", control: "clear" }];
  }
  return [{ label: "Clear goal", control: "clear" }];
}

function goalStatusSummary(state: GoalState, ctx: ExtensionContext): string {
  const usedTokens = Math.max(0, sumGoalTokens(ctx) - state.baselineTokens);
  const turns = state.maxTurns === undefined
    ? `${state.turns} turn${state.turns === 1 ? "" : "s"}`
    : `${state.turns}/${state.maxTurns} turns`;
  const lines = [
    `Goal ${state.status} · ${turns} · ${formatTime(goalElapsedMilliseconds(state, Date.now()))} · ${formatTokens(usedTokens)} tokens`,
    state.objective,
    ...(state.verification === undefined ? [] : [`Deliverable · ${state.verification.path}`]),
  ];
  const decision = state.turnDecision ?? state.lastDecision;
  if (decision?.kind === "continue") {
    lines.push(`Progress · model-reported on turn ${decision.turn}`);
    lines.push(`Next · ${decision.nextAction}`);
  } else if (decision?.kind === "blocker-audit") {
    lines.push(`Blocker audit · ${decision.streak}/3 on turn ${decision.turn}`);
    lines.push(`Evidence · ${decision.evidence}`);
  } else if (decision?.kind === "blocked") {
    lines.push(`Evidence · ${decision.evidence}`);
  } else if (decision?.kind === "complete") {
    lines.push(`Completion · ${decision.verification === "file" ? `verified file ${state.verification?.path ?? "deliverable"}` : "model-reported"}`);
    lines.push(`Evidence · ${decision.evidence}`);
  }
  if (state.status === "paused") {
    lines.push(state.turns === 0 ? "Paused at · before turn 1" : `Paused at · turn ${state.turns}`);
    const reason = state.stopReason ?? state.result;
    if (reason) lines.push(`Reason · ${reason}`);
    if (state.stopReason === "repeated continue report" && state.lastContinueReport) {
      lines.push(`Repeated turns · ${state.lastContinueReport.turn} and ${state.turns}`);
    }
  } else if (state.result && decision?.kind !== "complete" && decision?.kind !== "blocked") {
    lines.push(`Result · ${state.result}`);
  }
  return safeTerminalText(lines.join("\n"));
}

/** What a /goal command captured when it started, so code after an await can tell whether it still owns the goal. */
interface GoalCommandScope {
  pi: ExtensionAPI;
  runtime: GoalRuntime;
  ctx: ExtensionCommandContext;
  generation: number;
  initiatingState: GoalState | undefined;
  ownsGoal: () => boolean;
}

/** Shows the goal; in TUI mode it offers the controls that fit its status and runs the chosen one. */
async function showGoalStatus(scope: GoalCommandScope, rerun: (control: "pause" | "resume" | "clear") => Promise<void>): Promise<void> {
  const { runtime, ctx, ownsGoal } = scope;
  if (!runtime.state) {
    ctx.ui.notify("No goal is set. Use /goal <objective> to start a long-running task.", "info");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify(goalStatusSummary(runtime.state, ctx), "info");
    return;
  }
  const actions = goalPanelActions(runtime.state.status);
  const selected = await ctx.ui.select(goalStatusSummary(runtime.state, ctx), actions.map((action) => action.label));
  if (!ownsGoal()) return;
  const action = actions.find((candidate) => candidate.label === selected);
  if (!action) return;
  if (action.control === "clear" && !await ctx.ui.confirm("Clear goal?", safeTerminalText(runtime.state.objective))) return;
  if (!ownsGoal()) return;
  await rerun(action.control);
  return;
}

/** Removes the goal and stops its run; when the clear cannot be saved, the goal pauses instead. */
async function clearGoal(scope: GoalCommandScope): Promise<void> {
  const { pi, runtime, ctx } = scope;
  if (!runtime.state) {
    ctx.ui.notify("No goal is set", "info");
    return;
  }
  const shouldStopGoalRun = runtime.goalTurnInFlight || runtime.continuationScheduled;
  let saved = false;
  try {
    clearGoalState(pi, runtime);
    saved = true;
  } catch (error) {
    if (runtime.state?.status === "active") {
      pauseFailedGoal(pi, runtime, `the requested clear could not be saved: ${errorMessage(error)}`);
    } else {
      reportError(ctx, "Goal could not be cleared", error);
      return;
    }
  }
  try {
    await stopGoalRun(runtime, ctx, shouldStopGoalRun);
  } catch (error) {
    reportError(ctx, saved ? "Goal cleared, but the active goal turn could not be confirmed stopped" : "Goal paused, but the active goal turn could not be confirmed stopped", error);
    return;
  }
  if (saved) {
    if (ctx.mode !== "tui") ctx.ui.notify("Goal cleared", "info");
  } else {
    ctx.ui.notify("Goal paused: the requested clear could not be saved\nAutomatic continuation is stopped. Retry /goal clear to remove the goal.", "error");
  }
  return;
}

/** Pauses an active goal and stops its run, or saves again a pause that is still pending. */
async function pauseGoalCommand(scope: GoalCommandScope): Promise<void> {
  const { pi, runtime, ctx } = scope;
  if (!runtime.state) {
    ctx.ui.notify("No goal is set", "info");
    return;
  }
  if (runtime.state.status === "paused") {
    if (!runtime.persistenceRetryNeeded
      && runtime.state.resumeAfterManualCompaction !== true
      && runtime.automaticCompaction === undefined) {
      ctx.ui.notify("Goal is already paused", "info");
      return;
    }
    const checkpoint = checkpointPausedGoalState(runtime.state, Date.now());
    try {
      persistGoalState(pi, runtime, "pause", checkpoint);
      ctx.ui.notify("Goal pause saved. Goal remains paused. Automatic compaction recovery is off.", "info");
    } catch (error) {
      runtime.continuationScheduled = false;
      holdUnsavedGoal(pi, runtime, checkpoint);
      reportError(ctx, "Goal pause still could not be saved", error);
    }
    return;
  }
  if (runtime.state.status !== "active") {
    ctx.ui.notify(`Goal is ${runtime.state.status}; only an active goal can be paused`, "warning");
    return;
  }
  const shouldStopGoalRun = runtime.goalTurnInFlight || runtime.continuationScheduled;
  let saved = false;
  let failureReason: string | undefined;
  try {
    transitionGoal(pi, runtime, "pause", "paused");
    saved = true;
  } catch (error) {
    failureReason = safeTerminalText(`the requested pause could not be saved: ${errorMessage(error)}`);
    pauseFailedGoal(pi, runtime, failureReason);
  }
  try {
    await stopGoalRun(runtime, ctx, shouldStopGoalRun);
  } catch (error) {
    reportError(ctx, "Goal paused, but the active goal turn could not be confirmed stopped", error);
    return;
  }
  if (saved) {
    if (ctx.mode !== "tui") ctx.ui.notify("Goal paused. Run /goal resume to continue.", "info");
  } else {
    ctx.ui.notify(`Goal paused: ${failureReason}\nAutomatic continuation is stopped. If session storage is still unavailable, retry /goal pause after it recovers.`, "error");
  }
  return;
}

/** Resumes a paused or blocked goal, renewing an exhausted turn budget up to the lifetime limit. */
function resumeGoalCommand(scope: GoalCommandScope): void {
  const { pi, runtime, ctx } = scope;
  if (!runtime.state) {
    ctx.ui.notify("No goal is set", "info");
    return;
  }
  if (runtime.state.status === "complete") {
    ctx.ui.notify("The goal is complete. Set a new objective.", "info");
    return;
  }
  if (runtime.state.status === "active") {
    ctx.ui.notify("Goal is already active", "info");
    return;
  }
  const currentMax = runtime.state.maxTurns;
  const exhausted = currentMax !== undefined && runtime.state.turns >= currentMax;
  if (exhausted && runtime.state.turns >= GOAL_MAX_TURNS) {
    ctx.ui.notify(`Goal reached the lifetime limit (${runtime.state.turns}/${GOAL_MAX_TURNS}). Set a new objective.`, "warning");
    return;
  }
  try {
    transitionGoal(pi, runtime, "resume", "active", undefined, {
      resetBlockedAudit: true,
      ...(exhausted ? { maxTurns: Math.min(Math.max(currentMax, runtime.state.turns) + DEFAULT_GOAL_MAX_TURNS, GOAL_MAX_TURNS) } : {}),
    });
    if (scheduleGoalContinuation(pi, runtime, ctx) && ctx.mode !== "tui") ctx.ui.notify("Goal resumed", "info");
  } catch (error) {
    reportError(ctx, "Goal could not be resumed", error);
  }
  return;
}

/** Replaces the objective of an active or paused goal once Pi is idle, keeping its identity and status. */
async function editGoal(scope: GoalCommandScope, objective: string): Promise<void> {
  const { pi, runtime, ctx, generation, initiatingState } = scope;
  const mutation = runtime.mutation;
  const ownsEdit = (): boolean => runtime.lifecycleGeneration === generation
    && runtime.mutation === mutation
    && runtime.state?.status === initiatingState?.status;
  const hold = Symbol();
  runtime.continuationHeld = hold;
  let waitError: unknown;
  try {
    await ctx.waitForIdle();
  } catch (error) {
    waitError = error;
  } finally {
    releaseContinuationHold(pi, runtime, ctx, hold);
  }
  if (!ownsEdit()) {
    // Settlement may have authorized a turn while this command held continuation.
    if (runtime.lifecycleGeneration === generation) scheduleGoalContinuation(pi, runtime, ctx);
    return;
  }
  if (waitError) {
    reportError(ctx, "Goal objective could not be updated", waitError);
    scheduleGoalContinuation(pi, runtime, ctx);
    return;
  }
  const state = runtime.state;
  let verification: Awaited<ReturnType<typeof inferGoalVerification>>;
  try {
    verification = await inferGoalVerification(objective, ctx.cwd);
  } catch (error) {
    if (!ownsEdit() || runtime.state !== state) return;
    reportError(ctx, "Goal objective could not be updated", error);
    scheduleGoalContinuation(pi, runtime, ctx);
    return;
  }
  if (!ownsEdit() || runtime.state !== state) return;
  if (!state || state.status !== "active" && state.status !== "paused") return;
  try {
    const next = editGoalState(state, objective, verification, Date.now());
    persistGoalState(pi, runtime, "edit", next);
    endGoalTurn(runtime);
    runtime.continuationScheduled = false;
    if (next.status === "paused") {
      if (ctx.mode !== "tui") ctx.ui.notify("Goal objective updated. The goal is paused; run /goal resume to continue.", "info");
    } else if (scheduleGoalContinuation(pi, runtime, ctx) && ctx.mode !== "tui") {
      ctx.ui.notify("Goal objective updated.", "info");
    }
  } catch (error) {
    if (runtime.state?.status === "active") {
      pauseGoalAfterFailure(
        pi,
        runtime,
        ctx,
        `Goal objective could not be updated: ${errorMessage(error)}`,
        "Automatic continuation is stopped. Retry /goal edit after session storage recovers.",
      );
    } else {
      reportError(ctx, "Goal objective could not be updated", error);
    }
  }
  return;
}

/** Starts a goal, or replaces an unfinished one after confirmation, once Pi is idle. */
async function startGoal(scope: GoalCommandScope, objective: string): Promise<void> {
  const { pi, runtime, ctx, generation, ownsGoal } = scope;
  const unfinished = runtime.state && runtime.state.status !== "complete";
  if (unfinished) {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear the current goal before replacing it outside TUI mode", "error");
      return;
    }
    const replace = await ctx.ui.confirm("Replace active goal", "Replace the current unfinished goal and discard its continuation state?");
    if (!replace || !ownsGoal()) return;
  }

  // Recovery must not change the captured goal while replacement waits or infers file proof.
  const hold = Symbol();
  runtime.continuationHeld = hold;
  try {
    let waitError: unknown;
    try {
      await ctx.waitForIdle();
    } catch (error) {
      waitError = error;
    }
    if (!ownsGoal()) return;
    if (waitError) {
      reportError(ctx, "Goal could not wait for the active turn", waitError);
      return;
    }
    let verification: Awaited<ReturnType<typeof inferGoalVerification>>;
    try {
      verification = await inferGoalVerification(objective, ctx.cwd);
    } catch (error) {
      if (!ownsGoal()) return;
      if (!unfinished) {
        reportError(ctx, "Goal could not be started", error);
      } else {
        reportError(ctx, "Goal could not be replaced", error);
      }
      return;
    }
    if (!ownsGoal()) return;
    try {
      const state = createNewGoalState(objective, sumGoalTokens(ctx), verification, Date.now(), {
        maxTurns: DEFAULT_GOAL_MAX_TURNS,
      });
      persistGoalState(pi, runtime, unfinished ? "replace" : "set", state);
      // The replacement supersedes any recovery still parked after waitForIdle().
      if (unfinished) runtime.automaticCompaction = undefined;
      if (runtime.continuationHeld === hold) runtime.continuationHeld = undefined;
      if (scheduleGoalContinuation(pi, runtime, ctx) && ctx.mode !== "tui") {
        ctx.ui.notify(`${unfinished ? "Goal replaced" : "Goal started"}. Each turn must record continue, complete, or a blocker decision before another turn starts.`, "info");
      }
    } catch (error) {
      if (!unfinished) {
        reportError(ctx, "Goal could not be started", error);
      } else if (runtime.state?.status === "active") {
        pauseGoalAfterFailure(
          pi,
          runtime,
          ctx,
          `Goal could not be replaced: ${errorMessage(error)}`,
          "Automatic continuation is stopped. Retry replacement after session storage recovers.",
        );
      } else {
        reportError(ctx, "Goal could not be replaced", error);
      }
    }
  } finally {
    if (releaseContinuationHold(pi, runtime, ctx, hold) && runtime.lifecycleGeneration === generation) {
      scheduleGoalContinuation(pi, runtime, ctx);
    }
  }
}

/** Registers /goal: it parses the arguments, captures the goal it acts on, and runs one subcommand. */
export function registerGoalCommand(pi: ExtensionAPI, runtime: GoalRuntime): void {
  const handleGoalCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    let command = parseGoalCommand(args);
    if (!isAutomationMode(ctx)) {
      ctx.ui.notify("/goal requires TUI or RPC mode", "error");
      return;
    }
    if (command.kind === "invalid") {
      ctx.ui.notify(command.message, "error");
      return;
    }
    if (!isSavedSession(ctx)) {
      ctx.ui.notify("/goal requires a saved session", "error");
      return;
    }
    const generation = runtime.lifecycleGeneration;
    const initiatingState = runtime.state;
    const ownsGoal = (): boolean => runtime.lifecycleGeneration === generation && runtime.state === initiatingState;

    if (command.kind === "edit" && initiatingState?.status !== "active" && initiatingState?.status !== "paused") {
      const fallback = parseGoalObjectiveText(args.trim());
      if (fallback.kind === "invalid") {
        ctx.ui.notify(fallback.message, "error");
        return;
      }
      command = fallback;
    }
    const scope: GoalCommandScope = { pi, runtime, ctx, generation, initiatingState, ownsGoal };
    switch (command.kind) {
      case "status": return showGoalStatus(scope, (control) => handleGoalCommand(control, ctx));
      case "clear": return clearGoal(scope);
      case "pause": return pauseGoalCommand(scope);
      case "resume": return resumeGoalCommand(scope);
      case "edit": return editGoal(scope, command.objective);
      case "objective": return startGoal(scope, command.objective);
      default: {
        const unhandled: never = command;
        return unhandled;
      }
    }
  };

  pi.registerCommand("goal", {
    description: "Set a non-command objective or view the current goal",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      const actions = [
        { value: "clear", description: "Remove the current goal" },
        { value: "edit", description: "Update the objective without resetting the goal" },
        { value: "pause", description: "Stop automatic continuation" },
        { value: "resume", description: "Resume automatic continuation" },
      ];
      return actions
        .filter((action) => action.value.startsWith(normalized))
        .map((action) => ({ ...action, label: action.value.trimEnd() }));
    },
    handler: handleGoalCommand,
  });
}
