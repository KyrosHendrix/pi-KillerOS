import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { isBunRuntime, nodeExecutable } from "../test/support/NodeRuntime.ts";
import measured from "../test/test-timings.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));
const timingsFile = new URL("../test/test-timings.json", import.meta.url);

export const nodeTestFlags = [
  "--test-force-exit",
  "--experimental-strip-types",
  "--import",
  "./test/support/TestTemp.ts",
] as const;

export const nodeOnlyFiles = new Set([
  "test/Activity.e2e.test.ts",
  "test/BlockedGoalCompletion.e2e.test.ts",
  "test/BoundedText.e2e.test.ts",
  "test/CompactionGoals.e2e.test.ts",
  "test/CompactionSessionBoundaries.e2e.test.ts",
  "test/CompactionSettings.e2e.test.ts",
  "test/CompactionTrigger.e2e.test.ts",
  "test/Display.e2e.test.ts",
  "test/Footer.e2e.test.ts",
  "test/GoalLifecycle.e2e.test.ts",
  "test/GoalUi.e2e.test.ts",
  "test/Goals.e2e.test.ts",
  "test/HandoffTerminal.e2e.test.ts",
  "test/Hooks.e2e.test.ts",
  "test/Notifications.e2e.test.ts",
  "test/PiExtensionContract.test.ts",
  "test/Question.e2e.test.ts",
  "test/RepositoryContracts.test.ts",
  "test/ScenarioFailure.test.ts",
  "test/Settings.e2e.test.ts",
  "test/ShellUi.e2e.test.ts",
  "test/SlashCommands.e2e.test.ts",
  "test/runtime-fast.e2e.test.ts",
  "test/runtime-native-provider.e2e.test.ts",
  "test/runtime-package.e2e.test.ts",
  "test/runtime-receipt-git.e2e.test.ts",
  "test/runtime-receipts.e2e.test.ts",
  "test/runtime-tools.e2e.test.ts",
]);

export type Timings = Readonly<
  Record<string, Readonly<Record<string, number>>>
>;

export const testTimings: Timings = measured;

export const unitSeconds = { min: 15, max: 60 } as const;

export function unitTarget(
  slots: number,
  timings: Timings = testTimings,
): number {
  const total = Object.values(timings).reduce(
    (sum, tests) => sum + Object.values(tests).reduce((a, b) => a + b, 0),
    0,
  );
  return Math.min(
    unitSeconds.max,
    Math.max(unitSeconds.min, Math.round(total / (slots * 3))),
  );
}

export const unmeasuredSeconds = 10;

export type Unit = TestUnit | LifecycleUnit;
export type TestUnit = {
  kind: "tests";
  name: string;
  file: string;
  seconds: number;
  select?: { mode: "only" | "skip"; tests: readonly string[] };
};
export type LifecycleUnit = {
  kind: "lifecycle";
  name: string;
  files: readonly string[];
  pattern?: string;
  seconds: number;
};

const cancellationCases = {
  "test/Goals.e2e.test.ts":
    "continuation dispatch respects idle, pending, and cancellation gates",
  "test/runtime-native-provider.e2e.test.ts":
    "active faux provider retries preserve goal ownership until settlement",
  "test/CompactionTrigger.e2e.test.ts":
    "Cancelled ordinary and goal compaction cannot recover after an aborted settlement",
};

export const lifecycles = [
  {
    name: "Pi startup",
    files: ["test/runtime-startup.e2e.test.ts"],
    seconds: 5,
  },
  {
    name: "installed CLI pilot",
    files: ["test/PiExtensionContract.test.ts"],
    seconds: 5,
    pattern:
      "installed Pi CLI completes a goal and restores it without unsolicited model work",
  },
  {
    name: "terminal pilot",
    files: ["test/PiExtensionContract.test.ts"],
    seconds: 5,
    pattern: "installed Pi terminal",
  },
  {
    name: "Pi cancellation",
    files: Object.keys(cancellationCases),
    seconds: 10,
    pattern: Object.values(cancellationCases).join("|"),
  },
  {
    name: "saved tool restoration",
    files: ["test/runtime-restoration.e2e.test.ts"],
    seconds: 3,
  },
] as const satisfies ReadonlyArray<Omit<LifecycleUnit, "kind">>;

