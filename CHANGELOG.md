# Changelog

All notable changes to KillerOS are documented here.

## [Unreleased]

### Fixed

- Stripped sentence punctuation from unquoted inferred goal paths and picked token units after rounding so 999.6 shows as 1k and 999999 as 1M.
- Increased change-receipt Git timeouts to five seconds and stopped timeout failures from showing warning notifications.

## [2.1.22] - 2026-09-03

### Added

- Added named goal completion checks, per-goal turn limits, and branch-aware `/goal history`.
- Added per-response TUI receipts for net Git changes and recognized verification results.

### Changed

- Defaulted new goals to 20 turns, added safe `/goal checks` discovery, preserved blocker evidence in history, and separated pure goal parsing and history formatting.
- Refreshed footer Git telemetry from throttled filesystem changes instead of every completed turn, while retaining branch and 30-second fallback scans.

### Fixed

- Prevented Linux CI test workers from waiting indefinitely on extension-owned handles after their tests finish.
- Made change receipts use a final repository scan, disable current Git filters, report line-ending-only edits, and recheck file goals after completion commands.
- Released automatic-compaction request state when Pi rejects an ordinary continuation before accepting its hidden message.
- Resumed ordinary tasks exactly once after automatic compaction and interrupted-turn settlement, keeping the hidden continuation pending until Pi accepts it.
- Allowed Git footer scans up to five seconds, contained rejected refreshes, and kept the last successful file-change status after transient failures.
- Recorded only exact check commands in response receipts, replaced verification claims with observed-check copy, and reserved `/goal` command words so malformed controls cannot start objectives.
- Rejected unsafe persisted goal counters, contained file-verification inference errors, and prevented stale completion checks from completing a newly restored goal.
- Kept lifecycle hooks stable for corrupt payload serialization, `NaN` direct timeouts, abort races, stream errors, and synchronous process completion without tightening custom process adapter contracts.

## [2.0.22] - 2026-08-30

### Changed

- Replaced the footer's changed-file total with a colored modified, added, and deleted breakdown.

### Fixed

- Preserved the existing `createGitStatusRefresh` changed-file count callback contract.
- Rejected linked `AGENTS.local.md` files before reading personal instructions.
- Confirmed Windows hook process-tree cleanup before settling cancellations and timeouts, even when `taskkill` is absent from `PATH`.

## [2.0.21] - 2026-08-29

### Changed

- Bounded goal verification and Pi compatibility, reduced Git status polling, reserved handoff context, and separated goal state and question UI logic.
- Blocked moderate dependency advisories in CI and updated TypeBox within the supported 1.x line.
- Preserved seconds in footer and goal elapsed times after one minute.
- Added a muted top border to the prompt editor.
- Colored the footer workspace path `#F0F89A`.
- Added a live changed-file count beside the Git branch when the worktree is dirty.
- Synced `dev` back to successful `main` releases after publishing.

### Fixed

- Kept likely secrets out of `/init`, restricted personal-instruction imports to Pi's agent directory, and replaced injectable handoff framing with validated JSON.
- Hardened releases against stale CI runs, mismatched existing npm artifacts, and tag conflicts discovered after publication.

## [2.0.20] - 2026-08-25

### Changed

- Added a typescript-eslint type-checked lint gate (`npm run lint`) alongside `tsc --noEmit`, and cleaned up the dead imports and untyped boundaries it surfaced.

### Fixed

- Treated Pi's exact `Nothing to compact (session too small)` rejection as an expected automatic-compaction skip: no failure notification, silent retry on the next eligible turn, and active goals resume through a dedicated skip recovery instead of pausing for `/goal resume`.
- Made `/handoff` resilient to an unreadable `killeros.json`: explicit `KillerosOptions` budgets bypass the file, while other summaries fall back to the default budget with a visible warning.
- Named `/handoff` output truncation instead of reporting "did not finish", raised the default summary budget to 8192 tokens for reasoning models, and made the budget configurable through `KillerosOptions` or the `killeros.json` `handoffMaxTokens` key.

## [2.0.19] - 2026-08-24

### Changed

- Hardened JSON and caught-error boundaries, made goal and `/init` target states constructive, added exhaustive outcome handling, and replaced unsafe test doubles with checked adapters.
- Deprecated positional `executeHook` arguments in favor of object options; the compatibility adapter will be removed in the next major release.

