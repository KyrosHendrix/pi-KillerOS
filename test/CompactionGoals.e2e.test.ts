import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const reportsRoot = path.join(repositoryRoot, "node_modules", ".killeros-compact-goals-reports");
const fixtureProvider = "compact-goals";
const fixtureKey = "compact-goals-local-only";
const waitTimeoutMs = 60_000;

type Json = Record<string, unknown>;
type Mode = "rpc" | "tui";
type CompactionAction = "provider" | "custom";
type Reply =
  | { kind: "text"; content: string; usageTokens?: number }
  | { kind: "goal"; decision: Json; usageTokens?: number }
  | { kind: "write"; filePath: string; content: string; usageTokens?: number }
  | { kind: "error"; status: number; message: string; errorType?: string };
type RequestPlan = Reply | { kind: "held"; barrier: Barrier; response: Reply };
type Barrier = { released: Promise<void>; release(): void };
type ProbeEvent = Json & { sequence: number; type: string };
type ProviderRequest = { index: number; body: Json };
type FixtureBase = {
  directory: string;
  project: string;
  agent: string;
  sessions: string;
  planFile: string;
  probeFile: string;
  faultModeFile: string;
  faultAttemptFile: string;
  sessionFile: string;
  signal: AbortSignal;
  provider: LocalProvider;
};
type RpcFixture = FixtureBase & { kind: "rpc"; rpc: PiRpcProcess };
type TuiFixture = FixtureBase & { kind: "tui"; terminal: PiTerminalProcess };
type Fixture = RpcFixture | TuiFixture;
type FixtureOptions = {
  mode: Mode;
  label: string;
  percentRemaining?: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  compactionEnabled?: boolean;
  seedHistory?: boolean;
  compactActions?: readonly CompactionAction[];
  heldCompactions?: readonly number[];
  retry?: "off" | "provider-once";
};
type HistoryResult = { scenarioId: string; label: string; piLaunches: number; providerRequests: number; naturalExit: boolean; scratchRemoved: boolean };

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Json {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function records(value: unknown, label: string): Json[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function stringField(value: Json, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`${field} must be a string`);
  return candidate;
}

function numberField(value: Json, field: string): number {
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

/** Serves only scripted loopback responses and rejects every unplanned Pi request. */
class LocalProvider {
  private readonly server: Server;
  private readonly plans: RequestPlan[] = [];
  private readonly activeBarriers = new Set<Barrier>();
  private readonly handlers = new Set<Promise<void>>();
  private baseUrl = "";
  readonly requests: ProviderRequest[] = [];
  readonly faults: string[] = [];

  constructor() {
    this.server = createServer((request, response) => {
      const handler = this.handleRequest(request, response);
      this.handlers.add(handler);
      void handler.then(
        () => this.handlers.delete(handler),
        (error: unknown) => {
          this.faults.push(errorText(error).slice(0, 4_000));
          this.handlers.delete(handler);
        },
      );
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }

  get url(): string {
    if (!this.baseUrl) throw new Error("The local provider is not listening");
    return this.baseUrl;
  }

  get remainingPlans(): number {
    return this.plans.length;
  }

  enqueue(plan: RequestPlan): void {
    this.plans.push(plan);
    if (plan.kind === "held") this.activeBarriers.add(plan.barrier);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The local provider did not bind a TCP port"));
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  async waitForRequest(count: number, signal: AbortSignal): Promise<ProviderRequest> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    const ready = this.requests[count - 1];
    if (ready) return ready;
    if (signal.aborted) throw new Error("Provider wait was cancelled", { cause: signal.reason });
    return await new Promise<ProviderRequest>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Timed out waiting for provider request ${count}`)), waitTimeoutMs);
      let poll: ReturnType<typeof setInterval> | undefined;
      const abort = (): void => finish(new Error("Provider wait was cancelled", { cause: signal.reason }));
      const finish = (error?: Error, request?: ProviderRequest): void => {
        clearTimeout(timeout);
        if (poll) clearInterval(poll);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (request) resolve(request);
        else reject(new Error("Provider request wait finished without a result"));
      };
      poll = setInterval(() => {
        const request = this.requests[count - 1];
        if (request) finish(undefined, request);
      }, 5);
      signal.addEventListener("abort", abort, { once: true });
      const request = this.requests[count - 1];
      if (request) finish(undefined, request);
    });
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
    assert.deepEqual(this.faults, [], "the loopback provider must not record fixture faults");
  }

  releaseAll(): void {
    for (const barrier of this.activeBarriers) barrier.release();
  }

  private async readBody(request: IncomingMessage): Promise<Json> {
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
    const outcome = plan.kind === "held" ? await this.resolveHeld(plan) : plan;
    if (response.destroyed || response.writableEnded) return;
    if (outcome.kind === "error") {
      response.writeHead(outcome.status, {
        "content-type": "application/json",
        connection: "close",
        ...(outcome.status === 429 ? { "retry-after": "30" } : {}),
      });
      response.end(JSON.stringify({ error: {
        message: outcome.message,
        type: outcome.errorType ?? (outcome.status === 429 ? "rate_limit_error" : "server_error"),
        ...(outcome.errorType === "context_length_exceeded" ? { code: "context_length_exceeded" } : {}),
      } }));
      return;
    }
    const delta = outcome.kind === "goal"
      ? { tool_calls: [{ index: 0, id: `compact-goal-${observed.index}`, type: "function",
        function: { name: "killeros_goal_update", arguments: JSON.stringify(outcome.decision) } }] }
      : outcome.kind === "write"
        ? { tool_calls: [{ index: 0, id: `compact-write-${observed.index}`, type: "function",
          function: { name: "write", arguments: JSON.stringify({ path: outcome.filePath, content: outcome.content }) } }] }
        : { content: outcome.content };
    const usage = outcome.kind === "text" || outcome.kind === "goal" || outcome.kind === "write"
      ? outcome.usageTokens === undefined
        ? undefined
        : { prompt_tokens: Math.max(0, outcome.usageTokens - 1), completion_tokens: 1, total_tokens: outcome.usageTokens }
      : undefined;
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(`data: ${JSON.stringify({
      id: `compact-goals-${observed.index}`,
      model: "local",
      choices: [{ index: 0, delta, finish_reason: outcome.kind === "goal" || outcome.kind === "write" ? "tool_calls" : "stop" }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\ndata: [DONE]\n\n`);
  }

  private async resolveHeld(plan: Extract<RequestPlan, { kind: "held" }>): Promise<Reply> {
    await plan.barrier.released;
    return plan.response;
  }
}

/** Observation-only extension. Custom summaries use Pi's public compaction hook and can wait at a real summary barrier. */
const probeExtensionSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const probeFile = process.env.KILLEROS_COMPACT_PROBE;
const planFile = process.env.KILLEROS_COMPACT_PLAN;
const faultModeFile = process.env.KILLEROS_COMPACT_FAULT_MODE;
const faultAttemptFile = process.env.KILLEROS_COMPACT_FAULT_ATTEMPT;
const sessionFile = process.env.KILLEROS_COMPACT_SESSION;
if (!probeFile || !planFile || !faultModeFile || !faultAttemptFile || !sessionFile) throw new Error("Compact-goal probe paths are missing");
let sequence = 0;
let compactionIndex = 0;
let activeFaultMode = "";
let goalWritesInMode = 0;
const originalAppendFileSync = fs.appendFileSync.bind(fs);

function record(type, details = {}) {
  fs.appendFileSync(probeFile, JSON.stringify({ sequence: ++sequence, type, ...details }) + "\n", "utf8");
}
function publish(filePath, token) {
  const temporary = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, token + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, filePath);
}
function readPlan() {
  return JSON.parse(fs.readFileSync(planFile, "utf8"));
}
function waitForRelease(filePath, token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
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
    const watcher = fs.watch(path.dirname(filePath), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === path.basename(filePath)) check();
    });
    watcher.on("error", finish);
    const timer = setTimeout(() => finish(new Error("summary release gate timed out")), 60_000);
    check();
  });
}

fs.appendFileSync = function(file, data, ...args) {
  if (typeof file === "string" && path.resolve(file).toLowerCase() === path.resolve(sessionFile).toLowerCase()
    && String(data).includes('"customType":"killeros-goal"')) {
    let mode = "";
    try { mode = fs.readFileSync(faultModeFile, "utf8").trim(); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (mode !== activeFaultMode) { activeFaultMode = mode; goalWritesInMode = 0; }
    if (mode === "deny-next" || mode === "allow-one-then-deny" && goalWritesInMode > 0) {
      fs.writeFileSync(faultAttemptFile, JSON.stringify({ pid: process.pid, operation: "appendFileSync", file }), "utf8");
      throw new Error("session storage unavailable");
    }
    if (mode === "allow-one-then-deny") goalWritesInMode += 1;
  }
  return originalAppendFileSync(file, data, ...args);
};
syncBuiltinESMExports();

export default function compactGoalProbe(pi) {
  pi.on("session_start", (_event, ctx) => record("session_start", { mode: ctx.mode }));
  pi.on("agent_start", (_event, ctx) => record("agent_start", { mode: ctx.mode }));
  pi.on("message_start", (event) => record("message_start", {
    role: event.message.role,
    customType: event.message.role === "custom" ? event.message.customType : undefined,
    display: event.message.role === "custom" ? event.message.display : undefined,
  }));
  pi.on("turn_end", (event, ctx) => record("turn_end", {
    turnIndex: event.turnIndex,
    usage: ctx.getContextUsage() ?? null,
  }));
  pi.on("agent_end", (event) => {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const assistant = [...messages].reverse().find((message) => message && message.role === "assistant");
    record("agent_end", {
      stopReason: assistant?.stopReason ?? null,
      errorMessage: assistant?.errorMessage ?? null,
    });
  });
  pi.on("agent_settled", (event, ctx) => record("agent_settled", {
    aborted: event.aborted === true,
    idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(),
  }));
  pi.on("session_before_compact", async (event) => {
    const plan = readPlan();
    const index = compactionIndex++;
    const action = plan.compactActions?.[index] ?? "provider";
    const hold = Array.isArray(plan.heldCompactions) && plan.heldCompactions.includes(index + 1);
    const token = "summary-" + (index + 1);
    record("session_before_compact", {
      index: index + 1,
      action,
      reason: event.reason,
      willRetry: event.willRetry,
      tokensBefore: event.preparation.tokensBefore,
      hasSummarizableMessages: event.preparation.messagesToSummarize.length > 0,
    });
    if (hold) {
      publish(path.join(path.dirname(probeFile), token + ".ack"), token);
      await waitForRelease(path.join(path.dirname(probeFile), token + ".release"), token);
    }
    if (action === "custom") return { compaction: {
      summary: "Fixture summary. Preserve the current goal state and next authorized step.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } };
    return undefined;
  });
  pi.on("session_compact", (event) => record("session_compact", {
    index: compactionIndex,
    reason: event.reason,
    fromExtension: event.fromExtension,
    summary: event.compactionEntry.summary,
  }));
  pi.on("session_compact_failed", (event) => record("session_compact_failed", {
    reason: event.reason,
    errorMessage: event.errorMessage ?? null,
    aborted: event.aborted,
    willRetry: event.willRetry,
  }));
  pi.on("session_shutdown", () => {
    fs.appendFileSync = originalAppendFileSync;
    syncBuiltinESMExports();
    record("session_shutdown", { faultAdapterRestored: true });
  });
}
`;

function readProbeEvents(filePath: string): ProbeEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean);
  return lines.map((line, index) => {
    const event = record(JSON.parse(line), `probe event ${index + 1}`);
    const sequence = numberField(event, "sequence");
    const type = stringField(event, "type");
    assert.equal(sequence, index + 1, "probe sequences must be contiguous");
    return { ...event, sequence, type };
  });
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

function isolatedEnvironment(base: Omit<FixtureBase, "provider" | "signal">): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {
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
    KILLEROS_COMPACT_PROBE: base.probeFile,
    KILLEROS_COMPACT_PLAN: base.planFile,
    KILLEROS_COMPACT_FAULT_MODE: base.faultModeFile,
    KILLEROS_COMPACT_FAULT_ATTEMPT: base.faultAttemptFile,
    KILLEROS_COMPACT_SESSION: base.sessionFile,
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  assert.deepEqual(Object.keys(env).filter((key) => /(?:api.?key|token|secret|credential|mcp)/iu.test(key)), [],
    "the child environment must not inherit provider credentials or MCP configuration");
  mkdirSync(path.join(base.directory, "appdata"), { recursive: true });
  mkdirSync(path.join(base.directory, "localappdata"), { recursive: true });
  mkdirSync(path.join(base.directory, "tmp"), { recursive: true });
  return env;
}

function writeFixtureConfiguration(base: Omit<FixtureBase, "provider" | "signal" | "sessionFile">, providerUrl: string, options: FixtureOptions): void {
  writeFileSync(path.join(base.agent, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    defaultThinkingLevel: "off",
    retry: options.retry === "provider-once"
      ? { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1, provider: { maxRetries: 1 } }
      : { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: {
      enabled: options.compactionEnabled ?? true,
      reserveTokens: options.reserveTokens ?? 1,
      keepRecentTokens: options.keepRecentTokens ?? 1,
    },
  }, null, 2), "utf8");
  writeFileSync(path.join(base.agent, "models.json"), JSON.stringify({ providers: {
    [fixtureProvider]: {
      api: "openai-completions",
      apiKey: fixtureKey,
      baseUrl: providerUrl,
      models: [{ id: "local", name: "Compact goals local", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  } }, null, 2), "utf8");
  writeFileSync(path.join(base.agent, "killeros.json"), JSON.stringify({
    autoCompaction: { enabled: true, percentRemaining: options.percentRemaining ?? 15 },
  }, null, 2), "utf8");
  writeFileSync(base.planFile, JSON.stringify({
    compactActions: options.compactActions ?? [],
    heldCompactions: options.heldCompactions ?? [],
  }) + "\n", "utf8");
  writeFileSync(base.probeFile, "", "utf8");
  writeFileSync(path.join(base.directory, "compact-goal-probe.mjs"), probeExtensionSource, "utf8");
}

function seedHistory(project: string, sessions: string, provider: string): string {
  const manager = SessionManager.create(project, sessions);
  manager.appendMessage({ role: "user", content: `Older saved work for native compaction. ${"Retain this verified context. ".repeat(100)}`, timestamp: Date.now() - 2_000 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The older verification is complete." }],
    api: "openai-completions",
    provider,
    model: "local",
    stopReason: "stop",
    timestamp: Date.now() - 1_000,
    usage: { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile), "seeded session must be durable before Pi starts");
  return sessionFile;
}

async function createBase(options: FixtureOptions, signal: AbortSignal): Promise<FixtureBase> {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const directory = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), `.killeros-compact-goals-${options.label}-`)));
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    assert.equal(existsSync(path.join(ancestor, ".git")), false, "Compaction fixtures must not discover an ancestor repository");
    if (path.dirname(ancestor) === ancestor) break;
  }
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  for (const child of [project, agent, sessions, path.join(directory, "tmp")]) mkdirSync(child);
  const planFile = path.join(directory, "plan.json");
  const probeFile = path.join(directory, "probe.jsonl");
  const faultModeFile = path.join(directory, "fault-mode.txt");
  const faultAttemptFile = path.join(directory, "fault-attempt.json");
  const provider = new LocalProvider();
  try {
    await provider.listen();
    const partial = { directory, project, agent, sessions, planFile, probeFile, faultModeFile, faultAttemptFile };
    writeFixtureConfiguration(partial, provider.url, options);
    const sessionFile = options.seedHistory === false ? SessionManager.create(project, sessions).getSessionFile() : seedHistory(project, sessions, fixtureProvider);
    assert.ok(sessionFile);
    return { ...partial, sessionFile, signal, provider };
  } catch (error) {
    try { await provider.close(); } catch (closeError) { throw new AggregateError([error, closeError], "fixture setup and provider cleanup failed"); }
    await removeDirectoryEventually(directory);
    throw error;
  }
}

function childArguments(base: FixtureBase, mode: Mode): string[] {
  return [
    ...(mode === "rpc" ? ["--mode", "rpc"] : []),
    "--model", `${fixtureProvider}/local`,
    "--thinking", "off",
    "--tools", "read,write,killeros_goal_update",
    "--session", base.sessionFile,
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
    "--extension", path.join(base.directory, "compact-goal-probe.mjs"),
  ];
}

async function startFixture(base: FixtureBase, mode: Mode): Promise<Fixture> {
  const env = isolatedEnvironment(base);
  if (mode === "rpc") {
    const rpc = new PiRpcProcess({ cliPath, cwd: base.project, env, args: childArguments(base, mode) });
    try {
      const fixture: RpcFixture = { ...base, kind: "rpc", rpc };
      const started = await waitForProbe(base.probeFile, (event) => event.type === "session_start", "RPC session_start", base.signal);
      assert.equal(started.mode, "rpc");
      assert.equal(base.provider.requests.length, 0, "Pi startup must not call the provider");
      assertIdle(await getState(fixture), "RPC startup");
      return fixture;
    } catch (error) {
      const errors: unknown[] = [error];
      try {
        assert.deepEqual(await rpc.close(), { exit: { code: 0, signal: null }, forced: false }, rpc.diagnostics());
      } catch (cleanupError) { errors.push(cleanupError); }
      throw new AggregateError(errors, "Compaction RPC startup failed");
    }
  }
  const terminal = new PiTerminalProcess({
    file: process.execPath,
    args: [cliPath, ...childArguments(base, mode)],
    cwd: base.project,
    env,
    cols: 110,
    rows: 34,
  });
  try {
    const fixture: TuiFixture = { ...base, kind: "tui", terminal };
    const started = await waitForProbe(base.probeFile, (event) => event.type === "session_start", "TUI session_start", base.signal);
    assert.equal(started.mode, "tui");
    await terminal.waitForScreen((screen) => screen.includes("❯"), { signal: base.signal, timeoutMs: waitTimeoutMs });
    assert.equal(base.provider.requests.length, 0, "TUI startup must not call the provider");
    return fixture;
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics());
    } catch (cleanupError) { errors.push(cleanupError); }
    throw new AggregateError(errors, "Compaction TUI startup failed");
  }
}

async function closeFixture(fixture: Fixture): Promise<void> {
  const errors: unknown[] = [];
  fixture.provider.releaseAll();
  try {
    if (fixture.kind === "rpc") {
      assert.deepEqual(await fixture.rpc.close(), { exit: { code: 0, signal: null }, forced: false }, fixture.rpc.diagnostics());
    } else {
      assert.deepEqual(await fixture.terminal.close(), { code: 0, forced: false }, fixture.terminal.diagnostics());
    }
  } catch (error) { errors.push(error); }
  try { await fixture.provider.close(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "Compaction fixture cleanup failed");
}

async function runHistory(
  scenarioId: string,
  options: FixtureOptions,
  t: TestContext,
  action: (fixture: Fixture) => Promise<void>,
): Promise<HistoryResult> {
  let base: FixtureBase | undefined;
  let fixture: Fixture | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let naturalExit = false;
  let scratchRemoved = false;
  try {
    base = await createBase(options, t.signal);
    fixture = await startFixture(base, options.mode);
    await action(fixture);
  } catch (error) {
    primaryError = error;
  } finally {
    if (fixture) {
      try {
        await releasePlannedSummaryGates(fixture, options.heldCompactions ?? []);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await closeFixture(fixture);
        naturalExit = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (base) {
      try { await base.provider.close(); } catch (error) { cleanupErrors.push(error); }
    }
    // Snapshot owned evidence before the scratch directory disappears; bound arrays, not serialized bytes.
    const providerRequests = base
      ? base.provider.requests.slice(0, 40).map((request) => ({ index: request.index, model: request.body.model,
        roles: Array.isArray(request.body.messages) ? request.body.messages.map((message) => record(message, "request message").role) : [] }))
      : [];
    const providerFaults = base?.provider.faults.slice(0, 8) ?? [];
    let probeEventsSnapshot: ProbeEvent[] = [];
    try {
      probeEventsSnapshot = base ? readProbeEvents(base.probeFile).slice(-120) : [];
    } catch (error) {
      probeEventsSnapshot = [{ sequence: 0, type: "probe-read-failed", detail: errorText(error) }];
    }
    if (primaryError !== undefined || cleanupErrors.length > 0) {
      const details = {
        scenarioId,
        label: options.label,
        node: process.version,
        mode: options.mode,
        providerRequests,
        providerFaults,
        probeEvents: probeEventsSnapshot,
        process: fixture ? boundedDiagnostics(fixture) : "",
        cleanupErrors: cleanupErrors.map(errorText),
      };
      try {
        mkdirSync(reportsRoot, { recursive: true });
        const report = path.join(reportsRoot, `failure-${scenarioId}-${process.pid}-${Date.now()}.json`);
        writeFileSync(report, JSON.stringify(details, null, 2), "utf8");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (base) {
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
    const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
    throw new AggregateError(errors, `${scenarioId}/${options.label} failed or did not clean up naturally`);
  }
  assert.ok(fixture && base);
  assert.equal(naturalExit, true);
  assert.equal(scratchRemoved, true);
  assert.deepEqual(base.provider.faults, []);
  return { scenarioId, label: options.label, piLaunches: 1, providerRequests: base.provider.requests.length, naturalExit, scratchRemoved };
}

async function rpcCommand(fixture: RpcFixture, type: string, fields: PiRpcRecord = {}): Promise<PiRpcRecord> {
  return await fixture.rpc.command(type, fields, { timeoutMs: waitTimeoutMs, signal: fixture.signal });
}

async function getState(fixture: RpcFixture): Promise<Json> {
  return record((await rpcCommand(fixture, "get_state")).data, "RPC state");
}

function assertSettledState(state: Json, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: no active stream`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no queued messages`);
}

function assertIdle(state: Json, label: string): void {
  assertSettledState(state, label);
  assert.equal(state.isCompacting, false, `${label}: no compaction remains active`);
}

async function prompt(fixture: Fixture, message: string): Promise<number> {
  if (fixture.kind === "rpc") {
    const after = fixture.rpc.currentSequence;
    const response = await rpcCommand(fixture, "prompt", { message });
    const disposition = record(response.data, `${message} response`).disposition;
    assert.equal(disposition, message.startsWith("/") ? "handled" : "started", message);
    return after;
  }
  const after = fixture.terminal.sequence;
  await fixture.terminal.submitEditorText(message, { signal: fixture.signal });
  return after;
}

/** Continuing workflows prove the follow-on request separately; only their final boundary must stay idle. */
async function settle(fixture: Fixture, afterProbe: number, count = 1, label = "agent settlement",
  currentState: "idle" | "continuing" = "idle"): Promise<ProbeEvent[]> {
  const result: ProbeEvent[] = [];
  let cursor = afterProbe;
  for (let index = 0; index < count; index += 1) {
    const event = await waitForProbe(fixture.probeFile, (candidate) => candidate.type === "agent_settled", label, fixture.signal, cursor);
    assert.equal(event.idle, true, `${label}: Pi reports idle at settlement`);
    assert.equal(event.pending, false, `${label}: Pi reports an empty follow-up queue`);
    result.push(event);
    cursor = event.sequence;
  }
  if (fixture.kind === "rpc" && currentState === "idle") assertSettledState(await getState(fixture), label);
  return result;
}

async function waitForProvider(fixture: Fixture, count: number): Promise<ProviderRequest> {
  return await fixture.provider.waitForRequest(count, fixture.signal);
}

function probeEvents(fixture: Fixture): ProbeEvent[] {
  return readProbeEvents(fixture.probeFile);
}

function countProbe(fixture: Fixture, type: string): number {
  return probeEvents(fixture).filter((event) => event.type === type).length;
}

function entries(fixture: Fixture): Json[] {
  return SessionManager.open(fixture.sessionFile).getBranch().map((entry) => record(entry, "saved session entry"));
}

function goalStates(fixture: Fixture): Json[] {
  return entries(fixture).flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal entry data");
    return [record(data.state, "saved goal state")];
  });
}

function last<T>(values: readonly T[], label: string): T {
  const value = values.at(-1);
  assert.ok(value, `${label}: expected a saved value`);
  return value;
}

function countMessages(fixture: Fixture, customType: string): number {
  return probeEvents(fixture).filter((event) => event.type === "message_start"
    && event.role === "custom" && event.customType === customType).length;
}

function compactionEntries(fixture: Fixture): Json[] {
  return entries(fixture).filter((entry) => entry.type === "compaction");
}

function assertGoalToolDeclared(request: ProviderRequest, expected: boolean): void {
  const tools = records(request.body.tools, "provider tools");
  assert.equal(tools.some((tool) => record(tool.function, "provider tool function").name === "killeros_goal_update"), expected);
}

/** Parses child diagnostics when structured so a large payload stays valid JSON, never a byte slice. */
function boundedDiagnostics(fixture: Fixture): Json | string {
  const text = fixture.kind === "rpc" ? fixture.rpc.diagnostics() : fixture.terminal.diagnostics();
  if (text.length <= 20_000) return text;
  try { return record(JSON.parse(text), "child diagnostics"); } catch { return text.slice(0, 4_000); }
}

function assertFaultBelongsToChild(fixture: RpcFixture, attempt: Json): void {
  const diagnostics = record(JSON.parse(fixture.rpc.diagnostics()), "Pi RPC diagnostics");
  assert.equal(numberField(attempt, "pid"), numberField(diagnostics, "pid"),
    "the append fault acknowledgment must identify this owned Pi child");
}

function acknowledgeRpc(fixture: RpcFixture): void {
  fixture.rpc.acknowledge(fixture.rpc.currentSequence);
  assert.equal(fixture.rpc.retainedRecordCount, 0, "completed protocol records are acknowledged at each stable boundary");
}

async function releaseSummary(fixture: Fixture, index: number): Promise<void> {
  const token = `summary-${index}`;
  const gate = path.join(fixture.directory, `${token}.release`);
  const temporary = `${gate}.${process.pid}.tmp`;
  writeFileSync(temporary, token + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(temporary, gate);
}

/** Releases every planned summary gate so a failed history waits out no held compaction barrier. */
async function releasePlannedSummaryGates(fixture: Fixture, heldCompactions: readonly number[]): Promise<void> {
  for (const index of new Set(heldCompactions)) {
    if (existsSync(path.join(fixture.directory, `summary-${index}.release`))) continue;
    await releaseSummary(fixture, index);
  }
}

async function waitForCompaction(fixture: Fixture, index: number, label: string): Promise<ProbeEvent> {
  return await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact" && event.index === index,
    label, fixture.signal);
}

function setGoalFaultMode(fixture: Fixture, mode: "deny-next" | "allow-one-then-deny" | "off"): void {
  if (mode === "off") {
    if (existsSync(fixture.faultModeFile)) writeFileSync(fixture.faultModeFile, "", "utf8");
    return;
  }
  writeFileSync(fixture.faultModeFile, mode + "\n", "utf8");
}

async function awaitRpcNotification(fixture: RpcFixture, after: number, text: RegExp): Promise<PiRpcRecord> {
  return await fixture.rpc.waitFor((event) => event.type === "extension_ui_request" && event.method === "notify"
    && typeof event.message === "string" && text.test(event.message), { after, timeoutMs: waitTimeoutMs, signal: fixture.signal });
}

/** Collects native notices until settlement and idle state have been acknowledged. */
function observeRpcErrors(fixture: RpcFixture): () => PiRpcRecord[] {
  const errors: PiRpcRecord[] = [];
  const controller = new AbortController();
  let observationFailure: Error | undefined;
  void fixture.rpc.waitFor((event) => {
    if (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error") errors.push(event);
    return false;
  }, { after: fixture.rpc.currentSequence, signal: controller.signal }).catch((error: unknown) => {
    if (!controller.signal.aborted) observationFailure = error instanceof Error ? error : new Error(String(error));
  });
  return () => {
    controller.abort();
    if (observationFailure !== undefined) throw observationFailure;
    return errors;
  };
}

async function answerGoalConfirmation(fixture: RpcFixture, message: string, afterConfirmation: () => Promise<void>): Promise<void> {
  const after = fixture.rpc.currentSequence;
  const command = rpcCommand(fixture, "prompt", { message });
  const confirmation = await fixture.rpc.waitFor((event) => event.type === "extension_ui_request" && event.method === "confirm",
    { after, timeoutMs: waitTimeoutMs, signal: fixture.signal });
  const id = stringField(confirmation, "id");
  await fixture.rpc.send({ type: "extension_ui_response", id, confirmed: true });
  await afterConfirmation();
  const response = await command;
  assert.equal(record(response.data, "goal replacement response").disposition, "handled");
}

function goalDecision(status: "continue" | "complete" | "blocked", turn: number): Json {
  return {
    status,
    evidence: `Audited acceptance vector ${turn}.`,
    ...(status === "continue" ? { nextAction: `Run authorized step ${turn + 1}.` } : {}),
    ...(status === "blocked" ? { blockerKey: "missing-prerequisite" } : {}),
  };
}

function seedActiveGoalSession(base: FixtureBase, label: string, maxTurns: number): string {
  const manager = SessionManager.create(base.project, base.sessions);
  manager.appendMessage({ role: "user", content: `Saved history for ${label}.`, timestamp: Date.now() - 1_000 });
  const now = Date.now();
  manager.appendCustomEntry("killeros-goal", { version: 1, event: "set", state: {
    version: 1, revision: 1, objective: `Exercise ${label}.`, status: "active", createdAt: now - 2_000,
    updatedAt: now - 1_000, activeMilliseconds: 0, activeStartedAt: now - 1_000, turns: 0, blockedAuditStartTurn: 0,
    baselineTokens: 0, maxTurns, turnPhase: "ready",
  } });
  const file = manager.getSessionFile();
  assert.ok(file && existsSync(file));
  return file;
}

async function switchRpcSession(fixture: RpcFixture, sessionFile: string): Promise<void> {
  const response = await rpcCommand(fixture, "switch_session", { sessionPath: sessionFile });
  assert.equal(record(response.data, "switch_session response").cancelled, false);
  fixture.sessionFile = sessionFile;
  const state = await getState(fixture);
  assert.equal(path.resolve(stringField(state, "sessionFile")), path.resolve(sessionFile));
  assert.equal(state.pendingMessageCount, 0, "session restoration has no queued ordinary messages");
}

// Catalog ID: compaction-goal-recovery.
test("Automatic compaction pauses a goal and resumes the same or next turn exactly once", { timeout: 600_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  const observedCompletionOrders: string[] = [];

  histories.push(await runHistory("compaction-goal-recovery", {
    mode: "rpc", label: "same-turn-rpc-exact-abort-error-100-percent-rearm", percentRemaining: 100,
    compactActions: ["custom", "custom"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    const writtenFile = path.join(fixture.project, "same-turn-tool-result.txt");
    const writtenContent = "The public write tool completed before compaction interrupted the loop.";
    const recoveryResponseBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "write", filePath: writtenFile, content: writtenContent, usageTokens: 90_000 });
    fixture.provider.enqueue({ kind: "held", barrier: recoveryResponseBarrier,
      response: { kind: "text", content: "The low-usage same-turn recovery stops without a new decision.", usageTokens: 0 } });

    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "/goal Verify one same-turn recovery after automatic compaction.");
    const initial = await waitForProvider(fixture, 1);
    assertGoalToolDeclared(initial, true);
    assert.ok(records(initial.body.tools, "provider tools").some((tool) =>
      record(tool.function, "provider tool function").name === "write"), "the real request declares the public write tool");
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 1,
      "same-turn compaction preparation after tool use", fixture.signal, before);
    assert.equal(readFileSync(writtenFile, "utf8"), writtenContent, "Pi executed the public tool before compaction");
    const [settlements, compacted] = await Promise.all([
      settle(fixture, before, 1, "same-turn interrupted request settlement", "continuing"),
      waitForCompaction(fixture, 1, "first native compaction completion"),
    ]);
    const firstSettlement = last(settlements, "first same-turn settlement");
    observedCompletionOrders.push(compacted.sequence < firstSettlement.sequence
      ? "same-turn-rpc:compaction-before-settlement"
      : "same-turn-rpc:settlement-before-compaction");
    const interrupted = last(probeEvents(fixture).filter((event) => event.type === "agent_end"), "interrupted agent_end");
    assert.equal(interrupted.stopReason, "aborted", "Pi classifies the interrupted request as aborted");
    assert.equal(interrupted.errorMessage, "This operation was aborted",
      "only the exact native abort error qualifies here, not an arbitrary provider error");
    assert.equal(firstSettlement.aborted, true, "Pi confirms the interrupted request was aborted at settlement");
    const interruptedPause = goalStates(fixture).find((state) => state.status === "paused");
    assert.ok(interruptedPause, "the interrupted turn durably pauses before recovery");
    assert.equal(interruptedPause.turns, 1);

    const recoveryBarrier = Math.max(compacted.sequence, firstSettlement.sequence);
    const recovery = await waitForProvider(fixture, 2);
    const resumedMessage = probeEvents(fixture).find((event) => event.sequence > recoveryBarrier
      && event.type === "message_start" && event.role === "custom"
      && event.customType === "killeros-goal-continuation");
    assert.ok(resumedMessage, "the goal resumes only after both the interrupted run and compaction complete");
    assert.match(JSON.stringify(recovery.body.messages), /Verify one same-turn recovery/u);
    assert.equal(last(goalStates(fixture), "same-turn recovered goal").status, "active");
    assert.equal(last(goalStates(fixture), "same-turn recovered goal").turns, 1,
      "same-turn recovery keeps the saved logical turn unchanged before its response");
    const sameTurnStatuses = goalStates(fixture).map((state) => stringField(state, "status"));
    const firstPause = sameTurnStatuses.indexOf("paused");
    assert.ok(firstPause >= 0 && sameTurnStatuses.indexOf("active", firstPause + 1) >= 0,
      "the saved goal returns to active only after the interrupted turn settles and compaction completes");
    try {
      assert.ok(resumedMessage.sequence > recoveryBarrier);
      assert.equal(countMessages(fixture, "killeros-goal-continuation"), 2,
        "one same-turn recovery follows the initial authorization");
    } finally {
      recoveryResponseBarrier.release();
    }
    const [recoverySettlements, rearmedStart] = await Promise.all([
      settle(fixture, resumedMessage.sequence, 1, "same-turn low-usage recovery settlement"),
      waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 2,
        "100 percent rearmed compaction", fixture.signal, resumedMessage.sequence),
    ]);
    const rearmedCompact = await waitForCompaction(fixture, 2, "second native compaction completion");
    assert.ok(rearmedStart.sequence < rearmedCompact.sequence);
    assert.ok(recoverySettlements[0]);
    assertIdle(await getState(fixture), "after 100 percent rearm recovery");
    const finalGoal = last(goalStates(fixture), "final same-turn goal");
    assert.equal(finalGoal.turns, 1, "same-turn recovery does not grant a logical turn");
    assert.equal(finalGoal.status, "paused", "a normal stop without a decision remains paused after recovery");
    assert.equal(finalGoal.result, "no turn decision");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 2, "initial authorization plus exactly one same-turn recovery");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0, "goal-owned compaction never emits ordinary recovery");
    assert.equal(compactionEntries(fixture).length, 2, "100 percent rearm adds one bounded compaction without another recovery loop");
    assert.equal(fixture.provider.requests.length, 2);
    assert.equal(fixture.provider.remainingPlans, 0);
    if (fixture.kind === "rpc") acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-recovery", {
    mode: "tui", label: "next-turn-tui-15-percent", percentRemaining: 15,
    compactActions: ["custom"], heldCompactions: [1],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "tui");
    const nextTurnResponseBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "goal", decision: goalDecision("continue", 1), usageTokens: 20_000 });
    fixture.provider.enqueue({ kind: "text", content: "The accepted first step reached compaction.", usageTokens: 90_000 });
    fixture.provider.enqueue({ kind: "held", barrier: nextTurnResponseBarrier,
      response: { kind: "text", content: "The authorized next logical turn completed without another decision.", usageTokens: 0 } });

    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "/goal Continue the same saved objective after compaction.");
    const decision = await waitForProvider(fixture, 1);
    assertGoalToolDeclared(decision, true);
    assert.match(JSON.stringify(decision.body.messages), /Continue the same saved objective/u);
    await waitForProvider(fixture, 2);
    const summary = await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 1,
      "held TUI goal summary", fixture.signal, before);
    const acceptedSettlement = last(
      await settle(fixture, before, 1, "accepted goal request settlement before summary release"),
      "accepted goal request settlement");
    assert.equal(last(goalStates(fixture), "paused accepted goal").status, "paused");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    await releaseSummary(fixture, 1);
    const completed = await waitForCompaction(fixture, 1, "held TUI summary completion");
    assert.ok(summary.sequence < completed.sequence);
    assert.ok(acceptedSettlement.sequence < completed.sequence);
    observedCompletionOrders.push("next-turn-tui:settlement-before-compaction");
    const resumed = await waitForProvider(fixture, 3);
    assert.match(JSON.stringify(resumed.body.messages), /Run authorized step 2/u);
    assert.equal(last(goalStates(fixture), "next-turn recovered goal").status, "active");
    const nextTurnStatuses = goalStates(fixture).map((state) => stringField(state, "status"));
    const pausedIndex = nextTurnStatuses.indexOf("paused");
    assert.ok(pausedIndex >= 0 && nextTurnStatuses.indexOf("active", pausedIndex + 1) >= 0,
      "the accepted next turn is persisted active after compaction completes");
    nextTurnResponseBarrier.release();
    await settle(fixture, completed.sequence, 1, "authorized next-turn settlement");
    const finalGoal = last(goalStates(fixture), "next-turn goal");
    assert.equal(finalGoal.turns, 2);
    assert.equal(finalGoal.status, "paused");
    assert.equal(finalGoal.result, "no turn decision");
    assert.deepEqual(finalGoal.lastDecision, { kind: "continue", turn: 1, evidence: "Audited acceptance vector 1.", nextAction: "Run authorized step 2." });
    assert.equal(finalGoal.turnDecision, undefined);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 2, "one accepted next turn follows the same objective exactly once");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(compactionEntries(fixture).length, 1);
    assert.equal(fixture.provider.requests.length, 3);
    assert.equal(fixture.provider.remainingPlans, 0);
  }));

  assert.deepEqual(histories.map(({ providerRequests }) => providerRequests), [2, 3]);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-recovery", histories,
    assertedDomains: { goal: ["same-turn", "next-turn"], decision: ["none", "continue"],
      ordering: observedCompletionOrders, threshold: [100, 15] } }));
});

