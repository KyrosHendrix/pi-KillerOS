import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const piManifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
assert.ok(typeof piManifest === "object" && piManifest !== null && "version" in piManifest && typeof piManifest.version === "string");
const piVersion = piManifest.version;
const enter = "\x1b[13u";
// Frozen source input: a configured display name that must never become receipt attribution.
const hostileModelName = " \x1b[31mModel\x1b[0m\n Name\0 ";

type RecordValue = Record<string, unknown>;
type ToolStep = { kind: "tool"; outputTokens?: number; holdMs?: number; responseModel?: string } & (
  | { command: string; toolName?: "bash" | "powershell" }
  | { toolName: "killeros_goal_update"; decision: RecordValue }
);
type Step =
  | { kind: "text"; content: string; outputTokens?: number; inputTokens?: number; holdMs?: number; holdUntil?: Promise<void>; responseModel?: string; reasoningTokens?: number; reasoningContent?: string; finishReason?: "stop" | "length" | "tool_calls" }
  | ToolStep
  | { kind: "fail" };

/** Loopback provider fixture: exact scripted responses, no live service or credentials. */
class ReceiptProvider {
  readonly requests: RecordValue[] = [];
  private readonly faults: unknown[] = [];
  private readonly server: Server;
  private readonly steps: Step[] = [];

  constructor() {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          assert.ok(chunk instanceof Uint8Array, "Provider fixture received a non-byte chunk");
          size += chunk.length;
          assert.ok(size < 1_048_576, "Provider fixture request exceeded 1 MiB");
          chunks.push(Buffer.from(chunk));
        }
        assert.equal(request.url, "/v1/chat/completions", "Receipt fixture only serves the completions endpoint");
        assert.equal(request.method, "POST");
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(typeof body === "object" && body !== null && "model" in body);
        this.requests.push(body);
        const step = this.steps.shift();
        if (step === undefined) throw new Error(`Unexpected provider request ${this.requests.length}`);
        const socket = response.socket;
        if (socket === null) throw new Error("Receipt fixture lost the response socket");
        if (step.kind === "fail") {
          response.writeHead(500, { connection: "close" });
          response.end("Receipt fixture controlled failure");
          return;
        }
        const holdMs = step.holdMs;
        const output = step.kind === "text" ? step.outputTokens ?? 40 : step.outputTokens;
        const responseModel = step.responseModel ?? "receipt-model";
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        const index = this.requests.length;
        if (step.kind === "tool") {
          const argumentsValue = "command" in step ? { command: step.command } : step.decision;
          const call = { index: 0, id: `receipt-call-${index}`, type: "function", function: { name: step.toolName ?? "bash", arguments: JSON.stringify(argumentsValue) } };
          response.write(`data: ${JSON.stringify({ id: `receipt-${index}`, model: responseModel, choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id: `receipt-${index}`, model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
        } else {
          const delta = step.reasoningContent === undefined ? { content: step.content } : { reasoning_content: step.reasoningContent };
          response.write(`data: ${JSON.stringify({ id: `receipt-${index}`, model: responseModel, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        }
        if (step.kind === "text") await step.holdUntil;
        if (socket.destroyed) return;
        if (holdMs !== undefined) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(finish, holdMs);
            function finish(): void {
              clearTimeout(timer);
              response.off("close", finish);
              resolve();
            }
            response.once("close", finish);
          });
          if (socket.destroyed) return;
        }
        const input = step.kind === "text" ? step.inputTokens ?? 900 : 900;
        const details = step.kind === "text" && step.reasoningTokens !== undefined
          ? { completion_tokens_details: { reasoning_tokens: step.reasoningTokens } } : {};
        const usage = output === undefined ? {} : { usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, ...details } };
        const finishReason = step.kind === "text" ? step.finishReason ?? "stop" : "tool_calls";
        response.end(`data: ${JSON.stringify({ id: `receipt-${index}`, model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...usage })}\n\ndata: [DONE]\n\n`);
      })().catch((error: unknown) => {
        this.faults.push(error);
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(500, { connection: "close" });
          response.end("Receipt fixture rejected request");
        }
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
  }

  get errors(): unknown[] {
    return this.faults;
  }

  plan(...steps: Step[]): void {
    this.steps.push(...steps);
  }

  async listen(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Receipt fixture did not report a port"));
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }
}

type Family = {
  directory: string;
  project: string;
  agent: string;
  temporary: string;
  env: NodeJS.ProcessEnv;
};

function createFamily(name: string): Family {
  const directory = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), `killeros-receipts-${name}-`)));
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    assert.equal(existsSync(path.join(ancestor, ".git")), false, "Fixture discovery cannot reach a parent repository");
    if (path.dirname(ancestor) === ancestor) break;
  }
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const temporary = path.join(directory, "tmp");
  for (const folder of [project, agent, temporary]) mkdirSync(folder);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: temporary, TMP: temporary,
    PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([entry]) => entry.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  return { directory, project, agent, temporary, env };
}

function git(project: string, ...args: string[]): void {
  const env: NodeJS.ProcessEnv = { HOME: path.dirname(project), USERPROFILE: path.dirname(project),
    PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  execFileSync("git", ["-c", "user.email=receipts@fixture.invalid", "-c", "user.name=Receipt Fixture", ...args], {
    cwd: project, env, stdio: "ignore", windowsHide: true,
  });
}

function initRepository(project: string): void {
  git(project, "init", "-q");
  git(project, "config", "core.autocrlf", "false");
  writeFileSync(path.join(project, "baseline.txt"), "baseline\n");
  // Local scripts keep fixture checks from resolving the repository root's manifest upward.
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "receipt-fixture", private: true,
    scripts: { test: "node -e \"require('node:fs').writeFileSync('checked.txt', 'one\\ntwo\\n')\"", check: "node -e \"process.exit(1)\"" } }));
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "baseline");
}

function writeProviderConfig(agent: string, port: number, displayName = "receipt model"): void {
  const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).trim();
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
    shellPath: path.resolve(gitExecPath, "../../..", "bin/bash.exe"),
    compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "receipts-local": {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "receipts-fixture-only",
    models: [{ id: "receipt-model", name: displayName, reasoning: false, input: ["text"], contextWindow: 200_000,
      maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
}

type WorkedForEntry = { customType: string; data: RecordValue };

function workedForEntries(sessionFile: string): WorkedForEntry[] {
  const entries: WorkedForEntry[] = [];
  for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/u)) {
    if (!line) continue;
    const parsed: unknown = JSON.parse(line);
    assert.ok(typeof parsed === "object" && parsed !== null);
    if ((parsed as RecordValue).type === "custom" && (parsed as RecordValue).customType === "killeros-worked-for") {
      const data = (parsed as RecordValue).data;
      assert.ok(typeof data === "object" && data !== null);
      entries.push({ customType: "killeros-worked-for", data: data as RecordValue });
    }
  }
  return entries;
}

// Observe native settlement after KillerOS has finished its registered handler.
function receiptObserver(directory: string, captureTimings = false): { extension: string; events: string; timings: string } {
  const events = path.join(directory, "settlements.jsonl");
  const timings = path.join(directory, "timings.jsonl");
  const extension = path.join(directory, "receipt-observer.mjs");
  writeFileSync(events, "");
  writeFileSync(timings, "");
  writeFileSync(extension, `import { appendFileSync } from "node:fs";
${captureTimings ? `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};` : ""}
export default function(pi) {
  ${captureTimings ? `
  pi.registerTool({
    name: "powershell", label: "PowerShell", description: "Execute an owned fixture check through Windows PowerShell",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, args, signal) => {
      const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", args.command],
        { windowsHide: true, signal, timeout: 15000, maxBuffer: 1048576 });
      return { content: [{ type: "text", text: result.stdout || "PowerShell check completed" }], details: {} };
    },
  });
  for (const name of ["agent_start", "message_start", "message_end", "agent_settled"]) {
    pi.on(name, (event, ctx) => appendFileSync(${JSON.stringify(timings)}, JSON.stringify({
      event: name, at: Date.now(), role: event.message?.role, output: event.message?.usage?.output,
      model: event.message?.responseModel ?? event.message?.model,
      receiptCount: name === "agent_start" ? ctx.sessionManager.getEntries().filter(entry =>
        entry.type === "custom" && entry.customType === "killeros-worked-for").length : undefined
    }) + "\\n"));
  }
  pi.on("agent_before_settle", async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  ` : ""}
  pi.registerCommand("receipt-frame", {
    description: "Acknowledge the native terminal width for receipt inspection",
    handler: async (args, ctx) => ctx.ui.notify("Receipt frame " + args + ": " + process.stdout.columns, "info"),
  });
  pi.on("agent_settled", (event, ctx) => {
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({
      aborted: event.aborted, idle: ctx.isIdle(), pending: ctx.hasPendingMessages()
    }) + "\\n");
  });
}
`);
  return { extension, events, timings };
}

function waitForReceiptSettlement(events: string, count: number, signal: AbortSignal, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      watcher.close();
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error instanceof Error ? error : new Error("Receipt settlement observation failed", { cause: error })); else resolve();
    };
    const check = (): void => {
      try {
        const lines = readFileSync(events, "utf8").trim().split(/\r?\n/u).filter(Boolean);
        if (lines.length < count) return;
        assert.equal(lines.length, count, "Each submitted run settles exactly once");
        const event = record(JSON.parse(lines[count - 1] ?? "null"), "native settlement");
        assert.equal(event.idle, true, "Native settlement must report idle");
        assert.equal(event.pending, false, "Native settlement must have no pending messages");
        finish();
      } catch (error) { finish(error); }
    };
    const abort = (): void => finish(signal.reason ?? new Error("Settlement observation aborted"));
    const timer = setTimeout(() => finish(new Error(`Missing native settlement ${count}`)), timeoutMs);
    const watcher = watch(events, check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}
function seededReceipts(): RecordValue[] {
  return [
    ...[0, 999, 8_999, 60_000, 125_999, 3_600_000, 4_379_999].map((milliseconds) => ({ version: 1, milliseconds })),
    { version: 2, milliseconds: 18_000, outcome: "stopped" },
    { version: 3, milliseconds: 18_000, outcome: "done", tokens: 54_000 },
    {
      version: 4, milliseconds: 84_000, outcome: "done", tokens: 18_200,
      outputTokens: 367, decodeMilliseconds: 5_000, model: hostileModelName,
      changes: { state: "available", totalFiles: 3, additions: 84, deletions: 21,
        files: [
          { kind: "modified", path: "killeros/worked-for.ts", additions: 46, deletions: 12 },
          { kind: "renamed", path: "test/Receipt.test.ts", previousPath: "test/Old.test.ts", additions: 35, deletions: 9 },
          { kind: "added", path: "docs/implemented/change-receipts.md", additions: 3, deletions: 0 },
        ], omittedFiles: 0 },
      checks: [{ label: "npm test", outcome: "passed" }, { label: "npm run check", outcome: "passed" }],
      omittedChecks: { passed: 0, failed: 0 },
    },
    { version: 4, milliseconds: 1.5, outcome: "done", tokens: 1,
      changes: { state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0 },
      checks: [], omittedChecks: { passed: 0, failed: 0 } },
  ];
}

