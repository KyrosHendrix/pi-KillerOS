# Pi-Owned Compaction and Goal Continuation Implementation Plan

STATUS: DONE

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Implement this plan task-by-task; finish one task before starting the next.

**Goal:** Make Pi the sole owner of compaction while `/goal` remains the durable objective and status owner and continues safely after manual, threshold, or overflow compaction.

**Architecture:** Delete KillerOS’s compaction controller and let Pi choose timing, cut points, summaries, retries, file tracking, manual instructions, and overflow recovery. Goal continuation runs only at Pi’s `agent_settled` boundary; the sole compaction-specific goal state is a revision-bound recovery marker in the existing `/goal` entry, used to resume a manually aborted turn only after branch order proves that Pi saved a later compaction.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi Extension API public lifecycle events, `node:test`, GitHub Actions

**Execution Mode:** Inline execution in the existing worktree. Record the initial state, preserve unrelated changes, inspect each task’s bounded diff, retry a failed task at most twice after diagnosing it, and do not commit, push, publish, or change external data.

## Global Constraints

- `/goal` entries are the only durable source of the objective and status; a Pi summary is a disposable projection, not goal state.
- Pi alone triggers compaction and writes every summary. KillerOS must not call `ctx.compact()`, register `session_before_compact`, return a custom summary, retry summarization, or provide deterministic/model-backed fallbacks.
- Continue active goals only from `agent_settled`, which Pi documents as occurring after retries, compaction, and queued continuation finish.
- A manual abort records `resumeAfterManualCompaction: true` on the exact paused `GoalState` revision. Every other goal transition clears it.
- Live recovery requires `SessionCompactEvent.reason === "manual"`; reload recovery requires the latest `/goal` entry on the active branch to be that marked paused revision and a later `CompactionEntry` on the same branch.
- Manual compaction failure or cancellation emits no `session_compact`, so the goal stays paused. An explicit `/goal pause` while marked clears automatic recovery.
- Threshold failure remains Pi-owned and does not pause a successfully completed goal turn. Unrecovered overflow reaches normal goal error handling and pauses there.
- Preserve the public `contextPercentRemaining(ctx: ExtensionContext): number | null` export as display-only logic.
- Keep peer ranges open-ended from the existing minimum `>=0.82.1`; use public lifecycle contracts without version-specific branches.
- Compatibility checks must cover the locked minimum package set and the latest matched `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` version.
- Do not edit historical `CHANGELOG.md` entries that accurately describe released behavior.
- Preserve the existing user change in `CONTEXT.md` and the ignored ADR at `docs/adr/0001-let-pi-own-compaction.md`.
- The repository ignores `docs/`; do not alter `.gitignore` or stage files. Report the plan and ADR paths so the user can force-add them later if desired.
- Match current style: strict TypeScript, ESM `.ts` imports, named internal exports, `node:test`, and `node:assert/strict`.

---

## Authoritative Design

- `CONTEXT.md`: Goal truth, Compaction projection, Manual compaction recovery, Goal continuation gate, Host compaction recovery, Fail-closed compaction, Pi lifecycle compatibility, and Projection resume rule.
- `docs/adr/0001-let-pi-own-compaction.md`: Pi owns compaction; `/goal` owns objective, status, continuation, and fail-closed manual recovery.
- Pi `SessionCompactEvent`: carries `reason: "manual" | "threshold" | "overflow"` and `willRetry` after a successful compaction.
- Pi `CompactionEntry`: persists summary and branch position but not the compaction reason. Reload can still treat a later compaction after a marked paused goal as manual because paused goals cannot create threshold/overflow work on their own.
- Pi `AgentSettledEvent`: fires only after automatic retry, compaction, overflow retry, and queued messages are exhausted.

## Current Baseline

- `npm run check`: PASS on 2026-08-09.
- `npm test`: PASS, 141 tests total, 139 passed and 2 environment-dependent symlink tests skipped.
- Existing unrelated state: `CONTEXT.md` is modified; `docs/adr/0001-let-pi-own-compaction.md` exists but is ignored by `.gitignore`.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `Killeros.ts` | Modify | Stop creating/registering compaction runtime; preserve the display helper export |
| `killeros/context-compaction.ts` | Delete | Remove threshold polling, custom summaries, fallbacks, timers, and recovery mirrors |
| `killeros/footer.ts` | Modify | Own the preserved `contextPercentRemaining()` display helper |
| `killeros/runtime.ts` | Modify | Remove `CompactionRuntime` and compaction hold fields; add the optional goal recovery marker |
| `killeros/goals.ts` | Modify | Continue at `agent_settled`, strengthen the prompt, persist/recover manual abort state |
| `test/ContextCompaction.test.ts` | Rewrite | Verify host ownership, lifecycle ordering, manual recovery, reload proof, and public API stability |
| `test/Killeros.test.ts` | Modify | Verify prompt wording and explicit `/goal pause` recovery cancellation |
| `test/RepositoryContracts.test.ts` | Modify | Lock current documentation and minimum/latest compatibility policy |
| `.github/workflows/ci.yml` | Modify | Test latest matched Pi packages in addition to the locked minimum |
| `README.md` | Modify | Describe Pi-owned compaction and honest manual pause/resume behavior |
| `docs/implemented/context-compaction.md` | Rewrite | Replace obsolete implementation instructions with a short superseded notice |
| `docs/spec/2026-08-09-pi-owned-compaction-goal-continuation.md` | Move after verification | Mark `STATUS: DONE` and move to `docs/implemented/` when execution completes |

---