export function lifecycleUnits(
  repeats: number,
  names: readonly string[] = lifecycles.map(({ name }) => name),
  files: readonly string[] = testFiles(),
): LifecycleUnit[] {
  return lifecycles.flatMap((lifecycle) => {
    const reachable = lifecycle.files.filter((file) => files.includes(file));
    if (!names.includes(lifecycle.name) || reachable.length === 0) return [];
    const seconds = Math.ceil(
      (lifecycle.seconds * reachable.length) / lifecycle.files.length,
    );
    const pattern =
      lifecycle.name === "Pi cancellation"
        ? Object.entries(cancellationCases)
            .filter(([file]) => reachable.includes(file))
            .map(([, title]) => title)
            .join("|")
        : "pattern" in lifecycle
          ? lifecycle.pattern
          : undefined;
    return Array.from({ length: repeats }, (_, repeat): LifecycleUnit => ({
      kind: "lifecycle",
      files: reachable,
      pattern,
      seconds,
      name: `${lifecycle.name} (repeat ${repeat + 1}/${repeats})`,
    }));
  });
}

export function testFiles(): string[] {
  return readdirSync(new URL("../test/", import.meta.url), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && entry.name.includes(".test."))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

const unitName = (file: string): string =>
  file.replace(/^test\//u, "").replace(/\.test\.[^.]+$/u, "");

const escapeRegex = (value: string) =>
  value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");

function testTitlePatterns(source: string): RegExp[] | undefined {
  const calls = source.matchAll(
    /(?:^|[;{}])\s*test(?:\.(?:only|skip|todo))?\s*\(\s*/gmu,
  );
  const patterns: RegExp[] = [];
  for (const call of calls) {
    const argument = source.slice(call.index + call[0].length);
    const title =
      /^(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|`((?:\\[\s\S]|[^`\\])*)`)\s*(?=[,)])/u.exec(
        argument,
      );
    if (!title) return undefined;
    const literal = title[1] ?? title[2];
    const parts =
      literal === undefined ? title[3].split(/(?<!\\)\$\{[^}]*\}/u) : [literal];
    const pattern = parts
      .map((part) => escapeRegex(part.replace(/\\([\\'"`$])/gu, "$1")))
      .join(".+");
    patterns.push(new RegExp(`^${pattern}$`, "su"));
  }
  return patterns;
}

function packTests(
  tests: Array<[string, number]>,
  target: number,
): Array<{ tests: string[]; seconds: number }> {
  const groups: Array<{ tests: string[]; seconds: number }> = [];
  for (const [test, seconds] of tests.sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  )) {
    const group = groups.find(
      (candidate) => candidate.seconds + seconds <= target,
    );
    if (group) {
      group.tests.push(test);
      group.seconds += seconds;
    } else groups.push({ tests: [test], seconds });
  }
  return groups;
}

export function testUnits(
  files: readonly string[],
  target: number,
  timings: Timings = testTimings,
): TestUnit[] {
  return files.flatMap((file): TestUnit[] => {
    const name = unitName(file);
    const recorded = Object.hasOwn(timings, file) ? timings[file] : undefined;
    const patterns = recorded
      ? testTitlePatterns(readFileSync(path.resolve(root, file), "utf8"))
      : undefined;
    const tests = Object.entries(recorded ?? {}).filter(
      ([title]) =>
        patterns === undefined ||
        patterns.some((pattern) => pattern.test(title)),
    );
    if (tests.length === 0)
      return [{ kind: "tests", name, file, seconds: unmeasuredSeconds }];
    const groups = packTests(tests, target);
    const seconds = (group: { seconds: number }): number =>
      Math.max(1, Math.round(group.seconds));
    if (groups.length < 2)
      return [
        {
          kind: "tests",
          name,
          file,
          seconds: seconds(groups[0]),
        },
      ];
    const rest = groups.reduce((least, group) =>
      group.seconds < least.seconds ? group : least,
    );
    const listed = groups.filter((group) => group !== rest);
    return [
      ...listed.map((group, index): TestUnit => ({
        kind: "tests",
        name: `${name}#${index + 1}`,
        file,
        seconds: seconds(group),
        select: { mode: "only", tests: group.tests },
      })),
      {
        kind: "tests",
        name: `${name}#rest`,
        file,
        seconds: seconds(rest),
        select: { mode: "skip", tests: listed.flatMap((group) => group.tests) },
      },
    ];
  });
}

