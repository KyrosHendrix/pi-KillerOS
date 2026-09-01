import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CompactOptions,
  ContextUsage,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AUTO_COMPACTION_MESSAGE,
  AUTO_COMPACTION_MESSAGE_TYPE,
  isSessionTooSmallCompactionError,
  readAutoCompactionPreference,
  registerAutoCompaction,
  SESSION_TOO_SMALL_COMPACTION_ERROR,
  shouldTriggerAutoCompaction,
  type AutoCompactionGoalHandlers,
} from "../killeros/auto-compaction.ts";
import { registerGoal, registerGoalSettlement } from "../killeros/goals.ts";
import { createGoalRuntime, createInitRuntime } from "../killeros/runtime.ts";
import { createKillerosSettingsStore } from "../killeros/settings.ts";
import { extensionApiTestAdapter, extensionContextTestAdapter } from "./PiTestAdapters.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function requiredMapValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  assert.ok(value, `expected ${key} to be registered`);
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AutoHarness {
  compactCalls: CompactOptions[];
  notifications: Array<{ message: string; type: string | undefined }>;
  sentMessages: Array<{ message: unknown; options: unknown }>;
  setUsage(usage: ContextUsage | undefined): void;
  failCompactionSynchronously(error?: Error): void;
  failContinuationSynchronously(error?: Error): void;
  emit(eventName: string, event?: unknown): Promise<unknown>;
}

function createHarness(
  mode: "tui" | "rpc" = "tui",
  initialUsage: ContextUsage | undefined = { tokens: 90_000, contextWindow: 100_000, percent: 90 },
  goal?: AutoCompactionGoalHandlers,
): AutoHarness {
  const handlers = new Map<string, Handler[]>();
  const compactCalls: CompactOptions[] = [];
  const notifications: AutoHarness["notifications"] = [];
  const sentMessages: AutoHarness["sentMessages"] = [];
  let usage: ContextUsage | undefined = initialUsage;
  let continuationError: Error | undefined;
  const api = extensionApiTestAdapter({
    on(eventName: string, handler: Handler): void {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    },
    sendMessage(message: unknown, options: unknown): void {
      if (continuationError) throw continuationError;
      sentMessages.push({ message, options });
    },
  });
  const ctx = extensionContextTestAdapter({
    cwd: process.cwd(),
    getContextUsage: () => usage,
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode,
    compact: (options?: CompactOptions) => {
      if (compactError) throw compactError;
      if (options) compactCalls.push(options);
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  });
  let compactError: Error | undefined;
  registerAutoCompaction(api, {
    loadPreference: () => ({ enabled: true, percentRemaining: 15 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 }),
    goal,
  });
  return {
    compactCalls,
    notifications,
    sentMessages,
    setUsage: (next) => { usage = next; },
    failCompactionSynchronously: (error) => { compactError = error; },
    failContinuationSynchronously: (error) => { continuationError = error; },
    async emit(eventName, event = { type: eventName }): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) result = await handler(event, ctx);
      return result;
    },
  };
}

function compactResult(): { summary: string; firstKeptEntryId: string; tokensBefore: number } {
  return { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 90_000 };
}

