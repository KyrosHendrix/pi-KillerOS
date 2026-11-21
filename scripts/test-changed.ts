import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  assignShards,
  estimateShardWallSeconds,
  lifecycles,
  parseConcurrency,
  parseWholeNumber,
  runSuite,
  selectedUnits,
  targetShardSeconds,
  testFiles,
  testTimings,
  testUnits,
  unitTarget,
  type Timings,
} from "./test-suite.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = "test/RepositoryContracts.test.ts";

export const moduleTests = {
  "activity.ts": [
    "test/Activity.e2e.test.ts",
    "test/runtime-receipts.e2e.test.ts",
  ],
  "auto-compaction.ts": [
    "test/CompactionTrigger.e2e.test.ts",
    "test/CompactionGoals.e2e.test.ts",
    "test/CompactionModes.e2e.test.ts",
    "test/CompactionSettings.e2e.test.ts",
    "test/CompactionManual.e2e.test.ts",
    "test/CompactionSessionBoundaries.e2e.test.ts",
  ],
  "bounded-text.ts": ["test/BoundedText.e2e.test.ts"],
  "change-receipt.ts": [
    "test/runtime-receipt-git.e2e.test.ts",
    "test/runtime-receipt-conversion.e2e.test.ts",
    "test/runtime-receipts.e2e.test.ts",
  ],
  "checks.ts": ["test/runtime-receipts.e2e.test.ts"],
  "codex-fast-state.ts": ["test/runtime-fast.e2e.test.ts"],
  "codex-fast.ts": ["test/runtime-fast.e2e.test.ts"],
  "commands.ts": ["test/SlashCommands.e2e.test.ts"],
  "display.ts": ["test/Display.e2e.test.ts"],
  "errors.ts": [],
  "file-identity.ts": [],
  "footer.ts": [
    "test/Footer.e2e.test.ts",
    "test/FooterGitSchedule.test.ts",
    "test/FooterGitSafety.test.ts",
  ],
  "goal-command.ts": [
    "test/Goals.e2e.test.ts",
    "test/GoalLifecycle.e2e.test.ts",
    "test/GoalUi.e2e.test.ts",
  ],
  "goal-model.ts": [],
  "goal-interface.ts": [
    "test/Goals.e2e.test.ts",
    "test/GoalLifecycle.e2e.test.ts",
    "test/GoalUi.e2e.test.ts",
  ],
  "goal-runtime.ts": [
    "test/Goals.e2e.test.ts",
    "test/GoalLifecycle.e2e.test.ts",
    "test/BlockedGoalCompletion.e2e.test.ts",
    "test/GoalCompletionVerification.e2e.test.ts",
  ],
  "goal-settlement.ts": [
    "test/Goals.e2e.test.ts",
    "test/GoalLifecycle.e2e.test.ts",
    "test/BlockedGoalCompletion.e2e.test.ts",
    "test/CompactionGoals.e2e.test.ts",
  ],
  "goal-state.ts": [
    "test/GoalLifecycle.e2e.test.ts",
    "test/GoalHandoff.e2e.test.ts",
    "test/runtime-restoration.e2e.test.ts",
  ],
  "guards.ts": [],
  "handoff.ts": [
    "test/Handoff.e2e.test.ts",
    "test/HandoffTerminal.e2e.test.ts",
    "test/GoalHandoff.e2e.test.ts",
  ],
  "hooks.ts": ["test/Hooks.e2e.test.ts", "test/Hooks.system.test.ts"],
  "notifications.ts": ["test/Notifications.e2e.test.ts"],
  "passive-git-status.ts": [
    "test/Footer.e2e.test.ts",
    "test/runtime-receipt-git.e2e.test.ts",
    "test/PassiveGitStatus.test.ts",
    "test/FooterGitSafety.test.ts",
  ],
  "personal-instructions.ts": ["test/PersonalInstructions.e2e.test.ts"],
  "pi-context.ts": [],
  "question-ui.ts": [
    "test/Question.e2e.test.ts",
    "test/QuestionHistory.test.ts",
  ],
  "question.ts": ["test/Question.e2e.test.ts", "test/QuestionHistory.test.ts"],
  "safe-terminal-text.ts": [],
  "secret-detector.ts": [
    "test/Handoff.e2e.test.ts",
    "test/SecretDetector.test.ts",
  ],
  "settings.ts": ["test/Settings.e2e.test.ts"],
  "shell-ui.ts": ["test/ShellUi.e2e.test.ts", "test/Theme.test.ts"],
  "worked-for.ts": ["test/runtime-receipts.e2e.test.ts"],
} as const satisfies Record<string, readonly string[]>;

