import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, createTuiContext, getHandlers, getTool, theme, type TestTool } from "./ExtensionTestHarness.ts";
type TestNotification = { message: string; level?: string };
function isUnknownRecord(value: unknown): value is Record<string, unknown> {
 return typeof value === "object" && value !== null && !Array.isArray(value);
}
type NativeStep =
  | { select: RegExp | undefined; inspect?: (title: string, options: string[]) => void }
  | { input: string | undefined };

function nativeQuestion(tool: TestTool, steps: NativeStep[], params: Record<string, unknown> = {}, signal = new AbortController().signal) {
  const notifications: TestNotification[] = [];
  const ctx = { mode: "tui", ui: {
    async select(title: string, options: string[]) {
      const step = steps.shift();
      assert.ok(step && "select" in step, `Unexpected selector: ${title} / ${options.join(", ")}`);
      step.inspect?.(title, options);
      if (!step.select) return undefined;
      const pattern = step.select;
      const chosen = options.find((option) => pattern.test(option));
      assert.ok(chosen, `Missing choice ${step.select}: ${options.join(", ")}`);
      return chosen;
    },
    async input() {
      const step = steps.shift();
      assert.ok(step && "input" in step, "Unexpected native input");
      return step.input;
    },
    custom() { assert.fail("Question input must use native dialogs"); },
    notify(message: string, level?: string) { notifications.push({ message, level }); },
  } };
  const result = tool.execute("native-question", { question: "Choose", options: [{ label: "Alpha" }, { label: "Beta" }], ...params }, signal, () => {}, ctx).then((value) => {
    assert.equal(steps.length, 0, "All requested native interactions must occur");
    return value;
  });
  return { notifications, result };
}

test("native question preserves duplicate option identity and the single result", async () => {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [{ select: /^2\. /u }], {
    options: [{ label: "Custom answer" }, { label: "Custom answer" }],
  });
  assert.deepEqual(await result, {
    content: [{ type: "text", text: "User selected: Custom answer" }],
    details: { question: "Choose", options: ["Custom answer", "Custom answer"], answer: "Custom answer", selectedIndex: 2, wasCustom: false },
  });
});

test("native question multi-select keeps hidden selections under filtering", async () => {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /\[ \] Alpha/u }, { select: /More actions/u }, { select: /Filter options/u }, { input: "bEtA" },
    { select: /\[ \] Beta/u, inspect(_title, options) { assert.equal(options.some((option) => /Alpha/u.test(option)), false); } },
    { select: /Submit answers/u },
  ], { mode: "multiple", minSelections: 2, maxSelections: 2 });
  assert.deepEqual((await result).details, { question: "Choose", options: ["Alpha", "Beta"], mode: "multiple", answers: ["Alpha", "Beta"], selectedIndices: [1, 2] });
});

test("native question cancellation discards pending multi-select answers", async () => {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [{ select: /Alpha/u }, { select: undefined }], { mode: "multiple" });
  assert.deepEqual((await result).details, { question: "Choose", options: ["Alpha", "Beta"], mode: "multiple", answers: [], selectedIndices: [], cancelled: true });
});


test("question is model-only and sequential", () => {
  const tool = getTool(createHarness(), "question");
  assert.equal(tool.exposure, "model-only");
  assert.equal(tool.executionMode, "sequential");
});

test("question rejects direct execution outside TUI without opening custom UI", async () => {
  const tool = getTool(createHarness(), "question");
  let opened = false;
  for (const mode of ["rpc", "print", "json"]) {
    await assert.rejects(tool.execute(
      "non-tui-question",
      { question: "Choose", options: [{ label: "Alpha" }] },
      new AbortController().signal,
      () => {},
      { mode, ui: { custom: () => { opened = true; } } },
    ), { message: "The question tool requires interactive TUI mode" });
  }
  assert.equal(opened, false);
});

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
      select: () => {
        opened += 1;
        return Promise.resolve(undefined);
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

test("native question rejects invalid counts without losing selections and permits toggling off", async () => {
  const { result, notifications } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /Submit answers/u }, { select: /Alpha/u }, { select: /Beta/u }, { select: /\[x\] Alpha/u },
    { select: /Beta/u }, { select: /Submit answers/u },
  ], { mode: "multiple", maxSelections: 1 });
  assert.deepEqual((await result).details.answers, ["Beta"]);
  assert.deepEqual(notifications.map((item) => item.message), ["Select at least 1 answer", "Select at most 1 answer"]);
});

