import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PiTerminalProcess } from "./PiTerminalProcess.ts";
import { throwScenarioFailure } from "./ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const piManifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
assert.ok(typeof piManifest === "object" && piManifest !== null && "version" in piManifest && typeof piManifest.version === "string");
const piVersion = piManifest.version;
const enter = "\x1b[13u";

type RecordValue = Record<string, unknown>;
type Step = { kind: "text"; content: string } | { kind: "tools"; commands: string[] };
type PlannedStep = { step: Step; acknowledge: () => void; released: Promise<void> };

/** Loopback provider; tool steps may carry several scripted bash calls in one response. */
class ReceiptGitProvider {
  readonly requests: RecordValue[] = [];
  private readonly faults: unknown[] = [];
  private readonly server: Server;
  private readonly steps: PlannedStep[] = [];
  private readonly releases = new Set<() => void>();

  constructor() {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          assert.ok(chunk instanceof Uint8Array);
          size += chunk.length;
          assert.ok(size < 1_048_576);
          chunks.push(Buffer.from(chunk));
        }
        assert.equal(request.url, "/v1/chat/completions");
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(typeof body === "object" && body !== null);
        this.requests.push(body as RecordValue);
        const planned = this.steps.shift();
        if (planned === undefined) throw new Error(`Unexpected provider request ${this.requests.length}`);
        const { step } = planned;
        // A tool-call response is always followed by one continuation request after the results land.
        if (step.kind === "tools") this.steps.unshift({ ...planned, step: { kind: "text", content: "Checks response." } });
        const socket = response.socket;
        if (socket === null) throw new Error("Receipt fixture lost the response socket");
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        const index = this.requests.length;
        if (step.kind === "tools") {
          const calls = step.commands.map((command, position) => ({ index: position, id: `receipt-git-call-${index}-${position}`,
            type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }));
          response.write(`data: ${JSON.stringify({ id: `receipt-git-${index}`, model: "receipt-git-model",
            choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id: `receipt-git-${index}`, model: "receipt-git-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
        } else {
          planned.acknowledge();
          response.write(`data: ${JSON.stringify({ id: `receipt-git-${index}`, model: "receipt-git-model",
            choices: [{ index: 0, delta: { content: step.content }, finish_reason: null }] })}\n\n`);
        }
        // Only final text waits: tool execution must reach its visible marker before the turn can release.
        if (step.kind === "text") await planned.released;
        if (socket.destroyed) return;
        response.end(`data: ${JSON.stringify({ id: `receipt-git-${index}`, model: "receipt-git-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 } })}\n\ndata: [DONE]\n\n`);
      })().catch((error: unknown) => {
        this.faults.push(error);
        if (!response.destroyed && !response.writableEnded) { response.writeHead(500, { connection: "close" }); response.end("Receipt-git fixture rejected request"); }
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 10_000;
  }

  get errors(): unknown[] {
    return this.faults;
  }

  plan(step: Step): { accepted: Promise<void>; release: () => void } {
    let acknowledge: () => void = () => {};
    const accepted = new Promise<void>((resolve) => { acknowledge = resolve; });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = () => { this.releases.delete(release); resolve(); };
    });
    this.releases.add(release);
    this.steps.push({ step, acknowledge, released });
    return { accepted, release };
  }

  releaseAll(): void {
    for (const release of this.releases) release();
  }

  async listen(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Receipt-git fixture did not report a port"));
      });
    });
  }

  async close(): Promise<void> {
    this.releaseAll();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }
}

type Family = { directory: string; project: string; agent: string; env: NodeJS.ProcessEnv };

function createFamily(root: string, name: string): Family {
  const directory = mkdtempSync(path.join(root, "node_modules", `.killeros-receipt-git-${name}-`));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  for (const folder of [project, agent]) mkdirSync(folder);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
    PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([entry]) => entry.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  return { directory, project, agent, env };
}

