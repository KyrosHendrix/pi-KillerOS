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
  const goalEntry = getRenderer(entryRenderers, "killeros-goal")({ data: { version: 1, event: "error", state: {
    version: 1,
    revision: 1,
    objective: "safespoof\nnext",
    result: "safespoof\nnext",
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
  assert.ok(getRenderer(entryRenderers, "killeros-goal")(entry, { expanded: false }, theme).render(40).length <= 1);
  assert.match(getRenderer(entryRenderers, "killeros-goal")(entry, { expanded: true }, theme).render(40).join("\n"), /Objective Objective/u);

  const result = { content: [], details: { status: "complete", evidence: "E".repeat(2_000) } };
  assert.ok(getTool(tools, "killeros_goal_update").renderResult(result, { expanded: false }, theme).render(40).length <= 1);
  const expandedEvidence = getTool(tools, "killeros_goal_update").renderResult(result, { expanded: true }, theme).render(40).join("\n");
  assert.equal((expandedEvidence.match(/E/gu) ?? []).length, 2_000);
});

test("active, paused, and blocked goals keep compact status text in the footer", async () => {
  const { appendedEntries, commands, handlers } = createHarness<GoalEntryData>();
  const { captured, ctx, tui } = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "startup" }, ctx);
  await getCommand(commands, "goal").handler("Keep working", ctx);
  const state = last(appendedEntries).data.state;
  const tealTheme = themeTestAdapter({
    ...theme,
    fg: (color: string, text: string) => color === "customMessageLabel" ? `\x1B[36m${text}\x1B[39m` : text,
  });
  const footer = captured.footerFactory(tui, tealTheme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });
  const stripAnsi = (line: string) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 10_000;
  const seconds = footer.render(160)[2] ?? "";
  assert.match(seconds, /\x1B\[36m\/goal active\x1B\[39m · 1\/20 · 10s/u);
  assert.ok(stripAnsi(seconds).trimEnd().endsWith("/goal active · 1/20 · 10s"));
  assert.doesNotMatch(stripAnsi(seconds), /✻|\/goal is active|pi-KillerOS/u);

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 125_000;
  assert.ok(stripAnsi(footer.render(40)[2] ?? "").trimEnd().endsWith("/goal active · 1/20 · 2m 05s"));

  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 3_725_000;
  assert.ok(stripAnsi(footer.render(40)[2] ?? "").trimEnd().endsWith("/goal active · 1/20 · 1h 02m 05s"));

  state.maxTurns = undefined;
  state.turns = 3;
  state.activeStartedAt = Date.now();
  state.activeMilliseconds = 10_000;
  assert.ok(stripAnsi(footer.render(160)[2] ?? "").trimEnd().endsWith("/goal active · 3 turns · 10s"));
  state.maxTurns = 20;
  state.turns = 1;

  for (let width = 1; width <= 180; width += 1) {
    const lines = footer.render(width).map(stripAnsi);
    assert.equal(lines.length, 3, `goal footer rows at width ${width}`);
    assert.ok(lines.every((line) => [...line].length === width), `goal footer width mismatch at ${width}`);
  }
  const narrow = stripAnsi(footer.render(20)[2] ?? "");
  assert.match(narrow, /\/goal active/u);

  state.status = "paused";
  state.activeStartedAt = undefined;
  const paused = stripAnsi(footer.render(160)[2] ?? "");
  assert.ok(paused.trimEnd().endsWith("/goal paused"));
  assert.doesNotMatch(paused, /Ⅱ|\/goal is paused/u);

  state.status = "blocked";
  const blocked = stripAnsi(footer.render(160)[2] ?? "");
  assert.ok(blocked.trimEnd().endsWith("/goal blocked"));
  assert.doesNotMatch(blocked, /! goal|\/goal is blocked/u);
  disposeTestComponent(footer);
});

function goalLifecycleState(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    revision: 1,
    objective: "run",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    activeMilliseconds: 0,
    activeStartedAt: 1,
    turns: 1,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    ...overrides,
  };
}

const taggingTheme = themeTestAdapter({
  ...theme,
  fg: (color: string, text: string) => `<${color}>${text}</>`,
});

function renderGoalEntry(event: string, state: Record<string, unknown> | null, expanded = false): string[] | undefined {
  const { entryRenderers } = createHarness<GoalEntryData>();
  const rendered = getRenderer(entryRenderers, "killeros-goal")(
    { data: { version: 1, event, state } },
    { expanded },
    taggingTheme,
  );
  return rendered?.render(80);
}

