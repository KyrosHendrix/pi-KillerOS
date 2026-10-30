import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenarioTitle = "goal commands separate objectives, controls, edits, and unsafe replacements";
const startNotice = "Goal started. Each turn must record continue, complete, or a blocker decision before another turn starts.";
const replaceNotice = "Goal replaced. Each turn must record continue, complete, or a blocker decision before another turn starts.";
const pauseNotice = "Goal paused. Run /goal resume to continue.";

async function isolatedGoalRoot(prefix: string): Promise<string> {
  const directory = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
  try {
    for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false, "Goal histories must not discover an ancestor Git repository");
      if (path.dirname(ancestor) === ancestor) break;
    }
    return directory;
  } catch (error) {
    await removeDirectoryEventually(directory);
    throw error;
  }
}

type RecordValue = Record<string, unknown>;
type ProviderOutcome = "finished" | "closed";
type ProviderRequest = { index: number; body: RecordValue; completion: Promise<ProviderOutcome> };
type ProviderBarrier = { released: Promise<void>; release(): void };
type ProviderToolCall = { name: string; arguments: RecordValue };
type ProviderPlan = { kind: "stop" } | { kind: "barrier"; barrier: ProviderBarrier }
  | { kind: "goal"; barrier: ProviderBarrier; decision: RecordValue }
  | { kind: "calls"; barrier?: ProviderBarrier; calls: ProviderToolCall[] }
  | { kind: "partial"; barrier: ProviderBarrier; content: string };
type RpcBatch = { label: string; first: number; through: number; records: number };
type SavedGoalEntry = { id: string; event: string; state: RecordValue | null };
type PromiseOutcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown };
type RpcWaiter = {
  count: number;
  resolve(request: ProviderRequest): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};
type NotificationObservation = { count(): number; stop(): void };

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecordValue(value)) throw new Error(`Expected ${label} to be an object`);
  return value;
}

function records(value: unknown, label: string): RecordValue[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function stringField(value: RecordValue, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected ${key} to be a string`);
  return field;
}

function makeBarrier(): ProviderBarrier {
  let resolveRelease: () => void = () => {};
  let isReleased = false;
  const released = new Promise<void>((resolve) => { resolveRelease = resolve; });
  return {
    released,
    release() {
      if (isReleased) return;
      isReleased = true;
      resolveRelease();
    },
  };
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function outcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value): PromiseOutcome<T> => ({ kind: "resolved", value }),
    (error: unknown): PromiseOutcome<T> => ({ kind: "rejected", error }),
  );
}

class LocalProvider {
  readonly faults: string[] = [];
  readonly requests: ProviderRequest[] = [];
  private readonly server: Server;
  private readonly plans: ProviderPlan[] = [];
  private readonly waiters = new Set<RpcWaiter>();
  private readonly barriers: ProviderBarrier[] = [];
  private readonly handlers = new Set<Promise<void>>();
  private address = "";

  constructor() {
    this.server = createServer((request, response) => {
      const handling = this.handle(request, response);
      this.handlers.add(handling);
      void handling.then(
        () => this.handlers.delete(handling),
        (error: unknown) => {
          this.faults.push(error instanceof Error ? error.message : String(error));
          this.handlers.delete(handling);
        },
      );
    });
  }

  get baseUrl(): string {
    if (!this.address) throw new Error("The local provider is not listening");
    return this.address;
  }

  get requestCount(): number {
    return this.requests.length;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The loopback provider did not receive a TCP address"));
          return;
        }
        this.address = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  holdNextRequest(): ProviderBarrier {
    const barrier = makeBarrier();
    this.barriers.push(barrier);
    this.plans.push({ kind: "barrier", barrier });
    return barrier;
  }

  queueGoalDecision(decision: RecordValue): ProviderBarrier {
    const barrier = makeBarrier();
    this.barriers.push(barrier);
    this.plans.push({ kind: "goal", barrier, decision }, { kind: "stop" });
    return barrier;
  }

  /** Holds the next request, then answers with one or more model tool calls in a single message.
   * The caller queues the follow-up plan explicitly because tool results may justify any response. */
  holdToolCalls(calls: ProviderToolCall[]): ProviderBarrier {
    const barrier = makeBarrier();
    this.barriers.push(barrier);
    this.plans.push({ kind: "calls", barrier, calls });
    return barrier;
  }

  /** Answers the next request with tool calls and no hold; used for queued decision follow-ups. */
  queueToolCalls(calls: ProviderToolCall[]): void {
    this.plans.push({ kind: "calls", calls });
  }

  /** Answers the next request with a plain settled response. */
  queueStop(): void {
    this.plans.push({ kind: "stop" });
  }

  /** Streams content, then holds the response open mid-stream until released or aborted. */
  holdPartialResponse(content: string): ProviderBarrier {
    const barrier = makeBarrier();
    this.barriers.push(barrier);
    this.plans.push({ kind: "partial", barrier, content });
    return barrier;
  }

  async waitForRequest(count: number, signal: AbortSignal): Promise<ProviderRequest> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    const existing = this.requests[count - 1];
    if (existing) return existing;
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Provider wait was cancelled");
    return await new Promise<ProviderRequest>((resolve, reject) => {
      const waiter: RpcWaiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`Timed out waiting for provider request ${count}`));
        }, 30_000),
        signal,
      };
      waiter.abort = () => {
        this.removeWaiter(waiter);
        reject(signal.reason instanceof Error ? signal.reason : new Error("Provider wait was cancelled"));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.add(waiter);
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
      try {
        await waitWithTimeout(closed, 10_000, "loopback provider shutdown");
      } catch (error) {
        this.server.closeAllConnections();
        await waitWithTimeout(closed, 5_000, "loopback provider shutdown after owned connection cleanup");
        throw error;
      }
    }
    await waitWithTimeout(Promise.all([...this.handlers]).then(() => undefined), 10_000, "provider request handlers");
    assert.deepEqual(this.faults, [], "the loopback provider must not record fixture faults");
    assert.equal(this.waiters.size, 0, "all provider request waiters must be resolved");
    assert.equal(this.plans.length, 0, "every planned provider barrier must be consumed");
  }

  summary(): RecordValue {
    return {
      requestCount: this.requestCount,
      plannedResponsesRemaining: this.plans.length,
      waitingRequestObservers: this.waiters.size,
      faults: this.faults.slice(0, 20),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        bytes += chunk.byteLength;
        assert.ok(bytes <= 1_048_576, "provider requests must remain bounded");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "provider request");
      const exchange = this.observe(body, response);
      const plan = this.plans.shift() ?? { kind: "stop" as const };
      if (plan.kind !== "stop" && plan.kind !== "calls") await plan.barrier.released;
      else if (plan.kind === "calls" && plan.barrier) await plan.barrier.released;
      if (response.destroyed || response.writableEnded) return;
      if (plan.kind === "partial") {
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.write(`data: ${JSON.stringify({
          id: `goals-partial-${exchange.index}`,
          model: "local",
          choices: [{ index: 0, delta: { content: plan.content }, finish_reason: null }],
          usage: { prompt_tokens: 30_000, completion_tokens: 20, total_tokens: 30_020 },
        })}\n\n`);
        await plan.barrier.released;
        if (response.destroyed || response.writableEnded) return;
        response.end("data: [DONE]\n\n");
        return;
      }
      const delta = plan.kind === "goal"
        ? { tool_calls: [{ index: 0, id: `decision-${exchange.index}`, type: "function",
          function: { name: "killeros_goal_update", arguments: JSON.stringify(plan.decision) } }] }
        : plan.kind === "calls"
          ? { tool_calls: plan.calls.map((call, callIndex) => ({ index: callIndex,
            id: `calls-${exchange.index}-${callIndex}`, type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : { content: "The scripted request has settled." };
      const finishReason = plan.kind === "goal" || plan.kind === "calls" ? "tool_calls" : "stop";
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `goals-command-${exchange.index}`,
        model: "local",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        usage: { prompt_tokens: 30_000, completion_tokens: 120, total_tokens: 30_120 },
      })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      this.faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { connection: "close" });
        response.end("Provider fixture failure");
      }
    }
  }

  private observe(body: RecordValue, response: ServerResponse): ProviderRequest {
    let resolveCompletion: (outcome: ProviderOutcome) => void = () => {};
    const completion = new Promise<ProviderOutcome>((resolve) => { resolveCompletion = resolve; });
    response.once("finish", () => resolveCompletion("finished"));
    response.once("close", () => resolveCompletion(response.writableFinished ? "finished" : "closed"));
    const exchange = { index: this.requests.length + 1, body, completion };
    this.requests.push(exchange);
    for (const waiter of this.waiters) {
      const matched = this.requests[waiter.count - 1];
      if (!matched) continue;
      this.removeWaiter(waiter);
      waiter.resolve(matched);
    }
    return exchange;
  }

  private removeWaiter(waiter: RpcWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.waiters.delete(waiter);
  }
}

type PiFixture = {
  directory: string;
  project: string;
  initialSessionFile: string;
  currentSessionFile: string;
  currentSessionId: string;
  signal: AbortSignal;
  rpc: PiRpcProcess;
  provider: LocalProvider;
  batches: RpcBatch[];
  acknowledgedSequence: number;
};

function acknowledgeBatch(fixture: PiFixture, label: string): void {
  const through = fixture.rpc.currentSequence;
  const first = fixture.rpc.firstSequence;
  const count = fixture.rpc.retainedRecordCount;
  assert.equal(first, fixture.acknowledgedSequence + 1, `${label}: retained RPC evidence must be contiguous`);
  assert.equal(count, through - fixture.acknowledgedSequence, `${label}: acknowledge the complete retained RPC batch`);
  fixture.rpc.acknowledge(through);
  assert.equal(fixture.rpc.retainedRecordCount, 0, `${label}: the acknowledged RPC batch must be released`);
  fixture.batches.push({ label, first, through, records: count });
  fixture.acknowledgedSequence = through;
}

async function createFixture(
  directory: string,
  label: string,
  signal: AbortSignal,
  savedGoal?: RecordValue,
  savedEvent = "limit",
  tools = "killeros_goal_update",
  extra: { extensions?: string[]; env?: RecordValue; compaction?: RecordValue; seedPadding?: string } = {},
): Promise<PiFixture> {
  const fixtureDirectory = path.join(directory, label);
  let ownsFixtureDirectory = false;
  let provider: LocalProvider | undefined;
  let rpc: PiRpcProcess | undefined;
  try {
    mkdirSync(fixtureDirectory);
    ownsFixtureDirectory = true;
    const agent = path.join(fixtureDirectory, "agent");
    const project = path.join(fixtureDirectory, "project");
    const sessions = path.join(fixtureDirectory, "sessions");
    const temporary = path.join(fixtureDirectory, "tmp");
    mkdirSync(agent);
    mkdirSync(project);
    mkdirSync(sessions);
    mkdirSync(temporary);

    provider = new LocalProvider();
    await provider.listen();
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      compaction: extra.compaction ?? { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "off",
    }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({
      providers: {
        "goals-command": {
          api: "openai-completions",
          apiKey: "fixture-only",
          baseUrl: provider.baseUrl,
          models: [{
            id: "local",
            name: "Local goal grammar fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }));

    const session = SessionManager.create(project, sessions);
    session.appendCustomEntry("goals-command-grammar-fixture", { scenario: "saved-session" });
    if (savedGoal || extra.seedPadding !== undefined) {
      // Compaction estimates context from the last assistant usage, so padded seeds carry a larger count.
      const seedTokens = extra.seedPadding === undefined ? 2 : 40_000;
      session.appendMessage({ role: "user", content: extra.seedPadding ?? "Restore the saved goal history.", timestamp: Date.now() });
      session.appendMessage({ role: "assistant", content: [{ type: "text", text: "The previous work is saved." }],
        api: "openai-completions", provider: "goals-command", model: "local", stopReason: "stop", timestamp: Date.now(),
        usage: { input: seedTokens - 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: seedTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    if (savedGoal) session.appendCustomEntry("killeros-goal", { version: 1, event: savedEvent, state: savedGoal });
    const initialSessionFile = session.getSessionFile();
    assert.ok(initialSessionFile, "the native fixture session must be saved before Pi starts");

    const env: NodeJS.ProcessEnv = {
      HOME: fixtureDirectory,
      USERPROFILE: fixtureDirectory,
      APPDATA: fixtureDirectory,
      LOCALAPPDATA: fixtureDirectory,
      TEMP: temporary,
      TMP: temporary,
      PATH: path.dirname(process.execPath),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      ...(extra.env ?? {}),
    };
    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    for (const key of ["SystemRoot", "WINDIR", "PATHEXT"]) {
      const value = inherited.get(key.toLowerCase());
      if (value !== undefined) env[key] = value;
    }

    rpc = new PiRpcProcess({
      cliPath: path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      cwd: project,
      env,
      args: [
        "--mode", "rpc",
        "--model", "goals-command/local",
        "--thinking", "off",
        "--tools", tools,
        "--session", initialSessionFile,
        "--offline",
        "--approve",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-mcp",
        "--no-extensions",
        "--extension", repositoryRoot,
        ...(extra.extensions ?? []).flatMap((extension) => ["--extension", extension]),
      ],
    });
    return {
      directory: fixtureDirectory,
      project,
      initialSessionFile,
      currentSessionFile: initialSessionFile,
      currentSessionId: "",
      signal,
      rpc,
      provider,
      batches: [],
      acknowledgedSequence: 0,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    provider?.releaseAll();
    if (rpc) {
      try {
        const cleanup = await rpc.close();
        if (cleanup.forced) cleanupErrors.push(new Error(`Pi CLI required forced setup-failure cleanup: ${JSON.stringify(cleanup)}`));
        if (cleanup.exit.code !== 0) cleanupErrors.push(new Error(`Pi CLI exited with ${cleanup.exit.code} during setup failure`));
        if (cleanup.treeCleanupError !== undefined) cleanupErrors.push(new Error(`Pi CLI tree cleanup was uncertain during setup failure: ${cleanup.treeCleanupError}`));
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (provider) {
      try { await provider.close(); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (ownsFixtureDirectory) {
      try { await removeDirectoryEventually(fixtureDirectory); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    const diagnostics = [
      `fixture: ${fixtureDirectory}`,
      `provider: ${JSON.stringify(provider?.summary() ?? null)}`,
      `rpc: ${rpc?.diagnostics() ?? "not started"}`,
    ].join("\n").slice(0, 12_000);
    throw new AggregateError([error, ...cleanupErrors], `${label}: goal command fixture setup failed\n${diagnostics}`);
  }
}

async function initializeFixture(fixture: PiFixture): Promise<void> {
  const state = await getState(fixture);
  assert.equal(stringField(state, "sessionFile"), fixture.initialSessionFile);
  fixture.currentSessionId = stringField(state, "sessionId");
  assertIdle(state, "startup");
  const response = await rpcCommand(fixture, "get_commands");
  const data = record(response.data, "get_commands data");
  const commands = records(data.commands, "registered commands");
  assert.ok(commands.some((command) => command.name === "goal" && command.source === "extension"));
  assert.equal(fixture.provider.requestCount, 0, "startup must not make a provider request");
  assert.equal(goalEntries(await getEntries(fixture)).length, 0, "the saved fixture session starts without a goal");
  acknowledgeBatch(fixture, "startup");
}

async function rpcCommand(fixture: PiFixture, type: string, fields: RecordValue = {}): Promise<PiRpcRecord> {
  return await fixture.rpc.command(type, fields, { timeoutMs: 45_000, signal: fixture.signal });
}

async function getState(fixture: PiFixture): Promise<RecordValue> {
  return record((await rpcCommand(fixture, "get_state")).data, "RPC state");
}

async function getEntries(fixture: PiFixture): Promise<RecordValue[]> {
  const data = record((await rpcCommand(fixture, "get_entries")).data, "RPC entries response");
  return records(data.entries, "saved session entries");
}

function goalEntries(entries: RecordValue[]): SavedGoalEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal entry data");
    const state = data.state === null ? null : record(data.state, "saved goal state");
    return [{ id: stringField(entry, "id"), event: stringField(data, "event"), state }];
  });
}

function lastGoal(entries: SavedGoalEntry[], label: string): SavedGoalEntry {
  const entry = entries.at(-1);
  assert.ok(entry, `${label}: expected a saved KillerOS goal entry`);
  return entry;
}

function goalEvent(entries: SavedGoalEntry[], event: string, label: string): SavedGoalEntry {
  let entry: SavedGoalEntry | undefined;
  for (const candidate of entries) {
    if (candidate.event === event) entry = candidate;
  }
  assert.ok(entry, `${label}: expected saved goal event ${event}`);
  return entry;
}

function goalState(entry: SavedGoalEntry, label: string): RecordValue {
  assert.ok(entry.state, `${label}: expected the goal entry to retain its state`);
  return entry.state;
}

function assertSetEntry(entries: SavedGoalEntry[], objective: string, label: string): void {
  const entry = goalEvent(entries, "set", label);
  const state = goalState(entry, label);
  assert.equal(state.objective, objective, `${label}: exact saved objective`);
  assert.equal(state.maxTurns, 20, `${label}: default saved turn budget`);
}

function assertIdle(state: RecordValue, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: Pi must not still be streaming`);
  assert.equal(state.isCompacting, false, `${label}: Pi must not still be compacting`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no follow-up may remain queued`);
}

function assertProviderRequest(request: ProviderRequest, expectedCount: number, objective: string, label: string): void {
  assert.equal(request.index, expectedCount, `${label}: provider request index`);
  assert.equal(request.body.model, "local", `${label}: the loopback model must receive the request`);
  const messages = JSON.stringify(request.body.messages);
  assert.ok(messages.includes(objective), `${label}: provider context must contain the exact objective`);
}

async function waitForNotification(
  fixture: PiFixture,
  after: number,
  expectedMessage: string,
  expectedType: string,
  label: string,
): Promise<PiRpcRecord> {
  const notification = await fixture.rpc.waitFor(
    (entry) => entry.type === "extension_ui_request"
      && entry.method === "notify"
      && entry.message === expectedMessage,
    { after, timeoutMs: 15_000, signal: fixture.signal },
  );
  assert.equal(notification.notifyType, expectedType, `${label}: notification type`);
  return notification;
}

/** Counts every notify record published after a cursor until the caller stops the observation. */
function observeNotifications(fixture: PiFixture, after: number, label: string): NotificationObservation {
  let observed = 0;
  let failure: Error | undefined;
  const controller = new AbortController();
  const pending = fixture.rpc.waitForRecord(
    (entry) => {
      if (entry.type === "extension_ui_request" && entry.method === "notify") observed += 1;
      return false;
    },
    { after, timeoutMs: 45_000, signal: controller.signal },
  );
  void pending.catch((error: unknown) => {
    if (!controller.signal.aborted) failure = error instanceof Error ? error : new Error(String(error));
  });
  return {
    count() {
      if (failure !== undefined) throw failure;
      return observed;
    },
    stop() {
      if (!controller.signal.aborted) controller.abort(new Error(`${label}: notification observation finished`));
    },
  };
}

async function waitForSettled(fixture: PiFixture, after: number, label: string): Promise<void> {
  await fixture.rpc.waitFor((entry) => entry.type === "agent_settled", {
    after,
    timeoutMs: 45_000,
    signal: fixture.signal,
  });
  assertIdle(await getState(fixture), label);
}

async function submitCommand(fixture: PiFixture, text: string, label: string): Promise<PiRpcRecord> {
  const response = await rpcCommand(fixture, "prompt", { message: text });
  const data = record(response.data, `${label} prompt response`);
  assert.equal(data.disposition, "handled", `${label}: the real RPC command must be handled`);
  return response;
}

/** Submits an ordinary user prompt; Pi reports started (or queued while streaming), not handled. */
async function submitPrompt(fixture: PiFixture, text: string, label: string): Promise<PiRpcRecord> {
  const response = await rpcCommand(fixture, "prompt", { message: text });
  const data = record(response.data, `${label} prompt response`);
  const disposition = stringField(data, "disposition");
  assert.ok(["started", "queued"].includes(disposition), `${label}: the ordinary prompt must start or queue: ${disposition}`);
  return response;
}

async function assertFreshSession(fixture: PiFixture, label: string): Promise<void> {
  const beforeRequests = fixture.provider.requestCount;
  const previousFile = fixture.currentSessionFile;
  const previousId = fixture.currentSessionId;
  const cursor = fixture.rpc.currentSequence;
  const response = await rpcCommand(fixture, "new_session");
  const data = record(response.data, `${label} new_session response`);
  assert.equal(data.cancelled, false, `${label}: native new_session must commit`);
  const state = await getState(fixture);
  const sessionFile = stringField(state, "sessionFile");
  const sessionId = stringField(state, "sessionId");
  assert.notEqual(sessionFile, previousFile, `${label}: new_session must select a new saved session file`);
  assert.notEqual(sessionId, previousId, `${label}: new_session must select a new session identity`);
  assertIdle(state, label);
  assert.equal(goalEntries(await getEntries(fixture)).length, 0, `${label}: the new session must not inherit a goal`);
  assert.equal(fixture.provider.requestCount, beforeRequests, `${label}: reset must not make a provider request`);
  fixture.currentSessionFile = sessionFile;
  fixture.currentSessionId = sessionId;
  assert.ok(fixture.rpc.currentSequence > cursor, `${label}: the reset must have a public RPC response`);
  acknowledgeBatch(fixture, `reset:${label}`);
}

async function assertNormalObjective(fixture: PiFixture, objective: string, label: string): Promise<void> {
  const beforeRequests = fixture.provider.requestCount;
  const cursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, `/goal ${objective}`, label);
  await waitForNotification(fixture, cursor, startNotice, "info", label);
  const request = await fixture.provider.waitForRequest(beforeRequests + 1, fixture.signal);
  assertProviderRequest(request, beforeRequests + 1, objective, label);
  await waitForSettled(fixture, cursor, label);
  assert.equal(await request.completion, "finished", `${label}: the provider response must finish`);
  assert.equal(fixture.provider.requestCount, beforeRequests + 1, `${label}: exactly one request is allowed`);
  const entries = goalEntries(await getEntries(fixture));
  assertSetEntry(entries, objective, label);
  const latest = goalState(lastGoal(entries, label), label);
  assert.equal(latest.objective, objective, `${label}: latest saved objective`);
  assert.equal(latest.maxTurns, 20, `${label}: latest saved turn budget`);
  assert.equal(latest.status, "paused", `${label}: a no-decision response must settle as paused`);
  acknowledgeBatch(fixture, label);
}

async function assertRejectedObjective(
  fixture: PiFixture,
  objective: string,
  expectedMessage: string,
  label: string,
  options: { requireSingleNotification?: boolean } = {},
): Promise<void> {
  const beforeRequests = fixture.provider.requestCount;
  const beforeEntries = await getEntries(fixture);
  const beforeGoals = goalEntries(beforeEntries);
  const cursor = fixture.rpc.currentSequence;
  const observation = options.requireSingleNotification === true
    ? observeNotifications(fixture, cursor, label)
    : undefined;
  try {
    await submitCommand(fixture, `/goal ${objective}`, label);
    const notification = await waitForNotification(fixture, cursor, expectedMessage, "error", label);
    assert.equal(stringField(notification, "message").includes("\0"), false, `${label}: safe notification must not echo NUL`);
    const afterEntries = await getEntries(fixture);
    const afterGoals = goalEntries(afterEntries);
    assert.deepEqual(afterGoals, beforeGoals, `${label}: rejection must append no goal entry`);
    assert.deepEqual(afterEntries.filter(entry => entry.type === "custom_message" && entry.customType === "killeros-goal-continuation"),
      beforeEntries.filter(entry => entry.type === "custom_message" && entry.customType === "killeros-goal-continuation"),
      `${label}: rejection must not persist a goal continuation`);
    assert.equal(fixture.provider.requestCount, beforeRequests, `${label}: rejection must not issue a provider request`);
    assertIdle(await getState(fixture), `${label}: handled rejection`);
    if (observation) {
      assert.equal(observation.count(), 1, `${label}: the handled rejection must report exactly one notification`);
    }
  } finally {
    observation?.stop();
  }
  acknowledgeBatch(fixture, label);
}

async function runStartForms(fixture: PiFixture): Promise<void> {
  await assertNormalObjective(fixture, "Existing objective", "start: existing objective");
  await assertFreshSession(fixture, "start: replacement form reset");

  const label = "start: confirmed replacement";
  const firstObjective = "First objective";
  const replacementObjective = "Replacement objective";
  const beforeRequests = fixture.provider.requestCount;
  const firstBarrier = fixture.provider.holdNextRequest();
  const firstCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, `/goal ${firstObjective}`, `${label}: initial`);
  await waitForNotification(fixture, firstCursor, startNotice, "info", `${label}: initial`);
  const firstRequest = await fixture.provider.waitForRequest(beforeRequests + 1, fixture.signal);
  assertProviderRequest(firstRequest, beforeRequests + 1, firstObjective, `${label}: initial`);
  const initialEntries = goalEntries(await getEntries(fixture));
  assertSetEntry(initialEntries, firstObjective, `${label}: initial`);
  assert.equal(goalState(lastGoal(initialEntries, label), label).status, "active");

  firstBarrier.release();
  await waitForSettled(fixture, firstCursor, `${label}: initial turn`);
  assert.equal(await firstRequest.completion, "finished", `${label}: initial provider request must finish`);
  const settledEntries = goalEntries(await getEntries(fixture));
  assert.equal(goalState(lastGoal(settledEntries, label), label).status, "paused");

  // Settle the first turn before replacement so settlement cannot invalidate the command's captured state.
  const secondBarrier = fixture.provider.holdNextRequest();
  const replacementCursor = fixture.rpc.currentSequence;
  const replacementOutcome = outcome(submitCommand(fixture, `/goal ${replacementObjective}`, label));
  const confirmation = await fixture.rpc.waitFor(
    (entry) => entry.type === "extension_ui_request" && entry.method === "confirm",
    { after: replacementCursor, timeoutMs: 15_000, signal: fixture.signal },
  );
  assert.equal(confirmation.title, "Replace active goal", `${label}: Pi must request its real replacement confirmation`);
  assert.equal(confirmation.message, "Replace the current unfinished goal and discard its continuation state?");
  await fixture.rpc.send({ type: "extension_ui_response", id: stringField(confirmation, "id"), confirmed: true });

  const responseResult = await replacementOutcome;
  if (responseResult.kind === "rejected") {
    throw new Error(`${label}: the public confirmation must allow replacement`, { cause: responseResult.error });
  }
  const responseData = record(responseResult.value.data, `${label} prompt response`);
  assert.equal(responseData.disposition, "handled");
  await waitForNotification(fixture, replacementCursor, replaceNotice, "info", label);

  const secondRequest = await fixture.provider.waitForRequest(beforeRequests + 2, fixture.signal);
  assertProviderRequest(secondRequest, beforeRequests + 2, replacementObjective, label);
  const entries = goalEntries(await getEntries(fixture));
  assertSetEntry(entries, firstObjective, `${label}: original set`);
  const replacementEntry = goalEvent(entries, "replace", label);
  const replacementState = goalState(replacementEntry, label);
  assert.equal(replacementState.objective, replacementObjective, `${label}: exact replacement objective`);
  assert.equal(replacementState.maxTurns, 20, `${label}: replacement turn budget`);
  assert.equal(replacementState.status, "active", `${label}: replacement starts an active goal`);
  assert.equal(fixture.provider.requestCount, beforeRequests + 2, `${label}: initial and replacement requests only`);

  secondBarrier.release();
  await waitForSettled(fixture, replacementCursor, label);
  assert.equal(await secondRequest.completion, "finished", `${label}: replacement provider request must finish`);
  const finalEntries = goalEntries(await getEntries(fixture));
  const latest = goalState(lastGoal(finalEntries, label), label);
  assert.equal(latest.objective, replacementObjective, `${label}: settled session retains the replacement`);
  assert.equal(latest.maxTurns, 20);
  assert.equal(latest.status, "paused", `${label}: no decision pauses the settled replacement`);
  acknowledgeBatch(fixture, label);
  await assertFreshSession(fixture, `${label} reset`);
}

type LifecycleControl = { label: string; spelling: string; kind: "pause" | "resume" | "clear" };

async function runPauseControl(fixture: PiFixture, control: LifecycleControl): Promise<void> {
  const label = `control: ${control.spelling}`;
  const beforeRequests = fixture.provider.requestCount;
  const barrier = fixture.provider.holdNextRequest();
  const startCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, "/goal Some objective", `${label}: initial`);
  await waitForNotification(fixture, startCursor, startNotice, "info", `${label}: initial`);
  const request = await fixture.provider.waitForRequest(beforeRequests + 1, fixture.signal);
  assertProviderRequest(request, beforeRequests + 1, "Some objective", `${label}: initial`);
  const activeEntries = goalEntries(await getEntries(fixture));
  assertSetEntry(activeEntries, "Some objective", `${label}: initial`);
  assert.equal(goalState(lastGoal(activeEntries, label), label).status, "active");

  const controlCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, `/goal ${control.spelling}`, label);
  await waitForNotification(fixture, controlCursor, pauseNotice, "info", label);
  const pausedEntries = goalEntries(await getEntries(fixture));
  const pauseEntry = goalEvent(pausedEntries, "pause", label);
  assert.equal(goalState(pauseEntry, label).status, "paused", `${label}: bare pause must pause the goal`);
  assert.equal(goalState(pauseEntry, label).objective, "Some objective");
  await waitForSettled(fixture, startCursor, label);
  barrier.release();
  assert.equal(await request.completion, "closed", `${label}: pause must cancel the held provider request`);
  assert.equal(fixture.provider.requestCount, beforeRequests + 1, `${label}: pause must not start another request`);
  const finalEntries = goalEntries(await getEntries(fixture));
  assert.equal(goalState(lastGoal(finalEntries, label), label).status, "paused");
  acknowledgeBatch(fixture, label);
}

async function runResumeControl(fixture: PiFixture, control: LifecycleControl): Promise<void> {
  const label = `control: ${control.spelling}`;
  const beforeRequests = fixture.provider.requestCount;
  const firstBarrier = fixture.provider.holdNextRequest();
  const startCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, "/goal Some objective", `${label}: initial`);
  await waitForNotification(fixture, startCursor, startNotice, "info", `${label}: initial`);
  const firstRequest = await fixture.provider.waitForRequest(beforeRequests + 1, fixture.signal);
  assertProviderRequest(firstRequest, beforeRequests + 1, "Some objective", `${label}: initial`);

  const pauseCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, "/goal pause", `${label}: pause before resume`);
  await waitForNotification(fixture, pauseCursor, pauseNotice, "info", `${label}: pause before resume`);
  const pausedEntry = goalEvent(goalEntries(await getEntries(fixture)), "pause", label);
  assert.equal(goalState(pausedEntry, label).status, "paused");
  await waitForSettled(fixture, startCursor, `${label}: paused turn`);
  firstBarrier.release();
  assert.equal(await firstRequest.completion, "closed", `${label}: pause must cancel the first request`);

  const secondBarrier = fixture.provider.holdNextRequest();
  const resumeCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, `/goal ${control.spelling}`, label);
  await waitForNotification(fixture, resumeCursor, "Goal resumed", "info", label);
  const resumedRequest = await fixture.provider.waitForRequest(beforeRequests + 2, fixture.signal);
  assertProviderRequest(resumedRequest, beforeRequests + 2, "Some objective", label);
  const entries = goalEntries(await getEntries(fixture));
  const resumeEntry = goalEvent(entries, "resume", label);
  const resumedState = goalState(resumeEntry, label);
  assert.equal(resumedState.status, "active", `${label}: mixed-case resume must reactivate the goal`);
  assert.equal(resumedState.objective, "Some objective");
  assert.equal(resumedState.maxTurns, 20);
  assert.equal(fixture.provider.requestCount, beforeRequests + 2, `${label}: pause and resume requests only`);

  secondBarrier.release();
  await waitForSettled(fixture, resumeCursor, label);
  assert.equal(await resumedRequest.completion, "finished", `${label}: resumed provider request must finish`);
  const finalEntries = goalEntries(await getEntries(fixture));
  assert.equal(goalState(lastGoal(finalEntries, label), label).status, "paused");
  assert.equal(goalState(lastGoal(finalEntries, label), label).objective, "Some objective");
  acknowledgeBatch(fixture, label);
}

async function runClearControl(fixture: PiFixture, control: LifecycleControl): Promise<void> {
  const label = `control: ${control.spelling}`;
  const beforeRequests = fixture.provider.requestCount;
  const barrier = fixture.provider.holdNextRequest();
  const startCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, "/goal Some objective", `${label}: initial`);
  await waitForNotification(fixture, startCursor, startNotice, "info", `${label}: initial`);
  const request = await fixture.provider.waitForRequest(beforeRequests + 1, fixture.signal);
  assertProviderRequest(request, beforeRequests + 1, "Some objective", `${label}: initial`);

  const clearCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, `/goal ${control.spelling}`, label);
  await waitForNotification(fixture, clearCursor, "Goal cleared", "info", label);
  await waitForSettled(fixture, startCursor, label);
  barrier.release();
  assert.equal(await request.completion, "closed", `${label}: clear must cancel the held request`);
  assert.equal(fixture.provider.requestCount, beforeRequests + 1, `${label}: clear must not start another request`);
  const entries = goalEntries(await getEntries(fixture));
  assert.ok(entries.some((entry) => entry.event === "clear"), `${label}: bare clear must persist the clear event`);
  assert.equal(lastGoal(entries, label).state, null, `${label}: clear must remove the saved goal state`);
  acknowledgeBatch(fixture, label);
}

async function runLifecycleControl(fixture: PiFixture, control: LifecycleControl): Promise<void> {
  if (control.kind === "pause") await runPauseControl(fixture, control);
  else if (control.kind === "resume") await runResumeControl(fixture, control);
  else await runClearControl(fixture, control);
  await assertFreshSession(fixture, `control: ${control.spelling} reset`);
}

async function runUnsafeReplacement(fixture: PiFixture): Promise<void> {
  const label = "rejection: unsafe replacement";
  const beforeRequests = fixture.provider.requestCount;
  const barrier = fixture.provider.holdNextRequest();
  const startCursor = fixture.rpc.currentSequence;
  const originalObjective = "Keep the original objective";
  await submitCommand(fixture, `/goal ${originalObjective}`, `${label}: original`);
  await waitForNotification(fixture, startCursor, startNotice, "info", `${label}: original`);
  const request = await fixture.provider.waitForRequest(beforeRequests + 1, fixture.signal);
  assertProviderRequest(request, beforeRequests + 1, originalObjective, `${label}: original`);
  const beforeEntries = await getEntries(fixture);
  const beforeGoals = goalEntries(beforeEntries);
  assert.equal(goalState(lastGoal(beforeGoals, label), label).status, "active");

  const badPath = `${fixture.project.replace(/\\/gu, "/")}/invalid\0file`;
  const rejectedCursor = fixture.rpc.currentSequence;
  await submitCommand(fixture, `/goal Create the file at \`${badPath}\``, label);
  const notification = await waitForNotification(
    fixture,
    rejectedCursor,
    "A goal objective contains unsupported content",
    "error",
    label,
  );
  assert.equal(stringField(notification, "message").includes("\0"), false, `${label}: safe error must not echo NUL`);
  const afterGoals = goalEntries(await getEntries(fixture));
  assert.deepEqual(afterGoals, beforeGoals, `${label}: unsafe input must not append or replace the saved goal`);
  assert.equal(goalState(lastGoal(afterGoals, label), label).objective, originalObjective);
  assert.equal(goalState(lastGoal(afterGoals, label), label).status, "active", `${label}: the original remains active at rejection`);
  assert.equal(fixture.provider.requestCount, beforeRequests + 1, `${label}: rejection must not start a replacement request`);

  barrier.release();
  await waitForSettled(fixture, startCursor, `${label}: original turn`);
  assert.equal(await request.completion, "finished");
  const finalEntries = await getEntries(fixture);
  assert.deepEqual(finalEntries.filter(entry => entry.type === "custom_message" && entry.customType === "killeros-goal-continuation"),
    beforeEntries.filter(entry => entry.type === "custom_message" && entry.customType === "killeros-goal-continuation"),
    `${label}: rejection must not queue a continuation that persists after settlement`);
  const finalGoals = goalEntries(finalEntries);
  const finalState = goalState(lastGoal(finalGoals, label), label);
  assert.equal(finalState.objective, originalObjective, `${label}: the original objective survives settlement`);
  assert.equal(finalState.status, "paused", `${label}: the original no-decision turn settles paused`);
  acknowledgeBatch(fixture, label);
  await assertFreshSession(fixture, `${label} reset`);
}

