import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const failureReporter = new URL("./support/ScenarioFailure.ts", import.meta.url).href;

type FixtureMode = "natural" | "forced";

type ChildObservation = {
  mode: FixtureMode;
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnError: string | undefined;
  output: string;
  report: string | undefined;
};

function fixtureEnvironment(directory: string, mode: FixtureMode): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    PATH: path.dirname(process.execPath),
    KILLEROS_SCENARIO_FAILURE_MODE: mode,
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Catalog ID: runtime.system-scenario-failure.
test("scenario failures expose nested errors and bounded reports under forced exit", {
  timeout: 45_000,
}, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-scenario-failure-"));
  const observations: ChildObservation[] = [];
  const failures: unknown[] = [];

  try {
    const reportRoot = path.join(directory, "reports");
    mkdirSync(path.join(reportRoot, "natural"), { recursive: true });
    mkdirSync(path.join(reportRoot, "forced"), { recursive: true });
    const script = path.join(directory, "failure.mjs");
    writeFileSync(script, `
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { throwScenarioFailure } from ${JSON.stringify(failureReporter)};

const mode = process.env.KILLEROS_SCENARIO_FAILURE_MODE;
assert.ok(mode === 'natural' || mode === 'forced');
const reportDirectory = path.join(${JSON.stringify(reportRoot)}, mode);
const missingDirectory = path.join(${JSON.stringify(path.join(directory, "missing"))}, mode);
const heldHandle = mode === 'forced' ? setInterval(() => {}, 60_000) : undefined;
process.stdout.write(heldHandle ? 'FORCED_HANDLE_ACTIVE\\n' : 'NATURAL_NO_HELD_HANDLE\\n');

test('scenario failure reporter fixture', () => {
  const errors = [
    new AggregateError([new Error('original assertion', { cause: new Error('nested cause') })], 'nested failure'),
    new Error('cleanup failure'),
    new Error('x'.repeat(100_000)),
  ];
  const diagnostics = 'FIXTURE_MODE=' + mode + '; SCREEN_MARKER ' + 'x'.repeat(100_000);
  let savedFailure;
  try {
    throwScenarioFailure({ directory: reportDirectory, message: 'fixture assertion failed', errors, diagnostics });
  } catch (error) {
    savedFailure = error;
  }
  assert.ok(savedFailure instanceof AggregateError);

  const reportPath = path.join(reportDirectory, 'failure.txt');
  assert.equal(existsSync(reportPath), true, 'The reporter must save before the fixture exits');
  const report = readFileSync(reportPath, 'utf8');
  assert.ok(Buffer.byteLength(report, 'utf8') <= 65_536);
  for (const marker of ['AggregateError: nested failure', 'Error: original assertion', 'Error: nested cause', 'Error: cleanup failure', 'SCREEN_MARKER']) {
    assert.ok(report.includes(marker), 'The saved report omitted ' + marker);
  }

  let unsavedFailure;
  try {
    throwScenarioFailure({ directory: missingDirectory, message: 'unsaved fixture failure', errors, diagnostics });
  } catch (error) {
    unsavedFailure = error;
  }
  assert.ok(unsavedFailure instanceof AggregateError);
  assert.match(unsavedFailure.message, /Could not save failure report/u);
  assert.equal(existsSync(missingDirectory), false, 'The reporter must not create an unowned directory');
  for (const marker of ['original assertion', 'nested cause', 'cleanup failure', 'SCREEN_MARKER']) {
    assert.ok(unsavedFailure.message.includes(marker), 'The unsaved failure omitted ' + marker);
  }

  if (mode === 'forced') {
    assert.ok(heldHandle?.hasRef(), 'The forced-exit control must retain a referenced handle');
    process.stdout.write('FORCED_HANDLE_STILL_REFERENCED\\n');
  } else {
    assert.equal(heldHandle, undefined);
    process.stdout.write('NATURAL_EXIT_HAS_NO_HELD_HANDLE\\n');
  }
  throw unsavedFailure;
});
`);

    for (const mode of ["natural", "forced"] as const) {
      const reportPath = path.join(reportRoot, mode, "failure.txt");
      const result = spawnSync(process.execPath, [
        "--test",
        ...(mode === "forced" ? ["--test-force-exit"] : []),
        "--experimental-strip-types",
        "--test-reporter=tap",
        script,
      ], {
        cwd: directory,
        env: fixtureEnvironment(directory, mode),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 512 * 1024,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined;
      observations.push({
        mode,
        status: result.status,
        signal: result.signal,
        spawnError: result.error?.message,
        output,
        report,
      });

      assert.equal(result.error, undefined, `${mode} fixture did not exit within its bound`);
      assert.equal(result.status, 1, `${mode} fixture failure must remain a failing test`);
      assert.equal(result.signal, null);
      assert.match(output, /^# tests 1$/mu, "Each child must report exactly one fixture registration");
      assert.match(output, /^1\.\.1$/mu, "Each child must report exactly one fixture result");
      assert.equal((output.match(/^not ok \d+ - /gmu) ?? []).length, 1);
      for (const marker of ["AggregateError: nested failure", "Error: original assertion", "Error: nested cause", "Error: cleanup failure", "SCREEN_MARKER", "Could not save failure report"]) {
        assert.ok(output.includes(marker), `${mode} child output omitted ${marker}`);
      }
      assert.ok(report, `${mode} child did not save its report`);
      assert.ok(Buffer.byteLength(report, "utf8") <= 65_536, `${mode} report exceeded its byte bound`);
      for (const marker of ["AggregateError: nested failure", "Error: original assertion", "Error: nested cause", "Error: cleanup failure", "SCREEN_MARKER"]) {
        assert.ok(report.includes(marker), `${mode} report omitted ${marker}`);
      }
      assert.equal(existsSync(path.join(directory, "missing", mode)), false);

      if (mode === "forced") {
        assert.ok(output.includes("FORCED_HANDLE_ACTIVE"));
        assert.ok(output.includes("FORCED_HANDLE_STILL_REFERENCED"));
        assert.doesNotMatch(output, /NATURAL_EXIT_HAS_NO_HELD_HANDLE/u);
      } else {
        assert.ok(output.includes("NATURAL_NO_HELD_HANDLE"));
        assert.ok(output.includes("NATURAL_EXIT_HAS_NO_HELD_HANDLE"));
        assert.doesNotMatch(output, /FORCED_HANDLE_STILL_REFERENCED/u);
      }
    }
  } catch (error) {
    failures.push(error);
  }

  const diagnostics = JSON.stringify({ node: process.version, observations }, null, 2) ?? "[]";
  const failureMessage = "runtime.system-scenario-failure did not complete cleanly";
  let failureReportDirectory: string | undefined;
  let reportedFailure: unknown;

  const captureFailureReport = async (errorsToReport: unknown[]): Promise<void> => {
    try {
      if (failureReportDirectory === undefined || !existsSync(failureReportDirectory)) {
        failureReportDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-scenario-failure-"));
      }
      try {
        throwScenarioFailure({
          directory: failureReportDirectory,
          message: failureMessage,
          errors: errorsToReport,
          diagnostics,
        });
      } catch (error) {
        reportedFailure = error;
        if (!existsSync(path.join(failureReportDirectory, "failure.txt"))) {
          try {
            await removeDirectoryEventually(failureReportDirectory);
            assert.equal(existsSync(failureReportDirectory), false, "An unsaved failure report directory must be removed");
          } catch (cleanupError) {
            failures.push(cleanupError);
            reportedFailure = new AggregateError(
              [...errorsToReport, error, cleanupError],
              `${failureMessage} and failure evidence cleanup failed`,
            );
          }
        }
      }
    } catch (error) {
      failures.push(error);
    }
  };

  if (failures.length > 0) {
    await captureFailureReport(failures);
  }

  const failuresBeforeCleanup = failures.length;
  let cleanupFailed = false;
  try {
    await removeDirectoryEventually(directory);
    assert.equal(existsSync(directory), false, "All owned fixture files must be removed");
  } catch (error) {
    failures.push(error);
    cleanupFailed = true;
  }

  if (failures.length > 0 && (failureReportDirectory === undefined || failures.length > failuresBeforeCleanup)) {
    await captureFailureReport(reportedFailure === undefined ? failures : [...failures, reportedFailure]);
  }

  if (cleanupFailed) {
    try {
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false, "All owned fixture files must be removed after saving failure evidence");
    } catch (error) {
      failures.push(error);
      await captureFailureReport(reportedFailure === undefined ? failures : [...failures, reportedFailure]);
    }
  }

  if (failureReportDirectory !== undefined && !existsSync(path.join(failureReportDirectory, "failure.txt"))) {
    try {
      await removeDirectoryEventually(failureReportDirectory);
      assert.equal(existsSync(failureReportDirectory), false, "An unsaved failure report directory must be removed");
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(reportedFailure === undefined ? failures : [...failures, reportedFailure], failureMessage);
  }
});
