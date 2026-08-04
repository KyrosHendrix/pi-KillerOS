import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBAGENT_PERSISTENCE_TYPE,
  createSubagentPersistence,
} from "../killeros/subagent-persistence.ts";

function threadSnapshot(overrides = {}) {
  return {
    id: "subagent-1",
    parentId: "main:parent",
    displayName: "reviewer",
    attempt: 1,
    role: "reviewer",
    prompt: "Map auth",
    model: "test/model",
    tools: ["read"],
    capabilityBoundary: {
      filesystem: "read",
      network: "read",
      process: "none",
      childThreads: false,
    },
    session: { id: "child-session-1", directory: "C:/tmp/killeros-child-1" },
    state: "queued",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      turns: 0,
    },
    handoff: undefined,
    result: undefined,
    failure: undefined,
    stopReason: undefined,
    evicted: false,
    timestamps: { createdAt: 50, updatedAt: 50 },
    version: 1,
    trace: [],
    steering: [],
    ...overrides,
  };
}

function customEntry({ event, thread, id, parentId, closedAt, result }) {
  return {
    type: "custom",
    customType: SUBAGENT_PERSISTENCE_TYPE,
    data: {
      version: 1,
      event,
      parentId: parentId ?? thread?.parentId,
      ...(thread ? { thread } : {}),
      ...(result ? { result } : {}),
      ...(id ? { id } : {}),
      ...(closedAt === undefined ? {} : { closedAt }),
    },
  };
}

function restoreFromEntries(entries, parentId = "main:parent") {
  return createSubagentPersistence(() => {}).restore(entries, parentId);
}

test("records spawn and terminal snapshots through Pi custom entries", () => {
  const entries = [];
  const persistence = createSubagentPersistence((type, data) => entries.push({ type, data }), () => 100);
  const thread = threadSnapshot({ id: "subagent-1", parentId: "main:parent", displayName: "reviewer" });
  persistence.recordSpawn(thread);
  persistence.recordSnapshot({ ...thread, state: "done", result: "Mapped auth" }, {
    id: thread.id,
    agent: "reviewer",
    name: "reviewer",
    task: "Map auth",
    status: "complete",
    output: "Mapped auth",
    outputBytes: 10,
  });
  assert.deepEqual(entries.map((entry) => entry.type), [SUBAGENT_PERSISTENCE_TYPE, SUBAGENT_PERSISTENCE_TYPE]);
  assert.equal(entries[0].data.version, 1);
  assert.equal(entries[0].data.event, "spawn");
  assert.equal(entries[1].data.event, "snapshot");
});

test("restores a result handoff when the snapshot thread omits its result", () => {
  const thread = threadSnapshot({ id: "subagent-2", state: "done" });
  const restored = restoreFromEntries([customEntry({
    event: "snapshot",
    thread,
    id: thread.id,
    result: {
      id: thread.id,
      name: thread.displayName,
      agent: thread.role,
      task: thread.prompt,
      status: "complete",
      output: "restored handoff",
      outputBytes: 17,
    },
  })]);
  assert.equal(restored[0].result, "restored handoff");
});

test("restores the latest snapshot and marks an interrupted active record orphaned", () => {
  const restored = restoreFromEntries([
    customEntry({ event: "spawn", thread: threadSnapshot({ id: "subagent-1", state: "active" }) }),
  ], "main:parent");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].state, "orphaned");
  assert.equal(restored[0].stopReason, "parent_restarted");
});

test("ignores malformed and foreign-parent entries and bounds persisted output", () => {
  const restored = restoreFromEntries([
    { type: "custom", customType: SUBAGENT_PERSISTENCE_TYPE, data: { version: 99 } },
    customEntry({ event: "spawn", thread: threadSnapshot({ id: "foreign", parentId: "main:other" }) }),
    customEntry({ event: "spawn", thread: threadSnapshot({ id: "local", output: "x".repeat(300_000) }) }),
  ], "main:parent");
  assert.deepEqual(restored.map((thread) => thread.id), ["local"]);
  assert.ok(Buffer.byteLength(restored[0].result ?? "", "utf8") <= 256 * 1024);
});

