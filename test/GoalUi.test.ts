import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, createTuiContext, disposeTestComponent, getCommand, getHandlers, getRenderer, getTool, last, theme, type TestHandler } from "./ExtensionTestHarness.ts";
import { themeTestAdapter } from "./PiTestAdapters.ts";
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

test("goal renderers strip terminal controls while preserving line breaks", () => {
  const { entryRenderers, tools } = createHarness<GoalEntryData>();
  const unsafe = "safe\x1B[2Jspoof\u0007\nnext";
  const goalEntry = getRenderer(entryRenderers, "killeros-goal")({ data: { version: 1, event: "complete", state: {
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
  const goalResult = getTool(tools, "killeros_goal_update").renderResult({
    content: [], details: { status: "complete", evidence: unsafe },
  }, { expanded: true }, theme, {}).render(80).join("\n");

  for (const rendered of [goalEntry, goalResult]) {
    assert.doesNotMatch(rendered, /\x1B|\u0007|\[2J/u);
    assert.match(rendered, /safespoof[^\S\r\n]*\nnext/u);
  }
});

test("goal update renders the real tool error instead of an undefined blocker audit", () => {
  const tool = getTool(createHarness<GoalEntryData>(), "killeros_goal_update");
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

test("completed goals leave the footer but remain available through /goal", async () => {
  const { commands, handlers, tools } = createHarness<GoalEntryData>();
  const { captured, ctx, tui } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
  await getCommand(commands, "goal").handler("Finish cleanly", ctx);
  await emitGoalStart(handlers, ctx);
  await getTool(tools, "killeros_goal_update").execute(
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
  await getCommand(commands, "goal").handler("", ctx);
  assert.match(last(notifications).message, /Goal complete/u);
  assert.match(last(notifications).message, /All checks passed/u);
  disposeTestComponent(footer);
});

test("goal transcript rows are compact until expanded", () => {
  const { entryRenderers, tools } = createHarness<GoalEntryData>();
  const objective = "Objective ".repeat(400);
  const entry = { data: { version: 1, event: "set", state: {
    version: 1,
    revision: 1,
    objective,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    activeMilliseconds: 0,
    activeStartedAt: 1,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  } } };
  assert.ok(getRenderer(entryRenderers, "killeros-goal")(entry, { expanded: false }, theme).render(40).length <= 3);
  assert.match(getRenderer(entryRenderers, "killeros-goal")(entry, { expanded: true }, theme).render(40).join("\n"), /Objective Objective/u);

  const result = { content: [], details: { status: "complete", evidence: "E".repeat(2_000) } };
  assert.ok(getTool(tools, "killeros_goal_update").renderResult(result, { expanded: false }, theme).render(40).length <= 3);
  const expandedEvidence = getTool(tools, "killeros_goal_update").renderResult(result, { expanded: true }, theme).render(40).join("\n");
  assert.equal((expandedEvidence.match(/E/gu) ?? []).length, 2_000);
});

test("active, paused, and blocked goals replace the footer path with exact status text", async () => {
  const { appendedEntries, commands, handlers } = createHarness<GoalEntryData>();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "startup" }, ctx);
  await getCommand(commands, "goal").handler("Keep working", ctx);
  const state = last(appendedEntries).data.state;
  const yellowTheme = themeTestAdapter({
    ...theme,
    fg: (color: string, text: string) => color === "warning" ? `\x1B[33m${text}\x1B[39m` : text,
  });
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
  disposeTestComponent(footer);
});
