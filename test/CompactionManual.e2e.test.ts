import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const reportsRoot = path.join(repositoryRoot, "node_modules", ".killeros-compaction-manual-reports");
const fixtureProvider = "compact-manual";
const fixtureKey = "compact-manual-loopback-only";
const waitTimeoutMs = 60_000;

type JsonObject = Record<string, unknown>;
type ProbeEvent = JsonObject & { sequence: number; type: string };
type ProviderRequest = { index: number; body: JsonObject };
type ProviderReply =
  | { kind: "text"; content: string; usageTokens?: number }
  | { kind: "complete"; evidence: string; usageTokens?: number }
  | { kind: "error"; status: number; message: string; errorType?: string };
type Barrier = { released: Promise<void>; release(): void };
type ProviderPlan = ProviderReply | { kind: "held"; barrier: Barrier; fallback: ProviderReply };
type RpcOutcome = { kind: "response"; record: PiRpcRecord } | { kind: "failure"; error: unknown };
type Notification = { message: string; type: string };
type SessionSnapshot = {
  label: string;
  fileExists: boolean;
  entryCount: number;
  goalStatuses: string[];
  manualMarkers: boolean[];
  compactionEntries: number;
};
type HistoryResult = {
  scenarioId: string;
  label: string;
  piLaunches: number;
  otherChildLaunches: number;
  providerRequests: number;
  providerPlansRemaining: number;
  goalContinuations: number;
  naturalExit: boolean;
  scratchRemoved: boolean;
  sessionFiles: SessionSnapshot[];
};
type FixtureBase = {
  directory: string;
  project: string;
  agent: string;
  sessions: string;
  planFile: string;
  probeFile: string;
  faultModeFile: string;
  faultAttemptFile: string;
  sessionFiles: Map<string, string>;
  heldIndexes: number[];
  provider: LocalProvider;
};
type Fixture = FixtureBase & {
  signal: AbortSignal;
  rpc: PiRpcProcess;
  sessionFile: string;
  pendingRpcCursors: Map<symbol, number>;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function stringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`${field} must be a string`);
  return candidate;
}

function finiteNumberField(value: JsonObject, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) throw new Error(`${field} must be a finite number`);
  return candidate;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function makeBarrier(): Barrier {
  let releasePromise: () => void = () => {};
  let released = false;
  const promise = new Promise<void>((resolve) => { releasePromise = resolve; });
  return {
    released: promise,
    release() {
      if (released) return;
      released = true;
      releasePromise();
    },
  };
}

/** Serves scripted loopback requests and makes every unexpected request a fixture fault. */
class LocalProvider {
  private readonly server: Server;
  private readonly plans: ProviderPlan[] = [];
  private readonly barriers = new Set<Barrier>();
  private readonly handlers = new Set<Promise<void>>();
  private readonly requestWaiters = new Set<{
    count: number;
    resolve: (request: ProviderRequest) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    abort?: () => void;
  }>();
  private baseUrl = "";
  readonly requests: ProviderRequest[] = [];
  readonly faults: string[] = [];
  readonly abortedRequests: number[] = [];

  constructor() {
    this.server = createServer((request, response) => {
      const handler = this.handleRequest(request, response);
      this.handlers.add(handler);
      void handler.then(
        () => this.handlers.delete(handler),
        (error: unknown) => {
          this.faults.push(errorText(error));
          this.handlers.delete(handler);
          if (!response.destroyed && !response.writableEnded) {
            response.writeHead(500, { connection: "close" });
            response.end("Manual compaction provider fixture failed");
          }
        },
      );
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }

  get url(): string {
    if (!this.baseUrl) throw new Error("The loopback provider is not listening");
    return this.baseUrl;
  }

  get remainingPlans(): number {
    return this.plans.length;
  }

  enqueue(plan: ProviderPlan): void {
    this.plans.push(plan);
    if (plan.kind === "held") this.barriers.add(plan.barrier);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The loopback provider did not bind a TCP port"));
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  async waitForRequest(count: number, signal: AbortSignal): Promise<ProviderRequest> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    const existing = this.requests[count - 1];
    if (existing) return existing;
    if (signal.aborted) throw new Error("Provider request wait was cancelled", { cause: signal.reason });
    return await new Promise<ProviderRequest>((resolve, reject) => {
      const waiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => finish(new Error(`Timed out waiting for provider request ${count}`)), waitTimeoutMs),
        signal,
        abort: (): void => finish(new Error("Provider request wait was cancelled", { cause: signal.reason })),
      };
      const finish = (error?: Error, request?: ProviderRequest): void => {
        clearTimeout(waiter.timer);
        signal.removeEventListener("abort", waiter.abort);
        this.requestWaiters.delete(waiter);
        if (error) reject(error);
        else if (request) resolve(request);
        else reject(new Error("Provider request wait ended without a request"));
      };
      this.requestWaiters.add(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      const arrived = this.requests[count - 1];
      if (arrived) finish(undefined, arrived);
    });
  }

  releaseAll(): void {
    for (const barrier of this.barriers) barrier.release();
  }

  async close(): Promise<void> {
    this.releaseAll();
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
      this.server.closeAllConnections();
      await closed;
    }
    await Promise.all([...this.handlers]);
    for (const waiter of this.requestWaiters) {
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("Provider closed before the expected request arrived"));
    }
    this.requestWaiters.clear();
    assert.deepEqual(this.faults, [], "the loopback provider must not record fixture faults");
  }

  private async readBody(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      assert.ok(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      assert.ok(bytes <= 1_048_576, "provider request exceeded the 1 MiB bound");
      chunks.push(Buffer.from(chunk));
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "provider request body");
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    const body = await this.readBody(request);
    assert.equal(body.model, "local");
    const plan = this.plans.shift();
    assert.ok(plan, `provider request ${this.requests.length + 1} has no scripted response`);
    const observed = { index: this.requests.length + 1, body };
    this.requests.push(observed);
    for (const waiter of this.requestWaiters) {
      if (waiter.count !== observed.index) continue;
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
      this.requestWaiters.delete(waiter);
      waiter.resolve(observed);
    }
    const reply = plan.kind === "held" ? await this.waitForHeld(plan, response, observed.index) : plan;
    if (reply === undefined || response.destroyed || response.writableEnded) return;
    this.sendReply(response, observed.index, reply);
  }

  private async waitForHeld(
    plan: Extract<ProviderPlan, { kind: "held" }>,
    response: ServerResponse,
    requestIndex: number,
  ): Promise<ProviderReply | undefined> {
    const closed = new Promise<"closed">((resolve) => response.once("close", () => resolve("closed")));
    const released = plan.barrier.released.then(() => "released" as const);
    const result = await Promise.race([closed, released]);
    if (result === "closed" || response.destroyed || response.writableEnded) {
      this.abortedRequests.push(requestIndex);
      return undefined;
    }
    return plan.fallback;
  }

  private sendReply(response: ServerResponse, index: number, reply: ProviderReply): void {
    if (reply.kind === "error") {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        connection: "close",
        ...(reply.status === 429 ? { "retry-after": "30" } : {}),
      });
      response.end(JSON.stringify({ error: {
        message: reply.message,
        type: reply.errorType ?? (reply.status === 429 ? "rate_limit_error" : "server_error"),
        ...(reply.errorType === "context_length_exceeded" ? { code: "context_length_exceeded" } : {}),
      } }));
      return;
    }
    const delta = reply.kind === "complete"
      ? { tool_calls: [{ index: 0, id: `manual-goal-${index}`, type: "function", function: {
        name: "killeros_goal_update",
        arguments: JSON.stringify({ status: "complete", evidence: reply.evidence }),
      } }] }
      : { content: reply.content };
    const usage = reply.usageTokens === undefined
      ? undefined
      : {
        prompt_tokens: Math.max(0, reply.usageTokens - 1),
        completion_tokens: 1,
        total_tokens: reply.usageTokens,
      };
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(`data: ${JSON.stringify({
      id: `compact-manual-${index}`,
      model: "local",
      choices: [{ index: 0, delta, finish_reason: reply.kind === "complete" ? "tool_calls" : "stop" }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\ndata: [DONE]\n\n`);
  }
}

/** Observation-only hooks; compaction cancellation and barriers use Pi's public hook result. */
const probeExtensionSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const probeFile = process.env.KILLEROS_MANUAL_PROBE;
const planFile = process.env.KILLEROS_MANUAL_PLAN;
const faultModeFile = process.env.KILLEROS_MANUAL_FAULT_MODE;
const faultAttemptFile = process.env.KILLEROS_MANUAL_FAULT_ATTEMPT;
const sessionFile = process.env.KILLEROS_MANUAL_SESSION;
if (!probeFile || !planFile || !faultModeFile || !faultAttemptFile || !sessionFile) throw new Error("Manual compaction fixture paths are missing");

let sequence = 0;
let compactionIndex = 0;
let faultAdapterInstalled = false;
let faultConsumed = false;
const originalAppendFileSync = fs.appendFileSync.bind(fs);

function record(type, details = {}) {
  fs.appendFileSync(probeFile, JSON.stringify({ sequence: ++sequence, type, ...details }) + "\n", "utf8");
}

function limitedString(value, limit = 160) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function modelIdentity(model) {
  if (!model) return null;
  return {
    provider: limitedString(model.provider),
    id: limitedString(model.id ?? model.modelId),
    api: limitedString(model.api),
  };
}

function contentShape(content) {
  if (typeof content === "string") return { kind: "text", characters: content.length };
  if (!Array.isArray(content)) return { kind: content === null ? "null" : typeof content };
  const sample = content.slice(0, 16);
  let textCharactersInSample = 0;
  for (const block of sample) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      textCharactersInSample = Math.min(1_000_000, textCharactersInSample + block.text.length);
    }
  }
  return {
    kind: "blocks",
    count: content.length,
    inspected: sample.length,
    omitted: Math.max(0, content.length - sample.length),
    textCharactersInSample,
    types: sample.map((block) => block && typeof block === "object" ? limitedString(block.type, 40) : null),
  };
}

