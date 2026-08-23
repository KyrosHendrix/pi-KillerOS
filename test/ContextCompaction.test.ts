import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import Killeros from "../Killeros.ts";

const theme = {
  bold(text: string): string { return text; },
  fg(_color: string, text: string): string { return text; },
  italic(text: string): string { return text; },
  strikethrough(text: string): string { return text; },
  underline(text: string): string { return text; },
} as unknown as Theme;

type TestEvent = {
  type: string;
  [key: string]: unknown;
};

type TestHandler = (event: TestEvent, ctx: TestContext) => unknown | Promise<unknown>;

type TestCommand = {
  description?: string;
  handler(args: string, ctx: TestContext): unknown | Promise<unknown>;
};

type TestTool = {
  name: string;
  execute(...args: unknown[]): Promise<unknown>;
};

type TestEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  customType?: string;
  data?: Record<string, unknown>;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
};

type SavedGoalState = {
  version: number;
  revision: number;
  objective: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  activeMilliseconds: number;
  turns: number;
  blockedAuditStartTurn: number;
  baselineTokens: number;
  resumeAfterManualCompaction?: boolean;
  [key: string]: unknown;
};

type AppendedEntry = {
  type: "custom";
  customType: string;
  data: { event: string; state: SavedGoalState };
};

type TestContext = {
  cwd: string;
  getContextUsage(): unknown;
  hasPendingMessages(): boolean;
  hasUI: boolean;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  mode: "tui";
  model: unknown;
  modelRegistry: {
    getApiKeyAndHeaders(): Promise<unknown>;
    getProvider(): unknown;
  };
  sessionManager: {
    getBranch(): TestEntry[];
    getEntries(): TestEntry[];
    getSessionFile(): string;
  };
  signal: AbortSignal | undefined;
  abort(): void;
  compact(options: unknown): void;
  getSystemPrompt(): string;
  shutdown(): void;
  ui: {
    addAutocompleteProvider(...args: unknown[]): void;
    confirm(...args: unknown[]): Promise<boolean>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, level?: string): void;
    setEditorComponent(...args: unknown[]): void;
    setFooter(...args: unknown[]): void;
    setHeader(...args: unknown[]): void;
    setTitle(...args: unknown[]): void;
    setTheme(...args: unknown[]): { success: boolean };
    setHiddenThinkingLabel(...args: unknown[]): void;
    setWorkingIndicator(...args: unknown[]): void;
    setWorkingMessage(...args: unknown[]): void;
    theme: Theme;
  };
  waitForIdle(): Promise<void>;
};

type TestAPI = {
  appendEntry(customType: string, data: unknown): void;
  getAllTools(): Array<TestTool & { sourceInfo: Record<string, string> }>;
  getCommands(): Array<{ name: string; description?: string; source: string; sourceInfo: Record<string, string> }>;
  getSessionName(): undefined;
  getThinkingLevel(): string;
  on(event: string, handler: TestHandler): void;
  registerCommand(name: string, command: TestCommand): void;
  registerEntryRenderer(...args: unknown[]): void;
  registerTool(tool: TestTool): void;
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(...args: unknown[]): void;
  setThinkingLevel(...args: unknown[]): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
};

type Harness = {
  api: TestAPI;
  appendedEntries: AppendedEntry[];
  commands: Map<string, TestCommand>;
  handlers: Map<string, TestHandler[]>;
  sentMessages: Array<{ message: unknown; options: unknown }>;
  tools: Map<string, TestTool>;
};

type ContextUsage = { tokens: number | null; contextWindow: number };
type ContextOptions = {
  entries?: TestEntry[];
  usage?: ContextUsage | (() => ContextUsage | undefined);
  notifications?: Array<{ message: string; level?: string }>;
  compactCalls?: unknown[];
};