async function closeFixture(fixture: PiFixture): Promise<unknown[]> {
  const errors: unknown[] = [];
  fixture.provider.releaseAll();
  try {
    const cleanup = await fixture.rpc.close();
    if (cleanup.forced) errors.push(new Error(`Pi CLI required forced cleanup: ${JSON.stringify(cleanup)}`));
    if (cleanup.exit.code !== 0) errors.push(new Error(`Pi CLI exited with ${cleanup.exit.code}: ${fixture.rpc.diagnostics()}`));
    if (cleanup.treeCleanupError !== undefined) errors.push(new Error(`Pi CLI tree cleanup was uncertain: ${cleanup.treeCleanupError}`));
    acknowledgeBatch(fixture, "natural-shutdown");
  } catch (error) {
    errors.push(error);
  }
  try {
    for (const request of fixture.provider.requests) {
      await waitWithTimeout(request.completion, 10_000, `provider request ${request.index} completion`);
    }
    await fixture.provider.close();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function fixtureDiagnostics(fixtures: PiFixture[]): RecordValue[] {
  return fixtures.map((fixture) => ({
    directory: fixture.directory,
    sessionFile: fixture.currentSessionFile,
    requestCount: fixture.provider.requestCount,
    provider: fixture.provider.summary(),
    rpc: fixture.rpc.diagnostics(),
    acknowledgedBatches: fixture.batches.slice(0, 80),
  }));
}

// ---------------------------------------------------------------------------
// Shared goal E2E infrastructure for the remaining catalog scenarios.
// ---------------------------------------------------------------------------

type TerminalFixture = {
  directory: string;
  project: string;
  sessionFile: string;
  extraSessionFiles: string[];
  provider: LocalProvider;
  terminal: PiTerminalProcess;
  signal: AbortSignal;
  cols: number;
};

type TerminalFixtureOptions = {
  directory: string;
  label: string;
  signal: AbortSignal;
  tools?: string;
  excludeTools?: string;
  extraExtensions?: string[];
  envExtra?: RecordValue;
  savedGoal?: RecordValue;
  savedGoalEvent?: string;
  seedPadding?: string;
  seededSessions?: Array<{ state: RecordValue; event: string }>;
  cols?: number;
  rows?: number;
};

function writeGoalAgentConfig(agent: string, provider: LocalProvider): void {
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultThinkingLevel: "off",
  }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({
    providers: {
      "goals-command": {
        api: "openai-completions",
        apiKey: "fixture-only",
        baseUrl: provider.baseUrl,
        models: [{
          id: "local",
          name: "Local goal fixture model",
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }));
}

function childEnvironment(fixtureDirectory: string, temporary: string, agent: string, extra?: RecordValue): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: fixtureDirectory,
    USERPROFILE: fixtureDirectory,
    APPDATA: fixtureDirectory,
    LOCALAPPDATA: fixtureDirectory,
    TEMP: temporary,
    TMP: temporary,
    PATH: path.dirname(process.execPath),
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...(extra ?? {}),
  };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function seedSavedSession(project: string, sessions: string, savedGoal?: RecordValue, savedEvent = "limit", seedPadding?: string): string {
  const session = SessionManager.create(project, sessions);
  session.appendCustomEntry("goals-e2e-fixture", { scenario: "saved-session" });
  // A conversation is required for SessionManager to flush the seeded file before Pi starts.
  session.appendMessage({ role: "user", content: seedPadding ?? "Restore the saved goal history.", timestamp: Date.now() });
  // Compaction estimates context from the last assistant usage, so padded seeds carry a larger count.
  const seedTokens = seedPadding === undefined ? 2 : 40_000;
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "The previous work is saved." }],
    api: "openai-completions", provider: "goals-command", model: "local", stopReason: "stop", timestamp: Date.now(),
    usage: { input: seedTokens - 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: seedTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  if (savedGoal) {
    session.appendCustomEntry("killeros-goal", { version: 1, event: savedEvent, state: savedGoal });
  }
  const sessionFile = session.getSessionFile();
  assert.ok(sessionFile, "the native fixture session must be saved before Pi starts");
  return sessionFile;
}

async function createTerminalFixture(options: TerminalFixtureOptions): Promise<TerminalFixture> {
  const fixtureDirectory = path.join(options.directory, options.label);
  let ownsFixtureDirectory = false;
  let provider: LocalProvider | undefined;
  let terminal: PiTerminalProcess | undefined;
  const cols = options.cols ?? 110;
  const rows = options.rows ?? 32;
  try {
    mkdirSync(fixtureDirectory);
    ownsFixtureDirectory = true;
    const agent = path.join(fixtureDirectory, "agent");
    const project = path.join(fixtureDirectory, "project");
    const sessions = path.join(fixtureDirectory, "sessions");
    const temporary = path.join(fixtureDirectory, "tmp");
    mkdirSync(agent);
    mkdirSync(project);
    mkdirSync(sessions);
    mkdirSync(temporary);
    provider = new LocalProvider();
    await provider.listen();
    writeGoalAgentConfig(agent, provider);
    const sessionFile = seedSavedSession(project, sessions, options.savedGoal, options.savedGoalEvent, options.seedPadding);
    const panel = options.seededSessions === undefined
      ? undefined
      : preparePanelSessions(fixtureDirectory, options.seededSessions);
    const extraSessionFiles = panel?.files ?? [];
    const extensions = [...(options.extraExtensions ?? []), ...(panel ? [panel.extensionPath] : [])];
    const envExtra = { ...(options.envExtra ?? {}), ...(panel?.env ?? {}) };
    const args = [
      path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      "--model", "goals-command/local",
      "--thinking", "off",
      "--tools", options.tools ?? "killeros_goal_update",
      "--session", sessionFile,
      "--session-dir", sessions,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      ...extensions.flatMap((extension) => ["--extension", extension]),
    ];
    if (options.excludeTools !== undefined) args.push("--exclude-tools", options.excludeTools);
    terminal = new PiTerminalProcess({
      file: process.execPath,
      args,
      cwd: project,
      env: childEnvironment(fixtureDirectory, temporary, agent, envExtra),
      cols,
      rows,
    });
    await terminal.waitForScreen(
      (screen) => screen.includes("KillerOS") && screen.split("\n").some((line) => line === "─".repeat(cols)),
      { signal: options.signal, timeoutMs: 30_000 },
    );
    return {
      directory: fixtureDirectory,
      project,
      sessionFile,
      extraSessionFiles,
      provider,
      terminal,
      signal: options.signal,
      cols,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    provider?.releaseAll();
    if (terminal) {
      try {
        const closed = await terminal.close();
        if (closed.code !== 0 || closed.forced || closed.failure !== undefined) {
          cleanupErrors.push(new Error(`Pi TUI required forced setup-failure cleanup: ${JSON.stringify(closed)}`));
        }
      } catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (provider) {
      try { await provider.close(); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (ownsFixtureDirectory) {
      try { await removeDirectoryEventually(fixtureDirectory); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    const diagnostics = [
      `fixture: ${fixtureDirectory}`,
      `provider: ${JSON.stringify(provider?.summary() ?? null)}`,
      `terminal: ${terminal?.diagnostics() ?? "not started"}`,
    ].join("\n").slice(0, 12_000);
    throw new AggregateError([error, ...cleanupErrors], `${options.label}: goal terminal fixture setup failed\n${diagnostics}`);
  }
}

/** Writes one editor line and submits it with an explicit CSI-u Enter (ConPTY maps bare CR to Shift+Enter). */
function submitTerminalLine(fixture: TerminalFixture, text: string): number {
  const cursor = fixture.terminal.sequence;
  fixture.terminal.write(`${text}\x1b[13u`);
  return cursor;
}

async function closeTerminalFixture(fixture: TerminalFixture): Promise<unknown[]> {
  const errors: unknown[] = [];
  fixture.provider.releaseAll();
  try {
    const closed = await fixture.terminal.close();
    if (closed.code !== 0 || closed.forced || closed.failure !== undefined) {
      errors.push(new Error(`Pi TUI cleanup was not natural: ${JSON.stringify(closed)}`));
    }
  } catch (error) { errors.push(error); }
  try {
    for (const request of fixture.provider.requests) {
      await waitWithTimeout(request.completion, 10_000, `provider request ${request.index} completion`);
    }
    await fixture.provider.close();
  } catch (error) { errors.push(error); }
  return errors;
}

function sessionFileGoalEntries(raw: string): SavedGoalEntry[] {
  const entries: SavedGoalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecordValue(parsed) || parsed.type !== "custom" || parsed.customType !== "killeros-goal") continue;
    const data = record(parsed.data, "saved goal entry data");
    entries.push({
      id: stringField(parsed, "id"),
      event: stringField(data, "event"),
      state: data.state === null ? null : record(data.state, "saved goal state"),
    });
  }
  return entries;
}

async function readSessionGoalEntries(file: string): Promise<SavedGoalEntry[]> {
  return sessionFileGoalEntries(await readFile(file, "utf8"));
}

type SessionCustomEntry = { id: string; customType: string; data: RecordValue | null };

function sessionCustomEntries(raw: string): SessionCustomEntry[] {
  const entries: SessionCustomEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRecordValue(parsed) || parsed.type !== "custom" || typeof parsed.customType !== "string") continue;
    const data = parsed.data === null || parsed.data === undefined ? null : record(parsed.data, "custom entry data");
    entries.push({ id: stringField(parsed, "id"), customType: parsed.customType, data });
  }
  return entries;
}

/** Bounded fs.watch wait until the owned session file contains a matching durable custom entry. */
async function waitForSessionCustomEntry(
  file: string,
  customType: string,
  dataKey: string,
  expected: unknown,
  signal: AbortSignal,
  label: string,
): Promise<void> {
  const matches = async (): Promise<boolean> => {
    try {
      return sessionCustomEntries(await readFile(file, "utf8"))
        .some((entry) => entry.customType === customType && entry.data !== null && entry.data[dataKey] === expected);
    } catch {
      return false;
    }
  };
  if (await matches()) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = (): void => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clean();
      if (error !== undefined) reject(error instanceof Error ? error : new Error(`${label}: marker wait failed`, { cause: error }));
      else resolve();
    };
    const abort = (): void => settle(signal.reason);
    const poll = async (): Promise<void> => {
      if (await matches()) settle();
    };
    watcher = watch(path.dirname(file), () => { void poll(); });
    watcher.on("error", (error) => settle(error));
    timer = setTimeout(() => settle(new Error(`${label}: timed out waiting for the ${customType} marker`)), 20_000);
    signal.addEventListener("abort", abort, { once: true });
    void poll();
  });
}

/** Bounded fs.watch wait for a durable session-file goal state; no sleeps. */
async function waitForSessionGoalEntries(
  file: string,
  predicate: (entries: SavedGoalEntry[]) => boolean,
  signal: AbortSignal,
  label: string,
): Promise<SavedGoalEntry[]> {
  signal.throwIfAborted();
  const check = async (): Promise<SavedGoalEntry[] | undefined> => {
    try {
      const entries = await readSessionGoalEntries(file);
      return predicate(entries) ? entries : undefined;
    } catch {
      return undefined;
    }
  };
  const initial = await check();
  if (initial !== undefined) return initial;
  return await new Promise<SavedGoalEntry[]>((resolve, reject) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = (): void => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
    };
    const settle = (error: unknown, entries?: SavedGoalEntry[]): void => {
      if (settled) return;
      settled = true;
      clean();
      if (error !== undefined) reject(error instanceof Error ? error : new Error(`${label}: durable session wait failed`, { cause: error }));
      else resolve(entries ?? []);
    };
    const abort = (): void => settle(signal.reason);
    const poll = async (): Promise<void> => {
      const entries = await check();
      if (entries !== undefined) settle(undefined, entries);
    };
    watcher = watch(path.dirname(file), () => { void poll(); });
    watcher.on("error", (error) => settle(error));
    timer = setTimeout(() => settle(new Error(`${label}: timed out waiting for the durable session goal state`)), 20_000);
    signal.addEventListener("abort", abort, { once: true });
    void poll();
  });
}

