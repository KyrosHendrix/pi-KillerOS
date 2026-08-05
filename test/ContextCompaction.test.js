import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
  const entryRenderers = new Map();
  const appendedEntries = [];
  const sentMessages = [];
  const sentUserMessages = [];
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

  Killeros(api);
  activeTools.push(...tools.keys());
  return { api, activeTools, appendedEntries, commands, entryRenderers, handlers, sentMessages, sentUserMessages, tools };
}

function createContext({
  entries = [],
  usage = { tokens: 1_000, contextWindow: 128_000 },
  notifications = [],
  compactCalls = [],
  cwd = process.cwd(),
  model,
  modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: false, error: "No model auth is available" }),
    getProvider: () => undefined,
  },
} = {}) {
  const captured = {};
  const tui = { requestRender() {}, terminal: { rows: 40 } };
  const ctx = {
    cwd,
    getContextUsage: () => (typeof usage === "function" ? usage() : usage),
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode: "tui",
    model,
    modelRegistry,
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => path.join(process.cwd(), "session.jsonl"),
    },
    signal: undefined,
    abort() {},
    compact: (options) => {
      compactCalls.push(options);
    },
    getSystemPrompt: () => "",
    shutdown() {},
    ui: {
      addAutocompleteProvider: (factory) => { captured.autocompleteFactory = factory; },
      confirm: async () => true,
      editor: async (_title, prefill) => prefill,
      notify: (message, level) => notifications.push({ message, level }),
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
  return { captured, compactCalls, ctx, notifications, tui };
}

function createCompactionEvent({ preparation = {}, ...overrides } = {}) {
  return {
    type: "session_before_compact",
    preparation: {
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 80_000,
      firstKeptEntryId: "entry-5",
      previousSummary: undefined,
      fileOps: {
        read: new Set(),
        written: new Set(),
        edited: new Set(),
      },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
      ...preparation,
    },
    branchEntries: [],
    customInstructions: undefined,
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function emitSequentially(handlers, event, ctx) {
  const results = [];
  for (const handler of handlers ?? []) results.push(await handler(event, ctx));
  return results;
}

function getHandler(handlers, event) {
  const registered = handlers.get(event) ?? [];
  assert.ok(registered.length > 0, `${event} handler should be registered`);
  return registered.at(-1);
}

function createSummaryModel({ summary, errorMessage } = {}) {
  const requests = [];
  const model = {
    api: "openai-completions",
    id: "test-model",
    name: "Test model",
    provider: "test",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const modelRegistry = {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    getProvider: () => ({
      streamSimple: (_model, context) => {
        requests.push(context);
        return {
          result: async () => ({
            role: "assistant",
            content: summary ? [{ type: "text", text: summary }] : [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: summary ? 10 : 0,
              output: summary ? 5 : 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: summary ? 15 : 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: errorMessage ? "error" : "stop",
            ...(errorMessage ? { errorMessage } : {}),
            timestamp: Date.now(),
          }),
        };
      },
    }),
  };
  return { model, modelRegistry, requests };
}

test("CompactionRuntime starts with no in-flight compaction", async () => {
  const { createCompactionRuntime } = await import("../killeros/runtime.ts");
  assert.equal(typeof createCompactionRuntime, "function");

  const runtime = createCompactionRuntime();
  assert.equal(runtime.compactionInFlight, false);
  assert.equal(runtime.automaticCompactionArmed, true);
  assert.equal(runtime.automaticCompactionAwaitingHook, false);
  assert.equal(runtime.automaticCompactionPending, false);
  assert.equal(runtime.compactionOperationId, 0);
  assert.equal(runtime.sessionGeneration, 0);
  assert.equal(runtime.lastCompactionAt, undefined);
  assert.equal(runtime.thresholdPercent, 40);
});

test("Killeros registers context compaction handlers", () => {
  const { handlers } = createHarness();
  assert.ok((handlers.get("turn_end") ?? []).length > 0);
  assert.ok((handlers.get("agent_settled") ?? []).length > 0);
  assert.ok((handlers.get("session_before_compact") ?? []).length > 0);
  assert.ok((handlers.get("session_compact") ?? []).length > 0);
  assert.ok((handlers.get("session_start") ?? []).length > 0);
  assert.ok((handlers.get("session_tree") ?? []).length > 0);
  assert.ok((handlers.get("session_shutdown") ?? []).length > 0);
});

test("contextPercentRemaining handles normal and edge usage", async () => {
  const { contextPercentRemaining } = await import("../Killeros.ts");
  assert.equal(typeof contextPercentRemaining, "function");
  const makeContext = (tokens, contextWindow = 128_000) => ({
    getContextUsage: () => ({ tokens, contextWindow }),
  });

  assert.equal(contextPercentRemaining(makeContext(89_600)), 30);
  assert.equal(contextPercentRemaining(makeContext(64_000)), 50);
  assert.equal(contextPercentRemaining(makeContext(115_200)), 10);
  assert.equal(contextPercentRemaining(makeContext(0)), 100);
  assert.equal(contextPercentRemaining(makeContext(128_000)), 0);
  assert.equal(contextPercentRemaining(makeContext(200_000)), 0);
  assert.equal(contextPercentRemaining(makeContext(-1)), 100);
  assert.equal(contextPercentRemaining(makeContext(1, 0)), null);
  assert.equal(contextPercentRemaining(makeContext(1, -1)), null);
});

test("contextPercentRemaining treats unknown usage as unknown", async () => {
  const { contextPercentRemaining } = await import("../Killeros.ts");
  assert.equal(contextPercentRemaining({ getContextUsage: () => undefined }), null);
  assert.equal(contextPercentRemaining({ getContextUsage: () => null }), null);
  assert.equal(contextPercentRemaining({
    getContextUsage: () => ({ tokens: null, contextWindow: 128_000, percent: null }),
  }), null);
  assert.equal(contextPercentRemaining({
    getContextUsage: () => ({ contextWindow: 128_000 }),
  }), null);
});

test("manual and threshold compaction use Pi's model summarizer", async () => {
  for (const reason of ["manual", "threshold"]) {
    const { handlers } = createHarness();
    const { model, modelRegistry, requests } = createSummaryModel({
      summary: `Model summary for ${reason}`,
    });
    const { ctx } = createContext({ model, modelRegistry });
    const result = await getHandler(handlers, "session_before_compact")(
      createCompactionEvent({
        customInstructions: "Keep the auth decision.",
        reason,
        preparation: {
          messagesToSummarize: [
            { role: "user", content: [{ type: "text", text: "Fix authentication." }] },
          ],
        },
      }),
      ctx,
    );

    assert.match(result.compaction.summary, new RegExp(`Model summary for ${reason}`, "u"));
    assert.doesNotMatch(result.compaction.summary, /produced deterministically/u);
    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content[0].text, /Additional focus: Keep the auth decision\./u);
  }
});

test("deterministic compaction waits for model retries to exhaust", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "killeros-compaction-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  }));

  const { handlers } = createHarness();
  const notifications = [];
  const { model, modelRegistry, requests } = createSummaryModel({ errorMessage: "terminated" });
  const { ctx } = createContext({ cwd, model, modelRegistry, notifications });

  const result = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({
      reason: "manual",
      preparation: {
        messagesToSummarize: [
          { role: "user", content: [{ type: "text", text: "Keep this context." }] },
        ],
      },
    }),
    ctx,
  );

  assert.equal(requests.length, 3, "the initial model call and both configured retries must run first");
  assert.match(result.compaction.summary, /^This summary was produced deterministically/u);
  assert.match(notifications.at(-1).message, /Model compaction failed: Summarization failed: terminated/u);
});

test("overflow compaction returns Pi fields and a disclosed structured fallback", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const { ctx } = createContext({
    notifications,
    usage: { tokens: 80_000, contextWindow: 128_000 },
  });
  const event = createCompactionEvent({
    reason: "overflow",
    willRetry: true,
    preparation: {
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "Fix the login bug in src/auth/login.ts." }] },
        { role: "assistant", content: [{ type: "text", text: "Done: I found the auth failure and decided to keep the current session format." }] },
        { role: "assistant", content: [{ type: "text", text: "In Progress: test/auth.test.js, still needs the final regression run." }] },
      ],
      turnPrefixMessages: [
        { role: "assistant", content: [{ type: "text", text: "Next, run test/auth.test.js after the fix." }] },
      ],
      tokensBefore: 80_000,
      firstKeptEntryId: "entry-5",
    },
  });

  const result = await getHandler(handlers, "session_before_compact")(event, ctx);
  assert.equal(typeof result.compaction.summary, "string");
  assert.equal(result.compaction.firstKeptEntryId, "entry-5");
  assert.equal(result.compaction.tokensBefore, 80_000);
  assert.equal(result.cancel, undefined);

  const summary = result.compaction.summary;
  assert.match(summary, /^This summary was produced deterministically without model understanding\./u);
  assert.match(summary, /# KillerOS Compaction Summary/u);
  assert.match(summary, /## Goal\s+[\s\S]*Fix the login bug/u);
  assert.match(summary, /## Progress\s+[\s\S]*### Done\s+[\s\S]*auth failure[\s\S]*### In Progress\s+[\s\S]*final regression run[\s\S]*## Key Decisions/u);
  assert.match(summary, /## Key Decisions\s+[\s\S]*Extracted from conversation context/u);
  assert.match(summary, /## Next Steps\s+[\s\S]*Continue the task from where it was interrupted/u);
  assert.match(summary, /## Modified Files\s+[\s\S]*src\/auth\/login\.ts/u);
  const modifiedFiles = summary.slice(summary.indexOf("## Modified Files"));
  assert.match(modifiedFiles, /(?:^|\n)- src\/auth\/login\.ts(?:\r?\n|$)/u);
  assert.match(modifiedFiles, /(?:^|\n)- test\/auth\.test\.js(?:\r?\n|$)/u);
  assert.doesNotMatch(modifiedFiles, /(?:login\.ts|test\.js)[.,;]/u);
  assert.equal(result.compaction.details.killerosDeterministicFallback, true);

  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact",
    compactionEntry: result.compaction,
    fromExtension: true,
    reason: "overflow",
    willRetry: true,
  }, ctx);
  assert.match(notifications.at(-1).message, /multiple compactions can cause the model to be less accurate/u);
  assert.equal(notifications.at(-1).level, "warning");
});

test("compaction summary uses Pi file operation paths", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext();
  const result = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({
      reason: "overflow",
      preparation: {
        fileOps: {
          read: new Set(["README.md"]),
          written: new Set(["src/new-file.ts"]),
          edited: new Set(["src/changed-file.ts"]),
        },
      },
    }),
    ctx,
  );

  const modifiedFiles = result.compaction.summary.slice(result.compaction.summary.indexOf("## Modified Files"));
  assert.match(modifiedFiles, /(?:^|\n)- src\/new-file\.ts(?:\r?\n|$)/u);
  assert.match(modifiedFiles, /(?:^|\n)- src\/changed-file\.ts(?:\r?\n|$)/u);
  assert.doesNotMatch(modifiedFiles, /README\.md/u);
});