### Fixed

- Paused active goals during automatic compaction and resumed the exact paused revision once after compaction and turn settlement succeed.
- Restored active goals saved by v2.0.18 shutdown checkpoints that omitted their stopped clock timestamp.

## [2.0.18] - 2026-08-24

### Added

- Added a real Pi SDK lifecycle test for package activation, shutdown-before-reload, fresh registration, and stale-context rejection.

### Changed

- Raised the locked Pi development packages and minimum supported Pi peer version to 0.84.3.
- Made Pi lifecycle compatibility coverage install the generated npm tarball offline before activation and reload.

### Fixed

- Preserved provider-managed OAuth routing during `/handoff`, fixing GitHub Copilot `421 Misdirected Request` failures.
- Repaired incompatible process-global `/codex-fast` state during extension updates while preserving a valid saved enabled flag.
- Stopped lifecycle-hook failures from echoing configured shell commands, which could expose inline credentials in Pi diagnostics.
- Kept lifecycle-hook configuration paths terminal-safe and single-line in warnings.
- Limited trusted lifecycle-hook configuration to a 64 KiB regular, non-linked file in the project's real `.pi` directory and verified the opened file identity before parsing it.
- Sanitized dynamic slash-command descriptions and omitted unsafe command names from KillerOS autocomplete.
- Rejected explicit file goals when their starting filesystem baseline cannot be inspected instead of treating every error as a missing file.
- Kept custom model and provider labels single-line and terminal-safe in the shell header and footer.
- Sanitized model-reported `/init` policy conflicts before returning, storing, or notifying with them.
- Kept session-storage failure details terminal-safe when an explicit goal pause falls back to in-memory state.
- Stripped terminal commands and unsafe controls from saved goal objectives before clear confirmations.
- Kept rejected `/variants` arguments terminal-safe and single-line in error notifications.
- Kept provider and model identifiers terminal-safe and single-line throughout `/variants`.
- Flushed partial UTF-8 lifecycle-hook output on process close instead of silently dropping final diagnostic bytes.
- Contained synchronous lifecycle-hook process-start failures inside normal hook failure handling.
- Kept header and footer paths single-line and terminal-safe for unusual cwd or home-directory names.
- Sanitized manual-compaction abort diagnostics before saving recovery-eligible goal state.
- Stripped terminal commands and unsafe controls from saved goal text before showing status panels or notifications.
- Sanitized provider and storage diagnostics before persisting or announcing an automatically paused goal.
- Routed handoff generation and session-replacement failures through the shared terminal-safe error reporter.
- Stripped terminal commands and unsafe control bytes from caught errors before showing KillerOS failure notifications.
- Stripped terminal commands and control bytes from cwd and session names before emitting the KillerOS terminal title.
- Removed filesystem source paths from personal-instruction prompt wrappers so unusual project paths cannot alter prompt structure.
- Stripped terminal commands and unsafe control bytes from lifecycle hook failure notifications and tool block reasons.

## [2.0.17] - 2026-08-23

### Added

- Added per-task token usage to settled TUI receipts for ordinary requests and individual goal turns.

### Changed

- Limited push CI to `main` and `dev`; feature branches run through pull request CI without duplicate push runs.
- Removed obsolete Pi tool API casts, shared caught-error formatting, and expanded the non-repeating startup tip and editor suggestion banks.
- Clarified that the README's pinned Git tag is an example rather than the current package version.

### Fixed

- Limited retired-feature repository checks to tracked and non-ignored files so ignored private notes cannot fail the suite.

## [2.0.16] - 2026-08-23

### Fixed

- Kept `/handoff` input inside a cancellable TUI loader so buffered editor text cannot cross the session boundary.
- Prevented a cancelled handoff from starting provider completion when authentication resolves late.
- Made repository contract tests validate README facts without depending on discarded prose.

## [2.0.15] - 2026-08-23

### Added

- Added `/handoff [focus]` for fresh linked sessions with visible continuation context.

### Fixed

- Compared pre-existing goal deliverables by content instead of file size and modification time.
- Made `/init` evidence directory listing follow case-insensitive Windows path semantics.
- Kept the interactive question component within a zero-row terminal height.

## [2.0.14] - 2026-08-22

### Fixed

