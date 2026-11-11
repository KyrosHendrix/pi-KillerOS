import { watch } from "node:fs";
import { type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { isCodexFastEnabled, isCodexFastModel, subscribeCodexFast } from "./codex-fast-state.ts";
import { colorDirectory, formatCwd, formatTime, modelDisplayName, padRight } from "./display.ts";
import { entryUsage, readContextUsage } from "./pi-context.ts";
import { resolveGitFileChanges, type GitFileChanges } from "./passive-git-status.ts";
import { goalElapsedMilliseconds } from "./goal-state.ts";
import { onGoalChange, type GoalRuntime, type GoalState } from "./goal-model.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const LEVEL_COLORS: Readonly<Record<ThinkingLevel, ThemeColor>> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const GIT_STATUS_WATCH_DEBOUNCE_MS = 250;
/**
 * Minimum time between watch-triggered scans. KILLEROS_FOOTER_WATCH_INTERVAL_MS can only shorten it, so end-to-end
 * tests need not sit through the cooldown; FooterGitSchedule.test.ts checks the real five seconds on mocked timers.
 */
const watchIntervalOverride = Number(process.env.KILLEROS_FOOTER_WATCH_INTERVAL_MS);
const GIT_STATUS_WATCH_INTERVAL_MS = Number.isSafeInteger(watchIntervalOverride) && watchIntervalOverride > 0
  ? Math.min(watchIntervalOverride, 5_000) : 5_000;

/** Coalesces file-change scans to one active scan and one queued follow-up, and emits only successful results. */
function createGitFileChangesRefresh(
  resolveChanges: () => Promise<GitFileChanges | undefined>,
  onChanges: (changes: GitFileChanges) => void,
): { request: () => void; dispose: () => void } {
  let disposed = false;
  let pending = false;
  let queued = false;
  const request = (): void => {
    if (disposed) return;
    if (pending) {
      queued = true;
      return;
    }
    pending = true;
    void resolveChanges().then(
      (changes) => { if (!disposed && changes !== undefined) onChanges(changes); },
      () => undefined,
    ).finally(() => {
      pending = false;
      if (!disposed && queued) {
        queued = false;
        request();
      }
    });
  };
  return {
    request,
    dispose() {
      disposed = true;
      queued = false;
    },
  };
}

type ScheduleFallback = (refresh: () => void, intervalMs: number) => () => void;
type WatchDirectory = (cwd: string, onChange: () => void, onError: () => void) => () => void;
type ScheduleDelay = (refresh: () => void, delayMs: number) => () => void;

const scheduleFallback: ScheduleFallback = (refresh, intervalMs) => {
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

const watchDirectory: WatchDirectory = (cwd, onChange, onError) => {
  const watcher = watch(cwd, { recursive: true }, onChange);
  watcher.on("error", onError);
  return () => watcher.close();
};

const scheduleDelay: ScheduleDelay = (refresh, delayMs) => {
  const timer = setTimeout(refresh, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** Schedules the fallback Git scan independently from footer rendering. */
export function scheduleGitStatusFallback(
  refresh: () => void,
  schedule: ScheduleFallback = scheduleFallback,
): () => void {
  return schedule(refresh, GIT_STATUS_REFRESH_INTERVAL_MS);
}

/** Throttles filesystem changes and falls back silently when watching is unavailable. */
export function scheduleGitStatusWatch(
  cwd: string,
  refresh: () => void,
  startWatching: WatchDirectory = watchDirectory,
  schedule: ScheduleDelay = scheduleDelay,
): () => void {
  let disposed = false;
  let coolingDown = false;
  let queued = false;
  let stopTimer: (() => void) | undefined;
  let stopWatching: (() => void) | undefined;
  const stop = (): void => {
    if (disposed) return;
    disposed = true;
    stopTimer?.();
    stopTimer = undefined;
    stopWatching?.();
    stopWatching = undefined;
  };
  const changed = (): void => {
    if (disposed) return;
    if (stopTimer) {
      if (coolingDown) queued = true;
      return;
    }
    stopTimer = schedule(() => {
      stopTimer = undefined;
      if (disposed) return;
      refresh();
      coolingDown = true;
      stopTimer = schedule(() => {
        stopTimer = undefined;
        coolingDown = false;
        if (queued) {
          queued = false;
          changed();
        }
      }, GIT_STATUS_WATCH_INTERVAL_MS);
    }, GIT_STATUS_WATCH_DEBOUNCE_MS);
  };
  try {
    stopWatching = startWatching(cwd, changed, stop);
  } catch {
    disposed = true;
  }
  return stop;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  return `$${usd.toFixed(2)}`;
}

export function contextPercentRemaining(ctx: Pick<ExtensionContext, "getContextUsage">): number | null {
  const usage = readContextUsage(ctx);
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  if (usage.tokens === null || !Number.isFinite(usage.tokens)) return null;

  const percentRemaining = ((usage.contextWindow - Math.max(0, usage.tokens)) / usage.contextWindow) * 100;
  return Math.round(Math.max(0, Math.min(100, percentRemaining)));
}

function validCapacity(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function formatContextTokens(tokens: number): string {
  const unit = tokens >= 1_000_000 ? 1_000_000 : tokens >= 1_000 ? 1_000 : 1;
  // Floor labels so rounding never promises tokens that are not available.
  const count = unit === 1 ? Math.floor(tokens) : Math.floor(tokens / (unit / 100)) / 100;
  return `${count}${unit === 1_000_000 ? "M" : unit === 1_000 ? "K" : ""}`;
}

export function formatContextProgress(
  tokensUsed: number | null,
  contextWindow: number,
  theme: Theme,
  showManualHint = false,
  detail: "full" | "capacity" | "percentage" = "full",
): string {
  if (!validCapacity(contextWindow)) return theme.fg("dim", "ctx —%");
  const capacity = detail === "percentage" ? "" : ` (${formatContextTokens(contextWindow)})`;
  if (tokensUsed === null || !Number.isFinite(tokensUsed)) return theme.fg("dim", `ctx —%${capacity}`);
  const remaining = Math.max(0, contextWindow - Math.max(0, tokensUsed));
  const percentRemaining = Math.round(remaining / contextWindow * 100);
  const color: ThemeColor = percentRemaining > 50 ? "success" : percentRemaining >= 20 ? "warning" : "error";
  const counts = detail === "full" ? ` (${formatContextTokens(remaining)}/${formatContextTokens(contextWindow)})` : capacity;
  const action = showManualHint && percentRemaining <= 15 ? " · /compact" : "";
  return theme.fg(color, `ctx ${percentRemaining}%${counts}${action}`);
}

function sumSessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) total += entryUsage(entry)?.cost.total ?? 0;
  return total;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "Amazon Bedrock",
  azure: "Azure",
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

function formatProviderName(provider: string): string {
  const normalized = safeTerminalText(provider).replaceAll("\n", "").trim();
  const known = PROVIDER_LABELS[normalized.toLowerCase()];
  if (known) return known.toLowerCase();
  return normalized.toLowerCase().split(/[-_]+/u).filter(Boolean).join(" ") || "unknown provider";
}

function formatModel(
  model: ExtensionContext["model"],
  theme: Theme,
  includeProvider = true,
  showCodexFast = false,
): string {
  if (!model) return theme.fg("dim", "no model");
  const displayName = modelDisplayName(model) || "unknown model";
  const name = theme.fg("text", displayName);
  const fast = showCodexFast && isCodexFastModel(model) ? theme.fg("text", "fast") : "";
  const provider = includeProvider ? theme.fg("dim", formatProviderName(model.provider)) : "";
  return [name, fast, provider].filter(Boolean).join(" ");
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

function renderFooter(rows: string[], width: number, theme: Theme): string[] {
  return [theme.fg("borderMuted", "─".repeat(width)), ...rows];
}

function formatGoalFooter(state: GoalState | undefined, theme: Theme): string {
  if (!state) return "";
  if (state.status === "active") {
    const detail = state.maxTurns === undefined
      ? `${state.turns} turn${state.turns === 1 ? "" : "s"} · ${formatTime(goalElapsedMilliseconds(state, Date.now()))}`
      : `${state.turns}/${state.maxTurns} · ${formatTime(goalElapsedMilliseconds(state, Date.now()))}`;
    return `${theme.fg("customMessageLabel", "/goal active")}${theme.fg("dim", ` · ${detail}`)}`;
  }
  if (state.status === "paused") return theme.fg("warning", "/goal paused");
  if (state.status === "blocked") return theme.fg("error", "/goal blocked");
  return "";
}

function formatGitFileChanges(changes: GitFileChanges, theme: Theme): string {
  const total = changes.modified + changes.added + changes.deleted;
  if (total === 0) return "";
  return `${theme.fg("dim", `±${total} [`)}${theme.fg("warning", `~${changes.modified}`)} ${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `−${changes.deleted}`)}${theme.fg("dim", "]")}`;
}

export function registerFooter(
  pi: ExtensionAPI,
  goalRuntime: GoalRuntime,
): (preference: { enabled: boolean } | undefined) => void {
  let autoCompactionEnabled: boolean | undefined;
  const updatePreference = (preference: { enabled: boolean } | undefined): void => {
    autoCompactionEnabled = preference?.enabled;
    activeTui?.requestRender();
  };
  let currentModel: ExtensionContext["model"];
  let thinkingLevel: ThinkingLevel = "off";
  let activeTui: TUI | undefined;
  let cachedSessionCost = 0;
  let sessionCostDirty = true;
  let unsubscribeCodexFast: (() => void) | undefined;
  const resetSessionCost = (): void => {
    cachedSessionCost = 0;
    sessionCostDirty = true;
  };
  const invalidateSessionCost = (): void => {
    sessionCostDirty = true;
    activeTui?.requestRender();
  };
  const getSessionCost = (ctx: ExtensionContext): number => {
    if (sessionCostDirty) {
      cachedSessionCost = sumSessionCost(ctx);
      sessionCostDirty = false;
    }
    return cachedSessionCost;
  };
  onGoalChange(goalRuntime, () => activeTui?.requestRender());

  pi.on("session_start", (_event, ctx) => {
    resetSessionCost();
    if (ctx.mode !== "tui") return;
    unsubscribeCodexFast?.();
    unsubscribeCodexFast = subscribeCodexFast(() => activeTui?.requestRender());
    const sessionStart = Date.now();
    currentModel = ctx.model;
    thinkingLevel = pi.getThinkingLevel();
    const cwd = formatCwd(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      let gitFileChanges: GitFileChanges | undefined;
      const gitStatus = createGitFileChangesRefresh(() => resolveGitFileChanges(ctx.cwd, ctx.isProjectTrusted()), (changes) => {
        if (JSON.stringify(changes) === JSON.stringify(gitFileChanges)) return;
        gitFileChanges = changes;
        tui.requestRender();
      });
      const unsubscribe = footerData.onBranchChange(() => {
        gitStatus.request();
        tui.requestRender();
      });
      gitStatus.request();
      const stopWatch = scheduleGitStatusWatch(ctx.cwd, gitStatus.request);
      const stopFallback = scheduleGitStatusFallback(gitStatus.request);
      return {
        dispose() {
          unsubscribe();
          stopWatch();
          stopFallback();
          gitStatus.dispose();
          if (activeTui === tui) activeTui = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          if (width <= 0) return [];
          const model = currentModel ?? ctx.model;
          const level = model?.reasoning === false
            ? theme.fg("thinkingOff", "no reasoning")
            : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
          const usage = readContextUsage(ctx);
          const contextWindow = validCapacity(usage?.contextWindow)
            ? usage.contextWindow : validCapacity(model?.contextWindow) ? model.contextWindow : Number.NaN;
          const contexts = (["full", "capacity", "percentage"] as const).map((detail) =>
            formatContextProgress(usage?.tokens ?? null, contextWindow, theme, autoCompactionEnabled === false, detail));
          const branch = footerData.getGitBranch();
          const signature = formatModel(model, theme, true, isCodexFastEnabled());
          const fullDirectory = colorDirectory(cwd);
          const focusedDirectory = colorDirectory(compactDirectory(cwd));
          const goal = formatGoalFooter(goalRuntime.state, theme);
          const primary = contexts.map((context) => joinFooterParts([signature, level, context], theme));
          const primaryFocused = contexts.map((context) => joinFooterParts([signature, context], theme));
          const session = joinFooterParts([
            theme.fg("dim", formatTime(Date.now() - sessionStart)),
            theme.fg("dim", formatCost(getSessionCost(ctx))),
          ], theme);
          const essentialModel = formatModel(model, theme, false, isCodexFastEnabled());
          const candidates = [
            { left: primary[0] ?? "", right: session },
            ...primary.map((left) => ({ left, right: "" })),
            ...primaryFocused.map((left) => ({ left, right: "" })),
            ...contexts.map((right) => ({ left: essentialModel, right })),
          ];
          const selected = candidates.find(({ left, right }) => footerRowFits(left, right, width))
            ?? { left: essentialModel, right: contexts[2] ?? "" };
          const primaryRow = renderFooterRow(selected.left, selected.right, width);
          const changes = gitFileChanges ? formatGitFileChanges(gitFileChanges, theme) : "";
          const branchLabel = joinFooterParts([branch ? theme.fg("dim", branch) : "", changes], theme);
          const workspaceRight = goal || fullDirectory;
          const secondaryRow = footerRowFits(branchLabel, workspaceRight, width)
            ? renderFooterRow(branchLabel, workspaceRight, width)
            : goal
              ? renderFooterRow("", goal, width)
              : footerRowFits(branchLabel, focusedDirectory, width)
                ? renderFooterRow(branchLabel, focusedDirectory, width)
                : renderFooterRow(branchLabel, "", width);
          return renderFooter([primaryRow, secondaryRow], width, theme);
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
  pi.on("turn_end", invalidateSessionCost);
  pi.on("session_compact", invalidateSessionCost);
  pi.on("session_tree", () => {
    resetSessionCost();
    activeTui?.requestRender();
  });
  pi.on("session_shutdown", () => {
    unsubscribeCodexFast?.();
    unsubscribeCodexFast = undefined;
    resetSessionCost();
    activeTui = undefined;
  });
  return updatePreference;
}
