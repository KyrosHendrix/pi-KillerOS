/** A dependency-free lifecycle model for child agent threads. */

declare const threadIdBrand: unique symbol;

export type SubagentThreadId = string & { readonly [threadIdBrand]: "SubagentThreadId" };
export type SubagentThreadState = "queued" | "active" | "done" | "failed" | "stopped" | "orphaned" | "closed";
export type SubagentTerminalState = Extract<SubagentThreadState, "done" | "failed" | "stopped" | "orphaned">;
export type SubagentFilesystemAccess = "none" | "read" | "write";
export type SubagentNetworkAccess = "none" | "read" | "full";
export type SubagentProcessAccess = "none" | "limited" | "full";

export interface SubagentCapabilityBoundary {
  filesystem: SubagentFilesystemAccess;
  network: SubagentNetworkAccess;
  process: SubagentProcessAccess;
  childThreads: boolean;
}

export interface SubagentHandoff {
  summary: string;
  nextAction?: string;
  artifacts?: readonly string[];
}

export interface SubagentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
}

export interface SubagentTraceEvent {
  at: number;
  kind: string;
  message?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SubagentTraceUpdate {
  kind: string;
  message?: string;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface SubagentSteeringMessage {
  id: number;
  at: number;
  message: string;
}

export interface SubagentThreadTimestamps {
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  closedAt?: number;
}

export interface SubagentThreadSession {
  id: string;
  directory: string;
}

export interface SubagentThreadSpec {
  parentId?: SubagentThreadId;
  displayName: string;
  role: string;
  prompt: string;
  model: string;
  tools: readonly string[];
  capabilityBoundary: SubagentCapabilityBoundary;
  session: SubagentThreadSession;
  handoff?: SubagentHandoff;
}

export interface SubagentThreadPatch {
  usage?: Partial<SubagentUsage>;
  handoff?: SubagentHandoff | null;
  result?: string | null;
}

export interface SubagentCompletion extends SubagentThreadPatch {
  result?: string;
}

export interface SubagentFailure extends SubagentThreadPatch {
  message: string;
  code?: string;
}

export interface SubagentStop extends SubagentThreadPatch {
  reason?: string;
}

export interface SubagentThread extends SubagentThreadSpec {
  id: SubagentThreadId;
  attempt: number;
  state: SubagentThreadState;
  usage: SubagentUsage;
  trace: SubagentTraceEvent[];
  steering: SubagentSteeringMessage[];
  result?: string;
  failure?: { message: string; code?: string };
  stopReason?: string;
  /** True when close evicted the heavy trace, prompt, handoff, and result fields. */
  evicted: boolean;
  timestamps: SubagentThreadTimestamps;
  version: number;
}

export type SubagentThreadChangeType =
  | "spawn"
  | "begin"
  | "patch"
  | "trace"
  | "steer"
  | "complete"
  | "fail"
  | "stop"
  | "interrupt"
  | "resume"
  | "close";

export interface SubagentThreadChange {
  type: SubagentThreadChangeType;
  thread: SubagentThread;
}

export interface SubagentThreadRegistryOptions {
  createId?: () => string;
  now?: () => number;
  maxSteeringMessages?: number;
  maxSteeringMessageLength?: number;
}

export type SubagentThreadListener = (change: SubagentThreadChange) => void;

export interface SubagentWaitResult {
  threadIds: readonly SubagentThreadId[];
  completedThreadIds: readonly SubagentThreadId[];
  pendingThreadIds: readonly SubagentThreadId[];
  timedOut: boolean;
  waitedMs: number;
  threads: readonly SubagentThread[];
}

const DEFAULT_MAX_STEERING_MESSAGES = 20;
const DEFAULT_MAX_STEERING_MESSAGE_LENGTH = 4_000;
const UPDATABLE_STATES = new Set<SubagentThreadState>(["queued", "active"]);
const TERMINAL_STATES = new Set<SubagentThreadState>(["done", "failed", "stopped", "orphaned"]);
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$/u;
const MAX_WAIT_TIMEOUT_MS = 2_147_483_647;
const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
  "costUsd",
  "turns",
] as const;

function emptyUsage(): SubagentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

function copyHandoff(handoff: SubagentHandoff | undefined): SubagentHandoff | undefined {
  if (!handoff) return undefined;
  return {
    summary: handoff.summary,
    nextAction: handoff.nextAction,
    artifacts: handoff.artifacts ? [...handoff.artifacts] : undefined,
  };
}

function copyBoundary(boundary: SubagentCapabilityBoundary): SubagentCapabilityBoundary {
  return { ...boundary };
}

function copySession(session: SubagentThreadSession): SubagentThreadSession {
  return { id: session.id, directory: session.directory };
}

function copyTraceEvent(event: SubagentTraceEvent): SubagentTraceEvent {
  return {
    at: event.at,
    kind: event.kind,
    message: event.message,
    details: event.details ? { ...event.details } : undefined,
  };
}

function snapshot(thread: SubagentThread): SubagentThread {
  return {
    id: thread.id,
    parentId: thread.parentId,
    displayName: thread.displayName,
    role: thread.role,
    prompt: thread.prompt,
    model: thread.model,
    tools: [...thread.tools],
    capabilityBoundary: copyBoundary(thread.capabilityBoundary),
    session: copySession(thread.session),
    handoff: copyHandoff(thread.handoff),
    attempt: thread.attempt,
    state: thread.state,
    usage: { ...thread.usage },
    trace: thread.trace.map(copyTraceEvent),
    steering: thread.steering.map((message) => ({ ...message })),
    result: thread.result,
    failure: thread.failure ? { ...thread.failure } : undefined,
    stopReason: thread.stopReason,
    evicted: thread.evicted,
    timestamps: { ...thread.timestamps },
    version: thread.version,
  };
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be non-empty`);
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function validateUsage(patch: Partial<SubagentUsage>): void {
  for (const field of USAGE_FIELDS) {
    const value = patch[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`usage.${field} must be a non-negative finite number`);
    }
  }
}

function validateHandoff(handoff: SubagentHandoff): void {
  if (!handoff || typeof handoff !== "object") throw new Error("handoff must be an object");
  requireText(handoff.summary, "handoff.summary");
  if (handoff.nextAction !== undefined) requireText(handoff.nextAction, "handoff.nextAction");
  if (handoff.artifacts !== undefined && !Array.isArray(handoff.artifacts)) throw new Error("handoff.artifacts must be an array");
  for (const artifact of handoff.artifacts ?? []) requireText(artifact, "handoff artifact");
}

function validateDisplayName(displayName: string): void {
  if (typeof displayName !== "string" || !DISPLAY_NAME_PATTERN.test(displayName)) {
    throw new Error("display name must match ^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$");
  }
}

function validateSession(session: SubagentThreadSession): void {
  if (!session || typeof session !== "object") throw new Error("session must be an object");
  requireText(session.id, "session.id");
  requireText(session.directory, "session.directory");
}

function validateBoundary(boundary: SubagentCapabilityBoundary): void {
  if (!boundary || typeof boundary !== "object") throw new Error("capabilityBoundary must be an object");
  if (!(["none", "read", "write"] as string[]).includes(boundary.filesystem)) {
    throw new Error("capabilityBoundary.filesystem must be none, read, or write");
  }
  if (!(["none", "read", "full"] as string[]).includes(boundary.network)) {
    throw new Error("capabilityBoundary.network must be none, read, or full");
  }
  if (!(["none", "limited", "full"] as string[]).includes(boundary.process)) {
    throw new Error("capabilityBoundary.process must be none, limited, or full");
  }
  if (typeof boundary.childThreads !== "boolean") throw new Error("capabilityBoundary.childThreads must be a boolean");
}

function validateTraceDetails(details: Readonly<Record<string, string | number | boolean | null>> | undefined): void {
  if (details === undefined) return;
  if (!details || typeof details !== "object" || Array.isArray(details)) throw new Error("trace.details must be an object");
  for (const value of Object.values(details)) {
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("trace.details values must be strings, numbers, booleans, or null");
    }
  }
}

function validateTraceEvent(event: SubagentTraceEvent, index: number): void {
  if (!event || typeof event !== "object") throw new Error(`trace[${index}] must be an object`);
  if (!Number.isFinite(event.at)) throw new Error(`trace[${index}].at must be a finite number`);
  requireText(event.kind, `trace[${index}].kind`);
  if (event.message !== undefined) requireText(event.message, `trace[${index}].message`);
  validateTraceDetails(event.details);
}

function validateSteeringMessage(message: SubagentSteeringMessage, index: number): void {
  if (!message || typeof message !== "object") throw new Error(`steering[${index}] must be an object`);
  requirePositiveInteger(message.id, `steering[${index}].id`);
  if (!Number.isFinite(message.at)) throw new Error(`steering[${index}].at must be a finite number`);
  requireText(message.message, `steering[${index}].message`);
}

function validateCompleteUsage(usage: SubagentUsage): void {
  if (!usage || typeof usage !== "object") throw new Error("usage must be an object");
  for (const field of USAGE_FIELDS) {
    if (!(field in usage)) throw new Error(`usage.${field} is required`);
  }
  validateUsage(usage);
}

function validateTimestamps(timestamps: SubagentThreadTimestamps): void {
  if (!timestamps || typeof timestamps !== "object") throw new Error("timestamps must be an object");
  for (const field of ["createdAt", "updatedAt", "startedAt", "endedAt", "closedAt"] as const) {
    const value = timestamps[field];
    if (value !== undefined && !Number.isFinite(value)) throw new Error(`timestamps.${field} must be a finite number`);
  }
  if (timestamps.createdAt === undefined) throw new Error("timestamps.createdAt is required");
  if (timestamps.updatedAt === undefined) throw new Error("timestamps.updatedAt is required");
}

function isTerminal(state: SubagentThreadState): state is SubagentTerminalState {
  return TERMINAL_STATES.has(state);
}

// Module-scoped so fresh registries keep assigning fresh ids across session replacements.
let nextId = 0;

/**
 * Owns child-thread state only. Callers execute, cancel, and transport work.
 * Each read returns a copy, so callers cannot mutate registry state.
 */
export class SubagentThreadRegistry {
  private readonly threads = new Map<SubagentThreadId, SubagentThread>();
  private readonly listeners = new Set<SubagentThreadListener>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxSteeringMessages: number;
  private readonly maxSteeringMessageLength: number;
  private nextSteeringId = 0;
  private disposed = false;

  constructor(options: SubagentThreadRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSteeringMessages = options.maxSteeringMessages ?? DEFAULT_MAX_STEERING_MESSAGES;
    this.maxSteeringMessageLength = options.maxSteeringMessageLength ?? DEFAULT_MAX_STEERING_MESSAGE_LENGTH;
    requirePositiveInteger(this.maxSteeringMessages, "maxSteeringMessages");
    requirePositiveInteger(this.maxSteeringMessageLength, "maxSteeringMessageLength");
    this.createId = options.createId ?? (() => `subagent-${++nextId}`);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  spawn(spec: SubagentThreadSpec): SubagentThread {
    this.assertOpen();
    this.validateSpec(spec);
    this.assertUniqueDisplayName(spec.displayName, spec.parentId);
    const rawId = this.createId();
    requireText(rawId, "thread id");
    const id = rawId as SubagentThreadId;
    if (this.threads.has(id)) throw new Error(`Duplicate thread id ${rawId}`);

    const timestamp = this.now();
    const thread: SubagentThread = {
      id,
      parentId: spec.parentId,
      displayName: spec.displayName,
      role: spec.role,
      prompt: spec.prompt,
      model: spec.model,
      tools: [...spec.tools],
      capabilityBoundary: copyBoundary(spec.capabilityBoundary),
      session: copySession(spec.session),
      handoff: copyHandoff(spec.handoff),
      attempt: 1,
      state: "queued",
      usage: emptyUsage(),
      trace: [],
      steering: [],
      evicted: false,
      timestamps: { createdAt: timestamp, updatedAt: timestamp },
      version: 1,
    };
    this.threads.set(id, thread);
    this.emit("spawn", thread);
    return snapshot(thread);
  }

  begin(id: SubagentThreadId): SubagentThread {
    const thread = this.requireState(id, ["queued"]);
    thread.state = "active";
    thread.timestamps.startedAt = this.now();
    this.changed(thread, "begin");
    return snapshot(thread);
  }

  patch(id: SubagentThreadId, patch: SubagentThreadPatch): SubagentThread {
    const thread = this.requireState(id, UPDATABLE_STATES);
    this.applyPatch(thread, patch);
    this.changed(thread, "patch");
    return snapshot(thread);
  }

  trace(id: SubagentThreadId, update: SubagentTraceUpdate): SubagentThread {
    const thread = this.requireState(id, UPDATABLE_STATES);
    requireText(update.kind, "trace.kind");
    if (update.message !== undefined) requireText(update.message, "trace.message");
    if (update.details) {
      for (const value of Object.values(update.details)) {
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
          throw new Error("trace.details values must be strings, numbers, booleans, or null");
        }
      }
    }
    thread.trace.push({ at: this.now(), kind: update.kind, message: update.message, details: update.details ? { ...update.details } : undefined });
    this.changed(thread, "trace");
    return snapshot(thread);
  }

  steer(id: SubagentThreadId, message: string): SubagentThread {
    const thread = this.requireState(id, UPDATABLE_STATES);
    requireText(message, "steering message");
    if (message.length > this.maxSteeringMessageLength) {
      throw new Error(`steering message exceeds ${this.maxSteeringMessageLength} characters`);
    }
    thread.steering.push({ id: ++this.nextSteeringId, at: this.now(), message });
    if (thread.steering.length > this.maxSteeringMessages) thread.steering.splice(this.maxSteeringMessages);
    this.changed(thread, "steer");
    return snapshot(thread);
  }

  complete(id: SubagentThreadId, completion: SubagentCompletion = {}): SubagentThread {
    const thread = this.requireState(id, ["active"]);
    const result = completion.result !== undefined ? completion.result : thread.result;
    if (result === undefined || result === null) throw new Error(`Cannot complete thread ${id} without a usable result`);
    requireText(result, "result");
    this.applyPatch(thread, completion);
    thread.state = "done";
    thread.timestamps.endedAt = this.now();
    this.changed(thread, "complete");
    return snapshot(thread);
  }

  fail(id: SubagentThreadId, failure: SubagentFailure): SubagentThread {
    const thread = this.requireState(id, ["active"]);
    requireText(failure.message, "failure.message");
    if (failure.code !== undefined) requireText(failure.code, "failure.code");
    this.applyPatch(thread, failure);
    thread.failure = { message: failure.message, code: failure.code };
    thread.state = "failed";
    thread.timestamps.endedAt = this.now();
    this.changed(thread, "fail");
    return snapshot(thread);
  }

  stop(id: SubagentThreadId, stop: SubagentStop = {}): SubagentThread {
    const thread = this.requireState(id, UPDATABLE_STATES);
    if (stop.reason !== undefined) requireText(stop.reason, "stop.reason");
    this.applyPatch(thread, stop);
    thread.stopReason = stop.reason ?? "stopped";
    thread.state = "stopped";
    thread.timestamps.endedAt = this.now();
    this.changed(thread, "stop");
    return snapshot(thread);
  }

  interrupt(id: SubagentThreadId, reason = "interrupted"): SubagentThread {
    const thread = this.requireState(id, ["active"]);
    requireText(reason, "interrupt reason");
    thread.stopReason = reason;
    thread.state = "stopped";
    thread.timestamps.endedAt = this.now();
    this.changed(thread, "interrupt");
    return snapshot(thread);
  }

  stopAllActive(stop: SubagentStop = {}): SubagentThread[] {
    return this.listActive().map((thread) => this.stop(thread.id, stop));
  }

  interruptAllActive(reason = "interrupted"): SubagentThread[] {
    return this.listActive().map((thread) => this.interrupt(thread.id, reason));
  }

  inspect(id: SubagentThreadId): SubagentThread | undefined {
    const thread = this.threads.get(id);
    return thread ? snapshot(thread) : undefined;
  }

  resolve(reference: string, parentId?: SubagentThreadId): SubagentThread | undefined {
    if (typeof reference !== "string") return undefined;
    const exact = this.threads.get(reference as SubagentThreadId);
    if (exact) return snapshot(exact);
    const name = reference.toLocaleLowerCase();
    const match = [...this.threads.values()].find((thread) =>
      thread.parentId === parentId && thread.displayName.toLocaleLowerCase() === name,
    );
    return match ? snapshot(match) : undefined;
  }

  hydrate(thread: SubagentThread): SubagentThread {
    this.assertOpen();
    this.validateThreadSnapshot(thread);
    if (this.threads.has(thread.id)) throw new Error(`Duplicate thread id ${thread.id}`);
    this.assertUniqueDisplayName(thread.displayName, thread.parentId);

    const hydrated = snapshot(thread);
    if (hydrated.state === "queued" || hydrated.state === "active") {
      hydrated.state = "orphaned";
      hydrated.stopReason = "parent_restarted";
    }
    this.threads.set(hydrated.id, hydrated);
    for (const message of hydrated.steering) this.nextSteeringId = Math.max(this.nextSteeringId, message.id);
    return snapshot(hydrated);
  }

  resume(id: SubagentThreadId, prompt?: string): SubagentThread {
    const thread = this.requireState(id, ["done", "failed", "stopped", "orphaned"]);
    if (prompt !== undefined) {
      requireText(prompt, "prompt");
      thread.prompt = prompt;
    }
    thread.attempt += 1;
    thread.result = undefined;
    thread.failure = undefined;
    thread.stopReason = undefined;
    delete thread.timestamps.startedAt;
    delete thread.timestamps.endedAt;
    thread.state = "queued";
    this.changed(thread, "resume");
    return snapshot(thread);
  }

  waitForTerminal(ids: readonly SubagentThreadId[], timeoutMs: number): Promise<SubagentWaitResult> {
    const threadIds = [...ids];
    if (threadIds.length === 0) {
      return Promise.resolve({
        threadIds,
        completedThreadIds: [],
        pendingThreadIds: [],
        timedOut: false,
        waitedMs: 0,
        threads: [],
      });
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
      throw new Error(`timeoutMs must be an integer from 0 to ${MAX_WAIT_TIMEOUT_MS}`);
    }
    for (const id of threadIds) this.requireThread(id);

    const startedAt = Date.now();
    const currentThreads = (): SubagentThread[] => threadIds.map((id) => snapshot(this.threads.get(id)!));
    const makeResult = (timedOut: boolean): SubagentWaitResult => {
      const threads = currentThreads();
      const completedThreadIds = threads.filter((thread) => isTerminal(thread.state)).map((thread) => thread.id);
      return {
        threadIds,
        completedThreadIds,
        pendingThreadIds: threads.filter((thread) => !isTerminal(thread.state)).map((thread) => thread.id),
        timedOut,
        waitedMs: Math.max(0, Date.now() - startedAt),
        threads,
      };
    };
    const allTerminal = (): boolean => threadIds.every((id) => isTerminal(this.threads.get(id)!.state));
    if (allTerminal()) return Promise.resolve(makeResult(false));

    return new Promise<SubagentWaitResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = (): void => {};
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer !== undefined) clearTimeout(timer);
        resolve(makeResult(timedOut));
      };
      unsubscribe = this.subscribe((change) => {
        if (threadIds.includes(change.thread.id) && allTerminal()) finish(false);
      });
      timer = setTimeout(() => finish(true), timeoutMs);
    });
  }

  listActive(): SubagentThread[] {
    return this.list((thread) => thread.state === "active");
  }

  /** Returns all terminal records: done, failed, stopped, and orphaned. */
  listDone(): SubagentThread[] {
    return this.list((thread) => isTerminal(thread.state));
  }

  listAll(): SubagentThread[] {
    return this.list(() => true);
  }

  /** Returns a terminal snapshot without removing the record. */
  collect(id: SubagentThreadId): SubagentThread {
    const thread = this.requireThread(id);
    if (!isTerminal(thread.state)) throw new Error(`Thread ${id} is ${thread.state}, not terminal`);
    return snapshot(thread);
  }

  /** Closes a terminal record and retains only a small tombstone for inspection. */
  close(id: SubagentThreadId): SubagentThread {
    this.assertOpen();
    const thread = this.requireThread(id);
    if (thread.state === "closed") return snapshot(thread);
    if (!isTerminal(thread.state)) throw new Error(`Cannot close thread ${id} from ${thread.state}`);
    thread.state = "closed";
    thread.timestamps.closedAt = this.now();
    thread.prompt = "[closed thread prompt evicted]";
    thread.handoff = undefined;
    thread.trace = [];
    thread.steering = [];
    thread.result = undefined;
    thread.failure = thread.failure ? { message: thread.failure.message.slice(0, 512), code: thread.failure.code } : undefined;
    thread.evicted = true;
    this.changed(thread, "close");
    return snapshot(thread);
  }

  /** Remove the oldest closed tombstones and return bounded eviction notices. */
  pruneClosed(maxRecords: number): SubagentThread[] {
    this.assertOpen();
    const closed = [...this.threads.values()]
      .filter((thread) => thread.state === "closed")
      .sort((left, right) => (left.timestamps.closedAt ?? left.timestamps.updatedAt) - (right.timestamps.closedAt ?? right.timestamps.updatedAt));
    const removed: SubagentThread[] = [];
    while (closed.length > Math.max(0, Math.floor(maxRecords))) {
      const thread = closed.shift()!;
      this.threads.delete(thread.id);
      removed.push(snapshot(thread));
    }
    return removed;
  }

  subscribe(listener: SubagentThreadListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const thread of this.listAll().filter((candidate) => candidate.state === "queued" || candidate.state === "active")) {
      this.stop(thread.id, { reason: "disposed" });
    }
    for (const thread of this.listDone()) this.close(thread.id);
    this.listeners.clear();
    this.disposed = true;
  }

  private validateSpec(spec: SubagentThreadSpec): void {
    if (!spec || typeof spec !== "object") throw new Error("thread spec must be an object");
    if (spec.parentId !== undefined) requireText(spec.parentId, "parent id");
    validateDisplayName(spec.displayName);
    requireText(spec.role, "role");
    requireText(spec.prompt, "prompt");
    requireText(spec.model, "model");
    validateBoundary(spec.capabilityBoundary);
    validateSession(spec.session);
    if (!Array.isArray(spec.tools)) throw new Error("tools must be an array");
    const tools = new Set<string>();
    for (const tool of spec.tools) {
      requireText(tool, "tool");
      if (tools.has(tool)) throw new Error(`Duplicate tool ${tool}`);
      tools.add(tool);
    }
    if (spec.handoff) validateHandoff(spec.handoff);
  }

  private validateThreadSnapshot(thread: SubagentThread): void {
    if (!thread || typeof thread !== "object") throw new Error("thread snapshot must be an object");
    requireText(thread.id, "thread id");
    this.validateSpec(thread);
    if (!(["queued", "active", "done", "failed", "stopped", "orphaned", "closed"] as string[]).includes(thread.state)) {
      throw new Error(`Unknown thread state ${thread.state}`);
    }
    requirePositiveInteger(thread.attempt, "attempt");
    validateCompleteUsage(thread.usage);
    if (!Array.isArray(thread.trace)) throw new Error("trace must be an array");
    thread.trace.forEach(validateTraceEvent);
    if (!Array.isArray(thread.steering)) throw new Error("steering must be an array");
    thread.steering.forEach(validateSteeringMessage);
    if (thread.result !== undefined) requireText(thread.result, "result");
    if (thread.failure !== undefined) {
      if (!thread.failure || typeof thread.failure !== "object") throw new Error("failure must be an object");
      requireText(thread.failure.message, "failure.message");
      if (thread.failure.code !== undefined) requireText(thread.failure.code, "failure.code");
    }
    if (thread.stopReason !== undefined) requireText(thread.stopReason, "stopReason");
    if (typeof thread.evicted !== "boolean") throw new Error("evicted must be a boolean");
    validateTimestamps(thread.timestamps);
    requirePositiveInteger(thread.version, "version");
  }

  private applyPatch(thread: SubagentThread, patch: SubagentThreadPatch): void {
    if (patch.usage) {
      validateUsage(patch.usage);
      Object.assign(thread.usage, patch.usage);
    }
    if (patch.handoff !== undefined) {
      if (patch.handoff) validateHandoff(patch.handoff);
      thread.handoff = copyHandoff(patch.handoff ?? undefined);
    }
    if (patch.result !== undefined) {
      if (patch.result !== null) requireText(patch.result, "result");
      thread.result = patch.result ?? undefined;
    }
  }

  private list(matches: (thread: SubagentThread) => boolean): SubagentThread[] {
    return [...this.threads.values()].filter(matches).map(snapshot);
  }

  private assertUniqueDisplayName(displayName: string, parentId?: SubagentThreadId): void {
    const name = displayName.toLocaleLowerCase();
    if ([...this.threads.values()].some((thread) =>
      thread.parentId === parentId && thread.displayName.toLocaleLowerCase() === name,
    )) {
      throw new Error(`display name ${displayName} already exists for this parent`);
    }
  }

  private requireThread(id: SubagentThreadId): SubagentThread {
    this.assertOpen();
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`Unknown thread ${id}`);
    return thread;
  }

  private requireState(id: SubagentThreadId, allowed: Iterable<SubagentThreadState>): SubagentThread {
    const thread = this.requireThread(id);
    const allowedStates = [...allowed];
    if (!allowedStates.includes(thread.state)) {
      throw new Error(`Cannot change thread ${id} from ${thread.state}; expected ${allowedStates.join(" or ")}`);
    }
    return thread;
  }

  private changed(thread: SubagentThread, type: SubagentThreadChangeType): void {
    thread.timestamps.updatedAt = this.now();
    thread.version += 1;
    this.emit(type, thread);
  }

  private emit(type: SubagentThreadChangeType, thread: SubagentThread): void {
    for (const listener of this.listeners) listener({ type, thread: snapshot(thread) });
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("SubagentThreadRegistry is disposed");
  }
}