function createGoalHarness(mode: "tui" | "rpc" = "rpc"): {
  compactCalls: CompactOptions[];
  notifications: Array<{ message: string; type?: string }>;
  persistedStatuses: string[];
  sentMessages: Array<{ message: unknown; options: unknown }>;
  state(): ReturnType<typeof createGoalRuntime>;
  failCompactionSynchronously(error?: Error): void;
  failPersistence(error?: Error): void;
  runGoalCommand(command: string): Promise<void>;
  startGoal(objective: string): Promise<void>;
  emit(eventName: string, event?: unknown): Promise<unknown>;
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const tools = new Map<string, unknown>();
  const activeTools: string[] = [];
  const compactCalls: CompactOptions[] = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const entries: unknown[] = [];
  const persistedStatuses: string[] = [];
  let compactError: Error | undefined;
  let persistenceError: Error | undefined;
  const api = extensionApiTestAdapter({
    appendEntry: (customType: string, data: unknown) => {
      if (persistenceError) throw persistenceError;
      entries.push({ customType, data });
      if (isUnknownRecord(data) && isUnknownRecord(data.state) && typeof data.state.status === "string") {
        persistedStatuses.push(data.state.status);
      }
    },
    getActiveTools: () => [...activeTools],
    on(eventName: string, handler: Handler): void {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    registerEntryRenderer: () => {},
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    sendMessage: (message: unknown, options: unknown) => sentMessages.push({ message, options }),
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
  });
  const runtime = createGoalRuntime();
  const initRuntime = createInitRuntime();
  registerGoal(api, runtime, initRuntime);
  const goal = registerGoalSettlement(api, runtime, initRuntime);
  registerAutoCompaction(api, {
    loadPreference: () => ({ enabled: true, percentRemaining: 15 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 }),
    goal,
  });
  const ctx = extensionContextTestAdapter({
    cwd: process.cwd(),
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode,
    compact: (options?: CompactOptions) => {
      if (compactError) throw compactError;
      if (options) compactCalls.push(options);
    },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getSessionFile: () => `${process.cwd()}\session.jsonl`,
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
    waitForIdle: async () => {},
  });
  const emit = async (eventName: string, event = { type: eventName }): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(eventName) ?? []) result = await handler(event, ctx);
    return result;
  };
  return {
    compactCalls,
    notifications,
    persistedStatuses,
    sentMessages,
    state: () => runtime,
    failCompactionSynchronously: (error) => { compactError = error ?? new Error("compaction unavailable"); },
    failPersistence: (error) => { persistenceError = error ?? new Error("session storage unavailable"); },
    runGoalCommand: (command) => requiredMapValue(commands, "goal").handler(command, ctx),
    startGoal: (objective) => requiredMapValue(commands, "goal").handler(`start -- ${objective}`, ctx),
    emit,
  };
}

test("auto-compaction uses the active context window, reserve, and Pi enablement", () => {
  assert.equal(shouldTriggerAutoCompaction(
    { tokens: 84_000, contextWindow: 100_000 },
    { enabled: true, percentRemaining: 15 },
    { enabled: true, reserveTokens: 10_000 },
  ), false);
  assert.equal(shouldTriggerAutoCompaction(
    { tokens: 170_000, contextWindow: 200_000 },
    { enabled: true, percentRemaining: 15 },
    { enabled: true, reserveTokens: 10_000 },
  ), true);
  assert.equal(shouldTriggerAutoCompaction(
    { tokens: 90_500, contextWindow: 100_000 },
    { enabled: true, percentRemaining: 1 },
    { enabled: true, reserveTokens: 10_000 },
  ), true);
  assert.equal(shouldTriggerAutoCompaction(
    { tokens: 99_000, contextWindow: 100_000 },
    { enabled: true, percentRemaining: 15 },
    { enabled: false, reserveTokens: 10_000 },
  ), false);
  assert.equal(shouldTriggerAutoCompaction(
    { tokens: null, contextWindow: 100_000 },
    { enabled: true, percentRemaining: 15 },
    { enabled: true, reserveTokens: 10_000 },
  ), false);
  assert.equal(shouldTriggerAutoCompaction(undefined, { enabled: true, percentRemaining: 15 }, { enabled: true, reserveTokens: 10_000 }), false);
});

test("auto-compaction reads only its global preference and keeps safe defaults", () => {
  assert.deepEqual(readAutoCompactionPreference({}), { enabled: true, percentRemaining: 15 });
  assert.deepEqual(readAutoCompactionPreference({ autoCompaction: { enabled: false, percentRemaining: 22 } }), {
    enabled: false,
    percentRemaining: 22,
  });
  assert.deepEqual(readAutoCompactionPreference({
    completionSound: true,
    autoCompaction: { enabled: "yes", percentRemaining: 200 },
  }), { enabled: true, percentRemaining: 15 });
});

