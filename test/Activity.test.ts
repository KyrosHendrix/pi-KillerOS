import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { type ActivityMessage, formatActivityMessage, registerRequestActivity } from "../killeros/activity.ts";
import { extensionApiTestAdapter, themeTestAdapter } from "./PiTestAdapters.ts";
import { createHarness, createTuiContext, getHandlers, last } from "./ExtensionTestHarness.ts";

type ActivityEvent = {
  type: string;
  toolName?: string;
  isError?: boolean;
  assistantMessageEvent?: { type: string };
};

type ActivityHandler = (event: ActivityEvent, ctx: ActivityContext) => void | Promise<void>;

type ActivityAPI = { on(event: string, handler: ActivityHandler): void };

type ActivityContext = Pick<ExtensionContext, "mode" | "hasPendingMessages" | "isIdle"> & {
  ui: Pick<ExtensionContext["ui"], "theme" | "setWorkingMessage" | "setWidget">;
  model?: { id?: string; name?: string };
};

type ActivityHarness = {
  emit(event: string, data?: Record<string, unknown>): Promise<void>;
  setIdle(value: boolean): void;
  setPendingMessages(value: boolean): void;
  setModel(model: { id?: string; name?: string } | undefined): void;
  widgetCalls: boolean[];
  workingMessages: Array<string | undefined>;
};

const plainTheme = themeTestAdapter({
  bold(text: string): string { return text; },
  fg(_color: string, text: string): string { return text; },
});

const styledTheme = themeTestAdapter({
  bold(text: string): string { return `<bold>${text}</bold>`; },
  fg(color: string, text: string): string { return `<${color}>${text}</${color}>`; },
});

test("working messages append the model suffix to every activity state", () => {
  const cases: ReadonlyArray<readonly [ActivityMessage, string]> = [
    [{ kind: "prompt" }, "Mapping… (esc to interrupt · understanding request) · gpt-5.4"],
    [{ kind: "tool", toolName: "read" }, "Inspecting… (esc to interrupt · reading relevant code) · gpt-5.4"],
    [{ kind: "tool", toolName: "edit" }, "Changing… (esc to interrupt · editing) · gpt-5.4"],
    [{ kind: "tool", toolName: "bash" }, "Running… (esc to interrupt · command) · gpt-5.4"],
    [{ kind: "tool", toolName: "my-tool" }, "Working… (esc to interrupt · using my-tool) · gpt-5.4"],
    [{ kind: "tool-result", failed: false }, "Reviewing… (esc to interrupt · reading the result) · gpt-5.4"],
    [{ kind: "tool-result", failed: true }, "Recovering… (esc to interrupt · tool failed) · gpt-5.4"],
    [{ kind: "responding" }, "Responding… (esc to interrupt · assembling the answer) · gpt-5.4"],
  ];
  for (const [message, expected] of cases) assert.equal(formatActivityMessage(message, plainTheme, "gpt-5.4"), expected);

  const custom = formatActivityMessage({
    kind: "tool",
    toolName: "danger\n\u0000  name ".repeat(10),
  }, plainTheme, "gpt-5.4");
  assert.match(custom, /^Working… \(esc to interrupt · using danger name/u);
  assert.match(custom, / · gpt-5\.4$/u);
  assert.doesNotMatch(custom, /[\r\n\u0000]/u);
  assert.ok(custom.length < 120);

  assert.equal(
    formatActivityMessage({ kind: "prompt" }, styledTheme, "gpt-5.4"),
    "<accent>Mapping…</accent> <dim>(<bold>esc</bold> to interrupt · understanding request)</dim><dim> · gpt-5.4</dim>",
  );
  assert.equal(formatActivityMessage({ kind: "prompt" }, plainTheme),
    "Mapping… (esc to interrupt · understanding request) · unknown model");
  assert.equal(formatActivityMessage({ kind: "prompt" }, plainTheme, "  GPT-5.4  "),
    "Mapping… (esc to interrupt · understanding request) · gpt-5.4");

  const unsafeModel = formatActivityMessage({ kind: "prompt" }, plainTheme, "[31mGPT\n5.4");
  assert.equal(unsafeModel, "Mapping… (esc to interrupt · understanding request) · gpt5.4");
  assert.doesNotMatch(unsafeModel, /[\r\n]/u);
});

function createActivityHarness(
  mode: ActivityContext["mode"] = "tui",
  model: { id?: string; name?: string } | undefined = { id: "gpt-5.4", name: "GPT" },
): ActivityHarness {
  const handlers = new Map<string, ActivityHandler[]>();
  const workingMessages: Array<string | undefined> = [];
  const widgetCalls: boolean[] = [];
  let idle = true;
  let pendingMessages = false;
  let currentModel: { id?: string; name?: string } | undefined = model;
  const ctx: ActivityContext = {
    mode,
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    get model(): { id?: string; name?: string } | undefined { return currentModel; },
    ui: {
      theme: plainTheme,
      setWorkingMessage: (message?: string) => { workingMessages.push(message); },
      setWidget: () => widgetCalls.push(true),
    },
  };
  const api: ActivityAPI = {
    on: (event: string, handler: ActivityHandler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
  };
  registerRequestActivity(extensionApiTestAdapter(api));

  return {
    emit: async (event: string, data: Record<string, unknown> = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
    },
    setIdle: (value: boolean) => { idle = value; },
    setPendingMessages: (value: boolean) => { pendingMessages = value; },
    setModel: (value: { id?: string; name?: string } | undefined) => { currentModel = value; },
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
    "Mapping… (esc to interrupt · understanding request) · gpt-5.4",
    "Inspecting… (esc to interrupt · reading relevant code) · gpt-5.4",
    "Reviewing… (esc to interrupt · reading the result) · gpt-5.4",
    "Changing… (esc to interrupt · editing) · gpt-5.4",
    "Reviewing… (esc to interrupt · reading the result) · gpt-5.4",
    "Responding… (esc to interrupt · assembling the answer) · gpt-5.4",
  ]);
});