export const targetShardSeconds = 25;
const startupSeconds = { node: 1.5, bun: 0.3 };

export function selectedUnits(
  files: readonly string[],
  names: readonly string[],
  repeats: number,
  target: number,
  timings: Timings = testTimings,
): Unit[] {
  return [
    ...files.flatMap((file) => {
      const runner = nodeOnlyFiles.has(file) ? "node" : "bun";
      const testTarget = Math.max(
        1,
        Math.floor(target - startupSeconds[runner]),
      );
      return testUnits([file], testTarget, timings);
    }),
    ...lifecycleUnits(repeats, names, files),
  ];
}

export type Shard = { units: Unit[]; seconds: number };

export function assignShards(units: readonly Unit[], total: number): Shard[] {
  const shards: Shard[] = Array.from({ length: total }, () => ({
    units: [],
    seconds: 0,
  }));
  for (const unit of longestFirst(units)) {
    const lightest = shards.reduce((least, shard) =>
      shard.seconds < least.seconds ? shard : least,
    );
    lightest.units.push(unit);
    lightest.seconds += unit.seconds;
  }
  return shards;
}

const longestFirst = (units: readonly Unit[]): Unit[] =>
  [...units].sort(
    (a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name),
  );

export function estimateShardWallSeconds(
  units: readonly Unit[],
  concurrency: number,
): number {
  const lanes = Array.from(
    { length: Math.min(concurrency, units.length) },
    () => 0,
  );
  for (const unit of longestFirst(units)) {
    const lane = lanes.indexOf(Math.min(...lanes));
    lanes[lane] += (unit.seconds + startupSeconds[unitRunner(unit)]) * 1_000;
  }
  return Math.max(0, ...lanes) / 1_000;
}

export function parseShard(value: string): { index: number; total: number } {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(total) || index > total)
    throw new Error(`Expected a shard as <index>/<total>, got "${value}"`);
  return { index, total };
}

const escapedNames = (tests: readonly string[]) =>
  tests.map(escapeRegex).join("|");

export function exactNames(tests: readonly string[]): string {
  return `^(?:${escapedNames(tests)})$`;
}

export function unitRunner(unit: Unit): "node" | "bun" {
  return unit.kind === "lifecycle" ||
    nodeOnlyFiles.has(
      path
        .relative(root, path.resolve(root, unit.file))
        .replaceAll(path.sep, "/"),
    )
    ? "node"
    : "bun";
}

export function unitArguments(unit: Unit): string[] {
  if (unit.kind === "lifecycle") {
    return [
      "--test",
      "--experimental-strip-types",
      "--test-reporter=spec",
      ...(unit.pattern ? [`--test-name-pattern=${unit.pattern}`] : []),
      ...unit.files,
    ];
  }
  if (unitRunner(unit) === "bun") {
    const select =
      unit.select?.mode === "only"
        ? exactNames(unit.select.tests)
        : unit.select?.mode === "skip"
          ? `^(?!(?:${escapedNames(unit.select.tests)})$).*$`
          : undefined;
    return [
      "test",
      "--preload",
      "./test/support/TestTemp.ts",
      ...(select ? ["-t", select] : []),
      path.resolve(root, unit.file),
    ];
  }
  const select = unit.select
    ? [
        `--test-${unit.select.mode === "only" ? "name" : "skip"}-pattern=${exactNames(unit.select.tests)}`,
      ]
    : [];
  return [
    "--test",
    ...nodeTestFlags,
    "--test-reporter=spec",
    ...select,
    unit.file,
  ];
}

const unitFiles = (unit: Unit): readonly string[] =>
  unit.kind === "lifecycle" ? unit.files : [unit.file];

export type TopLevel = { name: string; milliseconds: number };

export type UnitResult = {
  unit: Unit;
  code: number | null;
  topLevel: TopLevel[];
};

function patternAlternatives(pattern: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let depth = 0;
  let characterClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") index++;
    else if (character === "[" && !characterClass) characterClass = true;
    else if (character === "]" && characterClass) characterClass = false;
    else if (!characterClass) {
      if (character === "(") depth++;
      else if (character === ")") depth--;
      else if (character === "|" && depth === 0) {
        alternatives.push(pattern.slice(start, index));
        start = index + 1;
      }
    }
  }
  alternatives.push(pattern.slice(start));
  return alternatives;
}

