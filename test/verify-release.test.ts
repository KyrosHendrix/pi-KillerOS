import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/verify-release.ts", import.meta.url));
const RELEASE_ENV = { GITHUB_ACTIONS: "true", KILLEROS_RELEASE: "true" };

function fixture(overrides: { changelog?: string; lockVersion?: string; readme?: string } = {}): string {
  const directory = mkdtempSync(path.join(tmpdir(), "killeros-release-"));
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "killeros", version: "2.1.31" }));
  writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ version: overrides.lockVersion ?? "2.1.31", packages: { "": { version: overrides.lockVersion ?? "2.1.31" } } }));
  writeFileSync(path.join(directory, "CHANGELOG.md"), overrides.changelog ?? "## [Unreleased]\n\n## [2.1.31] - 2026-09-22\n");
  writeFileSync(path.join(directory, "README.md"), overrides.readme ?? "Pin a release by appending its tag, for example `@v2.1.31`.\n");
  return directory;
}

function verify(directory: string, env: NodeJS.ProcessEnv = RELEASE_ENV) {
  return spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
    cwd: directory,
    env: { ...isolatedAcceptEnvironment(directory), GITHUB_ACTIONS: "", KILLEROS_RELEASE: "", ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

const ACCEPT_SCENARIO_ID = "runtime.system-release-validator-accept";
const ACCEPT_SCENARIO_TITLE = "release validator accepts complete and README-pinned metadata";
const MAXIMUM_DIAGNOSTIC_LENGTH = 2_000;

type AcceptVector = {
  readonly label: string;
  readonly readme: string;
};

type AcceptObservation = {
  readonly label: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: string | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly fixtureRemoved: boolean;
};

/** Builds a child environment without inherited npm, proxy, or credential settings. */
function isolatedAcceptEnvironment(directory: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {
    PATH: path.dirname(process.execPath),
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    GITHUB_ACTIONS: "true",
    KILLEROS_RELEASE: "true",
  };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  return env;
}

type AcceptResult = ReturnType<typeof verify>;

function boundedText(value: string): string {
  return value.slice(0, MAXIMUM_DIAGNOSTIC_LENGTH);
}

function writeAcceptFixture(directory: string, readme: string): void {
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "killeros", version: "2.1.31" }));
  writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({ version: "2.1.31", packages: { "": { version: "2.1.31" } } }));
  writeFileSync(path.join(directory, "CHANGELOG.md"), "## [Unreleased]\n\n## [2.1.31] - 2026-09-22\n");
  writeFileSync(path.join(directory, "README.md"), readme);
}

