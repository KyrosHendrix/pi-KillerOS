import assert from "node:assert/strict";
import test from "node:test";
import {
  formatActivityMessage,
  registerRequestActivity,
} from "../killeros/activity.ts";

const plainTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

const styledTheme = {
  bold: (text) => `<bold>${text}</bold>`,
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

test("working messages use exact causal copy and sanitize custom tool names", () => {
  const cases = [
    [{ kind: "prompt" }, "Mapping… (esc to interrupt · understanding request)"],
    [{ kind: "tool", toolName: "read" }, "Inspecting… (esc to interrupt · reading relevant code)"],
    [{ kind: "tool", toolName: "edit" }, "Changing… (esc to interrupt · editing)"],
    [{ kind: "tool", toolName: "bash" }, "Running… (esc to interrupt · command)"],
    [{ kind: "tool-result", failed: false }, "Reviewing… (esc to interrupt · reading the result)"],
    [{ kind: "tool-result", failed: true }, "Recovering… (esc to interrupt · tool failed)"],
    [{ kind: "responding" }, "Responding… (esc to interrupt · assembling the answer)"],
  ];
  for (const [message, expected] of cases) assert.equal(formatActivityMessage(message, plainTheme), expected);

  const custom = formatActivityMessage({
    kind: "tool",
    toolName: "danger\n\u0000  name ".repeat(10),
  }, plainTheme);
  assert.match(custom, /^Working… \(esc to interrupt · using danger name/u);
  assert.doesNotMatch(custom, /[\r\n\u0000]/u);
  assert.ok(custom.length < 100);

  assert.equal(
    formatActivityMessage({ kind: "prompt" }, styledTheme),
    "<accent>Mapping…</accent> <dim>(<bold>esc</bold> to interrupt · understanding request)</dim>",
  );
});

function createActivityHarness(mode = "tui") {
  const handlers = new Map();
  const workingMessages = [];
  const widgetCalls = [];
  let idle = true;
  let pendingMessages = false;
  const ctx = {
    mode,
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    ui: {
      theme: plainTheme,
      setWorkingMessage: (message) => workingMessages.push(message),
      setWidget: () => widgetCalls.push(true),
    },
  };
  const api = {
    on: (event, handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
  };
  registerRequestActivity(api);

  return {
    emit: async (event, data = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
    },
    setIdle: (value) => { idle = value; },
    setPendingMessages: (value) => { pendingMessages = value; },
    widgetCalls,
    workingMessages,
  };
}

test("lifecycle copy follows ordinary observed work", async () => {
  const harness = createActivityHarness();
  await harness.emit("agent_start");
  assert.deepEqual(harness.widgetCalls, []);

  await harness.emit("tool_execution_start", { toolName: "read" });
  await harness.emit("tool_execution_end", { toolName: "read", isError: false });
  await harness.emit("tool_execution_start", { toolName: "edit" });
  await harness.emit("tool_execution_end", { toolName: "edit", isError: false });
  await harness.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
  await harness.emit("message_update", { assistantMessageEvent: { type: "text_start" } });

  assert.deepEqual(harness.workingMessages, [
    "Mapping… (esc to interrupt · understanding request)",
    "Inspecting… (esc to interrupt · reading relevant code)",
    "Reviewing… (esc to interrupt · reading the result)",
    "Changing… (esc to interrupt · editing)",
    "Reviewing… (esc to interrupt · reading the result)",
    "Responding… (esc to interrupt · assembling the answer)",
  ]);
});

test("settlement clears the working message after pending work finishes", async () => {
  const harness = createActivityHarness();
  await harness.emit("tool_execution_start", { toolName: "read" });
  await harness.emit("tool_execution_end", { toolName: "read", isError: false });
  await harness.emit("message_update", { assistantMessageEvent: { type: "text_start" } });
  await harness.emit("agent_settled");
  assert.deepEqual(harness.workingMessages, []);
  await harness.emit("agent_start");
  await harness.emit("tool_execution_start", { toolName: "bash" });
  harness.setIdle(false);
  await harness.emit("agent_settled");
  await harness.emit("agent_start");

  harness.setIdle(true);
  harness.setPendingMessages(true);
  await harness.emit("agent_settled");
  assert.notEqual(harness.workingMessages.at(-1), undefined);
  harness.setPendingMessages(false);
  await harness.emit("agent_settled");
  assert.equal(harness.workingMessages.at(-1), undefined);
});

test("errors, custom tools, shutdown, and non-TUI modes stay truthful", async () => {
  const harness = createActivityHarness();
  await harness.emit("agent_start");
  await harness.emit("tool_execution_start", { toolName: "question\nunsafe" });
  assert.match(harness.workingMessages.at(-1), /^Working… .*question unsafe/u);
  await harness.emit("tool_execution_end", { toolName: "question", isError: true });
  assert.match(harness.workingMessages.at(-1), /^Recovering…/u);
  await harness.emit("session_shutdown");
  assert.equal(harness.workingMessages.at(-1), undefined);

  for (const mode of ["rpc", "print", "json"]) {
    const nonTui = createActivityHarness(mode);
    await nonTui.emit("agent_start");
    await nonTui.emit("tool_execution_start", { toolName: "read" });
    await nonTui.emit("message_update", { assistantMessageEvent: { type: "text_start" } });
    await nonTui.emit("agent_settled");
    assert.deepEqual(nonTui.workingMessages, [], mode);
  }
});
