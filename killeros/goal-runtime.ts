import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportError } from "./errors.ts";
import {
  beginGoalTurnState,
  boundGoalText,
  checkpointActiveGoalState,
  GOAL_VERSION,
  parseGoalState,
  pauseGoalState,
  transitionGoalState,
  type GoalTransitionOptions,
} from "./goal-state.ts";
import { resolvePersonalInstructions } from "./personal-instructions.ts";
import type { GoalRuntime, GoalState, GoalStatus } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

export const GOAL_ENTRY_TYPE = "killeros-goal";
const GOAL_CONTINUATION_TYPE = "killeros-goal-continuation";
export const GOAL_UPDATE_TOOL = "killeros_goal_update";

export type GoalEntryEvent = "set" | "replace" | "limit" | "turn" | "continue" | "pause" | "resume" | "blocked" | "complete" | "error" | "clear" | "checkpoint" | "blocker-audit";
export interface GoalEntryData {
  version: 1;
  event: GoalEntryEvent;
  state: GoalState | null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RestoredGoalState {
  state?: GoalState;
}

export function goalBranchEntries(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getEntries"]> {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

function restoreGoalState(ctx: ExtensionContext): RestoredGoalState {
  const entries = goalBranchEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const data: unknown = entry.data;
    if (!isUnknownRecord(data) || data.version !== GOAL_VERSION || data.state === null) {
      return { state: undefined };
    }
    // v2.0.18 shutdown checkpoints stopped active clocks by omitting activeStartedAt.
    const savedState = data.event === "checkpoint"
      && isUnknownRecord(data.state)
      && data.state.status === "active"
      && data.state.activeStartedAt === undefined
      ? { ...data.state, activeStartedAt: Date.now() }
      : data.state;
    const restored = parseGoalState(savedState);
    if (!restored) return { state: undefined };
    if (restored.status === "active") {
      return { state: { ...restored, activeStartedAt: Date.now() } };
    }
    if (restored.status === "paused") {
      const { resumeAfterManualCompaction: _resume, ...state } = restored;
      return { state };
    }
    return { state: restored };
  }
  return { state: undefined };
}

export function sumGoalTokens(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of goalBranchEntries(ctx)) {
    if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
      total += entry.message.usage?.totalTokens ?? 0;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      total += entry.usage.totalTokens;
    }
  }
  return total;
}

function setGoalUpdateToolActive(pi: ExtensionAPI, active: boolean): void {
  try {
    const activeTools = pi.getActiveTools();
    const isActive = activeTools.includes(GOAL_UPDATE_TOOL);
    if (active === isActive) return;
    pi.setActiveTools(active
      ? [...activeTools, GOAL_UPDATE_TOOL]
      : activeTools.filter((name) => name !== GOAL_UPDATE_TOOL));
  } catch {
    // Availability is checked again immediately before a goal request.
  }
}

export function syncGoalUpdateTool(pi: ExtensionAPI, runtime: GoalRuntime): void {
  setGoalUpdateToolActive(pi, runtime.state?.status === "active");
}

function goalUpdateToolIsAvailable(pi: ExtensionAPI): boolean {
  try {
    const active = pi.getActiveTools();
    if (!active.includes(GOAL_UPDATE_TOOL)) pi.setActiveTools([...active, GOAL_UPDATE_TOOL]);
    return pi.getActiveTools().includes(GOAL_UPDATE_TOOL);
  } catch {
    return false;
  }
}

export function persistGoalState(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalEntryEvent,
  state: GoalState | undefined,
): void {
  const data: GoalEntryData = { version: GOAL_VERSION, event, state: state ?? null };
  pi.appendEntry(GOAL_ENTRY_TYPE, data);
  runtime.state = state;
  syncGoalUpdateTool(pi, runtime);
  runtime.persistenceRetryNeeded = false;
  runtime.requestRender?.();
}