- Prevented direct tag pushes from publishing commits that have not passed CI on `main`.
- Kept oversized hook payloads valid JSON and marked their bounded preview as truncated.
- Stripped terminal escape sequences and unsafe controls from model-controlled question and goal text.
- Aligned hook timeout validation and execution on the documented five-minute maximum.
- Required file-backed goals to create or change their deliverable after the goal starts, including after session restore.
- Removed a CI test dependency on an intentionally untracked internal document.

## [2.0.13] - 2026-08-21

### Added

- Added the process-local bare `/codex-fast` toggle for Codex priority requests, with a bold inline `Fast` footer indicator while an active Codex model uses it.

### Changed

- Converted all tracked test suites from JavaScript to strict TypeScript while keeping Node's built-in test runner.

## [2.0.12] - 2026-08-18

### Fixed

- Resumed active goals exactly once after Pi reports automatic compaction complete.

## [2.0.11] - 2026-08-17

### Fixed

- Made automated npm publication and GitHub release recovery idempotent, aligned the documented and tested Pi floor, and made machine-identifier casing locale-independent.
- Extended strict type checking to release scripts and typed test suites, while correctly identifying JavaScript-only suites as `.js`.

### Removed

- Removed the decision-gated workflow subsystem, its skill-specific policy, public extension interface, and YAML dependency. Skills now remain instruction-only.

## [2.0.10] - 2026-08-16

### Added

- Added proactive turn-boundary compaction with Pi-owned settings and safe continuation for ordinary prompts and active goals.
- Added reusable multi-activation decision-gated workflow registrations while preserving exact-match behavior.

## [2.0.9] - 2026-08-15

### Added

- Highlighted exact, currently registered slash commands in the TUI editor with the theme's shared command-blue link role while preserving autocomplete boundaries and ANSI cursor styling.

## [2.0.8] - 2026-08-15

### Added

- Added a reusable, opt-in pre-turn gate for explicitly activated decision-gated workflows. It opens the shared structured question UI before skill expansion, keeps the selected policy active, blocks unknown and disallowed tools, and clears safely across lifecycle boundaries.
- Added a disposable decision-gated workflow fixture and focused coverage for activation ordering, pending safety, policy allowlists, lifecycle cleanup, adapter reuse, and Pi 0.84.2 compatibility.

### Removed

- Removed KillerOS's always-on concise response policy and provider-specific concise defaults; Pi now owns response-style guidance.

### Changed

- Raised the locked direct Pi development packages to 0.84.2 while keeping the peer dependency floor at 0.84.1.

## [2.0.7] - 2026-08-13

### Changed

- Raised the supported and locked Pi baseline from 0.82.1 to the current matched 0.84.1 AI, coding-agent, and TUI packages.
- Added a compact two-deck footer beneath the prompt and removed the work-trail widget.
- Replaced the framed prompt and shuffled activity verbs with a focus-aware single-arrow editor and event-derived working copy.
- Made settled timing entries report `Done`, `Stopped`, or `Failed` while keeping existing `Worked for` history readable.

### Fixed

- Separated response output from the prompt editor while keeping footer telemetry close beneath a quiet muted divider.
- Kept `/variants` within the active terminal height, preserved the focused reasoning level across resizes, and initially focused the current level.
- Rendered `/variants` controls from the same Pi keybinding manager that handles input, including installations with separate package module instances.
- Rendered active, paused, and blocked `/goal` status text consistently in the footer's far-right slot.
- Kept the private goal-update tool inactive outside active `/goal` runs and rendered its real execution errors instead of malformed blocker-audit fields.
- Verified exact persisted paths for clearly declared file-deliverable goals before completion, while preserving model-reported completion for general objectives.
- Accepted explicit `1`/`1` bounds for single-select questions and applied the same bounds validation before rendering and execution.
- Prevented reload and branch navigation from preserving or reconstructing stale manual-compaction recovery eligibility; only Pi's live event in the current session can resume the interrupted goal safely.
- Restricted goal deliverable verification to explicit destination phrases so source and reference paths cannot be reported as completed output.
- Kept saved goals fully inactive in print and JSON modes, including the private update tool and shutdown checkpoints.
- Rejected concurrent `/init` starts during preflight, cancelled pending preflight work on shutdown, and settled active `/init` command handlers when their session closes.

