import assert from "node:assert/strict";
import test from "node:test";
import { formatContextProgress } from "../Killeros.ts";
import { formatCwd, formatTime, formatTokens } from "../killeros/display.ts";
import { theme } from "./ExtensionTestHarness.ts";
import { themeTestAdapter } from "./PiTestAdapters.ts";

test("time formatting preserves seconds across every unit boundary", () => {
  const cases: ReadonlyArray<readonly [milliseconds: number, expected: string]> = [
    [Number.NaN, "0s"],
    [Number.POSITIVE_INFINITY, "0s"],
    [Number.NEGATIVE_INFINITY, "0s"],
    [-1, "0s"],
    [0, "0s"],
    [999, "0s"],
    [1_000, "1s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [65_000, "1m 05s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "1h 00m 00s"],
    [3_725_000, "1h 02m 05s"],
    [90_061_000, "25h 01m 01s"],
  ];
  for (const [milliseconds, expected] of cases) assert.equal(formatTime(milliseconds), expected);
});

test("display formatters contain non-finite telemetry and honor Windows path casing", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(formatTokens(value), "0");
  }
  assert.equal(
    formatCwd("/__killeros_terminal_test__/\x1b]2;owned\x07\x1b[31mrepo\x1b[0m\nname\0"),
    "/__killeros_terminal_test__/reponame",
  );

  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { value: "win32" });
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  delete process.env.HOME;
  process.env.USERPROFILE = "C:\\Users\\Example";
  try {
    assert.equal(formatCwd("c:\\users\\example\\repo"), "~\\repo");
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});

test("token unit thresholds follow rounding", () => {
  assert.equal(formatTokens(999.6), "1k");
  assert.equal(formatTokens(999999), "1M");
});

test("context telemetry shows the remaining percentage with urgency colors", () => {
  const semanticTheme = themeTestAdapter({
    ...theme,
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  });
  const cases: ReadonlyArray<readonly [tokens: number | null, window: number, expected: string]> = [
    [0, 1_000_000, "<success>ctx 100%</success>"],
    [300_000, 1_000_000, "<success>ctx 70%</success>"],
    [50_000, 1_050_000, "<success>ctx 95%</success>"],
    [500_000, 1_000_000, "<warning>ctx 50%</warning>"],
    [700_000, 1_000_000, "<warning>ctx 30%</warning>"],
    [800_000, 1_000_000, "<warning>ctx 20%</warning>"],
    [810_000, 1_000_000, "<error>ctx 19%</error>"],
    [850_000, 1_000_000, "<error>ctx 15% · /compact</error>"],
    [860_000, 1_000_000, "<error>ctx 14% · /compact</error>"],
    [1_000_000, 1_000_000, "<error>ctx 0% · /compact</error>"],
    [1_100_000, 1_000_000, "<error>ctx 0% · /compact</error>"],
    [-1, 1_000_000, "<success>ctx 100%</success>"],
    [64_000, Number.NaN, "<warning>ctx 50%</warning>"],
    [null, 1_000_000, "<dim>ctx —%</dim>"],
    [Number.NaN, 1_000_000, "<dim>ctx —%</dim>"],
    [Number.POSITIVE_INFINITY, 1_000_000, "<dim>ctx —%</dim>"],
  ];

  for (const [tokens, window, expected] of cases) {
    assert.equal(formatContextProgress(tokens, window, semanticTheme), expected);
  }
  assert.doesNotMatch(formatContextProgress(50_000, 1_050_000, theme), /[█░]/u);
});
