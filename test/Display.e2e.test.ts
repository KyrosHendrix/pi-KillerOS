import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

const durationCases = [
  { name: "duration-0-ms", milliseconds: 0, expected: "0s" },
  { name: "duration-999-ms", milliseconds: 999, expected: "0s" },
  { name: "duration-1-second", milliseconds: 1_000, expected: "1s" },
  { name: "duration-59-seconds", milliseconds: 59_999, expected: "59s" },
  { name: "duration-1-minute", milliseconds: 60_000, expected: "1m 00s" },
  { name: "duration-1-minute-5-seconds", milliseconds: 65_000, expected: "1m 05s" },
  { name: "duration-59-minutes", milliseconds: 3_599_999, expected: "59m 59s" },
  { name: "duration-1-hour", milliseconds: 3_600_000, expected: "1h 00m 00s" },
  { name: "duration-1-hour-2-minutes-5-seconds", milliseconds: 3_725_000, expected: "1h 02m 05s" },
  { name: "duration-25-hours", milliseconds: 90_061_000, expected: "25h 01m 01s" },
] as const;

// Catalog ID: DISP-01.
test("Time formatting preserves seconds across unit boundaries in goal and footer displays", { timeout: 120_000 }, async (t) => {
  const temporaryRoot = realpathSync(tmpdir());
  for (let parent = temporaryRoot; ; parent = path.dirname(parent)) {
    assert.equal(existsSync(path.join(parent, ".git")), false, "Display scratch must have no repository ancestor");
    if (path.dirname(parent) === parent) break;
  }
  const directory = mkdtempSync(path.join(temporaryRoot, ".killeros-display-"));
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  mkdirSync(agent);
  mkdirSync(project);
  mkdirSync(sessions);
  mkdirSync(temporary);

  const faults: string[] = [];
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    faults.push("The display fixture must not start a model request");
    response.writeHead(500, { connection: "close" });
    response.end("Unexpected display fixture request");
  });
  let terminal: PiTerminalProcess | undefined;
  let primaryFailure: unknown;
  let didFail = false;
  const cleanupFailures: unknown[] = [];
  let failureDirectory: string | undefined;
  let savedFailureReport = false;
  const screens: Record<string, string> = {};

  try {
    symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(directory, "node_modules"), "junction");
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("The display provider did not receive a TCP address"));
      });
    });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "off",
    }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: {
      "killeros-display": {
        api: "openai-completions",
        apiKey: "display-fixture-key",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [{ id: "local", name: "Local display fixture", contextWindow: 1_000_000,
          maxTokens: 16, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    } }));

    const sessionFiles: string[] = [];
    for (const item of durationCases) {
      const session = SessionManager.create(project, sessions);
      session.appendMessage({ role: "user", content: `Seeded ${item.name} goal display fixture.`, timestamp: Date.now() });
      session.appendSessionInfo(item.name);
      session.appendCustomEntry("killeros-goal", {
        version: 1,
        event: "set",
        state: {
          version: 1,
          revision: 1,
          objective: `Display ${item.name}`,
          status: "paused",
          createdAt: 0,
          updatedAt: 0,
          activeMilliseconds: item.milliseconds,
          turns: 0,
          blockedAuditStartTurn: 0,
          baselineTokens: 0,
          maxTurns: 20,
        },
      });
      const sessionFile = session.getSessionFile();
      assert.ok(sessionFile, `SessionManager must persist ${item.name}`);
      sessionFiles.push(sessionFile);
    }
    const initialSessionFile = sessionFiles.at(0);
    assert.ok(initialSessionFile, "the first saved goal session must be available to Pi");
    const fixtureExtension = path.join(directory, "display-sessions.ts");
    writeFileSync(fixtureExtension, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  const sessions: string[] = ${JSON.stringify(sessionFiles)};
  pi.registerCommand("fixture-display-session", {
    description: "Select an exact saved display fixture through native session replacement",
    handler: async (args, ctx) => {
      const index = Number(args);
      const file = sessions[index];
      if (!Number.isInteger(index) || file === undefined) throw new Error("Unknown display fixture");
      const result = await ctx.switchSession(file);
      if (result.cancelled) throw new Error("Display fixture switch was cancelled");
    },
  });
}
`);

    const env: NodeJS.ProcessEnv = {
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: path.join(directory, "appdata"),
      LOCALAPPDATA: path.join(directory, "localappdata"),
      TEMP: temporary,
      TMP: temporary,
      PATH: path.dirname(process.execPath),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }

    terminal = new PiTerminalProcess({
      file: process.execPath,
      args: [cliPath, "--model", "killeros-display/local", "--thinking", "off", "--tools", "read",
        "--session", initialSessionFile, "--session-dir", sessions, "--offline", "--approve", "--no-context-files",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
        "--extension", repositoryRoot, "--extension", fixtureExtension],
      cwd: project,
      env,
      cols: 120,
      rows: 30,
    });

    screens.startup = await terminal.waitForScreen(
      (screen) => screen.includes("KillerOS") && screen.includes("/goal paused"),
      { signal: t.signal },
    );
    for (const width of [120, 72]) {
      if (width === 72) {
        const resizeCursor = terminal.sequence;
        terminal.resize(width, 30);
        await terminal.waitForScreen(
          (screen) => screen.includes("/goal paused") && screen.includes("❯")
            && screen.split("\n").some((line) => line === "─".repeat(width)),
          { signal: t.signal, after: resizeCursor },
        );
      }
      for (const [index, item] of durationCases.entries()) {
        t.diagnostic(`DISP-01 vector ${index}: ${item.name}, width ${width}`);
        if (index > 0 || width === 72) {
          const switchCursor = terminal.sequence;
          // Explicit Enter avoids ConPTY translating a bare CR into Shift+Enter.
          terminal.write(`/fixture-display-session ${index}\x1b[13u`);
          screens[`session-${width}-${item.name}`] = await terminal.waitForScreen(
            (screen) => screen.split("\n").some((line) => line.trim() === `Goal started · Display ${item.name}`)
              && screen.includes("/goal paused"),
            { signal: t.signal, after: switchCursor },
          );
        }

        const statusCursor = terminal.sequence;
        terminal.write("/goal\x1b[13u");
        const expectedStatus = `Goal paused · 0/20 turns · ${item.expected} · 0 tokens`;
        screens[`status-${width}-${item.name}`] = await terminal.waitForScreen(
          (screen) => screen.includes(`Display ${item.name}`) && screen.includes(expectedStatus),
          { signal: t.signal, after: statusCursor },
        );
        assert.ok(screens[`status-${width}-${item.name}`]?.includes(expectedStatus),
          `${item.name}: exact elapsed text at width ${width}`);

        const closeStatusCursor = terminal.sequence;
        terminal.write("\x1b");
        screens[`footer-${width}-${item.name}`] = await terminal.waitForScreen(
          (screen) => screen.includes("/goal paused") && !screen.includes("Pause goal") && !screen.includes("Clear goal"),
          { signal: t.signal, after: closeStatusCursor },
        );
        t.diagnostic(`DISP-01 completed ${item.name}: ${item.expected}, width ${width}`);
      }
    }
    assert.equal(requestCount, 0, "saved-state display checks do not start model requests");
    assert.deepEqual(faults, []);
  } catch (error) {
    didFail = true;
    primaryFailure = error;
  }

  if (terminal) {
    try {
      const result = await terminal.close();
      if (result.code !== 0 || result.forced || result.failure !== undefined) {
        cleanupFailures.push(new Error(`Pi TUI cleanup was not natural: ${JSON.stringify(result)}`));
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (server.listening) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await removeDirectoryEventually(directory);
    assert.equal(existsSync(directory), false, "remove the owned display fixture directory");
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (requestCount !== 0) cleanupFailures.push(new Error(`Display fixture unexpectedly made ${requestCount} provider requests`));
  const errors = [
    ...(didFail ? [primaryFailure] : []),
    ...cleanupFailures,
    ...faults.map((fault) => new Error(fault)),
  ];
  if (errors.length > 0) {
    const diagnostics = JSON.stringify({ scenarioId: "DISP-01", node: process.version, platform: process.platform,
      directory, requestCount, faults, terminal: terminal?.diagnostics(), screens }, null, 2);
    try {
      failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-DISP-01-failure-"));
      try {
        throwScenarioFailure({ directory: failureDirectory, message: "DISP-01 failed or did not clean up naturally", errors, diagnostics });
      } catch (error) {
        savedFailureReport = existsSync(path.join(failureDirectory, "failure.txt"));
        if (!savedFailureReport) throw error;
        throw error;
      }
    } catch (reportError) {
      if (failureDirectory !== undefined && !savedFailureReport) {
        try {
          if (readdirSync(failureDirectory).length === 0) await removeDirectoryEventually(failureDirectory);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      throw new AggregateError([...errors, ...cleanupFailures, reportError], "DISP-01 failed or did not clean up naturally");
    }
  }
  t.diagnostic(JSON.stringify({ scenarioId: "DISP-01", piLaunches: 1, providerRequests: requestCount,
    otherChildLaunches: 0, durations: durationCases.length, widths: [120, 72], cleanup: "natural" }));
});

// Catalog ID: DISP-02.
test("Display telemetry clamps values, rounds thresholds, and sanitizes Windows paths", { timeout: 90_000 }, async (t) => {
  for (let parent = tmpdir(); ; parent = path.dirname(parent)) {
    assert.equal(existsSync(path.join(parent, ".git")), false, "Display scratch must have no repository ancestor");
    if (path.dirname(parent) === parent) break;
  }
  const directory = mkdtempSync(path.join(tmpdir(), ".killeros-display-telemetry-"));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  for (const folder of [project, agent, sessions]) mkdirSync(folder);
  const files: string[] = [];
  const inputs = ["positive", "negative", "nan"] as const;
  let terminal: PiTerminalProcess | undefined;
  const errors: unknown[] = [];
  const screens: Record<string, string> = {};
  try {
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "display-telemetry": {
      api: "openai-completions", apiKey: "local-display", baseUrl: "http://127.0.0.1:1/v1",
      models: [{ id: "local", name: "Display telemetry", contextWindow: 1_000_000, maxTokens: 16,
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    for (const kind of inputs) {
      const session = SessionManager.create(project, sessions);
      session.appendMessage({ role: "user", content: `telemetry-history-${kind}`, timestamp: 1 });
      const totals = kind === "positive" ? [Number.MAX_VALUE, Number.MAX_VALUE]
        : kind === "negative" ? [-Number.MAX_VALUE, -Number.MAX_VALUE] : [12345678901, 12345678902];
      for (const totalTokens of totals) session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved usage" }],
        api: "openai-completions", provider: "display-telemetry", model: "local", stopReason: "stop", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      session.appendCustomEntry("killeros-goal", { version: 1, event: "set", state: {
        version: 1, revision: 1, objective: `Telemetry ${kind}`, status: "paused", createdAt: 1, updatedAt: 1,
        activeMilliseconds: 0, turns: 0, blockedAuditStartTurn: 0, baselineTokens: 0, maxTurns: 20,
      } });
      for (const tokens of [999.6, 999999]) session.appendCustomEntry("killeros-worked-for", {
        version: 3, milliseconds: 1_000, outcome: "done", tokens,
      });
      const file = session.getSessionFile();
      assert.ok(file);
      if (kind === "nan") {
        // JSON exponent overflow preserves actual infinities on native load instead of serializing NaN as null.
        const bytes = readFileSync(file, "utf8");
        assert.equal(bytes.split('"totalTokens":12345678901').length, 2);
        assert.equal(bytes.split('"totalTokens":12345678902').length, 2);
        writeFileSync(file, bytes.replace('"totalTokens":12345678901', '"totalTokens":1e999')
          .replace('"totalTokens":12345678902', '"totalTokens":-1e999'));
      }
      files.push(file);
    }
    const observer = path.join(directory, "telemetry.mjs");
    writeFileSync(observer, `import assert from "node:assert/strict";
export default function(pi) {
  const files = ${JSON.stringify(files)};
  pi.registerCommand("fixture-telemetry-switch", {description:"Select public saved telemetry history",handler:async(args,ctx)=>{
    const file=files[Number(args)]; assert.ok(file); assert.equal((await ctx.switchSession(file)).cancelled,false);
  }});
  pi.registerCommand("fixture-telemetry-observe", {description:"Observe actual public branch usage",handler:async(args,ctx)=>{
    const totals=ctx.sessionManager.getBranch().filter(entry=>entry.type === "message" && entry.message.role === "assistant")
      .map(entry=>entry.message.usage.totalTokens);
    assert.equal(totals.length,2);
    const total=totals.reduce((sum,value)=>sum+value,0);
    const kind=Number.isNaN(total)?"nan":total===Infinity?"positive":total===-Infinity?"negative":"finite";
    assert.equal(kind,args);ctx.ui.notify("Observed actual telemetry "+kind,"info");
  }});
}`);
    const env: NodeJS.ProcessEnv = { USERPROFILE: directory.toUpperCase(), APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: directory, TMP: directory, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    assert.equal(env.HOME, undefined, "the actual child uses USERPROFILE for its differently cased home");
    const first = files[0];
    assert.ok(first);
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: project.toLowerCase(), env, cols: 120, rows: 50,
      args: [cliPath, "--model", "display-telemetry/local", "--thinking", "off", "--tools", "read", "--session", first,
        "--session-dir", sessions, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot, "--extension", observer] });
    for (const [index, kind] of inputs.entries()) {
      if (index > 0) await terminal.submitEditorText(`/fixture-telemetry-switch ${index}`, { signal: t.signal });
      const history = await terminal.waitForScreen(screen => screen.includes(`telemetry-history-${kind}`)
        && screen.includes(`Goal started · Telemetry ${kind}`)
        && screen.split("\n").filter(line => /✓ Done · 1s · ↑ .* tokens/u.test(line)).length === 2, { signal: t.signal });
      const receipts = history.split("\n").filter(line => /✓ Done · 1s · ↑ .* tokens/u.test(line)).map(line => line.trim());
      assert.deepEqual(receipts, ["✓ Done · 1s · ↑ 1k tokens", "✓ Done · 1s · ↑ 1M tokens"],
        "source-51: fractional and million-boundary token counts render with their rounded units");
      t.diagnostic(JSON.stringify({ source: "test/Display.test.ts:51#1", kind, receipts }));
      assert.ok(history.includes("~\\project"), "native Windows cwd abbreviates a differently cased USERPROFILE");
      await terminal.submitEditorText(`/fixture-telemetry-observe ${kind}`, { signal: t.signal });
      await terminal.waitForScreen(screen => screen.includes(`Observed actual telemetry ${kind}`), { signal: t.signal });
      const after = terminal.sequence;
      await terminal.submitEditorText("/goal", { signal: t.signal });
      screens[kind] = await terminal.waitForScreen(screen => screen.includes(`Telemetry ${kind}`)
        && screen.includes("Goal paused · 0/20 turns · 0s · 0 tokens"), { signal: t.signal, after });
      terminal.write("\x1b");
      await terminal.waitForScreen(screen => !screen.includes("Resume goal") && screen.includes("❯"), { signal: t.signal });
    }
  } catch (error) { errors.push(error); }
  if (terminal) {
    try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics()); }
    catch (error) { errors.push(error); }
  }
  try { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); }
  catch (error) { errors.push(error); }
  if (errors.length) {
    const report = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-DISP-02-failure-"));
    throwScenarioFailure({ directory: report, message: "DISP-02 native telemetry failed", errors,
      diagnostics: JSON.stringify({ node: process.version, screens, terminal: terminal?.diagnostics() }) });
  }
  t.diagnostic(JSON.stringify({ scenarioId: "DISP-02", piLaunches: 1, tokenThresholds: [999.6, 999999],
    actualGoalUsage: inputs, homeCaseFolding: true, cleanup: "natural",
    unprovedSourceVector: "A Windows process cwd cannot contain NUL or the original ANSI-control path; retain source case pending public-contract review." }));
});
