# Working on KillerOS

KillerOS is a strict TypeScript extension for the Pi coding agent. It replaces the stock TUI and adds goals, compaction, questions, and workflow commands. Changes must preserve Pi's native settings, request lifecycle, and project trust boundaries.

## Start with the affected behavior

`Killeros.ts` registers and connects features. Keep implementation in `killeros/`. Preserve registration order, especially goal settlement before request activity and completion notifications. `test/RepositoryContracts.test.ts` checks that order.

Read `README.md` before changing commands, configuration, requirements, or mode behavior. It owns user guidance and the release process. For Pi integration changes, consult the installed docs and API types in `node_modules/@earendil-works/pi-coding-agent/`.

Use npm. `package.json` defines supported engine and peer ranges; `package-lock.json` pins development packages. KillerOS supports Windows only.

Before finishing, check each applicable mode and entry point:

- TUI supports interactive UI and questions. RPC supports goals and proactive compaction without TUI components. Print/JSON modes do not support interactive questions, goals, or proactive compaction.
- Preserve Pi's `tuiMode`, `quietStartup`, and user keybindings. Editor movement must not consume fullscreen transcript navigation.
- Use Pi's native thinking, sampling, MCP, and codemode configuration. KillerOS does not migrate credentials or manage those settings.

## Keep local files local

`AGENTS.md` is tracked repository guidance. The root `.gitignore` ignores `docs/` and `.pi/`. Do not force-add those directories or change their ignore rules unless asked.

Open known files in ignored paths directly with `read`. Indexed `find` and `grep` may omit them. Keep private verification helpers in ignored locations. `eslint.config.js` excludes private `.pi/` artifacts, not repository code.

## Preserve the affected contracts

Read the relevant implementation and tests before changing these behaviors. Keep fixes in the shared owner rather than patching individual callers.

### Goals and compaction

Start with `killeros/goal-runtime.ts`, `killeros/goal-command.ts`, `killeros/goal-settlement.ts`, and `killeros/auto-compaction.ts`.

- Goal continuation requires an accepted turn decision. Compaction and provider retries must not grant turns or restart completed or blocked goals.
- Keep a goal request goal-owned through settlement, even after it completes or blocks the goal. Otherwise compaction can restart it as ordinary work.
- Guard pending goal commands against committed navigation and competing goal mutations during asynchronous waits. Cancelled navigation preserves valid pending commands.
- Keep `question` and `killeros_goal_update` sequential and `model-only`. Codemode must neither hide them from the model nor expose them to scripts.
- Activate the goal tool for active goals. An eligible later ordinary TUI or RPC request may complete only the same saved blocked goal. That permission is transient, tied to the captured goal snapshot, and grants no automatic turns.

Check `test/Goals.e2e.test.ts`, `test/CompactionGoals.e2e.test.ts`, `test/GoalLifecycle.e2e.test.ts`, and `test/BlockedGoalCompletion.e2e.test.ts`.

### Receipts, notifications, and Git metadata

Request activity and settled receipts live in `killeros/activity.ts` and `killeros/worked-for.ts`. Completion sounds live in `killeros/notifications.ts`.

- Finalize receipts and sounds at `agent_settled`, not an intermediate provider result.
- Session replacement, reload, and committed tree navigation invalidate pending work and stale contexts. Cancelled navigation preserves valid pending work.
- `killeros/passive-git-status.ts` owns Git scanning for the footer and `killeros/change-receipt.ts`. Fix Git correctness and executable safety there.
- Passive scans must not execute repository filters or repository-owned Git shims. A failed scan means unavailable metadata, not an empty repository.

Check `test/runtime-receipts.e2e.test.ts`, `test/Notifications.e2e.test.ts`, `test/runtime-receipt-git.e2e.test.ts`, and `test/runtime-receipt-conversion.e2e.test.ts`.

### Settings and fast mode

- Update `killeros.json` through `killeros/settings.ts`. Derive each update from the latest settings under the writer lock and preserve unrelated fields. Never replace malformed settings while reporting success.
- `killeros/codex-fast-state.ts` owns the process-local fast-mode preference. Do not persist it with KillerOS settings.
- Fast mode changes only eligible requests' service tier. Preserve sampling, other payload fields, exact native model matching, endpoint restrictions, and Pi's provider retry behavior.
- A footer label does not prove OpenAI accepted priority service. Azure's provider is `azure`; its Responses API is `azure-openai-responses`. Do not apply OpenAI priority service to Azure.

Check `test/Settings.e2e.test.ts` and `test/runtime-fast.e2e.test.ts`.

### Hooks, trust, and handoff

`killeros/hooks.ts` and `killeros/personal-instructions.ts` enforce project trust and file boundaries. `killeros/handoff.ts` and `killeros/secret-detector.ts` validate continuation context.

