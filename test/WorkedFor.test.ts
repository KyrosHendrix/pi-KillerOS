import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { StopReason } from "@earendil-works/pi-ai";
import test from "node:test";
import {
  formatWorkedForDuration,
  registerWorkedFor,
  type WorkedForOutcome,
  workedForOutcome,
} from "../killeros/worked-for.ts";

type WorkedForEvent = {
  type: string;
  messages?: Array<{ role?: string; stopReason?: StopReason }>;
};

type WorkedForSessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];
type WorkedForContext = Pick<ExtensionContext, "mode" | "hasPendingMessages" | "isIdle"> & {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries">;
  ui: Pick<ExtensionContext["ui"], "notify">;
};

type WorkedForHandler = (event: WorkedForEvent, ctx: WorkedForContext) => void | Promise<void>;
type WorkedForAPI = {
  appendEntry(customType: string, data: unknown): void;
  on(event: string, handler: WorkedForHandler): void;
  registerEntryRenderer(customType: string, renderer: WorkedForRenderer): void;
};
type WorkedForRenderer = (
  entry: { data: unknown },
  options: unknown,
  theme: Theme,
) => { render(width: number): string[] } | undefined;

type WorkedForEntry = { customType: string; data: Record<string, unknown> };
type NotificationLevel = Parameters<ExtensionContext["ui"]["notify"]>[1];

type WorkedForHarness = {
  appendedEntries: WorkedForEntry[];
  emit(event: string, data?: Partial<WorkedForEvent>): Promise<void>;
  notices: Array<{ message: string; level: NotificationLevel }>;
  renderers: Map<string, WorkedForRenderer>;
  setAppendError(error: Error | undefined): void;
  setIdle(value: boolean): void;
  setPendingMessages(value: boolean): void;
  setSessionEntries(entries: WorkedForSessionEntry[]): void;
  setSessionError(error: Error | undefined): void;
  setTime(milliseconds: number): void;
};

function createWorkedForHarness(mode: WorkedForContext["mode"] = "tui"): WorkedForHarness {
  let currentTime = 0;
  let appendError: Error | undefined;
  let idle = true;
  let pendingMessages = false;
  let sessionEntries: WorkedForSessionEntry[] = [];
  let sessionError: Error | undefined;
  const appendedEntries: WorkedForEntry[] = [];
  const handlers = new Map<string, WorkedForHandler[]>();
  const notices: Array<{ message: string; level: NotificationLevel }> = [];
  const renderers = new Map<string, WorkedForRenderer>();
  const api: WorkedForAPI = {
    appendEntry: (customType: string, data: unknown) => {
      if (appendError) throw appendError;
      appendedEntries.push({ customType, data: data as Record<string, unknown> });
    },
    on: (event: string, handler: WorkedForHandler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerEntryRenderer: (customType: string, renderer: WorkedForRenderer) => {
      renderers.set(customType, renderer);
    },
  };
  const ctx: WorkedForContext = {
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    mode,
    sessionManager: { getEntries: () => {
      if (sessionError) throw sessionError;
      return sessionEntries;
    } },
    ui: { notify: (message: string, level?: NotificationLevel) => notices.push({ message, level }) },
  };
  registerWorkedFor(api as unknown as ExtensionAPI, () => currentTime);

  return {
    appendedEntries,
    emit: async (event: string, data: Partial<WorkedForEvent> = {}) => {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...data }, ctx);
    },
    notices,
    renderers,
    setAppendError: (error: Error | undefined) => { appendError = error; },
    setIdle: (value: boolean) => { idle = value; },
    setPendingMessages: (value: boolean) => { pendingMessages = value; },
    setSessionEntries: (entries: WorkedForSessionEntry[]) => { sessionEntries = entries; },
    setSessionError: (error: Error | undefined) => { sessionError = error; },
    setTime: (milliseconds: number) => { currentTime = milliseconds; },
  };
}

const theme = { fg: (_color: string, text: string): string => text } as unknown as Theme;

function usageEntry(type: "assistant" | "toolResult" | "compaction" | "branch_summary", totalTokens: number): WorkedForSessionEntry {
  if (type === "compaction" || type === "branch_summary") {
    return { type, usage: { totalTokens } } as WorkedForSessionEntry;
  }
  return {
    type: "message",
    message: { role: type, usage: { totalTokens } },
  } as WorkedForSessionEntry;
}

