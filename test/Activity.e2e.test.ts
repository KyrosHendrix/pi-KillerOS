import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const themePath = path.join(repositoryRoot, "themes/killeros.json");
const evidenceDirectory = path.join(repositoryRoot, ".pi/compact-codex-20261023/activity");
const providerName = "activity-local";
const defaultModelId = "gpt-5.4";
const changedModelId = "claude-sonnet-4-6";
const visibleActivityWords = ["Mapping…", "Inspecting…", "Reviewing…", "Changing…", "Running…", "Working…", "Recovering…", "Responding…"];
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type JsonObject = Record<string, unknown>;
type Gate<T> = { promise: Promise<T>; release(value: T): void };
type ProviderResponse =
  | { kind: "tool"; toolName: string; args: JsonObject; gate?: Gate<void>; thinking?: string; thinkingGate?: Gate<void> }
  | { kind: "text"; text: string; thinking?: string; gate?: Gate<void>; thinkingGate?: Gate<void>; contentGate?: Gate<void> };
type ProviderRequest = { index: number; model: string; body: JsonObject; toolNames: string[] };
type ToolCall = { id: string; name: string; body: JsonObject };
type ToolResult = { isError: boolean; text: string };
type OneShotInvocation = { child: ChildProcess; stdout: string; stderr: string };
type EventWaiter<T> = {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};
type ProviderWaiter = EventWaiter<ProviderRequest> & { count: number };
type ToolWaiter = EventWaiter<ToolCall> & { name: string; occurrence: number };
type ModelDefinition = { id: string; name: string; reasoning: boolean };
type ModelCommand = { name: string; modelId: string; notification: string };
type FixtureOptions = {
  label: string;
  responses: ProviderResponse[];
  models: ModelDefinition[];
  initialModelId: string;
  toolNames?: string[];
  modelCommands?: ModelCommand[];
  switchModelId?: string;
  queueFollowUp?: boolean;
  hideThinkingBlock?: boolean;
};
type Fixture = {
  root: string;
  project: string;
  agent: string;
  targetFile: string;
  sessionFile: string;
  extensionFile: string;
  eventFile: string;
  registrationFile: string;
  env: NodeJS.ProcessEnv;
  provider: LocalFixtureServer;
};
type ProbeEvent = JsonObject & { type: string };
type ActivityObservation = { screen: string; line: string; sequence: number };

function deferred<T>(): Gate<T> {
  let resolvePromise: (value: T) => void = () => {};
  let released = false;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    release(value) {
      if (released) return;
      released = true;
      resolvePromise(value);
    },
  };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`${key} must be a string`);
  return field;
}

function recordsFromJsonLines(contents: string, label: string): JsonObject[] {
  if (!contents.trim()) return [];
  return contents.trim().split(/\r?\n/u).map((line, index) => record(JSON.parse(line), `${label}[${index}]`));
}

function boundedErrorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function abortedError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Activity scenario was cancelled");
}

async function readRequest(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of request) {
    if (!(chunk instanceof Uint8Array)) throw new Error("Expected a byte request body");
    byteCount += chunk.byteLength;
    if (byteCount > 1_048_576) throw new Error("Activity fixture request exceeded 1 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "Activity fixture request");
}

function providerToolNames(body: JsonObject): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool, index) => {
    const definition = record(tool, `tools[${index}]`);
    const fn = record(definition.function, `tools[${index}].function`);
    return stringField(fn, "name");
  });
}