// Catalog ID: compaction-goal-terminal-limit.
test("Terminal goals preserve ownership across later ordinary compaction", { timeout: 90_000 }, async (t) => {
  const histories: HistoryResult[] = [];

  for (const status of ["complete", "blocked"] as const) {
    for (const mode of ["tui", "rpc"] as const) {
      const label = `${status}-${mode}-${mode === "tui" ? "unheld-native-order" : "held-after-settlement"}`;
      histories.push(await runHistory("compaction-goal-terminal-limit", {
        mode, label, percentRemaining: 15, compactActions: ["custom", "custom", "custom"],
        ...(mode === "tui" ? {} : { heldCompactions: [1] }),
      }, t, async (fixture) => {
        const turns = status === "blocked" ? 3 : 1;
        const stopErrors = fixture.kind === "rpc" ? observeRpcErrors(fixture) : undefined;
        for (let turn = 1; turn <= turns; turn += 1) {
          fixture.provider.enqueue({ kind: "goal", decision: goalDecision(status, turn), usageTokens: turn === turns ? 80_000 : 10_000 });
          fixture.provider.enqueue({ kind: "text", content: `Terminal decision ${turn} was saved.`, usageTokens: turn === turns ? 90_000 : 10_000 });
        }
        fixture.provider.enqueue({ kind: "text", content: "A low-usage ordinary request rearms the compaction threshold.", usageTokens: 0 });
        fixture.provider.enqueue({ kind: "text", content: "An unrelated task starts ordinary compaction.", usageTokens: 90_000 });
        fixture.provider.enqueue({ kind: "text", content: "The ordinary continuation finished.", usageTokens: 0 });
        const forbiddenWrite = path.join(fixture.directory, "unauthorized-continuation.txt");
        if (status === "blocked") {
          fixture.provider.enqueue({ kind: "goal", decision: goalDecision("complete", 4), usageTokens: 10_000 });
          fixture.provider.enqueue({ kind: "text", content: "The later ordinary request completed the blocked goal.", usageTokens: 90_000 });
        }
        fixture.provider.enqueue({ kind: "write", filePath: forbiddenWrite, content: "Unauthorized terminal-goal restart" });

        const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
        await prompt(fixture, `/goal Stop after the ${status} decision.`);
        let terminalSettlementSequence = 0;
        for (let turn = 1; turn <= turns; turn += 1) {
          const decision = await waitForProvider(fixture, (turn - 1) * 2 + 1);
          assertGoalToolDeclared(decision, true);
          await waitForProvider(fixture, turn * 2);
          const settlements = await settle(fixture, before, turn, `${status} goal turn ${turn} settlement`,
            turn < turns ? "continuing" : "idle");
          terminalSettlementSequence = last(settlements, `${status} goal turn ${turn} settlement`).sequence;
        }
        const compactStarted = await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 1,
          `${status} terminal compaction`, fixture.signal, before);
        if (mode === "rpc") {
          const rpc = fixture;
          assert.equal(rpc.kind, "rpc");
          await releaseSummary(rpc, 1);
        }
        const terminalCompaction = await waitForCompaction(fixture, 1, `${status} terminal compaction complete`);
        if (mode === "rpc") {
          assert.ok(terminalSettlementSequence < terminalCompaction.sequence,
            "the held RPC summary completes after the terminal goal settles");
        } else {
          assert.ok(compactStarted.sequence < terminalCompaction.sequence,
            "the unheld TUI summary must finish its observed native preparation");
          t.diagnostic(JSON.stringify({ label, terminalSettlementSequence, compactionSequence: terminalCompaction.sequence,
            ordering: terminalCompaction.sequence < terminalSettlementSequence ? "before-settlement" : "after-settlement",
            beforeSettlementReplacementGate: "pending public-order reachability review" }));
        }
        let terminal = last(goalStates(fixture), `${status} terminal goal`);
        assert.equal(terminal.status, status);
        assert.equal(terminal.turns, turns, "compaction does not add terminal goal turns");
        assert.equal(countMessages(fixture, "killeros-goal-continuation"), turns);
        assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
        assert.equal(existsSync(forbiddenWrite), false, "an unrequested terminal restart must not reach the write tool");
        if (stopErrors) assert.deepEqual(stopErrors(), [], "successful terminal compaction emits no error notice");
        else {
          assert.equal(fixture.kind, "tui");
          assert.doesNotMatch(fixture.terminal.screen(), /Automatic compaction failed:|Goal paused:.*compaction/u);
        }

        const resetCursor = probeEvents(fixture).at(-1)?.sequence ?? 0;
        await prompt(fixture, "Check the compacted context at low usage before the unrelated task.");
        await waitForProvider(fixture, turns * 2 + 1);
        await settle(fixture, resetCursor, 1, "low-usage threshold rearm settlement");
        assert.equal(countProbe(fixture, "session_before_compact"), 1, "low usage rearms without compacting");
        const later = await prompt(fixture, "Work on an unrelated task after the terminal goal.");
        await waitForProvider(fixture, turns * 2 + 2);
        const ordinaryCompact = await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 2,
          "later ordinary compaction", fixture.signal, compactStarted.sequence);
        if (mode === "rpc") await releaseSummary(fixture, 2);
        await waitForCompaction(fixture, 2, "later ordinary compaction completion");
        await waitForProvider(fixture, turns * 2 + 3);
        await settle(fixture, ordinaryCompact.sequence, 1, "ordinary compaction continuation settlement");
        terminal = last(goalStates(fixture), "terminal goal after unrelated request");
        assert.equal(terminal.status, status);
        assert.equal(terminal.turns, turns);
        assert.equal(countMessages(fixture, "killeros-goal-continuation"), turns);
        assert.equal(countMessages(fixture, "killeros-auto-compaction"), 1, "only unrelated work receives ordinary compaction recovery");
        assert.equal(fixture.provider.requests.length, turns * 2 + 3);
        assert.equal(fixture.provider.remainingPlans, status === "blocked" ? 3 : 1,
          "completion controls and the armed write response remain unused until the explicit later request");
        assert.equal(existsSync(forbiddenWrite), false);
        if (status === "blocked") {
          const beforeCompletion = probeEvents(fixture).at(-1)?.sequence ?? 0;
          await prompt(fixture, "The prerequisite is resolved. Complete the original blocked objective.");
          const completionRequest = await waitForProvider(fixture, turns * 2 + 4);
          assertGoalToolDeclared(completionRequest, true);
          assert.match(JSON.stringify(completionRequest.body.messages), /Blocked KillerOS goal/u);
          await waitForProvider(fixture, turns * 2 + 5);
          await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 3,
            "later blocked completion compaction", fixture.signal, beforeCompletion);
          await waitForCompaction(fixture, 3, "blocked completion compaction");
          await settle(fixture, beforeCompletion, 1, "blocked completion settlement");
          const completed = last(goalStates(fixture), "blocked goal after later ordinary completion");
          assert.equal(completed.status, "complete");
          assert.equal(completed.turns, turns, "blocked completion grants no additional goal turn");
          assert.deepEqual(completed.verification, terminal.verification, "Blocked completion retains the original proof contract");
          assert.equal(completed.activeMilliseconds, terminal.activeMilliseconds, "Blocked completion grants no goal runtime");
          assert.equal(countMessages(fixture, "killeros-goal-continuation"), turns);
          assert.equal(countMessages(fixture, "killeros-auto-compaction"), 1,
            "blocked completion does not inherit the unrelated request's continuation");
          assert.equal(fixture.provider.requests.length, turns * 2 + 5);
          assert.equal(fixture.provider.remainingPlans, 1);
          assert.equal(existsSync(forbiddenWrite), false, "blocked completion cannot restart the terminal goal");
        }
        if (fixture.kind === "rpc") {
          assertIdle(await getState(fixture), "terminal and ordinary compaction workflow");
          acknowledgeRpc(fixture);
        }
        if (fixture.kind === "tui") {
          assert.ok(compactStarted.sequence > before);
          assert.ok(fixture.terminal.screen().includes("❯"), "native TUI returns to its prompt after compaction");
        }
        assert.ok(later >= 0);
      }));
    }
  }

  assert.equal(histories.length, 4);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-terminal-limit", histories }));
});