function seedSession(project: string, receipts: unknown[] = seededReceipts()): string {
  const session = SessionManager.create(project, path.join(path.dirname(project), "sessions"));
  session.appendModelChange("receipts-local", "receipt-model");
  session.appendThinkingLevelChange("off");
  session.appendMessage({ role: "user", content: "Seed the receipt history.", timestamp: Date.now() });
  session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Seeded history response." }],
    api: "openai-completions", provider: "receipts-local", model: "receipt-model", stopReason: "stop",
    usage: { input: 900, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 940, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now() });
  for (const data of receipts) session.appendCustomEntry("killeros-worked-for", data);
  const file = session.getSessionFile();
  assert.ok(typeof file === "string");
  return file;
}

test("real Pi validates saved receipt telemetry and corruption", { timeout: 120_000 }, async (t: TestContext) => {
  const family = createFamily("saved-validation");
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    initRepository(family.project);
    writeProviderConfig(family.agent, 1);
    const valid = {
      version: 4, milliseconds: 1_000, outcome: "done", tokens: 1,
      model: "\x1b[31mModel\x1b[0m\n Name\0", outputTokens: 367, decodeMilliseconds: 5_000,
      changes: { state: "available", totalFiles: 1, additions: 1, deletions: 0,
        files: [{ kind: "added", path: "safe\npath.ts", additions: 1, deletions: 0 }], omittedFiles: 0 },
      checks: [{ label: "npm test", outcome: "passed" }], omittedChecks: { passed: 0, failed: 0 },
    };
    const legacy = [
      { outputTokens: 0, decodeMilliseconds: 5_000 }, { outputTokens: 367, decodeMilliseconds: 0 },
      { outputTokens: 1.5, decodeMilliseconds: 5_000 }, { outputTokens: 367, decodeMilliseconds: Infinity },
      { outputTokens: 367, decodeMilliseconds: undefined }, { outputTokens: undefined, decodeMilliseconds: 5_000 },
    ];
    const response = [
      { outputTokens: undefined }, { outputTokens: 0 }, { outputTokens: 1.5 },
      { responseMilliseconds: undefined }, { responseMilliseconds: 0 }, { responseMilliseconds: -1 },
      { responseMilliseconds: NaN }, { responseMilliseconds: Infinity }, { responseMilliseconds: "5000" },
      { decodeMilliseconds: 5_000 },
    ];
    const noRate = [
      ...legacy.map((telemetry) => ({ ...valid, ...telemetry })),
      ...response.map((telemetry) => ({ ...valid, decodeMilliseconds: undefined, responseMilliseconds: 5_000, ...telemetry })),
      { ...valid, model: 42 }, { ...valid, model: "x".repeat(201) },
      { ...valid, decodeMilliseconds: undefined, responseMilliseconds: 5_000, outcome: "failed" },
    ].map((data, index) => ({ ...data, milliseconds: (index + 10) * 1_000 }));
    const corrupt = [
      { ...valid, milliseconds: 1.5 }, { ...valid, tokens: Infinity }, { ...valid, outcome: "unknown" },
      { ...valid, changes: { ...valid.changes, totalFiles: 2 } },
      { ...valid, changes: { ...valid.changes, files: [{ kind: "added", path: "../unsafe", additions: 1, deletions: 0 }] } },
      { ...valid, checks: [{ label: "npm install", outcome: "passed" }] },
      { ...valid, checks: [{ label: "npm test", outcome: "unknown" }] },
      { ...valid, checks: [], omittedChecks: { passed: 1, failed: 0 } },
      { ...valid, changes: { ...valid.changes, files: [{ kind: "modified", path: "binary.bin", additions: 1, deletions: 0, detail: "binary" }] } },
      { ...valid, changes: { ...valid.changes, files: [{ kind: "added", path: "x".repeat(70_000), additions: 1, deletions: 0 }] } },
    ].map((data, index) => index === 0 ? data : { ...data, milliseconds: (index + 40) * 1_000 });
    const savedInputs = [valid, ...noRate,
      { ...valid, milliseconds: 30_000, outputTokens: 1, decodeMilliseconds: 100_000 },
      { ...valid, milliseconds: 31_000, outputTokens: 1, decodeMilliseconds: undefined, responseMilliseconds: 100_000 },
      { ...valid, milliseconds: 32_000, outcome: "failed" }, ...corrupt, undefined, null, [], {}];
    const sessionFile = seedSession(family.project, savedInputs);
    // A hand-edited JSON exponent can overflow on load even though JSON.stringify(Infinity) is null.
    let savedIndex = 0;
    const savedLines = readFileSync(sessionFile, "utf8").trimEnd().split(/\r?\n/u).map((line) => {
      const entry = record(JSON.parse(line), "saved entry");
      if (entry.type !== "custom" || entry.customType !== "killeros-worked-for") return line;
      const data = savedInputs[savedIndex++];
      return JSON.stringify({ ...entry, data }, (_key, value: unknown) => value === Infinity ? "__receipt_infinity__" : value)
        .replaceAll('"__receipt_infinity__"', "1e999");
    });
    assert.equal(savedIndex, savedInputs.length);
    assert.ok(savedLines.some(line => line.includes('"decodeMilliseconds":1e999')));
    assert.ok(savedLines.some(line => line.includes('"responseMilliseconds":1e999')));
    assert.ok(savedLines.some(line => line.includes('"tokens":1e999')));
    writeFileSync(sessionFile, savedLines.join("\n") + "\n");
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--session", sessionFile,
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts")],
      cwd: family.project, env: family.env, cols: 120, rows: 160 });
    const screen = await terminal.waitForScreen((value) => value.includes("× Failed · 32s · ↑ 1 tokens · 73.4 tok/s")
      && value.includes("✓ Done · 31s · ↑ 1 tokens · <0.1 tok/s"), { signal: t.signal });
    const lines = screen.split("\n").map((line) => line.trim());
    assert.equal(lines.filter((line) => /^(?:✓ Done|■ Stopped|× Failed) ·/u.test(line)).length, 23,
      "Malformed saved data must not create receipt headlines");
    assert.ok(lines.includes("✓ Done · 1s · ↑ 1 tokens · 73.4 tok/s · Model Name"));
    for (let index = 0; index < noRate.length; index += 1) {
      const seconds = index + 10;
      const outcome = index === 18 ? "× Failed" : "✓ Done";
      const model = index === 16 || index === 17 ? "" : " · Model Name";
      const rate = index === 16 || index === 17 ? " · 73.4 tok/s" : "";
      assert.ok(lines.includes(`${outcome} · ${seconds}s · ↑ 1 tokens${rate}${model}`), `Saved telemetry vector ${index}`);
    }
    assert.ok(lines.includes("✓ Done · 30s · ↑ 1 tokens · 0.0 tok/s · Model Name"));
    assert.ok(lines.includes("✓ Done · 31s · ↑ 1 tokens · <0.1 tok/s · Model Name"));
    assert.ok(lines.includes("× Failed · 32s · ↑ 1 tokens · 73.4 tok/s · Model Name"));
    for (let seconds = 41; seconds <= 49; seconds += 1) {
      assert.ok(!lines.some((line) => line.includes(` · ${seconds}s ·`)), `Corrupt vector ${seconds} must not render`);
    }
    const before = terminal.sequence;
    terminal.write("\x0f");
    const expanded = await terminal.waitForScreen((value) => value.includes("A safe⏎path.ts +1 −0"),
      { signal: t.signal, after: before });
    assert.ok(expanded.includes("A safe⏎path.ts +1 −0"));
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Saved validation terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
  }
  if (failure !== undefined || cleanupFailures.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Saved receipt validation scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      diagnostics: JSON.stringify({ directory: family.directory, terminal: terminal?.diagnostics() }) });
  }
  await removeDirectoryEventually(family.directory);
});

test("real Pi describes saved observed checks without verification claims", { timeout: 120_000 }, async (t: TestContext) => {
  const family = createFamily("saved-checks");
  const provider = new ReceiptProvider();
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    initRepository(family.project);
    writeProviderConfig(family.agent, await provider.listen());
    const checks = [
      [{ label: "npm test", outcome: "passed" }],
      [{ label: "node --test (focused)", outcome: "passed" }],
      [{ label: "npm test", outcome: "failed" }],
      [{ label: "npm test", outcome: "passed" }, { label: "npm run check", outcome: "failed" }],
      [],
    ];
    const sessionFile = seedSession(family.project, checks.map((entries) => ({
      version: 4, milliseconds: 1, outcome: "done", tokens: 1,
      changes: { state: "available", totalFiles: 1, additions: 1, deletions: 0,
        files: [{ kind: "added", path: "file.ts", additions: 1, deletions: 0 }], omittedFiles: 0 },
      checks: entries, omittedChecks: { passed: 0, failed: 0 },
    })));
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--session", sessionFile,
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts")],
      cwd: family.project, env: family.env, cols: 120, rows: 50 });
    const screen = await terminal.waitForScreen((value) => value.includes("No check recorded")
      && value.includes("Check passed: node --test (focused) ✓"), { signal: t.signal });
    for (const expected of ["Check passed: npm test ✓", "Check passed: node --test (focused) ✓",
      "Check failed: npm test ×", "Checks: 1 passed · 1 failed", "No check recorded"]) {
      assert.ok(screen.includes(expected), `Saved receipt renders ${expected}`);
    }
    assert.doesNotMatch(screen, /Verified|Verification|Not verified/u);
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Saved checks terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await provider.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || provider.errors.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Saved receipt checks scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...provider.errors],
      diagnostics: JSON.stringify({ directory: family.directory, providerRequests: provider.requests.length, terminal: terminal?.diagnostics() }) });
  }
  await removeDirectoryEventually(family.directory);
});

