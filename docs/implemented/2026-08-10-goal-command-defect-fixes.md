# Goal Command Defect Fixes Implementation Plan

STATUS: DONE

> **For agentic workers:** Steps use checkbox (`- [x]`) syntax for tracking. Implement this plan task-by-task; finish one task before starting the next.

**Final verification (2026-08-10):** `npm test` passed 158 tests with the two existing Windows symlink skips; `npm run check`, `git diff --check`, and `npm pack --dry-run` passed. The evidence-first review found no initial findings. The edge-case run executed five isolated probes, found one impossible turn-zero blocker audit, promoted it to a permanent regression test, removed all scratch files, and verified the repair.

**Goal:** Make every defective `/goal` path stop safely, report persistence failures, preserve the correct objective after failed replacement, and require a durable three-turn streak for one declared blocker before marking a goal blocked.

**Architecture:** Keep goal ownership in `killeros/goals.ts` and durable branch state in `GoalState`; do not add a second scheduler or use private Pi APIs. Save pause or clear state before aborting the associated goal run, then use the public command-context `abort()` and `waitForIdle()` methods. Extend version-1 goal state with an optional blocker-audit record so old sessions remain readable while new sessions can prove a stable blocker key on consecutive turns.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+ test runner, `@earendil-works/pi-coding-agent` 0.82.1 public extension API, TypeBox 1.1.

## Global Constraints

- Modify only goal runtime, goal tests, and goal-facing documentation required by these defects.
- Keep goal session entries at `version: 1`; every new state field must be optional when parsing old entries.
- Use only public Pi APIs. Do not access or mutate Pi's internal message queues.
- `/goal pause` and `/goal clear` must save non-active durable state before aborting, so the resulting `agent_settled` event cannot resume the stopped goal.
- Abort only when KillerOS knows a goal turn is in flight or a goal continuation is scheduled; do not abort unrelated user work solely because `ctx.isIdle()` is false.
- In TUI mode, rely on Pi's standard `ctx.abort()` behavior to restore unrelated queued user messages to the editor.
- In RPC mode, verify that no KillerOS continuation runs after pause or clear.
- A blocked goal requires the same canonical blocker key on three distinct, consecutive goal-turn numbers. The tool may record an attempt only during a KillerOS goal turn. Duplicate calls in one turn do not advance the streak; a different key or skipped turn resets it to one.
- Do not weaken the existing complete-goal evidence requirement, mode gates, saved-session gate, manual-compaction recovery rules, or one-turn-at-a-time continuation gate.
- Add no dependencies and perform no unrelated refactor.
- Do not commit or push changes.

---

## Confirmed Behavior Specification

1. `/goal pause` immediately stops an in-flight or scheduled KillerOS goal run after persisting `paused`; it still clears manual-compaction recovery eligibility.
2. `/goal clear` immediately stops an in-flight or scheduled KillerOS goal run after persisting the clear entry.
3. If stopping the host run cannot be confirmed, the saved goal remains paused or cleared and KillerOS reports the stop failure; it never reactivates the goal.
4. `/goal edit` reports a failed write for active, paused, blocked, and completed goals. It preserves the last durable objective and status.
5. A failed confirmed `/goal <new objective>` replacement pauses the old active goal in memory, even when the pause entry also cannot be written. It does not dispatch either objective.
6. First-time goal creation retains its existing failure behavior: report the failed write and dispatch nothing.
7. A `blocked` goal-tool call must include a stable `blockerKey`. Attempts one and two persist audit progress while the goal stays active; attempt three on the third consecutive goal turn marks it blocked.
8. `complete`, resume, edit, replacement, and a changed or nonconsecutive blocker clear or reset blocker-audit progress as appropriate.

## File Map

