# Feature-owned test suite split

STATUS: DONE

**Goal:** Delete `test/Killeros.test.ts` and move every test into a flat, feature-owned test file without changing product behavior or weakening coverage.

**Architecture:** Keep Node's built-in test runner and the current `test/*.test.*` command. Put extension-host setup in one shared `test/ExtensionTestHarness.ts` module. Keep feature fixtures and expected values in their owning test files. Split the Goal tests into command, lifecycle, and UI files because one Goal file would still exceed 1,400 source lines before imports and helpers.

**Tech stack:** TypeScript 5.9 in strict mode, Node.js 22.19 or later, `node:test`, `node:assert/strict`, the existing Pi test adapters, and the installed `@earendil-works/pi-*` packages.

## Problem

`test/Killeros.test.ts` is a catch-all suite rather than a feature suite.

The current file has these properties:

- 5,875 lines.
- 175 of the repository's 304 tests.
- 552 lines before the first test.
- Imports from the extension entry point and nine distinct feature modules.
- Tests for commands, Goal state, `/init`, lifecycle hooks, the Question tool, theme rules, footer rendering, editor behavior, and shell startup.
- Shared helpers inserted between unrelated test groups, including `createTuiContext()` and `emitSequentially()`.

The existing suite already has focused files such as `Handoff.test.ts`, `InitEvidence.test.ts`, `Activity.test.ts`, and `SlashCommands.test.ts`. `Killeros.test.ts` bypasses that structure because `createHarness()` and the simulated Pi host live inside the catch-all file. Appending a test there is cheaper than creating a feature file, even when a focused file already exists.

The split must remove that incentive. Moving tests while leaving a feature-aware utility dump would only rename the problem.

## Current verified baseline

The baseline was verified on 2026-08-30 with a clean worktree.

```text
Killeros.test.ts: 5,875 lines
Repository test files and support files: 9,566 lines
Tests: 304
Passed: 301
Skipped: 3
Failed: 0
TypeScript and ESLint check: passed
```

Commands:

```bash
npm test
npm run check
git status --short
git diff --stat
```

`npm test` uses this unchanged command:

```bash
node --test --experimental-strip-types test/*.test.*
```

The flat glob is a constraint. This work must not add nested test directories or change the test command.

## Required outcome

The implementation is complete only when all of these statements are true:

1. `test/Killeros.test.ts` no longer exists.
2. Every test from the deleted file has one named feature owner.
3. The mixed Question and Goal renderer test becomes two feature-owned tests.
4. No other test assertion or behavior case is deleted.
5. Existing focused files absorb related tests instead of gaining parallel integration files.
6. Shared extension-host setup lives in `test/ExtensionTestHarness.ts`.
7. Shared setup contains no feature fixture, feature expected value, or feature-specific production import.
8. Feature-only helpers stay in the owning test file.
9. Production TypeScript files remain unchanged.
10. `package.json`, `tsconfig.json`, and the test command remain unchanged.
11. No dependency, test framework, snapshot library, barrel file, or custom test loader is added.
12. The final suite passes `npm run check` and `npm test` with the same platform-specific behavior.

## Non-goals

Do not include any of this work in the split:

- Refactoring production modules.
- Rewriting assertions for style.
- Converting top-level `test()` calls to `describe()` blocks.
- Introducing factories for each feature.
- Adding a test file line limit.
- Adding an ESLint `max-lines` rule.
- Adding a repository test that only asserts that `Killeros.test.ts` is absent.
- Changing Node test concurrency to hide shared-state failures.
- Renaming existing production concepts.
- Moving tests into feature directories.
- Adding a changelog entry for a test-only reorganization.

If the move exposes a product defect, stop that destination file's migration and report the defect separately. Do not bury a behavior fix inside this reorganization.

## Ownership rules

Use these rules for every moved test.

### Name the user-facing feature

A test belongs to the feature whose contract appears in the test title and assertions. The production module imported by the test does not decide ownership by itself.

Examples:

- `/handoff leaves the source selected...` belongs in `Handoff.test.ts` even though it creates a full KillerOS extension harness.
- `active goal blocks /init...` belongs in `Init.test.ts` because the asserted behavior is the `/init` precondition.
- `personal instruction truncation...` belongs in `PersonalInstructions.test.ts`, not `Footer.test.ts`, despite its current location beside footer tests.
- `/init reloads only after existing agent-settled hooks complete` belongs in `Init.test.ts`. The test asserts `/init` settlement ordering across the hook boundary.

### Split only on a stable feature boundary

Create another file only when one product feature contains separate areas with different reasons to change. Goal command handling, Goal lifecycle persistence, and Goal rendering meet this test. Arbitrary numbered chunks do not.

Do not create these names:

- `Killeros2.test.ts`
- `Integration.test.ts`
- `Misc.test.ts`
- `Commands2.test.ts`
- `SharedFeatureTests.test.ts`

### Keep helpers with their behavior

A helper stays local when only one feature uses it or when it contains feature-specific data.

A helper moves to `ExtensionTestHarness.ts` only when at least two feature files need the same Pi host behavior. The shared harness may contain a helper used by one file only when `createHarness()` or `createTuiContext()` requires it internally.

### Preserve public seams during the move

Move a test with its current assertion seam. A test that registers the complete extension through `Killeros()` must continue to do so. A direct module test must continue to call the direct module function unless an import conflict requires a mechanical alias.

Do not turn runtime behavior tests into source-text checks. Do not replace direct module tests with full-extension tests merely to make imports uniform.

## Target test layout

The final suite remains flat under `test/`.

### Files that absorb moved tests

| Destination | Existing tests | Moved tests | Final responsibility |
| --- | ---: | ---: | --- |
| `PiExtensionContract.test.ts` | 1 | 1 | Installed-package lifecycle and extension-wide tool schema compatibility. |
| `SlashCommands.test.ts` | 5 | 2 | Slash parsing, autocomplete, `/exit`, and `/clear`. |
| `Handoff.test.ts` | 8 | 14 | Handoff summary generation and `/handoff` command behavior. |
| `InitEvidence.test.ts` | 2 | 3 | Evidence indexing, filtering, UTF-8 bounds, and Git failure behavior. |
| `Activity.test.ts` | 4 | 2 | Request activity state and activity rendering. |

### New feature test files

| Destination | Tests after the split | Final responsibility |
| --- | ---: | --- |
| `CodexFast.test.ts` | 4 | `/codex-fast` registration, validation, reload persistence, and rendering. |
| `Variants.test.ts` | 4 | `/variants` validation, selection, resizing, keybindings, and cancellation. |
| `Question.test.ts` | 32 | Question schema, bounds, single-select, multi-select, input, filtering, transcript, and layout. |
| `Goals.test.ts` | 16 | Goal command registration, action panel, dispatch, continuation, and explicit controls. |
| `GoalLifecycle.test.ts` | 20 | Goal restoration, persisted transitions, blocker audits, failure containment, and tool availability. |
| `GoalUi.test.ts` | 5 | Goal tool rendering, transcript rendering, footer status, and terminal safety. |
| `BoundedText.test.ts` | 1 | Collapsed and expanded bounded text rendering. |
| `Theme.test.ts` | 4 | Theme token values, contrast, and shell use of theme roles. |
| `Init.test.ts` | 24 | `/init` command lifecycle, target writes, policy checks, trust, tool scoping, and settlement ordering. |
| `PersonalInstructions.test.ts` | 4 | Personal instruction exclusion, import containment, links, and UTF-8 truncation. |
| `Hooks.test.ts` | 17 | Hook configuration boundaries, execution, cancellation, timeouts, output, and process cleanup. |
| `Display.test.ts` | 3 | Time, token, path, and context telemetry formatting. |
| `Footer.test.ts` | 9 | Context fallback, cost accounting, Git refresh, width reduction, and model metadata. |
| `Editor.test.ts` | 6 | Editor border, focus, autocomplete placement, text preservation, and existing editor ownership. |
| `ShellUi.test.ts` | 5 | Git branch lookup, startup disposal, header rendering, tips, and suggestions. |

