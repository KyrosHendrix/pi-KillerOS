# General Terminal Interaction Redesign Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. Implement this plan task-by-task; finish one task before starting the next.

**STATUS: DONE**

**Verification note:** The execution environment did not expose an interactive PTY. The planned visual smoke checks were covered with the registered TUI component harness across widths 1–180, explicit focus/autocomplete/scroll/settlement cases, a real non-interactive TUI startup, and the RPC load smoke test.

**Goal:** Give every ordinary KillerOS TUI request a lighter frameless prompt, truthful contextual activity, a compact temporary work trail, and one restrained settled line without introducing points, fixed progress percentages, or `/goal`-specific behavior.

**Architecture:** Keep Pi’s native transcript and tool-call rendering authoritative. Add one TUI-only request-activity controller that derives a short work trail and working copy from Pi lifecycle events, renders that trail through the public `setWidget()` API, and clears it after final settlement; keep durable completion in the existing `killeros-worked-for` custom entry with a backward-compatible outcome-aware schema. Simplify `PiCodeEditor.render()` to remove permanent rules while retaining `CustomEditor` behavior, autocomplete, multiline input, cursor handling, and overflow cues.

**Tech Stack:** Strict TypeScript 5.9, Node.js 22.19.0+, Pi coding-agent/TUI public extension APIs 0.82.1+, Node’s built-in test runner.

## Global Constraints

- This plan lives in `docs/spec/` because the repository’s `AGENTS.md` overrides the planning skill’s default `docs/plans/` location.
- Preserve the current user-owned changes in `CHANGELOG.md`, `killeros/variants.ts`, and `test/Killeros.test.ts`; the editor task must merge with the existing test edits instead of replacing them.
- Use only Pi’s public `ExtensionAPI`, `ExtensionContext`, `ExtensionUIContext`, `CustomEditor`, and `@earendil-works/pi-tui` APIs; do not reach into private editor or session internals.
- Keep the redesign TUI-only. RPC, print, and JSON behavior must not gain widgets, custom editor rendering, or settled display entries.
- Keep the existing orange activity glyph sequence `· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·` at 120 ms per frame and the static hidden-thinking label `└ Thinking…`.
- Remove time-randomized activity verbs. Visible working copy must change only because an observed request, message, or tool lifecycle event changed.
- Never claim verification from an inferred stage. A `bash` execution is labeled as a command, not a check, unless a future explicit API supplies verification semantics.
- The work trail is transient UI, not model context and not stored session data. It must use `ctx.ui.setWidget()` rather than `pi.sendMessage()` or `pi.appendEntry()`.
- The work trail contains at most four recent non-adjacent-duplicate phases, uses text markers as well as color, never displays a percentage, and collapses to the active phase at narrow widths.
- The prompt editor has no permanent top or bottom rules. It retains one `❯` anchor, dim while unfocused and coral while focused, with continuation rows aligned under the prompt text.
- Preserve the shuffled session-stable `Try "…"` suggestion, Shift+Enter behavior, slash autocomplete, normal typed-text color, and the rule that KillerOS never replaces another extension’s custom editor factory.
- Keep the existing footer layout and priority rules unchanged, including active `/goal` status. Do not add ordinary-request progress to the footer.
- Keep neutral pending/success/error tool containers and the optional completion bell unchanged.
- The settled line must be proportional: one line only, with an explicit text/icon outcome and elapsed request time; no metrics strip, badges, streaks, points, or celebratory animation.
- Existing version-1 `killeros-worked-for` session entries must continue to render. New persisted entries use a version-2 discriminated outcome schema; no historical entry is rewritten.
- After implementation, add one concise `CHANGELOG.md` entry, update `PRODUCT.md`, `DESIGN.md`, and `README.md`, then mark this plan `STATUS: DONE` and move it to `docs/implemented/`.
- Do not commit or push.

## Approved Behavior Specification

### Frameless prompt editor

Idle and focused input uses this shape:

```text
❯ Try "how does <filepath> work?"
```

