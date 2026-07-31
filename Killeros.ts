import { execFileSync, spawn } from "node:child_process";
import { promises as fs, closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIG_DIR_NAME,
  CustomEditor,
  DynamicBorder,
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  Editor,
  Key,
  Markdown,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const COMMAND_BLUE_RGB = "120;169;255";
const FOOTER_REFRESH_INTERVAL_MS = 1_000;
const COMPACT_HEADER_MAX_WIDTH = 52;

const commandBlue = (text: string): string => `\x1B[38;2;${COMMAND_BLUE_RGB}m${text}\x1B[39m`;

function readPackageVersion(path: string | URL): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

const KILLEROS_VERSION = readPackageVersion(new URL("./package.json", import.meta.url));

const STARTUP_TIPS = [
  "Press Shift+Enter to insert a line break without sending.",
  "Run /variants to tune the model's reasoning depth.",
  "Type / to browse every command available in this session.",
] as const;

function resolveGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
      windowsHide: true,
    }).trim();
    if (!branch) return undefined;
    return branch === "HEAD" ? "detached" : branch;
  } catch {
    return undefined;
  }
}

function shuffledTips(): string[] {
  const tips = [...STARTUP_TIPS];
  for (let index = tips.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [tips[index], tips[swapIndex]] = [tips[swapIndex]!, tips[index]!];
  }
  return tips;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) return cwd;
  const normalizedHome = home.replace(/[\\/]+$/, "");
  const normalizedCwd = cwd.replace(/[\\/]+$/, "");
  if (normalizedCwd === normalizedHome) return "~";
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  return normalizedCwd.startsWith(normalizedHome) && (separator === "/" || separator === "\\")
    ? `~${normalizedCwd.slice(normalizedHome.length)}`
    : cwd;
}

function padRight(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function compactBoxLine(content: string, width: number, theme: Theme): string {
  if (width < 4) return truncateToWidth(content, width, "");
  return `${theme.fg("dim", "│")} ${padRight(content, width - 4)} ${theme.fg("dim", "│")}`;
}

class PiStartupHeader {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly branch: string | undefined;
  private readonly tip: string;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, tip: string) {
    this.pi = pi;
    this.ctx = ctx;
    this.branch = resolveGitBranch(ctx.cwd);
    this.tip = tip;
  }

  private tipLines(width: number, theme: Theme): string[] {
    const indent = "  ";
    const text = `${theme.fg("text", theme.bold("Tip:"))}${theme.fg("dim", ` ${this.tip}`)}`;
    return wrapTextWithAnsi(text, width - indent.length)
      .map((line) => padRight(`${indent}${line}`, width));
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.ctx.ui.theme;
    if (width < 28) return [truncateToWidth(theme.fg("text", theme.bold("KillerOS")), width, "")];

    const panelWidth = Math.min(width, COMPACT_HEADER_MAX_WIDTH);
    const innerWidth = panelWidth - 4;
    const version = KILLEROS_VERSION ? theme.fg("dim", ` (v${KILLEROS_VERSION})`) : "";
    const identity = `${theme.fg("dim", "›")} ${theme.fg("text", theme.bold("KillerOS"))}${version}`;
    const thinkingLevel = this.pi.getThinkingLevel() as ThinkingLevel;
    const reasoning = this.ctx.model?.reasoning === false
      ? theme.fg("thinkingOff", "no reasoning")
      : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
    const agent = `${formatModel(this.ctx.model, theme)}${theme.fg("dim", " · ")}${reasoning}`;
    const directory = formatCwd(this.ctx.cwd);
    const repository = this.branch
      ? `${directory} ${theme.fg("dim", `· ${this.branch}`)}`
      : directory;
    const modelCommand = commandBlue("/model");
    const agentWidth = Math.max(0, innerWidth - visibleWidth(modelCommand) - 1);
    const agentCommand = `${truncateToWidth(agent, agentWidth, "…")} ${modelCommand}`;
    const border = (left: string, right: string): string => theme.fg("dim", `${left}${"─".repeat(panelWidth - 2)}${right}`);
    const lines = [
      border("╭", "╮"),
      compactBoxLine(identity, panelWidth, theme),
      compactBoxLine("", panelWidth, theme),
      compactBoxLine(agentCommand, panelWidth, theme),
      compactBoxLine(repository, panelWidth, theme),
      border("╰", "╯"),
      " ".repeat(panelWidth),
      ...this.tipLines(panelWidth, theme),
    ];
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

const ANSI_REGEX = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "").trim();
}

function isBorderLine(line: string): boolean {
  const unstyled = stripAnsi(line);
  return /^[─━═]+$/.test(unstyled) || /^───\s*[↓↑]/.test(unstyled) || /^─{3,}/.test(unstyled);
}

class PiCodeEditor extends CustomEditor {
  private readonly appKeybindings: KeybindingsManager;

  constructor(tui: TUI, theme: EditorTheme, appKeybindings: KeybindingsManager) {
    super(tui, theme, appKeybindings);
    this.appKeybindings = appKeybindings;
  }

