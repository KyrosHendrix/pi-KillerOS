import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type AssistantMessage, type Provider } from "@earendil-works/pi-ai";
import { getKeybindings } from "@earendil-works/pi-tui";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Type } from "typebox";
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
import { registerCodexFastMode } from "../killeros/codex-fast.ts";
import { isCodexFastEnabled, resetCodexFastState } from "../killeros/codex-fast-state.ts";
import { registerCompletionNotifications } from "../killeros/notifications.ts";
import { registerWorkedFor } from "../killeros/worked-for.ts";
import { registerGoalInterface } from "../killeros/goal-interface.ts";
import { registerGoalRuntime } from "../killeros/goal-runtime.ts";
import { registerGoalSettlement } from "../killeros/goal-settlement.ts";
import { registerHandoff } from "../killeros/handoff.ts";
import { createGoalRuntime } from "../killeros/runtime.ts";
import { createNewGoalState, parseGoalState, transitionGoalState } from "../killeros/goal-state.ts";
import { createHarness, createTuiContext, requireInteractive, theme } from "./ExtensionTestHarness.ts";
import { extensionContextTestAdapter } from "./PiTestAdapters.ts";

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
    rmSync(directory, { recursive: true, force: true });
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
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("real native OpenAI transport sends priority and reports rejection without a tier-changing retry", { timeout: 30_000 }, async (t) => {
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
        const modelRuntime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"), modelsPath: null,
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
        const { session } = await createAgentSession({
          cwd, agentDir, model, modelRuntime, settingsManager, resourceLoader: loader,
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
          await session.prompt("Test priority rejection locally");
          await session.waitForIdle();

          // HTTP 400 is not retryable. HTTP 429 gets exactly one configured Pi provider retry.
          assert.equal(bodies.length, expectedRequests);
          for (const body of bodies) {
            assert.equal(body.model, model.id);
            assert.equal(body.service_tier, "priority");
            assert.ok(Array.isArray(body.input));
          }
          const response = session.messages.filter((message) => message.role === "assistant").at(-1);
          assert.ok(response?.role === "assistant");
          assert.equal(response.stopReason, "error");
          assert.match(response.errorMessage ?? "", /Priority is not available for this test account/u);
          assert.deepEqual(errors, []);
        } finally {
          session.dispose();
        }
      } finally {
        resetCodexFastState();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("real Pi keeps KillerOS decisions declared and rejects nested calls with every codemode setting", { timeout: 60_000 }, async (t) => {
  for (const mode of ["tui", "rpc"] as const) {
    for (const codemode of ["disabled", "on", "only"] as const) {
      await t.test(`${mode}/${codemode}`, async () => {
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
          const setResponses = (messages: AssistantMessage[]): void => {
            faux.setResponses(messages.map((message) => (context) => {
              declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
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
            resourceLoader: loader, noTools: "builtin",
          });
          const errors: string[] = [];
          const { ctx, tui } = createTuiContext();
          const ui = extensionContextTestAdapter({ ui: {
            ...ctx.ui,
            custom(factory: (...args: unknown[]) => unknown) {
              opened++;
              return new Promise<unknown>((resolve) => {
                requireInteractive(factory(tui, theme, getKeybindings(), resolve)).handleInput("\r");
              });
            },
          } }).ui;
          const assertDeclarations = (start: number, activeGoal: boolean, end = declarations.length): void => {
            const requests = declarations.slice(start, end);
            assert.ok(requests.length > 0, "the provider must receive a request");
            for (const names of requests) {
              assert.equal(names.includes("question"), true, `question missing from ${names.join(", ")}`);
              assert.equal(names.includes("killeros_goal_update"), activeGoal);
              assert.equal(names.includes("exposure_probe"), true);
              assert.equal(names.includes("codemode"), codemode !== "disabled");
              assert.equal(names.includes("unrelated"), codemode !== "only", "codemode-only must actually hide direct tools");
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
            let finish: (() => void) | undefined;
            const finished = new Promise<void>((resolve) => { finish = resolve; });
            const unsubscribe = session.subscribe((event) => {
              if (event.type === "message_end" && event.message.role === "assistant"
                && event.message.content.some((part) => part.type === "text" && part.text === "exposure turn finished")) finish?.();
            });
            try {
              await start();
              await finished;
              await session.waitForIdle();
            } finally {
              unsubscribe();
            }
            assert.equal(probes, probesBefore + 1);
            assert.equal(declarations.length - firstRequest, 4);
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
            if (codemode !== "disabled") session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
            const unrelatedActive = session.getActiveToolNames();
            setResponses([fauxAssistantMessage("No goal")]);
            await session.prompt("Inspect the declarations without a goal");
            assertDeclarations(0, false);

            await runGoal(() => session.prompt("/goal Verify native tool exposure"));
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
              await session.prompt(`Inspect ${status} goal declarations`);
              assertDeclarations(firstRequest, false);
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
          rmSync(directory, { recursive: true, force: true });
        }
      });
    }
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
        rmSync(directory, { recursive: true, force: true });
      }
    });
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
    rmSync(directory, { recursive: true, force: true });
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
      rmSync(directory, { recursive: true, force: true });
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
        rmSync(directory, { recursive: true, force: true });
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
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("BUG-05 real Pi tree navigation invalidates a pending goal-start command", { timeout: 20000 }, async (t) => {
  for (const cancelled of [false, true]) {
    const root = mkdtempSync(path.join(process.cwd(), "node_modules", ".killeros-edge-goal-command-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
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
