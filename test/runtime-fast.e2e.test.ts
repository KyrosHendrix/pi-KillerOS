import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const piManifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
assert.ok(typeof piManifest === "object" && piManifest !== null && "version" in piManifest && typeof piManifest.version === "string");
const piVersion = piManifest.version;
const enter = "\x1b[13u";

type RecordValue = Record<string, unknown>;

/** Loopback provider fixture with per-provider routes; no live service or credentials. */
class FastProvider {
  readonly codexBodies: RecordValue[] = [];
  readonly otherBodies: RecordValue[] = [];
  private readonly faults: unknown[] = [];
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          assert.ok(chunk instanceof Uint8Array);
          size += chunk.length;
          assert.ok(size < 1_048_576);
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.ok(typeof body === "object" && body !== null);
        const url = request.url ?? "";
        const bodies = url.startsWith("/codex/") ? this.codexBodies : url.startsWith("/other/") ? this.otherBodies : undefined;
        if (bodies === undefined) throw new Error(`Fast fixture received an unexpected request to ${url}`);
        bodies.push(body as RecordValue);
        let index = 0;
        if (url.startsWith("/codex/")) index = this.codexBodies.length;
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(`data: ${JSON.stringify({ id: `fast-${index}`, model: "fast-model",
          choices: [{ index: 0, delta: { content: `Fast response ${index}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
      })().catch((error: unknown) => {
        this.faults.push(error);
        if (!response.destroyed && !response.writableEnded) { response.writeHead(500, { connection: "close" }); response.end("Fast fixture rejected request"); }
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
  }

  get errors(): unknown[] {
    return this.faults;
  }

  async listen(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const address = this.server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Fast fixture did not report a port"));
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }
}

type Family = { directory: string; project: string; agent: string; env: NodeJS.ProcessEnv };

function createFamily(root: string, name: string): Family {
  const directory = mkdtempSync(path.join(root, "node_modules", `.killeros-fast-${name}-`));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  for (const folder of [project, agent]) mkdirSync(folder);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
    PATH: process.env.PATH ?? "", PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([entry]) => entry.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  // Bound passive receipt/footer scans to the fixture, not the enclosing development checkout.
  execFileSync("git", ["init", "--quiet"], { cwd: project, env, windowsHide: true, stdio: "pipe" });
  return { directory, project, agent, env };
}

