import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { Type } from "typebox";
import { parseArgs } from "../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import {
  createAgentSession,
  createAgentSessionRuntime,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerRequestActivity } from "../killeros/activity.ts";
import { registerAutoCompaction } from "../killeros/auto-compaction.ts";
import { registerCodexFastMode } from "../killeros/codex-fast.ts";
import { isCodexFastEnabled, resetCodexFastState } from "../killeros/codex-fast-state.ts";
import { registerCompletionNotifications } from "../killeros/notifications.ts";
import { registerWorkedFor } from "../killeros/worked-for.ts";
import Killeros from "../Killeros.ts";
import { registerGoalInterface } from "../killeros/goal-interface.ts";
import { registerQuestionTool } from "../killeros/question.ts";
import { registerGoalRuntime } from "../killeros/goal-runtime.ts";
import { registerGoalSettlement } from "../killeros/goal-settlement.ts";
import { registerHandoff } from "../killeros/handoff.ts";
import { passiveGitCommand, passiveGitEnv } from "../killeros/passive-git-status.ts";
import { registerFooter } from "../killeros/footer.ts";
import { createGoalRuntime } from "../killeros/runtime.ts";
import { createNewGoalState, parseGoalState, transitionGoalState } from "../killeros/goal-state.ts";
import { createHarness, createTuiContext, theme, waitFor } from "./ExtensionTestHarness.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { extensionContextTestAdapter } from "./PiTestAdapters.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Runs npm with isolated config and no shell interpretation of paths. */
function runNpm(args: string[], cwd: string, userConfig: string, processEnv: NodeJS.ProcessEnv = process.env): string {
  const npmCli = process.env.npm_execpath ?? [path.dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)]
    .map((directory) => path.join(directory, "node_modules/npm/bin/npm-cli.js"))
    .find((candidate) => existsSync(candidate));
  assert.ok(npmCli && existsSync(npmCli), "Cannot locate npm-cli.js without a shell");
  const env = { ...processEnv };
  const globalConfig = `${userConfig}.global`;
  writeFileSync(globalConfig, "");
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const npmArgs = ["--userconfig", userConfig, "--globalconfig", globalConfig, "--loglevel", "error", ...args];
  const options = { cwd, encoding: "utf8" as const, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };
  return execFileSync(process.execPath, [npmCli, ...npmArgs], options);
}

function assertInstalledPackage(directory: string, expectedVersion: string): void {
  for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
    assert.equal(existsSync(path.join(directory, file)), true, `Package is missing: ${file}`);
  }
  const identity: unknown = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  assert.ok(isUnknownRecord(identity));
  assert.equal(identity.name, "killeros", "Unexpected package name");
  assert.equal(identity.version, expectedVersion, "Unexpected package version");
  assert.deepEqual(identity.os, ["win32"], "Package must restrict installation to Windows");
}

function isolatedFixtureEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  env.PATH = inherited.get("path") ?? "";
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.APPDATA = path.join(directory, "appdata");
  env.LOCALAPPDATA = path.join(directory, "localappdata");
  const temporaryDirectory = path.join(directory, "tmp");
  const emptyGitConfig = path.join(directory, "empty-git-config");
  env.TEMP = temporaryDirectory;
  env.TMP = temporaryDirectory;
  env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  env.GIT_CONFIG_SYSTEM = emptyGitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(emptyGitConfig, "");
  return env;
}

function initializeFixtureRepository(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const git = passiveGitCommand(cwd, env);
  assert.ok(git, "The fixture needs an absolute Git executable outside its repository");
  const gitEnv = passiveGitEnv(env);
  execFileSync(git, ["init", "--quiet"], { cwd, env: gitEnv, timeout: 15_000 });
  const discoveredGit = passiveGitCommand(cwd, env);
  assert.ok(discoveredGit, "The passive scanner must resolve Git after fixture initialization");
  const discoveredRoot = realpathSync.native(execFileSync(discoveredGit, ["rev-parse", "--show-toplevel"], {
    cwd, env: gitEnv, encoding: "utf8", timeout: 15_000,
  }).trim());
  const fixtureRoot = realpathSync.native(cwd);
  assert.equal(discoveredRoot.toLowerCase(), fixtureRoot.toLowerCase(),
    "KillerOS passive Git scans must resolve to the disposable fixture root");
  return discoveredGit;
}

function packageVersion(packageName: string): string {
  const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules", packageName, "package.json"), "utf8"));
  assert.ok(isUnknownRecord(manifest));
  const version = manifest.version;
  assert.ok(typeof version === "string", `Missing version for ${packageName}`);
  return version;
}

function rpcData(response: PiRpcRecord): Record<string, unknown> {
  assert.ok(isUnknownRecord(response.data), "RPC response omitted its data object");
  return response.data;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

test("npm package fixtures preserve shell-special paths without npm_execpath", { timeout: 90_000 }, (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-npm&literal-"));
  t.after(() => removeDirectoryEventually(directory));
  const userConfig = path.join(directory, "empty&literal.npmrc");
  writeFileSync(userConfig, "");
  const previous = process.env.npm_execpath;
  delete process.env.npm_execpath;
  try {
    const output = runNpm(["pack", "--dry-run", "--ignore-scripts", "--json"], repositoryRoot, userConfig,
      isolatedFixtureEnvironment(directory));
    const packed: unknown = JSON.parse(output);
    assert.ok(isUnknownArray(packed) && isUnknownRecord(packed[0]));
    const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.ok(isUnknownRecord(manifest));
    assert.equal(packed[0].id, `killeros@${String(manifest.version)}`);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  }
});

test("installed Pi CLI rejects KillerOS activation on unsupported operating systems", { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-platform-"));
  t.after(() => removeDirectoryEventually(directory));
  const env = isolatedFixtureEnvironment(directory);
  const agentDirectory = path.join(directory, "agent");
  mkdirSync(agentDirectory);
  const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  for (const platform of ["linux", "darwin"]) {
    await t.test(platform, async () => {
      const extension = path.join(directory, `${platform}.ts`);
      writeFileSync(extension, `
        import Killeros from ${JSON.stringify(new URL("../Killeros.ts", import.meta.url).href)};
        export default function (pi) {
          const original = Object.getOwnPropertyDescriptor(process, "platform");
          Object.defineProperty(process, "platform", { ...original, value: ${JSON.stringify(platform)} });
          try { Killeros(pi); }
          finally { Object.defineProperty(process, "platform", original); }
        }
      `);
      const cli = new PiRpcProcess({ cliPath, cwd: directory,
        args: ["--mode", "rpc", "--offline", "--approve", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--extension", extension],
        env: { ...env, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      });
      const result = await cli.close(30_000);
      assert.equal(result.forced, false, cli.diagnostics());
      assert.equal(result.exit.code, 1, cli.diagnostics());
      assert.match(cli.diagnostics(), /KillerOS supports Windows only\./u);
    });
  }
});

test("installed Pi terminal accepts resized questions, cancels partial selections, and preserves editor navigation", { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-terminal-"));
  const env = isolatedFixtureEnvironment(directory);
  const agentDirectory = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const consumer = path.join(directory, "consumer");
  const pack = path.join(directory, "pack");
  const userConfig = path.join(directory, "empty.npmrc");
  const sessionFile = path.join(directory, "terminal.jsonl");
  const requests: string[] = [];
  const faults: string[] = [];
  let sourceRevision = "unavailable";
  let npmVersion = "unavailable";
  const piVersions = { ai: packageVersion("@earendil-works/pi-ai"), codingAgent: packageVersion("@earendil-works/pi-coding-agent"),
    tui: packageVersion("@earendil-works/pi-tui") };
  let packageIdentity = "unavailable";
  let cliPath = "unavailable";
  let cliArgs: string[] = [];
  const screens: Record<string, string> = {};
  const cleanup: string[] = [];
  let terminal: PiTerminalProcess | undefined;
  let capability: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576, "Terminal provider request exceeds 1 MiB");
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer killeros-terminal-key");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(isUnknownRecord(body) && isUnknownArray(body.messages));
      assert.equal(body.model, "local");
      const messages = body.messages.filter(isUnknownRecord);
      const last = messages.at(-1);
      assert.ok(last);
      const tools = isUnknownArray(body.tools) ? body.tools : [];
      assert.ok(tools.some((tool) => isUnknownRecord(tool) && isUnknownRecord(tool.function) && tool.function.name === "question"));
      const content = typeof last.content === "string" ? last.content : isUnknownArray(last.content)
        ? last.content.map((part) => { assert.ok(isUnknownRecord(part) && part.type === "text" && typeof part.text === "string"); return part.text; }).join("")
        : undefined;
      const step = requests.length;
      requests.push(JSON.stringify(last).slice(0, 4_000));
      let delta: Record<string, unknown>;
      let finishReason = "stop";
      if (step === 0 || step === 2) {
        assert.equal(last.role, "user");
        assert.equal(content, step === 0 ? "terminal single question" : "terminal cancel question");
        delta = { tool_calls: [{ index: 0, id: step === 0 ? "single" : "multiple", type: "function", function: {
          name: "question", arguments: JSON.stringify({ question: step === 0 ? "Resize question" : "Cancel partial question",
            options: [{ label: "First choice" }, { label: "Second choice" }],
            ...(step === 2 ? { mode: "multiple", minSelections: 1, maxSelections: 2 } : {}),
          }),
        } }] };
        finishReason = "tool_calls";
      } else if (step === 1) {
        assert.equal(last.role, "tool");
        assert.equal(last.tool_call_id, "single");
        assert.equal(content, "User selected: Second choice");
        delta = { content: Array.from({ length: 60 }, (_, i) => `Transcript marker ${String(i).padStart(2, "0")}`).join("\n") + "\nSingle interaction done" };
      } else if (step === 3) {
        assert.equal(last.role, "tool");
        assert.equal(last.tool_call_id, "multiple");
        assert.equal(content, "User cancelled the question");
        delta = { content: "Cancellation interaction done" };
      } else if (step === 4) {
        assert.equal(last.role, "user");
        assert.equal(content, "edited alpha\nbeta", "Fullscreen navigation must not move the editor cursor or alter the draft");
        delta = { content: "Editor interaction done" };
      } else throw new Error(`Unexpected terminal provider request ${step + 1}`);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `terminal-${step}`, model: "local", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Terminal fixture rejected model request"); }
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  try {
    for (const location of [agentDirectory, project, consumer, pack]) mkdirSync(location, { recursive: true });
    writeFileSync(userConfig, "");
    const git = initializeFixtureRepository(project, env);
    sourceRevision = execFileSync(git, ["-C", repositoryRoot, "rev-parse", "HEAD"], { env, encoding: "utf8", timeout: 10_000 }).trim();
    npmVersion = runNpm(["--version"], repositoryRoot, userConfig, env).trim();
    capability = new PiTerminalProcess({ file: process.execPath, args: ["-e", [
      "if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);",
      "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');",
      "process.stdout.on('resize', () => process.stdout.write('RESIZE:' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'));",
      "let input = '';",
      "process.stdin.on('data', data => { input += data; if (input.includes('PING')) { input = ''; const [cols, rows] = process.stdout.getWindowSize(); process.stdout.write('INPUT:' + cols + 'x' + rows + '\\r\\n'); process.exitCode = cols === 80 && rows === 24 ? 0 : 3; } if (data.includes('\\x04')) process.stdin.pause(); });",
      // Observe input while the probe is alive; native PTY exit can discard unread final bytes.
      "process.stdout.write('READY:100x30\\r\\n');",
    ].join("\n")], cwd: project, env });
    await capability.waitForScreen((screen) => screen.includes("READY:100x30"), { signal: t.signal });
    capability.resize(80, 24);
    await capability.waitForScreen((screen) => screen.includes("RESIZE:80x24"), { signal: t.signal });
    capability.write("PING");
    screens.capability = await capability.waitForScreen((screen) => screen.includes("INPUT:80x24"), { signal: t.signal });
    assert.deepEqual(await capability.close(), { code: 0, forced: false });
    cleanup.push("native capability exited normally");

    const npmEnv = { ...env, NPM_CONFIG_CACHE: path.join(directory, "npm-cache") };
    runNpm(["pack", "--ignore-scripts", "--pack-destination", pack], repositoryRoot, userConfig, npmEnv);
    const tarballs = readdirSync(pack).filter((name) => name.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save", "--legacy-peer-deps", path.join(pack, tarballs[0] ?? "")], consumer, userConfig, npmEnv);
    const installedPackage = path.join(consumer, "node_modules", "killeros");
    const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.ok(isUnknownRecord(manifest) && typeof manifest.version === "string");
    assertInstalledPackage(installedPackage, manifest.version);
    packageIdentity = `killeros@${manifest.version} (${installedPackage})`;
    assert.equal(existsSync(path.join(consumer, "node_modules", "@earendil-works")), false);
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const address = server.address(); if (address && typeof address !== "string") resolve(address.port); else reject(new Error("No terminal provider port")); });
    });
    writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(path.join(agentDirectory, "keybindings.json"), JSON.stringify({ "tui.altScreen.top": ["ctrl+home", "alt+t"] }));
    writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: { "killeros-terminal": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "killeros-terminal-key", models: [{ id: "local", name: "Terminal fixture", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    env.PATH = [path.dirname(git), path.dirname(process.execPath)].join(path.delimiter);
    cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    cliArgs = ["--model", "killeros-terminal/local", "--thinking", "off", "--tools", "question", "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions", "--extension", installedPackage];
    terminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...cliArgs], cwd: project, env: { ...env, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" } });
    screens.startup = await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("local killeros terminal"), { signal: t.signal });
    terminal.write("terminal single question\r");
    screens.singleBeforeResize = await terminal.waitForScreen((screen) => screen.includes("Resize question") && screen.includes("Second choice"), { signal: t.signal });
    const beforeResize = terminal.sequence;
    terminal.resize(80, 24);
    screens.singleAfterResize = await terminal.waitForScreen((screen) => screen.includes("Resize question") && screen.includes("Second choice"), { signal: t.signal, after: beforeResize });
    terminal.write("\x1b[B\r");
    await terminal.waitForScreen((screen) => screen.includes("Single interaction done"), { signal: t.signal });
    assert.deepEqual(faults, []);
    assert.equal(requests.length, 2);
    terminal.write("terminal cancel question\r");
    await terminal.waitForScreen((screen) => screen.includes("Cancel partial question") && screen.includes("Selected 0"), { signal: t.signal });
    terminal.write("\r");
    screens.partialSelection = await terminal.waitForScreen((screen) => screen.includes("Selected 1") && screen.includes("[x] First choice"), { signal: t.signal });
    terminal.write("\x1b");
    screens.cancelled = await terminal.waitForScreen((screen) => screen.includes("Cancellation interaction done") && !screen.includes("Selected 1"), { signal: t.signal });
    assert.deepEqual(faults, []);
    assert.equal(requests.length, 4);
    terminal.write("\x1b[200~alpha\nbeta\x1b[201~");
    await terminal.waitForScreen((screen) => screen.includes("alpha") && screen.includes("beta"), { signal: t.signal });
    terminal.write("\x1b[A\x01edited ");
    screens.editor = await terminal.waitForScreen((screen) => screen.includes("edited alpha") && screen.includes("beta"), { signal: t.signal });
    const beforeScroll = terminal.sequence;
    terminal.write("\x1b[5~");
    screens.pageUp = await terminal.waitForScreen((screen) => screen.includes("Jump to latest message") && screen.includes("edited alpha") && screen.includes("beta"), { signal: t.signal, after: beforeScroll });
    terminal.write("\x1bt");
    screens.customTop = await terminal.waitForScreen((screen) => screen.includes("terminal single question") && screen.includes("KillerOS")
      && screen.includes("Jump to latest message") && !screen.includes("Cancellation interaction done"), { signal: t.signal });
    terminal.write("\x1b[1;5F");
    screens.bottom = await terminal.waitForScreen((screen) => screen.includes("Cancellation interaction done") && screen.includes("edited alpha") && screen.includes("beta"), { signal: t.signal });
    terminal.write("\r");
    screens.submitted = await terminal.waitForScreen((screen) => screen.includes("Editor interaction done"), { signal: t.signal });
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    cleanup.push("installed Pi terminal exited normally");
    const savedEntries: unknown[] = readFileSync(sessionFile, "utf8").trim().split("\n").map((line): unknown => JSON.parse(line));
    const questionResults = savedEntries.flatMap((entry) => isUnknownRecord(entry) && isUnknownRecord(entry.message)
      && entry.message.role === "toolResult" && entry.message.toolName === "question" ? [entry.message] : []);
    assert.equal(questionResults.length, 2, "Exactly two native question executions must persist");
    assert.ok(isUnknownRecord(questionResults[0]?.details));
    assert.equal(questionResults[0].isError, false);
    assert.equal(questionResults[0].details.answer, "Second choice");
    assert.equal(questionResults[0].details.selectedIndex, 2);
    assert.ok(isUnknownRecord(questionResults[1]?.details));
    assert.equal(questionResults[1].isError, false);
    assert.equal(questionResults[1].details.cancelled, true);
    assert.deepEqual(questionResults[1].details.answers, []);
    assert.deepEqual(questionResults[1].details.selectedIndices, []);
  } catch (error) { failure = error; }
  finally {
    for (const child of [capability, terminal]) if (child) {
      try { const result = await child.close(); cleanup.push(JSON.stringify(result)); if (result.forced || result.code !== 0 || result.failure !== undefined) cleanupFailures.push(new Error(`Terminal cleanup was not orderly: ${JSON.stringify(result)}`)); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (server.listening) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await Promise.race([closed, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Terminal provider shutdown timeout")), 5_000); })]);
      } catch (error) { cleanupFailures.push(error); }
      finally { if (timer) clearTimeout(timer); }
    }
  }
  if (faults.length) cleanupFailures.push(new Error(faults.join("\n")));
  if (requests.length !== 5) cleanupFailures.push(new Error(`Expected five terminal requests, received ${requests.length}`));
  if (sockets.size !== 0) cleanupFailures.push(new Error("Terminal provider retained connections"));
  if (failure || cleanupFailures.length) {
    throwScenarioFailure({ directory, message: "Installed terminal pilot failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      diagnostics: JSON.stringify({ scenario: "installed-terminal-pilot", directory, sourceRevision, platform: process.platform, node: process.version, npm: npmVersion, piVersions, packageIdentity, cliPath, sanitizedCliArgs: cliArgs, requests, faults, screens, terminal: terminal?.diagnostics(), capability: capability?.diagnostics(), cleanup, session: existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").slice(-16_384) : "missing" }),
    });
  }
  t.diagnostic(JSON.stringify({ scenario: "installed-terminal-pilot", sourceRevision, platform: process.platform, node: process.version,
    npm: npmVersion, piVersions, packageIdentity, cliPath, sanitizedCliArgs: cliArgs, requestCount: requests.length, cleanup, navigationScreens: { editor: screens.editor, pageUp: screens.pageUp, customTop: screens.customTop, bottom: screens.bottom } }));
  await removeDirectoryEventually(directory);
});

