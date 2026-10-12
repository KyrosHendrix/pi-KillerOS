import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./ExtensionTestHarness.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const terminalDriver = new URL("./support/PiTerminalProcess.ts", import.meta.url).href;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const driverVersions = Object.fromEntries(["zigpty", "@xterm/headless"].map((name) => {
  const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules", name, "package.json"), "utf8"));
  assert.ok(isRecord(manifest) && typeof manifest.version === "string");
  return [name, manifest.version];
}));

for (const fault of ["missing-cli", "early-assertion", "kill-throws"] as const) {
  test(fault === "kill-throws"
    ? "terminal driver reports kill-throws and confirms owned fallback cleanup"
    : `terminal driver reports ${fault} and confirms orderly owned cleanup`, { timeout: 40_000 }, async (t) => {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-terminal-control-"));
    const temporaryDirectory = path.join(directory, "tmp");
    mkdirSync(temporaryDirectory);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: temporaryDirectory, TMP: temporaryDirectory };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    env.PATH = path.dirname(process.execPath);
    const script = path.join(directory, "control.mjs");
    const childSource = [
      "if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);",
      "process.stdin.setRawMode(true); process.stdin.setEncoding('utf8');",
      fault === "kill-throws"
        ? "process.stdin.on('data', data => { if (data.length) process.stdout.write('CONTROL_IGNORED\\r\\n'); });"
        : "process.stdin.on('data', data => { if (data.includes('\\x04')) { process.stdout.write('CONTROL_CLOSED\\r\\n'); process.stdin.pause(); } });",
      "process.stdout.write('CONTROL_READY\\r\\n');",
    ].join("\n");
    writeFileSync(script, `
import assert from 'node:assert/strict';
import { PiTerminalProcess } from ${JSON.stringify(terminalDriver)};
const fault = ${JSON.stringify(fault)};
const terminal = new PiTerminalProcess({ file: process.execPath,
  args: fault === 'missing-cli' ? [${JSON.stringify(path.join(directory, "missing-pi-cli.js"))}] : ['-e', ${JSON.stringify(childSource)}],
  cwd: ${JSON.stringify(directory)}, env: process.env });
const pty = terminal.pty;
const originalKill = pty.kill.bind(pty);
const originalClose = pty.close.bind(pty);
let killCalls = 0;
let ownedCloseCalls = 0;
if (fault === 'kill-throws') {
  pty.kill = signal => { killCalls++; throw new Error('injected terminal SIGKILL failure'); };
  pty.close = () => { ownedCloseCalls++; originalClose(); };
}
let primaryFailure;
let cleanupFailure;
let fallbackFailure;
let cleanup;
let activeScreen;
let liveBeforeFallback;
let closeCallsBeforeFallback;
let fallbackExit;
try {
  if (fault === 'kill-throws') {
    activeScreen = await terminal.waitForScreen(screen => screen.includes('CONTROL_READY'), { signal: AbortSignal.timeout(10000) });
    cleanup = await terminal.close();
  } else {
    activeScreen = await terminal.waitForScreen(screen => screen.includes('CONTROL_READY'), { signal: AbortSignal.timeout(10000) });
    assert.fail('intentional early terminal assertion failure');
  }
} catch (error) {
  if (fault === 'kill-throws') cleanupFailure = error instanceof Error ? error.message : String(error);
  else primaryFailure = error instanceof Error ? error.message : String(error);
}
finally {
  if (fault === 'kill-throws') {
    pty.kill = originalKill;
    closeCallsBeforeFallback = ownedCloseCalls;
    liveBeforeFallback = pty.exitCode === null;
    try {
      pty.close();
      let fallbackTimer;
      try {
        fallbackExit = await Promise.race([pty.exited, new Promise(resolve => { fallbackTimer = setTimeout(() => resolve(undefined), 5000); })]);
      } finally { if (fallbackTimer) clearTimeout(fallbackTimer); }
      if (fallbackExit === undefined) fallbackFailure = 'owned PTY close did not confirm child exit';
    } catch (error) { fallbackFailure = error instanceof Error ? error.message : String(error); }
  } else {
    try { cleanup = await terminal.close(); }
    catch (error) { cleanupFailure = error instanceof Error ? error.message : String(error); }
  }
}
console.log(JSON.stringify({ type: 'terminal_control_result', fault, primaryFailure, cleanupFailure, fallbackFailure, cleanup, activeScreen,
  killCalls, ownedCloseCallsBeforeFallback: closeCallsBeforeFallback, liveBeforeFallback, fallbackExit, diagnostics: terminal.diagnostics() }));
process.exitCode = fault === 'kill-throws' && cleanupFailure === undefined && fallbackFailure === undefined ? 0 : 1;
`);
    // Reuse the existing bounded subprocess owner, not a second process supervisor.
    const processOwner = new PiRpcProcess({ cliPath: script, args: [], cwd: directory, env });
    let succeeded = false;
    let primaryFailure: unknown;
    let terminalResult: PiRpcRecord | undefined;
    const cleanupFailures: unknown[] = [];
    try {
      const result = await processOwner.waitFor((record) => record.type === "terminal_control_result", { signal: t.signal, timeoutMs: 25_000 });
      terminalResult = result;
      const exit = await processOwner.close();
      assert.equal(exit.exit.code, fault === "kill-throws" ? 0 : 1, "The control fixture must report its expected outcome");
      assert.equal(exit.exit.signal, null);
      assert.equal(exit.forced, false, "The control subprocess must exit without forced cleanup");
      assert.equal(result.fault, fault);
      if (fault === "kill-throws") {
        assert.equal(result.cleanupFailure, undefined);
        assert.equal(result.fallbackFailure, undefined);
        assert.equal(result.killCalls, 1);
        assert.equal(result.ownedCloseCallsBeforeFallback, 1, "The driver must use zigpty's owned close fallback");
        assert.equal(result.liveBeforeFallback, false, "The fallback must confirm exit before fixture teardown");
        assert.equal(typeof result.fallbackExit, "number");
        assert.ok(isRecord(result.cleanup));
        assert.equal(result.cleanup.forced, true, "Failed SIGKILL must count as forced cleanup");
        assert.match(String(result.cleanup.failure), /injected terminal SIGKILL failure/u);
      } else {
        assert.equal(result.cleanupFailure, undefined);
        assert.ok(isRecord(result.cleanup));
        assert.equal(result.cleanup.forced, false, "The owned terminal child must exit normally");
        assert.equal(result.cleanup.code, fault === "missing-cli" ? 1 : 0);
        assert.equal(result.cleanup.failure, undefined);
        assert.ok(typeof result.primaryFailure === "string");
      }
      assert.ok(typeof result.diagnostics === "string" && result.diagnostics.length <= 65_536);
      const diagnostics: unknown = JSON.parse(result.diagnostics);
      assert.ok(isRecord(diagnostics));
      if (fault === "kill-throws") {
        assert.ok(isRecord(result.cleanup));
        assert.equal(diagnostics.exitCode, result.cleanup.code);
      } else assert.equal(diagnostics.exitCode, fault === "missing-cli" ? 1 : 0);
      assert.equal(diagnostics.nativeResourcesCreated, process.platform === "win32" ? 2 : 1,
        "Cleanup must track the owned native callbacks, not pass with an empty tracker");
      assert.equal(diagnostics.nativeResources, 0, "Native callbacks must be destroyed before cleanup returns");
      assert.ok(typeof diagnostics.rawBase64 === "string" && diagnostics.rawBase64.length > 0);
      const raw = Buffer.from(diagnostics.rawBase64, "base64").toString("utf8");
      if (fault === "missing-cli") {
        assert.ok(typeof result.primaryFailure === "string");
        assert.match(result.primaryFailure, /Terminal exited before expected screen/u);
        assert.match(raw, /missing-pi-cli\.js/u);
      } else if (fault === "early-assertion") {
        assert.ok(typeof result.primaryFailure === "string");
        assert.match(result.primaryFailure, /intentional early terminal assertion failure/u);
        assert.ok(typeof result.activeScreen === "string" && result.activeScreen.includes("CONTROL_READY"));
        assert.match(raw, /CONTROL_READY/u);
        assert.ok(typeof diagnostics.screen === "string" && diagnostics.screen.includes("CONTROL_CLOSED"),
          "Cleanup must drain the child's final output into the parsed screen before disposal");
      } else {
        assert.ok(typeof result.activeScreen === "string" && result.activeScreen.includes("CONTROL_READY"));
        assert.match(raw, /CONTROL_IGNORED/u);
      }
      succeeded = true;
    } catch (error) { primaryFailure = error; }
    finally {
      try {
        const result = await processOwner.close();
        if (result.forced || result.treeCleanupError) cleanupFailures.push(new Error(`Control cleanup was forced or uncertain: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    if (!succeeded || cleanupFailures.length) {
      t.diagnostic(JSON.stringify({ scenario: `terminal-${fault}`, directory, platform: process.platform, node: process.version,
        driverVersions, executable: process.execPath, sanitizedCliArgs: [script], terminalResult, process: processOwner.diagnostics() }));
      throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures], "Terminal fault control failed");
    }
    await removeDirectoryEventually(directory);
  });
}
