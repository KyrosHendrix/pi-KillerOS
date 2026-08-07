import { type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MAX_NODE_TIMER_MS } from "./limits.ts";
import { CONCISE_SYSTEM_PROMPT } from "./concise.ts";
import { formatTime, formatTokens } from "./display.ts";
import { reportError } from "./errors.ts";
import { resolvePersonalInstructions } from "./personal-instructions.ts";
import type { CompactionRuntime, GoalRuntime, GoalState, GoalStatus, InitRuntime } from "./runtime.ts";

const GOAL_ENTRY_TYPE = "killeros-goal";
const GOAL_CONTINUATION_TYPE = "killeros-goal-continuation";
const GOAL_OBJECTIVE_LIMIT = 4_000;
const GOAL_VERSION = 1;

type GoalEntryEvent = "set" | "replace" | "edit" | "turn" | "pause" | "resume" | "blocked" | "complete" | "error" | "clear" | "checkpoint";
interface GoalEntryData {
  version: 1;
  event: GoalEntryEvent;
  state: GoalState | null;
}

const GoalUpdateParams = Type.Object({
  status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
    description: "Mark the active goal complete or blocked",
  }),
  evidence: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "Concise evidence that the objective is complete, or the repeated blocker and attempted workarounds",
  }),
});

interface GoalUpdateDetails {
  status: "complete" | "blocked";
  evidence: string;
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseGoalState(value: unknown): GoalState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<GoalState>;
  if (candidate.version !== GOAL_VERSION
    || !Number.isInteger(candidate.revision) || (candidate.revision ?? 0) < 1
    || typeof candidate.objective !== "string" || !candidate.objective.trim()
    || [...candidate.objective].length > GOAL_OBJECTIVE_LIMIT
    || !isGoalStatus(candidate.status)
    || !finiteNonNegative(candidate.createdAt)
    || !finiteNonNegative(candidate.updatedAt)
    || !finiteNonNegative(candidate.activeMilliseconds)
    || !Number.isInteger(candidate.turns) || (candidate.turns ?? -1) < 0
    || candidate.blockedAuditStartTurn !== undefined
      && (!Number.isInteger(candidate.blockedAuditStartTurn) || candidate.blockedAuditStartTurn < 0 || candidate.blockedAuditStartTurn > candidate.turns!)
    || !finiteNonNegative(candidate.baselineTokens)
    || candidate.activeStartedAt !== undefined && !finiteNonNegative(candidate.activeStartedAt)
    || candidate.result !== undefined && typeof candidate.result !== "string") {
    return undefined;
  }
  return {
    version: GOAL_VERSION,
    revision: candidate.revision!,
    objective: candidate.objective.trim(),
    status: candidate.status,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    activeMilliseconds: candidate.activeMilliseconds,
    activeStartedAt: candidate.activeStartedAt,
    turns: candidate.turns!,
    blockedAuditStartTurn: candidate.blockedAuditStartTurn ?? 0,
    baselineTokens: candidate.baselineTokens,
    result: candidate.result,
  };
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
    const data = entry.data as Partial<GoalEntryData> | undefined;
    if (!data || data.version !== GOAL_VERSION) return undefined;
    if (data.state === null) return undefined;
    const restored = parseGoalState(data.state);
    if (!restored) return undefined;
    return restored.status === "active"
      ? { ...restored, activeStartedAt: Date.now() }
      : { ...restored, activeStartedAt: undefined };
  }
  return undefined;
}

export function goalElapsedMilliseconds(state: GoalState, now = Date.now()): number {
  const activeInterval = state.status === "active" && state.activeStartedAt !== undefined
    ? Math.max(0, now - state.activeStartedAt)
    : 0;
  return state.activeMilliseconds + activeInterval;
}

function stopGoalClock(state: GoalState, now: number): GoalState {
  if (state.status !== "active" || state.activeStartedAt === undefined) return state;
  return {
    ...state,
    activeMilliseconds: state.activeMilliseconds + Math.max(0, now - state.activeStartedAt),
    activeStartedAt: undefined,
  };
}