  override handleInput(data: string): void {
    const isShiftEnter = data === "\x1B[13;2u"
      || data === "\x1B[13;2~"
      || data === "\x1B[27;2;13~"
      || data === "\x1B\r"
      || data === "\x1B\n"
      || this.appKeybindings.matches(data, "tui.input.newLine");
    if (isShiftEnter) {
      this.insertTextAtCursor("\n");
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    if (width < 4) return super.render(width);
    const innerWidth = width - 2;
    const lines = super.render(innerWidth);
    if (lines.length < 2) return lines.map((line) => truncateToWidth(line, width, ""));

    const gray = (text: string): string => `\x1B[90m${text}\x1B[39m`;
    let bottomBorderIndex = -1;
    for (let index = lines.length - 1; index >= 1; index -= 1) {
      if (isBorderLine(lines[index] ?? "")) {
        bottomBorderIndex = index;
        break;
      }
    }
    if (bottomBorderIndex < 0) bottomBorderIndex = lines.length - 1;

    const framed: string[] = [];
    const top = stripAnsi(lines[0] ?? "");
    const isScrolledHeader = top.includes("↑");
    if (isScrolledHeader) {
      const count = top.match(/↑\s*(\d+)/)?.[1] ?? "";
      const indicator = `${gray("─── ↑ ")}${count}${gray(" more ")}${gray("─".repeat(Math.max(0, width - 12 - count.length)))}`;
      framed.push(truncateToWidth(indicator, width, ""));
    } else {
      framed.push(gray("─".repeat(width)));
    }

    for (let index = 1; index < bottomBorderIndex; index += 1) {
      const prefix = index === 1 && !isScrolledHeader ? gray("❯ ") : "  ";
      framed.push(`${prefix}${padRight(lines[index] ?? "", innerWidth)}`);
    }

    const bottom = stripAnsi(lines[bottomBorderIndex] ?? "");
    if (bottom.includes("↓")) {
      const count = bottom.match(/↓\s*(\d+)/)?.[1] ?? "";
      const indicator = `${gray("─── ↓ ")}${count}${gray(" more ")}${gray("─".repeat(Math.max(0, width - 12 - count.length)))}`;
      framed.push(truncateToWidth(indicator, width, ""));
    } else {
      framed.push(gray("─".repeat(width)));
    }

    for (let index = bottomBorderIndex + 1; index < lines.length; index += 1) {
      framed.push(`  ${padRight(lines[index] ?? "", innerWidth)}`);
    }
    return framed.map((line) => truncateToWidth(line, width, ""));
  }
}

function reportError(ctx: ExtensionContext, area: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${area}: ${message}`, "error");
}

const ACTIVITY_WORDS = ["Brewing", "Pondering", "Tinkering", "Wrangling", "Noodling", "Cooking"] as const;

function registerShellUi(pi: ExtensionAPI): void {
  let activeHeader: PiStartupHeader | undefined;
  let activityWordIndex = 0;
  let tipDeck: string[] = [];
  const nextStartupTip = (): string => {
    if (tipDeck.length === 0) tipDeck = shuffledTips();
    return tipDeck.pop() ?? STARTUP_TIPS[0];
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setTheme("killeros");
      const startupTip = nextStartupTip();
      ctx.ui.setHeader(() => {
        activeHeader?.dispose();
        activeHeader = new PiStartupHeader(pi, ctx, startupTip);
        return activeHeader;
      });
      ctx.ui.setWorkingIndicator({
        frames: [
          ctx.ui.theme.fg("dim", "✻"),
          ctx.ui.theme.fg("muted", "✻"),
          ctx.ui.theme.fg("accent", "✻"),
          ctx.ui.theme.fg("muted", "✻"),
        ],
        intervalMs: 180,
      });
      ctx.ui.setHiddenThinkingLabel("└ Thinking…");
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new PiCodeEditor(tui, theme, keybindings));
    } catch (error) {
      reportError(ctx, "Killeros UI failed to initialize", error);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(`${ACTIVITY_WORDS[activityWordIndex]}…`);
    activityWordIndex = (activityWordIndex + 1) % ACTIVITY_WORDS.length;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", () => {
    activeHeader?.dispose();
    activeHeader = undefined;
    activityWordIndex = 0;
  });
}

export const CONCISE_SYSTEM_PROMPT = `
# Concise output rules
1. Start with the answer or next action; omit conversational preambles.
2. Use numbered steps only when order matters, with one bounded action per step.
3. Finish the primary task before mentioning optional follow-up work.
4. State failures directly and include the recovery action.
5. Keep lists focused; group long inventories under clear headings.
6. Do not invent time estimates, completion claims, or facts.
7. Preserve exact code, commands, paths, quoted text, warnings, and user-requested formats.
8. Omit recap sections and generic closing pleasantries.
`.trim();

export function isConcisedEnabled(): boolean {
  return true;
}

function registerConcisePrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CONCISE_SYSTEM_PROMPT}`,
  }));
}

const INIT_READ_ONLY_TOOLS = new Set(["read", "ls", "find", "grep"]);

interface InitWorkflowState {
  active: boolean;
  targetPath?: string;
  writeAttempted: boolean;
  writeSucceeded: boolean;
  writeToolCallId?: string;
  settle?: (writeSucceeded: boolean) => void;
}

function resetInitState(state: InitWorkflowState): void {
  state.active = false;
  state.targetPath = undefined;
  state.writeAttempted = false;
  state.writeSucceeded = false;
  state.writeToolCallId = undefined;
}

const GOAL_ENTRY_TYPE = "killeros-goal";
const GOAL_CONTINUATION_TYPE = "killeros-goal-continuation";
const GOAL_OBJECTIVE_LIMIT = 4_000;
const GOAL_VERSION = 1;

type GoalStatus = "active" | "paused" | "blocked" | "complete";
type GoalEntryEvent = "set" | "replace" | "edit" | "turn" | "pause" | "resume" | "blocked" | "complete" | "error" | "clear" | "checkpoint";

interface GoalState {
  version: 1;
  revision: number;
  objective: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  activeMilliseconds: number;
  activeStartedAt?: number;
  turns: number;
  blockedAuditStartTurn: number;
  baselineTokens: number;
  result?: string;
}

interface GoalEntryData {
  version: 1;
  event: GoalEntryEvent;
  state: GoalState | null;
}

