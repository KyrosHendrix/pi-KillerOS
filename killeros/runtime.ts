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

export interface GoalFileVerification {
  kind: "file";
  path: string;
}

export interface GoalState {
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
  resumeAfterManualCompaction?: true;
  blockerAudit?: GoalBlockerAudit;
  verification?: GoalFileVerification;
}

export interface GoalRuntime {
  state?: GoalState;
  continuationScheduled: boolean;
  continuationHeld: boolean;
  goalTurnInFlight: boolean;
  agentEndObserved: boolean;
  automaticCompaction?: "pending";
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
