import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

test("the KillerOS package activates and reloads through Pi's public lifecycle", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-pi-lifecycle-"));
  try {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const lifecycle: string[] = [];
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: [process.cwd()],
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