test("compaction summary carries the previous summary", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext();
  const result = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({
      reason: "overflow",
      preparation: {
        previousSummary: "The database schema and migration are already complete.",
      },
    }),
    ctx,
  );

  assert.match(result.compaction.summary, /## Previous Summary/u);
  assert.match(result.compaction.summary, /database schema and migration are already complete/u);
});

test("compaction summary keeps the tail of a long previous summary", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext();
  const result = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({
      reason: "overflow",
      preparation: {
        previousSummary: `${"Earlier progress. ".repeat(500)}\n## Modified Files\n- retained-at-tail.ts`,
      },
    }),
    ctx,
  );

  assert.match(result.compaction.summary, /retained-at-tail\.ts/u);
});

test("compaction summary carries custom instructions", async () => {
  const { handlers } = createHarness();
  const { ctx } = createContext();
  const result = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({
      customInstructions: "Keep the handoff short and verify the API contract.",
      reason: "overflow",
    }),
    ctx,
  );

  assert.match(result.compaction.summary, /## Custom Instructions/u);
  assert.match(result.compaction.summary, /Keep the handoff short and verify the API contract\./u);
});

test("compaction summary uses the active goal objective", async () => {
  const { commands, handlers } = createHarness();
  const { ctx } = createContext();
  await commands.get("goal").handler("Implement user authentication", ctx);

  const result = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({ reason: "overflow" }),
    ctx,
  );
  assert.match(result.compaction.summary, /## Goal\s+Implement user authentication/u);
});

