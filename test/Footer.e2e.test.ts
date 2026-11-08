import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const enter = "\x1b[13u";
const piManifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
assert.ok(typeof piManifest === "object" && piManifest !== null && "version" in piManifest && typeof piManifest.version === "string");
const piVersion = piManifest.version;

// Provider usage enters through Pi's real transport, not a replacement context API.
test("installed Pi terminal updates context capacity and the settings-driven compact hint", { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-footer-"));
  const agent = path.join(directory, "agent");
  const temporary = path.join(directory, "tmp");
  mkdirSync(agent);
  mkdirSync(temporary);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: temporary, TMP: temporary,
    PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  let usedTokens = 850_000;
  let requestCount = 0;
  const faults: string[] = [];
  const server = createServer((request, response) => {
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
      assert.equal(request.method, "POST");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(typeof body === "object" && body !== null && "model" in body);
      assert.ok(body.model === "million" || body.model === "fractional");
      requestCount++;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `footer-${requestCount}`, model: body.model,
        choices: [{ index: 0, delta: { content: `Budget response ${requestCount}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: usedTokens - 1, completion_tokens: 1, total_tokens: usedTokens },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Footer fixture rejected request"); }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const screens: Record<string, string> = {};
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("No footer provider port"));
      });
    });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
      compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "killeros-footer": {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "footer-fixture-key",
      models: [{ id: "million", contextWindow: 1_000_000 }, { id: "fractional", contextWindow: 1_050_000 }].map((model) => ({
        ...model, name: model.id, reasoning: false, input: ["text"], maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    } } }));
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        "--model", "killeros-footer/million", "--thinking", "off", "--tools", "read", "--session", path.join(directory, "session.jsonl"),
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts")], cwd: directory, env, cols: 120, rows: 30 });
    const footerLine = (screen: string): string => screen.split("\n").find((line) => /ctx (?:\d+|—)%/u.test(line)) ?? "";
    const command = async (text: string, predicate: (screen: string) => boolean): Promise<string> => {
      assert.ok(terminal);
      const after = terminal.sequence;
      await terminal.submitEditorText(text, { signal: t.signal });
      return await terminal.waitForScreen((screen) => footerLine(screen) !== "" && predicate(screen), { signal: t.signal, after });
    };
    screens.startup = await terminal.waitForScreen((screen) => footerLine(screen).includes("(1M/1M)"), { signal: t.signal });
    screens.default = await command("low budget", (screen) => footerLine(screen).includes("ctx 15% (150K/1M)"));
    assert.doesNotMatch(footerLine(screens.default), /\/compact/u);
    screens.off = await command("/auto-compact off", (screen) => footerLine(screen).includes("/compact"));
    assert.match(footerLine(screens.off), /ctx 15% \(150K\/1M\) · \/compact/u);
    screens.threshold = await command("/auto-compact 80", (screen) => screen.includes("threshold: 80%"));
    assert.match(footerLine(screens.threshold), /\/compact/u);
    screens.on = await command("/auto-compact on", (screen) => screen.includes("on at 80%") && !footerLine(screen).includes("/compact"));
    screens.offAgain = await command("/auto-compact off", (screen) => footerLine(screen).includes("/compact"));
    usedTokens = 800_000;
    screens.warning = await command("higher budget", (screen) => footerLine(screen).includes("ctx 20% (200K/1M)"));
    assert.doesNotMatch(footerLine(screens.warning), /\/compact/u);
    const modelAfter = terminal.sequence;
    await terminal.submitEditorText("/model killeros-footer/fractional", { signal: t.signal });
    // Model-argument completion can consume the first Enter without executing the command.
    terminal.write("\x1b[13u");
    screens.switched = await terminal.waitForScreen((screen) => footerLine(screen).includes("fractional")
      && footerLine(screen).includes("/1.05M)"), { signal: t.signal, after: modelAfter });
    usedTokens = 1_000_000;
    screens.fractional = await command("fractional budget", (screen) => footerLine(screen).includes("ctx 5% (50K/1.05M)"));
    assert.match(footerLine(screens.fractional), /\/compact/u);
    const settingsPath = path.join(agent, "killeros.json");
    const malformed = "{ invalid settings";
    writeFileSync(settingsPath, malformed);
    screens.failedWrite = await command("/auto-compact on", (screen) => screen.includes("could not be saved"));
    assert.match(footerLine(screens.failedWrite), /\/compact/u, "A failed write must retain the last displayed preference");
    assert.equal(readFileSync(settingsPath, "utf8"), malformed);
    screens.failedRead = await command("/auto-compact status", (screen) => screen.includes("could not be read") && !footerLine(screen).includes("/compact"));
    assert.equal(readFileSync(settingsPath, "utf8"), malformed);
    screens.failedReload = await command("/reload", (screen) => screen.includes("Reloaded") && !footerLine(screen).includes("/compact"));
    assert.match(footerLine(screens.failedReload), /ctx 5% \(50K\/1\.05M\)/u);
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.reloaded = await command("/reload", (screen) => screen.includes("Reloaded") && footerLine(screen).includes("/compact"));
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.externalOn = await command("updated preference", (screen) => screen.includes("Budget response 4") && !footerLine(screen).includes("/compact"));
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.externalOff = await command("updated preference again", (screen) => screen.includes("Budget response 5") && footerLine(screen).includes("/compact"));
    writeFileSync(settingsPath, malformed);
    screens.turnReadFailure = await command("unreadable preference", (screen) => screen.includes("settings could not be read") && !footerLine(screen).includes("/compact"));
    assert.equal(readFileSync(settingsPath, "utf8"), malformed);
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.restored = await command("/auto-compact status", (screen) => footerLine(screen).includes("/compact"));
    const afterResize = terminal.sequence;
    terminal.resize(58, 30);
    screens.capacityOnly = await terminal.waitForScreen((screen) => /ctx 5% \(1\.05M\)/u.test(footerLine(screen)), { signal: t.signal, after: afterResize });
    const beforeNarrow = terminal.sequence;
    terminal.resize(34, 30);
    screens.percentageOnly = await terminal.waitForScreen((screen) => /ctx 5% · \/compact/u.test(footerLine(screen)) && !footerLine(screen).includes("1.05M"), { signal: t.signal, after: beforeNarrow });
    assert.ok(screens.percentageOnly.split("\n").every((line) => [...line].length <= 34));
    assert.deepEqual(faults, []);
    assert.equal(requestCount, 6, "Settings commands, model selection, and reload must not start model requests");
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Footer terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      } catch (error) { cleanupFailures.push(error); }
    }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || faults.length > 0) {
    throwScenarioFailure({ directory, message: "Footer TUI scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...faults.map((fault) => new Error(fault))],
      diagnostics: JSON.stringify({ directory, platform: process.platform, node: process.version, pi: piVersion,
        faults, requestCount, terminal: terminal?.diagnostics(), screens }),
    });
  }
  await removeDirectoryEventually(directory);
});

// FT-01 keeps the file header frozen; helpers for FT-02..FT-05 live below this point.
import { truncateToWidth } from "@earendil-works/pi-tui";

type FooterDisplayRow = { left: string; right: string };

/* Mirrors killeros/display.ts padRight without importing production modules: clip visibly, then pad. */
function footerReplicaPadRight(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/* Mirrors killeros/footer.ts footerRowFits: content plus margins must fit the row. */
function footerReplicaFits(left: string, right: string, width: number): boolean {
  const contentWidth = visibleWidth(left) + (right ? visibleWidth(right) + 1 : 0);
  return contentWidth + 2 <= width;
}

/* Mirrors killeros/footer.ts renderFooterRow's visible output, including its tiny-width fallbacks. */
function footerReplicaRow(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width < 3) return " ".repeat(width);
  const innerWidth = width - 2;
  if (!right) return ` ${footerReplicaPadRight(left, innerWidth)} `;
  const clippedRight = truncateToWidth(right, innerWidth, "");
  const rightWidth = visibleWidth(clippedRight);
  const leftBudget = Math.max(0, innerWidth - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, leftBudget, "…");
  const gap = " ".repeat(Math.max(0, innerWidth - visibleWidth(clippedLeft) - rightWidth));
  return ` ${clippedLeft}${gap}${clippedRight} `;
}

/* Mirrors killeros/footer.ts render()'s order-only candidate ladder: session row, then full,
   capacity, and percentage variants at provider, provider-focused, and essential priorities. */
function footerReplicaCandidates(input: {
  signature: string;
  level: string;
  essentialModel: string;
  contexts: readonly string[];
  session?: string;
}): FooterDisplayRow[] {
  const primary = input.contexts.map((context) =>
    input.level ? `${input.signature} · ${input.level} · ${context}` : `${input.signature} · ${context}`);
  const primaryFocused = input.contexts.map((context) => `${input.signature} · ${context}`);
  return [
    { left: primary[0] ?? "", right: input.session ?? "" },
    ...primary.map((left) => ({ left, right: "" })),
    ...primaryFocused.map((left) => ({ left, right: "" })),
    ...input.contexts.map((right) => ({ left: input.essentialModel, right })),
  ];
}

type FooterRecord = Record<string, unknown>;

type FooterFamily = {
  name: string;
  directory: string;
  project: string;
  agent: string;
  temporary: string;
  session: string;
  trace: string;
  env: NodeJS.ProcessEnv;
  fixtureGitCalls: number;
};

function isFooterRecord(value: unknown): value is FooterRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createFooterFamily(name: string, options: { outsideRepository?: boolean; path?: string } = {}): FooterFamily {
  // Corrupting HEAD must not let Git discover the checkout above the fixture.
  const parent = os.tmpdir();
  const directory = mkdtempSync(path.join(parent, `.killeros-footer-${name}-`));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const temporary = path.join(directory, "tmp");
  const sessions = path.join(directory, "sessions");
  for (const folder of [project, agent, temporary, sessions]) mkdirSync(folder);
  const trace = path.join(directory, "git-trace2.jsonl");
  const globalGitConfig = path.join(directory, "empty-git-config");
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"),
    TEMP: temporary,
    TMP: temporary,
    PATH: options.path ?? process.env.PATH ?? "",
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalGitConfig,
    GIT_TRACE2_EVENT: trace,
    // FooterGitSchedule.test.ts checks the real five-second watch cooldown; these scenarios only need scans to follow changes.
    KILLEROS_FOOTER_WATCH_INTERVAL_MS: "500",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };
  writeFileSync(globalGitConfig, "", "utf8");
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([entry]) => entry.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  return { name, directory, project, agent, temporary, session: path.join(sessions, "footer.jsonl"), trace, env, fixtureGitCalls: 0 };
}

function writeFooterSettings(agent: string, options: { completionSound?: boolean; keepRecentTokens?: number } = {}): void {
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
    compaction: { enabled: false, ...(options.keepRecentTokens === undefined ? {} : { keepRecentTokens: options.keepRecentTokens }) },
    retry: { enabled: false }, defaultThinkingLevel: "off" }), "utf8");
  writeFileSync(path.join(agent, "killeros.json"), JSON.stringify({
    autoCompaction: { enabled: false, percentRemaining: 15 }, completionSound: options.completionSound ?? false,
  }), "utf8");
}

function writeFooterLocalModels(agent: string, port: number): void {
  const cost = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "footer-local": {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "footer-local-fixture-only",
    models: [{ id: "local", name: "footer local", reasoning: false, input: ["text"], contextWindow: 1_000_000,
      maxTokens: 2_000, cost }],
  } } }), "utf8");
}

function footerUsage(cost: number): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function footerSavedCompactionCount(sessionFile: string): number {
  return SessionManager.open(sessionFile).getEntries().filter((entry) => entry.type === "compaction").length;
}

function footerLastCompactionEntryId(sessionFile: string): string | undefined {
  return SessionManager.open(sessionFile).getEntries().filter((entry) => entry.type === "compaction").at(-1)?.id;
}

function footerSavedBranchSummaryCount(sessionFile: string): number {
  return SessionManager.open(sessionFile).getEntries().filter((entry) => entry.type === "branch_summary").length;
}

/** Test provider requests enter through Pi's public configured transport. */
class FooterFixtureProvider {
  readonly requests: FooterRecord[] = [];
  readonly errors: unknown[] = [];
  private readonly server = createServer((request, response) => {
    void this.respond(request, response);
  });

  private readonly readTarget: string;
  private readonly firstResponse: Promise<void>;
  readonly releaseFirstResponse: () => void;

  constructor(readTarget: string) {
    this.readTarget = readTarget;
    let release: (() => void) | undefined;
    this.firstResponse = new Promise<void>((resolve) => { release = resolve; });
    assert.ok(release);
    this.releaseFirstResponse = release;
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 5_000;
  }

  async listen(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Footer fixture provider did not bind a TCP port"));
      });
    });
  }

  async close(): Promise<void> {
    this.releaseFirstResponse();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeAllConnections();
    });
  }

  private async respond(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size < 1_048_576, "Footer provider request exceeded its bounded body");
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.method, "POST");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(isFooterRecord(body));
      this.requests.push(body);
      const ordinal = this.requests.length;
      assert.ok(ordinal <= 6, `Unexpected footer provider request ${ordinal}`);
      assert.equal(body.model, "local");
      if (ordinal === 1) await this.firstResponse;
      if (response.destroyed) return;

      const common = { id: `footer-fixture-${ordinal}`, model: "local", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      const payload = ordinal === 1
        ? { ...common, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "footer-read-call",
          type: "function", function: { name: "read", arguments: JSON.stringify({ path: this.readTarget }) } }] }, finish_reason: "tool_calls" }] }
        : { ...common, choices: [{ index: 0, delta: { content: ordinal === 2 ? "Footer request settled"
          : ordinal === 3 ? "Footer history summary"
          : ordinal === 6 ? "Footer tree summary" : "Footer turn-prefix summary" },
          finish_reason: "stop" }] };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      this.errors.push(error);
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { connection: "close" });
        response.end("Footer fixture rejected request");
      }
    }
  }
}

function writeFooterMetadataExtension(extensionPath: string, port: number, unsafeProvider: string, unsafeModelId: string): void {
  const source = `import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export default function (pi) {
const openai = openaiProvider();
const response = openai.getModels().find((model) => model.api === "openai-responses");
if (!response) throw new Error("Pi's native OpenAI Responses model is unavailable");
const { baseUrl: _baseUrl, contextWindow: _contextWindow, ...withoutEndpointAndCapacity } = response;
const nativeModels = [
  { ...response, id: "gpt-6.1-sol", name: "gpt-6.1-sol", baseUrl: "https://api.openai.com/v1", contextWindow: 1050000 },
  { ...response, id: "gpt-5.6-sol", name: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1/", contextWindow: 1050000 },
  { ...response, id: "invalid-host", name: "invalid-host", baseUrl: "https://example.invalid/v1" },
  { ...response, id: "completions-api", name: "completions-api", api: "openai-completions" },
  { ...response, id: "virtual-api", name: "virtual-api", api: "virtual" },
  { ...withoutEndpointAndCapacity, id: "no-endpoint", name: "no-endpoint" },
];
pi.registerProvider({ ...openai, getModels: () => nativeModels });

const codex = openaiCodexProvider();
const codexModel = codex.getModels()[0];
if (!codexModel) throw new Error("Pi's native Codex model is unavailable");
pi.registerProvider({ ...codex, getModels: () => [{ ...codexModel, id: "codex-footer", name: "codex-footer", contextWindow: 1000000 }] });

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const simpleModel = (id, name, contextWindow) => ({ id, name, reasoning: false, input: ["text"],
  ...(contextWindow === "missing" ? {} : { contextWindow }), maxTokens: 2000, cost });
pi.registerProvider("footer-context", {
  baseUrl: "http://127.0.0.1:${port}/metadata/v1", api: "openai-completions", apiKey: "footer-metadata-fixture-only",
  models: [
    simpleModel("context-valid", "context valid", 200000),
    simpleModel("context-missing", "context missing", "missing"),
    simpleModel("context-zero", "context zero", 0),
    simpleModel("context-negative", "context negative", -1),
    simpleModel("context-nan", "context NaN", Number.NaN),
    simpleModel("context-infinite", "context infinite", Number.POSITIVE_INFINITY),
  ],
});
pi.registerProvider("azure", {
  baseUrl: "https://api.openai.com/v1", api: "openai-responses", apiKey: "footer-azure-fixture-only",
  models: [{ id: "azure-footer", name: "azure-footer", reasoning: false, input: ["text"], contextWindow: 1000000,
    maxTokens: 2000, cost }],
});
pi.registerProvider("anthropic", {
  baseUrl: "https://api.openai.com/v1", api: "openai-responses", apiKey: "footer-anthropic-fixture-only",
  models: [{ id: "anthropic-footer", name: "anthropic-footer", reasoning: false, input: ["text"], contextWindow: 1000000,
    maxTokens: 2000, cost }],
});
pi.registerProvider(${JSON.stringify(unsafeProvider)}, {
  baseUrl: "http://127.0.0.1:1/controls", api: "openai-completions", apiKey: "footer-controls-fixture-only",
  models: [{ id: ${JSON.stringify(unsafeModelId)}, name: "\\u001b]2;owned\\u0007\\u001b[31m\\u001b[0m", reasoning: false,
    input: ["text"], contextWindow: 1000000, maxTokens: 2000, cost }],
});
pi.registerCommand("footer-controls", {
  description: "Select the control-character fixture through Pi's public model API",
  handler: async (_args, ctx) => {
    const model = ctx.modelRegistry.find(${JSON.stringify(unsafeProvider)}, ${JSON.stringify(unsafeModelId)});
    if (!model || !await pi.setModel(model)) throw new Error("Pi rejected the control-character fixture model");
    ctx.ui.notify("Footer controls selected", "info");
  },
});
pi.registerCommand("footer-model", {
  description: "Report the current native model metadata",
  handler: async (_args, ctx) => {
    const model = ctx.model;
    if (!model) throw new Error("No current model");
    ctx.ui.notify(["footer-model", JSON.stringify(model.provider), JSON.stringify(model.id),
      JSON.stringify(model.api), JSON.stringify(model.baseUrl ?? null)].join(" "), "info");
  },
});
pi.registerCommand("footer-navigate", {
  description: "Navigate the real session tree with a native branch summary",
  handler: async (args, ctx) => {
    const targetId = args.trim();
    if (!targetId) throw new Error("footer-navigate requires an entry id");
    const result = await ctx.navigateTree(targetId, { summarize: true });
    if (result.cancelled) throw new Error("Pi cancelled footer tree navigation");
    ctx.ui.notify("Footer tree navigated", "info");
  },
});
pi.registerProvider("future_provider", {
  baseUrl: "http://127.0.0.1:1/controls", api: "openai-completions", apiKey: "footer-controls-fixture-only",
  models: [simpleModel("future-model", "future model", 1000000)],
});
pi.registerProvider("deepseek", {
  baseUrl: "http://127.0.0.1:1/controls", api: "openai-completions", apiKey: "footer-controls-fixture-only",
  models: [simpleModel("deepseek-v4-flash", "deepseek v4 flash", 1000000)],
});
}
`;
  writeFileSync(extensionPath, source, "utf8");
}

function footerCliArgs(family: FooterFamily, model: string, extensionPath?: string, options: { trusted?: boolean; tools?: string } = {}): string[] {
  return [cliPath, "--model", model, "--thinking", "off", "--tools", options.tools ?? "read", "--session", family.session,
    "--offline", options.trusted === false ? "--no-approve" : "--approve", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
    ...(extensionPath === undefined ? [] : ["--extension", extensionPath])];
}

function footerLine(screen: string): string {
  return screen.split("\n").filter((line) => /ctx (?:\d+|—)%/u.test(line)).at(-1) ?? "";
}

async function submitFooterText(terminal: PiTerminalProcess, text: string, signal: AbortSignal): Promise<void> {
  await terminal.submitEditorText(text, { signal });
}

async function selectFooterModel(terminal: PiTerminalProcess, model: string, signal: AbortSignal, predicate: (screen: string) => boolean): Promise<string> {
  const after = terminal.sequence;
  await submitFooterText(terminal, `/model ${model}`, signal);
  // The first Enter may accept Pi's argument completion rather than run /model.
  terminal.write(enter);
  return await terminal.waitForScreen(predicate, { signal, after });
}

async function runFooterPrompt(terminal: PiTerminalProcess, text: string, signal: AbortSignal, predicate: (screen: string) => boolean): Promise<string> {
  const after = terminal.sequence;
  await submitFooterText(terminal, text, signal);
  return await terminal.waitForScreen(predicate, { signal, after, timeoutMs: 60_000 });
}

test("Footer preserves model, context, cost, goal, and priority information across widths", { timeout: 240_000 }, async (t: TestContext) => {
  const family = createFooterFamily("information", { outsideRepository: true });
  const readTarget = path.join(family.project, "footer-read.txt");
  writeFileSync(readTarget, "real Pi read-tool content\n", "utf8");
  const provider = new FooterFixtureProvider(readTarget);
  const extensionPath = path.join(family.directory, "footer-metadata.ts");
  const unsafeProvider = "future_\x1b]2;owned\x07\x1b[31mprivate\x1b[0m";
  const unsafeModelId = "Next\x1b]2;owned\x07\x1b[31m Model\x1b[0m";
  writeFooterMetadataExtension(extensionPath, 1, unsafeProvider, unsafeModelId);
  let terminal: PiTerminalProcess | undefined;
  let terminalClose: Awaited<ReturnType<PiTerminalProcess["close"]>> | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const screens: Record<string, string> = {};
  let piLaunches = 0;
  let providerClosed = false;
  try {
    // The project stays outside the checkout; the extension still resolves installed public packages.
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(family.directory, "node_modules"), "junction");
    const port = await provider.listen();
    writeFooterLocalModels(family.agent, port);
    writeFooterSettings(family.agent, { keepRecentTokens: 0 });
    writeFileSync(path.join(family.agent, "auth.json"), JSON.stringify({
      openai: { type: "oauth", access: "footer-openai-fixture-access", refresh: "footer-openai-fixture-refresh",
        expires: Date.now() + 3_600_000, clientId: "footer-fixture", scopes: ["openid"] },
      "openai-codex": { type: "oauth", access: "footer-codex-fixture-access", refresh: "footer-codex-fixture-refresh",
        expires: Date.now() + 3_600_000, clientId: "footer-fixture", scopes: ["chatgpt.tokens.use.direct"] },
    }), "utf8");

    const session = SessionManager.create(family.project, path.dirname(family.session));
    const seededAt = Date.now();
    const userEntry = session.appendMessage({ role: "user", content: "Seeded footer cost history", timestamp: seededAt });
    const seededAssistant: AssistantMessage = {
      role: "assistant", content: [{ type: "toolCall", id: "footer-seeded-call", name: "read", arguments: { path: readTarget } }],
      api: "openai-completions", provider: "footer-local", model: "local", usage: footerUsage(1), stopReason: "toolUse", timestamp: seededAt,
    };
    session.appendMessage(seededAssistant);
    const seededToolResult: ToolResultMessage = {
      role: "toolResult", toolCallId: "footer-seeded-call", toolName: "read",
      content: [{ type: "text", text: "Seeded footer tool result" }], usage: footerUsage(2), isError: false, timestamp: seededAt,
    };
    session.appendMessage(seededToolResult);
    session.appendCompaction("Seeded compaction usage", userEntry, 1, {}, false, footerUsage(3));
    session.branchWithSummary(userEntry, "Seeded branch summary usage", {}, false, footerUsage(4));
    session.appendCustomEntry("killeros-goal", { version: 1, event: "set", state: {
      version: 1, revision: 1, objective: "Footer turn-limit fixture", status: "active",
      createdAt: seededAt, updatedAt: seededAt, activeMilliseconds: 0, activeStartedAt: seededAt,
      // Native restoration begins turn three; hold its HTTP reply during width checks.
      turns: 2, blockedAuditStartTurn: 0, baselineTokens: 0, maxTurns: 8, turnPhase: "ready",
    } });
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);
    family.session = sessionFile;

    terminal = new PiTerminalProcess({ file: process.execPath,
      args: footerCliArgs(family, "footer-local/local", extensionPath, { tools: "read,killeros_goal_update" }),
      cwd: family.project, env: family.env, cols: 120, rows: 34 });
    piLaunches += 1;
    screens.startup = await terminal.waitForScreen((screen) => screen.includes("footer local")
      && screen.includes("/goal active · 3/8") && footerLine(screen) !== "", { signal: t.signal });
    assert.match(footerLine(screens.startup), /1M/u);
    assert.match(screens.startup, /\$10\.00/u, "Assistant, tool, compaction, and branch-summary history all contributes cost");
    assert.match(screens.startup, /\/goal active · 3\/8/u, "A restored active goal displays its compact turn limit");

    for (const width of [64, 40, 26]) {
      const after = terminal.sequence;
      terminal.resize(width, 34);
      screens[`active-goal-width-${width}`] = await terminal.waitForScreen(
        (screen) => screen.split("\n").includes("─".repeat(width))
          && screen.includes("/goal active · 3/8"), { signal: t.signal, after });
      assert.match(screens[`active-goal-width-${width}`] ?? "", /\/goal active · 3\/8/u,
        `The restored active goal keeps its turn limit at width ${width}`);
    }
    const restoreWide = terminal.sequence;
    terminal.resize(120, 34);
    await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120))
      && screen.includes("/goal active · 3/8"), { signal: t.signal, after: restoreWide });

    const beforeRestoredReply = terminal.sequence;
    provider.releaseFirstResponse();
    screens.prompt = await terminal.waitForScreen((screen) => screen.includes("Footer request settled")
      && /\$14\.00/u.test(footerLine(screen)) && screen.includes("/goal paused"),
    { signal: t.signal, after: beforeRestoredReply, timeoutMs: 60_000 });
    assert.equal(provider.requests.length, 2, "The tool call and its assistant follow-up use exactly two model requests");
    const firstRequest = provider.requests[0];
    const secondRequest = provider.requests[1];
    assert.ok(firstRequest && secondRequest);
    assert.equal(firstRequest.model, "local");
    assert.equal(secondRequest.model, "local");
    assert.match(JSON.stringify(firstRequest.tools), /read/u, "The real request declares Pi's read tool");
    assert.match(JSON.stringify(secondRequest.messages), /real Pi read-tool content/u, "The continuation includes the public tool result");
    assert.match(screens.prompt, /\$14\.00/u, "Settled assistant usage refreshes the displayed cost after session content changes");

    const beforeCompact = terminal.sequence;
    await submitFooterText(terminal, "/compact", t.signal);
    let savedCompactionCount = 0;
    screens.compaction = await terminal.waitForScreen((screen) => {
      savedCompactionCount = footerSavedCompactionCount(sessionFile);
      return savedCompactionCount === 2 && /\$18\.00/u.test(footerLine(screen));
    }, { signal: t.signal, after: beforeCompact, timeoutMs: 60_000 });
    assert.equal(savedCompactionCount, 2, "Pi saved a second public session compaction entry");
    assert.match(footerLine(screens.compaction), /\$18\.00/u,
      "Compaction refreshes the current footer cost independently of transcript history");
    assert.equal(provider.requests.length, 4, "Split-turn manual compaction makes one history and one turn-prefix request");
    const historySummaryRequest = provider.requests[2];
    const turnPrefixRequest = provider.requests[3];
    assert.ok(historySummaryRequest && turnPrefixRequest);
    assert.equal(historySummaryRequest.model, "local");
    assert.equal(turnPrefixRequest.model, "local");
    assert.notDeepEqual(historySummaryRequest.messages, turnPrefixRequest.messages,
      "Pi sends distinct public requests for history and turn-prefix summaries");

    const beforeFastResize = terminal.sequence;
    terminal.resize(120, 34);
    await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120)),
      { signal: t.signal, after: beforeFastResize });
    const initiallyDisabled = await selectFooterModel(terminal, "openai/gpt-6.1-sol", t.signal,
      (screen) => footerLine(screen).includes("gpt-6.1-sol"));
    assert.doesNotMatch(footerLine(initiallyDisabled), /\bfast\b/u);
    const initialNarrow = terminal.sequence;
    terminal.resize(26, 34);
    const initiallyDisabledNarrow = await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(26))
      && footerLine(screen) !== "", { signal: t.signal, after: initialNarrow });
    assert.doesNotMatch(footerLine(initiallyDisabledNarrow), /\bfast\b/u);
    terminal.resize(120, 34);
    await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120)), { signal: t.signal });
    const fastOn = terminal.sequence;
    await submitFooterText(terminal, "/codex-fast", t.signal);
    screens.fastOn = await terminal.waitForScreen((screen) => screen.includes("Fast enabled"), { signal: t.signal, after: fastOn });
    const fastModels = [
      { provider: "openai", id: "gpt-6.1-sol", label: "gpt-6.1-sol", api: "openai-responses",
        baseUrl: "https://api.openai.com/v1", eligible: true },
      { provider: "openai", id: "gpt-5.6-sol", label: "gpt-5.6-sol", api: "openai-responses",
        baseUrl: "https://api.openai.com/v1/", eligible: true },
      { provider: "openai-codex", id: "codex-footer", label: "codex-footer", api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api", eligible: true },
      { provider: "azure", id: "azure-footer", label: "azure-footer", api: "openai-responses",
        baseUrl: "https://api.openai.com/v1", eligible: false },
      { provider: "anthropic", id: "anthropic-footer", label: "anthropic-footer", api: "openai-responses",
        baseUrl: "https://api.openai.com/v1", eligible: false },
      { provider: "openai", id: "completions-api", label: "completions-api", api: "openai-completions",
        baseUrl: "https://api.openai.com/v1", eligible: false },
      { provider: "openai", id: "virtual-api", label: "virtual-api", api: "virtual",
        baseUrl: "https://api.openai.com/v1", eligible: false },
      { provider: "openai", id: "invalid-host", label: "invalid-host", api: "openai-responses",
        baseUrl: "https://example.invalid/v1", eligible: false },
      { provider: "openai", id: "no-endpoint", label: "no-endpoint", api: "openai-responses",
        baseUrl: null, eligible: false },
    ] as const;
    for (const item of fastModels) {
      // The driver's editor-echo barrier requires the complete command on one row.
      terminal.resize(120, 34);
      await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120)),
        { signal: t.signal });
      await selectFooterModel(terminal, `${item.provider}/${item.id}`, t.signal,
        (screen) => footerLine(screen) !== "" && footerLine(screen).includes(item.label));
      const marker = ["footer-model", JSON.stringify(item.provider), JSON.stringify(item.id),
        JSON.stringify(item.api), JSON.stringify(item.baseUrl)].join(" ");
      const selected = await runFooterPrompt(terminal, "/footer-model", t.signal,
        (screen) => footerLine(screen).includes(item.label) && screen.includes(marker));
      screens[`fast-wide-${item.id}`] = selected;
      assert.equal(/\bfast\b/u.test(footerLine(selected)), item.eligible,
        `${item.provider}/${item.id} ${item.api}/${item.baseUrl} fast label at width 120`);
      if (item.eligible) assert.ok(footerLine(selected).includes(`${item.label} fast openai`),
        `${item.provider}/${item.id} renders the full eligible label`);
      if (item.eligible) assert.ok(footerRawOutput(terminal).includes(`${item.label} fast \x1b[2mopenai`),
        "The fast label shares the native model text style before the dim provider");
      const beforeNarrow = terminal.sequence;
      terminal.resize(26, 34);
      screens[`fast-narrow-${item.id}`] = await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(26))
        && footerLine(screen).includes(item.label)
        && /\bfast\b/u.test(footerLine(screen)) === item.eligible, { signal: t.signal, after: beforeNarrow });
      assert.equal(/\bfast\b/u.test(footerLine(screens[`fast-narrow-${item.id}`] ?? "")), item.eligible,
        `${item.provider}/${item.id} ${item.api}/${item.baseUrl} fast label at width 26`);
      if (item.eligible) assert.ok(footerLine(screens[`fast-narrow-${item.id}`] ?? "").includes(`${item.label} fast`));
      assert.doesNotMatch(footerLine(screens[`fast-narrow-${item.id}`] ?? ""), /openai/u);
      terminal.resize(120, 34);
      await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120)), { signal: t.signal });
      const beforeOff = terminal.sequence;
      await submitFooterText(terminal, "/codex-fast", t.signal);
      const offWide = await terminal.waitForScreen((screen) => screen.includes("Fast disabled")
        && footerLine(screen).includes(item.label) && !/\bfast\b/u.test(footerLine(screen)),
      { signal: t.signal, after: beforeOff });
      assert.doesNotMatch(footerLine(offWide), /\bfast\b/u, `${item.id} disabled at width 120`);
      const beforeOffNarrow = terminal.sequence;
      terminal.resize(26, 34);
      const offNarrow = await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(26))
        && footerLine(screen) !== "", { signal: t.signal, after: beforeOffNarrow });
      assert.doesNotMatch(footerLine(offNarrow), /\bfast\b/u, `${item.id} disabled at width 26`);
      terminal.resize(120, 34);
      await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120)), { signal: t.signal });
      const beforeOn = terminal.sequence;
      await submitFooterText(terminal, "/codex-fast", t.signal);
      await terminal.waitForScreen((screen) => screen.includes("Fast enabled"), { signal: t.signal, after: beforeOn });
      assert.equal(provider.requests.length, 4, "Changing model metadata and fast preference starts no provider request");
    }
    const beforeControlsResize = terminal.sequence;
    terminal.resize(120, 34);
    await terminal.waitForScreen((screen) => screen.split("\n").includes("─".repeat(120)),
      { signal: t.signal, after: beforeControlsResize });
    const fastOff = terminal.sequence;
    await submitFooterText(terminal, "/codex-fast", t.signal);
    screens.fastOff = await terminal.waitForScreen((screen) => screen.includes("Fast disabled"), { signal: t.signal, after: fastOff });
    const disabled = await selectFooterModel(terminal, "openai/gpt-6.1-sol", t.signal,
      (screen) => footerLine(screen).includes("gpt-6.1-sol"));
    assert.doesNotMatch(footerLine(disabled), /\bfast\b/u);

    // Parsed screens are SGR-free, so the sanitized labels match as plain text.
    const calibratedModels = [
      { provider: unsafeProvider, id: unsafeModelId, label: "next model future private" },
      { provider: "future_provider", id: "future-model", label: "future-model future provider" },
      { provider: "deepseek", id: "deepseek-v4-flash", label: "deepseek-v4-flash deepseek" },
    ] as const;
    for (const item of calibratedModels) {
      const selected = item.provider === unsafeProvider
        ? await runFooterPrompt(terminal, "/footer-controls", t.signal,
          (screen) => screen.includes("Footer controls selected") && footerLine(screen).includes(item.label))
        : await selectFooterModel(terminal, `${item.provider}/${item.id}`, t.signal,
          (screen) => footerLine(screen).includes(item.label));
      assert.ok(footerLine(selected).includes(item.label),
        `${item.provider}/${item.id} renders its sanitized label`);
    }
    assert.equal(provider.requests.length, 4, "Display calibration selections start no provider request");

    const contextModels = [
      { id: "context-valid", expected: /200K/u },
      { id: "context-missing", expected: /ctx —%/u },
      { id: "context-zero", expected: /ctx —%/u },
      { id: "context-negative", expected: /ctx —%/u },
      { id: "context-nan", expected: /ctx —%/u },
      { id: "context-infinite", expected: /ctx —%/u },
    ] as const;
    for (const item of contextModels) {
      screens[`context-${item.id}`] = await selectFooterModel(terminal, `footer-context/${item.id}`, t.signal,
        (screen) => footerLine(screen).includes(item.id));
      assert.match(footerLine(screens[`context-${item.id}`] ?? ""), item.expected, `${item.id} context capacity`);
      if (item.id !== "context-valid") {
        assert.doesNotMatch(footerLine(screens[`context-${item.id}`] ?? ""), /\/compact/u);
        assert.doesNotMatch(footerLine(screens[`context-${item.id}`] ?? ""), /\(/u,
          `${item.id} must not render a full detail parenthetical`);
        assert.doesNotMatch(footerLine(screens[`context-${item.id}`] ?? ""), /\b\d+(?:\.\d+)?[KM]\b/u,
          `${item.id} must not render formatted capacity tokens`);
      }
      assert.equal(provider.requests.length, 4, "Context metadata selection starts no provider request");
    }

    await selectFooterModel(terminal, "footer-local/local", t.signal, (screen) => footerLine(screen).includes("1M"));
    await runFooterPrompt(terminal, "Restore measured context after compaction", t.signal,
      (screen) => /ctx \d+% \(/u.test(footerLine(screen)));
    assert.equal(provider.requests.length, 5, "One ordinary request restores post-compaction context telemetry");
    // Wide anchor: measure the full and percentage context tokens the footer really rendered.
    terminal.resize(120, 34);
    const wideAnchor = await terminal.waitForScreen(
      (screen) => /ctx \d+% \([^()]+\/[^()]+\)/u.test(footerLine(screen)), { signal: t.signal });
    const wideMeta = footerLine(wideAnchor);
    const percentTokenMatch = wideMeta.match(/ctx \d+%/u);
    const ctxDetailMatch = wideMeta.match(/ctx \d+% \([^()]+\/[^()]+\)/u);
    assert.ok(percentTokenMatch && ctxDetailMatch, "The wide footer anchor rendered full and percentage context tokens");
    const percentToken = percentTokenMatch[0];
    const ctxDetail = ctxDetailMatch[0];
    const capacityToken = `${percentToken} (1M)`;
    const essentialModel = "local";
    // ConPTY clamps its physical size to at least two columns.
    for (let width = 2; width <= 180; width += 1) {
      const after = terminal.sequence;
      terminal.resize(width, 34);
      const expectedRow = (metaRow: string): string => {
        const session = metaRow.match(/(?:\d+h )?(?:\d+m )?\d+s · \$\d+\.\d{2}/u)?.[0] ?? "";
        const candidates = footerReplicaCandidates({
          signature: "local footer local", level: "no reasoning", essentialModel,
          contexts: [ctxDetail, capacityToken, percentToken], session,
        });
        const selected = candidates.find(({ left, right }) => footerReplicaFits(left, right, width))
          ?? { left: essentialModel, right: percentToken };
        return stripVTControlCharacters(footerReplicaRow(selected.left, selected.right, width)).trimEnd();
      };
      const screen: string = await terminal.waitForScreen((value) => {
        const rows = value.split("\n");
        const border = rows.lastIndexOf("─".repeat(width));
        const meta = rows[border + 1] ?? "";
        return border >= 0 && meta.trimEnd() === expectedRow(meta);
      }, { signal: t.signal, after });
      const lines: string[] = screen.split("\n");
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width), `screen clips to ${width} cells`);
      const borderIndex = lines.lastIndexOf("─".repeat(width));
      const metaRow = lines[borderIndex + 1] ?? "";
      assert.equal(metaRow.trimEnd(), expectedRow(metaRow),
        `footer meta row matches the production candidate ladder at width ${width}`);
      if (width >= 18) assert.ok(metaRow.includes("local"), `the essential model label survives at width ${width}`);
      if (width >= 12) assert.match(metaRow, /ctx \d+%/u, `the context percentage survives at width ${width}`);
    }
    assert.equal(provider.requests.length, 5, "Footer redraws across priority widths start no request");
    const treeTarget = footerLastCompactionEntryId(sessionFile);
    assert.ok(treeTarget, "The footer session has a saved compaction entry to navigate to");
    const beforeTree = terminal.sequence;
    await submitFooterText(terminal, `/footer-navigate ${treeTarget}`, t.signal);
    screens.tree = await terminal.waitForScreen((screen) => screen.includes("Footer tree navigated")
      && /\$22\.00/u.test(footerLine(screen)), { signal: t.signal, after: beforeTree, timeoutMs: 60_000 });
    assert.match(footerLine(screens.tree), /\$22\.00/u,
      "Native tree navigation refreshes session cost from the saved branch-summary usage");
    assert.equal(provider.requests.length, 6, "Native tree navigation makes one branch-summary request");
    const treeSummaryRequest = provider.requests[5];
    assert.ok(treeSummaryRequest);
    assert.equal(treeSummaryRequest.model, "local");
    assert.equal(footerSavedBranchSummaryCount(sessionFile), 2,
      "Native tree navigation saves a second public branch-summary entry");
    assert.deepEqual(provider.errors, []);
    terminalClose = await terminal.close();
    assert.deepEqual(terminalClose, { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        terminalClose = result;
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Footer information terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await provider.close(); providerClosed = true; } catch (error) { cleanupFailures.push(error); }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || provider.errors.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Footer information E2E failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...provider.errors],
      diagnostics: JSON.stringify({ directory: family.directory, platform: process.platform, node: process.version, pi: piVersion,
        providerRequests: provider.requests.length, piLaunches, fixtureGitCalls: family.fixtureGitCalls,
        providerErrors: provider.errors.map(String), terminalClose, terminal: terminal?.diagnostics(), screens }),
    });
  }
  await removeDirectoryEventually(family.directory);
  assert.equal(existsSync(family.directory), false, "The FT-02 scratch directory is removed after terminal and provider cleanup");
  assert.equal(piLaunches, 1);
  assert.equal(providerClosed, true);
  assert.equal(family.fixtureGitCalls, 0);
  assert.ok(terminal);
  const terminalCleanup = footerTerminalCleanup(terminal);
  assert.equal(terminalCleanup.exitCode, 0);
  assert.equal(terminalCleanup.nativeResources, 0);
  t.diagnostic(JSON.stringify({ piLaunches, providerRequests: provider.requests.length, fixtureGitCalls: family.fixtureGitCalls,
    terminalClose, terminalCleanup, providerClosed, scratchDirectoryRemoved: true }));
});

type FooterTraceEvent = { event: string; sid?: string; time?: string; argv?: string[]; code?: number };

function readFooterTrace(trace: string): FooterTraceEvent[] {
  let contents: string;
  try { contents = readFileSync(trace, "utf8"); }
  catch (error) {
    if (isFooterRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const complete = contents.endsWith("\n") ? contents : contents.slice(0, contents.lastIndexOf("\n") + 1);
  const events: FooterTraceEvent[] = [];
  for (const line of complete.split(/\r?\n/u)) {
    if (!line) continue;
    const value: unknown = JSON.parse(line);
    assert.ok(isFooterRecord(value));
    const event = value.event;
    if (typeof event !== "string") continue;
    const sid = value.sid;
    const time = value.time;
    const argv = value.argv;
    const code = value.code;
    events.push({
      event,
      ...(typeof sid === "string" ? { sid } : {}),
      ...(typeof time === "string" ? { time } : {}),
      ...(Array.isArray(argv) && argv.every((item): item is string => typeof item === "string") ? { argv } : {}),
      ...(typeof code === "number" ? { code } : {}),
    });
  }
  return events;
}

function footerGitStarts(events: readonly FooterTraceEvent[]): FooterTraceEvent[] {
  return events.filter((event) => event.event === "start");
}

function footerScannerStarts(events: readonly FooterTraceEvent[]): FooterTraceEvent[] {
  return footerGitStarts(events).filter(({ argv = [] }) =>
    (argv.includes("--path-format=absolute") && argv.includes("--show-toplevel"))
    || argv.includes("core.fsmonitor=false")
    || (argv.includes("ls-tree") && argv.includes("--full-tree")));
}

function footerRootScanStarts(events: readonly FooterTraceEvent[]): FooterTraceEvent[] {
  return footerScannerStarts(events).filter(({ argv = [] }) =>
    argv.includes("--path-format=absolute") && argv.includes("--show-toplevel"));
}

function footerGitExits(events: readonly FooterTraceEvent[]): FooterTraceEvent[] {
  return events.filter((event) => event.event === "exit");
}

function footerRootScanCount(events: readonly FooterTraceEvent[]): number {
  return footerRootScanStarts(events).length;
}

async function waitForFooterTrace(
  trace: string,
  predicate: (events: readonly FooterTraceEvent[]) => boolean,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<FooterTraceEvent[]> {
  if (signal.aborted) throw new Error("Footer Git trace wait cancelled", { cause: signal.reason });
  const current = readFooterTrace(trace);
  if (predicate(current)) return current;
  return await new Promise<FooterTraceEvent[]>((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | undefined;
    const clean = (): void => {
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown): void => {
      clean();
      reject(error instanceof Error ? error : new Error("Footer Git trace wait failed", { cause: error }));
    };
    const check = (): void => {
      try {
        const events = readFooterTrace(trace);
        if (predicate(events)) { clean(); resolve(events); }
      } catch (error) { fail(error); }
    };
    const abort = (): void => fail(new Error("Footer Git trace wait cancelled", { cause: signal.reason }));
    const timer = setTimeout(() => fail(new Error(`Timed out waiting for footer Git trace: ${trace}`)), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      watcher = watch(path.dirname(trace), { persistent: false }, (_event, filename) => {
        if (filename === null || filename.toString() === path.basename(trace)) check();
      });
    } catch (error) { fail(error); return; }
    check();
  });
}

function footerGitFailureCount(events: readonly FooterTraceEvent[]): number {
  // Pi's separate startup branch query legitimately exits 128 for an unborn HEAD.
  const nativeBranchQueries = new Set(footerGitStarts(events)
    .filter((event) => event.argv?.includes("--abbrev-ref") && event.argv.includes("HEAD"))
    .map((event) => event.sid));
  return footerGitExits(events).filter((event) => !nativeBranchQueries.has(event.sid)
    && event.code !== undefined && event.code !== 0).length;
}

/**
 * Git children one successful footer scan starts: the root lookup, the index and untracked listings,
 * HEAD, and one settings read. A committed HEAD adds its tree listing.
 */
const footerScanCommands = 5;

async function waitForFooterGitScan(
  trace: string,
  before: readonly FooterTraceEvent[],
  signal: AbortSignal,
  options: { outcome: "success" | "failure"; repository: "present" | "absent"; committed?: boolean; count?: number; timeoutMs?: number },
): Promise<FooterTraceEvent[]> {
  const count = options.count ?? 1;
  const minimumScans = footerRootScanCount(before) + count;
  const startsBefore = footerGitStarts(before).length;
  const failuresBefore = footerGitFailureCount(before);
  const commandsPerScan = options.repository === "absent" || options.outcome === "failure"
    ? 1 : footerScanCommands + (options.committed ? 1 : 0);
  return await waitForFooterTrace(trace, (events) => {
    const starts = footerGitStarts(events);
    const exits = footerGitExits(events);
    if (footerRootScanCount(events) < minimumScans || starts.length < startsBefore + commandsPerScan * count || starts.length !== exits.length) return false;
    const failures = footerGitFailureCount(events);
    if (options.outcome === "success") return failures === failuresBefore;
    if (failures <= failuresBefore) return false;
    if (options.repository === "absent") return true;
    const rootStarts = starts.filter((event) => event.argv?.includes("--show-toplevel") === true);
    const targetRoot = rootStarts[minimumScans - 1];
    const rootExit = targetRoot?.sid === undefined ? undefined : exits.find((event) => event.sid === targetRoot.sid);
    return rootExit?.code !== undefined && rootExit.code !== 0
      || starts.length >= startsBefore + footerScanCommands;
  }, signal, options.timeoutMs ?? 20_000);
}

function footerGitEnvironment(family: FooterFamily): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: family.directory,
    USERPROFILE: family.directory,
    TEMP: family.temporary,
    TMP: family.temporary,
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(family.directory, "empty-git-config"),
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([entry]) => entry.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function footerGit(family: FooterFamily, cwd: string, ...args: string[]): string {
  family.fixtureGitCalls += 1;
  const env = footerGitEnvironment(family);
  delete env.GIT_TRACE2_EVENT;
  const gitDirectory = systemGitDirectories[0];
  assert.ok(gitDirectory, "Fixture preparation requires an absolute system Git");
  return execFileSync(path.join(gitDirectory, "git.exe"), ["-C", cwd, "-c", "core.fsmonitor=false", "-c", "filter.tripwire.clean=",
    "-c", "user.name=KillerOS Footer Fixture", "-c", "user.email=footer@fixture.invalid", ...args], {
    cwd, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
}

function initFooterRepository(family: FooterFamily, cwd = family.project): void {
  footerGit(family, cwd, "init", "--quiet", "--initial-branch=main");
}

function writePassiveFooterConfig(agent: string): void {
  writeFooterSettings(agent);
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "footer-local": {
    baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "footer-no-request-fixture-only",
    models: [{ id: "local", name: "footer local", reasoning: false, input: ["text"], contextWindow: 200_000,
      maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), "utf8");
}

function startFooterTerminal(
  family: FooterFamily,
  options: { model?: string; cwd?: string; extension?: string; trusted?: boolean; cols?: number } = {},
): PiTerminalProcess {
  return new PiTerminalProcess({ file: process.execPath,
    args: footerCliArgs(family, options.model ?? "footer-local/local", options.extension, { trusted: options.trusted }),
    cwd: options.cwd ?? family.project, env: family.env, cols: options.cols ?? 120, rows: 34 });
}

function footerRenderedGitLine(screen: string): string {
  return screen.match(/±\d+ \[~\d+ \+\d+ −\d+\]/u)?.[0] ?? "";
}

async function waitForFooterFailureBarrier(
  terminal: PiTerminalProcess,
  signal: AbortSignal,
  expectedGitLine: string,
): Promise<string> {
  const after = terminal.sequence;
  await submitFooterText(terminal, "/goal pause", signal);
  // Argument completion may consume the first Enter without executing the command.
  terminal.write(enter);
  return await terminal.waitForScreen((screen) => screen.includes("No goal is set")
    && !screen.split("\n").some((line) => line.includes("❯") && line.includes("/goal pause"))
    && footerRenderedGitLine(screen) === expectedGitLine, { signal, after });
}

function footerRawOutput(terminal: PiTerminalProcess): string {
  const diagnostics: unknown = JSON.parse(terminal.diagnostics());
  assert.ok(isFooterRecord(diagnostics));
  assert.ok(typeof diagnostics.rawBase64 === "string");
  return Buffer.from(diagnostics.rawBase64, "base64").toString("utf8");
}

function footerTerminalCleanup(terminal: PiTerminalProcess): { exitCode: number; nativeResources: number; nativeResourcesCreated: number } {
  const diagnostics: unknown = JSON.parse(terminal.diagnostics());
  assert.ok(isFooterRecord(diagnostics));
  const { exitCode, nativeResources, nativeResourcesCreated } = diagnostics;
  assert.ok(typeof exitCode === "number");
  assert.ok(typeof nativeResources === "number");
  assert.ok(typeof nativeResourcesCreated === "number");
  return { exitCode, nativeResources, nativeResourcesCreated };
}

// Fixture setup uses the unchanged parent PATH; hostile child PATH vectors stay separate.
const systemGitSearchPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
const systemGitDirectories = systemGitSearchPath.split(path.delimiter).filter((directory) => path.isAbsolute(directory)
  && existsSync(path.join(directory, "git.exe")));

/**
 * FT-04 harness: each recovery history is its own test with one Pi launch. `body` creates families and
 * starts terminals through the harness, which closes every terminal, reports diagnostics on failure,
 * and checks natural exit, native resource release, and scratch directory removal.
 */
async function footerRecovery(t: TestContext, body: (harness: {
  createFamily: (...args: Parameters<typeof createFooterFamily>) => FooterFamily;
  startTerminal: (...args: Parameters<typeof startFooterTerminal>) => PiTerminalProcess;
  screens: Record<string, string>;
}) => Promise<void>): Promise<void> {
  const families: FooterFamily[] = [];
  const terminals: PiTerminalProcess[] = [];
  const cleanupFailures: unknown[] = [];
  const screens: Record<string, string> = {};
  let failure: unknown;
  try {
    await body({
      createFamily: (...args) => { const family = createFooterFamily(...args); families.push(family); return family; },
      startTerminal: (...args) => { const terminal = startFooterTerminal(...args); terminals.push(terminal); return terminal; },
      screens,
    });
  } catch (error) { failure = error; }
  finally {
    for (const terminal of [...terminals].reverse()) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Footer recovery terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
  }
  const piLaunches = terminals.length;
  if (failure !== undefined || cleanupFailures.length > 0) {
    throwScenarioFailure({ directory: families[0]?.directory ?? repositoryRoot, message: "Footer recovery E2E failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      diagnostics: JSON.stringify({ directories: families.map((family) => family.directory), platform: process.platform,
        node: process.version, pi: piVersion, piLaunches,
        gitStarts: families.map((family) => footerGitStarts(readFooterTrace(family.trace)).length),
        gitExits: families.map((family) => footerGitExits(readFooterTrace(family.trace)).length), screens,
        terminals: terminals.map((terminal) => terminal.diagnostics()) }),
    });
  }
  assert.equal(piLaunches, 1, "Each FT-04 history launches Pi once");
  const familyCounts = families.map((family) => ({ name: family.name,
    piLaunchedGitChildren: footerGitStarts(readFooterTrace(family.trace)).length,
    scannerStarts: footerScannerStarts(readFooterTrace(family.trace)).length,
    fixtureGitCalls: family.fixtureGitCalls }));
  const terminalCleanup = terminals.map(footerTerminalCleanup);
  assert.ok(terminalCleanup.every(({ exitCode, nativeResources }) => exitCode === 0 && nativeResources === 0),
    "All FT-04 Pi terminals exit naturally and release native resources");
  for (const family of families) await removeDirectoryEventually(family.directory);
  const scratchDirectoriesRemoved = families.map((family) => ({ directory: family.directory, removed: !existsSync(family.directory) }));
  assert.ok(scratchDirectoriesRemoved.every(({ removed }) => removed), "Every FT-04 scratch directory is removed");
  const fixtureGitCalls = familyCounts.reduce((total, family) => total + family.fixtureGitCalls, 0);
  t.diagnostic(JSON.stringify({ providerRequests: 0, providerRequestBasis: "No model prompt is submitted; no provider server is configured",
    piLaunches, families: familyCounts, fixtureGitCalls, terminalCleanup, scratchDirectoriesRemoved }));
}

test("Footer Git status preserves last good counts through failures and recovers without recreation (recovery)", { timeout: 120_000 }, async (t: TestContext) => {
  await footerRecovery(t, async ({ createFamily, startTerminal, screens }) => {
    const recovery = createFamily("recovery");
    initFooterRepository(recovery);
    const tracked = path.join(recovery.project, "tracked.txt");
    const added = path.join(recovery.project, "added.txt");
    writeFileSync(tracked, "baseline\n", "utf8");
    footerGit(recovery, recovery.project, "add", ".");
    footerGit(recovery, recovery.project, "commit", "--quiet", "-m", "footer recovery baseline");
    writeFileSync(tracked, "changed\n", "utf8");
    writeFileSync(added, "new\n", "utf8");
    writePassiveFooterConfig(recovery.agent);

    const recoveryBefore = readFooterTrace(recovery.trace);
    const recoveryTerminal = startTerminal(recovery);
    const recoveryStartupSequence = recoveryTerminal.sequence;
    screens.recoveryStartup = await recoveryTerminal.waitForScreen((screen) => screen.includes("KillerOS") && footerLine(screen) !== "", { signal: t.signal });
    let events = await waitForFooterGitScan(recovery.trace, recoveryBefore, t.signal,
      { outcome: "success", repository: "present", committed: true });
    screens.recoveryDirty = await recoveryTerminal.waitForScreen((screen) => /±2 \[~1 \+1 −0\]/u.test(footerRenderedGitLine(screen)),
      { signal: t.signal, after: recoveryStartupSequence });

    // The head-states test covers committed HEAD failures; this history covers repository config failures.
    const recoveryBeforeConfigFailure = events;
    const recoveryGitConfig = path.join(recovery.project, ".git", "config");
    const savedRecoveryGitConfig = path.join(recovery.directory, "saved-git-config");
    renameSync(recoveryGitConfig, savedRecoveryGitConfig);
    mkdirSync(recoveryGitConfig);
    writeFileSync(tracked, "changed\n", "utf8");
    events = await waitForFooterGitScan(recovery.trace, recoveryBeforeConfigFailure, t.signal,
      { outcome: "failure", repository: "present" });
    screens.configFailure = await waitForFooterFailureBarrier(recoveryTerminal, t.signal, "±2 [~1 +1 −0]");
    assert.match(footerRenderedGitLine(screens.configFailure), /±2 \[~1 \+1 −0\]/u,
      "A malformed typed Git setting leaves the last successful counts in place");

    const recoveryBeforeRestore = events;
    rmSync(recoveryGitConfig, { recursive: true, force: true });
    renameSync(savedRecoveryGitConfig, recoveryGitConfig);
    events = await waitForFooterGitScan(recovery.trace, recoveryBeforeRestore, t.signal,
      { outcome: "success", repository: "present", committed: true });
    // Recovery produces the same counts, so no new footer frame is expected.
    assert.match(footerRenderedGitLine(recoveryTerminal.screen()), /±2 \[~1 \+1 −0\]/u);

    const recoveryBeforeCommit = events;
    const beforeCleanRender = recoveryTerminal.sequence;
    footerGit(recovery, recovery.project, "add", "-A");
    footerGit(recovery, recovery.project, "commit", "--quiet", "-m", "clean footer recovery");
    writeFileSync(tracked, "changed\n", "utf8");
    events = await waitForFooterGitScan(recovery.trace, recoveryBeforeCommit, t.signal,
      { outcome: "success", repository: "present", committed: true });
    screens.cleanRecovery = await recoveryTerminal.waitForScreen((screen) => footerRenderedGitLine(screen) === "",
      { signal: t.signal, after: beforeCleanRender });
    assert.equal(footerRenderedGitLine(screens.cleanRecovery), "", "A successful clean scan replaces the last good dirty counts");
    assert.deepEqual(await recoveryTerminal.close(), { code: 0, forced: false });
  });
});

test("Footer Git status preserves last good counts through failures and recovers without recreation (discovery)", { timeout: 120_000 }, async (t: TestContext) => {
  await footerRecovery(t, async ({ createFamily, startTerminal, screens }) => {
    const discovery = createFamily("discovery", { outsideRepository: true });
    initFooterRepository(discovery);
    const discoveryTracked = path.join(discovery.project, "tracked.txt");
    writeFileSync(discoveryTracked, "baseline\n", "utf8");
    footerGit(discovery, discovery.project, "add", ".");
    footerGit(discovery, discovery.project, "commit", "--quiet", "-m", "footer discovery baseline");
    writeFileSync(discoveryTracked, "dirty\n", "utf8");
    writePassiveFooterConfig(discovery.agent);

    const discoveryBefore = readFooterTrace(discovery.trace);
    const discoveryTerminal = startTerminal(discovery);
    const discoveryStartupSequence = discoveryTerminal.sequence;
    screens.discoveryStartup = await discoveryTerminal.waitForScreen((screen) => screen.includes("KillerOS") && footerLine(screen) !== "", { signal: t.signal });
    let events = await waitForFooterGitScan(discovery.trace, discoveryBefore, t.signal,
      { outcome: "success", repository: "present", committed: true });
    screens.discoveryDirty = await discoveryTerminal.waitForScreen((screen) => /±1 \[~1 \+0 −0\]/u.test(footerRenderedGitLine(screen)),
      { signal: t.signal, after: discoveryStartupSequence });

    const discoveryBeforeFailure = events;
    const removedGitDirectory = path.join(discovery.directory, "saved-git-directory");
    renameSync(path.join(discovery.project, ".git"), removedGitDirectory);
    writeFileSync(discoveryTracked, "dirty\n", "utf8");
    events = await waitForFooterGitScan(discovery.trace, discoveryBeforeFailure, t.signal,
      { outcome: "failure", repository: "absent" });
    screens.discoveryFailure = await waitForFooterFailureBarrier(discoveryTerminal, t.signal, "±1 [~1 +0 −0]");
    assert.match(footerRenderedGitLine(screens.discoveryFailure), /±1 \[~1 \+0 −0\]/u,
      "Failed repository discovery keeps the last successful result instead of showing clean");
    assert.ok(footerGitFailureCount(events) > footerGitFailureCount(discoveryBeforeFailure),
      "The unavailable discovery reached the selected system Git process");
    assert.deepEqual(await discoveryTerminal.close(), { code: 0, forced: false });
  });
});

test("Footer Git status preserves last good counts through failures and recovers without recreation (initial unavailable)", { timeout: 120_000 }, async (t: TestContext) => {
  await footerRecovery(t, async ({ createFamily, startTerminal, screens }) => {
    const initialUnavailable = createFamily("initial-unavailable", { outsideRepository: true });
    writePassiveFooterConfig(initialUnavailable.agent);
    const unavailableBefore = readFooterTrace(initialUnavailable.trace);
    const unavailableTerminal = startTerminal(initialUnavailable);
    screens.unavailableStartup = await unavailableTerminal.waitForScreen((screen) => screen.includes("KillerOS") && footerLine(screen) !== "", { signal: t.signal });
    let events = await waitForFooterGitScan(initialUnavailable.trace, unavailableBefore, t.signal,
      { outcome: "failure", repository: "absent" });
    screens.unavailableFailure = await waitForFooterFailureBarrier(unavailableTerminal, t.signal, "");
    assert.equal(footerRenderedGitLine(screens.unavailableFailure), "", "A failed initial discovery is not rendered as a clean repository");

    const unavailableBeforeRecovery = events;
    const beforeUnavailableRecoveryRender = unavailableTerminal.sequence;
    initFooterRepository(initialUnavailable);
    writeFileSync(path.join(initialUnavailable.project, "recovered.txt"), "available after startup\n", "utf8");
    events = await waitForFooterGitScan(initialUnavailable.trace, unavailableBeforeRecovery, t.signal,
      { outcome: "success", repository: "present", committed: false });
    screens.unavailableRecovery = await unavailableTerminal.waitForScreen((screen) => /±1 \[~0 \+1 −0\]/u.test(footerRenderedGitLine(screen)),
      { signal: t.signal, after: beforeUnavailableRecoveryRender });
    assert.match(footerRenderedGitLine(screens.unavailableRecovery), /±1 \[~0 \+1 −0\]/u,
      "The same footer instance recovers after an unavailable first refresh");
    assert.deepEqual(await unavailableTerminal.close(), { code: 0, forced: false });
  });
});
