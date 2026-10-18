import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ESLint } from "eslint";

type PackageJson = {
  version: string;
  os: string[];
  scripts: Record<string, string>;
  dependencies?: Record<string, unknown>;
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
    && isStringRecord(value.scripts)
    && (value.dependencies === undefined || isUnknownRecord(value.dependencies))
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
const main = readFileSync(new URL("../Killeros.ts", import.meta.url), "utf8");
const goalModules = ["goal-interface.ts", "goal-runtime.ts", "goal-settlement.ts"]
  .map((file) => readFileSync(new URL(`../killeros/${file}`, import.meta.url), "utf8"))
  .join("\n");
const question = readFileSync(new URL("../killeros/question.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const privateRootFiles = new Set<string>(["AGENTS.md", "CONTEXT.md", "PRODUCT.md", "DESIGN.md"]);

function repositoryFiles(directory: string = repositoryRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === ".git" || entry === "node_modules") continue;
    if (directory === repositoryRoot && privateRootFiles.has(entry)) continue;
    const entryPath = path.join(directory, entry);
    if (statSync(entryPath).isDirectory()) files.push(...repositoryFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function repositoryContractFiles(): string[] {
  return execFileSync(
    "git",
    ["-C", repositoryRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((file) => path.join(repositoryRoot, file))
    .filter(existsSync);
}

test("repository contract scan includes untracked non-ignored files", () => {
  const probePath = path.join(repositoryRoot, `.killeros-contract-probe-${process.pid}.txt`);
  writeFileSync(probePath, "contract probe", { flag: "wx" });
  try {
    assert.ok(repositoryContractFiles().includes(probePath));
  } finally {
    unlinkSync(probePath);
  }
});

test("repository contains no retired feature references", () => {
  const retiredTerms = [
    "sub" + "agent",
    "sub" + "-agent",
    "sub" + " agent",
    "child" + " agent",
    "child" + " thread",
  ];
  const matches = repositoryContractFiles().filter((file: string) => {
    const content = readFileSync(file, "utf8").toLowerCase();
    return retiredTerms.some((term) => content.includes(term));
  });
  assert.deepEqual(matches, []);
});

test("skill-specific workflow gating is no longer part of KillerOS", () => {
  assert.equal(existsSync(path.join(repositoryRoot, "killeros", "workflow-gate.ts")), false);
  assert.equal(existsSync(path.join(repositoryRoot, "killeros", "decision-gated-workflow.ts")), false);
  assert.equal(packageJson.dependencies?.yaml, undefined);
  assert.doesNotMatch(main, /WorkflowGate|decisionGatedWorkflows|question-first/iu);
  assert.doesNotMatch(readme, /decision-gated workflow|killeros\.workflow|With docs/iu);
});

test("real Pi fixtures use bounded cleanup for transient Windows directory locks", () => {
  const contracts = readFileSync(new URL("./PiExtensionContract.test.ts", import.meta.url), "utf8");
  assert.doesNotMatch(contracts, /\brmSync\(/u);
  assert.match(contracts, /removeDirectoryEventually/u);
});

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
  assert.match(readme, /Users on older Pi versions must upgrade/u);
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

test("lockfile matches the exact Pi development pins without retired experimental packages", () => {
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
  for (const name of ["pi-server", "pi-client", "pi-protocol"]) {
    assert.equal(packageJson.devDependencies[`@earendil-works/${name}`], undefined, name);
    assert.equal(lock.packages[`node_modules/@earendil-works/${name}`], undefined, name);
  }
});

test("locked brace expansion bounds deeply nested patterns", () => {
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { expand } from "brace-expansion";
    assert.doesNotThrow(() => expand("{".repeat(10_000) + "a,b" + "}".repeat(10_000)));
  `], { cwd: repositoryRoot, timeout: 5_000, stdio: "pipe" });
});

test("goal state and question UI stay separate from host wiring", () => {
  assert.match(goalModules, /from "\.\/goal-state\.ts"/u);
  assert.doesNotMatch(goalModules, /function parseGoalState|readFileSync|readSync|openSync/u);
  assert.match(question, /from "\.\/question-ui\.ts"/u);
  assert.doesNotMatch(question, /\bEditor\b|ctx\.ui\.custom|handleInput/u);
});

test("machine identifiers use locale-independent casing", () => {
  const source = repositoryFiles(path.join(repositoryRoot, "killeros"))
    .filter((file: string) => file.endsWith(".ts"))
    .map((file: string) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /\.toLocale(?:Lower|Upper)Case\(/u);
});

test("all shipped TypeScript entry points use strict checking", () => {
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.deepEqual(tsconfig.include, ["Killeros.ts", "scripts/**/*.ts", "test/**/*.ts"]);
});

test("public compaction documentation states the configurable default", () => {
  assert.match(readme, /compaction triggers by default at 15% tokens remaining/iu);
  assert.match(readme, /"autoCompaction"/u);
  assert.match(readme, /"enabled": true/u);
  assert.match(readme, /"percentRemaining": 15/u);
  assert.doesNotMatch(readme, /40% remaining|deterministic fallback/iu);
});

test("lint ignores private Pi artifacts and docs without excluding repository code", async () => {
  const eslint = new ESLint({ cwd: repositoryRoot });
  assert.equal(await eslint.isPathIgnored(".pi/verification/release-prompt.test.mjs"), true);
  assert.equal(await eslint.isPathIgnored("docs/killeros-launch/film.mjs"), true);
  for (const file of ["Killeros.ts", "killeros/hooks.ts", "scripts/verify-release.ts", "test/RepositoryContracts.test.ts"]) {
    assert.equal(await eslint.isPathIgnored(file), false, file);
  }
});

test("CI blocks moderate dependency advisories without running lifecycle scripts", () => {
  assert.match(ci, /npm audit --audit-level=moderate --package-lock-only --ignore-scripts --no-fund/u);
  assert.match(ci, /fail-on-severity: moderate/u);
  assert.match(ci, /npm ci --ignore-scripts/u);
  for (const workflow of [ci, release]) {
    const runners = [...workflow.matchAll(/^    runs-on: (.+)$/gmu)].map((match) => match[1]);
    assert.ok(runners.length > 0);
    assert.ok(runners.every((runner) => runner === "windows-latest"), "All workflow jobs must run on Windows");
    assert.match(workflow, /defaults:\s+run:\s+shell: bash/u);
  }
  assert.doesNotMatch(ci, /uses: [^\s]+@(?![a-f0-9]{40}(?:\s|$))/u);
});

test("CI runs the full quality suite on Windows at the Node.js floor and current LTS", () => {
  const jobsStart = ci.search(/^jobs:\s*$/mu);
  assert.notEqual(jobsStart, -1);
  const jobs = ci.slice(jobsStart);
  assert.deepEqual([...jobs.matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]),
    ["quality", "pi-latest", "package", "audit", "dependency-review", "codeql"]);
  const qualityJob = /^  quality:\r?\n(?:(?: {4,}.*)?\r?\n)*/mu.exec(jobs)?.[0];
  assert.ok(qualityJob);
  assert.match(qualityJob, /^    name: Quality \(Node \$\{\{ matrix\.node-version \}\}\)$/mu);
  assert.match(qualityJob, /^    timeout-minutes: 15$/mu);
  assert.match(qualityJob, /node-version:\s*\n\s*- '22\.19\.0'\s*\n\s*- 'lts\/\*'/u);
  assert.match(qualityJob, /^          node-version: \$\{\{ matrix\.node-version \}\}$/mu);
  assert.match(qualityJob, /name: test-failures-quality-\$\{\{ strategy\.job-index \}\}-/u);
  assert.match(qualityJob, /^        run: npm ci --ignore-scripts --no-audit --no-fund$/mu);
  assert.match(qualityJob, /^        run: npm run check$/mu);
  assert.match(qualityJob, /^        run: npm test$/mu);
  for (const job of ["quality", "pi-latest"]) {
    const source = new RegExp(`^  ${job}:\\r?\\n(?:(?: {4,}.*)?\\r?\\n)*`, "mu").exec(ci)?.[0];
    assert.ok(source);
    assert.match(source, /^    runs-on: windows-latest$/mu);
    assert.match(source, /- name: Upload test failure reports\s+if: failure\(\)\s+uses: actions\/upload-artifact@[a-f0-9]{40}/u);
    assert.match(source, /^          path: node_modules\/\.killeros-\*\/failure\.txt$/mu);
    assert.match(source, /^          include-hidden-files: true$/mu);
    assert.match(source, /^          retention-days: 7$/mu);
    assert.ok(source.indexOf("Upload test failure reports") > source.indexOf("run: npm test"));
    assert.match(source, /- name: Repeat Pi startup lifecycle without forced exit/u);
    assert.match(source, /node --test --experimental-strip-types test\/PiStartup\.test\.ts \|\| exit \$\?/u);
    for (const step of [
      "Repeat Pi startup lifecycle without forced exit",
      "Repeat installed CLI pilot without forced exit",
      "Test terminal pilot and fault controls without forced exit",
    ]) {
      const start = source.indexOf(`      - name: ${step}`);
      assert.notEqual(start, -1);
      const end = source.indexOf("      - name:", start + 1);
      const lifecycle = source.slice(start, end === -1 ? undefined : end);
      assert.match(lifecycle, /for attempt in 1 2 3 4 5; do/u);
      assert.match(lifecycle, /node --test --experimental-strip-types .* \|\| exit \$\?/u);
      assert.doesNotMatch(lifecycle, /--test-force-exit/u);
    }
  }
});

test("CI checks minimum and latest Pi with matched runtime packages and stable required-check names", () => {
  const triggers = ci.slice(ci.indexOf("\non:"), ci.indexOf("\n# Keep the default token"));
  assert.match(triggers, /push:\s*\n\s*branches:\s*\n\s*- main\s*\n  pull_request:/u);
  assert.match(triggers, /pull_request:\s*\n\s*types:\s*\n\s*- opened\s*\n\s*- synchronize\s*\n\s*- reopened\s*\n\s*- ready_for_review\s*\n  schedule:/u);
  assert.match(triggers, /cron: '17 3 \* \* 1'/u);
  assert.match(triggers, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(ci, /pull_request_target|paths-ignore:|paths:|github\.event\.pull_request\.draft/u);
  assert.match(readme, /Automatic pre-merge CI requires a pull request, including a draft pull request/u);
  assert.match(readme, /run the CI workflow manually/u);
  assert.match(readme, /Standalone pushes to `dev` do not start automatic CI/u);
  const jobsStart = ci.search(/^jobs:\s*$/mu);
  const compatibilityJob = /^  pi-latest:\r?\n(?:(?: {4,}.*)?\r?\n)*/mu.exec(ci.slice(jobsStart))?.[0];
  assert.ok(compatibilityJob);
  assert.match(compatibilityJob, /^    name: Pi compatibility \(\$\{\{ matrix\.pi-channel \}\}\)$/mu);
  const targets = [...compatibilityJob.matchAll(/- pi-channel: (minimum|latest)\s*\n\s*pi-target: '([^']+)'/gu)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(targets, [
    ["minimum", packageJson.devDependencies["@earendil-works/pi-coding-agent"]],
    ["latest", packageJson.peerDependencies["@earendil-works/pi-coding-agent"]],
  ]);
  assert.match(compatibilityJob, /PI_TARGET: \$\{\{ matrix\.pi-target \}\}/u);
  assert.match(compatibilityJob, /npm view "@earendil-works\/pi-coding-agent@\$PI_TARGET" version/u);
  assert.match(compatibilityJob, /npm ci --ignore-scripts --no-audit --no-fund/u);
  assert.match(compatibilityJob, /^        run: npm run check$/mu);
  assert.match(compatibilityJob, /^        run: npm test$/mu);
  assert.match(compatibilityJob, /git diff --exit-code -- package\.json package-lock\.json/u);
  assert.doesNotMatch(compatibilityJob, /--save|@latest/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-ai/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-tui/u);
  assert.match(ci, /dependencies\.typebox/u);
  assert.match(ci, /typebox@\$PI_TYPEBOX_RANGE/u);
  assert.match(ci, /test -n "\$PI_AI_RANGE" && test -n "\$PI_TUI_RANGE" && test -n "\$PI_TYPEBOX_RANGE"/u);
  assert.match(ci, /@earendil-works\/pi-ai@\$PI_AI_RANGE/u);
  assert.match(ci, /@earendil-works\/pi-coding-agent@\$PI_VERSION/u);
  assert.doesNotMatch(ci, /@earendil-works\/pi-(?:server|client|protocol)/u);
  assert.match(ci, /@earendil-works\/pi-tui@\$PI_TUI_RANGE/u);
  assert.match(ci, /--package-lock=false/u);
  const cancellation = /--test-name-pattern="([^"]*user cancellation[^"]*)"/u.exec(compatibilityJob)?.[1];
  assert.ok(cancellation);
  const contracts = readFileSync(new URL("./PiExtensionContract.test.ts", import.meta.url), "utf8");
  assert.ok(contracts.includes(`test("${cancellation}"`), "CI must select the retained cancellation scenario");
});

test("Node-floor quality validates current metadata and tests the release-pinned npm lifecycle before the full suite", () => {
  const qualityJob = /^  quality:\r?\n(?:(?: {4,}.*)?\r?\n)*/mu.exec(ci)?.[0];
  assert.ok(qualityJob);
  assert.match(qualityJob, /node-version:\s*\n\s*- '22\.19\.0'\s*\n\s*- 'lts\/\*'/u);
  assert.match(qualityJob, /- name: Validate release metadata\s+if: matrix\.node-version == '22\.19\.0'\s+env:\s+KILLEROS_RELEASE: 'true'\s+run: node --experimental-strip-types scripts\/verify-release\.ts/u);
  assert.ok(qualityJob.indexOf("scripts/verify-release.ts") < qualityJob.indexOf("run: npm test"));
  assert.equal((qualityJob.match(/KILLEROS_RELEASE:/gu) ?? []).length, 1);
  assert.doesNotMatch(ci.split("jobs:")[0], /KILLEROS_RELEASE/u);
  assert.doesNotMatch(qualityJob.split("steps:")[0], /KILLEROS_RELEASE/u);
  const publishingNpm = /npm install --global npm@(\d+\.\d+\.\d+)/u.exec(release)?.[1];
  assert.ok(publishingNpm);
  assert.match(release, /npm prefix --global >> "\$GITHUB_PATH"/u);
  assert.ok(qualityJob.includes(`npm@${publishingNpm}`));
  assert.match(qualityJob, /- name: Provision publishing npm\s+if: matrix\.node-version == '22\.19\.0'/u);
  assert.match(qualityJob, /npm install --prefix "\$RUNNER_TEMP\/killeros-publishing-npm" --ignore-scripts --no-audit --no-fund --no-package-lock --no-save npm@/u);
  assert.match(qualityJob, /- name: Test publication lifecycle with publishing npm\s+if: matrix\.node-version == '22\.19\.0'\s+env:\s+KILLEROS_TEST_NPM_CLI: \$\{\{ runner\.temp \}\}\/killeros-publishing-npm\/node_modules\/npm\/bin\/npm-cli\.js\s+run: node --test --test-force-exit --experimental-strip-types --test-name-pattern="publication lifecycle" test\/verify-release\.test\.ts/u);
  assert.ok(qualityJob.indexOf('--test-name-pattern="publication lifecycle"') < qualityJob.indexOf("run: npm test"));
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

test("CI retains package smoke coverage until required-check migration", () => {
  const jobsStart = ci.search(/^jobs:\s*$/mu);
  const packageJob = /^  package:\r?\n(?:(?: {4,}.*)?\r?\n)*/mu.exec(ci.slice(jobsStart))?.[0];
  assert.ok(packageJob);
  assert.match(packageJob, /- name: Validate release metadata\s+env:\s+KILLEROS_RELEASE: 'true'\s+run: node --experimental-strip-types scripts\/verify-release\.ts/u);
  assert.ok(packageJob.indexOf("scripts/verify-release.ts") < packageJob.indexOf("npm pack"));
  assert.doesNotMatch(packageJob, /npm publish/u);
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
  assert.doesNotMatch(readme, /does not publish to npm|npm login/iu);
});

test("public README documents current requirements and commands", () => {
  assert.deepEqual(packageJson.os, ["win32"]);
  assert.match(readme, /KillerOS supports Windows only/u);
  assert.doesNotMatch(readme, /supports Windows and Linux|on Linux and Windows/u);
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(readme, new RegExp(`@v${escapedVersion}`, "u"));
  assert.match(readme, /Node\.js\s+`?22\.19\.0`?(?:\+| or later)/u);
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /^\/goal edit/mu);
  assert.match(readme, /^\/goal pause/mu);
  assert.match(readme, /^\/goal resume/mu);
  assert.match(readme, /^\/goal clear/mu);
  assert.doesNotMatch(readme, /\/goal (start|check|checks|limit|history)/u);
  for (const command of ["codex-fast", "notification", "handoff", "clear", "exit"] as const) {
    assert.match(readme, new RegExp(`^/${command}(?:\\s|$)`, "mu"));
  }
  assert.doesNotMatch(readme, /^\/init(?:\s|$)/mu);
  assert.doesNotMatch(readme, /killeros_init_/u);
  assert.match(readme, /^\/handoff \[focus\]/mu);
  assert.match(readme, /off by default/iu);
  assert.match(readme, /Nerd Font/iu);
  assert.doesNotMatch(readme, /work trail|transient borderless trail/iu);
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

test("request activity observes continuation scheduling before settlement cleanup", () => {
  const goalSettlement = main.indexOf("registerGoalSettlement(pi");
  const activity = main.indexOf("registerRequestActivity(pi");
  const notifications = main.indexOf("registerCompletionNotifications(pi");
  const workedFor = main.indexOf("registerWorkedFor(pi");

  assert.ok(workedFor < goalSettlement);
  assert.ok(goalSettlement < activity);
  assert.ok(activity < notifications);
});

test("removed init workflow leaves no command, tool, or runtime behind", () => {
  assert.doesNotMatch(main, /registerInit|killeros_init_|InitRuntime|createInitRuntime/u);
  assert.doesNotMatch(main, /^\s*pi\.registerCommand\("init"/mu);
});