/** Bounded fs.watch wait for a JSON fixture-control file written by a child adapter or extension. */
async function waitForControlFile(file: string, signal: AbortSignal, label: string): Promise<RecordValue> {
  signal.throwIfAborted();
  const check = (): RecordValue | undefined => {
    if (!existsSync(file)) return undefined;
    try {
      const contents = record(JSON.parse(readFileSync(file, "utf8")), `${label} control file`);
      assert.ok(Number.isSafeInteger(contents.pid), `${label}: the control acknowledgement must carry a pid`);
      return contents;
    } catch {
      return undefined;
    }
  };
  const initial = check();
  if (initial !== undefined) return initial;
  return await new Promise<RecordValue>((resolve, reject) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = (): void => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
    };
    const settle = (error: unknown, contents?: RecordValue): void => {
      if (settled) return;
      settled = true;
      clean();
      if (error !== undefined) reject(error instanceof Error ? error : new Error(`${label}: control wait failed`, { cause: error }));
      else resolve(contents ?? {});
    };
    const abort = (): void => settle(signal.reason);
    const poll = (): void => {
      const contents = check();
      if (contents !== undefined) settle(undefined, contents);
    };
    watcher = watch(path.dirname(file), poll);
    watcher.on("error", (error) => settle(error));
    timer = setTimeout(() => settle(new Error(`${label}: timed out waiting for ${file}`)), 20_000);
    signal.addEventListener("abort", abort, { once: true });
    poll();
  });
}

function seededGoalBase(objective: string, revision: number): RecordValue {
  const now = Date.now();
  return { version: 1, revision, objective, createdAt: now - 60_000, updatedAt: now,
    activeMilliseconds: 60_000, turns: 1, blockedAuditStartTurn: 0, baselineTokens: 0, maxTurns: 20 };
}

/** A restored active goal whose accepted continue decision authorizes exactly one more turn. */
function authorizedContinueGoalState(objective: string): RecordValue {
  return {
    ...seededGoalBase(objective, 4),
    status: "active",
    activeStartedAt: Date.now(),
    turnPhase: "authorized",
    turnDecision: { kind: "continue", turn: 1, evidence: "Restored observed progress", nextAction: "Inspect the next restored result" },
  };
}

/** A restored active goal whose turn never recorded a decision; restore must pause it. */
function unresolvedGoalTurnState(objective: string): RecordValue {
  return { ...seededGoalBase(objective, 3), status: "active", activeStartedAt: Date.now(), turnPhase: "in-flight" };
}


const sessionSwitchExtensionSource = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  const sessions: string[] = JSON.parse(process.env.KILLEROS_GOAL_PANEL_SESSIONS ?? "[]");
  pi.registerCommand("fixture-goal-session", {
    description: "Switch to an exact saved goal fixture session",
    handler: async (args, ctx) => {
      const index = Number(args.trim());
      const file = sessions[index];
      if (!Number.isInteger(index) || file === undefined) throw new Error("Unknown goal fixture session");
      const result = await ctx.switchSession(file, {
        withSession: async (freshCtx) => {
          freshCtx.sessionManager.appendCustomEntry("goals-e2e-fixture", { ready: index });
        },
      });
      if (result.cancelled) throw new Error("Goal fixture session switch was cancelled");
    },
  });
}
`;

/** Seeds panel sessions and wires the public session-switch fixture command for them. */
function preparePanelSessions(fixtureDirectory: string, seeds: Array<{ state: RecordValue; event: string }>): {
  extensionPath: string;
  files: string[];
  env: RecordValue;
} {
  const sessionsDir = path.join(fixtureDirectory, "sessions");
  const files = seeds.map((seed) => {
    const session = SessionManager.create(path.join(fixtureDirectory, "project"), sessionsDir);
    session.appendCustomEntry("goals-e2e-fixture", { scenario: "panel-session" });
    session.appendMessage({ role: "user", content: `Seed a ${seed.event} goal panel session.`, timestamp: Date.now() });
    session.appendCustomEntry("killeros-goal", { version: 1, event: seed.event, state: seed.state });
    const file = session.getSessionFile();
    assert.ok(file, "the seeded panel session must be saved");
    return file;
  });
  const extensionPath = path.join(fixtureDirectory, "goal-panel-session-switch.ts");
  writeFileSync(extensionPath, sessionSwitchExtensionSource);
  return { extensionPath, files, env: { KILLEROS_GOAL_PANEL_SESSIONS: JSON.stringify(files) } };
}const toolBarrierExtensionSource = `import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const control = process.env.KILLEROS_GOAL_TOOL_BARRIER ?? "";
function log(line) {
  fs.appendFileSync(path.join(control, "events.log"), JSON.stringify({ at: Date.now(), ...line }) + "\\n");
}
export default function (pi: ExtensionAPI) {
  let held = false;
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "killeros_goal_update") return;
    log({ event: "tool_call", id: event.toolCallId, held });
    let plan = {};
    try { plan = JSON.parse(fs.readFileSync(path.join(control, "plan.json"), "utf8")); } catch {}
    if (plan.mode !== "hold-first") return;
    if (!held) {
      held = true;
      fs.writeFileSync(path.join(control, "first-entered.json"), JSON.stringify({ pid: process.pid, tool: event.toolName }));
      log({ event: "hold-start", id: event.toolCallId });
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(path.join(control, "tool-release"))) {
        if (Date.now() >= deadline) { log({ event: "deadline", id: event.toolCallId }); throw new Error("Goal tool barrier release deadline exceeded"); }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      log({ event: "released", id: event.toolCallId });
      return;
    }
    log({ event: "second-entered", id: event.toolCallId });
    fs.writeFileSync(path.join(control, "second-entered.json"), JSON.stringify({
      pid: process.pid,
      afterRelease: fs.existsSync(path.join(control, "tool-release")),
    }));
  });
}
`;

const removedObjectives = [
  "Start reliably",
  "Check the release",
  "Checks pass",
  "Limit latency",
  "History of changes",
  "Clear the cache",
  "Edit the file",
  "history 10",
  "check quality",
] as const;

const lifecycleControls = [
  { label: "pause", spelling: "PAUSE", kind: "pause" },
  { label: "resume", spelling: "Resume", kind: "resume" },
  { label: "clear", spelling: "clear", kind: "clear" },
] as const satisfies readonly LifecycleControl[];

const nearControlObjectives = [
  "Pause.",
  "Pause the video",
  "Start reliably",
  "history 10",
  "clear now",
  "pause now",
  "resume now",
] as const;

test(scenarioTitle, { timeout: 120_000, skip: piRpcShutdownSkip }, async (t: TestContext) => {
  const artifactDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-goals-command-grammar-"));
  const fixtures: PiFixture[] = [];
  let primaryError: unknown;
  try {
    for (let ancestor = realpathSync(artifactDirectory); ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false, `fixture must not discover Git at ${ancestor}`);
      if (path.dirname(ancestor) === ancestor) break;
    }
    const starts = await createFixture(artifactDirectory, "start-replacement", t.signal);
    fixtures.push(starts);
    await initializeFixture(starts);
    await runStartForms(starts);

    const grammar = await createFixture(artifactDirectory, "objectives-controls-rejections", t.signal);
    fixtures.push(grammar);
    await initializeFixture(grammar);
    for (const [index, objective] of removedObjectives.entries()) {
      const label = `removed command word ${index + 1}: ${objective}`;
      await assertNormalObjective(grammar, objective, label);
      await assertFreshSession(grammar, `${label} reset`);
    }
    for (const control of lifecycleControls) await runLifecycleControl(grammar, control);
    for (const [index, objective] of nearControlObjectives.entries()) {
      const label = `near-control objective ${index + 1}: ${objective}`;
      await assertNormalObjective(grammar, objective, label);
      await assertFreshSession(grammar, `${label} reset`);
    }

    await assertRejectedObjective(
      grammar,
      "x".repeat(4_001),
      "A goal objective may not exceed 4,000 characters",
      "rejection: 4,001-character objective",
    );
    await assertFreshSession(grammar, "rejection: overlong objective reset");
    await runUnsafeReplacement(grammar);

    const unsupportedPath = path.join(path.parse(process.cwd()).root, "killeros-invalid\0report.md");
    await assertRejectedObjective(
      grammar,
      `Write the Markdown file to \`${unsupportedPath}\``,
      "A goal objective contains unsupported content",
      "rejection: unsupported terminal path",
      { requireSingleNotification: true },
    );
    await assertFreshSession(grammar, "rejection: unsupported path reset");

    const vectorCount = 2 + removedObjectives.length + lifecycleControls.length + nearControlObjectives.length + 3;
    assert.equal(vectorCount, 24, "the catalog input domain contains exactly 24 vectors");
    assert.equal(starts.provider.requestCount, 3, "the two start forms issue one initial and two replacement-workflow requests");
    assert.equal(grammar.provider.requestCount, 21, "the remaining 22 vectors issue exactly 21 provider requests");
    assert.deepEqual(starts.provider.faults, []);
    assert.deepEqual(grammar.provider.faults, []);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const fixture of [...fixtures].reverse()) {
    try {
      cleanupErrors.push(...await closeFixture(fixture));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const failureErrors = [
    ...(primaryError === undefined ? [] : [primaryError]),
    ...cleanupErrors,
  ];

  // Snapshot bounded process evidence before removing any owned fixture directory.
  const diagnostics = JSON.stringify(fixtureDiagnostics(fixtures), null, 2).slice(0, 32_768);
  let failureDirectory: string | undefined;
  let reportError: Error | undefined;
  let reportedErrorCount = 0;
  const saveFailureEvidence = (): void => {
    try {
      // Keep the report outside artifactDirectory so scratch cleanup cannot erase it.
      failureDirectory ??= mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goals-command-grammar-failure-"));
      throwScenarioFailure({
        directory: failureDirectory,
        message: "goals.command-grammar failed or did not clean up naturally",
        errors: failureErrors,
        diagnostics,
      });
    } catch (error) {
      reportError = error instanceof Error ? error : new Error(String(error));
      if (failureDirectory === undefined || !existsSync(path.join(failureDirectory, "failure.txt"))) {
        failureErrors.push(error);
      }
      reportedErrorCount = failureErrors.length;
    }
  };

  if (failureErrors.length > 0) saveFailureEvidence();

  for (const fixture of [...fixtures].reverse()) {
    try {
      await removeDirectoryEventually(fixture.directory);
      assert.equal(existsSync(fixture.directory), false, `remove the owned fixture directory ${fixture.directory}`);
    } catch (error) {
      cleanupErrors.push(error);
      failureErrors.push(error);
    }
  }
  try {
    await removeDirectoryEventually(artifactDirectory);
    assert.equal(existsSync(artifactDirectory), false, "remove the owned goal-command artifact directory");
  } catch (error) {
    cleanupErrors.push(error);
    failureErrors.push(error);
  }

  if (failureErrors.length > reportedErrorCount) saveFailureEvidence();
  if (failureDirectory !== undefined) {
    try {
      if (existsSync(failureDirectory) && readdirSync(failureDirectory).length === 0) {
        await removeDirectoryEventually(failureDirectory);
      }
    } catch (error) {
      failureErrors.push(error);
    }
  }
  if (failureErrors.length > 0) {
    throw new AggregateError(
      reportError === undefined ? failureErrors : [...failureErrors, reportError],
      "goals.command-grammar failed or did not clean up naturally",
    );
  }
});

function savedLimitedGoal(objective: string, turns: number, maxTurns: number): RecordValue {
  const now = Date.now();
  return { version: 1, revision: 5, objective, status: "paused", createdAt: now - 60_000, updatedAt: now,
    activeMilliseconds: 60_000, turns, blockedAuditStartTurn: 0, baselineTokens: 0, maxTurns };
}