// Catalog ID: runtime.system-release-validator-accept.
test(ACCEPT_SCENARIO_TITLE, { timeout: 120_000 }, async (t) => {
  const repositoryReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string");
  const readmeWithPins = repositoryReadme.replaceAll(manifest.version, "2.1.31");
  assert.match(readmeWithPins, /`npm:killeros@2\.1\.31`/u, `${ACCEPT_SCENARIO_ID}: README must document the npm release pin`);
  assert.match(readmeWithPins, /`git:github\.com\/KyrosHendrix\/pi-KillerOS@v2\.1\.31`/u, `${ACCEPT_SCENARIO_ID}: README must document the Git release pin`);
  const vectors: AcceptVector[] = [
    {
      label: "complete matching metadata",
      readme: "Pin a release by appending its tag, for example `@v2.1.31`.\n",
    },
    {
      label: "real README npm and Git pinned examples",
      readme: readmeWithPins,
    },
    {
      label: "current npm and Git pins wrapped onto separate lines",
      readme: "Pin with\n`npm:killeros@2.1.31` or\n`git:github.com/KyrosHendrix/pi-KillerOS@v2.1.31`.\n",
    },
  ];
  const errors: unknown[] = [];
  const observations: AcceptObservation[] = [];

  for (const vector of vectors) {
    let directory: string | undefined;
    let result: AcceptResult | undefined;
    let fixtureRemoved = false;
    try {
      directory = mkdtempSync(path.join(tmpdir(), "killeros-release-accept-"));
      writeAcceptFixture(directory, vector.readme);
      result = verify(directory);
      assert.equal(result.error, undefined, `${ACCEPT_SCENARIO_ID}: ${vector.label} must exit without a spawn error or timeout`);
      assert.equal(result.signal, null, `${ACCEPT_SCENARIO_ID}: ${vector.label} must exit naturally`);
      assert.equal(result.status, 0,
        `${ACCEPT_SCENARIO_ID}: ${vector.label} must be accepted; stderr=${boundedText(result.stderr)}`);
    } catch (error) {
      errors.push(error);
    } finally {
      if (directory !== undefined) {
        try {
          await removeDirectoryEventually(directory);
        } catch (error) {
          errors.push(error);
        }
        fixtureRemoved = !existsSync(directory);
        if (!fixtureRemoved) errors.push(new Error(`${ACCEPT_SCENARIO_ID}: ${vector.label} fixture directory must not survive`));
      }
    }
    observations.push({
      label: vector.label,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      spawnError: result?.error?.message,
      stdout: boundedText(result?.stdout ?? ""),
      stderr: boundedText(result?.stderr ?? ""),
      fixtureRemoved,
    });
  }

  if (errors.length === 0) {
    t.diagnostic(JSON.stringify({ scenarioId: ACCEPT_SCENARIO_ID, vectors: observations,
      piLaunches: 0, validatorLaunches: vectors.length, cleanup: "natural" }));
    return;
  }

  let failureDirectory: string;
  try {
    failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-${ACCEPT_SCENARIO_ID}-`));
  } catch (error) {
    throw new AggregateError([...errors, error], `${ACCEPT_SCENARIO_ID} could not create failure evidence`);
  }

  try {
    throwScenarioFailure({
      directory: failureDirectory,
      message: `${ACCEPT_SCENARIO_ID} failed`,
      errors,
      diagnostics: JSON.stringify({
        scenario: ACCEPT_SCENARIO_ID,
        node: process.version,
        executable: process.execPath,
        platform: process.platform,
        vectors: observations,
      }).slice(0, 32_768),
    });
  } catch (error) {
    if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
      try {
        await removeDirectoryEventually(failureDirectory);
      } catch (cleanupError) {
        throw new AggregateError([...errors, error, cleanupError], `${ACCEPT_SCENARIO_ID} failed and failure evidence cleanup failed`);
      }
    }
    throw error;
  }
});

// Catalog ID: runtime.system-release-validator-reject.
test("release validator rejects direct publication and identity drift", { timeout: 120_000 }, async (t) => {
  const cases = [
    { label: "outside the release workflow", overrides: {}, env: {}, error: /only the verified GitHub release workflow may publish/iu },
    { label: "mismatched lockfile", overrides: { lockVersion: "2.1.30" }, env: RELEASE_ENV, error: /versions do not match/iu },
    { label: "missing changelog section", overrides: { changelog: "## [Unreleased]\n" }, env: RELEASE_ENV, error: /CHANGELOG\.md has no section/iu },
    { label: "stale npm pin", overrides: { readme: "To pin a release, use `npm:killeros@2.1.30` or append a Git tag such as `@v2.1.31` to the Git source.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "stale Git pin", overrides: { readme: "To pin a release, use `npm:killeros@2.1.31` or append a Git tag such as `@v2.1.30` to the Git source.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "Git pin with different build metadata", overrides: { readme: "Pin with `npm:killeros@2.1.31` or `git:github.com/KyrosHendrix/pi-KillerOS@v2.1.31+old`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "npm pin with different build metadata", overrides: { readme: "Pin with `npm:killeros@2.1.31+old` or `@v2.1.31`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "stale wrapped Git pin", overrides: { readme: "Pin with\n`npm:killeros@2.1.31` or\n`git:github.com/KyrosHendrix/pi-KillerOS@v2.1.30`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "stale wrapped npm pin", overrides: { readme: "Pin with\n`npm:killeros@2.1.30` or\n`git:github.com/KyrosHendrix/pi-KillerOS@v2.1.31`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "missing pins", overrides: { readme: "Install with `pi install npm:killeros`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "stale README tag", overrides: { readme: "Pin a release by appending its tag, for example `@v2.1.30`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
    { label: "current version elsewhere but stale pinned example", overrides: { readme: "Current version @v2.1.31.\nPin a release by appending its tag, for example `@v2.1.30`.\n" }, env: RELEASE_ENV, error: /README\.md does not reference/iu },
  ];

  const errors: unknown[] = [];
  const observations: AcceptObservation[] = [];
  for (const { label, overrides, env, error } of cases) {
    let directory: string | undefined;
    let result: AcceptResult | undefined;
    let fixtureRemoved = false;
    try {
      directory = fixture(overrides);
      result = verify(directory, env);
      assert.equal(result.error, undefined, `${label}: no spawn error or timeout`);
      assert.equal(result.signal, null, `${label}: validator exits naturally`);
      assert.equal(result.status, 1, `${label}: validator explicitly rejects the input`);
      assert.equal(result.stdout, "", `${label}: no success output`);
      assert.match(result.stderr, error, label);
    } catch (error) {
      errors.push(error);
    } finally {
      if (directory !== undefined) {
        try {
          await removeDirectoryEventually(directory);
          assert.equal(existsSync(directory), false, `${label}: no fixture survives`);
          fixtureRemoved = true;
        } catch (error) {
          errors.push(error);
        }
      }
    }
    observations.push({ label, status: result?.status ?? null, signal: result?.signal ?? null,
      spawnError: result?.error?.message, stdout: boundedText(result?.stdout ?? ""),
      stderr: boundedText(result?.stderr ?? ""), fixtureRemoved });
  }
  if (errors.length > 0) {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-release-reject-failure-"));
    throwScenarioFailure({ directory, message: "runtime.system-release-validator-reject failed", errors,
      diagnostics: JSON.stringify({ node: process.version, platform: process.platform, vectors: observations }) });
  }
  assert.equal(observations.length, 12, "every invalid source vector executed");
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.system-release-validator-reject", vectors: observations,
    piLaunches: 0, validatorLaunches: cases.length, cleanup: "natural" }));
});

function npmCliPath(): string {
  const explicit = process.env.KILLEROS_TEST_NPM_CLI ?? process.env.npm_execpath;
  if (explicit) {
    assert.ok(existsSync(explicit), `Missing npm CLI: ${explicit}`);
    return explicit;
  }
  const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)];
  for (const directory of directories) {
    const candidate = path.resolve(directory, "node_modules/npm/bin/npm-cli.js");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Cannot locate npm CLI. Set KILLEROS_TEST_NPM_CLI to its npm-cli.js path.");
}

// Catalog ID: runtime.system-publication-lifecycle.
test("publication lifecycle invokes the real validator exactly once and blocks direct publish", { timeout: 300_000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "killeros-publication-lifecycle-"));
  const requests: string[] = [];
  const errors: unknown[] = [];
  const npmRuns: Array<{ pid: number | undefined; args: string[]; status: number | null; validators: number }> = [];
  let processEvidence: unknown = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(request.method === "GET" ? 404 : 403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Local test registry rejects writes" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const npmCli = npmCliPath();
    const userConfig = path.join(directory, "user.npmrc");
    const globalConfig = path.join(directory, "global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const preload = path.join(directory, "count.mjs");
    const processManifest = path.join(directory, "node-processes.jsonl");
    const forbiddenEnvironment = {
      NPM_ID_TOKEN: "synthetic-inherited-token",
      NPM_TOKEN: "synthetic-inherited-token",
      NODE_AUTH_TOKEN: "synthetic-inherited-token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-inherited-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:1/oidc",
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      npm_config_ignore_scripts: "true",
    };
    writeFileSync(preload, `
      import assert from "node:assert/strict";
      import { appendFileSync } from "node:fs";
      import path from "node:path";
      appendFileSync(process.env.KILLEROS_NODE_PROCESS_MANIFEST, JSON.stringify({
        pid: process.pid, parentPid: process.ppid, entrypoint: path.basename(process.argv[1] ?? ""),
        runId: process.env.KILLEROS_LIFECYCLE_RUN_ID, node: process.version,
      }) + "\\n");
      for (const key of ${JSON.stringify(Object.keys(forbiddenEnvironment).filter((key) => key !== "npm_config_ignore_scripts"))}) {
        assert.equal(process.env[key], undefined, "Publication probe inherited " + key);
      }
      if (process.argv[1] && path.basename(process.argv[1]) === "verify-release.ts") {
        appendFileSync(process.env.KILLEROS_VALIDATOR_INVOCATIONS, process.version + "\\n");
      }
    `);
    // Seed synthetic inherited settings to prove filtering through the real npm and validator processes.
    // Allow only OS process-launch variables. Never inherit npm config, proxies, credentials, or OIDC.
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries({ ...process.env, ...forbiddenEnvironment })) {
      if (["systemroot", "comspec", "temp", "tmp"].includes(key.toLowerCase())) env[key] = value;
    }
    env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
    env.HOME = directory;
    env.USERPROFILE = directory;
    env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    env.KILLEROS_NODE_PROCESS_MANIFEST = processManifest;
    const npmArgs = [npmCli, "--userconfig", userConfig, "--globalconfig", globalConfig,
      "--cache", path.join(directory, "cache"), "--registry", `http://127.0.0.1:${address.port}/`,
      "--fetch-retries=0", "--fetch-timeout=5000", "--loglevel=error"];

    async function run(cwd: string, args: string[], flags: NodeJS.ProcessEnv = {}) {
      const countFile = path.join(cwd, "invocations.txt");
      const child = spawn(process.execPath, [...npmArgs, ...args], {
        cwd, env: { ...env, GITHUB_ACTIONS: "", KILLEROS_RELEASE: "", KILLEROS_VALIDATOR_INVOCATIONS: countFile,
          KILLEROS_LIFECYCLE_RUN_ID: String(npmRuns.length), ...flags },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let outputOverflow = false;
      let timedOut = false;
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > 32_768) { outputOverflow = true; stdout = stdout.slice(-32_768); }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > 32_768) { outputOverflow = true; stderr = stderr.slice(-32_768); }
      });
      // The deadline bounds failure; process close, not elapsed silence, completes each vector.
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
      try {
        const status = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(timedOut, false, `npm ${args.join(" ")} exceeded its owned process deadline; descendant cleanup is unconfirmed`);
        assert.notEqual(status, null, `npm ${args.join(" ")} was killed: ${stderr}`);
        assert.equal(outputOverflow, false, `npm ${args.join(" ")} exceeded the bounded output limit`);
        const invocations = existsSync(countFile) ? readFileSync(countFile, "utf8").trim().split("\n") : [];
        npmRuns.push({ pid: child.pid, args, status, validators: invocations.length });
        return { status, stdout, stderr, invocations };
      } finally {
        clearTimeout(timer);
      }
    }

    const version = await run(directory, ["--version"]);
    assert.equal(version.status, 0, version.stderr);
    if (process.env.KILLEROS_TEST_NPM_CLI) {
      const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
      const pinned = /npm install --global npm@(\d+\.\d+\.\d+)/u.exec(release)?.[1];
      assert.ok(pinned, "Release workflow must pin publishing npm");
      assert.equal(version.stdout.trim(), pinned, "Lifecycle probe must use release-pinned npm");
    }
    t.diagnostic(`Lifecycle subprocess uses Node ${process.version}, npm ${version.stdout.trim()}`);
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && "scripts" in manifest);
    const scripts = manifest.scripts;
    assert.ok(typeof scripts === "object" && scripts !== null && "prepublishOnly" in scripts);
    const prepublishOnly = scripts.prepublishOnly;
    assert.ok(typeof prepublishOnly === "string");

    function publicationFixture(label: string, overrides: { lockVersion?: string; rootVersion?: string; changelog?: string; readme?: string } = {}): string {
      const cwd = path.join(directory, label);
      mkdirSync(path.join(cwd, "scripts"), { recursive: true });
      copyFileSync(SCRIPT, path.join(cwd, "scripts", "verify-release.ts"));
      copyFileSync(fileURLToPath(new URL("../scripts/release-notes.ts", import.meta.url)), path.join(cwd, "scripts", "release-notes.ts"));
      writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "killeros", version: "2.1.31", type: "module", scripts: { prepublishOnly } }));
      writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ version: overrides.lockVersion ?? "2.1.31", packages: { "": { version: overrides.rootVersion ?? "2.1.31" } } }));
      writeFileSync(path.join(cwd, "CHANGELOG.md"), overrides.changelog ?? "## [Unreleased]\n\n## [2.1.31] - 2026-09-22\n");
      writeFileSync(path.join(cwd, "README.md"), overrides.readme ?? "Pin a release by appending its tag, for example `@v2.1.31`.\n");
      return cwd;
    }

    const authorized = { GITHUB_ACTIONS: "true", KILLEROS_RELEASE: "true" };
    const cases: Array<{ label: string; overrides: Parameters<typeof publicationFixture>[1]; flags: NodeJS.ProcessEnv; error: RegExp | null }> = [
      { label: "unauthorized", overrides: {}, flags: {}, error: /Only the verified/u },
      { label: "unauthorized-inherited-ignore", overrides: {}, flags: { npm_config_ignore_scripts: "true" }, error: /Only the verified/u },
      { label: "missing-release-flag", overrides: {}, flags: { GITHUB_ACTIONS: "true" }, error: /Only the verified/u },
      { label: "missing-actions-flag", overrides: {}, flags: { KILLEROS_RELEASE: "true" }, error: /Only the verified/u },
      { label: "valid", overrides: {}, flags: authorized, error: null },
      { label: "valid-inherited-ignore", overrides: {}, flags: { ...authorized, npm_config_ignore_scripts: "true" }, error: null },
      { label: "lock-mismatch", overrides: { lockVersion: "2.1.30" }, flags: authorized, error: /versions do not match/u },
      { label: "root-mismatch", overrides: { rootVersion: "2.1.30" }, flags: authorized, error: /versions do not match/u },
      { label: "missing-changelog", overrides: { changelog: "## [Unreleased]\n" }, flags: authorized, error: /has no section/u },
      { label: "stale-readme", overrides: { readme: "Current version @v2.1.31.\nPin a release by appending its tag, for example `@v2.1.30`.\n" }, flags: authorized, error: /does not reference/u },
    ];
    for (const { label, overrides, flags, error } of cases) {
      const result = await run(publicationFixture(label, overrides), ["publish", ".", "--dry-run", "--ignore-scripts=false"], flags);
      assert.deepEqual(result.invocations, [process.version], `${label}: one real validator invocation on the same Node`);
      if (error) {
        assert.notEqual(result.status, 0, label);
        assert.match(result.stderr, error, label);
      } else assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      t.diagnostic(`runtime.system-publication-lifecycle completed ${label}`);
    }
    const omitted = await run(publicationFixture("omitted-override"), ["publish", ".", "--dry-run"], { npm_config_ignore_scripts: "true" });
    assert.equal(omitted.status, 0, `omitting explicit script enablement: ${omitted.stderr}`);
    assert.deepEqual(omitted.invocations, [], "omitting explicit script enablement bypasses the validator");
    const tarballDirectory = publicationFixture("tarball");
    const packed = await run(tarballDirectory, ["pack", "--ignore-scripts"]);
    assert.equal(packed.status, 0, `tarball preparation: ${packed.stderr}`);
    assert.deepEqual(packed.invocations, [], "packing with scripts disabled does not invoke the validator");
    const tarball = await run(tarballDirectory, ["publish", path.join(tarballDirectory, "killeros-2.1.31.tgz"), "--dry-run", "--ignore-scripts=false"]);
    assert.equal(tarball.status, 0, `tarball publication: ${tarball.stderr}`);
    assert.deepEqual(tarball.invocations, [], "tarball publication bypasses prepublishOnly even with scripts enabled");
    t.diagnostic("runtime.system-publication-lifecycle completed both bypass controls");
    assert.ok(requests.every((request) => request.startsWith("GET ")), `Unexpected publication or OIDC request: ${requests.join(", ")}`);
    const nodeProcesses = readFileSync(processManifest, "utf8").trim().split("\n").map((line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(typeof value === "object" && value !== null && "pid" in value && "parentPid" in value
        && "entrypoint" in value && "node" in value && "runId" in value, "each real Node child records its identity");
      assert.ok(typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0);
      assert.ok(typeof value.parentPid === "number" && Number.isInteger(value.parentPid) && value.parentPid > 0);
      assert.ok(typeof value.entrypoint === "string");
      assert.ok(typeof value.runId === "string" && /^\d+$/u.test(value.runId));
      assert.equal(value.node, process.version, "every nested Node process uses the same pinned executable");
      return { pid: value.pid, parentPid: value.parentPid, entrypoint: value.entrypoint, runId: Number(value.runId) };
    });
    processEvidence = nodeProcesses;
    assert.equal(npmRuns.length, 14, "one version probe, ten guarded publishes, two bypasses, and one pack");
    assert.equal(nodeProcesses.length, 24, "all fourteen npm processes and ten real validators are accounted for");
    assert.equal(nodeProcesses.filter((child) => child.entrypoint === "npm-cli.js").length, 14);
    const validators = nodeProcesses.filter((child) => child.entrypoint === "verify-release.ts");
    assert.equal(validators.length, 10);
    // Windows reuses PIDs between histories; count observed launches, not globally unique PID numbers.
    for (const [runId, run] of npmRuns.entries()) {
      const owned = nodeProcesses.filter((child) => child.runId === runId);
      const npmRoot = owned.filter((child) => child.entrypoint === "npm-cli.js");
      assert.equal(npmRoot.length, 1, `run ${runId}: exactly one npm root`);
      assert.equal(npmRoot[0]?.pid, run.pid, `run ${runId}: preload observes the actual spawned npm child`);
      assert.equal(npmRoot[0]?.parentPid, process.pid, `run ${runId}: npm belongs to this runner`);
      const nested = owned.filter((child) => child.entrypoint === "verify-release.ts");
      assert.equal(nested.length, run.validators, `run ${runId}: every validator invocation has a process record`);
      assert.ok(nested.every((child) => child.parentPid !== run.pid), `run ${runId}: npm launches validators through a script shell`);
    }
    t.diagnostic(JSON.stringify({ scenarioId: "runtime.system-publication-lifecycle", piLaunches: 0,
      npmLaunches: npmRuns.length, validatorLaunches: validators.length, shellLaunches: validators.length,
      totalChildLaunches: nodeProcesses.length + validators.length, guardedVectors: cases.length,
      bypassVectors: 2, registryRequests: requests, processes: nodeProcesses }));
  } catch (error) {
    errors.push(error);
  }
  try {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  } catch (error) {
    errors.push(error);
  }
  try {
    await removeDirectoryEventually(directory);
    assert.equal(existsSync(directory), false, "publication fixture and isolated npm cache must be removed");
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    const failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-publication-failure-"));
    throwScenarioFailure({ directory: failureDirectory, message: "runtime.system-publication-lifecycle failed", errors,
      diagnostics: JSON.stringify({ node: process.version, platform: process.platform, requests,
        npmRuns, processes: processEvidence, fixtureRemoved: !existsSync(directory) }) });
  }
  t.diagnostic("runtime.system-publication-lifecycle cleanup completed");
});
