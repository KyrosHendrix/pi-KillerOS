import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { INIT_WORKFLOW_PROMPT, captureInitTargetBaseline, installInitAgentsFile, validateGeneratedGuidance, writeInitAgentsFile } from "../Killeros.ts";
import { createHarness, createTuiContext, emitSequentially, getCommand, getHandlers, getTool, last, resultReason, waitFor, type TestHandler, type TestSentMessage, type TestTool, type TestTuiContext } from "./ExtensionTestHarness.ts";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

type TestNotification = { message: string; level?: string };

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTestSentMessage(value: unknown): value is TestSentMessage["message"] {
  return isUnknownRecord(value)
    && typeof value.customType === "string"
    && typeof value.content === "string";
}

function requireTestSentMessage(value: unknown): TestSentMessage["message"] {
  assert.ok(isTestSentMessage(value), "expected a KillerOS custom message");
  return value;
}

const validGeneratedGuidance = `# AGENTS.md

## 1. Think Before Coding
Check facts before changing code.

## 2. Simplicity First
Use the smallest complete change.

## 3. Surgical Changes
Touch only files required by the task.

## 4. Goal-Driven Execution
Define and run exact verification.
`;

async function emitSuccessfulInitWrite(
  handlers: Map<string, TestHandler[]>,
  tools: Map<string, TestTool>,
  ctx: unknown,
  content: string = validGeneratedGuidance,
  toolCallId = "init-write",
): Promise<void> {
  const input = { content };
  const callResults = await emitSequentially(getHandlers(handlers, "tool_call"), {
    toolCallId,
    toolName: "killeros_init_write",
    input,
  }, ctx);
  assert.equal(callResults.some((result) => (
    typeof result === "object" && result !== null && "block" in result && result.block === true
  )), false);
  await getTool(tools, "killeros_init_write").execute(
    toolCallId,
    input,
    new AbortController().signal,
    () => {},
    ctx,
  );
}

function createFileSymlinkOrSkip(t: TestContext, target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EACCES", "EPERM"].includes(String(error.code))) {
      t.skip("file symlinks are unavailable in this environment");
      return false;
    }
    throw error;
  }
}

test("an active goal blocks /init before repository work starts", async () => {
  const { commands, sentMessages } = createHarness();
  const { ctx } = createTuiContext();
  const notifications: TestNotification[] = [];
  ctx.ui.notify = (message, level) => notifications.push({ message, level });
  await getCommand(commands, "goal").handler("Finish this first", ctx);
  await getCommand(commands, "init").handler("", ctx);
  assert.equal(sentMessages.length, 1);
  assert.match(last(notifications).message, /Pause or clear the active goal/u);
});

