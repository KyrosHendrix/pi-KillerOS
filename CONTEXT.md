# KillerOS Context

Shared product language for KillerOS as a workflow layer inside the Pi coding agent.

## Language

**Goal truth**:
The durable `/goal` objective and status on the active session branch. It is the only authoritative long-running goal state across turns, compaction, reload, and branch navigation.
_Avoid_: compaction-owned goal, handoff goal copy, summary as source of truth

**Compaction projection**:
A disposable view that Pi’s default compaction summarizer writes from transcript evidence to carry current progress, important decisions, blockers or unresolved issues, and the exact next action across compaction. It may quote Goal truth but never becomes authoritative goal state.
_Avoid_: goal checkpoint, handoff ledger, second goal state

**Manual compaction recovery**:
The fail-closed transition recorded in `/goal` entries that makes a Pi-forced goal-turn abort eligible for reactivation only when active-branch order proves a successful later compaction for that exact paused Goal truth revision with no intervening goal transition. KillerOS reports the temporary pause and successful resume; a failed or cancelled compaction leaves the goal paused, reload can finish a proven recovery, and an explicit `/goal pause` clears recovery eligibility.
_Avoid_: compaction preemption, unconditional abort resume, timer-based resume

**Goal continuation gate**:
Pi’s settled boundary, reached only after retries, compaction, and queued follow-ups finish. KillerOS starts the next active goal turn there instead of mirroring Pi’s internal compaction state.
_Avoid_: compaction hold, threshold gate, in-flight mirror

**Goal stop boundary**:
The `/goal pause` or `/goal clear` transition that first saves non-active Goal truth, then aborts and awaits only a known KillerOS goal run. A later settlement cannot reactivate that goal, and unrelated host work is not aborted when no goal run is scheduled or in flight.
_Avoid_: abort-first goal stop, settlement-based pause, unrelated-run abort

**Blocker audit streak**:
A durable record of one canonical blocker key on distinct consecutive goal turns. Duplicate reports in one turn do not advance it; a changed key or skipped turn restarts it, and only the third consecutive report marks Goal truth blocked.
_Avoid_: elapsed-turn blocker, prose-matched blocker, cumulative blocker count

**Goal-aware clear**:
The confirmed `/clear` transition that aborts an in-flight goal turn, lets the old session record that goal as paused, and starts a new session only after settlement. It never waits behind a newly scheduled goal continuation or leaves the old goal active.
_Avoid_: idle-first clear, active-goal carryover, manual-pause prerequisite

**Host compaction recovery**:
Pi’s own retry path after threshold compaction fails. KillerOS keeps the goal active; Pi retries compaction on later work, while an unrecovered overflow becomes an agent error that pauses the goal through normal goal failure handling.
_Avoid_: KillerOS compaction retry, threshold-failure watchdog, inferred failure pause

**Fail-closed compaction**:
The rule that Pi always writes the compaction projection and KillerOS never substitutes a deterministic or model-backed fallback. If Pi cannot summarize, the failed compaction does not replace context and recovery follows the compaction reason.
_Avoid_: deterministic fallback, KillerOS summary retry, emergency handoff

**Pi lifecycle compatibility**:
KillerOS integration through Pi’s public goal, session, and compaction lifecycle contracts without version-specific branches. Compatibility checks cover the supported minimum and the latest matched Pi package set so Pi can keep evolving without redesigning KillerOS ownership.
_Avoid_: latest-only integration, pinned-host architecture, version switch

**Projection resume rule**:
The goal-turn instruction to restore the exact objective from Goal truth, then continue from the compaction projection’s first concrete next step after checking current repository state. It adds no handoff message or stored progress copy.
_Avoid_: restart from objective, hidden resume message, unverified next step

**Host-owned dependency resolution**:
The install root that owns Pi decides which versions Pi loads. A published KillerOS override protects KillerOS's own development tree but cannot govern a consumer's Pi install.
_Avoid_: universal package override, dependency-owned override

**Supported Pi floor**:
The deferred security-qualified compatibility floor that KillerOS will declare only after a matched Pi release's published dependency tree meets KillerOS's security baseline and passes compatibility checks. Current releases claim only the peer dependency minimum.
_Avoid_: current peer minimum, best-effort override, silent compatibility

