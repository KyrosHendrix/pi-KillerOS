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
- **Command Blue:** The shared `mdLink` role for the explicit `/model` affordance and Markdown links; do not use it decoratively. Prompt input uses the normal editor text color.

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
- **Frame:** Use no permanent rules or container border. A dim `❯` leads the first input row and turns Signal Coral only while focused; continuation rows begin with two spaces.
- **Response spacing:** Reserve one blank terminal row above the editor so the latest response and next input remain distinct.
- **Suggestion:** While the editor is empty, show one dim `Try "…"` suggestion from a shuffled deck. Keep it fixed for the session and remove it as soon as the user enters text.
- **Command feedback:** Keep typed prompt text in its normal role and use autocomplete to identify valid slash commands. Do not replace an editor factory owned by another extension.
- **Boundaries:** Trigger slash autocomplete only at the start of a line or after horizontal whitespace. Completion must not alter unrelated text, cursor placement, or wrapping. Show compact `↑ N more` or `↓ N more` rows only when the editor scrolls.

### Question Selector
- **Single-select:** Preserve type-to-filter, configured Pi navigation and confirmation, custom answers, previews, and current result rendering.
- **Multi-select:** Use `[ ]` and `[x]` plus text so checked state never depends on color. Keep the focus pointer separate from checked state.
- **Controls:** Show Space as toggle, `/` as filter, and the effective Pi confirmation key as submit. The custom row uses confirmation to add or edit and Space to remove.
- **Status:** Keep `Selected N` and the required range visible before lower-priority preview detail. Reject excess choices without replacing existing checks.
- **Filtering:** Render filter editing as a distinct input state. Applied filters may hide checked options but never clear them.
- **Transcript:** Compact results show selected names followed by an exact `+N more` overflow; expanded results show every answer in original option order with custom text last.
- **Adaptation:** At tiny heights preserve the focused choice or selected count, then controls; never exceed terminal width or height.

### Activity Indicator
- **Mark:** Animate the accent-orange glyph sequence `· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·` at 120 ms per frame; do not use green or a static indicator.
- **Voice:** Derive the coral leading verb from real lifecycle events: `Mapping…` at request start; `Inspecting…` for read, grep, find, or list; `Changing…` for edit or write; `Running…` for commands; `Working…` for a sanitized custom tool name; `Reviewing…` after a successful tool result; `Recovering…` after a failed tool result; and `Responding…` when assistant text begins.
- **Status:** Follow the verb with a gray parenthetical that names the observed action. Keep only `esc` bold and never infer verification, progress, or an ETA from a command.
- **Hidden reasoning:** Use the static neutral label `└ Thinking…`.

### Settled Line
- **Outcome:** Render exactly one `✓ Done`, `■ Stopped`, or `× Failed` line followed by a dim middle dot and compact elapsed time. Use Success, Warning, or Error on the outcome respectively.
- **Truth:** Map Pi's final assistant stop reason directly; missing or non-terminal reasons fail closed to `Failed`.
- **History:** Keep valid version-1 `✻ Worked for …` session entries readable. Do not rewrite stored history or add a metrics panel.

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
- **Style:** Place a full-width Console Line Muted divider directly beneath the prompt editor, followed by two compact decks. The primary row leads with the human-readable model name in Console Ink and provider in Dim Slate, then reasoning and context; show elapsed time and session cost when space permits. The secondary row holds branch and workspace path.
- **Context:** Show direct telemetry such as `82% left (1M)`. At critical pressure, append `/compact`; never use a progress bar.
- **Wide:** Render the divider plus primary and secondary rows. The primary row shows model, provider, reasoning, context, elapsed time, and session cost; the secondary row shows branch and full path unless an active goal takes its right-side slot.
- **Focused:** Preserve model, provider, and context on the primary row, plus a shortened path on the secondary row.
- **Compact:** Preserve model, provider, and context. At emergency widths, preserve context and truncate model identity before overflowing; the secondary row may reduce to goal status or remain blank.
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
