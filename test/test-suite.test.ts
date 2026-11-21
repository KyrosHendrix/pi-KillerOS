import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isBunRuntime, nodeExecutable } from "./support/NodeRuntime.ts";
import {
  assignShards,
  exactNames,
  lifecycles,
  lifecycleUnits,
  nodeOnlyFiles,
  parseConcurrency,
  parseShard,
  parseTopLevel,
  recordTimings,
  runSuite,
  runUnits,
  testFiles,
  testTimings,
  testUnits,
  unitArguments,
  unitFailed,
  unitRunner,
  unitSeconds,
  unitTarget,
  unmeasuredSeconds,
  type Unit,
} from "../scripts/test-suite.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

function runsTest(unit: Unit, name: string): boolean {
  const args = unitArguments(unit);
  if (args.includes("-t"))
    return new RegExp(args[args.indexOf("-t") + 1], "u").test(name);
  const pattern = args.find((argument) =>
    /^--test-(name|skip)-pattern=/u.test(argument),
  );
  if (!pattern) return true;
  const matches = new RegExp(pattern.slice(pattern.indexOf("=") + 1), "u").test(
    name,
  );
  return pattern.startsWith("--test-name-pattern=") ? matches : !matches;
}

const reporter = isBunRuntime() ? [] : ["--experimental-strip-types"];

test("the runner uses Node for native PTY scenarios and Node-specific contracts", () => {
  const files = testFiles();
  const terminalTests = files.filter((file) =>
    /PiTerminalProcess\.ts["']|\brunTurns\(/u.test(
      readFileSync(path.join(root, file), "utf8"),
    ),
  );
  assert.deepEqual(
    [...nodeOnlyFiles].sort(),
    [
      ...terminalTests,
      "test/RepositoryContracts.test.ts",
      "test/ScenarioFailure.test.ts",
    ].sort(),
  );
  for (const unit of testUnits(files, unitSeconds.max)) {
    assert.equal(
      unitRunner(unit),
      nodeOnlyFiles.has(unit.file) ? "node" : "bun",
      unit.file,
    );
  }
});

test("every test file runs in exactly one shard for any shard count", () => {
  const files = testFiles();
  assert.ok(
    files.includes("test/RepositoryContracts.test.ts") &&
      files.includes("test/test-suite.test.ts"),
  );
  assert.ok(
    files.every((file) => /^test\/[^/]+\.test\.[^/]+$/u.test(file)),
    "Only files named *.test.*",
  );
  const units = [...testUnits(files, unitSeconds.min), ...lifecycleUnits(5)];
  for (let total = 1; total <= 16; total++) {
    const assigned = assignShards(units, total).flatMap((shard) => shard.units);
    assert.deepEqual(
      assigned.map((unit) => unit.name).sort(),
      units.map((unit) => unit.name).sort(),
      `${total} shard(s) must run each unit once`,
    );
  }
  for (const target of [unitSeconds.min, unitSeconds.max]) {
    assert.deepEqual(
      [...new Set(testUnits(files, target).map((unit) => unit.file))],
      files,
      `Every file has at least one unit at ${target}s`,
    );
  }
});

test("lifecycle repeats keep CI's plain Node flags and select existing tests", () => {
  const units = lifecycleUnits(5);
  assert.equal(units.length, lifecycles.length * 5);
  assert.equal(
    new Set(units.map((unit) => unit.name)).size,
    units.length,
    "Each repeat is its own named unit",
  );
  assert.deepEqual(lifecycleUnits(0), [], "Runs add no repeats unless asked");
  for (const unit of units) {
    assert.equal(unitRunner(unit), "node");
    const args = unitArguments(unit);
    assert.deepEqual(
      args.slice(0, 2),
      ["--test", "--experimental-strip-types"],
      unit.name,
    );
    assert.ok(
      !args.includes("--test-force-exit"),
      `${unit.name}: a leaked handle must hang the repeat`,
    );
    assert.ok(!args.includes("--import"), `${unit.name}: no shared test setup`);
    assert.deepEqual(args.slice(-unit.files.length), unit.files);
  }
  for (const lifecycle of lifecycles) {
    const sources = lifecycle.files.map((file) =>
      readFileSync(new URL(`../${file}`, import.meta.url), "utf8"),
    );
    const pattern: string | undefined =
      "pattern" in lifecycle ? lifecycle.pattern : undefined;
    for (const title of pattern?.split("|") ?? []) {
      assert.ok(
        sources.some(
          (source) =>
            source.includes(`"${title}`) || source.includes(`\`${title}`),
        ),
        `${lifecycle.name}: "${title}" must start an existing test name`,
      );
    }
  }
});