### Task 1: Remove KillerOS Compaction Ownership

**Files:**
- Modify: `Killeros.ts:1-46`
- Delete: `killeros/context-compaction.ts:1-613`
- Modify: `killeros/footer.ts:1-24`
- Modify: `killeros/runtime.ts:13-86`
- Modify: `killeros/goals.ts:1-10, 255-281, 358-412, 719-774`
- Rewrite: `test/ContextCompaction.test.ts`
- Modify: `test/Killeros.test.ts:367-441`

**Interfaces:**
- Consumes: Pi’s existing `agent_settled`, `session_compact`, and automatic compaction lifecycle.
- Produces: `contextPercentRemaining(ctx: ExtensionContext): number | null` from `killeros/footer.ts`; `registerGoalSettlement(pi: ExtensionAPI, runtime: GoalRuntime, initState: InitRuntime): void` without compaction runtime state.

- [ ] **Step 1: Record and protect the initial worktree**

Run:

```bash
git status --short --untracked-files=all
git diff -- CONTEXT.md
git check-ignore -v docs/adr/0001-let-pi-own-compaction.md
```

Expected:

```text
 M CONTEXT.md
.gitignore:2:docs/ docs/adr/0001-let-pi-own-compaction.md
```

Do not edit or revert either artifact during source tasks.

- [ ] **Step 2: Replace old compaction tests with failing ownership and lifecycle tests**

Keep the existing `createHarness`, `createContext`, and `emitSequentially` helpers in `test/ContextCompaction.test.ts`. Remove model-summary fixtures and all tests for thresholds, custom summary sections, fallback summaries, guards, timers, and `ctx.compact()` calls. Add these tests:

```typescript
test("KillerOS leaves compaction triggering and summary generation to Pi", async () => {
  const { handlers } = createHarness();
  const { compactCalls, ctx } = createContext({
    usage: { tokens: 100_000, contextWindow: 128_000 },
  });
  assert.equal(handlers.has("session_before_compact"), false);
  await emitSequentially(handlers.get("turn_end"), {
    type: "turn_end", turnIndex: 0, message: {}, toolResults: [],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(compactCalls.length, 0);
});

test("contextPercentRemaining remains a public display helper", async () => {
  const { contextPercentRemaining } = await import("../Killeros.ts");
  const makeContext = (tokens: number | null, contextWindow = 128_000) => ({
    getContextUsage: () => ({ tokens, contextWindow }),
  });

  assert.equal(contextPercentRemaining(makeContext(89_600)), 30);
  assert.equal(contextPercentRemaining(makeContext(64_000)), 50);
  assert.equal(contextPercentRemaining(makeContext(200_000)), 0);
  assert.equal(contextPercentRemaining(makeContext(-1)), 100);
  assert.equal(contextPercentRemaining(makeContext(null)), null);
  assert.equal(contextPercentRemaining(makeContext(1, 0)), null);
  assert.equal(contextPercentRemaining({ getContextUsage: () => undefined }), null);
  assert.equal(contextPercentRemaining({ getContextUsage: () => { throw new Error("unavailable"); } }), null);
});

test("threshold compaction continues a goal only at Pi's settled boundary", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createContext();
  await commands.get("goal").handler("Finish the migration", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);

  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact", compactionEntry: {}, fromExtension: false,
    reason: "threshold", willRetry: false,
  }, ctx);
  assert.equal(sentMessages.length, 1, "session_compact is not the continuation gate");

  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(sentMessages.length, 2);
});

test("overflow retry produces one continuation after the final settled result", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createContext();
  await commands.get("goal").handler("Repair the overflowed task", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "context overflow" }],
  }, ctx);
  await emitSequentially(handlers.get("session_compact"), {
    type: "session_compact", compactionEntry: {}, fromExtension: false,
    reason: "overflow", willRetry: true,
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);
  assert.equal(sentMessages.length, 1);

  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(sentMessages.length, 2);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(sentMessages.length, 2, "duplicate settled events must not duplicate continuation");
});

test("threshold compaction failure remains Pi-owned and continues at settled", async () => {
  const { commands, handlers, sentMessages } = createHarness();
  const { ctx } = createContext();
  await commands.get("goal").handler("Continue after Pi retries compaction", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }],
  }, ctx);

  // Failed threshold compaction emits no session_compact extension event.
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  assert.equal(sentMessages.length, 2);
});

test("an unrecovered overflow pauses through normal goal error handling", async () => {
  const { appendedEntries, commands, handlers, sentMessages } = createHarness();
  const { ctx } = createContext();
  await commands.get("goal").handler("Repair the overflowed task", ctx);
  await emitSequentially(handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await emitSequentially(handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "overflow recovery failed" }],
  }, ctx);
  await emitSequentially(handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  assert.equal(appendedEntries.at(-1).data.state.status, "paused");
  assert.match(appendedEntries.at(-1).data.state.result, /overflow recovery failed/u);
  assert.equal(sentMessages.length, 1);
});
```

In `test/Killeros.test.ts`, strengthen the existing goal prompt test with:

```typescript
assert.match(sentMessages[0].message.content, /exact objective from \/goal/u);
assert.match(sentMessages[0].message.content, /first concrete next step/u);
assert.match(sentMessages[0].message.content, /check(?:ing)? (?:the )?current repository state/u);
assert.doesNotMatch(sentMessages[0].message.content, /hidden handoff|stored progress copy/u);
```

- [ ] **Step 3: Run the focused test to prove the old design fails the new contract**

Run:

```bash
node --test --experimental-strip-types test/ContextCompaction.test.ts
```

