import { execFile } from "node:child_process";
import { type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { isCodexFastEnabled, subscribeCodexFast } from "./codex-fast-state.ts";
import { formatCwd, formatTime, formatTokens, padRight } from "./display.ts";
import { goalElapsedMilliseconds } from "./goal-state.ts";
import type { GoalRuntime, GoalState } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";
import { LEVEL_COLORS, type ThinkingLevel } from "./variants.ts";

const GIT_STATUS_REFRESH_INTERVAL_MS = 30_000;
const CODEX_PROVIDER = "openai-codex";
const colorDirectory = (text: string): string => `\x1B[38;2;240;248;154m${text}\x1B[39m`;

interface GitFileChanges {
  modified: number;
  added: number;
  deleted: number;
}

function resolveGitFileChanges(cwd: string): Promise<GitFileChanges | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 1_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }

        const changes: GitFileChanges = { modified: 0, added: 0, deleted: 0 };
        const entries = stdout.split("\0");
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          if (!entry) continue;
          const status = entry.slice(0, 2);
          if (status.includes("D")) changes.deleted += 1;
          else if (status === "??" || status.includes("A")) changes.added += 1;
          else changes.modified += 1;
          if (status.includes("R") || status.includes("C")) index += 1;
        }
        resolve(changes);
      },
    );
  });
}

async function resolveUncommittedFileCount(cwd: string): Promise<number | undefined> {
  const changes = await resolveGitFileChanges(cwd);
  return changes && changes.modified + changes.added + changes.deleted;
}

