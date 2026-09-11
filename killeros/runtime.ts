export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalBlockerAudit {
  key: string;
  streak: number;
  lastTurn: number;
  evidence?: string;
}

export type GoalFileBaseline =
  | { exists: false }
  | { exists: true; size: number; mtimeMs: number; contentHash?: string | null };

export interface GoalFileVerification {
  kind: "file";
  path: string;
  baseline: GoalFileBaseline;
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