The moved total is 176 because one mixed renderer test becomes two tests. The repository test count becomes 305 if no unrelated tests land before implementation.

The counts are migration checks, not permanent line or test budgets. Future tests belong where their behavior belongs.

## Exact move ledger

Line numbers refer to the verified 5,875-line baseline. Use test titles as the source of truth if the file changes before implementation.

| Current area | Baseline lines | Destination | Notes |
| --- | ---: | --- | --- |
| Tool object schema | 553-566 | `PiExtensionContract.test.ts` | Keep the installed-package test unchanged. Add the schema test beside it. |
| `/codex-fast` | 567-712 | `CodexFast.test.ts` | Keep `resetCodexFastState()` cleanup. |
| Question schema and bounds | 713-764 and 861-912 | `Question.test.ts` | Move with the later Question UI block. |
| `/variants` | 765-860 | `Variants.test.ts` | Keep the keybinding `try` and `finally` restoration. |
| Goal update schema | 913-932 | `Goals.test.ts` | This is the Goal feature's tool contract. |
| Shared and feature helpers | 933-1136 | Shared or owning feature file | Follow the helper allocation below. Do not copy this block wholesale. |
| `BoundedText` | 1137-1147 | `BoundedText.test.ts` | Direct module test. |
| Question starter helper | 1148-1187 | `Question.test.ts` | `startQuestion()` is feature-specific. |
| Theme | 1188-1237 | `Theme.test.ts` | Keep theme JSON parsing local. |
| `/exit` and `/clear` | 1238-1290 | `SlashCommands.test.ts` | These are slash command behaviors. |
| `/handoff` | 1291-2062 | `Handoff.test.ts` | Reuse the existing handoff summary fixtures after the mechanical move passes. |
| Goal command behavior | 2063-2470 | `Goals.test.ts` | Command, action panel, dispatch, continuation, and explicit controls. |
| Goal blocks `/init` | 2471-2481 | `Init.test.ts` | `/init` owns the asserted refusal. |
| Goal restore and update activation | 2482-2606 | `GoalLifecycle.test.ts` | Includes legacy restore and contradictory-state rejection. |
| Question and Goal terminal safety | 2607-2641 | Split between `Question.test.ts` and `GoalUi.test.ts` | This is the only required assertion split. |
| Goal renderer error | 2642-2659 | `GoalUi.test.ts` | Rendering contract. |
| Goal lifecycle and failure handling | 2660-3145 | `GoalLifecycle.test.ts` | Includes blocker streaks, persistence failures, replacement, and cancellation. |
| Goal completion UI | 3146-3248 | `GoalUi.test.ts` | Includes transcript and footer status. |
| `/init` workflow | 3249-3818 | `Init.test.ts` | Includes target write and trust behavior. |
| Init evidence UTF-8 and filtering | 3819-3904 | `InitEvidence.test.ts` | Three direct evidence tests. |
| `/init` tool scoping and middleware | 3905-3962 | `Init.test.ts` | Full extension behavior. |
| Question proposal preview | 3963-3984 | `Question.test.ts` | Question rendering contract. |
| Personal instructions | 3985-4086 | `PersonalInstructions.test.ts` | Keep temporary agent-directory fixtures local. |
| Lifecycle hooks | 4087-4626 | `Hooks.test.ts` | Keep process fakes and hook fixtures local. |
| `/init` waits for hooks | 4627-4658 | `Init.test.ts` | `/init` owns the settlement behavior. |
| Question interaction and rendering | 4659-5173 | `Question.test.ts` | Keep all Question input limits and layouts together. |
| Display formatters | 5174-5228 | `Display.test.ts` | `formatContextProgress()` remains with display behavior. |
| Footer unavailable context | 5229-5243 | `Footer.test.ts` | Footer rendering contract. |
| Personal instruction truncation | 5244-5256 | `PersonalInstructions.test.ts` | This test is misplaced in the current footer block. |
| Footer behavior | 5257-5542 | `Footer.test.ts` | Includes cost and Git status behavior. |
| Editor and autocomplete | 5543-5710 | `Editor.test.ts` | The existing editor factory test belongs here. |
| Activity rendering | 5711-5753 | `Activity.test.ts` | Add to the existing activity suite. |
| Shell startup and header | 5754-5875 | `ShellUi.test.ts` | Includes branch resolution, startup tips, and suggestion decks. |