test("worked-for durations use compact mixed units with a one-second minimum", () => {
  assert.equal(formatWorkedForDuration(0), "1s");
  assert.equal(formatWorkedForDuration(999), "1s");
  assert.equal(formatWorkedForDuration(8_999), "8s");
  assert.equal(formatWorkedForDuration(60_000), "1m 00s");
  assert.equal(formatWorkedForDuration(125_999), "2m 05s");
  assert.equal(formatWorkedForDuration(3_600_000), "1h 00m");
  assert.equal(formatWorkedForDuration(4_379_999), "1h 12m");
  assert.equal(formatWorkedForDuration(-1), "1s");
  assert.equal(formatWorkedForDuration(Number.NaN), "1s");
});

test("a settled TUI run appends one durable timing entry measured from its first start", async () => {
  const harness = createWorkedForHarness();
  await harness.emit("session_start");
  harness.setTime(1_000);
  await harness.emit("agent_start");
  harness.setTime(4_000);
  await harness.emit("agent_start");
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.setSessionEntries([usageEntry("assistant", 54_000)]);
  harness.setTime(9_000);
  await harness.emit("agent_settled");
  await harness.emit("agent_settled");

  assert.deepEqual(harness.appendedEntries, [{
    customType: "killeros-worked-for",
    data: { version: 3, milliseconds: 8_000, outcome: "done", tokens: 54_000 },
  }]);
});

test("task tokens include model, tool, and compaction usage without recounting history", async () => {
  const harness = createWorkedForHarness();
  const history = [usageEntry("assistant", 1_000), usageEntry("branch_summary", 500)];
  harness.setSessionEntries(history);
  await harness.emit("agent_start");
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.setSessionEntries([
    ...history,
    usageEntry("assistant", 30_000),
    usageEntry("toolResult", 2_000),
    usageEntry("compaction", 3_000),
    usageEntry("branch_summary", 4_000),
    { type: "message", message: { role: "user", usage: { totalTokens: 100_000 } } } as unknown as WorkedForSessionEntry,
    usageEntry("assistant", -1),
    usageEntry("assistant", Number.NaN),
  ]);
  harness.setTime(1_000);
  await harness.emit("agent_settled");

  assert.deepEqual(harness.appendedEntries[0]?.data, {
    version: 3,
    milliseconds: 1_000,
    outcome: "done",
    tokens: 39_000,
  });
});

test("unavailable or reset session telemetry reports zero tokens without losing the receipt", async () => {
  const unavailable = createWorkedForHarness();
  unavailable.setSessionError(new Error("session unavailable"));
  await unavailable.emit("agent_start");
  unavailable.setSessionError(undefined);
  unavailable.setSessionEntries([usageEntry("assistant", 20_000)]);
  await unavailable.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await unavailable.emit("agent_settled");

  const reset = createWorkedForHarness();
  reset.setSessionEntries([usageEntry("assistant", 20_000)]);
  await reset.emit("agent_start");
  reset.setSessionEntries([]);
  await reset.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await reset.emit("agent_settled");

  assert.equal(unavailable.appendedEntries[0]?.data.tokens, 0);
  assert.equal(reset.appendedEntries[0]?.data.tokens, 0);
});

test("settled goal turns each append their own task receipt before continuation", async () => {
  const harness = createWorkedForHarness();
  harness.setSessionEntries([usageEntry("assistant", 1_000)]);
  harness.setTime(1_000);
  await harness.emit("agent_start");
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });

  harness.setSessionEntries([usageEntry("assistant", 1_000), usageEntry("assistant", 20_000)]);
  harness.setTime(4_000);
  harness.setIdle(false);
  await harness.emit("agent_settled");

  harness.setIdle(true);
  harness.setTime(5_000);
  await harness.emit("agent_start");
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.setSessionEntries([
    usageEntry("assistant", 1_000),
    usageEntry("assistant", 20_000),
    usageEntry("toolResult", 4_000),
    usageEntry("assistant", 6_000),
  ]);
  harness.setTime(9_000);
  await harness.emit("agent_settled");

  assert.deepEqual(harness.appendedEntries, [
    {
      customType: "killeros-worked-for",
      data: { version: 3, milliseconds: 3_000, outcome: "done", tokens: 20_000 },
    },
    {
      customType: "killeros-worked-for",
      data: { version: 3, milliseconds: 4_000, outcome: "done", tokens: 10_000 },
    },
  ]);
});

