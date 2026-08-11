# Optional Question Multi-Select Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. Implement this plan task-by-task; finish one task before starting the next.

**STATUS:** DONE

**Goal:** Add an explicit, bounded multi-select mode to the existing `question` tool while leaving every existing single-select call and interaction unchanged.

**Architecture:** Extend the existing TypeBox contract with an optional Google-compatible mode and selection bounds, then keep single-select on its current path while adding multi-select state inside `killeros/question.ts`. Multi-select uses checked original option indices plus at most one custom answer, a dedicated `/` filter editor, and a distinct array-based result contract; the existing responsive renderer remains the sole TUI component.

**Tech Stack:** Strict TypeScript 5.9, Node.js 22.19 or later, Node’s built-in test runner with `--experimental-strip-types`, TypeBox 1.1, `@earendil-works/pi-ai` `StringEnum`, and public `@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` 0.82.1 APIs.

**Environment:** Use inline execution in the main worktree, not an isolated worktree. At plan creation the worktree is clean, `npm run check` passes, and `npm test` reports 170 tests: 168 passed and 2 Windows link-only tests skipped.

## Global Constraints

- Single-select remains the default when `mode` is absent and remains available explicitly as `mode: "single"`.
- Multi-select activates only with `mode: "multiple"`.
- Existing single-select schema inputs, controls, filtering, custom-answer completion, result details, transcript rendering, cancellation, previews, history, and tiny-terminal behavior must remain unchanged.
- Add optional integer `minSelections` and `maxSelections` only for multi-select. The effective minimum defaults to `1`; the effective maximum defaults to `options.length + 1`, including the one custom-answer slot.
- Reject bounds unless `1 <= minSelections <= maxSelections <= options.length + 1`; reject selection-bound fields in single-select mode instead of silently ignoring them.
- Multi-select browse mode uses Space to toggle a predefined option and the effective `tui.select.confirm` binding—Enter by default—to submit.
- On the custom-answer row, the effective confirm binding opens or edits the custom answer. Space removes an existing custom answer and does nothing when no custom answer exists.
- Number keys keep single-select behavior. In multi-select browse mode, `1` through `9` toggle the corresponding visible predefined option; the number for the custom row opens or edits it.
- Multi-select supports exactly one custom answer. It is additive, counts as one selection, and appears after predefined answers in results.
- Return predefined answers in original option order, regardless of filter state or toggle order. Return their existing one-based indices in the same order.
- When the maximum is reached, preserve current choices, reject an additional choice, and show an error notice. Never replace or submit automatically.
- Multi-select filtering is explicit: `/` opens a filter editor; the editor accepts spaces and paste; its effective submit binding applies the draft and returns to browse; its effective cancel binding discards the draft and returns to browse.
- In multi-select browse mode, the effective cancel binding first clears an applied filter; with no filter it cancels the question. Checked options survive filtering and filter clearing.
- Multi-select result details use arrays and do not overload the single-select `answer` or `selectedIndex` fields.
- Collapsed multi-select results show selected names that fit and an exact `+N more` suffix whenever the suffix fits; narrower widths use bounded fallback text. Expanded results show every answer.
- Keep filter limits at exactly 4,000 characters and 16,000 UTF-8 bytes, custom answers at exactly 4,000 characters, option counts at 1–9, labels at 200 characters, descriptions at 500 characters, and previews at 8,000 characters.
- Render no more rows than `tui.terminal.rows` and no line wider than the supplied render width, including 1–5-row terminal layouts.
- Selector navigation and confirmation continue to use Pi’s effective keybindings and matching help text. Space and `/` are fixed multi-select controls because Pi 0.82.1 exposes no selector-toggle or selector-filter keybinding action.
- Add no dependency and do not change package versions.
- Do not commit, push, publish, or modify unrelated code during inline execution.
- Before inline execution, record `git status --short`; preserve unrelated changes if the state differs from this plan’s clean baseline.
- After each task, run its focused tests and inspect only that task’s bounded diff. Inspect a failed command before retrying; stop after the third failed attempt and report retained changes before starting another task.
- When all checks pass, add `STATUS: DONE` and move this plan to `docs/implemented/2026-08-11-question-multi-select.md`.

---

## File Responsibility Map