function createHarness(): Harness {
  const commands = new Map<string, TestCommand>();
  const handlers = new Map<string, TestHandler[]>();
  const tools = new Map<string, TestTool>();
  const appendedEntries: AppendedEntry[] = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const activeTools: string[] = [];
  const sourceInfo = {
    path: `${process.cwd()}/Killeros.ts`,
    source: "npm:killeros",
    baseDir: process.cwd(),
  };
  const api: TestAPI = {
    appendEntry: (customType: string, data: unknown) => {
      const entryData = data as { event: string; state: SavedGoalState };
      appendedEntries.push({ type: "custom", customType, data: entryData });
    },
    getAllTools: () => [...tools.values()].map((tool) => ({ ...tool, sourceInfo })),
    getCommands: () => [...commands].map(([name, command]) => ({
      name,
      description: command.description,
      source: "extension",
      sourceInfo,
    })),
    getSessionName: () => undefined,
    getThinkingLevel: () => "high",
    on: (event: string, handler: TestHandler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: (name: string, command: TestCommand) => { commands.set(name, command); },
    registerEntryRenderer: () => {},
    registerTool: (tool: TestTool) => { tools.set(tool.name, tool); },
    sendMessage: (message: unknown, options?: unknown) => sentMessages.push({ message, options }),
    sendUserMessage: () => {},
    setThinkingLevel: () => {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names); },
  };

  Killeros(api as unknown as ExtensionAPI, {
    completionNotifications: {
      store: { load: () => false, save: () => {} },
      ring: () => {},
    },
  });
  activeTools.push(...tools.keys());
  return { api, appendedEntries, commands, handlers, sentMessages, tools };
}

function createContext({
  entries = [],
  usage = { tokens: 1_000, contextWindow: 128_000 },
  notifications = [],
  compactCalls = [],
}: ContextOptions = {}): { compactCalls: unknown[]; ctx: TestContext; notifications: Array<{ message: string; level?: string }> } {
  const ctx: TestContext = {
    cwd: process.cwd(),
    getContextUsage: () => (typeof usage === "function" ? usage() : usage),
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode: "tui",
    model: undefined,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: false, error: "No model auth is available" }),
      getProvider: () => undefined,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => path.join(process.cwd(), "session.jsonl"),
    },
    signal: undefined,
    abort() {},
    compact: (options: unknown) => { compactCalls.push(options); },
    getSystemPrompt: () => "",
    shutdown() {},
    ui: {
      addAutocompleteProvider: () => {},
      confirm: async () => true,
      editor: async (_title: string, prefill?: string) => prefill,
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
      setEditorComponent: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      setTheme: () => ({ success: true }),
      setHiddenThinkingLabel: () => {},
      setWorkingIndicator: () => {},
      setWorkingMessage: () => {},
      theme,
    },
    waitForIdle: async () => {},
  };
  return { compactCalls, ctx, notifications };
}

async function emitSequentially(
  handlers: TestHandler[] | undefined,
  event: TestEvent,
  ctx: TestContext,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of handlers ?? []) results.push(await handler(event, ctx));
  return results;
}

function getCommand(harness: Harness, name: string): TestCommand {
  const command = harness.commands.get(name);
  assert.ok(command);
  return command;
}

function getTool(harness: Harness, name: string): TestTool {
  const tool = harness.tools.get(name);
  assert.ok(tool);
  return tool;
}

function lastAppendedEntry(harness: Harness): AppendedEntry {
  const entry = harness.appendedEntries.at(-1);
  assert.ok(entry);
  return entry;
}