test("real Pi persists and renders complete worked-for receipt data", { timeout: 240_000 }, async (t: TestContext) => {
  const family = createFamily("render");
  initRepository(family.project);
  const provider = new ReceiptProvider();
  let terminal: PiTerminalProcess | undefined;
  const cleanupFailures: unknown[] = [];
  let failure: unknown;
  const screens: RecordValue = {};
  let releaseLiveStream: (() => void) | undefined;
  const liveStreamObserved = new Promise<void>((resolve) => { releaseLiveStream = resolve; });
  try {
    const port = await provider.listen();
    writeProviderConfig(family.agent, port, hostileModelName);
    const observer = receiptObserver(family.directory, true);
    const sessionFile = seedSession(family.project, [
      ...seededReceipts(),
      { version: 1, milliseconds: 125_000 },
      { version: 2, milliseconds: 18_000, outcome: "done" },
      { version: 2, milliseconds: 18_000, outcome: "failed" },
      { version: 3, milliseconds: 18_000, outcome: "stopped", tokens: 999 },
      { version: 3, milliseconds: 18_000, outcome: "failed", tokens: 1_250_000 },
      {},
      { version: 3, milliseconds: 101_000 },
      { version: 3, milliseconds: 102_000, outcome: "done", tokens: -1 },
      { version: 3, milliseconds: 103_000, outcome: "done", tokens: Number.NaN },
      { version: 2, milliseconds: 104_000 },
      { version: 2, milliseconds: 105_000, outcome: "unknown" },
      { version: 1, milliseconds: -1 },
      { version: 1, milliseconds: Number.NaN },
      { version: 4, milliseconds: 84_000, outcome: "done", tokens: 18_200,
        outputTokens: 367, responseMilliseconds: 5_000, model: 42,
        changes: { state: "available", totalFiles: 2, additions: 10, deletions: 2,
          files: [
            { kind: "modified", path: `${"directory/".repeat(8)}file.ts`, additions: 10, deletions: 2 },
            { kind: "added", path: "safe\npath.ts", additions: 0, deletions: 0 },
          ], omittedFiles: 0 },
        checks: [], omittedChecks: { passed: 0, failed: 0 } },
    ]);
    const seeded = workedForEntries(sessionFile);
    assert.equal(seeded.length, 25, "Seeded history must persist the duration boundaries and other durable receipts");
    assert.equal(seeded[9]?.data.model, hostileModelName, "The durable v4 entry keeps the hostile configured text; rendering must sanitize it");
    assert.equal(seeded[9]?.data.decodeMilliseconds, 5_000, "The legacy decode interval persists as its own durable field");
    assert.equal(Object.hasOwn(seeded[9]?.data ?? {}, "responseMilliseconds"), false, "Legacy decode receipts do not acquire the new interval field");
    const responseRate = seeded[24]?.data;
    assert.equal(responseRate?.responseMilliseconds, 5_000, "The response interval persists as its own durable field");
    assert.equal(Object.hasOwn(responseRate ?? {}, "decodeMilliseconds"), false, "Response-interval receipts do not acquire the legacy decode field");
    assert.equal(responseRate?.model, 42, "The saved invalid model value is preserved for the renderer to reject safely");

    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash,powershell,killeros_goal_update",
        "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
        "--extension", observer.extension],
      cwd: family.project, env: family.env, cols: 120, rows: 50 });

    screens.startup = await terminal.waitForScreen((screen) => screen.includes("Worked for 2m 05s")
      && screen.includes("Worked for 1h 12m") && screen.includes("■ Stopped · 18s")
        && screen.includes("✓ Done · 18s · ↑ 54k tokens") && screen.includes("× Failed · 18s · ↑ 1.3M tokens"), { signal: t.signal });
    const startupLines = String(screens.startup).split("\n").map((line) => line.trim());
    assert.equal((String(screens.startup).match(/Worked for 1s/gu) ?? []).length, 2,
      "Zero and subsecond durations both render the minimum; neither rejected v1 time value adds one");
    assert.equal((String(screens.startup).match(/Worked for 2m 05s/gu) ?? []).length, 2,
      "Both the exact 125-second history and the 125.999-second boundary render");
    for (const expected of ["8s", "1m 00s", "2m 05s", "1h 00m", "1h 12m"]) {
      assert.ok(String(screens.startup).includes(`Worked for ${expected}`), `Duration renders ${expected}`);
    }
    for (const expected of ["✓ Done · 18s", "■ Stopped · 18s", "× Failed · 18s",
      "✓ Done · 18s · ↑ 54k tokens", "■ Stopped · 18s · ↑ 999 tokens", "× Failed · 18s · ↑ 1.3M tokens"]) {
      assert.equal(startupLines.filter((line) => line === expected).length, 1, `Historical receipt renders ${expected} exactly once`);
    }
    assert.ok(startupLines.includes("✓ Done · 1m 24s · ↑ 18.2k tokens · 73.4 tok/s · Model Name"),
      "Saved v4 receipt renders its sanitized model and durable throughput line exactly");
    assert.ok(startupLines.includes("✓ Done · 1m 24s · ↑ 18.2k tokens · 73.4 tok/s"),
      "A response-interval receipt renders its rate and omits a non-string model");
    assert.match(String(screens.startup), /Changed 3 files · \+84 −21/u, "Seeded v4 compact change summary renders");
    assert.match(String(screens.startup), /Checks: 2 passed/u, "Seeded v4 compact check summary renders");
    assert.equal(startupLines.filter((line) => /^(?:✓ Done|■ Stopped|× Failed|Worked for )/u.test(line)).length, 16,
      "Exactly the valid saved receipts render a headline; the empty object adds none");
    for (const rejected of ["1m 41s", "1m 42s", "1m 43s", "1m 44s", "1m 45s"]) {
      assert.ok(!String(screens.startup).includes(rejected), `Rejected malformed receipt must not render its unique duration ${rejected}`);
    }
    assert.ok(!String(screens.startup).includes("NaN"), "The malformed seeded entry must not render as a receipt");
    assert.doesNotMatch(String(screens.startup), /(?:✓ Done|■ Stopped|× Failed) · 1s(?: ·|\s*$)/mu,
      "Malformed legacy entries must not render a one-second outcome");

    let frame = 0;
    const atWidth = async (cols: number, content: (screen: string) => boolean, label: string): Promise<string> => {
      assert.ok(terminal);
      const before = terminal.sequence;
      const marker = `Receipt frame ${++frame}: ${cols}`;
      terminal.resize(cols, 100);
      await terminal.submitEditorText(`/receipt-frame ${frame}`, { signal: t.signal });
      const screen = await terminal.waitForScreen(
        (candidate) => candidate.includes(marker) && content(candidate)
          && candidate.split("\n").every((line) => visibleWidth(line) <= cols),
        { signal: t.signal, after: before },
      );
      assert.ok(screen.split("\n").every((line) => visibleWidth(line) <= cols), `${label} respects terminal cells`);
      return screen;
    };

    const beforeExpand = terminal.sequence;
    terminal.write("\x0f");
    screens.expanded = await terminal.waitForScreen((screen) => screen.includes("R test/Old.test.ts → test/Receipt.test.ts +35 −9")
      && screen.includes("directory/directory/"), { signal: t.signal, after: beforeExpand });
    const expandedLines = String(screens.expanded).split("\n").map((line) => line.trim());
    assert.ok(expandedLines.includes("R test/Old.test.ts → test/Receipt.test.ts +35 −9"));
    assert.ok(expandedLines.includes("A docs/implemented/change-receipts.md +3 −0"), "Expanded receipt keeps added-file identity");
    assert.ok(expandedLines.includes("A safe⏎path.ts +0 −0"), "A saved newline path renders as a visible marker, never a line break");
    assert.ok(expandedLines.includes("✓ npm test") && expandedLines.includes("✓ npm run check"), "Expanded receipt lists both observed checks");
    assert.ok(String(screens.expanded).split("\n").every((line) => [...line].length <= 120), "Expanded receipt stays within 120 cells");
    screens.expanded40 = await atWidth(40, (screen) => screen.split("\n").some((line) => line.includes("M directory/")
      && line.includes("+10 −2")), "Expanded receipt at 40 cells");
    assert.ok(String(screens.expanded40).split("\n").every((line) => visibleWidth(line) <= 40), "Expanded receipt stays within 40 cells");
    const beforeCollapse = terminal.sequence;
    terminal.write("\x0f");
    await terminal.waitForScreen((screen) => !screen.includes("M directory/") && screen.includes("+10 −2"),
      { signal: t.signal, after: beforeCollapse });

    screens.width200 = await atWidth(200, (screen) => screen.includes("73.4 tok/s") && screen.includes("Model Name"), "width 200");
    screens.width80 = await atWidth(80, (screen) => screen.includes("73.4 tok/s") && screen.includes("Model Name"), "width 80");
    const width80Lines = String(screens.width80).split("\n").map((line) => line.trim());
    for (const expected of ["✓ Done · 1m 24s · ↑ 18.2k tokens · 73.4 tok/s · Model Name",
      "Changed 3 files · +84 −21", "Checks: 2 passed"]) {
      assert.ok(width80Lines.includes(expected), `Saved v4 compact receipt renders ${expected} at 80 cells`);
    }
    screens.width52 = await atWidth(52, (screen) => screen.includes("73.4 tok/s")
      && screen.includes("Changed 3 files") && !screen.includes("Model Name"), "width 52");
    screens.width40 = await atWidth(40, (screen) => screen.includes("Changed 3 files"), "width 40");
    screens.width39 = await atWidth(39, (screen) => screen.includes("3 files") && !screen.includes("Changed 3 files"), "width 39");
    screens.width30 = await atWidth(30, (screen) => screen.includes("Done"), "width 30");

    terminal.resize(120, 34);
    // Start the measured hold only after native output proves Pi is processing this response.
    provider.plan({ kind: "text", content: "Live receipt response.", outputTokens: 400,
      holdMs: 2_000, holdUntil: liveStreamObserved });
    const beforeSubmit = terminal.sequence;
    const activeTerminal = terminal;
    const [, live] = await Promise.all([
      waitForReceiptSettlement(observer.events, 1, t.signal),
      (async () => {
        activeTerminal.write(`add one file${enter}`);
        await activeTerminal.waitForScreen((screen) => screen.includes("Live receipt response."), { signal: t.signal, after: beforeSubmit });
        writeFileSync(path.join(family.project, "added.txt"), "one\ntwo\nthree\n");
        releaseLiveStream?.();
        return await activeTerminal.waitForScreen((screen) => /✓ Done · \d+s · ↑ [\d.]+[kM]? tokens · [\d.]+ tok\/s · receipt-model/u.test(screen)
          && screen.includes("Changed 1 file") && screen.includes("+3"), { signal: t.signal });
      })(),
    ]);
    screens.live = live;
    assert.doesNotMatch(live, /Change receipt unavailable/u, "A live git change must produce an available receipt");
    const liveLines = live.split("\n").map((line) => line.trim());
    assert.ok(liveLines.some((line) => line.includes("✓ Done") && line.includes("receipt-model")),
      "The live receipt attributes the concrete model id");
    assert.ok(!liveLines.some((line) => line.includes("receipt-model") && line.includes("Model Name")),
      "The hostile configured display name never becomes receipt attribution");
    assert.equal(provider.requests[0]?.model, "receipt-model", "The provider request keeps the native model id");

    const after = workedForEntries(sessionFile);
    assert.equal(after.length, 26, "Exactly one durable entry is appended for the settled live run");
    assert.deepEqual(after.slice(0, 25), seeded, "Older history is preserved unchanged by the live append");
    const liveEntry = after[25]?.data;
    assert.equal(liveEntry?.version, 4, "Live entry uses the durable version 4 schema");
    assert.equal(liveEntry?.outcome, "done");
    assert.ok(typeof liveEntry?.tokens === "number" && liveEntry.tokens > 0, "Task tokens count the live turn's usage delta");
    assert.equal(liveEntry?.outputTokens, 400, "Throughput counts the provider's complete output usage");
    assert.ok(typeof liveEntry?.responseMilliseconds === "number" && liveEntry.responseMilliseconds >= 2_000, "Held stream duration is measured from assistant start");
    assert.equal(liveEntry?.model, "receipt-model", "Single-model runs attribute the concrete model id");
    const assertMeasuredIntervals = (entry: RecordValue, run: number, calls: number): void => {
      const observations = readFileSync(observer.timings, "utf8").trim().split(/\r?\n/u)
        .map((line) => record(JSON.parse(line), "native receipt timing"));
      const starts = observations.flatMap((event, index) => event.event === "agent_start" ? [index] : []);
      const events = observations.slice(starts[run - 1], starts[run]);
      const assistantStarts = events.filter((event) => event.event === "message_start" && event.role === "assistant");
      const assistantEnds = events.filter((event) => event.event === "message_end" && event.role === "assistant");
      assert.equal(assistantStarts.length, calls);
      assert.equal(assistantEnds.length, calls);
      let elapsed = 0;
      for (const [index, start] of assistantStarts.entries()) {
        const end = assistantEnds[index];
        assert.ok(typeof start.at === "number" && typeof end?.at === "number");
        elapsed += end.at - start.at;
      }
      assert.ok(typeof entry.responseMilliseconds === "number");
      assert.ok(Math.abs(entry.responseMilliseconds - elapsed) <= 50,
        `Saved assistant interval ${entry.responseMilliseconds} agrees with independently observed ${elapsed}`);
      assert.ok(typeof entry.milliseconds === "number" && entry.milliseconds >= elapsed + 300,
        "Task duration includes the real pre-settlement delay while response duration excludes it");
    };
    assertMeasuredIntervals(liveEntry, 1, 1);
    const changes = liveEntry?.changes as RecordValue | undefined;
    assert.equal(changes?.state, "available");
    assert.equal(changes?.totalFiles, 1);
    assert.equal(changes?.additions, 3);
    const files = changes?.files as RecordValue[] | undefined;
    assert.equal(files?.[0]?.path, "added.txt");
    assert.equal(files?.[0]?.kind, "added");
    assert.equal(provider.requests.length, 1, "The live turn makes exactly one provider request");

    // Frozen WorkedFor 379: zero-output attribution, then a native reload of the produced receipt.
    const zeroLine = /^✓ Done · .+ · ↑ 0 tokens · receipt-model$/u;
    provider.plan({ kind: "text", content: "", outputTokens: 0, inputTokens: 0 });
    const beforeZero = terminal.sequence;
    await Promise.all([
      waitForReceiptSettlement(observer.events, 2, t.signal),
      Promise.resolve().then(() => activeTerminal.write(`zero output turn${enter}`)),
    ]);
    const zeroScreen = await terminal.waitForScreen(
      (screen) => screen.split("\n").some((line) => zeroLine.test(line.trim())),
      { signal: t.signal, after: beforeZero },
    );
    screens.zeroOutput = zeroScreen;
    assert.equal(zeroScreen.split("\n").map((line) => line.trim()).filter((line) => zeroLine.test(line)).length, 1,
      "The zero-output receipt renders exactly once with its concrete model id and no rate");
    const afterZero = workedForEntries(sessionFile);
    assert.equal(afterZero.length, 27, "Zero-output settlement appends exactly one durable receipt");
    assert.deepEqual(afterZero.slice(0, 26), after, "The zero-output append preserves the produced positive-output receipt unchanged");
    const zeroEntry = afterZero[26]?.data;
    assert.equal(zeroEntry?.version, 4, "Zero-output entry uses the durable version 4 schema");
    assert.equal(zeroEntry?.outcome, "done");
    assert.equal(zeroEntry?.tokens, 0, "Zero input and output usage contribute no task tokens");
    assert.equal(Object.hasOwn(zeroEntry ?? {}, "outputTokens"), false, "Zero output persists no throughput token count");
    assert.equal(Object.hasOwn(zeroEntry ?? {}, "responseMilliseconds"), false, "Zero output persists no throughput interval");
    assert.equal(zeroEntry?.model, "receipt-model", "Zero output still persists the exact concrete model id");
    assert.notEqual(zeroEntry?.model, hostileModelName, "The hostile configured display name is never persisted as attribution");
    assert.equal((zeroEntry?.changes as RecordValue | undefined)?.totalFiles, 0, "The zero-output turn changes no files");
    assert.equal(provider.requests.length, 2, "The zero-output turn makes exactly one more provider request");
    assert.equal(provider.requests[1]?.model, "receipt-model", "The zero-output request keeps the native model id");

    terminal.resize(120, 100);
    const beforeReload = provider.requests.length;
    const reloadStart = terminal.sequence;
    terminal.write("/reload");
    await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.includes("❯") && line.includes("/reload")),
      { signal: t.signal, after: reloadStart });
    const reloadSubmitted = terminal.sequence;
    terminal.write(enter);
    const reloaded = await terminal.waitForScreen((screen) => screen.includes("Reloaded")
      && screen.split("\n").some((line) => zeroLine.test(line.trim())), { signal: t.signal, after: reloadSubmitted });
    screens.reloaded = reloaded;
    assert.equal(provider.requests.length, beforeReload, "Native reload starts no provider request");
    assert.deepEqual(workedForEntries(sessionFile), afterZero, "Reload re-reads the same produced receipt without rewriting its durable data");

    const zero80 = await atWidth(80, (screen) => screen.split("\n").some((line) => zeroLine.test(line.trim())),
      "Reloaded zero-output receipt at 80 cells");
    screens.zeroWidth80 = zero80;
    assert.ok(zero80.split("\n").some((line) => zeroLine.test(line.trim())),
      "The same produced zero-output receipt renders at 80 cells after reload");

    const zero30 = await atWidth(30, (screen) => screen.split("\n").some((line) => line.includes("↑ 0 tokens")),
      "Reloaded zero-output receipt at 30 cells");
    screens.zeroWidth30 = zero30;
    assert.ok(zero30.split("\n").some((line) => line.includes("↑ 0 tokens")),
      "The same produced zero-output receipt remains visible at 30 cells after reload");
    assert.ok(zero30.split("\n").every((line) => visibleWidth(line) <= 30),
      "The produced receipt and every screen line stay within 30 cells after reload");
    assert.equal(provider.requests.length, 2, "The complete scenario makes exactly two provider requests");

    // Keep the existing reload/history assertions above, then exercise multi-call metrics in the same native session.
    terminal.resize(120, 50);
    let settlement = 2;
    const metricTurn = async (prompt: string, steps: Step[]): Promise<RecordValue> => {
      const beforeEntries = workedForEntries(sessionFile);
      const beforeRequests = provider.requests.length;
      provider.plan(...steps);
      await Promise.all([
        waitForReceiptSettlement(observer.events, ++settlement, t.signal),
        activeTerminal.submitEditorText(prompt, { signal: t.signal }),
      ]);
      const entries = workedForEntries(sessionFile);
      assert.equal(entries.length, beforeEntries.length + 1);
      assert.deepEqual(entries.slice(0, -1), beforeEntries, "Each metrics turn preserves earlier receipts");
      assert.equal(provider.requests.length, beforeRequests + steps.length);
      const entry = entries.at(-1)?.data;
      assert.ok(entry);
      return entry;
    };
    const command = 'node -e "setTimeout(() => console.log(\'tool interval complete\'), 600)"';
    const weighted = await metricTurn("measure weighted response intervals", [
      { kind: "tool", command, outputTokens: 0, holdMs: 300, responseModel: "wire-stable" },
      { kind: "text", content: "Weighted response complete.", outputTokens: 100, holdMs: 300, responseModel: "wire-stable" },
    ]);
    assert.equal(weighted.outputTokens, 100);
    assert.equal(weighted.model, "wire-stable", "Stable concrete response id overrides the requested model id");
    assertMeasuredIntervals(weighted, 3, 2);
    assert.ok(typeof weighted.responseMilliseconds === "number" && weighted.responseMilliseconds >= 600,
      "The zero-output call contributes its assistant duration to the positive-output task");
    assert.ok(typeof weighted.milliseconds === "number" && weighted.milliseconds >= weighted.responseMilliseconds + 850,
      "Native tool execution and pre-settlement delay stay outside the summed assistant intervals");

    const allZero = await metricTurn("measure an all zero multi call turn", [
      { kind: "tool", command, outputTokens: 0, holdMs: 150 },
      { kind: "text", content: "", outputTokens: 0, holdMs: 150 },
    ]);
    assert.equal(Object.hasOwn(allZero, "outputTokens"), false);
    assert.equal(Object.hasOwn(allZero, "responseMilliseconds"), false);
    assert.equal(allZero.model, "receipt-model");

    const mixed = await metricTurn("measure mixed concrete response ids", [
      { kind: "tool", command, outputTokens: 20, holdMs: 150, responseModel: "wire-routed" },
      { kind: "text", content: "Mixed response complete.", outputTokens: 80, holdMs: 150 },
    ]);
    assert.equal(mixed.outputTokens, 100);
    assert.equal(Object.hasOwn(mixed, "model"), false, "Mixed concrete response ids omit whole-task attribution");
    assertMeasuredIntervals(mixed, 5, 2);
    const reset = await metricTurn("verify next task attribution resets", [
      { kind: "text", content: "Attribution reset.", outputTokens: 40, holdMs: 150 },
    ]);
    assert.equal(reset.model, "receipt-model");
    assert.equal(reset.outputTokens, 40);
    assertMeasuredIntervals(reset, 6, 1);
    for (const reasoningTokens of [90, undefined]) {
      const reasoning = await metricTurn("measure output without a text delta", [
        { kind: "text", content: "", reasoningContent: "Reasoning-only response.", reasoningTokens, outputTokens: 100, holdMs: 200 },
      ]);
      assert.equal(reasoning.outputTokens, 100, "Output usage includes reasoning without double-counting the breakdown");
      assertMeasuredIntervals(reasoning, settlement, 1);
    }
    const mixedFailure = await metricTurn("measure mixed model failure", [
      { kind: "tool", command, outputTokens: 100, holdMs: 150, responseModel: "wire-failed" },
      { kind: "fail" },
    ]);
    assert.equal(mixedFailure.outcome, "failed");
    for (const field of ["model", "outputTokens", "responseMilliseconds"]) {
      assert.equal(Object.hasOwn(mixedFailure, field), false, `Mixed failed task omits ${field}`);
    }
    const recovered = await metricTurn("verify zero output attribution after failure", [
      { kind: "text", content: "", outputTokens: 0, holdMs: 100 },
    ]);
    assert.equal(recovered.model, "receipt-model");
    assert.equal(Object.hasOwn(recovered, "outputTokens"), false);
    for (const finishReason of ["length", "tool_calls"] as const) {
      const incomplete = await metricTurn(`observe native ${finishReason} outcome`, [
        { kind: "text", content: "Incomplete provider response.", outputTokens: 100, holdMs: 150, finishReason },
      ]);
      assert.equal(incomplete.outcome, "failed", `Native ${finishReason} is not a successful completion`);
      assert.equal(Object.hasOwn(incomplete, "outputTokens"), false);
      assert.equal(Object.hasOwn(incomplete, "responseMilliseconds"), false);
    }
    const subsequent = await metricTurn("finish normally after incomplete outcomes", [
      { kind: "text", content: "Normal subsequent task.", outputTokens: 40, holdMs: 150 },
    ]);
    assert.equal(subsequent.outcome, "done", "A new run uses its own final assistant reason");
    mkdirSync(path.join(family.project, "test"));
    writeFileSync(path.join(family.project, "test/WorkedFor.test.ts"), 'process.exit(process.execArgv.includes("--experimental-strip-types") ? 1 : 0);\n');
    const focused = await metricTurn("run focused native process checks", [
      { kind: "tool", command: "node --test test/WorkedFor.test.ts" },
      { kind: "tool", toolName: "powershell", command: "node --test --experimental-strip-types test/WorkedFor.test.ts" },
      { kind: "text", content: "Focused checks complete.", outputTokens: 40, holdMs: 150 },
    ]);
    assert.deepEqual(focused.checks, [
      { label: "node --test (focused)", outcome: "passed" },
      { label: "node --test (focused)", outcome: "failed" },
    ]);
    assert.doesNotMatch(JSON.stringify(focused), /(?:WorkedFor|Footer)\.test\.ts/u,
      "Observed focused checks persist canonical labels without paths");
    assert.equal(provider.requests.length, 20, "All native metrics histories use exactly their scripted provider requests");
    const beforeGoal = workedForEntries(sessionFile);
    const timingsBeforeGoal = readFileSync(observer.timings, "utf8").trim().split(/\r?\n/u).length;
    provider.plan(
      { kind: "tool", toolName: "killeros_goal_update", outputTokens: 100, holdMs: 150,
        decision: { status: "continue", evidence: "Measured the first accepted turn.", nextAction: "Complete the second accepted turn." } },
      { kind: "text", content: "First goal turn finished.", outputTokens: 40, holdMs: 150 },
      { kind: "tool", toolName: "killeros_goal_update", outputTokens: 100, holdMs: 150,
        decision: { status: "complete", evidence: "Measured both accepted turns and their independent receipts." } },
      { kind: "text", content: "Second goal turn finished.", outputTokens: 100, holdMs: 150 },
    );
    await Promise.all([
      waitForReceiptSettlement(observer.events, settlement + 2, t.signal, 40_000),
      activeTerminal.submitEditorText("/goal Count receipts across two accepted goal turns", { signal: t.signal }),
    ]);
    const goalReceipts = workedForEntries(sessionFile);
    assert.equal(goalReceipts.length, beforeGoal.length + 2);
    assert.deepEqual(goalReceipts.slice(0, beforeGoal.length), beforeGoal);
    for (const [index, entry] of goalReceipts.slice(-2).entries()) {
      assert.equal(entry.data.outcome, "done");
      assert.equal(entry.data.tokens, index === 0 ? 1_940 : 2_000, "Each goal turn counts only its own two provider calls");
      assert.equal(entry.data.outputTokens, index === 0 ? 140 : 200);
    }
    const goalStarts = readFileSync(observer.timings, "utf8").trim().split(/\r?\n/u).slice(timingsBeforeGoal)
      .map((line) => record(JSON.parse(line), "native goal timing")).filter((event) => event.event === "agent_start");
    assert.deepEqual(goalStarts.map((event) => event.receiptCount), [beforeGoal.length, beforeGoal.length + 1],
      "First goal receipt is already durable before the authorized second turn starts");
    assert.equal(provider.requests.length, 24);
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    releaseLiveStream?.();
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Receipt render terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await provider.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || provider.errors.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Receipt durable-render scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...provider.errors.map((fault) => fault instanceof Error ? fault : new Error(String(fault)))],
      diagnostics: JSON.stringify({ directory: family.directory, platform: process.platform, node: process.version, pi: piVersion,
        providerRequests: provider.requests.length, providerErrors: provider.errors, terminal: terminal?.diagnostics(), screens }),
    });
  }
  await removeDirectoryEventually(family.directory);
});

