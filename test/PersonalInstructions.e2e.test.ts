import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const piVersion = record(JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"))).version;

const sharedSystemMarker = "KILLEROS_PERSONAL_SHARED_SYSTEM_CONTEXT";
const personalMarker = "Prefer concise tradeoff explanations.";
const outsideMarker = "KILLEROS_OUTSIDE_PRIVATE_VALUE";
const externalLinkMarker = "KILLEROS_EXTERNAL_LINKED_VALUE";
const truncationNotice = "[Personal instructions truncated by KillerOS]";
const replacementCharacter = "\uFFFD";

type CapturedRequest = { messages: Record<string, unknown>[] };
type Provider = {
  port: number;
  requests: CapturedRequest[];
  faults: string[];
  close(): Promise<void>;
};
type PersonalFixture = {
  root: string;
  project: string;
  agent: string;
  personal: string;
  agentsLocal: string;
  outside: string;
  oversized: string;
  external: string;
};
type FileSymlinkCapability =
  | { kind: "created" }
  | { kind: "unavailable"; errorCode: string };
type OwnedPi = {
  process: PiRpcProcess;
  result?: Awaited<ReturnType<PiRpcProcess["close"]>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function isErrorCode(error: unknown, codes: readonly string[]): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

function systemPromptOf(request: CapturedRequest): string {
  const systems = request.messages.filter((message) => message.role === "system");
  assert.equal(systems.length, 1, "The provider request must contain exactly one system message");
  const content = systems[0]?.content;
  assert.ok(typeof content === "string", "The provider system prompt must be text");
  return content;
}

function personalBlock(systemPrompt: string): string | undefined {
  const opening = "<personal_instructions>";
  const closing = "</personal_instructions>";
  const start = systemPrompt.indexOf(opening);
  if (start < 0) return undefined;
  assert.equal(systemPrompt.indexOf(opening, start + opening.length), -1, "Only one personal instructions block may be injected");
  const end = systemPrompt.indexOf(closing, start + opening.length);
  assert.notEqual(end, -1, "The personal instructions block must close");
  return systemPrompt.slice(start + opening.length, end);
}

function assertSharedSystemPrompt(systemPrompt: string, label: string): void {
  assert.ok(systemPrompt.includes(sharedSystemMarker), `${label}: the surrounding system prompt must survive`);
  assert.doesNotMatch(systemPrompt, /\uFFFD/u, `${label}: the surrounding system prompt must remain valid UTF-8`);
}

function assertNoPersonalInstructions(systemPrompt: string, label: string): void {
  assertSharedSystemPrompt(systemPrompt, label);
  assert.doesNotMatch(systemPrompt, /personal_instructions/u, `${label}: personal instructions must not be injected`);
}

function assertValidPersonalInstructions(systemPrompt: string, label: string): void {
  assertSharedSystemPrompt(systemPrompt, label);
  assert.match(systemPrompt, /\n<personal_instructions>\n/u, label);
  const block = personalBlock(systemPrompt);
  assert.ok(block, `${label}: the personal instructions block must be present`);
  assert.ok(block.includes(personalMarker), `${label}: the imported text must be injected`);
  assert.equal(block.includes(sharedSystemMarker), false, `${label}: the shared prompt must stay outside the personal block`);
  assert.ok(systemPrompt.indexOf(sharedSystemMarker) < systemPrompt.indexOf("<personal_instructions>"),
    `${label}: the shared prompt must precede the personal block`);
  assert.doesNotMatch(systemPrompt, /source=/u, `${label}: no source metadata may be added`);
}

async function startProvider(): Promise<Provider> {
  const requests: CapturedRequest[] = [];
  const faults: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer local-personal-key");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576, "Provider request exceeded the capture limit");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const messages = body.messages;
      assert.ok(Array.isArray(messages));
      requests.push({ messages: messages.map(record) });
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `personal-${requests.length}`,
        model: "local",
        choices: [{ index: 0, delta: { content: "Personal instructions acknowledged" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2_000, completion_tokens: 8, total_tokens: 2_008 },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) {
        response.writeHead(500, { connection: "close" });
        response.end("Personal instructions fixture rejected the request");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    port: address.port,
    requests,
    faults,
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

function isolatedChildEnvironment(directory: string, agentDirectory: string): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  const appData = path.join(directory, "appdata");
  const localAppData = path.join(directory, "localappdata");
  const temporaryDirectory = path.join(directory, "tmp");
  const emptyGitConfig = path.join(directory, "empty-git-config");
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(emptyGitConfig, "");
  Object.assign(env, {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
  return env;
}

function writeAgentConfiguration(agentDirectory: string, port: number): void {
  writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
    retry: { enabled: false },
  }));
  writeFileSync(path.join(agentDirectory, "killeros.json"), JSON.stringify({
    autoCompaction: { enabled: false, percentRemaining: 100 },
  }));
  writeFileSync(path.join(agentDirectory, "append-system.txt"), `${sharedSystemMarker}\n`);
  writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: {
    "personal-local": {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "local-personal-key",
      models: [{
        id: "local",
        name: "Local personal instructions check",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  } }));
}

function launchPi(options: {
  fixture: PersonalFixture;
  trusted: boolean;
}): PiRpcProcess {
  return new PiRpcProcess({
    cliPath,
    cwd: options.fixture.project,
    env: isolatedChildEnvironment(options.fixture.root, options.fixture.agent),
    args: [
      "--mode", "rpc",
      "--model", "personal-local/local",
      "--thinking", "off",
      "--no-tools",
      "--session", path.join(options.fixture.root, "session.jsonl"),
      "--offline",
      options.trusted ? "--approve" : "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--append-system-prompt", path.join(options.fixture.agent, "append-system.txt"),
    ],
  });
}

async function promptAndCapture(
  pi: PiRpcProcess,
  provider: Provider,
  message: string,
  label: string,
): Promise<CapturedRequest> {
  const after = pi.currentSequence;
  const before = provider.requests.length;
  const response = record(await pi.command("prompt", { message }, { timeoutMs: 30_000 }));
  const data = record(response.data);
  assert.equal(data.disposition, "started", `${label}: the prompt must start an agent run`);
  const settled = await pi.waitFor((event) => event.type === "agent_settled", { after, timeoutMs: 60_000 });
  assert.notEqual(settled.aborted, true, `${label}: the run must settle without cancellation`);
  assert.equal(provider.requests.length, before + 1, `${label}: exactly one provider request must complete`);
  const state = record((await pi.command("get_state", {}, { timeoutMs: 30_000 })).data);
  assert.equal(state.isStreaming, false, `${label}: streaming must be finished`);
  assert.equal(state.isCompacting, false, `${label}: compaction must be finished`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no queued work may remain`);
  const request = provider.requests.at(-1);
  assert.ok(request);
  return request;
}

function createPersonalFixture(root: string): PersonalFixture {
  const project = path.join(root, "project");
  const agent = path.join(root, "agent");
  mkdirSync(project, { recursive: true });
  mkdirSync(agent, { recursive: true });
  const personal = path.join(agent, "personal.md");
  const outside = path.join(project, "outside.md");
  const oversized = path.join(agent, "oversized.md");
  writeFileSync(personal, `${personalMarker}\n`);
  writeFileSync(outside, `${outsideMarker}\n`);
  writeFileSync(oversized, "x".repeat(32 * 1024 + 1));
  return {
    root,
    project,
    agent,
    personal,
    agentsLocal: path.join(project, "AGENTS.local.md"),
    outside,
    oversized,
    external: path.join(root, "external.md"),
  };
}

async function exercisePersonalInstructions(options: {
  fixture: PersonalFixture;
  provider: Provider;
  trusted: boolean;
  processes: OwnedPi[];
}): Promise<{ requests: number; fileSymlink: FileSymlinkCapability }> {
  const { fixture, provider, trusted, processes } = options;
  writeAgentConfiguration(fixture.agent, provider.port);
  const pi = launchPi({ fixture, trusted });
  processes.push({ process: pi });

  writeFileSync(fixture.agentsLocal, `@${fixture.personal}\n`);
  const valid = await promptAndCapture(pi, provider, "Report the shared context", `${trusted ? "trusted" : "untrusted"} valid import`);
  if (trusted) assertValidPersonalInstructions(systemPromptOf(valid), "trusted valid import");
  else assertNoPersonalInstructions(systemPromptOf(valid), "untrusted valid import");

  const rejected: Array<{ name: string; importPath: string; privateMarker?: string }> = [
    { name: "outside path", importPath: fixture.outside, privateMarker: outsideMarker },
    { name: "oversized file", importPath: fixture.oversized },
  ];
  const hardLink = path.join(fixture.agent, "hard-linked.md");
  linkSync(fixture.personal, hardLink);
  rejected.push({ name: "hard link", importPath: hardLink, privateMarker: personalMarker });

  let fileSymlink: FileSymlinkCapability;
  const linkedPath = path.join(fixture.agent, "symlinked.md");
  const symlinkTarget = path.join(fixture.agent, "symlink-target.md");
  writeFileSync(symlinkTarget, `${personalMarker}\n`);
  assert.equal(lstatSync(symlinkTarget).nlink, 1, "The symlink target must not also be hard-linked");
  try {
    symlinkSync(symlinkTarget, linkedPath, "file");
    fileSymlink = { kind: "created" };
  } catch (error) {
    if (!isErrorCode(error, ["EACCES", "EPERM"])) throw error;
    // A directory junction fails containment before the file-symlink checks and is not a substitute.
    fileSymlink = { kind: "unavailable", errorCode: error.code };
  }
  if (fileSymlink.kind === "created") {
    assert.equal(lstatSync(linkedPath).isSymbolicLink(), true, "The imported file must be a real file symlink");
    rejected.push({ name: "file symlink", importPath: linkedPath, privateMarker: personalMarker });
  }

  for (const vector of rejected) {
    writeFileSync(fixture.agentsLocal, `@${vector.importPath}\n`);
    const request = await promptAndCapture(pi, provider, `Report the ${vector.name} vector`, `${trusted ? "trusted" : "untrusted"} ${vector.name}`);
    const systemPrompt = systemPromptOf(request);
    assertNoPersonalInstructions(systemPrompt, `${trusted ? "trusted" : "untrusted"} ${vector.name}`);
    if (vector.privateMarker) {
      assert.equal(systemPrompt.includes(vector.privateMarker), false,
        `${trusted ? "trusted" : "untrusted"} ${vector.name}: the private text must not reach the provider`);
    }
  }

  writeFileSync(fixture.external, `${externalLinkMarker}\n`);
  unlinkSync(fixture.agentsLocal);
  linkSync(fixture.external, fixture.agentsLocal);
  const linked = await promptAndCapture(pi, provider, "Report the linked instructions vector", `${trusted ? "trusted" : "untrusted"} linked AGENTS.local.md`);
  const linkedSystemPrompt = systemPromptOf(linked);
  assertNoPersonalInstructions(linkedSystemPrompt, `${trusted ? "trusted" : "untrusted"} linked AGENTS.local.md`);
  assert.equal(linkedSystemPrompt.includes(externalLinkMarker), false, "The externally linked instructions must not reach the provider");

  return { requests: 2 + rejected.length, fileSymlink };
}

function summarizeRequest(request: CapturedRequest): Record<string, unknown> {
  const systems = request.messages.filter((message) => message.role === "system");
  const content = systems[0]?.content;
  if (typeof content !== "string") {
    return { messages: request.messages.length, systemMessages: systems.length, systemType: typeof content };
  }
  return {
    messages: request.messages.length,
    systemMessages: systems.length,
    systemLength: content.length,
    hasPersonalBlock: content.includes("<personal_instructions>"),
    hasSharedSystemMarker: content.includes(sharedSystemMarker),
    systemTail: content.slice(-1_500),
  };
}

async function reportFailure(options: {
  scenarioId: string;
  message: string;
  errors: unknown[];
  diagnostics: string;
}): Promise<never> {
  let reportDirectory: string;
  try {
    reportDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-personal-instructions-failure-"));
  } catch (error) {
    throw new AggregateError([...options.errors, error], `${options.message} and its failure report directory could not be created`);
  }
  try {
    throwScenarioFailure({
      directory: reportDirectory,
      message: options.message,
      errors: options.errors,
      diagnostics: options.diagnostics,
    });
  } catch (error) {
    if (!existsSync(path.join(reportDirectory, "failure.txt"))) {
      try {
        await removeDirectoryEventually(reportDirectory);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${options.message} and its empty failure report could not be cleaned up`);
      }
    }
    throw error;
  }
}