test("auto-compaction shares the global KillerOS settings file without clobbering other preferences", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-auto-compaction-"));
  try {
    const settingsPath = path.join(directory, "killeros.json");
    const settings = createKillerosSettingsStore(settingsPath);
    settings.update({ completionSound: true });
    settings.update({ autoCompaction: { enabled: false, percentRemaining: 22 } });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      completionSound: true,
      autoCompaction: { enabled: false, percentRemaining: 22 },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TUI and RPC wait for turn_end -> agent_settled -> compaction completion before one hidden continuation", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await harness.emit("turn_end", { type: "turn_end", toolResults: [{ toolName: "read" }] });
    assert.equal(harness.compactCalls.length, 1, mode);
    assert.equal(harness.sentMessages.length, 0, mode);

    await harness.emit("agent_settled");
    assert.equal(harness.sentMessages.length, 0, mode);
    harness.compactCalls[0]?.onComplete?.(compactResult());
    harness.compactCalls[0]?.onComplete?.(compactResult());
    await harness.emit("agent_settled");
    assert.deepEqual(harness.sentMessages, [{
      message: {
        customType: AUTO_COMPACTION_MESSAGE_TYPE,
        content: AUTO_COMPACTION_MESSAGE,
        display: false,
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    }], mode);
  }
});

test("ordinary continuation also waits when compaction completion precedes settlement", async () => {
  const harness = createHarness();
  await harness.emit("turn_end");

  harness.compactCalls[0]?.onComplete?.(compactResult());
  harness.compactCalls[0]?.onComplete?.(compactResult());
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_settled");
  assert.equal(harness.sentMessages.length, 1);
});

test("a stale ordinary continuation cannot dispatch after a lifecycle reset", async () => {
  for (const event of ["session_start", "session_shutdown", "session_tree", "session_before_switch", "session_before_fork"] as const) {
    const harness = createHarness();
    await harness.emit("turn_end");
    const callbacks = harness.compactCalls[0];

    await harness.emit(event);
    callbacks?.onComplete?.(compactResult());
    await harness.emit("agent_settled");

    assert.equal(harness.sentMessages.length, 0, event);
  }
});

test("a synchronous ordinary continuation dispatch failure is visible and never retried", async () => {
  const harness = createHarness();
  harness.failContinuationSynchronously(new Error("continuation unavailable"));
  await harness.emit("turn_end");
  await harness.emit("agent_settled");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await harness.emit("agent_settled");

  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /continuation unavailable/u);
});

test("missing readings, disabled Pi compaction, and failed compaction do not retry automatically", async () => {
  const missing = createHarness("tui", { tokens: null, contextWindow: 100_000, percent: null });
  await missing.emit("turn_end");
  assert.equal(missing.compactCalls.length, 0);

  const failure = createHarness();
  // The harness supplies enabled Pi settings; replace the registration with a separate disabled probe.
  const disabledHandlers = new Map<string, Handler[]>();
  const disabledApi = extensionApiTestAdapter({
    on(eventName: string, handler: Handler): void {
      const current = disabledHandlers.get(eventName) ?? [];
      current.push(handler);
      disabledHandlers.set(eventName, current);
    },
  });
  const disabledCtx = extensionContextTestAdapter({
    mode: "tui",
    getContextUsage: () => ({ tokens: 99_000, contextWindow: 100_000, percent: 99 }),
    isProjectTrusted: () => true,
    compact: (options?: CompactOptions) => { if (options) disabledCalls.push(options); },
    ui: { notify: () => {} },
  });
  const disabledCalls: CompactOptions[] = [];
  registerAutoCompaction(disabledApi, {
    loadPreference: () => ({ enabled: true, percentRemaining: 15 }),
    getCompactionSettings: () => ({ enabled: false, reserveTokens: 10_000, keepRecentTokens: 20_000 }),
  });
  for (const handler of disabledHandlers.get("turn_end") ?? []) await handler({ type: "turn_end" }, disabledCtx);
  assert.equal(disabledCalls.length, 0);

  await failure.emit("turn_end");
  failure.compactCalls[0]?.onError?.(new Error("provider unavailable"));
  await failure.emit("turn_end");
  assert.equal(failure.compactCalls.length, 1);
  assert.match(failure.notifications[0]?.message ?? "", /provider unavailable/u);
});

