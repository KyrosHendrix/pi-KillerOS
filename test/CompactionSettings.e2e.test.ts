import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const usage = "Usage: /auto-compact [status|on|off|<percent 0-100>]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

// Child-scoped external-I/O controls affect only the owned settings file, never KillerOS or Pi methods.
const adapterSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const root = process.env.COMPACTION_SETTINGS_CONTROL;
const settings = process.env.COMPACTION_SETTINGS_FILE;
const read = fs.readFileSync.bind(fs);
const link = fs.linkSync.bind(fs);
const rename = fs.renameSync.bind(fs);
function publish(file, value) {
  fs.writeFileSync(file + ".tmp", JSON.stringify(value));
  fs.renameSync(file + ".tmp", file);
}
function owned(file) { return typeof file === "string" && path.resolve(file).toLowerCase() === settings.toLowerCase(); }
fs.linkSync = function(source, destination) {
  if (typeof destination === "string" && owned(destination.slice(0, -5)) && destination.endsWith(".lock")) {
    const plan = JSON.parse(read(path.join(root, "plan.json"), "utf8"));
    if (plan.round) publish(path.join(root, plan.round + ".attempt"), { pid: process.pid, operation: "linkSync" });
  }
  return link(source, destination);
};
fs.renameSync = function(source, destination) {
  if (owned(destination)) {
    const plan = JSON.parse(read(path.join(root, "plan.json"), "utf8"));
    if (plan.fault === "rename") {
      publish(path.join(root, "fault-ack.json"), { pid: process.pid, operation: "renameSync", destination });
      throw new Error("disk full");
    }
  }
  return rename(source, destination);
};
fs.readFileSync = function(file, ...args) {
  const plan = owned(file) ? JSON.parse(read(path.join(root, "plan.json"), "utf8")) : {};
  if (plan.fault === "read") {
    publish(path.join(root, "fault-ack.json"), { pid: process.pid, operation: "readFileSync", file });
    throw new Error("bad\x1b[31m file");
  }
  if (owned(file) && fs.existsSync(settings + ".lock")) {
    const lock = JSON.parse(read(settings + ".lock", "utf8"));
    if (lock.pid === process.pid && plan.round && plan.hold) {
      publish(path.join(root, plan.round + ".acquired"), { pid: process.pid, operation: "readFileSync", lockPid: lock.pid });
      const deadline = Date.now() + 20000;
      while (!fs.existsSync(path.join(root, plan.round + ".release"))) {
        if (Date.now() >= deadline) throw new Error("Owned settings lock release deadline exceeded");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }
  return read(file, ...args);
};
syncBuiltinESMExports();
export default function() {}
`;

async function waitForFile(file: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const finish = (error?: unknown): void => {
      clearTimeout(timer);
      watcher.close();
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error instanceof Error ? error : new Error("Settings barrier failed", { cause: error }));
    };
    const check = (): void => {
      if (!existsSync(file)) return;
      try {
        const contents = record(JSON.parse(readFileSync(file, "utf8")));
        assert.ok(Number.isSafeInteger(contents.pid));
        finish();
        resolve(contents);
      } catch (error) { finish(error); }
    };
    const abort = (): void => finish(signal.reason);
    const watcher = watch(path.dirname(file), check);
    watcher.on("error", finish);
    const timer = setTimeout(() => finish(new Error(`Settings barrier timeout: ${file}`)), 15_000);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

async function createFixture(t: TestContext, id: string) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), ".killeros-compaction-settings-")));
  const agent = path.join(directory, "agent");
  mkdirSync(agent);
  const settings = path.join(agent, "killeros.json");
  const processes: PiRpcProcess[] = [];
  const terminals: PiTerminalProcess[] = [];
  const requests: string[] = [];
  const faults: unknown[] = [];
  const diagnostics: unknown[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("error", (error) => faults.push(error));
    response.writeHead(503, { connection: "close" });
    response.end("Compaction settings commands must never call a provider");
  });
  try {
    for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false,
        "Settings fixtures must not discover an ancestor Git repository");
      if (path.dirname(ancestor) === ancestor) break;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: false },
      compaction: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "compaction-settings": {
      api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-fixture",
      models: [{ id: "local", name: "settings local", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
  } catch (error) {
    server.close();
    await removeDirectoryEventually(directory);
    throw error;
  }
  const env: NodeJS.ProcessEnv = { PATH: path.dirname(process.execPath), HOME: directory, USERPROFILE: directory,
    TEMP: directory, TMP: directory, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) env[key] = inherited.get(key.toLowerCase());
  return {
    directory, settings, diagnostics,
    async start(label: string, adapter = false) {
      const project = path.join(directory, label);
      mkdirSync(project);
      const adapterFile = path.join(project, "adapter.mjs");
      writeFileSync(path.join(project, "plan.json"), "{}");
      if (adapter) writeFileSync(adapterFile, adapterSource);
      const rpc = new PiRpcProcess({ cliPath, cwd: project,
        env: { ...env, HOME: project, USERPROFILE: project, TEMP: project, TMP: project,
          COMPACTION_SETTINGS_CONTROL: project, COMPACTION_SETTINGS_FILE: settings },
        args: ["--mode", "rpc", "--model", "compaction-settings/local", "--thinking", "off", "--no-tools",
          "--session", path.join(project, "session.jsonl"), "--offline", "--approve", "--no-context-files", "--no-skills",
          "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
          ...(adapter ? ["--extension", adapterFile] : []), "--extension", repositoryRoot] });
      processes.push(rpc);
      const commands = record((await rpc.command("get_commands", {}, { signal: t.signal, timeoutMs: 30_000 })).data);
      assert.ok(Array.isArray(commands.commands) && commands.commands.some((value) => record(value).name === "auto-compact"));
      rpc.acknowledge(rpc.currentSequence);
      return { rpc, project };
    },
    async startTerminal() {
      const project = path.join(directory, "terminal");
      mkdirSync(project);
      const terminal = new PiTerminalProcess({ file: process.execPath, cwd: project,
        env: { ...env, HOME: project, USERPROFILE: project, TEMP: project, TMP: project }, cols: 120, rows: 30,
        args: [cliPath, "--model", "compaction-settings/local", "--thinking", "off", "--no-tools",
          "--session", path.join(project, "session.jsonl"), "--offline", "--approve", "--no-context-files", "--no-skills",
          "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot] });
      terminals.push(terminal);
      await terminal.waitForScreen((screen) => screen.includes("KillerOS"), { signal: t.signal });
      return terminal;
    },
    async command(rpc: PiRpcProcess, argument: string, expected: string | RegExp, notifyType = "info") {
      const after = rpc.currentSequence;
      const response = await rpc.command("prompt", { message: `/auto-compact ${argument}` }, { signal: t.signal });
      assert.equal(record(response.data).disposition, "handled", "The slash command starts no agent run");
      const notices: Record<string, unknown>[] = [];
      const through = rpc.currentSequence;
      let cursor = after;
      while (cursor < through) {
        const stored = await rpc.waitForRecord(() => true, { after: cursor, signal: t.signal });
        cursor = stored.sequence;
        assert.notEqual(stored.value.type, "agent_start", "A settings command must not start an agent");
        if (stored.value.type === "extension_ui_request" && stored.value.method === "notify") notices.push(stored.value);
      }
      assert.equal(notices.length, 1, "Each command emits exactly one outcome notification");
      const notice = notices[0];
      assert.ok(notice);
      assert.equal(notice.notifyType, notifyType);
      if (typeof expected === "string") assert.equal(notice.message, expected);
      else { assert.equal(typeof notice.message, "string"); assert.match(String(notice.message), expected); }
      diagnostics.push({ argument, notice });
      rpc.acknowledge(rpc.currentSequence);
    },
    async finish(failure?: unknown) {
      const errors: unknown[] = failure === undefined ? [] : [failure];
      for (const rpc of processes) {
        diagnostics.push(JSON.parse(rpc.diagnostics()));
        try {
          const state = record((await rpc.command("get_state", {}, { signal: t.signal })).data);
          assert.equal(state.isStreaming, false);
          assert.equal(state.isCompacting, false);
          assert.equal(state.pendingMessageCount, 0);
          const entries = record((await rpc.command("get_entries", {}, { signal: t.signal })).data);
          assert.ok(Array.isArray(entries.entries));
          assert.ok(entries.entries.every((value) => !["compaction", "message"].includes(String(record(value).type))),
            "Commands must not append assistant messages or compaction entries");
        } catch (error) { errors.push(error); }
        try { assert.deepEqual(await rpc.close(), { exit: { code: 0, signal: null }, forced: false }); }
        catch (error) { errors.push(error); }
      }
      for (const terminal of terminals) {
        diagnostics.push(JSON.parse(terminal.diagnostics()));
        try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }); }
        catch (error) { errors.push(error); }
      }
      try {
        await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
        assert.deepEqual(requests, []);
        assert.deepEqual(faults, []);
        assert.equal(existsSync(settings + ".lock"), false);
      } catch (error) { errors.push(error); }
      if (errors.length) throwScenarioFailure({ directory, message: `${id} failed`, errors, diagnostics: JSON.stringify(diagnostics) });
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false);
      t.diagnostic(JSON.stringify({ scenarioId: id, piLaunches: processes.length + terminals.length, providerRequests: requests.length,
        naturalExits: processes.length + terminals.length, rpcProcesses: processes.length, terminalProcesses: terminals.length, cleanup: "complete" }));
    },
  };
}

// Catalog ID: compaction-settings-rpc-lifecycle.
test("RPC /auto-compact status, updates, normalization, and settings failure preservation", { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(t, "compaction-settings-rpc-lifecycle");
  let failure: unknown;
  try {
    assert.equal(existsSync(fixture.settings), false, "The original settings file starts absent");
    const terminal = await fixture.startTerminal();
    assert.equal(existsSync(fixture.settings), false, "Native startup must leave settings absent before the first write");
    let after = terminal.sequence;
    await terminal.submitEditorText("/notification", { signal: t.signal });
    await terminal.waitForScreen((screen) => screen.includes("Completion sound") && screen.includes("Off ← current"),
      { after, signal: t.signal });
    after = terminal.sequence;
    terminal.write("\r");
    await terminal.waitForScreen((screen) => screen.includes("Completion sound: On"), { after, signal: t.signal });
    assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), { completionSound: true },
      "Selecting On creates the absent file with exactly the first field");
    for (const { command, notice, enabled } of [
      { command: "/auto-compact 22", notice: "Automatic compaction threshold: 22% remaining (on)", enabled: true },
      { command: "/auto-compact off", notice: "Automatic compaction: off (threshold 22%)", enabled: false },
    ]) {
      after = terminal.sequence;
      await terminal.submitEditorText(command, { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes(notice), { after, signal: t.signal });
      assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), {
        completionSound: true, autoCompaction: { enabled, percentRemaining: 22 },
      }, "Public updates preserve the first write and persist exactly two fields");
    }
    const terminalSession = path.join(fixture.directory, "terminal", "session.jsonl");
    const terminalEntries = (existsSync(terminalSession) ? readFileSync(terminalSession, "utf8") : "")
      .trim().split("\n").filter(Boolean).map((line) => record(JSON.parse(line)));
    assert.ok(terminalEntries.every((entry) => !["message", "compaction"].includes(String(entry.type))),
      "Native settings commands are handled without an agent turn or compaction");
    fixture.diagnostics.push({ history: "absent-settings-first-and-later-write", commands: 3, providerRequests: 0 });
    const retained = { completionSound: true, handoffMaxTokens: 4096, futureSetting: { retained: "exactly" } };
    const seed = (autoCompaction: unknown): void => writeFileSync(fixture.settings, JSON.stringify({ ...retained, autoCompaction }));
    seed({ enabled: true, percentRemaining: 12.5 });
    const { rpc, project } = await fixture.start("lifecycle", true);
    for (const argument of ["", " status "]) await fixture.command(rpc, argument, "Automatic compaction: on at 12.5% remaining");
    seed({ enabled: true, percentRemaining: 15 });
    for (const argument of ["  ", " status "]) await fixture.command(rpc, argument, "Automatic compaction: on at 15% remaining");
    seed({ enabled: false, percentRemaining: 15 });
    await fixture.command(rpc, "status", "Automatic compaction: off (threshold 15%)");
    seed({ enabled: true, percentRemaining: 12.5 });
    const mutations = [
      { argument: " off ", enabled: false, percentRemaining: 12.5, notice: "Automatic compaction: off (threshold 12.5%)" },
      { argument: "20", enabled: false, percentRemaining: 20, notice: "Automatic compaction threshold: 20% remaining (off)" },
      { argument: "on", enabled: true, percentRemaining: 20, notice: "Automatic compaction: on at 20% remaining" },
      { argument: "00", enabled: true, percentRemaining: 0, notice: "Automatic compaction threshold: 0% remaining (on)" },
      { argument: "15", enabled: true, percentRemaining: 15, notice: "Automatic compaction threshold: 15% remaining (on)" },
      { argument: "100", enabled: true, percentRemaining: 100, notice: "Automatic compaction threshold: 100% remaining (on)" },
    ];
    for (const { argument, enabled, percentRemaining, notice } of mutations) {
      await fixture.command(rpc, argument, notice);
      assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), { ...retained, autoCompaction: { enabled, percentRemaining } });
    }
    for (const invalid of [undefined, { enabled: "yes", percentRemaining: 200 }, { enabled: "yes", percentRemaining: 900 }]) {
      seed(invalid);
      await fixture.command(rpc, "status", "Automatic compaction: on at 15% remaining");
      await fixture.command(rpc, "off", "Automatic compaction: off (threshold 15%)");
      assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), { ...retained, autoCompaction: { enabled: false, percentRemaining: 15 } });
    }
    seed({ enabled: false, percentRemaining: 22 });
    await fixture.command(rpc, "status", "Automatic compaction: off (threshold 22%)");
    seed({ enabled: "yes", percentRemaining: 900 });
    await fixture.command(rpc, "20", "Automatic compaction threshold: 20% remaining (on)");
    assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), {
      ...retained, autoCompaction: { enabled: true, percentRemaining: 20 },
    });
    for (const argument of ["-1", "101", "1.5", "1e1", "+10", "10%", "10 now", "ON", "unknown"]) {
      const before = readFileSync(fixture.settings, "utf8");
      await fixture.command(rpc, argument, usage, "error");
      assert.equal(readFileSync(fixture.settings, "utf8"), before, `${argument} must leave the file byte-identical`);
    }
    writeFileSync(fixture.settings, "{malformed");
    await fixture.command(rpc, "status", /^Automatic compaction setting could not be read:/u, "error");
    await fixture.command(rpc, "off", /^Automatic compaction setting could not be saved:/u, "error");
    assert.equal(readFileSync(fixture.settings, "utf8"), "{malformed");
    seed({ enabled: true, percentRemaining: 15 });
    const before = readFileSync(fixture.settings, "utf8");
    const planPath = path.join(project, "plan.json");
    try {
      writeFileSync(planPath, JSON.stringify({ fault: "read" }));
      await fixture.command(rpc, "status", "Automatic compaction setting could not be read: bad file", "error");
      const readFault = record(JSON.parse(readFileSync(path.join(project, "fault-ack.json"), "utf8")));
      assert.equal(readFault.operation, "readFileSync");
      assert.equal(readFault.file, fixture.settings);
      assert.equal(readFileSync(fixture.settings, "utf8"), before);
      writeFileSync(planPath, JSON.stringify({ fault: "rename" }));
      await fixture.command(rpc, "off", "Automatic compaction setting could not be saved: disk full", "error");
      const writeFault = record(JSON.parse(readFileSync(path.join(project, "fault-ack.json"), "utf8")));
      assert.equal(writeFault.operation, "renameSync");
      assert.equal(writeFault.destination, fixture.settings);
      assert.equal(readFileSync(fixture.settings, "utf8"), before, "An acknowledged failed replacement must preserve original bytes");
    } finally { writeFileSync(planPath, "{}"); }
    chmodSync(fixture.settings, 0o444);
    try { await fixture.command(rpc, "off", /^Automatic compaction setting could not be saved:/u, "error"); }
    finally { chmodSync(fixture.settings, 0o666); }
    assert.equal(readFileSync(fixture.settings, "utf8"), before);

    for (const { command, expected, enabled, percentRemaining } of [
      { command: "/auto-compact", expected: "Automatic compaction: on at 15% remaining", enabled: true, percentRemaining: 15 },
      { command: "/auto-compact status", expected: "Automatic compaction: on at 16% remaining", enabled: true, percentRemaining: 16 },
      { command: "/auto-compact status", expected: "Automatic compaction: off (threshold 15%)", enabled: false, percentRemaining: 15 },
    ]) {
      seed({ enabled, percentRemaining });
      const unchanged = readFileSync(fixture.settings, "utf8");
      const after = terminal.sequence;
      await terminal.submitEditorText(command, { signal: t.signal });
      // Every result differs from earlier screens, so an old notification cannot satisfy the wait.
      const screen = await terminal.waitForScreen((value) => value.includes(expected), { after, signal: t.signal });
      assert.ok(screen.includes(expected), "TUI status comes through native terminal command dispatch");
      assert.equal(readFileSync(fixture.settings, "utf8"), unchanged, "TUI status commands are read-only");
      fixture.diagnostics.push({ mode: "tui", command, expected });
    }
    assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), {
      ...retained, autoCompaction: { enabled: false, percentRemaining: 15 },
    });
  } catch (error) { failure = error; }
  await fixture.finish(failure);
});

// Catalog ID: compaction-settings-concurrent-writers.
test("Two Pi writers preserve independently changed auto-compaction fields under the settings lock", { timeout: 90_000 }, async (t) => {
  const fixture = await createFixture(t, "compaction-settings-concurrent-writers");
  const releases: string[] = [];
  let failure: unknown;
  try {
    const initial = { futureSetting: "keep", autoCompaction: { enabled: true, percentRemaining: 15 } };
    writeFileSync(fixture.settings, JSON.stringify(initial));
    const a = await fixture.start("A", true);
    const b = await fixture.start("B", true);
    const orders = [
      [{ argument: "off", notice: "Automatic compaction: off (threshold 15%)" },
        { argument: "70", notice: "Automatic compaction threshold: 70% remaining (off)" }],
      [{ argument: "70", notice: "Automatic compaction threshold: 70% remaining (on)" },
        { argument: "off", notice: "Automatic compaction: off (threshold 70%)" }],
    ] as const;
    for (const [identity, [first, second]] of [[a, b], [b, a]].entries()) {
      for (const [order, [firstCommand, secondCommand]] of orders.entries()) {
        assert.ok(first && second);
        const round = `round-${identity}-${order}`;
        writeFileSync(fixture.settings, JSON.stringify(initial));
        for (const [owner, hold] of [[first, true], [second, false]] as const) {
          writeFileSync(path.join(owner.project, "plan.json"), JSON.stringify({ round, hold }));
        }
        const release = path.join(first.project, round + ".release");
        releases.push(release);
        const firstDone = fixture.command(first.rpc, firstCommand.argument, firstCommand.notice);
        // Attach handlers immediately so an unexpected early command failure cannot become unhandled.
        const firstOutcome = firstDone.then(() => undefined, (error: unknown) => error);
        try {
          const acquired = await waitForFile(path.join(first.project, round + ".acquired"), t.signal);
          assert.equal(acquired.pid, acquired.lockPid);
          assert.equal(acquired.operation, "readFileSync");
          const secondDone = fixture.command(second.rpc, secondCommand.argument, secondCommand.notice);
          const secondOutcome = secondDone.then(() => undefined, (error: unknown) => error);
          try {
            const attempted = await waitForFile(path.join(second.project, round + ".attempt"), t.signal);
            assert.notEqual(attempted.pid, acquired.pid, "Independent Pi processes contend for the same file");
            writeFileSync(release, "release");
          } finally { if (!existsSync(release)) writeFileSync(release, "release"); }
          const secondError = await secondOutcome;
          if (secondError !== undefined) throw secondError instanceof Error ? secondError : new Error("Second writer failed", { cause: secondError });
        } finally { if (!existsSync(release)) writeFileSync(release, "release"); }
        const firstError = await firstOutcome;
        if (firstError !== undefined) throw firstError instanceof Error ? firstError : new Error("First writer failed", { cause: firstError });
        assert.deepEqual(JSON.parse(readFileSync(fixture.settings, "utf8")), {
          futureSetting: "keep", autoCompaction: { enabled: false, percentRemaining: 70 },
        }, `Process order ${identity}, command order ${firstCommand.argument}->${secondCommand.argument} preserves both field updates`);
      }
    }
  } catch (error) { failure = error; }
  finally { for (const release of releases) if (!existsSync(release)) writeFileSync(release, "release"); }
  await fixture.finish(failure);
});
