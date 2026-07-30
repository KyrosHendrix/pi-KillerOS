import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Killeros from "../Killeros.ts";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const theme = {
  bold: (text) => text,
  fg: (_color, text) => text,
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
  const api = {
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
    registerTool: (tool) => tools.set(tool.name, tool),
    setThinkingLevel: () => {},
  };
  Killeros(api);
  return { api, commands, handlers, tools };
}

function createTuiContext(entries = []) {
  const captured = {};
  const tui = { requestRender() {}, terminal: { rows: 40 } };
  const ctx = {
    cwd: process.cwd(),
    getContextUsage: () => ({ tokens: 1_000, contextWindow: 128_000 }),
    mode: "tui",
    model: {
      id: "test-model",
      name: "Test model",
      provider: "test",
      reasoning: true,
    },
    sessionManager: { getEntries: () => entries },
    ui: {
      addAutocompleteProvider: (factory) => { captured.autocompleteFactory = factory; },
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
  };
  return { captured, ctx, tui };
}

async function startQuestion(tool, options = [{ label: "Alpha" }]) {
  let component;
  let finish;
  const tui = { requestRender() {}, terminal: { rows: 40 } };
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
    { question: "Choose", options },
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

test("registers /exit without conflicting with Pi's /quit", async () => {
  const { commands } = createHarness();
  assert.equal(commands.has("exit"), true);
  assert.equal(commands.has("quit"), false);

  let shutdownCalled = false;
  await commands.get("exit").handler("", { shutdown: async () => { shutdownCalled = true; } });
  assert.equal(shutdownCalled, true);
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
  const { handlers, commands, tools } = createHarness();
  commands.set("mcp", {
    description: "Connect to MCP servers",
    sourceInfo: { path: "/extensions/pi-mcp-adapter/index.ts", source: "npm:pi-mcp-adapter" },
  });
  tools.set("web_search", {
    name: "web_search",
    description: "Search the web",
    sourceInfo: { path: "/extensions/pi-web-access/index.ts", source: "npm:pi-web-access" },
  });
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);
  assert.equal(captured.themeName, "killeros");

  const header = captured.headerFactory(tui);
  const strip = (line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  const wide = header.render(120).map(strip);
  assert.equal(wide.length, 8);
  assert.ok(wide.join("\n").includes(`› KillerOS ${PACKAGE_VERSION}`));
  assert.match(wide.join("\n"), /test-model · high/);
  assert.match(wide.join("\n"), /99% context/);
  assert.match(wide.join("\n"), /MCP adapter · Web access/);
  assert.doesNotMatch(wide.join("\n"), /KILLEROS/);
  assert.ok(wide.every((line) => [...line].length === 76));
  for (let width = 1; width <= 100; width += 1) {
    const lines = header.render(width).map(strip);
    assert.ok(lines.every((line) => [...line].length <= width), `header overflowed at width ${width}`);
    if (width >= 28) {
      assert.ok(lines.every((line) => [...line].length === Math.min(width, 76)), `header was ragged at width ${width}`);
    }
  }
  assert.deepEqual(header.render(4).map(strip), ["Kill"]);
  assert.deepEqual(header.render(0), []);
  header.dispose();
});
