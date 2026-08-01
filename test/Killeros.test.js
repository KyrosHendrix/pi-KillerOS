import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Killeros, { formatContextProgress, INIT_WORKFLOW_PROMPT } from "../Killeros.ts";
import { formatThreadBoard, formatThreadState } from "../subagent-ui.ts";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

function usage(cost) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

test("child state presents completion, interruption, and process failure accurately", () => {
  assert.deepEqual(formatThreadState({ status: "limited", terminationReason: "completed" }), {
    status: "complete",
    label: "Complete",
  });
  assert.deepEqual(formatThreadState({ status: "limited", terminationReason: "interrupt" }), {
    status: "cancelled",
    label: "Stopped",
    reason: "Interrupted by user.",
    partialWork: "Stopped before completion. Any saved output is partial work.",
  });
  assert.deepEqual(formatThreadState({ status: "limited", terminationReason: "exit_1", errorMessage: "provider unavailable" }), {
    status: "failed",
    label: "Failed",
    reason: "exit_1: provider unavailable",
    partialWork: "Failed before completion. Any saved output is partial work.",
  });
});

test("child board keeps a completed handoff whole when the completion event wins", () => {
  const board = formatThreadBoard({
    selectedThreadId: "child-1",
    threads: [{
      id: "child-1",
      agent: "scout",
      task: "Map auth",
      status: "limited",
      terminationReason: "completed",
      handoff: "Mapped auth.",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, turns: 1 },
    }],
  });
  assert.equal(board.done[0].state.label, "Complete");
  assert.equal(board.selected?.handoff.isPartial, false);
});

function createHarness() {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const entryRenderers = new Map();
  const appendedEntries = [];
  const sentMessages = [];
  const sentUserMessages = [];
  const api = {
    appendEntry: (customType, data) => appendedEntries.push({ type: "custom", customType, data }),
    getAllTools: () => [...tools.values()].map((tool) => ({
      ...tool,
      sourceInfo: tool.sourceInfo ?? {
        path: `${process.cwd()}/Killeros.ts`,
        source: "npm:killeros",
        baseDir: process.cwd(),
      },
    })),
    getCommands: () => [...commands].map(([name, command]) => ({
      name,
      description: command.description,
      source: "extension",
      sourceInfo: command.sourceInfo ?? {
        path: `${process.cwd()}/Killeros.ts`,
        source: "npm:killeros",
        baseDir: process.cwd(),
      },
    })),
    getThinkingLevel: () => "high",
    on: (event, handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerEntryRenderer: (customType, renderer) => entryRenderers.set(customType, renderer),
    registerTool: (tool) => tools.set(tool.name, tool),
    sendMessage: (message, options) => sentMessages.push({ message, options }),
    sendUserMessage: (message, options) => sentUserMessages.push({ message, options }),
    setThinkingLevel: () => {},
  };
  Killeros(api);
  return { api, appendedEntries, commands, entryRenderers, handlers, sentMessages, sentUserMessages, tools };
}

async function emitSequentially(handlers, event, ctx) {
  const results = [];
  for (const handler of handlers ?? []) {
    const result = await handler(event, ctx);
    results.push(result);
    if (result?.block) break;
  }
  return results;
}

async function emitSuccessfulInitWrite(handlers, ctx, toolCallId = "init-write") {
  const callResults = await emitSequentially(handlers.get("tool_call"), {
    toolCallId,
    toolName: "write",
    input: { path: "AGENTS.md", content: "# AGENTS.md\n" },
  }, ctx);
  assert.equal(callResults.some((result) => result?.block), false);
  await emitSequentially(handlers.get("tool_result"), {
    toolCallId,
    toolName: "write",
    input: { path: "AGENTS.md" },
    content: [{ type: "text", text: "written" }],
    isError: false,
  }, ctx);
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for asynchronous test state");
}

function createFileSymlinkOrSkip(t, target, linkPath) {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      t.skip("file symlinks are unavailable in this environment");
      return false;
    }
    throw error;
  }
}

function createTuiContext(entries = []) {
  const captured = {};
  const tui = { requestRender() {}, terminal: { rows: 40 } };
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 128_000 }),
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode: "tui",
    model: {
      id: "test-model",
      name: "Test model",
      provider: "test",
      reasoning: true,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => path.join(process.cwd(), "session.jsonl"),
    },
    ui: {
      addAutocompleteProvider: (factory) => { captured.autocompleteFactory = factory; },
      confirm: async () => true,
      editor: async (_title, prefill) => prefill,
      notify() {},
      setEditorComponent: (factory) => { captured.editorFactory = factory; },
      setFooter: (factory) => { captured.footerFactory = factory; },
      setHeader: (factory) => { captured.headerFactory = factory; },
      setTheme: (name) => {
        captured.themeName = name;
        return { success: true };
      },
      setHiddenThinkingLabel: (label) => { captured.hiddenThinkingLabel = label; },
      setWorkingIndicator: (options) => { captured.workingIndicator = options; },
      setWorkingMessage: (message) => {
        captured.workingMessages ??= [];
        captured.workingMessages.push(message);
      },
      theme,
    },
    waitForIdle: async () => {},
  };
  return { captured, ctx, tui };
}

