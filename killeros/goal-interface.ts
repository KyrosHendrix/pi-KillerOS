import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedText } from "./bounded-text.ts";
import { formatTime, formatTokens } from "./display.ts";
import { reportError } from "./errors.ts";
import { parseGoalCommand } from "./goal-command.ts";
import { GOAL_ENTRY_TYPE, GOAL_UPDATE_TOOL, isGoalModeSupported, isSavedSession, pauseGoalAfterFailure, persistGoalState, scheduleGoalContinuation, stopGoalRun, sumGoalTokens, syncGoalUpdateTool, transitionGoal, type GoalEntryData } from "./goal-runtime.ts";
import { checkpointPausedGoalState, createNewGoalState, DEFAULT_GOAL_MAX_TURNS, GOAL_EVIDENCE_LIMIT, GOAL_MAX_TURNS, goalElapsedMilliseconds, GOAL_VERSION, inferGoalVerification, normalizeGoalText, parseGoalState, recordGoalDecision, transitionGoalState, verifyGoalDeliverable } from "./goal-state.ts";
import type { GoalRuntime, GoalState, GoalStatus } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

const GoalUpdateParams = Type.Object({
  status: StringEnum(["complete", "continue", "blocked"] as const, {
    description: "Record exactly one active-goal decision: complete, continue, or blocked",
  }),
  evidence: Type.String({
    minLength: 1,
    maxLength: GOAL_EVIDENCE_LIMIT,
    description: "Concrete current-turn evidence for completion, progress, or the repeated blocker",
  }),
  nextAction: Type.Optional(Type.String({
    minLength: 1,
    maxLength: GOAL_EVIDENCE_LIMIT,
    description: "One concrete action toward the unchanged objective when status is continue",
  })),
  blockerKey: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 120,
    pattern: "^[a-z0-9][a-z0-9._-]{0,119}$",
    description: "Stable lowercase key identifying the repeated blocker",
  })),
});

interface GoalUpdateDetails {
  status: "complete" | "continue" | "blocked" | "blocker-audit";
  evidence: string;
  nextAction?: string;
  verification?: "file" | "model-reported";
  blockerKey?: string;
  streak?: number;
}