test("the durable entry renders task tokens and preserves older history", () => {
  const harness = createWorkedForHarness();
  const renderer = harness.renderers.get("killeros-worked-for");
  assert.ok(renderer);
  const styledTheme = {
    fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
  } as unknown as Theme;

  const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
    [{ version: 3, milliseconds: 18_000, outcome: "done", tokens: 54_000 }, "<success>✓ Done</success><dim> · 18s · ↑ 54k tokens</dim>"],
    [{ version: 3, milliseconds: 18_000, outcome: "stopped", tokens: 999 }, "<warning>■ Stopped</warning><dim> · 18s · ↑ 999 tokens</dim>"],
    [{ version: 3, milliseconds: 18_000, outcome: "failed", tokens: 1_250_000 }, "<error>× Failed</error><dim> · 18s · ↑ 1.3M tokens</dim>"],
    [{ version: 2, milliseconds: 18_000, outcome: "done" }, "<success>✓ Done</success><dim> · 18s</dim>"],
    [{ version: 2, milliseconds: 18_000, outcome: "stopped" }, "<warning>■ Stopped</warning><dim> · 18s</dim>"],
    [{ version: 2, milliseconds: 18_000, outcome: "failed" }, "<error>× Failed</error><dim> · 18s</dim>"],
    [{ version: 1, milliseconds: 125_000 }, "<dim>✻ Worked for 2m 05s</dim>"],
  ];
  for (const [data, expected] of cases) {
    const component = renderer({ data }, {}, styledTheme);
    assert.ok(component);
    assert.deepEqual(component.render(80).map((line) => line.trimEnd()), [expected]);
  }

  for (const data of [
    undefined,
    null,
    [],
    {},
    { version: 3, milliseconds: 1_000 },
    { version: 3, milliseconds: 1_000, outcome: "done", tokens: -1 },
    { version: 3, milliseconds: 1_000, outcome: "done", tokens: Number.NaN },
    { version: 2, milliseconds: 1_000 },
    { version: 2, milliseconds: 1_000, outcome: "unknown" },
    { version: 1, milliseconds: -1 },
    { version: 1, milliseconds: Number.NaN },
  ]) {
    assert.equal(renderer({ data }, {}, theme), undefined);
  }
});

test("all Pi stop reasons map to truthful outcomes", async () => {
  assert.equal(workedForOutcome("stop"), "done");
  assert.equal(workedForOutcome("aborted"), "stopped");
  for (const stopReason of ["error", "length", "toolUse", undefined] as const) {
    assert.equal(workedForOutcome(stopReason), "failed");
  }

  for (const [stopReason, outcome] of [
    ["stop", "done"],
    ["aborted", "stopped"],
    ["error", "failed"],
    ["length", "failed"],
    ["toolUse", "failed"],
  ] as const) {
    const harness = createWorkedForHarness();
    harness.setTime(1_000);
    await harness.emit("agent_start");
    await harness.emit("agent_end", {
      messages: [
        { role: "assistant", stopReason: "error" },
        { role: "toolResult" },
        { role: "assistant", stopReason },
      ],
    });
    harness.setTime(2_000);
    await harness.emit("agent_settled");
    assert.equal(harness.appendedEntries[0].data.outcome, outcome, stopReason);
  }
});

test("each settled continuation uses its own last assistant reason", async () => {
  const harness = createWorkedForHarness();
  harness.setTime(1_000);
  await harness.emit("agent_start");
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] });
  harness.setIdle(false);
  harness.setTime(2_000);
  await harness.emit("agent_settled");

  await harness.emit("agent_start");
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  harness.setIdle(true);
  harness.setTime(4_000);
  await harness.emit("agent_settled");

  assert.deepEqual(harness.appendedEntries, [
    {
      customType: "killeros-worked-for",
      data: { version: 3, milliseconds: 1_000, outcome: "failed", tokens: 0 },
    },
    {
      customType: "killeros-worked-for",
      data: { version: 3, milliseconds: 2_000, outcome: "done", tokens: 0 },
    },
  ]);
});

test("non-TUI modes and settlements without a started run append nothing", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const harness = createWorkedForHarness(mode);
    await harness.emit("session_start");
    await harness.emit("agent_start");
    await harness.emit("agent_settled");
    assert.deepEqual(harness.appendedEntries, [], mode);
  }

  const tui = createWorkedForHarness();
  await tui.emit("agent_settled");
  assert.deepEqual(tui.appendedEntries, []);
});

test("session boundaries discard unfinished timing and save failures stay contained", async () => {
  const harness = createWorkedForHarness();
  harness.setTime(1_000);
  await harness.emit("agent_start");
  await harness.emit("session_shutdown");
  harness.setTime(9_000);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, []);

  await harness.emit("agent_start");
  harness.setAppendError(new Error("session unavailable"));
  harness.setTime(10_000);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.notices, [{
    message: "Worked-for timing could not be saved: session unavailable",
    level: "error",
  }]);

  harness.setAppendError(undefined);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, []);
});
