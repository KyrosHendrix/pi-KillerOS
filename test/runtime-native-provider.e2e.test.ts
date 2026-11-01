import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

// Catalog family: runtime.native-provider-retries. Native transport histories are
// separately selectable, including independent active and blocked retry histories.
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const killerosExtension = path.join(repositoryRoot, "Killeros.ts");
const enter = "\x1b[13u";

type RecordValue = Record<string, unknown>;
type ProbeEvent = RecordValue & { sequence: number; type: string };
type PlanStep =
  | { kind: "content"; text: string }
  | { kind: "error"; message: string }
  | { kind: "tool"; name: string; arguments: RecordValue };
type FauxStep = PlanStep & { sessionFile: string; releaseFile: string };
type NativeResponsePlan =
  | { kind: "openai-error"; status: 400 | 429; message: string; expectedUrl: string }
  | { kind: "azure-error"; status: 400; message: string }
  | { kind: "mistral-sse"; expectedUrl: string; step: PlanStep };
type TransportCapture = {
  index: number;
  method: string;
  url: string;
  authorization: string | null;
  apiKey: string | null;
  body: unknown;
  status: number;
};
type RequestHold = {
  waitStarted(signal: AbortSignal): Promise<TransportCapture>;
  release(): void;
};
type LoopbackTransport = {
  url: string;
  captureFile: string;
  failures: string[];
  captures(): TransportCapture[];
  holdNextRequest(): RequestHold;
  releaseAll(): void;
  close(): Promise<void>;
};
type Family = {
  directory: string;
  project: string;
  agent: string;
  env: NodeJS.ProcessEnv;
};
type FamilyScope = Family & {
  terminal: PiTerminalProcess | undefined;
  transport: LoopbackTransport | undefined;
  releaseFiles: Set<string>;
  launchTerminal(args: string[], env: NodeJS.ProcessEnv): PiTerminalProcess;
  closeTransport(): Promise<TransportCapture[]>;
};

const probeExtensionSource = String.raw`import fs from "node:fs";
const probeFile = process.env.KILLEROS_NATIVE_PROBE;
if (!probeFile) throw new Error("KillerOS native probe file is missing");
// Reload re-evaluates this module while the owned event file survives.
let sequence = fs.readFileSync(probeFile, "utf8").split("\n").filter(Boolean).length;
function record(type, details = {}) {
  sequence += 1;
  fs.appendFileSync(probeFile, JSON.stringify({ sequence, type, ...details }) + "\n", "utf8");
}
export default function (pi) {
  pi.on("session_start", (_event, ctx) => record("session_start", {
    mode: ctx.mode, sessionFile: ctx.sessionManager.getSessionFile(),
  }));
  pi.on("agent_start", (_event, ctx) => record("agent_start", {
    sessionFile: ctx.sessionManager.getSessionFile(),
  }));
  pi.on("message_start", (event, ctx) => record("message_start", {
    role: event?.message?.role ?? null,
    customType: event?.message?.customType ?? null,
    sessionFile: ctx.sessionManager.getSessionFile(),
  }));
  pi.on("agent_end", (event, ctx) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const assistant = [...messages].reverse().find((message) => message && message.role === "assistant");
    record("agent_end", {
      stopReason: assistant?.stopReason ?? null,
      errorMessage: assistant?.errorMessage ?? null,
      sessionFile: ctx.sessionManager.getSessionFile(),
    });
  });
  pi.on("agent_settled", (event, ctx) => record("agent_settled", {
    aborted: event?.aborted === true,
    idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(),
    sessionFile: ctx.sessionManager.getSessionFile(),
  }));
}
`;

const loopbackFetchSource = String.raw`const transportUrl = process.env.KILLEROS_NATIVE_TRANSPORT_URL;
if (!transportUrl) throw new Error("KillerOS loopback transport URL is missing");
async function loopbackFetch(input, init) {
  const externalRequest = new Request(input, init);
  const headers = new Headers(externalRequest.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.set("x-killeros-native-url", externalRequest.url);
  const body = externalRequest.method === "GET" || externalRequest.method === "HEAD"
    ? undefined
    : await externalRequest.arrayBuffer();
  return await fetch(transportUrl, {
    method: externalRequest.method,
    headers,
    body,
    signal: externalRequest.signal,
    redirect: "manual",
  });
}`;

const openaiWrapperSource = [
  'import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";',
  "const native = openaiProvider();",
  loopbackFetchSource,
  "export default function (pi) {",
  "  pi.registerProvider({",
  "    ...native,",
  "    streamSimple: (model, context, options) => native.streamSimple(model, context, {",
  "      ...options, fetch: loopbackFetch, maxRetries: 1,",
  "    }),",
  "  });",
  "}",
].join("\n");

const azureWrapperSource = [
  'import fs from "node:fs";',
  'import { azureProvider } from "@earendil-works/pi-ai/providers/azure";',
  "const native = azureProvider();",
  loopbackFetchSource,
  'const injected = JSON.parse(fs.readFileSync(process.env.KILLEROS_NATIVE_ENV, "utf8"));',
  "export default function (pi) {",
  "  pi.registerProvider({",
  "    ...native,",
  "    streamSimple: (model, context, options) => native.streamSimple(model, context, {",
  "      ...options, fetch: loopbackFetch, maxRetries: 0, env: { ...options?.env, ...injected },",
  "    }),",
  "  });",
  "}",
].join("\n");

const mistralWrapperSource = [
  'import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";',
  "const native = mistralProvider();",
  loopbackFetchSource,
  "export default function (pi) {",
  "  pi.registerProvider({",
  "    ...native,",
  "    streamSimple: (model, context, options) => native.streamSimple(model, context, { ...options, fetch: loopbackFetch }),",
  "  });",
  "}",
].join("\n");

const fauxWrapperSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const probeFile = process.env.KILLEROS_NATIVE_PROBE;
const captureFile = process.env.KILLEROS_NATIVE_CAPTURE;
const planFile = process.env.KILLEROS_NATIVE_PLAN;
if (!probeFile || !captureFile || !planFile) throw new Error("KillerOS faux fixture paths are missing");
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
if (!Array.isArray(plan.steps)) throw new Error("KillerOS faux plan needs a steps array");
const faux = fauxProvider({ provider: "killeros-native-retry", models: [{
  id: "local", contextWindow: 100000, maxTokens: 1000,
}] });
function readJsonl(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
function waitForRelease(file) {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const check = (name) => {
      if (name && name.toString() !== path.basename(file)) return;
      if (fs.existsSync(file)) finish();
    };
    const watcher = fs.watch(path.dirname(file), (_event, name) => check(name));
    watcher.on("error", finish);
    const timer = setTimeout(() => finish(new Error("Timed out waiting for parent to release a faux response")), 120000);
    check();
  });
}
function responseFor(step) {
  switch (step.kind) {
    case "error":
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.message });
    case "tool":
      return fauxAssistantMessage(fauxToolCall(step.name, step.arguments));
    case "content":
      return fauxAssistantMessage(step.text);
    default:
      throw new Error("Unknown KillerOS faux plan step");
  }
}
function receiptCount(sessionFile) {
  return readJsonl(sessionFile).filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for").length;
}
let consumed = 0;
const responses = plan.steps.map((step) => async () => {
  const settled = readJsonl(probeFile).filter((event) =>
    event.type === "agent_settled" && event.sessionFile === step.sessionFile).length;
  const receipts = receiptCount(step.sessionFile);
  if (settled !== 0 || receipts !== settled) {
    throw new Error("A faux provider response started after settlement or before its receipt boundary");
  }
  fs.appendFileSync(captureFile, JSON.stringify({ index: consumed, step, unexpected: false }) + "\n", "utf8");
  consumed += 1;
  await waitForRelease(step.releaseFile);
  return responseFor(step);
});
responses.push(async () => {
  fs.appendFileSync(captureFile, JSON.stringify({ index: consumed, unexpected: true }) + "\n", "utf8");
  throw new Error("KillerOS faux response plan exhausted");
});
faux.setResponses(responses);
export default function (pi) {
  pi.registerProvider(faux.provider);
}`;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `Expected ${label} to be an object`);
  return value;
}

function stringField(value: RecordValue, key: string): string {
  const field = value[key];
  assert.ok(typeof field === "string", `Expected ${key} to be a string`);
  return field;
}

function numberField(value: RecordValue, key: string): number {
  const field = value[key];
  assert.ok(typeof field === "number", `Expected ${key} to be a number`);
  return field;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function completeJsonlLines(file: string): string[] {
  const contents = readFileSync(file, "utf8");
  const lines = contents.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  else lines.pop();
  return lines.filter(Boolean);
}

function probeEvents(file: string): ProbeEvent[] {
  return completeJsonlLines(file).map((line, index) => {
    const value = record(JSON.parse(line), "probe event");
    assert.equal(numberField(value, "sequence"), index + 1, "Native probe cursor stays monotonic across reload");
    return { ...value, sequence: numberField(value, "sequence"), type: stringField(value, "type") };
  });
}

function captureRecords(file: string): RecordValue[] {
  return completeJsonlLines(file).map((line) => record(JSON.parse(line), "captured provider response"));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headerValue(request: IncomingMessage, key: string): string | null {
  const value = request.headers[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return null;
}

function responseStatus(plan: NativeResponsePlan): number {
  switch (plan.kind) {
    case "openai-error":
    case "azure-error":
      return plan.status;
    case "mistral-sse":
      return 200;
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

function startHold(): {
  hold: RequestHold;
  signalStarted(capture: TransportCapture): void;
  released: Promise<void>;
} {
  let resolveStarted = (_capture: TransportCapture): void => {};
  const started = new Promise<TransportCapture>((resolve) => { resolveStarted = resolve; });
  let releaseResponse = (): void => {};
  const released = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let isReleased = false;
  return {
    hold: {
      waitStarted: async (signal) => {
        if (signal.aborted) throw new Error("Loopback provider wait cancelled", { cause: signal.reason });
        return await new Promise<TransportCapture>((resolve, reject) => {
          let complete = false;
          const finish = (error: Error | undefined, capture: TransportCapture | undefined): void => {
            if (complete) return;
            complete = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else if (capture) resolve(capture);
          };
          const abort = (): void => finish(new Error("Loopback provider wait cancelled", { cause: signal.reason }), undefined);
          const timer = setTimeout(() => finish(new Error("Timed out waiting for a loopback provider request"), undefined), 120_000);
          signal.addEventListener("abort", abort, { once: true });
          void started.then((capture) => finish(undefined, capture));
        });
      },
      release: () => {
        if (isReleased) return;
        isReleased = true;
        releaseResponse();
      },
    },
    signalStarted: resolveStarted,
    released,
  };
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new Error("Loopback provider request yielded a non-Buffer body chunk");
    byteLength += value.length;
    if (byteLength > 1_048_576) throw new Error("Loopback provider request exceeded the 1 MiB fixture limit");
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length === 0 ? undefined : JSON.parse(text);
}

function sendPlanResponse(response: ServerResponse, plan: NativeResponsePlan, requestBody: unknown): void {
  switch (plan.kind) {
    case "openai-error":
    case "azure-error": {
      response.writeHead(plan.status, {
        "content-type": "application/json",
        ...(plan.status === 429 ? { "retry-after-ms": "1" } : {}),
      });
      response.end(JSON.stringify({
        error: {
          message: plan.message,
          ...(plan.kind === "openai-error" ? { type: "invalid_request_error", code: "priority_rejected" } : {}),
        },
      }));
      return;
    }
    case "mistral-sse": {
      const body = record(requestBody, "native Mistral request body");
      let delta: RecordValue;
      let finishReason: string;
      switch (plan.step.kind) {
        case "error":
          delta = { content: "" };
          finishReason = "error";
          break;
        case "tool":
          delta = { tool_calls: [{
            index: 0,
            id: "abcdefghi",
            type: "function",
            function: { name: plan.step.name, arguments: JSON.stringify(plan.step.arguments) },
          }] };
          finishReason = "tool_calls";
          break;
        case "content":
          delta = { content: plan.step.text };
          finishReason = "stop";
          break;
        default: {
          const exhaustive: never = plan.step;
          throw new Error(`Unhandled Mistral response step: ${JSON.stringify(exhaustive)}`);
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        id: "killeros-native-mistral",
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`);
      return;
    }
    default: {
      const exhaustive: never = plan;
      throw new Error(`Unhandled loopback response plan: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function createLoopbackTransport(directory: string, plans: NativeResponsePlan[]): Promise<LoopbackTransport> {
  const captureFile = path.join(directory, "native-transport.jsonl");
  writeFileSync(captureFile, "", "utf8");
  const captures: TransportCapture[] = [];
  const failures: string[] = [];
  const pendingHolds: Array<ReturnType<typeof startHold>> = [];
  const allHolds = new Set<ReturnType<typeof startHold>>();
  let activeHandlers = 0;

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const index = captures.length;
    const plan = plans[index];
    try {
      if (request.url !== "/transport") throw new Error(`Unexpected loopback path ${request.url ?? "<missing>"}`);
      const body = await readRequestBody(request);
      const capture: TransportCapture = {
        index,
        method: request.method ?? "",
        url: headerValue(request, "x-killeros-native-url") ?? "",
        authorization: headerValue(request, "authorization"),
        apiKey: headerValue(request, "api-key"),
        body,
        status: plan === undefined ? 500 : responseStatus(plan),
      };
      captures.push(capture);
      appendFileSync(captureFile, `${JSON.stringify(capture)}\n`, "utf8");
      if (!plan) {
        failures.push(`Unexpected provider request ${index} after the scripted plan`);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Loopback provider plan exhausted" } }));
        return;
      }
      if (plan.kind !== "azure-error" && capture.url !== plan.expectedUrl) {
        failures.push(`Request ${index} targeted ${capture.url}, expected ${plan.expectedUrl}`);
      }
      const hold = pendingHolds.shift();
      if (hold) {
        hold.signalStarted(capture);
        await hold.released;
      }
      sendPlanResponse(response, plan, body);
    } catch (error) {
      failures.push(errorText(error));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Loopback provider fixture failed" } }));
    }
  };

  const server: Server = createServer((request, response) => {
    activeHandlers += 1;
    void handleRequest(request, response).finally(() => { activeHandlers -= 1; });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Loopback provider must bind an owned IPv4 port");

  const transport: LoopbackTransport = {
    url: `http://127.0.0.1:${address.port}/transport`,
    captureFile,
    failures,
    captures: () => [...captures],
    holdNextRequest: () => {
      const item = startHold();
      pendingHolds.push(item);
      allHolds.add(item);
      return item.hold;
    },
    releaseAll: () => {
      for (const item of allHolds) item.hold.release();
      pendingHolds.length = 0;
    },
    close: async () => {
      for (const item of allHolds) item.hold.release();
      pendingHolds.length = 0;
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      if (activeHandlers !== 0) throw new Error(`Loopback server closed with ${activeHandlers} active request handler(s)`);
    },
  };
  return transport;
}

