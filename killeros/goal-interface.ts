import { type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedText } from "./bounded-text.ts";
import { errorMessage } from "./errors.ts";
import { isAutomationMode } from "./pi-context.ts";
import { GOAL_ENTRY_TYPE, GOAL_UPDATE_TOOL, isSavedSession, pauseFailedGoal, pauseGoalAfterFailure, recordGoalProgress, syncGoalUpdateTool, transitionGoal, type GoalEntryData } from "./goal-runtime.ts";
import { GOAL_BLOCKER_KEY_PATTERN, GOAL_EVIDENCE_LIMIT, GOAL_VERSION, normalizeGoalText, parseGoalState, recordGoalDecision, verifyGoalDeliverable } from "./goal-state.ts";
import type { GoalRuntime } from "./goal-model.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

const GoalUpdateParams = Type.Object({
  // `type: "string"` keeps the plain string enum every provider accepts.
  status: Type.Enum(["complete", "continue", "blocked"], {
    type: "string",
    description: "Record an active-goal decision, or complete a blocked goal during an eligible later ordinary request",
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
    pattern: GOAL_BLOCKER_KEY_PATTERN.source,
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

export function registerGoalInterface(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
): void {
  pi.registerEntryRenderer<GoalEntryData>(GOAL_ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data;
    if (!data || data.version !== GOAL_VERSION) return undefined;
    if (data.event === "clear" || data.state === null) return new Text(theme.fg("dim", "Goal cleared"), 0, 0);
    const event = data.event;
    if (event !== "set" && event !== "replace" && event !== "edit" && event !== "pause" && event !== "resume" && event !== "limit" && event !== "error") return undefined;
    const state = parseGoalState(data.state);
    if (!state) return undefined;
    const reason = state.stopReason ?? state.result;
    const objective = safeTerminalText(state.objective);
    let label: string;
    let detail: string;
    let color: ThemeColor;
    switch (event) {
      case "set":
        label = "Goal started";
        detail = objective;
        color = "customMessageLabel";
        break;
      case "replace":
        label = "Goal replaced";
        detail = objective;
        color = "customMessageLabel";
        break;
      case "edit":
        label = "Goal objective edited";
        detail = objective;
        color = "customMessageLabel";
        break;
      case "resume":
        label = "Goal resumed";
        detail = objective;
        color = "customMessageLabel";
        break;
      case "pause":
        label = "Goal paused";
        detail = reason ?? objective;
        color = "warning";
        break;
      case "limit":
        label = "Goal paused";
        detail = reason ?? "";
        color = "warning";
        break;
      case "error":
        label = "Goal paused";
        detail = reason ?? "";
        color = "error";
        break;
    }
    const safeDetail = safeTerminalText(detail);
    const status = theme.fg(color, label);
    if (!options.expanded) {
      return new BoundedText(safeDetail ? `${status}${theme.fg("dim", " · ")}${safeDetail}` : status, 1);
    }
    const lines = [status, objective];
    if (reason && reason !== objective) lines.push(theme.fg("muted", safeTerminalText(reason)));
    return new BoundedText(lines.join("\n"));
  });

  pi.registerTool<typeof GoalUpdateParams, GoalUpdateDetails>({
    name: GOAL_UPDATE_TOOL,
    label: "Goal update",
    description: "Record exactly one active-goal decision: complete after verification, continue with evidence and one next action, or audit the same blocker before blocking it. During an eligible later ordinary request for a blocked goal, only verified completion of the whole unchanged objective is permitted; it does not resume work or grant turns.",
    parameters: GoalUpdateParams,
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!isAutomationMode(ctx)) throw new Error("KillerOS goals require TUI or RPC mode");
      if (!isSavedSession(ctx)) throw new Error("KillerOS goals require a saved session");
      const state = runtime.state;
      if (!state || state.status !== "active" && state.status !== "blocked") throw new Error("There is no active KillerOS goal to update");
      const generation = runtime.lifecycleGeneration;
      const permission = runtime.blockedCompletion;
      const ownsDecision = (): boolean => runtime.state === state
        && runtime.lifecycleGeneration === generation
        && (state.status === "blocked"
          ? permission?.kind === "eligible"
            && runtime.blockedCompletion === permission
            && permission.state === state
            && permission.generation === generation
          : runtime.goalTurnInFlight
            && runtime.goalTurn?.turn === state.turns
            && runtime.goalTurn.revision === state.revision
            && state.turnDecision === undefined);
      if (state.status === "blocked") {
        if (!ownsDecision()) throw new Error("A blocked goal can only be completed during an eligible later ordinary request");
        if (params.status !== "complete") throw new Error("A blocked goal accepts only complete; automatic continuation remains stopped");
        if (state.turns === 0) throw new Error("A zero-turn blocked goal cannot record completion; no accounted goal turn exists");
      } else {
        if (state.turnDecision !== undefined) throw new Error("Only one goal decision may be accepted per logical goal turn");
        if (!ownsDecision()) throw new Error("A goal decision can only be recorded during an active KillerOS goal turn");
      }
      if (params.status !== "complete" && params.status !== "continue" && params.status !== "blocked") {
        throw new Error("Goal update status is invalid");
      }
      if (typeof params.evidence !== "string") throw new Error("Goal evidence must be text");
      const evidence = normalizeGoalText(params.evidence, GOAL_EVIDENCE_LIMIT, "Goal evidence");
      /** Saves an accepted decision; a failed save pauses the goal before the tool reports the error. */
      const saveDecision = (label: string, save: () => void): void => {
        try {
          save();
        } catch (error) {
          pauseGoalAfterFailure(pi, runtime, ctx, `${label} could not be saved: ${errorMessage(error)}`);
          throw error;
        }
      };

      if (params.status === "complete") {
        if (state.verification) await verifyGoalDeliverable(state.verification);
        signal?.throwIfAborted();
        if (!ownsDecision()) throw new Error("Goal changed while completion was being verified");
        const verification: "file" | "model-reported" = state.verification ? "file" : "model-reported";
        const decision = { kind: "complete" as const, turn: state.turns, evidence, verification };
        saveDecision("goal completion", () => transitionGoal(pi, runtime, "complete", "complete", evidence, { resetBlockedAudit: true, decision }));
        if (state.status === "blocked") runtime.blockedCompletion = { kind: "accepted", generation };
        const text = state.verification
          ? `Goal verified complete at ${safeTerminalText(state.verification.path)}: ${evidence}`
          : `Goal marked complete (model-reported): ${evidence}`;
        return {
          content: [{ type: "text", text }],
          details: { status: "complete", evidence, verification },
        };
      }

      if (state.status !== "active") throw new Error("A blocked goal accepts only complete");
      if (params.status === "continue") {
        if (typeof params.nextAction !== "string") throw new Error("A continue decision requires a nextAction");
        const nextAction = normalizeGoalText(params.nextAction, GOAL_EVIDENCE_LIMIT, "Goal nextAction");
        const previous = state.lastContinueReport;
        if (previous?.turn === state.turns - 1
          && previous.evidence === evidence
          && previous.nextAction === nextAction) {
          pauseFailedGoal(pi, runtime, "repeated continue report");
          ctx.ui.notify(
            `Goal paused: repeated continue report on turns ${previous.turn} and ${state.turns}\nRun /goal resume only after choosing a different next action.`,
            "error",
          );
          throw new Error("repeated continue report");
        }
        const decision = { kind: "continue" as const, turn: state.turns, evidence, nextAction };
        saveDecision("goal decision", () => recordGoalProgress(pi, runtime, "continue", recordGoalDecision(state, decision, Date.now())));
        return {
          content: [{ type: "text", text: `Model-reported progress recorded; the goal remains active: ${evidence}` }],
          details: { status: "continue", evidence, nextAction },
        };
      }

      const blockerKey = params.blockerKey;
      if (!blockerKey || !GOAL_BLOCKER_KEY_PATTERN.test(blockerKey)) {
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
        saveDecision("blocker decision", () => recordGoalProgress(pi, runtime, "blocker-audit", { ...recordGoalDecision(state, decision, Date.now()), blockerAudit }));
        return {
          content: [{ type: "text", text: `Blocker audit ${streak}/3 recorded; the goal remains active: ${evidence}` }],
          details: { status: "blocker-audit", evidence, blockerKey, streak },
        };
      }
      const decision = { kind: "blocked" as const, turn: state.turns, blockerKey, streak: 3 as const, evidence };
      saveDecision("blocked decision", () => transitionGoal(pi, runtime, "blocked", "blocked", evidence, { blockerAudit, decision }));
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
        return new BoundedText(theme.fg("error", message), options.expanded ? undefined : 1);
      }
      const details = result.details;
      if (!details || typeof details.evidence !== "string") return new BoundedText(theme.fg("dim", "Goal updated"), options.expanded ? undefined : 1);
      const label = details.status === "complete"
        ? "Goal completed"
        : details.status === "blocked"
          ? "Goal blocked"
          : details.status === "continue"
            ? "Progress recorded"
            : `Blocker audit ${details.streak}/3`;
      const color: ThemeColor = details.status === "complete"
        ? "success"
        : details.status === "blocked"
          ? "error"
          : details.status === "continue"
            ? "customMessageLabel"
            : "warning";
      const text = `${theme.fg(color, label)}${theme.fg("dim", " · ")}${safeTerminalText(details.evidence)}`;
      return new BoundedText(text, options.expanded ? undefined : 1);
    },
  });
  syncGoalUpdateTool(pi, runtime);
}
