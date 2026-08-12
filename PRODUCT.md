# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Developers using the Pi coding agent in an interactive terminal, especially those who want a more informative and controlled coding workflow.

## Product Purpose

KillerOS is a Pi extension that combines a custom terminal UI, reasoning controls, interactive questions, command aliases, and concise-response guidance. It should help users understand the current session and move into productive work quickly.

## Positioning

Unlike a standalone theme or command bundle, KillerOS coordinates the startup header, editor, footer, reasoning controls, question flow, slash completion, and response guidance as one Pi workflow layer.

## Operating Context

KillerOS runs inside Pi’s TUI during repository work. Users start sessions, inspect model and reasoning state, enter prompts, invoke slash commands, review agent work, and switch or clear sessions without leaving the terminal.

## Capabilities and Constraints

- Requires Node.js 22.19.0 or later and Pi 0.82.1 or later.
- Full custom header, editor, footer, and interactive question behavior requires TUI mode.
- RPC supports commands and concise prompt guidance but disables TUI components.
- Print and JSON modes support concise prompt guidance but not interactive questions.
- UI components must remain legible across narrow and wide terminal widths and use the packaged KillerOS theme in TUI mode.
- The prompt editor is frameless: one dim `❯` turns coral on focus, continuation rows align under the input, and scroll indicators appear only when content overflows. The shuffled session-stable `Try "…"` suggestion and Shift+Enter remain; slash-command autocomplete stays available, typed prompt text uses the normal editor color, and KillerOS leaves a custom editor factory from another extension unchanged.
- Interactive question components must never render more rows than the active terminal height; tiny terminals degrade to a compact usable view.
- Question and selector navigation must follow Pi’s effective keybindings and display the same bindings in help text.
- The `question` tool remains single-select by default. Multi-select is opt-in and bounded, with one additive custom answer.
- Multi-select uses Space for checked state, Enter for submission, and a dedicated `/` filter editor so typed filters can contain spaces; filtering never clears checked answers.
- Pending, successful, and failed tool calls share one neutral container surface; status remains distinguishable through restrained text and icons.
- Active responses use the orange 12-frame glyph loop `· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·` at 120 ms per frame and event-derived copy for mapping, inspection, changes, commands, custom tools, recovery, review, and response assembly. The gray status names the observed action with only `esc` bold; hidden reasoning uses the static `└ Thinking…` label.
- TUI requests show a transient borderless trail of at most four observed phases above the editor. It uses text markers as well as semantic color, collapses to the active phase below 48 columns, survives automatic continuations, and clears only at final settlement.
- Final TUI settlement adds exactly one compact `Done`, `Stopped`, or `Failed` transcript line with elapsed time. Saved version-1 `✻ Worked for …` entries remain readable without migration.
- Persistent footer state is reserved for active or actionable work; an active goal replaces the path on the right with warning-yellow status and exact seconds, while completed goals remain in history and goal status.
- An opt-in completion sound uses the terminal bell once after a successful or failed settled request; manual aborts remain silent, and the global setting is off by default.
- The startup surface is a compact KillerOS card showing the active model, reasoning level, directory, and repository branch when available; context telemetry remains in the footer.

## Brand Commitments

- Product name: KillerOS.
- Existing accent color: RGB 215, 119, 87.
- Existing interface language uses terminal-native text, box-drawing characters, and concise operational copy.
- Existing voice is direct, practical, and low-ceremony.

## Evidence on Hand

- Product documentation and feature inventory: `README.md`.
- Current implementation, including the startup header and terminal UI behavior: `Killeros.ts`.
- No customer claims, testimonials, benchmarks, pricing, or external brand assets are present and none should be fabricated.

## Product Principles

- Get users from startup to useful work quickly.
- Make model, reasoning, repository, and session state easy to scan.
- Keep interaction terminal-native and keyboard-first.
- Prefer operational clarity over decorative chrome.
- Preserve graceful behavior across Pi’s supported modes.

## Accessibility & Inclusion

Use theme-aware colors, never rely on color alone to communicate state, preserve keyboard operation, and keep all rendered TUI lines within the available terminal width.
