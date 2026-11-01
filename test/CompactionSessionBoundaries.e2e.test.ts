/**
 * End-to-end catalog scenario suite for session and tree boundaries around real
 * automatic compaction recovery.
 *
 * Each catalog ID owns exactly one top-level test:
 * - compaction-session-replacement (RPC, one Pi launch)
 * - compaction-tui-reload-tree (TUI, two Pi launches)
 * - compaction-tui-tree-manual-recovery (TUI, two Pi launches)
 *
 * Every test drives the real installed Pi CLI with a loopback scripted provider
 * and a probe extension that uses only public Pi extension APIs. Private
 * killeros modules are never imported in child code, fixture behavior
 * synchronizes on observed provider requests or acknowledged compaction
 * barriers, and every hold is released in `finally` paths so a failed phase
 * can never retry into a pass. Every cursor handed to `waitForProbe`,
 * `waitForPreparation`, or `settle` is a probe-file line number; RPC and
 * terminal sequence counters are separate spaces and never used as probe
 * cursors.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const evidenceParent = path.join(repositoryRoot, ".pi", "compact-orchestrated-20261027", "c1");
mkdirSync(evidenceParent, { recursive: true });
const evidenceRoot = mkdtempSync(path.join(evidenceParent, "run-"));
const fixtureProvider = "compact-boundaries";
const fixtureKey = "compact-boundaries-local-only";
const contextWindow = 100_000;
const waitTimeoutMs = 60_000;

type Json = Record<string, unknown>;
type Mode = "rpc" | "tui";
type CompactionAction = "custom" | "default";
type Reply =
  | { kind: "text"; content: string; usageTokens?: number }
  | { kind: "goal"; decision: Json; usageTokens?: number }
  | { kind: "write"; filePath: string; content: string; usageTokens?: number }
  | { kind: "error"; status: number; message: string; errorType?: string };
type RequestPlan = Reply | { kind: "held"; barrier: Barrier; response: Reply };
type Barrier = { released: Promise<void>; release(): void };
type ProbeEvent = Json & { sequence: number; type: string };
type ProviderRequest = { index: number; body: Json };
type SeedResult = { file: string; firstUserId: string };
type TwoBranchSeed = SeedResult & { commonAncestorId: string; branchBLeafId: string; branchALeafId: string };
/** Paths of one scenario scratch base; every launch owns its own loopback provider. */
type BasePaths = {
  directory: string;
  project: string;
  agent: string;
  sessions: string;
  planFile: string;
  probeFile: string;
};
type FixtureBase = BasePaths & { sessionA: string; signal: AbortSignal };
type RpcFixture = FixtureBase & FixtureState & { kind: "rpc"; rpc: PiRpcProcess };
type TuiFixture = FixtureBase & FixtureState & { kind: "tui"; terminal: PiTerminalProcess };
type FixtureState = {
  sessionFile: string;
  provider: LocalProvider;
};
type Fixture = RpcFixture | TuiFixture;
type LaunchOptions = { label: string; sessionFile: string; tools: string };
type ScenarioOptions = {
  label: string;
  compactActions: readonly CompactionAction[];
  heldCompactions: readonly number[];
};
type LaunchRecord = { scenarioId: string; label: string; mode: Mode; naturalExit: boolean };
type ScenarioRecord = {
  scenarioId: string;
  label: string;
  launches: LaunchRecord[];
  providerRequests: number;
  naturalExit: boolean;
  scratchRemoved: boolean;
  elapsedMs: number;
};

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
      ? { tool_calls: [{ index: 0, id: `compact-boundary-goal-${observed.index}`, type: "function",
        function: { name: "killeros_goal_update", arguments: JSON.stringify(outcome.decision) } }] }
      : outcome.kind === "write"
        ? { tool_calls: [{ index: 0, id: `compact-boundary-write-${observed.index}`, type: "function",
          function: { name: "write", arguments: JSON.stringify({ path: outcome.filePath, content: outcome.content }) } }] }
        : { content: outcome.content };
    const usage = outcome.kind === "text" || outcome.kind === "goal" || outcome.kind === "write"
      ? outcome.usageTokens === undefined
        ? undefined
        : { prompt_tokens: Math.max(0, outcome.usageTokens - 1), completion_tokens: 1, total_tokens: outcome.usageTokens }
      : undefined;
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.end(`data: ${JSON.stringify({
      id: `compact-boundaries-${observed.index}`,
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

/**
 * Observation and control extension. Sequences and compaction ordinals are
 * derived from the shared probe log (not in-memory counters) so a TUI reload
 * that replaces the runtime resumes the same log without gaps. Held summaries
 * wait at a real gate file; cancel toggles route through one command so the
 * driver can arm a boundary before provoking it. Public APIs only.
 */
const probeExtensionSource = String.raw`import fs from "node:fs";
import path from "node:path";

const probeFile = process.env.KILLEROS_BOUNDARY_PROBE;
const planFile = process.env.KILLEROS_BOUNDARY_PLAN;
if (!probeFile || !planFile) throw new Error("Boundary probe paths are missing");

const armed = { switch: false, fork: false, tree: false };
let lastSequence = 0;

function fileLines() {
  try {
    return fs.readFileSync(probeFile, "utf8").split(/\r?\n/u).filter(Boolean);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function record(type, details = {}) {
  const lines = fileLines();
  if (lines.length < lastSequence) throw new Error("Probe log shrank unexpectedly");
  const sequence = Math.max(lastSequence, lines.length) + 1;
  lastSequence = sequence;
  fs.appendFileSync(probeFile, JSON.stringify({ sequence, type, ...details }) + "\n", "utf8");
}

function compactionOrdinal() {
  return fileLines().filter((line) => line.includes('"type":"session_before_compact"')).length;
}

function publish(name, token) {
  const target = path.join(path.dirname(probeFile), name);
  const temporary = target + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, token + "\n", { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, target);
}

function waitForRelease(name, token) {
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
        if (fs.readFileSync(path.join(path.dirname(probeFile), name), "utf8") === token + "\n") finish();
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") finish(error);
      }
    };
    const watcher = fs.watch(path.dirname(probeFile), { persistent: false }, (_event, filename) => {
      if (filename === null || filename.toString() === name) check();
    });
    watcher.on("error", finish);
    const timer = setTimeout(() => finish(new Error("summary release gate timed out")), 60_000);
    check();
  });
}

