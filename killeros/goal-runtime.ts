import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, reportError } from "./errors.ts";
import { entryUsage, isAutomationMode, lastAssistantMessage } from "./pi-context.ts";
import {
  beginGoalTurnState,
  boundGoalText,
  checkpointActiveGoalState,
  checkpointPausedGoalState,
  GOAL_VERSION,
  parseGoalState,
  pauseGoalState,
  transitionGoalState,
  type GoalTransitionOptions,
} from "./goal-state.ts";
import { GOAL_CONTINUATION_TYPE, notifyGoalChange, type GoalRuntime, type GoalState, type GoalStatus } from "./goal-model.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";
import { isRecord } from "./guards.ts";

export const GOAL_ENTRY_TYPE = "killeros-goal";
export const GOAL_UPDATE_TOOL = "killeros_goal_update";

type GoalEntryEvent = "set" | "replace" | "edit" | "limit" | "turn" | "continue" | "pause" | "resume" | "blocked" | "complete" | "error" | "clear" | "checkpoint" | "blocker-audit";
/** Entry events that change the goal itself, as opposed to recording turn progress or clearing it. */
type GoalChangeEvent = Exclude<GoalEntryEvent, "continue" | "blocker-audit" | "clear">;

export interface GoalEntryData {
  version: 1;
  event: GoalEntryEvent;
  state: GoalState | null;
}

function goalBranchEntries(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getEntries"]> {
  try {
    return ctx.sessionManager.getBranch();
  } catch {
    return [];
  }
}

function restoreGoalState(ctx: ExtensionContext): GoalState | undefined {
  const entries = goalBranchEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const data: unknown = entry.data;
    if (!isRecord(data) || data.version !== GOAL_VERSION || data.state === null) {
      return undefined;
    }
    // v2.0.18 shutdown checkpoints stopped active clocks by omitting activeStartedAt.
    const savedState = data.event === "checkpoint"
      && isRecord(data.state)
      && data.state.status === "active"
      && data.state.activeStartedAt === undefined
      ? { ...data.state, activeStartedAt: Date.now() }
      : data.state;
    const restored = parseGoalState(savedState);
    if (!restored) return undefined;
    if (restored.status === "active") {
      return { ...restored, activeStartedAt: Date.now() };
    }
    if (restored.status === "paused") {
      const { resumeAfterManualCompaction: _resume, ...state } = restored;
      return state;
    }
    return restored;
  }
  return undefined;
}

export function sumGoalTokens(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of goalBranchEntries(ctx)) {
    total += entryUsage(entry)?.totalTokens ?? 0;
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
  const permission = runtime.blockedCompletion;
  setGoalUpdateToolActive(pi, runtime.state?.status === "active"
    || permission?.kind === "eligible"
      && permission.state === runtime.state
      && permission.generation === runtime.lifecycleGeneration);
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

/** Appends a goal entry and makes its state current. */
function saveGoalEntry(pi: ExtensionAPI, runtime: GoalRuntime, event: GoalEntryEvent, state: GoalState | undefined): void {
  const data: GoalEntryData = { version: GOAL_VERSION, event, state: state ?? null };
  pi.appendEntry(GOAL_ENTRY_TYPE, data);
  runtime.state = state;
  runtime.blockedCompletion = undefined;
  syncGoalUpdateTool(pi, runtime);
  runtime.persistenceRetryNeeded = false;
  notifyGoalChange(runtime);
}

/** Saves a goal change; a command that captured the previous goal while it waited no longer owns it. */
export function persistGoalState(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalChangeEvent,
  state: GoalState,
): void {
  saveGoalEntry(pi, runtime, event, state);
  runtime.mutation = Symbol();
}

/** Records accepted progress for the current turn, so an edit waiting for that turn stays valid. */
export function recordGoalProgress(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: "continue" | "blocker-audit",
  state: Extract<GoalState, { status: "active" }>,
): void {
  saveGoalEntry(pi, runtime, event, state);
  runtime.goalTurn = { turn: state.turns, revision: state.revision };
}

/** Removes the goal and starts a new lifecycle, so work still pending for the old goal is stale. */
export function clearGoalState(pi: ExtensionAPI, runtime: GoalRuntime): void {
  saveGoalEntry(pi, runtime, "clear", undefined);
  runtime.mutation = Symbol();
  runtime.lifecycleGeneration += 1;
  runtime.continuationHeld = undefined;
}

export function transitionGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalChangeEvent,
  status: GoalStatus,
  result?: string,
  options: GoalTransitionOptions = {},
): GoalState {
  const current = runtime.state;
  if (!current) throw new Error("No goal is set");
  const next = transitionGoalState(current, status, result, options, Date.now());
  persistGoalState(pi, runtime, event, next);
  settleExecutionFlags(runtime, status, options);
  return next;
}

