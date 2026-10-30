"use strict";
/**
 * System-level migration of blocked-goal completion behavior.
 *
 * Catalog IDs: goals.blocked-completion, goals.blocked-races.
 * Source tests: test/BlockedGoalCompletion.test.ts (legacy, read-only).
 *
 * Every launch is a real Pi CLI process: RPC mode drives goals through the
 * JSON protocol, the TUI launch drives the real terminal. The loopback
 * scripted provider owns every model decision, lifecycle races park the real
 * `verifyGoalDeliverable` open through a child-side filesystem barrier, and
 * the failed-append fault rides the real `appendFileSync` persist path.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const completionCatalogId = "goals.blocked-completion";
const racesCatalogId = "goals.blocked-races";
const completionEvidenceLimit = 2_000;
const goalFixtureProvider = "blocked-goal-local";
const goalFixtureModel = "local";
const originalContent = "Original baseline\n";
const changedContent = "Changed original deliverable\n";
const acceptanceEvidence = "Read the report and checked every acceptance criterion";
const goalStartNotice = "Goal started. Each turn must record continue, complete, or a blocker decision before another turn starts.";
const rawControlEvidence = "  Audited\x1b[31m all criteria\u0007\nChecked results  ";
const normalizedControlEvidence = "Audited all criteria\nChecked results";
const oversizedEvidence = "x".repeat(completionEvidenceLimit + 1);

type RecordValue = Record<string, unknown>;
type PromiseOutcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown };
type ProviderCall = { name: string; args: RecordValue };
type ProviderPlan =
  | { kind: "calls"; calls: ProviderCall[]; beforeResponse?: () => void }
  | { kind: "error" }
  | { kind: "stop" };
type ProviderRequest = { index: number; body: RecordValue; completion: Promise<"finished" | "closed"> };
type SavedGoalEntry = { id: string; event: string; state: RecordValue | null };
type FixturePlan = {
  /** Adapter status sink: written once at load and on every barrier event. */
  status: string;
  verification?: {
    target: string;
    holdCall: number;
    acknowledgement: string;
    release: string;
    status: string;
    failure: string;
    waitTimeoutMs: number;
  };
  appendFault?: {
    acknowledgement: string;
    status: string;
    failure: string;
  };
};
type BlockedGoalFixture = {
  directory: string;
  project: string;
  sessionFile: string;
  currentSessionFile: string;
  provider: LocalProvider;
  rpc?: PiRpcProcess;
  terminal?: PiTerminalProcess;
  batches: Array<{ label: string; first: number; through: number; records: number }>;
  acknowledgedSequence: number;
  observerPath: string;
  signal: AbortSignal;
};
type LaunchObservation = {
  launch: string;
  providerRequests: number;
  naturalExit: boolean;
  exitCode: number | null;
};

const repositoryCliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

// ---------------------------------------------------------------------------
// Small typed plumbing helpers.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label = "JSON object"): RecordValue {
  if (!isRecord(value)) throw new Error(`Expected ${label} to be a JSON object`);
  return value;
}

function records(value: unknown, label = "JSON array"): RecordValue[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be a JSON array`);
  return value.map((entry) => record(entry, label));
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function stringField(value: RecordValue, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`Expected string field ${name}`);
  return field;
}

function numberField(value: RecordValue, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`Expected numeric field ${name}`);
  return field;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function outcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  try {
    return { kind: "resolved", value: await promise };
  } catch (error) {
    return { kind: "rejected", error };
  }
}

// -----------------------------------------------------------------------
// Loopback scripted provider.
// -----------------------------------------------------------------------

class LocalProvider {
  readonly faults: string[] = [];
  readonly requests: ProviderRequest[] = [];
  private readonly server: Server;
  private readonly plans: ProviderPlan[] = [];
  private readonly handlers = new Set<Promise<void>>();
  private address = "";

  constructor() {
    this.server = createServer((request, response) => {
      const handling = this.handle(request, response);
      this.handlers.add(handling);
      void handling.then(
        () => this.handlers.delete(handling),
        (error: unknown) => {
          if (this.faults.length < 16) this.faults.push(errorText(error).slice(0, 4_000));
          this.handlers.delete(handling);
        },
      );
    });
  }

  get baseUrl(): string {
    if (!this.address) throw new Error("The loopback blocked-goal provider is not listening");
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
          reject(new Error("The loopback blocked-goal provider did not receive a TCP address"));
          return;
        }
        this.address = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  queueGoalDecision(decision: RecordValue): void {
    this.queueCalls([{ name: "killeros_goal_update", args: decision }]);
  }

  /** Queues one assistant response with the exact ordered tool-call batch, followed by a settling plain response. */
  queueCalls(calls: ProviderCall[]): void {
    this.plans.push({ kind: "calls", calls }, { kind: "stop" });
  }

  /**
   * Queues only the tool-call batch. Abort-family race vectors (reload, RPC abort,
   * shutdown) never send the settling request, so a trailing stop plan would fail close().
   */
  queueCallsOnly(calls: ProviderCall[], beforeResponse?: () => void): void {
    this.plans.push({ kind: "calls", calls, beforeResponse });
  }

  queuePlainStop(): void {
    this.plans.push({ kind: "stop" });
  }

  queueError(): void {
    this.plans.push({ kind: "error" });
  }

  async waitForRequest(count: number, signal?: AbortSignal): Promise<ProviderRequest> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    const existing = this.requests[count - 1];
    if (existing) return existing;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Provider wait was cancelled");
    return await new Promise<ProviderRequest>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const clean = (): void => {
        if (pollTimer) clearTimeout(pollTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (signal) signal.removeEventListener("abort", abort);
      };
      const abort = (): void => {
        clean();
        if (!settled) {
          settled = true;
          reject(signal?.reason instanceof Error ? signal.reason : new Error("Provider wait was cancelled"));
        }
      };
      let index = this.requests.length;
      const poll = (): void => {
        while (index < this.requests.length) {
          const candidate = this.requests[index];
          index += 1;
          if (String(candidate.index) === String(count)) {
            clean();
            if (!settled) {
              settled = true;
              resolve(candidate);
            }
            return;
          }
        }
        if (!settled) pollTimer = setTimeout(check, 25);
      };
      const check = poll;
      signal?.addEventListener("abort", abort, { once: true });
      deadlineTimer = setTimeout(() => {
        clean();
        if (!settled) {
          settled = true;
          reject(new Error(`Timed out waiting for provider request ${count}`));
        }
      }, 30_000);
      poll();
    });
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
      const timer = setTimeout(() => this.server.closeAllConnections(), 5_000);
      try {
        await closed;
      } catch (error) {
        errors.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.handlers]).then(() => undefined),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Loopback provider still has ${this.handlers.size} unfinished handlers`)), 5_000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.faults.length > 0) errors.push(new Error(`Loopback provider recorded fixture faults: ${this.faults.slice(0, 4).join("; ")}`));
    if (this.plans.length > 0) errors.push(new Error(`${this.plans.length} planned provider responses were never consumed`));
    if (errors.length > 0) throw new AggregateError(errors, "Loopback provider cleanup failed");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error(`Unexpected provider request ${request.method} ${request.url}`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Provider request chunk was not bytes");
        bytes += chunk.length;
        if (bytes > 1_048_576) throw new Error("Provider request exceeded 1 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(parseJson(Buffer.concat(chunks).toString("utf8")));
      const index = this.requests.length + 1;
      let resolveCompletion: (outcomeValue: "finished" | "closed") => void = () => {};
      const completion = new Promise<"finished" | "closed">((resolve) => { resolveCompletion = resolve; });
      response.once("finish", () => resolveCompletion("finished"));
      response.once("close", () => resolveCompletion(response.writableFinished ? "finished" : "closed"));
      const observed: ProviderRequest = { index, body, completion };
      this.requests.push(observed);
      const plan: ProviderPlan = this.plans.shift() ?? { kind: "stop" };
      if (plan.kind === "calls") plan.beforeResponse?.();
      if (response.destroyed || response.writableEnded) return;
      if (plan.kind === "error") {
        // A planned 500 keeps the real pi-ai path: the request fails and the turn settles with stopReason "error".
        response.writeHead(500, { connection: "close" });
        response.end("planned provider failure");
        // Let the socket drain before the handler resolves so close() never races an in-flight response.
        await outcome(completion);
        return;
      }
      const calls = plan.kind === "calls" ? plan.calls : undefined;
      const deltas = calls === undefined
        ? { content: "The scripted request has settled." }
        : { tool_calls: calls.map((call, callIndex) => ({
          index: callIndex,
          id: `blocked-goal-${index}-${callIndex}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })) };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `blocked-goal-${index}`,
        model: goalFixtureModel,
        choices: [{
          index: 0,
          delta: deltas,
          finish_reason: calls === undefined ? "stop" : "tool_calls",
        }],
      })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      if (this.faults.length < 16) this.faults.push(errorText(error).slice(0, 4_000));
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { connection: "close" });
        response.end("Blocked goal fixture provider failure");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture probe extension (see blockedGoalProbeSource below).
// ---------------------------------------------------------------------------

function blockedGoalProbeSource(): string {
  return String.raw`
import { appendFileSync } from "node:fs";

const observerPath = process.env.KILLEROS_BLOCKED_GOAL_OBSERVER ?? "";
if (!observerPath) throw new Error("KILLEROS_BLOCKED_GOAL_OBSERVER is not set");
let sequence = 0;
function record(type, details = {}) {
  appendFileSync(observerPath, JSON.stringify({ sequence: ++sequence, type, ...details }) + "\n", "utf8");
}

export default function blockedGoalProbe(pi) {
  const pendingPollers = new Map();
  pi.on("session_start", (event, ctx) => {
    record("session_start", {
      reason: event?.reason ?? null,
      mode: ctx.mode,
      activeTools: pi.getActiveTools().filter((name) => name === "killeros_goal_update"),
    });
  });
  pi.on("session_shutdown", (event) => {
    for (const poll of pendingPollers.values()) clearInterval(poll);
    pendingPollers.clear();
    record("session_shutdown", { reason: event?.reason ?? null });
  });
  pi.on("session_before_tree", (event) => record("session_before_tree", { targetId: event?.preparation?.targetId ?? null }));
  pi.on("session_tree", (event) => {
    record("session_tree", { newLeafId: event?.newLeafId ?? null, oldLeafId: event?.oldLeafId ?? null });
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "killeros_goal_update") return;
    const signal = ctx.signal;
    record("goal_tool_start", {
      signalPresent: signal !== undefined,
      signalAborted: signal?.aborted ?? null,
      hold: pi.getActiveTools().includes("killeros_goal_update"),
    });
    if (!signal) return;
    const deadline = Date.now() + 120_000;
    const poll = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(poll);
        pendingPollers.delete(event.toolCallId);
        record("goal_signal_poll_timeout", {});
        return;
      }
      if (!signal.aborted) return;
      clearInterval(poll);
      pendingPollers.delete(event.toolCallId);
      record("goal_signal_aborted", {});
    }, 5);
    pendingPollers.set(event.toolCallId, poll);
  });
  pi.on("agent_end", (event) => {
    record("agent_end", {
      stopReason: event?.messages?.at?.(-1)?.stopReason ?? null,
      hold: pi.getActiveTools().includes("killeros_goal_update"),
    });
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== "killeros_goal_update") return;
    const poll = pendingPollers.get(event.toolCallId);
    if (poll !== undefined) clearInterval(poll);
    pendingPollers.delete(event.toolCallId);
    record("goal_tool_end", {
      status: event.result?.details?.status ?? null,
      verification: event.result?.details?.verification ?? null,
      hold: pi.getActiveTools().includes("killeros_goal_update"),
    });
  });
  pi.on("agent_settled", () => {
    record("agent_settled", { hold: pi.getActiveTools().includes("killeros_goal_update") });
  });
  pi.registerCommand("fixture-goal-tree", {
    description: "Attempt public Pi tree navigation through the real extension command context",
    handler: async (argument, ctx) => {
      const [action, targetId] = argument.split(" ");
      if (action !== "navigate" || !targetId) throw new Error("Unknown fixture-goal-tree request");
      try {
        const result = await ctx.navigateTree(targetId, { summarize: false });
        record("navigation_result", { outcome: result.cancelled ? "cancelled" : "committed", targetId });
      } catch (error) {
        record("navigation_result", {
          outcome: "rejected",
          message: error instanceof Error ? error.message : String(error),
          targetId,
        });
      }
    },
  });
  pi.registerCommand("fixture-reload", {
    description: "Reload the extension runtime through the real extension command context",
    handler: async (_argument, ctx) => {
      try {
        await ctx.reload();
        record("reload_result", { outcome: "committed" });
      } catch (error) {
        record("reload_result", { outcome: "rejected", message: error instanceof Error ? error.message : String(error) });
      }
    },
  });
  pi.registerCommand("fixture-seed", {
    description: "Create a fresh saved session and seed killeros-goal entries through the real replacement context",
    handler: async (argument, ctx) => {
      const [action, planPath] = argument.split(" ");
      if (action !== "seed" || !planPath) throw new Error("Unknown fixture-seed request");
      const plan = JSON.parse(readPlan(planPath));
      await ctx.newSession({
        setup: async (sessionManager) => {
          sessionManager.appendMessage({ role: "user", content: plan.userMessage ?? "Blocked goal fixture seed.", timestamp: Date.now() });
          for (const entry of plan.entries) {
            sessionManager.appendCustomEntry(entry.customType, entry.data);
          }
        },
      });
      record("seed_result", { outcome: "committed", entries: plan.entries.length });
    },
  });
}

import { readFileSync } from "node:fs";
function readPlan(planPath) {
  return readFileSync(planPath, "utf8");
}
`;
}

// ---------------------------------------------------------------------------
// Child-side fixture adapter: filesystem verification barrier + append fault.
// ---------------------------------------------------------------------------

function blockedGoalAdapterSource(): string {
  return String.raw`
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const planPath = process.env.KILLEROS_BLOCKED_GOAL_FIXTURE_PLAN;
if (!planPath) throw new Error("KILLEROS_BLOCKED_GOAL_FIXTURE_PLAN is not set");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const status = { events: [], appendFired: false, verificationArmed: plan.verification !== undefined, appendArmed: plan.appendFault !== undefined };
function writeJsonAtomic(filePath, value) {
  const temporary = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}
function recordEvent(event, extra = {}) {
  status.events.push({ event, ...extra });
  if (status.events.length > 16) status.events.shift();
}
function recordFailure(operation, error, failurePath) {
  const failure = {
    operation,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack || "").slice(0, 4000) : null,
    recordedAt: new Date().toISOString(),
  };
  try { writeJsonAtomic(failurePath, failure); }
  catch (reportError) {
    process.stderr.write(JSON.stringify({ adapterFailure: failure, failureReportError: String(reportError) }) + "\n");
  }
}