- Hook timeout and cancellation cleanup must account for descendants after shell exit. Report bounded uncertainty when termination cannot be confirmed.
- Process-tree tests must wait for complete PID contents, not just readiness-file creation.
- Reject recognized credentials before creating a handoff destination session. Save validated context before reporting success, without starting an agent turn.

Check `test/Hooks.e2e.test.ts`, `test/Hooks.system.test.ts`, and `test/Handoff.e2e.test.ts`.

## Verify the change

Run commands from the repository root. On a fresh checkout or after lockfile changes:

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

Run an affected test file while working:

```bash
node --test --test-force-exit --experimental-strip-types test/RepositoryContracts.test.ts
```

Application scenarios use the real Pi CLI through `test/support/`, not simulated hosts or private helpers.

For host integration, use `test/PiExtensionContract.test.ts` for packed-package activation and reload, `test/runtime-tools.e2e.test.ts` for tool exposure, and `test/runtime-native-provider.e2e.test.ts` for provider transport, sampling, Azure, and capacity retries. Use `test/Editor.e2e.test.ts` for inherited navigation, `test/Hooks.e2e.test.ts` for trust boundaries, and `test/Hooks.system.test.ts` for public hook process cleanup.

Before finishing a code change:

```bash
npm run check
npm run test:changed
```

`test:changed` runs the test files that cover the branch's changes since `origin/main`, including uncommitted and untracked files. Pass `-- --dry-run` to see the selection. When you add a module or a test file, map it in `scripts/test-changed.ts`; `test/test-changed.test.ts` fails until you do.

CI owns the full suite. Do not run `npm test` locally unless asked: it takes about 10 minutes on a laptop, and a pull request's CI runs it in under 2. CI tests the pushed commit, not uncommitted changes. Push only when you're allowed to. To run CI on a pushed branch without a pull request:

```bash
run=$(gh workflow run ci.yml --ref <branch> | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
gh run watch "$run" --exit-status
```

A test that fails in CI and passes on its own is a bug, not bad luck. Do not rerun CI until it turns green. Read the failure report, rerun the failing file locally, and fix the cause in the test, its driver, or KillerOS. If you can't fix it in the current change, open an issue with the failure report and say so in the pull request. Do not add retries, longer timeouts, or skips to make a flaky test pass.

`check` runs TypeScript without emitting files, then ESLint. Tests execute `.ts` files directly. There is no separate build step. Repository contracts scan untracked, non-ignored files too.

For README or changelog-only changes, run the focused `RepositoryContracts.test.ts` command and verify affected paths and examples. For release-metadata changes, also run:

```bash
node --test --test-force-exit --experimental-strip-types test/verify-release.test.ts test/release-notes.test.ts
```

For guidance-only changes in `AGENTS.md` or `docs/`, verify referenced paths, headings, and commands directly. Prose alone does not require the runtime suite.

CI runs on Windows using Node.js 26.13.0, pinned in `.node-version`, and checks the minimum Pi in Quality, because development pins equal the peer-range minimums, and the newest compatible Pi in `Pi compatibility (latest)`, which repeats the runtime suites only when that install differs from the lockfile. `npm test` runs `scripts/test-suite.ts`, which packs each file's top-level tests into units of about 15 seconds from `test/test-timings.json`. One top-level test is one unit at most, so split a long test that loops over independent scenarios into one test per scenario. Quality runs the same script across fifteen runners and adds the lifecycle repeats listed in `scripts/test-suite.ts`; `Pi compatibility (latest) tests` runs the identical shards against a newer Pi. When one shard regularly finishes well after the others, refresh the timings from a green CI run's shard logs: save `gh run view <run> --log` and run `node --experimental-strip-types scripts/test-suite.ts --record <log>`. Compatibility installs must not change the tracked manifest or lockfile. Local checks do not establish that CI passes. Report what ran and what remains unverified.

## Update docs and release metadata when needed

- Update `README.md` when commands, configuration, requirements, or mode behavior change. Keep detailed user guidance there.
- After implementing and verifying a spec, move it from `docs/spec/` to `docs/implemented-spec/`. Leave unfinished and unrelated specs in place.
- Add entries under `CHANGELOG.md`'s `[Unreleased]` only for changes a package user can notice or must act on: new capabilities, behavior changes, fixes, requirement or setup changes, and security fixes. Skip internal upkeep with no user-visible effect: tests, CI and release tooling, lint rules, refactors, documentation edits, repository instructions, plans, specs, and changelog policy.
- Bump versions only when asked. Follow [the README release process](README.md#release-process). `.github/workflows/release.yml` implements publication; `scripts/verify-release.ts` validates it. Do not bypass the publish guard or push version tags manually.

## Keep this guidance useful

Add a rule only for a non-obvious, recurring mistake that a concrete instruction can prevent. Explain the consequence when it is not clear. Keep details for one feature near its code or in a linked task-specific document.

Do not turn this file into a module inventory or a record of completed work. Rewrite or remove outdated guidance instead of appending another account. Remove migration notes when the migration finishes.
