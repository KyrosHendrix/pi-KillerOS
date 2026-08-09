import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import Killeros, { CONCISE_SYSTEM_PROMPT, executeHook, formatContextProgress, INIT_WORKFLOW_PROMPT, writeInitAgentsFile } from "../Killeros.ts";
import { formatCwd, formatTime, formatTokens } from "../killeros/display.ts";
import { resolvePersonalInstructions } from "../killeros/personal-instructions.ts";
import { resolveGitBranch } from "../killeros/shell-ui.ts";
import { BoundedText } from "../killeros/bounded-text.ts";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
initTheme("dark", false);

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

function createHarness() {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const entryRenderers = new Map();
  const appendedEntries = [];
  const sentMessages = [];
  const sentUserMessages = [];
  const activeTools = [];
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
    getSessionName: () => undefined,
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
  return { api, activeTools, appendedEntries, commands, entryRenderers, handlers, sentMessages, sentUserMessages, tools };
}

test("all KillerOS tools expose provider-compatible object schemas", () => {
  const { tools } = createHarness();

  for (const tool of tools.values()) {
    const schema = JSON.parse(JSON.stringify(tool.parameters));
    assert.equal(schema.type, "object", `${tool.name} must use a top-level object schema`);
    assert.equal(typeof schema.properties, "object", `${tool.name} must declare object properties`);
    assert.equal(schema.anyOf, undefined, `${tool.name} must not use a top-level anyOf`);
    assert.equal(schema.oneOf, undefined, `${tool.name} must not use a top-level oneOf`);
  }
});

test("concise guidance encodes action-oriented behavioral anchors", () => {
  assert.doesNotMatch(CONCISE_SYSTEM_PROMPT, /# Concise output rules/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /Make each response easy to start and easy to follow/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /first line serves the user's immediate need/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /state anchor only when multi-step work spans turns/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /concrete human execution estimate only when requested or supported by evidence/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /After three consecutive turns leave the same issue broken/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /Safety and harness constraints come first/u);
  assert.match(CONCISE_SYSTEM_PROMPT, /ending is either the verified outcome or one action the user must take/u);
});

test("applies the fixed concise preset to Responses API payloads", async () => {
  const { handlers } = createHarness();
  const payload = {
    model: "gpt-5.6",
    input: [],
    text: { format: { type: "text" }, verbosity: "high" },
    reasoning: { effort: "high", summary: "detailed" },
  };

  const [result] = await emitSequentially(handlers.get("before_provider_request"), { payload }, {
    model: { api: "openai-codex-responses", id: "gpt-5.6" },
  });

  assert.deepEqual(result, {
    ...payload,
    text: { format: { type: "text" }, verbosity: "low" },
    reasoning: { effort: "high", summary: "concise" },
  });
});

test("keeps concise provider settings scoped to compatible payload fields", async () => {
  const { handlers } = createHarness();
  const handler = handlers.get("before_provider_request")[0];
  const withoutSettings = { model: "gpt-5.6-luna", input: [] };
  const incompatible = { model: "deepseek-v4-flash", input: [], text: { verbosity: "high" } };

  assert.deepEqual(await handler({ payload: withoutSettings }, {
    model: { api: "openai-responses", id: "gpt-5.6-luna" },
  }), {
    model: "gpt-5.6-luna",
    input: [],
    text: { verbosity: "low" },
  });
  assert.strictEqual(await handler({ payload: incompatible }, {
    model: { api: "openai-completions", id: "deepseek-v4-flash" },
  }), incompatible);
  assert.equal(await handler({ payload: null }, {
    model: { api: "openai-responses", id: "gpt-5.6-luna" },
  }), null);
});

async function emitSequentially(handlers, event, ctx) {
  const results = [];
  for (const handler of handlers ?? []) {
    const result = await handler(event, ctx);
    results.push(result);
    if (result?.block) break;
  }
  return results;
}

async function emitSuccessfulInitWrite(handlers, tools, ctx, content = "# AGENTS.md\n", toolCallId = "init-write") {
  const input = { content };
  const callResults = await emitSequentially(handlers.get("tool_call"), {
    toolCallId,
    toolName: "killeros_init_write",
    input,
  }, ctx);
  assert.equal(callResults.some((result) => result?.block), false);
  await tools.get("killeros_init_write").execute(
    toolCallId,
    input,
    new AbortController().signal,
    () => {},
    ctx,
  );
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for asynchronous test state");
}

async function removeDirectoryEventually(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  rmSync(directory, { recursive: true, force: true });
}

async function emitGoalStart(handlers, ctx) {
  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
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

function createTuiContext(entries = [], uiTheme = theme) {
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
      select: async (title, options) => {
        captured.selection = { title, options };
        return undefined;
      },
      setEditorComponent: (factory) => { captured.editorFactory = factory; },
      setFooter: (factory) => { captured.footerFactory = factory; },
      setHeader: (factory) => { captured.headerFactory = factory; },
      setTitle: (title) => {
        captured.titles ??= [];
        captured.titles.push(title);
      },
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
      theme: uiTheme,
    },
    waitForIdle: async () => {},
  };
  return { captured, ctx, tui };
}

test("BoundedText limits collapsed rows and preserves full expanded text", () => {
  const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const collapsed = new BoundedText(source, 3).render(20);
  assert.equal(collapsed.length, 3);
  assert.match(collapsed.at(-1) ?? "", /…/u);

  const expanded = new BoundedText(source).render(20);
  assert.equal(expanded.length, 20);
  assert.match(expanded.at(-1) ?? "", /line 20/u);
});