test("installed Pi CLI completes a goal and restores it without unsolicited model work", {
  timeout: 120_000,
  skip: piRpcShutdownSkip,
}, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-installed-cli-"));
  const packDirectory = path.join(directory, "pack");
  const consumerDirectory = path.join(directory, "consumer");
  const projectDirectory = path.join(directory, "project");
  const agentDirectory = path.join(directory, "agent");
  const sessionFile = path.join(directory, "sessions", "goal.jsonl");
  const userConfig = path.join(directory, "empty.npmrc");
  const fixtureEnv = isolatedFixtureEnvironment(directory);
  const npmEnv = { ...fixtureEnv, NPM_CONFIG_CACHE: path.join(directory, "npm-cache") };
  const providerRequests: Array<{ purpose: string; model: string; tools: string[]; roles: string[] }> = [];
  const requestTrace: string[] = [];
  const unexpectedRequests: string[] = [];
  const expectedFaultRequests: string[] = [];
  const cleanupResults: string[] = [];
  let expectUnexpectedRequest = false;
  let holdNextRequest = false;
  let signalHeldRequest: (() => void) | undefined;
  const heldRequest = new Promise<void>((resolve) => { signalHeldRequest = resolve; });
  const providerSockets = new Set<Socket>();
  const providerIdleWaiters = new Set<() => void>();
  const objective = "Verify the installed CLI persists a model-issued goal decision";
  const evidence = "The local scripted provider issued the completion decision and the installed CLI persisted it.";
  const startedAt = Date.now();
  let sourceRevision = "unavailable";
  let npmVersion = "unavailable";
  let cliPath = "unavailable";
  let cliArgs: string[] = [];
  let packageIdentity = "unavailable";
  let piVersions: Record<string, string> = {};
  let startupFailureProcess: PiRpcProcess | undefined;
  let firstProcess: PiRpcProcess | undefined;
  let reopenedProcess: PiRpcProcess | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  let sessionFileContents = "<not created>";

  const sendModelStream = (response: ServerResponse, event: Record<string, unknown>): void => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
    response.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  };
  const providerServer = createServer((request, response) => {
    const tracePrefix = `${request.method ?? "UNKNOWN"} ${request.url ?? "<no path>"}`;
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const rawChunk of request) {
        const chunk: unknown = rawChunk;
        const bytes = typeof chunk === "string"
          ? Buffer.from(chunk)
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : undefined;
        if (!bytes) throw new Error("Local model request stream contained a non-byte chunk");
        size += bytes.length;
        if (size > 1_048_576) throw new Error("Local model request exceeded 1 MiB");
        chunks.push(bytes);
      }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error(`Unexpected local model endpoint: ${tracePrefix}`);
      }
      if (request.headers.authorization !== "Bearer killeros-local-test-key") {
        throw new Error("Local model request did not use the fixture credential");
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isUnknownRecord(body)) throw new Error("Local model request body was not an object");
      const messages = isUnknownArray(body.messages) ? body.messages.filter(isUnknownRecord) : [];
      const roles = messages.map((message) => typeof message.role === "string" ? message.role : "<missing>");
      const tools = isUnknownArray(body.tools)
        ? body.tools.flatMap((tool) => isUnknownRecord(tool) && isUnknownRecord(tool.function) && typeof tool.function.name === "string"
          ? [tool.function.name]
          : [])
        : [];
      const decisionResult = messages.find((message) => message.role === "tool" && message.tool_call_id === "call_killeros_goal_1");
      const purpose = providerRequests.length === 0
        ? "goal-decision"
        : holdNextRequest
          ? "held-cancellation-control"
          : expectUnexpectedRequest
            ? "unexpected-request-control"
            : decisionResult
              ? "goal-tool-result"
              : "unexpected-model-request";
      const model = typeof body.model === "string" ? body.model : "<missing>";
      providerRequests.push({ purpose, model, tools, roles });
      requestTrace.push(`${purpose}: model=${model}, tools=${tools.join(",") || "<none>"}, roles=${roles.join(",")}`);
      if (model !== "local") throw new Error(`Unexpected local model ID: ${model}`);
      if (holdNextRequest) {
        holdNextRequest = false;
        signalHeldRequest?.();
        return;
      }

      if (providerRequests.length === 1) {
        if (decisionResult) throw new Error("The first request already contained a goal tool result");
        if (!tools.includes("killeros_goal_update")) throw new Error("The first request omitted the active goal decision tool");
        if (!JSON.stringify(messages).includes(objective)) throw new Error("The first request omitted the public goal objective");
        sendModelStream(response, {
          id: "chatcmpl-killeros-goal-1",
          model,
          choices: [{
            index: 0,
            delta: { tool_calls: [{
              index: 0,
              id: "call_killeros_goal_1",
              type: "function",
              function: { name: "killeros_goal_update", arguments: JSON.stringify({ status: "complete", evidence }) },
            }] },
            finish_reason: "tool_calls",
          }],
        });
        return;
      }
      if (providerRequests.length === 2) {
        if (!decisionResult || !JSON.stringify(decisionResult).includes("Goal marked complete (model-reported)")) {
          throw new Error("The follow-up request did not contain the successful goal decision result");
        }
        sendModelStream(response, {
          id: "chatcmpl-killeros-goal-2",
          model,
          choices: [{
            index: 0,
            delta: { content: "The installed CLI saved the completed goal." },
            finish_reason: "stop",
          }],
        });
        return;
      }
      throw new Error(`Unexpected extra model request #${providerRequests.length}`);
    })().catch((error: unknown) => {
      const message = `${tracePrefix}: ${error instanceof Error ? error.message : String(error)}`;
      if (expectUnexpectedRequest) {
        expectUnexpectedRequest = false;
        expectedFaultRequests.push(message);
      } else {
        unexpectedRequests.push(message);
      }
      if (!response.destroyed) {
        response.writeHead(500, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ error: "Unexpected local model request" }));
      }
    });
  });
  providerServer.on("connection", (socket) => {
    providerSockets.add(socket);
    socket.once("close", () => {
      providerSockets.delete(socket);
      if (providerSockets.size === 0) {
        for (const resolve of providerIdleWaiters) resolve();
        providerIdleWaiters.clear();
      }
    });
  });
  providerServer.requestTimeout = 10_000;
  providerServer.headersTimeout = 5_000;
  const waitForProviderIdle = async (timeoutMs = 5_000): Promise<void> => {
    if (providerSockets.size === 0) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        clearTimeout(timer);
        providerIdleWaiters.delete(finish);
        resolve();
      };
      timer = setTimeout(() => {
        providerIdleWaiters.delete(finish);
        reject(new Error(`Local model provider retained ${providerSockets.size} connection(s) after the response`));
      }, timeoutMs);
      providerIdleWaiters.add(finish);
      if (providerSockets.size === 0) finish();
    });
  };
  const waitForHeldProviderRequest = async (timeoutMs = 5_000): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        heldRequest,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Local model provider did not receive the held-request control")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const closeModelServer = async (): Promise<void> => {
    if (!providerServer.listening) return;
    const closed = new Promise<void>((resolve, reject) => {
      providerServer.close((error) => error ? reject(error) : resolve());
    });
    providerServer.closeAllConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const didClose = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!didClose) throw new Error("Local model server did not close within five seconds");
  };

  const processDiagnostics = (): Record<string, unknown> => ({
    startupFailure: startupFailureProcess?.diagnostics(),
    first: firstProcess?.diagnostics(),
    reopened: reopenedProcess?.diagnostics(),
  });
  const failureDiagnostics = (): string => JSON.stringify({
    scenario: "installed-cli-goal-restoration",
    sourceRevision,
    platform: process.platform,
    node: process.version,
    npm: npmVersion,
    piVersions,
    packageIdentity,
    cliPath,
    sanitizedCliArgs: cliArgs,
    fixtureDirectory: directory,
    requestTrace,
    unexpectedRequests,
    expectedFaultRequests,
    sessionFile: existsSync(sessionFile) ? sessionFileContents.slice(-8_000) : sessionFileContents,
    processes: processDiagnostics(),
    cleanup: cleanupResults,
  }, null, 2).slice(-100_000);

  try {
    mkdirSync(packDirectory, { recursive: true });
    mkdirSync(consumerDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    mkdirSync(agentDirectory, { recursive: true });
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    writeFileSync(userConfig, "");
    npmVersion = runNpm(["--version"], directory, userConfig, npmEnv).trim();

    const providerAddress = await new Promise<{ address: string; port: number }>((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", () => {
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("Local model server did not bind a TCP address"));
          return;
        }
        resolve(address);
      });
    });

    runNpm(["pack", "--ignore-scripts", "--pack-destination", packDirectory], repositoryRoot, userConfig, npmEnv);
    const tarballs = readdirSync(packDirectory).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "npm pack must produce exactly one KillerOS archive");
    const tarball = path.join(packDirectory, tarballs[0] ?? "");
    writeFileSync(path.join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    runNpm([
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save", "--legacy-peer-deps",
      "--cache", path.join(directory, "npm-cache"), tarball,
    ], consumerDirectory, userConfig, npmEnv);

    const packageManifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.ok(isUnknownRecord(packageManifest) && typeof packageManifest.version === "string");
    const installedPackage = path.join(consumerDirectory, "node_modules", "killeros");
    assertInstalledPackage(installedPackage, packageManifest.version);
    packageIdentity = `killeros@${packageManifest.version} (${installedPackage})`;
    assert.equal(existsSync(path.join(consumerDirectory, "node_modules", "@earendil-works")), false,
      "The disposable consumer must not install a second Pi dependency tree");

    piVersions = {
      ai: packageVersion("@earendil-works/pi-ai"),
      codingAgent: packageVersion("@earendil-works/pi-coding-agent"),
      tui: packageVersion("@earendil-works/pi-tui"),
    };
    cliPath = path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    assert.equal(existsSync(cliPath), true, "The selected Pi CLI bundle must exist in the installed test dependency set");
    assert.equal(realpathSync.native(cliPath), cliPath, "The CLI must not resolve through a global shim or another install");

    const gitCommand = initializeFixtureRepository(projectDirectory, fixtureEnv);
    fixtureEnv.PATH = [...new Set([path.dirname(gitCommand), path.dirname(process.execPath)])].join(path.delimiter);
    sourceRevision = execFileSync(gitCommand, ["-C", repositoryRoot, "rev-parse", "HEAD"], {
      cwd: repositoryRoot, env: fixtureEnv, encoding: "utf8", timeout: 15_000,
    }).trim();
    writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "off",
    }));
    writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: {
      "killeros-local": {
        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        api: "openai-completions",
        apiKey: "killeros-local-test-key",
        models: [{
          id: "local",
          name: "KillerOS scripted local model",
          reasoning: false,
          input: ["text"],
          contextWindow: 32_000,
          maxTokens: 2_000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    } }));

    const piEnv: NodeJS.ProcessEnv = {
      ...fixtureEnv,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    cliArgs = [
      "--mode", "rpc",
      "--model", "killeros-local/local",
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
      "--extension", installedPackage,
    ];

    startupFailureProcess = new PiRpcProcess({
      cliPath: path.join(directory, "missing-pi-cli.js"),
      args: [],
      cwd: projectDirectory,
      env: piEnv,
    });
    const startupFailure = await startupFailureProcess.close();
    cleanupResults.push(`missing CLI control: code=${startupFailure.exit.code}, forced=${startupFailure.forced}`);
    assert.equal(startupFailure.forced, false, "A Pi startup failure must not require forced cleanup");
    assert.notEqual(startupFailure.exit.code, 0, "A missing CLI must fail instead of looking like a successful startup");
    assert.equal(startupFailure.exit.signal, null);
    const startupDiagnostics = startupFailureProcess.diagnostics();
    assert.ok(startupDiagnostics.length <= 32 * 1024, "Startup failure diagnostics must remain bounded");
    assert.match(startupDiagnostics, /missing-pi-cli\.js/u);

    firstProcess = new PiRpcProcess({ cliPath, args: cliArgs, cwd: projectDirectory, env: piEnv });
    const firstState = rpcData(await firstProcess.command("get_state", {}, { signal: t.signal }));
    assert.equal(firstState.isStreaming, false);
    assert.ok(isUnknownRecord(firstState.model));
    assert.equal(firstState.model.provider, "killeros-local");
    assert.equal(firstState.model.id, "local");
    assert.equal(path.resolve(String(firstState.sessionFile)), path.resolve(sessionFile));
    const commandResponse = await firstProcess.command("get_commands", {}, { signal: t.signal });
    const registeredCommands = rpcData(commandResponse).commands;
    assert.ok(isUnknownArray(registeredCommands));
    assert.ok(registeredCommands.some((command) => isUnknownRecord(command) && command.name === "goal" && command.source === "extension"),
      "The installed package must register its public /goal command");

    const goalRunSequence = firstProcess.currentSequence;
    const goalCommand = await firstProcess.command("prompt", { message: `/goal ${objective}` }, { signal: t.signal, timeoutMs: 30_000 });
    assert.equal(rpcData(goalCommand).disposition, "handled", "Pi must route /goal through its public command handler");
    await firstProcess.waitFor((record) => record.type === "agent_settled", {
      after: goalRunSequence,
      timeoutMs: 45_000,
      signal: t.signal,
    });
    assert.equal(providerRequests.length, 2, "The goal should require one decision request and one post-tool response");
    assert.deepEqual(unexpectedRequests, []);
    assert.deepEqual(providerRequests.map(({ purpose }) => purpose), ["goal-decision", "goal-tool-result"]);
    assert.ok(providerRequests[0]?.tools.includes("killeros_goal_update"));

    const messagesResponse = await firstProcess.command("get_messages", {}, { signal: t.signal });
    const messages = rpcData(messagesResponse).messages;
    assert.ok(isUnknownArray(messages));
    const decisionResult = messages.find((message) => isUnknownRecord(message) && message.role === "toolResult" && message.toolName === "killeros_goal_update");
    assert.ok(isUnknownRecord(decisionResult));
    assert.equal(decisionResult.isError, false);
    assert.ok(JSON.stringify(decisionResult.content).includes("Goal marked complete (model-reported)"));

    const getSavedGoal = async (rpc: PiRpcProcess): Promise<{ event: unknown; state: NonNullable<ReturnType<typeof parseGoalState>> }> => {
      const entriesResponse = await rpc.command("get_entries", {}, { signal: t.signal });
      const entries = rpcData(entriesResponse).entries;
      assert.ok(isUnknownArray(entries));
      const goalEntry = entries.filter((entry) => isUnknownRecord(entry)
        && entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
      assert.ok(isUnknownRecord(goalEntry) && isUnknownRecord(goalEntry.data));
      const state = parseGoalState(goalEntry.data.state);
      assert.ok(state);
      return { event: goalEntry.data.event, state };
    };
    const firstSavedGoal = await getSavedGoal(firstProcess);
    assert.equal(firstSavedGoal.event, "complete");
    assert.equal(firstSavedGoal.state.status, "complete");
    assert.equal(firstSavedGoal.state.objective, objective);
    assert.equal(firstSavedGoal.state.turns, 1);
    assert.equal(firstSavedGoal.state.lastDecision?.kind, "complete");

    await waitForProviderIdle();
    const firstClose = await firstProcess.close();
    cleanupResults.push(`initial CLI: code=${firstClose.exit.code}, signal=${firstClose.exit.signal}, forced=${firstClose.forced}`);
    assert.equal(firstClose.forced, false, "The first CLI process must exit orderly");
    assert.equal(firstClose.exit.code, 0);
    assert.equal(firstClose.exit.signal, null);

    reopenedProcess = new PiRpcProcess({ cliPath, args: cliArgs, cwd: projectDirectory, env: piEnv });
    const restoredState = rpcData(await reopenedProcess.command("get_state", {}, { signal: t.signal }));
    assert.equal(restoredState.isStreaming, false, "Restoring a completed session must not start a model run");
    assert.equal(path.resolve(String(restoredState.sessionFile)), path.resolve(sessionFile));
    const restoredGoal = await getSavedGoal(reopenedProcess);
    assert.equal(restoredGoal.event, "complete");
    assert.equal(restoredGoal.state.status, "complete");
    assert.equal(restoredGoal.state.objective, objective);
    assert.equal(providerRequests.length, 2, "Reopening and inspecting the saved state must not call the model");

    const statusSequence = reopenedProcess.currentSequence;
    const statusCommand = await reopenedProcess.command("prompt", { message: "/goal" }, { signal: t.signal });
    assert.equal(rpcData(statusCommand).disposition, "handled");
    const statusNotification = await reopenedProcess.waitFor((record) => record.type === "extension_ui_request"
      && record.method === "notify" && typeof record.message === "string" && record.message.includes(objective), {
      after: statusSequence,
      timeoutMs: 15_000,
      signal: t.signal,
    });
    assert.match(String(statusNotification.message), /Goal complete/u);
    assert.match(String(statusNotification.message), /Completion · model-reported/u);
    assert.match(String(statusNotification.message), new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.equal(providerRequests.length, 2, "The public status command must not issue model work");

    holdNextRequest = true;
    const cancellationSequence = reopenedProcess.currentSequence;
    const heldPrompt = await reopenedProcess.command("prompt", { message: "Exercise cancellation while the local provider is holding a response" }, {
      signal: t.signal,
      timeoutMs: 15_000,
    });
    assert.equal(rpcData(heldPrompt).disposition, "started");
    await waitForHeldProviderRequest();
    assert.equal(providerRequests.length, 3, "The held-work control must reach exactly one provider request");
    assert.deepEqual(unexpectedRequests, []);
    const abortResponse = await reopenedProcess.command("abort", {}, { signal: t.signal, timeoutMs: 15_000 });
    assert.equal(abortResponse.success, true, "Pi must accept the abort while provider work is held");
    const abortedRun = await reopenedProcess.waitFor((record) => record.type === "agent_end"
      && isUnknownArray(record.messages)
      && record.messages.some((message) => isUnknownRecord(message) && message.stopReason === "aborted"), {
      after: cancellationSequence,
      timeoutMs: 10_000,
      signal: t.signal,
    });
    assert.equal(abortedRun.type, "agent_end");
    await reopenedProcess.waitFor((record) => record.type === "agent_settled", {
      after: cancellationSequence,
      timeoutMs: 10_000,
      signal: t.signal,
    });
    assert.equal(rpcData(await reopenedProcess.command("get_state", {}, { signal: t.signal })).isStreaming, false);
    await waitForProviderIdle();
    assert.equal(providerRequests.length, 3, "Aborting held work must not cause a retry or follow-up request");

    expectUnexpectedRequest = true;
    const unexpectedSequence = reopenedProcess.currentSequence;
    const unexpectedPrompt = await reopenedProcess.command("prompt", { message: "Exercise the unexpected-provider-request control" }, {
      signal: t.signal,
      timeoutMs: 15_000,
    });
    assert.equal(rpcData(unexpectedPrompt).disposition, "started");
    const failedRun = await reopenedProcess.waitFor((record) => record.type === "agent_end"
      && isUnknownArray(record.messages)
      && record.messages.some((message) => isUnknownRecord(message) && message.stopReason === "error"), {
      after: unexpectedSequence,
      timeoutMs: 15_000,
      signal: t.signal,
    });
    const failedAssistant = isUnknownArray(failedRun.messages)
      ? failedRun.messages.find((message) => isUnknownRecord(message) && message.role === "assistant" && message.stopReason === "error")
      : undefined;
    assert.ok(isUnknownRecord(failedAssistant) && typeof failedAssistant.errorMessage === "string",
      "The deliberately unexpected model request must produce a visible provider error");
    await reopenedProcess.waitFor((record) => record.type === "agent_settled", {
      after: unexpectedSequence,
      timeoutMs: 10_000,
      signal: t.signal,
    });
    assert.equal(providerRequests.length, 4);
    assert.equal(expectedFaultRequests.length, 1);
    assert.match(expectedFaultRequests[0] ?? "", /Unexpected extra model request #4/u);
    assert.deepEqual(unexpectedRequests, []);
    const boundedDiagnostics = reopenedProcess.diagnostics();
    assert.ok(boundedDiagnostics.length <= 32 * 1024, "CLI diagnostics must remain within their character limit");

    let earlyAssertionFailure: unknown;
    let earlyCleanupFailure: unknown;
    let reopenedClose: Awaited<ReturnType<PiRpcProcess["close"]>> | undefined;
    try {
      assert.equal(providerRequests.length, 2, "intentional early assertion cleanup control");
    } catch (error) {
      earlyAssertionFailure = error;
    } finally {
      try {
        reopenedClose = await reopenedProcess.close();
        cleanupResults.push(`reopened CLI: code=${reopenedClose.exit.code}, signal=${reopenedClose.exit.signal}, forced=${reopenedClose.forced}`);
      } catch (error) {
        earlyCleanupFailure = error;
      }
    }
    assert.ok(earlyAssertionFailure instanceof Error && earlyAssertionFailure.message.includes("intentional early assertion cleanup control"),
      "The early assertion-failure control must preserve its primary failure");
    assert.equal(earlyCleanupFailure, undefined, "Cleanup must still complete after the controlled assertion failure");
    assert.ok(reopenedClose);
    assert.equal(reopenedClose.forced, false, "The reopened CLI process must exit orderly after the assertion control");
    assert.equal(reopenedClose.exit.code, 0);
    assert.equal(reopenedClose.exit.signal, null);
    assert.equal(providerRequests.length, 4, "No late model request may escape shutdown");
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const [label, process] of [["initial", firstProcess], ["reopened", reopenedProcess]] as const) {
      if (!process) continue;
      try {
        const result = await process.close();
        const outcome = `${label} cleanup: code=${result.exit.code}, signal=${result.exit.signal}, forced=${result.forced}`;
        cleanupResults.push(outcome);
        if (result.forced || result.exit.code !== 0 || result.exit.signal !== null || result.treeCleanupError) {
          cleanupFailures.push(new Error(`${outcome}${result.treeCleanupError ? `; ${result.treeCleanupError}` : ""}`));
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await closeModelServer();
      cleanupResults.push("local model server: closed");
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (existsSync(sessionFile)) sessionFileContents = readFileSync(sessionFile, "utf8");
  }

  if (unexpectedRequests.length > 0) cleanupFailures.push(new Error(`Unexpected local provider requests: ${unexpectedRequests.join("; ")}`));
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    const details = failureDiagnostics();
    throwScenarioFailure({ directory, message: "Installed CLI goal/persistence pilot failed",
      errors: [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures], diagnostics: details,
    });
  }

  await removeDirectoryEventually(directory);
  t.diagnostic(JSON.stringify({
    scenario: "installed-cli-goal-restoration",
    sourceRevision,
    platform: process.platform,
    node: process.version,
    npm: npmVersion,
    piVersions,
    packageIdentity,
    requests: providerRequests,
    expectedFaultRequests,
    orderlyExits: cleanupResults,
    durationMs: Date.now() - startedAt,
  }));
});

test("installed archive assertions reject missing files, incorrect identity, and non-Windows metadata", async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-package-assertions-"));
  try {
    for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), "fixture");
    }
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "killeros", version: "3.0.3", os: ["win32"] }));
    assertInstalledPackage(directory, "3.0.3");
    for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
      unlinkSync(path.join(directory, file));
      assert.throws(() => assertInstalledPackage(directory, "3.0.3"), { message: new RegExp(file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u") });
      writeFileSync(path.join(directory, file), "fixture");
    }
    for (const identity of [
      { name: "not-killeros", version: "3.0.3", os: ["win32"] },
      { name: "killeros", version: "3.0.2", os: ["win32"] },
      { name: "killeros", version: "3.0.3" },
      { name: "killeros", version: "3.0.3", os: ["linux"] },
      { name: "killeros", version: "3.0.3", os: ["win32", "linux"] },
    ]) {
      writeFileSync(path.join(directory, "package.json"), JSON.stringify(identity));
      assert.throws(() => assertInstalledPackage(directory, "3.0.3"));
    }
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("installed Pi print and JSON preserve trust and reject interactive workflows", { timeout: 60_000 }, async (t) => {
  for (const mode of ["print", "json"] as const) {
    for (const trusted of [true, false]) {
      await t.test(`${mode}/${trusted ? "trusted" : "untrusted"}`, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-noninteractive-"));
        const project = path.join(directory, "project"), agentDir = path.join(directory, "agent");
        mkdirSync(project); mkdirSync(agentDir);
        const session = path.join(directory, "session.jsonl");
        const probe = path.join(directory, "probe.ts");
        const personal = "KILLEROS_NONINTERACTIVE_PERSONAL";
        writeFileSync(path.join(project, "AGENTS.local.md"), personal);
        writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false },
          compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } }));
        writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
        writeFileSync(probe, `export default function(pi) { pi.on("session_before_compact", () => {
          pi.appendEntry("unexpected-noninteractive-compaction", {}); return {cancel:true};
        }); }`);
        let requests = 0;
        const faults: string[] = [];
        const server = createServer((request, response) => {
          void (async () => {
            assert.equal(request.method, "POST");
            assert.equal(request.url, "/v1/chat/completions");
            assert.equal(request.headers.authorization, "Bearer noninteractive-local-key");
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of request) {
              assert.ok(chunk instanceof Uint8Array); size += chunk.length; assert.ok(size <= 1_048_576); chunks.push(Buffer.from(chunk));
            }
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            assert.ok(isUnknownRecord(body) && isUnknownArray(body.messages) && isUnknownArray(body.tools));
            assert.equal(JSON.stringify(body.messages).split(personal).length - 1, trusted ? 1 : 0);
            const names = body.tools.map((tool) => { assert.ok(isUnknownRecord(tool) && isUnknownRecord(tool.function)); return tool.function.name; });
            assert.deepEqual(names, ["question"], "No goal tool may activate in print or JSON mode");
            const last = body.messages.at(-1); assert.ok(isUnknownRecord(last));
            const step = requests++;
            assert.ok(step < 2, "Noninteractive modes must not start compaction continuations");
            if (step === 0) assert.equal(last.role, "user");
            else {
              assert.equal(last.role, "tool");
              assert.match(JSON.stringify(last.content), /The question tool requires interactive TUI mode/u);
            }
            const delta = step === 0 ? { tool_calls: [{ index: 0, id: "noninteractive-question", type: "function", function: {
              name: "question", arguments: JSON.stringify({ question: "Choose", options: [{ label: "Alpha" }] }),
            } }] } : { content: "Noninteractive workflow verified" };
            response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
            response.end(`data: ${JSON.stringify({ id: `noninteractive-${step}`, model: "local", choices: [{ index: 0, delta,
              finish_reason: step === 0 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 2_000, completion_tokens: 20, total_tokens: 2_020 } })}\n\ndata: [DONE]\n\n`);
          })().catch((error: unknown) => {
            faults.push(error instanceof Error ? error.message : String(error));
            if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Rejected noninteractive fixture request"); }
          });
        });
        let failure: unknown;
        try {
          await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
          const address = server.address(); assert.ok(address && typeof address !== "string");
          writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "noninteractive-local": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "noninteractive-local-key",
            models: [{ id: "local", name: "Noninteractive local", reasoning: false, input: ["text"], contextWindow: 100_000,
              maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          } } }));
          const env = { ...isolatedFixtureEnvironment(directory), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
          initializeFixtureRepository(project, env);
          const args = ["--print", ...(mode === "json" ? ["--mode", "json"] : []), "--model", "noninteractive-local/local", "--thinking", "off",
            "--tools", "question,killeros_*", "--session", session, trusted ? "--approve" : "--no-approve", "--offline", "--no-context-files",
            "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot, "--extension", probe];
          const cli = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
          const options = { cwd: project, env, timeout: 15_000, maxBuffer: 1_048_576, signal: t.signal };
          const run = async (prompt: string) => {
            const invocation = promisify(execFile)(process.execPath, [cli, ...args, prompt], options);
            invocation.child.stdin?.end();
            return await invocation;
          };
          await run("/goal Unsupported noninteractive goal");
          assert.equal(requests, 0, "/goal must not start provider work in print or JSON mode");
          const result = await run("Verify noninteractive restrictions");
          assert.match(result.stdout, /Noninteractive workflow verified/u);
          assert.equal(requests, 2);
          assert.deepEqual(faults, []);
          const entries = readFileSync(session, "utf8").trim().split("\n").map((line) => { const value: unknown = JSON.parse(line); return value; });
          assert.equal(entries.some((entry) => isUnknownRecord(entry)
            && (entry.customType === "killeros-goal" || entry.customType === "unexpected-noninteractive-compaction")), false);
          if (mode === "json") {
            const events = result.stdout.trim().split("\n").map((line) => { const value: unknown = JSON.parse(line); return value; });
            assert.ok(events.some((event) => isUnknownRecord(event) && event.type === "agent_settled" && event.aborted === false));
          }
        } catch (error) { failure = error; }
        finally {
          server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); });
        }
        if (failure !== undefined) throwScenarioFailure({ directory, message: `Pi ${mode} with trust ${trusted} failed`, errors: [failure],
          diagnostics: JSON.stringify({ node: process.version, mode, trusted, requests, faults }) });
        await removeDirectoryEventually(directory);
      });
    }
  }
});

