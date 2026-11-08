import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const fixtureKey = "runtime-tools-fixture-key";
const hiddenGuideline = "KILLEROS_HIDDEN_TOOL_GUIDELINE_104";
const editorEnter = "\x1b[13u";
const dialogEnter = editorEnter;

type JsonRecord = Record<string, unknown>;
type SessionMode = "tui" | "rpc";
type CodemodeMode = "disabled" | "on" | "only";
type ProviderCall = { name: string; arguments: JsonRecord };
type ProviderStep = { kind: "text"; content: string } | { kind: "calls"; calls: ProviderCall[] };
type FixtureEvent = JsonRecord;

type TestCounts = { pi: number; providerRequests: number; otherChildren: number };
const testCounts: TestCounts = { pi: 0, providerRequests: 0, otherChildren: 0 };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  assert.ok(isRecord(value), `${label} must be an object`);
  return value;
}

function records(value: unknown, label: string): JsonRecord[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function toolCall(name: string, args: JsonRecord): ProviderCall {
  return { name, arguments: args };
}

function completionCall(evidence: string): ProviderCall {
  return toolCall("killeros_goal_update", { status: "complete", evidence });
}

function codemodeDecisionProbe(): ProviderCall {
  return toolCall("codemode", {
    code: 'for (const [name, args] of [["question", { question: "Nested question", options: [{ label: "Alpha" }] }], ["killeros_goal_update", { status: "complete", evidence: "Nested completion" }]]) { try { await tools[name](args); text("Unexpected call: " + name); } catch (error) { text(error.message); } }',
  });
}

function objectSchemas(request: JsonRecord): void {
  const declarations = records(request.tools, "provider tools");
  for (const declaration of declarations) {
    const fn = record(declaration.function, "provider tool function");
    const name = typeof fn.name === "string" ? fn.name : "unnamed tool";
    const parameters = record(fn.parameters, `${name} parameters`);
    assert.equal(parameters.type, "object", `${name} must use a top-level object schema`);
    assert.ok(isRecord(parameters.properties), `${name} must declare object properties`);
    assert.equal(parameters.anyOf, undefined, `${name} must not use a top-level anyOf`);
    assert.equal(parameters.oneOf, undefined, `${name} must not use a top-level oneOf`);
  }
}

function requestToolNames(request: JsonRecord): string[] {
  return records(request.tools, "provider tools").map((declaration) => {
    const fn = record(declaration.function, "provider tool function");
    assert.ok(typeof fn.name === "string", "provider tool names must be strings");
    return fn.name;
  });
}

function requestText(request: JsonRecord): string {
  return records(request.messages, "provider messages").map((message) => textContent(message.content)).join("\n");
}

function goalEntries(entries: JsonRecord[]): JsonRecord[] {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
}

function savedGoalState(entry: JsonRecord): JsonRecord {
  const data = record(entry.data, "KillerOS goal entry data");
  return record(data.state, "KillerOS goal state");
}

function lastGoalState(entries: JsonRecord[]): JsonRecord | undefined {
  const latest = goalEntries(entries).at(-1);
  return latest === undefined || record(latest.data, "KillerOS goal entry data").state === null
    ? undefined
    : savedGoalState(latest);
}

function toolResults(messages: JsonRecord[]): JsonRecord[] {
  return messages.filter((message) => message.role === "tool" || message.role === "toolResult");
}

function assertNoFixtureFaults(provider: LocalToolProvider): void {
  assert.deepEqual(provider.faults, [], "the loopback provider and public extension callbacks must not fail");
  assert.equal(provider.remainingSteps, 0, "every scripted provider response must be consumed");
}

/** A loopback OpenAI-completions fixture with bounded requests and acknowledged extension events. */
class LocalToolProvider {
  readonly name: string;
  readonly requests: JsonRecord[] = [];
  readonly faults: string[] = [];
  readonly events: FixtureEvent[] = [];
  readonly callNames = new Map<string, string>();
  private readonly steps: ProviderStep[] = [];
  private readonly server: Server;
  private readonly firstProbeGate: Promise<void>;
  private releaseProbe: (() => void) | undefined;
  private readonly parallelProbeGate: Promise<void>;
  private releaseParallel: (() => void) | undefined;
  private readonly eventWaiters = new Set<{
    predicate: (event: FixtureEvent) => boolean;
    resolve: (event: FixtureEvent) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    signal: AbortSignal;
    abort: () => void;
  }>();

  constructor(name: string) {
    this.name = name;
    this.firstProbeGate = new Promise<void>((resolve) => { this.releaseProbe = resolve; });
    this.parallelProbeGate = new Promise<void>((resolve) => { this.releaseParallel = resolve; });
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.faults.push(error instanceof Error ? error.message : String(error));
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(500, { connection: "close" });
          response.end("runtime-tools fixture rejected request");
        }
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
  }

  get origin(): string {
    const address = this.server.address();
    if (!this.server.listening || !address || typeof address === "string") throw new Error("The runtime-tools fixture is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  get baseUrl(): string {
    return `${this.origin}/v1`;
  }

  get remainingSteps(): number {
    return this.steps.length;
  }

  plan(...steps: ProviderStep[]): void {
    this.steps.push(...steps);
  }

  releaseFirstProbe(): void {
    const release = this.releaseProbe;
    this.releaseProbe = undefined;
    release?.();
  }

  releaseParallelProbe(): void {
    this.releaseParallel?.();
    this.releaseParallel = undefined;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
  }

  async waitForEvent(predicate: (event: FixtureEvent) => boolean, label: string, signal: AbortSignal, after = 0): Promise<FixtureEvent> {
    const existing = this.events.slice(after).find(predicate);
    if (existing) return existing;
    if (signal.aborted) throw new Error(`${label} wait was cancelled`, { cause: signal.reason });
    return await new Promise<FixtureEvent>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.eventWaiters.delete(waiter);
          signal.removeEventListener("abort", waiter.abort);
          reject(new Error(`Timed out waiting for ${label}`));
        }, 20_000),
        signal,
        abort: (): void => {
          clearTimeout(waiter.timer);
          this.eventWaiters.delete(waiter);
          signal.removeEventListener("abort", waiter.abort);
          reject(new Error(`${label} wait was cancelled`, { cause: signal.reason }));
        },
      };
      this.eventWaiters.add(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });
  }

  async close(): Promise<void> {
    this.releaseFirstProbe();
    this.releaseParallelProbe();
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new Error("The runtime-tools fixture closed before an event arrived"));
    }
    this.eventWaiters.clear();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
        this.server.closeAllConnections();
      });
    }
  }

  private async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    assert.equal(request.method, "POST", "the runtime-tools fixture only accepts POST requests");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      assert.ok(chunk instanceof Uint8Array);
      size += chunk.length;
      assert.ok(size <= 1_048_576, "fixture request bodies must stay bounded");
      chunks.push(Buffer.from(chunk));
    }
    const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "fixture request body");
    if (request.url === "/event") {
      this.events.push(body);
      for (const waiter of this.eventWaiters) {
        if (!waiter.predicate(body)) continue;
        clearTimeout(waiter.timer);
        waiter.signal.removeEventListener("abort", waiter.abort);
        this.eventWaiters.delete(waiter);
        waiter.resolve(body);
      }
      if (body.type === "probe-start" && body.index === 1) await this.firstProbeGate;
      if (body.type === "parallel-start" && body.index === 1) await this.parallelProbeGate;
      response.writeHead(204, { connection: "close" });
      response.end();
      return;
    }
    assert.equal(request.url, "/v1/chat/completions", "the runtime-tools fixture only serves OpenAI completions");
    assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
    assert.equal(body.model, "local-model");
    objectSchemas(body);
    this.requests.push(body);
    testCounts.providerRequests++;
    const step = this.steps.shift();
    assert.ok(step, `Unexpected ${this.name} provider request ${this.requests.length}`);
    const id = `${this.name}-${this.requests.length}`;
    const delta = step.kind === "calls"
      ? { tool_calls: step.calls.map((call, index) => {
        const callId = `${id}-call-${index}`;
        this.callNames.set(callId, call.name);
        return { index, id: callId, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
      }) }
      : { content: step.content };
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(`data: ${JSON.stringify({
      id,
      model: "local-model",
      choices: [{ index: 0, delta, finish_reason: step.kind === "calls" ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
    })}\n\ndata: [DONE]\n\n`);
  }
}