async function startQuestion(
  tool,
  options = [{ label: "Alpha" }],
  questionText = "Choose",
  terminalRows = 40,
  keybindings = getKeybindings(),
) {
  let component;
  let finish;
  const notifications = [];
  const tui = { requestRender() {}, terminal: { rows: terminalRows } };
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory) => new Promise((resolve) => {
        finish = resolve;
        component = factory(tui, theme, keybindings, resolve);
      }),
      notify: (message, level) => notifications.push({ message, level }),
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
  return { component, finish, result, notifications, tui };
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

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("reasoning text meets normal-text contrast on KillerOS surfaces", () => {
  const killerosTheme = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8"));
  for (const role of ["thinkingMinimal", "thinkingLow"]) {
    const foreground = killerosTheme.colors[role].startsWith("#")
      ? killerosTheme.colors[role]
      : killerosTheme.vars[killerosTheme.colors[role]];
    for (const background of [killerosTheme.vars.surface, killerosTheme.vars.surfaceRaised]) {
      assert.ok(contrastRatio(foreground, background) >= 4.5, `${role} must reach 4.5:1`);
    }
  }
});

test("shell UI uses theme roles instead of raw ANSI colors", () => {
  const source = readFileSync(new URL("../killeros/shell-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /38;2;|\\x1B\[90m|COMMAND_BLUE_RGB/u);
});

test("registers /exit without conflicting with Pi's /quit", async () => {
  const { commands } = createHarness();
  assert.equal(commands.has("exit"), true);
  assert.equal(commands.has("quit"), false);

  const calls = [];
  await commands.get("exit").handler("", {
    isIdle: () => false,
    abort: () => calls.push("abort"),
    shutdown: () => calls.push("shutdown"),
  });
  assert.deepEqual(calls, ["abort", "shutdown"]);

  calls.length = 0;
  await commands.get("exit").handler("", {
    isIdle: () => true,
    abort: () => calls.push("abort"),
    shutdown: () => calls.push("shutdown"),
  });
  assert.deepEqual(calls, ["shutdown"]);
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
  assert.match(sentMessages[0].message.content, /Action-oriented response guidance/u);
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

  ctx.mode = "rpc";
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal complete/u);
  assert.match(notifications.at(-1).message, /npm test and npm run check passed/u);
});

test("bare /goal opens a context-valid action panel in TUI mode", async () => {
  const { appendedEntries, commands } = createHarness();
  const { captured, ctx } = createTuiContext();
  await commands.get("goal").handler("Ship the release", ctx);
  ctx.ui.select = async (title, options) => {
    captured.goalPanel = { title, options };
    return "Pause automatic continuation";
  };

  await commands.get("goal").handler("", ctx);
  assert.match(captured.goalPanel.title, /Goal active/u);
  assert.match(captured.goalPanel.title, /Ship the release/u);
  assert.deepEqual(captured.goalPanel.options, [
    "Pause automatic continuation",
    "Edit objective",
    "Clear goal",
  ]);
  assert.equal(appendedEntries.at(-1).data.state.status, "paused");
});

test("goal panel confirms clear and leaves direct goal commands compatible", async () => {
  const { appendedEntries, commands } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Keep this goal", ctx);
  ctx.ui.select = async () => "Clear goal";
  ctx.ui.confirm = async () => false;
  await commands.get("goal").handler("", ctx);
  assert.notEqual(appendedEntries.at(-1).data.state, null);

  ctx.ui.confirm = async () => true;
  await commands.get("goal").handler("", ctx);
  assert.equal(appendedEntries.at(-1).data.state, null);

  await commands.get("goal").handler("Direct clear", ctx);
  await commands.get("goal").handler("clear", ctx);
  assert.equal(appendedEntries.at(-1).data.state, null);
});

test("goal panel actions match paused, blocked, and complete states", async () => {
  const expected = {
    paused: ["Resume automatic continuation", "Edit objective", "Clear goal"],
    blocked: ["Resume automatic continuation", "Edit objective", "Clear goal"],
    complete: ["Edit objective", "Clear goal"],
  };
  for (const [status, options] of Object.entries(expected)) {
    const now = Date.now();
    const entries = [{
      type: "custom",
      customType: "killeros-goal",
      data: { version: 1, event: status, state: {
        version: 1,
        revision: 1,
        objective: `${status} objective`,
        status,
        createdAt: now,
        updatedAt: now,
        activeMilliseconds: 0,
        turns: 3,
        blockedAuditStartTurn: 0,
        baselineTokens: 0,
        result: status === "complete" ? "verified" : undefined,
      } },
    }];
    const { commands, handlers } = createHarness();
    const { captured, ctx } = createTuiContext(entries);
    for (const handler of handlers.get("session_start")) await handler({}, ctx);
    await commands.get("goal").handler("", ctx);
    assert.deepEqual(captured.selection.options, options, status);
  }
});

test("/goal continues one turn at a time and pause stops future turns", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Finish the migration", ctx);
  assert.equal(sentMessages.length, 1);

  await emitGoalStart(handlers, ctx);
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
  assert.match(lastGoalEntry.data.state.result, /before an agent turn started/u);
  assert.equal(lastGoalEntry.data.state.turns, 0);
});

test("/goal does not report start, resume, or edit success after dispatch failure", async () => {
  for (const control of ["start", "resume", "edit"]) {
    const { api, appendedEntries, commands, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    const notifications = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });

    if (control === "start") {
      api.sendMessage = () => { throw new Error("provider unavailable"); };
      await commands.get("goal").handler("Start reliably", ctx);
    } else {
      await commands.get("goal").handler("Original objective", ctx);
      api.sendMessage = () => { throw new Error("provider unavailable"); };
      if (control === "resume") {
        await commands.get("goal").handler("pause", ctx);
        await commands.get("goal").handler("resume", ctx);
      } else {
        ctx.ui.editor = async () => "Edited objective";
        await commands.get("goal").handler("edit", ctx);
      }
    }

    const state = appendedEntries.filter((entry) => entry.customType === "killeros-goal").at(-1).data.state;
    assert.equal(state.status, "paused", `${control} failure must pause the goal`);
    assert.match(state.result, /continuation could not start: provider unavailable/u);
    assert.equal(sentMessages.length, control === "start" ? 0 : 1);
    assert.equal(notifications.some(({ message }) => new RegExp(control === "start" ? "Goal active" : control === "resume" ? "Goal resumed" : "Goal updated and active", "u").test(message)), false);
    assert.equal(notifications.at(-1).level, "error");
  }
});