test("native question edits and removes custom answers while preserving predefined choices", async () => {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /Alpha/u }, { select: /Custom answer/u }, { input: " First " },
    { select: /Edit custom answer/u }, { input: undefined },
    { select: /Edit custom answer/u }, { input: "Edited" },
    { select: /More actions/u }, { select: /Remove custom answer/u },
    { select: /Custom answer/u }, { input: "Final" }, { select: /Submit answers/u },
  ], { mode: "multiple", maxSelections: 2 });
  assert.deepEqual(await result, {
    content: [{ type: "text", text: "User selected multiple answers:\n- Alpha\n- Final" }],
    details: { question: "Choose", options: ["Alpha", "Beta"], mode: "multiple", answers: ["Alpha", "Final"], selectedIndices: [1], customAnswer: "Final" },
  });
});

test("native question custom input cancellation returns to single selection", async () => {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [ { select: /Custom answer/u }, { input: undefined }, { select: /Beta/u } ]);
  assert.deepEqual((await result).details, { question: "Choose", options: ["Alpha", "Beta"], answer: "Beta", selectedIndex: 2, wasCustom: false });
});

test("native question validates Unicode custom answers and strips terminal controls", async () => {
  const { result, notifications } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /Custom answer/u }, { input: "  " },
    { select: /Custom answer/u }, { input: "𐐀".repeat(4_001) },
    { select: /Custom answer/u }, { input: "\x1b[2J𐐀".repeat(1) + "𐐀".repeat(3_999) },
    { select: /Custom answer/u }, { input: "𐐀".repeat(4_000) },
  ]);
  assert.deepEqual((await result).details.answer, "𐐀".repeat(4_000));
  assert.deepEqual(notifications.map((item) => item.message), ["Enter a nonempty custom answer", "Custom answers are limited to 4,000 characters", "Custom answers are limited to 4,000 characters"]);
  const safe = nativeQuestion(getTool(createHarness(), "question"), [{ select: /Custom answer/u }, { input: "safe\x1b[2Janswer\u0007" }]);
  assert.equal((await safe.result).details.answer, "safeanswer");
});

test("native question custom answer cannot bypass the maximum selection count", async () => {
  const { result, notifications } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /Alpha/u }, { select: /Custom answer/u }, { input: "Other" }, { select: /Submit answers/u },
  ], { mode: "multiple", maxSelections: 1 });
  assert.deepEqual((await result).details.answers, ["Alpha"]);
  assert.deepEqual(notifications.map((item) => item.message), ["Select at most 1 answer"]);
});

test("native question filters descriptions, recovers zero matches, and discards cancelled edits", async () => {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /More actions/u }, { select: /Filter options/u }, { input: "missing" },
    { select: /More actions/u, inspect(_title, options) { assert.equal(options.some((value) => /Alpha|Beta/u.test(value)), false); } },
    { select: /Filter options/u }, { input: undefined },
    { select: /More actions/u }, { select: /Clear filter/u },
    { select: /More actions/u }, { select: /Filter options/u }, { input: "SECOND" },
    { select: /Beta/u },
  ], { options: [{ label: "Alpha" }, { label: "Beta", description: "Second choice" }] });
  assert.equal((await result).details.selectedIndex, 2);
});

test("native question filter limits reject oversized input without losing checked options", async () => {
  const { result, notifications } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /Alpha/u }, { select: /More actions/u }, { select: /Filter options/u }, { input: "𐐀".repeat(4_001) },
    { select: /More actions/u }, { select: /Filter options/u }, { input: "𐐀".repeat(4_000) },
    { select: /Submit answers/u },
  ], { mode: "multiple" });
  assert.deepEqual((await result).details.answers, ["Alpha"]);
  assert.deepEqual(notifications.map((item) => item.message), ["Question filters are limited to 4,000 characters and 16,000 bytes"]);
});

test("native question history reuses complete answers, deduplicates them, and clears on session changes", async () => {
  const harness = createHarness();
  const tool = getTool(harness, "question");
  for (const answer of ["First", "Second", "First"]) {
    assert.equal((await nativeQuestion(tool, [{ select: /Custom answer/u }, { input: answer }]).result).details.answer, answer);
  }
  const reused = nativeQuestion(tool, [
    { select: /More actions/u }, { select: /Recent answers/u },
    { select: /Second/u, inspect(_title, choices) { assert.deepEqual(choices, ["1. First", "2. Second"]); } },
  ]);
  assert.equal((await reused.result).details.answer, "Second");
  for (const handler of getHandlers(harness.handlers, "session_start")) await handler({ reason: "new" }, createTuiContext().ctx);
  const cleared = nativeQuestion(tool, [ { select: /More actions/u }, { select: undefined, inspect(_title, choices) { assert.equal(choices.some((value) => /Recent answers/u.test(value)), false); } }, { select: /Alpha/u } ]);
  assert.equal((await cleared.result).details.answer, "Alpha");
});

