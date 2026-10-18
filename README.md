# KillerOS

Give Pi a goal. Keep working in your terminal.

KillerOS replaces the [Pi coding agent's](https://github.com/earendil-works/pi) stock UI with a dark, coral-accented terminal and goals that continue across turns and context compaction.

![KillerOS terminal UI](.github/assets/killeros-preview.png)

## Tell it what done looks like

```text
/goal Create `./summary.md` describing this repository's entry points, verified against the source files
```

The agent works until it reports completion, hits a blocker, or pauses. Each goal gets 20 turns. Resume an exhausted goal to grant another 20. Goals survive compaction and reloads.

Pause the work, edit the objective, or carry context into a fresh session. The question tool offers single-select and multi-select answers without leaving the terminal. Settled task receipts show duration and token usage.

The footer keeps your model, remaining context, and goal status visible. Completion sounds are off by default. The tab-title indicator requires a Nerd Font.

## Install

KillerOS supports Windows only, with native Windows Node.js 22.19.0+ and Pi 1.3.0 or later below 2.0.0. Users on older Pi versions must upgrade.

```bash
pi install npm:killeros
pi
```

Run `/login` if you haven't configured a provider, then enter a `/goal`.

Prefer GitHub? Use `pi install git:github.com/KyrosHendrix/pi-KillerOS`. Pin with `npm:killeros@3.0.8` or `git:github.com/KyrosHendrix/pi-KillerOS@v3.0.8`. Add `-l` for a project-only install.

## Commands

```text
/goal                     View the current goal
/goal <objective>         Set an objective
/goal edit <objective>    Update an active or paused goal
/goal pause               Stop automatic continuation
/goal resume              Resume automatic continuation
/goal clear               Remove the current goal
/handoff [focus]          Carry context into a linked session
/codex-fast [status]      Toggle or report priority service
/auto-compact [status|on|off|<percent>]
/notification             Configure the completion sound
/clear                    Start a new session after confirmation
/exit                     Quit Pi
```

## Worth knowing

Goals send model requests and can incur charges. Include a checkable result in your objective. KillerOS checks changes to directly quoted file targets, but cannot independently prove every completion claim. Review the result.

Compaction triggers by default at 15% tokens remaining. Turning KillerOS compaction off doesn't disable Pi's own compaction. Fast mode requests eligible OpenAI priority service and can cost more. Its footer label doesn't confirm OpenAI accepted the tier.

Extensions run with your permissions. Review project hooks before granting trust, and check handoff context for secrets. Questions require TUI mode. RPC supports goals and proactive compaction. Print and JSON modes support neither.

<details>
<summary>Pi compatibility and settings</summary>

KillerOS leaves Pi's `tuiMode` and `quietStartup` preferences unchanged. Pi defaults to fullscreen. Use `--tui-mode regular` or `"tuiMode": "regular"` for terminal-owned scrollback. Your keybindings still apply.

Settings live in `%USERPROFILE%\.pi\agent\killeros.json`. The compaction defaults are `"autoCompaction": { "enabled": true, "percentRemaining": 15 }`. Fast mode isn't persisted.

Pi's native `--tools` and `--exclude-tools` support `*` patterns. Quote patterns such as `"killeros_*"` so the shell does not expand them. An explicit allowlist must include `question` for questions and permit `killeros_goal_update` for goals. Excluding the goal tool pauses goals. Use `--exclude-tools` rather than `-name` modifiers to exclude extension tools. See [tool selection](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#tools).

In Pi codemode, `tools.read()` returns an image block for images that you can pass to `image()`. See [codemode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md#call-tools).

Use `/thinking` and `samplingParamsByThinkingLevel` for [native sampling](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md#configure-sampling-by-thinking-level). Use `.pi/mcp.json` for [trusted project MCP overrides](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md#configure-servers).

A nonempty `--tools` list with no `mcp__` entry preserves MCP tool availability. For example, `--tools codemode` does not disable MCP connections. Use `--no-mcp` to disable MCP connections. See [MCP tool exposure](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md#control-tool-exposure).

</details>

## Contributing

Install dependencies with `npm ci --ignore-scripts --no-audit --no-fund`. Run the checkout with `npx pi -e .`, with any installed copy disabled. Check changes with `npm run check` and `npm test`. There is no build step.

### Release process

Prepare releases on `dev`, update package versions and changelog, and open a PR into `main`. Wait for required checks and review, then use a merge commit. Releases go through CI on `main`; do not push version tags manually. Wait for the automated sync back to `dev` before advancing it.

## Bugs and license

Windows Node 24.19.0 has a native RPC shutdown crash. Use Node 22.19.0 or 24.20.0+.

[Report a bug](https://github.com/KyrosHendrix/pi-KillerOS/issues) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
