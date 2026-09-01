import assert from "node:assert/strict";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { StopReason } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import type { ChangeReceiptCollection } from "../killeros/change-receipt.ts";
import {
  formatWorkedForDuration,
  registerWorkedFor,
  workedForOutcome,
} from "../killeros/worked-for.ts";
import { extensionApiTestAdapter, themeTestAdapter } from "./PiTestAdapters.ts";

type WorkedForEvent = {
  type: string;
  messages?: Array<{ role?: string; stopReason?: StopReason }>;
  toolName?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
};

type WorkedForSessionEntry =
  | { type: "compaction" | "branch_summary"; usage: { totalTokens: number } }
  | { type: "message"; message: { role: string; usage: { totalTokens: number } } };
type WorkedForContext = {
  cwd: string;
  mode: ExtensionContext["mode"];
  hasPendingMessages(): boolean;
  isIdle(): boolean;
  sessionManager: { getEntries(): WorkedForSessionEntry[] };
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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function createWorkedForHarness(
  mode: WorkedForContext["mode"] = "tui",
  collect: (cwd: string) => Promise<ChangeReceiptCollection> = async () => ({
    finish: async () => ({ state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0 }),
    dispose: async () => undefined,
  }),
): WorkedForHarness {
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
      assert.ok(isUnknownRecord(data), "expected worked-for entry data to be an object");
      appendedEntries.push({ customType, data });
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
    cwd: process.cwd(),
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    mode,
    sessionManager: { getEntries: () => {
      if (sessionError) throw sessionError;
      return sessionEntries;
    } },
    ui: { notify: (message: string, level?: NotificationLevel) => notices.push({ message, level }) },
  };
  registerWorkedFor(extensionApiTestAdapter(api), () => currentTime, collect);

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

const theme = themeTestAdapter({ fg: (_color: string, text: string): string => text });
const EMPTY_V4 = {
  changes: { state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0 },
  checks: [],
  omittedChecks: { passed: 0, failed: 0 },
} as const;

function usageEntry(type: "assistant" | "toolResult" | "compaction" | "branch_summary", totalTokens: number): WorkedForSessionEntry {
  if (type === "compaction" || type === "branch_summary") {
    return { type, usage: { totalTokens } };
  }
  return {
    type: "message",
    message: { role: type, usage: { totalTokens } },
  };
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
    data: { version: 4, milliseconds: 8_000, outcome: "done", tokens: 54_000, ...EMPTY_V4 },
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
    { type: "message", message: { role: "user", usage: { totalTokens: 100_000 } } },
    usageEntry("assistant", -1),
    usageEntry("assistant", Number.NaN),
  ]);
  harness.setTime(1_000);
  await harness.emit("agent_settled");

  assert.deepEqual(harness.appendedEntries[0]?.data, {
    version: 4,
    milliseconds: 1_000,
    outcome: "done",
    tokens: 39_000,
    ...EMPTY_V4,
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
      data: { version: 4, milliseconds: 3_000, outcome: "done", tokens: 20_000, ...EMPTY_V4 },
    },
    {
      customType: "killeros-worked-for",
      data: { version: 4, milliseconds: 4_000, outcome: "done", tokens: 10_000, ...EMPTY_V4 },
    },
  ]);
});

