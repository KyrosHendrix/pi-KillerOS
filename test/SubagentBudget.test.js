import assert from "node:assert/strict";
import test from "node:test";
import registerSubagentBudget, { parseChildToolBudget } from "../subagent-budget.ts";

function fakePi() {
  const handlers = new Map();
  const messages = [];
  return {
    messages,
    on(name, handler) {
      handlers.set(name, handler);
    },
    sendUserMessage(message, options) {
      messages.push({ message, options });
    },
    async toolCall(toolName) {
      const handler = handlers.get("tool_call");
      return handler ? handler({ toolName }) : undefined;
    },
  };
}

function withBudget(value, run) {
  const previous = process.env.PI_KILLEROS_TOOL_BUDGET;
  if (value === undefined) delete process.env.PI_KILLEROS_TOOL_BUDGET;
  else process.env.PI_KILLEROS_TOOL_BUDGET = JSON.stringify(value);
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.PI_KILLEROS_TOOL_BUDGET;
    else process.env.PI_KILLEROS_TOOL_BUDGET = previous;
  }
}

test("child tool budgets validate hard and soft limits", () => {
  assert.deepEqual(parseChildToolBudget(JSON.stringify({ soft: 2, hard: 4, block: ["read", "grep"] })), {
    soft: 2,
    hard: 4,
    block: ["read", "grep"],
  });
  assert.equal(parseChildToolBudget(JSON.stringify({ soft: 5, hard: 4, block: ["read"] })), undefined);
  assert.equal(parseChildToolBudget(JSON.stringify({ hard: 4, block: [] })), undefined);
  assert.equal(parseChildToolBudget("not json"), undefined);
});

test("soft nudges once and hard blocks only selected tools", async () => {
  await withBudget({ soft: 2, hard: 3, block: ["read"] }, async () => {
    const pi = fakePi();
    registerSubagentBudget(pi);
    assert.equal(await pi.toolCall("read"), undefined);
    assert.equal(await pi.toolCall("grep"), undefined);
    assert.equal(pi.messages.length, 1);
    assert.match(pi.messages[0].message, /finalize/u);
    assert.equal((await pi.toolCall("read"))?.block, undefined);
    assert.equal((await pi.toolCall("read"))?.block, true);
    assert.equal(await pi.toolCall("edit"), undefined);
    assert.equal(pi.messages.length, 1);
  });
});

test("no child budget leaves final text and tools available", async () => {
  await withBudget(undefined, async () => {
    const pi = fakePi();
    registerSubagentBudget(pi);
    assert.equal(await pi.toolCall("read"), undefined);
    assert.equal(pi.messages.length, 0);
  });
});

test("four read children hit their own small tool guard and can still report", async () => {
  const children = Array.from({ length: 4 }, () => fakePi());
  await withBudget({ soft: 2, hard: 3, block: ["read", "grep"] }, async () => {
    for (const pi of children) registerSubagentBudget(pi);
    for (const pi of children) {
      await pi.toolCall("read");
      await pi.toolCall("grep");
      await pi.toolCall("read");
      assert.equal((await pi.toolCall("read"))?.block, true);
      assert.equal(pi.messages.length, 1);
    }
  });
});
