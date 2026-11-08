import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

/** Real RPC UI notifications preserve exact counts and text without replacing the host UI. */
async function recordsSince(pi: PiRpcProcess, after: number): Promise<Record<string, unknown>[]> {
  await pi.command("get_state");
  const through = pi.currentSequence;
  const events: Record<string, unknown>[] = [];
  let cursor = after;
  while (cursor < through) {
    const event = await pi.waitForRecord(() => true, { after: cursor });
    events.push(event.value);
    cursor = event.sequence;
  }
  pi.acknowledge(through);
  return events;
}

function notifications(events: Record<string, unknown>[]) {
  return events.filter(event => event.type === "extension_ui_request" && event.method === "notify")
    .map(event => ({ message: event.message, level: event.notifyType }));
}

/** Runs a hook scenario in a temporary project and agent directory and cleans up every Pi it launched. */
async function withHooks(t: TestContext, scenarioId: string, run: (fixture: {
  project: string;
  config: string;
  command(this: void, source: string, name?: string): string;
  launch(this: void, trusted: boolean): Promise<PiRpcProcess>;
  terminalBlock(this: void, name: string, secret: string): Promise<void>;
  reload(this: void, pi: PiRpcProcess): Promise<Record<string, unknown>[]>;
  write(this: void, pi: PiRpcProcess, name: string, content?: string): Promise<Record<string, unknown>[]>;
}) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-hooks-e2e-"));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const config = path.join(project, ".pi", "killeros-hooks.json");
  for (const folder of [project, agent, path.dirname(config), path.join(directory, "tmp")]) mkdirSync(folder, { recursive: true });
  // Keep receipt scans inside the disposable project instead of the parent checkout.
  execFileSync("git", ["init", "--quiet", project]);
  const probe = path.join(directory, "reload.mjs");
  const mutator = path.join(directory, "mutate-input.mjs");
  const tuiSettlement = path.join(directory, "tui-settled");
  writeFileSync(tuiSettlement, "");
  writeFileSync(mutator, `export default function(pi) {
  pi.on("tool_call", event => {
    if (event.toolName !== "write") return;
    if (event.input.path === "circular-input.txt") {
      const input = {}; input.self = input; event.input = input;
    } else if (event.input.path === "bigint-input.txt") event.input = { value: 1n };
  });
}`);
  writeFileSync(probe, `import { appendFileSync } from "node:fs";
export default function(pi) {
  pi.registerCommand("hooks-reload",{description:"Reload extensions",handler:async(_args,ctx)=>{await ctx.reload();}});
  pi.on("agent_settled", (_event,ctx)=>{
    if(ctx.mode === "tui") appendFileSync(${JSON.stringify(tuiSettlement)}, "idle:"+ctx.isIdle()+" pending:"+ctx.hasPendingMessages()+"\\n");
  });
}`);
  const plans: Array<{ name: string; content: string } | "done"> = [];
  const requests: Record<string, unknown>[] = [];
  const faults: string[] = [];
  const processes: PiRpcProcess[] = [];
  const terminals: PiTerminalProcess[] = [];
  const terminalResults: Awaited<ReturnType<PiTerminalProcess["close"]>>[] = [];
  const results: Awaited<ReturnType<PiRpcProcess["close"]>>[] = [];
  let commands = 0;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer hook-fixture");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes <= 2_097_152);
        chunks.push(Buffer.from(chunk));
      }
      requests.push(record(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      const plan = plans.shift();
      assert.ok(plan, "Every provider request must have a planned response");
      const delta = plan === "done" ? { content: "Hook scenario complete" } : {
        tool_calls: [{ index: 0, id: `write-${requests.length}`, type: "function", function: {
          name: "write", arguments: JSON.stringify({ path: plan.name, content: plan.content }),
        } }],
      };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `hooks-${requests.length}`, model: "local", choices: [
        { index: 0, delta, finish_reason: plan === "done" ? "stop" : "tool_calls" },
      ], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(String(error));
      response.writeHead(500, { connection: "close" });
      response.end("Hook fixture failed");
    });
  });
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(path.join(agent, "killeros.json"), JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 100 } }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "hooks-local": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "hook-fixture",
      models: [{ id: "local", name: "Hooks local", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 20_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) env[key] = inherited.get(key.toLowerCase());
    Object.assign(env, { HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "appdata"),
      LOCALAPPDATA: path.join(directory, "localappdata"), TEMP: path.join(directory, "tmp"), TMP: path.join(directory, "tmp"),
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "empty-gitconfig"), GIT_OPTIONAL_LOCKS: "0" });
    writeFileSync(path.join(directory, "empty-gitconfig"), "");
    const commonArgs = ["--model", "hooks-local/local", "--thinking", "off", "--tools", "write", "--offline",
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
      "--extension", mutator, "--extension", repositoryRoot, "--extension", probe];
    const actorEnvironment = (): NodeJS.ProcessEnv => {
      const actor = path.join(directory, `agent-${processes.length + terminals.length}`);
      cpSync(agent, actor, { recursive: true });
      return { ...env, PI_CODING_AGENT_DIR: actor };
    };
    await run({
      project, config,
      command(source, name = `hook-${++commands}`) {
        const script = path.join(directory, `${name}.cjs`);
        writeFileSync(script, source);
        return `"${process.execPath}" "${script}"`;
      },
      async launch(trusted) {
        const pi = new PiRpcProcess({ cliPath, cwd: project, env: actorEnvironment(), args: ["--mode", "rpc", ...commonArgs,
          "--session", path.join(directory, `session-${processes.length}.jsonl`), trusted ? "--approve" : "--no-approve"] });
        processes.push(pi);
        await pi.command("get_state", {}, { signal: t.signal });
        return pi;
      },
      async terminalBlock(name, secret) {
        const terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env: actorEnvironment(), cols: 120, rows: 40,
          args: [cliPath, ...commonArgs, "--approve", "--session", path.join(directory, "terminal.jsonl")] });
        terminals.push(terminal);
        await terminal.waitForScreen(screen => screen.includes("❯"), { signal: t.signal });
        const before = requests.length;
        const after = terminal.sequence;
        const cancelWatch = new AbortController();
        const signal = AbortSignal.any([t.signal, AbortSignal.timeout(30_000), cancelWatch.signal]);
        const completion = new Promise<void>((resolve, reject) => {
          const watcher = watch(tuiSettlement, () => check());
          const finish = (error?: unknown) => {
            watcher.close();
            clearInterval(poll);
            signal.removeEventListener("abort", abort);
            if (error !== undefined) reject(error instanceof Error ? error : new Error("Settlement observer failed", { cause: error })); else resolve();
          };
          const abort = () => finish(signal.reason);
          const check = () => {
            try { if (readFileSync(tuiSettlement, "utf8").endsWith("\n")) finish(); }
            catch (error) { finish(error); }
          };
          const poll = setInterval(check, 100);
          watcher.on("error", finish);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort(); else check();
        });
        plans.push({ name, content: "test" }, "done");
        let screen = "";
        let operationError: unknown;
        try {
          [screen] = await Promise.all([(async () => {
            await terminal.submitEditorText(`Write ${name}`, { signal: t.signal });
            return await terminal.waitForScreen(value => value.includes("Hook scenario complete") && value.includes("blocked"),
              { signal: t.signal, after, timeoutMs: 30_000 });
          })(), completion]);
        } catch (error) {
          operationError = error;
          throw error instanceof Error ? error : new Error(String(error));
        } finally {
          cancelWatch.abort();
          try { await completion; } catch (cleanupError) {
            if (operationError === undefined) throw cleanupError;
          }
        }
        assert.equal(readFileSync(tuiSettlement, "utf8"), "idle:true pending:false\n",
          "the actual TUI agent_settled event confirms idle state and an empty queue");
        assert.equal(requests.length, before + 2);
        assert.equal(existsSync(path.join(project, name)), false);
        assert.equal(screen.includes(secret), false);
        assert.equal(screen.includes("owned"), false);
        assert.ok(terminal.titles.every(title => !title.includes("owned")));
      },
      async reload(pi) {
        const after = pi.currentSequence;
        await pi.command("prompt", { message: "/hooks-reload" }, { signal: t.signal });
        return await recordsSince(pi, after);
      },
      async write(pi, name, content = "test") {
        const after = pi.currentSequence;
        const before = requests.length;
        plans.push({ name, content }, "done");
        await pi.command("prompt", { message: `Write ${name}` }, { signal: t.signal });
        await pi.waitFor(event => event.type === "agent_settled", { after, timeoutMs: 30_000, signal: t.signal });
        const events = await recordsSince(pi, after);
        assert.equal(requests.length, before + 2, "One write and one final answer must complete");
        const state = record((await pi.command("get_state")).data);
        assert.equal(state.isStreaming, false);
        assert.equal(state.isCompacting, false);
        assert.equal(state.pendingMessageCount, 0);
        return events;
      },
    });
    assert.equal(plans.length, 0);
    assert.deepEqual(faults, []);
  } catch (error) { failure = error; }
  finally {
    for (const pi of processes) {
      try {
        const result = await pi.close();
        results.push(result);
        assert.equal(result.exit.code, 0, pi.diagnostics());
        assert.equal(result.forced, false);
        assert.equal(result.treeCleanupError, undefined);
      } catch (error) { cleanupFailures.push(error); }
    }
    for (const terminal of terminals) {
      try {
        const result = await terminal.close();
        terminalResults.push(result);
        assert.deepEqual(result, { code: 0, forced: false }, terminal.diagnostics());
      } catch (error) { cleanupFailures.push(error); }
    }
    server.closeAllConnections();
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) { cleanupFailures.push(error); }
    if (failure === undefined && cleanupFailures.length === 0) {
      try { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); }
      catch (error) { cleanupFailures.push(error); }
    }
  }
  const counts = { scenarioId, piLaunches: processes.length + terminals.length, providerRequests: requests.length, hookScripts: commands, results, terminalResults };
  if (failure !== undefined || cleanupFailures.length > 0) throwScenarioFailure({ directory,
    message: `${scenarioId} hook scenario failed`, errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
    diagnostics: JSON.stringify({ ...counts, faults, processes: processes.map(pi => pi.diagnostics()),
      terminals: terminals.map(terminal => terminal.diagnostics()), requests: requests.map(request => ({ model: request.model,
        bytes: Buffer.byteLength(JSON.stringify(request)), messages: Array.isArray(request.messages) ? request.messages.length : null })) }, null, 2) });
  t.diagnostic(JSON.stringify({ ...counts, cleanup: "removed" }));
}