interface GoalRuntime {
  state?: GoalState;
  continuationScheduled: boolean;
  continuationHeld: boolean;
  goalTurnInFlight: boolean;
  agentEndObserved: boolean;
  persistenceRetryNeeded: boolean;
  lastStopReason?: string;
  lastError?: string;
  requestRender?: () => void;
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

function goalElapsedMilliseconds(state: GoalState, now = Date.now()): number {
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

function pauseGoalAfterFailure(
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
  initState: InitWorkflowState,
  ctx: ExtensionContext,
): void {
  if (!isGoalModeSupported(ctx)
    || !isSavedSession(ctx)
    || runtime.state?.status !== "active"
    || runtime.continuationScheduled
    || runtime.continuationHeld
    || initState.active
    || ctx.hasPendingMessages()) return;
  const current = runtime.state;
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
    pauseGoalAfterFailure(pi, runtime, ctx, `continuation state could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  runtime.continuationScheduled = true;
  runtime.goalTurnInFlight = true;
  runtime.agentEndObserved = false;
  runtime.lastStopReason = undefined;
  runtime.lastError = undefined;
  try {
    pi.sendMessage({
      customType: GOAL_CONTINUATION_TYPE,
      content: goalContinuationMessage(next, ctx),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  } catch (error) {
    runtime.continuationScheduled = false;
    runtime.goalTurnInFlight = false;
    pauseGoalAfterFailure(pi, runtime, ctx, `continuation could not start: ${error instanceof Error ? error.message : String(error)}`);
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

function registerGoal(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitWorkflowState,
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
          scheduleGoalContinuation(pi, runtime, initState, ctx);
          ctx.ui.notify("Goal resumed", "info");
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
          scheduleGoalContinuation(pi, runtime, initState, ctx);
          ctx.ui.notify("Goal updated and active", "info");
        } catch (error) {
          reportError(ctx, "Goal could not be edited", error);
          scheduleGoalContinuation(pi, runtime, initState, ctx);
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
        scheduleGoalContinuation(pi, runtime, initState, ctx);
        ctx.ui.notify("Goal active. KillerOS will continue until completion, a repeated blocker, or pause.", "info");
      } catch (error) {
        reportError(ctx, "Goal could not be started", error);
        scheduleGoalContinuation(pi, runtime, initState, ctx);
      }
    },
  });
}

function registerGoalSettlement(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitWorkflowState,
): void {
  pi.on("agent_settled", (_event, ctx) => {
    const wasGoalTurn = runtime.goalTurnInFlight;
    const agentEndObserved = runtime.agentEndObserved;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.continuationScheduled = false;
    if (!wasGoalTurn || runtime.state?.status !== "active" || initState.active) return;
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
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    scheduleGoalContinuation(pi, runtime, initState, ctx);
  });
}

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200, description: "Display label for the option" }),
  description: Type.Optional(Type.String({ maxLength: 500, description: "Optional detail shown for the selected option" })),
  preview: Type.Optional(Type.String({ maxLength: 8_000, description: "Optional markdown proposal preview shown for the selected option" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 1_000, description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, {
    minItems: 1,
    maxItems: 9,
    description: "Between 1 and 9 options for the user to choose from",
  }),
});

interface DisplayOption {
  label: string;
  description?: string;
  preview?: string;
  originalIndex: number;
  isOther: boolean;
}

interface QuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  selectedIndex?: number;
  wasCustom?: boolean;
  cancelled?: boolean;
}

type QuestionSelection =
  | { kind: "selected"; answer: string; originalIndex: number }
  | { kind: "custom"; answer: string }
  | { kind: "cancelled" }
  | { kind: "aborted" };

const customInputHistory: string[] = [];

function rememberCustomInput(value: string): void {
  const existingIndex = customInputHistory.indexOf(value);
  if (existingIndex >= 0) customInputHistory.splice(existingIndex, 1);
  customInputHistory.push(value);
  if (customInputHistory.length > 100) customInputHistory.shift();
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001F\u007F-\u009F]/u.test(data);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function decodeQuestionFilterInput(data: string): string | undefined {
  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) return isPrintableInput(kittyPrintable) ? kittyPrintable : undefined;

  const pasteStart = "\x1B[200~";
  const pasteEnd = "\x1B[201~";
  const startIndex = data.indexOf(pasteStart);
  const endIndex = data.indexOf(pasteEnd, startIndex + pasteStart.length);
  if (startIndex >= 0 && endIndex >= 0) {
    return data
      .slice(startIndex + pasteStart.length, endIndex)
      .replace(/\r\n|\r|\n/gu, "")
      .replace(/\t/gu, "    ")
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");
  }

  return isPrintableInput(data) ? data : undefined;
}

function removeLastGrapheme(value: string): string {
  const segments = [...graphemeSegmenter.segment(value)];
  const last = segments.at(-1);
  return last ? value.slice(0, last.index) : "";
}

function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof QuestionParams, QuestionDetails>({
    name: "question",
    label: "Question",
    description: "Ask one interactive multiple-choice question. Provide 1-9 concise options. The user can filter options or type a custom answer.",
    promptSnippet: "Ask the user one multiple-choice question when a decision is required to proceed",
    promptGuidelines: [
      "Use question only when user input is required to choose between concrete alternatives; do not use question for rhetorical or optional follow-up prompts.",
    ],
    parameters: QuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error("The question tool requires interactive TUI mode");
      if (signal?.aborted) throw new Error("Question cancelled before it opened");

      const options: DisplayOption[] = [
        ...params.options.map((option, index) => ({
          label: option.label,
          description: option.description,
          preview: option.preview,
          originalIndex: index + 1,
          isOther: false,
        })),
        {
          label: "Type a custom answer",
          originalIndex: params.options.length + 1,
          isOther: true,
        },
      ];

      let finishFromAbort: (() => void) | undefined;
      const resultPromise = ctx.ui.custom<QuestionSelection>((tui, theme, _keybindings, done) => {
        let optionIndex = 0;
        let editMode = false;
        let filterQuery = "";
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;
        let completed = false;

        const finish = (selection: QuestionSelection): void => {
          if (completed) return;
          completed = true;
          done(selection);
        };
        finishFromAbort = () => finish({ kind: "aborted" });

        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);
        customInputHistory.forEach((value) => editor.addToHistory(value));

        const filteredOptions = (): DisplayOption[] => {
          const query = filterQuery.trim().toLocaleLowerCase();
          return options.filter((option) => option.isOther
            || query.length === 0
            || option.label.toLocaleLowerCase().includes(query)
            || option.description?.toLocaleLowerCase().includes(query));
        };

        const invalidate = (): void => {
          cachedWidth = undefined;
          cachedLines = undefined;
          editor.invalidate();
        };

        const refresh = (): void => {
          invalidate();
          tui.requestRender();
        };

        editor.onSubmit = (value) => {
          const answer = value.trim();
          if (answer) {
            rememberCustomInput(answer);
            finish({ kind: "custom", answer });
            return;
          }
          editMode = false;
          editor.setText("");
          refresh();
        };

        const enterCustomMode = (): void => {
          editMode = true;
          refresh();
        };

        const handleInput = (data: string): void => {
          if (editMode) {
            if (matchesKey(data, Key.escape)) {
              editMode = false;
              editor.setText("");
              refresh();
              return;
            }
            editor.handleInput(data);
            refresh();
            return;
          }

          const visibleOptions = filteredOptions();
          if (optionIndex >= visibleOptions.length) optionIndex = Math.max(0, visibleOptions.length - 1);
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(visibleOptions.length - 1, optionIndex + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const selected = visibleOptions[optionIndex];
            if (!selected) return;
            if (selected.isOther) enterCustomMode();
            else finish({ kind: "selected", answer: selected.label, originalIndex: selected.originalIndex });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            if (filterQuery) {
              filterQuery = "";
              optionIndex = 0;
              refresh();
            } else {
              finish({ kind: "cancelled" });
            }
            return;
          }
          if (matchesKey(data, Key.backspace)) {
            if (filterQuery) {
              filterQuery = removeLastGrapheme(filterQuery);
              optionIndex = 0;
              refresh();
            }
            return;
          }
          const printableInput = decodeQuestionFilterInput(data);
          const isPasteInput = data.includes("\x1B[200~");
          if (!isPasteInput && printableInput && /^[1-9]$/.test(printableInput)) {
            const selected = visibleOptions[Number(printableInput) - 1];
            if (!selected) return;
            if (selected.isOther) enterCustomMode();
            else finish({ kind: "selected", answer: selected.label, originalIndex: selected.originalIndex });
            return;
          }
          if (printableInput) {
            filterQuery += printableInput;
            optionIndex = 0;
            refresh();
          }
        };

        const render = (width: number): string[] => {
          const renderWidth = Math.max(1, width);
          if (cachedLines && cachedWidth === renderWidth) return cachedLines;
          const lines: string[] = [];
          const addWrapped = (text: string): void => {
            lines.push(...wrapTextWithAnsi(text, renderWidth));
          };
          const addWrappedWithPrefix = (prefix: string, text: string): void => {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= renderWidth) {
              addWrapped(prefix + text);
              return;
            }
            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
            const continuation = " ".repeat(prefixWidth);
            wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
          };

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          addWrappedWithPrefix(" ", theme.fg("text", params.question));
          lines.push("");
          if (!editMode && filterQuery) {
            addWrappedWithPrefix(" ", `${theme.fg("muted", "Filter: ")}${theme.fg("accent", filterQuery)}`);
            lines.push("");
          }

          const visibleOptions = filteredOptions();
          if (optionIndex >= visibleOptions.length) optionIndex = Math.max(0, visibleOptions.length - 1);
          visibleOptions.forEach((option, index) => {
            const selected = index === optionIndex;
            const prefix = selected ? theme.fg("accent", "> ") : "  ";
            const color: ThemeColor = selected ? "accent" : "text";
            addWrappedWithPrefix(prefix, theme.fg(color, `${index + 1}. ${option.label}`));
            if (selected && option.description) {
              addWrappedWithPrefix("    ", theme.fg("muted", option.description));
            }
          });

          const selectedPreview = visibleOptions[optionIndex]?.preview;
          if (!editMode && selectedPreview) {
            const footerRows = 3;
            const previewChromeRows = 2;
            const availableRows = tui.terminal.rows - lines.length - footerRows;
            if (availableRows > previewChromeRows) {
              lines.push("");
              addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Proposal preview")));
              const markdownLines = new Markdown(
                selectedPreview,
                1,
                0,
                {
                  heading: (text) => theme.fg("accent", theme.bold(text)),
                  link: (text) => theme.fg("accent", text),
                  linkUrl: (text) => theme.fg("dim", text),
                  code: (text) => theme.fg("mdCode", text),
                  codeBlock: (text) => theme.fg("mdCodeBlock", text),
                  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
                  quote: (text) => theme.fg("mdQuote", text),
                  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
                  hr: (text) => theme.fg("mdHr", text),
                  listBullet: (text) => theme.fg("mdListBullet", text),
                  bold: (text) => theme.bold(text),
                  italic: (text) => theme.italic(text),
                  strikethrough: (text) => theme.strikethrough(text),
                  underline: (text) => theme.underline(text),
                },
                { color: (text) => theme.fg("muted", text) },
              ).render(renderWidth);
              const maxPreviewRows = Math.min(12, availableRows - previewChromeRows);
              if (markdownLines.length <= maxPreviewRows) {
                lines.push(...markdownLines);
              } else {
                const visiblePreviewRows = Math.max(0, maxPreviewRows - 1);
                lines.push(...markdownLines.slice(0, visiblePreviewRows));
                const hiddenRows = markdownLines.length - visiblePreviewRows;
                lines.push(theme.fg("dim", ` … ${hiddenRows} more line${hiddenRows === 1 ? "" : "s"}`));
              }
            }
          }

          if (editMode) {
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
            editor.render(Math.max(1, renderWidth - 2)).forEach((line) => lines.push(` ${line}`));
          }

          lines.push("");
          const hint = editMode
            ? `Enter submit • Esc options${customInputHistory.length ? " • ↑↓ history" : ""}`
            : filterQuery
              ? "1-9 select • ↑↓ navigate • Enter select • Esc clear filter"
              : "1-9 select • type to filter • ↑↓ navigate • Enter select • Esc cancel";
          addWrappedWithPrefix(" ", theme.fg("dim", hint));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedWidth = renderWidth;
          cachedLines = lines.map((line) => truncateToWidth(line, renderWidth, ""));
          return cachedLines;
        };

        let focused = false;
        return {
          get focused(): boolean { return focused; },
          set focused(value: boolean) {
            focused = value;
            editor.focused = value;
          },
          render,
          handleInput,
          invalidate,
        };
      });

      const abortHandler = (): void => finishFromAbort?.();
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
      let result: QuestionSelection;
      try {
        result = await resultPromise;
      } finally {
        signal?.removeEventListener("abort", abortHandler);
      }

      const simpleOptions = params.options.map((option) => option.label);
      if (result.kind === "aborted") throw new Error("Question cancelled because the agent operation was aborted");
      if (result.kind === "cancelled") {
        return {
          content: [{ type: "text", text: "User cancelled the question" }],
          details: { question: params.question, options: simpleOptions, answer: null, cancelled: true },
        };
      }
      if (result.kind === "custom") {
        return {
          content: [{ type: "text", text: `User wrote: ${result.answer}` }],
          details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: true },
        };
      }
      return {
        content: [{ type: "text", text: `User selected: ${result.answer}` }],
        details: {
          question: params.question,
          options: simpleOptions,
          answer: result.answer,
          selectedIndex: result.originalIndex,
          wasCustom: false,
        },
      };
    },

    renderCall(args, theme) {
      let text = `${theme.fg("toolTitle", theme.bold("question "))}${theme.fg("muted", args.question)}`;
      if (args.options.length) {
        const numbered = [...args.options.map((option) => option.label), "Type a custom answer"]
          .map((option, index) => `${index + 1}. ${option}`);
        text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled || details.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      if (details.wasCustom) {
        return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", "(wrote) ")}${theme.fg("accent", details.answer)}`, 0, 0);
      }
      return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", details.answer)}`, 0, 0);
    },
  });
}

