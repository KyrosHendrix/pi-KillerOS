# KillerOS

KillerOS is a TypeScript extension for the Pi coding agent. It adds a custom TUI, repository initialization, long-running goals, reasoning controls, interactive questions, lifecycle hooks, and a small set of command aliases.

## Requirements

- Node.js `22.19.0` or later
- Pi `0.84.2` or later
- An interactive TUI session for the custom header, editor, footer, `question`, and `/init`

KillerOS ships as TypeScript. Pi supplies the runtime modules listed as peer dependencies.

## Install

Install the current npm release:

```bash
pi install npm:killeros
```

Install from GitHub:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS
```

Pin an install to version `v2.0.14`:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS@v2.0.14
```

Add `-l` to either command to install only for the current project. Restart Pi after installing.

## Features

- A compact startup card with the extension version, model, provider, `/model`, working directory, Git branch, and a session-stable tip.
- A dark theme with coral accents and neutral tool-call containers for pending, successful, and failed calls.
- A 12-frame orange activity glyph with event-based status text and a quiet hidden-thinking label.
- A multiline editor with a single focus-aware prompt arrow, a session-stable empty-state suggestion, overflow-only scroll indicators, Shift+Enter support, and slash-command completion.
- A settled transcript line that reports `Done`, `Stopped`, or `Failed` with elapsed time, while preserving older `✻ Worked for ...` entries.
- A responsive footer that keeps model, context, and goal state visible as the terminal gets narrower.
- Automatic turn-boundary context compaction in TUI and RPC modes.
- Optional completion sounds for successful and failed settled requests.
- `/variants` for selecting a model reasoning level.
- `/codex-fast` for toggling the `priority` service tier on Codex requests.
- `/goal` for durable objectives with pause, resume, edit, clear, completion, continuation, and blocker audits.
- `/init` for generating a root `AGENTS.md` from a bounded, safe set of repository files.
- A `question` tool with single-select and opt-in multi-select controls.
- Slash completion based on Pi's registered commands, extensions, prompts, and skills.
- Goal-aware `/clear` and graceful `/exit` handling.

## Commands

```text
/init                     Generate root AGENTS.md from repository evidence
/goal                     Open current goal status and valid actions
/goal <objective>         Set an objective and start working
/goal edit                Edit and reactivate the current goal
/goal pause               Stop the current goal turn and automatic continuation
/goal resume              Resume automatic continuation
/goal clear               Stop current goal work and remove the goal
/variants                 Open the reasoning-level selector
/variants high            Set a reasoning level directly
/codex-fast               Toggle process-local Codex fast mode
/notification             Configure the completion sound
/clear                    Start a new session after confirmation
/exit                     Quit Pi gracefully
```

### Codex fast mode

`/codex-fast` takes no arguments. It toggles a process-local setting. When it is enabled and the active model uses the `openai-codex` provider, KillerOS adds `service_tier: "priority"` to the provider request. The footer shows bold `Fast` between the model and provider.

The setting survives a session reload within the same process, does not change other providers, is not saved to KillerOS configuration, and starts disabled after Pi restarts. A provider failure leaves the setting enabled and follows Pi's normal error handling.

### Goals

`/goal` requires a saved session in TUI or RPC mode. Goal state is stored in versioned session entries on the active branch and restored after reload, resume, fork, and tree navigation.

An active goal injects its unchanged objective on each turn and continues one settled turn at a time. The model must use KillerOS's private goal tool to report completion. If the objective explicitly asks for a named file-like deliverable at one quoted absolute path, KillerOS records that path and checks that a regular file exists before accepting completion. Other objectives use the model's completion report.

KillerOS marks a goal blocked only after a stable lowercase blocker key recorded on three consecutive goal turns. A changed key, skipped turn, resume, or edit resets the streak. Final prose does not end the loop.

Active goals replace the footer path with warning-yellow `/goal is active (...)` and keep the exact elapsed time visible.

`/goal pause` and `/goal clear` save paused or cleared state before aborting current goal work, so settlement cannot restart it. Aborted turns, provider failures, and continuation failures pause safely. Failed edit and replacement writes dispatch no edited objective. Replacing unfinished work requires confirmation, and `/goal edit` works only in TUI mode.

### Repository initialization

`/init` freezes a safe project-file map and exposes only dedicated read and list operations while it generates the root `AGENTS.md`. Git-ignored files, known secret paths, private-key formats, other guidance files, dependencies, links, non-regular files, and files outside the map are unavailable to the generation step.

An existing root `AGENTS.md` is protected policy. Compatible rules are preserved. A real policy conflict leaves the file unchanged with a reason, and a concurrent target change aborts installation instead of replacing the newer file.

