import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHarness, emitSequentially, getCommand, getHandlers, waitFor } from "./ExtensionTestHarness.ts";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolvePersonalInstructions } from "../killeros/personal-instructions.ts";

test("does not inject AGENTS.local.md into the /init generation turn", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-personal-"));
  try {
    writeFileSync(path.join(directory, "AGENTS.local.md"), "PRIVATE-INIT-GUIDANCE\n");
    const { commands, handlers, sentMessages } = createHarness();
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

    let event = { systemPrompt: "shared AGENTS context" };
    for (const handler of getHandlers(handlers, "before_agent_start")) {
      const update = await handler(event, ctx);
      if (update?.systemPrompt) event = { ...event, systemPrompt: update.systemPrompt };
    }
    assert.doesNotMatch(event.systemPrompt, /PRIVATE-INIT-GUIDANCE|personal_instructions/u);

    await emitSequentially(getHandlers(handlers, "agent_settled"), {}, ctx);
    await initRun;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("personal instruction imports stay inside Pi's agent directory", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-personal-"));
  const projectDirectory = path.join(directory, "project");
  const agentDirectory = path.join(directory, "agent");
  mkdirSync(projectDirectory);
  mkdirSync(agentDirectory);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  try {
    const importedPath = path.join(agentDirectory, "personal.md");
    writeFileSync(importedPath, "Prefer concise tradeoff explanations.\n");
    writeFileSync(path.join(projectDirectory, "AGENTS.local.md"), `@${importedPath}\n`);
    const { handlers } = createHarness();
    let event = { systemPrompt: "shared AGENTS context" };
    const ctx = { cwd: projectDirectory, isProjectTrusted: () => true };
    for (const handler of getHandlers(handlers, "before_agent_start")) {
      const update = await handler(event, ctx);
      if (update?.systemPrompt) event = { ...event, systemPrompt: update.systemPrompt };
    }
    assert.match(event.systemPrompt, /shared AGENTS context/u);
    assert.match(event.systemPrompt, /\n<personal_instructions>\n/u);
    assert.doesNotMatch(event.systemPrompt, /source=/u);
    assert.match(event.systemPrompt, /Prefer concise tradeoff explanations\./u);

    const rejected = [
      path.join(projectDirectory, "outside.md"),
      path.join(agentDirectory, "oversized.md"),
      path.join(agentDirectory, "hard-linked.md"),
    ];
    writeFileSync(rejected[0], "OUTSIDE_PRIVATE_VALUE\n");
    writeFileSync(rejected[1], "x".repeat(32 * 1024 + 1));
    linkSync(importedPath, rejected[2]);
    const linkedPath = path.join(agentDirectory, "linked.md");
    try {
      symlinkSync(importedPath, linkedPath, "file");
      rejected.push(linkedPath);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM"].includes(String(error.code))) throw error;
    }
    for (const rejectedPath of rejected) {
      writeFileSync(path.join(projectDirectory, "AGENTS.local.md"), `@${rejectedPath}\n`);
      const instructions = resolvePersonalInstructions(projectDirectory);
      assert.equal(instructions, undefined, rejectedPath);
    }

    event = { systemPrompt: "shared" };
    for (const handler of getHandlers(handlers, "before_agent_start")) {
      const update = await handler(event, { cwd: projectDirectory, isProjectTrusted: () => false });
      if (update?.systemPrompt) event = { ...event, systemPrompt: update.systemPrompt };
    }
    assert.doesNotMatch(event.systemPrompt, /personal_instructions/u);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("personal instructions reject a linked AGENTS.local.md", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-personal-link-"));
  const projectDirectory = path.join(directory, "project");
  mkdirSync(projectDirectory);
  try {
    const externalPath = path.join(directory, "external.md");
    writeFileSync(externalPath, "EXTERNAL_PRIVATE_VALUE\n");
    linkSync(externalPath, path.join(projectDirectory, "AGENTS.local.md"));
    assert.equal(resolvePersonalInstructions(projectDirectory), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("personal instruction truncation preserves valid UTF-8", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-personal-"));
  try {
    writeFileSync(path.join(directory, "AGENTS.local.md"), `${"a".repeat(32_767)}é`, "utf8");
    const instructions = resolvePersonalInstructions(directory);
    assert.ok(instructions);
    assert.doesNotMatch(instructions, /�/u);
    assert.match(instructions, /truncated by KillerOS/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
