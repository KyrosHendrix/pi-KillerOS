# Changelog

All notable changes to KillerOS are documented here.

## [Unreleased]

### Fixed

- Prevented direct tag pushes from publishing commits that have not passed CI on `main`.
- Kept oversized hook payloads valid JSON and marked their bounded preview as truncated.
- Stripped terminal escape sequences and unsafe controls from model-controlled question and goal text.
- Aligned hook timeout validation and execution on the documented five-minute maximum.
- Required file-backed goals to create or change their deliverable after the goal starts, including after session restore.

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
