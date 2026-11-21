import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ciPlan,
  diffFiles,
  fullSuiteFiles,
  hostFiles,
  hostTests,
  isFullSuiteChange,
  moduleTests,
  parseNameStatus,
  selectLifecycles,
  selectTests,
} from "../scripts/test-changed.ts";
import {
  assignShards,
  estimateShardWallSeconds,
  selectedUnits,
} from "../scripts/test-suite.ts";
import { isBunRuntime } from "./support/NodeRuntime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const modules = readdirSync(new URL("../killeros/", import.meta.url))
  .filter((file) => file.endsWith(".ts"))
  .sort();
const testFiles = readdirSync(new URL("./", import.meta.url))
  .filter((file) => /\.test\.[cm]?ts$/u.test(file))
  .map((file) => `test/${file}`)
  .sort();
const cli = [
  ...(isBunRuntime() ? [] : ["--experimental-strip-types"]),
  "scripts/test-changed.ts",
];

test("changed-test selection maps every KillerOS module to existing tests", () => {
  assert.deepEqual(
    Object.keys(moduleTests).sort(),
    modules,
    "Every module needs an entry, and every entry a module",
  );
  for (const file of [...Object.values(moduleTests).flat(), ...hostTests])
    assert.ok(
      existsSync(new URL(`../${file}`, import.meta.url)),
      `${file} must exist`,
    );
  for (const module of modules) {
    const selected = selectTests([`killeros/${module}`]).filter(
      (file) => file !== "test/RepositoryContracts.test.ts",
    );
    assert.ok(
      selected.length > 0,
      `killeros/${module} must select at least one runtime test`,
    );
  }
});

test("every test file is selected by a change to the code it covers", () => {
  const sources = [
    ...modules.map((module) => `killeros/${module}`),
    ...hostFiles,
    "scripts/verify-release.ts",
    "scripts/release-notes.ts",
    "scripts/test-changed.ts",
    "scripts/test-suite.ts",
    "themes/killeros.json",
  ];
  const reachable = new Set(sources.flatMap((source) => selectTests([source])));
  const harnessTests = ["test/ScenarioFailure.test.ts"];
  assert.deepEqual(
    testFiles.filter((file) => !reachable.has(file)),
    harnessTests,
    "Map new tests in scripts/test-changed.ts",
  );
  for (const file of harnessTests)
    assert.ok(
      readdirSync(new URL("./support/", import.meta.url)).some((support) =>
        selectTests([`test/support/${support}`]).includes(file),
      ),
      file,
    );
});

test("changed-test selection follows importers, support files, host files, and path references", () => {
  const shared = selectTests(["killeros/safe-terminal-text.ts"]);
  for (const file of [
    "test/Question.e2e.test.ts",
    "test/Footer.e2e.test.ts",
    "test/Handoff.e2e.test.ts",
  ])
    assert.ok(shared.includes(file), file);
  const bounded = selectTests(["killeros/bounded-text.ts"]);
  for (const file of [
    "test/BoundedText.e2e.test.ts",
    "test/Goals.e2e.test.ts",
    "test/Question.e2e.test.ts",
  ])
    assert.ok(bounded.includes(file), file);
  assert.ok(
    !bounded.includes("test/Footer.e2e.test.ts"),
    "A module must not select tests of code that does not import it",
  );
  assert.deepEqual(selectTests(["killeros/codex-fast.ts"]), [
    "test/RepositoryContracts.test.ts",
    "test/runtime-fast.e2e.test.ts",
  ]);

  const cache = selectTests(["test/support/LaunchCaches.ts"]);
  for (const file of ["test/Footer.e2e.test.ts", "test/Goals.e2e.test.ts"])
    assert.ok(cache.includes(file), file);

  assert.ok(
    selectTests(["package.json"]).includes("test/PiExtensionContract.test.ts"),
  );
  assert.ok(
    selectTests(["scripts/verify-release.ts"]).includes(
      "test/verify-release.test.ts",
    ),
  );
  assert.deepEqual(
    selectTests([[".github", "workflows", "ci.yml"].join("/")]),
    ["test/RepositoryContracts.test.ts"],
  );
  assert.ok(
    selectTests(["README.md"]).includes("test/runtime-package.e2e.test.ts"),
    "Packaging tests read the README",
  );
  assert.deepEqual(selectTests(["test/Theme.test.ts"]), [
    "test/RepositoryContracts.test.ts",
    "test/Theme.test.ts",
  ]);
});