const owners: Readonly<Partial<Record<string, readonly string[]>>> =
  moduleTests;

export const hostFiles = [
  "Killeros.ts",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".node-version",
  "bunfig.toml",
];

export const fullSuiteFiles = new Set([
  ...hostFiles,
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
  "scripts/test-suite.ts",
  "scripts/test-changed.ts",
  "test/test-timings.json",
  "test/support/TestTemp.ts",
  "test/support/NodeRuntime.ts",
  "test/support/LaunchCaches.ts",
  "test/support/TimerResolution.ts",
]);

export const hostTests = [
  "test/PiExtensionContract.test.ts",
  "test/runtime-restoration.e2e.test.ts",
  "test/runtime-startup.e2e.test.ts",
  "test/runtime-tools.e2e.test.ts",
  "test/runtime-platform.e2e.test.ts",
  "test/runtime-package.e2e.test.ts",
  "test/runtime-print-json.e2e.test.ts",
  "test/runtime-native-provider.e2e.test.ts",
];

const posix = (file: string): string => file.replaceAll("\\", "/");
const read = (file: string): string =>
  readFileSync(path.join(root, file), "utf8");
const isFullSuiteFile = (file: string) =>
  fullSuiteFiles.has(file) || file.startsWith(".github/actions/");

export function isFullSuiteChange(changed: readonly string[]): boolean {
  return changed.some((file) => isFullSuiteFile(posix(file)));
}

function filesIn(directory: string): string[] {
  const entries = readdirSync(path.join(root, directory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) =>
      posix(path.relative(root, path.join(entry.parentPath, entry.name))),
    );
}

function importers(files: readonly string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    for (const [, specifier] of read(file).matchAll(
      /["'](\.\.?\/[^"']+\.ts)["']/gu,
    )) {
      const target = posix(path.join(path.dirname(file), specifier));
      graph.set(target, (graph.get(target) ?? new Set()).add(file));
    }
  }
  return graph;
}

function closure(start: string, graph: Map<string, Set<string>>): Set<string> {
  const seen = new Set([start]);
  for (const file of seen)
    for (const next of graph.get(file) ?? []) seen.add(next);
  return seen;
}

export function selectTests(changed: readonly string[]): string[] {
  const modules = filesIn("killeros");
  const testSources = filesIn("test");
  const moduleImporters = importers(modules);
  const testImporters = importers(testSources);
  const tests = new Set(testFiles());
  const selected = new Set<string>([contracts]);
  for (const file of changed.map(posix)) {
    if (file.startsWith("killeros/")) {
      for (const module of closure(file, moduleImporters)) {
        for (const test of owners[path.basename(module)] ?? [])
          selected.add(test);
        for (const dependent of closure(module, testImporters))
          if (tests.has(dependent)) selected.add(dependent);
      }
    } else if (file.startsWith("test/")) {
      for (const dependent of closure(file, testImporters))
        if (tests.has(dependent)) selected.add(dependent);
    } else if (hostFiles.includes(file)) {
      for (const test of hostTests) selected.add(test);
    } else {
      for (const test of tests)
        if (read(test).includes(file)) selected.add(test);
    }
  }
  return [...selected].filter((file) => tests.has(file)).sort();
}

export function selectLifecycles(files: readonly string[]): string[] {
  return lifecycles
    .filter((lifecycle) => lifecycle.files.some((file) => files.includes(file)))
    .map(({ name }) => name);
}

type PlanOptions = {
  full: boolean;
  maxShards: number;
  targetSeconds: number;
  concurrency: number;
  lifecycleRepeats: number;
};