- Modify `killeros/runtime.ts`: define the durable optional blocker-audit state carried by `GoalState`.
- Modify `killeros/goals.ts`: parse and persist blocker audits, stop active goal runs, repair edit and replacement failures, and render interim blocker-audit results.
- Modify `test/Killeros.test.ts`: add command, persistence, dispatch, mode, and blocker-streak regression tests; extend the harness with abort and idle controls.
- Modify `test/ContextCompaction.test.ts`: prove pause cancellation does not create manual-compaction recovery and blocker audit survives valid state restoration without changing compaction ownership.
- Modify `README.md`: document immediate pause/clear behavior and the blocker-key streak contract.
- Modify `CHANGELOG.md`: summarize the repaired behavior under `Unreleased`.
- Modify `CONTEXT.md`: add stable product language for immediate goal stopping and blocker streaks if the implementation introduces terms used across code and tests.
- Modify `test/RepositoryContracts.test.ts`: lock the updated README and context wording where repository contract tests already own documentation guarantees.

### Task 1: Durable blocker-audit state and parser compatibility

**Files:**
- Modify: `killeros/runtime.ts:17-42`
- Modify: `killeros/goals.ts:16-100`
- Test: `test/Killeros.test.ts`

**Interfaces:**
- Consumes: existing `GoalState`, `parseGoalState()`, `persistGoalState()`, and `GoalEntryEvent`.
- Produces: `GoalBlockerAudit`, optional `GoalState.blockerAudit`, and the `"blocker-audit"` goal entry event used by Task 2.

- [x] **Step 1: Add parser regression tests for old and new state**

Add tests that restore an old version-1 active state with no audit and a new state with a valid audit. Use observable restoration behavior because `parseGoalState()` is intentionally private:

```ts
const validAuditedState = {
  ...activeState,
  turns: 4,
  blockerAudit: {
    key: "missing-deploy-credential",
    streak: 2,
    lastTurn: 4,
  },
};
const entry = {
  type: "custom",
  customType: "killeros-goal",
  data: { version: 1, event: "turn", state: validAuditedState },
};
const { handlers, sentMessages } = createHarness();
const { ctx } = createTuiContext([entry]);
await emitSequentially(handlers.get("session_start"), { reason: "resume" }, ctx);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(sentMessages.length, 1, "a valid optional audit must not invalidate restoration");
```

Run the same restoration assertion for the old state with `blockerAudit` omitted. Add malformed cases for an empty or noncanonical key, `streak` outside `1..3`, a negative/non-integer `lastTurn`, and `lastTurn > turns`. Each malformed latest goal entry must fail closed and schedule no continuation. Task 2 will prove that the valid audit value itself survives by advancing its streak after restoration.

- [x] **Step 2: Run the focused restoration tests and verify the new-state case fails**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="blocker audit|malformed active recovery markers|restores only the current branch" test/Killeros.test.ts test/ContextCompaction.test.ts
```

Expected: the old-state compatibility test passes; tests requiring `blockerAudit` preservation or validation fail because the field is not parsed.

- [x] **Step 3: Add the durable interface and strict optional parsing**

Add this public runtime shape:

```ts
export interface GoalBlockerAudit {
  key: string;
  streak: number;
  lastTurn: number;
}

export interface GoalState {
  // existing fields remain unchanged
  blockerAudit?: GoalBlockerAudit;
}
```

Accept `blockerAudit` only when:

```ts
const validBlockerAudit = candidate.blockerAudit === undefined || (
  typeof candidate.blockerAudit === "object"
  && candidate.blockerAudit !== null
  && typeof candidate.blockerAudit.key === "string"
  && candidate.blockerAudit.key.length > 0
  && candidate.blockerAudit.key.length <= 120
  && /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(candidate.blockerAudit.key)
  && Number.isInteger(candidate.blockerAudit.streak)
  && candidate.blockerAudit.streak >= 1
  && candidate.blockerAudit.streak <= 3
  && Number.isInteger(candidate.blockerAudit.lastTurn)
  && candidate.blockerAudit.lastTurn >= 0
  && candidate.blockerAudit.lastTurn <= candidate.turns!
);
```

Copy a valid audit into the parsed return value. Add `"blocker-audit"` to `GoalEntryEvent`. Do not increment `GOAL_VERSION`.

- [x] **Step 4: Run focused parser and type checks**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="blocker audit|malformed active recovery markers|restores only the current branch" test/Killeros.test.ts test/ContextCompaction.test.ts
npm run check
```

