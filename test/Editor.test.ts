import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, createTuiContext, getHandlers, last, requireEditor, requiredFactory } from "./ExtensionTestHarness.ts";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { themeTestAdapter } from "./PiTestAdapters.ts";

type TestStyle = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

type TestFullStyle = TestStyle & {
  italic(text: string): string;
  strikethrough(text: string): string;
  underline(text: string): string;
};

type TestEditorTheme = {
  borderColor(text: string): string;
  selectList: {
    selectedPrefix(text: string): string;
    selectedText(text: string): string;
    description(text: string): string;
    scrollInfo(text: string): string;
    noMatch(text: string): string;
  };
};

function createEditorTheme(): TestEditorTheme {
  return {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
}

test("editor has a top border, is focus-aware and width-safe, and supports Shift+Enter", async () => {
  const source = readFileSync(new URL("../killeros/shell-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /buildVisualLineMap|scrollOffset|lastWidth|as unknown as/u);
  assert.doesNotMatch(source, /COMMAND_TOKEN_PATTERN|highlightEditorLines/u);

  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
  const editorTheme: TestEditorTheme = {
    borderColor: (text) => text,
    selectList: {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
  };
  const editor = requireEditor(requiredFactory(captured.editorFactory, "editor")(tui, editorTheme, getKeybindings()));
  editor.focused = true;
  const emptyRender = editor.render(40);
  const emptyLines = emptyRender.map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(emptyLines[0], "─".repeat(40));
  const emptyPrompt = emptyLines[1] ?? "";
  assert.equal(emptyLines.length, 2);
  assert.match(emptyPrompt.replace(/\x1B_pi:c\x07/gu, ""), /^❯\u00A0Try "/u);
  assert.equal(visibleWidth(emptyPrompt), 40);
  assert.doesNotMatch(emptyPrompt, /─/u);
  for (let width = 1; width <= 180; width += 1) {
    const lines = editor.render(width);
    assert.equal(visibleWidth(lines[0] ?? ""), width, `top border width ${width}`);
    assert.equal(lines.length, 2, `empty editor rows at width ${width}`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `empty editor width ${width}`);
  }

  editor.setText("/model");
  const rendered = editor.render(40);
  const promptLine = rendered[1]?.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "") ?? "";
  assert.equal(promptLine.slice(0, 8), "❯\u00A0/model");
  assert.doesNotMatch(rendered.join("\n"), /Try "/u);
  assert.doesNotMatch(rendered.join("\n"), /\x1B\[34m/u);
  assert.deepEqual(editor.render(0), []);
  for (let width = 1; width <= 180; width += 1) {
    assert.ok(editor.render(width).every((line) => visibleWidth(line) <= width), `editor width ${width}`);
  }
  editor.setText("first");
  editor.handleInput("\x1B[13;2u");
  editor.handleInput("second");
  assert.equal(editor.getText(), "first\nsecond");
  const multiline = editor.render(40).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(multiline[0], "─".repeat(40));
  assert.match(multiline[1], /^❯\u00A0first/u);
  assert.match(multiline[2], /^  second/u);

  editor.setText("wrapped text ".repeat(20));
  const wrapped = editor.render(24).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(wrapped[0], "─".repeat(24));
  assert.match(wrapped[1], /^  ↑ \d+ more/u);
  assert.ok(wrapped.slice(2).every((line) => line.startsWith("  ")));
  editor.handleInput("\x1B[5~");
  const scrolledUp = editor.render(24).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.match(last(scrolledUp) ?? "", /^  ↓ \d+ more/u);
});

test("editor arrow alone carries focus color", async () => {
  const styledTheme: TestFullStyle = {
    bold: (text) => text,
    fg: (color, text) => `<${color}>${text}</${color}>`,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
  };
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext([], themeTestAdapter(styledTheme));
  for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
  const editor = requireEditor(requiredFactory(captured.editorFactory, "editor")(tui, createEditorTheme(), getKeybindings()));

  editor.setText("hello");
  editor.focused = false;
  assert.match(editor.render(20)[1], /^<dim>❯\u00A0<\/dim>hello/u);
  editor.focused = true;
  assert.match(editor.render(20)[1], /^<accent>❯\u00A0<\/accent>/u);
});

test("shell UI preserves an existing custom editor factory", async () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  const existingFactory = () => ({ render: () => [], handleInput() {}, getText: () => "", setText() {} });
  captured.currentEditorFactory = existingFactory;
  for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
  assert.equal(captured.editorFactory, undefined);
  assert.equal(captured.currentEditorFactory, existingFactory);
});

test("autocomplete omits unsupported argument hints", async () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

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

test("top-bordered editor keeps autocomplete rows aligned below the prompt", async () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);
  const current = {
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    getSuggestions: async () => ({ prefix: "/", items: [] }),
    shouldTriggerFileCompletion: () => true,
  };
  const editor = requireEditor(requiredFactory(captured.editorFactory, "editor")(tui, createEditorTheme(), getKeybindings()));
  editor.focused = true;
  editor.setAutocompleteProvider(captured.autocompleteFactory(current));
  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const rendered = editor.render(60).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(rendered[0], "─".repeat(60));
  assert.match(rendered[1], /^❯\u00A0\//u);
  assert.ok(rendered.slice(2).some((line) => line.includes("/clear")));
  assert.ok(rendered.slice(2).every((line) => line.startsWith("  ")));
});

test("autocomplete preserves text and horizontal whitespace after the cursor", async () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  const current = {
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    getSuggestions: async () => ({ prefix: "/", items: [] }),
    shouldTriggerFileCompletion: () => true,
  };
  const provider = captured.autocompleteFactory(current);
  const cases = [
    { line: "/go", cursorCol: 3, expected: "/goal " },
    { line: "/gokeep", cursorCol: 3, expected: "/goal keep" },
    { line: "/go keep", cursorCol: 3, expected: "/goal  keep" },
    { line: "prefix /go   keep", cursorCol: 10, expected: "prefix /goal    keep" },
    { line: "prefix\t/go\t \tkeep", cursorCol: 10, expected: "prefix\t/goal \t \tkeep" },
  ];

  for (const testCase of cases) {
    const suggestions = await provider.getSuggestions([testCase.line], 0, testCase.cursorCol, {});
    const goal = suggestions.items.find((candidate) => candidate.label === "/goal");
    assert.ok(goal, `missing /goal for ${JSON.stringify(testCase.line)}`);
    const completed = provider.applyCompletion([testCase.line], 0, testCase.cursorCol, goal, suggestions.prefix);
    assert.deepEqual(completed, {
      lines: [testCase.expected],
      cursorLine: 0,
      cursorCol: testCase.line.startsWith("prefix") ? 13 : 6,
    });
  }
});