## [2.0.6] - 2026-08-11

### Added

- Added a durable `✻ Worked for …` transcript line below each settled TUI response, including stopped and failed runs.
- Added optional multi-select to the `question` tool with bounded checked options, one additive custom answer, a dedicated multi-word filter editor, and compact expandable results while preserving single-select defaults.

### Changed

- Automated GitHub releases after successful `main` CI version bumps, with package, lockfile, changelog, tag, and verified-commit checks plus a manual tag recovery path.

### Fixed

- Entered automatic `/goal` continuations into durable goal-turn state before dispatch so turn numbers advance and blocker audits work on Pi custom-message turns.

## [2.0.5] - 2026-08-11

### Added

- Added shuffled session-stable suggestions to the empty three-line prompt editor.

### Fixed

- Preserved complete UTF-8 characters in truncated `/init` evidence and chunked lifecycle-hook output, and kept filesystem-root paths visible in notification titles.
- Kept the startup-tip shuffle deck across session rebinds so every tip appears before the bank repeats.
- Rejected matchers on `agent_settled` lifecycle hooks instead of silently bypassing their tool-name guard.
- Made the goal update status schema compatible with Google models while preserving strict completion and blocking values.
- Kept multiline custom-answer drafts within tiny terminal row limits by rendering a clipped single-line preview.
- Preserved existing spaces and tabs after the cursor when applying slash-command autocomplete.
- Made `/init` abort safely when Git ignore inspection fails or returns untrusted output, preventing ignored files from entering model evidence.
- Wrapped long interactive questions to the current terminal width while keeping the question UI within the terminal height.
- Made `/goal pause` and `/goal clear` save terminal state before immediately stopping active goal work.
- Kept failed goal edits and replacements visible and fail-closed without restarting a stale objective.
- Required one durable blocker key on three consecutive goal turns before a goal can be marked blocked.

## [2.0.4] - 2026-08-10

### Changed

- Rebuilt `/init` around a packaged four-section guideline-synthesis workflow that preserves compatible root policy without requiring an external skill.
- Removed live blue slash-command coloring while retaining slash autocomplete, the framed multiline editor, and Shift+Enter.

### Fixed

- Prevented `/init` from reading Git-ignored files, known secrets, private keys, linked or non-regular files, other guidance, dependencies, and files outside its frozen evidence map.
- Protected root `AGENTS.md` from concurrent replacement and reported incompatible policy conflicts without writing.
- Made `/clear` confirm before aborting active work, wait for settlement, and then start the new session.
- Preserved explicit Responses API verbosity and reasoning-summary settings while applying concise defaults only to absent fields.
- Cancelled lifecycle hook process trees with bounded cleanup when Pi aborts the parent request.
- Kept `/init` middleware from freezing shared tool input and preserved custom editors installed by other extensions.
- Removed private Pi editor-state access in favor of public rendering contracts.

## [2.0.3] - 2026-08-09

### Added

- Added an opt-in global completion sound with `/notification` and an enabled-state Nerd Font bell in the terminal tab title.
- Moved active goal status to the footer's right side in warning yellow, replacing the path with `/goal is active (...)` and exact seconds.

### Changed

- Returned compaction timing, summary generation, manual instructions, retries, file tracking, and overflow recovery to Pi's public lifecycle.
- Continued active goals only after Pi reaches its settled boundary and preserved `/goal` as the sole durable objective and status owner.

### Fixed

- Added fail-closed, revision-bound recovery after successful manual compaction, including reload and branch navigation recovery without reviving stale or explicitly paused goals.
- Rendered question help from the effective selector keybindings across supported Pi versions.

## [2.0.2] - 2026-08-08

### Changed

- Replaced the static activity Spark with a 12-frame orange glyph loop at 120 ms per frame.
- Styled activity verbs orange and added the gray `(esc to interrupt · thinking)` status with bold `esc`.

## [2.0.1] - 2026-08-08

### Added

- Added a height-bounded question viewport with configured Pi controls, progress labels, and compact expandable history.
- Added an interactive `/goal` status and actions panel in TUI mode.
- Added live command-blue highlighting for recognized slash command prefixes in the prompt editor.

### Changed

