/**
 * Runs the full test suite, or one CI shard of it, scheduled by measured duration.
 *
 *   npm test                                                       the full suite, four units at a time
 *   node --experimental-strip-types scripts/test-suite.ts --shard 2/8 --concurrency 2 --lifecycle-repeats 2   one CI shard
 *   node --experimental-strip-types scripts/test-suite.ts --shard 2/8 --dry-run   print every shard's units
 *   node --experimental-strip-types scripts/test-suite.ts --record <log>...      rewrite test/test-timings.json
 *
 * Tests inside one process run one after another, so the suite runs in units: groups of one file's
 * top-level tests, packed from `test/test-timings.json` into about `unitTarget` seconds each. A file with one
 * unit runs whole. A file with several runs one process per group (`--test-name-pattern`), except its
 * smallest group, which skips every other group's tests (`--test-skip-pattern`), so tests missing
 * from the timings still run exactly once.
 *
 * CI adds `--lifecycle-repeats`: each listed lifecycle runs that many more times, one process per repeat,
 * with Node's plain flags, so a leaked handle or child process hangs it instead of being forced to exit.
 *
 * Units are dealt to shards longest first, each onto the shard with the least estimated time, and each
 * shard starts its longest units first. A unit that reports zero tests, or misses a test it lists, fails,
 * so a renamed test cannot silently drop out. Output lines carry the unit's name, because units run concurrently.
 * `--record` reads that output, from a local run or from `gh run view --log`, back into timings.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import measured from "../test/test-timings.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const timingsFile = new URL("../test/test-timings.json", import.meta.url);

/** Node flags for every test process. `npm test` and `npm run test:changed` share them. */
export const nodeTestFlags = ["--test-force-exit", "--experimental-strip-types", "--import", "./test/support/TestTemp.ts"] as const;

/** Seconds per top-level test, by file, from a recorded suite run. */
export type Timings = Readonly<Record<string, Readonly<Record<string, number>>>>;

export const testTimings: Timings = measured;

/** Bounds on the target seconds per unit. A test longer than the target is a unit by itself. */
export const unitSeconds = { min: 15, max: 60 } as const;

/**
 * Target seconds per unit for a run with `slots` worker slots in total: about three units per slot.
 * CI's many small slots get short units that balance well; a local run's few slots get long units,
 * because each unit process spends about 1.5 s loading Pi before its first test.
 */
export function unitTarget(slots: number, timings: Timings = testTimings): number {
  const total = Object.values(timings).reduce((sum, tests) => sum + Object.values(tests).reduce((a, b) => a + b, 0), 0);
  return Math.min(unitSeconds.max, Math.max(unitSeconds.min, Math.round(total / (slots * 3))));
}

/** Estimate for a file without timings, so a new file counts as mid-sized until it is recorded. */
export const unmeasuredSeconds = 10;

/** One test process: a whole file, the tests of a file that `select` picks, or one lifecycle repeat. */
export type Unit = TestUnit | LifecycleUnit;
export type TestUnit = {
  kind: "tests";
  name: string;
  file: string;
  seconds: number;
  select?: { mode: "only" | "skip"; tests: readonly string[] };
};
export type LifecycleUnit = { kind: "lifecycle"; name: string; files: readonly string[]; pattern?: string; seconds: number };

/**
 * Lifecycles CI repeats without --test-force-exit or shared test setup, so a leaked handle or child
 * process hangs the repeat until the job times out. `--lifecycle-repeats` adds that many units of each.
 */