test("threshold compacts after the run settles and stays quiet above it", async () => {
  const { handlers } = createHarness();
  const thresholdNotifications = [];
  const thresholdCompactions = [];
  const { ctx: thresholdCtx } = createContext({
    usage: { tokens: 76_800, contextWindow: 128_000 },
    notifications: thresholdNotifications,
    compactCalls: thresholdCompactions,
  });
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, thresholdCtx);
  assert.equal(thresholdNotifications.length, 1);
  assert.equal(thresholdNotifications[0].level, "warning");
  assert.match(thresholdNotifications[0].message, /40% remaining/u);
  assert.match(thresholdNotifications[0].message, /automatic compaction/iu);
  assert.equal(thresholdCompactions.length, 0, "compaction must wait for the settled boundary");
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 1,
    message: {},
    toolResults: [],
  }, thresholdCtx);
  assert.equal(thresholdNotifications.length, 1, "threshold warning should not repeat every turn");
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, thresholdCtx);
  assert.equal(thresholdCompactions.length, 1);
  assert.equal(typeof thresholdCompactions[0].onError, "function");
  assert.match(thresholdNotifications.at(-1).message, /Compacting automatically/u);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, thresholdCtx);
  assert.equal(thresholdCompactions.length, 1, "an in-flight compaction must not repeat");

  const justAboveNotifications = [];
  const justAboveCompactions = [];
  const { ctx: justAboveCtx } = createContext({
    usage: { tokens: 76_200, contextWindow: 128_000 },
    notifications: justAboveNotifications,
    compactCalls: justAboveCompactions,
  });
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 2,
    message: {},
    toolResults: [],
  }, justAboveCtx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, justAboveCtx);
  assert.equal(justAboveNotifications.length, 0, "40.47% remaining is above the exact threshold");
  assert.equal(justAboveCompactions.length, 0);

  const aboveThresholdNotifications = [];
  const aboveThresholdCompactions = [];
  const { ctx: aboveThresholdCtx } = createContext({
    usage: { tokens: 64_000, contextWindow: 128_000 },
    notifications: aboveThresholdNotifications,
    compactCalls: aboveThresholdCompactions,
  });
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, aboveThresholdCtx);
  assert.equal(aboveThresholdNotifications.length, 0);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, aboveThresholdCtx);
  assert.equal(aboveThresholdCompactions.length, 0);
});