Expected: all selected tests and TypeScript checks pass.

- [x] **Step 5: Inspect the task diff**

Run:

```bash
git diff -- killeros/runtime.ts killeros/goals.ts test/Killeros.test.ts test/ContextCompaction.test.ts
```

Expected: only the optional state shape, parser/event support, and focused restoration tests changed.

### Task 2: Three-consecutive-turn blocker enforcement

**Files:**
- Modify: `killeros/goals.ts:25-45,395-435`
- Test: `test/Killeros.test.ts:848-899`
- Test: `test/ContextCompaction.test.ts`

**Interfaces:**
- Consumes: `GoalState.blockerAudit` and `"blocker-audit"` from Task 1.
- Produces: optional `blockerKey` in goal-tool parameters, `recordBlockerAttempt()`, `GoalTransitionOptions.blockerAudit`, and interim blocker-audit tool details/rendering.

- [x] **Step 1: Replace the turn-count-only test with streak tests**

Cover all required transitions. Define the test-local wrapper against the registered tool so the examples do not depend on a production helper:

```ts
const recordBlocked = (blockerKey: string | undefined, evidence: string) =>
  tools.get("killeros_goal_update").execute(
    `blocked-${blockerKey ?? "missing"}`,
    { status: "blocked", blockerKey, evidence },
    new AbortController().signal,
    () => {},
    ctx,
  );

await emitGoalStart(handlers, ctx);
await recordBlocked("missing-credential", "turn one evidence");
assert.deepEqual(lastState().blockerAudit, {
  key: "missing-credential",
  streak: 1,
  lastTurn: 1,
});
assert.equal(lastState().status, "active");

await recordBlocked("missing-credential", "duplicate in turn one");
assert.equal(lastState().blockerAudit.streak, 1);

await finishTurnAndStartNext();
await recordBlocked("different-blocker", "turn two changed blocker");
assert.equal(lastState().blockerAudit.streak, 1);

await finishTurnAndStartNext();
await recordBlocked("missing-credential", "new streak starts");
assert.equal(lastState().blockerAudit.streak, 1);
```

Use the existing `emitGoalStart()` plus `agent_end`/`agent_settled` harness events for each `finishTurnAndStartNext()` action shown above. Add a clean three-turn sequence proving statuses `active`, `active`, then `blocked`. Restore the valid two-attempt state from Task 1, start turn 5, submit the same key, and assert it becomes blocked; this proves the audit value survives reload. Add a skipped-turn case proving the streak resets. Add rejection tests for a call outside `runtime.goalTurnInFlight` and for missing, blank, over-120-character, uppercase, whitespace, and other invalid-format keys. Require a canonical key matching:

```regex
^[a-z0-9][a-z0-9._-]{0,119}$
```

