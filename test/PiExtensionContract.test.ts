import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { Type } from "typebox";
import { parseArgs } from "../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import {
  createAgentSession,
  createAgentSessionRuntime,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerRequestActivity } from "../killeros/activity.ts";
import { registerAutoCompaction } from "../killeros/auto-compaction.ts";
import { registerCodexFastMode } from "../killeros/codex-fast.ts";
import { isCodexFastEnabled, resetCodexFastState } from "../killeros/codex-fast-state.ts";
import { registerCompletionNotifications } from "../killeros/notifications.ts";
import { registerWorkedFor } from "../killeros/worked-for.ts";
import { registerGoalInterface } from "../killeros/goal-interface.ts";
import { registerQuestionTool } from "../killeros/question.ts";
import { registerGoalRuntime } from "../killeros/goal-runtime.ts";
import { registerGoalSettlement } from "../killeros/goal-settlement.ts";
import { registerHandoff } from "../killeros/handoff.ts";
import { registerFooter } from "../killeros/footer.ts";
import { createGoalRuntime } from "../killeros/runtime.ts";
import { createNewGoalState, parseGoalState, transitionGoalState } from "../killeros/goal-state.ts";
import { createHarness, createTuiContext, removeDirectoryEventually, theme, waitFor } from "./ExtensionTestHarness.ts";
import { extensionContextTestAdapter } from "./PiTestAdapters.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const piManifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
assert.ok(isUnknownRecord(piManifest) && typeof piManifest.version === "string");
const piHasModifiers = Number(piManifest.version.split(".")[1]) >= 1;

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

function assertInstalledPackage(directory: string, expectedVersion: string): void {
  for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
    assert.equal(existsSync(path.join(directory, file)), true, `Package is missing: ${file}`);
  }
  const identity: unknown = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
  assert.ok(isUnknownRecord(identity));
  assert.equal(identity.name, "killeros", "Unexpected package name");
  assert.equal(identity.version, expectedVersion, "Unexpected package version");
}