if (status.verificationArmed) {
  const verification = plan.verification;
  const target = path.resolve(verification.target);
  const holdCall = verification.holdCall;
  if (!Number.isSafeInteger(holdCall) || holdCall < 1) throw new Error("Invalid fixture verification holdCall");
  const originalOpen = fsp.open;
  let forwarded = 0;
  let intercepts = 0;
  let restored = false;
  function waitForRelease() {
    const deadline = Date.now() + verification.waitTimeoutMs;
    return new Promise((resolve, reject) => {
      function check() {
        if (fs.existsSync(verification.release)) resolve(fs.readFileSync(verification.release, "utf8"));
        else if (Date.now() >= deadline) reject(new Error("Fixture verification barrier timed out after " + verification.waitTimeoutMs + "ms"));
        else setTimeout(check, 10);
      }
      check();
    });
  }
  function restoreAdapter() {
    if (restored) return;
    fsp.open = originalOpen;
    syncBuiltinESMExports();
    restored = true;
    recordEvent("verification-adapter-restored");
  }
  fsp.open = async function openWithVerificationBarrier(...args) {
    const filePath = args[0];
    const isTarget = typeof filePath === "string" && path.resolve(filePath).toLowerCase() === target.toLowerCase();
    if (!isTarget) return originalOpen.apply(fsp, args);
    forwarded += 1;
    if (forwarded !== holdCall || intercepts > 0) return originalOpen.apply(fsp, args);
    intercepts += 1;
    let operation = "inspect verification target";
    try {
      const inspected = fs.lstatSync(target);
      writeJsonAtomic(verification.acknowledgement, {
        size: inspected.size,
        mtimeMs: inspected.mtimeMs,
        contentHash: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
        acknowledgedAt: new Date().toISOString(),
      });
      recordEvent("verification-open-paused", { call: forwarded });
      operation = "wait for parent verification release";
      await waitForRelease();
      recordEvent("verification-open-release-observed");
      restoreAdapter();
      operation = "forward verification target open";
      const handle = await originalOpen.apply(fsp, args);
      recordEvent("verification-open-completed");
      writeJsonAtomic(verification.status, status);
      return handle;
    } catch (error) {
      recordFailure(operation, error, verification.failure);
      restoreAdapter();
      throw error;
    }
  };
  recordEvent("verification-adapter-armed");
}

if (status.appendArmed) {
  const appendFault = plan.appendFault;
  const originalAppend = fs.appendFileSync;
  fs.appendFileSync = function appendWithFault(filePath, data, options) {
    const line = typeof data === "string" ? data : String(data || "");
    if (!status.appendFired
      && typeof filePath === "string"
      && path.resolve(filePath).toLowerCase() === path.resolve(appendFault.target).toLowerCase()
      && line.includes("\"customType\":\"killeros-goal\"")
      && line.includes("\"event\":\"complete\"")) {
      status.appendFired = true;
      fs.appendFileSync = originalAppend;
      syncBuiltinESMExports();
      writeJsonAtomic(appendFault.status, status);
      recordEvent("append-fault-fired");
      writeJsonAtomic(appendFault.acknowledgement, { firedAt: new Date().toISOString() });
      recordFailure("append blocked goal complete event", new Error("Session storage unavailable"), appendFault.failure);
      throw new Error("Session storage unavailable");
    }
    return originalAppend.call(fs, filePath, data, options);
  };
  recordEvent("append-fault-armed");
}
writeJsonAtomic(plan.status, status);
syncBuiltinESMExports();
`;
}

// ---------------------------------------------------------------------------
// Fixture construction and shared helpers.
// ---------------------------------------------------------------------------

function goalFileBaseline(target: string): RecordValue {
  const content = readFileSync(target);
  return {
    exists: true,
    size: content.length,
    mtimeMs: statSync(target).mtimeMs,
    contentHash: createHash("sha256").update(content).digest("hex"),
  };
}

/** Builds a parse-valid blocked goal state; `overrides` replaces whole fields and `omit` drops them. */
function blockedState(template: RecordValue, overrides: RecordValue = {}, omit: readonly string[] = []): RecordValue {
  const state: RecordValue = { ...template, ...overrides };
  for (const field of omit) delete state[field];
  return state;
}

const blockedStateTemplate: RecordValue = {
  version: 1,
  revision: 1,
  objective: "Audit the whole objective",
  status: "blocked",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  activeMilliseconds: 321,
  turns: 3,
  blockedAuditStartTurn: 0,
  baselineTokens: 0,
  result: "Persistent external blocker remains after three audited attempts",
  maxTurns: 20,
};

function blockedFileState(target: string): RecordValue {
  return blockedState(blockedStateTemplate, {
    objective: `Fix \`${target}\``,
    verification: { kind: "file", path: target, baseline: goalFileBaseline(target) },
  });
}