// Catalog ID: PI-01.
test("Personal instruction imports remain inside Pi's agent directory and reject linked files", {
  timeout: 240_000,
}, async (t) => {
  const scenarioId = "PI-01";
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-personal-instructions-"));
  let provider: Provider | undefined;
  const processes: OwnedPi[] = [];
  const runs: Array<{ trusted: boolean; requests: number; fileSymlink: FileSymlinkCapability }> = [];
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    provider = await startProvider();
    const trusted = await exercisePersonalInstructions({
      fixture: createPersonalFixture(path.join(directory, "trusted")),
      provider,
      trusted: true,
      processes,
    });
    runs.push({ trusted: true, ...trusted });
    const untrusted = await exercisePersonalInstructions({
      fixture: createPersonalFixture(path.join(directory, "untrusted")),
      provider,
      trusted: false,
      processes,
    });
    runs.push({ trusted: false, ...untrusted });
    assert.equal(runs.reduce((total, run) => total + run.requests, 0), provider.requests.length,
      "Every run must account for its provider requests");
    assert.equal(processes.length, 2, "Trusted and untrusted projects each require a fresh Pi process");
    assert.deepEqual(provider.faults, []);
    t.diagnostic(JSON.stringify({ scenarioId, runs, providerRequests: provider.requests.length, piLaunches: processes.length }));
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const owned of processes) {
      if (owned.result) continue;
      try {
        owned.result = await owned.process.close();
        assert.equal(owned.result.exit.code, 0, "The trusted or untrusted Pi process must exit naturally");
        assert.equal(owned.result.forced, false, "Pi shutdown must not be forced");
        assert.equal(owned.result.treeCleanupError, undefined, "Pi process-tree cleanup must be confirmed");
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await provider?.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false, "All personal instruction fixtures must be removed");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    const errors = [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures];
    const diagnostics = JSON.stringify({
      scenarioId,
      mode: "rpc",
      node: process.version,
      piVersion,
      runs,
      providerRequests: provider?.requests.length ?? 0,
      requests: provider?.requests.map(summarizeRequest) ?? [],
      providerFaults: provider?.faults.slice(0, 8) ?? [],
      processResults: processes.map((owned) => owned.result),
    }, null, 2);
    await reportFailure({
      scenarioId,
      message: "Personal instruction import scenario failed",
      errors,
      diagnostics,
    });
  }
});