test("native question recent-answer history evicts old entries under the byte bound", async () => {
  const tool = getTool(createHarness(), "question");
  for (let index = 0; index < 6; index++) {
    const answer = `${index}:` + "𐐀".repeat(3_998);
    assert.equal((await nativeQuestion(tool, [{ select: /Custom answer/u }, { input: answer }]).result).details.answer, answer);
  }
  const { result } = nativeQuestion(tool, [
    { select: /More actions/u }, { select: /Recent answers/u },
    { select: /5:/u, inspect(_title, choices) { assert.equal(choices.length, 4); assert.equal(choices.some((value) => /0:|1:/u.test(value)), false); } },
  ]);
  assert.equal((await result).details.answer, "5:" + "𐐀".repeat(3_998));
});

test("native question previews preserve complete text through pages and preserve selected answers", async () => {
  const preview = Array.from({ length: 19 }, (_, index) => `preview-line-${index}`).join("\n");
  const seen: string[] = [];
  const tool = getTool(createHarness(), "question");
  const { result } = nativeQuestion(tool, [
    { select: /Alpha/u }, { select: /More actions/u }, { select: /Review option details/u }, { select: /Alpha/u },
    ...Array.from({ length: 4 }, () => ({ select: /Next page/u, inspect(title: string) { seen.push(title); } })),
    { select: /Previous page/u, inspect(title: string) { seen.push(title); } },
    { select: /Back/u }, { select: /Submit answers/u },
  ], { mode: "multiple", options: [{ label: "Alpha", description: "Description", preview }, { label: "Beta" }] });
  assert.deepEqual((await result).details.answers, ["Alpha"]);
  for (let index = 0; index < 19; index++) assert.ok(seen.join("\n").includes(`preview-line-${index}\n`) || seen.join("\n").endsWith(`preview-line-${index}`));
  assert.ok(seen.join("\n").includes("Description"));
});

for (const step of ["selector", "input", "between steps"] as const) {
  test(`native question abort ${step} returns no partial answer or next dialog`, async () => {
    const controller = new AbortController();
    let opened = 0;
    const tool = getTool(createHarness(), "question");
    const result = tool.execute("cancel", { question: "Choose", options: [{ label: "Alpha" }], mode: "multiple" }, controller.signal, () => {}, {
      mode: "tui", ui: {
        async select(_title: string, options: string[], opts: { signal: AbortSignal }) {
          opened++;
          if (step === "input") return options.find((value) => /Custom answer/u.test(value));
          if (step === "between steps") { controller.abort(); return options[0]; }
          return new Promise<undefined>((resolve) => { opts.signal.addEventListener("abort", () => resolve(undefined), { once: true }); controller.abort(); });
        },
        async input(_title: string, _placeholder: string, opts: { signal: AbortSignal }) {
          opened++;
          return new Promise<undefined>((resolve) => { opts.signal.addEventListener("abort", () => resolve(undefined), { once: true }); controller.abort(); });
        },
        notify() {},
      },
    });
    await assert.rejects(result, { message: "Question cancelled because the agent operation was aborted" });
    assert.equal(opened, step === "input" ? 2 : 1);
  });
}

for (const event of ["session_start", "session_tree", "session_shutdown"]) {
  test(`native question ${event} invalidation closes the open dialog`, async () => {
    const harness = createHarness();
    const { ctx } = createTuiContext();
    let opened = 0;
    let dismiss: (() => void) | undefined;
    const result = getTool(harness, "question").execute("stale", { question: "Choose", options: [{ label: "Alpha" }] }, new AbortController().signal, () => {}, {
      mode: "tui", ui: {
        select(_title: string, _options: string[], opts: { signal: AbortSignal }) {
          opened++;
          return new Promise<undefined>((resolve) => { dismiss = () => resolve(undefined); opts.signal.addEventListener("abort", dismiss, { once: true }); });
        },
      },
    });
    const rejected = assert.rejects(result, { message: "Question cancelled because the agent operation was aborted" });
    for (const handler of getHandlers(harness.handlers, event)) await handler({ reason: "new" }, ctx);
    assert.ok(dismiss);
    await rejected;
    assert.equal(opened, 1);
    const fresh = nativeQuestion(getTool(harness, "question"), [{ select: /Alpha/u }]);
    assert.equal((await fresh.result).details.answer, "Alpha");
  });
}