test("/goal reports start, resume, and edit success after dispatch", async () => {
  const { commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  await commands.get("goal").handler("Original objective", ctx);
  assert.match(notifications.at(-1).message, /Goal active/u);
  await commands.get("goal").handler("pause", ctx);
  await commands.get("goal").handler("resume", ctx);
  assert.match(notifications.at(-1).message, /Goal resumed/u);
  ctx.ui.editor = async () => "Edited objective";
  await commands.get("goal").handler("edit", ctx);
  assert.match(notifications.at(-1).message, /Goal updated and active/u);
  assert.equal(sentMessages.length, 3);
});

test("/goal does not claim success when a pending message defers dispatch", async () => {
  const { appendedEntries, commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  ctx.hasPendingMessages = () => true;

  await commands.get("goal").handler("Wait for the pending message", ctx);
  assert.equal(sentMessages.length, 0);
  assert.equal(appendedEntries.at(-1).data.state.status, "active");
  assert.equal(notifications.some(({ message }) => /Goal active/u.test(message)), false);
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
  ctx.mode = "rpc";
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

  for (let turn = 0; turn < 3; turn += 1) {
    await emitGoalStart(handlers, ctx);
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
  assert.equal(sentMessages.length, 1, "invalid edits must not strand an active goal");

  for (const handler of handlers.get("before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
  ctx.ui.editor = async () => "Changed objective";
  api.appendEntry = () => { throw new Error("session write failed"); };
  await commands.get("goal").handler("edit", ctx);
  assert.equal(sentMessages.length, 1, "an unsaved continuation must not start");
  ctx.mode = "rpc";
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal paused/u);
  assert.match(notifications.at(-1).message, /session write failed/u);
  assert.equal(appendedEntries.at(-1).data.state.objective, "Keep the original objective");
});

test("completed goals leave the footer but remain available through /goal", async () => {
  const { commands, handlers, tools } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  const notifications = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
  await commands.get("goal").handler("Finish cleanly", ctx);
  await emitGoalStart(handlers, ctx);
  await tools.get("killeros_goal_update").execute(
    "complete",
    { status: "complete", evidence: "All checks passed" },
    new AbortController().signal,
    () => {},
    ctx,
  );

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });
  assert.doesNotMatch(footer.render(120).join("\n"), /goal complete/u);
  ctx.mode = "rpc";
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal complete/u);
  assert.match(notifications.at(-1).message, /All checks passed/u);
  footer.dispose();
});

test("goal transcript rows are compact until expanded", () => {
  const { entryRenderers, tools } = createHarness();
  const objective = "Objective ".repeat(400);
  const entry = { data: { version: 1, event: "set", state: {
    version: 1,
    revision: 1,
    objective,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    activeMilliseconds: 0,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  } } };
  assert.ok(entryRenderers.get("killeros-goal")(entry, { expanded: false }, theme).render(40).length <= 3);
  assert.match(entryRenderers.get("killeros-goal")(entry, { expanded: true }, theme).render(40).join("\n"), /Objective Objective/u);

  const result = { content: [], details: { status: "complete", evidence: "E".repeat(2_000) } };
  assert.ok(tools.get("killeros_goal_update").renderResult(result, { expanded: false }, theme).render(40).length <= 3);
  const expandedEvidence = tools.get("killeros_goal_update").renderResult(result, { expanded: true }, theme).render(40).join("\n");
  assert.equal((expandedEvidence.match(/E/gu) ?? []).length, 2_000);
});

test("active goal replaces the footer path with an exact yellow timer", async () => {
  const { appendedEntries, commands, handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
  await commands.get("goal").handler("Keep working", ctx);
  const state = appendedEntries.at(-1).data.state;
  const yellowTheme = {
    ...theme,
    fg: (color, text) => color === "warning" ? `\x1B[33m${text}\x1B[39m` : text,
  };
  const footer = captured.footerFactory(tui, yellowTheme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });
  const stripAnsi = (line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 10_000;
  const seconds = footer.render(160)[0];
  assert.match(seconds, /\x1B\[33m\/goal is active \(10s\)\x1B\[39m/u);
  assert.ok(stripAnsi(seconds).trimEnd().endsWith("/goal is active (10s)"));
  assert.doesNotMatch(stripAnsi(seconds), /✻ goal|pi-KillerOS/u);

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 125_000;
  assert.ok(stripAnsi(footer.render(40)[0]).trimEnd().endsWith("/goal is active (2m 05s)"));

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 3_725_000;
  assert.ok(stripAnsi(footer.render(40)[0]).trimEnd().endsWith("/goal is active (1h 02m 05s)"));

  for (let width = 1; width <= 180; width += 1) {
    const line = stripAnsi(footer.render(width)[0]);
    assert.equal([...line].length, width, `goal footer width mismatch at ${width}`);
  }
  footer.dispose();
});

test("registers /init as a native command and runs the hidden generation workflow", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-workflow-"));
  try {
    const { commands, handlers, sentMessages, sentUserMessages, tools } = createHarness();
    assert.equal(commands.has("init"), true);
    assert.equal(tools.has("init"), false);
    assert.equal(tools.has("init_survey"), false);

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

    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0].options, { triggerTurn: true });
    assert.equal(sentMessages[0].message.customType, "killeros-init");
    assert.equal(sentMessages[0].message.display, false);
    assert.ok(sentMessages[0].message.content.startsWith(INIT_WORKFLOW_PROMPT));
    assert.match(sentMessages[0].message.content, /Initial repository snapshot/u);
    assert.match(INIT_WORKFLOW_PROMPT, /## Analyze[\s\S]*## Synthesize[\s\S]*## Generate/u);
    assert.match(INIT_WORKFLOW_PROMPT, /ask no questions/u);
    assert.match(INIT_WORKFLOW_PROMPT, /killeros_init_write.*exactly once/u);
    assert.doesNotMatch(INIT_WORKFLOW_PROMPT, /preserve|targeted edit|init_survey|\.agents\/skills|killeros-hooks\.json/iu);

    await commands.get("init").handler("", ctx);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(notifications.at(-1), { message: "/init is already running", level: "warning" });

    await emitSuccessfulInitWrite(handlers, tools, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
    assert.equal(reloadCalls, 1);
    assert.deepEqual(sentUserMessages, []);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    assert.equal(reloadCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    writeFileSync(path.join(directory, "src-index.ts"), "export const value = 1;\n");
    const { commands, handlers, sentMessages, tools } = createHarness();
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
      input: { path: "src-index.ts" },
    }, ctx);
    assert.equal(readOnly.some((result) => result?.block), false);

    const replacement = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "replace-existing",
      toolName: "killeros_init_write",
      input: { content: "# AGENTS.md\n\nGenerated.\n" },
    }, ctx);
    assert.equal(replacement.some((result) => result?.block), false);
    await tools.get("killeros_init_write").execute("replace-existing", { content: "# AGENTS.md\n\nGenerated.\n" }, new AbortController().signal, () => {}, ctx);
    assert.equal(readFileSync(path.join(directory, "AGENTS.md"), "utf8"), "# AGENTS.md\n\nGenerated.\n");

    const secondWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "replace-again",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.match(secondWrite.find((result) => result?.block)?.reason, /scoped read tools|exactly once/u);

    const editTarget = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "edit-existing",
      toolName: "edit",
      input: { path: "AGENTS.md", edits: [{ oldText: "Generated", newText: "Changed" }] },
    }, ctx);
    assert.match(editTarget.find((result) => result?.block)?.reason, /may not modify any other file/u);

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

test("/init preserves the existing AGENTS.md when atomic replacement fails", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-rename-failure-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "original guidance\n");
    const renameError = Object.assign(new Error("replacement blocked"), { code: "EPERM" });

    await assert.rejects(
      writeInitAgentsFile(target, "replacement guidance\n", async () => { throw renameError; }),
      /replacement blocked/u,
    );
    assert.equal(readFileSync(target, "utf8"), "original guidance\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init blocks a linked AGENTS.md target", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-target-"));
  try {
    writeFileSync(path.join(directory, "shared.md"), "shared instructions\n");
    if (!createFileSymlinkOrSkip(t, "shared.md", path.join(directory, "AGENTS.md"))) return;

    const { commands, handlers, sentMessages, tools } = createHarness();
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
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.equal(writeAttempt.some((result) => result?.block), false);
    await assert.rejects(
      tools.get("killeros_init_write").execute("linked-agents", { content: "replacement" }, new AbortController().signal, () => {}, ctx),
      /regular, non-linked file/u,
    );
    assert.equal(readFileSync(path.join(directory, "shared.md"), "utf8"), "shared instructions\n");

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init rejects a target swapped after tool-call validation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-swap-target-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    const shared = path.join(directory, "shared.md");
    writeFileSync(target, "old guidance\n");
    writeFileSync(shared, "shared guidance\n");
    const { commands, handlers, sentMessages, tools } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    handlers.get("tool_call").push((event) => {
      if (event.toolName !== "killeros_init_write") return;
      rmSync(target);
      try {
        linkSync(shared, target);
      } catch {
        mkdirSync(target);
      }
    });
    const callResults = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "swap-target",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.equal(callResults.some((result) => result?.block), false);
    await assert.rejects(
      tools.get("killeros_init_write").execute("swap-target", { content: "replacement" }, new AbortController().signal, () => {}, ctx),
      /regular, non-linked file/u,
    );
    assert.equal(readFileSync(shared, "utf8"), "shared guidance\n");
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init retries its single AGENTS.md write only after a failed write", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-new-"));
  try {
    mkdirSync(path.join(directory, "AGENTS.md"));
    const { commands, handlers, sentMessages, tools } = createHarness();
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
      toolName: "killeros_init_write",
      input: { content: "# AGENTS.md" },
    }, ctx);
    assert.equal(firstWrite.some((result) => result?.block), false);
    await assert.rejects(
      tools.get("killeros_init_write").execute("create-agents", { content: "# AGENTS.md" }, new AbortController().signal, () => {}, ctx),
      /regular, non-linked file/u,
    );
    rmSync(path.join(directory, "AGENTS.md"), { recursive: true, force: true });

    const retryWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "retry-agents",
      toolName: "killeros_init_write",
      input: { content: "# AGENTS.md" },
    }, ctx);
    assert.equal(retryWrite.some((result) => result?.block), false);
    await tools.get("killeros_init_write").execute("retry-agents", { content: "# AGENTS.md" }, new AbortController().signal, () => {}, ctx);

    const thirdWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "third-agents",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
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

