# Changelog

All notable changes to KillerOS are documented here.

## [1.2.0] - 2026-07-30

### Added

- A 52-column Compact startup card with inline version, polished model/provider identity, reasoning level, `/model`, working directory, and conditional Git branch.
- A shuffled startup-tip deck that keeps one tip stable per session and exhausts the bank before repeating.
- A responsive footer that preserves model and context while progressively removing lower-priority telemetry.
- Packaged KillerOS theme with coral accents and one neutral tool-call surface across pending, success, and error states.
- Single-glyph Spark activity indicator with a restrained color pulse.
- Claude-adjacent activity word bank that advances between agent runs.
- Static `└ Thinking…` label for hidden reasoning blocks.
- Responsive header and footer tests across narrow terminal widths.

### Changed

- Replaced the animated startup illustration and capability inventory with the Compact startup card and one external tip.
- Standardized product branding on mixed-case `KillerOS` and the neutral `› KillerOS (v1.2.0)` lockup.
- Made theme neutrals achromatic while preserving the coral accent.
- Replaced the footer progress bar with direct `percent left (tokens)` context telemetry and a critical `/compact` prompt.
