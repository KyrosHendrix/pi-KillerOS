import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenarioId = "compaction-print-mode";
const scenarioTitle = "Print mode skips KillerOS proactive compaction below Pi's native reserve threshold";
const finalResponse = "Compaction print-mode response";
const modelName = "compaction-print/local";
const contextWindow = 100_000;
const contextTokens = 99_000;
const promptTokens = 98_980;
const completionTokens = 20;
const percentRemaining = 100;
const reserveTokens = 1;

type JsonObject = Record<string, unknown>;

type ProviderObservation = {
  model: string;
  messageRoles: string[];
  toolNames: string[];
};

type SessionSummary = {
  entryCount: number;
  entryTypes: string[];
  assistantUsage: {
    input: number;
    output: number;
    totalTokens: number;
  };
};

type TurnEndObservation = {
  event: string;
  mode: string;
  turnEnds: number;
  hasAutoCompactCommand: boolean;
};

/**
 * Owns the single ordered marker line written by the observation-only fixture
 * extension. It records the real host event and mode; it never emits events.
 */
const probeExtensionSource = String.raw`
import { appendFileSync } from "node:fs";

const markerPath = process.env.KILLEROS_COMPACTION_PRINT_PROBE;
if (!markerPath) throw new Error("KILLEROS_COMPACTION_PRINT_PROBE is not set");
let turnEnds = 0;

export default function observePrintMode(pi) {
  pi.on("turn_end", (_event, ctx) => {
    turnEnds += 1;
    const commands = pi.getCommands().map((command) => command.name);
    appendFileSync(markerPath, JSON.stringify({
      event: "turn_end",
      mode: ctx.mode,
      turnEnds,
      hasAutoCompactCommand: commands.includes("auto-compact"),
    }) + "\n");
  });
}
`;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requireNumberField(value: JsonObject, field: string): number {
  const candidate = value[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new Error(`Expected numeric field ${field}`);
  }
  return candidate;
}

function requireStringField(value: JsonObject, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`Expected string field ${field}`);
  return candidate;
}

function readJsonObject(filePath: string, label: string): JsonObject {
  const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  return requireRecord(value, label);
}

function readJsonLines(filePath: string, label: string): JsonObject[] {
  const contents = readFileSync(filePath, "utf8").trim();
  if (!contents) return [];
  return contents.split(/\r?\n/u).map((line) => {
    const value: unknown = JSON.parse(line);
    return requireRecord(value, label);
  });
}

/**
 * Builds a child-only environment. The runner's process.env is never mutated,
 * and no inherited provider credential, MCP configuration, or Git config is
 * visible to the launch.
 */