- Empty editor: one prompt row, no full-width rules.
- Non-empty multiline editor: `❯ ` prefixes the first content row and two spaces prefix wrapped or explicit continuation rows.
- Focused arrow: `accent`; unfocused arrow: `dim`.
- Suggestion: `dim`, disappears as soon as text exists, and remains fixed for the session.
- Vertical overflow: show compact `↑ N more` or `↓ N more` rows only when the underlying `CustomEditor` reports hidden rows; do not rebuild a decorative rule around them.
- Autocomplete rows returned after the editor’s lower boundary remain intact and keep their existing theme and key behavior.
- Every rendered line must stay within the requested width for widths 1 through 180.

### Contextual activity line

The animated orange glyph remains Pi’s working indicator. KillerOS supplies event-driven copy:

| Observed state | Working message |
|---|---|
| First `agent_start` in a request | `Mapping… (esc to interrupt · understanding request)` |
| `read`, `grep`, `find`, or `ls` execution starts | `Inspecting… (esc to interrupt · reading relevant code)` |
| `edit` or `write` execution starts | `Changing… (esc to interrupt · editing)` |
| `bash` execution starts | `Running… (esc to interrupt · command)` |
| Any other tool execution starts | `Working… (esc to interrupt · using <tool-name>)` |
| Tool execution ends and the request remains active | `Reviewing… (esc to interrupt · reading the result)` |
| Tool execution ends with `isError: true` | `Recovering… (esc to interrupt · tool failed)` |
| The first assistant `message_update` with `assistantMessageEvent.type === "text_start"` occurs | `Responding… (esc to interrupt · assembling the answer)` |

Use coral for the leading verb and dim text for the parenthetical status, with only `esc` bold. Sanitize an unknown tool name to a bounded single-line label before placing it in UI text; if no safe label remains, use `tool`.

### Temporary work trail

The work trail summarizes real categories, not a promised plan:

```ts
type RequestActivityPhase = "prompt" | "inspect" | "change" | "command" | "tool" | "result";
type RequestActivityPhaseStatus = "active" | "done" | "failed";

interface RequestActivityItem {
  phase: RequestActivityPhase;
  status: RequestActivityPhaseStatus;
}
```

```text
Prompt ✓  Inspect ✓  Change ›
```

- Start with `Prompt` when the first `agent_start` begins a new unsettled request.
- Append `Inspect`, `Change`, `Command`, or `Tool` only when a matching tool execution actually starts. Append `Result` only on the first assistant `text_start` stream event.
- Collapse adjacent repeats. Keep the latest four phases; dropping an older phase is presentation-only.
- Mark successfully completed phases with `✓`, a tool phase whose execution ended with `isError: true` with `×`, and the active phase with `›`; never depend on color alone. A later adjacent repeat may reactivate the same phase and replace its prior presentation status because the authoritative error remains in Pi’s tool transcript.
- At widths below 48 columns, render only `› <active phase>`.
- Render above the editor through widget key `killeros-work-trail`.
- Preserve one trail across retries, compaction recovery, queued messages, and automatic `/goal` continuations until `agent_settled` observes both `ctx.isIdle()` and no pending messages.
- Clear the widget at final settlement and on session shutdown. Do not persist it and do not show it outside TUI mode.

### Settled transcript line

New `killeros-worked-for` entries use:

```ts
type WorkedForOutcome = "done" | "stopped" | "failed";

interface WorkedForEntryDataV2 {
  version: 2;
  milliseconds: number;
  outcome: WorkedForOutcome;
}
```

Map the last assistant stop reason observed across the unsettled request as follows:

- `stop` → `done`
- `aborted` → `stopped`
- `error`, `length`, `toolUse`, or no usable final assistant stop reason → `failed`

Render exactly one line:

```text
✓ Done · 18s
■ Stopped · 18s
× Failed · 18s
```

- `done` uses `success`, `stopped` uses `warning`, and `failed` uses `error` for the marker/outcome; duration remains `dim`.
- Preserve the existing one-second minimum and compact mixed-unit formatting.
- Render valid version-1 entries with their existing `✻ Worked for <duration>` text so historical sessions retain their original meaning.
- Append only after final idle settlement, as today. Storage failures remain contained in the current notification path.

### Explicit non-goals