- [x] **Step 2: Run blocker tests and verify they fail under count-only enforcement**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="blocker|blocked status" test/Killeros.test.ts test/ContextCompaction.test.ts
```

Expected: failures show that the current tool accepts blocking based only on elapsed turns and stores no streak.

- [x] **Step 3: Implement blocker-attempt recording**

Extend the top-level TypeBox object without introducing a top-level union:

```ts
blockerKey: Type.Optional(Type.String({
  minLength: 1,
  maxLength: 120,
  pattern: "^[a-z0-9][a-z0-9._-]{0,119}$",
  description: "Stable key identifying the repeated blocker",
})),
```

For `status: "complete"`, keep the current evidence flow and clear `blockerAudit` in the terminal state. For `status: "blocked"`, reject the call unless `runtime.goalTurnInFlight` is true, require the already-canonical `blockerKey`, then compute:

```ts
const previous = state.blockerAudit;
const sameTurn = previous?.key === blockerKey && previous.lastTurn === state.turns;
const consecutive = previous?.key === blockerKey && previous.lastTurn === state.turns - 1;
const streak = sameTurn ? previous.streak : consecutive ? previous.streak + 1 : 1;
const blockerAudit = { key: blockerKey, streak, lastTurn: state.turns };
```

If `streak < 3`, persist a revision-incremented active state with event `"blocker-audit"`, return text such as `Blocker audit 2/3 recorded; the goal remains active`, and render `! Blocker audit 2/3`. If `streak === 3`, pass the final audit through `GoalTransitionOptions.blockerAudit` while transitioning to blocked.

Extend transition options explicitly:

```ts
interface GoalTransitionOptions {
  resetBlockedAudit?: boolean;
  resumeAfterManualCompaction?: true;
  blockerAudit?: GoalBlockerAudit;
}
```

When `resetBlockedAudit` is true, clear `blockerAudit`; when `blockerAudit` is supplied, store it; otherwise preserve the current audit. Call complete, resume, and edit transitions with reset behavior. Preserve the audit across ordinary persistence, reload, and a directly consecutive continuation.

Update `goalInstructions()` and the tool description to tell the model to call the blocked update with the same canonical `blockerKey` on each blocked turn; attempts one and two record progress instead of ending the goal.

- [x] **Step 4: Run focused behavior and schema tests**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="blocker|blocked status|provider-compatible object schemas" test/Killeros.test.ts test/ContextCompaction.test.ts
npm run check
```

Expected: blocker tests pass; every tool still exposes a provider-compatible top-level object schema.

- [x] **Step 5: Inspect the task diff**

Run:

```bash
git diff -- killeros/goals.ts test/Killeros.test.ts test/ContextCompaction.test.ts
```

Expected: the diff contains only blocker-key schema, streak state transitions/rendering, resets, and their tests.

### Task 3: Immediate and durable `/goal pause` cancellation

**Files:**
- Modify: `killeros/goals.ts:219-325,567-613,793-824`
- Test: `test/Killeros.test.ts:609-630,745-802`
- Test: `test/ContextCompaction.test.ts:281-360`

**Interfaces:**
- Consumes: public `ExtensionCommandContext.abort()`, `waitForIdle()`, `GoalRuntime.goalTurnInFlight`, and `GoalRuntime.continuationScheduled`.
- Produces: `stopGoalRun(ctx, shouldStop): Promise<void>` or an equivalent focused helper shared with Task 4.

- [x] **Step 1: Add active, scheduled, idle, and failure-path pause tests**

Extend the test context with observable controls:

```ts
let abortCalls = 0;
let idle = false;
ctx.isIdle = () => idle;
ctx.abort = () => { abortCalls += 1; };
ctx.waitForIdle = async () => { idle = true; };
```

Assert these cases:

- an in-flight goal turn persists `paused` before `abort()` runs, calls abort once, waits for idle, and sends no next continuation;
- a scheduled goal continuation is stopped once;
- an already idle active goal is paused without aborting unrelated work;
- a pause persistence failure uses the in-memory paused fallback and still aborts the known goal run;
- settlement after the explicit abort does not set `resumeAfterManualCompaction` and a later manual compaction does not resume it;
- TUI and RPC contexts both end with paused state and no KillerOS continuation.

Record call order explicitly:

```ts
assert.deepEqual(calls, ["persist:paused", "abort", "waitForIdle", "notify"]);
```

- [x] **Step 2: Run pause tests and verify cancellation assertions fail**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal pause|pause stops|explicit.*pause" test/Killeros.test.ts test/ContextCompaction.test.ts
```

Expected: tests fail because the current pause handler never calls `abort()` or `waitForIdle()`.

- [x] **Step 3: Implement state-first cancellation**

Before changing state, capture only known KillerOS activity:

```ts
const shouldStopGoalRun = runtime.goalTurnInFlight || runtime.continuationScheduled;
```

Persist `paused` or install the existing in-memory paused fallback first. Then, only when `shouldStopGoalRun` is true:

```ts
ctx.abort();
await ctx.waitForIdle();
```

Notify success only after settlement. If abort or idle waiting fails, keep the saved paused state, clear KillerOS scheduling flags, and report `Goal paused, but the active goal turn could not be confirmed stopped`. Never mark this explicit abort as eligible for manual-compaction recovery.

Add `ctx.isIdle()` to `scheduleGoalContinuation()`'s gate so KillerOS does not queue a continuation behind unrelated active work; the next `agent_settled` boundary remains responsible for dispatch.

- [x] **Step 4: Run pause, compaction, and continuation tests**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal pause|pause stops|explicit.*pause|manual compaction|continues one turn" test/Killeros.test.ts test/ContextCompaction.test.ts
npm run check
```

