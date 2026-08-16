import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { extractReleaseSection } from "../scripts/release-notes.ts";

const CHANGELOG = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const SCRIPT = fileURLToPath(new URL("../scripts/release-notes.ts", import.meta.url));

test("extracts the changelog section for an existing version", () => {
  const section = extractReleaseSection(CHANGELOG, "2.0.2");
  assert.ok(section);
  assert.match(section, /^## \[2\.0\.2\] - 2026-08-08/);
  assert.match(section, /12-frame orange glyph loop at 120 ms per frame/);
});

test("stops the section at the next version header", () => {
  const section = extractReleaseSection(CHANGELOG, "2.0.2");
  assert.ok(section);
  assert.doesNotMatch(section, /## \[2\.0\.1\]/);
});

test("returns null for a version without a section", () => {
  assert.equal(extractReleaseSection(CHANGELOG, "9.9.9"), null);
});

test("does not treat the Unreleased header as a version", () => {
  const text = "# Changelog\n\n## [Unreleased]\n\nPending.\n\n## [2.0.2] - 2026-08-08\n\n### Changed\n\n- X.\n";
  assert.equal(extractReleaseSection(text, "Unreleased"), null);
});

test("ignores a leading UTF-8 BOM before the first header", () => {
  const text = "\uFEFF## [2.0.2] - 2026-08-08\n\n### Changed\n\n- X.\n";
  const section = extractReleaseSection(text, "2.0.2");
  assert.ok(section);
  assert.match(section, /^## \[2\.0\.2\]/);
  assert.match(section, /- X\./);
});

test("a leading BOM does not turn a headerless changelog into a section", () => {
  assert.equal(extractReleaseSection("\uFEFF\n\nno headers here\n", "1.0.0"), null);
});

test("cli prints the section and exits 0", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "CHANGELOG.md", "2.0.2"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^## \[2\.0\.2\]/);
});

test("cli exits 1 with a message when the section is missing", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "CHANGELOG.md", "9.9.9"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no section for version 9\.9\.9/);
});

test("cli exits 1 with a clean message when the changelog file cannot be read", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "no-such-changelog.md", "2.0.2"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^cannot read changelog no-such-changelog\.md:/);
});

test("cli exits 2 on bad usage", () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
});