test("the packed KillerOS package activates and reloads through Pi's public lifecycle", async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-pi-lifecycle-"));
  try {
    const packDirectory = path.join(directory, "pack");
    const consumerDirectory = path.join(directory, "consumer");
    const userConfig = path.join(directory, "empty.npmrc");
    mkdirSync(packDirectory);
    mkdirSync(consumerDirectory);
    writeFileSync(userConfig, "");
    runNpm([
      "pack",
      "--pack-destination",
      packDirectory,
    ], repositoryRoot, userConfig);
    const tarballs = readdirSync(packDirectory).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const tarball = path.join(packDirectory, tarballs[0]);
    writeFileSync(path.join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    runNpm([
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--legacy-peer-deps",
      tarball,
    ], consumerDirectory, userConfig);
    const installedPackage = path.join(consumerDirectory, "node_modules", "killeros");
    const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.ok(isUnknownRecord(manifest));
    assert.ok(typeof manifest.version === "string");
    assertInstalledPackage(installedPackage, manifest.version);

    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const lifecycle: string[] = [];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [installedPackage],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
        pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    });
    const lifecycleErrors: string[] = [];
    try {
      await session.bindExtensions({
        mode: "json",
        shutdownHandler() {},
        onError(diagnostic) { lifecycleErrors.push(`${diagnostic.event}: ${diagnostic.error}`); },
      });
      const firstRunner = session.extensionRunner;
      const firstCommands = firstRunner.getRegisteredCommands().map(({ invocationName }) => invocationName);
      const oldContext = firstRunner.createContext();
      assert.equal(firstRunner.hasHandlers("session_start"), true);
      assert.equal(firstRunner.hasHandlers("session_shutdown"), true);
      assert.equal(firstCommands.includes("goal"), true);
      assert.equal(new Set(firstCommands).size, firstCommands.length);
      for (const name of ["question", "killeros_goal_update"]) {
        assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
        assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
        assert.equal(session.getCallableToolNames().includes(name), false);
      }

      await session.reload();

      const secondRunner = session.extensionRunner;
      const secondCommands = secondRunner.getRegisteredCommands().map(({ invocationName }) => invocationName);
      assert.notEqual(secondRunner, firstRunner);
      assert.throws(() => oldContext.mode, /stale/u);
      assert.deepEqual(secondCommands, firstCommands);
      assert.deepEqual(secondRunner.getCommandDiagnostics(), []);
      for (const name of ["question", "killeros_goal_update"]) {
        assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
        assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
        assert.equal(session.getCallableToolNames().includes(name), false);
      }
      assert.deepEqual(lifecycle, ["start:startup", "shutdown:reload", "start:reload"]);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      session.dispose();
    }
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("KillerOS initialization and reload preserve unset Pi display preferences", async (t) => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    await t.test(mode, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-display-preferences-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const settingsPath = path.join(agentDir, "settings.json");
        writeFileSync(settingsPath, "{}\n");
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const before = {
          tuiMode: settingsManager.getTuiMode(),
          quietStartup: settingsManager.getQuietStartup(),
        };
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager,
          additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
          modelRuntime: await ModelRuntime.create({
            authPath: path.join(agentDir, "auth.json"), modelsPath: null,
            modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
          }),
        }));
        const errors: string[] = [];
        const { ctx, captured } = createTuiContext();
        await session.bindExtensions({
          mode, uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        if (mode === "tui") {
          assert.equal(typeof captured.headerFactory, "function");
          assert.equal(typeof captured.editorFactory, "function");
          assert.equal(typeof captured.footerFactory, "function");
        }
        for (const stage of ["startup", "reload"] as const) {
          if (stage === "reload") await session.reload();
          await settingsManager.flush();
          assert.equal(settingsManager.getTuiMode(), before.tuiMode, stage);
          assert.equal(settingsManager.getQuietStartup(), before.quietStartup, stage);
          assert.equal(settingsManager.getGlobalSettings().tuiMode, undefined, stage);
          assert.equal(settingsManager.getGlobalSettings().quietStartup, undefined, stage);
          assert.equal(readFileSync(settingsPath, "utf8"), "{}\n", stage);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(settingsManager.drainErrors(), []);
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real native OpenAI transport preserves thinking-level sampling with priority and provider retries", { timeout: 30_000 }, async (t) => {
  for (const [label, apiKey, status, expectedRequests] of [
    ["API-key rejection", "sk-local-test-key", 400, 1],
    ["ChatGPT subscription rejection", "local-test-chatgpt-token", 400, 1],
    ["Pi provider retry", "sk-local-test-key", 429, 2],
  ] as const) {
    await t.test(label, async () => {
      resetCodexFastState();
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-openai-fast-"));
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const bodies: Record<string, unknown>[] = [];
        const fakeFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          assert.equal(request.url, "https://api.openai.com/v1/responses");
          assert.equal(request.method, "POST");
          assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
          const body: unknown = await request.json();
          assert.ok(isUnknownRecord(body));
          bodies.push(body);
          return new Response(JSON.stringify({ error: {
            message: "Priority is not available for this test account", type: "invalid_request_error", code: "priority_rejected",
          } }), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
        };
        const native: Provider = openaiProvider();
        const model = native.getModels().find((model) => model.id === "gpt-6.1-sol");
        assert.ok(model);
        assert.equal(model.provider, "openai");
        assert.equal(model.api, "openai-responses");
        assert.equal(model.baseUrl, "https://api.openai.com/v1");
        if (!apiKey.startsWith("sk-")) {
          writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ openai: {
            type: "oauth", access: apiKey, refresh: "local-test-refresh-token", expires: Date.now() + 3_600_000,
            clientId: "local-test-client", scopes: ["chatgpt.tokens.use.direct"],
          } }));
        }
        const modelsPath = path.join(agentDir, "models.json");
        writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { modelOverrides: {
          [model.id]: {
            samplingParams: { temperature: 1, top_p: 0.95 },
            samplingParamsByThinkingLevel: {
              high: { temperature: 0.6 },
              low: { temperature: 0.2, top_p: 0.8 },
            },
          },
        } } } }));
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider({
          ...native,
          // Keep Pi's native Responses implementation and replace only its HTTP transport.
          streamSimple: (model, context, options) => native.streamSimple(model, context, {
            ...options, fetch: fakeFetch, maxRetries: 1,
          }),
        });
        if (apiKey.startsWith("sk-")) await modelRuntime.setRuntimeApiKey("openai", apiKey);
        assert.equal(modelRuntime.isUsingSubscription("openai"), !apiKey.startsWith("sk-"));
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
          noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [registerCodexFastMode],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const configuredModel = modelRuntime.getModel("openai", model.id);
        assert.ok(configuredModel);
        const { session } = await createAgentSession({
          cwd, agentDir, model: configuredModel, modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), noTools: "all",
        });
        const errors: string[] = [];
        try {
          await session.bindExtensions({ mode: "json", onError(error) { errors.push(`${error.event}: ${error.error}`); } });
          await session.prompt("/codex-fast");
          assert.equal(isCodexFastEnabled(), true);
          await session.reload();
          assert.equal(isCodexFastEnabled(), true);
          assert.equal(modelRuntime.isUsingSubscription("openai"), !apiKey.startsWith("sk-"));
          for (const [thinkingLevel, temperature, topP] of [["high", 0.6, 0.95], ["low", 0.2, 0.8]] as const) {
            session.setThinkingLevel(thinkingLevel);
            assert.equal(session.thinkingLevel, thinkingLevel);
            const firstRequest = bodies.length;
            await session.prompt("Test priority rejection locally");
            await session.waitForIdle();

            // HTTP 400 is not retryable. HTTP 429 gets exactly one configured Pi provider retry.
            const requests = bodies.slice(firstRequest);
            assert.equal(requests.length, expectedRequests);
            for (const body of requests) {
              assert.equal(body.model, model.id);
              assert.equal(body.service_tier, "priority");
              assert.equal(body.temperature, temperature);
              assert.equal(body.top_p, topP);
              assert.ok(Array.isArray(body.input));
            }
            const response = session.messages.filter((message) => message.role === "assistant").at(-1);
            assert.ok(response?.role === "assistant");
            assert.equal(response.stopReason, "error");
            assert.match(response.errorMessage ?? "", /Priority is not available for this test account/u);
          }
          assert.deepEqual(errors, []);
        } finally {
          session.dispose();
        }
      } finally {
        resetCodexFastState();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi Azure Responses and Foundry requests survive reload without OpenAI priority", { timeout: 30_000 }, async (t) => {
  for (const [id, api, endpoint] of [
    ["gpt-6.1-sol", "azure-openai-responses", "responses"],
    ["deepseek-v4-pro", "openai-completions", "chat/completions"],
  ] as const) {
    await t.test(api, async () => {
      resetCodexFastState();
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-azure-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const modelsPath = path.join(agentDir, "models.json");
        writeFileSync(modelsPath, JSON.stringify({ providers: { azure: { modelOverrides: {
          [id]: { samplingParams: { top_p: 0.8 }, samplingParamsByThinkingLevel: { high: { temperature: 0.6 } } },
        } } } }));
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        const native = modelRuntime.getProvider("azure");
        assert.ok(native, "Pi must expose the renamed Azure provider");
        const model = modelRuntime.getModel("azure", id);
        assert.ok(model, `Azure must expose ${id}`);
        assert.equal(model.api, api);
        const bodies: Record<string, unknown>[] = [];
        const fakeFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, "https://killeros-test.ai.azure.com");
          assert.ok(url.pathname.endsWith(`/${endpoint}`), url.pathname);
          assert.equal(request.method, "POST");
          const body: unknown = await request.json();
          assert.ok(isUnknownRecord(body));
          bodies.push(body);
          return new Response(JSON.stringify({ error: { message: "Local Azure test rejection" } }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        };
        modelRuntime.registerNativeProvider({
          ...native,
          streamSimple: (model, context, options) => native.streamSimple(model, context, {
            ...options, fetch: fakeFetch, maxRetries: 0,
            env: { ...options?.env, AZURE_OPENAI_BASE_URL: "https://killeros-test.ai.azure.com",
              AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${id}=local-deployment` },
          }),
        });
        await modelRuntime.setRuntimeApiKey("azure", "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
          noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerCodexFastMode(pi);
            registerFooter(pi, createGoalRuntime());
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), noTools: "all",
        }));
        const errors: string[] = [];
        const { ctx, captured, tui } = createTuiContext();
        await session.bindExtensions({
          mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        await session.prompt("/codex-fast");
        assert.equal(isCodexFastEnabled(), true);
        for (const stage of ["startup", "reload"] as const) {
          if (stage === "reload") await session.reload();
          assert.equal(session.model?.provider, "azure", stage);
          assert.equal(session.model?.id, id, stage);
          assert.equal(isCodexFastEnabled(), true, stage);
          const footer = captured.footerFactory(tui, theme, {
            getGitBranch: () => undefined, onBranchChange: () => () => {},
          });
          try {
            assert.ok((footer.render(160)[1] ?? "").includes(`${id} azure`));
            assert.doesNotMatch(footer.render(160)[1] ?? "", /\bfast\b/u);
          } finally {
            footer.dispose?.();
          }
          session.setThinkingLevel("high");
          const firstRequest = bodies.length;
          await session.prompt(`Test Azure locally at ${stage}`);
          await session.waitForIdle();
          assert.equal(bodies.length, firstRequest + 1, stage);
          const body = bodies[firstRequest];
          assert.ok(body, stage);
          assert.equal(body.model, "local-deployment", stage);
          assert.equal(body.service_tier, undefined, stage);
          assert.equal(body.temperature, 0.6, stage);
          assert.equal(body.top_p, 0.8, stage);
          const response = session.messages.at(-1);
          assert.ok(response?.role === "assistant", stage);
          assert.equal(response.provider, "azure", stage);
          assert.equal(response.api, api, stage);
          assert.equal(response.model, id, stage);
          assert.equal(response.stopReason, "error", stage);
          assert.match(response.errorMessage ?? "", /Local Azure test rejection/u, stage);
          assert.deepEqual(errors, [], stage);
        }
        assert.equal(bodies.length, 2, "startup and reload must each send one Azure request");
      } finally {
        session?.dispose();
        resetCodexFastState();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi retries preserve active turns and blocked completion permission until settlement", { timeout: 60_000 }, async (t) => {
  for (const [goalStatus, errorMessage] of [
    ["active", "Selected model is at capacity"], ["active", "The pending stream has been canceled"],
    ["blocked", "Selected model is at capacity"], ["blocked", "The pending stream has been canceled"],
    ["active", "server_busy"], ["blocked", "server_busy"],
    ["active", "servers are currently busy"], ["blocked", "servers are currently busy"],
    ["active", "mistral finish_reason:error"], ["blocked", "mistral finish_reason:error"],
  ] as const) {
    await t.test(`${goalStatus}/${errorMessage}`, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-provider-retry-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const runtime = createGoalRuntime();
        const faux = fauxProvider({ provider: "killeros-provider-retry", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        const mistral: Provider | undefined = errorMessage === "mistral finish_reason:error" ? mistralProvider() : undefined;
        const model = mistral?.getModels().find((candidate) => candidate.id === "mistral-small-latest") ?? faux.getModel();
        let transportRequests = 0;
        const fakeFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          assert.equal(request.url, "https://api.mistral.ai/v1/chat/completions");
          const body: unknown = await request.json();
          assert.ok(isUnknownRecord(body));
          if (transportRequests < 2) {
            assert.ok(Array.isArray(body.tools));
            assert.equal(JSON.stringify(body.tools).includes("killeros_goal_update"), true);
          }
          assert.equal(receipts().length, 0);
          assert.equal(bells, 0);
          transportRequests += 1;
          const delta = transportRequests === 2
            ? { tool_calls: [{ index: 0, id: "abcdefghi", type: "function", function: {
              name: "killeros_goal_update", arguments: JSON.stringify({ status: "complete", evidence: "Recovered and verified" }),
            } }] }
            : { content: transportRequests === 1 ? "" : "Goal finished after recovery" };
          const finish = transportRequests === 1 ? "error" : transportRequests === 2 ? "tool_calls" : "stop";
          return new Response(`data: ${JSON.stringify({ id: "local", model: model.id, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        };
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath: null,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider(mistral ? {
          ...mistral, streamSimple: (model, context, options) => mistral.streamSimple(model, context, { ...options, fetch: fakeFetch }),
        } : faux.provider);
        await modelRuntime.setRuntimeApiKey(model.provider, "local-test-key");
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false }, cacheWarming: "off",
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
        });
        settingsManager.setProjectTrusted(true);
        let bells = 0;
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerGoalInterface(pi, runtime);
            registerGoalRuntime(pi, runtime);
            registerWorkedFor(pi, Date.now, async () => ({
              finish: async () => ({ state: "unavailable", reason: "not-git" }),
              dispose: async () => undefined,
            }));
            registerGoalSettlement(pi, runtime);
            registerRequestActivity(pi);
            registerCompletionNotifications(pi, {
              store: { load: () => true, save() {} }, ring: () => { bells += 1; },
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")), noTools: "builtin",
        }));
        const host = session;
        if (goalStatus === "blocked") {
          host.sessionManager.appendCustomEntry("killeros-goal", {
            version: 1, event: "blocked", state: transitionGoalState({
              ...createNewGoalState("Verify provider retry recovery", 0, undefined, Date.now(), { maxTurns: 20 }), turns: 1,
            }, "blocked", "External prerequisite", {}, Date.now()),
          });
        }
        const receipts = () => host.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for");
        const errors: string[] = [];
        const { ctx, captured } = createTuiContext();
        await host.bindExtensions({
          mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        const retries: Array<{ status: string | undefined; turns: number | undefined; maxTurns: number | undefined; receipts: number; bells: number; working: boolean }> = [];
        let recovered = false;
        let settlements = 0;
        let normalizedError: string | undefined;
        faux.setResponses([
          fauxAssistantMessage("", { stopReason: "error", errorMessage }),
          fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Recovered and verified" })),
          fauxAssistantMessage("Goal finished after recovery"),
        ].map((message) => () => {
          assert.equal(receipts().length, 0, "provider follow-ups must not persist receipts before settlement");
          assert.equal(bells, 0, "provider follow-ups must not ring before settlement");
          assert.equal(settlements, 0);
          assert.notEqual(captured.workingMessages.at(-1), undefined);
          return message;
        }));
        let resolveSettled: (() => void) | undefined;
        const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
        const unsubscribe = host.subscribe((event) => {
          if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") normalizedError = event.message.errorMessage;
          if (event.type === "auto_retry_start") retries.push({
            status: runtime.state?.status, turns: runtime.state?.turns, maxTurns: runtime.state?.maxTurns,
            receipts: receipts().length, bells, working: captured.workingMessages.at(-1) !== undefined,
          });
          if (event.type === "auto_retry_end") recovered = event.success;
          if (event.type === "agent_settled") { settlements += 1; resolveSettled?.(); }
        });
        try {
          await host.prompt(goalStatus === "active" ? "/goal Verify provider retry recovery" : "The prerequisite is resolved. Verify and complete the original goal.");
          await settled;
          await host.waitForIdle();
          assert.deepEqual(retries, [{ status: goalStatus, turns: 1, maxTurns: 20, receipts: 0, bells: 0, working: true }]);
          assert.equal(recovered, true);
          assert.equal(mistral ? transportRequests : faux.state.callCount, 3);
          if (mistral) assert.equal(normalizedError, "Provider stopped with: error (server error)");
          assert.equal(runtime.state?.status, "complete");
          assert.equal(runtime.state?.turns, 1);
          assert.equal(runtime.state?.maxTurns, 20);
          assert.equal(settlements, 1);
          const receipt = receipts();
          assert.equal(receipt.length, 1);
          assert.ok(receipt[0]?.type === "custom" && isUnknownRecord(receipt[0].data));
          assert.equal(receipt[0].data.outcome, "done");
          assert.equal(bells, 1);
          assert.equal(captured.workingMessages.at(-1), undefined);
          assert.equal(host.pendingMessageCount, 0);
          assert.equal(runtime.continuationScheduled, false);
          assert.equal(runtime.goalTurnInFlight, false);
          assert.equal(runtime.blockedCompletion, undefined);
          assert.deepEqual(errors, []);
        } finally {
          unsubscribe();
        }
      } finally {
        session?.dispose();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi keeps KillerOS decisions declared and rejects nested calls with every codemode setting", { timeout: 6 * 60_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const codemode of ["disabled", "on", "only"] as const) {
      await t.test(`${mode}/${codemode}`, { timeout: 60_000 }, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-exposure-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        try {
          const cwd = path.join(directory, "project");
          const agentDir = path.join(directory, "agent");
          mkdirSync(cwd);
          mkdirSync(agentDir);
          process.env.PI_CODING_AGENT_DIR = agentDir;
          initializeFixtureRepository(cwd);
          const provider = `killeros-exposure-${mode}-${codemode}`;
          const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
          const declarations: string[][] = [];
          const prompts: string[] = [];
          const requestInstructions: string[] = [];
          const hiddenGuideline = "KILLEROS_HIDDEN_TOOL_GUIDELINE_104";
          const questionGuideline = "Use question only when user input is required to choose between concrete alternatives";
          const setResponses = (messages: AssistantMessage[]): void => {
            faux.setResponses(messages.map((message) => (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              prompts.push(getCurrentSystemPrompt(context.messages));
              requestInstructions.push(context.messages.map((entry) => typeof entry.content === "string" ? entry.content
                : entry.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n"));
              return message;
            }));
          };
          const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
          modelRuntime.registerNativeProvider(faux.provider);
          await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
          const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
          const sessionManager = SessionManager.create(cwd, path.join(directory, "sessions"));
          const goalEntries = () => sessionManager.getEntries()
            .filter((entry) => entry.type === "custom")
            .filter((entry) => entry.customType === "killeros-goal");
          let opened = 0;
          let probes = 0;
          const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              ...(codemode === "disabled" ? [] : [createCodemodeExtension({ mode: codemode })]),
              (pi) => {
                pi.registerTool({
                  name: "exposure_probe", label: "Exposure probe", description: "Check nested tool exclusion",
                  parameters: Type.Object({}), exposure: "model-only", executionMode: "sequential",
                  async execute(_id, _params, _signal, _update, ctx) {
                    probes++;
                    const before = structuredClone(goalEntries());
                    const openedBefore = opened;
                    for (const [name, args] of [
                      ["question", { question: "Choose", options: [{ label: "Alpha" }] }],
                      ["killeros_goal_update", { status: "continue", evidence: "Nested progress", nextAction: "Inspect result" }],
                    ] as const) {
                      assert.equal(ctx.tools.some((tool) => tool.name === name), false);
                      const outcome = await ctx.executeTool(name, args);
                      assert.equal(outcome.isError, true);
                      assert.deepEqual(outcome.result.content, [{ type: "text", text: `Tool ${name} not found` }]);
                    }
                    assert.equal(opened, openedBefore, "nested questions must not open UI");
                    assert.deepEqual(goalEntries(), before, "nested decisions must not persist goal entries");
                    return { content: [{ type: "text", text: "Nested calls rejected" }], details: undefined };
                  },
                });
                pi.registerTool({
                  name: "unrelated", label: "Unrelated", description: "An ordinary direct tool",
                  promptGuidelines: [hiddenGuideline],
                  parameters: Type.Object({}),
                  async execute() { return { content: [{ type: "text", text: "Unchanged" }], details: undefined }; },
                });
              },
            ],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          const { session } = await createAgentSession({
            cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager,
            resourceLoader: loader, tools: ["question", "killeros_*", "exposure_probe", "unrelated", "write", "read", ...(codemode === "disabled" ? [] : ["codemode"])],
          });
          const errors: string[] = [];
          const { ctx } = createTuiContext();
          const ui = extensionContextTestAdapter({ ui: {
            ...ctx.ui,
            async select(_title: string, options: string[]) {
              opened++;
              return options[0];
            },
          } }).ui;
          const assertDeclarations = (start: number, activeGoal: boolean, end = declarations.length): void => {
            const requests = declarations.slice(start, end);
            assert.ok(requests.length > 0, "the provider must receive a request");
            for (const [index, names] of requests.entries()) {
              const prompt = prompts[start + index];
              assert.ok(prompt);
              assert.ok(prompt.includes(questionGuideline), "declared question rules must reach the provider");
              assert.equal(prompt.includes(hiddenGuideline), codemode !== "only", "hidden tool rules must not reach the system prompt");
              assert.equal(names.includes("question"), true, `question missing from ${names.join(", ")}`);
              assert.equal(names.includes("killeros_goal_update"), activeGoal);
              assert.equal(names.includes("exposure_probe"), true);
              assert.equal(names.includes("codemode"), codemode !== "disabled");
              assert.equal(names.includes("unrelated"), codemode !== "only", "codemode-only must actually hide direct tools");
            }
          };
          const runToSettlement = async (start: () => Promise<unknown>, finalText: string): Promise<void> => {
            let finish: (() => void) | undefined;
            const finished = new Promise<void>((resolve) => { finish = resolve; });
            const unsubscribe = session.subscribe((event) => {
              const final = session.messages.filter((message) => message.role === "assistant").at(-1);
              if (event.type === "agent_settled" && final?.role === "assistant"
                && final.content.some((part) => part.type === "text" && part.text === finalText)) finish?.();
            });
            try {
              await start();
              await finished;
              await session.waitForIdle();
              await new Promise<void>((resolve) => setImmediate(resolve));
            } finally {
              unsubscribe();
            }
          };
          const runGoal = async (start: () => Promise<unknown>): Promise<void> => {
            const firstRequest = declarations.length;
            const firstMessage = session.messages.length;
            const openedBefore = opened;
            const probesBefore = probes;
            setResponses([
              fauxAssistantMessage(fauxToolCall("exposure_probe", {}, { id: `probe-${probes}` })),
              fauxAssistantMessage(fauxToolCall("question", { question: "Choose", options: [{ label: "Alpha" }] })),
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Direct completion verified" })),
              fauxAssistantMessage("exposure turn finished"),
            ]);
            await runToSettlement(start, "exposure turn finished");
            assert.equal(probes, probesBefore + 1);
            assert.equal(declarations.length - firstRequest, 4);
            assert.match(requestInstructions[firstRequest], /Before ending this turn, choose exactly one accepted goal decision/u);
            assert.match(requestInstructions[firstRequest], /call killeros_goal_update with status complete/u);
            assertDeclarations(firstRequest, true, firstRequest + 3);
            assertDeclarations(firstRequest + 3, false);
            const results = session.messages.slice(firstMessage).filter((message) => message.role === "toolResult");
            const probe = results.find((result) => result.toolName === "exposure_probe");
            assert.ok(probe);
            assert.equal(probe.isError, false, JSON.stringify(probe.content));
            const question = results.find((result) => result.toolName === "question");
            assert.ok(question);
            assert.equal(opened - openedBefore, mode === "tui" ? 1 : 0);
            assert.equal(question.isError, mode !== "tui");
            assert.deepEqual(question.content, [{ type: "text", text: mode === "tui"
              ? "User selected: Alpha" : "The question tool requires interactive TUI mode" }]);
            if (mode === "tui") assert.deepEqual(question.details, {
              question: "Choose", options: ["Alpha"], answer: "Alpha", selectedIndex: 1, wasCustom: false,
            });
            const completion = results.find((result) => result.toolName === "killeros_goal_update");
            assert.ok(completion);
            assert.equal(completion.isError, false, JSON.stringify(completion.content));
            const saved = goalEntries().at(-1)?.data;
            assert.ok(isUnknownRecord(saved));
            assert.equal(parseGoalState(saved.state)?.status, "complete");
            assert.equal(session.getCallableToolNames().includes("question"), false);
            assert.equal(session.getCallableToolNames().includes("killeros_goal_update"), false);
          };
          try {
            await session.bindExtensions({ mode, uiContext: ui, onError(error) { errors.push(`${error.event}: ${error.error}`); } });
            for (const name of ["question", "killeros_goal_update"]) {
              assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
              assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
            }
            assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false, "wildcard selection must not activate an idle goal tool");
            const unrelatedActive = session.getActiveToolNames();
            setResponses([fauxAssistantMessage("No goal")]);
            await session.prompt("Inspect the declarations without a goal");
            assertDeclarations(0, false);
            assert.doesNotMatch(prompts[0], /Active KillerOS goal/u);

            await runGoal(() => session.prompt("/goal Verify native tool exposure"));

            // Reach blocked through real decisions, reload it, then finish the original file in ordinary work.
            setResponses([1, 2, 3].flatMap((turn) => [
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
                status: "blocked", blockerKey: "external", evidence: `External prerequisite still missing ${turn}`,
              })),
              fauxAssistantMessage(`Blocker turn ${turn} finished`),
            ]));
            await runToSettlement(
              () => session.prompt("/goal Write the Markdown file to `report.md` and verify its contents"),
              "Blocker turn 3 finished",
            );
            const blockedEntry = goalEntries().at(-1)?.data;
            assert.ok(isUnknownRecord(blockedEntry));
            const blocked = parseGoalState(blockedEntry.state);
            assert.ok(blocked?.status === "blocked");
            assert.equal(blocked.turns, 3);
            assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false);
            const requestsBeforeReload = declarations.length;
            await session.reload();
            await session.waitForIdle();
            assert.equal(declarations.length, requestsBeforeReload, "restoring blocked must not start work");
            const firstBlockedRequest = declarations.length;
            const firstBlockedMessage = session.messages.length;
            const work = codemode === "only"
              ? [fauxAssistantMessage(fauxToolCall("codemode", {
                code: 'await tools.write({path: "report.md", content: "Verified report\\n"}); text(await tools.read({path: "report.md"}));',
              }))]
              : [
                fauxAssistantMessage(fauxToolCall("write", { path: "report.md", content: "Verified report\n" })),
                fauxAssistantMessage(fauxToolCall("read", { path: "report.md" })),
              ];
            setResponses([
              fauxAssistantMessage(fauxToolCall("exposure_probe", {})),
              ...work,
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
                status: "complete", evidence: "Read the report and audited the whole original objective",
              })),
              fauxAssistantMessage("Blocked goal completed without resumption"),
            ]);
            await runToSettlement(
              () => session.prompt("The prerequisite is resolved. Finish and verify the original report."),
              "Blocked goal completed without resumption",
            );
            assert.ok(declarations.length > firstBlockedRequest + 1, JSON.stringify({ errors, messages: session.messages.slice(firstBlockedMessage) }));
            assertDeclarations(firstBlockedRequest, true, declarations.length - 1);
            assertDeclarations(declarations.length - 1, false);
            assert.match(requestInstructions[firstBlockedRequest], /Status: blocked/u);
            assert.ok(requestInstructions[firstBlockedRequest].includes(blocked.objective));
            assert.equal(readFileSync(path.join(cwd, "report.md"), "utf8"), "Verified report\n");
            const laterResults = session.messages.slice(firstBlockedMessage).filter((message) => message.role === "toolResult");
            assert.ok(laterResults.length >= 3);
            for (const result of laterResults) assert.equal(result.isError, false, JSON.stringify(result.content));
            const completeEntry = goalEntries().at(-1)?.data;
            assert.ok(isUnknownRecord(completeEntry));
            assert.equal(completeEntry.event, "complete");
            const completed = parseGoalState(completeEntry.state);
            assert.ok(completed?.status === "complete");
            assert.equal(completed.lastDecision?.kind, "complete");
            for (const key of ["objective", "createdAt", "verification", "baselineTokens", "turns", "maxTurns", "activeMilliseconds"] as const) {
              assert.deepEqual(completed[key], blocked[key], key);
            }
            assert.equal(session.pendingMessageCount, 0);
            const requestsAfterCompletion = declarations.length;
            await session.reload();
            await session.waitForIdle();
            assert.equal(declarations.length, requestsAfterCompletion);
            assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false);

            for (const status of ["paused", "blocked", "complete", "cleared"] as const) {
              const state = createNewGoalState("Restore the saved goal", 0, undefined, Date.now());
              sessionManager.appendCustomEntry("killeros-goal", {
                version: 1, event: status === "cleared" ? "clear" : status === "paused" ? "pause" : status,
                state: status === "cleared" ? null : transitionGoalState(state, status, "Saved result", {}, Date.now()),
              });
              await session.reload();
              assert.deepEqual(session.getActiveToolNames(), unrelatedActive, `${status} must not change unrelated tools`);
              const firstRequest = declarations.length;
              setResponses([fauxAssistantMessage(`Goal ${status}`)]);
              await runToSettlement(() => session.prompt(`Inspect ${status} goal declarations`), `Goal ${status}`);
              assertDeclarations(firstRequest, status === "blocked");
              if (status === "paused") await runGoal(() => session.prompt("/goal resume"));
            }
            sessionManager.appendCustomEntry("killeros-goal", {
              version: 1, event: "set", state: createNewGoalState("Restore active work", 0, undefined, Date.now()),
            });
            await runGoal(() => session.reload());
            assert.deepEqual(errors, []);
          } finally {
            try {
              await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
              assert.deepEqual(errors, [], "Extension shutdown must not report errors");
            } finally {
              session.dispose();
            }
          }
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          await removeDirectoryEventually(directory);
        }
      });
    }
  }
});

