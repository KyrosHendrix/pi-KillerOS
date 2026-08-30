import type { InitEvidenceIndex } from "./init-evidence.ts";
import type { InitTargetBaseline } from "./init-target.ts";

export type InitOutcome =
  | { kind: "pending" }
  | { kind: "written" }
  | { kind: "policy-conflict"; reason: string }
  | { kind: "cancelled" }
  | { kind: "no-outcome" };

export interface InitRuntime {
  active: boolean;
  starting?: symbol;
  targetPath?: string;
  projectRoot?: string;
  activeTools?: string[];
  evidence?: InitEvidenceIndex;
  baseline?: InitTargetBaseline;
  outcome: InitOutcome;
  settle?: (outcome: InitOutcome) => void;
}

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalBlockerAudit {
  key: string;
  streak: number;
  lastTurn: number;
}

export type GoalFileBaseline =
  | { exists: false }
  | { exists: true; size: number; mtimeMs: number; contentHash?: string | null };

export interface GoalFileVerification {
  kind: "file";
  path: string;
  baseline: GoalFileBaseline;
}

export interface GoalCompletionCheck {
  kind: "named-command";
  name: string;
  configHash: string;
}

export interface GoalStateCommon {
  version: 1;
  revision: number;
  objective: string;
  createdAt: number;
  updatedAt: number;
  activeMilliseconds: number;
  turns: number;
  blockedAuditStartTurn: number;
  baselineTokens: number;
  verification?: GoalFileVerification;
  completionCheck?: GoalCompletionCheck;
  maxTurns?: number;
}

export type GoalState = GoalStateCommon & (
  | {
      status: "active";
      activeStartedAt: number;
      result?: string;
      blockerAudit?: GoalBlockerAudit;
      resumeAfterManualCompaction?: never;
    }
  | {
      status: "paused";
      activeStartedAt?: never;
      result?: string;
      blockerAudit?: GoalBlockerAudit;
      resumeAfterManualCompaction?: true;
    }
  | {
      status: "blocked";
      activeStartedAt?: never;
      result: string;
      blockerAudit?: GoalBlockerAudit;
      resumeAfterManualCompaction?: never;
    }
  | {
      status: "complete";
      activeStartedAt?: never;
      result: string;
      blockerAudit?: never;
      resumeAfterManualCompaction?: never;
    }
);

/** Pi request outcomes for goal recovery: awaiting result, compacted, or rejected as session-too-small. */
export type AutomaticGoalCompactionOutcome = "pending" | "completed" | "skipped";

export interface AutomaticGoalCompaction {
  pausedRevision: number;
  outcome: AutomaticGoalCompactionOutcome;
  turnSettled: boolean;
}

export interface GoalRuntime {
  state?: GoalState;
  continuationScheduled: boolean;
  continuationHeld: boolean;
  goalTurnInFlight: boolean;
  agentEndObserved: boolean;
  automaticCompaction?: AutomaticGoalCompaction;
  persistenceRetryNeeded: boolean;
  lastStopReason?: string;
  lastError?: string;
  requestRender?: () => void;
}

export function createInitRuntime(): InitRuntime {
  return { active: false, outcome: { kind: "pending" } };
}

export function createGoalRuntime(): GoalRuntime {
  return {
    continuationScheduled: false,
    continuationHeld: false,
    goalTurnInFlight: false,
    agentEndObserved: false,
    automaticCompaction: undefined,
    persistenceRetryNeeded: false,
  };
}

export function resetInitRuntime(state: InitRuntime): void {
  state.active = false;
  state.starting = undefined;
  state.targetPath = undefined;
  state.projectRoot = undefined;
  state.activeTools = undefined;
  state.evidence = undefined;
  state.baseline = undefined;
  state.outcome = { kind: "pending" };
  state.settle = undefined;
}
