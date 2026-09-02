import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listGoalCompletionChecks, resolveGoalCompletionCheck, runGoalCompletionCheck, type HookSpawnProcess } from "../killeros/hooks.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHarness, createTuiContext, emitSequentially, getHandlers, last, removeDirectoryEventually, resultReason, waitFor } from "./ExtensionTestHarness.ts";
import { execFileSync, spawn } from "node:child_process";
import { executeHook } from "../Killeros.ts";
import { extensionContextTestAdapter } from "./PiTestAdapters.ts";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

type TestNotification = { message: string; level?: string };

test("goal checks validate trusted configuration and bind command plus effective timeout", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-goal-check-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, ".pi"));
  const configPath = path.join(directory, ".pi", "killeros-hooks.json");
  const { ctx } = createTuiContext();
  ctx.cwd = directory;
  const extensionCtx = extensionContextTestAdapter(ctx);
  const writeChecks = (goalChecks: unknown) => writeFileSync(configPath, JSON.stringify({
    hooks: { tool_call: [{ command: `"${process.execPath}" -e "process.exit(0)"` }] },
    goalChecks,
  }));

  writeChecks({
    unit: { command: "npm test" },
    quality: { command: `"${process.execPath}" -e "if(process.env.KILLEROS_EVENT!=='goal_check'||process.env.KILLEROS_GOAL_CHECK!=='quality')process.exit(2)"` },
  });
  assert.deepEqual(listGoalCompletionChecks(extensionCtx), ["quality", "unit"]);
  const first = resolveGoalCompletionCheck(extensionCtx, "quality");
  assert.deepEqual(resolveGoalCompletionCheck(extensionCtx, "quality"), first);
  await runGoalCompletionCheck(extensionCtx, first);

  writeChecks({ quality: { command: `"${process.execPath}" -e "process.exit(0)"`, timeoutMs: 30_001 } });
  assert.notEqual(resolveGoalCompletionCheck(extensionCtx, "quality").configHash, first.configHash);
  ctx.isProjectTrusted = () => false;
  assert.throws(() => listGoalCompletionChecks(extensionCtx), /trusted project/u);
  assert.throws(() => resolveGoalCompletionCheck(extensionCtx, "quality"), /trusted project/u);
});

test("goal checks reject malformed definitions", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-goal-check-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, ".pi"));
  const configPath = path.join(directory, ".pi", "killeros-hooks.json");
  const { ctx } = createTuiContext();
  ctx.cwd = directory;
  const extensionCtx = extensionContextTestAdapter(ctx);
  const invalid = [
    { "Bad Name": { command: "exit 0" } },
    { "bad\x1b]2;owned\x07": { command: "exit 0" } },
    { quality: { command: "" } },
    { quality: { command: "exit 0", timeoutMs: 0 } },
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`check-${index}`, { command: "exit 0" }])),
  ];
  for (const goalChecks of invalid) {
    writeFileSync(configPath, JSON.stringify({ goalChecks }));
    const safeError = (error: unknown) => error instanceof Error && !error.message.includes("\x1b") && !error.message.includes("\x07");
    assert.throws(() => listGoalCompletionChecks(extensionCtx), safeError);
    assert.throws(() => resolveGoalCompletionCheck(extensionCtx, "quality"), safeError);
  }
});

