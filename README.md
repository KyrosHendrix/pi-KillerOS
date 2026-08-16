# KillerOS

A production-hardened Pi extension that combines a custom TUI, repository initialization, long-running goals, reasoning controls, interactive questions, and command aliases.

## Requirements

- Node.js `22.19.0` or later
- Pi `0.84.2` or later
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
pi install git:github.com/KyrosHendrix/pi-KillerOS@v2.0.10
```

Add `-l` to either command for a project-only install. Restart Pi after installing.

## Features

- 52-column Compact startup card with inline version, polished model/provider identity, adjacent `/model`, directory, conditional Git branch, and a shuffled session-stable tip
- Cohesive dark theme with coral accents and neutral tool-call containers across pending, success, and error states
- Animated orange 12-frame activity glyph loop at 120 ms per frame with contextual copy derived from request, tool, result, and response events, plus a quiet hidden-thinking label
- Frameless multiline editor with one focus-aware `❯`, a shuffled session-stable empty-state suggestion, overflow-only scroll indicators, Shift+Enter support, and slash-command autocomplete; KillerOS preserves an editor factory configured by another extension
- One compact TUI transcript line reporting truthful `Done`, `Stopped`, or `Failed` settlement with elapsed time while preserving older `✻ Worked for …` entries
- Compact two-deck footer with session state above workspace state; model, context, and active goals stay prioritized as reasoning, time, cost, branch, and path reduce by available width
- Proactive turn-boundary context compaction in TUI and RPC modes, with ordinary prompts and active goals continuing safely after a successful summary
- Optional completion sounds after successful or failed settled requests, excluding manual aborts
- `/variants` selector and direct reasoning-level arguments
- Codex-style `/goal` with an interactive status/action panel, durable objectives, immediate pause and clear cancellation, automatic continuation, explicit completion, and durable blocker audits
- Automatic `/init` guideline synthesis with a frozen safe evidence map, protected existing policy, and the four packaged behavioral sections adapted from `writing-great-guidelines`
- Opt-in decision-gated workflows that ask a structured policy question before explicit skill expansion, preserve the selected allowlist, and fail closed across tool and session boundaries
- `question` tool with single-select and opt-in bounded multi-select, height-bounded option windows, configured Pi keybindings, live option/input progress, proposal previews, custom answers, history, cancellation, and compact expandable transcript rendering
- Mid-prompt slash completion with current Pi `0.84.2` commands, extensions, prompts, and skills; paths, URLs, and invalid commands remain plain text
- Goal-aware `/clear` that confirms, aborts active work, waits for settlement, and starts a new session, plus `/exit` for graceful shutdown

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
/notification             Configure the completion sound
/clear                    Start a new session after confirmation
/exit                     Quit Pi gracefully
```

`/goal` requires a saved session in TUI or RPC mode. Goal state is stored in versioned session entries on the active branch and restored after reload, resume, fork, or tree navigation. Active goals inject their unchanged objective every turn and continue one settled turn at a time. The model must use KillerOS’s private goal tool to report completion. For an objective that clearly asks to create, write, save, or generate a named file-like deliverable at one quoted absolute path, KillerOS saves that exact path with the goal and verifies that a regular file exists there before accepting completion. Other objectives retain model-reported completion. Blocking requires one stable lowercase blocker key recorded on three consecutive goal turns; a changed key, skipped turn, resume, or edit resets the streak. Final prose alone does not end the loop.

`/goal pause` and `/goal clear` save paused or cleared state before aborting current goal work, so settlement cannot restart it. Aborted turns, provider failures, and continuation failures otherwise pause safely. Failed edit and replacement writes dispatch no edited objective; an active prior objective pauses fail-closed, while inactive durable state remains unchanged. Replacing unfinished work requires confirmation, and `/goal edit` requires TUI mode.

`/init` freezes a safe project-file map and exposes only dedicated read and list operations while it generates root `AGENTS.md`. Git-ignored files, known secret paths, private-key formats, other guidance, dependencies, links, non-regular files, and files outside that map are unavailable. Existing root `AGENTS.md` is separate protected policy: compatible rules are preserved, a real policy conflict leaves it unchanged with a reason, and any concurrent target change aborts installation without replacing the newer file.

The generated file uses the four behavioral sections adapted from `writing-great-guidelines`; no external skill installation is required. `/init` asks no setup questions, starts no second model process, writes no other file, and reloads Pi resources only after a successful write.

### Decision-gated workflows

Explicit `/skill:<name>` activation opens the shared question UI before Pi expands a registered skill. `WorkflowAdapter.activation` keeps the existing exact-match API, while `WorkflowAdapter.activations` lets one policy register multiple explicit skill names without duplicating the gate. `Normal` allows only interview and read-only tools; `With docs` additionally permits agreed glossary, context-map, and ADR paths. Unregistered names pass through unchanged, duplicate or ambiguous registrations fail at startup, and the selected policy remains active until the workflow is explicitly finished or cancelled. Extensions can supply additional adapters through `KillerosOptions.decisionGatedWorkflows`.

### Interactive questions

