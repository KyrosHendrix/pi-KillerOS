import assert from "node:assert/strict";
import test from "node:test";
import { goalElapsedMilliseconds, parseGoalState, stopGoalClock } from "../killeros/goal-state.ts";
import { createHarness, createTuiContext, emitSequentially, getCommand, getHandlers, getTool, last, type TestHandler, type TestResult } from "./ExtensionTestHarness.ts";
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

async function emitGoalStart(handlers: Map<string, TestHandler[]>, ctx: unknown): Promise<void> {
  for (const handler of getHandlers(handlers, "before_agent_start") ?? []) {
    await handler({ prompt: "", systemPrompt: "base", systemPromptOptions: {} }, ctx);
  }
}

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
    completionCheck: { kind: "named-command", name: "quality", configHash: "a".repeat(64) },
    maxTurns: 4,
  };
  const branchEntries = [{
    type: "custom",
    customType: "killeros-goal",
    data: { version: 1, event: "turn", state: activeState },
  }];
  const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(branchEntries);
  for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.length, 1);

  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  ctx.mode = "rpc";
  await getCommand(commands, "goal").handler("", ctx);
  assert.match(last(notifications).message, /Goal active · 3\/4 turns/u);
  assert.doesNotMatch(last(notifications).message, /Check:/u);
  assert.match(last(notifications).message, /Finish the saved task/u);
});

test("/goal pauses an exhausted restored goal before continuation", async () => {
  const now = Date.now();
  const exhausted = {
    version: 1,
    revision: 3,
    objective: "Do not start another turn",
    status: "active",
    createdAt: now - 60_000,
    updatedAt: now,
    activeMilliseconds: 60_000,
    activeStartedAt: now,
    turns: 2,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    maxTurns: 2,
  };
  const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "turn", state: exhausted } }];
  const { appendedEntries, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(entries);
  await emitSequentially(getHandlers(handlers, "session_start"), { reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentMessages.length, 0);
  assert.equal(last(appendedEntries).data.event, "limit");
  assert.equal(last(appendedEntries).data.state.status, "paused");
});

test("/goal restores v2.0.18 active shutdown checkpoints", async () => {
  const now = Date.now();
  const checkpoint = {
    version: 1,
    revision: 3,
    objective: "Resume the checkpointed task",
    status: "active",
    createdAt: now - 60_000,
    updatedAt: now - 10_000,
    activeMilliseconds: 50_000,
    turns: 2,
    baselineTokens: 0,
  };
  const branchEntries = [{
    type: "custom",
    customType: "killeros-goal",
    data: { version: 1, event: "checkpoint", state: checkpoint },
  }];
  const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(branchEntries);

  await emitSequentially(getHandlers(handlers, "session_start"), { reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentMessages.length, 1);
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  ctx.mode = "rpc";
  await getCommand(commands, "goal").handler("", ctx);
  assert.match(last(notifications).message, /Resume the checkpointed task/u);
});

test("/goal restore rejects contradictory status-specific fields", async () => {
  const now = Date.now();
  const common = {
    version: 1,
    revision: 1,
    objective: "Reject contradictory state",
    createdAt: now,
    updatedAt: now,
    activeMilliseconds: 0,
    turns: 1,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  };
  const invalidStates = [
    { ...common, status: "active", activeStartedAt: -1 },
    { ...common, status: "paused", activeStartedAt: now },
    { ...common, status: "blocked", activeStartedAt: now, result: "blocked" },
    { ...common, status: "complete", result: "done", blockerAudit: { key: "blocked", streak: 1, lastTurn: 1 } },
  ];

  for (const state of invalidStates) {
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "checkpoint", state } }];
    const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext(entries);
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await emitSequentially(getHandlers(handlers, "session_start"), { reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    ctx.mode = "rpc";
    await getCommand(commands, "goal").handler("", ctx);

    assert.equal(sentMessages.length, 0, state.status);
    assert.match(last(notifications)?.message ?? "", /No goal is set/u, state.status);
  }
});

