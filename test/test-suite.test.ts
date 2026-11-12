import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assignShards, exactNames, lifecycles, lifecycleUnits, parseConcurrency, parseShard, recordTimings, runUnits, testFiles, testTimings,
  testUnits, unitArguments, unitFailed, unitSeconds, unitTarget, unmeasuredSeconds, type TestUnit, type Unit,
} from "../scripts/test-suite.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Whether `unit` runs the top-level test `name`, judged by the same pattern Node receives. */
function runsTest(unit: Unit, name: string): boolean {
  const pattern = unitArguments(unit).find((argument) => /^--test-(name|skip)-pattern=/u.test(argument));
  if (!pattern) return true;
  const matches = new RegExp(pattern.slice(pattern.indexOf("=") + 1), "u").test(name);
  return pattern.startsWith("--test-name-pattern=") ? matches : !matches;
}

test("every test file runs in exactly one shard for any shard count", () => {
  const files = testFiles();
  assert.ok(files.includes("test/RepositoryContracts.test.ts") && files.includes("test/test-suite.test.ts"));
  assert.ok(files.every((file) => /^test\/[^/]+\.test\.[^/]+$/u.test(file)), "Only files named *.test.*");
  const units = [...testUnits(files, unitSeconds.min), ...lifecycleUnits(5)];
  for (let total = 1; total <= 16; total++) {
    const assigned = assignShards(units, total).flatMap((shard) => shard.units);
    assert.deepEqual(assigned.map((unit) => unit.name).sort(), units.map((unit) => unit.name).sort(), `${total} shard(s) must run each unit once`);
  }
  for (const target of [unitSeconds.min, unitSeconds.max]) {
    assert.deepEqual([...new Set(testUnits(files, target).map((unit) => unit.file))], files, `Every file has at least one unit at ${target}s`);
  }
});

test("lifecycle repeats keep CI's plain Node flags and select existing tests", () => {
  const units = lifecycleUnits(5);
  assert.equal(units.length, lifecycles.length * 5);
  assert.equal(new Set(units.map((unit) => unit.name)).size, units.length, "Each repeat is its own named unit");
  assert.deepEqual(lifecycleUnits(0), [], "Runs add no repeats unless asked");
  for (const unit of units) {
    const args = unitArguments(unit);
    assert.deepEqual(args.slice(0, 2), ["--test", "--experimental-strip-types"], unit.name);
    assert.ok(!args.includes("--test-force-exit"), `${unit.name}: a leaked handle must hang the repeat`);
    assert.ok(!args.includes("--import"), `${unit.name}: no shared test setup`);
    assert.deepEqual(args.slice(-unit.files.length), unit.files);
  }
  for (const lifecycle of lifecycles) {
    const sources = lifecycle.files.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    const pattern: string | undefined = "pattern" in lifecycle ? lifecycle.pattern : undefined;
    for (const title of pattern?.split("|") ?? []) {
      // Some files name their test through a constant, so the title must start a string literal in one of its files.
      assert.ok(sources.some((source) => source.includes(`"${title}`) || source.includes(`\`${title}`)),
        `${lifecycle.name}: "${title}" must start an existing test name`);
    }
  }
});

test("a lifecycle unit ignores file-named results from files its pattern skips", () => {
  const unit: Unit = { kind: "lifecycle", name: "sample", files: ["test/a.test.ts", "test/b.test.ts"], pattern: "x", seconds: 1 };
  assert.ok(!unitFailed({ unit, code: 0, topLevel: [{ name: "x", milliseconds: 1 }, { name: "test\\b.test.ts", milliseconds: 1 }] }));
  assert.ok(unitFailed({ unit, code: 0, topLevel: [{ name: "test\\a.test.ts", milliseconds: 1 }, { name: "test/b.test.ts", milliseconds: 1 }] }));
  assert.ok(unitFailed({ unit, code: 1, topLevel: [{ name: "x", milliseconds: 1 }] }));
});

test("timings name only existing test files", () => {
  for (const file of Object.keys(testTimings)) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `Remove stale timings for ${file}`);
});

test("every timed test, and any test the timings lack, runs in exactly one unit", () => {
  for (const [file, tests] of Object.entries(testTimings)) {
    for (const target of [unitSeconds.min, unitSeconds.max]) {
      const units = testUnits([file], target);
      for (const name of [...Object.keys(tests), "a test added after the timings were recorded"]) {
        assert.equal(units.filter((unit) => runsTest(unit, name)).length, 1, `${file} at ${target}s: "${name}" must run in exactly one unit`);
      }
    }
  }
});

test("tests pack into units of about the target, and a file that fits one unit runs whole", () => {
  const timings = { "test/split.test.ts": { long: 20, a: 8, b: 6, c: 1 }, "test/small.test.ts": { x: 2, y: 3 } };
  const units = testUnits(["test/split.test.ts", "test/small.test.ts", "test/new.test.ts"], 15, timings);
  assert.deepEqual(units.map(({ name, seconds, select }) => ({ name, seconds, select })), [
    { name: "split#1", seconds: 20, select: { mode: "only", tests: ["long"] } },
    { name: "split#rest", seconds: 15, select: { mode: "skip", tests: ["long"] } },
    { name: "small", seconds: 5, select: undefined },
    { name: "new", seconds: unmeasuredSeconds, select: undefined },
  ], "The smallest group skips the others, so it also runs tests the timings lack");
  assert.deepEqual(testUnits(["test/split.test.ts"], 40, timings).map((unit) => unit.name), ["split"], "A larger target keeps the file whole");
});

