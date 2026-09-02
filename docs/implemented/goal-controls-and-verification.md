# Goal controls and verification

STATUS: DONE

> **Reserved-word grammar:** Objectives beginning with a reserved goal command require `/goal start -- <objective>`.

## Summary

KillerOS `/goal` can continue across turns, compaction, reloads, and branch navigation. Three additions make that automation easier to trust and inspect:

1. Named completion checks that must pass before a goal can become complete.
2. Per-goal turn limits that pause unattended work at a defined boundary.
3. Branch-aware goal history built from the existing goal entry stream.

The design keeps one owner for goal state. It adds no dependency, scheduler, database, or second history format.

## Problem statement

General goals currently complete from model-reported evidence. Goals that name one absolute file can also use the existing file baseline check, but most repository work has a stronger acceptance command such as `npm test`, `npm run check`, or a project script. KillerOS has no first-class way for the user to require that command.

An active goal also has no user-defined turn boundary. It continues until the model reports completion, records the same blocker for three turns, encounters a failure, or the user pauses it. A mistaken or broad objective can therefore consume more turns than the user intended.

KillerOS persists every goal transition as a `killeros-goal` custom entry, but the user can inspect only the latest state through `/goal`. The transcript contains individual entries, yet it does not provide one concise lifecycle view after compaction, reload, or branch navigation.

## Goals

- Let the user bind a goal to a named project completion check.
- Run the completion check before KillerOS persists `complete`.
- Keep raw shell commands out of session state.
- Detect changes to a bound check and require the user to approve the new definition.
- Let the user cap the number of goal turns.
- Pause only at a turn boundary. Never interrupt a tool call to enforce the limit.
- Show meaningful goal transitions for the current session branch.
- Preserve old version 1 goal entries without migration.
- Preserve current plain `/goal <objective>` behavior.

## Non-goals

- Token, cost, wall-clock, or per-tool budgets.
- Parallel goals, goal queues, subtasks, or dependency graphs.
- Remote CI polling or hosted build integrations.
- Running arbitrary commands copied from a session file.
- Replacing the existing file deliverable check.
- Persisting a second goal history model.
- Adding a custom TUI component for history.
- Changing blocker audit, compaction, handoff, or notification policy.

## User experience

### Configure named completion checks

A trusted project may define checks in `${CONFIG_DIR_NAME}/killeros-hooks.json`. In the standard Pi distribution this is `.pi/killeros-hooks.json`.

```json
{
  "goalChecks": {
    "quality": {
      "command": "npm run check && npm test",
      "timeoutMs": 300000
    },
    "unit": {
      "command": "npm test",
      "timeoutMs": 120000
    }
  }
}
```

`timeoutMs` is optional. Its default remains the existing hook default of 30,000 ms. Accepted values are integers from 1 through 300,000.

Check names must match `^[a-z0-9][a-z0-9._-]{0,63}$`. A configuration may contain at most 32 checks. A command must contain between 1 and 8,000 characters after trimming.

KillerOS reads this configuration through the existing bounded, trusted, regular-file path in `killeros/hooks.ts`. Symlinks, hard links, oversized files, untrusted projects, malformed JSON, and invalid check definitions remain fail-closed.

### Start a controlled goal

The existing form remains unchanged:

```text
/goal <objective>
```

A new strict form creates the goal and its controls atomically:

```text
/goal start [--check <name>] [--turns <count>] -- <objective>
```

Examples:

```text
/goal start --check quality -- Ship the release
/goal start --turns 8 -- Investigate the slow startup
/goal start --check unit --turns 12 -- Finish the parser migration
```

The first ` -- ` separates options from the free-form objective. KillerOS parses only the option prefix. The objective may contain spaces, quotes, Markdown, and later `--` text without custom shell tokenization.

Use Node's `parseArgs` for the option prefix. Reject unknown flags, duplicate flags, missing values, positional option text, an invalid check name, an invalid turn count, or a missing separator. A turn count must be an integer from 1 through 10,000.

The existing unfinished-goal replacement confirmation still applies. KillerOS resolves and hashes the named check before it clears or replaces any goal state. A failed configuration lookup leaves the current goal unchanged.

### Change controls on an existing goal

```text
/goal check <name>
/goal check clear
/goal limit <count>
/goal limit clear
```

