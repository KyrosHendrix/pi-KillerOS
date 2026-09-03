# Bug: Change receipt unavailable timeout warning on turn settlement

**STATUS: DONE**

**Date:** 2026-09-03

## Summary

When a Git change-receipt scan exceeds one second as an assistant turn settles, KillerOS displays a UI warning notification:

```text
Warning: Change receipt unavailable: timeout
```

The repository is not necessarily unhealthy. Change-receipt collection uses a strict one-second Git timeout, performs a full status scan at settlement, discards its repository monitor after failure, and reports the optional metric failure as a warning. Windows process startup and NTFS traversal can push a valid status scan past that limit.

## Environment

- OS: Windows (NTFS)
- Package: `killeros` >= 2.1.22
- Host: Pi coding agent (TUI mode)

## Symptoms

1. At the end of an assistant turn during `agent_settled`, a warning notification appears: `Change receipt unavailable: timeout`.
2. In the "Worked for" entry, Git change metrics are omitted, displaying `Changes unavailable` instead of added, modified, or deleted line counts.
3. Once a timeout occurs, subsequent turns often continue to report timeouts repeatedly, even on turns with minimal file edits.
4. The repository itself is clean, functional, and contains no index locks or corruption.

## Root cause analysis

The issue stems from five confirmed behaviors across `killeros/change-receipt.ts` and `killeros/worked-for.ts`.

### 1. Hardcoded 1,000 ms timeout for Git operations

In `killeros/change-receipt.ts`:

```typescript
const GIT_TIMEOUT_MS = 1_000;
```

When `runGit()` executes any Git command, it arms a 1,000 ms timer:

```typescript
const timer = setTimeout(() => {
  failure = new GitFailure("timeout");
  child.kill();
}, GIT_TIMEOUT_MS);
```

If Git takes longer than 1 second to spawn and finish, the process is terminated and the error converts into `{ state: "unavailable", reason: "timeout" }`.

### 2. Heavy status arguments and disabled FSMonitor

In `killeros/change-receipt.ts`, the `snapshot()` status command runs with:

```typescript
const output = decode(await runGit(repo.root, [
  "-c", "core.fsmonitor=false",
  ...filterNames.flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]),
  "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all",
  ...(paths ? ["--", ...paths] : []),
]));
```

- `-c core.fsmonitor=false` prevents Git from using a configured FSMonitor for the scan.
- `--untracked-files=all` forces Git to recurse into every untracked subdirectory and inspect individual files rather than stopping at the directory level.
- In v2.1.22, `finish()` was updated to run an intentional full `snapshot(repo)` at turn settlement to guarantee accuracy. Windows process startup and a full NTFS directory scan share the 1,000 ms budget.

### 3. Inconsistency with footer status timeout

In `killeros/footer.ts`, Git status uses a 5-second timeout:

```typescript
const GIT_STATUS_TIMEOUT_MS = 5_000;
```

The v2.1.22 changelog noted that footer Git scans were expanded to five seconds because shorter intervals timed out on real repositories. However, `killeros/change-receipt.ts` was introduced with a 1,000 ms ceiling.

### 4. Timeout recovery forces another full baseline scan

In `killeros/change-receipt.ts`:

```typescript
} catch (error) {
  discardMonitor(monitor);
  return { state: "unavailable", reason: error instanceof GitFailure ? error.reason : "error" };
}
```

When `finish()` catches a timeout, it executes `discardMonitor(monitor)`. This closes the filesystem watchers and deletes the monitor from `repositoryMonitors`.

On the next turn, `beginChangeReceipt()` must create a monitor from another full `snapshot(repo)` under the same 1,000 ms limit. A repository that consistently exceeds the limit can therefore time out on every turn. The monitor cannot simply be preserved: its snapshot predates the failed turn, so reusing it could attribute old changes to the next turn.

### 5. Overly aggressive user notification for optional telemetry

In `killeros/worked-for.ts` lines 350-354:

```typescript
const changes = await (await settled.collection).finish();
if (changes.state === "unavailable" && changes.reason !== "not-git" && !collectionNoticeShown) {
  collectionNoticeShown = true;
  ctx.ui.notify(`Change receipt unavailable: ${changes.reason}`, "warning");
}
```

While `not-git` is suppressed, `timeout` fires a visible warning toast. The change receipt is an optional end-of-turn display metric with a clean existing fallback (`Changes unavailable`). Timing out during telemetry collection should not trigger an alarm in the user interface.

## Verification

Verified against the v2.1.22 source and history:

- `GIT_TIMEOUT_MS` is 1,000 ms and `runGit()` kills the child when it expires.
- Settlement performs an unconditional full `snapshot(repo)`.
- Any settlement failure discards the repository monitor.
- The next collection rebuilds a missing monitor with another full snapshot.
- `worked-for.ts` warns for `timeout`, while the footer allows Git status five seconds.
- On the current repository, warm scans completed in 60 to 74 ms. A controlled Windows repository with 400,000 untracked files took about 1,001 ms for the same Git status command, crossing the configured limit without repository corruption.

## Acceptance criteria

1. Change-receipt Git operations allow 5,000 ms, matching the footer's existing timeout.
2. A timeout produces the existing inline `Changes unavailable` fallback without a warning notification.
3. Failed settlement does not let a stale baseline leak changes into the next turn. Retain the current discard behavior unless recovery explicitly rebuilds the baseline.
4. Existing non-timeout collection failures keep their current warning behavior.