function buildFixtureEnvironment(directory: string, agent: string, temporary: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const inheritedPath = inherited.get("path");
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    TEMP: temporary,
    TMP: temporary,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PATH: inheritedPath
      ? `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`
      : path.dirname(process.execPath),
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function writeProviderCatalog(agent: string, provider: LocalProvider): void {
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultThinkingLevel: "off",
  }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({
    providers: {
      [goalFixtureProvider]: {
        api: "openai-completions",
        apiKey: "fixture-only",
        baseUrl: provider.baseUrl,
        models: [{
          id: goalFixtureModel,
          name: "Local blocked goal fixture",
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

type RpcFixtureOptions = {
  seedEntries?: Array<{ customType: string; data: RecordValue }>;
  seedUserMessage?: string;
  plan?: FixturePlan;
};

/**
 * Creates one isolated RPC blocked-goal fixture: owned project/sessions/agent
 * directories, a loopback provider, an optionally seeded saved session, an
 * armed child adapter, and the probe extension.
 */
async function createBlockedGoalRpcFixture(
  parentDirectory: string,
  label: string,
  signal: AbortSignal,
  options: RpcFixtureOptions = {},
): Promise<BlockedGoalFixture> {
  const directory = path.join(parentDirectory, label);
  let ownsDirectory = false;
  let provider: LocalProvider | undefined;
  let rpc: PiRpcProcess | undefined;
  try {
    mkdirSync(directory);
    ownsDirectory = true;
    const agent = path.join(directory, "agent");
    // Saved sessions retain cwd across fresh-process recovery after fixture cleanup.
    const project = path.join(parentDirectory, `${label}-project`);
    const sessions = path.join(directory, "sessions");
    const temporary = path.join(directory, "tmp");
    for (const sub of [agent, project, sessions, temporary]) mkdirSync(sub);

    provider = new LocalProvider();
    await provider.listen();
    writeProviderCatalog(agent, provider);

    const session = SessionManager.create(project, sessions);
    session.appendMessage({
      role: "user",
      content: options.seedUserMessage ?? `Blocked goal fixture session: ${label}.`,
      timestamp: Date.now(),
    });
    for (const seed of options.seedEntries ?? []) {
      session.appendCustomEntry(seed.customType, seed.data);
    }
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile, `${label}: the native fixture session must be saved before Pi starts`);

    const observerPath = path.join(directory, "probe-observer.jsonl");
    const environment = buildFixtureEnvironment(directory, agent, temporary);
    environment.KILLEROS_BLOCKED_GOAL_OBSERVER = observerPath;
    const probePath = path.join(directory, "blocked-goal-probe.ts");
    writeFileSync(probePath, blockedGoalProbeSource(), "utf8");

    const args = [
      "--mode", "rpc",
      "--model", `${goalFixtureProvider}/${goalFixtureModel}`,
      "--thinking", "off",
      "--tools", "killeros_goal_update",
      "--session", sessionFile,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", probePath,
    ];

    if (options.plan) {
      const planPath = path.join(directory, "fixture-plan.json");
      writeFileSync(planPath, JSON.stringify({
        ...options.plan,
        appendFault: options.plan.appendFault && { ...options.plan.appendFault, target: sessionFile },
      }, null, 2));
      environment.KILLEROS_BLOCKED_GOAL_FIXTURE_PLAN = planPath;
      const adapterPath = path.join(directory, "blocked-goal-adapter.cjs");
      writeFileSync(adapterPath, blockedGoalAdapterSource(), "utf8");
      environment.NODE_OPTIONS = `--require "${adapterPath.replaceAll("\\", "/")}"`;
    }

    rpc = new PiRpcProcess({ cliPath: repositoryCliPath, cwd: project, env: environment, args });
    return {
      directory,
      project,
      sessionFile,
      currentSessionFile: sessionFile,
      provider,
      rpc,
      batches: [],
      acknowledgedSequence: 0,
      observerPath,
      signal,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (rpc) {
      try {
        const closed = await rpc.close();
        if (closed.forced || closed.treeCleanupError !== undefined || closed.exit.code !== 0 || closed.exit.signal !== null) {
          cleanupErrors.push(new Error(`${label}: setup-failure cleanup was not orderly: ${JSON.stringify(closed)}`));
        }
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (provider) {
      try { await provider.close(); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (ownsDirectory) {
      try { await removeDirectoryNow(directory); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    throw new AggregateError([error, ...cleanupErrors], `${label}: blocked goal fixture setup failed\n${rpc?.diagnostics() ?? "rpc not started"}`);
  }
}

async function removeDirectoryNow(directory: string): Promise<void> {
  rmSync(directory, { recursive: true, force: true });
  if (existsSync(directory)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  assert.equal(existsSync(directory), false, `the owned fixture directory must be removed: ${directory}`);
}

async function failedRpcCleanup(
  fixture: Pick<BlockedGoalFixture, "rpc" | "provider" | "directory">,
  label: string,
  options: { release?: string; remove?: boolean } = {},
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (options.release && !existsSync(options.release)) {
    try { writeReleaseFile(options.release, `${label}: cleanup release`); } catch (error) { errors.push(error); }
  }
  if (fixture.rpc) {
    try {
      const closed = await fixture.rpc.close();
      if (closed.forced || closed.treeCleanupError !== undefined || closed.exit.code !== 0 || closed.exit.signal !== null) {
        errors.push(new Error(`${label}: RPC cleanup was not orderly: ${JSON.stringify(closed)}\n${fixture.rpc.diagnostics()}`));
      }
    } catch (error) { errors.push(error); }
  }
  try { await fixture.provider.close(); } catch (error) { errors.push(error); }
  if (options.remove) {
    try { await removeDirectoryNow(fixture.directory); } catch (error) { errors.push(error); }
  }
  return errors;
}

function goalRpcCommand(fixture: BlockedGoalFixture, type: string, fields: RecordValue = {}, timeoutMs = 30_000): Promise<RecordValue> {
  return fixture.rpc!.command(type, fields, { timeoutMs, signal: fixture.signal }).then((response) => record(response, `${type} response`));
}

async function goalState(fixture: BlockedGoalFixture): Promise<RecordValue> {
  return record((await goalRpcCommand(fixture, "get_state")).data, "RPC state");
}

async function goalEntriesOf(fixture: BlockedGoalFixture): Promise<RecordValue[]> {
  const data = record((await goalRpcCommand(fixture, "get_entries")).data, "RPC entries response");
  return records(data.entries, "saved session entries");
}

function savedGoalEntries(entries: RecordValue[]): SavedGoalEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal entry data");
    const state = data.state === null ? null : record(data.state, "saved goal state");
    return [{ id: stringField(entry, "id"), event: stringField(data, "event"), state }];
  });
}

function lastSavedGoal(entries: SavedGoalEntry[], label: string): SavedGoalEntry {
  const entry = entries.at(-1);
  assert.ok(entry, `${label}: expected a saved killeros-goal entry`);
  return entry;
}

function savedGoalEvent(entries: SavedGoalEntry[], event: string, label: string): SavedGoalEntry {
  const matches = entries.filter((entry) => entry.event === event);
  const entry = matches.at(-1);
  assert.ok(entry, `${label}: expected a saved goal event ${event}`);
  return entry;
}

function goalToolResults(entries: RecordValue[]): Array<{ text: string; isError: boolean; details: unknown }> {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = record(entry.message, "session message entry");
    if (message.role !== "toolResult" || message.toolName !== "killeros_goal_update") return [];
    const content = records(message.content, "tool result content");
    return [{
      text: content.map((part) => stringField(part, "text")).join("\n"),
      isError: message.isError === true,
      details: message.details,
    }];
  });
}

function toolResultError(results: Array<{ text: string; isError: boolean }>, pattern: RegExp, label: string): { text: string } {
  const error = results.find((result) => result.isError && pattern.test(result.text));
  assert.ok(error, `${label}: expected an error tool result matching ${String(pattern)}\nobserved: ${JSON.stringify(results.map((result) => result.text.slice(0, 200)))}`);
  return error;
}

/** Reads goal entries directly from the session file on disk; the durable truth after a failed in-memory append. */
function savedGoalEntriesFromSessionFile(sessionFile: string, label: string): SavedGoalEntry[] {
  const lines = readFileSync(sessionFile, "utf8").split(/\r?\n/u).filter(Boolean)
    .map((line, index) => record(parseJson(line), `${label}[${index}]`));
  return savedGoalEntries(lines);
}

function providerBodyIncludes(body: RecordValue, text: string): boolean {
  const raw = JSON.stringify(body);
  return raw.includes(text) || raw.includes(JSON.stringify(text).slice(1, -1));
}

function acknowledgeGoalBatch(fixture: BlockedGoalFixture, label: string): void {
  const rpc = fixture.rpc;
  assert.ok(rpc, `${label}: acknowledgeGoalBatch requires an RPC fixture`);
  const through = rpc.currentSequence;
  const first = rpc.firstSequence;
  const count = rpc.retainedRecordCount;
  assert.equal(first, fixture.acknowledgedSequence + 1, `${label}: retained RPC evidence must be contiguous`);
  assert.equal(count, through - fixture.acknowledgedSequence, `${label}: acknowledge the complete retained RPC batch`);
  rpc.acknowledge(through);
  assert.equal(rpc.retainedRecordCount, 0, `${label}: the acknowledged RPC batch must be released`);
  fixture.batches.push({ label, first, through, records: count });
  fixture.acknowledgedSequence = through;
}

function assertGoalIdle(state: RecordValue, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: Pi must not still be streaming`);
  assert.equal(state.isCompacting, false, `${label}: Pi must not still be compacting`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no follow-up may remain queued`);
}

async function waitForGoalSettled(fixture: BlockedGoalFixture, after: number, label: string): Promise<void> {
  assert.ok(fixture.rpc, `${label}: waitForGoalSettled requires an RPC fixture`);
  await fixture.rpc.waitFor((entry) => entry.type === "agent_settled", {
    after,
    timeoutMs: 60_000,
    signal: fixture.signal,
  });
  assertGoalIdle(await goalState(fixture), label);
}

async function waitForGoalSettlements(fixture: BlockedGoalFixture, after: number, count: number, label: string): Promise<void> {
  assert.ok(fixture.rpc, `${label}: waitForGoalSettlements requires an RPC fixture`);
  let cursor = after;
  for (let settled = 0; settled < count; settled += 1) {
    const stored = await fixture.rpc.waitForRecord((entry) => entry.type === "agent_settled", {
      after: cursor,
      timeoutMs: 60_000,
      signal: fixture.signal,
    });
    assert.ok(stored.sequence > cursor, `${label}: each settlement advances the observation cursor`);
    cursor = stored.sequence;
  }
}

async function expectedGoalNotification(fixture: BlockedGoalFixture, after: number, predicate: string | ((message: string) => boolean), expectedType: string, label: string): Promise<RecordValue> {
  const notification = await fixture.rpc!.waitFor(
    (entry) => entry.type === "extension_ui_request"
      && entry.method === "notify"
      && typeof entry.message === "string"
      && (typeof predicate === "string" ? entry.message === predicate : predicate(entry.message)),
    { after, timeoutMs: 30_000, signal: fixture.signal },
  );
  assert.equal((record(notification, `${label} notification`)).notifyType, expectedType, `${label}: notification type`);
  return record(notification, `${label} notification`);
}

async function promptGoalCommand(fixture: BlockedGoalFixture, text: string, label: string, timeoutMs = 45_000): Promise<RecordValue> {
  const response = await goalRpcCommand(fixture, "prompt", { message: text }, timeoutMs);
  return record(response.data ?? response, `${label} prompt response`);
}

async function promptOrdinaryRun(fixture: BlockedGoalFixture, text: string, label: string): Promise<void> {
  const data = await promptGoalCommand(fixture, text, label);
  assert.equal(data.disposition, "started", `${label}: the ordinary message must start a run`);
}

/** Confirms the child is idle, /goal is registered, and a seeded goal (if any) restored without provider traffic. */
async function initializeBlockedGoalFixture(
  fixture: BlockedGoalFixture,
  label: string,
  expectSeedCount = 1,
): Promise<void> {
  const state = await goalState(fixture);
  assert.equal(state.isStreaming, false, `${label}: startup must not stream`);
  const commands = records(record((await goalRpcCommand(fixture, "get_commands")).data, "get_commands data").commands, "registered commands");
  assert.ok(commands.some((command) => stringField(command, "name") === "goal"), `${label}: /goal must be registered`);
  assert.equal(fixture.provider.requestCount, 0, `${label}: startup must not make a provider request`);
  const seeded = savedGoalEntries(await goalEntriesOf(fixture));
  assert.equal(seeded.length, expectSeedCount, `${label}: seeded goal entry count`);
  acknowledgeGoalBatch(fixture, `${label}: startup`);
}

/** Drives one blocked goal through three real blocker turns at the RPC boundary. */
async function blockGoalThroughRealTurns(
  fixture: BlockedGoalFixture,
  label: string,
  signal: AbortSignal,
  objective = "Audit the whole objective",
): Promise<void> {
  const startCursor = fixture.acknowledgedSequence;
  for (const turn of [1, 2, 3]) {
    fixture.provider.queueGoalDecision({ status: "blocked", blockerKey: "external", evidence: `Missing prerequisite ${turn}` });
  }
  const startOutcome = await promptGoalCommand(fixture, `/goal ${objective}`, `${label}: start`);
  assert.equal(startOutcome.disposition, "handled", `${label}: Pi must dispatch /goal to the extension command`);
  await expectedGoalNotification(fixture, startCursor, goalStartNotice, "info", `${label}: start notice`);
  for (const request of [1, 2, 3, 4, 5, 6]) await fixture.provider.waitForRequest(request, signal);
  await waitForGoalSettlements(fixture, startCursor, 3, `${label}: three blocker turns`);
  const entries = savedGoalEntries(await goalEntriesOf(fixture));
  assert.deepEqual(entries.map((entry) => entry.event), ["set", "turn", "blocker-audit", "turn", "blocker-audit", "turn", "blocked"],
    `${label}: three accepted blocker decisions must block the goal`);
  const blocked = lastSavedGoal(entries, `${label}: blocked state`).state;
  assert.ok(blocked, `${label}: the blocked state must persist`);
  assert.equal(blocked.status, "blocked");
  assert.equal(numberField(blocked, "turns"), 3);
  assert.equal(numberField(record(blocked.blockerAudit, `${label}: blocker audit`), "streak"), 3);
  blockGoalStateByFixture.set(fixture.directory, blocked);
  acknowledgeGoalBatch(fixture, `${label}: blocked state created`);
}

const blockGoalStateByFixture = new Map<string, RecordValue>();

/** Returns the blocked state that `blockGoalThroughRealTurns` persisted for the fixture. */
function blockGoalState(fixture: BlockedGoalFixture): RecordValue {
  const state = blockGoalStateByFixture.get(fixture.directory);
  assert.ok(state, "the real-turn blocked state must have been captured before this check");
  return state;
}

/** Closes the RPC fixture, records cleanup proof, and removes the owned directory. */
async function closeRpcFixture(
  fixture: BlockedGoalFixture,
  label: string,
  expectedRequests: number,
): Promise<LaunchObservation> {
  const rpc = fixture.rpc;
  assert.ok(rpc, `${label}: closeRpcFixture requires an RPC fixture`);
  assert.equal(fixture.provider.requestCount, expectedRequests, `${label}: exact provider request count`);
  const errors: unknown[] = [];
  let closed: Awaited<ReturnType<typeof rpc.close>> = { exit: { code: 0, signal: null }, forced: false };
  try {
    closed = await rpc.close(30_000);
    if (closed.forced) errors.push(new Error(`${label}: Pi CLI required forced cleanup: ${JSON.stringify(closed)}`));
    if (closed.exit.code !== 0 || closed.exit.signal !== null) {
      errors.push(new Error(`${label}: Pi CLI exit was not clean: ${JSON.stringify(closed.exit)}\n${rpc.diagnostics()}`));
    }
    if (closed.treeCleanupError !== undefined) errors.push(new Error(`${label}: Pi CLI tree cleanup was uncertain: ${closed.treeCleanupError}`));
    assert.equal(fixture.provider.requestCount, expectedRequests, `${label}: exact provider request count after exit`);
    acknowledgeGoalBatch(fixture, `${label}: shutdown`);
  } catch (error) {
    errors.push(error);
  }
  try {
    await fixture.provider.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, `${label}: cleanup failed`);
  return {
    launch: label,
    providerRequests: expectedRequests,
    naturalExit: closed.forced === false,
    exitCode: closed.exit.code,
  };
}

async function closeBlockedFixtureCompletely(
  fixture: BlockedGoalFixture,
  label: string,
  observation: LaunchObservation,
): Promise<void> {
  try {
    await removeDirectoryNow(fixture.directory);
  } catch (error) {
    throw new AggregateError([error], `${label}: ${observation.launch} cleanup failed`);
  }
}

function readProbeEvents(observerPath: string, label: string): RecordValue[] {
  if (!existsSync(observerPath)) return [];
  return readFileSync(observerPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => record(parseJson(line), `${label}[${index}]`));
}

function probeEventCount(events: RecordValue[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

async function waitForPlanJson(
  acknowledgementPath: string,
  failurePath: string | undefined,
  timeoutMs: number,
  label: string,
): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (failurePath !== undefined && existsSync(failurePath)) {
      const failure = record(parseJson(readFileSync(failurePath, "utf8")));
      throw new Error(`${label}: child-side barrier failed during ${stringField(failure, "operation")}: ${stringField(failure, "message")}`);
    }
    if (existsSync(acknowledgementPath)) return record(parseJson(readFileSync(acknowledgementPath, "utf8")));
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

function writeReleaseFile(releasePath: string, label: string): void {
  try {
    writeFileSync(releasePath, "release\n");
  } catch (error) {
    throw new Error(`${label}: unable to write verification release: ${errorText(error)}`);
  }
}

/** Writes a seed plan the probe's /fixture-seed command consumes through the real replacement context. */
function writeSeedPlan(
  directory: string,
  label: string,
  entries: Array<{ customType: string; data: RecordValue }>,
): string {
  const seedPath = path.join(directory, `${label}-seed.json`);
  writeFileSync(seedPath, JSON.stringify({
    userMessage: `Blocked goal fixture seeded session: ${label}.`,
    entries,
  }), "utf8");
  return seedPath;
}

/** Seeds a fresh in-process session (new_session + setup) through the probe's real replacement context. */
async function seedFreshSession(
  fixture: BlockedGoalFixture,
  label: string,
  goalStateToSeed: RecordValue,
  seedEvent = "blocked",
): Promise<string> {
  const previousFile = fixture.currentSessionFile;
  const seedPath = writeSeedPlan(fixture.directory, label, [{ customType: "killeros-goal", data: { version: 1, event: seedEvent, state: goalStateToSeed } }]);
  const seedData = await promptGoalCommand(fixture, `/fixture-seed seed ${seedPath}`, `${label}: seed`, 60_000);
  assert.equal(seedData.disposition, "handled", `${label}: the seed prompt must be handled`);
  const seedEvents = readProbeEvents(fixture.observerPath, label).filter((event) => event.type === "seed_result");
  const seedEventRecord = seedEvents.at(-1);
  assert.ok(seedEventRecord, `${label}: the probe must record the seed result`);
  assert.equal(stringField(seedEventRecord, "outcome"), "committed", `${label}: the seed must commit`);
  const state = await goalState(fixture);
  assert.notEqual(state.sessionFile, previousFile, `${label}: the seed must select a new saved session file`);
  assertGoalIdle(state, `${label}: seeded session`);
  fixture.currentSessionFile = stringField(state, "sessionFile");
  acknowledgeGoalBatch(fixture, `${label}: seed prompt response`);
  return fixture.currentSessionFile;
}

// ---------------------------------------------------------------------------
// Evidence journal: one run-owned directory, never shared across test invocations.
// ---------------------------------------------------------------------------

const evidenceDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-goal-evidence-"));
const evidenceWriteProblems: string[] = [];

function createArtifactDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    for (const root of [directory, realpathSync(directory)]) {
      for (let current = root; ; current = path.dirname(current)) {
        if (existsSync(path.join(current, ".git"))) throw new Error(`Fixture ancestor contains .git: ${current}`);
        if (path.dirname(current) === current) break;
      }
    }
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(directory, "node_modules"), "junction");
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function removeArtifactDirectory(directory: string): Promise<void> {
  const junction = path.join(directory, "node_modules");
  assert.equal(lstatSync(junction).isSymbolicLink(), true, "the dependency entry must remain an owned junction");
  assert.equal(realpathSync(junction).toLowerCase(), realpathSync(path.join(repositoryRoot, "node_modules")).toLowerCase(),
    "the dependency junction must still target the checkout dependencies");
  unlinkSync(junction);
  await removeDirectoryNow(directory);
}

/** Best-effort per-catalog launch journal; failures are collected and asserted at scenario end. */
function writeRunsJournal(catalog: string, launches: LaunchObservation[], extra: RecordValue = {}): void {
  try {
    const journalPath = path.join(evidenceDirectory, "runs.json");
    const journal: Record<string, RecordValue> = {};
    if (existsSync(journalPath)) {
      const parsed: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
      if (isRecord(parsed)) {
        for (const [id, entry] of Object.entries(parsed)) {
          if (isRecord(entry)) journal[id] = entry;
        }
      }
    }
    journal[catalog] = {
      recordedAt: new Date().toISOString(),
      piLaunches: launches.length,
      launches,
      ...extra,
    };
    mkdirSync(evidenceDirectory, { recursive: true });
    const temporary = `${journalPath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(journal, null, 2));
    renameSync(temporary, journalPath);
  } catch (error) {
    evidenceWriteProblems.push(`${catalog}: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: goals.blocked-completion.
// ---------------------------------------------------------------------------

const invalidStatuses = ["continue", "blocked", "pause", "resume", "clear", "replace", "unknown"] as const;
const invalidEvidenceValues = ["", "  ", oversizedEvidence] as const;

// Catalog ID: goals.blocked-completion.
test(`${completionCatalogId}: a later ordinary request can complete the same blocked goal once`, { timeout: 130_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-completion-");
    await runTuiBlockedCompletion(t.signal, artifactDirectory, observations);
    await runFileProofHistory(t, artifactDirectory, observations);
    const legacyProof = await runLegacyTurnHistories(t.signal, artifactDirectory);
    observations.push(...legacyProof);
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must stay writable");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
    writeRunsJournal(completionCatalogId, observations);
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
  } catch (error) {
    failure = error;
    if (artifactDirectory) try {
      throwScenarioFailure({ directory: artifactDirectory, message: `${completionCatalogId}: blocked goal completion failed`, errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))], diagnostics: "" });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory)) try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${completionCatalogId}: artifact cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

test(`${completionCatalogId}: ordinary request eligibility and decision validation`, { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-eligibility-");
    await runEligibilityLifecycle(t.signal, artifactDirectory, observations);
    assert.equal(observations.length, 1, "eligibility uses one Pi launch");
    writeRunsJournal(`${completionCatalogId}.eligibility`, observations, { divergences: [
      "numeric evidence 42 reaches the model path through typebox string conversion and completes the goal with evidence \"42\"",
    ] });
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
  } catch (error) {
    failure = error;
    if (artifactDirectory) try {
      throwScenarioFailure({ directory: artifactDirectory, message: `${completionCatalogId}: eligibility failed`, errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))], diagnostics: "" });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory)) try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${completionCatalogId}: eligibility artifact cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

/** Launch 1: TUI live block, early rejection, one eligible request with invalids, and a verified file completion. */
async function runTuiBlockedCompletion(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
): Promise<void> {
  const label = "tui-live-completion";
  const directory = path.join(artifactDirectory, label);
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  const target = path.join(project, "target.md");
  writeFileSync(target, originalContent);
  const objective = `Fix \`${target}\``;
  let provider: LocalProvider | undefined;
  let terminal: PiTerminalProcess | undefined;
  let observerPath = "";
  let failure: unknown;
  try {
    // Keep receipt scans and filesystem watchers inside this fixture, even when
    // other test processes are changing the enclosing checkout.
    const gitOptions = { cwd: project, env: buildFixtureEnvironment(directory, agent, temporary), windowsHide: true, timeout: 10_000 };
    execFileSync("git", ["init", "-q", "--template="], gitOptions);
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], gitOptions).toString("utf8").trim();
    assert.equal(realpathSync.native(gitRoot).toLowerCase(), realpathSync.native(project).toLowerCase(), "the TUI fixture must own its Git root");
    provider = new LocalProvider();
    await provider.listen();
    writeProviderCatalog(agent, provider);
    observerPath = path.join(directory, "probe-observer.jsonl");
    const probePath = path.join(directory, "blocked-goal-probe.ts");
    writeFileSync(probePath, blockedGoalProbeSource(), "utf8");
    const environment = buildFixtureEnvironment(directory, agent, temporary);
    environment.KILLEROS_BLOCKED_GOAL_OBSERVER = observerPath;
    const session = SessionManager.create(project, sessions);
    session.appendMessage({ role: "user", content: `Blocked goal TUI fixture: ${label}.`, timestamp: Date.now() });
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile, "the TUI fixture session must be saved");

    provider.queueGoalDecision({ status: "blocked", blockerKey: "external", evidence: "Missing prerequisite 1" });
    provider.queueGoalDecision({ status: "blocked", blockerKey: "external", evidence: "Missing prerequisite 2" });
    provider.queueCalls([
      { name: "killeros_goal_update", args: { status: "blocked", blockerKey: "external", evidence: "Missing prerequisite 3" } },
      { name: "killeros_goal_update", args: { status: "complete", evidence: "Too early" } },
    ]);

    terminal = new PiTerminalProcess({
      file: process.execPath,
      args: [repositoryCliPath,
        "--model", `${goalFixtureProvider}/${goalFixtureModel}`,
        "--thinking", "off",
        "--tools", "killeros_goal_update",
        "--session", sessionFile,
        "--session-dir", sessions,
        "--offline", "--approve",
        "--no-context-files",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
        "--extension", repositoryRoot,
        "--extension", probePath],
      cwd: project,
      env: environment,
      cols: 120,
      rows: 32,
    });
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal, timeoutMs: 60_000 });
    const commandCursor = terminal.sequence;
    terminal.write(`\x1b[200~/goal ${objective}\x1b[201~`);
    await terminal.waitForScreen((screen) => screen.includes("/goal") && screen.includes("target.md"),
      { signal, after: commandCursor });
    terminal.write("\x1b[13u");
    await terminal.waitForScreen(
      (screen) => screen.includes("Goal blocked") && screen.includes("/goal blocked"),
      { signal, timeoutMs: 120_000 },
    );
    const blockedSettlement = await waitForProbeEvent({ directory, observerPath },
      event => event.type === "agent_settled" && event.hold === false,
      30_000, "TUI blocked settlement", signal);
    assert.equal(provider.requestCount, 6, "three blocker turns must produce six provider requests");

    writeFileSync(target, changedContent);
    assert.equal(readFileSync(target, "utf8"), changedContent, "the verified deliverable exists at the original path");
    // Numeric evidence 42 is deferred to the RPC leg: typebox converts it to "42" and the
    // real Pi then completes the goal, so this batch only carries truly rejected evidence.
    provider.queueCalls([
      ...invalidStatuses.map((status) => ({
        name: "killeros_goal_update" as const,
        args: { status, evidence: "Attempt", ...(status === "blocked" ? { blockerKey: "external" } : {}) },
      })),
      ...invalidEvidenceValues.map((evidence) => ({
        name: "killeros_goal_update" as const,
        args: { status: "complete", evidence },
      })),
      { name: "killeros_goal_update", args: { status: "complete", evidence: acceptanceEvidence } },
      { name: "killeros_goal_update", args: { status: "complete", evidence: "Duplicate" } },
    ]);
    await terminal.submitEditorText("Verify the deliverable and record goal completion if the whole objective is done.", { signal });
    const eligibleRequest = await provider.waitForRequest(7, signal);
    assert.ok(records(eligibleRequest.body.tools, "eligible tool inventory")
      .some(tool => record(tool.function, "eligible tool").name === "killeros_goal_update"),
    "the later ordinary request must declare the blocked completion tool");
    assert.ok(providerBodyIncludes(eligibleRequest.body, "Status: blocked"), "the eligible request must carry the blocked status system section");
    assert.ok(providerBodyIncludes(eligibleRequest.body, objective), "the eligible request must carry the unchanged objective");
    await terminal.waitForScreen(
      (screen) => screen.includes("Goal completed") && !screen.includes("/goal blocked"),
      { signal, timeoutMs: 120_000 },
    );
    // Goal completion renders during tool execution, before the final provider response settles.
    const completionSettlement = await waitForProbeEvent({ directory, observerPath },
      event => event.type === "agent_settled" && numberField(event, "sequence") > numberField(blockedSettlement, "sequence"),
      30_000, "TUI completion settlement", signal);
    assert.equal(completionSettlement.hold, false, "completion must deactivate the goal tool");
    const completedTool = readProbeEvents(observerPath, label)
      .find(event => event.type === "goal_tool_end" && event.status === "complete");
    assert.ok(completedTool, "the successful completion must emit its native tool result");
    assert.equal(completedTool.hold, false, "completion must deactivate the tool before settlement");
    assert.equal(completedTool.verification, "file", "the native completion result reports file verification");
    await terminal.waitForScreen(screen => !screen.split("\n").slice(-2).join("\n").includes("/goal"), { signal });

    const sessionLines = readFileSync(sessionFile, "utf8").split(/\r?\n/u).filter(Boolean)
      .map((line, index) => record(parseJson(line), `tui-session[${index}]`));
    const goalEntries = savedGoalEntries(sessionLines);
    assert.deepEqual(goalEntries.map((entry) => entry.event), ["set", "turn", "blocker-audit", "turn", "blocker-audit", "turn", "blocked", "complete"],
      "the TUI goal must persist set, three audited turns, the blocked decision, and one complete event");
    assert.equal(sessionLines.filter(entry => entry.type === "custom_message"
      && entry.customType === "killeros-goal-continuation").length, 3, "only the three authorized goal messages are saved");
    const completed = lastSavedGoal(goalEntries, "TUI completed state").state;
    assert.ok(completed, "the completed TUI goal state must persist");
    assert.equal(completed.status, "complete");
    assert.equal(completed.blockerAudit, undefined);
    const blocked = goalEntries.find((entry) => entry.event === "blocked")?.state;
    assert.ok(blocked, "the live blocked state must precede completion");
    for (const field of ["objective", "createdAt", "baselineTokens", "verification", "turns", "maxTurns", "activeMilliseconds"] as const) {
      assert.deepEqual(completed[field], blocked[field], `TUI completion must preserve ${field}`);
    }
    assert.equal(numberField(completed, "revision"), numberField(blocked, "revision") + 1,
      "completion must increment the live blocked revision exactly once");
    assert.equal(numberField(completed, "turns"), 3);
    assert.equal(completed.objective, objective);
    const lastDecision = record(completed.lastDecision, "TUI completed decision");
    assert.deepEqual(lastDecision, { kind: "complete", verification: "file", turn: 3, evidence: acceptanceEvidence });
    const verification = record(completed.verification, "TUI completed verification");
    assert.equal(verification.path, target);
    const originalBaseline = record(verification.baseline, "TUI original file baseline");
    assert.equal(originalBaseline.exists, true);
    assert.equal(originalBaseline.contentHash, createHash("sha256").update(originalContent).digest("hex"));
    assert.equal(provider.requestCount, 8, "the eligible request consumes the invalid batch and one settling response");

    const results = goalToolResults(sessionLines);
    const earlyRejection = toolResultError(results, /completed during an eligible later ordinary request|later ordinary request/iu, "TUI early rejection");
    assert.ok(earlyRejection.text.length > 0);
    // "continue" and "blocked" are valid enum values and must be rejected by the tool execute path.
    const executeStatusRejections = results.filter((result) => result.isError && /A blocked goal accepts only complete/u.test(result.text));
    assert.equal(executeStatusRejections.length, 2, "status continue and status blocked must be rejected without consuming permission");
    toolResultError(results, /Goal evidence must not be empty/u, "the whitespace-only evidence rejection");
    toolResultError(results, /no active/iu, "completion must reject a duplicate decision without appending another event");
    // The other five statuses, empty evidence, and oversized evidence fail host validation.
    const hostRejections = results.filter((result) => result.isError && /Validation failed for tool "killeros_goal_update"/u.test(result.text));
    assert.equal(hostRejections.length, 7, "five invalid statuses, empty evidence, and oversized evidence must fail host validation without consuming permission");

    const closed = await terminal.close();
    assert.equal(closed.forced, false, "the TUI child must exit naturally");
    assert.equal(closed.code, 0, "the TUI child must exit cleanly");
    assert.equal(closed.failure, undefined, "the TUI child must close without native cleanup errors");
    assert.equal(provider.requestCount, 8, "the TUI child must not make another request before exit");
    observations.push({ launch: label, providerRequests: provider.requestCount, naturalExit: closed.forced === false, exitCode: closed.code });
  } catch (error) {
    failure = error;
    try {
      writeRunsJournal(completionCatalogId, observations, {
        outcome: "failed", failedLaunch: label, providerRequests: provider?.requestCount,
        error: errorText(error), terminal: terminal?.diagnostics(),
        probe: observerPath && existsSync(observerPath) ? readFileSync(observerPath, "utf8").slice(0, 30_000) : "",
      });
    } catch (diagnosticError) {
      failure = new AggregateError([error, diagnosticError], `${label}: failed to capture diagnostics`);
    }
  } finally {
    const cleanup: unknown[] = [];
    if (terminal) {
      try {
        const closed = await terminal.close();
        if (closed.forced || closed.code !== 0 || closed.failure !== undefined) {
          cleanup.push(new Error(`${label}: TUI cleanup was not orderly: ${JSON.stringify(closed)}`));
        }
      } catch (error) { cleanup.push(error); }
    }
    if (provider) try { await provider.close(); } catch (error) { cleanup.push(error); }
    try { await removeDirectoryNow(directory); } catch (error) { cleanup.push(error); }
    if (cleanup.length > 0) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], `${label}: cleanup failed`);
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
}

/** Launch 2: RPC eligibility lifecycle - provider error, settlement cut-off, unrelated request, and model-reported completion. */
async function runEligibilityLifecycle(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
): Promise<void> {
  const label = "rpc-eligibility-lifecycle";
  const fixture = await createBlockedGoalRpcFixture(artifactDirectory, label, signal);
  try {
    await initializeBlockedGoalFixture(fixture, label, 0);
    // One live RPC sequence creates the blocked state through three real blocker turns.
    await blockGoalThroughRealTurns(fixture, label, signal);
    const initialEntries = await goalEntriesOf(fixture);
    const blockedHistory = savedGoalEntries(initialEntries);
    const goalMessages = (entries: RecordValue[]) => entries.filter((entry) =>
      entry.type === "custom_message" && entry.customType === "killeros-goal-continuation").length;
    assert.equal(goalMessages(initialEntries), 3, "the blocked goal must have exactly three authorized continuation messages");

    // Vector: eligibility survives provider failure but ends at agent_settled.
    fixture.provider.queueError();
    await promptOrdinaryRun(fixture, "Continue the blocked goal if you can now.", `${label}: eligible error`);
    const failedRequest = await fixture.provider.waitForRequest(7, signal);
    assert.ok(providerBodyIncludes(failedRequest.body, "Status: blocked"), "the eligible request must carry the blocked status system section");
    assert.ok(providerBodyIncludes(failedRequest.body, "Audit the whole objective"), "the eligible request must carry the unchanged objective");
    await waitForGoalSettled(fixture, fixture.acknowledgedSequence, `${label}: provider-error settlement`);
    assert.equal(fixture.provider.requestCount, 7, "the failed provider response must not trigger another request");
    assert.deepEqual(savedGoalEntries(await goalEntriesOf(fixture)), blockedHistory,
      "the provider error must preserve the complete live blocked history");
    const probeEvents = readProbeEvents(fixture.observerPath, label);
    const agents = probeEvents.filter((event) => event.type === "agent_end" || event.type === "agent_settled");
    assert.equal(agents.filter((event) => event.type === "agent_end").at(-1)?.stopReason, "error", "the provider failure must reach agent_end as an error");
    assert.equal(agents.filter((event) => event.type === "agent_end").at(-1)?.hold, true, "the goal tool must stay active through agent_end after a provider error");
    assert.equal(agents.filter((event) => event.type === "agent_settled").at(-1)?.hold, false, "eligibility must end at agent_settled");
    acknowledgeGoalBatch(fixture, `${label}: failed eligible window`);

    // Vector: ordinary work has no mandatory decision.
    const unrelatedCursor = fixture.acknowledgedSequence;
    fixture.provider.queuePlainStop();
    await promptOrdinaryRun(fixture, "Summarize today's weather without recording any goal decision.", `${label}: unrelated`);
    await waitForGoalSettled(fixture, unrelatedCursor, `${label}: unrelated settlement`);
    assert.equal(fixture.provider.requestCount, 8, "the unrelated request must receive exactly one plain response");
    const unrelatedEntries = await goalEntriesOf(fixture);
    assert.deepEqual(savedGoalEntries(unrelatedEntries), blockedHistory, "ordinary work must not append a goal decision");
    assert.equal(goalMessages(unrelatedEntries), 3, "settlement and ordinary work must not send another goal continuation");
    acknowledgeGoalBatch(fixture, `${label}: unrelated window`);

    // Vector: invalid statuses and invalid evidence share one eligible window, then the normalized completion succeeds.
    const invalidCursor = fixture.acknowledgedSequence;
    fixture.provider.queueCalls([
      ...invalidStatuses.map((status) => ({
        name: "killeros_goal_update" as const,
        args: { status, evidence: "Attempt", ...(status === "blocked" ? { blockerKey: "external" } : {}) },
      })),
      ...invalidEvidenceValues.map((evidence) => ({
        name: "killeros_goal_update" as const,
        args: { status: "complete", evidence },
      })),
      { name: "killeros_goal_update", args: { status: "complete", evidence: rawControlEvidence } },
    ]);
    await promptOrdinaryRun(fixture, "Sometimes validate and complete the blocked goal.", `${label}: invalids`);
    await waitForGoalSettled(fixture, invalidCursor, `${label}: invalid batch settlement`);
    const entries = savedGoalEntries(await goalEntriesOf(fixture));
    assert.deepEqual(entries.slice(0, -1), blockedHistory, "the invalid batch must preserve the live blocked history");
    assert.equal(entries.at(-1)?.event, "complete", "the invalid batch must append exactly one complete event");
    const completed = lastSavedGoal(entries, "lifecycle completed state").state;
    assert.ok(completed, "the completed state must persist");
    for (const field of ["objective", "createdAt", "maxTurns", "activeMilliseconds", "baselineTokens"] as const) {
      assert.equal(record(completed, `${field} must be preserved`)[field], blockGoalState(fixture)[field], `${field} must survive completion unchanged`);
    }
    assert.equal(numberField(completed, "revision"), numberField(blockGoalState(fixture), "revision") + 1, "completion must increment the revision");
    assert.equal(completed.blockerAudit, undefined, "completion must clear the blocker audit");
    assert.equal(numberField(completed, "turns"), numberField(blockGoalState(fixture), "turns"), "completion must not consume additional turns");
    const decision = record(completed.lastDecision, "lifecycle completed decision");
    assert.equal(decision.turn, 3, "the completion decision belongs to the saved turn");
    assert.equal(decision.evidence, normalizedControlEvidence, "control characters must be stripped from accepted evidence");
    assert.equal(completed.result, normalizedControlEvidence, "the persisted result must match the normalized evidence");
    assert.equal(decision.verification, "model-reported");
    const completedEntries = await goalEntriesOf(fixture);
    const results = goalToolResults(completedEntries);
    const completionResult = results.find((result) => !result.isError && isRecord(result.details) && result.details.status === "complete");
    assert.ok(completionResult, "the goal tool must report a successful completion");
    assert.equal(record(completionResult.details).verification, "model-reported");
    assert.equal(record(completionResult.details).evidence, normalizedControlEvidence);
    assert.equal(goalMessages(completedEntries), 3, "completion must not send another goal continuation");
    toolResultError(results, /Goal evidence must not be empty/u, "the whitespace evidence rejection");
    assert.equal(results.filter((result) => result.isError
      && /A blocked goal accepts only complete/u.test(result.text)).length, 2,
      "continue and blocked must be rejected without consuming completion permission");
    assert.equal(results.filter((result) => result.isError
      && /Validation failed for tool "killeros_goal_update"/u.test(result.text)).length, 7,
      "five invalid statuses, empty evidence, and oversized evidence must fail host validation");
    acknowledgeGoalBatch(fixture, `${label}: completed lifecycle`);

    const completedStatusCursor = fixture.acknowledgedSequence;
    await promptGoalCommand(fixture, "/goal", `${label}: normalized completion status`);
    await expectedGoalNotification(fixture, completedStatusCursor,
      message => message.includes("Goal complete") && message.includes(normalizedControlEvidence), "info",
      `${label}: completed status preserves the accepted evidence`);
    acknowledgeGoalBatch(fixture, `${label}: normalized completion status`);

    // Vector: the legacy non-string evidence value 42 reaches the real Pi path: typebox converts
    // it to "42", so the eligible window completes with that string instead of rejecting.
    const echoedSeed = blockGoalState(fixture);
    await seedFreshSession(fixture, `${label}-target-42`, echoedSeed);
    const coercedCursor = fixture.acknowledgedSequence;
    fixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: 42 } }]);
    await promptOrdinaryRun(fixture, "Record completion for the blocked goal using the numeric evidence.", `${label}: numeric evidence`);
    await waitForGoalSettled(fixture, coercedCursor, `${label}: coerced evidence settlement`);
    const coercedEntries = savedGoalEntries(await goalEntriesOf(fixture));
    assert.deepEqual(coercedEntries.map((entry) => entry.event), ["blocked", "complete"], "the coerced numeric evidence must complete the goal (documented divergence)");
    const coercedCompleted = lastSavedGoal(coercedEntries, "coerced evidence completed state").state;
    assert.ok(coercedCompleted, "the coerced completion state must persist");
    assert.equal(record(coercedCompleted.lastDecision, "coerced completion decision").evidence, "42", "typebox must coerce numeric evidence 42 to the string \"42\"");
    assert.equal(fixture.provider.requestCount, 12, "three blocker turns, three eligibility windows, and the coerced window consume exactly twelve requests");
    acknowledgeGoalBatch(fixture, `${label}: coerced evidence window`);

    const statusCursor = fixture.acknowledgedSequence;
    await promptGoalCommand(fixture, "/goal", `${label}: status`);
    const summary = await expectedGoalNotification(fixture, statusCursor, (message) => message.includes("Goal complete") && message.includes("42"), "info", `${label}: completed status summary`);
    assert.ok(String(summary.message).includes(`3/${String(echoedSeed.maxTurns)} turns`), "the status summary must report the saved turns and limit");
    acknowledgeGoalBatch(fixture, `${label}: status summary`);
    observations.push(await closeRpcFixture(fixture, label, 12));
  } catch (error) {
    throw new AggregateError([error, ...await failedRpcCleanup(fixture, label)], `${label}: fixture failed`);
  }
}

