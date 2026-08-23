import { StringEnum } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedText } from "./bounded-text.ts";
import { formatTime, formatTokens } from "./display.ts";
import { reportError } from "./errors.ts";
import { resolvePersonalInstructions } from "./personal-instructions.ts";
import type { GoalBlockerAudit, GoalFileBaseline, GoalFileVerification, GoalRuntime, GoalState, GoalStatus, InitRuntime } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

const GOAL_ENTRY_TYPE = "killeros-goal";
const GOAL_CONTINUATION_TYPE = "killeros-goal-continuation";
const GOAL_UPDATE_TOOL = "killeros_goal_update";
const GOAL_OBJECTIVE_LIMIT = 4_000;
const GOAL_VERSION = 1;
const FILE_HASH_CHUNK_SIZE = 64 * 1024;

type GoalEntryEvent = "set" | "replace" | "edit" | "turn" | "pause" | "resume" | "blocked" | "complete" | "error" | "clear" | "checkpoint" | "blocker-audit";
interface GoalEntryData {
  version: 1;
  event: GoalEntryEvent;
  state: GoalState | null;
}

interface GoalTransitionOptions {
  resetBlockedAudit?: boolean;
  resumeAfterManualCompaction?: true;
  blockerAudit?: GoalBlockerAudit;
}

interface RestoredGoalState {
  state?: GoalState;
}

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

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isGoalFileBaseline(value: unknown): value is GoalFileBaseline {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { exists?: unknown; size?: unknown; mtimeMs?: unknown; contentHash?: unknown };
  if (candidate.exists === false) return candidate.size === undefined && candidate.mtimeMs === undefined && candidate.contentHash === undefined;
  return candidate.exists === true
    && finiteNonNegative(candidate.size)
    && finiteNonNegative(candidate.mtimeMs)
    && (candidate.contentHash === undefined
      || candidate.contentHash === null
      || typeof candidate.contentHash === "string" && /^[a-f0-9]{64}$/u.test(candidate.contentHash));
}

function isGoalFileVerification(value: unknown): value is GoalFileVerification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoalFileVerification>;
  return candidate.kind === "file"
    && typeof candidate.path === "string"
    && candidate.path === candidate.path.trim()
    && isAbsoluteFilePath(candidate.path)
    && isGoalFileBaseline(candidate.baseline);
}

function isAbsoluteFilePath(value: string): boolean {
  if (!value || /^(?:https?|file):\/\//iu.test(value) || /[\\\/]$/u.test(value)) return false;
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

/** Hash a deliverable in bounded memory for baseline and completion checks. */
function hashFileContent(filePath: string): string {
  const descriptor = openSync(filePath, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_SIZE);
    let position = 0;
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
}

function captureGoalFileBaseline(filePath: string): GoalFileBaseline {
  let artifact: ReturnType<typeof lstatSync>;
  try {
    artifact = lstatSync(filePath);
  } catch {
    return { exists: false };
  }
  const baseline = { exists: true as const, size: artifact.size, mtimeMs: artifact.mtimeMs };
  if (!artifact.isFile()) return baseline;
  try {
    return { ...baseline, contentHash: hashFileContent(filePath) };
  } catch {
    return { ...baseline, contentHash: null };
  }
}

/** Captures one explicit absolute output path so goal completion can verify its creation or modification. */
function inferGoalVerification(objective: string): GoalFileVerification | undefined {
  const destination = /\b(?:create|write|save|generate)\b[^\r\n]{0,160}?\b(?:file|document|markdown|report|spreadsheet|presentation|image)\b\s+(?:to|at|as|destination(?:\s+is)?|output(?:\s+(?:to|at))?)\b\s*(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z]:\\[^\s,;]+|\/[^\s,;]+))/giu;
  const paths = [...objective.matchAll(destination)]
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim())
    .filter(isAbsoluteFilePath);
  const unique = [...new Set(paths)];
  const filePath = unique.length === 1 ? unique[0] : undefined;
  return filePath ? { kind: "file", path: filePath, baseline: captureGoalFileBaseline(filePath) } : undefined;
}

