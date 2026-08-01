import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  SUBAGENT_LIMITS,
  childProcessEnvironment,
  discoverAgentRoles,
  registerSubagentTool,
  resolveAgentModel,
} from "../subagents.ts";

function roleFile({
  name,
  description = `${name} role`,
  access = "read",
  tools = "read, grep, find, ls, web_search, source_check, fetch_content, get_search_content",
  model,
  maxTurns = 8,
  timeoutMs = 300000,
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
    `maxTurns: ${maxTurns}`,
    `timeoutMs: ${timeoutMs}`,
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
  registerSubagentTool({ registerTool(value) { tool = value; } }, options);
  assert.ok(tool);
  return tool;
}

function toolContext(cwd, { trusted = true, confirm = true, models } = {}) {
  return {
    ...modelContext(models),
    cwd,
    hasUI: true,
    isProjectTrusted: () => trusted,
    ui: { confirm: async () => confirm },
  };
}

async function execute(tool, params, ctx, signal = new AbortController().signal, updates = []) {
  return tool.execute("subagent-test", params, signal, (update) => updates.push(update), ctx);
}

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
    maxTurns: 8,
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

test("isolated child invocation uses explicit tools and reports bounded output, trace, usage, and unique task IDs", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const calls = [];
    const promptPaths = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      spawnProcess(args, cwd) {
        calls.push({ args, cwd });
        const promptPath = args[args.indexOf("--append-system-prompt") + 1];
        promptPaths.push(promptPath);
        assert.equal(existsSync(promptPath), true);
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
    for (const flag of ["--mode", "--no-session", "--no-extensions", "--extension", "--no-prompt-templates", "--approve", "--model", "--thinking", "--tools"]) {
      assert.ok(args.includes(flag), `missing child flag ${flag}`);
    }
    assert.equal(args[args.indexOf("--extension") + 1], "npm:pi-web-access");
    assert.equal(args.includes("--no-skills"), false);
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls,web_search,source_check,fetch_content,get_search_content");
    assert.equal(args[args.indexOf("--model") + 1], "test/parent-model");
    assert.equal(args[args.indexOf("--thinking") + 1], "high");
    assert.ok(promptPaths.every((promptPath) => !existsSync(promptPath)), "temporary prompts must be removed");
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
    }, toolContext(roster.root)), /exactly one subagent mode/u);
    await assert.rejects(execute(tool, {
      task: "stray task",
      chain: [{ agent: "scout", task: "map" }],
    }, toolContext(roster.root)), /exactly one subagent mode/u);
    assert.equal(spawned, 0);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("parallel execution caps readers, waits before the writer, and rejects multiple writers", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    writeRole(roster.bundled, "reviewer.md", { name: "reviewer" });
    writeRole(roster.bundled, "worker.md", { name: "worker", access: "write", tools: "read, edit, write, bash" });
    let activeReaders = 0;
    let peakReaders = 0;
    let writerStartedWithReaders = false;
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
        if (writer) writerStartedWithReaders = activeReaders > 0;
        else {
          activeReaders += 1;
          peakReaders = Math.max(peakReaders, activeReaders);
        }
        setTimeout(() => {
          child.json(assistantEvent(writer ? "written" : "read"));
          if (!writer) activeReaders -= 1;
          child.close(0);
        }, 20);
        return child;
      },
    });
    const ctx = toolContext(roster.root);
    const result = await execute(tool, {
      tasks: [
        { agent: "scout", task: "one" },
        { agent: "reviewer", task: "two" },
        { agent: "scout", task: "three" },
        { agent: "worker", task: "write after reads" },
      ],
    }, ctx);
    assert.equal(result.details.results.every((entry) => entry.status === "complete"), true);
    assert.equal(peakReaders, 2);
    assert.equal(writerStartedWithReaders, false);

    await assert.rejects(execute(tool, {
      tasks: [
        { agent: "worker", task: "one" },
        { agent: "worker", task: "two" },
      ],
    }, ctx), /at most one write-capable/u);
    assert.equal(spawned, 4);
  } finally {
    rmSync(roster.root, { recursive: true, force: true });
  }
});

