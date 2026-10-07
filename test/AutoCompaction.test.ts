import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  CompactOptions,
  ContextUsage,
  ExtensionCommandContext,
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
import { registerGoalInterface } from "../killeros/goal-interface.ts";
import { GOAL_CONTINUATION_TYPE, registerGoalRuntime } from "../killeros/goal-runtime.ts";
import { registerGoalSettlement } from "../killeros/goal-settlement.ts";
import { createGoalRuntime } from "../killeros/runtime.ts";
import { createKillerosSettingsStore, type KillerosSettingsStore } from "../killeros/settings.ts";
import {
  extensionApiTestAdapter,
  extensionCommandContextTestAdapter,
  extensionContextTestAdapter,
} from "./PiTestAdapters.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type GoalTool = {
  name: string;
  execute: (id: string, params: unknown, signal: AbortSignal, onUpdate: () => void, ctx: ExtensionContext) => Promise<{ details: Record<string, unknown> }>;
};

function requiredMapValue<T>(values: ReadonlyMap<string, T>, key: string): T {
  const value = values.get(key);
  assert.ok(value, `expected ${key} to be registered`);
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AutoHarness {
  activeTools: string[];
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
  percentRemaining = 15,
): AutoHarness {
  const handlers = new Map<string, Handler[]>();
  const activeTools = ["read", "bash", "edit", "write"];
  const compactCalls: CompactOptions[] = [];
  const notifications: AutoHarness["notifications"] = [];
  const sentMessages: AutoHarness["sentMessages"] = [];
  let usage: ContextUsage | undefined = initialUsage;
  let continuationError: Error | undefined;
  const api = extensionApiTestAdapter({
    getActiveTools: () => [...activeTools],
    on(eventName: string, handler: Handler): void {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    },
    registerCommand: () => {},
    registerTool: () => {},
    setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names); },
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
    loadPreference: () => ({ enabled: true, percentRemaining }),
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 }),
    goal,
  });
  return {
    activeTools,
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

function createCommandHarness(
  settingsStore: KillerosSettingsStore,
  mode: "tui" | "rpc" = "tui",
): {
  compactCalls: CompactOptions[];
  notifications: Array<{ message: string; type?: string }>;
  run(args: string): Promise<void>;
  turnEnd(): Promise<void>;
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const compactCalls: CompactOptions[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const api = extensionApiTestAdapter({
    on(eventName: string, handler: Handler): void {
      handlers.set(eventName, [...(handlers.get(eventName) ?? []), handler]);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ): void {
      commands.set(name, command.handler);
    },
  });
  const context = {
    cwd: process.cwd(),
    getContextUsage: () => ({ tokens: 84_000, contextWindow: 100_000, percent: 84 }),
    isProjectTrusted: () => true,
    mode,
    compact: (options?: CompactOptions) => { if (options) compactCalls.push(options); },
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  };
  registerAutoCompaction(api, {
    settingsStore,
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 }),
  });
  const command = requiredMapValue(commands, "auto-compact");
  return {
    compactCalls,
    notifications,
    run: (args) => command(args, extensionCommandContextTestAdapter(context)),
    async turnEnd(): Promise<void> {
      for (const handler of handlers.get("turn_end") ?? []) {
        await handler({ type: "turn_end" }, extensionContextTestAdapter(context));
      }
    },
  };
}