test("Decisionless goals remain paused after successful or too-small compaction", { timeout: 60_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  histories.push(await runHistory("compaction-goal-decisionless", {
    mode: "rpc", label: "decisionless-completed", percentRemaining: 100, compactActions: ["custom"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "text", content: "The model stops without a goal decision.", usageTokens: 80_000 });
    await prompt(fixture, "/goal Pause when there is no accepted decision.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await settle(fixture, before, 1, "decisionless normal stop");
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "decisionless completed compaction", fixture.signal, before);
    await waitForCompaction(fixture, 1, "decisionless successful compaction");
    const state = last(goalStates(fixture), "decisionless successful terminal state");
    assert.equal(state.status, "paused");
    assert.equal(state.result, "no turn decision");
    assert.equal(state.turns, 1);
    assert.equal(state.maxTurns, 20);
    assert.equal(state.turnDecision, undefined);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(compactionEntries(fixture).length, 1);
    assert.equal(fixture.provider.requests.length, 1);
    assertIdle(await getState(fixture), "decisionless completed compaction");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-decisionless", {
    mode: "rpc", label: "decisionless-native-too-small", percentRemaining: 100, keepRecentTokens: 100_000,
    seedHistory: false, compactActions: [],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "text", content: "The naturally small session cannot be compacted.", usageTokens: 50_000 });
    await prompt(fixture, "/goal Pause without an accepted decision on an exact native skip.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await settle(fixture, before, 1, "native too-small decisionless settlement");
    const failure = await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed", "native exact too-small error", fixture.signal, before);
    assert.match(stringField(failure, "errorMessage"), /Nothing to compact \(session too small\)/u);
    const state = last(goalStates(fixture), "decisionless exact-skip state");
    assert.equal(state.status, "paused");
    assert.equal(state.result, "no turn decision");
    assert.equal(state.turns, 1);
    assert.equal(state.maxTurns, 20);
    assert.equal(state.turnDecision, undefined);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(countProbe(fixture, "session_before_compact"), 0, "native too-small preparation fails before the public summary hook");
    assert.equal(compactionEntries(fixture).length, 0);
    assert.equal(fixture.provider.requests.length, 1);
    assertIdle(await getState(fixture), "decisionless native skip");
    acknowledgeRpc(fixture);
  }));

  assert.equal(histories.length, 2);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-decisionless", histories }));
});