test("lifecycle subsets run only the selected files of a shared scenario", () => {
  const units = lifecycleUnits(
    2,
    ["Pi cancellation"],
    ["test/Goals.e2e.test.ts", "test/runtime-startup.e2e.test.ts"],
  );
  assert.deepEqual(
    units.map(({ name, files, pattern }) => ({ name, files, pattern })),
    [
      {
        name: "Pi cancellation (repeat 1/2)",
        files: ["test/Goals.e2e.test.ts"],
        pattern:
          "continuation dispatch respects idle, pending, and cancellation gates",
      },
      {
        name: "Pi cancellation (repeat 2/2)",
        files: ["test/Goals.e2e.test.ts"],
        pattern:
          "continuation dispatch respects idle, pending, and cancellation gates",
      },
    ],
  );
  assert.deepEqual(lifecycleUnits(1, []), []);
});

test("a lifecycle unit ignores file-named results from files its pattern skips", () => {
  const unit: Unit = {
    kind: "lifecycle",
    name: "sample",
    files: ["test/a.test.ts", "test/b.test.ts"],
    pattern: "x",
    seconds: 1,
  };
  assert.ok(
    !unitFailed({
      unit,
      code: 0,
      topLevel: [
        { name: "x", milliseconds: 1 },
        { name: "test\\b.test.ts", milliseconds: 1 },
      ],
    }),
  );
  assert.ok(
    unitFailed({
      unit,
      code: 0,
      topLevel: [
        { name: "test\\a.test.ts", milliseconds: 1 },
        { name: "test/b.test.ts", milliseconds: 1 },
      ],
    }),
  );
  assert.ok(
    unitFailed({ unit, code: 1, topLevel: [{ name: "x", milliseconds: 1 }] }),
  );
});

test("timings name only existing test files", () => {
  for (const file of Object.keys(testTimings))
    assert.ok(
      existsSync(new URL(`../${file}`, import.meta.url)),
      `Remove stale timings for ${file}`,
    );
});

test("computed blob-limit titles retain their recorded timings", () => {
  const file = "test/runtime-receipt-git.e2e.test.ts";
  const measured = Object.fromEntries(
    Object.entries(testTimings[file]).filter(([title]) =>
      title.startsWith("real Pi receipts enforce blob storage limits"),
    ),
  );
  const units = testUnits([file], 100, {
    [file]: { ...measured, "real Pi receipts enforce the old limit": 90 },
  });
  assert.equal(Object.keys(measured).length, 3);
  assert.deepEqual(
    units.map(({ seconds }) => seconds),
    [
      Math.round(
        Object.values(measured).reduce((sum, seconds) => sum + seconds, 0),
      ),
    ],
  );
});

test("session-boundary timings survive title filtering", () => {
  const file = "test/CompactionSessionBoundaries.e2e.test.ts";
  const expected = Math.round(
    Object.values(testTimings[file]).reduce((sum, seconds) => sum + seconds, 0),
  );
  assert.deepEqual(
    testUnits([file], 100).map(({ seconds }) => seconds),
    [expected],
  );
});

test("opaque title expressions preserve recorded timings for the file", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "opaque.test.ts");
  writeFileSync(
    file,
    'const name = ["computed", "title"].join(" ");\ntest(name, () => {});',
  );
  assert.deepEqual(
    testUnits([file], 100, { [file]: { "computed title": 19 } }).map(
      ({ seconds }) => seconds,
    ),
    [19],
  );
});