// Catalog ID: goals.turn-limits.
test("turn budgets renew explicitly and stop silently at the limit", { timeout: 150_000, skip: piRpcShutdownSkip }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-goal-budgets-"));
  const fixtures: PiFixture[] = [];
  const observations: RecordValue[] = [];
  const errors: unknown[] = [];
  try {
    for (let ancestor = realpathSync(directory); ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false, `fixture must not discover Git at ${ancestor}`);
      if (path.dirname(ancestor) === ancestor) break;
    }
    const exhaustion = await createFixture(directory, "default-exhaustion-resume", t.signal);
    fixtures.push(exhaustion);
    await initializeFixture(exhaustion);
    const barriers = Array.from({ length: 20 }, (_, index) => exhaustion.provider.queueGoalDecision({
      status: "continue", evidence: `Verified progress ${index + 1}`, nextAction: `Inspect result ${index + 1}`,
    }));
    const objective = "Finish within the default goal budget";
    let cursor = exhaustion.rpc.currentSequence;
    await submitCommand(exhaustion, `/goal ${objective}`, "default budget");
    let createdAt: unknown;
    for (const [index, barrier] of barriers.entries()) {
      const turn = index + 1;
      const request = await exhaustion.provider.waitForRequest(index * 2 + 1, t.signal);
      assertProviderRequest(request, index * 2 + 1, objective, `budget turn ${turn}`);
      const active = goalState(lastGoal(goalEntries(await getEntries(exhaustion)), "active budget"), "active budget");
      assert.equal(active.status, "active");
      assert.equal(active.turns, turn, "Each accepted decision authorizes exactly one next logical goal turn");
      assert.equal(active.maxTurns, 20);
      createdAt ??= active.createdAt;
      assert.equal(active.createdAt, createdAt, "All twenty turns retain the same goal identity");
      barrier.release();
      await exhaustion.rpc.waitFor((entry) => entry.type === "agent_settled", { after: cursor, signal: t.signal });
      if (turn === 20) assertIdle(await getState(exhaustion), "exhausted budget settlement");
      while (cursor < exhaustion.rpc.currentSequence) {
        const stored = await exhaustion.rpc.waitForRecord(() => true, { after: cursor, signal: t.signal });
        cursor = stored.sequence;
        if (stored.value.type === "extension_ui_request" && stored.value.method === "notify") {
          assert.notEqual(stored.value.notifyType, "warning", `Turn ${turn} must not issue a limit warning`);
          assert.notEqual(stored.value.notifyType, "error", `Turn ${turn} must accept its report`);
        }
      }
      acknowledgeBatch(exhaustion, `budget turn ${turn}`);
      cursor = exhaustion.rpc.currentSequence;
    }
    assertIdle(await getState(exhaustion), "exhausted budget settlement");
    const limitedEntry = lastGoal(goalEntries(await getEntries(exhaustion)), "default exhaustion");
    const limited = goalState(limitedEntry, "default exhaustion");
    assert.equal(limitedEntry.event, "limit");
    assert.equal(limited.status, "paused");
    assert.equal(limited.turns, 20);
    assert.equal(exhaustion.provider.requestCount, 40, "Twenty goal turns each use one decision and one native tool follow-up");
    acknowledgeBatch(exhaustion, "exhausted goal");
    cursor = exhaustion.rpc.currentSequence;
    const resumedBarrier = exhaustion.provider.holdNextRequest();
    await submitCommand(exhaustion, "/goal resume", "explicit budget renewal");
    await exhaustion.provider.waitForRequest(41, t.signal);
    const resumed = goalState(lastGoal(goalEntries(await getEntries(exhaustion)), "renewed budget"), "renewed budget");
    assert.equal(resumed.status, "active");
    assert.equal(resumed.maxTurns, 40);
    assert.equal(resumed.turns, 21);
    assert.equal(resumed.createdAt, createdAt);
    assert.equal(resumed.objective, objective);
    resumedBarrier.release();
    await waitForSettled(exhaustion, cursor, "explicitly renewed turn");
    assert.equal(exhaustion.provider.requestCount, 41);
    observations.push({ history: "default exhaustion and explicit renewal", logicalTurns: 21, providerRequests: 41,
      finalBudget: resumed.maxTurns, createdAtPreserved: true });
    acknowledgeBatch(exhaustion, "renewed goal settlement");

    for (const vector of [
      { label: "lowered-old-limit", turns: 50, maxTurns: 20, expectedBudget: 70 },
      { label: "complete-on-last-turn", turns: 19, maxTurns: 20, expectedBudget: 20 },
    ]) {
      const saved = savedLimitedGoal(`Budget history ${vector.label}`, vector.turns, vector.maxTurns);
      if (vector.label === "complete-on-last-turn") {
        saved.revision = 60;
        saved.turnPhase = "ready";
      }
      const fixture = await createFixture(directory, vector.label, t.signal, saved,
        vector.label === "complete-on-last-turn" ? "pause" : "limit");
      fixtures.push(fixture);
      assertIdle(await getState(fixture), `${vector.label} startup`);
      const before = goalEntries(await getEntries(fixture));
      assert.equal(goalState(lastGoal(before, vector.label), vector.label).turns, vector.turns);
      assert.equal(fixture.provider.requestCount, 0, "Restoring a paused goal cannot grant a turn");
      acknowledgeBatch(fixture, `${vector.label} startup`);
      const barrier = fixture.provider.queueGoalDecision({ status: "complete", evidence: "Verified all requested work" });
      const after = fixture.rpc.currentSequence;
      await submitCommand(fixture, "/goal resume", vector.label);
      await fixture.provider.waitForRequest(1, t.signal);
      const active = goalState(lastGoal(goalEntries(await getEntries(fixture)), vector.label), vector.label);
      assert.equal(active.status, "active");
      assert.equal(active.maxTurns, vector.expectedBudget);
      assert.equal(active.turns, vector.turns + 1);
      assert.equal(active.createdAt, saved.createdAt);
      assert.equal(active.objective, saved.objective);
      barrier.release();
      await waitForSettled(fixture, after, vector.label);
      const entries = goalEntries(await getEntries(fixture));
      const completed = goalState(lastGoal(entries, vector.label), vector.label);
      assert.equal(completed.status, "complete");
      assert.equal(completed.turns, vector.turns + 1);
      assert.equal(completed.maxTurns, vector.expectedBudget);
      assert.equal(entries.slice(before.length).some((entry) => entry.event === "limit"), false,
        "Accepted completion wins even on the last authorized turn");
      assert.equal(fixture.provider.requestCount, 2, "Completion makes only its decision and native tool follow-up requests");
      observations.push({ history: vector.label, logicalTurns: 1, providerRequests: 2, maxTurns: completed.maxTurns, turns: completed.turns });
      acknowledgeBatch(fixture, vector.label);
    }

    const saved = savedLimitedGoal("At the lifetime ceiling", 10_000, 10_000);
    const ceiling = await createFixture(directory, "lifetime-ceiling", t.signal, saved);
    fixtures.push(ceiling);
    assertIdle(await getState(ceiling), "lifetime ceiling startup");
    const before = goalEntries(await getEntries(ceiling));
    acknowledgeBatch(ceiling, "lifetime ceiling startup");
    const after = ceiling.rpc.currentSequence;
    await submitCommand(ceiling, "/goal resume", "lifetime ceiling");
    const notification = await ceiling.rpc.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify",
      { after, signal: t.signal });
    assert.match(stringField(notification, "message"), /lifetime limit.*Set a new objective/u);
    assert.equal(notification.notifyType, "warning");
    const finalEntries = goalEntries(await getEntries(ceiling));
    const final = goalState(lastGoal(finalEntries, "ceiling"), "ceiling");
    assert.equal(final.status, "paused");
    assert.equal(final.turns, 10_000);
    assert.equal(final.maxTurns, 10_000);
    assert.deepEqual(finalEntries, before, "Rejected lifetime renewal changes no durable goal entry");
    assert.equal(ceiling.provider.requestCount, 0);
    assertIdle(await getState(ceiling), "lifetime ceiling command completion");
    observations.push({ history: "lifetime ceiling", providerRequests: 0, turns: final.turns });
    acknowledgeBatch(ceiling, "lifetime ceiling command");
  } catch (error) { errors.push(error); }
  for (const fixture of fixtures) errors.push(...await closeFixture(fixture));
  const diagnostics = JSON.stringify({ observations, fixtures: fixtureDiagnostics(fixtures) });
  let report: unknown;
  if (errors.length) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-budgets-failure-"));
    try { throwScenarioFailure({ directory: failureDirectory, message: "goals.turn-limits failed", errors, diagnostics }); }
    catch (error) { report = error; }
  }
  try { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...errors, ...(report === undefined ? [] : [report])], "goals.turn-limits failed");
  assert.equal(fixtures.length, 4);
  assert.deepEqual(fixtures.map((fixture) => fixture.provider.requestCount), [41, 2, 2, 0]);
  t.diagnostic(JSON.stringify({ scenarioId: "goals.turn-limits", piLaunches: 4, providerRequests: 45,
    naturalExits: 4, observations, ownedScratchRemoved: true }));
});

// ---------------------------------------------------------------------------
// Catalog ID: goals.tool-contract.
// ---------------------------------------------------------------------------

const goalUpdateStatusSchema = {
  type: "string",
  enum: ["complete", "continue", "blocked"],
  description: "Record an active-goal decision, or complete a blocked goal during an eligible later ordinary request",
};

function providerGoalTool(request: ProviderRequest, label: string): RecordValue {
  const tools = records(request.body.tools ?? [], `${label} provider tools`);
  const entry = tools.find((tool) => stringField(record(tool.function, `${label} tool entry`), "name") === "killeros_goal_update");
  assert.ok(entry, `${label}: the goal tool must be declared to the model while authorized`);
  return record(entry.function, `${label} goal tool declaration`);
}

function codemodeScriptCall(code: string): ProviderToolCall {
  return { name: "codemode", arguments: { code } };
}

test("the goal tool is model-only, schema-bounded, and sequential", { timeout: 240_000, skip: piRpcShutdownSkip }, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-goal-tool-contract-"));
  const fixtures: PiFixture[] = [];
  const observations: RecordValue[] = [];
  const errors: unknown[] = [];
  const controlDirectory = path.join(directory, "tool-barrier");
  mkdirSync(controlDirectory);
  const planFile = path.join(controlDirectory, "plan.json");
  const barrierExtension = path.join(directory, "goal-tool-barrier.ts");
  writeFileSync(barrierExtension, toolBarrierExtensionSource);

  try {
    for (let ancestor = realpathSync(directory); ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false, `fixture must not discover Git at ${ancestor}`);
      if (path.dirname(ancestor) === ancestor) break;
    }
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(directory, "node_modules"), "junction");
    // One ordinary RPC process: provider-visible registration, valid shapes, invalid statuses, two-call serialization.
    const ordinary = await createFixture(directory, "ordinary", t.signal, undefined, "limit", "killeros_goal_update",
      { extensions: [barrierExtension], env: { KILLEROS_GOAL_TOOL_BARRIER: controlDirectory } });
    fixtures.push(ordinary);
    await initializeFixture(ordinary);

    // Registration fields: the tool is declared while authorized, with the exact status schema.
    // The three valid shapes run as one authorized-turn chain, matching Pi's decision-follow-up loop.
    const validShapes = [
      { label: "continue shape", decision: { status: "continue", evidence: "The first shape passed", nextAction: "Run the blocked shape next" },
        resultText: "Model-reported progress recorded; the goal remains active: The first shape passed", event: "continue" },
      { label: "blocked shape", decision: { status: "blocked", evidence: "The blocked shape evidence", blockerKey: "schema-blocker" },
        resultText: "Blocker audit 1/3 recorded; the goal remains active: The blocked shape evidence", event: "blocker-audit" },
      { label: "complete shape", decision: { status: "complete", evidence: "The complete shape evidence" },
        resultText: "Goal marked complete (model-reported): The complete shape evidence", event: "complete" },
    ] as const;
    const shapeBarriers: ProviderBarrier[] = [];
    for (const shape of validShapes) {
      // Interleave each turn's held decision with the plain follow-up response Pi sends after executing it.
      shapeBarriers.push(ordinary.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: { ...shape.decision } }]));
      ordinary.provider.queueStop();
    }
    let cursor = ordinary.rpc.currentSequence;
    await submitCommand(ordinary, "/goal Validate the goal tool contract", "schema");
    await waitForNotification(ordinary, cursor, startNotice, "info", "schema");
    for (const [index, shape] of validShapes.entries()) {
      const requestIndex = index * 2 + 1;
      const request = await ordinary.provider.waitForRequest(requestIndex, t.signal);
      if (index === 0) {
        const declaration = providerGoalTool(request, "schema");
        const parameters = record(declaration.parameters, "schema parameters");
        assert.deepEqual(record(parameters.properties, "schema properties").status, goalUpdateStatusSchema,
          "the provider-visible status schema is exactly the documented string enum");
        assert.ok(Array.isArray(parameters.required), "the provider schema declares its required fields");
        assert.ok(parameters.required.includes("status") && parameters.required.includes("evidence"));
        assert.equal(parameters.required.includes("blockerKey"), false,
          "the blocked shape without a blocker key is schema-valid even though execution requires one");
        const messages = JSON.stringify(request.body.messages);
        assert.match(messages, /Validate the goal tool contract/u);
        assert.match(messages, /Active KillerOS goal/u);
        assert.match(messages, /KillerOS long-running goal turn/u);
        assert.match(messages, /killeros_goal_update/u);
        assert.match(messages, /exact objective above from \/goal/u);
        assert.match(messages, /first concrete next step after checking the current repository state/u);
        assert.doesNotMatch(messages, /hidden handoff|stored progress copy/u);
        const active = goalState(lastGoal(goalEntries(await getEntries(ordinary)), "initial goal"), "initial goal");
        assert.equal(active.status, "active");
        assert.equal(active.objective, "Validate the goal tool contract");
      }
      shapeBarriers[index].release();
      const followUp = await ordinary.provider.waitForRequest(requestIndex + 1, t.signal);
      assert.match(JSON.stringify(followUp.body.messages), new RegExp(shape.resultText.replace(/[()[\]/]/gu, "\\$&"), "u"),
        `${shape.label}: the decision must execute through the goal tool`);
      await ordinary.rpc.waitFor((entry) => entry.type === "agent_settled", { after: cursor, signal: t.signal });
      acknowledgeBatch(ordinary, shape.label);
      cursor = ordinary.rpc.currentSequence;
    }
    // The complete decision finished the goal: the last settled turn dispatched nothing further.
    assertIdle(await getState(ordinary), "valid shapes");
    const shapeEntries = goalEntries(await getEntries(ordinary));
    for (const shape of validShapes) assert.ok(goalEvent(shapeEntries, shape.event, shape.label));
    assert.equal(goalState(lastGoal(shapeEntries, "valid shapes"), "valid shapes").status, "complete");
    assert.equal(ordinary.provider.requestCount, 6, "three valid shapes use exactly six provider requests");
    const statusCursor = ordinary.rpc.currentSequence;
    await submitCommand(ordinary, "/goal", "completed status");
    const statusNotice = await ordinary.rpc.waitFor((entry) => entry.type === "extension_ui_request"
      && entry.method === "notify" && typeof entry.message === "string" && entry.message.includes("Goal complete"),
    { after: statusCursor, timeoutMs: 15_000, signal: t.signal });
    assert.equal(statusNotice.notifyType, "info");
    assert.match(stringField(statusNotice, "message"), /The complete shape evidence/u);
    assert.equal(ordinary.provider.requestCount, 6, "status lookup does not start another request");
    observations.push({ history: "valid shapes", providerRequests: 6 });
    acknowledgeBatch(ordinary, "valid shapes");

    // Invalid statuses are rejected at the schema boundary without recording a decision.
    for (const [index, status] of [["active"], ["paused"], ["Complete"], [""], [null], [0]].entries()) {
      const label = `invalid status ${index + 1}: ${String(status)}`;
      await assertFreshSession(ordinary, label);
      const beforeRequests: number = ordinary.provider.requestCount;
      const barrier = ordinary.provider.holdToolCalls([
        { name: "killeros_goal_update", arguments: { status: status[0], evidence: "Invalid shape evidence" } },
      ]);
      const invalidCursor = ordinary.rpc.currentSequence;
      await submitCommand(ordinary, "/goal Reject the invalid status shape", label);
      await ordinary.provider.waitForRequest(beforeRequests + 1, t.signal);
      barrier.release();
      const rejected = await ordinary.provider.waitForRequest(beforeRequests + 2, t.signal);
      assert.match(JSON.stringify(rejected.body.messages), /Validation failed for tool/u,
        `${label}: the schema must reject the shape before execution`);
      await waitForSettled(ordinary, invalidCursor, label);
      const entries = goalEntries(await getEntries(ordinary));
      assert.equal(entries.some((entry) => ["continue", "blocker-audit", "blocked", "complete"].includes(entry.event)), false,
        `${label}: no decision may be recorded`);
      assert.equal(goalState(lastGoal(entries, label), label).status, "paused", `${label}: the turn settles paused without a decision`);
      assert.equal(ordinary.provider.requestCount, beforeRequests + 2, `${label}: exactly one goal request and one follow-up`);
      acknowledgeBatch(ordinary, label);
      await assertFreshSession(ordinary, `${label} reset`);
    }
    observations.push({ history: "invalid statuses", vectors: 6, providerRequests: 12 });

    const invalidBlockerKeys = [undefined, "", "UPPERCASE", "contains whitespace", `x${"y".repeat(120)}`];
    const blockersBefore = ordinary.provider.requestCount;
    const blockersCursor = ordinary.rpc.currentSequence;
    const invalidBlockers = ordinary.provider.holdToolCalls(invalidBlockerKeys.map((blockerKey) => ({
      name: "killeros_goal_update", arguments: { status: "blocked", evidence: "Still blocked",
        ...(blockerKey === undefined ? {} : { blockerKey }) },
    })));
    await submitCommand(ordinary, "/goal Reject malformed blocker audit keys", "invalid blocker keys");
    await ordinary.provider.waitForRequest(blockersBefore + 1, t.signal);
    invalidBlockers.release();
    await ordinary.provider.waitForRequest(blockersBefore + 2, t.signal);
    await waitForSettled(ordinary, blockersCursor, "invalid blocker keys");
    const blockerEntries = await getEntries(ordinary);
    const blockerResults = blockerEntries.filter(entry => entry.type === "message"
      && isRecordValue(entry.message) && entry.message.role === "toolResult")
      .map(entry => record(entry.message, "invalid blocker result"));
    assert.equal(blockerResults.length, invalidBlockerKeys.length);
    for (const result of blockerResults) {
      assert.equal(result.isError, true, "Every malformed blocker key is rejected by the real tool boundary");
      assert.match(JSON.stringify(result.content), /Validation failed for tool|stable lowercase blockerKey/u);
    }
    assert.equal(goalEntries(blockerEntries).some(entry => ["continue", "blocker-audit", "blocked", "complete"].includes(entry.event)), false,
      "Malformed blocker keys never persist an accepted decision");
    assert.equal(ordinary.provider.requestCount, blockersBefore + 2);
    acknowledgeBatch(ordinary, "invalid blocker keys");
    observations.push({ history: "invalid blocker keys", vectors: invalidBlockerKeys.length, providerRequests: 2 });

    // Two queued goal calls in one assistant message execute sequentially under the public tool_call barrier.
    await assertFreshSession(ordinary, "two-call serialization");
    const serialBeforeRequests = ordinary.provider.requestCount;
    writeFileSync(planFile, JSON.stringify({ mode: "hold-first" }));
    const serialCursor = ordinary.rpc.currentSequence;
    const serialBarrier = ordinary.provider.holdToolCalls([
      { name: "killeros_goal_update", arguments: { status: "continue", evidence: "First queued decision", nextAction: "Finish the serialization proof" } },
      { name: "killeros_goal_update", arguments: { status: "complete", evidence: "Second queued decision" } },
    ]);
    await submitCommand(ordinary, "/goal Prove sequential queued goal execution", "two-call serialization");
    await ordinary.provider.waitForRequest(serialBeforeRequests + 1, t.signal);
    serialBarrier.release();
    await waitForControlFile(path.join(controlDirectory, "first-entered.json"), t.signal, "two-call first entry");
    // The child blocks inside the acknowledged barrier, so the durable check reads the owned session file directly.
    const heldEntries = await readSessionGoalEntries(ordinary.currentSessionFile);
    assert.equal(heldEntries.some((entry) => entry.event === "continue" || entry.event === "complete"), false,
      `the held first call must not have executed before release: ${JSON.stringify(heldEntries)}`);
    writeFileSync(path.join(controlDirectory, "tool-release"), "release");
    const secondEntry = await waitForControlFile(path.join(controlDirectory, "second-entered.json"), t.signal, "two-call second entry");
    assert.equal(secondEntry.afterRelease, true, "the second queued call may enter only after the first was released");
    const serialFollowUp = await ordinary.provider.waitForRequest(serialBeforeRequests + 2, t.signal);
    const serialMessages = JSON.stringify(serialFollowUp.body.messages);
    const firstResult = serialMessages.indexOf("Model-reported progress recorded; the goal remains active: First queued decision");
    const secondResult = serialMessages.indexOf("Only one goal decision may be accepted per logical goal turn");
    assert.ok(firstResult >= 0, "the first queued call records its continue decision");
    assert.ok(secondResult >= 0, "the second queued call is rejected as a second decision for the same logical turn");
    assert.ok(firstResult < secondResult, "the first call's result precedes the second call's rejection");
    await ordinary.provider.waitForRequest(serialBeforeRequests + 3, t.signal);
    await waitForSettled(ordinary, serialCursor, "two-call serialization");
    const serialEntries = goalEntries(await getEntries(ordinary));
    const serialState = goalState(lastGoal(serialEntries, "two-call serialization"), "two-call serialization");
    assert.equal(serialState.status, "paused");
    assert.equal(serialState.turns, 2, "exactly one accepted decision authorized exactly one next turn");
    assert.equal(ordinary.provider.requestCount, serialBeforeRequests + 3, "the two-call turn uses three provider requests");
    writeFileSync(planFile, JSON.stringify({}));
    acknowledgeBatch(ordinary, "two-call serialization");
    observations.push({ history: "two-call serialization", providerRequests: 3, secondEnteredAfterRelease: true });

    // One codemode-enabled process: the goal tool stays model-visible but is unreachable from scripts.
    const codemode = await createFixture(directory, "codemode", t.signal, undefined, "limit", "read,killeros_goal_update,codemode",
      { extensions: ["builtin:codemode"] });
    fixtures.push(codemode);
    await initializeFixture(codemode);
    const script = [
      "let outcome;",
      "try {",
      "  await tools.killeros_goal_update({ status: \"complete\", evidence: \"script attempted completion\" });",
      "  outcome = JSON.stringify({ callable: true });",
      "} catch (error) {",
      "  outcome = JSON.stringify({ callable: false, error: String(error && error.message) });",
      "}",
      "return outcome;",
    ].join("\n");
    const scriptBarrier = codemode.provider.holdToolCalls([codemodeScriptCall(script)]);
    const scriptCursor = codemode.rpc.currentSequence;
    await submitCommand(codemode, "/goal Keep the goal tool out of codemode scripts", "codemode exposure");
    const scriptRequest = await codemode.provider.waitForRequest(1, t.signal);
    const scriptDeclaration = providerGoalTool(scriptRequest, "codemode exposure");
    assert.deepEqual(record(record(scriptDeclaration.parameters, "codemode schema parameters").properties, "codemode schema properties").status,
      goalUpdateStatusSchema, "the goal tool remains model-visible with its documented schema beside codemode");
    assert.ok(records(scriptRequest.body.tools, "codemode tools").some((tool) => stringField(record(tool.function, "codemode tool entry"), "name") === "codemode"),
      `the codemode tool must be declared in the same request: ${JSON.stringify(records(scriptRequest.body.tools, "codemode tools").map((tool) => stringField(record(tool.function, "codemode tool entry"), "name")))}`);
    scriptBarrier.release();
    const scriptFollowUp = await codemode.provider.waitForRequest(2, t.signal);
    const scriptMessages = JSON.stringify(scriptFollowUp.body.messages);
    assert.match(scriptMessages, /Script completed/u, "the codemode script must run through the real codemode tool");
    assert.match(scriptMessages, /\\"callable\\":false/u, "the script must not reach the goal tool");
    assert.doesNotMatch(scriptMessages, /\\"callable\\":true/u, "the goal tool must stay unavailable to scripts");
    await waitForSettled(codemode, scriptCursor, "codemode exposure");
    const codemodeEntries = goalEntries(await getEntries(codemode));
    assert.equal(codemodeEntries.some((entry) => ["continue", "blocker-audit", "blocked", "complete"].includes(entry.event)), false,
      "the script must not record a goal decision");
    assert.equal(goalState(lastGoal(codemodeEntries, "codemode exposure"), "codemode exposure").status, "paused");
    assert.equal(codemode.provider.requestCount, 2);
    observations.push({ history: "codemode exposure", providerRequests: 2, scriptCallable: false });
    acknowledgeBatch(codemode, "codemode exposure");

    assert.equal(fixtures.length, 2);
    assert.deepEqual(fixtures.map((fixture) => fixture.provider.requestCount), [23, 2]);
    assert.deepEqual(ordinary.provider.faults, []);
    assert.deepEqual(codemode.provider.faults, []);
    t.diagnostic(JSON.stringify({ scenarioId: "goals.tool-contract", piLaunches: 2, providerRequests: 25,
      naturalExits: 2, observations, ownedScratchRemoved: true }));
  } catch (error) {
    errors.push(error);
  }
  const diagnostics = JSON.stringify({ observations, fixtures: fixtureDiagnostics(fixtures) });
  for (const fixture of fixtures) errors.push(...await closeFixture(fixture));
  let report: unknown;
  if (errors.length) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-tool-contract-failure-"));
    try { throwScenarioFailure({ directory: failureDirectory, message: "goals.tool-contract failed", errors, diagnostics }); }
    catch (error) { report = error; }
  }
  try { if (errors.length === 0) { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); } }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...errors, ...(report === undefined ? [] : [report])], "goals.tool-contract failed");
});