test("real Pi exclusions cannot be bypassed by KillerOS goal activation or codemode", { timeout: 60_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const excluded of ["killeros_*", "killeros_goal_update", "question", "allowlist"]) {
      await t.test(`${mode}/${excluded}`, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-tool-exclusion-"));
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
          mkdirSync(cwd); mkdirSync(agentDir);
          const runtime = createGoalRuntime();
          const faux = fauxProvider({ provider: "killeros-tool-exclusion", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
          const declarations: string[][] = [];
          faux.setResponses([
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage(fauxToolCall("codemode", {
                code: 'for (const name of ["question", "killeros_goal_update"]) { try { await tools[name]({}); text("Unexpected call: " + name); } catch (error) { text(error.message); } }',
              }));
            },
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage("Exclusions verified");
            },
          ]);
          const modelRuntime = await ModelRuntime.create({
            authPath: path.join(agentDir, "auth.json"), modelsPath: null,
            modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
          });
          modelRuntime.registerNativeProvider(faux.provider);
          await modelRuntime.setRuntimeApiKey("killeros-tool-exclusion", "local-test-key");
          const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
          const loader = new DefaultResourceLoader({
            cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
            noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [createCodemodeExtension({ mode: "only" }), (pi) => {
              registerQuestionTool(pi);
              registerGoalInterface(pi, runtime);
              registerGoalRuntime(pi, runtime);
              registerGoalSettlement(pi, runtime);
            }],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          ({ session } = await createAgentSession({
            cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
            sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")),
            tools: excluded === "allowlist" ? ["question", "codemode"] : ["question", "killeros_*", "codemode"],
            excludeTools: excluded === "allowlist" ? [] : [excluded],
          }));
          const errors: string[] = [];
          const { ctx } = createTuiContext();
          const ui = extensionContextTestAdapter({ ui: { ...ctx.ui,
            select: async () => { assert.fail("scripts must not open question UI"); },
            input: async () => { assert.fail("scripts must not open question UI"); },
          } }).ui;
          await session.bindExtensions({ mode, uiContext: ui,
            onError(error) { errors.push(`${error.event}: ${error.error}`); } });
          await session.prompt("/goal Verify exclusions through native selection");
          if (excluded !== "question") {
            assert.equal(runtime.state?.status, "paused");
            assert.equal(runtime.state?.turns, 0);
            assert.equal(runtime.state?.stopReason, "killeros_goal_update is unavailable");
            assert.equal(faux.state.callCount, 0, "an excluded goal tool must prevent any provider request");
            await session.prompt("Inspect the remaining declarations");
          }
          await session.waitForIdle();
          assert.equal(faux.state.callCount, 2);
          for (const names of declarations) {
            assert.equal(names.includes("question"), excluded !== "question");
            assert.equal(names.includes("killeros_goal_update"), excluded === "question");
            assert.equal(names.includes("codemode"), true);
          }
          const script = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
          assert.ok(script?.role === "toolResult");
          assert.equal(script.isError, false, JSON.stringify(script.content));
          const output = script.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          assert.match(output, /tools\.question does not exist/u);
          assert.match(output, /tools\.killeros_goal_update does not exist/u);
          assert.doesNotMatch(output, /Unexpected call/u);
          for (const name of ["question", "killeros_goal_update"]) {
            assert.equal(session.getCallableToolNames().includes(name), false);
          }
          assert.equal(session.pendingMessageCount, 0);
          assert.equal(runtime.continuationScheduled, false);

          const blocked = transitionGoalState({
            ...createNewGoalState("Finish the original blocked objective", 0, undefined, Date.now()), turns: 3,
          }, "blocked", "Waiting for an external prerequisite", {}, Date.now());
          session.sessionManager.appendCustomEntry("killeros-goal", { version: 1, event: "blocked", state: blocked });
          await session.reload();
          assert.equal(runtime.state?.status, "blocked");
          assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false);
          const firstBlockedRequest = declarations.length;
          faux.setResponses([
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage(fauxToolCall("codemode", {
                code: 'try { await tools.killeros_goal_update({status: "complete", evidence: "Nested attempt"}); text("Unexpected call"); } catch (error) { text(error.message); }',
              }));
            },
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage("Ordinary blocked work without a goal decision");
            },
          ]);
          await session.prompt("Finish this ordinary response without resuming the blocked goal");
          await session.waitForIdle();
          assert.equal(declarations.length - firstBlockedRequest, 2, "selection must not abort an ordinary request");
          for (const names of declarations.slice(firstBlockedRequest)) {
            assert.equal(names.includes("killeros_goal_update"), excluded === "question");
          }
          assert.equal(runtime.state?.status, "blocked");
          assert.deepEqual(runtime.state, blocked);
          assert.equal(runtime.goalTurnInFlight, false);
          assert.equal(runtime.continuationScheduled, false);
          assert.equal(session.pendingMessageCount, 0);
          assert.deepEqual(errors, []);
        } finally {
          session?.dispose();
          await removeDirectoryEventually(directory);
        }
      });
    }
  }
});

