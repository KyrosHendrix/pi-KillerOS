import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_LIMITS,
  childProcessEnvironment,
  discoverAgentRoles,
  normalizeSubagentRequest,
  registerSubagentTool,
  resolveAgentModel,
  tryNormalizeSubagentRequest,
} from "../subagents.ts";

function roleFile({
  name,
  description = `${name} role`,
  access = "read",
  tools = "read, grep, find, ls, web_search, source_check, fetch_content, get_search_content",
  model,
  thinking,
  timeoutMs,
  extra = "",
  prompt = `Act as ${name}.`,
}) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `access: ${access}`,
    `tools: ${tools}`,
    ...(model ? [`model: ${model}`] : []),
    ...(thinking ? [`thinking: ${thinking}`] : []),
    ...(timeoutMs === undefined ? [] : [`timeoutMs: ${timeoutMs}`]),
    ...(extra ? [extra] : []),
    "---",
    "",
    prompt,
    "",
  ].join("\n");
}

function writeRole(directory, fileName, options) {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  writeFileSync(filePath, roleFile(options));
  return filePath;
}

function tempRoster() {
  const root = mkdtempSync(path.join(os.tmpdir(), "killeros-subagents-test-"));
  const bundled = path.join(root, "bundled");
  const personal = path.join(root, "personal");
  mkdirSync(bundled);
  mkdirSync(personal);
  return { root, bundled, personal };
}

const parentModel = {
  provider: "test",
  id: "parent-model",
  name: "Parent model",
  reasoning: true,
};

function modelContext(models = [parentModel]) {
  return {
    model: parentModel,
    thinkingLevel: "high",
    modelRegistry: {
      getAvailable: () => models,
      find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    },
  };
}

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid;
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

function createToolHarness(options) {
  let tool;
  const parentTools = options?.parentTools ?? ["read", "grep", "find", "ls", "bash", "edit", "write", "web_search", "source_check", "fetch_content", "get_search_content"];
  registerSubagentTool({
    getActiveTools: () => parentTools,
    registerTool(value) { tool = value; },
  }, {
    ...options,
    awaitSpawnCompletion: options?.awaitSpawnCompletion ?? true,
  });
  assert.ok(tool);
  return tool;
}

function toolContext(cwd, { trusted = true, confirm = true, models, sessionRoot, sessionId = "parent-session", entries = [] } = {}) {
  return {
    ...modelContext(models),
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: { confirm: async () => confirm },
    ...(sessionRoot ? {
      sessionManager: {
        getSessionDir: () => sessionRoot,
        getSessionId: () => sessionId,
        getEntries: () => entries,
      },
    } : {}),
  };
}

async function execute(tool, params, ctx, signal = new AbortController().signal, updates = []) {
  return tool.execute("subagent-test", params, signal, (update) => updates.push(update), ctx);
}

test("subagent request normalizer rejects conflicting and unrelated fields", () => {
  const invalidRequests = [
    {
      input: { action: "spawn", agent: "worker", task: "inspect", tasks: [{ agent: "worker", task: "inspect" }] },
      error: /exactly one.*spawn/iu,
    },
    {
      input: { action: "spawn", tasks: [{ agent: "worker", task: "inspect" }], chain: [{ agent: "worker", task: "inspect" }] },
      error: /exactly one.*spawn/iu,
    },
    {
      input: { action: "spawn", agent: "worker", task: "inspect", writerConcurrency: 1 },
      error: /writerConcurrency.*parallel/iu,
    },
    {
      input: { action: "list", agent: "worker", task: "inspect" },
      error: /agent.*list|task.*list|unrelated/iu,
    },
    { input: { message: "steer" }, error: /agent.*non-empty string/iu },
    { input: { action: "list", model: "provider/model" }, error: /model.*list/iu },
    { input: { action: "inspect", threadId: "subagent-1", task: "invalid" }, error: /task.*inspect/iu },
    { input: { action: "steer", threadId: "subagent-1", message: "continue", agent: "worker" }, error: /agent.*steer/iu },
    { input: { action: "collect", threadId: "subagent-1", tasks: [] }, error: /tasks.*collect/iu },
    { input: { action: "close", threadId: "subagent-1", message: "invalid" }, error: /message.*steer/iu },
    { input: { action: "interrupt", all: true, threadId: "subagent-1" }, error: /exactly one.*threadId.*all/iu },
    { input: { action: "spawn", agent: "worker" }, error: /task.*non-empty string/iu },
    { input: { action: "spawn", task: "inspect" }, error: /agent.*non-empty string/iu },
    { input: { action: "spawn", tasks: [] }, error: /tasks.*non-empty array/iu },
    { input: { action: "spawn", chain: [] }, error: /chain.*non-empty array/iu },
    { input: { action: "spawn", chain: [{ agent: "worker", task: "inspect" }], writerConcurrency: 1 }, error: /writerConcurrency.*parallel/iu },
    { input: { action: "spawn", agent: "worker", task: "inspect", all: true }, error: /all.*spawn single/iu },
  ];

  for (const testCase of invalidRequests) {
    assert.throws(() => normalizeSubagentRequest(testCase.input), testCase.error);
  }
});

test("subagent request normalizer classifies valid request shapes", () => {
  const validRequests = [
    [{ agent: "worker", task: "inspect" }, "spawn-single"],
    [{ action: "spawn", agent: "worker", task: "inspect" }, "spawn-single"],
    [{ tasks: [{ agent: "worker", task: "inspect" }] }, "spawn-parallel"],
    [{ action: "spawn", tasks: [{ agent: "worker", task: "inspect" }] }, "spawn-parallel"],
    [{ chain: [{ agent: "worker", task: "inspect" }] }, "spawn-chain"],
    [{ action: "spawn", chain: [{ agent: "worker", task: "inspect" }] }, "spawn-chain"],
    [{ action: "list" }, "list"],
    [{ action: "inspect", threadId: "subagent-1" }, "inspect"],
    [{ action: "steer", threadId: "subagent-1", message: "continue" }, "steer"],
    [{ action: "interrupt", threadId: "subagent-1" }, "interrupt-one"],
    [{ action: "interrupt", all: true }, "interrupt-all"],
    [{ action: "collect", threadId: "subagent-1" }, "collect"],
    [{ action: "close", threadId: "subagent-1" }, "close"],
  ];

  for (const [input, kind] of validRequests) {
    assert.equal(normalizeSubagentRequest(input).kind, kind);
  }
  assert.deepEqual(tryNormalizeSubagentRequest({ action: "list", task: "invalid" }).ok, false);
});

test("spawn accepts message as task and validates inline role descriptors", () => {
  const inline = { name: "focused", description: "Inspect the target only.", access: "read", tools: ["read", "grep"] };
  const alias = normalizeSubagentRequest({ action: "spawn", agent: "worker", message: "inspect" });
  assert.equal(alias.kind, "spawn-single");
  assert.equal(alias.input.task, "inspect");
  assert.equal(normalizeSubagentRequest({ agent: "worker", message: "x".repeat(20_000) }).input.task.length, 20_000);
  assert.throws(
    () => normalizeSubagentRequest({ agent: "worker", message: "x".repeat(20_001) }),
    /message.*20000 characters/iu,
  );
  assert.equal(normalizeSubagentRequest({ action: "steer", threadId: "subagent-1", message: "x".repeat(4_000) }).input.message.length, 4_000);
  assert.throws(
    () => normalizeSubagentRequest({ action: "steer", threadId: "subagent-1", message: "x".repeat(4_001) }),
    /message.*4000 characters/iu,
  );
  assert.deepEqual(normalizeSubagentRequest({ agent: inline, task: "inspect" }).input.agent, inline);
  assert.throws(
    () => normalizeSubagentRequest({ agent: { ...inline, extra: true }, task: "inspect" }),
    /extra.*unknown role field/iu,
  );
  assert.throws(
    () => normalizeSubagentRequest({ agent: { ...inline, tools: ["read", "made_up"] }, task: "inspect" }),
    /unknown child tool.*made_up/iu,
  );
  assert.throws(
    () => normalizeSubagentRequest({ agent: { ...inline, access: "read", tools: ["bash"] }, task: "inspect" }),
    /read-only roles cannot use bash/iu,
  );
  assert.throws(
    () => normalizeSubagentRequest({ action: "list", message: "inspect" }),
    /message.*steer/iu,
  );
});

test("subagent schema is a top-level object for strict providers", () => {
  const tool = createToolHarness();
  const schema = JSON.parse(JSON.stringify(tool.parameters));

  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.deepEqual(Object.keys(schema.properties), [
    "action",
    "threadId",
    "name",
    "message",
    "all",
    "timeoutMs",
    "agent",
    "task",
    "tasks",
    "writerConcurrency",
    "chain",
    "model",
    "thinking",
    "agentScope",
  ]);
  assert.equal(schema.properties.tasks.items.type, "object");
  assert.equal(schema.properties.chain.items.type, "object");
  assert.match(tool.description, /debugger, documenter, planner, reviewer, scout, security, tester, worker/u);
  assert.equal(schema.properties.agent.anyOf[1].additionalProperties, false);
});

test("schema accepts named children, wait, and resume", () => {
  const tool = createToolHarness();
  const schema = JSON.parse(JSON.stringify(tool.parameters));
  assert.equal(schema.properties.tasks.items.properties.name.maxLength, 48);
  assert.equal(schema.properties.tasks.items.properties.name.pattern, "^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$");
  assert.equal(normalizeSubagentRequest({ action: "wait", timeoutMs: 100 }).kind, "wait");
  assert.equal(normalizeSubagentRequest({ action: "resume", threadId: "reviewer" }).kind, "resume");
  assert.throws(() => normalizeSubagentRequest({ agent: "scout", task: "map", name: "" }), /name.*non-empty/iu);
  assert.throws(() => normalizeSubagentRequest({ agent: "scout", task: "map", name: "x".repeat(49) }), /name.*match|name.*48/iu);
  assert.throws(() => normalizeSubagentRequest({ action: "wait", threadId: "one", all: true }), /wait.*threadId.*all|cannot combine/iu);
  assert.throws(() => normalizeSubagentRequest({ action: "wait", timeoutMs: 0 }), /timeoutMs.*positive/iu);
  assert.throws(() => normalizeSubagentRequest({ action: "resume" }), /threadId.*non-empty/iu);
});

