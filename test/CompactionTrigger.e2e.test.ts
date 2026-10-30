import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixtureProvider = "compaction-trigger";
const fixtureKey = "compaction-trigger-fixture-key";
const observerTimeoutMs = 45_000;
const evidenceRoot = path.join(repositoryRoot, ".pi/compact-codex-20261023/compaction-trigger");

type JsonObject = Record<string, unknown>;
type RpcCloseResult = Awaited<ReturnType<PiRpcProcess["close"]>>;
type TerminalCloseResult = Awaited<ReturnType<PiTerminalProcess["close"]>>;
type ProviderOutcome = "finished" | "closed";
type ProviderResponse =
  | { kind: "text"; content: string; usageTokens?: number }
  | { kind: "goal"; decision: JsonObject; usageTokens?: number };
type ProviderReply = ProviderResponse | { kind: "error"; status: number; message: string };
type ProviderPlan = ProviderReply | { kind: "held"; barrier: Barrier; response: ProviderReply };
type ProviderObservation = {
  index: number;
  body: JsonObject;
  completion: Promise<ProviderOutcome>;
};
type Barrier = { released: Promise<void>; release(): void };
type ProbeEvent = JsonObject & { sequence: number; type: string };
type FixtureBase = {
  directory: string;
  project: string;
  agent: string;
  sessions: string;
  temporary: string;
  sessionFile: string;
  observerFile: string;
  planFile: string;
  provider: LocalProvider;
  signal: AbortSignal;
  acknowledgedSequence: number;
};
type RpcFixture = FixtureBase & { kind: "rpc"; rpc: PiRpcProcess };
type TuiFixture = FixtureBase & { kind: "tui"; terminal: PiTerminalProcess };
type Fixture = RpcFixture | TuiFixture;
type CancellationStage =
  | { kind: "normal-result" | "production-entrypoint"; name: string; compactionAction: "none"; prompt: string; usage: number; requests: 2 }
  | { kind: "provider-retry"; name: string; compactionAction: "none"; prompt: string; usage: number; requests: 1 }
  | { kind: "goal-compaction"; name: string; compactionAction: "cancel-on-abort"; prompt: string; usage: number; requests: 1 }
  | { kind: "ordinary-compaction"; name: string; compactionAction: "cancel-on-abort"; prompt: string; usage: number; requests: 1 };
type RpcRecordWatch = { stop(): PiRpcRecord[] };
type FixtureEvidence = { snapshot: JsonObject; probePlan: JsonObject; probeEvents: ProbeEvent[]; captureErrors: string[] };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function records(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function stringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`${field} must be a string`);
  return candidate;
}

function numberField(value: JsonObject, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) throw new Error(`${field} must be a finite number`);
  return candidate;
}

function readJsonObject(filePath: string, label: string): JsonObject {
  return record(JSON.parse(readFileSync(filePath, "utf8")), label);
}

function readJsonLines(filePath: string, label: string): JsonObject[] {
  const contents = readFileSync(filePath, "utf8");
  return contents.split(/\r?\n/u).filter(Boolean).map((line, index) =>
    record(JSON.parse(line), `${label}[${index + 1}]`));
}

function makeBarrier(): Barrier {
  let resolveRelease: () => void = () => {};
  let released = false;
  const promise = new Promise<void>((resolve) => { resolveRelease = resolve; });
  return {
    released: promise,
    release() {
      if (released) return;
      released = true;
      resolveRelease();
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function captureEnvironment(): string {
  return JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
}

function isolatedEnvironment(directory: string, agentDirectory: string, additional: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const temporary = path.join(directory, "tmp");
  const appData = path.join(directory, "appdata");
  const localAppData = path.join(directory, "localappdata");
  const emptyGitConfig = path.join(directory, "empty-git-config");
  mkdirSync(temporary, { recursive: true });
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  writeFileSync(emptyGitConfig, "", "utf8");

  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    PATH: path.dirname(process.execPath),
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    KILLEROS_COMPACTION_OBSERVER: path.join(directory, "probe.jsonl"),
    KILLEROS_COMPACTION_PLAN: path.join(directory, "probe-plan.json"),
    KILLEROS_COMPACTION_AGENT_END_ACK: path.join(directory, "agent-end.ack"),
    KILLEROS_COMPACTION_AGENT_END_RELEASE: path.join(directory, "agent-end.release"),
    KILLEROS_COMPACTION_AGENT_END_MARKER: "agent-end-control-token",
    ...additional,
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  const secrets = Object.keys(env).filter((key) => /(?:api.?key|token|secret|credential|mcp)/iu.test(key));
  assert.deepEqual(secrets, [], "The isolated child environment must not inherit credentials or MCP configuration");
  return env;
}

function probeExtensionSource(): string {
  return String.raw`import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const observerPath = process.env.KILLEROS_COMPACTION_OBSERVER;
const planPath = process.env.KILLEROS_COMPACTION_PLAN;
const agentEndAck = process.env.KILLEROS_COMPACTION_AGENT_END_ACK;
const agentEndRelease = process.env.KILLEROS_COMPACTION_AGENT_END_RELEASE;
const agentEndMarker = process.env.KILLEROS_COMPACTION_AGENT_END_MARKER;
if (!observerPath || !planPath || !agentEndAck || !agentEndRelease || !agentEndMarker) {
  throw new Error("Compaction probe paths are missing");
}
let sequence = 0;
let compactionIndex = 0;
let agentEndHeld = false;
const readPlan = () => JSON.parse(readFileSync(planPath, "utf8"));
function record(type, details = {}) {
  appendFileSync(observerPath, JSON.stringify({ sequence: ++sequence, type, ...details }) + "\n", "utf8");
}
function publishGate(filePath, token) {
  const temporary = filePath + "." + process.pid + ".tmp";
  writeFileSync(temporary, token + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(temporary, filePath);
}
async function waitForRelease(filePath, token) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(filePath, "utf8") === token + "\n") return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Compaction probe release gate timed out");
}

export default function observeCompaction(pi) {
  pi.registerCommand("fixture-compaction-abort", {
    description: "Abort the real request before releasing the observed agent-end barrier",
    handler: async (_args, ctx) => {
      ctx.abort();
      record("abort_requested", { mode: ctx.mode });
      publishGate(agentEndRelease, agentEndMarker);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    const commands = pi.getCommands().map((command) => command.name);
    record("session_start", {
      mode: ctx.mode,
      hasGoalCommand: commands.includes("goal"),
      hasAutoCompactCommand: commands.includes("auto-compact"),
      hasNotificationCommand: commands.includes("notification"),
    });
  });
  pi.on("agent_start", (_event, ctx) => record("agent_start", { mode: ctx.mode }));
  pi.on("message_start", (event) => record("message_start", {
    role: event.message.role,
    customType: event.message.role === "custom" ? event.message.customType : undefined,
    display: event.message.role === "custom" ? event.message.display : undefined,
  }));
  pi.on("turn_end", (event, ctx) => record("turn_end", {
    mode: ctx.mode,
    turnIndex: event.turnIndex,
    usage: ctx.getContextUsage() ?? null,
  }));
  pi.on("agent_end", async (event, ctx) => {
    const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
    record("agent_end", {
      mode: ctx.mode,
      stopReason: assistant?.stopReason ?? null,
      errorMessage: assistant?.role === "assistant" ? assistant.errorMessage ?? null : null,
    });
    const plan = readPlan();
    if (!agentEndHeld && plan.holdAtAgentEnd === true) {
      agentEndHeld = true;
      publishGate(agentEndAck, agentEndMarker);
      await waitForRelease(agentEndRelease, agentEndMarker);
    }
  });
  pi.on("agent_settled", (event, ctx) => record("agent_settled", {
    mode: ctx.mode,
    aborted: event.aborted === true,
    idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(),
  }));
  pi.on("session_before_compact", async (event) => {
    const plan = readPlan();
    const action = plan.compactActions?.[compactionIndex++] ?? "default";
    record("session_before_compact", {
      action,
      reason: event.reason,
      willRetry: event.willRetry,
      tokensBefore: event.preparation.tokensBefore,
      hasSummarizableMessages: event.preparation.messagesToSummarize.length > 0,
      signalAbortedAtEntry: event.signal.aborted,
    });
    if (action === "custom") {
      return { compaction: {
        summary: "Local compaction fixture summary.",
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } };
    }
    if (action === "cancel-on-abort") {
      if (!event.signal.aborted) await new Promise((resolve) => event.signal.addEventListener("abort", resolve, { once: true }));
      record("compaction_cancel_signal", { aborted: event.signal.aborted });
      return { cancel: true };
    }
    return undefined;
  });
  pi.on("session_compact", (event) => record("session_compact", {
    reason: event.reason,
    fromExtension: event.fromExtension,
    summary: event.compactionEntry.summary,
  }));
  pi.on("session_compact_failed", (event) => record("session_compact_failed", {
    reason: event.reason,
    errorMessage: event.errorMessage ?? null,
    aborted: event.aborted,
    willRetry: event.willRetry,
    fromExtension: event.fromExtension,
  }));
}
`;
}

class LocalProvider {
  private readonly server: Server;
  private readonly plans: ProviderPlan[] = [];
  private readonly waiters = new Set<{
    count: number;
    resolve(request: ProviderObservation): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    signal: AbortSignal;
    abort: () => void;
  }>();
  private readonly barriers = new Set<Barrier>();
  private readonly handlers = new Set<Promise<void>>();
  private base = "";
  readonly requests: ProviderObservation[] = [];
  readonly faults: string[] = [];

  constructor() {
    this.server = createServer((request, response) => {
      const handler = this.handleRequest(request, response);
      this.handlers.add(handler);
      void handler.then(
        () => this.handlers.delete(handler),
        (error: unknown) => {
          if (this.faults.length < 16) this.faults.push(errorText(error).slice(0, 4_000));
          this.handlers.delete(handler);
        },
      );
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }

  get baseUrl(): string {
    if (!this.base) throw new Error("The loopback compaction provider is not listening");
    return this.base;
  }

  get remainingPlans(): number {
    return this.plans.length;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      this.server.once("error", failed);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", failed);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The loopback provider did not receive a TCP address"));
          return;
        }
        this.base = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  enqueue(plan: ProviderPlan): void {
    this.plans.push(plan);
    if (plan.kind === "held") this.barriers.add(plan.barrier);
  }

  holdNext(response: ProviderReply): Barrier {
    const barrier = makeBarrier();
    this.enqueue({ kind: "held", barrier, response });
    return barrier;
  }

  async waitForRequest(count: number, signal: AbortSignal): Promise<ProviderObservation> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    const existing = this.requests[count - 1];
    if (existing) return existing;
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Provider request wait was cancelled");
    return await new Promise<ProviderObservation>((resolve, reject) => {
      const waiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`Timed out waiting for provider request ${count}`));
        }, observerTimeoutMs),
        signal,
        abort: () => {
          this.removeWaiter(waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Provider request wait was cancelled"));
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.add(waiter);
    });
  }

  releaseAll(): void {
    for (const barrier of this.barriers) barrier.release();
  }

  summary(): JsonObject {
    return {
      requestCount: this.requests.length,
      remainingPlans: this.remainingPlans,
      waitingObservers: this.waiters.size,
      faults: this.faults.slice(0, 8),
      statuses: this.requests.map((request) => request.body),
    };
  }

  async close(): Promise<void> {
    this.releaseAll();
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
      try {
        await waitWithTimeout(closed, 10_000, "loopback provider shutdown");
      } catch (error) {
        this.server.closeAllConnections();
        await waitWithTimeout(closed, 5_000, "loopback provider shutdown after closing owned connections");
        throw error;
      }
    }
    await waitWithTimeout(Promise.all([...this.handlers]).then(() => undefined), 10_000, "provider handlers");
    assert.equal(this.waiters.size, 0, "all provider request observers must be stopped");
    assert.deepEqual(this.faults, [], "the loopback provider must not record fixture faults");
  }

  private removeWaiter(waiter: {
    timer: ReturnType<typeof setTimeout>;
    signal: AbortSignal;
    abort: () => void;
  }): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.abort);
    this.waiters.delete(waiter as (typeof this.waiters extends Set<infer T> ? T : never));
  }

  private async readBody(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      assert.ok(chunk instanceof Uint8Array, "provider request chunks must be bytes");
      bytes += chunk.byteLength;
      assert.ok(bytes <= 1_048_576, "provider request body must remain below 1 MiB");
      chunks.push(Buffer.from(chunk));
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "provider request body");
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      const body = await this.readBody(request);
      const plan = this.plans.shift();
      assert.ok(plan, `provider request ${this.requests.length + 1} must have a scripted response`);
      let resolveCompletion: (outcome: ProviderOutcome) => void = () => {};
      const completion = new Promise<ProviderOutcome>((resolve) => { resolveCompletion = resolve; });
      response.once("finish", () => resolveCompletion("finished"));
      response.once("close", () => resolveCompletion(response.writableFinished ? "finished" : "closed"));
      const observation = { index: this.requests.length + 1, body, completion };
      this.requests.push(observation);
      this.resolveWaiters(observation);

      let outcome: ProviderReply;
      if (plan.kind === "held") {
        await plan.barrier.released;
        outcome = plan.response;
      } else {
        outcome = plan;
      }
      if (response.destroyed || response.writableEnded) return;
      if (outcome.kind === "error") {
        response.writeHead(outcome.status, {
          "content-type": "application/json",
          connection: "close",
          ...(outcome.status === 429 ? { "retry-after": "30" } : {}),
        });
        response.end(JSON.stringify({ error: {
          message: outcome.message,
          type: outcome.status === 429 ? "rate_limit_error" : "server_error",
        } }));
        return;
      }

      const usageTokens = outcome.usageTokens;
      const delta = outcome.kind === "text"
        ? { content: outcome.content }
        : { tool_calls: [{
          index: 0,
          id: `compaction-goal-${observation.index}`,
          type: "function",
          function: { name: "killeros_goal_update", arguments: JSON.stringify(outcome.decision) },
        }] };
      const usage = usageTokens === undefined ? undefined : {
        prompt_tokens: Math.max(0, usageTokens - 1),
        completion_tokens: 1,
        total_tokens: usageTokens,
      };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `compaction-trigger-${observation.index}`,
        model: typeof body.model === "string" ? body.model : "local",
        choices: [{ index: 0, delta, finish_reason: outcome.kind === "goal" ? "tool_calls" : "stop" }],
        ...(usage === undefined ? {} : { usage }),
      })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      if (this.faults.length < 16) this.faults.push(errorText(error).slice(0, 4_000));
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { "content-type": "text/plain", connection: "close" });
        response.end("Compaction fixture provider rejected the request");
      }
    }
  }

  private resolveWaiters(observation: ProviderObservation): void {
    for (const waiter of this.waiters) {
      if (waiter.count !== observation.index) continue;
      this.removeWaiter(waiter);
      waiter.resolve(observation);
    }
  }
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function writeProbePlan(filePath: string, plan: { compactActions: string[]; holdAtAgentEnd?: boolean }): void {
  writeFileSync(filePath, `${JSON.stringify(plan)}\n`, "utf8");
}

