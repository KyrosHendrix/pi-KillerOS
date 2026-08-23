import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  getKeybindings,
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import Killeros, {
  buildInitEvidence,
  captureInitTargetBaseline,
  executeHook,
  formatContextProgress,
  INIT_WORKFLOW_PROMPT,
  installInitAgentsFile,
  listInitEvidence,
  readInitEvidence,
  validateGeneratedGuidance,
  writeInitAgentsFile,
} from "../Killeros.ts";
import { formatCwd, formatTime, formatTokens } from "../killeros/display.ts";
import { resetCodexFastState } from "../killeros/codex-fast-state.ts";
import { resolvePersonalInstructions } from "../killeros/personal-instructions.ts";
import { registerHandoff } from "../killeros/handoff.ts";
import { createGoalRuntime, type GoalState, type GoalStatus } from "../killeros/runtime.ts";
import { resolveGitBranch } from "../killeros/shell-ui.ts";
import { BoundedText } from "../killeros/bounded-text.ts";

type PackageJson = { version: string };
type ThemeJson = { colors: Record<string, string>; vars: Record<string, string> };
type QuestionOption = { label: string; description?: string; preview?: string; [key: string]: unknown };
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
type TestUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
type TestEvent = Record<string, unknown>;
type TestNotification = { message: string; level?: string };
type TestHandlerResult = {
  block?: boolean;
  reason?: string;
  systemPrompt?: string;
  content?: Array<{ type: string; text: string }>;
  [key: string]: unknown;
} | undefined;
type TestHandler = (event: TestEvent, ctx?: unknown) => TestHandlerResult | Promise<TestHandlerResult>;
type TestRenderable = {
  render(width: number): string[];
  handleInput(input: string): void;
  setAutocompleteProvider(provider: unknown): void;
  dispose(): void;
  focused: boolean;
  setText(text: string): void;
  getText(): string;
};
type ToolSchema = Parameters<typeof Check>[0];
type TestResult = {
  details: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
  systemPrompt?: string;
  [key: string]: unknown;
};
type TestTool = {
  name: string;
  description: string;
  parameters: ToolSchema;
  renderCall(...args: unknown[]): TestRenderable;
  renderResult(...args: unknown[]): TestRenderable;
  execute(...args: unknown[]): Promise<TestResult>;
};
type TestCommand = {
  description?: string;
  getArgumentCompletions?: unknown;
  handler(args: string, ctx: unknown): unknown | Promise<unknown>;
};
type SourceInfo = { path: string; source: string; baseDir: string };
type TestEntry = { [key: string]: unknown };
type TestGoalState = {
  status: string;
  objective?: string;
  result: string;
  resumeAfterManualCompaction?: boolean;
  [key: string]: unknown;
};
type TestEntryData = {
  state: TestGoalState;
  event?: string;
  [key: string]: unknown;
};
type TestAppendedEntry = { type: string; customType: string; data: TestEntryData };
type RequiredArray<T> = Omit<T[], "at"> & { at(index: number): T };
type TestSentMessage = {
  message: { customType: string; content: string; display?: boolean; [key: string]: unknown };
  options: unknown;
};
type TestRenderer = (...args: unknown[]) => TestRenderable;
type TestCapturedFactory = (...args: unknown[]) => TestRenderable;
type CompletionItem = { label: string; description: string; [key: string]: unknown };
type CompletionResult = { prefix: string; items: CompletionItem[] };
type TestProvider = {
  applyCompletion(
    lines: string[],
    lineIndex: number,
    cursorColumn: number,
    item: CompletionItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  getSuggestions(
    lines: string[],
    lineIndex: number,
    cursorColumn: number,
    signal: unknown,
  ): Promise<CompletionResult>;
  shouldTriggerFileCompletion(): boolean;
  [key: string]: unknown;
};
type RequiredRegistry<T> = Omit<Map<string, T>, "get"> & { get(key: string): T };
type Captured = {
  autocompleteFactory: (current: unknown) => TestProvider;
  currentEditorFactory: unknown;
  editorFactory: TestCapturedFactory;
  footerFactory: TestCapturedFactory;
  goalPanel: { title: string; options: unknown };
  headerFactory: TestCapturedFactory;
  hiddenThinkingLabel?: string;
  selection: { title: string; options: string[] };
  statuses?: Map<string, string>;
  themeName?: string;
  titles?: string[];
  widgetComponent?: unknown;
  widgets?: Array<{ key: string; content: unknown; options: unknown }>;
  workingIndicator?: unknown;
  workingMessages: RequiredArray<string | undefined>;
};
type TestTui = { requestRender(): void; terminal: { rows: number } };
type TestModel = {
  id: string;
  name?: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string>;
  contextWindow?: number;
  [key: string]: unknown;
};
type TestSessionManager = {
  getBranch(): TestEntry[];
  getEntries(): TestEntry[];
  getSessionFile(): string;
};
type TestTuiContext = {
  abort(): void;
  cwd: string;
  getContextUsage(): { tokens: number | null; contextWindow: number };
  hasPendingMessages(): boolean;
  hasUI: boolean;
  isIdle(): boolean;
  isProjectTrusted(): boolean;
  mode: string;
  model: TestModel;
  reload(): Promise<void>;
  sessionManager: TestSessionManager;
  ui: {
    addAutocompleteProvider(factory: unknown): void;
    confirm(...args: unknown[]): Promise<boolean>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    getEditorComponent(): unknown;
    notify(message: string, level?: string): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    setEditorComponent(factory: unknown): void;
    setFooter(factory: TestCapturedFactory): void;
    setHeader(factory: TestCapturedFactory): void;
    setStatus(key: string, text?: string): void;
    setTheme(name: string): { success: boolean };
    setTitle(title: string): void;
    setHiddenThinkingLabel(label: string): void;
    setWorkingIndicator(options: unknown): void;
    setWorkingMessage(message?: string): void;
    setWidget(key: string, content?: unknown, options?: unknown): void;
    theme: Theme;
  };
  waitForIdle(): Promise<void>;
};
type VariantsContext = {
  mode: "tui";
  model: TestModel;
  ui: {
    custom(factory: (...args: unknown[]) => unknown): Promise<unknown>;
    notify(message: string, level?: string): void;
  };
};
type TestAPI = {
  appendEntry(customType: string, data: TestEntryData): void;
  getAllTools(): Array<TestTool & { sourceInfo: SourceInfo }>;
  getCommands(): Array<{ name: string; description?: string; source: string; sourceInfo: SourceInfo }>;
  getSessionName(): undefined;
  getThinkingLevel(): string;
  on(event: string, handler: TestHandler): void;
  registerCommand(name: string, command: TestCommand): void;
  registerEntryRenderer(customType: string, renderer: TestRenderer): void;
  registerTool(tool: TestTool): void;
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(message: unknown, options?: unknown): void;
  setThinkingLevel(level: string): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
};
type HookSpawner = Parameters<typeof executeHook>[4];
type Harness = {
  api: TestAPI;
  activeTools: string[];
  appendedEntries: RequiredArray<TestAppendedEntry>;
  commandRegistrations: string[];
  commands: RequiredRegistry<TestCommand>;
  entryRenderers: RequiredRegistry<TestRenderer>;
  handlers: RequiredRegistry<TestHandler[]>;
  sentMessages: TestSentMessage[];
  sentUserMessages: Array<{ message: unknown; options: unknown }>;
  tools: RequiredRegistry<TestTool>;
};

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson).version;
initTheme("dark", false);

const theme = {
  bold(text: string): string { return text; },
  fg(_color: string, text: string): string { return text; },
  italic(text: string): string { return text; },
  strikethrough(text: string): string { return text; },
  underline(text: string): string { return text; },
} as unknown as Theme;

function usage(cost: number): TestUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

/** Builds a valid handoff document for command-seam tests. */
function createCompleteHandoffSummary(objective: string, focus = ""): string {
  return [
    "## Objective",
    objective,
    "",
    "## Current state",
    focus || "Resume the saved work.",
    "",
    "## Decisions",
    "Keep the current approach.",
    "",
    "## Constraints",
    "Keep the source session unchanged.",
    "",
    "## Completed work",
    "Prior work is recorded in the source session.",
    "",
    "## Relevant artifacts",
    "Reference the existing plan.",
    "",
    "## Verification",
    "No new verification has run.",
    "",
    "## Blockers or open questions",
    "None.",
    "",
    "## Exact next action",
    "Inspect the existing plan.",
    "",
    "## Suggested skills",
    "No installed skill is required.",
  ].join("\n");
}

/** Creates the durable Goal truth needed to exercise a handoff availability check. */
function createGoalState(status: GoalStatus): GoalState {
  return {
    version: 1,
    revision: 1,
    objective: "Test handoff availability",
    status,
    createdAt: 0,
    updatedAt: 0,
    activeMilliseconds: 0,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  };
}

function createHarness(): Harness {
  const commands = new Map<string, TestCommand>() as RequiredRegistry<TestCommand>;
  const commandRegistrations: string[] = [];
  const handlers = new Map<string, TestHandler[]>() as RequiredRegistry<TestHandler[]>;
  const tools = new Map<string, TestTool>() as RequiredRegistry<TestTool>;
  const entryRenderers = new Map<string, TestRenderer>() as RequiredRegistry<TestRenderer>;
  const appendedEntries = [] as unknown as RequiredArray<TestAppendedEntry>;
  const sentMessages: TestSentMessage[] = [];
  const sentUserMessages: Array<{ message: unknown; options: unknown }> = [];
  const activeTools: string[] = [];
  const sourceInfo: SourceInfo = {
    path: `${process.cwd()}/Killeros.ts`,
    source: "npm:killeros",
    baseDir: process.cwd(),
  };
  const api: TestAPI = {
    appendEntry: (customType: string, data: TestEntryData) => {
      appendedEntries.push({ type: "custom", customType, data });
    },
    getAllTools: () => [...tools.values()].map((tool) => ({
      ...tool,
      sourceInfo,
    })),
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
    registerCommand: (name: string, command: TestCommand) => {
      commandRegistrations.push(name);
      commands.set(name, command);
    },
    registerEntryRenderer: (customType: string, renderer: TestRenderer) => { entryRenderers.set(customType, renderer); },
    registerTool: (tool: TestTool) => { tools.set(tool.name, tool); },
    sendMessage: (message: unknown, options?: unknown) => sentMessages.push({
      message: message as TestSentMessage["message"],
      options,
    }),
    sendUserMessage: (message: unknown, options?: unknown) => sentUserMessages.push({ message, options }),
    setThinkingLevel: (_level: string) => {},
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
  return { api, activeTools, appendedEntries, commandRegistrations, commands, entryRenderers, handlers, sentMessages, sentUserMessages, tools };
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

function last<T>(values: T[]): T {
  const value = values.at(-1);
  assert.ok(value);
  return value;
}

async function startVariants({
  terminalRows = 40,
  current = "high",
  keybindings = getKeybindings(),
}: {
  terminalRows?: number;
  current?: string;
  keybindings?: ReturnType<typeof getKeybindings>;
} = {}) {
  const harness = createHarness();
  const selectedLevels: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const tui: TestTui = { requestRender() {}, terminal: { rows: terminalRows } };
  let component: TestRenderable | undefined;
  harness.api.getThinkingLevel = () => current;
  harness.api.setThinkingLevel = (level: string) => { selectedLevels.push(level); };
  const ctx: VariantsContext = {
    mode: "tui",
    model: {
      provider: "test",
      id: "reasoner",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        component = factory(tui, theme, keybindings, resolve) as TestRenderable;
      }),
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
    },
  };
  const result = getCommand(harness, "variants").handler("", ctx);
  assert.ok(component);
  return { ...harness, component, notifications, result, selectedLevels, tui };
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

test("/codex-fast is registered once and toggles Codex priority requests", async () => {
  resetCodexFastState();
  const harness = createHarness();
  assert.equal(harness.commandRegistrations.filter((name) => name === "codex-fast").length, 1);

  const notifications = [] as unknown as RequiredArray<TestNotification>;
  const { ctx } = createTuiContext();
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  const command = harness.commands.get("codex-fast");
  assert.ok(command);
  assert.equal(command.getArgumentCompletions, undefined);

  const requestHandler = harness.handlers.get("before_provider_request")?.at(-1);
  assert.ok(requestHandler);
  const payload = { model: "gpt-5.5", input: [] };
  const codexContext = { ...ctx, model: { ...ctx.model, provider: "openai-codex" } };
  assert.strictEqual(await requestHandler({ type: "before_provider_request", payload }, codexContext), payload);

  await command.handler("", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Fast enabled", level: "info" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  const nonCodexPayload = { model: "gpt-5.5", input: [] };
  assert.strictEqual(
    await requestHandler({ type: "before_provider_request", payload: nonCodexPayload }, {
      ...ctx,
      model: { ...ctx.model, provider: "openai" },
    }),
    nonCodexPayload,
  );

  await command.handler("", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Fast disabled", level: "info" });
  assert.strictEqual(await requestHandler({ type: "before_provider_request", payload }, codexContext), payload);

  ctx.mode = "rpc";
  await command.handler("", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Fast enabled", level: "info" });
});

test("/codex-fast rejects arguments without changing its state", async () => {
  resetCodexFastState();
  const harness = createHarness();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  const { ctx } = createTuiContext();
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  const command = harness.commands.get("codex-fast");
  const requestHandler = harness.handlers.get("before_provider_request")?.at(-1);
  assert.ok(command);
  assert.ok(requestHandler);

  const payload = { model: "gpt-5.5", input: [] };
  const codexContext = { ...ctx, model: { ...ctx.model, provider: "openai-codex" } };
  await command.handler("", ctx);
  await command.handler("status", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Usage: /codex-fast", level: "error" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  await command.handler("off now", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Usage: /codex-fast", level: "error" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );
});

test("/codex-fast state survives extension reloads and renders inline for Codex", async () => {
  resetCodexFastState();
  const first = createHarness();
  const firstContext = createTuiContext().ctx;
  const sessionManager = firstContext.sessionManager;
  firstContext.model = { ...firstContext.model, provider: "openai-codex" };
  await first.commands.get("codex-fast").handler("", firstContext);

  const second = createHarness();
  const { captured, ctx, tui } = createTuiContext([], theme, sessionManager);
  ctx.model = { ...ctx.model, provider: "openai-codex" };
  const requestHandler = second.handlers.get("before_provider_request")?.at(-1);
  assert.ok(requestHandler);
  const payload = { model: "gpt-5.5", input: [] };
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, ctx),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  for (const handler of second.handlers.get("session_start") ?? []) await handler({}, ctx);
  assert.equal(captured.statuses?.size ?? 0, 0);
  const semanticTheme: TestStyle = {
    ...theme,
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (color: string, text: string) => color === "accent" ? `<accent>${text}</accent>` : text,
  } as unknown as Theme;
  const footer = captured.footerFactory(tui, semanticTheme, {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  });
  const enabledRender = footer.render(120).join("\n");
  assert.match(enabledRender, /Test model.*Fast.*OpenAI/u);
  assert.match(enabledRender, /<accent><bold>Fast<\/bold><\/accent>/u);
  assert.equal(footer.render(120).length, 3);

  for (const handler of second.handlers.get("model_select") ?? []) {
    handler({ model: { ...ctx.model, provider: "openai" } });
  }
  assert.doesNotMatch(footer.render(120).join("\n"), /Fast/u);

  for (const handler of second.handlers.get("model_select") ?? []) {
    handler({ model: { ...ctx.model, provider: "openai-codex" } });
  }
  assert.match(footer.render(120).join("\n"), /Test model.*Fast.*OpenAI/u);
  footer.dispose();
  resetCodexFastState();
});

test("question exposes a Google-compatible optional selection mode", () => {
  const tool = getTool(createHarness(), "question");
  const schema = JSON.parse(JSON.stringify(tool.parameters));

  assert.deepEqual(schema.properties.mode, {
    type: "string",
    enum: ["single", "multiple"],
    description: "Choose one answer or multiple answers; defaults to single",
  });
  assert.equal(Check(tool.parameters, { question: "Choose", options: [{ label: "Alpha" }] }), true);
  assert.equal(Check(tool.parameters, {
    question: "Choose", options: [{ label: "Alpha" }], mode: "single", minSelections: 1, maxSelections: 1,
  }), true);
  assert.equal(Check(tool.parameters, {
    question: "Choose", options: [{ label: "Alpha" }], mode: "multiple", minSelections: 1, maxSelections: 2,
  }), true);
  assert.equal(Check(tool.parameters, { question: "Choose", options: [{ label: "Alpha" }], mode: "ranked" }), false);
});

test("question accepts omitted or explicit 1/1 single-select bounds before rendering and execution", async () => {
  const tool = getTool(createHarness(), "question");
  const acceptedBounds = [
    {},
    { mode: "single" },
    { minSelections: 1, maxSelections: 1 },
    { mode: "single", minSelections: 1, maxSelections: 1 },
  ];
  let opened = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: () => {
        opened += 1;
        return Promise.resolve({ kind: "cancelled" });
      },
      notify: () => {},
    },
  };

  for (const extra of acceptedBounds) {
    const params = { question: "Choose", options: [{ label: "Alpha" }], ...extra };
    const rendered = tool.renderCall(params, theme, { expanded: false }).render(80).join("\n");
    assert.doesNotMatch(rendered, /multi-select|\[ \]/iu);
    const result = await tool.execute("question-bounds", params, new AbortController().signal, () => {}, ctx);
    assert.equal("mode" in result.details, false);
  }
  assert.equal(opened, acceptedBounds.length);
});

test("/variants validates direct levels and model support", async () => {
  const { api, commands } = createHarness();
  const selectedLevels: string[] = [];
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  api.setThinkingLevel = (level) => selectedLevels.push(level);
  const ctx = {
    mode: "tui",
    model: { provider: "test", id: "reasoner", reasoning: true },
    ui: {
      custom: () => { throw new Error("direct variants must not open the selector"); },
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  };
  const variants = commands.get("variants");

  await variants.handler("deep", ctx);
  await variants.handler("xhigh", ctx);
  await variants.handler("unknown", ctx);

  assert.deepEqual(selectedLevels, ["high"]);
  assert.match(notifications[0].message, /Thinking: High/u);
  assert.match(notifications[1].message, /Extra High is not supported/u);
  assert.match(notifications[2].message, /Unknown reasoning level/u);

  await variants.handler("", { ...ctx, model: { provider: "test", id: "plain", reasoning: false } });
  assert.match(notifications[3].message, /does not support extended reasoning/u);

  await variants.handler("", { ...ctx, mode: "rpc" });
  assert.match(notifications[4].message, /Use \/variants <level> outside TUI mode/u);
});

test("/variants initially focuses the current level and submits it", async () => {
  const variants = await startVariants({ current: "high" });
  const rendered = variants.component.render(80).join("\n");

  assert.match(rendered, /→ High ← current/u);
  variants.component.handleInput("\r");
  await variants.result;
  assert.deepEqual(variants.selectedLevels, ["high"]);
});

test("/variants stays within terminal bounds and preserves focus across resizes", async () => {
  const variants = await startVariants({ current: "high" });
  variants.component.handleInput("\x1B[B");

  for (const rows of [12, 8, 7, 4, 3, 2, 1, 0]) {
    variants.tui.terminal.rows = rows;
    const rendered = variants.component.render(24);
    assert.ok(rendered.length <= rows, `${rendered.length} rows rendered into a ${rows}-row terminal`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 24));
  }

  variants.tui.terminal.rows = 12;
  const fullLayout = variants.component.render(24);
  assert.equal(fullLayout.length, 12);
  assert.match(fullLayout.join("\n"), /→ Extra High/u);
  assert.match(fullLayout.at(-1) ?? "", /^─+$/u);
  assert.deepEqual(variants.component.render(0), []);
  variants.component.handleInput("\r");
  await variants.result;
  assert.deepEqual(variants.selectedLevels, ["xhigh"]);
});

test("/variants follows remapped selector bindings and cancellation", async () => {
  const previous = getKeybindings();
  const remapped = new TuiKeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.up": "ctrl+p",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+g",
  });
  setKeybindings(remapped);
  try {
    const variants = await startVariants({ current: "high", keybindings: remapped });
    variants.component.handleInput("\x1B[B");
    assert.match(variants.component.render(80).join("\n"), /→ High ← current/u);
    variants.component.handleInput("\x0E");
    const rendered = variants.component.render(80).join("\n");
    assert.match(rendered, /→ Extra High/u);
    assert.match(rendered, /ctrl\+p.*ctrl\+n/u);
    variants.component.handleInput("\x07");
    await variants.result;
    assert.deepEqual(variants.selectedLevels, []);
  } finally {
    setKeybindings(previous);
  }
});