Expected: explicit pause stops immediately, manual compaction does not revive it, and normal continuation still runs one settled turn at a time.

- [x] **Step 5: Inspect the task diff**

Run:

```bash
git diff -- killeros/goals.ts test/Killeros.test.ts test/ContextCompaction.test.ts
```

Expected: only pause cancellation, the idle scheduling gate, harness controls, and regression tests changed.

### Task 4: Immediate and durable `/goal clear` cancellation

**Files:**
- Modify: `killeros/goals.ts:542-565`
- Test: `test/Killeros.test.ts:538-575,719-777`

**Interfaces:**
- Consumes: the state-first cancellation helper/sequence from Task 3.
- Produces: clear behavior that removes durable state and settles associated goal execution before success notification.

- [x] **Step 1: Add direct and panel-clear cancellation tests**

For both direct `/goal clear` and confirmed panel clear, assert:

```ts
assert.deepEqual(calls, ["persist:clear", "abort", "waitForIdle", "notify"]);
assert.equal(lastGoalEntry().data.state, null);
assert.equal(sentMessages.length, 1, "cleared goals must not continue");
```

Also cover:

- clearing an idle paused, blocked, or completed goal does not call abort;
- cancelled panel confirmation makes no state or cancellation call;
- if the first clear write fails while active, the existing in-memory/persisted pause fallback is installed before aborting;
- a host abort/wait failure reports that clear was saved but stop was not confirmed, and does not recreate goal state;
- RPC clear leaves no KillerOS continuation.

- [x] **Step 2: Run clear tests and verify active cancellation fails**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal panel confirms clear|goal.*clear|clear stop continuation" test/Killeros.test.ts
```

Expected: active-clear tests fail because the current handler persists `null` without aborting or waiting.

- [x] **Step 3: Apply the shared state-first stop sequence**

Capture `goalTurnInFlight || continuationScheduled`, persist the clear entry, then abort and wait only for known goal execution. Preserve direct-command compatibility and panel-only confirmation. Keep state undefined even if host stopping cannot be confirmed.

On clear persistence failure from an active goal, invoke the existing fail-closed paused fallback and still stop the known goal run. On failure from paused, blocked, or complete state, report the write failure and leave that durable state untouched.

- [x] **Step 4: Run clear, pause, panel, and mode tests**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal panel|goal pause|goal.*clear|saved goals stay inactive" test/Killeros.test.ts test/ContextCompaction.test.ts
npm run check
```

Expected: direct and panel clear stop goal execution without changing confirmation or mode contracts.

- [x] **Step 5: Inspect the task diff**

Run:

```bash
git diff -- killeros/goals.ts test/Killeros.test.ts
```

Expected: clear reuses the cancellation boundary from Task 3 and adds no separate scheduler or queue access.

### Task 5: Visible `/goal edit` persistence failures for every status

**Files:**
- Modify: `killeros/goals.ts:642-708`
- Test: `test/Killeros.test.ts:719-744,974-1000`

**Interfaces:**
- Consumes: existing `pauseGoalAfterFailure()` for active goals and `reportError()` for non-active goals.
- Produces: status-complete edit failure reporting with no state corruption or dispatch.

- [x] **Step 1: Add a table-driven edit failure test**

Run the same write failure against active, paused, blocked, and completed states:

```ts
for (const status of ["active", "paused", "blocked", "complete"] as const) {
  const { api, appendedEntries, commands, ctx, notifications, sentMessages } =
    await harnessWithGoalStatus(status, "Original objective");
  const sentBeforeEdit = sentMessages.length;
  api.appendEntry = () => { throw new Error(`write failed from ${status}`); };
  await commands.get("goal").handler("edit", ctx);
  assert.match(notifications.at(-1).message, new RegExp(`write failed from ${status}`, "u"));
  assert.equal(sentMessages.length, sentBeforeEdit);
  assert.equal(appendedEntries.at(-1).data.state.objective, "Original objective");
}
```

Define `harnessWithGoalStatus()` in the test file using the existing saved-entry fixtures plus `session_start`; do not add a production export. For the active case, query bare `/goal` in RPC mode after the failed append and assert the in-memory fallback is paused. For paused, blocked, and complete cases, query the same status summary and assert the original status remains unchanged. In every case, assert no edited continuation is sent.

- [x] **Step 2: Run the edit failure test and verify non-active cases fail silently**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal edit.*persistence|edit failure" test/Killeros.test.ts
```

Expected: paused, blocked, and complete cases fail because `pauseGoalAfterFailure()` returns before notifying.

- [x] **Step 3: Split active and non-active error handling**

Use the current helper only when the old state is active:

```ts
if (runtime.state?.status === "active") {
  pauseGoalAfterFailure(pi, runtime, ctx, reason, recoveryInstruction);
} else {
  reportError(ctx, "Goal could not be edited", error);
}
```

Do not mutate non-active state after the failed append. Do not schedule a continuation from any persistence-failure branch.

- [x] **Step 4: Run all edit tests and type checks**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal edit|editing a marked paused goal" test/Killeros.test.ts test/ContextCompaction.test.ts
npm run check
```

Expected: valid edits reactivate and dispatch; invalid/cancelled edits preserve prior behavior; every write failure is visible and safe.

- [x] **Step 5: Inspect the task diff**

Run:

```bash
git diff -- killeros/goals.ts test/Killeros.test.ts
```

Expected: only edit failure branching and its table-driven tests changed.

### Task 6: Fail-closed objective replacement

**Files:**
- Modify: `killeros/goals.ts:708-767`
- Test: `test/Killeros.test.ts`

**Interfaces:**
- Consumes: existing unfinished-goal confirmation, `pauseGoalAfterFailure()`, and continuation scheduling gate.
- Produces: replacement failures that pause the old goal and dispatch neither old nor new objective.

- [x] **Step 1: Add replacement-specific persistence tests**

Start an old active goal, begin its turn, invoke replacement while `waitForIdle()` is controlled, settle the old turn while `continuationHeld` is true, then fail the replacement append:

```ts
const replacing = commands.get("goal").handler("New objective", ctx);
await settleOldTurnWhileReplacementWaits();
api.appendEntry = () => { throw new Error("replacement write failed"); };
releaseIdle();
await replacing;

assert.equal(sentMessages.length, 1, "neither objective may restart after failed replacement");
ctx.mode = "rpc";
await commands.get("goal").handler("", ctx);
assert.match(notifications.at(-1).message, /Goal paused/u);
assert.match(notifications.at(-1).message, /Old objective/u);
assert.match(notifications.some(({ message }) => /replacement write failed/u.test(message)), true);
```

Implement `settleOldTurnWhileReplacementWaits()` as a test-local sequence using the existing `agent_end` and `agent_settled` handlers plus a controlled `waitForIdle()` promise. Add a first-time set write failure test proving no goal exists and no message is sent. Add a paused/blocked replacement failure test proving the old non-active state remains and the error is visible.

