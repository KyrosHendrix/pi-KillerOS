import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type ThemeJson = { colors: Record<string, string>; vars: Record<string, string> };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isUnknownRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function readThemeFixture(): ThemeJson {
  const value: unknown = JSON.parse(readFileSync(new URL("../themes/killeros.json", import.meta.url), "utf8"));
  assert.ok(isUnknownRecord(value) && isStringRecord(value.colors) && isStringRecord(value.vars));
  return { colors: value.colors, vars: value.vars };
}

test("uses one neutral background for every tool state", () => {
  const killerosTheme = readThemeFixture();
  assert.equal(killerosTheme.colors.toolPendingBg, "surface");
  assert.equal(killerosTheme.colors.toolSuccessBg, "surface");
  assert.equal(killerosTheme.colors.toolErrorBg, "surface");
});

test("uses achromatic neutrals without changing the coral accent", () => {
  const killerosTheme = readThemeFixture();
  assert.equal(killerosTheme.vars.coral, "#d77757");
  assert.equal(killerosTheme.vars.coralBright, "#e58b6d");

  for (const name of ["canvas", "surface", "surfaceRaised", "line", "lineMuted", "text", "muted", "dim"]) {
    const match = /^#(..)(..)(..)$/.exec(killerosTheme.vars[name]);
    assert.ok(match);
    const [, red, green, blue] = match;
    assert.equal(red, green, `${name} must not have a color cast`);
    assert.equal(green, blue, `${name} must not have a color cast`);
  }
});

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("reasoning text meets normal-text contrast on KillerOS surfaces", () => {
  const killerosTheme = readThemeFixture();
  for (const role of ["thinkingMinimal", "thinkingLow"]) {
    const foreground = killerosTheme.colors[role].startsWith("#")
      ? killerosTheme.colors[role]
      : killerosTheme.vars[killerosTheme.colors[role]];
    for (const background of [killerosTheme.vars.surface, killerosTheme.vars.surfaceRaised]) {
      assert.ok(contrastRatio(foreground, background) >= 4.5, `${role} must reach 4.5:1`);
    }
  }
});

test("shell UI uses theme roles instead of raw ANSI colors", () => {
  const source = readFileSync(new URL("../killeros/shell-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /38;2;|\\x1B\[90m|COMMAND_BLUE_RGB/u);
});