async function startQuestion(tool, options = [{ label: "Alpha" }], questionText = "Choose", terminalRows = 40) {
  let component;
  let finish;
  const tui = { requestRender() {}, terminal: { rows: terminalRows } };
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory) => new Promise((resolve) => {
        finish = resolve;
        component = factory(tui, theme, {}, resolve);
      }),
    },
  };
  const result = tool.execute(
    "question-test",
    { question: questionText, options },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.ok(component);
  assert.ok(finish);
  return { component, finish, result };
}

test("uses one neutral background for every tool state", () => {
  const killerosTheme = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8"));
  assert.equal(killerosTheme.colors.toolPendingBg, "surface");
  assert.equal(killerosTheme.colors.toolSuccessBg, "surface");
  assert.equal(killerosTheme.colors.toolErrorBg, "surface");
});

test("uses achromatic neutrals without changing the coral accent", () => {
  const killerosTheme = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8"));
  assert.equal(killerosTheme.vars.coral, "#d77757");
  assert.equal(killerosTheme.vars.coralBright, "#e58b6d");

  for (const name of ["canvas", "surface", "surfaceRaised", "line", "lineMuted", "text", "muted", "dim"]) {
    const [, red, green, blue] = /^#(..)(..)(..)$/.exec(killerosTheme.vars[name]);
    assert.equal(red, green, `${name} must not have a color cast`);
    assert.equal(green, blue, `${name} must not have a color cast`);
  }
});

test("registers /exit without conflicting with Pi's /quit", async () => {
  const { commands } = createHarness();
  assert.equal(commands.has("exit"), true);
  assert.equal(commands.has("quit"), false);

  let shutdownCalled = false;
  await commands.get("exit").handler("", { shutdown: async () => { shutdownCalled = true; } });
  assert.equal(shutdownCalled, true);
});

test("registers /goal and completes only through the model goal tool", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  assert.equal(commands.has("goal"), true);
  assert.equal(tools.has("killeros_goal_update"), true);

  await commands.get("goal").handler("Ship only after every release check passes", ctx);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message.customType, "killeros-goal-continuation");
  assert.match(sentMessages[0].message.content, /Ship only after every release check passes/u);
  assert.match(sentMessages[0].message.content, /killeros_goal_update/u);
  assert.match(sentMessages[0].message.content, /Concise output rules/u);
  assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(appendedEntries.at(-1).customType, "killeros-goal");
  assert.equal(appendedEntries.at(-1).data.state.status, "active");

  let systemPrompt = "base";
  for (const handler of handlers.get("before_agent_start")) {
    const result = await handler({ prompt: "", systemPrompt, systemPromptOptions: {} }, ctx);
    if (result?.systemPrompt) systemPrompt = result.systemPrompt;
  }
  assert.match(systemPrompt, /Active KillerOS goal/u);
  assert.match(systemPrompt, /Ship only after every release check passes/u);
  assert.match(systemPrompt, /killeros_goal_update/u);

  const update = await tools.get("killeros_goal_update").execute(
    "goal-complete",
    { status: "complete", evidence: "npm test and npm run check passed" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.match(update.content[0].text, /marked complete/u);
  assert.equal(appendedEntries.at(-1).data.state.status, "complete");

  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 1, "completed goals must not continue");

  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal complete/u);
  assert.match(notifications.at(-1).message, /npm test and npm run check passed/u);
});

test("/goal continues one turn at a time and pause stops future turns", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Finish the migration", ctx);
  assert.equal(sentMessages.length, 1);

  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].message.content, /Finish the migration/u);

  await commands.get("goal").handler("pause", ctx);
  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 2, "a paused goal must not enqueue another continuation");
});

test("/goal pauses when a scheduled continuation fails before the agent starts", async () => {
  const { appendedEntries, commands, handlers } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Start reliably", ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  const lastGoalEntry = appendedEntries.filter((entry) => entry.customType === "killeros-goal").at(-1);
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.match(lastGoalEntry.data.state.result, /without an agent result/u);
});

test("/goal pauses after an aborted or failed goal turn", async () => {
  const { appendedEntries, commands, handlers } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Recover the deployment", ctx);
  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  const lastGoalEntry = appendedEntries.filter((entry) => entry.customType === "killeros-goal").at(-1);
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.match(lastGoalEntry.data.state.result, /provider unavailable/u);
});

test("/goal edit, pause, resume, and clear persist explicit transitions", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Original objective", ctx);
  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }

  await commands.get("goal").handler("pause", ctx);
  assert.equal(appendedEntries.at(-1).data.state.status, "paused");

  await commands.get("goal").handler("resume", ctx);
  assert.equal(appendedEntries.at(-1).data.state.status, "active");
  assert.equal(sentMessages.length, 2);

  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
  ctx.ui.editor = async () => "Edited objective";
  await commands.get("goal").handler("edit", ctx);
  const editEntry = appendedEntries.filter((entry) => entry.data.event === "edit").at(-1);
  assert.equal(editEntry.data.state.objective, "Edited objective");
  assert.equal(appendedEntries.at(-1).data.state.status, "active");

  await commands.get("goal").handler("clear", ctx);
  assert.equal(appendedEntries.at(-1).data.event, "clear");
  assert.equal(appendedEntries.at(-1).data.state, null);
});