/** Detaches Pi's current request from any goal turn. */
export function endGoalTurn(runtime: GoalRuntime): void {
  runtime.goalTurn = undefined;
  runtime.goalTurnInFlight = false;
  runtime.agentEndObserved = false;
}

/** Applies the execution state that follows a status change, saved or not; recovery options keep the interrupted turn. */
function settleExecutionFlags(runtime: GoalRuntime, status: GoalStatus, options: GoalTransitionOptions): void {
  runtime.continuationScheduled = false;
  if (status !== "active") {
    runtime.automaticCompaction = undefined;
    if (!options.hold) endGoalTurn(runtime);
  } else if (options.resume !== "same-turn") {
    endGoalTurn(runtime);
  }
}

/** Pauses the goal in memory after its save failed, so automation stops while the save waits for a retry. */
export function pauseGoalUnsaved(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  reason: string | undefined,
  options: GoalTransitionOptions = {},
): void {
  const current = runtime.state;
  // Build the paused state first: a goal whose clock cannot stop safely must keep its execution state.
  const paused = current && pauseGoalState(current, reason, Date.now(), options.hold);
  settleExecutionFlags(runtime, "paused", options);
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
  holdUnsavedGoal(pi, runtime, paused);
}

/** Keeps a goal state that could not be saved, so the next goal command retries the save. */
export function holdUnsavedGoal(pi: ExtensionAPI, runtime: GoalRuntime, state: GoalState | undefined): void {
  runtime.state = state;
  syncGoalUpdateTool(pi, runtime);
  runtime.persistenceRetryNeeded = true;
  notifyGoalChange(runtime);
}

/** Saves a paused goal, or pauses it unsaved when the session cannot record the pause. */
export function pauseGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalChangeEvent,
  reason: string | undefined,
  options: GoalTransitionOptions = {},
): void {
  try {
    transitionGoal(pi, runtime, event, "paused", reason, options);
  } catch {
    pauseGoalUnsaved(pi, runtime, reason, options);
  }
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
    pauseGoalAfterFailure(pi, runtime, ctx, `turn limit pause could not be saved: ${errorMessage(error)}`);
  }
  return true;
}

function clearGoalExecutionFlags(runtime: GoalRuntime): void {
  runtime.continuationScheduled = false;
  endGoalTurn(runtime);
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

/** Pauses an active goal after a failure without telling the user, for callers that report it themselves. */
export function pauseFailedGoal(pi: ExtensionAPI, runtime: GoalRuntime, reason: string): string | undefined {
  if (runtime.state?.status !== "active") return undefined;
  const safeReason = safeFailureReason(reason);
  pauseGoal(pi, runtime, "error", safeReason);
  return safeReason;
}

/** Pauses an active goal after a failure and tells the user how to recover. */
export function pauseGoalAfterFailure(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
  recoveryInstruction = "Run /goal resume after resolving the problem.",
): void {
  const safeReason = pauseFailedGoal(pi, runtime, reason);
  if (safeReason !== undefined) ctx.ui.notify(`Goal paused: ${safeReason}\n${safeTerminalText(recoveryInstruction)}`, "error");
}

/** Pauses a goal whose turn ended without an accepted continue, complete, or blocked decision. */
export function pauseGoalWithoutDecision(pi: ExtensionAPI, runtime: GoalRuntime, ctx: ExtensionContext): void {
  pauseGoalAfterFailure(
    pi,
    runtime,
    ctx,
    "no turn decision",
    "The agent ended without choosing continue, complete, or blocked. Run /goal resume only after choosing to continue.",
  );
}

/** Pauses an active goal whose tool is unavailable. */
function pauseGoalBeforeTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
): void {
  const state = runtime.state;
  if (state?.status !== "active") return;
  const nextTurn = state.turns + 1;
  const reason = "killeros_goal_update is unavailable";
  pauseGoal(pi, runtime, "error", reason);
  ctx.ui.notify(
    `Goal paused before turn ${nextTurn}: ${reason}\nEnable the goal tool, then run /goal resume.`,
    "error",
  );
}

/** Aborts the request a paused goal was about to own. */
function abortGoalRequest(ctx: ExtensionContext): void {
  try {
    ctx.abort();
  } catch {
    // The goal is already paused; a host abort may be unavailable during startup.
  }
}

function beginGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  current: Extract<GoalState, { status: "active" }>,
): Extract<GoalState, { status: "active" }> | undefined {
  let next: Extract<GoalState, { status: "active" }>;
  try {
    next = beginGoalTurnState(current, Date.now());
    persistGoalState(pi, runtime, "turn", next);
  } catch (error) {
    pauseGoalAfterFailure(pi, runtime, ctx, `turn state could not be saved: ${errorMessage(error)}`);
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
      content: goalContinuationMessage(state),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    return true;
  } catch (error) {
    runtime.continuationScheduled = false;
    endGoalTurn(runtime);
    pauseGoalAfterFailure(pi, runtime, ctx, `continuation could not start: ${errorMessage(error)}`);
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
  if (isAutomationMode(ctx) && isSavedSession(ctx) && pauseGoalAtTurnLimit(pi, runtime, ctx)) return false;
  if (!isAutomationMode(ctx)
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
  return next !== undefined && sendGoalTurn(pi, runtime, ctx, next);
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
    "If earlier messages contain a different objective, the objective above replaces them.",
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

function blockedGoalSystemPrompt(state: Extract<GoalState, { status: "blocked" }>): string {
  return [
    "# Blocked KillerOS goal",
    "Status: blocked",
    "Objective:",
    state.objective,
    "",
    "Treat the exact saved objective above as authoritative. Automatic goal continuation remains stopped; this ordinary request grants no goal turns.",
    "If killeros_goal_update is available, you may call it only with status complete and current evidence after auditing and verifying the whole unchanged objective.",
    "File proof checks only the persisted deliverable against its original baseline, not every acceptance criterion. General-objective completion is model-reported.",
    "The disappearance of a blocker alone does not prove completion. If useful work remains or this request is unrelated, finish normally without a goal update. No decision is mandatory.",
    "Never use the goal tool to continue, audit a blocker, pause, resume, edit, replace, or clear this goal. User controls remain unchanged.",
  ].join("\n");
}

function goalSystemPrompt(state: GoalState): string {
  return goalInstructions(state, "Active KillerOS goal");
}

function goalContinuationMessage(state: GoalState): string {
  return goalInstructions(state, "KillerOS long-running goal turn");
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
    runtime.state = isAutomationMode(ctx) ? restored : undefined;
    runtime.blockedCompletion = undefined;
    syncGoalUpdateTool(pi, runtime);
    clearGoalExecutionFlags(runtime);
    runtime.continuationHeld = undefined;
    runtime.persistenceRetryNeeded = false;
    notifyGoalChange(runtime);
    const state = runtime.state;
    if (state?.status !== "active") return;
    if ((state.turnPhase === "in-flight") || (state.turnPhase === undefined && state.turns > 0)) {
      pauseGoalWithoutDecision(pi, runtime, ctx);
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
    runtime.blockedCompletion = undefined;
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
    runtime.continuationHeld = undefined;
    runtime.persistenceRetryNeeded = false;
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.continuationScheduled = false;
    if (!runtime.goalTurnInFlight && isAutomationMode(ctx) && isSavedSession(ctx) && pauseGoalAtTurnLimit(pi, runtime, ctx)) return;
    const current = runtime.state;
    if (!isAutomationMode(ctx) || !isSavedSession(ctx) || !current) return;
    if (current.status === "paused" && current.resumeAfterManualCompaction === true) {
      // The aborted turn may resume only when /compact follows the abort directly. A request in between means
      // the user moved on, so a later /compact must not restart the old turn.
      const checkpoint = checkpointPausedGoalState(current, Date.now());
      try {
        persistGoalState(pi, runtime, "checkpoint", checkpoint);
      } catch {
        holdUnsavedGoal(pi, runtime, checkpoint);
      }
      return;
    }
    if (current.status === "blocked") {
      runtime.blockedCompletion ??= { kind: "eligible", state: current, generation: runtime.lifecycleGeneration };
      syncGoalUpdateTool(pi, runtime);
      return { systemPrompt: `${event.systemPrompt}\n\n${blockedGoalSystemPrompt(current)}` };
    }
    if (current.status !== "active") return;
    if (runtime.goalTurnInFlight) {
      if (!goalUpdateToolIsAvailable(pi)) {
        pauseGoalBeforeTurn(pi, runtime, ctx);
        abortGoalRequest(ctx);
        return;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(current)}` };
    }
    if (current.turnPhase === "in-flight") {
      pauseGoalWithoutDecision(pi, runtime, ctx);
      return;
    }
    if (!goalUpdateToolIsAvailable(pi)) {
      pauseGoalBeforeTurn(pi, runtime, ctx);
      abortGoalRequest(ctx);
      return;
    }
    const next = beginGoalTurn(pi, runtime, ctx, current);
    if (!next) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(next)}` };
  });

  pi.on("agent_end", (event) => {
    if (!runtime.goalTurnInFlight) return;
    const finalAssistant = lastAssistantMessage(event.messages);
    runtime.agentEndObserved = finalAssistant !== undefined;
    runtime.lastStopReason = finalAssistant?.stopReason;
    runtime.lastError = finalAssistant?.errorMessage;
  });
}