test("question rejects every other single-select bound before rendering and execution", async () => {
  const tool = createHarness().tools.get("question");
  const invalidBounds = [
    { minSelections: 1 },
    { maxSelections: 1 },
    { minSelections: 1, maxSelections: 2 },
    { mode: "single", minSelections: 2, maxSelections: 2 },
  ];
  let opened = false;
  const ctx = {
    mode: "tui",
    ui: {
      custom: () => {
        opened = true;
        throw new Error("UI must not open for invalid bounds");
      },
      notify: () => {},
    },
  };

  for (const extra of invalidBounds) {
    const params = { question: "Choose", options: [{ label: "Alpha" }], ...extra };
    assert.throws(
      () => tool.renderCall(params, theme, { expanded: false }),
      /single-select.*omitted or both be 1/iu,
    );
    await assert.rejects(
      tool.execute("question-bounds", params, new AbortController().signal, () => {}, ctx),
      /single-select.*omitted or both be 1/iu,
    );
  }
  assert.equal(opened, false);
});

test("question retains multiple-select bound validation before rendering and execution", async () => {
  const tool = createHarness().tools.get("question");
  const ctx = { mode: "tui", ui: { custom: () => { throw new Error("UI must not open for invalid bounds"); }, notify: () => {} } };
  const invalidBounds = [
    { mode: "multiple", minSelections: 2, maxSelections: 1, error: /minimum.*maximum/iu },
    { mode: "multiple", maxSelections: 3, error: /at most 2 selections/iu },
  ];

  for (const { error, ...extra } of invalidBounds) {
    const params = { question: "Choose", options: [{ label: "Alpha" }], ...extra };
    assert.throws(() => tool.renderCall(params, theme, { expanded: false }), error);
    await assert.rejects(
      tool.execute("question-bounds", params, new AbortController().signal, () => {}, ctx),
      error,
    );
  }
});

test("goal updates use a Google-compatible status enum", () => {
  const tool = createHarness().tools.get("killeros_goal_update");
  const schema = JSON.parse(JSON.stringify(tool.parameters));

  assert.deepEqual(schema.properties.status, {
    type: "string",
    enum: ["complete", "blocked"],
    description: "Mark the active goal complete or blocked",
  });
  for (const status of ["complete", "blocked"]) {
    assert.equal(Check(tool.parameters, { status, evidence: "verified" }), true, status);
  }
  for (const status of ["active", "paused", "Complete", "", null, 0]) {
    assert.equal(Check(tool.parameters, { status, evidence: "verified" }), false, String(status));
  }
});

async function emitSequentially(
  handlers: TestHandler[] | undefined,
  event: TestEvent,
  ctx: unknown,
): Promise<TestHandlerResult[]> {
  const results: TestHandlerResult[] = [];
  for (const handler of handlers ?? []) {
    const result = await handler(event, ctx);
    results.push(result);
    if (typeof result === "object" && result !== null && "block" in result && result.block === true) break;
  }
  return results;
}

function resultReason(results: TestHandlerResult[]): string {
  const result = results.find((candidate) => candidate?.block);
  const reason = result?.reason;
  assert.ok(reason);
  return reason;
}

const validGeneratedGuidance = `# AGENTS.md

## 1. Think Before Coding
Check facts before changing code.

## 2. Simplicity First
Use the smallest complete change.

## 3. Surgical Changes
Touch only files required by the task.

## 4. Goal-Driven Execution
Define and run exact verification.
`;

async function emitSuccessfulInitWrite(
  handlers: Map<string, TestHandler[]>,
  tools: RequiredRegistry<TestTool>,
  ctx: unknown,
  content: string = validGeneratedGuidance,
  toolCallId = "init-write",
): Promise<void> {
  const input = { content };
  const callResults = await emitSequentially(handlers.get("tool_call"), {
    toolCallId,
    toolName: "killeros_init_write",
    input,
  }, ctx);
  assert.equal(callResults.some((result) => (
    typeof result === "object" && result !== null && "block" in result && result.block === true
  )), false);
  await getTool({ tools } as Harness, "killeros_init_write").execute(
    toolCallId,
    input,
    new AbortController().signal,
    () => {},
    ctx,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for asynchronous test state");
}

async function removeDirectoryEventually(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EPERM", "EBUSY"].includes(String(error.code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  rmSync(directory, { recursive: true, force: true });
}

async function emitGoalStart(handlers: Map<string, TestHandler[]>, ctx: unknown): Promise<void> {
  for (const handler of handlers.get("before_agent_start") ?? []) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
}

function createFileSymlinkOrSkip(t: TestContext, target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EACCES", "EPERM"].includes(String(error.code))) {
      t.skip("file symlinks are unavailable in this environment");
      return false;
    }
    throw error;
  }
}

function createTuiContext(
  entries: TestEntry[] = [],
  uiTheme: Theme = theme,
  sessionManager: TestSessionManager = {
  getBranch: () => entries,
  getEntries: () => entries,
  getSessionFile: () => path.join(process.cwd(), "session.jsonl"),
  },
): { captured: Captured; ctx: TestTuiContext; tui: TestTui } {
  const captured = {} as Captured;
  const tui: TestTui = { requestRender() {}, terminal: { rows: 40 } };
  const ctx: TestTuiContext = {
    abort() {},
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
    reload: async () => {},
    sessionManager,
    ui: {
      addAutocompleteProvider: (factory: unknown) => {
        captured.autocompleteFactory = factory as (current: unknown) => TestProvider;
      },
      confirm: async () => true,
      editor: async (_title: string, prefill?: string) => prefill,
      notify() {},
      select: async (title: string, options: string[]) => {
        captured.selection = { title, options };
        return undefined;
      },
      getEditorComponent: () => captured.currentEditorFactory,
      setEditorComponent: (factory: unknown) => {
        captured.editorFactory = factory as TestCapturedFactory;
        captured.currentEditorFactory = factory;
      },
      setFooter: (factory: TestCapturedFactory) => { captured.footerFactory = factory; },
      setStatus: (key: string, text?: string) => {
        captured.statuses ??= new Map();
        if (text === undefined) captured.statuses.delete(key);
        else captured.statuses.set(key, text);
      },
      setHeader: (factory: TestCapturedFactory) => { captured.headerFactory = factory; },
      setTitle: (title: string) => {
        captured.titles ??= [];
        captured.titles.push(title);
      },
      setTheme: (name: string) => {
        captured.themeName = name;
        return { success: true };
      },
      setHiddenThinkingLabel: (label: string) => { captured.hiddenThinkingLabel = label; },
      setWorkingIndicator: (options: unknown) => { captured.workingIndicator = options; },
      setWorkingMessage: (message?: string) => {
        captured.workingMessages ??= [] as unknown as RequiredArray<string | undefined>;
        captured.workingMessages.push(message);
      },
      setWidget: (key: string, content?: unknown, options?: unknown) => {
        captured.widgets ??= [];
        captured.widgets.push({ key, content, options });
        if (typeof content === "function") {
          captured.widgetComponent = (content as (tui: TestTui, theme: Theme) => unknown)(tui, uiTheme);
        }
        if (content === undefined) captured.widgetComponent = undefined;
      },
      theme: uiTheme,
    },
    waitForIdle: async () => {},
  };
  return { captured, ctx, tui };
}

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

test("BoundedText limits collapsed rows and preserves full expanded text", () => {
  const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const collapsed = new BoundedText(source, 3).render(20);
  assert.equal(collapsed.length, 3);
  assert.match(collapsed.at(-1) ?? "", /…/u);

  const expanded = new BoundedText(source).render(20);
  assert.equal(expanded.length, 20);
  assert.match(expanded.at(-1) ?? "", /line 20/u);
});