function createFamily(label: string): Family {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-native-${label}-`));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  mkdirSync(project);
  mkdirSync(agent);
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    TEMP: directory,
    TMP: directory,
    PATH: path.dirname(process.execPath),
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_CEILING_DIRECTORIES: directory,
  };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    assert.doesNotMatch(key, /(api[_-]?key|token|secret|password|credential)/iu,
      `No credential-shaped environment variable may be injected into the child (${key})`);
  }
  return { directory, project, agent, env };
}

function makeProbeExtension(directory: string): { file: string; probeFile: string } {
  const file = path.join(directory, "native-probe.mjs");
  const probeFile = path.join(directory, "probe.jsonl");
  writeFileSync(file, probeExtensionSource, "utf8");
  writeFileSync(probeFile, "", "utf8");
  return { file, probeFile };
}

function makeSessionSwitchExtension(directory: string, sessions: string[]): string {
  const file = path.join(directory, "switch-session.mjs");
  const source = `const sessions = ${JSON.stringify(sessions)};
export default function (pi) {
  pi.registerCommand("fixture-session", {
    description: "Select an owned saved session through Pi's public command context",
    handler: async (args, ctx) => {
      const index = Number(args);
      const target = sessions[index];
      if (!Number.isInteger(index) || typeof target !== "string") throw new Error("Unknown fixture session index");
      const result = await ctx.switchSession(target);
      if (result.cancelled) throw new Error("Fixture session switch was cancelled");
    },
  });
}`;
  writeFileSync(file, source, "utf8");
  return file;
}

function seedSession(scope: Family, label: string, goal: "active" | "blocked"): string {
  const sessions = path.join(scope.directory, "sessions");
  mkdirSync(sessions, { recursive: true });
  const manager = SessionManager.create(scope.project, sessions);
  manager.appendMessage({ role: "user", content: `Saved source history for ${label}.`, timestamp: Date.now() - 1_000 });
  if (goal === "blocked") {
    const now = Date.now();
    manager.appendCustomEntry("killeros-goal", {
      version: 1,
      event: "blocked",
      state: {
        version: 1,
        revision: 2,
        objective: "Verify provider retry recovery",
        status: "blocked",
        createdAt: now - 2_000,
        updatedAt: now - 1_000,
        activeMilliseconds: 0,
        turns: 1,
        blockedAuditStartTurn: 0,
        baselineTokens: 0,
        maxTurns: 20,
        result: "External prerequisite",
      },
    });
  }
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile), `${label}: the saved session must be durable before Pi starts`);
  return sessionFile;
}

function sessionEntries(sessionFile: string): RecordValue[] {
  return SessionManager.open(sessionFile).getBranch().map((entry: unknown) => record(entry, "saved session entry"));
}

function assistantEntries(sessionFile: string): RecordValue[] {
  return sessionEntries(sessionFile).flatMap((entry) => {
    const message = entry.type === "message" && isRecord(entry.message) ? entry.message : entry;
    return message.role === "assistant" ? [record(message, "saved assistant message")] : [];
  });
}

function goalStates(sessionFile: string): RecordValue[] {
  return sessionEntries(sessionFile).flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal entry data");
    return [record(data.state, "saved goal state")];
  });
}

function receiptEntries(sessionFile: string): RecordValue[] {
  return sessionEntries(sessionFile).flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-worked-for") return [];
    return [record(entry.data, "worked-for receipt data")];
  });
}

function lastGoalState(sessionFile: string, label: string): RecordValue {
  const state = goalStates(sessionFile).at(-1);
  assert.ok(isRecord(state), `${label}: expected a saved goal state`);
  return state;
}

function currentProbeCursor(probeFile: string): number {
  return probeEvents(probeFile).at(-1)?.sequence ?? 0;
}

function waitForFileValue<T>(
  file: string,
  label: string,
  signal: AbortSignal,
  readValue: () => T | undefined,
  timeoutMs = 120_000,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`${label} cancelled`, { cause: signal.reason }));
  return new Promise<T>((resolve, reject) => {
    let complete = false;
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
    };
    const finish = (error: unknown, value: T | undefined): void => {
      if (complete) return;
      complete = true;
      cleanup();
        if (error !== undefined) reject(error instanceof Error ? error : new Error(errorText(error)));
      else if (value !== undefined) resolve(value);
    };
    const check = (): void => {
      try {
        const value = readValue();
        if (value !== undefined) finish(undefined, value);
      } catch (error) {
        finish(error, undefined);
      }
    };
    const abort = (): void => finish(new Error(`${label} cancelled`, { cause: signal.reason }), undefined);
    try {
      watcher = watch(file, check);
      watcher.on("error", (error) => finish(error, undefined));
      timer = setTimeout(() => finish(new Error(`${label} timed out after ${timeoutMs}ms`), undefined), timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      check();
    } catch (error) {
      finish(error, undefined);
    }
  });
}

async function waitForSettles(
  probeFile: string,
  after: number,
  count: number,
  label: string,
  signal: AbortSignal,
): Promise<ProbeEvent[]> {
  const events = await waitForFileValue(probeFile, `${label} settlement`, signal, () => {
    const settled = probeEvents(probeFile).filter((event) => event.sequence > after && event.type === "agent_settled");
    return settled.length >= count ? settled : undefined;
  });
  assert.equal(events.length, count, `${label}: exact settlement count at the action boundary`);
  for (const event of events) {
    assert.equal(event.aborted, false, `${label}: settlement must not be aborted`);
    assert.equal(event.idle, true, `${label}: Pi must report idle at settlement`);
    assert.equal(event.pending, false, `${label}: Pi must report an empty follow-up queue at settlement`);
  }
  return events;
}

async function waitForCapture(
  captureFile: string,
  count: number,
  label: string,
  signal: AbortSignal,
): Promise<RecordValue> {
  const captures = await waitForFileValue(captureFile, label, signal, () => {
    const records = captureRecords(captureFile);
    return records.length >= count ? records : undefined;
  });
  const capture = captures[count - 1];
  assert.ok(capture, `${label}: expected the captured provider response`);
  return capture;
}

async function waitForBellCount(terminal: PiTerminalProcess, expected: number, label: string, signal: AbortSignal): Promise<void> {
  while (terminal.bellCount < expected) {
    const after = terminal.sequence;
    await terminal.waitForScreen(() => true, { signal, after, timeoutMs: 15_000 });
  }
  assert.equal(terminal.bellCount, expected, `${label}: exact BEL count after settlement`);
}

function assertFinalSettlements(probeFile: string, expected: number, label: string): ProbeEvent[] {
  const settled = probeEvents(probeFile).filter((event) => event.type === "agent_settled");
  assert.equal(settled.length, expected, `${label}: exact agent_settled count after orderly exit`);
  for (const event of settled) {
    assert.equal(event.aborted, false, `${label}: settled runs are not aborted`);
    assert.equal(event.idle, true, `${label}: Pi is idle at each final settlement`);
    assert.equal(event.pending, false, `${label}: no queued follow-up remains at settlement`);
  }
  return settled;
}

function assertProbeRetry(probeFile: string, after: number, message: string, sessionFile: string, label: string): void {
  const events = probeEvents(probeFile).filter((event) => event.sequence > after && event.sessionFile === sessionFile);
  const errors = events.filter((event) => event.type === "agent_end" && event.stopReason === "error");
  assert.equal(errors.length, 1, `${label}: exactly one native error precedes the held retry request`);
  assert.equal(errors[0]?.errorMessage, message, `${label}: exact provider error reaches the retry boundary`);
  assert.equal(events.filter((event) => event.type === "agent_start").length, 2,
    `${label}: Pi starts the original attempt and one retry before any settlement`);
}

/** Retry events are RPC/session events, not extension hooks. Observe recovery through public run events and exact provider traffic. */
function assertRecoveredRetry(probeFile: string, after: number, sessionFile: string, label: string): void {
  const ends = probeEvents(probeFile).filter((event) => event.sequence > after
    && event.sessionFile === sessionFile && event.type === "agent_end");
  assert.equal(ends.filter((event) => event.stopReason === "error").length, 1,
    `${label}: recovery adds no second provider failure`);
  assert.equal(ends.at(-1)?.stopReason, "stop", `${label}: the retried run finishes successfully`);
}

function assertOpenaiCapture(
  capture: TransportCapture,
  expectation: { temperature: number; topP: number; authorization: string; status: 400 | 429 },
): void {
  assert.equal(capture.method, "POST", "Native OpenAI requests stay POST");
  assert.equal(capture.url, "https://api.openai.com/v1/responses", "Native OpenAI endpoint stays unchanged");
  assert.equal(capture.authorization, expectation.authorization, "Native bearer authentication stays unchanged");
  assert.equal(capture.apiKey, null, "Native OpenAI auth does not become an Azure api-key header");
  assert.equal(capture.status, expectation.status, "The loopback server returns the planned native HTTP status");
  const body = record(capture.body, "captured OpenAI Responses payload");
  assert.equal(body.model, "gpt-6.1-sol", "The native serialized model id stays unchanged");
  assert.equal(body.service_tier, "priority", "Fast mode adds priority only to eligible native OpenAI requests");
  assert.equal(body.temperature, expectation.temperature, "Thinking-level temperature is preserved");
  assert.equal(body.top_p, expectation.topP, "Thinking-level top_p is preserved");
  assert.ok(Array.isArray(body.input), "The native Responses payload retains its input array");
}

function assertAzureCapture(capture: TransportCapture, id: string, endpoint: string, auth: "responses" | "foundry"): void {
  assert.equal(capture.method, "POST", "Azure requests stay POST");
  const url = new URL(capture.url);
  assert.equal(url.origin, "https://killeros-test.ai.azure.com", "Azure keeps the configured native endpoint origin");
  assert.ok(url.pathname.endsWith(`/${endpoint}`), `Azure request must target /${endpoint} (pathname ${url.pathname})`);
  if (auth === "responses") {
    assert.equal(capture.apiKey, "local-test-key", "Azure Responses keeps its native api-key header");
    assert.equal(capture.authorization, null, "Azure Responses does not become bearer-authenticated OpenAI");
  } else {
    assert.equal(capture.authorization, "Bearer local-test-key", "Azure Foundry completions keep native bearer auth");
    assert.equal(capture.apiKey, null, "Azure Foundry completions do not become Azure Responses auth");
  }
  const body = record(capture.body, "captured Azure payload");
  assert.equal(body.model, "local-deployment", "Azure deployment mapping is serialized unchanged");
  assert.equal("service_tier" in body, false, "Azure never receives OpenAI priority service");
  assert.equal(body.temperature, 0.6, "Azure thinking-level temperature is preserved");
  assert.equal(body.top_p, 0.8, "Azure top_p is preserved");
}

function assertMistralCapture(capture: TransportCapture, goalToolExpected: boolean): void {
  assert.equal(capture.method, "POST", "Native Mistral requests stay POST");
  assert.equal(capture.url, "https://api.mistral.ai/v1/chat/completions", "Native Mistral endpoint stays unchanged");
  assert.equal(capture.authorization, "Bearer local-test-key", "Native Mistral bearer auth stays unchanged");
  assert.equal(capture.apiKey, null, "Native Mistral does not become Azure api-key auth");
  assert.equal(capture.status, 200, "Mistral errors remain native streamed finish_reason errors");
  const body = record(capture.body, "captured Mistral payload");
  assert.equal(body.model, "mistral-small-latest", "Native Mistral model identity stays unchanged");
  assert.ok(Array.isArray(body.tools), "Native Mistral requests retain their tools list");
  assert.equal(body.tools.some((tool) => isRecord(tool)
    && isRecord(tool.function) && tool.function.name === "killeros_goal_update"), goalToolExpected,
  "The goal tool remains available across retries and is removed after terminal completion");
}

function assertAssistantErrors(sessionFile: string, count: number, label: string): void {
  const assistants = assistantEntries(sessionFile);
  assert.equal(assistants.length, count, `${label}: exact durable assistant message count`);
  for (const message of assistants) {
    assert.equal(stringField(message, "provider"), "openai", `${label}: native OpenAI provider identity survives`);
    assert.equal(stringField(message, "api"), "openai-responses", `${label}: native Responses API identity survives`);
    assert.equal(stringField(message, "model"), "gpt-6.1-sol", `${label}: native OpenAI model identity survives`);
    assert.equal(stringField(message, "stopReason"), "error", `${label}: HTTP rejection surfaces as an assistant error`);
    assert.match(stringField(message, "errorMessage"), /Priority is not available for this test account/u,
      `${label}: native OpenAI error text survives transport`);
  }
}

function assertFinalTransport(scope: FamilyScope, expected: number, label: string): TransportCapture[] {
  const transport = scope.transport;
  assert.ok(transport, `${label}: loopback transport remains owned until final capture checks`);
  assert.deepEqual(transport.failures, [], `${label}: loopback server records no transport faults`);
  const captures = transport.captures();
  assert.equal(captures.length, expected, `${label}: exact request count after orderly Pi exit`);
  assert.deepEqual(captures.map((capture) => capture.index), Array.from({ length: expected }, (_value, index) => index),
    `${label}: request sequence has no gaps or duplicates`);
  return captures;
}

async function runFamily(
  label: string,
  launch: (scope: FamilyScope, args: string[], env: NodeJS.ProcessEnv) => PiTerminalProcess,
  scenario: (scope: FamilyScope, report: (name: string, value: unknown) => void) => Promise<void>,
): Promise<void> {
  const family = createFamily(label);
  let launchCount = 0;
  const scope: FamilyScope = {
    ...family,
    terminal: undefined,
    transport: undefined,
    releaseFiles: new Set(),
    launchTerminal: (args, env) => {
      launchCount += 1;
      scope.terminal = launch(scope, args, env);
      return scope.terminal;
    },
    closeTransport: async () => {
      const transport = scope.transport;
      if (!transport) return [];
      await transport.close();
      return transport.captures();
    },
  };
  const reported: RecordValue = {};
  const report = (name: string, value: unknown): void => { reported[name] = value; };
  const failures: unknown[] = [];
  const cleanupFailures: unknown[] = [];
  let finalCaptures: TransportCapture[] = [];
  let finalTransportFailures: string[] = [];
  try {
    await scenario(scope, report);
    assert.equal(launchCount, 1, `${label}: family owns exactly one Pi launch`);
  } catch (error) {
    failures.push(error);
  }
  for (const releaseFile of scope.releaseFiles) {
    try {
      writeFileSync(releaseFile, "released\n", "utf8");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  scope.transport?.releaseAll();
  if (scope.terminal) {
    try {
      const result = await scope.terminal.close({ force: true });
      cleanupFailures.push(new Error(`${label}: terminal required forced cleanup (${JSON.stringify(result)})`));
    } catch (error) {
      cleanupFailures.push(error);
    }
    scope.terminal = undefined;
  }
  if (scope.transport) {
    const transport = scope.transport;
    try {
      await transport.close();
    } catch (error) {
      cleanupFailures.push(error);
    } finally {
      finalCaptures = transport.captures();
      finalTransportFailures = [...transport.failures];
    }
  }
  if (failures.length > 0 || cleanupFailures.length > 0) {
    throwScenarioFailure({
      directory: family.directory,
      message: `Native provider family ${label} failed`,
      errors: [...failures, ...cleanupFailures],
      diagnostics: JSON.stringify({
        directory: family.directory,
        node: process.version,
        launches: launchCount,
        captures: finalCaptures.slice(-24),
        transportFailures: finalTransportFailures.slice(-12),
        transportCaptureFile: scope.transport?.captureFile,
        ...reported,
      }),
    });
  }
  try {
    await removeDirectoryEventually(family.directory);
    assert.equal(existsSync(family.directory), false, `${label}: owned scratch directory must be removed`);
  } catch (error) {
    throwScenarioFailure({
      directory: family.directory,
      message: `Native provider family ${label} cleanup failed`,
      errors: [error],
      diagnostics: JSON.stringify({
        directory: family.directory,
        node: process.version,
        launches: launchCount,
        captures: finalCaptures.slice(-24),
        transportFailures: finalTransportFailures.slice(-12),
        transportCaptureFile: scope.transport?.captureFile,
        ...reported,
      }),
    });
  }
}

async function runCommand(scope: FamilyScope, text: string, gate: string, signal: AbortSignal, label: string): Promise<void> {
  const terminal = scope.terminal;
  assert.ok(terminal, `${label}: terminal is active`);
  const after = terminal.sequence;
  // Paste keeps argument autocomplete from consuming Enter instead of submitting the command.
  terminal.write(`\x1b[200~${text}\x1b[201~`);
  await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.includes("❯") && line.includes(text)), {
    signal, after, timeoutMs: 60_000,
  });
  const submittedAfter = terminal.sequence;
  terminal.write(enter);
  await terminal.waitForScreen((screen) => screen.includes(gate)
    && !screen.split("\n").some((line) => line.includes("❯") && line.includes(text)),
  { signal, after: submittedAfter, timeoutMs: 60_000 });
}

async function submitAndSettle(
  scope: FamilyScope,
  probeFile: string,
  text: string,
  signal: AbortSignal,
  label: string,
): Promise<ProbeEvent[]> {
  const terminal = scope.terminal;
  assert.ok(terminal, `${label}: terminal is active`);
  const after = currentProbeCursor(probeFile);
  const settled = waitForSettles(probeFile, after, 1, label, signal);
  await terminal.submitEditorText(text, { signal });
  return await settled;
}

async function closeNaturally(scope: FamilyScope, label: string): Promise<void> {
  const terminal = scope.terminal;
  assert.ok(terminal, `${label}: terminal is active before orderly exit`);
  const result = await terminal.close();
  scope.terminal = undefined;
  assert.deepEqual(result, { code: 0, forced: false }, `${label}: Pi exits naturally`);
}

function writeOpenaiFiles(scope: FamilyScope, label: string, auth: "api-key" | "oauth"): void {
  writeJson(path.join(scope.agent, "settings.json"), {
    tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
    defaultThinkingLevel: "high",
  });
  if (auth === "api-key") {
    writeJson(path.join(scope.agent, "auth.json"), { openai: { type: "api_key", key: "sk-local-test-key" } });
  } else {
    writeJson(path.join(scope.agent, "auth.json"), { openai: {
      type: "oauth", access: "local-test-chatgpt-token", refresh: "local-test-refresh-token",
      expires: Date.now() + 3_600_000, clientId: "local-test-client", scopes: ["chatgpt.tokens.use.direct"],
    } });
  }
  writeJson(path.join(scope.agent, "models.json"), { providers: { openai: { modelOverrides: {
    "gpt-6.1-sol": {
      samplingParams: { temperature: 1, top_p: 0.95 },
      samplingParamsByThinkingLevel: { high: { temperature: 0.6 }, low: { temperature: 0.2, top_p: 0.8 } },
    },
  } } } });
  assert.equal(existsSync(path.join(scope.agent, "killeros.json")), false, `${label}: fast mode starts process-local`);
}

function openaiArgs(sessionFile: string, wrapperFile: string, probeExtension: string): string[] {
  return [
    "--offline", "--approve", "--model", "openai/gpt-6.1-sol", "--session", sessionFile,
    "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
    "--no-extensions", "--extension", killerosExtension, "--extension", wrapperFile, "--extension", probeExtension,
  ];
}

function launchTerminal(scope: FamilyScope, args: string[], env: NodeJS.ProcessEnv): PiTerminalProcess {
  return new PiTerminalProcess({
    file: process.execPath,
    args: [cliPath, ...args],
    cwd: scope.project,
    env,
    cols: 120,
    rows: 34,
  });
}

function assertOpenaiModelCatalog(): void {
  const model = openaiProvider().getModels().find((candidate) => candidate.id === "gpt-6.1-sol");
  assert.ok(model, "Installed Pi must expose the native OpenAI test model");
  assert.equal(model.provider, "openai");
  assert.equal(model.api, "openai-responses");
  assert.equal(model.baseUrl, "https://api.openai.com/v1");
}

function assertAzureModelCatalog(): void {
  const provider = azureProvider();
  const responses = provider.getModels().find((candidate) => candidate.id === "gpt-6.1-sol");
  const foundry = provider.getModels().find((candidate) => candidate.id === "deepseek-v4-pro");
  assert.ok(responses, "Installed Pi must expose the Azure Responses model");
  assert.ok(foundry, "Installed Pi must expose the Azure Foundry model");
  assert.equal(responses.provider, "azure");
  assert.equal(responses.api, "azure-openai-responses");
  assert.equal(foundry.provider, "azure");
  assert.equal(foundry.api, "openai-completions");
}

function assertMistralModelCatalog(): void {
  const model = mistralProvider().getModels().find((candidate) => candidate.id === "mistral-small-latest");
  assert.ok(model, "Installed Pi must expose the native Mistral test model");
  assert.equal(model.provider, "mistral");
  assert.equal(model.api, "mistral-conversations");
  assert.equal(model.baseUrl, "https://api.mistral.ai");
}

function openaiErrorPlan(status: 400 | 429, count: number): NativeResponsePlan[] {
  return Array.from({ length: count }, () => ({
    kind: "openai-error" as const,
    status,
    message: "Priority is not available for this test account",
    expectedUrl: "https://api.openai.com/v1/responses",
  }));
}

async function runOpenaiFamily(
  label: string,
  auth: "api-key" | "oauth",
  status: 400 | 429,
  expectedPerTurn: 1 | 2,
  signal: AbortSignal,
): Promise<void> {
  await runFamily(label, (scope, args, env) => launchTerminal(scope, args, env), async (scope, report) => {
    const sessionFile = seedSession(scope, label, "active");
    const wrapperFile = path.join(scope.directory, "openai-wrapper.mjs");
    const { file: probeExtension, probeFile } = makeProbeExtension(scope.directory);
    writeOpenaiFiles(scope, label, auth);
    writeFileSync(wrapperFile, openaiWrapperSource, "utf8");
    scope.transport = await createLoopbackTransport(scope.directory, openaiErrorPlan(status, expectedPerTurn * 2));
    const expectedAuthorization = auth === "api-key" ? "Bearer sk-local-test-key" : "Bearer local-test-chatgpt-token";
    const terminal = scope.launchTerminal(openaiArgs(sessionFile, wrapperFile, probeExtension), {
      ...scope.env,
      KILLEROS_NATIVE_PROBE: probeFile,
      KILLEROS_NATIVE_TRANSPORT_URL: scope.transport.url,
    });
    await terminal.waitForScreen((screen) => screen.includes("❯") && screen.includes("gpt-6.1-sol") && screen.includes("ctx 100%"), {
      signal, timeoutMs: 120_000,
    });
    await runCommand(scope, "/codex-fast", "Fast enabled", signal, label);
    await runCommand(scope, "/reload", "Reloaded", signal, label);
    await runCommand(scope, "/codex-fast status", "Codex fast mode: enabled", signal, label);
    assert.equal(existsSync(path.join(scope.agent, "killeros.json")), false, `${label}: reload does not persist fast mode`);

    const thinkingCases = [
      { level: "high", temperature: 0.6, topP: 0.95 },
      { level: "low", temperature: 0.2, topP: 0.8 },
    ] as const;
    for (const thinking of thinkingCases) {
      await runCommand(scope, `/thinking ${thinking.level}`, `Thinking level: ${thinking.level}`, signal, label);
      const before = scope.transport.captures().length;
      await submitAndSettle(scope, probeFile, "Test priority rejection locally", signal, `${label} ${thinking.level}`);
      const captures = scope.transport.captures().slice(before);
      assert.equal(captures.length, expectedPerTurn, `${label} ${thinking.level}: exact native provider retry count`);
      for (const capture of captures) {
        assertOpenaiCapture(capture, { temperature: thinking.temperature, topP: thinking.topP, authorization: expectedAuthorization, status });
      }
    }
    assertAssistantErrors(sessionFile, 2, label);
    await closeNaturally(scope, label);
    await scope.closeTransport();
    const finalCaptures = assertFinalTransport(scope, expectedPerTurn * 2, label);
    assert.deepEqual(finalCaptures.map((capture) => capture.status), Array.from({ length: expectedPerTurn * 2 }, () => status),
      `${label}: exact response status vector after orderly exit`);
    assertFinalSettlements(probeFile, 2, label);
    assert.equal(terminal.bellCount, 0, `${label}: no completion bell is enabled for rejected OpenAI runs`);
    report("launches", 1);
    report("nativeHttpRequests", finalCaptures.length);
  });
}

async function runAzureFamily(id: string, api: "azure-openai-responses" | "openai-completions", endpoint: string, signal: AbortSignal): Promise<void> {
  const label = api === "azure-openai-responses" ? "azure-responses" : "azure-foundry";
  await runFamily(label, (scope, args, env) => launchTerminal(scope, args, env), async (scope, report) => {
    const sessionFile = seedSession(scope, label, "active");
    const wrapperFile = path.join(scope.directory, "azure-wrapper.mjs");
    const envFile = path.join(scope.directory, "azure-env.json");
    const { file: probeExtension, probeFile } = makeProbeExtension(scope.directory);
    writeJson(path.join(scope.agent, "settings.json"), {
      tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
      defaultThinkingLevel: "high",
    });
    writeJson(path.join(scope.agent, "auth.json"), { azure: { type: "api_key", key: "local-test-key" } });
    writeJson(path.join(scope.agent, "models.json"), { providers: { azure: { modelOverrides: {
      [id]: { samplingParams: { top_p: 0.8 }, samplingParamsByThinkingLevel: { high: { temperature: 0.6 } } },
    } } } });
    writeJson(envFile, {
      AZURE_OPENAI_BASE_URL: "https://killeros-test.ai.azure.com",
      AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${id}=local-deployment`,
    });
    writeFileSync(wrapperFile, azureWrapperSource, "utf8");
    scope.transport = await createLoopbackTransport(scope.directory, Array.from({ length: 2 }, () => ({
      kind: "azure-error" as const, status: 400 as const, message: "Local Azure test rejection",
    })));
    const terminal = scope.launchTerminal([
      "--offline", "--approve", "--model", `azure/${id}`, "--session", sessionFile,
      "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
      "--no-extensions", "--extension", killerosExtension, "--extension", wrapperFile, "--extension", probeExtension,
    ], {
      ...scope.env,
      KILLEROS_NATIVE_PROBE: probeFile,
      KILLEROS_NATIVE_TRANSPORT_URL: scope.transport.url,
      KILLEROS_NATIVE_ENV: envFile,
    });
    await terminal.waitForScreen((screen) => {
      const footer = screen.split("\n").find((line) => line.includes("ctx"));
      return screen.includes("❯") && footer !== undefined && footer.includes(`${id} azure`);
    }, { signal, timeoutMs: 120_000 });

    const assertFooter = (stage: string): void => {
      const footer = terminal.screen().split("\n").find((line) => line.includes("ctx"));
      assert.ok(footer, `${label}: footer is visible at ${stage}`);
      assert.ok(footer.includes(`${id} azure`), `${label} ${stage}: native Azure model/provider remain selected`);
      assert.doesNotMatch(footer, /\bfast\b/u, `${label} ${stage}: Azure footer stays free of fast mode`);
    };
    await runCommand(scope, "/codex-fast", "Fast enabled", signal, label);
    assertFooter("startup");
    for (const stage of ["startup", "reload"] as const) {
      if (stage === "reload") {
        await runCommand(scope, "/reload", "Reloaded", signal, label);
        await runCommand(scope, "/codex-fast status", "Codex fast mode: enabled", signal, label);
        assertFooter("reload");
      }
      const before = scope.transport.captures().length;
      await submitAndSettle(scope, probeFile, `Test Azure locally at ${stage}`, signal, `${label} ${stage}`);
      const captures = scope.transport.captures().slice(before);
      assert.equal(captures.length, 1, `${label} ${stage}: exactly one native request for HTTP 400`);
      const capture = captures[0];
      assert.ok(capture, `${label} ${stage}: captured request exists`);
      assertAzureCapture(capture, id, endpoint, api === "azure-openai-responses" ? "responses" : "foundry");
      const message = assistantEntries(sessionFile).at(-1);
      assert.ok(message, `${label} ${stage}: native assistant rejection is saved`);
      assert.equal(stringField(message, "provider"), "azure");
      assert.equal(stringField(message, "api"), api);
      assert.equal(stringField(message, "model"), id);
      assert.equal(stringField(message, "stopReason"), "error");
      assert.match(stringField(message, "errorMessage"), /Local Azure test rejection/u);
    }
    assert.equal(existsSync(path.join(scope.agent, "killeros.json")), false, `${label}: fast mode remains process-local`);
    await closeNaturally(scope, label);
    await scope.closeTransport();
    const captures = assertFinalTransport(scope, 2, label);
    for (const capture of captures) assertAzureCapture(capture, id, endpoint, api === "azure-openai-responses" ? "responses" : "foundry");
    assertFinalSettlements(probeFile, 2, label);
    assert.equal(terminal.bellCount, 0, `${label}: no completion bell is enabled`);
    report("launches", 1);
    report("nativeHttpRequests", captures.length);
  });
}

