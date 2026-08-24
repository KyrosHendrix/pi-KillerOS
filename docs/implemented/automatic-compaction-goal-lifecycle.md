# Automatic compaction goal lifecycle

STATUS: DONE

## Problem statement

KillerOS can automatically compact context while a `/goal` is active. The goal currently remains active during the compaction request in the mocked success path, and Pi 0.84.3 can report the interrupted turn as `stopReason: "error"` with `errorMessage: "This operation was aborted"`. Normal goal error handling then persists the goal as paused and clears automatic-compaction recovery state. Compaction can finish successfully afterward without resuming the goal.

This leaves a long-running goal stopped even though automatic compaction succeeded. The user must run `/goal resume` manually.

The required lifecycle is:

```text
/goal active -> /goal paused + automatic compaction -> /goal resume
```

The goal must remain paused for the entire compaction interval. Successful compaction resumes the same goal once. Failed compaction leaves it paused.

## Current behavior

- Automatic compaction runs at the completed-turn boundary in TUI and RPC modes when the configured context threshold is reached.
- The automatic-compaction controller records one in-flight request and calls goal lifecycle handlers when a goal is active.
- The goal handler currently records only an in-memory `pending` marker when compaction starts. It does not persist a paused goal transition.
- The existing success regression models `stopReason: "aborted"` and expects the goal to remain active during compaction.
- Pi 0.84.3 can instead emit `stopReason: "error"` with the abort diagnostic `This operation was aborted` during automatic compaction.
- Generic error settlement pauses the active goal and clears the automatic-compaction marker. The later successful compaction callback then has no eligible goal to resume.
- Failed automatic compaction already stops automatic continuation and reports the compaction failure, but this behavior assumes the goal is still active when failure is reported.
- Manual compaction has separate recovery behavior. It persists a recovery-eligible paused state and uses live event and revision safeguards so explicit user actions cannot revive stale work.

## Solution

Persist a real automatic pause before requesting compaction. Bind automatic recovery to the exact paused goal revision created for that request.

While the automatic pause marker is active, settlement of the interrupted goal turn must recognize both Pi abort forms:

- `stopReason: "aborted"`
- `stopReason: "error"` with the exact known Pi abort diagnostic `This operation was aborted`

These outcomes belong to the active automatic-compaction lifecycle. They must not become generic goal failures and must not consume recovery eligibility. Other `error` outcomes remain genuine goal failures and must fail closed.

Successful compaction may resume only when the current goal is still the exact automatic pause revision. Resuming persists an active goal transition and schedules one hidden goal continuation. Duplicate completion callbacks, duplicate settlement events, and either callback order must not create a second resume or continuation.

Failed compaction clears automatic recovery eligibility, persists the failure on the paused goal when storage is available, and schedules no continuation. The user can recover with an explicit `/goal resume` after resolving the compaction problem.

Automatic and manual compaction recovery remain separate. Automatic compaction must not use or weaken the manual `resumeAfterManualCompaction` marker.

## User stories

1. As a user running a long-lived `/goal`, I want the goal paused while automatic compaction runs, so that its status reflects that automatic work is temporarily stopped.
2. As a user whose automatic compaction succeeds, I want the same goal resumed once, so that work continues without a manual command.
3. As a user whose automatic compaction fails, I want the goal to stay paused, so that KillerOS does not continue with uncompacted or uncertain context.
4. As a user who changes goal state during compaction, I want my explicit action to win, so that compaction cannot revive work I paused, replaced, cleared, completed, or blocked.

## Acceptance criteria

