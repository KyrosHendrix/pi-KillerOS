# KillerOS Context

Shared product language for KillerOS as a workflow layer inside the Pi coding agent.

## Language

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

**Parent-facing response**:
Output from the main KillerOS agent, including long-running goal turns, governed by concise guidance; isolated subagent handoffs remain governed by their role prompts.
_Avoid_: global subagent style, child concise injection

**Parent-defined subagent role**:
A child role whose name, purpose, and allowed actions the main agent chooses at dispatch time; KillerOS does not select a fixed specialist for it.
_Avoid_: built-in role, bundled role, automatic specialist

**Custom subagent role**:
A reusable child definition the user places in an approved dedicated agents folder using the fixed Markdown format; it is optional and discoverable by the main agent.
_Avoid_: hidden role file, free-form role file, bundled default

**Resumable child thread**:
A child thread that keeps its selected generic or custom role contract across later attempts; resuming a thread does not add to or replace its allowed actions.
_Avoid_: one-shot child, role rediscovery, resumed privilege

**Parent authority ceiling**:
The main agent may narrow a child’s actions but may not grant the child a tool or capability that the main agent does not already hold.
_Avoid_: child privilege minting, unrestricted child tools, inherited full access

**Delegation owner**:
The main agent owns child creation, limits, control, and shared-worktree coordination; a child cannot dispatch another child.
_Avoid_: nested delegation, child-owned orchestration, recursive subagents

**Fixed child web access**:
Children may use the approved web research service through the parent’s existing authority; a parent-defined role cannot load an arbitrary extension.
_Avoid_: arbitrary child extension, extension injection, unrestricted web access

**Generic child dispatch**:
A child dispatch that needs only a task and uses a neutral contract within the parent’s authority; an optional custom role may replace it.
_Avoid_: built-in specialist, mandatory custom role, hidden default role

**Generic child baseline**:
A task-only child starts with read-only repository tools and may use parent-authorized web tools; writes and process access require an explicit custom role.
_Avoid_: inherited write access, implicit writer, task-only shell access

**Operational child safeguards**:
Role freedom does not remove limits and controls that protect the host, shared worktree, process lifecycle, cancellation, and retained output.
_Avoid_: unlimited child work, role-based limit bypass, unbounded delegation

**Boundary guidance**:
Tool guidance may state safety, lifecycle, and handoff rules but must not prescribe named child specialties or task designs.
_Avoid_: specialist defaults, role steering, empty tool guidance

**Guidance precedence**:
The conflict order for response shaping: safety and harness constraints, explicit user depth or format, correctness and completeness, then concise defaults.
_Avoid_: brevity over safety, brevity over correctness, silent conflict resolution

**Diagnostic reset**:
After three consecutive turns leave the same issue broken, stop speculative edits, identify the likely invalid assumption from observed evidence, and ask one diagnostic question.
_Avoid_: debug spiral, fourth speculative fix, repeated still-broken loop

**Response policy**:
The self-contained, medium-length system guidance that teaches KillerOS’s cognitive-load model, contextual response shape, continuity behavior, exceptions, and pre-send check without copying external examples.
_Avoid_: concise rules list, full skill copy, one-line style hint

**Native concise settings**:
Supported Responses API controls that request low text verbosity and concise reasoning summaries; they complement response policy and remain limited to verified provider/model combinations.
_Avoid_: universal provider override, reasoning-effort reduction, response policy replacement

**Behavioral anchor**:
A stable semantic contract asserted in tests so response-policy wording can evolve without weakening immediate-need framing, continuity, required actions, estimate discipline, diagnostic reset, or precedence.
_Avoid_: full-prompt snapshot, wording lock, smoke-only assertion

**v1.5.2**:
The patch release combining restored bundled-role discovery with hardened action-oriented concise guidance and no additional feature expansion.
_Avoid_: discovery-only release, concise-only release, feature release

**Test-language parity**:
The tracked test suite is written in the same language as the source tree (TypeScript), so the public repository presents one code language while the suite stays public and runtime-checked by CI; the npm package never shipped the suite.
_Avoid_: JavaScript tests, private test suite, mixed-language repository
