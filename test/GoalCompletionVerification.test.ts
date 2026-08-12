import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Killeros from "../Killeros.ts";

function createHarness(entries: Array<Record<string, unknown>> = []) {
  const commands = new Map<string, { handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void> }>();
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: ReturnType<typeof createContext>) => unknown>>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: { status: string } }> }>();
  const appendedEntries: Array<{ customType: string; data: { event: string; state: Record<string, unknown> | null } }> = [];
  const sentMessages: Array<unknown> = [];
  const api = {
    appendEntry: (customType: string, data: { event: string; state: Record<string, unknown> | null }) => appendedEntries.push({ customType, data }),
    getAllTools: () => [],
    getCommands: () => [],
    getSessionName: () => undefined,
    getThinkingLevel: () => "high",
    on: (event: string, handler: (event: Record<string, unknown>, ctx: ReturnType<typeof createContext>) => unknown) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ReturnType<typeof createContext>) => Promise<void> }) => commands.set(name, command),
    registerEntryRenderer: () => {},
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ details: { status: string } }> }) => tools.set(tool.name, tool),
    sendMessage: (message: unknown) => sentMessages.push(message),
    sendUserMessage: () => {},
    setThinkingLevel: () => {},
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  Killeros(api as never, { completionNotifications: { store: { load: () => false, save: () => {} }, ring: () => {} } });
  return { appendedEntries, commands, entries, handlers, sentMessages, tools };
}

function createContext(entries: Array<Record<string, unknown>> = []) {
  return {
    abort() {},
    cwd: process.cwd(),
    getContextUsage: () => ({ tokens: 0, contextWindow: 128_000 }),
    hasPendingMessages: () => false,
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => false,
    mode: "tui",
    model: { id: "test", name: "test", provider: "test", reasoning: true },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionFile: () => path.join(process.cwd(), "session.jsonl"),
    },
    ui: {
      addAutocompleteProvider() {},
      confirm: async () => true,
      editor: async (_title: string, prefill: string) => prefill,
      getEditorComponent: () => undefined,
      notify() {},
      select: async () => undefined,
      setEditorComponent() {},
      setFooter() {},
      setHeader() {},
      setHiddenThinkingLabel() {},
      setTitle() {},
      setWorkingIndicator() {},
      setWorkingMessage() {},
    },
    waitForIdle: async () => {},
  };
}

async function startGoal(harness: ReturnType<typeof createHarness>, ctx: ReturnType<typeof createContext>, objective: string) {
  await harness.commands.get("goal")!.handler(objective, ctx);
  return harness.appendedEntries.at(-1)!.data.state!;
}

function complete(harness: ReturnType<typeof createHarness>, ctx: ReturnType<typeof createContext>) {
  return harness.tools.get("killeros_goal_update")!.execute(
    "complete",
    { status: "complete", evidence: "Verified deliverable" },
    new AbortController().signal,
    () => {},
    ctx,
  );
}

test("file goals verify the persisted exact path before completion", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-goal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requested = path.join(directory, "requested.md");
  const wrong = path.join(directory, "wrong.md");
  writeFileSync(wrong, "wrong destination");
  const harness = createHarness();
  const ctx = createContext();
  const active = await startGoal(harness, ctx, `Write the Markdown file to \`${requested}\``);

  assert.deepEqual(active.verification, { kind: "file", path: requested });
  await assert.rejects(complete(harness, ctx), /not a regular file at the required path/u);
  assert.equal(harness.appendedEntries.at(-1)!.data.state!.status, "active");
  assert.equal(harness.appendedEntries.some((entry) => entry.data.event === "complete"), false);

  mkdirSync(requested);
  await assert.rejects(complete(harness, ctx), /not a regular file at the required path/u);
  assert.equal(harness.appendedEntries.at(-1)!.data.state!.status, "active");
  rmSync(requested, { recursive: true });

  try {
    symlinkSync(wrong, requested, "file");
    await assert.rejects(complete(harness, ctx), /not a regular file at the required path/u);
    assert.equal(harness.appendedEntries.at(-1)!.data.state!.status, "active");
    rmSync(requested);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM"].includes(String(error.code))) throw error;
  }

  writeFileSync(requested, "correct destination");
  const result = await complete(harness, ctx);
  assert.equal(result.details.status, "complete");
  assert.equal(result.details.verification, "file");
  assert.equal(harness.appendedEntries.at(-1)!.data.state!.status, "complete");
});

test("general natural-language goals retain model-reported completion", async () => {
  const harness = createHarness();
  const ctx = createContext();
  const active = await startGoal(harness, ctx, "Review the release and explain whether it is ready");
  assert.equal(active.verification, undefined);
  const result = await complete(harness, ctx);
  assert.equal(result.details.status, "complete");
  assert.equal(result.details.verification, "model-reported");
});

test("reference paths are not inferred as goal deliverables", async () => {
  for (const objective of [
    "Write a report explaining how to use `C:\\data\\reference.md`",
    "Write a report file comparing the current data to `/tmp/reference.md`; put the finished report in the session response.",
  ]) {
    const harness = createHarness();
    const ctx = createContext();
    const active = await startGoal(harness, ctx, objective);
    assert.equal(active.verification, undefined, objective);
  }
});

test("directory and symlink objectives do not create a regular-file contract", async () => {
  for (const objective of [
    "Create a directory at `C:\\work\\release.v1`",
    "Create a symlink at `C:\\work\\release.md`",
  ]) {
    const harness = createHarness();
    const ctx = createContext();
    const active = await startGoal(harness, ctx, objective);
    assert.equal(active.verification, undefined, objective);
  }
});

test("explicit file goals support extensionless absolute destinations", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-goal-extensionless-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const requested = path.join(directory, "README");
  const harness = createHarness();
  const ctx = createContext();
  const active = await startGoal(harness, ctx, `Create the file at \`${requested}\``);
  assert.deepEqual(active.verification, { kind: "file", path: requested });
});

test("old goal state restores, while malformed persisted verification fails closed", async () => {
  const now = Date.now();
  const baseState = {
    version: 1,
    revision: 1,
    objective: "Continue old natural-language goal",
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeMilliseconds: 0,
    activeStartedAt: now,
    turns: 0,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
  };
  const restore = async (state: Record<string, unknown>) => {
    const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "set", state } }];
    const harness = createHarness(entries);
    const ctx = createContext(entries);
    for (const handler of harness.handlers.get("session_start") ?? []) await handler({}, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    return harness;
  };

  assert.equal((await restore(baseState)).sentMessages.length, 1);
  assert.equal((await restore({ ...baseState, verification: { kind: "file", path: "relative.md" } })).sentMessages.length, 0);
  assert.equal((await restore({ ...baseState, verification: { kind: "url", path: "C:\\out.md" } })).sentMessages.length, 0);
});