## Shared harness contract

Create `test/ExtensionTestHarness.ts`. It is a support module, so its name must not match `*.test.*`.

The module owns the simulated Pi extension host. It may import:

- `Killeros` and `KillerosOptions` from `../Killeros.ts`.
- Pi and TUI host types and test-safe utilities.
- `extensionApiTestAdapter` and `themeTestAdapter` from `PiTestAdapters.ts`.
- Node primitives needed by generic test cleanup.

The module must not import a feature implementation such as:

- `killeros/goals.ts`
- `killeros/handoff.ts`
- `killeros/hooks.ts`
- `killeros/init.ts`
- `killeros/init-evidence.ts`
- `killeros/personal-instructions.ts`
- `killeros/question.ts`
- `killeros/footer.ts`
- `killeros/shell-ui.ts`

The root `Killeros()` import is the one allowed production-wide dependency because `createHarness()` tests extension registration.

### Required shared values and functions

Move or expose the smallest typed forms of these existing capabilities:

- `theme`
- `createHarness()`
- `createTuiContext()`
- `emitSequentially()`
- `resultReason()`
- `getCommand()`
- `getTool()`
- `getRenderer()`
- `getHandlers()`
- `requireRenderable()`
- `requireInteractive()`
- `requireEditor()`
- `disposeTestComponent()`
- `requiredFactory()`
- `last()`
- `waitFor()`
- `removeDirectoryEventually()`

Keep the existing assertion behavior. Partial operations such as `Map.get()`, `.at()`, and optional component factories must remain checked at runtime. Do not replace checks with casts or non-null assertions.

Export a shared test type only when a destination file needs to name it. Prefer the inferred return types of exported helpers when TypeScript can carry them without a cast.

Likely shared types include:

- `Harness`
- `TestCommand`
- `TestHandler`
- `TestHandlerResult`
- `TestInteractive`
- `TestNotification`
- `TestRenderable`
- `TestResult`
- `TestTool`
- `TestTui`
- `TestTuiContext`

Do not export the complete current type block by default. Delete types that only described the old monolithic file.

### Shared harness invariants

`createHarness()` must preserve these behaviors:

1. It registers the full KillerOS extension through `extensionApiTestAdapter()`.
2. It records commands, tools, event handlers, entry renderers, sent messages, active tools, and command registration order.
3. It accepts the existing `handoffMaxTokens` option.
4. It injects inert completion notification dependencies so tests do not ring the terminal bell.
5. It returns fresh mutable collections for every call.
6. It adds the registered tool names to `activeTools` after activation, matching the current harness.
7. It validates custom messages through `requireTestSentMessage()` before recording them.
8. It does not retain state across test files.

`createTuiContext()` must preserve these behaviors:

1. It creates fresh captured UI state and a fresh fake TUI.
2. It supports optional branch entries, a theme, and a session manager.
3. It records editor, footer, header, status, title, theme, working indicator, working message, and widget changes.
4. It keeps missing component factories as explicit assertion failures.
5. It does not contain Goal, Init, Question, Handoff, Hook, Footer, or Shell expected values.

`initTheme("dark", false)` must run in the shared harness module before feature tests render Pi components. Each Node test-file worker loads the support module independently.

## Feature-local helper allocation

Move these helpers beside the tests that own their data.