test("named child arguments use a persistent parent-session directory", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const calls = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        calls.push(args);
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("named output")); child.close(0); });
        return child;
      },
    });
    const result = await execute(tool, { agent: "scout", task: "Map auth", name: "auth-audit" }, toolContext(roster.root, { sessionRoot, sessionId: "parent/one" }));
    const args = calls[0];
    assert.equal(args[args.indexOf("--name") + 1], "auth-audit");
    const directory = args[args.indexOf("--session-dir") + 1];
    assert.match(directory, /killeros-subagents/u);
    assert.equal(existsSync(directory), true);
    assert.equal(result.details.results[0].name, "auth-audit");
    assert.equal(result.details.results[0].attempt, 1);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("empty final assistant content fails with a deterministic reason", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("", { stopReason: "stop" })); child.close(0); });
        return child;
      },
    });
    const result = await execute(tool, { agent: "scout", task: "empty" }, toolContext(roster.root));
    assert.equal(result.details.results[0].status, "failed");
    assert.equal(result.details.results[0].terminationReason, "missing_assistant_message");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("default wall time applies when a role omits timeoutMs", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      limits: { defaultWallTimeMs: 20, processExitWaitMs: 10 },
      spawnProcess() { return new FakeProcess(); },
    });
    const result = await execute(tool, { agent: "scout", task: "wait" }, toolContext(roster.root));
    assert.equal(result.details.results[0].terminationReason, "wall_time_limit");
    assert.equal(result.details.results[0].exitConfirmed, true);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("wait returns a timeout without stopping the child and wakes after completion", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let child;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess() { child = new FakeProcess(); return child; },
    });
    const ctx = toolContext(roster.root);
    const started = await execute(tool, { agent: "scout", task: "wait", name: "waiter" }, ctx);
    const threadId = started.details.results[0].id;
    for (let attempt = 0; attempt < 100 && !child; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(child);
    const timedOut = await execute(tool, { action: "wait", threadId: "waiter", timeoutMs: 1 }, ctx);
    assert.equal(timedOut.details.wait.timedOut, true);
    assert.deepEqual(timedOut.details.wait.pendingThreadIds, [threadId]);
    assert.equal((await execute(tool, { action: "inspect", threadId }, ctx)).details.threads[0].state, "active");
    const settled = execute(tool, { action: "wait", threadId, timeoutMs: 100 }, ctx);
    child.json(assistantEvent("waited"));
    child.close(0);
    const completed = await settled;
    assert.equal(completed.details.wait.timedOut, false);
    assert.deepEqual(completed.details.wait.pendingThreadIds, []);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("resume keeps the child identity and session path while increasing attempt", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const calls = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        calls.push(args);
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent(calls.length === 1 ? "first" : "second")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "resume-parent" });
    const first = await execute(tool, { agent: "scout", task: "first", name: "reviewer" }, ctx);
    const firstThread = first.details.threads.find((thread) => thread.state === "done");
    const resumed = await execute(tool, { action: "resume", threadId: "REVIEWER", task: "Continue review" }, ctx);
    const resumedThread = resumed.details.threads.find((thread) => thread.id === firstThread.id);
    assert.equal(resumed.details.selectedThreadId, firstThread.id);
    assert.equal(resumedThread.displayName, "reviewer");
    assert.equal(resumedThread.attempt, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][calls[0].indexOf("--name") + 1], "reviewer");
    assert.equal(calls[1][calls[1].indexOf("--name") + 1], "reviewer");
    assert.equal(calls[0][calls[0].indexOf("--session-id") + 1], calls[1][calls[1].indexOf("--session-id") + 1]);
    assert.equal(calls[0][calls[0].indexOf("--session-dir") + 1], calls[1][calls[1].indexOf("--session-dir") + 1]);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session hooks persist terminal snapshots and restore them on session start", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  let tool;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const pi = {
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("persisted")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "persist-parent", entries });
    const first = await execute(tool, { agent: "scout", task: "save me", name: "saved-child" }, ctx);
    assert.deepEqual(entries.map((entry) => entry.data.event), ["spawn", "snapshot"]);
    assert.equal(first.details.results[0].output, "persisted");
    const expectedSessionDirectory = path.join(sessionRoot, "killeros-subagents", "persist-parent", first.details.results[0].id);
    assert.equal(entries[0].data.thread.session.directory, expectedSessionDirectory);
    handlers.get("session_start")(undefined, ctx);
    const restored = await execute(tool, { action: "list" }, ctx);
    assert.equal(restored.details.doneThreads[0].displayName, "saved-child");
    assert.equal(restored.details.results[0].output, "persisted");
    assert.equal(restored.details.doneThreads[0].session.directory, expectedSessionDirectory);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("inline roles remain non-resumable after session restore", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  let tool;
  try {
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    const pi = {
      getActiveTools: () => ["read"],
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("inline saved")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "inline-parent", entries });
    const started = await execute(tool, {
      agent: { name: "worker", description: "Inspect one target.", access: "read", tools: ["read"] },
      task: "inspect",
    }, ctx);
    assert.equal(started.details.results[0].agentSource, "inline");
    assert.equal(entries.at(-1).data.result.agentSource, "inline");

    handlers.get("session_start")(undefined, ctx);
    const restored = await execute(tool, { action: "list" }, ctx);
    assert.equal(restored.details.results[0].agentSource, "inline");
    await assert.rejects(
      execute(tool, { action: "resume", threadId: started.details.results[0].id }, ctx),
      /inline role.*cannot be resumed|cannot resume inline role/iu,
    );
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session start ignores malformed custom thread records", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  let tool;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const pi = {
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("saved")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "malformed-parent", entries });
    await execute(tool, { agent: "scout", task: "save me", name: "saved-child" }, ctx);
    const malformed = JSON.parse(JSON.stringify(entries[1]));
    malformed.data.thread.state = "not-a-thread-state";
    entries.splice(0, entries.length, malformed);

    assert.doesNotThrow(() => handlers.get("session_start")(undefined, ctx));
    const restored = await execute(tool, { action: "list" }, ctx);
    assert.deepEqual(restored.details.threads, []);
    assert.deepEqual(restored.details.results, []);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session start ignores malformed persisted results", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  let tool;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const pi = {
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("saved")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "malformed-result-parent", entries });
    await execute(tool, { agent: "scout", task: "save me", name: "saved-child" }, ctx);
    const malformed = JSON.parse(JSON.stringify(entries[1]));
    malformed.data.result.output = { not: "text" };
    entries.splice(0, entries.length, malformed);

    assert.doesNotThrow(() => handlers.get("session_start")(undefined, ctx));
    const restored = await execute(tool, { action: "list" }, ctx);
    assert.deepEqual(restored.details.threads, []);
    assert.deepEqual(restored.details.results, []);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session start ignores a persisted child session path outside the parent session", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  let tool;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const pi = {
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("saved")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "safe-parent", entries });
    await execute(tool, { agent: "scout", task: "save me", name: "saved-child" }, ctx);
    const outside = mkdtempSync(path.join(os.tmpdir(), "killeros-outside-session-"));
    try {
      const malformed = JSON.parse(JSON.stringify(entries[1]));
      malformed.data.thread.session.directory = outside;
      entries.splice(0, entries.length, malformed);
      handlers.get("session_start")(undefined, ctx);
      const restored = await execute(tool, { action: "list" }, ctx);
      assert.deepEqual(restored.details.threads, []);
      assert.equal(existsSync(outside), true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("restored active snapshots expose orphaned status in task results", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  let tool;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const pi = {
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("saved")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "orphan-parent", entries });
    await execute(tool, { agent: "scout", task: "save me", name: "saved-child" }, ctx);
    const orphaned = JSON.parse(JSON.stringify(entries[1]));
    orphaned.data.thread.state = "active";
    orphaned.data.result.status = "running";
    entries.splice(0, entries.length, orphaned);
    handlers.get("session_start")(undefined, ctx);
    const restored = await execute(tool, { action: "list" }, ctx);
    assert.equal(restored.details.doneThreads[0].state, "orphaned");
    assert.equal(restored.details.results[0].status, "orphaned");
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("resume persistence clears the prior terminal result before the child runs", async () => {
  const roster = tempRoster();
  const sessionRoot = mkdtempSync(path.join(os.tmpdir(), "killeros-parent-session-"));
  const entries = [];
  const handlers = new Map();
  const children = [];
  let tool;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const pi = {
      registerTool(value) { tool = value; },
      appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
      on(event, handler) { handlers.set(event, handler); },
    };
    registerSubagentTool(pi, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: false,
      spawnProcess() {
        const child = new FakeProcess();
        children.push(child);
        return child;
      },
    });
    const ctx = toolContext(roster.root, { sessionRoot, sessionId: "resume-persist-parent", entries });
    const started = await execute(tool, { agent: "scout", task: "first", name: "reviewer" }, ctx);
    for (let attempt = 0; attempt < 100 && !children[0]; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(children[0]);
    children[0].json(assistantEvent("first"));
    children[0].close(0);
    await execute(tool, { action: "wait", threadId: started.details.results[0].id, timeoutMs: 100 }, ctx);

    const resumed = await execute(tool, { action: "resume", threadId: "reviewer", task: "second" }, ctx);
    for (let attempt = 0; attempt < 100 && !children[1]; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(children[1]);
    const snapshots = entries.filter((entry) => entry.data.event === "snapshot");
    const latest = snapshots.at(-1).data;
    assert.equal(latest.thread.state, "queued");
    assert.equal(Object.hasOwn(latest, "result"), false);
    assert.equal(resumed.details.results[0].output, "");

    children[1].json(assistantEvent("second"));
    children[1].close(0);
    await execute(tool, { action: "wait", threadId: started.details.results[0].id, timeoutMs: 100 }, ctx);
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("resume keeps a terminal child unchanged when role validation fails", async () => {
  const roster = tempRoster();
  try {
    const rolePath = writeRole(roster.bundled, "scout.md", { name: "scout" });
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => { child.json(assistantEvent("saved")); child.close(0); });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const started = await execute(tool, { agent: "scout", task: "save this", name: "reviewer" }, ctx);
    rmSync(rolePath);
    await assert.rejects(
      execute(tool, { action: "resume", threadId: started.details.results[0].id }, ctx),
      /Unknown subagent.*scout/iu,
    );
    const listed = await execute(tool, { action: "list" }, ctx);
    assert.equal(listed.details.threads.find((thread) => thread.id === started.details.results[0].id).state, "done");
    assert.equal(listed.details.results.find((result) => result.id === started.details.results[0].id).output, "saved");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("subagent preparation gives Pi action-specific request errors", () => {
  const tool = createToolHarness();
  const validate = (input) => validateToolArguments(tool, {
    name: "subagent",
    arguments: tool.prepareArguments ? tool.prepareArguments(input) : input,
  });

  assert.throws(
    () => validate({ action: "spawn", agent: "worker", task: "inspect", message: "steer" }),
    /cannot combine task with its message alias/u,
  );
  assert.deepEqual(
    validate({ action: "spawn", agent: "worker", message: "inspect" }),
    { action: "spawn", agent: "worker", task: "inspect" },
  );
  const inline = { name: "focused", description: "Inspect only.", access: "read", tools: ["read"] };
  assert.deepEqual(validate({ agent: inline, task: "inspect" }), { agent: inline, task: "inspect" });
  assert.deepEqual(
    validate({ action: "spawn", tasks: [{ agent: "worker", task: "inspect" }] }),
    { action: "spawn", tasks: [{ agent: "worker", task: "inspect" }] },
  );
  assert.deepEqual(
    validate({ action: "spawn", agent: "worker", task: "inspect", threadId: "provider-generated" }),
    { action: "spawn", agent: "worker", task: "inspect" },
  );
});

test("invalid subagent requests fail before context access or child launch", async () => {
  let spawned = 0;
  const tool = createToolHarness({
    spawnProcess() {
      spawned += 1;
      return new FakeProcess();
    },
  });
  const invalidRequests = [
    [{ action: "spawn", agent: "worker", task: "inspect", message: "steer" }, /cannot combine task.*message alias/iu],
    [{ action: "spawn", agent: "worker", task: "inspect", tasks: [{ agent: "worker", task: "inspect" }] }, /exactly one.*spawn/iu],
    [{ action: "spawn", agent: "worker", task: "inspect", writerConcurrency: 1 }, /writerConcurrency.*parallel/iu],
    [{ action: "list", agent: "worker", task: "inspect" }, /agent.*list|task.*list|unrelated/iu],
    [{ action: "interrupt", all: true, threadId: "subagent-1" }, /exactly one.*threadId.*all/iu],
  ];

  for (const [input, error] of invalidRequests) {
    await assert.rejects(
      () => tool.execute("test-call", input, undefined, undefined, undefined),
      error,
    );
  }
  assert.equal(spawned, 0);
});

test("renderCall never shows a schedule for an invalid subagent request", () => {
  const tool = createToolHarness();
  const theme = {
    bold(text) { return text; },
    fg(_color, text) { return text; },
  };
  const invalid = tool.renderCall({
    action: "spawn",
    tasks: [{ agent: "worker", task: "inspect" }],
    writerConcurrency: 1,
    agentScope: "both",
    message: "invalid for spawn",
  }, theme).render(200).join("\n");
  const valid = tool.renderCall({
    action: "spawn",
    tasks: [{ agent: "worker", task: "inspect" }],
    writerConcurrency: 1,
    agentScope: "both",
  }, theme).render(200).join("\n");
  const preparedSpawn = tool.renderCall({
    action: "spawn",
    agent: "scout",
    task: "inspect",
    threadId: "provider-generated",
  }, theme).render(200).join("\n");

  assert.match(invalid, /invalid request/iu);
  assert.doesNotMatch(invalid, /parallel 1|shared pool 1|both/iu);
  assert.match(valid, /parallel 1.*shared pool 1.*both/iu);
  assert.match(preparedSpawn, /subagent scout/iu);
  assert.doesNotMatch(preparedSpawn, /invalid request/iu);
});

test("child process environment does not expose the parent session identity", () => {
  assert.deepEqual(childProcessEnvironment({
    API_KEY: "keep",
    PI_SESSION_FILE: "parent.jsonl",
    PI_SESSION_ID: "parent-id",
    PI_MODEL: "parent-model",
  }), {
    API_KEY: "keep",
    PI_MODEL: "parent-model",
  });
});

test("discovers bundled, personal, and trusted project roles with deterministic precedence", () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout", description: "bundled scout" });
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer", description: "bundled reviewer" });
    writeRole(roster.personal, "scout.md", { name: "scout", description: "personal scout" });
    const projectDir = path.join(roster.root, ".pi", "agents");
    writeRole(projectDir, "scout.md", { name: "scout", description: "project scout" });

    const user = discoverAgentRoles(roster.root, "user", true, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
    });
    assert.equal(user.agents.find((agent) => agent.name === "scout").source, "personal");
    assert.equal(user.agents.find((agent) => agent.name === "reviewer").source, "bundled");

    const both = discoverAgentRoles(roster.root, "both", true, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
    });
    assert.equal(both.agents.find((agent) => agent.name === "scout").source, "project");
    assert.equal(both.projectAgentsDir, projectDir);

    assert.throws(
      () => discoverAgentRoles(roster.root, "both", false, {
        bundledAgentsDir: roster.bundled,
        userAgentsDir: roster.personal,
      }),
      /trusted project/u,
    );
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("role validation fails closed for mutation tools, unknown fields, duplicates, and missing prompts", () => {
  const cases = [
    [{ name: "unsafe", access: "read", tools: "read, bash" }, /read-only roles cannot use bash/u],
    [{ name: "typo", extra: "maxTurn: 4" }, /maxTurn.*unknown role field/u],
    [{ name: "empty", prompt: "   " }, /prompt.*non-empty/u],
  ];
  for (const [options, expected] of cases) {
    const roster = tempRoster();
    try {
      writeRole(roster.bundled, `${options.name}.md`, options);
      assert.throws(() => discoverAgentRoles(roster.root, "user", true, {
        bundledAgentsDir: roster.bundled,
        userAgentsDir: roster.personal,
      }), expected);
    } finally {
      rmSync(roster.root, { recursive: true, force: true });
    }
  }

  const malformedRoster = tempRoster();
  try {
    const malformedPath = path.join(malformedRoster.bundled, "malformed.md");
    writeFileSync(malformedPath, "---\nname: [broken\n---\nprompt\n");
    assert.throws(() => discoverAgentRoles(malformedRoster.root, "user", true, {
      bundledAgentsDir: malformedRoster.bundled,
      userAgentsDir: malformedRoster.personal,
    }), (error) => {
      assert.match(error.message, new RegExp(malformedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
      assert.match(error.message, /frontmatter/u);
      return true;
    });
  } finally {
    rmSync(malformedRoster.root, { recursive: true, force: true });
  }

  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "one.md", { name: "same" });
    writeRole(roster.bundled, "two.md", { name: "same" });
    assert.throws(() => discoverAgentRoles(roster.root, "user", true, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
    }), /duplicate bundled role/u);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("model resolution supports exact colon IDs and enforces Pi thinking capabilities", () => {
  const base = {
    name: "reviewer",
    description: "review",
    access: "read",
    tools: ["read"],
    timeoutMs: 300000,
    prompt: "review",
    source: "bundled",
    filePath: "reviewer.md",
  };
  assert.deepEqual(resolveAgentModel(base, modelContext()), {
    model: "test/parent-model",
    thinking: "high",
    definition: parentModel,
  });
  assert.deepEqual(resolveAgentModel({ ...base, model: "inherit", thinking: "low" }, modelContext()), {
    model: "test/parent-model",
    thinking: "low",
    definition: parentModel,
  });

  const duplicate = { ...parentModel, provider: "other" };
  assert.throws(() => resolveAgentModel({ ...base, model: "parent-model" }, modelContext([parentModel, duplicate])), /ambiguous model/u);
  assert.throws(() => resolveAgentModel({ ...base, model: "missing/model" }, modelContext()), /unavailable model/u);
  assert.throws(
    () => resolveAgentModel({ ...base, model: "plain/no-reasoning:high" }, modelContext([
      parentModel,
      { provider: "plain", id: "no-reasoning", reasoning: false },
    ])),
    /does not support thinking level high/u,
  );
  assert.throws(
    () => resolveAgentModel({ ...base, model: "test/parent-model:turbo" }, modelContext()),
    /does not support thinking level turbo/u,
  );
  assert.throws(
    () => resolveAgentModel({ ...base, thinking: "turbo" }, modelContext()),
    /does not support thinking level turbo/u,
  );

  const colonModel = { provider: "ollama", id: "qwen2.5-coder:7b", reasoning: false };
  assert.deepEqual(resolveAgentModel({ ...base, model: "ollama/qwen2.5-coder:7b" }, {
    ...modelContext([colonModel]),
    thinkingLevel: "off",
  }), {
    model: "ollama/qwen2.5-coder:7b",
    thinking: "off",
    definition: colonModel,
  });

  const alwaysThinking = { provider: "custom", id: "always-thinking", reasoning: true, thinkingLevelMap: { off: null } };
  assert.throws(
    () => resolveAgentModel({ ...base, model: "custom/always-thinking:off" }, modelContext([alwaysThinking])),
    /does not support thinking level off/u,
  );

  const unavailable = { provider: "locked", id: "configured-model", reasoning: true };
  assert.throws(() => resolveAgentModel({ ...base, model: "locked/configured-model" }, {
    ...modelContext(),
    modelRegistry: {
      getAvailable: () => [parentModel],
      find: () => unavailable,
    },
  }), /unavailable model/u);
});

test("role timeout validation rejects Node timer overflow values", () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "slow.md", { name: "slow", timeoutMs: 2_147_483_648 });
    assert.throws(
      () => discoverAgentRoles(roster.root, "user", true, { bundledAgentsDir: roster.bundled, userAgentsDir: roster.personal }),
      /timeoutMs.*no greater than 2147483647/u,
    );
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("isolated child invocation uses explicit tools and reports bounded output, trace, usage, and unique task IDs", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const calls = [];
    const promptPaths = [];
    const promptContents = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args, cwd, environment) {
        calls.push({ args, cwd, environment });
        const promptPath = args[args.indexOf("--append-system-prompt") + 1];
        promptPaths.push(promptPath);
        assert.equal(existsSync(promptPath), true);
        promptContents.push(readFileSync(promptPath, "utf8"));
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("Mapped auth flow", {
            content: [
              { type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } },
              { type: "text", text: "Mapped auth flow" },
            ],
          }));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const first = await execute(tool, { agent: "scout", task: "Map auth" }, ctx);
    const second = await execute(tool, { agent: "scout", task: "Map sessions" }, ctx);

    assert.notEqual(first.details.results[0].id, second.details.results[0].id);
    assert.equal(first.details.results[0].status, "complete");
    assert.equal(first.details.results[0].output, "Mapped auth flow");
    assert.match(first.details.results[0].trace.join("\n"), /read.*src\/auth\.ts/u);
    assert.equal(first.details.aggregateUsage.totalTokens, 18);
    assert.equal(first.usage.cost.total, 0.03);
    assert.match(first.content[0].text, /Mapped auth flow/u);

    const args = calls[0].args;
    for (const flag of ["--mode", "--session-dir", "--session-id", "--no-extensions", "--extension", "--no-prompt-templates", "--approve", "--model", "--thinking", "--tools"]) {
      assert.ok(args.includes(flag), `missing child flag ${flag}`);
    }
    assert.equal(args.includes("--no-session"), false);
    assert.equal(args[args.indexOf("--extension") + 1], "npm:pi-web-access");
    assert.equal(args.includes("--no-skills"), false);
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,web_search,source_check,fetch_content,get_search_content");
    assert.equal(args[args.indexOf("--model") + 1], "test/parent-model");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    assert.equal(calls[0].environment, undefined);
    assert.deepEqual(promptContents, ["Act as scout.", "Act as scout."]);
    assert.ok(promptPaths.every((promptPath) => !existsSync(promptPath)), "temporary prompts must be removed");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("model and thinking overrides select the requested child configuration independently", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout", model: "inherit", thinking: "inherit" });
    const selectedModel = {
      provider: "test",
      id: "selected-model",
      name: "Selected model",
      reasoning: true,
    };
    let capturedArgs;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        capturedArgs = args;
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("selected", { provider: selectedModel.provider, model: selectedModel.id }));
          child.close(0);
        });
        return child;
      },
    });
    const result = await execute(tool, {
      agent: "scout",
      task: "Use the selected configuration",
      model: "test/selected-model",
      thinking: "low",
    }, toolContext(roster.root, { models: [parentModel, selectedModel] }));
    assert.equal(result.details.results[0].status, "complete");
    assert.equal(result.details.results[0].model, "test/selected-model");
    assert.equal(result.details.results[0].thinking, "low");
    assert.equal(capturedArgs[capturedArgs.indexOf("--model") + 1], "test/selected-model");
    assert.equal(capturedArgs[capturedArgs.indexOf("--thinking") + 1], "low");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("project overrides require trust, explicit scope, and interactive approval", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer", description: "bundled" });
    writeRole(path.join(roster.root, ".pi", "agents"), "reviewer.md", { name: "reviewer", description: "project" });
    let spawned = 0;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() { spawned += 1; return new FakeProcess(); },
    });

    await assert.rejects(execute(tool, { agent: "reviewer", task: "Review", agentScope: "both" }, toolContext(roster.root, { trusted: false })), /trusted project/u);
    await assert.rejects(execute(tool, { agent: "reviewer", task: "Review", agentScope: "both" }, toolContext(roster.root, { confirm: false })), /not approved/u);
    const noUi = toolContext(roster.root);
    noUi.hasUI = false;
    await assert.rejects(execute(tool, { agent: "reviewer", task: "Review", agentScope: "both" }, noUi), /interactive confirmation/u);
    assert.equal(spawned, 0);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("mixed partial single fields cannot be combined with parallel or chain mode", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let spawned = 0;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() { spawned += 1; return new FakeProcess(); },
    });
    await assert.rejects(execute(tool, {
      agent: "scout",
      tasks: [{ agent: "scout", task: "map" }],
    }, toolContext(roster.root)), /exactly one spawn shape/u);
    await assert.rejects(execute(tool, {
      task: "stray task",
      chain: [{ agent: "scout", task: "map" }],
    }, toolContext(roster.root)), /exactly one spawn shape/u);
    assert.equal(spawned, 0);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("parallel execution caps readers, serializes writers by default, and supports an explicit shared-pool cap", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer" });
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    let activeReaders = 0;
    let peakReaders = 0;
    let activeChildren = 0;
    let peakChildren = 0;
    let activeWriters = 0;
    let peakWriters = 0;
    let writerStartedWithWriter = false;
    const writerTasks = [];
    let spawned = 0;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { maxReadConcurrency: 2 },
      spawnProcess(args) {
        spawned += 1;
        const child = new FakeProcess();
        const tools = args[args.indexOf("--tools") + 1];
        const writer = tools.includes("edit");
        activeChildren += 1;
        peakChildren = Math.max(peakChildren, activeChildren);
        if (writer) {
          writerTasks.push(args.at(-1));
          writerStartedWithWriter = writerStartedWithWriter || activeWriters > 0;
          activeWriters += 1;
          peakWriters = Math.max(peakWriters, activeWriters);
        }
        else {
          activeReaders += 1;
          peakReaders = Math.max(peakReaders, activeReaders);
        }
        setTimeout(() => {
          child.json(assistantEvent(writer ? "written" : "read"));
          if (writer) activeWriters -= 1;
          else activeReaders -= 1;
          activeChildren -= 1;
          child.close(0);
        }, 20);
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const readOnly = await execute(tool, {
      tasks: [
        { agent: "scout", task: "one" },
        { agent: "reviewer", task: "two" },
        { agent: "scout", task: "three" },
      ],
    }, ctx);
    assert.equal(readOnly.details.results.every((entry) => entry.status === "complete"), true);
    assert.equal(peakReaders, 2);

    peakChildren = 0;
    const mixed = await execute(tool, {
      tasks: [
        { agent: "scout", task: "one" },
        { agent: "reviewer", task: "two" },
        { agent: "scout", task: "three" },
        { agent: "worker", task: "write with readers" },
      ],
    }, ctx);
    assert.equal(mixed.details.results.every((entry) => entry.status === "complete"), true);
    assert.equal(peakChildren, 1);
    assert.match(mixed.details.executionNote, /shared pool of up to 1 \(safe default\)/u);

    peakWriters = 0;
    writerStartedWithWriter = false;
    const writers = await execute(tool, {
      tasks: [
        { agent: "worker", task: "one" },
        { agent: "worker", task: "two" },
      ],
    }, ctx);
    assert.deepEqual(writers.details.results.map((entry) => entry.status), ["complete", "complete"]);
    assert.deepEqual([...writerTasks.slice(-2)].sort(), ["Task: one", "Task: two"].sort());
    assert.equal(peakWriters, 1);
    assert.equal(writerStartedWithWriter, false);
    assert.match(writers.details.executionNote, /shared pool of up to 1 \(safe default\)/u);

    await assert.rejects(() => execute(tool, {
      writerConcurrency: 2,
      tasks: [
        { agent: "scout", task: "read one" },
        { agent: "reviewer", task: "read two" },
        { agent: "worker", task: "write one" },
        { agent: "worker", task: "write two" },
      ],
    }, ctx), /writerConcurrency above 1.*share the parent worktree.*use 1/iu);

    peakChildren = 0;
    const serialMixed = await execute(tool, {
      writerConcurrency: 1,
      tasks: [
        { agent: "scout", task: "serial read one" },
        { agent: "reviewer", task: "serial read two" },
        { agent: "worker", task: "serial write" },
      ],
    }, ctx);
    assert.deepEqual(serialMixed.details.results.map((entry) => entry.status), ["complete", "complete", "complete"]);
    assert.equal(peakChildren, 1);
    assert.match(serialMixed.details.executionNote, /shared pool of up to 1/u);

    peakWriters = 0;
    writerStartedWithWriter = false;
    const serialWriters = await execute(tool, {
      writerConcurrency: 1,
      tasks: [
        { agent: "worker", task: "serial one" },
        { agent: "worker", task: "serial two" },
      ],
    }, ctx);
    assert.deepEqual(serialWriters.details.results.map((entry) => entry.status), ["complete", "complete"]);
    assert.equal(peakWriters, 1);
    assert.equal(writerStartedWithWriter, false);
    assert.match(serialWriters.details.executionNote, /shared pool of up to 1/u);
    assert.equal(spawned, 14);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("chain expansion bounds repeated handoffs before spawning", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const expandedTasks = [];
    const successTool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        expandedTasks.push(args.at(-1));
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("handoff 😀"));
          child.close(0);
        });
        return child;
      },
    });
    const success = await execute(successTool, {
      chain: [
        { agent: "scout", task: "produce the handoff" },
        { agent: "scout", task: "prefix {previous} suffix" },
      ],
    }, toolContext(roster.root));
    assert.deepEqual(success.details.results.map((entry) => entry.status), ["complete", "complete"]);
    assert.match(expandedTasks[1], /prefix handoff 😀 suffix/u);

    let spawned = 0;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        spawned += 1;
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("x".repeat(900_000)));
          child.close(0);
        });
        return child;
      },
    });
    const result = await execute(tool, {
      chain: [
        { agent: "scout", task: "produce the handoff" },
        { agent: "scout", task: "{previous}".repeat(2_000) },
        { agent: "scout", task: "must not start" },
      ],
    }, toolContext(roster.root));
    assert.equal(spawned, 1);
    assert.equal(result.details.results[0].status, "complete");
    assert.equal(result.details.results[1].status, "failed");
    assert.equal(result.details.results[1].terminationReason, "task_limit");
    assert.equal(result.details.results[2].status, "cancelled");
    assert.equal(result.details.results[2].terminationReason, "chain_stopped");
    assert.equal(result.details.threads[2].stopReason, "chain_stopped");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("default writer serialization preserves both file updates", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    const target = path.join(roster.root, "shared.txt");
    writeFileSync(target, "");
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        const child = new FakeProcess();
        const task = args.at(-1);
        const update = task.includes("first") ? "first" : "second";
        const before = readFileSync(target, "utf8");
        setTimeout(() => {
          writeFileSync(target, `${before}${update}\n`);
          child.json(assistantEvent(update));
          child.close(0);
        }, 5);
        return child;
      },
    });
    const result = await execute(tool, {
      tasks: [
        { agent: "worker", task: "write first update" },
        { agent: "worker", task: "write second update" },
      ],
    }, toolContext(roster.root));
    assert.deepEqual(result.details.results.map((entry) => entry.status), ["complete", "complete"]);
    const content = readFileSync(target, "utf8");
    assert.match(content, /first/u);
    assert.match(content, /second/u);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("production spawn returns thread IDs before completion and permits active interruption", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let tool;
    let resolveSpawned;
    let resolveCompletion;
    const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { resolveCompletion({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          setImmediate(() => child.close(143));
          return true;
        };
        resolveSpawned(child);
        return child;
      },
    });

    const ctx = toolContext(roster.root);
    const started = await execute(tool, { agent: "scout", task: "inspect the repository" }, ctx);
    const threadId = started.details.results[0].id;
    const child = await spawned;
    assert.equal(child.closed, false);
    assert.equal(started.details.results[0].status, "queued");
    assert.match(started.content[0].text, new RegExp(threadId, "u"));

    const active = await execute(tool, { action: "inspect", threadId }, ctx);
    assert.equal(active.details.activeThreads[0].id, threadId);
    await execute(tool, { action: "interrupt", threadId }, ctx);

    const delivered = await completion;
    assert.equal(delivered.message.customType, "killeros-subagent-settled");
    assert.match(delivered.message.content, /cancelled|interrupt/iu);
    assert.deepEqual(delivered.options, { triggerTurn: true, deliverAs: "followUp" });
    const finished = await execute(tool, { action: "inspect", threadId }, ctx);
    assert.equal(finished.details.doneThreads[0].state, "stopped");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("production spawn delivers a successful handoff as a triggered follow-up", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let tool;
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { resolveCompletion({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("verified handoff"));
          child.close(0);
        });
        return child;
      },
    });

    const started = await execute(tool, { agent: "scout", task: "inspect the repository" }, toolContext(roster.root));
    assert.match(started.content[0].text, /continue in the background/iu);
    const delivered = await completion;
    assert.equal(delivered.message.customType, "killeros-subagent-settled");
    assert.match(delivered.message.content, /Subagent batch settled[\s\S]*verified handoff/iu);
    assert.deepEqual(delivered.options, { triggerTurn: true, deliverAs: "followUp" });
    const modelMessages = convertToLlm([{ role: "custom", ...delivered.message, timestamp: Date.now() }]);
    assert.equal(modelMessages[0].role, "user");
    assert.match(modelMessages[0].content[0].text, /Subagent batch settled[\s\S]*verified handoff/iu);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("production spawn shows live child state and usage after the tool call returns", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let tool;
    let resolveSpawned;
    let resolveCompletion;
    const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const widgets = [];
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { resolveCompletion({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        resolveSpawned(child);
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    ctx.ui.setWidget = (key, content) => widgets.push({ key, content });

    const started = await execute(tool, { agent: "scout", task: "inspect the repository" }, ctx);
    assert.equal(started.details.results[0].status, "queued");
    assert.match(started.content[0].text, /Live progress appears above the editor/iu);
    const launchReceipt = tool.renderResult(started, { expanded: false }, {
      bold(text) { return text; },
      fg(_color, text) { return text; },
    }).render(200).join("\n");
    assert.ok(widgets.some(({ content }) => content?.some((line) => /Queued.*0 turns.*0 tokens/iu.test(line))));
    const child = await spawned;
    child.json(assistantEvent("working"));
    await new Promise((resolve) => setImmediate(resolve));

    const sawLiveUsage = widgets.some(({ content }) => content?.some((line) => /Running.*1 turn.*18 tokens/iu.test(line)));
    child.close(0);
    await completion;
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(launchReceipt, /Started in background \(1\)/iu);
    assert.match(launchReceipt, /scout.*role scout.*attempt 1/iu);
    assert.match(launchReceipt, /Live status appears below/iu);
    assert.doesNotMatch(launchReceipt, /Queued|0 turns|0 tokens/iu);
    assert.ok(sawLiveUsage);
    assert.ok(widgets.some(({ content }) => content?.some((line) => /Complete.*1 turn.*18 tokens/iu.test(line))));
    assert.equal(widgets.at(-1).content, undefined);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("default token quota stops a runaway child and saves a terminal thread", async () => {
  const roster = tempRoster();
  let fallbackTimer;
  try {
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer" });
    let child;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        child = new FakeProcess();
        setImmediate(() => {
          const usage = {
            input: 1_100_000,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1_100_001,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          child.json(assistantEvent("first tool", { stopReason: "toolUse", usage }));
          child.json(assistantEvent("second tool", { stopReason: "toolUse", usage }));
          fallbackTimer = setTimeout(() => child.close(0), 50);
        });
        return child;
      },
    });

    const result = await execute(tool, { agent: "reviewer", task: "review the change" }, toolContext(roster.root));
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === task.id);

    assert.equal(task.status, "limited");
    assert.equal(task.terminationReason, "quota_tokens");
    assert.equal(task.usage.turns, 2);
    assert.equal(thread.state, "stopped");
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("default turn limit reaches the child process and stops tool loops", async () => {
  const roster = tempRoster();
  let fallbackTimer;
  try {
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer" });
    let child;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { defaultMaxTurns: 2, defaultQuotaTokens: 10_000_000 },
      spawnProcess() {
        child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("first tool", { stopReason: "toolUse" }));
          child.json(assistantEvent("second tool", { stopReason: "toolUse" }));
          fallbackTimer = setTimeout(() => child.close(0), 50);
        });
        return child;
      },
    });

    const result = await execute(tool, { agent: "reviewer", task: "review the change" }, toolContext(roster.root));
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === task.id);

    assert.equal(task.status, "limited");
    assert.equal(task.terminationReason, "turn_limit");
    assert.equal(task.usage.turns, 2);
    assert.equal(thread.state, "stopped");
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  } finally {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("production spawn reports a failed follow-up delivery in the TUI", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let tool;
    let resolveNotice;
    const notice = new Promise((resolve) => { resolveNotice = resolve; });
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage() { throw new Error("delivery failed"); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("saved result"));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    ctx.ui.notify = (message, type) => resolveNotice({ message, type });

    await execute(tool, { agent: "scout", task: "inspect the repository" }, ctx);
    const delivered = await notice;
    assert.match(delivered.message, /follow-up could not be delivered.*list or collect/iu);
    assert.equal(delivered.type, "warning");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("production parent abort settles children without triggering a replacement turn", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let tool;
    let resolveSpawned;
    let resolveClosed;
    const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    const sentMessages = [];
    registerSubagentTool({
      registerTool(value) { tool = value; },
      sendMessage(message, options) { sentMessages.push({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          setImmediate(() => {
            child.close(143);
            resolveClosed();
          });
          return true;
        };
        resolveSpawned(child);
        return child;
      },
    });

    const controller = new AbortController();
    const started = await execute(tool, { agent: "scout", task: "inspect the repository" }, toolContext(roster.root), controller.signal);
    const threadId = started.details.results[0].id;
    await spawned;
    controller.abort();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(sentMessages, []);
    const finished = await execute(tool, { action: "inspect", threadId }, toolContext(roster.root));
    assert.equal(finished.details.doneThreads[0].state, "stopped");
    assert.equal(finished.details.results[0].terminationReason, "abort");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("production session shutdown awaits active background child settlement", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let tool;
    let shutdown;
    let resolveSpawned;
    const spawned = new Promise((resolve) => { resolveSpawned = resolve; });
    const sentMessages = [];
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) {
        if (event === "session_shutdown") shutdown = callback;
      },
      sendMessage(message, options) { sentMessages.push({ message, options }); },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          return true;
        };
        resolveSpawned(child);
        return child;
      },
    });

    await execute(tool, { agent: "scout", task: "inspect the repository" }, toolContext(roster.root));
    const child = await spawned;
    let shutdownSettled = false;
    const stopping = shutdown().then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
    assert.equal(shutdownSettled, false);

    child.close(143);
    await stopping;
    assert.equal(shutdownSettled, true);
    assert.deepEqual(sentMessages, []);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("parent abort stops the active writer and cancels queued writers", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    let spawned = 0;
    let resolveFirstWriter;
    const firstWriterStarted = new Promise((resolve) => { resolveFirstWriter = resolve; });
    const controller = new AbortController();
    let firstChild;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        spawned += 1;
        firstChild = new FakeProcess();
        resolveFirstWriter();
        setImmediate(() => controller.abort());
        setTimeout(() => {
          firstChild.json(assistantEvent("first finished"));
          firstChild.close(0);
        }, 20);
        return firstChild;
      },
    });
    const run = execute(tool, {
      writerConcurrency: 1,
      tasks: [
        { agent: "worker", task: "first" },
        { agent: "worker", task: "never starts" },
      ],
    }, toolContext(roster.root), controller.signal);
    await firstWriterStarted;
    const result = await run;

    assert.deepEqual(result.details.results.map((entry) => entry.status), ["cancelled", "cancelled"]);
    assert.deepEqual(result.details.results.map((entry) => entry.terminationReason), ["abort", "abort"]);
    assert.deepEqual(result.details.threads.map((thread) => thread.state), ["stopped", "stopped"]);
    assert.deepEqual(firstChild.killSignals, ["SIGTERM"]);
    assert.equal(spawned, 1);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("message is scoped to steer and the parallel schedule is described", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("mapped"));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const spawned = await execute(tool, { agent: "scout", message: "map" }, ctx);
    assert.equal(spawned.details.results[0].task, "map");
    await assert.rejects(execute(tool, { action: "list", message: "extra" }, ctx), /message is only valid with action "steer"/u);
    await assert.rejects(execute(tool, {
      writerConcurrency: 2,
      tasks: [{ agent: "scout", task: "map" }],
    }, ctx), /requires at least one write-capable role/u);
    assert.match(tool.description, /write-capable tasks are serialized in the shared parent worktree/iu);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.ok(tool.parameters.properties.action.enum.includes("steer"));
    assert.match(tool.parameters.properties.tasks.description, /one shared slot by default/u);
    assert.match(tool.parameters.properties.writerConcurrency.description, /Defaults to 1/u);
    assert.match(tool.parameters.properties.message.description, /spawn.*20,000.*steer.*4,000/iu);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("inline roles cover every spawn shape and unknown roles fail before launch", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    let spawned = 0;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      parentTools: ["read", "grep"],
      spawnProcess() {
        spawned += 1;
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("done"));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);

    await assert.rejects(
      execute(tool, { agent: "general-purpose", task: "fix it" }, ctx),
      /Unknown subagent "general-purpose".*Available: worker \(bundled\)/iu,
    );
    assert.equal(spawned, 0);

    const inlineRole = { name: "focused", description: "Inspect only the named file.", access: "read", tools: ["read", "grep"] };
    const inline = await execute(tool, {
      agent: inlineRole,
      message: "inspect auth",
    }, ctx);
    assert.equal(inline.details.results[0].agent, "focused");
    assert.equal(inline.details.results[0].agentSource, "inline");
    assert.deepEqual(inline.details.results[0].tools, ["read", "grep"]);
    assert.equal(inline.details.results[0].task, "inspect auth");

    const parallel = await execute(tool, { tasks: [{ agent: inlineRole, task: "inspect sessions" }] }, ctx);
    assert.equal(parallel.details.mode, "parallel");
    assert.equal(parallel.details.results[0].agentSource, "inline");

    const chain = await execute(tool, { chain: [{ agent: inlineRole, task: "inspect storage" }] }, ctx);
    assert.equal(chain.details.mode, "chain");
    assert.equal(chain.details.results[0].agentSource, "inline");
    assert.equal(spawned, 3);

    await assert.rejects(execute(tool, {
      agent: { name: "shell", description: "Run a command.", access: "write", tools: ["bash"] },
      task: "run it",
    }, ctx), /tool "bash".*not active for the parent/iu);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("parallel reviewers complete after more than 250,000 tokens", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("Reviewed", {
            usage: {
              input: 250_001,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 250_001,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          }));
          child.close(0);
        });
        return child;
      },
    });

    const result = await execute(tool, {
      tasks: [
        { agent: "reviewer", task: "Review first change" },
        { agent: "reviewer", task: "Review second change" },
      ],
    }, toolContext(roster.root));

    assert.deepEqual(result.details.results.map((entry) => entry.status), ["complete", "complete"]);
    assert.equal(result.details.aggregateUsage.totalTokens, 500_002);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("turn, retained trace, stderr, malformed JSONL, timeout, and output limits fail or truncate visibly", async () => {
  const scenarios = [
    {
      name: "turn",
      role: { name: "agent" },
      emit(child) {
        child.json(assistantEvent("tool requested at the cap", {
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "read", arguments: { path: "next.ts" } }],
        }));
        child.close(0);
      },
      expectedStatus: "failed",
      expectedReason: "missing_assistant_message",
    },
    {
      name: "trace",
      role: { name: "agent" },
      limits: { traceBytes: 80 },
      emit(child) {
        child.json({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(200) } });
        child.json(assistantEvent("done", {
          content: [
            { type: "text", text: "done" },
            { type: "toolCall", name: "read", arguments: { path: `src/${"nested/".repeat(20)}file.ts` } },
          ],
        }));
        child.close(0);
      },
      expectedStatus: "limited",
      expectedReason: "trace_limit",
      expectedOutput: "done",
    },
    {
      name: "chunked-utf8",
      role: { name: "agent" },
      emit(child) {
        const payload = Buffer.from(`${JSON.stringify(assistantEvent("before 😀 after"))}\n`, "utf8");
        const split = payload.indexOf(Buffer.from("😀", "utf8")) + 1;
        child.stdout.write(payload.subarray(0, split));
        child.stdout.write(payload.subarray(split));
        child.close(0);
      },
      expectedStatus: "complete",
      expectedReason: "completed",
      expectedOutput: "before 😀 after",
    },
    {
      name: "stderr",
      role: { name: "agent" },
      limits: { stderrBytes: 16 },
      emit(child) { child.stderr.write("error output larger than cap"); },
      expectedStatus: "limited",
      expectedReason: "stderr_limit",
    },
    {
      name: "json",
      role: { name: "agent" },
      emit(child) { child.stdout.write("not-json\n"); },
      expectedStatus: "failed",
      expectedReason: "malformed_jsonl",
    },
    {
      name: "jsonl-line",
      role: { name: "agent", timeoutMs: 20 },
      limits: { jsonlLineBytes: 64 },
      emit(child) {
        child.stdout.write("x".repeat(40));
        child.stdout.write("x".repeat(40));
      },
      expectedStatus: "limited",
      expectedReason: "jsonl_line_limit",
    },
    {
      name: "length",
      role: { name: "agent" },
      emit(child) { child.json(assistantEvent("partial", { stopReason: "length" })); child.close(0); },
      expectedStatus: "complete",
      expectedReason: "completed",
    },
    {
      name: "output",
      role: { name: "agent" },
      limits: { taskOutputBytes: 10 },
      emit(child) { child.json(assistantEvent("0123456789EXTRA")); child.close(0); },
      expectedStatus: "limited",
      expectedReason: "output_limit",
      outputTruncated: true,
    },
  ];

  for (const scenario of scenarios) {
    const roster = tempRoster();
    try {
      writeRole(roster.bundled, "agent.md", scenario.role);
      const tool = createToolHarness({
        bundledAgentsDir: roster.bundled,
        userAgentsDir: roster.personal,
        limits: scenario.limits,
        spawnProcess() {
          const child = new FakeProcess();
          setImmediate(() => scenario.emit(child));
          return child;
        },
      });
      const result = await execute(tool, { agent: "agent", task: scenario.name }, toolContext(roster.root));
      const task = result.details.results[0];
      assert.equal(task.status, scenario.expectedStatus, scenario.name);
    assert.equal(task.terminationReason, scenario.expectedReason, scenario.name);
      if (scenario.expectedOutput) assert.equal(task.output, scenario.expectedOutput);
      if (scenario.outputTruncated) assert.ok(task.outputTruncatedBytes > 0);
      if (scenario.name === "trace") {
        assert.equal(task.traceBytes, Buffer.byteLength(task.trace.join(""), "utf8"));
        assert.ok(task.traceBytes <= scenario.limits.traceBytes);
        assert.ok(task.traceTruncatedBytes > 0);
      }
      if (scenario.name === "stderr") assert.ok(task.stderrTruncatedBytes > 0);
      if (scenario.name === "json") assert.match(task.errorMessage, /Malformed child JSONL/u);
      if (scenario.name === "jsonl-line") assert.match(task.errorMessage, /JSONL line exceeds 64 bytes/u);
    } finally {
      rmSync(roster.root, { recursive: true, force: true });
    }
  }

  const timeoutRoster = tempRoster();
  try {
    writeRole(timeoutRoster.bundled, "slow.md", { name: "slow", timeoutMs: 20 });
    const tool = createToolHarness({
      bundledAgentsDir: timeoutRoster.bundled,
      userAgentsDir: timeoutRoster.personal,
      spawnProcess() { return new FakeProcess(); },
    });
    const result = await execute(tool, { agent: "slow", task: "wait" }, toolContext(timeoutRoster.root));
    assert.equal(result.details.results[0].status, "limited");
    assert.equal(result.details.results[0].terminationReason, "wall_time_limit");
  } finally {
    rmSync(timeoutRoster.root, { recursive: true, force: true });
  }
});

