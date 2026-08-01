# KillerOS

A production-hardened Pi extension that combines a custom TUI, isolated subagents, repository initialization, long-running goals, reasoning controls, interactive questions, command aliases, and concise-response guidance.

## Requirements

- Node.js `22.19.0` or later
- Pi `0.82.1` or later
- `pi-web-access` for child-agent web search and URL fetching (`pi install npm:pi-web-access`)
- Interactive TUI mode for the custom header, editor, footer, `question` tool, and `/init`

The extension is strict TypeScript. Pi provides the runtime modules; `pi-web-access` provides the child web tools.

## Install

### npm

Install KillerOS and its separate child-web-tools peer:

```bash
pi install npm:killeros
pi install npm:pi-web-access
```

### Git

Install the latest commit:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS
```

Pin an install to a release:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS@v1.4.7
```

Add `-l` to either command for a project-only install. Restart Pi after installing.

## Features

- 52-column Compact startup card with inline version, polished model/provider identity, adjacent `/model`, directory, conditional Git branch, and a shuffled session-stable tip
- Cohesive dark theme with coral accents and neutral tool-call containers across pending, success, and error states
- Coral Spark activity indicator with Claude-adjacent verbs that advance between agent runs and a quiet hidden-thinking label
- Framed multiline editor with Shift+Enter support
- Responsive footer with polished model/provider identity, plain-language context, and active goal state remaining; reasoning, Git branch, elapsed time, cost, and path cut down by available width
- `/variants` selector and direct reasoning-level arguments
- Codex-style `/goal` for durable long-running objectives with pause, resume, edit, clear, automatic continuation, and explicit completion
- Pi-native `subagent` tool with named, inspectable child threads, Markdown roles, explicit read/write boundaries, parent controls, natural completion, and cancellation propagation
- Claude Code-style `/init` that scans the repository and generates a concise root `AGENTS.md` without setup questions
- `question` tool with filtering, proposal previews, keyboard selection, custom answers, history, cancellation, and resize-safe rendering
- Mid-prompt slash completion with current Pi `0.82.1` commands, extensions, prompts, and skills
- `/clear` for a confirmed new session, plus `/exit` for graceful shutdown
- Concise system-prompt guidance without modifying completed assistant messages

## Commands

```text
/init                     Generate root AGENTS.md from repository evidence
/goal                     View the current long-running goal
/goal <objective>         Set an objective and start working
/goal edit                Edit and reactivate the current goal
/goal pause               Stop automatic continuation
/goal resume              Resume automatic continuation
/goal clear               Remove the current goal
/variants                 Open the reasoning-level selector
/variants high            Set a reasoning level directly
/clear                    Start a new session after confirmation
/exit                     Quit Pi gracefully
```

`/goal` requires a saved session in TUI or RPC mode. Goal state is stored in versioned session entries on the active branch and restored after reload, resume, fork, or tree navigation. Active goals inject their unchanged objective every turn and continue one settled turn at a time. The model must use KillerOS’s private goal tool to mark verified completion or a blocker repeated across at least three goal turns; final prose alone does not end the loop. Aborted turns, provider failures, and continuation failures pause safely. Replacing unfinished work requires confirmation, and `/goal edit` requires TUI mode.

`/init` builds a bounded project map, reads high-value manifests, documentation, and CI configuration, and lets the active model inspect additional implementation files before generating root `AGENTS.md`. Existing `AGENTS.md` and `CLAUDE.md` content is intentionally excluded so stale guidance is not inherited. The command asks no setup questions, starts no second model process, writes only `AGENTS.md`, and reloads Pi resources when finished.

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. KillerOS limits choices to levels supported by the current model.

## Subagents

KillerOS ships `planner`, `reviewer`, `scout`, and `security` as read-only roles plus focused write-capable `debugger`, `documenter`, and `tester` roles; `worker` remains the general-purpose implementation role. Each invocation rediscovers Markdown roles with this precedence:

| Role | Access | Focus |
|---|---|---|
| `debugger` | write | Reproduce failures, fix root causes, and verify regressions |
| `documenter` | write | Keep repository documentation accurate and audience-focused |
| `planner` | read | Turn repository constraints into an executable implementation route |
| `reviewer` | read | Report proven correctness, security, and regression risks |
| `scout` | read | Map unfamiliar code and return an evidence trail |
| `security` | read | Audit trust boundaries and report concrete security findings |
| `tester` | write | Add focused coverage and run deterministic verification |
| `worker` | write | Execute the assigned repository change |

1. Bundled: `<killeros>/agents/*.md`
2. Personal: `~/.pi/agent/agents/*.md`
3. Trusted project: `<repo>/.pi/agents/*.md`

The default `agentScope: "user"` uses bundled and personal roles. Use `"project"` or `"both"` to opt into trusted project roles; a selected project override requires interactive confirmation. Role frontmatter requires `name`, `description`, `access`, and an explicit `tools` list. Optional fields are `model`, `thinking`, and `timeoutMs`. Every bundled role shows `model: inherit` and `thinking: inherit` as editable placeholders. Replace them with an available `provider/model` and a separate thinking level when you want to pin a role; `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` are checked against that model’s supported capabilities.

The tool supports a single `agent` + `task`, parallel `tasks`, or a sequential `chain` whose task text may include `{previous}`. Parallel batches run read-only roles concurrently, up to four at a time, then run every write-capable role serially in input order because all children share the parent worktree. A call can also set `model` and `thinking` for every task, overriding role settings; use `inherit` to fall back to each role and then the active parent model. The `message` field is only valid with `action: "steer"`. For example:

```json
{"agent":"reviewer","task":"Review the change","model":"provider/model","thinking":"high"}
```

Use the separate `model` and `thinking` fields for new configuration. The older `provider/model:thinking` model form remains accepted. Children run as isolated `pi --mode json -p` processes with a private `--session-dir` and `--session-id`, plus explicit local tools and `web_search`, `source_check`, `fetch_content`, and `get_search_content`. Steering restarts the same child session, so the child keeps its prior conversation. Each child explicitly loads `npm:pi-web-access`, discovers available skills, and keeps arbitrary extensions and prompt templates disabled; project-local skills load only when the parent project is trusted. Every bundled role is instructed to load the most relevant `SKILL.md` and report useful evidence. Children have no default token, dollar, turn, tool-call, research, wall-time, JSONL-line, trace, stderr, or returned-output execution quota. KillerOS bounds retained trace, stderr, and returned text and spills a large JSONL line to temporary storage; retention never stops a child or marks it `limited`. The parent limits each request to ten tasks and four parallel readers and bounds role files, task input, and combined parent output. An embedding caller may opt into named child resource guards. Esc cancellation terminates active children and escalates after five seconds.

### Thread lifecycle

Each delegated task creates a named child thread. Its contract records the parent ID, child ID, role, prompt, model, requested capability boundary, trace, usage, and result state. Roles define the child’s access and tools; they do not own lifecycle controls or grant new filesystem powers. The parent owns scope, waits, inspection, steering, collection, and closure.

Threads move through `queued`, `active`, `done`, `failed`, `stopped`, and `closed`. The parent renders separate **Active** and **Done** lists. Active threads show their name, task, model, usage, and direct controls. Done threads keep their handoff and trace available until the parent closes them.

The parent can inspect a thread’s prompt, role, model, tools, trace, usage, and handoff; steer an active thread with one bounded follow-up; interrupt one child or all active children; collect a concise handoff into parent context; and close a finished or stopped thread. An interrupt preserves the partial trace, states the reason, and reports the handoff as partial rather than successful.

A child completes naturally when it returns a final answer. The default path has no per-child execution quota. Explicit embedding options can add wall-time, output, trace, stderr, JSONL, token, or cost guards; those guards report their cause and return partial work clearly. The parent still bounds task count, reader concurrency, role files, task input, and combined parent output. Explicit user interruptions and real child-process failures remain visible. Esc cancellation terminates active children and escalates after five seconds.

The replacement lifecycle has nine phases:

1. **Dispatch:** create a named thread and store its contract before launch.
2. **Track:** maintain lifecycle states and Active/Done visibility.
3. **Inspect:** keep the trace in the child thread, not the parent context.
4. **Steer:** append a bounded parent follow-up to an active thread.
5. **Interrupt:** stop one or all active children while preserving partial work.
6. **Collect:** return a concise handoff while retaining the expanded trace.
7. **Guard:** honor only explicitly configured child resource guards; do not impose a routine turn stop.
8. **Close:** remove a finished or stopped thread from the workspace without deleting its result record.
9. **Prove:** test identity, visibility, controls, natural completion, guards, partial handoffs, and closure.

## Configuration

KillerOS activates its packaged `killeros` theme when a TUI session starts. Tool-call backgrounds stay neutral across pending, successful, and failed states; restrained text and icons preserve status visibility.

KillerOS displays session costs in USD. The footer uses Pi's human-readable model name when available, keeps the provider visually secondary, and renders context as `percent left (tokens)` without a progress bar. When a goal exists, the footer adds its active time or terminal state; at narrow widths, context pressure and goal state take priority.

For trusted projects, KillerOS loads `AGENTS.local.md` after Pi's shared repository context. A one-line `@path` or `@~/path` file imports personal guidance from another location.

Lifecycle hooks are loaded from `.pi/killeros-hooks.json` at session start. Supported event keys are `tool_call`, `tool_result`, and `agent_settled`; matchers are JavaScript regular expressions over Pi tool names. Hook commands run from the repository root with `KILLEROS_EVENT`, `KILLEROS_TOOL`, and `KILLEROS_PAYLOAD` environment variables. Failed `tool_call` hooks block the tool, while later-event failures notify the user.

## Behavior by mode

| Mode | Behavior |
|---|---|
| TUI | All features are available, including confirmation for trusted project subagents |
| RPC | Goal set/view/pause/resume/clear, subagents, and concise prompt guidance work; TUI components, `/goal edit`, and `/init` are disabled |
| Print/JSON | Concise prompt guidance works; interactive questions, `/goal`, `/init`, and project-role confirmation fail explicitly |

## Validation

Before release, run:

```bash
npm ci
npm run check
npm test
npm pack --dry-run
pi -ne -e . --mode rpc
```

The package manifest lists Pi’s built-in modules as peer dependencies, so npm does not bundle a second copy.

## Publish

The [`pi-package`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) keyword makes a published npm release visible in Pi’s package catalog.

For release `1.4.7`, publish after the validation checks pass:

```bash
npm login
npm publish
```

For later releases, choose `patch`, `minor`, or `major` with `npm version`, then publish and push the version commit and tag.

## Security

Pi extensions and write-capable subagents run with your user permissions. Review the source before installing it globally. KillerOS executes lifecycle hook commands and reads project agent roles only for projects Pi marks as trusted; review `.pi/killeros-hooks.json` and `.pi/agents/*.md` before enabling project trust.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