function goalCompleteStep(): PlanStep {
  return { kind: "tool", name: "killeros_goal_update", arguments: { status: "complete", evidence: "Recovered and verified" } };
}

function contentStep(): PlanStep {
  return { kind: "content", text: "Goal finished after recovery" };
}

function errorStep(message: string): PlanStep {
  return { kind: "error", message };
}

const fauxVariants = [
  { status: "active", label: "capacity-active", message: "Selected model is at capacity" },
  { status: "active", label: "cancelled-active", message: "The pending stream has been canceled" },
  { status: "blocked", label: "capacity-blocked", message: "Selected model is at capacity" },
  { status: "blocked", label: "cancelled-blocked", message: "The pending stream has been canceled" },
  { status: "active", label: "busy-token-active", message: "server_busy" },
  { status: "blocked", label: "busy-token-blocked", message: "server_busy" },
  { status: "active", label: "busy-text-active", message: "servers are currently busy" },
  { status: "blocked", label: "busy-text-blocked", message: "servers are currently busy" },
] satisfies ReadonlyArray<{ status: "active" | "blocked"; label: string; message: string }>;

async function runHeldFauxVariant(
  scope: FamilyScope,
  variant: (typeof fauxVariants)[number],
  sessionFile: string,
  probeFile: string,
  captureFile: string,
  index: number,
  signal: AbortSignal,
): Promise<void> {
  const terminal = scope.terminal;
  assert.ok(terminal, `${variant.label}: terminal is active`);
  const settledBefore = probeEvents(probeFile).filter((event) => event.type === "agent_settled").length;
  const receiptsBefore = receiptEntries(sessionFile).length;
  assert.equal(receiptsBefore, 0, `${variant.label}: source history starts without a receipt`);
  const bellsBefore = terminal.bellCount;
  const cursor = currentProbeCursor(probeFile);
  const activeIndicator = terminal.waitForScreen((screen) => /(?:esc to interrupt|Retrying)/u.test(screen), {
    signal, after: terminal.sequence, timeoutMs: 60_000,
  });
  const prompt = variant.status === "active"
    ? "/goal Verify provider retry recovery"
    : "The prerequisite is resolved. Verify and complete the original goal.";
  await terminal.submitEditorText(prompt, { signal });
  await activeIndicator;

  for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
    const stepNumber = index * 3 + stepIndex + 1;
    const step = await waitForCapture(captureFile, stepNumber, `${variant.label} provider response ${stepIndex + 1}`, signal);
    assert.equal(step.unexpected, false, `${variant.label}: response remains inside the scripted provider plan`);
    assert.equal(stringField(record(step.step, "faux plan step"), "sessionFile"), sessionFile,
      `${variant.label}: response belongs to the isolated saved session`);
    assert.equal(probeEvents(probeFile).filter((event) => event.type === "agent_settled").length, settledBefore,
      `${variant.label}: no run settles while a faux provider response is held`);
    assert.equal(receiptEntries(sessionFile).length, receiptsBefore,
      `${variant.label}: no receipt is appended before agent_settled`);
    assert.equal(terminal.bellCount, bellsBefore, `${variant.label}: no BEL is emitted before agent_settled`);
    assert.match(terminal.screen(), /(?:esc to interrupt|Retrying)/u,
      `${variant.label}: the native TUI keeps its working indicator visible during every provider response`);
    if (stepIndex === 1) {
      assertProbeRetry(probeFile, cursor, variant.message, sessionFile, variant.label);
      const retryState = lastGoalState(sessionFile, `${variant.label} retry state`);
      assert.equal(stringField(retryState, "status"), variant.status, `${variant.label}: retry retains the source goal status`);
      assert.equal(numberField(retryState, "turns"), 1, `${variant.label}: retry retains source turn 1`);
      assert.equal(numberField(retryState, "maxTurns"), 20, `${variant.label}: retry preserves the goal turn limit`);
    }
    if (stepIndex === 2) {
      const completed = lastGoalState(sessionFile, `${variant.label} pre-settlement completion`);
      assert.equal(stringField(completed, "status"), "complete", `${variant.label}: tool completion precedes final settlement`);
      assert.equal(numberField(completed, "turns"), 1, `${variant.label}: completing blocked work grants no new turn`);
    }
    writeFileSync(stringField(record(step.step, "faux plan step"), "releaseFile"), "released\n", "utf8");
  }
  const settledEvents = await waitForSettles(probeFile, cursor, 1, `${variant.label} run`, signal);
  assert.equal(settledEvents.length, 1, `${variant.label}: one run settles after its three provider responses`);
  const finalState = lastGoalState(sessionFile, `${variant.label} final goal state`);
  assert.equal(stringField(finalState, "status"), "complete", `${variant.label}: the original goal completes`);
  assert.equal(numberField(finalState, "turns"), 1, `${variant.label}: goal turn count stays at source turn 1`);
  assert.equal(numberField(finalState, "maxTurns"), 20, `${variant.label}: maxTurns stays 20`);
  const settledForSession = probeEvents(probeFile).filter((event) => event.type === "agent_settled" && event.sessionFile === sessionFile);
  assert.equal(settledForSession.length, 1, `${variant.label}: exact saved-session settlement count`);
  const receipts = receiptEntries(sessionFile);
  assert.equal(receipts.length, 1, `${variant.label}: exactly one receipt follows the run settlement`);
  assert.equal(numberField(receipts[0] ?? {}, "version"), 4, `${variant.label}: receipt version stays 4`);
  assert.equal(stringField(receipts[0] ?? {}, "outcome"), "done", `${variant.label}: receipt outcome is done`);
  await waitForBellCount(terminal, bellsBefore + 1, variant.label, signal);
  assertRecoveredRetry(probeFile, cursor, sessionFile, variant.label);
  await terminal.waitForScreen((screen) => screen.includes("❯") && !/(?:esc to interrupt|Retrying)/u.test(screen), { signal, timeoutMs: 15_000 });
  assert.doesNotMatch(terminal.screen(), /(?:esc to interrupt|Retrying)/u, `${variant.label}: working indicator clears after settlement`);
}

