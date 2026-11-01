import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function isolatedFixtureEnvironment(directory: string, agentDirectory: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  env.PATH = inherited.get("path") ?? "";
  env.HOME = directory;
  env.USERPROFILE = directory;
  const appData = path.join(directory, "appdata");
  const localAppData = path.join(directory, "localappdata");
  const temporaryDirectory = path.join(directory, "tmp");
  const emptyGitConfig = path.join(directory, "empty-git-config");
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.TEMP = temporaryDirectory;
  env.TMP = temporaryDirectory;
  env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  env.GIT_CONFIG_SYSTEM = emptyGitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.PI_CODING_AGENT_DIR = agentDirectory;
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(emptyGitConfig, "");
  return env;
}

test("installed Pi rejects KillerOS activation on unsupported operating systems", { timeout: 90_000 }, async () => {
  type UnsupportedPlatform = "linux" | "darwin";
  type OwnedProcess = {
    platform: UnsupportedPlatform;
    cli: PiRpcProcess;
    result?: Awaited<ReturnType<PiRpcProcess["close"]>>;
  };
  const processes: OwnedProcess[] = [];
  const diagnostics: Partial<Record<"linux" | "darwin", string>> = {};
  let primaryFailure: unknown;
  let failed = false;
  const cleanupFailures: unknown[] = [];
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-platform-"));

  try {
    const cliPath = path.join(repositoryRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    for (const platform of ["linux", "darwin"] as const) {
      const fixtureDirectory = path.join(directory, platform);
      const projectDirectory = path.join(fixtureDirectory, "project");
      const agentDirectory = path.join(fixtureDirectory, "agent");
      mkdirSync(projectDirectory, { recursive: true });
      mkdirSync(agentDirectory, { recursive: true });

      const restorationFile = path.join(fixtureDirectory, "platform-restored.txt");
      const extension = path.join(fixtureDirectory, "platform-fixture.ts");
      writeFileSync(extension, `
        import { writeFileSync } from "node:fs";
        import Killeros from ${JSON.stringify(new URL("../Killeros.ts", import.meta.url).href)};
        export default function (pi) {
          const original = Object.getOwnPropertyDescriptor(process, "platform");
          if (!original) throw new Error("process.platform descriptor is unavailable");
          Object.defineProperty(process, "platform", { ...original, value: ${JSON.stringify(platform)} });
          try { Killeros(pi); }
          finally {
            Object.defineProperty(process, "platform", original);
            writeFileSync(${JSON.stringify(restorationFile)}, String(process.platform));
          }
        }
      `);

      const cli = new PiRpcProcess({
        cliPath,
        cwd: projectDirectory,
        args: ["--mode", "rpc", "--offline", "--approve", "--no-context-files", "--no-extensions", "--no-skills",
          "--no-prompt-templates", "--no-themes", "--no-mcp", "--extension", extension],
        env: isolatedFixtureEnvironment(fixtureDirectory, agentDirectory),
      });
      const owned: OwnedProcess = { platform, cli };
      processes.push(owned);

      const result = await cli.close(30_000);
      owned.result = result;
      const processDiagnostics = cli.diagnostics();
      diagnostics[platform] = processDiagnostics;
      assert.equal(result.forced, false, processDiagnostics);
      assert.equal(result.treeCleanupError, undefined, processDiagnostics);
      assert.equal(result.exit.code, 1, processDiagnostics);
      assert.equal(result.exit.signal, null, processDiagnostics);
      assert.equal((processDiagnostics.match(/KillerOS supports Windows only\./gu) ?? []).length, 1, processDiagnostics);
      assert.equal(readFileSync(restorationFile, "utf8"), process.platform,
        `${platform} fixture must confirm process.platform restoration before native exit`);
    }
  } catch (error) {
    failed = true;
    primaryFailure = error;
  } finally {
    for (const owned of processes) {
      if (owned.result) continue;
      try {
        const result = await owned.cli.close(30_000);
        owned.result = result;
        if (result.forced || result.treeCleanupError !== undefined || result.exit.code !== 1 || result.exit.signal !== null) {
          cleanupFailures.push(new Error(`${owned.platform} Pi cleanup was not an orderly native rejection: ${JSON.stringify(result)}`));
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await removeDirectoryEventually(directory);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (failed || cleanupFailures.length > 0) {
    const errors = [...(failed ? [primaryFailure] : []), ...cleanupFailures];
    let reportDirectory: string;
    try {
      reportDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-platform-failure-"));
    } catch (error) {
      throw new AggregateError([...errors, error], "Unsupported-platform scenario failed and could not create its report directory");
    }
    try {
      throwScenarioFailure({
        directory: reportDirectory,
        message: "Unsupported-platform scenario failed",
        errors,
        diagnostics: JSON.stringify({ platforms: diagnostics, processes: processes.map(({ platform, result }) => ({ platform, result })) }),
      });
    } catch (error) {
      if (!existsSync(path.join(reportDirectory, "failure.txt"))) {
        try {
          await removeDirectoryEventually(reportDirectory);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Unsupported-platform report cleanup failed");
        }
      }
      throw error;
    }
  }
});
