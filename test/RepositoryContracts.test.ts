import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { Session } from "node:inspector";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING } from "../killeros/auto-compaction.ts";
import { lifecycles } from "../scripts/test-suite.ts";
import Killeros from "../Killeros.ts";

type PackageJson = {
  version: string;
  os: string[];
  engines: Record<string, string>;
  scripts: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

type TypeScriptConfig = {
  compilerOptions: { strict: true };
  include: string[];
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isUnknownRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isPackageJson(value: unknown): value is PackageJson {
  return isUnknownRecord(value)
    && typeof value.version === "string"
    && Array.isArray(value.os) && value.os.every((os) => typeof os === "string")
    && isStringRecord(value.engines)
    && isStringRecord(value.scripts)
    && isStringRecord(value.peerDependencies)
    && isStringRecord(value.devDependencies);
}

function isTypeScriptConfig(value: unknown): value is TypeScriptConfig {
  return isUnknownRecord(value)
    && isUnknownRecord(value.compilerOptions)
    && value.compilerOptions.strict === true
    && Array.isArray(value.include)
    && value.include.every((entry) => typeof entry === "string");
}

const packageValue: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tsconfigValue: unknown = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"));
assert.ok(isPackageJson(packageValue));
assert.ok(isTypeScriptConfig(tsconfigValue));
const packageJson = packageValue;
const tsconfig = tsconfigValue;
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));


test("peer ranges require the pinned Pi minimums and reject older and next-major versions", () => {
  assert.deepEqual(Object.keys(packageJson.peerDependencies).sort(), [
    "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
  ]);
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import semver from "semver";
    const { peerDependencies, devDependencies } = JSON.parse(readFileSync("package.json", "utf8"));
    for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
      const key = "@earendil-works/" + name;
      const minimum = devDependencies[key];
      assert.equal(semver.valid(minimum), minimum, key + " must have an exact development pin");
      assert.equal(semver.prerelease(minimum), null, key + " must use a stable release");
      const { major, minor, patch } = semver.parse(minimum);
      const ceiling = major + 1;
      const previous = patch > 0 ? major + "." + minor + "." + (patch - 1)
        : minor > 0 ? major + "." + (minor - 1) + ".999999" : (major - 1) + ".999999.999999";
      const range = peerDependencies[key];
      assert.equal(range, ">=" + minimum + " <" + ceiling, key);
      for (const [version, supported] of [[previous, false], [minimum + "-rc.1", false], [minimum, true], [major + ".999999.999999", true], [ceiling + ".0.0", false]]) {
        assert.equal(semver.satisfies(version, range), supported, key + "@" + version);
      }
    }
    const typeboxMinimum = semver.minVersion(peerDependencies.typebox);
    assert.ok(typeboxMinimum);
    assert.equal(semver.satisfies(devDependencies.typebox, peerDependencies.typebox), true);
    assert.equal(semver.satisfies("2.0.0", peerDependencies.typebox), false);
  `], { cwd: repositoryRoot, stdio: "pipe" });
  const minimum = packageJson.devDependencies["@earendil-works/pi-coding-agent"];
  const ceiling = Number(minimum.split(".")[0]) + 1;
  assert.ok(readme.includes(`Pi ${minimum} or later below ${ceiling}.0.0`));
  assert.match(readme, /Users on older Node or Pi versions must upgrade/u);
});

test("unreleased notes state only the current Pi minimum", () => {
  const unreleased = changelog.split(/^## \[/mu)[1];
  assert.ok(unreleased?.startsWith("Unreleased]"));
  const minimums = [...unreleased.matchAll(/minimum supported Pi version[^\n]*?to (\d+\.\d+\.\d+)/gu)]
    .map((match) => match[1]);
  assert.deepEqual(minimums, minimums.length === 0 ? [] : [packageJson.devDependencies["@earendil-works/pi-coding-agent"]]);
});

test("public TUI guidance preserves Pi defaults and documents regular-mode scrollback", () => {
  assert.match(readme, /Pi defaults to fullscreen/u);
  assert.match(readme, /`--tui-mode regular`/u);
  assert.match(readme, /`"tuiMode": "regular"`/u);
  assert.match(readme, /terminal-owned scrollback/u);
  assert.match(readme, /KillerOS leaves Pi's `tuiMode` and `quietStartup` preferences unchanged/u);
});

test("lockfile matches the exact Pi development pins", () => {
  const lock: unknown = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(isUnknownRecord(lock));
  assert.ok(isUnknownRecord(lock.packages));
  const root = lock.packages[""];
  assert.ok(isUnknownRecord(root));
  assert.deepEqual(root.devDependencies, packageJson.devDependencies);
  assert.deepEqual(root.peerDependencies, packageJson.peerDependencies);
  assert.deepEqual(root.os, packageJson.os);
  for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
    const lockedPackage: unknown = lock.packages[`node_modules/@earendil-works/${name}`];
    assert.ok(isUnknownRecord(lockedPackage));
    assert.equal(lockedPackage.version, packageJson.devDependencies[`@earendil-works/${name}`], name);
  }
});

test("locked brace expansion bounds deeply nested patterns", () => {
  const output = execFileSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { expand } from "brace-expansion";
    import braceExpansion from "brace-expansion/package.json" with { type: "json" };

    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    assert.equal(braceExpansion.version, lock.packages["node_modules/brace-expansion"].version);

    const shallow = expand("{a,b}");
    assert.deepEqual(shallow, ["a", "b"]);

    const deepPattern = "{".repeat(10_000) + "a,b" + "}".repeat(10_000);
    const deep = expand(deepPattern);
    assert.ok(deep.length <= 2);
    assert.ok(deep.every((value) => value.length <= deepPattern.length));
    assert.ok(deep.reduce((length, value) => length + value.length, 0) <= deepPattern.length);
    process.stdout.write("ok");
  `], {
    cwd: repositoryRoot,
    env: {
      PATH: path.dirname(process.execPath),
      SystemRoot: process.env.SystemRoot,
    },
    maxBuffer: 1_024,
    timeout: 5_000,
    stdio: "pipe",
  }).toString();
  assert.equal(output, "ok");
});

