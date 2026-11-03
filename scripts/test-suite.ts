/**
 * Runs the full test suite, or one CI shard of it, scheduled by measured duration.
 *
 *   npm test                                                       the full suite, four units at a time
 *   node --experimental-strip-types scripts/test-suite.ts --shard 2/8 --concurrency 2
 *   node --experimental-strip-types scripts/test-suite.ts --shard 2/8 --dry-run   print every shard's units
 *
 * Tests inside one file run one after another, so a long file sets a floor for the whole run.
 * The suite therefore runs in units: a whole test file, or one part of a file listed in `testParts`.
 * A split file runs as one process per listed group of top-level tests (`--test-name-pattern`) plus
 * one process for the rest (`--test-skip-pattern` of every listed name), so each test runs exactly once.
 *
 * Units are dealt to shards longest first, each onto the shard with the least estimated time, and each
 * shard starts its longest units first. A unit that reports zero tests fails, so a renamed test cannot
 * silently drop out of a part. Output lines carry the unit's name, because units run concurrently.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Node flags for every test process. `npm test` and `npm run test:changed` share them. */
export const nodeTestFlags = ["--test-force-exit", "--experimental-strip-types", "--import", "./test/support/TestTemp.ts"] as const;

/**
 * Seconds of test time per file on a CI shard runner, from the shard logs of a green CI run.
 * Refresh them when one shard regularly finishes well after the others.
 */
export const testSeconds = {
  "test/runtime-receipts.e2e.test.ts": 114,
  "test/GoalLifecycle.e2e.test.ts": 107,
  "test/Footer.e2e.test.ts": 102,
  "test/runtime-receipt-git.e2e.test.ts": 93,
  "test/runtime-receipt-conversion.e2e.test.ts": 86,
  "test/Question.e2e.test.ts": 82,
  "test/Handoff.e2e.test.ts": 49,
  "test/runtime-native-provider.e2e.test.ts": 42,
  "test/runtime-tools.e2e.test.ts": 38,
  "test/Editor.e2e.test.ts": 31,
  "test/Goals.e2e.test.ts": 26,
  "test/BoundedText.e2e.test.ts": 25,
  "test/CompactionGoals.e2e.test.ts": 24,
  "test/CompactionTrigger.e2e.test.ts": 23,
  "test/BlockedGoalCompletion.e2e.test.ts": 23,
  "test/Notifications.e2e.test.ts": 20,
  "test/GoalCompletionVerification.e2e.test.ts": 19,
  "test/PiTerminalControls.test.ts": 16,
  "test/Activity.e2e.test.ts": 16,
  "test/Hooks.system.test.ts": 14,
  "test/ShellUi.e2e.test.ts": 14,
  "test/PiExtensionContract.test.ts": 13,
  "test/CompactionRestoration.e2e.test.ts": 11,
  "test/runtime-package.e2e.test.ts": 11,
  "test/runtime-print-json.e2e.test.ts": 10,
  "test/verify-release.test.ts": 9,
  "test/Hooks.e2e.test.ts": 8,
  "test/GoalUi.e2e.test.ts": 8,
  "test/SlashCommands.e2e.test.ts": 8,
  "test/CompactionSessionBoundaries.e2e.test.ts": 7,
  "test/installed-archive.system.test.ts": 7,
  "test/Settings.e2e.test.ts": 6,
  "test/runtime-fast.e2e.test.ts": 6,
  "test/CompactionSettings.e2e.test.ts": 5,
  "test/Display.e2e.test.ts": 5,
  "test/CompactionManual.e2e.test.ts": 4,
  "test/runtime-startup.e2e.test.ts": 4,
  "test/PiStartup.test.ts": 4,
  "test/GoalHandoff.e2e.test.ts": 4,
  "test/test-changed.test.ts": 4,
  "test/HandoffTerminal.e2e.test.ts": 3,
  "test/PiToolRestoration.e2e.test.ts": 2,
  "test/CompactionModes.e2e.test.ts": 2,
  "test/runtime-restoration.e2e.test.ts": 2,
  "test/RepositoryContracts.test.ts": 2,
  "test/runtime-platform.e2e.test.ts": 2,
  "test/PersonalInstructions.e2e.test.ts": 2,
  "test/npm-package-fixtures.system.test.ts": 1,
  "test/PiRpcControls.test.ts": 1,
  "test/release-notes.test.ts": 1,
  "test/ScenarioFailure.test.ts": 1,
  "test/test-suite.test.ts": 1,
  "test/FooterGitSchedule.test.ts": 1,
  "test/Theme.test.ts": 1,
  "test/ShellUi.test.ts": 1,
} as const satisfies Record<string, number>;