test("automatic compaction reports failure and releases its guard", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    notifications,
    compactCalls,
  });

  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 1);
  compactCalls[0].onError(new Error("summarizer unavailable"));
  assert.match(notifications.at(-1).message, /summarizer unavailable/u);
  assert.match(notifications.at(-1).message, /\/compact/u);

  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 2, "a failed request must not leave the guard stuck");
});

test("cancelled automatic compaction releases its guard", async () => {
  const { handlers } = createHarness();
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    compactCalls,
  });
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  const controller = new AbortController();
  await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({ signal: controller.signal }),
    ctx,
  );
  controller.abort();
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 2, "a cancelled request must not leave the guard stuck");
});

test("stale compaction failure callbacks are ignored after session shutdown", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    notifications,
    compactCalls,
  });
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  const onError = compactCalls[0].onError;
  await emitSequentially(handlers.get("session_shutdown"), { type: "session_shutdown", reason: "quit" }, ctx);
  onError(new Error("stale failure"));
  assert.equal(notifications.length, 1, "shutdown must suppress stale failure UI");
});

test("stale compaction failure callbacks are ignored after tree navigation", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    notifications,
    compactCalls,
  });
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  const onError = compactCalls[0].onError;
  await emitSequentially(handlers.get("session_tree"), { type: "session_tree", newLeafId: "new", oldLeafId: "old" }, ctx);
  onError(new Error("stale failure"));
  assert.equal(notifications.length, 1, "tree navigation must suppress stale failure UI");
});

test("overlapping compactions cancel the later request", async () => {
  const { handlers } = createHarness();
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    compactCalls,
  });
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  const first = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({ signal: new AbortController().signal }),
    ctx,
  );
  const second = await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({ signal: new AbortController().signal }),
    ctx,
  );
  assert.ok(first.compaction);
  assert.equal(second.cancel, true);
});

test("successful compaction waits for a new threshold crossing", async () => {
  const { handlers } = createHarness();
  const compactCalls = [];
  let usage = { tokens: 89_600, contextWindow: 128_000 };
  const { ctx } = createContext({
    usage: () => usage,
    compactCalls,
  });

  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 1);
  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: true,
    reason: "manual",
    willRetry: false,
  }, ctx);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 1, "the same low reading must not retrigger compaction");

  usage = { tokens: 64_000, contextWindow: 128_000 };
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 1,
    message: {},
    toolResults: [],
  }, ctx);
  usage = { tokens: 89_600, contextWindow: 128_000 };
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 2,
    message: {},
    toolResults: [],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 2, "compaction must re-arm after usage rises above the threshold");
});

test("goal continuation waits for automatic compaction to finish", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    compactCalls,
  });

  await commands.get("goal").handler("Keep working until the task is complete", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    prompt: "",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  assert.equal(compactCalls.length, 1);
  assert.equal(sentMessages.length, 1, "the goal must wait for compaction");

  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: true,
    reason: "manual",
    willRetry: false,
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.length, 2, "the goal must continue after compaction");
});