function startQuestion(
  tool: TestTool,
  options: QuestionOption[] = [{ label: "Alpha" }],
  questionText = "Choose",
  terminalRows = 40,
  keybindings = getKeybindings(),
  extraParams: Record<string, unknown> = {},
): {
  component: TestRenderable;
  finish: (value: unknown) => void;
  result: Promise<TestResult>;
  notifications: RequiredArray<TestNotification>;
  tui: TestTui;
} {
  let component: TestRenderable | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  const tui: TestTui = { requestRender() {}, terminal: { rows: terminalRows } };
  const ctx = {
    mode: "tui" as const,
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise((resolve) => {
        finish = resolve;
        component = factory(tui, theme, keybindings, resolve) as TestRenderable;
      }),
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  };
  const result = tool.execute(
    "question-test",
    { question: questionText, options, ...extraParams },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.ok(component);
  assert.ok(finish);
  return { component, finish, result, notifications, tui };
}

test("uses one neutral background for every tool state", () => {
  const killerosTheme = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8")) as ThemeJson;
  assert.equal(killerosTheme.colors.toolPendingBg, "surface");
  assert.equal(killerosTheme.colors.toolSuccessBg, "surface");
  assert.equal(killerosTheme.colors.toolErrorBg, "surface");
});

test("uses achromatic neutrals without changing the coral accent", () => {
  const killerosTheme = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8")) as ThemeJson;
  assert.equal(killerosTheme.vars.coral, "#d77757");
  assert.equal(killerosTheme.vars.coralBright, "#e58b6d");

  for (const name of ["canvas", "surface", "surfaceRaised", "line", "lineMuted", "text", "muted", "dim"]) {
    const match = /^#(..)(..)(..)$/.exec(killerosTheme.vars[name]);
    assert.ok(match);
    const [, red, green, blue] = match;
    assert.equal(red, green, `${name} must not have a color cast`);
    assert.equal(green, blue, `${name} must not have a color cast`);
  }
});

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("reasoning text meets normal-text contrast on KillerOS surfaces", () => {
  const killerosTheme = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8")) as ThemeJson;
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

  const calls: string[] = [];
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

test("/clear confirms before aborting and waits before creating a session", async () => {
  const { commands } = createHarness();
  const calls: string[] = [];
  let releaseIdle: () => void = () => {};
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  const run = commands.get("clear").handler("", {
    hasUI: true,
    isIdle: () => false,
    abort: () => calls.push("abort"),
    waitForIdle: async () => { calls.push("wait"); await idle; },
    newSession: async () => { calls.push("new"); return { cancelled: false }; },
    ui: { confirm: async () => { calls.push("confirm"); return true; } },
  });
  await waitFor(() => calls.includes("wait"));
  assert.deepEqual(calls, ["confirm", "abort", "wait"]);
  releaseIdle();
  await run;
  assert.deepEqual(calls, ["confirm", "abort", "wait", "new"]);

  calls.length = 0;
  await commands.get("clear").handler("", {
    hasUI: true,
    isIdle: () => false,
    abort: () => calls.push("abort"),
    waitForIdle: async () => calls.push("wait"),
    newSession: async () => calls.push("new"),
    ui: { confirm: async () => false },
  });
  assert.deepEqual(calls, []);
});

test("/handoff refuses unavailable work without side effects", async () => {
  const unavailable = [
    { label: "running agent", isIdle: () => false, hasPendingMessages: () => false, goalStatus: "paused" },
    { label: "queued message", isIdle: () => true, hasPendingMessages: () => true, goalStatus: "paused" },
  ] as const;

  for (const testCase of unavailable) {
    const { commands } = createHarness();
    const calls: string[] = [];
    const notifications: TestNotification[] = [];
    await commands.get("handoff").handler("finish verification", {
      isIdle: testCase.isIdle,
      hasPendingMessages: testCase.hasPendingMessages,
      abort: () => calls.push("abort"),
      waitForIdle: async () => calls.push("wait"),
      compact: () => calls.push("compact"),
      model: { id: "test-model", provider: "test" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => { calls.push("auth"); return { ok: true }; },
        complete: async () => { calls.push("complete"); return { content: [] }; },
      },
      sessionManager: {
        getSessionFile: () => "source.jsonl",
        buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
      },
      newSession: async () => { calls.push("new"); return { cancelled: false }; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      getSystemPromptOptions: () => ({ cwd: process.cwd() }),
    });
    assert.deepEqual(notifications, [{
      message: "/handoff is not available while an agent or /goal is running.",
      level: "error",
    }], testCase.label);
    assert.deepEqual(calls, [], testCase.label);
  }

  const { commands } = createHarness();
  await commands.get("goal").handler("Keep working", createTuiContext().ctx);
  const calls: string[] = [];
  const notifications: TestNotification[] = [];
  await commands.get("handoff").handler("", {
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => calls.push("abort"),
    waitForIdle: async () => calls.push("wait"),
    compact: () => calls.push("compact"),
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => { calls.push("auth"); return { ok: true }; },
      complete: async () => { calls.push("complete"); return { content: [] }; },
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async () => { calls.push("new"); return { cancelled: false }; },
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });
  assert.deepEqual(notifications, [{
    message: "/handoff is not available while an agent or /goal is running.",
    level: "error",
  }]);
  assert.deepEqual(calls, []);
});

test("/handoff allows paused, blocked, and complete Goal truth", async () => {
  for (const status of ["paused", "blocked", "complete"] as const) {
    const commands = new Map<string, TestCommand>() as RequiredRegistry<TestCommand>;
    const goalRuntime = createGoalRuntime();
    goalRuntime.state = createGoalState(status);
    registerHandoff({
      registerCommand: (name: string, command: TestCommand) => commands.set(name, command),
    } as unknown as ExtensionAPI, goalRuntime);

    const notifications: TestNotification[] = [];
    await commands.get("handoff").handler("", {
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionFile: () => undefined },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    });
    assert.deepEqual(notifications, [{ message: "Handoff requires a saved session", level: "error" }], status);
  }
});

test("/handoff owns TUI input while generating the summary", async () => {
  const { commands } = createHarness();
  const summary = createCompleteHandoffSummary("Finish the release checks.");
  let customViews = 0;
  let completionSignal: AbortSignal | undefined;
  let renderedLoader: TestRenderable | undefined;

  await commands.get("handoff").handler("", {
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
        completionSignal = options.signal;
        return { content: [{ type: "text", text: summary }], stopReason: "stop" };
      },
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async (options: {
      setup?: (sessionManager: {
        appendCustomMessageEntry(customType: string, content: string, display: boolean): void;
        appendSessionInfo(name: string): void;
      }) => Promise<void>;
      withSession?: (destination: { ui: { notify(message: string, level?: string): void } }) => Promise<void>;
    }) => {
      await options.setup?.({ appendCustomMessageEntry() {}, appendSessionInfo() {} });
      await options.withSession?.({ ui: { notify() {} } });
      return { cancelled: false };
    },
    ui: {
      custom: async <T>(factory: (...args: unknown[]) => unknown): Promise<T> => {
        customViews += 1;
        return await new Promise<T>((resolve) => {
          const done = (result: T): void => {
            renderedLoader?.dispose();
            resolve(result);
          };
          renderedLoader = factory(
            { requestRender() {} },
            theme,
            {},
            done,
          ) as TestRenderable;
        });
      },
      notify() {},
    },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });

  assert.equal(customViews, 1);
  assert.match(renderedLoader?.render(80).join("\n") ?? "", /Generating handoff/iu);
  assert.ok(completionSignal instanceof AbortSignal);
});

test("/handoff cancels its TUI generation without replacing the session", async () => {
  const { commands } = createHarness();
  const notifications: TestNotification[] = [];
  let completionSignal: AbortSignal | undefined;
  let newSessions = 0;

  await commands.get("handoff").handler("", {
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
        completionSignal = options.signal;
        return await new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => resolve({ content: [], stopReason: "aborted" }), { once: true });
        });
      },
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async () => {
      newSessions += 1;
      return { cancelled: false };
    },
    ui: {
      custom: async <T>(factory: (...args: unknown[]) => unknown): Promise<T> => {
        return await new Promise<T>((resolve) => {
          let component: TestRenderable | undefined;
          const done = (result: T): void => {
            component?.dispose();
            resolve(result);
          };
          component = factory({ requestRender() {} }, theme, {}, done) as TestRenderable;
          setImmediate(() => component?.handleInput("\x1B"));
        });
      },
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });

  assert.equal(completionSignal?.aborted, true);
  assert.equal(newSessions, 0);
  assert.deepEqual(notifications, [{ message: "Handoff cancelled", level: "info" }]);
});

test("/handoff cancellation during authentication never starts a completion", async () => {
  const { commands } = createHarness();
  let resolveAuth: ((auth: { ok: true }) => void) | undefined;
  let completions = 0;
  let newSessions = 0;
  const auth = new Promise<{ ok: true }>((resolve) => {
    resolveAuth = resolve;
  });

  await commands.get("handoff").handler("", {
    mode: "tui",
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => await auth,
      complete: async () => {
        completions += 1;
        return { content: [], stopReason: "aborted" };
      },
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async () => {
      newSessions += 1;
      return { cancelled: false };
    },
    ui: {
      custom: async <T>(factory: (...args: unknown[]) => unknown): Promise<T> => {
        return await new Promise<T>((resolve) => {
          let component: TestRenderable | undefined;
          const done = (result: T): void => {
            component?.dispose();
            resolve(result);
          };
          component = factory({ requestRender() {} }, theme, {}, done) as TestRenderable;
          component.handleInput("\x1B");
        });
      },
      notify() {},
    },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });

  resolveAuth?.({ ok: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completions, 0);
  assert.equal(newSessions, 0);
});

test("/handoff creates an idle child session with a visible summary", async () => {
  const { commands } = createHarness();
  const sourceName = "Release work with a name that is intentionally longer than sixty characters for session naming";
  const destinationNotifications: TestNotification[] = [];
  const oldRawHistory = "OLD RAW HISTORY THAT MUST NOT REACH THE HANDOFF REQUEST";
  const projectedEntries = [
    {
      type: "compaction",
      id: "compaction",
      parentId: "old-message",
      timestamp: "2026-08-23T00:00:00.000Z",
      summary: "Compaction projection: release validation is the current work.",
      firstKeptEntryId: "retained-message",
      tokensBefore: 4_000,
    },
    {
      type: "branch_summary",
      id: "branch-summary",
      parentId: "compaction",
      timestamp: "2026-08-23T00:01:00.000Z",
      fromId: "other-branch",
      summary: "Branch summary: retain the release specification decision.",
    },
    {
      type: "message",
      id: "retained-message",
      parentId: "branch-summary",
      timestamp: "2026-08-23T00:02:00.000Z",
      message: { role: "user", content: "Implement the command", timestamp: 1 },
    },
  ];
  const completionRequests: Array<{ context: { systemPrompt?: string; messages: unknown[] } }> = [];
  const destinationEntries: Array<{ customType?: string; content?: string; display?: boolean; name?: string }> = [];
  const calls: string[] = [];
  let sourceActive = true;
  let sentMessages = 0;
  let sentUserMessages = 0;
  const summary = createCompleteHandoffSummary("Finish the release checks.", "finish the release checks");

  await commands.get("handoff").handler("finish the release checks", {
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort: () => calls.push("abort"),
    waitForIdle: async () => calls.push("wait"),
    compact: () => calls.push("compact"),
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async (_model: unknown, context: { systemPrompt?: string; messages: unknown[] }) => {
        completionRequests.push({ context });
        return { content: [{ type: "text", text: summary }], stopReason: "stop" };
      },
    },
    sessionManager: {
      getSessionFile: () => "C:/sessions/source.jsonl",
      getSessionName: () => {
        if (!sourceActive) throw new Error("source session is no longer active");
        return sourceName;
      },
      getEntries: () => [{ type: "message", message: { role: "user", content: oldRawHistory, timestamp: 0 } }, ...projectedEntries],
      buildContextEntries: () => projectedEntries,
    },
    newSession: async (options: {
      parentSession?: string;
      setup?: (sessionManager: {
        appendCustomMessageEntry(customType: string, content: string, display: boolean): void;
        appendSessionInfo(name: string): void;
      }) => Promise<void>;
      withSession?: (destination: {
        sendMessage(): Promise<void>;
        sendUserMessage(): Promise<void>;
        ui: { notify(message: string, level?: string): void };
      }) => Promise<void>;
    }) => {
      calls.push("new");
      assert.equal(options.parentSession, "C:/sessions/source.jsonl");
      sourceActive = false;
      await options.setup?.({
        appendCustomMessageEntry: (customType, content, display) => destinationEntries.push({ customType, content, display }),
        appendSessionInfo: (name) => destinationEntries.push({ name }),
      });
      await options.withSession?.({
        sendMessage: async () => { sentMessages += 1; },
        sendUserMessage: async () => { sentUserMessages += 1; },
        ui: { notify: (message, level) => destinationNotifications.push({ message, level }) },
      });
      return { cancelled: false };
    },
    ui: { notify: () => { throw new Error("source notifications are unavailable after replacement"); } },
    getSystemPromptOptions: () => ({
      cwd: process.cwd(),
      skills: [{ name: "code-review", description: "Review a diff", filePath: "skill.md", baseDir: ".", sourceInfo: {} }],
    }),
  });

  assert.equal(completionRequests.length, 1);
  const request = completionRequests[0].context;
  const requestMessage = request.messages[0] as { content: string };
  assert.match(requestMessage.content, /Implement the command/u);
  assert.match(requestMessage.content, /Compaction projection: release validation is the current work/u);
  assert.match(requestMessage.content, /Branch summary: retain the release specification decision/u);
  assert.doesNotMatch(requestMessage.content, /OLD RAW HISTORY THAT MUST NOT REACH THE HANDOFF REQUEST/u);
  assert.match(requestMessage.content, /finish the release checks/u);
  assert.match(requestMessage.content, /code-review: Review a diff/u);
  assert.match(request.systemPrompt ?? "", /reference existing artifacts instead of duplicating them/iu);
  assert.match(request.systemPrompt ?? "", /redact credentials, passwords, personally identifiable information, and other sensitive values/iu);
  assert.deepEqual(calls, ["new"]);
  assert.deepEqual(destinationNotifications, [{ message: "Handoff ready in a new session", level: "info" }]);
  assert.equal(sentMessages, 0);
  assert.equal(sentUserMessages, 0);
  assert.deepEqual(destinationEntries, [
    {
      customType: "killeros-handoff",
      content: `# Handoff\n\n${summary}`,
      display: true,
    },
    { name: `${sourceName} · handoff` },
  ]);
});

test("/handoff derives short unnamed focus and objective fallback names", async () => {
  const longFocus = "Continue the release verification work after the new session has opened and preserve every active constraint";
  const cases = [
    { focus: longFocus, objective: "Recover release verification", expectedBase: [...longFocus].slice(0, 60).join("") },
    { focus: "", objective: "Recover release verification", expectedBase: "Recover release verification" },
  ];

  for (const testCase of cases) {
    const { commands } = createHarness();
    const names: string[] = [];
    const summary = createCompleteHandoffSummary(testCase.objective, testCase.focus);
    await commands.get("handoff").handler(testCase.focus, {
      isIdle: () => true,
      hasPendingMessages: () => false,
      model: { id: "test-model", provider: "test" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async () => ({ content: [{ type: "text", text: summary }], stopReason: "stop" }),
      },
      sessionManager: {
        getSessionFile: () => "source.jsonl",
        getSessionName: () => undefined,
        buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
      },
      newSession: async (options: {
        setup?: (sessionManager: {
          appendCustomMessageEntry(customType: string, content: string, display: boolean): void;
          appendSessionInfo(name: string): void;
        }) => Promise<void>;
        withSession?: (destination: { ui: { notify(message: string, level?: string): void } }) => Promise<void>;
      }) => {
        await options.setup?.({ appendCustomMessageEntry() {}, appendSessionInfo: (name) => names.push(name) });
        await options.withSession?.({ ui: { notify() {} } });
        return { cancelled: false };
      },
      ui: { notify() {} },
      getSystemPromptOptions: () => ({ cwd: process.cwd() }),
    });
    assert.deepEqual(names, [`${testCase.expectedBase} · handoff`]);
  }
});

