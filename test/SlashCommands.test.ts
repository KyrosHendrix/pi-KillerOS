import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  createSlashCommandResolver,
  findSlashCommandTokens,
  getSlashCommandPrefix,
  registerSlashAutocomplete,
} from "../killeros/commands.ts";
import { highlightSlashCommands, registerShellUi } from "../killeros/shell-ui.ts";

function command(name: string, source: "extension" | "prompt" | "skill" = "extension") {
  return {
    name,
    source,
    sourceInfo: { path: "test", source: "test", scope: "temporary" as const, origin: "top-level" as const, baseDir: "." },
  };
}

interface TestEditor {
  focused: boolean;
  setText(text: string): void;
  render(width: number): string[];
}

type TestEditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => TestEditor;

interface TestAutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: unknown,
  ): Promise<{ items: Array<{ label: string; description?: string }> }>;
}

type TestProviderFactory = (current: unknown) => TestAutocompleteProvider;

test("slash tokenization keeps autocomplete and highlighting boundaries aligned", () => {
  assert.deepEqual(getSlashCommandPrefix("prefix /go"), { prefix: "go", slashIndex: 7 });
  assert.deepEqual(getSlashCommandPrefix("\t/goal"), { prefix: "goal", slashIndex: 1 });
  assert.equal(getSlashCommandPrefix("https://example.com"), undefined);
  assert.equal(getSlashCommandPrefix("(/goal"), undefined);

  assert.deepEqual(
    findSlashCommandTokens("/goal /variants\t/skill:review"),
    [
      { name: "goal", start: 0, end: 5 },
      { name: "variants", start: 6, end: 15 },
      { name: "skill:review", start: 16, end: 29 },
    ],
  );
  assert.deepEqual(findSlashCommandTokens("https://example.com /src/index.ts //comment"), []);
});

test("resolver covers built-ins, aliases, extensions, prompts, skills, and refreshes dynamically", () => {
  let commands = [
    command("goal"),
    command("clear"),
    command("handoff"),
    command("release", "prompt"),
    command("skill:review", "skill"),
  ];
  const resolver = createSlashCommandResolver({ getCommands: () => commands });

  assert.equal(resolver.isValidCommand("settings"), true);
  assert.equal(resolver.isValidCommand("goal"), true);
  assert.equal(resolver.isValidCommand("clear"), true);
  assert.equal(resolver.isValidCommand("handoff"), true);
  assert.equal(resolver.isValidCommand("release"), true);
  assert.equal(resolver.isValidCommand("skill:review"), true);
  assert.equal(resolver.isValidCommand("go"), false);
  assert.equal(resolver.isValidCommand("goalx"), false);

  resolver.updateFallbackCommands([{ value: "/fallback ", label: "/fallback", description: "Fallback command" }]);
  assert.equal(resolver.isValidCommand("fallback"), true);
  resolver.updateFallbackCommands([]);
  assert.equal(resolver.isValidCommand("fallback"), false);

  commands = commands.filter(({ name }) => name !== "goal");
  assert.equal(resolver.isValidCommand("goal"), false);
  commands.push(command("new-command"));
  assert.equal(resolver.isValidCommand("new-command"), true);
});

