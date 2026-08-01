import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { SubagentThreadRegistry } from "../subagent-lifecycle.ts";
import { runSubagentProcess } from "../subagent-process.ts";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killSignals = [];
  closeOnTerm = true;
  closed = false;

  json(event) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    if (this.closeOnTerm || signal === "SIGKILL") setImmediate(() => this.close(143));
    return true;
  }

  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

function threadSpec(overrides = {}) {
  return {
    role: "scout",
    prompt: "Map the codebase",
    model: "test/model",
    tools: ["read"],
    capabilityBoundary: {
      filesystem: "read",
      network: "read",
      process: "none",
      childThreads: false,
    },
    ...overrides,
  };
}

function piArgs() {
  return ["--mode", "json", "--no-session", "-p", "Do the task"];
}

function assistantEvent(text, overrides = {}) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "test",
      model: "child-model",
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

function runWith(child, options = {}) {
  return runSubagentProcess({
    args: piArgs(),
    cwd: process.cwd(),
    spawnProcess: () => child,
    ...options,
  });
}

test("registry keeps child id and parentId stable through queued, active, done, and closed", () => {
  let nextId = 0;
  const registry = new SubagentThreadRegistry({ createId: () => `thread-${++nextId}` });
  const changes = [];
  registry.subscribe((change) => changes.push(change));

  const parent = registry.spawn(threadSpec({ role: "planner" }));
  const child = registry.spawn(threadSpec({ parentId: parent.id }));
  assert.equal(child.id, "thread-2");
  assert.equal(child.parentId, parent.id);
  assert.equal(registry.inspect(child.id).id, child.id);

  registry.begin(child.id);
  const done = registry.complete(child.id, { result: "Mapped auth" });
  assert.equal(done.id, child.id);
  assert.equal(done.parentId, parent.id);
  assert.equal(registry.collect(child.id).result, "Mapped auth");

  const closed = registry.close(child.id);
  assert.equal(closed.state, "closed");
  assert.equal(closed.id, child.id);
  assert.equal(registry.inspect(child.id).state, "closed");
  assert.deepEqual(
    changes.filter((change) => change.thread.id === child.id).map((change) => `${change.type}:${change.thread.state}`),
    ["spawn:queued", "begin:active", "complete:done", "close:closed"],
  );
});

test("registry retains failed and stopped terminal records until close", () => {
  const registry = new SubagentThreadRegistry();
  const failed = registry.spawn(threadSpec());
  registry.begin(failed.id);
  registry.fail(failed.id, { message: "bad input", code: "INVALID_INPUT" });

  const stopped = registry.spawn(threadSpec());
  registry.begin(stopped.id);
  registry.stop(stopped.id, { reason: "resource_limit:wall_time" });

  assert.deepEqual(registry.collect(failed.id).failure, { message: "bad input", code: "INVALID_INPUT" });
  assert.equal(registry.inspect(stopped.id).stopReason, "resource_limit:wall_time");
  assert.deepEqual(registry.listDone().map((thread) => thread.state), ["failed", "stopped"]);

  assert.equal(registry.close(failed.id).state, "closed");
  assert.equal(registry.close(stopped.id).state, "closed");
  assert.equal(registry.inspect(failed.id).state, "closed");
  assert.equal(registry.inspect(stopped.id).state, "closed");
});

test("registry disposal stops queued work and closes every retained record", () => {
  const registry = new SubagentThreadRegistry();
  const active = registry.spawn(threadSpec());
  const queued = registry.spawn(threadSpec());
  registry.begin(active.id);

  registry.dispose();

  assert.equal(registry.isDisposed, true);
  assert.equal(registry.inspect(active.id).state, "closed");
  assert.equal(registry.inspect(queued.id).state, "closed");
  assert.equal(registry.inspect(active.id).stopReason, "disposed");
  assert.equal(registry.inspect(queued.id).stopReason, "disposed");
});

test("registry interrupts one active thread or every active thread", () => {
  const registry = new SubagentThreadRegistry();
  const first = registry.spawn(threadSpec());
  const second = registry.spawn(threadSpec());
  const third = registry.spawn(threadSpec());
  for (const thread of [first, second, third]) registry.begin(thread.id);

  assert.equal(registry.interrupt(first.id, "user_stop").stopReason, "user_stop");
  assert.deepEqual(
    registry.interruptAllActive("parent_stop").map((thread) => thread.id),
    [second.id, third.id],
  );
  assert.equal(registry.inspect(first.id).state, "stopped");
  assert.equal(registry.inspect(second.id).stopReason, "parent_stop");
  assert.equal(registry.inspect(third.id).stopReason, "parent_stop");
});

test("registry bounds steering history and returns defensive snapshots", () => {
  const registry = new SubagentThreadRegistry({ maxSteeringMessages: 2 });
  const seen = [];
  registry.subscribe((change) => seen.push(change.thread));
  const thread = registry.spawn(threadSpec({
    handoff: { summary: "Check auth", artifacts: ["auth.ts"] },
  }));
  thread.tools.push("write");
  thread.capabilityBoundary.filesystem = "write";
  thread.handoff.artifacts.push("changed.ts");
  seen[0].prompt = "changed";

  registry.begin(thread.id);
  registry.steer(thread.id, "check auth");
  registry.steer(thread.id, "check tests");
  registry.steer(thread.id, "check docs");
  const inspected = registry.inspect(thread.id);
  inspected.steering[0].message = "changed";
  inspected.handoff.artifacts.push("mutated.ts");

  const current = registry.inspect(thread.id);
  assert.deepEqual(current.steering.map((message) => message.message), ["check tests", "check docs"]);
  assert.deepEqual(current.tools, ["read"]);
  assert.equal(current.capabilityBoundary.filesystem, "read");
  assert.equal(current.prompt, "Map the codebase");
  assert.deepEqual(current.handoff.artifacts, ["auth.ts"]);
});

