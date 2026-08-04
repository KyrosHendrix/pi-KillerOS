import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SubagentTaskResult } from "./subagents.ts";
import type { SubagentThread } from "./subagent-lifecycle.ts";

export const SUBAGENT_PERSISTENCE_TYPE = "killeros-subagent-v1";

const RECORD_VERSION = 1;
const MAX_PROMPT_CHARS = 20_000;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TRACE_BYTES = 64 * 1024;
const MAX_TOOLS = 32;
const MAX_TOOL_CHARS = 64;
const MAX_ARTIFACTS = 32;
const MAX_ARTIFACT_CHARS = 512;
const CLOSED_PROMPT = "[closed thread prompt evicted]";

export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

export interface PersistedThreadSession {
  id: string;
  directory: string;
}

export interface PersistedCapabilityBoundary {
  filesystem: "none" | "read" | "write";
  network: "none" | "read" | "full";
  process: "none" | "limited" | "full";
  childThreads: boolean;
}

export interface PersistedHandoff {
  summary: string;
  nextAction?: string;
  artifacts?: string[];
}

export interface PersistedFailure {
  message: string;
  code?: string;
}

export interface PersistedTimestamps {
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  closedAt?: number;
}

export interface PersistedThread {
  id: string;
  parentId: string;
  displayName: string;
  attempt: number;
  role: string;
  prompt: string;
  model: string;
  tools: string[];
  capabilityBoundary: PersistedCapabilityBoundary;
  session: PersistedThreadSession;
  state: "queued" | "active" | "done" | "failed" | "stopped" | "orphaned" | "closed";
  usage: Record<string, unknown>;
  handoff: PersistedHandoff | undefined;
  result: string | undefined;
  failure: PersistedFailure | undefined;
  stopReason: string | undefined;
  evicted: boolean;
  timestamps: PersistedTimestamps;
  version: number;
  trace: unknown[];
  steering: unknown[];
}

export interface PersistedResult {
  id: string;
  name: string;
  agent: string;
  task: string;
  status: string;
  output: string;
  outputBytes: number;
  outputTruncatedBytes: number;
  usage: Record<string, unknown>;
  terminationReason: string | undefined;
  errorMessage: string | undefined;
  durationMs: number;
  exitCode: number | null;
  exitConfirmed: boolean;
}

export type SubagentPersistenceRecord =
  | { version: 1; event: "spawn"; parentId: string; thread: PersistedThread }
  | { version: 1; event: "snapshot"; parentId: string; id: string; thread: PersistedThread; result?: PersistedResult }
  | { version: 1; event: "close"; parentId: string; id: string; closedAt: number };

export interface SubagentPersistence {
  restore(entries: readonly SessionEntry[], parentId: string): readonly SubagentThread[];
  recordSpawn(thread: SubagentThread): void;
  recordSnapshot(thread: SubagentThread, result?: SubagentTaskResult): void;
  recordClose(thread: SubagentThread): void;
}

const INVALID = Symbol("invalid");
type SourceRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SourceRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value: unknown, seen = new Set<object>()): unknown | typeof INVALID {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID;
  if (typeof value !== "object") return INVALID;
  if (seen.has(value)) return INVALID;
  seen.add(value);
  let copy: unknown;
  if (Array.isArray(value)) {
    const array: unknown[] = [];
    for (const item of value) {
      const cloned = cloneJson(item, seen);
      if (cloned === INVALID) {
        seen.delete(value);
        return INVALID;
      }
      array.push(cloned);
    }
    copy = array;
  } else {
    const object: SourceRecord = {};
    for (const [key, item] of Object.entries(value)) {
      const cloned = cloneJson(item, seen);
      if (cloned === INVALID) {
        seen.delete(value);
        return INVALID;
      }
      object[key] = cloned;
    }
    copy = object;
  }
  seen.delete(value);
  return copy;
}

function cloneRecord(value: unknown): SourceRecord | undefined {
  const cloned = cloneJson(value);
  return isRecord(cloned) ? cloned : undefined;
}

function cloneArray(value: unknown): unknown[] | undefined {
  const cloned = cloneJson(value);
  return Array.isArray(cloned) ? cloned : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

const THREAD_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "costUsd",
  "turns",
] as const;
const RESULT_USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "turns"] as const;
const RESULT_COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function normalizeThreadUsage(value: unknown): Record<string, unknown> | undefined {
  const usage = cloneRecord(value);
  if (!usage) return undefined;
  for (const field of THREAD_USAGE_FIELDS) {
    if (!finiteNonNegative(usage[field])) return undefined;
  }
  return usage;
}