test("installed archive assertions reject every missing required file and incorrect package identity", async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-package-assertions-"));
  try {
    for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      writeFileSync(path.join(directory, file), "fixture");
    }
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "killeros", version: "3.0.3" }));
    assertInstalledPackage(directory, "3.0.3");
    for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
      unlinkSync(path.join(directory, file));
      assert.throws(() => assertInstalledPackage(directory, "3.0.3"), { message: new RegExp(file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u") });
      writeFileSync(path.join(directory, file), "fixture");
    }
    for (const identity of [{ name: "not-killeros", version: "3.0.3" }, { name: "killeros", version: "3.0.2" }]) {
      writeFileSync(path.join(directory, "package.json"), JSON.stringify(identity));
      assert.throws(() => assertInstalledPackage(directory, "3.0.3"));
    }
  } finally {
    await removeDirectoryEventually(directory);
  }
});

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
    const manifest: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.ok(isUnknownRecord(manifest));
    assert.ok(typeof manifest.version === "string");
    assertInstalledPackage(installedPackage, manifest.version);

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
      noTools: "builtin",
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
      for (const name of ["question", "killeros_goal_update"]) {
        assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
        assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
        assert.equal(session.getCallableToolNames().includes(name), false);
      }

      await session.reload();

      const secondRunner = session.extensionRunner;
      const secondCommands = secondRunner.getRegisteredCommands().map(({ invocationName }) => invocationName);
      assert.notEqual(secondRunner, firstRunner);
      assert.throws(() => oldContext.mode, /stale/u);
      assert.deepEqual(secondCommands, firstCommands);
      assert.deepEqual(secondRunner.getCommandDiagnostics(), []);
      for (const name of ["question", "killeros_goal_update"]) {
        assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
        assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
        assert.equal(session.getCallableToolNames().includes(name), false);
      }
      assert.deepEqual(lifecycle, ["start:startup", "shutdown:reload", "start:reload"]);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      session.dispose();
    }
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("KillerOS initialization and reload preserve unset Pi display preferences", async (t) => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    await t.test(mode, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-display-preferences-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const settingsPath = path.join(agentDir, "settings.json");
        writeFileSync(settingsPath, "{}\n");
        const settingsManager = SettingsManager.create(cwd, agentDir);
        const before = {
          tuiMode: settingsManager.getTuiMode(),
          quietStartup: settingsManager.getQuietStartup(),
        };
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager,
          additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
          modelRuntime: await ModelRuntime.create({
            authPath: path.join(agentDir, "auth.json"), modelsPath: null,
            modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
          }),
        }));
        const errors: string[] = [];
        const { ctx, captured } = createTuiContext();
        await session.bindExtensions({
          mode, uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        if (mode === "tui") {
          assert.equal(typeof captured.headerFactory, "function");
          assert.equal(typeof captured.editorFactory, "function");
          assert.equal(typeof captured.footerFactory, "function");
        }
        for (const stage of ["startup", "reload"] as const) {
          if (stage === "reload") await session.reload();
          await settingsManager.flush();
          assert.equal(settingsManager.getTuiMode(), before.tuiMode, stage);
          assert.equal(settingsManager.getQuietStartup(), before.quietStartup, stage);
          assert.equal(settingsManager.getGlobalSettings().tuiMode, undefined, stage);
          assert.equal(settingsManager.getGlobalSettings().quietStartup, undefined, stage);
          assert.equal(readFileSync(settingsPath, "utf8"), "{}\n", stage);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(settingsManager.drainErrors(), []);
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real native OpenAI transport preserves thinking-level sampling with priority and provider retries", { timeout: 30_000 }, async (t) => {
  for (const [label, apiKey, status, expectedRequests] of [
    ["API-key rejection", "sk-local-test-key", 400, 1],
    ["ChatGPT subscription rejection", "local-test-chatgpt-token", 400, 1],
    ["Pi provider retry", "sk-local-test-key", 429, 2],
  ] as const) {
    await t.test(label, async () => {
      resetCodexFastState();
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-openai-fast-"));
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const bodies: Record<string, unknown>[] = [];
        const fakeFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          assert.equal(request.url, "https://api.openai.com/v1/responses");
          assert.equal(request.method, "POST");
          assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
          const body: unknown = await request.json();
          assert.ok(isUnknownRecord(body));
          bodies.push(body);
          return new Response(JSON.stringify({ error: {
            message: "Priority is not available for this test account", type: "invalid_request_error", code: "priority_rejected",
          } }), { status, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
        };
        const native: Provider = openaiProvider();
        const model = native.getModels().find((model) => model.id === "gpt-6.1-sol");
        assert.ok(model);
        assert.equal(model.provider, "openai");
        assert.equal(model.api, "openai-responses");
        assert.equal(model.baseUrl, "https://api.openai.com/v1");
        if (!apiKey.startsWith("sk-")) {
          writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ openai: {
            type: "oauth", access: apiKey, refresh: "local-test-refresh-token", expires: Date.now() + 3_600_000,
            clientId: "local-test-client", scopes: ["chatgpt.tokens.use.direct"],
          } }));
        }
        const modelsPath = path.join(agentDir, "models.json");
        writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { modelOverrides: {
          [model.id]: {
            samplingParams: { temperature: 1, top_p: 0.95 },
            samplingParamsByThinkingLevel: {
              high: { temperature: 0.6 },
              low: { temperature: 0.2, top_p: 0.8 },
            },
          },
        } } } }));
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider({
          ...native,
          // Keep Pi's native Responses implementation and replace only its HTTP transport.
          streamSimple: (model, context, options) => native.streamSimple(model, context, {
            ...options, fetch: fakeFetch, maxRetries: 1,
          }),
        });
        if (apiKey.startsWith("sk-")) await modelRuntime.setRuntimeApiKey("openai", apiKey);
        assert.equal(modelRuntime.isUsingSubscription("openai"), !apiKey.startsWith("sk-"));
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
          noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [registerCodexFastMode],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const configuredModel = modelRuntime.getModel("openai", model.id);
        assert.ok(configuredModel);
        const { session } = await createAgentSession({
          cwd, agentDir, model: configuredModel, modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), noTools: "all",
        });
        const errors: string[] = [];
        try {
          await session.bindExtensions({ mode: "json", onError(error) { errors.push(`${error.event}: ${error.error}`); } });
          await session.prompt("/codex-fast");
          assert.equal(isCodexFastEnabled(), true);
          await session.reload();
          assert.equal(isCodexFastEnabled(), true);
          assert.equal(modelRuntime.isUsingSubscription("openai"), !apiKey.startsWith("sk-"));
          for (const [thinkingLevel, temperature, topP] of [["high", 0.6, 0.95], ["low", 0.2, 0.8]] as const) {
            session.setThinkingLevel(thinkingLevel);
            assert.equal(session.thinkingLevel, thinkingLevel);
            const firstRequest = bodies.length;
            await session.prompt("Test priority rejection locally");
            await session.waitForIdle();

            // HTTP 400 is not retryable. HTTP 429 gets exactly one configured Pi provider retry.
            const requests = bodies.slice(firstRequest);
            assert.equal(requests.length, expectedRequests);
            for (const body of requests) {
              assert.equal(body.model, model.id);
              assert.equal(body.service_tier, "priority");
              assert.equal(body.temperature, temperature);
              assert.equal(body.top_p, topP);
              assert.ok(Array.isArray(body.input));
            }
            const response = session.messages.filter((message) => message.role === "assistant").at(-1);
            assert.ok(response?.role === "assistant");
            assert.equal(response.stopReason, "error");
            assert.match(response.errorMessage ?? "", /Priority is not available for this test account/u);
          }
          assert.deepEqual(errors, []);
        } finally {
          session.dispose();
        }
      } finally {
        resetCodexFastState();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi Azure Responses and Foundry requests survive reload without OpenAI priority", { timeout: 30_000 }, async (t) => {
  for (const [id, api, endpoint] of [
    ["gpt-6.1-sol", "azure-openai-responses", "responses"],
    ["deepseek-v4-pro", "openai-completions", "chat/completions"],
  ] as const) {
    await t.test(api, async () => {
      resetCodexFastState();
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-azure-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const modelsPath = path.join(agentDir, "models.json");
        writeFileSync(modelsPath, JSON.stringify({ providers: { azure: { modelOverrides: {
          [id]: { samplingParams: { top_p: 0.8 }, samplingParamsByThinkingLevel: { high: { temperature: 0.6 } } },
        } } } }));
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        const native = modelRuntime.getProvider("azure");
        assert.ok(native, "Pi must expose the renamed Azure provider");
        const model = modelRuntime.getModel("azure", id);
        assert.ok(model, `Azure must expose ${id}`);
        assert.equal(model.api, api);
        const bodies: Record<string, unknown>[] = [];
        const fakeFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          assert.equal(url.origin, "https://killeros-test.ai.azure.com");
          assert.ok(url.pathname.endsWith(`/${endpoint}`), url.pathname);
          assert.equal(request.method, "POST");
          const body: unknown = await request.json();
          assert.ok(isUnknownRecord(body));
          bodies.push(body);
          return new Response(JSON.stringify({ error: { message: "Local Azure test rejection" } }), {
            status: 400, headers: { "content-type": "application/json" },
          });
        };
        modelRuntime.registerNativeProvider({
          ...native,
          streamSimple: (model, context, options) => native.streamSimple(model, context, {
            ...options, fetch: fakeFetch, maxRetries: 0,
            env: { ...options?.env, AZURE_OPENAI_BASE_URL: "https://killeros-test.ai.azure.com",
              AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${id}=local-deployment` },
          }),
        });
        await modelRuntime.setRuntimeApiKey("azure", "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
          noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerCodexFastMode(pi);
            registerFooter(pi, createGoalRuntime());
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.inMemory(cwd), noTools: "all",
        }));
        const errors: string[] = [];
        const { ctx, captured, tui } = createTuiContext();
        await session.bindExtensions({
          mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        await session.prompt("/codex-fast");
        assert.equal(isCodexFastEnabled(), true);
        for (const stage of ["startup", "reload"] as const) {
          if (stage === "reload") await session.reload();
          assert.equal(session.model?.provider, "azure", stage);
          assert.equal(session.model?.id, id, stage);
          assert.equal(isCodexFastEnabled(), true, stage);
          const footer = captured.footerFactory(tui, theme, {
            getGitBranch: () => undefined, onBranchChange: () => () => {},
          });
          try {
            assert.ok((footer.render(160)[1] ?? "").includes(`${id} azure`));
            assert.doesNotMatch(footer.render(160)[1] ?? "", /\bfast\b/u);
          } finally {
            footer.dispose?.();
          }
          session.setThinkingLevel("high");
          const firstRequest = bodies.length;
          await session.prompt(`Test Azure locally at ${stage}`);
          await session.waitForIdle();
          assert.equal(bodies.length, firstRequest + 1, stage);
          const body = bodies[firstRequest];
          assert.ok(body, stage);
          assert.equal(body.model, "local-deployment", stage);
          assert.equal(body.service_tier, undefined, stage);
          assert.equal(body.temperature, 0.6, stage);
          assert.equal(body.top_p, 0.8, stage);
          const response = session.messages.at(-1);
          assert.ok(response?.role === "assistant", stage);
          assert.equal(response.provider, "azure", stage);
          assert.equal(response.api, api, stage);
          assert.equal(response.model, id, stage);
          assert.equal(response.stopReason, "error", stage);
          assert.match(response.errorMessage ?? "", /Local Azure test rejection/u, stage);
          assert.deepEqual(errors, [], stage);
        }
        assert.equal(bodies.length, 2, "startup and reload must each send one Azure request");
      } finally {
        session?.dispose();
        resetCodexFastState();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi retries preserve active turns and blocked completion permission until settlement", { timeout: 60_000 }, async (t) => {
  for (const [goalStatus, errorMessage] of [
    ["active", "Selected model is at capacity"], ["active", "The pending stream has been canceled"],
    ["blocked", "Selected model is at capacity"], ["blocked", "The pending stream has been canceled"],
    ...(piHasModifiers ? [
      ["active", "server_busy"], ["blocked", "server_busy"],
      ["active", "servers are currently busy"], ["blocked", "servers are currently busy"],
      ["active", "mistral finish_reason:error"], ["blocked", "mistral finish_reason:error"],
    ] as const : []),
  ] as const) {
    await t.test(`${goalStatus}/${errorMessage}`, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-provider-retry-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const runtime = createGoalRuntime();
        const faux = fauxProvider({ provider: "killeros-provider-retry", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        const mistral: Provider | undefined = errorMessage === "mistral finish_reason:error" ? mistralProvider() : undefined;
        const model = mistral?.getModels().find((candidate) => candidate.id === "mistral-small-latest") ?? faux.getModel();
        let transportRequests = 0;
        const fakeFetch: typeof fetch = async (input, init) => {
          const request = new Request(input, init);
          assert.equal(request.url, "https://api.mistral.ai/v1/chat/completions");
          const body: unknown = await request.json();
          assert.ok(isUnknownRecord(body));
          if (transportRequests < 2) {
            assert.ok(Array.isArray(body.tools));
            assert.equal(JSON.stringify(body.tools).includes("killeros_goal_update"), true);
          }
          assert.equal(receipts().length, 0);
          assert.equal(bells, 0);
          transportRequests += 1;
          const delta = transportRequests === 2
            ? { tool_calls: [{ index: 0, id: "abcdefghi", type: "function", function: {
              name: "killeros_goal_update", arguments: JSON.stringify({ status: "complete", evidence: "Recovered and verified" }),
            } }] }
            : { content: transportRequests === 1 ? "" : "Goal finished after recovery" };
          const finish = transportRequests === 1 ? "error" : transportRequests === 2 ? "tool_calls" : "stop";
          return new Response(`data: ${JSON.stringify({ id: "local", model: model.id, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        };
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath: null,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider(mistral ? {
          ...mistral, streamSimple: (model, context, options) => mistral.streamSimple(model, context, { ...options, fetch: fakeFetch }),
        } : faux.provider);
        await modelRuntime.setRuntimeApiKey(model.provider, "local-test-key");
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false }, cacheWarming: "off",
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 },
        });
        settingsManager.setProjectTrusted(true);
        let bells = 0;
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerGoalInterface(pi, runtime);
            registerGoalRuntime(pi, runtime);
            registerWorkedFor(pi, Date.now, async () => ({
              finish: async () => ({ state: "unavailable", reason: "not-git" }),
              dispose: async () => undefined,
            }));
            registerGoalSettlement(pi, runtime);
            registerRequestActivity(pi);
            registerCompletionNotifications(pi, {
              store: { load: () => true, save() {} }, ring: () => { bells += 1; },
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")), noTools: "builtin",
        }));
        const host = session;
        if (goalStatus === "blocked") {
          host.sessionManager.appendCustomEntry("killeros-goal", {
            version: 1, event: "blocked", state: transitionGoalState({
              ...createNewGoalState("Verify provider retry recovery", 0, undefined, Date.now(), { maxTurns: 20 }), turns: 1,
            }, "blocked", "External prerequisite", {}, Date.now()),
          });
        }
        const receipts = () => host.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for");
        const errors: string[] = [];
        const { ctx, captured } = createTuiContext();
        await host.bindExtensions({
          mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        const retries: Array<{ status: string | undefined; turns: number | undefined; maxTurns: number | undefined; receipts: number; bells: number; working: boolean }> = [];
        let recovered = false;
        let settlements = 0;
        let normalizedError: string | undefined;
        faux.setResponses([
          fauxAssistantMessage("", { stopReason: "error", errorMessage }),
          fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Recovered and verified" })),
          fauxAssistantMessage("Goal finished after recovery"),
        ].map((message) => () => {
          assert.equal(receipts().length, 0, "provider follow-ups must not persist receipts before settlement");
          assert.equal(bells, 0, "provider follow-ups must not ring before settlement");
          assert.equal(settlements, 0);
          assert.notEqual(captured.workingMessages.at(-1), undefined);
          return message;
        }));
        let resolveSettled: (() => void) | undefined;
        const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
        const unsubscribe = host.subscribe((event) => {
          if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") normalizedError = event.message.errorMessage;
          if (event.type === "auto_retry_start") retries.push({
            status: runtime.state?.status, turns: runtime.state?.turns, maxTurns: runtime.state?.maxTurns,
            receipts: receipts().length, bells, working: captured.workingMessages.at(-1) !== undefined,
          });
          if (event.type === "auto_retry_end") recovered = event.success;
          if (event.type === "agent_settled") { settlements += 1; resolveSettled?.(); }
        });
        try {
          await host.prompt(goalStatus === "active" ? "/goal Verify provider retry recovery" : "The prerequisite is resolved. Verify and complete the original goal.");
          await settled;
          await host.waitForIdle();
          assert.deepEqual(retries, [{ status: goalStatus, turns: 1, maxTurns: 20, receipts: 0, bells: 0, working: true }]);
          assert.equal(recovered, true);
          assert.equal(mistral ? transportRequests : faux.state.callCount, 3);
          if (mistral) assert.equal(normalizedError, "Provider stopped with: error (server error)");
          assert.equal(runtime.state?.status, "complete");
          assert.equal(runtime.state?.turns, 1);
          assert.equal(runtime.state?.maxTurns, 20);
          assert.equal(settlements, 1);
          const receipt = receipts();
          assert.equal(receipt.length, 1);
          assert.ok(receipt[0]?.type === "custom" && isUnknownRecord(receipt[0].data));
          assert.equal(receipt[0].data.outcome, "done");
          assert.equal(bells, 1);
          assert.equal(captured.workingMessages.at(-1), undefined);
          assert.equal(host.pendingMessageCount, 0);
          assert.equal(runtime.continuationScheduled, false);
          assert.equal(runtime.goalTurnInFlight, false);
          assert.equal(runtime.blockedCompletion, undefined);
          assert.deepEqual(errors, []);
        } finally {
          unsubscribe();
        }
      } finally {
        session?.dispose();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi keeps KillerOS decisions declared and rejects nested calls with every codemode setting", { timeout: 6 * 60_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const codemode of ["disabled", "on", "only"] as const) {
      await t.test(`${mode}/${codemode}`, { timeout: 60_000 }, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-exposure-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        try {
          const cwd = path.join(directory, "project");
          const agentDir = path.join(directory, "agent");
          mkdirSync(cwd);
          mkdirSync(agentDir);
          process.env.PI_CODING_AGENT_DIR = agentDir;
          const provider = `killeros-exposure-${mode}-${codemode}`;
          const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
          const declarations: string[][] = [];
          const prompts: string[] = [];
          const requestInstructions: string[] = [];
          const hiddenGuideline = "KILLEROS_HIDDEN_TOOL_GUIDELINE_104";
          const questionGuideline = "Use question only when user input is required to choose between concrete alternatives";
          const setResponses = (messages: AssistantMessage[]): void => {
            faux.setResponses(messages.map((message) => (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              prompts.push(getCurrentSystemPrompt(context.messages));
              requestInstructions.push(context.messages.map((entry) => typeof entry.content === "string" ? entry.content
                : entry.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")).join("\n"));
              return message;
            }));
          };
          const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
          modelRuntime.registerNativeProvider(faux.provider);
          await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
          const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
          const sessionManager = SessionManager.create(cwd, path.join(directory, "sessions"));
          const goalEntries = () => sessionManager.getEntries()
            .filter((entry) => entry.type === "custom")
            .filter((entry) => entry.customType === "killeros-goal");
          let opened = 0;
          let probes = 0;
          const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              ...(codemode === "disabled" ? [] : [createCodemodeExtension({ mode: codemode })]),
              (pi) => {
                pi.registerTool({
                  name: "exposure_probe", label: "Exposure probe", description: "Check nested tool exclusion",
                  parameters: Type.Object({}), exposure: "model-only", executionMode: "sequential",
                  async execute(_id, _params, _signal, _update, ctx) {
                    probes++;
                    const before = structuredClone(goalEntries());
                    const openedBefore = opened;
                    for (const [name, args] of [
                      ["question", { question: "Choose", options: [{ label: "Alpha" }] }],
                      ["killeros_goal_update", { status: "continue", evidence: "Nested progress", nextAction: "Inspect result" }],
                    ] as const) {
                      assert.equal(ctx.tools.some((tool) => tool.name === name), false);
                      const outcome = await ctx.executeTool(name, args);
                      assert.equal(outcome.isError, true);
                      assert.deepEqual(outcome.result.content, [{ type: "text", text: `Tool ${name} not found` }]);
                    }
                    assert.equal(opened, openedBefore, "nested questions must not open UI");
                    assert.deepEqual(goalEntries(), before, "nested decisions must not persist goal entries");
                    return { content: [{ type: "text", text: "Nested calls rejected" }], details: undefined };
                  },
                });
                pi.registerTool({
                  name: "unrelated", label: "Unrelated", description: "An ordinary direct tool",
                  promptGuidelines: [hiddenGuideline],
                  parameters: Type.Object({}),
                  async execute() { return { content: [{ type: "text", text: "Unchanged" }], details: undefined }; },
                });
              },
            ],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          const { session } = await createAgentSession({
            cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager,
            resourceLoader: loader, tools: ["question", "killeros_*", "exposure_probe", "unrelated", "write", "read", ...(codemode === "disabled" ? [] : ["codemode"])],
          });
          const errors: string[] = [];
          const { ctx } = createTuiContext();
          const ui = extensionContextTestAdapter({ ui: {
            ...ctx.ui,
            async select(_title: string, options: string[]) {
              opened++;
              return options[0];
            },
          } }).ui;
          const assertDeclarations = (start: number, activeGoal: boolean, end = declarations.length): void => {
            const requests = declarations.slice(start, end);
            assert.ok(requests.length > 0, "the provider must receive a request");
            for (const [index, names] of requests.entries()) {
              const prompt = prompts[start + index];
              assert.ok(prompt);
              assert.ok(prompt.includes(questionGuideline), "declared question rules must reach the provider");
              assert.equal(prompt.includes(hiddenGuideline), codemode !== "only", "hidden tool rules must not reach the system prompt");
              assert.equal(names.includes("question"), true, `question missing from ${names.join(", ")}`);
              assert.equal(names.includes("killeros_goal_update"), activeGoal);
              assert.equal(names.includes("exposure_probe"), true);
              assert.equal(names.includes("codemode"), codemode !== "disabled");
              assert.equal(names.includes("unrelated"), codemode !== "only", "codemode-only must actually hide direct tools");
            }
          };
          const runToSettlement = async (start: () => Promise<unknown>, finalText: string): Promise<void> => {
            let finish: (() => void) | undefined;
            const finished = new Promise<void>((resolve) => { finish = resolve; });
            const unsubscribe = session.subscribe((event) => {
              const final = session.messages.filter((message) => message.role === "assistant").at(-1);
              if (event.type === "agent_settled" && final?.role === "assistant"
                && final.content.some((part) => part.type === "text" && part.text === finalText)) finish?.();
            });
            try {
              await start();
              await finished;
              await session.waitForIdle();
              await new Promise<void>((resolve) => setImmediate(resolve));
            } finally {
              unsubscribe();
            }
          };
          const runGoal = async (start: () => Promise<unknown>): Promise<void> => {
            const firstRequest = declarations.length;
            const firstMessage = session.messages.length;
            const openedBefore = opened;
            const probesBefore = probes;
            setResponses([
              fauxAssistantMessage(fauxToolCall("exposure_probe", {}, { id: `probe-${probes}` })),
              fauxAssistantMessage(fauxToolCall("question", { question: "Choose", options: [{ label: "Alpha" }] })),
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Direct completion verified" })),
              fauxAssistantMessage("exposure turn finished"),
            ]);
            await runToSettlement(start, "exposure turn finished");
            assert.equal(probes, probesBefore + 1);
            assert.equal(declarations.length - firstRequest, 4);
            assert.match(requestInstructions[firstRequest], /Before ending this turn, choose exactly one accepted goal decision/u);
            assert.match(requestInstructions[firstRequest], /call killeros_goal_update with status complete/u);
            assertDeclarations(firstRequest, true, firstRequest + 3);
            assertDeclarations(firstRequest + 3, false);
            const results = session.messages.slice(firstMessage).filter((message) => message.role === "toolResult");
            const probe = results.find((result) => result.toolName === "exposure_probe");
            assert.ok(probe);
            assert.equal(probe.isError, false, JSON.stringify(probe.content));
            const question = results.find((result) => result.toolName === "question");
            assert.ok(question);
            assert.equal(opened - openedBefore, mode === "tui" ? 1 : 0);
            assert.equal(question.isError, mode !== "tui");
            assert.deepEqual(question.content, [{ type: "text", text: mode === "tui"
              ? "User selected: Alpha" : "The question tool requires interactive TUI mode" }]);
            if (mode === "tui") assert.deepEqual(question.details, {
              question: "Choose", options: ["Alpha"], answer: "Alpha", selectedIndex: 1, wasCustom: false,
            });
            const completion = results.find((result) => result.toolName === "killeros_goal_update");
            assert.ok(completion);
            assert.equal(completion.isError, false, JSON.stringify(completion.content));
            const saved = goalEntries().at(-1)?.data;
            assert.ok(isUnknownRecord(saved));
            assert.equal(parseGoalState(saved.state)?.status, "complete");
            assert.equal(session.getCallableToolNames().includes("question"), false);
            assert.equal(session.getCallableToolNames().includes("killeros_goal_update"), false);
          };
          try {
            await session.bindExtensions({ mode, uiContext: ui, onError(error) { errors.push(`${error.event}: ${error.error}`); } });
            for (const name of ["question", "killeros_goal_update"]) {
              assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
              assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
            }
            assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false, "wildcard selection must not activate an idle goal tool");
            const unrelatedActive = session.getActiveToolNames();
            setResponses([fauxAssistantMessage("No goal")]);
            await session.prompt("Inspect the declarations without a goal");
            assertDeclarations(0, false);
            assert.doesNotMatch(prompts[0], /Active KillerOS goal/u);

            await runGoal(() => session.prompt("/goal Verify native tool exposure"));

            // Reach blocked through real decisions, reload it, then finish the original file in ordinary work.
            setResponses([1, 2, 3].flatMap((turn) => [
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
                status: "blocked", blockerKey: "external", evidence: `External prerequisite still missing ${turn}`,
              })),
              fauxAssistantMessage(`Blocker turn ${turn} finished`),
            ]));
            await runToSettlement(
              () => session.prompt("/goal Write the Markdown file to `report.md` and verify its contents"),
              "Blocker turn 3 finished",
            );
            const blockedEntry = goalEntries().at(-1)?.data;
            assert.ok(isUnknownRecord(blockedEntry));
            const blocked = parseGoalState(blockedEntry.state);
            assert.ok(blocked?.status === "blocked");
            assert.equal(blocked.turns, 3);
            assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false);
            const requestsBeforeReload = declarations.length;
            await session.reload();
            await session.waitForIdle();
            assert.equal(declarations.length, requestsBeforeReload, "restoring blocked must not start work");
            const firstBlockedRequest = declarations.length;
            const firstBlockedMessage = session.messages.length;
            const work = codemode === "only"
              ? [fauxAssistantMessage(fauxToolCall("codemode", {
                code: 'await tools.write({path: "report.md", content: "Verified report\\n"}); text(await tools.read({path: "report.md"}));',
              }))]
              : [
                fauxAssistantMessage(fauxToolCall("write", { path: "report.md", content: "Verified report\n" })),
                fauxAssistantMessage(fauxToolCall("read", { path: "report.md" })),
              ];
            setResponses([
              fauxAssistantMessage(fauxToolCall("exposure_probe", {})),
              ...work,
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
                status: "complete", evidence: "Read the report and audited the whole original objective",
              })),
              fauxAssistantMessage("Blocked goal completed without resumption"),
            ]);
            await runToSettlement(
              () => session.prompt("The prerequisite is resolved. Finish and verify the original report."),
              "Blocked goal completed without resumption",
            );
            assert.ok(declarations.length > firstBlockedRequest + 1, JSON.stringify({ errors, messages: session.messages.slice(firstBlockedMessage) }));
            assertDeclarations(firstBlockedRequest, true, declarations.length - 1);
            assertDeclarations(declarations.length - 1, false);
            assert.match(requestInstructions[firstBlockedRequest], /Status: blocked/u);
            assert.ok(requestInstructions[firstBlockedRequest].includes(blocked.objective));
            assert.equal(readFileSync(path.join(cwd, "report.md"), "utf8"), "Verified report\n");
            const laterResults = session.messages.slice(firstBlockedMessage).filter((message) => message.role === "toolResult");
            assert.ok(laterResults.length >= 3);
            for (const result of laterResults) assert.equal(result.isError, false, JSON.stringify(result.content));
            const completeEntry = goalEntries().at(-1)?.data;
            assert.ok(isUnknownRecord(completeEntry));
            assert.equal(completeEntry.event, "complete");
            const completed = parseGoalState(completeEntry.state);
            assert.ok(completed?.status === "complete");
            assert.equal(completed.lastDecision?.kind, "complete");
            for (const key of ["objective", "createdAt", "verification", "baselineTokens", "turns", "maxTurns", "activeMilliseconds"] as const) {
              assert.deepEqual(completed[key], blocked[key], key);
            }
            assert.equal(session.pendingMessageCount, 0);
            const requestsAfterCompletion = declarations.length;
            await session.reload();
            await session.waitForIdle();
            assert.equal(declarations.length, requestsAfterCompletion);
            assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false);

            for (const status of ["paused", "blocked", "complete", "cleared"] as const) {
              const state = createNewGoalState("Restore the saved goal", 0, undefined, Date.now());
              sessionManager.appendCustomEntry("killeros-goal", {
                version: 1, event: status === "cleared" ? "clear" : status === "paused" ? "pause" : status,
                state: status === "cleared" ? null : transitionGoalState(state, status, "Saved result", {}, Date.now()),
              });
              await session.reload();
              assert.deepEqual(session.getActiveToolNames(), unrelatedActive, `${status} must not change unrelated tools`);
              const firstRequest = declarations.length;
              setResponses([fauxAssistantMessage(`Goal ${status}`)]);
              await runToSettlement(() => session.prompt(`Inspect ${status} goal declarations`), `Goal ${status}`);
              assertDeclarations(firstRequest, status === "blocked");
              if (status === "paused") await runGoal(() => session.prompt("/goal resume"));
            }
            sessionManager.appendCustomEntry("killeros-goal", {
              version: 1, event: "set", state: createNewGoalState("Restore active work", 0, undefined, Date.now()),
            });
            await runGoal(() => session.reload());
            assert.deepEqual(errors, []);
          } finally {
            session.dispose();
          }
        } finally {
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          await removeDirectoryEventually(directory);
        }
      });
    }
  }
});