function createGitRefresh<T>(
  cwd: string,
  onResult: (result: T | undefined) => void,
  resolveResult: (cwd: string) => Promise<T | undefined>,
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
    void resolveResult(cwd).then((result) => {
      if (!disposed) onResult(result);
    }).finally(() => {
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

/** Coalesces Git status requests to one active scan and one queued follow-up. */
export function createGitStatusRefresh(
  cwd: string,
  onCount: (count: number | undefined) => void,
  resolveCount: (cwd: string) => Promise<number | undefined> = resolveUncommittedFileCount,
): { request: () => void; dispose: () => void } {
  return createGitRefresh(cwd, onCount, resolveCount);
}

function createGitFileChangesRefresh(
  cwd: string,
  onChanges: (changes: GitFileChanges | undefined) => void,
): { request: () => void; dispose: () => void } {
  return createGitRefresh(cwd, onChanges, resolveGitFileChanges);
}

type ScheduleFallback = (refresh: () => void, intervalMs: number) => () => void;

const scheduleFallback: ScheduleFallback = (refresh, intervalMs) => {
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

/** Schedules the fallback Git scan independently from footer rendering. */
export function scheduleGitStatusFallback(
  refresh: () => void,
  schedule: ScheduleFallback = scheduleFallback,
): () => void {
  return schedule(refresh, GIT_STATUS_REFRESH_INTERVAL_MS);
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  return `$${usd.toFixed(2)}`;
}

export function contextPercentRemaining(ctx: ExtensionContext): number | null {
  let usage: ReturnType<ExtensionContext["getContextUsage"]>;
  try {
    usage = ctx.getContextUsage();
  } catch {
    return null;
  }
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  if (usage.tokens === null || !Number.isFinite(usage.tokens)) return null;

  const percentRemaining = ((usage.contextWindow - Math.max(0, usage.tokens)) / usage.contextWindow) * 100;
  return Math.round(Math.max(0, Math.min(100, percentRemaining)));
}

export function formatContextProgress(tokensUsed: number | null, contextWindow: number, theme: Theme): string {
  if (tokensUsed === null || !Number.isFinite(tokensUsed)) return theme.fg("dim", "—% left (—)");
  const windowSize = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128_000;
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
  const normalized = safeTerminalText(provider).replaceAll("\n", "").trim();
  const known = PROVIDER_LABELS[normalized.toLowerCase()];
  if (known) return known;
  return normalized
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => PROVIDER_WORDS[word.toLowerCase()] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ") || "Unknown provider";
}

function modelDisplayName(model: NonNullable<ExtensionContext["model"]>): string {
  const name = safeTerminalText(model.name ?? "").replaceAll("\n", "").trim();
  return name || safeTerminalText(model.id).replaceAll("\n", "").trim() || "Unknown model";
}

export function formatModel(
  model: ExtensionContext["model"],
  theme: Theme,
  includeProvider = true,
  showCodexFast = false,
): string {
  if (!model) return theme.fg("dim", "No model");
  const name = theme.fg("text", theme.bold(modelDisplayName(model)));
  const fast = showCodexFast && model.provider === CODEX_PROVIDER
    ? theme.fg("accent", theme.bold("Fast"))
    : "";
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
    return theme.fg("warning", `/goal is active (${formatTime(goalElapsedMilliseconds(state, Date.now()))})`);
  }
  if (state.status === "paused") return theme.fg("warning", "/goal is paused");
  if (state.status === "blocked") return theme.fg("error", "/goal is blocked");
  return "";
}

function formatGitFileChanges(changes: GitFileChanges, theme: Theme): string {
  const total = changes.modified + changes.added + changes.deleted;
  if (total === 0) return "";
  return `${theme.fg("dim", `±${total} [`)}${theme.fg("warning", `~${changes.modified}`)} ${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `−${changes.deleted}`)}${theme.fg("dim", "]")}`;
}

export function registerFooter(pi: ExtensionAPI, goalRuntime: GoalRuntime): void {
  let currentModel: ExtensionContext["model"];
  let thinkingLevel: ThinkingLevel = "off";
  let activeTui: TUI | undefined;
  let cachedSessionCost = 0;
  let sessionCostDirty = true;
  let unsubscribeCodexFast: (() => void) | undefined;
  let requestGitStatusRefresh: (() => void) | undefined;
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
  goalRuntime.requestRender = () => activeTui?.requestRender();

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
      const gitStatus = createGitFileChangesRefresh(ctx.cwd, (changes) => {
        if (JSON.stringify(changes) === JSON.stringify(gitFileChanges)) return;
        gitFileChanges = changes;
        tui.requestRender();
      });
      requestGitStatusRefresh = gitStatus.request;
      const unsubscribe = footerData.onBranchChange(() => {
        gitStatus.request();
        tui.requestRender();
      });
      gitStatus.request();
      const stopFallback = scheduleGitStatusFallback(gitStatus.request);
      return {
        dispose() {
          unsubscribe();
          stopFallback();
          gitStatus.dispose();
          if (requestGitStatusRefresh === gitStatus.request) requestGitStatusRefresh = undefined;
          if (activeTui === tui) activeTui = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          if (width <= 0) return [];
          const model = currentModel ?? ctx.model;
          const level = model?.reasoning === false
            ? theme.fg("thinkingOff", "no reasoning")
            : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
          let usage: ReturnType<ExtensionContext["getContextUsage"]>;
          try {
            usage = ctx.getContextUsage();
          } catch {
            usage = undefined;
          }
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 128_000;
          const context = formatContextProgress(usage?.tokens ?? null, contextWindow, theme);
          const branch = footerData.getGitBranch();
          const signature = formatModel(model, theme, true, isCodexFastEnabled());
          const fullDirectory = colorDirectory(cwd);
          const focusedDirectory = colorDirectory(compactDirectory(cwd));
          const goal = formatGoalFooter(goalRuntime.state, theme);
          const primary = joinFooterParts([
            signature,
            level,
            context,
          ], theme);
          const primaryFocused = joinFooterParts([signature, context], theme);
          const session = joinFooterParts([
            theme.fg("dim", formatTime(Date.now() - sessionStart)),
            theme.fg("dim", formatCost(getSessionCost(ctx))),
          ], theme);
          const essentialModel = formatModel(model, theme, false, isCodexFastEnabled());
          const primaryRow = footerRowFits(primary, session, width)
            ? renderFooterRow(primary, session, width)
            : footerRowFits(primary, "", width)
              ? renderFooterRow(primary, "", width)
              : footerRowFits(primaryFocused, "", width)
                ? renderFooterRow(primaryFocused, "", width)
                : renderFooterRow(essentialModel, context, width);
          const changes = gitFileChanges ? formatGitFileChanges(gitFileChanges, theme) : "";
          const branchLabel = branch
            ? `${theme.fg("dim", branch)}${changes ? `${theme.fg("dim", " · ")}${changes}` : ""}`
            : "";
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
  const refreshAfterActivity = (): void => {
    invalidateSessionCost();
    requestGitStatusRefresh?.();
  };
  pi.on("turn_end", refreshAfterActivity);
  pi.on("session_compact", refreshAfterActivity);
  pi.on("session_tree", () => {
    resetSessionCost();
    activeTui?.requestRender();
  });
  pi.on("session_shutdown", () => {
    unsubscribeCodexFast?.();
    unsubscribeCodexFast = undefined;
    resetSessionCost();
    activeTui = undefined;
    requestGitStatusRefresh = undefined;
    goalRuntime.requestRender = undefined;
  });
}