test("lifecycle units require a real result for every top-level alternative", () => {
  const unit = {
    kind: "lifecycle",
    name: "sample branches",
    files: ["test/a.test.ts", "test/b.test.ts"],
    pattern: "^first (x|y)$|^second [|]$|^third \\|$",
    seconds: 1,
  } satisfies Unit;
  const topLevel = ["first x", "second |", unit.files[1]].map((name) => ({
    name,
    milliseconds: 1,
  }));
  assert.equal(unitFailed({ unit, code: 0, topLevel }), true);
  topLevel.push({ name: "third |", milliseconds: 1 });
  assert.equal(unitFailed({ unit, code: 0, topLevel }), false);
});

test("every timed test, and any test the timings lack, runs in exactly one unit", () => {
  for (const [file, tests] of Object.entries(testTimings)) {
    for (const target of [unitSeconds.min, unitSeconds.max]) {
      const units = testUnits([file], target);
      for (const name of [
        ...Object.keys(tests),
        "a test added after the timings were recorded",
      ]) {
        assert.equal(
          units.filter((unit) => runsTest(unit, name)).length,
          1,
          `${file} at ${target}s: "${name}" must run in exactly one unit`,
        );
      }
    }
  }
});

test("tests pack into units of about the target, and a file that fits one unit runs whole", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = ["split", "small", "new"].map((name) =>
    path
      .relative(root, path.join(directory, `${name}.test.ts`))
      .replaceAll(path.sep, "/"),
  );
  const [split, small, fresh] = files;
  writeFileSync(
    path.resolve(root, split),
    [
      'test("long", () => {});',
      'test("a", () => {});',
      'test("b", () => {});',
      'test("c", () => {});',
    ].join("\n"),
  );
  writeFileSync(
    path.resolve(root, small),
    'test("x", () => {});\ntest("y", () => {});',
  );
  writeFileSync(path.resolve(root, fresh), 'test("new", () => {});');
  const timings = Object.fromEntries<Readonly<Record<string, number>>>([
    [split, { long: 20, a: 8, b: 6, c: 1 }],
    [small, { x: 2, y: 3 }],
  ]);
  const units = testUnits(files, 15, timings);
  assert.deepEqual(
    units.map(({ name, seconds, select }) => ({
      name: path.basename(name),
      seconds,
      select,
    })),
    [
      {
        name: "split#1",
        seconds: 20,
        select: { mode: "only", tests: ["long"] },
      },
      {
        name: "split#rest",
        seconds: 15,
        select: { mode: "skip", tests: ["long"] },
      },
      { name: "small", seconds: 5, select: undefined },
      { name: "new", seconds: unmeasuredSeconds, select: undefined },
    ],
    "The smallest group skips the others, so it also runs tests the timings lack",
  );
  assert.deepEqual(
    testUnits([split], 40, timings).map((unit) => path.basename(unit.name)),
    ["split"],
    "A larger target keeps the file whole",
  );
});

test("the unit target gives about three units per worker slot within its bounds", () => {
  const timings = { "test/a.test.ts": { a: 450, b: 450 } };
  assert.equal(
    unitTarget(10, timings),
    30,
    "900 s over 10 slots is three units of 30 s per slot",
  );
  assert.equal(
    unitTarget(30, timings),
    unitSeconds.min,
    "Many slots never shrink units below the minimum",
  );
  assert.equal(
    unitTarget(1, timings),
    unitSeconds.max,
    "Few slots never grow units past the maximum",
  );
});

test("exact name patterns escape regular expression syntax", () => {
  const pattern = new RegExp(exactNames(["a (b) [c] 1.5+?", "x|y"]), "u");
  assert.ok(pattern.test("a (b) [c] 1.5+?") && pattern.test("x|y"));
  assert.ok(
    !pattern.test("a (b) [c] 1x5") &&
      !pattern.test("x") &&
      !pattern.test("prefix x|y"),
  );
});

test("shards balance estimated time, longest units first", () => {
  const units = Object.entries({ a: 9, b: 7, c: 5, d: 3 }).map(
    ([name, seconds]) =>
      ({
        kind: "tests",
        file: `test/${name}.test.ts`,
        name,
        seconds,
      }) satisfies Unit,
  );
  const shards = assignShards(units, 2);
  assert.deepEqual(
    shards.map((shard) => shard.units.map((unit) => unit.name)),
    [
      ["a", "d"],
      ["b", "c"],
    ],
  );
  assert.deepEqual(
    shards.map((shard) => shard.seconds),
    [12, 12],
  );
});