test("process completes naturally after multiple Pi assistant messages without a turn cap", async () => {
  const child = new FakeProcess();
  const updates = [];
  const handle = runWith(child, { onUpdate: (result) => updates.push(result) });

  child.json(assistantEvent("first", {
    stopReason: "toolUse",
    content: [{ type: "toolCall", name: "read", arguments: { path: "auth.ts" } }],
  }));
  child.json({ type: "tool_result_end", message: { toolName: "read", isError: false } });
  child.json(assistantEvent("final result"));
  child.close();
  const result = await handle.result;

  assert.equal(result.status, "complete");
  assert.equal(result.terminationReason, "completed");
  assert.equal(result.usage.turns, 2);
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.output, "final result");
  assert.match(result.trace.join("\n"), /read.*auth\.ts/u);
  assert.match(result.trace.join("\n"), /read result/u);
  assert.equal(child.killSignals.length, 0);
  assert.equal(updates.at(-1).status, "complete");
});

test("process applies output limit across assistant messages", async () => {
  const child = new FakeProcess();
  const handle = runWith(child, { limits: { outputBytes: 5 } });

  child.json(assistantEvent("123"));
  child.json(assistantEvent("456"));
  child.close();
  const result = await handle.result;

  assert.equal(result.status, "limited");
  assert.equal(result.terminationReason, "output_limit");
  assert.equal(result.output, "456");
  assert.equal(result.outputBytes, 6);
  assert.equal(result.outputTruncatedBytes, 1);
});

test("process reports malformed Pi JSONL as a named failure", async () => {
  const child = new FakeProcess();
  const handle = runWith(child);

  child.stdout.write("{not json}\n");
  const result = await handle.result;

  assert.equal(result.status, "failed");
  assert.equal(result.terminationReason, "malformed_jsonl");
  assert.match(result.errorMessage, /Malformed child JSONL/u);
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
});

test("process reports malformed final JSONL without a newline", async () => {
  const child = new FakeProcess();
  const handle = runWith(child);

  child.stdout.write("{not json}");
  child.close();
  const result = await handle.result;

  assert.equal(result.status, "failed");
  assert.equal(result.terminationReason, "malformed_jsonl");
  assert.match(result.errorMessage, /Malformed child JSONL/u);
});

test("process rejects malformed assistant usage", async () => {
  const child = new FakeProcess();
  const handle = runWith(child);

  child.json(assistantEvent("bad usage", { usage: { totalTokens: "6" } }));
  const result = await handle.result;

  assert.equal(result.status, "failed");
  assert.equal(result.terminationReason, "invalid_usage");
  assert.match(result.errorMessage, /usage must contain non-negative numbers/u);
});

test("process applies output limit to a final JSONL message without a newline", async () => {
  const child = new FakeProcess();
  const handle = runWith(child, { limits: { outputBytes: 3 } });

  child.stdout.write(JSON.stringify(assistantEvent("123456")));
  child.close();
  const result = await handle.result;

  assert.equal(result.status, "limited");
  assert.equal(result.terminationReason, "output_limit");
  assert.equal(result.output, "123");
  assert.equal(result.outputTruncatedBytes, 3);
});

test("process names wall, JSONL-line, and stderr limits", async () => {
  const scenarios = [
    {
      name: "wall",
      limits: { wallTimeMs: 10, killGraceMs: 5 },
      emit() {},
      reason: "wall_time_limit",
    },
    {
      name: "line",
      limits: { jsonlLineBytes: 16, killGraceMs: 5 },
      emit(child) { child.stdout.write("x".repeat(17)); },
      reason: "jsonl_line_limit",
    },
    {
      name: "stderr",
      limits: { stderrBytes: 5, killGraceMs: 5 },
      emit(child) { child.stderr.write("too much stderr"); },
      reason: "stderr_limit",
    },
    {
      name: "token quota",
      limits: { quotaTokens: 17, killGraceMs: 5 },
      emit(child) { child.json(assistantEvent("partial")); },
      reason: "quota_tokens",
    },
    {
      name: "cost quota",
      limits: { quotaUsd: 0.02, killGraceMs: 5 },
      emit(child) { child.json(assistantEvent("partial")); },
      reason: "quota_cost",
    },
  ];

  for (const scenario of scenarios) {
    const child = new FakeProcess();
    const handle = runWith(child, { limits: scenario.limits });
    scenario.emit(child);
    const result = await handle.result;
    assert.equal(result.status, "limited", scenario.name);
    assert.equal(result.terminationReason, scenario.reason, scenario.name);
    assert.deepEqual(child.killSignals, ["SIGTERM"], scenario.name);
  }
});

test("process retains partial output and escalates from SIGTERM to SIGKILL", async () => {
  const child = new FakeProcess();
  child.closeOnTerm = false;
  const handle = runWith(child, { limits: { killGraceMs: 5 } });

  child.json(assistantEvent("partial result"));
  handle.stop("user_stop");
  const result = await handle.result;

  assert.equal(result.status, "cancelled");
  assert.equal(result.terminationReason, "user_stop");
  assert.equal(result.output, "partial result");
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});