test("failed automatic compaction pauses an active goal", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness();
  const compactCalls = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    compactCalls,
  });

  await commands.get("goal").handler("Keep working safely", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    prompt: "",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  compactCalls[0].onError(new Error("summarizer unavailable"));

  assert.equal(appendedEntries.at(-1).data.state.status, "paused");
  assert.match(appendedEntries.at(-1).data.state.result, /summarizer unavailable/u);
  assert.equal(sentMessages.length, 1, "a failed compaction must not resume the goal");
});

test("failed Pi-owned compaction pauses a goal that was waiting for it", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness();
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
  });

  await commands.get("goal").handler("Keep working safely", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    prompt: "",
    systemPrompt: "base",
    systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  const controller = new AbortController();
  await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({ signal: controller.signal, reason: "manual" }),
    ctx,
  );
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  controller.abort();

  assert.equal(appendedEntries.at(-1).data.state.status, "paused");
  assert.match(appendedEntries.at(-1).data.state.result, /context compaction failed/u);
  assert.equal(sentMessages.length, 1, "a failed Pi-owned compaction must not resume the goal");
});

test("a stale automatic failure cannot clear a newer compaction", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const compactCalls = [];
  let usage = { tokens: 89_600, contextWindow: 128_000 };
  const { ctx } = createContext({
    usage: () => usage,
    notifications,
    compactCalls,
  });

  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  const firstFailure = compactCalls[0].onError;
  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: true,
    reason: "manual",
    willRetry: false,
  }, ctx);

  usage = { tokens: 64_000, contextWindow: 128_000 };
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, ctx);
  usage = { tokens: 89_600, contextWindow: 128_000 };
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 1,
    message: {},
    toolResults: [],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 2);

  firstFailure(new Error("stale failure"));
  assert.equal(notifications.filter(({ level }) => level === "error").length, 0);
  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: true,
    reason: "manual",
    willRetry: false,
  }, ctx);
});

test("turn_end does not warn for unknown usage or while compaction is in flight", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const { ctx } = createContext({
    usage: { tokens: null, contextWindow: 128_000, percent: null },
    notifications,
  });
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, ctx);
  assert.equal(notifications.length, 0);

  const lowUsage = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    notifications,
  });
  await getHandler(handlers, "session_before_compact")(createCompactionEvent(), lowUsage.ctx);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, lowUsage.ctx);
  assert.equal(notifications.length, 1, "in-flight compaction must suppress a threshold warning");
});

test("compaction lifecycle clears in-flight state and permits a new warning", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    notifications,
  });
  const beforeEvent = createCompactionEvent();

  await getHandler(handlers, "session_before_compact")(beforeEvent, ctx);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, ctx);
  assert.equal(notifications.length, 1, "in-flight compaction must suppress a threshold warning");

  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact",
    compactionEntry: {},
    fromExtension: true,
    reason: "threshold",
    willRetry: false,
  }, ctx);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 1,
    message: {},
    toolResults: [],
  }, ctx);
  assert.equal(notifications.length, 2);

  notifications.length = 0;
  await getHandler(handlers, "session_before_compact")(beforeEvent, ctx);
  await emitSequentially(handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 2,
    message: {},
    toolResults: [],
  }, ctx);
  assert.equal(notifications.length, 2);

  notifications.length = 0;
  await getHandler(handlers, "session_before_compact")(beforeEvent, ctx);
  await emitSequentially(handlers.get("session_shutdown"), { type: "session_shutdown", reason: "quit" }, ctx);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 3,
    message: {},
    toolResults: [],
  }, ctx);
  assert.equal(notifications.length, 2);
});

test("aborted compaction clears in-flight state", async () => {
  const { handlers } = createHarness();
  const notifications = [];
  const { ctx } = createContext({
    usage: { tokens: 89_600, contextWindow: 128_000 },
    notifications,
  });
  const controller = new AbortController();

  await getHandler(handlers, "session_before_compact")(
    createCompactionEvent({ signal: controller.signal }),
    ctx,
  );
  controller.abort();
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end",
    turnIndex: 0,
    message: {},
    toolResults: [],
  }, ctx);

  assert.equal(notifications.length, 2);
});

test("the main entry exports the extension and contextPercentRemaining", async () => {
  const entry = await import("../Killeros.ts");
  assert.equal(typeof entry.default, "function");
  assert.equal(typeof entry.contextPercentRemaining, "function");
});
