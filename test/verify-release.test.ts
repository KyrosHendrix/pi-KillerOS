import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function npmCliPath(): string {
  const explicit = process.env.KILLEROS_TEST_NPM_CLI ?? process.env.npm_execpath;
  if (explicit) {
    assert.ok(existsSync(explicit), `Missing npm CLI: ${explicit}`);
    return explicit;
  }
  const directories = [path.dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)];
  for (const directory of directories) {
    for (const relative of ["node_modules/npm/bin/npm-cli.js", "../lib/node_modules/npm/bin/npm-cli.js"]) {
      const candidate = path.resolve(directory, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Cannot locate npm CLI. Set KILLEROS_TEST_NPM_CLI to its npm-cli.js path.");
}

test("publication lifecycle enforces the real validator exactly once with isolated npm dry-runs", { timeout: 300_000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "killeros-publication-lifecycle-"));
  const requests: string[] = [];
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
    const npmArgs = [npmCli, "--userconfig", userConfig, "--globalconfig", globalConfig,
      "--cache", path.join(directory, "cache"), "--registry", `http://127.0.0.1:${address.port}/`,
      "--fetch-retries=0", "--fetch-timeout=5000", "--loglevel=error"];

    async function run(cwd: string, args: string[], flags: NodeJS.ProcessEnv = {}) {
      const countFile = path.join(cwd, "invocations.txt");
      const child = spawn(process.execPath, [...npmArgs, ...args], {
        cwd, env: { ...env, GITHUB_ACTIONS: "", KILLEROS_RELEASE: "", KILLEROS_VALIDATOR_INVOCATIONS: countFile, ...flags },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
      // Full-suite Windows workers can delay npm startup. Keep the probe bounded without a 20-second startup race.
      const timer = setTimeout(() => child.kill(), 60_000);
      try {
        const status = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.notEqual(status, null, `npm ${args.join(" ")} was killed or timed out: ${stderr}`);
        const invocations = existsSync(countFile) ? readFileSync(countFile, "utf8").trim().split("\n") : [];
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
      await t.test(label, async () => {
        const result = await run(publicationFixture(label, overrides), ["publish", ".", "--dry-run", "--ignore-scripts=false"], flags);
        assert.deepEqual(result.invocations, [process.version], `${label}: one real validator invocation on the same Node`);
        if (error) {
          assert.notEqual(result.status, 0, label);
          assert.match(result.stderr, error, label);
        } else assert.equal(result.status, 0, result.stderr);
      });
    }
    await t.test("omitting explicit script enablement bypasses the validator", async () => {
      const result = await run(publicationFixture("omitted-override"), ["publish", ".", "--dry-run"], { npm_config_ignore_scripts: "true" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.invocations, []);
    });
    await t.test("tarball publication bypasses prepublishOnly even with scripts enabled", async () => {
      const cwd = publicationFixture("tarball");
      const packed = await run(cwd, ["pack", "--ignore-scripts"]);
      assert.equal(packed.status, 0, packed.stderr);
      const result = await run(cwd, ["publish", path.join(cwd, "killeros-2.1.31.tgz"), "--dry-run", "--ignore-scripts=false"]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.invocations, []);
    });
    assert.ok(requests.every((request) => request.startsWith("GET ")), `Unexpected publication or OIDC request: ${requests.join(", ")}`);
  } finally {
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
});
