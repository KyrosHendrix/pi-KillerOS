import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { GoalBlockerAudit, GoalFileBaseline, GoalFileVerification, GoalState, GoalStateCommon, GoalStatus } from "./runtime.ts";

export const DEFAULT_GOAL_MAX_TURNS = 20;
export const GOAL_OBJECTIVE_LIMIT = 4_000;
export const GOAL_MAX_TURNS = 10_000;
export const GOAL_VERSION = 1;
const FILE_HASH_CHUNK_SIZE = 64 * 1024;
export const FILE_HASH_LIMIT = 64 * 1024 * 1024;
type OpenGoalFile = (filePath: string) => Promise<FileHandle>;
const openGoalFile: OpenGoalFile = (filePath) => open(filePath, "r");

export interface GoalTransitionOptions {
  resetBlockedAudit?: boolean;
  resumeAfterManualCompaction?: true;
  blockerAudit?: GoalBlockerAudit;
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function incrementableNonNegativeInteger(value: unknown): value is number {
  return safeNonNegativeInteger(value) && value < Number.MAX_SAFE_INTEGER;
}

function addGoalMilliseconds(accumulated: number, interval: number): number {
  const total = accumulated + interval;
  if (!safeNonNegativeInteger(total)) throw new Error("Goal active duration exceeds the safe integer range");
  return total;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGoalFileBaseline(value: unknown): value is GoalFileBaseline {
  if (!isUnknownRecord(value)) return false;
  if (value.exists === false) {
    return value.size === undefined && value.mtimeMs === undefined && value.contentHash === undefined;
  }
  return value.exists === true
    && finiteNonNegative(value.size)
    && finiteNonNegative(value.mtimeMs)
    && (value.contentHash === undefined
      || value.contentHash === null
      || typeof value.contentHash === "string" && /^[a-f0-9]{64}$/u.test(value.contentHash));
}

function isAbsoluteFilePath(value: string): boolean {
  if (!value || /^(?:https?|file):\/\//iu.test(value) || /[\\\/]$/u.test(value)) return false;
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function stripUnquotedPathPunctuation(value: string): string {
  const pathWithoutMarks = value.replace(/[.!?]+$/u, "");
  const trailingClosers = pathWithoutMarks.match(/\)+$/u)?.[0].length ?? 0;
  const unmatchedClosers = Math.max(0, pathWithoutMarks.split(")").length - pathWithoutMarks.split("(").length);
  const punctuationLength = Math.min(trailingClosers, unmatchedClosers);
  return pathWithoutMarks.slice(0, punctuationLength ? -punctuationLength : undefined);
}

function isGoalFileVerification(value: unknown): value is GoalFileVerification {
  return isUnknownRecord(value)
    && value.kind === "file"
    && typeof value.path === "string"
    && value.path === value.path.trim()
    && isAbsoluteFilePath(value.path)
    && isGoalFileBaseline(value.baseline);
}

function isMaxTurns(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= GOAL_MAX_TURNS;
}

function isGoalBlockerAudit(value: unknown, turns: number, status: GoalStatus): value is GoalBlockerAudit {
  if (!isUnknownRecord(value)
    || typeof value.key !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(value.key)
    || typeof value.streak !== "number" || !Number.isInteger(value.streak) || value.streak < 1 || value.streak > 3
    || typeof value.lastTurn !== "number" || !Number.isInteger(value.lastTurn) || value.lastTurn < 1 || value.lastTurn > turns
    || value.evidence !== undefined && (typeof value.evidence !== "string"
      || value.evidence !== value.evidence.trim() || !value.evidence || value.evidence.length > 2_000)) {
    return false;
  }
  if (status === "complete") return false;
  return status === "blocked" ? value.streak === 3 : value.streak < 3;
}

export function parseGoalState(value: unknown): GoalState | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const {
    version,
    revision,
    objective,
    status,
    createdAt,
    updatedAt,
    activeMilliseconds,
    activeStartedAt,
    turns,
    blockedAuditStartTurn,
    baselineTokens,
    result,
    resumeAfterManualCompaction,
    blockerAudit,
    verification,
    maxTurns,
  } = value;
  if (version !== GOAL_VERSION
    || !incrementableNonNegativeInteger(revision) || revision < 1
    || typeof objective !== "string" || !objective.trim() || [...objective].length > GOAL_OBJECTIVE_LIMIT
    || !isGoalStatus(status)
    || !safeNonNegativeInteger(createdAt)
    || !safeNonNegativeInteger(updatedAt)
    || !incrementableNonNegativeInteger(activeMilliseconds)
    || !incrementableNonNegativeInteger(turns)
    || blockedAuditStartTurn !== undefined
      && (!safeNonNegativeInteger(blockedAuditStartTurn) || blockedAuditStartTurn > turns)
    || !safeNonNegativeInteger(baselineTokens)
    || result !== undefined && typeof result !== "string"
    || verification !== undefined && !isGoalFileVerification(verification)
    || maxTurns !== undefined && !isMaxTurns(maxTurns)
    || resumeAfterManualCompaction !== undefined && resumeAfterManualCompaction !== true
    || blockerAudit !== undefined && !isGoalBlockerAudit(blockerAudit, turns, status)) {
    return undefined;
  }

  const common: GoalStateCommon = {
    version: GOAL_VERSION,
    revision,
    objective: objective.trim(),
    createdAt,
    updatedAt,
    activeMilliseconds,
    turns,
    blockedAuditStartTurn: blockedAuditStartTurn ?? 0,
    baselineTokens,
    ...(verification === undefined ? {} : { verification }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
  };
  switch (status) {
    case "active":
      if (!safeNonNegativeInteger(activeStartedAt) || resumeAfterManualCompaction !== undefined) return undefined;
      return {
        ...common,
        status,
        activeStartedAt,
        ...(result === undefined ? {} : { result }),
        ...(blockerAudit === undefined ? {} : { blockerAudit }),
      };
    case "paused":
      if (activeStartedAt !== undefined) return undefined;
      return {
        ...common,
        status,
        ...(result === undefined ? {} : { result }),
        ...(blockerAudit === undefined ? {} : { blockerAudit }),
        ...(resumeAfterManualCompaction === undefined ? {} : { resumeAfterManualCompaction }),
      };
    case "blocked":
      if (activeStartedAt !== undefined || resumeAfterManualCompaction !== undefined || typeof result !== "string") return undefined;
      return { ...common, status, result, ...(blockerAudit === undefined ? {} : { blockerAudit }) };
    case "complete":
      if (activeStartedAt !== undefined || resumeAfterManualCompaction !== undefined
        || typeof result !== "string" || blockerAudit !== undefined) return undefined;
      return { ...common, status, result };
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function hashFile(handle: FileHandle, inspected: Stats): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_SIZE);
  let position = 0;
  while (position < inspected.size) {
    const length = Math.min(buffer.length, inspected.size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error("Goal deliverable changed while it was being inspected");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (!sameFile(inspected, await handle.stat())) {
    throw new Error("Goal deliverable changed while it was being inspected");
  }
  return hash.digest("hex");
}

/** Captures a file baseline with bounded asynchronous I/O and descriptor identity checks. */
export async function captureGoalFileBaseline(
  filePath: string,
  openFile: OpenGoalFile = openGoalFile,
): Promise<GoalFileBaseline> {
  let inspected: Stats;
  try {
    inspected = await lstat(filePath);
  } catch (error) {
    if (isUnknownRecord(error) && error.code === "ENOENT") return { exists: false };
    throw error;
  }
  const baseline = { exists: true as const, size: inspected.size, mtimeMs: inspected.mtimeMs };
  if (!inspected.isFile() || inspected.size > FILE_HASH_LIMIT) return baseline;

  let handle: FileHandle | undefined;
  try {
    handle = await openFile(filePath);
    if (!sameFile(inspected, await handle.stat())) {
      throw new Error("Goal deliverable changed while it was being inspected");
    }
    return { ...baseline, contentHash: await hashFile(handle, inspected) };
  } catch (error) {
    if (error instanceof Error && error.message === "Goal deliverable changed while it was being inspected") throw error;
    return { ...baseline, contentHash: null };
  } finally {
    await handle?.close();
  }
}

/** Captures one explicit output path so goal completion can verify its creation or modification. */
export async function inferGoalVerification(objective: string, cwd: string): Promise<GoalFileVerification | undefined> {
  const candidates: string[] = [];
  const destination = /\b(?:create|write|save|generate)\b[^\r\n]{0,160}?\b(?:file|document|markdown|report|spreadsheet|presentation|image)\b\s+(?:to|at|as|destination(?:\s+is)?|output(?:\s+(?:to|at))?)\b\s*(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z]:\\[^\s,;]+|\/[^\s,;]+))/giu;
  for (const match of objective.matchAll(destination)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    candidates.push(quoted !== undefined ? quoted.trim() : stripUnquotedPathPunctuation((match[4] ?? "").trim()));
  }
  const direct = /\b(?:update|edit|fix|refactor|migrate)\s+(`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)')/giu;
  for (const match of objective.matchAll(direct)) {
    const quoted = match[2] ?? match[3] ?? match[4];
    if (quoted !== undefined) candidates.push(quoted.trim());
  }
  const resolved: string[] = [];
  for (const raw of candidates) {
    if (!raw || /^(?:https?|file):\/\//iu.test(raw) || /[\\\/]$/u.test(raw)) continue;
    const absolute = path.isAbsolute(raw) || path.win32.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    if (isAbsoluteFilePath(absolute)) resolved.push(absolute);
  }
  const unique = [...new Set(resolved)];
  const filePath = unique.length === 1 ? unique[0] : undefined;
  return filePath ? { kind: "file", path: filePath, baseline: await captureGoalFileBaseline(filePath) } : undefined;
}

export async function verifyGoalDeliverable(verification: GoalFileVerification): Promise<void> {
  let artifact: Stats;
  try {
    artifact = await lstat(verification.path);
  } catch {
    throw new Error(`Goal deliverable is not a regular file at the required path: ${verification.path}`);
  }
  if (!artifact.isFile()) {
    throw new Error(`Goal deliverable is not a regular file at the required path: ${verification.path}`);
  }
  if (!verification.baseline.exists) return;
  if (verification.baseline.contentHash === null) {
    throw new Error(`Goal deliverable content cannot be verified: ${verification.path}`);
  }
  if (verification.baseline.contentHash !== undefined) {
    const current = await captureGoalFileBaseline(verification.path);
    if (!current.exists || current.contentHash === null) {
      throw new Error(`Goal deliverable content cannot be verified: ${verification.path}`);
    }
    if (current.contentHash === verification.baseline.contentHash) {
      throw new Error(`Goal deliverable has not changed since the goal started: ${verification.path}`);
    }
  }
  if (verification.baseline.contentHash === undefined
    && artifact.size === verification.baseline.size
    && artifact.mtimeMs === verification.baseline.mtimeMs) {
    throw new Error(`Goal deliverable has not changed since the goal started: ${verification.path}`);
  }
}

export function validateGoalObjective(input: string): string | undefined {
  const objective = input.trim();
  if (!objective) return undefined;
  return [...objective].length <= GOAL_OBJECTIVE_LIMIT ? objective : undefined;
}

export function goalElapsedMilliseconds(state: GoalState, now: number): number {
  const activeInterval = state.status === "active" ? Math.max(0, now - state.activeStartedAt) : 0;
  return addGoalMilliseconds(state.activeMilliseconds, activeInterval);
}

export function commonGoalState(state: GoalState): GoalStateCommon {
  return {
    version: state.version,
    revision: state.revision,
    objective: state.objective,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    activeMilliseconds: state.activeMilliseconds,
    turns: state.turns,
    blockedAuditStartTurn: state.blockedAuditStartTurn,
    baselineTokens: state.baselineTokens,
    ...(state.verification === undefined ? {} : { verification: state.verification }),
    ...(state.maxTurns === undefined ? {} : { maxTurns: state.maxTurns }),
  };
}

export function stopGoalClock(state: GoalState, now: number): GoalStateCommon {
  const common = commonGoalState(state);
  return state.status === "active"
    ? { ...common, activeMilliseconds: addGoalMilliseconds(common.activeMilliseconds, Math.max(0, now - state.activeStartedAt)) }
    : common;
}

export function createNewGoalState(
  objective: string,
  baselineTokens: number,
  verification: GoalFileVerification | undefined,
  now: number,
  controls: { maxTurns?: number } = {},
): GoalState {
  return {
    version: GOAL_VERSION,
    revision: 1,
    objective,
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeMilliseconds: 0,
    activeStartedAt: now,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens,
    ...(verification === undefined ? {} : { verification }),
    ...(controls.maxTurns === undefined ? {} : { maxTurns: controls.maxTurns }),
  };
}

export function beginGoalTurnState(
  current: Extract<GoalState, { status: "active" }>,
  now: number,
): GoalState {
  return { ...current, revision: current.revision + 1, turns: current.turns + 1, updatedAt: now };
}

export function checkpointActiveGoalState(
  current: Extract<GoalState, { status: "active" }>,
  now: number,
): GoalState {
  return {
    ...stopGoalClock(current, now),
    revision: current.revision + 1,
    status: "active",
    updatedAt: now,
    activeStartedAt: now,
    ...(current.result === undefined ? {} : { result: current.result }),
    ...(current.blockerAudit === undefined ? {} : { blockerAudit: current.blockerAudit }),
  };
}

export function pauseGoalState(
  current: GoalState,
  result: string | undefined,
  now: number,
  resumeAfterManualCompaction = false,
): GoalState {
  const common = stopGoalClock(current, now);
  return {
    ...common,
    status: "paused",
    ...(result === undefined ? {} : { result }),
    ...(current.blockerAudit === undefined ? {} : { blockerAudit: current.blockerAudit }),
    ...(resumeAfterManualCompaction ? { resumeAfterManualCompaction: true as const } : {}),
  };
}

export function checkpointPausedGoalState(
  current: Extract<GoalState, { status: "paused" }>,
  now: number,
): GoalState {
  const { resumeAfterManualCompaction: _resume, ...paused } = current;
  return { ...paused, revision: paused.revision + 1, updatedAt: now };
}

export function recordGoalBlockerAudit(
  state: Extract<GoalState, { status: "active" }>,
  blockerAudit: GoalBlockerAudit,
  now: number,
): GoalState {
  return { ...state, revision: state.revision + 1, updatedAt: now, blockerAudit };
}

export function transitionGoalState(
  current: GoalState,
  status: GoalStatus,
  result: string | undefined,
  options: GoalTransitionOptions,
  now: number,
): GoalState {
  const stopped = stopGoalClock(current, now);
  const common: GoalStateCommon = {
    ...stopped,
    revision: stopped.revision + 1,
    updatedAt: now,
    blockedAuditStartTurn: options.resetBlockedAudit ? stopped.turns : stopped.blockedAuditStartTurn,
  };
  const blockerAudit = options.resetBlockedAudit ? undefined : options.blockerAudit ?? current.blockerAudit;
  switch (status) {
    case "active":
      return { ...common, status, activeStartedAt: now, ...(blockerAudit === undefined ? {} : { blockerAudit }) };
    case "paused":
      return {
        ...common,
        status,
        ...(result === undefined ? {} : { result }),
        ...(blockerAudit === undefined ? {} : { blockerAudit }),
        ...(options.resumeAfterManualCompaction === undefined ? {} : { resumeAfterManualCompaction: true }),
      };
    case "blocked":
      if (result === undefined) throw new Error("A blocked goal requires a result");
      return { ...common, status, result, ...(blockerAudit === undefined ? {} : { blockerAudit }) };
    case "complete":
      if (result === undefined) throw new Error("A complete goal requires a result");
      return { ...common, status, result };
  }
}
