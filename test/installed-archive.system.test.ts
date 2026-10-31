import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const requiredFiles = ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"];
const run = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Expected a JSON object");
  return value;
}

function assertArchive(files: string[], manifest: unknown, expectedVersion: string): void {
  for (const file of requiredFiles) assert.ok(files.includes(`package/${file}`), `Package is missing: ${file}`);
  const identity = record(manifest);
  assert.equal(identity.name, "killeros", "Unexpected package name");
  assert.equal(identity.version, expectedVersion, "Unexpected package version");
  assert.deepEqual(identity.os, ["win32"], "Package must restrict installation to Windows");
}

// Catalog ID: runtime.system-archive-integrity.
test("installed archive assertions reject missing files, identity drift, and non-Windows metadata", {
  timeout: 120_000,
}, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "killeros-archive-"));
  const observations: { label: string; files: string[]; rejected: boolean }[] = [];
  let childLaunches = 0;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    const windowsRoot = inherited.get("systemroot");
    assert.ok(windowsRoot, "Windows SystemRoot is required for the native tar CLI");
    const tar = path.join(windowsRoot, "System32", "tar.exe");
    assert.ok(existsSync(tar));
    const npmCli = [path.dirname(process.execPath), ...(inherited.get("path") ?? "").split(path.delimiter)]
      .map((entry) => path.join(entry, "node_modules/npm/bin/npm-cli.js"))
      .find((entry) => existsSync(entry));
    assert.ok(npmCli, "Cannot locate npm-cli.js without a shell");
    const env: NodeJS.ProcessEnv = {
      PATH: path.dirname(process.execPath), HOME: directory, USERPROFILE: directory,
      TEMP: directory, TMP: directory, npm_config_cache: path.join(directory, "cache"),
      npm_config_update_notifier: "false",
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) env[key] = inherited.get(key.toLowerCase());
    const userConfig = path.join(directory, "user.npmrc");
    const globalConfig = path.join(directory, "global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const realManifest = record(JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")));
    assert.equal(typeof realManifest.version, "string");
    const version = String(realManifest.version);
    const valid = { name: "killeros", version, os: ["win32"] };
    const vectors = [
      { label: "valid", manifest: valid, omitted: "", expected: "" },
      ...requiredFiles.map((file) => ({ label: `missing ${file}`, manifest: valid, omitted: file, expected: `Package is missing: ${file}` })),
      { label: "wrong name", manifest: { ...valid, name: "not-killeros" }, omitted: "", expected: "Unexpected package name" },
      { label: "wrong version", manifest: { ...valid, version: "0.0.0" }, omitted: "", expected: "Unexpected package version" },
      { label: "missing os", manifest: { name: "killeros", version }, omitted: "", expected: "Package must restrict installation to Windows" },
      { label: "linux os", manifest: { ...valid, os: ["linux"] }, omitted: "", expected: "Package must restrict installation to Windows" },
      { label: "mixed os", manifest: { ...valid, os: ["win32", "linux"] }, omitted: "", expected: "Package must restrict installation to Windows" },
    ];
    for (const [index, vector] of vectors.entries()) {
      const fixture = path.join(directory, String(index));
      mkdirSync(fixture);
      writeFileSync(path.join(fixture, "package.json"), JSON.stringify(vector.manifest));
      for (const file of requiredFiles) {
        if (file === vector.omitted) continue;
        mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
        writeFileSync(path.join(fixture, file), "fixture");
      }
      const options = { cwd: fixture, env, encoding: "utf8" as const, timeout: 30_000, maxBuffer: 65_536, signal: t.signal };
      childLaunches++;
      const packed = await run(process.execPath, [npmCli, "--userconfig", userConfig, "--globalconfig", globalConfig,
        "--loglevel", "error", "pack", "--ignore-scripts", "--offline", "--json"], options);
      const parsed: unknown = JSON.parse(packed.stdout);
      const packages: unknown = Array.isArray(parsed) ? parsed : Object.values(record(parsed));
      assert.ok(Array.isArray(packages) && packages.length === 1);
      const archive = record(packages[0]);
      assert.ok(typeof archive.filename === "string" && path.basename(archive.filename) === archive.filename);
      childLaunches++;
      const listing = await run(tar, ["-tzf", archive.filename], options);
      const files = listing.stdout.trim().split(/\r?\n/u);
      childLaunches++;
      const extracted = await run(tar, ["-xOzf", archive.filename, "package/package.json"], options);
      const manifest: unknown = JSON.parse(extracted.stdout);
      observations.push({ label: vector.label, files, rejected: vector.expected !== "" });
      if (vector.expected) {
        assert.throws(() => assertArchive(files, manifest, version), (error: unknown) =>
          error instanceof assert.AssertionError && error.message.includes(vector.expected), vector.label);
      } else {
        assertArchive(files, manifest, version);
      }
      await removeDirectoryEventually(fixture);
      assert.equal(existsSync(fixture), false, `${vector.label} fixture was removed`);
    }
    assert.equal(observations.length, 10, "The valid archive and all nine negative vectors ran");
    assert.equal(childLaunches, 30, "Each vector runs one npm pack and two native archive reads");
  } catch (error) { failure = error; }
  try { await removeDirectoryEventually(directory); }
  catch (error) { cleanupErrors.push(error); }
  if (failure !== undefined || cleanupErrors.length > 0) {
    throwScenarioFailure({ directory, message: "Installed archive system scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupErrors],
      diagnostics: JSON.stringify({ node: process.version, directory, childLaunches, observations }),
    });
  }
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.system-archive-integrity", vectors: observations.length,
    piLaunches: 0, npmLaunches: 10, archiveReads: 20, childLaunches, naturalExit: true, scratchRemoved: true }));
});