// Catalog ID: PI-02.
test("Personal instruction truncation preserves valid UTF-8", {
  timeout: 120_000,
}, async (t) => {
  const scenarioId = "PI-02";
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-personal-instructions-utf8-"));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const fixture: PersonalFixture = {
    root: directory,
    project,
    agent,
    personal: path.join(agent, "unused-personal.md"),
    agentsLocal: path.join(project, "AGENTS.local.md"),
    outside: path.join(project, "unused-outside.md"),
    oversized: path.join(agent, "unused-oversized.md"),
    external: path.join(directory, "unused-external.md"),
  };
  let provider: Provider | undefined;
  const processes: OwnedPi[] = [];
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];

  try {
    mkdirSync(project);
    mkdirSync(agent);
    const content = `${"a".repeat(32_767)}é`;
    writeFileSync(fixture.agentsLocal, content, "utf8");
    assert.equal(Buffer.byteLength(content, "utf8"), 32_769, "The UTF-8 input domain must exceed 32 KiB by one byte");

    provider = await startProvider();
    writeAgentConfiguration(agent, provider.port);
    const pi = launchPi({ fixture, trusted: true });
    processes.push({ process: pi });
    const request = await promptAndCapture(pi, provider, "Report the truncated instructions", "UTF-8 truncation");
    const systemPrompt = systemPromptOf(request);
    assertSharedSystemPrompt(systemPrompt, "UTF-8 truncation");
    assert.equal(systemPrompt.includes(replacementCharacter), false, "The system prompt must contain no replacement character");
    const block = personalBlock(systemPrompt);
    assert.ok(block, "The truncated personal instructions must be injected");
    const expected = `\n${"a".repeat(32_767)}\n\n${truncationNotice}\n`;
    assert.equal(block, expected, "The block must stop at the 32 KiB bound and include the KillerOS notice");
    assert.equal(block.includes("é"), false, "The split multibyte character must not be injected");
    assert.ok(systemPrompt.indexOf(sharedSystemMarker) < systemPrompt.indexOf("<personal_instructions>"),
      "The surrounding system prompt must precede the personal instructions block");
    assert.ok(systemPrompt.endsWith("</personal_instructions>"), "The surrounding system prompt must remain complete");
    assert.equal(provider.requests.length, 1, "The truncation scenario must use exactly one provider request");
    assert.equal(processes.length, 1, "The truncation scenario must use exactly one fresh Pi process");
    assert.deepEqual(provider.faults, []);
    t.diagnostic(JSON.stringify({
      scenarioId,
      providerRequests: provider.requests.length,
      piLaunches: processes.length,
      inputBytes: Buffer.byteLength(content, "utf8"),
      injectedAsciiBytes: Buffer.byteLength("a".repeat(32_767), "utf8"),
    }));
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const owned of processes) {
      if (owned.result) continue;
      try {
        owned.result = await owned.process.close();
        assert.equal(owned.result.exit.code, 0, "The Pi process must exit naturally");
        assert.equal(owned.result.forced, false, "Pi shutdown must not be forced");
        assert.equal(owned.result.treeCleanupError, undefined, "Pi process-tree cleanup must be confirmed");
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await provider?.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false, "All truncation fixtures must be removed");
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    const errors = [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures];
    const diagnostics = JSON.stringify({
      scenarioId,
      mode: "rpc",
      node: process.version,
      piVersion,
      providerRequests: provider?.requests.length ?? 0,
      requests: provider?.requests.map(summarizeRequest) ?? [],
      providerFaults: provider?.faults.slice(0, 8) ?? [],
      processResults: processes.map((owned) => owned.result),
    }, null, 2);
    await reportFailure({
      scenarioId,
      message: "Personal instruction UTF-8 truncation scenario failed",
      errors,
      diagnostics,
    });
  }
});
