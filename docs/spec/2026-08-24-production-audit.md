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
7. Caught errors routed through the shared user-facing formatter retain terminal commands and unsafe control bytes.
8. Manual-compaction abort state retains raw provider diagnostics even though current goal renderers and status summaries sanitize their terminal output.
9. Header and footer cwd formatting sends an unusual project path to Pi's terminal renderer without control-byte sanitization.
10. A synchronous hook process-start exception rejects `executeHook` and bypasses the normal failure result, tool block, and Pi notification path.
11. Hook output uses incremental UTF-8 decoders but never finalizes them, silently dropping an incomplete final byte sequence after close or forced settlement.
12. Custom provider and model identifiers reach `/variants` notifications and its selector model row without terminal-control sanitization.
13. An unknown `/variants` argument is echoed into an error notification without terminal-control sanitization.
14. The `/goal` action panel sends a stored objective directly into the clear-confirmation body even though its status title uses a safe formatter.
15. Explicit goal-pause fallback sanitizes its stored failure reason but later notifies with the original unsafe storage-error message.
16. The model-authored `/init` policy-conflict reason reaches tool output, runtime state, and a Pi warning without terminal-control sanitization.
17. Custom model names, IDs, and provider identifiers render raw in the shared shell header/footer formatter.
18. Goal file-baseline capture treats every `lstat` failure as a missing deliverable, allowing unverifiable starts and bypassing the command's error boundary.
19. Slash-command names and descriptions from other extensions, prompts, skills, and fallback providers are re-rendered raw by KillerOS autocomplete.

## Pi lifecycle contract observed

- Extension factories register commands, tools, shortcuts, and event handlers into a fresh runner; factories do not return a disposer.
- Reload and session replacement both await `session_shutdown` on the current runner before invalidation.
- Reload clears the resource-loader cache before importing and activating the extension again.
- Interactive mode resets extension-owned UI before reload or session invalidation, including footer, header, widgets, status, editor, and terminal title.
- KillerOS cleanup therefore belongs in `session_shutdown`; process-global state must not be relied upon across module reloads.

## Attempts reverted or deferred

- Deferred cross-process locking for `killeros.json`: completion sound is currently the only programmatic writer and all sessions update the same key, while auto-compaction is read-only. Add coordination when a second independently writable setting exists rather than shipping crash-recovery lock machinery speculatively.
- Reverted a product-floor contract because `PRODUCT.md` is intentionally ignored and untracked; a test that reads it would pass locally but fail in clean checkouts. Keep shipped compatibility claims bound to tracked package metadata and README instead of adding a dependency on a private design document.
- Deferred hook config-path warning coverage: Windows cannot create the control-byte path needed for the public seam, and exporting a display helper only for this test would add API surface. Keep the issue queued for platform-backed coverage rather than shipping an unproved patch.

## Verified changes

### Hook failure terminal safety

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes in both a failed `tool_call` hook's Pi notification and its blocking reason.
- Added a public-seam regression through the registered lifecycle handler.
- Sanitized the complete failure diagnostic at its construction boundary so the same safe text reaches every event path.

### Pi extension lifecycle compatibility

- Exercised the package manifest through Pi's public `DefaultResourceLoader` and `createAgentSession` APIs in an isolated project and agent home.
- Verified activation has no loader or lifecycle errors, both lifecycle handlers exist, command registration is unique, reload replaces the runner, the old context becomes stale, and the fresh runner preserves the command contract without diagnostics.
- Kept the test on public Pi exports so the existing pinned-floor/latest CI matrix now detects incompatible Pi lifecycle changes.

### Personal-instruction source metadata

- Confirmed that both ordinary and goal-continuation prompt wrappers interpolated the resolved filesystem path into XML-like metadata.
- Removed the undocumented source attribute and its data plumbing instead of maintaining a custom escaping layer.
- Centralized the source-free block in `resolvePersonalInstructions`, preserving trust checks, imports, fallback content, and bounded UTF-8 reads for both callers.

### Terminal title safety

- Traced Pi 0.84.2's title implementation to a raw `OSC 0;...BEL` write with no host escaping.
- Reproduced cwd and session-name injection of OSC, BEL, NUL, and line-feed bytes through `formatNotificationTitle`.
- Reused the shared terminal sanitizer at the title formatter and removed the remaining line feeds before any title reaches Pi.

### Caught-error terminal safety

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes in a completion-sound settings failure notification.
- Sanitized unknown caught values once in the shared `errorMessage` formatter, covering auto-compaction, settings, notification playback, worked-for persistence, and general reported failures.

### Handoff error reporting

- Reproduced terminal-command injection from a provider exception during `/handoff` summary generation.
- Deleted the command's duplicate raw-error reporter and routed summary, destination setup, and session replacement failures through the shared terminal-safe reporter.

### Goal failure diagnostics

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes in a provider failure that automatically pauses an active goal.
- Sanitized the reason once before both normal persistence and the in-memory persistence fallback, then reused the same safe value in the pause notification.

### Goal status summaries

