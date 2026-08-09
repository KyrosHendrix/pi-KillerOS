---
name: KillerOS
description: A direct, terminal-native workflow layer for the Pi coding agent.
colors:
  signal-coral: "#d77757"
  console-black: "#0a0a0a"
  console-panel: "#121212"
  console-raised: "#1a1a1a"
  console-line: "#404040"
  console-ink: "#f2f2f2"
  console-muted: "#adadad"
  console-dim: "#808080"
  ready-green: "#72d79b"
  reasoning-pink: "#ec91c2"
  command-blue: "#78a9ff"
typography:
  display:
    fontFamily: "Arial Narrow, Aptos Narrow, Roboto Condensed, Arial, sans-serif"
    fontSize: "clamp(3.125rem, 7vw, 6.5rem)"
    fontWeight: 800
    lineHeight: 0.86
    letterSpacing: "-0.03em"
  terminal:
    fontFamily: "Consolas, Cascadia Mono, SFMono-Regular, monospace"
    fontSize: "clamp(0.6875rem, 1.05vw, 0.9375rem)"
    fontWeight: 400
    lineHeight: 1.42
rounded:
  terminal: "13px"
  capture: "10px"
spacing:
  compact: "9px"
  control: "13px"
  section: "48px"
components:
  terminal-frame:
    backgroundColor: "{colors.console-black}"
    textColor: "{colors.console-ink}"
    rounded: "{rounded.terminal}"
  jump-link:
    backgroundColor: "{colors.console-black}"
    textColor: "{colors.console-muted}"
    typography: "{typography.terminal}"
    padding: "10px 13px"
---

# Design System: KillerOS

## Overview

**Creative North Star: "The Operational Console"**

KillerOS should feel like a serious terminal instrument: immediate, compact, and explicit about state. Identity comes from disciplined coral signals and terse operational language rather than decorative effects. Startup uses one bounded operational card inspired by familiar coding-agent launch screens.

**Key Characteristics:**
- Neutral black working surfaces with white and gray text plus one coral signal color.
- Monospaced telemetry for real terminal state.
- Compressed, heavy display type only in browser-based design or documentation artifacts.
- Hard dividers, restrained curves, and no ornamental gradients.

## Colors

The palette is restrained: achromatic black, white, and gray neutrals carry the surface, signal coral marks identity and selection, and semantic colors remain rare. Tool containers use the same neutral surface in pending, success, and error states.

### Primary
- **Signal Coral:** Borders, active markers, branded labels, and the single dominant color field.

### Secondary
- **Ready Green:** Positive runtime and context state.
- **Reasoning Pink:** Reasoning-level state where it must remain distinct from brand accents.
- **Command Blue:** The shared `mdLink` role for recognized slash command tokens in the prompt editor, the explicit `/model` affordance, and Markdown links; do not use it decoratively.

### Neutral
- **Console Black / Panel / Raised:** Layered terminal backgrounds.
- **Console Ink / Muted / Dim:** Primary, secondary, and tertiary text.
- **Console Line:** Structural dividers and inactive control outlines.

**The One Signal Rule.** Coral identifies the product or the current action; it is not scattered over every label.

## Typography

**Display Font:** Arial Narrow with system condensed fallbacks
**Body Font:** Arial Narrow with system sans fallbacks
**Label/Mono Font:** Consolas with Cascadia Mono and system monospace fallbacks

**Character:** Display type is compressed and declarative. Terminal type is factual and aligned; it carries commands, paths, measurements, and runtime state rather than acting as a technical costume.

### Hierarchy
- **Display** (800, fluid 3.125–6.5rem, 0.86): Browser concept titles and decision statements only.
- **Headline** (800, fluid 2.375–4.375rem, 0.9): Concept and section titles.
- **Body** (400, 1.125rem, 1.55): Explanations with a bounded reading measure.
- **Terminal** (400, fluid 0.6875–0.9375rem, 1.42): TUI simulations, commands, paths, and status.
- **Label** (700, 0.6875rem, tracked uppercase): Sparse metadata and section labels.

**The Data Earns Mono Rule.** Use monospace for terminal content, state, code, paths, and measurements; use the condensed sans for narrative hierarchy.

## Layout

Browser artifacts use large editorial fields followed by bounded terminal evidence. Sections separate with single-pixel rules and generous vertical space. TUI layouts must collapse from split panels to one column when the available width cannot preserve readable columns; controls and status text truncate before they force horizontal overflow.

## Elevation & Depth

The TUI is flat and layered by tone and borders. Browser captures may use one wide, soft, downward shadow to distinguish a terminal window from the page; no glow is used.

**The Flat Console Rule.** Runtime surfaces use tonal layers and rules, not floating cards.

## Shapes