type FamilyOptions = {
  name: string;
  mode: SessionMode;
  codemode: CodemodeMode;
  tools?: string;
  excludeTools?: string;
  signal: AbortSignal;
  faultOnSettlement?: boolean;
};

type PromptRun = { finish: (marker: string) => Promise<void>; cursor: number; settlementIndex: number };

/** Owns one real Pi CLI process, its project, session, provider, and public fixture extension. */
class PiFamily {
  readonly directory: string;
  readonly project: string;
  readonly agent: string;
  readonly sessionFile: string;
  readonly extensionFile: string;
  readonly provider: LocalToolProvider;
  readonly env: NodeJS.ProcessEnv;
  private rpc: PiRpcProcess | undefined;
  private terminal: PiTerminalProcess | undefined;
  private readonly errorMonitorAbort = new AbortController();
  private errorMonitor: Promise<void> | undefined;
  private observedErrorScreen: string | undefined;
  private monitorFailure: unknown;
  private terminalClosing = false;
  private readonly options: FamilyOptions;

  constructor(options: FamilyOptions) {
    this.options = options;
    this.directory = realpathSync(mkdtempSync(path.join(realpathSync(tmpdir()), `.killeros-runtime-tools-${options.name}-`)));
    for (let ancestor = this.directory; ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false, "Tool fixtures cannot discover a parent repository");
      if (path.dirname(ancestor) === ancestor) break;
    }
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(this.directory, "node_modules"), "junction");
    this.project = path.join(this.directory, "project");
    this.agent = path.join(this.directory, "agent");
    this.sessionFile = path.join(this.directory, "session.jsonl");
    this.extensionFile = path.join(this.directory, "tool-probe.ts");
    const temporary = path.join(this.directory, "tmp");
    const appData = path.join(this.directory, "appdata");
    const localAppData = path.join(this.directory, "localappdata");
    for (const folder of [this.project, this.agent, temporary]) mkdirSync(folder);
    this.provider = new LocalToolProvider(options.name);
    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    this.env = {
      HOME: this.directory,
      USERPROFILE: this.directory,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: temporary,
      TMP: temporary,
      PATH: inherited.get("path") ?? path.dirname(process.execPath),
      PI_CODING_AGENT_DIR: this.agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = inherited.get(key.toLowerCase());
      if (value !== undefined) this.env[key] = value;
    }
    mkdirSync(appData);
    mkdirSync(localAppData);
    const emptyGit = path.join(this.directory, "empty-git-config");
    writeFileSync(emptyGit, "");
    Object.assign(this.env, { GIT_CONFIG_GLOBAL: emptyGit, GIT_CONFIG_SYSTEM: emptyGit,
      GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" });
  }

  get mode(): SessionMode {
    return this.options.mode;
  }

  screen(): string {
    assert.ok(this.terminal, "a terminal screen requires the native TUI");
    return this.terminal.screen();
  }

  assertNoVisibleExtensionError(): void {
    if (!this.terminal) return;
    if (this.monitorFailure !== undefined) throw new Error("native TUI error monitoring failed", { cause: this.monitorFailure });
    const screen = this.observedErrorScreen ?? this.terminal.screen();
    assert.ok(!/\bExtension\s+"[\s\S]*?\berror:/u.test(screen),
      `native TUI rendered an extension error: ${screen}`);
  }

  async waitForVisibleError(marker: string, after: number): Promise<void> {
    assert.ok(this.terminal, "visible error control requires the native TUI");
    await this.terminal.waitForScreen((screen) => screen.includes(marker),
      { after, signal: this.options.signal, timeoutMs: 30_000 });
  }

  async clearVisibleErrorForControl(marker: string): Promise<void> {
    assert.ok(this.terminal, "visible error control requires the native TUI");
    const eventCursor = this.provider.events.length;
    const screenCursor = this.terminal.sequence;
    await this.terminal.submitEditorText("/new", { signal: this.options.signal });
    await this.provider.waitForEvent((event) => event.type === "tool-metadata", "new session after visible error",
      this.options.signal, eventCursor);
    await this.terminal.waitForScreen((screen) => !screen.includes(marker) && screen.includes("❯"),
      { after: screenCursor, signal: this.options.signal, timeoutMs: 30_000 });
  }

  async answerDirectQuestion(cursor: number, signal: AbortSignal): Promise<void> {
    assert.ok(this.terminal, "a direct interactive question requires the native TUI");
    const terminal = this.terminal;
    const dialog = await terminal.waitForScreen((screen) => screen.includes("Choose one answer")
      && screen.includes("Direct question") && screen.includes("Alpha"), {
      after: cursor,
      signal,
      timeoutMs: 30_000,
    });
    assert.ok(dialog.includes("Direct question"), `only the direct model question may open a dialog: ${terminal.diagnostics()}`);
    assert.ok(dialog.includes("Alpha"), "the native question dialog must offer Alpha");
    const state = lastGoalState(await this.entries());
    assert.equal(state?.status, "active", "the sequential goal update must wait while the native question is open");
    terminal.write(dialogEnter);
  }

  async start(): Promise<void> {
    await this.provider.listen();
    writeFileSync(path.join(this.agent, "settings.json"), JSON.stringify({
      tuiMode: "fullscreen",
      cacheWarming: "off",
      defaultThinkingLevel: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      ...(this.options.codemode === "disabled" ? {} : { codemode: { mode: this.options.codemode } }),
    }));
    writeFileSync(path.join(this.agent, "models.json"), JSON.stringify({ providers: {
      [this.provider.name]: {
        baseUrl: this.provider.baseUrl,
        api: "openai-completions",
        apiKey: fixtureKey,
        models: [{ id: "local-model", name: "Runtime tools fixture", reasoning: false, input: ["text"], contextWindow: 100_000,
          maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    } }));
    writeFileSync(this.extensionFile, this.extensionSource(), "utf8");
    const args = this.cliArgs();
    testCounts.pi++;
    if (this.options.mode === "rpc") {
      this.rpc = new PiRpcProcess({ cliPath, args, cwd: this.project, env: this.env });
      const state = record((await this.rpc.command("get_state", {}, { signal: this.options.signal })).data, "initial RPC state");
      assert.equal(state.isStreaming, false);
      assert.equal(state.isCompacting, false);
      assert.equal(state.pendingMessageCount, 0);
    } else {
      this.terminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...args], cwd: this.project, env: this.env, cols: 110, rows: 34 });
      this.errorMonitor = this.terminal.waitForScreen((screen) => {
        if (!/\bExtension\s+"[\s\S]*?\berror:/u.test(screen)) return false;
        this.observedErrorScreen = screen;
        return true;
      }, { signal: AbortSignal.any([this.options.signal, this.errorMonitorAbort.signal]), timeoutMs: 250_000 })
        .then(() => undefined, (error: unknown) => {
          if (error instanceof Error && error.message.startsWith("Terminal exited before expected screen") && this.terminalClosing) return;
          if (error instanceof Error && error.message === "Terminal screen wait cancelled"
            && this.errorMonitorAbort.signal.aborted && !this.options.signal.aborted) return;
          this.monitorFailure = error;
        });
      await this.terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: this.options.signal });
      this.assertNoVisibleExtensionError();
    }
  }

  async beginPrompt(message: string, settlements = 1): Promise<PromptRun> {
    const cursor = this.rpc?.currentSequence ?? this.terminal?.sequence;
    assert.ok(cursor !== undefined, "Pi must be started before sending a prompt");
    const eventCursor = this.provider.events.length;
    const settlementIndex = this.provider.events.filter((event) => event.type === "agent-settled").length + 1;
    if (this.rpc) {
      const accepted = this.rpc.command("prompt", { message }, { timeoutMs: 30_000, signal: this.options.signal });
      return {
        cursor,
        settlementIndex,
        finish: async (marker) => {
          await accepted;
          let after = cursor;
          for (let index = 0; index < settlements; index++) {
            const settled = await this.rpc!.waitForRecord((event) => event.type === "agent_settled",
              { after, timeoutMs: 60_000, signal: this.options.signal });
            after = settled.sequence;
          }
          await this.assertRpcIdle();
          const messages = await this.messages();
          assert.ok(messages.some((item) => textContent(item.content).includes(marker)), `settled RPC transcript must contain ${marker}`);
          await this.acknowledgeRpcBatch();
        },
      };
    }
    assert.ok(this.terminal);
    await this.terminal.submitEditorText(message, { signal: this.options.signal });
    return {
      cursor,
      settlementIndex,
      finish: async (marker) => {
        assert.ok(this.terminal);
        await this.terminal.waitForScreen((screen) => screen.includes(marker), { after: cursor, signal: this.options.signal, timeoutMs: 60_000 });
        let after = eventCursor;
        for (let index = 0; index < settlements; index++) {
          const settled = await this.provider.waitForEvent((event) => event.type === "agent-settled",
            `TUI agent settlement ${settlementIndex + index}`, this.options.signal, after);
          after = this.provider.events.indexOf(settled) + 1;
          if (index === settlements - 1) {
            assert.equal(settled.idle, true, "final native TUI settlement must be idle");
            assert.equal(settled.pending, false, "final native TUI settlement must leave no queued messages");
          }
        }
        this.assertNoVisibleExtensionError();
      },
    };
  }

  async runPrompt(message: string, marker: string, settlements = 1): Promise<void> {
    const run = await this.beginPrompt(message, settlements);
    await run.finish(marker);
  }

  async runCommand(message: string, options: { eventType?: string; screenText?: string } = {}): Promise<void> {
    if (this.rpc) {
      const after = this.rpc.currentSequence;
      await this.rpc.command("prompt", { message }, { timeoutMs: 30_000, signal: this.options.signal });
      if (options.eventType) {
        await this.provider.waitForEvent((event) => event.type === options.eventType, options.eventType, this.options.signal);
      } else {
        const response = await this.rpc.waitFor((event) => event.type === "extension_ui_request", { after, signal: this.options.signal });
        assert.equal(response.method, "notify", `RPC command ${message} must settle through its native notification`);
        if (options.screenText) assert.ok(JSON.stringify(response).includes(options.screenText));
      }
      await this.assertRpcIdle();
      await this.acknowledgeRpcBatch();
      return;
    }
    assert.ok(this.terminal);
    const after = this.terminal.sequence;
    await this.terminal.submitEditorText(message, { signal: this.options.signal });
    if (options.eventType) {
      await this.provider.waitForEvent((event) => event.type === options.eventType, options.eventType, this.options.signal);
      return;
    }
    if (options.screenText) {
      await this.terminal.waitForScreen((screen) => screen.includes(options.screenText!), { after, signal: this.options.signal, timeoutMs: 30_000 });
    }
    this.assertNoVisibleExtensionError();
  }

  async entries(): Promise<JsonRecord[]> {
    if (this.rpc) {
      const response = await this.rpc.command("get_entries", {}, { signal: this.options.signal });
      return records(record(response.data, "RPC entries response").entries, "RPC session entries");
    }
    if (!existsSync(this.sessionFile)) {
      assert.ok(this.terminal);
      const after = this.provider.events.length;
      const id = `entries-${after}`;
      await this.terminal.submitEditorText(`/runtime-entries ${id}`, { signal: this.options.signal });
      const snapshot = await this.provider.waitForEvent((event) => event.type === "session-entries" && event.id === id,
        "public session inspection before the first assistant message flushes the session", this.options.signal, after);
      return records(snapshot.entries, "public TUI session entries");
    }
    return readFileSync(this.sessionFile, "utf8").split(/\r?\n/u).filter(Boolean)
      .map((line, index) => record(JSON.parse(line), `saved session line ${index + 1}`));
  }

  async messages(): Promise<JsonRecord[]> {
    if (this.rpc) {
      const response = await this.rpc.command("get_messages", {}, { signal: this.options.signal });
      return records(record(response.data, "RPC messages response").messages, "RPC messages");
    }
    return (await this.entries()).flatMap((entry) => entry.type === "message" && isRecord(entry.message) ? [entry.message] : []);
  }

  async assertRpcIdle(): Promise<void> {
    if (!this.rpc) return;
    const state = record((await this.rpc.command("get_state", {}, { signal: this.options.signal })).data, "RPC state");
    assert.equal(state.isStreaming, false);
    assert.equal(state.isCompacting, false);
    assert.equal(state.pendingMessageCount, 0);
  }

  private async acknowledgeRpcBatch(): Promise<void> {
    const rpc = this.rpc;
    assert.ok(rpc, "RPC evidence requires an owned RPC child");
    const end = rpc.currentSequence;
    let after = rpc.firstSequence - 1;
    while (after < end) {
      const observed = await rpc.waitForRecord(() => true, { after });
      assert.notEqual(observed.value.type, "extension_error", JSON.stringify(observed.value));
      after = observed.sequence;
    }
    rpc.acknowledge(end);
  }

  async close(options: { expectedVisibleError?: boolean } = {}): Promise<void> {
    this.provider.releaseFirstProbe();
    this.provider.releaseParallelProbe();
    const errors: unknown[] = [];
    if (this.rpc) {
      const rpc = this.rpc;
      try {
        const result = await rpc.close();
        await this.acknowledgeRpcBatch();
        assert.equal(result.forced, false, JSON.stringify(result));
        assert.equal(result.exit.code, 0, JSON.stringify(result));
        assert.equal(result.exit.signal, null, JSON.stringify(result));
        assert.equal(result.treeCleanupError, undefined, JSON.stringify(result));
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.terminal) {
      const terminal = this.terminal;
      this.terminalClosing = true;
      try {
        const result = await terminal.close();
        assert.equal(result.forced, false, JSON.stringify(result));
        assert.equal(result.code, 0, JSON.stringify(result));
        assert.equal(result.failure, undefined, JSON.stringify(result));
      } catch (error) {
        errors.push(error);
      } finally {
        this.errorMonitorAbort.abort();
        await this.errorMonitor;
        if (this.monitorFailure !== undefined) errors.push(new Error("native TUI error monitoring failed", { cause: this.monitorFailure }));
        if (options.expectedVisibleError) {
          if (this.observedErrorScreen === undefined) errors.push(new Error("The expected visible error was not observed"));
        } else if (this.observedErrorScreen !== undefined) {
          errors.push(new Error(`native TUI rendered an extension error: ${this.observedErrorScreen}`));
        }
      }
    }
    try { await this.provider.close(); } catch (error) { errors.push(error); }
    try { assertNoFixtureFaults(this.provider); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, `Pi family ${this.options.name} cleanup failed`);
  }

  diagnostics(): JsonRecord {
    return {
      name: this.options.name,
      mode: this.options.mode,
      codemode: this.options.codemode,
      providerRequests: this.provider.requests.length,
      remainingSteps: this.provider.remainingSteps,
      events: this.provider.events.slice(-32),
      providerFaults: this.provider.faults.slice(0, 8),
      rpc: this.rpc?.diagnostics(),
      terminal: this.terminal?.diagnostics(),
    };
  }

  private cliArgs(): string[] {
    const selection = this.options.tools ?? (this.options.codemode === "disabled"
      ? "question,killeros_*,exposure_probe,parallel_probe,unrelated,read,write"
      : "+codemode,+exposure_probe,+parallel_probe,+unrelated,+question");
    return [
      ...(this.options.mode === "rpc" ? ["--mode", "rpc"] : []),
      "--model", `${this.provider.name}/local-model`, "--thinking", "off", "--tools", selection,
      ...(this.options.excludeTools === undefined ? [] : ["--exclude-tools", this.options.excludeTools]),
      "--session", this.sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot, "--extension", this.extensionFile,
      ...(this.options.codemode === "disabled" ? [] : ["--extension", "builtin:codemode"]),
    ];
  }

  private extensionSource(): string {
    const eventUrl = JSON.stringify(`${this.provider.origin}/event`);
    return String.raw`import { Type } from "typebox";

const eventUrl = ${eventUrl};
let probeCount = 0;
let parallelCount = 0;
let settledCount = 0;

async function report(event) {
  const response = await fetch(eventUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
  if (!response.ok) throw new Error("runtime-tools event endpoint returned " + response.status);
}

export default function runtimeToolsProbe(pi) {
  pi.on("session_start", async () => {
    await report({ type: "tool-metadata", activeTools: pi.getActiveTools(), tools: pi.getAllTools()
      .filter((tool) => ["question", "killeros_goal_update"].includes(tool.name))
      .map((tool) => ({ name: tool.name, exposure: tool.exposure })) });
  });
  for (const event of ["tool_execution_start", "tool_execution_end"]) {
    pi.on(event, async (data) => {
      if (!data.parentToolCallId && ["question", "killeros_goal_update"].includes(data.toolName)) {
        await report({ type: event, name: data.toolName });
      }
    });
  }
  pi.on("agent_settled", async (event, ctx) => {
    await report({ type: "agent-settled", index: ++settledCount, aborted: event.aborted,
      idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
    ${this.options.faultOnSettlement ? 'throw new Error("RUNTIME_TOOLS_VISIBLE_ERROR_CONTROL");' : ""}
  });
  pi.registerTool({
    name: "exposure_probe",
    label: "Exposure probe",
    description: "Check model-only nested tool exposure.",
    parameters: Type.Object({}),
    exposure: "model-only",
    executionMode: "sequential",
    async execute(_id, _args, _signal, _update, ctx) {
      const index = ++probeCount;
      const goalEntries = () => ctx.sessionManager.getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal")
        .map((entry) => entry.type === "custom" ? entry.data : undefined);
      const before = goalEntries();
      await report({ type: "probe-start", index, callable: ctx.tools.map((tool) => tool.name) });
      const nested = [];
      for (const [name, args] of [
        ["question", { question: "Nested question", options: [{ label: "Alpha" }] }],
        ["killeros_goal_update", { status: "complete", evidence: "Nested completion" }],
      ]) {
        const outcome = await ctx.executeTool(name, args);
        nested.push({ name, isError: outcome.isError, content: outcome.result.content });
      }
      await report({ type: "probe-result", index, nested, before, after: goalEntries() });
      await report({ type: "probe-end", index });
      return { content: [{ type: "text", text: "Nested calls checked" }] };
    },
  });
  pi.registerTool({
    name: "parallel_probe",
    label: "Parallel probe",
    description: "Hold an independent operation beside a decision tool.",
    parameters: Type.Object({}),
    exposure: "model-only",
    executionMode: "parallel",
    async execute() {
      const index = ++parallelCount;
      await report({ type: "parallel-start", index });
      await report({ type: "parallel-end", index });
      return { content: [{ type: "text", text: "Parallel operation finished" }] };
    },
  });
  pi.registerTool({
    name: "unrelated",
    label: "Unrelated tool",
    description: "An ordinary direct fixture tool.",
    promptGuidelines: [${JSON.stringify(hiddenGuideline)}],
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "Unchanged" }] }; },
  });
  pi.registerCommand("runtime-entries", {
    description: "Inspect the current branch through the public session API.",
    handler: async (id, ctx) => {
      await report({ type: "session-entries", id, entries: ctx.sessionManager.getBranch() });
    },
  });
  pi.registerCommand("runtime-reload", {
    description: "Reload the real CLI extension runtime.",
    handler: async (_args, ctx) => {
      await ctx.reload();
      await report({ type: "reload-complete" });
    },
  });
  pi.registerCommand("runtime-restore-active", {
    description: "Restore an actual saved active-goal entry through native reload.",
    handler: async (_args, ctx) => {
      const saved = ctx.sessionManager.getBranch().find((entry) => entry.type === "custom"
        && entry.customType === "killeros-goal" && entry.data?.state?.status === "active");
      if (!saved || saved.type !== "custom") throw new Error("No native active-goal entry was saved");
      pi.appendEntry("killeros-goal", saved.data);
      await ctx.reload();
    },
  });
  pi.registerCommand("runtime-restore-blocked", {
    description: "Load the saved blocked-goal exclusion fixture through native reload.",
    handler: async (_args, ctx) => {
      const now = Date.now();
      pi.appendEntry("killeros-goal", {
        version: 1, event: "blocked", state: {
          version: 1, revision: 1, objective: "Finish the original blocked objective", status: "blocked",
          createdAt: now, updatedAt: now, activeMilliseconds: 0, turns: 3, blockedAuditStartTurn: 0,
          baselineTokens: 0, maxTurns: 20, result: "Waiting for an external prerequisite",
        },
      });
      await ctx.reload();
      await report({ type: "blocked-restored" });
    },
  });
}
`;
  }
}

