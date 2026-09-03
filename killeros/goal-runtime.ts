import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportError } from "./errors.ts";
import { beginGoalTurnState, checkpointActiveGoalState, GOAL_VERSION, parseGoalState, pauseGoalState, transitionGoalState, type GoalTransitionOptions } from "./goal-state.ts";
import { resolvePersonalInstructions } from "./personal-instructions.ts";
import type { GoalRuntime, GoalState, GoalStatus, InitRuntime } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

export const GOAL_ENTRY_TYPE = "killeros-goal";
const GOAL_CONTINUATION_TYPE = "killeros-goal-continuation";
export const GOAL_UPDATE_TOOL = "killeros_goal_update";

export type GoalEntryEvent = "set" | "replace" | "limit" | "turn" | "pause" | "resume" | "blocked" | "complete" | "error" | "clear" | "checkpoint" | "blocker-audit";
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
  const activeTools = pi.getActiveTools();
  const isActive = activeTools.includes(GOAL_UPDATE_TOOL);
  if (active === isActive) return;
  pi.setActiveTools(active
    ? [...activeTools, GOAL_UPDATE_TOOL]
    : activeTools.filter((name) => name !== GOAL_UPDATE_TOOL));
}

export function syncGoalUpdateTool(pi: ExtensionAPI, runtime: GoalRuntime): void {
  setGoalUpdateToolActive(pi, runtime.state?.status === "active");
}

export function persistGoalState(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalEntryEvent,
  state: GoalState | undefined,
): void {
  const data: GoalEntryData = { version: GOAL_VERSION, event, state: state ?? null };
  runtime.automaticCompaction = undefined;
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

export function pauseGoalAfterFailure(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
  recoveryInstruction = "Run /goal resume after resolving the problem.",
  notify = true,
): void {
  if (runtime.state?.status !== "active") return;
  const safeReason = safeTerminalText(reason);
  try {
    transitionGoal(pi, runtime, "error", "paused", safeReason);
  } catch {
    const current = runtime.state;
    runtime.state = current ? pauseGoalState(current, safeReason, Date.now()) : undefined;
    syncGoalUpdateTool(pi, runtime);
    runtime.persistenceRetryNeeded = true;
    runtime.continuationScheduled = false;
    runtime.automaticCompaction = undefined;
    runtime.requestRender?.();
  }
  if (notify) ctx.ui.notify(`Goal paused: ${safeReason}\n${recoveryInstruction}`, "error");
}

function beginGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  current: Extract<GoalState, { status: "active" }>,
): GoalState | undefined {
  const next = beginGoalTurnState(current, Date.now());
  try {
    persistGoalState(pi, runtime, "turn", next);
  } catch (error) {
    pauseGoalAfterFailure(pi, runtime, ctx, `turn state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  runtime.goalTurnInFlight = true;
  runtime.agentEndObserved = false;
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
  return next;
}

/** Starts one goal turn only after Pi is idle and all competing workflow gates are clear. */
export function scheduleGoalContinuation(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): boolean {
  if (isGoalModeSupported(ctx) && isSavedSession(ctx) && pauseGoalAtTurnLimit(pi, runtime, ctx)) return false;
  if (!isGoalModeSupported(ctx)
    || !isSavedSession(ctx)
    || runtime.state?.status !== "active"
    || runtime.continuationScheduled
    || runtime.continuationHeld
    || runtime.goalTurnInFlight
    || initState.active
    || !ctx.isIdle()
    || ctx.hasPendingMessages()) return false;
  runtime.continuationScheduled = true;
  const next = beginGoalTurn(pi, runtime, ctx, runtime.state);
  if (!next) return false;
  try {
    pi.sendMessage({
      customType: GOAL_CONTINUATION_TYPE,
      content: goalContinuationMessage(next, ctx),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
    return true;
  } catch (error) {
    runtime.continuationScheduled = false;
    runtime.goalTurnInFlight = false;
    pauseGoalAfterFailure(pi, runtime, ctx, `continuation could not start: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function goalInstructions(state: GoalState, heading: string): string {
  return [
    `# ${heading}`,
    `Status: active · Turn: ${state.turns}`,
    "Objective:",
    state.objective,
    "",
    "Treat the exact objective above from /goal as authoritative; a compaction summary may describe it but does not replace it.",
    "If the current context contains a compaction summary, take its first concrete next step after checking the current repository state.",
    "Continue making concrete progress toward this unchanged objective. Re-check repository state and prior results instead of repeating work.",
    "Do not stop merely because one response is complete: KillerOS will start another goal turn while the goal remains active.",
    "Before declaring completion, audit every part of the objective and verify the relevant results. Then call killeros_goal_update with status complete and concise evidence.",
    "Call killeros_goal_update with status blocked and the same lowercase blockerKey on each turn where one external impasse persists; attempts one and two record the audit, and attempt three marks the goal blocked.",
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
    if (personal) {
      sections.push(personal);
    }
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
  initState: InitRuntime,
): void {
  const restoreGoal = (ctx: ExtensionContext): void => {
    const restored = restoreGoalState(ctx);
    runtime.state = isGoalModeSupported(ctx) ? restored.state : undefined;
    syncGoalUpdateTool(pi, runtime);
    runtime.continuationScheduled = false;
    runtime.continuationHeld = false;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.automaticCompaction = undefined;
    runtime.persistenceRetryNeeded = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    runtime.requestRender?.();
    if (runtime.state?.status === "active") {
      setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
    }
  };

  pi.on("session_start", (_event, ctx) => restoreGoal(ctx));
  pi.on("session_tree", (_event, ctx) => restoreGoal(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
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
    runtime.continuationScheduled = false;
    runtime.continuationHeld = false;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.automaticCompaction = undefined;
    runtime.persistenceRetryNeeded = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.continuationScheduled = false;
    if (!runtime.goalTurnInFlight && isGoalModeSupported(ctx) && isSavedSession(ctx) && pauseGoalAtTurnLimit(pi, runtime, ctx)) return;
    const current = runtime.state;
    if (!isGoalModeSupported(ctx) || !isSavedSession(ctx) || !current || current.status !== "active" || initState.active) return;
    if (runtime.goalTurnInFlight) return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(current)}` };
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
