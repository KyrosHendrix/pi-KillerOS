# KillerOS

A production-hardened Pi extension that combines a custom TUI, repository initialization, long-running goals, reasoning controls, interactive questions, command aliases, and concise-response guidance.

## Requirements

- Node.js `22.19.0` or later
- Pi `0.82.1` or later
- Interactive TUI mode for the custom header, editor, footer, `question` tool, and `/init`

The extension is strict TypeScript. Pi provides the runtime modules.

## Install

### npm

Install KillerOS:

```bash
pi install npm:killeros
```

### Git

Install the latest commit:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS
```

Pin an install to a release:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS@v2.0.3
```

Add `-l` to either command for a project-only install. Restart Pi after installing.

## Features

- 52-column Compact startup card with inline version, polished model/provider identity, adjacent `/model`, directory, conditional Git branch, and a shuffled session-stable tip
- Cohesive dark theme with coral accents and neutral tool-call containers across pending, success, and error states
- Animated orange 12-frame activity glyph loop at 120 ms per frame, with orange shuffled Claude-adjacent verbs changing every 2.5 seconds, a gray `(esc to interrupt · thinking)` status with bold `esc`, and a quiet hidden-thinking label
- Framed multiline editor with Shift+Enter support and live command-blue highlighting for recognized slash command prefixes
- Responsive footer with polished model/provider identity, plain-language context, and active goal state remaining; reasoning, Git branch, elapsed time, cost, and path cut down by available width
- Pi-owned context compaction with active goals continuing from Pi's settled boundary after manual, threshold, and overflow compaction
- Optional completion sounds after successful or failed settled requests, excluding manual aborts
- `/variants` selector and direct reasoning-level arguments
- Codex-style `/goal` with an interactive status/action panel, durable objectives, pause, resume, edit, confirmed panel clearing, automatic continuation, and explicit completion
- Claude Code-style `/init` that scans the repository and generates a concise root `AGENTS.md` without setup questions
- `question` tool with height-bounded option windows, configured Pi keybindings, live option/input progress, proposal previews, custom answers, history, cancellation, and compact expandable transcript rendering
- Mid-prompt slash completion with current Pi `0.82.1` commands, extensions, prompts, and skills; paths, URLs, and invalid commands remain plain text
- `/clear` for a confirmed new session, plus `/exit` for graceful shutdown
- Concise system-prompt guidance without modifying completed assistant messages

## Commands

```text
/init                     Generate root AGENTS.md from repository evidence
/goal                     Open current goal status and valid actions
/goal <objective>         Set an objective and start working
/goal edit                Edit and reactivate the current goal
/goal pause               Stop automatic continuation
/goal resume              Resume automatic continuation
/goal clear               Remove the current goal
/variants                 Open the reasoning-level selector
/variants high            Set a reasoning level directly
/notification             Configure the completion sound
/clear                    Start a new session after confirmation
/exit                     Quit Pi gracefully
```

`/goal` requires a saved session in TUI or RPC mode. Goal state is stored in versioned session entries on the active branch and restored after reload, resume, fork, or tree navigation. Active goals inject their unchanged objective every turn and continue one settled turn at a time. The model must use KillerOS’s private goal tool to mark verified completion or a blocker repeated across at least three goal turns; final prose alone does not end the loop. Aborted turns, provider failures, and continuation failures pause safely. Replacing unfinished work requires confirmation, and `/goal edit` requires TUI mode.

`/init` builds a bounded project map, reads high-value manifests, documentation, and CI configuration, and lets the active model inspect additional implementation files before generating root `AGENTS.md`. Existing `AGENTS.md` and `CLAUDE.md` content is intentionally excluded so stale guidance is not inherited. The command asks no setup questions, starts no second model process, writes only `AGENTS.md`, and reloads Pi resources when finished.

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. KillerOS limits choices to levels supported by the current model.

## Configuration

KillerOS activates its packaged `killeros` theme when a TUI session starts. Tool-call backgrounds stay neutral across pending, successful, and failed states; restrained text and icons preserve status visibility.

The completion sound is a global user preference stored in Pi's agent directory and is off by default. Run `/notification` in TUI mode to enable or disable it; enabling does not play a preview. Enabled TUI tabs append `󰂚`, which requires a Nerd Font in the terminal tab UI. An unsupported font may show a box without affecting sound. KillerOS uses the terminal's audible bell and cannot produce sound when the terminal disables it.

KillerOS displays session costs in USD. The footer uses Pi's human-readable model name when available, keeps the provider visually secondary, and renders context as `percent left (tokens)` without a progress bar. An active goal replaces the right-side path with warning-yellow `/goal is active (...)` and keeps exact seconds in minute and hour formats. Paused and blocked goals retain their existing placement; completed goals remain in transcript history and `/goal` status rather than the footer. At narrow widths, context pressure and actionable goal state take priority.

Pi decides when compaction runs and Pi writes the summary, applies manual focus instructions, tracks files, retries summarization, and handles overflow recovery. KillerOS does not add a second threshold or replace Pi's summary. Active `/goal` work continues from Pi's settled boundary, after Pi finishes retries, compaction, and queued work.

Manual `/compact` aborts the current goal turn before summarization, so KillerOS records an honest temporary pause for that exact goal revision. After Pi saves the manual summary, KillerOS resumes that revision automatically. A failed or cancelled manual compaction stays paused; run `/goal pause` during the pause to cancel automatic recovery.

For trusted projects, KillerOS loads `AGENTS.local.md` after Pi's shared repository context. A one-line `@path` or `@~/path` file imports personal guidance from another location.

Lifecycle hooks are loaded from `.pi/killeros-hooks.json` at session start. Supported event keys are `tool_call`, `tool_result`, and `agent_settled`; matchers are JavaScript regular expressions over Pi tool names. Hook commands run from the repository root with `KILLEROS_EVENT`, `KILLEROS_TOOL`, and `KILLEROS_PAYLOAD` environment variables. Failed `tool_call` hooks block the tool, while later-event failures notify the user.

## Behavior by mode

| Mode | Behavior |
|---|---|
| TUI | All features are available, including the completion sound and tab-title indicator |
| RPC | Goal set/view/pause/resume/clear and concise prompt guidance work; TUI components, `/goal edit`, `/init`, completion sounds, and the title indicator are disabled |
| Print/JSON | Concise prompt guidance works; interactive questions, `/goal`, and `/init` fail explicitly; completion sounds and the title indicator are disabled |

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

For a release, publish after the validation checks pass:

```bash
npm login
npm publish
```

For later releases, choose `patch`, `minor`, or `major` with `npm version`, then publish and push the version commit and tag.

## Security

Pi extensions run with your user permissions. Review the source before installing KillerOS globally. KillerOS executes lifecycle hook commands only for projects Pi marks as trusted; review `.pi/killeros-hooks.json` before enabling project trust.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