test("Native threshold and overflow retries grant no goal decision", { timeout: 60_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  histories.push(await runHistory("compaction-goal-native-overflow", {
    mode: "rpc", label: "native-threshold-and-overflow", percentRemaining: 1, reserveTokens: 20_000,
    compactionEnabled: true, compactActions: ["custom", "provider", "custom", "custom", "custom"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "text", content: "Native reserve threshold leaves the goal decisionless.", usageTokens: 85_000 });
    fixture.provider.enqueue({ kind: "text", content: "The next accepted user request exercises a failing threshold summary.", usageTokens: 85_000 });
    fixture.provider.enqueue({ kind: "error", status: 503, message: "threshold summary unavailable" });
    await prompt(fixture, "/goal Pause after the Pi reserve threshold without a decision.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await settle(fixture, before, 1, "native threshold goal settlement");
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "reserve threshold compaction", fixture.signal, before);
    await waitForCompaction(fixture, 1, "native reserve threshold compaction");
    assert.equal(last(goalStates(fixture), "threshold paused goal").status, "paused");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);

    const resumeCursor = await prompt(fixture, "/goal resume");
    await waitForProvider(fixture, 2);
    const failure = await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed", "failed native threshold summary", fixture.signal);
    await settle(fixture, failure.sequence, 1, "failed threshold compaction settlement");
    assert.match(stringField(failure, "errorMessage"), /threshold summary unavailable/u);
    assert.equal(last(goalStates(fixture), "failed-threshold goal").status, "paused");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 2, "explicit resume is the only added goal authorization");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.ok(resumeCursor >= 0);
    assertIdle(await getState(fixture), "failed native threshold compaction");

    fixture.provider.enqueue({ kind: "error", status: 400, message: "context length exceeded", errorType: "context_length_exceeded" });
    fixture.provider.enqueue({ kind: "text", content: "Pi retried after overflow compaction without a goal decision.", usageTokens: 0 });
    const overflowBefore = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "/goal resume");
    const overflowRequest = await waitForProvider(fixture, 4);
    assertGoalToolDeclared(overflowRequest, true);
    const overflowCompaction = await waitForProbe(fixture.probeFile,
      (event) => event.type === "session_before_compact" && event.reason === "overflow",
      "native context-overflow compaction", fixture.signal, overflowBefore);
    const preflight = probeEvents(fixture).find((event) => event.type === "session_before_compact" && event.index === 3);
    assert.ok(preflight, "Pi retries the previously failed threshold summary before dispatching the resumed request");
    assert.equal(preflight.reason, "threshold");
    await waitForCompaction(fixture, 3, "native preflight threshold recovery");
    assert.equal(overflowCompaction.index, 4);
    await waitForCompaction(fixture, 4, "native overflow summary completion");
    await waitForProvider(fixture, 5);
    await settle(fixture, overflowBefore, 1, "decisionless provider retry after overflow compaction");
    const afterOverflowRetry = last(goalStates(fixture), "goal after context-overflow retry");
    assert.equal(afterOverflowRetry.status, "paused");
    assert.equal(afterOverflowRetry.result, "no turn decision");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 3,
      "overflow retry does not grant an additional logical goal turn");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);

    fixture.provider.enqueue({ kind: "error", status: 400, message: "context length exceeded", errorType: "context_length_exceeded" });
    fixture.provider.enqueue({ kind: "error", status: 400, message: "context length exceeded again", errorType: "context_length_exceeded" });
    const unrecoveredBefore = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "/goal resume");
    await waitForProvider(fixture, 6);
    const retryCompaction = await waitForProbe(fixture.probeFile,
      (event) => event.type === "session_before_compact" && event.reason === "overflow",
      "second native context-overflow compaction", fixture.signal, unrecoveredBefore);
    assert.equal(retryCompaction.index, 5);
    await waitForCompaction(fixture, 5, "second overflow summary completion");
    await waitForProvider(fixture, 7);
    await settle(fixture, unrecoveredBefore, 1, "unrecovered context-overflow settlement");
    const unrecovered = last(goalStates(fixture), "goal after unrecovered context overflow");
    assert.equal(unrecovered.status, "paused");
    assert.match(String(unrecovered.result), /context length exceeded again/u);
    assert.equal(unrecovered.resumeAfterManualCompaction, undefined,
      "an ordinary provider failure must not grant manual recovery eligibility");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 4,
      "the explicit resume is the only new goal authorization after unrecovered overflow");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(compactionEntries(fixture).length, 4,
      "the initial summary, preflight threshold recovery, and two overflow summaries complete; the failed summary does not");
    assertIdle(await getState(fixture), "recovered and unrecovered overflow compaction");
    assert.equal(fixture.provider.requests.length, 7,
      "the workflow uses one initial request, one explicit-resume failure, one compaction-provider failure, and two overflow/retry pairs");
    acknowledgeRpc(fixture);
  }));

  assert.equal(histories.length, 1);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-native-overflow", histories }));
});