test("child lifecycle rejects empty success and recovers transient retries within the default safety limits", async () => {
  const scenarios = [
    {
      name: "empty",
      emit(child) { child.close(0); },
      status: "failed",
      reason: "missing_assistant_message",
      turns: 0,
    },
    {
      name: "recovered",
      emit(child) {
        child.json(assistantEvent("", { stopReason: "error", errorMessage: "transient provider failure", content: [] }));
        child.json(assistantEvent("RECOVERED"));
        child.close(0);
      },
      status: "complete",
      reason: "completed",
      output: "RECOVERED",
      turns: 2,
    },
    {
      name: "terminal-error-at-cap",
      emit(child) {
        child.json(assistantEvent("", { stopReason: "error", errorMessage: "terminal provider failure", content: [] }));
        child.json({ type: "agent_end", willRetry: false });
        child.close(0);
      },
      status: "failed",
      reason: "error",
      turns: 1,
    },
    {
      name: "retry-cap",
      emit(child) {
        child.json(assistantEvent("", { stopReason: "error", errorMessage: "retryable provider failure", content: [] }));
        child.json({ type: "agent_end", willRetry: true });
        setImmediate(() => {
          if (child.closed) return;
          child.json(assistantEvent("EXTRA_REQUEST"));
          child.close(0);
        });
      },
      status: "complete",
      reason: "completed",
      output: "EXTRA_REQUEST",
      turns: 2,
    },
  ];

  for (const scenario of scenarios) {
    const roster = tempRoster();
    try {
      writeRole(roster.bundled, "agent.md", { name: "agent" });
      const tool = createToolHarness({
        bundledAgentsDir: roster.bundled,
        userAgentsDir: roster.personal,
        spawnProcess() {
          const child = new FakeProcess();
          setImmediate(() => scenario.emit(child));
          return child;
        },
      });
      const result = await execute(tool, { agent: "agent", task: scenario.name }, toolContext(roster.root));
      const task = result.details.results[0];
      assert.equal(task.status, scenario.status, scenario.name);
      assert.equal(task.terminationReason, scenario.reason, scenario.name);
      assert.equal(task.usage.turns, scenario.turns, scenario.name);
      if (scenario.output) assert.equal(task.output, scenario.output);
      if (scenario.name === "recovered") assert.equal(task.errorMessage, undefined);
    } finally {
      rmSync(roster.root, { recursive: true, force: true });
    }
  }
});

