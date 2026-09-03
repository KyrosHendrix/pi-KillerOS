# KillerOS

A TypeScript extension for the [Pi coding agent](https://github.com/earendil-works/pi) that replaces the stock TUI and adds long-running goals, reasoning controls, and workflow commands.

## What you get

- A custom TUI: startup card with version, model, provider, working directory, and Git branch; a dark theme with coral accents; a multiline editor with slash-command completion; a footer that tracks model, context, and goal state; settled task receipts with duration and token usage.
- `/goal`: set an objective and Pi keeps working toward it across turns, compaction, reloads, and branch navigation. New goals pause after 20 turns; `/goal resume` grants another 20.
- `/init`: generates a root `AGENTS.md` from repository evidence, preserving compatible existing rules.
- `/variants`: pick a reasoning level supported by the active model.
- `/codex-fast`: toggles the `priority` service tier on Codex requests.
- `/handoff`: starts a fresh linked session carrying visible continuation context.
- Automatic context compaction when remaining tokens drop below 15% of the window (configurable).
- A `question` tool with single-select and multi-select modes.
- Lifecycle hooks (`tool_call`, `tool_result`, `agent_settled`) from `.pi/killeros-hooks.json`, plus `AGENTS.local.md` loading for trusted projects.
- Optional completion sounds for settled requests.


## Requirements

- Node.js 22.19.0+
- Pi 0.84.3 or later within the 0.x release line
- An interactive TUI session for the custom header, editor, footer, `question`, and `/init`

## Install

```bash
pi install npm:killeros
```

Or from GitHub:

```bash
pi install git:github.com/KyrosHendrix/pi-KillerOS
```

Pin a release by appending its tag, for example `@v2.1.23`. Add `-l` to install only for the current project. Restart Pi after installing.

## Commands

```text
/init                     Generate root AGENTS.md from repository evidence
/goal                     View the current goal
/goal <objective>        Set an objective
/goal pause               Stop automatic continuation
/goal resume              Resume automatic continuation
/goal clear               Remove the current goal
/variants                 Reasoning-level selector (/variants high sets directly)
/codex-fast               Toggle Codex fast mode
/notification             Configure the completion sound
/handoff [focus]          Fresh session with continuation context
/clear                    New session after confirmation
/exit                     Quit Pi gracefully
```

## Behavior by mode

| Mode | What works |
| --- | --- |
| TUI | Everything |
| RPC | Goals, proactive compaction; no TUI components, `/init`, sounds, title indicator |
| Print/JSON | No interactive questions, `/goal`, `/init`, or proactive compaction |

## Configuration

The packaged `killeros` theme activates on TUI start. Compaction triggers by default at 15% tokens remaining, stored in global `killeros.json`:

```json
{
  "autoCompaction": {
    "enabled": true,
    "percentRemaining": 15
  },
  "handoffMaxTokens": 8192
}
```

`handoffMaxTokens` caps the `/handoff` summary output at 8192 tokens by default; raise it when long sessions truncate the summary.

State proof in the objective so the agent can verify it with its normal tools:

```text
/goal Reduce p95 checkout latency below 120 ms, verified by the checkout benchmark, while keeping the correctness suite green
```

A direct quoted file target binds silent file proof:

```text
/goal Fix `killeros/footer.ts`, verified by npm test
```

KillerOS captures the file baseline at goal start and only completes when the file is created or changed. New goals pause after 20 turns without warning. An explicit `/goal resume` on an exhausted goal grants another 20 turns; compaction recovery never grants turns. Restored goals keep their persisted limit.

Completion sounds are off by default; change with `/notification` in TUI mode. The tab-title indicator requires a Nerd Font.

## Development

Strict TypeScript throughout. Tests run on Node's built-in test runner:

```bash
npm ci && npm run check && npm test
```

Releases go through CI on `main`; do not push version tags manually.

## Security

Pi extensions run with your user permissions. Review the source before installing globally. Hook commands run only for projects Pi marks as trusted; check `.pi/killeros-hooks.json` before enabling project trust. KillerOS accepts that configuration only as a regular, non-linked file no larger than 64 KiB in the project's real `.pi` directory.

## License

[MIT](LICENSE) © 2026 KyrosHendrix