/** Launch 3: file proof history - exact-path and content failures plus the retry after each failure. */
async function runFileProofHistory(
  t: TestContext,
  artifactDirectory: string,
  observations: LaunchObservation[],
): Promise<void> {
  const signal = t.signal;
  const label = "rpc-file-proof";
  const directory = path.join(artifactDirectory, `${label}-files`);
  const target = path.join(directory, "target.md");
  mkdirSync(directory, { recursive: true });
  writeFileSync(target, originalContent);
  const seed = blockedFileState(target);
  const proofSeed = blockedState(seed, { activeMilliseconds: 1234 });
  const fixture = await createBlockedGoalRpcFixture(artifactDirectory, label, signal, {
    seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: proofSeed } }],
  });
  try {
    await initializeBlockedGoalFixture(fixture, label);
    const wrongTarget = path.join(directory, "wrong.md");
    writeFileSync(wrongTarget, "Wrong destination");
    const originalHash = goalFileBaseline(target).contentHash;

    type FileCase = {
      name: string;
      prepare: () => void;
      pattern?: RegExp;
      accepts?: boolean;
    };
    const fileCases: FileCase[] = [
      {
        name: "unchanged",
        prepare: () => {
          rmSync(target, { force: true });
          writeFileSync(target, originalContent);
        },
        pattern: /has not changed/u,
      },
      { name: "missing", prepare: () => { rmSync(target, { force: true }); }, pattern: /not a regular file at the required path/u },
      { name: "directory", prepare: () => { rmSync(target, { force: true }); mkdirSync(target); }, pattern: /not a regular file at the required path/u },
      {
        name: "symlink",
        prepare: () => {
          rmSync(target, { force: true, recursive: true });
          try {
            symlinkSync(wrongTarget, target, "file");
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM"].includes(String(error.code))) throw error;
            t.diagnostic("File symlink creation unavailable; regular-file rejection uses the missing target. Real symlink coverage requires a capable host.");
          }
        },
        pattern: /not a regular file at the required path/u,
      }, {
        name: "null-content",
        prepare: () => {
          rmSync(target, { force: true, recursive: true });
          writeFileSync(target, originalContent);
        },
        pattern: /content cannot be verified/u,
      }, {
        name: "retry",
        prepare: () => {
          rmSync(target, { force: true, recursive: true });
          writeFileSync(target, changedContent);
        },
        accepts: true,
      },
    ];
    let requests = 0;
    for (const [index, fileCase] of fileCases.entries()) {
      const caseLabel = `${label}: ${fileCase.name}`;
      const isNullCase = fileCase.name === "null-content";
      const seededState = isNullCase
        ? blockedState(proofSeed, { verification: { kind: "file", path: target, baseline: { exists: true, size: originalContent.length, mtimeMs: 1, contentHash: null } } })
        : proofSeed;
      fileCase.prepare();
      await seedFreshSession(fixture, `${label}-seed-${index + 1}`, seededState);
      fixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: "Checked the file" } }]);
      const caseCursor = fixture.acknowledgedSequence;
      await promptOrdinaryRun(fixture, "Proof check the deliverable and record completion if the whole objective is done.", caseLabel);
      await waitForGoalSettled(fixture, caseCursor, `${caseLabel}: settlement`);
      const entries = savedGoalEntries(await goalEntriesOf(fixture));
      const results = goalToolResults(await goalEntriesOf(fixture));
      if (fileCase.accepts) {
        const complete = savedGoalEvent(entries, "complete", caseLabel);
        const completed = record(complete.state!, `${caseLabel}: completed state`);
        assert.equal(completed.status, "complete");
        assert.equal(record(completed.lastDecision, `${caseLabel}: decision`).verification, "file");
        assert.deepEqual(record(completed.verification, `${caseLabel}: verification unchanged`), proofSeed.verification);
        assert.notEqual(goalFileBaseline(target).contentHash, originalHash, `${caseLabel}: the retry must keep the original baseline and record the changed deliverable`);
      } else {
        toolResultError(results, fileCase.pattern ?? /never fail/u, caseLabel);
        const lastEntry = entries.at(-1);
        assert.ok(lastEntry, `${caseLabel}: at least the seeded goal entry must remain`);
        assert.equal(lastEntry.event, "blocked", `${caseLabel}: the rejection must leave the blocked seed last`);
        assert.deepEqual(lastEntry.state, seededState, `${caseLabel}: the rejection must leave the blocked state unchanged`);
        assert.equal(entries.length, 1, `${caseLabel}: the rejection must append no goal event`);
        assert.equal(results.every((result) => !result.isError || fileCase.pattern?.test(result.text) === true), true,
          `${caseLabel}: every error result must match the case oracle`);
      }
      requests += 2;
      acknowledgeGoalBatch(fixture, caseLabel);
    }

    // Each follow-up request acknowledges the previous tool result before changing its real file input.
    await seedFreshSession(fixture, `${label}-same-request-retry`, proofSeed);
    const retryCases = fileCases.filter(fileCase => fileCase.name !== "null-content");
    const settlementsBeforeRetry = readProbeEvents(fixture.observerPath, label)
      .filter(event => event.type === "agent_settled").length;
    for (const [index, fileCase] of retryCases.entries()) {
      fixture.provider.queueCallsOnly([
        { name: "killeros_goal_update", args: { status: "complete", evidence: "Checked the file" } },
      ], () => {
        const entries = savedGoalEntriesFromSessionFile(fixture.currentSessionFile, `${label}: retry ${index}`);
        assert.deepEqual(entries.map(entry => entry.event), ["blocked"], "failed verification appends no goal event");
        assert.deepEqual(entries[0]?.state, proofSeed, "failed verification preserves the original state and baseline");
        assert.equal(readProbeEvents(fixture.observerPath, label).filter(event => event.type === "agent_settled").length,
          settlementsBeforeRetry, "all verification attempts share the same eligible request");
        fileCase.prepare();
      });
    }
    fixture.provider.queuePlainStop();
    const retryCursor = fixture.acknowledgedSequence;
    await promptOrdinaryRun(fixture, "Retry file verification after each failed check without ending this request.", `${label}: same-request retry`);
    await waitForGoalSettled(fixture, retryCursor, `${label}: same-request retry settlement`);
    const retryResults = goalToolResults(await goalEntriesOf(fixture));
    assert.equal(retryResults.length, retryCases.length, "the request executes every verification attempt exactly once");
    for (const [index, fileCase] of retryCases.entries()) {
      const result = retryResults[index];
      assert.ok(result);
      assert.equal(result.isError, !fileCase.accepts, `${fileCase.name}: verification outcome`);
      if (fileCase.pattern) assert.match(result.text, fileCase.pattern, `${fileCase.name}: original rejection`);
    }
    const retryEntries = savedGoalEntries(await goalEntriesOf(fixture));
    assert.deepEqual(retryEntries.map(entry => entry.event), ["blocked", "complete"], "retry completes only once");
    const retryCompleted = retryEntries[1]?.state;
    assert.ok(retryCompleted);
    assert.deepEqual(retryCompleted.verification, proofSeed.verification, "the successful retry retains the original proof baseline");
    assert.equal(record(retryCompleted.lastDecision, "same-request retry decision").verification, "file");
    assert.equal(record(retryResults.at(-1)?.details, "same-request retry result").verification, "file");
    assert.equal(retryCompleted.turns, proofSeed.turns, "failed checks and retry grant no goal turn");
    requests += retryCases.length + 1;
    acknowledgeGoalBatch(fixture, `${label}: same-request retry`);
    assert.equal(fixture.provider.requestCount, requests, "the file proof history consumes a decision and a settling request per case");
    observations.push(await closeRpcFixture(fixture, label, requests));
  } catch (error) {
    throw new AggregateError([error, ...await failedRpcCleanup(fixture, label)], `${label}: fixture failed`);
  }
}