Single-select remains the default. Explicit `minSelections: 1` and `maxSelections: 1` are equivalent to omitting both bounds; other single-select bounds are rejected. An agent opts into multi-select with `mode: "multiple"` and may set `minSelections` and `maxSelections`; the custom answer counts as one selection.

In multi-select, use Space or a visible number to toggle an option, `/` to filter, and Enter to submit. The filter accepts spaces; Enter applies it and Escape returns to the choices. Checked options remain selected when the filter changes. Select **Type a custom answer** with Enter to add or edit one custom item alongside checked options.

Supported reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. KillerOS limits choices to levels supported by the current model.

## Configuration

KillerOS activates its packaged `killeros` theme when a TUI session starts. Tool-call backgrounds stay neutral across pending, successful, and failed states; restrained text and icons preserve status visibility.

The completion sound is a global user preference stored in Pi's agent directory and is off by default. Run `/notification` in TUI mode to enable or disable it; enabling does not play a preview. Enabled TUI tabs append `󰂚`, which requires a Nerd Font in the terminal tab UI. An unsupported font may show a box without affecting sound. KillerOS uses the terminal's audible bell and cannot produce sound when the terminal disables it.

Automatic compaction is enabled by default when Pi's effective `compaction.enabled` setting is true. After each completed assistant turn, including its tool execution, KillerOS reads the active model's current context usage and triggers the public Pi compaction API when `remainingTokens <= max(contextWindow * percentRemaining / 100, reserveTokens)`. The default `percentRemaining` is `15`; `reserveTokens` and `keepRecentTokens` remain Pi-owned. KillerOS reads those effective settings with Pi's public `SettingsManager` using `getAgentDir()` and the current project trust state. The KillerOS-only preference lives in the same global `killeros.json` file:

```json
{
  "autoCompaction": {
    "enabled": true,
    "percentRemaining": 15
  }
}
```

Missing context readings skip the check. Successful ordinary-prompt compaction queues one hidden continuation; active `/goal` runs use the existing session-compaction and goal-continuation path. A failed compaction does not automatically retry. Manual `/compact` behavior is unchanged.

KillerOS displays session costs in USD. The footer uses Pi's human-readable model name when available, keeps the provider visually secondary, and renders context as `percent left (tokens)` without a progress bar. An active goal replaces the right-side path with warning-yellow `/goal is active (...)` and keeps exact seconds in minute and hour formats. Paused and blocked goals retain their existing placement; completed goals remain in transcript history and `/goal` status rather than the footer. At narrow widths, context pressure and actionable goal state take priority.

Pi writes the summary, applies manual focus instructions, tracks files, retries summarization, and handles overflow recovery. KillerOS owns only the proactive turn-boundary trigger and does not replace Pi's compaction implementation. Active `/goal` work continues from the settled compaction boundary, after Pi finishes retries, compaction, and queued work.

Manual `/compact` aborts the current goal turn before summarization, so KillerOS records an honest temporary pause for that exact goal revision. After Pi saves the manual summary, KillerOS resumes that revision automatically. A failed or cancelled manual compaction stays paused; run `/goal pause` during the pause to cancel automatic recovery.

For trusted projects, KillerOS loads `AGENTS.local.md` after Pi's shared repository context. A one-line `@path` or `@~/path` file imports personal guidance from another location.

Lifecycle hooks are loaded from `.pi/killeros-hooks.json` at session start. Supported event keys are `tool_call`, `tool_result`, and `agent_settled`. Optional matchers are JavaScript regular expressions over Pi tool names, so they are valid only for `tool_call` and `tool_result`; KillerOS rejects an `agent_settled` hook that defines a matcher. Hook commands run from the repository root with `KILLEROS_EVENT`, `KILLEROS_TOOL`, and `KILLEROS_PAYLOAD` environment variables. Failed `tool_call` hooks block the tool, while later-event failures notify the user. Aborting the parent request stops the hook process tree with bounded graceful and forced cleanup without reporting cancellation as a hook failure.

## Behavior by mode

| Mode | Behavior |
|---|---|
| TUI | All features are available, including proactive compaction, the completion sound, and the tab-title indicator |
| RPC | Proactive compaction and goal set/view/pause/resume/clear work; TUI components, `/goal edit`, `/init`, completion sounds, and the title indicator are disabled |
| Print/JSON | Interactive questions, `/goal`, `/init`, and proactive compaction are disabled; completion sounds and the title indicator are disabled |

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

To create a GitHub release, update the version in `package.json` and `package-lock.json`, add the matching `CHANGELOG.md` section, and push the release commit to `main`. After the full CI workflow passes, the release workflow creates the matching tag and GitHub release from that verified commit.

Do not manually tag a normal release. If automation must recover a missing GitHub release, push the matching version tag; the same workflow validates the tag against the package and changelog before creating the release.

The [`pi-package`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) keyword makes a published npm release visible in Pi’s package catalog. GitHub release automation does not publish to npm. Publish there separately after validation:

```bash
npm login
npm publish
```

## Security

Pi extensions run with your user permissions. Review the source before installing KillerOS globally. KillerOS executes lifecycle hook commands only for projects Pi marks as trusted; review `.pi/killeros-hooks.json` before enabling project trust.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