test("/goal restore rejects counters that cannot advance safely", async () => {
  const now = Date.now();
  const common = {
    version: 1,
    revision: 1,
    objective: "Reject unsafe counters",
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeMilliseconds: 0,
    activeStartedAt: now,
    turns: 1,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  };

  for (const state of [
    { ...common, revision: Number.MAX_SAFE_INTEGER },
    { ...common, turns: Number.MAX_SAFE_INTEGER },
    { ...common, activeMilliseconds: Number.MAX_VALUE },
  ]) {
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "checkpoint", state } }];
    const { commands, handlers, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext(entries);
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await emitSequentially(getHandlers(handlers, "session_start"), { reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    ctx.mode = "rpc";
    await getCommand(commands, "goal").handler("", ctx);

    assert.equal(sentMessages.length, 0);
    assert.match(last(notifications)?.message ?? "", /No goal is set/u);
  }
});

test("goal duration arithmetic rejects unsafe integer results", () => {
  const state = parseGoalState({
    version: 1,
    revision: 1,
    objective: "Reject unsafe duration arithmetic",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    activeMilliseconds: Number.MAX_SAFE_INTEGER - 1,
    activeStartedAt: 0,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  });
  assert.ok(state);

  assert.throws(() => goalElapsedMilliseconds(state, 10), /safe integer range/iu);
  assert.throws(() => stopGoalClock(state, 10), /safe integer range/iu);
});

test("failed replacement inference keeps the old goal and reschedules continuation", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("Keep the original objective", ctx);
  ctx.waitForIdle = async () => {
    await emitSequentially(getHandlers(handlers, "agent_end"), {
      messages: [{ role: "assistant", stopReason: "stop" }],
    }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  };
  const badPath = `${process.cwd().replace(/\\/gu, "/")}/invalid\0file`;
  await getCommand(commands, "goal").handler(`Create the file at \`${badPath}\``, ctx);
  assert.equal(last(appendedEntries).data.state.objective, "Keep the original objective");
  assert.equal(last(appendedEntries).data.state.status, "active");
  assert.equal(sentMessages.length, 2);
  assert.equal(last(notifications).level, "error");
});

test("goal update is active only while a goal is active", async () => {
  const { activeTools, commands, handlers, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();

  assert.equal(activeTools.includes("killeros_goal_update"), true);
  await emitSequentially(getHandlers(handlers, "session_start"), { reason: "startup" }, ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), false);

  await getCommand(commands, "goal").handler("Finish only after explicit activation", ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), true);
  await getCommand(commands, "goal").handler("pause", ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), false);
  await getCommand(commands, "goal").handler("resume", ctx);
  assert.equal(activeTools.includes("killeros_goal_update"), true);
  await getTool(tools, "killeros_goal_update").execute(
    "complete-explicit-goal",
    { status: "complete", evidence: "Verified complete" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(activeTools.includes("killeros_goal_update"), false);
});

