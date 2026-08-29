import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, createTuiContext, disposeTestComponent, getCommand, getHandlers, last, theme } from "./ExtensionTestHarness.ts";
import { resetCodexFastState } from "../killeros/codex-fast-state.ts";
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
  await command.handler("status", ctx);
  assert.deepEqual(last(notifications), { message: "Usage: /codex-fast", level: "error" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );

  await command.handler("off now", ctx);
  assert.deepEqual(last(notifications), { message: "Usage: /codex-fast", level: "error" });
  assert.deepEqual(
    await requestHandler({ type: "before_provider_request", payload }, codexContext),
    { model: "gpt-5.5", input: [], service_tier: "priority" },
  );
});

test("/codex-fast state survives extension reloads and renders inline for Codex", async () => {
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
    fg: (color: string, text: string) => color === "accent" ? `<accent>${text}</accent>` : text,
  });
  const footer = captured.footerFactory(tui, semanticTheme, {
    getGitBranch: () => undefined,
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  });
  const enabledRender = footer.render(120).join("\n");
  assert.match(enabledRender, /Test model.*Fast.*OpenAI/u);
  assert.match(enabledRender, /<accent><bold>Fast<\/bold><\/accent>/u);
  assert.equal(footer.render(120).length, 3);

  for (const handler of getHandlers(second, "model_select") ?? []) {
    handler({ model: { ...ctx.model, provider: "openai" } });
  }
  assert.doesNotMatch(footer.render(120).join("\n"), /Fast/u);

  for (const handler of getHandlers(second, "model_select") ?? []) {
    handler({ model: { ...ctx.model, provider: "openai-codex" } });
  }
  assert.match(footer.render(120).join("\n"), /Test model.*Fast.*OpenAI/u);
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