function sumGoalTokens(ctx: ExtensionContext): number {
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

function persistGoalState(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalEntryEvent,
  state: GoalState | undefined,
): void {
  const data: GoalEntryData = { version: GOAL_VERSION, event, state: state ?? null };
  pi.appendEntry(GOAL_ENTRY_TYPE, data);
  runtime.state = state;
  runtime.persistenceRetryNeeded = false;
  runtime.requestRender?.();
}

function transitionGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalEntryEvent,
  status: GoalStatus,
  result?: string,
  resetBlockedAudit = false,
): GoalState {
  const current = runtime.state;
  if (!current) throw new Error("No goal is set");
  const now = Date.now();
  const stopped = stopGoalClock(current, now);
  const next: GoalState = {
    ...stopped,
    revision: stopped.revision + 1,
    status,
    updatedAt: now,
    activeStartedAt: status === "active" ? now : undefined,
    blockedAuditStartTurn: resetBlockedAudit ? stopped.turns : stopped.blockedAuditStartTurn,
    result,
  };
  persistGoalState(pi, runtime, event, next);
  if (status !== "active") runtime.continuationScheduled = false;
  return next;
}

function goalStatusLabel(status: GoalStatus): string {
  return `${status.charAt(0).toLocaleUpperCase()}${status.slice(1)}`;
}

function goalStatusSummary(state: GoalState, ctx: ExtensionContext): string {
  const usedTokens = Math.max(0, sumGoalTokens(ctx) - state.baselineTokens);
  const lines = [
    `Goal ${goalStatusLabel(state.status).toLocaleLowerCase()} · ${state.turns} turn${state.turns === 1 ? "" : "s"} · ${formatTime(goalElapsedMilliseconds(state))} · ${formatTokens(usedTokens)} tokens`,
    state.objective,
  ];
  if (state.result) lines.push(state.result);
  return lines.join("\n");
}

export function pauseGoalAfterFailure(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
  recoveryInstruction = "Run /goal resume after resolving the problem.",
): void {
  if (runtime.state?.status !== "active") return;
  try {
    transitionGoal(pi, runtime, "error", "paused", reason);
  } catch {
    runtime.state = runtime.state ? { ...stopGoalClock(runtime.state, Date.now()), status: "paused", result: reason } : undefined;
    runtime.persistenceRetryNeeded = true;
    runtime.continuationScheduled = false;
    runtime.requestRender?.();
  }
  ctx.ui.notify(`Goal paused: ${reason}\n${recoveryInstruction}`, "error");
}