function createGoalHarness(mode: "tui" | "rpc" = "rpc", percentRemaining = 15): {
  compactCalls: CompactOptions[];
  notifications: Array<{ message: string; type?: string }>;
  persistedStatuses: string[];
  sentMessages: Array<{ message: unknown; options: unknown }>;
  state(): ReturnType<typeof createGoalRuntime>;
  failCompactionSynchronously(error?: Error): void;
  failPersistence(error?: Error): void;
  lastState(): Record<string, unknown>;
  decide(params: Record<string, unknown>): Promise<{ details: Record<string, unknown> }>;
  runGoalCommand(command: string): Promise<void>;
  startGoal(objective: string): Promise<void>;
  emit(eventName: string, event?: unknown): Promise<unknown>;
} {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const tools = new Map<string, GoalTool>();
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
    registerTool: (tool: GoalTool) => tools.set(tool.name, tool),
    sendMessage: (message: unknown, options: unknown) => sentMessages.push({ message, options }),
    setActiveTools: (names: string[]) => activeTools.splice(0, activeTools.length, ...names),
  });
  const runtime = createGoalRuntime();
  registerGoalInterface(api, runtime);
  registerGoalRuntime(api, runtime);
  const goal = registerGoalSettlement(api, runtime);
  registerAutoCompaction(api, {
    loadPreference: () => ({ enabled: true, percentRemaining }),
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
      confirm: async () => true,
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
    lastState: () => {
      const data = entries.at(-1);
      assert.ok(isUnknownRecord(data) && isUnknownRecord(data.data) && isUnknownRecord(data.data.state));
      return data.data.state;
    },
    decide: (params) => requiredMapValue(tools, "killeros_goal_update").execute(
      `decision-${entries.length}`,
      params,
      new AbortController().signal,
      () => {},
      ctx,
    ),
    runGoalCommand: (command) => requiredMapValue(commands, "goal").handler(command, ctx),
    startGoal: (objective) => requiredMapValue(commands, "goal").handler(objective, ctx),
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

test("/auto-compact reports enabled and disabled status in TUI and RPC modes", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const settings = {
      autoCompaction: { enabled: true, percentRemaining: 15 },
    };
    const harness = createCommandHarness({
      load: () => settings,
      update: () => {},
    }, mode);

    await harness.run("  ");
    await harness.run(" status ");
    settings.autoCompaction.enabled = false;
    await harness.run("status");

    assert.deepEqual(harness.notifications, [
      { message: "Automatic compaction: on at 15% remaining", type: "info" },
      { message: "Automatic compaction: on at 15% remaining", type: "info" },
      { message: "Automatic compaction: off (threshold 15%)", type: "info" },
    ], mode);
  }
});

test("/auto-compact persists both effective fields and preserves unrelated settings", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-auto-command-"));
  try {
    const settingsPath = path.join(directory, "killeros.json");
    writeFileSync(settingsPath, JSON.stringify({
      completionSound: true,
      handoffMaxTokens: 4096,
      futureSetting: { retained: "exactly" },
      autoCompaction: { enabled: true, percentRemaining: 12.5 },
    }));
    const harness = createCommandHarness(createKillerosSettingsStore(settingsPath));

    await harness.run(" off ");
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      completionSound: true,
      handoffMaxTokens: 4096,
      futureSetting: { retained: "exactly" },
      autoCompaction: { enabled: false, percentRemaining: 12.5 },
    });
    await harness.run("20");
    await harness.run("on");
    await harness.run("00");
    await harness.run("15");
    await harness.run("100");

    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
      completionSound: true,
      handoffMaxTokens: 4096,
      futureSetting: { retained: "exactly" },
      autoCompaction: { enabled: true, percentRemaining: 100 },
    });
    assert.deepEqual(harness.notifications.map(({ message }) => message), [
      "Automatic compaction: off (threshold 12.5%)",
      "Automatic compaction threshold: 20% remaining (off)",
      "Automatic compaction: on at 20% remaining",
      "Automatic compaction threshold: 0% remaining (on)",
      "Automatic compaction threshold: 15% remaining (on)",
      "Automatic compaction threshold: 100% remaining (on)",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/auto-compact rejects non-integer percentages and extra input without writing", async () => {
  const invalid = ["-1", "101", "1.5", "1e1", "+10", "10%", "10 now", "ON", "unknown"];
  let updates = 0;
  const harness = createCommandHarness({
    load: () => ({ autoCompaction: { enabled: true, percentRemaining: 15 } }),
    update: () => { updates += 1; },
  });

  for (const value of invalid) await harness.run(value);

  assert.equal(updates, 0);
  assert.deepEqual(harness.notifications, invalid.map(() => ({
    message: "Usage: /auto-compact [status|on|off|<percent 0-100>]",
    type: "error",
  })));
});

test("/auto-compact normalizes invalid stored fields before saving", async () => {
  let saved: Readonly<Record<string, unknown>> | undefined;
  const harness = createCommandHarness({
    load: () => ({ autoCompaction: { enabled: "yes", percentRemaining: 900 } }),
    update: (patch) => { saved = typeof patch === "function" ? patch({ autoCompaction: { enabled: "yes", percentRemaining: 900 } }) : patch; },
  });

  await harness.run("off");
  assert.deepEqual(saved, { autoCompaction: { enabled: false, percentRemaining: 15 } });

  await harness.run("20");
  assert.deepEqual(saved, { autoCompaction: { enabled: true, percentRemaining: 20 } });
});