test("real Pi exclusions cannot be bypassed by KillerOS goal activation or codemode", { timeout: 60_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const excluded of ["killeros_*", "killeros_goal_update", "question", "allowlist"]) {
      await t.test(`${mode}/${excluded}`, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-tool-exclusion-"));
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
          mkdirSync(cwd); mkdirSync(agentDir);
          const runtime = createGoalRuntime();
          const faux = fauxProvider({ provider: "killeros-tool-exclusion", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
          const declarations: string[][] = [];
          faux.setResponses([
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage(fauxToolCall("codemode", {
                code: 'for (const name of ["question", "killeros_goal_update"]) { try { await tools[name]({}); text("Unexpected call: " + name); } catch (error) { text(error.message); } }',
              }));
            },
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage("Exclusions verified");
            },
          ]);
          const modelRuntime = await ModelRuntime.create({
            authPath: path.join(agentDir, "auth.json"), modelsPath: null,
            modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
          });
          modelRuntime.registerNativeProvider(faux.provider);
          await modelRuntime.setRuntimeApiKey("killeros-tool-exclusion", "local-test-key");
          const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
          const loader = new DefaultResourceLoader({
            cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
            noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [createCodemodeExtension({ mode: "only" }), (pi) => {
              registerQuestionTool(pi);
              registerGoalInterface(pi, runtime);
              registerGoalRuntime(pi, runtime);
              registerGoalSettlement(pi, runtime);
            }],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          ({ session } = await createAgentSession({
            cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
            sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")),
            tools: excluded === "allowlist" ? ["question", "codemode"] : ["question", "killeros_*", "codemode"],
            excludeTools: excluded === "allowlist" ? [] : [excluded],
          }));
          const errors: string[] = [];
          const { ctx } = createTuiContext();
          const ui = extensionContextTestAdapter({ ui: { ...ctx.ui,
            select: async () => { assert.fail("scripts must not open question UI"); },
            input: async () => { assert.fail("scripts must not open question UI"); },
          } }).ui;
          await session.bindExtensions({ mode, uiContext: ui,
            onError(error) { errors.push(`${error.event}: ${error.error}`); } });
          await session.prompt("/goal Verify exclusions through native selection");
          if (excluded !== "question") {
            assert.equal(runtime.state?.status, "paused");
            assert.equal(runtime.state?.turns, 0);
            assert.equal(runtime.state?.stopReason, "killeros_goal_update is unavailable");
            assert.equal(faux.state.callCount, 0, "an excluded goal tool must prevent any provider request");
            await session.prompt("Inspect the remaining declarations");
          }
          await session.waitForIdle();
          assert.equal(faux.state.callCount, 2);
          for (const names of declarations) {
            assert.equal(names.includes("question"), excluded !== "question");
            assert.equal(names.includes("killeros_goal_update"), excluded === "question");
            assert.equal(names.includes("codemode"), true);
          }
          const script = session.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
          assert.ok(script?.role === "toolResult");
          assert.equal(script.isError, false, JSON.stringify(script.content));
          const output = script.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          assert.match(output, /tools\.question does not exist/u);
          assert.match(output, /tools\.killeros_goal_update does not exist/u);
          assert.doesNotMatch(output, /Unexpected call/u);
          for (const name of ["question", "killeros_goal_update"]) {
            assert.equal(session.getCallableToolNames().includes(name), false);
          }
          assert.equal(session.pendingMessageCount, 0);
          assert.equal(runtime.continuationScheduled, false);

          const blocked = transitionGoalState({
            ...createNewGoalState("Finish the original blocked objective", 0, undefined, Date.now()), turns: 3,
          }, "blocked", "Waiting for an external prerequisite", {}, Date.now());
          session.sessionManager.appendCustomEntry("killeros-goal", { version: 1, event: "blocked", state: blocked });
          await session.reload();
          assert.equal(runtime.state?.status, "blocked");
          assert.equal(session.getActiveToolNames().includes("killeros_goal_update"), false);
          const firstBlockedRequest = declarations.length;
          faux.setResponses([
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage(fauxToolCall("codemode", {
                code: 'try { await tools.killeros_goal_update({status: "complete", evidence: "Nested attempt"}); text("Unexpected call"); } catch (error) { text(error.message); }',
              }));
            },
            (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
              return fauxAssistantMessage("Ordinary blocked work without a goal decision");
            },
          ]);
          await session.prompt("Finish this ordinary response without resuming the blocked goal");
          await session.waitForIdle();
          assert.equal(declarations.length - firstBlockedRequest, 2, "selection must not abort an ordinary request");
          for (const names of declarations.slice(firstBlockedRequest)) {
            assert.equal(names.includes("killeros_goal_update"), excluded === "question");
          }
          assert.equal(runtime.state?.status, "blocked");
          assert.deepEqual(runtime.state, blocked);
          assert.equal(runtime.goalTurnInFlight, false);
          assert.equal(runtime.continuationScheduled, false);
          assert.equal(session.pendingMessageCount, 0);
          assert.deepEqual(errors, []);
        } finally {
          session?.dispose();
          await removeDirectoryEventually(directory);
        }
      });
    }
  }
});