function writeFastConfig(agent: string, port: number): void {
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: {
    "openai-codex": { baseUrl: `http://127.0.0.1:${port}/codex/v1`, api: "openai-completions", apiKey: "fast-fixture-only",
      models: [{ id: "codex-local", name: "codex local", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
    "fast-other": { baseUrl: `http://127.0.0.1:${port}/other/v1`, api: "openai-completions", apiKey: "fast-fixture-only",
      models: [{ id: "other-model", name: "other local", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
  } }));
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `Expected ${label} to be an object`);
  return value;
}

function stringField(value: RecordValue, key: string): string {
  const field = value[key];
  assert.ok(typeof field === "string", `Expected ${key} to be a string`);
  return field;
}

test("real Pi /codex-fast controls process-local state, status, and footer", { timeout: 240_000, skip: piRpcShutdownSkip }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "local");
  const provider = new FastProvider();
  const oneShotResults: RecordValue = {};
  const cleanupFailures: unknown[] = [];
  const failures: unknown[] = [];
  let failure: unknown;
  const screens: RecordValue = {};
  let terminal: PiTerminalProcess | undefined;
  try {
    const port = await provider.listen();
    writeFastConfig(family.agent, port);
    const sessionFile = path.join(family.directory, "session-fast.jsonl");

    // Family 1: one trusted TUI process drives toggles, status, footer, model switches, and reload.
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, "--model", "openai-codex/codex-local", "--thinking", "off", "--tools", "read",
        "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts")],
      cwd: family.project, env: family.env, cols: 120, rows: 34 });
    const command = async (text: string, predicate: (screen: string) => boolean): Promise<string> => {
      assert.ok(terminal);
      const after = terminal.sequence;
      terminal.write(text);
      await terminal.waitForScreen((screen) => screen.includes("❯") && screen.split("\n").some((line) => line.includes(text)), { signal: t.signal, after });
      terminal.write(enter);
      return await terminal.waitForScreen(predicate, { signal: t.signal });
    };
    writeFileSync(path.join(family.agent, "auth.json"), JSON.stringify({ "openai-codex": {
      type: "oauth", access: "fast-fixture-access-token", refresh: "fast-fixture-refresh-token", expires: Date.now() + 3_600_000,
      clientId: "fast-fixture-client", scopes: ["chatgpt.tokens.use.direct"] } }));
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("codex-local openai") && screen.includes("ctx 100%"), { signal: t.signal });
    screens.beforeToggle = await command("plain turn", (screen) => screen.includes("Fast response 1"));
    assert.equal("service_tier" in (provider.codexBodies[0] ?? {}), false, "Fast mode defaults to disabled: no service tier");
    screens.enabled = await command("/codex-fast", (screen) => screen.includes("Fast enabled"));
    screens.priorityTurn = await command("priority turn", (screen) => screen.includes("Fast response 2"));
    const priorityBody = provider.codexBodies[1];
    assert.equal(priorityBody?.service_tier, "priority", "Enabling fast adds the priority tier to eligible requests");
    assert.equal(priorityBody?.model, "codex-local", "Enabling fast preserves the model identity");
    screens.status = await command("/codex-fast status", (screen) => screen.includes("Codex fast mode: enabled"));
    screens.invalid = await command("/codex-fast on", (screen) => screen.includes("Usage: /codex-fast [status]"));
    const invalidBodyCount = provider.codexBodies.length;
    screens.statusAfterInvalid = await command("/codex-fast status", (screen) => screen.includes("Codex fast mode: enabled"));
    assert.equal(provider.codexBodies.length, invalidBodyCount, "Invalid arguments change no state and start no request");
    screens.footerFast = await command("/codex-fast status", (screen) => {
      const footer = screen.split("\n").find((line) => line.includes("ctx"));
      return footer !== undefined && /codex-local fast openai/u.test(footer);
    });
    const beforeReload = provider.codexBodies.length;
    screens.reloaded = await command("/reload", (screen) => screen.includes("Reloaded"));
    screens.statusAfterReload = await command("/codex-fast status", (screen) => screen.includes("Codex fast mode: enabled"));
    const settingsPath = path.join(family.agent, "killeros.json");
    if (existsSync(settingsPath)) {
      assert.doesNotMatch(readFileSync(settingsPath, "utf8"), /fast|codex/iu, "The live preference must never persist to settings");
    }
    assert.equal(provider.codexBodies.length, beforeReload, "Reload starts no provider request");
    screens.disabled = await command("/codex-fast", (screen) => screen.includes("Fast disabled"));
    screens.disabledTurn = await command("plain again", (screen) => screen.includes("Fast response 3"));
    assert.equal("service_tier" in (provider.codexBodies[2] ?? {}), false, "Disabling fast removes the tier again");
    assert.equal(provider.otherBodies.length, 0, "The TUI family never prompts on the non-eligible provider");
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    terminal = undefined;

    // Family 2: RPC keeps the same process-local contract through notifications and payloads.
    let rpc: PiRpcProcess | undefined;
    try {
      const rpcSession = path.join(family.directory, "session-fast-rpc.jsonl");
      rpc = new PiRpcProcess({ cliPath, cwd: family.project, env: family.env,
        args: ["--mode", "rpc", "--model", "openai-codex/codex-local", "--thinking", "off", "--tools", "read",
          "--session", rpcSession, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts")] });
      const state = record((await rpc.command("get_state", {}, { timeoutMs: 30_000, signal: t.signal })).data, "RPC state");
      assert.equal(stringField(state, "sessionFile"), rpcSession);
      const commandData = record((await rpc.command("get_commands", {}, { timeoutMs: 30_000, signal: t.signal })).data, "RPC commands");
      assert.ok(Array.isArray(commandData.commands));
      assert.equal(commandData.commands.filter((entry) => record(entry, "command").name === "codex-fast").length, 1);
      const rpcCommand = async (message: string, expected: string, level: "info" | "error"): Promise<void> => {
        const before = rpc!.currentSequence;
        const requests = provider.codexBodies.length;
        await rpc!.command("prompt", { message }, { timeoutMs: 30_000, signal: t.signal });
        const notice = await rpc!.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify",
          { after: before, signal: t.signal, timeoutMs: 30_000 });
        assert.equal(notice.message, expected);
        assert.equal(notice.notifyType, level);
        assert.equal(provider.codexBodies.length, requests, `${message} starts no provider request`);
      };
      const rpcTurn = async (message: string, tier: "priority" | undefined): Promise<void> => {
        const before = rpc!.currentSequence;
        const requests = provider.codexBodies.length;
        await rpc!.command("prompt", { message }, { timeoutMs: 60_000, signal: t.signal });
        await rpc!.waitFor((entry) => entry.type === "agent_settled", { after: before, signal: t.signal, timeoutMs: 60_000 });
        assert.equal(provider.codexBodies.length, requests + 1);
        assert.equal(provider.codexBodies[requests]?.model, "codex-local");
        assert.equal(provider.codexBodies[requests]?.service_tier, tier);
        assert.ok(JSON.stringify(provider.codexBodies[requests]?.messages).includes(message), "The request retains its user input");
      };
      await rpcCommand("/codex-fast status", "Codex fast mode: disabled", "info");
      await rpcTurn("status disabled control", undefined);
      await rpcCommand("/codex-fast", "Fast enabled", "info");
      const beforeNotifications = rpc.currentSequence;
      const rpcBefore = provider.codexBodies.length;
      await rpc.command("prompt", { message: "rpc priority turn" }, { timeoutMs: 60_000, signal: t.signal });
      await rpc.waitFor((entry) => entry.type === "agent_settled", { after: beforeNotifications, signal: t.signal, timeoutMs: 60_000 });
      assert.equal(provider.codexBodies[rpcBefore]?.service_tier, "priority", "RPC payloads gain the priority tier after the toggle");
      const beforeStatus = rpc.currentSequence;
      await rpc.command("prompt", { message: "/codex-fast status" }, { timeoutMs: 30_000, signal: t.signal });
      await rpc.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify" && typeof entry.message === "string" && entry.message.includes("Codex fast mode: enabled"), { after: beforeStatus, signal: t.signal });
      await rpcCommand("/codex-fast   status  ", "Codex fast mode: enabled", "info");
      await rpcTurn("status enabled control", "priority");
      for (const argument of ["on", "off now"]) {
        await rpcCommand(`/codex-fast ${argument}`, "Usage: /codex-fast [status]", "error");
        await rpcTurn(`after invalid ${argument}`, "priority");
      }
      await rpcCommand("/codex-fast", "Fast disabled", "info");
      await rpcTurn("after disabling fast", undefined);
      await rpcCommand("/codex-fast", "Fast enabled", "info");
      await rpcTurn("after re-enabling fast", "priority");
      const switched = await rpc.command("set_model", { provider: "fast-other", modelId: "other-model" }, { timeoutMs: 30_000, signal: t.signal });
      assert.equal(stringField(record(switched.data, "set_model data"), "id"), "other-model", "Switching to the non-eligible provider selects its model");
      const ineligibleBefore = provider.otherBodies.length;
      const beforeIneligibleTurn = rpc.currentSequence;
      await rpc.command("prompt", { message: "ineligible provider turn" }, { timeoutMs: 60_000, signal: t.signal });
      await rpc.waitFor((entry) => entry.type === "agent_settled", { after: beforeIneligibleTurn, signal: t.signal, timeoutMs: 60_000 });
      assert.equal(provider.otherBodies.length, ineligibleBefore + 1, "The ineligible provider serves its own turn");
      assert.equal("service_tier" in (provider.otherBodies[0] ?? {}), false, "The live preference transforms only eligible requests");
      const beforeIneligibleStatus = rpc.currentSequence;
      await rpc.command("prompt", { message: "/codex-fast status" }, { timeoutMs: 30_000, signal: t.signal });
      await rpc.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify" && typeof entry.message === "string" && entry.message.includes("Codex fast mode: enabled"), { after: beforeIneligibleStatus, signal: t.signal },
      );
      assert.deepEqual(await rpc.close(), { exit: { code: 0, signal: null }, forced: false });
    } catch (error) {
      failures.push(error);
      oneShotResults.rpc = { error: error instanceof Error ? error.message : String(error), diagnostics: rpc?.diagnostics() };
    } finally {
      if (rpc) {
        try {
          const result = await rpc.close();
          if (result.forced || result.exit.code !== 0) failures.push(new Error(`Fast RPC cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
    }

    // Family 3: one-shot print and JSON invocations execute the registered command cleanly and
    // cannot carry process-local state across separate processes (no footer, no settings write).
    let oneShotRequests = provider.codexBodies.length;
    for (const mode of ["print", "json"] as const) {
      const result = spawnSync(process.execPath, [cliPath, ...(mode === "json" ? ["--mode", "json"] : []), "--print",
        "--model", "openai-codex/codex-local", "--thinking", "off", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts"),
        "--session", path.join(family.directory, `session-oneshot-${mode}.jsonl`), "--offline",
        "/codex-fast status"], { cwd: family.project, env: family.env, encoding: "utf8", timeout: 90_000, windowsHide: true });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      oneShotResults[mode] = { code: result.status, output: output.slice(-400) };
      assert.equal(result.status, 0, `${mode} one-shot exits cleanly with the command registered`);
      assert.doesNotMatch(output, /usage: \/codex-fast|unknown command/iu, `${mode} one-shot reports no command failure`);
      assert.equal(provider.codexBodies.length, oneShotRequests, `${mode} one-shot starts no provider request`);
      oneShotRequests = provider.codexBodies.length;
    }
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Fast terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    try { await provider.close(); } catch (error) { cleanupFailures.push(error); }
  }
  if (failure !== undefined || failures.length > 0 || cleanupFailures.length > 0 || provider.errors.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Fast local scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...failures, ...cleanupFailures,
        ...provider.errors.map((fault) => fault instanceof Error ? fault : new Error(String(fault)))],
      diagnostics: JSON.stringify({ directory: family.directory, platform: process.platform, node: process.version, pi: piVersion,
        codexRequests: provider.codexBodies.length, otherRequests: provider.otherBodies.length, providerErrors: provider.errors,
        terminal: terminal?.diagnostics(), oneShotResults, screens }),
    });
  }
  await removeDirectoryEventually(family.directory);
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.fast-local", piLaunches: 4,
    codexRequests: provider.codexBodies.length, otherRequests: provider.otherBodies.length, cleanup: "scratch removed" }));
});

test("real Pi /codex-fast transforms only eligible payloads and survives reload", { timeout: 240_000 }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "payload");
  const captureFile = path.join(family.directory, "captured.jsonl");
  const fixtureExtension = path.join(family.directory, "fast-native-wrapper.ts");
  const beforeFile = path.join(family.directory, "before.jsonl");
  const observerExtension = path.join(family.directory, "observe-fast.ts");
  const inputFile = path.join(family.directory, "input.json");
  writeFileSync(inputFile, "{}");
  writeFileSync(observerExtension, String.raw`import fs from "node:fs";
export default function(pi) {
  pi.on("before_provider_request", (event) => {
    const input = JSON.parse(fs.readFileSync(process.env.FAST_INPUT_FILE, "utf8"));
    if (input.undefinedPayload) {
      fs.appendFileSync(process.env.FAST_BEFORE_FILE, JSON.stringify({ undefinedPayload: true }) + "\n");
      return;
    }
    let payload = event.payload;
    if (Object.hasOwn(input, "replacement")) payload = input.replacement;
    else {
      payload = { ...payload, ...input.fields };
      if (input.removeModel) delete payload.model;
    }
    fs.appendFileSync(process.env.FAST_BEFORE_FILE, JSON.stringify(payload) + "\n");
    return payload;
  });
}`);
  // Public-API fixture: keeps Pi's native openai-responses implementation and swaps only its HTTP transport.
  writeFileSync(fixtureExtension, String.raw`import fs from "node:fs";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const native = openaiProvider();
const capture = process.env.FAST_CAPTURE_FILE ?? "";
const baseModels = native.getModels().filter((model) => model.provider === "openai" && model.api === "openai-responses");
const variant = (id, baseUrl) => ({ ...baseModels[0], id, name: id, baseUrl });
const fetchCapture = async (input, init) => {
  const request = new Request(input, init);
  const body = await request.text();
  fs.appendFileSync(capture, JSON.stringify({ url: request.url, authorization: request.headers.get("authorization"), body }) + "\n");
  return new Response(JSON.stringify({ error: { message: "Priority is not available for this fixture account",
    type: "invalid_request_error", code: "priority_rejected" } }),
    { status: 400, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
};
const streamSimple = (model, context, options) => {
  const input = JSON.parse(fs.readFileSync(process.env.FAST_INPUT_FILE, "utf8"));
  if (!Object.hasOwn(input, "replacement") && !input.undefinedPayload) {
    return native.streamSimple(model, context, { ...options, fetch: fetchCapture, maxRetries: 1 });
  }
  // The native SDK dereferences body.stream before transport for null. The documented custom
  // provider contract can send every unknown payload value without replacing any host method.
  const stream = createAssistantMessageEventStream();
  const fail = (errorMessage) => stream.push({ type: "error", reason: "error", error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage, timestamp: Date.now(),
  } });
  void (async () => {
    const original = input.undefinedPayload ? undefined : { model: model.id, input: [] };
    const replacement = await options?.onPayload?.(original, model);
    const payload = replacement === undefined ? original : replacement;
    const response = await fetchCapture(model.baseUrl + "/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(input.undefinedPayload && payload === undefined ? { undefinedPayload: true } : payload),
    });
    await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    await response.text();
    fail("Fixture rejected payload");
  })().catch((error) => fail(String(error)));
  return stream;
};
export default function (pi) {
  pi.registerProvider({
    ...native,
    getModels: () => [
      variant("fast-canonical", "https://api.openai.com/v1"),
      variant("fast-slash", "https://api.openai.com/v1/"),
      variant("fast-invalid-host", "https://example.invalid/v1"),
      variant("fast-insecure", "http://api.openai.com/v1"),
      variant("fast-double-slash", "https://api.openai.com/v1//"),
      variant("fast-responses-path", "https://api.openai.com/v1/responses"),
      variant("fast-query", "https://api.openai.com/v1?test=1"),
      { ...baseModels[0], id: "fast-completions-api", name: "fast completions api", api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
      { ...variant("fast-custom-api", "https://api.openai.com/v1"), api: "virtual" },
    ],
    streamSimple,
  });
  // A public provider registration uses the same native serializer and captured HTTP transport.
  pi.registerProvider({
    ...native, id: "openai-codex",
    getModels: () => [{ ...variant("fast-codex", "https://example.invalid/v1"), provider: "openai-codex" }],
    streamSimple,
  });
  for (const id of ["anthropic", "OpenAI", "azure"]) {
    pi.registerProvider({
      ...native, id,
      getModels: () => [{ ...variant("fast-excluded", "https://api.openai.com/v1"), provider: id }],
      streamSimple,
    });
  }
}
`);
  writeFileSync(path.join(family.agent, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: "fast-fixture-access-token", refresh: "fast-fixture-refresh-token", expires: Date.now() + 3_600_000,
    clientId: "fast-fixture-client", scopes: ["chatgpt.tokens.use.direct"] },
    "openai-codex": { type: "api_key", key: "fast-fixture-only" },
    anthropic: { type: "api_key", key: "fast-fixture-only" },
    OpenAI: { type: "api_key", key: "fast-fixture-only" },
    azure: { type: "api_key", key: "fast-fixture-only" } }));
  writeFileSync(path.join(family.agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
  let rpc: PiRpcProcess | undefined;
  const cleanupFailures: unknown[] = [];
  let failure: unknown;
  const rpcDiagnostics: RecordValue = {};
  try {
    rpc = new PiRpcProcess({ cliPath, cwd: family.project, env: { ...family.env, FAST_CAPTURE_FILE: captureFile, FAST_BEFORE_FILE: beforeFile, FAST_INPUT_FILE: inputFile },
      args: ["--mode", "rpc", "--model", "openai/fast-canonical", "--thinking", "off", "--tools", "read",
        "--session", path.join(family.directory, "session-payload.jsonl"), "--offline", "--approve", "--no-context-files",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
        "--extension", observerExtension, "--extension", path.join(repositoryRoot, "Killeros.ts"), "--extension", fixtureExtension] });
    const captured = (): Array<{ url: string; authorization: string | null; body: unknown; rawBody: string }> => {
      if (!existsSync(captureFile)) return [];
      return readFileSync(captureFile, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => {
        const stored = JSON.parse(line) as { url: string; authorization: string | null; body: string };
        let body: unknown;
        try { body = JSON.parse(stored.body); }
        catch { body = stored.body === "" ? null : stored.body; }
        return { url: stored.url, authorization: stored.authorization, body, rawBody: stored.body };
      });
    };
    const turn = async (message: string, label: string, input: RecordValue = {}, priority?: boolean): Promise<void> => {
      writeFileSync(inputFile, JSON.stringify(input));
      const requestCount = captured().length;
      const before = rpc!.currentSequence;
      await rpc!.command("prompt", { message }, { timeoutMs: 60_000, signal: t.signal });
      await rpc!.waitFor((entry) => entry.type === "agent_settled", { after: before, signal: t.signal, timeoutMs: 60_000 });
      const requests = captured();
      assert.equal(requests.length, requestCount + 1, `Exactly one HTTP request: ${label}`);
      const beforePayloads = readFileSync(beforeFile, "utf8").trim().split(/\r?\n/u).map((line): unknown => JSON.parse(line));
      assert.equal(beforePayloads.length, requests.length, "Every transport request has a pre-hook observation");
      const original = beforePayloads.at(-1);
      const addPriority = priority ?? !(label === "disabled" || label.startsWith("fast-") || label === "completions");
      const expected = addPriority ? { ...record(original, "eligible original"), service_tier: "priority" } : original;
      assert.deepEqual(requests.at(-1)?.body, expected, `Complete serialized payload preserved: ${label}`);
      assert.equal(requests.at(-1)?.rawBody, JSON.stringify(expected),
        `Exact native serialized bytes: ${label}`);
      rpcDiagnostics[label] = requests.length;
      rpc!.acknowledge(rpc!.currentSequence);
    };
    await rpc.command("get_state", {}, { timeoutMs: 30_000, signal: t.signal });
    await turn("disabled turn", "disabled");
    let requests = captured();
    assert.equal(requests.length, 1, "The disabled run makes exactly one native request");
    assert.equal("service_tier" in record(requests[0]?.body, "disabled body"), false, "Disabled fast mode preserves the serialized payload without a tier");
    assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses", "The native transport keeps its endpoint");
    assert.match(requests[0]?.authorization ?? "", /^Bearer /u, "Authentication shape is preserved");
    assert.equal(record(requests[0]?.body, "disabled body").model, "fast-canonical", "The payload keeps the exact model identity");

    const beforeToggle = rpc.currentSequence;
    await rpc.command("prompt", { message: "/codex-fast" }, { timeoutMs: 30_000, signal: t.signal });
    await rpc.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify" && typeof entry.message === "string" && entry.message.includes("Fast enabled"), { after: beforeToggle, signal: t.signal });

    const select = async (modelId: string, provider = "openai"): Promise<void> => {
      const response = await rpc!.command("set_model", { provider, modelId }, { timeoutMs: 30_000, signal: t.signal });
      assert.equal(stringField(record(response.data, "set_model data"), "id"), modelId, `Selecting ${modelId}`);
    };
    await select("fast-canonical");
    await turn("canonical turn", "canonical");
    for (const argument of ["on", "off now"]) {
      const cursor = rpc.currentSequence;
      await rpc.command("prompt", { message: `/codex-fast ${argument}` }, { signal: t.signal });
      const notice = await rpc.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify", { after: cursor, signal: t.signal });
      assert.equal(notice.message, "Usage: /codex-fast [status]");
      assert.equal(notice.notifyType, "error");
      await turn(`invalid argument ${argument}`, `invalid-${argument}`);
    }
    await select("fast-slash");
    await turn("slash turn", "slash");
    requests = captured();
    assert.equal(requests.length, 5, "Each turn makes exactly one captured native request");
    for (const request of requests.slice(1)) {
      assert.equal(record(request.body, "eligible body").service_tier, "priority", "Eligible native Responses payloads gain the priority tier");
    }
    const ineligibleIds = ["fast-invalid-host", "fast-insecure", "fast-double-slash", "fast-responses-path", "fast-query"];
    for (const modelId of ineligibleIds) {
      await select(modelId);
      await turn(`ineligible ${modelId}`, modelId);
    }
    await select("fast-completions-api");
    await turn("completions turn", "completions");
    requests = captured();
    assert.equal(requests.length, 5 + ineligibleIds.length + 1, "Every turn makes exactly one captured native request");
    for (const request of requests.slice(5)) {
      assert.equal("service_tier" in record(request.body, "ineligible body"), false, `Non-canonical or non-Responses requests pass through unchanged (${request.url})`);
    }
    for (const modelId of [...ineligibleIds, "fast-completions-api"]) {
      await select(modelId);
      await turn("ineligible flex", `${modelId}-flex`, { fields: { input: [], service_tier: "flex" } }, false);
    }

    // Eligibility re-evaluates per request: switching back to the canonical model transforms again.
    await select("fast-canonical");
    await turn("eligible again", "eligible-again");
    requests = captured();
    assert.equal(record(requests.at(-1)?.body, "eligible again body").service_tier, "priority", "The live preference still transforms eligible payloads after model switches");

    for (const modelId of ["fast-canonical", "fast-slash"]) {
      await select(modelId);
      for (const tier of [undefined, "flex", "default", "priority"]) {
        await turn("tier overwrite", `${modelId}-tier-${tier ?? "absent"}`, {
          fields: { input: [], metadata: { task: "test" }, ...(tier === undefined ? {} : { service_tier: tier }) },
        }, true);
      }
    }
    await select("fast-canonical");
    for (const input of [
      { removeModel: true, fields: { input: [] } },
      { fields: { model: "another-model", input: [], service_tier: "flex" } },
      { fields: { model: null, input: [], service_tier: "flex" } },
    ]) {
      await turn("ambiguous model", `ambiguous-${JSON.stringify(input)}`, input, false);
    }
    await select("fast-custom-api");
    await turn("custom API", "custom-api", { fields: { service_tier: "flex" } }, false);
    for (const provider of ["anthropic", "OpenAI", "azure"]) {
      await select("fast-excluded", provider);
      await turn("excluded provider", `excluded-${provider}`, { fields: { service_tier: "flex" } }, false);
    }
    for (const provider of ["openai", "openai-codex"]) {
      await select(provider === "openai" ? "fast-canonical" : "fast-codex", provider);
      for (const replacement of [null, [], "request", 42]) {
        await turn("non-object payload", `${provider}-invalid-${JSON.stringify(replacement)}`, { replacement }, false);
      }
      await turn("undefined payload", `${provider}-invalid-undefined`, { undefinedPayload: true }, false);
      if (provider === "openai-codex") {
        await turn("Codex model-less payload", "codex-model-less", {
          removeModel: true, fields: { input: [], service_tier: "flex" },
        }, true);
      }
    }
    const toggleCursor = rpc.currentSequence;
    await rpc.command("prompt", { message: "/codex-fast" }, { signal: t.signal });
    await rpc.waitFor((entry) => entry.type === "extension_ui_request" && entry.method === "notify" && entry.message === "Fast disabled",
      { after: toggleCursor, signal: t.signal });
    for (const provider of ["openai", "openai-codex"]) {
      await select(provider === "openai" ? "fast-canonical" : "fast-codex", provider);
      for (const tier of [undefined, "flex"]) {
        await turn("disabled tier preservation", `${provider}-disabled-${tier ?? "absent"}`, {
          fields: { input: [], ...(tier === undefined ? {} : { service_tier: tier }) },
        }, false);
      }
    }
    assert.equal(captured().length, 48, "The complete payload domain makes exactly 48 HTTP requests");
    rpcDiagnostics.totalRequests = captured().length;
    assert.deepEqual(await rpc.close(), { exit: { code: 0, signal: null }, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (rpc) {
      try {
        const result = await rpc.close();
        if (result.forced || result.exit.code !== 0) cleanupFailures.push(new Error(`Fast payload RPC cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
  }
  if (failure !== undefined || cleanupFailures.length > 0) {
    const capturedTail = existsSync(captureFile) ? readFileSync(captureFile, "utf8").slice(-4_000) : "";
    throwScenarioFailure({ directory: family.directory, message: "Fast payload scenario failed",
      errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      diagnostics: JSON.stringify({ directory: family.directory, platform: process.platform, node: process.version, pi: piVersion,
        capturedTail, rpc: rpc?.diagnostics(), rpcDiagnostics }),
    });
  }
  await removeDirectoryEventually(family.directory);
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.fast-payload-reload", piLaunches: 1,
    providerRequests: rpcDiagnostics.totalRequests, cleanup: "scratch removed" }));
});