test("all shipped TypeScript entry points use strict checking", () => {
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.deepEqual(tsconfig.include, ["Killeros.ts", "scripts/**/*.ts", "test/**/*.ts"]);
});

test("public compaction documentation states the configurable default", () => {
  assert.ok(readme.toLowerCase().includes(`compaction triggers by default at ${DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING}% tokens remaining`));
  assert.match(readme, /"autoCompaction"/u);
  assert.match(readme, /"enabled": true/u);
  assert.ok(readme.includes(`"percentRemaining": ${DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING}`));
});

test("Oxlint configuration ignores private artifacts without excluding repository code", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "killeros-lint-"));
  try {
    copyFileSync(path.join(repositoryRoot, ".oxlintrc.json"), path.join(fixture, ".oxlintrc.json"));
    writeFileSync(path.join(fixture, "clean.ts"), "export {};\n");
    const cases = [
      [".pi/verification/probe.ts", 0],
      ["docs/probe.ts", 0],
      ["Killeros.ts", 1],
      ["killeros/probe.ts", 1],
      ["scripts/probe.ts", 1],
      ["test/probe.ts", 1],
    ] as const;
    for (const [file, expectedStatus] of cases) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(path.join(fixture, file), "debugger;\n");
      const result = spawnSync(process.execPath, [
        path.join(repositoryRoot, "node_modules/oxlint/bin/oxlint"),
        "--deny", "no-debugger", "clean.ts", file,
      ], { cwd: fixture, encoding: "utf8", timeout: 10_000 });
      assert.ifError(result.error);
      assert.equal(result.status, expectedStatus, `${file}: ${result.stdout}${result.stderr}`);
      if (expectedStatus === 1) assert.match(result.stdout + result.stderr, /no-debugger/u);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("CI blocks moderate dependency advisories without running lifecycle scripts", () => {
  assert.match(ci, /npm audit --audit-level=moderate --package-lock-only --ignore-scripts --no-fund/u);
  assert.match(ci, /npm ci --ignore-scripts/u);
  const checks = ciJob("quality-checks");
  assert.ok(checks.indexOf("npm audit --audit-level=moderate") < checks.indexOf("run: npm ci --ignore-scripts"));
  const linuxJobs = new Set(["tested-tree", "quality", "codeql"]);
  for (const workflow of [ci, release]) {
    const jobs = [...workflow.slice(workflow.search(/^jobs:\s*$/mu)).matchAll(/^  ([\w-]+):\r?\n(?:(?: {4,}.*)?\r?\n)*/gmu)];
    assert.ok(jobs.length > 0);
    for (const [source, job] of jobs) {
      const runner = /^    runs-on: (.+)$/mu.exec(source)?.[1];
      const expected = workflow === ci && linuxJobs.has(job) ? "ubuntu-latest" : "windows-latest";
      assert.equal(runner, expected, `${job} must run on ${expected}`);
    }
    assert.match(workflow, /defaults:\s+run:\s+shell: bash/u);
  }
  assert.doesNotMatch(ci, /uses: [^\s]+@(?![a-f0-9]{40}(?:\s|$))/u);
});

/** Returns one top-level job's YAML from the CI workflow. */
function ciJob(name: string): string {
  const jobs = ci.slice(ci.search(/^jobs:\s*$/mu));
  const source = new RegExp(`^  ${name}:\\r?\\n(?:(?: {4,}.*)?\\r?\\n)*`, "mu").exec(jobs)?.[0];
  assert.ok(source, `CI must define ${name}`);
  return source;
}

test("CI and releases use the pinned Node.js version with one aggregated quality check", () => {
  const nodeVersion = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
  assert.equal(nodeVersion, "26.13.0");
  assert.equal(packageJson.engines.node, `>=${nodeVersion} <27`);
  for (const workflow of [ci, release]) {
    const versions = [...workflow.matchAll(/^          node-version: (.+)$/gmu)].map((match) => match[1]);
    assert.ok(versions.length > 0);
    assert.ok(versions.every((version) => version === `'${nodeVersion}'`));
  }
  const jobsStart = ci.search(/^jobs:\s*$/mu);
  assert.notEqual(jobsStart, -1);
  assert.deepEqual([...ci.slice(jobsStart).matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]),
    ["tested-tree", "quality-checks", "quality-tests", "pi-latest", "pi-latest-tests", "quality", "codeql"]);

  const quality = ciJob("quality");
  assert.match(quality, /^    name: Quality$/mu);
  assert.match(quality, /^    needs: \[tested-tree, quality-checks, quality-tests, pi-latest, pi-latest-tests\]$/mu);
  assert.match(quality, /^    if: always\(\)$/mu);
  const checks = ciJob("quality-checks");
  assert.match(checks, /^    name: Quality checks$/mu);
  assert.doesNotMatch(checks, /strategy:|matrix\./u);
  assert.match(checks, /^        run: npm ci --ignore-scripts --no-audit --no-fund$/mu);
  assert.match(checks, /^        run: npm run check$/mu);

  const shardCommands = (["quality-tests", "pi-latest-tests"] as const).map((job) => {
    const source = ciJob(job);
    const shards = /^        shard: \[([\d, ]+)\]$/mu.exec(source)?.[1].split(", ").map(Number);
    assert.ok(shards, `${job} must list its shards`);
    assert.deepEqual(shards, shards.map((_, index) => index + 1));
    assert.match(source, /^      fail-fast: false$/mu);
    assert.match(source, new RegExp(`^    name: .+ \\(\\$\\{\\{ matrix\\.shard \\}\\}/${shards.length}\\)$`, "mu"));
    assert.match(source, /^        run: npm ci --ignore-scripts --no-audit --no-fund$/mu);
    const matrixShard = ["$", "{{ matrix.shard }}"].join("");
    const command = `node --experimental-strip-types scripts/test-suite.ts --shard ${matrixShard}/${shards.length} --concurrency 2 --lifecycle-repeats 2`;
    assert.ok(source.split(/\r?\n/u).includes(`        run: ${command}`), `${job} must run: ${command}`);
    assert.doesNotMatch(source, /--test-force-exit/u, `${job}: lifecycle flags belong to scripts/test-suite.ts`);
    return command;
  });
  assert.equal(shardCommands[0], shardCommands[1], "Quality and pi-latest-tests must run the same shards and lifecycle repeats");
  const shardCommand = shardCommands[0];
  assert.equal(packageJson.scripts.test, "node --experimental-strip-types scripts/test-suite.ts");
  assert.match(ciJob("quality-tests"), /name: test-failures-quality-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.run_attempt \}\}/u);
  assert.match(ciJob("pi-latest-tests"), /name: test-failures-pi-latest-\$\{\{ matrix\.shard \}\}-\$\{\{ github\.run_attempt \}\}/u);

  for (const [job, suite] of [
    ["quality-checks", "--test-name-pattern=\"publication lifecycle\""], ["quality-tests", shardCommand], ["pi-latest-tests", shardCommand],
  ] as const) {
    const source = ciJob(job);
    assert.match(source, /^    runs-on: windows-latest$/mu);
    assert.match(source, /- name: Upload test failure reports\s+if: failure\(\)\s+uses: actions\/upload-artifact@[a-f0-9]{40}/u);
    assert.match(source, /^          path: node_modules\/\.killeros-\*\/failure\.txt$/mu);
    assert.match(source, /^          include-hidden-files: true$/mu);
    assert.match(source, /^          retention-days: 7$/mu);
    assert.ok(source.indexOf("Upload test failure reports") > source.indexOf(suite));
  }
});