/** A group of top-level tests that runs as its own unit, with its share of the file's seconds. */
export type TestPart = { seconds: number; tests: readonly string[] };

/** Files split into parts. The file's unlisted tests form one more part with the remaining seconds. */
export const testParts = {
  "test/runtime-receipts.e2e.test.ts": [
    { seconds: 49, tests: ["native session boundaries discard receipts parked at settlement", "real Pi receipt lifecycle settles, discards, and survives navigation at the correct boundary"] },
    { seconds: 44, tests: ["real Pi persists and renders complete worked-for receipt data", "real Pi bounds observed checks and warns once for unavailable change collection"] },
  ],
  "test/GoalLifecycle.e2e.test.ts": [
    { seconds: 38, tests: ["saved goals stay inactive outside TUI and RPC or without a saved session", "malformed saved blocker audits fail closed without dispatch"] },
    { seconds: 31, tests: ["malformed saved goals and unsafe reports fail closed before dispatch", "pause and clear cancel goal work while inactive clears preserve unrelated work"] },
  ],
  "test/Footer.e2e.test.ts": [
    { seconds: 47, tests: ["Footer Git status preserves last good counts through failures and recovers without recreation"] },
    { seconds: 28, tests: ["Footer Git refresh timing, watch bursts, and file-count rendering stay bounded"] },
  ],
  "test/runtime-receipt-git.e2e.test.ts": [
    { seconds: 43, tests: ["real Pi receipt bounds diff work, blob storage, and repository formats", "real Pi receipts report only the response delta with bounded Git metadata"] },
  ],
  "test/Question.e2e.test.ts": [
    { seconds: 45, tests: ["Question history retains the newest hundred distinct answers", "Question history, preview paging, resize, and draft preservation"] },
  ],
} as const satisfies Partial<Record<keyof typeof testSeconds, readonly TestPart[]>>;

const estimates: Readonly<Partial<Record<string, number>>> = testSeconds;
const parts: Readonly<Partial<Record<string, readonly TestPart[]>>> = testParts;

/** Estimate for a file without a timing, so a new file counts as mid-sized until `testSeconds` lists it. */
export const unmeasuredSeconds = 10;

/** One test process: a whole file, or the tests of a split file that `select` picks. */
export type Unit = {
  name: string;
  file: string;
  seconds: number;
  select?: { mode: "only" | "skip"; tests: readonly string[] };
};

