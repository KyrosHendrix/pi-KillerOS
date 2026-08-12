import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  RequestActivityTrail,
  activityPhaseForTool,
  formatActivityMessage,
  registerRequestActivity,
  renderWorkTrail,
} from "../killeros/activity.ts";

const plainTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

const styledTheme = {
  bold: (text) => `<bold>${text}</bold>`,
  fg: (color, text) => `<${color}>${text}</${color}>`,
};

test("tool names map to observed request phases", () => {
  for (const name of ["read", "grep", "find", "ls"]) assert.equal(activityPhaseForTool(name), "inspect");
  for (const name of ["edit", "write"]) assert.equal(activityPhaseForTool(name), "change");
  assert.equal(activityPhaseForTool("bash"), "command");
  assert.equal(activityPhaseForTool("question"), "tool");
  assert.equal(activityPhaseForTool(" READ "), "inspect");
});

test("trail state collapses adjacent phases and keeps the latest four observed phases", () => {
  const trail = new RequestActivityTrail();
  trail.activate("prompt");
  trail.activate("inspect");
  trail.activate("inspect");
  assert.deepEqual(trail.getItems(), [
    { phase: "prompt", status: "done" },
    { phase: "inspect", status: "active" },
  ]);

  trail.failCurrent();
  assert.deepEqual(trail.getItems().at(-1), { phase: "inspect", status: "failed" });
  trail.activate("inspect");
  trail.completeCurrent();
  assert.deepEqual(trail.getItems().at(-1), { phase: "inspect", status: "done" });
  trail.activate("change");
  trail.activate("command");
  trail.activate("result");
  assert.deepEqual(trail.getItems(), [
    { phase: "inspect", status: "done" },
    { phase: "change", status: "done" },
    { phase: "command", status: "done" },
    { phase: "result", status: "active" },
  ]);
});

test("work trail is semantic, borderless, width-aware, and bounded", () => {
  const trail = new RequestActivityTrail();
  trail.activate("prompt");
  trail.activate("inspect");
  trail.activate("change");
  const wide = renderWorkTrail(trail.getItems(), 80, plainTheme);
  assert.deepEqual(wide, ["Prompt ✓  Inspect ✓  Change ›"]);
  assert.deepEqual(renderWorkTrail(trail.getItems(), 47, plainTheme), ["› Change"]);
  assert.doesNotMatch(wide[0], /[─│╭╮╰╯]/u);

  trail.failCurrent();
  assert.match(renderWorkTrail(trail.getItems(), 80, plainTheme)[0], /Change ×/u);
  for (let width = 1; width <= 180; width += 1) {
    assert.ok(renderWorkTrail(trail.getItems(), width, plainTheme).every((line) => visibleWidth(line) <= width));
  }
});