- [ ] Starting automatic compaction for an active goal persists a `paused` goal state before `ctx.compact()` is invoked.
- [ ] The observable state throughout compaction is `/goal paused` in both TUI and RPC modes.
- [ ] The automatic pause stops the active goal clock and disables active-only goal tooling through the existing goal transition behavior.
- [ ] Automatic compaction recovery is bound to the exact paused goal revision created by that compaction request.
- [ ] Pi's `stopReason: "aborted"` while the automatic marker is active is treated as the expected compaction interruption.
- [ ] Pi's `stopReason: "error"` with `errorMessage: "This operation was aborted"` while the automatic marker is active is treated as the expected compaction interruption.
- [ ] The abort-shaped `error` outcome does not overwrite the automatic pause with a generic goal error and does not clear valid automatic recovery eligibility.
- [ ] A non-abort provider error remains a genuine failure, leaves the goal paused, clears automatic recovery eligibility, and cannot resume after a later compaction-success callback.
- [ ] A successful automatic compaction changes the exact eligible paused goal to `active` through the existing resume transition.
- [ ] Successful automatic compaction sends exactly one hidden `killeros-goal-continuation` message.
- [ ] The continuation is sent only after compaction succeeds and the interrupted goal turn has reached its settlement boundary.
- [ ] A duplicate compaction completion callback does not create another resume transition or continuation.
- [ ] A duplicate `agent_settled` event does not create another resume transition or continuation.
- [ ] Completion before settlement and settlement before completion both produce one final resume and one continuation.
- [ ] A failed automatic compaction leaves the goal `paused` and sends no continuation.
- [ ] A synchronous `ctx.compact()` failure follows the same paused failure behavior as the asynchronous compaction error callback.
- [ ] A failed compaction records a terminal-safe automatic-compaction failure reason on the paused goal when persistence succeeds.
- [ ] If persisting the automatic pause fails, KillerOS does not start compaction, keeps the goal fail-closed in paused in-memory state through existing persistence-retry behavior, and sends no continuation.
- [ ] If compaction succeeds but persisting the resume fails, the goal remains paused, no continuation is sent, and KillerOS reports the resume failure.
- [ ] An explicit `/goal pause` during automatic compaction invalidates automatic recovery, remains paused after success, and sends no continuation.
- [ ] Replacing or editing the goal during automatic compaction invalidates recovery for the old paused revision.
- [ ] Clearing the goal during automatic compaction prevents any later callback from recreating it.
- [ ] A goal that is completed or blocked before recovery cannot be changed back to active by automatic compaction callbacks.
- [ ] Session shutdown, session restore, tree navigation, switch, and fork lifecycle resets cannot revive a stale automatic pause marker.
- [ ] Automatic recovery is process-local. Reload does not infer automatic recovery from historical compaction entries.
- [ ] Existing manual-compaction recovery still resumes only its exact eligible paused revision after a live manual compaction event.
- [ ] Explicit pause still cancels manual-compaction recovery.
- [ ] Threshold and overflow compaction events still do not consume manual-compaction recovery eligibility.
- [ ] Ordinary prompts without an active goal retain their current automatic-compaction continuation behavior.
- [ ] Print and JSON modes remain unsupported for automatic goal continuation.
- [ ] No new dependency, scheduler, persistence format version, or second compaction implementation is introduced.

## Implementation decisions

- Persist the automatic pause in the existing goal entry stream. Use the existing `pause` event and `paused` goal state rather than adding a second durable goal-state model.
- Persist successful recovery through the existing `resume` event and active goal transition.
- Persist an automatic-compaction failure through the existing `error` event while keeping the goal paused.
- Keep automatic recovery metadata in `GoalRuntime`. Do not add an automatic recovery field to persisted `GoalState`; stale automatic recovery must not survive process or branch lifecycle changes.
- Replace the string-only automatic-compaction marker with the minimum runtime state needed to identify:
  - the exact paused goal revision,
  - whether compaction has completed successfully,
  - whether the interrupted goal turn has settled.
- Treat the automatic pause revision as a compare-before-resume guard. Recovery is eligible only when the current state is still `paused` and its revision equals the marker's paused revision.
- The automatic-compaction completion callback and `agent_settled` share one guarded finalization path. That path resumes only after both successful compaction and goal-turn settlement are observed.
- The finalization path consumes the automatic marker before attempting the resume transition. A duplicate callback therefore has no recovery capability.
- The normal continuation scheduler remains the only message dispatch path. Its existing scheduling and in-flight gates provide the final duplicate-continuation guard.
- While automatic recovery is pending, settlement clears bookkeeping for the interrupted turn but does not schedule continuation independently.
- Match the known Pi 0.84.3 abort diagnostic exactly after the project's existing terminal-safe normalization. Do not use broad substring matching such as any message containing `abort`.
- Keep `stopReason: "aborted"` as an accepted automatic-compaction interruption for compatible providers and prior Pi behavior.
- Route all other `stopReason: "error"` values through normal fail-closed goal error handling, even if compaction later reports success.
- An explicit `/goal pause` against the automatic paused revision must write a new pause revision or otherwise invalidate the exact revision marker before returning. The existing "already paused" no-op is not sufficient while automatic recovery is pending.
- All goal transitions that supersede the marked revision clear automatic recovery state. This includes resume, edit, replace, clear, block, complete, failure, shutdown, restore, tree navigation, switch, and fork handling.
- Keep the manual `resumeAfterManualCompaction` field and its revision-bound rules unchanged. Automatic recovery must not set, clear, or consume that persisted marker except through existing user transitions that already supersede goal state.
- Keep Pi responsible for summary generation, cut points, retry behavior, and writing the compaction entry. This change only repairs KillerOS goal state around its existing proactive trigger.
- Add one concise `Unreleased` changelog fix describing the corrected `active -> paused + compaction -> active` lifecycle after implementation.

