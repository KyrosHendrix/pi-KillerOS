import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { createHarness, createTuiContext, emitSequentially, getCommand, getHandlers, getTool, last, type TestHandler } from "./ExtensionTestHarness.ts";
type GoalEntryState = {
  status: string;
  result: string;
  turns: number;
  objective?: string;
  blockerAudit?: unknown;
  [key: string]: unknown;
};

type GoalEntryData = {
  state: GoalEntryState;
  event?: string;
  [key: string]: unknown;
};


type TestNotification = { message: string; level?: string };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("goal updates use a Google-compatible status enum", () => {
  const tool = getTool(createHarness<GoalEntryData>(), "killeros_goal_update");
  const rawSchema: unknown = JSON.parse(JSON.stringify(tool.parameters));
  assert.ok(isUnknownRecord(rawSchema));
  const properties = rawSchema.properties;
  assert.ok(isUnknownRecord(properties));

  assert.deepEqual(properties.status, {
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

async function emitGoalStart(handlers: Map<string, TestHandler[]>, ctx: unknown): Promise<void> {
  for (const handler of getHandlers(handlers, "before_agent_start") ?? []) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
}

test("strict goal start validates controls atomically", async () => {
  const { appendedEntries, commands } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Existing objective", ctx);
  const writes = appendedEntries.length;
  for (const malformed of [
    "start --turns 0 -- Invalid",
    "start --turns 2 --turns 3 -- Invalid",
    "start --unknown value -- Invalid",
    "start --turns 2 Invalid",
    "start positional -- Invalid",
    "start --check Bad -- Invalid",
  ]) {
    await getCommand(commands, "goal").handler(malformed, ctx);
    assert.equal(appendedEntries.length, writes, malformed);
  }

  const controlled = createHarness<GoalEntryData>();
  const controlledContext = createTuiContext().ctx;
  await getCommand(controlled.commands, "goal").handler("start --turns 2 -- Objective with -- later text", controlledContext);
  const state = last(controlled.appendedEntries).data.state;
  assert.equal(state.objective, "Objective with -- later text");
  assert.equal(state.maxTurns, 2);
  assert.equal(controlled.sentMessages.length, 1);

  const unbounded = createHarness<GoalEntryData>();
  await getCommand(unbounded.commands, "goal").handler("start -- Objective without controls", createTuiContext().ctx);
  assert.equal(last(unbounded.appendedEntries).data.state.objective, "Objective without controls");
});

test("plain goals preserve objectives that begin with control words", async () => {
  for (const objective of [
    "Start reliably",
    "Clear stale generated files",
    "Edit the release notes",
    "Pause scheduled work safely",
    "Resume interrupted downloads",
    "Check the release artifacts carefully",
    "Limit dependency updates carefully",
    "History of the migration effort",
  ]) {
    const { appendedEntries, commands } = createHarness<GoalEntryData>();
    await getCommand(commands, "goal").handler(objective, createTuiContext().ctx);
    assert.equal(last(appendedEntries).data.state.objective, objective);
  }
});

test("turn limits pause at settlement and refuse exhausted resume", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const settle = async () => {
    await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  };
  await getCommand(commands, "goal").handler("start --turns 2 -- Finish in two turns", ctx);
  assert.equal(sentMessages.length, 1);
  await settle();
  assert.equal(sentMessages.length, 2);
  await settle();
  assert.equal(sentMessages.length, 2);
  assert.equal(last(appendedEntries).data.event, "limit");
  assert.equal(last(appendedEntries).data.state.status, "paused");

  await getCommand(commands, "goal").handler("resume", ctx);
  assert.equal(last(appendedEntries).data.state.status, "paused");
  await getCommand(commands, "goal").handler("limit clear", ctx);
  assert.equal(last(appendedEntries).data.state.maxTurns, undefined);
  assert.equal(last(appendedEntries).data.state.status, "paused");
});

test("completion wins on the last allowed goal turn", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("start --turns 1 -- Complete now", ctx);
  await getTool(tools, "killeros_goal_update").execute(
    "complete-at-limit",
    { status: "complete", evidence: "Verified" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  assert.equal(last(appendedEntries).data.state.status, "complete");
  assert.equal(sentMessages.length, 1);
});

test("goal history scans the active branch without writing state", async () => {
  const now = Date.now();
  const state = (revision: number, status: "active" | "paused", turns: number, result?: string) => ({
    version: 1,
    revision,
    objective: "Ship the release",
    status,
    createdAt: now - 60_000,
    updatedAt: now,
    activeMilliseconds: 60_000,
    ...(status === "active" ? { activeStartedAt: now } : {}),
    turns,
    blockedAuditStartTurn: 0,
    baselineTokens: 10,
    ...(result === undefined ? {} : { result }),
  });
  const entries = [
    { type: "custom", customType: "killeros-goal", data: { version: 1, event: "set", state: state(1, "active", 0) } },
    { type: "message", message: { role: "assistant", usage: { totalTokens: 110 } } },
    { type: "custom", customType: "killeros-goal", data: { version: 1, event: "turn", state: state(2, "active", 1) } },
    { type: "custom", customType: "killeros-goal", data: { version: 1, event: "pause", state: state(3, "paused", 1, "Waiting") } },
    { type: "custom", customType: "killeros-goal", data: { version: 1, event: "complete", state: { broken: true } } },
  ];
  const { appendedEntries, commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(entries);
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("history 1", ctx);
  assert.match(last(notifications).message, /pause  turn 1  100 tokens  Waiting/u);
  assert.doesNotMatch(last(notifications).message, /\bturn  turn\b/u);
  assert.equal(appendedEntries.length, 0);
  assert.equal(sentMessages.length, 0);
  await getCommand(commands, "goal").handler("history 51", ctx);
  assert.equal(last(notifications).message, "Usage: /goal history [count]");
});

test("registers /goal and completes only through the model goal tool", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  assert.equal(commands.has("goal"), true);
  assert.equal(tools.has("killeros_goal_update"), true);

  await getCommand(commands, "goal").handler("Ship only after every release check passes", ctx);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message.customType, "killeros-goal-continuation");
  assert.match(sentMessages[0].message.content, /Ship only after every release check passes/u);
  assert.match(sentMessages[0].message.content, /killeros_goal_update/u);
  assert.match(sentMessages[0].message.content, /exact objective above from \/goal/u);
  assert.match(sentMessages[0].message.content, /first concrete next step/u);
  assert.match(sentMessages[0].message.content, /checking the current repository state/u);
  assert.doesNotMatch(sentMessages[0].message.content, /hidden handoff|stored progress copy/u);
  assert.deepEqual(sentMessages[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(last(appendedEntries).customType, "killeros-goal");
  assert.equal(last(appendedEntries).data.state.status, "active");

  let systemPrompt = "base";
  for (const handler of getHandlers(handlers, "before_agent_start")) {
    const result = await handler({ prompt: "", systemPrompt, systemPromptOptions: {} }, ctx);
    if (result?.systemPrompt) systemPrompt = result.systemPrompt;
  }
  assert.match(systemPrompt, /Active KillerOS goal/u);
  assert.match(systemPrompt, /Ship only after every release check passes/u);
  assert.match(systemPrompt, /killeros_goal_update/u);

  const update = await getTool(tools, "killeros_goal_update").execute(
    "goal-complete",
    { status: "complete", evidence: "npm test and npm run check passed" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.match(update.content[0].text, /marked complete/u);
  assert.equal(last(appendedEntries).data.state.status, "complete");

  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 1, "completed goals must not continue");

  ctx.mode = "rpc";
  await getCommand(commands, "goal").handler("", ctx);
  assert.match(last(notifications).message, /Goal complete/u);
  assert.match(last(notifications).message, /npm test and npm run check passed/u);
});

test("bare /goal opens a context-valid action panel in TUI mode", async () => {
  const { appendedEntries, commands } = createHarness<GoalEntryData>();
  const { captured, ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Ship the release", ctx);
  ctx.ui.select = async (title, options) => {
    captured.selection = { title, options };
    return "Pause automatic continuation";
  };

  await getCommand(commands, "goal").handler("", ctx);
  assert.match(captured.selection.title, /Goal active/u);
  assert.match(captured.selection.title, /Ship the release/u);
  assert.deepEqual(captured.selection.options, [
    "Pause automatic continuation",
    "Edit objective",
    "Clear goal",
  ]);
  assert.equal(last(appendedEntries).data.state.status, "paused");
});

test("goal panel confirms clear and leaves direct goal commands compatible", async () => {
  const { appendedEntries, commands } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  let abortCalls = 0;
  let confirmation: { message: string; title: string } | undefined;
  ctx.abort = () => { abortCalls += 1; };
  await getCommand(commands, "goal").handler("Keep \x1b]2;owned\x07\x1b[31mthis\x1b[0m\0 goal", ctx);
  ctx.ui.select = async () => "Clear goal";
  ctx.ui.confirm = async (title, message) => {
    assert.ok(typeof title === "string");
    assert.ok(typeof message === "string");
    confirmation = { title, message };
    return false;
  };
  await getCommand(commands, "goal").handler("", ctx);
  assert.deepEqual(confirmation, { title: "Clear goal?", message: "Keep this goal" });
  assert.notEqual(last(appendedEntries).data.state, null);
  assert.equal(abortCalls, 0);

  ctx.ui.confirm = async () => true;
  await getCommand(commands, "goal").handler("", ctx);
  assert.equal(last(appendedEntries).data.state, null);
  assert.equal(abortCalls, 1);

  await getCommand(commands, "goal").handler("Direct clear", ctx);
  await getCommand(commands, "goal").handler("clear", ctx);
  assert.equal(last(appendedEntries).data.state, null);
});

test("goal panel actions match paused, blocked, and complete states", async () => {
  const unsafeObjective = "\x1b]2;owned\x07\x1b[31mobjective\x1b[0m\0";
  const unsafeResult = "\x1b]2;owned\x07\x1b[31mverified\x1b[0m\0";
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
        objective: `${status} ${unsafeObjective}`,
        status,
        createdAt: now,
        updatedAt: now,
        activeMilliseconds: 0,
        turns: 3,
        blockedAuditStartTurn: 0,
        baselineTokens: 0,
        ...(status === "blocked" || status === "complete" ? { result: unsafeResult } : {}),
      } },
    }];
    const { commands, handlers } = createHarness<GoalEntryData>();
    const { captured, ctx } = createTuiContext(entries);
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await getCommand(commands, "goal").handler("", ctx);
    assert.deepEqual(captured.selection.options, options, status);
    assert.match(captured.selection.title, new RegExp(`${status} objective`, "u"), status);
    assert.doesNotMatch(captured.selection.title, /\x1b|\x07|\0/u, status);
    if (status === "complete") assert.match(captured.selection.title, /verified/u);
  }
});

test("/goal custom-message continuations enter goal turns without before_agent_start", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();

  await getCommand(commands, "goal").handler("Audit the host continuation lifecycle", ctx);

  assert.match(sentMessages[0].message.content, /Status: active · Turn: 1/u);
  assert.equal(last(appendedEntries.filter((entry) => entry.data.event === "turn")).data.state.turns, 1);
  const first = await getTool(tools, "killeros_goal_update").execute(
    "first-host-turn",
    { status: "blocked", blockerKey: "host-lifecycle", evidence: "The same external blocker remains" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const duplicate = await getTool(tools, "killeros_goal_update").execute(
    "duplicate-host-turn",
    { status: "blocked", blockerKey: "host-lifecycle", evidence: "Duplicate audit in the same turn" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(first.details.streak, 1);
  assert.equal(duplicate.details.streak, 1);

  await emitSequentially(getHandlers(handlers, "agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);

  assert.match(sentMessages[1].message.content, /Status: active · Turn: 2/u);
  assert.equal(last(appendedEntries.filter((entry) => entry.data.event === "turn")).data.state.turns, 2);
  const second = await getTool(tools, "killeros_goal_update").execute(
    "second-host-turn",
    { status: "blocked", blockerKey: "host-lifecycle", evidence: "The blocker remains on the next turn" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(second.details.streak, 2);
});

test("/goal continues one turn at a time and pause stops future turns", async () => {
  const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Finish the migration", ctx);
  assert.equal(sentMessages.length, 1);

  await emitGoalStart(handlers, ctx);
  await emitSequentially(getHandlers(handlers, "agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].message.content, /Finish the migration/u);

  await getCommand(commands, "goal").handler("pause", ctx);
  await emitSequentially(getHandlers(handlers, "agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 2, "a paused goal must not enqueue another continuation");
});

test("/goal pauses when a dispatched continuation settles without an agent result", async () => {
  const { appendedEntries, commands, handlers } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Start reliably", ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.match(lastGoalEntry.data.state.result, /without an agent result/u);
  assert.equal(lastGoalEntry.data.state.turns, 1);
});

test("/goal does not report start, resume, or edit success after dispatch failure", async () => {
  for (const control of ["start", "resume", "edit"]) {
    const { api, appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext();
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });

    if (control === "start") {
      api.sendMessage = () => { throw new Error("provider unavailable"); };
      await getCommand(commands, "goal").handler("Start reliably", ctx);
    } else {
      await getCommand(commands, "goal").handler("Original objective", ctx);
      api.sendMessage = () => { throw new Error("provider unavailable"); };
      if (control === "resume") {
        await getCommand(commands, "goal").handler("pause", ctx);
        await getCommand(commands, "goal").handler("resume", ctx);
      } else {
        ctx.waitForIdle = async () => {
          await emitSequentially(getHandlers(handlers, "agent_end"), {
            messages: [{ role: "assistant", stopReason: "stop" }],
          }, ctx);
          await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
        };
        ctx.ui.editor = async () => "Edited objective";
        await getCommand(commands, "goal").handler("edit", ctx);
      }
    }

    const state = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal")).data.state;
    assert.equal(state.status, "paused", `${control} failure must pause the goal`);
    assert.match(state.result, /continuation could not start: provider unavailable/u);
    assert.equal(sentMessages.length, control === "start" ? 0 : 1);
    assert.equal(notifications.some(({ message }) => new RegExp(control === "start" ? "Goal active" : control === "resume" ? "Goal resumed" : "Goal updated and active", "u").test(message)), false);
    assert.equal(last(notifications).level, "error");
  }
});

test("/goal reports start, resume, and edit success after dispatch", async () => {
  const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  await getCommand(commands, "goal").handler("Original objective", ctx);
  assert.match(last(notifications).message, /Goal active/u);
  await getCommand(commands, "goal").handler("pause", ctx);
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.match(last(notifications).message, /Goal resumed/u);
  ctx.waitForIdle = async () => {
    await emitSequentially(getHandlers(handlers, "agent_end"), {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  };
  ctx.ui.editor = async () => "Edited objective";
  await getCommand(commands, "goal").handler("edit", ctx);
  assert.match(last(notifications).message, /Goal updated and active/u);
  assert.equal(sentMessages.length, 3);
});

test("/goal waits for an unrelated active run to settle before dispatch", async () => {
  const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  let idle = false;
  ctx.isIdle = () => idle;

  await getCommand(commands, "goal").handler("Start after unrelated work", ctx);
  assert.equal(sentMessages.length, 0);
  idle = true;
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message.content, /Start after unrelated work/u);
});

test("/goal does not claim success when a pending message defers dispatch", async () => {
  const { appendedEntries, commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  ctx.hasPendingMessages = () => true;

  await getCommand(commands, "goal").handler("Wait for the pending message", ctx);
  assert.equal(sentMessages.length, 0);
  assert.equal(last(appendedEntries).data.state.status, "active");
  assert.equal(notifications.some(({ message }) => /Goal active/u.test(message)), false);
});

test("/goal pauses after an aborted or failed goal turn", async () => {
  const { appendedEntries, commands, handlers } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Recover the deployment", ctx);
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  for (const handler of getHandlers(handlers, "before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
  await emitSequentially(getHandlers(handlers, "agent_end"), {
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "\x1b]2;owned\x07\x1b[31mprovider\x1b[0m\0 unavailable" }],
  }, ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.equal(lastGoalEntry.data.state.result, "provider unavailable");
  assert.deepEqual(notifications, [{
    message: "Goal paused: provider unavailable\nRun /goal resume after resolving the problem.",
    level: "error",
  }]);
});

test("/goal edit, pause, resume, and clear persist explicit transitions", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Original objective", ctx);

  await getCommand(commands, "goal").handler("pause", ctx);
  assert.equal(last(appendedEntries).data.state.status, "paused");

  await getCommand(commands, "goal").handler("resume", ctx);
  assert.equal(last(appendedEntries).data.state.status, "active");
  assert.equal(sentMessages.length, 2);

  for (const handler of getHandlers(handlers, "before_agent_start")) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
  ctx.ui.editor = async () => "Edited objective";
  await getCommand(commands, "goal").handler("edit", ctx);
  const editEntry = last(appendedEntries.filter((entry) => entry.data.event === "edit"));
  assert.equal(editEntry.data.state.objective, "Edited objective");
  assert.equal(last(appendedEntries).data.state.status, "active");

  await getCommand(commands, "goal").handler("clear", ctx);
  assert.equal(last(appendedEntries).data.event, "clear");
  assert.equal(last(appendedEntries).data.state, null);
});

test("/goal pause and clear stop continuation when their first session write fails", async () => {
  for (const control of ["pause", "clear"]) {
    const { api, appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext();
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
    await getCommand(commands, "goal").handler(`Safely ${control} this goal`, ctx);
    assert.equal(sentMessages.length, 1);

    const appendEntry = api.appendEntry;
    let failed = false;
    api.appendEntry = (...args) => {
      if (!failed) {
        failed = true;
        throw new Error("\x1b]2;owned\x07\x1b[31mtransient\x1b[0m\0 session write failure");
      }
      return appendEntry(...args);
    };

    await getCommand(commands, "goal").handler(control, ctx);
    const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
    assert.equal(lastGoalEntry.data.state.status, "paused");
    assert.equal(lastGoalEntry.data.state.result, `the requested ${control} could not be saved: transient session write failure`);
    assert.equal(last(notifications).message, control === "pause"
      ? "Goal paused: the requested pause could not be saved: transient session write failure\nAutomatic continuation is stopped. If session storage is still unavailable, retry /goal pause after it recovers."
      : "Goal paused: the requested clear could not be saved\nAutomatic continuation is stopped. Retry /goal clear to remove the goal.");

    await emitSequentially(getHandlers(handlers, "agent_end"), {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    assert.equal(sentMessages.length, 1, `${control} failure must not schedule another continuation`);
  }
});

test("/goal pause can save an in-memory fallback after persistence recovers", async () => {
  const { api, appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("Pause even if storage fails", ctx);

  const appendEntry = api.appendEntry;
  api.appendEntry = () => { throw new Error("persistent session write failure"); };
  await getCommand(commands, "goal").handler("pause", ctx);
  assert.match(last(notifications).message, /Automatic continuation is stopped/u);

  api.appendEntry = appendEntry;
  await getCommand(commands, "goal").handler("pause", ctx);
    const lastGoalEntry = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal"));
  assert.equal(lastGoalEntry.data.event, "pause");
  assert.equal(lastGoalEntry.data.state.status, "paused");
  assert.match(last(notifications).message, /Goal pause saved/u);

  await emitSequentially(getHandlers(handlers, "agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  assert.equal(sentMessages.length, 1);
});