async function runFauxGoalFamily(status: "active" | "blocked", signal: AbortSignal): Promise<void> {
  const variants = fauxVariants.filter((variant) => variant.status === status);
  await runFamily("goal-faux", (scope, args, env) => launchTerminal(scope, args, env), async (scope, report) => {
    const sessionFiles = variants.map((variant) => seedSession(scope, variant.label, variant.status));
    const initialSession = sessionFiles[0];
    assert.ok(initialSession, "Faux family must have an initial saved session");
    const captureFile = path.join(scope.directory, "faux-responses.jsonl");
    const planFile = path.join(scope.directory, "faux-plan.json");
    const { file: probeExtension, probeFile } = makeProbeExtension(scope.directory);
    const switchExtension = makeSessionSwitchExtension(scope.directory, sessionFiles);
    writeFileSync(captureFile, "", "utf8");
    writeJson(path.join(scope.agent, "settings.json"), {
      tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      defaultThinkingLevel: "off",
    });
    writeJson(path.join(scope.agent, "killeros.json"), { completionSound: true });

    const steps: FauxStep[] = [];
    variants.forEach((variant, variantIndex) => {
      const sessionFile = sessionFiles[variantIndex];
      assert.ok(sessionFile, `${variant.label}: saved session exists`);
      const responseSteps = [errorStep(variant.message), goalCompleteStep(), contentStep()];
      for (const [stepIndex, response] of responseSteps.entries()) {
        const suffix = `${variantIndex}-${stepIndex}`;
        const releaseFile = path.join(scope.directory, `faux-release-${suffix}`);
        scope.releaseFiles.add(releaseFile);
        steps.push({ ...response, sessionFile, releaseFile });
      }
    });
    writeJson(planFile, { steps });
    const wrapperFile = path.join(scope.directory, "faux-wrapper.mjs");
    writeFileSync(wrapperFile, fauxWrapperSource, "utf8");
    const terminal = scope.launchTerminal([
      "--offline", "--approve", "--model", "killeros-native-retry/local", "--session", initialSession,
      "--no-builtin-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
      "--no-extensions", "--extension", killerosExtension, "--extension", wrapperFile,
      "--extension", switchExtension, "--extension", probeExtension,
    ], {
      ...scope.env,
      KILLEROS_NATIVE_PROBE: probeFile,
      KILLEROS_NATIVE_CAPTURE: captureFile,
      KILLEROS_NATIVE_PLAN: planFile,
    });
    await terminal.waitForScreen((screen) => screen.includes("❯") && screen.includes("local killeros native retry") && screen.includes("ctx"), {
      signal, timeoutMs: 120_000,
    });

    for (const [index, variant] of variants.entries()) {
      const sessionFile = sessionFiles[index];
      assert.ok(sessionFile, `${variant.label}: saved session exists`);
      if (index > 0) await runCommand(scope, `/fixture-session ${index}`, `Saved source history for ${variant.label}.`, signal, variant.label);
      await runHeldFauxVariant(scope, variant, sessionFile, probeFile, captureFile, index, signal);
    }
    await closeNaturally(scope, "goal-faux");
    const responses = captureRecords(captureFile);
    assert.equal(responses.length, variants.length * 3, "Each source vector consumes exactly three faux responses after orderly exit");
    assert.equal(responses.filter((response) => response.unexpected === true).length, 0,
      "The provider does not receive a request beyond the complete source response plan");
    assertFinalSettlements(probeFile, variants.length, "goal-faux");
    assert.equal(probeEvents(probeFile).filter((event) => event.type === "agent_start").length, variants.length * 2,
      "Each source variant starts the original attempt and exactly one native retry");
    assert.equal(probeEvents(probeFile).filter((event) => event.type === "agent_end" && event.stopReason === "error").length, variants.length,
      "Each source variant has exactly one provider error before recovery");
    assert.equal(terminal.bellCount, variants.length, "Each settled successful run emits exactly one parsed BEL");
    for (const [index, sessionFile] of sessionFiles.entries()) {
      assert.equal(receiptEntries(sessionFile).length, 1, `Faux source vector ${index + 1} leaves one settled receipt`);
      const state = lastGoalState(sessionFile, `Faux source vector ${index + 1}`);
      assert.equal(stringField(state, "status"), "complete");
      assert.equal(numberField(state, "turns"), 1, "Blocked completion consumes no additional goal turn");
    }
    report("launches", 1);
    report("fauxResponses", responses.length);
  });
}

