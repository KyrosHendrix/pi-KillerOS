# Changelog

All notable changes to KillerOS are documented here.

## [1.4.1] - 2026-08-01

### Added

- Added per-invocation child model selection and separate thinking-effort controls, with visible `inherit` placeholders in every bundled role.
- Added focused `debugger`, `documenter`, `security`, and `tester` roles with explicit access boundaries, skill discovery, and web research guidance.
- Added child web research through the separately installed `pi-web-access` package and exposed search, source-check, fetch, and stored-content tools to every bundled role.

### Fixed

- Made child timeout and forced-termination fallbacks settle even when no other event-loop handles remain.
- Kept streamed child thinking within the retained trace budget without terminating successful invocations.
- Preserved model IDs containing colons and validated thinking levels through Pi's model capabilities, including models that do not support `off`.
- Bounded unterminated JSONL lines while preserving fragmented UTF-8 handling.

### Changed

- Expanded the bundled role roster while keeping read-only auditors separate from write-capable implementation roles.
- Hardened CI with Node floor/LTS checks, locked-dependency auditing, dependency review, package-content validation, and CodeQL analysis.

## [1.4.0] - 2026-08-01

### Added

- Pi-native `subagent` tool with isolated JSONL child processes, single/parallel/chain modes, streamed TUI status, aggregate usage, and abort propagation.
- Bundled Markdown roles for read-only scouting, planning, and review plus one serialized write-capable worker.
- Strict role, tool, model, trust, precedence, concurrency, turn, timeout, trace, stderr, and output enforcement.

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
- Standardized product branding on mixed-case `KillerOS` and the neutral `› KillerOS (v1.2.0)` lockup.
- Made theme neutrals achromatic while preserving the coral accent.
- Replaced the footer progress bar with direct `percent left (tokens)` context telemetry and a critical `/compact` prompt.