const PERSONAL_INSTRUCTIONS_FILE = "AGENTS.local.md";
const PERSONAL_INSTRUCTIONS_LIMIT = 32 * 1024;

function readBoundedText(filePath: string, limit = PERSONAL_INSTRUCTIONS_LIMIT): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.alloc(limit + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const content = buffer.toString("utf8", 0, Math.min(bytesRead, limit));
    if (!content.trim()) return undefined;
    return bytesRead > limit
      ? `${content}\n\n[Personal instructions truncated by KillerOS]`
      : content;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore cleanup failures after a bounded best-effort read.
      }
    }
  }
}

function resolvePersonalInstructions(cwd: string): { content: string; source: string } | undefined {
  const localPath = path.join(cwd, PERSONAL_INSTRUCTIONS_FILE);
  const local = readBoundedText(localPath);
  if (!local) return undefined;

  const importMatch = local.trim().match(/^@(.+)$/u);
  if (!importMatch) return { content: local, source: localPath };

  const requestedPath = importMatch[1]!.trim();
  const importedPath = requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
    ? path.join(os.homedir(), requestedPath.slice(2))
    : path.resolve(cwd, requestedPath);
  const imported = readBoundedText(importedPath);
  return imported ? { content: imported, source: importedPath } : { content: local, source: localPath };
}

function registerPersonalInstructions(pi: ExtensionAPI, initState: InitWorkflowState): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (initState.active || !ctx.isProjectTrusted()) return;
    const personal = resolvePersonalInstructions(ctx.cwd);
    if (!personal) return;
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        `<personal_instructions source="${personal.source}">`,
        personal.content,
        "</personal_instructions>",
      ].join("\n"),
    };
  });
}

type KillerosHookEvent = "tool_call" | "tool_result" | "agent_settled";

interface KillerosHook {
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

interface KillerosHookConfig {
  hooks?: Partial<Record<KillerosHookEvent, KillerosHook[]>>;
}

interface HookExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const HOOK_EVENTS: readonly KillerosHookEvent[] = ["tool_call", "tool_result", "agent_settled"];
const HOOK_OUTPUT_LIMIT = 16 * 1024;

function loadKillerosHooks(ctx: ExtensionContext): KillerosHookConfig {
  const configPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "killeros-hooks.json");
  if (!existsSync(configPath)) return {};
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(`Ignored untrusted project hooks in ${configPath}`, "warning");
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as KillerosHookConfig;
    const hooks: KillerosHookConfig["hooks"] = {};
    for (const event of HOOK_EVENTS) {
      const candidates = parsed.hooks?.[event];
      if (!Array.isArray(candidates)) continue;
      hooks[event] = candidates.filter((hook, index) => {
        const valid = hook
          && typeof hook.command === "string"
          && hook.command.trim().length > 0
          && (hook.matcher === undefined || typeof hook.matcher === "string")
          && (hook.timeoutMs === undefined || Number.isFinite(hook.timeoutMs));
        if (!valid) {
          ctx.ui.notify(`Ignored invalid ${event} hook ${index + 1} in ${configPath}`, "warning");
          return false;
        }
        if (hook.matcher && hook.matcher !== "*") {
          try {
            new RegExp(hook.matcher, "u");
          } catch {
            ctx.ui.notify(`Ignored ${event} hook ${index + 1}: invalid matcher ${JSON.stringify(hook.matcher)}`, "warning");
            return false;
          }
        }
        return true;
      });
    }
    return { hooks };
  } catch (error) {
    reportError(ctx, `Invalid ${CONFIG_DIR_NAME}/killeros-hooks.json`, error);
    return {};
  }
}

