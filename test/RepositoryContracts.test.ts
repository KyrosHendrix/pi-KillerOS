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

test("product and design docs match current runtime contracts", () => {
  assert.equal(packageJson.version, "2.0.0");
  assert.match(readme, /Node\.js `22\.19\.0` or later/u);
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /\/init/u);
  assert.match(product, /custom terminal UI/u);
  assert.doesNotMatch(product, /context remaining, and loaded package capabilities/u);
  assert.match(design, /dynamic|package version|v<package version>/iu);
  assert.doesNotMatch(design, /\(v1\.2\.0\)/u);
  assert.match(changelog, /Scoped atomic `\/init` reads and writes/u);
});