export const lifecycles = [
  { name: "Pi startup", files: ["test/runtime-startup.e2e.test.ts"], seconds: 5 },
  { name: "installed CLI pilot", files: ["test/PiExtensionContract.test.ts"], seconds: 5,
    pattern: "installed Pi CLI completes a goal and restores it without unsolicited model work" },
  { name: "terminal pilot", files: ["test/PiExtensionContract.test.ts"], seconds: 5,
    pattern: "installed Pi terminal" },
  { name: "Pi cancellation", files: ["test/Goals.e2e.test.ts", "test/runtime-native-provider.e2e.test.ts", "test/CompactionTrigger.e2e.test.ts"], seconds: 10,
    pattern: "continuation dispatch respects idle, pending, and cancellation gates|active faux provider retries preserve goal ownership until settlement|Cancelled ordinary and goal compaction cannot recover after an aborted settlement" },
  { name: "saved tool restoration", files: ["test/runtime-restoration.e2e.test.ts"], seconds: 3 },
] as const satisfies ReadonlyArray<Omit<LifecycleUnit, "kind">>;

/** Units that repeat every lifecycle `repeats` times, each repeat in its own process. */
export function lifecycleUnits(repeats: number): LifecycleUnit[] {
  return lifecycles.flatMap((lifecycle) => Array.from({ length: repeats }, (_, repeat): LifecycleUnit =>
    ({ kind: "lifecycle", ...lifecycle, name: `${lifecycle.name} (repeat ${repeat + 1}/${repeats})` })));
}

/** Lists the files the suite runs: `test/*.test.*`, sorted. */
export function testFiles(): string[] {
  return readdirSync(new URL("../test/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes(".test."))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

const unitName = (file: string): string => file.replace(/^test\//u, "").replace(/\.test\.[^.]+$/u, "");

/** Packs tests longest first into groups of about `target` seconds, each test into the first group it fits. */
function packTests(tests: Readonly<Record<string, number>>, target: number): Array<{ tests: string[]; seconds: number }> {
  const groups: Array<{ tests: string[]; seconds: number }> = [];
  for (const [test, seconds] of Object.entries(tests).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))) {
    const group = groups.find((candidate) => candidate.seconds + seconds <= target);
    if (group) { group.tests.push(test); group.seconds += seconds; } else groups.push({ tests: [test], seconds });
  }
  return groups;
}

/** Expands files into units of about `target` seconds from `timings`. */
export function testUnits(files: readonly string[], target: number, timings: Timings = testTimings): TestUnit[] {
  return files.flatMap((file): TestUnit[] => {
    const name = unitName(file);
    const tests = Object.hasOwn(timings, file) ? timings[file] : undefined;
    if (!tests) return [{ kind: "tests", name, file, seconds: unmeasuredSeconds }];
    const groups = packTests(tests, target);
    const seconds = (group: { seconds: number }): number => Math.max(1, Math.round(group.seconds));
    if (groups.length < 2) return [{ kind: "tests", name, file, seconds: seconds(groups[0] ?? { seconds: 0 }) }];
    const rest = groups.reduce((least, group) => group.seconds < least.seconds ? group : least);
    const listed = groups.filter((group) => group !== rest);
    return [
      ...listed.map((group, index): TestUnit => ({ kind: "tests", name: `${name}#${index + 1}`, file, seconds: seconds(group), select: { mode: "only", tests: group.tests } })),
      { kind: "tests", name: `${name}#rest`, file, seconds: seconds(rest), select: { mode: "skip", tests: listed.flatMap((group) => group.tests) } },
    ];
  });
}

export type Shard = { units: Unit[]; seconds: number };

/** Deals units into `total` shards with balanced estimated seconds. Each shard lists its longest units first. */
export function assignShards(units: readonly Unit[], total: number): Shard[] {
  const shards: Shard[] = Array.from({ length: total }, () => ({ units: [], seconds: 0 }));
  for (const unit of longestFirst(units)) {
    const lightest = shards.reduce((least, shard) => shard.seconds < least.seconds ? shard : least);
    lightest.units.push(unit);
    lightest.seconds += unit.seconds;
  }
  return shards;
}

const longestFirst = (units: readonly Unit[]): Unit[] => [...units].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));