test("Pi 1.1 user cancellation stops goal work after a normal result, during retry, and during pending compaction", { skip: !piHasModifiers, timeout: 30_000 }, async (t) => {
  for (const stage of ["normal result", "retry", "goal compaction", "ordinary compaction"] as const) {
    await t.test(stage, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-cancellation-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
        mkdirSync(cwd); mkdirSync(agentDir);
        const runtime = createGoalRuntime();
        const compacting = stage.endsWith("compaction");
        const ordinary = stage === "ordinary compaction";
        const faux = fauxProvider({ provider: "killeros-cancellation", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey("killeros-cancellation", "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: compacting, reserveTokens: 100, keepRecentTokens: 1 },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 30_000, maxAgentDelayMs: 30_000 }, cacheWarming: "off" });
        settingsManager.setProjectTrusted(true);
        let bells = 0;
        let resolveCompacting: (() => void) | undefined;
        const compactionStarted = new Promise<void>((resolve) => { resolveCompacting = resolve; });
        const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerGoalInterface(pi, runtime); registerGoalRuntime(pi, runtime);
            registerWorkedFor(pi, Date.now, async () => ({ finish: async () => ({ state: "unavailable", reason: "not-git" }), dispose: async () => undefined }));
            const goal = registerGoalSettlement(pi, runtime);
            registerAutoCompaction(pi, { goal, loadPreference: () => ({ enabled: compacting, percentRemaining: 100 }),
              getCompactionSettings: () => ({ enabled: compacting, reserveTokens: 100, keepRecentTokens: 1 }) });
            registerCompletionNotifications(pi, { store: { load: () => true, save() {} }, ring: () => { bells += 1; } });
            pi.on("session_before_compact", async (event) => {
              resolveCompacting?.();
              if (!event.signal.aborted) await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve(), { once: true }));
              return { cancel: true };
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")), noTools: "builtin" }));
        const host = session;
        const errors: string[] = [];
        const { ctx } = createTuiContext();
        await host.bindExtensions({ mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); } });
        const settlements: boolean[] = [];
        let cancellation: Promise<void> | undefined;
        host.subscribe((event) => {
          if (stage === "normal result" && event.type === "agent_end") cancellation = host.abort();
          if (stage === "retry" && event.type === "auto_retry_start") cancellation = new Promise<void>((resolve, reject) => {
            setImmediate(() => { host.abort().then(resolve, reject); });
          });
          if (event.type === "agent_settled") settlements.push("aborted" in event && event.aborted === true);
        });
        faux.setResponses(stage === "retry" ? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "server_busy" })]
          : ordinary ? [fauxAssistantMessage("ordinary response")]
            : [fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "continue", evidence: "First step verified", nextAction: "Do the next step" })), fauxAssistantMessage("normal response")]);
        const prompt = host.prompt(ordinary ? "Inspect the fixture" : "/goal Finish the isolated fixture");
        if (compacting) {
          await compactionStarted;
          await host.abort();
        }
        await prompt;
        await cancellation;
        await host.waitForIdle();
        if (compacting) await waitFor(() => !host.isCompacting && runtime.automaticCompaction === undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(faux.state.callCount, stage === "normal result" ? 2 : 1);
        assert.deepEqual(settlements, [true]);
        const receipts = host.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for");
        assert.equal(receipts.length, 1);
        assert.ok(receipts[0]?.type === "custom" && isUnknownRecord(receipts[0].data));
        assert.equal(receipts[0].data.outcome, "stopped");
        assert.equal(bells, 0);
        if (!ordinary) {
          assert.equal(runtime.state?.status, "paused");
          assert.equal(runtime.state?.turns, 1);
          assert.equal(runtime.state?.maxTurns, 20);
          assert.notEqual(runtime.state?.resumeAfterManualCompaction, true);
        }
        assert.equal(runtime.continuationScheduled, false);
        assert.equal(host.pendingMessageCount, 0);
        assert.deepEqual(errors, []);
      } finally {
        session?.dispose();
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("Pi 1.1 native CLI rejects mixed modifiers and wildcard modifiers", { skip: !piHasModifiers }, () => {
  for (const selection of ["read,+codemode", "+codemode,-killeros_*"]) {
    const args = parseArgs(["--tools", selection]);
    assert.equal(args.diagnostics.some((diagnostic) => diagnostic.type === "error"), true, selection);
    assert.equal(args.tools, undefined);
  }
  for (const selection of ["+codemode", "-killeros_goal_update", "read,killeros_*"]) {
    const args = parseArgs(["--tools", selection]);
    assert.deepEqual(args.diagnostics, []);
    assert.deepEqual(args.tools, selection.split(","));
  }
});

test("Pi 1.1 +codemode retains native defaults through goal activation and reload", { skip: !piHasModifiers, timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-tool-modifiers-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const runtime = createGoalRuntime();
    const faux = fauxProvider({ provider: "killeros-modifiers", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-modifiers", "local-test-key");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createCodemodeExtension({ mode: "on" }), (pi) => {
        registerQuestionTool(pi); registerGoalInterface(pi, runtime); registerGoalRuntime(pi, runtime); registerGoalSettlement(pi, runtime);
      }],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")),
      tools: parseArgs(["--tools", "+codemode"]).tools,
    }));
    const { ctx } = createTuiContext();
    const errors: string[] = [];
    await session.bindExtensions({ mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui,
      onError(error) { errors.push(`${error.event}: ${error.error}`); } });
    for (const stage of ["startup", "reload"] as const) {
      if (stage === "reload") await session.reload();
      faux.setResponses([(context) => {
        const names = getCurrentTools(context.messages).map((tool) => tool.name);
        for (const name of ["read", "bash", "edit", "write", "codemode", "question", "killeros_goal_update"]) assert.equal(names.includes(name), true, `${stage}/${name}`);
        return fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Defaults verified" }));
      }, fauxAssistantMessage("Verified")]);
      await session.prompt(`/goal Verify defaults at ${stage}`);
      await session.waitForIdle();
      assert.equal(runtime.state?.status, "complete");
      for (const name of ["question", "killeros_goal_update"]) {
        assert.equal(session.getToolDefinition(name)?.exposure, "model-only");
        assert.equal(session.getToolDefinition(name)?.executionMode, "sequential");
        assert.equal(session.getCallableToolNames().includes(name), false);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    await removeDirectoryEventually(directory);
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
    await removeDirectoryEventually(directory);
  }
});