function writePiConfiguration(options: {
  agent: string;
  providerUrl: string;
  reserveTokens: number;
  keepRecentTokens: number;
  percentRemaining: number;
  compactionEnabled?: boolean;
  preferenceEnabled?: boolean;
  contextWindows?: readonly number[];
  completionSound?: boolean;
  retry?: "off" | "slow";
}): void {
  writeFileSync(path.join(options.agent, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    compaction: {
      enabled: options.compactionEnabled ?? true,
      reserveTokens: options.reserveTokens,
      keepRecentTokens: options.keepRecentTokens,
    },
    retry: options.retry === "slow"
      ? { enabled: true, maxRetries: 1, baseDelayMs: 30_000, maxAgentDelayMs: 30_000, provider: { maxRetries: 0 } }
      : { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    defaultThinkingLevel: "off",
  }, null, 2), "utf8");
  const contextWindows = options.contextWindows ?? [100_000];
  writeFileSync(path.join(options.agent, "models.json"), JSON.stringify({ providers: {
    [fixtureProvider]: {
      api: "openai-completions",
      apiKey: fixtureKey,
      baseUrl: options.providerUrl,
      models: contextWindows.map((contextWindow) => {
        const id = contextWindow === 200_000 ? "large" : contextWindow === 128_000 ? "medium" : "local";
        return {
          id,
          name: `Compaction trigger ${contextWindow}`,
          reasoning: false,
          input: ["text"],
          contextWindow,
          maxTokens: 2_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      }),
    },
  } }, null, 2), "utf8");
  writeFileSync(path.join(options.agent, "killeros.json"), JSON.stringify({
    autoCompaction: { enabled: options.preferenceEnabled ?? options.compactionEnabled ?? true, percentRemaining: options.percentRemaining },
    ...(options.completionSound === undefined ? {} : { completionSound: options.completionSound }),
  }, null, 2), "utf8");
}

function makeSession(project: string, sessions: string, seedHistory: boolean, seedCompaction = false): string {
  if (!seedHistory) return path.join(sessions, "compaction-session.jsonl");
  const manager = SessionManager.create(project, sessions);
  const first = manager.appendMessage({
    role: "user",
    content: `Older saved context for real compaction. ${"Keep this history available to the native cut-point planner. ".repeat(120)}`,
    timestamp: Date.now() - 10_000,
  });
  if (seedCompaction) manager.appendCompaction("Saved historical summary before any reported post-compaction usage.", first, 80_000);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile, "the seeded session must have a saved file");
  return sessionFile;
}

function createBaseFixture(options: {
  label: string;
  percentRemaining: number;
  compactionEnabled?: boolean;
  preferenceEnabled?: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  contextWindows?: readonly number[];
  seedHistory?: boolean;
  seedCompaction?: boolean;
  completionSound?: boolean;
  retry?: "off" | "slow";
  compactActions: string[];
  holdAtAgentEnd?: boolean;
  signal: AbortSignal;
}): Promise<FixtureBase> {
  return createBaseFixtureAsync(options);
}

async function createBaseFixtureAsync(options: Parameters<typeof createBaseFixture>[0]): Promise<FixtureBase> {
  const directory = mkdtempSync(path.join(tmpdir(), `.killeros-compaction-trigger-${options.label}-`));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  mkdirSync(project);
  mkdirSync(agent);
  mkdirSync(sessions);
  mkdirSync(temporary);
  const provider = new LocalProvider();
  try {
    await provider.listen();
    writePiConfiguration({
      agent,
      providerUrl: provider.baseUrl,
      reserveTokens: options.reserveTokens,
      keepRecentTokens: options.keepRecentTokens,
      percentRemaining: options.percentRemaining,
      compactionEnabled: options.compactionEnabled,
      preferenceEnabled: options.preferenceEnabled,
      contextWindows: options.contextWindows,
      completionSound: options.completionSound,
      retry: options.retry,
    });
    const sessionFile = makeSession(project, sessions, options.seedHistory ?? true, options.seedCompaction);
    const observerFile = path.join(directory, "probe.jsonl");
    const planFile = path.join(directory, "probe-plan.json");
    writeFileSync(observerFile, "", "utf8");
    writeProbePlan(planFile, {
      compactActions: options.compactActions,
      holdAtAgentEnd: options.holdAtAgentEnd,
    });
    writeFileSync(path.join(directory, "compaction-probe.mjs"), probeExtensionSource(), "utf8");
    return {
      directory,
      project,
      agent,
      sessions,
      temporary,
      sessionFile,
      observerFile,
      planFile,
      provider,
      signal: options.signal,
      acknowledgedSequence: 0,
    };
  } catch (error) {
    provider.releaseAll();
    try { await provider.close(); } catch { /* preserve setup failure; outer fixture cleanup reports owned files */ }
    await removeDirectoryEventually(directory);
    throw error;
  }
}

function childArguments(options: { mode: "rpc" | "tui"; modelId: "local" | "large"; tools?: string; sessionFile: string; directory: string }): string[] {
  return [
    ...(options.mode === "rpc" ? ["--mode", "rpc"] : []),
    "--model", `${fixtureProvider}/${options.modelId}`,
    "--thinking", "off",
    ...(options.tools === undefined ? ["--no-tools"] : ["--tools", options.tools]),
    "--session", options.sessionFile,
    "--session-dir", path.join(options.directory, "sessions"),
    "--offline",
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-mcp",
    "--no-extensions",
    "--extension", repositoryRoot,
    "--extension", path.join(options.directory, "compaction-probe.mjs"),
  ];
}

async function startRpcFixture(options: Parameters<typeof createBaseFixture>[0] & { tools?: string; modelId?: "local" | "large" }): Promise<RpcFixture> {
  const base = await createBaseFixture(options);
  const env = isolatedEnvironment(base.directory, base.agent, {});
  const rpc = new PiRpcProcess({
    cliPath,
    cwd: base.project,
    env,
    args: childArguments({ mode: "rpc", modelId: options.modelId ?? "local", tools: options.tools, sessionFile: base.sessionFile, directory: base.directory }),
  });
  const fixture: RpcFixture = { ...base, kind: "rpc", rpc };
  try {
    const started = await waitForProbe(fixture, (event) => event.type === "session_start", `RPC session_start for ${options.label}`);
    assert.equal(started.mode, "rpc");
    assert.equal(started.hasAutoCompactCommand, true, `${options.label}: load the real KillerOS entry point`);
    assert.equal(fixture.provider.requests.length, 0, `${options.label}: startup must not call the provider`);
    assertIdle(await getRpcState(fixture), `${options.label} startup`);
    return fixture;
  } catch (error) {
    fixture.provider.releaseAll();
    const cleanupErrors = await closeFixture(fixture);
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `${options.label}: RPC startup and cleanup failed`);
    throw error;
  }
}

async function startTuiFixture(options: Parameters<typeof createBaseFixture>[0] & { tools?: string }): Promise<TuiFixture> {
  const base = await createBaseFixture(options);
  const env = isolatedEnvironment(base.directory, base.agent, {});
  const terminal = new PiTerminalProcess({
    file: process.execPath,
    args: [cliPath, ...childArguments({ mode: "tui", modelId: "local", tools: options.tools, sessionFile: base.sessionFile, directory: base.directory })],
    cwd: base.project,
    env,
    cols: 110,
    rows: 34,
  });
  const fixture: TuiFixture = { ...base, kind: "tui", terminal };
  try {
    const started = await waitForProbe(fixture, (event) => event.type === "session_start", `TUI session_start for ${options.label}`);
    assert.equal(started.mode, "tui");
    assert.equal(started.hasAutoCompactCommand, true, `${options.label}: load the real KillerOS entry point`);
    await waitForTerminalScreen(fixture, (screen) => screen.includes("❯"), "TUI startup");
    return fixture;
  } catch (error) {
    fixture.provider.releaseAll();
    const cleanupErrors = await closeFixture(fixture);
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `${options.label}: TUI startup and cleanup failed`);
    throw error;
  }
}