function normalizeResultUsage(value: unknown, fallback: unknown): Record<string, unknown> | undefined {
  const fallbackRecord = cloneRecord(fallback);
  const resultFallback = fallbackRecord && "inputTokens" in fallbackRecord
    ? {
      input: fallbackRecord.inputTokens,
      output: fallbackRecord.outputTokens,
      cacheRead: fallbackRecord.cacheReadTokens,
      cacheWrite: fallbackRecord.cacheWriteTokens,
      totalTokens: fallbackRecord.totalTokens,
      turns: fallbackRecord.turns,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: fallbackRecord.costUsd },
    }
    : fallback;
  const usage = cloneRecord(value ?? resultFallback);
  if (!usage) return undefined;
  if (RESULT_USAGE_FIELDS.some((field) => !finiteNonNegative(usage[field]))) return undefined;
  const cost = cloneRecord(usage.cost);
  if (!cost || RESULT_COST_FIELDS.some((field) => !finiteNonNegative(cost[field]))) return undefined;
  return { ...usage, cost };
}

function normalizeTrace(value: unknown[]): unknown[] | typeof INVALID {
  for (const event of value) {
    if (!isRecord(event) || !finiteNonNegative(event.at) || !text(event.kind)) return INVALID;
    if (event.message !== undefined && !text(event.message)) return INVALID;
    if (event.details !== undefined) {
      if (!isRecord(event.details)) return INVALID;
      for (const detail of Object.values(event.details)) {
        if (detail !== null && !["string", "number", "boolean"].includes(typeof detail)) return INVALID;
      }
    }
  }
  return boundedTrace(value);
}

function normalizeSteering(value: unknown[]): unknown[] | typeof INVALID {
  for (const message of value) {
    if (!isRecord(message) || !positiveInteger(message.id) || typeof message.at !== "number" || !Number.isFinite(message.at) || !text(message.message)) return INVALID;
  }
  return value;
}

function boundedChars(value: string, maxChars: number): string {
  return [...value].slice(0, maxChars).join("");
}

function boundedUtf8(value: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, omittedBytes: 0 };
  let end = maxBytes;
  while (end > 0 && Buffer.byteLength(bytes.subarray(0, end).toString("utf8"), "utf8") > end) end -= 1;
  const result = bytes.subarray(0, end).toString("utf8");
  return { text: result, omittedBytes: bytes.length - Buffer.byteLength(result, "utf8") };
}

function boundedTrace(value: unknown[]): unknown[] {
  const trace: unknown[] = [];
  for (const event of value) {
    const candidate = [...trace, event];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_TRACE_BYTES) break;
    trace.push(event);
  }
  return trace;
}

function normalizeTools(value: unknown): string[] | typeof INVALID {
  if (!Array.isArray(value)) return INVALID;
  const tools: string[] = [];
  for (const item of value.slice(0, MAX_TOOLS)) {
    if (typeof item !== "string" || !item.trim()) return INVALID;
    tools.push(boundedChars(item, MAX_TOOL_CHARS));
  }
  return tools;
}

function normalizeArtifacts(value: unknown): string[] | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return INVALID;
  const artifacts: string[] = [];
  for (const item of value.slice(0, MAX_ARTIFACTS)) {
    if (typeof item !== "string" || !item.trim()) return INVALID;
    artifacts.push(boundedChars(item, MAX_ARTIFACT_CHARS));
  }
  return artifacts;
}

function normalizeBoundary(value: unknown): PersistedCapabilityBoundary | undefined {
  if (!isRecord(value)) return undefined;
  if (!(value.filesystem === "none" || value.filesystem === "read" || value.filesystem === "write")) return undefined;
  if (!(value.network === "none" || value.network === "read" || value.network === "full")) return undefined;
  if (!(value.process === "none" || value.process === "limited" || value.process === "full")) return undefined;
  if (typeof value.childThreads !== "boolean") return undefined;
  return {
    filesystem: value.filesystem,
    network: value.network,
    process: value.process,
    childThreads: value.childThreads,
  };
}

