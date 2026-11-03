/**
 * Runs one CI shard of the full test suite.
 *
 *   node --experimental-strip-types scripts/test-shard.ts <index>/<total>             run shard <index> of <total>
 *   node --experimental-strip-types scripts/test-shard.ts <index>/<total> --dry-run   print every shard without running
 *
 * Node's `--test-shard` deals files out by name, which can stack the slowest files on one runner.
 * This script deals them out by measured duration instead: longest first, each onto the shard with
 * the least estimated time. Every file that `npm test` runs lands in exactly one shard. A file
 * missing from `testSeconds` gets a default estimate, so a new test always runs.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { testFlags } from "./test-changed.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * Seconds of test time per file on a CI shard runner, from the shard logs of a green CI run.
 * Refresh it when one shard regularly finishes well after the others.
 */
export const testSeconds = {
  "test/Question.e2e.test.ts": 121,
  "test/runtime-receipts.e2e.test.ts": 106,
  "test/Footer.e2e.test.ts": 105,
  "test/runtime-receipt-git.e2e.test.ts": 97,
  "test/GoalLifecycle.e2e.test.ts": 94,
  "test/runtime-receipt-conversion.e2e.test.ts": 60,
  "test/BoundedText.e2e.test.ts": 45,
  "test/runtime-tools.e2e.test.ts": 41,
  "test/Handoff.e2e.test.ts": 39,
  "test/Editor.e2e.test.ts": 35,
  "test/CompactionGoals.e2e.test.ts": 23,
  "test/runtime-print-json.e2e.test.ts": 22,
  "test/BlockedGoalCompletion.e2e.test.ts": 21,
  "test/CompactionTrigger.e2e.test.ts": 21,
  "test/Notifications.e2e.test.ts": 20,
  "test/Goals.e2e.test.ts": 20,
  "test/Activity.e2e.test.ts": 16,
  "test/PiTerminalControls.test.ts": 16,
  "test/runtime-package.e2e.test.ts": 14,
  "test/ShellUi.e2e.test.ts": 13,
  "test/Hooks.system.test.ts": 13,
  "test/GoalCompletionVerification.e2e.test.ts": 12,
  "test/GoalUi.e2e.test.ts": 11,
  "test/verify-release.test.ts": 11,
  "test/runtime-native-provider.e2e.test.ts": 10,
  "test/PiExtensionContract.test.ts": 10,
  "test/CompactionRestoration.e2e.test.ts": 9,
  "test/Settings.e2e.test.ts": 8,
  "test/CompactionSessionBoundaries.e2e.test.ts": 8,
  "test/SlashCommands.e2e.test.ts": 7,
  "test/Hooks.e2e.test.ts": 6,
  "test/runtime-fast.e2e.test.ts": 6,
  "test/Display.e2e.test.ts": 5,
  "test/installed-archive.system.test.ts": 5,
  "test/CompactionManual.e2e.test.ts": 5,
  "test/PiStartup.test.ts": 4,
  "test/CompactionSettings.e2e.test.ts": 4,
  "test/HandoffTerminal.e2e.test.ts": 4,
  "test/PiToolRestoration.e2e.test.ts": 4,
  "test/GoalHandoff.e2e.test.ts": 3,
  "test/runtime-startup.e2e.test.ts": 3,
  "test/PersonalInstructions.e2e.test.ts": 2,
  "test/RepositoryContracts.test.ts": 2,
  "test/CompactionModes.e2e.test.ts": 2,
  "test/test-changed.test.ts": 1,
  "test/test-shard.test.ts": 1,
  "test/runtime-platform.e2e.test.ts": 1,
  "test/npm-package-fixtures.system.test.ts": 1,
  "test/release-notes.test.ts": 1,
  "test/PiRpcControls.test.ts": 1,
  "test/ScenarioFailure.test.ts": 1,
  "test/FooterGitSchedule.test.ts": 1,
  "test/Theme.test.ts": 1,
  "test/ShellUi.test.ts": 1,
  "test/runtime-restoration.e2e.test.ts": 1,
} as const satisfies Record<string, number>;

const estimates: Readonly<Partial<Record<string, number>>> = testSeconds;

/** Estimate for a file without a timing, so a new file counts as mid-sized until `testSeconds` lists it. */
export const unmeasuredSeconds = 10;

/** CI runners have 4 vCPUs; two files at a time keeps Pi child processes from starving each other. */
const shardConcurrency = 2;

/** Lists the files that the `npm test` glob `test/*.test.*` matches, sorted. */
export function testFiles(): string[] {
  return readdirSync(new URL("../test/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.includes(".test."))
    .map((entry) => `test/${entry.name}`)
    .sort();
}

export type Shard = { files: string[]; seconds: number };

/** Splits files into `total` shards with balanced estimated seconds. Each shard lists its longest files first. */
export function assignShards(files: readonly string[], total: number): Shard[] {
  const seconds = (file: string): number => estimates[file] ?? unmeasuredSeconds;
  const shards: Shard[] = Array.from({ length: total }, () => ({ files: [], seconds: 0 }));
  const longestFirst = [...files].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b));
  for (const file of longestFirst) {
    const lightest = shards.reduce((least, shard) => shard.seconds < least.seconds ? shard : least);
    lightest.files.push(file);
    lightest.seconds += seconds(file);
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

function main(): number {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean", default: false } } });
  if (positionals.length !== 1) throw new Error("Usage: test-shard.ts <index>/<total> [--dry-run]");
  const { index, total } = parseShard(positionals[0]);
  const shards = assignShards(testFiles(), total);
  if (values["dry-run"]) {
    shards.forEach((shard, position) => console.log(`shard ${position + 1}/${total}: ~${shard.seconds}s\n${shard.files.map((file) => `  ${file}`).join("\n")}`));
    return 0;
  }
  const flags = testFlags().map((flag) => flag.startsWith("--test-concurrency=") ? `--test-concurrency=${shardConcurrency}` : flag);
  const result = spawnSync(process.execPath, [...flags, ...shards[index - 1].files], { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

if (import.meta.main) process.exitCode = main();