// Catalog ID: HK-01.
test("Project hook configuration enforces trust, file identity, size, and schema before execution", {
  timeout: 240_000, skip: piRpcShutdownSkip,
}, async t => withHooks(t, "HK-01", async fixture => {
  const { project, config, command, launch, reload, write } = fixture;
  const marker = path.join(project, "accepted");
  const accepted = command("require('node:fs').writeFileSync('accepted','ran')");
  const valid = { hooks: { tool_call: [{ command: accepted }] } };
  writeFileSync(config, JSON.stringify({ ...valid, goalChecks: { quality: { command: "npm test" } } }));
  const pi = await launch(true);
  await write(pi, "goal-checks.txt");
  assert.equal(readFileSync(marker, "utf8"), "ran");
  unlinkSync(marker);
  let writes = 0;
  async function vector(value: unknown, expected: RegExp, count = 1) {
    writeFileSync(config, JSON.stringify(value));
    const notices = notifications(await reload(pi));
    assert.equal(notices.length, count, `${expected.source}: exact invalid configuration notice count`);
    assert.ok(notices.every(notice => typeof notice.message === "string" && expected.test(notice.message)));
    const events = await write(pi, `config-${++writes}.txt`);
    assert.ok(events.some(event => event.type === "agent_settled"),
      "Each rejected configuration is checked after the native settlement event");
    return notices;
  }
  for (const root of [null, [], "hooks", 1, true]) {
    await vector(root, /Invalid \.pi\/killeros-hooks\.json/u);
    assert.equal(existsSync(marker), false);
  }
  await vector({ unknownRootField: true, hooks: { unknown_event: [{ command: "exit 7" }], tool_call: [
    null, [], "hook", 1, { command: null }, { command: "exit 7", matcher: 1 },
    { command: "exit 7", timeoutMs: "1000" }, { command: accepted, unknownHookField: { future: true } },
  ] } }, /Ignored invalid tool_call hook|timeoutMs/u, 7);
  assert.equal(readFileSync(marker, "utf8"), "ran");
  unlinkSync(marker);
  const shared = path.join(project, "shared-hooks.json");
  writeFileSync(shared, JSON.stringify(valid));
  unlinkSync(config);
  linkSync(shared, config);
  assert.match(String(notifications(await reload(pi)).at(-1)?.message), /regular, non-linked file/u);
  await write(pi, "hardlink.txt");
  assert.equal(existsSync(marker), false);
  unlinkSync(config);
  let fileSymlink = false;
  try {
    symlinkSync(shared, config, "file");
    fileSymlink = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES"))) throw error;
    t.diagnostic(JSON.stringify({ scenarioId: "HK-01", unprovedCatalogVector: "file symlink", capabilityExclusion: error.code }));
  }
  if (fileSymlink) {
    assert.match(String(notifications(await reload(pi)).at(-1)?.message), /real project \.pi directory/u);
    await write(pi, "symlink.txt");
    assert.equal(existsSync(marker), false);
    unlinkSync(config);
  }
  const sharedDirectory = path.join(project, "shared-pi");
  mkdirSync(sharedDirectory);
  writeFileSync(path.join(sharedDirectory, "killeros-hooks.json"), JSON.stringify(valid));
  await removeDirectoryEventually(path.dirname(config));
  symlinkSync(sharedDirectory, path.dirname(config), "junction");
  assert.match(String(notifications(await reload(pi)).at(-1)?.message), /real project \.pi directory/u);
  await write(pi, "junction.txt");
  assert.equal(existsSync(marker), false);
  unlinkSync(path.dirname(config));
  mkdirSync(path.dirname(config));
  const json = JSON.stringify(valid);
  writeFileSync(config, json.padEnd(65_536, " "));
  assert.deepEqual(notifications(await reload(pi)), []);
  await write(pi, "size-accepted.txt");
  assert.equal(readFileSync(marker, "utf8"), "ran");
  unlinkSync(marker);
  writeFileSync(config, json.padEnd(65_537, " "));
  assert.match(String(notifications(await reload(pi)).at(-1)?.message), /exceeds 65536 bytes/u);
  await write(pi, "size-rejected.txt");
  assert.equal(existsSync(marker), false);
  writeFileSync(config, `${json}${" ".repeat(65_536)}`);
  assert.match(String(notifications(await reload(pi)).at(-1)?.message), /exceeds 65536 bytes/u);
  await write(pi, "source-size-rejected.txt");
  assert.equal(existsSync(marker), false);
  const settled = await vector({ hooks: { agent_settled: [{ matcher: "^bash$", command: accepted }] } }, /matchers are only valid for tool events/u);
  assert.deepEqual(settled, [{ message: "Ignored agent_settled hook 1: matchers are only valid for tool events", level: "warning" }]);
  assert.equal(existsSync(marker), false);
  const rejected = command("require('node:fs').writeFileSync('rejected','ran')");
  await vector({ hooks: { tool_call: [{ command: accepted, timeoutMs: 300_000 }, { command: rejected, timeoutMs: 300_001 }] } },
    /Ignored tool_call hook 2: timeoutMs must be an integer from 1 to 300000/u);
  assert.equal(readFileSync(marker, "utf8"), "ran");
  assert.equal(existsSync(path.join(project, "rejected")), false);
  unlinkSync(marker);
  const secret = "KILLEROS_INLINE_SECRET_9374";
  const failing = `"${process.execPath}" -e "const token='${secret}';process.stderr.write('\\u001b]2;owned\\u0007\\u001b[31mblocked\\u001b[0m\\u0000');process.exit(token?7:0)"`;
  writeFileSync(config, JSON.stringify({ hooks: { tool_call: [{ matcher: "^write$", command: failing, timeoutMs: 5_000 }] } }));
  assert.deepEqual(notifications(await reload(pi)), []);
  const blocked = await write(pi, "blocked.txt");
  assert.equal(existsSync(path.join(project, "blocked.txt")), false);
  assert.deepEqual(notifications(blocked), [{ message: "Hook failed\nblocked", level: "error" }]);
  const result = blocked.find(event => event.type === "tool_execution_end");
  assert.ok(result);
  assert.equal(result.isError, true);
  const content = record(result.result).content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content.map(block => record(block).text), ["Hook failed\nblocked"]);
  assert.equal(JSON.stringify(blocked).includes(secret), false);
  assert.equal(JSON.stringify(blocked).includes(failing), false);
  await fixture.terminalBlock("terminal-blocked.txt", secret);
  writeFileSync(config, JSON.stringify({ hooks: { tool_call: [{ command: accepted }, { command: `"${process.execPath}" -e "process.exit(7)"` }] } }));
  const untrusted = await launch(false);
  assert.match(String(notifications(await recordsSince(untrusted, 0)).at(-1)?.message), /Ignored untrusted project hooks/u);
  await write(untrusted, "untrusted.txt");
  assert.equal(readFileSync(path.join(project, "untrusted.txt"), "utf8"), "test");
  assert.equal(existsSync(marker), false);
}));

