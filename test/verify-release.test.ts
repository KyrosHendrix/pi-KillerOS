import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/verify-release.ts", import.meta.url));
const RELEASE_ENV = { ...process.env, GITHUB_ACTIONS: "true", KILLEROS_RELEASE: "true" };

function fixture(overrides: { changelog?: string; lockVersion?: string; readme?: string } = {}): string {
  const directory = mkdtempSync(path.join(tmpdir(), "killeros-release-"));
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "killeros", version: "2.1.31" }));
  writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ version: overrides.lockVersion ?? "2.1.31", packages: { "": { version: overrides.lockVersion ?? "2.1.31" } } }));
  writeFileSync(path.join(directory, "CHANGELOG.md"), overrides.changelog ?? "## [Unreleased]\n\n## [2.1.31] - 2026-09-22\n");
  writeFileSync(path.join(directory, "README.md"), overrides.readme ?? "Pin a release by appending its tag, for example `@v2.1.31`.\n");
  return directory;
}

function verify(directory: string, env: NodeJS.ProcessEnv = RELEASE_ENV) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], { cwd: directory, env, encoding: "utf8" });
}

test("release verification passes only with complete matching metadata", () => {
  const directory = fixture();
  try {
    assert.equal(verify(directory).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release verification rejects direct publication and incomplete release metadata", () => {
  const cases = [
    { label: "outside the release workflow", overrides: {}, env: process.env, error: /only the verified GitHub release workflow may publish/iu },
    { label: "mismatched lockfile", overrides: { lockVersion: "2.1.30" }, env: RELEASE_ENV, error: /versions do not match/iu },
    { label: "missing changelog section", overrides: { changelog: "## [Unreleased]\n" }, env: RELEASE_ENV, error: /CHANGELOG\.md has no section/iu },
    { label: "stale README tag", overrides: { readme: "Pin a release by appending its tag, for example `@v2.1.30`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "current version elsewhere but stale pinned example", overrides: { readme: "Current version @v2.1.31.\nPin a release by appending its tag, for example `@v2.1.30`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
  ];

  for (const { label, overrides, env, error } of cases) {
    const directory = fixture(overrides);
    try {
      const result = verify(directory, env);
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, error, label);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