test("real Pi compaction pauses a normally stopped goal after one decisionless request", { timeout: 30_000 }, async (t) => {
  for (const outcome of ["completed", "session-too-small"] as const) {
    await t.test(outcome, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-compaction-decision-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const compaction = { enabled: true, reserveTokens: 100, keepRecentTokens: outcome === "completed" ? 1 : 20_000 };
        writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction }));
        writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
        const provider = `killeros-goal-decision-${outcome}`;
        const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        faux.setResponses([
          fauxAssistantMessage("Normal stop without a decision"),
          fauxAssistantMessage("Another normal stop without a decision"),
          fauxAssistantMessage("End regression probe", { stopReason: "error", errorMessage: "End regression probe" }),
        ]);
        const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction, retry: { enabled: false }, cacheWarming: "off" });
        const sessionManager = SessionManager.create(cwd, path.join(directory, "sessions"));
        if (outcome === "completed") {
          sessionManager.appendMessage({ role: "user", content: "Earlier work", timestamp: Date.now() - 2 });
          sessionManager.appendMessage(fauxAssistantMessage("Earlier answer", { timestamp: Date.now() - 1 }));
        }
        const savedGoal = () => {
          const entry = sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
          assert.ok(entry?.type === "custom" && isUnknownRecord(entry.data));
          return parseGoalState(entry.data.state);
        };
        let resolvePaused: (() => void) | undefined;
        const paused = new Promise<void>((resolve) => { resolvePaused = resolve; });
        let compactions = 0;
        let compactionFailure: string | undefined;
        const errors: string[] = [];
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager,
          additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            pi.on("session_before_compact", (event) => {
              compactions += 1;
              return { compaction: { summary: "Local summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
            });
            pi.on("session_compact_failed", (event) => { compactionFailure = event.errorMessage; });
            pi.on("agent_settled", () => {
              const state = savedGoal();
              if (state?.status === "paused" && state.result) resolvePaused?.();
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager, resourceLoader: loader, noTools: "builtin",
        }));
        await session.bindExtensions({ mode: "rpc", onError(error) { errors.push(`${error.event}: ${error.error}`); } });
        await session.prompt("/goal Pause without a turn decision");
        await paused;
        await session.waitForIdle();
        await new Promise((resolve) => setImmediate(resolve));

        const state = savedGoal();
        assert.equal(state?.status, "paused");
        assert.equal(state?.result, "no turn decision");
        assert.equal(state?.turns, 1);
        assert.equal(state?.maxTurns, 20);
        assert.equal(state?.turnDecision, undefined);
        assert.equal(faux.state.callCount, 1);
        assert.equal(compactions, outcome === "completed" ? 1 : 0);
        assert.equal(compactionFailure, outcome === "completed" ? undefined : "Compaction failed: Nothing to compact (session too small)");
        assert.equal(session.pendingMessageCount, 0);
        assert.deepEqual(errors, []);
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("real Pi terminal goal compaction cannot start extra tool work in TUI or RPC", { timeout: 30_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const status of ["complete", "blocked"] as const) {
      await t.test(`${mode}/${status}`, async () => {
        const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-terminal-compaction-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const cwd = path.join(directory, "project"), agentDir = path.join(directory, "agent");
          mkdirSync(cwd); mkdirSync(agentDir);
          process.env.PI_CODING_AGENT_DIR = agentDir;
          const compaction = { enabled: true, reserveTokens: 100, keepRecentTokens: 1 };
          const preferences = path.join(agentDir, "killeros.json");
          writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction }));
          writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 100 } }));
          const provider = `killeros-terminal-${mode}-${status}`;
          const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
          const extraFile = path.join(cwd, "unauthorized.txt");
          const decisions: AssistantMessage[] = [];
          const turns = status === "blocked" ? 3 : 1;
          for (let turn = 1; turn <= turns; turn++) {
            decisions.push(fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
              status, evidence: `Verified turn ${turn}`, ...(status === "blocked" ? { blockerKey: "external" } : {}),
            })));
            if (turn < turns) decisions.push(fauxAssistantMessage(`Audit ${turn} finished`));
          }
          faux.setResponses([
            ...decisions,
            () => {
              // Trigger only at the final answer, so normal tool-result follow-up is not mistaken for a restart.
              writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
              return fauxAssistantMessage("The terminal goal request finished");
            },
            fauxAssistantMessage(fauxToolCall("write", { path: extraFile, content: "Unauthorized continuation" })),
            fauxAssistantMessage("Unauthorized work finished"),
          ]);
          const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
          modelRuntime.registerNativeProvider(faux.provider);
          await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
          const settingsManager = SettingsManager.inMemory({ compaction, retry: { enabled: false }, cacheWarming: "off" });
          const sessionManager = SessionManager.create(cwd, path.join(directory, "sessions"));
          sessionManager.appendMessage({ role: "user", content: "Earlier context", timestamp: Date.now() - 2 });
          sessionManager.appendMessage(fauxAssistantMessage("Earlier answer", { timestamp: Date.now() - 1 }));
          let compactions = 0;
          let resolveCompacted: (() => void) | undefined;
          const compacted = new Promise<void>((resolve) => { resolveCompacted = resolve; });
          const errors: string[] = [];
          const loader = new DefaultResourceLoader({
            cwd, agentDir, settingsManager, additionalExtensionPaths: [path.join(repositoryRoot, "Killeros.ts")],
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [(pi) => {
              pi.on("session_before_compact", (event) => {
                compactions++;
                return { compaction: { summary: "The goal is terminal. Do not continue it.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
              });
              pi.on("session_compact", () => { resolveCompacted?.(); });
            }],
          });
          await loader.reload();
          assert.deepEqual(loader.getExtensions().errors, []);
          ({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, sessionManager, resourceLoader: loader }));
          let starts = 0;
          let settlements = 0;
          let finalAnswer = false;
          session.subscribe((event) => {
            if (event.type === "agent_start") starts++;
            if (event.type === "agent_settled") settlements++;
            if (event.type === "message_end" && event.message.role === "assistant"
              && event.message.content.some((part) => part.type === "text" && part.text === "The terminal goal request finished")) finalAnswer = true;
          });
          await session.bindExtensions({ mode, uiContext: extensionContextTestAdapter(createTuiContext().ctx).ui, onError(error) { errors.push(`${error.event}: ${error.error}`); } });
          await session.prompt("/goal Stop after the terminal decision");
          await compacted;
          await waitFor(() => session?.isCompacting === false);
          await new Promise((resolve) => setImmediate(resolve));
          await session.waitForIdle();
          const entry = sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
          assert.ok(entry?.type === "custom" && isUnknownRecord(entry.data));
          const state = parseGoalState(entry.data.state);
          assert.equal(state?.status, status);
          assert.equal(state?.turns, turns);
          assert.equal(finalAnswer, true);
          assert.equal(compactions, 1);
          assert.equal(starts, turns);
          assert.equal(faux.state.callCount, turns * 2);
          assert.equal(existsSync(extraFile), false);
          assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "killeros-auto-compaction"), false);
          assert.equal(session.pendingMessageCount, 0);
          await waitFor(() => settlements === turns);
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (status === "blocked") {
            writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 100 } }));
            const laterCompacted = new Promise<void>((resolve) => { resolveCompacted = resolve; });
            faux.setResponses([
              fauxAssistantMessage(fauxToolCall("killeros_goal_update", { status: "complete", evidence: "Audited the original objective after resolving the prerequisite" })),
              () => {
                writeFileSync(preferences, JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
                return fauxAssistantMessage("The later terminal completion finished");
              },
              fauxAssistantMessage(fauxToolCall("write", { path: extraFile, content: "Unauthorized blocked completion restart" })),
              fauxAssistantMessage("Unauthorized work finished"),
            ]);
            await session.prompt("The prerequisite is resolved. Audit and complete the original goal without resuming it.");
            await laterCompacted;
            await waitFor(() => session?.isCompacting === false);
            await session.waitForIdle();
            await waitFor(() => settlements === turns + 1);
            await new Promise<void>((resolve) => setImmediate(resolve));
            const finalEntry = sessionManager.getEntries().reverse().find((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
            assert.ok(finalEntry?.type === "custom" && isUnknownRecord(finalEntry.data));
            const completed = parseGoalState(finalEntry.data.state);
            assert.equal(completed?.status, "complete");
            assert.equal(completed?.turns, turns);
            assert.deepEqual(completed?.verification, state?.verification);
            assert.equal(completed?.activeMilliseconds, state?.activeMilliseconds);
            assert.equal(compactions, 2);
            assert.equal(starts, turns + 1);
            assert.equal(faux.state.callCount, turns * 2 + 2);
            assert.equal(existsSync(extraFile), false);
            assert.equal(session.messages.some((message) => message.role === "custom" && message.customType === "killeros-auto-compaction"), false);
            assert.equal(session.pendingMessageCount, 0);
          }
          assert.deepEqual(errors, []);
        } finally {
          session?.dispose();
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          await removeDirectoryEventually(directory);
        }
      });
    }
  }
});