function verifyGoalDeliverable(verification: GoalFileVerification): void {
  let artifact: ReturnType<typeof lstatSync>;
  try {
    artifact = lstatSync(verification.path);
  } catch {
    throw new Error(`Goal deliverable is not a regular file at the required path: ${verification.path}`);
  }
  if (!artifact.isFile()) {
    throw new Error(`Goal deliverable is not a regular file at the required path: ${verification.path}`);
  }
  if (!verification.baseline.exists) return;
  if (verification.baseline.contentHash === null) {
    throw new Error(`Goal deliverable content cannot be verified: ${verification.path}`);
  }
  if (verification.baseline.contentHash !== undefined) {
    let contentHash: string;
    try {
      contentHash = hashFileContent(verification.path);
    } catch {
      throw new Error(`Goal deliverable content cannot be verified: ${verification.path}`);
    }
    if (contentHash === verification.baseline.contentHash) {
      throw new Error(`Goal deliverable has not changed since the goal started: ${verification.path}`);
    }
  }
  if (verification.baseline.contentHash === undefined
    && artifact.size === verification.baseline.size
    && artifact.mtimeMs === verification.baseline.mtimeMs) {
    throw new Error(`Goal deliverable has not changed since the goal started: ${verification.path}`);
  }
}

function isGoalBlockerAudit(value: unknown, turns: number, status: GoalStatus): value is GoalBlockerAudit {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoalBlockerAudit>;
  if (typeof candidate.key !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(candidate.key)
    || !Number.isInteger(candidate.streak) || (candidate.streak ?? 0) < 1 || (candidate.streak ?? 0) > 3
    || !Number.isInteger(candidate.lastTurn) || (candidate.lastTurn ?? 0) < 1 || (candidate.lastTurn ?? 0) > turns) return false;
  if (status === "complete") return false;
  return status === "blocked" ? candidate.streak === 3 : candidate.streak! < 3;
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
    || candidate.result !== undefined && typeof candidate.result !== "string"
    || candidate.verification !== undefined && !isGoalFileVerification(candidate.verification)
    || candidate.blockerAudit !== undefined && !isGoalBlockerAudit(candidate.blockerAudit, candidate.turns!, candidate.status)
    || candidate.resumeAfterManualCompaction !== undefined && candidate.resumeAfterManualCompaction !== true
    || candidate.resumeAfterManualCompaction === true && candidate.status !== "paused") {
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
    resumeAfterManualCompaction: candidate.resumeAfterManualCompaction,
    blockerAudit: candidate.blockerAudit,
    verification: candidate.verification,
  };
}

function goalBranchEntries(ctx: ExtensionContext): ReturnType<ExtensionContext["sessionManager"]["getEntries"]> {
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
    const data = entry.data as Partial<GoalEntryData> | undefined;
    if (!data || data.version !== GOAL_VERSION || data.state === null) {
      return { state: undefined };
    }
    const restored = parseGoalState(data.state);
    if (!restored) return { state: undefined };
    const state = restored.status === "active"
      ? { ...restored, activeStartedAt: Date.now() }
      : { ...restored, activeStartedAt: undefined };
    if (state.status === "paused") state.resumeAfterManualCompaction = undefined;
    return { state };
  }
  return { state: undefined };
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

function setGoalUpdateToolActive(pi: ExtensionAPI, active: boolean): void {
  const activeTools = pi.getActiveTools();
  const isActive = activeTools.includes(GOAL_UPDATE_TOOL);
  if (active === isActive) return;
  pi.setActiveTools(active
    ? [...activeTools, GOAL_UPDATE_TOOL]
    : activeTools.filter((name) => name !== GOAL_UPDATE_TOOL));
}

function syncGoalUpdateTool(pi: ExtensionAPI, runtime: GoalRuntime): void {
  setGoalUpdateToolActive(pi, runtime.state?.status === "active");
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
  syncGoalUpdateTool(pi, runtime);
  runtime.persistenceRetryNeeded = false;
  runtime.requestRender?.();
}

function transitionGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  event: GoalEntryEvent,
  status: GoalStatus,
  result?: string,
  options: GoalTransitionOptions = {},
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
    blockedAuditStartTurn: options.resetBlockedAudit ? stopped.turns : stopped.blockedAuditStartTurn,
    blockerAudit: options.resetBlockedAudit ? undefined : options.blockerAudit ?? stopped.blockerAudit,
    result,
    resumeAfterManualCompaction: options.resumeAfterManualCompaction,
  };
  persistGoalState(pi, runtime, event, next);
  if (status !== "active") {
    runtime.continuationScheduled = false;
    runtime.automaticCompaction = undefined;
  }
  return next;
}

function clearGoalExecutionFlags(runtime: GoalRuntime): void {
  runtime.continuationScheduled = false;
  runtime.goalTurnInFlight = false;
  runtime.agentEndObserved = false;
  runtime.automaticCompaction = undefined;
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
}

