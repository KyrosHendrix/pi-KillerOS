/**
 * Runs the test files that cover this branch's changes, so local checks stay fast and CI owns the full suite.
 *
 *   npm run test:changed                      changes since the merge base with origin/main, plus uncommitted and untracked files
 *   npm run test:changed -- --base <ref>      compare against the merge base with <ref>
 *   npm run test:changed -- --dry-run         print the selection without running it
 *   npm run test:changed -- <paths...>        select for these paths instead of Git's changes
 *
 * Selection always includes the repository contracts, then expands each changed path:
 * - a KillerOS module selects its owner tests and those of every module that imports it, transitively;
 * - a test file selects itself, and a test support file selects every test that imports it;
 * - host entry points and package metadata select the host integration tests;
 * - any other path selects the tests whose source names that path.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runSuite, testTimings, testUnits, unitTarget } from "./test-suite.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = "test/RepositoryContracts.test.ts";

/** Tests that own each KillerOS module. Shared modules list none and inherit their importers' tests. */
export const moduleTests = {
  "activity.ts": ["test/Activity.e2e.test.ts", "test/runtime-receipts.e2e.test.ts"],
  "auto-compaction.ts": [
    "test/CompactionTrigger.e2e.test.ts", "test/CompactionGoals.e2e.test.ts", "test/CompactionModes.e2e.test.ts",
    "test/CompactionSettings.e2e.test.ts", "test/CompactionManual.e2e.test.ts",
    "test/CompactionSessionBoundaries.e2e.test.ts",
  ],
  "bounded-text.ts": ["test/BoundedText.e2e.test.ts"],
  "change-receipt.ts": ["test/runtime-receipt-git.e2e.test.ts", "test/runtime-receipt-conversion.e2e.test.ts", "test/runtime-receipts.e2e.test.ts"],
  "checks.ts": ["test/runtime-receipts.e2e.test.ts"],
  "codex-fast-state.ts": ["test/runtime-fast.e2e.test.ts"],
  "codex-fast.ts": ["test/runtime-fast.e2e.test.ts"],
  "commands.ts": ["test/SlashCommands.e2e.test.ts"],
  "display.ts": ["test/Display.e2e.test.ts"],
  "errors.ts": [],
  "file-identity.ts": [],
  "footer.ts": ["test/Footer.e2e.test.ts", "test/FooterGitSchedule.test.ts", "test/FooterGitSafety.test.ts"],
  "goal-command.ts": ["test/Goals.e2e.test.ts", "test/GoalLifecycle.e2e.test.ts", "test/GoalUi.e2e.test.ts"],
  "goal-model.ts": [],
  "goal-interface.ts": ["test/Goals.e2e.test.ts", "test/GoalLifecycle.e2e.test.ts", "test/GoalUi.e2e.test.ts"],
  "goal-runtime.ts": [
    "test/Goals.e2e.test.ts", "test/GoalLifecycle.e2e.test.ts", "test/BlockedGoalCompletion.e2e.test.ts",
    "test/GoalCompletionVerification.e2e.test.ts",
  ],
  "goal-settlement.ts": [
    "test/Goals.e2e.test.ts", "test/GoalLifecycle.e2e.test.ts", "test/BlockedGoalCompletion.e2e.test.ts",
    "test/CompactionGoals.e2e.test.ts",
  ],
  "goal-state.ts": ["test/GoalLifecycle.e2e.test.ts", "test/GoalHandoff.e2e.test.ts", "test/runtime-restoration.e2e.test.ts"],
  "guards.ts": [],
  "handoff.ts": ["test/Handoff.e2e.test.ts", "test/HandoffTerminal.e2e.test.ts", "test/GoalHandoff.e2e.test.ts"],
  "hooks.ts": ["test/Hooks.e2e.test.ts", "test/Hooks.system.test.ts"],
  "notifications.ts": ["test/Notifications.e2e.test.ts"],
  "passive-git-status.ts": ["test/Footer.e2e.test.ts", "test/runtime-receipt-git.e2e.test.ts", "test/PassiveGitStatus.test.ts", "test/FooterGitSafety.test.ts"],
  "personal-instructions.ts": ["test/PersonalInstructions.e2e.test.ts"],
  "pi-context.ts": [],
  "question-ui.ts": ["test/Question.e2e.test.ts", "test/QuestionHistory.test.ts"],
  "question.ts": ["test/Question.e2e.test.ts", "test/QuestionHistory.test.ts"],
  "safe-terminal-text.ts": [],
  "secret-detector.ts": ["test/Handoff.e2e.test.ts", "test/SecretDetector.test.ts"],
  "settings.ts": ["test/Settings.e2e.test.ts"],
  "shell-ui.ts": ["test/ShellUi.e2e.test.ts", "test/Theme.test.ts"],
  "worked-for.ts": ["test/runtime-receipts.e2e.test.ts"],
} as const satisfies Record<string, readonly string[]>;