test("a successful goal compaction uses the goal continuation callback without an ordinary continuation", async () => {
  const events: string[] = [];
  const harness = createHarness("rpc", undefined, {
    isActive: () => true,
    onRequested: () => events.push("requested"),
    onCompleted: () => events.push("completed"),
    onFailed: (_ctx, error) => events.push(`failed:${String(error)}`),
    onSkipped: () => events.push("skipped"),
  });
  await harness.emit("turn_end");
  assert.deepEqual(events, ["requested"]);
  harness.compactCalls[0]?.onComplete?.(compactResult());
  assert.deepEqual(events, ["requested", "completed"]);
  assert.equal(harness.sentMessages.length, 0);
});

test("an active goal pauses for automatic compaction and resumes once after settlement", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createGoalHarness(mode);
    await harness.startGoal("Continue this goal after compaction");
    assert.equal(harness.sentMessages.length, 1, mode);

    await harness.emit("turn_end");
    assert.equal(harness.state().state?.status, "paused", mode);

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [{
        role: "assistant",
        stopReason: "error",
        errorMessage: "This operation was aborted",
      }],
    });
    await harness.emit("agent_settled");
    assert.equal(harness.state().state?.status, "paused", mode);
    assert.equal(harness.sentMessages.length, 1, mode);

    harness.compactCalls[0]?.onComplete?.(compactResult());
    harness.compactCalls[0]?.onComplete?.(compactResult());
    await harness.emit("agent_settled");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.state().state?.status, "active", mode);
    assert.equal(harness.sentMessages.length, 2, mode);
    assert.deepEqual(harness.persistedStatuses.slice(0, 4), ["active", "active", "paused", "active"], mode);
    const continuation = harness.sentMessages[1]?.message;
    assert.ok(isUnknownRecord(continuation));
    assert.equal(continuation.customType, "killeros-goal-continuation");
  }
});

test("automatic goal compaction also resumes once when completion precedes settlement", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Resume after both boundaries");
  await harness.emit("turn_end");

  harness.compactCalls[0]?.onComplete?.(compactResult());
  assert.equal(harness.state().state?.status, "paused");
  assert.equal(harness.sentMessages.length, 1);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state().state?.status, "active");
  assert.equal(harness.sentMessages.length, 2);
});

test("explicit /goal pause during automatic compaction prevents recovery", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Keep this goal paused");
  await harness.emit("turn_end");
  await harness.runGoalCommand("pause");

  harness.compactCalls[0]?.onComplete?.(compactResult());
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state().state?.status, "paused");
  assert.equal(harness.sentMessages.length, 1);
});

test("session switch and fork reset automatic goal recovery", async () => {
  for (const event of ["session_before_switch", "session_before_fork"] as const) {
    const harness = createGoalHarness();
    await harness.startGoal(`Stay paused after ${event}`);
    await harness.emit("turn_end");

    await harness.emit(event);

    assert.equal(harness.state().automaticCompaction, undefined, event);
    assert.equal(harness.state().state?.status, "paused", event);
  }
});

test("a genuine provider error cannot recover after automatic compaction succeeds", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Fail closed on provider errors");
  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted unexpectedly" }],
  });
  await harness.emit("agent_settled");

  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state().state?.status, "paused");
  assert.match(harness.state().state?.result ?? "", /aborted unexpectedly/u);
  assert.equal(harness.sentMessages.length, 1);
});

test("a failed automatic goal compaction pauses without scheduling a retry", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Pause when automatic compaction fails");
  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  assert.equal(harness.state().state?.status, "paused");
  harness.compactCalls[0]?.onError?.(new Error("compaction unavailable"));
  assert.equal(harness.state().state?.status, "paused");
  assert.match(harness.state().state?.result ?? "", /automatic compaction failed: compaction unavailable/u);
  assert.equal(harness.sentMessages.length, 1);
});