test("/auto-compact reports read and save failures without success", async () => {
  const readFailure = createCommandHarness({
    load: () => { throw new Error("bad\x1B[31m file"); },
    update: () => {},
  });
  await readFailure.run("status");
  assert.deepEqual(readFailure.notifications, [{
    message: "Automatic compaction setting could not be read: bad file",
    type: "error",
  }]);

  const writeFailure = createCommandHarness({
    load: () => ({ autoCompaction: { enabled: true, percentRemaining: 15 } }),
    update: () => { throw new Error("disk full"); },
  });
  await writeFailure.run("off");
  assert.deepEqual(writeFailure.notifications, [{
    message: "Automatic compaction setting could not be saved: disk full",
    type: "error",
  }]);
});

test("/auto-compact changes the next eligibility check without compacting immediately", async () => {
  let settings: Record<string, unknown> = {
    autoCompaction: { enabled: true, percentRemaining: 15 },
  };
  const harness = createCommandHarness({
    load: () => settings,
    update: (patch) => { settings = { ...settings, ...(typeof patch === "function" ? patch(settings) : patch) }; },
  });

  await harness.run("20");
  assert.equal(harness.compactCalls.length, 0);
  await harness.turnEnd();
  assert.equal(harness.compactCalls.length, 1);
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
    await harness.emit("message_start", {
      type: "message_start",
      message: { role: "custom", customType: AUTO_COMPACTION_MESSAGE_TYPE },
    });
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

test("a stale ordinary continuation cannot dispatch after a committed lifecycle reset", async () => {
  for (const event of ["session_start", "session_shutdown", "session_tree"] as const) {
    const harness = createHarness();
    await harness.emit("turn_end");
    const callbacks = harness.compactCalls[0];

    await harness.emit(event);
    callbacks?.onComplete?.(compactResult());
    await harness.emit("agent_settled");

    assert.equal(harness.sentMessages.length, 0, event);
  }
});

test("a cancelled session replacement preserves ordinary compaction recovery", async () => {
  for (const event of ["session_before_switch", "session_before_fork"] as const) {
    const harness = createHarness();
    await harness.emit("turn_end");
    await harness.emit("agent_settled");
    const callbacks = harness.compactCalls[0];

    await harness.emit(event);
    callbacks?.onComplete?.(compactResult());

    assert.equal(harness.sentMessages.length, 1, event);
  }
});

test("a committed session replacement invalidates callbacks during teardown", async () => {
  for (const event of ["session_before_switch", "session_before_fork"] as const) {
    const harness = createHarness();
    await harness.emit("turn_end");
    await harness.emit("agent_settled");
    const callbacks = harness.compactCalls[0];

    await harness.emit(event);
    await harness.emit("session_shutdown");
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

test("an asynchronously rejected ordinary continuation releases request state", async () => {
  const harness = createHarness();
  await harness.emit("turn_end");
  await harness.emit("agent_settled");
  harness.compactCalls[0]?.onComplete?.(compactResult());

  await harness.emit("agent_settled");
  harness.setUsage({ tokens: 70_000, contextWindow: 100_000, percent: 70 });
  await harness.emit("turn_end");
  harness.setUsage({ tokens: 90_000, contextWindow: 100_000, percent: 90 });
  await harness.emit("turn_end");

  assert.equal(harness.compactCalls.length, 2);
  assert.match(harness.notifications.at(-1)?.message ?? "", /continuation was not accepted/u);
});

test("missing readings, disabled Pi compaction, and failed compaction do not retry automatically", async () => {
  const missing = createHarness("tui", { tokens: null, contextWindow: 100_000, percent: null });
  await missing.emit("turn_end");
  assert.equal(missing.compactCalls.length, 0);

  const failure = createHarness();
  // The harness supplies enabled Pi settings; replace the registration with a separate disabled probe.
  const disabledHandlers = new Map<string, Handler[]>();
  const disabledApi = extensionApiTestAdapter({
    registerCommand: () => {},
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
    hasAcceptedTerminalDecision: () => false,
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

test("terminal goal requests never become ordinary compaction continuations", async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const status of ["complete", "blocked"] as const) {
      for (const order of ["before settlement", "after settlement"] as const) {
        await t.test(`${mode}/${status}/${order}`, async () => {
          const harness = createGoalHarness(mode, 100);
          await harness.startGoal("Stop after the terminal decision");
          const turns = status === "blocked" ? 3 : 1;
          for (let turn = 1; turn <= turns; turn++) {
            await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "Test prompt" });
            await harness.emit("agent_start");
            await harness.decide({ status, evidence: `Verified turn ${turn}`, ...(status === "blocked" ? { blockerKey: "external" } : {}) });
            if (turn < turns) {
              await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
              await harness.emit("agent_settled");
              await new Promise((resolve) => setImmediate(resolve));
            }
          }
          assert.equal(harness.state().state?.status, status);
          await harness.emit("turn_end");
          assert.equal(harness.compactCalls.length, 1);
          if (order === "before settlement") harness.compactCalls[0]?.onComplete?.(compactResult());
          await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
          await harness.emit("agent_settled");
          if (order === "after settlement") harness.compactCalls[0]?.onComplete?.(compactResult());
          harness.compactCalls[0]?.onComplete?.(compactResult());
          await new Promise((resolve) => setImmediate(resolve));

          assert.equal(harness.sentMessages.length, turns, "compaction must not start another request");
          assert.equal(harness.state().state?.status, status);
          assert.equal(harness.state().state?.turns, turns);
          assert.equal(harness.state().automaticCompaction, undefined);
          assert.deepEqual(harness.notifications.filter(({ type }) => type === "error"), []);

          // A later ordinary request must not inherit the terminal goal's ownership.
          await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "Ordinary prompt" });
          await harness.emit("agent_start");
          await harness.emit("message_start", { message: { role: "user", content: "Ordinary work" } });
          await harness.emit("turn_end");
          await harness.emit("agent_settled");
          harness.compactCalls[1]?.onComplete?.(compactResult());
          assert.equal(harness.compactCalls.length, 2);
          const continuation = harness.sentMessages.at(-1)?.message;
          assert.ok(isUnknownRecord(continuation));
          assert.equal(continuation.customType, AUTO_COMPACTION_MESSAGE_TYPE);
          assert.equal(harness.sentMessages.length, turns + 1);
        });
      }
    }
  }
});

async function startBlocked(harness: ReturnType<typeof createGoalHarness>): Promise<void> {
  await harness.startGoal("Audit the original blocked objective");
  for (let turn = 1; turn <= 3; turn++) {
    await harness.emit("before_agent_start", { systemPrompt: "Goal prompt" });
    await harness.emit("agent_start");
    await harness.decide({ status: "blocked", evidence: `Missing prerequisite ${turn}`, blockerKey: "external" });
    await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    await harness.emit("agent_settled");
  }
  assert.equal(harness.state().state?.status, "blocked");
  assert.equal(harness.sentMessages.length, 3);
}

test("accepted blocked completion prevents compaction restart in either callback order, including already pending compaction", async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const timing of ["before completion", "after completion"] as const) {
      for (const order of ["before settlement", "after settlement", "before completion"] as const) {
        if (order === "before completion" && timing === "after completion") continue;
        for (const outcome of ["completed", "skipped"] as const) {
          await t.test(`${mode}/${timing}/${order}/${outcome}`, async () => {
            const harness = createGoalHarness(mode, 100);
            await startBlocked(harness);
            await harness.emit("before_agent_start", { systemPrompt: "Ordinary prompt" });
            await harness.emit("agent_start");
            await harness.emit("message_start", { message: { role: "user", content: "Finish the original objective" } });
            const callback = () => {
              const call = harness.compactCalls[0];
              assert.ok(call);
              if (outcome === "completed") call.onComplete?.(compactResult());
              else call.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
            };
            if (timing === "before completion") await harness.emit("turn_end");
            if (order === "before completion") callback();
            await harness.decide({ status: "complete", evidence: "Audited all original criteria" });
            if (timing === "after completion") await harness.emit("turn_end");
            if (order === "before settlement") callback();
            await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
            await harness.emit("agent_settled");
            if (order === "after settlement") callback();
            callback();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(harness.state().state?.status, "complete");
            assert.equal(harness.state().state?.turns, 3);
            assert.equal(harness.state().automaticCompaction, undefined);
            assert.equal(harness.state().blockedCompletion, undefined);
            assert.equal(harness.sentMessages.length, 3, "accepted completion must stop ordinary compaction continuation");
            assert.deepEqual(harness.notifications.filter(({ type }) => type === "error"), []);

            await harness.emit("before_agent_start", { systemPrompt: "Later unrelated prompt" });
            await harness.emit("agent_start");
            await harness.emit("message_start", { message: { role: "user", content: "Unrelated task" } });
            await harness.emit("turn_end");
            const next = harness.compactCalls[1];
            assert.ok(next, "the later unrelated request must still compact");
            await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
            await harness.emit("agent_settled");
            next.onComplete?.(compactResult());
            assert.equal(harness.sentMessages.length, 4);
            const message = harness.sentMessages.at(-1)?.message;
            assert.ok(isUnknownRecord(message));
            assert.equal(message.customType, AUTO_COMPACTION_MESSAGE_TYPE);
          });
        }
      }
    }
  }
});

