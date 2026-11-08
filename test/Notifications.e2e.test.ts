import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const projectTitle = "Notification E2E project";
const fixtureKey = "notification-fixture-key";
const bellGlyph = "󰂚";
const observerTimeoutMs = 30_000;

type JsonObject = Record<string, unknown>;
type AgentMode = "tui" | "rpc" | "json" | "print";
type Fixture = {
  root: string;
  project: string;
  agent: string;
  sessions: string;
  temporary: string;
  observer: string;
  session: string;
};
type ObserverEvent = JsonObject & { type: string };
type ProviderObservation = { index: number; body: JsonObject; status?: number };
type ProviderSuccess =
  | { kind: "text"; content: string }
  | { kind: "goal"; decision: JsonObject };
type ProviderResponsePlan = ProviderSuccess
  | { kind: "error"; status: number; message: string };
type ProviderPlan =
  | ProviderResponsePlan
  | { kind: "held"; barrier: ProviderBarrier; response: ProviderSuccess };
type RequestWaiter = {
  count: number;
  resolve(request: ProviderObservation): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};
type ProviderBarrier = { released: Promise<void>; release(): void };
type LocalProvider = {
  readonly baseUrl: string;
  readonly requests: ProviderObservation[];
  readonly faults: string[];
  readonly ready: Promise<void>;
  enqueue(plan: ProviderPlan): void;
  waitForRequest(count: number, signal: AbortSignal): Promise<ProviderObservation>;
  close(): Promise<void>;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function makeBarrier(): ProviderBarrier {
  let resolveRelease: () => void = () => {};
  let releasedAlready = false;
  const released = new Promise<void>((resolve) => { resolveRelease = resolve; });
  return {
    released,
    release() {
      if (releasedAlready) return;
      releasedAlready = true;
      resolveRelease();
    },
  };
}

function readObserverEvents(observerPath: string): ObserverEvent[] {
  const contents = readFileSync(observerPath, "utf8");
  const lines = contents.split(/\r?\n/u).filter(Boolean);
  return lines.map((line, index) => {
    const value: unknown = JSON.parse(line);
    const event = record(value, `observer event ${index + 1}`);
    if (typeof event.type !== "string") throw new Error(`observer event ${index + 1} has no type`);
    return { ...event, type: event.type };
  });
}

function summarizeProviderRequest(request: ProviderObservation): JsonObject {
  const rawMessages = request.body.messages;
  const messages = Array.isArray(rawMessages) ? rawMessages.filter(isRecord) : [];
  const tail = messages.slice(-4).map((message) => ({
    role: message.role ?? null,
    name: message.name ?? null,
    toolCallId: message.tool_call_id ?? null,
    content: typeof message.content === "string" ? message.content.slice(-400) : message.content ?? null,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
  }));
  const tools = Array.isArray(request.body.tools)
    ? request.body.tools.filter(isRecord).map((tool) => {
      const fn = isRecord(tool.function) ? tool.function : {};
      return typeof fn.name === "string" ? fn.name : null;
    }).filter((name) => name !== null)
    : [];
  return { index: request.index, messageCount: messages.length, tail, tools };
}

function waitForObserver(
  observerPath: string,
  predicate: (events: ObserverEvent[]) => boolean,
  signal: AbortSignal,
  label: string,
): Promise<ObserverEvent[]> {
  if (signal.aborted) return Promise.reject(new Error(`${label} wait was cancelled`, { cause: signal.reason }));

  return new Promise<ObserverEvent[]>((resolve, reject) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), observerTimeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
    };
    const finish = (error?: Error, events?: ObserverEvent[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(events ?? []);
    };
    const abort = (): void => finish(new Error(`${label} wait was cancelled`, { cause: signal.reason }));
    const check = (): void => {
      try {
        const events = readObserverEvents(observerPath);
        if (predicate(events)) finish(undefined, events);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    signal.addEventListener("abort", abort, { once: true });
    try {
      watcher = watch(observerPath, { persistent: false }, check);
      watcher.on("error", (error: Error) => finish(error));
      check();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function createParserObservers() {
  const titles: string[] = [];
  let bells = 0;
  return {
    titles,
    get bells() { return bells; },
    onTitle(title: string) {
      titles.push(title);
      if (titles.length > 32) titles.shift();
    },
    onBell() { bells += 1; },
  };
}
/** Creates an isolated notification fixture with its own project, agent, sessions, and observer log. */
function createFixture(label: string, agentRelativePath = "agent", createAgentDirectory = true): Fixture {
  const root = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-notification-${label}-`));
  const project = path.join(root, "project");
  const agent = path.join(root, agentRelativePath);
  const sessions = path.join(root, "sessions");
  const temporary = path.join(root, "tmp");
  const observer = path.join(root, "observer.jsonl");
  const session = path.join(sessions, "notification-session.jsonl");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "--quiet", project], { stdio: "pipe" });
  if (createAgentDirectory) mkdirSync(agent, { recursive: true });
  mkdirSync(sessions);
  mkdirSync(temporary);
  writeFileSync(path.join(project, "project-name.txt"), projectTitle, "utf8");
  writeFileSync(observer, "", "utf8");
  return { root, project, agent, sessions, temporary, observer, session };
}

function isolatedEnvironment(fixture: Fixture): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const appData = path.join(fixture.root, "appdata");
  const localAppData = path.join(fixture.root, "localappdata");
  const globalGitConfig = path.join(fixture.root, "empty-git-config");
  const env: NodeJS.ProcessEnv = {
    HOME: fixture.root,
    USERPROFILE: fixture.root,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: fixture.temporary,
    TMP: fixture.temporary,
    PATH: path.dirname(process.execPath),
    GIT_CONFIG_GLOBAL: globalGitConfig,
    GIT_CONFIG_SYSTEM: globalGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    PI_CODING_AGENT_DIR: fixture.agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  writeFileSync(globalGitConfig, "", "utf8");
  const permitted = new Set([
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "TEMP", "TMP", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_OPTIONAL_LOCKS",
    "GIT_NO_LAZY_FETCH", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
  ]);
  assert.deepEqual(Object.keys(env).filter((key) => !permitted.has(key)), [], "Pi receives only the fixture allowlist");
  assert.deepEqual(Object.keys(env).filter((key) => /(?:api.?key|token|secret|credential|mcp)/iu.test(key)), [],
    "the fixture environment contains no inherited credentials or MCP configuration");
  return env;
}

function writePiSettings(agentDirectory: string, providerRetries = 0): void {
  writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
    retry: { enabled: false, provider: { maxRetries: providerRetries, maxRetryDelayMs: 0 } },
    defaultThinkingLevel: "off",
  }), "utf8");
}

function writeModelSettings(agentDirectory: string, providerUrl: string): void {
  writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: {
    "notification-fixture": {
      baseUrl: providerUrl,
      api: "openai-completions",
      apiKey: fixtureKey,
      models: [{
        id: "local",
        name: "Local notification fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  } }), "utf8");
}

function observerExtensionSource(
  observerPath: string,
  options: {
    rootWithThrowingRing?: boolean;
    rootWithCountingStore?: boolean;
    settingsPath?: string;
    sessionNameCommands?: boolean;
    navigationCommands?: boolean;
  } = {},
): string {
  const rootImport = options.rootWithThrowingRing || options.rootWithCountingStore
    ? `import Killeros from ${JSON.stringify(pathToFileURL(path.join(repositoryRoot, "Killeros.ts")).href)};\n`
    : "";
  const notificationRoot = options.rootWithThrowingRing
    ? `
  const settingsPath = ${JSON.stringify(options.settingsPath)};
  Killeros(pi, {
    completionNotifications: {
      store: {
        load() {
          const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          if (settings.loadError) throw new Error("\\x1b]2;owned\\x07\\x1b[31minvalid\\x1b[0m\\0 JSON");
          appendFileSync(observerPath, JSON.stringify({type:"fixture-preference-load", enabled:settings.completionSound}) + "\\n");
          return typeof settings === "object" && settings !== null && !Array.isArray(settings)
            && settings.completionSound === true;
        },
        save(enabled) {
          const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
          if (settings.saveError) throw new Error("read-only settings");
          writeFileSync(settingsPath, JSON.stringify({ ...settings, completionSound: enabled }), "utf8");
        },
      },
       ring() { throw new Error("stdout closed"); },
    },
  });
`
    : options.rootWithCountingStore ? `
  const settingsPath = ${JSON.stringify(options.settingsPath)};
  Killeros(pi, {
    completionNotifications: {
      store: {
        load() { return JSON.parse(readFileSync(settingsPath, "utf8")).completionSound === true; },
        save(enabled) {
          appendFileSync(observerPath, JSON.stringify({type:"fixture-preference-save", enabled}) + "\\n");
          writeFileSync(settingsPath, JSON.stringify({completionSound: enabled}), "utf8");
        },
      },
      ring() {
        appendFileSync(observerPath, JSON.stringify({type:"fixture-ring"}) + "\\n");
        process.stdout.write("\\x07");
      },
    },
  });
` : "";
  const sessionNameCommands = options.sessionNameCommands
    ? `
  pi.registerCommand("fixture-notification-name", {
    description: "Set a session name through Pi's public extension API",
    handler: async (argument) => {
      if (argument === "safe") pi.setSessionName("release check");
      else if (argument === "before-hostile") pi.setSessionName("before hostile");
      else if (argument === "hostile") pi.setSessionName("release\\x1b]0;owned\\x07 check\\0\\n");
      else throw new Error("Unknown notification name fixture");
    },
  });
`
    : "";
  const navigationCommands = options.navigationCommands
    ? `
  let cancelNextTreeNavigation = false;
  pi.on("session_before_tree", (event) => {
    recordEvent("session_before_tree", {
      targetId: event.preparation.targetId,
      oldLeafId: event.preparation.oldLeafId,
    });
    return cancelNextTreeNavigation ? { cancel: true } : undefined;
  });
  pi.on("session_tree", (event) => recordEvent("session_tree", {
    newLeafId: event.newLeafId,
    oldLeafId: event.oldLeafId,
  }));
  pi.registerCommand("fixture-notification-tree", {
    description: "Attempt public Pi tree navigation",
    handler: async (argument, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const current = branch.at(-1);
      const target = branch.find((entry) => entry.id !== current?.id);
      if (!current || !target) throw new Error("A second session-tree entry is required");
      cancelNextTreeNavigation = argument === "cancel";
      try {
        const result = await ctx.navigateTree(target.id, { summarize: false });
        const finalLeaf = ctx.sessionManager.getBranch().at(-1);
        const outcome = result.cancelled ? "cancelled" : "committed";
        recordEvent("navigation_result", {
          outcome,
          initialLeafId: current.id,
          targetId: target.id,
          finalLeafId: finalLeaf?.id,
        });
        ctx.ui.notify("fixture navigation " + outcome, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordEvent("navigation_result", {
          outcome: "rejected",
          currentLeafId: ctx.sessionManager.getLeafId(),
          message,
        });
        ctx.ui.notify("fixture navigation rejected: " + message, "error");
      } finally {
        cancelNextTreeNavigation = false;
      }
    },
  });
`
    : "";

  return `${rootImport}import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const observerPath = ${JSON.stringify(observerPath)};
export default function observeNotificationLifecycle(pi) {
${options.rootWithThrowingRing || options.rootWithCountingStore ? `  pi.on("session_start", (_event, ctx) => {
    if (ctx.ui.notify.__fixtureObserved) return;
    const notify = ctx.ui.notify.bind(ctx.ui);
    const observed = (message, level) => {
      // Match the original notification-only collector, not unrelated receipt notices.
      if (message.startsWith("Completion sound")) {
        appendFileSync(observerPath, JSON.stringify({type:"fixture-notice", message, level}) + "\\n");
      }
      return notify(message, level);
    };
    observed.__fixtureObserved = true;
    ctx.ui.notify = observed;
  });` : ""}
${notificationRoot}${sessionNameCommands}
  let sequence = 0;
  let nativeRun = 0;
  const recordEvent = (type, details = {}) => appendFileSync(observerPath,
    JSON.stringify({ sequence: ++sequence, type, ...details }) + "\\n", "utf8");
${navigationCommands}
  pi.on("session_start", (_event, ctx) => recordEvent("session_start", {
    mode: ctx.mode,
    sessionName: pi.getSessionName(),
  }));
  pi.on("session_shutdown", (_event, ctx) => recordEvent("session_shutdown", { mode: ctx.mode }));
  pi.on("agent_start", (_event, ctx) => {
    nativeRun += 1;
    recordEvent("agent_start", { mode: ctx.mode, nativeRun });
  });
  pi.on("turn_start", (event) => recordEvent("turn_start", {
    nativeRun,
    turnIndex: event.turnIndex,
  }));
  pi.on("turn_end", (event) => recordEvent("turn_end", {
    nativeRun,
    turnIndex: event.turnIndex,
    stopReason: event.message?.stopReason ?? null,
    toolResults: event.toolResults.map((result) => ({ toolName: result.toolName, isError: result.isError })),
    outcome: event.outcome,
    canContinue: event.context.canContinue,
    pendingMessages: event.context.pendingMessages.length,
  }));
  pi.on("agent_before_settle", (event, ctx) => recordEvent("agent_before_settle", {
    nativeRun,
    outcome: event.outcome,
    continuationRequested: event.continue,
    canContinue: event.context.canContinue,
    pendingMessages: event.context.pendingMessages.length,
    idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(),
  }));
  pi.on("agent_end", (event, ctx) => {
    let assistant;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      if (event.messages[index]?.role === "assistant") {
        assistant = event.messages[index];
        break;
      }
    }
    recordEvent("agent_end", {
      mode: ctx.mode,
      nativeRun,
      assistantMessage: assistant !== undefined,
      stopReason: assistant?.stopReason ?? null,
      stopReasonWasUndefined: assistant !== undefined && assistant.stopReason === undefined,
    });
  });
  pi.on("agent_settled", (event, ctx) => recordEvent("agent_settled", {
    mode: ctx.mode,
    nativeRun,
    aborted: event.aborted,
    idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(),
  }));
}
`;
}

function makeProviderBarrier(): ProviderBarrier {
  return makeBarrier();
}

function createLocalProvider(): LocalProvider {
  const plans: ProviderPlan[] = [];
  const requests: ProviderObservation[] = [];
  const faults: string[] = [];
  const waiters = new Set<RequestWaiter>();
  const barriers = new Set<ProviderBarrier>();
  const handlers = new Set<Promise<void>>();
  let baseUrl = "";

  const server: Server = createServer((request, response) => {
    const handling = handleRequest(request, response);
    handlers.add(handling);
    void handling.then(() => handlers.delete(handling));
  });

  function removeWaiter(waiter: RequestWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    waiters.delete(waiter);
  }

  function publishRequest(observation: ProviderObservation): void {
    requests.push(observation);
    for (const waiter of waiters) {
      const matching = requests[waiter.count - 1];
      if (!matching) continue;
      removeWaiter(waiter);
      waiter.resolve(matching);
    }
  }

  function responseFor(plan: ProviderSuccess, index: number): { delta: JsonObject; finishReason: string } {
    if (plan.kind === "text") return { delta: { content: plan.content }, finishReason: "stop" };
    return {
      delta: {
        tool_calls: [{
          index: 0,
          id: `notification-goal-${index}`,
          type: "function",
          function: { name: "killeros_goal_update", arguments: JSON.stringify(plan.decision) },
        }],
      },
      finishReason: "tool_calls",
    };
  }

  async function readRequestBody(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      assert.ok(chunk instanceof Uint8Array, "provider body chunks must be bytes");
      bytes += chunk.byteLength;
      assert.ok(bytes <= 1_048_576, "provider request bodies are bounded to 1 MiB");
      chunks.push(Buffer.from(chunk));
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "provider request body");
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${fixtureKey}`);
      const body = await readRequestBody(request);
      const index = requests.length + 1;
      const plan = plans.shift();
      assert.ok(plan, `provider request ${index} has a scripted response`);
      publishRequest({ index, body });

      let responsePlan: ProviderResponsePlan;
      if (plan.kind === "held") {
        await plan.barrier.released;
        responsePlan = plan.response;
      } else responsePlan = plan;
      if (response.destroyed || response.writableEnded) return;

      if (responsePlan.kind === "error") {
        response.writeHead(responsePlan.status, {
          "content-type": "application/json",
          connection: "close",
          ...(responsePlan.status === 429 ? { "retry-after": "0" } : {}),
        });
        response.end(JSON.stringify({
          error: {
            message: responsePlan.message,
            type: responsePlan.status === 429 ? "rate_limit_error" : "invalid_request_error",
          },
        }));
        return;
      }

      const result = responseFor(responsePlan, index);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `notification-${index}`,
        model: "local",
        choices: [{ index: 0, delta: result.delta, finish_reason: result.finishReason }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      faults.push((error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 4_000));
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { "content-type": "text/plain", connection: "close" });
        response.end("Notification provider fixture failed");
      }
    }
  }

  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("local notification provider did not receive a TCP address"));
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve();
    });
  });

  return {
    get baseUrl() { return baseUrl; },
    requests,
    faults,
    ready: listening,
    enqueue(plan) {
      plans.push(plan);
      if (plan.kind === "held") barriers.add(plan.barrier);
    },
    waitForRequest(count, signal) {
      if (!Number.isSafeInteger(count) || count < 1) return Promise.reject(new Error(`invalid request index ${count}`));
      const existing = requests[count - 1];
      if (existing) return Promise.resolve(existing);
      if (signal.aborted) return Promise.reject(new Error("provider request wait cancelled", { cause: signal.reason }));
      return new Promise<ProviderObservation>((resolve, reject) => {
        const waiter: RequestWaiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            removeWaiter(waiter);
            reject(new Error(`timed out waiting for provider request ${count}`));
          }, observerTimeoutMs),
          signal,
        };
        waiter.abort = () => {
          removeWaiter(waiter);
          reject(new Error("provider request wait cancelled", { cause: signal.reason }));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
        waiters.add(waiter);
      });
    },
    async close() {
      for (const barrier of barriers) barrier.release();
      await listening;
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      await Promise.all([...handlers]);
      assert.equal(waiters.size, 0, "provider request waiters are cleaned up");
      assert.equal(plans.length, 0, "all scripted provider responses are consumed");
    },
  };
}