test("/goal pause and clear stop continuation when their first session write fails", async () => {
  for (const control of ["pause", "clear"]) {
    const { api, appendedEntries, commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    const notifications = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await commands.get("goal").handler(`Safely ${control} this goal`, ctx);
    assert.equal(sentMessages.length, 1);

    const appendEntry = api.appendEntry;
    let failed = false;
    api.appendEntry = (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("transient session write failure");
      }
      return appendEntry(...args);
    };

    await commands.get("goal").handler(control, ctx);
    const lastGoalEntry = appendedEntries.filter((entry) => entry.customType === "killeros-goal").at(-1);
    assert.equal(lastGoalEntry.data.state.status, "paused");
    assert.match(lastGoalEntry.data.state.result, new RegExp(`requested ${control} could not be saved`, "u"));
    assert.match(notifications.at(-1).message, /Automatic continuation is stopped/u);

    await emitSequentially(handlers.get("agent_end"), {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    assert.equal(sentMessages.length, 1, `${control} failure must not schedule another continuation`);
  }
});

test("/goal pause can save an in-memory fallback after persistence recovers", async () => {
  const { api, appendedEntries, commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await commands.get("goal").handler("Pause even if storage fails", ctx);

  const appendEntry = api.appendEntry;
  api.appendEntry = () => { throw new Error("persistent session write failure"); };
  await commands.get("goal").handler("pause", ctx);
  assert.match(notifications.at(-1).message, /Automatic continuation is stopped/u);

  api.appendEntry = appendEntry;
  await commands.get("goal").handler("pause", ctx);
  const lastGoalEntry = appendedEntries.filter((entry) => entry.customType === "killeros-goal").at(-1);
  assert.equal(lastGoalEntry.data.event, "pause");
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.match(notifications.at(-1).message, /Goal pause saved/u);

  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 1);
});

test("an active goal blocks /init before repository work starts", async () => {
  const { commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await commands.get("goal").handler("Finish this first", ctx);
  await commands.get("init").handler("", ctx);
  assert.equal(sentMessages.length, 1);
  assert.match(notifications.at(-1).message, /Pause or clear the active goal/u);
});

test("/goal restores only the current branch and resumes active saved work", async () => {
  const now = Date.now();
  const activeState = {
    version: 1,
    revision: 3,
    objective: "Finish the saved task",
    status: "active",
    createdAt: now - 60_000,
    updatedAt: now - 10_000,
    activeMilliseconds: 20_000,
    activeStartedAt: now - 10_000,
    turns: 2,
    baselineTokens: 0,
  };
  const branchEntries = [{
    type: "custom",
    customType: "killeros-goal",
    data: { version: 1, event: "turn", state: activeState },
  }];
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext(branchEntries);
  for (const handler of handlers.get("session_start")) await handler({ reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.length, 1);

  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal active/u);
  assert.match(notifications.at(-1).message, /Finish the saved task/u);
});

test("/goal validates objectives, reserves control words, and gates blocked status", async () => {
  const { appendedEntries, commands, handlers, tools } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  await commands.get("goal").handler("x".repeat(4_001), ctx);
  assert.match(notifications.at(-1).message, /4,000 characters/u);
  await commands.get("goal").handler("CLEAR", ctx);
  assert.match(notifications.at(-1).message, /No goal is set/u);

  await commands.get("goal").handler("Resolve the blocker", ctx);
  await assert.rejects(
    tools.get("killeros_goal_update").execute(
      "goal-blocked",
      { status: "blocked", evidence: "Credentials are unavailable" },
      new AbortController().signal,
      () => {},
      ctx,
    ),
    /three goal turns/u,
  );

  for (let turn = 0; turn < 2; turn += 1) {
    await emitSequentially(handlers.get("agent_end"), {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  }
  assert.equal(appendedEntries.at(-1).data.state.turns, 3);
  await tools.get("killeros_goal_update").execute(
    "goal-blocked-after-audit",
    { status: "blocked", evidence: "The same missing credential blocked three consecutive attempts" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(appendedEntries.at(-1).data.state.status, "blocked");

  await commands.get("goal").handler("resume", ctx);
  await assert.rejects(
    tools.get("killeros_goal_update").execute(
      "goal-blocked-too-soon-after-resume",
      { status: "blocked", evidence: "The blocker appeared again" },
      new AbortController().signal,
      () => {},
      ctx,
    ),
    /current audit/u,
  );
});

test("/goal fails closed when the current branch cannot be read", async () => {
  const now = Date.now();
  const staleEntries = [{
    type: "custom",
    customType: "killeros-goal",
    data: {
      version: 1,
      event: "turn",
      state: {
        version: 1,
        revision: 1,
        objective: "Goal from another branch",
        status: "active",
        createdAt: now,
        updatedAt: now,
        activeMilliseconds: 0,
        activeStartedAt: now,
        turns: 1,
        baselineTokens: 0,
      },
    },
  }];
  const { handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext(staleEntries);
  ctx.sessionManager.getBranch = () => { throw new Error("branch unavailable"); };
  for (const handler of handlers.get("session_start")) await handler({ reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.length, 0);
});

test("saved goals stay inactive in print and JSON modes", async () => {
  const now = Date.now();
  const entries = [{
    type: "custom",
    customType: "killeros-goal",
    data: {
      version: 1,
      event: "turn",
      state: {
        version: 1,
        revision: 1,
        objective: "Do not auto-run here",
        status: "active",
        createdAt: now,
        updatedAt: now,
        activeMilliseconds: 0,
        activeStartedAt: now,
        turns: 1,
        baselineTokens: 0,
      },
    },
  }];
  for (const mode of ["print", "json"]) {
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext(entries);
    ctx.mode = mode;
    const notifications = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({ reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentMessages.length, 0);

    let systemPrompt = "base";
    for (const handler of handlers.get("before_agent_start")) {
      const result = await handler({ prompt: "", systemPrompt, systemPromptOptions: {} }, ctx);
      if (result?.systemPrompt) systemPrompt = result.systemPrompt;
    }
    assert.doesNotMatch(systemPrompt, /Active KillerOS goal/u);
    await commands.get("goal").handler("", ctx);
    assert.match(notifications.at(-1).message, /requires TUI or RPC mode/u);
  }
});

test("/goal edit resumes after invalid input and pauses after persistence failure", async () => {
  const { api, appendedEntries, commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await commands.get("goal").handler("Keep the original objective", ctx);
  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }

  ctx.ui.editor = async () => "";
  await commands.get("goal").handler("edit", ctx);
  assert.equal(sentMessages.length, 2, "invalid edits must not strand an active goal");

  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
  ctx.ui.editor = async () => "Changed objective";
  api.appendEntry = () => { throw new Error("session write failed"); };
  await commands.get("goal").handler("edit", ctx);
  assert.equal(sentMessages.length, 2, "an unsaved continuation must not start");
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal paused/u);
  assert.match(notifications.at(-1).message, /session write failed/u);
  assert.equal(appendedEntries.at(-1).data.state.objective, "Keep the original objective");
});

test("goal state appears in wide and compact footer cutdowns", async () => {
  const { commands, handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
  await commands.get("goal").handler("Keep working", ctx);

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });
  assert.match(footer.render(160)[0], /✻ goal · \d+s/u);
  assert.match(footer.render(40)[0], /goal/u);
  for (let width = 1; width <= 180; width += 1) {
    const line = footer.render(width)[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
    assert.equal([...line].length, width, `goal footer width mismatch at ${width}`);
  }
  footer.dispose();
});

test("registers /init as a native command and runs the hidden generation workflow", async () => {
  const { commands, handlers, sentMessages, sentUserMessages, tools } = createHarness();
  assert.equal(commands.has("init"), true);
  assert.equal(tools.has("init"), false);
  assert.equal(tools.has("init_survey"), false);

  const notifications = [];
  let reloadCalls = 0;
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    mode: "tui",
    reload: async () => { reloadCalls += 1; },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  };
  const initRun = commands.get("init").handler("", ctx);
  await waitFor(() => sentMessages.length === 1);

  assert.equal(sentMessages.length, 1);
  assert.deepEqual(sentMessages[0].options, { triggerTurn: true });
  assert.equal(sentMessages[0].message.customType, "killeros-init");
  assert.equal(sentMessages[0].message.display, false);
  assert.ok(sentMessages[0].message.content.startsWith(INIT_WORKFLOW_PROMPT));
  assert.match(sentMessages[0].message.content, /Initial repository snapshot/u);
  assert.match(INIT_WORKFLOW_PROMPT, /## Analyze[\s\S]*## Synthesize[\s\S]*## Generate/u);
  assert.match(INIT_WORKFLOW_PROMPT, /ask no questions/u);
  assert.match(INIT_WORKFLOW_PROMPT, /write tool exactly once/u);
  assert.doesNotMatch(INIT_WORKFLOW_PROMPT, /preserve|targeted edit|init_survey|\.agents\/skills|killeros-hooks\.json/iu);

  await commands.get("init").handler("", ctx);
  assert.equal(sentMessages.length, 1);
  assert.deepEqual(notifications.at(-1), { message: "/init is already running", level: "warning" });

  await emitSuccessfulInitWrite(handlers, ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  await initRun;
  assert.equal(reloadCalls, 1);
  assert.deepEqual(sentUserMessages, []);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  assert.equal(reloadCalls, 1);
});

test("/init reports failure instead of reloading when the model does not write", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-no-write-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const notifications = [];
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;

    assert.equal(reloadCalls, 0);
    assert.deepEqual(notifications.at(-1), {
      message: "/init did not generate AGENTS.md: the model completed without a successful write",
      level: "error",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init replaces an existing AGENTS.md once and blocks every other mutation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-existing-"));
  try {
    writeFileSync(path.join(directory, "AGENTS.md"), "# AGENTS.md\n\nPreserve this workflow.\n");
    const { commands, handlers, sentMessages } = createHarness();
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    const readOnly = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "inspect-source",
      toolName: "read",
      input: { path: "src/index.ts" },
    }, ctx);
    assert.equal(readOnly.some((result) => result?.block), false);

    const replacement = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "replace-existing",
      toolName: "write",
      input: { path: "AGENTS.md", content: "# AGENTS.md\n\nGenerated.\n" },
    }, ctx);
    assert.equal(replacement.some((result) => result?.block), false);
    await emitSequentially(handlers.get("tool_result"), {
      toolCallId: "replace-existing",
      toolName: "write",
      input: { path: "AGENTS.md" },
      content: [{ type: "text", text: "written" }],
      isError: false,
    }, ctx);

    const secondWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "replace-again",
      toolName: "write",
      input: { path: "AGENTS.md", content: "replacement" },
    }, ctx);
    assert.match(secondWrite.find((result) => result?.block)?.reason, /exactly once/u);

    const editTarget = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "edit-existing",
      toolName: "edit",
      input: { path: "AGENTS.md", edits: [{ oldText: "Generated", newText: "Changed" }] },
    }, ctx);
    assert.match(editTarget.find((result) => result?.block)?.reason, /exactly once/u);

    const otherFile = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "write-other",
      toolName: "write",
      input: { path: "README.md", content: "replacement" },
    }, ctx);
    assert.match(otherFile.find((result) => result?.block)?.reason, /may not modify any other file/u);

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init blocks a linked AGENTS.md target", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-target-"));
  try {
    writeFileSync(path.join(directory, "shared.md"), "shared instructions\n");
    if (!createFileSymlinkOrSkip(t, "shared.md", path.join(directory, "AGENTS.md"))) return;

    const { commands, handlers, sentMessages } = createHarness();
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    const writeAttempt = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "linked-agents",
      toolName: "write",
      input: { path: "AGENTS.md", content: "replacement" },
    }, ctx);
    assert.match(writeAttempt.find((result) => result?.block)?.reason, /regular, non-linked file/u);
    assert.equal(readFileSync(path.join(directory, "shared.md"), "utf8"), "shared instructions\n");

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init retries its single AGENTS.md write only after a failed write", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-new-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    const firstWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "create-agents",
      toolName: "write",
      input: { path: "AGENTS.md", content: "# AGENTS.md" },
    }, ctx);
    assert.equal(firstWrite.some((result) => result?.block), false);
    await emitSequentially(handlers.get("tool_result"), {
      toolCallId: "create-agents",
      toolName: "write",
      input: { path: "AGENTS.md" },
      content: [{ type: "text", text: "disk error" }],
      isError: true,
    }, ctx);

    const retryWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "retry-agents",
      toolName: "write",
      input: { path: "AGENTS.md", content: "# AGENTS.md" },
    }, ctx);
    assert.equal(retryWrite.some((result) => result?.block), false);
    await emitSequentially(handlers.get("tool_result"), {
      toolCallId: "retry-agents",
      toolName: "write",
      input: { path: "AGENTS.md" },
      content: [{ type: "text", text: "created" }],
      isError: false,
    }, ctx);

    const thirdWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "third-agents",
      toolName: "write",
      input: { path: "AGENTS.md", content: "replacement" },
    }, ctx);
    assert.equal(thirdWrite.find((result) => result?.block)?.block, true);

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init recovers when its agent workflow cannot start", async () => {
  const { api, commands, handlers, sentMessages } = createHarness();
  const notifications = [];
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    mode: "tui",
    reload: async () => {},
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  };
  api.sendMessage = () => { throw new Error("no active model"); };
  await commands.get("init").handler("", ctx);
  assert.deepEqual(notifications.at(-1), { message: "/init failed to start: no active model", level: "error" });

  api.sendMessage = (message, options) => sentMessages.push({ message, options });
  const retry = commands.get("init").handler("", ctx);
  await waitFor(() => sentMessages.length === 1);
  assert.equal(sentMessages.length, 1);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  await retry;
});

