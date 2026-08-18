import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CompactOptions,
  CompactionSettings,
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  AUTO_COMPACTION_MESSAGE,
  AUTO_COMPACTION_MESSAGE_TYPE,
  readAutoCompactionPreference,
  registerAutoCompaction,
  shouldTriggerAutoCompaction,
} from "../killeros/auto-compaction.ts";
import { registerGoal, registerGoalSettlement } from "../killeros/goals.ts";
import { createGoalRuntime, createInitRuntime } from "../killeros/runtime.ts";
import { createKillerosSettingsStore } from "../killeros/settings.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface AutoHarness {
  compactCalls: CompactOptions[];
  notifications: Array<{ message: string; type: string | undefined }>;
  sentMessages: Array<{ message: unknown; options: unknown }>;
  setUsage(usage: ContextUsage | undefined): void;
  emit(eventName: string, event?: unknown): Promise<unknown>;
}

function createHarness(
  mode: "tui" | "rpc" = "tui",
  initialUsage: ContextUsage | undefined = { tokens: 90_000, contextWindow: 100_000, percent: 90 },
  goal?: {
    isActive(): boolean;
    onRequested(): void;
    onCompleted(ctx: ExtensionContext): void;
    onFailed(ctx: ExtensionContext, error: unknown): void;
  },
): AutoHarness {
  const handlers = new Map<string, Handler[]>();
  const compactCalls: CompactOptions[] = [];
  const notifications: AutoHarness["notifications"] = [];
  const sentMessages: AutoHarness["sentMessages"] = [];
  let usage: ContextUsage | undefined = initialUsage;
  const api = {
    on(eventName: string, handler: Handler): void {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    },
    sendMessage(message: unknown, options: unknown): void {
      sentMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => usage,
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode,
    compact: (options?: CompactOptions) => { if (options) compactCalls.push(options); },
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
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

function createGoalHarness(): {
  compactCalls: CompactOptions[];
  sentMessages: Array<{ message: unknown; options: unknown }>;
  state(): ReturnType<typeof createGoalRuntime>;
  startGoal(objective: string): Promise<void>;
  emit(eventName: string, event?: unknown): Promise<unknown>;
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const tools = new Map<string, unknown>();
  const activeTools: string[] = [];
  const compactCalls: CompactOptions[] = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const entries: unknown[] = [];
  const api = {
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
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
  } as unknown as ExtensionAPI;
  const runtime = createGoalRuntime();
  const initRuntime = createInitRuntime();
  registerGoal(api, runtime, initRuntime);
  const goal = registerGoalSettlement(api, runtime, initRuntime);
  registerAutoCompaction(api, {
    loadPreference: () => ({ enabled: true, percentRemaining: 15 }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 }),
    goal,
  });
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => ({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode: "rpc",
    compact: (options?: CompactOptions) => { if (options) compactCalls.push(options); },
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getSessionFile: () => `${process.cwd()}\session.jsonl`,
    },
    ui: {
      notify: () => {},
    },
    waitForIdle: async () => {},
  } as unknown as ExtensionContext;
  const emit = async (eventName: string, event = { type: eventName }): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(eventName) ?? []) result = await handler(event, ctx);
    return result;
  };
  return {
    compactCalls,
    sentMessages,
    state: () => runtime,
    startGoal: (objective) => commands.get("goal")!.handler(objective, ctx),
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

test("TUI and RPC compaction happens at the settled turn boundary and queues one hidden continuation", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await harness.emit("turn_end", { type: "turn_end", toolResults: [{ toolName: "read" }] });
    assert.equal(harness.compactCalls.length, 1, mode);
    assert.equal(harness.sentMessages.length, 0, mode);

    harness.compactCalls[0]?.onComplete?.(compactResult());
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

test("missing readings, disabled Pi compaction, and failed compaction do not retry automatically", async () => {
  const missing = createHarness("tui", { tokens: null, contextWindow: 100_000, percent: null });
  await missing.emit("turn_end");
  assert.equal(missing.compactCalls.length, 0);

  const failure = createHarness();
  // The harness supplies enabled Pi settings; replace the registration with a separate disabled probe.
  const disabledHandlers = new Map<string, Handler[]>();
  const disabledApi = {
    on(eventName: string, handler: Handler): void {
      const current = disabledHandlers.get(eventName) ?? [];
      current.push(handler);
      disabledHandlers.set(eventName, current);
    },
  } as unknown as ExtensionAPI;
  const disabledCtx = {
    mode: "tui",
    getContextUsage: () => ({ tokens: 99_000, contextWindow: 100_000, percent: 99 }),
    isProjectTrusted: () => true,
    compact: (options?: CompactOptions) => { if (options) disabledCalls.push(options); },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
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
  });
  await harness.emit("turn_end");
  assert.deepEqual(events, ["requested"]);
  harness.compactCalls[0]?.onComplete?.(compactResult());
  assert.deepEqual(events, ["requested", "completed"]);
  assert.equal(harness.sentMessages.length, 0);
});

test("an active goal resumes once after Pi completes automatic compaction", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Continue this goal after compaction");
  assert.equal(harness.sentMessages.length, 1);

  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  assert.equal(harness.state().state?.status, "active");
  assert.equal(harness.sentMessages.length, 1);

  await harness.emit("session_compact", { type: "session_compact", reason: "manual" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.state().state?.status, "active");
  assert.equal(harness.sentMessages.length, 1, "the compaction event precedes Pi's completion callback");

  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 2);
  assert.equal((harness.sentMessages[1]?.message as { customType: string }).customType, "killeros-goal-continuation");

  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 2);
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
  harness.compactCalls[0]?.onError?.(new Error("compaction unavailable"));
  assert.equal(harness.state().state?.status, "paused");
  assert.match(harness.state().state?.result ?? "", /automatic compaction failed: compaction unavailable/u);
  assert.equal(harness.sentMessages.length, 1);
});

test("a successful compaction must be followed by a higher reading before another trigger", async () => {
  const harness = createHarness();
  await harness.emit("turn_end");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 1);
  harness.setUsage({ tokens: 70_000, contextWindow: 100_000, percent: 70 });
  await harness.emit("turn_end");
  harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 2);
});