/** Lists the files the suite runs: `test/*.test.*`, sorted. */
export function testFiles(): string[] {
  return readdirSync(new URL("../test/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes(".test."))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

/** Expands files into units, splitting the files listed in `testParts`. */
export function testUnits(files: readonly string[]): Unit[] {
  return files.flatMap((file): Unit[] => {
    const seconds = estimates[file] ?? unmeasuredSeconds;
    const name = file.replace(/^test\//u, "").replace(/\.test\.[^.]+$/u, "");
    const split = parts[file];
    if (!split) return [{ name, file, seconds }];
    const listed = split.flatMap((part) => part.tests);
    const listedSeconds = split.reduce((sum, part) => sum + part.seconds, 0);
    return [
      ...split.map((part, index): Unit => ({ name: `${name}#${index + 1}`, file, seconds: part.seconds, select: { mode: "only", tests: part.tests } })),
      { name: `${name}#rest`, file, seconds: Math.max(1, seconds - listedSeconds), select: { mode: "skip", tests: listed } },
    ];
  });
}

export type Shard = { units: Unit[]; seconds: number };

/** Deals units into `total` shards with balanced estimated seconds. Each shard lists its longest units first. */
export function assignShards(units: readonly Unit[], total: number): Shard[] {
  const shards: Shard[] = Array.from({ length: total }, () => ({ units: [], seconds: 0 }));
  const longestFirst = [...units].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  for (const unit of longestFirst) {
    const lightest = shards.reduce((least, shard) => shard.seconds < least.seconds ? shard : least);
    lightest.units.push(unit);
    lightest.seconds += unit.seconds;
  }
  return shards;
}

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

/** Node arguments that run one unit. */
export function unitArguments(unit: Unit): string[] {
  const select = unit.select ? [`--test-${unit.select.mode === "only" ? "name" : "skip"}-pattern=${exactNames(unit.select.tests)}`] : [];
  return ["--test", ...nodeTestFlags, ...select, unit.file];
}

/** A finished unit: its exit code and the top-level tests the reporter listed, in order. */
export type UnitResult = { unit: Unit; code: number | null; topLevel: string[] };

/**
 * A unit fails when its process fails or it ran none of its tests. When a name pattern matches
 * nothing, Node reports the file itself as one passing test, so a file-named result does not count.
 * A part must also report every test it lists.
 */
export function unitFailed({ unit, code, topLevel }: UnitResult): boolean {
  const ran = topLevel.filter((name) => path.resolve(root, name) !== path.resolve(root, unit.file));
  if (code !== 0 || ran.length === 0) return true;
  return unit.select?.mode === "only" && unit.select.tests.some((test) => !ran.includes(test));
}

/** A spec reporter line for a finished top-level test: no indentation, a result mark, and a duration. */
const topLevelResult = /^[✔✖﹣] (.+?) \(\d[\d.]*ms\)(?: #.*)?$/u;

/** Runs one unit, prefixing each output line with its name, and records its top-level results. */
async function runUnit(unit: Unit): Promise<UnitResult> {
  // Inside a test process, NODE_TEST_CONTEXT would make the unit stream results to that test runner instead of reporting them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const child = spawn(process.execPath, unitArguments(unit), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const topLevel: string[] = [];
  const relay = (stream: NodeJS.ReadableStream, sink: NodeJS.WriteStream): void => {
    let pending = "";
    stream.setEncoding("utf8");
    const emit = (line: string): void => {
      const result = topLevelResult.exec(line);
      if (result) topLevel.push(result[1]);
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
  const queue = [...units].sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name));
  const results: UnitResult[] = [];
  const worker = async (): Promise<void> => {
    for (let unit = queue.shift(); unit; unit = queue.shift()) results.push(await runUnit(unit));
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    shard: { type: "string", default: "1/1" },
    concurrency: { type: "string", default: "4" },
    "dry-run": { type: "boolean", default: false },
  } });
  const { index, total } = parseShard(values.shard);
  const concurrency = Number(values.concurrency);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error(`Expected a positive concurrency, got "${values.concurrency}"`);
  const shards = assignShards(testUnits(testFiles()), total);
  if (values["dry-run"]) {
    shards.forEach((shard, position) => console.log(`shard ${position + 1}/${total}: ~${shard.seconds}s\n${shard.units.map((unit) => `  ${unit.name} ~${unit.seconds}s`).join("\n")}`));
    return 0;
  }
  const started = performance.now();
  const results = await runUnits(shards[index - 1].units, concurrency);
  const failed = results.filter(unitFailed);
  const tests = results.reduce((sum, result) => sum + result.topLevel.length, 0);
  console.log(`\n${results.length} units, ${tests} top-level tests, ${failed.length} failed units, ${Math.round((performance.now() - started) / 1000)}s`);
  for (const { unit, code, topLevel } of failed) console.log(`FAILED ${unit.name}: exit ${code ?? "unknown"}, top-level results: ${topLevel.join(" | ") || "none"}`);
  return failed.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