test("Compaction preserves accepted twenty-turn and restored one-turn limits", { timeout: 60_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  histories.push(await runHistory("compaction-goal-saved-turn-limit", {
    mode: "rpc", label: "saved-turn-budget", percentRemaining: 15, compactActions: ["custom"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    for (let turn = 1; turn <= 20; turn += 1) {
      fixture.provider.enqueue({ kind: "goal", decision: goalDecision("continue", turn), usageTokens: 10_000 });
      fixture.provider.enqueue({ kind: "text", content: `Authorized goal turn ${turn} finished.`, usageTokens: turn === 20 ? 90_000 : 10_000 });
    }
    await prompt(fixture, "/goal Reach the saved twenty-turn limit through accepted decisions.");
    for (let turn = 1; turn <= 20; turn += 1) {
      const decision = await waitForProvider(fixture, (turn - 1) * 2 + 1);
      assertGoalToolDeclared(decision, true);
      await waitForProvider(fixture, turn * 2);
      const settlements = probeEvents(fixture).filter((event) => event.type === "agent_settled").length;
      await settle(fixture, 0, settlements < turn ? turn - settlements : 0, `accepted goal turns through ${turn}`,
        turn < 20 ? "continuing" : "idle");
      if (turn < 20) acknowledgeRpc(fixture);
    }
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "turn twenty compaction", fixture.signal);
    await waitForCompaction(fixture, 1, "turn twenty compaction completion");
    const state = last(goalStates(fixture), "twenty-turn saved goal");
    assert.equal(state.status, "paused");
    assert.equal(state.turns, 20);
    assert.equal(state.maxTurns, 20);
    assert.equal(state.result, "Turn limit reached (20/20).");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 20, "there is no twenty-first logical goal turn");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(fixture.provider.requests.length, 40);
    assert.equal(fixture.provider.remainingPlans, 0);

    const oneTurnSession = seedActiveGoalSession(fixture, "restored maxTurns=1 limit", 1);
    fixture.provider.enqueue({ kind: "goal", decision: goalDecision("continue", 1), usageTokens: 10_000 });
    fixture.provider.enqueue({ kind: "text", content: "The restored one-turn budget is reached.", usageTokens: 10_000 });
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await switchRpcSession(fixture, oneTurnSession);
    await waitForProvider(fixture, 41);
    await waitForProvider(fixture, 42);
    await settle(fixture, before, 1, "restored maxTurns=1 settlement");
    const restored = last(goalStates(fixture), "restored one-turn state");
    assert.equal(restored.status, "paused");
    assert.equal(restored.turns, 1);
    assert.equal(restored.maxTurns, 1);
    assert.equal(restored.result, "Turn limit reached (1/1).");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 21);
    assert.equal(fixture.provider.requests.length, 42, "the restored limit starts no second turn");
    assertIdle(await getState(fixture), "restored one-turn limit");
    acknowledgeRpc(fixture);
  }));

  assert.equal(histories.length, 1);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-saved-turn-limit", histories,
    assertedDomains: { goal: ["complete", "blocked", "active"], decision: ["none", "continue", "terminal"],
      compaction: ["extension", "threshold", "overflow", "failed"], limit: [20, 1],
      ordering: ["held-after-settlement", "unheld-native-order"] },
    pendingReplacementGates: ["before-settlement public-order reachability review"] }));
});