**Host compatibility guard**:
A deferred startup check that would compare Pi's public version with the supported Pi floor and stop KillerOS on an older host. It would back the peer dependency rule but would not inspect or repair the host's dependency tree.
_Avoid_: current protection, undici resolver, host repair, warning-only check

**Consumer-tree proof**:
A deferred release check that would install the packed KillerOS candidate with its supported Pi host in a clean root that has no KillerOS override, then verify the resolved tree, security audit, and extension load.
_Avoid_: current release gate, repository-only audit, override-masked test, manual-only check

**Init evidence boundary**:
The frozen project-file map that limits automatic `/init` reads to regular, non-linked repository files while excluding Git-ignored files when Git is available, known secret names, private-key formats, other guidance, dependencies, and unsafe file types. The protected root guidance baseline is the only guidance exception; dedicated `/init` read and list tools enforce this boundary when they execute, and files outside the bounded map remain unavailable even when they are inside the project root.
_Avoid_: project-root access, shared tool-input freeze, unrestricted repository scan

**Init guideline synthesis**:
KillerOS’s packaged adaptation of the `writing-great-guidelines` evidence priorities, four behavioral sections, repository-specific limits, and verification rules. It remains part of the automatic `/init` workflow instead of depending on a separately installed skill.
_Avoid_: runtime skill invocation, verbatim skill copy, external skill dependency

**Protected guidance baseline**:
The existing root `AGENTS.md` that `/init` treats as policy to preserve rather than repository evidence to imitate. KillerOS writes only when compatible rules can be reconciled; an incompatible policy leaves the file unchanged and returns a structured conflict reason for human reconciliation.
_Avoid_: stale evidence, replacement source, disposable guidance

**Guidance policy conflict**:
A concrete contradiction between the protected guidance baseline and the adapted four-section guideline policy that the model cannot preserve in one coherent file. The `/init` workflow reports the conflicting rules through a structured outcome and performs no write.
_Avoid_: generic no-write failure, silent omission, automatic conflict choice

**Guidance write conflict**:
Any change to root `AGENTS.md` after `/init` captures its protected baseline and before the generated update is installed. KillerOS aborts the write, preserves the exact newer file, discards the generated candidate, and requires a rerun.
_Avoid_: last writer wins, automatic re-merge, backup-and-replace

**Concise guidance**:
KillerOS’s universal, always-on response policy that reduces cognitive load and makes the next useful action clear without assuming or labeling a user’s neurotype.
_Avoid_: ADHD mode, terse mode, brevity mode

**Low-friction response**:
An answer that is easy to start and follow because needed state is visible and the user is not expected to remember missing context.
_Avoid_: hidden context, memory-dependent answer, contextless next step

**Progress checkpoint**:
A user-facing update reserved for meaningful phase changes, long-running verification, failures, or required decisions rather than routine tool-by-tool narration.
_Avoid_: tool narration, silent long-running work, conversational progress filler

**Material ambiguity**:
An unresolved choice that would meaningfully change the result after available code and context have been checked; it warrants one concrete user question.
_Avoid_: guess-and-rewrite, unnecessary clarification, multi-question dump

**Material tangent**:
An issue outside the requested task that affects safety, correctness, or the user’s next decision; mention it separately after the primary work without fixing it unasked.
_Avoid_: by-the-way list, adjacent cleanup, hidden consequential issue

**Pragmatic tone**:
Direct, plain, and task-focused language that states errors without drama and uses acknowledgment only when it carries real responsibility or information.
_Avoid_: robotic terseness, generic praise, conversational filler

**Pre-send check**:
A short final quality gate confirming the first line serves the immediate need, filler and redundant recap are removed, exact artifacts and necessary uncertainty remain, and the ending is meaningful.
_Avoid_: detailed style checklist, cosmetic rewrite loop, forced closer

**Semantic structure**:
Formatting chosen by meaning: numbers for sequence, bullets for parallel facts or options, and short headings when they improve scanning or re-entry into a longer answer.
_Avoid_: fixed response template, numbered non-sequence, decorative heading

**Action-oriented guidance**:
A response model that lowers initiation and working-memory friction by foregrounding actionable state, suppressing tangents, and making completed work visible while preserving task, safety, and harness constraints.
_Avoid_: output checklist, copied ADHD skill, minimal answers