test("/init scopes reads to safe project files and freezes checked inputs", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-read-scope-"));
  const outsideSecret = path.join(os.tmpdir(), `killeros-init-outside-${process.pid}-${Date.now()}.txt`);
  try {
    mkdirSync(path.join(directory, ".agents", "skills"), { recursive: true });
    mkdirSync(path.join(directory, "@.."), { recursive: true });
    writeFileSync(path.join(directory, "allowed.ts"), "export const allowed = true;\n");
    writeFileSync(path.join(directory, "outside.md"), "outside guidance\n");
    writeFileSync(path.join(directory, "@..", "nested.md"), "nested in the @.. directory\n");
    writeFileSync(path.join(directory, "AGENTS.md"), "existing guidance\n");
    writeFileSync(outsideSecret, "OUTSIDE SECRET\n");
    let hasSymlink = false;
    try {
      symlinkSync(path.join(directory, "outside.md"), path.join(directory, "linked.md"), "file");
      hasSymlink = true;
    } catch (error) {
      if (!["EACCES", "EPERM", "UNKNOWN"].includes(error.code)) throw error;
    }
    let hasHardLink = false;
    try {
      linkSync(path.join(directory, "outside.md"), path.join(directory, "hard-linked.md"));
      hasHardLink = true;
    } catch (error) {
      if (!["EACCES", "EPERM", "UNKNOWN"].includes(error.code)) throw error;
    }

    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = () => {};
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    const read = async (toolName, value) => emitSequentially(handlers.get("tool_call"), {
      toolCallId: `${toolName}-${value}`,
      toolName,
      input: { path: value },
    }, ctx);
    assert.equal((await read("read", "allowed.ts")).some((result) => result?.block), false);
    assert.equal((await read("read", "@allowed.ts")).some((result) => result?.block), false);
    const blockedPaths = ["AGENTS.md", "agents.md", "AGENTS.local.md", "CLAUDE.md", ".agents/skills/secret.md", "../outside.md", path.join(directory, "outside.md"), "@../nested.md", `@../${path.basename(outsideSecret)}`, "@AGENTS.md", "@.git/config", "~/killeros-init-any.txt"];
    if (hasSymlink) blockedPaths.push("linked.md");
    if (hasHardLink) blockedPaths.push("hard-linked.md");
    for (const value of blockedPaths) {
      const results = await read("read", value);
      assert.equal(results.some((result) => result?.block), true, value);
    }
    const blockedFind = await read("find", ".");
    assert.equal(blockedFind.some((result) => result?.block), true);

    handlers.get("tool_call").push((event) => {
      if (event.toolName === "read") event.input.path = "../outside.md";
    });
    await assert.rejects(read("read", "allowed.ts"), /read-only property|Cannot assign/u);

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outsideSecret, { force: true });
  }
});

