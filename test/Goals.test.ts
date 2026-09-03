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

test("goal set uses five forms with a 20-turn default", async () => {
  const { appendedEntries, commands } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Existing objective", ctx);
  assert.equal(last(appendedEntries).data.state.maxTurns, 20);
  assert.equal(last(appendedEntries).data.state.objective, "Existing objective");
  const replacement = createHarness<GoalEntryData>();
  const replacementContext = createTuiContext().ctx;
  replacementContext.ui.confirm = async () => true;
  await getCommand(replacement.commands, "goal").handler("First objective", replacementContext);
  await getCommand(replacement.commands, "goal").handler("Replacement objective", replacementContext);
  assert.equal(last(replacement.appendedEntries).data.event, "replace");
  assert.equal(last(replacement.appendedEntries).data.state.maxTurns, 20);
  assert.equal(last(replacement.appendedEntries).data.state.objective, "Replacement objective");
});

test("removed command words start goals as plain objectives", async () => {
  for (const objective of ["Start reliably", "Check the release", "Checks pass", "Limit latency", "History of changes", "Clear the cache", "Edit the file", "history 10", "check quality"]) {
    const harness = createHarness<GoalEntryData>();
    await getCommand(harness.commands, "goal").handler(objective, createTuiContext().ctx);
    assert.equal(last(harness.appendedEntries).data.state.objective, objective);
  }
});

test("bare lifecycle controls match case-insensitively while longer text stays an objective", async () => {
  for (const [control, spelling] of [["pause", "PAUSE"], ["resume", "Resume"], ["clear", "clear"]] as const) {
    const { appendedEntries, commands } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext();
    await getCommand(commands, "goal").handler("Some objective", ctx);
    if (control === "resume") await getCommand(commands, "goal").handler("pause", ctx);
    await getCommand(commands, "goal").handler(spelling, ctx);
    assert.equal(appendedEntries.some(({ data }) => data.event === control), true);
    assert.equal(last(appendedEntries).data.state?.status, control === "pause" ? "paused" : control === "resume" ? "active" : undefined);
  }
  for (const objective of ["Pause.", "Pause the video", "Start reliably", "history 10", "clear now", "pause now", "resume now"]) {
    const harness = createHarness<GoalEntryData>();
    await getCommand(harness.commands, "goal").handler(objective, createTuiContext().ctx);
    assert.equal(last(harness.appendedEntries).data.state.objective, objective, objective);
  }
  const overlong = createHarness<GoalEntryData>();
  const overlongCtx = createTuiContext().ctx;
  const notifications: TestNotification[] = [];
  overlongCtx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(overlong.commands, "goal").handler("x".repeat(4_001), overlongCtx);
  assert.equal(overlong.appendedEntries.length, 0);
  assert.equal(last(notifications).message, "A goal objective may not exceed 4,000 characters");
});

test("explicit resume renews an exhausted 20-turn budget to 40", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const settle = async () => {
    await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  };
  await getCommand(commands, "goal").handler("Finish in twenty turns", ctx);
  for (let turn = 1; turn <= 19; turn += 1) await settle();
  assert.equal(sentMessages.length, 20);
  await settle();
  assert.equal(sentMessages.length, 20);
  assert.equal(last(appendedEntries).data.event, "limit");
  assert.equal(last(appendedEntries).data.state.status, "paused");
  assert.equal(last(appendedEntries).data.state.turns, 20);
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.equal(last(appendedEntries).data.state.status, "active");
  assert.equal(last(appendedEntries).data.state.maxTurns, 40);
  assert.equal(last(appendedEntries).data.state.turns, 21);
  assert.equal(sentMessages.length, 21);
});