test("registers /init as a native command and runs the hidden generation workflow", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-workflow-"));
  try {
    const { commands, handlers, sentMessages, sentUserMessages, tools } = createHarness();
    assert.equal(commands.has("init"), true);
    assert.equal(tools.has("init"), false);
    assert.equal(tools.has("init_survey"), false);

    const notifications: TestNotification[] = [];
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => {},
    };
    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0].options, { triggerTurn: true });
    assert.equal(sentMessages[0].message.customType, "killeros-init");
    assert.equal(sentMessages[0].message.display, false);
    assert.ok(sentMessages[0].message.content.startsWith(INIT_WORKFLOW_PROMPT));
    assert.match(sentMessages[0].message.content, /Initial repository snapshot/u);
    assert.match(sentMessages[0].message.content, /Existing root AGENTS\.md \(protected policy/u);
    assert.match(INIT_WORKFLOW_PROMPT, /## Analyze[\s\S]*## Synthesize[\s\S]*## Generate/u);
    assert.match(INIT_WORKFLOW_PROMPT, /ask no questions/u);
    assert.match(INIT_WORKFLOW_PROMPT, /preserve every compatible existing rule/iu);
    assert.match(INIT_WORKFLOW_PROMPT, /killeros_init_conflict/u);
    assert.match(INIT_WORKFLOW_PROMPT, /at most 2 repository-specific lines per section/u);
    assert.doesNotMatch(INIT_WORKFLOW_PROMPT, /C:\\Users|writing-great-guidelines\/SKILL\.md/u);

    await getCommand(commands, "init").handler("", ctx);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(last(notifications), { message: "/init is already running", level: "warning" });

    await emitSuccessfulInitWrite(handlers, tools, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
    assert.equal(reloadCalls, 1);
    assert.deepEqual(sentUserMessages, []);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    assert.equal(reloadCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init rejects re-entry while the first invocation waits for idle", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-starting-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const notifications: TestNotification[] = [];
    let releaseIdle: () => void = () => {};
    let waitCalls = 0;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => { waitCalls += 1; await idle; },
    };

    const first = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => waitCalls === 1);
    await getCommand(commands, "init").handler("", ctx);
    assert.equal(waitCalls, 1);
    assert.deepEqual(last(notifications), { message: "/init is already running", level: "warning" });

    releaseIdle();
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await first;
    assert.equal(sentMessages.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init cancels preflight when its session shuts down", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-shutdown-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    let releaseIdle: () => void = () => {};
    let waiting = false;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    ctx.cwd = directory;
    ctx.reload = async () => {};
    ctx.waitForIdle = async () => { waiting = true; await idle; };

    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => waiting);
    await emitSequentially(getHandlers(handlers, "session_shutdown"), {}, ctx);
    releaseIdle();
    await initRun;
    assert.equal(sentMessages.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelled /init preflight cannot overwrite a newer session", { timeout: 10_000 }, async () => {
  const slowDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-slow-"));
  const fastDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-fast-"));
  try {
    execFileSync("git", ["init"], { cwd: slowDirectory, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["init"], { cwd: fastDirectory, stdio: "ignore", windowsHide: true });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(path.join(slowDirectory, `source-${index}.txt`), "x".repeat(8_192));
    }
    writeFileSync(path.join(fastDirectory, "package.json"), '{"name":"new-session"}\n');

    const { commands, handlers, sentMessages, tools } = createHarness();
    const context = (cwd: string): TestTuiContext => {
      const { ctx } = createTuiContext();
      ctx.cwd = cwd;
      ctx.reload = async () => {};
      return ctx;
    };
    const slow = getCommand(commands, "init").handler("", context(slowDirectory));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await emitSequentially(getHandlers(handlers, "session_shutdown"), {}, context(slowDirectory));

    const fastContext = context(fastDirectory);
    const fast = getCommand(commands, "init").handler("", fastContext);
    await waitFor(() => sentMessages.length === 1);
    await slow;

    const result = await getTool(tools, "killeros_init_read").execute("new-session-read", { path: "package.json" });
    assert.match(result.content[0].text, /new-session/u);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, fastContext);
    await fast;
  } finally {
    rmSync(slowDirectory, { recursive: true, force: true });
    rmSync(fastDirectory, { recursive: true, force: true });
  }
});