- No literal right-side progress panel in the terminal. Pi’s transcript already owns tool history, and a second panel would duplicate it and fail narrow widths.
- No fixed five-step workflow, numeric progress, ETA, fake verification stage, or inferred percentage.
- No redesign of the startup card, footer structure, tool-call containers, question UI, `/goal` lifecycle, notification setting, or non-TUI modes.
- No prompt disabling, dimming, or locking while work runs.
- No new dependency, user setting, command, public API, or configuration file.

---

## File and Interface Map

| Path | Responsibility after implementation |
|---|---|
| `killeros/activity.ts` | New request-activity state machine, tool-category mapping, contextual working-message formatting, width-aware work-trail component, and TUI lifecycle registration. |
| `killeros/shell-ui.ts` | Startup card and frameless `PiCodeEditor`; retains activity indicator frame configuration and hidden-thinking label, but no longer owns random verb timers. |
| `killeros/worked-for.ts` | Backward-compatible versioned settled-entry parsing, final stop-reason capture, outcome mapping, timing, persistence, and one-line rendering. |
| `Killeros.ts` | Registers the new request-activity controller alongside existing shell UI and settled-entry registration. |
| `test/Activity.test.ts` | Focused unit/lifecycle tests for request activity, trail rendering, width bounds, event-derived messages, settlement cleanup, and non-TUI behavior. |
| `test/Killeros.test.ts` | Existing integration harness plus frameless editor and registration assertions. |
| `test/WorkedFor.test.ts` | Version-2 outcome mapping, rendering, version-1 compatibility, timing, continuation, and failure containment. |
| `PRODUCT.md` | Durable product constraints for the frameless editor, contextual activity, transient trail, and outcome-aware settled line. |
| `DESIGN.md` | Visual/interaction rules replacing the framed editor and shuffled verb deck; adds work-trail and settled-line components. |
| `README.md` | User-visible feature inventory and TUI behavior. |
| `CHANGELOG.md` | Concise Unreleased entry added only with the implementation. |

## Task Plan

### Task 1: Build the request-activity state and rendering contract

**Files:**
- Create: `killeros/activity.ts` — pure state helpers and the width-aware trail component
- Create: `test/Activity.test.ts` — focused behavior tests

**Interfaces:**
- Consumes: Pi `Theme`, `TUI`, lifecycle event tool names, and the public `setWidget()`/`setWorkingMessage()` contracts
- Produces: `registerRequestActivity(pi: ExtensionAPI): void`, `activityPhaseForTool(toolName: string): RequestActivityPhase`, and a bounded work-trail renderer used by later integration

**Verification strategy:** Behavioral tests with a small fake extension harness and deterministic TUI widths.

- [x] Add failing tests in `test/Activity.test.ts` for the exact tool mappings: `read`/`grep`/`find`/`ls` → `inspect`, `edit`/`write` → `change`, `bash` → `command`, and unknown/custom names → `tool`.
- [x] Add failing tests for trail mutation: starts with `prompt`, collapses adjacent duplicates, preserves non-adjacent repeats, and retains only the latest four phases.
- [x] Add failing render tests that strip ANSI and prove wide output contains completed `✓` markers plus one active `›`, narrow output below 48 columns contains only the active phase, state is not conveyed by color alone, and every line fits widths 1 through 180.
- [x] Add failing format tests for every working message in the approved behavior table, including a custom tool name containing control characters or a newline; assert the result is bounded and single-line.
- [x] Implement the smallest typed state model and component needed by those tests. Treat incoming custom tool labels as untrusted strings, normalize whitespace/control characters, truncate with Pi TUI width helpers, and fall back to `tool`.
- [x] Keep the component borderless and dependency-free. Give it `render(width)`, `invalidate()`, and an update path that requests a TUI render without rebuilding the widget.
- [x] Run `node --test --experimental-strip-types test/Activity.test.ts`; expect all activity model and rendering tests to pass.
- [x] Inspect only this task’s diff with `git diff -- killeros/activity.ts test/Activity.test.ts` and remove unused flexibility or duplicate state.

### Task 2: Connect contextual activity to Pi’s real request lifecycle

