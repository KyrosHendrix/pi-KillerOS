import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Killeros, { formatContextProgress } from "../Killeros.ts";

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
  assert.ok(wide.includes(process.cwd()));

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
