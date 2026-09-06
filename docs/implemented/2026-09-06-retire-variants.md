# Retire /variants (keep /init)

STATUS: DONE

Pi owns thinking-level selection with its native `/thinking` selector (since
Pi 0.84.3; our floor is 0.85.0, so no version gate is needed). KillerOS drops
its duplicate command. `/init` stays: no successor exists and `InitRuntime`
gates the goal system.

## Decisions (from grill)

1. `/init` is out of scope. Nothing about it changes.
2. Removal depth: the `/variants` command, picker UI, and aliases go.
   `LEVEL_COLORS` and the thinking-level type stay, since the footer
   (`killeros/footer.ts:10`) and the startup header
   (`killeros/shell-ui.ts:28`) import them to render the current level.
3. The startup tip is repointed at `/thinking`, not dropped. The tip deck
   stays at 10.

## Scope

Delete:

- `registerVariants` and the `/variants` command in `killeros/variants.ts`
  (command registration, picker, aliases, direct-level path).
- The `variants` entry in `COMMAND_SYNTAX_HINTS` (`killeros/commands.ts:75`).
- README `/variants` lines (feature list and command table).
- `test/Variants.test.ts` in full. All 4 tests exercise the command
  only; none covers the kept color map.
- One `CHANGELOG.md` entry under Unreleased (command removal is notable).

Keep:

- `LEVEL_COLORS` and the thinking-level type for footer/header rendering.
  Move them only if the keeper module needs a neutral home; no behavior
  change either way.
- Footer and header level display, and all 8 `thinking*` theme roles.

Change:

- Startup tip text to `Run /thinking to tune the model's reasoning depth.`
- `Killeros.ts` extension wiring (drop `registerVariants`).

No change needed: slash autocomplete builds from `pi.getCommands()`, so
`/variants` disappears from suggestions once unregistered.

## Verification

- `npm run check`.
- `ShellUi.test.ts` tip-deck test still passes with the repointed tip.
  It asserts a 10-tip deck, which repointing preserves (dropping would
  have broken it).
- Footer tests still pass with the kept color map.
- `test/Variants.test.ts` deleted in full with the command; no coverage remains for it.

## Open risk

If Pi ever renames `/thinking`, the repointed tip misnames it. Low likelihood,
one-line fix.