These commands require a saved session and an existing non-complete goal. They preserve the objective, status, elapsed active time, turn count, blocker audit, result, and file verification.

When the goal is active, the command holds automatic continuation and waits for Pi to become idle. It then rechecks the current revision before saving the change. If the goal completed while the command waited, KillerOS reports that outcome and writes nothing.

Changing a check or a limit does not resume a paused or blocked goal. The user still runs `/goal resume`. Changing an active goal keeps it active and schedules at most one continuation after the new revision is saved.

Setting a limit less than or equal to the current turn count pauses an active goal immediately with `Turn limit reached (<turns>/<maxTurns>).` A paused or blocked goal keeps its current status. `/goal resume` refuses while `turns >= maxTurns` and tells the user to raise or clear the limit.

Editing an objective keeps the named completion check and turn limit. It still replaces the inferred file verification because the output path may have changed. Starting or replacing a goal through plain `/goal <objective>` does not inherit controls from the prior goal.

### Complete a checked goal

The model continues to call `killeros_goal_update` with `status: "complete"` and concise evidence. KillerOS performs checks in this order:

1. Validate and trim the model's evidence.
2. Run the existing file deliverable verification when present.
3. Reload the trusted project configuration.
4. Resolve the bound named completion check.
5. Compare its current definition hash with the hash saved on the goal.
6. Run the command from `ctx.cwd` through `executeHook` with the tool's `AbortSignal`.
7. Repeat file verification so the command cannot invalidate the deliverable.
8. Persist `complete` only when every applicable check passes.

A nonzero exit, timeout, cancellation, missing check, changed definition, unreadable configuration, or untrusted project throws a tool error and leaves the goal active. The model receives a bounded reason and may fix the repository before retrying. KillerOS never records partial completion.

The command receives these additional environment variables:

```text
KILLEROS_EVENT=goal_check
KILLEROS_GOAL_CHECK=<name>
```

Do not put the objective, model evidence, session path, or raw goal state in the environment. The check already runs in the project working directory.

Successful stdout and stderr are not copied into goal state or model context. Failure output uses the existing 16 KiB limit for each output stream and terminal-safe error formatting.

### Enforce a turn limit

`turns` continues to mean goal turns started. `maxTurns` is the maximum number of those turns.

If the Nth turn reaches normal settlement while the goal remains active and `maxTurns` is N, KillerOS persists a paused `limit` transition and schedules no continuation. Terminal outcomes win:

- A successful completion during the Nth turn remains complete.
- A third matching blocker during the Nth turn remains blocked.
- An abort, provider failure, or persistence failure follows the existing fail-closed pause behavior.
- A failed completion check during the Nth turn leaves the goal active until settlement, then the limit pauses it.

The continuation gate must also enforce the limit before starting work. This covers restored sessions, tree navigation, manual prompts, automatic-compaction recovery, and states written by older runtimes. An exhausted active state becomes paused before KillerOS can begin another goal turn.

The limit never calls `ctx.abort()`. It does not interrupt an active model response or tool process.

### Inspect goal history

```text
/goal history
/goal history <count>
```

The default count is 20. The accepted range is 1 through 50.

History scans `ctx.sessionManager.getBranch()` once and reads only valid `killeros-goal` custom entries. It follows the active branch automatically. It includes these events:

```text
set, replace, edit, check, limit, pause, resume,
blocker-audit, blocked, complete, error, clear
```

It omits `turn` and `checkpoint` entries because those can dominate a long session without adding a lifecycle decision. Each shown state already contains its current turn count.

Each line uses existing terminal-safe formatting and contains the available parts of:

```text
+<elapsed>  <event>  turn <turns>  <tokens used>  <result or control change>
```

Elapsed time comes from `state.updatedAt - state.createdAt`. Token use comes from one running total over assistant, tool-result, compaction, and branch-summary usage on the active branch, minus the state's `baselineTokens`. Evidence and objectives are truncated to a terminal-safe 160-character preview.

A `clear` event uses the most recent valid goal state for its objective and token baseline. Invalid historical data is skipped. If no valid goal entries exist, KillerOS reports `No goal history on the current branch.`

TUI and RPC use the same plain notification output. History adds no custom component and no persisted summary.

## Command grammar