test("/handoff removes terminal controls from the document and derived session name", async () => {
  const { commands } = createHarness();
  const destinationEntries: Array<{ content?: string; name?: string }> = [];
  const summary = createCompleteHandoffSummary("Recover \x1B[31mrelease\x1B[0m\u0001 verification");

  await commands.get("handoff").handler("", {
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async () => ({ content: [{ type: "text", text: summary }], stopReason: "stop" }),
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async (options: {
      setup?: (sessionManager: {
        appendCustomMessageEntry(customType: string, content: string, display: boolean): void;
        appendSessionInfo(name: string): void;
      }) => Promise<void>;
      withSession?: (destination: { ui: { notify(message: string, level?: string): void } }) => Promise<void>;
    }) => {
      await options.setup?.({
        appendCustomMessageEntry: (_customType, content) => destinationEntries.push({ content }),
        appendSessionInfo: (name) => destinationEntries.push({ name }),
      });
      await options.withSession?.({ ui: { notify() {} } });
      return { cancelled: false };
    },
    ui: { notify() {} },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });

  assert.equal(destinationEntries[0].content?.includes("\x1B"), false);
  assert.equal(destinationEntries[0].content?.includes("\u0001"), false);
  assert.match(destinationEntries[0].content ?? "", /Recover release verification/u);
  assert.deepEqual(destinationEntries[1], { name: "Recover release verification · handoff" });
});

test("/handoff reports destination setup failure without reusing the stale source context", async () => {
  const { commands } = createHarness();
  const destinationNotifications: TestNotification[] = [];
  const sourceNotifications: TestNotification[] = [];
  const summary = createCompleteHandoffSummary("Recover release verification");
  let sourceStale = false;

  await commands.get("handoff").handler("", {
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async () => ({ content: [{ type: "text", text: summary }], stopReason: "stop" }),
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async (options: {
      setup?: (sessionManager: {
        appendCustomMessageEntry(customType: string, content: string, display: boolean): void;
        appendSessionInfo(name: string): void;
      }) => Promise<void>;
      withSession?: (destination: { ui: { notify(message: string, level?: string): void } }) => Promise<void>;
    }) => {
      sourceStale = true;
      await options.setup?.({
        appendCustomMessageEntry: () => { throw new Error("Destination write failed"); },
        appendSessionInfo() {},
      });
      await options.withSession?.({
        ui: { notify: (message, level) => destinationNotifications.push({ message, level }) },
      });
      return { cancelled: false };
    },
    ui: {
      notify: (message: string, level?: string) => {
        if (sourceStale) throw new Error("stale source context");
        sourceNotifications.push({ message, level });
      },
    },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });

  assert.deepEqual(sourceNotifications, []);
  assert.deepEqual(destinationNotifications, [{ message: "Handoff failed: Destination write failed", level: "error" }]);
});

test("/handoff reports session replacement failure while the source context remains valid", async () => {
  const { commands } = createHarness();
  const notifications: TestNotification[] = [];
  const summary = createCompleteHandoffSummary("Recover release verification");

  await commands.get("handoff").handler("", {
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async () => ({ content: [{ type: "text", text: summary }], stopReason: "stop" }),
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async () => { throw new Error("Replacement failed"); },
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });

  assert.deepEqual(notifications, [{ message: "Handoff failed: Replacement failed", level: "error" }]);
});