Expected: FAIL because KillerOS still registers `session_before_compact` and calls `ctx.compact()` at low context; prompt assertions also fail when run through `test/Killeros.test.ts`.

- [ ] **Step 4: Move the public percentage helper to display ownership**

Add this next to `formatContextProgress` in `killeros/footer.ts`:

```typescript
export function contextPercentRemaining(ctx: ExtensionContext): number | null {
  let usage: ReturnType<ExtensionContext["getContextUsage"]>;
  try {
    usage = ctx.getContextUsage();
  } catch {
    return null;
  }
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  if (usage.tokens === null || !Number.isFinite(usage.tokens)) return null;

  const percentRemaining = ((usage.contextWindow - Math.max(0, usage.tokens)) / usage.contextWindow) * 100;
  return Math.round(Math.max(0, Math.min(100, percentRemaining)));
}
```

Update `Killeros.ts` to export it from `footer.ts`:

```typescript
export { contextPercentRemaining, formatCost, formatContextProgress } from "./killeros/footer.ts";
```

- [ ] **Step 5: Delete duplicate compaction ownership and simplify goal settlement**

In `Killeros.ts`:

- Remove imports and calls for `registerContextCompaction` and `createCompactionRuntime`.
- Remove `const compactionRuntime = createCompactionRuntime()`.
- Call `registerGoalSettlement(pi, goalRuntime, initRuntime)` with three arguments.

Delete `killeros/context-compaction.ts` entirely.

In `killeros/runtime.ts`, delete `CompactionRuntime`, `createCompactionRuntime()`, `GoalRuntime.continuationHeldForCompaction`, and its initializer. Keep `continuationHeld`; `/goal edit` still uses it while waiting for idle.

In `killeros/goals.ts`:

- Remove the `CompactionRuntime` type import.
- Remove all resets of `continuationHeldForCompaction`.
- Change `registerGoalSettlement` to three required parameters.
- Delete its compaction-in-flight hold and old `session_compact` release handler.
- Keep one `agent_settled` handler that processes the final goal result and schedules exactly one continuation.

The resulting settlement signature and success tail must be:

```typescript
export function registerGoalSettlement(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
): void {
  pi.on("agent_settled", (_event, ctx) => {
    const wasGoalTurn = runtime.goalTurnInFlight;
    const continuationWasScheduled = runtime.continuationScheduled;
    const agentEndObserved = runtime.agentEndObserved;
    runtime.goalTurnInFlight = false;
    runtime.agentEndObserved = false;
    runtime.continuationScheduled = false;
    if (!wasGoalTurn || runtime.state?.status !== "active" || initState.active) {
      if (continuationWasScheduled && runtime.state?.status === "active" && !initState.active) {
        pauseGoalAfterFailure(pi, runtime, ctx, "the goal continuation ended before an agent turn started");
      }
      return;
    }
    if (!agentEndObserved) {
      pauseGoalAfterFailure(pi, runtime, ctx, "the goal turn ended without an agent result");
      return;
    }
    if (runtime.lastStopReason === "error" || runtime.lastStopReason === "aborted") {
      const reason = runtime.lastError
        || (runtime.lastStopReason === "aborted" ? "the agent turn was aborted" : "the agent turn failed");
      runtime.lastStopReason = undefined;
      runtime.lastError = undefined;
      pauseGoalAfterFailure(pi, runtime, ctx, reason);
      return;
    }
    runtime.lastStopReason = undefined;
    runtime.lastError = undefined;
    scheduleGoalContinuation(pi, runtime, initState, ctx);
  });
}
```

- [ ] **Step 6: Strengthen the existing goal prompt without adding a second message**

Add these lines inside `goalInstructions()` after the objective:

```typescript
"Treat the exact objective above from /goal as authoritative; a compaction summary may describe it but does not replace it.",
"If the current context contains a compaction summary, take its first concrete next step after checking the current repository state.",
```

Keep using the existing hidden `killeros-goal-continuation` message. Do not create a compaction handoff message or progress ledger.

- [ ] **Step 7: Run focused checks and inspect the bounded diff**

Run:

```bash
node --test --experimental-strip-types test/ContextCompaction.test.ts test/Killeros.test.ts
npm run check
git diff -- Killeros.ts killeros/context-compaction.ts killeros/footer.ts killeros/runtime.ts killeros/goals.ts test/ContextCompaction.test.ts test/Killeros.test.ts
```

Expected: PASS. The diff contains deletion of compaction control code, the preserved display helper, simplified settlement, stronger prompt copy, and replacement lifecycle tests only.

---

### Task 2: Add Live Manual-Compaction Recovery

**Files:**
- Modify: `killeros/runtime.ts:13-41`
- Modify: `killeros/goals.ts:13-177, 480-539, 719-end`
- Modify: `test/ContextCompaction.test.ts`
- Modify: `test/Killeros.test.ts:510-555, 770-820`

**Interfaces:**
- Consumes: `SessionCompactEvent.reason`, the final `agent_end` stop reason, existing `/goal` persistence, and `scheduleGoalContinuation()`.
- Produces: `GoalState.resumeAfterManualCompaction?: true`; all normal transitions clear the marker; successful live manual compaction resumes the same marked paused revision.

- [ ] **Step 1: Add failing live recovery tests**

Append to `test/ContextCompaction.test.ts`:

```typescript
async function abortActiveGoal(harness: ReturnType<typeof createHarness>, ctx: ReturnType<typeof createContext>["ctx"]): Promise<void> {
  await harness.commands.get("goal").handler("Continue after manual compaction", ctx);
  await emitSequentially(harness.handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
}

test("manual compaction resumes only the exact recovery-eligible paused goal", async () => {
  const harness = createHarness();
  const notifications: Array<{ message: string; level: string }> = [];
  const { ctx } = createContext({ notifications });
  await abortActiveGoal(harness, ctx);

  const paused = harness.appendedEntries.at(-1).data.state;
  assert.equal(paused.status, "paused");
  assert.equal(paused.resumeAfterManualCompaction, true);
  assert.match(notifications.at(-1)?.message ?? "", /paused.*compaction|compaction.*paused/iu);

  await emitSequentially(harness.handlers.get("session_compact"), {
    type: "session_compact", compactionEntry: {}, fromExtension: false,
    reason: "manual", willRetry: false,
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  const resumed = harness.appendedEntries.at(-1).data.state;
  assert.equal(resumed.status, "active");
  assert.equal(resumed.resumeAfterManualCompaction, undefined);
  assert.equal(harness.sentMessages.length, 2);
  assert.match(notifications.at(-1)?.message ?? "", /compaction.*goal resumed/iu);
});

test("failed or cancelled manual compaction leaves the marked goal paused", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);

  // Pi emits no session_compact event on failure or cancellation.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused");
  assert.equal(harness.sentMessages.length, 1);
});

test("threshold and overflow compaction never consume manual recovery eligibility", async () => {
  for (const reason of ["threshold", "overflow"] as const) {
    const harness = createHarness();
    const { ctx } = createContext();
    await abortActiveGoal(harness, ctx);
    await emitSequentially(harness.handlers.get("session_compact"), {
      type: "session_compact", compactionEntry: {}, fromExtension: false,
      reason, willRetry: reason === "overflow",
    }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused", reason);
    assert.equal(harness.sentMessages.length, 1, reason);
  }
});

test("explicit /goal pause clears pending manual recovery", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  await harness.commands.get("goal").handler("pause", ctx);

  const explicitPause = harness.appendedEntries.at(-1).data.state;
  assert.equal(explicitPause.status, "paused");
  assert.equal(explicitPause.resumeAfterManualCompaction, undefined);

  await emitSequentially(harness.handlers.get("session_compact"), {
    type: "session_compact", compactionEntry: {}, fromExtension: false,
    reason: "manual", willRetry: false,
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 1);
});

test("editing a marked paused goal clears recovery before reactivation", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await abortActiveGoal(harness, ctx);
  ctx.ui.editor = async () => "Edited objective";
  await harness.commands.get("goal").handler("edit", ctx);

  const edited = harness.appendedEntries.at(-1).data.state;
  assert.equal(edited.objective, "Edited objective");
  assert.equal(edited.status, "active");
  assert.equal(edited.resumeAfterManualCompaction, undefined);
});

test("a terminal goal update cannot be revived by manual compaction", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await harness.commands.get("goal").handler("Complete before compaction", ctx);
  await emitSequentially(harness.handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await harness.tools.get("killeros_goal_update").execute(
    "complete-before-compaction",
    { status: "complete", evidence: "verified before the manual abort" },
    new AbortController().signal,
    () => {},
    ctx,
  );
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);
  await emitSequentially(harness.handlers.get("session_compact"), {
    type: "session_compact", compactionEntry: {}, fromExtension: false,
    reason: "manual", willRetry: false,
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "complete");
  assert.equal(harness.sentMessages.length, 1);
});

test("a provider error pauses without compaction recovery eligibility", async () => {
  const harness = createHarness();
  const { ctx } = createContext();
  await harness.commands.get("goal").handler("Fail closed", ctx);
  await emitSequentially(harness.handlers.get("before_agent_start"), {
    type: "before_agent_start", prompt: "", systemPrompt: "base", systemPromptOptions: {},
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_end"), {
    type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider unavailable" }],
  }, ctx);
  await emitSequentially(harness.handlers.get("agent_settled"), { type: "agent_settled" }, ctx);

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "paused");
  assert.equal(harness.appendedEntries.at(-1).data.state.resumeAfterManualCompaction, undefined);
});
```

- [ ] **Step 2: Run the focused test to prove recovery is missing**

Run:

```bash
node --test --experimental-strip-types test/ContextCompaction.test.ts
```

Expected: FAIL because aborted goals have no recovery marker and successful manual compaction does not resume them.

- [ ] **Step 3: Add the optional marker and validate it without changing the goal entry version**

Add to `GoalState` in `killeros/runtime.ts`:

```typescript
resumeAfterManualCompaction?: true;
```

Keep `version: 1`; the optional field is backward-compatible. In `parseGoalState()` reject values other than `true` or `undefined`, and reject the marker on any status except `paused`, then preserve it:

```typescript
|| candidate.resumeAfterManualCompaction !== undefined
  && candidate.resumeAfterManualCompaction !== true
|| candidate.resumeAfterManualCompaction === true
  && candidate.status !== "paused"
```

```typescript
resumeAfterManualCompaction: candidate.resumeAfterManualCompaction,
```

- [ ] **Step 4: Make transition clearing the default**

Replace the boolean tail parameter on `transitionGoal()` with:

```typescript
interface GoalTransitionOptions {
  resetBlockedAudit?: boolean;
  resumeAfterManualCompaction?: true;
}
```

Build every next state with:

```typescript
blockedAuditStartTurn: options.resetBlockedAudit ? stopped.turns : stopped.blockedAuditStartTurn,
result,
resumeAfterManualCompaction: options.resumeAfterManualCompaction,
```