test("highlighter colors only exact valid commands and preserves ANSI cursor state", () => {
  const style = (token: string) => `<blue>${token}</blue>`;
  const isValid = (name: string) => name === "goal" || name === "variants";
  const cases = [
    ["/goal review this file", "<blue>/goal</blue> review this file"],
    ["/go", "/go"],
    ["/goalx", "/goalx"],
    ["/does-not-exist", "/does-not-exist"],
    ["/src/index.ts", "/src/index.ts"],
    ["https://example.com", "https://example.com"],
    ["//comment", "//comment"],
    ["/goal,", "/goal,"],
    ["prose /goal /variants", "prose <blue>/goal</blue> <blue>/variants</blue>"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(highlightSlashCommands(input, isValid, style), expected, input);
  }

  const cursorLine = `x /g${CURSOR_MARKER}\x1B[7mo\x1B[0mal args`;
  const highlighted = highlightSlashCommands(cursorLine, isValid, style);
  assert.match(highlighted, /<blue>\/g<\/blue>/u);
  assert.match(highlighted, /<blue>o<\/blue>/u);
  assert.match(highlighted, /<blue>al<\/blue>/u);
  assert.ok(highlighted.includes(CURSOR_MARKER));
  assert.equal(stripTerminalSequences(highlighted.replace(/<blue>|<\/blue>/gu, "")), "x /goal args");
  assert.equal(visibleWidth(highlighted.replace(/<blue>|<\/blue>/gu, "")), visibleWidth(cursorLine));
});

test("editor render uses the shared resolver, mdLink theme role, multiline tokens, and safe widths", () => {
  let commands = [command("goal"), command("variants")];
  const resolver = createSlashCommandResolver({ getCommands: () => commands });
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  let editorFactory: TestEditorFactory | undefined;
  const api = {
    getCommands: () => commands,
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };

  const styledTokens: string[] = [];
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      theme: {
        bold: (text: string) => text,
        fg: (color: string, text: string) => {
          if (color === "mdLink") {
            styledTokens.push(text);
            return `\x1B[34m${text}\x1B[39m`;
          }
          return text;
        },
      },
      setTheme: () => ({ success: true }),
      setHeader: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      getEditorComponent: () => undefined,
      setEditorComponent: (factory: TestEditorFactory) => { editorFactory = factory; },
    },
  };
  registerShellUi(api as never, resolver);
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  assert.ok(editorFactory);

  const tui = { requestRender() {}, terminal: { rows: 40 } };
  const editor = editorFactory(
    tui,
    {
      borderColor: (text: string) => text,
      selectList: {
        selectedPrefix: (text: string) => text,
        selectedText: (text: string) => text,
        description: (text: string) => text,
        scrollInfo: (text: string) => text,
        noMatch: (text: string) => text,
      },
    },
    getKeybindings(),
  );
  editor.focused = true;
  editor.setText("/goal review\n/variants");
  styledTokens.length = 0;
  const rendered = editor.render(60);
  assert.deepEqual(styledTokens, ["/goal", "/variants"]);
  assert.match(rendered.join("\n"), /\x1B\[34m\/goal\x1B\[39m/u);
  assert.match(rendered.join("\n"), /\x1B\[34m\/variants\x1B\[39m/u);
  assert.ok(rendered.some((line: string) => line.includes(CURSOR_MARKER)));

  for (let width = 1; width <= 100; width += 1) {
    assert.ok(editor.render(width).every((line: string) => visibleWidth(line) <= width), `editor width ${width}`);
  }

  commands = commands.filter(({ name }) => name !== "goal");
  styledTokens.length = 0;
  editor.setText("/goal review");
  editor.render(60);
  assert.deepEqual(styledTokens, []);
});

test("autocomplete uses the same resolver and falls back to current base suggestions", async () => {
  let commands = [command("goal"), command("handoff")];
  const resolver = createSlashCommandResolver({ getCommands: () => commands });
  let providerFactory: TestProviderFactory | undefined;
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  const api = {
    getCommands: () => commands,
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  };
  registerSlashAutocomplete(api as never, resolver);
  const ctx = {
    mode: "tui",
    ui: { addAutocompleteProvider: (factory: TestProviderFactory) => { providerFactory = factory; } },
  };
  for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
  assert.ok(providerFactory);

  const current = {
    getSuggestions: async () => ({
      prefix: "/",
      items: [{ value: "/fallback ", label: "/fallback", description: "Fallback command" }],
    }),
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
  };
  const provider = providerFactory(current);
  const suggestions = await provider.getSuggestions(["/"], 0, 1, {});
  assert.ok(suggestions.items.some((item: { label: string }) => item.label === "/goal"));
  assert.equal(
    suggestions.items.find((item: { label: string }) => item.label === "/handoff")?.description,
    "[Extension] /handoff [next-session focus] —",
  );
  assert.equal(
    suggestions.items.find((item: { label: string }) => item.label === "/fallback")?.description,
    "[Built-in] Fallback command",
  );
  assert.equal(resolver.isValidCommand("fallback"), true);

  commands = [];
  const afterRemoval = await provider.getSuggestions(["/"], 0, 1, {});
  assert.equal(afterRemoval.items.some((item: { label: string }) => item.label === "/goal"), false);
  assert.equal(resolver.isValidCommand("goal"), false);
});