// ---------------------------------------------------------------------------
// Catalog ID: goals.panel-tui.
// ---------------------------------------------------------------------------

function screenLines(screen: string): string[] {
  return screen.split("\n").map((line) => line.trimEnd());
}

function panelOptionLine(screen: string, option: string): string | undefined {
  return screenLines(screen).find((line) => line.includes(option));
}

test("the TUI goal panel offers only actions valid for the saved status", { timeout: 240_000 }, async (t) => {
  const directory = await isolatedGoalRoot("killeros-goal-panel-");
  let terminalFixture: TerminalFixture | undefined;
  let primaryError: unknown;
  const screens: Record<string, string> = {};
  const cleanupErrors: unknown[] = [];
  const objective = "Panel objective";
  const panelSeed = (status: "paused" | "blocked" | "complete") => {
    const now = Date.now();
    return { version: 1, revision: 1, objective: `${status} objective`, status,
      createdAt: now, updatedAt: now, activeMilliseconds: 0, turns: 3,
      blockedAuditStartTurn: 0, baselineTokens: 0, ...(status === "paused" ? {} : { result: "verified" }) };
  };
  try {
    const fixture = await createTerminalFixture({
      directory,
      label: "panel",
      signal: t.signal,
      seededSessions: [
        { state: panelSeed("paused"), event: "paused" },
        { state: panelSeed("blocked"), event: "blocked" },
        { state: panelSeed("complete"), event: "complete" },
      ],
    });
    terminalFixture = fixture;
    const terminal = fixture.terminal;
    const bellsAtStart = terminal.bellCount;

    // Active panel while the goal's first turn is in flight at the held provider barrier.
    fixture.provider.holdPartialResponse("Working on the panel objective.");
    let cursor = submitTerminalLine(fixture, `/goal ${objective}`);
    await terminal.waitForScreen(
      (screen) => screen.includes("/goal active") && screen.includes(`Goal started · ${objective}`),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    await fixture.provider.waitForRequest(1, t.signal);

    cursor = submitTerminalLine(fixture, "/goal");
    screens.activePanel = await terminal.waitForScreen(
      (screen) => screen.includes("Goal active · 1/20 turns") && screen.includes("Pause goal") && screen.includes("Clear goal"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    const activePanelLines = screenLines(screens.activePanel);
    const activeTitleIndex = activePanelLines.findIndex((line) => line.includes("Goal active · 1/20 turns"));
    assert.ok(activeTitleIndex >= 0, "the active panel title carries the status heading");
    assert.equal(activePanelLines[activeTitleIndex + 1]?.trim(), objective, "the objective renders on its own line below the status");
    assert.equal(panelOptionLine(screens.activePanel, "Resume goal"), undefined, "an active goal offers no resume");
    assert.equal(terminal.bellCount, bellsAtStart, "opening the active panel must not ring the terminal bell");

    // Selecting Pause saves status=paused durably and aborts the in-flight turn once.
    const pauseRequest = await fixture.provider.waitForRequest(1, t.signal);
    terminal.write("\x1b[13u");
    screens.afterPause = await terminal.waitForScreen(
      (screen) => screen.includes("/goal paused") && !screen.includes("Pause goal"),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    const pauseOutcome = await pauseRequest.completion;
    assert.equal(pauseOutcome, "closed", "pausing during the active turn must abort it");
    assert.equal(fixture.provider.requestCount, 1, "the paused goal must not dispatch another request");
    const pauseEntries = await waitForSessionGoalEntries(
      fixture.sessionFile,
      (entries) => entries.at(-1)?.event === "pause" && entries.at(-1)?.state?.status === "paused",
      t.signal,
      "panel pause durability",
    );
    assert.equal(pauseEntries.at(-1)?.state?.objective, objective);

    // The paused panel offers resume and clear.
    cursor = submitTerminalLine(fixture, "/goal");
    screens.pausedPanel = await terminal.waitForScreen(
      (screen) => screen.includes("Goal paused") && screen.includes("Resume goal") && screen.includes("Clear goal"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    assert.equal(panelOptionLine(screens.pausedPanel, "Pause goal"), undefined, "a paused goal offers no pause");

    // Resume through the panel dispatches one continuation.
    terminal.write("\x1b[13u");
    const resumeBarrier = fixture.provider.holdPartialResponse("Resumed work on the panel objective.");
    void resumeBarrier;
    screens.afterResume = await terminal.waitForScreen(
      (screen) => screen.includes("/goal active") && !screen.includes("Resume goal"),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    const resumeRequest = await fixture.provider.waitForRequest(2, t.signal);
    let resumeRequestSettled = false;
    void resumeRequest.completion.then(() => { resumeRequestSettled = true; });
    assert.match(JSON.stringify(resumeRequest.body.messages), /Turn: 2/u, "resuming the paused goal starts its next turn");
    const resumeEntries = await waitForSessionGoalEntries(
      fixture.sessionFile,
      (entries) => entries.some((entry) => entry.event === "resume" && entry.state?.status === "active"),
      t.signal,
      "panel resume durability",
    );
    assert.equal(resumeEntries.at(-1)?.state?.objective, objective);

    // Clear confirmation: cancel changes nothing and aborts nothing.
    cursor = submitTerminalLine(fixture, "/goal");
    await terminal.waitForScreen(
      (screen) => screen.includes("Pause goal") && screen.includes("Clear goal"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    terminal.write("\x1b[B");
    cursor = terminal.sequence;
    terminal.write("\x1b[13u");
    screens.clearConfirm = await terminal.waitForScreen(
      (screen) => screen.includes("Clear goal?") && screen.includes("Yes") && screen.includes("No"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    assert.ok(screenLines(screens.clearConfirm).some((line) => line.trim() === objective),
      `the clear confirmation quotes the objective: ${JSON.stringify(screenLines(screens.clearConfirm).slice(0, 24))}`);
    const requestsBeforeCancel = fixture.provider.requestCount;
    terminal.write("\x1b");
    screens.afterCancel = await terminal.waitForScreen(
      (screen) => screen.includes("/goal active") && !screen.includes("Clear goal?") && !screen.includes("Pause goal"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    assert.equal(fixture.provider.requestCount, requestsBeforeCancel, "cancelling the clear must not abort the active turn");
    const cancelEntries = await readSessionGoalEntries(fixture.sessionFile);
    assert.equal(cancelEntries.some((entry) => entry.event === "clear"), false, "cancelling the clear must not persist");
    assert.equal(resumeRequestSettled, false, "cancelling the clear must leave the active provider request open");

    // Accepting the same confirmation clears the goal and aborts the in-flight turn once.
    cursor = submitTerminalLine(fixture, "/goal");
    await terminal.waitForScreen(
      (screen) => screen.includes("Pause goal") && screen.includes("Clear goal"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    terminal.write("\x1b[B");
    cursor = terminal.sequence;
    terminal.write("\x1b[13u");
    await terminal.waitForScreen(
      (screen) => screen.includes("Clear goal?") && screen.includes("Yes"),
      { signal: t.signal, after: cursor, timeoutMs: 15_000 },
    );
    terminal.write("\x1b[13u");
    screens.afterClearAccept = await terminal.waitForScreen(
      (screen) => !screen.includes("Clear goal?") && !screen.includes("/goal active") && !screen.includes("Pause goal"),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    const acceptOutcome = await resumeRequest.completion;
    assert.equal(acceptOutcome, "closed", "the accepted clear aborts the active goal turn once");
    assert.equal(fixture.provider.requestCount, 2, "the cleared goal must not dispatch further requests");
    const clearEntries = await waitForSessionGoalEntries(
      fixture.sessionFile,
      (entries) => entries.at(-1)?.event === "clear" && entries.at(-1)?.state === null,
      t.signal,
      "panel clear durability",
    );
    assert.ok(clearEntries.at(-1));

    // Direct clear clears without any panel or confirmation dialog.
    const directBarrier = fixture.provider.holdPartialResponse("Working on the direct objective.");
    void directBarrier;
    cursor = submitTerminalLine(fixture, "/goal Direct clear objective");
    await terminal.waitForScreen(
      (screen) => screen.includes("/goal active") && screen.includes("Goal started · Direct clear objective"),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    const directRequest = await fixture.provider.waitForRequest(3, t.signal);
    cursor = submitTerminalLine(fixture, "/goal clear");
    screens.afterDirectClear = await terminal.waitForScreen(
      (screen) => !screen.includes("/goal active") && !screen.includes("Clear goal?") && !screen.includes("Pause goal"),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    assert.equal(await directRequest.completion, "closed", "the direct clear stops the active goal turn");
    await waitForSessionGoalEntries(
      fixture.sessionFile,
      (entries) => entries.at(-1)?.event === "clear" && entries.at(-1)?.state === null
        && entries.some((entry) => entry.event === "set" && entry.state?.objective === "Direct clear objective"),
      t.signal,
      "direct clear durability",
    );
    assert.equal(terminal.bellCount, bellsAtStart, "the whole panel flow must not ring the terminal bell");

    // Restored paused, blocked, and complete goals open status-valid panels.
    for (const [index, seeded] of [
      { label: "paused", footer: "/goal paused", first: "Resume goal", second: "Clear goal", objective: "paused objective" },
      { label: "blocked", footer: "/goal blocked", first: "Resume goal", second: "Clear goal", objective: "blocked objective" },
      { label: "complete", footer: "", first: "Clear goal", second: undefined, objective: "complete objective" },
    ].entries()) {
      cursor = submitTerminalLine(fixture, `/fixture-goal-session ${index}`);
      // The withSession marker lands durably in the seeded file once the replacement settled.
      await waitForSessionCustomEntry(fixture.extraSessionFiles[index], "goals-e2e-fixture", "ready", index, t.signal,
        `panel session switch marker ${index}`);
      cursor = submitTerminalLine(fixture, "/goal");
      screens[`${seeded.label}Panel`] = await terminal.waitForScreen(
        (screen) => screen.includes(`Goal ${seeded.label}`) && screen.includes(seeded.first)
          && (seeded.second === undefined || screen.includes(seeded.second)),
        { signal: t.signal, after: cursor, timeoutMs: 15_000 },
      );
      const panelText = screens[`${seeded.label}Panel`];
      assert.ok(panelOptionLine(panelText, seeded.first), `${seeded.label} panel offers ${seeded.first}`);
      assert.equal(panelOptionLine(panelText, "Pause goal"), undefined, `${seeded.label} panel offers no pause`);
      if (seeded.second === undefined) {
        assert.equal(panelOptionLine(panelText, "Resume goal"), undefined, "a complete goal offers no resume");
        assert.match(panelText, /verified/u, "the complete panel shows the recorded result");
      }
      const panelLines = screenLines(panelText);
      const titleIndex = panelLines.findIndex((line) => line.includes(`Goal ${seeded.label} · 3 turns`));
      assert.ok(titleIndex >= 0, `${seeded.label} panel renders its status heading`);
      assert.equal(panelLines[titleIndex + 1]?.trim(), seeded.objective, `${seeded.label} panel quotes the objective on its own line`);
      terminal.write("\x1b");
      await terminal.waitForScreen(
        (screen) => !screen.includes(seeded.first),
        { signal: t.signal, after: cursor, timeoutMs: 15_000 },
      );
    }
    assert.equal(terminal.bellCount, bellsAtStart, "restored panels must not ring the terminal bell");
    for (const [name, screen] of Object.entries(screens)) {
      assert.equal(screen.includes("\u0007"), false, `${name}: no bell character in panel text`);
      assert.equal(screen.includes("\u0000"), false, `${name}: no NUL byte in panel text`);
    }
  } catch (error) {
    primaryError = error;
  }
  const runtimeDiagnostics = JSON.stringify({ screens, provider: terminalFixture?.provider.summary() ?? null,
    terminal: terminalFixture?.terminal.diagnostics() ?? "not started" }).slice(0, 60_000);
  if (terminalFixture) cleanupErrors.push(...await closeTerminalFixture(terminalFixture));
  const errors = [ ...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors ];
  try { if (errors.length === 0) { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); } }
  catch (error) { errors.push(error); }
  if (errors.length) {
    try {
      throwScenarioFailure({
        directory: mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-panel-failure-")),
        message: "goals.panel-tui failed",
        errors,
        diagnostics: runtimeDiagnostics,
      });
    } catch { /* the aggregate error below still carries the primary failure */ }
    throw new AggregateError(errors, "goals.panel-tui failed");
  }
  t.diagnostic(JSON.stringify({ scenarioId: "goals.panel-tui", piLaunches: 1, providerRequests: terminalFixture?.provider.requestCount ?? 0,
    vectors: 7, cleanup: "natural", ownedScratchRemoved: true }));
});

// ---------------------------------------------------------------------------
// Catalog ID: goals.turn-authority.
// ---------------------------------------------------------------------------

function providerToolNames(request: ProviderRequest, label: string): string[] {
  // Pi omits the tools field entirely when nothing is declared to the model.
  return records(request.body.tools ?? [], `${label} provider tools`)
    .map((tool) => stringField(record(tool.function, `${label} tool entry`), "name"));
}

test("only an accepted goal decision advances or finishes a turn", { timeout: 300_000, skip: piRpcShutdownSkip }, async (t) => {
  const directory = await isolatedGoalRoot("killeros-goal-turn-authority-");
  const fixtures: PiFixture[] = [];
  const terminalFixtures: TerminalFixture[] = [];
  const observations: RecordValue[] = [];
  const errors: unknown[] = [];
  try {
    // RPC live decisions: activation, turn increments, duplicate rejection, completion, and removal.
    const live = await createFixture(directory, "rpc-live", t.signal);
    fixtures.push(live);
    await initializeFixture(live);
    const objective = "Ship only after every release check passes";
    const turn1Barrier = live.provider.holdNextRequest(); // request 1: the turn-1 goal request, answered plain (no decision)
    live.provider.queueStop(); // request 2: ordinary request while paused
    const continueBarrier = live.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "The release checks ran", nextAction: "Record the duplicate check",
    } }]); // request 3: turn 2 with the accepted continue decision
    live.provider.queueToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "complete", evidence: "Duplicate decision attempt",
    } }]); // request 4: the native tool follow-up responds with a duplicate decision
    live.provider.queueStop(); // request 5
    const completeBarrier = live.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "complete", evidence: "npm test and npm run check passed",
    } }]); // request 6: turn 3 with the accepted complete decision
    live.provider.queueStop(); // request 7
    live.provider.queueStop(); // request 8: ordinary request after completion

    let cursor = live.rpc.currentSequence;
    await submitCommand(live, `/goal ${objective}`, "live start");
    await waitForNotification(live, cursor, startNotice, "info", "live start");
    const turn1 = await live.provider.waitForRequest(1, t.signal);
    assert.ok(providerToolNames(turn1, "turn 1").includes("killeros_goal_update"), "the goal tool is active for an active goal");
    const turn1Messages = JSON.stringify(turn1.body.messages);
    assert.match(turn1Messages, /Status: active · Turn: 1/u, "the continuation enters turn 1");
    assert.match(turn1Messages, new RegExp(objective, "u"), "the goal turn carries the exact objective");
    assert.match(turn1Messages, /Active KillerOS goal/u, "before_agent_start injects the goal system prompt");
    turn1Barrier.release();
    const pauseNotify = await live.rpc.waitFor(
      (entry) => entry.type === "extension_ui_request" && entry.method === "notify"
        && typeof entry.message === "string" && entry.message.includes("Goal paused: no turn decision"),
      { after: cursor, timeoutMs: 20_000, signal: t.signal },
    );
    assert.equal(stringField(pauseNotify, "notifyType"), "error", "a no-decision stop pauses with an error notification");
    assert.match(stringField(pauseNotify, "message"), /Goal paused: no turn decision/u);
    assert.match(stringField(pauseNotify, "message"), /ended without choosing continue, complete, or blocked/u);
    await waitForSettled(live, cursor, "turn 1 no-decision settlement");
    const turn1Entries = goalEntries(await getEntries(live));
    const turn1State = goalState(lastGoal(turn1Entries, "turn 1"), "turn 1");
    assert.equal(turn1State.status, "paused");
    assert.equal(turn1State.stopReason, "no turn decision");
    assert.equal(turn1State.turns, 1);
    acknowledgeBatch(live, "turn 1 no-decision settlement");

    cursor = live.rpc.currentSequence;
    await submitPrompt(live, "Summarize the release checks", "ordinary while paused");
    const ordinary1 = await live.provider.waitForRequest(2, t.signal);
    assert.equal(providerToolNames(ordinary1, "ordinary while paused").includes("killeros_goal_update"), false,
      "settlement removes the goal tool from the model-visible set");
    await waitForSettled(live, cursor, "ordinary while paused");
    acknowledgeBatch(live, "ordinary while paused");

    cursor = live.rpc.currentSequence;
    await submitCommand(live, "/goal resume", "live resume");
    await waitForNotification(live, cursor, "Goal resumed", "info", "live resume");
    const turn2 = await live.provider.waitForRequest(3, t.signal);
    assert.ok(providerToolNames(turn2, "turn 2").includes("killeros_goal_update"), "resume reactivates the goal tool");
    assert.match(JSON.stringify(turn2.body.messages), /Status: active · Turn: 2/u, "each later turn increments exactly once");
    continueBarrier.release();
    const duplicateRequest = await live.provider.waitForRequest(5, t.signal);
    const duplicateMessages = JSON.stringify(duplicateRequest.body.messages);
    const acceptedResult = duplicateMessages.indexOf("Model-reported progress recorded; the goal remains active: The release checks ran");
    const duplicateResult = duplicateMessages.indexOf("Only one goal decision may be accepted per logical goal turn");
    assert.ok(acceptedResult >= 0, "the accepted continue decision records exactly one next turn");
    assert.ok(duplicateResult >= 0, "a duplicate decision in the same logical turn is rejected");
    assert.ok(acceptedResult < duplicateResult, "the accepted decision precedes the duplicate rejection");
    // The rejected duplicate settles the turn and dispatches exactly one authorized follow-up; Pi never idles between them.
    const turn3 = await live.provider.waitForRequest(6, t.signal);
    assert.match(JSON.stringify(turn3.body.messages), /Status: active · Turn: 3/u, "the accepted decision authorized exactly one next turn");
    assert.match(JSON.stringify(turn3.body.messages), /Record the duplicate check/u, "the accepted next action reaches the next goal turn");
    const duplicateEntries = goalEntries(await getEntries(live));
    const duplicateState = goalState(lastGoal(duplicateEntries, "duplicate decision"), "duplicate decision");
    assert.equal(duplicateState.status, "active", "the rejected duplicate leaves the accepted turn authorized");
    assert.equal(duplicateState.turnPhase, "in-flight");
    const continueResult = (await getEntries(live)).filter(entry => entry.type === "message")
      .map(entry => record(entry.message, "persisted message"))
      .find(message => message.role === "toolResult" && isRecordValue(message.details) && message.details.status === "continue");
    assert.ok(continueResult, "the actual accepted tool result retains status continue");
    assert.ok(duplicateEntries.every((entry) => entry.event !== "complete"), "the duplicate complete must not record");
    assert.equal(duplicateEntries.filter((entry) => entry.event === "continue").length, 1,
      "exactly one continue decision was accepted across the duplicate attempt");
    acknowledgeBatch(live, "duplicate decision settlement");

    cursor = live.rpc.currentSequence;
    completeBarrier.release();
    await waitForSettled(live, cursor, "completion settlement");
    const completedEntries = goalEntries(await getEntries(live));
    const completedState = goalState(lastGoal(completedEntries, "completion"), "completion");
    assert.equal(completedState.status, "complete");
    assert.equal(completedState.turns, 3);
    acknowledgeBatch(live, "completion settlement");

    cursor = live.rpc.currentSequence;
    await submitPrompt(live, "Confirm the goal is finished", "ordinary after completion");
    const ordinary2 = await live.provider.waitForRequest(8, t.signal);
    assert.equal(providerToolNames(ordinary2, "ordinary after completion").includes("killeros_goal_update"), false,
      "completion removes the goal tool");
    await waitForSettled(live, cursor, "ordinary after completion");
    assert.equal(live.provider.requestCount, 8, "the RPC live history issues exactly eight provider requests");
    observations.push({ history: "rpc-live", providerRequests: 8 });
    acknowledgeBatch(live, "ordinary after completion");

    // TUI live decisions through the native terminal.
    const tui = await createTerminalFixture({ directory, label: "tui-live", signal: t.signal });
    terminalFixtures.push(tui);
    const tuiContinueBarrier = tui.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "The terminal check passed", nextAction: "Finish the terminal objective",
    } }]);
    tui.provider.queueStop(); // follow-up
    const tuiTurn2Barrier = tui.provider.holdNextRequest(); // turn 2, answered plain (no decision)
    const tuiObjective = "Finish the terminal migration";
    cursor = submitTerminalLine(tui, `/goal ${tuiObjective}`);
    await tui.terminal.waitForScreen(
      (screen) => screen.includes("/goal active") && screen.includes(`Goal started · ${tuiObjective}`),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    const tuiTurn1 = await tui.provider.waitForRequest(1, t.signal);
    assert.ok(providerToolNames(tuiTurn1, "tui turn 1").includes("killeros_goal_update"));
    assert.match(JSON.stringify(tuiTurn1.body.messages), /Status: active · Turn: 1/u);
    tuiContinueBarrier.release();
    const tuiTurn2 = await tui.provider.waitForRequest(3, t.signal);
    assert.match(JSON.stringify(tuiTurn2.body.messages), /Status: active · Turn: 2/u);
    tuiTurn2Barrier.release();
    await tui.terminal.waitForScreen(
      (screen) => screen.includes("/goal paused") && screen.includes("Goal paused · no turn decision"),
      { signal: t.signal, after: cursor, timeoutMs: 30_000 },
    );
    assert.equal(tui.provider.requestCount, 3, "the TUI history issues exactly three provider requests");
    observations.push({ history: "tui-live", providerRequests: 3 });
    const tuiSessionEntries = await readSessionGoalEntries(tui.sessionFile);
    const tuiFinalState = tuiSessionEntries.at(-1);
    assert.ok(tuiFinalState, "the TUI session saved goal entries");
    assert.equal(tuiFinalState.state?.status, "paused", "the TUI goal settles paused without a decision");
    assert.ok(tuiSessionEntries.some((entry) => entry.event === "continue"), "the TUI continue decision was accepted");

    // Starting without an available goal tool appends a paused goal and sends zero requests.
    const excluded = await createTerminalFixture({
      directory, label: "excluded-tool", signal: t.signal, excludeTools: "killeros_goal_update",
    });
    terminalFixtures.push(excluded);
    const excludedObjective = "Do not dispatch without the goal tool";
    cursor = submitTerminalLine(excluded, `/goal ${excludedObjective}`);
    await excluded.terminal.waitForScreen(
      (screen) => screen.includes("/goal paused") && screen.includes("killeros_goal_update is unavailable"),
      { signal: t.signal, after: cursor, timeoutMs: 20_000 },
    );
    assert.equal(excluded.provider.requestCount, 0, "an unavailable goal tool must not start any request");
    const excludedEntries = await waitForSessionGoalEntries(
      excluded.sessionFile,
      (entries) => entries.at(-1)?.event === "error" && entries.at(-1)?.state?.status === "paused",
      t.signal,
      "excluded tool pause durability",
    );
    const excludedState = excludedEntries.at(-1)?.state;
    assert.equal(excludedState?.stopReason, "killeros_goal_update is unavailable", "the failure names the unavailable tool before turn 1");
    assert.equal(excludedState?.turns, 0);
    observations.push({ history: "excluded-tool", providerRequests: 0 });

    // A restored accepted continue authorization is consumed once.
    const restored = await createFixture(directory, "restored-authorization", t.signal,
      authorizedContinueGoalState("Restore the authorized objective"), "continue");
    fixtures.push(restored);
    // The restored authorization dispatches its turn during startup, so the request hold goes in first.
    restored.provider.holdNextRequest();
    await getState(restored);
    cursor = restored.rpc.currentSequence;
    const restoredTurn = await restored.provider.waitForRequest(1, t.signal);
    const restoredMessages = JSON.stringify(restoredTurn.body.messages);
    assert.match(restoredMessages, /Status: active · Turn: 2/u, "the restored authorization starts the authorized next turn");
    assert.match(restoredMessages, new RegExp("Restore the authorized objective", "u"));
    const consumedAuthorization = goalState(lastGoal(goalEntries(await getEntries(restored)), "consumed authorization"), "consumed authorization");
    assert.equal(consumedAuthorization.turns, 2);
    assert.equal(consumedAuthorization.turnPhase, "in-flight");
    restored.provider.releaseAll();
    await waitForSettled(restored, cursor, "restored authorization settlement");
    const restoredEntries = goalEntries(await getEntries(restored));
    const restoredState = goalState(lastGoal(restoredEntries, "restored"), "restored");
    assert.equal(restoredState.status, "paused", "the consumed authorization leaves the turn paused without a new decision");
    assert.equal(restoredState.turns, 2);
    assert.equal(restored.provider.requestCount, 1, "the restored authorization is consumed exactly once");
    acknowledgeBatch(restored, "restored authorization settlement");
    observations.push({ history: "restored-authorization", providerRequests: 1 });

    // Reopen the exact in-flight checkpoint produced by consuming the saved authorization.
    const consumed = await createFixture(directory, "restored-consumed-authorization", t.signal, consumedAuthorization, "turn");
    fixtures.push(consumed);
    assertIdle(await getState(consumed), "consumed authorization reopen");
    const consumedState = goalState(lastGoal(goalEntries(await getEntries(consumed)), "consumed reopen"), "consumed reopen");
    assert.equal(consumedState.status, "paused");
    assert.equal(consumedState.stopReason, "no turn decision");
    assert.equal(consumedState.turns, 2);
    await waitForNotification(consumed, 0,
      "Goal paused: no turn decision\nThe agent ended without choosing continue, complete, or blocked. Run /goal resume only after choosing to continue.", "error", "consumed reopen");
    assert.equal(consumed.provider.requestCount, 0, "a consumed saved authorization grants no second request");
    observations.push({ history: "restored-consumed-authorization", providerRequests: 0 });
    acknowledgeBatch(consumed, "consumed authorization reopen");

    // A restored unresolved turn pauses; blocked goals stay eligible only for verified completion.
    const unresolved = await createFixture(directory, "restored-unresolved-blocked", t.signal,
      unresolvedGoalTurnState("Restore the unresolved objective"), "turn");
    fixtures.push(unresolved);
    assertIdle(await getState(unresolved), "unresolved startup");
    assert.equal(unresolved.provider.requestCount, 0, "an unresolved restore grants no request");
    const unresolvedNotify = await unresolved.rpc.waitFor(
      (entry) => entry.type === "extension_ui_request" && entry.method === "notify",
      { after: 0, timeoutMs: 20_000, signal: t.signal },
    );
    assert.equal(stringField(unresolvedNotify, "notifyType"), "error");
    assert.match(stringField(unresolvedNotify, "message"), /no turn decision/u);
    acknowledgeBatch(unresolved, "unresolved startup");

    const blockedDecisions: ProviderBarrier[] = [];
    for (let index = 0; index < 3; index += 1) {
      // Interleave each held blocked decision with the plain follow-up response.
      blockedDecisions.push(unresolved.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
        status: "blocked", evidence: "The restored blocker remains", blockerKey: "restored-blocker",
      } }]));
      unresolved.provider.queueStop();
    }
    const blockedCompleteBarrier = unresolved.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "complete", evidence: "The blocked deliverable is verified complete",
    } }]);
    unresolved.provider.queueStop();
    unresolved.provider.queueStop();

    cursor = unresolved.rpc.currentSequence;
    await submitCommand(unresolved, "/goal resume", "unresolved resume");
    for (const turn of [2, 3, 4]) {
      await unresolved.provider.waitForRequest((turn - 2) * 2 + 1, t.signal);
      blockedDecisions[turn - 2].release();
      await unresolved.provider.waitForRequest((turn - 2) * 2 + 2, t.signal);
      await unresolved.rpc.waitFor((entry) => entry.type === "agent_settled", { after: cursor, signal: t.signal });
      acknowledgeBatch(unresolved, `blocked turn ${turn}`);
      cursor = unresolved.rpc.currentSequence;
    }
    const blockedEntries = goalEntries(await getEntries(unresolved));
    const blockedState = goalState(lastGoal(blockedEntries, "blocked"), "blocked");
    assert.equal(blockedState.status, "blocked", "three consecutive blocker audits mark the goal blocked");
    const audit = blockedState.blockerAudit === undefined ? undefined : record(blockedState.blockerAudit, "blocked audit");
    assert.equal(audit?.streak, 3);
    acknowledgeBatch(unresolved, "blocked status");

    cursor = unresolved.rpc.currentSequence;
    await submitPrompt(unresolved, "Check the blocked deliverable", "eligible blocked request");
    const eligible = await unresolved.provider.waitForRequest(7, t.signal);
    assert.ok(providerToolNames(eligible, "eligible blocked request").includes("killeros_goal_update"),
      "an eligible blocked goal reactivates the goal tool");
    assert.match(JSON.stringify(eligible.body.messages), /Blocked KillerOS goal/u, "the blocked system prompt reaches the model");
    blockedCompleteBarrier.release();
    await unresolved.provider.waitForRequest(8, t.signal);
    await waitForSettled(unresolved, cursor, "blocked completion settlement");
    const finishedEntries = goalEntries(await getEntries(unresolved));
    const finishedState = goalState(lastGoal(finishedEntries, "blocked completion"), "blocked completion");
    assert.equal(finishedState.status, "complete", "an eligible blocked goal completes through the goal tool");
    assert.equal(finishedState.turns, 4, "the eligible completion grants no additional turn");
    acknowledgeBatch(unresolved, "blocked completion settlement");

    cursor = unresolved.rpc.currentSequence;
    await submitPrompt(unresolved, "Confirm completion", "ordinary after blocked completion");
    const ordinary3 = await unresolved.provider.waitForRequest(9, t.signal);
    assert.equal(providerToolNames(ordinary3, "ordinary after blocked completion").includes("killeros_goal_update"), false);
    await waitForSettled(unresolved, cursor, "ordinary after blocked completion");
    assert.equal(unresolved.provider.requestCount, 9, "the blocked history issues exactly nine provider requests");
    observations.push({ history: "restored-unresolved-blocked", providerRequests: 9 });
    acknowledgeBatch(unresolved, "ordinary after blocked completion");

    assert.equal(fixtures.length, 4);
    assert.deepEqual(fixtures.map((fixture) => fixture.provider.requestCount), [8, 1, 0, 9]);
    assert.equal(terminalFixtures.length, 2);
  } catch (error) {
    errors.push(error);
  }
  const runtimeDiagnostics = JSON.stringify({ observations, fixtures: fixtureDiagnostics(fixtures) }).slice(0, 40_000);
  for (const fixture of fixtures) errors.push(...await closeFixture(fixture));
  for (const terminal of terminalFixtures) errors.push(...await closeTerminalFixture(terminal));
  let report: unknown;
  if (errors.length) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-turn-authority-failure-"));
    try { throwScenarioFailure({ directory: failureDirectory, message: "goals.turn-authority failed", errors, diagnostics: runtimeDiagnostics }); }
    catch (error) { report = error; }
  }
  try { if (errors.length === 0) { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); } }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...errors, ...(report === undefined ? [] : [report])], "goals.turn-authority failed");
  t.diagnostic(JSON.stringify({ scenarioId: "goals.turn-authority", piLaunches: fixtures.length + terminalFixtures.length,
    providerRequests: 21, naturalExits: fixtures.length + terminalFixtures.length, observations, ownedScratchRemoved: true }));
});