test("the unit target gives about three units per worker slot within its bounds", () => {
  const timings = { "test/a.test.ts": { a: 450, b: 450 } };
  assert.equal(unitTarget(10, timings), 30, "900 s over 10 slots is three units of 30 s per slot");
  assert.equal(unitTarget(30, timings), unitSeconds.min, "Many slots never shrink units below the minimum");
  assert.equal(unitTarget(1, timings), unitSeconds.max, "Few slots never grow units past the maximum");
});

test("exact name patterns escape regular expression syntax", () => {
  const pattern = new RegExp(exactNames(["a (b) [c] 1.5+?", "x|y"]), "u");
  assert.ok(pattern.test("a (b) [c] 1.5+?") && pattern.test("x|y"));
  assert.ok(!pattern.test("a (b) [c] 1x5") && !pattern.test("x") && !pattern.test("prefix x|y"));
});

test("shards balance estimated time, longest units first", () => {
  const timings = { "test/a.test.ts": { a: 9 }, "test/b.test.ts": { b: 7 }, "test/c.test.ts": { c: 5 }, "test/d.test.ts": { d: 3 } };
  const shards = assignShards(testUnits(Object.keys(timings), 15, timings), 2);
  assert.deepEqual(shards.map((shard) => shard.units.map((unit) => unit.name)), [["a", "d"], ["b", "c"]]);
  assert.deepEqual(shards.map((shard) => shard.seconds), [12, 12]);
});

test("shard selectors must be <index>/<total> within range", () => {
  assert.deepEqual(parseShard("3/6"), { index: 3, total: 6 });
  for (const value of ["0/6", "7/6", "1", "1/0", "a/b", "1/6/2"]) assert.throws(() => parseShard(value), /<index>\/<total>/u, value);
});

test("concurrency must be a positive integer", () => {
  assert.equal(parseConcurrency("3"), 3);
  for (const value of ["0", "-1", "1.5", "two", "auto"]) assert.throws(() => parseConcurrency(value), /positive concurrency/u, value);
});

test("recorded timings read local and CI suite output by file and top-level test", () => {
  const files = ["test/Footer.e2e.test.ts", "test/Theme.test.ts"];
  const local = [
    "[Footer.e2e#1] ✔ footer first (1234.5ms)",
    "[Footer.e2e#1]   ✔ nested subtest (99ms)",
    "[Footer.e2e#rest] ✖ footer second (20ms)",
    "[Footer.e2e#rest] ✔ test\\Footer.e2e.test.ts (5ms)",
    "[Unknown] ✔ unknown file (1ms)",
    "[Theme] ﹣ skipped theme (0.2ms) # SKIP",
  ].join("\n");
  const ci = "Quality tests (2/7)\tTest shard\t2026-11-03T15:06:16.0000000Z [Theme] ✔ theme contrast (51ms)\r\n";
  assert.deepEqual(recordTimings([local, ci], files), {
    "test/Footer.e2e.test.ts": { "footer first": 1.2, "footer second": 0 },
    "test/Theme.test.ts": { "skipped theme": 0, "theme contrast": 0.1 },
  });
});

test("dry run prints every shard without running tests", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/test-suite.ts", "--shard", "2/3", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.match(output, /^shard 1\/3: ~\d+s$/mu);
  assert.match(output, /^shard 3\/3: ~\d+s$/mu);
  // Which files split depends on the recorded timings, so match any split file's listed and remaining units.
  assert.match(output, /^ {2}\S+#1 ~\d+s$/mu);
  assert.match(output, /^ {2}\S+#rest ~\d+s$/mu);
  assert.doesNotMatch(output, /ℹ tests/u, "A dry run must not start the test runner");
});

test("the suite runs a shard and prefixes output by unit", () => {
  // With one shard per unit, the last shard holds exactly one of the shortest units. That many slots keep the minimum target.
  const total = testUnits(testFiles(), unitSeconds.min).length;
  assert.equal(unitTarget(total), unitSeconds.min);
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
  const run = async (select: TestUnit["select"]) => {
    const [result] = await runUnits([{ kind: "tests", name: "sample", file, seconds: 1, select }], 1);
    return { ...result, names: result.topLevel.map((test) => test.name) };
  };

  const renamed = await run({ mode: "only", tests: ["renamed test"] });
  assert.equal(renamed.code, 0, "Node exits successfully when a name pattern matches nothing");
  assert.deepEqual(renamed.names, [file], "Node reports the file itself instead");
  assert.ok(unitFailed(renamed));
  const partial = await run({ mode: "only", tests: ["first (a)", "renamed test"] });
  assert.deepEqual(partial.names, ["first (a)"]);
  assert.ok(unitFailed(partial), "Every listed test must run");
  const everythingSkipped = await run({ mode: "skip", tests: ["first (a)", "second"] });
  assert.ok(unitFailed(everythingSkipped));

  const part = await run({ mode: "only", tests: ["first (a)"] });
  assert.deepEqual(part.names, ["first (a)"], "Subtests are not top-level results");
  assert.ok(part.topLevel.every((test) => Number.isFinite(test.milliseconds)), "Results carry their duration");
  assert.ok(!unitFailed(part));
  const rest = await run({ mode: "skip", tests: ["first (a)"] });
  assert.deepEqual(rest.names, ["second"]);
  assert.ok(!unitFailed(rest));
  const whole = await run(undefined);
  assert.deepEqual(whole.names, ["first (a)", "second"]);
  assert.ok(!unitFailed(whole));
});
