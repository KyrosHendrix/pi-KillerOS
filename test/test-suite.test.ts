import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assignShards, exactNames, parseShard, runUnits, testFiles, testParts, testSeconds, testUnits, unitArguments, unitFailed, unmeasuredSeconds,
} from "../scripts/test-suite.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Names of a test file's top-level tests, read from `test("name"` calls at the start of a line. */
function topLevelTests(file: string): string[] {
  return [...readFileSync(new URL(`../${file}`, import.meta.url), "utf8").matchAll(/^test\((["'`])(.+?)\1/gmu)].map((match) => match[2]);
}

test("every test file runs in exactly one shard for any shard count", () => {
  const files = testFiles();
  assert.ok(files.includes("test/RepositoryContracts.test.ts") && files.includes("test/test-suite.test.ts"));
  assert.ok(files.every((file) => /^test\/[^/]+\.test\.[^/]+$/u.test(file)), "Only files named *.test.*");
  const units = testUnits(files);
  for (let total = 1; total <= 10; total++) {
    const assigned = assignShards(units, total).flatMap((shard) => shard.units);
    assert.deepEqual(assigned.map((unit) => unit.name).sort(), units.map((unit) => unit.name).sort(), `${total} shard(s) must run each unit once`);
  }
  assert.deepEqual([...new Set(units.map((unit) => unit.file))], files, "Every file has at least one unit");
});

test("timings and parts name only existing files and top-level tests", () => {
  const seconds: Readonly<Record<string, number>> = testSeconds;
  for (const file of Object.keys(seconds)) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `Remove stale timing ${file}`);
  for (const [file, parts] of Object.entries(testParts)) {
    const names = topLevelTests(file);
    const listed: readonly string[] = parts.flatMap((part) => part.tests);
    assert.equal(new Set(listed).size, listed.length, `${file}: a test belongs to one part`);
    for (const name of listed) assert.ok(names.includes(name), `${file} has no top-level test "${name}"`);
    assert.ok(names.some((name) => !listed.includes(name)), `${file}: the rest part must keep at least one test`);
    assert.ok(parts.reduce((sum, part) => sum + part.seconds, 0) < (seconds[file] ?? 0), `${file}: parts must leave seconds for the rest`);
  }
});

test("a split file runs each top-level test in exactly one unit", () => {
  for (const [file, parts] of Object.entries(testParts)) {
    const names = topLevelTests(file);
    const units = testUnits([file]);
    assert.equal(units.length, parts.length + 1);
    for (const name of names) {
      const runs = units.filter((unit) => {
        const pattern = unitArguments(unit).find((argument) => /^--test-(name|skip)-pattern=/u.test(argument));
        assert.ok(pattern, `${unit.name} must select tests`);
        const matches = new RegExp(pattern.slice(pattern.indexOf("=") + 1), "u").test(name);
        return pattern.startsWith("--test-name-pattern=") ? matches : !matches;
      });
      assert.equal(runs.length, 1, `${file}: "${name}" must run in exactly one unit`);
    }
  }
});

test("exact name patterns escape regular expression syntax", () => {
  const pattern = new RegExp(exactNames(["a (b) [c] 1.5+?", "x|y"]), "u");
  assert.ok(pattern.test("a (b) [c] 1.5+?") && pattern.test("x|y"));
  assert.ok(!pattern.test("a (b) [c] 1x5") && !pattern.test("x") && !pattern.test("prefix x|y"));
});

test("shards balance estimated time and keep unmeasured files", () => {
  const units = testUnits(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/new.test.ts"]);
  assert.deepEqual(assignShards(units, 2).map((shard) => shard.seconds), [unmeasuredSeconds * 3, unmeasuredSeconds * 2]);
  const measured = assignShards(testUnits(["test/Handoff.e2e.test.ts", "test/Editor.e2e.test.ts", "test/runtime-tools.e2e.test.ts", "test/Theme.test.ts"]), 2);
  assert.deepEqual(measured.map((shard) => shard.units.map((unit) => unit.name)), [
    ["Handoff.e2e", "Theme"],
    ["runtime-tools.e2e", "Editor.e2e"],
  ], "The slowest units go to different shards, longest first");
});

test("shard selectors must be <index>/<total> within range", () => {
  assert.deepEqual(parseShard("3/6"), { index: 3, total: 6 });
  for (const value of ["0/6", "7/6", "1", "1/0", "a/b", "1/6/2"]) assert.throws(() => parseShard(value), /<index>\/<total>/u, value);
});

test("dry run prints every shard without running tests", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/test-suite.ts", "--shard", "2/3", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.match(output, /^shard 1\/3: ~\d+s$/mu);
  assert.match(output, /^shard 3\/3: ~\d+s$/mu);
  assert.match(output, /^ {2}Footer\.e2e#1 ~\d+s$/mu);
  assert.match(output, /^ {2}Footer\.e2e#rest ~\d+s$/mu);
  assert.doesNotMatch(output, /ℹ tests/u, "A dry run must not start the test runner");
});

test("the suite runs a shard and prefixes output by unit", () => {
  // With one shard per unit, the last shard holds exactly one of the shortest units.
  const total = testUnits(testFiles()).length;
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/test-suite.ts", "--shard", `${total}/${total}`, "--concurrency", "1"],
    { cwd: root, encoding: "utf8" });
  assert.match(output, /^\[[^\]]+\] ℹ tests [1-9]\d*$/mu);
  assert.match(output, /^1 units, [1-9]\d* top-level tests, 0 failed units, \d+s$/mu);
});

test("a unit fails when it runs none or only some of its tests", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sample.test.mjs");
  writeFileSync(file, "import test from \"node:test\";\ntest(\"first (a)\", async (t) => { await t.test(\"child\", () => {}); });\ntest(\"second\", () => {});\n");
  const run = async (select: NonNullable<Parameters<typeof unitArguments>[0]["select"]> | undefined) =>
    (await runUnits([{ name: "sample", file, seconds: 1, select }], 1))[0];

  const renamed = await run({ mode: "only", tests: ["renamed test"] });
  assert.equal(renamed.code, 0, "Node exits successfully when a name pattern matches nothing");
  assert.deepEqual(renamed.topLevel, [file], "Node reports the file itself instead");
  assert.ok(unitFailed(renamed));
  const partial = await run({ mode: "only", tests: ["first (a)", "renamed test"] });
  assert.deepEqual(partial.topLevel, ["first (a)"]);
  assert.ok(unitFailed(partial), "Every listed test must run");
  const everythingSkipped = await run({ mode: "skip", tests: ["first (a)", "second"] });
  assert.ok(unitFailed(everythingSkipped));

  const part = await run({ mode: "only", tests: ["first (a)"] });
  assert.deepEqual(part.topLevel, ["first (a)"], "Subtests are not top-level results");
  assert.ok(!unitFailed(part));
  const rest = await run({ mode: "skip", tests: ["first (a)"] });
  assert.deepEqual(rest.topLevel, ["second"]);
  assert.ok(!unitFailed(rest));
  const whole = await run(undefined);
  assert.deepEqual(whole.topLevel, ["first (a)", "second"]);
  assert.ok(!unitFailed(whole));
});