test("Pi user cancellation stops goal work after a normal result, during retry, and during pending compaction", { timeout: 30_000 }, async (t) => {
  for (const stage of ["normal result", "retry", "goal compaction", "ordinary compaction", "production entrypoint"] as const) {
    await t.test(stage, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-cancellation-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      try {
        const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
        mkdirSync(cwd); mkdirSync(agentDir);
        const runtime = createGoalRuntime();
        if (stage === "production entrypoint") {
          process.env.PI_CODING_AGENT_DIR = agentDir;
          initializeFixtureRepository(cwd);
        }
        const compacting = stage.endsWith("compaction");
        const ordinary = stage === "ordinary compaction";
        const faux = fauxProvider({ provider: "killeros-cancellation", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey("killeros-cancellation", "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: compacting, reserveTokens: 100, keepRecentTokens: 1 },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 30_000, maxAgentDelayMs: 30_000 }, cacheWarming: "off" });
        settingsManager.setProjectTrusted(true);
        let bells = 0;
        let resolveCompacting: (() => void) | undefined;
        const compactionStarted = new Promise<void>((resolve) => { resolveCompacting = resolve; });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            if (stage === "production entrypoint") {
              Killeros(pi, { completionNotifications: { store: { load: () => true, save() {} }, ring: () => { bells += 1; } } });
            } else {
              registerGoalInterface(pi, runtime); registerGoalRuntime(pi, runtime);
              registerWorkedFor(pi, Date.now, async () => ({ finish: async () => ({ state: "unavailable", reason: "not-git" }), dispose: async () => undefined }));
              const goal = registerGoalSettlement(pi, runtime);
              registerAutoCompaction(pi, { goal, loadPreference: () => ({ enabled: compacting, percentRemaining: 100 }),
                getCompactionSettings: () => ({ enabled: compacting, reserveTokens: 100, keepRecentTokens: 1 }) });
              registerCompletionNotifications(pi, { store: { load: () => true, save() {} }, ring: () => { bells += 1; } });
            }
            pi.on("session_before_compact", async (event) => {
              resolveCompacting?.();
              if (!event.signal.aborted) await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
              return { cancel: true };
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")), noTools: "builtin" }));
        const host = session;
        const errors: string[] = [];
        const { ctx } = createTuiContext();
        await host.bindExtensions({ mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); } });
        const settlements: boolean[] = [];
        let cancellation: Promise<void> | undefined;
        host.subscribe((event) => {
          if ((stage === "normal result" || stage === "production entrypoint") && event.type === "agent_end") cancellation = host.abort();
          if (stage === "retry" && event.type === "auto_retry_start") cancellation = new Promise<void>((resolve, reject) => {
            setImmediate(() => { host.abort().then(resolve, reject); });
          });
          if (event.type === "agent_settled") settlements.push("aborted" in event && event.aborted === true);
        });
        faux.setResponses(stage === "retry" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "server_busy" })]
          : ordinary ? [fauxAssistantMessage("ordinary response")]
            : [fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "continue", evidence: "First step verified", nextAction: "Do the next step" })), fauxAssistantMessage("normal response")]);
        const prompt = host.prompt(ordinary ? "Inspect the fixture" : "/goal Finish the isolated fixture");
        if (compacting) {
          await compactionStarted;
          await host.abort();
        }
        await prompt;
        await cancellation;
        await host.waitForIdle();
        if (compacting) await waitFor(() => !host.isCompacting && runtime.automaticCompaction === undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(faux.state.callCount, stage === "normal result" || stage === "production entrypoint" ? 2 : 1);
        assert.deepEqual(settlements, [true]);
        const receipts = host.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for");
        assert.equal(receipts.length, 1);
        assert.ok(receipts[0]?.type === "custom" && isUnknownRecord(receipts[0].data));
        assert.equal(receipts[0].data.outcome, "stopped");
        assert.equal(bells, 0);
        if (!ordinary) {
          let finalGoalState = runtime.state;
          if (stage === "production entrypoint") {
            const goalEntry = host.sessionManager.getEntries().reverse()
              .find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
            assert.ok(goalEntry?.type === "custom" && isUnknownRecord(goalEntry.data));
            finalGoalState = parseGoalState(goalEntry.data.state);
          }
          assert.equal(finalGoalState?.status, "paused");
          assert.equal(finalGoalState?.turns, 1);
          assert.equal(finalGoalState?.maxTurns, 20);
          assert.notEqual(finalGoalState?.resumeAfterManualCompaction, true);
        }
        assert.equal(runtime.continuationScheduled, false);
        assert.equal(host.pendingMessageCount, 0);
        assert.deepEqual(errors, []);
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("Pi native CLI rejects mixed modifiers and wildcard modifiers", () => {
  for (const selection of ["read,+codemode", "+codemode,-killeros_*"]) {
    const args = parseArgs(["--tools", selection]);
    assert.equal(args.diagnostics.some((diagnostic) => diagnostic.type === "error"), true, selection);
    assert.equal(args.tools, undefined);
  }
  for (const selection of ["+codemode", "-killeros_goal_update", "read,killeros_*"]) {
    const args = parseArgs(["--tools", selection]);
    assert.deepEqual(args.diagnostics, []);
    assert.deepEqual(args.tools, selection.split(","));
  }
});

test("Pi +codemode retains native defaults through goal activation and reload", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-tool-modifiers-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const runtime = createGoalRuntime();
    const faux = fauxProvider({ provider: "killeros-modifiers", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-modifiers", "local-test-key");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createCodemodeExtension({ mode: "on" }), (pi) => {
        registerQuestionTool(pi); registerGoalInterface(pi, runtime); registerGoalRuntime(pi, runtime); registerGoalSettlement(pi, runtime);
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")),
      tools: parseArgs(["--tools", "+codemode"]).tools,
    }));
    const { ctx } = createTuiContext();
    const errors: string[] = [];
    await session.bindExtensions({ mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
      onError(error) { errors.push(`${error.event}: ${error.error}`); } });
    for (const stage of ["startup", "reload"] as const) {
      if (stage === "reload") await session.reload();
      faux.setResponses([(context) => {
        const names = getCurrentTools(context.messages).map((tool) => tool.name);
        for (const name of ["read", "bash", "edit", "write", "codemode", "question", "killeros_goal_update"]) assert.equal(names.includes(name), true, `${stage}/${name}`);
        return fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Defaults verified" }));
      }, fauxAssistantMessage("Verified")]);
      await session.prompt(`/goal Verify defaults at ${stage}`);
      await session.waitForIdle();
      assert.equal(runtime.state?.status, "complete");
      for (const name of ["question", "killeros_goal_update"]) {
        assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
        assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
        assert.equal(session.getCallableToolNames().includes(name), false);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await removeDirectoryEventually(directory);
  }
});

test("real Pi delivery starts one hidden ordinary continuation after turn_end -> agent_settled -> compaction", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-auto-compaction-lifecycle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({
      autoCompaction: { enabled: true, percentRemaining: 100 },
    }));
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const faux = fauxProvider({
      provider: "killeros-lifecycle",
      models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("ordinary turn finished"),
      fauxAssistantMessage("continuation turn finished"),
    ]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-lifecycle", "local-test-key");

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      settingsManager,
      extensionFactories: [(pi) => {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "Compacted ordinary task context.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendMessage({ role: "user", content: "Earlier task context", timestamp: Date.now() - 2 });
    sessionManager.appendMessage(fauxAssistantMessage("Earlier work", { timestamp: Date.now() - 1 }));
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      noTools: "all",
    });
    let agentStarts = 0;
    const lifecycleErrors: string[] = [];
    let continuationFinished: (() => void) | undefined;
    const continuation = new Promise<void>((resolve) => { continuationFinished = resolve; });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") agentStarts++;
      if (event.type === "message_end"
        && event.message.role === "assistant"
        && event.message.content.some((part) => part.type === "text" && part.text === "continuation turn finished")) {
        continuationFinished?.();
      }
    });
    try {
      await session.bindExtensions({
        mode: "rpc",
        shutdownHandler() {},
        onError(diagnostic) { lifecycleErrors.push(`${diagnostic.event}: ${diagnostic.error}`); },
      });
      await session.prompt("Continue the ordinary task");
      await continuation;
      await session.waitForIdle();

      assert.equal(agentStarts, 2);
      assert.equal(faux.state.callCount, 2);
      const internalMessages = session.messages.filter((message) => message.role === "custom"
        && message.customType === "killeros-auto-compaction");
      assert.equal(internalMessages.length, 1);
      const internalMessage = internalMessages[0];
      assert.ok(internalMessage?.role === "custom");
      assert.equal(internalMessage.display, false);
      assert.equal(session.messages.some((message) => message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("Continue the interrupted task")), false);
      assert.equal(session.pendingMessageCount, 0);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      unsubscribe();
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await removeDirectoryEventually(directory);
  }
});