function mistralPlan(): NativeResponsePlan[] {
  return [
    { kind: "mistral-sse" as const, expectedUrl: "https://api.mistral.ai/v1/chat/completions", step: errorStep("mistral finish_reason:error") },
    { kind: "mistral-sse" as const, expectedUrl: "https://api.mistral.ai/v1/chat/completions", step: goalCompleteStep() },
    { kind: "mistral-sse" as const, expectedUrl: "https://api.mistral.ai/v1/chat/completions", step: contentStep() },
  ];
}

async function runHeldMistralVariant(
  scope: FamilyScope,
  sessionFile: string,
  mode: "active" | "blocked",
  probeFile: string,
  signal: AbortSignal,
): Promise<void> {
  const terminal = scope.terminal;
  const transport = scope.transport;
  assert.ok(terminal && transport, "Mistral CLI and loopback provider are active");
  const label = `mistral ${mode}`;
  const cursor = currentProbeCursor(probeFile);
  const settlementsBefore = probeEvents(probeFile).filter((event) => event.type === "agent_settled").length;
  const receiptsBefore = receiptEntries(sessionFile).length;
  const bellsBefore = terminal.bellCount;
  const activeIndicator = terminal.waitForScreen((screen) => /(?:esc to interrupt|Retrying)/u.test(screen), {
    signal, after: terminal.sequence, timeoutMs: 60_000,
  });
  const holds = Array.from({ length: 3 }, () => transport.holdNextRequest());
  try {
    const prompt = mode === "active"
      ? "/goal Verify provider retry recovery"
      : "The prerequisite is resolved. Verify and complete the original goal.";
    await terminal.submitEditorText(prompt, { signal });
    await activeIndicator;
    for (const [index, hold] of holds.entries()) {
      const capture = await hold.waitStarted(signal);
      assertMistralCapture(capture, index < 2);
      assert.equal(probeEvents(probeFile).filter((event) => event.type === "agent_settled").length, settlementsBefore,
        `${label}: no settlement occurs until all native provider responses finish`);
      assert.equal(receiptEntries(sessionFile).length, receiptsBefore,
        `${label}: receipts stay unchanged before the native run settles`);
      assert.equal(terminal.bellCount, bellsBefore, `${label}: completion BEL is suppressed until settlement`);
      assert.match(terminal.screen(), /(?:esc to interrupt|Retrying)/u, `${label}: TUI working indicator remains visible during the held request`);
      if (index === 1) {
        assertProbeRetry(probeFile, cursor, "Provider stopped with: error (server error)", sessionFile, label);
        const retryState = lastGoalState(sessionFile, `${label} retry state`);
        assert.equal(stringField(retryState, "status"), mode, `${label}: retry preserves the source goal status`);
        assert.equal(numberField(retryState, "turns"), 1, `${label}: retry preserves source turn 1`);
        assert.equal(numberField(retryState, "maxTurns"), 20, `${label}: retry preserves the goal turn limit`);
      }
      if (index === 2) {
        const completed = lastGoalState(sessionFile, `${label} pre-settlement completion`);
        assert.equal(stringField(completed, "status"), "complete", `${label}: goal tool completion precedes settlement`);
        assert.equal(numberField(completed, "turns"), 1, `${label}: completion adds no goal turn`);
      }
      hold.release();
    }
    await waitForSettles(probeFile, cursor, 1, label, signal);
    const finalState = lastGoalState(sessionFile, `${label} final state`);
    assert.equal(stringField(finalState, "status"), "complete");
    assert.equal(numberField(finalState, "turns"), 1);
    assert.equal(numberField(finalState, "maxTurns"), 20);
    const receipts = receiptEntries(sessionFile);
    assert.equal(receipts.length, 1, `${label}: exactly one versioned receipt follows settlement`);
    assert.equal(numberField(receipts[0] ?? {}, "version"), 4);
    assert.equal(stringField(receipts[0] ?? {}, "outcome"), "done");
    assertRecoveredRetry(probeFile, cursor, sessionFile, label);
    await waitForBellCount(terminal, bellsBefore + 1, label, signal);
    await terminal.waitForScreen((screen) => screen.includes("❯") && !/(?:esc to interrupt|Retrying)/u.test(screen), { signal, timeoutMs: 15_000 });
    assert.doesNotMatch(terminal.screen(), /(?:esc to interrupt|Retrying)/u, `${label}: working indicator clears after settlement`);
  } finally {
    for (const hold of holds) hold.release();
  }
}

