import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { passiveGitCommand, passiveGitEnv } from "../killeros/passive-git-status.ts";
import { parseGoalState } from "../killeros/goal-state.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
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
    await terminal.submitEditorText("terminal single question", { signal: t.signal });
    screens.singleBeforeResize = await terminal.waitForScreen((screen) => screen.includes("Resize question") && screen.includes("Second choice"), { signal: t.signal });
    const beforeResize = terminal.sequence;
    terminal.resize(80, 24);
    screens.singleAfterResize = await terminal.waitForScreen((screen) => screen.includes("Resize question") && screen.includes("Second choice"), { signal: t.signal, after: beforeResize });
    terminal.write("\x1b[B\x1b[13u");
    await terminal.waitForScreen((screen) => screen.includes("Single interaction done"), { signal: t.signal });
    assert.deepEqual(faults, []);
    assert.equal(requests.length, 2);
    await terminal.submitEditorText("terminal cancel question", { signal: t.signal });
    await terminal.waitForScreen((screen) => screen.includes("Cancel partial question") && screen.includes("Selected 0"), { signal: t.signal });
    terminal.write("\x1b[13u");
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
    terminal.write("\x1b[13u");
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
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
