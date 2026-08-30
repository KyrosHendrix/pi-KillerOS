import Killeros from "../Killeros.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { extensionApiTestAdapter, themeTestAdapter } from "./PiTestAdapters.ts";
import { rmSync } from "node:fs";

type TestEvent = Record<string, unknown>;

type TestHandlerResult = {
  block?: boolean;
  reason?: string;
  systemPrompt?: string;
  content?: Array<{ type: string; text: string }>;
  [key: string]: unknown;
} | undefined;

export type TestHandler = (event: TestEvent, ctx?: unknown) => TestHandlerResult | Promise<TestHandlerResult>;

export type TestRenderable = {
  render(width: number): string[];
  dispose?: () => void;
};

export type TestInteractive = TestRenderable & {
  handleInput(input: string): void;
};

type TestEditor = TestInteractive & {
  setAutocompleteProvider(provider: unknown): void;
  focused: boolean;
  setText(text: string): void;
  getText(): string;
};

type ToolSchema = Parameters<typeof Check>[0];

export type TestResult = {
  details: Record<string, unknown>;
  content: Array<{ type: string; text: string }>;
  systemPrompt?: string;
  [key: string]: unknown;
};

export type TestTool = {
  name: string;
  description: string;
  parameters: ToolSchema;
  renderCall(...args: unknown[]): TestRenderable;
  renderResult(...args: unknown[]): TestRenderable;
  execute(...args: unknown[]): Promise<TestResult>;
};

export type TestCommand = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
  handler(args: string, ctx: unknown): Promise<unknown>;
};

type SourceInfo = { path: string; source: string; baseDir: string };

type TestEntry = { [key: string]: unknown };

type TestAppendedEntry<TData extends Record<string, unknown>> = {
  type: string;
  customType: string;
  data: TData;
};