/** Parses `<index>/<total>` with 1 <= index <= total. */
export function parseShard(value: string): { index: number; total: number } {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index > total) throw new Error(`Expected a shard as <index>/<total>, got "${value}"`);
  return { index, total };
}

/** Builds the anchored pattern that matches exactly the named tests. */
export function exactNames(tests: readonly string[]): string {
  return `^(?:${tests.map((test) => test.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")).join("|")})$`;
}

/** Node arguments that run one unit. Lifecycle repeats keep CI's original flags: no forced exit and no shared test setup. */
export function unitArguments(unit: Unit): string[] {
  if (unit.kind === "lifecycle") {
    return ["--test", "--experimental-strip-types", ...(unit.pattern ? [`--test-name-pattern=${unit.pattern}`] : []), ...unit.files];
  }
  const select = unit.select ? [`--test-${unit.select.mode === "only" ? "name" : "skip"}-pattern=${exactNames(unit.select.tests)}`] : [];
  return ["--test", ...nodeTestFlags, ...select, unit.file];
}

const unitFiles = (unit: Unit): readonly string[] => unit.kind === "lifecycle" ? unit.files : [unit.file];

/** A finished top-level test as the spec reporter lists it. */
export type TopLevel = { name: string; milliseconds: number };

/** A finished unit: its exit code and the top-level tests the reporter listed, in order. */
export type UnitResult = { unit: Unit; code: number | null; topLevel: TopLevel[] };

/**
 * A unit fails when its process fails or it ran none of its tests. When a name pattern matches
 * nothing, Node reports the file itself as one passing test, so a file-named result does not count.
 * A unit that lists tests must also report every one of them.
 */
export function unitFailed({ unit, code, topLevel }: UnitResult): boolean {
  const files = unitFiles(unit).map((file) => path.resolve(root, file));
  const ran = topLevel.map((test) => test.name).filter((name) => !files.includes(path.resolve(root, name)));
  if (code !== 0 || ran.length === 0) return true;
  return unit.kind === "tests" && unit.select?.mode === "only" && unit.select.tests.some((test) => !ran.includes(test));
}

/** A spec reporter line for a finished top-level test: no indentation, a result mark, and a duration. */
const topLevelResult = /^[✔✖﹣] (.+?) \((\d[\d.]*)ms\)(?: #.*)?$/u;

/** The same line as the suite prints it, behind its unit name and, in CI logs, a job and timestamp prefix. */
const suiteResult = /(?:^|\s)\[([^\]]+)\] ([✔✖﹣] .+?\(\d[\d.]*ms\)(?: #.*)?)$/u;

/** Parses one reporter line, or returns undefined for any other line. */
export function parseTopLevel(line: string): TopLevel | undefined {
  const result = topLevelResult.exec(line);
  return result ? { name: result[1], milliseconds: Number(result[2]) } : undefined;
}

/** Reads suite output back into timings. A unit name maps to its file; lines from unknown files are ignored. */
export function recordTimings(logs: readonly string[], files: readonly string[]): Record<string, Record<string, number>> {
  const byName = new Map(files.map((file) => [unitName(file), file]));
  const timings: Record<string, Record<string, number>> = {};
  for (const line of logs.flatMap((log) => log.split(/\r?\n/u))) {
    const match = suiteResult.exec(line);
    const file = match ? byName.get(match[1].replace(/#[^#]*$/u, "")) : undefined;
    const test = match ? parseTopLevel(match[2]) : undefined;
    if (!file || !test || path.resolve(root, test.name) === path.resolve(root, file)) continue;
    (timings[file] ??= {})[test.name] = Math.round(test.milliseconds / 100) / 10;
  }
  return Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b))
    .map(([file, tests]) => [file, Object.fromEntries(Object.entries(tests).sort(([a], [b]) => a.localeCompare(b)))]));
}

/** Runs one unit, prefixing each output line with its name, and records its top-level results. */
async function runUnit(unit: Unit): Promise<UnitResult> {
  // Inside a test process, NODE_TEST_CONTEXT would make the unit stream results to that test runner instead of reporting them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const child = spawn(process.execPath, unitArguments(unit), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const topLevel: TopLevel[] = [];
  const relay = (stream: NodeJS.ReadableStream, sink: NodeJS.WriteStream): void => {
    let pending = "";
    stream.setEncoding("utf8");
    const emit = (line: string): void => {
      const result = parseTopLevel(line);
      if (result) topLevel.push(result);
      sink.write(`[${unit.name}] ${line}\n`);
    };
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/u);
      pending = lines.pop() ?? "";
      lines.forEach(emit);
    });
    stream.on("end", () => { if (pending) emit(pending); });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  return { unit, code, topLevel };
}