test("/handoff leaves the source selected when summary or replacement fails", async () => {
  {
    const { commands } = createHarness();
    const notifications: TestNotification[] = [];
    let summaries = 0;
    let newSessions = 0;
    await commands.get("handoff").handler("", {
      isIdle: () => true,
      hasPendingMessages: () => false,
      model: { id: "test-model", provider: "test" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => { summaries += 1; return { ok: true }; },
        complete: async () => { summaries += 1; return { content: [] }; },
      },
      sessionManager: { getSessionFile: () => undefined },
      newSession: async () => { newSessions += 1; return { cancelled: false }; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      getSystemPromptOptions: () => ({ cwd: process.cwd() }),
    });
    assert.deepEqual(notifications, [{ message: "Handoff requires a saved session", level: "error" }]);
    assert.equal(summaries, 0);
    assert.equal(newSessions, 0);
  }

  const emptyHandoffSections = [
    "## Objective",
    "## Current state",
    "## Decisions",
    "## Constraints",
    "## Completed work",
    "## Relevant artifacts",
    "## Verification",
    "## Blockers or open questions",
    "## Exact next action",
    "## Suggested skills",
  ].join("\n\n");
  const cases = [
    { label: "missing model", model: undefined, auth: { ok: true }, completion: undefined, expected: "Handoff failed: No current model is available" },
    { label: "authentication failure", model: { id: "test-model", provider: "test" }, auth: { ok: false, error: "Sign in first" }, completion: undefined, expected: "Handoff failed: Sign in first" },
    { label: "empty usable context", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: undefined, expected: "Handoff failed: No usable session context is available" },
    { label: "empty model response", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: { content: [], stopReason: "stop" }, expected: "Handoff failed: The handoff summary was empty" },
    { label: "incomplete model response", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: { content: [{ type: "text", text: "## Objective\nFinish the release checks." }], stopReason: "stop" }, expected: "Handoff failed: The handoff summary did not contain every required section" },
    { label: "empty required sections", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: { content: [{ type: "text", text: emptyHandoffSections }], stopReason: "stop" }, expected: "Handoff failed: The handoff summary did not contain every required section" },
    { label: "truncated model response", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: { content: [{ type: "text", text: createCompleteHandoffSummary("Finish the release checks.") }], stopReason: "length" }, expected: "Handoff failed: The handoff summary did not finish" },
    { label: "aborted model response", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: { content: [{ type: "text", text: createCompleteHandoffSummary("Finish the release checks.") }], stopReason: "aborted" }, expected: "Handoff failed: The handoff summary did not finish" },
    { label: "model failure", model: { id: "test-model", provider: "test" }, auth: { ok: true }, completion: new Error("\x1b]2;owned\x07\x1b[31mProvider\x1b[0m\0 failed"), expected: "Handoff failed: Provider failed" },
  ] as const;

  for (const testCase of cases) {
    const { commands } = createHarness();
    const notifications: TestNotification[] = [];
    let newSessions = 0;
    let completions = 0;
    await commands.get("handoff").handler("", {
      isIdle: () => true,
      hasPendingMessages: () => false,
      model: testCase.model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => testCase.auth,
        complete: async () => {
          completions += 1;
          if (testCase.completion instanceof Error) throw testCase.completion;
          return testCase.completion ?? { content: [], stopReason: "stop" };
        },
      },
      sessionManager: {
        getSessionFile: () => "source.jsonl",
        getSessionName: () => undefined,
        buildContextEntries: () => testCase.label === "empty usable context"
          ? []
          : [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
      },
      newSession: async () => { newSessions += 1; return { cancelled: false }; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      getSystemPromptOptions: () => ({ cwd: process.cwd() }),
    });
    assert.deepEqual(notifications, [{ message: testCase.expected, level: "error" }], testCase.label);
    assert.equal(newSessions, 0, testCase.label);
    assert.equal(completions, testCase.label === "authentication failure" || testCase.label === "missing model" || testCase.label === "empty usable context" ? 0 : 1, testCase.label);
  }

  const { commands } = createHarness();
  const notifications: TestNotification[] = [];
  const cancelledSummary = createCompleteHandoffSummary("Finish the release checks.");
  await commands.get("handoff").handler("", {
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async () => ({ content: [{ type: "text", text: cancelledSummary }], stopReason: "stop" }),
    },
    sessionManager: {
      getSessionFile: () => "source.jsonl",
      getSessionName: () => undefined,
      buildContextEntries: () => [{ type: "message", message: { role: "user", content: "source", timestamp: 0 } }],
    },
    newSession: async () => ({ cancelled: true }),
    ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    getSystemPromptOptions: () => ({ cwd: process.cwd() }),
  });
  assert.deepEqual(notifications, []);
});

test("registers /goal and completes only through the model goal tool", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  assert.equal(commands.has("goal"), true);
  assert.equal(tools.has("killeros_goal_update"), true);

  await commands.get("goal").handler("Ship only after every release check passes", ctx);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message.customType, "killeros-goal-continuation");
  assert.match(sentMessages[0].message.content, /Ship only after every release check passes/u);
  assert.match(sentMessages[0].message.content, /killeros_goal_update/u);
  assert.match(sentMessages[0].message.content, /exact objective above from \/goal/u);
  assert.match(sentMessages[0].message.content, /first concrete next step/u);
  assert.match(sentMessages[0].message.content, /checking the current repository state/u);
  assert.doesNotMatch(sentMessages[0].message.content, /hidden handoff|stored progress copy/u);
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
  let abortCalls = 0;
  ctx.abort = () => { abortCalls += 1; };
  await commands.get("goal").handler("Keep this goal", ctx);
  ctx.ui.select = async () => "Clear goal";
  ctx.ui.confirm = async () => false;
  await commands.get("goal").handler("", ctx);
  assert.notEqual(appendedEntries.at(-1).data.state, null);
  assert.equal(abortCalls, 0);

  ctx.ui.confirm = async () => true;
  await commands.get("goal").handler("", ctx);
  assert.equal(appendedEntries.at(-1).data.state, null);
  assert.equal(abortCalls, 1);

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

test("/goal custom-message continuations enter goal turns without before_agent_start", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness();
  const { ctx } = createTuiContext();

  await commands.get("goal").handler("Audit the host continuation lifecycle", ctx);

  assert.match(sentMessages[0].message.content, /Status: active · Turn: 1/u);
  assert.equal(last(appendedEntries.filter((entry) => entry.data.event === "turn")).data.state.turns, 1);
  const first = await tools.get("killeros_goal_update").execute(
    "first-host-turn",
    { status: "blocked", blockerKey: "host-lifecycle", evidence: "The same external blocker remains" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const duplicate = await tools.get("killeros_goal_update").execute(
    "duplicate-host-turn",
    { status: "blocked", blockerKey: "host-lifecycle", evidence: "Duplicate audit in the same turn" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(first.details.streak, 1);
  assert.equal(duplicate.details.streak, 1);

  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);

  assert.match(sentMessages[1].message.content, /Status: active · Turn: 2/u);
  assert.equal(last(appendedEntries.filter((entry) => entry.data.event === "turn")).data.state.turns, 2);
  const second = await tools.get("killeros_goal_update").execute(
    "second-host-turn",
    { status: "blocked", blockerKey: "host-lifecycle", evidence: "The blocker remains on the next turn" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(second.details.streak, 2);
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

test("/goal pauses when a dispatched continuation settles without an agent result", async () => {
  const { appendedEntries, commands, handlers } = createHarness();
  const { ctx } = createTuiContext();
  await commands.get("goal").handler("Start reliably", ctx);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.match(lastGoalEntry.data.state.result, /without an agent result/u);
  assert.equal(lastGoalEntry.data.state.turns, 1);
});

test("/goal does not report start, resume, or edit success after dispatch failure", async () => {
  for (const control of ["start", "resume", "edit"]) {
    const { api, appendedEntries, commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });

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
        ctx.waitForIdle = async () => {
          await emitSequentially(handlers.get("agent_end"), {
            messages: [{ role: "assistant", stopReason: "stop" }],
          }, ctx);
          await emitSequentially(handlers.get("agent_settled"), {}, ctx);
        };
        ctx.ui.editor = async () => "Edited objective";
        await commands.get("goal").handler("edit", ctx);
      }
    }

    const state = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal")).data.state;
    assert.equal(state.status, "paused", `${control} failure must pause the goal`);
    assert.match(state.result, /continuation could not start: provider unavailable/u);
    assert.equal(sentMessages.length, control === "start" ? 0 : 1);
    assert.equal(notifications.some(({ message }) => new RegExp(control === "start" ? "Goal active" : control === "resume" ? "Goal resumed" : "Goal updated and active", "u").test(message)), false);
    assert.equal(notifications.at(-1).level, "error");
  }
});

test("/goal reports start, resume, and edit success after dispatch", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  await commands.get("goal").handler("Original objective", ctx);
  assert.match(notifications.at(-1).message, /Goal active/u);
  await commands.get("goal").handler("pause", ctx);
  await commands.get("goal").handler("resume", ctx);
  assert.match(notifications.at(-1).message, /Goal resumed/u);
  ctx.waitForIdle = async () => {
    await emitSequentially(handlers.get("agent_end"), {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  };
  ctx.ui.editor = async () => "Edited objective";
  await commands.get("goal").handler("edit", ctx);
  assert.match(notifications.at(-1).message, /Goal updated and active/u);
  assert.equal(sentMessages.length, 3);
});

test("/goal waits for an unrelated active run to settle before dispatch", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  let idle = false;
  ctx.isIdle = () => idle;

  await commands.get("goal").handler("Start after unrelated work", ctx);
  assert.equal(sentMessages.length, 0);
  idle = true;
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message.content, /Start after unrelated work/u);
});

test("/goal does not claim success when a pending message defers dispatch", async () => {
  const { appendedEntries, commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
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
  const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
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
  const editEntry = last(appendedEntries.filter((entry) => entry.data.event === "edit"));
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
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
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
    const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
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
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await commands.get("goal").handler("Pause even if storage fails", ctx);

  const appendEntry = api.appendEntry;
  api.appendEntry = () => { throw new Error("persistent session write failure"); };
  await commands.get("goal").handler("pause", ctx);
  assert.match(notifications.at(-1).message, /Automatic continuation is stopped/u);

  api.appendEntry = appendEntry;
  await commands.get("goal").handler("pause", ctx);
    const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
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
  const notifications = [] as unknown as RequiredArray<TestNotification>;
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

  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  ctx.mode = "rpc";
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal active/u);
  assert.match(notifications.at(-1).message, /Finish the saved task/u);
});

test("goal update is active only while a goal is active", async () => {
  const { activeTools, commands, handlers, tools } = createHarness();
  const { ctx } = createTuiContext();

  assert.equal(activeTools.includes("killeros_goal_update"), true);
  await emitSequentially(handlers.get("session_start"), { reason: "startup" }, ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), false);

  await commands.get("goal").handler("Finish only after explicit activation", ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), true);
  await commands.get("goal").handler("pause", ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), false);
  await commands.get("goal").handler("resume", ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), true);
  await tools.get("killeros_goal_update").execute(
    "complete-explicit-goal",
    { status: "complete", evidence: "Verified complete" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(activeTools.includes("killeros_goal_update"), false);
});

test("question and goal renderers strip terminal controls while preserving line breaks", () => {
  const { entryRenderers, tools } = createHarness();
  const unsafe = "safe\x1B[2Jspoof\u0007\nnext";
  const question = tools.get("question");
  const questionCall = question.renderCall({
    question: unsafe,
    options: [{ label: unsafe, description: unsafe, preview: unsafe }],
  }, theme, { expanded: true }).render(80).join("\n");
  const questionResult = question.renderResult({
    content: [{ type: "text", text: unsafe }],
    details: { question: unsafe, options: [unsafe], answer: unsafe, wasCustom: true },
  }, { expanded: true }, theme).render(80).join("\n");
  const goalEntry = entryRenderers.get("killeros-goal")({ data: { version: 1, event: "complete", state: {
    version: 1,
    revision: 1,
    objective: unsafe,
    result: unsafe,
    status: "complete",
    createdAt: 1,
    updatedAt: 1,
    activeMilliseconds: 0,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  } } }, { expanded: true }, theme).render(80).join("\n");
  const goalResult = tools.get("killeros_goal_update").renderResult({
    content: [], details: { status: "complete", evidence: unsafe },
  }, { expanded: true }, theme, {}).render(80).join("\n");

  for (const rendered of [questionCall, questionResult, goalEntry, goalResult]) {
    assert.doesNotMatch(rendered, /\x1B|\u0007|\[2J/u);
    assert.match(rendered, /safespoof[^\S\r\n]*\nnext/u);
  }
});

test("goal update renders the real tool error instead of an undefined blocker audit", () => {
  const tool = createHarness().tools.get("killeros_goal_update");
  const call = tool.renderCall({ status: "complete" }, theme, {}).render(80).join("\n");
  const result = tool.renderResult(
    {
      content: [{ type: "text", text: "There is no active KillerOS goal to update" }],
      details: {},
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: true },
  ).render(80).join("\n");
  const rendered = `${call.trimEnd()}\n${result.trimEnd()}`;

  assert.match(rendered, /goal complete\nThere is no active KillerOS goal to update/u);
  assert.doesNotMatch(rendered, /undefined|Blocker audit/u);
});

test("/goal validates objectives, reserves control words, and requires blocker audits during goal turns", async () => {
  const { commands, handlers, tools } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  await commands.get("goal").handler("x".repeat(4_001), ctx);
  assert.match(notifications.at(-1).message, /4,000 characters/u);
  await commands.get("goal").handler("CLEAR", ctx);
  assert.match(notifications.at(-1).message, /No goal is set/u);

  ctx.hasPendingMessages = () => true;
  await commands.get("goal").handler("Resolve the blocker", ctx);
  await assert.rejects(
    tools.get("killeros_goal_update").execute(
      "goal-blocked-outside-turn",
      { status: "blocked", blockerKey: "missing-credential", evidence: "Credentials are unavailable" },
      new AbortController().signal,
      () => {},
      ctx,
    ),
    /during an active KillerOS goal turn/u,
  );

  ctx.hasPendingMessages = () => false;
  await emitGoalStart(handlers, ctx);
  for (const blockerKey of [undefined, "", "UPPERCASE", "contains whitespace", `x${"y".repeat(120)}`]) {
    await assert.rejects(
      tools.get("killeros_goal_update").execute(
        `invalid-${blockerKey}`,
        { status: "blocked", blockerKey, evidence: "Still blocked" },
        new AbortController().signal,
        () => {},
        ctx,
      ),
      /stable lowercase blockerKey/u,
    );
  }
});

test("a goal blocks only after the same blocker is recorded on three consecutive turns", async () => {
  const { appendedEntries, commands, handlers, tools } = createHarness();
  const { ctx } = createTuiContext();
  const blocked = (id: string, blockerKey = "missing-credential"): Promise<TestResult> => tools.get("killeros_goal_update").execute(
    id,
    { status: "blocked", blockerKey, evidence: `Evidence for ${blockerKey}` },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const finishTurn = async () => {
    await emitSequentially(handlers.get("agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  };

  await commands.get("goal").handler("Resolve one stable blocker", ctx);
  await emitGoalStart(handlers, ctx);
  const first = await blocked("first");
  assert.equal(first.details.status, "blocker-audit");
  assert.equal(first.details.streak, 1);
  assert.equal(appendedEntries.at(-1).data.state.status, "active");

  const duplicate = await blocked("duplicate");
  assert.equal(duplicate.details.streak, 1, "duplicate calls in one turn must not advance the streak");
  await finishTurn();

  await emitGoalStart(handlers, ctx);
  const second = await blocked("second");
  assert.equal(second.details.streak, 2);
  await finishTurn();

  await emitGoalStart(handlers, ctx);
  const third = await blocked("third");
  assert.equal(third.details.status, "blocked");
  assert.equal(third.details.streak, 3);
  assert.equal(appendedEntries.at(-1).data.state.status, "blocked");
  assert.deepEqual(appendedEntries.at(-1).data.state.blockerAudit, {
    key: "missing-credential",
    streak: 3,
    lastTurn: 3,
  });
});

test("resume, edit, and completion clear blocker audit progress", async () => {
  for (const transition of ["resume", "edit", "complete"]) {
    const { appendedEntries, commands, handlers, tools } = createHarness();
    const { ctx } = createTuiContext();
    await commands.get("goal").handler(`Reset audit on ${transition}`, ctx);
    await emitGoalStart(handlers, ctx);
    await tools.get("killeros_goal_update").execute(
      `audit-before-${transition}`,
      { status: "blocked", blockerKey: "stable-blocker", evidence: "First attempt" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    if (transition === "resume") {
      await commands.get("goal").handler("pause", ctx);
      await commands.get("goal").handler("resume", ctx);
    } else if (transition === "edit") {
      ctx.ui.editor = async () => "Edited objective";
      await commands.get("goal").handler("edit", ctx);
    } else {
      await tools.get("killeros_goal_update").execute(
        "complete-after-audit",
        { status: "complete", evidence: "Verified complete" },
        new AbortController().signal,
        () => {},
        ctx,
      );
    }
    assert.equal(appendedEntries.at(-1).data.state.blockerAudit, undefined, transition);
  }
});

test("changed and skipped blocker turns reset the blocker streak", async () => {
  const { appendedEntries, commands, handlers, tools } = createHarness();
  const { ctx } = createTuiContext();
  const blocked = (blockerKey: string): Promise<TestResult> => tools.get("killeros_goal_update").execute(
    blockerKey,
    { status: "blocked", blockerKey, evidence: "Repeated evidence" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const finishTurn = async () => {
    await emitSequentially(handlers.get("agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  };

  await commands.get("goal").handler("Audit blocker resets", ctx);
  await emitGoalStart(handlers, ctx);
  await blocked("first-blocker");
  await finishTurn();
  await emitGoalStart(handlers, ctx);
  assert.equal((await blocked("changed-blocker")).details.streak, 1);
  await finishTurn();
  await emitGoalStart(handlers, ctx);
  await finishTurn();
  await emitGoalStart(handlers, ctx);
  assert.equal((await blocked("changed-blocker")).details.streak, 1);
  assert.equal(appendedEntries.at(-1).data.state.status, "active");
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
    const { activeTools, appendedEntries, commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext(entries);
    ctx.mode = mode;
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({ reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentMessages.length, 0);
    assert.equal(activeTools.includes("killeros_goal_update"), false);

    let systemPrompt = "base";
    for (const handler of handlers.get("before_agent_start")) {
      const result = await handler({ prompt: "", systemPrompt, systemPromptOptions: {} }, ctx);
      if (result?.systemPrompt) systemPrompt = result.systemPrompt;
    }
    assert.doesNotMatch(systemPrompt, /Active KillerOS goal/u);
    await commands.get("goal").handler("", ctx);
    assert.match(notifications.at(-1).message, /requires TUI or RPC mode/u);
    for (const handler of handlers.get("session_shutdown")) await handler({}, ctx);
    assert.equal(appendedEntries.length, 0, `${mode} must not checkpoint an inactive saved goal`);
  }
});

test("/goal edit resumes after invalid input and pauses after persistence failure", async () => {
  const { api, appendedEntries, commands, handlers, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
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

test("/goal pause and clear persist terminal state before stopping an active goal run", async () => {
  for (const mode of ["tui", "rpc"]) {
    for (const control of ["pause", "clear"]) {
      const { api, commands, handlers, sentMessages } = createHarness();
      const { ctx } = createTuiContext();
      ctx.mode = mode;
      const calls: string[] = [];
      const appendEntry = api.appendEntry;
      api.appendEntry = (customType, data) => {
        appendEntry(customType, data);
        if (data.event === control) calls.push(`persist:${data.state?.status ?? "clear"}`);
      };
      ctx.abort = () => calls.push("abort");
      ctx.waitForIdle = async () => { calls.push("waitForIdle"); };
      ctx.ui.notify = () => calls.push("notify");

      await commands.get("goal").handler(`Immediately ${control} active work`, ctx);
      calls.length = 0;
      await emitGoalStart(handlers, ctx);
      await commands.get("goal").handler(control, ctx);

      assert.deepEqual(calls, [`persist:${control === "pause" ? "paused" : "clear"}`, "abort", "waitForIdle", "notify"], `${mode} ${control}`);
      await emitSequentially(handlers.get("agent_end"), { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
      await emitSequentially(handlers.get("agent_settled"), {}, ctx);
      assert.equal(sentMessages.length, 1, `${mode} ${control} must not continue after explicit cancellation`);
    }
  }
});

test("/goal pause stops a scheduled continuation before its goal turn starts", async () => {
  const { commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const calls: string[] = [];
  ctx.abort = () => calls.push("abort");
  ctx.waitForIdle = async () => { calls.push("waitForIdle"); };
  await commands.get("goal").handler("Pause scheduled work", ctx);
  assert.equal(sentMessages.length, 1);
  calls.length = 0;
  await commands.get("goal").handler("pause", ctx);
  assert.deepEqual(calls, ["abort", "waitForIdle"]);
});

test("/goal does not abort unrelated work when clearing an inactive goal", async () => {
  const now = Date.now();
  for (const status of ["paused", "blocked", "complete"]) {
    const state = {
      version: 1,
      revision: 3,
      objective: `${status} objective`,
      status,
      createdAt: now,
      updatedAt: now,
      activeMilliseconds: 0,
      turns: 3,
      blockedAuditStartTurn: 0,
      baselineTokens: 0,
    };
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: status, state } }];
    const { commands, handlers } = createHarness();
    const { ctx } = createTuiContext(entries);
    let abortCalls = 0;
    ctx.abort = () => { abortCalls += 1; };
    await emitSequentially(handlers.get("session_start"), { reason: "resume" }, ctx);
    await commands.get("goal").handler("clear", ctx);
    assert.equal(abortCalls, 0, status);
  }
});

test("saved goal cancellation remains terminal when host stopping fails", async () => {
  for (const control of ["pause", "clear"]) {
    const { appendedEntries, commands, handlers } = createHarness();
    const { ctx } = createTuiContext();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await commands.get("goal").handler(`Persist ${control} before abort`, ctx);
    await emitGoalStart(handlers, ctx);
    ctx.abort = () => { throw new Error("abort unavailable"); };
    await commands.get("goal").handler(control, ctx);
    const state = appendedEntries.at(-1).data.state;
    assert.equal(control === "pause" ? state.status : state, control === "pause" ? "paused" : null);
    assert.match(notifications.at(-1).message, /could not be confirmed stopped/u);
    assert.match(notifications.at(-1).message, /abort unavailable/u);
  }
});

test("valid blocker audits restore and malformed audits fail closed", async () => {
  const now = Date.now();
  const activeState = {
    version: 1,
    revision: 4,
    objective: "Restore the blocker audit",
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeMilliseconds: 0,
    turns: 2,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  };
  const restore = async (blockerAudit: unknown) => {
    const entries = [{
      type: "custom",
      customType: "killeros-goal",
      data: { version: 1, event: "blocker-audit", state: { ...activeState, blockerAudit } },
    }];
    const harness = createHarness();
    const { ctx } = createTuiContext(entries);
    await emitSequentially(harness.handlers.get("session_start"), { reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    return { ...harness, ctx };
  };

  const valid = await restore({ key: "missing-credential", streak: 2, lastTurn: 2 });
  assert.equal(valid.sentMessages.length, 1);
  await emitGoalStart(valid.handlers, valid.ctx);
  await valid.tools.get("killeros_goal_update").execute(
    "restored-third-attempt",
    { status: "blocked", blockerKey: "missing-credential", evidence: "Still unavailable" },
    new AbortController().signal,
    () => {},
    valid.ctx,
  );
  assert.equal(valid.appendedEntries.at(-1).data.state.status, "blocked");

  const malformed = [
    { key: "", streak: 1, lastTurn: 1 },
    { key: "UPPERCASE", streak: 1, lastTurn: 1 },
    { key: "valid", streak: 0, lastTurn: 1 },
    { key: "valid", streak: 4, lastTurn: 1 },
    { key: "valid", streak: 1.5, lastTurn: 1 },
    { key: "valid", streak: 1, lastTurn: -1 },
    { key: "valid", streak: 1, lastTurn: 0 },
    { key: "valid", streak: 1, lastTurn: 3 },
  ];
  for (const audit of malformed) {
    const restored = await restore(audit);
    assert.equal(restored.sentMessages.length, 0, JSON.stringify(audit));
  }
});

test("/goal edit reports persistence failure for every goal status", async () => {
  const now = Date.now();
  for (const status of ["active", "paused", "blocked", "complete"]) {
    const state = {
      version: 1,
      revision: 3,
      objective: "Original objective",
      status,
      createdAt: now,
      updatedAt: now,
      activeMilliseconds: 0,
      activeStartedAt: status === "active" ? now : undefined,
      turns: 3,
      blockedAuditStartTurn: 0,
      baselineTokens: 0,
    };
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: status, state } }];
    const { api, commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext(entries);
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    ctx.ui.editor = async () => "Edited objective";
    await emitSequentially(handlers.get("session_start"), { reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    const sentBeforeEdit = sentMessages.length;
    api.appendEntry = () => { throw new Error(`write failed from ${status}`); };
    await commands.get("goal").handler("edit", ctx);
    assert.match(notifications.at(-1).message, new RegExp(`write failed from ${status}`, "u"));
    assert.equal(sentMessages.length, sentBeforeEdit, status);
    ctx.mode = "rpc";
    await commands.get("goal").handler("", ctx);
    assert.match(notifications.at(-1).message, /Original objective/u);
    assert.match(notifications.at(-1).message, new RegExp(`Goal ${status === "active" ? "paused" : status}`, "u"));
  }
});

test("failed goal replacement pauses the old active goal and dispatches neither objective", async () => {
  const { api, commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await commands.get("goal").handler("Old objective", ctx);
  api.appendEntry = () => { throw new Error("replacement write failed"); };
  await commands.get("goal").handler("New objective", ctx);
  assert.equal(sentMessages.length, 1);
  assert.match(notifications.at(-1).message, /Goal could not be replaced: replacement write failed/u);
  ctx.mode = "rpc";
  await commands.get("goal").handler("", ctx);
  assert.match(notifications.at(-1).message, /Goal paused/u);
  assert.match(notifications.at(-1).message, /Old objective/u);
});

test("failed replacement preserves paused and blocked goals", async () => {
  const now = Date.now();
  for (const status of ["paused", "blocked"]) {
    const state = {
      version: 1,
      revision: 3,
      objective: `Original ${status} objective`,
      status,
      createdAt: now,
      updatedAt: now,
      activeMilliseconds: 0,
      turns: 3,
      blockedAuditStartTurn: 0,
      baselineTokens: 0,
    };
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: status, state } }];
    const { api, commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext(entries);
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await emitSequentially(handlers.get("session_start"), { reason: "resume" }, ctx);
    api.appendEntry = () => { throw new Error(`${status} replacement failed`); };
    await commands.get("goal").handler("Replacement objective", ctx);
    assert.equal(sentMessages.length, 0);
    assert.match(notifications.at(-1).message, new RegExp(`${status} replacement failed`, "u"));
    ctx.mode = "rpc";
    await commands.get("goal").handler("", ctx);
    assert.match(notifications.at(-1).message, new RegExp(`Goal ${status}`, "u"));
    assert.match(notifications.at(-1).message, new RegExp(`Original ${status} objective`, "u"));
  }
});

test("first goal write failure reports the error and dispatches nothing", async () => {
  const { api, commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  api.appendEntry = () => { throw new Error("first write failed"); };
  await commands.get("goal").handler("New objective", ctx);
  assert.equal(sentMessages.length, 0);
  assert.match(notifications.at(-1).message, /Goal could not be started: first write failed/u);
});

test("completed goals leave the footer but remain available through /goal", async () => {
  const { commands, handlers, tools } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
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

test("active, paused, and blocked goals replace the footer path with exact status text", async () => {
  const { appendedEntries, commands, handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of handlers.get("session_start")) await handler({ reason: "startup" }, ctx);
  await commands.get("goal").handler("Keep working", ctx);
  const state = appendedEntries.at(-1).data.state;
  const yellowTheme = {
    ...theme,
    fg: (color: string, text: string) => color === "warning" ? `\x1B[33m${text}\x1B[39m` : text,
  } as unknown as Theme;
  const footer = captured.footerFactory(tui, yellowTheme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });
  const stripAnsi = (line: string) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 10_000;
  const seconds = footer.render(160)[2] ?? "";
  assert.match(seconds, /\x1B\[33m\/goal is active \(10s\)\x1B\[39m/u);
  assert.ok(stripAnsi(seconds).trimEnd().endsWith("/goal is active (10s)"));
  assert.doesNotMatch(stripAnsi(seconds), /✻ goal|pi-KillerOS/u);

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 125_000;
  assert.ok(stripAnsi(footer.render(40)[2] ?? "").trimEnd().endsWith("/goal is active (2m 05s)"));

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 3_725_000;
  assert.ok(stripAnsi(footer.render(40)[2] ?? "").trimEnd().endsWith("/goal is active (1h 02m 05s)"));

  for (let width = 1; width <= 180; width += 1) {
    const lines = footer.render(width).map(stripAnsi);
    assert.equal(lines.length, 3, `goal footer rows at width ${width}`);
    assert.ok(lines.every((line) => [...line].length === width), `goal footer width mismatch at ${width}`);
  }

  state.status = "paused";
  state.activeStartedAt = undefined;
  const paused = stripAnsi(footer.render(160)[2] ?? "");
  assert.ok(paused.trimEnd().endsWith("/goal is paused"));
  assert.doesNotMatch(paused, /Ⅱ goal paused/u);

  state.status = "blocked";
  const blocked = stripAnsi(footer.render(160)[2] ?? "");
  assert.ok(blocked.trimEnd().endsWith("/goal is blocked"));
  assert.doesNotMatch(blocked, /! goal blocked/u);
  footer.dispose();
});

test("registers /init as a native command and runs the hidden generation workflow", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-workflow-"));
  try {
    const { commands, handlers, sentMessages, sentUserMessages, tools } = createHarness();
    assert.equal(commands.has("init"), true);
    assert.equal(tools.has("init"), false);
    assert.equal(tools.has("init_survey"), false);

    const notifications = [] as unknown as RequiredArray<TestNotification>;
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
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
    assert.match(sentMessages[0].message.content, /Existing root AGENTS\.md \(protected policy/u);
    assert.match(INIT_WORKFLOW_PROMPT, /## Analyze[\s\S]*## Synthesize[\s\S]*## Generate/u);
    assert.match(INIT_WORKFLOW_PROMPT, /ask no questions/u);
    assert.match(INIT_WORKFLOW_PROMPT, /preserve every compatible existing rule/iu);
    assert.match(INIT_WORKFLOW_PROMPT, /killeros_init_conflict/u);
    assert.match(INIT_WORKFLOW_PROMPT, /at most 2 repository-specific lines per section/u);
    assert.doesNotMatch(INIT_WORKFLOW_PROMPT, /C:\\Users|writing-great-guidelines\/SKILL\.md/u);

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

test("/init rejects re-entry while the first invocation waits for idle", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-starting-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    let releaseIdle: () => void = () => {};
    let waitCalls = 0;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => { waitCalls += 1; await idle; },
    };

    const first = commands.get("init").handler("", ctx);
    await waitFor(() => waitCalls === 1);
    await commands.get("init").handler("", ctx);
    assert.equal(waitCalls, 1);
    assert.deepEqual(notifications.at(-1), { message: "/init is already running", level: "warning" });

    releaseIdle();
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await first;
    assert.equal(sentMessages.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init cancels preflight when its session shuts down", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-shutdown-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    let releaseIdle: () => void = () => {};
    let waiting = false;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    ctx.cwd = directory;
    ctx.reload = async () => {};
    ctx.waitForIdle = async () => { waiting = true; await idle; };

    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => waiting);
    await emitSequentially(handlers.get("session_shutdown"), {}, ctx);
    releaseIdle();
    await initRun;
    assert.equal(sentMessages.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelled /init preflight cannot overwrite a newer session", { timeout: 10_000 }, async () => {
  const slowDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-slow-"));
  const fastDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-fast-"));
  try {
    execFileSync("git", ["init"], { cwd: slowDirectory, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["init"], { cwd: fastDirectory, stdio: "ignore", windowsHide: true });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(path.join(slowDirectory, `source-${index}.txt`), "x".repeat(8_192));
    }
    writeFileSync(path.join(fastDirectory, "package.json"), '{"name":"new-session"}\n');

    const { commands, handlers, sentMessages, tools } = createHarness();
    const context = (cwd: string): TestTuiContext => {
      const { ctx } = createTuiContext();
      ctx.cwd = cwd;
      ctx.reload = async () => {};
      return ctx;
    };
    const slow = commands.get("init").handler("", context(slowDirectory));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await emitSequentially(handlers.get("session_shutdown"), {}, context(slowDirectory));

    const fastContext = context(fastDirectory);
    const fast = commands.get("init").handler("", fastContext);
    await waitFor(() => sentMessages.length === 1);
    await slow;

    const result = await tools.get("killeros_init_read").execute("new-session-read", { path: "package.json" });
    assert.match(result.content[0].text, /new-session/u);
    await emitSequentially(handlers.get("agent_settled"), {}, fastContext);
    await fast;
  } finally {
    rmSync(slowDirectory, { recursive: true, force: true });
    rmSync(fastDirectory, { recursive: true, force: true });
  }
});

test("/init settles its command handler when the session shuts down", { timeout: 1_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-active-shutdown-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    ctx.cwd = directory;
    ctx.reload = async () => {};
    ctx.ui.notify = (message, level) => notifications.push({ message, level });

    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(handlers.get("session_shutdown"), {}, ctx);
    await initRun;
    assert.deepEqual(notifications, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init reports failure instead of reloading when the model does not write", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-no-write-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;

    assert.equal(reloadCalls, 0);
    assert.deepEqual(notifications.at(-1), {
      message: "/init did not generate AGENTS.md: the model completed without a write or policy-conflict outcome",
      level: "error",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init reports a structured policy conflict without writing or reloading", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-conflict-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "# AGENTS.md\n\nProtected policy.\n");
    const { commands, handlers, sentMessages, tools } = createHarness();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => {},
    };
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    const reason = "Protected release policy conflicts with repository evidence.";
    await tools.get("killeros_init_conflict").execute("conflict", { reason });
    await assert.rejects(
      tools.get("killeros_init_write").execute("write-after-conflict", { content: validGeneratedGuidance }),
      /exactly one write or policy-conflict/u,
    );
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nProtected policy.\n");
    assert.equal(reloadCalls, 0);
    assert.deepEqual(notifications.at(-1), { message: `/init left AGENTS.md unchanged: ${reason}`, level: "warning" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init preserves compatible protected policy and blocks every other mutation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-existing-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
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
      toolName: "killeros_init_read",
      input: { path: "src-index.ts" },
    }, ctx);
    assert.equal(readOnly.some((result) => result?.block), false);
    assert.match((await tools.get("killeros_init_read").execute("inspect-source", { path: "src-index.ts" })).content[0].text, /value = 1/u);

    const generated = validGeneratedGuidance.replace("Check facts before changing code.", "Check facts before changing code.\nPreserve this workflow.");
    const replacement = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "replace-existing",
      toolName: "killeros_init_write",
      input: { content: generated },
    }, ctx);
    assert.equal(replacement.some((result) => result?.block), false);
    await tools.get("killeros_init_write").execute("replace-existing", { content: generated }, new AbortController().signal, () => {}, ctx);
    assert.equal(readFileSync(path.join(directory, "AGENTS.md"), "utf8"), generated);

    const secondWrite = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "replace-again",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.match(resultReason(secondWrite), /exactly one write or policy-conflict/u);

    const editTarget = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "edit-existing",
      toolName: "edit",
      input: { path: "AGENTS.md", edits: [{ oldText: "Generated", newText: "Changed" }] },
    }, ctx);
    assert.match(resultReason(editTarget), /bounded evidence and terminal tools/u);

    const otherFile = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "write-other",
      toolName: "write",
      input: { path: "README.md", content: "replacement" },
    }, ctx);
    assert.match(resultReason(otherFile), /bounded evidence and terminal tools/u);

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
      writeInitAgentsFile(target, validGeneratedGuidance, async () => { throw renameError; }),
      /replacement blocked/u,
    );
    assert.equal(readFileSync(target, "utf8"), "original guidance\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init aborts instead of overwriting an in-place concurrent edit", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-concurrent-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "# AGENTS.md\n\nOriginal.\n");
    const baseline = await captureInitTargetBaseline(target);
    writeFileSync(target, "# AGENTS.md\n\nConcurrent user edit.\n");
    await assert.rejects(
      installInitAgentsFile(target, validGeneratedGuidance, baseline),
      /changed while \/init was generating/u,
    );
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nConcurrent user edit.\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init does not report failure after committed candidate cleanup fails", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-cleanup-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "# AGENTS.md\n\nOriginal.\n");
    const baseline = await captureInitTargetBaseline(target);
    let unlinkCalls = 0;
    const { unlink } = await import("node:fs/promises");
    await installInitAgentsFile(target, validGeneratedGuidance, baseline, {
      unlinkFile: async (filePath) => {
        unlinkCalls += 1;
        if (unlinkCalls === 2) throw new Error("candidate cleanup failed");
        await unlink(filePath);
      },
    });
    assert.equal(readFileSync(target, "utf8"), validGeneratedGuidance);
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init detects a writer that replaces the linked candidate before commit", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-race-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    const baseline = await captureInitTargetBaseline(target);
    const { link, unlink, writeFile } = await import("node:fs/promises");
    await assert.rejects(
      installInitAgentsFile(target, validGeneratedGuidance, baseline, {
        linkFile: async (candidatePath, installedPath) => {
          await link(candidatePath, installedPath);
          await unlink(installedPath);
          await writeFile(installedPath, "# AGENTS.md\n\nNewer external file.\n");
        },
      }),
      /changed while \/init was generating/u,
    );
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nNewer external file.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init validates generated guidance deterministically", () => {
  assert.equal(validateGeneratedGuidance(validGeneratedGuidance), undefined);
  for (const invalid of [
    validGeneratedGuidance.replace("# AGENTS.md", "# Instructions"),
    `# AGENTS.md extra\n\n${validGeneratedGuidance}`,
    validGeneratedGuidance.replace("## 2. Simplicity First", "## Simplicity"),
    `${validGeneratedGuidance}\n[FILL IN command]`,
    `${validGeneratedGuidance}\n[exact command]`,
    `${validGeneratedGuidance}\n[confirmed command]`,
    "x".repeat(128 * 1024 + 1),
  ]) {
    assert.equal(typeof validateGeneratedGuidance(invalid), "string");
  }
});

test("/init blocks a linked AGENTS.md target before a model turn", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-target-"));
  try {
    writeFileSync(path.join(directory, "shared.md"), "shared instructions\n");
    if (!createFileSymlinkOrSkip(t, "shared.md", path.join(directory, "AGENTS.md"))) return;
    await assert.rejects(captureInitTargetBaseline(path.join(directory, "AGENTS.md")), /regular, non-linked file/u);
    assert.equal(readFileSync(path.join(directory, "shared.md"), "utf8"), "shared instructions\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init rejects a target swapped after tool-call validation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-swap-target-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
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
      return undefined;
    });
    const callResults = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "swap-target",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.equal(callResults.some((result) => result?.block), false);
    await assert.rejects(
      tools.get("killeros_init_write").execute("swap-target", { content: validGeneratedGuidance }, new AbortController().signal, () => {}, ctx),
      /changed while \/init was generating|regular, non-linked file/u,
    );
    assert.equal(readFileSync(shared, "utf8"), "shared guidance\n");
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init preserves a target created after an absent baseline", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-new-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    const baseline = await captureInitTargetBaseline(target);
    writeFileSync(target, "# AGENTS.md\n\nConcurrent creator.\n");
    await assert.rejects(
      installInitAgentsFile(target, validGeneratedGuidance, baseline),
      /changed while \/init was generating/u,
    );
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nConcurrent creator.\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init recovers when its agent workflow cannot start", async () => {
  const { api, commands, handlers, sentMessages } = createHarness();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    mode: "tui",
    reload: async () => {},
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  };
  api.sendMessage = () => { throw new Error("no active model"); };
  await commands.get("init").handler("", ctx);
  assert.deepEqual(notifications.at(-1), { message: "/init failed to start: no active model", level: "error" });

  api.sendMessage = (message, options) => {
    sentMessages.push({ message: message as TestSentMessage["message"], options });
  };
  const retry = commands.get("init").handler("", ctx);
  await waitFor(() => sentMessages.length === 1);
  assert.equal(sentMessages.length, 1);
  await emitSequentially(handlers.get("agent_settled"), {}, ctx);
  await retry;
});

test("/init refuses untrusted projects before scanning or starting the model", async () => {
  const { commands, sentMessages } = createHarness();
  const notifications = [] as unknown as RequiredArray<TestNotification>;
  await commands.get("init").handler("", {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    mode: "tui",
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  });
  assert.deepEqual(notifications.at(-1), { message: "Trust this project before running /init", level: "error" });
  assert.equal(sentMessages.length, 0);
});

test("/init attaches a bounded project snapshot without reading existing guidance", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-survey-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
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
    const encodedSnapshot = sentMessages[0].message.content.split(marker)[1].split("\n\n## Existing root AGENTS.md")[0];
    const snapshot = JSON.parse(encodedSnapshot);
    assert.match(snapshot, /src\/core\/index\.ts/u);
    assert.match(snapshot, /node --test/u);
    assert.doesNotMatch(snapshot, /Preserve releases|PRIVATE-CONTEXT|PRIVATE-MEMORY|DEPENDENCY-CONTENT|PRIVATE-SKILL|PRIVATE-HOOK|MEMORY\.md|killeros-hooks/u);
    assert.match(sentMessages[0].message.content, /Preserve releases/u);
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
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
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

test("/init truncation preserves complete UTF-8 characters", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-utf8-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "README.md"), `${"a".repeat(8_191)}😀`, "utf8");
    writeFileSync(path.join(directory, "src", "large.ts"), `${"b".repeat(32_767)}😀`, "utf8");

    const { index } = await buildInitEvidence(directory);

    assert.doesNotMatch(index.snapshot, /�/u);
    assert.doesNotMatch(await readInitEvidence(index, "src/large.ts"), /�/u);
    assert.ok(Buffer.byteLength(index.snapshot, "utf8") <= 40 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init evidence excludes secrets, ignored files, links, and paths outside the frozen map", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-read-scope-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, ".gitignore"), ".env.local\nignored.ts\n");
    writeFileSync(path.join(directory, "allowed.ts"), "export const allowed = true;\n");
    for (const name of [".env", ".env.local", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials.json", "service-account-prod.json", "private.pem", "private.key", "private.p12", "private.pfx", "private.jks", "private.keystore", "AGENTS.md", "CLAUDE.md", "ignored.ts"]) {
      writeFileSync(path.join(directory, name), "SECRET\n");
    }
    let linked = false;
    try {
      symlinkSync("allowed.ts", path.join(directory, "linked.ts"), "file");
      linked = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code))) throw error;
    }
    writeFileSync(path.join(directory, "hard-link-source.ts"), "linked\n");
    try {
      linkSync(path.join(directory, "hard-link-source.ts"), path.join(directory, "hard-linked.ts"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code))) throw error;
    }

    const { index } = await buildInitEvidence(directory);
    assert.match(index.snapshot, /allowed\.ts/u);
    assert.doesNotMatch(index.snapshot, /\.env|\.npmrc|private\.pem|ignored\.ts|CLAUDE\.md/u);
    assert.match(await readInitEvidence(index, "allowed.ts"), /allowed = true/u);
    assert.deepEqual(listInitEvidence(index), [...listInitEvidence(index)].sort());
    for (const unavailable of [".env", ".env.local", ".npmrc", "private.pem", "ignored.ts", "AGENTS.md", "../outside", path.resolve(directory, "allowed.ts"), "~/secret", "file:///secret", "missing.ts", "hard-linked.ts", ...(linked ? ["linked.ts"] : [])]) {
      await assert.rejects(readInitEvidence(index, unavailable), /not available to \/init|rejects/u, unavailable);
    }

    writeFileSync(path.join(directory, "created-after-map.ts"), "late\n");
    await assert.rejects(readInitEvidence(index, "created-after-map.ts"), /not available to \/init/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init fails closed without exposing a custom ignored file when Git is unavailable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-no-git-"));
  try {
    writeFileSync(path.join(directory, ".gitignore"), "private-notes.txt\n");
    writeFileSync(path.join(directory, "private-notes.txt"), "PRIVATE NOTES MUST NOT ENTER EVIDENCE\n");
    execFileSync(process.execPath, [
      "--input-type=module",
      "--experimental-strip-types",
      "--eval",
      `
        import { buildInitEvidence } from "./killeros/init-evidence.ts";
        try {
          await buildInitEvidence(process.env.KILLEROS_TEST_DIRECTORY);
          throw new Error("/init unexpectedly built an evidence index");
        } catch (error) {
          if (!String(error.message).includes("Git ignore inspection failed")) throw error;
        }
      `,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, KILLEROS_TEST_DIRECTORY: directory, PATH: "" },
      stdio: "pipe",
      windowsHide: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init tool scoping never exposes killeros_init_write outside /init", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-tool-scope-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
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
    assert.deepEqual(activeTools, [
      "killeros_init_read",
      "killeros_init_list",
      "killeros_init_write",
      "killeros_init_conflict",
    ]);

    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
    await initRun;
    assert.deepEqual(activeTools, fullSet);

    for (const handler of handlers.get("session_start")) await handler({ reason: "new" }, ctx);
    assert.deepEqual(activeTools, fullSet);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init tool middleware does not freeze or redefine shared event input", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-middleware-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "safe.ts"), "safe\n");
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    const initRun = commands.get("init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    const input = { path: "safe.ts" };
    const event = { toolCallId: "mutable", toolName: "killeros_init_read", input };
    await emitSequentially(handlers.get("tool_call"), event, ctx);
    assert.equal(Object.isFrozen(input), false);
    input.path = "changed-by-another-extension.ts";
    assert.equal(event.input.path, "changed-by-another-extension.ts");
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);
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

test("injects trusted AGENTS.local.md imports without source-path metadata", async () => {
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
    assert.match(event.systemPrompt, /\n<personal_instructions>\n/u);
    assert.doesNotMatch(event.systemPrompt, /source=/u);
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
    const notifications = [] as unknown as RequiredArray<TestNotification>;
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

test("rejects agent_settled matchers without executing their commands", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-settled-matcher-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const marker = path.join(directory, "marker.txt");
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { agent_settled: [{ matcher: "^bash$", command }] },
    }));

    const { handlers } = createHarness();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({}, ctx);
    await emitSequentially(handlers.get("agent_settled"), {}, ctx);

    assert.equal(existsSync(marker), false);
    assert.deepEqual(notifications, [{
      message: "Ignored agent_settled hook 1: matchers are only valid for tool events",
      level: "warning",
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hook timeout validation accepts five minutes and rejects one millisecond more", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-timeout-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = (file: string) => `"${process.execPath}" -e "require('node:fs').writeFileSync('${file}','ran')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [
        { command: command("accepted"), timeoutMs: 300_000 },
        { command: command("rejected"), timeoutMs: 300_001 },
      ] },
    }));

    const { handlers } = createHarness();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of handlers.get("session_start")) await handler({}, ctx);
    await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "hook-timeout-boundary",
      toolName: "write",
      input: {},
    }, ctx);

    assert.equal(existsSync(path.join(directory, "accepted")), true);
    assert.equal(existsSync(path.join(directory, "rejected")), false);
    assert.match(notifications.at(-1)?.message, /Ignored tool_call hook 2: timeoutMs must be an integer from 1 to 300000/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project tool_call hook failures block tools with terminal-safe diagnostics", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "process.stderr.write('\\u001b]2;owned\\u0007\\u001b[31mblocked\\u001b[0m\\u0000');process.exit(7)"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command, timeoutMs: 5_000 }] },
    }));

    const { handlers } = createHarness();
    const notifications = [] as unknown as RequiredArray<TestNotification>;
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
    const expected = `Hook failed: ${command}\nblocked`;
    assert.equal(blocked?.block, true);
    assert.equal(resultReason(results), expected);
    assert.deepEqual(notifications.at(-1), { message: expected, level: "error" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized hook payloads remain valid JSON and report truncation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-payload-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "const value=process.env.KILLEROS_PAYLOAD;const payload=JSON.parse(value);if(value.length>8000||payload.truncated!==true||typeof payload.preview!=='string')process.exit(2)"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command }] },
    }));

    const { handlers } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    for (const handler of handlers.get("session_start")) await handler({}, ctx);

    const results = await emitSequentially(handlers.get("tool_call"), {
      toolCallId: "large-hook-payload",
      toolName: "write",
      input: { path: "example.txt", content: "x".repeat(9_000) },
    }, ctx);
    assert.equal(results.some((result) => result?.block), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hook output preserves UTF-8 characters split across stream chunks", async () => {
  class ChunkedHook extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 123;
    kill() { return true; }
  }
  const child = new ChunkedHook();
  const spawnChild = (() => child) as unknown as HookSpawner;
  const resultPromise = executeHook("ignored", process.cwd(), {}, 1_000, spawnChild);
  child.stdout.write(Buffer.from([0xf0, 0x9f]));
  child.stdout.write(Buffer.from([0x98, 0x80]));
  child.emit("close", 0);

  const result = await resultPromise;
  assert.equal(result.stdout, "😀");
});

test("never-closing hooks report unconfirmed exit after bounded cleanup", async () => {
  class NeverClosingHook extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new NeverClosingHook();
  const spawnChild = (() => child) as unknown as HookSpawner;
  const result = await executeHook("ignored", process.cwd(), {}, 1_000, spawnChild);
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitUnconfirmed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("aborting a running hook terminates it and reports cancellation", async () => {
  class NeverClosingChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals: NodeJS.Signals[] = [];
    kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
  }
  const controller = new AbortController();
  const child = new NeverClosingChild();
  const spawnChild = (() => child) as unknown as HookSpawner;
  const resultPromise = executeHook("ignored", process.cwd(), {}, 30_000, spawnChild, controller.signal);
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 130);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);

  let spawned = false;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const neverSpawn = (() => { spawned = true; return undefined; }) as unknown as HookSpawner;
  const preResult = await executeHook("ignored", process.cwd(), {}, 30_000, neverSpawn, alreadyAborted.signal);
  assert.equal(spawned, false);
  assert.equal(preResult.cancelled, true);
  assert.equal(preResult.code, 130);

  const racingChild = new NeverClosingChild();
  racingChild.kill = function kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", null));
    return true;
  };
  let abortedReads = 0;
  const racingSignal = {
    get aborted() { abortedReads += 1; return abortedReads > 1; },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  const racingSpawn = (() => racingChild) as unknown as HookSpawner;
  const racingResult = await executeHook("ignored", process.cwd(), {}, 30_000, racingSpawn, racingSignal);
  assert.equal(racingResult.cancelled, true);
  assert.equal(racingResult.timedOut, false);
  assert.deepEqual(racingChild.signals, ["SIGTERM"]);
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
    const notifications = [] as unknown as RequiredArray<TestNotification>;
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

test("question keeps single-select as the unchanged default", async () => {
  const question = await startQuestion(createHarness().tools.get("question"), [{ label: "Alpha" }, { label: "Beta" }]);
  question.component.handleInput("\x1B[B");
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details, {
    question: "Choose", options: ["Alpha", "Beta"], answer: "Beta", selectedIndex: 2, wasCustom: false,
  });
});

test("multi-select toggles choices and returns original option order", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", minSelections: 2, maxSelections: 3 },
  );
  question.component.handleInput("\x1B[B");
  question.component.handleInput(" ");
  question.component.handleInput("\x1B[A");
  question.component.handleInput(" ");
  question.component.handleInput("\r");
  const result = await question.result;
  assert.equal(result.content[0].text, "User selected multiple answers:\n- Alpha\n- Beta");
  assert.deepEqual(result.details, {
    question: "Choose all", options: ["Alpha", "Beta", "Gamma"], mode: "multiple", answers: ["Alpha", "Beta"], selectedIndices: [1, 2],
  });
});

test("multi-select toggles with digits and supports one editable custom answer", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"), [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", maxSelections: 3 },
  );
  question.component.handleInput("2");
  question.component.handleInput("3");
  question.component.handleInput("Different choice");
  question.component.handleInput("\r");
  question.component.handleInput("3");
  question.component.handleInput("\x01");
  question.component.handleInput("Edited ");
  question.component.handleInput("\r");
  question.component.handleInput("\r");
  const result = await question.result;
  assert.deepEqual(result.details.answers, ["Beta", "Edited Different choice"]);
  assert.deepEqual(result.details.selectedIndices, [2]);
  assert.equal(result.details.customAnswer, "Edited Different choice");
});

test("multi-select enforces bounds without replacing choices", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"), [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", minSelections: 1, maxSelections: 1 },
  );
  question.component.handleInput("\r");
  assert.match(question.notifications.at(-1).message, /Select at least 1/u);
  question.component.handleInput(" ");
  question.component.handleInput("\x1B[B");
  question.component.handleInput(" ");
  assert.match(question.notifications.at(-1).message, /Select at most 1/u);
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details.answers, ["Alpha"]);
});

