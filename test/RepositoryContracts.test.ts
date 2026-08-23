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
  include: string[];
};

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;
const tsconfig = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")) as TypeScriptConfig;
const main = readFileSync(new URL("../Killeros.ts", import.meta.url), "utf8");
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
    "@earendil-works/pi-ai": ">=0.84.2",
    "@earendil-works/pi-coding-agent": ">=0.84.2",
    "@earendil-works/pi-tui": ">=0.84.2",
    typebox: ">=1.1.38 <2",
  });
  assert.match(readme, /Pi\s+`?0\.84\.2`?(?:\+| or later)/u);
});

test("machine identifiers use locale-independent casing", () => {
  const source = repositoryFiles(path.join(repositoryRoot, "killeros"))
    .filter((file: string) => file.endsWith(".ts"))
    .map((file: string) => readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /\.toLocale(?:Lower|Upper)Case\(/u);
});

test("all shipped TypeScript entry points are type-checked", () => {
  assert.deepEqual(tsconfig.include, ["Killeros.ts", "scripts/**/*.ts", "test/**/*.ts"]);
});

test("public compaction documentation states the configurable default", () => {
  assert.match(readme, /compaction triggers by default at 15% tokens remaining/iu);
  assert.match(readme, /"autoCompaction"/u);
  assert.match(readme, /"enabled": true/u);
  assert.match(readme, /"percentRemaining": 15/u);
  assert.doesNotMatch(readme, /40% remaining|deterministic fallback/iu);
});

test("CI checks the locked Pi floor and latest matched Pi packages", () => {
  assert.match(ci, /Pi latest compatibility/u);
  assert.match(ci, /npm view @earendil-works\/pi-coding-agent version/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-ai/u);
  assert.match(ci, /dependencies\.@earendil-works\/pi-tui/u);
  assert.match(ci, /@earendil-works\/pi-ai@\$PI_AI_RANGE/u);
  assert.match(ci, /@earendil-works\/pi-coding-agent@\$PI_VERSION/u);
  assert.match(ci, /@earendil-works\/pi-tui@\$PI_TUI_RANGE/u);
  assert.match(ci, /--package-lock=false/u);
  assert.equal(packageJson.devDependencies["@earendil-works/pi-ai"], "0.84.2");
  assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.84.2");
  assert.equal(packageJson.devDependencies["@earendil-works/pi-tui"], "0.84.2");
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.84.2");
});

test("GitHub releases require a green CI version bump and consistent metadata", () => {
  assert.match(release, /workflow_run:/u);
  assert.match(release, /workflows:\s*\n\s*- CI/u);
  assert.match(release, /github\.event\.workflow_run\.conclusion == 'success'/u);
  assert.match(release, /github\.event\.workflow_run\.head_sha/u);
  assert.match(release, /PREVIOUS_VERSION.*VERSION/su);
  assert.match(release, /packageJson\.version !== packageLock\.version/u);
  assert.match(release, /scripts\/release-notes\.ts CHANGELOG\.md/u);
  assert.match(release, /Existing tag.*verified commit/u);
  assert.doesNotMatch(release, /push:\s*\n\s*tags:/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" version/u);
  assert.match(release, /publish_npm/u);
  assert.match(readme, /Releases go through CI on `main`/u);
  assert.match(readme, /do not push version tags manually/iu);
  assert.doesNotMatch(readme, /does not publish to npm|npm login/iu);
});

test("public documentation exposes current requirements and commands", () => {
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(readme, new RegExp(`@v${escapedVersion}`, "u"));
  assert.match(readme, /Node\.js\s+`?22\.19\.0`?(?:\+| or later)/u);
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /^\/goal edit\|pause\|resume\|clear/mu);
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
  assert.match(readme, /question.*single-select and multi-select/iu);
  assert.match(changelog, /optional multi-select.*question/iu);
});

test("request activity observes continuation scheduling before settlement cleanup", () => {
  const goalSettlement = main.indexOf("registerGoalSettlement(pi");
  const initSettlement = main.indexOf("registerInitSettlement(pi");
  const activity = main.indexOf("registerRequestActivity(pi");
  const notifications = main.indexOf("registerCompletionNotifications(pi");
  const workedFor = main.indexOf("registerWorkedFor(pi");

  assert.ok(goalSettlement < activity);
  assert.ok(initSettlement < activity);
  assert.ok(activity < notifications);
  assert.ok(activity < workedFor);
});