test("/goal validates objectives, reserves control words, and requires blocker audits during goal turns", async () => {
  const { commands, handlers, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });

  await getCommand(commands, "goal").handler("x".repeat(4_001), ctx);
  assert.match(last(notifications).message, /4,000 characters/u);
  await getCommand(commands, "goal").handler("CLEAR", ctx);
  assert.match(last(notifications).message, /No goal is set/u);

  ctx.hasPendingMessages = () => true;
  await getCommand(commands, "goal").handler("Resolve the blocker", ctx);
  await assert.rejects(
    getTool(tools, "killeros_goal_update").execute(
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
      getTool(tools, "killeros_goal_update").execute(
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
  const { appendedEntries, commands, handlers, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const blocked = (id: string, blockerKey = "missing-credential"): Promise<TestResult> => getTool(tools, "killeros_goal_update").execute(
    id,
    { status: "blocked", blockerKey, evidence: `Evidence for ${blockerKey}` },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const finishTurn = async () => {
    await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  };

  await getCommand(commands, "goal").handler("Resolve one stable blocker", ctx);
  await emitGoalStart(handlers, ctx);
  const first = await blocked("first");
  assert.equal(first.details.status, "blocker-audit");
  assert.equal(first.details.streak, 1);
  assert.equal(last(appendedEntries).data.state.status, "active");

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
  assert.equal(last(appendedEntries).data.state.status, "blocked");
  assert.deepEqual(last(appendedEntries).data.state.blockerAudit, {
    key: "missing-credential",
    streak: 3,
    lastTurn: 3,
    evidence: "Evidence for missing-credential",
  });
});

test("resume and completion clear blocker audit progress", async () => {
  for (const transition of ["resume", "complete"]) {
    const { appendedEntries, commands, handlers, tools } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext();
    await getCommand(commands, "goal").handler(`Reset audit on ${transition}`, ctx);
    await emitGoalStart(handlers, ctx);
    await getTool(tools, "killeros_goal_update").execute(
      `audit-before-${transition}`,
      { status: "blocked", blockerKey: "stable-blocker", evidence: "First attempt" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    if (transition === "resume") {
      await getCommand(commands, "goal").handler("pause", ctx);
      await getCommand(commands, "goal").handler("resume", ctx);
    } else {
      await getTool(tools, "killeros_goal_update").execute(
        "complete-after-audit",
        { status: "complete", evidence: "Verified complete" },
        new AbortController().signal,
        () => {},
        ctx,
      );
    }
    assert.equal(last(appendedEntries).data.state.blockerAudit, undefined, transition);
  }
});

test("changed and skipped blocker turns reset the blocker streak", async () => {
  const { appendedEntries, commands, handlers, tools } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const blocked = (blockerKey: string): Promise<TestResult> => getTool(tools, "killeros_goal_update").execute(
    blockerKey,
    { status: "blocked", blockerKey, evidence: "Repeated evidence" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const finishTurn = async () => {
    await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  };

  await getCommand(commands, "goal").handler("Audit blocker resets", ctx);
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
  assert.equal(last(appendedEntries).data.state.status, "active");
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
  const { handlers, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext(staleEntries);
  ctx.sessionManager.getBranch = () => { throw new Error("branch unavailable"); };
  for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "resume" }, ctx);
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
    const { activeTools, appendedEntries, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext(entries);
    ctx.mode = mode;
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentMessages.length, 0);
    assert.equal(activeTools.includes("killeros_goal_update"), false);

    let systemPrompt = "base";
    for (const handler of getHandlers(handlers, "before_agent_start")) {
      const result = await handler({ prompt: "", systemPrompt, systemPromptOptions: {} }, ctx);
      if (result?.systemPrompt) systemPrompt = result.systemPrompt;
    }
    assert.doesNotMatch(systemPrompt, /Active KillerOS goal/u);
    await getCommand(commands, "goal").handler("", ctx);
    assert.match(last(notifications).message, /requires TUI or RPC mode/u);
    for (const handler of getHandlers(handlers, "session_shutdown")) await handler({}, ctx);
    assert.equal(appendedEntries.length, 0, `${mode} must not checkpoint an inactive saved goal`);
  }
});

test("/goal pause and clear persist terminal state before stopping an active goal run", async () => {
  for (const mode of ["tui", "rpc"]) {
    for (const control of ["pause", "clear"]) {
      const { api, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
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

      await getCommand(commands, "goal").handler(`Immediately ${control} active work`, ctx);
      calls.length = 0;
      await emitGoalStart(handlers, ctx);
      await getCommand(commands, "goal").handler(control, ctx);

      assert.deepEqual(calls, [`persist:${control === "pause" ? "paused" : "clear"}`, "abort", "waitForIdle", "notify"], `${mode} ${control}`);
      await emitSequentially(getHandlers(handlers, "agent_end"), { messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
      await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
      assert.equal(sentMessages.length, 1, `${mode} ${control} must not continue after explicit cancellation`);
    }
  }
});

test("/goal pause stops a scheduled continuation before its goal turn starts", async () => {
  const { commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const calls: string[] = [];
  ctx.abort = () => calls.push("abort");
  ctx.waitForIdle = async () => { calls.push("waitForIdle"); };
  await getCommand(commands, "goal").handler("Pause scheduled work", ctx);
  assert.equal(sentMessages.length, 1);
  calls.length = 0;
  await getCommand(commands, "goal").handler("pause", ctx);
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
    const { commands, handlers } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext(entries);
    let abortCalls = 0;
    ctx.abort = () => { abortCalls += 1; };
    await emitSequentially(getHandlers(handlers, "session_start"), { reason: "resume" }, ctx);
    await getCommand(commands, "goal").handler("clear", ctx);
    assert.equal(abortCalls, 0, status);
  }
});

test("saved goal cancellation remains terminal when host stopping fails", async () => {
  for (const control of ["pause", "clear"]) {
    const { appendedEntries, commands, handlers } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext();
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await getCommand(commands, "goal").handler(`Persist ${control} before abort`, ctx);
    await emitGoalStart(handlers, ctx);
    ctx.abort = () => { throw new Error("abort unavailable"); };
    await getCommand(commands, "goal").handler(control, ctx);
    const state = last(appendedEntries).data.state;
    assert.equal(control === "pause" ? state.status : state, control === "pause" ? "paused" : null);
    assert.match(last(notifications).message, /could not be confirmed stopped/u);
    assert.match(last(notifications).message, /abort unavailable/u);
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
    activeStartedAt: now,
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
    const harness = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext(entries);
    await emitSequentially(getHandlers(harness, "session_start"), { reason: "resume" }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    return { ...harness, ctx };
  };

  const valid = await restore({ key: "missing-credential", streak: 2, lastTurn: 2, evidence: "Credential is still unavailable" });
  assert.equal(valid.sentMessages.length, 1);
  assert.deepEqual(last(valid.appendedEntries).data.state.blockerAudit, {
    key: "missing-credential",
    streak: 2,
    lastTurn: 2,
    evidence: "Credential is still unavailable",
  });
  await emitGoalStart(valid.handlers, valid.ctx);
  await getTool(valid, "killeros_goal_update").execute(
    "restored-third-attempt",
    { status: "blocked", blockerKey: "missing-credential", evidence: "Still unavailable" },
    new AbortController().signal,
    () => {},
    valid.ctx,
  );
  assert.equal(last(valid.appendedEntries).data.state.status, "blocked");

  const malformed = [
    { key: "", streak: 1, lastTurn: 1 },
    { key: "UPPERCASE", streak: 1, lastTurn: 1 },
    { key: "valid", streak: 0, lastTurn: 1 },
    { key: "valid", streak: 4, lastTurn: 1 },
    { key: "valid", streak: 1.5, lastTurn: 1 },
    { key: "valid", streak: 1, lastTurn: -1 },
    { key: "valid", streak: 1, lastTurn: 0 },
    { key: "valid", streak: 1, lastTurn: 3 },
    { key: "valid", streak: 1, lastTurn: 1, evidence: "" },
    { key: "valid", streak: 1, lastTurn: 1, evidence: " padded" },
    { key: "valid", streak: 1, lastTurn: 1, evidence: "x".repeat(2_001) },
  ];
  for (const audit of malformed) {
    const restored = await restore(audit);
    assert.equal(restored.sentMessages.length, 0, JSON.stringify(audit));
  }
});

test("failed goal replacement pauses the old active goal and dispatches neither objective", async () => {
  const { api, commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("Old objective", ctx);
  api.appendEntry = () => { throw new Error("replacement write failed"); };
  await getCommand(commands, "goal").handler("New objective", ctx);
  assert.equal(sentMessages.length, 1);
  assert.match(last(notifications).message, /Goal could not be replaced: replacement write failed/u);
  ctx.mode = "rpc";
  await getCommand(commands, "goal").handler("", ctx);
  assert.match(last(notifications).message, /Goal paused/u);
  assert.match(last(notifications).message, /Old objective/u);
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
      ...(status === "blocked" ? { result: "Blocked result" } : {}),
    };
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: status, state } }];
    const { api, commands, handlers, sentMessages } = createHarness<GoalEntryData>();
    const { ctx } = createTuiContext(entries);
    const notifications: TestNotification[] = [];
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    await emitSequentially(getHandlers(handlers, "session_start"), { reason: "resume" }, ctx);
    api.appendEntry = () => { throw new Error(`${status} replacement failed`); };
    await getCommand(commands, "goal").handler("Replacement objective", ctx);
    assert.equal(sentMessages.length, 0);
    assert.match(last(notifications).message, new RegExp(`${status} replacement failed`, "u"));
    ctx.mode = "rpc";
    await getCommand(commands, "goal").handler("", ctx);
    assert.match(last(notifications).message, new RegExp(`Goal ${status}`, "u"));
    assert.match(last(notifications).message, new RegExp(`Original ${status} objective`, "u"));
  }
});

test("first goal write failure reports the error and dispatches nothing", async () => {
  const { api, commands, sentMessages } = createHarness<GoalEntryData>();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  api.appendEntry = () => { throw new Error("first write failed"); };
  await getCommand(commands, "goal").handler("New objective", ctx);
  assert.equal(sentMessages.length, 0);
  assert.match(last(notifications).message, /Goal could not be started: first write failed/u);
});
