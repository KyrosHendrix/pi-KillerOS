import { parseArgs } from "node:util";
import { GOAL_CHECK_NAME_PATTERN, GOAL_MAX_TURNS, validateGoalObjective } from "./goal-state.ts";

const GOAL_START_USAGE = "Usage: /goal start [--check <name>] [--turns <count>] -- <objective>";
const GOAL_CHECK_USAGE = "Usage: /goal check <name|clear>";
const GOAL_CHECKS_USAGE = "Usage: /goal checks";
const GOAL_LIMIT_USAGE = "Usage: /goal limit <count|clear>";
const GOAL_HISTORY_USAGE = "Usage: /goal history [count]";
const RESERVED_OBJECTIVE_USAGE = "Objective begins with a reserved goal command. Use /goal start -- <objective>.";

interface ControlledGoalStart {
  objective: string;
  completionCheckName?: string;
  maxTurns?: number;
}

export type GoalCommand =
  | { kind: "status" }
  | { kind: "objective"; objective: string }
  | { kind: "start"; objective: string; completionCheckName?: string; maxTurns?: number }
  | { kind: "check"; value: { kind: "clear" } | { kind: "named"; name: string } }
  | { kind: "checks" }
  | { kind: "limit"; value: { kind: "clear" } | { kind: "count"; count: number } }
  | { kind: "history"; count: number }
  | { kind: "clear" }
  | { kind: "edit" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "invalid"; message: string };

const RESERVED_GOAL_WORDS = ["start", "check", "checks", "limit", "history", "clear", "edit", "pause", "resume"] as const;

function parseBoundedInteger(value: string, maximum: number): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : undefined;
}

function parseControlledGoalStart(input: string): ControlledGoalStart | undefined {
  const separator = input.startsWith("-- ") ? 0 : input.indexOf(" -- ");
  if (separator < 0) return undefined;
  const optionText = input.slice(0, separator).trim();
  const objective = validateGoalObjective(input.slice(separator + (separator === 0 ? 3 : 4)));
  if (!objective) return undefined;
  const tokens = optionText ? optionText.split(/\s+/u) : [];
  if (tokens.filter((token) => token === "--check" || token.startsWith("--check=")).length > 1
    || tokens.filter((token) => token === "--turns" || token.startsWith("--turns=")).length > 1) return undefined;
  try {
    const parsed = parseArgs({
      args: tokens,
      options: { check: { type: "string" }, turns: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    const check = parsed.values.check;
    const turns = parsed.values.turns;
    if (check !== undefined && !GOAL_CHECK_NAME_PATTERN.test(check)) return undefined;
    const maxTurns = turns === undefined ? undefined : parseBoundedInteger(turns, GOAL_MAX_TURNS);
    if (turns !== undefined && maxTurns === undefined) return undefined;
    return {
      objective,
      ...(check === undefined ? {} : { completionCheckName: check }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
    };
  } catch {
    return undefined;
  }
}

/** Parses one raw /goal argument string into a closed command variant. */
export function parseGoalCommand(args: string): GoalCommand {
  const input = args.trim();
  if (!input) return { kind: "status" };
  const parts = input.split(/\s+/u);
  const rawFirstWord = parts[0] ?? "";
  const firstWord = RESERVED_GOAL_WORDS.find((word) => word === rawFirstWord.toLowerCase());
  if (!firstWord) {
    const objective = validateGoalObjective(input);
    return objective
      ? { kind: "objective", objective }
      : { kind: "invalid", message: "A goal objective may not exceed 4,000 characters" };
  }

  if (firstWord === "start") {
    const start = parseControlledGoalStart(input.slice(rawFirstWord.length).trimStart());
    if (start) return { kind: "start", ...start };
    return { kind: "invalid", message: rawFirstWord === firstWord ? GOAL_START_USAGE : RESERVED_OBJECTIVE_USAGE };
  }
  if (firstWord === "check") {
    const value = parts[1];
    if (parts.length === 2 && value?.toLowerCase() === "clear") return { kind: "check", value: { kind: "clear" } };
    if (parts.length === 2 && value && GOAL_CHECK_NAME_PATTERN.test(value)) return { kind: "check", value: { kind: "named", name: value } };
    return { kind: "invalid", message: rawFirstWord !== firstWord && parts.length > 2 ? RESERVED_OBJECTIVE_USAGE : GOAL_CHECK_USAGE };
  }
  if (firstWord === "checks") {
    return parts.length === 1
      ? { kind: "checks" }
      : { kind: "invalid", message: rawFirstWord === firstWord ? GOAL_CHECKS_USAGE : RESERVED_OBJECTIVE_USAGE };
  }
  if (firstWord === "limit") {
    const value = parts[1];
    if (parts.length === 2 && value?.toLowerCase() === "clear") return { kind: "limit", value: { kind: "clear" } };
    const count = parts.length === 2 && value ? parseBoundedInteger(value, GOAL_MAX_TURNS) : undefined;
    if (count !== undefined) return { kind: "limit", value: { kind: "count", count } };
    return { kind: "invalid", message: rawFirstWord !== firstWord && parts.length > 2 ? RESERVED_OBJECTIVE_USAGE : GOAL_LIMIT_USAGE };
  }
  if (firstWord === "history") {
    if (parts.length === 1) return { kind: "history", count: 20 };
    const count = parts.length === 2 && parts[1] ? parseBoundedInteger(parts[1], 50) : undefined;
    if (count !== undefined) return { kind: "history", count };
    return { kind: "invalid", message: rawFirstWord !== firstWord && parts.length > 2 ? RESERVED_OBJECTIVE_USAGE : GOAL_HISTORY_USAGE };
  }
  if (parts.length === 1) return { kind: firstWord };
  return {
    kind: "invalid",
    message: rawFirstWord === firstWord
      ? `Usage: /goal ${firstWord}`
      : RESERVED_OBJECTIVE_USAGE,
  };
}