/** Launches 4 and 5: legacy positive-turn history and zero-turn closure, each through a fresh seeded process. */
async function runLegacyTurnHistories(
  signal: AbortSignal,
  artifactDirectory: string,
): Promise<LaunchObservation[]> {
  const observations: LaunchObservation[] = [];
  const base = blockedStateTemplate;
  const legacyBase = blockedState(base, { activeMilliseconds: 1234, maxTurns: 3 }, ["blockerAudit", "lastDecision"]);
  const positiveTurns = blockedState(legacyBase, { turns: 3, blockedAuditStartTurn: 0 });
  const zeroTurns = blockedState(legacyBase, { turns: 0, blockedAuditStartTurn: 0, result: "Zero accounted turns at block time" });

  const positiveLabel = "rpc-legacy-positive-turns";
  const positiveFixture = await createBlockedGoalRpcFixture(artifactDirectory, positiveLabel, signal, {
    seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: positiveTurns } }],
  });
  try {
    await initializeBlockedGoalFixture(positiveFixture, positiveLabel);
    let events = readProbeEvents(positiveFixture.observerPath, positiveLabel);
    const startup = events.filter((event) => event.type === "session_start").at(-1);
    assert.deepEqual(startup?.activeTools ?? [], [], "the restored legacy goal must not activate the tool before a later ordinary request");
    const completeCursor = positiveFixture.rpc!.currentSequence;
    positiveFixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: "Audited legacy objective" } }]);
    await promptOrdinaryRun(positiveFixture, "Inspect the legacy goal and record completion if appropriate.", `${positiveLabel}: complete`);
    await waitForGoalSettled(positiveFixture, completeCursor, `${positiveLabel}: completion settlement`);
    const entries = savedGoalEntries(await goalEntriesOf(positiveFixture));
    const completedState = record(savedGoalEvent(entries, "complete", positiveLabel).state!, `${positiveLabel}: completed`);
    assert.equal(completedState.status, "complete");
    assert.equal(numberField(completedState, "turns"), 3, "the legacy completion must not consume a new turn");
    assert.equal(numberField(completedState, "maxTurns"), 3);
    assert.equal(numberField(completedState, "activeMilliseconds"), 1234, "the persisted clock must survive the seeded restore");
    assert.equal(numberField(completedState, "revision"), numberField(positiveTurns, "revision") + 1);
    assert.equal(numberField(record(completedState.lastDecision, `${positiveLabel}: decision`), "turn"), 3);
    assert.equal(record(completedState.lastDecision, `${positiveLabel}: decision`).verification, "model-reported");
    const completionResult = (await goalEntriesOf(positiveFixture))
      .filter(entry => entry.type === "message")
      .map(entry => record(entry.message, `${positiveLabel}: message`))
      .find(message => message.role === "toolResult" && message.toolName === "killeros_goal_update");
    assert.ok(completionResult);
    assert.equal(record(completionResult.details, `${positiveLabel}: tool result`).verification, "model-reported");
    assert.equal(positiveFixture.provider.requestCount, 2, "the legacy completion consumes a decision and a settling response");
    acknowledgeGoalBatch(positiveFixture, `${positiveLabel}: completed`);

    // Restart equivalence: a fresh in-process session seeded with the completed state must open with the tool inactive.
    await seedFreshSession(positiveFixture, `${positiveLabel}-reopen`, completedState, "complete");
    await promptGoalCommand(positiveFixture, "/fixture-reload", `${positiveLabel}: reopen reload`);
    events = readProbeEvents(positiveFixture.observerPath, positiveLabel);
    const reopenStart = events.filter((event) => event.type === "session_start").at(-1);
    assert.equal(stringField(reopenStart!, "reason"), "reload");
    assert.deepEqual(reopenStart?.activeTools ?? [], [], "the completed goal must reopen with the goal tool inactive");
    assert.equal(positiveFixture.provider.requestCount, 2, "the reopen must not make a provider request");
    acknowledgeGoalBatch(positiveFixture, `${positiveLabel}: reopen reload`);

    const ordinaryCursor = positiveFixture.rpc!.currentSequence;
    positiveFixture.provider.queuePlainStop();
    await promptOrdinaryRun(positiveFixture, "Summarize the completed work without starting another goal.", `${positiveLabel}: ordinary`);
    const ordinaryRequest = await positiveFixture.provider.waitForRequest(3, signal);
    assert.doesNotMatch(JSON.stringify(ordinaryRequest.body.tools ?? []), /"name":"killeros_goal_update"/u,
      "a later ordinary request must not declare completion for an already completed goal");
    await waitForGoalSettled(positiveFixture, ordinaryCursor, `${positiveLabel}: ordinary settlement`);
    events = readProbeEvents(positiveFixture.observerPath, positiveLabel);
    assert.equal(events.filter(event => event.type === "agent_settled").at(-1)?.hold, false,
      "the completed goal tool remains inactive through the later ordinary request");
    const ordinaryEntries = savedGoalEntries(await goalEntriesOf(positiveFixture));
    assert.deepEqual(ordinaryEntries.map(entry => entry.event), ["complete"], "ordinary work appends no goal accounting");
    assert.deepEqual(ordinaryEntries[0]?.state, completedState, "ordinary work preserves the completed state");
    acknowledgeGoalBatch(positiveFixture, `${positiveLabel}: ordinary`);
    observations.push(await closeRpcFixture(positiveFixture, positiveLabel, 3));
  } catch (error) {
    throw new AggregateError([error, ...await failedRpcCleanup(positiveFixture, positiveLabel)], `${positiveLabel}: fixture failed`);
  }

  const zeroLabel = "rpc-legacy-zero-turn";
  const zeroFixture = await createBlockedGoalRpcFixture(artifactDirectory, zeroLabel, signal, {
    seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: zeroTurns } }],
  });
  try {
    await initializeBlockedGoalFixture(zeroFixture, zeroLabel);
    const cursor = zeroFixture.rpc!.currentSequence;
    zeroFixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: "Audited legacy objective" } }]);
    await promptOrdinaryRun(zeroFixture, "Inspect the legacy zero-turn goal and record completion if appropriate.", `${zeroLabel}: attempt`);
    await waitForGoalSettled(zeroFixture, cursor, `${zeroLabel}: rejection settlement`);
    const results = goalToolResults(await goalEntriesOf(zeroFixture));
    toolResultError(results, /zero-turn blocked goal/u, `${zeroLabel}: rejection`);
    const entries = savedGoalEntries(await goalEntriesOf(zeroFixture));
    assert.equal(entries.length, 1, "the zero-turn rejection must append no goal event");
    assert.deepEqual(entries[0]?.state, zeroTurns, "the zero-turn state must survive byte-equal");
    assert.equal(zeroFixture.provider.requestCount, 2, "the zero-turn closure consumes a decision and a settling response");
    acknowledgeGoalBatch(zeroFixture, `${zeroLabel}: rejected`);
    observations.push(await closeRpcFixture(zeroFixture, zeroLabel, 2));
  } catch (error) {
    throw new AggregateError([error, ...await failedRpcCleanup(zeroFixture, zeroLabel)], `${zeroLabel}: fixture failed`);
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Scenario 2: goals.blocked-races.
// ---------------------------------------------------------------------------

type RaceContext = {
  fixture: BlockedGoalFixture;
  label: string;
  target: string;
  seed: RecordValue;
  signal: AbortSignal;
};

function raceBlockedState(target: string, revision = 1): RecordValue {
  const state = blockedFileState(target);
  return blockedState(state, { activeMilliseconds: 1234, maxTurns: 20, revision });
}

/**
 * Parks one verified completion at the real child-side open barrier. With
 * `settleAfterRelease` the trailing settling response is planned (normal races);
 * abort-family vectors omit it because the run never reaches the model again.
 */
async function parkParkedCompletion(
  fixture: BlockedGoalFixture,
  target: string,
  label: string,
  evidence = "Old snapshot",
  settleAfterRelease = true,
): Promise<void> {
  writeFileSync(target, changedContent);
  const parkCall = { name: "killeros_goal_update", args: { status: "complete", evidence } };
  if (settleAfterRelease) fixture.provider.queueCalls([parkCall]); else fixture.provider.queueCallsOnly([parkCall]);
  await promptOrdinaryRun(fixture, "Verify the deliverable and record completion if the whole objective is done.", `${label}: eligible`);
  await waitForPlanJson(path.join(fixture.directory, "verification-acknowledgement.json"), path.join(fixture.directory, "verification-failure.json"), 45_000, `${label}: verification parked`);
  assert.equal(fixture.provider.requestCount, 1, `${label}: the parked completion must hold exactly one provider response`);
}

/** Sends a mid-run prompt without awaiting its response (the response arrives only after the handler completes). */
async function sendMidRunPrompt(fixture: BlockedGoalFixture, text: string, label: string): Promise<PromiseOutcome<RecordValue>> {
  const after = fixture.rpc!.currentSequence;
  await fixture.rpc!.send({ id: `mid-${after}`, type: "prompt", message: text });
  return await outcome((async () => {
    const response = await fixture.rpc!.waitFor(
      (entry) => entry.type === "response" && entry.id === `mid-${after}`,
      { after, timeoutMs: 90_000, signal: fixture.signal },
    );
    return record(response, `${label} response`);
  })());
}

/** Polls the probe observer for the first matching event; same acknowledgement-file sync style as waitForPlanJson. */
async function waitForProbeEvent(
  fixture: Pick<BlockedGoalFixture, "directory" | "observerPath">,
  predicate: (event: RecordValue) => boolean,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failurePath = path.join(fixture.directory, "verification-failure.json");
    if (existsSync(failurePath)) {
      const failure = record(parseJson(readFileSync(failurePath, "utf8")));
      throw new Error(`${label}: child-side barrier failed during ${stringField(failure, "operation")}: ${stringField(failure, "message")}`);
    }
    const event = readProbeEvents(fixture.observerPath, label).find(predicate);
    if (event) return event;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${label} probe event`);
    await sleep(10, undefined, { signal });
  }
}

function verifyBarrierPaths(fixture: BlockedGoalFixture): { acknowledgement: string; release: string; failure: string; status: string } {
  return {
    acknowledgement: path.join(fixture.directory, "verification-acknowledgement.json"),
    release: path.join(fixture.directory, "verification-release"),
    failure: path.join(fixture.directory, "verification-failure.json"),
    status: path.join(fixture.directory, "verification-status.json"),
  };
}

function assertRejectedCompletion(
  entries: RecordValue[],
  label: string,
  expectedMessage: RegExp,
  expectedLastEvent: string,
  expectLastState: unknown = undefined,
): void {
  const goalEntries = savedGoalEntries(entries);
  assert.equal(goalEntries.filter((entry) => entry.event === "complete").length, 0, `${label}: no complete event must be appended`);
  const last = lastSavedGoal(goalEntries, label);
  assert.equal(last.event, expectedLastEvent, `${label}: the last goal event after invalidation`);
  if (expectLastState !== undefined) assert.deepEqual(last.state, expectLastState, `${label}: the last goal state`);
  const rejection = goalToolResults(entries).find((result) => result.isError && expectedMessage.test(result.text));
  assert.ok(rejection, `${label}: the rejected completion must carry the invalidation error\nobserved: ${JSON.stringify(goalToolResults(entries).map((result) => result.text.slice(0, 200)))}`);
}

function assertCompletedGoal(entries: RecordValue[], label: string, evidence = "Old snapshot"): RecordValue {
  const goalEntries = savedGoalEntries(entries);
  assert.equal(goalEntries.filter((entry) => entry.event === "complete").length, 1, `${label}: exactly one complete event`);
  const completed = record(savedGoalEvent(goalEntries, "complete", label).state ?? {}, `${label}: completed state`);
  assert.equal(completed.status, "complete");
  assert.equal(record(completed.lastDecision ?? {}, `${label}: completed decision`).evidence, evidence);
  return completed;
}

// Catalog ID: goals.blocked-races.
test(`${racesCatalogId}: blocked completion stays single-owner across mutations and retries`, { timeout: 175_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  const divergences: string[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-races-");

    await runMutationRaceVector(t.signal, artifactDirectory, observations, "replace", async (ctx) => {
      // Replacement waits for idle while completion owns the parked verification.
      // Completion changes the captured state, invalidating the pending replacement.
      const replaceOutcome = sendMidRunPrompt(ctx.fixture, "/goal Replacement objective", `${ctx.label}: replace prompt`);
      const confirmation = await ctx.fixture.rpc!.waitFor(
        (entry) => entry.type === "extension_ui_request" && entry.method === "confirm",
        { after: ctx.fixture.acknowledgedSequence, timeoutMs: 60_000, signal: ctx.signal },
      );
      assert.equal(record(confirmation, `${ctx.label}: confirm`).title, "Replace active goal",
        "the replacement of an unfinished goal must require confirmation");
      await ctx.fixture.rpc!.send({ type: "extension_ui_response", id: stringField(confirmation, "id"), confirmed: true });
      writeReleaseFile(verifyBarrierPaths(ctx.fixture).release, `${ctx.label}: release`);
      await waitForGoalSettled(ctx.fixture, ctx.fixture.acknowledgedSequence, `${ctx.label}: settlement before replace persistence`);
      const replaceResponse = await replaceOutcome;
      if (replaceResponse.kind === "rejected") throw replaceResponse.error;
      assert.equal(record(replaceResponse.value.data ?? replaceResponse.value, `${ctx.label}: replace prompt response`).disposition, "handled");
      const goalEntries = await goalEntriesOf(ctx.fixture);
      divergences.push(
        `${ctx.label}: completion lands before idle and invalidates the stale confirmed replacement`,
      );
      assert.equal(savedGoalEntries(goalEntries).filter((entry) => entry.event === "complete").length, 1,
        `${ctx.label}: the confirmed replacement cannot invalidate an in-flight verification; completion lands first (documented divergence)`);
      assert.equal(savedGoalEntries(goalEntries).some((entry) => entry.event === "replace"), false,
        `${ctx.label}: completion must invalidate the stale confirmed replacement`);
      const completedState = assertCompletedGoal(goalEntries, ctx.label);
      assert.equal(completedState.objective, ctx.seed.objective, "the original objective must survive the stale replacement");
      assertGoalIdle(await goalState(ctx.fixture), `${ctx.label}: stale replacement released`);
      return { divergence: "completion invalidates stale replacement" };
    });
    await runMutationRaceVector(t.signal, artifactDirectory, observations, "session_tree", async (ctx) => {
      const entries = savedGoalEntries(await goalEntriesOf(ctx.fixture));
      const blockedEntryId = lastSavedGoal(entries, `${ctx.label}: blocked entry`).id;
      const navigationOutcome = await sendMidRunPrompt(ctx.fixture, `/fixture-goal-tree navigate ${blockedEntryId}`, `${ctx.label}: navigation`);
      const navigationEvent = await waitForProbeEvent(ctx.fixture,
        (event) => event.type === "navigation_result", 45_000, `${ctx.label}: the refused mid-run navigation attempt`);
      assert.equal(stringField(navigationEvent, "outcome"), "rejected",
        "Pi must refuse committed tree navigation while the response streams");
      assert.equal(stringField(navigationEvent, "message"),
        "Wait for the current response to finish before navigating the session tree.",
        "the refusal must quote Pi's busy-navigation error verbatim");
      const observedEvents = readProbeEvents(ctx.fixture.observerPath, ctx.label);
      assert.equal(probeEventCount(observedEvents, "session_before_tree"), 0, "a refused navigation must not reach the cancellable tree hook");
      assert.equal(probeEventCount(observedEvents, "session_tree"), 0, "a refused navigation must not commit a tree move");
      writeReleaseFile(verifyBarrierPaths(ctx.fixture).release, `${ctx.label}: release`);
      await waitForGoalSettled(ctx.fixture, ctx.fixture.acknowledgedSequence, `${ctx.label}: settlement`);
      const navigationResponse = navigationOutcome;
      if (navigationResponse.kind === "rejected") throw navigationResponse.error;
      divergences.push(`${ctx.label}: this mid-run navigation was refused before session_tree; the pending completion survives`);
      assertCompletedGoal(await goalEntriesOf(ctx.fixture), `${ctx.label}: preserved completion`);
      return { divergence: "session_tree commit refused while streaming" };
    });

    // Vector 8: refused navigation followed by an abort rejects the pending completion.
    await runMutationRaceVector(t.signal, artifactDirectory, observations, "cancelled-navigation", async (ctx) => {
      const entries = savedGoalEntries(await goalEntriesOf(ctx.fixture));
      const blockedEntryId = lastSavedGoal(entries, `${ctx.label}: blocked entry`).id;
      const _navigationOutcome = await sendMidRunPrompt(ctx.fixture, `/fixture-goal-tree navigate ${blockedEntryId}`, `${ctx.label}: navigation`);
      const navigationEvent = await waitForProbeEvent(ctx.fixture,
        (event) => event.type === "navigation_result", 45_000, `${ctx.label}: the refused navigation attempt`);
      assert.equal(stringField(navigationEvent, "outcome"), "rejected",
        "the navigation attempt must be refused while the verification is parked");
      const observedEvents = readProbeEvents(ctx.fixture.observerPath, ctx.label);
      assert.equal(probeEventCount(observedEvents, "session_tree"), 0,
        "no session_tree notification may commit before the cancellation");
      // Real Pi accepts the RPC abort even after the refused navigation; the parked tool
      // is observed through the probe's signal acknowledgement before the barrier releases.
      const abortOutcome = outcome(goalRpcCommand(ctx.fixture, "abort", {}, 60_000));
      await waitForProbeEvent(ctx.fixture, (event) => event.type === "goal_signal_aborted", 60_000,
        `${ctx.label}: the probe acknowledgement that the run signal fired`);
      writeReleaseFile(verifyBarrierPaths(ctx.fixture).release, `${ctx.label}: release`);
      const settled = await abortOutcome;
      if (settled.kind === "rejected") throw settled.error;
      assert.equal(settled.value.success, true, `${ctx.label}: the abort command must succeed`);
      await waitForGoalSettled(ctx.fixture, ctx.fixture.acknowledgedSequence, `${ctx.label}: settlement`);
      toolResultError(goalToolResults(await goalEntriesOf(ctx.fixture)), /This operation was aborted/u,
        `${ctx.label}: the cancelled verification must surface Pi's abort error`);
      const durableEvents = await goalEntriesOf(ctx.fixture);
      assert.equal(savedGoalEntries(durableEvents).filter((entry) => entry.event === "complete").length, 0,
        `${ctx.label}: the cancelled completion must append no complete event`);
      assert.equal(lastSavedGoal(savedGoalEntries(durableEvents), `${ctx.label}: durable`).event, "blocked",
        `${ctx.label}: the blocked state must stay last after the cancellation`);
      return { outcome: "aborted" };
    });

    // Vector: shutdown during the parked verification; the durable session stays blocked and
    // the child exits naturally. shutdownTargets feeds the later reopen control launch.
    const shutdownTargets = await runParkedShutdownFixture(t.signal, artifactDirectory, observations, divergences);

    // Vector 10: run the independent shutdown reopen control before the corrupt-session recovery.
    await runRecoveryFixture(t.signal, artifactDirectory, observations, "shutdown-reopen",
      shutdownTargets, async (fixture, label, target, _seed) => {
        const durable = savedGoalEntriesFromSessionFile(fixture.currentSessionFile, `${label}: durable`);
        assert.equal(durable.filter((entry) => entry.event === "complete").length, 0, "shutdown must not have appended a complete event");
        assert.equal((durable.at(-1)?.event), "blocked", "shutdown must leave the blocked state last");
        writeFileSync(target, changedContent);
        const cursor = fixture.rpc!.currentSequence;
        fixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: "Reopened and verified" } }]);
        await promptOrdinaryRun(fixture, "Verify the deliverable and record completion if the whole objective is done.", `${label}: reopen`);
        await waitForGoalSettled(fixture, cursor, `${label}: settlement`);
        assertCompletedGoal(await goalEntriesOf(fixture), label, "Reopened and verified");
        return { reopened: true };
      });

    assert.equal(observations.length, 5, "the replacement, navigation, and shutdown histories use five Pi launches");
    assert.equal(divergences.length, 3, "the documented limits are replacement timing, mid-run tree refusal, and quit teardown");
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must stay writable");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
    writeRunsJournal(racesCatalogId, observations, { divergences });
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
  } catch (error) {
    failure = error;
    writeRunsJournal(racesCatalogId, observations, { status: "failed", divergences });
    t.diagnostic(`Partial launch evidence: ${evidenceDirectory}`);
    if (artifactDirectory) try {
      throwScenarioFailure({
        directory: artifactDirectory,
        message: `${racesCatalogId}: blocked goal races failed`,
        errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))],
        diagnostics: (error instanceof AggregateError ? error.message : errorText(error)).slice(0, 30_000),
      });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory) && process.env.KILLEROS_KEEP_ARTIFACTS !== "1") try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${racesCatalogId}: artifact cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