async function startTerminal(options: {
  fixture: Fixture;
  observer: string;
  model?: string;
  tools: string;
  includeRepositoryExtension?: boolean;
  cols?: number;
  parser: ReturnType<typeof createParserObservers>;
}): Promise<PiTerminalProcess> {
  const env = isolatedEnvironment(options.fixture);
  return new PiTerminalProcess({
    file: process.execPath,
    cwd: options.fixture.project,
    env,
    cols: options.cols ?? 110,
    rows: 32,
    onTitle: (title) => options.parser.onTitle(title),
    onBell: () => options.parser.onBell(),
    args: [
      cliPath,
      ...(options.model === undefined ? [] : ["--model", options.model]),
      "--thinking", "off",
      "--tools", options.tools,
      "--session", options.fixture.session,
      "--session-dir", options.fixture.sessions,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      ...(options.includeRepositoryExtension === false ? [] : ["--extension", repositoryRoot]),
      "--extension", options.observer,
    ],
  });
}

async function waitForScreen(
  terminal: PiTerminalProcess,
  signal: AbortSignal,
  predicate: (screen: string) => boolean,
  label: string,
  after = terminal.sequence,
): Promise<string> {
  return await terminal.waitForScreen(predicate, { signal, after, timeoutMs: observerTimeoutMs }).catch((error: unknown) => {
    throw new Error(`timed out waiting for terminal ${label}: ${terminal.diagnostics()}`, { cause: error });
  });
}

async function selectNotification(
  terminal: PiTerminalProcess,
  signal: AbortSignal,
  selected: "On" | "Off",
  result: "saved" | "save-failed" = "saved",
): Promise<string> {
  const dialogAfter = terminal.sequence;
  await terminal.submitEditorText("/notification", { signal: signal });
  const dialog = await waitForScreen(terminal, signal,
    (screen) => screen.includes("Completion sound") && screen.includes("↑↓ navigate"),
    "completion sound selection dialog", dialogAfter);

  const selectionAfter = terminal.sequence;
  terminal.write(selected === "On" ? "\x1b[13u" : "\x1b[B\x1b[13u");
  if (result === "saved") {
    await waitForScreen(terminal, signal, (screen) => screen.includes(`Completion sound: ${selected}`) && !screen.includes("↑↓ navigate"),
      `completion sound ${selected} acknowledgement`, selectionAfter);
  } else {
    await waitForScreen(terminal, signal, (screen) => screen.includes("Completion sound setting could not be saved:") && !screen.includes("↑↓ navigate"),
      `completion sound ${selected} save failure`, selectionAfter);
  }
  return dialog;
}

function assertNoSettingsTemporaries(agentDirectory: string, label: string): void {
  const leftovers = readdirSync(agentDirectory).filter((name) =>
    name.endsWith(".tmp") || name.includes(".lock") || name.endsWith(".stale") || name.endsWith(".recovery"));
  assert.deepEqual(leftovers, [], `${label}: settings updates must remove all owned lock and temporary files`);
}

function assertIdleSettlement(events: ObserverEvent, label: string): void {
  assert.equal(events.type, "agent_settled", `${label}: wait for the real settled lifecycle event`);
  assert.equal(events.idle, true, `${label}: Pi must report idle when agent_settled fires`);
  assert.equal(events.pending, false, `${label}: Pi must report no pending message at settlement`);
}