The intended runtime state machine is:

```text
active revision N
  -> automatic request persists paused revision N+1
  -> wait for successful compaction and interrupted-turn settlement in either order
  -> if current revision is still N+1, persist active revision N+2
  -> schedule one continuation

paused revision N+1
  -> compaction failure, genuine provider failure, explicit user transition,
     persistence failure, or lifecycle reset
  -> clear automatic recovery eligibility
  -> remain paused or honor the newer user/terminal state
```

## Testing decisions

- Use `test/AutoCompaction.test.ts` as the primary TDD seam. Its registered extension handlers, command entry point, real goal runtime, persisted-entry adapter, compaction callbacks, and sent-message capture exercise the full automatic trigger-to-goal lifecycle without testing private helpers.
- Replace the current success regression that expects `active` during compaction. The corrected regression must observe the persisted state sequence `active`, `paused`, then `active`.
- First add a red regression that emits Pi 0.84.3's real interruption shape: `stopReason: "error"` and `errorMessage: "This operation was aborted"` while automatic compaction is pending.
- In the same public seam, assert that:
  - the last persisted goal state is paused before compaction completion,
  - successful completion persists active state,
  - one continuation is sent,
  - repeated completion and settlement callbacks do not increase that count.
- Add the inverse callback-order case so completion-before-settlement and settlement-before-completion converge on the same result.
- Update the existing failed automatic goal compaction test to assert the goal is already paused before failure and remains paused afterward with a saved failure reason and no continuation.
- Add a genuine provider-error case using `stopReason: "error"` with a non-abort message. A later successful compaction callback must not resume it.
- Add an explicit `/goal pause` case during the automatic pause. A later successful completion must leave it paused.
- Run the primary behavior cases for both `tui` and `rpc` where the harness supports mode selection. One shared table is preferred over duplicated tests.
- Keep `test/ContextCompaction.test.ts` as the regression seam for manual compaction. Its existing tests cover exact-revision recovery, explicit pause cancellation, threshold and overflow isolation, terminal states, persistence failure, reload, and branch navigation.
- Do not duplicate manual recovery coverage in the automatic-compaction suite. Run the existing focused file unchanged unless a shared public behavior requires a narrow assertion update.
- Keep the ordinary-prompt automatic-compaction tests unchanged to prove the goal fix does not alter non-goal continuation.
- Follow strict red-green TDD:
  1. Change the lifecycle test to require paused state and the Pi 0.84.3 abort-shaped error.
  2. Run the focused test and record the failure.
  3. Implement only the state transition and guarded finalization needed to pass.
  4. Add failure and race-order slices one at a time.
  5. Run focused tests, then the full suite and type check.
- Verification commands after implementation:

```bash
node --test --experimental-strip-types test/AutoCompaction.test.ts
node --test --experimental-strip-types test/ContextCompaction.test.ts
npm test
npm run check
git diff --check
```

## Out of scope

- Changing automatic-compaction thresholds, settings, arming, or retry policy.
- Replacing Pi's compaction summaries or adding a KillerOS summary format.
- Persisting automatic recovery across process restart, session reload, branch navigation, switch, or fork.
- Changing manual `/compact` behavior or its persisted recovery marker.
- Broad provider-specific error classification beyond the confirmed Pi 0.84.3 abort diagnostic and existing `aborted` stop reason.
- Adding user commands, settings, notifications, dependencies, timers, background workers, or a new goal status.
- Refactoring unrelated goal transitions, test adapters, or compaction code.
- Changing goal entry version 1 or migrating historical session entries.

## Open questions

- None.

## Further notes

The real Pi 0.84.3 session proves the missing case. The interrupted assistant message ended with `stopReason: "error"` and `errorMessage: "This operation was aborted"`. KillerOS then persisted an `error` goal entry with paused state. Pi saved the compaction entry about 32 seconds later, but no automatic resume followed. The next resume entry came from a manual `/goal resume`.

The historical automatic-compaction fix covered only the mocked `aborted` path and kept the goal active during compaction. Its exactly-once continuation guard remains useful prior art, but its lifecycle assertion is now intentionally replaced.

The source of truth remains the goal entry stream. Pi's compaction summary describes context but does not own the goal objective or status.