| File | Responsibility after this work |
|---|---|
| `killeros/question.ts` | Own the single- and multi-select schemas, validation, interaction states, responsive question UI, result contracts, and call/result transcript rendering. |
| `test/Killeros.test.ts` | Prove provider-compatible schema behavior, backward compatibility, multi-select bounds and interactions, explicit filter mode, rendering, and cancellation. |
| `test/RepositoryContracts.test.ts` | Keep the product, design, README, and changelog descriptions aligned with the shipped question behavior. |
| `README.md` | Document opt-in multi-select, bounds, custom answers, and keyboard controls. |
| `PRODUCT.md` | State the product-level compatibility, filtering, selection, and responsive behavior. |
| `DESIGN.md` | Define checkbox, status, hint, preview, filter-editor, and transcript presentation rules. |
| `CHANGELOG.md` | Record the implemented user-visible feature under `[Unreleased]`. |
| `docs/spec/2026-08-11-question-multi-select.md` | Track inline execution until verification, then move to `docs/implemented`. |

## Stable Interfaces Between Tasks

Use these contracts in `killeros/question.ts`:

```ts
type QuestionMode = "single" | "multiple";

interface SingleQuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  selectedIndex?: number;
  wasCustom?: boolean;
  cancelled?: boolean;
}

interface MultipleQuestionDetails {
  question: string;
  options: string[];
  mode: "multiple";
  answers: string[];
  selectedIndices: number[];
  customAnswer?: string;
  cancelled?: boolean;
}

type QuestionDetails = SingleQuestionDetails | MultipleQuestionDetails;

type QuestionSelection =
  | { kind: "selected"; answer: string; originalIndex: number }
  | { kind: "custom"; answer: string }
  | {
      kind: "multiple";
      answers: string[];
      selectedIndices: number[];
      customAnswer?: string;
    }
  | { kind: "cancelled" }
  | { kind: "aborted" };
```

Successful multi-select output has this exact semantic shape:

```ts
{
  content: [{
    type: "text",
    text: "User selected multiple answers:\n- Alpha\n- Beta\n- Custom answer",
  }],
  details: {
    question: "Choose all that apply",
    options: ["Alpha", "Beta", "Gamma"],
    mode: "multiple",
    answers: ["Alpha", "Beta", "Custom answer"],
    selectedIndices: [1, 2],
    customAnswer: "Custom answer",
  },
}
```

Cancelled multi-select output remains explicit and array-safe:

```ts
{
  content: [{ type: "text", text: "User cancelled the question" }],
  details: {
    question: "Choose all that apply",
    options: ["Alpha", "Beta"],
    mode: "multiple",
    answers: [],
    selectedIndices: [],
    cancelled: true,
  },
}
```

Do not add `mode`, `answers`, `selectedIndices`, or `customAnswer` to existing single-select results.

---

### Task 1: Add the backward-compatible multi-select contract and selection flow

**Files:**
- Modify: `killeros/question.ts:1-560`
- Modify: `test/Killeros.test.ts:114-145,371-407,2425-2740`
- Verify: `test/Killeros.test.ts`

**Interfaces:**
- Consumes: `registerQuestionTool()`, `QuestionParams`, `QuestionSelection`, `QuestionDetails`, `startQuestion()`, Pi’s effective selector keybindings, and the stable interfaces above.
- Produces: optional `mode`, `minSelections`, and `maxSelections` inputs; checked predefined options; one additive custom answer; deterministic multi-select output; unchanged single-select output.

**Verification strategy:** behavioral test plus schema validation

- [x] **Step 1: Extend the harness without changing existing test calls**

Add a final optional argument to `startQuestion()` so all current positional callers remain valid. Change the end of its parameter list from:

```ts
  terminalRows = 40,
  keybindings = getKeybindings(),
) {
```

to:

```ts
  terminalRows = 40,
  keybindings = getKeybindings(),
  extraParams = {},
) {
```

Then change its tool input from:

```ts
    { question: questionText, options },
```

to:

```ts
    { question: questionText, options, ...extraParams },
```

- [x] **Step 2: Add failing schema, default-mode, and validation tests**

Place these near the current provider-schema and question tests. Keep the existing Google-compatibility test intact:

```ts
test("question exposes a Google-compatible optional selection mode", () => {
  const tool = createHarness().tools.get("question");
  const schema = JSON.parse(JSON.stringify(tool.parameters));

  assert.deepEqual(schema.properties.mode, {
    type: "string",
    enum: ["single", "multiple"],
    description: "Choose one answer or multiple answers; defaults to single",
  });
  assert.equal(Check(tool.parameters, {
    question: "Choose",
    options: [{ label: "Alpha" }],
  }), true);
  assert.equal(Check(tool.parameters, {
    question: "Choose",
    options: [{ label: "Alpha" }],
    mode: "multiple",
    minSelections: 1,
    maxSelections: 2,
  }), true);
  assert.equal(Check(tool.parameters, {
    question: "Choose",
    options: [{ label: "Alpha" }],
    mode: "ranked",
  }), false);
});

test("question rejects invalid or single-select selection bounds before opening the UI", async () => {
  const tool = createHarness().tools.get("question");
  const ctx = {
    mode: "tui",
    ui: {
      custom: () => { throw new Error("UI must not open for invalid bounds"); },
      notify: () => {},
    },
  };
  const execute = (extra) => tool.execute(
    "question-bounds",
    { question: "Choose", options: [{ label: "Alpha" }], ...extra },
    new AbortController().signal,
    () => {},
    ctx,
  );

  await assert.rejects(execute({ minSelections: 1 }), /require mode.*multiple/iu);
  await assert.rejects(execute({ mode: "single", maxSelections: 1 }), /require mode.*multiple/iu);
  await assert.rejects(execute({ mode: "multiple", minSelections: 2, maxSelections: 1 }), /minimum.*maximum/iu);
  await assert.rejects(execute({ mode: "multiple", maxSelections: 3 }), /at most 2 selections/iu);
});
```

The validation test must not enter `ctx.ui.custom`; use a local context whose `custom()` throws if called so the test proves fail-fast behavior.

- [x] **Step 3: Add failing interaction and result-contract tests**

Add focused tests that drive the real custom component:

```ts
test("question keeps single-select as the unchanged default", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }],
  );
  question.component.handleInput("\x1B[B");
  question.component.handleInput("\r");
  const result = await question.result;

  assert.equal(result.content[0].text, "User selected: Beta");
  assert.deepEqual(result.details, {
    question: "Choose",
    options: ["Alpha", "Beta"],
    answer: "Beta",
    selectedIndex: 2,
    wasCustom: false,
  });
});

test("multi-select toggles choices and returns original option order", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple", minSelections: 2, maxSelections: 3 },
  );

  question.component.handleInput("\x1B[B");
  question.component.handleInput(" "); // Beta first
  question.component.handleInput("\x1B[A");
  question.component.handleInput(" "); // Alpha second
  question.component.handleInput("\r");
  const result = await question.result;

  assert.equal(result.content[0].text, "User selected multiple answers:\n- Alpha\n- Beta");
  assert.deepEqual(result.details, {
    question: "Choose all",
    options: ["Alpha", "Beta", "Gamma"],
    mode: "multiple",
    answers: ["Alpha", "Beta"],
    selectedIndices: [1, 2],
  });
});

test("multi-select adds one custom answer after predefined answers", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple", maxSelections: 3 },
  );

  question.component.handleInput("2"); // Toggle Beta.
  question.component.handleInput("3"); // Open custom editor.
  question.component.handleInput("Different choice");
  question.component.handleInput("\r"); // Add custom answer and return to browse.
  question.component.handleInput("\r"); // Submit checked answers.
  const result = await question.result;

  assert.deepEqual(result.details.answers, ["Beta", "Different choice"]);
  assert.deepEqual(result.details.selectedIndices, [2]);
  assert.equal(result.details.customAnswer, "Different choice");
});

test("multi-select enforces minimum and maximum without replacing choices", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple", minSelections: 1, maxSelections: 1 },
  );

  question.component.handleInput("\r");
  assert.match(question.notifications.at(-1).message, /Select at least 1/u);
  question.component.handleInput(" ");
  question.component.handleInput("\x1B[B");
  question.component.handleInput(" ");
  assert.match(question.notifications.at(-1).message, /Select at most 1/u);
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details.answers, ["Alpha"]);
});

test("multi-select cancellation returns empty arrays", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple" },
  );
  question.component.handleInput("\x1B");
  assert.deepEqual((await question.result).details, {
    question: "Choose all",
    options: ["Alpha"],
    mode: "multiple",
    answers: [],
    selectedIndices: [],
    cancelled: true,
  });
});
```

Also cover these exact cases in separate assertions or focused tests:

- toggling a checked option removes it;
- visible digit shortcuts toggle rather than submit in multi-select;
- Space on an unanswered custom row leaves state unchanged;
- effective confirmation on the custom row opens the editor;
- submitting a custom draft at the maximum rejects it without losing the draft or checked options;
- editing an existing custom answer at the maximum is allowed because it does not add a selection;
- Space on an existing custom answer removes it;
- custom-answer history is updated only after a non-empty custom answer is accepted;
- an empty custom draft returns to browse without adding an answer;
- abort still rejects with `Question cancelled because the agent operation was aborted`.