test("native question terminal resize rebuilds the step without losing selected answers", async () => {
  let calls = 0;
  const notifications: string[] = [];
  const result = await getTool(createHarness(), "question").execute("resize", { question: "Choose", options: [{ label: "Alpha" }], mode: "multiple" }, new AbortController().signal, () => {}, {
    mode: "tui", ui: {
      async select(title: string, options: string[], opts: { signal: AbortSignal }) {
        calls++;
        if (calls === 1) return options[0];
        assert.match(title, /Selected 1/u);
        if (calls === 2) return new Promise<undefined>((resolve) => {
          opts.signal.addEventListener("abort", () => resolve(undefined), { once: true });
          process.stdout.emit("resize");
        });
        return options.find((value) => /Submit answers/u.test(value));
      },
      notify(message: string) { notifications.push(message); },
    },
  });
  assert.deepEqual(result.details.answers, ["Alpha"]);
  assert.equal(calls, 3);
  assert.deepEqual(notifications, []);
});

test("native question option paging bounds offered rows and returns the original ninth option", async () => {
  const previousRows = process.stdout.rows;
  process.stdout.rows = 20;
  try {
  const { result } = nativeQuestion(getTool(createHarness(), "question"), [
    { select: /Next choices/u, inspect(title, choices) { assert.ok(title.split("\n").length + choices.length <= 12); assert.ok(choices.every((value) => visibleWidth(value) <= 74)); } },
    { select: /Choice 9/u },
  ], { options: Array.from({ length: 9 }, (_, index) => ({ label: `Choice ${index + 1} ${"L".repeat(180)}` })) });
  assert.equal((await result).details.selectedIndex, 9);
  } finally {
    process.stdout.rows = previousRows;
  }
});

test("native question lets Pi resize text input without discarding the draft", async () => {
  let inputs = 0;
  const result = await getTool(createHarness(), "question").execute("input-resize", { question: "Choose", options: [{ label: "Alpha" }] }, new AbortController().signal, () => {}, {
    mode: "tui", ui: {
      async select(_title: string, options: string[]) { return options.find((value) => /Custom answer/u.test(value)); },
      async input(_title: string, _placeholder: string, opts: { signal: AbortSignal }) {
        inputs++;
        assert.equal(inputs, 1, "Resizing input must preserve the native editing component");
        process.stdout.emit("resize");
        assert.equal(opts.signal.aborted, false);
        return "Draft after resize";
      },
      notify() {},
    },
  });
  assert.equal(result.details.answer, "Draft after resize");
});

test("native question history keeps only the newest hundred distinct answers", async () => {
  const tool = getTool(createHarness(), "question");
  for (let index = 0; index <= 100; index++) {
    assert.equal((await nativeQuestion(tool, [{ select: /Custom answer/u }, { input: `answer-${index}` }]).result).details.answer, `answer-${index}`);
  }
  const { result } = nativeQuestion(tool, [
    { select: /More actions/u }, { select: /Recent answers/u },
    ...Array.from({ length: 9 }, () => ({ select: /Next choices/u })),
    { select: /answer-1$/u, inspect(_title, choices) { assert.equal(choices.includes("Next choices"), false); assert.equal(choices.some((value) => /answer-0$/u.test(value)), false); } },
  ]);
  assert.equal((await result).details.answer, "answer-1");
});

test("native question cancelling history and review steps preserves selected answers", async () => {
  const tool = getTool(createHarness(), "question");
  assert.equal((await nativeQuestion(tool, [{ select: /Custom answer/u }, { input: "Saved" }]).result).details.answer, "Saved");
  const { result } = nativeQuestion(tool, [
    { select: /Alpha/u }, { select: /More actions/u }, { select: /Recent answers/u }, { select: undefined },
    { select: /More actions/u }, { select: /Review option details/u }, { select: undefined },
    { select: /More actions/u }, { select: /Review option details/u }, { select: /Alpha/u }, { select: undefined },
    { select: /Submit answers/u },
  ], { mode: "multiple" });
  assert.deepEqual((await result).details.answers, ["Alpha"]);
});

test("native question cancellation while the selector closes cannot publish a late answer", async () => {
  const controller = new AbortController();
  const result = getTool(createHarness(), "question").execute("closing-abort", { question: "Choose", options: [{ label: "Alpha" }] }, controller.signal, () => {}, {
    mode: "tui", ui: {
      async select(_title: string, choices: string[]) {
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort())));
        return choices[0];
      },
    },
  });
  await assert.rejects(result, { message: "Question cancelled because the agent operation was aborted" });
});