const owners: Readonly<Partial<Record<string, readonly string[]>>> = moduleTests;

/** Files that change how Pi loads or runs KillerOS as a whole. */
export const hostFiles = ["Killeros.ts", "package.json", "package-lock.json", "tsconfig.json", ".node-version", "eslint.config.js"];

/** Host integration tests: activation, packaging, startup, modes, tools, and provider transport. */
export const hostTests = [
  "test/PiExtensionContract.test.ts", "test/runtime-restoration.e2e.test.ts",
  "test/runtime-startup.e2e.test.ts", "test/runtime-tools.e2e.test.ts", "test/runtime-platform.e2e.test.ts",
  "test/runtime-package.e2e.test.ts", "test/runtime-print-json.e2e.test.ts", "test/runtime-native-provider.e2e.test.ts",
];

const posix = (file: string): string => file.split(path.sep).join("/");
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const isTestFile = (file: string): boolean => /^test\/[^/]+\.test\.[cm]?ts$/u.test(file);

function filesIn(directory: string): string[] {
  const entries = readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => posix(path.relative(root, path.join(entry.parentPath, entry.name))));
}

/** Maps each file to the files that reference it with a relative `.ts` specifier, in imports or `new URL(...)`. */
function importers(files: readonly string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    for (const [, specifier] of read(file).matchAll(/["'](\.\.?\/[^"']+\.ts)["']/gu)) {
      const target = posix(path.join(path.dirname(file), specifier));
      graph.set(target, (graph.get(target) ?? new Set()).add(file));
    }
  }
  return graph;
}

function closure(start: string, graph: Map<string, Set<string>>): Set<string> {
  const seen = new Set([start]);
  for (const file of seen) for (const next of graph.get(file) ?? []) seen.add(next);
  return seen;
}

/** Returns the test files that cover the given repository-relative paths. */
export function selectTests(changed: readonly string[]): string[] {
  const modules = filesIn("killeros");
  const testSources = filesIn("test");
  const moduleImporters = importers(modules);
  const testImporters = importers(testSources);
  const tests = testSources.filter(isTestFile);
  const selected = new Set<string>([contracts]);
  for (const file of changed.map(posix)) {
    if (file.startsWith("killeros/")) {
      for (const module of closure(file, moduleImporters)) for (const test of owners[path.basename(module)] ?? []) selected.add(test);
    } else if (file.startsWith("test/")) {
      for (const dependent of closure(file, testImporters)) if (isTestFile(dependent) && existsSync(path.join(root, dependent))) selected.add(dependent);
    } else if (hostFiles.includes(file)) {
      for (const test of hostTests) selected.add(test);
    } else {
      for (const test of tests) if (read(test).includes(file)) selected.add(test);
    }
  }
  return [...selected].sort();
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** Lists files changed since the merge base with `base`, including uncommitted and untracked files. */
function changedFiles(base: string): string[] {
  const mergeBase = git("merge-base", base, "HEAD");
  const tracked = git("diff", "--name-only", mergeBase);
  const untracked = git("ls-files", "--others", "--exclude-standard");
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
}

/** Selects the tests that cover the changed files, prints them for --dry-run or runs them, and resolves to the exit code. */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { base: { type: "string", default: "origin/main" }, "dry-run": { type: "boolean", default: false } },
  });
  const changed = positionals.length > 0 ? positionals : changedFiles(values.base);
  const tests = selectTests(changed);
  console.log(`${changed.length} changed path(s) select ${tests.length} test file(s):\n${tests.map((test) => `  ${test}`).join("\n")}`);
  if (values["dry-run"]) return 0;
  // The same units and concurrency as `npm test`, sized for the selected files so a small selection still fills four slots.
  const selected = Object.fromEntries(Object.entries(testTimings).filter(([file]) => tests.includes(file)));
  return await runSuite(testUnits(tests, unitTarget(4, selected)), 4);
}

if (import.meta.main) process.exitCode = await main();