test("real Pi records only canonical observed check commands", { timeout: 90_000 }, async (t: TestContext) => {
  const family = createFamily("recognition");
  const provider = new ReceiptProvider();
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    initRepository(family.project);
    const bin = path.join(family.directory, "check-bin");
    mkdirSync(bin);
    // Owned external command fixtures return a known status. KillerOS still receives
    // actual native bash tool results; these labels describe observations, not verification.
    const executable = "#!/bin/sh\nexit 0\n";
    for (const name of ["npm", "pnpm", "yarn", "bun", "python", "py", "node", "cargo", "dotnet", "mvn", "go", "pytest", "gradle", "gradlew", "gradlew.bat", ".gradlew", ".gradlew.bat"]) {
      writeFileSync(path.join(bin, name), executable);
    }
    for (const name of ["gradlew", "gradlew.bat"]) writeFileSync(path.join(family.project, name), executable);
    family.env.PATH = bin + path.delimiter + family.env.PATH;
    const port = await provider.listen();
    writeProviderConfig(family.agent, port);
    const observer = receiptObserver(family.directory);
    const sessionFile = path.join(family.directory, "recognition.jsonl");
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash",
        "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
        "--extension", observer.extension],
      cwd: family.project, env: family.env, cols: 120, rows: 40 });
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("ctx 100%"), { signal: t.signal });
    const canonical = [
      ...["npm", "pnpm", "yarn", "bun"].flatMap((manager) => [`${manager} test`,
        ...["test", "check", "lint", "typecheck", "build"].map((script) => `${manager} run ${script}`)]),
      "python -m pytest", "py -m pytest", "node --test", "cargo clippy", "cargo check", "cargo test",
      "dotnet test", "mvn verify", "mvn test", "go test", "go vet", "pytest",
      ...["gradle", "gradlew", "gradlew.bat", "./gradlew", "./gradlew.bat", ".\\gradlew", ".\\gradlew.bat"]
        .flatMap((command) => [`${command} test`, `${command} check`]),
    ];
    const rejected = ["npm test --if-present", "npm test --ignore-scripts", "npm test --help", "npm test -- --runInBand",
      "node --test --help", "pytest tests/unit", "go test ./...", "API_TOKEN=secret npm test", "npm test || true",
      "npm test && npm run build", "npm test\nnpm run build", "node --test --experimental-strip-types",
      "node --test --test-name-pattern name test/WorkedFor.test.ts", "node --test test/WorkedFor.test.ts test/Footer.test.ts",
      "node --test ../test/WorkedFor.test.ts", 'node --test "test/Worked For.test.ts"', "node --test test/*.test.ts",
      "node --test test/WorkedFor.test.ts || true", "node --test test/WorkedFor.test.ts # focused",
      "API_TOKEN=secret node --test test/WorkedFor.test.ts", "node --test test/test-helper.ts", "node --test -test/WorkedFor.test.ts",
      "node --test /test/WorkedFor.test.ts", "node --test C:\\test\\WorkedFor.test.ts", "node --test https://example.test/WorkedFor.test.ts",
      "node --test test/./WorkedFor.test.ts", "node --test test/foo.test.TS", "node --test test/foo.test.tsx",
      "node --test test/$(printf WorkedFor).test.ts", "node --test test/WorkedFor.test.ts>receipt", "node --test test/WorkedFor.test.ts\n"];
    const focused = ["node --test test/WorkedFor.test.ts", "node --test --experimental-strip-types test/WorkedFor.test.ts",
      " \tnode --test test\\WorkedFor.test.ts\t "];
    let settlements = 0;
    let expectedRequests = 0;
    const batches = [
      ...[0, 20, 40].map((offset) => ({ commands: canonical.slice(offset, offset + 20).map((command) => ` \t${command}\t `),
        expected: canonical.slice(offset, offset + 20).map((label) => ({ label, outcome: "passed" })) })),
      ...[0, 20].map((offset) => ({ commands: rejected.slice(offset, offset + 20), expected: [] })),
      { commands: focused, expected: focused.map(() => ({ label: "node --test (focused)", outcome: "passed" })) },
    ];
    for (const batch of batches) {
      provider.plan(...batch.commands.map((command): Step => ({ kind: "tool", command })),
        { kind: "text", content: `Check recognition batch ${settlements + 1} complete.` });
      expectedRequests += batch.commands.length + 1;
      await Promise.all([
        waitForReceiptSettlement(observer.events, ++settlements, t.signal, 40_000),
        terminal.submitEditorText(`run recognition batch ${settlements}`, { signal: t.signal }),
      ]);
      const entries = workedForEntries(sessionFile);
      assert.equal(entries.length, settlements);
      assert.deepEqual(entries.at(-1)?.data.checks, batch.expected);
      assert.deepEqual(entries.at(-1)?.data.omittedChecks, { passed: 0, failed: 0 });
      assert.equal(provider.requests.length, expectedRequests);
    }
    assert.equal(canonical.length, 50);
    assert.equal(provider.requests.length, 90);
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Check recognition cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await provider.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || provider.errors.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Receipt check-recognition scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...provider.errors],
      diagnostics: JSON.stringify({ directory: family.directory, requests: provider.requests.length, terminal: terminal?.diagnostics() }) });
  }
  await removeDirectoryEventually(family.directory);
});