function assertDeclarations(provider: LocalToolProvider, start: number, options: {
  codemode: CodemodeMode;
  activeGoal: boolean;
  question?: boolean;
  goalTool?: boolean;
  exposureProbe?: boolean;
  unrelated?: boolean;
  read?: boolean;
  write?: boolean;
}, end = provider.requests.length): void {
  const requests = provider.requests.slice(start, end);
  assert.ok(requests.length > 0, "the provider must receive at least one request for this state");
  for (const [offset, request] of requests.entries()) {
    const names = requestToolNames(request);
    const prompt = requestText(request);
    const systemMessages = records(request.messages, "provider messages")
      .filter((message) => message.role === "system" || message.role === "developer");
    assert.ok(systemMessages.length > 0, "the provider must receive native system instructions");
    const systemPrompt = systemMessages.map((message) => textContent(message.content)).join("\n");
    const question = options.question ?? true;
    const goalTool = options.goalTool ?? options.activeGoal;
    const exposureProbe = options.exposureProbe ?? true;
    const unrelated = options.unrelated ?? options.codemode !== "only";
    assert.equal(names.includes("question"), question, `request ${start + offset + 1}: question exposure`);
    assert.equal(names.includes("killeros_goal_update"), goalTool, `request ${start + offset + 1}: goal tool exposure`);
    assert.equal(names.includes("exposure_probe"), exposureProbe, `request ${start + offset + 1}: model-only probe exposure`);
    assert.equal(names.includes("codemode"), options.codemode !== "disabled", `request ${start + offset + 1}: codemode selection`);
    assert.equal(names.includes("unrelated"), unrelated, `request ${start + offset + 1}: codemode-only direct-tool hiding`);
    if (options.read !== undefined) assert.equal(names.includes("read"), options.read, `request ${start + offset + 1}: read selection`);
    if (options.write !== undefined) assert.equal(names.includes("write"), options.write, `request ${start + offset + 1}: write selection`);
    assert.equal(systemPrompt.includes(hiddenGuideline), unrelated, `request ${start + offset + 1}: hidden system-prompt guidelines`);
    if (question) assert.ok(systemPrompt.includes("Use question only when user input is required to choose between concrete alternatives"),
      `request ${start + offset + 1}: declared question guidance reaches the provider`);
    assert.equal(prompt.includes("Active KillerOS goal"), options.activeGoal, `request ${start + offset + 1}: active-goal prompt`);
    if (options.activeGoal) {
      assert.match(prompt, /Before ending this turn, choose exactly one accepted goal decision/u);
      assert.match(prompt, /call killeros_goal_update with status complete/u);
    }
  }
}