- [x] **Step 4: Run the focused tests and confirm the pre-change failure**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="question.*(selection mode|selection bounds|single-select|multi-select)" test/Killeros.test.ts
```

Expected before implementation: FAIL because the schema rejects or ignores the new mode fields, Enter still finishes one choice, Space becomes filter text, and array-based details do not exist.

- [x] **Step 5: Add the provider-compatible schema and fail-fast bounds**

Import `StringEnum` and extend the existing object schema without `anyOf`, `oneOf`, or a top-level union:

```ts
import { StringEnum } from "@earendil-works/pi-ai";

const QuestionParams = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 1_000, description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, {
    minItems: 1,
    maxItems: 9,
    description: "Between 1 and 9 options for the user to choose from",
  }),
  mode: Type.Optional(StringEnum(["single", "multiple"] as const, {
    description: "Choose one answer or multiple answers; defaults to single",
  })),
  minSelections: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: "Minimum answers required in multiple mode; defaults to 1",
  })),
  maxSelections: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: "Maximum answers allowed in multiple mode; defaults to all options plus one custom answer",
  })),
});
```

At the start of `execute()`, before `ctx.ui.custom()`, derive and validate:

```ts
const mode: QuestionMode = params.mode ?? "single";
const hasSelectionBounds = params.minSelections !== undefined || params.maxSelections !== undefined;
if (mode === "single" && hasSelectionBounds) {
  throw new Error("Question selection bounds require mode \"multiple\"");
}
const maximumAvailable = params.options.length + 1;
const minSelections = params.minSelections ?? 1;
const maxSelections = params.maxSelections ?? maximumAvailable;
if (minSelections > maxSelections) {
  throw new Error("Question minimum selections cannot exceed maximum selections");
}
if (maxSelections > maximumAvailable) {
  throw new Error(`Question allows at most ${maximumAvailable} selections including one custom answer`);
}
```

Update the tool description and prompt guidance to say that multi-select is opt-in and bounded. Do not instruct the model to use multi-select for ordinary either/or decisions.

- [x] **Step 6: Implement multi-select state without changing the single-select completion path**

Keep the existing single-select branches intact behind `mode === "single"`. Add only the multi-select state required by the stable contract:

```ts
const selectedOriginalIndices = new Set<number>();
let customAnswer: string | undefined;

type EditMode = "none" | "custom";
let editMode: EditMode = "none";

const selectedCount = (): number => selectedOriginalIndices.size + (customAnswer === undefined ? 0 : 1);
const orderedMultipleSelection = () => {
  const selectedIndices = [...selectedOriginalIndices].sort((left, right) => left - right);
  const predefined = selectedIndices.map((index) => params.options[index - 1]!.label);
  return {
    answers: customAnswer === undefined ? predefined : [...predefined, customAnswer],
    selectedIndices,
    ...(customAnswer === undefined ? {} : { customAnswer }),
  };
};
```

Use one bounded toggle helper for Space and digit shortcuts:

```ts
const togglePredefined = (option: DisplayOption): void => {
  if (selectedOriginalIndices.has(option.originalIndex)) {
    selectedOriginalIndices.delete(option.originalIndex);
    refresh();
    return;
  }
  if (selectedCount() >= maxSelections) {
    ctx.ui.notify(`Select at most ${maxSelections} answer${maxSelections === 1 ? "" : "s"}`, "error");
    return;
  }
  selectedOriginalIndices.add(option.originalIndex);
  refresh();
};
```

Multi-select browse behavior must follow this order:

1. Effective navigation and page keys move focus exactly as today.
2. A non-pasted decoded single Space toggles a predefined option; on the custom row it removes an existing custom answer.
3. A non-pasted digit toggles the visible numbered predefined option; the custom-row digit enters custom mode.
4. Effective confirmation on the custom row enters custom mode.
5. Effective confirmation elsewhere validates `selectedCount() >= minSelections`, then finishes with `{ kind: "multiple", ...orderedMultipleSelection() }`.
6. Effective cancellation follows Task 2’s filter-aware behavior; until Task 2 adds filter mode, it cancels with `{ kind: "cancelled" }`.
7. Other printable browse input does not alter the filter in multi-select.

When the custom editor submits a non-empty answer:

```ts
if (mode === "multiple") {
  const addsSelection = customAnswer === undefined;
  if (addsSelection && selectedCount() >= maxSelections) {
    ctx.ui.notify(`Select at most ${maxSelections} answer${maxSelections === 1 ? "" : "s"}`, "error");
    return;
  }
  if (!rememberCustomInput(answer)) {
    ctx.ui.notify(`Custom answer history is limited to ${CUSTOM_INPUT_HISTORY_BYTES} bytes`, "error");
    return;
  }
  customAnswer = answer;
  editMode = "none";
  editor.setText("");
  refresh();
  return;
}
```

Keep current Unicode character checks, history byte checks, and empty-draft behavior. Do not create a second editor or a second TUI component.

- [x] **Step 7: Return the stable multi-select result while preserving exact single-select details**

Before the existing single-select result branches, add mode-aware cancellation and successful multi-select output:

```ts
if (result.kind === "cancelled" && mode === "multiple") {
  return {
    content: [{ type: "text", text: "User cancelled the question" }],
    details: {
      question: params.question,
      options: simpleOptions,
      mode: "multiple",
      answers: [],
      selectedIndices: [],
      cancelled: true,
    },
  };
}
if (result.kind === "multiple") {
  return {
    content: [{
      type: "text",
      text: `User selected multiple answers:\n${result.answers.map((answer) => `- ${answer}`).join("\n")}`,
    }],
    details: {
      question: params.question,
      options: simpleOptions,
      mode: "multiple",
      answers: result.answers,
      selectedIndices: result.selectedIndices,
      ...(result.customAnswer === undefined ? {} : { customAnswer: result.customAnswer }),
    },
  };
}
```

Leave the existing aborted, cancelled-single, custom-single, and selected-single return values byte-for-byte equivalent.

- [x] **Step 8: Run focused verification and inspect the bounded diff**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="question.*(selection mode|selection bounds|single-select|multi-select|custom-answer history)" test/Killeros.test.ts
npm run check
git diff -- killeros/question.ts test/Killeros.test.ts
```