test("/init tool scoping never exposes killeros_init_write outside /init", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-tool-scope-"));
  try {
    writeFileSync(path.join(directory, "README.md"), "# Probe\n");
    const { commands, handlers, sentMessages, activeTools } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = () => {};

    for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
    assert.ok(activeTools.length > 0);
    assert.equal(activeTools.includes("killeros_init_write"), false);
    const fullSet = [...activeTools];

    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    assert.deepEqual(activeTools, ["read", "ls", "killeros_init_write"]);

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
    assert.deepEqual(activeTools, fullSet);

    for (const handler of handlers.get("session_start")) await handler({ reason: "new" }, ctx);
    assert.deepEqual(activeTools, fullSet);
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

test("never-closing hooks report unconfirmed exit after bounded cleanup", async () => {
  class NeverClosingHook extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals = [];

    kill(signal) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new NeverClosingHook();
  const result = await executeHook("ignored", process.cwd(), {}, 1_000, () => child);
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitUnconfirmed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("timed-out hooks terminate the process tree or report bounded uncertainty", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-tree-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const script = path.join(directory, "hook-child.cjs");
    const marker = path.join(directory, "late-marker");
    writeFileSync(script, [
      "const { spawn } = require('node:child_process');",
      "const marker = process.argv[1];",
      "spawn(process.execPath, ['-e', \"require('node:fs').writeFileSync(process.argv[1], 'late')\", marker], { stdio: 'ignore' });",
      "setTimeout(() => {}, 5000);",
    ].join("\n"));
    const command = `"${process.execPath}" "${script}" "${marker}"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command, timeoutMs: 1_000 }] },
    }));

    const { handlers } = createHarness();
    const notifications = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({}, ctx);
    const started = Date.now();
    const results = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "tree-timeout",
      toolName: "write",
      input: { path: "example.txt", content: "test" },
    }, ctx);
    assert.equal(results.find((result) => result?.block)?.block, true);
    assert.ok(Date.now() - started >= 1_000);
    assert.match(notifications.at(-1).message, /Hook failed \(timed out\)/u);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    assert.equal(existsSync(marker), false);
  } finally {
    await removeDirectoryEventually(directory);
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

    const { commands, handlers, sentMessages, tools } = createHarness();
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
    await emitSuccessfulInitWrite(handlers, tools, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
    assert.equal(reloadCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("question shows option, filter, and answer progress", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"), [{ label: "Alpha" }], "Choose", 8);
  assert.match(question.component.render(40).join("\n"), /Option 1\/2/u);
  question.component.handleInput("abc");
  assert.match(question.component.render(40).join("\n"), /Filter 3\/4,000/u);
  question.component.handleInput("\x1B");
  question.component.handleInput("2");
  question.component.handleInput("draft");
  assert.match(question.component.render(40).join("\n"), /Answer 5\/4,000/u);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question transcript is three rows collapsed and complete when expanded", () => {
  const { tools } = createHarness();
  const tool = tools.get("question");
  const args = {
    question: "Q".repeat(1_000),
    options: Array.from({ length: 9 }, (_, index) => ({
      label: `Option ${index + 1} ${"L".repeat(180)}`,
      description: `Description ${index + 1}`,
      preview: `# Preview ${index + 1}`,
    })),
  };
  const collapsed = tool.renderCall(args, theme, { expanded: false }).render(40);
  assert.ok(collapsed.length <= 3);

  const expanded = tool.renderCall(args, theme, { expanded: true }).render(40).join("\n");
  assert.match(expanded, /Option 9/u);
  assert.match(expanded, /Description 9/u);
  assert.match(expanded, /Preview 9/u);
  assert.ok(expanded.length > collapsed.join("\n").length);

  const answer = "A".repeat(4_000);
  const result = {
    content: [{ type: "text", text: `User wrote: ${answer}` }],
    details: { question: "Choose", options: ["Alpha"], answer, wasCustom: true },
  };
  assert.ok(tool.renderResult(result, { expanded: false }, theme).render(40).length <= 3);
  assert.equal((tool.renderResult(result, { expanded: true }, theme).render(40).join("\n").match(/A/gu) ?? []).length, 4_000);
});

test("question follows remapped selector bindings exactly", async () => {
  const previous = getKeybindings();
  const remapped = new TuiKeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.up": "ctrl+p",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+g",
  });
  setKeybindings(remapped);
  try {
    const { tools } = createHarness();
    const question = await startQuestion(
      tools.get("question"),
      [{ label: "Alpha" }, { label: "Beta" }],
      "Choose",
      8,
      remapped,
    );
    question.component.handleInput("\x1B[B");
    assert.match(question.component.render(80).join("\n"), /> 1\. Alpha/u);
    question.component.handleInput("\x0E");
    assert.match(question.component.render(80).join("\n"), /> 2\. Beta/u);
    assert.match(question.component.render(80).join("\n"), /ctrl\+p.*ctrl\+n/u);
    question.component.handleInput("\x19");
    assert.match((await question.result).content[0].text, /Beta/u);
  } finally {
    setKeybindings(previous);
  }
});

