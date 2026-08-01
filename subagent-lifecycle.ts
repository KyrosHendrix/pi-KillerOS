/** A dependency-free lifecycle model for child agent threads. */

declare const threadIdBrand: unique symbol;

export type SubagentThreadId = string & { readonly [threadIdBrand]: "SubagentThreadId" };
export type SubagentThreadState = "queued" | "active" | "done" | "failed" | "stopped" | "closed";
export type SubagentTerminalState = Extract<SubagentThreadState, "done" | "failed" | "stopped">;
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

export interface SubagentThreadSpec {
  parentId?: SubagentThreadId;
  role: string;
  prompt: string;
  model: string;
  tools: readonly string[];
  capabilityBoundary: SubagentCapabilityBoundary;
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
  state: SubagentThreadState;
  usage: SubagentUsage;
  trace: SubagentTraceEvent[];
  steering: SubagentSteeringMessage[];
  result?: string;
  failure?: { message: string; code?: string };
  stopReason?: string;
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

const DEFAULT_MAX_STEERING_MESSAGES = 20;
const DEFAULT_MAX_STEERING_MESSAGE_LENGTH = 4_000;
const UPDATABLE_STATES = new Set<SubagentThreadState>(["queued", "active"]);
const TERMINAL_STATES = new Set<SubagentThreadState>(["done", "failed", "stopped"]);
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
    role: thread.role,
    prompt: thread.prompt,
    model: thread.model,
    tools: [...thread.tools],
    capabilityBoundary: copyBoundary(thread.capabilityBoundary),
    handoff: copyHandoff(thread.handoff),
    state: thread.state,
    usage: { ...thread.usage },
    trace: thread.trace.map(copyTraceEvent),
    steering: thread.steering.map((message) => ({ ...message })),
    result: thread.result,
    failure: thread.failure ? { ...thread.failure } : undefined,
    stopReason: thread.stopReason,
    timestamps: { ...thread.timestamps },
    version: thread.version,
  };
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must be non-empty`);
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
  requireText(handoff.summary, "handoff.summary");
  if (handoff.nextAction !== undefined) requireText(handoff.nextAction, "handoff.nextAction");
  for (const artifact of handoff.artifacts ?? []) requireText(artifact, "handoff artifact");
}

function validateBoundary(boundary: SubagentCapabilityBoundary): void {
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

function isTerminal(state: SubagentThreadState): state is SubagentTerminalState {
  return TERMINAL_STATES.has(state);
}

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
  private nextId = 0;
  private nextSteeringId = 0;
  private disposed = false;

  constructor(options: SubagentThreadRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSteeringMessages = options.maxSteeringMessages ?? DEFAULT_MAX_STEERING_MESSAGES;
    this.maxSteeringMessageLength = options.maxSteeringMessageLength ?? DEFAULT_MAX_STEERING_MESSAGE_LENGTH;
    requirePositiveInteger(this.maxSteeringMessages, "maxSteeringMessages");
    requirePositiveInteger(this.maxSteeringMessageLength, "maxSteeringMessageLength");
    this.createId = options.createId ?? (() => `subagent-${++this.nextId}`);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  spawn(spec: SubagentThreadSpec): SubagentThread {
    this.assertOpen();
    this.validateSpec(spec);
    const rawId = this.createId();
    requireText(rawId, "thread id");
    const id = rawId as SubagentThreadId;
    if (this.threads.has(id)) throw new Error(`Duplicate thread id ${rawId}`);

    const timestamp = this.now();
    const thread: SubagentThread = {
      id,
      parentId: spec.parentId,
      role: spec.role,
      prompt: spec.prompt,
      model: spec.model,
      tools: [...spec.tools],
      capabilityBoundary: copyBoundary(spec.capabilityBoundary),
      handoff: copyHandoff(spec.handoff),
      state: "queued",
      usage: emptyUsage(),
      trace: [],
      steering: [],
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
    if (thread.steering.length > this.maxSteeringMessages) thread.steering.splice(0, thread.steering.length - this.maxSteeringMessages);
    this.changed(thread, "steer");
    return snapshot(thread);
  }

  complete(id: SubagentThreadId, completion: SubagentCompletion = {}): SubagentThread {
    const thread = this.requireState(id, ["active"]);
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

  listActive(): SubagentThread[] {
    return this.list((thread) => thread.state === "active");
  }

  /** Returns all terminal records: done, failed, and stopped. */
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

  /** Closes a terminal record while retaining its result for inspection. */
  close(id: SubagentThreadId): SubagentThread {
    this.assertOpen();
    const thread = this.requireThread(id);
    if (thread.state === "closed") return snapshot(thread);
    if (!isTerminal(thread.state)) throw new Error(`Cannot close thread ${id} from ${thread.state}`);
    thread.state = "closed";
    thread.timestamps.closedAt = this.now();
    this.changed(thread, "close");
    return snapshot(thread);
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
    requireText(spec.role, "role");
    requireText(spec.prompt, "prompt");
    requireText(spec.model, "model");
    validateBoundary(spec.capabilityBoundary);
    const tools = new Set<string>();
    for (const tool of spec.tools) {
      requireText(tool, "tool");
      if (tools.has(tool)) throw new Error(`Duplicate tool ${tool}`);
      tools.add(tool);
    }
    if (spec.handoff) validateHandoff(spec.handoff);
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