`/goal` reserves command words case-insensitively. Objectives such as `Start reliably` and `Pause scheduled work` require `/goal start -- <objective>`.

The forms are:

```text
/goal
/goal <objective>
/goal clear
/goal edit
/goal pause
/goal resume
/goal start [--check <name>] [--turns <count>] -- <objective>
/goal check <name|clear>
/goal limit <count|clear>
/goal history [count]
```

Malformed strict-start syntax returns a usage error once the text begins with an option or contains the ` -- ` separator. Other input that does not match a complete control form remains a plain objective.

Update `COMMAND_SYNTAX_HINTS` and `/goal` argument completions. Completion should suggest control words and static option names. It does not need to read project configuration to suggest dynamic check names.

## Data model

Keep `GOAL_VERSION` and `GoalEntryData.version` at 1. Both additions are optional and old entries remain valid.

```ts
export interface GoalCompletionCheck {
  kind: "named-command";
  name: string;
  configHash: string;
}

export interface GoalStateCommon {
  version: 1;
  revision: number;
  objective: string;
  createdAt: number;
  updatedAt: number;
  activeMilliseconds: number;
  turns: number;
  blockedAuditStartTurn: number;
  baselineTokens: number;
  verification?: GoalFileVerification;
  completionCheck?: GoalCompletionCheck;
  maxTurns?: number;
}
```

`configHash` is a lowercase SHA-256 hex digest of the accepted command and its effective timeout. `killeros/hooks.ts` owns the canonical hash input. `goals.ts` never hashes or persists a raw command.

`parseGoalState` accepts absent fields for old sessions and validates present fields:

- `completionCheck.kind` equals `named-command`.
- `completionCheck.name` matches the check-name pattern.
- `completionCheck.configHash` contains 64 lowercase hexadecimal characters.
- `maxTurns` is an integer from 1 through 10,000.

`commonGoalState`, clock transitions, checkpoints, pause, resume, blocked, and complete transitions preserve both fields. `createNewGoalState` accepts optional controls. `editGoalState` preserves controls while replacing file verification. Plain replacement creates a new state without inherited controls.

Add `check` and `limit` to `GoalEntryEvent`. These events persist the complete next `GoalState`, like every current goal transition.

## Configuration model

Extend the internal hook configuration without changing existing hook behavior:

```ts
interface KillerosGoalCheck {
  command: string;
  timeoutMs?: number;
}

interface KillerosHookConfig {
  hooks?: Partial<Record<KillerosHookEvent, KillerosHook[]>>;
  goalChecks?: Record<string, KillerosGoalCheck>;
}
```

Refactor the current loader into one private parser for both sections. Existing `tool_call`, `tool_result`, and `agent_settled` hooks keep their current matching, ordering, timeout, cancellation, and notification behavior.

Expose two narrow functions from `killeros/hooks.ts`:

```ts
export function resolveGoalCompletionCheck(
  ctx: ExtensionContext,
  name: string,
): GoalCompletionCheck;

export async function runGoalCompletionCheck(
  ctx: ExtensionContext,
  check: GoalCompletionCheck,
  signal?: AbortSignal,
): Promise<void>;
```

`resolveGoalCompletionCheck` validates project trust, loads the secure configuration, resolves the name, and returns only the name and hash. `runGoalCompletionCheck` repeats those checks, compares the hash, and delegates process management to `executeHook`.

Do not add a service interface, registry class, event bus message, or dependency injection layer. Two functions cover the two required operations.

## Runtime flows

### Controlled goal start

```text
user invokes /goal start
  -> parse options and objective
  -> resolve named check when supplied
  -> validate turn limit
  -> apply existing replacement guard
  -> wait for idle under continuationHeld
  -> re-resolve named check to detect a config change during the wait
  -> create GoalState with optional completionCheck and maxTurns
  -> persist set or replace
  -> schedule one continuation
```

### Checked completion

```text
model calls killeros_goal_update complete
  -> verify file when configured
  -> resolve and hash current named check
  -> reject changed or missing definition
  -> execute through executeHook
  -> reject cancellation, timeout, or nonzero exit
  -> verify the file again when both checks apply
  -> persist complete with model evidence
  -> disable goal update tool
```

### Turn-limit settlement