- [x] **Step 2: Run replacement tests and verify the old objective restarts**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal replacement|Goal could not be started" test/Killeros.test.ts
```

Expected: the active replacement test observes a second message containing the old objective.

- [x] **Step 3: Separate set failure from replacement failure**

In the persistence catch:

- if there was no unfinished goal, report `Goal could not be started` and dispatch nothing;
- if the prior goal is active, call `pauseGoalAfterFailure()` with replacement-specific text and do not call `scheduleGoalContinuation()`;
- if the prior goal is paused or blocked, report `Goal could not be replaced`, preserve it, and dispatch nothing.

The in-memory fallback in `pauseGoalAfterFailure()` must remain effective when the same session-storage outage also prevents writing the pause entry.

- [x] **Step 4: Run set, replacement, dispatch-failure, and continuation tests**

Run:

```bash
node --test --experimental-strip-types --test-name-pattern="goal replacement|Goal could not be started|does not report start|continues one turn" test/Killeros.test.ts
npm run check
```

Expected: first-time set, successful replacement, and provider dispatch behavior remain unchanged; failed replacement stops with the old objective paused.

- [x] **Step 5: Inspect the task diff**

Run:

```bash
git diff -- killeros/goals.ts test/Killeros.test.ts
```

Expected: no continuation is scheduled from a persistence-failure catch.

### Task 7: User-facing contracts and full verification

**Files:**
- Modify: `README.md:49-74,89-103`
- Modify: `CHANGELOG.md:3-6`
- Modify: `CONTEXT.md`
- Modify: `test/RepositoryContracts.test.ts`
- Verify: `killeros/goals.ts`, `killeros/runtime.ts`, `test/Killeros.test.ts`, `test/ContextCompaction.test.ts`

**Interfaces:**
- Consumes: completed behavior from Tasks 1-6.
- Produces: release-facing command semantics and repository contract assertions matching runtime behavior.

- [x] **Step 1: Add documentation contract assertions**

Require README language equivalent to:

```text
/goal pause               Stop the current goal turn and automatic continuation
/goal clear               Stop current goal work and remove the goal
```

Require prose stating that blocked status needs one stable blocker key recorded on three consecutive goal turns, and that failed edit/replacement writes leave the prior durable goal unchanged or safely paused without dispatch.

- [x] **Step 2: Run repository contract tests and verify old wording fails**

Run:

```bash
node --test --experimental-strip-types test/RepositoryContracts.test.ts
```

Expected: new assertions fail until README and shared product language are updated.

- [x] **Step 3: Update README, context language, and changelog**

Under `CHANGELOG.md` → `Unreleased`, add a `Fixed` section covering:

- immediate state-first pause and clear cancellation;
- visible edit/replacement write failures that do not restart stale work;
- durable same-blocker streak enforcement.

Update `README.md` command and goal lifecycle prose. Add concise `CONTEXT.md` definitions only if code/tests use new cross-cutting terms such as **Goal stop boundary** or **Blocker audit streak**; do not duplicate implementation details.

- [x] **Step 4: Run the complete verification matrix**

Run:

```bash
npm test
npm run check
git diff --check
npm pack --dry-run
```

Expected:

- all tests pass; only the repository's already-documented platform-dependent symlink skips may remain;
- TypeScript reports no errors;
- no whitespace errors appear;
- package dry-run includes runtime and documentation files expected by `package.json` and excludes test/spec files from the published package.

- [x] **Step 5: Audit the final diff against every confirmed defect**

Run:

```bash
git status --short
git diff --stat
git diff -- killeros/runtime.ts killeros/goals.ts test/Killeros.test.ts test/ContextCompaction.test.ts test/RepositoryContracts.test.ts README.md CHANGELOG.md CONTEXT.md
```

Expected: every changed line maps to immediate pause/clear cancellation, blocker streaks, visible edit failure, fail-closed replacement, tests, or matching documentation. No dependency, generated, formatting-only, or unrelated files changed.

- [x] **Step 6: Mark the implemented plan complete only after verification**

After all checks pass, add `STATUS: DONE` near the top of this plan and move it from:

```text
docs/spec/2026-08-10-goal-command-defect-fixes.md
```

to:

```text
docs/implemented/2026-08-10-goal-command-defect-fixes.md
```

Expected: no completed plan remains under `docs/spec`, and the implemented copy records the exact final verification commands and results.