// Catalog ID: compaction-blocked-completion.
test("Accepted blocked completion owns a pending compaction and prevents restart", { timeout: 900_000 }, async (t) => {
  const histories: HistoryResult[] = [];
  histories.push(await runHistory("compaction-blocked-completion", {
    mode: "rpc", label: "blocked-completion-completed-and-later-ordinary", percentRemaining: 15,
    compactActions: ["custom", "custom"], heldCompactions: [1, 2],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    const queueBlockedGoal = (): void => {
      for (let turn = 1; turn <= 3; turn += 1) {
        fixture.provider.enqueue({ kind: "goal", decision: goalDecision("blocked", turn), usageTokens: 10_000 });
        fixture.provider.enqueue({ kind: "text", content: `Blocker audit ${turn} finished.`, usageTokens: 10_000 });
      }
    };
    queueBlockedGoal();
    const unauthorizedFile = path.join(fixture.directory, "unauthorized-blocked-restart.txt");

    await prompt(fixture, "/goal Audit the original objective and stop after three matching blockers.");
    for (let index = 1; index <= 6; index += 1) await waitForProvider(fixture, index);
    await settle(fixture, 0, 3, "three accepted blocker audits");
    const blocked = last(goalStates(fixture), "three-turn blocked goal");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.turns, 3);
    assert.deepEqual(blocked.blockerAudit, { key: "missing-prerequisite", streak: 3, lastTurn: 3, evidence: "Audited acceptance vector 3." });
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 3);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    acknowledgeRpc(fixture);

    const completionErrors = observeRpcErrors(fixture);
    fixture.provider.enqueue({ kind: "goal", decision: goalDecision("complete", 4), usageTokens: 10_000 });
    fixture.provider.enqueue({ kind: "text", content: "The ordinary request accepted blocked completion.", usageTokens: 90_000 });
    const beforeCompletion = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "Audit and complete the unchanged original blocked objective.");
    const completion = await waitForProvider(fixture, 7);
    assertGoalToolDeclared(completion, true);
    assert.match(JSON.stringify(completion.body.messages), /Blocked KillerOS goal/u);
    await waitForProvider(fixture, 8);
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 1,
      "blocked completion's pending compaction", fixture.signal, beforeCompletion);
    await settle(fixture, beforeCompletion, 1, "blocked completion settlement before compaction");
    const completedGoal = last(goalStates(fixture), "accepted blocked completion before summary");
    assert.equal(completedGoal.status, "complete");
    assert.equal(completedGoal.turns, 3, "blocked completion grants no goal turn");
    assert.ok(isRecord(completedGoal.lastDecision) && completedGoal.lastDecision.kind === "complete",
      "accepted blocked completion saved its decision");
    await releaseSummary(fixture, 1);
    await waitForCompaction(fixture, 1, "blocked completion compaction success");
    assert.equal(last(goalStates(fixture), "completed goal after compaction").status, "complete");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 3);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(existsSync(unauthorizedFile), false);
    assert.deepEqual(completionErrors(), [], "completed blocked compaction emits no errors");
    acknowledgeRpc(fixture);

    fixture.provider.enqueue({ kind: "text", content: "Rearm the threshold at low usage before unrelated work.", usageTokens: 0 });
    const beforeRearm = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "Check the compacted context at low usage.");
    await waitForProvider(fixture, 9);
    await settle(fixture, beforeRearm, 1, "blocked completion threshold rearm");
    assert.equal(countProbe(fixture, "session_before_compact"), 1);
    acknowledgeRpc(fixture);

    fixture.provider.enqueue({ kind: "text", content: "Later unrelated work is allowed to use ordinary compaction.", usageTokens: 90_000 });
    fixture.provider.enqueue({ kind: "text", content: "The ordinary continuation finished.", usageTokens: 0 });
    fixture.provider.enqueue({ kind: "write", filePath: unauthorizedFile, content: "Unexpected completion restart" });
    const later = await prompt(fixture, "Do unrelated work without resuming or editing the completed goal.");
    await waitForProvider(fixture, 10);
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 2,
      "later unrelated compaction", fixture.signal);
    await releaseSummary(fixture, 2);
    await waitForCompaction(fixture, 2, "later unrelated compaction success");
    await waitForProvider(fixture, 11);
    await settle(fixture, beforeRearm, 3, "later unrelated request and ordinary continuation");
    assert.equal(last(goalStates(fixture), "completed goal after later ordinary task").status, "complete");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 1);
    assert.equal(fixture.provider.requests.length, 11);
    assert.equal(fixture.provider.remainingPlans, 1, "the armed restart write remains unused");
    assert.equal(existsSync(unauthorizedFile), false);
    assert.ok(later >= 0);
    acknowledgeRpc(fixture);

  }));

  for (const outcome of ["skipped", "ordinary", "failed"] as const) {
    histories.push(await runHistory("compaction-blocked-completion", {
      mode: "rpc", label: `blocked-completion-${outcome}`, percentRemaining: 15,
      ...(outcome === "skipped" ? { keepRecentTokens: 100_000, seedHistory: false } : {}),
      compactActions: outcome === "failed" ? ["provider"] : ["custom"],
    }, t, async (fixture) => {
      assert.equal(fixture.kind, "rpc");
    const queueBlockedGoal = (): void => {
      for (let turn = 1; turn <= 3; turn += 1) {
        fixture.provider.enqueue({ kind: "goal", decision: goalDecision("blocked", turn), usageTokens: 10_000 });
        fixture.provider.enqueue({ kind: "text", content: `Blocker audit ${turn} finished.`, usageTokens: 10_000 });
      }
    };
    queueBlockedGoal();
    const unauthorizedFile = path.join(fixture.directory, "unauthorized-blocked-restart.txt");

    await prompt(fixture, "/goal Audit the original objective and stop after three matching blockers.");
    for (let index = 1; index <= 6; index += 1) await waitForProvider(fixture, index);
    await settle(fixture, 0, 3, "three accepted blocker audits");
    const blocked = last(goalStates(fixture), "three-turn blocked goal");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.turns, 3);
    assert.deepEqual(blocked.blockerAudit, { key: "missing-prerequisite", streak: 3, lastTurn: 3, evidence: "Audited acceptance vector 3." });
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 3);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    acknowledgeRpc(fixture);


      const errorsAfterBlock = observeRpcErrors(fixture);
      const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
      if (outcome !== "ordinary") {
        fixture.provider.enqueue({ kind: "goal", decision: goalDecision("complete", 4), usageTokens: 10_000 });
        fixture.provider.enqueue({ kind: "text", content: "The accepted completion reaches a native too-small skip.", usageTokens: 90_000 });
        if (outcome === "failed") fixture.provider.enqueue({ kind: "error", status: 503, message: "provider unavailable" });
      } else {
        fixture.provider.enqueue({ kind: "text", content: "Leave the blocked objective unchanged.", usageTokens: 90_000 });
        fixture.provider.enqueue({ kind: "text", content: "Ordinary recovery continues without reviving the blocked goal.", usageTokens: 0 });
      }
      fixture.provider.enqueue({ kind: "write", filePath: unauthorizedFile, content: "Unexpected blocked-goal restart" });
      await prompt(fixture, outcome !== "ordinary"
        ? "Audit and complete the unchanged original blocked objective."
        : "Leave the saved blocked objective unchanged and finish unrelated work.");
      const request = await waitForProvider(fixture, 7);
      assertGoalToolDeclared(request, true);
      assert.match(JSON.stringify(request.body.messages), /Blocked KillerOS goal/u);
      await waitForProvider(fixture, 8);
      if (outcome === "skipped") {
        const failure = await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed",
          "exact native too-small skip after blocked completion", fixture.signal, before);
        assert.equal(stringField(failure, "errorMessage"), "Compaction failed: Nothing to compact (session too small)");
        assert.equal(countProbe(fixture, "session_before_compact"), 0);
        assert.equal(compactionEntries(fixture).length, 0);
      } else if (outcome === "failed") {
        await waitForProvider(fixture, 9);
        await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed",
          "failed compaction after accepted completion", fixture.signal, before);
        assert.equal(compactionEntries(fixture).length, 0);
      } else {
        await waitForCompaction(fixture, 1, "ordinary compaction without accepted blocked completion");
        assert.equal(compactionEntries(fixture).length, 1);
      }
      await settle(fixture, before, outcome === "ordinary" ? 2 : 1, "blocked request final settlement");
      const terminal = last(goalStates(fixture), "blocked request terminal state");
      assert.equal(terminal.status, outcome === "ordinary" ? "blocked" : "complete");
      if (outcome === "ordinary") {
        assert.deepEqual(terminal, blocked, "ordinary compaction preserves the complete saved blocked goal");
      }
      assert.equal(terminal.turns, 3, "blocked completion grants no goal turn");
      assert.equal(countMessages(fixture, "killeros-goal-continuation"), 3);
      assert.equal(countMessages(fixture, "killeros-auto-compaction"), outcome === "ordinary" ? 1 : 0);
      assert.equal(fixture.provider.requests.length, outcome === "failed" ? 9 : 8);
      assert.equal(fixture.provider.remainingPlans, 1, "the armed restart write remains unused");
      assert.equal(existsSync(unauthorizedFile), false);
      assertIdle(await getState(fixture), "blocked request final idle state");
      const errors = errorsAfterBlock();
      assert.equal(errors.length, outcome === "failed" ? 1 : 0);
      if (outcome === "failed") assert.match(String(errors[0]?.message), /provider unavailable/u);
      acknowledgeRpc(fixture);
    }));
  }
  assert.deepEqual(histories.map((history) => history.providerRequests), [11, 8, 8, 9]);
  assert.ok(histories.every((history) => history.naturalExit && history.scratchRemoved));
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-blocked-completion", histories,
    piLaunches: histories.length, providerRequests: histories.reduce((sum, history) => sum + history.providerRequests, 0),
    assertedDomains: { goal: ["blocked", "complete"], completion: ["accepted", "not-accepted"], compaction: ["completed", "skipped"], request: ["ordinary", "later"], ownership: ["goal", "ordinary"] } }));
});