test("question renders nothing when no terminal width is available", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"), undefined, "Choose", 3);
  assert.deepEqual(question.component.render(0), []);
  assert.deepEqual(question.component.render(-1), []);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question keeps a custom draft visible at the six-row layout boundary", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"), undefined, "Choose", 6);
  question.component.handleInput("2");
  question.component.handleInput("visible draft");
  assert.match(question.component.render(40).join("\n"), /visible draft/u);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question rendering never exceeds terminal height for valid maximum content", async () => {
  const { tools } = createHarness();
  const options = Array.from({ length: 9 }, (_, index) => ({
    label: `Option ${index + 1} ${"L".repeat(190)}`,
    description: "D".repeat(500),
    preview: Array.from({ length: 100 }, () => "- preview content").join("\n"),
  }));

  for (const rows of [1, 2, 3, 5, 6, 12]) {
    for (const width of [20, 40, 80]) {
      const question = await startQuestion(tools.get("question"), options, `Question ${"Q".repeat(990)}`, rows);
      const rendered = question.component.render(width);
      assert.ok(rendered.length <= rows, `${width} columns rendered ${rendered.length}/${rows} rows`);
      if (rows >= 3) assert.match(rendered.join("\n"), /Question/u);
      assert.match(rendered.join("\n"), /Option 1/u);
      question.finish({ kind: "cancelled" });
      await question.result;
    }
  }
});

