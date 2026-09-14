import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalState } from "../killeros/goal-state.ts";
import {
  createHarness,
  createTuiContext,
  emitSequentially,
  getCommand,
  getHandlers,
  getTool,
  last,
} from "./ExtensionTestHarness.ts";

type GoalData = { state: Record<string, unknown> | null; event?: string; [key: string]: unknown };

type Notification = { message: string; level?: string };

async function start(harness: ReturnType<typeof createHarness<GoalData>>, objective = "Finish the objective") {
  const ctx = createTuiContext().ctx;
  await getCommand(harness.commands, "goal").handler(objective, ctx);
  return { ctx, tool: getTool(harness.tools, "killeros_goal_update") };
}

async function settle(
  harness: ReturnType<typeof createHarness<GoalData>>,
  ctx: ReturnType<typeof createTuiContext>["ctx"],
): Promise<void> {
  await emitSequentially(getHandlers(harness.handlers, "agent_end"), {
    messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  await emitSequentially(getHandlers(harness.handlers, "agent_settled"), {}, ctx);
}

function state(harness: ReturnType<typeof createHarness<GoalData>>): Record<string, unknown> {
  const saved = last(harness.appendedEntries).data.state;
  assert.ok(saved);
  return saved;
}

test("a normal goal stop without a decision pauses and does not continue", async () => {
  const harness = createHarness<GoalData>();
  const { ctx } = await start(harness);
  const notices: Notification[] = [];
  ctx.ui.notify = (message, level) => notices.push({ message, level });

  await settle(harness, ctx);

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(state(harness).status, "paused");
  assert.equal(state(harness).turns, 1);
  assert.equal(state(harness).stopReason, "no turn decision");
  assert.match(notices.at(-1)?.message ?? "", /ended without choosing continue, complete, or blocked|no turn decision/u);
});

test("continue records model-reported evidence and authorizes exactly one next turn", async () => {
  const harness = createHarness<GoalData>();
  const { ctx, tool } = await start(harness);

  const result = await tool.execute(
    "continue",
    { status: "continue", evidence: "The first check passed", nextAction: "Run the remaining check" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(result.details.status, "continue");
  await settle(harness, ctx);

  assert.equal(harness.sentMessages.length, 2);
  assert.equal(state(harness).turns, 2);
  assert.equal(state(harness).turnPhase, "in-flight");
  assert.match(harness.sentMessages[1]?.message.content ?? "", /Run the remaining check/u);
  assert.match(harness.sentMessages[1]?.message.content ?? "", /Finish the objective/u);
});

test("identical normalized continue reports pause before a duplicate turn", async () => {
  const harness = createHarness<GoalData>();
  const { ctx, tool } = await start(harness);
  await tool.execute(
    "first",
    { status: "continue", evidence: "Same evidence", nextAction: "Same next action" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  await settle(harness, ctx);

  await assert.rejects(tool.execute(
    "duplicate",
    { status: "continue", evidence: "  Same evidence\r\n", nextAction: "Same next action" },
    new AbortController().signal,
    () => {},
    ctx,
  ), /repeated continue report/u);

  assert.equal(harness.sentMessages.length, 2);
  assert.equal(state(harness).status, "paused");
  assert.equal(state(harness).stopReason, "repeated continue report");
});

test("the goal tool is required before dispatch and disallowed activation stays inactive", async () => {
  const harness = createHarness<GoalData>();
  const { ctx } = createTuiContext();
  harness.activeTools.splice(harness.activeTools.indexOf("killeros_goal_update"), 1);
  harness.api.setActiveTools = () => {};
  const notices: Notification[] = [];
  ctx.ui.notify = (message, level) => notices.push({ message, level });

  await getCommand(harness.commands, "goal").handler("Do not dispatch", ctx);

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
  assert.equal(state(harness).status, "paused");
  assert.equal(state(harness).stopReason, "killeros_goal_update is unavailable");
  assert.match(notices[0]?.message ?? "", /before turn 1.*unavailable/su);
});

test("only an accepted complete decision can finish a general goal", async () => {
  const harness = createHarness<GoalData>();
  const { ctx, tool } = await start(harness);
  await settle(harness, ctx);
  assert.equal(state(harness).status, "paused");

  await getCommand(harness.commands, "goal").handler("resume", ctx);
  await tool.execute(
    "complete",
    { status: "complete", evidence: "Verified" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  assert.equal(state(harness).status, "complete");
  assert.equal(harness.sentMessages.length, 2);
});

test("blocker audits still require three consecutive accepted decisions", async () => {
  const harness = createHarness<GoalData>();
  const { ctx, tool } = await start(harness);
  const record = async (turn: number) => {
    const result = await tool.execute(
      `blocked-${turn}`,
      { status: "blocked", blockerKey: "external", evidence: `Evidence ${turn}` },
      new AbortController().signal,
      () => {},
      ctx,
    );
    return result.details.status;
  };

  assert.equal(await record(1), "blocker-audit");
  await settle(harness, ctx);
  assert.equal(await record(2), "blocker-audit");
  await settle(harness, ctx);
  assert.equal(await record(3), "blocked");
  assert.equal(state(harness).status, "blocked");
  assert.equal(harness.sentMessages.length, 3);
});

test("a persisted continue authorization is consumed once and an unresolved turn restores paused", async () => {
  const original = createHarness<GoalData>();
  const { ctx, tool } = await start(original);
  await tool.execute(
    "continue",
    { status: "continue", evidence: "Observed progress", nextAction: "Inspect the next result" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  const authorized = state(original);
  const restoredEntries = [{
    type: "custom",
    customType: "killeros-goal",
    data: { version: 1, event: "continue", state: authorized },
  }];
  const restored = createHarness<GoalData>();
  const restoredContext = createTuiContext(restoredEntries).ctx;
  for (const handler of getHandlers(restored.handlers, "session_start")) await handler({}, restoredContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restored.sentMessages.length, 1);
  assert.equal(state(restored).turns, 2);

  const unresolvedEntries = [{
    type: "custom",
    customType: "killeros-goal",
    data: { version: 1, event: "turn", state: state(restored) },
  }];
  const unresolved = createHarness<GoalData>();
  const unresolvedContext = createTuiContext(unresolvedEntries).ctx;
  const notices: Notification[] = [];
  unresolvedContext.ui.notify = (message, level) => notices.push({ message, level });
  for (const handler of getHandlers(unresolved.handlers, "session_start")) await handler({}, unresolvedContext);
  assert.equal(unresolved.sentMessages.length, 0);
  assert.equal(state(unresolved).status, "paused");
  assert.equal(state(unresolved).stopReason, "no turn decision");
  assert.match(notices.at(-1)?.message ?? "", /no turn decision/u);
});

test("persisted reports fail closed when oversized or unsafe", () => {
  const base = {
    version: 1,
    revision: 3,
    objective: "Bounded report",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
    activeMilliseconds: 0,
    activeStartedAt: 0,
    turns: 1,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    turnPhase: "authorized",
    turnDecision: { kind: "continue", turn: 1, evidence: "evidence", nextAction: "next" },
  };
  assert.ok(parseGoalState(base));
  assert.equal(parseGoalState({
    ...base,
    turnDecision: { ...base.turnDecision, evidence: "x".repeat(2_001) },
  }), undefined);
  assert.equal(parseGoalState({
    ...base,
    turnDecision: { ...base.turnDecision, nextAction: "\x1b[31mnext" },
  }), undefined);
  assert.equal(parseGoalState({
    ...base,
    turns: 2,
  }), undefined, "a stale decision must not authorize another turn");
});