test("a parent abort during child startup stops the active child", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout", timeoutMs: 1000 });
    const controller = new AbortController();
    const child = new FakeProcess();
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        controller.abort();
        setImmediate(() => {
          child.json(assistantEvent("startup finished"));
          child.close(0);
        });
        return child;
      },
    });
    const result = await execute(tool, { agent: "scout", task: "startup" }, toolContext(roster.root), controller.signal);
    assert.equal(result.details.results[0].status, "cancelled");
    assert.equal(result.details.results[0].terminationReason, "abort");
    assert.deepEqual(child.killSignals, ["SIGTERM"]);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("interrupt during child startup prevents the child from launching", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let spawned = 0;
    const updates = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        spawned += 1;
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("unexpected startup"));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "startup" }, ctx, new AbortController().signal, updates);
    const threadId = updates[0].details.results[0].id;
    await execute(tool, { action: "interrupt", threadId }, ctx);
    const result = await run;

    assert.equal(spawned, 0);
    assert.equal(result.details.results[0].status, "cancelled");
    assert.equal(result.details.results[0].terminationReason, "interrupt");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session shutdown during child startup prevents the child from launching", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let spawned = 0;
    let tool;
    let shutdown;
    registerSubagentTool({
      registerTool(value) { tool = value; },
      on(event, callback) {
        if (event === "session_shutdown") shutdown = callback;
      },
    }, {
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      awaitSpawnCompletion: true,
      spawnProcess() {
        spawned += 1;
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("unexpected shutdown startup"));
          child.close(0);
        });
        return child;
      },
    });
    const updates = [];
    const run = execute(tool, { agent: "scout", task: "shutdown" }, toolContext(roster.root), new AbortController().signal, updates);
    shutdown();
    const result = await run;

    assert.equal(spawned, 0);
    assert.equal(result.details.results[0].status, "cancelled");
    assert.equal(result.details.results[0].terminationReason, "session_shutdown");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session cleanup waits for the child close event after forced termination", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let sessionDirectory;
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      limits: { wallTimeMs: 50, killGraceMs: 5 },
      spawnProcess(args) {
        sessionDirectory = args[args.indexOf("--session-dir") + 1];
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          return true;
        };
        setTimeout(() => child.close(143), 1400);
        return child;
      },
    });
    const result = await execute(tool, { agent: "scout", task: "timeout" }, toolContext(roster.root));
    assert.equal(result.details.results[0].status, "limited");
    assert.equal(result.details.results[0].terminationReason, "wall_time_limit");
    assert.equal(existsSync(sessionDirectory), false);

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(existsSync(sessionDirectory), false);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("session cleanup retains the session when forced termination never confirms exit", async () => {
  const roster = tempRoster();
  let sessionDirectory;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      limits: { wallTimeMs: 50, killGraceMs: 5, processExitWaitMs: 10 },
      spawnProcess(args) {
        sessionDirectory = args[args.indexOf("--session-dir") + 1];
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          return true;
        };
        return child;
      },
    });
    const result = await execute(tool, { agent: "scout", task: "timeout" }, toolContext(roster.root));

    assert.equal(result.details.results[0].status, "failed");
    assert.equal(result.details.results[0].terminationReason, "process_exit_unconfirmed");
    assert.equal(result.details.results[0].exitConfirmed, false);
    assert.equal(existsSync(sessionDirectory), true);
  } finally {
    if (sessionDirectory) rmSync(sessionDirectory, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("bundled roster declares read-only auditors and focused writers", () => {
  const agents = discoverAgentRoles(process.cwd(), "user", true, {
    bundledAgentsDir: path.join(process.cwd(), "agents"),
    userAgentsDir: path.join(process.cwd(), "test", "missing-agents"),
  }).agents;
  assert.deepEqual(agents.map((agent) => agent.name), ["debugger", "documenter", "planner", "reviewer", "scout", "security", "tester", "worker"]);
  for (const name of ["planner", "reviewer", "scout", "security"]) {
    const agent = agents.find((candidate) => candidate.name === name);
    assert.equal(agent.access, "read");
    assert.equal(agent.tools.some((tool) => ["bash", "edit", "write"].includes(tool)), false);
  }
  for (const name of ["debugger", "documenter", "tester", "worker"]) {
    const agent = agents.find((candidate) => candidate.name === name);
    assert.equal(agent.access, "write");
  }
  const worker = agents.find((agent) => agent.name === "worker");
  for (const agent of agents) {
    for (const tool of ["web_search", "source_check", "fetch_content", "get_search_content"]) {
      assert.equal(agent.tools.includes(tool), true, `${agent.name} must expose ${tool}`);
    }
    assert.equal(agent.model, "inherit", `${agent.name} must expose a model placeholder`);
    assert.equal(agent.thinking, "inherit", `${agent.name} must expose a thinking placeholder`);
    assert.match(agent.prompt, /## Skills and web research/u);
    assert.match(agent.prompt, /load the most relevant skill/u);
  }
  assert.deepEqual(worker.tools, ["read", "grep", "find", "ls", "edit", "write", "bash", "web_search", "source_check", "fetch_content", "get_search_content"]);
  assert.equal(SUBAGENT_LIMITS.maxTasks, 10);
  assert.equal(SUBAGENT_LIMITS.maxReadConcurrency, 4);
  assert.equal(SUBAGENT_LIMITS.defaultMaxTurns, 64);
  assert.equal(SUBAGENT_LIMITS.defaultQuotaTokens, 2_000_000);
  assert.equal("maxTimeoutMs" in SUBAGENT_LIMITS, false);
  for (const agent of agents) assert.equal(agent.timeoutMs, undefined);
});

test("discovers bundled roles through the default module-relative agents path", () => {
  const agents = discoverAgentRoles(process.cwd(), "user", true, {
    userAgentsDir: path.join(process.cwd(), "test", "missing-agents"),
  }).agents;
  const names = agents.map((agent) => agent.name);
  assert.deepEqual(names, ["debugger", "documenter", "planner", "reviewer", "scout", "security", "tester", "worker"]);
  assert.equal(agents.every((agent) => agent.source === "bundled"), true);
});

test("Codex-style thread actions keep a completed handoff visible until close", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("Mapped auth"));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const spawned = await execute(tool, { action: "spawn", agent: "scout", task: "Map auth" }, ctx);
    const thread = spawned.details.threads.find((candidate) => candidate.state === "done");
    assert.ok(thread);
    assert.equal(thread.parentId, "main");
    assert.equal(thread.handoff.summary, "Mapped auth");
    assert.equal(spawned.details.activeThreads.length, 0);
    assert.equal(spawned.details.doneThreads.length, 1);

    const listed = await execute(tool, { action: "list" }, ctx);
    assert.equal(listed.details.doneThreads[0].id, thread.id);
    assert.match(listed.content[0].text, /Done \(1\)/u);

    const inspected = await execute(tool, { action: "inspect", threadId: thread.id }, ctx);
    assert.equal(inspected.details.selectedThreadId, thread.id);
    assert.match(inspected.content[0].text, new RegExp(`Inspect ${thread.id}`));

    await assert.rejects(execute(tool, { action: "interrupt", threadId: thread.id }, ctx), /Cannot interrupt thread/u);
    await assert.rejects(execute(tool, { action: "interrupt", threadId: "missing-thread" }, ctx), /Unknown child thread/u);

    const collected = await execute(tool, { action: "collect", threadId: thread.id }, ctx);
    assert.match(collected.content[0].text, /Mapped auth/u);

    const closed = await execute(tool, { action: "close", threadId: thread.id }, ctx);
    assert.equal(closed.details.threads.find((candidate) => candidate.id === thread.id).state, "closed");
    assert.equal(closed.details.doneThreads.length, 0);
    assert.equal((await execute(tool, { action: "list" }, ctx)).details.doneThreads.length, 0);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("closed and over-budget thread records become bounded tombstones", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { threadRetentionRecords: 2, threadRetentionBytes: 32 * 1024 },
      spawnProcess() {
        const child = new FakeProcess();
        setImmediate(() => {
          child.json(assistantEvent("retained handoff ".repeat(1_000)));
          child.close(0);
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const ids = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await execute(tool, { agent: "scout", task: `task ${index}` }, ctx);
      ids.push(result.details.results[0].id);
    }
    const listed = await execute(tool, { action: "list" }, ctx);
    assert.equal(listed.details.threads.every((thread) => thread.state !== "closed"), true);
    assert.ok(listed.details.doneThreads.length <= 2);
    const evicted = await execute(tool, { action: "inspect", threadId: ids[2] }, ctx);
    const tombstone = evicted.details.threads.find((thread) => thread.id === ids[2]);
    assert.equal(tombstone.state, "closed");
    assert.equal(tombstone.evicted, true);
    assert.match(evicted.content[0].text, /heavy thread data was evicted/u);
    const notice = await execute(tool, { action: "inspect", threadId: ids[1] }, ctx);
    assert.match(notice.content[0].text, /evicted from bounded retention/u);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("concurrent child spawns share the global task guard", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let child;
    let resolveStarted;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { maxTasks: 1 },
      spawnProcess() {
        child = new FakeProcess();
        resolveStarted();
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const first = execute(tool, { agent: "scout", task: "long task" }, ctx);
    await started;
    await assert.rejects(execute(tool, { agent: "scout", task: "second task" }, ctx), /active at once/u);
    child.json(assistantEvent("first task"));
    child.close(0);
    assert.equal((await first).details.results[0].status, "complete");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("queued interrupt marks the child stopped before its scheduler can start it", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let firstChild;
    let resolveStarted;
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    const updates = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { maxReadConcurrency: 1 },
      spawnProcess() {
        firstChild = new FakeProcess();
        resolveStarted();
        return firstChild;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, {
      tasks: [
        { agent: "scout", task: "active task" },
        { agent: "scout", task: "queued task" },
      ],
    }, ctx, new AbortController().signal, updates);
    await started;
    const queued = updates.at(-1).details.threads.find((thread) => thread.state === "queued");
    assert.ok(queued);
    const interrupted = await execute(tool, { action: "interrupt", threadId: queued.id }, ctx);
    assert.match(interrupted.content[0].text, new RegExp(`Interrupt requested for ${queued.id}`));
    firstChild.json(assistantEvent("active task"));
    firstChild.close(0);
    const result = await run;
    assert.deepEqual(result.details.results.map((entry) => entry.status), ["complete", "cancelled"]);
    assert.equal(result.details.results[1].terminationReason, "interrupt");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering restarts the same child thread and retains prior usage and trace", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let processCount = 0;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    const updates = [];
    const children = [];
    const childTasks = [];
    const childArgs = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args) {
        const child = new FakeProcess();
        children.push(child);
        childArgs.push(args);
        childTasks.push(args.at(-1));
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("first handoff", {
              stopReason: "toolUse",
              content: [
                { type: "toolCall", name: "read", arguments: { path: "first.ts" } },
                { type: "text", text: "first handoff" },
              ],
            }));
            resolveFirstMessage();
          });
        } else {
          setImmediate(() => {
            child.json(assistantEvent("second handoff", {
              content: [
                { type: "toolCall", name: "read", arguments: { path: "second.ts" } },
                { type: "text", text: "second handoff" },
              ],
            }));
            child.close(0);
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map both files" }, ctx, new AbortController().signal, updates);
    await firstMessage;
    const active = updates.at(-1).details.activeThreads[0];
    assert.ok(active);
    const steered = await execute(tool, { action: "steer", threadId: active.id, message: "Finish the second file" }, ctx);
    assert.equal(steered.details.results[0].status, "running");
    const result = await run;
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === active.id);
    assert.equal(processCount, 2);
    assert.equal(childArgs[0][childArgs[0].indexOf("--session-id") + 1], childArgs[1][childArgs[1].indexOf("--session-id") + 1]);
    assert.equal(childArgs[0][childArgs[0].indexOf("--session-dir") + 1], childArgs[1][childArgs[1].indexOf("--session-dir") + 1]);
    assert.equal(childArgs[0].includes("--no-session"), false);
    assert.match(childTasks[1], /Parent steering:[\s\S]*Finish the second file/u);
    assert.equal(task.status, "complete");
    assert.equal(task.output, "second handoff");
    assert.equal(task.usage.turns, 2);
    assert.equal(task.usage.totalTokens, 36);
    assert.match(task.trace.join("\n"), /first\.ts/u);
    assert.match(task.trace.join("\n"), /second\.ts/u);
    assert.equal(thread.steering.length, 1);
    assert.equal(thread.trace.length, 2);
    assert.equal(existsSync(childArgs[0][childArgs[0].indexOf("--session-dir") + 1]), false);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering waits for a forced child to exit before reusing its session", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let processCount = 0;
    let firstClosed = false;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    const childArgs = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      limits: { killGraceMs: 5 },
      spawnProcess(args) {
        const child = new FakeProcess();
        childArgs.push(args);
        processCount += 1;
        if (processCount === 1) {
          child.kill = (signal = "SIGTERM") => {
            child.killSignals.push(signal);
            return true;
          };
          setImmediate(() => {
            child.json(assistantEvent("first handoff", {
              stopReason: "toolUse",
              content: [{ type: "text", text: "first handoff" }],
            }));
            resolveFirstMessage();
          });
          setTimeout(() => {
            child.close(143);
            firstClosed = true;
          }, 1400);
        } else {
          assert.equal(firstClosed, true);
          setImmediate(() => {
            child.json(assistantEvent("second handoff"));
            child.close(0);
          });
        }
        return child;
      },
    });
    const updates = [];
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "map both files" }, ctx, new AbortController().signal, updates);
    await firstMessage;
    const active = updates.at(-1).details.activeThreads[0];
    assert.ok(active);
    await execute(tool, { action: "steer", threadId: active.id, message: "Finish" }, ctx);
    const result = await run;

    assert.equal(processCount, 2);
    assert.equal(firstClosed, true);
    assert.equal(childArgs[0][childArgs[0].indexOf("--session-dir") + 1], childArgs[1][childArgs[1].indexOf("--session-dir") + 1]);
    assert.equal(existsSync(childArgs[0][childArgs[0].indexOf("--session-dir") + 1]), false);
    assert.equal(result.details.results[0].status, "complete");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering settles a thread when the previous child never confirms exit", async () => {
  const roster = tempRoster();
  let sessionDirectory;
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    const updates = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { killGraceMs: 5 },
      spawnProcess(args) {
        sessionDirectory = args[args.indexOf("--session-dir") + 1];
        const child = new FakeProcess();
        child.kill = (signal = "SIGTERM") => {
          child.killSignals.push(signal);
          return true;
        };
        setImmediate(() => {
          child.json(assistantEvent("partial handoff", { stopReason: "toolUse" }));
          resolveFirstMessage();
        });
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const run = execute(tool, { agent: "scout", task: "finish the task" }, ctx, new AbortController().signal, updates);
    await firstMessage;
    const active = updates.at(-1).details.activeThreads[0];
    assert.ok(active);
    await execute(tool, { action: "steer", threadId: active.id, message: "Continue" }, ctx);
    const result = await run;
    const task = result.details.results[0];
    const thread = result.details.threads.find((candidate) => candidate.id === active.id);
    assert.equal(task.status, "failed");
    assert.equal(task.terminationReason, "process_exit_unconfirmed");
    assert.equal(thread.state, "failed");
    assert.equal(thread.failure.code, "process_exit_unconfirmed");
    assert.equal(existsSync(sessionDirectory), true);
  } finally {
    if (sessionDirectory) rmSync(sessionDirectory, { recursive: true, force: true });
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("steering keeps the same child quota across process restarts", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    let processCount = 0;
    let resolveFirstMessage;
    const firstMessage = new Promise((resolve) => { resolveFirstMessage = resolve; });
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { quotaTokens: 10 },
      spawnProcess() {
        const child = new FakeProcess();
        processCount += 1;
        if (processCount === 1) {
          setImmediate(() => {
            child.json(assistantEvent("first", {
              stopReason: "toolUse",
              usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            }));
            resolveFirstMessage();
          });
        } else {
          setImmediate(() => {
            child.json(assistantEvent("second", {
              usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            }));
          });
        }
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const updates = [];
    const run = execute(tool, { agent: "scout", task: "use one child budget" }, ctx, new AbortController().signal, updates);
    await firstMessage;
    const active = updates.at(-1).details.activeThreads[0];
    await execute(tool, { action: "steer", threadId: active.id, message: "Continue" }, ctx);
    const result = await run;

    assert.equal(processCount, 2);
    assert.equal(result.details.results[0].status, "limited");
    assert.equal(result.details.results[0].terminationReason, "quota_tokens");
    assert.equal(result.details.results[0].usage.totalTokens, 12);
    assert.equal(result.details.threads.find((thread) => thread.id === active.id).state, "stopped");
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});