function stripTags(line: string): string {
  return line.replace(/<[^>]*>/gu, "");
}

test("goal history shows only lifecycle changes with event wording and no status icons", () => {
  const visible: Array<[string, Record<string, unknown> | null, string, string]> = [
    ["set", goalLifecycleState({}), "Goal started", "customMessageLabel"],
    ["replace", goalLifecycleState({}), "Goal replaced", "customMessageLabel"],
    ["resume", goalLifecycleState({}), "Goal resumed", "customMessageLabel"],
    ["pause", goalLifecycleState({ status: "paused", activeStartedAt: undefined }), "Goal paused", "warning"],
    ["limit", goalLifecycleState({ status: "paused", activeStartedAt: undefined, result: "Turn limit reached (20/20)." }), "Goal paused", "warning"],
    ["error", goalLifecycleState({ status: "paused", activeStartedAt: undefined, result: "provider unavailable", stopReason: "provider unavailable" }), "Goal paused", "error"],
    ["clear", null, "Goal cleared", "dim"],
  ];
  for (const [event, state, label, role] of visible) {
    const lines = renderGoalEntry(event, state);
    assert.ok(lines, `${event} must render a lifecycle row`);
    assert.equal(lines.length, 1, `${event} must collapse to one row`);
    assert.match(lines.join("\n"), new RegExp(`<${role}>${label}</>`, "u"), `${event} role`);
    assert.doesNotMatch(stripTags(lines.join("\n")), /✻|Ⅱ|✓|→/u, `${event} must not add a status icon`);
  }
  assert.match(stripTags(renderGoalEntry("set", goalLifecycleState({}))!.join("\n")), /Goal started · run/u);
  assert.match(stripTags(renderGoalEntry("limit", goalLifecycleState({ status: "paused", activeStartedAt: undefined, result: "Turn limit reached (20/20)." }))!.join("\n")), /Goal paused · Turn limit reached \(20\/20\)\./u);
  assert.match(stripTags(renderGoalEntry("clear", null)!.join("\n")).trimEnd(), /^Goal cleared$/u);

  for (const event of ["turn", "checkpoint", "continue", "blocker-audit", "blocked", "complete"]) {
    assert.equal(renderGoalEntry(event, goalLifecycleState({})), undefined, `${event} must not render a custom row`);
  }

  const expanded = renderGoalEntry("error", goalLifecycleState({ status: "paused", activeStartedAt: undefined, result: "provider unavailable", stopReason: "provider unavailable" }), true)!.join("\n");
  assert.match(stripTags(expanded), /run/u);
  assert.match(stripTags(expanded), /provider unavailable/u);
});

test("goal decisions own progress, audit, blocked, and completed output", () => {
  const { tools } = createHarness<GoalEntryData>();
  const tool = getTool(tools, "killeros_goal_update");
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ status: "continue", evidence: "first step passed" }, "Progress recorded", "customMessageLabel"],
    [{ status: "blocker-audit", evidence: "still waiting", blockerKey: "missing-credential", streak: 2 }, "Blocker audit 2/3", "warning"],
    [{ status: "blocked", evidence: "no credentials", blockerKey: "missing-credential", streak: 3 }, "Goal blocked", "error"],
    [{ status: "complete", evidence: "all checks passed" }, "Goal completed", "success"],
  ];
  for (const [details, label, role] of cases) {
    const lines = tool.renderResult({ content: [], details }, { expanded: false }, taggingTheme, {}).render(80);
    assert.equal(lines.length, 1, `${label} must collapse to one row`);
    assert.match(lines.join("\n"), new RegExp(`<${role}>${label}</>`, "u"), `${label} role`);
    assert.doesNotMatch(stripTags(lines.join("\n")), /✻|Ⅱ|✓|→|!/u, `${label} must not add a status icon`);
  }
  const fallback = tool.renderResult({ content: [], details: {} }, { expanded: false }, taggingTheme, {}).render(80).join("\n");
  assert.match(fallback, /<dim>Goal updated<\/>/u);
  const expanded = tool.renderResult(
    { content: [], details: { status: "continue", evidence: "first step passed", nextAction: "run the next step" } },
    { expanded: true },
    taggingTheme,
    {},
  ).render(80).join("\n");
  assert.match(stripTags(expanded), /first step passed/u);
});
