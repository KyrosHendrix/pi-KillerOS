import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const product = readFileSync(new URL("../PRODUCT.md", import.meta.url), "utf8");
const design = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const context = readFileSync(new URL("../CONTEXT.md", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const oldCompactionPlan = readFileSync(new URL("../docs/implemented/context-compaction.md", import.meta.url), "utf8");
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function repositoryFiles(directory = repositoryRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const entryPath = path.join(directory, entry);
    if (statSync(entryPath).isDirectory()) files.push(...repositoryFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

test("repository contains no retired feature references", () => {
  const retiredTerms = [
    "sub" + "agent",
    "sub" + "-agent",
    "sub" + " agent",
    "child" + " agent",
    "child" + " thread",
  ];
  const matches = repositoryFiles().filter((file) => {
    const content = readFileSync(file, "utf8").toLocaleLowerCase();
    return retiredTerms.some((term) => content.includes(term));
  });
  assert.deepEqual(matches, []);
});

test("peer ranges enforce the documented lower bounds", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-ai": ">=0.82.1",
    "@earendil-works/pi-coding-agent": ">=0.82.1",
    "@earendil-works/pi-tui": ">=0.82.1",
    typebox: ">=1.1.38 <2",
  });
});

test("compaction documentation assigns ownership to Pi", () => {
  assert.match(readme, /Pi decides when compaction runs/u);
  assert.match(readme, /Pi writes the summary/u);
  assert.match(readme, /manual `\/compact`.*pause.*resumes/isu);
  assert.doesNotMatch(readme, /40% remaining|deterministic fallback|KillerOS checks context after each agent turn/iu);
  assert.match(oldCompactionPlan, /STATUS: SUPERSEDED/u);
  assert.match(oldCompactionPlan, /docs\/adr\/0001-let-pi-own-compaction\.md/u);
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
  assert.equal(packageJson.devDependencies["@earendil-works/pi-coding-agent"], "0.82.1");
  assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.82.1");
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
  assert.match(release, /push:\s*\n\s*tags:/u);
  assert.match(readme, /After the full CI workflow passes.*matching tag and GitHub release/su);
  assert.match(readme, /manual tag recovery path|recover a missing GitHub release/iu);
});

test("product and design docs match current runtime contracts", () => {
  assert.equal(packageJson.version, "2.0.5");
  assert.match(readme, /@v2\.0\.5/u);
  assert.match(readme, /12-frame/u);
  assert.match(product, /· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·/u);
  assert.match(product, /120 ms/u);
  assert.match(product, /esc to interrupt · thinking/u);
  assert.match(design, /· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·/u);
  assert.match(design, /120 ms/u);
  assert.match(design, /esc to interrupt · thinking/u);
  assert.match(readme, /Node\.js `22\.19\.0` or later/u);
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /\/goal pause\s+Stop the current goal turn and automatic continuation/u);
  assert.match(readme, /\/goal clear\s+Stop current goal work and remove the goal/u);
  assert.match(readme, /stable lowercase blocker key recorded on three consecutive goal turns/u);
  assert.match(readme, /save paused or cleared state before aborting current goal work/u);
  assert.match(readme, /Failed edit and replacement writes dispatch no edited objective/u);
  assert.match(readme, /\/init/u);
  assert.match(readme, /\/notification/u);
  assert.match(readme, /off by default/iu);
  assert.match(readme, /global user preference/iu);
  assert.match(readme, /audible bell/iu);
  assert.match(readme, /Nerd Font/iu);
  assert.match(readme, /\/goal is active/iu);
  assert.match(product, /settled request/iu);
  assert.match(product, /completion sound/iu);
  assert.match(design, /π - <cwd> 󰂚/u);
  assert.match(design, /U\+F009A/u);
  assert.match(design, /\/goal is active \(10s\)/u);
  assert.match(changelog, /completion sound/iu);
  assert.match(product, /custom terminal UI/u);
  assert.match(product, /typed prompt text uses the normal editor color/u);
  assert.match(product, /custom editor factory from another extension unchanged/u);
  assert.doesNotMatch(product, /context remaining, and loaded package capabilities/u);
  assert.match(design, /dynamic|package version|v<package version>/iu);
  assert.match(design, /typed prompt text in its normal role/u);
  assert.match(design, /Do not replace an editor factory owned by another extension/u);
  assert.doesNotMatch(design, /\(v1\.2\.0\)/u);
  assert.match(changelog, /Scoped atomic `\/init` reads and writes/u);
  assert.match(changelog, /save terminal state before immediately stopping active goal work/u);
  assert.match(changelog, /one durable blocker key on three consecutive goal turns/u);
  assert.match(context, /\*\*Goal stop boundary\*\*/u);
  assert.match(context, /first saves non-active Goal truth, then aborts/u);
  assert.match(context, /\*\*Blocker audit streak\*\*/u);
});
