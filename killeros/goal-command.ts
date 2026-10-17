import { validateGoalObjective } from "./goal-state.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

export type GoalCommand =
  | { kind: "status" }
  | { kind: "objective"; objective: string }
  | { kind: "edit"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

/** Parses raw text as a plain objective, or reports why it cannot be one. */
export function parseGoalObjectiveText(input: string): Extract<GoalCommand, { kind: "objective" } | { kind: "invalid" }> {
  const objective = validateGoalObjective(input);
  if (objective) return { kind: "objective", objective };
  if (safeTerminalText(input) !== input) {
    return { kind: "invalid", message: "A goal objective contains unsupported content" };
  }
  return { kind: "invalid", message: "A goal objective may not exceed 4,000 characters" };
}

/** Parses one raw /goal argument string into a closed command variant; the handler decides whether "edit" applies to the current goal. */
export function parseGoalCommand(args: string): GoalCommand {
  const input = args.trim();
  if (!input) return { kind: "status" };
  const lowered = input.toLowerCase();
  if (lowered === "pause") return { kind: "pause" };
  if (lowered === "resume") return { kind: "resume" };
  if (lowered === "clear") return { kind: "clear" };
  if (lowered === "edit") return { kind: "invalid", message: "Provide the new objective: /goal edit <objective>" };
  if (/^edit\s/ui.test(input)) {
    const objective = validateGoalObjective(input.replace(/^edit\s+/ui, ""));
    if (objective) return { kind: "edit", objective };
  }
  return parseGoalObjectiveText(input);
}
