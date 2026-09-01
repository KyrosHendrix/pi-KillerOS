import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createHarness } from "./ExtensionTestHarness.ts";

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

test("real Pi delivery starts one hidden ordinary continuation after turn_end -> agent_settled -> compaction", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-auto-compaction-lifecycle-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({
      autoCompaction: { enabled: true, percentRemaining: 100 },
    }));
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const faux = fauxProvider({
      provider: "killeros-lifecycle",
      models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }],
    });
    faux.setResponses([
      fauxAssistantMessage("ordinary turn finished"),
      fauxAssistantMessage("continuation turn finished"),
    ]);
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-lifecycle", "local-test-key");

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      settingsManager,
      extensionFactories: [(pi) => {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "Compacted ordinary task context.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendMessage({ role: "user", content: "Earlier task context", timestamp: Date.now() - 2 });
    sessionManager.appendMessage(fauxAssistantMessage("Earlier work", { timestamp: Date.now() - 1 }));
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      noTools: "all",
    });
    let agentStarts = 0;
    const lifecycleErrors: string[] = [];
    let continuationFinished: (() => void) | undefined;
    const continuation = new Promise<void>((resolve) => { continuationFinished = resolve; });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") agentStarts++;
      if (event.type === "message_end"
        && event.message.role === "assistant"
        && event.message.content.some((part) => part.type === "text" && part.text === "continuation turn finished")) {
        continuationFinished?.();
      }
    });
    try {
      await session.bindExtensions({
        mode: "rpc",
        shutdownHandler() {},
        onError(diagnostic) { lifecycleErrors.push(`${diagnostic.event}: ${diagnostic.error}`); },
      });
      await session.prompt("Continue the ordinary task");
      await continuation;
      await session.waitForIdle();

      assert.equal(agentStarts, 2);
      assert.equal(faux.state.callCount, 2);
      const internalMessages = session.messages.filter((message) => message.role === "custom"
        && message.customType === "killeros-auto-compaction");
      assert.equal(internalMessages.length, 1);
      const internalMessage = internalMessages[0];
      assert.ok(internalMessage?.role === "custom");
      assert.equal(internalMessage.display, false);
      assert.equal(session.messages.some((message) => message.role === "user"
        && typeof message.content === "string"
        && message.content.includes("Continue the interrupted task")), false);
      assert.equal(session.pendingMessageCount, 0);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      unsubscribe();
      session.dispose();
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("all KillerOS tools expose provider-compatible object schemas", () => {
  const { tools } = createHarness();

  for (const tool of tools.values()) {
    const rawSchema: unknown = JSON.parse(JSON.stringify(tool.parameters));
    assert.ok(isUnknownRecord(rawSchema), `${tool.name} schema must be a JSON object`);
    const schema = rawSchema;
    assert.equal(schema.type, "object", `${tool.name} must use a top-level object schema`);
    assert.equal(typeof schema.properties, "object", `${tool.name} must declare object properties`);
    assert.equal(schema.anyOf, undefined, `${tool.name} must not use a top-level anyOf`);
    assert.equal(schema.oneOf, undefined, `${tool.name} must not use a top-level oneOf`);
  }
});