Expected: all focused tests pass; TypeScript reports no errors; the diff contains only the schema, mode validation, selection state, result contract, and focused harness/tests described in this task.

---

### Task 2: Add explicit multi-select filtering and responsive checkbox/transcript rendering

**Files:**
- Modify: `killeros/question.ts:170-560`
- Modify: `test/Killeros.test.ts:2425-2740`
- Verify: `test/Killeros.test.ts`

**Interfaces:**
- Consumes: Task 1’s `mode`, selection bounds, checked-index set, custom answer, result arrays, current `Editor`, `decodeQuestionFilterInput()`, bounded viewport helpers, and effective Pi keybindings.
- Produces: `/` filter-editing mode, filter-preserving selection behavior, checkbox/status rendering, compact `+N more` results, and complete expanded results.

**Verification strategy:** behavioral test

- [x] **Step 1: Add failing explicit-filter and selection-persistence tests**

Add tests that distinguish browse, filter, and custom editing:

```ts
test("multi-select uses slash filter mode and accepts spaces", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha one" }, { label: "Beta two" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple" },
  );

  question.component.handleInput("/");
  question.component.handleInput("Beta two");
  assert.match(question.component.render(60).join("\n"), /Filter 8\/4,000/u);
  question.component.handleInput("\r");
  const applied = question.component.render(60).join("\n");
  assert.match(applied, /Beta two/u);
  assert.doesNotMatch(applied, /Alpha one/u);
  question.component.handleInput(" ");
  question.component.handleInput("\x1B"); // Clear applied filter.
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details.answers, ["Beta two"]);
});

test("multi-select escape discards filter edits and preserves the applied filter", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple" },
  );

  question.component.handleInput("/");
  question.component.handleInput("Alpha");
  question.component.handleInput("\r");
  question.component.handleInput("/");
  question.component.handleInput("Beta");
  question.component.handleInput("\x1B");
  assert.match(question.component.render(60).join("\n"), /Alpha/u);
  assert.doesNotMatch(question.component.render(60).join("\n"), /Beta/u);
});

test("multi-select keeps hidden checks across filter changes", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple", minSelections: 2 },
  );

  question.component.handleInput(" ");
  question.component.handleInput("/");
  question.component.handleInput("Beta");
  question.component.handleInput("\r");
  question.component.handleInput(" ");
  question.component.handleInput("\r");
  assert.deepEqual((await question.result).details.answers, ["Alpha", "Beta"]);
});
```

Also add exact cases for:

- `/` reopens the filter editor with the current applied query;
- Enter with an empty filter draft clears the filter;
- pasted multi-word and Kitty printable input work inside filter mode;
- filter mode enforces both existing 4,000-character and 16,000-byte limits;
- filter-mode Escape does not cancel the question;
- browse-mode Escape clears a filter before a second Escape cancels;
- single-select still begins filtering from ordinary printable input and treats `/` as ordinary filter text;
- multi-select browse ignores ordinary letters instead of silently starting a filter;
- custom-answer editing remains separate from filter editing and preserves history behavior.

- [x] **Step 2: Add failing checkbox, tiny-terminal, and transcript tests**

Drive the component and tool renderers:

```ts
test("multi-select renders checked state, bounds, and discoverable controls", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    [{ label: "Alpha" }, { label: "Beta" }],
    "Choose all",
    10,
    getKeybindings(),
    { mode: "multiple", minSelections: 1, maxSelections: 2 },
  );
  assert.match(question.component.render(80).join("\n"), /\[ \].*Alpha/u);
  assert.match(question.component.render(80).join("\n"), /Selected 0.*1–2/u);
  assert.match(question.component.render(80).join("\n"), /space.*toggle.*\/.*filter.*enter.*submit/iu);
  question.component.handleInput(" ");
  assert.match(question.component.render(80).join("\n"), /\[x\].*Alpha/iu);
  question.finish({ kind: "cancelled" });
  await question.result;
});

test("multi-select rendering remains bounded at every compact height", async () => {
  const question = await startQuestion(
    createHarness().tools.get("question"),
    Array.from({ length: 9 }, (_, index) => ({ label: `Choice ${index + 1} ${"L".repeat(180)}` })),
    `Choose ${"Q".repeat(990)}`,
    12,
    getKeybindings(),
    { mode: "multiple", minSelections: 1, maxSelections: 10 },
  );
  question.component.handleInput(" ");

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

test("multi-select transcript collapses names with exact overflow and expands all answers", () => {
  const tool = createHarness().tools.get("question");
  const result = {
    content: [{ type: "text", text: "User selected multiple answers" }],
    details: {
      question: "Choose all",
      options: ["Alpha", "Beta", "Gamma", "Delta"],
      mode: "multiple",
      answers: ["Alpha", "Beta", "Gamma", "Delta"],
      selectedIndices: [1, 2, 3, 4],
    },
  };

  const collapsed = tool.renderResult(result, { expanded: false }, theme).render(24).join("\n");
  assert.match(collapsed, /Alpha/u);
  assert.match(collapsed, /\+[1-3] more/u);
  const expanded = tool.renderResult(result, { expanded: true }, theme).render(24).join("\n");
  for (const answer of result.details.answers) assert.match(expanded, new RegExp(answer, "u"));
});
```

Also assert that `renderCall()` labels `mode: "multiple"` as a multi-select question and shows its effective selection range, while calls without mode retain the existing compact and expanded rendering.

- [x] **Step 3: Run the focused tests and confirm the pre-change failure**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="(multi-select.*filter|multi-select.*render|multi-select.*transcript|question filtering)" test/Killeros.test.ts
```

Expected before implementation: FAIL because multi-select has no separate filter-editing state, checkbox/status rendering, or array-aware transcript renderer.

- [x] **Step 4: Reuse the existing editor for a separate filter-editing state**

Expand the mode state without adding another component:

```ts
type EditMode = "none" | "filter" | "custom";
let editMode: EditMode = "none";
let filterQuery = ""; // Applied filter only.
```

Open filter mode only from multi-select browse mode on a non-pasted decoded `/`:

```ts
const enterFilterMode = (): void => {
  editMode = "filter";
  editor.setText(filterQuery);
  refresh();
};
```

Route `editor.onSubmit` by edit mode:

```ts
editor.onSubmit = (value) => {
  if (editMode === "filter") {
    filterQuery = value;
    optionIndex = 0;
    editMode = "none";
    editor.setText("");
    refresh();
    return;
  }
  // Keep Task 1's single- and multi-select custom-answer handling here.
};
```

While `editMode === "filter"`:

1. Effective cancel sets `editMode = "none"`, clears the editor draft, and leaves `filterQuery` unchanged.
2. All other input goes through the existing `Editor` so spaces, paste, Kitty input, cursor movement, and grapheme deletion work.
3. Compare the editor value before and after each input. If the draft exceeds 4,000 characters or 16,000 UTF-8 bytes, restore the previous value and show the existing bounded-filter error.
4. Render `Filter <count>/4,000` and the visible editor draft; show effective submit and cancel hints.

In multi-select browse mode:

```ts
if (keybindings.matches(data, "tui.select.cancel")) {
  if (filterQuery) {
    filterQuery = "";
    optionIndex = 0;
    refresh();
  } else {
    finish({ kind: "cancelled" });
  }
  return;
}
```

Decode paste before testing fixed controls so pasted `/`, digits, and spaces never trigger browse actions. Keep the current single-select input branch unchanged.

- [x] **Step 5: Render multi-select state within every existing row budget**

For multi-select option rows, use a pointer plus a non-color checkbox:

```ts
const checked = option.isOther
  ? customAnswer !== undefined
  : selectedOriginalIndices.has(option.originalIndex);
