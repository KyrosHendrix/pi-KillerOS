import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const failureReporter = new URL("./support/ScenarioFailure.ts", import.meta.url).href;

test("scenario failures expose nested errors and bounded reports even with forced exit", { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-failure-control-"));
  const reportDirectory = path.join(directory, "report");
  mkdirSync(reportDirectory);
  const script = path.join(directory, "failure.mjs");
  writeFileSync(script, `
import test from 'node:test';
import { throwScenarioFailure } from ${JSON.stringify(failureReporter)};
const errors = [new AggregateError([new Error('original assertion', {cause: new Error('nested cause')})], 'nested failure'), new Error('cleanup failure'), new Error('x'.repeat(100000))];
for (const [label, directory] of [['saved', ${JSON.stringify(reportDirectory)}], ['unsaved', ${JSON.stringify(path.join(directory, "missing"))}]]) {
  test(label, t => {
    t.diagnostic('deferred diagnostic');
    throwScenarioFailure({directory, message:'intentional scenario failure', errors,
      diagnostics:'SCREEN_MARKER ' + 'x'.repeat(100000)});
  });
}
`);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory, PATH: path.dirname(process.execPath) };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  try {
    const result = spawnSync(process.execPath, ["--test", "--test-force-exit", "--experimental-strip-types", "--test-reporter=tap", script],
      { cwd: directory, env, encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, "Deliberate failures must remain failures");
    assert.equal(result.signal, null);
    const output = result.stdout + result.stderr;
    for (const marker of ["original assertion", "nested cause", "cleanup failure", "SCREEN_MARKER", "Could not save failure report"]) {
      assert.ok(output.includes(marker), `Test output omitted ${marker}`);
    }
    const report = readFileSync(path.join(reportDirectory, "failure.txt"), "utf8");
    assert.ok(report.length <= 65_536);
    for (const marker of ["original assertion", "nested cause", "cleanup failure", "SCREEN_MARKER"]) assert.ok(report.includes(marker));
    assert.equal(existsSync(path.join(directory, "missing")), false, "Reporting must not create an unowned fixture directory");
  } finally {
    await removeDirectoryEventually(directory);
  }
});