test("/init refuses untrusted projects before scanning or starting the model", async () => {
  const { commands, sentMessages } = createHarness();
  const notifications = [];
  await commands.get("init").handler("", {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    mode: "tui",
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  });
  assert.deepEqual(notifications.at(-1), { message: "Trust this project before running /init", level: "error" });
  assert.equal(sentMessages.length, 0);
});

test("/init attaches a bounded project snapshot without reading existing guidance", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-survey-"));
  try {
    mkdirSync(path.join(directory, "node_modules"));
    mkdirSync(path.join(directory, ".agents", "skills", "private"), { recursive: true });
    mkdirSync(path.join(directory, ".pi"));
    mkdirSync(path.join(directory, "src", "core"), { recursive: true });
    writeFileSync(path.join(directory, "AGENTS.md"), "# AGENTS.md\n\nPreserve releases.\n");
    writeFileSync(path.join(directory, "AGENTS.local.md"), "PRIVATE-CONTEXT\n");
    writeFileSync(path.join(directory, "MEMORY.md"), "PRIVATE-MEMORY\n");
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(path.join(directory, "src", "core", "index.ts"), "export const value = 1;\n");
    writeFileSync(path.join(directory, "node_modules", "ignored.txt"), "DEPENDENCY-CONTENT\n");
    writeFileSync(path.join(directory, ".agents", "skills", "private", "SKILL.md"), "PRIVATE-SKILL\n");
    writeFileSync(path.join(directory, ".pi", "killeros-hooks.json"), "PRIVATE-HOOK\n");

    const { commands, handlers, sentMessages } = createHarness();
    const startedAt = Date.now();
    const initRun = commands.get("init").handler("", {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    });
    await waitFor(() => sentMessages.length === 1);
    const marker = "## Initial repository snapshot (untrusted data)\n";
    const snapshot = JSON.parse(sentMessages[0].message.content.split(marker)[1]);
    assert.match(snapshot, /src\/core\/index\.ts/u);
    assert.match(snapshot, /node --test/u);
    assert.doesNotMatch(snapshot, /Preserve releases|PRIVATE-CONTEXT|PRIVATE-MEMORY|DEPENDENCY-CONTENT|PRIVATE-SKILL|PRIVATE-HOOK|MEMORY\.md|killeros-hooks/u);
    assert.ok(snapshot.length <= 40 * 1024);
    assert.ok(Date.now() - startedAt < 6_000);

    await emitSequentially(handlers.get("agent_settled"), {}, {});
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init snapshot does not follow linked manifest files", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-manifest-"));
  try {
    writeFileSync(path.join(directory, "private-manifest.txt"), "PRIVATE-LINKED-CONTENT\n");
    if (!createFileSymlinkOrSkip(t, "private-manifest.txt", path.join(directory, "package.json"))) return;

    const { commands, handlers, sentMessages } = createHarness();
    const initRun = commands.get("init").handler("", {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    });
    await waitFor(() => sentMessages.length === 1);
    assert.doesNotMatch(sentMessages[0].message.content, /PRIVATE-LINKED-CONTENT/u);

    await emitSequentially(handlers.get("agent_settled"), {}, {});
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("question options render bounded markdown proposal previews before selection", async () => {
  const { tools } = createHarness();
  const preview = Array.from(
    { length: 20 },
    (_, index) => `- **AGENTS.md** — run \`check-${index + 1}\``,
  ).join("\n");
  const question = await startQuestion(tools.get("question"), [{
    label: "Looks good",
    description: "Apply the proposal",
    preview,
  }], "Choose", 14);
  const renderedLines = question.component.render(80);
  const rendered = renderedLines.join("\n");
  assert.match(rendered, /Proposal preview/u);
  assert.match(rendered, /AGENTS\.md/u);
  assert.match(rendered, /more lines/u);
  assert.doesNotMatch(rendered, /\*\*|`/u);
  assert.ok(renderedLines.length <= 14);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("does not inject AGENTS.local.md into the /init generation turn", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-personal-"));
  try {
    writeFileSync(path.join(directory, "AGENTS.local.md"), "PRIVATE-INIT-GUIDANCE\n");
    const { commands, handlers, sentMessages } = createHarness();
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    let event = { systemPrompt: "shared AGENTS context" };
    for (const handler of handlers.get("before_agent_start")) {
      const update = await handler(event, ctx);
      if (update?.systemPrompt) event = { ...event, systemPrompt: update.systemPrompt };
    }
    assert.doesNotMatch(event.systemPrompt, /PRIVATE-INIT-GUIDANCE|personal_instructions/u);

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("injects trusted AGENTS.local.md imports after shared context", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-personal-"));
  try {
    writeFileSync(path.join(directory, "personal.md"), "Prefer concise tradeoff explanations.\n");
    writeFileSync(path.join(directory, "AGENTS.local.md"), "@personal.md\n");
    const { handlers } = createHarness();
    let event = { systemPrompt: "shared AGENTS context" };
    const ctx = { cwd: directory, isProjectTrusted: () => true };
    for (const handler of handlers.get("before_agent_start")) {
      const update = await handler(event, ctx);
      if (update?.systemPrompt) event = { ...event, systemPrompt: update.systemPrompt };
    }
    assert.match(event.systemPrompt, /shared AGENTS context/u);
    assert.match(event.systemPrompt, /<personal_instructions/u);
    assert.match(event.systemPrompt, /Prefer concise tradeoff explanations\./u);
    assert.ok(event.systemPrompt.indexOf("shared AGENTS context") < event.systemPrompt.indexOf("<personal_instructions"));

    event = { systemPrompt: "shared" };
    for (const handler of handlers.get("before_agent_start")) {
      const update = await handler(event, { cwd: directory, isProjectTrusted: () => false });
      if (update?.systemPrompt) event = { ...event, systemPrompt: update.systemPrompt };
    }
    assert.doesNotMatch(event.systemPrompt, /personal_instructions/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not load lifecycle hooks for untrusted projects", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-untrusted-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ command: `"${process.execPath}" -e "process.exit(7)"` }] },
    }));

    const { handlers } = createHarness();
    const notifications = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.isProjectTrusted = () => false;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({}, ctx);

    const results = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "untrusted-hook",
      toolName: "write",
      input: { path: "example.txt", content: "test" },
    }, ctx);
    assert.equal(results.some((result) => result?.block), false);
    assert.match(notifications.at(-1)?.message, /Ignored untrusted project hooks/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project tool_call hooks can deterministically block a tool", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "process.stderr.write('blocked');process.exit(7)"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command, timeoutMs: 5_000 }] },
    }));

    const { handlers } = createHarness();
    const notifications = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({}, ctx);

    const results = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "hook-test",
      toolName: "write",
      input: { path: "example.txt", content: "test" },
    }, ctx);
    const blocked = results.find((result) => result?.block);
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason, /blocked/u);
    assert.equal(notifications.at(-1).level, "error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init reloads only after existing agent-settled hooks complete", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-settled-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('hook.done','done')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { agent_settled: [{ command, timeoutMs: 5_000 }] },
    }));

    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.waitForIdle = async () => {};
    let reloadCalls = 0;
    ctx.reload = async () => {
      assert.equal(readFileSync(path.join(directory, "hook.done"), "utf8"), "done");
      reloadCalls += 1;
    };
    for (const handler of handlers.get("session_start")) await handler({}, ctx);

    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSuccessfulInitWrite(handlers, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
    assert.equal(reloadCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("question filtering decodes Kitty input, paste, and grapheme backspace", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"));

  question.component.handleInput("\x1B[97u");
  assert.match(question.component.render(80).join("\n"), /Filter: a/);

  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B[200~a\nb\tc\x1B[201~");
  assert.match(question.component.render(80).join("\n"), /Filter: ab {4}c/);

  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B[200~👨‍👩‍👧‍👦\x1B[201~");
  assert.match(question.component.render(80).join("\n"), /Filter: 👨‍👩‍👧‍👦/);
  question.component.handleInput("\x7F");
  assert.doesNotMatch(question.component.render(80).join("\n"), /Filter:/);

  question.component.handleInput("\x1B[155u");
  assert.doesNotMatch(question.component.render(80).join("\n"), /Filter:/);

  question.component.handleInput("\x1B[200~1\x1B[201~");
  assert.match(question.component.render(80).join("\n"), /Filter: 1/);

  question.finish({ kind: "cancelled" });
  await question.result;
});

test("custom-answer history does not replace a multiline draft on Up", async () => {
  const { tools } = createHarness();
  const tool = tools.get("question");
  const first = await startQuestion(tool);
  first.component.handleInput("2");
  first.component.handleInput("old answer");
  first.component.handleInput("\r");
  await first.result;

  const second = await startQuestion(tool);
  second.component.handleInput("2");
  second.component.handleInput("first line");
  second.component.handleInput("\x1B[13;2u");
  second.component.handleInput("second line");
  second.component.handleInput("\x1B[A");
  const rendered = second.component.render(80).join("\n");
  assert.match(rendered, /first line/);
  assert.match(rendered, /second line/);
  assert.doesNotMatch(rendered, /old answer/);

  second.finish({ kind: "cancelled" });
  await second.result;
});

test("context telemetry uses plain language without a progress bar", () => {
  assert.equal(formatContextProgress(50_000, 1_050_000, theme), "95% left (1M)");
  assert.equal(formatContextProgress(860_000, 1_000_000, theme), "14% left (140k) · /compact");
  assert.equal(formatContextProgress(null, 1_000_000, theme), "—% left (—)");
  assert.doesNotMatch(formatContextProgress(50_000, 1_050_000, theme), /[█░]/u);
});

test("footer includes assistant, tool, compaction, and branch-summary costs", () => {
  const { handlers } = createHarness();
  const entries = [
    { type: "message", message: { role: "assistant", usage: usage(1) } },
    { type: "message", message: { role: "toolResult", usage: usage(2) } },
    { type: "compaction", usage: usage(3) },
    { type: "branch_summary", usage: usage(4) },
  ];
  const { captured, ctx, tui } = createTuiContext(entries);
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  assert.match(footer.render(160).join("\n"), /\$10\.00/);
  footer.dispose();
});

test("footer cuts down by priority while preserving model and context", () => {
  const { handlers } = createHarness();
  const entries = [{ type: "message", message: { role: "assistant", usage: usage(10) } }];
  const { captured, ctx, tui } = createTuiContext(entries);
  ctx.model = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 1_050_000,
  };
  ctx.getContextUsage = () => ({ tokens: 50_000, contextWindow: 1_050_000 });
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });

  const wide = footer.render(160)[0];
  assert.match(wide, /GPT-5\.6 Sol OpenAI · high · 95% left \(1M\) · main · \d+s · \$10\.00/u);
  const normalizedHome = (process.env.HOME || process.env.USERPROFILE || os.homedir()).replace(/[\\/]+$/u, "");
  const normalizedCwd = process.cwd().replace(/[\\/]+$/u, "");
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  const displayedCwd = normalizedCwd === normalizedHome
    ? "~"
    : normalizedCwd.startsWith(normalizedHome) && /^[\\/]/u.test(separator)
      ? `~${normalizedCwd.slice(normalizedHome.length)}`
      : process.cwd();
  assert.ok(wide.includes(displayedCwd));

  const focused = footer.render(72)[0];
  assert.match(focused, /GPT-5\.6 Sol OpenAI · 95% left \(1M\)/u);
  assert.match(focused, /…\/pi-KillerOS/u);
  assert.doesNotMatch(focused, /· high|· main|\$10\.00/u);

  const compact = footer.render(40)[0];
  assert.match(compact, /GPT-5\.6 Sol OpenAI · 95% left \(1M\)/u);
  assert.doesNotMatch(compact, /pi-KillerOS/u);

  const emergency = footer.render(35)[0];
  assert.match(emergency, /GPT-5\.6 Sol/u);
  assert.match(emergency, /95% left \(1M\)/u);
  assert.doesNotMatch(emergency, /OpenAI/u);

  for (let width = 1; width <= 180; width += 1) {
    const line = footer.render(width)[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
    assert.equal([...line].length, width, `footer width mismatch at ${width}`);
  }
  footer.dispose();
});

test("footer uses model metadata and formats unknown provider names", () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  ctx.model = {
    id: "raw-model-v1",
    name: "Professional Model",
    provider: "my-private-ai",
    reasoning: true,
  };
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  const semanticTheme = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim" ? `\x1B[90m${text}\x1B[39m` : text,
  };
  const footer = captured.footerFactory(tui, semanticTheme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  const firstRender = footer.render(120)[0];
  assert.match(firstRender, /\x1B\[37m\x1B\[1mProfessional Model\x1B\[22m\x1B\[39m/u);
  assert.match(firstRender, /\x1B\[90mMy Private AI\x1B\[39m/u);

  for (const handler of handlers.get("model_select")) {
    handler({ model: { ...ctx.model, id: "next", name: "Next Model", provider: "future_provider" } });
  }
  const updated = footer.render(120)[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(updated, /Next Model Future Provider/u);

  for (const handler of handlers.get("model_select")) {
    handler({ model: { ...ctx.model, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" } });
  }
  const deepSeek = footer.render(120)[0].replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(deepSeek, /DeepSeek V4 Flash DeepSeek/u);
  footer.dispose();
});

test("autocomplete omits unsupported argument hints", async () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  const current = {
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    getSuggestions: async () => ({ prefix: "/", items: [] }),
    shouldTriggerFileCompletion: () => true,
  };
  const provider = captured.autocompleteFactory(current);
  const result = await provider.getSuggestions(["/"], 0, 1, {});
  for (const command of ["logout", "fork", "clone", "resume"]) {
    const item = result.items.find((candidate) => candidate.label === `/${command}`);
    assert.ok(item, `missing /${command}`);
    assert.doesNotMatch(item.description, new RegExp(`/${command} \\[`));
  }
  assert.ok(result.items.some((item) => item.label === "/exit"));
});

test("activity treatment uses the Spark and cycles Claude-adjacent words", () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  assert.deepEqual(captured.workingIndicator, {
    frames: ["✻", "✻", "✻", "✻"],
    intervalMs: 180,
  });
  assert.equal(captured.hiddenThinkingLabel, "└ Thinking…");

  for (let index = 0; index < 7; index += 1) {
    for (const handler of handlers.get("agent_start")) handler({}, ctx);
  }
  assert.deepEqual(captured.workingMessages, [
    "Brewing…",
    "Pondering…",
    "Tinkering…",
    "Wrangling…",
    "Noodling…",
    "Cooking…",
    "Brewing…",
  ]);

  for (const handler of handlers.get("agent_end")) handler({}, ctx);
  assert.equal(captured.workingMessages.at(-1), undefined);
});

test("header renders the compact KillerOS card", () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  ctx.ui.theme = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim" ? `\x1B[90m${text}\x1B[39m` : text,
  };
  for (const handler of handlers.get("session_start")) handler({}, ctx);
  assert.equal(captured.themeName, "killeros");

  const header = captured.headerFactory(tui);
  const strip = (line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  const rendered = header.render(120);
  const wide = rendered.map(strip);
  assert.equal(wide.length, 9);
  assert.match(wide[1], new RegExp(`› KillerOS \\(v${PACKAGE_VERSION.replaceAll(".", "\\.")}\\)`));
  assert.match(wide[3], /Test model Test · high \/model/);
  assert.match(wide[4], /pi-KillerOS(?: · \S+)?/);
  assert.doesNotMatch(wide.join("\n"), /context/);
  assert.match(wide[5], /^╰─+╯$/);
  assert.equal(wide[6].trim(), "");
  assert.match(wide[7].trim(), /^Tip: /);
  assert.match(rendered[1], /\x1B\[90m›\x1B\[39m \x1B\[37m\x1B\[1mKillerOS\x1B\[22m\x1B\[39m/u);
  assert.match(rendered[3], /\x1B\[37m\x1B\[1mTest model\x1B\[22m\x1B\[39m \x1B\[90mTest\x1B\[39m/u);
  assert.ok(rendered.some((line) => line.includes("\x1B[38;2;120;169;255m/model")));
  assert.doesNotMatch(wide.join("\n"), /READY|MCP adapter|Web access/);
  assert.doesNotMatch(wide.join("\n"), /KILLEROS/);
  assert.ok(wide.every((line) => [...line].length === 52));
  for (let width = 1; width <= 100; width += 1) {
    const lines = header.render(width).map(strip);
    assert.ok(lines.every((line) => [...line].length <= width), `header overflowed at width ${width}`);
    if (width >= 28) {
      assert.ok(lines.every((line) => [...line].length === Math.min(width, 52)), `header was ragged at width ${width}`);
    }
  }
  assert.deepEqual(header.render(4).map(strip), ["Kill"]);
  assert.deepEqual(header.render(0), []);
  header.dispose();
});

test("startup tips stay fixed within a session and cycle before repeating", () => {
  const { handlers } = createHarness();
  const sessionStart = handlers.get("session_start")[0];
  const sessionShutdown = handlers.get("session_shutdown")[0];
  const tips = [];
  const strip = (line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").trim();

  for (let index = 0; index < 3; index += 1) {
    const { captured, ctx, tui } = createTuiContext();
    sessionStart({}, ctx);
    const first = captured.headerFactory(tui).render(76).map(strip).find((line) => line.startsWith("Tip:"));
    const second = captured.headerFactory(tui).render(76).map(strip).find((line) => line.startsWith("Tip:"));
    assert.equal(first, second);
    tips.push(first);
    sessionShutdown();
  }

  assert.equal(new Set(tips).size, 3);
});