function readPlan() {
  try {
    return JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch {
    return {};
  }
}

export default function boundaryProbe(pi) {
  pi.on("session_start", (_event, ctx) => record("session_start", { mode: ctx.mode }));
  pi.on("agent_start", (_event, ctx) => record("agent_start", { mode: ctx.mode }));
  pi.on("message_start", (event) => record("message_start", {
    role: event.message.role,
    customType: event.message.role === "custom" ? event.message.customType : undefined,
    display: event.message.role === "custom" ? event.message.display : undefined,
  }));
  pi.on("turn_end", (event, ctx) => {
    let usageTokens = null;
    try {
      const usage = ctx.getContextUsage();
      if (usage && usage.tokens !== undefined && usage.tokens !== null) usageTokens = usage.tokens;
    } catch (error) {
      record("turn_end_usage_failed", { message: String(error && error.message || error).slice(0, 200) });
    }
    record("turn_end", { turnIndex: event.turnIndex, usageTokens });
  });
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
  pi.on("session_before_switch", (event) => {
    record("session_before_switch", {
      reason: event.reason,
      targetSessionFile: event.targetSessionFile ?? null,
      cancelledByProbe: armed.switch,
    });
    return armed.switch ? { cancel: true } : undefined;
  });
  pi.on("session_before_fork", (event) => {
    record("session_before_fork", {
      entryId: event.entryId,
      position: event.position,
      cancelledByProbe: armed.fork,
    });
    return armed.fork ? { cancel: true } : undefined;
  });
  pi.on("session_before_compact", async (event) => {
    // The plan is re-read per invocation so a relaunched runtime follows the shared plan.
    const plan = readPlan();
    const index = compactionOrdinal() + 1;
    const action = plan.compactActions?.[index - 1] ?? "default";
    const hold = Array.isArray(plan.heldCompactions) && plan.heldCompactions.includes(index);
    const token = "summary-" + index;
    record("session_before_compact", {
      index,
      action,
      reason: event.reason,
      willRetry: event.willRetry,
      tokensBefore: event.preparation.tokensBefore,
      hasSummarizableMessages: event.preparation.messagesToSummarize.length > 0,
    });
    if (hold) {
      const onAbort = () => record("compaction_signal_aborted", { index });
      event.signal.addEventListener("abort", onAbort, { once: true });
      if (event.signal.aborted) onAbort();
      publish(token + ".ack", token);
      try {
        await waitForRelease(token + ".release", token);
      } finally {
        event.signal.removeEventListener("abort", onAbort);
      }
    }
    if (action === "custom") return { compaction: {
      summary: "Fixture summary. Preserve the current goal state and next authorized step.",
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    } };
    return undefined;
  });
  pi.on("session_compact", (event) => record("session_compact", {
    index: compactionOrdinal(),
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
  pi.on("session_before_tree", (event) => {
    record("session_before_tree", {
      targetId: event.preparation.targetId,
      oldLeafId: event.preparation.oldLeafId,
      commonAncestorId: event.preparation.commonAncestorId,
      summarizeCount: event.preparation.entriesToSummarize.length,
      userWantsSummary: event.preparation.userWantsSummary,
      signalAborted: event.signal.aborted,
      cancelledByProbe: armed.tree,
    });
    return armed.tree ? { cancel: true } : undefined;
  });
  pi.on("session_tree", (event) => record("session_tree", {
    newLeafId: event.newLeafId ?? null,
    oldLeafId: event.oldLeafId ?? null,
    summaryEntry: event.summaryEntry ? "present" : null,
  }));
  pi.on("session_shutdown", (event) => record("session_shutdown", {
    reason: event.reason,
    targetSessionFile: event.targetSessionFile ?? null,
  }));
  pi.registerCommand("boundary-armed-cancel", {
    description: "Arm one probe boundary cancellation",
    handler: async (args, _ctx) => {
      const mode = args.trim();
      armed.switch = mode === "switch";
      armed.fork = mode === "fork";
      armed.tree = mode === "tree";
      record("cancel_armed", { mode });
    },
  });
  pi.registerCommand("boundary-navigate", {
    description: "Navigate the session tree to a supplied entry id",
    handler: async (args, ctx) => {
      const targetId = args.trim();
      if (!targetId) {
        ctx.ui.notify("boundary-navigate requires an entry id", "error");
        return;
      }
      try {
        const result = await ctx.navigateTree(targetId, { summarize: false });
        record("navigation_result", { targetId, cancelled: result.cancelled });
      } catch (error) {
        record("navigation_result", {
          targetId,
          failed: String(error && error.message ? error.message : error).slice(0, 400),
        });
      }
    },
  });
  pi.registerCommand("boundary-abort", {
    description: "Abort the active agent run",
    handler: async (_args, ctx) => {
      ctx.abort();
      record("abort_requested", { mode: ctx.mode });
    },
  });
}
`;

function readProbeEvents(filePath: string): ProbeEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean);
  let previous = 0;
  return lines.map((line, index) => {
    const event = record(JSON.parse(line), `probe event ${index + 1}`);
    const sequence = numberField(event, "sequence");
    assert.ok(sequence > previous, `probe sequences must increase (${sequence} after ${previous})`);
    previous = sequence;
    return { ...event, sequence, type: stringField(event, "type") };
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

function isolatedEnvironment(base: BasePaths): NodeJS.ProcessEnv {
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
    KILLEROS_BOUNDARY_PROBE: base.probeFile,
    KILLEROS_BOUNDARY_PLAN: base.planFile,
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

/**
 * Writes the base-level agent configuration and probe surfaces once per
 * scratch base. percentRemaining stays at 15 so a 10k-goal decision turn never
 * arms an eligible turn_end while a 90k turn always does, matching the
 * CompactionGoals next-turn precedent.
 */
function writeBaseConfiguration(base: BasePaths, options: ScenarioOptions): void {
  writeFileSync(path.join(base.agent, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    defaultThinkingLevel: "off",
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
    compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
  }, null, 2), "utf8");
  writeFileSync(path.join(base.agent, "killeros.json"), JSON.stringify({
    autoCompaction: { enabled: true, percentRemaining: 15 },
  }, null, 2), "utf8");
  writeFileSync(base.planFile, JSON.stringify({
    compactActions: options.compactActions,
    heldCompactions: options.heldCompactions,
  }) + "\n", "utf8");
  writeFileSync(base.probeFile, "", "utf8");
  writeFileSync(path.join(base.directory, "boundary-probe.mjs"), probeExtensionSource, "utf8");
}

/** Rewrites models.json per launch so each child talks only to its own loopback provider. */
function writeModelsFile(base: BasePaths, providerUrl: string): void {
  writeFileSync(path.join(base.agent, "models.json"), JSON.stringify({ providers: {
    [fixtureProvider]: {
      api: "openai-completions",
      apiKey: fixtureKey,
      baseUrl: providerUrl,
      models: [{ id: "local", name: "Compaction boundaries local", reasoning: false, input: ["text"],
        contextWindow, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  } }, null, 2), "utf8");
}

/** Seeds a real two-entry conversation so Pi's native compaction eligibility holds on every branch used. */
function seedHistory(project: string, sessions: string, label: string): SeedResult {
  const manager = SessionManager.create(project, sessions);
  const first = manager.appendMessage({
    role: "user",
    content: `Older saved work for ${label}. Retain this verified context.`,
    timestamp: Date.now() - 2_000,
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The older verification is complete." }],
    api: "openai-completions",
    provider: fixtureProvider,
    model: "local",
    stopReason: "stop",
    timestamp: Date.now() - 1_000,
    usage: { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile), "seeded session must be durable before Pi starts");
  assert.ok(first);
  return { file: sessionFile, firstUserId: first };
}

/**
 * Seeds the restored two-branch history for the manual-recovery scenario:
 * a marker goal with a compaction entry on branch A and a separate paused
 * goal without a marker on branch B. The leaf ends on branch A.
 */
function seedTwoBranchSession(project: string, sessions: string): TwoBranchSeed {
  const manager = SessionManager.create(project, sessions);
  const first = manager.appendMessage({ role: "user", content: "Root question saved for both branches.", timestamp: Date.now() - 9_000 });
  const commonAncestor = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The root answer is shared by both branches." }],
    api: "openai-completions",
    provider: fixtureProvider,
    model: "local",
    stopReason: "stop",
    timestamp: Date.now() - 8_000,
    usage: { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  assert.ok(commonAncestor);
  // Branch A: real work, a paused goal with the manual-recovery marker, then a compaction entry as the leaf.
  const branchAUser = manager.appendMessage({ role: "user", content: "Branch A work request.", timestamp: Date.now() - 7_000 });
  assert.ok(branchAUser);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Branch A result is saved." }],
    api: "openai-completions",
    provider: fixtureProvider,
    model: "local",
    stopReason: "stop",
    timestamp: Date.now() - 6_000,
    usage: { input: 2_500, output: 120, cacheRead: 0, cacheWrite: 0, totalTokens: 2_620,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const markerState = {
    version: 1, revision: 7, objective: "Resume the exact saved branch A goal", status: "paused",
    createdAt: Date.now() - 5_000, updatedAt: Date.now() - 4_000, activeMilliseconds: 1_000, turns: 1,
    blockedAuditStartTurn: 0, baselineTokens: 0, resumeAfterManualCompaction: true,
  };
  manager.appendCustomEntry("killeros-goal", { version: 1, event: "pause", state: markerState });
  manager.appendCompaction("Summary A. Preserve the goal state during restored navigation.", branchAUser, 80_000);
  const branchALeafId = manager.getBranch().at(-1)?.id ?? "";
  manager.branch(commonAncestor);
  // Branch B: different work and a separate paused goal without the marker.
  const branchBUser = manager.appendMessage({ role: "user", content: "Branch B work request.", timestamp: Date.now() - 5_000 });
  assert.ok(branchBUser);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Branch B result is saved." }],
    api: "openai-completions",
    provider: fixtureProvider,
    model: "local",
    stopReason: "stop",
    timestamp: Date.now() - 4_000,
    usage: { input: 2_200, output: 90, cacheRead: 0, cacheWrite: 0, totalTokens: 2_290,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const detachedState = { ...markerState, revision: 9, objective: "Resume the exact saved branch B goal", resumeAfterManualCompaction: undefined };
  manager.appendCustomEntry("killeros-goal", { version: 1, event: "pause", state: detachedState });
  const branchBLeafId = manager.getBranch().at(-1)?.id ?? "";
  assert.ok(branchBLeafId);
  // Restore the active leaf to branch A's end before launching the TUI.
  manager.branch(branchALeafId);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile), "the two-branch session must be durable before Pi starts");
  assert.notEqual(branchBLeafId, branchALeafId, "the seeded branches must end at different leaves");
  return { file: sessionFile, firstUserId: first, commonAncestorId: commonAncestor, branchBLeafId, branchALeafId };
}

async function createBase(options: ScenarioOptions, signal: AbortSignal): Promise<FixtureBase> {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const directory = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "killeros-compaction-boundaries-")));
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    assert.equal(existsSync(path.join(ancestor, ".git")), false, "Boundary fixtures must not discover an ancestor repository");
    if (path.dirname(ancestor) === ancestor) break;
  }
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  for (const child of [project, agent, sessions, path.join(directory, "tmp")]) mkdirSync(child);
  const planFile = path.join(directory, "plan.json");
  const probeFile = path.join(directory, "probe.jsonl");
  try {
    const base: BasePaths = { directory, project, agent, sessions, planFile, probeFile };
    writeBaseConfiguration(base, options);
    const seeded = seedHistory(project, sessions, "the primary identity file");
    return { ...base, sessionA: seeded.file, signal };
  } catch (error) {
    await removeDirectoryEventually(directory);
    throw error;
  }
}

function childArguments(base: FixtureBase, mode: Mode, sessionFile: string, tools: string): string[] {
  return [
    ...(mode === "rpc" ? ["--mode", "rpc"] : []),
    "--model", `${fixtureProvider}/local`,
    "--thinking", "off",
    "--tools", tools,
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
    "--extension", path.join(base.directory, "boundary-probe.mjs"),
  ];
}

async function startFixture(base: FixtureBase, mode: Mode, options: LaunchOptions): Promise<Fixture> {
  const provider = new LocalProvider();
  let child: PiRpcProcess | PiTerminalProcess | undefined;
  try {
    await provider.listen();
    writeModelsFile(base, provider.url);
    const env = isolatedEnvironment(base);
    const shared: FixtureState = { sessionFile: options.sessionFile, provider };
    if (mode === "rpc") {
      const rpc = new PiRpcProcess({ cliPath, cwd: base.project, env, args: childArguments(base, mode, options.sessionFile, options.tools) });
      child = rpc;
      const fixture: RpcFixture = { ...base, ...shared, kind: "rpc", rpc };
      const started = await waitForProbe(base.probeFile, (event) => event.type === "session_start", `${options.label}: RPC session_start`, base.signal);
      assert.equal(started.mode, "rpc", `${options.label}: the child must start in RPC mode`);
      assert.equal(provider.requests.length, 0, `${options.label}: Pi startup must not call the provider`);
      assertIdle(await getState(fixture), `${options.label}: startup after RPC session_start`);
      return fixture;
    }
    const terminal = new PiTerminalProcess({
      file: process.execPath,
      args: [cliPath, ...childArguments(base, mode, options.sessionFile, options.tools)],
      cwd: base.project,
      env,
      cols: 110,
      rows: 34,
    });
    child = terminal;
    const fixture: TuiFixture = { ...base, ...shared, kind: "tui", terminal };
    const started = await waitForProbe(base.probeFile, (event) => event.type === "session_start", `${options.label}: TUI session_start`, base.signal);
    assert.equal(started.mode, "tui", `${options.label}: the child must start in TUI mode`);
    await terminal.waitForScreen((screen) => screen.includes("❯"), { signal: base.signal, timeoutMs: waitTimeoutMs });
    assert.equal(provider.requests.length, 0, `${options.label}: TUI startup must not call the provider`);
    return fixture;
  } catch (error) {
    const errors: unknown[] = [error];
    if (child instanceof PiRpcProcess) {
      try {
        assert.deepEqual(await child.close(), { exit: { code: 0, signal: null }, forced: false }, child.diagnostics());
      } catch (closeError) { errors.push(closeError); }
    } else if (child instanceof PiTerminalProcess) {
      try {
        assert.deepEqual(await child.close(), { code: 0, forced: false }, child.diagnostics());
      } catch (closeError) { errors.push(closeError); }
    }
    try { await provider.close(); } catch (providerError) { errors.push(providerError); }
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, `${options.label}: compaction boundary ${mode} startup failed`);
  }
}

/** Launch records by fixture so mid-scenario child closures feed the natural-exit ledger. */
const launchRecordOf = new WeakMap<Fixture, LaunchRecord>();

/**
 * Closes only the child runtime; each launch's provider stays answerable until
 * scenario close, which also releases every recorded launch barrier and any
 * compaction gate a failed phase left acknowledged.
 */
async function closeChildFixture(fixture: Fixture): Promise<void> {
  if (fixture.kind === "rpc") {
    assert.deepEqual(await fixture.rpc.close(), { exit: { code: 0, signal: null }, forced: false }, fixture.rpc.diagnostics());
  } else {
    assert.deepEqual(await fixture.terminal.close(), { code: 0, forced: false }, fixture.terminal.diagnostics());
  }
  const launchRecord = launchRecordOf.get(fixture);
  if (launchRecord) launchRecord.naturalExit = true;
}

type Scenario = {
  scenarioId: string;
  label: string;
  base: FixtureBase;
  fixtures: Fixture[];
  launchRecords: LaunchRecord[];
  startedAt: number;
  heldCompactions: readonly number[];
  launch(mode: Mode, options: LaunchOptions): Promise<Fixture>;
  seedFile(label: string): SeedResult;
};

async function createScenario(scenarioId: string, options: ScenarioOptions, signal: AbortSignal): Promise<Scenario> {
  const base = await createBase(options, signal);
  const scenario: Scenario = {
    scenarioId,
    label: options.label,
    base,
    fixtures: [],
    launchRecords: [],
    startedAt: Date.now(),
    heldCompactions: options.heldCompactions,
    async launch(mode: Mode, launchOptions: LaunchOptions): Promise<Fixture> {
      const fixture = await startFixture(base, mode, launchOptions);
      scenario.fixtures.push(fixture);
      const launchRecord: LaunchRecord = { scenarioId, label: launchOptions.label, mode, naturalExit: false };
      scenario.launchRecords.push(launchRecord);
      launchRecordOf.set(fixture, launchRecord);
      return fixture;
    },
    seedFile(seedLabel: string): SeedResult {
      return seedHistory(base.project, base.sessions, seedLabel);
    },
  };
  return scenario;
}

/** Parses child diagnostics when structured so a large payload stays valid JSON, never a byte slice. */
function boundedDiagnostics(fixture: Fixture): Json | string {
  const text = fixture.kind === "rpc" ? fixture.rpc.diagnostics() : fixture.terminal.diagnostics();
  if (text.length <= 20_000) return text;
  try { return record(JSON.parse(text), "child diagnostics"); } catch { return text.slice(0, 4_000); }
}

async function closeScenario(scenario: Scenario, primaryError: unknown): Promise<ScenarioRecord> {
  const cleanupErrors: unknown[] = [];
  // A failed phase can leave a child parked inside an acknowledged compaction
  // gate; release every planned gate first so launches can still exit naturally.
  try { await releasePlannedSummaryGates(scenario.base.directory, scenario.heldCompactions); } catch (error) {
    cleanupErrors.push(error);
  }
  for (const fixture of scenario.fixtures.slice().reverse()) {
    try { await closeChildFixture(fixture); } catch (error) { cleanupErrors.push(error); }
  }
  for (const fixture of scenario.fixtures.slice().reverse()) {
    try { await fixture.provider.close(); } catch (error) { cleanupErrors.push(error); }
  }
  const savedProbeEvents = (() => {
    try { return readProbeEvents(scenario.base.probeFile).slice(-140); } catch (error) {
      return [{ sequence: 0, type: "probe-read-failed", detail: errorText(error) } satisfies ProbeEvent];
    }
  })();
  let scratchRemoved = false;
  try {
    await removeDirectoryEventually(scenario.base.directory);
    scratchRemoved = !existsSync(scenario.base.directory);
    assert.ok(scratchRemoved, `owned scratch directory remains: ${scenario.base.directory}`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  const record_: ScenarioRecord = {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    launches: scenario.launchRecords,
    providerRequests: scenario.fixtures.reduce((total, fixture) => total + fixture.provider.requests.length, 0),
    naturalExit: scenario.launchRecords.length > 0 && scenario.launchRecords.every((launch) => launch.naturalExit),
    scratchRemoved,
    elapsedMs: Date.now() - scenario.startedAt,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  try {
    writeFileSync(path.join(evidenceRoot, `runs-${record_.scenarioId}-${process.pid}.json`), JSON.stringify(record_, null, 2), "utf8");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    try {
      const details = {
        scenarioId: record_.scenarioId,
        label: scenario.label,
        node: process.version,
        launches: scenario.launchRecords,
        fixtures: scenario.fixtures.map((fixture) => ({
          kind: fixture.kind,
          sessionFile: fixture.sessionFile,
          providerRequests: fixture.provider.requests.slice(0, 60).map((request) => ({
            index: request.index,
            model: request.body.model,
            roles: Array.isArray(request.body.messages) ? request.body.messages.map((message) => record(message, "message").role) : [],
          })),
          providerFaults: fixture.provider.faults.slice(0, 8),
          child: boundedDiagnostics(fixture),
        })),
        probeEvents: savedProbeEvents,
        cleanupErrors: cleanupErrors.map(errorText),
      };
      writeFileSync(path.join(evidenceRoot, `failure-${record_.scenarioId}-${process.pid}-${Date.now()}.json`),
        JSON.stringify(details, null, 2), "utf8");
    } catch (writeError) {
      cleanupErrors.push(writeError);
    }
    const errors = [...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors];
    throw new AggregateError(errors, `${scenario.scenarioId}/${scenario.label} failed or did not clean up naturally`);
  }
  assert.ok(record_.naturalExit, `${record_.scenarioId}: every launch must exit naturally`);
  return record_;
}

async function runScenario(
  scenarioId: string,
  scenarioOptions: ScenarioOptions,
  t: TestContext,
  action: (scenario: Scenario) => Promise<void>,
): Promise<ScenarioRecord> {
  let scenario: Scenario | undefined;
  let primaryError: unknown;
  try {
    scenario = await createScenario(scenarioId, scenarioOptions, t.signal);
    await action(scenario);
  } catch (error) {
    primaryError = error;
  }
  if (!scenario) throw new AggregateError([primaryError], `${scenarioId}: scenario setup failed before any launch`);
  return await closeScenario(scenario, primaryError);
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

/**
 * Submits one RPC prompt and returns the probe-file cursor captured before the
 * submission, so downstream probe waits anchor on real probe line numbers.
 */
async function prompt(fixture: RpcFixture, message: string): Promise<number> {
  const before = probeCursor(fixture);
  const response = await rpcCommand(fixture, "prompt", { message });
  const disposition = record(response.data, `${message} response`).disposition;
  assert.equal(disposition, message.startsWith("/") ? "handled" : "started", message);
  return before;
}

/** Continuing workflows prove the follow-on request separately; only their final boundary must stay idle. */
async function settle(
  fixture: Fixture,
  afterProbe: number,
  count = 1,
  label = "agent settlement",
  currentState: "idle" | "continuing" = "idle",
): Promise<ProbeEvent[]> {
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

function probeCursor(fixture: Fixture): number {
  return probeEvents(fixture).at(-1)?.sequence ?? 0;
}

function countProbe(fixture: Fixture, type: string): number {
  return probeEvents(fixture).filter((event) => event.type === type).length;
}

function entriesOf(file: string): Json[] {
  return SessionManager.open(file).getBranch().map((entry) => record(entry, "saved session entry"));
}

function entries(fixture: Fixture): Json[] {
  return entriesOf(fixture.sessionFile);
}

function flatEntries(file: string): Json[] {
  return SessionManager.open(file).getEntries().map((entry) => record(entry, "saved session entry"));
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

function countMessages(fixture: Fixture, customType: string, after = 0): number {
  return probeEvents(fixture).filter((event) => event.sequence > after && event.type === "message_start"
    && event.role === "custom" && event.customType === customType).length;
}

function countSavedMessages(file: string, customType: string): number {
  return flatEntries(file).filter((entry) => (entry.type === "custom_message" || entry.type === "custom")
    && entry.customType === customType).length;
}

function compactionEntriesOf(file: string): Json[] {
  return flatEntries(file).filter((entry) => entry.type === "compaction");
}

async function releaseSummary(fixture: Fixture, index: number): Promise<void> {
  const token = `summary-${index}`;
  const gate = path.join(fixture.directory, `${token}.release`);
  const temporary = `${gate}.${process.pid}.tmp`;
  writeFileSync(temporary, token + "\n", { encoding: "utf8", flag: "wx" });
  renameSync(temporary, gate);
}

/** Releases every planned summary gate so a failed scenario waits out no held compaction barrier. */
async function releasePlannedSummaryGates(directory: string, heldCompactions: readonly number[]): Promise<void> {
  for (const index of new Set(heldCompactions)) {
    const gate = path.join(directory, `summary-${index}.release`);
    if (existsSync(gate)) continue;
    const temporary = `${gate}.${process.pid}.tmp`;
    writeFileSync(temporary, `summary-${index}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, gate);
  }
}

function acknowledgeRpc(fixture: RpcFixture): void {
  fixture.rpc.acknowledge(fixture.rpc.currentSequence);
  assert.equal(fixture.rpc.retainedRecordCount, 0, "completed protocol records are acknowledged at each stable boundary");
}

/** Native teardown can report cancellation before shutdown invalidates the pending callback. */
async function assertCancellationNotificationsThroughState(
  fixture: RpcFixture, after: number, label: string, expectedMessage: string,
): Promise<void> {
  const id = `boundary-state-${fixture.rpc.currentSequence}`;
  await fixture.rpc.send({ id, type: "get_state" });
  let cursor = after;
  let notifications = 0;
  while (true) {
    const observed = await fixture.rpc.waitForRecord((event) =>
      (event.type === "extension_ui_request" && event.method === "notify") || (event.type === "response" && event.id === id),
    { after: cursor, timeoutMs: waitTimeoutMs, signal: fixture.signal });
    if (observed.value.type === "response") {
      assert.equal(observed.value.success, true, `${label}: state request failed`);
      return;
    }
    assert.equal(observed.value.message, expectedMessage, `${label}: only native cancellation may notify before reset`);
    assert.equal(observed.value.notifyType, "error", `${label}: cancellation notification type`);
    assert.equal(++notifications, 1, `${label}: cancellation must not notify twice`);
    cursor = observed.sequence;
  }
}

async function switchRpcSession(fixture: RpcFixture, sessionFile: string): Promise<void> {
  const response = await rpcCommand(fixture, "switch_session", { sessionPath: sessionFile });
  assert.equal(record(response.data, "switch_session response").cancelled, false, "committed session replacement must not be cancelled");
  fixture.sessionFile = sessionFile;
  const state = await getState(fixture);
  assert.equal(path.resolve(stringField(state, "sessionFile")), path.resolve(sessionFile), "the active session must switch");
  assert.equal(state.pendingMessageCount, 0, "session restoration has no queued ordinary messages");
}

async function assertNoErrorsThroughState(fixture: RpcFixture, after: number, label: string): Promise<void> {
  const id = `boundary-no-errors-${fixture.rpc.currentSequence}`;
  await fixture.rpc.send({ id, type: "get_state" });
  const observed = await fixture.rpc.waitForRecord((event) => event.type === "extension_error"
    || event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error"
    || event.type === "response" && event.id === id,
  { after, timeoutMs: waitTimeoutMs, signal: fixture.signal });
  assert.equal(observed.value.type, "response", `${label}: recovery emits no runtime or error notice`);
  assert.equal(observed.value.success, true);
}

async function switchRpcSessionCancelled(fixture: RpcFixture, sessionFile: string, keepFile: string): Promise<void> {
  const response = await rpcCommand(fixture, "switch_session", { sessionPath: sessionFile });
  assert.equal(record(response.data, "cancelled switch_session response").cancelled, true, "the armed cancellation must cancel the replacement");
  fixture.sessionFile = keepFile;
  const state = await getState(fixture);
  assert.equal(path.resolve(stringField(state, "sessionFile")), path.resolve(keepFile), "a cancelled replacement keeps the source session");
  assert.equal(state.pendingMessageCount, 0, "a cancelled replacement leaves no queued messages");
}

async function forkRpcCommitted(fixture: RpcFixture, entryId: string): Promise<string> {
  const response = await rpcCommand(fixture, "fork", { entryId });
  const data = record(response.data, "fork response");
  assert.equal(data.cancelled, false, "committed fork must not be cancelled");
  assert.ok(typeof data.text === "string", "committed fork returns the forked prompt text");
  const state = await getState(fixture);
  const child = stringField(state, "sessionFile");
  assert.notEqual(path.resolve(child), path.resolve(fixture.sessionFile), "a committed fork selects a new child session");
  fixture.sessionFile = child;
  return child;
}

async function forkRpcCancelled(fixture: RpcFixture, entryId: string, keepFile: string): Promise<void> {
  const response = await rpcCommand(fixture, "fork", { entryId });
  const data = record(response.data, "cancelled fork response");
  assert.equal(data.cancelled, true, "the armed cancellation must cancel the fork");
  fixture.sessionFile = keepFile;
  const state = await getState(fixture);
  assert.equal(path.resolve(stringField(state, "sessionFile")), path.resolve(keepFile), "a cancelled fork keeps the source session");
  assert.equal(state.pendingMessageCount, 0, "a cancelled fork leaves no queued messages");
}

/** Observe the pasted command before sending Enter, including while compaction is pending. */
async function writeTuiCommand(fixture: TuiFixture, command: string): Promise<void> {
  await fixture.terminal.submitEditorText(command, { signal: fixture.signal });
}

/** Same as prompt() for the TUI editor path, anchored on the pre-submission probe cursor. */
async function tuiPrompt(fixture: TuiFixture, message: string): Promise<number> {
  const before = probeCursor(fixture);
  await fixture.terminal.submitEditorText(message, { signal: fixture.signal });
  return before;
}

async function armProbeCancel(fixture: RpcFixture, mode: "switch" | "fork" | "tree" | "off"): Promise<void> {
  await prompt(fixture, `/boundary-armed-cancel ${mode}`);
}

/** Navigation rides a small TUI command so it still executes while a compaction is held. */
async function probeNavigate(fixture: TuiFixture, targetId: string): Promise<void> {
  await writeTuiCommand(fixture, `/boundary-navigate ${targetId}`);
}

async function probeAbort(fixture: TuiFixture): Promise<void> {
  await writeTuiCommand(fixture, "/boundary-abort");
}

function goalDecision(status: "continue", turn: number): Json {
  return {
    status,
    evidence: `Audited acceptance vector ${turn}.`,
    nextAction: `Run authorized step ${turn + 1}.`,
  };
}

async function waitForPreparation(fixture: Fixture, index: number, label: string, after: number): Promise<ProbeEvent> {
  return await waitForProbe(fixture.probeFile,
    (event) => event.type === "session_before_compact" && event.index === index, label, fixture.signal, after);
}

function assertToolDeclared(request: ProviderRequest, name: string, expected: boolean, label: string): void {
  const tools = records(request.body.tools, "provider tools");
  assert.equal(tools.some((tool) => record(tool.function, "provider tool function").name === name), expected, label);
}

// Catalog ID: compaction-session-replacement.
test("Session replacement and forking leave real compaction continuations exactly once or inert", { timeout: 900_000 }, async (t) => {
  const record_ = await runScenario("compaction-session-replacement", {
    label: "single-rpc-launch",
    compactActions: ["custom", "custom", "custom", "custom", "custom", "default", "custom", "custom"],
    heldCompactions: [1, 2, 3, 4, 5, 7, 8],
  }, t, async (scenario) => {
    const fixture = await scenario.launch("rpc", {
      label: "rpc-replacement-single-launch",
      sessionFile: scenario.base.sessionA,
      tools: "write,killeros_goal_update",
    });
    assert.equal(fixture.kind, "rpc");
    const fileB = scenario.seedFile("the committed replacement target");

    // Phase 1 (sw-cancelled): the interrupted request settles while its summary is held, the
    // cancelled replacement keeps the source session, and releasing the gate yields exactly one
    // hidden continuation plus its follow-up POST (oracle 1).
    fixture.provider.enqueue({ kind: "text", content: "First settled work reaches the held summary.", usageTokens: 90_000 });
    const errorsBeforeSwitch = fixture.rpc.currentSequence;
    const p1 = await prompt(fixture, "Settle uninterrupted work that triggers the first automatic compaction.");
    await waitForProvider(fixture, 1);
    const held1 = await waitForPreparation(fixture, 1, "held summary for the first replacement attempt", p1);
    // KillerOS checks usage at turn_end, then calls Pi's public ctx.compact API.
    // Pi labels that request manual even though KillerOS initiated it automatically.
    assert.equal(held1.reason, "manual", "sw-cancelled: proactive compaction uses Pi's public compaction request");
    const armCursor1 = probeCursor(fixture);
    await armProbeCancel(fixture, "switch");
    await waitForProbe(fixture.probeFile, (event) => event.type === "cancel_armed" && event.mode === "switch",
      "sw-cancelled armed boundary", fixture.signal, armCursor1);
    await switchRpcSessionCancelled(fixture, fileB.file, fixture.sessionFile);
    const armedBoundary1 = await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_switch",
      "sw-cancelled armed replacement boundary", fixture.signal, armCursor1);
    assert.equal(armedBoundary1.cancelledByProbe, true, "sw-cancelled: the armed extension cancelled the replacement");
    const cancelledNew = await rpcCommand(fixture, "new_session");
    assert.equal(record(cancelledNew.data, "cancelled new session").cancelled, true);
    assert.equal(path.resolve(stringField(await getState(fixture), "sessionFile")), path.resolve(scenario.base.sessionA));
    await settle(fixture, p1, 1, "sw-cancelled interrupted request settlement");
    const beforeRelease1 = probeCursor(fixture);
    fixture.provider.enqueue({ kind: "text", content: "The interrupted ordinary task settles after compaction.", usageTokens: 0 });
    await releaseSummary(fixture, 1);
    const resumed1 = await waitForProvider(fixture, 2);
    assert.match(JSON.stringify(resumed1.body.messages), /Continue the interrupted task/u,
      "sw-cancelled: the released summary dispatches the hidden continuation request");
    await settle(fixture, beforeRelease1, 1, "sw-cancelled continuation settlement");
    assert.equal(countMessages(fixture, "killeros-auto-compaction"), 1, "sw-cancelled: exactly one hidden continuation");
    assert.equal(countSavedMessages(scenario.base.sessionA, "killeros-auto-compaction"), 1,
      "sw-cancelled: the continuation is saved only in the source file");
    assert.equal(compactionEntriesOf(scenario.base.sessionA).length, 1, "sw-cancelled: the custom summary landed in the source file");
    assert.equal(fixture.provider.requests.length, 2, "sw-cancelled: one prompt plus one follow-up POST");
    assert.equal(probeEvents(fixture).filter(event => event.sequence > p1 && event.type === "agent_start").length, 2);
    assertIdle(await getState(fixture), "sw-cancelled final idle");
    await assertNoErrorsThroughState(fixture, errorsBeforeSwitch, "cancelled switch/new session");
    await armProbeCancel(fixture, "off");
    acknowledgeRpc(fixture);

    // Phase 2: replacement aborts the pending summary and selects the destination.
    fixture.provider.enqueue({ kind: "text", content: "Committed replacement work reaches a held second summary.", usageTokens: 90_000 });
    const p2 = await prompt(fixture, "Settled work whose pending summary witnesses a committed replacement.");
    await waitForProvider(fixture, 3);
    await waitForPreparation(fixture, 2, "held summary before the committed replacement", p2);
    await settle(fixture, p2, 1, "sw-committed interrupted request settlement");
    const notificationCursor2 = fixture.rpc.currentSequence;
    const shutdownCursor = probeCursor(fixture);
    const switching = switchRpcSession(fixture, fileB.file).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await waitForProbe(fixture.probeFile, (event) => event.type === "compaction_signal_aborted" && event.index === 2,
      "sw-committed: native teardown aborts the held summary", fixture.signal, shutdownCursor);
    await releaseSummary(fixture, 2);
    const switched = await switching;
    if (switched.error !== undefined) throw switched.error instanceof Error ? switched.error : new Error(errorText(switched.error), { cause: switched.error });
    await waitForProbe(fixture.probeFile, (event) => event.type === "session_shutdown" && event.reason === "resume",
      "sw-committed: the replacement shuts the old runtime down as a resume", fixture.signal, shutdownCursor);
    await assertCancellationNotificationsThroughState(fixture, notificationCursor2, "sw-committed",
      "Automatic compaction failed: Compaction cancelled");
    assert.equal(fixture.provider.requests.length, 3, "sw-committed: no new provider POST follows");
    assert.equal(countSavedMessages(fileB.file, "killeros-auto-compaction"), 0, "sw-committed: the destination file gains no continuation");
    assert.equal(countSavedMessages(scenario.base.sessionA, "killeros-auto-compaction"), 1,
      "sw-committed: the source file keeps exactly its earlier continuation");
    assertIdle(await getState(fixture), "sw-committed final idle");
    acknowledgeRpc(fixture);

    // Phase 3 (fork-cancelled): the cancelled fork stays in the source session and its pending
    // summary still owns exactly one ordinary continuation (oracle 3).
    fixture.provider.enqueue({ kind: "text", content: "Cancelled-fork work reaches the held third summary.", usageTokens: 90_000 });
    const errorsBeforeFork = fixture.rpc.currentSequence;
    const p3 = await prompt(fixture, "Settle work in the replacement whose summary witnesses a cancelled fork.");
    await waitForProvider(fixture, 4);
    await waitForPreparation(fixture, 3, "held summary before the cancelled fork", p3);
    await settle(fixture, p3, 1, "fork-cancelled interrupted request settlement");
    const armCursor3 = probeCursor(fixture);
    await armProbeCancel(fixture, "fork");
    await waitForProbe(fixture.probeFile, (event) => event.type === "cancel_armed" && event.mode === "fork",
      "fork-cancelled armed boundary", fixture.signal, armCursor3);
    await forkRpcCancelled(fixture, fileB.firstUserId, fixture.sessionFile);
    await forkRpcCancelled(fixture, "not-an-entry", fixture.sessionFile);
    const armedBoundary3 = await waitForProbe(fixture.probeFile, (event) => event.type === "session_before_fork",
      "fork-cancelled armed fork boundary", fixture.signal, armCursor3);
    assert.equal(armedBoundary3.cancelledByProbe, true, "fork-cancelled: the armed extension cancelled the fork");
    await armProbeCancel(fixture, "off");
    const beforeRelease3 = probeCursor(fixture);
    fixture.provider.enqueue({ kind: "text", content: "The ordinary task settles in the preserved fork source.", usageTokens: 0 });
    await releaseSummary(fixture, 3);
    assert.match(JSON.stringify((await waitForProvider(fixture, 5)).body.messages), /Continue the interrupted task/u,
      "fork-cancelled: the released summary dispatches exactly one continuation");
    await settle(fixture, beforeRelease3, 1, "fork-cancelled continuation settlement");
    assert.equal(countSavedMessages(fileB.file, "killeros-auto-compaction"), 1, "fork-cancelled: exactly one continuation in the fork source");
    assert.equal(compactionEntriesOf(fileB.file).length, 1, "fork-cancelled: the custom summary landed in the fork source");
    assert.equal(fixture.provider.requests.length, 5, "fork-cancelled: one prompt plus one follow-up POST");
    assert.equal(probeEvents(fixture).filter(event => event.sequence > p3 && event.type === "agent_start").length, 2);
    assertIdle(await getState(fixture), "fork-cancelled final idle");
    await assertNoErrorsThroughState(fixture, errorsBeforeFork, "cancelled fork");
    acknowledgeRpc(fixture);

    // Phase 4: a committed fork aborts the pending summary and creates a child.
    fixture.provider.enqueue({ kind: "text", content: "Committed-fork work reaches the held fourth summary.", usageTokens: 90_000 });
    const p4 = await prompt(fixture, "Settle work whose pending summary witnesses a committed fork.");
    await waitForProvider(fixture, 6);
    await waitForPreparation(fixture, 4, "held summary before the committed fork", p4);
    await settle(fixture, p4, 1, "fork-committed interrupted request settlement");
    const notificationCursor4 = fixture.rpc.currentSequence;
    const forkCursor = probeCursor(fixture);
    const forking = forkRpcCommitted(fixture, fileB.firstUserId).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await waitForProbe(fixture.probeFile, (event) => event.type === "compaction_signal_aborted" && event.index === 4,
      "fork-committed: native teardown aborts the held summary", fixture.signal, forkCursor);
    await releaseSummary(fixture, 4);
    const forked = await forking;
    if (forked.error !== undefined) throw forked.error instanceof Error ? forked.error : new Error(errorText(forked.error), { cause: forked.error });
    await assertCancellationNotificationsThroughState(fixture, notificationCursor4, "fork-committed",
      "Automatic compaction failed: Compaction cancelled");
    assert.equal(fixture.provider.requests.length, 6, "fork-committed: no new provider POST follows");
    assert.equal(countSavedMessages(fixture.sessionFile, "killeros-auto-compaction"), 0,
      "fork-committed: the child gains no continuation");
    assertIdle(await getState(fixture), "fork-committed final idle");
    acknowledgeRpc(fixture);
    const childSessionFile = fixture.sessionFile;

    // Phase 5 (goal): an active goal's accepted next turn rides a held summary; a committed
    // replacement back to the goal-free source file denies it without any new authorization.
    fixture.provider.enqueue({ kind: "goal", decision: goalDecision("continue", 1), usageTokens: 10_000 });
    fixture.provider.enqueue({ kind: "text", content: "The authorized goal step reaches the held fifth summary.", usageTokens: 90_000 });
    const p5 = await prompt(fixture, "/goal Exercise recovery while a committed replacement arrives.");
    const decision = await waitForProvider(fixture, 7);
    assertToolDeclared(decision, "killeros_goal_update", true, "goal: the goal tool is declared");
    await waitForProvider(fixture, 8);
    await waitForPreparation(fixture, 5, "held summary after the accepted goal decision", p5);
    await settle(fixture, p5, 1, "goal interrupted request settlement");
    const notificationCursor5 = fixture.rpc.currentSequence;
    const goalSwitchCursor = probeCursor(fixture);
    const goalSwitch = switchRpcSession(fixture, scenario.base.sessionA).then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    await waitForProbe(fixture.probeFile, (event) => event.type === "compaction_signal_aborted" && event.index === 5,
      "goal: native teardown aborts the held summary", fixture.signal, goalSwitchCursor);
    await releaseSummary(fixture, 5);
    const goalSwitched = await goalSwitch;
    if (goalSwitched.error !== undefined) throw goalSwitched.error instanceof Error ? goalSwitched.error : new Error(errorText(goalSwitched.error), { cause: goalSwitched.error });
    await assertCancellationNotificationsThroughState(fixture, notificationCursor5, "goal replacement",
      "Goal paused: automatic compaction failed: Compaction cancelled\nAutomatic continuation is stopped. Run /goal resume after resolving the compaction problem.");
    assert.equal(countMessages(fixture, "killeros-goal-continuation"), 1,
      "goal: only the initial authorization exists; the replacement denies the next turn");
    assert.equal(goalStates(fixture).length, 0, "goal: the goal-free source file holds no goal entries");
    const childGoalStates = entriesOf(childSessionFile)
      .filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal")
      .map((entry) => record(record(entry.data, "goal entry data").state, "goal state"));
    assert.equal(last(childGoalStates, "goal child state").status, "paused", "goal: the child goal stays paused");
    assert.equal(fixture.provider.requests.length, 8, "goal: no recovery request follows the replacement");
    assertIdle(await getState(fixture), "goal after replacement");
    acknowledgeRpc(fixture);

    // Phase 6: replacement aborts a held native summary; the server may see a closed response.
    const destinationContinuations = countSavedMessages(fileB.file, "killeros-auto-compaction");
    const sourceContinuations = countSavedMessages(fixture.sessionFile, "killeros-auto-compaction");
    const staleSourceFile = fixture.sessionFile;
    fixture.provider.enqueue({ kind: "text", content: "The final request leaves a native summary pending.", usageTokens: 90_000 });
    const staleBarrier = makeBarrier();
    fixture.provider.enqueue({ kind: "held", barrier: staleBarrier,
      response: { kind: "error", status: 503, message: "replacement summary unavailable" } });
    const p6 = await prompt(fixture, "Settle final work whose native summary outlives its session.");
    await waitForProvider(fixture, 9);
    await waitForProvider(fixture, 10);
    await settle(fixture, p6, 1, "stale-native interrupted request settlement");
    const notificationCursor6 = fixture.rpc.currentSequence;
    await switchRpcSession(fixture, fileB.file);
    staleBarrier.release();
    await assertCancellationNotificationsThroughState(fixture, notificationCursor6, "native failure replacement",
      "Automatic compaction failed: Turn prefix summarization failed: This operation was aborted");
    assert.equal(fixture.provider.requests.length, 10, "stale-native: no recovery POST before the state response");
    assert.equal(countSavedMessages(fileB.file, "killeros-auto-compaction"), destinationContinuations,
      "stale-native: the destination gains no continuation beyond its earlier cancelled-fork recovery");
    assert.equal(countSavedMessages(staleSourceFile, "killeros-auto-compaction"), sourceContinuations,
      "stale-native: the source gains no continuation from the abandoned summary");
    assertIdle(await getState(fixture), "stale native failure final idle");
    acknowledgeRpc(fixture);

    // Exercise each cancelled replacement with a fresh goal and a held recovery request.
    for (const [offset, mode] of (["switch", "fork"] as const).entries()) {
      const source = scenario.seedFile(`cancelled goal ${mode} source`);
      await switchRpcSession(fixture, source.file);
      await armProbeCancel(fixture, mode);
      const beforeGoal = countMessages(fixture, "killeros-goal-continuation");
      const beforeOrdinary = countMessages(fixture, "killeros-auto-compaction");
      const initialRequests: number = fixture.provider.requests.length;
      const proofFile = path.join(fixture.project, `cancelled-goal-${mode}.txt`);
      fixture.provider.enqueue({ kind: "write", filePath: proofFile, content: `Executed ${mode} work.`, usageTokens: 90_000 });
      const start = await prompt(fixture, `/goal Preserve automatic recovery after cancelled ${mode}.`);
      const initial = await waitForProvider(fixture, initialRequests + 1);
      assertToolDeclared(initial, "killeros_goal_update", true, `goal ${mode}: goal tool is declared`);
      const held = await waitForPreparation(fixture, 7 + offset, `goal ${mode} held summary`, start);
      assert.equal(readFileSync(proofFile, "utf8"), `Executed ${mode} work.`);
      await settle(fixture, start, 1, `goal ${mode} interrupted settlement`);
      const interrupted: ProbeEvent = last(probeEvents(fixture).filter((event) => event.sequence > start && event.type === "agent_end"),
        `goal ${mode} interrupted agent`);
      assert.equal(interrupted.stopReason, "error");
      assert.equal(interrupted.errorMessage, "This operation was aborted");
      const paused: Json = last(goalStates(fixture), `goal ${mode} paused state`);
      assert.equal(paused.status, "paused");
      assert.equal(paused.turns, 1);
      if (mode === "switch") await switchRpcSessionCancelled(fixture, fileB.file, source.file);
      else await forkRpcCancelled(fixture, source.firstUserId, source.file);
      const boundary = await waitForProbe(fixture.probeFile,
        (event) => event.type === `session_before_${mode}`, `goal ${mode} cancellation`, fixture.signal, held.sequence);
      assert.equal(boundary.cancelledByProbe, true);
      await armProbeCancel(fixture, "off");
      const recovery = makeBarrier();
      fixture.provider.enqueue({ kind: "held", barrier: recovery,
        response: { kind: "text", content: `Goal ${mode} recovery completes.`, usageTokens: 0 } });
      const beforeRelease = probeCursor(fixture);
      await releaseSummary(fixture, 7 + offset);
      await waitForProvider(fixture, initialRequests + 2);
      const resumed: Json = last(goalStates(fixture), `goal ${mode} resumed state`);
      assert.equal(resumed.status, "active");
      assert.equal(resumed.turns, paused.turns, `goal ${mode}: recovery does not grant a new turn`);
      assert.equal(countMessages(fixture, "killeros-goal-continuation") - beforeGoal, 2,
        `goal ${mode}: initial authorization and one recovery`);
      assert.equal(countMessages(fixture, "killeros-auto-compaction"), beforeOrdinary);
      assert.equal(fixture.provider.requests.length, initialRequests + 2);
      recovery.release();
      await settle(fixture, beforeRelease, 1, `goal ${mode} recovery settlement`);
      acknowledgeRpc(fixture);
    }

    // Every written file stays readable and parseable after the full workflow.
    for (const file of [scenario.base.sessionA, fileB.file, childSessionFile]) {
      assert.ok(existsSync(file), `the session file ${path.basename(file)} survives`);
      assert.ok(Array.isArray(SessionManager.open(file).getTree()), `${path.basename(file)} parses its tree`);
    }
  });

  assert.deepEqual(record_.launches.map((launch) => launch.mode), ["rpc"], "the replacement catalog owns one RPC launch");
  assert.equal(record_.providerRequests, 14, "the replacement ledger holds fourteen scripted provider requests");
  t.diagnostic(JSON.stringify({ scenarioId: record_.scenarioId, launches: record_.launches.length,
    providerRequests: record_.providerRequests, elapsedMs: record_.elapsedMs,
    assertedDomains: { cancellation: ["cancelled", "committed"], boundary: ["switch", "fork"], goal: ["denied", "cancelled-recovery"] },
    documentedGap: "state responses do not establish detached callback completion or stale exact-error coverage" }));
});