const pointer = isFocused ? ">" : " ";
const checkbox = checked ? "[x]" : "[ ]";
const label = option.isOther && customAnswer !== undefined
  ? `Custom: ${oneLine(customAnswer)}`
  : option.label;
const row = `${pointer} ${checkbox} ${index + 1}. ${label}`;
```

Status rules:

```ts
const selectionRange = minSelections === maxSelections
  ? `${minSelections}`
  : `${minSelections}–${maxSelections}`;
const selectionStatus = `Selected ${selectedCount()} · required ${selectionRange}`;
```

Apply these layout requirements to existing branches rather than creating a second renderer:

- 1–2 rows: show the focused checked row when it fits; otherwise preserve `Selected N`.
- 3–5 rows: preserve bounded question text, focused row or editor draft, selection/filter progress, and the most relevant controls.
- 6+ rows: preserve the moving option window, previews, hidden-above/below counts, selection/filter status, and a final hint row.
- Browse hints include fixed `space toggle`, fixed `/ filter`, effective navigation keys, effective confirm as `submit`, and effective cancel as `clear filter` or `cancel`.
- On the custom row, label effective confirm `add custom` or `edit custom`; label Space `remove custom` only when one exists.
- Filter mode hints use effective `tui.input.submit` and `tui.select.cancel` bindings.
- Keep every final line passed through `boundedRenderLine()` and every returned array sliced to `rowBudget`.

- [x] **Step 6: Add array-aware call and result transcript rendering**

In `renderCall()`, detect `args.mode === "multiple"`. Keep current single-select output unchanged; for multi-select add a compact second row such as `3 options · choose 1–4` and use checkbox markers in expanded output.

Add a width-aware compact helper that preserves an exact overflow count:

```ts
function compactMultipleAnswers(answers: readonly string[], width: number): string {
  const prefix = "✓ ";
  if (answers.length === 0) return prefix + "No answers";
  const visible: string[] = [];
  for (let index = 0; index < answers.length; index += 1) {
    const remaining = answers.length - index - 1;
    const candidate = [...visible, oneLine(answers[index]!)].join(", ");
    const suffix = remaining > 0 ? `, +${remaining} more` : "";
    if (visibleWidth(prefix + candidate + suffix) > width) break;
    visible.push(oneLine(answers[index]!));
  }
  if (visible.length === answers.length) return prefix + visible.join(", ");
  const hidden = answers.length - visible.length;
  if (visible.length === 0) return truncateToWidth(`${prefix}+${hidden} more`, width, "…");
  return truncateToWidth(`${prefix}${visible.join(", ")}, +${hidden} more`, width, "…");
}
```

Use the helper from a small renderable component or `BoundedText` wrapper that receives `width` at render time. Expanded multi-select results render one answer per line and mark the custom item as `(wrote)` without changing answer order. Cancellation remains `Cancelled`.

- [x] **Step 7: Run focused and full question verification, then inspect the bounded diff**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="question|multi-select" test/Killeros.test.ts
npm run check
git diff -- killeros/question.ts test/Killeros.test.ts
```

Expected: all existing single-select and new multi-select question tests pass; TypeScript reports no errors; tiny-terminal assertions prove every line and row stays bounded.

---

### Task 3: Align documentation, changelog, and repository contracts