test("multi-select custom controls preserve selections and drafts", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"), [{ label: "Alpha" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", maxSelections: 1 },
  );
  question.component.handleInput(" ");
  question.component.handleInput("2");
  question.component.handleInput("blocked draft");
  question.component.handleInput("\r");
  assert.match(question.notifications.at(-1).message, /Select at most 1/u);
  assert.match(question.component.render(60).join("\n"), /blocked draft/u);
  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B[A");
  question.component.handleInput(" ");
  question.component.handleInput("\x1B[B");
  question.component.handleInput(" ");
  assert.equal(question.notifications.length, 1);
  question.component.handleInput("\r");
  question.component.handleInput("custom");
  question.component.handleInput("\r");
  question.component.handleInput(" ");
  question.component.handleInput("\x1B");
  assert.deepEqual((await question.result).details.answers, []);
});

test("multi-select cancellation returns empty arrays", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"), [{ label: "Alpha" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple" },
  );
  question.component.handleInput("\x1B");
  assert.deepEqual((await question.result).details, {
    question: "Choose all", options: ["Alpha"], mode: "multiple", answers: [], selectedIndices: [], cancelled: true,
  });
});

test("multi-select uses slash filter mode, accepts spaces, and keeps hidden checks", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"), [{ label: "Alpha one" }, { label: "Beta two" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", minSelections: 2 },
  );
  question.component.handleInput(" ");
  question.component.handleInput("ignored");
  assert.doesNotMatch(question.component.render(60).join("\n"), /Filter 7/u);
  question.component.handleInput("/");
  question.component.handleInput("Beta two");
  assert.match(question.component.render(60).join("\n"), /Filter 8\/4,000/u);
  question.component.handleInput("\r");
  const applied = question.component.render(60).join("\n");
  assert.match(applied, /Beta two/u);
  assert.doesNotMatch(applied, /Alpha one/u);
  question.component.handleInput(" ");
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details.answers, ["Alpha one", "Beta two"]);
});