test("the request cycle retains its starting model until settlement", async () => {
  const harness = createActivityHarness();
  await harness.emit("agent_start");

  harness.setModel({ id: "claude-sonnet-4-6" });
  await harness.emit("agent_start");
  await harness.emit("tool_execution_start", { toolName: "read" });
  assert.equal(harness.workingMessages.at(-1),
    "Inspecting… (esc to interrupt · reading relevant code) · gpt-5.4");

  await harness.emit("agent_settled");
  await harness.emit("agent_start");
  assert.equal(harness.workingMessages.at(-1),
    "Mapping… (esc to interrupt · understanding request) · claude-sonnet-4-6");
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
  const customMessage = harness.workingMessages.at(-1);
  assert.ok(customMessage);
  assert.match(customMessage, /^Working… .*question unsafe/u);
  assert.match(customMessage, / · gpt-5\.4$/u);
  await harness.emit("tool_execution_end", { toolName: "question", isError: true });
  const recoveryMessage = harness.workingMessages.at(-1);
  assert.ok(recoveryMessage);
  assert.match(recoveryMessage, /^Recovering…/u);
  assert.match(recoveryMessage, / · gpt-5\.4$/u);
  await harness.emit("session_shutdown");
  assert.equal(harness.workingMessages.at(-1), undefined);

  for (const mode of ["rpc", "print", "json"] as const) {
    const nonTui = createActivityHarness(mode);
    await nonTui.emit("agent_start");
    await nonTui.emit("tool_execution_start", { toolName: "read" });
    await nonTui.emit("message_update", { assistantMessageEvent: { type: "text_start" } });
    await nonTui.emit("agent_settled");
    assert.deepEqual(nonTui.workingMessages, [], mode);
  }
});

type TestStyle = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

type TestFullStyle = TestStyle & {
  italic(text: string): string;
  strikethrough(text: string): string;
  underline(text: string): string;
};

test("activity keeps the animated orange glyph loop and uses contextual request copy", () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  assert.deepEqual(captured.workingIndicator, {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs: 80,
  });
  assert.equal(captured.hiddenThinkingLabel, "└ Thinking…");
  for (const handler of getHandlers(handlers, "agent_start")) handler({}, ctx);
  assert.equal(last(captured.workingMessages), "Mapping… (esc to interrupt · understanding request) · test-model");
  assert.equal(captured.widgetComponent, undefined);
});

test("activity styles the glyph and causal verb orange with a gray bold interrupt status", () => {
  const styledTheme: TestFullStyle = {
    bold: (text) => `<bold>${text}</bold>`,
    fg: (color, text) => `<${color}>${text}</${color}>`,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
  };
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext([], themeTestAdapter(styledTheme));
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  assert.deepEqual(captured.workingIndicator, {
    frames: [
      "<accent>⠋</accent>", "<accent>⠙</accent>", "<accent>⠹</accent>", "<accent>⠸</accent>",
      "<accent>⠼</accent>", "<accent>⠴</accent>", "<accent>⠦</accent>", "<accent>⠧</accent>",
      "<accent>⠇</accent>", "<accent>⠏</accent>",
    ],
    intervalMs: 80,
  });
  for (const handler of getHandlers(handlers, "agent_start")) handler({}, ctx);

  assert.match(
    last(captured.workingMessages) ?? "",
    /^<accent>Mapping…<\/accent> <dim>\(<bold>esc<\/bold> to interrupt · understanding request\)<\/dim><dim> · test-model<\/dim>$/u,
  );
});