test("a push to main checks for recorded PR coverage before allocating Windows runners", () => {
  const action = readFileSync(new URL("../.github/actions/tested-tree/action.yml", import.meta.url), "utf8");
  assert.match(action, /git rev-parse --verify 'HEAD\^\{tree\}'/u);
  assert.match(action, /git rev-parse --verify -q HEAD\^2/u);
  assert.match(action, /\.merged_at != null and \.merge_commit_sha == \\"\$GITHUB_SHA\\" and \.base\.ref == \\"main\\" and \.head\.repo\.full_name == \.base\.repo\.full_name and \.head\.sha == \\"\$head\\"/u);
  assert.match(action, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$head&event=pull_request&status=success/u);
  assert.match(action, /select\(\.head_repository\.full_name == \\"\$GITHUB_REPOSITORY\\"\) \| \[\.id, \.run_attempt\]/u);
  assert.match(action, /name="tested-tree-\$pr-\$attempt-\$tree"/u);
  assert.match(action, /\.name == \\"\$name\\" and \.expired == false/u);
  assert.match(action, /^        skip=false$/mu);
  assert.match(ci, /^permissions:\r?\n  actions: read\r?\n  contents: read\r?\n  pull-requests: read\r?$/mu);

  const lookup = ciJob("tested-tree");
  assert.match(lookup, /^    if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/mu);
  assert.match(lookup, /^          fetch-depth: 2$/mu);
  assert.match(lookup, /if: steps\.checkout\.outcome == 'success'\s+continue-on-error: true\s+uses: \.\/\.github\/actions\/tested-tree/u);

  const checks = ciJob("quality-checks");
  assert.match(checks, /Record the checked-out PR tree\s+id: tree\s+if: github\.event_name == 'pull_request' && github\.base_ref == 'main' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u);
  assert.match(checks, /git rev-parse --verify 'HEAD\^\{tree\}'/u);
  assert.match(checks, /name: tested-tree-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ steps\.tree\.outputs\.sha \}\}/u);
  for (const job of ["quality-checks", "quality-tests", "pi-latest"]) {
    const source = ciJob(job);
    assert.match(source, /^    needs: tested-tree$/mu, job);
    assert.match(source, /^    if: "!cancelled\(\) && \(needs\.tested-tree\.result != 'success' \|\| needs\.tested-tree\.outputs\.skip != 'true'\)"$/mu, job);
    assert.doesNotMatch(source, /uses: \.\/\.github\/actions\/tested-tree/u, job);
  }
  assert.doesNotMatch(ciJob("codeql"), /tested-tree|steps\.tested/u);
});