test("real Pi handoff survives immediate disposal and resume without an agent turn", { timeout: 15_000 }, async () => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-handoff-lifecycle-"));
  let runtimeHost: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const summary = ["Objective", "Current state", "Decisions", "Constraints", "Completed work", "Relevant artifacts", "Verification", "Blockers or open questions", "Exact next action", "Suggested skills"]
      .map((section) => `## ${section}\nContinue the existing release checks.`).join("\n\n");
    const faux = fauxProvider({ provider: "killeros-handoff-lifecycle", models: [{ id: "local", contextWindow: 100_000, maxTokens: 10_000 }] });
    faux.setResponses([fauxAssistantMessage(summary)]);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-handoff-lifecycle", "local-test-key");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
    const sourceManager = SessionManager.create(cwd, path.join(directory, "sessions"));
    sourceManager.appendMessage({ role: "user", content: "Finish the release checks", timestamp: Date.now() });
    sourceManager.appendSessionInfo("Release checks");
    const sourceFile = sourceManager.getSessionFile();
    assert.ok(sourceFile);
    const notices: string[] = [];
    const errors: string[] = [];
    let agentStarts = 0;
    runtimeHost = await createAgentSessionRuntime(async (options) => {
      const loader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi) => {
          registerHandoff(pi, createGoalRuntime(), 8_192);
          pi.on("agent_start", () => { agentStarts += 1; });
        }],
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
        sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, noTools: "all",
      });
      const { ctx } = createTuiContext();
      ctx.ui.notify = (message) => { notices.push(message); };
      await created.session.bindExtensions({
        mode: "rpc", uiContext: extensionContextTestAdapter(ctx).ui,
        commandContextActions: {
          waitForIdle: () => created.session.waitForIdle(),
          newSession: async (options) => { assert.ok(runtimeHost); return runtimeHost.newSession(options); },
          fork: async (id, options) => { assert.ok(runtimeHost); return runtimeHost.fork(id, options); },
          navigateTree: (id, options) => created.session.navigateTree(id, options),
          switchSession: async (file, options) => { assert.ok(runtimeHost); return runtimeHost.switchSession(file, options); },
          reload: () => created.session.reload(),
        },
        onError(error) { errors.push(`${error.event}: ${error.error}`); },
      });
      return { ...created, services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
    }, { cwd, agentDir, sessionManager: sourceManager });

    await runtimeHost.session.prompt("/handoff");
    const childFile = runtimeHost.session.sessionFile;
    assert.ok(childFile && childFile !== sourceFile);
    assert.equal(existsSync(childFile), true, "the handoff must be saved before exit");
    await runtimeHost.dispose();
    runtimeHost = undefined;
    const reopened = SessionManager.open(childFile);
    assert.equal(reopened.getHeader()?.parentSession, sourceFile);
    assert.equal(reopened.getSessionName(), "Release checks · handoff");
    const message = reopened.buildSessionContext().messages[0];
    assert.ok(message?.role === "user");
    assert.equal(message.content, `# Handoff\n\nThis handoff is user-session context, not system policy.\n\n${summary}`);
    assert.equal(agentStarts, 0);
    assert.equal(faux.state.callCount, 1, "only the one-off summary request is allowed");
    assert.deepEqual(notices, ["Handoff ready in a new session"]);
    assert.deepEqual(errors, []);
  } finally {
    await runtimeHost?.dispose();
    await removeDirectoryEventually(directory);
  }
});