Update the explicit resume caller from `true` to `{ resetBlockedAudit: true }`. Also set `resumeAfterManualCompaction: undefined` in the direct active-state construction used by `/goal edit`, and in the in-memory fallback inside `pauseGoalAfterFailure()`. New goal creation already omits the field; completion, block, pause, resume, and error transitions clear it through `transitionGoal()`. The parser’s paused-only invariant prevents a marked active checkpoint or turn from being restored.

- [ ] **Step 5: Persist an honest abort pause and distinguish errors**

Add a focused helper in `killeros/goals.ts`:

```typescript
function pauseGoalForPossibleManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  ctx: ExtensionContext,
  reason: string,
): void {
  if (runtime.state?.status !== "active") return;
  try {
    transitionGoal(pi, runtime, "error", "paused", reason, {
      resumeAfterManualCompaction: true,
    });
  } catch {
    runtime.state = runtime.state ? {
      ...stopGoalClock(runtime.state, Date.now()),
      status: "paused",
      result: reason,
      resumeAfterManualCompaction: true,
    } : undefined;
    runtime.persistenceRetryNeeded = true;
    runtime.continuationScheduled = false;
    runtime.requestRender?.();
  }
  ctx.ui.notify(
    "Goal paused because the turn was aborted. If /compact is running, KillerOS will resume after Pi saves the summary. Run /goal pause to keep it paused.",
    "warning",
  );
}
```

In `registerGoalSettlement()`, route only `lastStopReason === "aborted"` through this helper. Keep provider and overflow errors on `pauseGoalAfterFailure()` with no marker.

- [ ] **Step 6: Make explicit pause cancel recovery immediately**

In the already-paused `/goal pause` branch, treat either `persistenceRetryNeeded` or `resumeAfterManualCompaction === true` as a reason to write a new pause checkpoint. Build it with a new revision and `resumeAfterManualCompaction: undefined`.

On success notify:

```text
Goal remains paused. Automatic compaction recovery is off.
```

If persistence fails, keep the marker cleared in memory, set `persistenceRetryNeeded = true`, and report that the explicit pause could not be saved. This preserves current-process stop intent even when durable storage is unavailable.

- [ ] **Step 7: Resume marked state only from successful live manual compaction**

Register this inside `registerGoalSettlement()` after its `agent_settled` hook:

```typescript
pi.on("session_compact", (event, ctx) => {
  if (event.reason !== "manual"
    || runtime.state?.status !== "paused"
    || runtime.state.resumeAfterManualCompaction !== true
    || initState.active) return;

  try {
    transitionGoal(pi, runtime, "resume", "active", undefined, {
      resetBlockedAudit: true,
    });
  } catch (error) {
    reportError(ctx, "Manual compaction succeeded, but the goal could not be resumed", error);
    return;
  }

  runtime.continuationScheduled = false;
  ctx.ui.notify("Manual compaction complete. Goal resumed.", "info");
  setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
});
```

The `setImmediate` keeps continuation outside Pi’s still-finishing `session_compact` callback.

- [ ] **Step 8: Run focused checks and inspect the task diff**

Run:

```bash
node --test --experimental-strip-types test/ContextCompaction.test.ts test/Killeros.test.ts
npm run check
git diff -- killeros/runtime.ts killeros/goals.ts test/ContextCompaction.test.ts test/Killeros.test.ts
```

Expected: PASS. Manual success resumes once, absent success remains paused, threshold/overflow cannot consume the marker, provider errors have no marker, and explicit pause wins.

---

### Task 3: Recover Safely Across Crash, Reload, and Branch Navigation

**Files:**
- Modify: `killeros/goals.ts:82-106, 350-390`
- Modify: `test/ContextCompaction.test.ts`

**Interfaces:**
- Consumes: active-branch ordering from `ctx.sessionManager.getBranch()` and persisted `GoalState.resumeAfterManualCompaction`.
- Produces: internal `RestoredGoalState { state?: GoalState; recoveryProven: boolean }`; reload/tree recovery only when the latest goal entry is the marked paused revision and a later branch compaction proves success.

- [ ] **Step 1: Add failing branch-proof and failure-recovery tests**

Add a fixture:

```typescript
function savedGoalState(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    version: 1,
    revision: 4,
    objective: "Resume the exact saved goal",
    status: "paused",
    createdAt: now - 60_000,
    updatedAt: now - 1_000,
    activeMilliseconds: 20_000,
    turns: 2,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    resumeAfterManualCompaction: true,
    ...overrides,
  };
}

function goalEntry(state: ReturnType<typeof savedGoalState>, event = "error") {
  return {
    type: "custom", id: `goal-${state.revision}`, parentId: null, timestamp: new Date().toISOString(),
    customType: "killeros-goal", data: { version: 1, event, state },
  };
}

function compactionEntry(id = "compact-1") {
  return {
    type: "compaction", id, parentId: null, timestamp: new Date().toISOString(),
    summary: "Continue with the first unfinished verification step.",
    firstKeptEntryId: "message-1", tokensBefore: 80_000,
  };
}
```

Add tests:

```typescript
test("reload finishes recovery when active-branch order proves compaction success", async () => {
  const entries = [goalEntry(savedGoalState()), compactionEntry()];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.appendedEntries.at(-1).data.state.status, "active");
  assert.equal(harness.appendedEntries.at(-1).data.state.revision, 5);
  assert.equal(harness.sentMessages.length, 1);
});

test("reload does not recover when compaction precedes the marked pause", async () => {
  const entries = [compactionEntry(), goalEntry(savedGoalState())];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
});

test("a later goal transition invalidates an older recovery marker", async () => {
  const marked = savedGoalState();
  const explicitPause = savedGoalState({ revision: 5, resumeAfterManualCompaction: undefined });
  const entries = [goalEntry(marked), compactionEntry(), goalEntry(explicitPause, "pause")];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
});

test("malformed active recovery markers fail closed", async () => {
  const invalid = savedGoalState({
    status: "active",
    activeStartedAt: Date.now(),
    resumeAfterManualCompaction: true,
  });
  const harness = createHarness();
  const { ctx } = createContext({ entries: [goalEntry(invalid), compactionEntry()] });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "resume" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.appendedEntries.length, 0);
});

test("tree navigation evaluates only the destination branch", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const harness = createHarness();
  const { ctx } = createContext({ entries });
  await emitSequentially(harness.handlers.get("session_start"), { type: "session_start", reason: "startup" }, ctx);

  entries.push(goalEntry(savedGoalState()), compactionEntry());
  await emitSequentially(harness.handlers.get("session_tree"), {
    type: "session_tree", oldLeafId: null, newLeafId: "compact-1",
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 1);
});

test("recovery persistence failure stays paused and queues nothing", async () => {
  const harness = createHarness();
  const notifications: Array<{ message: string; level: string }> = [];
  const { ctx } = createContext({ notifications });
  await abortActiveGoal(harness, ctx);
  harness.api.appendEntry = () => { throw new Error("session storage unavailable"); };

  await emitSequentially(harness.handlers.get("session_compact"), {
    type: "session_compact", compactionEntry: {}, fromExtension: false,
    reason: "manual", willRetry: false,
  }, ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.sentMessages.length, 1);
  assert.match(notifications.at(-1)?.message ?? "", /could not be resumed/u);
});
```

- [ ] **Step 2: Run the focused test to prove reload recovery is missing**

Run:

```bash
node --test --experimental-strip-types test/ContextCompaction.test.ts
```

Expected: FAIL because `restoreGoalState()` returns only the paused state and does not inspect later compaction entries.

- [ ] **Step 3: Return state plus durable recovery proof from branch restoration**

Add:

```typescript
interface RestoredGoalState {
  state?: GoalState;
  recoveryProven: boolean;
}
```

Change `restoreGoalState()` to return this shape. After finding and parsing the latest valid `/goal` entry at index `index`, compute:

```typescript
const state = restored.status === "active"
  ? { ...restored, activeStartedAt: Date.now() }
  : { ...restored, activeStartedAt: undefined };
const recoveryProven = state.status === "paused"
  && state.resumeAfterManualCompaction === true
  && entries.slice(index + 1).some((candidate) => candidate.type === "compaction");
return { state, recoveryProven };
```

Return `{ state: undefined, recoveryProven: false }` for no goal, clear entries, malformed latest goal data, and branch-read failure. Because the scan selects the latest goal entry, any edit, explicit pause, resume, clear, completion, replacement, or turn after the marker invalidates old eligibility.

- [ ] **Step 4: Share one recovery function between live and restored paths**

Extract the Task 2 transition into:

```typescript
function recoverGoalAfterManualCompaction(
  pi: ExtensionAPI,
  runtime: GoalRuntime,
  initState: InitRuntime,
  ctx: ExtensionContext,
): boolean {
  if (runtime.state?.status !== "paused"
    || runtime.state.resumeAfterManualCompaction !== true
    || initState.active) return false;
  try {
    transitionGoal(pi, runtime, "resume", "active", undefined, { resetBlockedAudit: true });
  } catch (error) {
    runtime.persistenceRetryNeeded = true;
    reportError(ctx, "Manual compaction succeeded, but the goal could not be resumed", error);
    return false;
  }
  runtime.continuationScheduled = false;
  ctx.ui.notify("Manual compaction complete. Goal resumed.", "info");
  setImmediate(() => scheduleGoalContinuation(pi, runtime, initState, ctx));
  return true;
}
```

Use it from live `session_compact` after checking `event.reason === "manual"`.

In both `session_start` and `session_tree`:

1. Reset runtime turn flags exactly as today.
2. Assign `runtime.state = restored.state`.
3. If `restored.recoveryProven`, call `recoverGoalAfterManualCompaction()`.
4. Otherwise schedule only a normally active state.

A failed recovery append leaves the runtime paused with the marker and schedules nothing. A later reload can retry if durable branch proof still exists.

- [ ] **Step 5: Run focused and full checks, then inspect the diff**

Run:

```bash
node --test --experimental-strip-types test/ContextCompaction.test.ts test/Killeros.test.ts
npm run check
npm test
git diff -- killeros/goals.ts test/ContextCompaction.test.ts
```

Expected: all checks PASS. Reload and tree navigation recover only proven active-branch state; stale order, later transitions, malformed branches, and persistence failures stay paused.

---

### Task 4: Lock Documentation and Minimum/Latest Pi Compatibility

**Files:**
- Modify: `README.md:8-12, 39-53, 78-90`
- Rewrite: `docs/implemented/context-compaction.md`
- Modify: `.github/workflows/ci.yml:1-61`
- Modify: `test/RepositoryContracts.test.ts:1-108`

**Interfaces:**
- Consumes: the source behavior completed in Tasks 1-3 and the existing peer minimums.
- Produces: accurate user documentation, a short superseded historical record, and a CI job that tests the latest matched Pi package set without changing peer ranges or lockfiles.

