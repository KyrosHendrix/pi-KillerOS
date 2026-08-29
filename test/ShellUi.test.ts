import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHarness, createTuiContext, disposeTestComponent, getHandlers, last, requireEditor, requiredFactory, theme } from "./ExtensionTestHarness.ts";
import { getKeybindings } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { resolveGitBranch } from "../killeros/shell-ui.ts";
import { themeTestAdapter } from "./PiTestAdapters.ts";

type TestStyle = {
  bold(text: string): string;
  fg(color: string, text: string): string;
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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPackageVersion(): string {
  const value: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(isUnknownRecord(value) && typeof value.version === "string");
  return value.version;
}

const PACKAGE_VERSION = readPackageVersion();

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
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);
  const header = captured.headerFactory(tui);
  header.render(80);
  for (const handler of getHandlers(handlers, "session_shutdown")) handler({}, ctx);
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
  ctx.cwd = path.join(path.parse(process.cwd()).root, "work", "pi-KillerOS");
  const headerTheme: TestStyle = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim"
        ? `\x1B[90m${text}\x1B[39m`
        : color === "mdLink" ? `\x1B[34m${text}\x1B[39m` : text,
  };
  ctx.ui.theme = themeTestAdapter({ ...theme, ...headerTheme });
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);
  assert.equal(captured.themeName, "killeros");

  const header = captured.headerFactory(tui);
  const strip = (line: string) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
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
  disposeTestComponent(header);
});

test("startup tips and editor suggestions stay fixed per session and exhaust their shuffled decks", async () => {
  const originalRandom = Math.random;
  const suggestions: string[] = [];
  const tips: string[] = [];
  const strip = (line: string) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").trim();
  const shellUiUrl = new URL("../killeros/shell-ui.ts", import.meta.url);
  shellUiUrl.searchParams.set("startup-tip-test", String(Date.now()));
  // The query string forces a fresh module instance, so its exports cannot be typed statically.
  const shellUiModule: unknown = await import(shellUiUrl.href);
  assert.ok(typeof shellUiModule === "object" && shellUiModule !== null);
  assert.ok("registerShellUi" in shellUiModule && typeof shellUiModule.registerShellUi === "function");
  Math.random = () => 0;

  try {
    for (let index = 0; index < 10; index += 1) {
      const { api, handlers } = createHarness();
      (shellUiModule as { registerShellUi(api: unknown): void }).registerShellUi(api);
      const { captured, ctx, tui } = createTuiContext();
      last(getHandlers(handlers, "session_start"))({}, ctx);
      const first = captured.headerFactory(tui).render(76).map(strip).find((line) => line.startsWith("Tip:"));
      const second = captured.headerFactory(tui).render(76).map(strip).find((line) => line.startsWith("Tip:"));
      assert.equal(first, second);
      assert.ok(first);
      tips.push(first);

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
      const firstEditor = requireEditor(requiredFactory(captured.editorFactory, "editor")(tui, editorTheme, getKeybindings()));
      const secondEditor = requireEditor(requiredFactory(captured.editorFactory, "editor")(tui, editorTheme, getKeybindings()));
      const firstSuggestion = strip(firstEditor.render(76)[1] ?? "");
      const secondSuggestion = strip(secondEditor.render(76)[1] ?? "");
      assert.equal(firstSuggestion, secondSuggestion);
      assert.match(firstSuggestion, /^❯\u00A0Try "/u);
      suggestions.push(firstSuggestion);
      last(getHandlers(handlers, "session_shutdown"))({}, ctx);
    }
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(new Set(tips).size, 10);
  assert.equal(new Set(suggestions).size, 10);
});