function matchesHook(hook: KillerosHook, value: string): boolean {
  if (!hook.matcher || hook.matcher === "*") return true;
  try {
    return new RegExp(hook.matcher, "u").test(value);
  } catch {
    return false;
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (current.length >= HOOK_OUTPUT_LIMIT) return current;
  return (current + chunk.toString()).slice(0, HOOK_OUTPUT_LIMIT);
}

function executeHook(command: string, cwd: string, environment: Record<string, string>, timeoutMs = 30_000): Promise<HookExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env: { ...process.env, ...environment },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let completed = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number): void => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      stderr = appendBounded(stderr, error.message);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref?.();
      finish(124);
    }, Math.max(1_000, Math.min(timeoutMs, 300_000)));
    timer.unref?.();
  });
}

function hookEnvironment(event: KillerosHookEvent, toolName = "", payload: unknown = {}): Record<string, string> {
  return {
    KILLEROS_EVENT: event,
    KILLEROS_TOOL: toolName,
    KILLEROS_PAYLOAD: JSON.stringify(payload).slice(0, 8_000),
  };
}

function hookFailureMessage(hook: KillerosHook, result: HookExecutionResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return `Hook failed${result.timedOut ? " (timed out)" : ""}: ${hook.command}\n${detail}`;
}

function registerLifecycleHooks(pi: ExtensionAPI): void {
  let config: KillerosHookConfig = {};
  pi.on("session_start", (_event, ctx) => { config = loadKillerosHooks(ctx); });

  pi.on("tool_call", async (event, ctx) => {
    for (const hook of config.hooks?.tool_call ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await executeHook(
        hook.command,
        ctx.cwd,
        hookEnvironment("tool_call", event.toolName, event.input),
        hook.timeoutMs,
      );
      if (result.code !== 0) {
        const reason = hookFailureMessage(hook, result);
        ctx.ui.notify(reason, "error");
        return { block: true, reason };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    for (const hook of config.hooks?.tool_result ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await executeHook(
        hook.command,
        ctx.cwd,
        hookEnvironment("tool_result", event.toolName, {
          input: event.input,
          isError: event.isError,
        }),
        hook.timeoutMs,
      );
      if (result.code !== 0) ctx.ui.notify(hookFailureMessage(hook, result), "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    for (const hook of config.hooks?.agent_settled ?? []) {
      const result = await executeHook(
        hook.command,
        ctx.cwd,
        hookEnvironment("agent_settled"),
        hook.timeoutMs,
      );
      if (result.code !== 0) ctx.ui.notify(hookFailureMessage(hook, result), "error");
    }
  });
}

const INIT_SURVEY_OUTPUT_LIMIT = 40 * 1024;
const INIT_SURVEY_FILE_LIMIT = 8 * 1024;
const INIT_SURVEY_PATH_LIMIT = 400;
const INIT_SURVEY_DIRECTORY_LIMIT = 120;
const INIT_SURVEY_DEPTH_LIMIT = 4;
const INIT_SURVEY_EXCLUDED_DIRS = new Set([
  ".agents", ".claude", ".git", ".next", ".pi", ".pytest_cache", ".turbo", ".venv", "__pycache__", "archive", "build", "coverage", "data", "dist", "logs", "node_modules", "target", "test-results", "vendor",
]);
const INIT_SURVEY_EXCLUDED_FILES = new Set([
  ".cursorrules", "AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "MEMORY.md", "SKILL.md", "copilot-instructions.md",
]);
const INIT_SURVEY_ROOT_FILES = [
  "README.md",
  "README.rst",
  "README.txt",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "Dockerfile",
  "compose.yaml",
  "compose.yml",
  "config.yaml",
  "config.yml",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
] as const;
const INIT_SURVEY_NESTED_FILES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod",
]);

async function collectInitProjectFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];
  let directoriesRead = 0;
  while (queue.length && files.length < INIT_SURVEY_PATH_LIMIT && directoriesRead < INIT_SURVEY_DIRECTORY_LIMIT) {
    const current = queue.shift()!;
    directoriesRead += 1;
    let entries;
    try {
      entries = await fs.readdir(path.join(cwd, current.relativePath), { withFileTypes: true });
    } catch (error) {
      if (!current.relativePath) throw error;
      continue;
    }
    entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
    for (const entry of entries) {
      if (files.length >= INIT_SURVEY_PATH_LIMIT) break;
      const relativePath = path.join(current.relativePath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < INIT_SURVEY_DEPTH_LIMIT && !INIT_SURVEY_EXCLUDED_DIRS.has(entry.name)) {
          queue.push({ relativePath, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && !INIT_SURVEY_EXCLUDED_FILES.has(entry.name)) {
        files.push(relativePath.replaceAll("\\", "/"));
      }
    }
  }
  return files;
}

async function readFilePrefix(filePath: string, limit: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function runInitSurvey(
  cwd: string,
): Promise<{ output: string; error?: string }> {
  let projectFiles: string[];
  try {
    projectFiles = await collectInitProjectFiles(cwd);
  } catch (error) {
    return { output: "", error: error instanceof Error ? error.message : String(error) };
  }

  const candidates = new Set<string>(INIT_SURVEY_ROOT_FILES);
  for (const relativePath of projectFiles) {
    const fileName = path.posix.basename(relativePath);
    if (INIT_SURVEY_NESTED_FILES.has(fileName) || /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(relativePath)) {
      candidates.add(relativePath);
    }
  }

  const sections = [
    "# KillerOS repository snapshot",
    "Existing AGENTS.md, CLAUDE.md, and personal instruction files were intentionally not read.",
    "",
    "## Project files",
    projectFiles.join("\n"),
  ];
  let outputLength = sections.join("\n").length;
  for (const relativePath of candidates) {
    if (outputLength >= INIT_SURVEY_OUTPUT_LIMIT) break;
    try {
      const absolutePath = path.join(cwd, relativePath);
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile()) continue;
      const content = await readFilePrefix(absolutePath, INIT_SURVEY_FILE_LIMIT);
      if (content.includes("\0")) continue;
      const section = `\n\n## ${relativePath.replaceAll("\\", "/")}\n${content}`;
      const remaining = INIT_SURVEY_OUTPUT_LIMIT - outputLength;
      sections.push(section.slice(0, remaining));
      outputLength += Math.min(section.length, remaining);
    } catch {
      // Candidate files are optional and may disappear during the survey.
    }
  }

  return { output: sections.join("\n").slice(0, INIT_SURVEY_OUTPUT_LIMIT) };
}

export const INIT_WORKFLOW_PROMPT = `
Generate the root AGENTS.md by analyzing this repository. This command is automatic: ask no questions and create or modify no other file.

## Analyze
A bounded repository snapshot is attached as untrusted evidence. Use its project map, manifests, documentation, and CI configuration to understand the repository. Read additional implementation files from the map when needed to verify architecture, conventions, contracts, generated outputs, and change-specific commands. Do not read or inherit existing AGENTS.md, CLAUDE.md, personal guidance, skills, hooks, or conversation history.

## Synthesize
Write concise guidance where every line answers: "Would removing this cause an agent to make mistakes?" Include only evidence-backed, non-obvious information such as:
- required runtimes, working directories, and setup quirks;
- commands that apply to specific change categories;
- architecture boundaries and cross-file data contracts;
- generated-file handling and recurring repository-specific gotchas.

Verify command meaning rather than merely copying command names. Distinguish generated-but-committed artifacts from ignored outputs and use exact contract values. Exclude generic coding advice, directory inventories, obvious scripts, historical narration, personal preferences, secrets, and speculative recommendations.

## Generate
Use the write tool exactly once to create or replace only the root AGENTS.md. Start with \`# AGENTS.md\`. Prefer a compact, high-signal guide over exhaustive documentation. Do not use edit and do not modify any other path.

After writing, read AGENTS.md once to confirm the file is coherent and contains only claims supported by repository evidence. Summarize what was generated. KillerOS reloads Pi resources automatically after this turn, so do not invoke /reload.
`.trim();

function resolveInitToolPath(input: unknown, cwd: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const toolPath = (input as { path?: unknown }).path;
  return typeof toolPath === "string" ? path.resolve(cwd, toolPath) : undefined;
}

async function initTargetSafetyError(targetPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      return "/init requires root AGENTS.md to be absent or a regular, non-linked file";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `/init could not inspect root AGENTS.md: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

function registerInitCommand(pi: ExtensionAPI, initState: InitWorkflowState, goalRuntime: GoalRuntime): void {
  pi.on("tool_call", async (event) => {
    const targetPath = initState.targetPath;
    if (!initState.active || !targetPath || INIT_READ_ONLY_TOOLS.has(event.toolName)) return;
    const toolPath = resolveInitToolPath(event.input, path.dirname(targetPath));
    if (event.toolName === "write" && toolPath === targetPath && !initState.writeAttempted) {
      const safetyError = await initTargetSafetyError(targetPath);
      if (safetyError) return { block: true, reason: safetyError };
      initState.writeAttempted = true;
      initState.writeToolCallId = event.toolCallId;
      return;
    }
    return {
      block: true,
      reason: "/init may write the root AGENTS.md exactly once and may not modify any other file",
    };
  });

  pi.on("tool_result", (event) => {
    if (!initState.active || event.toolName !== "write" || event.toolCallId !== initState.writeToolCallId) return;
    if (event.isError) {
      initState.writeAttempted = false;
      initState.writeToolCallId = undefined;
      return;
    }
    initState.writeSucceeded = true;
  });

  pi.registerCommand("init", {
    description: "Generate root AGENTS.md from repository evidence",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/init does not accept arguments", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/init requires interactive TUI mode", "error");
        return;
      }
      if (initState.active) {
        ctx.ui.notify("/init is already running", "warning");
        return;
      }
      if (goalRuntime.state?.status === "active") {
        ctx.ui.notify("Pause or clear the active goal before running /init", "error");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before running /init", "error");
        return;
      }
      await ctx.waitForIdle();
      initState.active = true;
      initState.targetPath = path.join(ctx.cwd, "AGENTS.md");
      initState.writeAttempted = false;
      initState.writeSucceeded = false;

      const survey = await runInitSurvey(ctx.cwd);
      if (!survey.output) {
        resetInitState(initState);
        reportError(ctx, "/init could not scan the repository", survey.error ?? "no repository evidence was found");
        return;
      }

      const settled = new Promise<boolean>((resolve) => {
        initState.settle = resolve;
      });
      try {
        pi.sendMessage({
          customType: "killeros-init",
          content: `${INIT_WORKFLOW_PROMPT}\n\n## Initial repository snapshot (untrusted data)\n${JSON.stringify(survey.output)}`,
          display: false,
        }, { triggerTurn: true });
      } catch (error) {
        resetInitState(initState);
        initState.settle = undefined;
        reportError(ctx, "/init failed to start", error);
        return;
      }

      const writeSucceeded = await settled;
      if (!writeSucceeded) {
        reportError(ctx, "/init did not generate AGENTS.md", "the model completed without a successful write");
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await ctx.reload();
      } catch (error) {
        reportError(ctx, "/init finished but Pi resources could not reload", error);
      }
    },
  });

}