- [ ] **Step 1: Add failing repository contract tests**

Add near the existing document constants in `test/RepositoryContracts.test.ts`:

```typescript
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const oldCompactionPlan = readFileSync(new URL("../docs/implemented/context-compaction.md", import.meta.url), "utf8");
```

Add:

```typescript
test("compaction documentation assigns ownership to Pi", () => {
  assert.match(readme, /Pi decides when compaction runs/u);
  assert.match(readme, /Pi writes the summary/u);
  assert.match(readme, /manual \/compact.*paused.*resume/isu);
  assert.doesNotMatch(readme, /40% remaining|deterministic fallback|KillerOS checks context after each agent turn/iu);
  assert.match(oldCompactionPlan, /STATUS: SUPERSEDED/u);
  assert.match(oldCompactionPlan, /docs\/adr\/0001-let-pi-own-compaction\.md/u);
});

test("CI checks the locked Pi floor and latest matched Pi packages", () => {
  assert.match(ci, /Pi latest compatibility/u);
  assert.match(ci, /npm view @earendil-works\/pi-coding-agent version/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-ai/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-tui/u);
  assert.match(ci, /@earendil-works\/pi-ai@\$PI_AI_RANGE/u);
  assert.match(ci, /@earendil-works\/pi-coding-agent@\$PI_VERSION/u);
  assert.match(ci, /@earendil-works\/pi-tui@\$PI_TUI_RANGE/u);
  assert.match(ci, /--package-lock=false/u);
  assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.82.1");
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.82.1");
});
```

- [ ] **Step 2: Run the repository contract test to prove docs and CI are stale**

Run:

```bash
node --test --experimental-strip-types test/RepositoryContracts.test.ts
```

Expected: FAIL on old 40%/fallback claims, missing superseded status, and missing latest compatibility job.

- [ ] **Step 3: Rewrite README compaction behavior**

Replace the feature bullet with:

```markdown
- Pi-owned context compaction with active goals continuing from Pi's settled boundary after manual, threshold, and overflow compaction
```

Replace the configuration compaction paragraph with:

```markdown
Pi decides when compaction runs and Pi writes the summary, applies manual focus instructions, tracks files, retries summarization, and handles overflow recovery. KillerOS does not add a second threshold or replace Pi's summary. Active `/goal` work continues from Pi's settled boundary, after Pi finishes retries, compaction, and queued work.

Manual `/compact` aborts the current goal turn before summarization, so KillerOS records an honest temporary pause for that exact goal revision. After Pi saves the manual summary, KillerOS resumes that revision automatically. A failed or cancelled manual compaction stays paused; run `/goal pause` during the pause to cancel automatic recovery.
```

Keep the footer’s `<15% · /compact` display prompt; it is user guidance, not an automatic threshold.

- [ ] **Step 4: Replace obsolete implementation instructions with a superseded record**

Rewrite `docs/implemented/context-compaction.md` to exactly:

```markdown
# Context Compaction Implementation Plan

STATUS: SUPERSEDED

This plan describes the former KillerOS-owned threshold, summary, fallback, and continuation-hold implementation. It was implemented and later removed because it duplicated Pi's compaction lifecycle and state.

The replacement decision is recorded in [`docs/adr/0001-let-pi-own-compaction.md`](../adr/0001-let-pi-own-compaction.md): Pi owns compaction, while `/goal` owns the durable objective, status, continuation, and revision-bound manual recovery.
```

Do not rewrite historical release notes in `CHANGELOG.md`.

- [ ] **Step 5: Add latest matched Pi compatibility to CI**

Add this job after `quality` in `.github/workflows/ci.yml`:

```yaml
  pi-latest:
    name: Pi latest compatibility
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Check out source
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 1
          persist-credentials: false

      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22.19.0'
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Install locked dependencies
        run: npm ci --ignore-scripts --no-audit --no-fund

      - name: Install latest matched Pi packages
        run: |
          PI_VERSION=$(npm view @earendil-works/pi-coding-agent version)
          PI_AI_RANGE=$(npm view "@earendil-works/pi-coding-agent@$PI_VERSION" dependencies.@earendil-works/pi-ai)
          PI_TUI_RANGE=$(npm view "@earendil-works/pi-coding-agent@$PI_VERSION" dependencies.@earendil-works/pi-tui)
          test -n "$PI_AI_RANGE" && test -n "$PI_TUI_RANGE"
          npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false \
            "@earendil-works/pi-ai@$PI_AI_RANGE" \
            "@earendil-works/pi-coding-agent@$PI_VERSION" \
            "@earendil-works/pi-tui@$PI_TUI_RANGE"

      - name: Type-check against latest Pi
        run: npm run check

      - name: Test against latest Pi
        run: npm test
```

Run this on the workflow’s existing push, pull request, schedule, and manual triggers. The locked `quality` job remains the minimum compatibility check; do not change `package.json` or `package-lock.json` versions.

- [ ] **Step 6: Run focused checks and inspect documentation/CI diffs**

Run:

```bash
node --test --experimental-strip-types test/RepositoryContracts.test.ts
npm run check
git diff -- README.md docs/implemented/context-compaction.md .github/workflows/ci.yml test/RepositoryContracts.test.ts
```

Expected: PASS. Current docs contain no KillerOS threshold/fallback claim; the old plan is clearly superseded; CI derives the latest coding-agent version plus its declared Pi AI/TUI ranges and installs that matched package set without writing the lockfile.

---

### Task 5: Integration Audit, Latest-Pi Verification, and Plan Closure