export function ciPlan(
  changed: readonly string[],
  options: PlanOptions,
  timings: Timings = testTimings,
) {
  const paths = [...new Set(changed.map(posix))];
  const global = paths.find(isFullSuiteFile);
  const fullSuite = options.full || isFullSuiteChange(paths);
  const reason = options.full
    ? "full override"
    : global
      ? `full-suite input: ${global}`
      : "reachable tests";
  const files = fullSuite ? testFiles() : selectTests(paths);
  const names = selectLifecycles(files);
  const units = selectedUnits(
    files,
    names,
    options.lifecycleRepeats,
    options.targetSeconds,
    timings,
  );
  const limit = Math.min(options.maxShards, units.length);
  let shardCount = 0;
  let estimatedMaxShardSeconds = 0;
  while (shardCount < limit) {
    shardCount++;
    estimatedMaxShardSeconds = Math.max(
      ...assignShards(units, shardCount).map((shard) =>
        estimateShardWallSeconds(shard.units, options.concurrency),
      ),
    );
    if (estimatedMaxShardSeconds <= options.targetSeconds) break;
  }
  return {
    fullSuite,
    reason,
    changedCount: paths.length,
    files,
    lifecycles: names,
    shardCount,
    shards: Array.from({ length: shardCount }, (_, index) => index + 1),
    concurrency: options.concurrency,
    lifecycleRepeats: options.lifecycleRepeats,
    estimatedMaxShardSeconds,
  };
}

function git(directory: string, ...args: string[]) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
}

export function parseNameStatus(output: string): string[] {
  if (!output) return [];
  const fields = output.split("\0");
  if (fields.pop() !== "")
    throw new Error("Expected NUL-terminated Git diff output");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const file = fields[index++];
    if (!/^[ACDMRTUXB]\d*$/u.test(status) || !file)
      throw new Error("Invalid Git name-status entry");
    paths.add(file);
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (!destination)
        throw new Error("Missing destination in Git name-status entry");
      paths.add(destination);
    }
  }
  return [...paths];
}

function diff(directory: string, ...refs: string[]) {
  return parseNameStatus(
    git(
      directory,
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies-harder",
      ...refs,
      "--",
    ),
  );
}

export function diffFiles(
  base: string,
  head: string,
  directory = root,
): string[] {
  const refs = [base, head].map((ref) =>
    git(
      directory,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{tree}`,
    ).trim(),
  );
  return diff(directory, ...refs);
}

function changedFiles(base: string) {
  const commit = git(
    root,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${base}^{commit}`,
  ).trim();
  const mergeBase = git(root, "merge-base", commit, "HEAD").trim();
  const untracked = git(
    root,
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set([...diff(root, mergeBase), ...untracked])];
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      "diff-base": { type: "string" },
      "diff-head": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "ci-plan": { type: "boolean", default: false },
      "max-shards": { type: "string", default: "12" },
      "target-shard-seconds": {
        type: "string",
        default: String(targetShardSeconds),
      },
      concurrency: { type: "string" },
      "lifecycle-repeats": { type: "string", default: "2" },
      full: { type: "boolean", default: false },
    },
  });
  const base = values["diff-base"];
  const head = values["diff-head"];
  if ((base === undefined) !== (head === undefined))
    throw new Error("Use --diff-base and --diff-head together");
  if (base !== undefined && (values.base !== undefined || positionals.length)) {
    throw new Error(
      "Use --diff-base and --diff-head without --base or positional paths",
    );
  }
  const changed =
    base !== undefined && head !== undefined
      ? diffFiles(base, head)
      : positionals.length || (values.full && values.base === undefined)
        ? positionals
        : changedFiles(values.base ?? "origin/main");
  const concurrency = parseConcurrency(
    values.concurrency ?? (values["ci-plan"] ? "2" : "4"),
  );
  if (values["ci-plan"]) {
    console.log(
      JSON.stringify(
        ciPlan(changed, {
          full: values.full,
          maxShards: parseWholeNumber("max-shards", values["max-shards"], 1),
          targetSeconds: parseWholeNumber(
            "target-shard-seconds",
            values["target-shard-seconds"],
            1,
          ),
          concurrency,
          lifecycleRepeats: parseWholeNumber(
            "lifecycle-repeats",
            values["lifecycle-repeats"],
            0,
          ),
        }),
      ),
    );
    return 0;
  }
  const tests = values.full ? testFiles() : selectTests(changed);
  console.log(
    `${changed.length} changed path(s) select ${tests.length} test file(s):\n${tests.map((test) => `  ${test}`).join("\n")}`,
  );
  if (values["dry-run"]) return 0;
  const selected = Object.fromEntries(
    Object.entries(testTimings).filter(([file]) => tests.includes(file)),
  );
  return await runSuite(
    testUnits(tests, unitTarget(concurrency, selected)),
    concurrency,
  );
}

if (import.meta.main) process.exitCode = await main();
