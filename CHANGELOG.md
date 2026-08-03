# Changelog

All notable changes to KillerOS are documented here.

## [Unreleased]

### Fixed

- Resolved bundled subagent role discovery from the package `agents/` directory; the module-relative path broke when subagent modules moved under `killeros/` in v1.5.0, leaving fresh installs with `Unknown subagent "<role>". Available: none`.

## [1.5.0] - 2026-08-03

### Changed

- Split the main extension into feature modules under `killeros/` while keeping `Killeros.ts` as the stable entry point.
- Moved subagent modules under `killeros/` and kept root re-export files for existing deep imports.

### Fixed

- Hardened the subagent schema and runtime checks with action-specific request shapes.
- Invalid fields now fail before role discovery, project confirmation, thread creation, or child launch.
- The TUI no longer shows parallel schedules for malformed subagent requests.
- Kept valid single, parallel, chain, lifecycle, steering, interruption, collection, and closure behavior unchanged.

## [1.4.9] - 2026-08-02

### Changed

- Parallel batches with write-capable roles now use one shared slot by default; `writerConcurrency` above `1` opts into concurrent shared-worktree writes only when path ownership is proven. Reader-only batches reject `writerConcurrency` because it does not apply.
- Added an 8 MiB ceiling for one child JSONL record, bounded thread retention with inspectable tombstones, and scoped atomic `/init` reads and writes.

## [1.4.7] - 2026-08-01

### Fixed

- Serialized every write-capable task in a parallel batch in input order instead of rejecting batches with multiple writers.
- Added opt-in `writerConcurrency` scheduling for independent batches while keeping serialization as the safe default and documenting shared-worktree conflict responsibility.
- Parent tool-call aborts now settle only queued tasks; active children finish naturally, and session directories remain until child exit is confirmed.
- Settled queued tasks on interrupted parallel batches and documented the shared-worktree execution model.
- Restricted the `message` parameter to `action: "steer"` and added focused regression coverage.

## [1.4.6] - 2026-08-01

### Fixed

- Made the registered task schema use the same ten-task limit as runtime validation.
- Kept one isolated Pi session ID and session directory across steering restarts so a child retains its conversation.
- Bound retained trace, stderr, and returned text, and spooled large JSONL lines to temporary storage without stopping the child or reporting a retention cutoff as `limited`.
- Kept explicit embedding resource guards and user stops visible as terminal states.

## [1.4.5] - 2026-08-01

### Fixed

- Removed the child-budget extension, its read-tool budget, and the default 250,000-token/$5 quota.
- Removed default child wall-time, trace, stderr, returned-output, and model-output-length stops; role `timeoutMs` and other child guards are opt-in, while the parser retains a finite JSONL-record ceiling.
- Removed forced early-report prompt text so roles can finish their assigned work naturally.
- Treat model stop reason `length` as a completed child process instead of inventing a KillerOS `limited` result.
- Documented the child lifecycle contract: children complete naturally; explicit user interruptions, configured guards, and real child-process failures remain visible.

## [1.4.3] - 2026-08-01

### Fixed

- Added child-runtime tool budgets for read-only roles, with a soft finalization nudge and hard blocking for read and web tools after 32 calls.
- Added bounded child report instructions and kept read-tool budgets cumulative across steering restarts.
- Lowered the default child quota to 250,000 tokens and $5, and exposed child tool-call counts in results.

## [1.4.2] - 2026-08-01

### Added

- Added named child threads with inspectable lifecycle state, Active/Done views, steering, interruption, collection, and closure controls.
- Added isolated child-process resource guards for wall time, JSONL lines, retained trace, stderr, output, token quota, cost quota, task count, and concurrency.

### Changed

- Replaced routine child turn limits with natural completion plus named resource guards.
- Preserved partial traces and handoffs when a child fails, stops, or reaches a limit.

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
- Standardized product branding on mixed-case `KillerOS` and the neutral lockup used in the v1.2.0 release.
- Made theme neutrals achromatic while preserving the coral accent.
- Replaced the footer progress bar with direct `percent left (tokens)` context telemetry and a critical `/compact` prompt.