function messageMetadata(message) {
  if (!message || typeof message !== "object") return null;
  return {
    role: limitedString(message.role, 40),
    timestamp: typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? message.timestamp
      : limitedString(message.timestamp, 64),
    provider: limitedString(message.provider),
    model: limitedString(message.model),
    api: limitedString(message.api),
    stopReason: limitedString(message.stopReason, 40),
    hasErrorMessage: typeof message.errorMessage === "string",
    errorMessageLength: typeof message.errorMessage === "string" ? message.errorMessage.length : null,
    content: contentShape(message.content),
  };
}

function entryMetadata(entry) {
  const metadata = {
    type: limitedString(entry.type, 40),
    id: limitedString(entry.id),
    parentId: limitedString(entry.parentId),
    timestamp: limitedString(entry.timestamp, 64),
  };
  if (entry.type === "message") metadata.message = messageMetadata(entry.message);
  if (entry.type === "model_change") metadata.model = modelIdentity({ provider: entry.provider, modelId: entry.modelId });
  if (entry.type === "compaction") {
    metadata.firstKeptEntryId = limitedString(entry.firstKeptEntryId);
    metadata.tokensBefore = Number.isFinite(entry.tokensBefore) ? entry.tokensBefore : null;
  }
  if (entry.type === "context_edit") {
    metadata.targetId = limitedString(entry.targetId);
    metadata.replacement = entry.replacement === null
      ? "removed"
      : entry.replacement && typeof entry.replacement === "object"
        ? contentShape(entry.replacement.content)
        : "unknown";
  }
  return metadata;
}

function branchMetadata(branch) {
  return {
    entryCount: branch.length,
    omittedEntries: Math.max(0, branch.length - 20),
    tail: branch.slice(-20).map(entryMetadata),
  };
}

function projectionMetadata(projection) {
  return {
    model: modelIdentity(projection.model),
    entryCount: projection.entries.length,
    omittedEntries: Math.max(0, projection.entries.length - 20),
    entries: projection.entries.slice(-20).map(({ sourceEntry, messages }) => ({
      source: entryMetadata(sourceEntry),
      messageCount: messages.length,
      omittedMessages: Math.max(0, messages.length - 8),
      roles: messages.slice(0, 8).map((message) => limitedString(message.role, 40)),
    })),
    messageCount: projection.messages.length,
    omittedMessages: Math.max(0, projection.messages.length - 16),
    messages: projection.messages.slice(-16).map(messageMetadata),
  };
}

function atomicWrite(filePath, contents) {
  const temporary = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, filePath);
}

function restoreAppendAdapter() {
  if (!faultAdapterInstalled) return;
  fs.appendFileSync = originalAppendFileSync;
  syncBuiltinESMExports();
  faultAdapterInstalled = false;
}

function readPlan() {
  return JSON.parse(fs.readFileSync(planFile, "utf8"));
}

function waitForRelease(filePath, token, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let watcher;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      try {
        if (fs.readFileSync(filePath, "utf8") === token + "\n") finish();
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") finish(error);
      }
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Compaction hook was aborted"));
    try {
      watcher = fs.watch(path.dirname(filePath), { persistent: false }, (_event, name) => {
        if (name === null || name.toString() === path.basename(filePath)) check();
      });
      watcher.on("error", finish);
      timer = setTimeout(() => finish(new Error("Manual summary barrier timed out")), 120_000);
      signal.addEventListener("abort", abort, { once: true });
      check();
    } catch (error) {
      finish(error);
    }
  });
}

if (faultModeFile && faultAttemptFile && sessionFile) {
  const patchedAppendFileSync = function(file, data, ...args) {
    const ownedSessionPath = typeof file === "string"
      && path.resolve(file).toLowerCase() === path.resolve(sessionFile).toLowerCase();
    let mode = "";
    if (ownedSessionPath && !faultConsumed) {
      try { mode = fs.readFileSync(faultModeFile, "utf8").trim(); }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (ownedSessionPath && mode === "deny-next" && !faultConsumed
      && String(data).includes('"customType":"killeros-goal"')) {
      faultConsumed = true;
      const acknowledgment = { pid: process.pid, operation: "appendFileSync", path: file };
      try {
        originalAppendFileSync(faultAttemptFile, JSON.stringify(acknowledgment) + "\n", "utf8");
      } finally {
        restoreAppendAdapter();
      }
      record("append_fault", acknowledgment);
      throw new Error("session storage unavailable");
    }
    return originalAppendFileSync(file, data, ...args);
  };
  fs.appendFileSync = patchedAppendFileSync;
  syncBuiltinESMExports();
  faultAdapterInstalled = true;
}
process.once("exit", restoreAppendAdapter);

export default function observeManualCompaction(pi) {
  for (const name of ["session_start", "agent_start", "agent_end", "agent_settled", "message_start", "session_compact", "session_compact_failed"]) {
    pi.on(name, (event, ctx) => {
      if (name === "agent_end") {
        const messages = Array.isArray(event.messages) ? event.messages : [];
        const assistant = [...messages].reverse().find((message) => message && message.role === "assistant");
        record(name, {
          stopReason: assistant?.stopReason ?? null,
          hasErrorMessage: typeof assistant?.errorMessage === "string",
          errorMessageLength: typeof assistant?.errorMessage === "string" ? assistant.errorMessage.length : null,
          assistant: messageMetadata(assistant),
          selectedModel: modelIdentity(ctx.model),
          branch: branchMetadata(ctx.sessionManager.getBranch()),
          projection: projectionMetadata(ctx.sessionManager.buildSessionProjection()),
        });
        return;
      }
      if (name === "agent_settled") {
        record(name, { aborted: event.aborted === true, idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
        return;
      }
      if (name === "message_start") {
        record(name, {
          role: event.message.role,
          customType: event.message.role === "custom" ? event.message.customType : undefined,
        });
        return;
      }
      if (name === "session_compact") {
        record(name, {
          reason: event.reason,
          index: compactionIndex,
          fromExtension: event.fromExtension,
          compactionTimestamp: event.compactionEntry.timestamp,
        });
        return;
      }
      if (name === "session_compact_failed") {
        record(name, { reason: event.reason, errorMessage: event.errorMessage ?? null, aborted: event.aborted, willRetry: event.willRetry });
        return;
      }
      record(name, { mode: ctx.mode });
    });
  }

  pi.on("session_before_compact", async (event) => {
    const plan = readPlan();
    const index = ++compactionIndex;
    const token = "summary-" + index;
    record("session_before_compact", {
      index,
      reason: event.reason,
      willRetry: event.willRetry,
      tokensBefore: event.preparation.tokensBefore,
      hasSummarizableMessages: event.preparation.messagesToSummarize.length > 0,
    });
    if (Array.isArray(plan.holdIndexes) && plan.holdIndexes.includes(index)) {
      atomicWrite(path.join(path.dirname(probeFile), token + ".ack"), token + "\n");
      record("summary_barrier_ack", { index });
      await waitForRelease(path.join(path.dirname(probeFile), token + ".release"), token, event.signal);
    }
    if (Array.isArray(plan.cancelIndexes) && plan.cancelIndexes.includes(index)) return { cancel: true };
    return undefined;
  });

  pi.on("session_shutdown", (event) => {
    restoreAppendAdapter();
    record("session_shutdown", { reason: event.reason, faultAdapterRestored: !faultAdapterInstalled });
  });
}
`;

function readProbeEvents(filePath: string): ProbeEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean);
  return lines.map((line, index) => {
    const event = record(JSON.parse(line), `probe event ${index + 1}`);
    const sequence = finiteNumberField(event, "sequence");
    const type = stringField(event, "type");
    assert.equal(sequence, index + 1, "probe event sequences must be contiguous");
    return { ...event, sequence, type };
  });
}

function lastProbeSequence(fixture: Fixture): number {
  return readProbeEvents(fixture.probeFile).at(-1)?.sequence ?? 0;
}

async function waitForProbe(
  filePath: string,
  predicate: (event: ProbeEvent) => boolean,
  label: string,
  signal: AbortSignal,
  after = 0,
): Promise<ProbeEvent> {
  if (signal.aborted) throw new Error(`${label} was cancelled`, { cause: signal.reason });
  return await new Promise<ProbeEvent>((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (error?: Error, event?: ProbeEvent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (event) resolve(event);
      else reject(new Error(`${label} ended without an event`));
    };
    const check = (): void => {
      try {
        const event = readProbeEvents(filePath).find((candidate) => candidate.sequence > after && predicate(candidate));
        if (event) finish(undefined, event);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const abort = (): void => finish(new Error(`${label} was cancelled`, { cause: signal.reason }));
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), waitTimeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      watcher = watch(path.dirname(filePath), { persistent: false }, (_event, name) => {
        if (name === null || name.toString() === path.basename(filePath)) check();
      });
      watcher.on("error", (error) => finish(error));
      check();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function writeAtomic(filePath: string, contents: string): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, filePath);
}

async function releaseSummary(fixture: Fixture, index: number): Promise<void> {
  const token = `summary-${index}`;
  writeAtomic(path.join(fixture.directory, `${token}.release`), `${token}\n`);
}

async function releaseAllSummaryGates(fixture: Fixture): Promise<void> {
  const errors: unknown[] = [];
  for (const index of fixture.heldIndexes) {
    const releasePath = path.join(fixture.directory, `summary-${index}.release`);
    if (existsSync(releasePath)) continue;
    try { await releaseSummary(fixture, index); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not release every owned summary gate");
}

function sessionFileFor(base: Omit<FixtureBase, "provider">, label: string): string {
  const manager = SessionManager.create(base.project, base.sessions);
  const timestamp = Date.now();
  const usage = {
    input: 2_000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2_100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (let index = 0; index < 2; index += 1) {
    manager.appendMessage({
      role: "user",
      content: `Saved ${label} context ${index + 1}. ${"Preserve this verified historical detail. ".repeat(500)}`,
      timestamp: timestamp + index * 2,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Saved ${label} response ${index + 1}. The earlier verification is complete.` }],
      api: "openai-completions",
      provider: fixtureProvider,
      model: "local",
      stopReason: "stop",
      timestamp: timestamp + index * 2 + 1,
      usage,
    });
  }
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile), `${label} history must be saved before Pi starts`);
  return sessionFile;
}

