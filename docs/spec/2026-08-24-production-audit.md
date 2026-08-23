# Production audit journal

STATUS: ACTIVE

This journal records the solo production-readiness review requested on 2026-08-24. It stays active for the duration of the long-running goal.

## Ground rules in force

- Stay on `dev`; do not create branches or worktrees and do not push.
- Read every repository source, test, workflow, theme, product document, ADR, implemented spec, and local design artifact before changing implementation code.
- Treat Pi activation, teardown, event subscription lifetime, reload behavior, and version compatibility as product behavior.
- Add a focused failing test before each fix or feature, run the full check and test suite, update `CHANGELOG.md`, then commit the verified change.
- Stop periodically to review the resulting diff before continuing.

## Baseline

- Branch: `dev`.
- Worktree at start: clean.
- Tracked files: 56.
- Additional ignored local guidance and design files are present under the repository and are included in this review.
- Runtime contract declared by `package.json`: Node.js 22.19.0+, Pi packages 0.84.2+, TypeBox 1.1.38 through the 1.x line.

## Read progress

- [x] Repository inventory and local `AGENTS.md`
- [x] `CONTEXT.md`
- [x] Package metadata, TypeScript configuration, README, product and design overview
- [x] Existing issue log and architecture decisions
- [x] Complete changelog and release/CI workflows
- [x] Extension entry point and every `killeros/*.ts` module
- [x] Release script
- [x] Every test
- [x] Theme and lockfile
- [x] Implemented specs and local HTML design artifacts
- [x] Pi 0.84.2 loader, runner, session reload, resource invalidation, and interactive UI reset paths

## Findings queue

1. Hook subprocess output and configured command text can reach Pi notifications and block reasons without terminal-control sanitization. A trusted hook can still run an untrusted tool whose output contains escape sequences.
2. Lifecycle behavior is extensively mock-tested but has no proof through Pi's real extension loader and runner. Pi 0.84.2 emits `session_shutdown`, invalidates the old runner, clears the extension import cache, rebuilds registrations, and emits `session_start`; a compatibility test should exercise that contract rather than duplicate it in a fake API.
3. Personal-instruction source paths are interpolated into XML-like prompt metadata without escaping, so unusual workspace paths can alter the injected structure.
4. Settings updates use independent read-modify-write cycles. Concurrent Pi sessions can preserve valid JSON yet silently lose unrelated updates.
5. The packaged consumer boundary is not exercised. Unit tests import the source tree directly and therefore do not prove the npm tarball can be installed and loaded as a Pi extension.
6. Documentation support-floor mismatch: `PRODUCT.md` says Pi 0.84.1+, while package metadata and README say 0.84.2+.

## Pi lifecycle contract observed

- Extension factories register commands, tools, shortcuts, and event handlers into a fresh runner; factories do not return a disposer.
- Reload and session replacement both await `session_shutdown` on the current runner before invalidation.
- Reload clears the resource-loader cache before importing and activating the extension again.
- Interactive mode resets extension-owned UI before reload or session invalidation, including footer, header, widgets, status, editor, and terminal title.
- KillerOS cleanup therefore belongs in `session_shutdown`; process-global state must not be relied upon across module reloads.

## Attempts reverted or deferred

None.

## Verified changes

### Hook failure terminal safety

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes in both a failed `tool_call` hook's Pi notification and its blocking reason.
- Added a public-seam regression through the registered lifecycle handler.
- Sanitized the complete failure diagnostic at its construction boundary so the same safe text reaches every event path.