- Reproduced terminal-command injection from restored objective and completion-result text in the `/goal` action panel.
- Sanitized the complete status summary at its TUI/RPC output boundary, preserving its intentional line breaks and covering legacy state without rewriting session history.

### Manual-compaction pause state

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes in recovery-eligible goal state after an aborted provider turn.
- Sanitized the abort reason before normal or fallback persistence while leaving the static manual-compaction recovery notification unchanged.

### Header and footer path safety

- Reproduced OSC title injection, ANSI styling, BEL, NUL, and line-feed bytes through the shared cwd display formatter used by both shell header and footer.
- Sanitized cwd and home values before abbreviation and removed line feeds to preserve the formatter's single-line layout contract.

### Packaged consumer lifecycle

- Replaced source-directory activation in the Pi lifecycle contract with an actual `npm pack` tarball installed into an isolated local consumer without scripts, network access, or peer auto-installation.
- Verified the installed tarball contains its TypeScript entry point and theme, then activates and reloads through Pi using the repository's pinned peer runtime.

### Hook process-start failures

- Reproduced a synchronous spawner exception escaping `executeHook` instead of becoming a nonzero hook result.
- Moved process start ahead of the event-wait promise and converted start exceptions through the shared safe error formatter, preserving normal caller blocking and notification behavior.

### Hook output finalization

- Reproduced an incomplete final UTF-8 sequence disappearing from captured hook stderr when the process closed.
- Finalized both incremental decoders exactly once during settlement, preserving complete split characters and representing incomplete trailing bytes without reading beyond the existing byte capture bound.

### Variants model metadata

- Reproduced OSC title injection, ANSI styling, BEL, NUL, and line-feed bytes from custom provider/model identifiers in an unsupported-level notification.
- Sanitized the combined model label once and enforced its single-line contract, covering both notification paths and the interactive selector row.

### Variants argument errors

- Reproduced OSC title injection, ANSI styling, BEL, NUL, and line-feed bytes from an unknown reasoning-level argument echoed into a Pi error notification.
- Sanitized only the rejected display value, preserving the command's existing strict argument resolution while keeping error output single-line.

### Goal clear confirmation

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes from a stored objective in the `/goal` clear-confirmation body.
- Sanitized only the Pi confirmation sink so persisted objectives and model continuation semantics remain unchanged.

### Goal pause persistence errors

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes from a session-storage exception in the deferred explicit-pause notification.
- Sanitized the local fallback reason once so both in-memory state and its post-stop Pi notification use the same safe text.

### Init policy-conflict output

- Reproduced OSC title injection, ANSI styling, BEL, and NUL bytes from the model-authored conflict reason in `/init` tool output before settlement.
- Sanitized once at tool ingestion so its result content, result details, stored outcome, and final Pi warning share the same safe text.

### Shell model metadata

- Reproduced OSC title injection, ANSI styling, BEL, NUL, and line-feed bytes from custom model/provider metadata in a footer row.
- Sanitized the shared model formatter so both shell header and footer receive single-line labels, retaining name-to-ID fallback and adding a safe empty-label fallback.

### Goal file baseline errors

- Reproduced a non-I/O path failure being persisted as an absent-file baseline and immediately dispatching the first goal turn.
- Classified only `ENOENT` as absent and moved baseline inference inside the existing start/replacement error boundary, so other filesystem failures are contained without dispatch.

### Slash autocomplete metadata

- Confirmed Pi accepts extension command names without validation and reproduced terminal controls in extension and fallback descriptions returned by KillerOS autocomplete.
- Rejected names whose safe form differs or cannot be invoked as one slash token, and sanitized descriptions once when building the shared command catalog.

### 20. Executable hook configuration followed links and had no size bound

- `loadKillerosHooks` passed `.pi/killeros-hooks.json` directly to `readFileSync`, following symbolic or hard links and allowing an arbitrarily large file to be read before parsing.
- This file is a code-execution boundary: accepted commands run in the real Pi session with the user's permissions after project trust is granted.
- A linked config can make the reviewed project-local path refer to separately managed content, while an unbounded read creates avoidable memory exposure during session activation.

### Hook configuration file boundary

- Added regressions proving that a hard-linked config, a config reached through a linked `.pi` directory, and a valid JSON config larger than 64 KiB cannot execute their commands.
- Replaced the unbounded path read with a fixed-size descriptor read, requiring the canonical project-local path, a regular file with one link, and matching device/inode identity after opening.
- Documented the public 64 KiB regular, non-linked configuration contract in the README.

### 21. Hook failures exposed configured shell commands

- `hookFailureMessage` copied the complete configured command into tool-block reasons and Pi error notifications.
- Commands can contain inline credentials or other private values, so a failing hook could unnecessarily disclose them to the model transcript and terminal history.

### Hook command confidentiality

- Added a regression with an inline secret proving the failure still blocks the tool and reports sanitized stderr without returning the configured command.
- Removed command text from the shared failure formatter while preserving timeout, uncertain-exit, stderr/stdout, and exit-code diagnostics.