// Catalog ID: compaction-goal-failure-replacement.
test("Replacement, explicit pause, provider error, and failed compaction keep the old goal stopped", { timeout: 900_000 }, async (t) => {
  const histories: HistoryResult[] = [];

  histories.push(await runHistory("compaction-goal-failure-replacement", {
    mode: "rpc", label: "explicit-pause-during-compaction", percentRemaining: 15,
    compactActions: ["custom"], heldCompactions: [1],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "goal", decision: goalDecision("continue", 1), usageTokens: 10_000 });
    fixture.provider.enqueue({ kind: "text", content: "The goal is paused while the real summary is held.", usageTokens: 95_000 });
    await prompt(fixture, "/goal Keep the objective paused during compaction.");
    await waitForProvider(fixture, 1);
    await waitForProvider(fixture, 2);
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "explicit-pause summary barrier", fixture.signal);
    await settle(fixture, 0, 1, "explicit-pause precondition settlement");
    const cursor = await prompt(fixture, "/goal pause");
    await awaitRpcNotification(fixture, cursor, /paused/u);
    await releaseSummary(fixture, 1);
    await waitForCompaction(fixture, 1, "explicit-pause compaction completion");
    const state = last(goalStates(fixture), "explicitly paused goal after compaction");
    assert.equal(state.status, "paused");
    assert.equal(state.turns, 1);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(fixture.provider.requests.length, 2);
    assert.equal(fixture.provider.remainingPlans, 0);
    assertIdle(await getState(fixture), "explicit pause during compaction");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-failure-replacement", {
    mode: "rpc", label: "unexpected-provider-abort-error", percentRemaining: 100,
    compactActions: ["custom"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "error", status: 503, message: "This operation was aborted unexpectedly" });
    await prompt(fixture, "/goal Fail closed on an unexpected native provider error.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await settle(fixture, before, 1, "unexpected provider error settlement");
    await waitForCompaction(fixture, 1, "compaction after genuine provider error");
    const state = last(goalStates(fixture), "provider-error goal");
    assert.equal(state.status, "paused");
    assert.match(String(state.result), /This operation was aborted unexpectedly/u);
    assert.equal(state.turns, 1);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(countProbe(fixture, "session_before_compact"), 1);
    assert.equal(compactionEntries(fixture).length, 1, "a successful summary does not erase the genuine provider error or resume the goal");
    assert.equal(fixture.provider.requests.length, 1);
    assert.equal(fixture.provider.remainingPlans, 0);
    assertIdle(await getState(fixture), "unexpected provider error");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-failure-replacement", {
    mode: "rpc", label: "failed-summary-provider", percentRemaining: 100,
    compactActions: ["provider"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "write", filePath: path.join(fixture.project, "failed-summary-proof.txt"),
      content: "Native compaction interrupts this public tool loop before its provider fails.", usageTokens: 90_000 });
    fixture.provider.enqueue({ kind: "error", status: 503, message: "provider unavailable" });
    await prompt(fixture, "/goal Pause when automatic compaction fails.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "real compaction provider request", fixture.signal, before);
    await waitForProvider(fixture, 2);
    const failed = await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed", "native summary provider failure", fixture.signal, before);
    await settle(fixture, before, 1, "failed goal compaction settlement");
    assert.match(stringField(failed, "errorMessage"), /provider unavailable/u);
    const state = last(goalStates(fixture), "failed goal compaction state");
    assert.equal(state.status, "paused");
    assert.match(String(state.result), /automatic compaction failed:.*provider unavailable/u);
    assert.equal(state.turns, 1);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(fixture.provider.requests.length, 2);
    assert.equal(fixture.provider.remainingPlans, 0);
    assertIdle(await getState(fixture), "failed compaction provider response");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-failure-replacement", {
    mode: "rpc", label: "replacement-during-compaction", percentRemaining: 15,
    compactActions: ["custom"], heldCompactions: [1],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "goal", decision: goalDecision("continue", 1), usageTokens: 10_000 });
    fixture.provider.enqueue({ kind: "text", content: "Old objective reaches pending compaction.", usageTokens: 95_000 });
    fixture.provider.enqueue({ kind: "text", content: "Replacement objective ran once.", usageTokens: 0 });
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await prompt(fixture, "/goal Finish the old objective.");
    await waitForProvider(fixture, 1);
    await waitForProvider(fixture, 2);
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "old goal summary barrier", fixture.signal, before);
    await settle(fixture, before, 1, "old goal settlement with compaction pending");
    assert.equal(last(goalStates(fixture), "paused old goal").status, "paused");
    const beforeReplacement = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await answerGoalConfirmation(fixture, "/goal Finish the replacement objective.", async () => {
      assert.equal(last(goalStates(fixture), "old goal while replacement waits for native idle").objective, "Finish the old objective.");
      await releaseSummary(fixture, 1);
      await waitForCompaction(fixture, 1, "replacement compaction completion");
    });
    await waitForProvider(fixture, 3);
    await settle(fixture, beforeReplacement, 1, "replacement turn settlement");
    const final = last(goalStates(fixture), "replacement goal after old compaction");
    assert.equal(final.objective, "Finish the replacement objective.");
    assert.equal(final.turns, 1, "the old authorized turn cannot resume over the replacement");
    assert.equal(final.status, "paused");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 2, "one old and one replacement authorization only");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(fixture.provider.requests.length, 3);
    assert.equal(fixture.provider.remainingPlans, 0);
    assertIdle(await getState(fixture), "replacement during pending compaction");
    acknowledgeRpc(fixture);
  }));

  assert.equal(histories.length, 4);
  assert.deepEqual(histories.map(({ providerRequests }) => providerRequests), [2, 1, 2, 3]);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-failure-replacement", histories }));
});

async function assertSkipResumePersistenceFailure(fixture: Fixture): Promise<void> {
    assert.equal(fixture.kind, "rpc");
    const responseBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: responseBarrier,
      response: { kind: "write", filePath: path.join(fixture.project, "skip-resume-fault-proof.txt"),
        content: "The native too-small skip interrupts the public tool loop after its saved pause.", usageTokens: 50_000 } });
    const retryBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: retryBarrier,
      response: { kind: "text", content: "The explicit retry after storage recovery started.", usageTokens: 0 } });
    await prompt(fixture, "/goal Fail closed if an exact skip cannot save the goal resume.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    setGoalFaultMode(fixture, "allow-one-then-deny");
    responseBarrier.release();
    const settled = await settle(fixture, before, 1, "skip-resume failure settlement");
    const skip = await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed", "exact native skip before resume persistence fault", fixture.signal, before);
    const deadline = Date.now() + waitTimeoutMs;
    while (!existsSync(fixture.faultAttemptFile) && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(existsSync(fixture.faultAttemptFile), true, "the child adapter acknowledged the automatic skip-resume append failure");
    const attempt = record(JSON.parse(readFileSync(fixture.faultAttemptFile, "utf8")), "skip-resume append acknowledgment");
    assertFaultBelongsToChild(fixture, attempt);
    assert.equal(attempt.operation, "appendFileSync");
    assert.equal(path.resolve(stringField(attempt, "file")), path.resolve(fixture.sessionFile));
    setGoalFaultMode(fixture, "off");
    assert.equal(settled.length, 1);
    assert.match(stringField(skip, "errorMessage"), /Nothing to compact \(session too small\)/u);
    const interrupted = last(probeEvents(fixture).filter((event) => event.type === "agent_end"), "skip-resume fault agent_end");
    assert.ok(interrupted.stopReason === "aborted"
      || interrupted.stopReason === "error" && interrupted.errorMessage === "This operation was aborted",
    "automatic skip recovery requires Pi's real interrupted request result");
    assert.equal(last(goalStates(fixture), "durable state after skip-resume failure").status, "paused");
    assert.equal(fixture.provider.requests.length, 1, "a failed skip resume sends no provider request");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(countProbe(fixture, "session_before_compact"), 0);
    await prompt(fixture, "/auto-compact off");
    const retryCursor = probeEvents(fixture).at(-1)?.sequence ?? 0;
    const retry = await rpcCommand(fixture, "prompt", { message: "/goal resume" });
    await waitForProvider(fixture, 2);
    assert.equal(record(retry.data, "skip-resume retry after storage returns").disposition, "handled");
    assert.equal(last(goalStates(fixture), "saved state after explicit skip-resume retry").status, "active");
    assert.equal(fixture.provider.requests.length, 2);
    await rpcCommand(fixture, "abort");
    await waitForProbe(fixture.probeFile, (event) => event.type === "agent_settled" && event.aborted === true,
      "settlement after skip-resume retry", fixture.signal, retryCursor);
    retryBarrier.release();
    assertIdle(await getState(fixture), "skip-resume failure and explicit recovery");
    acknowledgeRpc(fixture);
}

// Catalog ID: compaction-goal-skip-resume.
test("Exact session-too-small skip resumes the paused goal once after settlement, fail-closed on races", { timeout: 600_000 }, async (t) => {
  const histories: HistoryResult[] = [];

  histories.push(await runHistory("compaction-goal-skip-resume", {
    mode: "rpc", label: "native-skip-after-compaction-interruption", percentRemaining: 100,
    seedHistory: false, keepRecentTokens: 100_000, compactActions: [],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "write", filePath: path.join(fixture.project, "skip-interruption-proof.txt"),
      content: "Native compaction interrupts the public tool loop.", usageTokens: 50_000 });
    const recoveredBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: recoveredBarrier,
      response: { kind: "goal", decision: goalDecision("continue", 1), usageTokens: 10_000 } });
    fixture.provider.enqueue({ kind: "text", content: "The recovered goal turn reaches its accepted next-turn decision.", usageTokens: 10_000 });
    fixture.provider.enqueue({ kind: "text", content: "The next authorized turn stops without a decision.", usageTokens: 10_000 });
    await prompt(fixture, "/goal Recover only if native compaction interrupted this same goal turn.");
    const first = await waitForProvider(fixture, 1);
    assertGoalToolDeclared(first, true);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    const settled = await settle(fixture, before, 1, "native exact skip settlement", "continuing");
    const failure = await waitForProbe(fixture.probeFile, (event) => event.type === "session_compact_failed", "native exact too-small goal skip", fixture.signal, before);
    assert.match(stringField(failure, "errorMessage"), /Nothing to compact \(session too small\)/u);
    const interrupted = last(probeEvents(fixture).filter((event) => event.type === "agent_end"), "native skip agent_end");
    assert.ok(interrupted.stopReason === "aborted"
      || interrupted.stopReason === "error" && interrupted.errorMessage === "This operation was aborted",
    "same-turn recovery requires Pi's observed interrupted result");
    assert.equal(settled.length, 1);
    const resumed = await waitForProvider(fixture, 2);
    assert.match(JSON.stringify(resumed.body.messages), /Recover only if native compaction interrupted/u);
    const recoveryBoundary = Math.max(failure.sequence, last(settled, "interrupted settlement").sequence);
    const recoveryMessage = probeEvents(fixture).find((event) => event.sequence > recoveryBoundary
      && event.type === "message_start" && event.customType === "killeros-goal-continuation");
    assert.ok(recoveryMessage, "same-turn recovery waits for both exact skip and settlement");
    const recoveredGoal = last(goalStates(fixture), "same-turn exact-skip recovery");
    assert.equal(recoveredGoal.status, "active");
    assert.equal(recoveredGoal.turns, 1, "same-turn recovery grants no logical turn");
    assert.deepEqual(goalStates(fixture).slice(0, 4).map((state) => state.status), ["active", "active", "paused", "active"]);
    assert.equal(countProbe(fixture, "session_before_compact"), 0, "Pi rejects the naturally too-small history before extension preparation");
    await prompt(fixture, "/auto-compact off");
    recoveredBarrier.release();
    await waitForProvider(fixture, 3);
    await waitForProvider(fixture, 4);
    await settle(fixture, failure.sequence, 2, "authorized next turn after exact skip");
    const goal = last(goalStates(fixture), "goal after exact skip recovery");
    assert.equal(goal.status, "paused", "a normal stop without a decision cannot resume again");
    assert.equal(goal.turns, 2, "only the accepted continue decision grants a next logical turn");
    assert.deepEqual(goal.lastDecision, { kind: "continue", turn: 1, evidence: "Audited acceptance vector 1.", nextAction: "Run authorized step 2." });
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 3, "initial request, same-turn recovery, and one accepted next turn");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(fixture.provider.requests.length, 4);
    assert.equal(fixture.provider.remainingPlans, 0);
    assert.equal(readFileSync(path.join(fixture.project, "skip-interruption-proof.txt"), "utf8"),
      "Native compaction interrupts the public tool loop.");
    assertIdle(await getState(fixture), "native exact skip and authorized continuation");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-skip-resume", {
    mode: "rpc", label: "skip-resume-superseded-revision", percentRemaining: 100,
    keepRecentTokens: 1, compactActions: ["custom"], heldCompactions: [1],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "write", filePath: path.join(fixture.project, "superseded-recovery-proof.txt"),
      content: "Interrupt the public tool loop while its summary is held.", usageTokens: 90_000 });
    await prompt(fixture, "/goal Invalidate recovery by pausing during compaction.");
    await waitForProvider(fixture, 1);
    const beforeCompaction = probeEvents(fixture).at(-1)?.sequence ?? 0;
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact" && event.index === 1,
      "pending compaction before explicit pause", fixture.signal, beforeCompaction);
    await settle(fixture, beforeCompaction, 1, "automatically paused goal before explicit pause");
    const automaticPause = last(goalStates(fixture), "automatic pause before revision change");
    const pauseCursor = await prompt(fixture, "/goal pause");
    await awaitRpcNotification(fixture, pauseCursor, /paused/u);
    const explicitPause = last(goalStates(fixture), "explicit pause during pending compaction");
    assert.ok(numberField(explicitPause, "revision") > numberField(automaticPause, "revision"),
      "the public pause command advances the saved goal revision");
    await releaseSummary(fixture, 1);
    await waitForCompaction(fixture, 1, "compaction after the goal revision moved");
    assert.equal(last(goalStates(fixture), "goal after superseded compaction").status, "paused");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1,
      "the superseded compaction cannot resume the explicitly paused revision");
    assert.equal(fixture.provider.requests.length, 1);

    assert.equal(fixture.provider.remainingPlans, 0);
    assertIdle(await getState(fixture), "superseded compaction final idle state");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-skip-resume", {
    mode: "rpc", label: "skip-resume-storage-failure", percentRemaining: 100,
    seedHistory: false, keepRecentTokens: 100_000, compactActions: [],
  }, t, assertSkipResumePersistenceFailure));

  assert.deepEqual(histories.map(({ providerRequests }) => providerRequests), [4, 1, 2]);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-skip-resume", histories,
    assertedDomains: { compaction: ["exact-skip"], goal: ["paused", "active"], ordering: ["after-settlement"], persistence: ["ok", "failed"], revision: ["same", "moved"] } }));
});