test("CI checks the newest peer-range Pi with matched runtime packages and a stable required-check name", () => {
  const triggers = ci.split(/^(?=[\w-]+:)/mu).find((section) => section.startsWith("on:"));
  assert.ok(triggers);
  assert.match(triggers, /push:\s*\n\s*branches:\s*\n\s*- main\s*\n  pull_request:/u);
  assert.match(triggers, /pull_request:\s*\n\s*types:\s*\n\s*- opened\s*\n\s*- synchronize\s*\n\s*- reopened\s*\n\s*- ready_for_review\s*\n  schedule:/u);
  assert.match(triggers, /cron: '17 3 \* \* 1'/u);
  assert.match(triggers, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(ci, /pull_request_target|paths-ignore:|paths:|github\.event\.pull_request\.draft/u);
  assert.match(readme, /Automatic pre-merge CI requires a pull request, including a draft pull request/u);
  assert.match(readme, /run the CI workflow manually/u);
  assert.match(readme, /Standalone pushes to `dev` do not start automatic CI/u);
  const compatibilityJob = ciJob("pi-latest");
  assert.match(compatibilityJob, /^    name: Pi compatibility \(latest\)$/mu);
  assert.match(compatibilityJob, /^        id: pi$/mu);
  assert.match(compatibilityJob, /"full-suite=" \+ fullSuite/u);
  assert.match(compatibilityJob, /packages=" \+ packages/u);
  assert.match(compatibilityJob, /^      full-suite: \$\{\{ steps\.pi\.outputs\.full-suite \}\}$/mu);
  assert.match(compatibilityJob, /^      packages: \$\{\{ steps\.pi\.outputs\.packages \}\}$/mu);
  assert.match(compatibilityJob, /package-lock\.json/u);
  assert.doesNotMatch(compatibilityJob, /strategy:|matrix\.|scripts\/test-suite\.ts|node --test/u, "pi-latest only resolves and type-checks");
  const compatibilityTests = ciJob("pi-latest-tests");
  assert.match(compatibilityTests, /^    needs: pi-latest$/mu);
  assert.match(compatibilityTests, /^    if: "!cancelled\(\) && needs\.pi-latest\.result == 'success' && needs\.pi-latest\.outputs\.full-suite == 'true'"$/mu);
  assert.match(compatibilityTests, /^          PI_PACKAGES: \$\{\{ needs\.pi-latest\.outputs\.packages \}\}$/mu);
  assert.match(compatibilityTests, /test "\$\{#packages\[@\]\}" -eq 4/u);
  assert.match(compatibilityTests, /npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false "\$\{packages\[@\]\}"/u);
  assert.match(compatibilityTests, /git diff --exit-code -- package\.json package-lock\.json/u);
  assert.ok(compatibilityTests.indexOf("Verify package files are unchanged") > compatibilityTests.indexOf("Install matched Pi packages"));
  assert.ok(compatibilityTests.indexOf("Test shard against matched Pi") > compatibilityTests.indexOf("Verify package files are unchanged"));
  const gate = ciJob("quality");
  assert.match(gate, /^          REUSE: \$\{\{ needs\.tested-tree\.result == 'success' && needs\.tested-tree\.outputs\.skip == 'true' \}\}$/mu);
  assert.match(gate, /^          CHECKS: \$\{\{ needs\.quality-checks\.result \}\}$/mu);
  assert.match(gate, /^          TESTS: \$\{\{ needs\.quality-tests\.result \}\}$/mu);
  assert.match(gate, /^          FULL_SUITE: \$\{\{ needs\.pi-latest\.outputs\.full-suite \}\}$/mu);
  assert.match(gate, /^          LATEST: \$\{\{ needs\.pi-latest\.result \}\}$/mu);
  assert.match(gate, /^          SHARDS: \$\{\{ needs\.pi-latest-tests\.result \}\}$/mu);
  for (const result of ["CHECKS", "TESTS", "LATEST"]) {
    assert.ok(gate.includes(`test "$${result}" = success`));
    assert.ok(gate.includes(`test "$${result}" = skipped`));
  }
  assert.match(gate, /true\) test "\$SHARDS" = success/u);
  assert.match(gate, /false\) test "\$SHARDS" = skipped/u);
  const target = /^          PI_TARGET: '([^']+)'$/mu.exec(compatibilityJob)?.[1];
  assert.equal(target, packageJson.peerDependencies["@earendil-works/pi-coding-agent"]);
  assert.match(compatibilityJob, /npm view "@earendil-works\/pi-coding-agent@\$PI_TARGET" version dependencies --json/u);
  assert.equal((compatibilityJob.match(/npm view /gu) ?? []).length, 1, "Resolve the Pi version and dependency ranges together");
  assert.match(compatibilityJob, /npm ci --ignore-scripts --no-audit --no-fund/u);
  assert.match(compatibilityJob, /^        run: npm run check$/mu);
  assert.match(compatibilityJob, /git diff --exit-code -- package\.json package-lock\.json/u);
  assert.doesNotMatch(compatibilityJob, /--save|@latest/u);
  assert.match(compatibilityJob, /"@earendil-works\/pi-coding-agent": latest\?\.version/u);
  assert.match(compatibilityJob, /"@earendil-works\/pi-ai": latest\?\.dependencies\?\.\["@earendil-works\/pi-ai"\]/u);
  assert.match(compatibilityJob, /"@earendil-works\/pi-tui": latest\?\.dependencies\?\.\["@earendil-works\/pi-tui"\]/u);
  assert.match(compatibilityJob, /"typebox": latest\?\.dependencies\?\.typebox/u);
  assert.match(compatibilityJob, /npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false "\$\{packages\[@\]\}"/u);
  const cancellation = lifecycles.find((lifecycle) => lifecycle.name === "Pi cancellation");
  assert.ok(cancellation);
  for (const [file, title] of [
    ["Goals.e2e.test.ts", "continuation dispatch respects idle, pending, and cancellation gates"],
    ["runtime-native-provider.e2e.test.ts", "active faux provider retries preserve goal ownership until settlement"],
    ["CompactionTrigger.e2e.test.ts", "Cancelled ordinary and goal compaction cannot recover after an aborted settlement"],
  ] as const) {
    assert.ok(cancellation.pattern.split("|").includes(title), `CI must select ${title}`);
    assert.ok(cancellation.files.includes(`test/${file}`));
    assert.ok(readFileSync(new URL(`./${file}`, import.meta.url), "utf8").includes(`test("${title}"`),
      "CI must select retained native cancellation scenarios");
  }
});