async function stopGoalRun(runtime: GoalRuntime, ctx: ExtensionCommandContext, shouldStop: boolean): Promise<void> {
  if (!shouldStop) return;
  try {
    ctx.abort();
    await ctx.waitForIdle();
  } finally {
    clearGoalExecutionFlags(runtime);
  }
}

function goalStatusLabel(status: GoalStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function goalPanelActions(status: GoalStatus): Array<{ label: string; control: "pause" | "resume" | "edit" | "clear" }> {
  const terminal = [
    { label: "Edit objective", control: "edit" as const },
    { label: "Clear goal", control: "clear" as const },
  ];
  if (status === "active") return [{ label: "Pause automatic continuation", control: "pause" }, ...terminal];
  if (status === "paused" || status === "blocked") {
    return [{ label: "Resume automatic continuation", control: "resume" }, ...terminal];
  }
  return terminal;
}

function goalStatusSummary(state: GoalState, ctx: ExtensionContext): string {
  const usedTokens = Math.max(0, sumGoalTokens(ctx) - state.baselineTokens);
  const lines = [
    `Goal ${goalStatusLabel(state.status).toLowerCase()} · ${state.turns} turn${state.turns === 1 ? "" : "s"} · ${formatTime(goalElapsedMilliseconds(state))} · ${formatTokens(usedTokens)} tokens`,
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
  notify = true,
): void {
  if (runtime.state?.status !== "active") return;
  try {
    transitionGoal(pi, runtime, "error", "paused", reason);
  } catch {
    runtime.state = runtime.state ? {
      ...stopGoalClock(runtime.state, Date.now()),
      status: "paused",
      result: reason,
      resumeAfterManualCompaction: undefined,
    } : undefined;
    syncGoalUpdateTool(pi, runtime);
    runtime.persistenceRetryNeeded = true;
    runtime.continuationScheduled = false;
    runtime.automaticCompaction = undefined;
    runtime.requestRender?.();
  }
  if (notify) ctx.ui.notify(`Goal paused: ${reason}\n${recoveryInstruction}`, "error");
}

function pauseGoalForPossibleManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
): void {
  if (runtime.state?.status !== "active") return;
  try {
    transitionGoal(pi, runtime, "error", "paused", reason, {
      resumeAfterManualCompaction: true,
    });
  } catch {
    runtime.state = runtime.state ? {
      ...stopGoalClock(runtime.state, Date.now()),
      status: "paused",
      result: reason,
      resumeAfterManualCompaction: true,
    } : undefined;
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

function beginGoalTurn(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  current: GoalState,
): GoalState | undefined {
  const now = Date.now();
  const next: GoalState = {
    ...current,
    revision: current.revision + 1,
    turns: current.turns + 1,
    updatedAt: now,
    activeStartedAt: current.activeStartedAt ?? now,
    resumeAfterManualCompaction: undefined,
  };
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

function completeAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): void {
  if (runtime.automaticCompaction === undefined) return;
  if (runtime.state?.status !== "active" || initState.active) {
    runtime.automaticCompaction = undefined;
    return;
  }
  runtime.automaticCompaction = undefined;
  setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
}

function failAutomaticCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  error: unknown,
): void {
  if (runtime.automaticCompaction === undefined) return;
  runtime.automaticCompaction = undefined;
  if (runtime.state?.status !== "active") return;
  const reason = error instanceof Error ? error.message : String(error);
  pauseGoalAfterFailure(
    pi,
    runtime,
    ctx,
    `automatic compaction failed: ${reason}`,
    "Automatic continuation is stopped. Run /goal resume after resolving the compaction problem.",
  );
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
      sections.push(`<personal_instructions source=${JSON.stringify(personal.source)}>\n${personal.content}\n</personal_instructions>`);
    }
  }
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isGoalModeSupported(ctx)) throw new Error("KillerOS goals require TUI or RPC mode");
      if (!isSavedSession(ctx)) throw new Error("KillerOS goals require a saved session");
      const state = runtime.state;
      if (!state || state.status !== "active") throw new Error("There is no active KillerOS goal to update");
      const evidence = params.evidence.trim();
      if (!evidence) throw new Error("Goal evidence must not be empty");
      if (params.status === "complete") {
        if (state.verification) verifyGoalDeliverable(state.verification);
        const verification = state.verification ? "file" : "model-reported";
        transitionGoal(pi, runtime, "complete", "complete", evidence, { resetBlockedAudit: true });
        return {
          content: [{ type: "text", text: state.verification
            ? `Goal verified complete at ${state.verification.path}: ${evidence}`
            : `Goal marked complete (model-reported): ${evidence}` }],
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
      const blockerAudit = { key: blockerKey, streak, lastTurn: state.turns };
      if (streak < 3) {
        const next: GoalState = {
          ...state,
          revision: state.revision + 1,
          updatedAt: Date.now(),
          blockerAudit,
        };
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

  const handleGoalCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      if (ctx.mode === "print" || ctx.mode === "json") {
        ctx.ui.notify("/goal requires TUI or RPC mode", "error");
        return;
      }
      if (!isSavedSession(ctx)) {
        ctx.ui.notify("/goal requires a saved session", "error");
        return;
      }
      const input = args.trim();
      const control = input.toLowerCase();
      const isControl = control === "clear" || control === "edit" || control === "pause" || control === "resume";

      if (!input) {
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
        if (action.control === "clear" && !await ctx.ui.confirm("Clear goal?", runtime.state.objective)) return;
        await handleGoalCommand(action.control, ctx);
        return;
      }

      if (control === "clear") {
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

      if (control === "pause") {
        if (!runtime.state) {
          ctx.ui.notify("No goal is set", "info");
          return;
        }
        if (runtime.state.status === "paused") {
          if (!runtime.persistenceRetryNeeded && runtime.state.resumeAfterManualCompaction !== true) {
            ctx.ui.notify("Goal is already paused", "info");
            return;
          }
          const now = Date.now();
          const checkpoint: GoalState = {
            ...runtime.state,
            revision: runtime.state.revision + 1,
            updatedAt: now,
            resumeAfterManualCompaction: undefined,
          };
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
          failureReason = `the requested pause could not be saved: ${error instanceof Error ? error.message : String(error)}`;
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
          transitionGoal(pi, runtime, "resume", "active", undefined, { resetBlockedAudit: true });
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
          blockerAudit: undefined,
          verification: inferGoalVerification(objective),
          result: undefined,
          resumeAfterManualCompaction: undefined,
        };
        try {
          persistGoalState(pi, runtime, "edit", next);
          runtime.continuationScheduled = false;
          if (scheduleGoalContinuation(pi, runtime, initState, ctx)) ctx.ui.notify("Goal updated and active", "info");
        } catch (error) {
          if (runtime.state?.status === "active") {
            pauseGoalAfterFailure(
              pi,
              runtime,
              ctx,
              `Goal could not be edited: ${error instanceof Error ? error.message : String(error)}`,
              "Automatic continuation is stopped. Retry /goal edit after session storage recovers.",
            );
          } else {
            reportError(ctx, "Goal could not be edited", error);
          }
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
        verification: inferGoalVerification(objective),
      };
      try {
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
    description: "Set or view the goal for a long-running task",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
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
    handler: handleGoalCommand,
  });
}

export function registerGoalSettlement(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
): {
  isActive(ctx: ExtensionContext): boolean;
  onRequested(): void;
  onCompleted(ctx: ExtensionContext): void;
  onFailed(ctx: ExtensionContext, error: unknown): void;
} {
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
      } else if (runtime.state?.status === "active" && !initState.active) {
        scheduleGoalContinuation(pi, runtime, initState, ctx);
      }
      return;
    }
    if (!agentEndObserved) {
      if (runtime.automaticCompaction !== undefined) return;
      pauseGoalAfterFailure(pi, runtime, ctx, "the goal turn ended without an agent result");
      return;
    }
    if (runtime.lastStopReason === "aborted") {
      const reason = runtime.lastError || "the agent turn was aborted";
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      if (runtime.automaticCompaction !== undefined) return;
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
    scheduleGoalContinuation(pi, runtime, initState, ctx);
  });

  pi.on("session_compact", (event, ctx) => {
    if (runtime.automaticCompaction !== undefined) return;
    if (event.reason !== "manual") return;
    recoverGoalAfterManualCompaction(pi, runtime, initState, ctx);
  });

  return {
    isActive: (ctx: ExtensionContext): boolean => isGoalModeSupported(ctx)
      && isSavedSession(ctx)
      && runtime.state?.status === "active"
      && !initState.active,
    onRequested: (): void => {
      if (runtime.state?.status === "active") runtime.automaticCompaction = "pending";
    },
    onCompleted: (ctx: ExtensionContext): void => completeAutomaticCompaction(pi, runtime, initState, ctx),
    onFailed: (ctx: ExtensionContext, error: unknown): void => failAutomaticCompaction(pi, runtime, ctx, error),
  };
}