test("real Pi compaction pauses a normally stopped goal after one decisionless request", { timeout: 30_000 }, async (t) => {
  for (const outcome of ["completed", "session-too-small"] as const) {
    await t.test(outcome, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-compaction-decision-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const compaction = { enabled: true, reserveTokens: 100, keepRecentTokens: outcome === "completed" ? 1 : 20_000 };
        writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction }));
        writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
        const provider = `killeros-goal-decision-${outcome}`;
        const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        faux.setResponses([
          fauxAssistantMessage("Normal stop without a decision"),
          fauxAssistantMessage("Another normal stop without a decision"),
          fauxAssistantMessage("End regression probe", { stopReason: "error", errorMessage: "End regression probe" }),
        ]);
        const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction, retry: { enabled: false }, cacheWarming: "off" });
        const sessionManager = SessionManager.create(cwd, path.join(directory, "sessions"));
        if (outcome === "completed") {
          sessionManager.appendMessage({ role: "user", content: "Earlier work", timestamp: Date.now() - 2 });
          sessionManager.appendMessage(fauxAssistantMessage("Earlier answer", { timestamp: Date.now() - 1 }));
        }
        const savedGoal = () => {
          const entry = sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
          assert.ok(entry?.type === "custom" && isUnknownRecord(entry.data));
          return parseGoalState(entry.data.state);
        };
        let resolvePaused: (() => void) | undefined;
        const paused = new Promise<void>((resolve) => { resolvePaused = resolve; });
        let compactions = 0;
        let compactionFailure: string | undefined;
        const errors: string[] = [];
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager,
          additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            pi.on("session_before_compact", (event) => {
              compactions += 1;
              return { compaction: { summary: "Local summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
            });
            pi.on("session_compact_failed", (event) => { compactionFailure = event.errorMessage; });
            pi.on("agent_settled", () => {
              const state = savedGoal();
              if (state?.status === "paused" && state.result) resolvePaused?.();
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager, resourceLoader: loader, noTools: "builtin",
        }));
        await session.bindExtensions({ mode: "rpc", onError(error) { errors.push(`${error.event}: ${error.error}`); } });
        await session.prompt("/goal Pause without a turn decision");
        await paused;
        await session.waitForIdle();
        await new Promise((resolve) => setImmediate(resolve));

        const state = savedGoal();
        assert.equal(state?.status, "paused");
        assert.equal(state?.result, "no turn decision");
        assert.equal(state?.turns, 1);
        assert.equal(state?.maxTurns, 20);
        assert.equal(state?.turnDecision, undefined);
        assert.equal(faux.state.callCount, 1);
        assert.equal(compactions, outcome === "completed" ? 1 : 0);
        assert.equal(compactionFailure, outcome === "completed" ? undefined : "Compaction failed: Nothing to compact (session too small)");
        assert.equal(session.pendingMessageCount, 0);
        assert.deepEqual(errors, []);
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi terminal goal compaction cannot start extra tool work in TUI or RPC", { timeout: 30_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const status of ["complete", "blocked"] as const) {
      await t.test(`${mode}/${status}`, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-terminal-compaction-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
          mkdirSync(cwd); mkdirSync(agentDir);
          process.env.PI_CODING_AGENT_DIR = agentDir;
          const compaction = { enabled: true, reserveTokens: 100, keepRecentTokens: 1 };
          const preferences = path.join(agentDir, "killeros.json");
          writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction }));
          writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 100 } }));
          const provider = `killeros-terminal-${mode}-${status}`;
          const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
          const extraFile = path.join(cwd, "unauthorized.txt");
          const decisions: AssistantMessage[] = [];
          const turns = status === "blocked" ? 3 : 1;
          for (let turn = 1; turn <= turns; turn++) {
            decisions.push(fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
              status, evidence: `Verified turn ${turn}`, ...(status === "blocked" ? { blockerKey: "external" } : {}),
            })));
            if (turn < turns) decisions.push(fauxAssistantMessage(`Audit ${turn} finished`));
          }
          faux.setResponses([
            ...decisions,
            () => {
              // Trigger only at the final answer, so normal tool-result follow-up is not mistaken for a restart.
              writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
              return fauxAssistantMessage("The terminal goal request finished");
            },
            fauxAssistantMessage(fauxToolCall("write", { path: extraFile, content: "Unauthorized continuation" })),
            fauxAssistantMessage("Unauthorized work finished"),
          ]);
          const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
          modelRuntime.registerNativeProvider(faux.provider);
          await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
          const settingsManager = SettingsManager.inMemory({ compaction, retry: { enabled: false }, cacheWarming: "off" });
          const sessionManager = SessionManager.create(cwd, path.join(directory, "sessions"));
          sessionManager.appendMessage({ role: "user", content: "Earlier context", timestamp: Date.now() - 2 });
          sessionManager.appendMessage(fauxAssistantMessage("Earlier answer", { timestamp: Date.now() - 1 }));
          let compactions = 0;
          let resolveCompacted: (() => void) | undefined;
          const compacted = new Promise<void>((resolve) => { resolveCompacted = resolve; });
          const errors: string[] = [];
          const loader = new DefaultResourceLoader({
            cwd, agentDir, settingsManager, additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [(pi) => {
              pi.on("session_before_compact", (event) => {
                compactions++;
                return { compaction: { summary: "The goal is terminal. Do not continue it.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
              });
              pi.on("session_compact", () => { resolveCompacted?.(); });
            }],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          ({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager, resourceLoader: loader }));
          let starts = 0;
          let settlements = 0;
          let finalAnswer = false;
          session.subscribe((event) => {
            if (event.type === "agent_start") starts++;
            if (event.type === "agent_settled") settlements++;
            if (event.type === "message_end" && event.message.role === "assistant"
              && event.message.content.some((part) => part.type === "text" && part.text === "The terminal goal request finished")) finalAnswer = true;
          });
          await session.bindExtensions({ mode, uiContext: extensionContextTestAdapter(createTuiContext().ctx).ui, onError(error) { errors.push(`${error.event}: ${error.error}`); } });
          await session.prompt("/goal Stop after the terminal decision");
          await compacted;
          await waitFor(() => session?.isCompacting === false);
          await new Promise((resolve) => setImmediate(resolve));
          await session.waitForIdle();
          const entry = sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
          assert.ok(entry?.type === "custom" && isUnknownRecord(entry.data));
          const state = parseGoalState(entry.data.state);
          assert.equal(state?.status, status);
          assert.equal(state?.turns, turns);
          assert.equal(finalAnswer, true);
          assert.equal(compactions, 1);
          assert.equal(starts, turns);
          assert.equal(faux.state.callCount, turns * 2);
          assert.equal(existsSync(extraFile), false);
          assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "killeros-auto-compaction"), false);
          assert.equal(session.pendingMessageCount, 0);
          await waitFor(() => settlements === turns);
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (status === "blocked") {
            writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 100 } }));
            const laterCompacted = new Promise<void>((resolve) => { resolveCompacted = resolve; });
            faux.setResponses([
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Audited the original objective after resolving the prerequisite" })),
              () => {
                writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
                return fauxAssistantMessage("The later terminal completion finished");
              },
              fauxAssistantMessage(fauxToolCall("write", { path: extraFile, content: "Unauthorized blocked completion restart" })),
              fauxAssistantMessage("Unauthorized work finished"),
            ]);
            await session.prompt("The prerequisite is resolved. Audit and complete the original goal without resuming it.");
            await laterCompacted;
            await waitFor(() => session?.isCompacting === false);
            await session.waitForIdle();
            await waitFor(() => settlements === turns + 1);
            await new Promise<void>((resolve) => setImmediate(resolve));
            const finalEntry = sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
            assert.ok(finalEntry?.type === "custom" && isUnknownRecord(finalEntry.data));
            const completed = parseGoalState(finalEntry.data.state);
            assert.equal(completed?.status, "complete");
            assert.equal(completed?.turns, turns);
            assert.deepEqual(completed?.verification, state?.verification);
            assert.equal(completed?.activeMilliseconds, state?.activeMilliseconds);
            assert.equal(compactions, 2);
            assert.equal(starts, turns + 1);
            assert.equal(faux.state.callCount, turns * 2 + 2);
            assert.equal(existsSync(extraFile), false);
            assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "killeros-auto-compaction"), false);
            assert.equal(session.pendingMessageCount, 0);
          }
          assert.deepEqual(errors, []);
        } finally {
          session?.dispose();
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          await removeDirectoryEventually(directory);
        }
      });
    }
  }
});