function isolatedEnvironment(directory: string, agentDirectory: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {};
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
  env.TEMP = temporaryDirectory;
  env.TMP = temporaryDirectory;
  const emptyGitConfig = path.join(directory, "empty-git-config");
  env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  env.GIT_CONFIG_SYSTEM = emptyGitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_CEILING_DIRECTORIES = directory;
  env.PI_CODING_AGENT_DIR = agentDirectory;
  env.PI_OFFLINE = "1";
  env.PI_TELEMETRY = "0";
  env.PI_SKIP_VERSION_CHECK = "1";
  env.KILLEROS_COMPACTION_PRINT_PROBE = path.join(directory, "turn-end.jsonl");
  mkdirSync(env.APPDATA, { recursive: true });
  mkdirSync(env.LOCALAPPDATA, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(emptyGitConfig, "");
  return env;
}

function readPiVersion(): string {
  const manifest = readJsonObject(
    path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"),
    "Installed Pi manifest",
  );
  return requireStringField(manifest, "version");
}

const piVersion = readPiVersion();

// Catalog ID: compaction-print-mode.
test(scenarioTitle, { timeout: 60_000 }, async (t) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const processEnvironmentBefore = JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-compaction-print-"));
  const project = path.join(directory, "project");
  const agentDirectory = path.join(directory, "agent");
  const sessionPath = path.join(directory, "session.jsonl");
  const probeExtensionPath = path.join(directory, "print-mode-probe.mjs");
  const turnEndPath = path.join(directory, "turn-end.jsonl");

  let providerRequests = 0;
  const providerFaults: string[] = [];
  const observations: ProviderObservation[] = [];
  const cleanup = {
    piLaunches: 0,
    otherOwnedChildLaunches: 0,
    naturalExits: 0,
    forced: null as boolean | null,
    providerRequests: 0,
    exitCode: null as number | null,
    exitSignal: null as NodeJS.Signals | null,
    serverClosed: false,
    scratchRemoved: false,
  };
  const cleanupFailures: unknown[] = [];
  let failure: unknown;
  let stdout = "";
  let stderr = "";
  let sessionSummary: SessionSummary | undefined;
  let turnEndObservation: TurnEndObservation | undefined;
  let settingsSnapshot: JsonObject | undefined;

  const server = createServer((request, response) => {
    providerRequests += 1;
    const requestNumber = providerRequests;
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer compaction-print-key");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576, "Fixture provider request exceeded 1 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const bodyValue: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const body = requireRecord(bodyValue, "Provider request body");
      const model = requireStringField(body, "model");
      assert.equal(model, "local");
      assert.ok(Array.isArray(body.messages), "Provider request must contain messages");
      const messageRoles = body.messages.map((message) => requireStringField(requireRecord(message, "Provider message"), "role"));
      assert.ok(Array.isArray(body.tools), "Provider request must contain a tools array");
      const toolNames = body.tools.map((tool) => {
        const functionDefinition = requireRecord(requireRecord(tool, "Provider tool").function, "Provider tool function");
        return requireStringField(functionDefinition, "name");
      });
      observations.push({ model, messageRoles, toolNames });

      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `compaction-print-${requestNumber}`,
        model: "local",
        choices: [{ index: 0, delta: { content: finalResponse }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: contextTokens,
        },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      const text = error instanceof Error ? error.stack ?? error.message : String(error);
      if (providerFaults.length < 8) providerFaults.push(text.slice(0, 4_000));
      if (!response.destroyed) {
        response.writeHead(500, { connection: "close" });
        response.end("Compaction print-mode fixture rejected the request");
      }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;

  try {
    mkdirSync(project);
    mkdirSync(agentDirectory);
    writeFileSync(probeExtensionPath, probeExtensionSource, "utf8");
    assert.equal(existsSync(sessionPath), false, "Each print-mode history must start with a new session");
    assert.equal(existsSync(turnEndPath), false, "Each print-mode history must start without a turn marker");

    writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      retry: { enabled: false },
      compaction: { enabled: true, reserveTokens, keepRecentTokens: 1 },
    }, null, 2));
    writeFileSync(path.join(agentDirectory, "killeros.json"), JSON.stringify({
      autoCompaction: { enabled: true, percentRemaining },
    }, null, 2));

    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Fixture provider did not bind a TCP port"));
      });
    });
    writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({
      providers: {
        "compaction-print": {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKey: "compaction-print-key",
          models: [{
            id: "local",
            name: "Compaction print local",
            reasoning: false,
            input: ["text"],
            contextWindow,
            maxTokens: 1_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }, null, 2));

    const env = isolatedEnvironment(directory, agentDirectory);
    assert.equal(env.PI_CODING_AGENT_DIR, agentDirectory);
    assert.equal(env.PI_OFFLINE, "1");
    assert.deepEqual(
      Object.keys(env).filter((key) => /(?:api.?key|token|secret|credential|mcp)/iu.test(key)),
      [],
      "The child environment must not inherit provider secrets or MCP configuration",
    );

    const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const args = [
      "--print",
      "--model", modelName,
      "--thinking", "off",
      "--tools", "read",
      "--session", sessionPath,
      "--approve",
      "--offline",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", probeExtensionPath,
      "Report the print-mode fixture result",
    ];

    cleanup.piLaunches += 1;
    const invocation = promisify(execFile)(process.execPath, [cliPath, ...args], {
      cwd: project,
      env,
      timeout: 30_000,
      maxBuffer: 1_048_576,
      signal: t.signal,
      windowsHide: true,
    });
    const recordExitMetadata = (completed: boolean): void => {
      cleanup.exitCode = invocation.child.exitCode;
      cleanup.exitSignal = invocation.child.signalCode;
      cleanup.forced = cleanup.exitSignal !== null
        ? true
        : completed && cleanup.exitCode !== null
          ? false
          : null;
    };
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
      recordExitMetadata(false);
      if (stdinFailure !== undefined) throw new AggregateError([error, stdinFailure], "Could not close Pi stdin");
      throw error;
    }
    recordExitMetadata(true);
    if (stdinFailure !== undefined) throw new Error("Could not close Pi stdin", { cause: stdinFailure });

    stdout = result.stdout;
    stderr = result.stderr;

    assert.equal(invocation.child.exitCode, 0, "Pi print mode must exit naturally with code 0");
    assert.equal(invocation.child.signalCode, null, "Pi print mode must not exit from a signal");
    cleanup.naturalExits += 1;
    assert.equal(stderr, "", "Pi print mode must not write errors or warnings to stderr");
    assert.equal(stdout.trimEnd(), finalResponse, "Print mode must write only the final assistant text to stdout");
    assert.equal(providerRequests, 1, "Print mode must issue exactly one provider request: no summary request and no hidden continuation");
    assert.deepEqual(providerFaults, []);
    assert.deepEqual(observations, [{
      model: "local",
      messageRoles: ["system", "user"],
      toolNames: ["read"],
    }], "The only request must be the initial prompt");

    assert.equal(existsSync(sessionPath), true, "Pi must save the isolated print-mode session");
    const entries = readJsonLines(sessionPath, "Session entry");
    assert.ok(entries.length > 0, "Session must contain entries");
    const assistantMessages = entries.flatMap((entry) => {
      if (entry.type !== "message") return [];
      const message = entry.message;
      if (!isRecord(message) || message.role !== "assistant") return [];
      return [message];
    });
    assert.equal(assistantMessages.length, 1, "Print mode must produce exactly one assistant message");
    const assistant = assistantMessages.at(0);
    assert.ok(assistant, "Missing assistant session entry");
    assert.equal(assistant.stopReason, "stop");
    const usage = requireRecord(assistant.usage, "Assistant usage");
    const assistantUsage = {
      input: requireNumberField(usage, "input"),
      output: requireNumberField(usage, "output"),
      totalTokens: requireNumberField(usage, "totalTokens"),
    };
    assert.deepEqual(assistantUsage, {
      input: promptTokens,
      output: completionTokens,
      totalTokens: contextTokens,
    }, "The session must record the fixture usage that exceeds the KillerOS threshold");
    assert.equal(entries.some((entry) => entry.type === "compaction"), false,
      "Print mode must not save a compaction entry");
    assert.equal(entries.some((entry) => entry.type === "branch_summary"), false,
      "Print mode must not save a branch summary entry");
    assert.equal(entries.some((entry) => (entry.type === "custom" || entry.type === "custom_message")
      && entry.customType === "killeros-auto-compaction"), false,
    "Print mode must not save a KillerOS auto-compaction continuation");
    sessionSummary = {
      entryCount: entries.length,
      entryTypes: entries.map((entry) => requireStringField(entry, "type")),
      assistantUsage,
    };

    assert.equal(existsSync(turnEndPath), true, "The observation extension must record the real turn_end");
    const turnEnds = readJsonLines(turnEndPath, "Turn-end observation");
    assert.equal(turnEnds.length, 1, "Pi must emit exactly one real turn_end in print mode");
    const turnEnd = turnEnds.at(0);
    assert.ok(turnEnd, "Missing turn_end observation");
    turnEndObservation = {
      event: requireStringField(turnEnd, "event"),
      mode: requireStringField(turnEnd, "mode"),
      turnEnds: requireNumberField(turnEnd, "turnEnds"),
      hasAutoCompactCommand: turnEnd.hasAutoCompactCommand === true,
    };
    assert.deepEqual(turnEndObservation, {
      event: "turn_end",
      mode: "print",
      turnEnds: 1,
      hasAutoCompactCommand: true,
    }, "The real print-mode turn_end must reach a loaded KillerOS auto-compaction registration");

    const killerSettings = readJsonObject(path.join(agentDirectory, "killeros.json"), "KillerOS settings");
    const autoCompaction = requireRecord(killerSettings.autoCompaction, "KillerOS autoCompaction");
    const piSettings = readJsonObject(path.join(agentDirectory, "settings.json"), "Pi settings");
    const compaction = requireRecord(piSettings.compaction, "Pi compaction settings");
    settingsSnapshot = { autoCompaction, compaction };
    assert.equal(autoCompaction.enabled, true);
    assert.equal(requireNumberField(autoCompaction, "percentRemaining"), percentRemaining);
    assert.equal(compaction.enabled, true);
    assert.equal(requireNumberField(compaction, "reserveTokens"), reserveTokens);

    // Pi's native threshold is contextWindow - reserveTokens, so 99,000 of 100,000 stays
    // inside it. KillerOS's 100 percent threshold is exceeded, so only KillerOS could
    // request compaction. The negative therefore isolates the missing print-mode gate.
    const remainingTokens = contextWindow - contextTokens;
    assert.equal(remainingTokens, 1_000);
    assert.ok(remainingTokens <= contextWindow * percentRemaining / 100,
      "Fixture usage must exceed the KillerOS trigger threshold");
    assert.ok(contextTokens <= contextWindow - reserveTokens,
      "Fixture usage must remain inside Pi's native reserve threshold so only KillerOS could request compaction");

    assert.equal(JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right))),
      processEnvironmentBefore, "Fixture setup must not mutate the runner environment");
  } catch (error) {
    failure = error;
  } finally {
    cleanup.providerRequests = providerRequests;
    if (server.listening) {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        cleanup.serverClosed = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    } else {
      cleanup.serverClosed = true;
    }
    try {
      await removeDirectoryEventually(directory);
      cleanup.scratchRemoved = !existsSync(directory);
      if (!cleanup.scratchRemoved) throw new Error(`Owned fixture directory remains: ${directory}`);
    } catch (error) {
      cleanupFailures.push(error);
      try {
        await removeDirectoryEventually(directory);
        cleanup.scratchRemoved = !existsSync(directory);
        if (!cleanup.scratchRemoved) cleanupFailures.push(new Error(`Owned fixture directory remains: ${directory}`));
      } catch (retryError) {
        cleanupFailures.push(retryError);
      }
    }
  }

  if (failure !== undefined || cleanupFailures.length > 0 || providerFaults.length > 0) {
    const errors: unknown[] = [...(failure === undefined ? [] : [failure]), ...cleanupFailures];
    if (errors.length === 0) errors.push(...providerFaults.map((fault) => new Error(fault)));
    const diagnostics = JSON.stringify({
      scenarioId,
      scenarioTitle,
      mode: "print",
      node: process.version,
      platform: process.platform,
      pi: piVersion,
      fixtureDirectory: directory,
      cleanup,
      providerRequests,
      providerFaults: providerFaults.slice(0, 8),
      observations: observations.slice(0, 4),
      stdout: stdout.slice(0, 8_000),
      stderr: stderr.slice(0, 8_000),
      sessionSummary,
      turnEndObservation,
      settings: settingsSnapshot,
    }, null, 2);
    let failureDirectory: string;
    try {
      failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-compaction-print-failure-"));
    } catch (error) {
      throw new AggregateError([...errors, error], `${scenarioId} could not create bounded failure evidence`);
    }
    try {
      throwScenarioFailure({
        directory: failureDirectory,
        message: `${scenarioId} failed`,
        errors,
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

  assert.equal(cleanup.piLaunches, 1);
  assert.equal(cleanup.otherOwnedChildLaunches, 0);
  assert.equal(cleanup.naturalExits, 1);
  assert.equal(cleanup.forced, false);
  assert.equal(cleanup.providerRequests, 1);
  assert.equal(cleanup.exitCode, 0);
  assert.equal(cleanup.exitSignal, null);
  assert.equal(cleanup.serverClosed, true);
  assert.equal(cleanup.scratchRemoved, true);
  assert.ok(turnEndObservation);
  t.diagnostic(JSON.stringify({
    scenarioId,
    mode: "print",
    providerRequests,
    piLaunches: cleanup.piLaunches,
    otherOwnedChildLaunches: cleanup.otherOwnedChildLaunches,
    naturalExits: cleanup.naturalExits,
    sessionEntries: sessionSummary?.entryCount,
    turnEnd: turnEndObservation,
  }));
});