test(`${racesCatalogId}: clear resume and reload invalidate pending completion`, { timeout: 100_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-mutations-");
    // Clear, resume, and reload each own a process, session, and deliverable file.
    await runMutationRaceVector(t.signal, artifactDirectory, observations, "clear", async (ctx) => {
      const outcomeData = await promptGoalCommand(ctx.fixture, "/goal clear", `${ctx.label}: clear`);
      assert.equal(outcomeData.disposition, "handled", `${ctx.label}: the clear prompt must be handled while parked`);
      await expectedGoalNotification(ctx.fixture, ctx.fixture.acknowledgedSequence, "Goal cleared", "info", `${ctx.label}: clear notify`);
      writeReleaseFile(verifyBarrierPaths(ctx.fixture).release, `${ctx.label}: release`);
      await waitForGoalSettled(ctx.fixture, ctx.fixture.acknowledgedSequence, `${ctx.label}: settlement after clear`);
      assertRejectedCompletion(await goalEntriesOf(ctx.fixture), ctx.label,
        /Goal changed while completion was being verified/u, "clear", null);
      return { divergence: "none" };
    });
    await runMutationRaceVector(t.signal, artifactDirectory, observations, "resume", async (ctx) => {
      const outcomeData = await promptGoalCommand(ctx.fixture, "/goal resume", `${ctx.label}: resume`);
      assert.equal(outcomeData.disposition, "handled", `${ctx.label}: the resume prompt must be handled while parked`);
      // Resume authorizes a fresh turn after the parked ordinary request settles.
      // A decisionless response must pause that turn rather than continue indefinitely.
      ctx.fixture.provider.queuePlainStop();
      writeReleaseFile(verifyBarrierPaths(ctx.fixture).release, `${ctx.label}: release`);
      await ctx.fixture.rpc!.waitFor(event => event.type === "agent_settled", {
        after: ctx.fixture.acknowledgedSequence, signal: ctx.signal, timeoutMs: 15_000,
      });
      assert.equal(savedGoalEntries(await goalEntriesOf(ctx.fixture)).filter(entry => entry.event === "complete").length, 0,
        "A stale blocked completion cannot complete the resumed goal before its authorized turn settles");
      await waitForGoalSettlements(ctx.fixture, ctx.fixture.acknowledgedSequence, 2, `${ctx.label}: settlement after resume`);
      assertGoalIdle(await goalState(ctx.fixture), `${ctx.label}: resumed turn settled`);
      assertRejectedCompletion(await goalEntriesOf(ctx.fixture), ctx.label,
        /Goal changed while completion was being verified/u, "error");
      const resumedState = record(lastSavedGoal(savedGoalEntries(await goalEntriesOf(ctx.fixture)), `${ctx.label}: resumed`).state ?? {}, "resumed state");
      assert.equal(resumedState.status, "paused", "the resumed decisionless turn must pause after settlement");
      assert.equal(resumedState.maxTurns, 20, "resume below the saved limit must preserve maxTurns");
      assert.equal(resumedState.turns, 4, "explicit resume must grant exactly one new turn");
      assert.equal(resumedState.result, "no turn decision", "the decisionless resumed turn must stop for the expected reason");
      return { divergence: "none" };
    });
    await runMutationRaceVector(t.signal, artifactDirectory, observations, "session_start", async (ctx) => {
      // Observe committed shutdown before releasing file verification, so the stale
      // completion cannot win merely because the reload command has not run yet.
      const reloadOutcome = sendMidRunPrompt(ctx.fixture, "/fixture-reload", `${ctx.label}: reload prompt`);
      await waitForProbeEvent(ctx.fixture,
        (event) => event.type === "session_shutdown" && event.reason === "reload", 45_000, `${ctx.label}: reload shutdown`);
      writeReleaseFile(verifyBarrierPaths(ctx.fixture).release, `${ctx.label}: release`);
      const reloadResponse = await reloadOutcome;
      if (reloadResponse.kind === "rejected") throw reloadResponse.error;
      assert.equal(record(reloadResponse.value.data ?? reloadResponse.value, `${ctx.label}: reload prompt response`).disposition, "handled");
      await waitForGoalSettled(ctx.fixture, ctx.fixture.acknowledgedSequence, `${ctx.label}: settlement during reload`);
      toolResultError(goalToolResults(await goalEntriesOf(ctx.fixture)), /Goal changed while completion was being verified/u,
        `${ctx.label}: committed reload must reject the stale verified completion`);
      assert.equal(savedGoalEntries(await goalEntriesOf(ctx.fixture)).filter((entry) => entry.event === "complete").length, 0,
        `${ctx.label}: the reload must append no complete event`);
      const settledProbe = readProbeEvents(ctx.fixture.observerPath, ctx.label);
      const shutdown = settledProbe.filter((event) => event.type === "session_shutdown").at(-1);
      assert.ok(shutdown, `${ctx.label}: the reload must deliver a real session_shutdown`);
      assert.equal(stringField(shutdown, "reason"), "reload");
      const startEvent = settledProbe.filter((event) => event.type === "session_start").at(-1);
      assert.ok(startEvent, `${ctx.label}: the reload must deliver a real session_start`);
      assert.equal(stringField(startEvent, "reason"), "reload", "the reload must deliver a real session_start");
      const restored = record(lastSavedGoal(savedGoalEntries(await goalEntriesOf(ctx.fixture)), `${ctx.label}: restored`).state ?? {}, "restored state");
      assert.equal(restored.status, "blocked", "the reload must restore the seeded blocked goal");
      return { divergence: "none" };
    });
    assert.equal(observations.length, 3, "clear, resume, and reload use three Pi launches");
    writeRunsJournal(`${racesCatalogId}.mutations`, observations);
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
  } catch (error) {
    failure = error;
    writeRunsJournal(`${racesCatalogId}.mutations`, observations, { status: "failed" });
    t.diagnostic(`Partial launch evidence: ${evidenceDirectory}`);
    if (artifactDirectory) try {
      throwScenarioFailure({ directory: artifactDirectory, message: `${racesCatalogId}: mutation histories failed`, errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))], diagnostics: "" });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory) && process.env.KILLEROS_KEEP_ARTIFACTS !== "1") try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${racesCatalogId}: mutation cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