test("real Pi handoff survives immediate disposal and resume without an agent turn", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-handoff-lifecycle-"));
  let runtimeHost: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const summary = ["Objective", "Current state", "Decisions", "Constraints", "Completed work", "Relevant artifacts", "Verification", "Blockers or open questions", "Exact next action", "Suggested skills"]
      .map((section) => `## ${section}\nContinue the existing release checks.`).join("\n\n");
    const faux = fauxProvider({ provider: "killeros-handoff-lifecycle", models: [{ id: "local", contextWindow: 100_000, maxTokens: 10_000 }] });
    faux.setResponses([fauxAssistantMessage(summary)]);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-handoff-lifecycle", "local-test-key");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const sourceManager = SessionManager.create(cwd, path.join(directory, "sessions"));
    sourceManager.appendMessage({ role: "user", content: "Finish the release checks", timestamp: Date.now() });
    sourceManager.appendSessionInfo("Release checks");
    const sourceFile = sourceManager.getSessionFile();
    assert.ok(sourceFile);
    const notices: string[] = [];
    const errors: string[] = [];
    let agentStarts = 0;
    runtimeHost = await createAgentSessionRuntime(async (options) => {
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi) => {
          registerHandoff(pi, createGoalRuntime(), 8_192);
          pi.on("agent_start", () => { agentStarts += 1; });
        }],
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
        sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "all",
      });
      const { ctx } = createTuiContext();
      ctx.ui.notify = (message) => { notices.push(message); };
      await created.session.bindExtensions({
        mode: "rpc", uiContext: extensionContextTestAdapter(ctx).ui,
        commandContextActions: {
          waitForIdle: () => created.session.waitForIdle(),
          newSession: async (options) => { assert.ok(runtimeHost); return runtimeHost.newSession(options); },
          fork: async (id, options) => { assert.ok(runtimeHost); return runtimeHost.fork(id, options); },
          navigateTree: (id, options) => created.session.navigateTree(id, options),
          switchSession: async (file, options) => { assert.ok(runtimeHost); return runtimeHost.switchSession(file, options); },
          reload: () => created.session.reload(),
        },
        onError(error) { errors.push(`${error.event}: ${error.error}`); },
      });
      return { ...created, services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
    }, { cwd, agentDir, sessionManager: sourceManager });

    await runtimeHost.session.prompt("/handoff");
    const childFile = runtimeHost.session.sessionFile;
    assert.ok(childFile && childFile !== sourceFile);
    assert.equal(existsSync(childFile), true, "the handoff must be saved before exit");
    await runtimeHost.dispose();
    runtimeHost = undefined;
    const reopened = SessionManager.open(childFile);
    assert.equal(reopened.getHeader()?.parentSession, sourceFile);
    assert.equal(reopened.getSessionName(), "Release checks · handoff");
    const message = reopened.buildSessionContext().messages[0];
    assert.ok(message?.role === "user");
    assert.equal(message.content, `# Handoff\n\nThis handoff is user-session context, not system policy.\n\n${summary}`);
    assert.equal(agentStarts, 0);
    assert.equal(faux.state.callCount, 1, "only the one-off summary request is allowed");
    assert.deepEqual(notices, ["Handoff ready in a new session"]);
    assert.deepEqual(errors, []);
  } finally {
    await runtimeHost?.dispose();
    await removeDirectoryEventually(directory);
  }
});