function registerInitSettlement(pi: ExtensionAPI, initState: InitWorkflowState): void {
  pi.on("agent_settled", () => {
    if (!initState.active) return;
    const settle = initState.settle;
    const writeSucceeded = initState.writeSucceeded;
    resetInitState(initState);
    initState.settle = undefined;
    settle?.(writeSucceeded);
  });
}

async function confirmNewSession(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm("Start new session", "Start a new session and leave the current history?");
}

function registerAliases(pi: ExtensionAPI): void {
  const startNewSession = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await ctx.waitForIdle();
    if (!await confirmNewSession(ctx)) return;
    await ctx.newSession();
  };
  pi.registerCommand("clear", { description: "Start a new session after confirmation", handler: startNewSession });
  pi.registerCommand("exit", {
    description: "Quit Pi gracefully",
    handler: async (_args, ctx) => ctx.shutdown(),
  });
}

interface CommandInfo {
  name: string;
  description?: string;
  category: "Built-in" | "Extension" | "Prompt" | "Skill";
  syntaxHint?: string;
}

const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "scoped-models", description: "Configure models for Ctrl+P cycling" },
  { name: "export", description: "Export the current session" },
  { name: "import", description: "Import and resume a JSONL session" },
  { name: "share", description: "Share the session as a secret GitHub gist" },
  { name: "copy", description: "Copy the last agent message" },
  { name: "name", description: "Set the session display name" },
  { name: "session", description: "Show session usage and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Fork from a previous user message" },
  { name: "clone", description: "Duplicate the session at the current position" },
  { name: "tree", description: "Navigate the session tree" },
  { name: "trust", description: "Save the project trust decision" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload extensions and resources" },
  { name: "quit", description: "Quit Pi" },
];

const COMMAND_SYNTAX_HINTS: Readonly<Record<string, string>> = {
  goal: "/goal [objective|clear|edit|pause|resume]",
  variants: "/variants [level]",
  model: "/model [provider/model]",
  "scoped-models": "/scoped-models",
  login: "/login [provider]",
  export: "/export [filename]",
  import: "/import [path]",
  name: "/name [session-name]",
};

interface TaggedAutocompleteItem extends AutocompleteItem {
  killerosCommand?: string;
}