test("hook config rejects malformed roots without executing hooks", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-malformed-root-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const configPath = path.join(configDirectory, "killeros-hooks.json");

    for (const root of [null, [], "hooks", 1, true]) {
      writeFileSync(configPath, JSON.stringify(root));
      const { handlers } = createHarness();
      const notifications: TestNotification[] = [];
      const { ctx } = createTuiContext();
      ctx.cwd = directory;
      ctx.ui.notify = (message, level) => notifications.push({ message, level });
      for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);

      assert.match(last(notifications)?.message ?? "", /Invalid \.pi\/killeros-hooks\.json/u);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hook config validates entries and ignores unknown fields", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-boundary-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const marker = path.join(directory, "accepted");
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('accepted','ran')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      unknownRootField: true,
      hooks: {
        unknown_event: [{ command: "exit 7" }],
        tool_call: [
          null,
          [],
          "hook",
          1,
          { command: null },
          { command: "exit 7", matcher: 1 },
          { command: "exit 7", timeoutMs: "1000" },
          { command, unknownHookField: { future: true } },
        ],
      },
    }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "hook-boundary",
      toolName: "write",
      input: {},
    }, ctx);

    assert.equal(readFileSync(marker, "utf8"), "ran");
    assert.equal(notifications.length, 7);
    assert.ok(notifications.every(({ message }) => /Ignored invalid tool_call hook|timeoutMs/u.test(message)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not load lifecycle hooks for untrusted projects", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-untrusted-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ command: `"${process.execPath}" -e "process.exit(7)"` }] },
    }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.isProjectTrusted = () => false;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);

    const results = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "untrusted-hook",
      toolName: "write",
      input: { path: "example.txt", content: "test" },
    }, ctx);
    assert.equal(results.some((result) => result?.block), false);
    assert.match(last(notifications)?.message, /Ignored untrusted project hooks/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hook config warnings sanitize project paths", {
  skip: process.platform === "win32" ? "control-byte paths are unavailable on Windows" : false,
}, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-path-\x1b]2;owned\x07\nspoof"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const configPath = path.join(configDirectory, "killeros-hooks.json");
    writeFileSync(configPath, JSON.stringify({ hooks: { tool_call: [{ command: "exit 0" }] } }));

    const untrusted = createHarness();
    const untrustedContext = createTuiContext().ctx;
    const untrustedNotifications: TestNotification[] = [];
    untrustedContext.cwd = directory;
    untrustedContext.isProjectTrusted = () => false;
    untrustedContext.ui.notify = (message, level) => untrustedNotifications.push({ message, level });
    for (const handler of getHandlers(untrusted, "session_start")) await handler({}, untrustedContext);

    writeFileSync(configPath, JSON.stringify({ hooks: { tool_call: [{}] } }));
    const invalid = createHarness();
    const invalidContext = createTuiContext().ctx;
    const invalidNotifications: TestNotification[] = [];
    invalidContext.cwd = directory;
    invalidContext.ui.notify = (message, level) => invalidNotifications.push({ message, level });
    for (const handler of getHandlers(invalid, "session_start")) await handler({}, invalidContext);

    assert.match(last(untrustedNotifications)?.message ?? "", /Ignored untrusted project hooks/u);
    assert.match(last(invalidNotifications)?.message ?? "", /Ignored invalid tool_call hook/u);
    assert.doesNotMatch(last(untrustedNotifications)?.message ?? "", /\x1b|\x07|\n/u);
    assert.doesNotMatch(last(invalidNotifications)?.message ?? "", /\x1b|\x07|\n/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects linked lifecycle hook configs before executing them", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-linked-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const source = path.join(directory, "shared-hooks.json");
    const marker = path.join(directory, "marker.txt");
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
    writeFileSync(source, JSON.stringify({ hooks: { tool_call: [{ command }] } }));
    linkSync(source, path.join(configDirectory, "killeros-hooks.json"));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "linked-hook",
      toolName: "write",
      input: {},
    }, ctx);

    assert.equal(existsSync(marker), false);
    assert.match(last(notifications)?.message, /regular, non-linked file/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects lifecycle hook configs in a linked project directory", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-linked-directory-"));
  try {
    const sharedConfigDirectory = path.join(directory, "shared-pi");
    mkdirSync(sharedConfigDirectory);
    symlinkSync(sharedConfigDirectory, path.join(directory, ".pi"), "junction");
    const marker = path.join(directory, "marker.txt");
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
    writeFileSync(path.join(sharedConfigDirectory, "killeros-hooks.json"), JSON.stringify({ hooks: { tool_call: [{ command }] } }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "linked-hook-directory",
      toolName: "write",
      input: {},
    }, ctx);

    assert.equal(existsSync(marker), false);
    assert.match(last(notifications)?.message, /real project \.pi directory/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects oversized lifecycle hook configs before executing them", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-large-config-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const marker = path.join(directory, "marker.txt");
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), `${JSON.stringify({ hooks: { tool_call: [{ command }] } })}${" ".repeat(65_536)}`);

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "oversized-hook-config",
      toolName: "write",
      input: {},
    }, ctx);

    assert.equal(existsSync(marker), false);
    assert.match(last(notifications)?.message, /exceeds 65536 bytes/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects agent_settled matchers without executing their commands", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-settled-matcher-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const marker = path.join(directory, "marker.txt");
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('marker.txt','ran')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { agent_settled: [{ matcher: "^bash$", command }] },
    }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);

    assert.equal(existsSync(marker), false);
    assert.deepEqual(notifications, [{
      message: "Ignored agent_settled hook 1: matchers are only valid for tool events",
      level: "warning",
    }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hook timeout validation accepts five minutes and rejects one millisecond more", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-timeout-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = (file: string) => `"${process.execPath}" -e "require('node:fs').writeFileSync('${file}','ran')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [
        { command: command("accepted"), timeoutMs: 300_000 },
        { command: command("rejected"), timeoutMs: 300_001 },
      ] },
    }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "hook-timeout-boundary",
      toolName: "write",
      input: {},
    }, ctx);

    assert.equal(existsSync(path.join(directory, "accepted")), true);
    assert.equal(existsSync(path.join(directory, "rejected")), false);
    assert.match(last(notifications)?.message, /Ignored tool_call hook 2: timeoutMs must be an integer from 1 to 300000/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project tool_call hook failures block tools without exposing configured commands", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const secret = "KILLEROS_INLINE_SECRET_9374";
    const command = `"${process.execPath}" -e "const token='${secret}';process.stderr.write('\\u001b]2;owned\\u0007\\u001b[31mblocked\\u001b[0m\\u0000');process.exit(token?7:0)"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command, timeoutMs: 5_000 }] },
    }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);

    const results = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "hook-test",
      toolName: "write",
      input: { path: "example.txt", content: "test" },
    }, ctx);
    const blocked = results.find((result) => result?.block);
    const expected = "Hook failed\nblocked";
    assert.equal(blocked?.block, true);
    assert.equal(resultReason(results), expected);
    assert.deepEqual(last(notifications), { message: expected, level: "error" });
    assert.doesNotMatch(expected, new RegExp(secret, "u"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unserializable hook payloads degrade to valid JSON", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-unserializable-payload-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "const payload=JSON.parse(process.env.KILLEROS_PAYLOAD);if(payload.serializationError!==true)process.exit(2)"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command }] },
    }));

    const { handlers } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);

    const circularInput: Record<string, unknown> = {};
    circularInput.self = circularInput;
    for (const [toolCallId, input] of [["circular", circularInput], ["bigint", { value: 1n }]] as const) {
      const results = await emitSequentially(getHandlers(handlers, "tool_call"), {
        toolCallId,
        toolName: "write",
        input,
      }, ctx);
      assert.equal(results.some((result) => result?.block), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("oversized hook payloads remain valid JSON and report truncation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-payload-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "const value=process.env.KILLEROS_PAYLOAD;const payload=JSON.parse(value);if(value.length>8000||payload.truncated!==true||typeof payload.preview!=='string')process.exit(2)"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command }] },
    }));

    const { handlers } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);

    const results = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "large-hook-payload",
      toolName: "write",
      input: { path: "example.txt", content: "x".repeat(9_000) },
    }, ctx);
    assert.equal(results.some((result) => result?.block), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("hook output preserves split UTF-8 and flushes incomplete final bytes", async () => {
  class ChunkedHook extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 123;
    kill() { return true; }
  }
  const child = new ChunkedHook();
  const spawnChild: HookSpawnProcess = () => child;
  const resultPromise = executeHook({ command: "ignored", cwd: process.cwd(), environment: {}, timeoutMs: 1_000, spawnProcess: spawnChild });
  child.stdout.write(Buffer.from([0xf0, 0x9f]));
  child.stdout.write(Buffer.from([0x98, 0x80]));
  child.emit("close", 0);

  const result = await resultPromise;
  assert.equal(result.stdout, "😀");

  const incompleteChild = new ChunkedHook();
  const incompleteResultPromise = executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    timeoutMs: 1_000,
    spawnProcess: () => incompleteChild,
  });
  incompleteChild.stderr.write(Buffer.from([0xf0, 0x9f]));
  incompleteChild.emit("close", 1);
  assert.equal((await incompleteResultPromise).stderr, "�");
});

test("hook stream errors are captured instead of escaping", async () => {
  class StreamErrorChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    kill() { return true; }
  }
  const child = new StreamErrorChild();
  const resultPromise = executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    timeoutMs: 1_000,
    spawnProcess: () => child,
  });
  child.stdout.emit("error", new Error("stdout failed"));
  child.stderr.emit("error", new Error("stderr failed"));
  child.emit("close", 1);

  const result = await resultPromise;
  assert.match(result.stderr, /stdout failed/u);
  assert.match(result.stderr, /stderr failed/u);
});

test("custom process adapters can keep data-only output streams", async () => {
  // Models an adapter written against the original output stream contract.
  class DataOnlyOutputStream {
    on(event: "data", _listener: (chunk: Buffer | string) => void) {
      assert.equal(event, "data");
      return this;
    }
  }
  class DataOnlyStreamChild extends EventEmitter {
    stdout = new DataOnlyOutputStream();
    stderr = new DataOnlyOutputStream();
    pid = undefined;
    kill() { return true; }
  }
  const child = new DataOnlyStreamChild();
  const spawnProcess: HookSpawnProcess = () => child;
  const resultPromise = executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    timeoutMs: 1_000,
    spawnProcess,
  });
  child.emit("close", 0);

  assert.equal((await resultPromise).code, 0);
});

test("the positional executeHook adapter preserves synchronous spawn failures", async () => {
  const spawnFailure: HookSpawnProcess = () => { throw new Error("process could not start"); };
  const result = await executeHook("ignored", process.cwd(), {}, 1_000, spawnFailure);
  assert.deepEqual(result, {
    code: 1,
    stdout: "",
    stderr: "process could not start",
    timedOut: false,
    cancelled: false,
    exitUnconfirmed: false,
  });
});

test("NaN hook timeouts use the default instead of firing immediately", async () => {
  class ClosingHook extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new ClosingHook();
  const resultPromise = executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    timeoutMs: Number.NaN,
    spawnProcess: () => child,
  });
  setTimeout(() => child.emit("close", 0), 20);

  const result = await resultPromise;
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.deepEqual(child.signals, []);
});

test("never-closing hooks report unconfirmed exit after bounded cleanup", async () => {
  class NeverClosingHook extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      return true;
    }
  }
  const child = new NeverClosingHook();
  const spawnChild: HookSpawnProcess = () => child;
  const result = await executeHook({ command: "ignored", cwd: process.cwd(), environment: {}, timeoutMs: 1_000, spawnProcess: spawnChild });
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitUnconfirmed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("aborting a running hook terminates it and reports cancellation", async () => {
  class NeverClosingChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals: NodeJS.Signals[] = [];
    kill(signal: NodeJS.Signals) { this.signals.push(signal); return true; }
  }
  const controller = new AbortController();
  const child = new NeverClosingChild();
  const spawnChild: HookSpawnProcess = () => child;
  const resultPromise = executeHook({ command: "ignored", cwd: process.cwd(), environment: {}, spawnProcess: spawnChild, signal: controller.signal });
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 130);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);

  let spawned = false;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const neverSpawn: HookSpawnProcess = () => { spawned = true; throw new Error("aborted hook spawned"); };
  const preResult = await executeHook({ command: "ignored", cwd: process.cwd(), environment: {}, spawnProcess: neverSpawn, signal: alreadyAborted.signal });
  assert.equal(spawned, false);
  assert.equal(preResult.cancelled, true);
  assert.equal(preResult.code, 130);

  const racingChild = new NeverClosingChild();
  racingChild.kill = function kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", null));
    return true;
  };
  const racingController = new AbortController();
  const racingSpawn: HookSpawnProcess = () => {
    racingController.abort();
    return racingChild;
  };
  const racingResult = await executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    spawnProcess: racingSpawn,
    signal: racingController.signal,
  });
  assert.equal(racingResult.cancelled, true);
  assert.equal(racingResult.timedOut, false);
  assert.deepEqual(racingChild.signals, ["SIGTERM"]);
});

test("synchronous process completion does not leave cleanup resources behind", async () => {
  class SynchronouslyClosedChild {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;

    kill() { return true; }
    on(_event: "error", _listener: (error: Error) => void) { return this; }
    once(_event: "close", listener: (code: number | null) => void) {
      listener(0);
      return this;
    }
  }
  const baselineTimeouts = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const result = await executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    timeoutMs: 50,
    spawnProcess: () => new SynchronouslyClosedChild(),
  });

  assert.equal(result.code, 0);
  assert.equal(process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length, baselineTimeouts);
});

test("abort cleanup observes a synchronous close from custom process adapters", async () => {
  class SynchronouslyClosingChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = undefined;
    signals: NodeJS.Signals[] = [];

    kill(signal: NodeJS.Signals) {
      this.signals.push(signal);
      this.emit("close", null);
      return true;
    }
  }
  const controller = new AbortController();
  const child = new SynchronouslyClosingChild();
  const baselineTimeouts = process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const resultPromise = executeHook({
    command: "ignored",
    cwd: process.cwd(),
    environment: {},
    spawnProcess: () => {
      controller.abort();
      return child;
    },
    signal: controller.signal,
  });

  const result = await resultPromise;
  assert.equal(result.cancelled, true);
  assert.equal(result.exitUnconfirmed, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length, baselineTimeouts);
});

test("Windows hook cleanup survives the shell exiting before tree termination", { skip: process.platform !== "win32" }, async () => {
  class ClosingShell extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    readonly pid: number;

    constructor(pid: number) {
      super();
      this.pid = pid;
    }

    kill() {
      queueMicrotask(() => this.emit("close", null));
      return true;
    }
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-windows-cleanup-"));
  const marker = path.join(directory, "descendant-marker");
  const script = path.join(directory, "descendant.cjs");
  writeFileSync(script, "setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'alive'), 1500);\nsetTimeout(() => {}, 5000);\n");
  const descendant = spawn(process.execPath, [script, marker], { stdio: "ignore", windowsHide: true });
  assert.ok(descendant.pid);
  try {
    const shell = new ClosingShell(descendant.pid);
    const result = await executeHook({
      command: "ignored",
      cwd: directory,
      environment: {},
      timeoutMs: 100,
      spawnProcess: () => shell,
    });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(existsSync(marker), false);
  } finally {
    try {
      execFileSync("taskkill", ["/pid", String(descendant.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // The regression passes when cleanup already terminated the process.
    }
    await removeDirectoryEventually(directory);
  }
});

test("Windows hook cleanup does not depend on taskkill being in PATH", { skip: process.platform !== "win32" }, async () => {
  const originalPath = process.env.PATH;
  let shell: ReturnType<HookSpawnProcess> | undefined;
  try {
    const resultPromise = executeHook({
      command: `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
      cwd: process.cwd(),
      environment: {},
      timeoutMs: 100,
      spawnProcess: (command, options) => {
        const spawned = spawn(command, options);
        shell = spawned;
        return spawned;
      },
    });
    process.env.PATH = "";

    const result = await resultPromise;
    assert.equal(result.timedOut, true);
    assert.equal(result.exitUnconfirmed, false);
    const pid = shell?.pid;
    assert.ok(pid);
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (shell?.pid) {
      try {
        execFileSync("taskkill", ["/pid", String(shell.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // The expected fallback already terminated the process.
      }
    }
  }
});