function git(project: string, ...args: string[]): Buffer {
  return execFileSync("git", ["-c", "user.email=receipts@fixture.invalid", "-c", "user.name=Receipt Git Fixture", ...args], {
    cwd: project, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
}

/** Standard fixture repository: tracked clean.txt and binary.bin, plus a local fast-failing package.json. */
function initRepository(project: string): void {
  git(project, "init", "-q");
  git(project, "config", "core.autocrlf", "false");
  writeFileSync(path.join(project, "clean.txt"), "clean\n");
  writeFileSync(path.join(project, "binary.bin"), Buffer.from([0, 9, 2, 3]));
  // A local manifest keeps scripted `npm test` checks from resolving the repository root's package.json upward.
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "receipt-git-fixture", private: true,
    scripts: { test: "node -e \"process.exit(1)\"" } }));
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "baseline");
}

function writeProviderConfig(agent: string, port: number, tuiMode: "fullscreen" | "regular" = "fullscreen"): void {
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode, cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "receipt-git-local": {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "receipt-git-fixture-only",
    models: [{ id: "receipt-git-model", name: "receipt git model", reasoning: false, input: ["text"], contextWindow: 200_000,
      maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionReceipts(sessionFile: string): RecordValue[] {
  const entries: RecordValue[] = [];
  let contents: string;
  try {
    contents = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return entries;
    throw error;
  }
  for (const line of contents.split(/\r?\n/u)) {
    if (!line) continue;
    const parsed: unknown = JSON.parse(line);
    assert.ok(isRecord(parsed));
    if (parsed.type === "custom" && parsed.customType === "killeros-worked-for") {
      const data = parsed.data;
      assert.ok(isRecord(data));
      entries.push(data);
    }
  }
  return entries;
}

function fileSummary(changes: unknown): { totalFiles: number; additions: number; deletions: number; files: RecordValue[]; state: string; reason?: string } {
  assert.ok(isRecord(changes));
  const files = Array.isArray(changes.files) ? changes.files as RecordValue[] : [];
  return { totalFiles: Number(changes.totalFiles), additions: Number(changes.additions),
    deletions: Number(changes.deletions), files, state: String(changes.state),
    ...(typeof changes.reason === "string" ? { reason: changes.reason } : {}) };
}

type Turn = {
  label: string;
  step: Step;
  /** Unique streaming marker identifying this turn before its provider barrier releases. */
  doneWhen: (screen: string) => boolean;
  mutate: () => void;
  receiptDelta?: 0 | 1;
  screenMarker?: string;
  afterSettlement?: () => void;
  verify: (receipt: RecordValue, screen: string) => void;
};

// Loaded after KillerOS: Pi awaits settlement handlers in extension order, including receipt persistence.
const settlementObserverSource = String.raw`import { writeFileSync, renameSync } from "node:fs";
export default function (pi) {
  let prompt;
  let ordinal = 0;
  pi.on("before_agent_start", (event) => {
    prompt = event.messageType === "user" ? event.prompt : undefined;
  });
  pi.on("agent_settled", (event, ctx) => {
    ordinal += 1;
    const destination = process.env.KILLEROS_RECEIPT_SETTLEMENT;
    if (!destination) throw new Error("Missing receipt settlement destination");
    // ExtensionContext has no compaction getter; native agent_settled guarantees compaction has stopped.
    const output = process.env.KILLEROS_RECEIPT_UNIQUE_SETTLEMENT === "1" ? destination + "." + ordinal : destination;
    writeFileSync(output + ".tmp", JSON.stringify({ ordinal, prompt,
      sessionFile: ctx.sessionManager.getSessionFile(), aborted: event.aborted,
      idle: ctx.isIdle(), pending: ctx.hasPendingMessages() }));
    renameSync(output + ".tmp", output);
  });
}
`;

/** Launch a trusted TUI and run labeled mid-turn mutation families, verifying each settled receipt. */
async function runTurns(options: { family: Family; provider: ReceiptGitProvider; turns: Turn[]; signal: AbortSignal;
  extensions?: string[]; uniqueSettlement?: true }): Promise<void> {
  const sessionFile = path.join(options.family.directory, "session.jsonl");
  const settlementFile = path.join(options.family.directory, "settlement.json");
  const observerFile = path.join(options.family.directory, "settlement-observer.ts");
  writeFileSync(observerFile, settlementObserverSource);
  const terminal = new PiTerminalProcess({ file: process.execPath,
    args: [cliPath, "--model", "receipt-git-local/receipt-git-model", "--thinking", "off", "--tools", "bash",
      "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
      "--extension", observerFile, ...(options.extensions ?? []).flatMap(extension => ["--extension", extension])],
    cwd: options.family.project, env: { ...options.family.env, KILLEROS_RECEIPT_SETTLEMENT: settlementFile,
      ...(options.uniqueSettlement ? { KILLEROS_RECEIPT_UNIQUE_SETTLEMENT: "1" } : {}) }, cols: 120, rows: 34 });
  const failures: unknown[] = [];
  let settledTurns = 0;
  try {
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("ctx 100%"), { signal: options.signal });
    for (const turn of options.turns) {
      const planned = options.provider.plan(turn.step);
      const receiptsBefore = sessionReceipts(sessionFile).length;
      try {
        const typingCursor = terminal.sequence;
        terminal.write(turn.label);
        await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.includes("❯") && line.includes(turn.label)), { signal: options.signal, after: typingCursor });
        const submittedCursor = terminal.sequence;
        terminal.write(enter);
        // Wait until this request is streaming so mutations land between baseline and settlement.
        await Promise.all([planned.accepted,
          terminal.waitForScreen(turn.doneWhen, { signal: options.signal, after: submittedCursor })]);
        turn.mutate();
      } finally {
        planned.release();
      }
      const deadline = Date.now() + 15_000;
      const completedFile = options.uniqueSettlement ? settlementFile + "." + (settledTurns + 1) : settlementFile;
      let settlement: unknown;
      while (true) {
        if (existsSync(completedFile)) settlement = JSON.parse(readFileSync(completedFile, "utf8"));
        if (isRecord(settlement) && settlement.ordinal !== settledTurns) break;
        assert.ok(Date.now() < deadline, `Turn "${turn.label}" did not acknowledge native settlement`);
        await delay(50, undefined, { signal: options.signal });
      }
      assert.ok(isRecord(settlement));
      assert.equal(settlement.ordinal, settledTurns + 1, "Exactly one native settlement per turn");
      assert.equal(settlement.prompt, turn.label, "Settlement matches the submitted turn");
      assert.equal(settlement.sessionFile, sessionFile, "Settlement matches the owned session");
      assert.equal(settlement.aborted, false, "The turn settled without aborting");
      assert.equal(settlement.idle, true, "Pi is idle at settlement");
      assert.equal(settlement.pending, false, "Pi has no queued continuation at settlement");
      settledTurns += 1;
      turn.afterSettlement?.();
      const receipts = sessionReceipts(sessionFile);
      assert.equal(receipts.length, receiptsBefore + (turn.receiptDelta ?? 1), `Turn "${turn.label}" appends its expected receipt count`);
      if (turn.screenMarker) await terminal.waitForScreen(screen => screen.includes(turn.screenMarker ?? ""), { signal: options.signal });
      turn.verify(receipts.at(-1) as RecordValue, terminal.screen());
    }
  } catch (error) {
    failures.push(error);
  } finally {
    options.provider.releaseAll();
    try {
      const result = await terminal.close();
      if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Receipt-git terminal cleanup: ${JSON.stringify(result)}`));
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0 || options.provider.errors.length > 0) {
    throwScenarioFailure({ directory: options.family.directory, message: "Receipt-git turn family failed",
      errors: [...failures, ...options.provider.errors.map((fault) => fault instanceof Error ? fault : new Error(String(fault)))],
      diagnostics: JSON.stringify({ directory: options.family.directory, pi: piVersion,
        requests: options.provider.requests.length, providerErrors: options.provider.errors, settledTurns,
        settlement: existsSync(settlementFile) ? readFileSync(settlementFile, "utf8") : null,
        terminal: terminal.diagnostics() }),
    });
  }
}


export { repositoryRoot, piVersion, ReceiptGitProvider, createFamily, git, initRepository, writeProviderConfig, isRecord, sessionReceipts, fileSummary, runTurns };
export type { Family, RecordValue };