function scoreCommandMatch(name: string, prefix: string): number {
  if (!prefix) return 1;
  const normalizedName = name.toLocaleLowerCase();
  const normalizedPrefix = prefix.toLocaleLowerCase();
  if (normalizedName.startsWith(normalizedPrefix)) return 100;
  if (normalizedName.split(/[:\-_]/).some((token) => token.startsWith(normalizedPrefix))) return 80;
  if (normalizedName.includes(normalizedPrefix)) return 50;
  return 0;
}

function registerSlashAutocomplete(pi: ExtensionAPI): void {
  const usage = new Map<string, number>();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["/"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/(?:^|[ \t])\/([^\s/]*)$/);
        if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const prefix = (match[1] ?? "").toLocaleLowerCase();
        const baseSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const commands = new Map<string, CommandInfo>();
        BUILTIN_COMMANDS.forEach((command) => commands.set(command.name, {
          ...command,
          category: "Built-in",
          syntaxHint: COMMAND_SYNTAX_HINTS[command.name],
        }));

        for (const command of pi.getCommands()) {
          const category: CommandInfo["category"] = command.source === "skill"
            ? "Skill"
            : command.source === "prompt"
              ? "Prompt"
              : "Extension";
          commands.set(command.name, {
            name: command.name,
            description: command.description,
            category,
            syntaxHint: COMMAND_SYNTAX_HINTS[command.name],
          });
        }

        for (const item of baseSuggestions?.items ?? []) {
          const name = (item.value || item.label).replace(/^\//, "").trim().split(/\s+/)[0] ?? "";
          if (name && !commands.has(name)) {
            commands.set(name, { name, description: item.description, category: "Built-in" });
          }
        }

        const ranked = [...commands.values()]
          .map((command) => ({
            command,
            score: scoreCommandMatch(command.name, prefix) + Math.min((usage.get(command.name) ?? 0) * 2, 15),
          }))
          .filter(({ command }) => scoreCommandMatch(command.name, prefix) > 0)
          .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name));
        if (!ranked.length) return baseSuggestions;

        return {
          prefix: `/${prefix}`,
          items: ranked.map(({ command }): TaggedAutocompleteItem => {
            const syntax = command.syntaxHint ? `${command.syntaxHint} — ` : "";
            return {
              value: `/${command.name} `,
              label: `/${command.name}`,
              description: `[${command.category}] ${syntax}${command.description ?? ""}`.trim(),
              killerosCommand: command.name,
            };
          }),
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const tagged = item as TaggedAutocompleteItem;
        if (!tagged.killerosCommand) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        usage.set(tagged.killerosCommand, (usage.get(tagged.killerosCommand) ?? 0) + 1);
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        let afterCursor = line.slice(cursorCol);
        const match = beforeCursor.match(/(?:^|[ \t])\/([^\s/]*)$/);
        if (!match || match.index === undefined) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        const slashIndex = match.index + (match[0].startsWith("/") ? 0 : 1);
        const newBefore = beforeCursor.slice(0, slashIndex) + item.value;
        if (item.value.endsWith(" ") && afterCursor.startsWith(" ")) afterCursor = afterCursor.trimStart();
        const nextLines = [...lines];
        nextLines[cursorLine] = newBefore + afterCursor;
        return { lines: nextLines, cursorLine, cursorCol: newBefore.length };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const ALL_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Maximum",
};
const LEVEL_DESCRIPTIONS: Readonly<Record<ThinkingLevel, string>> = {
  off: "No extended reasoning",
  minimal: "Brief reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extensive reasoning",
  max: "Maximum supported reasoning",
};
const LEVEL_COLORS: Readonly<Record<ThinkingLevel, ThemeColor>> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};
const LEVEL_ALIASES: Readonly<Record<string, ThinkingLevel>> = {
  quick: "minimal",
  fast: "minimal",
  light: "low",
  balanced: "medium",
  deep: "high",
  maximum: "max",
  none: "off",
};

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (ALL_LEVELS as readonly string[]).includes(value);
}

function resolveThinkingLevel(input: string): ThinkingLevel | undefined {
  const normalized = input.trim().toLocaleLowerCase();
  return isThinkingLevel(normalized) ? normalized : LEVEL_ALIASES[normalized];
}

function supportedLevels(model: ExtensionContext["model"]): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return ALL_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" || mapped !== undefined;
  });
}

function modelLabel(model: ExtensionContext["model"]): string {
  return model ? `${model.provider}/${model.id}` : "unknown model";
}

function registerVariants(pi: ExtensionAPI): void {
  const setLevel = (ctx: ExtensionContext, level: ThinkingLevel): void => {
    const supported = supportedLevels(ctx.model);
    if (!supported.includes(level)) {
      ctx.ui.notify(`${LEVEL_LABELS[level]} is not supported by ${modelLabel(ctx.model)}. Supported: ${supported.join(", ")}`, "warning");
      return;
    }
    pi.setThinkingLevel(level);
    ctx.ui.notify(`Thinking: ${LEVEL_LABELS[level]}`, "info");
  };

  pi.registerCommand("variants", {
    description: "Set reasoning level: off, minimal, low, medium, high, xhigh, or max",
    handler: async (args, ctx) => {
      if (args.trim()) {
        const level = resolveThinkingLevel(args);
        if (!level) {
          ctx.ui.notify(`Unknown reasoning level "${args.trim()}". Use: ${ALL_LEVELS.join(", ")}`, "error");
          return;
        }
        setLevel(ctx, level);
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Use /variants <level> outside TUI mode", "error");
        return;
      }

      const supported = supportedLevels(ctx.model);
      if (supported.length === 1) {
        ctx.ui.notify(`${modelLabel(ctx.model)} does not support extended reasoning`, "info");
        return;
      }
      const current = pi.getThinkingLevel() as ThinkingLevel;
      const items = supported.map((level) => ({
        value: level,
        label: level === current ? `${LEVEL_LABELS[level]} ← current` : LEVEL_LABELS[level],
        description: LEVEL_DESCRIPTIONS[level],
      }));
      const selected = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Thinking variants")), 1, 0));
        container.addChild(new Text(theme.fg("dim", `Model: ${modelLabel(ctx.model)}`), 1, 0));
        container.addChild(new Text("", 0, 0));
        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        selectList.onSelect = (item) => done(isThinkingLevel(item.value) ? item.value : null);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text("", 0, 0));
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return {
          render: (width) => container.render(width).map((line) => truncateToWidth(line, width, "")),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });
      if (selected) setLevel(ctx, selected);
    },
  });
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  return `$${usd.toFixed(2)}`;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatTokens(value: number): string {
  const amount = Math.max(0, value);
  if (amount < 1_000) return `${Math.round(amount)}`;
  if (amount >= 1_000_000) {
    const precision = amount >= 10_000_000 ? 0 : 1;
    return `${Number((amount / 1_000_000).toFixed(precision))}M`;
  }
  const precision = amount >= 100_000 ? 0 : 1;
  return `${Number((amount / 1_000).toFixed(precision))}k`;
}

