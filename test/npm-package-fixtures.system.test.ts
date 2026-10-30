import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

type NpmRun = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ObservedRun = {
  readonly label: string;
  readonly args: readonly string[];
  readonly result: NpmRun;
};

const npmConfigArguments = (userConfig: string, globalConfig: string, args: readonly string[]): string[] => [
  "--userconfig", userConfig,
  "--globalconfig", globalConfig,
  "--loglevel", "error",
  ...args,
];

/** Locates npm-cli.js without consulting npm_execpath, matching how npm resolves when the variable is unset. */
function findNpmCli(): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  const directories = new Set([path.dirname(process.execPath), ...pathValue.split(path.delimiter)]);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Builds a child environment that owns its home, caches, and Git configuration instead of inheriting the runner's. */
function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = inherited.get("path") ?? "";
  environment.HOME = directory;
  environment.USERPROFILE = directory;
  environment.APPDATA = path.join(directory, "appdata");
  environment.LOCALAPPDATA = path.join(directory, "localappdata");
  const temporaryDirectory = path.join(directory, "tmp");
  const emptyGitConfig = path.join(directory, "empty-git-config");
  environment.TEMP = temporaryDirectory;
  environment.TMP = temporaryDirectory;
  environment.GIT_CONFIG_GLOBAL = emptyGitConfig;
  environment.GIT_CONFIG_SYSTEM = emptyGitConfig;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.npm_config_cache = path.join(directory, "npm-cache");
  environment.npm_config_update_notifier = "false";
  mkdirSync(environment.APPDATA, { recursive: true });
  mkdirSync(environment.LOCALAPPDATA, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(emptyGitConfig, "");
  return environment;
}