test("automatic compaction does not start when its goal pause cannot be saved", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Fail closed before compaction");
  harness.failPersistence();

  await harness.emit("turn_end");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.state().state?.status, "paused");
  assert.equal(harness.state().persistenceRetryNeeded, true);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.notifications.at(-1)?.message ?? "", /did not start/u);
});

test("a successful compaction does not continue when its goal resume cannot be saved", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Fail closed after compaction");
  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  harness.failPersistence();

  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.state().state?.status, "paused");
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.notifications.at(-1)?.message ?? "", /could not be resumed/u);
});

test("a synchronous automatic goal compaction failure stays paused", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Pause after synchronous compaction failure");
  harness.failCompactionSynchronously();

  await harness.emit("turn_end");

  assert.equal(harness.state().state?.status, "paused");
  assert.match(harness.state().state?.result ?? "", /automatic compaction failed: compaction unavailable/u);
  assert.equal(harness.sentMessages.length, 1);
});

test("a successful compaction must be followed by a higher reading before another trigger", async () => {
  const harness = createHarness();
  await harness.emit("turn_end");
  await harness.emit("agent_settled");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "custom", customType: AUTO_COMPACTION_MESSAGE_TYPE },
  });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 1);
  harness.setUsage({ tokens: 70_000, contextWindow: 100_000, percent: 70 });
  await harness.emit("turn_end");
  harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 2);
});

test("an exact session-too-small rejection is a silent skip and rearms the next turn", async () => {
  const harness = createHarness("tui");
  await harness.emit("turn_end");
  harness.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
  assert.equal(harness.compactCalls.length, 1);
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.sentMessages, []);

  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 2);
});

test("a synchronous session-too-small throw behaves like the asynchronous skip", async () => {
  const harness = createHarness("rpc");
  harness.failCompactionSynchronously(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
  await harness.emit("turn_end");
  harness.failCompactionSynchronously(undefined);

  assert.equal(harness.compactCalls.length, 0);
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.sentMessages, []);

  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 1);
});

test("a near-match of the session-too-small message remains a visible failure", async () => {
  for (const message of [
    `${SESSION_TOO_SMALL_COMPACTION_ERROR}: retry later`,
    `automatic compaction skipped: ${SESSION_TOO_SMALL_COMPACTION_ERROR}`,
    "nothing to compact (session too small)",
  ] as const) {
    const harness = createHarness();
    await harness.emit("turn_end");
    harness.compactCalls[0]?.onError?.(new Error(message));
    assert.equal(harness.notifications[0]?.message, `Automatic compaction failed: ${message}`, message);
    await harness.emit("turn_end");
    assert.equal(harness.compactCalls.length, 1, `${message} must not rearm`);
  }
});

test("session-too-small classification matches only Pi's exact Error message", () => {
  assert.equal(isSessionTooSmallCompactionError(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR)), true);
  for (const candidate of [
    `${SESSION_TOO_SMALL_COMPACTION_ERROR}.`,
    ` ${SESSION_TOO_SMALL_COMPACTION_ERROR}`,
    "NOTHING TO COMPACT (SESSION TOO SMALL)",
    SESSION_TOO_SMALL_COMPACTION_ERROR,
    { message: SESSION_TOO_SMALL_COMPACTION_ERROR },
    undefined,
  ]) {
    assert.equal(isSessionTooSmallCompactionError(candidate), false);
  }
});

test("an active goal receives one requested and one skipped callback without failure or completion", async () => {
  const events: string[] = [];
  const harness = createHarness("rpc", undefined, {
    isActive: () => true,
    onRequested: () => events.push("requested"),
    onCompleted: () => events.push("completed"),
    onFailed: (_ctx, error) => events.push(`failed:${String(error)}`),
    onSkipped: () => events.push("skipped"),
  });
  await harness.emit("turn_end");
  harness.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));

  assert.deepEqual(events, ["requested", "skipped"]);
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.sentMessages, []);
});