| Helper or type | Destination | Reason |
| --- | --- | --- |
| `readPackageVersion()` and `PACKAGE_VERSION` | `ShellUi.test.ts` | Only shell startup renders the package version. |
| `readThemeFixture()`, `ThemeJson`, `isStringRecord()`, `relativeLuminance()`, `contrastRatio()` | `Theme.test.ts` | These describe the KillerOS theme file. |
| `usage()` and `TestUsage` | `Footer.test.ts` | They construct footer telemetry. |
| `createCompleteHandoffSummary()` | `Handoff.test.ts` | It encodes the handoff document contract. |
| `createGoalState()` | `Handoff.test.ts` | The helper constructs Goal states only for handoff availability tests. |
| `startVariants()` and `VariantsContext` | `Variants.test.ts` | They model the `/variants` selector. |
| `startQuestion()` and `QuestionOption` | `Question.test.ts` | They model Question execution and UI. |
| `validGeneratedGuidance` | `Init.test.ts` | It encodes the accepted `/init` output policy. |
| `emitSuccessfulInitWrite()` | `Init.test.ts` | It drives the hidden `/init` tool. |
| `createFileSymlinkOrSkip()` | `Init.test.ts` | Both current callers test `/init` command or target behavior. The direct evidence tests do not need this helper. |
| `emitGoalStart()` | Each Goal test file that drives Goal turns | Keep a small local copy in `Goals.test.ts`, `GoalLifecycle.test.ts`, and `GoalUi.test.ts` as needed. It encodes Goal semantics and does not belong in the shared host harness. |
| `createEditorTheme()` and `TestEditorTheme` | `Editor.test.ts` | They construct editor-only styles. |
| Hook child-process fakes | `Hooks.test.ts` | They model the hook process contract. |

A small duplicate is better than putting feature policy into the shared harness. Do not create another generic utility file during this work.

## Mixed renderer test split

Replace this test:

```text
question and goal renderers strip terminal controls while preserving line breaks
```

with two tests that preserve the same unsafe input and assertions:

```text
question renderers strip terminal controls while preserving line breaks
goal renderers strip terminal controls while preserving line breaks
```

Put the Question test in `Question.test.ts`. It checks `question.renderCall()` and `question.renderResult()`.

Put the Goal test in `GoalUi.test.ts`. It checks the `killeros-goal` entry renderer and `killeros_goal_update.renderResult()`.

Do not weaken the assertions. Both tests must reject escape bytes, BEL, and the `[2J` terminal command while preserving the original line break.

This split is the only planned assertion rewrite. Perform it after both destination files pass with the original combined test temporarily assigned to one owner.

## State isolation requirements

Splitting one file into many files changes process isolation and parallel execution. Treat failures as evidence of hidden coupling.

### Global state

- Keep `resetCodexFastState()` around Codex fast-mode tests.
- Keep `setKeybindings()` restoration in `finally` blocks for Variants and Question tests.
- Initialize the Pi theme inside the shared harness module.
- Do not rely on a test in another file to register a theme, reset state, or dispose a component.

### Timers and components

- Keep every current `disposeTestComponent()` call.
- Keep hook abort, timeout, and process-tree cleanup assertions unchanged.
- Keep footer fallback timers injectable and explicitly stopped.
- Do not use forced serial execution to make leaked timers pass.

### Filesystem fixtures

- Keep unique `mkdtempSync()` directories.
- Keep all `finally` cleanup blocks.
- Keep symlink skips platform-specific.
- Keep `removeDirectoryEventually()` for Windows cleanup races.
- Do not replace real filesystem boundary tests with mocked paths.

### Harness freshness

Every `createHarness()` and `createTuiContext()` call must return fresh state. Do not cache either result at module scope.

## Implementation plan

### Task 1: Record the migration baseline

**Files:**

- Read: `test/Killeros.test.ts`
- Read: every destination file listed in this specification
- Modify: none

Requirements:

- [ ] Confirm that the worktree contains no unrelated change.
- [ ] Run `npm run check`.
- [ ] Run `npm test`.
- [ ] Record the test count, pass count, skip count, and failure count.
- [ ] Capture the 175 test titles from `test/Killeros.test.ts` for the final coverage comparison.
- [ ] Recalculate the line ranges if the file changed after this specification.

Suggested title inventory:

```bash
rg -n '^test\(' test/Killeros.test.ts
```

Do not start moving tests from a failing baseline.

### Task 2: Extract the extension test harness

**Files:**