export type TestSentMessage = {
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

type Captured = {
  autocompleteFactory: (current: unknown) => TestProvider;
  currentEditorFactory: unknown;
  editorFactory?: TestCapturedFactory;
  footerFactory: TestCapturedFactory;
  headerFactory: TestCapturedFactory;
  hiddenThinkingLabel?: string;
  selection: { title: string; options: string[] };
  statuses?: Map<string, string>;
  themeName?: string;
  titles?: string[];
  widgetComponent?: unknown;
  widgets?: Array<{ key: string; content: unknown; options: unknown }>;
  workingIndicator?: unknown;
  workingMessages: Array<string | undefined>;
};

export type TestTui = { requestRender(): void; terminal: { rows: number } };

export type TestModel = {
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

export type TestTuiContext = {
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
    addAutocompleteProvider(factory: (current: unknown) => TestProvider): void;
    confirm(...args: unknown[]): Promise<boolean>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    getEditorComponent(): unknown;
    notify(message: string, level?: string): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    setEditorComponent(factory: TestCapturedFactory): void;
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

type TestAPI<TEntryData extends Record<string, unknown>> = {
  appendEntry: (customType: string, data: TEntryData) => void;
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

type Harness<TEntryData extends Record<string, unknown> = Record<string, unknown>> = {
  api: TestAPI<TEntryData>;
  activeTools: string[];
  appendedEntries: Array<TestAppendedEntry<TEntryData>>;
  commandRegistrations: string[];
  commands: Map<string, TestCommand>;
  entryRenderers: Map<string, TestRenderer>;
  handlers: Map<string, TestHandler[]>;
  sentMessages: TestSentMessage[];
  sentUserMessages: Array<{ message: unknown; options: unknown }>;
  tools: Map<string, TestTool>;
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTestSentMessage(value: unknown): value is TestSentMessage["message"] {
  return isUnknownRecord(value)
    && typeof value.customType === "string"
    && typeof value.content === "string";
}

function requireTestSentMessage(value: unknown): TestSentMessage["message"] {
  assert.ok(isTestSentMessage(value), "expected a KillerOS custom message");
  return value;
}

initTheme("dark", false);

export const theme = themeTestAdapter({
  bold(text: string): string { return text; },
  fg(_color: string, text: string): string { return text; },
  italic(text: string): string { return text; },
  strikethrough(text: string): string { return text; },
  underline(text: string): string { return text; },
});

export function createHarness<TEntryData extends Record<string, unknown> = Record<string, unknown>>(
  killerosOptions: { handoffMaxTokens?: number } = {},
): Harness<TEntryData> {
  const commands = new Map<string, TestCommand>();
  const commandRegistrations: string[] = [];
  const handlers = new Map<string, TestHandler[]>();
  const tools = new Map<string, TestTool>();
  const entryRenderers = new Map<string, TestRenderer>();
  const appendedEntries: Array<TestAppendedEntry<TEntryData>> = [];
  const sentMessages: TestSentMessage[] = [];
  const sentUserMessages: Array<{ message: unknown; options: unknown }> = [];
  const activeTools: string[] = [];
  const sourceInfo: SourceInfo = {
    path: `${process.cwd()}/Killeros.ts`,
    source: "npm:killeros",
    baseDir: process.cwd(),
  };
  const api: TestAPI<TEntryData> = {
    appendEntry: (customType: string, data: TEntryData) => {
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
      message: requireTestSentMessage(message),
      options,
    }),
    sendUserMessage: (message: unknown, options?: unknown) => sentUserMessages.push({ message, options }),
    setThinkingLevel: (_level: string) => {},
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools.splice(0, activeTools.length, ...names); },
  };
  Killeros(extensionApiTestAdapter(api), {
    completionNotifications: {
      store: { load: () => false, save: () => {} },
      ring: () => {},
    },
    ...killerosOptions,
  });
  activeTools.push(...tools.keys());
  return { api, activeTools, appendedEntries, commandRegistrations, commands, entryRenderers, handlers, sentMessages, sentUserMessages, tools };
}

export function getCommand(source: Pick<Harness, "commands"> | ReadonlyMap<string, TestCommand>, name: string): TestCommand {
  const commands = "commands" in source ? source.commands : source;
  const command = commands.get(name);
  assert.ok(command);
  return command;
}

export function getTool(source: Pick<Harness, "tools"> | ReadonlyMap<string, TestTool>, name: string): TestTool {
  const tools = "tools" in source ? source.tools : source;
  const tool = tools.get(name);
  assert.ok(tool);
  return tool;
}

export function getRenderer(source: Pick<Harness, "entryRenderers"> | ReadonlyMap<string, TestRenderer>, name: string): TestRenderer {
  const renderers = "entryRenderers" in source ? source.entryRenderers : source;
  const renderer = renderers.get(name);
  assert.ok(renderer);
  return renderer;
}

export function getHandlers(source: Pick<Harness, "handlers"> | ReadonlyMap<string, TestHandler[]>, event: string): TestHandler[] {
  const handlers = "handlers" in source ? source.handlers : source;
  const eventHandlers = handlers.get(event);
  assert.ok(eventHandlers);
  return eventHandlers;
}

function isTestRenderable(value: unknown): value is TestRenderable {
  return isUnknownRecord(value) && typeof value.render === "function";
}

export function requireRenderable(value: unknown): TestRenderable {
  assert.ok(isTestRenderable(value), "expected a renderable Pi component");
  return value;
}

function isTestInteractive(value: unknown): value is TestInteractive {
  return isUnknownRecord(value)
    && typeof value.render === "function"
    && typeof value.handleInput === "function";
}

export function requireInteractive(value: unknown): TestInteractive {
  assert.ok(isTestInteractive(value), "expected an interactive Pi component");
  return value;
}

function isTestEditor(value: unknown): value is TestEditor {
  return isUnknownRecord(value)
    && typeof value.render === "function"
    && typeof value.handleInput === "function"
    && typeof value.setAutocompleteProvider === "function"
    && typeof value.focused === "boolean"
    && typeof value.setText === "function"
    && typeof value.getText === "function";
}

export function requireEditor(value: unknown): TestEditor {
  assert.ok(isTestEditor(value), "expected a Pi editor component");
  return value;
}

export function disposeTestComponent(component: TestRenderable): void {
  assert.ok(component.dispose, "expected a disposable Pi component");
  component.dispose();
}

export function requiredFactory(factory: TestCapturedFactory | undefined, name: string): TestCapturedFactory {
  assert.ok(factory, `expected Pi to register the ${name} factory`);
  return factory;
}

export function last<T>(values: T[]): T {
  const value = values.at(-1);
  assert.ok(value);
  return value;
}

export async function emitSequentially(
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

export function resultReason(results: TestHandlerResult[]): string {
  const result = results.find((candidate) => candidate?.block);
  const reason = result?.reason;
  assert.ok(reason);
  return reason;
}

export async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for asynchronous test state");
}

export async function removeDirectoryEventually(directory: string): Promise<void> {
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

export function createTuiContext(
  entries: TestEntry[] = [],
  uiTheme: Theme = theme,
  sessionManager: TestSessionManager = {
  getBranch: () => entries,
  getEntries: () => entries,
  getSessionFile: () => path.join(process.cwd(), "session.jsonl"),
  },
): { captured: Captured; ctx: TestTuiContext; tui: TestTui } {
  const missingFactory = (): never => assert.fail("expected Pi to register the component factory");
  const captured: Captured = {
    autocompleteFactory: missingFactory,
    currentEditorFactory: undefined,
    footerFactory: missingFactory,
    headerFactory: missingFactory,
    selection: { title: "", options: [] },
    workingMessages: [],
  };
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
      addAutocompleteProvider: (factory: (current: unknown) => TestProvider) => {
        captured.autocompleteFactory = factory;
      },
      confirm: async () => true,
      editor: async (_title: string, prefill?: string) => prefill,
      notify() {},
      select: async (title: string, options: string[]) => {
        captured.selection = { title, options };
        return undefined;
      },
      getEditorComponent: () => captured.currentEditorFactory,
      setEditorComponent: (factory: TestCapturedFactory) => {
        captured.editorFactory = factory;
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
        captured.workingMessages ??= [];
        captured.workingMessages.push(message);
      },
      setWidget: (key: string, content?: unknown, options?: unknown) => {
        captured.widgets ??= [];
        captured.widgets.push({ key, content, options });
        if (typeof content === "function") {
          const render = content as (tui: unknown, theme: unknown) => unknown;
          captured.widgetComponent = render(tui, uiTheme);
        }
        if (content === undefined) captured.widgetComponent = undefined;
      },
      theme: uiTheme,
    },
    waitForIdle: async () => {},
  };
  return { captured, ctx, tui };
}