function assertCodemodeNativeDefaults(provider: LocalToolProvider, start: number, end = provider.requests.length): void {
  const requests = provider.requests.slice(start, end);
  assert.ok(requests.length > 0, "the +codemode workflow must reach the provider");
  for (const [offset, request] of requests.entries()) {
    const names = requestToolNames(request);
    for (const name of ["read", "bash", "edit", "write", "codemode", "question"]) {
      assert.ok(names.includes(name), `request ${start + offset + 1}: +codemode must retain ${name}`);
    }
    assert.equal(names.includes("killeros_goal_update"), offset === 0,
      `request ${start + offset + 1}: the completed goal releases its decision tool`);
  }
}

function assertToolResultOrder(provider: LocalToolProvider, request: JsonRecord, expectedNames: string[]): JsonRecord[] {
  const results = toolResults(records(request.messages, "follow-up provider messages"));
  const names = results.map((message) => {
    const callId = message.tool_call_id ?? message.toolCallId;
    assert.ok(typeof callId === "string", "tool result messages must retain their tool-call identifier");
    const name = provider.callNames.get(callId);
    assert.ok(name, `tool result ${callId} must map to a provider tool call`);
    return name;
  });
  assert.deepEqual(names, expectedNames, "Pi must return tool results in the observed sequential order");
  return results;
}

