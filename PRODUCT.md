# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

## Users

Developers using the Pi coding agent in an interactive terminal, especially those who want a more informative and controlled coding workflow.

## Product Purpose

KillerOS is a Pi extension that combines a custom terminal UI, isolated subagents, reasoning controls, interactive questions, command aliases, and concise-response guidance. It should help users understand the current session and move into productive work quickly.

## Positioning

Unlike a standalone theme or command bundle, KillerOS coordinates the startup header, editor, footer, reasoning controls, question flow, slash completion, and response guidance as one Pi workflow layer.

## Operating Context

KillerOS runs inside Pi’s TUI during repository work. Users start sessions, inspect model and reasoning state, enter prompts, invoke slash commands, review agent work, and switch or clear sessions without leaving the terminal.

## Capabilities and Constraints

- Requires Node.js 22.19.0 or later and Pi 0.82.1 or later.
- Full custom header, editor, footer, and interactive question behavior requires TUI mode.
- Subagents use named isolated Pi children with parent-scoped case-insensitive names. The main agent may omit a role for a generic read-only child, choose an optional custom role from the approved personal or trusted project folder, or define an inline role. Selected role contracts persist with the child session and are checked against the current parent tool set on resume. Stable child session IDs and directories, default limits of 64 turns, 2,000,000 reported tokens, and 30 minutes remain in force. `wait` reports terminal and pending children without stopping them; `resume` keeps the thread ID, name, session, and directory while increasing the attempt count. Compact child records persist in the parent session through `appendEntry`; active records restore as `orphaned` after a parent restart. Empty final assistant output fails, and write-capable parallel work is serialized in the shared worktree. Each JSONL record has an 8 MiB ceiling, retained telemetry is bounded, arbitrary child extensions and prompt templates stay disabled, and project-local skills load only when the parent project is trusted.
- Child web research uses the explicitly loaded `pi-web-access` package, which users install alongside KillerOS.
- Users can choose one child `provider/model` for a dispatch and separate thinking effort per invocation; omitted settings inherit the selected role or active parent, custom role files may set defaults, and KillerOS checks the requested effort against the selected model.
- KillerOS ships no role files. Personal roles are available by default; trusted project roles require explicit scope and confirmation. Inline roles are available for one dispatch.
- RPC supports commands, subagents, and concise prompt guidance but disables TUI components.
- Print and JSON modes support concise prompt guidance but not interactive questions.
- UI components must remain legible across narrow and wide terminal widths and use the packaged KillerOS theme in TUI mode.
- Pending, successful, and failed tool calls share one neutral container surface; status remains distinguishable through restrained text and icons.
- Active responses use a coral Spark indicator and cycle through a bounded bank of Claude-adjacent verbs; hidden reasoning uses the static `└ Thinking…` label.
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