export function unitFailed({ unit, code, topLevel }: UnitResult): boolean {
  const files = unitFiles(unit).map((file) => path.resolve(root, file));
  const ran = topLevel
    .map((test) => test.name)
    .filter((name) => !files.includes(path.resolve(root, name)));
  if (code !== 0 || ran.length === 0) return true;
  if (unit.kind === "lifecycle" && unit.pattern) {
    return patternAlternatives(unit.pattern).some((branch) => {
      const pattern = new RegExp(branch);
      return !ran.some((name) => pattern.test(name));
    });
  }
  return (
    unit.kind === "tests" &&
    unit.select?.mode === "only" &&
    unit.select.tests.some((test) => !ran.includes(test))
  );
}

const topLevelResult = /^[✔✖] (.+?) \((\d[\d.]*)ms\)(?: #.*)?$/u;

const bunResult = /^\((?:pass|fail)\) (.+?)(?: \[(\d+(?:\.\d+)?)(ms|s)\])?$/u;
const suiteResult = /(?:^|\s)\[([^\]]+)\] (.*)$/u;

export function parseTopLevel(line: string): TopLevel | undefined {
  const plain = stripVTControlCharacters(line);
  const node = topLevelResult.exec(plain);
  if (node) return { name: node[1], milliseconds: Number(node[2]) };
  const bun = bunResult.exec(plain);
  return bun
    ? {
        name: bun[1],
        milliseconds: Number(bun[2] ?? 0) * (bun[3] === "s" ? 1000 : 1),
      }
    : undefined;
}

export function recordTimings(
  logs: readonly string[],
  files: readonly string[],
): Record<string, Record<string, number>> {
  const byName = new Map(files.map((file) => [unitName(file), file]));
  const timings = new Map<string, Map<string, number>>();
  for (const line of logs.flatMap((log) => log.split(/\r?\n/u))) {
    const match = suiteResult.exec(stripVTControlCharacters(line));
    const file = match
      ? byName.get(match[1].replace(/#[^#]*$/u, ""))
      : undefined;
    const test = match ? parseTopLevel(match[2]) : undefined;
    if (
      !file ||
      !test ||
      path.resolve(root, test.name) === path.resolve(root, file)
    )
      continue;
    const tests = timings.get(file) ?? new Map<string, number>();
    tests.set(test.name, Math.round(test.milliseconds / 100) / 10);
    timings.set(file, tests);
  }
  return Object.fromEntries(
    [...timings]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, tests]) => [
        file,
        Object.fromEntries([...tests].sort(([a], [b]) => a.localeCompare(b))),
      ]),
  );
}

async function runUnit(unit: Unit): Promise<UnitResult> {
  const runner = unitRunner(unit);
  const executable =
    runner === "node"
      ? nodeExecutable()
      : isBunRuntime()
        ? process.execPath
        : "bun";
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== "NODE_TEST_CONTEXT",
    ),
  );
  const child = spawn(executable, unitArguments(unit), {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const topLevel: TopLevel[] = [];
  const relay = (
    stream: NodeJS.ReadableStream,
    sink: NodeJS.WriteStream,
  ): void => {
    let pending = "";
    let reporting = true;
    stream.setEncoding("utf8");
    const emit = (line: string): void => {
      const plain = stripVTControlCharacters(line);
      if (runner === "node" && /^ℹ tests \d+$/u.test(plain)) reporting = false;
      const result = reporting ? parseTopLevel(plain) : undefined;
      if (result) topLevel.push(result);
      sink.write(`[${unit.name}] ${line}\n`);
    };
    stream.on("data", (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/u);
      pending = lines.pop() ?? "";
      lines.forEach(emit);
    });
    stream.on("end", () => {
      if (pending) emit(pending);
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      console.error(`[${unit.name}] ${error.message}`);
      resolve(null);
    });
    child.once("close", resolve);
  });
  return { unit, code, topLevel };
}