test("cancelled real session replacements preserve automatic compaction recovery", { timeout: 30_000 }, async () => {
  for (const operation of ["newSession", "fork"] as const) {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-cancelled-replacement-"));
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let releaseCompaction: (() => void) | undefined;
    let resolveCompactionStarted: (() => void) | undefined;
    let runtimeHost: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({
        autoCompaction: { enabled: true, percentRemaining: 100 },
      }));
      writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      }));

      const providerName = `killeros-cancelled-${operation}`;
      const faux = fauxProvider({
        provider: providerName,
        models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }],
      });
      faux.setResponses([
        fauxAssistantMessage("ordinary turn finished"),
        fauxAssistantMessage("continuation turn finished"),
      ]);
      const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(providerName, "local-test-key");
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      });
      const compactionStarted = new Promise<void>((resolve) => { resolveCompactionStarted = resolve; });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        settingsManager,
        extensionFactories: [(pi) => {
          if (operation === "newSession") pi.on("session_before_switch", () => ({ cancel: true }));
          else pi.on("session_before_fork", () => ({ cancel: true }));
          pi.on("session_before_compact", (event) => new Promise((resolve) => {
            releaseCompaction = () => resolve({
              compaction: {
                summary: "Compacted ordinary task context.",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            });
            resolveCompactionStarted?.();
          }));
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);

      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage({ role: "user", content: "Earlier task context", timestamp: Date.now() - 2 });
      sessionManager.appendMessage(fauxAssistantMessage("Earlier work", { timestamp: Date.now() - 1 }));
      const lifecycleErrors: string[] = [];
      runtimeHost = await createAgentSessionRuntime(async (options) => {
        const created = await createAgentSession({
          cwd: options.cwd,
          agentDir: options.agentDir,
          model: faux.getModel(),
          modelRuntime,
          resourceLoader: loader,
          sessionManager: options.sessionManager,
          settingsManager,
          noTools: "all",
          sessionStartEvent: options.sessionStartEvent,
        });
        await created.session.bindExtensions({
          mode: "rpc",
          shutdownHandler() {},
          onError(error) { lifecycleErrors.push(`${error.event}: ${error.error}`); },
        });
        return {
          ...created,
          services: {
            cwd: options.cwd,
            agentDir: options.agentDir,
            modelRuntime,
            settingsManager,
            resourceLoader: loader,
            diagnostics: [],
          },
          diagnostics: [],
        };
      }, { cwd, agentDir, sessionManager });

      let agentStarts = 0;
      let settledCount = 0;
      let resolveInitialSettlement: (() => void) | undefined;
      let resolveContinuation: (() => void) | undefined;
      const initialSettlement = new Promise<void>((resolve) => { resolveInitialSettlement = resolve; });
      const continuation = new Promise<void>((resolve) => { resolveContinuation = resolve; });
      unsubscribe = runtimeHost.session.subscribe((event) => {
        if (event.type === "agent_start") agentStarts += 1;
        if (event.type === "agent_settled" && settledCount++ === 0) resolveInitialSettlement?.();
        if (event.type === "message_end"
          && event.message.role === "assistant"
          && event.message.content.some((part) => part.type === "text" && part.text === "continuation turn finished")) {
          resolveContinuation?.();
        }
      });

      const prompt = runtimeHost.session.prompt("Continue the ordinary task");
      await Promise.all([compactionStarted, initialSettlement]);
      const replacement = operation === "newSession"
        ? await runtimeHost.newSession()
        : await runtimeHost.fork("not-an-entry");
      assert.deepEqual(replacement, { cancelled: true });
      releaseCompaction?.();
      await continuation;
      await prompt;
      await runtimeHost.session.waitForIdle();

      assert.equal(agentStarts, 2);
      assert.equal(faux.state.callCount, 2);
      assert.equal(runtimeHost.session.messages.filter((message) => message.role === "custom"
        && message.customType === "killeros-auto-compaction").length, 1);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      releaseCompaction?.();
      unsubscribe?.();
      await runtimeHost?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await removeDirectoryEventually(directory);
    }
  }
});

test("real Pi session boundaries discard pending receipts without stale settlement handlers", { timeout: 30_000 }, async (t) => {
  for (const operation of ["none", "appendSessionInfo", "newSession", "cancelledNewSession", "reload", "navigateTree", "navigateTreeBeforeReceiptReset", "navigateTreeBeforeReceiptSettlement", "cancelledNavigateTree"] as const) {
    await t.test(operation, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-receipt-lifecycle-"));
      const cwd = path.join(directory, "project");
      const agentDir = path.join(directory, "agent");
      mkdirSync(cwd);
      mkdirSync(agentDir);
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      let runtimeHost: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
      let releaseScan: (() => void) | undefined;
      let scanStarted: (() => void) | undefined;
      const scanning = new Promise<void>((resolve) => { scanStarted = resolve; });
      const scan = new Promise<void>((resolve) => { releaseScan = resolve; });
      let settlementStarted: (() => void) | undefined;
      let releaseSettlement: (() => void) | undefined;
      const settling = new Promise<void>((resolve) => { settlementStarted = resolve; });
      const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
      const errors: string[] = [];
      const notices: string[] = [];
      let bells = 0;
      try {
        const provider = `killeros-receipt-${operation}`;
        const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        faux.setResponses([fauxAssistantMessage("first turn finished"), fauxAssistantMessage("next turn finished")]);
        const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
        settingsManager.setProjectTrusted(true);
        runtimeHost = await createAgentSessionRuntime(async (options) => {
          const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [(pi) => {
              if (operation === "cancelledNewSession") pi.on("session_before_switch", () => ({ cancel: true }));
              if (operation === "cancelledNavigateTree") pi.on("session_before_tree", () => ({ cancel: true }));
              if (operation === "navigateTreeBeforeReceiptSettlement") pi.on("agent_settled", async () => {
                settlementStarted?.();
                await settlement;
              });
              if (operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement") pi.on("session_tree", async () => {
                releaseSettlement?.();
                releaseScan?.();
                await new Promise((resolve) => setImmediate(resolve));
              });
              registerWorkedFor(pi, Date.now, async () => ({
                finish: async () => {
                  scanStarted?.();
                  await scan;
                  return { state: "unavailable", reason: "error" };
                },
                dispose: async () => undefined,
              }));
              registerRequestActivity(pi);
              registerCompletionNotifications(pi, {
                store: { load: () => true, save() {} },
                ring: () => { bells += 1; },
              });
            }],
          });
          await loader.reload();
          const created = await createAgentSession({
            cwd,
            agentDir,
            sessionManager: options.sessionManager,
            sessionStartEvent: options.sessionStartEvent,
            model: faux.getModel(),
            modelRuntime,
            settingsManager,
            resourceLoader: loader,
            noTools: "all",
          });
          const { ctx } = createTuiContext();
          ctx.ui.notify = (message) => { notices.push(message); };
          await created.session.bindExtensions({ mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui });
          return {
            ...created,
            services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] },
            diagnostics: [],
          };
        }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
        const anchor = runtimeHost.session.sessionManager.appendMessage(fauxAssistantMessage("Earlier branch"));

        const recordError = (error: { event: string; error: string }): void => { errors.push(`${error.event}: ${error.error}`); };
        const source = runtimeHost.session;
        source.extensionRunner.onError(recordError);
        const oldContext = source.extensionRunner.createContext();
        const prompt = source.prompt("Finish one turn");
        await (operation === "navigateTreeBeforeReceiptSettlement" ? settling : scanning);
        assert.equal(source.isIdle, true, "Pi reports idle before receipt finalization returns");
        if (operation === "reload") await source.reload();
        else if (operation === "appendSessionInfo") source.sessionManager.appendSessionInfo("Renamed during receipt collection");
        else if (operation === "navigateTree" || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement" || operation === "cancelledNavigateTree") {
          assert.equal((await source.navigateTree(anchor)).cancelled, operation === "cancelledNavigateTree");
        } else if (operation !== "none") {
          assert.deepEqual(await runtimeHost.newSession(), { cancelled: operation === "cancelledNewSession" });
        }
        const replaced = operation === "newSession" || operation === "reload";
        const receiptDiscarded = replaced || operation === "navigateTree" || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement";
        // Finalization inside session_tree is not idle, so the existing bell guard stays silent.
        const expectedBells = replaced || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement" ? 0 : 1;
        if (replaced) assert.throws(() => oldContext.mode, /stale/u);
        releaseScan?.();
        await prompt;

        const receipts = source.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for");
        assert.equal(receipts.length, receiptDiscarded ? 0 : 1);
        assert.equal(notices.length, receiptDiscarded ? 0 : 1);
        if (operation === "navigateTree" || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement") {
          assert.equal(source.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user"
            && entry.message.content === "Finish one turn"), false);
        }
        assert.equal(bells, expectedBells);
        assert.deepEqual(errors, []);

        runtimeHost.session.extensionRunner.onError(recordError);
        await runtimeHost.session.prompt("Finish the next turn");
        assert.equal(runtimeHost.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for").length,
          receiptDiscarded ? 1 : 2);
        assert.equal(bells, expectedBells + 1);
        assert.deepEqual(errors, []);
      } finally {
        releaseSettlement?.();
        releaseScan?.();
        await runtimeHost?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
  }
});

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("all KillerOS tools expose provider-compatible object schemas", () => {
  const { tools } = createHarness();

  for (const tool of tools.values()) {
    const rawSchema: unknown = JSON.parse(JSON.stringify(tool.parameters));
    assert.ok(isUnknownRecord(rawSchema), `${tool.name} schema must be a JSON object`);
    const schema = rawSchema;
    assert.equal(schema.type, "object", `${tool.name} must use a top-level object schema`);
    assert.equal(typeof schema.properties, "object", `${tool.name} must declare object properties`);
    assert.equal(schema.anyOf, undefined, `${tool.name} must not use a top-level anyOf`);
    assert.equal(schema.oneOf, undefined, `${tool.name} must not use a top-level oneOf`);
  }
});

test("a stale replacement releases a running goal's held continuation in real Pi", { timeout: 15_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    await t.test(mode, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-held-continuation-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let releaseFirst = (): void => { throw new Error("first response gate was not initialized"); };
      let signalFirst = (): void => { throw new Error("first response barrier was not initialized"); };
      let releaseNext = (): void => { throw new Error("next response gate was not initialized"); };
      let signalNext = (): void => { throw new Error("next response barrier was not initialized"); };
      const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const nextStarted = new Promise<void>((resolve) => { signalNext = resolve; });
      const nextGate = new Promise<void>((resolve) => { releaseNext = resolve; });
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const runtime = createGoalRuntime();
        const faux = fauxProvider({ provider: "killeros-held-goal", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        faux.setResponses([
          async () => {
            signalFirst();
            await firstGate;
            return fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
              status: "continue", evidence: "First check passed", nextAction: "Run the second check",
            }), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("First step finished"),
          async () => {
            signalNext();
            await nextGate;
            return fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
              status: "complete", evidence: "Both checks passed",
            }), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("Original objective finished"),
        ]);
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath: null,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey("killeros-held-goal", "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerGoalInterface(pi, runtime);
            registerGoalRuntime(pi, runtime);
            registerGoalSettlement(pi, runtime);
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")), noTools: "builtin",
        }));
        const host = session;
        const errors: string[] = [];
        const { ctx: uiContext } = createTuiContext();
        uiContext.ui.confirm = async () => true;
        await host.bindExtensions({
          mode, uiContext: extensionContextTestAdapter(uiContext).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        const command = host.extensionRunner.getCommand("goal");
        assert.ok(command);
        const ctx = host.extensionRunner.createCommandContext();
        ctx.waitForIdle = () => host.waitForIdle();
        await command.handler("Original objective", ctx);
        await firstStarted;
        const replacement = command.handler("Replacement objective", ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(runtime.continuationHeld);
        releaseFirst();
        await replacement;

        assert.equal(runtime.state?.objective, "Original objective", "stale replacements must not overwrite an accepted decision");
        assert.equal(runtime.state?.turns, 2, "releasing the hold must start the authorized next turn");
        assert.equal(runtime.state?.maxTurns, 20);
        assert.equal(runtime.goalTurnInFlight, true);
        assert.equal(runtime.continuationHeld, undefined);
        await nextStarted;
        assert.equal(faux.state.callCount, 3, "exactly one next logical turn starts");
        releaseNext();
        await host.waitForIdle();
        assert.equal(runtime.state?.status, "complete");
        assert.equal(runtime.state?.turns, 2);
        assert.equal(faux.state.callCount, 4);
        assert.equal(host.pendingMessageCount, 0);
        assert.deepEqual(errors, []);
      } finally {
        releaseFirst();
        releaseNext();
        if (session) {
          await session.waitForIdle();
          session.dispose();
        }
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("BUG-05 real Pi tree navigation invalidates a pending goal-start command", { timeout: 20000 }, async (t) => {
  for (const cancelled of [false, true]) {
    const root = mkdtempSync(path.join(process.cwd(), "node_modules", ".killeros-edge-goal-command-"));
    t.after(() => removeDirectoryEventually(root));
    const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const state = createGoalRuntime();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const faux = fauxProvider({ provider: "killeros-edge-goal", models: [{ id: "local", contextWindow: 100000, maxTokens: 1000 }] });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-edge-goal", "fixture-only-key");
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
      registerGoalInterface(pi, state); registerGoalRuntime(pi, state);
      if (cancelled) pi.on("session_before_tree", () => ({ cancel: true }));
    }] });
    await loader.reload();
    const manager = SessionManager.create(cwd, path.join(root, "sessions"));
    const anchor = manager.appendMessage(fauxAssistantMessage("Earlier branch"));
    manager.appendMessage({ role: "user", content: "Source branch", timestamp: Date.now() });
    const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, settingsManager, modelRuntime, model: faux.getModel(), resourceLoader: loader, noTools: "all" });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "rpc", shutdownHandler() {} });
    const command = session.extensionRunner.getCommand("goal"); assert.ok(command);
    const ctx = session.extensionRunner.createCommandContext();
    let release: (() => void) | undefined;
    ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
    ctx.hasPendingMessages = () => true; // Keep the reproduction limited to persistence, without a model turn.
    const pending = command.handler("Objective entered on the source branch", ctx);
    assert.ok(release);
    assert.equal((await session.navigateTree(anchor)).cancelled, cancelled);
    release(); await pending;
    const goals = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
    assert.equal(goals.length, cancelled ? 1 : 0, "only cancelled navigation preserves pending work");
  }
});