/** Runs the real npm CLI as an owned child and reports its natural exit instead of throwing on a nonzero status. */
function runNpm(options: {
  npmCli: string;
  args: readonly string[];
  cwd: string;
  userConfig: string;
  globalConfig: string;
  environment: NodeJS.ProcessEnv;
}): Promise<NpmRun> {
  const environment = { ...options.environment };
  delete environment.npm_config_allow_scripts;
  delete environment.NPM_CONFIG_ALLOW_SCRIPTS;
  const args = [options.npmCli, ...npmConfigArguments(options.userConfig, options.globalConfig, options.args)];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: environment,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, signal: null, stdout, stderr });
        return;
      }
      if (typeof error.code === "number" || error.signal !== undefined) {
        resolve({
          code: typeof error.code === "number" ? error.code : null,
          signal: error.signal ?? null,
          stdout,
          stderr,
        });
        return;
      }
      reject(error instanceof Error ? error : new Error("npm child failed to start", { cause: error }));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPackFile(value: unknown): value is { path: string } {
  return isRecord(value) && typeof value.path === "string";
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated ${text.length - limit} characters]`;
}

function runSummary(run: ObservedRun): Record<string, unknown> {
  return {
    label: run.label,
    args: run.args,
    code: run.result.code,
    signal: run.result.signal,
    stdout: run.label.startsWith("npm pack") ? bounded(run.result.stdout, 2_000) : "<omitted>",
    stderr: bounded(run.result.stderr, 2_000),
  };
}

test("npm package fixtures preserve shell-special paths without npm_execpath", { timeout: 90_000 }, async (t) => {
  const scenario = "npm-package-fixtures";
  const sourceScenarioId = "test/PiExtensionContract.test.ts:138#1";
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-npm-fixture & literal-"));
  const userConfig = path.join(directory, "empty & literal.npmrc");
  const globalConfig = `${userConfig}.global`;
  const observedRuns: ObservedRun[] = [];
  let npmCli: string | undefined;
  let primaryFailure: { error: unknown } | undefined;
  const cleanupFailures: unknown[] = [];

  const diagnostics = (): string => JSON.stringify({
    scenario,
    sourceScenarioId,
    platform: process.platform,
    node: process.version,
    repositoryRoot,
    directory,
    userConfig,
    globalConfig,
    npmCli,
    runs: observedRuns.map(runSummary),
  }, null, 2).slice(-50_000);

  t.diagnostic(`private npm fixture directory: ${directory}`);

  try {
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    assert.ok(directory.includes("&") && directory.includes(" "), "The fixture directory must contain an ampersand and a space");
    assert.ok(userConfig.includes("&") && userConfig.includes(" "), "The user config path must contain an ampersand and a space");

    npmCli = findNpmCli();
    assert.ok(npmCli, "Cannot locate npm-cli.js without npm_execpath; install npm beside Node or on PATH");

    const environment = isolatedEnvironment(directory);
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === "npm_execpath") delete environment[key];
    }
    assert.equal(Object.keys(environment).some((key) => key.toLowerCase() === "npm_execpath"), false,
      "The npm child environment must omit npm_execpath");

    const configRun = await runNpm({
      npmCli, args: ["config", "list", "--json"], cwd: repositoryRoot, userConfig, globalConfig, environment,
    });
    observedRuns.push({ label: "npm config list --json", args: ["config", "list", "--json"], result: configRun });
    assert.equal(configRun.code, 0, `npm config list --json did not exit with code 0: ${diagnostics()}`);
    assert.equal(configRun.signal, null, `npm config list --json was terminated: ${diagnostics()}`);
    const effectiveConfig: unknown = JSON.parse(configRun.stdout);
    assert.ok(isRecord(effectiveConfig), `npm config list --json must return an object: ${diagnostics()}`);
    assert.ok(isString(effectiveConfig.userconfig), `npm config list must report userconfig: ${diagnostics()}`);
    assert.equal(path.resolve(effectiveConfig.userconfig), path.resolve(userConfig),
      `npm must preserve the exact shell-special userconfig path: ${diagnostics()}`);
    assert.ok(effectiveConfig.userconfig.includes("&") && effectiveConfig.userconfig.includes(" "),
      `npm must return the raw ampersand and space in the userconfig path: ${diagnostics()}`);
    assert.ok(isString(effectiveConfig.globalconfig), `npm config list must report globalconfig: ${diagnostics()}`);
    assert.equal(path.resolve(effectiveConfig.globalconfig), path.resolve(globalConfig),
      `npm must preserve the exact shell-special globalconfig path: ${diagnostics()}`);

    const packRun = await runNpm({
      npmCli, args: ["pack", "--dry-run", "--ignore-scripts", "--json"], cwd: repositoryRoot, userConfig, globalConfig, environment,
    });
    observedRuns.push({ label: "npm pack --dry-run --ignore-scripts --json", args: ["pack", "--dry-run", "--ignore-scripts", "--json"], result: packRun });
    assert.equal(packRun.code, 0, `npm pack --dry-run did not exit with code 0: ${diagnostics()}`);
    assert.equal(packRun.signal, null, `npm pack --dry-run was terminated: ${diagnostics()}`);

    const packed: unknown = JSON.parse(packRun.stdout);
    assert.ok(isUnknownArray(packed), `npm pack --json must return an array: ${diagnostics()}`);
    assert.equal(packed.length, 1, `npm pack --json must return exactly one package object: ${diagnostics()}`);
    const descriptor = packed[0];
    assert.ok(isRecord(descriptor), `npm pack --json must return a package record: ${diagnostics()}`);

    const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.ok(isRecord(manifest), "The repository package manifest must be an object");
    assert.ok(isString(manifest.name), "The repository package manifest must contain a name");
    assert.ok(isString(manifest.version), "The repository package manifest must contain a version");
    assert.equal(descriptor.id, `killeros@${manifest.version}`, `Unexpected packed package identity: ${diagnostics()}`);
    assert.equal(descriptor.name, manifest.name, `Unexpected packed package name: ${diagnostics()}`);
    assert.equal(descriptor.version, manifest.version, `Unexpected packed package version: ${diagnostics()}`);

    assert.ok(isUnknownArray(descriptor.files), `npm pack --json must report package files: ${diagnostics()}`);
    const packedFiles = descriptor.files.map((file) => {
      assert.ok(isPackFile(file), `npm pack file entries must carry string paths: ${diagnostics()}`);
      return file.path;
    });
    for (const required of ["package.json", "Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
      assert.ok(packedFiles.includes(required), `The packed file list must include ${required}: ${diagnostics()}`);
    }
  } catch (error) {
    primaryFailure = { error };
  } finally {
    try {
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false, "The private npm fixture directory must be removed");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    const errors = [...(primaryFailure === undefined ? [] : [primaryFailure.error]), ...cleanupFailures];
    let reportDirectory: string;
    try {
      reportDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-npm-fixture-failure-"));
    } catch (error) {
      throw new AggregateError([...errors, error], "npm package fixture scenario failed and could not create its report directory");
    }
    try {
      throwScenarioFailure({
        directory: reportDirectory,
        message: "npm package fixture scenario failed",
        errors,
        diagnostics: diagnostics(),
      });
    } catch (reportError) {
      try {
        if (existsSync(reportDirectory) && readdirSync(reportDirectory).length === 0) {
          await removeDirectoryEventually(reportDirectory);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [...errors, reportError, cleanupError],
          "npm package fixture scenario failed and its empty failure report could not be cleaned up",
        );
      }
      throw reportError;
    }
  }
});
