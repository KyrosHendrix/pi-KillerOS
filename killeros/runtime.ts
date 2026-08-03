export interface InitRuntime {
  active: boolean;
  targetPath?: string;
  writeAttempted: boolean;
  writeSucceeded: boolean;
  projectRoot?: string;
  activeTools?: string[];
  settle?: (writeSucceeded: boolean) => void;
}

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

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
}

export interface GoalRuntime {
  state?: GoalState;
  continuationScheduled: boolean;
  continuationHeld: boolean;
  goalTurnInFlight: boolean;
  agentEndObserved: boolean;
  persistenceRetryNeeded: boolean;
  lastStopReason?: string;
  lastError?: string;
  requestRender?: () => void;
}

export function createInitRuntime(): InitRuntime {
  return { active: false, writeAttempted: false, writeSucceeded: false };
}

export function createGoalRuntime(): GoalRuntime {
  return {
    continuationScheduled: false,
    continuationHeld: false,
    goalTurnInFlight: false,
    agentEndObserved: false,
    persistenceRetryNeeded: false,
  };
}

export function resetInitRuntime(state: InitRuntime): void {
  state.active = false;
  state.targetPath = undefined;
  state.writeAttempted = false;
  state.writeSucceeded = false;
  state.projectRoot = undefined;
  state.activeTools = undefined;
}