/** Runs units longest first, `concurrency` at a time, and returns every result. */
export async function runUnits(units: readonly Unit[], concurrency: number): Promise<UnitResult[]> {
  const queue = longestFirst(units);
  const results: UnitResult[] = [];
  const worker = async (): Promise<void> => {
    for (let unit = queue.shift(); unit; unit = queue.shift()) results.push(await runUnit(unit));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

/** Runs units and prints a summary with every failed unit. Returns the process exit code. */
export async function runSuite(units: readonly Unit[], concurrency: number): Promise<number> {
  const started = performance.now();
  const results = await runUnits(units, concurrency);
  const failed = results.filter(unitFailed);
  const tests = results.reduce((sum, result) => sum + result.topLevel.length, 0);
  console.log(`\n${results.length} units, ${tests} top-level tests, ${failed.length} failed units, ${Math.round((performance.now() - started) / 1000)}s`);
  for (const { unit, code, topLevel } of failed) console.log(`FAILED ${unit.name}: exit ${code ?? "unknown"}, top-level results: ${topLevel.map((test) => test.name).join(" | ") || "none"}`);
  return failed.length > 0 ? 1 : 0;
}

/**
 * Parses `--concurrency`. The default of four units is what a 12-thread desktop sustains: four units already
 * kept about seven threads busy, and eight saturated the machine and made scenarios time out.
 */
export function parseConcurrency(value: string): number {
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error(`Expected a positive concurrency, got "${value}"`);
  return concurrency;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    shard: { type: "string", default: "1/1" },
    concurrency: { type: "string", default: "4" },
    "dry-run": { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    "lifecycle-repeats": { type: "string", default: "0" },
  } });
  if (values.record) {
    if (positionals.length === 0) throw new Error("--record needs one or more suite output logs");
    const timings = recordTimings(positionals.map((log) => readFileSync(log, "utf8")), testFiles());
    writeFileSync(timingsFile, `${JSON.stringify(timings, null, 2)}\n`);
    console.log(`Recorded ${Object.values(timings).reduce((sum, tests) => sum + Object.keys(tests).length, 0)} tests in ${Object.keys(timings).length} files`);
    return 0;
  }
  const { index, total } = parseShard(values.shard);
  const concurrency = parseConcurrency(values.concurrency);
  const repeats = Number(values["lifecycle-repeats"]);
  if (!Number.isSafeInteger(repeats) || repeats < 0) throw new Error(`Expected a non-negative lifecycle repeat count, got "${values["lifecycle-repeats"]}"`);
  const shards = assignShards([...testUnits(testFiles(), unitTarget(total * concurrency)), ...lifecycleUnits(repeats)], total);
  if (values["dry-run"]) {
    shards.forEach((shard, position) => console.log(`shard ${position + 1}/${total}: ~${shard.seconds}s\n${shard.units.map((unit) => `  ${unit.name} ~${unit.seconds}s`).join("\n")}`));
    return 0;
  }
  return await runSuite(shards[index - 1].units, concurrency);
}

if (import.meta.main) process.exitCode = await main();
