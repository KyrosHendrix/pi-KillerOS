import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { registerSubagentTool } from "../subagents.ts";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  closed = false;

  json(event) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }

  kill() {
    setImmediate(() => this.close(143));
    return true;
  }

  close(code = 0) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

function reviewerRole() {
  return [
    "---",
    "name: reviewer",
    "description: Read-only reviewer",
    "access: read",
    "tools: read, grep",
    "---",
    "",
    "Review the assigned scope and return a report.",
    "",
  ].join("\n");
}

function assistantReport(index) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "test",
      model: "reviewer-model",
      content: [{ type: "text", text: `review ${index} report` }],
      stopReason: "stop",
      usage: {
        input: 200_000,
        output: 50_001,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 250_001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
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

function toolContext(cwd, { mode, hasUI = true } = {}) {
  const model = { provider: "test", id: "parent-model", reasoning: true };
  return {
    cwd,
    mode,
    hasUI,
    isProjectTrusted: () => true,
    model,
    thinkingLevel: "high",
    modelRegistry: { getAvailable: () => [model] },
    ui: throwingUi(),
  };
}

test("ten parallel read-only reviewers complete past 250,000 tokens within the default safety limits", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "killeros-codex-parity-"));
  const bundledAgentsDir = path.join(root, "bundled");
  const userAgentsDir = path.join(root, "personal");
  mkdirSync(bundledAgentsDir);
  mkdirSync(userAgentsDir);
  writeFileSync(path.join(bundledAgentsDir, "reviewer.md"), reviewerRole());

  const children = [];
  let tool;
  try {
    registerSubagentTool({ registerTool(value) { tool = value; } }, {
      bundledAgentsDir,
      userAgentsDir,
      awaitSpawnCompletion: true,
      limits: { maxTasks: 10, maxReadConcurrency: 10 },
      spawnProcess: (args) => {
        assert.equal(args.some((arg) => /max[-_]?turns/i.test(arg)), false);
        const child = new FakeProcess();
        children.push(child);
        if (children.length === 10) {
          queueMicrotask(() => children.forEach((process, index) => {
            process.json(assistantReport(index + 1));
            process.close();
          }));
        }
        return child;
      },
    });
    assert.equal(tool.parameters.properties.tasks.maxItems, 10);

    const result = await tool.execute("subagent-codex-parity", {
      tasks: Array.from({ length: 10 }, (_, index) => ({ agent: "reviewer", task: `Review scope ${index + 1}`, name: `review-${index + 1}` })),
    }, new AbortController().signal, () => {}, {
      cwd: root,
      hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "test", id: "parent-model", reasoning: true },
      thinkingLevel: "high",
      modelRegistry: { getAvailable: () => [{ provider: "test", id: "parent-model", reasoning: true }] },
      ui: { confirm: async () => true },
    });

    assert.equal(children.length, 10);
    assert.equal(result.details.results.length, 10);
    assert.ok(result.details.results.every((review) => review.access === "read"));
    assert.ok(result.details.results.every((review) => review.status === "complete"));
    assert.ok(result.details.results.every((review) => review.status !== "limited"));
    assert.ok(result.details.results.every((review) => review.usage.totalTokens > 250_000));
    assert.equal(result.details.aggregateUsage.totalTokens, 2_500_010);
    assert.deepEqual(
      result.details.results.map((review) => review.output).sort(),
      Array.from({ length: 10 }, (_, index) => `review ${index + 1} report`).sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["tui", "rpc", "json", "print"]) {
  test(`subagent control works in ${mode} mode without relying on TUI prompts`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "killeros-codex-mode-"));
    const bundledAgentsDir = path.join(root, "bundled");
    const userAgentsDir = path.join(root, "personal");
    mkdirSync(bundledAgentsDir);
    mkdirSync(userAgentsDir);
    writeFileSync(path.join(bundledAgentsDir, "scout.md"), reviewerRole().replace(/reviewer/gu, "scout"));

    try {
      let tool;
      registerSubagentTool({ registerTool(value) { tool = value; } }, {
        bundledAgentsDir,
        userAgentsDir,
        awaitSpawnCompletion: true,
        spawnProcess() {
          const child = new FakeProcess();
          queueMicrotask(() => {
            child.json(assistantReport(1));
            child.close();
          });
          return child;
        },
      });
      const ctx = toolContext(root, { mode, hasUI: mode === "tui" });
      const result = await tool.execute(
        `subagent-codex-${mode}`,
        { agent: "scout", task: `mode:${mode}` },
        new AbortController().signal,
        () => {},
        ctx,
      );
      assert.equal(result.details.results[0].status, "complete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