test("timed-out hooks terminate the process tree or report bounded uncertainty", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-hooks-tree-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const script = path.join(directory, "hook-child.cjs");
    const marker = path.join(directory, "late-marker");
    writeFileSync(script, [
      "const { spawn } = require('node:child_process');",
      "const marker = process.argv[1];",
      "spawn(process.execPath, ['-e', \"require('node:fs').writeFileSync(process.argv[1], 'late')\", marker], { stdio: 'ignore' });",
      "setTimeout(() => {}, 5000);",
    ].join("\n"));
    const command = `"${process.execPath}" "${script}" "${marker}"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { tool_call: [{ matcher: "^write$", command, timeoutMs: 1_000 }] },
    }));

    const { handlers } = createHarness();
    const notifications: TestNotification[] = [];
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = (message, level) => notifications.push({ message, level });
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
    const started = Date.now();
    const results = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "tree-timeout",
      toolName: "write",
      input: { path: "example.txt", content: "test" },
    }, ctx);
    assert.equal(results.find((result) => result?.block)?.block, true);
    assert.ok(Date.now() - started >= 1_000);
    assert.match(last(notifications).message, /Hook failed \(timed out\)/u);
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    assert.equal(existsSync(marker), false);
  } finally {
    await removeDirectoryEventually(directory);
  }
});
