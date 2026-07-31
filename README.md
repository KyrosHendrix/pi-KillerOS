# KillerOS

A production-hardened Pi extension that combines a custom TUI, repository initialization, reasoning controls, interactive questions, command aliases, and concise-response guidance.

## Requirements

- Node.js `22.19.0` or later
- Pi `0.82.1` or later
- Interactive TUI mode for the custom header, editor, footer, `question` tool, and `/init`

The extension is strict TypeScript and uses only packages provided by Pi.

## Install

### npm

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
pi install git:github.com/KyrosHendrix/pi-KillerOS@v1.2.0
```

Add `-l` to either command for a project-only install. Restart Pi after installing.

## Features

- 52-column Compact startup card with inline version, polished model/provider identity, adjacent `/model`, directory, conditional Git branch, and a shuffled session-stable tip
- Cohesive dark theme with coral accents and neutral tool-call containers across pending, success, and error states
- Coral Spark activity indicator with Claude-adjacent verbs that advance between agent runs and a quiet hidden-thinking label
- Framed multiline editor with Shift+Enter support
- Responsive footer with polished model/provider identity and plain-language context remaining; reasoning, Git branch, elapsed time, cost, and path cut down by available width
- `/variants` selector and direct reasoning-level arguments
- Claude Code-style `/init` that scans the repository and generates a concise root `AGENTS.md` without setup questions
- `question` tool with filtering, proposal previews, keyboard selection, custom answers, history, cancellation, and resize-safe rendering
- Mid-prompt slash completion with current Pi `0.82.1` commands, extensions, prompts, and skills
- `/clear` for a confirmed new session, plus `/exit` for graceful shutdown
- Concise system-prompt guidance without modifying completed assistant messages

## Commands

```text
/init                     Generate root AGENTS.md from repository evidence
/variants                 Open the reasoning-level selector
/variants high            Set a reasoning level directly
/clear                    Start a new session after confirmation
/exit                     Quit Pi gracefully
```

`/init` builds a bounded project map, reads high-value manifests, documentation, and CI configuration, and lets the active model inspect additional implementation files before generating root `AGENTS.md`. Existing `AGENTS.md` and `CLAUDE.md` content is intentionally excluded so stale guidance is not inherited. The command asks no setup questions, starts no second model process, writes only `AGENTS.md`, and reloads Pi resources when finished.

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. KillerOS limits choices to levels supported by the current model.

## Configuration

KillerOS activates its packaged `killeros` theme when a TUI session starts. Tool-call backgrounds stay neutral across pending, successful, and failed states; restrained text and icons preserve status visibility.

KillerOS displays session costs in USD. The footer uses Pi's human-readable model name when available, keeps the provider visually secondary, and renders context as `percent left (tokens)` without a progress bar.

For trusted projects, KillerOS loads `AGENTS.local.md` after Pi's shared repository context. A one-line `@path` or `@~/path` file imports personal guidance from another location.

Lifecycle hooks are loaded from `.pi/killeros-hooks.json` at session start. Supported event keys are `tool_call`, `tool_result`, and `agent_settled`; matchers are JavaScript regular expressions over Pi tool names. Hook commands run from the repository root with `KILLEROS_EVENT`, `KILLEROS_TOOL`, and `KILLEROS_PAYLOAD` environment variables. Failed `tool_call` hooks block the tool, while later-event failures notify the user.

## Behavior by mode

| Mode | Behavior |
|---|---|
| TUI | All features are available |
| RPC | Non-interactive commands and concise prompt guidance work; TUI components and `/init` are disabled |
| Print/JSON | Concise prompt guidance works; interactive questions and `/init` fail explicitly |

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

Choose `patch`, `minor`, or `major` for the release, then publish and push the version commit and tag:

```bash
npm login
npm version patch
npm publish
git push origin main --follow-tags
```

## Security

Pi extensions run with your user permissions. Review the source before installing it globally. KillerOS executes lifecycle hook commands only for projects Pi marks as trusted; review `.pi/killeros-hooks.json` before enabling project trust.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