test("real Pi bounds observed checks and warns once for unavailable change collection", { timeout: 90_000 }, async (t: TestContext) => {
  const family = createFamily("overflow");
  const provider = new ReceiptProvider();
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    initRepository(family.project);
    const port = await provider.listen();
    writeProviderConfig(family.agent, port);
    // The tools still run normally; only this owned repository's Git metadata is unreadable.
    writeFileSync(path.join(family.project, ".git/config"), "[invalid configuration\n");
    const observer = receiptObserver(family.directory);
    const sessionFile = path.join(family.directory, "overflow.jsonl");
    const attempts = Array.from({ length: 22 }, (_, index) => ({
      label: index % 2 === 0 ? "npm test" : "npm run check", outcome: index % 2 === 0 ? "passed" : "failed",
    }));
    provider.plan(...attempts.map(({ label }): Step => ({ kind: "tool", command: label })),
      { kind: "text", content: "All observed checks completed." },
      { kind: "text", content: "Second unavailable collection completed." });
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash",
        "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
        "--extension", observer.extension],
      cwd: family.project, env: family.env, cols: 120, rows: 80 });
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("ctx 100%"), { signal: t.signal });
    await Promise.all([
      waitForReceiptSettlement(observer.events, 1, t.signal, 40_000),
      terminal.submitEditorText("run all observed checks", { signal: t.signal }),
    ]);
    const warning = "Warning: Change receipt unavailable: error";
    await terminal.waitForScreen((screen) => screen.includes(warning) && screen.includes("Checks: 11 passed · 11 failed"), { signal: t.signal });
    const first = workedForEntries(sessionFile);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]?.data.checks, attempts.slice(0, 20), "The first twenty real check attempts retain their order and outcomes");
    assert.deepEqual(first[0]?.data.omittedChecks, { passed: 1, failed: 1 });
    assert.deepEqual(first[0]?.data.changes, { state: "unavailable", reason: "error" });
    await Promise.all([
      waitForReceiptSettlement(observer.events, 2, t.signal),
      terminal.submitEditorText("repeat unavailable collection", { signal: t.signal }),
    ]);
    const second = workedForEntries(sessionFile);
    assert.equal(second.length, 2);
    assert.deepEqual(second[0], first[0]);
    assert.deepEqual(second[1]?.data.changes, { state: "unavailable", reason: "error" });
    assert.deepEqual(second[1]?.data.checks, [], "A later task resets its observed checks");
    const screen = await terminal.waitForScreen((candidate) => candidate.includes("Second unavailable collection completed.")
      && candidate.includes(warning), { signal: t.signal });
    assert.equal(screen.split(warning).length - 1, 1, "The unavailable warning appears exactly once across both settled runs");
    assert.equal(provider.requests.length, 24);
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Overflow terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await provider.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || provider.errors.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Receipt check-overflow scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...provider.errors],
      diagnostics: JSON.stringify({ directory: family.directory, requests: provider.requests.length, terminal: terminal?.diagnostics() }) });
  }
  await removeDirectoryEventually(family.directory);
});

