import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedText } from "./bounded-text.ts";
import { formatTime, formatTokens } from "./display.ts";
import { reportError } from "./errors.ts";
import { parseGoalCommand } from "./goal-command.ts";
import { GOAL_ENTRY_TYPE, GOAL_UPDATE_TOOL, isGoalModeSupported, isSavedSession, pauseGoalAfterFailure, persistGoalState, scheduleGoalContinuation, stopGoalRun, sumGoalTokens, syncGoalUpdateTool, transitionGoal, type GoalEntryData } from "./goal-runtime.ts";
import { checkpointPausedGoalState, createNewGoalState, DEFAULT_GOAL_MAX_TURNS, GOAL_MAX_TURNS, goalElapsedMilliseconds, GOAL_VERSION, inferGoalVerification, parseGoalState, recordGoalBlockerAudit, transitionGoalState, verifyGoalDeliverable } from "./goal-state.ts";
import type { GoalRuntime, GoalState, GoalStatus, InitRuntime } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

const GoalUpdateParams = Type.Object({
  status: StringEnum(["complete", "blocked"] as const, {
    description: "Mark the active goal complete or blocked",
  }),
  evidence: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: "Concise evidence that the objective is complete, or the repeated blocker and attempted workarounds",
  }),
  blockerKey: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 120,
    pattern: "^[a-z0-9][a-z0-9._-]{0,119}$",
    description: "Stable lowercase key identifying the repeated blocker",
  })),
});

interface GoalUpdateDetails {
  status: "complete" | "blocked" | "blocker-audit";
  evidence: string;
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
    ...(state.verification === undefined ? [] : [`Deliverable: ${state.verification.path}`]),
    state.objective,
  ];
  if (state.result) lines.push(state.result);
  return safeTerminalText(lines.join("\n"));
}

export function registerGoalInterface(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
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
    description: "Mark the active KillerOS long-running goal complete after verification, or record the same blocker key on three consecutive goal turns before blocking it.",
    parameters: GoalUpdateParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!isGoalModeSupported(ctx)) throw new Error("KillerOS goals require TUI or RPC mode");
      if (!isSavedSession(ctx)) throw new Error("KillerOS goals require a saved session");
      const state = runtime.state;
      if (!state || state.status !== "active") throw new Error("There is no active KillerOS goal to update");
      const evidence = params.evidence.trim();
      if (!evidence) throw new Error("Goal evidence must not be empty");
      if (params.status === "complete") {
        if (state.verification) await verifyGoalDeliverable(state.verification);
        if (runtime.state !== state) throw new Error("Goal changed while completion was being verified");
        const verification = state.verification ? "file" : "model-reported";
        transitionGoal(pi, runtime, "complete", "complete", evidence, { resetBlockedAudit: true });
        const safeEvidence = safeTerminalText(evidence);
        const text = state.verification
          ? `Goal verified complete at ${safeTerminalText(state.verification.path)}: ${safeEvidence}`
          : `Goal marked complete (model-reported): ${safeEvidence}`;
        return {
          content: [{ type: "text", text }],
          details: { status: "complete", evidence, verification },
        };
      }
      if (!runtime.goalTurnInFlight) throw new Error("A blocker audit can only be recorded during an active KillerOS goal turn");
      const blockerKey = params.blockerKey;
      if (!blockerKey || !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(blockerKey)) {
        throw new Error("A blocked goal update requires a stable lowercase blockerKey");
      }
      const previous = state.blockerAudit;
      const sameTurn = previous?.key === blockerKey && previous.lastTurn === state.turns;
      const consecutive = previous?.key === blockerKey && previous.lastTurn === state.turns - 1;
      const streak = sameTurn ? previous.streak : consecutive ? previous.streak + 1 : 1;
      const blockerAudit = { key: blockerKey, streak, lastTurn: state.turns, evidence };
      if (streak < 3) {
        const next = recordGoalBlockerAudit(state, blockerAudit, Date.now());
        persistGoalState(pi, runtime, "blocker-audit", next);
        return {
          content: [{ type: "text", text: `Blocker audit ${streak}/3 recorded; the goal remains active: ${evidence}` }],
          details: { status: "blocker-audit", evidence, blockerKey, streak },
        };
      }
      transitionGoal(pi, runtime, "blocked", "blocked", evidence, { blockerAudit });
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
      const label = details.status === "complete" ? "✓ Complete" : details.status === "blocked" ? "! Blocked" : `! Blocker audit ${details.streak}/3`;
      const text = `${theme.fg(details.status === "complete" ? "success" : "warning", label)}${theme.fg("dim", ` · ${safeTerminalText(details.evidence)}`)}`;
      return new BoundedText(text, options.expanded ? undefined : 3);
    },
  });
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
        if (initState.active) {
          ctx.ui.notify("Wait for /init to finish before resuming a goal", "error");
          return;
        }
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
            if (scheduleGoalContinuation(pi, runtime, initState, ctx)) ctx.ui.notify("Goal resumed", "info");
          } catch (error) {
            reportError(ctx, "Goal could not be resumed", error);
          }
          return;
        }
        try {
          transitionGoal(pi, runtime, "resume", "active", undefined, { resetBlockedAudit: true });
          runtime.continuationScheduled = false;
          if (scheduleGoalContinuation(pi, runtime, initState, ctx)) ctx.ui.notify("Goal resumed", "info");
        } catch (error) {
          reportError(ctx, "Goal could not be resumed", error);
        }
        return;
      }

      if (initState.active) {
        ctx.ui.notify("Wait for /init to finish before starting a goal", "error");
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
        scheduleGoalContinuation(pi, runtime, initState, ctx);
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
          scheduleGoalContinuation(pi, runtime, initState, ctx);
        }
        return;
      }
      try {
        const state = createNewGoalState(objective, sumGoalTokens(ctx), verification, Date.now(), {
          maxTurns: DEFAULT_GOAL_MAX_TURNS,
        });
        persistGoalState(pi, runtime, unfinished ? "replace" : "set", state);
        if (scheduleGoalContinuation(pi, runtime, initState, ctx)) {
          ctx.ui.notify("Goal active. KillerOS will continue until completion, a repeated blocker, or pause.", "info");
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
