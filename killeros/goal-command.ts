import { validateGoalObjective } from "./goal-state.ts";

export type GoalCommand =
  | { kind: "status" }
  | { kind: "objective"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

/** Parses one raw /goal argument string into a closed command variant. */
export function parseGoalCommand(args: string): GoalCommand {
  const input = args.trim();
  if (!input) return { kind: "status" };
  const lowered = input.toLowerCase();
  if (lowered === "pause") return { kind: "pause" };
  if (lowered === "resume") return { kind: "resume" };
  if (lowered === "clear") return { kind: "clear" };
  const objective = validateGoalObjective(input);
  return objective
    ? { kind: "objective", objective }
    : { kind: "invalid", message: "A goal objective may not exceed 4,000 characters" };
}