function countEvents(events: ObserverEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function lastEvent(events: ObserverEvent[], type: string): ObserverEvent {
  const matching = events.filter((event) => event.type === type).at(-1);
  assert.ok(matching, `expected a real ${type} observer event`);
  return matching;
}

async function closeTerminal(terminal: PiTerminalProcess | undefined, errors: unknown[]): Promise<boolean> {
  if (!terminal) return false;
  try {
    const result = await terminal.close();
    if (result.code !== 0 || result.forced || result.failure !== undefined) {
      errors.push(new Error(`Pi terminal did not exit cleanly: ${JSON.stringify(result)}\n${terminal.diagnostics()}`));
    }
    return result.code === 0 && !result.forced && result.failure === undefined;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

async function closeRpc(rpc: PiRpcProcess | undefined, errors: unknown[]): Promise<boolean> {
  if (!rpc) return false;
  try {
    const result = await rpc.close();
    if (result.exit.code !== 0 || result.forced || result.treeCleanupError !== undefined) {
      errors.push(new Error(`Pi RPC did not exit cleanly: ${JSON.stringify(result)}\n${rpc.diagnostics()}`));
    }
    return result.exit.code === 0 && result.exit.signal === null && !result.forced && result.treeCleanupError === undefined;
  } catch (error) {
    errors.push(error);
    return false;
  }
}

async function closeProvider(provider: LocalProvider | undefined, errors: unknown[]): Promise<void> {
  if (!provider) return;
  try {
    await provider.close();
    assert.deepEqual(provider.faults, [], "the scripted provider must not encounter fixture faults");
  } catch (error) {
    errors.push(error);
  }
}

async function removeFixture(fixture: Fixture | undefined, errors: unknown[]): Promise<void> {
  if (!fixture || !existsSync(fixture.root)) return;
  try {
    await removeDirectoryEventually(fixture.root);
    assert.equal(existsSync(fixture.root), false, "remove the owned notification fixture");
  } catch (error) {
    errors.push(error);
  }
}

async function reportFailure(options: {
  scenarioId: string;
  message: string;
  errors: unknown[];
  diagnostics: string;
}): Promise<never> {
  let directory: string;
  try {
    directory = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-${options.scenarioId}-failure-`));
  } catch (error) {
    throw new AggregateError([...options.errors, error], `${options.scenarioId} could not create failure evidence`);
  }
  try {
    throwScenarioFailure({ directory, message: options.message, errors: options.errors, diagnostics: options.diagnostics });
  } catch (error) {
    if (!existsSync(path.join(directory, "failure.txt"))) {
      try {
        await removeDirectoryEventually(directory);
      } catch (cleanupError) {
        throw new AggregateError([...options.errors, error, cleanupError],
          `${options.scenarioId} failed and its empty failure directory could not be removed`);
      }
    }
    throw error;
  }
}

async function runOneShotMode(options: {
  mode: "json" | "print";
  signal: AbortSignal;
}): Promise<{ stdout: string; stderr: string; mode: AgentMode; observerEvents: ObserverEvent[]; requests: number }> {
  const fixture = createFixture(`mode-${options.mode}`);
  let provider: LocalProvider | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let stdout = "";
  let stderr = "";
  let observerEvents: ObserverEvent[] = [];
  let naturalExit = false;
  try {
    provider = createLocalProvider();
    await provider.ready;
    writePiSettings(fixture.agent);
    writeModelSettings(fixture.agent, provider.baseUrl);
    writeFileSync(path.join(fixture.agent, "killeros.json"), JSON.stringify({ completionSound: true }), "utf8");
    provider.enqueue({ kind: "text", content: "noninteractive notification completion" });
    const observerPath = path.join(fixture.root, "observer-extension.mjs");
    writeFileSync(observerPath, observerExtensionSource(fixture.observer), "utf8");
    const env = isolatedEnvironment(fixture);
    const args = [
      cliPath,
      "--print",
      ...(options.mode === "json" ? ["--mode", "json"] : []),
      "--model", "notification-fixture/local",
      "--thinking", "off",
      "--tools", "read",
      "--session", fixture.session,
      "--session-dir", fixture.sessions,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", observerPath,
      "/notification",
      "noninteractive notification completion",
    ];
    const invocation = promisify(execFile)(process.execPath, args, {
      cwd: fixture.project,
      env,
      timeout: observerTimeoutMs,
      maxBuffer: 1_048_576,
      signal: options.signal,
    });
    let stdinFailure: unknown;
    try {
      invocation.child.stdin?.end();
    } catch (error) {
      stdinFailure = error;
    }
    let result: Awaited<typeof invocation>;
    try {
      result = await invocation;
    } catch (error) {
      if (stdinFailure !== undefined) throw new AggregateError([error, stdinFailure], "Could not close Pi stdin");
      throw error;
    }
    if (stdinFailure !== undefined) throw new Error("Could not close Pi stdin", { cause: stdinFailure });
    stdout = result.stdout;
    stderr = result.stderr;
    assert.equal(invocation.child.exitCode, 0, `${options.mode} mode exits naturally with code 0`);
    assert.equal(invocation.child.signalCode, null, `${options.mode} mode does not exit from a signal`);
    naturalExit = true;
    observerEvents = readObserverEvents(fixture.observer);
    assert.equal(countEvents(observerEvents, "session_start"), 1, `${options.mode}: observe one real session start`);
    assert.equal(lastEvent(observerEvents, "session_start").mode, options.mode);
    assert.equal(countEvents(observerEvents, "agent_start"), 1, `${options.mode}: the normal prompt starts one real agent run`);
    assert.equal(countEvents(observerEvents, "agent_settled"), 1, `${options.mode}: the normal prompt has one real settlement`);
    assertIdleSettlement(lastEvent(observerEvents, "agent_settled"), `${options.mode} notification suppression`);
    assert.equal(lastEvent(observerEvents, "agent_settled").mode, options.mode);
    assert.equal(provider.requests.length, 1, `${options.mode}: only the normal prompt contacts the provider`);
    const requestMessages = provider.requests[0]?.body.messages;
    assert.ok(Array.isArray(requestMessages), `${options.mode}: provider receives a message list`);
    const userMessages = requestMessages.filter(isRecord).filter((message) => message.role === "user");
    assert.equal(userMessages.length, 1, `${options.mode}: /notification is handled before model dispatch`);
    const userMessage = userMessages[0];
    assert.ok(userMessage, `${options.mode}: the ordinary prompt reaches the provider`);
    const userContent = JSON.stringify(userMessage.content);
    assert.equal(typeof userContent, "string", `${options.mode}: the provider prompt has serializable content`);
    assert.match(userContent, /noninteractive notification completion/u,
      `${options.mode}: the only model prompt is the ordinary request`);
    assert.doesNotMatch(userContent, /\/notification/u,
      `${options.mode}: the notification command is not sent to the model`);
    assert.equal(stdout.includes("setTitle"), false, `${options.mode}: notification mode must not request a terminal title`);
    assert.doesNotMatch(`${stdout}\n${stderr}`, /\x1b\](?:0|2);/u,
      `${options.mode}: no terminal title control sequence is emitted`);
    assert.equal(`${stdout}\n${stderr}`.includes("\x07"), false, `${options.mode}: no terminal bell is emitted`);
  } catch (error) {
    primaryError = error;
  }

  await closeProvider(provider, cleanupErrors);
  await removeFixture(fixture, cleanupErrors);
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId: `NOT-01-${options.mode}`,
      message: `Pi ${options.mode} notification mode failed`,
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ mode: options.mode, naturalExit, stdout: stdout.slice(0, 8_000), stderr: stderr.slice(0, 8_000),
        observerEvents, providerRequests: provider?.requests.length ?? 0, providerFaults: provider?.faults.slice(0, 8) ?? [] }, null, 2),
    });
  }
  return { stdout, stderr, mode: options.mode, observerEvents, requests: provider?.requests.length ?? 0 };
}

// Catalog ID: NOT-01.
test("Notification preference persists globally, defaults off, and rejects malformed settings", {
  timeout: 300_000,
}, async (t: TestContext) => {
  const scenarioId = "NOT-01";
  const fixture = createFixture("preference");
  const observerPath = path.join(fixture.root, "observer-extension.mjs");
  writePiSettings(fixture.agent);
  writeFileSync(observerPath, observerExtensionSource(fixture.observer), "utf8");

  let terminal: PiTerminalProcess | undefined;
  let tuiProvider: LocalProvider | undefined;
  let rpc: PiRpcProcess | undefined;
  let nestedFixture: Fixture | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  const parser = createParserObservers();
  let piLaunches = 0;
  let requestCount = 0;
  let notificationCommandRequests = 0;
  const processResults: Array<{ mode: AgentMode; label: string; requests: number; naturalExit: boolean }> = [];
  const savedSnapshots: Array<{ label: string; bytes: string; entries: string[] }> = [];

  try {
    tuiProvider = createLocalProvider();
    await tuiProvider.ready;
    writeModelSettings(fixture.agent, tuiProvider.baseUrl);
    terminal = await startTerminal({ parser, fixture, observer: observerPath, model: "notification-fixture/local", tools: "read" });
    piLaunches += 1;
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("KillerOS"), "TUI startup");
    const initialEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "session_start") === 1, t.signal, "initial TUI session_start");
    assert.equal(lastEvent(initialEvents, "session_start").mode, "tui");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`,
      "a fresh TUI title omits the bell glyph while completion sound defaults off");
    assert.equal(parser.bells, 0, "startup does not ring a preview");
    assert.equal(existsSync(path.join(fixture.agent, "killeros.json")), false,
      "the notification preference is absent on first launch");

    tuiProvider.enqueue({ kind: "text", content: "disabled notification request complete" });
    const disabledAfter = terminal.sequence;
    await terminal.submitEditorText("disabled notification request", { signal: t.signal });
    await tuiProvider.waitForRequest(1, t.signal);
    const disabledEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === 1, t.signal, "disabled TUI request settlement");
    assert.equal(countEvents(disabledEvents, "agent_start"), 1);
    assert.equal(lastEvent(disabledEvents, "agent_start").mode, "tui");
    assertIdleSettlement(lastEvent(disabledEvents, "agent_settled"), "disabled TUI request");
    assert.equal(lastEvent(disabledEvents, "agent_end").stopReason, "stop");
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("disabled notification request complete"),
      "disabled TUI request response", disabledAfter);
    assert.equal(parser.bells, 0, "a completed request while sound is disabled emits no bell");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`,
      "the settled disabled request preserves the title without a bell glyph");
    assert.equal(tuiProvider.requests.length, 1);

    const initialAgentEntries = readdirSync(fixture.agent).sort();
    const savedAgentEntries = [...initialAgentEntries, "killeros.json"].sort();
    const cancelAfter = terminal.sequence;
    await terminal.submitEditorText("/notification", { signal: t.signal });
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("Completion sound") && screen.includes("↑↓ navigate"),
      "notification dialog before cancellation", cancelAfter);
    const dismissAfter = terminal.sequence;
    terminal.write("\x1b");
    const dismissed = await waitForScreen(terminal, t.signal, (screen) => !screen.includes("↑↓ navigate"),
      "cancelled notification dialog", dismissAfter);
    assert.doesNotMatch(dismissed, /Completion sound: (?:On|Off)/u);
    assert.equal(existsSync(path.join(fixture.agent, "killeros.json")), false, "cancelling does not save a preference");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`);
    assert.equal(parser.bells, 0, "cancelling the dialog does not ring");
    const initialSelection = await selectNotification(terminal, t.signal, "On");
    assert.match(initialSelection, /Off ← current/u, "default completion sound selection is Off");
    const settingsPath = path.join(fixture.agent, "killeros.json");
    let settings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings, { completionSound: true });
    assert.doesNotMatch(terminal.screen(), /Completion sound settings could not be read:/u,
      "loading an absent preference succeeds without an error notice");
    assertNoSettingsTemporaries(fixture.agent, "enable notification sound");
    assert.deepEqual(readdirSync(fixture.agent).sort(), savedAgentEntries,
      "saving the preference adds only killeros.json to Pi's existing agent files");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)} ${bellGlyph}`);
    assert.equal(parser.bells, 0, "the disabled request and enabling sound emit no bell");

    await terminal.submitEditorText("/new", { signal: t.signal });
    await waitForObserver(fixture.observer,
      (events) => countEvents(events, "session_start") === 2, t.signal, "reload enabled preference");
    await waitForScreen(terminal, t.signal,
      () => parser.titles.at(-1) === `π - ${path.basename(fixture.project)} ${bellGlyph}`,
      "new session title reflects the saved true preference");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)} ${bellGlyph}`,
      "a new session loads the saved true preference rather than defaulting off");
    assert.equal(parser.bells, 0, "loading the enabled preference does not ring");
    const reloadedSelection = await selectNotification(terminal, t.signal, "On");
    assert.match(reloadedSelection, /On ← current/u, "a new session loads the saved true preference");

    writeFileSync(settingsPath, JSON.stringify({ futureSetting: "keep", completionSound: true }), "utf8");
    await selectNotification(terminal, t.signal, "Off");
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings, { futureSetting: "keep", completionSound: false },
      "the real command updates the preference without replacing unrelated settings");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`);
    assert.equal(parser.bells, 0);
    assertNoSettingsTemporaries(fixture.agent, "disable notification sound");
    assert.deepEqual(readdirSync(fixture.agent).sort(), savedAgentEntries,
      "preserving unrelated settings leaves no extra files");

    const malformedInputs = [
      { label: "malformed JSON", bytes: "{broken" },
      { label: "null root", bytes: "null" },
      { label: "array root", bytes: "[]" },
      { label: "string root", bytes: '"enabled"' },
      { label: "number root", bytes: "1" },
      { label: "boolean root", bytes: "true" },
    ] as const;
    for (const input of malformedInputs) {
      // Clear earlier error notices through a successful public session reset before each fault.
      writeFileSync(settingsPath, JSON.stringify({ completionSound: false }), "utf8");
      const resetStarts = countEvents(readObserverEvents(fixture.observer), "session_start") + 1;
      const resetAfter = terminal.sequence;
      await terminal.submitEditorText("/new", { signal: t.signal });
      await waitForObserver(fixture.observer,
        (events) => countEvents(events, "session_start") === resetStarts, t.signal, `${input.label} clean reset`);
      await waitForScreen(terminal, t.signal,
        (screen) => screen.includes("New session started")
          && !screen.includes("Completion sound settings could not be read:")
          && !screen.includes("Completion sound setting could not be saved:"),
        `${input.label} clean reset has no previous error notices`, resetAfter);

      writeFileSync(settingsPath, input.bytes, "utf8");
      const eventsBefore = readObserverEvents(fixture.observer);
      const expectedStarts = countEvents(eventsBefore, "session_start") + 1;
      const acceptedAfter = terminal.sequence;
      terminal.write("/new");
      await waitForScreen(terminal, t.signal, screen => screen.split("\n").some(line => line.includes("❯") && line.includes("/new")),
        `${input.label} new-session command`, acceptedAfter);
      terminal.write("\x1b[13u");
      const events = await waitForObserver(fixture.observer,
        (current) => countEvents(current, "session_start") === expectedStarts,
        t.signal,
        `${input.label} session_start after /new`);
      assert.equal(lastEvent(events, "session_start").mode, "tui", `${input.label}: new session uses TUI mode`);
      const expectedError = input.bytes === "{broken" ? /JSON|Unexpected/u : /JSON object/u;
      const loadError = await waitForScreen(terminal, t.signal,
        (screen) => screen.includes("Completion sound settings could not be read:") && expectedError.test(screen),
        `${input.label} settings load error`, acceptedAfter);
      assert.match(loadError, expectedError, `${input.label}: load reports the original validation failure`);
      assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`,
        `${input.label}: malformed settings leave sound disabled`);

      await selectNotification(terminal, t.signal, "On", "save-failed");
      assert.doesNotMatch(terminal.screen(), /Completion sound: (?:On|Off)/u,
        `${input.label}: a failed save must not report success`);
      assert.match(terminal.screen().replace(/\s+/gu, " "),
        input.bytes === "{broken"
          ? /Completion sound setting could not be saved:.*(?:JSON|Unexpected)/u
          : /Completion sound setting could not be saved:.*JSON object/u,
        `${input.label}: save reports the original validation failure`);
      const unchanged = readFileSync(settingsPath, "utf8");
      assert.equal(unchanged, input.bytes, `${input.label}: save failure leaves the original bytes unchanged`);
      assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`,
        `${input.label}: failed save does not enable sound`);
      assertNoSettingsTemporaries(fixture.agent, input.label);
      assert.deepEqual(readdirSync(fixture.agent).sort(), savedAgentEntries,
        `${input.label}: failed load and save leave no extra files`);
      savedSnapshots.push({ label: input.label, bytes: unchanged, entries: readdirSync(fixture.agent).sort() });
    }

    const mainTuiExitedNaturally = await closeTerminal(terminal, cleanupErrors);
    terminal = undefined;
    assert.equal(mainTuiExitedNaturally, true, "the preference TUI exits without forced cleanup");
    processResults.push({ mode: "tui", label: "preference and malformed settings", requests: tuiProvider.requests.length, naturalExit: true });
    await closeProvider(tuiProvider, cleanupErrors);
    tuiProvider = undefined;

    nestedFixture = createFixture("nested-directory", path.join("parent-not-created", "nested-agent"), false);
    const nestedObserver = path.join(nestedFixture.root, "observer-extension.mjs");
    writeFileSync(nestedObserver, observerExtensionSource(nestedFixture.observer), "utf8");
    nestedFixtureAgentAbsent(nestedFixture);
    terminal = await startTerminal({ parser, fixture: nestedFixture, observer: nestedObserver, tools: "read" });
    piLaunches += 1;
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("KillerOS"), "nested-agent TUI startup");
    const nestedStartup = await waitForObserver(nestedFixture.observer,
      (events) => countEvents(events, "session_start") === 1, t.signal, "nested-agent session_start");
    assert.equal(lastEvent(nestedStartup, "session_start").mode, "tui");
    rmSync(path.dirname(nestedFixture.agent), { recursive: true, force: true });
    nestedFixtureAgentAbsent(nestedFixture);
    await selectNotification(terminal, t.signal, "On");
    const nestedSettingsPath = path.join(nestedFixture.agent, "killeros.json");
    assert.deepEqual(JSON.parse(readFileSync(nestedSettingsPath, "utf8")), { completionSound: true },
      "the real command creates its missing nested agent directory and preference file");
    assert.deepEqual(readdirSync(nestedFixture.agent), ["killeros.json"]);
    assertNoSettingsTemporaries(nestedFixture.agent, "nested agent-directory save");
    const nestedTuiExitedNaturally = await closeTerminal(terminal, cleanupErrors);
    terminal = undefined;
    assert.equal(nestedTuiExitedNaturally, true, "the nested-agent TUI exits without forced cleanup");
    processResults.push({ mode: "tui", label: "nested agent directory", requests: 0, naturalExit: true });

    const modeRpc = createFixture("mode-rpc");
    let rpcProvider: LocalProvider | undefined;
    try {
      rpcProvider = createLocalProvider();
      await rpcProvider.ready;
      writePiSettings(modeRpc.agent);
      writeModelSettings(modeRpc.agent, rpcProvider.baseUrl);
      writeFileSync(path.join(modeRpc.agent, "killeros.json"), JSON.stringify({ completionSound: true }), "utf8");
      const rpcObserver = path.join(modeRpc.root, "observer-extension.mjs");
      writeFileSync(rpcObserver, observerExtensionSource(modeRpc.observer), "utf8");
      rpc = new PiRpcProcess({
        cliPath,
        cwd: modeRpc.project,
        env: isolatedEnvironment(modeRpc),
        args: ["--mode", "rpc", "--model", "notification-fixture/local", "--thinking", "off", "--tools", "read",
          "--session", modeRpc.session, "--session-dir", modeRpc.sessions, "--offline", "--approve", "--no-context-files",
          "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
          "--extension", repositoryRoot, "--extension", rpcObserver],
      });
      piLaunches += 1;
      const startup = await waitForObserver(modeRpc.observer,
        (events) => countEvents(events, "session_start") === 1, t.signal, "RPC session_start");
      assert.equal(lastEvent(startup, "session_start").mode, "rpc");
      const commandData = record((await rpc.command("get_commands", {}, { signal: t.signal })).data, "RPC commands");
      assert.ok(Array.isArray(commandData.commands));
      const commandNames = commandData.commands.filter(isRecord).map((command) => command.name);
      assert.equal(commandNames.filter((name) => name === "notification").length, 1);
      assert.equal(commandNames.includes("notifications"), false);
      const beforeCommand = rpc.currentSequence;
      const response = await rpc.command("prompt", { message: "/notification" }, { signal: t.signal, timeoutMs: observerTimeoutMs });
      assert.equal(record(response.data, "RPC notification response").disposition, "handled",
        "the real RPC command response acknowledges a handled non-agent command");
      const notice = await rpc.waitFor((entry) => entry.type === "extension_ui_request"
        && entry.method === "notify" && entry.message === "/notification requires TUI mode", {
        after: beforeCommand,
        signal: t.signal,
        timeoutMs: observerTimeoutMs,
      });
      assert.equal(notice.notifyType, "error");
      notificationCommandRequests += rpcProvider.requests.length;
      assert.equal(rpcProvider.requests.length, 0, "RPC notification command does not contact the provider");

      rpcProvider.enqueue({ kind: "text", content: "notification-rpc-normal-run" });
      const rpcEventsBeforePrompt = readObserverEvents(modeRpc.observer);
      const expectedRpcSettlements = countEvents(rpcEventsBeforePrompt, "agent_settled") + 1;
      await rpc.command("prompt", { message: "notification-rpc-normal-run" }, { signal: t.signal, timeoutMs: observerTimeoutMs });
      await rpcProvider.waitForRequest(1, t.signal);
      const rpcEvents = await waitForObserver(modeRpc.observer,
        (events) => countEvents(events, "agent_settled") === expectedRpcSettlements,
        t.signal,
        "non-TUI RPC normal prompt settlement");
      assertIdleSettlement(lastEvent(rpcEvents, "agent_settled"), "non-TUI RPC normal prompt");
      assert.equal(lastEvent(rpcEvents, "agent_settled").mode, "rpc");
      assert.equal(lastEvent(rpcEvents, "agent_end").stopReason, "stop");
      assert.equal(rpcProvider.requests.length, 1, "the ordinary RPC prompt makes exactly one request");
      const stateResponse = await rpc.command("get_state", {}, { signal: t.signal });
      const observedRpcRecords: JsonObject[] = [];
      await rpc.waitFor((entry) => {
        observedRpcRecords.push(entry);
        return entry.type === "response" && entry.command === "get_state";
      }, { after: 0, signal: t.signal, timeoutMs: observerTimeoutMs });
      const state = record(stateResponse.data, "RPC state");
      assert.equal(state.isStreaming, false);
      assert.equal(state.isCompacting, false);
      assert.equal(state.pendingMessageCount, 0);
      assert.deepEqual(observedRpcRecords.filter((entry) => entry.type === "extension_ui_request"
        && entry.method === "notify" && entry.message === "/notification requires TUI mode")
        .map((entry) => entry.notifyType), ["error"],
      "RPC reports exactly one error-severity notification for the command");
      assert.equal(observedRpcRecords.some((entry) => entry.method === "setTitle"), false,
        "RPC does not request a title through settlement");
      assert.equal(await closeRpc(rpc, cleanupErrors), true, "RPC exits naturally after stdin closes");
      const rpcDiagnostics = record(JSON.parse(rpc.diagnostics()), "closed RPC diagnostics");
      assert.equal(rpcDiagnostics.failure, undefined,
        "the RPC stream remains valid JSON through shutdown, including after settlement");
      rpc = undefined;
      processResults.push({ mode: "rpc", label: "command and normal prompt", requests: rpcProvider.requests.length, naturalExit: true });
      requestCount = processResults.reduce((total, result) => total + result.requests, 0);
    } finally {
      await closeRpc(rpc, cleanupErrors);
      rpc = undefined;
      await closeProvider(rpcProvider, cleanupErrors);
      rpcProvider = undefined;
      await removeFixture(modeRpc, cleanupErrors);
    }

    for (const mode of ["json", "print"] as const) {
      const result = await runOneShotMode({ mode, signal: t.signal });
      piLaunches += 1;
      requestCount += result.requests;
      processResults.push({ mode, label: "notification command and normal prompt", requests: result.requests, naturalExit: true });
      if (mode === "json") {
        const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
        const events = lines.map((line, index) => record(JSON.parse(line), `JSON mode output ${index + 1}`));
        assert.equal(events.filter((event) => event.type === "agent_settled").length, 1,
          "the normal JSON prompt publishes its real settlement");
        assert.equal(events.some((event) => event.method === "setTitle"), false,
          "JSON mode never requests a terminal title");
      }
    }

    assert.deepEqual(processResults.map(({ mode }) => mode), ["tui", "tui", "rpc", "json", "print"]);
    assert.equal(notificationCommandRequests, 0, "non-TUI /notification commands make no provider requests");
    assert.equal(requestCount, 4, "the TUI, RPC, JSON, and print normal prompts make one provider request each");
    assert.equal(piLaunches, 5, "NOT-01 launches normal TUI, nested TUI, RPC, JSON, and print processes");
    assert.equal(parser.bells, 0, "the disabled request and notification configuration never ring");
  } catch (error) {
    primaryError = error;
  }

  await closeTerminal(terminal, cleanupErrors);
  await closeProvider(tuiProvider, cleanupErrors);
  await removeFixture(nestedFixture, cleanupErrors);
  await removeFixture(fixture, cleanupErrors);
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId,
      message: "Notification preference E2E scenario failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ node: process.version, platform: process.platform, piLaunches, requestCount,
        notificationCommandRequests, processResults, nestedFixture: nestedFixture?.root,
        savedSnapshots, parser: { titles: parser.titles.slice(-32), bells: parser.bells }, terminal: terminal?.diagnostics() }, null, 2),
    });
  }
  t.diagnostic(JSON.stringify({ scenarioId, piLaunches, providerRequests: requestCount, notificationCommandRequests, processResults,
    malformedSettingsVectors: savedSnapshots.length, finalBellEvents: parser.bells,
    nonTuiCommandNotice: "RPC notification is observable; JSON and print expose no UI notification output" }));
});

function nestedFixtureAgentAbsent(fixture: Fixture): void {
  assert.equal(existsSync(fixture.agent), false, "Pi and the fixture have not created the nested agent directory");
  const configParent = path.dirname(fixture.agent);
  assert.equal(existsSync(configParent), false, "Pi and the fixture have not created the nested parent");
}

// Source: Notifications.test.ts:259#1. The public option observes store and ring calls in a real TUI.
test("Notification command dismisses without saving and enables once without ringing", {
  timeout: 90_000,
}, async (t: TestContext) => {
  const scenarioId = "notification-command-counts";
  const fixture = createFixture(scenarioId);
  const observerPath = path.join(fixture.root, "public-root-consumer.mjs");
  const settingsPath = path.join(fixture.agent, "fixture-preference.json");
  const initialPreference = JSON.stringify({ completionSound: false });
  const parser = createParserObservers();
  const cleanupErrors: unknown[] = [];
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  let diagnostics = "";
  let naturalExit = false;
  let observerEvents: ObserverEvent[] = [];

  try {
    writePiSettings(fixture.agent);
    writeModelSettings(fixture.agent, "http://127.0.0.1:1/v1");
    writeFileSync(settingsPath, initialPreference, "utf8");
    writeFileSync(observerPath, observerExtensionSource(fixture.observer, {
      rootWithCountingStore: true, settingsPath,
    }), "utf8");
    terminal = await startTerminal({ parser, fixture, observer: observerPath,
      model: "notification-fixture/local", tools: "read", includeRepositoryExtension: false });
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("KillerOS"), "command-count TUI startup");
    await waitForObserver(fixture.observer, (events) => countEvents(events, "session_start") === 1,
      t.signal, "command-count session_start");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`);
    assert.equal(parser.bells, 0);
    assert.equal(countEvents(readObserverEvents(fixture.observer), "fixture-preference-save"), 0);
    assert.deepEqual(readObserverEvents(fixture.observer).filter((event) => event.type === "fixture-notice"), []);

    const titlesBeforeCancel = [...parser.titles];
    const noticesBeforeCancel = terminal.screen().split("\n").filter((line) => /(?:Error|Warning):/u.test(line));
    const dialogAfter = terminal.sequence;
    await terminal.submitEditorText("/notification", { signal: t.signal });
    await waitForScreen(terminal, t.signal,
      (screen) => screen.includes("Completion sound") && screen.includes("↑↓ navigate"),
      "command-count dialog", dialogAfter);
    const dismissAfter = terminal.sequence;
    terminal.write("\x1b");
    const dismissed = await waitForScreen(terminal, t.signal, (screen) => !screen.includes("↑↓ navigate"),
      "command-count dismissed dialog", dismissAfter);
    assert.doesNotMatch(dismissed, /Completion sound: (?:On|Off)/u);
    assert.deepEqual(dismissed.split("\n").filter((line) => /(?:Error|Warning):/u.test(line)), noticesBeforeCancel,
      "Dismissing the dialog adds no error or warning to Pi's startup notices");
    assert.equal(readFileSync(settingsPath, "utf8"), initialPreference);
    assert.equal(countEvents(readObserverEvents(fixture.observer), "fixture-preference-save"), 0,
      "Dismissing the real dialog must not call the public store");
    assert.deepEqual(readObserverEvents(fixture.observer).filter((event) => event.type === "fixture-notice"), []);
    assert.deepEqual(parser.titles, titlesBeforeCancel, "Dismissal does not set another terminal title");
    assert.equal(parser.bells, 0);

    const dialog = await selectNotification(terminal, t.signal, "On");
    assert.match(dialog, /Off ← current/u);
    assert.deepEqual(readObserverEvents(fixture.observer).filter((event) => event.type === "fixture-preference-save"),
      [{ type: "fixture-preference-save", enabled: true }], "The public store receives one true save");
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { completionSound: true });
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)} ${bellGlyph}`);
    assert.equal([...parser.titles.at(-1) ?? ""].at(-1)?.codePointAt(0), 0xF009A);
    assert.deepEqual(readObserverEvents(fixture.observer).filter((event) => event.type === "fixture-notice"),
      [{ type: "fixture-notice", message: "Completion sound: On", level: "info" }]);
    assert.equal(countEvents(readObserverEvents(fixture.observer), "fixture-ring"), 0,
      "Enabling sound does not call the public ring dependency");
    assert.equal(parser.bells, 0, "Enabling sound does not emit a preview bell");
    assert.doesNotMatch(terminal.screen(), /(?:Error|Warning): Completion sound/u);
    assert.equal(countEvents(readObserverEvents(fixture.observer), "agent_start"), 0,
      "Configuration commands do not start an agent request");
    diagnostics = terminal.diagnostics();
  } catch (error) {
    primaryError = error;
    diagnostics = terminal?.diagnostics() ?? "";
  }

  naturalExit = await closeTerminal(terminal, cleanupErrors);
  try {
    observerEvents = readObserverEvents(fixture.observer);
  } catch (error) {
    cleanupErrors.push(error);
  }
  await removeFixture(fixture, cleanupErrors);
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({ scenarioId, message: "Notification command count scenario failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ terminal: diagnostics, observerEvents, titles: parser.titles, bells: parser.bells }) });
  }
  assert.equal(naturalExit, true);
  t.diagnostic(JSON.stringify({ scenarioId, piLaunches: 1, agentStarts: 0, saves: 1, rings: 0,
    cleanup: "natural TUI exit and owned fixture removed" }));
});

// Source: Notifications.test.ts:76#1. Hold Pi's real boundary after a completed assistant result.
test("Cancellation after a normal agent result suppresses the settlement bell", {
  timeout: 90_000,
}, async (t: TestContext) => {
  const scenarioId = "notification-abort-after-result";
  const fixture = createFixture(scenarioId);
  const observerPath = path.join(fixture.root, "observer-extension.mjs");
  const gateExtension = path.join(fixture.root, "settlement-gate.mjs");
  const releasePath = path.join(fixture.root, "settlement-release");
  const parser = createParserObservers();
  const cleanupErrors: unknown[] = [];
  let provider: LocalProvider | undefined;
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  let observerEvents: ObserverEvent[] = [];
  let diagnostics = "";
  let naturalExit = false;

  try {
    provider = createLocalProvider();
    await provider.ready;
    writePiSettings(fixture.agent);
    writeModelSettings(fixture.agent, provider.baseUrl);
    writeFileSync(path.join(fixture.agent, "killeros.json"), JSON.stringify({ completionSound: true }), "utf8");
    writeFileSync(observerPath, observerExtensionSource(fixture.observer), "utf8");
    writeFileSync(gateExtension, `import { appendFileSync, existsSync, watch } from "node:fs";
      import path from "node:path";
      import observe from ${JSON.stringify(pathToFileURL(observerPath).href)};
      const observer = ${JSON.stringify(fixture.observer)};
      const release = ${JSON.stringify(releasePath)};
      const record = type => appendFileSync(observer, JSON.stringify({type}) + "\\n");
      export default function(pi) {
        observe(pi);
        pi.on("session_start", (_event, ctx) => {
          ctx.ui.onTerminalInput(data => {
            if (data === "\\x1b") setImmediate(() => record("fixture-input-processed"));
          });
        });
        pi.on("agent_before_settle", async () => {
          record("fixture-settlement-held");
          await new Promise((resolve, reject) => {
            let finished = false;
            const finish = error => {
              if (finished) return;
              finished = true;
              watcher.close();
              clearTimeout(timer);
              if (error) reject(error); else resolve();
            };
            const check = () => { if (existsSync(release)) finish(); };
            const watcher = watch(path.dirname(release), check);
            watcher.on("error", finish);
            const timer = setTimeout(() => finish(new Error("Settlement gate timed out")), 20000);
            check();
          });
        });
      }`);
    terminal = await startTerminal({ parser, fixture, observer: gateExtension,
      model: "notification-fixture/local", tools: "read" });
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("KillerOS"), "abort-after-result startup");
    await waitForObserver(fixture.observer, (events) => countEvents(events, "session_start") === 1,
      t.signal, "abort-after-result session_start");
    assert.equal(parser.bells, 0);
    provider.enqueue({ kind: "text", content: "normal result before cancellation" });
    await terminal.submitEditorText("complete before the cancellation boundary", { signal: t.signal });
    await provider.waitForRequest(1, t.signal);
    const held = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "fixture-settlement-held") === 1,
      t.signal, "held settlement boundary");
    assert.equal(lastEvent(held, "agent_end").stopReason, "stop");
    assert.equal(countEvents(held, "agent_settled"), 0);
    assert.equal(parser.bells, 0, "The completed result does not ring before settlement");
    const inputBefore = countEvents(held, "fixture-input-processed");
    terminal.write("\x1b");
    await waitForObserver(fixture.observer, (events) => countEvents(events, "fixture-input-processed") > inputBefore,
      t.signal, "Escape processed while settlement is held");
    writeFileSync(releasePath, "release", "utf8");
    const settled = await waitForObserver(fixture.observer, (events) => countEvents(events, "agent_settled") === 1,
      t.signal, "aborted final settlement after normal result");
    assertIdleSettlement(lastEvent(settled, "agent_settled"), "aborted after normal result");
    assert.equal(lastEvent(settled, "agent_settled").aborted, true);
    assert.equal(lastEvent(settled, "agent_end").stopReason, "stop");
    assert.equal(parser.bells, 0, "Final cancellation suppresses the bell despite the normal result");
    assert.equal(provider.requests.length, 1);
    assert.deepEqual(provider.faults, []);
    diagnostics = terminal.diagnostics();
  } catch (error) {
    primaryError = error;
    diagnostics = terminal?.diagnostics() ?? "";
  }

  try { writeFileSync(releasePath, "release", "utf8"); } catch (error) { cleanupErrors.push(error); }
  naturalExit = await closeTerminal(terminal, cleanupErrors);
  try { observerEvents = readObserverEvents(fixture.observer); } catch (error) { cleanupErrors.push(error); }
  await closeProvider(provider, cleanupErrors);
  await removeFixture(fixture, cleanupErrors);
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({ scenarioId, message: "Notification cancellation boundary scenario failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ terminal: diagnostics, observerEvents, bells: parser.bells,
        providerRequests: provider?.requests.length ?? 0, providerFaults: provider?.faults ?? [] }) });
  }
  assert.equal(naturalExit, true);
  assert.equal(parser.bells, 0, "Final cancellation suppresses the bell despite the normal result through terminal shutdown");
  t.diagnostic(JSON.stringify({ scenarioId, piLaunches: 1, providerRequests: 1,
    order: ["normal agent_end", "held before_settle", "Escape", "aborted agent_settled"], bells: parser.bells }));
});

// Catalog ID: NOT-02.
test("Completion sound rings once at final settlement and never for aborts or retries", {
  timeout: 300_000,
}, async (t: TestContext) => {
  const scenarioId = "NOT-02";
  const fixture = createFixture("settlement");
  const observerPath = path.join(fixture.root, "observer-extension.mjs");
  const provider = createLocalProvider();
  let cancellationFixture: Fixture | undefined;
  let cancellationProvider: LocalProvider | undefined;
  writePiSettings(fixture.agent, 1);
  await provider.ready;
  writeModelSettings(fixture.agent, provider.baseUrl);
  writeFileSync(path.join(fixture.agent, "killeros.json"), JSON.stringify({ completionSound: false }), "utf8");
  writeFileSync(observerPath, observerExtensionSource(fixture.observer, { navigationCommands: true }), "utf8");
  const parser = createParserObservers();
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  let normalRequests = 0;
  let errorRequests = 0;
  let retryRequests = 0;
  let continuationRequests = 0;
  let navigationRequests = 0;
  let abortRequests = 0;
  let continuationAbortRequests = 0;
  let piLaunches = 0;
  let firstObserverSnapshot: ObserverEvent[] = [];
  let cancellationObserverSnapshot: ObserverEvent[] = [];
  let continuationEventEvidence: ObserverEvent[] = [];
  let continuationRequestEvidence: JsonObject[] = [];
  let continuationIntermediateBellCount: number | undefined;
  let finalGoalBellCount: number | undefined;
  let continuationBarrier: ProviderBarrier | undefined;
  let finalContinuationBarrier: ProviderBarrier | undefined;
  let firstTuiExitedNaturally = false;
  let cancellationTuiExitedNaturally = false;
  let terminalDiagnostics = "";

  try {
    terminal = await startTerminal({ parser, fixture, observer: observerPath, model: "notification-fixture/local",
      tools: "read,killeros_goal_update" });
    piLaunches += 1;
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("KillerOS"), "notification settlement TUI startup");
    const startupEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "session_start") === 1, t.signal, "settlement scenario session_start");
    assert.equal(lastEvent(startupEvents, "session_start").mode, "tui");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)}`,
      "completion sound starts disabled before its TUI command is used");
    assert.equal(parser.bells, 0, "the title's BEL terminator is parsed as a title event, not a completion ring");

    const idleStartCount = countEvents(startupEvents, "agent_start");
    await selectNotification(terminal, t.signal, "On");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(fixture.project)} ${bellGlyph}`,
      "the real TUI command enables the title glyph without ringing");
    const afterIdleCommand = readObserverEvents(fixture.observer);
    assert.equal(countEvents(afterIdleCommand, "agent_start"), idleStartCount,
      "the idle /notification command does not start an agent request");
    assert.equal(parser.bells, 0, "the idle extension command is not a completion");

    provider.enqueue({ kind: "text", content: "notification-normal-stop" });
    const normalStart = countEvents(readObserverEvents(fixture.observer), "agent_settled");
    const normalAfter = terminal.sequence;
    await terminal.submitEditorText("notification normal stop", { signal: t.signal });
    await provider.waitForRequest(provider.requests.length + 1, t.signal);
    const normalEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === normalStart + 1,
      t.signal,
      "normal stop agent_settled");
    const normalSettled = lastEvent(normalEvents, "agent_settled");
    assertIdleSettlement(normalSettled, "normal stop");
    assert.equal(normalSettled.aborted, false);
    assert.equal(lastEvent(normalEvents, "agent_end").stopReason, "stop");
    assert.equal(provider.requests.at(-1)?.index, 1);
    normalRequests = 1;
    await waitForScreen(terminal, t.signal, () => parser.bells >= 1, "first parsed completion bell", normalAfter);
    assert.equal(parser.bells, 1, "one real stop settlement produces one parser bell");

    const beforeCanceledNavigation = readObserverEvents(fixture.observer);
    const canceledNavigationAfter = terminal.sequence;
    await terminal.submitEditorText("/fixture-notification-tree cancel", { signal: t.signal });
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("fixture navigation cancelled"),
      "public cancelled tree navigation", canceledNavigationAfter);
    const canceledNavigationEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "navigation_result") === countEvents(beforeCanceledNavigation, "navigation_result") + 1,
      t.signal,
      "cancelled tree navigation result");
    const canceledNavigation = lastEvent(canceledNavigationEvents, "navigation_result");
    assert.equal(canceledNavigation.outcome, "cancelled");
    assert.equal(canceledNavigation.initialLeafId, canceledNavigation.finalLeafId,
      "cancelled navigation preserves the current session leaf");
    assert.equal(countEvents(canceledNavigationEvents, "session_before_tree"), 1);
    assert.equal(countEvents(canceledNavigationEvents, "session_tree"), 0,
      "cancelled navigation does not commit a new tree position");
    assert.equal(countEvents(canceledNavigationEvents, "session_start"), 1,
      "cancelled navigation does not replace the active session context");
    assert.equal(parser.bells, 1, "cancelled navigation does not ring");

    const navigationBarrier = makeProviderBarrier();
    provider.enqueue({ kind: "held", barrier: navigationBarrier, response: {
      kind: "text", content: "notification after navigation rejection",
    } });
    const navigationSettledBefore = countEvents(canceledNavigationEvents, "agent_settled");
    const navigationAfter = terminal.sequence;
    await terminal.submitEditorText("notification held during navigation attempt", { signal: t.signal });
    await provider.waitForRequest(2, t.signal);
    const treeEventsBeforeActiveAttempt = readObserverEvents(fixture.observer);
    await terminal.submitEditorText("/fixture-notification-tree cancel", { signal: t.signal });
    const activeNavigationEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "navigation_result") === countEvents(treeEventsBeforeActiveAttempt, "navigation_result") + 1,
      t.signal,
      "streaming tree navigation result");
    const rejectedNavigation = lastEvent(activeNavigationEvents, "navigation_result");
    assert.equal(rejectedNavigation.outcome, "rejected");
    assert.equal(rejectedNavigation.message, "Wait for the current response to finish before navigating the session tree.");
    assert.equal(countEvents(activeNavigationEvents, "session_before_tree"), 1,
      "Pi rejects streaming navigation before the cancellable tree hook");
    assert.equal(countEvents(activeNavigationEvents, "session_tree"), 0);
    assert.equal(countEvents(activeNavigationEvents, "agent_settled"), navigationSettledBefore,
      "the provider barrier keeps notification work pending during the navigation attempt");
    assert.equal(parser.bells, 1, "the pending request has not rung before settlement");
    navigationBarrier.release();
    const navigationSettledEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === navigationSettledBefore + 1,
      t.signal,
      "settlement after rejected navigation");
    assertIdleSettlement(lastEvent(navigationSettledEvents, "agent_settled"), "settlement after rejected navigation");
    assert.equal(lastEvent(navigationSettledEvents, "agent_end").stopReason, "stop");
    navigationRequests = 1;
    await waitForScreen(terminal, t.signal, () => parser.bells === 2,
      "pending notification after rejected navigation", navigationAfter);
    assert.equal(parser.bells, 2, "rejected navigation leaves the pending completion notification valid");

    provider.enqueue({ kind: "error", status: 400, message: "controlled final provider error" });
    const errorBefore = countEvents(navigationSettledEvents, "agent_settled");
    const errorAfter = terminal.sequence;
    await terminal.submitEditorText("notification final provider error", { signal: t.signal });
    await provider.waitForRequest(3, t.signal);
    const errorEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === errorBefore + 1,
      t.signal,
      "final provider error agent_settled");
    assertIdleSettlement(lastEvent(errorEvents, "agent_settled"), "provider error");
    assert.equal(lastEvent(errorEvents, "agent_end").stopReason, "error");
    errorRequests = 1;
    await waitForScreen(terminal, t.signal, () => parser.bells === 3, "provider error completion bell", errorAfter);
    assert.equal(parser.bells, 3, "a final provider error settlement rings once");

    const retryBarrier = makeProviderBarrier();
    provider.enqueue({ kind: "error", status: 429, message: "controlled retry" });
    provider.enqueue({ kind: "held", barrier: retryBarrier, response: { kind: "text", content: "notification-retry-finished" } });
    const retrySettledBefore = countEvents(errorEvents, "agent_settled");
    const retryAfter = terminal.sequence;
    await terminal.submitEditorText("notification retry", { signal: t.signal });
    await provider.waitForRequest(4, t.signal);
    await provider.waitForRequest(5, t.signal);
    const retryIntermediate = readObserverEvents(fixture.observer);
    assert.equal(countEvents(retryIntermediate, "agent_settled"), retrySettledBefore,
      "the provider retry has not settled the Pi run");
    assert.equal(parser.bells, 3, "an intermediate provider retry does not ring");
    retryBarrier.release();
    const retryEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === retrySettledBefore + 1,
      t.signal,
      "retried provider agent_settled");
    assertIdleSettlement(lastEvent(retryEvents, "agent_settled"), "retried provider request");
    assert.equal(lastEvent(retryEvents, "agent_end").stopReason, "stop");
    retryRequests = 2;
    await waitForScreen(terminal, t.signal, () => parser.bells === 4, "retried request completion bell", retryAfter);
    assert.equal(parser.bells, 4, "the completed retry rings once, not once per HTTP response");

    continuationBarrier = makeProviderBarrier();
    finalContinuationBarrier = makeProviderBarrier();
    provider.enqueue({ kind: "goal", decision: {
      status: "continue", evidence: "The first notification workflow step is complete", nextAction: "Finish the second step",
    } });
    provider.enqueue({ kind: "held", barrier: continuationBarrier, response: { kind: "text",
      content: "The first accepted goal decision is recorded; the next step can now start." } });
    provider.enqueue({ kind: "held", barrier: finalContinuationBarrier, response: { kind: "goal", decision: {
      status: "complete", evidence: "Both notification workflow steps are complete",
    } } });
    provider.enqueue({ kind: "text", content: "The completed goal update is acknowledged." });
    const continuationSettledBefore = countEvents(retryEvents, "agent_settled");
    const continuationStartsBefore = countEvents(retryEvents, "agent_start");
    const continuationTurnStartsBefore = countEvents(retryEvents, "turn_start");
    const continuationTurnEndsBefore = countEvents(retryEvents, "turn_end");
    const continuationAgentEndsBefore = countEvents(retryEvents, "agent_end");
    const continuationBoundariesBefore = countEvents(retryEvents, "agent_before_settle");
    const continuationRequestOffset = provider.requests.length;
    const continuationAfter = terminal.sequence;
    await terminal.submitEditorText("/goal Verify the notification continuation lifecycle", { signal: t.signal });
    await provider.waitForRequest(6, t.signal);
    await provider.waitForRequest(7, t.signal);
    const firstGoalStageHeld = readObserverEvents(fixture.observer);
    assert.equal(countEvents(firstGoalStageHeld, "agent_start") - continuationStartsBefore, 1,
      "the first goal decision uses one native agent run");
    assert.equal(countEvents(firstGoalStageHeld, "turn_start") - continuationTurnStartsBefore, 2,
      "the second provider request starts a second turn in that native run");
    assert.equal(countEvents(firstGoalStageHeld, "turn_end") - continuationTurnEndsBefore, 1,
      "the held second provider request has not ended its turn");
    assert.equal(countEvents(firstGoalStageHeld, "agent_end"), continuationAgentEndsBefore,
      "the native run has not ended while its second provider request is held");
    assert.equal(countEvents(firstGoalStageHeld, "agent_before_settle"), continuationBoundariesBefore,
      "Pi has not entered the pre-settlement boundary while the second request is held");
    assert.equal(countEvents(firstGoalStageHeld, "agent_settled"), continuationSettledBefore,
      "Pi has not settled the native run while the second request is held");
    continuationRequestEvidence = provider.requests.slice(continuationRequestOffset).map(summarizeProviderRequest);
    assert.match(JSON.stringify(continuationRequestEvidence[1]), /Model-reported progress recorded/u,
      "the second request contains the real result of the accepted continue tool call");
    assert.equal(parser.bells, 4, "the first goal stage does not ring before its native run settles");
    continuationBarrier.release();
    await provider.waitForRequest(8, t.signal);
    const firstGoalStageSettled = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === continuationSettledBefore + 1,
      t.signal,
      "first accepted goal turn agent_settled");
    const firstGoalRun = continuationStartsBefore + 1;
    assert.equal(countEvents(firstGoalStageSettled, "agent_start") - continuationStartsBefore, 2,
      "the accepted continue decision starts a second native run after the first settles");
    assert.equal(countEvents(firstGoalStageSettled, "turn_start") - continuationTurnStartsBefore, 3,
      "the two goal stages have started three turns while the second stage request is held");
    assert.equal(countEvents(firstGoalStageSettled, "turn_end") - continuationTurnEndsBefore, 2,
      "the first goal run completes both provider turns before the second run's held response");
    assert.equal(countEvents(firstGoalStageSettled, "agent_end") - continuationAgentEndsBefore, 1,
      "the first goal stage ends one native agent run");
    assert.equal(countEvents(firstGoalStageSettled, "agent_before_settle") - continuationBoundariesBefore, 1,
      "the first goal stage reaches one native pre-settlement boundary");
    assert.equal(countEvents(firstGoalStageSettled, "agent_settled") - continuationSettledBefore, 1,
      "the first goal stage has one native settlement");
    assertIdleSettlement(lastEvent(firstGoalStageSettled, "agent_settled"), "first accepted goal turn");
    assert.equal(lastEvent(firstGoalStageSettled, "agent_settled").aborted, false);
    continuationIntermediateBellCount = parser.bells;
    assert.equal(provider.requests.length, continuationRequestOffset + 3,
      "the first goal run consumes two requests and the next native run starts a third");
    assert.match(JSON.stringify(summarizeProviderRequest(provider.requests[continuationRequestOffset + 2])),
      /Finish the second step/u,
      "the next run's provider request carries the accepted goal action through Pi's real queue");
    continuationBarrier = undefined;

    finalContinuationBarrier.release();
    await provider.waitForRequest(9, t.signal);
    const continuationEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "agent_settled") === continuationSettledBefore + 2,
      t.signal,
      "final goal continuation agent_settled");
    continuationEventEvidence = continuationEvents.filter((event) =>
      typeof event.nativeRun === "number" && event.nativeRun >= firstGoalRun);
    continuationRequestEvidence = provider.requests.slice(continuationRequestOffset).map(summarizeProviderRequest);
    assert.equal(countEvents(continuationEvents, "agent_start") - countEvents(firstGoalStageSettled, "agent_start"), 0,
      "the final goal request stays in the second native run");
    assert.equal(countEvents(continuationEvents, "turn_start") - countEvents(firstGoalStageSettled, "turn_start"), 1,
      "the final goal response is the second turn in its native run");
    assert.equal(countEvents(continuationEvents, "turn_end") - countEvents(firstGoalStageSettled, "turn_end"), 2,
      "the final goal run ends its tool-call turn and its acknowledgment turn");
    assert.equal(countEvents(continuationEvents, "agent_end") - countEvents(firstGoalStageSettled, "agent_end"), 1,
      "the final goal stage ends one native agent run");
    assert.equal(countEvents(continuationEvents, "agent_before_settle") - countEvents(firstGoalStageSettled, "agent_before_settle"), 1,
      "the final goal stage reaches one native pre-settlement boundary");
    assert.equal(countEvents(continuationEvents, "agent_settled") - countEvents(firstGoalStageSettled, "agent_settled"), 1,
      "the final goal stage has one native settlement");
    assert.equal(provider.requests.length, continuationRequestOffset + 4,
      "the two logical goal stages use exactly four provider requests");
    assert.match(JSON.stringify(continuationRequestEvidence[3]), /Goal marked complete/u,
      "the fourth provider request contains the real goal-complete tool result");
    assertIdleSettlement(lastEvent(continuationEvents, "agent_settled"), "final goal continuation");
    assert.equal(lastEvent(continuationEvents, "agent_settled").aborted, false);
    continuationRequests = 4;
    assert.equal(continuationIntermediateBellCount, 5,
      "the first goal turn rings once at its actual idle settlement");
    await waitForScreen(terminal, t.signal, () => parser.bells === 6,
      "final automatic continuation completion bell", continuationAfter);
    finalGoalBellCount = parser.bells;
    finalContinuationBarrier = undefined;

    const beforeCommittedNavigation = readObserverEvents(fixture.observer);
    const committedNavigationAfter = terminal.sequence;
    await terminal.submitEditorText("/fixture-notification-tree commit", { signal: t.signal });
    await waitForScreen(terminal, t.signal, (screen) => screen.includes("fixture navigation committed"),
      "public committed tree navigation", committedNavigationAfter);
    const committedNavigationEvents = await waitForObserver(fixture.observer,
      (events) => countEvents(events, "navigation_result") === countEvents(beforeCommittedNavigation, "navigation_result") + 1,
      t.signal,
      "committed tree navigation result");
    const committedNavigation = lastEvent(committedNavigationEvents, "navigation_result");
    assert.equal(committedNavigation.outcome, "committed");
    assert.equal(committedNavigation.finalLeafId, committedNavigation.targetId,
      "committed navigation installs the selected session-tree leaf");
    assert.equal(countEvents(committedNavigationEvents, "session_before_tree"), 2);
    assert.equal(countEvents(committedNavigationEvents, "session_tree"), 1);
    assert.equal(countEvents(committedNavigationEvents, "session_start"), 1,
      "tree navigation does not replace the session context");
    assert.equal(parser.bells, finalGoalBellCount, "committed navigation does not replay a settled request bell");

    firstObserverSnapshot = readObserverEvents(fixture.observer);
    firstTuiExitedNaturally = await closeTerminal(terminal, cleanupErrors);
    terminal = undefined;
    assert.equal(firstTuiExitedNaturally, true, "the normal, error, retry, and continuation workflow exits naturally");

    const canceledFixture = createFixture("cancellation");
    cancellationFixture = canceledFixture;
    const canceledObserver = path.join(canceledFixture.root, "observer-extension.mjs");
    const canceledProvider = createLocalProvider();
    cancellationProvider = canceledProvider;
    await canceledProvider.ready;
    writePiSettings(canceledFixture.agent);
    writeModelSettings(canceledFixture.agent, canceledProvider.baseUrl);
    writeFileSync(path.join(canceledFixture.agent, "killeros.json"), JSON.stringify({ completionSound: false }), "utf8");
    writeFileSync(canceledObserver, observerExtensionSource(canceledFixture.observer), "utf8");
    terminal = await startTerminal({ parser, fixture: canceledFixture, observer: canceledObserver,
      model: "notification-fixture/local", tools: "read,killeros_goal_update" });
    const cancellationTerminal = terminal;
    piLaunches += 1;
    await waitForScreen(cancellationTerminal, t.signal, (screen) => screen.includes("KillerOS"), "cancellation TUI startup");
    const canceledStartup = await waitForObserver(canceledFixture.observer,
      (events) => countEvents(events, "session_start") === 1, t.signal, "cancellation session_start");
    assert.equal(lastEvent(canceledStartup, "session_start").mode, "tui");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(canceledFixture.project)}`);
    await selectNotification(terminal, t.signal, "On");
    assert.equal(parser.titles.at(-1), `π - ${path.basename(canceledFixture.project)} ${bellGlyph}`);
    const idleControlEvents = readObserverEvents(canceledFixture.observer);
    assert.equal(countEvents(idleControlEvents, "agent_start"), 0, "the idle notification command starts no request");
    assert.equal(countEvents(idleControlEvents, "agent_settled"), 0, "Pi emits no settlement without an active request");
    assert.equal(parser.bells, finalGoalBellCount, "the idle command adds no completion bell");

    const abortBarrier = makeProviderBarrier();
    canceledProvider.enqueue({ kind: "held", barrier: abortBarrier, response: { kind: "text", content: "must-not-finish" } });
    const abortSettledBefore = countEvents(canceledStartup, "agent_settled");
    const abortAfter = cancellationTerminal.sequence;
    await cancellationTerminal.submitEditorText("notification manual abort", { signal: t.signal });
    await canceledProvider.waitForRequest(1, t.signal);
    cancellationTerminal.write("\x1b");
    const abortedEvents = await waitForObserver(canceledFixture.observer,
      (events) => countEvents(events, "agent_settled") === abortSettledBefore + 1,
      t.signal,
      "manual abort agent_settled");
    const manualAbort = lastEvent(abortedEvents, "agent_settled");
    assertIdleSettlement(manualAbort, "manual abort");
    assert.equal(manualAbort.aborted, true, "Pi reports the actual user abort");
    assert.equal(lastEvent(abortedEvents, "agent_end").stopReason, "aborted");
    abortBarrier.release();
    abortRequests = 1;
    assert.equal(parser.bells, finalGoalBellCount, "manual abort does not ring");
    await waitForScreen(cancellationTerminal, t.signal, () => cancellationTerminal.sequence > abortAfter,
      "manual abort terminal update", abortAfter);

    const canceledContinuationBarrier = makeProviderBarrier();
    canceledProvider.enqueue({ kind: "goal", decision: {
      status: "continue", evidence: "The first step completed before cancellation", nextAction: "Start the second step",
    } });
    canceledProvider.enqueue({ kind: "held", barrier: canceledContinuationBarrier, response: { kind: "goal", decision: {
      status: "complete", evidence: "This response is released only during cleanup",
    } } });
    const continuationAbortSettledBefore = countEvents(abortedEvents, "agent_settled");
    const continuationAbortAfter = cancellationTerminal.sequence;
    await cancellationTerminal.submitEditorText("/goal Cancel after a normal intermediate result", { signal: t.signal });
    await canceledProvider.waitForRequest(2, t.signal);
    await canceledProvider.waitForRequest(3, t.signal);
    const beforeCancellation = readObserverEvents(canceledFixture.observer);
    assert.equal(countEvents(beforeCancellation, "agent_settled"), continuationAbortSettledBefore,
      "a normal intermediate goal result has not settled the overall request");
    assert.equal(parser.bells, finalGoalBellCount, "an unfinished continuation has not rung");
    cancellationTerminal.write("\x1b");
    const canceledEvents = await waitForObserver(canceledFixture.observer,
      (events) => countEvents(events, "agent_settled") === continuationAbortSettledBefore + 1,
      t.signal,
      "canceled continuation agent_settled");
    assertIdleSettlement(lastEvent(canceledEvents, "agent_settled"), "canceled continuation");
    assert.equal(lastEvent(canceledEvents, "agent_settled").aborted, true);
    assert.equal(parser.bells, finalGoalBellCount, "cancellation after a real intermediate result remains silent");
    canceledContinuationBarrier.release();
    continuationAbortRequests = 2;
    await waitForScreen(cancellationTerminal, t.signal, () => cancellationTerminal.sequence > continuationAbortAfter,
      "canceled continuation terminal update", continuationAbortAfter);

    const finalEvents = readObserverEvents(canceledFixture.observer);
    assert.equal(countEvents(firstObserverSnapshot, "agent_settled"), 6);
    assert.equal(countEvents(finalEvents, "agent_settled"), 2);
    const settledEvents = [...firstObserverSnapshot, ...finalEvents].filter((event) => event.type === "agent_settled");
    assert.equal(settledEvents.length, 8,
      "one real settled event follows each eligible request, retry, continuation, and abort");
    assert.ok(settledEvents.every((event) => event.mode === "tui"));
    assert.ok(settledEvents.every((event) => event.idle === true && event.pending === false));
    assert.equal(provider.requests.length, 9, "the first TUI consumes stop, navigation, error, retry, and four goal requests");
    assert.equal(canceledProvider.requests.length, 3, "the second TUI consumes the two cancellation workflows");
    assert.deepEqual(provider.requests.map((request) => request.index), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(canceledProvider.requests.map((request) => request.index), [1, 2, 3]);
    assert.equal(countEvents(firstObserverSnapshot, "agent_start"), 6,
      "the first TUI has six actual native agent runs, including both goal stages");
    assert.equal(countEvents(finalEvents, "agent_start"), 2,
      "the cancellation TUI has one manual-abort run and one canceled goal run");
    assert.equal(countEvents(firstObserverSnapshot, "agent_start") + countEvents(finalEvents, "agent_start"), 8,
      "the full scenario has eight actual native agent runs");
    assert.deepEqual(provider.faults, []);
    assert.deepEqual(canceledProvider.faults, []);
    cancellationObserverSnapshot = finalEvents;
    terminalDiagnostics = cancellationTerminal.diagnostics();
    cancellationTuiExitedNaturally = await closeTerminal(cancellationTerminal, cleanupErrors);
    terminal = undefined;
    assert.equal(cancellationTuiExitedNaturally, true, "the cancellation workflows exit naturally");
    assert.equal(parser.bells, finalGoalBellCount, "final cancellation and idle controls do not add completion bells");
    assert.equal(continuationIntermediateBellCount, 5,
      "Pi settles each accepted goal turn as a separate idle request");
    assert.equal(finalGoalBellCount, 6,
      "the final goal settlement contributes exactly one further bell");
    assert.equal(parser.bells, 6, "the whole notification scenario produces one bell per completed native request");
  } catch (error) {
    primaryError = error;
  }

  continuationBarrier?.release();
  finalContinuationBarrier?.release();

  if (cancellationFixture && cancellationObserverSnapshot.length === 0) {
    try {
      cancellationObserverSnapshot = readObserverEvents(cancellationFixture.observer);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (firstObserverSnapshot.length === 0) {
    try {
      firstObserverSnapshot = readObserverEvents(fixture.observer);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  cancellationTuiExitedNaturally ||= await closeTerminal(terminal, cleanupErrors);
  await closeProvider(provider, cleanupErrors);
  await closeProvider(cancellationProvider, cleanupErrors);
  await removeFixture(cancellationFixture, cleanupErrors);
  await removeFixture(fixture, cleanupErrors);
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await reportFailure({
      scenarioId,
      message: "Completion notification settlement E2E scenario failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ node: process.version, platform: process.platform, piLaunches,
        firstTuiExitedNaturally, cancellationTuiExitedNaturally,
        providerRequests: provider.requests.length + (cancellationProvider?.requests.length ?? 0), normalRequests,
        errorRequests, retryRequests, continuationRequests, navigationRequests, abortRequests, continuationAbortRequests,
        firstObserverEvents: firstObserverSnapshot.slice(-40), cancellationObserverEvents: cancellationObserverSnapshot.slice(-24),
        continuationEventEvidence, continuationRequestEvidence, continuationIntermediateBellCount,
        parser: { titles: parser.titles.slice(-32), bells: parser.bells }, providerFaults: provider.faults.slice(0, 8),
        cancellationProviderFaults: cancellationProvider?.faults.slice(0, 8) ?? [], terminal: terminalDiagnostics }, null, 2),
    });
  }
  t.diagnostic(JSON.stringify({ scenarioId, piLaunches, otherChildLaunches: 0,
    firstTuiExitedNaturally, cancellationTuiExitedNaturally,
    providerRequests: provider.requests.length + (cancellationProvider?.requests.length ?? 0),
    settledEvents: firstObserverSnapshot.filter((event) => event.type === "agent_settled").length
      + cancellationObserverSnapshot.filter((event) => event.type === "agent_settled").length,
    lowLevelRuns: firstObserverSnapshot.filter((event) => event.type === "agent_start").length
      + cancellationObserverSnapshot.filter((event) => event.type === "agent_start").length,
    continuationLifecycle: continuationEventEvidence, continuationProviderRequests: continuationRequestEvidence,
    normalRequests, errorRequests, retryRequests, continuationRequests, navigationRequests,
    abortRequests, continuationAbortRequests, finalBellEvents: parser.bells }));
});
