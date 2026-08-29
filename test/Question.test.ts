import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, createTuiContext, getHandlers, getTool, last, requireInteractive, theme, type TestInteractive, type TestResult, type TestTool, type TestTui } from "./ExtensionTestHarness.ts";

type QuestionOption = { label: string; description?: string; preview?: string; [key: string]: unknown };

type TestNotification = { message: string; level?: string };


function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("question exposes a Google-compatible optional selection mode", () => {
  const tool = getTool(createHarness(), "question");
  const rawSchema: unknown = JSON.parse(JSON.stringify(tool.parameters));
  assert.ok(isUnknownRecord(rawSchema));
  const properties = rawSchema.properties;
  assert.ok(isUnknownRecord(properties));

  assert.deepEqual(properties.mode, {
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

test("question rejects every other single-select bound before rendering and execution", async () => {
  const tool = getTool(createHarness(), "question");
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
  const tool = getTool(createHarness(), "question");
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

async function startQuestion(
  tool: TestTool,
  options: QuestionOption[] = [{ label: "Alpha" }],
  questionText = "Choose",
  terminalRows = 40,
  keybindings = getKeybindings(),
  extraParams: Record<string, unknown> = {},
): Promise<{
  component: TestInteractive;
  finish: (value: unknown) => void;
  result: Promise<TestResult>;
  notifications: TestNotification[];
  tui: TestTui;
}> {
  let component: TestInteractive | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const notifications: TestNotification[] = [];
  const tui: TestTui = { requestRender() {}, terminal: { rows: terminalRows } };
  const ctx = {
    mode: "tui" as const,
    ui: {
      custom: (factory: (...args: unknown[]) => unknown) => new Promise<unknown>((resolve) => {
        finish = resolve;
        component = requireInteractive(factory(tui, theme, keybindings, resolve));
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

test("question renderers strip terminal controls while preserving line breaks", () => {
  const { tools } = createHarness();
  const unsafe = "safe\x1B[2Jspoof\u0007\nnext";
  const question = getTool(tools, "question");
  const questionCall = question.renderCall({
    question: unsafe,
    options: [{ label: unsafe, description: unsafe, preview: unsafe }],
  }, theme, { expanded: true }).render(80).join("\n");
  const questionResult = question.renderResult({
    content: [{ type: "text", text: unsafe }],
    details: { question: unsafe, options: [unsafe], answer: unsafe, wasCustom: true },
  }, { expanded: true }, theme).render(80).join("\n");

  for (const rendered of [questionCall, questionResult]) {
    assert.doesNotMatch(rendered, /\x1B|\u0007|\[2J/u);
    assert.match(rendered, /safespoof[^\S\r\n]*\nnext/u);
  }
});

test("question options render bounded markdown proposal previews before selection", async () => {
  const { tools } = createHarness();
  const preview = Array.from(
    { length: 20 },
    (_, index) => `- **AGENTS.md** — run \`check-${index + 1}\``,
  ).join("\n");
  const question = await startQuestion(getTool(tools, "question"), [{
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

test("question keeps single-select as the unchanged default", async () => {
  const question = await startQuestion(getTool(createHarness(), "question"), [{ label: "Alpha" }, { label: "Beta" }]);
  question.component.handleInput("\x1B[B");
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details, {
    question: "Choose", options: ["Alpha", "Beta"], answer: "Beta", selectedIndex: 2, wasCustom: false,
  });
});

test("multi-select toggles choices and returns original option order", async () => {
  const question = await startQuestion(
    getTool(createHarness(), "question"),
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
    getTool(createHarness(), "question"), [{ label: "Alpha" }, { label: "Beta" }],
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
    getTool(createHarness(), "question"), [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", minSelections: 1, maxSelections: 1 },
  );
  question.component.handleInput("\r");
  assert.match(last(question.notifications).message, /Select at least 1/u);
  question.component.handleInput(" ");
  question.component.handleInput("\x1B[B");
  question.component.handleInput(" ");
  assert.match(last(question.notifications).message, /Select at most 1/u);
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details.answers, ["Alpha"]);
});

test("multi-select custom controls preserve selections and drafts", async () => {
  const question = await startQuestion(
    getTool(createHarness(), "question"), [{ label: "Alpha" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple", maxSelections: 1 },
  );
  question.component.handleInput(" ");
  question.component.handleInput("2");
  question.component.handleInput("blocked draft");
  question.component.handleInput("\r");
  assert.match(last(question.notifications).message, /Select at most 1/u);
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
    getTool(createHarness(), "question"), [{ label: "Alpha" }],
    "Choose all", 10, getKeybindings(), { mode: "multiple" },
  );
  question.component.handleInput("\x1B");
  assert.deepEqual((await question.result).details, {
    question: "Choose all", options: ["Alpha"], mode: "multiple", answers: [], selectedIndices: [], cancelled: true,
  });
});

test("multi-select uses slash filter mode, accepts spaces, and keeps hidden checks", async () => {
  const question = await startQuestion(
    getTool(createHarness(), "question"), [{ label: "Alpha one" }, { label: "Beta two" }],
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
    getTool(createHarness(), "question"), [{ label: "Alpha" }, { label: "Beta two" }],
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
  assert.match(last(question.notifications).message, /4,000 characters.*16,000 bytes/u);
  question.component.handleInput("\x1B");
  question.component.handleInput("\x1B");
  await question.result;
});

test("multi-select renders checked state, controls, and bounded compact layouts", async () => {
  const question = await startQuestion(
    getTool(createHarness(), "question"),
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
  const tool = getTool(createHarness(), "question");
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
  const question = await startQuestion(getTool(tools, "question"), [{ label: "Alpha" }], "Choose", 8);
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
  const tool = getTool(tools, "question");
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
      getTool(tools, "question"),
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
  const question = await startQuestion(getTool(tools, "question"), undefined, "Choose", 3);
  assert.deepEqual(question.component.render(0), []);
  assert.deepEqual(question.component.render(-1), []);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question renders no rows when terminal height is zero", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(getTool(tools, "question"), undefined, "Choose", 0);
  assert.deepEqual(question.component.render(80), []);
  question.tui.terminal.rows = 3;
  assert.deepEqual(question.component.render(80), ["Choose", "> 1. Alpha", "Option 1/2"]);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question keeps a custom draft visible at the six-row layout boundary", async () => {
  const { tools } = createHarness();
  const question = await startQuestion(getTool(tools, "question"), undefined, "Choose", 6);
  question.component.handleInput("2");
  question.component.handleInput("visible draft");
  assert.match(question.component.render(40).join("\n"), /visible draft/u);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("question wraps its full prompt when terminal width narrows", async () => {
  const { tools } = createHarness();
  const prompt = "Which deployment strategy should we use for this application now that the terminal is narrower than full screen?";
  const question = await startQuestion(getTool(tools, "question"), undefined, prompt, 12);

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
      const question = await startQuestion(getTool(tools, "question"), options, `Question ${"Q".repeat(990)}`, rows);
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
  const question = await startQuestion(getTool(tools, "question"), undefined, "Choose", 3);
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
    getTool(tools, "question"),
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
    getTool(tools, "question"),
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
  const question = await startQuestion(getTool(tools, "question"), undefined, "Choose", 8);
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
  const question = await startQuestion(getTool(tools, "question"));

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
  assert.match(getTool(tools, "question").description, /4,000 characters and 16,000 bytes/u);

  const huge = await startQuestion(getTool(tools, "question"));
  huge.component.handleInput(`\x1B[200~${"Q".repeat(1_000_000)}\x1B[201~`);
  assert.match(last(huge.notifications).message, /4,000 characters/u);
  assert.ok(huge.component.render(80).join("\n").length < 20_000);
  huge.finish({ kind: "cancelled" });
  await huge.result;

  const question = await startQuestion(getTool(tools, "question"));
  const boundary = "Z".repeat(4_000);
  question.component.handleInput(`\x1B[200~${boundary}\x1B[201~`);
  const boundaryRender = question.component.render(80).join("\n");
  assert.match(boundaryRender, /Filter 4,000\/4,000/u);
  assert.ok(boundaryRender.length < 500);

  question.component.handleInput("\x1B[200~Z\x1B[201~");
  assert.match(last(question.notifications).message, /4,000 characters/u);
  assert.match(question.component.render(80).join("\n"), /Filter 4,000\/4,000/u);
  question.finish({ kind: "cancelled" });
  await question.result;

  const unicode = await startQuestion(getTool(tools, "question"));
  const emojiBoundary = "😀".repeat(4_000);
  unicode.component.handleInput(`\x1B[200~${emojiBoundary}\x1B[201~`);
  assert.match(unicode.component.render(80).join("\n"), /Filter 4,000\/4,000/u);
  unicode.component.handleInput("\x1B[200~😀\x1B[201~");
  assert.match(last(unicode.notifications).message, /4,000 characters|16,000 bytes/u);
  assert.match(unicode.component.render(80).join("\n"), /Filter 4,000\/4,000/u);
  unicode.finish({ kind: "cancelled" });
  await unicode.result;
});

test("custom-answer history does not replace a multiline draft on Up", async () => {
  const { tools } = createHarness();
  const tool = getTool(tools, "question");
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
  const first = await startQuestion(getTool(tools, "question"));
  first.component.handleInput("2");
  const boundary = "😀".repeat(4_000);
  first.component.handleInput(`\x1B[200~${boundary}\x1B[201~`);
  assert.equal(first.notifications.length, 0);
  first.component.handleInput("\x1B[200~😀\x1B[201~");
  assert.match(last(first.notifications).message, /4000 characters/u);
  first.component.handleInput("\r");
  await first.result;

  for (let index = 0; index < 5; index += 1) {
    const answer = await startQuestion(getTool(tools, "question"));
    answer.component.handleInput("2");
    answer.component.handleInput(`\x1B[200~answer-${index}-${"😀".repeat(3_991)}\x1B[201~`);
    answer.component.handleInput("\r");
    await answer.result;
  }
  const historyProbe = await startQuestion(getTool(tools, "question"));
  historyProbe.component.handleInput("2");
  for (let index = 0; index < 5; index += 1) historyProbe.component.handleInput("\x1B[A");
  assert.doesNotMatch(historyProbe.component.render(80).join("\n"), /answer-0-/u);
  historyProbe.finish({ kind: "cancelled" });
  await historyProbe.result;

  const session = createTuiContext();
  for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "new" }, session.ctx);
  const afterNewSession = await startQuestion(getTool(tools, "question"));
  afterNewSession.component.handleInput("2");
  afterNewSession.component.handleInput("\x1B[A");
  assert.doesNotMatch(afterNewSession.component.render(80).join("\n"), /😀/u);
  afterNewSession.finish({ kind: "cancelled" });
  await afterNewSession.result;
});