test(`${racesCatalogId}: competing model completions record one terminal event`, { timeout: 60_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-competing-");
    await runAllAtOnceFixture(t.signal, artifactDirectory, observations, "competing-attempts",
      async (fixture, label, target, seed) => {
        writeFileSync(target, changedContent);
        fixture.provider.queueCalls([
          { name: "killeros_goal_update", args: { status: "complete", evidence: "Whole objective checked" } },
          { name: "killeros_goal_update", args: { status: "complete", evidence: "Whole objective checked" } },
        ]);
        const cursor = fixture.rpc!.currentSequence;
        await promptOrdinaryRun(fixture, "Verify the deliverable and record completion if the whole objective is done.", `${label}: eligible`);
        await waitForGoalSettled(fixture, cursor, `${label}: settlement`);
        const entries = await goalEntriesOf(fixture);
        const results = goalToolResults(entries);
        assert.equal(results.filter((result) => !result.isError).length, 1, `${label}: one fulfilled result`);
        assert.equal(results.filter((result) => result.isError).length, 1, `${label}: one rejection`);
        assert.equal(results[1]?.isError, true, `${label}: the later decision must reject`);
        assert.match(results[1]?.text ?? "", /no active/iu, `${label}: the completed goal must reject a second decision`);
        const completed = assertCompletedGoal(entries, label, "Whole objective checked");
        assert.equal(completed.objective, seed.objective, `${label}: completion must retain the blocked objective`);
        assert.equal(completed.turns, seed.turns, `${label}: completion must not grant a goal turn`);
        return { fulfilled: results[0]?.text ?? "" };
      });
    assert.equal(observations.length, 1, "competing model decisions use one Pi launch");
    writeRunsJournal(`${racesCatalogId}.competing`, observations);
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
  } catch (error) {
    failure = error;
    writeRunsJournal(`${racesCatalogId}.competing`, observations, { status: "failed" });
    t.diagnostic(`Partial launch evidence: ${evidenceDirectory}`);
    if (artifactDirectory) try {
      throwScenarioFailure({ directory: artifactDirectory, message: `${racesCatalogId}: competing completions failed`, errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))], diagnostics: "" });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory) && process.env.KILLEROS_KEEP_ARTIFACTS !== "1") try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${racesCatalogId}: competing completion cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

test(`${racesCatalogId}: failed completion append permits same-process retry`, { timeout: 90_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-append-retry-");
    await runAppendFaultFixture(t.signal, artifactDirectory, observations, "failed-append", "live");
    assert.equal(observations.length, 1, "the live append and retry history uses one Pi launch");
    writeRunsJournal(`${racesCatalogId}.append-retry`, observations);
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
  } catch (error) {
    failure = error;
    writeRunsJournal(`${racesCatalogId}.append-retry`, observations, { status: "failed" });
    t.diagnostic(`Partial launch evidence: ${evidenceDirectory}`);
    if (artifactDirectory) try {
      throwScenarioFailure({ directory: artifactDirectory, message: `${racesCatalogId}: append retry failed`, errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))], diagnostics: "" });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory) && process.env.KILLEROS_KEEP_ARTIFACTS !== "1") try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${racesCatalogId}: append retry artifact cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

test(`${racesCatalogId}: failed completion snapshot fails closed on reopen`, { timeout: 100_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const observations: LaunchObservation[] = [];
  const divergences: string[] = [];
  let artifactDirectory = "";
  let failure: unknown;
  try {
    artifactDirectory = createArtifactDirectory("killeros-blocked-goal-append-");
    const appendFaultTargets = await runAppendFaultFixture(t.signal, artifactDirectory, observations, "failed-append", "seeded");

    // Pi advances its leaf before a failed append; reopening that orphan must fail closed.
    await runRecoveryFixture(t.signal, artifactDirectory, observations, "retry-after-recovery",
      appendFaultTargets, async (fixture, label, target, _seed) => {
        writeFileSync(target, changedContent);
        const restoredEntries = savedGoalEntries(await goalEntriesOf(fixture));
        assert.equal(restoredEntries.at(-1)?.event, "blocked", "the recovered session must still last-block");
        assert.equal(restoredEntries.filter((entry) => entry.event === "complete").length, 0, "no complete event can exist after the failed append");
        fixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: acceptanceEvidence } }]);
        const cursor = fixture.rpc!.currentSequence;
        await promptOrdinaryRun(fixture, "The storage recovered; verify the deliverable and record completion.", `${label}: retry`);
        await waitForGoalSettled(fixture, cursor, `${label}: settlement`);
        const entries = await goalEntriesOf(fixture);
        toolResultError(goalToolResults(entries), /^Tool killeros_goal_update not found$/u,
          `${label}: an unreachable blocked ancestor must not authorize completion`);
        assert.equal(savedGoalEntriesFromSessionFile(fixture.currentSessionFile, `${label}: durable after retry`)
          .filter((entry) => entry.event === "complete").length, 0,
        `${label}: the orphaned snapshot must append no completion`);
        const branch = SessionManager.open(fixture.currentSessionFile).getBranch();
        assert.equal(branch.some((entry) => entry.type === "custom" && entry.customType === "killeros-goal"), false,
          `${label}: the missing persisted parent must keep the blocked ancestor outside the active branch`);
        divergences.push(`${label}: Pi's failed disk append leaves an orphaned branch; fresh reopen denies completion while same-process retry succeeds`);
        return { recovered: false, upstreamLimit: "Pi 1.4.0 advances its leaf before a failed disk append" };
      });

    assert.equal(observations.length, 2, "the append and reopen histories use two Pi launches");
    assert.equal(divergences.length, 1, "the failed snapshot reopen limitation must be recorded");
    writeRunsJournal(`${racesCatalogId}.append-reopen`, observations, { divergences });
    assert.deepEqual(evidenceWriteProblems, [], "the evidence journal must be saved");
    t.diagnostic(`Launch evidence: ${evidenceDirectory}`);
  } catch (error) {
    failure = error;
    writeRunsJournal(`${racesCatalogId}.append-reopen`, observations, { status: "failed", divergences });
    t.diagnostic(`Partial launch evidence: ${evidenceDirectory}`);
    if (artifactDirectory) try {
      throwScenarioFailure({ directory: artifactDirectory, message: `${racesCatalogId}: append reopen failed`, errors: [error, ...evidenceWriteProblems.map((message) => new Error(message))], diagnostics: "" });
    } catch (reportError) { failure = reportError; }
  } finally {
    if (artifactDirectory && existsSync(artifactDirectory) && process.env.KILLEROS_KEEP_ARTIFACTS !== "1") try {
      await removeArtifactDirectory(artifactDirectory);
    } catch (error) {
      throw new AggregateError(failure === undefined ? [error] : [failure, error], `${racesCatalogId}: append artifact cleanup failed`);
    }
  }
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure), { cause: failure });
});

/** Per-catalog mutation-race profile: how the parked run ends and how many provider requests prove it. */
const raceMutationProfiles: Record<string, { expectedRequests: number; settleAfterRelease: boolean }> = {
  clear: { expectedRequests: 2, settleAfterRelease: true },
  resume: { expectedRequests: 3, settleAfterRelease: true },
  replace: { expectedRequests: 2, settleAfterRelease: true },
  // Reload invalidates completion but lets the ordinary request settle once.
  session_start: { expectedRequests: 2, settleAfterRelease: true },
  // Explicit cancellation discards the parked run without a settling model turn.
  "cancelled-navigation": { expectedRequests: 1, settleAfterRelease: false },
  session_tree: { expectedRequests: 2, settleAfterRelease: true },
};

/** Creates one verification-barrier mutation race with one fixture and closes it even on failure. */
async function runMutationRaceVector(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
  launch: string,
  runVector: (context: RaceContext) => Promise<RecordValue>,
): Promise<void> {
  const label = `race-${launch}`;
  const profile = raceMutationProfiles[launch];
  assert.ok(profile, `${label}: every mutation race needs a planned profile`);
  const target = path.join(artifactDirectory, `${label}-target.md`);
  writeFileSync(target, originalContent);
  const seed = raceBlockedState(target);
  const featureFixture = await createBlockedGoalRpcFixture(artifactDirectory, label, signal, {
    seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: seed } }],
    plan: {
      status: path.join(artifactDirectory, label, "fixture-status.json"),
      verification: {
        target,
        holdCall: 1,
        acknowledgement: path.join(artifactDirectory, label, "verification-acknowledgement.json"),
        release: path.join(artifactDirectory, label, "verification-release"),
        status: path.join(artifactDirectory, label, "verification-status.json"),
        failure: path.join(artifactDirectory, label, "verification-failure.json"),
        waitTimeoutMs: 60_000,
      },
    },
  });
  const paths = verifyBarrierPaths(featureFixture);
  try {
    await initializeBlockedGoalFixture(featureFixture, label);
    await parkParkedCompletion(featureFixture, target, label, "Old snapshot", profile.settleAfterRelease);
    const vectorResult = await runVector({
      fixture: featureFixture,
      label,
      target,
      seed,
      signal,
    });
    assert.ok(vectorResult, `${label}: vector must return an observation`);
    const observation = await closeRpcFixture(featureFixture, label, profile.expectedRequests);
    observations.push(observation);
    await closeBlockedFixtureCompletely(featureFixture, label, observation);
  } catch (error) {
    const diagnostics = featureFixture.rpc?.diagnostics() ?? "RPC not started";
    const cleanup = await failedRpcCleanup(featureFixture, label, { release: paths.release, remove: true });
    throw new AggregateError([error, ...cleanup], `${label}: mutation race failed: ${errorText(error)}\n${diagnostics}`);
  }
}