async function runMistralFamily(mode: "active" | "blocked", signal: AbortSignal): Promise<void> {
  await runFamily("mistral-error", (scope, args, env) => launchTerminal(scope, args, env), async (scope, report) => {
    const initialSession = seedSession(scope, `mistral-${mode}`, mode);
    const sessions = [initialSession];
    assert.ok(initialSession, "Mistral active session exists");
    const wrapperFile = path.join(scope.directory, "mistral-wrapper.mjs");
    const switchExtension = makeSessionSwitchExtension(scope.directory, sessions);
    const { file: probeExtension, probeFile } = makeProbeExtension(scope.directory);
    writeJson(path.join(scope.agent, "settings.json"), {
      tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
      defaultThinkingLevel: "off",
    });
    writeJson(path.join(scope.agent, "killeros.json"), { completionSound: true });
    writeJson(path.join(scope.agent, "auth.json"), { mistral: { type: "api_key", key: "local-test-key" } });
    writeFileSync(wrapperFile, mistralWrapperSource, "utf8");
    scope.transport = await createLoopbackTransport(scope.directory, mistralPlan());
    const terminal = scope.launchTerminal([
      "--offline", "--approve", "--model", "mistral/mistral-small-latest", "--session", initialSession,
      "--no-builtin-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
      "--no-extensions", "--extension", killerosExtension, "--extension", wrapperFile,
      "--extension", switchExtension, "--extension", probeExtension,
    ], {
      ...scope.env,
      KILLEROS_NATIVE_PROBE: probeFile,
      KILLEROS_NATIVE_TRANSPORT_URL: scope.transport.url,
    });
    await terminal.waitForScreen((screen) => screen.includes("❯") && screen.includes("mistral") && screen.includes("ctx"), {
      signal, timeoutMs: 120_000,
    });
    await runHeldMistralVariant(scope, initialSession, mode, probeFile, signal);

    const errorEnds = probeEvents(probeFile).filter((event) => event.type === "agent_end" && event.stopReason === "error");
    assert.equal(errorEnds.length, 1, "One native finish_reason error reaches agent_end for each source state");
    for (const event of errorEnds) {
      assert.equal(event.errorMessage, "Provider stopped with: error (server error)",
        "Native Mistral finish_reason error keeps Pi's normalized message");
    }
    await closeNaturally(scope, "mistral-error");
    await scope.closeTransport();
    const captures = assertFinalTransport(scope, 3, "mistral-error");
    for (const [index, capture] of captures.entries()) assertMistralCapture(capture, index % 3 < 2);
    assertFinalSettlements(probeFile, 1, "mistral-error");
    assert.equal(terminal.bellCount, 1, "One settled successful run emits exactly one parsed BEL");
    for (const sessionFile of sessions) {
      assert.equal(receiptEntries(sessionFile).length, 1, "Each Mistral saved goal history gets one settled receipt");
      assert.equal(stringField(lastGoalState(sessionFile, "Mistral final state"), "status"), "complete");
    }
    report("launches", 1);
    report("nativeHttpRequests", captures.length);
  });
}

