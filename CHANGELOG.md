# Changelog

All notable changes to KillerOS are documented here.

## [Unreleased]

## [1.5.5] - 2026-08-05

### Added

- Added live background subagent progress with queued, running, and completed states plus per-child and batch usage.
- Added inline subagent roles for single, parallel, and chain spawns, bounded their tools to those active for the parent, and kept them scoped to one non-resumable spawn.
- Added `message` as a single-spawn task alias and visible fallback to `worker` for unknown named roles.

### Changed

- Replaced default deterministic context compaction with model-backed summaries at 40% remaining context, preserved manual focus prompts, and disclosed deterministic fallback after model retries fail.

### Fixed

- Warned when a settled or failed background subagent handoff cannot reach the parent and pointed users to `list` and `collect` for recovery.
- Overrode vulnerable transitive `brace-expansion` and `undici` versions with patched releases in the development and CI install tree.

## [1.5.4] - 2026-08-04

### Added

- Added named child sessions with `wait` and `resume`, persisted lifecycle records, real `/subagents` controls, empty-response failure, a 30-minute default wall time, bounded process-exit cleanup, and serialized shared-worktree writers.

### Fixed

- Added guarded automatic context compaction at 30% remaining, with structured summaries and goal continuation after the compaction is saved.
- Kept the parent-facing cancellation reason when a steer was already in flight: aborting the parent turn after a steer now reports `abort` on the settled thread and result and no longer triggers a replacement follow-up turn for the cancelled batch.
- Isolated host update callbacks in child-process and tool telemetry paths so a throwing callback cannot crash the host, strand the result promise, or fail a settled batch.
- Rejected steering explicitly once 20 messages are pending for a thread instead of silently dropping the oldest steers; task-size overflow is also rejected before mutation, and bounded steering history keeps the earliest messages.
- `interrupt all` now also stops queued children of the batch, matching `interrupt` on one thread and parent-turn abort, so queued writers cannot run after a stop command.
- Recreated the subagent thread registry on `session_start`, stopped old children, and fenced old callbacks so embedding hosts that keep the extension instance between sessions can still spawn children without stale follow-ups.

## [1.5.3] - 2026-08-03

### Fixed

- Returned spawned thread IDs immediately and delivered completed handoffs as Pi follow-ups, making active `inspect`, `steer`, and `interrupt` actions reachable through normal parent turns.
- Ignored provider-generated `threadId` values during spawn argument preparation and TUI rendering while retaining strict action validation during execution.
- Connected Pi's parent cancellation signal to active child processes so Escape stops the subagent, suppresses replacement follow-up turns, and returns control to the terminal.
- Made `/exit` abort an active run before requesting Pi's graceful shutdown, and made session teardown await bounded background-child settlement.
- Corrected the README cancellation contract so it matches active-child termination.

## [1.5.2] - 2026-08-03

### Changed

- Hardened always-on concise guidance around low-friction action, visible multi-turn state, evidence-backed outcomes, material ambiguity, diagnostic resets, and explicit safety and correctness precedence.

### Fixed

- Resolved bundled subagent role discovery from the package `agents/` directory; the module-relative path broke when subagent modules moved under `killeros/` in v1.5.0, leaving fresh installs with `Unknown subagent "<role>". Available: none`.

## [1.5.1] - 2026-08-03

### Changed

- Added a fixed pragmatic response style, low GPT-5 Responses API verbosity, and concise reasoning summaries without changing reasoning effort.

### Fixed

- Replaced the `subagent` tool's top-level union with a provider-compatible object schema, fixing request rejection by Console Go and other providers that require function schemas with `type: "object"`.
- Kept strict action-specific subagent validation at runtime, including single, parallel, chain, steering, interruption, collection, and closure requests.
- Scoped native concise settings to supported Responses APIs while leaving completion and unrelated provider payloads unchanged.

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