test("multi-select filter edits can be discarded, cleared, pasted, and bounded", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"), [{ label: "Alpha" }, { label: "Beta two" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple" },
  );
  question.component.handleInput("/");
  question.component.handleInput("Alpha");
  question.component.handleInput("\r");
  question.component.handleInput("/");
  question.component.handleInput("Beta");
  question.component.handleInput("\x1B");
  assert.match(question.component.render(60).join("\n"), /Alpha/u);
  assert.doesNotMatch(question.component.render(60).join("\n"), /Beta two/u);
  question.component.handleInput("/");
  assert.match(question.component.render(60).join("\n"), /Alpha/u);
  question.component.handleInput("\x01");
  question.component.handleInput("\x0B");
  question.component.handleInput("\x1B[200~Beta two\x1B[201~");
  question.component.handleInput("\r");
  assert.match(question.component.render(60).join("\n"), /Beta two/u);
  question.component.handleInput("\x1B");
  assert.match(question.component.render(60).join("\n"), /Alpha/u);
  question.component.handleInput("/");
  question.component.handleInput(`\x1B[200~${"😀".repeat(4_001)}\x1B[201~`);
  assert.match(question.notifications.at(-1).message, /4,000 characters.*16,000 bytes/u);
  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B");
  await question.result;
});