**Files:**
- Modify: `killeros/activity.ts` — lifecycle registration and final cleanup
- Modify: `killeros/shell-ui.ts` — retain indicator setup, remove random activity word/deck/timer ownership
- Modify: `Killeros.ts` — call `registerRequestActivity(pi)`
- Modify: `test/Activity.test.ts` — lifecycle integration coverage
- Modify: `test/Killeros.test.ts` — shell registration expectations

**Interfaces:**
- Consumes: Task 1’s phase model, `agent_start`, `message_update`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `agent_settled`, and `session_shutdown`
- Produces: one event-driven working message and one transient `killeros-work-trail` widget for each unsettled TUI request

**Verification strategy:** Behavioral lifecycle tests that emit real Pi event shapes through the extension harness.

- [x] Extend the fake TUI context with `setWidget(key, content, options)` capture and a component factory path; do not weaken existing harness assertions.
- [x] Add a failing lifecycle test for an ordinary request that emits `agent_start → read start/end → edit start/end → assistant message_update(text_start) → agent_end → agent_settled`. Assert the working messages change in that causal order, the trail uses `Prompt`, `Inspect`, `Change`, and `Result`, and the widget is registered above the editor with key `killeros-work-trail`.
- [x] Add a failing test proving repeated `agent_start` events before final settlement do not reset timing or the trail, including an intermediate settlement where `ctx.isIdle()` is false or `ctx.hasPendingMessages()` is true.
- [x] Add failing tests for `bash`, a custom tool, an errored tool execution rendered with `×`/`Recovering…`, non-text assistant stream events that must not append `Result`, final widget removal, session-shutdown cleanup, and complete no-op behavior in RPC/print/JSON modes.
- [x] Register request activity separately from `registerShellUi()`. In `Killeros.ts`, call `registerRequestActivity(pi)` after `registerGoalSettlement()` and `registerInitSettlement()` so its `agent_settled` handler observes any continuation those handlers schedule; place it before `registerCompletionNotifications()` and `registerWorkedFor()`. Leave `setWorkingIndicator()` and `setHiddenThinkingLabel()` in `registerShellUi()` because they are stable shell styling rather than request state.
- [x] Delete `ACTIVITY_WORDS`, shuffle-deck state, the 2.5-second word timer, and its cleanup paths from `killeros/shell-ui.ts`. Keep the 120 ms glyph animation unchanged.
- [x] Ensure `agent_end` records no durable UI and does not clear a request that can retry or continue. Clear working copy and the transient widget only at final idle `agent_settled` or `session_shutdown`.
- [x] Run `node --test --experimental-strip-types test/Activity.test.ts test/Killeros.test.ts`; expect the new lifecycle coverage and all existing shell UI tests to pass after their old shuffled-verb assertions are replaced.
- [x] Inspect the bounded diff with `git diff -- Killeros.ts killeros/activity.ts killeros/shell-ui.ts test/Activity.test.ts test/Killeros.test.ts`, paying special attention to the pre-existing `/variants` edits in `test/Killeros.test.ts` and preserving them byte-for-byte outside overlapping harness changes.

### Task 3: Replace the framed prompt with the approved single-arrow editor

**Files:**
- Modify: `killeros/shell-ui.ts` — `PiCodeEditor.render()`, border parsing helpers, and focus-aware prompt prefix
- Modify: `test/Killeros.test.ts` — editor rendering regression tests

**Interfaces:**
- Consumes: Pi `CustomEditor.render()`, `CURSOR_MARKER`, session-stable suggestion text, and the current autocomplete output contract
- Produces: a borderless `PiCodeEditor` whose first content row begins with `❯ ` and whose continuation/overflow/autocomplete rows remain usable

**Verification strategy:** Behavioral editor rendering tests across content states, focus states, key input, autocomplete, and widths 1–180.

