import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenarioId = "runtime.print-json-trust";
const personalMarker = "KILLEROS_NONINTERACTIVE_PERSONAL";

type OutputMode = "print" | "json";

type ProviderObservation = {
  step: number;
  lastRole: unknown;
  personalMarkerCount: number;
  toolNames: string[];
  questionErrorObserved: boolean;
};

type HistoryResult = {
  mode: OutputMode;
  trusted: boolean;
  fixtureDirectory: string;
  providerRequests: number;
  piLaunches: number;
  naturalExits: number;
  fixtureGitInitializations: number;
  gitCommands: number;
  sessionEntries: number;
  jsonSettlementObserved: boolean;
  observations: ProviderObservation[];
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isolatedFixtureEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  env.PATH = inherited.get("path") ?? "";
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.APPDATA = path.join(directory, "appdata");
  env.LOCALAPPDATA = path.join(directory, "localappdata");
  const temporaryDirectory = path.join(directory, "tmp");
  const emptyGitConfig = path.join(directory, "empty-git-config");
  env.TEMP = temporaryDirectory;
  env.TMP = temporaryDirectory;
  env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  env.GIT_CONFIG_SYSTEM = emptyGitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(emptyGitConfig, "");
  return env;
}

function initializeFixtureRepository(
  project: string,
  env: NodeJS.ProcessEnv,
  counts: { fixtureGitInitializations: number; gitCommands: number },
): void {
  const programFiles = process.env.ProgramFiles;
  assert.ok(programFiles, "The fixture requires the installed Windows Git executable");
  const git = path.join(programFiles, "Git", "cmd", "git.exe");
  assert.ok(existsSync(git), "The fixture requires Git at the standard Windows installation path");
  assert.ok(path.isAbsolute(git));

  const gitEnv: NodeJS.ProcessEnv = { ...env, PATH: "", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  for (const key of [
    "GIT_DIR", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_WORK_TREE", "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
  ]) {
    delete gitEnv[key];
  }

  counts.gitCommands += 1;
  execFileSync(git, ["init", "--quiet"], { cwd: project, env: gitEnv, timeout: 15_000 });
  counts.fixtureGitInitializations += 1;
  counts.gitCommands += 1;
  const discoveredRoot = realpathSync.native(execFileSync(git, ["rev-parse", "--show-toplevel"], {
    cwd: project,
    env: gitEnv,
    encoding: "utf8",
    timeout: 15_000,
  }).trim());
  const fixtureRoot = realpathSync.native(project);
  const gitRelativeToProject = path.relative(fixtureRoot, realpathSync.native(git));
  assert.ok(gitRelativeToProject === ".." || gitRelativeToProject.startsWith(`..${path.sep}`)
    || path.isAbsolute(gitRelativeToProject), "Fixture Git must resolve outside the project");
  assert.equal(discoveredRoot.toLowerCase(), fixtureRoot.toLowerCase(),
    "Fixture Git commands must resolve to the disposable project root");
}

function sessionEntries(session: string): unknown[] {
  if (!existsSync(session)) return [];
  const contents = readFileSync(session, "utf8").trim();
  if (!contents) return [];
  return contents.split(/\r?\n/u).map((line) => {
    const value: unknown = JSON.parse(line);
    return value;
  });
}

function assertNoGoalOrCompactionEntries(entries: unknown[]): void {
  assert.equal(entries.some((entry) => isUnknownRecord(entry)
    && (entry.customType === "killeros-goal" || entry.customType === "unexpected-noninteractive-compaction")), false);
}

async function runHistory(mode: OutputMode, trusted: boolean, signal: AbortSignal): Promise<HistoryResult> {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-print-json-"));
  let server: Server | undefined;
  let project = "";
  let agentDir = "";
  let session = "";
  let env: NodeJS.ProcessEnv = {};
  let args: string[] = [];
  let failure: unknown;
  let failed = false;
  const cleanupFailures: unknown[] = [];
  const observations: ProviderObservation[] = [];
  const faults: string[] = [];
  let providerRequests = 0;
  let piLaunches = 0;
  let naturalExits = 0;
  let sessionEntryCount = 0;
  let jsonSettlementObserved = false;
  const gitActivity = { fixtureGitInitializations: 0, gitCommands: 0 };

  try {
    project = path.join(directory, "project");
    agentDir = path.join(directory, "agent");
    session = path.join(directory, "session.jsonl");
    const probe = path.join(directory, "probe.ts");
    mkdirSync(project);
    mkdirSync(agentDir);
    assert.equal(existsSync(session), false, "Each history must start with a new session");

    writeFileSync(path.join(project, "AGENTS.local.md"), personalMarker);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      retry: { enabled: false },
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    }));
    writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
    writeFileSync(probe, `export default function(pi) { pi.on("session_before_compact", () => {
  pi.appendEntry("unexpected-noninteractive-compaction", {}); return {cancel:true};
}); }`);

    const providerServer = createServer((request, response) => {
      void (async () => {
        const step = providerRequests++;
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, "Bearer noninteractive-local-key");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          assert.ok(chunk instanceof Uint8Array);
          size += chunk.length;
          assert.ok(size <= 1_048_576, "Local provider request exceeds 1 MiB");
          chunks.push(Buffer.from(chunk));
        }

        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(isUnknownRecord(body) && isUnknownArray(body.messages) && isUnknownArray(body.tools));
        const personalMarkerCount = JSON.stringify(body.messages).split(personalMarker).length - 1;
        assert.equal(personalMarkerCount, trusted ? 1 : 0);
        const toolNames = body.tools.map((tool) => {
          assert.ok(isUnknownRecord(tool) && isUnknownRecord(tool.function));
          const name = tool.function.name;
          assert.ok(typeof name === "string");
          return name;
        });
        assert.deepEqual(toolNames, ["question"], "No goal tool may activate in print or JSON mode");
        const last = body.messages.at(-1);
        assert.ok(isUnknownRecord(last));
        assert.ok(step < 2, "Noninteractive modes must not start compaction continuations");

        let questionErrorObserved = false;
        if (step === 0) {
          assert.equal(last.role, "user");
        } else {
          assert.equal(last.role, "tool");
          const toolContent = JSON.stringify(last.content);
          assert.ok(typeof toolContent === "string");
          assert.match(toolContent, /The question tool requires interactive TUI mode/u);
          questionErrorObserved = true;
        }
        observations.push({ step, lastRole: last.role, personalMarkerCount, toolNames, questionErrorObserved });

        const delta = step === 0
          ? { tool_calls: [{ index: 0, id: "noninteractive-question", type: "function", function: {
            name: "question", arguments: JSON.stringify({ question: "Choose", options: [{ label: "Alpha" }] }),
          } }] }
          : { content: "Noninteractive workflow verified" };
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(`data: ${JSON.stringify({
          id: `noninteractive-${step}`,
          model: "local",
          choices: [{ index: 0, delta, finish_reason: step === 0 ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 2_000, completion_tokens: 20, total_tokens: 2_020 },
        })}\n\ndata: [DONE]\n\n`);
      })().catch((error: unknown) => {
        if (faults.length < 8) faults.push((error instanceof Error ? error.message : String(error)).slice(0, 1_000));
        if (!response.destroyed) {
          response.writeHead(500, { connection: "close" });
          response.end("Rejected noninteractive fixture request");
        }
      });
    });
    server = providerServer;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      providerServer.once("error", onError);
      providerServer.listen(0, "127.0.0.1", () => {
        providerServer.off("error", onError);
        resolve();
      });
    });
    const address = providerServer.address();
    assert.ok(address && typeof address !== "string");

    const providerModels = {
      providers: {
        "noninteractive-local": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "noninteractive-local-key",
          models: [{
            id: "local",
            name: "Noninteractive local",
            reasoning: false,
            input: ["text"],
            contextWindow: 100_000,
            maxTokens: 1_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    };
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(providerModels));

    env = isolatedFixtureEnvironment(directory);
    Object.assign(env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
    });
    const allowedEnvironmentKeys = new Set([
      "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_NO_LAZY_FETCH",
      "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_TELEMETRY", "PI_SKIP_VERSION_CHECK",
    ]);
    assert.deepEqual(Object.keys(env).filter((key) => !allowedEnvironmentKeys.has(key)), []);
    assert.deepEqual(Object.keys(env).filter((key) => /(?:api.?key|token|secret|credential|mcp)/iu.test(key)), []);
    initializeFixtureRepository(project, env, gitActivity);

    const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    args = [
      "--print",
      ...(mode === "json" ? ["--mode", "json"] : []),
      "--model", "noninteractive-local/local",
      "--thinking", "off",
      "--tools", "question,killeros_*",
      "--session", session,
      trusted ? "--approve" : "--no-approve",
      "--offline",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", probe,
    ];
    assert.ok(args.includes("--no-mcp"), "No MCP configuration may reach the fixture process");

    const run = async (prompt: string) => {
      piLaunches += 1;
      const invocation = promisify(execFile)(process.execPath, [cliPath, ...args, prompt], {
        cwd: project,
        env,
        timeout: 15_000,
        maxBuffer: 1_048_576,
        signal,
      });
      let stdinFailure: unknown;
      try {
        invocation.child.stdin?.end();
      } catch (error) {
        stdinFailure = error;
      }
      let result: Awaited<typeof invocation>;
      try {
        result = await invocation;
      } catch (error) {
        if (stdinFailure !== undefined) throw new AggregateError([error, stdinFailure], "Could not close Pi stdin");
        throw error;
      }
      if (stdinFailure !== undefined) throw new Error("Could not close Pi stdin", { cause: stdinFailure });
      assert.equal(invocation.child.exitCode, 0, "Pi must exit naturally with code 0");
      assert.equal(invocation.child.signalCode, null, "Pi must not exit from a signal");
      naturalExits += 1;
      return result;
    };

    await run("/goal Unsupported noninteractive goal");
    assert.equal(providerRequests, 0, "/goal must not start provider work in print or JSON mode");
    assertNoGoalOrCompactionEntries(sessionEntries(session));

    const result = await run("Verify noninteractive restrictions");
    assert.match(result.stdout, /Noninteractive workflow verified/u);
    assert.equal(providerRequests, 2, "Each ordinary prompt must make exactly two provider requests");
    assert.deepEqual(faults, []);
    assert.ok(observations[1]?.questionErrorObserved, "The question tool error must reach the provider follow-up");

    const entries = sessionEntries(session);
    assert.ok(existsSync(session), "Pi must save the scenario's independent session");
    assert.ok(entries.length > 0);
    assertNoGoalOrCompactionEntries(entries);
    sessionEntryCount = entries.length;

    if (mode === "json") {
      const events = result.stdout.trim().split(/\r?\n/u).map((line) => {
        const value: unknown = JSON.parse(line);
        return value;
      });
      jsonSettlementObserved = events.some((event) => isUnknownRecord(event)
        && event.type === "agent_settled" && event.aborted === false);
      assert.equal(jsonSettlementObserved, true, "JSON output must contain native agent_settled with aborted=false");
    }
    assert.equal(providerRequests, observations.length);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (server?.listening) {
      try {
        server.closeAllConnections();
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false, "All private history files must be removed");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (failed || cleanupFailures.length > 0) {
    if (existsSync(directory)) {
      try {
        await removeDirectoryEventually(directory);
        assert.equal(existsSync(directory), false, "Fixture cleanup must finish after failure capture");
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const diagnostics = JSON.stringify({
      scenarioId,
      mode,
      trusted,
      node: process.version,
      providerRequests,
      piLaunches,
      naturalExits,
      ...gitActivity,
      sessionEntryCount,
      jsonSettlementObserved,
      observations: observations.slice(0, 8),
      faults: faults.slice(0, 8),
      childEnvironmentKeys: Object.keys(env).sort(),
    }, null, 2);
    let failureDirectory: string;
    try {
      failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-print-json-failure-"));
    } catch (error) {
      throw new AggregateError([...(failed ? [failure] : []), ...cleanupFailures, error],
        `${scenarioId} could not create bounded failure evidence`);
    }
    try {
      throwScenarioFailure({
        directory: failureDirectory,
        message: `Pi ${mode} with project trust ${trusted ? "trusted" : "untrusted"} failed`,
        errors: [...(failed ? [failure] : []), ...cleanupFailures],
        diagnostics,
      });
    } catch (error) {
      if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
        try {
          await removeDirectoryEventually(failureDirectory);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `${scenarioId} failed and failure evidence cleanup failed`);
        }
      }
      throw error;
    }
  }

  return {
    mode,
    trusted,
    fixtureDirectory: directory,
    providerRequests,
    piLaunches,
    naturalExits,
    ...gitActivity,
    sessionEntries: sessionEntryCount,
    jsonSettlementObserved,
    observations,
  };
}

// Catalog ID: runtime.print-json-trust.
test("installed Pi print and JSON preserve trust and reject interactive workflows", { timeout: 60_000 }, async (t) => {
  const processEnvironmentBefore = JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
  const histories: HistoryResult[] = [];
  for (const mode of ["print", "json"] as const) {
    for (const trusted of [true, false] as const) {
      const history = await runHistory(mode, trusted, t.signal);
      histories.push(history);
      t.diagnostic(JSON.stringify({
        scenarioId,
        mode: history.mode,
        trusted: history.trusted,
        providerRequests: history.providerRequests,
        piLaunches: history.piLaunches,
        naturalExits: history.naturalExits,
        fixtureGitInitializations: history.fixtureGitInitializations,
        gitCommands: history.gitCommands,
        sessionEntries: history.sessionEntries,
        jsonSettlementObserved: history.jsonSettlementObserved,
        observations: history.observations,
      }));
    }
  }

  assert.deepEqual(histories.map((history) => [
    history.mode,
    history.trusted,
    history.providerRequests,
    history.piLaunches,
    history.naturalExits,
    history.fixtureGitInitializations,
  ]), [
    ["print", true, 2, 2, 2, 1],
    ["print", false, 2, 2, 2, 1],
    ["json", true, 2, 2, 2, 1],
    ["json", false, 2, 2, 2, 1],
  ]);
  assert.equal(new Set(histories.map((history) => history.fixtureDirectory)).size, 4,
    "Each mode/trust history must own a fresh fixture directory");
  assert.equal(histories.reduce((total, history) => total + history.piLaunches, 0), 8);
  assert.equal(histories.reduce((total, history) => total + history.fixtureGitInitializations, 0), 4);
  assert.equal(histories.filter((history) => history.mode === "json" && history.jsonSettlementObserved).length, 2);
  assert.equal(JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right))),
    processEnvironmentBefore, "Fixture setup must not mutate the runner environment");
});