test("ignores invalid lifecycle usage, trace, and steering fields", () => {
  const restored = restoreFromEntries([
    customEntry({
      event: "spawn",
      thread: threadSnapshot({
        usage: { inputTokens: -1 },
        trace: [{ at: "invalid", kind: "child" }],
        steering: [{ id: 0, at: 1, message: "invalid" }],
      }),
    }),
  ], "main:parent");
  assert.deepEqual(restored, []);
});

test("ignores malformed result identity and usage", () => {
  const thread = threadSnapshot({ state: "done", result: "done" });
  const baseResult = {
    id: thread.id,
    name: thread.displayName,
    agent: thread.role,
    task: thread.prompt,
    status: "complete",
    output: "done",
    outputBytes: 4,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      turns: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  assert.deepEqual(restoreFromEntries([
    customEntry({ event: "snapshot", thread, result: { ...baseResult, id: "other" } }),
  ]), []);
  assert.deepEqual(restoreFromEntries([
    customEntry({ event: "snapshot", thread, result: { ...baseResult, usage: { input: -1 } } }),
  ]), []);
});

test("a close record restores a bounded closed tombstone", () => {
  const restored = restoreFromEntries([
    customEntry({ event: "spawn", thread: threadSnapshot({
      id: "subagent-1",
      state: "done",
      prompt: "secret prompt",
      steering: [{ id: 1, at: 100, message: "secret steering" }],
    }) }),
    customEntry({ event: "close", id: "subagent-1", parentId: "main:parent", closedAt: 200 }),
  ], "main:parent");
  assert.equal(restored[0].state, "closed");
  assert.equal(restored[0].evicted, true);
  assert.equal(restored[0].prompt, "[closed thread prompt evicted]");
  assert.deepEqual(restored[0].steering, []);
  assert.equal(restored[0].result, undefined);
});

test("recordClose writes a parent-scoped tombstone timestamp", () => {
  const entries = [];
  const persistence = createSubagentPersistence((type, data) => entries.push({ type, data }), () => 100);
  persistence.recordClose(threadSnapshot({ id: "subagent-1", state: "done" }));
  assert.deepEqual(entries[0], {
    type: SUBAGENT_PERSISTENCE_TYPE,
    data: { version: 1, event: "close", parentId: "main:parent", id: "subagent-1", closedAt: 100 },
  });
});

test("bounds persisted prompt, tools, artifacts, trace, and task output", () => {
  const entries = [];
  const persistence = createSubagentPersistence((type, data) => entries.push({ type, data }));
  const thread = threadSnapshot({
    prompt: "p".repeat(25_000),
    tools: ["t".repeat(100), ...Array.from({ length: 40 }, (_, index) => `tool-${index}`)],
    handoff: { summary: "handoff", artifacts: ["a".repeat(600), ...Array.from({ length: 40 }, (_, index) => `artifact-${index}`)] },
    trace: [{ at: 1, kind: "trace", message: "x".repeat(100_000) }],
  });
  persistence.recordSnapshot(thread, {
    id: thread.id,
    name: thread.displayName,
    agent: thread.role,
    task: thread.prompt,
    status: "complete",
    output: "o".repeat(300_000),
    outputBytes: 300_000,
  });
  const data = entries[0].data;
  assert.ok(data.thread.prompt.length <= 20_000);
  assert.equal(data.thread.tools.length, 32);
  assert.ok(data.thread.tools.every((tool) => tool.length <= 64));
  assert.equal(data.thread.handoff.artifacts.length, 32);
  assert.ok(data.thread.handoff.artifacts.every((artifact) => artifact.length <= 512));
  assert.ok(Buffer.byteLength(JSON.stringify(data.thread.trace), "utf8") <= 64 * 1024);
  assert.ok(Buffer.byteLength(data.result.output, "utf8") <= 256 * 1024);
});