The generated file uses four behavioral sections adapted from `writing-great-guidelines`. `/init` does not require another skill installation, ask setup questions, start a second model process, or write another file. Pi resources reload only after a successful write.

### Interactive questions

Single-select remains the default. Explicit `minSelections: 1` and `maxSelections: 1` are accepted; other single-select bounds are rejected. Use `mode: "multiple"` to opt into multi-select. The custom answer counts as one selection.

In multi-select mode, use Space or a visible number to toggle an option, `/` to filter, and Enter to submit. The filter accepts spaces. Enter applies the filter and Escape returns to the choices. Checked options remain selected when the filter changes. Select `Type a custom answer` to add or edit one custom item alongside the checked options.

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. KillerOS limits the selector to levels supported by the current model.

## Configuration

KillerOS activates its packaged `killeros` theme when a TUI session starts. Tool-call backgrounds stay neutral in pending, successful, and failed states.

The completion sound is a global user preference in Pi's agent directory and is off by default. Run `/notification` in TUI mode to change it. Enabled TUI tabs append `󰂚`, which requires a Nerd Font. KillerOS uses the terminal's audible bell, so a terminal that disables the bell cannot play the sound.

### Automatic compaction

Automatic compaction is enabled by default when Pi's effective `compaction.enabled` setting is true. After each completed assistant turn, including tool execution, KillerOS reads the active model's context usage and calls Pi's public compaction API when:

```text
remainingTokens <= max(contextWindow * percentRemaining / 100, reserveTokens)
```

The default `percentRemaining` is `15`. Pi owns `reserveTokens` and `keepRecentTokens`. KillerOS reads the effective settings through Pi's public `SettingsManager` with `getAgentDir()` and stores its own preference in the global `killeros.json` file:

```json
{
  "autoCompaction": {
    "enabled": true,
    "percentRemaining": 15
  }
}
```

Missing context readings skip the check. Successful ordinary-prompt compaction queues one hidden continuation. Active `/goal` runs use the existing session-compaction and goal-continuation path. Failed compaction does not retry automatically, and manual `/compact` behavior is unchanged.

Pi writes the summary, applies manual focus instructions, tracks files, retries summarization, and handles overflow recovery. KillerOS only decides when to request proactive compaction.

Manual `/compact` pauses the current goal turn before summarization. After Pi saves the summary, KillerOS resumes that goal revision automatically. A failed or cancelled manual compaction stays paused. Run `/goal pause` during the pause to cancel automatic recovery.

### Project instructions and hooks

For trusted projects, KillerOS loads `AGENTS.local.md` after Pi's shared repository context. A one-line `@path` or `@~/path` file imports personal guidance from another location.

Lifecycle hooks load from `.pi/killeros-hooks.json` at session start. Supported event keys are `tool_call`, `tool_result`, and `agent_settled`. Regular-expression matchers apply only to the first two events. KillerOS rejects a matcher on `agent_settled`.

Hook commands run from the repository root with `KILLEROS_EVENT`, `KILLEROS_TOOL`, and `KILLEROS_PAYLOAD` environment variables. A failed `tool_call` hook blocks the tool. Failures for later events notify the user. If the parent request is aborted, KillerOS stops the hook process tree with bounded graceful and forced cleanup without reporting cancellation as a hook failure.

## Behavior by mode

| Mode | Behavior |
| --- | --- |
| TUI | All features are available, including proactive compaction, completion sounds, and the tab-title indicator. |
| RPC | Proactive compaction and goal set/view/pause/resume/clear work. TUI components, `/goal edit`, `/init`, completion sounds, and the title indicator are disabled. |
| Print/JSON | Interactive questions, `/goal`, `/init`, and proactive compaction are disabled. Completion sounds and the title indicator are disabled. |

## Development and validation

Source and tests use strict TypeScript. Tests run with Node's built-in test runner and type stripping.

Before a release, run:

```bash
npm ci
npm run check
npm test
npm pack --dry-run
pi -ne -e . --mode rpc
```

The package manifest lists Pi's built-in modules as peer dependencies, so npm does not bundle another copy.

## Releases

For a normal release:

1. Update the version in `package.json` and both matching version fields in `package-lock.json`.
2. Add a dated section with the same version to `CHANGELOG.md`.
3. Push the release commit to `main`.

After the full CI workflow passes on `main`, the release workflow validates the commit and changelog, publishes the package to npm through trusted publishing, and creates the matching tag and GitHub release. The [`pi-package` keyword](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) makes the npm package visible in Pi's package catalog.

Do not push version tags manually. Tag pushes cannot publish; every published commit must pass the full `main` CI workflow.

## Security

Pi extensions run with your user permissions. Review the source before installing KillerOS globally. KillerOS runs lifecycle hook commands only for projects Pi marks as trusted. Review `.pi/killeros-hooks.json` before enabling project trust.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
