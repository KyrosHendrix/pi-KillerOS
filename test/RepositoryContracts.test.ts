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
const concept = readFileSync(new URL("../design/main-Killeros.html", import.meta.url), "utf8");
const conceptText = concept.replace(/<[^>]+>/gu, "");
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

test("browser concept keeps colors and radii in root tokens", () => {
  const css = concept.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? "";
  const withoutRoot = css.replace(/:root\s*\{[\s\S]*?\}/u, "");
  assert.doesNotMatch(withoutRoot, /:\s*(?:#[0-9a-f]{3,8}\b|rgba?\([^)]*\))/iu);
  assert.doesNotMatch(withoutRoot, /border-radius\s*:\s*(?!var\()/iu);
});

test("browser concept describes the current KillerOS runtime", () => {
  assert.match(concept, new RegExp(`\\(v${packageJson.version.replaceAll(".", "\\.")}\\)`));
  assert.doesNotMatch(concept, /Plan only|no runtime implementation yet|Planned KillerOS goal flow|Proposed KillerOS init flow/iu);
  assert.match(concept, /Animated orange glyph loop/iu);
  assert.match(conceptText, /·✢✱✶✻✽✽✻✶✱✢·/u);
  assert.match(concept, /120 ms/u);
  assert.doesNotMatch(concept, /Static Spark/iu);
  assert.match(concept, /2\.5 seconds/u);
  assert.match(concept, /Pause automatic continuation/u);
  assert.match(concept, /Completed goals leave the footer/u);
});

test("browser concept preserves visible keyboard focus", () => {
  const css = concept.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? "";
  assert.doesNotMatch(css, /:focus-visible[^\{]*\{[^}]*outline\s*:\s*(?:0|none)/giu);
  assert.match(css, /:focus-visible[^\{]*\{[^}]*outline\s*:\s*2px solid var\(--coral\)/giu);
});

test("peer ranges enforce the documented lower bounds", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-ai": ">=0.82.1",
    "@earendil-works/pi-coding-agent": ">=0.82.1",
    "@earendil-works/pi-tui": ">=0.82.1",
    typebox: ">=1.1.38 <2",
  });
});

test("product and design docs match current runtime contracts", () => {
  assert.equal(packageJson.version, "2.0.2");
  assert.match(readme, /@v2\.0\.2/u);
  assert.match(readme, /12-frame/u);
  assert.match(product, /· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·/u);
  assert.match(product, /120 ms/u);
  assert.match(product, /esc to interrupt · thinking/u);
  assert.match(design, /· ✢ ✱ ✶ ✻ ✽ ✽ ✻ ✶ ✱ ✢ ·/u);
  assert.match(design, /120 ms/u);
  assert.match(design, /esc to interrupt · thinking/u);
  assert.match(readme, /Node\.js `22\.19\.0` or later/u);
  assert.match(readme, /\/goal <objective>/u);
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
  assert.match(product, /recognized slash commands and valid command prefixes use Command Blue/u);
  assert.doesNotMatch(product, /context remaining, and loaded package capabilities/u);
  assert.match(design, /dynamic|package version|v<package version>/iu);
  assert.match(design, /valid prefixes in Command Blue while the user types/u);
  assert.doesNotMatch(design, /\(v1\.2\.0\)/u);
  assert.match(changelog, /Scoped atomic `\/init` reads and writes/u);
});