function assertNestedRejections(events: FixtureEvent[], indices: readonly number[] = [1, 2]): void {
  const selected = events.filter(event => indices.some(index => event.index === index));
  const probeTrace = selected.filter((event) => ["probe-start", "probe-result", "probe-end"].includes(String(event.type)))
    .map((event) => [event.type, event.index]);
  assert.deepEqual(probeTrace, indices.flatMap(index => [
    ["probe-start", index], ["probe-result", index], ["probe-end", index],
  ]), "model-only probe executions must remain ordered and complete");
  const results = selected.filter((event) => event.type === "probe-result");
  assert.equal(results.length, indices.length, "all selected model-only probe calls must finish");
  for (const event of results) {
    const nested = records(event.nested, "nested tool outcomes");
    assert.deepEqual(nested.map((item) => item.name), ["question", "killeros_goal_update"]);
    for (const item of nested) {
      assert.equal(item.isError, true, `${String(item.name)} must reject nested execution`);
      assert.deepEqual(item.content, [{ type: "text", text: `Tool ${String(item.name)} not found` }]);
    }
    const callable = events.find((candidate) => candidate.type === "probe-start" && candidate.index === event.index);
    assert.ok(callable);
    const callableNames = callable.callable;
    assert.ok(Array.isArray(callableNames));
    assert.equal(callableNames.includes("question"), false);
    assert.equal(callableNames.includes("killeros_goal_update"), false);
    assert.deepEqual(event.before, event.after, "rejected nested decisions must not persist goal entries");
  }
}

function assertCodemodeRejections(provider: LocalToolProvider, request: JsonRecord, requestIndex: number, callIndex: number): void {
  const callId = `${provider.name}-${requestIndex + 1}-call-${callIndex}`;
  assert.equal(provider.callNames.get(callId), "codemode", "the originating response must contain the codemode probe");
  const script = toolResults(records(request.messages, "codemode follow-up messages"))
    .find((message) => (message.tool_call_id ?? message.toolCallId) === callId);
  assert.ok(script, "the follow-up must contain the codemode tool result");
  const output = textContent(script.content);
  assert.match(output, /tools\.question does not exist/u);
  assert.match(output, /tools\.killeros_goal_update does not exist/u);
  assert.doesNotMatch(output, /Unexpected call/u);
}

async function completeQuestionTurn(family: PiFamily, run: PromptRun, marker: string, signal: AbortSignal): Promise<void> {
  if (family.mode === "tui") await family.answerDirectQuestion(run.cursor, signal);
  await run.finish(marker);
  const messages = await family.messages();
  const completion = messages.filter((message) => message.role === "toolResult" && message.toolName === "killeros_goal_update").at(-1);
  assert.ok(completion, "the native session must retain the direct completion result");
  assert.equal(completion.isError, false, JSON.stringify(completion.content));
  const question = messages.filter((message) => message.role === "toolResult" && message.toolName === "question").at(-1);
  assert.ok(question, "the native session must retain the direct question result");
  assert.equal(question.isError, family.mode !== "tui");
  assert.equal(textContent(question.content), family.mode === "tui"
    ? "User selected: Alpha" : "The question tool requires interactive TUI mode");
  if (family.mode === "tui") {
    assert.deepEqual(question.details, {
      question: "Direct question", options: ["Alpha"], answer: "Alpha", selectedIndex: 1, wasCustom: false,
    });
  }
}

async function reloadFamily(family: PiFamily): Promise<void> {
  const before = family.provider.requests.length;
  await family.runCommand("/runtime-reload", { eventType: "reload-complete" });
  assert.equal(family.provider.requests.length, before, "native extension reload must not start provider work");
  const inventories = family.provider.events.filter((event) => event.type === "tool-metadata");
  assert.ok(inventories.length >= 2, "native reload must report a fresh public tool inventory");
  assert.ok(Array.isArray(inventories[0]?.activeTools), "startup must report its active tool names");
  assert.deepEqual(inventories.at(-1)?.activeTools, inventories[0].activeTools,
    "restoring an inactive goal must preserve the exact original unrelated tool loadout");
}

function assertGoalStatus(entries: JsonRecord[], status: string, label: string): JsonRecord {
  const state = lastGoalState(entries);
  assert.ok(state, `${label}: a saved goal state must exist`);
  assert.equal(state.status, status, label);
  return state;
}

