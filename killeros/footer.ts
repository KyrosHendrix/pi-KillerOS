import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { formatCwd, formatTime, formatTokens, padRight } from "./display.ts";
import { goalElapsedMilliseconds } from "./goals.ts";
import type { GoalRuntime, GoalState } from "./runtime.ts";
import { LEVEL_COLORS, type ThinkingLevel } from "./variants.ts";

const FOOTER_REFRESH_INTERVAL_MS = 1_000;

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

export function formatModel(model: ExtensionContext["model"], theme: Theme, includeProvider = true): string {
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

function renderFooter(rows: string[], width: number, theme: Theme): string[] {
  return [theme.fg("borderMuted", "─".repeat(width)), ...rows];
}

function formatGoalElapsed(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1_000)) : 0;
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

function formatGoalFooter(state: GoalState | undefined, theme: Theme): string {
  if (!state) return "";
  if (state.status === "active") {
    return theme.fg("warning", `/goal is active (${formatGoalElapsed(goalElapsedMilliseconds(state))})`);
  }
  if (state.status === "paused") return theme.fg("warning", "/goal is paused");
  if (state.status === "blocked") return theme.fg("error", "/goal is blocked");
  return "";
}

export function registerFooter(pi: ExtensionAPI, goalRuntime: GoalRuntime): void {
  let currentModel: ExtensionContext["model"];
  let thinkingLevel: ThinkingLevel = "off";
  let activeTui: TUI | undefined;
  let cachedSessionCost = 0;
  let sessionCostDirty = true;
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
          let usage: ReturnType<ExtensionContext["getContextUsage"]>;
          try {
            usage = ctx.getContextUsage();
          } catch {
            usage = undefined;
          }
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 128_000;
          const context = formatContextProgress(usage?.tokens ?? null, contextWindow, theme);
          const branch = footerData.getGitBranch();
          const signature = formatModel(model, theme);
          const fullDirectory = theme.fg("dim", cwd);
          const focusedDirectory = theme.fg("dim", compactDirectory(cwd));
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
          const essentialModel = formatModel(model, theme, false);
          const primaryRow = footerRowFits(primary, session, width)
            ? renderFooterRow(primary, session, width)
            : footerRowFits(primary, "", width)
              ? renderFooterRow(primary, "", width)
              : footerRowFits(primaryFocused, "", width)
                ? renderFooterRow(primaryFocused, "", width)
                : renderFooterRow(essentialModel, context, width);
          const branchLabel = branch ? theme.fg("dim", branch) : "";
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
    resetSessionCost();
    activeTui = undefined;
    goalRuntime.requestRender = undefined;
  });
}