function normalizeHandoff(value: unknown): PersistedHandoff | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return INVALID;
  const summary = text(value.summary);
  if (!summary) return INVALID;
  const nextAction = value.nextAction === undefined ? undefined : text(value.nextAction);
  if (value.nextAction !== undefined && !nextAction) return INVALID;
  const artifacts = normalizeArtifacts(value.artifacts);
  if (artifacts === INVALID) return INVALID;
  return {
    summary: boundedChars(summary, 256 * 1024),
    nextAction: nextAction === undefined ? undefined : boundedChars(nextAction, 4_000),
    artifacts,
  };
}

function normalizeFailure(value: unknown): PersistedFailure | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return INVALID;
  const message = text(value.message);
  if (!message) return INVALID;
  const code = value.code === undefined ? undefined : text(value.code);
  if (value.code !== undefined && !code) return INVALID;
  return { message: boundedChars(message, 512), code: code === undefined ? undefined : boundedChars(code, 256) };
}

function normalizeTimestamps(value: unknown): PersistedTimestamps | undefined {
  if (!isRecord(value) || !finiteNonNegative(value.createdAt) || !finiteNonNegative(value.updatedAt)) return undefined;
  const timestamps: PersistedTimestamps = { createdAt: value.createdAt, updatedAt: value.updatedAt };
  for (const name of ["startedAt", "endedAt", "closedAt"] as const) {
    if (value[name] !== undefined) {
      if (!finiteNonNegative(value[name])) return undefined;
      timestamps[name] = value[name];
    }
  }
  return timestamps;
}

function normalizeResult(value: unknown, thread: PersistedThread): PersistedResult | undefined | typeof INVALID {
  if (!isRecord(value)) return INVALID;
  if (value.id !== undefined && value.id !== thread.id) return INVALID;
  const id = thread.id;
  const name = boundedChars(text(value.name) ?? thread.displayName, 48);
  const agent = boundedChars(text(value.agent) ?? thread.role, 64);
  const task = typeof value.task === "string" ? value.task : thread.prompt;
  const status = text(value.status) ?? (thread.state === "done" ? "complete" : thread.state === "failed" ? "failed" : "cancelled");
  const rawOutput = value.output === undefined ? thread.result ?? "" : value.output;
  if (!id || !name || !agent || !task || !status || !["queued", "running", "complete", "failed", "cancelled", "limited"].includes(status) || typeof rawOutput !== "string") return INVALID;
  const output = boundedUtf8(rawOutput, MAX_RESULT_BYTES);
  const usage = normalizeResultUsage(value.usage, thread.usage);
  if (!usage) return INVALID;
  const outputBytes = value.outputBytes === undefined ? Buffer.byteLength(rawOutput, "utf8") : value.outputBytes;
  const priorTruncated = value.outputTruncatedBytes === undefined ? 0 : value.outputTruncatedBytes;
  if (!finiteNonNegative(outputBytes) || !finiteNonNegative(priorTruncated)) return INVALID;
  const normalizedOutputBytes = outputBytes as number;
  const normalizedPriorTruncated = priorTruncated as number;
  const durationMs = value.durationMs === undefined ? 0 : value.durationMs;
  if (!finiteNonNegative(durationMs)) return INVALID;
  const normalizedDurationMs = durationMs as number;
  const exitCodeValue = value.exitCode === undefined || value.exitCode === null ? null : value.exitCode;
  if (exitCodeValue !== null && (typeof exitCodeValue !== "number" || !Number.isSafeInteger(exitCodeValue) || exitCodeValue < 0)) return INVALID;
  const exitCode = exitCodeValue as number | null;
  const terminationReason = value.terminationReason === undefined ? undefined : text(value.terminationReason);
  const errorMessageValue = value.errorMessage === undefined ? undefined : typeof value.errorMessage === "string" ? value.errorMessage : INVALID;
  if (value.terminationReason !== undefined && !terminationReason) return INVALID;
  if (errorMessageValue === INVALID) return INVALID;
  const errorMessage = errorMessageValue === undefined ? undefined : boundedChars(errorMessageValue as string, 8_000);
  const exitConfirmedValue = value.exitConfirmed === undefined ? false : value.exitConfirmed;
  if (typeof exitConfirmedValue !== "boolean") return INVALID;
  return {
    id,
    name,
    agent,
    task: boundedChars(task, MAX_PROMPT_CHARS),
    status,
    output: output.text,
    outputBytes: normalizedOutputBytes,
    outputTruncatedBytes: normalizedPriorTruncated + output.omittedBytes,
    usage,
    terminationReason: terminationReason === undefined ? undefined : boundedChars(terminationReason, 256),
    errorMessage,
    durationMs: normalizedDurationMs,
    exitCode,
    exitConfirmed: exitConfirmedValue,
  };
}

