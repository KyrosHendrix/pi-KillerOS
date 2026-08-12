import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import Killeros from "../Killeros.ts";

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function createHarness() {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const appendedEntries = [];
  const sentMessages = [];
  const activeTools = [];
  const sourceInfo = {
    path: `${process.cwd()}/Killeros.ts`,
    source: "npm:killeros",
    baseDir: process.cwd(),
  };
  const api = {
    appendEntry: (customType, data) => appendedEntries.push({ type: "custom", customType, data }),
    getAllTools: () => [...tools.values()].map((tool) => ({ ...tool, sourceInfo: tool.sourceInfo ?? sourceInfo })),
    getCommands: () => [...commands].map(([name, command]) => ({
      name,
      description: command.description,
      source: "extension",
      sourceInfo: command.sourceInfo ?? sourceInfo,
    })),
    getSessionName: () => undefined,
    getThinkingLevel: () => "high",
    on: (event, handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerEntryRenderer: () => {},
    registerTool: (tool) => tools.set(tool.name, tool),
    sendMessage: (message, options) => sentMessages.push({ message, options }),
    sendUserMessage: () => {},
    setThinkingLevel: () => {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => activeTools.splice(0, activeTools.length, ...names),
  };

  Killeros(api, {
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
} = {}) {
  const ctx = {
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
    compact: (options) => compactCalls.push(options),
    getSystemPrompt: () => "",
    shutdown() {},
    ui: {
      addAutocompleteProvider: () => {},
      confirm: async () => true,
      editor: async (_title, prefill) => prefill,
      notify: (message, level) => notifications.push({ message, level }),
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

async function emitSequentially(handlers, event, ctx) {
  const results = [];
  for (const handler of handlers ?? []) results.push(await handler(event, ctx));
  return results;
}

async function startGoalTurn(harness, ctx, objective = "Finish the migration") {
  await harness.commands.get("goal").handler(objective, ctx);
  await emitSequentially(harness.handlers.get("before_agent_start"), {
    type: "before_agent_start",
    prompt: "",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
}

async function abortActiveGoal(harness, ctx) {
  await startGoalTurn(harness, ctx, "Continue after manual compaction");
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
}

function savedGoalState(overrides = {}) {
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

function goalEntry(state, event = "error") {
  return {
    type: "custom",
    id: `goal-${state.revision}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "killeros-goal",
    data: { version: 1, event, state },
  };
}

function compactionEntry(id = "compact-1") {
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

function compactEvent(reason, willRetry = false) {
  return {
    type: "session_compact",
    compactionEntry: compactionEntry(),
    fromExtension: false,
    reason,
    willRetry,
  };
}

test("KillerOS leaves compaction triggering and summary generation to Pi", async () => {
  const harness = createHarness();
  const { compactCalls, ctx, notifications } = createContext({
    usage: { tokens: 100_000, contextWindow: 128_000 },
  });

  assert.equal(harness.handlers.has("session_before_compact"), false);
  await emitSequentially(harness.handlers.get("turn_end"), {
    type: "turn_end", turnIndex: 0, message: {}, toolResults: [],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 0);
  assert.equal(notifications.length, 0);
});

test("contextPercentRemaining remains a public display helper", async () => {
  const { contextPercentRemaining } = await import("../Killeros.ts");
  const makeContext = (tokens, contextWindow = 128_000) => ({
    getContextUsage: () => ({ tokens, contextWindow }),
  });

  assert.equal(contextPercentRemaining(makeContext(89_600)), 30);
  assert.equal(contextPercentRemaining(makeContext(64_000)), 50);
  assert.equal(contextPercentRemaining(makeContext(200_000)), 0);
  assert.equal(contextPercentRemaining(makeContext(-1)), 100);
  assert.equal(contextPercentRemaining(makeContext(null)), null);
  assert.equal(contextPercentRemaining(makeContext(1, 0)), null);
  assert.equal(contextPercentRemaining({ getContextUsage: () => undefined }), null);
  assert.equal(contextPercentRemaining({ getContextUsage: () => { throw new Error("unavailable"); } }), null);
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

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused");
  assert.match(harness.appendedEntries.at(-1).data.state.result, /overflow recovery failed/u);
  assert.equal(harness.appendedEntries.at(-1).data.state.resumeAfterManualCompaction, undefined);
  assert.equal(harness.sentMessages.length, 1);
});

test("manual compaction resumes only the exact recovery-eligible paused goal", async () => {
  const harness = createHarness();
  const { ctx, notifications } = createContext();
  await abortActiveGoal(harness, ctx);

  const paused = harness.appendedEntries.at(-1).data.state;
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumeAfterManualCompaction, true);
  assert.match(notifications.at(-1)?.message ?? "", /paused.*\/compact|\/compact.*paused/iu);

  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  const resumed = harness.appendedEntries.at(-1).data.state;
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
  assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused");
  assert.equal(harness.sentMessages.length, 1);
});

test("threshold and overflow compaction never consume manual recovery eligibility", async () => {
  for (const reason of ["threshold", "overflow"]) {
    const harness = createHarness();
    const { ctx } = createContext();
    await abortActiveGoal(harness, ctx);
    await emitSequentially(harness.handlers.get("session_compact"), compactEvent(reason, reason === "overflow"), ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused", reason);
    assert.equal(harness.sentMessages.length, 1, reason);
  }
});

test("explicit /goal pause clears pending manual recovery", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  await harness.commands.get("goal").handler("pause", ctx);

  const explicitPause = harness.appendedEntries.at(-1).data.state;
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
  await harness.commands.get("goal").handler("pause", ctx);
  assert.equal(abortCalls, 1);

  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), compactEvent("manual"), ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused");
  assert.equal(harness.appendedEntries.at(-1).data.state.resumeAfterManualCompaction, undefined);
  assert.equal(harness.sentMessages.length, 1);
});

test("editing a marked paused goal clears recovery before reactivation", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  ctx.ui.editor = async () => "Edited objective";
  await harness.commands.get("goal").handler("edit", ctx);

  const edited = harness.appendedEntries.at(-1).data.state;
  assert.equal(edited.objective, "Edited objective");
  assert.equal(edited.status, "active");
  assert.equal(edited.resumeAfterManualCompaction, undefined);
});

test("a terminal goal update cannot be revived by manual compaction", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await startGoalTurn(harness, ctx, "Complete before compaction");
  await harness.tools.get("killeros_goal_update").execute(
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

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "complete");
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

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused");
  assert.equal(harness.appendedEntries.at(-1).data.state.resumeAfterManualCompaction, undefined);
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
  const entries = [];
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