test("a blocked request without accepted completion keeps ordinary compaction continuation", async () => {
  const harness = createGoalHarness("rpc", 100);
  await startBlocked(harness);
  const blocked = harness.state().state;
  await harness.emit("before_agent_start", { systemPrompt: "Ordinary prompt" });
  await harness.emit("agent_start");
  await harness.emit("turn_end");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await harness.emit("agent_settled");
  assert.equal(harness.state().state, blocked);
  assert.equal(harness.state().automaticCompaction, undefined);
  assert.equal(harness.sentMessages.length, 4);
  const message = harness.sentMessages.at(-1)?.message;
  assert.ok(isUnknownRecord(message));
  assert.equal(message.customType, AUTO_COMPACTION_MESSAGE_TYPE);
});

test("terminal goal compaction skips stay silent and failures stay visible without continuing", async () => {
  for (const outcome of ["skipped", "failed"] as const) {
    for (const synchronous of [false, true]) {
      const harness = createGoalHarness("rpc", 100);
      await harness.startGoal("Keep the completed request stopped");
      await harness.emit("before_agent_start", { systemPrompt: "Test prompt" });
      await harness.emit("agent_start");
      await harness.decide({ status: "complete", evidence: "Verified" });
      const error = new Error(outcome === "skipped" ? SESSION_TOO_SMALL_COMPACTION_ERROR : "provider unavailable");
      if (synchronous) harness.failCompactionSynchronously(error);
      await harness.emit("turn_end");
      await harness.emit("agent_settled");
      if (!synchronous) harness.compactCalls[0]?.onError?.(error);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.state().state?.status, "complete");
      assert.equal(harness.sentMessages.length, 1);
      const errors = harness.notifications.filter(({ type }) => type === "error");
      assert.equal(errors.length, outcome === "failed" ? 1 : 0);
      if (outcome === "failed") assert.match(errors[0]?.message ?? "", /provider unavailable/u);
    }
  }
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

test("automatic compaction cannot revive a normally stopped goal without a decision", async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const outcome of ["completed", "skipped"] as const) {
      for (const callbackOrder of ["before settlement", "after settlement"] as const) {
        await t.test(`${mode}/${outcome}/${callbackOrder}`, async () => {
          const harness = createGoalHarness(mode, 100);
          await harness.startGoal("Pause if the model does not choose a decision");
          await harness.emit("turn_end");
          const finishCompaction = (): void => {
            if (outcome === "completed") harness.compactCalls[0]?.onComplete?.(compactResult());
            else harness.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
          };
          if (callbackOrder === "before settlement") finishCompaction();
          await harness.emit("agent_end", {
            type: "agent_end",
            messages: [{ role: "assistant", stopReason: "stop" }],
          });
          await harness.emit("agent_settled");
          if (callbackOrder === "after settlement") finishCompaction();
          finishCompaction();
          await harness.emit("agent_settled");
          await new Promise((resolve) => setImmediate(resolve));

          assert.equal(harness.state().state?.status, "paused");
          assert.equal(harness.state().state?.result, "no turn decision");
          assert.equal(harness.state().state?.turns, 1);
          assert.equal(harness.state().state?.maxTurns, 20);
          assert.equal(harness.state().automaticCompaction, undefined);
          assert.equal(harness.state().goalTurnInFlight, false);
          assert.equal(harness.sentMessages.length, 1);
        });
      }
    }
  }
});