async function runMatrixFamily(mode: SessionMode, codemode: CodemodeMode, signal: AbortSignal, withReloadDefaults: boolean): Promise<JsonRecord> {
  const name = `matrix-${mode}-${codemode}`;
  const family = new PiFamily({ name, mode, codemode, signal });
  const errors: unknown[] = [];
  let primaryFailure: unknown;
  let outcome: JsonRecord | undefined;
  try {
    await family.start();

    family.provider.plan({ kind: "text", content: `NO_GOAL_${name}` });
    const noGoalStart = family.provider.requests.length;
    await family.runPrompt("Inspect the declarations without a goal", `NO_GOAL_${name}`);
    assertDeclarations(family.provider, noGoalStart, { codemode, activeGoal: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });

    const calls = [toolCall("exposure_probe", {}), toolCall("exposure_probe", {})];
    if (codemode !== "disabled") calls.push(codemodeDecisionProbe());
    // Pi serializes a whole batch if any tool is sequential, so isolate each decision tool.
    family.provider.plan({ kind: "calls", calls },
      { kind: "calls", calls: [toolCall("parallel_probe", {}),
        toolCall("question", { question: "Direct question", options: [{ label: "Alpha" }] }), toolCall("parallel_probe", {})] },
      { kind: "calls", calls: [toolCall("parallel_probe", {}),
        completionCall("Direct goal decision accepted after the question result"), toolCall("parallel_probe", {})] },
      { kind: "text", content: `ACTIVE_GOAL_${name}` });
    const activeRequestStart = family.provider.requests.length;
    const activeEventStart = family.provider.events.length;
    const activeRun = await family.beginPrompt("/goal Verify native tool exposure");
    const firstProbe = await family.provider.waitForEvent((event) => event.type === "probe-start" && event.index === 1, "first probe barrier", signal);
    assert.equal(firstProbe.index, 1);
    const heldEntries = await family.entries();
    assert.ok(goalEntries(heldEntries).length > 0, "the active goal must be saved before model decisions execute");
    assert.equal(lastGoalState(heldEntries)?.status, "active");
    family.provider.releaseFirstProbe();
    await family.provider.waitForEvent((event) => event.type === "probe-end" && event.index === 2, "second sequential probe completion", signal);
    await family.provider.waitForEvent((event) => event.type === "parallel-start" && event.index === 1,
      "parallel operation before the question", signal);
    family.provider.releaseParallelProbe();
    await completeQuestionTurn(family, activeRun, `ACTIVE_GOAL_${name}`, signal);

    const metadata = family.provider.events.find((event) => event.type === "tool-metadata");
    assert.ok(metadata, "the public tool catalog must report the decision tools");
    assert.deepEqual(records(metadata.tools, "decision metadata").sort((left, right) => String(left.name).localeCompare(String(right.name))), [
      { name: "killeros_goal_update", exposure: "model-only" }, { name: "question", exposure: "model-only" },
    ]);
    const executionOrder = family.provider.events.slice(activeEventStart)
      .filter((event) => ["parallel-start", "parallel-end", "tool_execution_start", "tool_execution_end"].includes(String(event.type)))
      .map((event) => [event.type, event.name ?? event.index]);
    assert.deepEqual(executionOrder, [
      ["parallel-start", 1], ["parallel-end", 1],
      ["tool_execution_start", "question"], ["tool_execution_end", "question"],
      ["parallel-start", 2], ["parallel-end", 2],
      ["parallel-start", 3], ["parallel-end", 3],
      ["tool_execution_start", "killeros_goal_update"], ["tool_execution_end", "killeros_goal_update"],
      ["parallel-start", 4], ["parallel-end", 4],
    ], "each decision tool must execute sequentially between independent parallel operations");

    assert.equal(family.provider.requests.length, activeRequestStart + 4);
    assertDeclarations(family.provider, activeRequestStart, { codemode, activeGoal: true,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined }, activeRequestStart + 3);
    if (withReloadDefaults) assertCodemodeNativeDefaults(family.provider, activeRequestStart, activeRequestStart + 1);
    // Pi keeps the run's system prompt while completion removes the tool before its follow-up.
    assertDeclarations(family.provider, activeRequestStart + 3, { codemode, activeGoal: true, goalTool: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
    const activeFollowUp = family.provider.requests[activeRequestStart + 3];
    assert.ok(activeFollowUp);
    const expectedOrder = ["exposure_probe", "exposure_probe", ...(codemode === "disabled" ? [] : ["codemode"]),
      "parallel_probe", "question", "parallel_probe", "parallel_probe", "killeros_goal_update", "parallel_probe"];
    const activeResults = assertToolResultOrder(family.provider, activeFollowUp, expectedOrder);
    assertNestedRejections(family.provider.events);
    if (codemode !== "disabled") assertCodemodeRejections(family.provider, activeFollowUp, activeRequestStart, 2);
    const sessionMessages = await family.messages();
    const sessionGoalResult = sessionMessages.find((message) => message.role === "toolResult" && message.toolName === "killeros_goal_update");
    assert.ok(sessionGoalResult, "the native session must retain the direct goal decision result");
    assert.equal(sessionGoalResult.isError, false);
    const decisionResult = activeResults.find((result) => family.provider.callNames.get(String(result.tool_call_id ?? result.toolCallId)) === "killeros_goal_update");
    assert.ok(decisionResult, "the provider follow-up must contain the goal decision result");
    assert.ok(textContent(decisionResult.content), "the goal decision must return a result to the provider");
    const completed = assertGoalStatus(await family.entries(), "complete", "direct goal completion");
    assert.equal(completed.turns, 1);
    assertNoFixtureFaults(family.provider);

    await reloadFamily(family);
    const afterReloadStart = family.provider.requests.length;
    if (withReloadDefaults) {
      family.provider.plan({ kind: "calls", calls: [completionCall("Native defaults survived extension reload")] },
        { kind: "text", content: `RELOAD_DEFAULTS_${name}` });
      const reloadGoalStart = family.provider.requests.length;
      await family.runPrompt("/goal Verify native defaults after reload", `RELOAD_DEFAULTS_${name}`);
      assertDeclarations(family.provider, reloadGoalStart, { codemode, activeGoal: true, read: true, write: true, unrelated: true }, reloadGoalStart + 1);
      assertDeclarations(family.provider, reloadGoalStart + 1, { codemode, activeGoal: true, goalTool: false, read: true, write: true, unrelated: true });
      assertCodemodeNativeDefaults(family.provider, reloadGoalStart, reloadGoalStart + 1);
      assert.equal(family.provider.requests[reloadGoalStart]?.tools === undefined, false);
      assert.equal(family.provider.requests.length, afterReloadStart + 2);
    } else {
      family.provider.plan({ kind: "text", content: `AFTER_RELOAD_${name}` });
      const requestStart = family.provider.requests.length;
      await family.runPrompt("Inspect completed goal after reload", `AFTER_RELOAD_${name}`);
      assertDeclarations(family.provider, requestStart, { codemode, activeGoal: false,
        read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
      assert.equal(family.provider.requests.length, afterReloadStart + 1);
    }

    family.provider.plan(
      { kind: "calls", calls: [toolCall("killeros_goal_update", { status: "blocked", blockerKey: "external", evidence: "The prerequisite remains unavailable on turn one" })] },
      { kind: "text", content: `BLOCKER_ONE_${name}` },
      { kind: "calls", calls: [toolCall("killeros_goal_update", { status: "blocked", blockerKey: "external", evidence: "The prerequisite remains unavailable on turn two" })] },
      { kind: "text", content: `BLOCKER_TWO_${name}` },
      { kind: "calls", calls: [toolCall("killeros_goal_update", { status: "blocked", blockerKey: "external", evidence: "The prerequisite remains unavailable on turn three" })] },
      { kind: "text", content: `BLOCKED_GOAL_${name}` },
    );
    const blockedRequestStart = family.provider.requests.length;
    await family.runPrompt("/goal Write the Markdown file to `report.md` and verify its contents", `BLOCKED_GOAL_${name}`, 3);
    assert.equal(family.provider.requests.length, blockedRequestStart + 6);
    for (let index = 0; index < 6; index++) {
      assertDeclarations(family.provider, blockedRequestStart + index, { codemode, activeGoal: true, goalTool: index < 5,
        read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined }, blockedRequestStart + index + 1);
    }
    const blocked = assertGoalStatus(await family.entries(), "blocked", "three acknowledged blocker audits");
    assert.equal(blocked.turns, 3);
    assert.equal(blocked.blockerAudit && record(blocked.blockerAudit, "blocker audit").streak, 3);
    const blockedCount = goalEntries(await family.entries()).length;

    await reloadFamily(family);
    assert.equal(goalEntries(await family.entries()).length, blockedCount, "reload must restore a blocked goal without appending or resuming it");
    const completionStart = family.provider.requests.length;
    const completionEventStart = family.provider.events.length;
    family.provider.plan({ kind: "calls", calls: [toolCall("exposure_probe", {}),
      ...(codemode === "disabled" ? [] : [codemodeDecisionProbe()])] });
    if (codemode === "only") {
      family.provider.plan(
        { kind: "calls", calls: [toolCall("codemode", { code: 'await tools.write({ path: "report.md", content: "Verified report\\n" }); text(await tools.read({ path: "report.md" }));' })] },
        { kind: "calls", calls: [completionCall("Read the report and audited the whole original objective")] },
        { kind: "text", content: `BLOCKED_COMPLETION_${name}` },
      );
    } else {
      family.provider.plan(
        { kind: "calls", calls: [toolCall("write", { path: "report.md", content: "Verified report\n" })] },
        { kind: "calls", calls: [toolCall("read", { path: "report.md" })] },
        { kind: "calls", calls: [completionCall("Read the report and audited the whole original objective")] },
        { kind: "text", content: `BLOCKED_COMPLETION_${name}` },
      );
    }
    await family.runPrompt("The prerequisite is resolved. Finish and verify the original report.", `BLOCKED_COMPLETION_${name}`);
    assert.equal(family.provider.requests.length - completionStart, codemode === "only" ? 4 : 5);
    assertNestedRejections(family.provider.events.slice(completionEventStart), [1]);
    if (codemode !== "disabled") assertCodemodeRejections(family.provider, family.provider.requests[completionStart + 1] ?? {}, completionStart, 1);
    assertDeclarations(family.provider, completionStart, { codemode, activeGoal: false, goalTool: true,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined }, family.provider.requests.length - 1);
    assertDeclarations(family.provider, family.provider.requests.length - 1, { codemode, activeGoal: false, goalTool: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
    assert.equal(readFileSync(path.join(family.project, "report.md"), "utf8"), "Verified report\n");
    const completedBlocked = assertGoalStatus(await family.entries(), "complete", "the same saved blocked goal completes during ordinary work");
    assert.equal(completedBlocked.lastDecision && record(completedBlocked.lastDecision, "blocked completion decision").kind, "complete");
    for (const key of ["objective", "createdAt", "verification", "baselineTokens", "turns", "maxTurns", "activeMilliseconds"] as const) {
      assert.deepEqual(completedBlocked[key], blocked[key], `blocked completion preserves ${key}`);
    }
    assert.ok(requestText(family.provider.requests[completionStart] ?? {}).includes("Status: blocked"),
      "the eligible ordinary request must receive the captured blocked goal");

    await family.runCommand("/goal clear");
    const clearDeadline = Date.now() + 30_000;
    while (lastGoalState(await family.entries()) !== undefined && Date.now() < clearDeadline && !signal.aborted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(lastGoalState(await family.entries()), undefined, "clearing a completed goal removes the saved goal state");
    await reloadFamily(family);
    assert.equal(lastGoalState(await family.entries()), undefined, "reload must preserve the cleared goal state");
    family.provider.plan({ kind: "text", content: `CLEARED_${name}` });
    const clearedStart = family.provider.requests.length;
    await family.runPrompt("Inspect declarations after clearing the goal", `CLEARED_${name}`);
    assertDeclarations(family.provider, clearedStart, { codemode, activeGoal: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });

    family.provider.plan(
      { kind: "text", content: `PAUSED_GOAL_TURN_${name}` },
      { kind: "text", content: `PAUSED_ORDINARY_${name}` },
      { kind: "calls", calls: [toolCall("exposure_probe", {}),
        ...(codemode === "disabled" ? [] : [codemodeDecisionProbe()]),
        toolCall("question", { question: "Direct question", options: [{ label: "Alpha" }] }),
        completionCall("Resumed goal completed after one accepted turn")] },
      { kind: "text", content: `RESUMED_${name}` },
    );
    const pausedGoalStart = family.provider.requests.length;
    await family.runPrompt("/goal Pause before accepting a turn decision", `PAUSED_GOAL_TURN_${name}`);
    assert.equal(family.provider.requests.length, pausedGoalStart + 1);
    assertDeclarations(family.provider, pausedGoalStart, { codemode, activeGoal: true,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
    const paused = assertGoalStatus(await family.entries(), "paused", "a paused goal stays saved");
    assert.equal(paused.turns, 1);
    assert.equal(paused.stopReason, "no turn decision");
    await reloadFamily(family);
    assert.equal(assertGoalStatus(await family.entries(), "paused", "reload preserves a saved paused goal").turns, 1);
    const pausedOrdinaryStart = family.provider.requests.length;
    await family.runPrompt("Inspect paused-goal declarations", `PAUSED_ORDINARY_${name}`);
    assertDeclarations(family.provider, pausedOrdinaryStart, { codemode, activeGoal: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
    const resumeStart = family.provider.requests.length;
    const resumeEventStart = family.provider.events.length;
    const resumeRun = await family.beginPrompt("/goal resume");
    await completeQuestionTurn(family, resumeRun, `RESUMED_${name}`, signal);
    assertNestedRejections(family.provider.events.slice(resumeEventStart), [1]);
    if (codemode !== "disabled") assertCodemodeRejections(family.provider, family.provider.requests[resumeStart + 1] ?? {}, resumeStart, 1);
    assert.equal(family.provider.requests.length - resumeStart, 2);
    assertDeclarations(family.provider, resumeStart, { codemode, activeGoal: true,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined }, resumeStart + 1);
    assertDeclarations(family.provider, resumeStart + 1, { codemode, activeGoal: true, goalTool: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
    assert.equal(assertGoalStatus(await family.entries(), "complete", "resumed goal completion").turns, 2);

    family.provider.plan(
      { kind: "calls", calls: [toolCall("exposure_probe", {}),
        ...(codemode === "disabled" ? [] : [codemodeDecisionProbe()]),
        toolCall("question", { question: "Direct question", options: [{ label: "Alpha" }] }),
        completionCall("Restored active goal completed through native reload")] },
      { kind: "text", content: `RESTORED_ACTIVE_${name}` },
    );
    const restoreStart = family.provider.requests.length;
    const restoreEventStart = family.provider.events.length;
    const restoredRun = await family.beginPrompt("/runtime-restore-active");
    await completeQuestionTurn(family, restoredRun, `RESTORED_ACTIVE_${name}`, signal);
    assertNestedRejections(family.provider.events.slice(restoreEventStart), [1]);
    if (codemode !== "disabled") assertCodemodeRejections(family.provider, family.provider.requests[restoreStart + 1] ?? {}, restoreStart, 1);
    assert.equal(family.provider.requests.length, restoreStart + 2,
      "restoring saved active work must start exactly one decision and its follow-up");
    assertDeclarations(family.provider, restoreStart, { codemode, activeGoal: true,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined }, restoreStart + 1);
    assertDeclarations(family.provider, restoreStart + 1, { codemode, activeGoal: true, goalTool: false,
      read: codemode === "only" ? false : undefined, write: codemode === "only" ? false : undefined });
    const restored = assertGoalStatus(await family.entries(), "complete", "saved active goal completion after reload");
    assert.equal(restored.objective, completed.objective, "reload must restore the original saved objective");
    assert.equal(restored.turns, 1, "restoration must use the saved initial counters");

    assertNoFixtureFaults(family.provider);
    outcome = { name, mode, codemode, requests: family.provider.requests.length, events: family.provider.events.length,
      decisionMetadata: metadata.tools, executionOrder };
  } catch (error) {
    primaryFailure = error;
  } finally {
    try { await family.close(); } catch (error) { errors.push(error); }
    if (primaryFailure !== undefined || errors.length > 0) {
      const evidence = JSON.stringify({ test: "runtime.tool-codemode-contracts", family: family.diagnostics(), counts: { ...testCounts } }, null, 2);
      try {
        const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-runtime-tools-failure-"));
        try {
          throwScenarioFailure({ directory: failureDirectory, message: `Tool/codemode family ${name} failed`,
            errors: [...(primaryFailure === undefined ? [] : [primaryFailure]), ...errors], diagnostics: evidence });
        } catch (failure) {
          if (!existsSync(path.join(failureDirectory, "failure.txt"))) throw failure;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await removeDirectoryEventually(family.directory);
      assert.equal(existsSync(family.directory), false, "remove the owned tool/codemode family directory");
    } catch (error) { errors.push(error); }
  }
  if (primaryFailure !== undefined || errors.length > 0) {
    throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...errors], `Tool/codemode family ${name} failed`);
  }
  if (outcome === undefined) throw new Error(`Tool/codemode family ${name} ended without a result`);
  return outcome;
}

async function runExclusionFamily(mode: SessionMode, excluded: "killeros_*" | "killeros_goal_update" | "question" | "allowlist", signal: AbortSignal): Promise<JsonRecord> {
  const name = `exclude-${mode}-${excluded.replaceAll("*", "wildcard")}`;
  const family = new PiFamily({ name, mode, codemode: "only", signal,
    tools: excluded === "allowlist" ? "question,codemode" : "question,killeros_*,codemode",
    ...(excluded === "allowlist" ? {} : { excludeTools: excluded }),
  });
  const errors: unknown[] = [];
  let primaryFailure: unknown;
  let outcome: JsonRecord | undefined;
  try {
    await family.start();
    const goalToolExcluded = excluded !== "question";
    if (goalToolExcluded) {
      await family.runCommand("/goal Verify exclusions through native selection", mode === "tui" ? { screenText: "killeros_goal_update is unavailable" } : {});
      const paused = assertGoalStatus(await family.entries(), "paused", `${excluded} must not be bypassed by goal activation`);
      assert.equal(paused.turns, 0);
      assert.equal(paused.stopReason, "killeros_goal_update is unavailable");
      assert.equal(family.provider.requests.length, 0, "an excluded goal tool must prevent the initial provider request");
    }

    family.provider.plan({ kind: "calls", calls: [codemodeDecisionProbe()] }, { kind: "text", content: `EXCLUSION_DONE_${name}` });
    const requestStart = family.provider.requests.length;
    await family.runPrompt(goalToolExcluded ? "Inspect the remaining declarations"
      : "/goal Verify exclusions through native selection", `EXCLUSION_DONE_${name}`);
    assert.equal(family.provider.requests.length - requestStart, 2);
    assertDeclarations(family.provider, requestStart, { codemode: "only", activeGoal: !goalToolExcluded,
      question: excluded !== "question", goalTool: !goalToolExcluded, exposureProbe: false, unrelated: false,
      read: false, write: false });
    const followUp = family.provider.requests[requestStart + 1];
    assert.ok(followUp);
    assertCodemodeRejections(family.provider, followUp, requestStart, 0);
    assert.equal(lastGoalState(await family.entries())?.status, "paused");
    if (goalToolExcluded) {
      const state = lastGoalState(await family.entries());
      assert.equal(state?.turns, 0, "codemode cannot authorize a goal turn");
      assert.equal(state?.lastDecision, undefined, "codemode cannot append a goal decision");
      assert.equal(state?.turnDecision, undefined, "codemode cannot leave a pending goal decision");
      assert.equal(state?.stopReason, "killeros_goal_update is unavailable");
    }
    if (mode === "tui") {
      assert.ok(!family.screen().includes("Choose one answer"), "a nested question must not open TUI input");
    }

    const beforeBlockedReload = family.provider.requests.length;
    await family.runCommand("/runtime-restore-blocked", { eventType: "blocked-restored" });
    assert.equal(family.provider.requests.length, beforeBlockedReload, "restoring blocked work cannot start provider work");
    const blocked = assertGoalStatus(await family.entries(), "blocked", "saved blocked exclusion fixture");
    assert.equal(blocked.objective, "Finish the original blocked objective");
    assert.equal(blocked.turns, 3);
    family.provider.plan({ kind: "calls", calls: [codemodeDecisionProbe()] },
      { kind: "text", content: `BLOCKED_EXCLUSION_DONE_${name}` });
    const blockedStart = family.provider.requests.length;
    await family.runPrompt("Finish this ordinary response without resuming the blocked goal", `BLOCKED_EXCLUSION_DONE_${name}`);
    assert.equal(family.provider.requests.length, blockedStart + 2, "exclusions must not abort ordinary blocked-goal work");
    assertDeclarations(family.provider, blockedStart, { codemode: "only", activeGoal: false,
      question: excluded !== "question", goalTool: !goalToolExcluded, exposureProbe: false, unrelated: false,
      read: false, write: false });
    for (const request of family.provider.requests.slice(blockedStart)) {
      assert.ok(requestText(request).includes("Status: blocked"), "ordinary work receives the blocked status");
      assert.ok(requestText(request).includes("Finish the original blocked objective"), "ordinary work receives the saved objective");
    }
    const blockedFollowUp = family.provider.requests[blockedStart + 1];
    assert.ok(blockedFollowUp);
    assertCodemodeRejections(family.provider, blockedFollowUp, blockedStart, 0);
    assert.deepEqual(assertGoalStatus(await family.entries(), "blocked", "nested calls preserve the saved blocked goal"), blocked);
    if (mode === "tui") assert.ok(!family.screen().includes("Choose one answer"), "blocked nested calls cannot open question UI");
    assertNoFixtureFaults(family.provider);
    outcome = { name, mode, excluded, requests: family.provider.requests.length, finalGoal: lastGoalState(await family.entries()) };
  } catch (error) {
    primaryFailure = error;
  } finally {
    try { await family.close(); } catch (error) { errors.push(error); }
    if (primaryFailure !== undefined || errors.length > 0) {
      const evidence = JSON.stringify({ test: "runtime.tool-codemode-contracts", family: family.diagnostics(), counts: { ...testCounts } }, null, 2);
      try {
        const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-runtime-tools-failure-"));
        try {
          throwScenarioFailure({ directory: failureDirectory, message: `Tool exclusion family ${name} failed`,
            errors: [...(primaryFailure === undefined ? [] : [primaryFailure]), ...errors], diagnostics: evidence });
        } catch (failure) {
          if (!existsSync(path.join(failureDirectory, "failure.txt"))) throw failure;
        }
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await removeDirectoryEventually(family.directory);
      assert.equal(existsSync(family.directory), false, "remove the owned exclusion family directory");
    } catch (error) { errors.push(error); }
  }
  if (primaryFailure !== undefined || errors.length > 0) {
    throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...errors], `Tool exclusion family ${name} failed`);
  }
  if (outcome === undefined) throw new Error(`Tool exclusion family ${name} ended without a result`);
  return outcome;
}

async function checkVisibleErrorControl(signal: AbortSignal): Promise<void> {
  const family = new PiFamily({ name: "visible-error-control", mode: "tui", codemode: "disabled", signal, faultOnSettlement: true });
  const errors: unknown[] = [];
  try {
    await family.start();
    family.provider.plan({ kind: "text", content: "VISIBLE_ERROR_CONTROL_REPLY" });
    const run = await family.beginPrompt("Exercise a native extension error");
    await family.waitForVisibleError("RUNTIME_TOOLS_VISIBLE_ERROR_CONTROL", run.cursor);
    assert.throws(() => family.assertNoVisibleExtensionError(), /native TUI rendered an extension error/,
      `the TUI error oracle must reject a real extension callback failure: ${family.screen()}`);
    await family.clearVisibleErrorForControl("RUNTIME_TOOLS_VISIBLE_ERROR_CONTROL");
    assert.doesNotMatch(family.screen(), /RUNTIME_TOOLS_VISIBLE_ERROR_CONTROL/u, "the new session clears the visible error");
    assert.throws(() => family.assertNoVisibleExtensionError(), /native TUI rendered an extension error/,
      "the monitor must retain an error after its screen is cleared");
  } catch (error) { errors.push(error); }
  try { await family.close({ expectedVisibleError: true }); } catch (error) { errors.push(error); }
  try {
    await removeDirectoryEventually(family.directory);
    assert.equal(existsSync(family.directory), false, "remove the owned visible-error control directory");
  } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "Native TUI visible-error control failed");
}

// Catalog IDs: runtime.tool-codemode-tui and runtime.tool-codemode-rpc.
for (const mode of ["tui", "rpc"] as const) {
  test(`real Pi ${mode} keeps model-only decisions sequential across codemode settings`, { timeout: 60_000 }, async (t) => {
    const results: JsonRecord[] = [];
    const before = { ...testCounts };
    for (const codemode of ["disabled", "on", "only"] as const) {
      results.push(await runMatrixFamily(mode, codemode, t.signal, mode === "tui" && codemode === "on"));
    }
    assert.deepEqual(results.map((result) => [result.mode, result.codemode]),
      [[mode, "disabled"], [mode, "on"], [mode, "only"]]);
    assert.deepEqual(results.map((result) => result.requests), mode === "tui" ? [24, 25, 23] : [24, 24, 23]);
    const processCounts = { pi: testCounts.pi - before.pi,
      providerRequests: testCounts.providerRequests - before.providerRequests,
      otherChildren: testCounts.otherChildren - before.otherChildren };
    assert.deepEqual(processCounts, { pi: 3, providerRequests: mode === "tui" ? 72 : 71, otherChildren: 0 });
    t.diagnostic(JSON.stringify({ scenarioId: `runtime.tool-codemode-${mode}`, results, processCounts }));
  });
}

// Catalog ID: runtime.tool-codemode-contracts.
const exclusions = ["killeros_*", "killeros_goal_update", "question", "allowlist"] as const;

/** Runs one bounded part of the tool-contract family and checks the Pi launches and provider requests it owns. */
async function runToolContracts(t: TestContext, scenarioId: string, expected: Omit<TestCounts, "otherChildren">,
  work: (results: JsonRecord[]) => Promise<void>): Promise<void> {
  const results: JsonRecord[] = [];
  const before = { ...testCounts };
  await work(results);
  const processCounts = { pi: testCounts.pi - before.pi,
    providerRequests: testCounts.providerRequests - before.providerRequests,
    otherChildren: testCounts.otherChildren - before.otherChildren };
  assert.deepEqual(processCounts, { ...expected, otherChildren: 0 });
  t.diagnostic(JSON.stringify({ scenarioId, results, processCounts }));
}

// The family is split so each test's sequential Pi launches fit its timeout on slower machines.
// Together the three parts launch 14 Pi processes and make 40 provider requests.
test("real Pi enforces tool exclusions in TUI", { timeout: 60_000 }, async (t: TestContext) => {
  await runToolContracts(t, "runtime.tool-exclusions-tui", { pi: 5, providerRequests: 17 }, async (results) => {
    await checkVisibleErrorControl(t.signal);
    for (const excluded of exclusions) results.push(await runExclusionFamily("tui", excluded, t.signal));
  });
});