**Immediate need**:
The single most useful first-line content for the current turn: an answer for an informational request, a next action for executable work, or a failure with its recovery when blocked.
_Avoid_: mandatory action opener, generic summary opener, conversational preamble

**State anchor**:
A compact current, completed, or next marker used when multi-step work spans turns or resumes after interruption; standalone answers omit it.
_Avoid_: recap, status narration, mandatory turn summary

**Execution estimate**:
A concrete, assumption-bound duration for human-run work, included only when requested or supported by evidence; it never predicts the agent’s own completion time.
_Avoid_: agent ETA, vague estimate, fabricated duration

**Verified outcome**:
A prominent completion statement that names what now works and the evidence proving it, without adding a separate trailing recap.
_Avoid_: done, completion claim without evidence, recap section

**Focused inventory**:
A ranked or grouped list that treats five items as the point to introduce structure, while retaining every item required for correctness or explicitly requested completeness.
_Avoid_: hard five-item cap, unranked long list, omitted required detail

**Required next action**:
The one concrete step shown at the end only when progress depends on the user’s choice, information, or external action; completed or autonomously continuable work does not manufacture one.
_Avoid_: optional closer, want-me-to question, artificial next step

**Guidance precedence**:
The conflict order for response shaping: safety and harness constraints, explicit user depth or format, correctness and completeness, then concise defaults.
_Avoid_: brevity over safety, brevity over correctness, silent conflict resolution

**Diagnostic reset**:
After three consecutive turns leave the same issue broken, stop speculative edits, identify the likely invalid assumption from observed evidence, and ask one diagnostic question.
_Avoid_: debug spiral, fourth speculative fix, repeated still-broken loop

**Settled request**:
A user request whose response, tools, retries, automatic compaction, and queued follow-ups have all finished, leaving Pi idle. Completion notifications occur once at this boundary rather than after each agent run or tool turn.
_Avoid_: finished task, agent end, turn completion, tool completion

**Hook cancellation**:
The bounded process-tree cleanup that starts when the user aborts Pi during a lifecycle hook. KillerOS requests graceful termination, force-kills after the cleanup window, and reports cancellation separately from hook failure.
_Avoid_: timeout-only hook, detached hook, abort failure

**Public editor boundary**:
KillerOS customizes Pi’s prompt input only through public TUI contracts. Slash-command autocomplete remains, but typed command text uses the normal editor color because Pi exposes no public visual-line API for safe command coloring; when another extension already owns a custom prompt input, KillerOS leaves it unchanged and skips only its editor-specific design and key behavior.
_Avoid_: private editor adapter, editor replacement on conflict, pinned editor internals

**Completion sound**:
The optional standard terminal bell sent once after a settled request that finishes normally or with an error; a manually aborted request does not ring. It is a global user preference, off by default, and advertised through the rotating startup tips. A simple Nerd Font line-bell glyph appears at the end of the terminal tab title only while this preference is enabled; it is not part of KillerOS’s startup card and is not clickable.
_Avoid_: notification sound, alert tone, startup-header bell, header button, emoji bell

**Response policy**:
The self-contained, medium-length system guidance that teaches KillerOS’s cognitive-load model, contextual response shape, continuity behavior, exceptions, and pre-send check without copying external examples.
_Avoid_: concise rules list, full skill copy, one-line style hint

**Native concise settings**:
Supported Responses API defaults that request low text verbosity and concise reasoning summaries only when those fields are absent. Explicit provider settings remain unchanged; the defaults complement response policy and stay limited to verified provider/model combinations.
_Avoid_: forced provider override, reasoning-effort reduction, response policy replacement

**Behavioral anchor**:
A stable semantic contract asserted in tests so response-policy wording can evolve without weakening immediate-need framing, continuity, required actions, estimate discipline, diagnostic reset, or precedence.
_Avoid_: full-prompt snapshot, wording lock, smoke-only assertion

**Test-language parity**:
The tracked test suite is written in the same language as the source tree (TypeScript), so the public repository presents one code language while the suite stays public and runtime-checked by CI; the npm package never shipped the suite.
_Avoid_: JavaScript tests, private test suite, mixed-language repository