test("quality checks validate current metadata and test the release-pinned npm lifecycle", () => {
  const qualityJob = ciJob("quality-checks");
  assert.match(qualityJob, /- name: Validate release metadata\s+env:\s+KILLEROS_RELEASE: 'true'\s+run: node --experimental-strip-types scripts\/verify-release\.ts/u);
  assert.equal((qualityJob.match(/KILLEROS_RELEASE:/gu) ?? []).length, 1);
  assert.doesNotMatch(ci.split("jobs:")[0], /KILLEROS_RELEASE/u);
  assert.doesNotMatch(qualityJob.split("steps:")[0], /KILLEROS_RELEASE/u);
  const publishingNpm = /npm install --global npm@(\d+\.\d+\.\d+)/u.exec(release)?.[1];
  assert.ok(publishingNpm);
  assert.match(release, /npm prefix --global >> "\$GITHUB_PATH"/u);
  assert.ok(qualityJob.includes(`npm@${publishingNpm}`));
  assert.match(qualityJob, /- name: Provision publishing npm\s+run: npm install/u);
  assert.match(qualityJob, /npm install --prefix "\$RUNNER_TEMP\/killeros-publishing-npm" --ignore-scripts --no-audit --no-fund --no-package-lock --no-save npm@/u);
  assert.match(qualityJob, /- name: Test publication lifecycle with publishing npm\s+env:\s+KILLEROS_TEST_NPM_CLI: \$\{\{ runner\.temp \}\}\/killeros-publishing-npm\/node_modules\/npm\/bin\/npm-cli\.js\s+run: node --test --test-force-exit --experimental-strip-types --test-name-pattern="publication lifecycle" test\/verify-release\.test\.ts/u);
  assert.doesNotMatch(qualityJob, /npm install --global/u);
  const lifecycleTests = readFileSync(new URL("./verify-release.test.ts", import.meta.url), "utf8");
  assert.match(lifecycleTests, /test\("publication lifecycle /u, "The pinned-npm entry point must select a retained test");
});

function assertPublicationBoundary(workflow: string): void {
  const publishStep = /      - name: Publish package to npm\r?\n[\s\S]*?(?=\r?\n      - name:)/u.exec(workflow)?.[0];
  assert.ok(publishStep);
  assert.match(publishStep, /if: steps\.metadata\.outputs\.publish_npm == 'true'/u);
  assert.match(publishStep, /env:\s+KILLEROS_RELEASE: 'true'/u);
  assert.match(publishStep, /run: npm publish \. --ignore-scripts=false\s*$/u);
  assert.doesNotMatch(publishStep, /scripts\/verify-release\.ts/u);
}

test("publication boundary requires directory publication with lifecycle scripts explicitly enabled", () => {
  assertPublicationBoundary(release);
  for (const command of ["npm publish", "npm publish .", "npm publish killeros.tgz --ignore-scripts=false", "npm publish . --ignore-scripts=true"]) {
    const invalid = release.replace("npm publish . --ignore-scripts=false", command);
    assert.throws(() => assertPublicationBoundary(invalid), command);
  }
});

test("GitHub releases require green current main and consistent package provenance", () => {
  assert.match(release, /workflow_run:/u);
  assert.match(release, /workflows:\s*\n\s*- CI/u);
  assert.match(release, /if: github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(release, /branches:\s*\n\s*- main/u);
  assert.match(release, /github\.event\.workflow_run\.head_sha/u);
  assert.match(release, /git fetch --no-tags origin main/u);
  assert.match(release, /CURRENT_MAIN=.*origin\/main/u);
  assert.match(release, /Verified commit .* is stale/u);
  assert.match(release, /PREVIOUS_VERSION.*VERSION/su);
  assert.match(release, /packageJson\.version !== packageLock\.version/u);
  assert.match(release, /scripts\/release-notes\.ts CHANGELOG\.md/u);
  assert.match(release, /> "\$RUNNER_TEMP\/killeros-release-notes\.md"/u);
  assert.match(release, /--notes-file "\$RUNNER_TEMP\/killeros-release-notes\.md"/u);
  assert.match(release, /Existing tag.*verified commit/u);
  assert.match(release, /git ls-remote[^\n]+\|\| TAG_LOOKUP_STATUS=\$\?/u);
  assert.match(release, /TAG_LOOKUP_STATUS != 2[\s\S]+exit "\$TAG_LOOKUP_STATUS"/u);
  assert.doesNotMatch(release, /push:\s*\n\s*tags:/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" version/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" gitHead/u);
  assert.match(release, /npm package.*verified commit/u);
  assert.match(release, /publish_npm/u);
  assert.equal(packageJson.scripts.prepublishOnly, "node --experimental-strip-types scripts/verify-release.ts");
  assert.match(release, /KILLEROS_RELEASE: 'true'/u);
  assertPublicationBoundary(release);
  assert.ok(release.indexOf("Existing tag") < release.indexOf("- name: Publish package to npm"));
  assert.match(release, /sync-dev:\s+name: Sync main back into dev\s+needs: release/su);
  assert.match(release, /publish:\s+\$\{\{ steps\.metadata\.outputs\.publish \}\}/u);
  assert.match(release, /if: needs\.release\.result == 'success' && needs\.release\.outputs\.publish == 'true'/u);
  assert.match(release, /MAIN_SHA:.*workflow_run\.head_sha/u);
  assert.match(release, /git merge-base --is-ancestor "\$MAIN_SHA" HEAD/u);
  assert.match(release, /git merge --ff-only "\$MAIN_SHA"/u);
  assert.match(release, /refs\/heads\/dev/u);
  assert.match(readme, /Releases go through CI on `main`/u);
  assert.match(readme, /do not push version tags manually/iu);
});

test("public README documents current requirements and commands", () => {
  assert.deepEqual(packageJson.os, ["win32"]);
  assert.match(readme, /KillerOS supports Windows only/u);
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(readme, new RegExp(`@v${escapedVersion}`, "u"));
  const nodeVersion = readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim();
  assert.ok(readme.includes(`Node.js ${nodeVersion} or later within Node 26`));
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /^\/goal edit/mu);
  assert.match(readme, /^\/goal pause/mu);
  assert.match(readme, /^\/goal resume/mu);
  assert.match(readme, /^\/goal clear/mu);
  for (const command of ["codex-fast", "notification", "handoff", "new", "exit"] as const) {
    assert.match(readme, new RegExp(`^/${command}(?:\\s|$)`, "mu"));
  }
  assert.match(readme, /^\/handoff \[focus\]/mu);
  assert.match(readme, /off by default/iu);
  assert.match(readme, /Nerd Font/iu);
  assert.match(readme, /settled.*token usage/iu);
  assert.match(readme, /question.*single-select and multi-select/iu);
});

test("public guidance uses Pi's native sampling and project MCP settings", () => {
  assert.match(readme, /samplingParamsByThinkingLevel/u);
  assert.match(readme, /\/thinking/u);
  assert.match(readme, /models\.md#configure-sampling-by-thinking-level/u);
  assert.match(readme, /\.pi\/mcp\.json/u);
  assert.match(readme, /mcp\.md#configure-servers/u);
  assert.match(readme, /trusted project/iu);
});

test("public guidance documents native wildcard filtering, image reads, and MCP selection", () => {
  assert.match(readme, /Pi's native `--tools` and `--exclude-tools` support `\*` patterns/u);
  assert.match(readme, /Quote patterns .*shell does not expand them/u);
  assert.match(readme, /allowlist must include `question`.*permit `killeros_goal_update`/u);
  assert.match(readme, /Excluding the goal tool pauses goals/u);
  assert.match(readme, /cli\.md#tools/u);
  assert.match(readme, /Pi codemode.*`tools\.read\(\)`.*image block.*`image\(\)`/u);
  assert.match(readme, /nonempty `--tools` list with no `mcp__` entry preserves MCP tool availability/u);
  assert.match(readme, /`--tools codemode` does not disable MCP connections/u);
  assert.match(readme, /Use `--no-mcp` to disable MCP connections/u);
  assert.match(readme, /mcp\.md#control-tool-exposure/u);
});

test("agent_settled handlers run receipt, goal settlement, activity, sound, then project hooks", () => {
  const handlers: unknown[] = [];
  const host: unknown = new Proxy(() => undefined, {
    get: (_target, key) => key === "on"
      ? (event: string, handler: unknown) => { if (event === "agent_settled") handlers.push(handler); }
      : host,
    apply: () => host,
  });
  Killeros(host as ExtensionAPI);

  const session = new Session();
  const scripts = new Map<string, string>();
  session.on("Debugger.scriptParsed", ({ params }) => scripts.set(params.scriptId, params.url));
  session.connect();
  const probe = Symbol.for("killeros.settled-handler");
  try {
    session.post("Debugger.enable");
    // Inspector calls on the main-thread session complete synchronously. A bound function has no location
    // of its own, so follow it to the function it wraps.
    const definingModule = (objectId: string): string | undefined => {
      let module: string | undefined;
      session.post("Runtime.getProperties", { objectId }, (error, properties) => {
        assert.ifError(error);
        const internal = (name: string) => properties.internalProperties?.find((property) => property.name === name)?.value;
        const location: unknown = internal("[[FunctionLocation]]")?.value;
        const target = internal("[[TargetFunction]]")?.objectId;
        if (isUnknownRecord(location) && typeof location.scriptId === "string") {
          const url = scripts.get(location.scriptId);
          if (url) module = path.basename(fileURLToPath(url), ".ts");
        } else if (target) module = definingModule(target);
      });
      return module;
    };
    const defining = handlers.map((handler) => {
      Reflect.set(globalThis, probe, handler);
      let module: string | undefined;
      session.post("Runtime.evaluate", { expression: `globalThis[Symbol.for("killeros.settled-handler")]` }, (error, value) => {
        assert.ifError(error);
        module = definingModule(value.result.objectId ?? "");
      });
      assert.ok(module, "The inspector must locate every handler");
      return module;
    });
    const order = ["worked-for", "goal-settlement", "activity", "notifications", "hooks"];
    assert.deepEqual(defining.filter((module) => order.includes(module)), order,
      "A slow project hook must not delay the receipt or sound, and its file edits must stay out of the agent's receipt");
  } finally {
    Reflect.deleteProperty(globalThis, probe);
    session.disconnect();
  }
});