- Create: `test/ExtensionTestHarness.ts`
- Modify: `test/Killeros.test.ts`
- Keep: `test/PiTestAdapters.ts`

Requirements:

- [ ] Move the simulated Pi host, generic lookup assertions, generic TUI context, and shared theme into `ExtensionTestHarness.ts`.
- [ ] Keep feature fixtures in `Killeros.test.ts` temporarily.
- [ ] Import the shared harness back into `Killeros.test.ts`.
- [ ] Delete dead local types and imports after TypeScript proves that the shared module covers them.
- [ ] Keep all 175 tests in the original file during this task.
- [ ] Add no cast to `ExtensionTestHarness.ts` except through the existing adapters in `PiTestAdapters.ts`.
- [ ] Do not change `PiTestAdapters.ts` unless moving a type-only import requires a mechanical edit.

Verification:

```bash
npm run check
node --test --experimental-strip-types test/Killeros.test.ts
```

Expected result: all 175 tests pass or retain the same platform skips before any test changes ownership.

### Task 3: Move small independent feature groups

**Files to create:**

- `test/CodexFast.test.ts`
- `test/Variants.test.ts`
- `test/BoundedText.test.ts`
- `test/Theme.test.ts`
- `test/PersonalInstructions.test.ts`
- `test/Display.test.ts`
- `test/Footer.test.ts`
- `test/Editor.test.ts`
- `test/ShellUi.test.ts`

Requirements:

- [ ] Move one complete feature group at a time.
- [ ] Move each feature's production imports and local helpers with its tests.
- [ ] Remove the moved block and now-unused imports from `Killeros.test.ts` in the same edit.
- [ ] Run the destination file immediately.
- [ ] Run `test/Killeros.test.ts` after each move until that file is deleted.
- [ ] Move the personal-instruction truncation test out of the footer block.
- [ ] Keep editor tests that specifically assert slash highlighting in `SlashCommands.test.ts`. Move general editor layout and ownership tests to `Editor.test.ts`.

Example focused command:

```bash
node --test --experimental-strip-types test/CodexFast.test.ts
```

Repeat the command with each destination filename.

### Task 4: Merge tests into existing feature suites

**Files to modify:**

- `test/PiExtensionContract.test.ts`
- `test/SlashCommands.test.ts`
- `test/Handoff.test.ts`
- `test/InitEvidence.test.ts`
- `test/Activity.test.ts`
- `test/Killeros.test.ts`

Requirements:

- [ ] Add the tool schema test to `PiExtensionContract.test.ts` without changing the installed-package lifecycle test.
- [ ] Add `/exit` and `/clear` behavior to `SlashCommands.test.ts`.
- [ ] Add all `/handoff` command tests to `Handoff.test.ts`.
- [ ] Reconcile handoff fixtures only after the moved tests pass unchanged.
- [ ] Add direct Init evidence UTF-8, exclusion, and Git failure tests to `InitEvidence.test.ts`.
- [ ] Keep `/init` snapshot attachment and linked-manifest command tests for `Init.test.ts`.
- [ ] Add activity rendering tests to `Activity.test.ts` without replacing its direct `registerRequestActivity()` tests.
- [ ] Remove each migrated block from `Killeros.test.ts`.

Focused verification:

```bash
node --test --experimental-strip-types test/PiExtensionContract.test.ts
node --test --experimental-strip-types test/SlashCommands.test.ts
node --test --experimental-strip-types test/Handoff.test.ts
node --test --experimental-strip-types test/InitEvidence.test.ts
node --test --experimental-strip-types test/Activity.test.ts
npm run check
```

### Task 5: Move Question, Init, and Hook workflows

**Files to create:**

- `test/Question.test.ts`
- `test/Init.test.ts`
- `test/Hooks.test.ts`

**File to modify:**

- `test/Killeros.test.ts`

Requirements:

- [ ] Move every Question schema, bounds, selection, transcript, input, filter, and rendering test into `Question.test.ts`.
- [ ] Keep `startQuestion()` local to `Question.test.ts`.
- [ ] Move `/init` command, target, trust, tool-scope, middleware, and settlement tests into `Init.test.ts`.
- [ ] Move the active-Goal `/init` refusal test into `Init.test.ts`.
- [ ] Move the `/init` waits-for-hooks test into `Init.test.ts`.
- [ ] Move hook configuration and process behavior into `Hooks.test.ts`.
- [ ] Keep hook process fakes local to `Hooks.test.ts`.
- [ ] Keep the combined Question and Goal renderer safety test temporarily in `Question.test.ts` until `GoalUi.test.ts` exists.

Verification:

```bash
node --test --experimental-strip-types test/Question.test.ts
node --test --experimental-strip-types test/Init.test.ts
node --test --experimental-strip-types test/Hooks.test.ts
npm run check
```

### Task 6: Split the Goal feature by responsibility

**Files to create:**

- `test/Goals.test.ts`
- `test/GoalLifecycle.test.ts`
- `test/GoalUi.test.ts`

**Files to modify:**

- `test/Question.test.ts`
- `test/Killeros.test.ts`

Requirements:

- [ ] Move Goal command registration, panel actions, dispatch, continuation, and explicit controls into `Goals.test.ts`.
- [ ] Move restoration, status-specific fields, blocker audits, persistence failures, cancellation, and replacement into `GoalLifecycle.test.ts`.
- [ ] Move Goal renderer, transcript, completion footer, and active-status footer tests into `GoalUi.test.ts`.
- [ ] Split the mixed renderer safety test exactly as specified.
- [ ] Keep `GoalCompletionVerification.test.ts` unchanged. It owns file-deliverable completion contracts, not command lifecycle.
- [ ] Keep `AutoCompaction.test.ts` and `ContextCompaction.test.ts` unchanged. They own compaction behavior.
- [ ] Do not create a fourth Goal support file. Use the shared extension harness and local helpers.

Verification:

```bash
node --test --experimental-strip-types test/Goals.test.ts
node --test --experimental-strip-types test/GoalLifecycle.test.ts
node --test --experimental-strip-types test/GoalUi.test.ts
node --test --experimental-strip-types test/GoalCompletionVerification.test.ts
node --test --experimental-strip-types test/AutoCompaction.test.ts
node --test --experimental-strip-types test/ContextCompaction.test.ts
npm run check
```

### Task 7: Delete the catch-all and remove migration residue

**Files:**

- Delete: `test/Killeros.test.ts`
- Modify: feature tests only when removing duplicate imports or temporary fixture duplication

Requirements:

- [ ] Confirm that no `test()` call remains in `Killeros.test.ts`.
- [ ] Confirm that every captured baseline title exists in a destination file, except the one mixed title replaced by two named tests.
- [ ] Delete `Killeros.test.ts` rather than leaving an empty compatibility file.
- [ ] Remove unused types, imports, constants, and helpers.
- [ ] Confirm that `ExtensionTestHarness.ts` has no feature fixture or feature-specific module import.
- [ ] Confirm that no destination file imports another `.test.ts` file.
- [ ] Confirm that feature files import support only from `ExtensionTestHarness.ts` and `PiTestAdapters.ts`.
- [ ] Do not add a barrel file for tests.
- [ ] Do not change the package test glob.

Useful audits:

```bash
rg -n 'Killeros\.test\.ts|Integration\.test|Misc\.test|Commands2\.test' test
rg -n '^test\(' test/*.test.ts
rg -n 'from ".*\.test\.ts"' test
rg -n 'from "\.\./killeros/' test/ExtensionTestHarness.ts
```

The final command should find no feature-module imports in `ExtensionTestHarness.ts`.

### Task 8: Run final verification and archive the specification

Requirements:

- [ ] Run every command in the final verification section.
- [ ] Record the exact final test, pass, skip, and failure counts in this document.
- [ ] Review `git diff --stat` and `git diff --check`.
- [ ] Confirm that production TypeScript, package metadata, and dependencies did not change.
- [ ] Change `STATUS: PLANNED` to `STATUS: DONE` only after every gate passes.
- [ ] Move this file to `docs/implemented/2026-08-30-feature-owned-test-suite.md`.

