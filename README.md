# KillerOS

A production-hardened Pi extension that combines a custom TUI, reasoning controls, interactive questions, command aliases, and concise-response guidance.

## Requirements

- Node.js `22.19.0` or later
- Pi `0.82.1` or later
- Interactive TUI mode for the custom header, editor, footer, and `question` tool

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
pi install git:github.com/KyrosHendrix/pi-KillerOS@v1.1.0
```

Add `-l` to either command for a project-only install. Restart Pi after installing.

## Features

- Compact KillerOS startup card with model, directory, context, and loaded capability state
- Cohesive dark theme with coral accents and neutral tool-call containers across pending, success, and error states
- Coral Spark activity indicator with Claude-adjacent verbs that advance between agent runs and a quiet hidden-thinking label
- Framed multiline editor with Shift+Enter support
- Footer with model, reasoning, context remaining, Git branch, elapsed time, and cost
- `/variants` selector and direct reasoning-level arguments
- `question` tool with filtering, keyboard selection, custom answers, history, cancellation, and resize-safe rendering
- Mid-prompt slash completion with current Pi `0.82.1` commands, extensions, prompts, and skills
- `/clear` for a confirmed new session, plus `/exit` for graceful shutdown
- Concise system-prompt guidance without modifying completed assistant messages

## Commands

```text
/variants                 Open the reasoning-level selector
/variants high            Set a reasoning level directly
/clear                    Start a new session after confirmation
/exit                     Quit Pi gracefully
```

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. KillerOS limits choices to levels supported by the current model.

## Configuration

KillerOS activates its packaged `killeros` theme when a TUI session starts. Tool-call backgrounds stay neutral across pending, successful, and failed states; restrained text and icons preserve status visibility.

KillerOS displays provider costs in USD.

Set a custom footer shortcut hint with:

```text
PI_SHORTCUT_HINT=/variants
```

## Behavior by mode

| Mode | Behavior |
|---|---|
| TUI | All features are available |
| RPC | Commands and concise prompt guidance work; TUI components are disabled |
| Print/JSON | Concise prompt guidance works; interactive questions fail explicitly |

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

Pi extensions run with your user permissions. Review the source before installing it globally.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
