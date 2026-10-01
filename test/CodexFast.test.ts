import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, createTuiContext, disposeTestComponent, getCommand, getHandlers, last, theme } from "./ExtensionTestHarness.ts";
import { isCodexFastEnabled, resetCodexFastState } from "../killeros/codex-fast-state.ts";
import { themeTestAdapter } from "./PiTestAdapters.ts";

type TestNotification = { message: string; level?: string };

test("/codex-fast is registered once and toggles Codex priority requests", async () => {
  resetCodexFastState();
  const harness = createHarness();
  assert.equal(harness.commandRegistrations.filter((name) => name === "codex-fast").length, 1);

  const notifications: TestNotification[] = [];
  const { ctx } = createTuiContext();
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  const command = getCommand(harness, "codex-fast");
  assert.ok(command);
  assert.equal(command.getArgumentCompletions, undefined);

  const requestHandler = last(getHandlers(harness, "before_provider_request"));
  assert.ok(requestHandler);
  const payload = { model: "gpt-5.5", input: [] };
  const codexContext = { ...ctx, model: { ...ctx.model, provider: "openai-codex" } };
  assert.strictEqual(await requestHandler({ type: "before_provider_request", payload }, codexContext), payload);

  await command.handler("", ctx);
  assert.deepEqual(last(notifications), { message: "Fast enabled", level: "info" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  const nonCodexPayload = { model: "gpt-5.5", input: [] };
  assert.strictEqual(
    await requestHandler({ type: "before_provider_request", payload: nonCodexPayload }, {
      ...ctx,
      model: { ...ctx.model, provider: "openai" },
    }),
    nonCodexPayload,
  );

  await command.handler("", ctx);
  assert.deepEqual(last(notifications), { message: "Fast disabled", level: "info" });
  assert.strictEqual(await requestHandler({ type: "before_provider_request", payload }, codexContext), payload);

  ctx.mode = "rpc";
  await command.handler("", ctx);
  assert.deepEqual(last(notifications), { message: "Fast enabled", level: "info" });
});

test("/codex-fast adds priority to native Responses without mutating other request fields", async () => {
  resetCodexFastState();
  const harness = createHarness();
  const { ctx } = createTuiContext();
  const requestHandler = last(getHandlers(harness, "before_provider_request"));
  await getCommand(harness, "codex-fast").handler("", ctx);

  for (const baseUrl of ["https://api.openai.com/v1", "https://api.openai.com/v1/"]) {
    const model = { ...ctx.model, id: "gpt-6.1-sol", provider: "openai", api: "openai-responses", baseUrl };
    for (const service_tier of [undefined, "flex", "default", "priority"]) {
      const payload = Object.freeze({ model: model.id, input: [], stream: true, metadata: { task: "test" },
        ...(service_tier === undefined ? {} : { service_tier }) });
      const result = await requestHandler({ type: "before_provider_request", payload }, { ...ctx, model });
      assert.notStrictEqual(result, payload);
      assert.deepEqual(result, { ...payload, service_tier: "priority" });
      assert.strictEqual(result?.input, payload.input);
      assert.strictEqual(result?.metadata, payload.metadata);
      assert.equal(payload.service_tier, service_tier);
    }
  }
  resetCodexFastState();
});

test("disabled fast mode preserves payload identity and existing tiers on both supported paths", async () => {
  resetCodexFastState();
  const harness = createHarness();
  const { ctx } = createTuiContext();
  const requestHandler = last(getHandlers(harness, "before_provider_request"));
  for (const provider of ["openai-codex", "openai"]) {
    const model = { ...ctx.model, provider, api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
    for (const payload of [{ model: model.id, input: [] }, { model: model.id, input: [], service_tier: "flex" }]) {
      assert.strictEqual(await requestHandler({ type: "before_provider_request", payload }, { ...ctx, model }), payload);
    }
  }
});

test("enabled fast mode passes unsupported, ambiguous, and invalid requests through by identity", async () => {
  resetCodexFastState();
  const harness = createHarness();
  const { ctx } = createTuiContext();
  const requestHandler = last(getHandlers(harness, "before_provider_request"));
  await getCommand(harness, "codex-fast").handler("", ctx);
  const nativeModel = { ...ctx.model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  const payload = { model: nativeModel.id, input: [], service_tier: "flex" };
  for (const model of [
    undefined,
    { ...nativeModel, provider: "anthropic" },
    { ...nativeModel, provider: "azure-openai-responses" },
    { ...nativeModel, provider: "OpenAI" },
    { ...nativeModel, api: "openai-completions" },
    { ...nativeModel, api: "virtual" },
    { ...nativeModel, api: undefined },
    { ...nativeModel, baseUrl: undefined },
    ...["https://example.invalid/v1", "http://api.openai.com/v1", "https://api.openai.com/v1//",
      "https://api.openai.com/v1/responses", "https://api.openai.com/v1?test=1"].map((baseUrl) => ({ ...nativeModel, baseUrl })),
  ]) {
    assert.strictEqual(await requestHandler({ type: "before_provider_request", payload }, { ...ctx, model }), payload);
  }
  for (const ambiguous of [{ input: [] }, { ...payload, model: "another-model" }, { ...payload, model: null }]) {
    assert.strictEqual(await requestHandler({ type: "before_provider_request", payload: ambiguous }, {
      ...ctx, model: nativeModel,
    }), ambiguous);
  }
  for (const provider of ["openai", "openai-codex"]) {
    for (const invalid of [null, undefined, [], "request", 42]) {
      assert.strictEqual(await requestHandler({ type: "before_provider_request", payload: invalid }, {
        ...ctx, model: { ...nativeModel, provider },
      }), invalid);
    }
  }
  // Legacy Codex never required a matching request model, API, or endpoint.
  const legacyPayload = Object.freeze({ input: [], service_tier: "flex" });
  assert.deepEqual(await requestHandler({ type: "before_provider_request", payload: legacyPayload }, {
    ...ctx, model: { ...ctx.model, provider: "openai-codex" },
  }), { input: [], service_tier: "priority" });
  resetCodexFastState();
});

test("/codex-fast status reports mode without changing state", async () => {
  resetCodexFastState();
  const harness = createHarness();
  const notifications: TestNotification[] = [];
  const { ctx } = createTuiContext();
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  const command = getCommand(harness, "codex-fast");
  assert.ok(command);

  await command.handler("status", ctx);
  assert.deepEqual(last(notifications), { message: "Codex fast mode: disabled", level: "info" });
  assert.equal(isCodexFastEnabled(), false);

  await command.handler("", ctx);
  await command.handler("  status  ", ctx);
  assert.deepEqual(last(notifications), { message: "Codex fast mode: enabled", level: "info" });
  assert.equal(isCodexFastEnabled(), true);
});

test("/codex-fast rejects arguments without changing its state", async () => {
  resetCodexFastState();
  const harness = createHarness();
  const notifications: TestNotification[] = [];
  const { ctx } = createTuiContext();
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  const command = getCommand(harness, "codex-fast");
  const requestHandler = last(getHandlers(harness, "before_provider_request"));
  assert.ok(command);
  assert.ok(requestHandler);

  const payload = { model: "gpt-5.5", input: [] };
  const codexContext = { ...ctx, model: { ...ctx.model, provider: "openai-codex" } };
  await command.handler("", ctx);
  await command.handler("on", ctx);
  assert.deepEqual(last(notifications), { message: "Usage: /codex-fast [status]", level: "error" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  await command.handler("off now", ctx);
  assert.deepEqual(last(notifications), { message: "Usage: /codex-fast [status]", level: "error" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );
});

test("/codex-fast state survives extension reloads and switches between Codex and native OpenAI", async () => {
  resetCodexFastState();
  const first = createHarness();
  const firstContext = createTuiContext().ctx;
  const sessionManager = firstContext.sessionManager;
  firstContext.model = { ...firstContext.model, provider: "openai-codex" };
  await getCommand(first, "codex-fast").handler("", firstContext);

  const second = createHarness();
  const { captured, ctx, tui } = createTuiContext([], theme, sessionManager);
  ctx.model = { ...ctx.model, provider: "openai-codex" };
  const requestHandler = last(getHandlers(second, "before_provider_request"));
  assert.ok(requestHandler);
  const payload = { model: "gpt-5.5", input: [] };
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, ctx),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  for (const handler of getHandlers(second, "session_start") ?? []) await handler({}, ctx);
  assert.equal(captured.statuses?.size ?? 0, 0);
  const semanticTheme = themeTestAdapter({
    ...theme,
    bold: (text: string) => `<bold>${text}</bold>`,
    fg: (color: string, text: string) => color === "accent"
      ? `<accent>${text}</accent>`
      : color === "text"
        ? `<text>${text}</text>`
        : text,
  });
  const footer = captured.footerFactory(tui, semanticTheme, {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  });
  const enabledRender = footer.render(120).join("\n");
  assert.match(enabledRender, /test-model.*fast.*openai/u);
  assert.match(enabledRender, /<text>fast<\/text>/u);
  assert.equal(footer.render(120).length, 3);

  const nativeModel = { ...ctx.model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  for (const handler of getHandlers(second, "model_select") ?? []) handler({ model: nativeModel });
  assert.match(footer.render(120).join("\n"), /test-model.*fast.*openai/u);
  const nativeContext = { ...ctx, model: nativeModel };
  const nativePayload = { model: nativeModel.id, input: [] };
  assert.deepEqual(await requestHandler({ type: "before_provider_request", payload: nativePayload }, nativeContext), {
    ...nativePayload, service_tier: "priority",
  });
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(second, "codex-fast").handler("status", nativeContext);
  assert.deepEqual(last(notifications), { message: "Codex fast mode: enabled", level: "info" });
  await getCommand(second, "codex-fast").handler("on", nativeContext);
  assert.deepEqual(last(notifications), { message: "Usage: /codex-fast [status]", level: "error" });
  assert.equal(isCodexFastEnabled(), true);

  for (const handler of getHandlers(second, "model_select") ?? []) {
    handler({ model: { ...nativeModel, baseUrl: "https://example.invalid/v1" } });
  }
  assert.doesNotMatch(footer.render(120).join("\n"), /fast/u);
  assert.equal(isCodexFastEnabled(), true);

  for (const handler of getHandlers(second, "model_select") ?? []) {
    handler({ model: { ...ctx.model, provider: "openai-codex" } });
  }
  assert.match(footer.render(120).join("\n"), /test-model.*fast.*openai/u);
  disposeTestComponent(footer);
  resetCodexFastState();
});

test("/codex-fast reload repairs legacy process-global state", async () => {
  const original = globalThis.__killerosCodexFastState;
  try {
    globalThis.__killerosCodexFastState = { enabled: true };
    const moduleUrl = new URL("../killeros/codex-fast-state.ts", import.meta.url);
    moduleUrl.searchParams.set("legacy", String(Date.now()));
    // The query string forces a fresh module instance, so its exports cannot be typed statically.
    const reloaded: unknown = await import(moduleUrl.href);
    assert.ok(typeof reloaded === "object" && reloaded !== null);
    assert.ok("isCodexFastEnabled" in reloaded && typeof reloaded.isCodexFastEnabled === "function");
    assert.ok("subscribeCodexFast" in reloaded && typeof reloaded.subscribeCodexFast === "function");
    // The assertions above validate the exact members used here.
    const codexModule = reloaded as {
      isCodexFastEnabled(): boolean;
      subscribeCodexFast(listener: () => void): () => void;
    };

    assert.equal(codexModule.isCodexFastEnabled(), true);
    const unsubscribe = codexModule.subscribeCodexFast(() => {});
    assert.doesNotThrow(unsubscribe);
  } finally {
    globalThis.__killerosCodexFastState = original;
  }
});