export function formatContextProgress(tokensUsed: number | null, contextWindow: number, theme: Theme): string {
  if (tokensUsed === null) return theme.fg("dim", "—% left (—)");
  const windowSize = contextWindow > 0 ? contextWindow : 128_000;
  const remaining = Math.max(0, Math.min(windowSize, windowSize - Math.max(0, tokensUsed)));
  const percentLeft = Math.max(0, Math.min(100, Math.round((remaining / windowSize) * 100)));
  const color: ThemeColor = percentLeft < 20 ? "error" : percentLeft <= 50 ? "warning" : "success";
  const action = percentLeft < 15 ? " · /compact" : "";
  return theme.fg(color, `${percentLeft}% left (${formatTokens(remaining)})${action}`);
}

function sumSessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") total += entry.message.usage.cost.total;
    else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      total += entry.message.usage.cost.total;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      total += entry.usage.cost.total;
    }
  }
  return total;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai-responses": "Azure OpenAI",
  "github-copilot": "GitHub Copilot",
  "google-vertex": "Google Vertex",
  "openai-codex": "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  ollama: "Ollama",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  deepseek: "DeepSeek",
  github: "GitHub",
  llm: "LLM",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

function formatProviderName(provider: string): string {
  const normalized = provider.trim();
  const known = PROVIDER_LABELS[normalized.toLocaleLowerCase()];
  if (known) return known;
  return normalized
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => PROVIDER_WORDS[word.toLocaleLowerCase()] ?? `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ") || "Unknown provider";
}

function modelDisplayName(model: NonNullable<ExtensionContext["model"]>): string {
  return model.name?.trim() || model.id;
}

function formatModel(model: ExtensionContext["model"], theme: Theme, includeProvider = true): string {
  if (!model) return theme.fg("dim", "No model");
  const name = theme.fg("text", theme.bold(modelDisplayName(model)));
  return includeProvider ? `${name} ${theme.fg("dim", formatProviderName(model.provider))}` : name;
}

function compactDirectory(cwd: string): string {
  if (cwd === "~" || cwd === "/" || /^[A-Za-z]:[\\/]?$/u.test(cwd)) return cwd;
  const normalized = cwd.replace(/\\/gu, "/").replace(/\/$/u, "");
  const finalSegment = normalized.split("/").at(-1);
  return finalSegment ? `…/${finalSegment}` : cwd;
}

function joinFooterParts(parts: string[], theme: Theme): string {
  return parts.filter(Boolean).join(theme.fg("dim", " · "));
}

function footerRowFits(left: string, right: string, width: number): boolean {
  const contentWidth = visibleWidth(left) + (right ? visibleWidth(right) + 1 : 0);
  return contentWidth + 2 <= width;
}

function renderFooterRow(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width < 3) return " ".repeat(width);

  const innerWidth = width - 2;
  if (!right) return ` ${padRight(left, innerWidth)} `;

  const clippedRight = truncateToWidth(right, innerWidth, "");
  const rightWidth = visibleWidth(clippedRight);
  const leftBudget = Math.max(0, innerWidth - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, leftBudget, "…");
  const gap = " ".repeat(Math.max(0, innerWidth - visibleWidth(clippedLeft) - rightWidth));
  return ` ${clippedLeft}${gap}${clippedRight} `;
}

function formatGoalFooter(state: GoalState | undefined, theme: Theme): string {
  if (!state) return "";
  if (state.status === "active") return theme.fg("accent", `✻ goal · ${formatTime(goalElapsedMilliseconds(state))}`);
  if (state.status === "paused") return theme.fg("warning", "Ⅱ goal paused");
  if (state.status === "blocked") return theme.fg("error", "! goal blocked");
  return theme.fg("success", "✓ goal complete");
}

function registerFooter(pi: ExtensionAPI, goalRuntime: GoalRuntime): void {
  let currentModel: ExtensionContext["model"];
  let thinkingLevel: ThinkingLevel = "off";
  let activeTui: TUI | undefined;
  goalRuntime.requestRender = () => activeTui?.requestRender();

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const sessionStart = Date.now();
    currentModel = ctx.model;
    thinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
    const cwd = formatCwd(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const refreshTimer = setInterval(() => tui.requestRender(), FOOTER_REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
      return {
        dispose() {
          unsubscribe();
          clearInterval(refreshTimer);
          if (activeTui === tui) activeTui = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          if (width <= 0) return [];
          const model = currentModel ?? ctx.model;
          const level = model?.reasoning === false
            ? theme.fg("thinkingOff", "no reasoning")
            : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
          const usage = ctx.getContextUsage();
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 128_000;
          const context = formatContextProgress(usage?.tokens ?? null, contextWindow, theme);
          const branch = footerData.getGitBranch();
          const signature = formatModel(model, theme);
          const fullDirectory = theme.fg("dim", cwd);
          const focusedDirectory = theme.fg("dim", compactDirectory(cwd));
          const goal = formatGoalFooter(goalRuntime.state, theme);
          const rich = joinFooterParts([
            signature,
            level,
            context,
            goal,
            branch ? theme.fg("dim", branch) : "",
            theme.fg("dim", formatTime(Date.now() - sessionStart)),
            theme.fg("dim", formatCost(sumSessionCost(ctx))),
          ], theme);
          const focused = joinFooterParts([signature, context, goal], theme);

          if (footerRowFits(rich, fullDirectory, width)) {
            return [renderFooterRow(rich, fullDirectory, width)];
          }
          if (footerRowFits(rich, focusedDirectory, width)) {
            return [renderFooterRow(rich, focusedDirectory, width)];
          }
          if (footerRowFits(focused, focusedDirectory, width)) {
            return [renderFooterRow(focused, focusedDirectory, width)];
          }
          if (footerRowFits(focused, "", width)) {
            return [renderFooterRow(focused, "", width)];
          }
          if (goal) {
            const essentialGoal = joinFooterParts([context, goal], theme);
            if (footerRowFits(essentialGoal, "", width)) return [renderFooterRow(essentialGoal, "", width)];
            return [renderFooterRow(goal, context, width)];
          }

          const essentialModel = formatModel(model, theme, false);
          return [renderFooterRow(essentialModel, context, width)];
        },
      };
    });
  });

  pi.on("model_select", (event) => {
    currentModel = event.model;
    activeTui?.requestRender();
  });
  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level;
    activeTui?.requestRender();
  });
  pi.on("session_shutdown", () => {
    activeTui = undefined;
    goalRuntime.requestRender = undefined;
  });
}

export default function Killeros(pi: ExtensionAPI): void {
  const initState: InitWorkflowState = {
    active: false,
    writeAttempted: false,
    writeSucceeded: false,
  };
  const goalRuntime: GoalRuntime = {
    continuationScheduled: false,
    continuationHeld: false,
    goalTurnInFlight: false,
    agentEndObserved: false,
    persistenceRetryNeeded: false,
  };
  registerShellUi(pi);
  registerConcisePrompt(pi);
  registerGoal(pi, goalRuntime, initState);
  registerPersonalInstructions(pi, initState);
  registerQuestionTool(pi);
  registerAliases(pi);
  registerSlashAutocomplete(pi);
  registerFooter(pi, goalRuntime);
  registerVariants(pi);
  registerInitCommand(pi, initState, goalRuntime);
  registerLifecycleHooks(pi);
  registerGoalSettlement(pi, goalRuntime, initState);
  registerInitSettlement(pi, initState);
}