function goalStatusLabel(status: GoalStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function goalPanelActions(status: GoalStatus): Array<{ label: string; control: "pause" | "resume" | "clear" }> {
  if (status === "active") return [{ label: "Pause automatic continuation", control: "pause" }, { label: "Clear goal", control: "clear" }];
  if (status === "paused" || status === "blocked") {
    return [{ label: "Resume automatic continuation", control: "resume" }, { label: "Clear goal", control: "clear" }];
  }
  return [{ label: "Clear goal", control: "clear" }];
}

function goalStatusSummary(state: GoalState, ctx: ExtensionContext): string {
  const usedTokens = Math.max(0, sumGoalTokens(ctx) - state.baselineTokens);
  const turns = state.maxTurns === undefined
    ? `${state.turns} turn${state.turns === 1 ? "" : "s"}`
    : `${state.turns}/${state.maxTurns} turns`;
  const lines = [
    `Goal ${goalStatusLabel(state.status).toLowerCase()} · ${turns} · ${formatTime(goalElapsedMilliseconds(state, Date.now()))} · ${formatTokens(usedTokens)} tokens`,
    `Objective: ${state.objective}`,
    ...(state.verification === undefined ? [] : [`Deliverable: ${state.verification.path}`]),
  ];
  const decision = state.turnDecision ?? state.lastDecision;
  if (decision?.kind === "continue") {
    lines.push(`Last decision: model-reported progress on turn ${decision.turn}`);
    lines.push(`Next action: ${decision.nextAction}`);
  } else if (decision?.kind === "blocker-audit") {
    lines.push(`Last decision: blocker audit ${decision.streak}/3 on turn ${decision.turn}`);
    lines.push(`Evidence: ${decision.evidence}`);
  } else if (decision?.kind === "blocked") {
    lines.push(`Last decision: blocked on turn ${decision.turn}`);
    lines.push(`Evidence: ${decision.evidence}`);
  } else if (decision?.kind === "complete") {
    lines.push(`Completion: ${decision.verification === "file" ? `verified file ${state.verification?.path ?? "deliverable"}` : "model-reported"}`);
    lines.push(`Evidence: ${decision.evidence}`);
  }
  if (state.status === "paused") {
    const stoppedTurn = state.turns === 0 ? "before turn 1" : `on turn ${state.turns}`;
    const reason = state.stopReason ?? state.result;
    if (reason) lines.push(`Stopped ${stoppedTurn}: ${reason}`);
    if (state.stopReason === "repeated continue report" && state.lastContinueReport) {
      lines.push(`Repeated report turns: ${state.lastContinueReport.turn} and ${state.turns}`);
    }
    lines.push("No automatic continuation was started.");
  } else if (state.result && decision?.kind !== "complete" && decision?.kind !== "blocked") {
    lines.push(`Result: ${state.result}`);
  }
  return safeTerminalText(lines.join("\n"));
}

export function registerGoalInterface(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
): void {
  pi.registerEntryRenderer<GoalEntryData>(GOAL_ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data;
    if (!data || data.version !== GOAL_VERSION || data.event === "turn" || data.event === "checkpoint") return undefined;
    if (data.event === "clear" || data.state === null) return new Text(theme.fg("dim", "Goal cleared"), 0, 0);
    const state = parseGoalState(data.state);
    if (!state) return undefined;
    const icon = state.status === "active" ? "✻" : state.status === "paused" ? "Ⅱ" : state.status === "blocked" ? "!" : "✓";
    const color: ThemeColor = state.status === "active" ? "accent" : state.status === "paused" ? "warning" : state.status === "blocked" ? "error" : "success";
    const status = theme.fg(color, `${icon} Goal ${state.status}`);
    const objective = safeTerminalText(state.objective);
    if (!options.expanded) return new BoundedText(`${status}${theme.fg("dim", ` · ${objective}`)}`, 3);
    const lines = [status, theme.fg("dim", objective)];
    if (state.result) lines.push(theme.fg("muted", safeTerminalText(state.result)));
    return new BoundedText(lines.join("\n"));
  });

  pi.registerTool<typeof GoalUpdateParams, GoalUpdateDetails>({
    name: GOAL_UPDATE_TOOL,
    label: "Goal update",
    description: "Record exactly one active-goal decision: complete after verification, continue with evidence and one next action, or audit the same blocker before blocking it.",
    parameters: GoalUpdateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!isGoalModeSupported(ctx)) throw new Error("KillerOS goals require TUI or RPC mode");
      if (!isSavedSession(ctx)) throw new Error("KillerOS goals require a saved session");
      const state = runtime.state;
      if (!state || state.status !== "active") throw new Error("There is no active KillerOS goal to update");
      if (!runtime.goalTurnInFlight
        || runtime.goalTurn?.turn !== state.turns
        || runtime.goalTurn.revision !== state.revision) {
        throw new Error("A goal decision can only be recorded during an active KillerOS goal turn");
      }
      if (state.turnDecision !== undefined) {
        throw new Error("Only one goal decision may be accepted per logical goal turn");
      }
      if (params.status !== "complete" && params.status !== "continue" && params.status !== "blocked") {
        throw new Error("Goal update status is invalid");
      }
      if (typeof params.evidence !== "string") throw new Error("Goal evidence must be text");
      const evidence = normalizeGoalText(params.evidence, GOAL_EVIDENCE_LIMIT, "Goal evidence");

      if (params.status === "complete") {
        if (state.verification) await verifyGoalDeliverable(state.verification);
        signal?.throwIfAborted();
        if (runtime.state !== state
          || runtime.goalTurn?.turn !== state.turns
          || runtime.goalTurn.revision !== state.revision
          || state.turnDecision !== undefined
          || !runtime.goalTurnInFlight) throw new Error("Goal changed while completion was being verified");
        const verification: "file" | "model-reported" = state.verification ? "file" : "model-reported";
        const decision = { kind: "complete" as const, turn: state.turns, evidence, verification };
        try {
          transitionGoal(pi, runtime, "complete", "complete", evidence, { resetBlockedAudit: true, decision });
        } catch (error) {
          pauseGoalAfterFailure(pi, runtime, ctx, `goal completion could not be saved: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        const text = state.verification
          ? `Goal verified complete at ${safeTerminalText(state.verification.path)}: ${evidence}`
          : `Goal marked complete (model-reported): ${evidence}`;
        return {
          content: [{ type: "text", text }],
          details: { status: "complete", evidence, verification },
        };
      }

      if (params.status === "continue") {
        if (typeof params.nextAction !== "string") throw new Error("A continue decision requires a nextAction");
        const nextAction = normalizeGoalText(params.nextAction, GOAL_EVIDENCE_LIMIT, "Goal nextAction");
        const previous = state.lastContinueReport;
        if (previous?.turn === state.turns - 1
          && previous.evidence === evidence
          && previous.nextAction === nextAction) {
          pauseGoalAfterFailure(pi, runtime, ctx, "repeated continue report", "Run /goal resume only after choosing a different next action.", false);
          ctx.ui.notify(
            `Goal paused: repeated continue report on turns ${previous.turn} and ${state.turns}\nRun /goal resume only after choosing a different next action.`,
            "error",
          );
          throw new Error("repeated continue report");
        }
        const decision = { kind: "continue" as const, turn: state.turns, evidence, nextAction };
        try {
          const next = recordGoalDecision(state, decision, Date.now());
          persistGoalState(pi, runtime, "continue", next);
          runtime.goalTurn = { turn: next.turns, revision: next.revision };
        } catch (error) {
          pauseGoalAfterFailure(pi, runtime, ctx, `goal decision could not be saved: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        return {
          content: [{ type: "text", text: `Model-reported progress recorded; the goal remains active: ${evidence}` }],
          details: { status: "continue", evidence, nextAction },
        };
      }

      const blockerKey = params.blockerKey;
      if (!blockerKey || !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(blockerKey)) {
        throw new Error("A blocked goal update requires a stable lowercase blockerKey");
      }
      const previous = state.blockerAudit;
      if (previous?.lastTurn === state.turns) {
        throw new Error("Only one goal decision may be accepted per logical goal turn");
      }
      const consecutive = previous?.key === blockerKey && previous.lastTurn === state.turns - 1;
      const streak = consecutive ? previous.streak + 1 : 1;
      const blockerAudit = { key: blockerKey, streak, lastTurn: state.turns, evidence };
      if (streak < 3) {
        const decision = { kind: "blocker-audit" as const, turn: state.turns, blockerKey, streak, evidence };
        try {
          const next = {
            ...recordGoalDecision(state, decision, Date.now()),
            blockerAudit,
          };
          persistGoalState(pi, runtime, "blocker-audit", next);
          runtime.goalTurn = { turn: next.turns, revision: next.revision };
        } catch (error) {
          pauseGoalAfterFailure(pi, runtime, ctx, `blocker decision could not be saved: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        return {
          content: [{ type: "text", text: `Blocker audit ${streak}/3 recorded; the goal remains active: ${evidence}` }],
          details: { status: "blocker-audit", evidence, blockerKey, streak },
        };
      }
      const decision = { kind: "blocked" as const, turn: state.turns, blockerKey, streak: 3 as const, evidence };
      try {
        transitionGoal(pi, runtime, "blocked", "blocked", evidence, { blockerAudit, decision });
      } catch (error) {
        pauseGoalAfterFailure(pi, runtime, ctx, `blocked decision could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
      return {
        content: [{ type: "text", text: `Goal marked blocked: ${evidence}` }],
        details: { status: "blocked", evidence, blockerKey, streak },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("goal "))}${theme.fg("muted", safeTerminalText(args.status))}`, 0, 0);
    },
    renderResult(result, options, theme, context) {
      if (context?.isError) {
        const first = result.content[0];
        const message = first?.type === "text" ? safeTerminalText(first.text) : "Goal update failed";
        return new BoundedText(theme.fg("error", message), options.expanded ? undefined : 3);
      }
      const details = result.details;
      if (!details) return new BoundedText(theme.fg("dim", "Goal updated"));
      const label = details.status === "complete"
        ? "✓ Complete"
        : details.status === "blocked"
          ? "! Blocked"
          : details.status === "continue"
            ? "→ Progress recorded"
            : `! Blocker audit ${details.streak}/3`;
      const text = `${theme.fg(details.status === "complete" ? "success" : "warning", label)}${theme.fg("dim", ` · ${safeTerminalText(details.evidence)}`)}`;
      return new BoundedText(text, options.expanded ? undefined : 3);
    },
  });
  syncGoalUpdateTool(pi, runtime);
  const handleGoalCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const command = parseGoalCommand(args);
      if (ctx.mode === "print" || ctx.mode === "json") {
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

      if (command.kind === "status") {
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
        const action = actions.find((candidate) => candidate.label === selected);
        if (!action) return;
        if (action.control === "clear" && !await ctx.ui.confirm("Clear goal?", safeTerminalText(runtime.state.objective))) return;
        await handleGoalCommand(action.control, ctx);
        return;
      }

      if (command.kind === "clear") {
        if (!runtime.state) {
          ctx.ui.notify("No goal is set", "info");
          return;
        }
        const shouldStopGoalRun = runtime.goalTurnInFlight || runtime.continuationScheduled;
        let saved = false;
        try {
          persistGoalState(pi, runtime, "clear", undefined);
          saved = true;
        } catch (error) {
          if (runtime.state?.status === "active") {
            pauseGoalAfterFailure(
              pi,
              runtime,
              ctx,
              `the requested clear could not be saved: ${error instanceof Error ? error.message : String(error)}`,
              "Automatic continuation is stopped. Retry /goal clear to remove the goal.",
              false,
            );
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
          ctx.ui.notify("Goal cleared", "info");
        } else {
          ctx.ui.notify("Goal paused: the requested clear could not be saved\nAutomatic continuation is stopped. Retry /goal clear to remove the goal.", "error");
        }
        return;
      }

      if (command.kind === "pause") {
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
            runtime.state = checkpoint;
            syncGoalUpdateTool(pi, runtime);
            runtime.persistenceRetryNeeded = true;
            runtime.continuationScheduled = false;
            runtime.requestRender?.();
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
          failureReason = safeTerminalText(`the requested pause could not be saved: ${error instanceof Error ? error.message : String(error)}`);
          pauseGoalAfterFailure(
            pi,
            runtime,
            ctx,
            failureReason,
            "Automatic continuation is stopped. If session storage is still unavailable, retry /goal pause after it recovers.",
            false,
          );
        }
        try {
          await stopGoalRun(runtime, ctx, shouldStopGoalRun);
        } catch (error) {
          reportError(ctx, "Goal paused, but the active goal turn could not be confirmed stopped", error);
          return;
        }
        if (saved) {
          ctx.ui.notify("Goal paused. Run /goal resume to continue.", "info");
        } else {
          ctx.ui.notify(`Goal paused: ${failureReason}\nAutomatic continuation is stopped. If session storage is still unavailable, retry /goal pause after it recovers.`, "error");
        }
        return;
      }

      if (command.kind === "resume") {
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
        if (currentMax !== undefined && runtime.state.turns >= currentMax) {
          if (runtime.state.turns >= GOAL_MAX_TURNS) {
            ctx.ui.notify(`Goal reached the lifetime limit (${runtime.state.turns}/${GOAL_MAX_TURNS}). Set a new objective.`, "warning");
            return;
          }
          const renewed = Math.min(Math.max(currentMax, runtime.state.turns) + DEFAULT_GOAL_MAX_TURNS, GOAL_MAX_TURNS);
          try {
            const base = transitionGoalState(runtime.state, "active", undefined, { resetBlockedAudit: true }, Date.now());
            persistGoalState(pi, runtime, "resume", { ...base, maxTurns: renewed });
            runtime.continuationScheduled = false;
            if (scheduleGoalContinuation(pi, runtime, ctx)) ctx.ui.notify("Goal resumed", "info");
          } catch (error) {
            reportError(ctx, "Goal could not be resumed", error);
          }
          return;
        }
        try {
          transitionGoal(pi, runtime, "resume", "active", undefined, { resetBlockedAudit: true });
          runtime.continuationScheduled = false;
          if (scheduleGoalContinuation(pi, runtime, ctx)) ctx.ui.notify("Goal resumed", "info");
        } catch (error) {
          reportError(ctx, "Goal could not be resumed", error);
        }
        return;
      }

      switch (command.kind) {
        case "objective":
          break;
        default: {
          const unhandled: never = command;
          return unhandled;
        }
      }
      const objective = command.objective;

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
        scheduleGoalContinuation(pi, runtime, ctx);
        return;
      }
      let verification: Awaited<ReturnType<typeof inferGoalVerification>>;
      try {
        verification = await inferGoalVerification(objective, ctx.cwd);
      } catch (error) {
        if (!unfinished) {
          reportError(ctx, "Goal could not be started", error);
        } else {
          reportError(ctx, "Goal could not be replaced", error);
          scheduleGoalContinuation(pi, runtime, ctx);
        }
        return;
      }
      try {
        const state = createNewGoalState(objective, sumGoalTokens(ctx), verification, Date.now(), {
          maxTurns: DEFAULT_GOAL_MAX_TURNS,
        });
        persistGoalState(pi, runtime, unfinished ? "replace" : "set", state);
        // The replacement supersedes any recovery still parked after waitForIdle().
        if (unfinished) runtime.automaticCompaction = undefined;
        if (scheduleGoalContinuation(pi, runtime, ctx)) {
          ctx.ui.notify("Goal active. Each turn must record continue, complete, or a blocker decision before another turn starts.", "info");
        }
      } catch (error) {
        if (!unfinished) {
          reportError(ctx, "Goal could not be started", error);
        } else if (runtime.state?.status === "active") {
          pauseGoalAfterFailure(
            pi,
            runtime,
            ctx,
            `Goal could not be replaced: ${error instanceof Error ? error.message : String(error)}`,
            "Automatic continuation is stopped. Retry replacement after session storage recovers.",
          );
        } else {
          reportError(ctx, "Goal could not be replaced", error);
        }
      }
  };

  pi.registerCommand("goal", {
    description: "Set a non-command objective or view the current goal",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      const actions = [
        { value: "clear", description: "Remove the current goal" },
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