test("test:changed dry run prints the selection without running it", () => {
  const output = execFileSync(
    process.execPath,
    [...cli, "--dry-run", "killeros/codex-fast.ts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.match(output, /1 changed path\(s\) select 2 test file\(s\):/u);
  assert.match(output, /test\/runtime-fast\.e2e\.test\.ts/u);
  assert.doesNotMatch(
    output,
    /^ℹ tests/mu,
    "A dry run must not start the test runner",
  );
});

test("KillerOS changes reach direct test importers and tests that use support files", () => {
  const files = selectTests(["killeros/passive-git-status.ts"]);
  assert.ok(files.includes("test/PiExtensionContract.test.ts"));
  assert.ok(
    selectTests(["killeros/guards.ts"]).includes(
      "test/runtime-package.e2e.test.ts",
    ),
  );
});

test("committed-tree diffs keep both sides of renames and copies and preserve deletions", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-test-diff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  writeFileSync(path.join(directory, "old name.ts"), "old path contents\n");
  writeFileSync(
    path.join(directory, "copy source.ts"),
    "copy source contents\n",
  );
  writeFileSync(path.join(directory, "deleted.ts"), "delete contents\n");
  git("add", "--all");
  const base = git("write-tree");
  renameSync(
    path.join(directory, "old name.ts"),
    path.join(directory, "new name.ts"),
  );
  writeFileSync(
    path.join(directory, "copy destination.ts"),
    "copy source contents\n",
  );
  rmSync(path.join(directory, "deleted.ts"));
  git("add", "--all");
  const head = git("write-tree");
  writeFileSync(
    path.join(directory, "untracked.ts"),
    "ignored by the tree diff\n",
  );
  assert.deepEqual(diffFiles(base, head, directory).sort(), [
    "copy destination.ts",
    "copy source.ts",
    "deleted.ts",
    "new name.ts",
    "old name.ts",
  ]);
  assert.deepEqual(
    parseNameStatus("R100\0old\tfile\0new\nfile\0D\0removed\0"),
    ["old\tfile", "new\nfile", "removed"],
  );
  assert.throws(() => parseNameStatus("R100\0old\0"), /Missing destination/u);
});

test("reachability uses old source paths and keeps only surviving test files", () => {
  assert.deepEqual(
    selectTests(
      parseNameStatus(
        "R100\0test/removed.test.ts\0test/Theme.test.ts\0D\0killeros/codex-fast.ts\0",
      ),
    ),
    [
      "test/RepositoryContracts.test.ts",
      "test/Theme.test.ts",
      "test/runtime-fast.e2e.test.ts",
    ],
  );
  assert.deepEqual(
    selectLifecycles([
      "test/Goals.e2e.test.ts",
      "test/PiExtensionContract.test.ts",
    ]),
    ["installed CLI pilot", "terminal pilot", "Pi cancellation"],
  );
});

const planOptions = {
  full: false,
  maxShards: 12,
  targetSeconds: 25,
  concurrency: 2,
  lifecycleRepeats: 2,
};

test("CI uses concurrency to reduce shard wall time and the shards needed", () => {
  const changed = ["killeros/codex-fast.ts"];
  const timings = {
    "test/RepositoryContracts.test.ts": {
      "lockfile matches the exact Pi development pins": 10,
    },
    "test/runtime-fast.e2e.test.ts": {
      "real Pi /codex-fast controls process-local state, status, and footer": 10,
    },
  };
  const serial = { ...planOptions, concurrency: 1, targetSeconds: 15 };
  const parallel = { ...serial, concurrency: 2 };
  assert.equal(ciPlan(changed, serial, timings).shardCount, 2);
  assert.equal(ciPlan(changed, parallel, timings).shardCount, 1);
  assert.equal(
    ciPlan(changed, { ...serial, maxShards: 1 }, timings)
      .estimatedMaxShardSeconds,
    23,
  );
  assert.equal(
    ciPlan(changed, parallel, timings).estimatedMaxShardSeconds,
    11.5,
  );
});

test("global CI inputs and the full override select the entire runnable suite", () => {
  for (const file of [
    ...fullSuiteFiles,
    ".github\\actions\\tested-tree\\action.yml",
  ])
    assert.ok(isFullSuiteChange([file]), file);
  assert.ok(!isFullSuiteChange(["README.md", "test/Theme.test.ts"]));
  const changed = ["killeros/codex-fast.ts", "bunfig.toml"];
  const plan = ciPlan(changed, planOptions);
  assert.equal(plan.fullSuite, true);
  assert.match(plan.reason, /bunfig\.toml/u);
  assert.deepEqual(plan.files, testFiles);
  assert.equal(plan.shardCount, planOptions.maxShards);
  assert.deepEqual(
    ciPlan([], { ...planOptions, full: true }).files,
    plan.files,
  );
});

test("CI packs reachable tests by recorded time and caps its shard matrix", () => {
  const changed = ["killeros/codex-fast.ts"];
  const small = ciPlan(changed, planOptions);
  assert.deepEqual(small.shards, [1]);
  assert.deepEqual(small.lifecycles, []);
  assert.equal(small.changedCount, 1);
  const contracts = "test/RepositoryContracts.test.ts";
  const contract = "lockfile matches the exact Pi development pins";
  const timings = {
    [contracts]: { [contract]: 25 },
    "test/runtime-fast.e2e.test.ts": {
      "real Pi /codex-fast controls process-local state, status, and footer": 20,
      "real Pi /codex-fast transforms only eligible payloads and survives reload": 25,
    },
  };
  const large = ciPlan(changed, planOptions, timings);
  assert.deepEqual(large.shards, [1, 2, 3]);
  assert.equal(large.estimatedMaxShardSeconds, 26.5);
  const capped = ciPlan(changed, { ...planOptions, maxShards: 2 }, timings);
  assert.deepEqual(capped.shards, [1, 2]);
  assert.equal(capped.estimatedMaxShardSeconds, 26.5);
  const oversized = ciPlan(changed, planOptions, {
    ...timings,
    [contracts]: { [contract]: 200 },
  });
  assert.deepEqual(oversized.shards, [1, 2, 3]);
  assert.equal(oversized.estimatedMaxShardSeconds, 201.5);
  const withLifecycle = ciPlan(
    ["test/runtime-startup.e2e.test.ts"],
    planOptions,
  );
  assert.deepEqual(withLifecycle.lifecycles, ["Pi startup"]);
  const shards = assignShards(
    selectedUnits(
      withLifecycle.files,
      withLifecycle.lifecycles,
      withLifecycle.lifecycleRepeats,
      planOptions.targetSeconds,
    ),
    withLifecycle.shardCount,
  );
  assert.equal(
    withLifecycle.estimatedMaxShardSeconds,
    Math.max(
      ...shards.map(({ units }) =>
        estimateShardWallSeconds(units, planOptions.concurrency),
      ),
    ),
  );
});

test("CI plan CLI emits only JSON and accepts explicit diff endpoints and overrides", () => {
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [...cli, "--ci-plan", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  assert.deepEqual(
    JSON.parse(run("--diff-base", "HEAD", "--diff-head", "HEAD")),
    ciPlan([], planOptions),
  );
  assert.deepEqual(
    JSON.parse(run("--full")),
    ciPlan([], { ...planOptions, full: true }),
  );
  assert.deepEqual(
    JSON.parse(
      run(
        "--max-shards",
        "1",
        "--concurrency",
        "3",
        "--lifecycle-repeats",
        "0",
        "--target-shard-seconds",
        "15",
        "test/runtime-startup.e2e.test.ts",
      ),
    ),
    ciPlan(["test/runtime-startup.e2e.test.ts"], {
      ...planOptions,
      maxShards: 1,
      concurrency: 3,
      lifecycleRepeats: 0,
      targetSeconds: 15,
    }),
  );
});
