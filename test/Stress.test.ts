import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { normalizeSubagentRequest, registerSubagentTool } from "../subagents.ts";
import { SubagentThreadRegistry } from "../subagent-lifecycle.ts";
import { runSubagentProcess } from "../subagent-process.ts";

// ---------------------------------------------------------------------------
// Shared harness
// ---------------------------------------------------------------------------

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killSignals = [];
  closed = false;
  closeOnTerminate = true;

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    if (this.closeOnTerminate || signal === "SIGKILL") setImmediate(() => this.close(143));
    return true;
  }

  json(event) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  write(chunk) {
    this.stdout.write(chunk);
  }

  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

function assistantEvent(text = "done", overrides = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "test",
      model: "parent-model",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
      ...overrides,
    },
  };
}

function roleFile({ name, access = "read", tools = "read, grep, find, ls, web_search, source_check, fetch_content, get_search_content" }) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} role`,
    `access: ${access}`,
    `tools: ${tools}`,
    "---",
    "",
    `Act as ${name}.`,
    "",
  ].join("\n");
}

function writeRole(directory, fileName, options) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, fileName), roleFile(options));
}

function tempRoster() {
  const root = mkdtempSync(path.join(os.tmpdir(), "killeros-stress-"));
  const bundled = path.join(root, "bundled");
  const personal = path.join(root, "personal");
  writeRole(bundled, "scout.md", { name: "scout" });
  writeRole(bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
  return { root, bundled, personal };
}

const parentModel = { provider: "test", id: "parent-model", name: "Parent model", reasoning: true };

function toolContext(cwd) {
  return {
    model: parentModel,
    thinkingLevel: "high",
    modelRegistry: { getAvailable: () => [parentModel] },
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: { confirm: async () => true },
  };
}

function createToolHarness(options) {
  let tool;
  registerSubagentTool({ registerTool(value) { tool = value; } }, {
    ...options,
    awaitSpawnCompletion: options?.awaitSpawnCompletion ?? true,
  });
  return tool;
}

/** Child that settles itself: emits one assistant message and closes. */
function settlingChild() {
  const child = new FakeProcess();
  setImmediate(() => {
    child.json(assistantEvent("settled"));
    child.close(0);
  });
  return child;
}

async function execute(tool, params, ctx, signal = new AbortController().signal, updates = []) {
  return tool.execute("stress-test", params, signal, (update) => updates.push(update), ctx);
}

// ---------------------------------------------------------------------------
// A. Process layer: hostile input handling
// ---------------------------------------------------------------------------

test("process assembles JSONL delivered in byte fragments with split multibyte characters", async () => {
  const child = new FakeProcess();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => child,
  });
  const payload = assistantEvent("héllo wörld — 🎉 emoji");
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
  for (let offset = 0; offset < bytes.length; offset += 3) {
    child.write(bytes.subarray(offset, Math.min(offset + 3, bytes.length)));
  }
  child.close(0);
  const result = await handle.result;
  assert.equal(result.status, "complete");
  assert.equal(result.output, "héllo wörld — 🎉 emoji");
  assert.equal(result.usage.turns, 1);
});

test("process accepts CRLF-delimited JSONL", async () => {
  const child = new FakeProcess();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => child,
  });
  child.stdout.write(`${JSON.stringify(assistantEvent("crlf ok"))}\r\n`);
  child.close(0);
  const result = await handle.result;
  assert.equal(result.status, "complete");
  assert.equal(result.output, "crlf ok");
});

test("process settles cancelled when the abort signal is already fired at construction", async () => {
  let spawned = 0;
  const controller = new AbortController();
  controller.abort();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    signal: controller.signal,
    spawnProcess() { spawned += 1; return new FakeProcess(); },
  });
  const result = await handle.result;
  assert.equal(result.status, "cancelled");
  assert.equal(result.terminationReason, "abort");
  assert.equal(spawned, 0);
  await handle.exited;
  assert.equal(handle.hasExited, true);
});

test("process fails a clean exit with no assistant response", async () => {
  const child = new FakeProcess();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => child,
  });
  child.close(0);
  const result = await handle.result;
  assert.equal(result.status, "failed");
  assert.equal(result.terminationReason, "missing_assistant_message");
});

test("process cleans its JSONL spool directory after a huge spooled line", async () => {
  const tmp = os.tmpdir();
  const before = new Set(readdirSync(tmp).filter((entry) => entry.startsWith("killeros-jsonl-")));
  const child = new FakeProcess();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => child,
    retention: { jsonlMemoryBytes: 512 },
  });
  child.stdout.write(Buffer.from(`${JSON.stringify(assistantEvent("x".repeat(20_000)))}\n`, "utf8"));
  child.close(0);
  const result = await handle.result;
  assert.equal(result.status, "complete");
  assert.equal(result.output, "x".repeat(20_000));
  await new Promise((resolve) => setImmediate(resolve));
  const after = new Set(readdirSync(tmp).filter((entry) => entry.startsWith("killeros-jsonl-")));
  assert.deepEqual(after, before);
});

test("process enforces the JSONL line ceiling exactly at the boundary", async () => {
  // Build the smallest valid assistant event whose serialized line is exactly 200 bytes.
  const minimalEvent = (text) => JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 1, output: 1 },
    },
  });
  const padding = 200 - Buffer.byteLength(minimalEvent(""), "utf8");
  assert.ok(padding > 0);
  const exactLine = minimalEvent("x".repeat(padding));
  assert.equal(Buffer.byteLength(exactLine, "utf8"), 200);

  const atLimit = new FakeProcess();
  const ok = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => atLimit,
    limits: { jsonlLineBytes: 200 },
  });
  atLimit.stdout.write(`${exactLine}\n`);
  atLimit.close(0);
  assert.equal((await ok.result).status, "complete");

  const over = new FakeProcess();
  const rejected = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => over,
    limits: { jsonlLineBytes: 200 },
  });
  over.stdout.write(`${exactLine}x\n`);
  over.close(0);
  const result = await rejected.result;
  assert.equal(result.status, "limited");
  assert.equal(result.terminationReason, "jsonl_line_limit");
});

// A2. Host callback failure containment — documents CURRENT behavior.
// Proven in a real child process: a throwing onUpdate escapes as an
// uncaughtException (killing the host) and strands the result promise.
test("a throwing onUpdate cannot crash the host or strand the result", () => {
  const script = `