/** Creates a non-parked races fixture for the competing-attempts vector. */
async function runAllAtOnceFixture(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
  launch: string,
  runVector: (fixture: BlockedGoalFixture, label: string, target: string, seed: RecordValue) => Promise<RecordValue>,
): Promise<void> {
  const label = `race-${launch}`;
  const target = path.join(artifactDirectory, `${label}-target.md`);
  writeFileSync(target, originalContent);
  const seed = raceBlockedState(target);
  const fixture = await createBlockedGoalRpcFixture(artifactDirectory, label, signal, {
    seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: seed } }],
  });
  try {
    await initializeBlockedGoalFixture(fixture, label);
    await runVector(fixture, label, target, seed);
    const observation = await closeRpcFixture(fixture, label, 2);
    observations.push(observation);
    await closeBlockedFixtureCompletely(fixture, label, observation);
  } catch (error) {
    const cleanup = await failedRpcCleanup(fixture, label, { remove: true });
    throw new AggregateError([error, ...cleanup], `${label}: competing attempts failed\n${fixture.rpc?.diagnostics() ?? "RPC not started"}`);
  }
}

/**
 * Shuts the child down through the real stdin end while the completion verification is
 * parked at the open barrier: the runtime disposes (session_shutdown reason "quit")
 * without settling the parked run, the release then lets the abandoned tool unwind, and
 * the child still exits naturally. Copies the durable session out for the reopen control.
 */
async function runParkedShutdownFixture(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
  divergences: string[],
): Promise<RecoveryTargets> {
  const label = "race-parked-shutdown";
  const target = path.join(artifactDirectory, `${label}-target.md`);
  writeFileSync(target, originalContent);
  const seed = raceBlockedState(target);
  const featureFixture = await createBlockedGoalRpcFixture(artifactDirectory, label, signal, {
    seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: seed } }],
    plan: {
      status: path.join(artifactDirectory, label, "fixture-status.json"),
      verification: {
        target,
        holdCall: 1,
        acknowledgement: path.join(artifactDirectory, label, "verification-acknowledgement.json"),
        release: path.join(artifactDirectory, label, "verification-release"),
        status: path.join(artifactDirectory, label, "verification-status.json"),
        failure: path.join(artifactDirectory, label, "verification-failure.json"),
        waitTimeoutMs: 60_000,
      },
    },
  });
  const paths = verifyBarrierPaths(featureFixture);
  try {
    await initializeBlockedGoalFixture(featureFixture, label);
    await parkParkedCompletion(featureFixture, target, label, "Old snapshot", false);
    // stdin end starts the real teardown; the parked tool cannot unwind until the release.
    const closeOutcome = outcome(featureFixture.rpc!.close(90_000));
    await waitForProbeEvent(featureFixture, (event) => event.type === "session_shutdown", 90_000,
      `${label}: the quit teardown while the verification is parked`);
    const lastShutdown = readProbeEvents(featureFixture.observerPath, label)
      .filter((event) => event.type === "session_shutdown").at(-1);
    assert.ok(lastShutdown, `${label}: the probe must record the quit teardown`);
    assert.equal(stringField(lastShutdown, "reason"), "quit",
      `${label}: orderly stdin end must dispose the runtime with the quit reason`);
    writeReleaseFile(paths.release, `${label}: release`);
    const closeResult = await closeOutcome;
    if (closeResult.kind === "rejected") throw closeResult.error;
    assert.equal(closeResult.value.forced, false, `${label}: the parked shutdown must exit naturally without forced process escalation`);
    assert.equal(closeResult.value.exit.code, 0, `${label}: the parked shutdown exit must be clean`);
    assert.equal(closeResult.value.exit.signal, null, `${label}: the parked shutdown must not terminate by signal`);
    assert.equal(closeResult.value.treeCleanupError, undefined, `${label}: parked shutdown cleanup must be confirmed`);
    // The abandoned completion never appends; the durable session stays blocked for the reopen control.
    const durable = savedGoalEntriesFromSessionFile(featureFixture.currentSessionFile, `${label}: durable after shutdown`);
    assert.equal(durable.filter((entry) => entry.event === "complete").length, 0,
      `${label}: the abandoned verification must not append a complete event`);
    assert.equal(durable.at(-1)?.event, "blocked", `${label}: the shutdown must leave the blocked state last`);
    divergences.push(`${label}: the quit teardown abandons the parked verification silently instead of the legacy shared veto, leaving the durable state blocked`);
    const reopenSessionFile = path.join(artifactDirectory, `${label}-reopen-session.jsonl`);
    copyFileSync(featureFixture.currentSessionFile, reopenSessionFile);
    assert.equal(featureFixture.provider.requestCount, 1, `${label}: the parked shutdown consumes exactly one provider request`);
    const observation: LaunchObservation = {
      launch: label,
      providerRequests: featureFixture.provider.requestCount,
      naturalExit: closeResult.value.forced === false,
      exitCode: closeResult.value.exit.code,
    };
    observations.push(observation);
    await featureFixture.provider.close();
    await closeBlockedFixtureCompletely(featureFixture, label, observation);
    return { sessionFile: reopenSessionFile, label };
  } catch (error) {
    const cleanup = await failedRpcCleanup(featureFixture, label, { release: paths.release, remove: true });
    throw new AggregateError([error, ...cleanup], `${label}: parked shutdown failed\n${featureFixture.rpc?.diagnostics() ?? "RPC not started"}`);
  }
}

/** A session file plus its owning launch label, enough for a fresh reopen process. */
type RecoveryTargets = { sessionFile: string; label: string };

async function runAppendFaultFixture(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
  launch: string,
  history: "live" | "seeded",
): Promise<RecoveryTargets> {
  const label = `race-${launch}`;
  const target = path.join(artifactDirectory, `${label}-target.md`);
  writeFileSync(target, originalContent);
  const seededState = history === "seeded" ? raceBlockedState(target) : undefined;
  const faultAck = path.join(artifactDirectory, label, "append-fault-ack.json");
  const fixture = await createBlockedGoalRpcFixture(artifactDirectory, label, signal, {
    ...(seededState ? { seedEntries: [{ customType: "killeros-goal", data: { version: 1, event: "blocked", state: seededState } }] } : {}),
    plan: {
      status: path.join(artifactDirectory, label, "fixture-status.json"),
      appendFault: {
        acknowledgement: faultAck,
        status: path.join(artifactDirectory, label, "append-fault-status.json"),
        failure: path.join(artifactDirectory, label, "append-failure.json"),
      },
    },
  });
  try {
    await initializeBlockedGoalFixture(fixture, label, history === "live" ? 0 : 1);
    if (history === "live") await blockGoalThroughRealTurns(fixture, label, signal, `Fix \`${target}\``);
    const seed = seededState ?? blockGoalState(fixture);
    const originalEntries = await goalEntriesOf(fixture);
    const continuationMessages = (entries: RecordValue[]) => entries.filter((entry) =>
      entry.type === "custom_message" && entry.customType === "killeros-goal-continuation").length;
    const expectedContinuations = history === "live" ? 3 : 0;
    assert.equal(continuationMessages(originalEntries), expectedContinuations, `${label}: initial continuation messages`);
    const resultsBeforeFault = goalToolResults(originalEntries).length;
    // The first completion hits the one-shot filesystem fault.
    fixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: acceptanceEvidence } }]);
    writeFileSync(target, changedContent);
    const faultCursor = fixture.rpc!.currentSequence;
    await promptOrdinaryRun(fixture, "Verify the deliverable and record completion if the whole objective is done.", `${label}: eligible`);
    await waitForGoalSettled(fixture, faultCursor, `${label}: settlement`);
    const failedEntries = await goalEntriesOf(fixture);
    toolResultError(goalToolResults(failedEntries), /Session storage unavailable/u, `${label}: append fault`);
    const failedDurable = savedGoalEntriesFromSessionFile(fixture.currentSessionFile, `${label}: durable`);
    assert.equal(failedDurable.filter((entry) => entry.event === "complete").length, 0,
      "the failed append must not durably record a complete event");
    assert.deepEqual(failedDurable.at(-1)?.state ?? {}, seed, "the failed append must preserve the blocked state verbatim");
    const endEvents = readProbeEvents(fixture.observerPath, label).filter((event) => event.type === "agent_end");
    assert.equal(endEvents.at(-1)?.hold, true, "the failed append must preserve the active goal tool through agent_end");
    assert.equal(existsSync(faultAck), true, `${label}: the owned append fault must acknowledge firing`);
    assert.equal(record(parseJson(readFileSync(path.join(fixture.directory, "append-fault-status.json"), "utf8"))).appendFired, true,
      `${label}: the fixture must report that the planned append fault fired`);
    // Preserve the failed history before retrying so reopen still checks the unresolved native corruption.
    const reopenSessionFile = path.join(artifactDirectory, `${label}-reopen-session.jsonl`);
    copyFileSync(fixture.currentSessionFile, reopenSessionFile);
    acknowledgeGoalBatch(fixture, `${label}: failed append settled`);
    const retryCursor = fixture.rpc!.currentSequence;
    const retryEvidence = "Rechecked after storage recovery";
    fixture.provider.queueCalls([{ name: "killeros_goal_update", args: { status: "complete", evidence: retryEvidence } }]);
    await promptOrdinaryRun(fixture, "Storage recovered; recheck the same blocked objective and record completion.", `${label}: same-process retry`);
    await waitForGoalSettled(fixture, retryCursor, `${label}: same-process retry settlement`);
    const durable = savedGoalEntriesFromSessionFile(fixture.currentSessionFile, `${label}: durable retry`);
    assert.equal(durable.filter((entry) => entry.event === "complete").length, 1, `${label}: exactly one durably accepted completion`);
    const completed = durable.at(-1)?.state;
    assert.equal(completed?.status, "complete");
    assert.equal(completed?.objective, seed.objective);
    assert.equal(completed?.turns, seed.turns, `${label}: retry must not grant a goal turn`);
    assert.equal(completed?.activeMilliseconds, seed.activeMilliseconds);
    assert.equal(record(completed?.lastDecision, `${label}: retry decision`).evidence, retryEvidence);
    const retryEntries = await goalEntriesOf(fixture);
    const results = goalToolResults(retryEntries).slice(resultsBeforeFault);
    assert.equal(results.length, 2, `${label}: exactly two model completion attempts`);
    assert.deepEqual(results.map((result) => result.isError), [true, false]);
    assert.equal(continuationMessages(retryEntries), expectedContinuations, `${label}: failure and retry must not grant another goal turn`);
    const observation = await closeRpcFixture(fixture, label, history === "live" ? 10 : 4);
    observations.push(observation);
    await closeBlockedFixtureCompletely(fixture, label, observation);
    return { sessionFile: reopenSessionFile, label };
  } catch (error) {
    const cleanup = await failedRpcCleanup(fixture, label, { remove: true });
    throw new AggregateError([error, ...cleanup], `${label}: append fault failed\n${fixture.rpc?.diagnostics() ?? "RPC not started"}`);
  }
}

async function runRecoveryFixture(
  signal: AbortSignal,
  artifactDirectory: string,
  observations: LaunchObservation[],
  launch: string,
  source: RecoveryTargets,
  runVector: (fixture: BlockedGoalFixture, label: string, target: string, seed: RecordValue) => Promise<RecordValue>,
): Promise<void> {
  const label = `race-${launch}`;
  const target = path.join(artifactDirectory, `${source.label}-target.md`);
  assert.equal(existsSync(source.sessionFile), true, `${label}: the closed session must still be on disk for the reopen process`);
  const durable = savedGoalEntriesFromSessionFile(source.sessionFile, `${label}: reopen durable`);
  const seed = durable.at(-1)?.state ?? {};
  const fixture = await createReopenedFixture(artifactDirectory, label, source.sessionFile, signal);
  try {
    await initializeBlockedGoalFixture(fixture, label, durable.length);
    await runVector(fixture, label, target, seed);
    const observation = await closeRpcFixture(fixture, label, 2);
    observations.push(observation);
    await closeBlockedFixtureCompletely(fixture, label, observation);
  } catch (error) {
    const cleanup = await failedRpcCleanup(fixture, label, { remove: true });
    throw new AggregateError([error, ...cleanup], `${label}: recovery failed: ${errorText(error)}\n${fixture.rpc?.diagnostics() ?? "RPC not started"}`);
  }
}

/** Reopens one durable saved session file in a fresh process with the same fixture environment. */
async function createReopenedFixture(
  parentDirectory: string,
  label: string,
  sessionFile: string,
  signal: AbortSignal,
): Promise<BlockedGoalFixture> {
  const directory = path.join(parentDirectory, label);
  let ownsDirectory = false;
  let provider: LocalProvider | undefined;
  let rpc: PiRpcProcess | undefined;
  try {
    mkdirSync(directory);
    ownsDirectory = true;
    const agent = path.join(directory, "agent");
    // Keep process-local resources separate while the saved session's original cwd remains available.
    const project = path.join(directory, "project");
    const temporary = path.join(directory, "tmp");
    mkdirSync(agent);
    mkdirSync(project);
    mkdirSync(temporary);
    provider = new LocalProvider();
    await provider.listen();
    writeProviderCatalog(agent, provider);
    const observerPath = path.join(directory, "probe-observer.jsonl");
    const environment = buildFixtureEnvironment(directory, agent, temporary);
    environment.KILLEROS_BLOCKED_GOAL_OBSERVER = observerPath;
    const probePath = path.join(directory, "blocked-goal-probe.ts");
    writeFileSync(probePath, blockedGoalProbeSource(), "utf8");
    const args = [
      "--mode", "rpc",
      "--model", `${goalFixtureProvider}/${goalFixtureModel}`,
      "--thinking", "off",
      "--tools", "killeros_goal_update",
      "--session", sessionFile,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", probePath,
    ];
    rpc = new PiRpcProcess({ cliPath: repositoryCliPath, cwd: project, env: environment, args });
    return {
      directory,
      project,
      sessionFile,
      currentSessionFile: sessionFile,
      provider,
      rpc,
      batches: [],
      acknowledgedSequence: 0,
      observerPath,
      signal,
    };
  } catch (error) {
    const cleanup: unknown[] = [];
    if (rpc) {
      try {
        const closed = await rpc.close();
        if (closed.forced || closed.treeCleanupError !== undefined || closed.exit.code !== 0 || closed.exit.signal !== null) {
          cleanup.push(new Error(`${label}: reopened setup cleanup was not orderly: ${JSON.stringify(closed)}`));
        }
      } catch (closeError) { cleanup.push(closeError); }
    }
    if (provider) try { await provider.close(); } catch (closeError) { cleanup.push(closeError); }
    if (ownsDirectory) try { await removeDirectoryNow(directory); } catch (cleanupError) { cleanup.push(cleanupError); }
    throw new AggregateError([error, ...cleanup], `${label}: reopened fixture setup failed`);
  }
}