test("turn, retained trace, stderr, malformed JSONL, timeout, and output limits fail or truncate visibly", async () => {
  const scenarios = [
    {
      name: "turn",
      role: { name: "agent", maxTurns: 1 },
      emit(child) {
        child.json(assistantEvent("tool requested at the cap", {
          stopReason: "toolUse",
          content: [{ type: "toolCall", name: "read", arguments: { path: "next.ts" } }],
        }));
        child.close(0);
      },
      expectedStatus: "limited",
      expectedReason: "turn_limit",
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
      expectedStatus: "complete",
      expectedReason: "completed",
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
      expectedStatus: "limited",
      expectedReason: "model_output_limit",
    },
    {
      name: "output",
      role: { name: "agent" },
      limits: { taskOutputBytes: 10 },
      emit(child) { child.json(assistantEvent("0123456789EXTRA")); child.close(0); },
      expectedStatus: "complete",
      expectedReason: "completed",
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
    assert.equal(result.details.results[0].terminationReason, "timeout");
  } finally {
    rmSync(timeoutRoster.root, { recursive: true, force: true });
  }
});

test("child lifecycle rejects empty success, recovers transient retries, and caps retry errors", async () => {
  const scenarios = [
    {
      name: "empty",
      maxTurns: 8,
      emit(child) { child.close(0); },
      status: "failed",
      reason: "missing_assistant_message",
      turns: 0,
    },
    {
      name: "recovered",
      maxTurns: 8,
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
      maxTurns: 1,
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
      maxTurns: 1,
      emit(child) {
        child.json(assistantEvent("", { stopReason: "error", errorMessage: "retryable provider failure", content: [] }));
        child.json({ type: "agent_end", willRetry: true });
        setImmediate(() => {
          if (child.closed) return;
          child.json(assistantEvent("EXTRA_REQUEST"));
          child.close(0);
        });
      },
      status: "limited",
      reason: "turn_limit",
      turns: 1,
    },
  ];

  for (const scenario of scenarios) {
    const roster = tempRoster();
    try {
      writeRole(roster.bundled, "agent.md", { name: "agent", maxTurns: scenario.maxTurns });
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

test("an abort raised during child startup is not missed", async () => {
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

test("abort cancels active and queued tasks and force-kill escalation settles a resistant child", async () => {
  const roster = tempRoster();
  try {
    writeRole(roster.bundled, "scout.md", { name: "scout" });
    const controller = new AbortController();
    const children = [];
    const tool = createToolHarness({
      bundledAgentsDir: roster.bundled,
      userAgentsDir: roster.personal,
      limits: { maxReadConcurrency: 1, killGraceMs: 10 },
      spawnProcess() {
        const child = new FakeProcess();
        child.closeOnTerminate = false;
        children.push(child);
        setImmediate(() => controller.abort());
        return child;
      },
    });
    const result = await execute(tool, {
      tasks: [
        { agent: "scout", task: "active" },
        { agent: "scout", task: "queued" },
      ],
    }, toolContext(roster.root), controller.signal);
    assert.deepEqual(result.details.results.map((entry) => entry.status), ["cancelled", "cancelled"]);
    assert.deepEqual(children[0].killSignals, ["SIGTERM", "SIGKILL"]);
  } finally {
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
    assert.match(agent.prompt, /## Skills and web research/u);
    assert.match(agent.prompt, /load the most relevant skill/u);
  }
  assert.deepEqual(worker.tools, ["read", "grep", "find", "ls", "edit", "write", "bash", "web_search", "source_check", "fetch_content", "get_search_content"]);
  assert.equal(SUBAGENT_LIMITS.maxTasks, 8);
  assert.equal(SUBAGENT_LIMITS.maxReadConcurrency, 4);
  assert.equal(SUBAGENT_LIMITS.maxTurns, 12);
  assert.equal(SUBAGENT_LIMITS.maxTimeoutMs, 600000);
});