import { runSubagentProcess } from ${JSON.stringify(pathToFileURL(path.resolve("killeros/subagent-process.ts")).href)};
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
class Fake extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { return true; }
  close(code) { this.stdout.end(); this.stderr.end(); this.emit("close", code); }
}
const child = new Fake();
let calls = 0;
const handle = runSubagentProcess({
  args: ["--mode", "json", "--no-session"],
  cwd: process.cwd(),
  spawnProcess: () => child,
  onUpdate() {
    calls += 1;
    if (calls > 1) throw new Error("host update failure");
  },
});
setTimeout(() => {
  child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", usage: { input: 1, output: 1 } } }) + "\\n");
  child.close(0);
}, 10);
handle.result.then((result) => { console.log("SETTLED", result.status, result.output); process.exit(0); });
setTimeout(() => { console.log("STRANDED"); process.exit(3); }, 500);
`;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "-e", script], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0, `host must survive: ${result.stderr}`);
  assert.match(result.stdout, /SETTLED complete hi/u);
  assert.equal(result.stderr.includes("host update failure"), false);
});

test("a throwing tool update callback cannot fail the task", async () => {
  const roster = tempRoster();
  try {
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess: settlingChild,
    });
    const ctx = toolContext(roster.root);
    let calls = 0;
    const result = await tool.execute("stress-test", { agent: "scout", task: "map" }, new AbortController().signal, () => {
      calls += 1;
      if (calls > 1) throw new Error("tui render failure");
    }, ctx);
    assert.equal(result.details.results[0].status, "complete");
    assert.equal(result.details.threads[0].state, "done");
    assert.equal(result.details.results[0].output, "settled");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B. Registry edges
// ---------------------------------------------------------------------------

test("registry tolerates repeated close, repeated dispose, and pruneClosed(0)", () => {
  const registry = new SubagentThreadRegistry({ createId: () => "t1", now: () => 1_000 });
  const spec = {
    displayName: "scout",
    role: "scout",
    prompt: "map the repo",
    model: "test/parent-model",
    tools: ["read"],
    capabilityBoundary: { filesystem: "read", network: "none", process: "none", childThreads: false },
    session: { id: "killeros-stress-1", directory: path.join(os.tmpdir(), "killeros-stress-session-1") },
  };
  const spawned = registry.spawn(spec);
  registry.begin(spawned.id);
  registry.complete(spawned.id, { result: "done" });
  const closed = registry.close(spawned.id);
  assert.equal(closed.evicted, true);
  assert.equal(registry.close(spawned.id).evicted, true); // idempotent
  assert.equal(registry.inspect(spawned.id).state, "closed");
  assert.equal(registry.pruneClosed(0).length, 1);
  assert.equal(registry.inspect(spawned.id), undefined);
  registry.dispose();
  registry.dispose(); // idempotent
  assert.equal(registry.isDisposed, true);
});

test("registry patch rejects invalid usage atomically without mutating the thread", () => {
  const registry = new SubagentThreadRegistry({ createId: () => "t1" });
  const thread = registry.spawn({
    displayName: "scout",
    role: "scout",
    prompt: "map",
    model: "test/parent-model",
    tools: ["read"],
    capabilityBoundary: { filesystem: "read", network: "none", process: "none", childThreads: false },
    session: { id: "killeros-stress-2", directory: path.join(os.tmpdir(), "killeros-stress-session-2") },
  });
  registry.begin(thread.id);
  assert.throws(() => registry.patch(thread.id, { usage: { turns: -1 } }), /usage\.turns/u);
  assert.throws(() => registry.patch(thread.id, { usage: { totalTokens: Number.NaN } }), /usage\.totalTokens/u);
  const after = registry.inspect(thread.id);
  assert.equal(after.usage.turns, 0);
  assert.equal(after.version, 2); // spawn + begin only
});

test("registry rejects duplicate ids, empty steering, and oversized steering", () => {
  const registry = new SubagentThreadRegistry({ createId: () => "same", maxSteeringMessages: 2, maxSteeringMessageLength: 5 });
  const spec = {
    displayName: "scout",
    role: "scout",
    prompt: "map",
    model: "test/parent-model",
    tools: ["read"],
    capabilityBoundary: { filesystem: "read", network: "none", process: "none", childThreads: false },
    session: { id: "killeros-stress-3", directory: path.join(os.tmpdir(), "killeros-stress-session-3") },
  };
  registry.spawn(spec);
  assert.throws(() => registry.spawn({ ...spec, displayName: "scout-2" }), /Duplicate thread id/u);
  assert.throws(() => registry.steer("same", "   "), /steering message/u);
  assert.throws(() => registry.steer("same", "123456"), /exceeds 5 characters/u);
});

// ---------------------------------------------------------------------------
// C. Normalizer / prepareArguments fuzz
// ---------------------------------------------------------------------------

function isRejected(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

test("prepareArguments strips provider threadId only for spawn shapes and keeps it for actions", () => {
  const roster = tempRoster();
  try {
    const tool = createToolHarness({ bundledAgentsDir: roster.bundled, userAgentsDir: roster.personal });
    const single = tool.prepareArguments({ threadId: "provider-injected", agent: "scout", task: "map" });
    assert.equal(single.agent, "scout");
    assert.equal("threadId" in single, false);
    const parallel = tool.prepareArguments({ threadId: "provider-injected", tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] });
    assert.equal(parallel.tasks.length, 2);
    assert.equal("threadId" in parallel, false);
    const chain = tool.prepareArguments({ threadId: "provider-injected", chain: [{ agent: "scout", task: "a" }] });
    assert.equal(chain.chain.length, 1);
    assert.equal("threadId" in chain, false);
    const steer = tool.prepareArguments({ action: "steer", threadId: "keep-me", message: "go on" });
    assert.equal(steer.threadId, "keep-me");
    const inspect = tool.prepareArguments({ action: "inspect", threadId: "keep-me" });
    assert.equal(inspect.threadId, "keep-me");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("normalizer rejects hostile shapes without crashing", () => {
  for (const bad of [
    { action: "SPAWN", agent: "scout", task: "x" },
    { action: 5 },
    { action: "interrupt", threadId: "t", all: "true" },
    { action: "interrupt", threadId: "t", all: true, extra: 1 },
    { action: "interrupt" },
    { action: "spawn", tasks: [null] },
    { action: "spawn", chain: [{}] },
    { action: "spawn", agent: "scout", task: "x", writerConcurrency: 1 },
    { action: "spawn", tasks: [{ agent: "scout", task: "x" }], writerConcurrency: 1.5 },
    { action: "spawn", tasks: [{ agent: "scout", task: "x" }], writerConcurrency: 0 },
    { action: "spawn", agent: "scout", task: "x", tasks: [{ agent: "scout", task: "y" }] },
    { action: "spawn", agent: "scout", task: "x", chain: [{ agent: "scout", task: "y" }] },
    { action: "list", threadId: "x" },
    { action: "collect" },
    { action: "close" },
    { action: "steer", threadId: "t" },
    { action: "steer", message: "m" },
    { action: "inspect" },
  ]) {
    assert.equal(isRejected(() => normalizeSubagentRequest(bad)), true, JSON.stringify(bad));
  }
  assert.equal(normalizeSubagentRequest({ action: "steer", threadId: "t", message: "m" }).kind, "steer");
  assert.equal(normalizeSubagentRequest({ action: "interrupt", all: true }).kind, "interrupt-all");
});

// ---------------------------------------------------------------------------
// D. Tool execution races
// ---------------------------------------------------------------------------

test("steering storm: 25 rapid steers accept 20, reject the rest explicitly, and deliver the oldest 20", async () => {
  const roster = tempRoster();
  try {
    let processCount = 0;
    let resolveFirst;
    const firstMessage = new Promise((resolve) => { resolveFirst = resolve; });
    const childTasks = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        const child = new FakeProcess();
        childTasks.push(args.at(-1));
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("first handoff", { stopReason: "toolUse" }));
            resolveFirst();
          });
        } else {
          setImmediate(() => {
            child.json(assistantEvent("final handoff"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, new AbortController().signal);
    await firstMessage;
    const started = await execute(tool, { action: "list" }, ctx);
    const threadId = started.details.results[0].id;
    const steers = [];
    for (let index = 1; index <= 25; index += 1) {
      steers.push(execute(tool, { action: "steer", threadId, message: `steer ${index}` }, ctx).catch((error) => error));
    }
    const outcomes = await Promise.all(steers);
    const errors = outcomes.filter((outcome) => outcome instanceof Error);
    assert.equal(errors.length, 5, "steers 21-25 must be rejected explicitly");
    for (const error of errors) assert.match(error.message, /Steering queue is full/u);
    const result = await run;
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === threadId);
    assert.equal(task.status, "complete");
    assert.equal(task.output, "final handoff");
    assert.equal(processCount, 2, "one restart delivers all 20 at once");
    assert.equal(thread.steering.length, 20);
    assert.equal(thread.steering[0].message, "steer 1", "history keeps the oldest");
    assert.equal(thread.steering[19].message, "steer 20");
    const delivered = childTasks.at(-1) ?? "";
    assert.match(delivered, /steer 1/u);
    assert.match(delivered, /steer 20/u);
    assert.equal(delivered.includes("steer 21"), false);
    assert.equal(task.usage.turns, 2, "one turn per run, no double count");
    assert.ok(thread.steering.every((entry) => delivered.includes(entry.message)));
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering a queued thread rejects at 20 pending messages", async () => {
  const roster = tempRoster();
  try {
    let spawned = 0;
    let resolveFirstSpawn;
    const firstSpawn = new Promise((resolve) => { resolveFirstSpawn = resolve; });
    const controller = new AbortController();
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        if (spawned === 1) {
          resolveFirstSpawn(child); // keeps the single writer slot busy
        } else {
          setImmediate(() => {
            child.json(assistantEvent("second done"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, {
      writerConcurrency: 1,
      tasks: [
        { agent: "worker", task: "first" },
        { agent: "worker", task: "second" },
      ],
    }, ctx, controller.signal);
    await firstSpawn;
    const list = await execute(tool, { action: "list" }, ctx);
    const queued = list.details.threads.find((thread) => thread.state === "queued");
    assert.ok(queued, "second task must still be queued");
    for (let index = 1; index <= 20; index += 1) {
      await execute(tool, { action: "steer", threadId: queued.id, message: `queued steer ${index}` }, ctx);
    }
    await assert.rejects(
      execute(tool, { action: "steer", threadId: queued.id, message: "one too many" }, ctx),
      /Steering queue is full/u,
    );
    const after = await execute(tool, { action: "inspect", threadId: queued.id }, ctx);
    const steeredQueued = after.details.threads.find((thread) => thread.id === queued.id);
    assert.equal(steeredQueued.steering.length, 20);
    assert.equal(steeredQueued.steering[0].message, "queued steer 1");
    controller.abort();
    await run;
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering rejects before accepted messages exceed the task-size limit", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    const sentMessages = [];
    const controller = new AbortController();
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message) { sentMessages.push(message); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("first", { stopReason: "toolUse" }));
          resolveFirstMessage();
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    await execute(tool, { agent: "scout", task: "map" }, ctx, controller.signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    let accepted = 0;
    let rejected;
    while (accepted < 20) {
      const outcome = await execute(tool, {
        action: "steer",
        threadId,
        message: `steer-${accepted}-${"x".repeat(1_500)}`,
      }, ctx).catch((error) => error);
      if (outcome instanceof Error) {
        rejected = outcome;
        break;
      }
      accepted += 1;
    }
    assert.ok(accepted > 0 && accepted < 20, "the task-size limit must reject before the message-count cap");
    assert.match(rejected.message, /task limit/u);
    const inspected = await execute(tool, { action: "inspect", threadId }, ctx);
    assert.equal(inspected.details.threads[0].steering.length, accepted, "the rejected message must not enter history");
    controller.abort();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const board = await execute(tool, { action: "list" }, ctx);
      if (board.details.threads[0]?.state === "stopped") break;
    }
    assert.equal(sentMessages.length, 0, "parent abort must suppress the follow-up");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("interrupt-all stops active and queued children", async () => {
  const roster = tempRoster();
  try {
    let spawned = 0;
    let resolveFirstSpawn;
    const firstSpawn = new Promise((resolve) => { resolveFirstSpawn = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        if (spawned === 1) {
          resolveFirstSpawn(child); // stays running, no output
        } else {
          setImmediate(() => {
            child.json(assistantEvent("done later"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, {
      writerConcurrency: 1,
      tasks: [
        { agent: "worker", task: "first" },
        { agent: "worker", task: "second" },
      ],
    }, ctx, new AbortController().signal);
    await firstSpawn; // Only the first child has launched; the second is queued.
    const stopped = await execute(tool, { action: "interrupt", all: true }, ctx);
    assert.match(stopped.content[0].text, /all active and queued child threads/u);
    const result = await run;
    assert.equal(result.details.results[0].status, "cancelled");
    assert.equal(result.details.results[1].status, "cancelled", "queued children must not launch after interrupt all");
    assert.deepEqual(result.details.results.map((entry) => entry.terminationReason), ["interrupt", "interrupt"]);
    assert.deepEqual(result.details.threads.map((thread) => thread.state), ["stopped", "stopped"]);
    assert.equal(spawned, 1, "the queued child must never spawn");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("in-flight guard rejects a second batch that exceeds the thread ceiling", async () => {
  const roster = tempRoster();
  try {
    let resolveFirstSpawn;
    const firstSpawn = new Promise((resolve) => { resolveFirstSpawn = resolve; });
    const controller = new AbortController();
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        resolveFirstSpawn(child);
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const tasks = Array.from({ length: 6 }, (_, index) => ({ agent: "scout", task: `task ${index}` }));
    const first = execute(tool, { tasks }, ctx, controller.signal);
    await firstSpawn;
    await assert.rejects(
      execute(tool, { tasks: [...tasks, { agent: "scout", task: "extra" }] }, ctx),
      /At most 10 child threads may be active at once/u,
    );
    const second = execute(tool, { tasks: tasks.slice(0, 2) }, ctx, controller.signal);
    controller.abort();
    const secondResult = await second;
    assert.equal(secondResult.details.results.length, 2);
    await first;
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("abort during a ten-task batch cancels everything without launching more", async () => {
  const roster = tempRoster();
  try {
    let spawned = 0;
    let resolveSecondSpawn;
    const secondSpawn = new Promise((resolve) => { resolveSecondSpawn = resolve; });
    const controller = new AbortController();
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        if (spawned === 1) {
          setImmediate(() => controller.abort());
        } else if (spawned === 2) {
          resolveSecondSpawn(child);
          setImmediate(() => controller.abort());
        }
        return child;
      },
    });
    const tasks = Array.from({ length: 10 }, (_, index) => ({ agent: "scout", task: `task ${index}` }));
    const result = await execute(tool, { tasks }, toolContext(roster.root), controller.signal);
    assert.ok(spawned >= 1 && spawned <= 4, `expected 1-4 spawns before abort, got ${spawned}`);
    assert.ok(result.details.results.every((entry) => entry.status === "cancelled"));
    assert.ok(result.details.results.every((entry) => entry.terminationReason === "abort"));
    assert.ok(result.details.threads.every((thread) => thread.state === "stopped"));
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("chain of ten fails at step four and cancels every later step", async () => {
  const roster = tempRoster();
  try {
    let spawned = 0;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        setImmediate(() => {
          if (spawned === 4) {
            child.stderr.write("boom");
            child.close(1);
          } else {
            child.json(assistantEvent(`output ${spawned}`));
            child.close(0);
          }
        });
        return child;
      },
    });
    const chain = Array.from({ length: 10 }, (_, index) => ({ agent: "scout", task: `step ${index + 1}` }));
    const result = await execute(tool, { chain }, toolContext(roster.root));
    const statuses = result.details.results.map((entry) => entry.status);
    assert.deepEqual(statuses, ["complete", "complete", "complete", "failed", "cancelled", "cancelled", "cancelled", "cancelled", "cancelled", "cancelled"]);
    assert.equal(spawned, 4);
    assert.equal(result.details.results[3].errorMessage, "boom");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("thread actions fail explicitly on impossible states", async () => {
  const roster = tempRoster();
  try {
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess: settlingChild,
    });
    const ctx = toolContext(roster.root);
    const result = await execute(tool, { agent: "scout", task: "quick" }, ctx);
    const threadId = result.details.results[0].id;
    await assert.rejects(execute(tool, { action: "steer", threadId, message: "x" }, ctx), /Cannot change thread/u);
    await assert.rejects(execute(tool, { action: "interrupt", threadId }, ctx), /Cannot interrupt thread/u);
    await assert.rejects(execute(tool, { action: "inspect", threadId: "nope" }, ctx), /Unknown child thread/u);
    const none = await execute(tool, { action: "interrupt", all: true }, ctx);
    assert.match(none.content[0].text, /Interrupt requested/u);

    // A running thread rejects collect and close.
    let resolveSpawn;
    const spawned = new Promise((resolve) => { resolveSpawn = resolve; });
    const controller = new AbortController();
    const runner = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        resolveSpawn(child);
        return child;
      },
    });
    const running = execute(runner, { agent: "scout", task: "slow" }, ctx, controller.signal);
    await spawned;
    const list = await execute(runner, { action: "list" }, ctx);
    const runningId = list.details.results[0].id;
    await assert.rejects(execute(runner, { action: "collect", threadId: runningId }, ctx), /not terminal/u);
    await assert.rejects(execute(runner, { action: "close", threadId: runningId }, ctx), /Cannot close thread/u);
    controller.abort();
    await running;
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("sendMessage failures are contained and the batch still settles", async () => {
  const roster = tempRoster();
  try {
    let tool;
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage() { throw new Error("follow-up channel broken"); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess: settlingChild,
    });
    const started = await execute(tool, { agent: "scout", task: "map" }, toolContext(roster.root));
    const threadId = started.details.results[0].id;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const inspected = await execute(tool, { action: "inspect", threadId }, toolContext(roster.root));
    assert.equal(inspected.details.doneThreads[0].state, "done");
    assert.equal(inspected.details.results[0].output, "settled");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session shutdown settles queued batches as cancelled without follow-ups", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let shutdown;
    const sentMessages = [];
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) { if (event === "session_shutdown") shutdown = callback; },
      sendMessage(message, options) { sentMessages.push({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      limits: { killGraceMs: 10 },
      spawnProcess() {
        const child = new FakeProcess();
        child.closeOnTerminate = false;
        return child;
      },
    });
    const started = await execute(tool, { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }, toolContext(roster.root));
    const threadIds = started.details.results.map((entry) => entry.id);
    await shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sentMessages, []);
    // Shutdown disposes the registry: terminal records are closed into tombstones.
    const board = await execute(tool, { action: "list" }, toolContext(roster.root));
    assert.equal(board.details.results.length, 0);
    const inspected = await execute(tool, { action: "inspect", threadId: threadIds[0] }, toolContext(roster.root));
    const tombstone = inspected.details.threads.find((thread) => thread.id === threadIds[0]);
    assert.equal(tombstone.state, "closed");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session replacement recreates the registry so new spawns work", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let shutdown;
    let start;
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) {
        if (event === "session_shutdown") shutdown = callback;
        if (event === "session_start") start = callback;
      },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess: settlingChild,
    });
    const ctx = toolContext(roster.root);
    const first = await execute(tool, { agent: "scout", task: "before" }, ctx);
    const oldThreadId = first.details.results[0].id;
    await shutdown();
    start();
    const second = await execute(tool, { agent: "scout", task: "after" }, ctx);
    assert.equal(second.details.results[0].status, "queued");
    assert.notEqual(second.details.results[0].id, oldThreadId, "a fresh registry must assign fresh thread ids");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const board = await execute(tool, { action: "list" }, ctx);
    assert.equal(board.details.threads.some((thread) => thread.id === oldThreadId), false, "old-session threads are gone");
    const inspected = await execute(tool, { action: "inspect", threadId: second.details.results[0].id }, ctx);
    assert.equal(inspected.details.doneThreads[0].state, "done");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("abort during a steering restart settles with abort and suppresses the follow-up turn", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    let processCount = 0;
    const sentMessages = [];
    const controller = new AbortController();
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { sentMessages.push({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess() {
        const child = new FakeProcess();
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("first", { stopReason: "toolUse" }));
            resolveFirstMessage();
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, controller.signal);
    assert.equal((await run).details.results[0].status, "queued"); // background mode returns immediately
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "keep going" }, ctx);
    controller.abort();
    let thread;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const board = await execute(tool, { action: "list" }, ctx);
      thread = board.details.threads.find((candidate) => candidate.id === threadId);
      if (thread && thread.state !== "active") break;
    }
    assert.ok(thread, "thread must settle");
    assert.equal(thread.state, "stopped");
    assert.equal(thread.stopReason, "abort");
    const result = await execute(tool, { action: "inspect", threadId }, ctx);
    assert.equal(result.details.results[0].terminationReason, "abort", "result must agree with the thread");
    assert.deepEqual(sentMessages, [], "aborted batch must not trigger a replacement turn");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("abort after child completion still suppresses the follow-up turn", async () => {
  const roster = tempRoster();
  try {
    let tool;
    const controller = new AbortController();
    const sentMessages = [];
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message) { sentMessages.push(message); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("done"));
          child.close(0);
          queueMicrotask(() => controller.abort());
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    await execute(tool, { agent: "scout", task: "finish" }, ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(sentMessages, [], "a parent abort in the completion turn must suppress the follow-up");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("abort during an unconfirmed steering restart settles as abort without a follow-up", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    let processCount = 0;
    const sentMessages = [];
    const controller = new AbortController();
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message) { sentMessages.push(message); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      limits: { killGraceMs: 5, processExitWaitMs: 2_000 },
      spawnProcess() {
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          return true;
        };
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("partial", { stopReason: "toolUse" }));
            resolveFirstMessage();
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    await execute(tool, { agent: "scout", task: "map" }, ctx, controller.signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "keep going" }, ctx);
    setTimeout(() => controller.abort(), 1_100);
    let thread;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const board = await execute(tool, { action: "list" }, ctx);
      thread = board.details.threads.find((candidate) => candidate.id === threadId);
      if (thread && thread.state !== "active") break;
    }
    assert.equal(processCount, 1, "an unconfirmed restart must not launch a replacement child");
    assert.equal(thread.state, "stopped");
    assert.equal(thread.stopReason, "abort");
    const result = await execute(tool, { action: "inspect", threadId }, ctx);
    assert.equal(result.details.results[0].terminationReason, "abort");
    assert.deepEqual(sentMessages, []);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("interrupt during a steering restart settles the thread and preserves partial work", async () => {
  const roster = tempRoster();
  try {
    let processCount = 0;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    let resolveSecondSpawn;
    const secondSpawn = new Promise((resolve) => { resolveSecondSpawn = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("partial work", { stopReason: "toolUse" }));
            resolveFirstMessage();
          });
        } else {
          resolveSecondSpawn(child);
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, new AbortController().signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "continue" }, ctx);
    await secondSpawn; // The restarted child is up but has not produced output yet.
    await execute(tool, { action: "interrupt", threadId }, ctx);
    const result = await run;
    const task = result.details.results[0];
    assert.equal(task.status, "cancelled");
    assert.equal(task.terminationReason, "interrupt");
    assert.equal(task.output, "partial work");
    const board = await execute(tool, { action: "list" }, ctx);
    const thread = board.details.threads.find((candidate) => candidate.id === threadId);
    assert.equal(thread.state, "stopped");
    assert.equal(thread.stopReason, "interrupt");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering restarts keep trace cumulative without double-counting usage", async () => {
  const roster = tempRoster();
  try {
    let processCount = 0;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        processCount += 1;
        setImmediate(() => {
          if (processCount === 1) {
            child.json(assistantEvent("first", {
              stopReason: "toolUse",
              content: [
                { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
                { type: "text", text: "first" },
              ],
            }));
            resolveFirstMessage();
          } else {
            child.json(assistantEvent("second", {
              content: [
                { type: "toolCall", name: "read", arguments: { path: "b.ts" } },
                { type: "text", text: "second" },
              ],
            }));
            child.close(0);
          }
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, new AbortController().signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "continue" }, ctx);
    const result = await run;
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === threadId);
    assert.equal(task.status, "complete");
    assert.equal(task.usage.turns, 2, "one turn per run, no double count");
    assert.equal(task.usage.totalTokens, 36);
    assert.equal(thread.trace.length, 2);
    assert.match(task.trace.join("\n"), /a\.ts/u);
    assert.match(task.trace.join("\n"), /b\.ts/u);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("close on a done thread evicts heavy data and keeps an inspectable tombstone", async () => {
  const roster = tempRoster();
  try {
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess: settlingChild,
    });
    const ctx = toolContext(roster.root);
    const result = await execute(tool, { agent: "scout", task: "quick" }, ctx);
    const threadId = result.details.results[0].id;
    await execute(tool, { action: "close", threadId }, ctx);
    const board = await execute(tool, { action: "list" }, ctx);
    assert.equal(board.details.results.length, 0, "closed threads leave the active board");
    const inspected = await execute(tool, { action: "inspect", threadId }, ctx);
    assert.equal(inspected.details.selectedThreadId, threadId);
    const tombstone = inspected.details.threads.find((thread) => thread.id === threadId);
    assert.equal(tombstone.state, "closed");
    assert.equal(tombstone.evicted, true);
    assert.equal(tombstone.result, undefined);
    assert.equal(tombstone.trace.length, 0);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("concurrent batches receive distinct thread ids and settle independently", async () => {
  const roster = tempRoster();
  try {
    let spawned = 0;
    let resolveFirst;
    const firstSpawn = new Promise((resolve) => { resolveFirst = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        if (spawned === 1) resolveFirst(child);
        setImmediate(() => {
          child.json(assistantEvent(`batch child ${spawned}`));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const runA = execute(tool, { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }] }, ctx, new AbortController().signal);
    await firstSpawn;
    const runB = execute(tool, { tasks: [{ agent: "scout", task: "c" }] }, ctx, new AbortController().signal);
    const [resultA, resultB] = await Promise.all([runA, runB]);
    const idsA = resultA.details.results.map((entry) => entry.id);
    const idsB = resultB.details.results.map((entry) => entry.id);
    assert.equal(new Set([...idsA, ...idsB]).size, 3, "thread ids are unique across batches");
    assert.ok(resultA.details.results.every((entry) => entry.status === "complete"));
    assert.ok(resultB.details.results.every((entry) => entry.status === "complete"));
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E. Post-fix stress tests — hostile probing of the five repairs
// ---------------------------------------------------------------------------

test("post-fix: a throwing onUpdate from the very first publish cannot break the process", async () => {
  const child = new FakeProcess();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => child,
    onUpdate() { throw new Error("always failing host"); },
  });
  child.json(assistantEvent("still works"));
  child.close(0);
  const result = await handle.result;
  assert.equal(result.status, "complete");
  assert.equal(result.output, "still works");
  await handle.exited;
});

test("post-fix: a throwing onUpdate during a stop still settles the cancelled result", async () => {
  const child = new FakeProcess();
  const handle = runSubagentProcess({
    args: ["--mode", "json", "--no-session"],
    cwd: process.cwd(),
    spawnProcess: () => child,
    onUpdate() { throw new Error("failing host"); },
  });
  child.json(assistantEvent("partial", { stopReason: "toolUse" }));
  handle.stop("parent_stop");
  const result = await Promise.race([
    handle.result,
    new Promise((resolve) => setTimeout(() => resolve("HANG"), 2_000)),
  ]);
  assert.notEqual(result, "HANG", "result must resolve despite the throwing callback");
  assert.equal(result.status, "cancelled");
  assert.equal(result.terminationReason, "parent_stop");
  assert.equal(result.output, "partial");
  await handle.exited;
});

test("post-fix: steering works again after the restart drains a full queue", async () => {
  const roster = tempRoster();
  try {
    let processCount = 0;
    let resolveFirst;
    const firstMessage = new Promise((resolve) => { resolveFirst = resolve; });
    let resolveSecondSpawn;
    const secondSpawn = new Promise((resolve) => { resolveSecondSpawn = resolve; });
    const childTasks = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        const child = new FakeProcess();
        childTasks.push(args.at(-1));
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("first handoff", { stopReason: "toolUse" }));
            resolveFirst();
          });
        } else if (processCount === 2) {
          resolveSecondSpawn(child); // silent; killed by the next steer
        } else {
          setImmediate(() => {
            child.json(assistantEvent("final handoff"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, new AbortController().signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    // Fill the queue in one tick, exactly like the storm test.
    const steers = [];
    for (let index = 1; index <= 20; index += 1) {
      steers.push(execute(tool, { action: "steer", threadId, message: `steer ${index}` }, ctx));
    }
    await Promise.all(steers);
    await secondSpawn; // the restart drained steers 1..20 and child 2 is up
    await execute(tool, { action: "steer", threadId, message: "steer 21" }, ctx);
    const result = await run;
    const task = result.details.results[0];
    assert.equal(task.status, "complete");
    assert.equal(processCount, 3, "exactly two restarts");
    assert.match(childTasks[1], /steer 1[\s\S]*steer 20/u);
    assert.match(childTasks[2], /steer 21/u);
    assert.equal(childTasks[2].includes("steer 1"), false, "drained steering is not redelivered");
    assert.equal(task.usage.turns, 2, "only the emitting children count turns");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: steering during a restart window is never lost", async () => {
  const roster = tempRoster();
  try {
    let processCount = 0;
    let resolveFirst;
    const firstMessage = new Promise((resolve) => { resolveFirst = resolve; });
    let resolveSecondSpawn;
    const secondSpawn = new Promise((resolve) => { resolveSecondSpawn = resolve; });
    const childTasks = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        const child = new FakeProcess();
        childTasks.push(args.at(-1));
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("first handoff", { stopReason: "toolUse" }));
            resolveFirst();
          });
        } else if (processCount === 2) {
          resolveSecondSpawn(child); // silent; killed by steer B
        } else {
          setImmediate(() => {
            child.json(assistantEvent("final handoff"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, new AbortController().signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "steer A" }, ctx);
    await secondSpawn; // child 2 is up with steer A delivered
    await execute(tool, { action: "steer", threadId, message: "steer B" }, ctx);
    const result = await run;
    const task = result.details.results[0];
    assert.equal(task.status, "complete");
    assert.equal(processCount, 3);
    assert.match(childTasks[1], /steer A/u);
    assert.match(childTasks[2], /steer B/u);
    assert.equal(childTasks[2].includes("steer A"), false);
    assert.equal(task.usage.turns, 2);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: interrupt-all stops a mixed batch including a fully steered queued thread", async () => {
  const roster = tempRoster();
  try {
    let spawned = 0;
    let resolveFirstSpawn;
    const firstSpawn = new Promise((resolve) => { resolveFirstSpawn = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        if (spawned === 1) {
          resolveFirstSpawn(child); // stays running
        } else {
          setImmediate(() => {
            child.json(assistantEvent("late"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, {
      writerConcurrency: 1,
      tasks: [
        { agent: "worker", task: "first" },
        { agent: "worker", task: "second" },
        { agent: "worker", task: "third" },
      ],
    }, ctx, new AbortController().signal);
    await firstSpawn;
    const list = await execute(tool, { action: "list" }, ctx);
    const queued = list.details.threads.find((thread) => thread.state === "queued");
    assert.ok(queued, "a queued sibling must exist");
    for (let index = 1; index <= 20; index += 1) {
      await execute(tool, { action: "steer", threadId: queued.id, message: `pending ${index}` }, ctx);
    }
    await execute(tool, { action: "interrupt", all: true }, ctx);
    const result = await run;
    assert.deepEqual(result.details.results.map((entry) => entry.status), ["cancelled", "cancelled", "cancelled"]);
    assert.deepEqual(result.details.results.map((entry) => entry.terminationReason), ["interrupt", "interrupt", "interrupt"]);
    assert.equal(spawned, 1, "no queued child may launch after interrupt all");
    const board = await execute(tool, { action: "list" }, ctx);
    const steered = board.details.threads.find((thread) => thread.id === queued.id);
    assert.equal(steered.state, "stopped");
    assert.equal(steered.steering.length, 20, "pending steering history is preserved");
    assert.equal(steered.steering[0].message, "pending 1");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: interrupt-all twice is safe", async () => {
  const roster = tempRoster();
  try {
    let resolveFirstSpawn;
    const firstSpawn = new Promise((resolve) => { resolveFirstSpawn = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        resolveFirstSpawn(child);
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "worker", task: "long" }, ctx, new AbortController().signal);
    await firstSpawn;
    const first = await execute(tool, { action: "interrupt", all: true }, ctx);
    assert.match(first.content[0].text, /all active and queued child threads/u);
    const second = await execute(tool, { action: "interrupt", all: true }, ctx);
    assert.match(second.content[0].text, /all active and queued child threads/u);
    const result = await run;
    assert.equal(result.details.results[0].status, "cancelled");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: three session cycles keep spawning with strictly increasing ids", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let shutdown;
    let start;
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) {
        if (event === "session_shutdown") shutdown = callback;
        if (event === "session_start") start = callback;
      },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess: settlingChild,
    });
    const ctx = toolContext(roster.root);
    const ids = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const spawned = await execute(tool, { agent: "scout", task: `cycle ${cycle}` }, ctx);
      ids.push(spawned.details.results[0].id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (cycle < 2) {
        await shutdown();
        start();
      }
    }
    assert.equal(new Set(ids).size, 3, "ids must be unique across sessions");
    const numbers = ids.map((id) => Number(id.replace("subagent-", "")));
    assert.ok(numbers[0] < numbers[1] && numbers[1] < numbers[2], "ids must keep increasing");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: session_start before any spawn does not break spawning", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let start;
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) { if (event === "session_start") start = callback; },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess: settlingChild,
    });
    start();
    const ctx = toolContext(roster.root);
    const spawned = await execute(tool, { agent: "scout", task: "fresh" }, ctx);
    assert.equal(spawned.details.results[0].status, "queued");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const board = await execute(tool, { action: "list" }, ctx);
    assert.equal(board.details.doneThreads[0].state, "done");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: abort during a steering restart in a parallel batch suppresses the follow-up", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let steerMeChildren = 0;
    const sentMessages = [];
    const controller = new AbortController();
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { sentMessages.push({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess(args) {
        const child = new FakeProcess();
        const task = args.at(-1) ?? "";
        if (task.includes("steer me")) {
          steerMeChildren += 1;
          if (steerMeChildren === 1) {
            setImmediate(() => {
              child.json(assistantEvent("first", { stopReason: "toolUse" }));
            });
          }
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, {
      tasks: [
        { agent: "scout", task: "steer me" },
        { agent: "scout", task: "plain" },
      ],
    }, ctx, controller.signal);
    // Wait for the first child (background mode returns the queued board immediately).
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (steerMeChildren >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(steerMeChildren, 1, "the steered child must be up");
    const list = await execute(tool, { action: "list" }, ctx);
    const steeredThread = list.details.threads.find((thread) => thread.prompt.includes("steer me"));
    assert.ok(steeredThread);
    await execute(tool, { action: "steer", threadId: steeredThread.id, message: "keep going" }, ctx);
    // Wait for the steering restart child to be up.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (steerMeChildren >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(steerMeChildren, 2, "the steering restart must be in flight");
    controller.abort();
    await run; // resolves with the queued board; the batch settles in the background
    let settled;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const board = await execute(tool, { action: "list" }, ctx);
      settled = board.details.threads.filter((thread) => thread.state === "active" || thread.state === "queued");
      if (settled.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled.length, 0, "every thread must settle");
    const board = await execute(tool, { action: "list" }, ctx);
    assert.deepEqual(board.details.results.map((entry) => entry.status), ["cancelled", "cancelled"]);
    assert.deepEqual(board.details.results.map((entry) => entry.terminationReason), ["abort", "abort"]);
    assert.deepEqual(board.details.threads.map((thread) => thread.state), ["stopped", "stopped"]);
    assert.deepEqual(sentMessages, [], "an aborted parallel batch must not trigger a replacement turn");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: a budget limit is not clobbered by pending steering", async () => {
  const roster = tempRoster();
  try {
    let processCount = 0;
    let resolveFirst;
    const firstMessage = new Promise((resolve) => { resolveFirst = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { quotaTokens: 10 },
      spawnProcess() {
        const child = new FakeProcess();
        processCount += 1;
        setImmediate(() => {
          if (processCount === 1) {
            child.json(assistantEvent("cheap", {
              stopReason: "toolUse",
              usage: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            }));
            resolveFirst();
          } else {
            child.json(assistantEvent("expensive")); // 18 tokens > 10 - 6 remaining
            child.close(0);
          }
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map" }, ctx, new AbortController().signal);
    await firstMessage;
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "continue" }, ctx);
    const result = await run;
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === threadId);
    assert.equal(processCount, 2, "limited runs must not restart");
    assert.equal(task.status, "limited");
    assert.equal(task.terminationReason, "quota_tokens", "the budget reason must survive");
    assert.equal(thread.state, "stopped");
    assert.equal(thread.stopReason, "quota_tokens");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: abort after one task completed cancels the rest and suppresses the follow-up", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let quickDone = false;
    const sentMessages = [];
    const controller = new AbortController();
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { sentMessages.push({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess(args) {
        const child = new FakeProcess();
        const task = args.at(-1) ?? "";
        if (task.includes("quick")) {
          setImmediate(() => {
            child.json(assistantEvent("quick done"));
            child.close(0);
            quickDone = true;
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, {
      tasks: [
        { agent: "scout", task: "quick" },
        { agent: "scout", task: "slow" },
      ],
    }, ctx, controller.signal);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (quickDone) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(quickDone, true, "the quick task must finish first");
    controller.abort();
    await run; // background mode: resolves with the queued board
    let unsettled;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const board = await execute(tool, { action: "list" }, ctx);
      unsettled = board.details.threads.filter((thread) => thread.state === "active" || thread.state === "queued");
      if (unsettled.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(unsettled.length, 0, "every thread must settle");
    const board = await execute(tool, { action: "list" }, ctx);
    assert.deepEqual(board.details.results.map((entry) => entry.status), ["complete", "cancelled"]);
    assert.deepEqual(board.details.results.map((entry) => entry.terminationReason), ["completed", "abort"]);
    assert.deepEqual(board.details.threads.map((thread) => thread.state), ["done", "stopped"]);
    assert.deepEqual(sentMessages, [], "any abort in the batch suppresses the replacement turn");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: full lifecycle spawn-steer-interrupt-close-shutdown-start-spawn", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let shutdown;
    let start;
    let spawned = 0;
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) {
        if (event === "session_shutdown") shutdown = callback;
        if (event === "session_start") start = callback;
      },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess() {
        const child = new FakeProcess();
        spawned += 1;
        if (spawned >= 3) {
          setImmediate(() => {
            child.json(assistantEvent("settled"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "life" }, ctx, new AbortController().signal);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawned >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const list = await execute(tool, { action: "list" }, ctx);
    const threadId = list.details.results[0].id;
    await execute(tool, { action: "steer", threadId, message: "keep going" }, ctx);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawned >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(spawned, 2, "the steering restart must be in flight");
    await execute(tool, { action: "interrupt", all: true }, ctx);
    await run; // background mode: resolves with the queued board
    let thread;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const board = await execute(tool, { action: "list" }, ctx);
      thread = board.details.threads.find((candidate) => candidate.id === threadId);
      if (thread && thread.state !== "active") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(thread, "the thread must settle");
    assert.equal(thread.state, "stopped");
    assert.equal(thread.stopReason, "interrupt");
    await execute(tool, { action: "close", threadId }, ctx);
    const board = await execute(tool, { action: "list" }, ctx);
    assert.equal(board.details.results.length, 0, "closed threads leave the board");
    await shutdown();
    start();
    const second = await execute(tool, { agent: "scout", task: "after" }, ctx);
    assert.equal(second.details.results[0].status, "queued");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await execute(tool, { action: "inspect", threadId: second.details.results[0].id }, ctx);
    assert.equal(after.details.doneThreads[0].state, "done");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("post-fix: session_start mid-batch leaves no crash or hang (hypothetical host)", async () => {
  const roster = tempRoster();
  try {
    let tool;
    let start;
    let shutdown;
    const sentMessages = [];
    const oldChildren = [];
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) {
        if (event === "session_start") start = callback;
        if (event === "session_shutdown") shutdown = callback;
      },
      sendMessage(message) { sentMessages.push(message); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess(args) {
        const child = new FakeProcess();
        const task = args.at(-1) ?? "";
        if (task.includes("new batch")) {
          setImmediate(() => {
            child.json(assistantEvent("fresh settled"));
            child.close(0);
          });
        } else {
          oldChildren.push(child);
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const controller = new AbortController();
    const oldBatch = execute(tool, { agent: "scout", task: "old batch" }, ctx, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    start(); // A host firing session_start without a settled shutdown (unsupported in pi).
    const fresh = execute(tool, { agent: "scout", task: "new batch" }, ctx, new AbortController().signal);
    await fresh; // must not hang; background mode returns the queued board
    await new Promise((resolve) => setTimeout(resolve, 50));
    const board = await execute(tool, { action: "list" }, ctx);
    assert.equal(board.details.doneThreads.length, 1, "the fresh batch must settle");
    assert.ok(oldChildren.every((child) => child.killSignals.length >= 1), "session replacement must terminate old children");
    await shutdown();
    const oldResult = await oldBatch; // must not hang or reject
    assert.equal(oldResult.details.results.length, 1, "the old batch board is still returned");
    assert.equal(sentMessages.length, 1, "the fresh session may send its own follow-up");
    assert.match(sentMessages[0].content, /fresh settled/u);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});