// Proposed catalog ID: runtime.native-openai-api-key-400.
test("native OpenAI API-key 400 preserves high and low sampling without retry", { timeout: 60_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  assertOpenaiModelCatalog();
  await runOpenaiFamily("openai-api-key-400", "api-key", 400, 1, t.signal);
});

// Proposed catalog ID: runtime.native-openai-oauth-400.
test("native OpenAI OAuth 400 preserves high and low sampling without retry", { timeout: 60_000 }, async (t: TestContext) => {
  assertOpenaiModelCatalog();
  await runOpenaiFamily("openai-chatgpt-oauth-400", "oauth", 400, 1, t.signal);
});

// Proposed catalog ID: runtime.native-openai-api-key-429.
test("native OpenAI 429 retries once with unchanged high and low sampling", { timeout: 60_000 }, async (t: TestContext) => {
  assertOpenaiModelCatalog();
  await runOpenaiFamily("openai-api-key-429", "api-key", 429, 2, t.signal);
});

// Proposed catalog ID: runtime.native-azure-responses.
test("native Azure Responses excludes priority before and after reload", { timeout: 60_000 }, async (t: TestContext) => {
  assertAzureModelCatalog();
  await runAzureFamily("gpt-6.1-sol", "azure-openai-responses", "responses", t.signal);
});

// Proposed catalog ID: runtime.native-azure-foundry.
test("native Azure Foundry excludes priority before and after reload", { timeout: 60_000 }, async (t: TestContext) => {
  assertAzureModelCatalog();
  await runAzureFamily("deepseek-v4-pro", "openai-completions", "chat/completions", t.signal);
});

// Proposed catalog IDs split frozen PiExtensionContract1492 without hidden registrations.
test("active faux provider retries preserve goal ownership until settlement", { timeout: 60_000 }, async (t: TestContext) => {
  await runFauxGoalFamily("active", t.signal);
});

test("blocked faux provider retries preserve completion permission until settlement", { timeout: 60_000 }, async (t: TestContext) => {
  await runFauxGoalFamily("blocked", t.signal);
});

test("active native Mistral retry preserves goal ownership until settlement", { timeout: 60_000 }, async (t: TestContext) => {
  assertMistralModelCatalog();
  await runMistralFamily("active", t.signal);
});

test("blocked native Mistral retry preserves completion permission until settlement", { timeout: 60_000 }, async (t: TestContext) => {
  assertMistralModelCatalog();
  await runMistralFamily("blocked", t.signal);
});