function readProbeEvents(fixture: FixtureBase): ProbeEvent[] {
  if (!existsSync(fixture.observerFile)) return [];
  return readJsonLines(fixture.observerFile, "compaction probe event").map((event, index) => {
    const sequence = numberField(event, "sequence");
    const type = stringField(event, "type");
    assert.equal(sequence, index + 1, "probe event sequences must be contiguous");
    return { ...event, sequence, type };
  });
}

async function waitForProbe(
  fixture: FixtureBase,
  predicate: (event: ProbeEvent) => boolean,
  label: string,
  afterSequence = 0,
): Promise<ProbeEvent> {
  const event = await waitForFileChange(fixture.observerFile, fixture.signal, label, () =>
    readProbeEvents(fixture).find((candidate) => candidate.sequence > afterSequence && predicate(candidate)));
  return event;
}

async function waitForFileChange<T>(
  filePath: string,
  signal: AbortSignal,
  label: string,
  read: () => T | undefined,
  timeoutMs = observerTimeoutMs,
): Promise<T> {
  if (signal.aborted) throw new Error(`${label} wait was cancelled`, { cause: signal.reason });
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (value !== undefined) resolve(value);
      else reject(new Error(`${label} finished without a value`));
    };
    const check = (): void => {
      try {
        const value = read();
        if (value !== undefined) finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const abort = (): void => finish(new Error(`${label} wait was cancelled`, { cause: signal.reason }));
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      watcher = watch(path.dirname(filePath), { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === path.basename(filePath)) check();
      });
      watcher.on("error", (error) => finish(error));
      check();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function observeRpcRecords(fixture: RpcFixture, after: number): RpcRecordWatch {
  const recordsSeen: PiRpcRecord[] = [];
  const controller = new AbortController();
  let failure: Error | undefined;
  const pending = fixture.rpc.waitForRecord((entry) => {
    recordsSeen.push(entry);
    return false;
  }, { after, timeoutMs: 240_000, signal: controller.signal });
  void pending.catch((error: unknown) => {
    if (!controller.signal.aborted) failure = error instanceof Error ? error : new Error(String(error));
  });
  return {
    stop() {
      if (!controller.signal.aborted) controller.abort(new Error("RPC record observation ended at an acknowledged lifecycle boundary"));
      if (failure) throw failure;
      return recordsSeen;
    },
  };
}

function acknowledgeRpcBatch(fixture: RpcFixture, label: string): void {
  const through = fixture.rpc.currentSequence;
  const first = fixture.rpc.firstSequence;
  const count = fixture.rpc.retainedRecordCount;
  assert.equal(first, fixture.acknowledgedSequence + 1, `${label}: retained RPC records must be contiguous`);
  assert.equal(count, through - fixture.acknowledgedSequence, `${label}: acknowledge the complete observed RPC batch`);
  fixture.rpc.acknowledge(through);
  fixture.acknowledgedSequence = through;
  assert.equal(fixture.rpc.retainedRecordCount, 0, `${label}: acknowledged RPC records must be released`);
}

async function rpcCommand(fixture: RpcFixture, type: string, fields: JsonObject = {}): Promise<PiRpcRecord> {
  return await fixture.rpc.command(type, fields, { timeoutMs: observerTimeoutMs, signal: fixture.signal });
}

async function getRpcState(fixture: RpcFixture): Promise<JsonObject> {
  return record((await rpcCommand(fixture, "get_state")).data, "RPC state");
}

async function getRpcEntries(fixture: RpcFixture): Promise<JsonObject[]> {
  const data = record((await rpcCommand(fixture, "get_entries")).data, "RPC entries response");
  return records(data.entries, "RPC session entries");
}

function assertIdle(state: JsonObject, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: Pi must not be streaming`);
  assert.equal(state.isCompacting, false, `${label}: Pi must not be compacting`);
  assert.equal(state.pendingMessageCount, 0, `${label}: the pending message queue must be empty`);
}

async function waitForSettlements(fixture: RpcFixture, after: number, count: number, label: string): Promise<number> {
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const settled = await fixture.rpc.waitForRecord((entry) => entry.type === "agent_settled", {
      after: cursor,
      timeoutMs: observerTimeoutMs,
      signal: fixture.signal,
    });
    cursor = settled.sequence;
  }
  const state = await getRpcState(fixture);
  assert.equal(state.isStreaming, false, `${label}: Pi must have settled the request`);
  assert.equal(state.pendingMessageCount, 0, `${label}: Pi must have no queued messages`);
  return cursor;
}

async function submitRpcPrompt(fixture: RpcFixture, message: string, expectedDisposition: "handled" | "started" = "started"): Promise<number> {
  const cursor = fixture.rpc.currentSequence;
  const response = await rpcCommand(fixture, "prompt", { message });
  const data = record(response.data, `${message} prompt response`);
  assert.equal(data.disposition, expectedDisposition, `${message}: public RPC disposition`);
  return cursor;
}

async function waitForNotification(
  fixture: RpcFixture,
  after: number,
  predicate: (message: string) => boolean,
  label: string,
  expectedType?: string,
): Promise<PiRpcRecord> {
  const notification = await fixture.rpc.waitFor((entry) => entry.type === "extension_ui_request"
    && entry.method === "notify"
    && typeof entry.message === "string"
    && predicate(entry.message), { after, timeoutMs: observerTimeoutMs, signal: fixture.signal });
  if (expectedType !== undefined) assert.equal(notification.notifyType ?? "info", expectedType, `${label}: notification type`);
  return notification;
}

function compactionEntries(entries: JsonObject[]): JsonObject[] {
  return entries.filter((entry) => entry.type === "compaction");
}

function customMessageStarts(fixture: FixtureBase, customType: string): ProbeEvent[] {
  return readProbeEvents(fixture).filter((event) =>
    event.type === "message_start" && event.role === "custom" && event.customType === customType);
}

function assertHiddenContinuationEntries(entries: JsonObject[], expected: number): void {
  const content = "Continue the interrupted task from the compacted context.";
  const hidden = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "killeros-auto-compaction");
  assert.equal(hidden.length, expected);
  for (const entry of hidden) {
    assert.equal(entry.content, content);
    assert.equal(entry.display, false);
  }
  const userMessages = entries.filter((entry) => entry.type === "message")
    .map((entry) => record(entry.message, "persisted message"))
    .filter((message) => message.role === "user");
  assert.equal(userMessages.some((message) => JSON.stringify(message.content).includes(content)), false,
    "The hidden continuation must not be persisted as a forged user message");
}

function goalStates(entries: JsonObject[]): JsonObject[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal entry data");
    return [record(data.state, "saved goal state")];
  });
}

function last<T>(values: T[], label: string): T {
  const value = values.at(-1);
  assert.ok(value, `${label}: expected a value`);
  return value;
}

function probeCount(fixture: FixtureBase, type: string): number {
  return readProbeEvents(fixture).filter((event) => event.type === type).length;
}

async function waitForTerminalScreen(
  fixture: TuiFixture,
  predicate: (screen: string) => boolean,
  label: string,
  after = fixture.terminal.sequence,
): Promise<string> {
  return await fixture.terminal.waitForScreen(predicate, { signal: fixture.signal, after, timeoutMs: observerTimeoutMs })
    .catch((error: unknown) => {
      throw new Error(`${label}: terminal screen was not reached\n${fixture.terminal.diagnostics()}`, { cause: error });
    });
}

async function waitForProviderRequest(fixture: Fixture, count: number): Promise<ProviderObservation> {
  return await fixture.provider.waitForRequest(count, fixture.signal);
}

function sessionFileEntries(fixture: FixtureBase): JsonObject[] {
  if (!existsSync(fixture.sessionFile)) return [];
  return readJsonLines(fixture.sessionFile, "saved session entry");
}

function processSnapshot(fixture: Fixture): JsonObject {
  return fixture.kind === "rpc"
    ? { kind: fixture.kind, provider: fixture.provider.summary(), rpc: fixture.rpc.diagnostics() }
    : { kind: fixture.kind, provider: fixture.provider.summary(), terminal: fixture.terminal.diagnostics() };
}

async function closeFixture(fixture: Fixture): Promise<unknown[]> {
  const errors: unknown[] = [];
  fixture.provider.releaseAll();
  try {
    if (existsSync(path.join(fixture.directory, "agent-end.ack"))) {
      writeFileSync(path.join(fixture.directory, "agent-end.release"), "agent-end-control-token\n", "utf8");
    }
  } catch (error) {
    errors.push(error);
  }
  if (fixture.kind === "rpc") {
    try {
      const result: RpcCloseResult = await fixture.rpc.close();
      if (result.exit.code !== 0 || result.exit.signal !== null || result.forced || result.treeCleanupError !== undefined) {
        errors.push(new Error(`Pi RPC did not exit naturally: ${JSON.stringify(result)}\n${fixture.rpc.diagnostics()}`));
      }
    } catch (error) {
      errors.push(error);
    }
  } else {
    try {
      const result: TerminalCloseResult = await fixture.terminal.close();
      if (result.code !== 0 || result.forced || result.failure !== undefined) {
        errors.push(new Error(`Pi TUI did not exit naturally: ${JSON.stringify(result)}\n${fixture.terminal.diagnostics()}`));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await fixture.provider.close();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function removeFixture(fixture: FixtureBase): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await removeDirectoryEventually(fixture.directory);
    assert.equal(existsSync(fixture.directory), false, "the owned compaction fixture directory must be removed");
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function reportFailure(options: {
  scenarioId: string;
  message: string;
  errors: unknown[];
  evidence: FixtureEvidence[];
  details?: JsonObject;
}): Promise<never> {
  let reportDirectory: string;
  try {
    mkdirSync(evidenceRoot, { recursive: true });
    reportDirectory = mkdtempSync(path.join(evidenceRoot, `${options.scenarioId}-failure-`));
  } catch (error) {
    throw new AggregateError([...options.errors, error], `${options.message}; failure evidence directory could not be created`);
  }
  throwScenarioFailure({
    directory: reportDirectory,
    message: options.message,
    errors: options.errors,
    diagnostics: JSON.stringify({
      scenarioId: options.scenarioId,
      node: process.version,
      platform: process.platform,
      details: options.details,
      fixtures: options.evidence.map((evidence) => evidence.snapshot),
      probePlans: options.evidence.map((evidence) => evidence.probePlan),
      probeEvents: options.evidence.map((evidence) => evidence.probeEvents),
      evidenceCaptureErrors: options.evidence.map((evidence) => evidence.captureErrors),
    }, null, 2).slice(0, 48_000),
  });
}

function captureFailureEvidence(fixtures: Fixture[]): FixtureEvidence[] {
  return fixtures.map((fixture) => {
    const captureErrors: string[] = [];
    let snapshot: JsonObject = {};
    let probePlan: JsonObject = {};
    let probeEvents: ProbeEvent[] = [];
    try {
      snapshot = processSnapshot(fixture);
    } catch (error) {
      captureErrors.push(`process snapshot: ${errorText(error).slice(0, 2_000)}`);
    }
    try {
      probePlan = readJsonObject(fixture.planFile, "compaction probe plan");
    } catch (error) {
      captureErrors.push(`probe plan: ${errorText(error).slice(0, 2_000)}`);
    }
    try {
      probeEvents = readProbeEvents(fixture).slice(-80);
    } catch (error) {
      captureErrors.push(`probe events: ${errorText(error).slice(0, 2_000)}`);
    }
    return { snapshot, probePlan, probeEvents, captureErrors };
  });
}

function assertOnlySettledReceipts(entries: JsonObject[], expectedOutcome: string, label: string): JsonObject[] {
  const receipts = entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-worked-for") return [];
    return [record(entry.data, `${label} worked-for data`)];
  });
  assert.equal(receipts.length, 1, `${label}: one receipt is written at final settlement`);
  assert.equal(receipts[0]?.outcome, expectedOutcome, `${label}: receipt outcome`);
  return receipts;
}

// Catalog ID: compaction-threshold-reserve-gating.
test("Threshold and reserve gating use the live context window, Pi enablement, and command changes", { timeout: 240_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const environmentBefore = captureEnvironment();
  const fixtures: RpcFixture[] = [];
  let primaryError: unknown;
  let observations: JsonObject = {};

  try {
    const percentage = await startRpcFixture({
      label: "threshold-percentage",
      percentRemaining: 15,
      reserveTokens: 10_000,
      keepRecentTokens: 1,
      compactActions: ["custom"],
      signal: t.signal,
    });
    fixtures.push(percentage);
    percentage.provider.enqueue({ kind: "text", content: "84k remains outside the trigger window.", usageTokens: 84_000 });
    percentage.provider.enqueue({ kind: "text", content: "The updated percentage triggers at the next prompt.", usageTokens: 84_000 });
    percentage.provider.enqueue({ kind: "text", content: "The continuation after the updated threshold finished.", usageTokens: 30_000 });

    let cursor = await submitRpcPrompt(percentage, "Check the 15 percent trigger boundary.");
    await waitForProviderRequest(percentage, 1);
    await waitForSettlements(percentage, cursor, 1, "84k below the 15 percent threshold");
    assert.equal(probeCount(percentage, "session_before_compact"), 0, "84k/100k leaves 16k, above the 15k trigger boundary");
    assert.equal(percentage.provider.requests.length, 1);
    assert.equal(compactionEntries(await getRpcEntries(percentage)).length, 0);
    assert.equal(customMessageStarts(percentage, "killeros-auto-compaction").length, 0);
    assertIdle(await getRpcState(percentage), "below the percentage threshold");

    cursor = percentage.rpc.currentSequence;
    const commandResponse = await rpcCommand(percentage, "prompt", { message: "/auto-compact 20" });
    assert.equal(record(commandResponse.data, "/auto-compact 20 response").disposition, "handled");
    await waitForNotification(percentage, cursor, (message) => message === "Automatic compaction threshold: 20% remaining (on)", "changed threshold", "info");
    assert.equal(probeCount(percentage, "session_before_compact"), 0, "/auto-compact changes only the next eligibility check");
    assert.equal(percentage.provider.requests.length, 1, "the setting command must not call the model");
    assertIdle(await getRpcState(percentage), "after /auto-compact 20");

    cursor = await submitRpcPrompt(percentage, "Check the changed 20 percent boundary.");
    await waitForProviderRequest(percentage, 2);
    await waitForSettlements(percentage, cursor, 2, "changed percentage compaction and continuation");
    let entries = await getRpcEntries(percentage);
    assert.equal(compactionEntries(entries).length, 1, "84k is within the new 20 percent threshold");
    assert.equal(customMessageStarts(percentage, "killeros-auto-compaction").length, 1);
    assert.equal(percentage.provider.requests.length, 3, "one initial prompt, the changed-threshold prompt, and its hidden continuation");
    assert.equal(probeCount(percentage, "session_before_compact"), 1);
    acknowledgeRpcBatch(percentage, "percentage and changed command");

    const reserve = await startRpcFixture({
      label: "threshold-reserve",
      percentRemaining: 1,
      reserveTokens: 10_000,
      keepRecentTokens: 1,
      compactActions: ["custom"],
      signal: t.signal,
    });
    fixtures.push(reserve);
    reserve.provider.enqueue({ kind: "text", content: "The reserve boundary triggers compaction.", usageTokens: 90_500 });
    reserve.provider.enqueue({ kind: "text", content: "The reserve-triggered continuation finished.", usageTokens: 20_000 });
    cursor = await submitRpcPrompt(reserve, "Check the 10000-token native reserve.");
    await waitForProviderRequest(reserve, 1);
    await waitForSettlements(reserve, cursor, 2, "reserve-triggered compaction and continuation");
    entries = await getRpcEntries(reserve);
    assert.equal(compactionEntries(entries).length, 1, "9500 remaining triggers even though the 1 percent threshold is only 1000");
    assert.equal(customMessageStarts(reserve, "killeros-auto-compaction").length, 1);
    assert.equal(reserve.provider.requests.length, 2);
    assert.equal(probeCount(reserve, "session_before_compact"), 1);
    acknowledgeRpcBatch(reserve, "reserve trigger");

    const liveWindow = await startRpcFixture({
      label: "threshold-live-window",
      percentRemaining: 15,
      reserveTokens: 10_000,
      keepRecentTokens: 1,
      contextWindows: [100_000, 128_000, 200_000],
      compactActions: ["custom", "custom"],
      signal: t.signal,
    });
    fixtures.push(liveWindow);
    const mediumModel = await rpcCommand(liveWindow, "set_model", { provider: fixtureProvider, modelId: "medium" });
    assert.equal(record(mediumModel.data, "128k-model selection").contextWindow, 128_000);
    liveWindow.provider.enqueue({ kind: "text", content: "100k of 128k remains above the threshold.", usageTokens: 100_000 });
    cursor = await submitRpcPrompt(liveWindow, "Check the original 100000-of-128000 idle boundary.");
    const idleRecords = observeRpcRecords(liveWindow, cursor);
    await waitForSettlements(liveWindow, cursor, 1, "100k of 128k below the threshold");
    assert.equal(probeCount(liveWindow, "session_before_compact"), 0);
    assert.equal(compactionEntries(await getRpcEntries(liveWindow)).length, 0);
    assert.equal(customMessageStarts(liveWindow, "killeros-auto-compaction").length, 0);
    assert.equal(liveWindow.provider.requests.length, 1);
    assertIdle(await getRpcState(liveWindow), "128k idle boundary");
    assert.deepEqual(idleRecords.stop().filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify"), [],
      "The original 100k/128k idle vector must emit no notification");
    const modelResponse = await rpcCommand(liveWindow, "set_model", { provider: fixtureProvider, modelId: "large" });
    assert.equal(record(modelResponse.data, "large-model selection").id, "large");
    liveWindow.provider.enqueue({ kind: "text", content: "The live 200k context reaches the 15 percent threshold.", usageTokens: 170_000 });
    liveWindow.provider.enqueue({ kind: "text", content: "The 200k continuation finished.", usageTokens: 20_000 });
    cursor = await submitRpcPrompt(liveWindow, "Check the current 200000-token model window.");
    await waitForProviderRequest(liveWindow, 2);
    await waitForSettlements(liveWindow, cursor, 2, "large-model percentage compaction");
    entries = await getRpcEntries(liveWindow);
    assert.equal(compactionEntries(entries).length, 1, "170k/200k leaves 30k, the 15 percent boundary");
    assert.equal(customMessageStarts(liveWindow, "killeros-auto-compaction").length, 1);

    const smallModel = await rpcCommand(liveWindow, "set_model", { provider: fixtureProvider, modelId: "local" });
    assert.equal(record(smallModel.data, "small-model selection").id, "local");
    await rpcCommand(liveWindow, "set_auto_compaction", { enabled: false });
    liveWindow.provider.enqueue({ kind: "text", content: "Pi-disabled compaction must remain idle.", usageTokens: 99_000 });
    cursor = await submitRpcPrompt(liveWindow, "Pi automatic compaction is disabled.");
    await waitForProviderRequest(liveWindow, 4);
    await waitForSettlements(liveWindow, cursor, 1, "Pi-disabled compaction");
    assert.equal(probeCount(liveWindow, "session_before_compact"), 1, "KillerOS must not call ctx.compact while Pi compaction is disabled");
    assert.equal(compactionEntries(await getRpcEntries(liveWindow)).length, 1);
    assert.equal(customMessageStarts(liveWindow, "killeros-auto-compaction").length, 1,
      "Disabling Pi compaction must not enqueue another hidden continuation");
    assert.equal(liveWindow.provider.requests.length, 4);
    assertIdle(await getRpcState(liveWindow), "Pi-disabled compaction");

    await rpcCommand(liveWindow, "compact");
    assert.equal(probeCount(liveWindow, "session_before_compact"), 2);
    assert.equal(compactionEntries(await getRpcEntries(liveWindow)).length, 2);
    await rpcCommand(liveWindow, "set_auto_compaction", { enabled: true });
    const nullThresholdCursor = await submitRpcPrompt(liveWindow, "/auto-compact 100", "handled");
    await waitForNotification(liveWindow, nullThresholdCursor,
      (message) => message === "Automatic compaction threshold: 100% remaining (on)", "unknown-reading threshold", "info");
    liveWindow.provider.enqueue({ kind: "text", content: "No post-compaction usage has been reported.", usageTokens: undefined });
    cursor = await submitRpcPrompt(liveWindow, "Keep the unknown post-compaction reading idle.");
    await waitForProviderRequest(liveWindow, 5);
    await waitForSettlements(liveWindow, cursor, 1, "null post-compaction context reading");
    const nullUsageEvent = last(readProbeEvents(liveWindow).filter((event) => event.type === "turn_end"), "null usage observation");
    const nullUsage = record(nullUsageEvent.usage, "post-compaction context usage");
    assert.equal(nullUsage.tokens, null, "This vector must actually reach Pi's unknown-token state");
    assert.equal(probeCount(liveWindow, "session_before_compact"), 2, "Unknown tokens must not request another compaction");
    assert.equal(customMessageStarts(liveWindow, "killeros-auto-compaction").length, 1);
    assertIdle(await getRpcState(liveWindow), "unknown post-compaction reading");
    await submitRpcPrompt(liveWindow, "/auto-compact 15", "handled");

    await rpcCommand(liveWindow, "new_session");
    await rpcCommand(liveWindow, "set_auto_compaction", { enabled: true });
    liveWindow.provider.enqueue({ kind: "text", content: "The provider omits usage for this observation.", usageTokens: undefined });
    cursor = await submitRpcPrompt(liveWindow, "Observe Pi context usage when provider usage is absent.");
    await waitForProviderRequest(liveWindow, 6);
    await waitForSettlements(liveWindow, cursor, 1, "missing-usage observation");
    const usageEvent = last(readProbeEvents(liveWindow).filter((event) => event.type === "turn_end"), "turn_end usage observation");
    const observedUsage = usageEvent.usage === null ? null : record(usageEvent.usage, "observed context usage");
    const missingUsageTokens = observedUsage?.tokens;
    assert.equal(probeCount(liveWindow, "session_before_compact"), 2, "the small missing-usage turn must not trigger compaction");
    assert.equal(compactionEntries(await getRpcEntries(liveWindow)).length, 0, "The fresh-session reset must discard historical compactions");
    assertIdle(await getRpcState(liveWindow), "fresh missing-usage observation");
    observations = {
      liveWindow: {
        selectedModelContextWindows: [100_000, 128_000, 200_000],
        postCompactionMissingUsageContext: nullUsage,
        postCompactionMissingUsageThreshold: 100,
        missingProviderUsageContext: observedUsage,
        missingProviderUsageTokens: missingUsageTokens,
      },
      launches: fixtures.length,
    };
    assert.equal(captureEnvironment(), environmentBefore, "Fixture setup must not mutate the runner environment");
  } catch (error) {
    primaryError = error;
  }

  const evidence = captureFailureEvidence(fixtures);
  const cleanupErrors: unknown[] = [];
  for (const fixture of [...fixtures].reverse()) {
    cleanupErrors.push(...await closeFixture(fixture));
    cleanupErrors.push(...await removeFixture(fixture));
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId: "compaction-threshold-reserve-gating",
      message: "Threshold and reserve gating E2E scenario failed or did not clean up naturally",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      evidence,
      details: observations,
    });
  }
  assert.equal(fixtures.length, 3, "the catalog workflow uses exactly three independent RPC histories");
  assert.equal(fixtures.reduce((count, fixture) => count + fixture.provider.requests.length, 0), 11);
  assert.ok(fixtures.every((fixture) => fixture.rpc.currentSequence <= 256), "all RPC evidence stays within the bounded record limit");
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-threshold-reserve-gating", piLaunches: fixtures.length, providerRequests: 11, ...observations }));
});

// Catalog ID: compaction-ordinary-continuation-rearm.
test("One hidden ordinary continuation, settlement ordering, and 100 percent rearm", { timeout: 240_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const fixtures: Fixture[] = [];
  let primaryError: unknown;
  let orderEvidence: JsonObject = {};

  try {
    const always = await startRpcFixture({
      label: "continuation-100-percent",
      percentRemaining: 100,
      reserveTokens: 1,
      keepRecentTokens: 1,
      compactActions: ["custom", "default"],
      signal: t.signal,
    });
    fixtures.push(always);
    always.provider.enqueue({ kind: "text", content: "The first ordinary response finished.", usageTokens: 50_000 });
    always.provider.enqueue({ kind: "text", content: "The first hidden continuation finished.", usageTokens: 50_000 });
    always.provider.enqueue({ kind: "text", content: "A later ordinary response finished.", usageTokens: 50_000 });
    const summaryBarrier = always.provider.holdNext({ kind: "text", content: "A native provider summary for the held compaction." });
    always.provider.enqueue({ kind: "text", content: "Native summary preserved the split-turn context." });
    always.provider.enqueue({ kind: "text", content: "The later hidden continuation finished.", usageTokens: 30_000 });

    let cursor = await submitRpcPrompt(always, "Run the first ordinary compaction-triggered request.");
    const firstRecords = observeRpcRecords(always, cursor);
    await waitForProviderRequest(always, 1);
    const firstCompaction = await waitForProbe(always, (event) => event.type === "session_compact", "first native compaction completion");
    await waitForSettlements(always, cursor, 2, "first 100 percent compaction and hidden continuation");
    const firstSettled = await waitForProbe(always, (event) => event.type === "agent_settled", "first ordinary settlement");
    assert.ok(firstSettled.sequence < firstCompaction.sequence,
      "Pi settles the ordinary request before completing its asynchronous compaction");
    let entries = await getRpcEntries(always);
    assert.equal(compactionEntries(entries).length, 1);
    const firstHidden = customMessageStarts(always, "killeros-auto-compaction");
    assert.equal(firstHidden.length, 1, "one hidden continuation follows the successful ordinary compaction");
    assert.equal(firstHidden[0]?.display, false, "the continuation is not displayed as user-facing text");
    assert.ok(firstSettled.sequence < (firstHidden[0]?.sequence ?? Number.POSITIVE_INFINITY)
      && firstCompaction.sequence < (firstHidden[0]?.sequence ?? Number.POSITIVE_INFINITY),
    "the hidden continuation starts after both settlement and compaction");
    assert.equal(always.provider.requests.length, 2, "the hidden continuation starts exactly one new provider request");
    assert.equal(probeCount(always, "session_before_compact"), 1, "the first compaction uses the immediate public custom summary");
    assert.equal(probeCount(always, "agent_start"), 2);
    assertHiddenContinuationEntries(entries, 1);
    assert.deepEqual(firstRecords.stop().filter((entry) => entry.type === "extension_ui_request"
      && entry.method === "notify" && entry.notifyType === "error"), []);
    assertIdle(await getRpcState(always), "first 100 percent trigger");
    acknowledgeRpcBatch(always, "first 100 percent trigger");

    cursor = await submitRpcPrompt(always, "Start a later ordinary request after the hidden continuation.");
    const laterRecords = observeRpcRecords(always, cursor);
    await waitForProviderRequest(always, 3);
    const settlement = await always.rpc.waitForRecord((entry) => entry.type === "agent_settled", {
      after: cursor,
      timeoutMs: observerTimeoutMs,
      signal: t.signal,
    });
    const summaryRequest = await waitForProviderRequest(always, 4);
    assert.equal(summaryRequest.index, 4, "the second compaction must reach the real summary provider");
    assert.equal(always.provider.requests.length, 4, "no continuation request starts while the summary response is held");
    assert.equal((await getRpcState(always)).isCompacting, true, "the held provider keeps native compaction in progress");
    assert.equal(customMessageStarts(always, "killeros-auto-compaction").length, 1,
      "the hidden continuation waits for compaction completion");
    summaryBarrier.release();
    const compacted = await always.rpc.waitForRecord((entry) => entry.type === "compaction_end", {
      after: settlement.sequence,
      timeoutMs: observerTimeoutMs,
      signal: t.signal,
    });
    assert.equal(compacted.value.aborted, false);
    const hidden = await always.rpc.waitForRecord((entry) => entry.type === "message_start"
      && isRecord(entry.message)
      && entry.message.role === "custom"
      && entry.message.customType === "killeros-auto-compaction", {
      after: compacted.sequence,
      timeoutMs: observerTimeoutMs,
      signal: t.signal,
    });
    assert.equal(record(hidden.value.message, "hidden continuation event").display, false);
    const sixth = await waitForProviderRequest(always, 6);
    assert.equal(sixth.index, 6);
    const finalSettled = await always.rpc.waitForRecord((entry) => entry.type === "agent_settled", {
      after: hidden.sequence,
      timeoutMs: observerTimeoutMs,
      signal: t.signal,
    });
    assertIdle(await getRpcState(always), "second 100 percent compaction and continuation");
    entries = await getRpcEntries(always);
    assert.equal(compactionEntries(entries).length, 2, "the later ordinary request rearms compaction once");
    assert.equal(customMessageStarts(always, "killeros-auto-compaction").length, 2);
    assert.equal(probeCount(always, "agent_start"), 4);
    assertHiddenContinuationEntries(entries, 2);
    assert.deepEqual(laterRecords.stop().filter((entry) => entry.type === "extension_ui_request"
      && entry.method === "notify" && entry.notifyType === "error"), []);
    assert.ok(settlement.sequence < compacted.sequence && compacted.sequence < hidden.sequence,
      "the held provider makes the native settlement-before-compaction order observable");
    assert.ok(hidden.sequence < finalSettled.sequence, "the continuation settles after its hidden message is delivered");
    assert.deepEqual(always.provider.faults, []);
    assert.equal(always.provider.remainingPlans, 0);
    orderEvidence = {
      firstCompactionSequence: firstCompaction.sequence,
      firstSettledSequence: firstSettled.sequence,
      firstSettlementBeforeCompactionCompletion: firstSettled.sequence < firstCompaction.sequence,
      firstSettlementSequence: settlement.sequence,
      compactionEndSequence: compacted.sequence,
      secondSettlementBeforeCompactionCompletion: true,
      hiddenContinuationSequence: hidden.sequence,
      continuationSettlementSequence: finalSettled.sequence,
      providerRequests: always.provider.requests.length,
    };
    acknowledgeRpcBatch(always, "100 percent rearm and ordering");

    const fifteen = await startRpcFixture({
      label: "continuation-15-percent",
      percentRemaining: 15,
      reserveTokens: 1,
      keepRecentTokens: 1,
      compactActions: ["custom", "custom"],
      signal: t.signal,
    });
    fixtures.push(fifteen);
    fifteen.provider.enqueue({ kind: "text", content: "90k reaches the 15 percent boundary.", usageTokens: 90_000 });
    fifteen.provider.enqueue({ kind: "text", content: "The first continuation retains the high reading while disarmed.", usageTokens: 90_000 });
    fifteen.provider.enqueue({ kind: "text", content: "70k remains below the trigger boundary.", usageTokens: 70_000 });
    fifteen.provider.enqueue({ kind: "text", content: "A later 90k reading reaches the trigger boundary again.", usageTokens: 90_000 });
    fifteen.provider.enqueue({ kind: "text", content: "The second continuation finished.", usageTokens: 70_000 });

    cursor = await submitRpcPrompt(fifteen, "Start the first 15 percent threshold request.");
    await waitForProviderRequest(fifteen, 1);
    await waitForSettlements(fifteen, cursor, 2, "first 15 percent compaction and continuation");
    assert.equal(probeCount(fifteen, "session_before_compact"), 1,
      "The hidden continuation's still-high 90k reading must remain disarmed");
    assert.equal(fifteen.provider.requests.length, 2);
    assertIdle(await getRpcState(fifteen), "still-high 15 percent continuation");

    cursor = await submitRpcPrompt(fifteen, "Observe the lower 70k post-compaction reading.");
    await waitForProviderRequest(fifteen, 3);
    await waitForSettlements(fifteen, cursor, 1, "70k remains below the 15 percent threshold");
    assert.equal(probeCount(fifteen, "session_before_compact"), 1, "70k rearms without retriggering");
    assert.equal(fifteen.provider.requests.length, 3);
    assertIdle(await getRpcState(fifteen), "below-threshold rearm");

    cursor = await submitRpcPrompt(fifteen, "Observe the later 90k reading.");
    await waitForProviderRequest(fifteen, 4);
    await waitForSettlements(fifteen, cursor, 2, "later 90k retrigger and continuation");
    entries = await getRpcEntries(fifteen);
    assert.equal(compactionEntries(entries).length, 2);
    assert.equal(customMessageStarts(fifteen, "killeros-auto-compaction").length, 2);
    assert.equal(fifteen.provider.requests.length, 5);
    assert.equal(probeCount(fifteen, "session_before_compact"), 2);
    assert.equal(fifteen.provider.remainingPlans, 0);
    assertHiddenContinuationEntries(entries, 2);
    assertIdle(await getRpcState(fifteen), "later 15 percent retrigger");
    acknowledgeRpcBatch(fifteen, "15 percent rearm");

    const tui = await startTuiFixture({
      label: "continuation-tui-100-percent",
      percentRemaining: 100,
      reserveTokens: 1,
      keepRecentTokens: 1,
      compactActions: ["custom", "custom"],
      signal: t.signal,
    });
    fixtures.push(tui);
    const tuiOrders: JsonObject[] = [];
    for (const round of [1, 2]) {
      const beforeProbe = readProbeEvents(tui).at(-1)?.sequence ?? 0;
      const beforeScreen = tui.terminal.sequence;
      const answer = `TUI hidden continuation ${round} finished.`;
      tui.provider.enqueue({ kind: "text", content: `TUI ordinary response ${round} finished.`, usageTokens: 50_000 });
      tui.provider.enqueue({ kind: "text", content: answer, usageTokens: 50_000 });
      tui.terminal.write(`Run ordinary TUI compaction round ${round}.\x1b[13u`);
      await waitForProviderRequest(tui, round * 2);
      const first = await waitForProbe(tui, (event) => event.type === "agent_settled", "TUI interrupted settlement", beforeProbe);
      const compact = await waitForProbe(tui, (event) => event.type === "session_compact", "TUI compaction completion", beforeProbe);
      const hidden = await waitForProbe(tui, (event) => event.type === "message_start"
        && event.role === "custom" && event.customType === "killeros-auto-compaction", "TUI hidden continuation", beforeProbe);
      const second = await waitForProbe(tui, (event) => event.type === "agent_settled", "TUI continuation settlement", hidden.sequence);
      const screen = await waitForTerminalScreen(tui, (value) => value.includes(answer) && value.includes("❯"),
        "TUI completed continuation screen", beforeScreen);
      assert.equal(screen.includes("Continue the interrupted task from the compacted context."), false);
      assert.equal(screen.includes("Automatic compaction failed"), false);
      assert.equal(hidden.display, false);
      assert.ok(first.sequence < compact.sequence && compact.sequence < hidden.sequence && hidden.sequence < second.sequence);
      assert.equal(second.idle, true);
      assert.equal(second.pending, false);
      assert.equal(probeCount(tui, "agent_start"), round * 2);
      assert.equal(probeCount(tui, "session_before_compact"), round);
      assert.equal(probeCount(tui, "session_compact_failed"), 0);
      assert.equal(customMessageStarts(tui, "killeros-auto-compaction").length, round);
      assert.equal(tui.provider.requests.length, round * 2);
      assert.equal(tui.provider.remainingPlans, 0);
      const saved = sessionFileEntries(tui);
      assert.equal(compactionEntries(saved).length, round);
      assertHiddenContinuationEntries(saved, round);
      tuiOrders.push({ round, settlement: first.sequence, compaction: compact.sequence,
        hidden: hidden.sequence, continuationSettlement: second.sequence });
    }
    orderEvidence.tui = tuiOrders;
  } catch (error) {
    primaryError = error;
  }

  const evidence = captureFailureEvidence(fixtures);
  const cleanupErrors: unknown[] = [];
  for (const fixture of [...fixtures].reverse()) {
    fixture.provider.releaseAll();
    cleanupErrors.push(...await closeFixture(fixture));
    cleanupErrors.push(...await removeFixture(fixture));
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId: "compaction-ordinary-continuation-rearm",
      message: "Ordinary compaction continuation E2E scenario failed or did not clean up naturally",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      evidence,
      details: orderEvidence,
    });
  }
  assert.equal(fixtures.length, 3, "the catalog workflow uses two independent RPC histories and one native TUI history");
  assert.equal(fixtures.reduce((count, fixture) => count + fixture.provider.requests.length, 0), 15);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-ordinary-continuation-rearm", piLaunches: fixtures.length, providerRequests: 15, orderEvidence }));
});

// Catalog ID: compaction-skip-failure-no-retry.
test("Exact skip stays silent and rearms; all other failures stay visible and disarm", { timeout: 360_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const fixtures: Fixture[] = [];
  let primaryError: unknown;
  const historyEvidence: JsonObject[] = [];

  try {
    const tooSmall = await startRpcFixture({
      label: "skip-too-small",
      percentRemaining: 100,
      reserveTokens: 1,
      keepRecentTokens: 100_000,
      seedHistory: false,
      compactActions: [],
      signal: t.signal,
    });
    fixtures.push(tooSmall);
    tooSmall.provider.enqueue({ kind: "text", content: "A short history cannot be compacted.", usageTokens: 50_000 });
    tooSmall.provider.enqueue({ kind: "text", content: "The exact skip rearms the next attempt.", usageTokens: 50_000 });
    let cursor = await submitRpcPrompt(tooSmall, "Trigger a native too-small compaction skip.");
    const watch = observeRpcRecords(tooSmall, cursor);
    await waitForProviderRequest(tooSmall, 1);
    await waitForSettlements(tooSmall, cursor, 1, "native too-small skip");
    let observedRecords = watch.stop();
    assert.equal(observedRecords.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify").length, 0,
      "the exact native session-too-small error is silent");
    assert.equal(observedRecords.filter((entry) => entry.type === "compaction_start").length, 1);
    assert.equal(customMessageStarts(tooSmall, "killeros-auto-compaction").length, 0);
    assert.equal(compactionEntries(await getRpcEntries(tooSmall)).length, 0);
    assert.equal(probeCount(tooSmall, "session_before_compact"), 0,
      "Pi throws during native preparation before session_before_compact for this naturally small history");
    assert.ok(tooSmall.rpc.currentSequence < 256);
    acknowledgeRpcBatch(tooSmall, "first native too-small skip");

    cursor = await submitRpcPrompt(tooSmall, "Retry the same exact native skip after rearm.");
    const secondWatch = observeRpcRecords(tooSmall, cursor);
    await waitForProviderRequest(tooSmall, 2);
    await waitForSettlements(tooSmall, cursor, 1, "second native too-small skip");
    observedRecords = secondWatch.stop();
    assert.equal(observedRecords.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify").length, 0);
    const exactStartCount = observedRecords.filter((entry) => entry.type === "compaction_start").length;
    assert.equal(exactStartCount, 1, "the second public prompt reaches another native preparation attempt");
    assert.equal(tooSmall.provider.requests.length, 2, "the exact skip makes no summary or continuation request");
    assert.equal(compactionEntries(await getRpcEntries(tooSmall)).length, 0);
    assert.equal(customMessageStarts(tooSmall, "killeros-auto-compaction").length, 0);
    assertIdle(await getRpcState(tooSmall), "rearmed exact skip");
    acknowledgeRpcBatch(tooSmall, "rearmed native too-small skip");

    const providerFailure = await startRpcFixture({
      label: "provider-failure-disarm",
      percentRemaining: 100,
      reserveTokens: 1,
      keepRecentTokens: 1,
      compactActions: ["default"],
      signal: t.signal,
    });
    fixtures.push(providerFailure);
    providerFailure.provider.enqueue({ kind: "text", content: "Start the provider-failure history.", usageTokens: 50_000 });
    providerFailure.provider.enqueue({ kind: "error", status: 503, message: "compaction provider unavailable" });
    providerFailure.provider.enqueue({ kind: "text", content: "The later same-usage prompt must not retry compaction.", usageTokens: 50_000 });
    cursor = await submitRpcPrompt(providerFailure, "Trigger a real compaction provider error.");
    const failureWatch = observeRpcRecords(providerFailure, cursor);
    await waitForProviderRequest(providerFailure, 1);
    await waitForSettlements(providerFailure, cursor, 1, "provider compaction failure");
    const notice = await waitForNotification(providerFailure, cursor, (message) => message.includes("compaction provider unavailable"),
      "provider compaction failure", "error");
    assert.equal(notice.notifyType, "error");
    let failureRecords = failureWatch.stop();
    assert.equal(failureRecords.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify").length, 1,
      "one provider error produces one visible notification");
    assert.equal(failureRecords.filter((entry) => entry.type === "compaction_start").length, 1);
    assert.equal(customMessageStarts(providerFailure, "killeros-auto-compaction").length, 0);
    assert.equal(compactionEntries(await getRpcEntries(providerFailure)).length, 0);
    assert.equal(providerFailure.provider.requests.length, 2, "the summary request fails after one prompt request");
    acknowledgeRpcBatch(providerFailure, "provider error failure boundary");

    cursor = await submitRpcPrompt(providerFailure, "Check that a same-usage provider failure stays disarmed.");
    const noRetryWatch = observeRpcRecords(providerFailure, cursor);
    await waitForProviderRequest(providerFailure, 3);
    await waitForSettlements(providerFailure, cursor, 1, "provider failure disarm check");
    failureRecords = noRetryWatch.stop();
    assert.equal(failureRecords.filter((entry) => entry.type === "compaction_start").length, 0,
      "The failed 100-percent request must remain disarmed");
    assert.equal(failureRecords.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify").length, 0);
    assert.equal(providerFailure.provider.requests.length, 3, "the later request has no summary retry");
    assert.equal(compactionEntries(await getRpcEntries(providerFailure)).length, 0);
    assert.equal(customMessageStarts(providerFailure, "killeros-auto-compaction").length, 0);
    assertIdle(await getRpcState(providerFailure), "100 percent failure remains disarmed");
    acknowledgeRpcBatch(providerFailure, "provider error remains disarmed");

    const nearMatches = [
      "Nothing to compact (session too small): retry later",
      "automatic compaction skipped: Nothing to compact (session too small)",
      "nothing to compact (session too small)",
      "Nothing to compact (session too small).",
      " Nothing to compact (session too small)",
      "NOTHING TO COMPACT (SESSION TOO SMALL)",
    ] as const;
    const near = await startRpcFixture({
      label: "near-match-provider-errors",
      percentRemaining: 100,
      reserveTokens: 1,
      keepRecentTokens: 1,
      compactActions: Array.from({ length: nearMatches.length }, () => "default"),
      signal: t.signal,
    });
    fixtures.push(near);
    let requestCount = 0;
    for (const [index, message] of nearMatches.entries()) {
      if (index > 0) {
        await rpcCommand(near, "set_auto_compaction", { enabled: false });
        await rpcCommand(near, "new_session");
        near.provider.enqueue({ kind: "text", content: `Seed history for near-match ${index + 1}.`, usageTokens: 5_000 });
        cursor = await submitRpcPrompt(near, `Seed session ${index + 1} while Pi compaction is disabled.`);
        requestCount += 1;
        await waitForProviderRequest(near, requestCount);
        await waitForSettlements(near, cursor, 1, `seed near-match session ${index + 1}`);
        await rpcCommand(near, "set_auto_compaction", { enabled: true });
        acknowledgeRpcBatch(near, `seed near-match session ${index + 1}`);
      }

      near.provider.enqueue({ kind: "text", content: `Start near-match error ${index + 1}.`, usageTokens: 50_000 });
      near.provider.enqueue({ kind: "error", status: 503, message });
      near.provider.enqueue({ kind: "text", content: `No retry after near-match ${index + 1}.`, usageTokens: 50_000 });
      cursor = await submitRpcPrompt(near, `Trigger near-match error ${index + 1}.`);
      const nearWatch = observeRpcRecords(near, cursor);
      requestCount += 1;
      await waitForProviderRequest(near, requestCount);
      await waitForSettlements(near, cursor, 1, `near-match failure ${index + 1}`);
      const expectedMessage = await waitForNotification(near, cursor, (notification) => notification.includes(message),
        `near-match failure ${index + 1}`, "error");
      const nearRecords = nearWatch.stop();
      assert.equal(expectedMessage.notifyType, "error");
      assert.equal(nearRecords.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify").length, 1,
        `near-match ${index + 1} is visible exactly once`);
      assert.equal(nearRecords.filter((entry) => entry.type === "compaction_start").length, 1);
      assert.equal(near.provider.requests.length, requestCount + 1, "the provider error is a real summary POST");
      acknowledgeRpcBatch(near, `near-match failure ${index + 1}`);

      cursor = await submitRpcPrompt(near, `Check no retry after near-match ${index + 1}.`);
      const noRetry = observeRpcRecords(near, cursor);
      requestCount += 2;
      await waitForProviderRequest(near, requestCount);
      await waitForSettlements(near, cursor, 1, `near-match disarm check ${index + 1}`);
      const noRetryRecords = noRetry.stop();
      assert.equal(noRetryRecords.filter((entry) => entry.type === "compaction_start").length, 0,
        `near-match ${index + 1} must not rearm`);
      assert.equal(noRetryRecords.filter((entry) => entry.type === "extension_ui_request" && entry.method === "notify").length, 0);
      assert.equal(near.provider.requests.length, requestCount, `near-match ${index + 1} has no extra summary request`);
      const compactionFailure = last(readProbeEvents(near).filter((event) => event.type === "session_compact_failed"),
        `native session_compact_failed event for near-match ${index + 1}`);
      assert.equal(compactionFailure.aborted, false);
      assert.equal(compactionFailure.errorMessage, `Compaction failed: ${stringField(expectedMessage, "message").slice("Automatic compaction failed: ".length)}`,
        "The notification must preserve the actual native error, including provider wrapping");
      assert.equal(customMessageStarts(near, "killeros-auto-compaction").length, 0);
      assert.equal(compactionEntries(await getRpcEntries(near)).length, 0);
      assertIdle(await getRpcState(near), `near-match ${index + 1} remains disarmed`);
      historyEvidence.push({ index: index + 1, message, nativeError: compactionFailure.errorMessage,
        notification: expectedMessage.message, providerRequests: requestCount });
      acknowledgeRpcBatch(near, `near-match disarm check ${index + 1}`);
    }
    assert.equal(near.provider.requests.length, 23, "six near-match values, six subsequent no-retry turns, and five disabled-compaction seed turns");
    assert.equal(near.provider.remainingPlans, 0);

    const exactSkipEvidence = readProbeEvents(tooSmall).filter((event) => event.type === "session_compact_failed");
    assert.equal(exactSkipEvidence.length, 2, "Both native preparation failures must actually be observed");
    assert.ok(exactSkipEvidence.every((event) => typeof event.errorMessage === "string" && event.errorMessage.includes("Nothing to compact (session too small)")),
      "installed Pi's failure event exposes the native preparation message while KillerOS receives the underlying Error");

    for (const kind of ["exact-skip", "missing-reading", "pi-disabled", "provider-failure"] as const) {
      const tui = await startTuiFixture({
        label: `skip-tui-${kind}`,
        percentRemaining: 100,
        reserveTokens: 1,
        keepRecentTokens: kind === "exact-skip" ? 100_000 : 1,
        seedHistory: kind !== "exact-skip",
        seedCompaction: kind === "missing-reading",
        compactionEnabled: kind !== "pi-disabled",
        preferenceEnabled: true,
        compactActions: kind === "provider-failure" ? ["default"] : [],
        signal: t.signal,
      });
      fixtures.push(tui);
      const initialCompactions = compactionEntries(sessionFileEntries(tui)).length;
      assert.equal(initialCompactions, kind === "missing-reading" ? 1 : 0);
      assert.equal(record(readJsonObject(path.join(tui.agent, "killeros.json"), "TUI preference").autoCompaction,
        "TUI auto-compaction preference").enabled, true, "Pi-only disablement must not disable the KillerOS preference");
      const rounds = kind === "exact-skip" || kind === "provider-failure" ? 2 : 1;
      for (let round = 1; round <= rounds; round++) {
        const beforeProbe = readProbeEvents(tui).at(-1)?.sequence ?? 0;
        const beforeScreen = tui.terminal.sequence;
        const answer = `TUI ${kind} response ${round} finished.`;
        tui.provider.enqueue({ kind: "text", content: answer,
          usageTokens: kind === "missing-reading" ? undefined : 99_000 });
        if (kind === "provider-failure" && round === 1) {
          tui.provider.enqueue({ kind: "error", status: 503, message: "compaction provider unavailable" });
        }
        tui.terminal.write(`Verify TUI ${kind} round ${round}.\x1b[13u`);
        const expectedRequests = kind === "provider-failure" ? round + 1 : round;
        await waitForProviderRequest(tui, expectedRequests);
        await waitForProbe(tui, (event) => event.type === "agent_settled", `TUI ${kind} settlement`, beforeProbe);
        if (kind === "exact-skip") {
          const failure = await waitForProbe(tui, (event) => event.type === "session_compact_failed", "TUI exact native preparation error", beforeProbe);
          assert.equal(failure.errorMessage, "Compaction failed: Nothing to compact (session too small)");
        } else if (kind === "provider-failure" && round === 1) {
          const failure = await waitForProbe(tui, (event) => event.type === "session_compact_failed", "TUI real summary provider failure", beforeProbe);
          assert.match(stringField(failure, "errorMessage"), /Summarization failed: 503:.*compaction provider unavailable/u);
        }
        const screen = await waitForTerminalScreen(tui, (value) => value.includes(answer) && value.includes("❯")
          && (kind !== "provider-failure" || round !== 1 || value.replace(/\s+/gu, " ").includes("compaction provider unavailable")),
          `TUI ${kind} completed response`, beforeScreen);
        if (kind === "provider-failure" && round === 1) {
          assert.equal(screen.match(/Error: Automatic compaction failed:/gu)?.length, 1,
            "The TUI must render exactly one KillerOS failure notification");
        } else if (kind !== "provider-failure") {
          assert.equal(screen.includes("Automatic compaction failed"), false, "Exact skips and ineligible checks stay silent");
        }
        const settled = last(readProbeEvents(tui).filter((event) => event.type === "agent_settled"), "TUI settled state");
        assert.equal(settled.idle, true);
        assert.equal(settled.pending, false);
        if (kind === "missing-reading") {
          const turn = last(readProbeEvents(tui).filter((event) => event.type === "turn_end"), "TUI null reading");
          assert.equal(record(turn.usage, "TUI context usage").tokens, null);
        }
        assert.equal(probeCount(tui, "session_compact_failed"), kind === "exact-skip" ? round : kind === "provider-failure" ? 1 : 0);
        assert.equal(probeCount(tui, "session_before_compact"), kind === "provider-failure" ? 1 : 0);
        assert.equal(compactionEntries(sessionFileEntries(tui)).length, initialCompactions);
        assert.equal(customMessageStarts(tui, "killeros-auto-compaction").length, 0);
        assert.equal(tui.provider.requests.length, expectedRequests);
        assert.equal(tui.provider.remainingPlans, 0);
      }
      historyEvidence.push({ kind, mode: "tui", providerRequests: tui.provider.requests.length,
        nativeFailures: probeCount(tui, "session_compact_failed"), initialCompactions });
    }
  } catch (error) {
    primaryError = error;
  }

  const evidence = captureFailureEvidence(fixtures);
  const cleanupErrors: unknown[] = [];
  for (const fixture of [...fixtures].reverse()) {
    cleanupErrors.push(...await closeFixture(fixture));
    cleanupErrors.push(...await removeFixture(fixture));
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId: "compaction-skip-failure-no-retry",
      message: "Compaction skip and failure E2E scenario failed or did not clean up naturally",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      evidence,
      details: { histories: historyEvidence },
    });
  }
  assert.equal(fixtures.length, 7, "the catalog workflow uses three independent RPC and four native TUI histories");
  assert.equal(fixtures[0]?.provider.requests.length, 2);
  assert.equal(fixtures[1]?.provider.requests.length, 3);
  assert.equal(fixtures[2]?.provider.requests.length, 23);
  assert.equal(fixtures.reduce((count, fixture) => count + fixture.provider.requests.length, 0), 35);
  t.diagnostic(JSON.stringify({
    scenarioId: "compaction-skip-failure-no-retry",
    piLaunches: fixtures.length,
    providerRequests: fixtures.map((fixture) => fixture.provider.requests.length),
    histories: historyEvidence,
  }));
});

// Catalog ID: compaction-cancellation-aborted-settlement.
test("Cancelled ordinary and goal compaction cannot recover after an aborted settlement", { timeout: 420_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const environmentBefore = captureEnvironment();
  const fixtures: Fixture[] = [];
  const parsers = new Map<TuiFixture, PiTerminalProcess>();
  let primaryError: unknown;
  const stageEvidence: JsonObject[] = [];

  try {
    const rpc = await startRpcFixture({
      label: "cancel-rpc-controls",
      percentRemaining: 15,
      reserveTokens: 1,
      keepRecentTokens: 1,
      compactActions: ["cancel-on-abort", "custom", "cancel-on-abort"],
      signal: t.signal,
      tools: "killeros_goal_update",
    });
    fixtures.push(rpc);
    rpc.provider.enqueue({ kind: "text", content: "The ordinary compaction is cancelled.", usageTokens: 90_000 });
    rpc.provider.enqueue({ kind: "text", content: "The context drops below the trigger before rearming.", usageTokens: 10_000 });
    rpc.provider.enqueue({ kind: "text", content: "A later ordinary prompt proves compaction can run again.", usageTokens: 90_000 });
    rpc.provider.enqueue({ kind: "text", content: "The later ordinary continuation finished.", usageTokens: 10_000 });
    rpc.provider.enqueue({ kind: "goal", decision: {
      status: "continue",
      evidence: "The first authorized step completed.",
      nextAction: "Continue the original objective.",
    }, usageTokens: 90_000 });

    let cursor = await submitRpcPrompt(rpc, "Cancel this ordinary context recovery.");
    await waitForProviderRequest(rpc, 1);
    await waitForProbe(rpc, (event) => event.type === "session_before_compact" && event.action === "cancel-on-abort",
      "ordinary RPC compaction hook");
    const abortOutcome = rpcCommand(rpc, "abort");
    await abortOutcome;
    await waitForSettlements(rpc, cursor, 1, "cancelled ordinary RPC compaction");
    assert.equal(probeCount(rpc, "compaction_cancel_signal"), 1);
    assert.equal(customMessageStarts(rpc, "killeros-auto-compaction").length, 0,
      "a cancelled ordinary compaction cannot send a hidden recovery message");
    assert.equal(rpc.provider.requests.length, 1);
    acknowledgeRpcBatch(rpc, "cancelled ordinary RPC compaction");

    cursor = await submitRpcPrompt(rpc, "Drop context usage below the threshold to rearm compaction.");
    await waitForProviderRequest(rpc, 2);
    await waitForSettlements(rpc, cursor, 1, "below-threshold rearm after cancellation");
    assert.equal(probeCount(rpc, "session_before_compact"), 1);
    acknowledgeRpcBatch(rpc, "below-threshold rearm after cancellation");

    cursor = await submitRpcPrompt(rpc, "A later ordinary prompt can request fresh compaction.");
    await waitForProviderRequest(rpc, 3);
    await waitForSettlements(rpc, cursor, 2, "later ordinary successful compaction");
    assert.equal(probeCount(rpc, "session_before_compact"), 2);
    assert.equal(customMessageStarts(rpc, "killeros-auto-compaction").length, 1,
      "a later request can create a new successful continuation after cancellation");
    assert.equal(rpc.provider.requests.length, 4);
    acknowledgeRpcBatch(rpc, "fresh ordinary compaction after cancellation");

    const goalProbeAfter = readProbeEvents(rpc).at(-1)?.sequence ?? 0;
    cursor = await submitRpcPrompt(rpc, "/goal Continue after the cancelled goal compaction.", "handled");
    await waitForProviderRequest(rpc, 5);
    await waitForProbe(rpc, (event) => event.type === "session_before_compact" && event.action === "cancel-on-abort",
      "goal RPC compaction hook", goalProbeAfter);
    await rpcCommand(rpc, "abort");
    await waitForSettlements(rpc, cursor, 1, "cancelled goal compaction");
    const rpcEntries = await getRpcEntries(rpc);
    const finalGoal = last(goalStates(rpcEntries), "cancelled goal RPC history");
    assert.equal(finalGoal.status, "paused");
    assert.equal(finalGoal.turns, 1);
    assert.notEqual(finalGoal.resumeAfterManualCompaction, true);
    assert.equal(customMessageStarts(rpc, "killeros-auto-compaction").length, 1,
      "goal compaction cancellation must not add another ordinary continuation");
    assert.equal(rpc.provider.requests.length, 5, "only one provider request belongs to the cancelled goal turn");
    assert.equal(record(await getRpcState(rpc), "RPC state after goal cancellation").pendingMessageCount, 0);
    acknowledgeRpcBatch(rpc, "cancelled goal RPC compaction");
    stageEvidence.push({
      kind: "rpc-controls",
      providerRequests: rpc.provider.requests.length,
      compactionAttempts: probeCount(rpc, "session_before_compact"),
      hiddenContinuations: customMessageStarts(rpc, "killeros-auto-compaction").length,
      goalState: finalGoal,
    });

    const stages = [
      { kind: "normal-result", name: "final normal-result boundary", compactionAction: "none", prompt: "/goal Verify the result boundary.", usage: 10_000, requests: 2 },
      { kind: "provider-retry", name: "provider retry pending", compactionAction: "none", prompt: "/goal Verify retry cancellation.", usage: 10_000, requests: 1 },
      { kind: "goal-compaction", name: "goal compaction pending", compactionAction: "cancel-on-abort", prompt: "/goal Verify goal compaction cancellation.", usage: 50_000, requests: 1 },
      { kind: "ordinary-compaction", name: "ordinary compaction pending", compactionAction: "cancel-on-abort", prompt: "Verify ordinary compaction cancellation.", usage: 50_000, requests: 1 },
      { kind: "production-entrypoint", name: "production entrypoint", compactionAction: "none", prompt: "/goal Verify the full production extension entrypoint.", usage: 10_000, requests: 2 },
    ] satisfies CancellationStage[];

    for (const [index, stage] of stages.entries()) {
      const tui = await startTuiFixture({
        label: `cancel-stage-${index + 1}`,
        percentRemaining: 100,
        reserveTokens: 1,
        keepRecentTokens: 1,
        compactActions: stage.compactionAction === "none" ? [] : [stage.compactionAction],
        compactionEnabled: stage.compactionAction !== "none",
        holdAtAgentEnd: stage.kind === "normal-result" || stage.kind === "production-entrypoint",
        completionSound: true,
        retry: stage.kind === "provider-retry" ? "slow" : "off",
        signal: t.signal,
        tools: "killeros_goal_update",
      });
      fixtures.push(tui);
      const parser = tui.terminal;
      parsers.set(tui, parser);
      await waitForTerminalScreen(tui, (screen) => screen.includes("❯"), `${stage.name} TUI ready`, -1);
      const soundDialogAfter = tui.terminal.sequence;
      await tui.terminal.submitEditorText("/notification", { signal: t.signal });
      await waitForTerminalScreen(tui, (screen) => screen.includes("Completion sound") && screen.includes("↑↓ navigate"),
        `${stage.name} completion sound dialog`, soundDialogAfter);
      const soundEnabledAfter = tui.terminal.sequence;
      tui.terminal.write("\r");
      await waitForTerminalScreen(tui, (screen) => screen.includes("Completion sound: On"),
        `${stage.name} completion sound enabled`, soundEnabledAfter);
      assert.ok(parser.titles.some((title) => title.includes("󰂚")), `${stage.name}: completion sound preference appears in the parsed title`);
      assert.equal(parser.bellCount, 0, `${stage.name}: startup title BEL does not count as a completion bell`);

      if (stage.kind === "normal-result" || stage.kind === "production-entrypoint") {
        tui.provider.enqueue({ kind: "goal", decision: {
          status: "continue", evidence: "The first authorized step passed.", nextAction: "Verify the final response.",
        }, usageTokens: stage.usage });
        tui.provider.enqueue({ kind: "text", content: "The normal assistant result reached agent_end.", usageTokens: stage.usage });
      } else if (stage.kind === "provider-retry") {
        tui.provider.enqueue({ kind: "error", status: 429, message: "controlled retry cancellation" });
      } else if (stage.kind === "goal-compaction") {
        tui.provider.enqueue({ kind: "goal", decision: {
          status: "continue", evidence: "The first compaction-stage step passed.", nextAction: "Continue after compaction.",
        }, usageTokens: stage.usage });
      } else {
        tui.provider.enqueue({ kind: "text", content: `${stage.name} response reached its cancellation boundary.`, usageTokens: stage.usage });
      }

      const before = tui.terminal.sequence;
      await tui.terminal.submitEditorText(stage.prompt, { signal: t.signal });
      const firstRequest = await waitForProviderRequest(tui, 1);
      if (stage.kind === "normal-result" || stage.kind === "production-entrypoint") {
        const agentEnd = await waitForFileChange(
          path.join(tui.directory, "agent-end.ack"),
          t.signal,
          `${stage.name} observed agent_end boundary`,
          () => existsSync(path.join(tui.directory, "agent-end.ack"))
            ? readFileSync(path.join(tui.directory, "agent-end.ack"), "utf8")
            : undefined,
        );
        assert.equal(agentEnd, "agent-end-control-token\n");
        assert.equal(tui.provider.requests.length, 2, `${stage.name}: normal-result workflow uses exactly two model calls`);
        assert.equal((await waitForProviderRequest(tui, 2)).index, 2);
        tui.terminal.write("/fixture-compaction-abort\r");
        await waitForProbe(tui, (event) => event.type === "abort_requested", `${stage.name} public abort request`);
      } else if (stage.kind === "provider-retry") {
        await firstRequest.completion;
        await waitForTerminalScreen(tui, (screen) => screen.includes("Retrying (1/1) in"), "native Pi provider retry pending", before);
        tui.terminal.write("/fixture-compaction-abort\r");
      } else {
        await waitForProbe(tui, (event) => event.type === "session_before_compact" && event.action === "cancel-on-abort",
          `${stage.name} real compaction hook`);
        tui.terminal.write("/fixture-compaction-abort\r");
      }

      const settledEvents = await waitForFileChange(
        tui.observerFile,
        t.signal,
        `${stage.name} aborted agent_settled`,
        () => readProbeEvents(tui).find((event) => event.type === "agent_settled" && event.aborted === true),
      );
      assert.equal(settledEvents.idle, true, `${stage.name}: Pi reports idle at aborted settlement`);
      assert.equal(settledEvents.pending, false, `${stage.name}: no follow-up remains queued`);
      assert.equal(tui.provider.requests.length, stage.requests, `${stage.name}: exact model request count`);
      assert.equal(parser.bellCount, 0, `${stage.name}: aborted settlement does not ring the parsed terminal bell`);
      if (stage.compactionAction !== "none") {
        await waitForProbe(tui, (event) => event.type === "compaction_cancel_signal",
          `${stage.name} acknowledged compaction abort signal`);
        const compactFailure = await waitForProbe(tui, (event) => event.type === "session_compact_failed",
          `${stage.name} native compaction cancellation completion`);
        assert.equal(compactFailure.aborted, true, `${stage.name}: Pi confirms native compaction cancellation`);
        assert.equal(probeCount(tui, "compaction_cancel_signal"), 1, `${stage.name}: native abort reaches the compaction hook signal`);
        assert.equal(probeCount(tui, "session_compact"), 0, `${stage.name}: cancellation never claims compaction succeeded`);
      }

      if (stage.kind !== "ordinary-compaction") {
        const pendingGoalState = last(goalStates(sessionFileEntries(tui)), `${stage.name} persisted goal state`);
        assert.equal(pendingGoalState.status, "paused", `${stage.name}: interrupted goal remains paused`);
        assert.equal(pendingGoalState.turns, 1, `${stage.name}: interrupted goal records one turn`);
        assert.equal(pendingGoalState.maxTurns, 20);
        assert.notEqual(pendingGoalState.resumeAfterManualCompaction, true);
      }

      if (stage.kind === "normal-result" || stage.kind === "production-entrypoint") {
        const entriesAtBoundary = sessionFileEntries(tui);
        assertOnlySettledReceipts(entriesAtBoundary, "stopped", stage.name);
        assert.equal(customMessageStarts(tui, "killeros-auto-compaction").length, 0);
        assert.equal(customMessageStarts(tui, "killeros-goal-continuation").length, 1,
          "only the initial authorized goal message is dispatched before cancellation");
        assert.ok(probeCount(tui, "agent_end") >= 1, `${stage.name}: public agent_end was observed before PTY abort`);
      }

      const closed = await closeFixture(tui);
      assert.deepEqual(closed, [], `${stage.name}: terminal and provider close naturally`);
      const savedEntries = sessionFileEntries(tui);
      assert.deepEqual(readProbeEvents(tui).filter((event) => event.type === "agent_settled").map((event) => event.aborted), [true],
        `${stage.name}: exactly one aborted settlement and no later successful settlement`);
      assert.equal(customMessageStarts(tui, "killeros-auto-compaction").length, 0,
        `${stage.name}: cancellation must never dispatch an ordinary recovery`);
      assert.equal(customMessageStarts(tui, "killeros-goal-continuation").length, stage.kind === "ordinary-compaction" ? 0 : 1,
        `${stage.name}: only the initial authorized goal message may dispatch`);
      assert.equal(tui.provider.requests.length, stage.requests, `${stage.name}: shutdown must not dispatch another provider request`);
      assertOnlySettledReceipts(savedEntries, "stopped", stage.name);
      if (stage.kind !== "ordinary-compaction") {
        const finalState = last(goalStates(savedEntries), `${stage.name} final goal state`);
        assert.equal(finalState.status, "paused");
        assert.equal(finalState.turns, 1);
      }
      assert.equal(parser.bellCount, 0, `${stage.name}: no final completion bell after saved settlement`);
      assert.equal(tui.provider.remainingPlans, 0, `${stage.name}: all planned external responses were consumed`);
      stageEvidence.push({
        stage: stage.name,
        mode: "tui",
        providerRequests: tui.provider.requests.length,
        settledAborted: true,
        receipts: savedEntries.filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for").length,
        parserBells: parser.bellCount,
        compactionCancelSignals: probeCount(tui, "compaction_cancel_signal"),
        cleanup: "natural",
      });
      parsers.delete(tui);
      cleanupErrorsForFixture(tui, await removeFixture(tui));
    }

    assert.equal(captureEnvironment(), environmentBefore, "TUI and RPC fixtures must not mutate the runner environment");
  } catch (error) {
    primaryError = error;
  }

  const evidence = captureFailureEvidence(fixtures);
  const cleanupErrors: unknown[] = [];
  for (const [fixture] of parsers) {
    cleanupErrors.push(...await closeFixture(fixture));
    cleanupErrors.push(...await removeFixture(fixture));
  }
  for (const fixture of fixtures) {
    if (parsers.has(fixture as TuiFixture)) continue;
    if (fixture.kind === "rpc" && existsSync(fixture.directory)) {
      cleanupErrors.push(...await closeFixture(fixture));
      cleanupErrors.push(...await removeFixture(fixture));
    }
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId: "compaction-cancellation-aborted-settlement",
      message: "Compaction cancellation E2E scenario failed or did not clean up naturally",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      evidence,
      details: { stages: stageEvidence },
    });
  }
  assert.equal(fixtures.filter((fixture) => fixture.kind === "tui").length, 5);
  assert.equal(fixtures.filter((fixture) => fixture.kind === "rpc").length, 1);
  assert.deepEqual(stageEvidence.slice(1).map((stage) => stage.providerRequests), [2, 1, 1, 1, 2]);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-cancellation-aborted-settlement", piLaunches: fixtures.length, stageEvidence }));
});

function cleanupErrorsForFixture(_fixture: Fixture, errors: unknown[]): void {
  if (errors.length > 0) throw new AggregateError(errors, "owned compaction fixture cleanup failed");
}