// Catalog ID: compaction-goal-persistence-failure.
test("Goal pause and resume persistence failures fail closed before and after compaction", { timeout: 900_000 }, async (t) => {
  const histories: HistoryResult[] = [];

  histories.push(await runHistory("compaction-goal-persistence-failure", {
    mode: "rpc", label: "automatic-pause-append-failure", percentRemaining: 100,
    compactActions: ["custom"],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    const responseBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: responseBarrier,
      response: { kind: "text", content: "The active goal reaches automatic compaction while its pause write is denied.", usageTokens: 90_000 } });
    await prompt(fixture, "/goal Fail closed before automatic compaction starts.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    const originalGoalCount = goalStates(fixture).length;
    setGoalFaultMode(fixture, "deny-next");
    responseBarrier.release();
    await settle(fixture, before, 1, "pause append failure settlement");
    const failedNotification = await awaitRpcNotification(fixture, 0, /Automatic compaction did not start.*session storage unavailable/u);
    assert.equal(typeof failedNotification.message, "string");
    const statusCursor = await prompt(fixture, "/goal");
    const pausedStatus = await awaitRpcNotification(fixture, statusCursor, /paused/u);
    assert.equal(typeof pausedStatus.message, "string", "the public goal status reports the in-memory fail-closed pause");
    assert.equal(existsSync(fixture.faultAttemptFile), true);
    const attempt = record(JSON.parse(readFileSync(fixture.faultAttemptFile, "utf8")), "pause write acknowledgment");
    assertFaultBelongsToChild(fixture, attempt);
    assert.equal(attempt.operation, "appendFileSync");
    assert.equal(path.resolve(stringField(attempt, "file")), path.resolve(fixture.sessionFile));
    assert.equal(countProbe(fixture, "session_before_compact"), 0, "a failed pause append prevents Pi compaction from starting");
    assert.equal(countProbe(fixture, "session_compact"), 0);
    assert.equal(compactionEntries(fixture).length, 0);
    assert.equal(goalStates(fixture).length, originalGoalCount, "no fabricated paused-success record may replace original bytes");
    assert.equal(last(goalStates(fixture), "persisted state after pause failure").status, "active");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(fixture.provider.requests.length, 1);
    assert.equal(fixture.provider.remainingPlans, 0);
    setGoalFaultMode(fixture, "off");
    const retryBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: retryBarrier,
      response: { kind: "text", content: "Explicit recovery after the pause write fault.", usageTokens: 0 } });
    const retryCursor = probeEvents(fixture).at(-1)?.sequence ?? 0;
    const resume = await rpcCommand(fixture, "prompt", { message: "/goal resume" });
    assert.equal(record(resume.data, "resume after pause failure").disposition, "handled");
    await waitForProvider(fixture, 2);
    assert.equal(last(goalStates(fixture), "saved goal after writable retry").status, "active");
    assert.equal(fixture.provider.requests.length, 2);
    await rpcCommand(fixture, "abort");
    await waitForProbe(fixture.probeFile, (event) => event.type === "agent_settled" && event.aborted === true,
      "abort after recovered writable goal", fixture.signal, retryCursor);
    retryBarrier.release();
    assertIdle(await getState(fixture), "pause failure and explicit recovery");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-persistence-failure", {
    mode: "rpc", label: "automatic-resume-append-failure", percentRemaining: 15,
    compactActions: ["custom"], heldCompactions: [1],
  }, t, async (fixture) => {
    assert.equal(fixture.kind, "rpc");
    fixture.provider.enqueue({ kind: "write", filePath: path.join(fixture.project, "resume-fault-proof.txt"),
      content: "The public write completes before compaction interrupts the tool loop.", usageTokens: 95_000 });
    await prompt(fixture, "/goal Fail closed when automatic compaction cannot save its resume state.");
    await waitForProvider(fixture, 1);
    const before = probeEvents(fixture).at(-1)?.sequence ?? 0;
    const originalBytes = readFileSync(fixture.sessionFile, "utf8");
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_compact", "resume-failure summary barrier", fixture.signal, before);
    await settle(fixture, before, 1, "pause saved before compaction completes");
    assert.equal(last(goalStates(fixture), "saved pause before resume fault").status, "paused");
    const notificationCursor = fixture.rpc.currentSequence;
    setGoalFaultMode(fixture, "deny-next");
    await releaseSummary(fixture, 1);
    await waitForCompaction(fixture, 1, "successful summary before failed resume append");
    const notification = await awaitRpcNotification(fixture, notificationCursor, /could not be resumed/u);
    assert.equal(typeof notification.message, "string");
    assert.equal(existsSync(fixture.faultAttemptFile), true);
    const attempt = record(JSON.parse(readFileSync(fixture.faultAttemptFile, "utf8")), "resume write acknowledgment");
    assertFaultBelongsToChild(fixture, attempt);
    assert.equal(attempt.operation, "appendFileSync");
    assert.equal(path.resolve(stringField(attempt, "file")), path.resolve(fixture.sessionFile));
    const finalGoal = last(goalStates(fixture), "durable state after resume failure");
    assert.equal(finalGoal.status, "paused");
    assert.equal(finalGoal.turns, 1);
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1);
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 0);
    assert.equal(fixture.provider.requests.length, 1);
    assert.equal(compactionEntries(fixture).length, 1);
    assert.ok(readFileSync(fixture.sessionFile, "utf8").startsWith(originalBytes), "session history is appended, never replaced");
    setGoalFaultMode(fixture, "off");
    const retryBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: retryBarrier,
      response: { kind: "text", content: "Explicit recovery after the resume write fault.", usageTokens: 0 } });
    const retryCursor = probeEvents(fixture).at(-1)?.sequence ?? 0;
    const retry = await rpcCommand(fixture, "prompt", { message: "/goal resume" });
    assert.equal(record(retry.data, "resume after compaction persistence recovery").disposition, "handled");
    await waitForProvider(fixture, 2);
    assert.equal(last(goalStates(fixture), "goal after explicit resume retry").status, "active");
    assert.equal(fixture.provider.requests.length, 2);
    await rpcCommand(fixture, "abort");
    await waitForProbe(fixture.probeFile, (event) => event.type === "agent_settled" && event.aborted === true,
      "settlement after explicit resume retry", fixture.signal, retryCursor);
    retryBarrier.release();
    assertIdle(await getState(fixture), "resume failure and explicit recovery");
    acknowledgeRpc(fixture);
  }));

  histories.push(await runHistory("compaction-goal-persistence-failure", {
    mode: "rpc", label: "skip-resume-append-failure", percentRemaining: 100,
    seedHistory: false, keepRecentTokens: 100_000, compactActions: [],
  }, t, async (fixture) => {
    await assertSkipResumePersistenceFailure(fixture);
  }));

  assert.deepEqual(histories.map(({ providerRequests }) => providerRequests), [2, 2, 2]);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-goal-persistence-failure", histories,
    assertedDomains: { persistence: ["pause", "resume", "skip-resume"], storage: ["writable", "unwritable"], compaction: ["not-started", "completed"], goal: ["active", "paused"], recovery: ["fail-closed", "retry"] } }));
});