// Catalog ID: compaction-tui-reload-tree.
test("TUI ordinary and goal continuations survive reload and committed tree boundaries", { timeout: 900_000 }, async (t) => {
  const record_ = await runScenario("compaction-tui-reload-tree", {
    label: "two-tui-launches",
    compactActions: ["custom", "default", "custom", "custom", "custom", "custom"],
    heldCompactions: [1, 3, 4, 5, 6],
  }, t, async (scenario) => {
    const reloadTarget = scenario.seedFile("the TUI reload history");
    assert.ok(reloadTarget.firstUserId, "the reload history exposes a forkable first user entry");

    // Launch 1 uses the ordinary TUI history. Ordinal 2 is the native summary held at the
    // provider across /reload: its action is "default" and it is deliberately never held at
    // an extension gate, because extension promises must not span a reload.
    const tui = await scenario.launch("tui", {
      label: "tui-reload-ordinary-history",
      sessionFile: reloadTarget.file,
      tools: "read",
    });
    assert.equal(tui.kind, "tui");

    // Phase A (ordinary-start): one high-usage ordinary prompt emits exactly one
    // hidden continuation and one follow-up POST in TUI mode (oracle 1).
    tui.provider.enqueue({ kind: "text", content: "The uninterrupted ordinary request completes.", usageTokens: 90_000 });
    const pA = await tuiPrompt(tui, "Settle ordinary work whose summary witnesses the whole TUI workflow.");
    await waitForProvider(tui, 1);
    await waitForPreparation(tui, 1, "held TUI ordinary summary", pA);
    await settle(tui, pA, 1, "ordinary interrupted request settlement");
    const beforeReleaseA = probeCursor(tui);
    tui.provider.enqueue({ kind: "text", content: "The ordinary TUI task settles after compaction.", usageTokens: 0 });
    await releaseSummary(tui, 1);
    await waitForProvider(tui, 2);
    assert.match(JSON.stringify((await waitForProvider(tui, 2)).body.messages), /Continue the interrupted task/u,
      "ordinary-start: the released summary dispatches the hidden continuation");
    await settle(tui, beforeReleaseA, 1, "ordinary continuation settlement");
    assert.equal(countSavedMessages(reloadTarget.file, "killeros-auto-compaction"), 1,
      "ordinary-start: exactly one hidden continuation is saved in the TUI history");
    assert.equal(tui.provider.requests.length, 2, "ordinary-start: one prompt plus one follow-up POST");

    // Phase B (reload-pending): native TUI refuses reload while compaction is pending.
    // Observe that refusal, finish the failed summary, then reload at the legal idle boundary.
    tui.provider.enqueue({ kind: "text", content: "The pre-reload request leaves a native summary pending.", usageTokens: 90_000 });
    const reloadBarrier = makeBarrier();
    tui.provider.enqueue({ kind: "held", barrier: reloadBarrier,
      response: { kind: "error", status: 503, message: "reload summary unavailable" } });
    const pB = await tuiPrompt(tui, "Settle work whose native summary is held across the reload.");
    await waitForProvider(tui, 3);
    await waitForProvider(tui, 4);
    await settle(tui, pB, 1, "reload-pending interrupted request settlement");
    const reloadCursor = probeCursor(tui);
    await writeTuiCommand(tui, "/reload");
    await tui.terminal.waitForScreen((screen) => screen.includes("Wait for compaction to finish before reloading."),
      { signal: tui.signal, timeoutMs: waitTimeoutMs });
    reloadBarrier.release();
    await waitForProbe(tui.probeFile, (event) => event.type === "session_compact_failed",
      "reload-pending: the refused reload leaves native summary failure observable", tui.signal, reloadCursor);
    assert.equal(probeEvents(tui).filter((event) => event.sequence > reloadCursor && event.type === "session_shutdown").length, 0,
      "reload-pending: refused reload must not commit a session boundary");
    await writeTuiCommand(tui, "/reload");
    await tui.terminal.waitForScreen((screen) => screen.includes("Reloaded"), { signal: tui.signal, timeoutMs: waitTimeoutMs });
    const reloadShutdown = await waitForProbe(tui.probeFile, (event) => event.type === "session_shutdown" && event.reason === "reload",
      "reload-pending: the reload tears the pre-reload runtime down as a reload", tui.signal, reloadCursor);
    const restarted = await waitForProbe(tui.probeFile,
      (event) => event.type === "session_start", "the reloaded runtime session start", tui.signal, reloadShutdown.sequence);
    assert.equal(restarted.mode, "tui", "reload-pending: the reloaded runtime stays in TUI mode");
    assert.equal(tui.provider.requests.length, 4, "reload-pending: no extra provider POST follows the reload");
    assert.equal(countSavedMessages(reloadTarget.file, "killeros-auto-compaction"), 1,
      "reload-pending: no hidden continuation follows the reload");
    await tui.terminal.waitForScreen((screen) => screen.includes("❯"), { signal: tui.signal, timeoutMs: waitTimeoutMs });

    // Phase C (post-reload-recovery): a fresh ordinary request compacting after the reload still
    // emits exactly one hidden continuation and one follow-up POST (oracle 4).
    tui.provider.enqueue({ kind: "text", content: "The post-reload request compacts freshly.", usageTokens: 90_000 });
    const pC = await tuiPrompt(tui, "Settle work in the reloaded runtime that compacts and continues.");
    await waitForProvider(tui, 5);
    const heldC = await waitForPreparation(tui, 3, "held post-reload summary", pC);
    assert.equal(numberField(heldC, "index"), 3, "post-reload-recovery: the file-derived ordinal survives the reload");
    await settle(tui, pC, 1, "post-reload interrupted request settlement");
    const beforeReleaseC = probeCursor(tui);
    tui.provider.enqueue({ kind: "text", content: "The reloaded TUI task settles after compaction.", usageTokens: 0 });
    await releaseSummary(tui, 3);
    await waitForProvider(tui, 6);
    assert.match(JSON.stringify((await waitForProvider(tui, 6)).body.messages), /Continue the interrupted task/u,
      "post-reload-recovery: the lifecycle reset is clean and the continuation runs exactly once");
    await settle(tui, beforeReleaseC, 1, "post-reload continuation settlement");
    assert.equal(countSavedMessages(reloadTarget.file, "killeros-auto-compaction"), 2,
      "post-reload-recovery: the new continuation joins the earlier one");

    // Phase D: native Pi refuses tree navigation while compaction is pending.
    // The refused move preserves recovery; a later idle move commits without new work.
    tui.provider.enqueue({ kind: "text", content: "The tree-navigation request leaves its summary pending.", usageTokens: 90_000 });
    const pD = await tuiPrompt(tui, "Settle work whose summary outlives a committed tree navigation.");
    await waitForProvider(tui, 7);
    const heldD = await waitForPreparation(tui, 4, "held summary before the committed navigation", pD);
    await settle(tui, pD, 1, "tree-navigation interrupted request settlement");
    await probeNavigate(tui, reloadTarget.firstUserId);
    const refusedTree = await waitForProbe(tui.probeFile,
      (event) => event.type === "navigation_result" && event.targetId === reloadTarget.firstUserId,
      "pending compaction refuses tree navigation", tui.signal, heldD.sequence);
    assert.equal(refusedTree.failed,
      "Wait for the current compaction or tree navigation to finish before navigating the session tree.");
    assert.equal(probeEvents(tui).filter((event) => event.sequence > heldD.sequence && event.type === "session_tree").length, 0,
      "refused navigation must not commit a tree boundary");
    tui.provider.enqueue({ kind: "text", content: "Refused navigation preserves this ordinary recovery.", usageTokens: 0 });
    const recoveryCursor = probeCursor(tui);
    await releaseSummary(tui, 4);
    await waitForProvider(tui, 8);
    await settle(tui, recoveryCursor, 1, "refused navigation recovery settlement");
    assert.equal(countSavedMessages(reloadTarget.file, "killeros-auto-compaction"), 3,
      "refused navigation preserves exactly one new continuation");
    const idleTreeCursor = probeCursor(tui);
    await probeNavigate(tui, reloadTarget.firstUserId);
    const committedTree = await waitForProbe(tui.probeFile,
      (event) => event.type === "session_tree", "idle navigation commits session_tree", tui.signal, idleTreeCursor);
    assert.equal(committedTree.newLeafId, null,
      "committed-tree: navigating to the first user message rewinds to its null parent for re-editing");
    assert.equal(tui.provider.requests.length, 8, "committed-tree: idle navigation makes no provider request");
    assert.equal(countSavedMessages(reloadTarget.file, "killeros-auto-compaction"), 3,
      "committed-tree: idle navigation appends no continuation");
    await tui.terminal.waitForScreen((screen) => screen.includes("❯"), { signal: tui.signal, timeoutMs: waitTimeoutMs });
    await closeChildFixture(tui);

    // Launch 2 uses the goal TUI history: the same-turn recovery and the pending-goal tree race.
    const goalTarget = scenario.seedFile("the TUI goal history");
    const goalTui = await scenario.launch("tui", {
      label: "tui-goal-history",
      sessionFile: goalTarget.file,
      tools: "read,write,killeros_goal_update",
    });
    assert.equal(goalTui.kind, "tui");
    const goalTerminal = goalTui.terminal;
    const launchTwoCursor = probeCursor(goalTui);

    // Phase E (goal-recovery): the /goal start aborts mid-run when its compaction starts; the
    // held gate releases a complete summary and the goal resumes the SAME turn exactly once
    // without a new decision (oracle 2).
    const proofFile = path.join(goalTui.project, "goal-recovery-proof.txt");
    const proofContent = "The public write tool executed before the compaction interrupted the run.";
    goalTui.provider.enqueue({ kind: "write", filePath: proofFile, content: proofContent, usageTokens: 90_000 });
    goalTui.provider.enqueue({ kind: "text", content: "The same-turn goal recovery stops without another decision.", usageTokens: 0 });
    const pE = await tuiPrompt(goalTui, "/goal Verify one same-turn recovery in the TUI after automatic compaction.");
    const writeRequest = await waitForProvider(goalTui, 1);
    assertToolDeclared(writeRequest, "killeros_goal_update", true, "goal-recovery: the goal tool is declared");
    assertToolDeclared(writeRequest, "write", true, "goal-recovery: the public write tool is declared");
    await waitForPreparation(goalTui, 5, "held goal summary before the same-turn recovery", pE);
    assert.equal(readFileSync(proofFile, "utf8"), proofContent, "goal-recovery: the public write executed before compaction");
    await settle(goalTui, pE, 1, "goal-recovery interrupted request settlement", "continuing");
    const afterInterrupted = probeCursor(goalTui);
    const interrupted = last(probeEvents(goalTui).filter((event) => event.type === "agent_end" && event.sequence > pE), "goal-recovery interrupted agent_end");
    assert.equal(interrupted.stopReason, "error", "goal-recovery: the compaction interruption surfaces Pi's abort-error result");
    assert.equal(interrupted.errorMessage, "This operation was aborted", "goal-recovery: the interruption is exact, not an arbitrary failure");
    await releaseSummary(goalTui, 5);
    await waitForProvider(goalTui, 2);
    const resumed = await waitForProbe(goalTui.probeFile, (event) => event.type === "message_start"
      && event.role === "custom" && event.customType === "killeros-goal-continuation",
      "goal-recovery: the same-turn recovery follows the completed compaction", goalTui.signal, afterInterrupted);
    assert.ok(resumed.sequence > afterInterrupted, "goal-recovery: the recovery starts only after the interrupted turn settles");
    await settle(goalTui, resumed.sequence, 1, "goal-recovery recovery settlement");
    assert.equal(countMessages(goalTui, "killeros-goal-continuation", launchTwoCursor), 2,
      "goal-recovery: initial authorization plus exactly one same-turn recovery");
    assert.equal(countMessages(goalTui, "killeros-auto-compaction", launchTwoCursor), 0,
      "goal-recovery: goal-owned compaction never emits the ordinary continuation");
    const recoveredGoal = last(goalStates(goalTui), "goal-recovery final goal state");
    assert.equal(recoveredGoal.status, "paused", "goal-recovery: the goal stays paused without a decision");
    assert.equal(numberField(recoveredGoal, "turns"), 1, "goal-recovery: the same-turn recovery grants no logical turn");
    // Initial set and turn authorization both persist active state before compaction pauses it.
    assert.equal(goalStates(goalTui).map((state) => state.status).join(","), "active,active,paused,active,paused",
      "goal-recovery: the save order for one same-turn recovery is exact");

    // Phase F: native Pi refuses navigation during the held goal summary.
    // The accepted decision remains valid and grants one turn before a legal idle navigation.
    goalTui.provider.enqueue({ kind: "goal", decision: goalDecision("continue", 2), usageTokens: 10_000 });
    goalTui.provider.enqueue({ kind: "text", content: "The authorized second step reaches the held summary.", usageTokens: 90_000 });
    const pF = await tuiPrompt(goalTui, "/goal resume");
    const resumedDecision = await waitForProvider(goalTui, 3);
    assertToolDeclared(resumedDecision, "killeros_goal_update", true, "goal-tree-pending: the goal tool is declared");
    await waitForProvider(goalTui, 4);
    const heldF = await waitForPreparation(goalTui, 6, "held summary while the next turn is pending", pF);
    await settle(goalTui, pF, 1, "goal-tree-pending interrupted request settlement");
    await probeNavigate(goalTui, goalTarget.firstUserId);
    const refusedGoalTree = await waitForProbe(goalTui.probeFile,
      (event) => event.type === "navigation_result" && event.targetId === goalTarget.firstUserId,
      "pending goal compaction refuses navigation", goalTui.signal, heldF.sequence);
    assert.equal(refusedGoalTree.failed,
      "Wait for the current compaction or tree navigation to finish before navigating the session tree.");
    assert.equal(probeEvents(goalTui).filter((event) => event.sequence > heldF.sequence && event.type === "session_tree").length, 0,
      "refused navigation cannot invalidate the accepted goal decision");
    goalTui.provider.enqueue({ kind: "text", content: "The authorized goal recovery ends without a new decision.", usageTokens: 0 });
    const goalRecoveryCursor = probeCursor(goalTui);
    await releaseSummary(goalTui, 6);
    await waitForProvider(goalTui, 5);
    await settle(goalTui, goalRecoveryCursor, 1, "preserved goal authorization recovery settlement");
    assert.equal(countMessages(goalTui, "killeros-goal-continuation"), 4,
      "goal-tree-pending: refusal preserves exactly one authorized continuation");
    const finalGoal = last(goalStates(goalTui), "goal-tree-pending recovered goal");
    assert.equal(finalGoal.turns, 3, "the accepted continue grants exactly one additional logical turn");
    assert.equal(finalGoal.status, "paused", "the recovered decisionless turn must pause");
    assert.equal(countMessages(goalTui, "killeros-auto-compaction", launchTwoCursor), 0, "goal recovery remains goal-owned");
    const idleGoalTreeCursor = probeCursor(goalTui);
    await probeNavigate(goalTui, goalTarget.firstUserId);
    const pendingTree = await waitForProbe(goalTui.probeFile,
      (event) => event.type === "session_tree", "idle goal navigation commits", goalTui.signal, idleGoalTreeCursor);
    assert.equal(pendingTree.newLeafId, null, "navigation to the first user rewinds to its parent");
    assert.equal(goalTui.provider.requests.length, 5, "idle navigation grants no further recovery request");
    assert.equal(countMessages(goalTui, "killeros-goal-continuation"), 4, "idle navigation grants no goal turn");
    await goalTerminal.waitForScreen((screen) => screen.includes("❯"), { signal: goalTui.signal, timeoutMs: waitTimeoutMs });
    await closeChildFixture(goalTui);
  });

  assert.deepEqual(record_.launches.map((launch) => launch.mode), ["tui", "tui"], "the reload-tree catalog owns two TUI launches");
  assert.equal(record_.providerRequests, 13, "the reload-tree ledger holds eight ordinary and five goal requests");
  t.diagnostic(JSON.stringify({ scenarioId: record_.scenarioId, launches: record_.launches.length,
    providerRequests: record_.providerRequests, elapsedMs: record_.elapsedMs,
    assertedDomains: { lifecycle: ["reload"], navigation: ["committed"], request: ["ordinary", "goal"],
      compaction: ["pending", "extension", "native"], continuation: ["once-per-pause", "denied"] } }));
});