```text
agent_settled for a goal turn
  -> clear in-flight bookkeeping
  -> preserve existing compaction and failure handling
  -> if state is still active and turns >= maxTurns, persist limit pause
  -> otherwise schedule the next continuation
```

### History

```text
user invokes /goal history
  -> validate count
  -> scan current branch once
  -> accumulate token usage
  -> parse valid goal entries
  -> retain the latest requested meaningful events
  -> format one bounded notification
```

## Security requirements

- Read `goalChecks` only when `ctx.isProjectTrusted()` is true.
- Keep the existing 64 KiB configuration limit and real-path identity checks.
- Reject linked configuration files through the existing loader.
- Never persist a raw completion command in a session entry.
- Bind a goal to the hash of the accepted command and effective timeout.
- Fail completion if the named definition changes after binding.
- Require an explicit `/goal check <name>` or a new controlled goal to approve the changed definition.
- Pass the goal tool's `AbortSignal` into `executeHook`.
- Keep the existing process-tree termination and bounded-output behavior on every platform.
- Run checks only from `ctx.cwd`.
- Sanitize every command failure before it reaches the TUI or model.
- Treat restored session entries as untrusted data and validate every new field in `parseGoalState`.
- Never execute a command merely because a session was restored. Execution occurs only when the active model requests completion.

## Failure behavior

| Condition | Result |
| --- | --- |
| Unknown check during start or attach | Report error; write no goal transition |
| Untrusted project | Report error; do not resolve or run a check |
| Check definition changed | Reject completion; keep goal active |
| Check exits nonzero | Reject completion; keep goal active |
| Check times out | Terminate its process tree; reject completion |
| Check is cancelled | Terminate its process tree; reject completion |
| File verification fails | Do not start the command check |
| Completion persistence fails after checks pass | Use existing fail-closed persistence handling |
| Limit reached after a normal turn | Persist paused `limit`; schedule nothing |
| Resume requested with exhausted limit | Refuse resume; write nothing |
| History contains malformed entries | Skip them and continue the scan |
| History formatting exceeds notification bounds | Show only the requested capped lines |

A passed command is evidence for this completion attempt only. If persisting `complete` fails, a later retry runs the command again. Do not cache successful command results in memory or session state.

## Mode behavior

| Mode | Controlled start | Change controls | Completion check | History |
| --- | --- | --- | --- | --- |
| TUI | Supported | Supported | Supported | Notification |
| RPC | Supported | Supported | Supported | Notification |
| Print | Unsupported with existing `/goal` message | Unsupported | Goal continuation already unsupported | Unsupported |
| JSON | Unsupported with existing `/goal` message | Unsupported | Goal continuation already unsupported | Unsupported |

No new TUI-only dialog is required.

## UI and copy changes

The bare `/goal` status summary adds controls when present:

```text
Goal active · 3/8 turns · 12m 04s · 18.2k tokens
Check: quality
Ship the release
```

The footer keeps its current compact shape. When `maxTurns` exists, show `/goal is active 3/8 (12m)` if width allows. Do not show the check name in the footer.

Completion tool output distinguishes the result:

```text
Goal verified complete by file and quality: <evidence>
Goal verified complete by quality: <evidence>
Goal verified complete at <path>: <evidence>
Goal marked complete (model-reported): <evidence>
```

Check and limit mutation notifications are:

```text
Goal completion check set to quality
Goal completion check cleared
Goal turn limit set to 8
Goal turn limit cleared
Goal paused: turn limit reached (8/8)
```

All objective, evidence, command output, paths, and configuration errors pass through `safeTerminalText` before display.

## Files and ownership

- `killeros/runtime.ts` owns the persisted `GoalCompletionCheck` and `maxTurns` types.
- `killeros/goal-state.ts` owns parsing and pure state transitions.
- `killeros/hooks.ts` owns trusted check configuration, hashing, and process execution.
- `killeros/goals.ts` owns command grammar, completion ordering, limit enforcement, history projection, and user-facing results.
- `killeros/commands.ts` owns slash syntax hints.
- `killeros/footer.ts` owns the optional compact turn-limit display.
- `Killeros.ts` needs no new runtime object or dependency wiring.

Do not create a new source module unless `goals.ts` becomes harder to navigate during implementation. The first extraction candidate is a pure `goal-history.ts`, but only extract it if the implementation and focused tests justify the extra file.