test("the durable entry renders task tokens and preserves older history", () => {
  const harness = createWorkedForHarness();
  const renderer = harness.renderers.get("killeros-worked-for");
  assert.ok(renderer);
  const styledTheme = themeTestAdapter({
    fg: (color: string, text: string): string => `<${color}>${text}</${color}>`,
  });

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

test("version 4 receipts render compact and expanded change details within every width", () => {
  const harness = createWorkedForHarness();
  const renderer = harness.renderers.get("killeros-worked-for");
  assert.ok(renderer);
  const data = {
    version: 4,
    milliseconds: 84_000,
    outcome: "done",
    tokens: 18_200,
    changes: {
      state: "available",
      totalFiles: 3,
      additions: 84,
      deletions: 21,
      files: [
        { kind: "modified", path: "killeros/worked-for.ts", additions: 46, deletions: 12 },
        { kind: "renamed", path: "test/Receipt.test.ts", previousPath: "test/Old.test.ts", additions: 35, deletions: 9 },
        { kind: "added", path: "docs/implemented/change-receipts.md", additions: 3, deletions: 0 },
      ],
      omittedFiles: 0,
    },
    checks: [
      { label: "npm test", outcome: "passed" },
      { label: "npm run check", outcome: "passed" },
    ],
    omittedChecks: { passed: 0, failed: 0 },
  };
  const compact = renderer({ data }, { expanded: false }, theme);
  assert.ok(compact);
  assert.deepEqual(compact.render(80), [
    "✓ Done · 1m 24s · ↑ 18.2k tokens",
    "  Changed 3 files · +84 −21",
    "  Checks: 2 passed",
  ]);
  const expanded = renderer({ data }, { expanded: true }, theme);
  assert.ok(expanded);
  assert.match(expanded.render(120).join("\n"), /R test\/Old\.test\.ts → test\/Receipt\.test\.ts \+35 −9/u);

  const longPathData = {
    ...data,
    changes: {
      state: "available",
      totalFiles: 1,
      additions: 10,
      deletions: 2,
      files: [{ kind: "modified", path: `${"directory/".repeat(8)}file.ts`, additions: 10, deletions: 2 }],
      omittedFiles: 0,
    },
    checks: [],
  };
  const narrowExpanded = renderer({ data: longPathData }, { expanded: true }, theme);
  assert.ok(narrowExpanded);
  assert.match(narrowExpanded.render(40)[3] ?? "", /\+10 −2/u);

  for (let width = 1; width <= 200; width += 1) {
    const compactLines = compact.render(width);
    const expandedLines = expanded.render(width);
    assert.ok(compactLines.length <= 3);
    assert.ok(expandedLines.length <= 45);
    assert.ok([...compactLines, ...expandedLines].every((line) => visibleWidth(line) <= width), `width ${width}`);
  }
});

test("version 4 receipts describe observed checks without verification claims", () => {
  const renderer = createWorkedForHarness().renderers.get("killeros-worked-for");
  assert.ok(renderer);
  const changed = { state: "available", totalFiles: 1, additions: 1, deletions: 0, files: [{ kind: "added", path: "file.ts", additions: 1, deletions: 0 }], omittedFiles: 0 };
  const cases = [
    { checks: [{ label: "npm test", outcome: "passed" }], omittedChecks: { passed: 0, failed: 0 }, expected: "  Check passed: npm test ✓" },
    { checks: [{ label: "npm test", outcome: "failed" }], omittedChecks: { passed: 0, failed: 0 }, expected: "  Check failed: npm test ×" },
    { checks: [{ label: "npm test", outcome: "passed" }, { label: "npm run check", outcome: "failed" }], omittedChecks: { passed: 0, failed: 0 }, expected: "  Checks: 1 passed · 1 failed" },
    { checks: [], omittedChecks: { passed: 0, failed: 0 }, expected: "  No check recorded" },
  ] as const;
  for (const receipt of cases) {
    const component = renderer({ data: { version: 4, milliseconds: 1, outcome: "done", tokens: 1, changes: changed, checks: receipt.checks, omittedChecks: receipt.omittedChecks } }, { expanded: false }, theme);
    assert.ok(component);
    const lines = component.render(100);
    assert.equal(lines[2], receipt.expected);
    assert.doesNotMatch(lines.join("\n"), /Verified|Verification|Not verified/u);
  }
});

test("version 4 validation rejects malformed and oversized durable data", () => {
  const harness = createWorkedForHarness();
  const renderer = harness.renderers.get("killeros-worked-for");
  assert.ok(renderer);
  const valid = {
    version: 4,
    milliseconds: 1,
    outcome: "done",
    tokens: 1,
    changes: { state: "available", totalFiles: 1, additions: 1, deletions: 0, files: [{ kind: "added", path: "safe\npath.ts", additions: 1, deletions: 0 }], omittedFiles: 0 },
    checks: [{ label: "npm test", outcome: "passed" }],
    omittedChecks: { passed: 0, failed: 0 },
  };
  const component = renderer({ data: valid }, { expanded: true }, theme);
  assert.ok(component);
  assert.match(component.render(100).join("\n"), /safe⏎path\.ts/u);
  for (const data of [
    { ...valid, milliseconds: 1.5 },
    { ...valid, tokens: Number.POSITIVE_INFINITY },
    { ...valid, outcome: "unknown" },
    { ...valid, changes: { ...valid.changes, totalFiles: 2 } },
    { ...valid, changes: { ...valid.changes, files: [{ kind: "added", path: "../unsafe", additions: 1, deletions: 0 }] } },
    { ...valid, checks: [{ label: "npm install", outcome: "passed" }] },
    { ...valid, checks: [{ label: "npm test", outcome: "unknown" }] },
    { ...valid, checks: [], omittedChecks: { passed: 1, failed: 0 } },
    { ...valid, changes: { ...valid.changes, files: [{ kind: "modified", path: "binary.bin", additions: 1, deletions: 0, detail: "binary" }] } },
    { ...valid, changes: { ...valid.changes, files: [{ kind: "added", path: "x".repeat(70_000), additions: 1, deletions: 0 }] } },
  ]) assert.equal(renderer({ data }, { expanded: false }, theme), undefined);
});

test("response collection keeps the first baseline and records checks in event order", async () => {
  let starts = 0;
  const harness = createWorkedForHarness("tui", async () => {
    starts += 1;
    return {
      finish: async () => ({
        state: "available",
        totalFiles: 1,
        additions: 2,
        deletions: 1,
        files: [{ kind: "modified", path: "changed.ts", additions: 2, deletions: 1 }],
        omittedFiles: 0,
      }),
      dispose: async () => undefined,
    };
  });
  await harness.emit("agent_start");
  await harness.emit("agent_start");
  await harness.emit("tool_result", { toolName: "bash", input: { command: "npm test -- --runInBand" }, isError: false });
  await harness.emit("tool_result", { toolName: "bash", input: { command: "npm test" }, isError: false });
  await harness.emit("tool_result", { toolName: "powershell", input: { command: "npm run check" }, isError: true });
  await harness.emit("tool_result", { toolName: "bash", input: { command: "npm test || true" }, isError: false });
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await harness.emit("agent_settled");
  assert.equal(starts, 1);
  assert.deepEqual(harness.appendedEntries[0]?.data, {
    version: 4,
    milliseconds: 0,
    outcome: "done",
    tokens: 0,
    changes: {
      state: "available",
      totalFiles: 1,
      additions: 2,
      deletions: 1,
      files: [{ kind: "modified", path: "changed.ts", additions: 2, deletions: 1 }],
      omittedFiles: 0,
    },
    checks: [
      { label: "npm test", outcome: "passed" },
      { label: "npm run check", outcome: "failed" },
    ],
    omittedChecks: { passed: 0, failed: 0 },
  });
});

test("check overflow keeps the first 20 attempts and unavailable collection warns once", async () => {
  const harness = createWorkedForHarness("tui", async () => ({
    finish: async () => ({ state: "unavailable", reason: "timeout" }),
    dispose: async () => undefined,
  }));
  for (let response = 0; response < 2; response += 1) {
    await harness.emit("agent_start");
    for (let attempt = 0; attempt < 22; attempt += 1) {
      await harness.emit("tool_result", {
        toolName: "bash",
        input: { command: attempt % 2 === 0 ? "npm test" : "npm run check" },
        isError: attempt % 2 === 1,
      });
    }
    await harness.emit("agent_settled");
  }
  assert.equal((harness.appendedEntries[0]?.data.checks as unknown[]).length, 20);
  assert.deepEqual(harness.appendedEntries[0]?.data.omittedChecks, { passed: 1, failed: 1 });
  assert.deepEqual(harness.notices, [{ message: "Change receipt unavailable: timeout", level: "warning" }]);
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
      data: { version: 4, milliseconds: 1_000, outcome: "failed", tokens: 0, ...EMPTY_V4 },
    },
    {
      customType: "killeros-worked-for",
      data: { version: 4, milliseconds: 2_000, outcome: "done", tokens: 0, ...EMPTY_V4 },
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