function normalizeThread(value: unknown, expectedParentId?: string): PersistedThread | undefined {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const parentId = text(value.parentId);
  const displayName = text(value.displayName);
  const role = text(value.role);
  const prompt = text(value.prompt);
  const model = text(value.model);
  if (!id || !parentId || expectedParentId !== undefined && parentId !== expectedParentId || !displayName || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$/u.test(displayName) || !role || !prompt || !model) return undefined;
  const tools = normalizeTools(value.tools);
  const capabilityBoundary = normalizeBoundary(value.capabilityBoundary);
  const sessionId = isRecord(value.session) ? text(value.session.id) : undefined;
  const sessionDirectory = isRecord(value.session) && typeof value.session.directory === "string" ? value.session.directory : undefined;
  const session = sessionId && sessionDirectory
    ? { id: sessionId, directory: sessionDirectory }
    : undefined;
  const usage = normalizeThreadUsage(value.usage);
  const timestamps = normalizeTimestamps(value.timestamps);
  const states = new Set(["queued", "active", "done", "failed", "stopped", "orphaned", "closed"]);
  const state = value.state;
  const attempt = value.attempt;
  const version = value.version;
  const evicted = value.evicted;
  if (tools === INVALID || !capabilityBoundary || !session || !usage || !timestamps || typeof state !== "string" || !states.has(state)
    || !positiveInteger(attempt) || !positiveInteger(version) || typeof evicted !== "boolean") return undefined;
  const rawResult = value.result === undefined ? value.output : value.result;
  if (rawResult !== undefined && typeof rawResult !== "string") return undefined;
  const normalizedResult = rawResult as string | undefined;
  const handoff = normalizeHandoff(value.handoff);
  const failure = normalizeFailure(value.failure);
  if (handoff === INVALID || failure === INVALID) return undefined;
  const traceSource = value.trace === undefined ? [] : cloneArray(value.trace);
  const steering = value.steering === undefined ? [] : cloneArray(value.steering);
  if (!traceSource || !steering) return undefined;
  const trace = normalizeTrace(traceSource);
  const clonedSteering = normalizeSteering(steering);
  if (trace === INVALID || clonedSteering === INVALID) return undefined;
  const stopReason = value.stopReason === undefined ? undefined : text(value.stopReason);
  if (value.stopReason !== undefined && !stopReason) return undefined;
  return {
    id,
    parentId,
    displayName,
    attempt,
    role,
    prompt: boundedChars(prompt, MAX_PROMPT_CHARS),
    model,
    tools,
    capabilityBoundary,
    session,
    state: state as PersistedThread["state"],
    usage,
    handoff: handoff as PersistedHandoff | undefined,
    result: normalizedResult === undefined ? undefined : boundedUtf8(normalizedResult, MAX_RESULT_BYTES).text,
    failure: failure as PersistedFailure | undefined,
    stopReason,
    evicted,
    timestamps,
    version,
    trace,
    steering: clonedSteering,
  };
}

function persistedThread(thread: SubagentThread): PersistedThread {
  const source = thread as unknown as SourceRecord;
  const role = text(source.role);
  const parentId = text(source.parentId);
  if (!role || !parentId) throw new Error("Subagent persistence requires a child thread with a parentId and role");
  const normalized = normalizeThread({
    id: source.id,
    parentId,
    displayName: source.displayName ?? role,
    attempt: source.attempt ?? 1,
    role,
    prompt: source.prompt,
    model: source.model,
    tools: source.tools,
    capabilityBoundary: source.capabilityBoundary,
    session: source.session,
    state: source.state,
    usage: source.usage,
    handoff: source.handoff,
    result: source.result ?? source.output,
    failure: source.failure,
    stopReason: source.stopReason,
    evicted: source.evicted ?? false,
    timestamps: source.timestamps,
    version: source.version ?? 1,
    trace: source.trace ?? [],
    steering: source.steering ?? [],
  }, parentId);
  if (!normalized) throw new Error("Subagent thread snapshot is not persistable");
  return normalized;
}