## Acceptance criteria

### Completion checks

- [ ] A trusted project can define up to 32 named `goalChecks` in the existing hooks configuration.
- [ ] Existing lifecycle hook configuration behaves unchanged when `goalChecks` is absent or present.
- [ ] `/goal start --check quality -- <objective>` persists only the check name and definition hash.
- [ ] `/goal check quality` attaches the current accepted definition to an existing non-complete goal.
- [ ] `/goal check clear` removes only the named check and preserves file verification.
- [ ] Plain `/goal <objective>` keeps current behavior and stores no named check.
- [ ] Old version 1 states without `completionCheck` restore unchanged.
- [ ] Malformed persisted checks fail state parsing and cannot execute.
- [ ] File verification runs before a named command check.
- [ ] A zero exit permits the normal complete transition.
- [ ] A nonzero exit, timeout, cancellation, missing definition, changed definition, untrusted project, or configuration error leaves the goal active.
- [ ] A check definition change requires explicit user approval before completion can proceed.
- [ ] The completion command runs from `ctx.cwd` with bounded output and process-tree cancellation.
- [ ] Successful command output is not persisted or added to model context.
- [ ] A persistence retry reruns the command instead of trusting a cached pass.

### Turn limits

- [ ] `/goal start --turns 8 -- <objective>` persists `maxTurns: 8` atomically with the new goal.
- [ ] `/goal limit 8` and `/goal limit clear` update the current non-complete goal through a new revision.
- [ ] A normal Nth settlement pauses a goal whose limit is N and sends no continuation.
- [ ] Completion, blocking, abort, and provider failure outcomes on the Nth turn keep their existing terminal behavior.
- [ ] Restore, tree navigation, manual prompt start, and compaction recovery cannot start turn N+1.
- [ ] Setting a limit at or below the current turn count pauses an active goal.
- [ ] Resume is refused while the limit remains exhausted.
- [ ] Editing preserves the limit. Plain replacement does not inherit it.
- [ ] Limit enforcement never aborts an active turn.

### History

- [ ] `/goal history` shows the latest 20 meaningful events on the current branch.
- [ ] `/goal history <count>` accepts 1 through 50 and rejects every other value.
- [ ] History includes control changes, blocker audits, terminal evidence, elapsed time, and token use.
- [ ] History excludes noisy turn and checkpoint entries.
- [ ] History remains correct after compaction, reload, and tree navigation because it reads the current branch entry stream.
- [ ] History skips malformed custom entries and sanitizes all displayed data.
- [ ] History writes no session entry and creates no second persisted model.

### Compatibility

- [ ] Existing `/goal`, file verification, blocker audit, compaction recovery, handoff guard, footer reduction, and active-tool behavior remain intact.
- [ ] `GOAL_VERSION` and `GoalEntryData.version` remain 1.
- [ ] No production dependency is added.
- [ ] TUI and RPC behavior match the mode table.
- [ ] README command and configuration documentation is updated after implementation.
- [ ] `CHANGELOG.md` receives one concise Unreleased feature entry after implementation.

## Testing plan

Use public command, tool, lifecycle, and renderer seams. Do not test private helpers when the extension harness can prove the same behavior.

### `test/Hooks.test.ts`

- Accept valid `goalChecks` beside existing hooks.
- Reject invalid names, commands, timeouts, excessive counts, malformed objects, linked files, oversized files, and untrusted projects.
- Prove that the same accepted definition produces the same hash.
- Prove that a command or effective-timeout change produces a different hash.
- Prove cancellation and timeout reuse the existing process-tree cleanup behavior.

### `test/GoalCompletionVerification.test.ts`

- Start a checked goal from the strict command form.
- Assert that session state contains no raw command.
- Pass a zero-exit check and observe `complete`.
- Fail a check and observe unchanged active state.
- Change the config after binding and observe a hash-mismatch failure.
- Reattach the changed check and observe success.
- Combine file and command verification and prove file-first ordering.
- Restore valid and malformed completion-check state.

### `test/Goals.test.ts`

