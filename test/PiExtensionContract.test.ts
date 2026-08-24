import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Runs npm with isolated config and no implicit shell when npm exposes its entry point. */
function runNpm(args: string[], cwd: string, userConfig: string): string {
  const npmCli = process.env.npm_execpath;
  const env = { ...process.env };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  const npmArgs = ["--userconfig", userConfig, "--loglevel", "error", ...args];
  const options = { cwd, encoding: "utf8" as const, env };
  if (npmCli) return execFileSync(process.execPath, [npmCli, ...npmArgs], options);
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...npmArgs], options);
  }
  return execFileSync("npm", npmArgs, options);
}

test("the packed KillerOS package activates and reloads through Pi's public lifecycle", async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-pi-lifecycle-"));
  try {
    const packDirectory = path.join(directory, "pack");
    const consumerDirectory = path.join(directory, "consumer");
    const userConfig = path.join(directory, "empty.npmrc");
    mkdirSync(packDirectory);
    mkdirSync(consumerDirectory);
    writeFileSync(userConfig, "");
    runNpm([
      "pack",
      "--pack-destination",
      packDirectory,
    ], repositoryRoot, userConfig);
    const tarballs = readdirSync(packDirectory).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const tarball = path.join(packDirectory, tarballs[0]);
    writeFileSync(path.join(consumerDirectory, "package.json"), JSON.stringify({ private: true, type: "module" }));
    runNpm([
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--legacy-peer-deps",
      tarball,
    ], consumerDirectory, userConfig);
    const installedPackage = path.join(consumerDirectory, "node_modules", "killeros");
    assert.equal(existsSync(path.join(installedPackage, "Killeros.ts")), true);
    assert.equal(existsSync(path.join(installedPackage, "themes", "killeros.json")), true);

    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const lifecycle: string[] = [];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [installedPackage],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
        pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    const lifecycleErrors: string[] = [];
    try {
      await session.bindExtensions({
        mode: "json",
        shutdownHandler() {},
        onError(diagnostic) { lifecycleErrors.push(`${diagnostic.event}: ${diagnostic.error}`); },
      });
      const firstRunner = session.extensionRunner;
      const firstCommands = firstRunner.getRegisteredCommands().map(({ invocationName }) => invocationName);
      const oldContext = firstRunner.createContext();
      assert.equal(firstRunner.hasHandlers("session_start"), true);
      assert.equal(firstRunner.hasHandlers("session_shutdown"), true);
      assert.equal(firstCommands.includes("goal"), true);
      assert.equal(new Set(firstCommands).size, firstCommands.length);

      await session.reload();

      const secondRunner = session.extensionRunner;
      const secondCommands = secondRunner.getRegisteredCommands().map(({ invocationName }) => invocationName);
      assert.notEqual(secondRunner, firstRunner);
      assert.throws(() => oldContext.mode, /stale/u);
      assert.deepEqual(secondCommands, firstCommands);
      assert.deepEqual(secondRunner.getCommandDiagnostics(), []);
      assert.deepEqual(lifecycle, ["start:startup", "shutdown:reload", "start:reload"]);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