function persistedResult(result: SubagentTaskResult, thread: PersistedThread): PersistedResult {
  const normalized = normalizeResult(result, thread);
  if (!normalized || normalized === INVALID) throw new Error("Subagent task result is not persistable");
  return normalized;
}

function closeTombstone(thread: PersistedThread, closedAt: number): PersistedThread {
  return {
    ...thread,
    state: "closed",
    prompt: CLOSED_PROMPT,
    handoff: undefined,
    trace: [],
    steering: [],
    result: undefined,
    failure: thread.failure ? { message: boundedChars(thread.failure.message, 512), code: thread.failure.code } : undefined,
    evicted: true,
    timestamps: { ...thread.timestamps, closedAt },
  };
}

function parentIdOf(thread: SubagentThread): string {
  const parentId = text((thread as unknown as SourceRecord).parentId);
  if (!parentId) throw new Error("Subagent persistence requires parentId");
  return parentId;
}

export function createSubagentPersistence(appendEntry: AppendEntryHandler, now: () => number = Date.now): SubagentPersistence {
  const append = (record: SubagentPersistenceRecord): void => appendEntry(SUBAGENT_PERSISTENCE_TYPE, record);

  return {
    restore(entries, parentId) {
      if (!text(parentId)) return [];
      const latest = new Map<string, PersistedThread>();
      for (const entry of entries) {
        try {
          if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_PERSISTENCE_TYPE) continue;
          const data = entry.data;
          if (!isRecord(data) || data.version !== RECORD_VERSION || data.parentId !== parentId) continue;
          if (data.event === "spawn") {
            const thread = normalizeThread(data.thread, parentId);
            if (thread) latest.set(thread.id, thread);
          } else if (data.event === "snapshot") {
            if (!text(data.id)) continue;
            const thread = normalizeThread(data.thread, parentId);
            if (!thread || thread.id !== data.id) continue;
            if (data.result !== undefined) {
              const result = normalizeResult(data.result, thread);
              if (!result || result === INVALID) continue;
              if (result.output) thread.result = result.output;
            }
            latest.set(thread.id, thread);
          } else if (data.event === "close") {
            const closedId = text(data.id);
            const closedAt = data.closedAt;
            if (!closedId || !finiteNonNegative(closedAt)) continue;
            const thread = latest.get(closedId);
            if (thread) latest.set(closedId, closeTombstone(thread, closedAt));
          }
        } catch {
          // A bad custom entry must not prevent the parent session from starting.
        }
      }
      return [...latest.values()].map((thread) => {
        const restored = { ...thread, tools: [...thread.tools], trace: [...thread.trace], steering: [...thread.steering], timestamps: { ...thread.timestamps } };
        if (restored.state === "queued" || restored.state === "active") {
          restored.state = "orphaned";
          restored.stopReason = "parent_restarted";
        }
        return restored as unknown as SubagentThread;
      });
    },

    recordSpawn(thread) {
      const snapshot = persistedThread(thread);
      append({ version: RECORD_VERSION, event: "spawn", parentId: snapshot.parentId, thread: snapshot });
    },

    recordSnapshot(thread, result) {
      const snapshot = persistedThread(thread);
      const record: Extract<SubagentPersistenceRecord, { event: "snapshot" }> = {
        version: RECORD_VERSION,
        event: "snapshot",
        parentId: snapshot.parentId,
        id: snapshot.id,
        thread: snapshot,
      };
      if (result !== undefined) record.result = persistedResult(result, snapshot);
      append(record);
    },

    recordClose(thread) {
      const parentId = parentIdOf(thread);
      const source = thread as unknown as SourceRecord;
      const timestamps = source.timestamps;
      const closedAt = isRecord(timestamps) && finiteNonNegative(timestamps.closedAt) ? timestamps.closedAt : now();
      if (!finiteNonNegative(closedAt)) throw new Error("Subagent close time must be a non-negative finite number");
      const id = text(source.id);
      if (!id) throw new Error("Subagent persistence requires a thread id");
      append({ version: RECORD_VERSION, event: "close", parentId, id, closedAt });
    },
  };
}