- Parse strict start options and reject malformed forms without replacing current state.
- Attach, replace, and clear controls while preserving unrelated state.
- Pause at the Nth settled turn and send no N+1 continuation.
- Let complete and blocked outcomes win on the last allowed turn.
- Refuse resume while exhausted.
- Format default and bounded history from synthetic branch entries.
- Skip turn, checkpoint, and malformed history entries.
- Prove history has no persistence or message side effects.

### `test/GoalLifecycle.test.ts`

- Restore optional control fields on the current branch.
- Pause an exhausted active state before continuation.
- Preserve controls through reload, tree navigation, checkpoint, pause, resume, and compaction recovery.
- Reject contradictory or malformed optional fields.

### Existing focused suites

- `test/SlashCommands.test.ts` covers the new syntax hint and control completions.
- `test/Footer.test.ts` covers limited and narrow-width turn-limit display.
- `test/AutoCompaction.test.ts` proves an exhausted goal does not restart after recovery.
- `test/ContextCompaction.test.ts` proves manual recovery respects the same continuation gate.

### Verification commands

```bash
node --test --experimental-strip-types test/Hooks.test.ts
node --test --experimental-strip-types test/GoalCompletionVerification.test.ts
node --test --experimental-strip-types test/Goals.test.ts
node --test --experimental-strip-types test/GoalLifecycle.test.ts
node --test --experimental-strip-types test/AutoCompaction.test.ts
node --test --experimental-strip-types test/ContextCompaction.test.ts
node --test --experimental-strip-types test/SlashCommands.test.ts
node --test --experimental-strip-types test/Footer.test.ts
npm test
npm run check
git diff --check
```

## Implementation sequence

1. Add failing parser and state-transition tests for `completionCheck` and `maxTurns`.
2. Extend `runtime.ts` and `goal-state.ts` while keeping version 1 compatibility.
3. Add failing secure-config tests for named checks.
4. Extend `hooks.ts` with check resolution, hashing, and execution through `executeHook`.
5. Add failing checked-completion tests at the registered tool seam.
6. Integrate file-first and command-second completion in `goals.ts`.
7. Add failing strict-start and control-mutation command tests.
8. Implement command parsing with Node's `parseArgs` and existing goal persistence paths.
9. Add failing turn-limit settlement and lifecycle tests.
10. Enforce the limit in settlement and the shared continuation gate.
11. Add failing history projection tests, then implement one branch scan and bounded output.
12. Update slash hints and the footer with focused tests.
13. Run the full suite, TypeScript check, lint, and diff check.
14. Update README and CHANGELOG only after behavior passes.
15. Add `STATUS: DONE` and move this file to `docs/implemented` after the feature ships.

Each step must leave one focused test file green before the next behavior is added.

## Kill criteria

Do not ship named completion checks if any of these conditions remain:

- A cancelled or timed-out check leaves its shell or descendant process alive.
- A restored or edited session can cause a raw persisted command to execute.
- A changed check definition can run without explicit user approval.
- A no-op check adds more than 250 ms p95 overhead across 100 local executions, excluding shell startup on the first warm-up run.

Do not ship turn limits if reload, tree navigation, or compaction recovery can start a turn above `maxTurns`.

Do not ship history if formatting 10,000 active-branch entries takes more than 50 ms on the supported Node.js baseline, or if implementation requires another persisted history record.

## Alternatives rejected

### Persist the raw command on `GoalState`

Rejected. Session files are data, may be imported, and should not become executable configuration. A named trusted-project check keeps command ownership in `.pi/killeros-hooks.json`.

### Use the existing `tool_call` lifecycle hook alone

A project can already match `killeros_goal_update`, parse `KILLEROS_PAYLOAD`, and run a command. That path cannot bind one accepted definition to one goal, distinguish configuration changes, expose the check in goal status, or preserve a per-goal completion contract without custom scripting.

### Add a second verification tool for the model

Rejected. The model could skip it or report completion through the existing goal tool. Completion enforcement belongs inside the one transition that writes `complete`.

### Abort a turn when the limit is reached

Rejected. A turn limit counts started turns. Enforcement at settlement avoids data loss and leaves tool execution semantics unchanged.

### Persist formatted history summaries

Rejected. The goal custom-entry stream already contains the source data and follows Pi branches. A second summary can drift from that source.

## Open questions

None. The command grammar, trust boundary, state shape, lifecycle ordering, and failure behavior are defined above.