test("real Pi receipt lifecycle settles, discards, and survives navigation at the correct boundary", { timeout: 300_000, skip: piRpcShutdownSkip }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const diagnostics: RecordValue[] = [];
  const directories: string[] = [];

  // Family A: one trusted TUI session with normal, checked, stopped, and failed settlements.
  {
    const family = createFamily("lifecycle");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      const observer = receiptObserver(family.directory);
      const sessionFile = path.join(family.directory, "session-a.jsonl");
      provider.plan({ kind: "text", content: "Normal settlement.", outputTokens: 40 });
      provider.plan({ kind: "tool", command: "npm run check" }, { kind: "text", content: "Single check completed.", outputTokens: 30 });
      provider.plan(
        { kind: "tool", command: "npm test -- --runInBand" },
        { kind: "tool", command: "npm test" },
        { kind: "tool", command: "npm run check" },
        { kind: "tool", command: "npm test || true" },
        { kind: "text", content: "Check completed.", outputTokens: 30 },
      );
      provider.plan({ kind: "tool", command: "npm test", outputTokens: 100, holdMs: 150 }, { kind: "text", content: "Slow cancellation.", outputTokens: 40, holdMs: 60_000 });
      provider.plan({ kind: "tool", command: "node -e \"console.log('before failure')\"", outputTokens: 100, holdMs: 150 }, { kind: "fail" });
      terminal = new PiTerminalProcess({ file: process.execPath,
        args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash",
          "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"), "--extension", observer.extension],
        cwd: family.project, env: family.env, cols: 120, rows: 34 });
      const submit = async (text: string): Promise<number> => {
        assert.ok(terminal);
        const after = terminal.sequence;
        terminal.write(`${text}${enter}`);
        return after;
      };
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("ctx 100%"), { signal: t.signal });
      const beforeNormal = await submit("normal turn");
      screens.normal = await terminal.waitForScreen((screen) => screen.includes("Normal settlement.") && /✓ Done · \d+s/u.test(screen)
        && screen.includes("No files changed"), { signal: t.signal, after: beforeNormal });

      await waitForReceiptSettlement(observer.events, 1, t.signal);
      const beforeCheck = await submit("run the check");
      screens.singleCheck = await terminal.waitForScreen((screen) => screen.includes("Single check completed.") && screen.includes("Check failed: npm run check ×"), { signal: t.signal, after: beforeCheck });

      await waitForReceiptSettlement(observer.events, 2, t.signal);
      const beforeOrderedChecks = await submit("run the ordered checks");
      screens.check = await terminal.waitForScreen((screen) => screen.includes("Check completed.") && screen.includes("Checks: 1 passed · 1 failed"), { signal: t.signal, after: beforeOrderedChecks });

      await waitForReceiptSettlement(observer.events, 3, t.signal);
      const beforeStopped = await submit("cancellable turn");
      await terminal.waitForScreen((screen) => screen.includes("Slow cancellation."), { signal: t.signal, after: beforeStopped });
      writeFileSync(path.join(family.project, "stopped-change.txt"), "kept\n");
      terminal.write("\x1b");
      const stopped = await terminal.waitForScreen((screen) => /■ Stopped · \d+s/u.test(screen) && screen.includes("Changed 1 file"), { signal: t.signal });
      screens.stopped = stopped;
      const stoppedLine = stopped.split("\n").find((line) => /■ Stopped · \d+s/u.test(line)) ?? "";
      assert.doesNotMatch(stoppedLine, /tok\/s/u, "A stopped run must not display a newly calculated rate");

      await waitForReceiptSettlement(observer.events, 4, t.signal);
      const beforeFailed = await submit("failing turn");
      const failed = await terminal.waitForScreen((screen) => /× Failed · \d+s/u.test(screen), { signal: t.signal, after: beforeFailed });
      screens.failed = failed;
      assert.doesNotMatch(failed, /Change receipt unavailable/u, "Provider failure must not corrupt the change receipt");
      const failedLine = failed.split("\n").find((line) => /× Failed · \d+s/u.test(line)) ?? "";
      assert.doesNotMatch(failedLine, /tok\/s/u, "A failed run must not display a newly calculated rate");

      await waitForReceiptSettlement(observer.events, 5, t.signal);
      const entries = workedForEntries(sessionFile);
      assert.equal(entries.length, 5, "Each settled TUI turn appends exactly one durable receipt");
      assert.equal(entries[0]?.data.outcome, "done", "Normal settlement maps stop to done");
      assert.deepEqual(entries[1]?.data.checks, [{ label: "npm run check", outcome: "failed" }]);
      const checkedEntry = entries[2]?.data;
      assert.equal(checkedEntry?.outcome, "done");
      assert.equal(checkedEntry?.version, 4);
      assert.deepEqual(checkedEntry?.omittedChecks, { passed: 0, failed: 0 });
      assert.ok(typeof checkedEntry?.milliseconds === "number" && Number.isFinite(checkedEntry.milliseconds) && checkedEntry.milliseconds >= 0);
      assert.ok(typeof checkedEntry?.tokens === "number" && Number.isFinite(checkedEntry.tokens) && checkedEntry.tokens >= 0);
      assert.deepEqual(checkedEntry?.checks, [
        { label: "npm test", outcome: "passed" },
        { label: "npm run check", outcome: "failed" },
      ], "Recognized checks retain their outcomes and order; arguments and compound commands are excluded");
      assert.deepEqual(checkedEntry?.changes, {
        state: "available", totalFiles: 1, additions: 2, deletions: 0,
        files: [{ kind: "added", path: "checked.txt", additions: 2, deletions: 0 }], omittedFiles: 0,
      }, "The turn retains its initial Git baseline across the tool-call continuations");
      const stoppedEntry = entries[3]?.data;
      assert.equal(stoppedEntry?.outcome, "stopped", "Cancellation records Stopped");
      assert.equal(Object.hasOwn(stoppedEntry ?? {}, "outputTokens"), false, "Stopped runs persist no throughput tokens");
      assert.equal(Object.hasOwn(stoppedEntry ?? {}, "responseMilliseconds"), false, "Stopped runs persist no throughput interval");
      assert.deepEqual(stoppedEntry?.checks, [{ label: "npm test", outcome: "passed" }],
        "Cancellation preserves checks completed earlier in the same turn");
      const stoppedChanges = stoppedEntry?.changes as RecordValue | undefined;
      assert.equal(stoppedChanges?.state, "available");
      assert.equal(stoppedChanges?.totalFiles, 1, "Cancellation preserves observed changes");
      assert.equal(stoppedChanges?.additions, 1);
      assert.equal(stoppedChanges?.deletions, 0);
      assert.deepEqual(stoppedChanges?.files, [{ kind: "added", path: "stopped-change.txt", additions: 1, deletions: 0 }],
        "The stopped receipt records the actual file written during the turn");
      const failedEntry = entries[4]?.data;
      assert.equal(failedEntry?.outcome, "failed", "Provider error maps to failed");
      assert.equal(Object.hasOwn(failedEntry ?? {}, "outputTokens"), false, "Failed runs persist no throughput tokens");
      assert.equal(Object.hasOwn(failedEntry ?? {}, "responseMilliseconds"), false, "Failed runs persist no throughput interval");
      assert.equal(provider.requests.length, 12, "Turns use exactly their planned provider requests");
      assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "lifecycle-tui", error: error instanceof Error ? error.message : String(error),
        providerRequests: provider.requests.length, providerErrors: provider.errors, terminal: terminal?.diagnostics(), screens });
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Lifecycle terminal cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
      failures.push(...provider.errors);
    }
  }

  // Family B: non-TUI RPC sessions append no receipts at all.
  {
    const family = createFamily("rpc");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptProvider();
    let rpc: PiRpcProcess | undefined;
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      const observer = receiptObserver(family.directory);
      const sessionFile = path.join(family.directory, "session-b.jsonl");
      provider.plan({ kind: "text", content: "Rpc settlement.", outputTokens: 20 });
      rpc = new PiRpcProcess({ cliPath, cwd: family.project, env: family.env,
        args: ["--mode", "rpc", "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash",
          "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"), "--extension", observer.extension] });
      const state = record((await rpc.command("get_state", {}, { timeoutMs: 30_000, signal: t.signal })).data, "RPC state");
      assert.equal(stringField(state, "sessionFile"), sessionFile);
      await rpc.command("prompt", { message: "rpc turn" }, { timeoutMs: 60_000, signal: t.signal });
      const settled = await rpc.waitFor((record) => record.type === "agent_settled", { signal: t.signal, timeoutMs: 60_000 });
      assert.ok(isRecord(settled));
      assert.equal(provider.requests.length, 1);
      await waitForReceiptSettlement(observer.events, 1, t.signal);
      assert.deepEqual(await rpc.close(), { exit: { code: 0, signal: null }, forced: false });
      const entries = workedForEntries(sessionFile);
      assert.equal(entries.length, 0, "Non-TUI modes append no worked-for receipts");
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "rpc", error: error instanceof Error ? error.message : String(error),
        providerRequests: provider.requests.length, providerErrors: provider.errors, rpc: rpc?.diagnostics() });
    } finally {
      if (rpc) {
        try {
          const result = await rpc.close();
          if (result.forced || result.exit.code !== 0) failures.push(new Error(`RPC cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
      failures.push(...provider.errors);
    }
  }

  // Family C: untrusted projects start no change collection and append no receipt.
  {
    const family = createFamily("untrusted");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      const observer = receiptObserver(family.directory);
      const sessionFile = path.join(family.directory, "session-c.jsonl");
      provider.plan({ kind: "text", content: "Untrusted settlement.", outputTokens: 20 });
      terminal = new PiTerminalProcess({ file: process.execPath,
        args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash",
          "--session", sessionFile, "--offline", "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"), "--extension", observer.extension],
        cwd: family.project, env: family.env, cols: 120, rows: 34 });
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("not trusted"), { signal: t.signal });
      const before = terminal.sequence;
      terminal.write(`untrusted turn${enter}`);
      const untrusted = await terminal.waitForScreen((screen) => screen.includes("Untrusted settlement."), { signal: t.signal, after: before });
      await waitForReceiptSettlement(observer.events, 1, t.signal);
      assert.deepEqual(await terminal.close(), { code: 0, forced: false });
      screens.untrusted = terminal.screen();
      assert.doesNotMatch(untrusted + terminal.screen(), /Worked for|✓ Done|■ Stopped|× Failed/u, "Untrusted projects must not render a receipt");
      assert.equal(workedForEntries(sessionFile).length, 0, "Untrusted projects append no durable receipt");
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "untrusted", error: error instanceof Error ? error.message : String(error),
        providerRequests: provider.requests.length, providerErrors: provider.errors, terminal: terminal?.diagnostics(), screens });
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Untrusted terminal cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
      failures.push(...provider.errors);
    }
  }

  // One-shot modes complete real work and persist native messages, but never append a TUI receipt.
  for (const mode of ["print", "json"] as const) {
    const family = createFamily(mode);
    directories.push(family.directory);
    const provider = new ReceiptProvider();
    try {
      initRepository(family.project);
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      const observer = receiptObserver(family.directory);
      const sessionFile = path.join(family.directory, `session-${mode}.jsonl`);
      provider.plan({ kind: "text", content: `Receipt ${mode} completed.`, outputTokens: 20 });
      const invocation = promisify(execFile)(process.execPath,
        [cliPath, "--print", ...(mode === "json" ? ["--mode", "json"] : []),
          "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "bash",
          "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
          "--extension", observer.extension, `complete the ${mode} receipt boundary`],
        { cwd: family.project, env: family.env, windowsHide: true, timeout: 30_000, maxBuffer: 2_097_152, signal: t.signal });
      invocation.child.stdin?.end();
      const [result] = await Promise.all([invocation, waitForReceiptSettlement(observer.events, 1, t.signal)]);
      assert.equal(invocation.child.exitCode, 0, `${mode} exits naturally`);
      assert.match(result.stdout, new RegExp(`Receipt ${mode} completed\\.`, "u"));
      assert.equal(provider.requests.length, 1);
      assert.deepEqual(workedForEntries(sessionFile), [], `${mode} persists no worked-for receipt`);
      if (mode === "json") {
        const events = result.stdout.trim().split(/\r?\n/u).map((line) => record(JSON.parse(line), "native JSON output"));
        assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
      }
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: mode, directory: family.directory, providerRequests: provider.requests.length });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
      failures.push(...provider.errors);
    }
  }

  if (failures.length > 0) {
    throwScenarioFailure({ directory: directories[0] ?? repositoryRoot, message: "Receipt lifecycle scenario failed",
      errors: failures, diagnostics: JSON.stringify({ platform: process.platform, node: process.version, pi: piVersion, diagnostics }) });
  }
  for (const directory of directories) await removeDirectoryEventually(directory);
});

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

test("native session boundaries discard receipts parked at settlement", { timeout: 180_000 }, async t => {
  const operations = ["none", "rename", "new", "cancel-new", "reload", "tree", "tree-before-reset", "tree-before-settle", "cancel-tree"];
  const selected = process.env.KILLEROS_RECEIPT_BOUNDARY_OPERATION;
  const observations: RecordValue[] = [];
  for (const operation of operations.filter(value => selected === undefined || selected.split(",").includes(value))) {
    const family = createFamily(`parked-${operation}`);
    const provider = new ReceiptProvider();
    let terminal: PiTerminalProcess | undefined;
    const plan = path.join(family.directory, "plan.json");
    const probe = path.join(family.directory, "boundary-probe.mjs");
    const observer = path.join(family.directory, "boundary-observer.mjs");
    const sessions = path.join(family.directory, "sessions");
    const waitFile = async (file: string): Promise<void> => {
      for (let attempt = 0; attempt < 1000; attempt++) {
        if (existsSync(file)) return;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        t.signal.throwIfAborted();
      }
      assert.fail(`Missing native boundary acknowledgement: ${file}`);
    };
    try {
      initRepository(family.project);
      mkdirSync(sessions);
      const seed = SessionManager.create(family.project, sessions);
      seed.appendMessage({ role: "user", content: "Retained boundary history", timestamp: 1 });
      seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Retained branch" }], api: "openai-completions",
        provider: "receipts-local", model: "receipt-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });
      const initial = seed.getSessionFile();
      const target = seed.getLeafId();
      assert.ok(initial && target);
      writeFileSync(plan, JSON.stringify({ id: "startup", armed: false }));
      writeFileSync(probe, `import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const directory=${JSON.stringify(family.directory)}, plan=${JSON.stringify(plan)}, operation=${JSON.stringify(operation)};
const file=name=>directory+"/"+name;
const key=Symbol.for(directory);
const boundary=globalThis[key]??={original:promises.open,intercepted:"",requestStarted:false};
const original=boundary.original;
let commandContext;
const readPlan=()=>JSON.parse(fs.readFileSync(plan,"utf8"));
const wait=async name=>{for(let i=0;i<1000;i++){if(fs.existsSync(file(name)))return;await new Promise(r=>setTimeout(r,10));}throw new Error("Boundary gate timeout "+name);};
boundary.wrapper??=async function(target,...args){
 const p=readPlan(), stack=new Error().stack??"";
 if(boundary.requestStarted&&p.armed&&operation!=="tree-before-settle"&&boundary.intercepted!==p.id&&String(target)===${JSON.stringify(path.join(family.project, "baseline.txt"))}&&stack.includes("change-receipt")){
  boundary.intercepted=p.id;fs.writeFileSync(file("entered-"+p.id),JSON.stringify({stack}));
  await wait("release-"+p.id);
 }
 return await original.call(this,target,...args);
};
promises.open=boundary.wrapper;
syncBuiltinESMExports();
export default function(pi){
 pi.on("before_provider_request",()=>{boundary.requestStarted=true;});
 pi.on("session_before_switch",()=>operation==="cancel-new"?{cancel:true}:undefined);
 pi.on("session_before_tree",()=>operation==="cancel-tree"?{cancel:true}:undefined);
 pi.on("agent_settled",async()=>{
  const p=readPlan();if(operation==="tree-before-settle"&&p.armed){
   fs.writeFileSync(file("entered-"+p.id),JSON.stringify({event:"agent_settled"}));await wait("release-"+p.id);
  }
 });
 pi.on("session_tree",async()=>{
  const p=readPlan();if(p.armed&&(operation==="tree-before-reset"||operation==="tree-before-settle")){
   fs.writeFileSync(file("release-"+p.id),"yes");
   await wait("settled-"+p.id);
   fs.writeFileSync(file("early-settlement-"+p.id),"yes");
  }
 });
 pi.registerCommand("receipt-boundary-arm",{description:"Capture a native boundary command context",handler:async(_args,ctx)=>{commandContext=ctx;boundary.requestStarted=false;ctx.ui.notify("Boundary armed");}});
 pi.registerCommand("receipt-boundary-state",{description:"Acknowledge active native state",handler:async(args,ctx)=>{
  fs.writeFileSync(file("state-"+args),JSON.stringify({file:ctx.sessionManager.getSessionFile(),idle:ctx.isIdle(),pending:ctx.hasPendingMessages()}));ctx.ui.notify("Boundary state "+args);
 }});
 pi.on("session_start",(_event,ctx)=>ctx.ui.onTerminalInput(data=>{
  if(data!=="\\x1b[23~")return;
  const p=readPlan();
  void (async()=>{
   let result;
   if(operation==="new"||operation==="cancel-new")result=await commandContext.newSession();
   else if(operation==="reload")result=await commandContext.reload();
   else if(operation.startsWith("tree")||operation==="cancel-tree")result=await commandContext.navigateTree(${JSON.stringify(target)},{summarize:false});
   else if(operation==="rename")pi.setSessionName("Renamed during parked receipt");
   fs.writeFileSync(file("action-"+p.id),JSON.stringify({ok:true,result}));
  })().catch(error=>fs.writeFileSync(file("action-"+p.id),JSON.stringify({error:String(error)})));
  return {consume:true};
 }));
 pi.on("session_shutdown",event=>{if(event.reason==="quit"){promises.open=original;syncBuiltinESMExports();}});
}`);
      writeFileSync(observer, `import fs from "node:fs";
const directory=${JSON.stringify(family.directory)}, plan=${JSON.stringify(plan)};
export default function(pi){
 pi.on("agent_settled",()=>{const p=JSON.parse(fs.readFileSync(plan,"utf8"));fs.writeFileSync(directory+"/settled-"+p.id,"yes");});
 pi.on("session_start",(_event,ctx)=>{fs.writeFileSync(directory+"/selected.json",JSON.stringify({file:ctx.sessionManager.getSessionFile()}));});
}`);
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      writeFileSync(path.join(family.agent, "killeros.json"), JSON.stringify({ completionSound: true }));
      terminal = new PiTerminalProcess({ file: process.execPath, cwd: family.project, env: family.env, cols: 120, rows: 40,
        args: [cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--session", initial,
          "--session-dir", sessions, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", probe,
          "--extension", process.env.KILLEROS_RECEIPT_BOUNDARY_EXTENSION ?? repositoryRoot, "--extension", observer] });
      await terminal.waitForScreen(screen => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
      const discard = ["new", "reload", "tree", "tree-before-reset", "tree-before-settle"].includes(operation);
      for (const failedScan of [false, true]) {
        const id = failedScan ? "error" : "available";
        await terminal.submitEditorText("/receipt-boundary-arm", { signal: t.signal });
        await terminal.waitForScreen(screen => screen.includes("Boundary armed"), { signal: t.signal });
        const source = stringField(record(JSON.parse(readFileSync(path.join(family.directory, "selected.json"), "utf8")), "selected"), "file");
        const before = workedForEntries(source);
        const bellsBefore: number = terminal.bellCount;
        let release = () => {};
        const held = new Promise<void>(resolve => { release = resolve; });
        provider.plan({ kind: "text", content: `Parked ${id} response.`, holdUntil: held, outputTokens: 50 });
        writeFileSync(plan, JSON.stringify({ id, armed: true }));
        await terminal.submitEditorText(`Start parked ${id}`, { signal: t.signal });
        await terminal.waitForScreen(screen => screen.includes(`Parked ${id} response.`), { signal: t.signal });
        writeFileSync(path.join(family.project, "baseline.txt"), `changed ${id}\n`);
        release();
        await waitFile(path.join(family.directory, `entered-${id}`));
        const entered = record(JSON.parse(readFileSync(path.join(family.directory, `entered-${id}`), "utf8")), "entered");
        if (operation === "tree-before-settle") assert.equal(entered.event, "agent_settled");
        else assert.match(String(entered.stack), /change-receipt/u, "The real receipt scan, not a footer read, is parked");
        if (failedScan) writeFileSync(path.join(family.project, ".git/config"), "[broken\n");
        terminal.write("\x1b[23~");
        await waitFile(path.join(family.directory, `action-${id}`));
        const action = record(JSON.parse(readFileSync(path.join(family.directory, `action-${id}`), "utf8")), "action");
        assert.equal(action.error, undefined, JSON.stringify(action));
        writeFileSync(path.join(family.directory, `release-${id}`), "yes");
        await waitFile(path.join(family.directory, `settled-${id}`));
        const after = workedForEntries(source);
        assert.equal(after.length, before.length + (discard ? 0 : 1), `${operation}/${id}: discard only committed boundaries`);
        if (!discard) assert.equal(record(after.at(-1)?.data.changes, "changes").state, failedScan ? "unavailable" : "available");
        if (operation === "tree-before-reset" || operation === "tree-before-settle") {
          await waitFile(path.join(family.directory, `early-settlement-${id}`));
        }
        assert.doesNotMatch(terminal.screen(), /stale|Worked-for timing could not be saved/iu);
        if (discard) assert.doesNotMatch(terminal.screen(), /Change receipt unavailable/u);
        if (failedScan) writeFileSync(path.join(family.project, ".git/config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
        const recovery = `recovery-${id}`;
        writeFileSync(plan, JSON.stringify({ id: recovery, armed: false }));
        await terminal.submitEditorText(`/receipt-boundary-state ${recovery}`, { signal: t.signal });
        await waitFile(path.join(family.directory, `state-${recovery}`));
        const state = record(JSON.parse(readFileSync(path.join(family.directory, `state-${recovery}`), "utf8")), "state");
        assert.deepEqual([state.idle, state.pending], [true, false]);
        await terminal.waitForScreen(screen => screen.includes(`Boundary state ${recovery}`), { signal: t.signal });
        const expectedBells = ["new", "reload", "tree-before-reset", "tree-before-settle"].includes(operation) ? 0 : 1;
        assert.equal(terminal.bellCount - bellsBefore, expectedBells, `${operation}/${id}: native completion sound respects the boundary`);
        if (failedScan && !discard) assert.equal(terminal.screen().split("Change receipt unavailable: error").length - 1, 1,
          "A surviving failed receipt publishes exactly one native warning");
        const destination = stringField(state, "file");
        const recoveredBefore = existsSync(destination) ? workedForEntries(destination) : [];
        provider.plan({ kind: "text", content: `Recovered ${id}.`, outputTokens: 100, holdMs: 100 });
        await terminal.submitEditorText(`Recover ${id}`, { signal: t.signal });
        await waitFile(path.join(family.directory, `settled-${recovery}`));
        const recovered = workedForEntries(destination);
        assert.equal(recovered.length, recoveredBefore.length + 1, `${operation}/${id}: next native receipt recovers`);
        assert.equal(recovered.at(-1)?.data.outcome, "done");
      }
      assert.equal(provider.requests.length, 4);
      assert.deepEqual(await terminal.close(), { code: 0, forced: false });
      terminal = undefined;
      observations.push({ operation, requests: 4, states: ["available", "error"], discard });
      t.diagnostic(JSON.stringify(observations.at(-1)));
    } finally {
      if (terminal) await terminal.close();
      await provider.close();
      await removeDirectoryEventually(family.directory);
    }
  }
  assert.ok(observations.length > 0);
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-parked-boundaries", piLaunches: observations.length,
    providerRequests: observations.length * 4, observations, cleanup: "natural" }));
});

test("native receipts reject malformed provider rates and count tool and compaction usage", { timeout: 60_000 }, async t => {
  const family = createFamily("provider-metrics");
  const extension = path.join(family.directory, "metrics-provider.mjs");
  const observation = path.join(family.directory, "provider.jsonl");
  const clockAdapter = path.join(family.directory, "owned-clock.mjs");
  const clockRestored = path.join(family.directory, "clock-restored");
  const observer = receiptObserver(family.directory);
  let terminal: PiTerminalProcess | undefined;
  try {
    initRepository(family.project);
    writeProviderConfig(family.agent, 1);
    const session = SessionManager.create(family.project, path.join(family.directory, "sessions"));
    const usage = (totalTokens: number) => ({ input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    session.appendMessage({ role: "user", content: "Historical tokens must not be recounted", timestamp: 1 });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Historical assistant" }], api: "openai-completions",
      provider: "receipts-local", model: "receipt-model", usage: usage(1000), stopReason: "stop", timestamp: 1 });
    session.branchWithSummary(session.getLeafId(), "Historical branch usage", undefined, false, usage(500));
    const file = session.getSessionFile();
    assert.ok(file);
    writeFileSync(clockAdapter, `import {writeFileSync} from "node:fs";
const original=Date.now;
const state={value:undefined};globalThis[Symbol.for("killeros.receipt.owned-clock")]=state;
Date.now=()=>state.value??original();
process.on("exit",()=>{Date.now=original;writeFileSync(${JSON.stringify(clockRestored)},"restored");});`);
    writeFileSync(extension, `import {appendFileSync} from "node:fs";
import {createAssistantMessageEventStream} from ${JSON.stringify(new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url).href)};
import {Type} from ${JSON.stringify(import.meta.resolve("typebox"))};
const usage=totalTokens=>({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const values=[-1,1.5,NaN,Infinity,undefined,25,25,25,25,25];let requests=0;
const clock=globalThis[Symbol.for("killeros.receipt.owned-clock")];
export default function(pi){
 pi.on("message_end",()=>{clock.value=undefined;});
 pi.registerTool({name:"receipt-noop",label:"Receipt usage",description:"Return owned tool usage",parameters:Type.Object({}),
  execute:async()=>({content:[{type:"text",text:"Measured owned tool usage"}],details:{},usage:usage(1000)})});
 pi.registerProvider("receipts-local",{api:"openai-completions",streamSimple(model){
  const ordinal=requests++,phase=ordinal%3,group=Math.floor(ordinal/3),output=phase===0?50:phase===1?values[group]:100;
  const total=group===7?(phase===0?-1:phase===1?NaN:30000):10000;
  appendFileSync(${JSON.stringify(observation)},JSON.stringify({ordinal,group,phase,output,total,totalNaN:Number.isNaN(total),undefined:output===undefined,nan:Number.isNaN(output),infinite:output===Infinity,starts:group===5&&phase===1?2:1,clock:group>=8&&phase===1?group:undefined})+"\\n");
  const stream=createAssistantMessageEventStream();
  const message={role:"assistant",content:phase<2?[{type:"toolCall",id:"metric-"+ordinal,name:"receipt-noop",arguments:{}}]:[{type:"text",text:"Metric sequence "+group+" finished."}],
   api:model.api,provider:model.provider,model:model.id,usage:{...usage(total),output},stopReason:phase<2?"toolUse":"stop",timestamp:Date.now()};
  if(group>=8&&phase===1)clock.value=100000;
  stream.push({type:"start",partial:message});
  if(group===5&&phase===1)stream.push({type:"start",partial:message});
  setTimeout(()=>{if(group===9&&phase===1)clock.value=99000;stream.push({type:"done",reason:message.stopReason,message});stream.end();},25);
  return stream;
 }});
 pi.on("agent_before_settle",(_event,ctx)=>({entries:[{type:"compaction",summary:"Owned native compaction usage",firstKeptEntryId:ctx.sessionManager.getLeafId(),usage:usage(3000)}]}));
}`);
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: family.project, env: family.env, cols: 120, rows: 40,
      args: ["--import", pathToFileURL(clockAdapter).href, cliPath, "--model", "receipts-local/receipt-model", "--thinking", "off", "--tools", "receipt-noop", "--session", file,
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--no-extensions", "--extension", repositoryRoot, "--extension", extension, "--extension", observer.extension] });
    await terminal.waitForScreen(screen => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
    for (let group = 0; group < 10; group++) {
      await terminal.submitEditorText(`Measure provider metrics ${group}`, { signal: t.signal });
      await waitForReceiptSettlement(observer.events, group + 1, t.signal);
      const entries = workedForEntries(file);
      assert.equal(entries.length, group + 1);
      const receipt = entries.at(-1)?.data;
      assert.ok(receipt);
      assert.equal(receipt.outcome, "done");
      assert.equal(receipt.tokens, 35000, "Three model usages plus two tool usages plus compaction; historical totals excluded");
      if (group < 6 || group >= 8) {
        assert.equal(Object.hasOwn(receipt, "outputTokens"), false, `Malformed output group ${group} invalidates the whole rate`);
        assert.equal(Object.hasOwn(receipt, "responseMilliseconds"), false);
      } else {
        assert.equal(receipt.outputTokens, 175, "The next valid task recovers its own complete rate");
        assert.ok(typeof receipt.responseMilliseconds === "number" && receipt.responseMilliseconds > 0);
      }
    }
    const calls = readFileSync(observation, "utf8").trim().split("\n").map(line => record(JSON.parse(line), "provider call"));
    assert.equal(calls.length, 30);
    assert.equal(calls[7]?.nan, true);
    assert.equal(calls[10]?.infinite, true);
    assert.equal(calls[13]?.undefined, true);
    assert.equal(calls[16]?.starts, 2, "Duplicate native provider start events reach the real agent loop");
    assert.equal(calls[21]?.total, -1);
    assert.equal(calls[22]?.totalNaN, true, "Invalid native total usage is ignored without discarding valid usage");
    assert.deepEqual([calls[25]?.clock, calls[28]?.clock], [8, 9], "Actual child clock boundary covers zero and reversed intervals");
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    terminal = undefined;
    assert.equal(readFileSync(clockRestored, "utf8"), "restored");
  } finally {
    if (terminal) await terminal.close();
    await removeDirectoryEventually(family.directory);
  }
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-provider-metrics", piLaunches: 1, providerStreams: 30,
    httpRequests: 0, toolCalls: 20, receiptTokens: 35000, clockFaults: ["zero", "reverse"], cleanup: "natural" }));
});