export async function runUnits(
  units: readonly Unit[],
  concurrency: number,
): Promise<UnitResult[]> {
  const queue = longestFirst(units);
  const results: UnitResult[] = [];
  const worker = async (): Promise<void> => {
    for (let unit = queue.shift(); unit; unit = queue.shift())
      results.push(await runUnit(unit));
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return results;
}

export async function runSuite(
  units: readonly Unit[],
  concurrency: number,
  allowEmpty = false,
): Promise<number> {
  if (!units.length && !allowEmpty) {
    console.error("No test units selected");
    return 1;
  }
  const started = performance.now();
  const results = await runUnits(units, concurrency);
  const failed = results.filter(unitFailed);
  const tests = results.reduce(
    (sum, result) => sum + result.topLevel.length,
    0,
  );
  console.log(
    `\n${results.length} units, ${tests} top-level tests, ${failed.length} failed units, ${Math.round((performance.now() - started) / 1000)}s`,
  );
  for (const { unit, code, topLevel } of failed)
    console.log(
      `FAILED ${unit.name}: exit ${code ?? "unknown"}, top-level results: ${topLevel.map((test) => test.name).join(" | ") || "none"}`,
    );
  return failed.length > 0 ? 1 : 0;
}

export function parseConcurrency(value: string): number {
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error(`Expected a positive concurrency, got "${value}"`);
  return concurrency;
}

export function parseWholeNumber(
  flag: string,
  value: string,
  minimum: number,
): number {
  const number = Number(value);
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(number) ||
    number < minimum
  ) {
    throw new Error(
      `Expected --${flag} to be an integer >= ${minimum}, got "${value}"`,
    );
  }
  return number;
}

function selection(
  value: readonly string[] | undefined,
  available: readonly string[],
  option: string,
): string[] {
  if (value === undefined) return [...available];
  const names = [...new Set(value.map((name) => name.trim()).filter(Boolean))];
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length)
    throw new Error(`Unknown --${option} selection: ${unknown.join(", ")}`);
  return names;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      shard: { type: "string", default: "1/1" },
      concurrency: { type: "string", default: "4" },
      "dry-run": { type: "boolean", default: false },
      record: { type: "boolean", default: false },
      "lifecycle-repeats": { type: "string", default: "0" },
      lifecycles: { type: "string" },
      files: { type: "string" },
      "files-from": { type: "string" },
      "target-shard-seconds": { type: "string" },
    },
  });
  if (values.record) {
    if (positionals.length === 0)
      throw new Error("--record needs one or more suite output logs");
    const timings = recordTimings(
      positionals.map((log) => readFileSync(log, "utf8")),
      testFiles(),
    );
    if (!Object.keys(timings).length)
      throw new Error("No test timings found in suite output logs");
    writeFileSync(timingsFile, `${JSON.stringify(timings, null, 2)}\n`);
    console.log(
      `Recorded ${Object.values(timings).reduce((sum, tests) => sum + Object.keys(tests).length, 0)} tests in ${Object.keys(timings).length} files`,
    );
    return 0;
  }
  if (positionals.length) throw new Error("Unexpected positional arguments");
  const { index, total } = parseShard(values.shard);
  const concurrency = parseConcurrency(values.concurrency);
  const repeats = parseWholeNumber(
    "lifecycle-repeats",
    values["lifecycle-repeats"],
    0,
  );
  const names = selection(
    values.lifecycles?.split(","),
    lifecycles.map(({ name }) => name),
    "lifecycles",
  );
  if (values.files !== undefined && values["files-from"] !== undefined)
    throw new Error("Use either --files or --files-from");
  const fileFilter =
    values["files-from"] === undefined
      ? values.files?.split(",")
      : readFileSync(values["files-from"], "utf8").split(/\r?\n/u);
  const files = selection(fileFilter, testFiles(), "files");
  const target =
    values["target-shard-seconds"] !== undefined
      ? parseWholeNumber(
          "target-shard-seconds",
          values["target-shard-seconds"],
          1,
        )
      : fileFilter !== undefined
        ? targetShardSeconds
        : unitTarget(total * concurrency);
  const shards = assignShards(
    selectedUnits(files, names, repeats, target),
    total,
  );
  if (values["dry-run"]) {
    shards.forEach((shard, position) =>
      console.log(
        `shard ${position + 1}/${total}: ~${shard.seconds}s\n${shard.units.map((unit) => `  ${unit.name} ~${unit.seconds}s`).join("\n")}`,
      ),
    );
    return 0;
  }
  return await runSuite(shards[index - 1].units, concurrency);
}

if (import.meta.main) process.exitCode = await main();
