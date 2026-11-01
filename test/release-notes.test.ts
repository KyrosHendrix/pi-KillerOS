import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const CHANGELOG = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const CURRENT_RELEASE_VERSION = /^## \[(\d+\.\d+\.\d+)\]/mu.exec(CHANGELOG)?.[1];
const TEST_CHANGELOG = `# Changelog

## [Unreleased]

Pending.

## [2.0.2] - 2026-08-08

### Changed

- A sample release note.

## [2.0.1] - 2026-08-07

### Changed

- An earlier release note.
`;
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/release-notes.ts", import.meta.url));
const CLI_ENV: NodeJS.ProcessEnv = {
  PATH: path.dirname(process.execPath),
  SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
};

const SCENARIO_ID = "runtime.system-release-notes-success";
const SCENARIO_TITLE = "release-notes CLI extracts BOM-safe sections and prints current notes";
const SAMPLE_SECTION = "## [2.0.2] - 2026-08-08\n\n### Changed\n\n- A sample release note.";
const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

test(SCENARIO_TITLE, async () => {
  const errors: unknown[] = [];
  const observations: string[] = [];
  let scratchDirectory: string | undefined;
  let launches = 0;

  const runCli = (label: string, changelogPath: string, version: string) => {
    const result = spawnSync(process.execPath, [SCRIPT, changelogPath, version], {
      cwd: REPOSITORY_ROOT,
      env: CLI_ENV,
      encoding: "utf8",
      timeout: 15_000,
    });
    launches += 1;
    observations.push(JSON.stringify({
      launch: launches,
      label,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout.slice(0, 2_000),
      stderr: result.stderr.slice(0, 2_000),
    }));
    assert.equal(result.error, undefined, `${SCENARIO_ID}: ${label} CLI must exit without a spawn error or timeout`);
    assert.equal(result.signal, null, `${SCENARIO_ID}: ${label} CLI must exit naturally`);
    return result;
  };

  try {
    const fixtureDirectory = mkdtempSync(path.join(tmpdir(), "killeros-release-notes-"));
    scratchDirectory = fixtureDirectory;
    const writeFixture = (name: string, contents: string): string => {
      const fixturePath = path.join(fixtureDirectory, `${name}.md`);
      writeFileSync(fixturePath, contents, "utf8");
      return fixturePath;
    };

    const existing = runCli("existing section", writeFixture("existing", TEST_CHANGELOG), "2.0.2");
    assert.equal(existing.status, 0);
    assert.equal(existing.stdout, `${SAMPLE_SECTION}\n`);
    assert.doesNotMatch(existing.stdout, /## \[2\.0\.1\]/);
    assert.equal(existing.stderr, "");

    const missing = runCli("missing version", writeFixture("missing", TEST_CHANGELOG), "9.9.9");
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(missing.stderr, "CHANGELOG.md has no section for version 9.9.9\n");

    const unreleased = runCli(
      "Unreleased is not a version",
      writeFixture("unreleased", "# Changelog\n\n## [Unreleased]\n\nPending.\n\n## [2.0.2] - 2026-08-08\n\n### Changed\n\n- X.\n"),
      "Unreleased",
    );
    assert.equal(unreleased.status, 1);
    assert.equal(unreleased.stdout, "");
    assert.equal(unreleased.stderr, "CHANGELOG.md has no section for version Unreleased\n");

    const bom = runCli("leading BOM", writeFixture("bom", "\uFEFF## [2.0.2] - 2026-08-08\n\n### Changed\n\n- X.\n"), "2.0.2");
    assert.equal(bom.status, 0);
    assert.equal(bom.stdout, "## [2.0.2] - 2026-08-08\n\n### Changed\n\n- X.\n");
    assert.equal(bom.stderr, "");

    const headerlessBom = runCli("headerless BOM", writeFixture("headerless-bom", "\uFEFF\n\nno headers here\n"), "1.0.0");
    assert.equal(headerlessBom.status, 1);
    assert.equal(headerlessBom.stdout, "");
    assert.equal(headerlessBom.stderr, "CHANGELOG.md has no section for version 1.0.0\n");

    assert.ok(CURRENT_RELEASE_VERSION);
    const currentHeader = `## [${CURRENT_RELEASE_VERSION}]`;
    const currentStart = CHANGELOG.indexOf(currentHeader);
    assert.notEqual(currentStart, -1);
    const nextHeader = CHANGELOG.indexOf("\n## [", currentStart + currentHeader.length);
    const currentSection = CHANGELOG.slice(currentStart, nextHeader === -1 ? CHANGELOG.length : nextHeader).trim();
    const current = runCli("current repository release", CHANGELOG_PATH, CURRENT_RELEASE_VERSION);
    assert.equal(current.status, 0);
    assert.equal(current.stdout, `${currentSection}\n`);
    assert.equal(current.stderr, "");
    assert.equal(launches, 6, `${SCENARIO_ID}: exactly six CLI processes cover seven source registrations`);
  } catch (error) {
    errors.push(error);
  }

  if (scratchDirectory !== undefined) {
    try {
      await removeDirectoryEventually(scratchDirectory);
      assert.equal(existsSync(scratchDirectory), false, `${SCENARIO_ID}: remove the owned fixture directory`);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 0) return;

  let failureDirectory: string;
  try {
    failureDirectory = mkdtempSync(path.join(REPOSITORY_ROOT, "node_modules", `.killeros-${SCENARIO_ID}-`));
  } catch (error) {
    throw new AggregateError([...errors, error], `${SCENARIO_ID} could not create failure evidence`);
  }

  try {
    throwScenarioFailure({
      directory: failureDirectory,
      message: `${SCENARIO_ID} failed`,
      errors,
      diagnostics: observations.join("\n").slice(0, 32_768),
    });
  } catch (error) {
    if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
      try {
        await removeDirectoryEventually(failureDirectory);
      } catch (cleanupError) {
        throw new AggregateError([...errors, error, cleanupError], `${SCENARIO_ID} failed and failure evidence cleanup failed`);
      }
    }
    throw error;
  }
});

// runtime.system-release-notes-failures
const FAILURE_SCENARIO_ID = "runtime.system-release-notes-failures";
test("release-notes CLI fails cleanly for missing sections, unreadable files, and bad usage", async () => {
  const errors: unknown[] = [];
  const observations: string[] = [];
  let scratchDirectory: string | undefined;
  let launches = 0;

  const runCli = (label: string, args: string[]) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: scratchDirectory,
      env: CLI_ENV,
      encoding: "utf8",
      timeout: 15_000,
    });
    launches += 1;
    observations.push(JSON.stringify({
      launch: launches,
      label,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout.slice(0, 2_000),
      stderr: result.stderr.slice(0, 2_000),
    }));
    assert.equal(result.error, undefined, `${FAILURE_SCENARIO_ID}: ${label} CLI must exit without a spawn error or timeout`);
    assert.equal(result.signal, null, `${FAILURE_SCENARIO_ID}: ${label} CLI must exit naturally`);
    return result;
  };

  try {
    scratchDirectory = mkdtempSync(path.join(tmpdir(), "killeros-release-notes-failures-"));
    const changelogPath = path.join(scratchDirectory, "CHANGELOG.md");
    writeFileSync(changelogPath, TEST_CHANGELOG, "utf8");

    const missingSection = runCli("missing section", [changelogPath, "9.9.9"]);
    assert.equal(missingSection.status, 1, `${FAILURE_SCENARIO_ID}: missing section exit code`);
    assert.equal(missingSection.stdout, "", `${FAILURE_SCENARIO_ID}: missing section stdout`);
    assert.equal(missingSection.stderr, "CHANGELOG.md has no section for version 9.9.9\n", `${FAILURE_SCENARIO_ID}: missing section diagnostic`);

    const missingFile = runCli("missing changelog file", ["no-such-changelog.md", "2.0.2"]);
    assert.equal(missingFile.status, 1, `${FAILURE_SCENARIO_ID}: missing file exit code`);
    assert.equal(missingFile.stdout, "", `${FAILURE_SCENARIO_ID}: missing file stdout`);
    assert.equal(missingFile.stderr, "cannot read changelog no-such-changelog.md: ENOENT\n", `${FAILURE_SCENARIO_ID}: missing file diagnostic`);

    const badUsage = runCli("bad usage", []);
    assert.equal(badUsage.status, 2, `${FAILURE_SCENARIO_ID}: bad usage exit code`);
    assert.equal(badUsage.stdout, "", `${FAILURE_SCENARIO_ID}: bad usage stdout`);
    assert.equal(badUsage.stderr, "usage: node scripts/release-notes.ts <changelog.md> <version>\n", `${FAILURE_SCENARIO_ID}: usage diagnostic`);
    assert.equal(launches, 3, `${FAILURE_SCENARIO_ID}: exactly three CLI processes exercise the mapped failures`);
  } catch (error) {
    errors.push(error);
  }

  if (scratchDirectory !== undefined) {
    try {
      await removeDirectoryEventually(scratchDirectory);
      assert.equal(existsSync(scratchDirectory), false, `${FAILURE_SCENARIO_ID}: remove the owned fixture directory`);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 0) return;

  let failureDirectory: string;
  try {
    failureDirectory = mkdtempSync(path.join(REPOSITORY_ROOT, "node_modules", `.killeros-${FAILURE_SCENARIO_ID}-`));
  } catch (error) {
    throw new AggregateError([...errors, error], `${FAILURE_SCENARIO_ID} could not create failure evidence`);
  }

  try {
    throwScenarioFailure({
      directory: failureDirectory,
      message: `${FAILURE_SCENARIO_ID} failed`,
      errors,
      diagnostics: observations.join("\n").slice(0, 32_768),
    });
  } catch (error) {
    if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
      try {
        await removeDirectoryEventually(failureDirectory);
      } catch (cleanupError) {
        throw new AggregateError([...errors, error, cleanupError], `${FAILURE_SCENARIO_ID} failed and failure evidence cleanup failed`);
      }
    }
    throw error;
  }
});