function isolatedEnvironment(base: Omit<FixtureBase, "provider">, sessionFile: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {
    GIT_CEILING_DIRECTORIES: base.directory,
    HOME: base.directory,
    USERPROFILE: base.directory,
    APPDATA: path.join(base.directory, "appdata"),
    LOCALAPPDATA: path.join(base.directory, "localappdata"),
    TEMP: path.join(base.directory, "tmp"),
    TMP: path.join(base.directory, "tmp"),
    PATH: path.dirname(process.execPath),
    PI_CODING_AGENT_DIR: base.agent,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    KILLEROS_MANUAL_PROBE: base.probeFile,
    KILLEROS_MANUAL_PLAN: base.planFile,
    KILLEROS_MANUAL_FAULT_MODE: base.faultModeFile,
    KILLEROS_MANUAL_FAULT_ATTEMPT: base.faultAttemptFile,
    KILLEROS_MANUAL_SESSION: sessionFile,
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  assert.deepEqual(Object.keys(env).filter((key) => /(?:api.?key|token|secret|credential|mcp)/iu.test(key)), [],
    "the RPC child must not inherit provider credentials or MCP configuration");
  mkdirSync(path.join(base.directory, "appdata"), { recursive: true });
  mkdirSync(path.join(base.directory, "localappdata"), { recursive: true });
  mkdirSync(path.join(base.directory, "tmp"), { recursive: true });
  return env;
}

async function createBase(
  label: string,
  options: { cancelIndexes?: number[]; holdIndexes?: number[] },
): Promise<FixtureBase> {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-compaction-manual-${label}-`));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  for (const child of [project, agent, sessions, path.join(directory, "tmp")]) mkdirSync(child);
  const base = {
    directory,
    project,
    agent,
    sessions,
    planFile: path.join(directory, "plan.json"),
    probeFile: path.join(directory, "probe.jsonl"),
    faultModeFile: path.join(directory, "fault-mode.txt"),
    faultAttemptFile: path.join(directory, "fault-attempt.json"),
    sessionFiles: new Map<string, string>(),
    heldIndexes: options.holdIndexes ?? [],
    provider: new LocalProvider(),
  };
  try {
    await base.provider.listen();
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      defaultThinkingLevel: "off",
      retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
      compaction: { enabled: true, reserveTokens: 15_000, keepRecentTokens: 100 },
    }, null, 2), "utf8");
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: {
      [fixtureProvider]: {
        api: "openai-completions",
        apiKey: fixtureKey,
        baseUrl: base.provider.url,
        models: [{ id: "local", name: "Manual compaction local", reasoning: false, input: ["text"], contextWindow: 100_000,
          maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    } }, null, 2), "utf8");
    writeFileSync(path.join(agent, "killeros.json"), JSON.stringify({
      autoCompaction: { enabled: false, percentRemaining: 15 },
    }, null, 2), "utf8");
    writeFileSync(base.planFile, JSON.stringify({
      cancelIndexes: options.cancelIndexes ?? [],
      holdIndexes: base.heldIndexes,
    }) + "\n", "utf8");
    writeFileSync(base.probeFile, "", "utf8");
    writeFileSync(base.faultModeFile, "off\n", "utf8");
    writeFileSync(path.join(directory, "manual-compaction-probe.mjs"), probeExtensionSource, "utf8");
    const first = sessionFileFor(base, "primary");
    base.sessionFiles.set("primary", first);
    return base;
  } catch (error) {
    const errors: unknown[] = [error];
    try { await base.provider.close(); } catch (closeError) { errors.push(closeError); }
    try { await removeDirectoryEventually(directory); } catch (removeError) { errors.push(removeError); }
    throw new AggregateError(errors, `Could not create manual compaction fixture ${label}`);
  }
}

function addSession(base: FixtureBase, label: string): string {
  const existing = base.sessionFiles.get(label);
  if (existing) return existing;
  const sessionFile = sessionFileFor(base, label);
  base.sessionFiles.set(label, sessionFile);
  return sessionFile;
}

function rpcArguments(base: FixtureBase, sessionFile: string): string[] {
  return [
    "--mode", "rpc",
    "--model", `${fixtureProvider}/local`,
    "--thinking", "off",
    "--tools", "read,write,killeros_goal_update",
    "--session", sessionFile,
    "--session-dir", base.sessions,
    "--offline",
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--no-extensions",
    "--extension", repositoryRoot,
    "--extension", path.join(base.directory, "manual-compaction-probe.mjs"),
  ];
}

function startRpcCommand(fixture: Fixture, type: string, fields: PiRpcRecord = {}): { after: number; result: Promise<RpcOutcome> } {
  const after = fixture.rpc.currentSequence;
  const id = `manual-${process.pid}-${after + 1}-${type}`;
  const pending = Symbol(type);
  fixture.pendingRpcCursors.set(pending, after);
  const result = (async (): Promise<RpcOutcome> => {
    try {
      await fixture.rpc.send({ ...fields, id, type });
      const stored = await fixture.rpc.waitForRecord(
        (value) => value.type === "response" && value.id === id,
        { after, timeoutMs: waitTimeoutMs, signal: fixture.signal },
      );
      return { kind: "response", record: stored.value };
    } catch (error) {
      return { kind: "failure", error };
    } finally {
      fixture.pendingRpcCursors.delete(pending);
    }
  })();
  return { after, result };
}

async function commandResponse(fixture: Fixture, type: string, fields: PiRpcRecord = {}): Promise<PiRpcRecord> {
  const outcome = await startRpcCommand(fixture, type, fields).result;
  if (outcome.kind === "failure") throw outcome.error;
  const response = outcome.record;
  assert.equal(response.success, true, `RPC ${type} must succeed: ${JSON.stringify(response.error)}`);
  return response;
}

function responseData(response: PiRpcRecord, label: string): JsonObject {
  return record(response.data, `${label} response data`);
}

async function currentState(fixture: Fixture): Promise<JsonObject> {
  return responseData(await commandResponse(fixture, "get_state"), "get_state");
}

function assertIdle(state: JsonObject, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: no active agent stream`);
  assert.equal(state.isCompacting, false, `${label}: no compaction remains active`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no pending RPC messages`);
}

function assertSettledEvent(event: ProbeEvent, label: string): void {
  assert.equal(event.idle, true, `${label}: the public context reports idle`);
  assert.equal(event.pending, false, `${label}: the public context reports an empty queue`);
}

async function waitForProvider(fixture: Fixture, count: number): Promise<ProviderRequest> {
  return await fixture.provider.waitForRequest(count, fixture.signal);
}

async function startGoal(fixture: Fixture, objective: string, requestNumber: number): Promise<number> {
  const probeCursor = lastProbeSequence(fixture);
  const response = await commandResponse(fixture, "prompt", { message: `/goal ${objective}` });
  assert.equal(responseData(response, "goal command").disposition, "handled");
  const request = await waitForProvider(fixture, requestNumber);
  assertGoalToolDeclared(request, true);
  return probeCursor;
}

async function startOrdinaryPrompt(fixture: Fixture, message: string, requestNumber: number): Promise<number> {
  const probeCursor = lastProbeSequence(fixture);
  const response = await commandResponse(fixture, "prompt", { message });
  assert.equal(responseData(response, "ordinary prompt").disposition, "started");
  await waitForProvider(fixture, requestNumber);
  return probeCursor;
}

async function waitForSettlement(fixture: Fixture, after: number, label: string): Promise<ProbeEvent> {
  const event = await waitForProbe(fixture.probeFile, (candidate) => candidate.type === "agent_settled", label,
    fixture.signal, after);
  assertSettledEvent(event, label);
  return event;
}

async function waitForCompactEvent(fixture: Fixture, index: number, reason: string, after: number): Promise<ProbeEvent> {
  return await waitForProbe(fixture.probeFile,
    (event) => event.type === "session_compact" && event.index === index && event.reason === reason,
    `successful ${reason} compaction ${index}`, fixture.signal, after);
}

async function waitForCompactFailure(fixture: Fixture, after: number): Promise<ProbeEvent> {
  return await waitForProbe(fixture.probeFile,
    (event) => event.type === "session_compact_failed" && event.reason === "manual",
    "failed manual compaction", fixture.signal, after);
}

async function waitForBeforeCompact(
  fixture: Fixture,
  index: number,
  reason: string,
  after: number,
): Promise<ProbeEvent> {
  return await waitForProbe(fixture.probeFile,
    (event) => event.type === "session_before_compact" && event.index === index && event.reason === reason,
    `${reason} summary hook ${index}`, fixture.signal, after);
}

async function waitForManualBarrier(fixture: Fixture, index: number): Promise<void> {
  const token = `summary-${index}\n`;
  await waitForProbe(fixture.probeFile,
    (event) => event.type === "summary_barrier_ack" && event.index === index,
    `summary gate acknowledgment ${index}`, fixture.signal);
  assert.equal(readFileSync(path.join(fixture.directory, `${token.trim()}.ack`), "utf8"), token);
}

async function collectRpcBatch(fixture: Fixture, after: number): Promise<PiRpcRecord[]> {
  // Probe files can lead stdout delivery. A native response bounds earlier RPC notifications.
  await currentState(fixture);
  const through = fixture.rpc.currentSequence;
  const records: PiRpcRecord[] = [];
  let cursor = after;
  while (cursor < through) {
    const stored = await fixture.rpc.waitForRecord(() => true, { after: cursor, signal: fixture.signal });
    records.push(stored.value);
    cursor = stored.sequence;
  }
  // A held compact command still owns its response cursor while notifications are inspected.
  fixture.rpc.acknowledge(Math.min(through, ...fixture.pendingRpcCursors.values()));
  return records;
}

function notifications(records: readonly PiRpcRecord[]): Notification[] {
  return records.flatMap((entry) => {
    if (entry.type !== "extension_ui_request" || entry.method !== "notify") return [];
    return [{ message: stringField(entry, "message"), type: typeof entry.notifyType === "string" ? entry.notifyType : "info" }];
  });
}

function assertNotifications(records: readonly PiRpcRecord[], expected: readonly Notification[], label: string): void {
  assert.deepEqual(notifications(records), expected, `${label}: exact RPC notification sequence`);
}

function entries(sessionFile: string) {
  return SessionManager.open(sessionFile).getEntries();
}

function goalStates(sessionFile: string): JsonObject[] {
  return entries(sessionFile).flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal data");
    return [record(data.state, "saved goal state")];
  });
}

function lastGoalState(sessionFile: string, label: string): JsonObject {
  const state = goalStates(sessionFile).at(-1);
  assert.ok(state, `${label}: a saved goal state must exist`);
  return state;
}

function compactionCount(sessionFile: string): number {
  return entries(sessionFile).filter((entry) => entry.type === "compaction").length;
}

function continuationCount(fixture: Fixture): number {
  return readProbeEvents(fixture.probeFile).filter((event) => event.type === "message_start"
    && event.role === "custom" && event.customType === "killeros-goal-continuation").length;
}

function autoCompactionMessageCount(fixture: Fixture): number {
  return readProbeEvents(fixture.probeFile).filter((event) => event.type === "message_start"
    && event.role === "custom" && event.customType === "killeros-auto-compaction").length;
}

function assertGoalToolDeclared(request: ProviderRequest, expected: boolean): void {
  const tools = request.body.tools;
  if (!Array.isArray(tools)) {
    assert.equal(expected, false, "the provider request has no tool declarations");
    return;
  }
  const names = tools.flatMap((tool) => {
    if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") return [];
    return [tool.function.name];
  });
  assert.equal(names.includes("killeros_goal_update"), expected);
}

function assertSummaryRequest(request: ProviderRequest, label: string): void {
  assert.equal(request.body.model, "local", `${label}: summary keeps the loopback model`);
  assert.ok(Array.isArray(request.body.messages), `${label}: native Pi sent summary messages`);
  assert.match(JSON.stringify(request.body.messages), /summar|checkpoint|compact/iu,
    `${label}: provider input belongs to Pi's summary request`);
}

function assertPausedMarker(sessionFile: string, label: string): JsonObject {
  const state = lastGoalState(sessionFile, label);
  assert.equal(state.status, "paused", `${label}: goal remains paused`);
  assert.equal(state.resumeAfterManualCompaction, true, `${label}: live manual recovery marker remains saved`);
  return state;
}

function assertNoManualMarker(sessionFile: string, status: string, label: string): JsonObject {
  const state = lastGoalState(sessionFile, label);
  assert.equal(state.status, status, `${label}: saved goal status`);
  assert.equal(state.resumeAfterManualCompaction, undefined, `${label}: no manual recovery marker is saved`);
  return state;
}

function assertResponseSuccess(outcome: RpcOutcome, label: string): PiRpcRecord {
  if (outcome.kind === "failure") throw outcome.error;
  assert.equal(outcome.record.success, true, `${label}: RPC command succeeded`);
  return outcome.record;
}

function assertResponseFailure(outcome: RpcOutcome, pattern: RegExp, label: string): PiRpcRecord {
  if (outcome.kind === "failure") throw outcome.error;
  assert.equal(outcome.record.success, false, `${label}: RPC command reports failure`);
  assert.match(String(outcome.record.error), pattern, `${label}: RPC error`);
  return outcome.record;
}

function beginManualCompact(fixture: Fixture): { after: number; result: Promise<RpcOutcome> } {
  return startRpcCommand(fixture, "compact");
}

async function switchSession(fixture: Fixture, label: string): Promise<void> {
  const sessionFile = addSession(fixture, label);
  const response = await commandResponse(fixture, "switch_session", { sessionPath: sessionFile });
  assert.equal(responseData(response, "switch_session").cancelled, false);
  fixture.sessionFile = sessionFile;
  const state = await currentState(fixture);
  assert.equal(path.resolve(stringField(state, "sessionFile")), path.resolve(sessionFile));
  assertIdle(state, `switch to ${label}`);
}

function assertChildFaultBelongsToRpc(fixture: Fixture, attempt: JsonObject): void {
  const diagnostic = record(JSON.parse(fixture.rpc.diagnostics()), "Pi RPC diagnostics");
  assert.equal(finiteNumberField(attempt, "pid"), finiteNumberField(diagnostic, "pid"),
    "append fault acknowledgment identifies the owned Pi child");
  assert.equal(attempt.operation, "appendFileSync");
  assert.equal(path.resolve(stringField(attempt, "path")).toLowerCase(), path.resolve(fixture.sessionFile).toLowerCase(),
    "append fault acknowledgment names only the owned session path");
}

function sessionSnapshots(base: FixtureBase): SessionSnapshot[] {
  return [...base.sessionFiles].map(([label, sessionFile]) => {
    const fileExists = existsSync(sessionFile);
    if (!fileExists) return { label, fileExists, entryCount: 0, goalStatuses: [], manualMarkers: [], compactionEntries: 0 };
    const savedEntries = entries(sessionFile);
    const states = goalStates(sessionFile);
    return {
      label,
      fileExists,
      entryCount: savedEntries.length,
      goalStatuses: states.map((state) => stringField(state, "status")),
      manualMarkers: states.map((state) => state.resumeAfterManualCompaction === true),
      compactionEntries: savedEntries.filter((entry) => entry.type === "compaction").length,
    };
  });
}

async function runHistory(
  scenarioId: string,
  label: string,
  options: { cancelIndexes?: number[]; holdIndexes?: number[] },
  t: TestContext,
  action: (fixture: Fixture) => Promise<void>,
): Promise<HistoryResult> {
  let base: FixtureBase | undefined;
  let fixture: Fixture | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let naturalExit = false;
  let scratchRemoved = false;
  let finalSessions: SessionSnapshot[] = [];
  let finalGoalContinuations = 0;
  try {
    base = await createBase(label, options);
    const sessionFile = base.sessionFiles.get("primary");
    assert.ok(sessionFile);
    const rpc = new PiRpcProcess({
      cliPath,
      cwd: base.project,
      env: isolatedEnvironment(base, sessionFile),
      args: rpcArguments(base, sessionFile),
    });
    fixture = { ...base, signal: t.signal, rpc, sessionFile, pendingRpcCursors: new Map() };
    const started = await waitForProbe(base.probeFile, (event) => event.type === "session_start", "RPC session_start", t.signal);
    assert.equal(started.mode, "rpc");
    assert.equal(base.provider.requests.length, 0, "Pi startup must not call the provider");
    assertIdle(await currentState(fixture), `${label} startup`);
    await collectRpcBatch(fixture, 0);
    await action(fixture);
  } catch (error) {
    primaryError = error;
  } finally {
    if (fixture) {
      try { await releaseAllSummaryGates(fixture); } catch (error) { cleanupErrors.push(error); }
      fixture.provider.releaseAll();
      try {
        const result = await fixture.rpc.close();
        assert.deepEqual(result, { exit: { code: 0, signal: null }, forced: false }, fixture.rpc.diagnostics());
        const lifecycle = readProbeEvents(fixture.probeFile);
        const shutdown = lifecycle.filter((event) => event.type === "session_shutdown");
        assert.equal(shutdown.filter((event) => event.reason === "quit").length, 1,
          "the owned child completes exactly one final native quit");
        assert.equal(lifecycle.at(-1)?.type, "session_shutdown", "the owned child completes final native shutdown");
        assert.equal(lifecycle.at(-1)?.reason, "quit", "the final shutdown belongs to process exit rather than session replacement");
        assert.ok(shutdown.every((event) => event.faultAdapterRestored === true),
          "the filesystem adapter is restored before each shutdown completes");
        naturalExit = true;
      } catch (error) { cleanupErrors.push(error); }
      try { await fixture.provider.close(); } catch (error) { cleanupErrors.push(error); }
      try {
        finalSessions = sessionSnapshots(fixture);
        finalGoalContinuations = continuationCount(fixture);
      } catch (error) { cleanupErrors.push(error); }
    } else if (base) {
      try { await base.provider.close(); } catch (error) { cleanupErrors.push(error); }
      try { finalSessions = sessionSnapshots(base); } catch (error) { cleanupErrors.push(error); }
    }

    if (base) {
      if (primaryError !== undefined || cleanupErrors.length > 0) {
        const report = {
          scenarioId,
          label,
          node: process.version,
          platform: process.platform,
          providerRequests: base.provider.requests.slice(0, 32).map(({ index, body }) => ({
            index,
            model: body.model,
            messageCount: Array.isArray(body.messages) ? body.messages.length : null,
          })),
          providerFaults: base.provider.faults.slice(0, 8),
          probeEvents: readProbeEvents(base.probeFile).slice(-100),
          process: fixture?.rpc.diagnostics(),
          cleanupErrors: cleanupErrors.map(errorText),
          primaryError: primaryError === undefined ? undefined : errorText(primaryError),
          sessionFiles: finalSessions,
        };
        try {
          mkdirSync(reportsRoot, { recursive: true });
          const reportFile = path.join(reportsRoot, `failure-${scenarioId}-${process.pid}-${Date.now()}.json`);
          writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await removeDirectoryEventually(base.directory);
        scratchRemoved = !existsSync(base.directory);
        if (!scratchRemoved) throw new Error(`Owned scratch directory remains: ${base.directory}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (primaryError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      `${scenarioId}/${label} failed or did not clean up naturally`,
    );
  }
  assert.ok(base && fixture);
  assert.equal(naturalExit, true);
  assert.equal(scratchRemoved, true);
  assert.deepEqual(base.provider.faults, []);
  return {
    scenarioId,
    label,
    piLaunches: 1,
    otherChildLaunches: 0,
    providerRequests: base.provider.requests.length,
    providerPlansRemaining: base.provider.remainingPlans,
    goalContinuations: finalGoalContinuations,
    naturalExit,
    scratchRemoved,
    sessionFiles: finalSessions,
  };
}

function heldPlan(): ProviderPlan {
  return {
    kind: "held",
    barrier: makeBarrier(),
    fallback: { kind: "text", content: "Released only during owned cleanup.", usageTokens: 500 },
  };
}

function textPlan(content: string, usageTokens = 500): ProviderReply {
  return { kind: "text", content, usageTokens };
}

function expectedNotification(message: string, type: string): Notification {
  return { message, type };
}

function assertSessionSnapshot(
  result: HistoryResult,
  expected: readonly { label: string; compactionEntries: number; finalStatus?: string; manualMarker?: boolean }[],
): void {
  assert.equal(result.sessionFiles.length, expected.length, "all and only seeded public session files survive until orderly exit");
  assert.deepEqual(result.sessionFiles.map((snapshot) => snapshot.label).sort(), expected.map(({ label }) => label).sort());
  for (const wanted of expected) {
    const snapshot = result.sessionFiles.find((candidate) => candidate.label === wanted.label);
    assert.ok(snapshot, `${wanted.label}: final session snapshot exists`);
    assert.equal(snapshot.fileExists, true, `${wanted.label}: saved session survives Pi exit`);
    assert.equal(snapshot.compactionEntries, wanted.compactionEntries, `${wanted.label}: exact durable compaction count after exit`);
    if (wanted.finalStatus !== undefined) assert.equal(snapshot.goalStatuses.at(-1), wanted.finalStatus, `${wanted.label}: final saved status after exit`);
    if (wanted.manualMarker !== undefined) assert.equal(snapshot.manualMarkers.at(-1), wanted.manualMarker, `${wanted.label}: final marker after exit`);
  }
}

// Catalog ID: compaction-manual-recovery.
test("Manual compaction resumes only the exact marked goal after the interrupted turn settles", { timeout: 1_200_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  const expectedGoalStart = expectedNotification(
    "Goal started. Each turn must record continue, complete, or a blocker decision before another turn starts.",
    "info",
  );
  const expectedManualPause = expectedNotification(
    "Goal paused because the turn was aborted. If /compact is running, KillerOS will resume the same goal turn after Pi saves the summary. Run /goal pause to keep it paused.",
    "warning",
  );

  histories.push(await runHistory("compaction-manual-recovery", "live-same-turn-and-repeat", { holdIndexes: [1, 2] }, t, async (fixture) => {
    fixture.provider.enqueue(heldPlan());
    fixture.provider.enqueue(textPlan("Manual summary preserves the current goal."));
    const recoveryResponseBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: recoveryResponseBarrier,
      fallback: textPlan("The interrupted goal turn resumed once.") });
    fixture.provider.enqueue(textPlan("A later real manual summary cannot restart the old turn."));
    const notificationCursor = fixture.rpc.currentSequence;
    const turnCursor = await startGoal(fixture, "Resume the exact interrupted goal turn after manual compaction.", 1);
    const firstRequest = fixture.provider.requests[0];
    assert.ok(firstRequest);
    assertGoalToolDeclared(firstRequest, true);
    const continuationBaseline = continuationCount(fixture);
    assert.equal(continuationBaseline, 1, "the public /goal command starts exactly one goal continuation");

    const compactBefore = lastProbeSequence(fixture);
    const compact = beginManualCompact(fixture);
    const hook = await waitForBeforeCompact(fixture, 1, "manual", compactBefore);
    const interruptedSettlement = await waitForSettlement(fixture, turnCursor, "interrupted goal settlement");
    assert.equal(interruptedSettlement.aborted, true, "Pi reports the real compaction-induced abort");
    assert.ok(interruptedSettlement.sequence < hook.sequence, "the interrupted request settles before summary preparation");
    const paused = assertPausedMarker(fixture.sessionFile, "goal paused before summary release");
    assert.match(stringField(paused, "result"), /abort|compact/iu, "the saved pause retains the interruption reason");
    assert.equal(paused.turns, 1, "the interrupted logical turn was counted once");
    const beforeReleaseRecords = await collectRpcBatch(fixture, notificationCursor);
    assertNotifications(beforeReleaseRecords, [expectedGoalStart, expectedManualPause], "manual interruption before summary release");
    const recoveryNotificationCursor = fixture.rpc.currentSequence;

    await waitForManualBarrier(fixture, 1);
    await releaseSummary(fixture, 1);
    const compactResponse = assertResponseSuccess(await compact.result, "successful manual compact");
    assert.equal(compactResponse.command, "compact");
    const summaryRequest = await waitForProvider(fixture, 2);
    assertSummaryRequest(summaryRequest, "manual recovery");
    const compacted = await waitForCompactEvent(fixture, 1, "manual", hook.sequence);
    const recoveryBarrier = Math.max(interruptedSettlement.sequence, compacted.sequence);
    const resumedMessage = await waitForProbe(fixture.probeFile,
      (event) => event.type === "message_start" && event.role === "custom"
        && event.customType === "killeros-goal-continuation",
      "same-turn recovery continuation", fixture.signal, recoveryBarrier);
    assert.ok(resumedMessage.sequence > recoveryBarrier, "recovery starts only after settlement and the saved summary");
    const resumedRequest = await waitForProvider(fixture, 3);
    assert.ok(JSON.stringify(resumedRequest.body.messages).includes("Resume the exact interrupted goal turn"));
    const activeRecovery = assertNoManualMarker(fixture.sessionFile, "active", "marked revision consumed by same-turn recovery");
    const resumedEntry = entries(fixture.sessionFile).filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(resumedEntry?.type === "custom");
    assert.equal(record(resumedEntry.data, "saved recovery entry").event, "resume", "same-turn recovery persists the native resume transition");
    assert.equal(activeRecovery.objective, paused.objective, "manual recovery keeps the exact saved objective");
    assert.equal(activeRecovery.turns, paused.turns, "manual recovery does not grant a new logical turn");
    assert.equal(finiteNumberField(activeRecovery, "revision"), finiteNumberField(paused, "revision") + 1,
      "recovery advances only the marked revision into its active state");
    recoveryResponseBarrier.release();
    const resumedSettlement = await waitForSettlement(fixture, hook.sequence, "resumed goal settlement");
    const resumedState = await currentState(fixture);
    assertIdle(resumedState, "after same-turn manual recovery");
    const finalPaused = assertNoManualMarker(fixture.sessionFile, "paused", "same-turn recovery settled without a new decision");
    assert.equal(finalPaused.turns, 1, "same-turn manual recovery grants no new turn");
    assert.equal(finalPaused.result, "no turn decision");
    assert.ok(resumedSettlement.sequence > hook.sequence);
    assert.equal(continuationCount(fixture), continuationBaseline + 1, "recovery sends one additional continuation");
    assert.equal(autoCompactionMessageCount(fixture), 0, "manual goal recovery never queues ordinary auto-compaction work");
    const recoveryRecords = await collectRpcBatch(fixture, recoveryNotificationCursor);
    assertNotifications(recoveryRecords, [
      expectedNotification("Manual compaction complete. The interrupted goal turn resumed.", "info"),
      expectedNotification("Goal paused: no turn decision\nThe agent ended without choosing continue, complete, or blocked. Run /goal resume only after choosing to continue.", "error"),
    ], "same-turn recovery and its settled turn decision");

    const beforeRepeat = lastProbeSequence(fixture);
    const repeatCursor = fixture.rpc.currentSequence;
    const repeat = beginManualCompact(fixture);
    const repeatedHook = await waitForBeforeCompact(fixture, 2, "manual", beforeRepeat);
    await waitForManualBarrier(fixture, 2);
    await releaseSummary(fixture, 2);
    assertResponseSuccess(await repeat.result, "repeated real manual compact");
    await waitForCompactEvent(fixture, 2, "manual", repeatedHook.sequence);
    assertIdle(await currentState(fixture), "after repeated manual compact");
    assert.equal(continuationCount(fixture), continuationBaseline + 1, "a repeated real compact creates no duplicate continuation");
    assert.deepEqual(lastGoalState(fixture.sessionFile, "after repeated real compact"), finalPaused,
      "repeated manual compaction preserves the exact unmarked paused goal revision");
    assert.equal(entries(fixture.sessionFile).filter((entry) => entry.type === "custom"
      && entry.customType === "killeros-goal" && record(entry.data, "goal transition").event === "resume").length,
    1, "two real manual compactions persist exactly one recovery transition");
    assert.deepEqual(readProbeEvents(fixture.probeFile).filter((event) => event.type === "session_compact")
      .map((event) => [event.index, event.reason]), [[1, "manual"], [2, "manual"]],
    "Pi delivers one manual event for each of the two saved summaries");
    const repeatedRecords = await collectRpcBatch(fixture, repeatCursor);
    assertNotifications(repeatedRecords, [], "repeated real manual compact");
    assert.equal(fixture.provider.requests.length, 4, "two summaries and two goal requests are observed");
    assert.equal(fixture.provider.remainingPlans, 0);
    assert.equal(compactionCount(fixture.sessionFile), 2, "both real manual summaries are durable");
  }));

  histories.push(await runHistory("compaction-manual-recovery", "manual-marker-trigger-and-terminal-guards", {
    cancelIndexes: [1, 5],
    holdIndexes: [1, 5],
  }, t, async (fixture) => {
    const allNotifications: Notification[] = [];
    let rpcCursor = fixture.rpc.currentSequence;
    const primaryContinuation = continuationCount(fixture);

    fixture.provider.enqueue(heldPlan());
    const initialTurn = await startGoal(fixture, "Preserve this marked goal through automatic compaction.", 1);
    const firstCompact = beginManualCompact(fixture);
    const cancelHook = await waitForBeforeCompact(fixture, 1, "manual", initialTurn);
    await waitForSettlement(fixture, initialTurn, "goal settlement before cancelled manual summary");
    assertPausedMarker(fixture.sessionFile, "cancelled manual summary leaves eligibility");
    await waitForManualBarrier(fixture, 1);
    await releaseSummary(fixture, 1);
    assertResponseFailure(await firstCompact.result, /cancel/iu, "cancelled manual summary");
    await waitForCompactFailure(fixture, cancelHook.sequence);
    assert.equal(compactionCount(fixture.sessionFile), 0, "cancelled manual summary appends no compaction entry");
    let batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [expectedGoalStart, expectedManualPause], "initial marked pause");
    rpcCursor = fixture.rpc.currentSequence;

    fixture.provider.enqueue(textPlan("Ordinary work reaches Pi's native threshold." , 90_000));
    fixture.provider.enqueue(textPlan("Pi completed a native threshold summary."));
    const thresholdTurn = await startOrdinaryPrompt(fixture, "Do unrelated work after the marked goal was paused.", 2);
    const thresholdHook = await waitForBeforeCompact(fixture, 2, "threshold", thresholdTurn);
    assert.equal(thresholdHook.willRetry, false);
    const thresholdSummary = await waitForProvider(fixture, 3);
    assertSummaryRequest(thresholdSummary, "native threshold compaction");
    await waitForCompactEvent(fixture, 2, "threshold", thresholdHook.sequence);
    await waitForSettlement(fixture, thresholdTurn, "native threshold prompt settlement");
    assertIdle(await currentState(fixture), "native threshold completion");
    assertPausedMarker(fixture.sessionFile, "threshold compaction preserves manual eligibility");
    assert.equal(continuationCount(fixture), primaryContinuation + 1, "threshold compaction sends no goal continuation");
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [], "native threshold compaction");
    rpcCursor = fixture.rpc.currentSequence;

    fixture.provider.enqueue({ kind: "error", status: 400, message: "Your input exceeds the context window of this model", errorType: "context_length_exceeded" });
    fixture.provider.enqueue(textPlan("Pi completed the native overflow history summary."));
    fixture.provider.enqueue(textPlan("Pi completed the native overflow turn-prefix summary."));
    fixture.provider.enqueue(textPlan("The overflow retry completes ordinary work.", 500));
    // The current turn exceeds the native 100-token keep window, leaving the earlier ordinary prefix summarizable.
    const overflowPrompt = `Continue unrelated work through native overflow recovery. ${"Preserve this ordinary history for the recovery summary. ".repeat(8)}`;
    const overflowTurn = await startOrdinaryPrompt(fixture, overflowPrompt, 4);
    const overflowHook = await waitForBeforeCompact(fixture, 3, "overflow", overflowTurn);
    assert.equal(overflowHook.willRetry, true);
    assertSummaryRequest(await waitForProvider(fixture, 5), "native overflow compaction");
    await waitForCompactEvent(fixture, 3, "overflow", overflowHook.sequence);
    assertSummaryRequest(await waitForProvider(fixture, 6), "native overflow turn-prefix compaction");
    await waitForProvider(fixture, 7);
    await waitForSettlement(fixture, overflowTurn, "native overflow retry settlement");
    assertIdle(await currentState(fixture), "native overflow retry completion");
    assertPausedMarker(fixture.sessionFile, "overflow compaction preserves manual eligibility");
    assert.equal(continuationCount(fixture), primaryContinuation + 1, "overflow compaction sends no goal continuation");
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [], "native overflow compaction and retry");
    rpcCursor = fixture.rpc.currentSequence;

    // Overflow has just compacted the retained branch. Add a new ordinary turn before another real summary.
    fixture.provider.enqueue(textPlan("Ordinary work adds fresh history without resuming the marked goal.", 500));
    const freshTurn = await startOrdinaryPrompt(fixture,
      `Record ordinary work before the later manual summary. ${"Keep this independent work in the history. ".repeat(40)}`, 8);
    await waitForSettlement(fixture, freshTurn, "fresh ordinary history after overflow");
    assertIdle(await currentState(fixture), "fresh ordinary history after overflow");
    assertPausedMarker(fixture.sessionFile, "ordinary work preserves manual eligibility");
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [], "ordinary work before manual recovery");
    rpcCursor = fixture.rpc.currentSequence;

    fixture.provider.enqueue(textPlan("Pi completed the later manual summary."));
    fixture.provider.enqueue(textPlan("The original marked logical turn resumed once."));
    const recoveryCursor = lastProbeSequence(fixture);
    const manualRecovery = beginManualCompact(fixture);
    const manualHook = await waitForBeforeCompact(fixture, 4, "manual", recoveryCursor);
    assertSummaryRequest(await waitForProvider(fixture, 9), "manual recovery after threshold and overflow");
    await waitForCompactEvent(fixture, 4, "manual", manualHook.sequence);
    const recovered = await waitForProvider(fixture, 10);
    assert.ok(JSON.stringify(recovered.body.messages).includes("Preserve this marked goal"));
    assertResponseSuccess(await manualRecovery.result, "manual recovery after automatic compactions");
    await waitForSettlement(fixture, manualHook.sequence, "goal settlement after automatic compactions");
    assertIdle(await currentState(fixture), "manual recovery after threshold and overflow");
    const recoveredState = assertNoManualMarker(fixture.sessionFile, "paused", "manual marker consumed only by successful manual compaction");
    assert.equal(recoveredState.turns, 1);
    assert.equal(continuationCount(fixture), primaryContinuation + 2,
      "initial authorization and one same-turn recovery are the only goal continuations");
    assert.equal(autoCompactionMessageCount(fixture), 0);
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [expectedNotification("Manual compaction complete. The interrupted goal turn resumed.", "info"),
      expectedNotification("Goal paused: no turn decision\nThe agent ended without choosing continue, complete, or blocked. Run /goal resume only after choosing to continue.", "error")],
    "same-turn recovery after threshold and overflow");
    rpcCursor = fixture.rpc.currentSequence;

    await switchSession(fixture, "marked-pause");
    fixture.provider.enqueue(heldPlan());
    const markedTurn = await startGoal(fixture, "Pause this marked objective explicitly.", 11);
    const cancelledMarkedCompact = beginManualCompact(fixture);
    const markedHook = await waitForBeforeCompact(fixture, 5, "manual", markedTurn);
    await waitForSettlement(fixture, markedTurn, "marked goal settlement before explicit pause");
    const marked = assertPausedMarker(fixture.sessionFile, "marked goal before explicit user pause");
    await waitForManualBarrier(fixture, 5);
    await releaseSummary(fixture, 5);
    assertResponseFailure(await cancelledMarkedCompact.result, /cancel/iu, "cancelled summary before explicit goal pause");
    await waitForCompactFailure(fixture, markedHook.sequence);
    const beforePause = finiteNumberField(marked, "revision");
    const pauseResponse = await commandResponse(fixture, "prompt", { message: "/goal pause" });
    assert.equal(responseData(pauseResponse, "explicit goal pause").disposition, "handled");
    const userPaused = assertNoManualMarker(fixture.sessionFile, "paused", "explicit pause moves the saved revision and clears eligibility");
    assert.ok(finiteNumberField(userPaused, "revision") > beforePause);
    fixture.provider.enqueue(textPlan("The explicitly paused goal is not resumed by later compaction."));
    const explicitPauseCompactCursor = lastProbeSequence(fixture);
    const explicitPauseCompact = beginManualCompact(fixture);
    const explicitPauseHook = await waitForBeforeCompact(fixture, 6, "manual", explicitPauseCompactCursor);
    assertSummaryRequest(await waitForProvider(fixture, 12), "manual compact after explicit pause");
    await waitForCompactEvent(fixture, 6, "manual", explicitPauseHook.sequence);
    assertResponseSuccess(await explicitPauseCompact.result, "manual compact after explicit pause");
    assertIdle(await currentState(fixture), "manual compact after explicit pause");
    assertNoManualMarker(fixture.sessionFile, "paused", "later manual compact cannot revive an explicitly paused goal");
    assert.equal(continuationCount(fixture), primaryContinuation + 3, "explicit pause and later compact add no continuation");
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [expectedGoalStart, expectedManualPause,
      expectedNotification("Goal pause saved. Goal remains paused. Automatic compaction recovery is off.", "info")],
    "explicit pause clears the moved manual marker");
    rpcCursor = fixture.rpc.currentSequence;

    await switchSession(fixture, "active-pause");
    fixture.provider.enqueue(heldPlan());
    const activePauseTurn = await startGoal(fixture, "Pause this active goal before its request settles.", 13);
    const activePauseContinuations = continuationCount(fixture);
    const activePauseResponse = await commandResponse(fixture, "prompt", { message: "/goal pause" });
    assert.equal(responseData(activePauseResponse, "active goal pause").disposition, "handled");
    const activePauseSettlement = await waitForSettlement(fixture, activePauseTurn, "active user-pause cancellation settlement");
    assert.equal(activePauseSettlement.aborted, true);
    assertNoManualMarker(fixture.sessionFile, "paused", "explicit cancellation does not create manual recovery eligibility");
    fixture.provider.enqueue(textPlan("Manual compact after active user cancellation."));
    const activePauseCompactCursor = lastProbeSequence(fixture);
    const activePauseCompact = beginManualCompact(fixture);
    const activePauseHook = await waitForBeforeCompact(fixture, 7, "manual", activePauseCompactCursor);
    assertSummaryRequest(await waitForProvider(fixture, 14), "manual compact after active user pause");
    await waitForCompactEvent(fixture, 7, "manual", activePauseHook.sequence);
    assertResponseSuccess(await activePauseCompact.result, "manual compact after active user pause");
    assertIdle(await currentState(fixture), "manual compact after active user pause");
    assertNoManualMarker(fixture.sessionFile, "paused", "manual compaction cannot revive an active request cancelled by /goal pause");
    assert.equal(continuationCount(fixture), activePauseContinuations,
      "explicit pause cancellation and subsequent manual compaction send no additional continuation");
    assert.equal(continuationCount(fixture), primaryContinuation + 4);
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [expectedGoalStart, expectedNotification("Goal paused. Run /goal resume to continue.", "info")],
      "active /goal pause cancellation");
    rpcCursor = fixture.rpc.currentSequence;

    await switchSession(fixture, "terminal-complete");
    fixture.provider.enqueue({ kind: "complete", evidence: "The public goal tool accepted completion.", usageTokens: 500 });
    fixture.provider.enqueue(heldPlan());
    fixture.provider.enqueue(textPlan("Manual compaction after a terminal goal."));
    const completeTurn = await startGoal(fixture, "Complete this goal through the real goal tool.", 15);
    await waitForProvider(fixture, 16);
    const completed = lastGoalState(fixture.sessionFile, "terminal goal before manual compaction");
    assert.equal(completed.status, "complete");
    assert.equal(completed.resumeAfterManualCompaction, undefined);
    const terminalContinuationCount = continuationCount(fixture);
    assert.equal(terminalContinuationCount, primaryContinuation + 5);
    const terminalCompactCursor = lastProbeSequence(fixture);
    const terminalCompact = beginManualCompact(fixture);
    const terminalHook = await waitForBeforeCompact(fixture, 8, "manual", terminalCompactCursor);
    const terminalSettlement = await waitForSettlement(fixture, completeTurn, "completed goal request aborted for manual compaction");
    assert.equal(terminalSettlement.aborted, true);
    assertSummaryRequest(await waitForProvider(fixture, 17), "manual compact after terminal completion");
    await waitForCompactEvent(fixture, 8, "manual", terminalHook.sequence);
    assertResponseSuccess(await terminalCompact.result, "manual compact after terminal goal");
    assertIdle(await currentState(fixture), "manual compact after terminal goal");
    assert.equal(lastGoalState(fixture.sessionFile, "terminal goal after compaction").status, "complete");
    assert.equal(continuationCount(fixture), terminalContinuationCount, "terminal goal never receives a manual continuation");
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [expectedGoalStart], "terminal completion remains terminal after manual compact");
    rpcCursor = fixture.rpc.currentSequence;

    await switchSession(fixture, "provider-error");
    fixture.provider.enqueue({ kind: "error", status: 503, message: "provider unavailable" });
    const failedTurn = await startGoal(fixture, "Pause after a real provider error without a manual marker.", 18);
    await waitForSettlement(fixture, failedTurn, "provider-error goal settlement");
    const providerFailed = assertNoManualMarker(fixture.sessionFile, "paused", "provider error leaves an unmarked paused goal");
    assert.equal(providerFailed.result, '503: {"message":"provider unavailable","type":"server_error"}');
    fixture.provider.enqueue(textPlan("A successful summary cannot revive an unmarked provider-error goal."));
    const errorCompactCursor = lastProbeSequence(fixture);
    const errorCompact = beginManualCompact(fixture);
    const errorHook = await waitForBeforeCompact(fixture, 9, "manual", errorCompactCursor);
    assertSummaryRequest(await waitForProvider(fixture, 19), "manual compact after provider error");
    await waitForCompactEvent(fixture, 9, "manual", errorHook.sequence);
    assertResponseSuccess(await errorCompact.result, "manual compact after provider error");
    assertIdle(await currentState(fixture), "manual compact after provider error");
    assertNoManualMarker(fixture.sessionFile, "paused", "unmarked provider error cannot resume after manual compact");
    assert.equal(continuationCount(fixture), primaryContinuation + 6);
    batch = await collectRpcBatch(fixture, rpcCursor);
    allNotifications.push(...notifications(batch));
    assertNotifications(batch, [expectedGoalStart,
      expectedNotification('Goal paused: 503: {"message":"provider unavailable","type":"server_error"}\nRun /goal resume after resolving the problem.', "error")],
    "provider error remains unmarked after manual compact");

    assert.equal(fixture.provider.requests.length, 19, "native compactions, fresh ordinary history, and five goal workflows use the exact planned requests");
    assert.equal(fixture.provider.remainingPlans, 0);
    assert.deepEqual(fixture.provider.abortedRequests, [1, 11, 13, 16],
      "only the explicitly interrupted loopback requests are abandoned by manual compaction or /goal pause");
    assert.equal(compactionCount(addSessionPath(fixture, "primary")), 3,
      "the primary history records threshold, overflow, and later manual compactions");
    assert.equal(allNotifications.filter((notice) => notice.type === "warning" && notice.message === expectedManualPause.message).length, 2);
  }));

  assert.deepEqual(histories.map((history) => history.providerRequests), [4, 19]);
  assert.deepEqual(histories.map((history) => history.goalContinuations), [2, 6], "exact goal continuation counts survive orderly exit");
  assert.deepEqual(histories.map((history) => history.piLaunches), [1, 1]);
  assert.deepEqual(histories.map((history) => history.otherChildLaunches), [0, 0]);
  assert.ok(histories.every((history) => history.providerPlansRemaining === 0 && history.naturalExit && history.scratchRemoved));
  assertSessionSnapshot(histories[0], [
    { label: "primary", compactionEntries: 2, finalStatus: "paused", manualMarker: false },
  ]);
  assertSessionSnapshot(histories[1], [
    { label: "primary", compactionEntries: 3, finalStatus: "paused", manualMarker: false },
    { label: "marked-pause", compactionEntries: 1, finalStatus: "paused", manualMarker: false },
    { label: "active-pause", compactionEntries: 1, finalStatus: "paused", manualMarker: false },
    { label: "terminal-complete", compactionEntries: 1, finalStatus: "complete", manualMarker: false },
    { label: "provider-error", compactionEntries: 1, finalStatus: "paused", manualMarker: false },
  ]);
  t.diagnostic(JSON.stringify({
    scenarioId: "compaction-manual-recovery",
    registrations: 1,
    plannedPiLaunches: 2,
    executedPiLaunches: histories.reduce((total, history) => total + history.piLaunches, 0),
    histories,
    plannedInputDomains: {
      compaction: ["manual", "threshold", "overflow"],
      goal: ["paused-marked", "paused-unmarked", "complete"],
      revision: ["same", "moved by /goal pause"],
      ordering: ["real request in flight before compact", "settlement before summary release"],
      commands: ["compact", "goal pause"],
    },
  }));
});

function addSessionPath(fixture: Fixture, label: string): string {
  const sessionFile = fixture.sessionFiles.get(label);
  assert.ok(sessionFile, `${label} session path exists`);
  return sessionFile;
}

// Catalog ID: compaction-manual-failure-persistence.
test("Failed, cancelled, or unsavable manual recovery leaves the marked goal paused", { timeout: 900_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  const expectedGoalStart = expectedNotification(
    "Goal started. Each turn must record continue, complete, or a blocker decision before another turn starts.",
    "info",
  );
  const expectedManualPause = expectedNotification(
    "Goal paused because the turn was aborted. If /compact is running, KillerOS will resume the same goal turn after Pi saves the summary. Run /goal pause to keep it paused.",
    "warning",
  );

  histories.push(await runHistory("compaction-manual-failure-persistence", "cancelled-then-explicit-pause", {
    cancelIndexes: [1],
    holdIndexes: [1],
  }, t, async (fixture) => {
    fixture.provider.enqueue(heldPlan());
    const notificationCursor = fixture.rpc.currentSequence;
    const turnCursor = await startGoal(fixture, "Keep this goal paused if manual compaction is cancelled.", 1);
    const compactCursor = lastProbeSequence(fixture);
    const compact = beginManualCompact(fixture);
    const hook = await waitForBeforeCompact(fixture, 1, "manual", compactCursor);
    const settlement = await waitForSettlement(fixture, turnCursor, "cancelled-summary goal settlement");
    assert.equal(settlement.aborted, true);
    const marked = assertPausedMarker(fixture.sessionFile, "goal before public compaction cancellation");
    await waitForManualBarrier(fixture, 1);
    await releaseSummary(fixture, 1);
    const failedResponse = assertResponseFailure(await compact.result, /cancel/iu, "cancelled manual compact RPC");
    assert.equal(failedResponse.command, "compact");
    const failed = await waitForCompactFailure(fixture, hook.sequence);
    assert.equal(failed.aborted, true, "Pi reports the cancelled manual compaction as aborted");
    assert.equal(failed.errorMessage, null, "cancelled compaction has no provider-failure text");
    assert.equal(lastGoalState(fixture.sessionFile, "after cancelled summary").revision, marked.revision,
      "cancellation leaves the persisted marked revision unchanged");
    assert.equal(lastGoalState(fixture.sessionFile, "after cancelled summary").status, "paused");
    assert.equal(compactionCount(fixture.sessionFile), 0, "cancelled summary appends no compaction entry");
    assert.equal(continuationCount(fixture), 1, "cancelled summary queues no recovery turn");

    const pauseResponse = await commandResponse(fixture, "prompt", { message: "/goal pause" });
    assert.equal(responseData(pauseResponse, "explicit marked pause").disposition, "handled");
    const explicitlyPaused = assertNoManualMarker(fixture.sessionFile, "paused", "explicit pause clears the cancelled marker");
    assert.ok(finiteNumberField(explicitlyPaused, "revision") > finiteNumberField(marked, "revision"));
    fixture.provider.enqueue(textPlan("The explicitly paused goal remains paused."));
    const nextCompactCursor = lastProbeSequence(fixture);
    const laterCompact = beginManualCompact(fixture);
    const laterHook = await waitForBeforeCompact(fixture, 2, "manual", nextCompactCursor);
    assertSummaryRequest(await waitForProvider(fixture, 2), "manual compact after explicit pause");
    await waitForCompactEvent(fixture, 2, "manual", laterHook.sequence);
    assertResponseSuccess(await laterCompact.result, "manual compact after explicit pause");
    assertIdle(await currentState(fixture), "cancelled and explicitly paused history");
    assertNoManualMarker(fixture.sessionFile, "paused", "later manual compaction cannot revive the explicitly paused goal");
    assert.equal(continuationCount(fixture), 1);
    const records = await collectRpcBatch(fixture, notificationCursor);
    assertNotifications(records, [expectedGoalStart, expectedManualPause,
      expectedNotification("Goal pause saved. Goal remains paused. Automatic compaction recovery is off.", "info")],
    "cancelled summary and explicit user pause");
    assert.equal(fixture.provider.requests.length, 2);
    assert.equal(fixture.provider.remainingPlans, 0);
  }));

  histories.push(await runHistory("compaction-manual-failure-persistence", "provider-failed-manual-summary", {
    holdIndexes: [1],
  }, t, async (fixture) => {
    fixture.provider.enqueue(heldPlan());
    fixture.provider.enqueue({ kind: "error", status: 503, message: "provider unavailable" });
    const notificationCursor = fixture.rpc.currentSequence;
    const turnCursor = await startGoal(fixture, "Keep the marked goal paused if its manual summary fails.", 1);
    const compactCursor = lastProbeSequence(fixture);
    const compact = beginManualCompact(fixture);
    const hook = await waitForBeforeCompact(fixture, 1, "manual", compactCursor);
    const settlement = await waitForSettlement(fixture, turnCursor, "provider-failed summary goal settlement");
    assert.equal(settlement.aborted, true);
    const marked = assertPausedMarker(fixture.sessionFile, "provider-failed summary before release");
    await waitForManualBarrier(fixture, 1);
    await releaseSummary(fixture, 1);
    const summary = await waitForProvider(fixture, 2);
    assertSummaryRequest(summary, "provider-failed manual summary");
    const failedResponse = assertResponseFailure(await compact.result, /provider unavailable/iu, "provider-failed manual compact RPC");
    const summaryError = 'Summarization failed: 503: {"message":"provider unavailable","type":"server_error"}';
    assert.equal(failedResponse.error, summaryError, "RPC preserves the complete native summary failure");
    const failed = await waitForCompactFailure(fixture, hook.sequence);
    assert.equal(failed.aborted, false, "provider summary failure is not mislabeled as cancellation");
    assert.equal(failed.errorMessage, `Compaction failed: ${summaryError}`);
    const stillPaused = assertPausedMarker(fixture.sessionFile, "provider-failed summary after failure");
    assert.deepEqual(stillPaused, marked, "failed summary cannot alter the durable marked goal");
    assert.equal(compactionCount(fixture.sessionFile), 0, "failed summary persists no compaction entry");
    assert.equal(continuationCount(fixture), 1, "provider failure queues no goal continuation");
    assertIdle(await currentState(fixture), "provider-failed summary");
    const records = await collectRpcBatch(fixture, notificationCursor);
    assertNotifications(records, [expectedGoalStart, expectedManualPause], "provider-failed summary");
    assert.equal(fixture.provider.requests.length, 2);
    assert.equal(fixture.provider.remainingPlans, 0);
  }));

  histories.push(await runHistory("compaction-manual-failure-persistence", "successful-summary-resume-append-fault", {
    holdIndexes: [1],
  }, t, async (fixture) => {
    fixture.provider.enqueue(heldPlan());
    fixture.provider.enqueue(textPlan("Pi saved the manual compaction summary before the goal resume append."));
    const notificationCursor = fixture.rpc.currentSequence;
    const turnCursor = await startGoal(fixture, "Keep the goal paused if its resume append fails.", 1);
    const originalBytes = readFileSync(fixture.sessionFile, "utf8");
    const compactCursor = lastProbeSequence(fixture);
    const compact = beginManualCompact(fixture);
    const hook = await waitForBeforeCompact(fixture, 1, "manual", compactCursor);
    const settlement = await waitForSettlement(fixture, turnCursor, "append-fault goal settlement");
    assert.equal(settlement.aborted, true);
    assertPausedMarker(fixture.sessionFile, "saved pause before resume append fault");
    await waitForManualBarrier(fixture, 1);
    writeFileSync(fixture.faultModeFile, "deny-next\n", "utf8");
    await releaseSummary(fixture, 1);
    assertResponseSuccess(await compact.result, "successful compaction with failed goal resume persistence");
    const summary = await waitForProvider(fixture, 2);
    assertSummaryRequest(summary, "successful manual summary before append fault");
    await waitForCompactEvent(fixture, 1, "manual", hook.sequence);
    const fault = await waitForProbe(fixture.probeFile, (event) => event.type === "append_fault",
      "owned session append fault acknowledgment", fixture.signal, hook.sequence);
    const attempt = record(JSON.parse(readFileSync(fixture.faultAttemptFile, "utf8")), "append fault acknowledgment");
    assert.equal(finiteNumberField(attempt, "pid"), finiteNumberField(fault, "pid"));
    assert.equal(attempt.operation, "appendFileSync");
    assert.equal(path.resolve(stringField(attempt, "path")).toLowerCase(), path.resolve(fixture.sessionFile).toLowerCase());
    assertChildFaultBelongsToRpc(fixture, attempt);
    assert.equal(fault.operation, "appendFileSync");
    assert.equal(path.resolve(stringField(fault, "path")).toLowerCase(), path.resolve(fixture.sessionFile).toLowerCase());
    assert.equal(readFileSync(fixture.faultModeFile, "utf8"), "deny-next\n", "fault adapter mode remains a fixture input, not a product write");
    const finalGoal = assertPausedMarker(fixture.sessionFile, "durable state after resume append fault");
    assert.equal(finalGoal.turns, 1);
    assert.equal(continuationCount(fixture), 1, "failed resume persistence queues no recovery turn");
    assert.equal(compactionCount(fixture.sessionFile), 1, "the successful summary is durable despite the later goal append fault");
    assert.ok(readFileSync(fixture.sessionFile, "utf8").startsWith(originalBytes), "Pi appends to the original session instead of fabricating replacement state");
    const finalState = await currentState(fixture);
    assertIdle(finalState, "successful summary with failed resume append");
    const records = await collectRpcBatch(fixture, notificationCursor);
    assertNotifications(records, [expectedGoalStart, expectedManualPause,
      expectedNotification("Manual compaction succeeded, but the goal could not be resumed: session storage unavailable", "error")],
    "successful summary with failed goal persistence");
    assert.equal(fixture.provider.requests.length, 2);
    assert.equal(fixture.provider.remainingPlans, 0);
  }));

  assert.deepEqual(histories.map((history) => history.providerRequests), [2, 2, 2]);
  assert.deepEqual(histories.map((history) => history.goalContinuations), [1, 1, 1], "failure histories queue no recovery before orderly exit");
  assert.deepEqual(histories.map((history) => history.piLaunches), [1, 1, 1]);
  assert.deepEqual(histories.map((history) => history.otherChildLaunches), [0, 0, 0]);
  assert.ok(histories.every((history) => history.providerPlansRemaining === 0 && history.naturalExit && history.scratchRemoved));
  assertSessionSnapshot(histories[0], [
    { label: "primary", compactionEntries: 1, finalStatus: "paused", manualMarker: false },
  ]);
  assertSessionSnapshot(histories[1], [
    { label: "primary", compactionEntries: 0, finalStatus: "paused", manualMarker: true },
  ]);
  assertSessionSnapshot(histories[2], [
    { label: "primary", compactionEntries: 1, finalStatus: "paused", manualMarker: true },
  ]);
  t.diagnostic(JSON.stringify({
    scenarioId: "compaction-manual-failure-persistence",
    registrations: 1,
    plannedPiLaunches: 3,
    executedPiLaunches: histories.reduce((total, history) => total + history.piLaunches, 0),
    histories,
    plannedInputDomains: {
      manualCompaction: ["cancelled", "provider-failed", "succeeded"],
      persistence: ["successful", "owned append failure"],
      marker: ["present", "cleared by /goal pause"],
      goal: ["paused"],
      mode: "rpc",
      appendFault: { operation: "appendFileSync", path: "owned saved session", acknowledgment: ["pid", "operation", "path"] },
    },
  }));
});