function modelSettings(models: ModelDefinition[]): JsonObject {
  return {
    providers: {
      [providerName]: {
        api: "openai-completions",
        apiKey: "activity-fixture-key",
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: ["text"],
          contextWindow: 100_000,
          maxTokens: 2_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    },
  };
}

function fixtureExtensionSource(options: {
  eventFile: string;
  registrationFile: string;
  toolUrl: string;
  toolNames: string[];
  modelCommands: ModelCommand[];
  switchModelId?: string;
  queueFollowUp: boolean;
}): string {
  const serializedOptions = JSON.stringify(JSON.stringify({ ...options, providerName }));
  return `
import { appendFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

const options = JSON.parse(${serializedOptions});
let settlementCount = 0;
let followUpQueued = false;

function log(type, ctx, extra = {}) {
  appendFileSync(options.eventFile, JSON.stringify({
    type,
    ...(ctx ? {
      mode: ctx.mode,
      modelId: ctx.model?.id,
      idle: ctx.isIdle(),
      pending: ctx.hasPendingMessages(),
    } : {}),
    ...extra,
  }) + "\\n");
}

async function selectModel(pi, ctx, modelId) {
  const model = ctx.modelRegistry.find(options.providerName, modelId);
  if (!model) throw new Error("Fixture model was not found in Pi's public registry");
  if (!await pi.setModel(model)) throw new Error("Pi rejected the fixture model selection");
  return model.id;
}

export default function activityProbe(pi) {
  const registrations = [];
  for (const name of options.toolNames) {
    try {
      pi.registerTool({
        name,
        label: "Activity fixture tool",
        description: "Perform one controlled activity observation.",
        parameters: Type.Object({}),
        execute: async () => {
          const response = await fetch(options.toolUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ toolName: name }),
          });
          const result = await response.json();
          const text = typeof result.text === "string" ? result.text : "Activity fixture operation completed";
          return { content: [{ type: "text", text }], ...(response.ok ? {} : { isError: true }) };
        },
      });
      registrations.push({ name, status: "registered" });
    } catch (error) {
      registrations.push({ name, status: "rejected", error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (options.switchModelId) {
    pi.registerTool({
      name: "activity-switch-model",
      label: "Switch fixture model",
      description: "Select the next configured local model.",
      parameters: Type.Object({}),
      execute: async (_id, _args, _signal, _update, ctx) => {
        const selected = await selectModel(pi, ctx, options.switchModelId);
        log("fixture-model-switched", ctx, { selectedModelId: selected });
        const barrier = await fetch(options.toolUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolName: "activity-switch-model" }),
        });
        await barrier.json();
        if (!barrier.ok) throw new Error("Activity model-switch barrier failed");
        return { content: [{ type: "text", text: "The local model selection changed." }] };
      },
    });
    registrations.push({ name: "activity-switch-model", status: "registered" });
  }

  for (const command of options.modelCommands) {
    pi.registerCommand(command.name, {
      description: "Select a configured local fixture model.",
      handler: async (_args, ctx) => {
        try {
          const selectedModelId = await selectModel(pi, ctx, command.modelId);
          log("fixture-model-command", ctx, { command: command.name, selectedModelId });
          ctx.ui.notify(command.notification, "info");
        } catch (error) {
          log("fixture-model-command-rejected", ctx, { command: command.name, error: error instanceof Error ? error.message : String(error) });
          ctx.ui.notify("Activity model selection was rejected", "error");
        }
      },
    });
  }

  writeFileSync(options.registrationFile, JSON.stringify(registrations), "utf8");

  pi.on("tool_call", async (event, ctx) => {
    if (!["read", "edit"].includes(event.toolName) || options.toolNames.includes(event.toolName)) return;
    const response = await fetch(options.toolUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toolName: "native:" + event.toolName, executionBarrier: true }),
      signal: ctx.signal,
    });
    await response.json();
    if (!response.ok) throw new Error("Native tool observation barrier failed");
  });

  pi.on("agent_start", (_event, ctx) => log("agent_start", ctx));
  pi.on("before_agent_start", (event, ctx) => log("before_agent_start", ctx, { messageType: event.messageType }));
  pi.on("tool_execution_start", (event, ctx) => log("tool_execution_start", ctx, { toolName: event.toolName }));
  pi.on("tool_execution_end", (event, ctx) => log("tool_execution_end", ctx, { toolName: event.toolName, isError: event.isError }));
  pi.on("message_update", (event, ctx) => log("message_update", ctx, { updateType: event.assistantMessageEvent.type }));
  pi.on("model_select", (event, ctx) => log("model_select", ctx, { selectedModelId: event.model.id, previousModelId: event.previousModel?.id }));
  pi.on("agent_before_settle", (_event, ctx) => {
    log("agent_before_settle", ctx);
    if (options.queueFollowUp && ctx.mode === "tui" && !followUpQueued) {
      followUpQueued = true;
      pi.sendUserMessage("queued activity follow-up", { deliverAs: "followUp" });
      log("fixture-follow-up-queued", ctx, { pendingAfterQueue: ctx.hasPendingMessages() });
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    settlementCount += 1;
    log("agent_settled", ctx, { settlementCount });
  });
  pi.on("session_shutdown", (event, ctx) => log("session_shutdown", ctx, { reason: event.reason }));
}
`;
}

class LocalFixtureServer {
  private readonly server: Server;
  private readonly responses: ProviderResponse[];
  private readonly requests: ProviderRequest[] = [];
  private readonly completedResponses = new Set<number>();
  private readonly responseFinishGates = new Map<number, Gate<void>>();
  private readonly toolCalls: ToolCall[] = [];
  private readonly toolGates = new Map<string, Gate<ToolResult>>();
  private readonly requestWaiters = new Set<ProviderWaiter>();
  private readonly toolWaiters = new Set<ToolWaiter>();
  readonly faults: string[] = [];
  readonly authorization = "Bearer activity-fixture-key";
  private address = "";
  private nextToolId = 0;

  constructor(responses: ProviderResponse[]) {
    this.responses = responses;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.addFault(error);
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(500, { connection: "close" });
          response.end("Activity fixture failure");
        }
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
  }

  get baseUrl(): string {
    if (!this.address) throw new Error("Activity fixture server is not listening");
    return this.address;
  }

  get providerRequests(): readonly ProviderRequest[] {
    return this.requests;
  }

  get observedTools(): readonly ToolCall[] {
    return this.toolCalls.filter((call) => call.body.executionBarrier !== true);
  }

  get observedExecutionBarriers(): readonly ToolCall[] {
    return this.toolCalls.filter((call) => call.body.executionBarrier === true);
  }

  async waitForProviderResponseFinish(count: number, signal: AbortSignal): Promise<void> {
    const gate = this.responseFinishGates.get(count);
    if (!gate) throw new Error(`No provider response ${count} is active`);
    if (signal.aborted) throw abortedError(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([
        gate.promise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for provider response ${count} to finish`)), 15_000);
          abort = () => reject(abortedError(signal));
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Activity fixture did not receive a loopback address"));
          return;
        }
        this.address = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async waitForProviderRequest(count: number, signal: AbortSignal): Promise<ProviderRequest> {
    const existing = this.requests[count - 1];
    if (existing) return existing;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    if (signal.aborted) throw abortedError(signal);
    return await new Promise<ProviderRequest>((resolve, reject) => {
      const waiter: ProviderWaiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeProviderWaiter(waiter);
          reject(new Error(`Timed out waiting for provider request ${count}`));
        }, 45_000),
        signal,
      };
      waiter.abort = () => {
        this.removeProviderWaiter(waiter);
        reject(abortedError(signal));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.requestWaiters.add(waiter);
    });
  }

  async waitForToolCall(name: string, occurrence: number, signal: AbortSignal): Promise<ToolCall> {
    const existing = this.toolCalls.filter((call) => call.name === name)[occurrence - 1];
    if (existing) return existing;
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) throw new Error(`Invalid tool occurrence ${occurrence}`);
    if (signal.aborted) throw abortedError(signal);
    return await new Promise<ToolCall>((resolve, reject) => {
      const waiter: ToolWaiter = {
        name,
        occurrence,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeToolWaiter(waiter);
          reject(new Error(`Timed out waiting for fixture tool ${JSON.stringify(name)} occurrence ${occurrence}`));
        }, 45_000),
        signal,
      };
      waiter.abort = () => {
        this.removeToolWaiter(waiter);
        reject(abortedError(signal));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.toolWaiters.add(waiter);
    });
  }

  releaseProviderResponse(count: number): void {
    this.responses[count - 1]?.gate?.release(undefined);
  }

  releaseThinking(count: number): void {
    const response = this.responses[count - 1];
    response?.thinkingGate?.release(undefined);
  }

  releaseText(count: number): void {
    const response = this.responses[count - 1];
    if (response?.kind === "text") response.contentGate?.release(undefined);
  }

  releaseToolCall(id: string, result: ToolResult = { isError: false, text: "Activity fixture operation completed" }): void {
    this.toolGates.get(id)?.release(result);
  }

  releaseAll(): void {
    for (const response of this.responses) {
      response.gate?.release(undefined);
      response.thinkingGate?.release(undefined);
      if (response.kind === "text") {
        response.contentGate?.release(undefined);
      }
    }
    for (const gate of this.toolGates.values()) gate.release({ isError: false, text: "Activity fixture cleanup release" });
  }

  summary(): JsonObject {
    return {
      providerRequests: this.requests.length,
      completedProviderResponses: [...this.completedResponses],
      providerModels: this.requests.map((request) => request.model),
      providerTools: this.requests.map((request) => request.toolNames.length),
      toolOperations: this.toolCalls.map((call) => ({ id: call.id, name: call.name })),
      faults: this.faults.slice(0, 12),
    };
  }

  async close(): Promise<void> {
    this.releaseAll();
    for (const waiter of this.requestWaiters) {
      this.removeProviderWaiter(waiter);
      waiter.reject(new Error("Activity fixture server closed before provider observation completed"));
    }
    for (const waiter of this.toolWaiters) {
      this.removeToolWaiter(waiter);
      waiter.reject(new Error("Activity fixture server closed before tool observation completed"));
    }
    if (!this.server.listening) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", this.baseUrl);
    if (requestUrl.pathname === "/activity-tool") {
      await this.handleTool(request, response);
      return;
    }
    if (requestUrl.pathname !== "/chat/completions") throw new Error(`Unexpected fixture path ${requestUrl.pathname}`);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, this.authorization);
    const body = await readRequest(request);
    const model = stringField(body, "model");
    const toolNames = providerToolNames(body);
    const index = this.requests.length;
    const observation = { index: index + 1, model, body, toolNames };
    this.requests.push(observation);
    this.notifyProviderWaiters(observation);
    const responseFinished = deferred<void>();
    this.responseFinishGates.set(index + 1, responseFinished);
    response.once("finish", () => {
      this.completedResponses.add(index + 1);
      responseFinished.release(undefined);
    });

    const plan = this.responses[index];
    if (!plan) {
      this.addFault(new Error(`Unexpected provider request ${index + 1}`));
      response.writeHead(500, { connection: "close" });
      response.end("No scripted activity response");
      return;
    }
    await plan.gate?.promise;
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    if (plan.thinking) {
      response.write(`data: ${JSON.stringify({
        id: `activity-${index + 1}`,
        model,
        choices: [{ index: 0, delta: { reasoning_content: plan.thinking }, finish_reason: null }],
      })}\n\n`);
      await plan.thinkingGate?.promise;
      if (response.destroyed || response.writableEnded) return;
    }
    if (plan.kind === "tool") {
      const payload = {
        id: `activity-${index + 1}`,
        model,
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0,
          id: `activity-tool-call-${index + 1}`,
          type: "function",
          function: { name: plan.toolName, arguments: JSON.stringify(plan.args) },
        }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
      response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (plan.contentGate) {
      response.write(`data: ${JSON.stringify({
        id: `activity-${index + 1}`,
        model,
        choices: [{ index: 0, delta: { content: plan.text }, finish_reason: null }],
      })}\n\n`);
      await plan.contentGate.promise;
      if (response.destroyed || response.writableEnded) return;
      response.end(`data: ${JSON.stringify({
        id: `activity-${index + 1}`,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      })}\n\ndata: [DONE]\n\n`);
      return;
    }
    response.end(`data: ${JSON.stringify({
      id: `activity-${index + 1}`,
      model,
      choices: [{ index: 0, delta: { content: plan.text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    })}\n\ndata: [DONE]\n\n`);
  }

  private async handleTool(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assert.equal(request.method, "POST");
    const body = await readRequest(request);
    const name = stringField(body, "toolName");
    const id = `activity-tool-${++this.nextToolId}`;
    const gate = deferred<ToolResult>();
    this.toolGates.set(id, gate);
    const call = { id, name, body };
    this.toolCalls.push(call);
    this.notifyToolWaiters(call);
    const result = await gate.promise;
    this.toolGates.delete(id);
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(result.isError ? 503 : 200, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify({ text: result.text }));
  }

  private notifyProviderWaiters(request: ProviderRequest): void {
    for (const waiter of this.requestWaiters) {
      if (waiter.count !== request.index) continue;
      this.removeProviderWaiter(waiter);
      waiter.resolve(request);
    }
  }

  private notifyToolWaiters(call: ToolCall): void {
    for (const waiter of this.toolWaiters) {
      const occurrence = this.toolCalls.filter((candidate) => candidate.name === waiter.name).length;
      if (waiter.name !== call.name || waiter.occurrence !== occurrence) continue;
      this.removeToolWaiter(waiter);
      waiter.resolve(call);
    }
  }

  private removeProviderWaiter(waiter: ProviderWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.requestWaiters.delete(waiter);
  }

  private removeToolWaiter(waiter: ToolWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.toolWaiters.delete(waiter);
  }

  private addFault(error: unknown): void {
    if (this.faults.length < 12) this.faults.push(boundedErrorText(error));
  }
}

function isolatedChildEnvironment(options: {
  root: string;
  agent: string;
  eventFile: string;
  registrationFile: string;
  toolUrl: string;
}): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  // Activity needs no external executables; do not scan the ancestor checkout through inherited Git.
  env.PATH = path.dirname(process.execPath);
  const appData = path.join(options.root, "appdata");
  const localAppData = path.join(options.root, "localappdata");
  const temporary = path.join(options.root, "tmp");
  const emptyGitConfig = path.join(options.root, "empty-git-config");
  mkdirSync(appData);
  mkdirSync(localAppData);
  mkdirSync(temporary);
  writeFileSync(emptyGitConfig, "", "utf8");
  Object.assign(env, {
    HOME: options.root,
    USERPROFILE: options.root,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    PI_CODING_AGENT_DIR: options.agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    KILLEROS_ACTIVITY_EVENTS: options.eventFile,
    KILLEROS_ACTIVITY_REGISTRATIONS: options.registrationFile,
    KILLEROS_ACTIVITY_TOOL_URL: options.toolUrl,
  });
  return env;
}

async function createFixture(options: FixtureOptions): Promise<Fixture> {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "killeros-activity-e2e-"));
  const project = path.join(root, "project");
  const agent = path.join(root, "agent");
  const eventFile = path.join(root, "events.jsonl");
  const registrationFile = path.join(root, "registrations.json");
  const extensionFile = path.join(root, "activity-probe.ts");
  const sessionFile = path.join(root, "session.jsonl");
  const targetFile = path.join(project, "activity-target.txt");
  let provider: LocalFixtureServer | undefined;
  try {
    for (let ancestor = realpathSync(root); ; ancestor = path.dirname(ancestor)) {
      try {
        lstatSync(path.join(ancestor, ".git"));
        throw new Error(`Activity fixture has a Git ancestor: ${ancestor}`);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (path.dirname(ancestor) === ancestor) break;
    }
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"), "junction");
    mkdirSync(project);
    mkdirSync(agent);
    provider = new LocalFixtureServer(options.responses);
    await provider.listen();
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      defaultThinkingLevel: "off",
      theme: "killeros",
      tuiMode: "fullscreen",
      ...(options.hideThinkingBlock === true ? { hideThinkingBlock: true } : {}),
      terminal: { trueColor: true },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
      retry: { enabled: false },
    }), "utf8");
    writeFileSync(path.join(agent, "killeros.json"), JSON.stringify({
      autoCompaction: { enabled: false, percentRemaining: 15 },
      completionSound: false,
    }), "utf8");
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({
      providers: {
        [providerName]: {
          ...record(
            record(modelSettings(options.models).providers, "model providers")[providerName],
            "activity provider settings",
          ),
          baseUrl: provider.baseUrl,
        },
      },
    }), "utf8");
    writeFileSync(targetFile, "before activity edit\n", "utf8");
    const toolNames = options.toolNames ?? [];
    writeFileSync(extensionFile, fixtureExtensionSource({
      eventFile,
      registrationFile,
      toolUrl: `${provider.baseUrl}/activity-tool`,
      toolNames,
      modelCommands: options.modelCommands ?? [],
      ...(options.switchModelId === undefined ? {} : { switchModelId: options.switchModelId }),
      queueFollowUp: options.queueFollowUp ?? false,
    }), "utf8");
    const env = isolatedChildEnvironment({
      root,
      agent,
      eventFile,
      registrationFile,
      toolUrl: `${provider.baseUrl}/activity-tool`,
    });
    return { root, project, agent, targetFile, sessionFile, extensionFile, eventFile, registrationFile, env, provider };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await provider?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await removeActivityRoot(root);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], `${options.label} fixture setup and cleanup failed`);
    throw error;
  }
}

async function removeActivityRoot(root: string): Promise<void> {
  const temp = realpathSync(os.tmpdir());
  assert.equal(path.dirname(root), temp, "Activity cleanup must target an owned temp directory");
  assert.ok(path.basename(root).startsWith("killeros-activity-e2e-"));
  assert.equal(realpathSync(root), root, "Activity root must remain a physical directory");
  const dependencies = path.join(root, "node_modules");
  let dependencyEntry;
  try {
    dependencyEntry = lstatSync(dependencies);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (dependencyEntry) {
    assert.ok(dependencyEntry.isSymbolicLink(), "Activity dependencies must remain a junction");
    assert.equal(realpathSync(dependencies), realpathSync(path.join(repositoryRoot, "node_modules")));
    rmdirSync(dependencies);
  }
  await removeDirectoryEventually(root);
}

function cliArgs(fixture: Fixture, options: { modelId: string; mode: "tui" | "rpc" | "print" | "json"; thinking?: string }): string[] {
  const args = [
    cliPath,
    "--offline",
    "--approve",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-mcp",
    "--no-extensions",
    "--extension", repositoryRoot,
    "--extension", fixture.extensionFile,
    "--model", `${providerName}/${options.modelId}`,
    "--thinking", options.thinking ?? "off",
    "--session", fixture.sessionFile,
  ];
  if (options.mode === "tui") {
    args.push("--no-themes", "--theme", themePath, "--use-theme", "killeros");
  } else if (options.mode === "rpc") {
    args.push("--mode", "rpc");
  } else if (options.mode === "json") {
    args.push("--mode", "json");
  } else {
    args.push("--print");
  }
  return args;
}

function readProbeEvents(fixture: Fixture): ProbeEvent[] {
  if (!existsSync(fixture.eventFile)) return [];
  return recordsFromJsonLines(readFileSync(fixture.eventFile, "utf8"), "probe event").map((entry) => ({
    ...entry,
    type: stringField(entry, "type"),
  }));
}

function eventsOf(events: ProbeEvent[], type: string): ProbeEvent[] {
  return events.filter((event) => event.type === type);
}

function activityLine(screen: string): string | undefined {
  const lines = screen.split("\n").filter((line) => visibleActivityWords.some((word) => line.includes(word)));
  return lines.at(-1)?.trimEnd();
}

async function waitForActivity(
  terminal: PiTerminalProcess,
  expected: string,
  options: { signal: AbortSignal; after?: number; timeoutMs?: number },
): Promise<ActivityObservation> {
  const screen = await terminal.waitForScreen((value) => activityLine(value)?.includes(expected) ?? false, options);
  const line = activityLine(screen);
  assert.ok(line, `Expected an activity line containing ${JSON.stringify(expected)}`);
  return { screen, line, sequence: terminal.sequence };
}

function assertModelSuffix(line: string, modelId: string): void {
  assert.ok(line.endsWith(` · ${modelId}`), `Expected model suffix ${JSON.stringify(modelId)} in ${JSON.stringify(line)}`);
}

function assertExactActivityCopy(observation: ActivityObservation, expected: string): void {
  const line = observation.line.trim();
  const frame = [...line][0];
  assert.ok(frame && spinnerFrames.includes(frame), `Expected a native spinner frame in ${JSON.stringify(line)}`);
  assert.equal(line.slice(frame.length).trimStart(), expected, "complete native activity copy");
  assert.equal(observation.screen.split("\n").filter(row => visibleActivityWords.some(word => row.includes(word))).length, 1,
    "the active screen has one visible working message");
}

function assertCleanActivityLine(line: string): void {
  assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u001b]/u);
}

function assertIdleState(state: JsonObject, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: Pi must not still be streaming`);
  assert.equal(state.isCompacting, false, `${label}: Pi must not still be compacting`);
  assert.equal(state.pendingMessageCount, 0, `${label}: Pi must have no pending messages`);
}

function rawTerminalOutput(terminal: PiTerminalProcess): string {
  const diagnostic = record(JSON.parse(terminal.diagnostics()), "terminal diagnostics");
  return Buffer.from(stringField(diagnostic, "rawBase64"), "base64").toString("utf8");
}

function processSnapshot(fixture: Fixture, terminal?: PiTerminalProcess, rpc?: PiRpcProcess): JsonObject {
  return {
    label: path.basename(fixture.root),
    fixtureRoot: fixture.root,
    provider: fixture.provider.summary(),
    events: readProbeEvents(fixture).slice(-120),
    terminal: terminal?.diagnostics(),
    rpc: rpc?.diagnostics(),
  };
}

async function cleanupFixture(options: {
  fixture: Fixture;
  terminal?: PiTerminalProcess;
  rpc?: PiRpcProcess;
}): Promise<unknown[]> {
  const failures: unknown[] = [];
  options.fixture.provider.releaseAll();
  if (options.terminal) {
    try {
      const result = await options.terminal.close();
      if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Pi terminal did not exit naturally: ${JSON.stringify(result)}`));
    } catch (error) {
      failures.push(error);
    }
  }
  if (options.rpc) {
    try {
      const result = await options.rpc.close();
      if (result.exit.code !== 0 || result.exit.signal !== null || result.forced || result.treeCleanupError !== undefined) {
        failures.push(new Error(`Pi RPC did not exit naturally: ${JSON.stringify(result)}`));
      }
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await options.fixture.provider.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await removeActivityRoot(options.fixture.root);
    assert.equal(existsSync(options.fixture.root), false, "Remove the owned activity fixture directory");
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

async function saveScenarioFailure(options: {
  scenarioId: string;
  message: string;
  errors: unknown[];
  diagnostics: string;
}): Promise<never> {
  mkdirSync(evidenceDirectory, { recursive: true });
  let directory: string | undefined;
  try {
    directory = mkdtempSync(path.join(evidenceDirectory, `${options.scenarioId}-failure-`));
    throwScenarioFailure({
      directory,
      message: options.message,
      errors: options.errors,
      diagnostics: options.diagnostics.slice(0, 32_768),
    });
  } catch (error) {
    if (directory !== undefined && existsSync(directory) && !existsSync(path.join(directory, "failure.txt"))) {
      try {
        await removeDirectoryEventually(directory);
      } catch (cleanupError) {
        throw new AggregateError([...options.errors, error, cleanupError], `${options.message}; empty failure evidence cleanup failed`);
      }
    }
    throw error;
  }
}

async function runTuiFixture(options: {
  fixture: Fixture;
  signal: AbortSignal;
  cols?: number;
  rows?: number;
  modelId?: string;
  thinking?: string;
}): Promise<PiTerminalProcess> {
  const terminal = new PiTerminalProcess({
    file: process.execPath,
    args: cliArgs(options.fixture, {
      modelId: options.modelId ?? defaultModelId,
      mode: "tui",
      thinking: options.thinking,
    }),
    cwd: options.fixture.project,
    env: options.fixture.env,
    cols: options.cols ?? 120,
    rows: options.rows ?? 32,
  });
  try {
    await terminal.waitForScreen((screen) => screen.includes("KillerOS"), {
      signal: options.signal,
      timeoutMs: 30_000,
    });
    return terminal;
  } catch (error) {
    options.fixture.provider.releaseAll();
    try {
      const result = await terminal.close();
      if (result.code !== 0 || result.forced || result.failure) {
        throw new AggregateError([error, new Error(`Startup terminal cleanup: ${JSON.stringify(result)}`)]);
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Activity TUI startup and cleanup failed");
    }
    throw error;
  }
}

function toolResponse(toolName: string, args: JsonObject = {}, gate = deferred<void>()): ProviderResponse {
  return { kind: "tool", toolName, args, gate };
}

function textResponse(text: string, options: { gate?: Gate<void>; thinking?: string; thinkingGate?: Gate<void>; contentGate?: Gate<void> } = {}): ProviderResponse {
  return {
    kind: "text",
    text,
    ...(options.gate === undefined ? {} : { gate: options.gate }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.thinkingGate === undefined ? {} : { thinkingGate: options.thinkingGate }),
    ...(options.contentGate === undefined ? {} : { contentGate: options.contentGate }),
  };
}

function registrationStatus(fixture: Fixture, toolName: string): string | undefined {
  if (!existsSync(fixture.registrationFile)) return undefined;
  const registrations: unknown = JSON.parse(readFileSync(fixture.registrationFile, "utf8"));
  if (!Array.isArray(registrations)) throw new Error("Fixture registration report must be an array");
  const matching = registrations.map((entry) => record(entry, "tool registration")).find((entry) => entry.name === toolName);
  return matching ? stringField(matching, "status") : undefined;
}

async function waitForActivitySettlement(
  fixture: Fixture,
  terminal: PiTerminalProcess,
  count: number,
  signal: AbortSignal,
  after: number,
): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown): void => {
      watcher.close();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error("Activity settlement observation failed", { cause: error }));
    };
    const check = (): void => {
      try {
        const contents = readFileSync(fixture.eventFile, "utf8");
        if (!contents.endsWith("\n")) return;
        const events = recordsFromJsonLines(contents, "activity settlement probe");
        const settled = events.filter((event) => event.type === "agent_settled");
        if (settled.length < count) return;
        assert.equal(settled[count - 1]?.idle, true, "native settlement reports idle Pi");
        assert.equal(settled[count - 1]?.pending, false, "native settlement has no queued work");
        finish();
      } catch (error) { finish(error); }
    };
    const abort = (): void => finish(abortedError(signal));
    const watcher = watch(fixture.eventFile, check);
    const timer = setTimeout(() => finish(new Error(`Native activity settlement ${count} was not observed`)), 60_000);
    watcher.on("error", finish);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
  return await terminal.waitForScreen((screen) => activityLine(screen) === undefined,
    { signal, after, timeoutMs: 30_000 });
}

async function runRpcMode(signal: AbortSignal): Promise<JsonObject> {
  const fixture = await createFixture({
    label: "rpc",
    responses: [textResponse("RPC activity response")],
    models: [{ id: defaultModelId, name: "Local activity model", reasoning: false }],
    initialModelId: defaultModelId,
  });
  let rpc: PiRpcProcess | undefined;
  let primaryError: unknown;
  let result: JsonObject = {};
  try {
    rpc = new PiRpcProcess({
      cliPath,
      cwd: fixture.project,
      env: fixture.env,
      args: cliArgs(fixture, { modelId: defaultModelId, mode: "rpc" }).slice(1),
    });
    const startup = await rpc.command("get_state", {}, { signal, timeoutMs: 30_000 });
    assertIdleState(record(startup.data, "RPC startup state"), "RPC startup");
    const cursor = rpc.currentSequence;
    const observed: PiRpcRecord[] = [];
    const settled = rpc.waitForRecord((entry) => {
      observed.push(entry);
      return entry.type === "agent_settled";
    }, { after: cursor, signal, timeoutMs: 60_000 });
    const prompt = record(await rpc.command("prompt", { message: "RPC activity mode must not render a status." }, { signal, timeoutMs: 30_000 }), "RPC prompt response");
    assert.equal(record(prompt.data, "RPC prompt response").disposition, "started");
    await settled;
    const state = record((await rpc.command("get_state", {}, { signal, timeoutMs: 30_000 })).data, "RPC settled state");
    assertIdleState(state, "RPC settlement");
    assert.equal(fixture.provider.providerRequests.length, 1);
    assert.equal(observed.some((entry) => entry.type === "extension_ui_request"), false,
      "RPC activity must not publish a working message or status widget");
    assert.deepEqual(fixture.provider.faults, []);
    result = { mode: "rpc", providerRequests: fixture.provider.providerRequests.length, rpcEvents: observed.length };
  } catch (error) {
    primaryError = error;
  }
  const snapshot = processSnapshot(fixture, undefined, rpc);
  const cleanupErrors = await cleanupFixture({ fixture, rpc });
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await saveScenarioFailure({
      scenarioId: "ACT-01-rpc",
      message: "ACT-01 RPC activity mode failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ fixture: snapshot, cleanupErrors: cleanupErrors.map(boundedErrorText) }, null, 2),
    });
  }
  return result;
}

async function runOneShotMode(mode: "print" | "json", signal: AbortSignal): Promise<JsonObject> {
  const fixture = await createFixture({
    label: mode,
    responses: [textResponse(`${mode} activity response`)],
    models: [{ id: defaultModelId, name: "Local activity model", reasoning: false }],
    initialModelId: defaultModelId,
  });
  let invocation: OneShotInvocation | undefined;
  let primaryError: unknown;
  let result: JsonObject = {};
  try {
    const args = cliArgs(fixture, { modelId: defaultModelId, mode });
    args.push(`${mode} activity request`);
    const completion = promisify(execFile)(process.execPath, args, {
      cwd: fixture.project,
      env: fixture.env,
      timeout: 45_000,
      maxBuffer: 1_048_576,
      signal,
      windowsHide: true,
      encoding: "utf8",
    });
    let stdinFailure: unknown;
    try {
      completion.child.stdin?.end();
    } catch (error) {
      stdinFailure = error;
    }
    try {
      const output = await completion;
      invocation = { child: completion.child, stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      const details = isRecord(error) ? error : {};
      invocation = {
        child: completion.child,
        stdout: typeof details.stdout === "string" ? details.stdout : "",
        stderr: typeof details.stderr === "string" ? details.stderr : "",
      };
      if (stdinFailure !== undefined) throw new AggregateError([error, stdinFailure], "Could not close Pi stdin");
      throw error;
    }
    if (stdinFailure !== undefined) {
      throw new Error("Could not close Pi stdin", { cause: stdinFailure });
    }
    assert.ok(Number.isSafeInteger(invocation.child.pid), `${mode}: own the real Pi child process`);
    assert.equal(invocation.child.exitCode, 0, `${mode}: Pi must exit naturally`);
    assert.equal(invocation.child.signalCode, null, `${mode}: Pi must not exit from a signal`);
    assert.equal(invocation.stderr, "", `${mode}: Pi must not report fixture errors`);
    assert.equal(fixture.provider.providerRequests.length, 1);
    assert.deepEqual(fixture.provider.faults, []);
    assert.doesNotMatch(invocation.stdout, /Mapping…|Inspecting…|Reviewing…|Changing…|Running…|Working…|Recovering…|Responding…|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/u,
      `${mode}: non-TUI output must not contain an activity working message or widget`);
    const records = mode === "json" ? recordsFromJsonLines(invocation.stdout, "JSON mode record") : [];
    if (mode === "json") assert.ok(records.some((entry) => entry.type === "agent_settled"), "JSON mode must emit the real settlement event");
    const events = readProbeEvents(fixture);
    assert.equal(eventsOf(events, "agent_start").length, 1);
    assert.equal(eventsOf(events, "agent_settled").length, 1);
    assert.equal(fixture.provider.providerRequests.length, 1);
    result = { mode, pid: invocation.child.pid, providerRequests: fixture.provider.providerRequests.length, jsonRecords: records.length };
  } catch (error) {
    primaryError = error;
  }
  const snapshot = processSnapshot(fixture);
  const cleanupErrors = await cleanupFixture({ fixture });
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await saveScenarioFailure({
      scenarioId: `ACT-01-${mode}`,
      message: `ACT-01 ${mode} activity mode failed`,
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ fixture: snapshot, stdout: invocation?.stdout.slice(0, 8_000), stderr: invocation?.stderr.slice(0, 8_000), cleanupErrors: cleanupErrors.map(boundedErrorText) }, null, 2),
    });
  }
  return result;
}

async function runPendingSettlement(signal: AbortSignal): Promise<JsonObject> {
  const fixture = await createFixture({
    label: "tui-pending-settlement",
    responses: [
      textResponse("The interrupted response must not finish.", { gate: deferred<void>() }),
      textResponse("The next request completed.", { gate: deferred<void>() }),
      textResponse("The pending follow-up completed.", { gate: deferred<void>() }),
    ],
    models: [
      { id: defaultModelId, name: "Local activity model", reasoning: false },
      { id: changedModelId, name: "Changed local activity model", reasoning: false },
    ],
    initialModelId: defaultModelId,
    modelCommands: [{ name: "activity-select-next", modelId: changedModelId, notification: "ACTIVITY_NEXT_MODEL_SELECTED" }],
  });
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  let result: JsonObject = {};
  try {
    terminal = await runTuiFixture({ fixture, signal });
    const firstCursor = terminal.sequence;
    terminal.write("Start the request that will be compacted.\x1b[13u");
    const firstRequest = await fixture.provider.waitForProviderRequest(1, signal);
    assert.equal(firstRequest.model, defaultModelId);
    const firstActivity = await waitForActivity(terminal, "Mapping…", { signal, after: firstCursor, timeoutMs: 30_000 });
    assertModelSuffix(firstActivity.line, defaultModelId);

    const editorCursor = terminal.sequence;
    terminal.write("\x1b[200~Pending activity follow-up\x1b[201~");
    await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.includes("❯")
      && line.includes("Pending activity follow-up")), { signal, after: editorCursor, timeoutMs: 30_000 });
    const queueCursor = terminal.sequence;
    // Ctrl+Q is Pi's default Windows follow-up key.
    terminal.write("\x11");
    await terminal.waitForScreen((screen) => screen.includes("Follow-up: Pending activity follow-up"),
      { signal, after: queueCursor, timeoutMs: 30_000 });
    const compactCursor = terminal.sequence;
    terminal.write("/compact\x1b[13u");
    const compactScreen = await terminal.waitForScreen((screen) => {
      if (!screen.includes("Nothing to compact (session too small)")) return false;
      const contents = readFileSync(fixture.eventFile, "utf8");
      if (!contents.endsWith("\n")) return false;
      return recordsFromJsonLines(contents, "pending settlement probe").some((event) => event.type === "agent_settled");
    }, { signal, after: compactCursor, timeoutMs: 30_000 });
    const firstSettlement = eventsOf(readProbeEvents(fixture), "agent_settled")[0];
    assert.equal(firstSettlement?.idle, true, "The interrupted request settles while idle");
    assert.equal(firstSettlement?.pending, true, "The queued follow-up remains pending at settlement");
    assert.ok(compactScreen.includes("Follow-up: Pending activity follow-up"));
    assert.equal(activityLine(compactScreen), undefined, "Pi hides the working indicator after the interrupted run");
    fixture.provider.releaseProviderResponse(1);

    await selectModelInTui(terminal, "activity-select-next", "ACTIVITY_NEXT_MODEL_SELECTED", signal);
    const nextCursor = terminal.sequence;
    terminal.write("Continue after the interrupted request.\x1b[13u");
    const nextRequest = await fixture.provider.waitForProviderRequest(2, signal);
    assert.equal(nextRequest.model, changedModelId, "The next provider request uses the newly selected model");
    const retainedActivity = await waitForActivity(terminal, "Mapping…", { signal, after: nextCursor, timeoutMs: 30_000 });
    assertModelSuffix(retainedActivity.line, defaultModelId);
    fixture.provider.releaseProviderResponse(2);
    const pendingRequest = await fixture.provider.waitForProviderRequest(3, signal);
    assert.equal(pendingRequest.model, changedModelId);
    const pendingActivity = await waitForActivity(terminal, "Responding…", { signal, after: retainedActivity.sequence, timeoutMs: 30_000 });
    assertModelSuffix(pendingActivity.line, defaultModelId);
    fixture.provider.releaseProviderResponse(3);
    const settled = await waitForActivitySettlement(fixture, terminal, 2, signal, pendingActivity.sequence);
    assert.equal(activityLine(settled), undefined);
    assert.equal(fixture.provider.providerRequests.length, 3);
    assert.deepEqual(fixture.provider.faults, []);
    result = { mode: "tui-pending-settlement", piLaunches: 1, providerRequests: 3,
      pendingAtSettlement: firstSettlement?.pending, retainedActivity: retainedActivity.line.trim() };
  } catch (error) {
    primaryError = error;
  }
  const snapshot = processSnapshot(fixture, terminal);
  const cleanupErrors = await cleanupFixture({ fixture, terminal });
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await saveScenarioFailure({
      scenarioId: "ACT-01-pending",
      message: "ACT-01 pending settlement failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ fixture: snapshot, cleanupErrors: cleanupErrors.map(boundedErrorText) }, null, 2),
    });
  }
  return result;
}

// Catalog ID: ACT-01.
test("Activity lifecycle copy tracks real request progress and settles truthfully", { timeout: 360_000 }, async (t: TestContext) => {
  const fixture = await createFixture({
    label: "tui-lifecycle",
    responses: [
      toolResponse("read", { path: "activity-target.txt" }),
      toolResponse("edit", {
        path: "activity-target.txt",
        edits: [{ oldText: "before activity edit", newText: "after activity edit" }],
      }),
      { kind: "tool", toolName: "activity-switch-model", args: {}, gate: deferred<void>(),
        thinking: "Activity thinking barrier", thinkingGate: deferred<void>() },
      toolResponse("activity-fail"),
      textResponse("The first activity run is complete.", {
        gate: deferred<void>(),
        thinking: "The fixture response includes a hidden thought.",
        contentGate: deferred<void>(),
      }),
      textResponse("The queued activity follow-up is complete.", { gate: deferred<void>() }),
      textResponse("The next independently submitted activity run is complete.", { gate: deferred<void>() }),
    ],
    models: [
      { id: defaultModelId, name: "Local activity model", reasoning: true },
      { id: changedModelId, name: "Changed local activity model", reasoning: true },
    ],
    initialModelId: defaultModelId,
    switchModelId: changedModelId,
    queueFollowUp: true,
    toolNames: ["activity-fail"],
  });
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  let tuiResult: JsonObject = {};
  try {
    terminal = await runTuiFixture({ fixture, signal: t.signal, thinking: "high" });
    assert.equal(registrationStatus(fixture, "activity-switch-model"), "registered");
    const waitForResponse = async (count: number, state: string, model: string, after = -1): Promise<ActivityObservation> => {
      const request = await fixture.provider.waitForProviderRequest(count, t.signal);
      if (count === 1) assert.equal(request.model, defaultModelId);
      return await waitForActivity(terminal!, state, { signal: t.signal, after: Math.max(after, 0), timeoutMs: 30_000 }).then((observation) => {
        assertModelSuffix(observation.line, model);
        return observation;
      });
    };

    const initialCursor = terminal.sequence;
    // Explicit Enter avoids ConPTY translating a bare CR into Shift+Enter.
    terminal.write("Read and edit the fixture, then report the controlled tool failure.\x1b[13u");
    const mapping = await waitForResponse(1, "Mapping…", defaultModelId, initialCursor);
    assertExactActivityCopy(mapping, "Mapping… (esc to interrupt · understanding request) · gpt-5.4");
    fixture.provider.releaseProviderResponse(1);
    const reading = await waitForActivity(terminal, "Inspecting…", { signal: t.signal, after: initialCursor, timeoutMs: 30_000 });
    assertModelSuffix(reading.line, defaultModelId);
    assertExactActivityCopy(reading, "Inspecting… (esc to interrupt · reading relevant code) · gpt-5.4");
    assertCleanActivityLine(reading.line);
    const nativeRead = await fixture.provider.waitForToolCall("native:read", 1, t.signal);
    fixture.provider.releaseToolCall(nativeRead.id);
    const readResult = await waitForActivity(terminal, "Reviewing…", { signal: t.signal, after: reading.sequence, timeoutMs: 30_000 });
    assertModelSuffix(readResult.line, defaultModelId);
    assertExactActivityCopy(readResult, "Reviewing… (esc to interrupt · reading the result) · gpt-5.4");

    const editCursor = terminal.sequence;
    await waitForResponse(2, "Reviewing…", defaultModelId, editCursor);
    fixture.provider.releaseProviderResponse(2);
    const changing = await waitForActivity(terminal, "Changing…", { signal: t.signal, after: editCursor, timeoutMs: 30_000 });
    assertModelSuffix(changing.line, defaultModelId);
    assertExactActivityCopy(changing, "Changing… (esc to interrupt · editing) · gpt-5.4");
    const nativeEdit = await fixture.provider.waitForToolCall("native:edit", 1, t.signal);
    fixture.provider.releaseToolCall(nativeEdit.id);
    const editResult = await waitForActivity(terminal, "Reviewing…", { signal: t.signal, after: changing.sequence, timeoutMs: 30_000 });
    assertModelSuffix(editResult.line, defaultModelId);
    assertExactActivityCopy(editResult, "Reviewing… (esc to interrupt · reading the result) · gpt-5.4");

    const switchCursor = terminal.sequence;
    await waitForResponse(3, "Reviewing…", defaultModelId, switchCursor);
    const beforeThinking = readProbeEvents(fixture).length;
    const thinkingCursor = terminal.sequence;
    fixture.provider.releaseProviderResponse(3);
    let thinkingEvents: JsonObject[] = [];
    const thinkingScreen = await terminal.waitForScreen((screen) => {
      if (!screen.includes("Activity thinking barrier")) return false;
      const contents = readFileSync(fixture.eventFile, "utf8");
      if (!contents.endsWith("\n")) return false;
      const events = recordsFromJsonLines(contents, "thinking probe").slice(beforeThinking);
      if (!events.some(event => event.type === "message_update" && event.updateType === "thinking_start")) return false;
      thinkingEvents = events;
      return true;
    }, { signal: t.signal, after: thinkingCursor, timeoutMs: 30_000 });
    const thinkingLine = activityLine(thinkingScreen);
    assert.ok(thinkingLine, "source-133: the existing working message remains during thinking");
    assertExactActivityCopy({ screen: thinkingScreen, line: thinkingLine, sequence: terminal.sequence },
      "Reviewing… (esc to interrupt · reading the result) · gpt-5.4");
    assert.ok(!thinkingEvents.some(event => event.type === "message_update" && event.updateType === "text_start"),
      "source-133: thinking is observed before text starts");
    fixture.provider.releaseThinking(3);
    const switchOperation = await fixture.provider.waitForToolCall("activity-switch-model", 1, t.signal);
    const switching = await waitForActivity(terminal, "Working…", { signal: t.signal, after: switchCursor, timeoutMs: 30_000 });
    assert.ok(switching.line.includes("using activity-switch-model"));
    assertModelSuffix(switching.line, defaultModelId);
    fixture.provider.releaseToolCall(switchOperation.id);
    const missingRequest = await fixture.provider.waitForProviderRequest(4, t.signal);
    const reviewingAfterSwitch = await waitForActivity(terminal, "Reviewing…", {
      signal: t.signal,
      after: switching.sequence,
      timeoutMs: 30_000,
    });
    assertModelSuffix(reviewingAfterSwitch.line, defaultModelId);
    assert.equal(missingRequest.model, changedModelId, "Pi must send the newly selected model on the next provider request");
    const switchEvents = readProbeEvents(fixture);
    assert.ok(switchEvents.some((event) => event.type === "model_select" && event.selectedModelId === changedModelId),
      "The fixture must use Pi's public model-selection API during the real run");
    fixture.provider.releaseProviderResponse(4);
    const failedOperation = await fixture.provider.waitForToolCall("activity-fail", 1, t.signal);
    const failing = await waitForActivity(terminal, "Working…", { signal: t.signal, after: reviewingAfterSwitch.sequence, timeoutMs: 30_000 });
    assertModelSuffix(failing.line, defaultModelId);
    fixture.provider.releaseToolCall(failedOperation.id, { isError: true, text: "The controlled activity tool failed." });
    const recovering = await waitForActivity(terminal, "Recovering…", { signal: t.signal, after: failing.sequence, timeoutMs: 30_000 });
    assertModelSuffix(recovering.line, defaultModelId);
    const finalRequest = await fixture.provider.waitForProviderRequest(5, t.signal);
    assert.equal(finalRequest.model, changedModelId);

    const finalCursor = recovering.sequence;
    fixture.provider.releaseProviderResponse(5);
    const responding = await waitForActivity(terminal, "Responding…", { signal: t.signal, after: finalCursor, timeoutMs: 30_000 });
    assertModelSuffix(responding.line, defaultModelId);
    assertExactActivityCopy(responding, "Responding… (esc to interrupt · assembling the answer) · gpt-5.4");
    t.diagnostic(JSON.stringify({ source: "test/Activity.test.ts:133#1",
      lines: [mapping.line, reading.line, readResult.line, changing.line, editResult.line, responding.line],
      duringThinking: thinkingLine, updateTypes: thinkingEvents.filter(event => event.type === "message_update").map(event => event.updateType) }));
    const settlementsBeforeQueue = eventsOf(readProbeEvents(fixture), "agent_settled").length;
    fixture.provider.releaseText(5);
    const followUpRequest = await fixture.provider.waitForProviderRequest(6, t.signal);
    assert.equal(followUpRequest.model, changedModelId, "Pi must use the selected model for the queued follow-up request");
    const followUpEvent = eventsOf(readProbeEvents(fixture), "fixture-follow-up-queued")[0];
    assert.ok(followUpEvent,
      "The observation extension must queue the follow-up through Pi's public API at agent_before_settle");
    assert.equal(typeof followUpEvent.pendingAfterQueue, "boolean",
      "Record the value returned by Pi's public hasPendingMessages API after enqueue");
    const queuedActivity = activityLine(terminal.screen());
    assert.ok(queuedActivity, "The activity message must remain while the queued follow-up request is active");
    assertModelSuffix(queuedActivity, defaultModelId);
    const settledBeforeFollowUp = eventsOf(readProbeEvents(fixture), "agent_settled").length;
    assert.equal(settledBeforeFollowUp, settlementsBeforeQueue,
      "Pi must not settle the request before the queued follow-up reaches its held provider response");
    fixture.provider.releaseProviderResponse(6);
    const firstSettled = await waitForActivitySettlement(fixture, terminal, settledBeforeFollowUp + 1, t.signal, finalCursor);
    assert.equal(activityLine(firstSettled), undefined, "The working message must clear after the queued work settles");

    const independentCursor = terminal.sequence;
    terminal.write("Run independently after the model switch.\x1b[13u");
    const independentRequest = await fixture.provider.waitForProviderRequest(7, t.signal);
    assert.equal(independentRequest.model, changedModelId);
    const independentStart = await waitForActivity(terminal, "Mapping…", { signal: t.signal, after: independentCursor, timeoutMs: 30_000 });
    assertModelSuffix(independentStart.line, changedModelId);
    const eventsBeforeSettlement = eventsOf(readProbeEvents(fixture), "agent_settled").length;
    fixture.provider.releaseProviderResponse(7);
    const independentSettled = await waitForActivitySettlement(fixture, terminal, eventsBeforeSettlement + 1, t.signal, independentStart.sequence);
    assert.equal(activityLine(independentSettled), undefined, "The independent run must clear its working message at settlement");

    assert.equal(readFileSync(fixture.targetFile, "utf8"), "after activity edit\n", "The real edit tool must change the owned file");
    const events = readProbeEvents(fixture);
    const tools = events.filter((event) => event.type === "tool_execution_start").map((event) => event.toolName);
    assert.deepEqual(tools, ["read", "edit", "activity-switch-model", "activity-fail"]);
    const toolEnds = events.filter((event) => event.type === "tool_execution_end");
    assert.equal(toolEnds.length, 4);
    assert.equal(toolEnds[3]?.isError, true, "The controlled public fixture tool must settle as a failure");
    assert.equal(eventsOf(events, "agent_settled").length, 2, "The queued work and the later independent prompt must each settle");
    assert.ok(eventsOf(events, "agent_settled").every((event) => event.idle === true && event.pending === false),
      "Real final settlements must report idle Pi with an empty queue");
    assert.equal(fixture.provider.providerRequests.length, 7);
    assert.deepEqual(fixture.provider.observedTools.map((call) => call.name), ["activity-switch-model", "activity-fail"]);
    assert.deepEqual(fixture.provider.observedExecutionBarriers.map((call) => call.name), ["native:read", "native:edit"]);
    assert.deepEqual(fixture.provider.faults, []);
    tuiResult = {
      mode: "tui",
      piLaunches: 1,
      providerRequests: fixture.provider.providerRequests.length,
      tools: tools.length,
      settlements: 2,
      queueObservation: {
        pendingAfterQueue: followUpEvent.pendingAfterQueue,
        activityDuringFollowUp: queuedActivity.trim(),
        settlementsBeforeFollowUpResponse: settledBeforeFollowUp,
      },
    };
  } catch (error) {
    primaryError = error;
  }
  const snapshot = processSnapshot(fixture, terminal);
  const cleanupErrors = await cleanupFixture({ fixture, terminal });
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await saveScenarioFailure({
      scenarioId: "ACT-01-tui",
      message: "ACT-01 TUI activity lifecycle failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ fixture: snapshot, cleanupErrors: cleanupErrors.map(boundedErrorText) }, null, 2),
    });
  }

  const modeResults: JsonObject[] = [tuiResult];
  const modeFailures: unknown[] = [];
  for (const run of [
    () => runPendingSettlement(t.signal),
    () => runRpcMode(t.signal),
    () => runOneShotMode("print", t.signal),
    () => runOneShotMode("json", t.signal),
  ]) {
    try {
      modeResults.push(await run());
    } catch (error) {
      modeFailures.push(error);
    }
  }
  if (modeFailures.length > 0) throw new AggregateError(modeFailures, "ACT-01 additional mode and pending checks failed");
  t.diagnostic(JSON.stringify({ scenarioId: "ACT-01", modes: modeResults, piLaunches: 5, otherChildLaunches: 0 }));
});

// Catalog ID: ACT-02.
test("Activity renders the orange glyph loop and contextual status styling", { timeout: 180_000 }, async (t: TestContext) => {
  const fixture = await createFixture({
    label: "tui-indicator",
    hideThinkingBlock: true,
    responses: [toolResponse("read", { path: "activity-target.txt" }), toolResponse("read", { path: "missing-activity-file.txt" }), textResponse("Styled activity response", {
      gate: deferred<void>(),
      thinking: "The hidden-thinking label uses the configured KillerOS copy.",
      contentGate: deferred<void>(),
    })],
    models: [{ id: defaultModelId, name: "Local activity model", reasoning: true }],
    initialModelId: defaultModelId,
  });
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  let output: JsonObject = {};
  try {
    terminal = await runTuiFixture({ fixture, signal: t.signal, cols: 120, rows: 32, thinking: "high" });
    assert.equal(activityLine(terminal.screen()), undefined, "An idle TUI must not show a working activity message");
    const firstCursor = terminal.sequence;
    terminal.write("Inspect the owned file, fail a missing-file read, then answer.\x1b[13u");
    const firstRequest = await fixture.provider.waitForProviderRequest(1, t.signal);
    assert.equal(firstRequest.model, defaultModelId);
    const mapping = await waitForActivity(terminal, "Mapping…", { signal: t.signal, after: firstCursor, timeoutMs: 30_000 });
    assertModelSuffix(mapping.line, defaultModelId);
    assert.equal(mapping.screen.split("\n").filter((line) => line.includes("Mapping…")).length, 1,
      "The active request must have one visible activity row, not a duplicate widget");

    const observedFrames: string[] = [];
    const frameTimes: number[] = [];
    let screen = mapping.screen;
    let cursor = mapping.sequence;
    let currentFrame = spinnerFrames.find((frame) => activityLine(screen)?.includes(frame));
    if (!currentFrame) {
      screen = await terminal.waitForScreen((value) => spinnerFrames.some((frame) => activityLine(value)?.includes(frame)), {
        signal: t.signal,
        after: cursor,
        timeoutMs: 15_000,
      });
      currentFrame = spinnerFrames.find((frame) => activityLine(screen)?.includes(frame));
      cursor = terminal.sequence;
    }
    assert.ok(currentFrame, "The native working indicator must render a frame");
    const firstFrameIndex = spinnerFrames.indexOf(currentFrame);
    let frameIndex = firstFrameIndex;
    observedFrames.push(currentFrame);
    frameTimes.push(performance.now());
    for (let count = 1; count < spinnerFrames.length; count += 1) {
      frameIndex = (frameIndex + 1) % spinnerFrames.length;
      const expectedFrame = spinnerFrames[frameIndex];
      screen = await terminal.waitForScreen((value) => activityLine(value)?.includes(expectedFrame) ?? false, {
        signal: t.signal,
        after: cursor,
        timeoutMs: 15_000,
      });
      observedFrames.push(expectedFrame);
      frameTimes.push(performance.now());
      cursor = terminal.sequence;
      assert.ok(screen.includes("Mapping…"));
    }
    assert.deepEqual(observedFrames, Array.from(
      { length: spinnerFrames.length },
      (_, index) => spinnerFrames[(firstFrameIndex + index) % spinnerFrames.length],
    ));
    assert.deepEqual(new Set(observedFrames), new Set(spinnerFrames), "The real native loader must render each configured braille frame");
    const frameIntervalsMs = frameTimes.slice(1).map((time, index) => Math.round(time - (frameTimes[index] ?? time)));
    const sortedFrameIntervalsMs = [...frameIntervalsMs].sort((left, right) => left - right);
    const medianFrameIntervalMs = sortedFrameIntervalsMs[Math.floor(sortedFrameIntervalsMs.length / 2)] ?? 0;
    assert.ok(medianFrameIntervalMs >= 40 && medianFrameIntervalMs <= 200,
      `The native loader's observed median interval must remain near 80 ms: ${frameIntervalsMs.join(", ")} ms`);
    fixture.provider.releaseProviderResponse(1);

    const inspect = await waitForActivity(terminal, "Inspecting…", { signal: t.signal, after: cursor, timeoutMs: 30_000 });
    assertModelSuffix(inspect.line, defaultModelId);
    const nativeRead = await fixture.provider.waitForToolCall("native:read", 1, t.signal);
    fixture.provider.releaseToolCall(nativeRead.id);
    const readDone = await waitForActivity(terminal, "Reviewing…", { signal: t.signal, after: inspect.sequence, timeoutMs: 30_000 });
    const secondRequest = await fixture.provider.waitForProviderRequest(2, t.signal);
    assert.equal(secondRequest.model, defaultModelId);
    fixture.provider.releaseProviderResponse(2);
    const inspectFailure = await waitForActivity(terminal, "Inspecting…", { signal: t.signal, after: readDone.sequence, timeoutMs: 30_000 });
    const missingRead = await fixture.provider.waitForToolCall("native:read", 2, t.signal);
    fixture.provider.releaseToolCall(missingRead.id);
    const recover = await waitForActivity(terminal, "Recovering…", { signal: t.signal, after: inspectFailure.sequence, timeoutMs: 30_000 });
    assertModelSuffix(recover.line, defaultModelId);

    const thirdRequest = await fixture.provider.waitForProviderRequest(3, t.signal);
    assert.equal(thirdRequest.model, defaultModelId);
    const rawBeforeResponse = rawTerminalOutput(terminal);
    for (const frame of spinnerFrames) {
      assert.ok(rawBeforeResponse.includes(`\u001b[38;2;215;119;87m${frame} Mapping…`),
        `The native glyph ${frame} and causal verb must use the loaded accent theme role`);
    }
    assert.ok(rawBeforeResponse.includes("\u001b[38;2;128;128;128m("), "The interrupt detail must use the loaded dim theme role");
    assert.ok(rawBeforeResponse.includes("\u001b[1mesc\u001b[22m"), "The interrupt key must use bold ANSI styling");
    assert.ok(rawBeforeResponse.includes("\u001b[38;2;128;128;128m(\u001b[1mesc\u001b[22m to interrupt · understanding request) · gpt-5.4"),
      "The interrupt detail and model suffix must share the loaded dim theme role");
    assert.ok(spinnerFrames.some((frame) => rawBeforeResponse.includes(frame)));
    fixture.provider.releaseProviderResponse(3);
    const hiddenThinkingScreen = await terminal.waitForScreen((value) => value.includes("└ Thinking…")
      && value.includes("Styled activity response"), {
      signal: t.signal,
      after: recover.sequence,
      timeoutMs: 30_000,
    });
    assert.ok(hiddenThinkingScreen.includes("└ Thinking…") && rawTerminalOutput(terminal).includes("└ Thinking…"),
      "The loaded TUI must use the exact KillerOS hidden-thinking label when rendered");
    const responding = await waitForActivity(terminal, "Responding…", { signal: t.signal, after: recover.sequence, timeoutMs: 30_000 });
    assertModelSuffix(responding.line, defaultModelId);
    assert.ok(responding.screen.includes("Styled activity response"));

    const resizeCursor = terminal.sequence;
    terminal.resize(44, 32);
    const narrow = await terminal.waitForScreen((value) => visibleWidth(activityLine(value) ?? "") <= 44
      && (activityLine(value)?.includes("Responding…") ?? false), {
      signal: t.signal,
      after: resizeCursor,
      timeoutMs: 30_000,
    });
    assert.ok(narrow.split("\n").every((line) => visibleWidth(line) <= 44), "Narrow TUI rows must stay within 44 columns");
    assert.ok(narrow.includes("Responding…"));

    const eventCount = eventsOf(readProbeEvents(fixture), "agent_settled").length;
    fixture.provider.releaseText(3);
    const settled = await waitForActivitySettlement(fixture, terminal, eventCount + 1, t.signal, responding.sequence);
    assert.equal(activityLine(settled), undefined, "Settlement must remove the native working row");
    const registration = registrationStatus(fixture, "read");
    assert.equal(registration, undefined, "ACT-02 uses Pi's built-in read tool, not a fixture override");
    assert.equal(fixture.provider.providerRequests.length, 3);
    assert.equal(fixture.provider.observedTools.length, 0);
    assert.deepEqual(fixture.provider.observedExecutionBarriers.map((call) => call.name), ["native:read", "native:read"]);
    assert.deepEqual(fixture.provider.faults, []);
    output = {
      mode: "tui",
      piLaunches: 1,
      providerRequests: fixture.provider.providerRequests.length,
      renderedFrames: observedFrames,
      observedFrameIntervalsMs: frameIntervalsMs,
      medianFrameIntervalMs,
      fullWidth: 120,
      narrowWidth: 44,
      toolEvents: eventsOf(readProbeEvents(fixture), "tool_execution_start").map((event) => event.toolName),
      hiddenThinkingVisible: settled.includes("└ Thinking…") || hiddenThinkingScreen.includes("└ Thinking…"),
    };
  } catch (error) {
    primaryError = error;
  }
  const snapshot = processSnapshot(fixture, terminal);
  const cleanupErrors = await cleanupFixture({ fixture, terminal });
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await saveScenarioFailure({
      scenarioId: "ACT-02",
      message: "ACT-02 TUI activity styling failed",
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ fixture: snapshot, cleanupErrors: cleanupErrors.map(boundedErrorText) }, null, 2),
    });
  }
  t.diagnostic(JSON.stringify({ scenarioId: "ACT-02", ...output, otherChildLaunches: 0 }));
});

const c1ToolName = `custom${Array.from({ length: 0x20 }, (_, index) => String.fromCharCode(0x80 + index)).join("")}tool`;
const wideToolName = "custom中".repeat(20);
const hostileToolName = "danger\n\u0000  name ".repeat(10) + "e\u0301😀中\u001b[31mred\u001b]2;activity-title\u0007";
const paddedModelId = "  GPT-5.4  ";
const hostileModelId = "\u001b[31mGPT\n5.4\u001b]2;activity-model\u0007\u0000";
const blankModelId = "   ";

async function runActivityVectorFixture(options: {
  label: string;
  signal: AbortSignal;
  models: ModelDefinition[];
  initialModelId: string;
  modelCommands?: ModelCommand[];
  toolNames: string[];
  responses: ProviderResponse[];
  exercise: (fixture: Fixture, terminal: PiTerminalProcess) => Promise<JsonObject>;
}): Promise<JsonObject> {
  const fixture = await createFixture({
    label: options.label,
    responses: options.responses,
    models: options.models,
    initialModelId: options.initialModelId,
    toolNames: options.toolNames,
    modelCommands: options.modelCommands,
  });
  let terminal: PiTerminalProcess | undefined;
  let primaryError: unknown;
  let output: JsonObject = {};
  try {
    terminal = await runTuiFixture({ fixture, signal: options.signal, cols: 160, rows: 36 });
    output = await options.exercise(fixture, terminal);
  } catch (error) {
    primaryError = error;
  }
  const snapshot = processSnapshot(fixture, terminal);
  const cleanupErrors = await cleanupFixture({ fixture, terminal });
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    await saveScenarioFailure({
      scenarioId: "ACT-03",
      message: `${options.label} activity input vector failed`,
      errors: [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors],
      diagnostics: JSON.stringify({ fixture: snapshot, cleanupErrors: cleanupErrors.map(boundedErrorText) }, null, 2),
    });
  }
  return output;
}

async function selectModelInTui(terminal: PiTerminalProcess, command: string, notification: string, signal: AbortSignal): Promise<void> {
  const cursor = terminal.sequence;
  // Explicit Enter avoids ConPTY translating a bare CR into Shift+Enter.
  terminal.write(`/${command}\x1b[13u`);
  await terminal.waitForScreen((screen) => screen.includes(notification), { signal, after: cursor, timeoutMs: 20_000 });
}

// Catalog ID: ACT-03.
test("Activity sanitizes custom tool names and appends the model suffix to every state", { timeout: 360_000 }, async (t: TestContext) => {
  const toolNames = ["read", "edit", "bash", "my-tool", c1ToolName, wideToolName, hostileToolName, "activity-fail"];
  const models: ModelDefinition[] = [
    { id: defaultModelId, name: "Local activity model", reasoning: false },
    { id: paddedModelId, name: "Whitespace model", reasoning: false },
    { id: hostileModelId, name: "Hostile local model", reasoning: false },
    { id: blankModelId, name: "Blank local model", reasoning: false },
  ];
  const firstRun = await runActivityVectorFixture({
    label: "activity-input-vectors",
    signal: t.signal,
    models,
    initialModelId: defaultModelId,
    modelCommands: [{ name: "activity-select-padded", modelId: paddedModelId, notification: "ACTIVITY_PADDED_MODEL_SELECTED" }],
    toolNames,
    responses: [
      toolResponse("read", { path: "activity-target.txt" }),
      toolResponse("edit", {
        path: "activity-target.txt",
        edits: [{ oldText: "before activity edit", newText: "after activity edit" }],
      }),
      toolResponse("bash", { command: "echo activity fixture" }),
      toolResponse("my-tool"),
      toolResponse(c1ToolName),
      toolResponse(wideToolName),
      toolResponse(hostileToolName),
      toolResponse("activity-fail"),
      textResponse("Every activity state was reached.", { gate: deferred<void>(), contentGate: deferred<void>() }),
    ],
    exercise: async (fixture, terminal) => {
      await selectModelInTui(terminal, "activity-select-padded", "ACTIVITY_PADDED_MODEL_SELECTED", t.signal);
      const firstCursor = terminal.sequence;
      terminal.write("Run all activity formatter states using the real extension tools.\x1b[13u");
      const expected = [
        { request: 1, tool: "read", started: "Inspecting…", completed: "Reviewing…" },
        { request: 2, tool: "edit", started: "Changing…", completed: "Reviewing…" },
        { request: 3, tool: "bash", started: "Running…", completed: "Reviewing…" },
        { request: 4, tool: "my-tool", started: "Working…", completed: "Reviewing…" },
        { request: 5, tool: c1ToolName, started: "Working…", completed: "Reviewing…" },
        { request: 6, tool: wideToolName, started: "Working…", completed: "Reviewing…" },
        { request: 7, tool: hostileToolName, started: "Working…", completed: "Reviewing…" },
        { request: 8, tool: "activity-fail", started: "Working…", completed: "Recovering…" },
      ];
      const vectors: JsonObject[] = [];
      let screenCursor = firstCursor;
      const occurrences = new Map<string, number>();
      for (const vector of expected) {
        const providerRequest = await fixture.provider.waitForProviderRequest(vector.request, t.signal);
        assert.ok(providerRequest.toolNames.includes(vector.tool), `Provider must receive declared tool ${JSON.stringify(vector.tool)}`);
        if (vector.request === 1) {
          assert.equal(providerRequest.model, paddedModelId, "Pi must send the selected whitespace-padded model id unchanged");
        }
        const start = await waitForActivity(terminal, vector.request === 1 ? "Mapping…" : "Reviewing…", {
          signal: t.signal,
          after: screenCursor,
          timeoutMs: 30_000,
        });
        assertModelSuffix(start.line, "gpt-5.4");
        fixture.provider.releaseProviderResponse(vector.request);
        const occurrence = (occurrences.get(vector.tool) ?? 0) + 1;
        occurrences.set(vector.tool, occurrence);
        const call = await fixture.provider.waitForToolCall(vector.tool, occurrence, t.signal);
        const toolStarted = await waitForActivity(terminal, vector.started, { signal: t.signal, after: screenCursor, timeoutMs: 30_000 });
        assertModelSuffix(toolStarted.line, "gpt-5.4");
        if (vector.tool === "bash") {
          assertExactActivityCopy(toolStarted, "Running… (esc to interrupt · command) · gpt-5.4");
        } else if (vector.tool === "my-tool") {
          assertExactActivityCopy(toolStarted, "Working… (esc to interrupt · using my-tool) · gpt-5.4");
        }
        if (vector.tool === c1ToolName) {
          assert.ok(toolStarted.line.includes("using customtool"), "All C1 code points in the tool id must be removed from the visible name");
          assert.doesNotMatch(toolStarted.line, /[\u0080-\u009f]/u);
        }
        if (vector.tool === wideToolName) {
          const usingIndex = toolStarted.line.indexOf("using ");
          const closeIndex = toolStarted.line.indexOf(")", usingIndex);
          assert.ok(usingIndex >= 0 && closeIndex > usingIndex);
          assert.ok(visibleWidth(toolStarted.line.slice(usingIndex + "using ".length, closeIndex)) <= 32,
            "The visible width-2 tool name must remain at most 32 columns");
        }
        if (vector.tool === hostileToolName) {
          assert.match(toolStarted.line, /using danger name/u);
          assert.ok(toolStarted.line.length < 120, "The hostile tool name must remain under 120 characters");
          assertCleanActivityLine(toolStarted.line);
        }
        fixture.provider.releaseToolCall(call.id, { isError: vector.completed === "Recovering…", text: "controlled public-tool result" });
        const finished = await waitForActivity(terminal, vector.completed, { signal: t.signal, after: toolStarted.sequence, timeoutMs: 30_000 });
        assertModelSuffix(finished.line, "gpt-5.4");
        assertExactActivityCopy(finished, vector.completed === "Recovering…"
          ? "Recovering… (esc to interrupt · tool failed) · gpt-5.4"
          : "Reviewing… (esc to interrupt · reading the result) · gpt-5.4");
        vectors.push({ request: vector.request, toolName: vector.tool, started: vector.started, completed: vector.completed, line: toolStarted.line });
        screenCursor = finished.sequence;
      }

      const finalRequest = await fixture.provider.waitForProviderRequest(9, t.signal);
      assert.ok(finalRequest.toolNames.length > 0);
      fixture.provider.releaseProviderResponse(9);
      const responding = await waitForActivity(terminal, "Responding…", { signal: t.signal, after: screenCursor, timeoutMs: 30_000 });
      assertModelSuffix(responding.line, "gpt-5.4");
      const settledCount = eventsOf(readProbeEvents(fixture), "agent_settled").length;
      fixture.provider.releaseText(9);
      await fixture.provider.waitForProviderResponseFinish(9, t.signal);
      const settled = await waitForActivitySettlement(fixture, terminal, settledCount + 1, t.signal, responding.sequence);
      assert.equal(activityLine(settled), undefined);
      const events = readProbeEvents(fixture);
      assert.deepEqual(eventsOf(events, "tool_execution_start").map((event) => event.toolName), toolNames);
      assert.equal(eventsOf(events, "tool_execution_end").length, toolNames.length);
      assert.equal(eventsOf(events, "tool_execution_end").at(-1)?.isError, true);
      assert.equal(fixture.provider.providerRequests.length, 9);
      assert.equal(fixture.provider.observedTools.length, toolNames.length);
      assert.deepEqual(fixture.provider.faults, []);
      return {
        label: "padded-model-and-tool-vectors",
        piLaunches: 1,
        providerRequests: fixture.provider.providerRequests.length,
        publicToolOperations: fixture.provider.observedTools.length,
        vectors,
      };
    },
  });

  const hostileModel = await runActivityVectorFixture({
    label: "activity-hostile-model-id",
    signal: t.signal,
    models,
    initialModelId: defaultModelId,
    modelCommands: [
      { name: "activity-select-hostile", modelId: hostileModelId, notification: "ACTIVITY_HOSTILE_MODEL_SELECTED" },
      { name: "activity-select-blank", modelId: blankModelId, notification: "ACTIVITY_BLANK_MODEL_SELECTED" },
    ],
    responses: [
      textResponse("The hostile model id was displayed safely.", { gate: deferred<void>() }),
      textResponse("The empty display name used its fallback.", { gate: deferred<void>() }),
    ],
    toolNames: [],
    exercise: async (fixture, terminal) => {
      await selectModelInTui(terminal, "activity-select-hostile", "ACTIVITY_HOSTILE_MODEL_SELECTED", t.signal);
      const cursor = terminal.sequence;
      terminal.write("Show the sanitized local model id.\x1b[13u");
      const request = await fixture.provider.waitForProviderRequest(1, t.signal);
      assert.equal(request.model, hostileModelId, "The selected model id must reach the local provider unchanged");
      const mapping = await waitForActivity(terminal, "Mapping…", { signal: t.signal, after: cursor, timeoutMs: 30_000 });
      assertExactActivityCopy(mapping, "Mapping… (esc to interrupt · understanding request) · gpt5.4");
      assertCleanActivityLine(mapping.line);
      const settlementCount = eventsOf(readProbeEvents(fixture), "agent_settled").length;
      fixture.provider.releaseProviderResponse(1);
      const settled = await waitForActivitySettlement(fixture, terminal, settlementCount + 1, t.signal, mapping.sequence);
      assert.equal(activityLine(settled), undefined);
      await selectModelInTui(terminal, "activity-select-blank", "ACTIVITY_BLANK_MODEL_SELECTED", t.signal);
      const blankCursor = terminal.sequence;
      terminal.write("Show the fallback for an empty model display name.\x1b[13u");
      const blankRequest = await fixture.provider.waitForProviderRequest(2, t.signal);
      assert.equal(blankRequest.model, blankModelId, "The selected blank id reaches the local provider unchanged");
      const blankMapping = await waitForActivity(terminal, "Mapping…", { signal: t.signal, after: blankCursor, timeoutMs: 30_000 });
      assertExactActivityCopy(blankMapping, "Mapping… (esc to interrupt · understanding request) · unknown model");
      fixture.provider.releaseProviderResponse(2);
      const blankSettled = await waitForActivitySettlement(fixture, terminal, settlementCount + 2, t.signal, blankMapping.sequence);
      assert.equal(activityLine(blankSettled), undefined);
      assert.equal(fixture.provider.providerRequests.length, 2);
      assert.deepEqual(fixture.provider.faults, []);
      return { label: "hostile-model-id", piLaunches: 1, providerRequests: 2, displayedSuffixes: ["gpt5.4", "unknown model"] };
    },
  });

  assert.deepEqual([firstRun.label, hostileModel.label], ["padded-model-and-tool-vectors", "hostile-model-id"]);
  const reports = [firstRun, hostileModel];
  t.diagnostic(JSON.stringify({ scenarioId: "ACT-03", runs: reports, piLaunches: 2, otherChildLaunches: 0 }));
});