// ---------------------------------------------------------------------------
// Catalog ID: goals.dispatch-gates.
// ---------------------------------------------------------------------------

test("continuation dispatch respects idle, pending, and cancellation gates", { timeout: 300_000, skip: piRpcShutdownSkip }, async (t) => {
  const directory = await isolatedGoalRoot("killeros-goal-dispatch-gates-");
  const fixtures: PiFixture[] = [];
  const terminalFixtures: TerminalFixture[] = [];
  const observations: RecordValue[] = [];
  const errors: unknown[] = [];
  try {
    // RPC gates workflow: notices, unrelated active run, pending message, repeated continue normalization.
    const gates = await createFixture(directory, "rpc-gates", t.signal);
    fixtures.push(gates);
    await initializeFixture(gates);
    const gatesObjective = "Gate the continuation dispatch";
    const g1 = gates.provider.holdNextRequest(); // r1: turn 1, plain (paused)
    const g2 = gates.provider.holdNextRequest(); // r2: turn 2 after resume, plain (paused)
    const g3 = gates.provider.holdNextRequest(); // r3: unrelated ordinary run
    const g4 = gates.provider.holdNextRequest(); // r4: the goal continuation dispatched after the run settles
    const g5 = gates.provider.holdNextRequest(); // r5: pending-message ordinary run
    const g6 = gates.provider.holdNextRequest(); // r6: the queued follow-up turn
    const g7 = gates.provider.holdNextRequest(); // r7: the goal continuation dispatched after the pending message settles
    const r8 = gates.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "Same evidence", nextAction: "Same next action",
    } }]); // r8: turn 1 of the repeated-report goal
    gates.provider.queueStop(); // r9
    const r10 = gates.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "  Same evidence\r\n", nextAction: "Same next action",
    } }]); // r10: turn 2 with the normalized duplicate report
    gates.provider.queueStop(); // r11

    // RPC reports Goal started, Goal paused, and Goal resumed.
    let cursor = gates.rpc.currentSequence;
    await submitCommand(gates, `/goal ${gatesObjective}`, "gates start");
    await waitForNotification(gates, cursor, startNotice, "info", "gates start");
    await gates.provider.waitForRequest(1, t.signal);
    g1.release();
    const pauseCommandCursor = gates.rpc.currentSequence;
    await submitCommand(gates, "/goal pause", "gates pause");
    await waitForNotification(gates, pauseCommandCursor, pauseNotice, "info", "gates pause");
    await waitForSettled(gates, cursor, "gates pause");
    acknowledgeBatch(gates, "gates pause");
    cursor = gates.rpc.currentSequence;
    await submitCommand(gates, "/goal resume", "gates resume");
    await waitForNotification(gates, cursor, "Goal resumed", "info", "gates resume");
    await gates.provider.waitForRequest(2, t.signal);
    g2.release();
    await waitForSettled(gates, cursor, "gates resume");
    acknowledgeBatch(gates, "gates resume");

    // A goal started during an unrelated active run sends nothing until agent_settled, then exactly one continuation.
    cursor = gates.rpc.currentSequence;
    await submitPrompt(gates, "Unrelated ordinary work", "unrelated run");
    const unrelatedCursor = gates.rpc.currentSequence;
    await gates.provider.waitForRequest(3, t.signal);
    // The goal command waits for the active run, so its response resolves only after settlement.
    const unrelatedObjective = "Unrelated gate objective";
    const goalDuringUnrelated = outcome(submitCommand(gates, `/goal ${unrelatedObjective}`, "goal during unrelated run"));
    const unrelatedConfirm = await gates.rpc.waitFor(
      (entry) => entry.type === "extension_ui_request" && entry.method === "confirm",
      { after: unrelatedCursor, timeoutMs: 20_000, signal: t.signal },
    );
    assert.equal(unrelatedConfirm.title, "Replace active goal", "the deferred replacement asks its real confirmation");
    await gates.rpc.send({ type: "extension_ui_response", id: stringField(unrelatedConfirm, "id"), confirmed: true });
    const unrelatedState = await getState(gates);
    assert.equal(unrelatedState.pendingMessageCount, 0);
    assert.equal(unrelatedState.isStreaming, true, "the unrelated run is still streaming");
    assert.equal(gates.provider.requestCount, 3, "the goal start must not dispatch during the unrelated run");
    // The previous goal is still the saved state: the new command has neither persisted nor claimed success.
    const beforeGoalEntries = goalEntries(await getEntries(gates));
    assert.ok(beforeGoalEntries.every((entry) => entry.event !== "set" || entry.state?.objective !== unrelatedObjective),
      "the deferred start must not persist while the unrelated run is active");
    g3.release();
    const unrelatedOutcome = await goalDuringUnrelated;
    if (unrelatedOutcome.kind === "rejected") {
      throw new Error("goal during unrelated run: the command must complete", { cause: unrelatedOutcome.error });
    }
    const unrelatedSettled = await gates.rpc.waitForRecord(
      (entry) => entry.type === "agent_settled",
      { after: unrelatedCursor, timeoutMs: 30_000, signal: t.signal },
    );
    // The released command dispatches its continuation immediately after settlement; Pi never idles between them.
    const gateContinuation = await gates.provider.waitForRequest(4, t.signal);
    const unrelatedStarted = await gates.rpc.waitForRecord(
      (entry) => entry.type === "extension_ui_request" && entry.method === "notify"
        && typeof entry.message === "string" && /Goal (started|replaced)/u.test(entry.message),
      { after: unrelatedCursor, timeoutMs: 20_000, signal: t.signal },
    );
    assert.ok(unrelatedStarted.sequence > unrelatedSettled.sequence,
      "the deferred start claims success only after the unrelated run settles");
    const gateMessages = JSON.stringify(gateContinuation.body.messages);
    assert.match(gateMessages, new RegExp(gatesObjective, "u"), "exactly one continuation follows the settlement");
    assert.match(gateMessages, /Status: active · Turn: 1/u);
    g4.release();
    await waitForSettled(gates, cursor, "goal continuation settlement");
    assert.equal(gates.provider.requestCount, 4, "the unrelated-run gate issues exactly four requests");
    acknowledgeBatch(gates, "unrelated run gate");
    observations.push({ history: "unrelated-run gate", providerRequests: 4 });

    // A pending message leaves the goal active but sends nothing and does not claim Goal started.
    await assertFreshSession(gates, "pending message reset");
    const pendingObjective = "Pending gate objective";
    cursor = gates.rpc.currentSequence;
    await submitPrompt(gates, "Pending ordinary work", "pending run");
    await gates.provider.waitForRequest(5, t.signal);
    const pendingQueued = await rpcCommand(gates, "follow_up", { message: "Queued follow-up message" });
    assert.equal(stringField(record(pendingQueued.data, "follow_up response"), "disposition"), "queued");
    const pendingState = await getState(gates);
    assert.equal(pendingState.pendingMessageCount, 1, "the queued follow-up counts as pending");
    // The reset session has no goal, so this deferred start needs no replacement confirmation.
    const goalDuringPending = outcome(submitCommand(gates, `/goal ${pendingObjective}`, "goal during pending message"));
    // The deferred start persists only after the wait; nothing is saved or dispatched while a message is pending.
    assert.equal(goalEntries(await getEntries(gates)).length, 0,
      "the deferred start must not persist while a message is pending");
    assert.equal(gates.provider.requestCount, 5, "the goal start must not dispatch while a message is pending");
    g5.release();
    const pendingFollowUp = await gates.provider.waitForRequest(6, t.signal);
    assert.match(JSON.stringify(pendingFollowUp.body.messages), /Queued follow-up message/u,
      "the queued message must run before the goal continuation");
    g6.release();
    const pendingOutcome = await goalDuringPending;
    if (pendingOutcome.kind === "rejected") {
      throw new Error("goal during pending message: the command must complete", { cause: pendingOutcome.error });
    }
    const settledRecord = await gates.rpc.waitForRecord(
      (entry) => entry.type === "agent_settled",
      { after: cursor, timeoutMs: 30_000, signal: t.signal },
    );
    const gateAfterPending = await gates.provider.waitForRequest(7, t.signal);
    assert.match(JSON.stringify(gateAfterPending.body.messages), new RegExp(pendingObjective, "u"),
      "the goal continuation dispatches only after the pending message settles");
    const startedRecord = await gates.rpc.waitForRecord(
      (entry) => entry.type === "extension_ui_request" && entry.method === "notify"
        && typeof entry.message === "string" && /Goal (started|replaced)/u.test(entry.message),
      { after: cursor, timeoutMs: 20_000, signal: t.signal },
    );
    assert.ok(startedRecord.sequence > settledRecord.sequence,
      "the deferred start claims success only after the queued work settles");
    g7.release();
    await waitForSettled(gates, cursor, "pending gate continuation");
    assert.equal(gates.provider.requestCount, 7, "the pending-message gate issues exactly seven requests");
    acknowledgeBatch(gates, "pending message gate");
    observations.push({ history: "pending-message gate", providerRequests: 7 });

    // A repeated continue report with normalized-identical evidence pauses before a duplicate turn.
    await assertFreshSession(gates, "repeated report reset");
    cursor = gates.rpc.currentSequence;
    await submitCommand(gates, "/goal Report progress honestly", "repeated report start");
    await waitForNotification(gates, cursor, startNotice, "info", "repeated report start");
    await gates.provider.waitForRequest(8, t.signal);
    r8.release();
    await gates.provider.waitForRequest(9, t.signal);
    await gates.rpc.waitFor((entry) => entry.type === "agent_settled", { after: cursor, signal: t.signal, timeoutMs: 30_000 });
    acknowledgeBatch(gates, "repeated report turn 1");
    cursor = gates.rpc.currentSequence;
    const repeatTurn2 = await gates.provider.waitForRequest(10, t.signal);
    assert.match(JSON.stringify(repeatTurn2.body.messages), /Status: active · Turn: 2/u);
    r10.release();
    const repeatFollowUp = await gates.provider.waitForRequest(11, t.signal);
    assert.match(JSON.stringify(repeatFollowUp.body.messages), /repeated continue report/u,
      "the normalized duplicate report is rejected before a duplicate turn");
    await waitForSettled(gates, cursor, "repeated report settlement");
    const repeatEntries = goalEntries(await getEntries(gates));
    const repeatState = goalState(lastGoal(repeatEntries, "repeated report"), "repeated report");
    assert.equal(repeatState.status, "paused");
    assert.equal(repeatState.stopReason, "repeated continue report");
    assert.equal(gates.provider.requestCount, 11, "the repeated report rejects before any further dispatch");
    acknowledgeBatch(gates, "repeated report settlement");
    observations.push({ history: "repeated-continue report", providerRequests: 11, stopReason: repeatState.stopReason });

    // Final user cancellation after an accepted continue stops before the next dispatch, without manual recovery.
    const cancellation = await createFixture(directory, "final-cancellation", t.signal);
    fixtures.push(cancellation);
    await initializeFixture(cancellation);
    cancellation.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "Accepted before cancellation", nextAction: "Never dispatched",
    } }]); // turn 1 with the accepted decision
    cancellation.provider.holdNextRequest(); // the tool follow-up, held unstreamed for the abort
    cursor = cancellation.rpc.currentSequence;
    await submitCommand(cancellation, "/goal Cancel after an accepted decision", "cancellation start");
    await waitForNotification(cancellation, cursor, startNotice, "info", "cancellation start");
    await cancellation.provider.waitForRequest(1, t.signal);
    cancellation.provider.releaseAll();
    await cancellation.provider.waitForRequest(2, t.signal);
    await rpcCommand(cancellation, "abort");
    await waitForSettled(cancellation, cursor, "cancellation settlement");
    const cancellationEntries = goalEntries(await getEntries(cancellation));
    const cancellationState = goalState(lastGoal(cancellationEntries, "cancellation"), "cancellation");
    assert.equal(cancellationState.status, "paused", "the cancellation leaves the goal paused");
    // Real Pi records the aborted request as an aborted assistant, so the cancellation parks the same
    // manual-compaction recovery as any aborted goal turn; the decision stays accepted and nothing dispatches.
    assert.equal(cancellationState.resumeAfterManualCompaction, true,
      "the parked recovery keeps the accepted decision without dispatching");
    assert.ok(cancellationEntries.some((entry) => entry.event === "continue"),
      "the accepted continue decision was recorded before the cancellation");
    assert.equal(cancellation.provider.requestCount, 2, "the cancellation stops before the next dispatch");
    acknowledgeBatch(cancellation, "cancellation settlement");
    observations.push({ history: "final-cancellation", providerRequests: 2 });

    // An aborted assistant stays paused until a manual compaction resumes exactly one turn.
    // A small keepRecentTokens window gives the manual compaction real history to summarize.
    const manual = await createFixture(directory, "manual-compaction", t.signal, undefined, "limit", "killeros_goal_update",
      { compaction: { enabled: false, keepRecentTokens: 200 }, seedPadding: `Manual compaction context seed. ${"compaction history ".repeat(400)}` });
    fixtures.push(manual);
    await initializeFixture(manual);
    const manualObjective = "Recover through manual compaction";
    manual.provider.holdPartialResponse("Streaming partial progress on the manual objective.");
    cursor = manual.rpc.currentSequence;
    await submitCommand(manual, `/goal ${manualObjective}`, "manual start");
    await waitForNotification(manual, cursor, startNotice, "info", "manual start");
    const manualRequest = await manual.provider.waitForRequest(1, t.signal);
    await rpcCommand(manual, "abort");
    await waitForSettled(manual, cursor, "manual abort settlement");
    assert.equal(await manualRequest.completion, "closed", "the abort closes the held provider request");
    const abortedEntries = goalEntries(await getEntries(manual));
    const abortedState = goalState(lastGoal(abortedEntries, "manual abort"), "manual abort");
    assert.equal(abortedState.status, "paused", "the aborted assistant stays paused");
    assert.equal(abortedState.resumeAfterManualCompaction, true, "the aborted turn parks manual-compaction recovery");
    assert.equal(manual.provider.requestCount, 1, "the aborted turn dispatches nothing further");
    acknowledgeBatch(manual, "manual abort settlement");

    cursor = manual.rpc.currentSequence;
    const compactResponse = await rpcCommand(manual, "compact");
    assert.ok(stringField(record(compactResponse.data, "compact response"), "summary").length > 0,
      "the manual compaction produces a summary");
    await manual.provider.waitForRequest(2, t.signal);
    const resumedTurn = await manual.provider.waitForRequest(3, t.signal);
    const resumedMessages = JSON.stringify(resumedTurn.body.messages);
    assert.match(resumedMessages, new RegExp(manualObjective, "u"), "the manual compaction resumes the same goal turn");
    assert.match(resumedMessages, /Status: active · Turn: 1/u, "the interrupted logical turn resumes unchanged");
    manual.provider.releaseAll();
    await waitForSettled(manual, cursor, "manual compaction resume settlement");
    const manualEntries = goalEntries(await getEntries(manual));
    const manualState = goalState(lastGoal(manualEntries, "manual compaction"), "manual compaction");
    assert.equal(manualState.status, "paused", "the resumed turn settles paused without a decision");
    assert.equal(manual.provider.requestCount, 3, "the manual compaction resumes exactly one turn");
    acknowledgeBatch(manual, "manual compaction resume settlement");
    observations.push({ history: "manual-compaction", providerRequests: 3 });

    // The TUI emits no duplicate success notices for the same transitions.
    const tui = await createTerminalFixture({ directory, label: "tui-gates", signal: t.signal, rows: 64 });
    terminalFixtures.push(tui);
    const tuiObjective = "Gate the terminal transitions";
    tui.provider.holdNextRequest(); // turn 1, plain
    const tuiCursor = submitTerminalLine(tui, `/goal ${tuiObjective}`);
    const tuiActive = await tui.terminal.waitForScreen(
      (screen) => screen.includes("/goal active") && screen.includes(`Goal started · ${tuiObjective}`),
      { signal: t.signal, after: tuiCursor, timeoutMs: 20_000 },
    );
    assert.equal((tuiActive.match(/Goal started · /gu) ?? []).length, 1, "exactly one start notice renders");
    assert.equal(tuiActive.includes("Each turn must record continue, complete, or a blocker decision"), false,
      "the TUI must not show the RPC-only success notice");
    await tui.provider.waitForRequest(1, t.signal);
    tui.provider.releaseAll();
    const tuiPauseCursor = submitTerminalLine(tui, "/goal pause");
    const tuiPaused = await tui.terminal.waitForScreen(
      (screen) => screen.includes("/goal paused"),
      { signal: t.signal, after: tuiPauseCursor, timeoutMs: 20_000 },
    );
    assert.equal((tuiPaused.match(/\/goal paused/gu) ?? []).length, 1, "exactly one paused footer");
    assert.equal(tuiPaused.includes("Run /goal resume to continue. Goal"), false,
      "the TUI must not show the RPC-only pause notice");
    // Hold turn 2 so the active footer is observable before the resumed turn settles.
    tui.provider.holdNextRequest();
    const tuiResumeCursor = submitTerminalLine(tui, "/goal resume");
    const tuiResumed = await tui.terminal.waitForScreen(
      (screen) => screen.includes("/goal active"),
      { signal: t.signal, after: tuiResumeCursor, timeoutMs: 20_000 },
    );
    assert.ok(!tuiResumed.split("\n").some((line) => line.trim() === "Goal resumed"),
      "the TUI must not show the RPC-only resume notice (the transcript entry with the objective is legitimate)");
    await tui.provider.waitForRequest(2, t.signal);
    tui.provider.releaseAll();
    await tui.terminal.waitForScreen(
      (screen) => screen.includes("/goal paused"),
      { signal: t.signal, after: tuiResumeCursor, timeoutMs: 20_000 },
    );
    const tuiFinal = tui.terminal.screen();
    assert.equal((tuiFinal.match(new RegExp(`Goal started · ${tuiObjective}`, "gu")) ?? []).length, 1,
      "the start transition renders exactly once");
    assert.equal((tuiFinal.match(new RegExp(`Goal resumed · ${tuiObjective}`, "gu")) ?? []).length, 1,
      "the resume transition renders exactly once");
    const replacementObjective = "Replace the terminal transitions";
    const replacementBarrier = tui.provider.holdNextRequest();
    const replacementCursor = submitTerminalLine(tui, `/goal ${replacementObjective}`);
    await tui.terminal.waitForScreen(screen => screen.includes("Replace active goal"),
      { signal: t.signal, after: replacementCursor });
    tui.terminal.write("\x1b[13u");
    await tui.provider.waitForRequest(3, t.signal);
    const replacementScreen = await tui.terminal.waitForScreen(screen => screen.includes(`/goal active`)
      && screen.includes(`Goal replaced · ${replacementObjective}`), { signal: t.signal, after: replacementCursor });
    assert.equal(replacementScreen.includes("Goal replaced. Each turn must record"), false,
      "The replacement has no duplicate RPC-only success notification");
    replacementBarrier.release();
    await tui.terminal.waitForScreen(screen => screen.includes("/goal paused"), { signal: t.signal });
    const clearCursor = submitTerminalLine(tui, "/goal clear");
    const clearedScreen = await tui.terminal.waitForScreen(screen => screen.includes("Goal cleared")
      && !screen.includes("/goal paused"), { signal: t.signal, after: clearCursor });
    assert.equal(clearedScreen.split("\n").filter(line => line.trim() === "Goal cleared").length, 1,
      "Only the native clear transcript entry renders, without a duplicate success notification");
    assert.equal((await readSessionGoalEntries(tui.sessionFile)).at(-1)?.event, "clear");
    assert.equal(tui.provider.requestCount, 3);
    observations.push({ history: "tui-gates", providerRequests: 3 });

    assert.equal(fixtures.length, 3);
    assert.deepEqual(fixtures.map((fixture) => fixture.provider.requestCount), [11, 2, 3]);
    assert.equal(terminalFixtures.length, 1);
  } catch (error) {
    errors.push(error);
  }
  const runtimeDiagnostics = JSON.stringify({ observations, fixtures: fixtureDiagnostics(fixtures) }).slice(0, 40_000);
  for (const fixture of fixtures) errors.push(...await closeFixture(fixture));
  for (const terminal of terminalFixtures) errors.push(...await closeTerminalFixture(terminal));
  let report: unknown;
  if (errors.length) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-dispatch-gates-failure-"));
    try { throwScenarioFailure({ directory: failureDirectory, message: "goals.dispatch-gates failed", errors, diagnostics: runtimeDiagnostics }); }
    catch (error) { report = error; }
  }
  try { if (errors.length === 0) { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); } }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...errors, ...(report === undefined ? [] : [report])], "goals.dispatch-gates failed");
  t.diagnostic(JSON.stringify({ scenarioId: "goals.dispatch-gates", piLaunches: fixtures.length + terminalFixtures.length,
    providerRequests: 19, naturalExits: fixtures.length + terminalFixtures.length, observations, ownedScratchRemoved: true }));
});