function scheduleGoalContinuation(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): boolean {
  if (!isGoalModeSupported(ctx)
    || !isSavedSession(ctx)
    || runtime.state?.status !== "active"
    || runtime.continuationScheduled
    || runtime.continuationHeld
    || runtime.goalTurnInFlight
    || initState.active
    || ctx.hasPendingMessages()) return false;
  const current = runtime.state;
  runtime.continuationScheduled = true;
  runtime.goalTurnInFlight = false;
  runtime.agentEndObserved = false;
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
  try {
    pi.sendMessage({
      customType: GOAL_CONTINUATION_TYPE,
      content: goalContinuationMessage(current, ctx),
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
    "Continue making concrete progress toward this unchanged objective. Re-check repository state and prior results instead of repeating work.",
    "Do not stop merely because one response is complete: KillerOS will start another goal turn while the goal remains active.",
    "Before declaring completion, audit every part of the objective and verify the relevant results. Then call killeros_goal_update with status complete and concise evidence.",
    "Call killeros_goal_update with status blocked only when the same external impasse has prevented progress for three consecutive goal turns; name the blocker and attempted workarounds.",
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
      sections.push(`<personal_instructions source=${JSON.stringify(personal.source)}>\n${personal.content}\n</personal_instructions>`);
    }
  }
  sections.push(CONCISE_SYSTEM_PROMPT);
  return sections.join("\n\n");
}

function isGoalModeSupported(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

function isSavedSession(ctx: ExtensionContext): boolean {
  try {
    return Boolean(ctx.sessionManager.getSessionFile());
  } catch {
    return false;
  }
}

function validateGoalObjective(input: string): string | undefined {
  const objective = input.trim();
  if (!objective) return undefined;
  return [...objective].length <= GOAL_OBJECTIVE_LIMIT ? objective : undefined;
}

export function registerGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
): void {
  pi.registerEntryRenderer<GoalEntryData>(GOAL_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data;
    if (!data || data.version !== GOAL_VERSION || data.event === "turn" || data.event === "checkpoint") return undefined;
    if (data.event === "clear" || data.state === null) return new Text(theme.fg("dim", "Goal cleared"), 0, 0);
    const state = parseGoalState(data.state);
    if (!state) return undefined;
    const icon = state.status === "active" ? "✻" : state.status === "paused" ? "Ⅱ" : state.status === "blocked" ? "!" : "✓";
    const color: ThemeColor = state.status === "active" ? "accent" : state.status === "paused" ? "warning" : state.status === "blocked" ? "error" : "success";
    return new Text(`${theme.fg(color, `${icon} Goal ${state.status}`)}${theme.fg("dim", ` · ${state.objective}`)}`, 0, 0);
  });

  pi.registerTool<typeof GoalUpdateParams, GoalUpdateDetails>({
    name: "killeros_goal_update",
    label: "Goal update",
    description: "Mark the active KillerOS long-running goal complete after verification, or blocked after the same impasse persists for three consecutive goal turns.",
    parameters: GoalUpdateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isGoalModeSupported(ctx)) throw new Error("KillerOS goals require TUI or RPC mode");
      if (!isSavedSession(ctx)) throw new Error("KillerOS goals require a saved session");
      const state = runtime.state;
      if (!state || state.status !== "active") throw new Error("There is no active KillerOS goal to update");
      const evidence = params.evidence.trim();
      if (!evidence) throw new Error("Goal evidence must not be empty");
      if (params.status === "blocked" && state.turns - state.blockedAuditStartTurn < 3) {
        throw new Error("A goal cannot be marked blocked before three goal turns in the current audit; keep working and audit the same blocker again");
      }
      transitionGoal(pi, runtime, params.status, params.status, evidence);
      return {
        content: [{ type: "text", text: `Goal marked ${params.status}: ${evidence}` }],
        details: { status: params.status, evidence },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal "))}${theme.fg("muted", args.status)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details;
      return new Text(details
        ? `${theme.fg(details.status === "complete" ? "success" : "warning", details.status === "complete" ? "✓ Complete" : "! Blocked")}${theme.fg("dim", ` · ${details.evidence}`)}`
        : theme.fg("dim", "Goal updated"), 0, 0);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime.state = restoreGoalState(ctx);
    runtime.continuationScheduled = false;
    runtime.continuationHeld = false;
    runtime.continuationHeldForCompaction = false;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.persistenceRetryNeeded = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    runtime.requestRender?.();
    if (runtime.state?.status === "active") {
      setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    runtime.state = restoreGoalState(ctx);
    runtime.continuationScheduled = false;
    runtime.continuationHeld = false;
    runtime.continuationHeldForCompaction = false;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.persistenceRetryNeeded = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    runtime.requestRender?.();
    if (runtime.state?.status === "active") {
      setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (runtime.state?.status === "active") {
      const now = Date.now();
      const checkpoint: GoalState = {
        ...stopGoalClock(runtime.state, now),
        revision: runtime.state.revision + 1,
        updatedAt: now,
      };
      try {
        persistGoalState(pi, runtime, "checkpoint", checkpoint);
      } catch (error) {
        reportError(ctx, "Goal state could not be checkpointed", error);
      }
    }
    runtime.state = undefined;
    runtime.continuationScheduled = false;
    runtime.continuationHeld = false;
    runtime.continuationHeldForCompaction = false;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.persistenceRetryNeeded = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.continuationScheduled = false;
    const current = runtime.state;
    if (!isGoalModeSupported(ctx) || !isSavedSession(ctx) || !current || current.status !== "active" || initState.active) return;
    if (runtime.goalTurnInFlight) return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(current)}` };
    const now = Date.now();
    const next: GoalState = {
      ...current,
      revision: current.revision + 1,
      turns: current.turns + 1,
      updatedAt: now,
      activeStartedAt: current.activeStartedAt ?? now,
    };
    try {
      persistGoalState(pi, runtime, "turn", next);
    } catch (error) {
      pauseGoalAfterFailure(pi, runtime, ctx, `turn state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    runtime.goalTurnInFlight = true;
    runtime.agentEndObserved = false;
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(next)}` };
  });

  pi.on("agent_end", (event) => {
    if (!runtime.goalTurnInFlight) return;
    const finalAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    runtime.agentEndObserved = finalAssistant !== undefined;
    runtime.lastStopReason = finalAssistant?.stopReason;
    runtime.lastError = finalAssistant?.errorMessage;
  });

  pi.registerCommand("goal", {
    description: "Set or view the goal for a long-running task",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLocaleLowerCase();
      if (normalized.includes(" ")) return null;
      const actions = [
        { value: "clear", description: "Remove the current goal" },
        { value: "edit", description: "Edit and reactivate the current goal" },
        { value: "pause", description: "Stop automatic continuation" },
        { value: "resume", description: "Resume automatic continuation" },
      ];
      return actions
        .filter((action) => action.value.startsWith(normalized))
        .map((action) => ({ ...action, label: action.value }));
    },
    handler: async (args, ctx) => {
      if (ctx.mode === "print" || ctx.mode === "json") {
        ctx.ui.notify("/goal requires TUI or RPC mode", "error");
        return;
      }
      if (!isSavedSession(ctx)) {
        ctx.ui.notify("/goal requires a saved session", "error");
        return;
      }
      const input = args.trim();
      const control = input.toLocaleLowerCase();
      const isControl = control === "clear" || control === "edit" || control === "pause" || control === "resume";

      if (!input) {
        if (!runtime.state) {
          ctx.ui.notify("No goal is set. Use /goal <objective> to start a long-running task.", "info");
          return;
        }
        ctx.ui.notify(goalStatusSummary(runtime.state, ctx), "info");
        return;
      }

      if (control === "clear") {
        if (!runtime.state) {
          ctx.ui.notify("No goal is set", "info");
          return;
        }
        try {
          persistGoalState(pi, runtime, "clear", undefined);
          runtime.continuationScheduled = false;
          ctx.ui.notify("Goal cleared", "info");
        } catch (error) {
          if (runtime.state?.status === "active") {
            pauseGoalAfterFailure(
              pi,
              runtime,
              ctx,
              `the requested clear could not be saved: ${error instanceof Error ? error.message : String(error)}`,
              "Automatic continuation is stopped. Retry /goal clear to remove the goal.",
            );
          } else {
            reportError(ctx, "Goal could not be cleared", error);
          }
        }
        return;
      }

      if (control === "pause") {
        if (!runtime.state) {
          ctx.ui.notify("No goal is set", "info");
          return;
        }
        if (runtime.state.status === "paused") {
          if (!runtime.persistenceRetryNeeded) {
            ctx.ui.notify("Goal is already paused", "info");
            return;
          }
          const now = Date.now();
          const checkpoint: GoalState = {
            ...runtime.state,
            revision: runtime.state.revision + 1,
            updatedAt: now,
          };
          try {
            persistGoalState(pi, runtime, "pause", checkpoint);
            ctx.ui.notify("Goal pause saved", "info");
          } catch (error) {
            reportError(ctx, "Goal pause still could not be saved", error);
          }
          return;
        }
        if (runtime.state.status !== "active") {
          ctx.ui.notify(`Goal is ${runtime.state.status}; only an active goal can be paused`, "warning");
          return;
        }
        try {
          transitionGoal(pi, runtime, "pause", "paused");
          ctx.ui.notify("Goal paused. Run /goal resume to continue.", "info");
        } catch (error) {
          pauseGoalAfterFailure(
            pi,
            runtime,
            ctx,
            `the requested pause could not be saved: ${error instanceof Error ? error.message : String(error)}`,
            "Automatic continuation is stopped. If session storage is still unavailable, retry /goal pause after it recovers.",
          );
        }
        return;
      }

      if (control === "resume") {
        if (initState.active) {
          ctx.ui.notify("Wait for /init to finish before resuming a goal", "error");
          return;
        }
        if (!runtime.state) {
          ctx.ui.notify("No goal is set", "info");
          return;
        }
        if (runtime.state.status === "active") {
          ctx.ui.notify("Goal is already active", "info");
          return;
        }
        if (runtime.state.status === "complete") {
          ctx.ui.notify("The goal is complete. Set a new objective or use /goal edit.", "info");
          return;
        }
        try {
          transitionGoal(pi, runtime, "resume", "active", undefined, true);
          runtime.continuationScheduled = false;
          if (scheduleGoalContinuation(pi, runtime, initState, ctx)) ctx.ui.notify("Goal resumed", "info");
        } catch (error) {
          reportError(ctx, "Goal could not be resumed", error);
        }
        return;
      }

      if (control === "edit") {
        if (initState.active) {
          ctx.ui.notify("Wait for /init to finish before editing a goal", "error");
          return;
        }
        if (!runtime.state) {
          ctx.ui.notify("No goal is set", "info");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/goal edit requires interactive TUI mode", "error");
          return;
        }
        runtime.continuationHeld = true;
        let waitError: unknown;
        try {
          await ctx.waitForIdle();
        } catch (error) {
          waitError = error;
        } finally {
          runtime.continuationHeld = false;
        }
        if (waitError) {
          reportError(ctx, "Goal could not wait for the active turn", waitError);
          scheduleGoalContinuation(pi, runtime, initState, ctx);
          return;
        }
        const edited = await ctx.ui.editor("Edit long-running goal", runtime.state.objective);
        if (edited === undefined) {
          scheduleGoalContinuation(pi, runtime, initState, ctx);
          return;
        }
        const objective = validateGoalObjective(edited);
        if (!objective) {
          ctx.ui.notify(edited.trim() ? "A goal objective may not exceed 4,000 characters" : "A goal objective may not be empty", "error");
          scheduleGoalContinuation(pi, runtime, initState, ctx);
          return;
        }
        const now = Date.now();
        const current = stopGoalClock(runtime.state, now);
        const next: GoalState = {
          ...current,
          revision: current.revision + 1,
          objective,
          status: "active",
          updatedAt: now,
          activeStartedAt: now,
          blockedAuditStartTurn: current.turns,
          result: undefined,
        };
        try {
          persistGoalState(pi, runtime, "edit", next);
          runtime.continuationScheduled = false;
          if (scheduleGoalContinuation(pi, runtime, initState, ctx)) ctx.ui.notify("Goal updated and active", "info");
        } catch (error) {
          pauseGoalAfterFailure(
            pi,
            runtime,
            ctx,
            `Goal could not be edited: ${error instanceof Error ? error.message : String(error)}`,
            "Automatic continuation is stopped. Retry /goal edit after session storage recovers.",
          );
        }
        return;
      }

      if (isControl) return;
      if (initState.active) {
        ctx.ui.notify("Wait for /init to finish before starting a goal", "error");
        return;
      }
      const objective = validateGoalObjective(input);
      if (!objective) {
        ctx.ui.notify(input ? "A goal objective may not exceed 4,000 characters" : "A goal objective may not be empty", "error");
        return;
      }

      const unfinished = runtime.state && runtime.state.status !== "complete";
      if (unfinished) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Clear the current goal before replacing it outside TUI mode", "error");
          return;
        }
        const replace = await ctx.ui.confirm("Replace active goal", "Replace the current unfinished goal and discard its continuation state?");
        if (!replace) return;
      }

      runtime.continuationHeld = true;
      let waitError: unknown;
      try {
        await ctx.waitForIdle();
      } catch (error) {
        waitError = error;
      } finally {
        runtime.continuationHeld = false;
      }
      if (waitError) {
        reportError(ctx, "Goal could not wait for the active turn", waitError);
        scheduleGoalContinuation(pi, runtime, initState, ctx);
        return;
      }
      const now = Date.now();
      const state: GoalState = {
        version: GOAL_VERSION,
        revision: 1,
        objective,
        status: "active",
        createdAt: now,
        updatedAt: now,
        activeMilliseconds: 0,
        activeStartedAt: now,
        turns: 0,
        blockedAuditStartTurn: 0,
        baselineTokens: sumGoalTokens(ctx),
      };
      try {
        persistGoalState(pi, runtime, unfinished ? "replace" : "set", state);
        if (scheduleGoalContinuation(pi, runtime, initState, ctx)) {
          ctx.ui.notify("Goal active. KillerOS will continue until completion, a repeated blocker, or pause.", "info");
        }
      } catch (error) {
        reportError(ctx, "Goal could not be started", error);
        scheduleGoalContinuation(pi, runtime, initState, ctx);
      }
    },
  });
}

export function registerGoalSettlement(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  compactionRuntime?: CompactionRuntime,
): void {
  pi.on("agent_settled", (_event, ctx) => {
    const wasGoalTurn = runtime.goalTurnInFlight;
    const continuationWasScheduled = runtime.continuationScheduled;
    const agentEndObserved = runtime.agentEndObserved;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.continuationScheduled = false;
    if (!wasGoalTurn || runtime.state?.status !== "active" || initState.active) {
      if (continuationWasScheduled && runtime.state?.status === "active" && !initState.active) {
        pauseGoalAfterFailure(pi, runtime, ctx, "the goal continuation ended before an agent turn started");
      }
      return;
    }
    if (!agentEndObserved) {
      pauseGoalAfterFailure(pi, runtime, ctx, "the goal turn ended without an agent result");
      return;
    }
    if (runtime.lastStopReason === "error" || runtime.lastStopReason === "aborted") {
      const reason = runtime.lastError || (runtime.lastStopReason === "aborted" ? "the agent turn was aborted" : "the agent turn failed");
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      pauseGoalAfterFailure(pi, runtime, ctx, reason);
      return;
    }
    if (compactionRuntime?.compactionInFlight) {
      runtime.continuationHeld = true;
      runtime.continuationHeldForCompaction = true;
      runtime.requestRender?.();
      return;
    }
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    scheduleGoalContinuation(pi, runtime, initState, ctx);
  });

  if (compactionRuntime) {
    pi.on("session_compact", (_event, ctx) => {
      if (!runtime.continuationHeldForCompaction) return;
      runtime.continuationHeldForCompaction = false;
      if (!runtime.continuationHeld || runtime.state?.status !== "active" || initState.active) {
        runtime.continuationHeld = false;
        return;
      }
      runtime.continuationHeld = false;
      setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
    });
  }
}
