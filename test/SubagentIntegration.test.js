import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registerSubagentTool } from "../subagents.ts";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi-child.mjs", import.meta.url));

function roleFile() {
  return [
    "---",
    "name: scout",
    "description: Read-only scout",
    "access: read",
    "tools: read, grep",
    "---",
    "",
    "Map the assigned scope and return a report.",
    "",
  ].join("\n");
}

function throwingUi() {
  return new Proxy({}, {
    get(_target, property) {
      return async () => {
        throw new Error(`Unexpected UI call: ${String(property)}`);
      };
    },
  });
}

function toolContext(root, sessionDirectory) {
  const parentModel = {
    provider: "test",
    id: "parent-model",
    name: "Parent model",
    reasoning: true,
  };
  return {
    cwd: root,
    hasUI: false,
    mode: "json",
    isProjectTrusted: () => true,
    model: parentModel,
    thinkingLevel: "high",
    modelRegistry: {
      getAvailable: () => [parentModel],
      find: (provider, id) => provider === parentModel.provider && id === parentModel.id ? parentModel : undefined,
    },
    sessionManager: {
      getSessionId: () => "parent-session",
      getSessionDir: () => sessionDirectory,
    },
    ui: throwingUi(),
  };
}

function valueAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

async function execute(tool, params, ctx) {
  return tool.execute("subagent-integration", params, new AbortController().signal, () => {}, ctx);
}

test("real child boundary passes isolated named sessions and reuses them on resume", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "killeros-subagent-integration-"));
  const bundledAgentsDir = path.join(root, "bundled");
  const userAgentsDir = path.join(root, "personal");
  const parentSessionDirectory = path.join(root, "parent-session");
  mkdirSync(bundledAgentsDir);
  mkdirSync(userAgentsDir);
  mkdirSync(parentSessionDirectory);
  writeFileSync(path.join(bundledAgentsDir, "scout.md"), roleFile());

  let tool;
  const childArguments = [];
  const childEnvironments = [];
  try {
    registerSubagentTool({ registerTool(value) { tool = value; } }, {
      bundledAgentsDir,
      userAgentsDir,
      awaitSpawnCompletion: true,
      spawnProcess(args, cwd, environment) {
        const childEnvironment = { ...process.env, ...(environment ?? {}) };
        childArguments.push([...args]);
        childEnvironments.push(childEnvironment);
        assert.equal(childEnvironment.PI_SESSION_FILE, undefined);
        assert.equal(childEnvironment.PI_SESSION_ID, undefined);
        return spawn(process.execPath, [fixture, ...args], {
          cwd,
          env: childEnvironment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      },
    });
    assert.ok(tool);

    const ctx = toolContext(root, parentSessionDirectory);
    const first = await execute(tool, {
      agent: "scout",
      task: "Map auth",
      name: "auth-audit",
    }, ctx);
    const firstResult = first.details.results[0];
    const firstThread = first.details.threads.find((thread) => thread.id === firstResult.id);
    const firstArgs = childArguments[0];
    const sessionDirectory = valueAfter(firstArgs, "--session-dir");
    const sessionId = valueAfter(firstArgs, "--session-id");

    assert.equal(valueAfter(firstArgs, "--mode"), "json");
    for (const flag of [
      "--session-dir",
      "--session-id",
      "--name",
      "--no-extensions",
      "--extension",
      "--no-prompt-templates",
      "--model",
      "--thinking",
      "--tools",
      "--append-system-prompt",
    ]) {
      assert.ok(firstArgs.includes(flag), `missing ${flag}`);
    }
    assert.equal(valueAfter(firstArgs, "--name"), "auth-audit");
    assert.equal(valueAfter(firstArgs, "--extension"), "npm:pi-web-access");
    assert.equal(firstResult.status, "complete");
    assert.equal(firstResult.output, "child:auth-audit");
    assert.equal(firstResult.exitConfirmed, true);
    assert.equal(firstResult.name, "auth-audit");
    assert.equal(firstResult.attempt, 1);
    assert.equal(firstThread.name ?? firstThread.displayName, "auth-audit");
    assert.equal(firstThread.attempt, 1);
    assert.equal(existsSync(sessionDirectory), true);
    assert.deepEqual(JSON.parse(readFileSync(path.join(sessionDirectory, `${sessionId}.jsonl`), "utf8")), {
      name: "auth-audit",
      sessionId,
    });
    assert.equal(childEnvironments.length, 1);

    const resumed = await execute(tool, {
      action: "resume",
      threadId: "auth-audit",
      task: "Continue auth review",
    }, ctx);
    const secondArgs = childArguments[1];
    const secondResult = resumed.details.results.find((result) => result.id === firstResult.id);
    const secondThread = resumed.details.threads.find((thread) => thread.id === firstResult.id);

    assert.equal(childArguments.length, 2);
    assert.equal(valueAfter(secondArgs, "--session-dir"), sessionDirectory);
    assert.equal(valueAfter(secondArgs, "--session-id"), sessionId);
    assert.equal(valueAfter(secondArgs, "--name"), "auth-audit");
    assert.equal(secondResult.status, "complete");
    assert.equal(secondResult.output, "child:auth-audit");
    assert.equal(secondResult.exitConfirmed, true);
    assert.equal(secondResult.attempt, 2);
    assert.equal(secondThread.attempt, 2);
    assert.equal(secondThread.name ?? secondThread.displayName, "auth-audit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