**Files:**
- Verify: all changed implementation, tests, docs, and CI files
- Modify: `docs/spec/2026-08-09-pi-owned-compaction-goal-continuation.md`
- Move to: `docs/implemented/2026-08-09-pi-owned-compaction-goal-continuation.md`

**Interfaces:**
- Consumes: all deliverables from Tasks 1-4.
- Produces: a verified implementation with no duplicate compaction ownership and a completed implementation record.

- [ ] **Step 1: Audit removed ownership and retained public behavior**

Run:

```bash
rg -n "CompactionRuntime|createCompactionRuntime|registerContextCompaction|continuationHeldForCompaction|automaticCompactionAwaitingHook|automaticCompactionPending|killerosDeterministicFallback|DETERMINISTIC_FALLBACK_PREFIX" Killeros.ts killeros test README.md
rg -n "session_before_compact|ctx\.compact\(" Killeros.ts killeros
rg -n "contextPercentRemaining" Killeros.ts killeros/footer.ts test/ContextCompaction.test.ts
```

Expected:

- The first two commands return no matches.
- The third command finds the main export, the display helper implementation, and its public API tests.
- `killeros/context-compaction.ts` no longer exists.

- [ ] **Step 2: Run the full locked-minimum validation**

Run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

Expected: PASS with no failed tests. Environment-dependent symlink tests may skip for the same documented platform reason as baseline.

- [ ] **Step 3: Verify against the latest matched Pi package set and restore the locked minimum**

Run:

```bash
PI_VERSION=$(npm view @earendil-works/pi-coding-agent version)
PI_AI_RANGE=$(npm view "@earendil-works/pi-coding-agent@$PI_VERSION" dependencies.@earendil-works/pi-ai)
PI_TUI_RANGE=$(npm view "@earendil-works/pi-coding-agent@$PI_VERSION" dependencies.@earendil-works/pi-tui)
test -n "$PI_AI_RANGE" && test -n "$PI_TUI_RANGE"
npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false \
  "@earendil-works/pi-ai@$PI_AI_RANGE" \
  "@earendil-works/pi-coding-agent@$PI_VERSION" \
  "@earendil-works/pi-tui@$PI_TUI_RANGE"
npm run check
npm test
npm ci --ignore-scripts --no-audit --no-fund
git diff --exit-code -- package.json package-lock.json
```

Expected: latest checks PASS, the locked minimum is restored, and neither manifest nor lockfile changed. If the registry is unavailable, record the exact network failure and rely on the new CI job rather than changing source or dependency policy.

- [ ] **Step 4: Validate package contents and repository hygiene**

Run:

```bash
npm pack --dry-run --ignore-scripts --json > pack.json
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [pack] = JSON.parse(readFileSync("pack.json", "utf8"));
  const files = new Set(pack.files.map(({ path }) => path));
  if (!files.has("Killeros.ts") || !files.has("killeros/footer.ts")) throw new Error("required runtime files are missing");
  if (files.has("killeros/context-compaction.ts")) throw new Error("deleted compaction controller is still packaged");
'
rm pack.json
git diff --check
git status --short --untracked-files=all
```

Expected: package check PASS, no whitespace errors, and the pre-existing `CONTEXT.md` change remains intact alongside only implementation-related tracked changes. Ignored docs remain absent from normal status by repository policy.

- [ ] **Step 5: Inspect every bounded diff against the objective**

Run:

```bash
git diff -- Killeros.ts killeros/footer.ts killeros/runtime.ts killeros/goals.ts test/ContextCompaction.test.ts test/Killeros.test.ts
git diff -- README.md docs/implemented/context-compaction.md .github/workflows/ci.yml test/RepositoryContracts.test.ts
git diff -- CONTEXT.md
```

Expected:

- Every source line traces to Pi-owned compaction, goal continuation, manual recovery, or API preservation.
- No fallback, threshold controller, watchdog, hidden handoff, or duplicate progress state remains.
- `CONTEXT.md` still contains only the previously agreed vocabulary changes.

- [ ] **Step 6: Mark this plan done and move it to implemented records**

Insert this line immediately after the title:

```markdown
STATUS: DONE
```

Then run:

```bash
mkdir -p docs/implemented
mv docs/spec/2026-08-09-pi-owned-compaction-goal-continuation.md \
  docs/implemented/2026-08-09-pi-owned-compaction-goal-continuation.md
test -f docs/implemented/2026-08-09-pi-owned-compaction-goal-continuation.md
test ! -e docs/spec/2026-08-09-pi-owned-compaction-goal-continuation.md
git check-ignore -v docs/implemented/2026-08-09-pi-owned-compaction-goal-continuation.md
git check-ignore -v docs/adr/0001-let-pi-own-compaction.md
```

Expected: the completed plan exists only under `docs/implemented/`; both new docs are still ignored by the repository’s existing `docs/` rule. Do not stage them. Name both paths in the execution report so the user can later use `git add -f` if they choose.

- [ ] **Step 7: Produce the inline execution report**

Use this exact structure:

```text
Execution summary
- Tasks complete: 5 / 5
- Checks passed: locked-minimum type-check/tests, latest matched Pi type-check/tests, package smoke test, diff audit
- Unrelated work preserved: CONTEXT.md and docs/adr/0001-let-pi-own-compaction.md preserved

Issues
- None

Remaining actions
- Force-add ignored ADR and implemented plan when the user is ready to stage documentation
```

If any check did not pass, replace `None` with the exact task, command, output, diagnosed cause, and retained changes. Do not claim completion until all objective requirements and relevant edge cases have been audited.