test("normal goal decisions survive compaction without bypassing the turn limit", async () => {
  for (const outcome of ["completed", "skipped"] as const) {
    for (const maxTurns of [1, 20]) {
      const harness = createGoalHarness("rpc", 100);
      await harness.startGoal("Honor the accepted decision and its turn budget");
      const runtime = harness.state();
      assert.ok(runtime.state);
      runtime.state = { ...runtime.state, maxTurns };
      await harness.decide({ status: "continue", evidence: "First step checked", nextAction: "Check the next step" });
      await harness.emit("turn_end");
      await harness.emit("agent_end", {
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      await harness.emit("agent_settled");
      if (outcome === "completed") harness.compactCalls[0]?.onComplete?.(compactResult());
      else harness.compactCalls[0]?.onError?.(new Error(SESSION_TOO_SMALL_COMPACTION_ERROR));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(runtime.state?.status, maxTurns === 1 ? "paused" : "active");
      assert.equal(runtime.state?.turns, maxTurns === 1 ? 1 : 2);
      assert.equal(runtime.state?.maxTurns, maxTurns);
      assert.equal(harness.sentMessages.length, maxTurns === 1 ? 1 : 2);
      if (maxTurns === 1) assert.equal(runtime.state?.result, "Turn limit reached (1/1).");
    }
  }
});

test("an accepted goal decision survives automatic compaction and starts exactly one next turn", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Continue this goal after compaction");
  await harness.decide({
    status: "continue",
    evidence: "The first step passed",
    nextAction: "Run the remaining step",
  });

  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  await harness.emit("agent_settled");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.lastState().status, "active");
  assert.equal(harness.lastState().turns, 2);
  assert.equal(harness.lastState().turnDecision, undefined);
  assert.deepEqual(harness.lastState().lastDecision, {
    kind: "continue",
    turn: 1,
    evidence: "The first step passed",
    nextAction: "Run the remaining step",
  });
});