Do not add a `CHANGELOG.md` entry unless implementation changes user-visible behavior. File movement and test helper cleanup alone do not need one.

## Verification strategy

### Focused checks

Run the changed destination file after every move:

```bash
node --test --experimental-strip-types test/<Feature>.test.ts
```

Run `npm run check` after each task. TypeScript is the fastest check for missing shared types, stale imports, and unsafe optional access.

### Coverage preservation check

The migration must preserve all 175 original behavior cases. Compare test titles from the baseline file with final files.

The comparison must account for this one intentional rename:

```text
Removed title:
question and goal renderers strip terminal controls while preserving line breaks

Added titles:
question renderers strip terminal controls while preserving line breaks
goal renderers strip terminal controls while preserving line breaks
```

No other baseline title may disappear without an explicit explanation in the implementation record.

Test titles alone are not enough. Review the diff to confirm that assertions, fixtures, timeouts, and skip conditions moved with each title.

### Final verification

Run in this order:

```bash
git diff --check
npm run check
npm test
git status --short --untracked-files=all
git diff --stat
git diff -- test
git diff -- package.json package-lock.json tsconfig.json Killeros.ts killeros
```

Expected result at the current baseline:

```text
Tests: 305
Passed: 302
Skipped: 3
Failed: 0
TypeScript and ESLint check: passed
Killeros.test.ts: absent
Production changes: none
Package or dependency changes: none
```

The exact pass and skip counts may differ by platform only where the existing filesystem tests already skip. A new skip is a failure unless the implementation documents an existing platform constraint.

## Review checklist

### File ownership

- [ ] Every test file name describes one product feature or one stable Goal subfeature.
- [ ] Existing feature files absorb related tests.
- [ ] No catch-all integration file remains.
- [ ] No numbered chunk file exists.
- [ ] No test directory or package script changed.

### Shared harness

- [ ] `ExtensionTestHarness.ts` models only Pi host behavior.
- [ ] The harness imports no feature implementation module.
- [ ] The harness contains no feature expected value.
- [ ] Every partial lookup performs a runtime assertion.
- [ ] No new cast or non-null assertion bypasses a missing fixture.
- [ ] Every harness call returns fresh state.

### Behavior preservation

- [ ] All 175 original tests moved.
- [ ] The mixed renderer test became two tests.
- [ ] Test timeouts stayed unchanged.
- [ ] Platform skip conditions stayed unchanged.
- [ ] Temporary directories still clean up in `finally` blocks.
- [ ] Components and timers still dispose.
- [ ] Global keybindings and Codex state still reset.
- [ ] Real filesystem and process boundary tests remain real.

### Scope control

- [ ] No production file changed.
- [ ] No dependency changed.
- [ ] No snapshot test was added.
- [ ] No line-count policy was added.
- [ ] No behavior assertion was rewritten except the mixed renderer split.
- [ ] No changelog entry was added for file movement alone.

## Failure policy

Use these rules when a focused test fails after a move:

1. Re-run the original test from the last passing state.
2. Check imports, module initialization, local fixture movement, and cleanup first.
3. Check whether the new test-file process exposed hidden global-state dependence.
4. Fix test ownership or setup at the narrowest shared boundary.
5. Do not serialize the full test suite.
6. Do not add arbitrary delays.
7. Do not weaken the assertion.
8. Revert that feature move if the failure cannot be explained before moving another feature.

A move is not complete merely because the full suite eventually passes. Each destination file must pass independently so that it does not rely on another test file's initialization.

## Completion record

Fill this section during implementation.

```text
Completed: 2026-08-30
Final test files: 28
Final support files: 2
Tests: 305
Passed: 302
Skipped: 3
Failed: 0
npm run check: passed
git diff --check: passed
Production changes: none
Package changes: none
```

## Completion rule

Do not mark this specification done while `Killeros.test.ts` exists, while a baseline test is missing, or while a feature fixture lives in the shared harness. The result must make the correct home for the next test obvious without a line-count rule or another catch-all file.