- [x] Change the existing editor test’s pre-change assertions so it fails against the current three-row framed editor: empty output must be one prompt row, contain no full-width `─` rule, begin with `❯ Try "`, and fit the requested width.
- [x] Add failing cases for a typed single line, an explicit Shift+Enter multiline value, wrapped long text, focused versus unfocused arrow theme roles, widths 1–3, and scroll overflow. Continuation rows must start with two spaces and compact overflow rows must contain `↑ N more` or `↓ N more` without decorative rule fill.
- [x] Keep the current assertions that typed `/model` stays in normal editor color, the suggestion disappears after input, Shift+Enter inserts a newline, and every rendered line remains within width.
- [x] Add an autocomplete regression using the current captured provider/factory that proves removing the lower rule does not drop, recolor, or misalign completion rows returned after the editor content.
- [x] Refactor `PiCodeEditor.render()` to treat the underlying top and bottom border rows as structural boundaries, omit them from ordinary output, translate only genuine scroll boundaries into compact indicators, and preserve every row after the underlying lower boundary as autocomplete/help output.
- [x] Render the prompt arrow with `accent` only while `this.focused` and `dim` otherwise. Keep typed text untouched and keep the empty suggestion/cursor technique compatible with Pi’s editor cursor.
- [x] Preserve the existing custom-editor ownership guard in `session_start`; add no API for taking over another extension’s editor.
- [x] Run `node --test --experimental-strip-types test/Killeros.test.ts`; expect all editor, autocomplete, shell UI, and unrelated integration tests in that file to pass.
- [x] Inspect the bounded diff with `git diff -- killeros/shell-ui.ts test/Killeros.test.ts` and verify every changed line belongs to editor rendering or the Task 2 activity extraction.

### Task 4: Make the settled line truthful, compact, and backward compatible

**Files:**
- Modify: `killeros/worked-for.ts` — versioned entry union, stop-reason capture, outcome mapping, and renderer
- Modify: `test/WorkedFor.test.ts` — outcome and compatibility tests

**Interfaces:**
- Consumes: final assistant `StopReason`, existing request timing lifecycle, and existing version-1 session entries
- Produces: version-2 `killeros-worked-for` entries with `outcome`, while continuing to render version 1

**Verification strategy:** Behavioral schema/render/lifecycle tests with deterministic time and stop reasons.

- [x] Add failing renderer tests for the exact `done`, `stopped`, and `failed` one-line outputs and semantic theme roles. Assert there is no second row and no `Changed`/`Verified`/`Result` metrics block.
- [x] Add failing validation tests that reject unknown versions, invalid outcomes, negative/non-finite durations, arrays, and partial objects while continuing to accept valid version-1 data.
- [x] Add failing lifecycle tests that extract the last assistant stop reason from `agent_end.messages`, retain it across intermediate continuations, map all five Pi stop reasons exactly as specified, and append one version-2 entry only at final idle settlement.
- [x] Preserve and extend the existing tests for the one-second minimum, mixed units, multiple `agent_start` calls, pending messages, non-TUI modes, session shutdown, and contained append failures.
- [x] Implement a discriminated `WorkedForEntryDataV1 | WorkedForEntryDataV2` parser without unsafe `any`. Keep version-1 rendering unchanged and write only version 2 going forward.
- [x] Reset both timing and captured stop reason after successful append, append failure, or session shutdown so duplicate settlement events cannot create duplicate lines.
- [x] Run `node --test --experimental-strip-types test/WorkedFor.test.ts`; expect all timing, outcome, schema, rendering, and compatibility cases to pass.
- [x] Inspect the bounded diff with `git diff -- killeros/worked-for.ts test/WorkedFor.test.ts` and confirm no historical session migration or unrelated notification behavior was added.

### Task 5: Update the durable product and user documentation

**Files:**
- Modify: `PRODUCT.md` — capabilities and constraints
- Modify: `DESIGN.md` — Prompt Editor, Activity Indicator, new Work Trail, and Settled Line sections
- Modify: `README.md` — feature inventory and TUI behavior
- Modify: `CHANGELOG.md` — Unreleased entry

**Interfaces:**
- Consumes: the implemented behavior from Tasks 1–4
- Produces: documentation that describes the shipped behavior without relying on the ignored browser prototype

**Verification strategy:** Documentation consistency check against implementation constants, entry schema, and tests.