test("a skipped goal request resumes the paused revision once after turn settlement", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createGoalHarness(mode);
    await harness.startGoal("Continue after an ineligible compaction attempt");
    await harness.emit("turn_end");
    assert.equal(harness.state().state?.status, "paused", mode);

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    // Before settlement a skip must not resume anything.
    harness.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
    assert.equal(harness.state().state?.status, "paused", mode);
    assert.equal(harness.sentMessages.length, 1, mode);

    await harness.emit("agent_settled");
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.state().state?.status, "active", mode);
    assert.equal(harness.state().automaticCompaction, undefined, mode);
    assert.equal(harness.sentMessages.length, 2, mode);
    assert.deepEqual(harness.persistedStatuses.slice(0, 4), ["active", "active", "paused", "active"], mode);
    assert.ok(!harness.persistedStatuses.includes("error"), mode);
    assert.deepEqual(harness.notifications.filter((notification) => notification.type === "error"), [], mode);
  }
});

test("a skipped goal stays fail-closed when its resume cannot be saved or the revision moved on", async () => {
  const unsavable = createGoalHarness();
  await unsavable.startGoal("Keep fail-closed resume behavior");
  await unsavable.emit("turn_end");
  await unsavable.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await unsavable.emit("agent_settled");
  unsavable.failPersistence();

  unsavable.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(unsavable.state().state?.status, "paused");
  assert.equal(unsavable.state().persistenceRetryNeeded, true);
  assert.equal(unsavable.sentMessages.length, 1);
  assert.match(unsavable.notifications.at(-1)?.message ?? "", /skipped, but the goal could not be resumed/u);

  const superseded = createGoalHarness();
  await superseded.startGoal("Keep revision guards on skips");
  await superseded.emit("turn_end");
  await superseded.runGoalCommand("pause");
  await superseded.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await superseded.emit("agent_settled");

  superseded.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(superseded.state().state?.status, "paused");
  assert.equal(superseded.state().automaticCompaction, undefined);
  assert.equal(superseded.sentMessages.length, 1);
  assert.deepEqual(superseded.notifications.filter((notification) => /resume/u.test(notification.message) && notification.type === "info"), []);
});

test("a lifecycle reset makes a stale exact-error callback inert", async () => {
  const stale = new Error(SESSION_TOO_SMALL_COMPACTION_ERROR);
  const harness = createHarness();
  await harness.emit("turn_end");
  const staleCallbacks = harness.compactCalls[0];

  await harness.emit("session_start");

  staleCallbacks?.onError?.(stale);
  assert.deepEqual(harness.notifications, []);
  assert.deepEqual(harness.sentMessages, []);

  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 2);
  harness.compactCalls[1]?.onError?.(stale);
  assert.deepEqual(harness.notifications, []);
});

test("RPC mode skips identically while print mode never requests compaction", async () => {
  const rpc = createHarness("rpc");
  await rpc.emit("turn_end");
  rpc.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
  assert.deepEqual(rpc.notifications, []);
  assert.deepEqual(rpc.sentMessages, []);
  await rpc.emit("turn_end");
  assert.equal(rpc.compactCalls.length, 2);

  const printHandlers = new Map<string, Handler[]>();
  const printApi = extensionApiTestAdapter({
    on(eventName: string, handler: Handler): void {
      const current = printHandlers.get(eventName) ?? [];
      current.push(handler);
      printHandlers.set(eventName, current);
    },
  });
  const printCtx = extensionContextTestAdapter({
    mode: "print",
    getContextUsage: () => ({ tokens: 99_000, contextWindow: 100_000, percent: 99 }),
    isProjectTrusted: () => true,
    compact: (options?: CompactOptions) => { if (options) printCalls.push(options); },
    ui: { notify: () => {} },
  });
  const printCalls: CompactOptions[] = [];
  registerAutoCompaction(printApi);
  for (const handler of printHandlers.get("turn_end") ?? []) await handler({ type: "turn_end" }, printCtx);
  assert.equal(printCalls.length, 0);
});
