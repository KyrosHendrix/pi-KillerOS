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
};

type ActivityHarness = {
  emit(event: string, data?: Record<string, unknown>): Promise<void>;
  setIdle(value: boolean): void;
  setPendingMessages(value: boolean): void;
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

test("working messages use exact causal copy and sanitize custom tool names", () => {
  const cases: ReadonlyArray<readonly [ActivityMessage, string]> = [
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

function createActivityHarness(mode: ActivityContext["mode"] = "tui"): ActivityHarness {
  const handlers = new Map<string, ActivityHandler[]>();
  const workingMessages: Array<string | undefined> = [];
  const widgetCalls: boolean[] = [];
  let idle = true;
  let pendingMessages = false;
  const ctx: ActivityContext = {
    mode,
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
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
  const customMessage = harness.workingMessages.at(-1);
  assert.ok(customMessage);
  assert.match(customMessage, /^Working… .*question unsafe/u);
  await harness.emit("tool_execution_end", { toolName: "question", isError: true });
  const recoveryMessage = harness.workingMessages.at(-1);
  assert.ok(recoveryMessage);
  assert.match(recoveryMessage, /^Recovering…/u);
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
    frames: ["·", "✢", "✱", "✶", "✻", "✽", "✽", "✻", "✶", "✱", "✢", "·"],
    intervalMs: 120,
  });
  assert.equal(captured.hiddenThinkingLabel, "└ Thinking…");
  for (const handler of getHandlers(handlers, "agent_start")) handler({}, ctx);
  assert.equal(last(captured.workingMessages), "Mapping… (esc to interrupt · understanding request)");
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
      "<accent>·</accent>", "<accent>✢</accent>", "<accent>✱</accent>", "<accent>✶</accent>",
      "<accent>✻</accent>", "<accent>✽</accent>", "<accent>✽</accent>", "<accent>✻</accent>",
      "<accent>✶</accent>", "<accent>✱</accent>", "<accent>✢</accent>", "<accent>·</accent>",
    ],
    intervalMs: 120,
  });
  for (const handler of getHandlers(handlers, "agent_start")) handler({}, ctx);

  assert.match(
    last(captured.workingMessages) ?? "",
    /^<accent>Mapping…<\/accent> <dim>\(<bold>esc<\/bold> to interrupt · understanding request\)<\/dim>$/u,
  );
});