- Made reasoning colors contrast-safe, moved commands and links to the themed command-blue role, and changed activity to a static Spark with shuffled 2.5-second verb updates.
- Reserved footer goal status for active, paused, and blocked work; completed goals remain in history and `/goal` status.
- Made startup Git lookup asynchronous, cached footer session cost between content changes, and aligned the browser visual reference with v2.0.1 runtime behavior.

## [2.0.0] - 2026-08-07

### Changed

- Focused the package, runtime, tests, and documentation on KillerOS's current TUI, repository initialization, long-running goals, reasoning controls, interactive questions, command aliases, and concise-response guidance.

## [1.5.8] - 2026-08-07

### Fixed

- Bounded question filter input to 4,000 characters and 16,000 UTF-8 bytes, with a clear rejection notice for excess input.
- Reported goal start, resume, and edit success only after continuation dispatch succeeded, and paused the goal when dispatch failed.

## [1.5.5] - 2026-08-05

### Changed

- Replaced default deterministic context compaction with model-backed summaries at 40% remaining context, preserved manual focus prompts, and disclosed deterministic fallback after model retries fail.

### Fixed

- Overrode vulnerable transitive `brace-expansion` and `undici` versions with patched releases in the development and CI install tree.

## [1.5.4] - 2026-08-04

### Fixed

- Added guarded automatic context compaction at 30% remaining, with structured summaries and goal continuation after the compaction is saved.

## [1.5.3] - 2026-08-03

### Fixed

- Made `/exit` abort an active run before requesting Pi's graceful shutdown.

## [1.5.2] - 2026-08-03

### Changed

- Hardened always-on concise guidance around low-friction action, visible multi-turn state, evidence-backed outcomes, material ambiguity, diagnostic resets, and explicit safety and correctness precedence.

## [1.5.1] - 2026-08-03

### Changed

- Added a fixed pragmatic response style, low GPT-5 Responses API verbosity, and concise reasoning summaries without changing reasoning effort.

### Fixed

- Scoped native concise settings to supported Responses APIs while leaving completion and unrelated provider payloads unchanged.

## [1.5.0] - 2026-08-03

### Changed

- Split the main extension into feature modules under `killeros/` while keeping `Killeros.ts` as the stable entry point.

## [1.4.9] - 2026-08-02

### Changed

- Scoped atomic `/init` reads and writes.

## [1.4.1] - 2026-08-01

### Changed

- Hardened CI with Node floor/LTS checks, locked-dependency auditing, dependency review, package-content validation, and CodeQL analysis.

## [1.3.0] - 2026-07-31

### Added

- Claude Code-style `/init` that builds a bounded repository snapshot and generates a concise root `AGENTS.md` with one controlled write.
- Codex-style `/goal` with durable branch-scoped state, automatic one-turn continuation, pause/resume/edit/clear controls, and explicit model-reported completion or blocking.
- Trusted `AGENTS.local.md` personal guidance and project lifecycle hooks for tool-call, tool-result, and settled-agent events.
- Focused coverage for goal transitions, recovery paths, branch restoration, mode gating, footer cutdowns, and repository initialization safeguards.

### Changed

- Extended the responsive footer with goal activity and terminal states while preserving context pressure at narrow widths.
- Hardened `/init` and `/goal` failure handling so interrupted work, provider errors, failed writes, and failed continuation starts stop safely.

## [1.2.0] - 2026-07-30

### Added

- A 52-column Compact startup card with inline version, polished model/provider identity, reasoning level, `/model`, working directory, and conditional Git branch.
- A shuffled startup-tip deck that keeps one tip stable per session and exhausts the bank before repeating.
- A responsive footer that preserves model and context while progressively removing lower-priority telemetry.
- Packaged KillerOS theme with coral accents and one neutral tool-call surface across pending, success, and error states.
- Single-glyph Spark activity indicator with a restrained color pulse.
- Claude-adjacent activity word bank that advances between agent runs.
- Static `└ Thinking…` label for hidden reasoning blocks.
- Responsive header and footer tests across narrow terminal widths.

### Changed

- Replaced the animated startup illustration and capability inventory with the Compact startup card and one external tip.
- Standardized product branding on mixed-case `KillerOS` and the neutral lockup used in the v1.2.0 release.
- Made theme neutrals achromatic while preserving the coral accent.
- Replaced the footer progress bar with direct `percent left (tokens)` context telemetry and a critical `/compact` prompt.