test("/init settles its command handler when the session shuts down", { timeout: 1_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-active-shutdown-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    const notifications: TestNotification[] = [];
    ctx.cwd = directory;
    ctx.reload = async () => {};
    ctx.ui.notify = (message, level) => notifications.push({ message, level });

    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(getHandlers(handlers, "session_shutdown"), {}, ctx);
    await initRun;
    assert.deepEqual(notifications, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init reports failure instead of reloading when the model does not write", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-no-write-"));
  try {
    const { commands, handlers, sentMessages } = createHarness();
    const notifications: TestNotification[] = [];
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => {},
    };
    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;

    assert.equal(reloadCalls, 0);
    assert.deepEqual(last(notifications), {
      message: "/init did not generate AGENTS.md: the model completed without a write or policy-conflict outcome",
      level: "error",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init reports a structured policy conflict without writing or reloading", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-conflict-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "# AGENTS.md\n\nProtected policy.\n");
    const { commands, handlers, sentMessages, tools } = createHarness();
    const notifications: TestNotification[] = [];
    let reloadCalls = 0;
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => { reloadCalls += 1; },
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      waitForIdle: async () => {},
    };
    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    const unsafeReason = "Protected \x1b]2;owned\x07\x1b[31mrelease\x1b[0m\0 policy conflicts with repository evidence.";
    const reason = "Protected release policy conflicts with repository evidence.";
    const conflict = await getTool(tools, "killeros_init_conflict").execute("conflict", { reason: unsafeReason });
    assert.equal(conflict.content[0].text, `Root AGENTS.md was left unchanged: ${reason}`);
    assert.equal(conflict.details.reason, reason);
    await assert.rejects(
      getTool(tools, "killeros_init_write").execute("write-after-conflict", { content: validGeneratedGuidance }),
      /exactly one write or policy-conflict/u,
    );
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nProtected policy.\n");
    assert.equal(reloadCalls, 0);
    assert.deepEqual(last(notifications), { message: `/init left AGENTS.md unchanged: ${reason}`, level: "warning" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init preserves compatible protected policy and blocks every other mutation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-existing-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "AGENTS.md"), "# AGENTS.md\n\nPreserve this workflow.\n");
    writeFileSync(path.join(directory, "src-index.ts"), "export const value = 1;\n");
    const { commands, handlers, sentMessages, tools } = createHarness();
    const ctx = {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    };
    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);

    const readOnly = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "inspect-source",
      toolName: "killeros_init_read",
      input: { path: "src-index.ts" },
    }, ctx);
    assert.equal(readOnly.some((result) => result?.block), false);
    assert.match((await getTool(tools, "killeros_init_read").execute("inspect-source", { path: "src-index.ts" })).content[0].text, /value = 1/u);

    const generated = validGeneratedGuidance.replace("Check facts before changing code.", "Check facts before changing code.\nPreserve this workflow.");
    const replacement = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "replace-existing",
      toolName: "killeros_init_write",
      input: { content: generated },
    }, ctx);
    assert.equal(replacement.some((result) => result?.block), false);
    await getTool(tools, "killeros_init_write").execute("replace-existing", { content: generated }, new AbortController().signal, () => {}, ctx);
    assert.equal(readFileSync(path.join(directory, "AGENTS.md"), "utf8"), generated);

    const secondWrite = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "replace-again",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.match(resultReason(secondWrite), /exactly one write or policy-conflict/u);

    const editTarget = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "edit-existing",
      toolName: "edit",
      input: { path: "AGENTS.md", edits: [{ oldText: "Generated", newText: "Changed" }] },
    }, ctx);
    assert.match(resultReason(editTarget), /bounded evidence and terminal tools/u);

    const otherFile = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "write-other",
      toolName: "write",
      input: { path: "README.md", content: "replacement" },
    }, ctx);
    assert.match(resultReason(otherFile), /bounded evidence and terminal tools/u);

    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init preserves the existing AGENTS.md when atomic replacement fails", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-rename-failure-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "original guidance\n");
    const renameError = Object.assign(new Error("replacement blocked"), { code: "EPERM" });

    await assert.rejects(
      writeInitAgentsFile(target, validGeneratedGuidance, async () => { throw renameError; }),
      /replacement blocked/u,
    );
    assert.equal(readFileSync(target, "utf8"), "original guidance\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init aborts instead of overwriting an in-place concurrent edit", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-concurrent-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "# AGENTS.md\n\nOriginal.\n");
    const baseline = await captureInitTargetBaseline(target);
    writeFileSync(target, "# AGENTS.md\n\nConcurrent user edit.\n");
    await assert.rejects(
      installInitAgentsFile(target, validGeneratedGuidance, baseline),
      /changed while \/init was generating/u,
    );
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nConcurrent user edit.\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init does not report failure after committed candidate cleanup fails", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-cleanup-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    writeFileSync(target, "# AGENTS.md\n\nOriginal.\n");
    const baseline = await captureInitTargetBaseline(target);
    let unlinkCalls = 0;
    const { unlink } = await import("node:fs/promises");
    await installInitAgentsFile(target, validGeneratedGuidance, baseline, {
      unlinkFile: async (filePath) => {
        unlinkCalls += 1;
        if (unlinkCalls === 2) throw new Error("candidate cleanup failed");
        await unlink(filePath);
      },
    });
    assert.equal(readFileSync(target, "utf8"), validGeneratedGuidance);
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init detects a writer that replaces the linked candidate before commit", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-race-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    const baseline = await captureInitTargetBaseline(target);
    const { link, unlink, writeFile } = await import("node:fs/promises");
    await assert.rejects(
      installInitAgentsFile(target, validGeneratedGuidance, baseline, {
        linkFile: async (candidatePath, installedPath) => {
          await link(candidatePath, installedPath);
          await unlink(installedPath);
          await writeFile(installedPath, "# AGENTS.md\n\nNewer external file.\n");
        },
      }),
      /changed while \/init was generating/u,
    );
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nNewer external file.\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init validates generated guidance deterministically", () => {
  assert.equal(validateGeneratedGuidance(validGeneratedGuidance), undefined);
  for (const invalid of [
    validGeneratedGuidance.replace("# AGENTS.md", "# Instructions"),
    `# AGENTS.md extra\n\n${validGeneratedGuidance}`,
    validGeneratedGuidance.replace("## 2. Simplicity First", "## Simplicity"),
    `${validGeneratedGuidance}\n[FILL IN command]`,
    `${validGeneratedGuidance}\n[exact command]`,
    `${validGeneratedGuidance}\n[confirmed command]`,
    "x".repeat(128 * 1024 + 1),
  ]) {
    assert.equal(typeof validateGeneratedGuidance(invalid), "string");
  }
});

