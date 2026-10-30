import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseGoalState } from "../killeros/goal-state.ts";
import type { GoalState } from "../killeros/runtime.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = { timeout: 40_000, skip: piRpcShutdownSkip };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): RecordValue {
  assert.ok(isRecord(value));
  return value;
}
function records(value: unknown): RecordValue[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}
function goalState(status: "active" | "paused" = "paused", turns = 0) {
  const now = Date.now();
  const common = { version: 1, revision: 1, objective: "Old objective before the user edit", createdAt: now, updatedAt: now,
    activeMilliseconds: 0, turns, blockedAuditStartTurn: 0, baselineTokens: 0, maxTurns: 20, turnPhase: "ready" } satisfies Partial<GoalState>;
  return status === "active" ? { ...common, status, activeStartedAt: now } : { ...common, status };
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("Timed out waiting for the CLI fixture result");
}
function decision(args: RecordValue, id = "decision"): Reply {
  return { delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "killeros_goal_update", arguments: JSON.stringify(args) } }] }, finish: "tool_calls" };
}
type Reply = { text?: string; delta?: RecordValue; finish?: string };

/** Runs the real installed CLI, with isolated settings and a loopback-only scripted provider. */
async function fixture(t: TestContext, respond: (body: RecordValue, count: number) => Reply | Promise<Reply>, seedGoal?: GoalState) {
  const directory = mkdtempSync(path.join(root, "node_modules/.killeros-goal-handoff-"));
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const bodies: RecordValue[] = [];
  const faults: string[] = [];
  let cli: PiRpcProcess | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes <= 1_048_576);
        chunks.push(Buffer.from(chunk));
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      bodies.push(body);
      const result = await respond(body, bodies.length);
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `handoff-${bodies.length}`, model: "local", choices: [{ index: 0,
        delta: result.delta ?? { content: result.text ?? "" }, finish_reason: result.finish ?? "stop" }] })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(String(error));
      if (!response.destroyed) { response.writeHead(500); response.end("Fixture failure"); }
    });
  });
  t.after(async () => {
    try {
      if (cli) {
        const cleanup = await cli.close();
        assert.equal(cleanup.forced, false, cli.diagnostics());
        assert.equal(cleanup.exit.code, 0, cli.diagnostics());
        assert.equal(cleanup.treeCleanupError, undefined);
      }
      assert.deepEqual(faults, []);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await removeDirectoryEventually(directory);
    }
  });
  mkdirSync(agent);
  mkdirSync(project);
  const source = SessionManager.create(project, sessions);
  source.appendMessage({ role: "user", content: "Keep the source session context.", timestamp: Date.now() });
  source.appendMessage({ role: "assistant", content: [{ type: "text", text: "The previous work is saved." }], api: "openai-completions",
    provider: "handoff-local", model: "local", usage, stopReason: "stop", timestamp: Date.now() });
  source.appendCustomEntry("fixture-marker", { position: "earlier" });
  source.appendMessage({ role: "user", content: "Continue from the latest source position.", timestamp: Date.now() });
  if (seedGoal) {
    assert.ok(parseGoalState(seedGoal), "The saved goal fixture must be valid");
    source.appendCustomEntry("killeros-goal", { version: 1, event: "pause", state: seedGoal });
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "handoff-local": { api: "openai-completions", apiKey: "fixture-only",
    baseUrl: `http://127.0.0.1:${address.port}/v1`, models: [{ id: "local", name: "Local handoff fixture", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    TEMP: directory, TMP: directory, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) env[key] = inherited.get(key.toLowerCase());
  const sourceFile = source.getSessionFile();
  assert.ok(sourceFile);
  const rpc = new PiRpcProcess({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd: project, env,
    args: ["--mode", "rpc", "--model", "handoff-local/local", "--thinking", "off", "--tools", "killeros_goal_update", "--session", sourceFile,
      "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions", "--extension", root] });
  cli = rpc;
  await rpc.command("get_state", {}, { signal: t.signal });
  const prompt = (message: string) => rpc.command("prompt", { message }, { timeoutMs: 20_000, signal: t.signal });
  const state = async () => record((await rpc.command("get_state", {}, { signal: t.signal })).data);
  const entries = () => SessionManager.open(sourceFile).getBranch();
  const lastGoal = (): GoalState => {
    const entry = entries().filter(entry => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(entry && entry.type === "custom");
    const goal = parseGoalState(record(entry.data).state);
    assert.ok(goal);
    return goal;
  };
  const run = async (message: string) => {
    const after = rpc.currentSequence;
    await prompt(message);
    await rpc.waitFor(event => event.type === "agent_settled", { after, signal: t.signal });
    assert.equal((await state()).isStreaming, false);
  };
  return { bodies, project, lastGoal, prompt, state, run };
}

test("quoted Create rejects a missing file, then accepts file proof on resume", options, async t => {
  const f = await fixture(t, body => records(body.messages).at(-1)?.role === "tool" ? { text: "Settled." }
    : decision({ status: "complete", evidence: "Verified the requested artifact." }));
  await f.run("/goal Create `./summary.md` describing this repository's entry points, verified against the source files");
  assert.equal(f.lastGoal().status, "paused");
  assert.equal(f.lastGoal().verification?.kind, "file");
  assert.deepEqual(f.lastGoal().verification?.baseline, { exists: false });
  assert.equal(f.lastGoal().stopReason, "no turn decision");
  writeFileSync(path.join(f.project, "summary.md"), "Verified repository entry points.");
  await f.run("/goal resume");
  assert.equal(f.lastGoal().status, "complete");
  assert.equal(f.lastGoal().lastDecision?.kind, "complete");
  assert.deepEqual(f.lastGoal().lastDecision, { kind: "complete", turn: 2, evidence: "Verified the requested artifact.", verification: "file" });
});

test("editing a paused goal applies the shared Create inference without resetting counters", options, async t => {
  const f = await fixture(t, () => ({ text: "No work requested." }), goalState("paused", 4));
  const cases: Array<[string, boolean]> = [
    ['Create `./summary.md` and review `./summary.md`', true],
    ['Create `./summary.md` and `./other.md`', false],
    ['Create "a concise summary"', false],
    ['Create `./reports/`', false],
    ['Create `https://example.com/summary.md`', false],
  ];
  for (const [objective, file] of cases) {
    await f.prompt(`/goal edit ${objective}`);
    assert.equal(f.lastGoal().verification?.kind === "file", file, objective);
    assert.equal(f.lastGoal().turns, 4);
    assert.equal(f.lastGoal().maxTurns, 20);
    assert.equal(f.lastGoal().status, "paused");
  }
  assert.equal(f.bodies.length, 0);
});

test("saved turn-17 work stops at 20 and explicit resume finishes at 22", options, async t => {
  let logical = 17;
  const f = await fixture(t, body => {
    if (records(body.messages).at(-1)?.role === "tool") return { text: `Settled logical turn ${logical}.` };
    logical++;
    return decision(logical === 22 ? { status: "complete", evidence: "Verified the turn boundary." }
      : { status: "continue", evidence: `Progress on turn ${logical}`, nextAction: `Perform work on turn ${logical + 1}` }, `turn-${logical}`);
  }, goalState("active", 17));
  await until(() => f.lastGoal().status === "paused" && f.lastGoal().turns === 20);
  await until(async () => (await f.state()).isStreaming === false);
  assert.equal(logical, 20);
  assert.equal(f.lastGoal().maxTurns, 20);
  await f.prompt("/goal resume");
  await until(() => f.lastGoal().status === "complete");
  await until(async () => (await f.state()).isStreaming === false);
  assert.equal(f.lastGoal().turns, 22);
  assert.equal(f.lastGoal().maxTurns, 40);
  assert.equal(logical - 17, 5);
});

test("three blocker audits stop work and later completion grants no new turns", options, async t => {
  let decisions = 0;
  let audits = 0;
  let complete = false;
  const f = await fixture(t, body => {
    if (records(body.messages).at(-1)?.role === "tool") {
      if (!complete) {
        // This exchange holds Pi before settlement can advance to the next goal turn.
        const saved = f.lastGoal();
        audits++;
        assert.equal(audits, decisions);
        assert.equal(saved.status, audits < 3 ? "active" : "blocked");
        assert.equal(saved.turns, audits);
        const evidence = `Service still unavailable on audit ${audits}`;
        assert.deepEqual(saved.blockerAudit, { key: "external-service", streak: audits, lastTurn: audits, evidence });
        assert.deepEqual(saved.turnDecision ?? saved.lastDecision, {
          kind: audits < 3 ? "blocker-audit" : "blocked", turn: audits, blockerKey: "external-service", streak: audits, evidence,
        });
        assert.equal(records(body.messages).at(-1)?.content, audits < 3
          ? `Blocker audit ${audits}/3 recorded; the goal remains active: ${evidence}` : `Goal marked blocked: ${evidence}`);
      }
      return { text: "Decision recorded." };
    }
    decisions++;
    return decision(complete ? { status: "complete", evidence: "Verified the whole unchanged objective." }
      : { status: "blocked", blockerKey: "external-service", evidence: `Service still unavailable on audit ${decisions}` }, `audit-${decisions}`);
  });
  await f.prompt("/goal Finish the unchanged objective after verifying the service");
  await until(() => f.lastGoal().status === "blocked");
  await until(async () => (await f.state()).isStreaming === false);
  assert.equal(f.lastGoal().turns, 3);
  assert.equal(decisions, 3);
  assert.equal(audits, 3);
  assert.equal(f.bodies.length, 6);
  complete = true;
  await f.run("Verify completion of the saved blocked objective");
  assert.equal(f.lastGoal().status, "complete");
  assert.equal(f.lastGoal().turns, 3);
  assert.equal(decisions, 4);
  assert.equal(f.bodies.length, 8);
  assert.deepEqual(f.lastGoal().lastDecision, {
    kind: "complete", turn: 3, evidence: "Verified the whole unchanged objective.", verification: "model-reported",
  });
});

test("direct quoted Update rejects unchanged content and pauses without a decision", options, async t => {
  const f = await fixture(t, body => records(body.messages).at(-1)?.role === "tool" ? { text: "The file is unchanged." }
    : decision({ status: "complete", evidence: "Claimed completion without changing content." }));
  writeFileSync(path.join(f.project, "existing.md"), "Original content.");
  await f.run("/goal Update `./existing.md` with the verified result");
  assert.equal(f.lastGoal().verification?.kind, "file");
  assert.equal(f.lastGoal().status, "paused");
  assert.equal(f.lastGoal().stopReason, "no turn decision");
});