test("pause and clear persist before stopping a run and survive write failure", { timeout: 240_000, skip: piRpcShutdownSkip }, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-pause-clear-"));
  const fixtures: PiFixture[] = [];
  const errors: unknown[] = [];
  const observations: RecordValue[] = [];

  // Family 1: clean pause, resume, and clear transitions with exact continuation counts.
  {
    const fixture = await createFixture(directory, "clean", t.signal, undefined, "limit", "killeros_goal_update");
    fixtures.push(fixture);
    try {
      await initializeFixture(fixture);
      const cursor = fixture.rpc.currentSequence;
      fixture.provider.holdNextRequest();
      await submitCommand(fixture, "/goal Persist clean pause and clear transitions", "clean start");
      await waitForNotification(fixture, cursor, startNotice, "info", "clean start");
      await fixture.provider.waitForRequest(1, t.signal);
      const pauseCursor = fixture.rpc.currentSequence;
      await submitCommand(fixture, "/goal pause", "clean pause");
      await waitForNotification(fixture, pauseCursor, pauseNotice, "info", "clean pause");
      await waitForSettled(fixture, cursor, "clean pause settlement");
      const pausedEntries = goalEntries(await getEntries(fixture));
      assert.equal(goalState(lastGoal(pausedEntries, "clean pause"), "clean pause").status, "paused",
        "the pause persists before the run stops");
      const resumeCursor = fixture.rpc.currentSequence;
      await submitCommand(fixture, "/goal resume", "clean resume");
      await waitForNotification(fixture, resumeCursor, "Goal resumed", "info", "clean resume");
      await fixture.provider.waitForRequest(2, t.signal);
      fixture.provider.releaseAll();
      await waitForSettled(fixture, resumeCursor, "clean resume settlement");
      const clearedCursor = fixture.rpc.currentSequence;
      await submitCommand(fixture, "/goal clear", "clean clear");
      await waitForNotification(fixture, clearedCursor, "Goal cleared", "info", "clean clear");
      const finalEntries = goalEntries(await getEntries(fixture));
      const finalEntry = finalEntries.at(-1);
      assert.ok(finalEntry, "the clear entry exists");
      assert.equal(finalEntry?.event, "clear", "the clear persists an explicit transition");
      assert.equal(finalEntry?.state, null, "the cleared goal saves null state");
      assert.equal(fixture.provider.requestCount, 2, "pause stops one turn and resume continues exactly one turn");
      assertIdle(await getState(fixture), "clean clear idle");
      observations.push({ family: "clean", providerRequests: 2 });
      acknowledgeBatch(fixture, "clean family");
    } catch (error) {
      errors.push(error);
    }
  }

  const runtimeDiagnostics = JSON.stringify({ observations, fixtures: fixtureDiagnostics(fixtures) }).slice(0, 40_000);
  for (const fixture of fixtures) errors.push(...await closeFixture(fixture));
  if (errors.length) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-pause-clear-failure-"));
    throwScenarioFailure({ directory: failureDirectory, message: "goals.pause-clear failed", errors, diagnostics: runtimeDiagnostics });
  }
  try { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); }
  catch (error) { throw error; }
  t.diagnostic(JSON.stringify({ scenarioId: "goals.pause-clear", piLaunches: fixtures.length, providerRequests: 2, observations,
    uncovered: "goal pause and clear first-write-failure and recovery vectors: no working fault injection at this boundary yet (child fs adapter is bypassed by the bundled CLI; read-only session files block Pi's own appends before the goal command runs)" }));
});

test("pending goal commands cannot overwrite newer state", { timeout: 240_000, skip: piRpcShutdownSkip }, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-command-races-"));
  const errors: unknown[] = [];
  let fixture: PiFixture | undefined;
  const observations: RecordValue[] = [];
  try {
    fixture = await createFixture(directory, "races", t.signal, undefined, "limit", "killeros_goal_update");
    await initializeFixture(fixture);
    const rpc = fixture.rpc;
    const cursor = rpc.currentSequence;

    // Turn 1 (Older) runs to a settled pause; a queued, confirmed replacement then owns the goal.
    fixture.provider.holdNextRequest();
    await submitCommand(fixture, "/goal Older racing objective", "older start");
    await waitForNotification(fixture, cursor, startNotice, "info", "older start");
    await fixture.provider.waitForRequest(1, t.signal);
    fixture.provider.releaseAll();
    await waitForSettled(fixture, cursor, "older turn settlement");

    // The replacement is submitted without awaiting: its handler waits for confirmation before responding.
    const newerCursor = rpc.currentSequence;
    const newerPending = rpcCommand(fixture, "prompt", { message: "/goal Newer racing objective" });
    const confirmation = await rpc.waitFor(
      (entry) => entry.type === "extension_ui_request" && entry.method === "confirm",
      { after: newerCursor, timeoutMs: 15_000, signal: fixture.signal },
    );
    assert.equal(confirmation.message, "Replace the current unfinished goal and discard its continuation state?",
      "the queued replacement triggers the real confirmation");
    await rpc.send({ type: "extension_ui_response", id: stringField(confirmation, "id"), confirmed: true });
    assert.equal(record((await newerPending).data, "newer prompt response").disposition, "handled",
      "the queued replacement command is handled once confirmed");
    await waitForNotification(fixture, newerCursor, replaceNotice, "info", "newer replace");
    await fixture.provider.waitForRequest(2, t.signal);
    await waitForSettled(fixture, newerCursor, "newer turn settlement");

    // The clear runs sequentially after the replacement settled: the newest state must win.
    const clearCursor = rpc.currentSequence;
    await submitCommand(fixture, "/goal clear", "racing clear");
    await waitForNotification(fixture, clearCursor, "Goal cleared", "info", "racing clear");

    const entries = goalEntries(await getEntries(fixture));
    const finalEntry = entries.at(-1);
    assert.equal(finalEntry?.event, "clear", "the queued clear applies last");
    assert.equal(finalEntry?.state, null, "the cleared goal saves null state");
    const lastObjectiveEntry = [...entries].reverse().find((entry) => entry.state !== null);
    const racedState = goalState(lastObjectiveEntry ?? lastGoal(entries, "races"), "races");
    assert.equal(racedState.objective, "Newer racing objective",
      "the sequential replacement retains the newer objective before clear");
    const objectives = entries
      .filter((entry) => entry.event === "set" || entry.event === "replace")
      .map((entry) => (entry.state === null ? null : goalState(entry, "races").objective));
    assert.ok(objectives.includes("Older racing objective"), "the older start applied once, in order");
    assert.equal(objectives.filter((objective) => objective === "Newer racing objective").length, 1,
      "the newer replacement applied exactly once");
    assert.equal(fixture.provider.requestCount, 2, "each goal turn dispatches exactly one provider request");
    assertIdle(await getState(fixture), "races idle");
    acknowledgeBatch(fixture, "sequential controls");

    // Hold a real replacement confirmation while a newer clear changes its captured goal.
    const seedCursor = rpc.currentSequence;
    await submitCommand(fixture, "/goal Confirmation race original", "confirmation seed");
    await fixture.provider.waitForRequest(3, t.signal);
    await waitForSettled(fixture, seedCursor, "confirmation seed settlement");
    const staleCursor = rpc.currentSequence;
    const stale = outcome(rpcCommand(fixture, "prompt", { message: "/goal Stale confirmed replacement" }));
    const staleConfirm = await rpc.waitFor(
      (entry) => entry.type === "extension_ui_request" && entry.method === "confirm",
      { after: staleCursor, timeoutMs: 15_000, signal: t.signal },
    );
    await submitCommand(fixture, "/goal clear", "clear during confirmation");
    await waitForNotification(fixture, staleCursor, "Goal cleared", "info", "clear during confirmation");
    const clearedEntries = goalEntries(await getEntries(fixture));
    assert.equal(clearedEntries.at(-1)?.event, "clear");
    assert.equal(clearedEntries.at(-1)?.state, null);
    await rpc.send({ type: "extension_ui_response", id: stringField(staleConfirm, "id"), confirmed: true });
    const staleResult = await stale;
    if (staleResult.kind === "rejected") throw staleResult.error;
    assert.equal(record(staleResult.value.data, "stale prompt response").disposition, "handled");
    assert.deepEqual(goalEntries(await getEntries(fixture)), clearedEntries,
      "accepting a stale confirmation must append nothing after clear");
    assert.equal(fixture.provider.requestCount, 3, "a stale replacement must not dispatch work");
    assertIdle(await getState(fixture), "stale confirmation after clear");
    observations.push({ family: "races", providerRequests: 3, objectives: objectives.join(" -> "), staleConfirmation: "clear" });
    acknowledgeBatch(fixture, "races family");
  } catch (error) {
    errors.push(error);
  }
  const runtimeDiagnostics = JSON.stringify({ observations, fixtures: fixtureDiagnostics(fixture ? [fixture] : []) }).slice(0, 40_000);
  if (fixture) errors.push(...await closeFixture(fixture));
  if (errors.length) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-command-races-failure-"));
    throwScenarioFailure({ directory: failureDirectory, message: "goals.command-races failed", errors, diagnostics: runtimeDiagnostics });
  }
  try { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); }
  catch (error) { throw error; }
  t.diagnostic(JSON.stringify({ scenarioId: "goals.command-races", piLaunches: 1, providerRequests: 3, observations }));
});