test("/init blocks a linked AGENTS.md target before a model turn", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-target-"));
  try {
    writeFileSync(path.join(directory, "shared.md"), "shared instructions\n");
    if (!createFileSymlinkOrSkip(t, "shared.md", path.join(directory, "AGENTS.md"))) return;
    await assert.rejects(captureInitTargetBaseline(path.join(directory, "AGENTS.md")), /regular, non-linked file/u);
    assert.equal(readFileSync(path.join(directory, "shared.md"), "utf8"), "shared instructions\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init rejects a target swapped after tool-call validation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-swap-target-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    const target = path.join(directory, "AGENTS.md");
    const shared = path.join(directory, "shared.md");
    writeFileSync(target, "old guidance\n");
    writeFileSync(shared, "shared guidance\n");
    const { commands, handlers, sentMessages, tools } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    getHandlers(handlers, "tool_call").push((event) => {
      if (event.toolName !== "killeros_init_write") return;
      rmSync(target);
      try {
        linkSync(shared, target);
      } catch {
        mkdirSync(target);
      }
      return undefined;
    });
    const callResults = await emitSequentially(getHandlers(handlers, "tool_call"), {
      toolCallId: "swap-target",
      toolName: "killeros_init_write",
      input: { content: "replacement" },
    }, ctx);
    assert.equal(callResults.some((result) => result?.block), false);
    await assert.rejects(
      getTool(tools, "killeros_init_write").execute("swap-target", { content: validGeneratedGuidance }, new AbortController().signal, () => {}, ctx),
      /changed while \/init was generating|regular, non-linked file/u,
    );
    assert.equal(readFileSync(shared, "utf8"), "shared guidance\n");
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init preserves a target created after an absent baseline", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-new-"));
  try {
    const target = path.join(directory, "AGENTS.md");
    const baseline = await captureInitTargetBaseline(target);
    writeFileSync(target, "# AGENTS.md\n\nConcurrent creator.\n");
    await assert.rejects(
      installInitAgentsFile(target, validGeneratedGuidance, baseline),
      /changed while \/init was generating/u,
    );
    assert.equal(readFileSync(target, "utf8"), "# AGENTS.md\n\nConcurrent creator.\n");
    assert.deepEqual(readdirSync(directory), ["AGENTS.md"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init recovers when its agent workflow cannot start", async () => {
  const { api, commands, handlers, sentMessages } = createHarness();
  const notifications: TestNotification[] = [];
  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    mode: "tui",
    reload: async () => {},
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  };
  api.sendMessage = () => { throw new Error("no active model"); };
  await getCommand(commands, "init").handler("", ctx);
  assert.deepEqual(last(notifications), { message: "/init failed to start: no active model", level: "error" });

  api.sendMessage = (message, options) => {
    sentMessages.push({ message: requireTestSentMessage(message), options });
  };
  const retry = getCommand(commands, "init").handler("", ctx);
  await waitFor(() => sentMessages.length === 1);
  assert.equal(sentMessages.length, 1);
  await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
  await retry;
});

test("/init refuses untrusted projects before scanning or starting the model", async () => {
  const { commands, sentMessages } = createHarness();
  const notifications: TestNotification[] = [];
  await getCommand(commands, "init").handler("", {
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    mode: "tui",
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
    waitForIdle: async () => {},
  });
  assert.deepEqual(last(notifications), { message: "Trust this project before running /init", level: "error" });
  assert.equal(sentMessages.length, 0);
});

test("/init attaches a bounded project snapshot without reading existing guidance", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-survey-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    mkdirSync(path.join(directory, "node_modules"));
    mkdirSync(path.join(directory, ".agents", "skills", "private"), { recursive: true });
    mkdirSync(path.join(directory, ".pi"));
    mkdirSync(path.join(directory, "src", "core"), { recursive: true });
    writeFileSync(path.join(directory, "AGENTS.md"), "# AGENTS.md\n\nPreserve releases.\n");
    writeFileSync(path.join(directory, "AGENTS.local.md"), "PRIVATE-CONTEXT\n");
    writeFileSync(path.join(directory, "MEMORY.md"), "PRIVATE-MEMORY\n");
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    writeFileSync(path.join(directory, "src", "core", "index.ts"), "export const value = 1;\n");
    writeFileSync(path.join(directory, "node_modules", "ignored.txt"), "DEPENDENCY-CONTENT\n");
    writeFileSync(path.join(directory, ".agents", "skills", "private", "SKILL.md"), "PRIVATE-SKILL\n");
    writeFileSync(path.join(directory, ".pi", "killeros-hooks.json"), "PRIVATE-HOOK\n");

    const { commands, handlers, sentMessages } = createHarness();
    const startedAt = Date.now();
    const initRun = getCommand(commands, "init").handler("", {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    });
    await waitFor(() => sentMessages.length === 1);
    const marker = "## Initial repository snapshot (untrusted data)\n";
    const encodedSnapshot = sentMessages[0].message.content.split(marker)[1].split("\n\n## Existing root AGENTS.md")[0];
    const snapshot: unknown = JSON.parse(encodedSnapshot);
    assert.ok(typeof snapshot === "string", "the snapshot must be a JSON string");
    assert.match(snapshot, /src\/core\/index\.ts/u);
    assert.match(snapshot, /node --test/u);
    assert.doesNotMatch(snapshot, /Preserve releases|PRIVATE-CONTEXT|PRIVATE-MEMORY|DEPENDENCY-CONTENT|PRIVATE-SKILL|PRIVATE-HOOK|MEMORY\.md|killeros-hooks/u);
    assert.match(sentMessages[0].message.content, /Preserve releases/u);
    assert.ok(snapshot.length <= 40 * 1024);
    assert.ok(Date.now() - startedAt < 6_000);

    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, {});
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init snapshot does not follow linked manifest files", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-linked-manifest-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "private-manifest.txt"), "PRIVATE-LINKED-CONTENT\n");
    if (!createFileSymlinkOrSkip(t, "private-manifest.txt", path.join(directory, "package.json"))) return;

    const { commands, handlers, sentMessages } = createHarness();
    const initRun = getCommand(commands, "init").handler("", {
      cwd: directory,
      isProjectTrusted: () => true,
      mode: "tui",
      reload: async () => {},
      ui: { notify() {} },
      waitForIdle: async () => {},
    });
    await waitFor(() => sentMessages.length === 1);
    assert.doesNotMatch(sentMessages[0].message.content, /PRIVATE-LINKED-CONTENT/u);

    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, {});
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init tool scoping never exposes killeros_init_write outside /init", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-tool-scope-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "README.md"), "# Probe\n");
    const { commands, handlers, sentMessages, activeTools } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.ui.notify = () => {};

    for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "startup" }, ctx);
    assert.ok(activeTools.length > 0);
    assert.equal(activeTools.includes("killeros_init_write"), false);
    const fullSet = [...activeTools];

    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    assert.deepEqual(activeTools, [
      "killeros_init_read",
      "killeros_init_list",
      "killeros_init_write",
      "killeros_init_conflict",
    ]);

    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
    assert.deepEqual(activeTools, fullSet);

    for (const handler of getHandlers(handlers, "session_start")) await handler({ reason: "new" }, ctx);
    assert.deepEqual(activeTools, fullSet);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init tool middleware does not freeze or redefine shared event input", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-middleware-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "safe.ts"), "safe\n");
    const { commands, handlers, sentMessages } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    const input = { path: "safe.ts" };
    const event = { toolCallId: "mutable", toolName: "killeros_init_read", input };
    await emitSequentially(getHandlers(handlers, "tool_call"), event, ctx);
    assert.equal(Object.isFrozen(input), false);
    input.path = "changed-by-another-extension.ts";
    assert.equal(event.input.path, "changed-by-another-extension.ts");
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init reloads only after existing agent-settled hooks complete", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-settled-"));
  try {
    const configDirectory = path.join(directory, ".pi");
    mkdirSync(configDirectory);
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('hook.done','done')"`;
    writeFileSync(path.join(configDirectory, "killeros-hooks.json"), JSON.stringify({
      hooks: { agent_settled: [{ command, timeoutMs: 5_000 }] },
    }));

    const { commands, handlers, sentMessages, tools } = createHarness();
    const { ctx } = createTuiContext();
    ctx.cwd = directory;
    ctx.waitForIdle = async () => {};
    let reloadCalls = 0;
    ctx.reload = async () => {
      assert.equal(readFileSync(path.join(directory, "hook.done"), "utf8"), "done");
      reloadCalls += 1;
    };
    for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);

    const initRun = getCommand(commands, "init").handler("", ctx);
    await waitFor(() => sentMessages.length === 1);
    await emitSuccessfulInitWrite(handlers, tools, ctx);
    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
    assert.equal(reloadCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