test("cancelled real session replacements preserve automatic compaction recovery", { timeout: 30_000 }, async () => {
  for (const operation of ["newSession", "fork"] as const) {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-cancelled-replacement-"));
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let releaseCompaction: (() => void) | undefined;
    let resolveCompactionStarted: (() => void) | undefined;
    let runtimeHost: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({
        autoCompaction: { enabled: true, percentRemaining: 100 },
      }));
      writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      }));

      const providerName = `killeros-cancelled-${operation}`;
      const faux = fauxProvider({
        provider: providerName,
        models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }],
      });
      faux.setResponses([
        fauxAssistantMessage("ordinary turn finished"),
        fauxAssistantMessage("continuation turn finished"),
      ]);
      const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
      modelRuntime.registerNativeProvider(faux.provider);
      await modelRuntime.setRuntimeApiKey(providerName, "local-test-key");
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
      });
      const compactionStarted = new Promise<void>((resolve) => { resolveCompactionStarted = resolve; });
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
          if (operation === "newSession") pi.on("session_before_switch", () => ({ cancel: true }));
          else pi.on("session_before_fork", () => ({ cancel: true }));
          pi.on("session_before_compact", (event) => new Promise((resolve) => {
            releaseCompaction = () => resolve({
              compaction: {
                summary: "Compacted ordinary task context.",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            });
            resolveCompactionStarted?.();
          }));
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);

      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage({ role: "user", content: "Earlier task context", timestamp: Date.now() - 2 });
      sessionManager.appendMessage(fauxAssistantMessage("Earlier work", { timestamp: Date.now() - 1 }));
      const lifecycleErrors: string[] = [];
      runtimeHost = await createAgentSessionRuntime(async (options) => {
        const created = await createAgentSession({
          cwd: options.cwd,
          agentDir: options.agentDir,
          model: faux.getModel(),
          modelRuntime,
          resourceLoader: loader,
          sessionManager: options.sessionManager,
          settingsManager,
          noTools: "all",
          sessionStartEvent: options.sessionStartEvent,
        });
        await created.session.bindExtensions({
          mode: "rpc",
          shutdownHandler() {},
          onError(error) { lifecycleErrors.push(`${error.event}: ${error.error}`); },
        });
        return {
          ...created,
          services: {
            cwd: options.cwd,
            agentDir: options.agentDir,
            modelRuntime,
            settingsManager,
            resourceLoader: loader,
            diagnostics: [],
          },
          diagnostics: [],
        };
      }, { cwd, agentDir, sessionManager });

      let agentStarts = 0;
      let settledCount = 0;
      let resolveInitialSettlement: (() => void) | undefined;
      let resolveContinuation: (() => void) | undefined;
      const initialSettlement = new Promise<void>((resolve) => { resolveInitialSettlement = resolve; });
      const continuation = new Promise<void>((resolve) => { resolveContinuation = resolve; });
      unsubscribe = runtimeHost.session.subscribe((event) => {
        if (event.type === "agent_start") agentStarts += 1;
        if (event.type === "agent_settled" && settledCount++ === 0) resolveInitialSettlement?.();
        if (event.type === "message_end"
          && event.message.role === "assistant"
          && event.message.content.some((part) => part.type === "text" && part.text === "continuation turn finished")) {
          resolveContinuation?.();
        }
      });

      const prompt = runtimeHost.session.prompt("Continue the ordinary task");
      await Promise.all([compactionStarted, initialSettlement]);
      const replacement = operation === "newSession"
        ? await runtimeHost.newSession()
        : await runtimeHost.fork("not-an-entry");
      assert.deepEqual(replacement, { cancelled: true });
      releaseCompaction?.();
      await continuation;
      await prompt;
      await runtimeHost.session.waitForIdle();

      assert.equal(agentStarts, 2);
      assert.equal(faux.state.callCount, 2);
      assert.equal(runtimeHost.session.messages.filter((message) => message.role === "custom"
        && message.customType === "killeros-auto-compaction").length, 1);
      assert.deepEqual(lifecycleErrors, []);
    } finally {
      releaseCompaction?.();
      unsubscribe?.();
      await runtimeHost?.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await removeDirectoryEventually(directory);
    }
  }
});