test("replacing a goal during compaction cannot revive the old goal", async () => {
  const harness = createGoalHarness();
  await harness.startGoal("Finish the old objective");
  await harness.decide({
    status: "continue",
    evidence: "Old progress",
    nextAction: "Old next action",
  });
  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");

  await harness.runGoalCommand("Finish the replacement objective");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 2);
  assert.equal(harness.lastState().objective, "Finish the replacement objective");
  assert.equal(harness.lastState().turns, 1);
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

test("a cancelled session replacement preserves automatic goal recovery", async () => {
  for (const event of ["session_before_switch", "session_before_fork"] as const) {
    const harness = createGoalHarness();
    await harness.startGoal(`Resume after cancelled ${event}`);
    await harness.emit("turn_end");
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    await harness.emit("agent_settled");

    await harness.emit(event);
    assert.ok(harness.state().automaticCompaction, event);
    harness.compactCalls[0]?.onComplete?.(compactResult());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.state().state?.status, "active", event);
    assert.equal(harness.sentMessages.length, 2, event);
  }
});

test("a committed goal session replacement invalidates recovery during teardown", async () => {
  for (const event of ["session_before_switch", "session_before_fork"] as const) {
    const harness = createGoalHarness();
    await harness.startGoal(`Do not resume after ${event}`);
    await harness.emit("turn_end");
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    await harness.emit("agent_settled");
    const callbacks = harness.compactCalls[0];

    await harness.emit(event);
    await harness.emit("session_shutdown");
    callbacks?.onComplete?.(compactResult());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.sentMessages.length, 1, event);
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

test("100 percent rearms on a later user request without compacting its ordinary continuation", async () => {
  const harness = createHarness("tui", undefined, undefined, 100);
  await harness.emit("turn_end");
  await harness.emit("agent_settled");
  harness.compactCalls[0]?.onComplete?.(compactResult());

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "custom", customType: AUTO_COMPACTION_MESSAGE_TYPE },
  });
  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 1);

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content: "Start another request" },
  });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 2);
});

test("100 percent rearms for the next recovered goal turn", async () => {
  const harness = createGoalHarness("rpc", 100);
  await harness.startGoal("Continue after each successful compaction");
  await harness.emit("turn_end");
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  await harness.emit("agent_settled");
  harness.compactCalls[0]?.onComplete?.(compactResult());
  await new Promise((resolve) => setImmediate(resolve));

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "custom", customType: GOAL_CONTINUATION_TYPE },
  });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 2);
});