test("multi-select renders checked state, controls, and bounded compact layouts", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    Array.from({ length: 9 }, (_, index) => ({ label: `Choice ${index + 1} ${"L".repeat(180)}` })),
    `Choose ${"Q".repeat(990)}`, 12, getKeybindings(), { mode: "multiple", minSelections: 1, maxSelections: 10 },
  );
  assert.match(question.component.render(80).join("\n"), /\[ \].*Choice 1/u);
  assert.match(question.component.render(80).join("\n"), /Selected 0.*1–10/u);
  assert.match(question.component.render(80).join("\n"), /space.*toggle.*\/.*filter.*enter.*submit/iu);
  question.component.handleInput(" ");
  assert.match(question.component.render(80).join("\n"), /\[x\].*Choice 1/iu);
  question.tui.terminal.rows = 1;
  assert.match(question.component.render(10).join("\n"), /Selected 1/u);
  for (const rows of [1, 2, 3, 5, 6, 12]) {
    question.tui.terminal.rows = rows;
    const rendered = question.component.render(20);
    assert.ok(rendered.length <= rows);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 20));
    assert.match(rendered.join("\n"), /Choice 1|Selected 1/u);
  }
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("multi-select transcript shows range, exact overflow, and every expanded answer", () => {
  const tool = createHarness().tools.get("question");
  const args = { question: "Choose all", options: [{ label: "Alpha" }, { label: "Beta" }], mode: "multiple", minSelections: 1, maxSelections: 2 };
  assert.match(tool.renderCall(args, theme, { expanded: false }).render(40).join("\n"), /multi-select.*choose 1–2/isu);
  assert.match(tool.renderCall(args, theme, { expanded: true }).render(40).join("\n"), /\[ \].*Alpha/isu);
  const result = {
    content: [{ type: "text", text: "User selected multiple answers" }],
    details: { question: "Choose all", options: ["Alpha", "Beta", "Gamma", "Delta"], mode: "multiple", answers: ["Alpha", "Beta", "Gamma", "Delta"], selectedIndices: [1, 2, 3, 4] },
  };
  const collapsed = tool.renderResult(result, { expanded: false }, theme).render(24).join("\n");
  assert.match(collapsed, /Alpha/u);
  assert.match(collapsed, /\+[1-3] more/u);
  const expanded = tool.renderResult(result, { expanded: true }, theme).render(24).join("\n");
  for (const answer of result.details.answers) assert.match(expanded, new RegExp(answer, "u"));
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

test("question renders no rows when terminal height is zero", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"), undefined, "Choose", 0);
  assert.deepEqual(question.component.render(80), []);
  question.tui.terminal.rows = 3;
  assert.deepEqual(question.component.render(80), ["Choose", "> 1. Alpha", "Option 1/2"]);
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

test("question wraps its full prompt when terminal width narrows", async () => {
  const { tools } = createHarness();
  const prompt = "Which deployment strategy should we use for this application now that the terminal is narrower than full screen?";
  const question = await startQuestion(tools.get("question"), undefined, prompt, 12);

  assert.match(question.component.render(80).join("\n"), /narrower than full screen\?/u);
  const narrowed = question.component.render(40);
  assert.match(narrowed.join("\n"), /narrower than full screen\?/u);
  assert.ok(narrowed.length <= 12);
  assert.ok(narrowed.every((line) => visibleWidth(line) <= 40));

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

test("multiline custom answers stay within tiny terminal row and width limits", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(tools.get("question"), undefined, "Choose", 3);
  question.component.handleInput("2");
  question.component.handleInput("first 😀界");
  question.component.handleInput("\x1B[13;2u");
  question.component.handleInput("second line that clips");

  for (const rows of [1, 2, 3]) {
    question.tui.terminal.rows = rows;
    const rendered = question.component.render(18);
    assert.ok(rendered.length <= rows, `rendered ${rendered.length}/${rows} rows`);
    assert.ok(rendered.every((line) => !/[\r\n]/u.test(line)), `height ${rows} returned an embedded line break`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 18), `height ${rows} exceeded the terminal width`);
    if (rows >= 2) assert.match(rendered.join("\n"), /first/u);
  }

  question.finish({ kind: "cancelled" });
  await question.result;
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
  assert.ok(platform);
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
    assert.doesNotMatch(instructions, /�/u);
    assert.match(instructions, /truncated by KillerOS/u);
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
  ctx.cwd = path.join(path.parse(process.cwd()).root, "work", "a-very-long-workspace-directory-name", "pi-KillerOS");
  ctx.model = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 1_050_000,
  };
  ctx.getContextUsage = () => ({ tokens: 50_000, contextWindow: 1_050_000 });
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  const quietTheme: { fg(color: string, text: string): string } = {
    ...theme,
    fg: (color, text) => color === "borderMuted" ? `<borderMuted>${text}</borderMuted>` : text,
  };
  const footer = captured.footerFactory(tui, quietTheme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });

  const wideRender = footer.render(160);
  assert.equal(wideRender.length, 3);
  assert.equal(wideRender[0], `<borderMuted>${"─".repeat(160)}</borderMuted>`);
  const widePrimary = wideRender[1] ?? "";
  const wideSecondary = wideRender[2] ?? "";
  assert.match(widePrimary, /GPT-5\.6 Sol OpenAI · high · 95% left \(1M\)/u);
  assert.match(widePrimary, /\d+s · \$10\.00/u);
  assert.match(wideSecondary, /main/u);
  const normalizedHome = (process.env.HOME || process.env.USERPROFILE || os.homedir()).replace(/[\\/]+$/u, "");
  const normalizedCwd = ctx.cwd.replace(/[\\/]+$/u, "");
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  const displayedCwd = normalizedCwd === normalizedHome
    ? "~"
    : normalizedCwd.startsWith(normalizedHome) && /^[\\/]/u.test(separator)
      ? `~${normalizedCwd.slice(normalizedHome.length)}`
      : ctx.cwd;
  assert.ok(wideSecondary.includes(displayedCwd));

  const focused = footer.render(48);
  assert.match(focused[1] ?? "", /GPT-5\.6 Sol OpenAI · high · 95% left \(1M\)/u);
  assert.match(focused[2] ?? "", /…\/pi-KillerOS/u);
  assert.doesNotMatch(focused[1] ?? "", /\d+s|\$10\.00/u);

  const compact = footer.render(40);
  assert.match(compact[1] ?? "", /GPT-5\.6 Sol OpenAI · 95% left \(1M\)/u);
  assert.match(compact[2] ?? "", /main/u);
  assert.match(compact[2] ?? "", /…\/pi-KillerOS/u);

  const tiny = footer.render(19);
  assert.doesNotMatch(tiny[2] ?? "", /pi-KillerOS/u);

  const emergency = footer.render(35)[1] ?? "";
  assert.match(emergency, /GPT-5\.6 Sol/u);
  assert.match(emergency, /95% left \(1M\)/u);
  assert.doesNotMatch(emergency, /OpenAI/u);

  for (let width = 1; width <= 180; width += 1) {
    const lines = footer.render(width);
    assert.equal(lines.length, 3, `footer rows at width ${width}`);
    assert.equal(lines[0], `<borderMuted>${"─".repeat(width)}</borderMuted>`);
    assert.ok(lines.slice(1).every((line) => [...line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")].length === width), `footer width mismatch at ${width}`);
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

  const semanticTheme: TestStyle = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim" ? `\x1B[90m${text}\x1B[39m` : text,
  };
  const footer = captured.footerFactory(tui, semanticTheme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  const firstRender = footer.render(120)[1] ?? "";
  assert.match(firstRender, /\x1B\[37m\x1B\[1mProfessional Model\x1B\[22m\x1B\[39m/u);
  assert.match(firstRender, /\x1B\[90mMy Private AI\x1B\[39m/u);

  for (const handler of handlers.get("model_select")) {
    handler({ model: { ...ctx.model, id: "next", name: "Next Model", provider: "future_provider" } });
  }
  const updated = (footer.render(120)[1] ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(updated, /Next Model Future Provider/u);

  for (const handler of handlers.get("model_select")) {
    handler({ model: { ...ctx.model, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" } });
  }
  const deepSeek = (footer.render(120)[1] ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(deepSeek, /DeepSeek V4 Flash DeepSeek/u);
  footer.dispose();
});

test("editor is frameless, focus-aware, width-safe, and supports Shift+Enter", async () => {
  const source = readFileSync(new URL("../killeros/shell-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /buildVisualLineMap|scrollOffset|lastWidth|as unknown as/u);
  assert.doesNotMatch(source, /COMMAND_TOKEN_PATTERN|highlightEditorLines/u);

  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
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
  const editor = captured.editorFactory(tui, editorTheme, getKeybindings());
  editor.focused = true;
  const emptyRender = editor.render(40);
  const emptyLines = emptyRender.map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(emptyLines[0], "");
  const emptyPrompt = emptyLines[1] ?? "";
  assert.equal(emptyLines.length, 2);
  assert.match(emptyPrompt.replace(/\x1B_pi:c\x07/gu, ""), /^❯\u00A0Try "/u);
  assert.equal(visibleWidth(emptyPrompt), 40);
  assert.doesNotMatch(emptyPrompt, /─/u);
  for (let width = 1; width <= 180; width += 1) {
    const lines = editor.render(width);
    assert.equal(lines[0], "", `missing response gap at width ${width}`);
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
  assert.equal(multiline[0], "");
  assert.match(multiline[1], /^❯\u00A0first/u);
  assert.match(multiline[2], /^  second/u);

  editor.setText("wrapped text ".repeat(20));
  const wrapped = editor.render(24).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(wrapped[0], "");
  assert.match(wrapped[1], /^  ↑ \d+ more/u);
  assert.ok(wrapped.slice(2).every((line) => line.startsWith("  ")));
  assert.doesNotMatch(wrapped.join("\n"), /─/u);
  editor.handleInput("\x1B[5~");
  const scrolledUp = editor.render(24).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.match(scrolledUp.at(-1) ?? "", /^  ↓ \d+ more/u);
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
  const { captured, ctx, tui } = createTuiContext([], styledTheme as unknown as Theme);
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
  const editor = captured.editorFactory(tui, createEditorTheme(), getKeybindings());

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
  for (const handler of handlers.get("session_start")) await handler({}, ctx);
  assert.equal(captured.editorFactory, undefined);
  assert.equal(captured.currentEditorFactory, existingFactory);
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

test("frameless editor keeps autocomplete rows aligned below the prompt", async () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);
  const current = {
    applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
    getSuggestions: async () => ({ prefix: "/", items: [] }),
    shouldTriggerFileCompletion: () => true,
  };
  const editor = captured.editorFactory(tui, createEditorTheme(), getKeybindings());
  editor.focused = true;
  editor.setAutocompleteProvider(captured.autocompleteFactory(current));
  editor.handleInput("/");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const rendered = editor.render(60).map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, ""));
  assert.equal(rendered[0], "");
  assert.match(rendered[1], /^❯\u00A0\//u);
  assert.ok(rendered.slice(2).some((line) => line.includes("/clear")));
  assert.ok(rendered.slice(2).every((line) => line.startsWith("  ")));
  assert.doesNotMatch(rendered.join("\n"), /─/u);
});

test("autocomplete preserves text and horizontal whitespace after the cursor", async () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);

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

test("activity keeps the animated orange glyph loop and uses contextual request copy", () => {
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext();
  for (const handler of handlers.get("session_start")) handler({}, ctx);

  assert.deepEqual(captured.workingIndicator, {
    frames: ["·", "✢", "✱", "✶", "✻", "✽", "✽", "✻", "✶", "✱", "✢", "·"],
    intervalMs: 120,
  });
  assert.equal(captured.hiddenThinkingLabel, "└ Thinking…");
  for (const handler of handlers.get("agent_start")) handler({}, ctx);
  assert.equal(captured.workingMessages.at(-1), "Mapping… (esc to interrupt · understanding request)");
  assert.equal(captured.widgetComponent, undefined);
});

test("activity styles the glyph and causal verb orange with a gray bold interrupt status", () => {
  const styledTheme: TestFullStyle = {
    bold: (text) => `<bold>${text}</bold>`,
    fg: (color, text) => `<${color}>${text}</${color}>`,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
  };
  const { handlers } = createHarness();
  const { captured, ctx } = createTuiContext([], styledTheme as unknown as Theme);
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
    /^<accent>Mapping…<\/accent> <dim>\(<bold>esc<\/bold> to interrupt · understanding request\)<\/dim>$/u,
  );
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
  ctx.cwd = path.join(path.parse(process.cwd()).root, "work", "pi-KillerOS");
  const headerTheme: TestStyle = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim"
        ? `\x1B[90m${text}\x1B[39m`
        : color === "mdLink" ? `\x1B[34m${text}\x1B[39m` : text,
  };
  ctx.ui.theme = { ...theme, ...headerTheme } as unknown as Theme;
  for (const handler of handlers.get("session_start")) handler({}, ctx);
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
  header.dispose();
});

test("startup tips and editor suggestions stay fixed per session and exhaust their shuffled decks", async () => {
  const originalRandom = Math.random;
  const suggestions: string[] = [];
  const tips: string[] = [];
  const strip = (line: string) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "").trim();
  const shellUiUrl = new URL("../killeros/shell-ui.ts", import.meta.url);
  shellUiUrl.searchParams.set("startup-tip-test", String(Date.now()));
  const { registerShellUi } = await import(shellUiUrl.href);
  Math.random = () => 0;

  try {
    for (let index = 0; index < 10; index += 1) {
      const { api, handlers } = createHarness();
      registerShellUi(api);
      const { captured, ctx, tui } = createTuiContext();
      last(handlers.get("session_start"))({}, ctx);
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
      const firstEditor = captured.editorFactory(tui, editorTheme, getKeybindings());
      const secondEditor = captured.editorFactory(tui, editorTheme, getKeybindings());
      const firstSuggestion = strip(firstEditor.render(76)[1] ?? "");
      const secondSuggestion = strip(secondEditor.render(76)[1] ?? "");
      assert.equal(firstSuggestion, secondSuggestion);
      assert.match(firstSuggestion, /^❯\u00A0Try "/u);
      suggestions.push(firstSuggestion);
      last(handlers.get("session_shutdown"))({}, ctx);
    }
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(new Set(tips).size, 10);
  assert.equal(new Set(suggestions).size, 10);
});