test("working messages use exact causal copy and sanitize custom tool names", () => {
  const cases = [
    [{ kind: "prompt" }, "Mapping… (esc to interrupt · understanding request)"],
    [{ kind: "tool", phase: "inspect", toolName: "read" }, "Inspecting… (esc to interrupt · reading relevant code)"],
    [{ kind: "tool", phase: "change", toolName: "edit" }, "Changing… (esc to interrupt · editing)"],
    [{ kind: "tool", phase: "command", toolName: "bash" }, "Running… (esc to interrupt · command)"],
    [{ kind: "tool-result", failed: false }, "Reviewing… (esc to interrupt · reading the result)"],
    [{ kind: "tool-result", failed: true }, "Recovering… (esc to interrupt · tool failed)"],
    [{ kind: "responding" }, "Responding… (esc to interrupt · assembling the answer)"],
  ];
  for (const [message, expected] of cases) assert.equal(formatActivityMessage(message, plainTheme), expected);

  const custom = formatActivityMessage({
    kind: "tool",
    phase: "tool",
    toolName: "danger\n\u0000  name ".repeat(10),
  }, plainTheme);
  assert.match(custom, /^Working… \(esc to interrupt · using danger name/u);
  assert.doesNotMatch(custom, /[\r\n\u0000]/u);
  assert.ok(visibleWidth(custom) < 100);

  assert.equal(
    formatActivityMessage({ kind: "prompt" }, styledTheme),
    "<accent>Mapping…</accent> <dim>(<bold>esc</bold> to interrupt · understanding request)</dim>",
  );
});

function createActivityHarness(mode = "tui") {
  const handlers = new Map();
  const workingMessages = [];
  const widgets = [];
  let idle = true;
  let pendingMessages = false;
  let renders = 0;
  let component;
  const tui = { requestRender: () => { renders += 1; } };
  const ctx = {
    mode,
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    ui: {
      theme: plainTheme,
      setWorkingMessage: (message) => workingMessages.push(message),
      setWidget: (key, content, options) => {
        widgets.push({ key, content, options });
        if (typeof content === "function") component = content(tui, plainTheme);
        if (content === undefined) component = undefined;
      },
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
    getComponent: () => component,
    getRenders: () => renders,
    setIdle: (value) => { idle = value; },
    setPendingMessages: (value) => { pendingMessages = value; },
    widgets,
    workingMessages,
  };
}

test("lifecycle copy and trail follow ordinary observed work", async () => {
  const harness = createActivityHarness();
  await harness.emit("agent_start");
  assert.deepEqual(harness.widgets[0], {
    key: "killeros-work-trail",
    content: harness.widgets[0].content,
    options: { placement: "aboveEditor" },
  });
  assert.deepEqual(harness.getComponent().render(80), ["Prompt ›"]);

  await harness.emit("tool_execution_start", { toolName: "read" });
  await harness.emit("tool_execution_end", { toolName: "read", isError: false });
  await harness.emit("tool_execution_start", { toolName: "edit" });
  await harness.emit("tool_execution_end", { toolName: "edit", isError: false });
  await harness.emit("message_update", { assistantMessageEvent: { type: "thinking_start" } });
  assert.deepEqual(harness.getComponent().render(80), ["Prompt ✓  Inspect ✓  Change ✓"]);
  await harness.emit("message_update", { assistantMessageEvent: { type: "text_start" } });

  assert.deepEqual(harness.getComponent().render(80), ["Prompt ✓  Inspect ✓  Change ✓  Result ›"]);
  assert.deepEqual(harness.workingMessages, [
    "Mapping… (esc to interrupt · understanding request)",
    "Inspecting… (esc to interrupt · reading relevant code)",
    "Reviewing… (esc to interrupt · reading the result)",
    "Changing… (esc to interrupt · editing)",
    "Reviewing… (esc to interrupt · reading the result)",
    "Responding… (esc to interrupt · assembling the answer)",
  ]);
  assert.ok(harness.getRenders() >= 5);
});

test("continuations preserve the trail and final settlement clears it", async () => {
  const harness = createActivityHarness();
  await harness.emit("agent_start");
  await harness.emit("tool_execution_start", { toolName: "bash" });
  harness.setIdle(false);
  await harness.emit("agent_settled");
  await harness.emit("agent_start");
  assert.deepEqual(harness.getComponent().render(80), ["Prompt ✓  Command ›"]);

  harness.setIdle(true);
  harness.setPendingMessages(true);
  await harness.emit("agent_settled");
  assert.ok(harness.getComponent());
  harness.setPendingMessages(false);
  await harness.emit("agent_settled");
  assert.equal(harness.getComponent(), undefined);
  assert.deepEqual(harness.widgets.at(-1), {
    key: "killeros-work-trail",
    content: undefined,
    options: undefined,
  });
  assert.equal(harness.workingMessages.at(-1), undefined);
});

test("errors, custom tools, shutdown, and non-TUI modes stay truthful", async () => {
  const harness = createActivityHarness();
  await harness.emit("agent_start");
  await harness.emit("tool_execution_start", { toolName: "question\nunsafe" });
  assert.match(harness.workingMessages.at(-1), /^Working… .*question unsafe/u);
  await harness.emit("tool_execution_end", { toolName: "question", isError: true });
  assert.deepEqual(harness.getComponent().render(80), ["Prompt ✓  Tool ×"]);
  assert.match(harness.workingMessages.at(-1), /^Recovering…/u);
  await harness.emit("session_shutdown");
  assert.equal(harness.getComponent(), undefined);

  for (const mode of ["rpc", "print", "json"]) {
    const nonTui = createActivityHarness(mode);
    await nonTui.emit("agent_start");
    await nonTui.emit("tool_execution_start", { toolName: "read" });
    await nonTui.emit("message_update", { assistantMessageEvent: { type: "text_start" } });
    await nonTui.emit("agent_settled");
    assert.deepEqual(nonTui.widgets, [], mode);
    assert.deepEqual(nonTui.workingMessages, [], mode);
  }
});