test("question invalidates cached rows when terminal height changes at the same width", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(
    tools.get("question"),
    Array.from({ length: 9 }, (_, index) => ({ label: `Choice ${index + 1}` })),
    "Choose one",
    12,
  );
  assert.ok(question.component.render(40).length <= 12);
  question.tui.terminal.rows = 3;
  const resized = question.component.render(40);
  assert.ok(resized.length <= 3);
  assert.match(resized.join("\n"), /Choose one/u);
  assert.match(resized.join("\n"), /Choice 1/u);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question keeps the selected option visible while its window moves", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(
    tools.get("question"),
    Array.from({ length: 9 }, (_, index) => ({ label: `Choice ${index + 1}` })),
    "Choose one",
    7,
  );
  for (let index = 0; index < 8; index += 1) question.component.handleInput("\x1B[B");
  const rendered = question.component.render(30).join("\n");
  assert.match(rendered, /Choice 9/u);
  assert.match(rendered, /Option 9\/10/u);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("maximum filter text stays on one bounded status row", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"), undefined, "Choose", 8);
  question.component.handleInput(`\x1B[200~${"Z".repeat(4_000)}\x1B[201~`);
  const rendered = question.component.render(20);
  assert.ok(rendered.length <= 8);
  assert.match(rendered.join("\n"), /Filter 4,000\/4,000/u);
  assert.ok(rendered.join("\n").length < 500);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question filtering decodes Kitty input, paste, and grapheme backspace", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"));

  question.component.handleInput("\x1B[97u");
  assert.match(question.component.render(80).join("\n"), /Filter 1\/4,000/u);

  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B[200~a\nb\tc\x1B[201~");
  assert.match(question.component.render(80).join("\n"), /Filter 7\/4,000/u);

  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B[200~👨‍👩‍👧‍👦\x1B[201~");
  assert.match(question.component.render(80).join("\n"), /Filter 7\/4,000/u);
  question.component.handleInput("\x7F");
  assert.doesNotMatch(question.component.render(80).join("\n"), /Filter /u);

  question.component.handleInput("\x1B[155u");
  assert.doesNotMatch(question.component.render(80).join("\n"), /Filter /u);

  question.component.handleInput("\x1B[200~1\x1B[201~");
  assert.match(question.component.render(80).join("\n"), /Filter 1\/4,000/u);

  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question filter bounds character and byte input", async () => {
  const { tools } = createHarness();
  assert.match(tools.get("question").description, /4,000 characters and 16,000 bytes/u);

  const huge = await startQuestion(tools.get("question"));
  huge.component.handleInput(`\x1B[200~${"Q".repeat(1_000_000)}\x1B[201~`);
  assert.match(huge.notifications.at(-1).message, /4,000 characters/u);
  assert.ok(huge.component.render(80).join("\n").length < 20_000);
  huge.finish({ kind: "cancelled" });
  await huge.result;

  const question = await startQuestion(tools.get("question"));
  const boundary = "Z".repeat(4_000);
  question.component.handleInput(`\x1B[200~${boundary}\x1B[201~`);
  const boundaryRender = question.component.render(80).join("\n");
  assert.match(boundaryRender, /Filter 4,000\/4,000/u);
  assert.ok(boundaryRender.length < 500);

  question.component.handleInput("\x1B[200~Z\x1B[201~");
  assert.match(question.notifications.at(-1).message, /4,000 characters/u);
  assert.match(question.component.render(80).join("\n"), /Filter 4,000\/4,000/u);
  question.finish({ kind: "cancelled" });
  await question.result;

  const unicode = await startQuestion(tools.get("question"));
  const emojiBoundary = "😀".repeat(4_000);
  unicode.component.handleInput(`\x1B[200~${emojiBoundary}\x1B[201~`);
  assert.match(unicode.component.render(80).join("\n"), /Filter 4,000\/4,000/u);
  unicode.component.handleInput("\x1B[200~😀\x1B[201~");
  assert.match(unicode.notifications.at(-1).message, /4,000 characters|16,000 bytes/u);
  assert.match(unicode.component.render(80).join("\n"), /Filter 4,000\/4,000/u);
  unicode.finish({ kind: "cancelled" });
  await unicode.result;
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

test("custom-answer history enforces Unicode character and byte limits", async () => {
  const { tools, handlers } = createHarness();
  const first = await startQuestion(tools.get("question"));
  first.component.handleInput("2");
  const boundary = "😀".repeat(4_000);
  first.component.handleInput(`\x1B[200~${boundary}\x1B[201~`);
  assert.equal(first.notifications.length, 0);
  first.component.handleInput("\x1B[200~😀\x1B[201~");
  assert.match(first.notifications.at(-1).message, /4000 characters/u);
  first.component.handleInput("\r");
  await first.result;

  for (let index = 0; index < 5; index += 1) {
    const answer = await startQuestion(tools.get("question"));
    answer.component.handleInput("2");
    answer.component.handleInput(`\x1B[200~answer-${index}-${"😀".repeat(3_991)}\x1B[201~`);
    answer.component.handleInput("\r");
    await answer.result;
  }
  const historyProbe = await startQuestion(tools.get("question"));
  historyProbe.component.handleInput("2");
  for (let index = 0; index < 5; index += 1) historyProbe.component.handleInput("\x1B[A");
  assert.doesNotMatch(historyProbe.component.render(80).join("\n"), /answer-0-/u);
  historyProbe.finish({ kind: "cancelled" });
  await historyProbe.result;

  const session = createTuiContext();
  for (const handler of handlers.get("session_start")) await handler({ reason: "new" }, session.ctx);
  const afterNewSession = await startQuestion(tools.get("question"));
  afterNewSession.component.handleInput("2");
  afterNewSession.component.handleInput("\x1B[A");
  assert.doesNotMatch(afterNewSession.component.render(80).join("\n"), /😀/u);
  afterNewSession.finish({ kind: "cancelled" });
  await afterNewSession.result;
});

test("display formatters contain non-finite telemetry and honor Windows path casing", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(formatTime(value), "0s");
    assert.equal(formatTokens(value), "0");
  }

  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  process.env.USERPROFILE = "C:\\Users\\Example";
  try {
    assert.equal(formatCwd("c:\\users\\example\\repo"), "~\\repo");
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});

test("context telemetry uses plain language without a progress bar", () => {
  assert.equal(formatContextProgress(50_000, 1_050_000, theme), "95% left (1M)");
  assert.equal(formatContextProgress(860_000, 1_000_000, theme), "14% left (140k) · /compact");
  assert.equal(formatContextProgress(null, 1_000_000, theme), "—% left (—)");
  assert.equal(formatContextProgress(Number.NaN, 1_000_000, theme), "—% left (—)");
  assert.doesNotMatch(formatContextProgress(50_000, 1_050_000, theme), /[█░]/u);
});

test("footer survives unavailable context telemetry", () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  ctx.getContextUsage = () => { throw new Error("usage unavailable"); };
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  assert.doesNotThrow(() => footer.render(80));
  assert.match(footer.render(80).join("\n"), /—% left \(—\)/u);
  footer.dispose();
});

test("personal instruction truncation preserves valid UTF-8", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-personal-"));
  try {
    writeFileSync(path.join(directory, "AGENTS.local.md"), `${"a".repeat(32_767)}é`, "utf8");
    const instructions = resolvePersonalInstructions(directory);
    assert.ok(instructions);
    assert.doesNotMatch(instructions.content, /�/u);
    assert.match(instructions.content, /truncated by KillerOS/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("footer scans session cost once until session content changes", async () => {
  const { handlers } = createHarness();
  const entries = [{ type: "message", message: { role: "assistant", usage: usage(1) } }];
  const { captured, ctx, tui } = createTuiContext(entries);
  let entryReads = 0;
  ctx.sessionManager.getEntries = () => {
    entryReads += 1;
    return entries;
  };
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });

  footer.render(120);
  footer.render(120);
  footer.render(120);
  assert.equal(entryReads, 1);

  entries.push({ type: "message", message: { role: "toolResult", usage: usage(2) } });
  for (const handler of handlers.get("turn_end") ?? []) {
    await handler({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
  }
  assert.match(footer.render(120).join("\n"), /\$3\.00/u);
  assert.equal(entryReads, 2);

  for (const handler of handlers.get("session_compact") ?? []) {
    await handler({ compactionEntry: { details: {} } }, ctx);
  }
  footer.render(120);
  assert.equal(entryReads, 3);

  for (const handler of handlers.get("session_tree") ?? []) await handler({}, ctx);
  footer.render(120);
  assert.equal(entryReads, 4);
  footer.dispose();
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

test("editor highlights recognized slash command prefixes without coloring paths or typos", async () => {
  const { commands, handlers } = createHarness();
  commands.set("skill:reviewing-and-fixing-code", { description: "Review code" });
  const commandTheme = {
    ...theme,
    fg: (color, text) => color === "mdLink" ? `\x1B[34m${text}\x1B[39m` : text,
  };
  const { captured, ctx, tui } = createTuiContext([], commandTheme);
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
  const editorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
  const editor = captured.editorFactory(tui, editorTheme, getKeybindings());

  editor.setText("use /skill:rev then /model; keep C:/src and https://host plus /made-up plain");
  const rendered = editor.render(120).join("\n");
  assert.match(rendered, /\x1B\[34m\/skill:rev\x1B\[39m/u);
  assert.match(rendered, /\x1B\[34m\/model\x1B\[39m/u);
  assert.doesNotMatch(rendered, /\x1B\[34m(?:\/src|\/\/host|\/made-up)/u);

  commands.set("late-command", { description: "Registered after editor creation" });
  editor.setText("/late");
  assert.match(editor.render(40).join("\n"), /\x1B\[34m\/late\x1B\[39m/u);

  const wrappedCommand = "/skill:reviewing-and-fixing-code";
  editor.setText(wrappedCommand);
  const wrapped = editor.render(12).join("\n");
  const blueText = [...wrapped.matchAll(/\x1B\[34m([^\x1B]*)\x1B\[39m/gu)]
    .map((match) => match[1])
    .join("");
  assert.equal(blueText, wrappedCommand);

  editor.setText("/skill:reviewing-and-fixing-typo");
  assert.doesNotMatch(editor.render(12).join("\n"), /\x1B\[34m/u);
  assert.deepEqual(editor.render(0), []);

  tui.terminal.rows = 5;
  editor.setText(wrappedCommand);
  for (const width of [1, 2, 3]) {
    const narrow = editor.render(width);
    assert.ok(narrow.every((line) => visibleWidth(line) <= width));
    assert.match(narrow.join("\n"), /\x1B\[34m/u);
  }
  const scrolled = editor.render(8).join("\n");
  const scrolledBlueText = [...scrolled.matchAll(/\x1B\[34m([^\x1B]*)\x1B\[39m/gu)]
    .map((match) => match[1])
    .join("");
  assert.ok(scrolledBlueText.length > 0);
  assert.ok(wrappedCommand.endsWith(scrolledBlueText));

  editor.setText(`/model\nAAAAAodel ${"Z".repeat(20)}`);
  const ordinaryScrolledText = editor.render(8).join("\n");
  assert.match(ordinaryScrolledText, /odel/u);
  assert.doesNotMatch(ordinaryScrolledText, /\x1B\[34model/u);

  editor.setText("/late");
  editor.focused = true;
  editor.handleInput("\x1B[D");
  assert.match(editor.render(40).join("\n"), /\x1B_pi:c\x07/u);
  assert.ok((editor.render(40).join("\n").match(/\x1B\[34m/gu) ?? []).length >= 2);
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

test("activity uses an animated orange glyph loop and a nonrepeating shuffled verb deck", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  assert.deepEqual(captured.workingIndicator, {
    frames: ["·", "✢", "✱", "✶", "✻", "✽", "✽", "✻", "✶", "✱", "✢", "·"],
    intervalMs: 120,
  });
  assert.equal(captured.hiddenThinkingLabel, "└ Thinking…");
  for (const handler of handlers.get("agent_start")) handler({}, ctx);

  const plainMessage = /^(?:Brewing|Pondering|Tinkering|Wrangling|Noodling|Cooking)… \(esc to interrupt · thinking\)$/u;
  for (let index = 0; index < 5; index += 1) t.mock.timers.tick(2_500);
  const firstDeck = captured.workingMessages.slice(-6);
  assert.equal(new Set(firstDeck).size, 6);
  assert.ok(firstDeck.every((message, index) => plainMessage.test(message) && (index === 0 || message !== firstDeck[index - 1])));

  t.mock.timers.tick(2_500);
  assert.notEqual(captured.workingMessages.at(-1), firstDeck.at(-1));
});

test("activity styles glyph and verb orange with a gray bold interrupt status", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const styledTheme = {
    bold: (text) => `<bold>${text}</bold>`,
    fg: (color, text) => `<${color}>${text}</${color}>`,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
  };
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext([], styledTheme);
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  assert.deepEqual(captured.workingIndicator, {
    frames: [
      "<accent>·</accent>", "<accent>✢</accent>", "<accent>✱</accent>", "<accent>✶</accent>",
      "<accent>✻</accent>", "<accent>✽</accent>", "<accent>✽</accent>", "<accent>✻</accent>",
      "<accent>✶</accent>", "<accent>✱</accent>", "<accent>✢</accent>", "<accent>·</accent>",
    ],
    intervalMs: 120,
  });
  for (const handler of handlers.get("agent_start")) handler({}, ctx);

  assert.match(
    captured.workingMessages.at(-1) ?? "",
    /^<accent>(?:Brewing|Pondering|Tinkering|Wrangling|Noodling|Cooking)…<\/accent> <dim>\(<bold>esc<\/bold> to interrupt · thinking\)<\/dim>$/u,
  );
  for (const handler of handlers.get("agent_end")) handler({ messages: [] }, ctx);
});

test("activity timer stops on agent end and session shutdown", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);
  for (const handler of handlers.get("agent_start")) handler({}, ctx);
  for (const handler of handlers.get("agent_end")) handler({ messages: [] }, ctx);
  const countAfterEnd = captured.workingMessages.length;
  t.mock.timers.tick(10_000);
  assert.equal(captured.workingMessages.length, countAfterEnd);

  for (const handler of handlers.get("agent_start")) handler({}, ctx);
  for (const handler of handlers.get("agent_start")) handler({}, ctx);
  const countBeforeReplacementTick = captured.workingMessages.length;
  t.mock.timers.tick(2_500);
  assert.equal(captured.workingMessages.length, countBeforeReplacementTick + 1);

  for (const handler of handlers.get("session_shutdown")) handler({}, ctx);
  const countAfterShutdown = captured.workingMessages.length;
  t.mock.timers.tick(10_000);
  assert.equal(captured.workingMessages.length, countAfterShutdown);
});

test("Git branch resolution is asynchronous and bounded", async () => {
  const pending = resolveGitBranch(process.cwd());
  assert.ok(pending instanceof Promise);
  const branch = await pending;
  assert.ok(branch === undefined || branch === "detached" || branch.length > 0);
});

test("disposed startup headers ignore late Git results", async () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  let renders = 0;
  const tui = { requestRender: () => { renders += 1; }, terminal: { rows: 40 } };
  for (const handler of handlers.get("session_start")) handler({}, ctx);
  const header = captured.headerFactory(tui);
  header.render(80);
  for (const handler of handlers.get("session_shutdown")) handler({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(renders, 0);
});

test("shell startup contains no synchronous child process call", () => {
  const source = readFileSync(new URL("../killeros/shell-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /execFileSync/u);
});

test("header renders the compact KillerOS card", () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  ctx.ui.theme = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim"
        ? `\x1B[90m${text}\x1B[39m`
        : color === "mdLink" ? `\x1B[34m${text}\x1B[39m` : text,
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
  assert.ok(rendered.some((line) => line.includes("\x1B[34m/model\x1B[39m")));
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

  for (let index = 0; index < 4; index += 1) {
    const { captured, ctx, tui } = createTuiContext();
    sessionStart({}, ctx);
    const first = captured.headerFactory(tui).render(76).map(strip).find((line) => line.startsWith("Tip:"));
    const second = captured.headerFactory(tui).render(76).map(strip).find((line) => line.startsWith("Tip:"));
    assert.equal(first, second);
    tips.push(first);
    sessionShutdown();
  }

  assert.equal(new Set(tips).size, 4);
});
