import assert from "node:assert/strict";
import test from "node:test";
import { formatContextProgress } from "../Killeros.ts";
import { formatCwd, formatTime, formatTokens } from "../killeros/display.ts";
import { theme } from "./ExtensionTestHarness.ts";

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

test("context telemetry uses plain language without a progress bar", () => {
  assert.equal(formatContextProgress(50_000, 1_050_000, theme), "95% left (1M)");
  assert.equal(formatContextProgress(860_000, 1_000_000, theme), "14% left (140k) · /compact");
  assert.equal(formatContextProgress(null, 1_000_000, theme), "—% left (—)");
  assert.equal(formatContextProgress(Number.NaN, 1_000_000, theme), "—% left (—)");
  assert.doesNotMatch(formatContextProgress(50_000, 1_050_000, theme), /[█░]/u);
});