Terminal frames use restrained 10–13px corners in browser documentation. Internal TUI structures remain square and rely on box-drawing characters or one-pixel dividers. Pills are reserved for genuinely compact state controls, not containers.

## Components

### Terminal Frame
- **Shape:** Restrained outer radius; square internal regions.
- **Background:** Console Black with a Console Panel title bar.
- **Border:** One-pixel Console Line.
- **State:** Signal Coral marks the selected action; Ready Green and Reasoning Pink remain semantic.

### Tool Calls
- **Background:** Console Panel for pending, successful, and failed calls; never use blue, green, or red container fills.
- **Title:** Coral Bright.
- **Status:** Muted sage, rust, or amber text and icons only where status must remain explicit.
- **Output:** Muted neutral text, with restrained semantic colors reserved for actual diffs and errors.

### Prompt Editor
- **Command feedback:** Color recognized slash command tokens and valid prefixes in Command Blue while the user types. Keep arguments, paths, URLs, invalid commands, and sent transcript text in their normal roles.
- **Boundaries:** Recognize commands only at the start of a line or after horizontal whitespace. Styling must not alter submitted text, cursor placement, wrapping, or autocomplete.

### Activity Indicator
- **Mark:** Animate the accent-orange glyph sequence `· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·` at 120 ms per frame; do not use green or a static indicator.
- **Voice:** While an agent run is active, render the same accent orange on `Brewing`, `Pondering`, `Tinkering`, `Wrangling`, `Noodling`, and `Cooking`; shuffle without immediate repeats and change the word every 2.5 seconds.
- **Status:** Show the gray `(esc to interrupt · thinking)` status after the orange verb, with only `esc` bold.
- **Hidden reasoning:** Use the static neutral label `└ Thinking…`.

### Jump Links
- **Shape:** Square outlined controls with compact padding.
- **Default:** Muted text and Console Line border.
- **Hover / Focus:** Signal Coral border with Console Ink text and a visible browser focus outline.

### Compact Startup Card
- **Style:** A neutral 52-column maximum frame with a dim gray `›`, bold white `KillerOS`, and the current package version directly beside the wordmark as `(v<package version>)`. One unboxed tip follows after a blank line.
- **Content:** Reuse the footer signature: bold white metadata-first model name, gray provider, and semantic reasoning, followed immediately by a blue `/model` affordance. The second row contains the directory and appends the active Git branch only when the workspace belongs to a repository; context remains in the footer.
- **Tips:** Shuffle a factual tip bank, choose once per startup, and keep that tip fixed for the session. Exhaust the shuffled bank before repeating.
- **Adaptation:** The card stops growing at 52 columns, truncates the model signature while preserving `/model`, truncates directory and branch together, wraps the external tip, and falls back to the wordmark below 28 columns.

### Terminal Tab Completion Indicator
- **Enabled:** Unnamed sessions render `π - <cwd> 󰂚`; named sessions render `π - <session name> - <cwd> 󰂚`.
- **Disabled:** Omit the suffix and preserve Pi's canonical terminal title.
- **Glyph:** Use Nerd Font `U+F009A`. It is not an emoji, is cosmetic and non-clickable, and must not affect sound delivery when the terminal tab font cannot render it.

### Status Footer
- **Style:** One compact line of real state. The human-readable model name leads in Console Ink; its provider follows in Dim Slate without a separator.
- **Context:** Show direct telemetry such as `82% left (1M)`. At critical pressure, append `/compact`; never use a progress bar.
- **Wide:** Show model, provider, reasoning, context, branch, elapsed time, session cost, and the full path unless an active goal replaces the path.
- **Focused:** Preserve model, provider, context, and a shortened path.
- **Compact:** Preserve model, provider, and context. At emergency widths, preserve context and truncate model identity before overflowing.
- **Adaptation:** Select the richest tier that fits its actual content rather than relying on fixed terminal breakpoints.
- **Goals:** Render an active goal on the right in Warning Amber as `/goal is active (10s)`, `/goal is active (2m 05s)`, or `/goal is active (1h 02m 05s)`; remove lower-priority left telemetry before clipping it. Keep paused and blocked goals persistent in their existing placement. Show completed goals in history and `/goal`, not the footer.

## Do's and Don'ts

### Do:
- **Do** expose model, reasoning, repository, and context state in a consistent scan order.
- **Do** use Signal Coral for product identity and the current action.
- **Do** truncate paths and long model identifiers within terminal width.
- **Do** preserve keyboard-first interaction and theme-aware semantic status.

### Don't:
- **Don't** spend runtime space on decorative containers that carry no task or state.
- **Don't** use glow, gradient text, glass, or ornamental blur.
- **Don't** fabricate repository, session, benchmark, or customer data.
- **Don't** show startup facts that cannot be derived from Pi, package provenance, or a bounded workspace query.