test("real Pi session boundaries discard pending receipts without stale settlement handlers", { timeout: 30_000 }, async (t) => {
  for (const operation of ["none", "appendSessionInfo", "newSession", "cancelledNewSession", "reload", "navigateTree", "navigateTreeBeforeReceiptReset", "navigateTreeBeforeReceiptSettlement", "cancelledNavigateTree"] as const) {
    await t.test(operation, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-receipt-lifecycle-"));
      const cwd = path.join(directory, "project");
      const agentDir = path.join(directory, "agent");
      mkdirSync(cwd);
      mkdirSync(agentDir);
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      let runtimeHost: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
      let releaseScan: (() => void) | undefined;
      let scanStarted: (() => void) | undefined;
      const scanning = new Promise<void>((resolve) => { scanStarted = resolve; });
      const scan = new Promise<void>((resolve) => { releaseScan = resolve; });
      let settlementStarted: (() => void) | undefined;
      let releaseSettlement: (() => void) | undefined;
      const settling = new Promise<void>((resolve) => { settlementStarted = resolve; });
      const settlement = new Promise<void>((resolve) => { releaseSettlement = resolve; });
      const errors: string[] = [];
      const notices: string[] = [];
      let bells = 0;
      try {
        const provider = `killeros-receipt-${operation}`;
        const faux = fauxProvider({ provider, models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        faux.setResponses([fauxAssistantMessage("first turn finished"), fauxAssistantMessage("next turn finished")]);
        const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey(provider, "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
        settingsManager.setProjectTrusted(true);
        runtimeHost = await createAgentSessionRuntime(async (options) => {
          const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [(pi) => {
              if (operation === "cancelledNewSession") pi.on("session_before_switch", () => ({ cancel: true }));
              if (operation === "cancelledNavigateTree") pi.on("session_before_tree", () => ({ cancel: true }));
              if (operation === "navigateTreeBeforeReceiptSettlement") pi.on("agent_settled", async () => {
                settlementStarted?.();
                await settlement;
              });
              if (operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement") pi.on("session_tree", async () => {
                releaseSettlement?.();
                releaseScan?.();
                await new Promise((resolve) => setImmediate(resolve));
              });
              registerWorkedFor(pi, Date.now, async () => ({
                finish: async () => {
                  scanStarted?.();
                  await scan;
                  return { state: "unavailable", reason: "error" };
                },
                dispose: async () => undefined,
              }));
              registerRequestActivity(pi);
              registerCompletionNotifications(pi, {
                store: { load: () => true, save() {} },
                ring: () => { bells += 1; },
              });
            }],
          });
          await loader.reload();
          const created = await createAgentSession({
            cwd,
            agentDir,
            sessionManager: options.sessionManager,
            sessionStartEvent: options.sessionStartEvent,
            model: faux.getModel(),
            modelRuntime,
            settingsManager,
            resourceLoader: loader,
            noTools: "all",
          });
          const { ctx } = createTuiContext();
          ctx.ui.notify = (message) => { notices.push(message); };
          await created.session.bindExtensions({ mode: "tui", uiContext: extensionContextTestAdapter(ctx).ui });
          return {
            ...created,
            services: { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] },
            diagnostics: [],
          };
        }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
        const anchor = runtimeHost.session.sessionManager.appendMessage(fauxAssistantMessage("Earlier branch"));

        const recordError = (error: { event: string; error: string }): void => { errors.push(`${error.event}: ${error.error}`); };
        const source = runtimeHost.session;
        source.extensionRunner.onError(recordError);
        const oldContext = source.extensionRunner.createContext();
        const prompt = source.prompt("Finish one turn");
        await (operation === "navigateTreeBeforeReceiptSettlement" ? settling : scanning);
        assert.equal(source.isIdle, true, "Pi reports idle before receipt finalization returns");
        if (operation === "reload") await source.reload();
        else if (operation === "appendSessionInfo") source.sessionManager.appendSessionInfo("Renamed during receipt collection");
        else if (operation === "navigateTree" || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement" || operation === "cancelledNavigateTree") {
          assert.equal((await source.navigateTree(anchor)).cancelled, operation === "cancelledNavigateTree");
        } else if (operation !== "none") {
          assert.deepEqual(await runtimeHost.newSession(), { cancelled: operation === "cancelledNewSession" });
        }
        const replaced = operation === "newSession" || operation === "reload";
        const receiptDiscarded = replaced || operation === "navigateTree" || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement";
        // Finalization inside session_tree is not idle, so the existing bell guard stays silent.
        const expectedBells = replaced || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement" ? 0 : 1;
        if (replaced) assert.throws(() => oldContext.mode, /stale/u);
        releaseScan?.();
        await prompt;

        const receipts = source.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for");
        assert.equal(receipts.length, receiptDiscarded ? 0 : 1);
        assert.equal(notices.length, receiptDiscarded ? 0 : 1);
        if (operation === "navigateTree" || operation === "navigateTreeBeforeReceiptReset" || operation === "navigateTreeBeforeReceiptSettlement") {
          assert.equal(source.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user"
            && entry.message.content === "Finish one turn"), false);
        }
        assert.equal(bells, expectedBells);
        assert.deepEqual(errors, []);

        runtimeHost.session.extensionRunner.onError(recordError);
        await runtimeHost.session.prompt("Finish the next turn");
        assert.equal(runtimeHost.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "killeros-worked-for").length,
          receiptDiscarded ? 1 : 2);
        assert.equal(bells, expectedBells + 1);
        assert.deepEqual(errors, []);
      } finally {
        releaseSettlement?.();
        releaseScan?.();
        await runtimeHost?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await removeDirectoryEventually(directory);
      }
    });
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

test("a stale replacement releases a running goal's held continuation in real Pi", { timeout: 15_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    await t.test(mode, async () => {
      const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-held-continuation-"));
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let releaseFirst = (): void => { throw new Error("first response gate was not initialized"); };
      let signalFirst = (): void => { throw new Error("first response barrier was not initialized"); };
      let releaseNext = (): void => { throw new Error("next response gate was not initialized"); };
      let signalNext = (): void => { throw new Error("next response barrier was not initialized"); };
      const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const nextStarted = new Promise<void>((resolve) => { signalNext = resolve; });
      const nextGate = new Promise<void>((resolve) => { releaseNext = resolve; });
      try {
        const cwd = path.join(directory, "project");
        const agentDir = path.join(directory, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        const runtime = createGoalRuntime();
        const faux = fauxProvider({ provider: "killeros-held-goal", models: [{ id: "local", contextWindow: 100_000, maxTokens: 1_000 }] });
        faux.setResponses([
          async () => {
            signalFirst();
            await firstGate;
            return fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
              status: "continue", evidence: "First check passed", nextAction: "Run the second check",
            }), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("First step finished"),
          async () => {
            signalNext();
            await nextGate;
            return fauxAssistantMessage(fauxToolCall("killeros_goal_update", {
              status: "complete", evidence: "Both checks passed",
            }), { stopReason: "toolUse" });
          },
          fauxAssistantMessage("Original objective finished"),
        ]);
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath: null,
          modelsStorePath: path.join(agentDir, "models-cache.json"), allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        await modelRuntime.setRuntimeApiKey("killeros-held-goal", "local-test-key");
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
        const loader = new DefaultResourceLoader({
          cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [(pi) => {
            registerGoalInterface(pi, runtime);
            registerGoalRuntime(pi, runtime);
            registerGoalSettlement(pi, runtime);
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd, agentDir, model: faux.getModel(), modelRuntime, settingsManager, resourceLoader: loader,
          sessionManager: SessionManager.create(cwd, path.join(directory, "sessions")), noTools: "builtin",
        }));
        const host = session;
        const errors: string[] = [];
        const { ctx: uiContext } = createTuiContext();
        uiContext.ui.confirm = async () => true;
        await host.bindExtensions({
          mode, uiContext: extensionContextTestAdapter(uiContext).ui,
          onError(error) { errors.push(`${error.event}: ${error.error}`); },
        });
        const command = host.extensionRunner.getCommand("goal");
        assert.ok(command);
        const ctx = host.extensionRunner.createCommandContext();
        ctx.waitForIdle = () => host.waitForIdle();
        await command.handler("Original objective", ctx);
        await firstStarted;
        const replacement = command.handler("Replacement objective", ctx);
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(runtime.continuationHeld);
        releaseFirst();
        await replacement;

        assert.equal(runtime.state?.objective, "Original objective", "stale replacements must not overwrite an accepted decision");
        assert.equal(runtime.state?.turns, 2, "releasing the hold must start the authorized next turn");
        assert.equal(runtime.state?.maxTurns, 20);
        assert.equal(runtime.goalTurnInFlight, true);
        assert.equal(runtime.continuationHeld, undefined);
        await nextStarted;
        assert.equal(faux.state.callCount, 3, "exactly one next logical turn starts");
        releaseNext();
        await host.waitForIdle();
        assert.equal(runtime.state?.status, "complete");
        assert.equal(runtime.state?.turns, 2);
        assert.equal(faux.state.callCount, 4);
        assert.equal(host.pendingMessageCount, 0);
        assert.deepEqual(errors, []);
      } finally {
        releaseFirst();
        releaseNext();
        if (session) {
          await session.waitForIdle();
          session.dispose();
        }
        await removeDirectoryEventually(directory);
      }
    });
  }
});

test("BUG-05 real Pi tree navigation invalidates a pending goal-start command", { timeout: 20000 }, async (t) => {
  for (const cancelled of [false, true]) {
    const root = mkdtempSync(path.join(process.cwd(), "node_modules", ".killeros-edge-goal-command-"));
    t.after(() => removeDirectoryEventually(root));
    const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const state = createGoalRuntime();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const faux = fauxProvider({ provider: "killeros-edge-goal", models: [{ id: "local", contextWindow: 100000, maxTokens: 1000 }] });
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey("killeros-edge-goal", "fixture-only-key");
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => {
      registerGoalInterface(pi, state); registerGoalRuntime(pi, state);
      if (cancelled) pi.on("session_before_tree", () => ({ cancel: true }));
    }] });
    await loader.reload();
    const manager = SessionManager.create(cwd, path.join(root, "sessions"));
    const anchor = manager.appendMessage(fauxAssistantMessage("Earlier branch"));
    manager.appendMessage({ role: "user", content: "Source branch", timestamp: Date.now() });
    const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, settingsManager, modelRuntime, model: faux.getModel(), resourceLoader: loader, noTools: "all" });
    t.after(() => session.dispose());
    await session.bindExtensions({ mode: "rpc", shutdownHandler() {} });
    const command = session.extensionRunner.getCommand("goal"); assert.ok(command);
    const ctx = session.extensionRunner.createCommandContext();
    let release: (() => void) | undefined;
    ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
    ctx.hasPendingMessages = () => true; // Keep the reproduction limited to persistence, without a model turn.
    const pending = command.handler("Objective entered on the source branch", ctx);
    assert.ok(release);
    assert.equal((await session.navigateTree(anchor)).cancelled, cancelled);
    release(); await pending;
    const goals = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
    assert.equal(goals.length, cancelled ? 1 : 0, "only cancelled navigation preserves pending work");
  }
});