test("shard selectors must be <index>/<total> within range", () => {
  assert.deepEqual(parseShard("3/6"), { index: 3, total: 6 });
  for (const value of ["0/6", "7/6", "1", "1/0", "a/b", "1/6/2"])
    assert.throws(() => parseShard(value), /<index>\/<total>/u, value);
});

test("concurrency must be a positive integer", () => {
  assert.equal(parseConcurrency("3"), 3);
  for (const value of ["0", "-1", "1.5", "two", "auto"])
    assert.throws(
      () => parseConcurrency(value),
      /positive concurrency/u,
      value,
    );
});

test("recorded timings read local and CI suite output by file and top-level test", () => {
  const files = ["test/Footer.e2e.test.ts", "test/Theme.test.ts"];
  const local = [
    "[Footer.e2e#1] ✔ footer first (1234.5ms)",
    "[Footer.e2e#1]   ✔ nested subtest (99ms)",
    "[Footer.e2e#rest] ✖ footer second (20ms)",
    "[Footer.e2e#rest] ✔ test\\Footer.e2e.test.ts (5ms)",
    "[Unknown] ✔ unknown file (1ms)",
    "[Theme] (pass) fast theme [25.00ms]",
    "[test-suite] [Theme] (pass) fast theme [45.00s]",
  ].join("\n");
  const ci =
    "Quality tests (2/7)\tTest shard\t2026-11-03T15:06:16.0000000Z [Theme] (fail) theme contrast [1.25s]\r\n";
  assert.deepEqual(recordTimings([local, ci], files), {
    "test/Footer.e2e.test.ts": { "footer first": 1.2, "footer second": 0 },
    "test/Theme.test.ts": { "fast theme": 0, "theme contrast": 1.3 },
  });
  assert.deepEqual(parseTopLevel("\x1b[32m(pass)\x1b[0m instant"), {
    name: "instant",
    milliseconds: 0,
  });
  assert.deepEqual(parseTopLevel("(pass) theme [1.23ms]"), {
    name: "theme",
    milliseconds: 1.23,
  });
  assert.equal(parseTopLevel("  ✔ nested (1.2ms)"), undefined);
  assert.equal(parseTopLevel("﹣ skipped (1.2ms) # SKIP"), undefined);
});