// Catalog ID: compaction-tui-tree-manual-recovery.
test("Tree navigation evaluates only the destination branch and cannot revive an old manual marker", { timeout: 900_000 }, async (t) => {
  const record_ = await runScenario("compaction-tui-tree-manual-recovery", {
    label: "two-tui-launches",
    compactActions: ["custom", "custom"],
    heldCompactions: [1, 2],
  }, t, async (scenario) => {
    // Launch 1: the restored two-branch history with zero provider POSTs (oracle 4).
    const restored = seedTwoBranchSession(scenario.base.project, scenario.base.sessions);
    const restoredTui = await scenario.launch("tui", {
      label: "tui-restored-two-branch",
      sessionFile: restored.file,
      tools: "killeros_goal_update",
    });
    assert.equal(restoredTui.kind, "tui");

    // Navigate the restored session from A to B and back through the public probe command.
    await probeNavigate(restoredTui, restored.branchBLeafId);
    const navToB = await waitForProbe(restoredTui.probeFile,
      (event) => event.type === "session_tree", "the restored navigation commits branch B", restoredTui.signal);
    assert.equal(navToB.newLeafId, restored.branchBLeafId, "restored-navigation: the leaf lands on branch B");
    assert.equal(navToB.summaryEntry, null, "restored-navigation: navigation without a summary adds no summary entry");
    await tuiPrompt(restoredTui, "/goal");
    await restoredTui.terminal.waitForScreen((screen) => screen.includes("Resume the exact saved branch B goal")
      && screen.includes("→ Resume goal"), { signal: restoredTui.signal, timeoutMs: waitTimeoutMs });
    restoredTui.terminal.write("\x1b");
    await restoredTui.terminal.waitForScreen((screen) => !screen.includes("Resume goal") && screen.includes("❯"),
      { signal: restoredTui.signal, timeoutMs: waitTimeoutMs });
    await probeNavigate(restoredTui, restored.branchALeafId);
    const navBackToA = await waitForProbe(restoredTui.probeFile,
      (event) => event.type === "session_tree" && event.newLeafId === restored.branchALeafId,
      "the restored navigation commits back to branch A", restoredTui.signal, navToB.sequence);
    assert.equal(navBackToA.oldLeafId, restored.branchBLeafId, "restored-navigation: the return replaces the branch B leaf");
    await tuiPrompt(restoredTui, "/goal");
    await restoredTui.terminal.waitForScreen((screen) => screen.includes("Resume the exact saved branch A goal")
      && screen.includes("→ Resume goal"), { signal: restoredTui.signal, timeoutMs: waitTimeoutMs });
    restoredTui.terminal.write("\x1b");
    await restoredTui.terminal.waitForScreen((screen) => !screen.includes("Resume goal") && screen.includes("❯"),
      { signal: restoredTui.signal, timeoutMs: waitTimeoutMs });
    await restoredTui.terminal.waitForScreen((screen) => screen.includes("❯"), { signal: restoredTui.signal, timeoutMs: waitTimeoutMs });

    assert.equal(restoredTui.provider.requests.length, 0, "restored-navigation: no provider POST occurs (oracle 4)");
    assert.equal(countMessages(restoredTui, "killeros-goal-continuation"), 0,
      "restored-navigation: no sendMessage continuation follows either commitment");
    assert.equal(countMessages(restoredTui, "killeros-auto-compaction"), 0,
      "restored-navigation: no ordinary continuation follows either commitment");
    assert.equal(countProbe(restoredTui, "session_before_compact"), 0,
      "restored-navigation: navigation never prepares a compaction");
    const restoredEntries = flatEntries(restored.file);
    const goalEntries = restoredEntries.filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
    assert.equal(goalEntries.length, 2, "restored-navigation: both seeded goal entries survive appends (oracle 1)");
    const branchAGoal = record(record(last(
      goalEntries.filter((entry) => record(entry.data, "goal entry data").state !== undefined
        && record(record(entry.data, "goal entry data").state, "goal state").resumeAfterManualCompaction === true),
      "branch A marker entry").data, "goal entry data").state, "branch A goal state");
    assert.equal(branchAGoal.status, "paused", "restored-navigation: the branch A goal stays paused (oracle 3)");
    assert.equal(branchAGoal.revision, 7, "restored-navigation: the marker entry is never rewritten by navigation");
    assert.equal(goalStates(restoredTui).length, 1,
      "restored-navigation: only branch A is evaluated from its own entries (oracle 2)");
    assert.equal(last(goalStates(restoredTui), "branch A restored goal").resumeAfterManualCompaction === true, false,
      "restored-navigation: the selected saved branch does not expose the old recovery marker");
    await closeChildFixture(restoredTui);

    // Launch 2: the live pending-manual-recovery/navigation race with real requests.
    const liveTarget = scenario.seedFile("the live manual-recovery history");
    const liveTui = await scenario.launch("tui", {
      label: "tui-live-manual-recovery",
      sessionFile: liveTarget.file,
      tools: "read,killeros_goal_update",
    });
    assert.equal(liveTui.kind, "tui");

    // Phase (a) live-abort: the fresh /goal run is aborted while its request is held at the
    // provider; the aborted settlement saves the paused marker.
    const liveBarrier = makeBarrier();
    liveTui.provider.enqueue({ kind: "held", barrier: liveBarrier,
      response: { kind: "text", content: "The live goal prompt never returns before the abort.", usageTokens: 90_000 } });
    const pA = await tuiPrompt(liveTui, "/goal Verify one live manual-recovery race in the TUI.");
    await waitForProvider(liveTui, 1);
    await probeAbort(liveTui);
    await waitForProbe(liveTui.probeFile, (event) => event.type === "abort_requested", "the public abort request", liveTui.signal, pA);
    await settle(liveTui, pA, 1, "live-abort settlement");
    const pausedMarker = last(goalStates(liveTui), "live-abort paused state");
    assert.equal(pausedMarker.status, "paused", "live-abort: the goal pauses");
    assert.equal(pausedMarker.resumeAfterManualCompaction === true, true,
      "live-abort: the aborted turn parks manual-compaction recovery");
    await liveTui.terminal.waitForScreen((screen) => screen.includes("Goal paused because the turn was aborted"),
      { signal: liveTui.signal, timeoutMs: waitTimeoutMs });
    assert.equal(liveTui.provider.requests.length, 1, "live-abort: exactly one provider POST");

    // Phase (b): native refusal while compacting preserves the live marker.
    // Recover the same turn, then abandon it through a legal idle navigation.
    await writeTuiCommand(liveTui, "/compact");
    const heldB = await waitForPreparation(liveTui, 1, "held manual summary for the abandoned marker", pA);
    await probeNavigate(liveTui, liveTarget.firstUserId);
    const refusedB = await waitForProbe(liveTui.probeFile,
      (event) => event.type === "navigation_result" && event.targetId === liveTarget.firstUserId,
      "manual compaction refuses navigation", liveTui.signal, heldB.sequence);
    assert.equal(refusedB.failed, "Wait for the current compaction or tree navigation to finish before navigating the session tree.");
    liveTui.provider.enqueue({ kind: "text", content: "The first manual recovery settles without a new decision.", usageTokens: 0 });
    await releaseSummary(liveTui, 1);
    const compactB = await waitForProbe(liveTui.probeFile,
      (event) => event.type === "session_compact" && event.reason === "manual", "the released manual summary completes", liveTui.signal, heldB.sequence);
    assert.equal(numberField(compactB, "index"), 1, "abandoned-marker: the manual compaction entry was recorded as the first prepared ordinal");
    await waitForProvider(liveTui, 2);
    await settle(liveTui, compactB.sequence, 1, "first manual recovery settlement");
    assert.equal(countMessages(liveTui, "killeros-goal-continuation"), 2, "initial authorization plus exactly one manual recovery");
    // Retain a complete historical exchange on the destination branch. Rewinding
    // to the first user's null parent leaves nothing for a later compact to summarize.
    const historyAssistant = flatEntries(liveTarget.file).find((entry) => entry.type === "message"
      && record(entry.message, "historical message").role === "assistant");
    assert.ok(historyAssistant, "the seeded assistant exchange must remain available");
    const historyLeafId = stringField(historyAssistant, "id");
    const idleB = probeCursor(liveTui);
    await probeNavigate(liveTui, historyLeafId);
    const committed = await waitForProbe(liveTui.probeFile,
      (event) => event.type === "session_tree", "idle navigation abandons recovered branch", liveTui.signal, idleB);
    assert.equal(committed.newLeafId, historyLeafId, "the goal-free destination retains summarizable history");
    assert.equal(liveTui.provider.requests.length, 2, "idle navigation makes no extra recovery request");
    const liveEntries = flatEntries(liveTarget.file);
    assert.equal(liveEntries.filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal"
      && record(entry.data, "goal data").event === "resume").length, 1,
      "abandoned-marker: only the completed recovery's resume entry exists");

    // Phase (c) second-marker: a fresh /goal (no confirm dialog exists without a goal) parks a
    // second marker through the same live abort.
    const secondBarrier = makeBarrier();
    liveTui.provider.enqueue({ kind: "held", barrier: secondBarrier,
      response: { kind: "text", content: "The second live prompt never returns before the abort.", usageTokens: 90_000 } });
    // Clear any editor input before starting the independent goal on retained history.
    liveTui.terminal.write("\x15");
    const pC = await tuiPrompt(liveTui, "/goal Verify the preserved recovery marker after a cancelled navigation.");
    await waitForProvider(liveTui, 3);
    await probeAbort(liveTui);
    await settle(liveTui, pC, 1, "second-marker settlement");
    const secondMarker = last(goalStates(liveTui), "second marker state");
    assert.equal(secondMarker.resumeAfterManualCompaction === true, true, "second-marker: the fresh marker is saved");
    assert.equal(liveTui.provider.requests.length, 3, "second-marker: exactly one provider POST for the fresh goal start");

    // Phase (d): Pi refuses navigation while compacting; recovery completes before the later idle cancellation.
    await writeTuiCommand(liveTui, "/boundary-armed-cancel tree");
    const armed = await waitForProbe(liveTui.probeFile, (event) => event.type === "cancel_armed", "the cancel toggle armed", liveTui.signal, compactB.sequence);
    void armed;
    await writeTuiCommand(liveTui, "/compact");
    const heldD = await waitForPreparation(liveTui, 2, "held manual summary for the preserved marker", compactB.sequence);
    await probeNavigate(liveTui, liveTarget.firstUserId);
    const cancelled = await waitForProbe(liveTui.probeFile,
      (event) => event.type === "navigation_result" && event.targetId === liveTarget.firstUserId,
      "the refused pending navigation result", liveTui.signal, heldD.sequence);
    assert.equal(cancelled.failed, "Wait for the current compaction or tree navigation to finish before navigating the session tree.");
    assert.equal(cancelled.targetId, liveTarget.firstUserId, "preserved-marker: the cancellation is recorded per target");
    assert.equal(probeEvents(liveTui).filter((event) => event.sequence > heldD.sequence
      && event.sequence < cancelled.sequence && event.type === "session_tree").length, 0,
      "preserved-marker: the refused pending navigation never commits a tree change");
    // The recovery plan is enqueued before the release so the resuming marker is scripted on time.
    liveTui.provider.enqueue({ kind: "text", content: "The preserved-marker recovery request resumes the same turn.", usageTokens: 0 });
    await releaseSummary(liveTui, 2);
    const compactD = await waitForProbe(liveTui.probeFile,
      (event) => event.type === "session_compact" && event.reason === "manual", "the released second manual summary", liveTui.signal, compactB.sequence);
    assert.ok(numberField(compactD, "index") >= 2, "preserved-marker: the second manual completion is distinct");
    await waitForProvider(liveTui, 4);
    await settle(liveTui, compactD.sequence, 1, "preserved-marker recovery settlement");
    const idleD = probeCursor(liveTui);
    await probeNavigate(liveTui, liveTarget.firstUserId);
    await waitForProbe(liveTui.probeFile,
      (event) => event.type === "navigation_result" && event.cancelled === true,
      "idle navigation reaches the cancellation hook", liveTui.signal, idleD);
    assert.equal(countMessages(liveTui, "killeros-goal-continuation"), 4,
      "preserved-marker: each initial authorization has exactly one manual recovery");
    assert.equal(liveTui.provider.requests.length, 4, "preserved-marker: the recovery runs one final request");
    const resumedStates = goalStates(liveTui);
    assert.equal(last(resumedStates, "preserved-marker final state").status, "paused",
      "preserved-marker: the resumed turn pauses again without a decision");
    const resumeTargets = flatEntries(liveTarget.file).filter((entry) => entry.type === "custom"
      && entry.customType === "killeros-goal" && record(entry.data, "goal data").event === "resume");
    assert.equal(resumeTargets.length, 2, "preserved-marker: each manual recovery appends exactly one resume entry");
    await writeTuiCommand(liveTui, "/boundary-armed-cancel off");
    await liveTui.terminal.waitForScreen((screen) => screen.includes("❯"), { signal: liveTui.signal, timeoutMs: waitTimeoutMs });
    secondBarrier.release();
    await closeChildFixture(liveTui);
  });

  assert.deepEqual(record_.launches.map((launch) => launch.mode), ["tui", "tui"], "the manual-recovery catalog owns two TUI launches");
  assert.equal(record_.providerRequests, 4, "the manual-recovery ledger holds two aborted and two recovery requests");
  t.diagnostic(JSON.stringify({ scenarioId: record_.scenarioId, launches: record_.launches.length,
    providerRequests: record_.providerRequests, elapsedMs: record_.elapsedMs,
    assertedDomains: { navigation: ["tree"], branch: ["A-to-B", "B-to-A"], marker: ["abandoned", "destination"],
      recovery: ["denied", "preserved"], race: ["restored", "live"] } }));
});