export function transitionGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalEntryEvent,
  status: GoalStatus,
  result?: string,
  options: GoalTransitionOptions = {},
): GoalState {
  const current = runtime.state;
  if (!current) throw new Error("No goal is set");
  const next = transitionGoalState(current, status, result, options, Date.now());
  persistGoalState(pi, runtime, event, next);
  if (status !== "active") {
    runtime.continuationScheduled = false;
    runtime.automaticCompaction = undefined;
    if (!options.keepTurnForRecovery) {
      runtime.goalTurn = undefined;
      runtime.goalTurnInFlight = false;
      runtime.agentEndObserved = false;
    }
  } else if (!options.resumeInterruptedTurn) {
    runtime.goalTurn = undefined;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
  }
  return next;
}

export function pauseGoalAtTurnLimit(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): boolean {
  const state = runtime.state;
  if (state?.status !== "active" || state.maxTurns === undefined || state.turns < state.maxTurns) return false;
  const result = `Turn limit reached (${state.turns}/${state.maxTurns}).`;
  try {
    transitionGoal(pi, runtime, "limit", "paused", result);
  } catch (error) {
    pauseGoalAfterFailure(pi, runtime, ctx, `turn limit pause could not be saved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

function clearGoalExecutionFlags(runtime: GoalRuntime): void {
  runtime.continuationScheduled = false;
  runtime.goalTurnInFlight = false;
  runtime.agentEndObserved = false;
  runtime.goalTurn = undefined;
  runtime.automaticCompaction = undefined;
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
}

export async function stopGoalRun(runtime: GoalRuntime, ctx: ExtensionCommandContext, shouldStop: boolean): Promise<void> {
  if (!shouldStop) return;
  try {
    ctx.abort();
    await ctx.waitForIdle();
  } finally {
    clearGoalExecutionFlags(runtime);
  }
}

function safeFailureReason(reason: string): string {
  return boundGoalText(reason) || "an unspecified goal failure";
}

export function pauseGoalAfterFailure(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
  recoveryInstruction = "Run /goal resume after resolving the problem.",
  notify = true,
): void {
  if (runtime.state?.status !== "active") return;
  const safeReason = safeFailureReason(reason);
  const safeRecoveryInstruction = safeReason === "no turn decision"
    && recoveryInstruction === "Run /goal resume after resolving the problem."
    ? "The agent ended without choosing continue, complete, or blocked. Run /goal resume only after choosing to continue."
    : safeTerminalText(recoveryInstruction);
  try {
    transitionGoal(pi, runtime, "error", "paused", safeReason);
  } catch {
    const current = runtime.state;
    runtime.state = current ? pauseGoalState(current, safeReason, Date.now()) : undefined;
    syncGoalUpdateTool(pi, runtime);
    runtime.persistenceRetryNeeded = true;
    clearGoalExecutionFlags(runtime);
    runtime.requestRender?.();
  }
  if (notify) ctx.ui.notify(`Goal paused: ${safeReason}\n${safeRecoveryInstruction}`, "error");
}

function pauseGoalBeforeTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): void {
  const state = runtime.state;
  if (state?.status !== "active") return;
  const nextTurn = state.turns + 1;
  const reason = "killeros_goal_update is unavailable";
  try {
    transitionGoal(pi, runtime, "error", "paused", reason);
  } catch {
    runtime.state = pauseGoalState(state, reason, Date.now());
    syncGoalUpdateTool(pi, runtime);
    runtime.persistenceRetryNeeded = true;
    clearGoalExecutionFlags(runtime);
    runtime.requestRender?.();
  }
  ctx.ui.notify(
    `Goal paused before turn ${nextTurn}: ${reason}\nEnable the goal tool, then run /goal resume.`,
    "error",
  );
}

function beginGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  current: Extract<GoalState, { status: "active" }>,
): GoalState | undefined {
  let next: GoalState;
  try {
    next = beginGoalTurnState(current, Date.now());
    persistGoalState(pi, runtime, "turn", next);
  } catch (error) {
    pauseGoalAfterFailure(pi, runtime, ctx, `turn state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  runtime.goalTurn = { revision: next.revision, turn: next.turns };
  runtime.goalTurnInFlight = true;
  runtime.agentEndObserved = false;
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
  return next;
}

function sendGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  state: Extract<GoalState, { status: "active" }>,
): boolean {
  runtime.continuationScheduled = true;
  try {
    pi.sendMessage({
      customType: GOAL_CONTINUATION_TYPE,
      content: goalContinuationMessage(state, ctx),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    return true;
  } catch (error) {
    runtime.continuationScheduled = false;
    runtime.goalTurnInFlight = false;
    runtime.goalTurn = undefined;
    pauseGoalAfterFailure(pi, runtime, ctx, `continuation could not start: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function resumeInterruptedGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): boolean {
  const state = runtime.state;
  if (state?.status !== "active"
    || (state.turnPhase !== "in-flight" && state.turnPhase !== "authorized")
    || !runtime.goalTurnInFlight) return false;
  if (!goalUpdateToolIsAvailable(pi)) {
    pauseGoalBeforeTurn(pi, runtime, ctx);
    return false;
  }
  return sendGoalTurn(pi, runtime, ctx, state);
}

/** Starts one goal turn only after Pi is idle and all competing workflow gates are clear. */
export function scheduleGoalContinuation(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  guard?: { generation: number; state: GoalState },
): boolean {
  if (guard && (guard.generation !== runtime.lifecycleGeneration || runtime.state !== guard.state)) return false;
  if (isGoalModeSupported(ctx) && isSavedSession(ctx) && pauseGoalAtTurnLimit(pi, runtime, ctx)) return false;
  if (!isGoalModeSupported(ctx)
    || !isSavedSession(ctx)
    || runtime.state?.status !== "active"
    || runtime.continuationScheduled
    || runtime.continuationHeld
    || runtime.goalTurnInFlight
    || !ctx.isIdle()
    || ctx.hasPendingMessages()) return false;

  const current = runtime.state;
  const phase = current.turnPhase;
  const canStart = phase === "ready"
    || phase === "authorized"
    || phase === undefined && current.turns === 0;
  if (!canStart || phase === "authorized" && current.turnDecision === undefined) return false;
  if (!goalUpdateToolIsAvailable(pi)) {
    pauseGoalBeforeTurn(pi, runtime, ctx);
    return false;
  }
  const next = beginGoalTurn(pi, runtime, ctx, current);
  return next !== undefined && sendGoalTurn(pi, runtime, ctx, next as Extract<GoalState, { status: "active" }>);
}

function goalInstructions(state: GoalState, heading: string): string {
  const previous = state.lastDecision;
  const continuation = previous?.kind === "continue"
    ? [
      "The previous turn's accepted next action was model-reported (not independently verified):",
      previous.nextAction,
    ]
    : [];
  return [
    `# ${heading}`,
    `Status: active · Turn: ${state.turns}`,
    "Objective:",
    state.objective,
    "",
    "Treat the exact objective above from /goal as authoritative; a compaction summary may describe it but does not replace it.",
    "If the current context contains a compaction summary, take its first concrete next step after checking the current repository state.",
    ...continuation,
    "Continue making concrete progress toward this unchanged objective. Re-check repository state and prior results instead of repeating work.",
    ...(state.turnDecision === undefined
      ? [
        "Before ending this turn, choose exactly one accepted goal decision.",
        "After auditing and verifying the whole objective, call killeros_goal_update with status complete and concise evidence.",
        "If useful work remains, call killeros_goal_update with status continue, concrete evidence from this turn, and one concrete nextAction toward the unchanged objective.",
        "If one external impasse persists, call killeros_goal_update with status blocked, the same lowercase blockerKey, and current evidence; attempts one and two record audits and attempt three marks the goal blocked.",
      ]
      : ["This logical turn already has one accepted decision. Do not call killeros_goal_update again; finish the interrupted request, then let KillerOS start the authorized next turn after settlement."]),
    "A normal response without one accepted decision pauses the goal. Do not restate a previous result as progress.",
    "Goal evidence and nextAction are model-reported; KillerOS does not verify progress from prose or tool activity.",
    "Never use the goal tool to pause, resume, edit, replace, or clear the objective. Those transitions belong to the user.",
  ].join("\n");
}

function goalSystemPrompt(state: GoalState): string {
  return goalInstructions(state, "Active KillerOS goal");
}

function goalContinuationMessage(state: GoalState, ctx: ExtensionContext): string {
  const sections = [goalInstructions(state, "KillerOS long-running goal turn")];
  if (ctx.isProjectTrusted()) {
    const personal = resolvePersonalInstructions(ctx.cwd);
    if (personal) sections.push(personal);
  }
  return sections.join("\n\n");
}

export function isGoalModeSupported(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function isSavedSession(ctx: ExtensionContext): boolean {
  try {
    return Boolean(ctx.sessionManager.getSessionFile());
  } catch {
    return false;
  }
}

export function registerGoalRuntime(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
): void {
  const restoreGoal = (ctx: ExtensionContext): void => {
    runtime.lifecycleGeneration += 1;
    const generation = runtime.lifecycleGeneration;
    const restored = restoreGoalState(ctx);
    runtime.state = isGoalModeSupported(ctx) ? restored.state : undefined;
    syncGoalUpdateTool(pi, runtime);
    runtime.continuationScheduled = false;
    runtime.continuationHeld = false;
    runtime.goalTurnInFlight = false;
    runtime.goalTurn = undefined;
    runtime.agentEndObserved = false;
    runtime.automaticCompaction = undefined;
    runtime.persistenceRetryNeeded = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    runtime.requestRender?.();
    const state = runtime.state;
    if (state?.status !== "active") return;
    if ((state.turnPhase === "in-flight") || (state.turnPhase === undefined && state.turns > 0)) {
      pauseGoalAfterFailure(pi, runtime, ctx, "no turn decision");
      return;
    }
    setImmediate(() => {
      if (runtime.lifecycleGeneration !== generation || runtime.state !== state) return;
      scheduleGoalContinuation(pi, runtime, ctx, { generation, state });
    });
  };

  pi.on("session_start", (_event, ctx) => restoreGoal(ctx));
  pi.on("session_tree", (_event, ctx) => restoreGoal(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    runtime.lifecycleGeneration += 1;
    if (runtime.state?.status === "active") {
      const checkpoint = checkpointActiveGoalState(runtime.state, Date.now());
      try {
        persistGoalState(pi, runtime, "checkpoint", checkpoint);
      } catch (error) {
        reportError(ctx, "Goal state could not be checkpointed", error);
      }
    }
    runtime.state = undefined;
    syncGoalUpdateTool(pi, runtime);
    clearGoalExecutionFlags(runtime);
    runtime.continuationHeld = false;
    runtime.persistenceRetryNeeded = false;
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.continuationScheduled = false;
    if (!runtime.goalTurnInFlight && isGoalModeSupported(ctx) && isSavedSession(ctx) && pauseGoalAtTurnLimit(pi, runtime, ctx)) return;
    const current = runtime.state;
    if (!isGoalModeSupported(ctx) || !isSavedSession(ctx) || !current || current.status !== "active") return;
    if (runtime.goalTurnInFlight) {
      if (!goalUpdateToolIsAvailable(pi)) {
        pauseGoalBeforeTurn(pi, runtime, ctx);
        try {
          ctx.abort();
        } catch {
          // The state is already paused; a host abort may be unavailable during startup.
        }
        return;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(current)}` };
    }
    if (current.turnPhase === "in-flight") {
      pauseGoalAfterFailure(pi, runtime, ctx, "no turn decision");
      return;
    }
    if (!goalUpdateToolIsAvailable(pi)) {
      pauseGoalBeforeTurn(pi, runtime, ctx);
      try {
        ctx.abort();
      } catch {
        // See the in-flight branch above.
      }
      return;
    }
    const next = beginGoalTurn(pi, runtime, ctx, current);
    if (!next) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(next)}` };
  });

  pi.on("agent_end", (event) => {
    if (!runtime.goalTurnInFlight) return;
    const finalAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    runtime.agentEndObserved = finalAssistant !== undefined;
    runtime.lastStopReason = finalAssistant?.stopReason;
    runtime.lastError = finalAssistant?.errorMessage;
  });
}