test("dry run prints every shard without running tests", () => {
  const output = execFileSync(
    process.execPath,
    [...reporter, "scripts/test-suite.ts", "--shard", "2/3", "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(output, /^shard 1\/3: ~\d+s$/mu);
  assert.match(output, /^shard 3\/3: ~\d+s$/mu);
  assert.match(output, /^ {2}\S+#1 ~\d+s$/mu);
  assert.match(output, /^ {2}\S+#rest ~\d+s$/mu);
  assert.doesNotMatch(
    output,
    /ℹ tests/u,
    "A dry run must not start the test runner",
  );
});

test("the suite limits its file list, prefixes Bun output and rejects an empty shard", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const list = path.join(directory, "files.txt");
  writeFileSync(list, "test/Theme.test.ts\r\ntest/Theme.test.ts\r\n");
  const args = [...reporter, "scripts/test-suite.ts"];
  const child = spawnSync(process.execPath, [...args, "--files-from", list], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stderr, /^\[Theme\] \(pass\) /mu);
  assert.match(
    child.stdout,
    /^1 units, 3 top-level tests, 0 failed units, \d+s$/mu,
  );
  const empty = spawnSync(
    process.execPath,
    [...args, "--files", "test/Theme.test.ts", "--shard", "2/2"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No test units selected/u);
  const subset = execFileSync(
    process.execPath,
    [
      ...args,
      "--files",
      "test/Goals.e2e.test.ts,test/runtime-startup.e2e.test.ts",
      "--lifecycles",
      "Pi cancellation",
      "--lifecycle-repeats",
      "1",
      "--dry-run",
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(subset, /Pi cancellation \(repeat 1\/1\)/u);
  assert.doesNotMatch(subset, /Pi startup|Theme/u);
});

test("an empty suite succeeds only when explicitly allowed", async () => {
  assert.equal(await runSuite([], 1), 1);
  assert.equal(await runSuite([], 1, true), 0);
});

test("record mode writes timings from Bun and Node logs", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of [
    "scripts/test-suite.ts",
    "test/support/NodeRuntime.ts",
    "test/Theme.test.ts",
    "test/RepositoryContracts.test.ts",
  ]) {
    const target = path.join(directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, file), target);
  }
  const timings = path.join(directory, "test/test-timings.json");
  writeFileSync(timings, "{}");
  writeFileSync(
    path.join(directory, "bun.log"),
    "[Theme] (pass) sample [1.20s]\n",
  );
  writeFileSync(
    path.join(directory, "node.log"),
    "[RepositoryContracts] ✔ contract (200ms)\n",
  );
  const output = execFileSync(
    process.execPath,
    [...reporter, "scripts/test-suite.ts", "--record", "bun.log", "node.log"],
    { cwd: directory, encoding: "utf8" },
  );
  assert.match(output, /Recorded 2 tests in 2 files/u);
  assert.deepEqual(JSON.parse(readFileSync(timings, "utf8")), {
    "test/Theme.test.ts": { sample: 1.2 },
    "test/RepositoryContracts.test.ts": { contract: 0.2 },
  });
});

test("Bun ignores stale timings, runs unrecorded tests once, and fails incomplete units", async () => {
  const file = "test/Theme.test.ts";
  const first = "uses one neutral background for every tool state";
  const second = "uses achromatic neutrals";
  const unrecorded =
    "reasoning text meets normal-text contrast on KillerOS surfaces";
  const [part, rest] = testUnits([file], 5, {
    [file]: { [first]: 6, [second]: 4, "uses achromatic neutral": 20 },
  });
  assert.deepEqual(testUnits([file], 5, { [file]: { outdated: 20 } }), [
    { kind: "tests", name: "Theme", file, seconds: unmeasuredSeconds },
  ]);
  assert.deepEqual(unitArguments(rest).slice(0, 5), [
    "test",
    "--preload",
    "./test/support/TestTemp.ts",
    "-t",
    `^(?!(?:${first})$).*$`,
  ]);
  assert.equal(unitArguments(part)[4], exactNames([first]));
  const partial = {
    ...part,
    select: { mode: "only", tests: [first, "missing"] },
  } satisfies Unit;
  const empty = {
    ...part,
    select: { mode: "only", tests: ["missing"] },
  } satisfies Unit;
  const results = await runUnits([part, rest, partial, empty], 1);
  assert.deepEqual(
    results.map(({ topLevel }) => topLevel.map(({ name }) => name)),
    [[first], [first], [], [second, unrecorded]],
  );
  assert.deepEqual(results.map(unitFailed), [false, true, true, false]);
  assert.equal(results[1].code, 0);
});

test("Node lifecycle units omit nested tests and exit naturally", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-suite-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "sample.test.mjs");
  writeFileSync(
    file,
    'import test from "node:test";\ntest("first (a)", async (t) => { await t.test("child", () => {}); });\ntest("second", () => {});\n',
  );
  const [result] = await runUnits(
    [{ kind: "lifecycle", name: "sample", files: [file], seconds: 1 }],
    1,
  );
  assert.equal(result.code, 0, nodeExecutable());
  assert.deepEqual(
    result.topLevel.map(({ name }) => name),
    ["first (a)", "second"],
  );
  assert.ok(!unitFailed(result));
  writeFileSync(
    file,
    'import test from "node:test";\ntest("fails", () => { throw new Error("fixture failure"); });\n',
  );
  const [failure] = await runUnits(
    [{ kind: "lifecycle", name: "sample failure", files: [file], seconds: 1 }],
    1,
  );
  assert.equal(failure.code, 1);
  assert.deepEqual(
    failure.topLevel.map(({ name }) => name),
    ["fails"],
    "A failure summary cannot count the same test again",
  );
});