// Catalog ID: HK-02.
test("Hook payloads and output remain valid JSON, bounded, and UTF-8 safe", {
  timeout: 120_000, skip: piRpcShutdownSkip,
}, async t => withHooks(t, "HK-02", async ({ project, config, command, launch, reload, write }) => {
  const payloadCommand = command(`const assert=require('node:assert/strict');const fs=require('node:fs');
const value=process.env.KILLEROS_PAYLOAD;const payload=JSON.parse(value);
assert.ok(value.length<=8000);assert.ok(Buffer.byteLength(value,'utf8')<=8000);
assert.equal(payload.truncated,true);assert.equal(typeof payload.preview,'string');
assert.equal(process.env.KILLEROS_EVENT,'tool_call');assert.equal(process.env.KILLEROS_TOOL,'write');
fs.writeFileSync('payload.json',JSON.stringify({value,payload}));`);
  writeFileSync(config, JSON.stringify({ hooks: { tool_call: [{ matcher: "^write$", command: payloadCommand }] } }));
  const pi = await launch(true);
  const events = await write(pi, "large.txt", "x".repeat(9_000));
  assert.deepEqual(notifications(events), []);
  assert.equal(readFileSync(path.join(project, "large.txt"), "utf8"), "x".repeat(9_000));
  const captured = record(JSON.parse(readFileSync(path.join(project, "payload.json"), "utf8")));
  assert.equal(record(captured.payload).truncated, true);
  assert.equal(typeof record(captured.payload).preview, "string");
  assert.ok(typeof captured.value === "string" && Buffer.byteLength(captured.value) <= 8_000);
  const serializationCommand = command(`const assert=require('node:assert/strict');const fs=require('node:fs');
const payload=JSON.parse(process.env.KILLEROS_PAYLOAD);assert.deepEqual(payload,{serializationError:true});
fs.appendFileSync('serialization-results.txt',JSON.stringify(payload)+'\\n');`);
  writeFileSync(config, JSON.stringify({ hooks: { tool_call: [{ matcher: "^write$", command: serializationCommand }] } }));
  assert.deepEqual(notifications(await reload(pi)), []);
  for (const name of ["circular-input.txt", "bigint-input.txt"]) {
    assert.deepEqual(notifications(await write(pi, name)), []);
    assert.equal(readFileSync(path.join(project, name), "utf8"), "test");
  }
  assert.equal(readFileSync(path.join(project, "serialization-results.txt"), "utf8"),
    '{"serializationError":true}\n{"serializationError":true}\n');
  for (const stream of ["stdout", "stderr"] as const) {
    for (const incomplete of [false, true]) {
      const output = command(`const stream=process.${stream};stream.write(Buffer.from([0xf0,0x90]),()=>{
${incomplete ? "process.exitCode=1;" : "setTimeout(()=>stream.write(Buffer.from([0x90,0x80]),()=>{process.exitCode=1;}),30);"}
});`);
      writeFileSync(config, JSON.stringify({ hooks: { tool_call: [{ matcher: "^write$", command: output }] } }));
      assert.deepEqual(notifications(await reload(pi)), []);
      const name = `${stream}-${incomplete}.txt`;
      const notices = notifications(await write(pi, name));
      assert.deepEqual(notices, [{ message: `Hook failed\n${incomplete ? "�" : "\u{10400}"}`, level: "error" }]);
      assert.equal(existsSync(path.join(project, name)), false);
    }
    const bounded = command(`process.${stream}.write('a'.repeat(16384)+'OUTPUT_PAST_LIMIT');process.exitCode=1;`);
    writeFileSync(config, JSON.stringify({ hooks: { tool_call: [{ matcher: "^write$", command: bounded }] } }));
    assert.deepEqual(notifications(await reload(pi)), []);
    const name = `${stream}-bounded.txt`;
    assert.deepEqual(notifications(await write(pi, name)), [{ message: `Hook failed\n${"a".repeat(16_384)}`, level: "error" }]);
    assert.equal(existsSync(path.join(project, name)), false);
  }
}));