**Files:**
- Modify: `README.md:45-90`
- Modify: `PRODUCT.md:23-36`
- Modify: `DESIGN.md:90-180`
- Modify: `CHANGELOG.md:3-15`
- Modify: `test/RepositoryContracts.test.ts:75-150`
- Move after verification: `docs/spec/2026-08-11-question-multi-select.md` → `docs/implemented/2026-08-11-question-multi-select.md`
- Verify: `test/RepositoryContracts.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2’s shipped schema, controls, result behavior, and responsive UI.
- Produces: user-facing usage documentation, lasting product/design constraints, a notable unreleased changelog entry, and completed-plan status.

**Verification strategy:** documentation contract check plus full repository verification

- [x] **Step 1: Add failing documentation contract assertions**

Extend `product and design docs match current runtime contracts` with exact behavior anchors:

```ts
assert.match(readme, /`mode: "multiple"`/u);
assert.match(readme, /Space.*toggle.*`\/`.*filter.*Enter.*submit/isu);
assert.match(readme, /single-select remains the default/iu);
assert.match(product, /multi-select.*opt-in/iu);
assert.match(product, /dedicated `\/` filter editor/iu);
assert.match(design, /### Question Selector/u);
assert.match(design, /\[ \].*\[x\]/isu);
assert.match(changelog, /optional multi-select.*question/iu);
```

Run:

```bash
node --test --experimental-strip-types test/RepositoryContracts.test.ts
```

Expected before documentation edits: FAIL because the new behavior is not documented.

- [x] **Step 2: Document exact user and model behavior**

Update the README feature bullet to include opt-in multi-select. Add a short `### Interactive questions` subsection containing this exact operational content:

```markdown
Single-select remains the default. An agent opts into multi-select with `mode: "multiple"` and may set `minSelections` and `maxSelections`; the custom answer counts as one selection.

In multi-select, use Space or a visible number to toggle an option and Enter to submit. Press `/` to edit a filter, including spaces; Enter applies it and Escape returns to the choices. Checked options remain selected when the filter changes. Select **Type a custom answer** with Enter to add or edit one custom item alongside checked options.
```

Do not expose internal result types in the README.

- [x] **Step 3: Record product and design constraints**

In `PRODUCT.md`, add capability bullets stating:

```markdown
- The `question` tool remains single-select by default and supports opt-in bounded multi-select with one additive custom answer.
- Multi-select uses Space for checked state, Enter for submission, and a dedicated `/` filter editor so typed filters can contain spaces; filtering never clears checked answers.
```

In `DESIGN.md`, add `### Question Selector` under Components:

```markdown
### Question Selector
- **Single-select:** Preserve type-to-filter, configured Pi navigation and confirmation, custom answers, previews, and current result rendering.
- **Multi-select:** Use `[ ]` and `[x]` plus text so checked state never depends on color. Keep the focus pointer separate from checked state.
- **Controls:** Show Space as toggle, `/` as filter, and the effective Pi confirmation key as submit. The custom row uses confirmation to add or edit and Space to remove.
- **Status:** Keep `Selected N` and the required range visible before lower-priority preview detail. Reject excess choices without replacing existing checks.
- **Filtering:** Render filter editing as a distinct input state. Applied filters may hide checked options but never clear them.
- **Transcript:** Compact results show selected names followed by an exact `+N more` overflow; expanded results show every answer in original option order with custom text last.
- **Adaptation:** At tiny heights preserve the focused choice or selected count, then controls; never exceed terminal width or height.
```

- [x] **Step 4: Add the changelog entry only after implementation is verified**

Under `[Unreleased]` → `### Added`, add:

```markdown
- Added opt-in bounded multi-select to the `question` tool with checked options, one additive custom answer, a dedicated multi-word filter editor, and compact expandable results while preserving single-select defaults.
```

Create `### Added` above `### Changed` if it is absent. Do not change a released version section.

- [x] **Step 5: Run documentation and full repository verification**

Run in this order:

```bash
node --test --experimental-strip-types test/RepositoryContracts.test.ts
npm run check
npm test
npm pack --dry-run
git diff --check
git diff -- killeros/question.ts test/Killeros.test.ts test/RepositoryContracts.test.ts README.md PRODUCT.md DESIGN.md CHANGELOG.md
```

Expected:

- repository contract tests pass;
- TypeScript reports no errors;
- the full suite passes with only the two existing environment-dependent Windows link tests skipped when links remain unavailable;
- the package dry run includes `killeros/question.ts`, `README.md`, and `CHANGELOG.md` and adds no dependency or unintended file;
- `git diff --check` reports no whitespace errors;
- the bounded diff contains only this feature, its tests, and its documentation.

- [x] **Step 6: Mark the plan complete and move it to implemented**

After every command in Step 5 passes:

1. Add `**STATUS:** DONE` directly below the agentic-workers block near the top of this file.
2. Move the file without changing its basename:

```bash
mv docs/spec/2026-08-11-question-multi-select.md docs/implemented/2026-08-11-question-multi-select.md
```

3. Because `docs/` is ignored except for explicitly tracked files, verify the moved plan directly:

```bash
test ! -e docs/spec/2026-08-11-question-multi-select.md
test -e docs/implemented/2026-08-11-question-multi-select.md
rg -n "STATUS: DONE|^- \[ \]" docs/implemented/2026-08-11-question-multi-select.md
```

Expected: the spec path is absent, the implemented path exists, `STATUS: DONE` is present, and no unchecked task remains. Change every completed checkbox to `- [x]` during inline execution before this final check.

---

## Inline Execution Completion Gate

Inline execution is complete only when all three tasks are checked, the plan is under `docs/implemented`, and the completion report states:

```text
Execution summary
- Tasks complete: 3 / 3
- Checks passed: focused question tests, repository contracts, TypeScript, full tests, package dry run, and diff checks
- Unrelated work preserved: yes

Issues
- None

Remaining actions
- None
```

If a check cannot pass after the initial attempt and two inspected retries, stop before the next task. Report the exact command, output, corrections attempted, and retained changes; do not mark the plan done or move it.