async function startGoalTurn(harness: Harness, ctx: TestContext, objective = "Finish the migration"): Promise<void> {
  await getCommand(harness, "goal").handler(objective, ctx);
  await emitSequentially(harness.handlers.get("before_agent_start"), {
    type: "before_agent_start",
    prompt: "",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
}

async function abortActiveGoal(harness: Harness, ctx: TestContext, errorMessage?: string): Promise<void> {
  await startGoalTurn(harness, ctx, "Continue after manual compaction");
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted", errorMessage }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
}

function savedGoalState(overrides: Partial<SavedGoalState> = {}): SavedGoalState {
  const now = Date.now();
  return {
    version: 1,
    revision: 4,
    objective: "Resume the exact saved goal",
    status: "paused",
    createdAt: now - 60_000,
    updatedAt: now - 1_000,
    activeMilliseconds: 20_000,
    turns: 2,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    resumeAfterManualCompaction: true,
    ...overrides,
  };
}

function goalEntry(state: SavedGoalState, event = "error"): TestEntry {
  return {
    type: "custom",
    id: `goal-${state.revision}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "killeros-goal",
    data: { version: 1, event, state },
  };
}

function compactionEntry(id = "compact-1"): TestEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    summary: "Continue with the first unfinished verification step.",
    firstKeptEntryId: "message-1",
    tokensBefore: 80_000,
  };
}

function compactEvent(reason: string, willRetry = false): TestEvent {
  return {
    type: "session_compact",
    compactionEntry: compactionEntry(),
    fromExtension: false,
    reason,
    willRetry,
  };
}

test("auto-compaction stays idle while context remains above its threshold", async () => {
  const harness = createHarness();
  const { compactCalls, ctx, notifications } = createContext({
    usage: { tokens: 100_000, contextWindow: 128_000 },
  });

  assert.equal(harness.handlers.has("turn_end"), true);
  await emitSequentially(harness.handlers.get("turn_end"), {
    type: "turn_end", turnIndex: 0, message: {}, toolResults: [],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 0);
  assert.equal(notifications.length, 0);
});

test("contextPercentRemaining remains a public display helper", async () => {
  const { contextPercentRemaining } = await import("../Killeros.ts");
  const makeContext = (tokens: number | null, contextWindow = 128_000): ExtensionContext => ({
    getContextUsage: () => ({ tokens, contextWindow }),
  } as unknown as ExtensionContext);

  assert.equal(contextPercentRemaining(makeContext(89_600)), 30);
  assert.equal(contextPercentRemaining(makeContext(64_000)), 50);
  assert.equal(contextPercentRemaining(makeContext(200_000)), 0);
  assert.equal(contextPercentRemaining(makeContext(-1)), 100);
  assert.equal(contextPercentRemaining(makeContext(null)), null);
  assert.equal(contextPercentRemaining(makeContext(1, 0)), null);
  assert.equal(contextPercentRemaining({ getContextUsage: () => undefined } as unknown as ExtensionContext), null);
  assert.equal(contextPercentRemaining({
    getContextUsage: () => { throw new Error("unavailable"); },
  } as unknown as ExtensionContext), null);
});

test("threshold compaction continues a goal only at Pi's settled boundary", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx);
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);

  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("threshold"), ctx);
  assert.equal(harness.sentMessages.length, 1, "session_compact is not the continuation gate");
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(harness.sentMessages.length, 2);
});

test("threshold compaction failure remains Pi-owned and continues at settled", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx, "Continue after Pi retries compaction");
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);

  // Failed threshold compaction emits no session_compact extension event.
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(harness.sentMessages.length, 2);
});

test("overflow retry produces one continuation after the final settled result", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx, "Repair the overflowed task");
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "context overflow" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("overflow", true), ctx);
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  assert.equal(harness.sentMessages.length, 1);

  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(harness.sentMessages.length, 2);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(harness.sentMessages.length, 2);
});

test("an unrecovered overflow pauses through normal goal error handling", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx, "Repair the overflowed task");
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "overflow recovery failed" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  assert.equal(lastAppendedEntry(harness).data.state.status, "paused");
  assert.match(String(lastAppendedEntry(harness).data.state.result), /overflow recovery failed/u);
  assert.equal(lastAppendedEntry(harness).data.state.resumeAfterManualCompaction, undefined);
  assert.equal(harness.sentMessages.length, 1);
});

test("manual compaction resumes only the exact recovery-eligible paused goal", async () => {
  const harness = createHarness();
  const { ctx, notifications } = createContext();
  await abortActiveGoal(harness, ctx, "\x1b]2;owned\x07\x1b[31mcompaction\x1b[0m\0 started");

  const paused = lastAppendedEntry(harness).data.state;
  assert.equal(paused.status, "paused");
  assert.equal(paused.result, "compaction started");
  assert.equal(paused.resumeAfterManualCompaction, true);
  assert.match(notifications.at(-1)?.message ?? "", /paused.*\/compact|\/compact.*paused/iu);

  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  const resumed = lastAppendedEntry(harness).data.state;
  assert.equal(resumed.status, "active");
  assert.equal(resumed.resumeAfterManualCompaction, undefined);
  assert.equal(harness.sentMessages.length, 2);
  assert.match(notifications.at(-1)?.message ?? "", /compaction.*goal resumed/iu);
});

test("duplicate manual compaction events do not duplicate recovery", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 2);
});

test("failed or cancelled manual compaction leaves the marked goal paused", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);

  // Pi emits no session_compact event on failure or cancellation.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lastAppendedEntry(harness).data.state.status, "paused");
  assert.equal(harness.sentMessages.length, 1);
});

test("threshold and overflow compaction never consume manual recovery eligibility", async () => {
  for (const reason of ["threshold", "overflow"]) {
    const harness = createHarness();
    const { ctx } = createContext();
    await abortActiveGoal(harness, ctx);
    await emitSequentially(harness.handlers.get("session_compact"), compactEvent(reason, reason === "overflow"), ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lastAppendedEntry(harness).data.state.status, "paused", reason);
    assert.equal(harness.sentMessages.length, 1, reason);
  }
});

test("explicit /goal pause clears pending manual recovery", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  await getCommand(harness, "goal").handler("pause", ctx);

  const explicitPause = lastAppendedEntry(harness).data.state;
  assert.equal(explicitPause.status, "paused");
  assert.equal(explicitPause.resumeAfterManualCompaction, undefined);

  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 1);
});

test("explicit pause cancellation cannot become manual-compaction recovery", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  let abortCalls = 0;
  ctx.abort = () => { abortCalls += 1; };
  await startGoalTurn(harness, ctx, "Stay paused after explicit cancellation");
  await getCommand(harness, "goal").handler("pause", ctx);
  assert.equal(abortCalls, 1);

  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lastAppendedEntry(harness).data.state.status, "paused");
  assert.equal(lastAppendedEntry(harness).data.state.resumeAfterManualCompaction, undefined);
  assert.equal(harness.sentMessages.length, 1);
});

test("editing a marked paused goal clears recovery before reactivation", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  ctx.ui.editor = async () => "Edited objective";
  await getCommand(harness, "goal").handler("edit", ctx);

  const edited = lastAppendedEntry(harness).data.state;
  assert.equal(edited.objective, "Edited objective");
  assert.equal(edited.status, "active");
  assert.equal(edited.resumeAfterManualCompaction, undefined);
});

test("a terminal goal update cannot be revived by manual compaction", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx, "Complete before compaction");
  await getTool(harness, "killeros_goal_update").execute(
    "complete-before-compaction",
    { status: "complete", evidence: "verified before the manual abort" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lastAppendedEntry(harness).data.state.status, "complete");
  assert.equal(harness.sentMessages.length, 1);
});

test("a provider error pauses without compaction recovery eligibility", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx, "Fail closed");
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  assert.equal(lastAppendedEntry(harness).data.state.status, "paused");
  assert.equal(lastAppendedEntry(harness).data.state.resumeAfterManualCompaction, undefined);
});

test("reload does not infer manual recovery from a persisted compaction entry", async () => {
  const entries = [goalEntry(savedGoalState()), compactionEntry()];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.appendedEntries.length, 0);
  assert.equal(harness.sentMessages.length, 0);
});

test("reload clears stale manual recovery eligibility before later live compaction", async () => {
  const entries = [goalEntry(savedGoalState())];
  const harness = createHarness();
  const { ctx, notifications } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), { type: "session_compact", reason: "manual" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.appendedEntries.length, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(notifications.length, 0);
});

test("reload does not recover when compaction precedes the marked pause", async () => {
  const entries = [compactionEntry(), goalEntry(savedGoalState())];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
});

test("a later goal transition invalidates an older recovery marker", async () => {
  const marked = savedGoalState();
  const explicitPause = savedGoalState({ revision: 5, resumeAfterManualCompaction: undefined });
  const entries = [goalEntry(marked), compactionEntry(), goalEntry(explicitPause, "pause")];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
});

test("malformed active recovery markers fail closed", async () => {
  const invalid = savedGoalState({
    status: "active",
    activeStartedAt: Date.now(),
    resumeAfterManualCompaction: true,
  });
  const harness = createHarness();
  const { ctx } = createContext({ entries: [goalEntry(invalid), compactionEntry()] });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
});

test("tree navigation evaluates only the destination branch", async () => {
  const entries: TestEntry[] = [];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "startup" }, ctx);

  entries.push(goalEntry(savedGoalState()), compactionEntry());
  await emitSequentially(harness.handlers.get("session_tree"), {
    type: "session_tree", oldLeafId: null, newLeafId: "compact-1",
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
});

test("live recovery persistence failure stays paused and queues nothing", async () => {
  const harness = createHarness();
  const { ctx, notifications } = createContext();
  await abortActiveGoal(harness, ctx);
  harness.api.appendEntry = () => { throw new Error("session storage unavailable"); };

  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 1);
  assert.match(notifications.at(-1)?.message ?? "", /could not be resumed/u);
});

test("reload never attempts recovery persistence without a live manual event", async () => {
  const entries = [goalEntry(savedGoalState()), compactionEntry()];
  const harness = createHarness();
  harness.api.appendEntry = () => { throw new Error("session storage unavailable"); };
  const { ctx, notifications } = createContext({ entries });

  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(notifications.length, 0);
});

test("the main entry still exports the extension and display helper", async () => {
  const entry = await import("../Killeros.ts");
  assert.equal(typeof entry.default, "function");
  assert.equal(typeof entry.contextPercentRemaining, "function");
});