- [x] In `PRODUCT.md`, replace the framed-editor rule with the single-arrow editor behavior, replace shuffled verbs with contextual lifecycle copy, add the transient maximum-four-phase work trail, and describe outcome-aware one-line settlement.
- [x] In `DESIGN.md`, update `Prompt Editor` to ban permanent rules and define focus/continuation/overflow behavior; update `Activity Indicator` with the exact event-copy table; add `Work Trail` and `Settled Line` component contracts; keep the existing startup, tool, footer, question, and goal rules unchanged.
- [x] In `README.md`, replace the framed-editor and rotating-verb bullets with user-facing descriptions of the frameless editor, contextual activity, temporary trail, and one-line outcome. State that these are TUI-only and that the trail is cleared after settlement.
- [x] Under `CHANGELOG.md` → `[Unreleased]`, preserve every existing user entry and add concise `Added`/`Changed` bullets for the implemented work only.
- [x] Search for stale claims with `git grep -n -E 'full-width framed|inside full-width rules|shuffled Claude-adjacent verbs|change every 2\.5 seconds|Worked for' -- PRODUCT.md DESIGN.md README.md CHANGELOG.md killeros test`; expect remaining matches only where historical changelog entries or version-1 compatibility tests intentionally preserve old behavior.
- [x] Inspect the bounded documentation diff with `git diff -- PRODUCT.md DESIGN.md README.md CHANGELOG.md`; confirm it makes no claims beyond the tests and implementation.

### Task 6: Verify the integrated redesign and close the spec

**Files:**
- Verify: `Killeros.ts`
- Verify: `killeros/activity.ts`
- Verify: `killeros/shell-ui.ts`
- Verify: `killeros/worked-for.ts`
- Verify: `test/Activity.test.ts`
- Verify: `test/Killeros.test.ts`
- Verify: `test/WorkedFor.test.ts`
- Modify after all checks pass: `docs/spec/2026-08-12-general-terminal-interaction-redesign.md` → set `STATUS: DONE`, then move to `docs/implemented/2026-08-12-general-terminal-interaction-redesign.md`

**Interfaces:**
- Consumes: all task deliverables and the repository’s release validation commands
- Produces: one verified TUI redesign with no non-TUI regression and a completed implementation record

**Verification strategy:** Full automated suite, package dry run, RPC smoke test, and bounded manual TUI checks.

- [x] Run `npm run check`; expect TypeScript to complete without errors.
- [x] Run `npm test`; expect the entire Node test suite, including new activity and updated editor/settlement coverage, to pass.
- [x] Run `npm pack --dry-run`; expect the existing package file list to remain valid and no design/spec artifact to enter the published package unexpectedly.
- [x] Run `pi -ne -e . --mode rpc`; expect KillerOS to load without attempting TUI widget/editor APIs and to exit without an extension initialization error.
- [x] Run an interactive `pi -ne -e .` TUI smoke check with an ordinary prompt that reads, edits, and runs a command. Verify: the prompt is frameless; the arrow changes between dim and coral focus; working copy follows observed actions; the trail contains no invented phase; tool calls remain authoritative in the transcript; and final settlement adds exactly one compact outcome line.
- [x] Repeat the TUI smoke check at approximately 40, 80, and 120 columns and in a terminal short enough to force editor scrolling. Verify no horizontal overflow, permanent rules, duplicate tool history, clipped active phase, or footer regression.
- [x] Abort one interactive request and verify the settled line says `Stopped`, never `Done`, while the optional completion bell remains silent under its existing rule. Treat the automated `StopReason` mapping tests as the authoritative failure-path evidence instead of forcing a live provider failure.
- [x] Review `git diff --stat` and `git diff -- Killeros.ts killeros/activity.ts killeros/shell-ui.ts killeros/worked-for.ts test/Activity.test.ts test/Killeros.test.ts test/WorkedFor.test.ts PRODUCT.md DESIGN.md README.md CHANGELOG.md docs/spec/2026-08-12-general-terminal-interaction-redesign.md`. Confirm unrelated user changes remain intact and no debug output, dead timer code, stale comments, or speculative settings remain.
- [x] Only after every required check succeeds, change the plan status to `STATUS: DONE` and move it with PowerShell’s `Move-Item -LiteralPath 'docs/spec/2026-08-12-general-terminal-interaction-redesign.md' -Destination 'docs/implemented/2026-08-12-general-terminal-interaction-redesign.md'`. Do not move it while any required behavior or verification remains incomplete.
