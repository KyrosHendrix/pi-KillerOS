import { formatTime, formatTokens } from "./display.ts";
import { parseGoalState } from "./goal-state.ts";
import type { GoalState } from "./runtime.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

const GOAL_ENTRY_TYPE = "killeros-goal";
const VALID_GOAL_EVENTS: ReadonlySet<string> = new Set([
  "set", "replace", "edit", "check", "limit", "turn", "pause", "resume",
  "blocker-audit", "blocked", "complete", "error", "clear", "checkpoint",
]);
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenUsage(entry: Record<string, unknown>): number | undefined {
  if (entry.type === "message" && isUnknownRecord(entry.message)
    && (entry.message.role === "assistant" || entry.message.role === "toolResult")
    && isUnknownRecord(entry.message.usage)
    && typeof entry.message.usage.totalTokens === "number"
    && Number.isFinite(entry.message.usage.totalTokens)
    && entry.message.usage.totalTokens >= 0) {
    return entry.message.usage.totalTokens;
  }
  if ((entry.type === "compaction" || entry.type === "branch_summary")
    && isUnknownRecord(entry.usage)
    && typeof entry.usage.totalTokens === "number"
    && Number.isFinite(entry.usage.totalTokens)
    && entry.usage.totalTokens >= 0) {
    return entry.usage.totalTokens;
  }
  return undefined;
}

function preview(value: string): string {
  const safe = safeTerminalText(value).replaceAll("\n", " ").trim();
  const characters = [...safe];
  return characters.length <= 160 ? safe : `${characters.slice(0, 159).join("")}…`;
}

function eventDetail(event: string, state: GoalState): string {
  if (event === "check") return state.completionCheck ? `check ${state.completionCheck.name}` : "check cleared";
  if (event === "limit") return state.maxTurns === undefined ? "limit cleared" : `limit ${state.maxTurns}`;
  if (event === "blocker-audit" && state.blockerAudit) {
    return `Blocker ${state.blockerAudit.streak}/3: ${state.blockerAudit.evidence ?? state.blockerAudit.key}`;
  }
  return state.result || state.objective;
}

/** Projects branch entries into the latest bounded goal-history rows. */
export function formatGoalHistory(entries: readonly unknown[], count: number): string | undefined {
  const lines: string[] = [];
  let tokens = 0;
  let previousState: GoalState | undefined;
  for (const value of entries) {
    if (!isUnknownRecord(value)) continue;
    const usage = tokenUsage(value);
    if (usage !== undefined) {
      tokens += usage;
      continue;
    }
    if (value.type !== "custom" || value.customType !== GOAL_ENTRY_TYPE || !isUnknownRecord(value.data)) continue;
    const event = value.data.event;
    if (typeof event !== "string" || !VALID_GOAL_EVENTS.has(event)) continue;
    const state = value.data.state === null ? previousState : parseGoalState(value.data.state);
    if (!state) continue;
    if (value.data.state !== null) previousState = state;
    if (event === "turn" || event === "checkpoint") continue;
    lines.push(`+${formatTime(Math.max(0, state.updatedAt - state.createdAt))}  ${event}  turn ${state.turns}  ${formatTokens(Math.max(0, tokens - state.baselineTokens))} tokens  ${preview(eventDetail(event, state))}`);
  }
  return lines.length ? lines.slice(-count).join("\n") : undefined;
}