test("a failed compaction at 100 percent remains disarmed for later requests", async () => {
  const harness = createHarness("tui", undefined, undefined, 100);
  await harness.emit("turn_end");
  harness.compactCalls[0]?.onError?.(new Error("provider unavailable"));

  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content: "Try another request" },
  });
  await harness.emit("turn_end");
  assert.equal(harness.compactCalls.length, 1);
});

test("a successful compaction below 100 percent must be followed by a higher reading before another trigger", async () => {
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
    hasAcceptedTerminalDecision: () => false,
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
  assert.match(unsavable.notifications.at(-1)?.message ?? "", /interrupted goal turn could not be resumed/u);

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
    registerCommand: () => {},
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

test("BUG-02 concurrent auto-compact commands preserve both independently changed fields", { timeout: 40000 }, async (t) => {
  for (const order of [[0, 1], [1, 0]]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "killeros-edge-nested-settings-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const settingsPath = path.join(root, "killeros.json"), gate = path.join(root, "gate");
    writeFileSync(settingsPath, JSON.stringify({ futureSetting: "keep", autoCompaction: { enabled: true, percentRemaining: 15 } }));
    const settingsUrl = new URL("../killeros/settings.ts", import.meta.url).href;
    const autoUrl = new URL("../killeros/auto-compaction.ts", import.meta.url).href;
    const adapterUrl = new URL("./PiTestAdapters.ts", import.meta.url).href;
    const writers = ["off", "70"].map((argument, index) => {
      const script = `
        import {existsSync} from 'node:fs';
        import {createKillerosSettingsStore} from ${JSON.stringify(settingsUrl)};
        import {registerAutoCompaction} from ${JSON.stringify(autoUrl)};
        import {extensionApiTestAdapter, extensionCommandContextTestAdapter} from ${JSON.stringify(adapterUrl)};
        const store = createKillerosSettingsStore(${JSON.stringify(settingsPath)});
        let command;
        let succeeded = false;
        registerAutoCompaction(extensionApiTestAdapter({on(){}, registerCommand(_name, definition){ command = definition; }}), {
          settingsStore: { load(){ return store.load(); }, update(patch){
            const snapshot = store.load();
            if (snapshot.autoCompaction.enabled !== true || snapshot.autoCompaction.percentRemaining !== 15) throw new Error("writers did not share the initial preference");
            process.stdout.write('read\\n');
            while (!existsSync(${JSON.stringify(gate + index)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
            store.update(patch);
          } }
        });
        await command.handler(${JSON.stringify(argument)}, extensionCommandContextTestAdapter({ ui: {notify(message, level){
          if(level === 'error') throw new Error(message);
          if(level === 'info') succeeded = true;
        }} }));
        if (!succeeded) throw new Error("command did not report success");
      `;
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
      t.after(() => child.kill("SIGKILL"));
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const completed = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      const ready = Promise.race([new Promise<void>((resolve) => child.stdout.once("data", () => resolve())), completed.then(() => { throw new Error("writer exited before reading"); })]);
      return { ready, completed };
    });
    await Promise.all(writers.map((writer) => writer.ready));
    for (const index of order) {
      writeFileSync(gate + index, "go");
      await writers[index]?.completed;
    }
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { futureSetting: "keep", autoCompaction: { enabled: false, percentRemaining: 70 } });
  }
});

test("/auto-compact preserves the original file on malformed settings and replacement failure", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-auto-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, "killeros.json");
  for (const original of ["{malformed", JSON.stringify({ futureSetting: "keep", autoCompaction: { enabled: true, percentRemaining: 15 } })]) {
    writeFileSync(settingsPath, original);
    const rename = fs.renameSync;
    const intercepted = t.mock.method(fs, "renameSync", (...args: Parameters<typeof rename>) => {
      if (args[1] === settingsPath) throw new Error("disk full");
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      const harness = createCommandHarness(createKillerosSettingsStore(settingsPath));
      await harness.run("off");
      assert.equal(readFileSync(settingsPath, "utf8"), original);
      assert.equal(harness.notifications.length, 1);
      assert.equal(harness.notifications[0]?.type, "error");
      assert.match(harness.notifications[0]?.message ?? "", /could not be saved/u);
    } finally {
      intercepted.mock.restore();
      syncBuiltinESMExports();
    }
  }
});
