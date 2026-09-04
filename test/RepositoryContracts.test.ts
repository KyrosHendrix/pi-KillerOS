import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type PackageJson = {
  version: string;
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
  assert.match(changelog, /Removed the decision-gated workflow subsystem/iu);
});

test("peer ranges enforce the tested Pi floor", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-ai": ">=0.84.3 <1",
    "@earendil-works/pi-coding-agent": ">=0.84.3 <1",
    "@earendil-works/pi-tui": ">=0.84.3 <1",
    typebox: ">=1.1.38 <2",
  });
  assert.match(readme, /Pi\s+`?0\.84\.3`? or later within the 0\.x release line/u);
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

test("CI blocks moderate dependency advisories without running lifecycle scripts", () => {
  assert.match(ci, /npm audit --audit-level=moderate --package-lock-only --ignore-scripts --no-fund/u);
  assert.match(ci, /fail-on-severity: moderate/u);
  assert.match(ci, /npm ci --ignore-scripts/u);
  assert.doesNotMatch(ci, /uses: [^\s]+@(?![a-f0-9]{40}(?:\s|$))/u);
});

test("CI checks the locked Pi floor and latest matched Pi packages", () => {
  assert.match(ci, /push:\s*\n\s*branches:\s*\n\s*- main\s*\n\s*- dev/u);
  assert.match(ci, /Pi latest compatibility/u);
  assert.match(ci, /Pi floor compatibility/u);
  assert.match(ci, /npm view "@earendil-works\/pi-coding-agent@>=0\.84\.3 <1" version/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-ai/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-tui/u);
  assert.match(ci, /@earendil-works\/pi-ai@\$PI_AI_RANGE/u);
  assert.match(ci, /@earendil-works\/pi-coding-agent@\$PI_VERSION/u);
  assert.match(ci, /@earendil-works\/pi-server@\$PI_VERSION/u);
  assert.match(ci, /@earendil-works\/pi-tui@\$PI_TUI_RANGE/u);
  assert.match(ci, /@earendil-works\/pi-ai@0\.84\.3/u);
  assert.match(ci, /@earendil-works\/pi-coding-agent@0\.84\.3/u);
  assert.match(ci, /@earendil-works\/pi-server@0\.84\.3/u);
  assert.match(ci, /@earendil-works\/pi-tui@0\.84\.3/u);
  assert.match(ci, /--package-lock=false/u);
  assert.equal(packageJson.devDependencies["@earendil-works/pi-ai"], "0.85.0");
  assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.85.0");
  assert.equal(packageJson.devDependencies["@earendil-works/pi-server"], "0.85.0");
  assert.equal(packageJson.devDependencies["@earendil-works/pi-tui"], "0.85.0");
});

test("GitHub releases require green current main and consistent package provenance", () => {
  assert.match(release, /workflow_run:/u);
  assert.match(release, /workflows:\s*\n\s*- CI/u);
  assert.match(release, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(release, /github\.event\.workflow_run\.head_sha/u);
  assert.match(release, /git fetch --no-tags origin main/u);
  assert.match(release, /CURRENT_MAIN=.*origin\/main/u);
  assert.match(release, /Verified commit .* is stale/u);
  assert.match(release, /PREVIOUS_VERSION.*VERSION/su);
  assert.match(release, /packageJson\.version !== packageLock\.version/u);
  assert.match(release, /scripts\/release-notes\.ts CHANGELOG\.md/u);
  assert.match(release, /Existing tag.*verified commit/u);
  assert.match(release, /git ls-remote[^\n]+\|\| TAG_LOOKUP_STATUS=\$\?/u);
  assert.match(release, /TAG_LOOKUP_STATUS != 2[\s\S]+exit "\$TAG_LOOKUP_STATUS"/u);
  assert.doesNotMatch(release, /push:\s*\n\s*tags:/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" version/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" gitHead/u);
  assert.match(release, /npm package.*verified commit/u);
  assert.match(release, /publish_npm/u);
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

test("public documentation exposes current requirements and commands", () => {
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(readme, new RegExp(`@v${escapedVersion}`, "u"));
  assert.match(readme, /Node\.js\s+`?22\.19\.0`?(?:\+| or later)/u);
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /^\/goal pause/mu);
  assert.match(readme, /^\/goal resume/mu);
  assert.match(readme, /^\/goal clear/mu);
  assert.doesNotMatch(readme, /\/goal (start|check|checks|limit|history|edit)/u);
  for (const command of ["init", "variants", "codex-fast", "notification", "handoff", "clear", "exit"] as const) {
    assert.match(readme, new RegExp(`^/${command}(?:\\s|$)`, "mu"));
  }
  assert.match(readme, /^\/handoff \[focus\]/mu);
  assert.match(readme, /off by default/iu);
  assert.match(readme, /Nerd Font/iu);
  assert.doesNotMatch(readme, /work trail|transient borderless trail/iu);
  assert.match(changelog, /completion sound/iu);
  assert.match(changelog, /Scoped atomic `\/init` reads and writes/u);
  assert.match(changelog, /save terminal state before immediately stopping active goal work/u);
  assert.match(changelog, /one durable blocker key on three consecutive goal turns/u);
  assert.match(readme, /settled.*token usage/iu);
  assert.match(readme, /question.*single-select and multi-select/iu);
  assert.match(changelog, /optional multi-select.*question/iu);
});

test("request activity observes continuation scheduling before settlement cleanup", () => {
  const goalSettlement = main.indexOf("registerGoalSettlement(pi");
  const initSettlement = main.indexOf("registerInitSettlement(pi");
  const activity = main.indexOf("registerRequestActivity(pi");
  const notifications = main.indexOf("registerCompletionNotifications(pi");
  const workedFor = main.indexOf("registerWorkedFor(pi");

  assert.ok(workedFor < goalSettlement);
  assert.ok(goalSettlement < activity);
  assert.ok(initSettlement < activity);
  assert.ok(activity < notifications);
});