// Catalog ID: goals.file-inference-races.
test("pending goal file inference respects newer commands and committed navigation", { timeout: 60_000 }, async (t) => {
  const directory = await isolatedGoalRoot("killeros-goal-inference-races-");
  const control = path.join(directory, "control");
  mkdirSync(control);
  const extension = path.join(directory, "inference-barrier.mjs");
  writeFileSync(extension, String.raw`import fsp from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, renameSync, watch } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
const control = process.env.KILLEROS_GOAL_INFERENCE_RACE;
const original = fsp.lstat;
const pending = new Set();
let cancelTree = false;
let armed;
const restore = () => { fsp.lstat = original; syncBuiltinESMExports(); };
const save = (file, value) => { writeFileSync(file + ".tmp", JSON.stringify({ ...value, pid: process.pid })); renameSync(file + ".tmp", file); };
const inspect = async (...args) => {
      const plan = armed;
      if (!plan || typeof args[0] !== "string" || path.resolve(args[0]).toLowerCase() !== plan.target.toLowerCase()) return original(...args);
      armed = undefined;
      restore();
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => { clearTimeout(timer); watcher.close(); pending.delete(release); error ? reject(error) : resolve(); };
        const release = () => finish();
        const check = () => { if (existsSync(plan.release) && readFileSync(plan.release, "utf8") === plan.nonce) finish(); };
        const watcher = watch(control, check);
        pending.add(release);
        timer = setTimeout(() => finish(Error("Owned inference barrier timed out")), 15000);
        save(plan.ready, { nonce: plan.nonce, pid: process.pid, target: plan.target });
        check();
      });
      return original(...args);
};
export default function(pi) {
  pi.registerCommand("fixture-inference-arm", { handler: async () => {
    const plan = JSON.parse(readFileSync(path.join(control, "plan.json"), "utf8"));
    if (path.dirname(plan.target) !== plan.project) throw Error("Barrier target must belong to the owned project");
    armed = plan;
    fsp.lstat = inspect;
    syncBuiltinESMExports();
  } });
  pi.registerCommand("fixture-inference-anchor", { handler: async (_args, ctx) => {
    try {
    const anchor = ctx.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant")?.id;
    if (!anchor || anchor === ctx.sessionManager.getLeafId()) throw Error("Navigation requires an earlier native assistant entry");
    save(path.join(control, "anchor.json"), { anchor });
    } catch (error) { save(path.join(control, "anchor.json"), { error: String(error) }); }
  } });
  pi.registerCommand("fixture-inference-cancel", { handler: async () => { cancelTree = true; } });
  pi.on("session_before_tree", () => { if (cancelTree) { cancelTree = false; return { cancel: true }; } });
  pi.registerCommand("fixture-inference-tree", { handler: async (args, ctx) => {
    const result = await ctx.navigateTree(args, { summarize: false });
    save(path.join(control, "navigation.json"), result);
  } });
  pi.on("session_shutdown", () => { armed = undefined; restore(); for (const release of [...pending]) release(); });
}
`);
  let fixture: PiFixture | undefined;
  let failure: unknown;
  const cleanup: unknown[] = [];
  const observations: RecordValue[] = [];
  let nonce = 0;
  let expectedRequests = 0;
  try {
    const active = await createFixture(directory, "commands", t.signal, undefined, "limit", "killeros_goal_update",
      { extensions: [extension], env: { KILLEROS_GOAL_INFERENCE_RACE: control } });
    fixture = active;
    await initializeFixture(active);
    const confirm = async (after: number): Promise<void> => {
      const dialog = await active.rpc.waitFor(event => event.type === "extension_ui_request" && event.method === "confirm",
        { after, signal: t.signal, timeoutMs: 15_000 });
      assert.equal(dialog.title, "Replace active goal");
      await active.rpc.send({ type: "extension_ui_response", id: stringField(dialog, "id"), confirmed: true });
    };
    const finishCommand = async (command: ReturnType<typeof outcome<PiRpcRecord>>): Promise<void> => {
      const result = await command;
      if (result.kind === "rejected") throw result.error;
      assert.equal(record(result.value.data, "command response").disposition, "handled");
    };
    const start = async (objective: string, replacement = false): Promise<void> => {
      const cursor = active.rpc.currentSequence;
      active.provider.queueStop();
      const command = outcome(rpcCommand(active, "prompt", { message: `/goal ${objective}` }));
      if (replacement) await confirm(cursor);
      await finishCommand(command);
      await active.provider.waitForRequest(++expectedRequests, t.signal);
      await waitForSettled(active, cursor, objective);
      assert.equal(goalState(lastGoal(goalEntries(await getEntries(active)), objective), objective).objective, objective);
      assertIdle(await getState(active), objective);
    };
    const park = async (edit: boolean, replacement: boolean) => {
      const target = path.join(active.project, `held-${++nonce}.txt`);
      writeFileSync(target, "Original file baseline\n");
      const plan = { target, project: active.project, nonce: `inference-${nonce}`,
        ready: path.join(control, `ready-${nonce}.json`), release: path.join(control, `release-${nonce}`) };
      writeFileSync(path.join(control, "plan.json"), JSON.stringify(plan));
      await submitCommand(active, "/fixture-inference-arm", "arm owned file read");
      const cursor = active.rpc.currentSequence;
      const command = outcome(rpcCommand(active, "prompt", { message: `/goal ${edit ? "edit " : ""}Fix \`${target}\`` }));
      if (replacement && !edit) await confirm(cursor);
      const ready = await waitForControlFile(plan.ready, t.signal, "actual owned lstat entry");
      assert.equal(ready.nonce, plan.nonce);
      assert.equal(ready.target, target);
      assert.ok(typeof ready.pid === "number" && Number.isInteger(ready.pid) && ready.pid > 0);
      return { command, plan, cursor };
    };

    for (const clear of [true, false]) {
      await assertFreshSession(active, "fresh pending start");
      const held = await park(false, false);
      await start("Newer objective");
      if (clear) await submitCommand(active, "/goal clear", "clear newer objective");
      const entries = goalEntries(await getEntries(active));
      writeFileSync(held.plan.release, held.plan.nonce);
      await finishCommand(held.command);
      assert.deepEqual(goalEntries(await getEntries(active)), entries, "An older start cannot overwrite newer state, including set then clear");
      assert.equal(active.provider.requestCount, expectedRequests);
      assertIdle(await getState(active), "older pending start finished");
      acknowledgeBatch(active, "pending start complete");
      observations.push({ workflow: clear ? "start-newer-clear" : "start-newer", providerRequests: expectedRequests });
    }
    for (const edit of [false, true]) {
      await assertFreshSession(active, "fresh file inference mutation");
      await start("Original objective");
      const held = await park(edit, true);
      await start("Newer objective", true);
      const entries = goalEntries(await getEntries(active));
      writeFileSync(held.plan.release, held.plan.nonce);
      await finishCommand(held.command);
      assert.deepEqual(goalEntries(await getEntries(active)), entries, "A pending replacement or edit cannot overwrite the newer objective");
      assert.equal(active.provider.requestCount, expectedRequests);
      assertIdle(await getState(active), "stale file inference finished");
      acknowledgeBatch(active, "stale file inference complete");
      observations.push({ workflow: edit ? "edit-newer" : "replace-newer", providerRequests: expectedRequests });
    }

    await assertFreshSession(active, "fresh confirmation race");
    await start("Original objective");
    const oldCursor = active.rpc.currentSequence;
    const older = outcome(rpcCommand(active, "prompt", { message: "/goal Older confirmed objective" }));
    const olderDialog = await active.rpc.waitFor(event => event.type === "extension_ui_request" && event.method === "confirm",
      { after: oldCursor, signal: t.signal, timeoutMs: 15_000 });
    await start("Newer objective", true);
    const confirmedEntries = goalEntries(await getEntries(active));
    await active.rpc.send({ type: "extension_ui_response", id: stringField(olderDialog, "id"), confirmed: true });
    await finishCommand(older);
    assert.deepEqual(goalEntries(await getEntries(active)), confirmedEntries);
    assert.equal(active.provider.requestCount, expectedRequests);
    acknowledgeBatch(active, "stale confirmation complete");
    observations.push({ workflow: "confirmation-newer", providerRequests: expectedRequests });

    await assertFreshSession(active, "fresh idle race");
    await start("Original objective");
    const ordinaryBarrier = active.provider.holdNextRequest();
    const ordinaryCursor = active.rpc.currentSequence;
    await submitPrompt(active, "Hold unrelated ordinary work", "idle race ordinary request");
    await active.provider.waitForRequest(++expectedRequests, t.signal);
    const idleCursor = active.rpc.currentSequence;
    const idleReplacement = outcome(rpcCommand(active, "prompt", { message: "/goal Older idle replacement" }));
    await confirm(idleCursor);
    await submitCommand(active, "/goal clear", "clear while replacement waits for global idle");
    const cleared = goalEntries(await getEntries(active));
    assert.equal(cleared.at(-1)?.state, null);
    assert.equal((await getState(active)).isStreaming, true, "Clearing inactive goal state preserves the held ordinary request");
    ordinaryBarrier.release();
    await waitForSettled(active, ordinaryCursor, "ordinary idle release");
    await finishCommand(idleReplacement);
    assert.deepEqual(goalEntries(await getEntries(active)), cleared);
    assert.equal(active.provider.requestCount, expectedRequests);
    acknowledgeBatch(active, "stale idle replacement complete");
    observations.push({ workflow: "idle-clear", providerRequests: expectedRequests });

    for (const cancelled of [false, true]) {
      await assertFreshSession(active, "fresh navigation race");
      for (const message of ["Create native navigation history", "Advance beyond the native anchor"]) {
        const cursor = active.rpc.currentSequence;
        active.provider.queueStop();
        await submitPrompt(active, message, "native navigation history");
        await active.provider.waitForRequest(++expectedRequests, t.signal);
        await waitForSettled(active, cursor, message);
      }
      for (const file of ["anchor.json", "navigation.json"]) rmSync(path.join(control, file), { force: true });
      await submitCommand(active, "/fixture-inference-anchor", "seed actual native navigation anchor");
      const anchor = stringField(await waitForControlFile(path.join(control, "anchor.json"), t.signal, "native tree anchor"), "anchor");
      const held = await park(false, false);
      if (cancelled) await submitCommand(active, "/fixture-inference-cancel", "cancel next native tree navigation");
      await submitCommand(active, `/fixture-inference-tree ${anchor}`, "native tree navigation");
      const navigation = await waitForControlFile(path.join(control, "navigation.json"), t.signal, "native navigation result");
      assert.equal(navigation.cancelled, cancelled);
      if (cancelled) active.provider.queueStop();
      writeFileSync(held.plan.release, held.plan.nonce);
      await finishCommand(held.command);
      if (cancelled) {
        await active.provider.waitForRequest(++expectedRequests, t.signal);
        await waitForSettled(active, held.cursor, "cancelled navigation preserves pending goal");
      }
      assert.equal(goalEntries(await getEntries(active)).filter(entry => entry.event === "set").length, cancelled ? 1 : 0);
      assert.equal(active.provider.requestCount, expectedRequests);
      assertIdle(await getState(active), "navigation race complete");
      acknowledgeBatch(active, "navigation race complete");
      observations.push({ workflow: cancelled ? "cancelled-tree" : "committed-tree", providerRequests: expectedRequests });
    }
    assert.equal(expectedRequests, 15);
  } catch (error) { failure = error; }
  finally {
    if (fixture) cleanup.push(...await closeFixture(fixture));
  }
  if (failure !== undefined || cleanup.length > 0) throwScenarioFailure({ directory,
    message: "Native goal inference races failed", errors: [...(failure === undefined ? [] : [failure]), ...cleanup],
    diagnostics: JSON.stringify({ observations, fixture: fixture?.rpc.diagnostics() }) });
  await removeDirectoryEventually(directory);
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: "goals.file-inference-races", piLaunches: 1, providerRequests: expectedRequests,
    workflows: observations, naturalExit: true, scratchRemoved: true }));
});

// Catalog ID: goals.provider-abort-reason.
test("provider abort reasons are sanitized before manual recovery is marked", { timeout: 30_000 }, async t => {
  const directory = await isolatedGoalRoot("killeros-goal-abort-reason-");
  const extension = path.join(directory, "aborted-provider.mjs");
  const observation = path.join(directory, "provider-streams.txt");
  const reason = "\x1b]2;owned\x07\x1b[31mcompaction\x1b[0m\0 started";
  writeFileSync(extension, `import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from ${JSON.stringify(new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href)};
export default function(pi) {
  pi.registerProvider("goals-command", { api:"openai-completions", streamSimple(model) {
    appendFileSync(${JSON.stringify(observation)}, "aborted\\n");
    const stream = createAssistantMessageEventStream();
    const message = {role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:"aborted",errorMessage:${JSON.stringify(reason)},timestamp:Date.now()};
    stream.push({type:"error",reason:"aborted",error:message});stream.end();return stream;
  }});
}`);
  let fixture: PiFixture | undefined;
  let failure: unknown;
  const cleanup: unknown[] = [];
  try {
    fixture = await createFixture(directory, "abort", t.signal, undefined, "limit", "killeros_goal_update", { extensions: [extension] });
    await initializeFixture(fixture);
    const cursor = fixture.rpc.currentSequence;
    await submitCommand(fixture, "/goal Resume only after manual compaction", "provider abort reason");
    await waitForSettled(fixture, cursor, "native provider abort");
    const state = goalState(lastGoal(goalEntries(await getEntries(fixture)), "aborted state"), "aborted state");
    assert.equal(state.status, "paused");
    assert.equal(state.result, "compaction started");
    assert.equal(state.resumeAfterManualCompaction, true);
    assert.equal(state.turns, 1);
    await waitForNotification(fixture, cursor,
      "Goal paused because the turn was aborted. If /compact is running, KillerOS will resume the same goal turn after Pi saves the summary. Run /goal pause to keep it paused.",
      "warning", "native abort manual recovery guidance");
    const assistant = (await getEntries(fixture)).filter(entry => entry.type === "message"
      && record(entry.message, "native message").role === "assistant").at(-1);
    assert.equal(record(assistant?.message, "native assistant").stopReason, "aborted");
    assert.equal(record(assistant?.message, "native assistant").errorMessage, reason);
    acknowledgeBatch(fixture, "native abort reason complete");
  } catch (error) { failure = error; }
  finally { if (fixture) cleanup.push(...await closeFixture(fixture)); }
  if (failure !== undefined || cleanup.length) throwScenarioFailure({ directory, message: "Native abort reason failed",
    errors: [...(failure === undefined ? [] : [failure]), ...cleanup], diagnostics: fixture?.rpc.diagnostics() ?? "" });
  assert.equal(readFileSync(observation, "utf8"), "aborted\n", "No automatic turn is granted after the abort");
  await removeDirectoryEventually(directory);
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: "goals.provider-abort-reason", piLaunches: 1, providerStreams: 1,
    httpRequests: 0, naturalExit: true, scratchRemoved: true }));
});

test("stale native replacements release the authorized goal continuation", { timeout: 60_000, skip: piRpcShutdownSkip }, async t => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-stale-held-"));
  const errors: unknown[] = [];
  let rpc: PiFixture | undefined;
  let tui: TerminalFixture | undefined;
  try {
    rpc = await createFixture(directory, "held-rpc", t.signal, undefined, "limit", "killeros_goal_update");
    await initializeFixture(rpc);
    const first = rpc.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "First check passed", nextAction: "Run the second check",
    } }]);
    rpc.provider.queueStop();
    const next = rpc.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "complete", evidence: "Both checks passed",
    } }]);
    rpc.provider.queueStop();
    await submitCommand(rpc, "/goal Original objective", "held original");
    await rpc.provider.waitForRequest(1, t.signal);
    const cursor = rpc.rpc.currentSequence;
    const replacement = outcome(rpcCommand(rpc, "prompt", { message: "/goal Replacement objective" }));
    const confirmation = await rpc.rpc.waitFor(event => event.type === "extension_ui_request" && event.method === "confirm",
      { after: cursor, signal: t.signal });
    await rpc.rpc.send({ type: "extension_ui_response", id: stringField(confirmation, "id"), confirmed: true });
    assert.equal((await getState(rpc)).isStreaming, true, "The confirmed replacement waits while the real turn is held");
    first.release();
    const replaced = await replacement;
    if (replaced.kind === "rejected") throw replaced.error;
    const secondTurn = await rpc.provider.waitForRequest(3, t.signal);
    assert.match(JSON.stringify(secondTurn.body.messages), /Original objective/u);
    const active = goalState(lastGoal(goalEntries(await getEntries(rpc)), "held continuation"), "held continuation");
    assert.equal(active.objective, "Original objective");
    assert.equal(active.turns, 2);
    assert.equal(rpc.provider.requestCount, 3);
    const finalCursor = rpc.rpc.currentSequence;
    next.release();
    await rpc.provider.waitForRequest(4, t.signal);
    await waitForSettled(rpc, finalCursor, "held RPC final");
    const final = goalState(lastGoal(goalEntries(await getEntries(rpc)), "held final"), "held final");
    assert.deepEqual([final.objective, final.status, final.turns], ["Original objective", "complete", 2]);
    assertIdle(await getState(rpc), "held RPC complete");
    assert.equal(rpc.provider.requestCount, 4);

    tui = await createTerminalFixture({ directory, label: "held-tui", signal: t.signal });
    const tuiFirst = tui.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "continue", evidence: "First check passed", nextAction: "Run the second check",
    } }]);
    tui.provider.queueStop();
    const tuiNext = tui.provider.holdToolCalls([{ name: "killeros_goal_update", arguments: {
      status: "complete", evidence: "Both checks passed",
    } }]);
    tui.provider.queueStop();
    submitTerminalLine(tui, "/goal Original objective");
    await tui.provider.waitForRequest(1, t.signal);
    const replaceCursor = submitTerminalLine(tui, "/goal Replacement objective");
    await tui.terminal.waitForScreen(screen => screen.includes("Replace active goal"), { signal: t.signal, after: replaceCursor });
    tui.terminal.write("\x1b[13u");
    await tui.terminal.waitForScreen(screen => !screen.includes("Replace active goal") && screen.includes("/goal active"), { signal: t.signal });
    tuiFirst.release();
    await tui.provider.waitForRequest(3, t.signal);
    const tuiActive = (await readSessionGoalEntries(tui.sessionFile)).at(-1)?.state;
    assert.ok(tuiActive);
    assert.deepEqual([tuiActive.objective, tuiActive.turns], ["Original objective", 2]);
    tuiNext.release();
    await tui.provider.waitForRequest(4, t.signal);
    await tui.terminal.waitForScreen(screen => screen.includes("Goal completed") && !screen.includes("/goal active"), { signal: t.signal });
    const tuiFinal = (await readSessionGoalEntries(tui.sessionFile)).at(-1)?.state;
    assert.ok(tuiFinal);
    assert.deepEqual([tuiFinal.objective, tuiFinal.status, tuiFinal.turns], ["Original objective", "complete", 2]);
    assert.equal(tui.provider.requestCount, 4);
  } catch (error) { errors.push(error); }
  if (rpc) errors.push(...await closeFixture(rpc));
  if (tui) errors.push(...await closeTerminalFixture(tui));
  await removeDirectoryEventually(directory);
  if (errors.length) throw new AggregateError(errors, "Stale native replacement failed");
  t.diagnostic(JSON.stringify({ scenarioId: "goals.stale-held-continuation", piLaunches: 2, providerRequests: 8,
    modes: ["rpc", "tui"], exactGoalTurns: 2, cleanup: "natural" }));
});