test("resume renews from the current turn when an old limit is lower", async () => {
  const now = Date.now();
  const state = {
    version: 1,
    revision: 5,
    objective: "Continue beyond an old lowered limit",
    status: "paused",
    createdAt: now - 60_000,
    updatedAt: now,
    activeMilliseconds: 60_000,
    turns: 50,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    maxTurns: 20,
  };
  const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "limit", state } }];
  const { appendedEntries, commands, handlers } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(entries);
  await emitSequentially(getHandlers(handlers, "session_start"), {}, ctx);
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.equal(last(appendedEntries).data.state.maxTurns, 70);
  assert.equal(last(appendedEntries).data.state.status, "active");
});

test("resume at the lifetime ceiling stays paused", async () => {
  const now = Date.now();
  const exhausted = {
    version: 1,
    revision: 5,
    objective: "At the ceiling",
    status: "paused",
    createdAt: now - 60_000,
    updatedAt: now,
    activeMilliseconds: 60_000,
    turns: 10_000,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    maxTurns: 10_000,
  };
  const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "limit", state: exhausted } }];
  const { commands, handlers } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(entries);
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await emitSequentially(getHandlers(handlers, "session_start"), {}, ctx);
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.match(last(notifications).message, /lifetime limit.*Set a new objective/u);
});

test("the 20th default-limited turn settles silently without starting turn 21", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("Finish within the default limit", ctx);

  for (let turn = 1; turn <= 20; turn += 1) {
    await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  }

  assert.equal(sentMessages.length, 20);
  assert.equal(last(appendedEntries).data.event, "limit");
  assert.equal(last(appendedEntries).data.state.status, "paused");
  assert.equal(last(appendedEntries).data.state.turns, 20);
  assert.deepEqual(notifications.filter(({ level }) => level === "warning"), []);
});

test("completion wins on the last allowed goal turn", async () => {
  const { appendedEntries, commands, handlers, sentMessages, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Complete now", ctx);
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
  assert.match(captured.selection.title, /1\/20 turns/u);
  assert.match(captured.selection.title, /Ship the release/u);
  assert.deepEqual(captured.selection.options, [
    "Pause automatic continuation",
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
    paused: ["Resume automatic continuation", "Clear goal"],
    blocked: ["Resume automatic continuation", "Clear goal"],
    complete: ["Clear goal"],
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

test("/goal does not report start or resume success after dispatch failure", async () => {
  for (const control of ["start", "resume"]) {
    const { api, appendedEntries, commands, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext();
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message: string, level?: string) => notifications.push({ message, level });
    if (control === "start") {
      api.sendMessage = () => { throw new Error("provider unavailable"); };
      await getCommand(commands, "goal").handler("Start reliably", ctx);
    } else {
      await getCommand(commands, "goal").handler("Original objective", ctx);
      api.sendMessage = () => { throw new Error("provider unavailable"); };
      await getCommand(commands, "goal").handler("pause", ctx);
      await getCommand(commands, "goal").handler("resume", ctx);
    }
    const state = last(appendedEntries.filter((entry) => entry.customType === "killeros-goal")).data.state;
    assert.equal(state.status, "paused", `${control} failure must pause the goal`);
    assert.match(state.result, /continuation could not start: provider unavailable/u);
    assert.equal(sentMessages.length, control === "start" ? 0 : 1);
    assert.equal(notifications.some(({ message }) => new RegExp(control === "start" ? "Goal active" : "Goal resumed", "u").test(message)), false);
    assert.equal(last(notifications).level, "error");
  }
});

test("/goal reports start and resume success after dispatch", async () => {
  const { commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("Original objective", ctx);
  assert.match(last(notifications).message, /Goal active/u);
  await getCommand(commands, "goal").handler("pause", ctx);
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.match(last(notifications).message, /Goal resumed/u);
  assert.equal(sentMessages.length, 2);
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

test("/goal pause, resume, and clear persist explicit transitions", async () => {
  const { appendedEntries, commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  await getCommand(commands, "goal").handler("Original objective", ctx);
  await getCommand(commands, "goal").handler("pause", ctx);
  assert.equal(last(appendedEntries).data.state.status, "paused");
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.equal(last(appendedEntries).data.state.status, "active");
  assert.equal(sentMessages.length, 2);
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
