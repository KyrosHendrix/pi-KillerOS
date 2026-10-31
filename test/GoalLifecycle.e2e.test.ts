import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

async function createIsolatedGoalDirectory(prefix: string): Promise<string> {
  const directory = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), prefix)));
  try {
    for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, ".git")), false,
        "Goal fixtures must not discover an ancestor Git repository");
      if (path.dirname(ancestor) === ancestor) break;
    }
    return directory;
  } catch (error) {
    await removeDirectoryEventually(directory);
    throw error;
  }
}

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Json {
  assert.ok(isRecord(value), "Expected a JSON object");
  return value;
}
function records(value: unknown): Json[] {
  assert.ok(Array.isArray(value), "Expected a JSON array");
  return value.map(record);
}
function barrier() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}
async function reached(promise: Promise<void>, signal: AbortSignal, label: string): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), 20_000);
    const abort = (): void => finish(new Error(`${label} cancelled`, { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(() => finish(), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

type Reply = { kind: "stop" } | { kind: "complete"; evidence: string } | { kind: "error"; message: string }
  | { kind: "calls"; decisions: Json[] };
type ProviderPlan = {
  reply: Reply;
  release: ReturnType<typeof barrier>;
  started: ReturnType<typeof barrier>;
  closed: ReturnType<typeof barrier>;
  body: Json | undefined;
};
function plan(reply: Reply, held = false): ProviderPlan {
  const release = barrier();
  if (!held) release.release();
  return { reply, release, started: barrier(), closed: barrier(), body: undefined };
}
function savedGoal(manager: SessionManager, event: string, state: Json): string {
  return manager.appendCustomEntry("killeros-goal", { version: 1, event, state });
}
function activeGoal(objective: string, now: number) {
  return { version: 1, revision: 3, objective, status: "active", createdAt: now - 60_000, updatedAt: now - 10_000,
    activeMilliseconds: 20_000, activeStartedAt: now - 10_000, turns: 2, blockedAuditStartTurn: 0,
    baselineTokens: 0, maxTurns: 4, turnPhase: "ready" };
}

/** One private saved history. Only an explicit reopen shares its session across fresh CLI processes. */
async function history(
  t: TestContext,
  scenarioId: "goals.restore-valid" | "goals.restore-validation" | "goals.blockers"
    | "goals.report-validation" | "goals.duration-overflow" | "goals.blocker-corruption" | "goals.provider-error",
  label: string,
  expected: { launches: number; requests: number },
  seed: (manager: SessionManager) => void,
  run: (f: {
    file: string;
    enqueue(reply: Reply, held?: boolean): ReturnType<typeof plan>;
    launch(): Promise<void>;
    close(): Promise<void>;
    rpc(): PiRpcProcess;
    state(): Promise<Json>;
    entries(): Promise<Json[]>;
    goals(): Array<{ event: unknown; state: Json }>;
    continuations(): string[];
    prompt(message: string): Promise<number>;
    settled(after: number): Promise<void>;
    notice(): Promise<string>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await createIsolatedGoalDirectory("killeros-goal-restore-");
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  for (const child of [agent, project, sessions, temporary]) mkdirSync(child);
  const plans: ReturnType<typeof plan>[] = [];
  const requests: Json[] = [];
  const faults: string[] = [];
  const snapshots: Json[] = [];
  const exits: unknown[] = [];
  let launches = 0;
  let rpc: PiRpcProcess | undefined;
  let lastDiagnostics: string | undefined;
  let file: string | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const handlers = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const handling = (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer saved-goal-fixture");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576, "Provider input must stay bounded");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert.equal(body.model, "local");
      const item = plans[requests.length];
      requests.push(body);
      assert.ok(item, "No unauthorized continuation or retry may reach the provider");
      item.body = body;
      response.once("close", () => item.closed.release());
      item.started.release();
      await Promise.race([item.release.promise, item.closed.promise]);
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      if (item.reply.kind === "error") {
        // A real SSE provider error avoids manufacturing an assistant result or a host event.
        response.end(`data: ${JSON.stringify({ error: { message: item.reply.message, type: "fixture_error" } })}\n\n`);
        return;
      }
      const delta = item.reply.kind === "calls"
        ? { tool_calls: item.reply.decisions.map((decision, index) => ({ index, id: `audit-${requests.length}-${index}`, type: "function",
          function: { name: "killeros_goal_update", arguments: JSON.stringify(decision) } })) }
        : item.reply.kind === "complete"
          ? { tool_calls: [{ index: 0, id: `goal-complete-${requests.length}`, type: "function",
            function: { name: "killeros_goal_update", arguments: JSON.stringify({ status: "complete", evidence: item.reply.evidence }) } }] }
          : { content: "The saved history request finished." };
      response.end(`data: ${JSON.stringify({ id: `restore-${requests.length}`, model: "local",
        choices: [{ index: 0, delta, finish_reason: item.reply.kind === "complete" || item.reply.kind === "calls" ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Unexpected goal restoration request"); }
    });
    handlers.add(handling);
    void handling.finally(() => handlers.delete(handling));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const current = (): PiRpcProcess => { assert.ok(rpc); return rpc; };
  const close = async (): Promise<void> => {
    if (!rpc) return;
    const result = await rpc.close();
    exits.push(result);
    assert.deepEqual(result, { exit: { code: 0, signal: null }, forced: false }, rpc.diagnostics());
    lastDiagnostics = rpc.diagnostics();
    rpc = undefined;
  };
  try {
    const manager = SessionManager.create(project, sessions);
    manager.appendMessage({ role: "user", content: "Preserve this saved goal history.", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The previous work is saved." }],
      api: "openai-completions", provider: "saved-goals", model: "local", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    seed(manager);
    file = manager.getSessionFile();
    assert.ok(file);
    const sessionFile = file;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false },
      retry: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "saved-goals": {
      api: "openai-completions", apiKey: "saved-goal-fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "local", name: "Saved goal fixture", reasoning: false, input: ["text"], contextWindow: 128_000,
        maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: temporary, TMP: temporary, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const state = async (): Promise<Json> => record((await current().command("get_state", {}, { signal: t.signal })).data);
    const goals = () => SessionManager.open(sessionFile).getBranch()
      .filter(entry => entry.type === "custom" && entry.customType === "killeros-goal")
      .map(entry => {
        assert.equal(entry.type, "custom");
        assert.ok("data" in entry);
        const data = record(entry.data);
        return { event: data.event, state: record(data.state) };
      });
    const prompt = async (message: string): Promise<number> => {
      const cli = current();
      const after = cli.currentSequence;
      const result = await cli.command("prompt", { message }, { signal: t.signal });
      assert.equal(record(result.data).disposition, message.startsWith("/") ? "handled" : "started");
      return after;
    };
    const notice = async (): Promise<string> => {
      const after = await prompt("/goal");
      const event = await current().waitFor(event => event.type === "extension_ui_request" && event.method === "notify"
        && typeof event.message === "string" && /^(?:Goal |No goal is set)/u.test(event.message), { after, signal: t.signal });
      assert.equal(typeof event.message, "string");
      return String(event.message);
    };
    await run({ file: sessionFile, rpc: current, state, goals, prompt, notice, close,
      enqueue: (reply, held = false) => { const item = plan(reply, held); plans.push(item); return item; },
      launch: async () => {
        assert.equal(rpc, undefined, "A reopen requires the preceding process to exit first");
        launches++;
        rpc = new PiRpcProcess({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd: project, env,
          args: ["--mode", "rpc", "--model", "saved-goals/local", "--thinking", "off", "--session", sessionFile,
            "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
            "--no-extensions", "--extension", root] });
        const started = await state();
        assert.equal(path.resolve(String(started.sessionFile)), path.resolve(sessionFile));
        assert.equal(record(started.model).provider, "saved-goals");
        assert.equal(record(started.model).id, "local");
        const commands = record((await current().command("get_commands", {}, { signal: t.signal })).data).commands;
        assert.ok(records(commands).some(command => command.name === "goal" && command.source === "extension"));
      },
      entries: async () => records(record((await current().command("get_entries", {}, { signal: t.signal })).data).entries),
      continuations: () => SessionManager.open(sessionFile).getBranch()
        .flatMap(entry => {
          if (entry.type !== "custom_message" || entry.customType !== "killeros-goal-continuation") return [];
          assert.ok(typeof entry.content === "string");
          return [entry.content];
        }),
      settled: async after => {
        await current().waitFor(event => event.type === "agent_settled", { after, signal: t.signal });
        const settled = await state();
        assert.equal(settled.isStreaming, false);
        assert.equal(settled.isCompacting, false);
        assert.equal(settled.pendingMessageCount, 0);
        const latest = goals().at(-1);
        snapshots.push({ label, ...latest });
        assert.ok(current().retainedRecordCount < 256);
        current().acknowledge(current().currentSequence);
      },
    });
    assert.deepEqual(faults, []);
  } catch (error) { failure = error; }
  finally {
    for (const item of plans) item.release.release();
    try { await close(); } catch (error) { cleanupFailures.push(error); }
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    catch (error) { cleanupFailures.push(error); }
    await Promise.all(handlers);
    try {
      assert.equal(launches, expected.launches, `${label}: exact fresh process count`);
      assert.equal(requests.length, expected.requests, `${label}: final provider count after orderly exit`);
      assert.equal(plans.length, requests.length, `${label}: every scripted response was exercised`);
      assert.deepEqual(faults, []);
    } catch (error) { cleanupFailures.push(error); }
    if (failure !== undefined || cleanupFailures.length > 0) {
      const reportDirectory = mkdtempSync(path.join(root, "node_modules", ".killeros-goal-restore-failure-"));
      try {
        throwScenarioFailure({ directory: reportDirectory, message: `${scenarioId}/${label} failed`,
          errors: [failure, ...cleanupFailures].filter(error => error !== undefined),
          diagnostics: JSON.stringify({ label, launches, requests: requests.map(body => ({ model: body.model, roles: records(body.messages).map(m => m.role) })),
            faults, snapshots, exits, rpc: rpc?.diagnostics() ?? lastDiagnostics, session: file && existsSync(file) ? readFileSync(file, "utf8").slice(-8_000) : null }) });
      } catch (error) { failure = error; }
    }
    try { await removeDirectoryEventually(directory); }
    catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], "Goal restoration and scratch cleanup failed");
      throw error;
    }
    assert.equal(existsSync(directory), false);
    if (failure !== undefined) throw new AggregateError([failure], `Goal restoration ${label} failed`);
    t.diagnostic(JSON.stringify({ scenarioId, label, launches, providerRequests: requests.length,
      fixtureGitLaunches: 0, directOtherChildLaunches: 0, nestedChildAccounting: "pending", cleanup: "natural; scratch removed" }));
  }
}

// Catalog ID: goals.restore-valid. Each history is an assertion vector, not a nested registration.
test("valid saved goals restore and resume without losing identity", { timeout: 180_000 }, async t => {
  const now = Date.now();
  const active = activeGoal("Finish the saved task", now);
  await history(t, "goals.restore-valid", "active-current-branch", { launches: 1, requests: 1 }, manager => {
    const selected = savedGoal(manager, "turn", { ...active,
      completionCheck: { kind: "named-command", name: "quality", configHash: "a".repeat(64) } });
    savedGoal(manager, "replace", { ...active, objective: "Abandoned branch objective must not resume" });
    manager.branch(selected);
    manager.appendSessionInfo("Current branch retained");
  }, async f => {
    const request = f.enqueue({ kind: "stop" }, true);
    await f.launch();
    await reached(request.started.promise, t.signal, "restored active request");
    const status = await f.notice();
    assert.match(status, /Goal active · 3\/4 turns/u);
    assert.match(status, /Finish the saved task/u);
    assert.doesNotMatch(status, /Check:/u);
    assert.equal(f.continuations().length, 1);
    assert.match(f.continuations()[0] ?? "", /Finish the saved task/u);
    assert.doesNotMatch(JSON.stringify(request.body), /Abandoned branch objective must not resume/u);
    const turn = f.goals().at(-1);
    assert.equal(turn?.event, "turn");
    assert.equal(turn?.state.status, "active");
    assert.equal(turn?.state.turns, 3);
    assert.equal(turn?.state.maxTurns, 4);
    assert.equal(turn?.state.createdAt, active.createdAt);
    request.release.release();
    await f.settled(0);
    assert.equal(f.continuations().length, 1, "No unaccepted second turn is dispatched");
  });

  const oldObjective = "Finish the original saved task";
  const newObjective = "Finish the edited saved task";
  await history(t, "goals.restore-valid", "edited-active", { launches: 1, requests: 1 }, manager => {
    savedGoal(manager, "set", { ...activeGoal(oldObjective, now), revision: 1, updatedAt: now - 50_000 });
    savedGoal(manager, "edit", { ...activeGoal(newObjective, now), revision: 2, blockedAuditStartTurn: 2 });
  }, async f => {
    const request = f.enqueue({ kind: "stop" }, true);
    await f.launch();
    await reached(request.started.promise, t.signal, "edited active request");
    const continuation = f.continuations();
    assert.equal(continuation.length, 1);
    assert.match(continuation[0] ?? "", /Finish the edited saved task/u);
    assert.doesNotMatch(continuation[0] ?? "", /Finish the original saved task/u);
    assert.match(JSON.stringify(request.body), /Finish the edited saved task/u);
    assert.doesNotMatch(JSON.stringify(request.body), /Finish the original saved task/u);
    const restored = f.goals().at(-1);
    assert.equal(restored?.event, "turn");
    assert.equal(restored?.state.status, "active");
    assert.equal(restored?.state.objective, newObjective);
    assert.equal(restored?.state.turns, 3);
    assert.equal(restored?.state.maxTurns, 4);
    assert.equal(restored?.state.createdAt, active.createdAt);
    request.release.release();
    await f.settled(0);
  });

  await history(t, "goals.restore-valid", "pause-reason-clearing", { launches: 1, requests: 4 }, () => {}, async f => {
    f.enqueue({ kind: "stop" });
    await f.launch();
    await f.settled(await f.prompt("/goal Finish after resuming"));
    assert.equal(f.goals().at(-1)?.state.stopReason, "no turn decision");
    const resumed = f.enqueue({ kind: "stop" }, true);
    const after = await f.prompt("/goal resume");
    await reached(resumed.started.promise, t.signal, "resumed request");
    assert.equal(f.goals().at(-1)?.state.stopReason, undefined);
    await f.prompt("/goal pause");
    await reached(resumed.closed.promise, t.signal, "paused request closure");
    assert.equal(f.goals().at(-1)?.state.status, "paused");
    assert.equal(f.goals().at(-1)?.state.stopReason, undefined);
    resumed.release.release();
    await f.settled(after);
    f.enqueue({ kind: "complete", evidence: "Verified after resume" });
    f.enqueue({ kind: "stop" });
    await f.settled(await f.prompt("/goal resume"));
    assert.equal(f.goals().at(-1)?.state.status, "complete");
    assert.equal(f.goals().at(-1)?.state.stopReason, undefined);
  });

  await history(t, "goals.restore-valid", "truncated-provider-error", { launches: 2, requests: 1 }, () => {}, async f => {
    const result = "x".repeat(1_999);
    f.enqueue({ kind: "error", message: result + " provider failure" });
    await f.launch();
    await f.settled(await f.prompt("/goal Keep the goal after a provider failure"));
    const saved = f.goals().at(-1);
    assert.equal(saved?.state.status, "paused");
    assert.equal(saved?.state.result, result);
    assert.equal(saved?.state.stopReason, result);
    const assistant = (await f.entries()).filter(entry => entry.type === "message"
      && record(entry.message).role === "assistant").at(-1);
    assert.equal(record(assistant?.message).stopReason, "error");
    assert.equal(record(assistant?.message).errorMessage, result + " provider failure");
    await f.close();
    await f.launch();
    assert.deepEqual(f.goals().at(-1), saved, "The exact bounded error state survives a fresh process");
    assert.match(await f.notice(), /Goal paused/u);
    const state = await f.state();
    assert.equal(state.isStreaming, false);
    assert.equal(state.isCompacting, false);
    assert.equal(state.pendingMessageCount, 0);
    assert.equal(f.continuations().length, 1);
  });

  await history(t, "goals.restore-valid", "exhausted", { launches: 1, requests: 0 }, manager => {
    savedGoal(manager, "turn", { ...activeGoal("Do not start another turn", now), turns: 2, maxTurns: 2 });
  }, async f => {
    await f.launch();
    assert.match(await f.notice(), /Goal paused/u);
    assert.equal(f.goals().at(-1)?.event, "limit");
    assert.equal(f.goals().at(-1)?.state.status, "paused");
    assert.equal(f.continuations().length, 0);
    assert.equal((await f.state()).pendingMessageCount, 0);
  });

  await history(t, "goals.restore-valid", "legacy-checkpoint", { launches: 1, requests: 0 }, manager => {
    savedGoal(manager, "checkpoint", { version: 1, revision: 3, objective: "Resume the checkpointed task", status: "active",
      createdAt: now - 60_000, updatedAt: now - 10_000, activeMilliseconds: 50_000, turns: 2, baselineTokens: 0 });
  }, async f => {
    await f.launch();
    const status = await f.notice();
    assert.match(status, /Goal paused/u);
    assert.match(status, /no turn decision/u);
    assert.equal(f.goals().at(-1)?.event, "error");
    assert.equal(f.goals().at(-1)?.state.status, "paused");
    assert.equal(f.continuations().length, 0);
    assert.equal((await f.state()).pendingMessageCount, 0);
  });

  const objective = "Verify the installed CLI persists a model-issued goal decision";
  const evidence = "The scripted model completed the goal and the saved entry survived reopening.";
  await history(t, "goals.restore-valid", "completed-reopen", { launches: 2, requests: 2 }, () => {}, async f => {
    const decision = f.enqueue({ kind: "complete", evidence });
    const followup = f.enqueue({ kind: "stop" });
    await f.launch();
    await f.settled(await f.prompt(`/goal ${objective}`));
    assert.ok(records(decision.body?.tools).some(tool => record(tool.function).name === "killeros_goal_update"));
    assert.match(JSON.stringify(decision.body?.messages), /Verify the installed CLI persists a model-issued goal decision/u);
    assert.ok(records(followup.body?.messages).some(message => message.role === "tool"
      && JSON.stringify(message.content).includes("Goal marked complete (model-reported)")));
    const tool = (await f.entries()).filter(entry => entry.type === "message"
      && record(entry.message).role === "toolResult").at(-1);
    assert.equal(record(tool?.message).isError, false);
    const saved = f.goals().at(-1);
    assert.equal(saved?.event, "complete");
    assert.equal(saved?.state.status, "complete");
    assert.equal(saved?.state.objective, objective);
    assert.equal(saved?.state.turns, 1);
    assert.equal(record(saved?.state.lastDecision).kind, "complete");
    await f.close();
    await f.launch();
    assert.deepEqual(f.goals().at(-1), saved);
    const status = await f.notice();
    assert.match(status, /Goal complete/u);
    assert.match(status, /Completion · model-reported/u);
    assert.ok(status.includes(evidence));
    const state = await f.state();
    assert.equal(state.isStreaming, false);
    assert.equal(state.isCompacting, false);
    assert.equal(state.pendingMessageCount, 0);
    assert.equal(f.continuations().length, 1);
  });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.restore-valid", histories: 7, piLaunches: 9, providerRequests: 9,
    fixtureGitLaunches: 0, nestedChildAccounting: "pending" }));
});

// Catalog ID: goals.restore-validation. Report and duration histories have independent selectors below.
// Catalog ID: goals.provider-error.
test("a native provider failure saves a sanitized paused goal and one error notification", { timeout: 30_000 }, async t => {
  await history(t, "goals.provider-error", "sanitized-provider-error", { launches: 1, requests: 1 }, () => {}, async f => {
    const raw = "\x1b]2;owned\x07\x1b[31mprovider\x1b[0m\0 unavailable";
    f.enqueue({ kind: "error", message: raw });
    await f.launch();
    const cursor = await f.prompt("/goal Recover the deployment");
    const notifications: Json[] = [];
    await f.rpc().waitFor(event => {
      if (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error") {
        notifications.push({ message: event.message, type: event.notifyType });
      }
      return event.type === "agent_settled";
    }, { after: cursor, signal: t.signal });
    assert.deepEqual(notifications, [{
      message: "Goal paused: provider unavailable\nRun /goal resume after resolving the problem.", type: "error",
    }]);
    await f.settled(cursor);
    const saved = f.goals().at(-1);
    assert.equal(saved?.event, "error");
    assert.equal(saved?.state.status, "paused");
    assert.equal(saved?.state.result, "provider unavailable");
    assert.equal(saved?.state.stopReason, "provider unavailable");
    assert.equal(f.continuations().length, 1);
    const assistant = (await f.entries()).filter(entry => entry.type === "message"
      && record(entry.message).role === "assistant").at(-1);
    assert.equal(record(assistant?.message).stopReason, "error");
    assert.equal(record(assistant?.message).errorMessage, raw);
  });
});

test("malformed saved goals and unsafe reports fail closed before dispatch", { timeout: 180_000 }, async t => {
  const now = Date.now();
  const common = { version: 1, revision: 1, objective: "Reject contradictory state", createdAt: now, updatedAt: now,
    activeMilliseconds: 0, turns: 1, blockedAuditStartTurn: 0, baselineTokens: 0 };
  const counters = { ...common, objective: "Reject unsafe counters", status: "active", activeStartedAt: now };
  const legacy = { ...counters, objective: "Continue old natural-language goal", turns: 0 };
  const absolute = "C:\\out.md";
  const check = { kind: "named-command", name: "quality", configHash: "a".repeat(64) };
  const vectors: Array<{ label: string; state: Json; valid: boolean }> = [
    ...[
      { ...common, status: "active", activeStartedAt: -1 },
      { ...common, status: "active", activeStartedAt: now, stopReason: "stale pause" },
      { ...common, status: "paused", activeStartedAt: now },
      { ...common, status: "paused", stopReason: "" },
      { ...common, status: "blocked", activeStartedAt: now, result: "blocked" },
      { ...common, status: "complete", result: "done", blockerAudit: { key: "blocked", streak: 1, lastTurn: 1 } },
      { ...common, status: "complete", result: "done", stopReason: "stale pause" },
    ].map((state, index) => ({ label: `contradiction-${index + 1}`, state, valid: false })),
    { label: "unsafe-revision", state: { ...counters, revision: Number.MAX_SAFE_INTEGER }, valid: false },
    { label: "unsafe-turns", state: { ...counters, turns: Number.MAX_SAFE_INTEGER }, valid: false },
    { label: "unsafe-duration", state: { ...counters, activeMilliseconds: Number.MAX_VALUE }, valid: false },
    { label: "old-natural-language", state: legacy, valid: true },
    { label: "absolute-baseline", state: { ...legacy, verification: { kind: "file", path: absolute,
      baseline: { exists: true, size: 0, mtimeMs: 0 } } }, valid: true },
    { label: "relative-baseline", state: { ...legacy, verification: { kind: "file", path: "relative.md", baseline: { exists: false } } }, valid: false },
    { label: "missing-baseline", state: { ...legacy, verification: { kind: "file", path: absolute } }, valid: false },
    { label: "unknown-verification", state: { ...legacy, verification: { kind: "url", path: absolute, baseline: { exists: false } } }, valid: false },
    { label: "legacy-check", state: { ...legacy, completionCheck: check, maxTurns: 3 }, valid: true },
    { label: "legacy-noncanonical-name", state: { ...legacy, completionCheck: { ...check, name: "Bad" } }, valid: true },
    { label: "legacy-noncanonical-hash", state: { ...legacy, completionCheck: { ...check, configHash: "ABC" } }, valid: true },
    { label: "zero-turn-limit", state: { ...legacy, maxTurns: 0 }, valid: false },
    { label: "oversized-turn-limit", state: { ...legacy, maxTurns: 10_001 }, valid: false },
  ];
  assert.equal(vectors.length, 20, "Persisted report vectors are independently selectable in goals.report-validation");
  assert.equal(vectors.filter(vector => vector.valid).length, 5);
  for (const vector of vectors) {
    const probeRejectedGoal = vector.label.startsWith("contradiction-")
      || ["unsafe-revision", "unsafe-turns", "unsafe-duration"].includes(vector.label);
    await history(t, "goals.restore-validation", vector.label, { launches: 1, requests: vector.valid || probeRejectedGoal ? 1 : 0 }, manager => {
      savedGoal(manager, "checkpoint", vector.state);
    }, async f => {
      const request = vector.valid ? f.enqueue({ kind: "stop" }, true) : undefined;
      await f.launch();
      if (request) {
        await reached(request.started.promise, t.signal, `${vector.label} restored request`);
        assert.match(await f.notice(), /Goal active/u, vector.label);
        assert.equal(f.continuations().length, 1, vector.label);
        assert.equal(f.goals().at(-1)?.state.objective, vector.state.objective);
        if (vector.label.startsWith("legacy-")) assert.doesNotMatch(await f.notice(), /Check:/u);
        if (vector.label === "absolute-baseline") assert.deepEqual(f.goals().at(-1)?.state.verification, vector.state.verification);
        request.release.release();
        await f.settled(0);
      } else {
        assert.match(await f.notice(), /No goal is set/u, vector.label);
        assert.equal(f.continuations().length, 0, vector.label);
        assert.deepEqual(f.goals(), [{ event: "checkpoint", state: vector.state }], "Rejected state must not be rewritten as accepted state");
        const state = await f.state();
        assert.equal(state.isStreaming, false);
        assert.equal(state.isCompacting, false);
        assert.equal(state.pendingMessageCount, 0);
        if (probeRejectedGoal) {
          const probe = f.enqueue({ kind: "stop" }, true);
          const after = await f.prompt("Inspect this session after rejecting the malformed saved goal");
          await reached(probe.started.promise, t.signal, `${vector.label} ordinary request`);
          assert.ok(!records(probe.body?.tools).some(tool => record(tool.function).name === "killeros_goal_update"),
            `${vector.label}: rejected saved state must not authorize the goal tool on ordinary work`);
          probe.release.release();
          await f.settled(after);
          assert.deepEqual(f.goals(), [{ event: "checkpoint", state: vector.state }],
            `${vector.label}: ordinary work must preserve the rejected checkpoint`);
          assert.equal(f.continuations().length, 0, vector.label);
        }
      }
    });
  }

  t.diagnostic(JSON.stringify({ scenarioId: "goals.restore-validation", validationVectors: 20,
    piLaunches: 20, providerRequests: 15, fixtureGitLaunches: 0, nestedChildAccounting: "pending" }));
});

// Catalog ID: goals.report-validation. Preserve the original epoch-zero report inputs.
test("persisted goal reports authorize only valid bounded decisions", { timeout: 60_000 }, async t => {
  const base = { version: 1, revision: 3, objective: "Bounded report", status: "active",
    createdAt: 0, updatedAt: 0, activeMilliseconds: 0, activeStartedAt: 0, turns: 1,
    blockedAuditStartTurn: 0, baselineTokens: 0, turnPhase: "authorized",
    turnDecision: { kind: "continue", turn: 1, evidence: "evidence", nextAction: "next" } };
  for (const vector of [
    { label: "valid-report", state: base, valid: true },
    { label: "oversized-evidence", state: { ...base, turnDecision: { ...base.turnDecision, evidence: "x".repeat(2_001) } }, valid: false },
    { label: "unsafe-next-action", state: { ...base, turnDecision: { ...base.turnDecision, nextAction: "\x1b[31mnext" } }, valid: false },
    { label: "stale-report", state: { ...base, turns: 2 }, valid: false },
  ]) {
    await history(t, "goals.report-validation", vector.label, { launches: 1, requests: vector.valid ? 1 : 0 }, manager => {
      savedGoal(manager, "checkpoint", vector.state);
    }, async f => {
      const request = vector.valid ? f.enqueue({ kind: "stop" }, true) : undefined;
      await f.launch();
      if (request) {
        await reached(request.started.promise, t.signal, "valid saved report request");
        assert.equal(f.goals().at(-1)?.state.turns, 2);
        assert.match(await f.notice(), /Goal active/u);
        assert.equal(f.continuations().length, 1);
        request.release.release();
        await f.settled(0);
      } else {
        assert.match(await f.notice(), /No goal is set/u, vector.label);
        assert.equal(f.continuations().length, 0);
        assert.deepEqual(f.goals(), [{ event: "checkpoint", state: vector.state }]);
        const idle = await f.state();
        assert.equal(idle.isStreaming, false);
        assert.equal(idle.isCompacting, false);
        assert.equal(idle.pendingMessageCount, 0);
      }
    });
  }
  t.diagnostic(JSON.stringify({ scenarioId: "goals.report-validation", histories: 4,
    piLaunches: 4, providerRequests: 1, fixtureGitLaunches: 0, nestedChildAccounting: "pending" }));
});

// Catalog ID: goals.duration-overflow. Keep arithmetic qualification independently selectable.
test("goal status and pause reject unsafe duration arithmetic without a rounded write", { timeout: 60_000 }, async t => {
  const now = Date.now();
  for (const operation of ["status", "pause"]) {
    await history(t, "goals.duration-overflow", `duration-overflow-${operation}`, { launches: 1, requests: 1 }, manager => {
      savedGoal(manager, "set", { ...activeGoal("Reject unsafe duration arithmetic", now), turns: 0,
        activeMilliseconds: Number.MAX_SAFE_INTEGER - 1 });
    }, async f => {
      const request = f.enqueue({ kind: "stop" }, true);
      await f.launch();
      await reached(request.started.promise, t.signal, "near-limit active request");
      const before = f.goals();
      const started = before.at(-1)?.state.activeStartedAt;
      assert.ok(typeof started === "number");
      // Elapsed time is the tested input. Acknowledged native commands advance it without sleep-based event ordering.
      const deadline = Date.now() + 5_000;
      while (Date.now() - started < 4 && Date.now() < deadline) await f.state();
      assert.ok(Date.now() - started >= 4, "The native clock has exceeded the remaining safe duration");
      const failedAfter = f.rpc().currentSequence;
      await f.prompt(operation === "status" ? "/goal" : "/goal pause");
      const diagnostic = await f.rpc().waitFor(event => event.type === "extension_error" && event.extensionPath === "command:goal"
        && event.event === "command" && typeof event.error === "string" && /safe integer range/iu.test(event.error),
      { after: failedAfter, signal: t.signal });
      assert.equal(diagnostic.error, "Goal active duration exceeds the safe integer range");
      assert.deepEqual(f.goals(), before, "Overflow must not create a rounded successful goal write");
      const after = f.rpc().currentSequence;
      await f.prompt("/goal clear");
      await reached(request.closed.promise, t.signal, "overflow-control request cancellation");
      await f.rpc().waitFor(event => event.type === "agent_settled", { after, signal: t.signal });
      assert.equal((await f.state()).pendingMessageCount, 0);
      const data = SessionManager.open(f.file).getBranch()
        .filter(entry => entry.type === "custom" && entry.customType === "killeros-goal")
        .map(entry => { assert.ok("data" in entry); return record(entry.data); });
      assert.equal(data.at(-1)?.event, "clear");
      assert.equal(data.at(-1)?.state, null);
      for (const entry of data) if (entry.state !== null) {
        const duration = record(entry.state).activeMilliseconds;
        assert.ok(typeof duration === "number" && Number.isSafeInteger(duration));
        assert.equal(duration, Number.MAX_SAFE_INTEGER - 1);
      }
    });
  }
  t.diagnostic(JSON.stringify({ scenarioId: "goals.duration-overflow", durationControls: 2,
    piLaunches: 2, providerRequests: 2, fixtureGitLaunches: 0, nestedChildAccounting: "pending" }));
});

function toolResult(entries: Json[], id: string): Json {
  const result = entries.filter(entry => entry.type === "message").map(entry => record(entry.message))
    .find(message => message.role === "toolResult" && message.toolCallId === id);
  assert.ok(result, `Missing persisted tool result ${id}`);
  return result;
}
function blocked(blockerKey: string | undefined, evidence = "Repeated evidence"): Json {
  return { status: "blocked", evidence, ...(blockerKey === undefined ? {} : { blockerKey }) };
}

function toolContentText(result: Json): string {
  return records(result.content).map(part => {
    assert.equal(part.type, "text");
    assert.ok(typeof part.text === "string");
    return part.text;
  }).join("\n");
}

// Catalog ID: goals.blockers. One registration owns the live sequences and isolated historical inputs.
test("blocker audits require three consecutive matching turns", { timeout: 180_000 }, async t => {
  await history(t, "goals.blockers", "validation-and-three-turns", { launches: 2, requests: 9 }, () => {}, async f => {
    await f.launch();
    const tooLong = await f.prompt(`/goal ${"x".repeat(4_001)}`);
    await f.rpc().waitFor(event => event.type === "extension_ui_request" && event.method === "notify"
      && typeof event.message === "string" && /4,000 characters/u.test(event.message), { after: tooLong, signal: t.signal });
    await f.prompt("/goal CLEAR");
    assert.match(await f.notice(), /No goal is set/u);
    assert.deepEqual(f.goals(), []);

    // Public model traffic cannot execute a tool that an inactive goal has removed from the loadout.
    const outside = f.enqueue({ kind: "calls", decisions: [blocked("missing-credential")] });
    f.enqueue({ kind: "stop" });
    await f.settled(await f.prompt("Probe the goal tool without starting a goal."));
    assert.ok(!records(outside.body?.tools).some(tool => record(tool.function).name === "killeros_goal_update"));
    const rejected = toolResult(await f.entries(), "audit-1-0");
    assert.equal(rejected.isError, true);
    assert.match(JSON.stringify(rejected.content), /not found|not available|no active|unknown tool/iu);
    assert.deepEqual(f.goals(), []);

    // Per-vector truth: an omitted key reaches the handler and carries the exact production
    // label; schema-rejected keys return the native tool-schema constraint text instead,
    // so each vector asserts its own constraint line.
    const invalidKeys: Array<{ key: string | undefined; expect: RegExp }> = [
      { key: undefined, expect: /A blocked goal update requires a stable lowercase blockerKey/u },
      { key: "", expect: /blockerKey: must not have fewer than 1 characters/u },
      { key: "UPPERCASE", expect: /blockerKey: must match pattern "\^\[a-z0-9\]\[a-z0-9._-\]\{0,119\}\$"/u },
      { key: "contains whitespace", expect: /blockerKey: must match pattern "\^\[a-z0-9\]\[a-z0-9._-\]\{0,119\}\$"/u },
      { key: `x${"y".repeat(120)}`, expect: /blockerKey: must not have more than 120 characters/u },
    ];
    f.enqueue({ kind: "calls", decisions: [...invalidKeys.map(vector => blocked(vector.key, "Still blocked")),
      blocked("missing-credential", "Evidence for missing-credential"), blocked("missing-credential", "Evidence for missing-credential")] });
    const first = f.enqueue({ kind: "stop" }, true);
    f.enqueue({ kind: "calls", decisions: [blocked("missing-credential", "Evidence for missing-credential")] });
    const second = f.enqueue({ kind: "stop" }, true);
    f.enqueue({ kind: "calls", decisions: [blocked("missing-credential", "Evidence for missing-credential")] });
    const third = f.enqueue({ kind: "stop" }, true);
    await f.prompt("/goal Resolve one stable blocker");
    await reached(first.started.promise, t.signal, "first blocker followup");
    const results = await f.entries();
    for (const [index, vector] of invalidKeys.entries()) {
      const result = toolResult(results, `audit-3-${index}`);
      assert.equal(result.isError, true, `Invalid blocker key ${index}`);
      const content = toolContentText(result);
      assert.match(content, vector.expect, `Invalid blocker key ${index}`);
      if (vector.key !== undefined) {
        assert.doesNotMatch(content, /stable lowercase blockerKey/u, `Schema rejection ${index} must not carry the handler label`);
      }
    }
    assert.equal(toolResult(results, "audit-3-5").isError, false);
    assert.equal(record(toolResult(results, "audit-3-5").details).status, "blocker-audit");
    assert.equal(record(toolResult(results, "audit-3-5").details).streak, 1);
    const duplicate = toolResult(results, "audit-3-6");
    assert.equal(duplicate.isError, true);
    assert.match(JSON.stringify(duplicate.content), /Only one goal decision may be accepted per logical goal turn/u);
    assert.equal(f.goals().at(-1)?.state.turnPhase, "authorized");
    assert.equal(f.goals().at(-1)?.state.status, "active");
    assert.equal(f.goals().at(-1)?.state.turns, 1);
    first.release.release();
    await reached(second.started.promise, t.signal, "second blocker followup");
    assert.equal(record(toolResult(await f.entries(), "audit-5-0").details).streak, 2);
    assert.equal(f.goals().at(-1)?.state.status, "active");
    assert.equal(f.goals().at(-1)?.state.turns, 2);
    second.release.release();
    await reached(third.started.promise, t.signal, "third blocker followup");
    const thirdResult = record(toolResult(await f.entries(), "audit-7-0").details);
    assert.equal(thirdResult.status, "blocked");
    assert.equal(thirdResult.streak, 3);
    assert.equal(f.goals().at(-1)?.state.status, "blocked");
    assert.deepEqual(f.goals().at(-1)?.state.blockerAudit,
      { key: "missing-credential", streak: 3, lastTurn: 3, evidence: "Evidence for missing-credential" });
    const finish = f.rpc().currentSequence;
    third.release.release();
    await f.settled(finish);
    assert.equal(f.continuations().length, 3);

    const resumed = f.enqueue({ kind: "stop" }, true);
    await f.prompt("/goal resume");
    await reached(resumed.started.promise, t.signal, "resumed fourth turn");
    assert.equal(f.goals().at(-1)?.state.turns, 4);
    assert.equal(f.goals().at(-1)?.state.blockerAudit, undefined);
    const paused = f.rpc().currentSequence;
    await f.prompt("/goal pause");
    await reached(resumed.closed.promise, t.signal, "resumed request cancellation");
    await f.settled(paused);
    await f.close();
    await f.launch();
    assert.match(await f.notice(), /Goal paused · 4\/20 turns/u);
    assert.equal(f.continuations().length, 4);
    assert.equal((await f.state()).isStreaming, false);
  });

  await history(t, "goals.blockers", "changed-skipped-and-cleared", { launches: 1, requests: 12 }, () => {}, async f => {
    const decisions = [blocked("first-blocker"), blocked("changed-blocker"),
      { status: "continue", evidence: "The blocker was not observed this turn", nextAction: "Retry the blocked operation" },
      blocked("changed-blocker")];
    const followups = decisions.map(decision => {
      f.enqueue({ kind: "calls", decisions: [decision] });
      return f.enqueue({ kind: "stop" }, true);
    });
    await f.launch();
    await f.prompt("/goal Audit blocker resets");
    for (const [index, followup] of followups.entries()) {
      await reached(followup.started.promise, t.signal, `reset turn ${index + 1}`);
      const result = toolResult(await f.entries(), `audit-${index * 2 + 1}-0`);
      assert.equal(result.isError, false);
      assert.equal(f.goals().at(-1)?.state.turns, index + 1);
      assert.equal(f.goals().at(-1)?.state.status, "active");
      if (index === 2) assert.equal(record(result.details).status, "continue");
      else {
        assert.equal(record(result.details).status, "blocker-audit");
        assert.equal(record(result.details).streak, 1, "Changed key or skipped turn must reset the streak");
        assert.equal(record(f.goals().at(-1)?.state.blockerAudit).lastTurn, index + 1);
      }
      if (index < 3) followup.release.release();
    }
    const beforePause = f.rpc().currentSequence;
    await f.prompt("/goal pause");
    await f.settled(beforePause);
    assert.equal(record(f.goals().at(-1)?.state.blockerAudit).streak, 1);
    const resumed = f.enqueue({ kind: "calls", decisions: [blocked("changed-blocker")] }, true);
    const fifth = f.enqueue({ kind: "stop" }, true);
    f.enqueue({ kind: "complete", evidence: "Verified complete after resetting audit progress" });
    const sixth = f.enqueue({ kind: "stop" }, true);
    await f.prompt("/goal resume");
    await reached(resumed.started.promise, t.signal, "resume after one audit");
    assert.equal(f.goals().at(-1)?.state.turns, 5);
    assert.equal(f.goals().at(-1)?.state.blockerAudit, undefined);
    resumed.release.release();
    await reached(fifth.started.promise, t.signal, "new audit after resume");
    assert.deepEqual(f.goals().at(-1)?.state.blockerAudit,
      { key: "changed-blocker", streak: 1, lastTurn: 5, evidence: "Repeated evidence" });
    fifth.release.release();
    await reached(sixth.started.promise, t.signal, "completion after audit");
    assert.equal(f.goals().at(-1)?.state.status, "complete");
    assert.equal(f.goals().at(-1)?.state.turns, 6);
    assert.equal(f.goals().at(-1)?.state.blockerAudit, undefined);
    const finish = f.rpc().currentSequence;
    sixth.release.release();
    await f.settled(finish);
    assert.equal(f.continuations().length, 6);
  });

  const base = activeGoal("Restore the blocker audit", Date.now());
  const valid = { key: "missing-credential", streak: 2, lastTurn: 2, evidence: "Credential is still unavailable" };
  await history(t, "goals.blockers", "valid-audit-restore", { launches: 1, requests: 2 }, manager => {
    savedGoal(manager, "blocker-audit", { ...base, blockerAudit: valid });
  }, async f => {
    const decision = f.enqueue({ kind: "calls", decisions: [blocked(valid.key, "Still unavailable")] }, true);
    f.enqueue({ kind: "stop" });
    await f.launch();
    await reached(decision.started.promise, t.signal, "restored third audit turn");
    assert.equal(f.continuations().length, 1);
    assert.deepEqual(f.goals().at(-1)?.state.blockerAudit, valid);
    const finish = f.rpc().currentSequence;
    decision.release.release();
    await f.settled(finish);
    assert.equal(f.goals().at(-1)?.state.status, "blocked");
    assert.equal(record(toolResult(await f.entries(), "audit-1-0").details).streak, 3);
    assert.deepEqual(f.goals().at(-1)?.state.blockerAudit,
      { key: valid.key, streak: 3, lastTurn: 3, evidence: "Still unavailable" });
  });

  const unicode = "\u{10400}".repeat(1_000) + "e\u0301".repeat(1_000);
  await history(t, "goals.blockers", "unicode-audit-roundtrip", { launches: 2, requests: 3 }, manager => {
    savedGoal(manager, "blocker-audit", { ...base, blockerAudit: { key: "external", streak: 1, lastTurn: 1, evidence: unicode } });
  }, async f => {
    const decision = f.enqueue({ kind: "calls", decisions: [blocked("external", unicode)] }, true);
    const followup = f.enqueue({ kind: "stop" }, true);
    await f.launch();
    await reached(decision.started.promise, t.signal, "Unicode saved audit");
    assert.equal(record(f.goals().at(-1)?.state.blockerAudit).evidence, unicode);
    assert.equal(f.continuations().length, 1);
    const tool = records(decision.body?.tools).find(tool => record(tool.function).name === "killeros_goal_update");
    const properties = record(record(record(tool?.function).parameters).properties);
    assert.equal(record(properties.evidence).maxLength, 2_000);
    decision.release.release();
    await reached(followup.started.promise, t.signal, "Unicode tool decision");
    assert.equal(toolResult(await f.entries(), "audit-1-0").isError, false);
    const produced = record(f.goals().at(-1)?.state.blockerAudit);
    assert.deepEqual(produced, { key: "external", streak: 1, lastTurn: 3, evidence: unicode });
    const paused = f.rpc().currentSequence;
    await f.prompt("/goal pause");
    await f.settled(paused);
    await f.close();
    // Seed the next historical input only after exit, using the audit actually produced by the native tool.
    savedGoal(SessionManager.open(f.file), "blocker-audit", { ...base, turns: 3, blockerAudit: produced });
    const reopened = f.enqueue({ kind: "stop" }, true);
    await f.launch();
    await reached(reopened.started.promise, t.signal, "Unicode audit reopened");
    assert.equal(f.continuations().length, 2);
    assert.deepEqual(f.goals().at(-1)?.state.blockerAudit, produced);
    const finish = f.rpc().currentSequence;
    reopened.release.release();
    await f.settled(finish);
    assert.deepEqual(f.goals().at(-1)?.state.blockerAudit, produced);
  });

  t.diagnostic(JSON.stringify({ scenarioId: "goals.blockers", histories: 4, piLaunches: 6, providerRequests: 26,
    fixtureGitLaunches: 0, nestedChildAccounting: "pending" }));
});

// Catalog ID: goals.blocker-corruption. Historical corruption can run independently of live audits.
test("malformed saved blocker audits fail closed without dispatch", { timeout: 60_000 }, async t => {
  const base = activeGoal("Restore the blocker audit", Date.now());
  const unicode = "\u{10400}".repeat(1_000) + "e\u0301".repeat(1_000);
  const malformed = [
    { key: "", streak: 1, lastTurn: 1 }, { key: "UPPERCASE", streak: 1, lastTurn: 1 },
    { key: "valid", streak: 0, lastTurn: 1 }, { key: "valid", streak: 4, lastTurn: 1 },
    { key: "valid", streak: 1.5, lastTurn: 1 }, { key: "valid", streak: 1, lastTurn: -1 },
    { key: "valid", streak: 1, lastTurn: 0 }, { key: "valid", streak: 1, lastTurn: 3 },
    { key: "valid", streak: 1, lastTurn: 1, evidence: "" }, { key: "valid", streak: 1, lastTurn: 1, evidence: " padded" },
    { key: "valid", streak: 1, lastTurn: 1, evidence: "x".repeat(2_001) },
    { key: "valid", streak: 1, lastTurn: 1, evidence: unicode + "x" },
  ];
  assert.equal(malformed.length, 12);
  for (const [index, blockerAudit] of malformed.entries()) {
    const state = { ...base, blockerAudit };
    await history(t, "goals.blocker-corruption", `malformed-audit-${index + 1}`, { launches: 1, requests: 0 }, manager => {
      savedGoal(manager, "blocker-audit", state);
    }, async f => {
      await f.launch();
      assert.match(await f.notice(), /No goal is set/u);
      assert.equal(f.continuations().length, 0);
      assert.deepEqual(f.goals(), [{ event: "blocker-audit", state }]);
      const idle = await f.state();
      assert.equal(idle.isStreaming, false);
      assert.equal(idle.isCompacting, false);
      assert.equal(idle.pendingMessageCount, 0);
    });
  }
  t.diagnostic(JSON.stringify({ scenarioId: "goals.blocker-corruption", histories: 12, piLaunches: 12, providerRequests: 0,
    malformedAudits: 12, fixtureGitLaunches: 0, nestedChildAccounting: "pending" }));
});

type GoalScenarioPlan = ProviderPlan & { beforeReply?: (body: Json) => void };

const goalObserverSource = String.raw`import fs from "node:fs";
const observer = process.env.KILLEROS_GOAL_OBSERVER;
export default function(pi) {
  pi.on("agent_settled", (event, ctx) => fs.appendFileSync(observer, JSON.stringify({
    type: "agent_settled", aborted: event.aborted === true, idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(), mode: ctx.mode, pid: process.pid,
  }) + "\n", "utf8"));
}`;

const goalAppendFaultSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const sessionFile = process.env.KILLEROS_GOAL_FAULT_SESSION ?? "";
const control = process.env.KILLEROS_GOAL_FAULT_DIR ?? "";
const message = JSON.parse(process.env.KILLEROS_GOAL_FAULT_MESSAGE_JSON ?? '"session write failed"');
const originalAppend = fs.appendFileSync.bind(fs);
let failed = false;
let forwarded = 0;
fs.appendFileSync = function(file, data, ...args) {
  const owned = typeof file === "string"
    && path.resolve(file).toLowerCase() === path.resolve(sessionFile).toLowerCase();
  let deny = false;
  let repeat = false;
  try {
    const plan = JSON.parse(fs.readFileSync(path.join(control, "plan.json"), "utf8"));
    deny = plan.deny === true;
    repeat = plan.repeat === true;
  }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if ((!failed || repeat) && deny && owned && String(data).includes('"customType":"killeros-goal"')) {
    failed = true;
    fs.writeFileSync(path.join(control, "attempt.json"), JSON.stringify({
      pid: process.pid, operation: "appendFileSync", path: file,
    }), "utf8");
    throw new Error(message);
  }
  if (!owned) forwarded += 1;
  return originalAppend(file, data, ...args);
};
syncBuiltinESMExports();
export default function(pi) {
  pi.on("session_start", () => fs.appendFileSync(path.join(control, "forwarded.log"), "forwarded\n", "utf8"));
  pi.on("session_shutdown", () => {
    fs.appendFileSync = originalAppend;
    syncBuiltinESMExports();
    fs.writeFileSync(path.join(control, "restored.json"), JSON.stringify({ pid: process.pid, forwarded }), "utf8");
  });
}`;

type GoalScenarioFixture = {
  directory: string;
  project: string;
  agent: string;
  sessions: string;
  temporary: string;
  observerFile: string;
  observerExtension: string;
  sessionFile: string | undefined;
  faultPlanFile: string | undefined;
  faultAttemptFile: string | undefined;
  faultExtension: string | undefined;
  env: NodeJS.ProcessEnv;
  provider: GoalScenarioProvider;
  rpc: PiRpcProcess | undefined;
  terminal: PiTerminalProcess | undefined;
  piLaunches: number;
  naturalExits: number;
};

type GoalScenarioOptions = {
  session?: { goal?: { state: Json; event: string } };
  faultMessage?: string;
};

class GoalScenarioProvider {
  readonly requests: Json[] = [];
  readonly faults: string[] = [];
  private readonly plans: GoalScenarioPlan[] = [];
  private readonly handlers = new Set<Promise<void>>();
  private readonly server = createServer((request, response) => {
    const handling = this.handle(request, response);
    this.handlers.add(handling);
    void handling.finally(() => this.handlers.delete(handling));
  });
  private baseUrl: string | undefined;

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The goal scenario provider did not receive a TCP address"));
          return;
        }
        this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  get url(): string {
    assert.ok(this.baseUrl);
    return this.baseUrl;
  }

  enqueue(reply: Reply, options: { held?: boolean; beforeReply?: (body: Json) => void } = {}): GoalScenarioPlan {
    const item: GoalScenarioPlan = { ...plan(reply, options.held),
      ...(options.beforeReply === undefined ? {} : { beforeReply: options.beforeReply }) };
    this.plans.push(item);
    return item;
  }

  async handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer goal-scenario-key");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576, "Goal provider request must stay bounded");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert.equal(body.model, "local");
      const item = this.plans[this.requests.length];
      this.requests.push(body);
      assert.ok(item, "No provider response was authorized for this request");
      item.body = body;
      response.once("close", () => item.closed.release());
      item.started.release();
      await Promise.race([item.release.promise, item.closed.promise]);
      if (response.destroyed) return;
      item.beforeReply?.(body);
      const delta = item.reply.kind === "calls"
        ? { tool_calls: item.reply.decisions.map((decision, index) => ({ index, id: `audit-${this.requests.length}-${index}`,
          type: "function", function: { name: "killeros_goal_update", arguments: JSON.stringify(decision) } })) }
        : item.reply.kind === "complete"
          ? { tool_calls: [{ index: 0, id: `goal-complete-${this.requests.length}`, type: "function",
            function: { name: "killeros_goal_update", arguments: JSON.stringify({ status: "complete", evidence: item.reply.evidence }) } }] }
          : item.reply.kind === "error"
            ? undefined
            : { content: "The goal scenario request finished." };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      if (item.reply.kind === "error") {
        response.end(`data: ${JSON.stringify({ error: { message: item.reply.message, type: "fixture_error" } })}\n\n`);
        return;
      }
      response.end(`data: ${JSON.stringify({ id: `goal-scenario-${this.requests.length}`, model: "local",
        choices: [{ index: 0, delta, finish_reason: item.reply.kind === "complete" || item.reply.kind === "calls" ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      this.faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) {
        response.writeHead(500, { connection: "close" });
        response.end("Unexpected goal scenario request");
      }
    }
  }

  releaseAll(): void {
    for (const item of this.plans) item.release.release();
  }

  async close(): Promise<void> {
    this.releaseAll();
    this.server.closeAllConnections();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
    }
    await Promise.all(this.handlers);
    assert.deepEqual(this.faults, []);
    assert.equal(this.requests.length, this.plans.length, "Every planned provider response must be exercised");
  }
}

function goalScenarioEnvironment(directory: string, temporary: string, agent: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    TEMP: temporary,
    TMP: temporary,
    PATH: path.dirname(process.execPath),
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function seedGoalScenarioSession(project: string, sessions: string, goal?: { state: Json; event: string }): string {
  const manager = SessionManager.create(project, sessions);
  manager.appendMessage({ role: "user", content: "The previous work is saved.", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The previous work is saved." }],
    api: "openai-completions", provider: "goal-scenario", model: "local", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  if (goal) savedGoal(manager, goal.event, goal.state);
  const file = manager.getSessionFile();
  assert.ok(file, "A saved goal scenario needs a native session file");
  return file;
}

async function createGoalScenarioFixture(label: string, options: GoalScenarioOptions = {}): Promise<GoalScenarioFixture> {
  const directory = await createIsolatedGoalDirectory(`.killeros-goal-scenario-${label}-`);
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  for (const child of [project, agent, sessions, temporary]) mkdirSync(child);
  const provider = new GoalScenarioProvider();
  await provider.listen();
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false },
    retry: { enabled: false }, defaultThinkingLevel: "off" }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "goal-scenario": {
    api: "openai-completions", apiKey: "goal-scenario-key", baseUrl: provider.url,
    models: [{ id: "local", name: "Goal scenario fixture", reasoning: false, input: ["text"], contextWindow: 128_000,
      maxTokens: 4_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const observerFile = path.join(directory, "observer.jsonl");
  const observerExtension = path.join(directory, "observer.ts");
  writeFileSync(observerExtension, goalObserverSource);
  const sessionFile = options.session === undefined
    ? undefined
    : seedGoalScenarioSession(project, sessions, options.session.goal);
  const env = goalScenarioEnvironment(directory, temporary, agent);
  env.KILLEROS_GOAL_OBSERVER = observerFile;
  let faultPlanFile: string | undefined;
  let faultAttemptFile: string | undefined;
  let faultExtension: string | undefined;
  if (options.faultMessage !== undefined) {
    const control = path.join(directory, "fault");
    mkdirSync(control);
    faultPlanFile = path.join(control, "plan.json");
    faultAttemptFile = path.join(control, "attempt.json");
    faultExtension = path.join(directory, "append-fault.ts");
    writeFileSync(faultPlanFile, JSON.stringify({ deny: false }));
    writeFileSync(faultExtension, goalAppendFaultSource);
    env.KILLEROS_GOAL_FAULT_SESSION = sessionFile ?? "";
    env.KILLEROS_GOAL_FAULT_DIR = control;
    env.KILLEROS_GOAL_FAULT_MESSAGE_JSON = JSON.stringify(options.faultMessage);
  }
  return { directory, project, agent, sessions, temporary, observerFile, observerExtension, sessionFile,
    faultPlanFile, faultAttemptFile, faultExtension, env, provider, rpc: undefined, terminal: undefined,
    piLaunches: 0, naturalExits: 0 };
}

function goalScenarioExtensions(fixture: GoalScenarioFixture): string[] {
  return ["--no-extensions", "--extension", root, "--extension", fixture.observerExtension,
    ...(fixture.faultExtension === undefined ? [] : ["--extension", fixture.faultExtension])];
}

function goalScenarioSessionArgs(fixture: GoalScenarioFixture): string[] {
  return fixture.sessionFile === undefined ? ["--no-session"] : ["--session", fixture.sessionFile];
}

function goalScenarioArgs(fixture: GoalScenarioFixture): string[] {
  return ["--model", "goal-scenario/local", "--thinking", "off", "--offline", "--approve",
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
    ...goalScenarioSessionArgs(fixture), ...goalScenarioExtensions(fixture)];
}

function scenarioRpc(fixture: GoalScenarioFixture): PiRpcProcess {
  assert.ok(fixture.rpc, "The RPC process must be running");
  return fixture.rpc;
}

function scenarioProcessId(fixture: GoalScenarioFixture): number {
  const diagnostics = record(JSON.parse(scenarioRpc(fixture).diagnostics()));
  assert.ok(typeof diagnostics.pid === "number");
  return diagnostics.pid;
}

async function launchGoalScenarioRpc(fixture: GoalScenarioFixture, signal: AbortSignal): Promise<PiRpcProcess> {
  assert.equal(fixture.rpc, undefined);
  fixture.piLaunches++;
  fixture.rpc = new PiRpcProcess({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    cwd: fixture.project, env: fixture.env, args: ["--mode", "rpc", ...goalScenarioArgs(fixture)] });
  const state = record((await scenarioRpc(fixture).command("get_state", {}, { signal })).data);
  if (fixture.sessionFile === undefined) {
    assert.equal(state.sessionFile, undefined);
  } else {
    assert.equal(path.resolve(String(state.sessionFile)), path.resolve(fixture.sessionFile));
  }
  return scenarioRpc(fixture);
}

async function launchGoalScenarioTerminal(fixture: GoalScenarioFixture, signal: AbortSignal): Promise<PiTerminalProcess> {
  assert.equal(fixture.terminal, undefined);
  fixture.piLaunches++;
  fixture.terminal = new PiTerminalProcess({ file: process.execPath,
    args: [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), ...goalScenarioArgs(fixture)],
    cwd: fixture.project, env: fixture.env, cols: 110, rows: 32 });
  await fixture.terminal.waitForScreen(screen => screen.includes("KillerOS"), { signal, timeoutMs: 30_000 });
  return fixture.terminal;
}

function parseJsonLines(file: string): Json[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/u).filter(line => line.length > 0).map(line => record(JSON.parse(line)));
}

function sessionGoalEntries(file: string | undefined): Array<{ event: unknown; state: Json | null }> {
  if (file === undefined) return [];
  return parseJsonLines(file).flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data);
    return [{ event: data.event, state: data.state === null ? null : record(data.state) }];
  });
}

function rpcGoalEntries(entries: Json[]): Array<{ event: unknown; state: Json | null }> {
  return entries.flatMap(entry => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data);
    return [{ event: data.event, state: data.state === null ? null : record(data.state) }];
  });
}

async function scenarioRpcEntries(fixture: GoalScenarioFixture, signal: AbortSignal): Promise<Json[]> {
  return records(record((await scenarioRpc(fixture).command("get_entries", {}, { signal })).data).entries);
}

async function scenarioRpcState(fixture: GoalScenarioFixture, signal: AbortSignal): Promise<Json> {
  return record((await scenarioRpc(fixture).command("get_state", {}, { signal })).data);
}

async function scenarioRpcPrompt(fixture: GoalScenarioFixture, message: string, signal: AbortSignal): Promise<number> {
  const rpc = scenarioRpc(fixture);
  const after = rpc.currentSequence;
  const response = await rpc.command("prompt", { message }, { signal });
  const data = record(response.data);
  assert.equal(data.disposition, message.startsWith("/") ? "handled" : "started");
  return after;
}

async function scenarioRpcSettled(fixture: GoalScenarioFixture, after: number, signal: AbortSignal): Promise<void> {
  await scenarioRpc(fixture).waitFor(event => event.type === "agent_settled", { after, signal, timeoutMs: 45_000 });
  const state = await scenarioRpcState(fixture, signal);
  assert.equal(state.isStreaming, false);
  assert.equal(state.isCompacting, false);
  assert.equal(state.pendingMessageCount, 0);
}

async function scenarioRpcNotice(fixture: GoalScenarioFixture, after: number, pattern: RegExp, signal: AbortSignal,
  severity?: "info" | "warning" | "error"): Promise<string> {
  const event = await scenarioRpc(fixture).waitFor(item => item.type === "extension_ui_request" && item.method === "notify"
    && typeof item.message === "string" && pattern.test(item.message), { after, signal, timeoutMs: 20_000 });
  assert.ok(typeof event.message === "string");
  if (severity !== undefined) assert.equal(event.notifyType, severity);
  return event.message;
}

async function scenarioObserverEvent(fixture: GoalScenarioFixture, after: number, signal: AbortSignal): Promise<Json> {
  signal.throwIfAborted();
  const find = (): Json | undefined => parseJsonLines(fixture.observerFile)[after];
  const existing = find();
  if (existing) return existing;
  return await new Promise<Json>((resolve, reject) => {
    let watcher: FSWatcher | undefined;
    let settled = false;
    const finish = (error?: Error, event?: Json): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (event) resolve(event);
      else reject(new Error("Goal observer closed without an event"));
    };
    const check = (): void => {
      const event = find();
      if (event) finish(undefined, event);
    };
    const abort = (): void => finish(new Error("Waiting for the goal observer was cancelled", { cause: signal.reason }));
    const timer = setTimeout(() => finish(new Error("Timed out waiting for the goal observer event")), 30_000);
    try {
      watcher = watch(path.dirname(fixture.observerFile), { persistent: false }, check);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    watcher.once("error", error => finish(error));
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

async function runGoalScenarioOneShot(
  fixture: GoalScenarioFixture,
  mode: "print" | "json",
  prompt: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  fixture.piLaunches++;
  const args = [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), "--print",
    ...(mode === "json" ? ["--mode", "json"] : []), ...goalScenarioArgs(fixture), prompt];
  const invocation = promisify(execFile)(process.execPath, args, { cwd: fixture.project, env: fixture.env,
    timeout: 45_000, maxBuffer: 2_097_152, signal });
  invocation.child.stdin?.end();
  const result = await invocation;
  assert.equal(invocation.child.exitCode, 0);
  assert.equal(invocation.child.signalCode, null);
  fixture.naturalExits++;
  return result;
}

async function setScenarioFault(fixture: GoalScenarioFixture, enabled: boolean, repeat = false): Promise<void> {
  assert.ok(fixture.faultPlanFile);
  writeFileSync(fixture.faultPlanFile, JSON.stringify({ deny: enabled, repeat }));
}

async function closeGoalScenarioProcess(fixture: GoalScenarioFixture): Promise<void> {
  const errors: unknown[] = [];
  if (fixture.rpc) {
    try {
      const closed = await fixture.rpc.close();
      if (closed.exit.code !== 0 || closed.exit.signal !== null || closed.forced || closed.treeCleanupError !== undefined) {
        errors.push(new Error(`Goal RPC did not exit naturally: ${JSON.stringify(closed)}`));
      } else fixture.naturalExits++;
    } catch (error) { errors.push(error); }
    fixture.rpc = undefined;
  }
  if (fixture.terminal) {
    try {
      const closed = await fixture.terminal.close();
      if (closed.code !== 0 || closed.forced || closed.failure !== undefined) {
        errors.push(new Error(`Goal TUI did not exit naturally: ${JSON.stringify(closed)}`));
      } else fixture.naturalExits++;
    } catch (error) { errors.push(error); }
    fixture.terminal = undefined;
  }
  if (errors.length > 0) throw new AggregateError(errors, "Goal scenario process cleanup failed");
}

async function closeGoalScenarioFixture(fixture: GoalScenarioFixture): Promise<void> {
  const errors: unknown[] = [];
  fixture.provider.releaseAll();
  try { await closeGoalScenarioProcess(fixture); } catch (error) { errors.push(error); }
  try { await fixture.provider.close(); } catch (error) { errors.push(error); }
  try {
    await removeDirectoryEventually(fixture.directory);
    assert.equal(existsSync(fixture.directory), false);
  } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, "Goal scenario process cleanup failed");
}

type PromiseOutcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown };

function promiseOutcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    value => ({ kind: "resolved", value }),
    (error: unknown) => ({ kind: "rejected", error }),
  );
}

type GoalScenarioSummary = { piLaunches: number; providerRequests: number; naturalExits: number };

// Needed only when an exercise failed: cleardown kills the child, so the public
// failure state (session bytes, goal entries, live RPC stream) must be captured
// first and is then written into the bounded failure report.
function captureGoalScenarioDiagnostics(fixture: GoalScenarioFixture): Json {
  let rpc: Json | undefined;
  if (fixture.rpc) {
    try { rpc = record(JSON.parse(fixture.rpc.diagnostics())); }
    catch (error) { rpc = { error: String(error) }; }
  }
  let session: string | null = null;
  if (fixture.sessionFile !== undefined && existsSync(fixture.sessionFile)) {
    try { session = readFileSync(fixture.sessionFile, "utf8").slice(-8_000); }
    catch { session = null; }
  }
  let goalEntries: Array<{ event: unknown; state: Json | null }> | string;
  try { goalEntries = sessionGoalEntries(fixture.sessionFile); }
  catch (error) { goalEntries = String(error); }
  return { sessionFile: fixture.sessionFile ?? null, session, sessionGoalEntries: goalEntries, rpc: rpc ?? null };
}

async function runGoalScenarioHistory(
  t: TestContext,
  scenarioId: string,
  label: string,
  options: GoalScenarioOptions,
  exercise: (fixture: GoalScenarioFixture) => Promise<void>,
): Promise<GoalScenarioSummary> {
  const fixture = await createGoalScenarioFixture(label, options);
  let failed = false;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await exercise(fixture);
  } catch (error) {
    failed = true;
    failure = error;
  }
  const failureDiagnostics = failed ? captureGoalScenarioDiagnostics(fixture) : undefined;
  try { await closeGoalScenarioFixture(fixture); }
  catch (error) { cleanupFailures.push(error); }
  t.diagnostic(JSON.stringify({ scenarioId, label, piLaunches: fixture.piLaunches,
    providerRequests: fixture.provider.requests.length, naturalExits: fixture.naturalExits,
    // Exit truth lives in the counts; a quick check: pi launches that did not exit naturally.
    forcedExits: fixture.piLaunches - fixture.naturalExits, fixtureGitLaunches: 0,
    cleanup: cleanupFailures.length === 0 ? "scratch removed" : "cleanup failed; scratch state uncertain",
    providerFaults: fixture.provider.faults }));
  if (failed || cleanupFailures.length > 0) {
    const reportDirectory = mkdtempSync(path.join(root, "node_modules", ".killeros-goal-scenario-failure-"));
    throwScenarioFailure({ directory: reportDirectory, message: `${scenarioId}/${label} failed`,
      errors: [...(failure !== undefined ? [failure] : []), ...cleanupFailures],
      diagnostics: JSON.stringify({ scenarioId, label, piLaunches: fixture.piLaunches,
        providerRequests: fixture.provider.requests.length, naturalExits: fixture.naturalExits,
        providerFaults: fixture.provider.faults, cleanupFailures: cleanupFailures.length,
        ...failureDiagnostics }) });
  }
  return { piLaunches: fixture.piLaunches, providerRequests: fixture.provider.requests.length, naturalExits: fixture.naturalExits };
}

function scenarioToolNames(body: Json | undefined): string[] {
  assert.ok(body);
  return records(body.tools).map(tool => String(record(tool.function).name));
}

function scenarioMessageText(body: Json | undefined): string {
  assert.ok(body);
  return JSON.stringify(body.messages);
}

function goalContinuations(file: string): string[] {
  return SessionManager.open(file).getBranch().flatMap(entry => {
    if (entry.type !== "custom_message" || entry.customType !== "killeros-goal-continuation") return [];
    assert.ok(typeof entry.content === "string");
    return [entry.content];
  });
}

function goalAppendAttempt(fixture: GoalScenarioFixture): Json {
  assert.ok(fixture.faultAttemptFile);
  return record(JSON.parse(readFileSync(fixture.faultAttemptFile, "utf8")));
}

function assertGoalAppendFaultAdapter(fixture: GoalScenarioFixture, expectedPath: string, processId: number): void {
  assert.ok(fixture.faultAttemptFile);
  const attempt = goalAppendAttempt(fixture);
  assert.equal(attempt.pid, processId);
  assert.equal(attempt.operation, "appendFileSync");
  assert.equal(path.resolve(String(attempt.path)), path.resolve(expectedPath));
  const control = path.dirname(fixture.faultAttemptFile);
  assert.match(readFileSync(path.join(control, "forwarded.log"), "utf8"), /forwarded/u);
  const restored = record(JSON.parse(readFileSync(path.join(control, "restored.json"), "utf8")));
  assert.equal(restored.pid, processId);
  assert.ok(typeof restored.forwarded === "number" && restored.forwarded > 0);
}

function statusGoal(objective: string, status: "paused" | "blocked" | "complete", now = Date.now()): Json {
  const active = activeGoal(objective, now);
  const { activeStartedAt: _activeStartedAt, turnPhase: _turnPhase, ...rest } = active;
  return { ...rest, status, ...(status === "blocked" || status === "complete" ? { result: `${status} fixture result` } : {}) };
}

test("saved goals stay inactive outside TUI and RPC or without a saved session", { timeout: 300_000 }, async t => {
  const totals = { piLaunches: 0, providerRequests: 0, naturalExits: 0 };
  const run = async (label: string, options: GoalScenarioOptions, exercise: (fixture: GoalScenarioFixture) => Promise<void>) => {
    const summary = await runGoalScenarioHistory(t, "goals.modes", label, options, exercise);
    totals.piLaunches += summary.piLaunches;
    totals.providerRequests += summary.providerRequests;
    totals.naturalExits += summary.naturalExits;
  };
  const objective = "Keep this saved active goal inactive outside an eligible session";
  const active = activeGoal(objective, Date.now());

  await run("tui-saved-active", { session: { goal: { state: active, event: "set" } } }, async fixture => {
    const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const terminal = await launchGoalScenarioTerminal(fixture, t.signal);
    await reached(request.started.promise, t.signal, "saved active TUI request");
    assert.ok(scenarioToolNames(request.body).includes("killeros_goal_update"));
    assert.match(scenarioMessageText(request.body), /Active KillerOS goal/u);
    assert.match(scenarioMessageText(request.body), new RegExp(objective, "u"));
    request.release.release();
    const settled = await scenarioObserverEvent(fixture, 0, t.signal);
    assert.equal(settled.mode, "tui");
    assert.equal(settled.aborted, false);
    assert.equal(settled.idle, true);
    assert.equal(fixture.provider.requests.length, 1);
    const saved = sessionGoalEntries(fixture.sessionFile);
    assert.equal(saved.at(-1)?.state?.status, "paused");
    void terminal;
  });

  await run("rpc-saved-active", { session: { goal: { state: active, event: "set" } } }, async fixture => {
    const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    await launchGoalScenarioRpc(fixture, t.signal);
    await reached(request.started.promise, t.signal, "saved active RPC request");
    assert.ok(scenarioToolNames(request.body).includes("killeros_goal_update"));
    assert.match(scenarioMessageText(request.body), /Active KillerOS goal/u);
    assert.match(scenarioMessageText(request.body), new RegExp(objective, "u"));
    const statusAfter = await scenarioRpcPrompt(fixture, "/goal", t.signal);
    assert.match(await scenarioRpcNotice(fixture, statusAfter, /Goal active/u, t.signal), /Goal active/u);
    request.release.release();
    await scenarioRpcSettled(fixture, 0, t.signal);
    assert.equal(rpcGoalEntries(await scenarioRpcEntries(fixture, t.signal)).at(-1)?.state?.status, "paused");
    assert.equal(fixture.provider.requests.length, 1);
  });

  for (const mode of ["tui", "rpc"] as const) {
    await run(`${mode}-no-session`, {}, async fixture => {
      const attempt = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "complete", evidence: "Try blocked completion" }] },
        { held: true });
      const followup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
      let settledAfter = 0;
      if (mode === "tui") {
        const terminal = await launchGoalScenarioTerminal(fixture, t.signal);
        settledAfter = parseJsonLines(fixture.observerFile).length;
        await terminal.submitEditorText("Attempt a goal completion without a saved session", { signal: t.signal });
      } else {
        const rpc = await launchGoalScenarioRpc(fixture, t.signal);
        settledAfter = rpc.currentSequence;
        await scenarioRpcPrompt(fixture, "Attempt a goal completion without a saved session", t.signal);
      }
      await reached(attempt.started.promise, t.signal, `${mode} unsaved probe request`);
      assert.ok(!scenarioToolNames(attempt.body).includes("killeros_goal_update"));
      assert.doesNotMatch(scenarioMessageText(attempt.body), /Active KillerOS goal/u);
      attempt.release.release();
      await reached(followup.started.promise, t.signal, `${mode} unavailable completion result`);
      assert.match(scenarioMessageText(followup.body), /not found|not available|no active|unknown tool/iu);
      if (mode === "rpc") {
        const entries = await scenarioRpcEntries(fixture, t.signal);
        const rejected = toolResult(entries, "audit-1-0");
        assert.equal(rejected.isError, true);
        assert.match(JSON.stringify(rejected.content), /not found|not available|no active|unknown tool/iu);
      }
      followup.release.release();
      if (mode === "rpc") await scenarioRpcSettled(fixture, settledAfter, t.signal);
      else {
        const settled = await scenarioObserverEvent(fixture, settledAfter, t.signal);
        assert.equal(settled.mode, "tui");
        assert.equal(settled.idle, true);
        assert.equal(settled.pending, false);
      }
      assert.deepEqual(sessionGoalEntries(fixture.sessionFile), []);
      assert.equal(fixture.provider.requests.length, 2);
      assert.equal(fixture.sessionFile, undefined, "The launch must use explicit --no-session");
      assert.deepEqual(readdirSync(fixture.sessions), []);
    });
  }

  for (const mode of ["print", "json"] as const) {
    await run(`${mode}-request-saved-active`, { session: { goal: { state: active, event: "set" } } }, async fixture => {
      const request = fixture.provider.enqueue({ kind: "stop" });
      const before = sessionGoalEntries(fixture.sessionFile);
      await runGoalScenarioOneShot(fixture, mode, "Inspect the saved active goal without resuming it", t.signal);
      assert.equal(fixture.provider.requests.length, 1);
      assert.ok(!scenarioToolNames(request.body).includes("killeros_goal_update"));
      assert.doesNotMatch(scenarioMessageText(request.body), /Active KillerOS goal/u);
      assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before,
        "A saved active goal must not dispatch, pause, or checkpoint during noninteractive work or shutdown");
    });
    for (const sessionKind of ["saved", "none"] as const) {
      const label = `${mode}-command-${sessionKind}`;
      const options: GoalScenarioOptions = sessionKind === "saved"
        ? { session: { goal: { state: active, event: "set" } } }
        : {};
      await run(label, options, async fixture => {
        const before = sessionGoalEntries(fixture.sessionFile);
        const result = await runGoalScenarioOneShot(fixture, mode, "/goal Unsupported noninteractive goal", t.signal);
        // The noninteractive goal rejection has no stdout/stderr channel in print or json mode
        // (observed 2026-10-25: only the seeded assistant text / a session-start JSON record),
        // so the observable contracts here are the process output shape and session truth.
        if (mode === "json") {
          const lines = result.stdout.split(/\r?\n/u).filter(line => line.length > 0);
          assert.equal(lines.length, 1, `${label}: a handled noninteractive goal command must emit exactly one JSON record`);
          assert.equal(record(JSON.parse(lines[0] ?? "")).type, "session", `${label}: the JSON record must be the session start`);
        } else {
          assert.equal(result.stdout.trimEnd(), sessionKind === "saved" ? "The previous work is saved." : "", `${label}: print output`);
        }
        assert.equal(result.stderr, "", `${label}: no stderr`);
        assert.equal(fixture.provider.requests.length, 0);
        assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before);
        if (sessionKind === "none") {
          assert.equal(fixture.sessionFile, undefined);
          assert.deepEqual(readdirSync(fixture.sessions), []);
        }
      });
    }
  }

  for (const mode of ["print", "json"] as const) {
    for (const sessionKind of ["saved", "none"] as const) {
      const state = statusGoal("A saved blocked goal must not be completable in this mode", "blocked");
      const options: GoalScenarioOptions = sessionKind === "saved"
        ? { session: { goal: { state, event: "blocked" } } }
        : {};
      await run(`${mode}-request-${sessionKind}`, options, async fixture => {
        const rejected = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "complete", evidence: "Try blocked completion" }] });
        fixture.provider.enqueue({ kind: "stop" });
        const before = sessionGoalEntries(fixture.sessionFile);
        const result = await runGoalScenarioOneShot(fixture, mode, "Attempt blocked goal completion", t.signal);
        assert.equal(fixture.provider.requests.length, 2, `${mode}/${sessionKind}: ${JSON.stringify(result)}`);
        assert.ok(!scenarioToolNames(rejected.body).includes("killeros_goal_update"));
        assert.doesNotMatch(scenarioMessageText(rejected.body), /Active KillerOS goal|Blocked KillerOS goal/u);
        assert.match(scenarioMessageText(fixture.provider.requests[1]), /not found|not available|no active|unknown tool/iu);
        assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before);
        if (mode === "json") assert.match(result.stdout, /agent_end|agent_start|agent|assistant/u);
        if (sessionKind === "none") {
          assert.equal(fixture.sessionFile, undefined);
          assert.deepEqual(readdirSync(fixture.sessions), []);
        }
      });
    }
  }

  for (const status of ["paused", "complete", "absent"] as const) {
    const options: GoalScenarioOptions = status === "absent"
      ? { session: {} }
      : { session: { goal: { state: statusGoal(`Saved ${status} goal`, status), event: status } } };
    await run(`rpc-saved-${status}-blocked-completion`, options, async fixture => {
      const rejected = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "complete", evidence: "Try blocked completion" }] },
        { held: true });
      const followup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
      const rpc = await launchGoalScenarioRpc(fixture, t.signal);
      const before = rpcGoalEntries(await scenarioRpcEntries(fixture, t.signal));
      const settledAfter = await scenarioRpcPrompt(fixture, "Attempt a blocked goal completion", t.signal);
      await reached(rejected.started.promise, t.signal, `${status} RPC completion probe`);
      assert.ok(!scenarioToolNames(rejected.body).includes("killeros_goal_update"));
      assert.doesNotMatch(scenarioMessageText(rejected.body), /Active KillerOS goal|Blocked KillerOS goal/u);
      rejected.release.release();
      await reached(followup.started.promise, t.signal, `${status} RPC rejected tool result`);
      const result = toolResult(await scenarioRpcEntries(fixture, t.signal), "audit-1-0");
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /not found|not available|no active|unknown tool/iu);
      followup.release.release();
      await scenarioRpcSettled(fixture, settledAfter, t.signal);
      assert.deepEqual(rpcGoalEntries(await scenarioRpcEntries(fixture, t.signal)), before);
      assert.equal(fixture.provider.requests.length, 2);
      assert.equal(rpc.currentSequence >= settledAfter, true);
    });
  }

  assert.deepEqual(totals, { piLaunches: 17, providerRequests: 22, naturalExits: 17 });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.modes", histories: 17, ...totals,
    fixtureGitLaunches: 0, activeButNotStartedGuard: "not covered by this catalog scenario",
    commandRejectionChannel: "unobservable in print and json stdout/stderr; catalog oracle needs re-tailoring (blocker)" }));
});


// Catalog ID: goals.tool-availability. Frozen source: GoalLifecycle.test.ts:348#1.
test("goal tool availability follows RPC start pause resume and completion", { timeout: 90_000 }, async t => {
  const totals = { piLaunches: 0, providerRequests: 0, naturalExits: 0 };
  const run = async (label: string, options: GoalScenarioOptions, exercise: (fixture: GoalScenarioFixture) => Promise<void>) => {
    const summary = await runGoalScenarioHistory(t, "goals.tool-availability", label, options, exercise);
    totals.piLaunches += summary.piLaunches;
    totals.providerRequests += summary.providerRequests;
    totals.naturalExits += summary.naturalExits;
  };
  await run("rpc-tool-availability-transitions", { session: {} }, async fixture => {
    const inactive = fixture.provider.enqueue({ kind: "stop" });
    const active = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const paused = fixture.provider.enqueue({ kind: "stop" });
    const completing = fixture.provider.enqueue({ kind: "complete", evidence: "Verified complete" }, { held: true });
    const followup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const completed = fixture.provider.enqueue({ kind: "stop" });
    await launchGoalScenarioRpc(fixture, t.signal);

    await scenarioRpcSettled(fixture, await scenarioRpcPrompt(fixture, "Inspect inactive tools", t.signal), t.signal);
    assert.ok(!scenarioToolNames(inactive.body).includes("killeros_goal_update"));
    const start = await scenarioRpcPrompt(fixture, "/goal Finish only after explicit activation", t.signal);
    await reached(active.started.promise, t.signal, "active tool request");
    assert.ok(scenarioToolNames(active.body).includes("killeros_goal_update"));
    const pause = await scenarioRpcPrompt(fixture, "/goal pause", t.signal);
    await reached(active.closed.promise, t.signal, "tool activation pause");
    await scenarioRpcNotice(fixture, pause, /Goal paused/u, t.signal);
    await scenarioRpcSettled(fixture, start, t.signal);
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "paused");

    await scenarioRpcSettled(fixture, await scenarioRpcPrompt(fixture, "Inspect paused tools", t.signal), t.signal);
    assert.ok(!scenarioToolNames(paused.body).includes("killeros_goal_update"));
    const resume = await scenarioRpcPrompt(fixture, "/goal resume", t.signal);
    await reached(completing.started.promise, t.signal, "resumed tool request");
    assert.ok(scenarioToolNames(completing.body).includes("killeros_goal_update"));
    completing.release.release();
    await reached(followup.started.promise, t.signal, "completion tool result");
    const result = toolResult(await scenarioRpcEntries(fixture, t.signal), "goal-complete-4");
    assert.equal(result.isError, false);
    assert.equal(record(result.details).status, "complete");
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "complete");
    assert.ok(!scenarioToolNames(followup.body).includes("killeros_goal_update"));
    followup.release.release();
    await scenarioRpcSettled(fixture, resume, t.signal);
    await scenarioRpcSettled(fixture, await scenarioRpcPrompt(fixture, "Inspect completed tools", t.signal), t.signal);
    assert.ok(!scenarioToolNames(completed.body).includes("killeros_goal_update"));
    assert.equal(fixture.provider.requests.length, 6);
  });

  assert.deepEqual(totals, { piLaunches: 1, providerRequests: 6, naturalExits: 1 });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.tool-availability", histories: 1, ...totals, fixtureGitLaunches: 0 }));
});

// Catalog ID: goals.legacy-modes. Frozen source: GoalLifecycle.test.ts:566#1.
test("legacy saved goals stay inactive in print and JSON modes", { timeout: 120_000 }, async t => {
  const totals = { piLaunches: 0, providerRequests: 0, naturalExits: 0 };
  const run = async (label: string, options: GoalScenarioOptions, exercise: (fixture: GoalScenarioFixture) => Promise<void>) => {
    const summary = await runGoalScenarioHistory(t, "goals.legacy-modes", label, options, exercise);
    totals.piLaunches += summary.piLaunches;
    totals.providerRequests += summary.providerRequests;
    totals.naturalExits += summary.naturalExits;
  };
  for (const mode of ["print", "json"] as const) {
    const now = Date.now();
    const legacyActive = { version: 1, revision: 1, objective: "Do not auto-run here", status: "active",
      createdAt: now, updatedAt: now, activeMilliseconds: 0, activeStartedAt: now, turns: 1, baselineTokens: 0 };
    await run(`${mode}-legacy-active-ordinary`, { session: { goal: { state: legacyActive, event: "turn" } } }, async fixture => {
      const request = fixture.provider.enqueue({ kind: "stop" });
      const before = sessionGoalEntries(fixture.sessionFile);
      await runGoalScenarioOneShot(fixture, mode, "Inspect the saved goal", t.signal);
      assert.equal(fixture.provider.requests.length, 1);
      assert.match(scenarioMessageText(request.body), /Inspect the saved goal/u);
      assert.ok(!scenarioToolNames(request.body).includes("killeros_goal_update"));
      assert.doesNotMatch(scenarioMessageText(request.body), /Active KillerOS goal/u);
      assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before);
    });
    await run(`${mode}-legacy-active-status`, { session: { goal: { state: legacyActive, event: "turn" } } }, async fixture => {
      const before = sessionGoalEntries(fixture.sessionFile);
      const result = await runGoalScenarioOneShot(fixture, mode, "/goal", t.signal);
      if (mode === "json") {
        const lines = result.stdout.split(/\r?\n/u).filter(line => line.length > 0);
        assert.equal(lines.length, 1);
        assert.equal(record(JSON.parse(lines[0] ?? "")).type, "session");
      } else assert.equal(result.stdout.trimEnd(), "The previous work is saved.");
      assert.equal(result.stderr, "");
      assert.equal(fixture.provider.requests.length, 0);
      assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before);
    });
  }

  assert.deepEqual(totals, { piLaunches: 4, providerRequests: 2, naturalExits: 4 });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.legacy-modes", histories: 4, ...totals, fixtureGitLaunches: 0,
    commandRejectionChannel: "unobservable in print and json stdout/stderr; private callback disposition remains pending" }));
});

// Catalog ID: goals.pause-after-progress. An explicit pause stops a legitimately advanced turn.
test("explicit pause prevents another continuation after accepted goal progress", { timeout: 60_000 }, async t => {
  await runGoalScenarioHistory(t, "goals.pause-after-progress", "pause-after-continue", { session: {} }, async fixture => {
    fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue",
      evidence: "The first migration step passed", nextAction: "Run the next migration step" }] });
    fixture.provider.enqueue({ kind: "stop" });
    const next = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const rpc = await launchGoalScenarioRpc(fixture, t.signal);
    await scenarioRpcPrompt(fixture, "/goal Finish the migration", t.signal);
    await reached(next.started.promise, t.signal, "authorized second goal turn");
    assert.match(scenarioMessageText(next.body), /Finish the migration/u);
    assert.match(scenarioMessageText(next.body), /Status: active · Turn: 2/u);
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.turns, 2);
    const paused = await scenarioRpcPrompt(fixture, "/goal pause", t.signal);
    await reached(next.closed.promise, t.signal, "explicit second-turn pause");
    await scenarioRpcSettled(fixture, paused, t.signal);
    const state = sessionGoalEntries(fixture.sessionFile).at(-1)?.state;
    assert.equal(state?.status, "paused");
    assert.equal(state?.turns, 2);
    assert.equal(state?.resumeAfterManualCompaction, undefined);
    assert.equal(fixture.provider.requests.length, 3);
    const entries = await scenarioRpcEntries(fixture, t.signal);
    assert.equal(entries.filter(entry => entry.type === "custom_message" && entry.customType === "killeros-goal-continuation").length, 2);
    assert.equal(sessionGoalEntries(fixture.sessionFile).filter(entry => entry.event === "continue").length, 1);
    assert.equal((await scenarioRpcState(fixture, t.signal)).pendingMessageCount, 0);
    assert.equal(rpc.currentSequence > paused, true);
  });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.pause-after-progress", histories: 1, piLaunches: 1,
    providerRequests: 3, naturalExits: 1, fixtureGitLaunches: 0 }));
});

// Catalog ID: goals.pause-clear. Native settlement proves cancellation, not private host-call order.
test("pause and clear cancel goal work while inactive clears preserve unrelated work", { timeout: 240_000 }, async t => {
  const totals = { piLaunches: 0, providerRequests: 0, naturalExits: 0 };
  const run = async (label: string, options: GoalScenarioOptions, exercise: (fixture: GoalScenarioFixture) => Promise<void>) => {
    const summary = await runGoalScenarioHistory(t, "goals.pause-clear", label, options, exercise);
    totals.piLaunches += summary.piLaunches;
    totals.providerRequests += summary.providerRequests;
    totals.naturalExits += summary.naturalExits;
  };
  await run("rpc-clean-pause-resume-clear", { session: {} }, async fixture => {
    const first = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    await launchGoalScenarioRpc(fixture, t.signal);
    const started = await scenarioRpcPrompt(fixture, "/goal Persist clean pause and clear transitions", t.signal);
    await scenarioRpcNotice(fixture, started, /^Goal started\. Each turn must record continue, complete, or a blocker decision before another turn starts\.$/u, t.signal, "info");
    await reached(first.started.promise, t.signal, "clean goal start");
    const paused = await scenarioRpcPrompt(fixture, "/goal pause", t.signal);
    await reached(first.closed.promise, t.signal, "clean pause cancellation");
    await scenarioRpcNotice(fixture, paused, /^Goal paused\. Run \/goal resume to continue\.$/u, t.signal, "info");
    await scenarioRpcSettled(fixture, started, t.signal);
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "paused");

    const second = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const resumed = await scenarioRpcPrompt(fixture, "/goal resume", t.signal);
    await scenarioRpcNotice(fixture, resumed, /^Goal resumed$/u, t.signal, "info");
    await reached(second.started.promise, t.signal, "clean resumed request");
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "active",
      "Resume persists active state before the held response settles");
    assert.equal(SessionManager.open(String(fixture.sessionFile)).getEntries().filter(entry =>
      entry.type === "custom_message" && entry.customType === "killeros-goal-continuation").length, 2,
    "Start and resume dispatch exactly two native goal continuations");
    second.release.release();
    await scenarioRpcSettled(fixture, resumed, t.signal);
    const entries = await scenarioRpcEntries(fixture, t.signal);
    const assistant = entries.filter(entry => entry.type === "message" && isRecord(entry.message)
      && entry.message.role === "assistant").at(-1);
    assert.ok(assistant && isRecord(assistant.message));
    assert.equal(assistant.message.stopReason, "stop");
    assert.ok(records(assistant.message.content).some(part => part.type === "text"
      && part.text === "The goal scenario request finished."));
    const cleared = await scenarioRpcPrompt(fixture, "/goal clear", t.signal);
    await scenarioRpcNotice(fixture, cleared, /^Goal cleared$/u, t.signal, "info");
    const final = sessionGoalEntries(fixture.sessionFile).at(-1);
    assert.equal(final?.event, "clear");
    assert.equal(final?.state, null);
    const state = await scenarioRpcState(fixture, t.signal);
    assert.equal(state.isStreaming, false);
    assert.equal(state.isCompacting, false);
    assert.equal(state.pendingMessageCount, 0);
    assert.equal(fixture.provider.requests.length, 2);
  });
  for (const mode of ["tui", "rpc"] as const) {
    for (const control of ["pause", "clear"] as const) {
      const objective = `Immediately ${control} active work`;
      await run(`${mode}-${control}-active`, { session: { goal: { state: activeGoal(objective, Date.now()), event: "set" } } },
        async fixture => {
          const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
          const terminal = mode === "tui" ? await launchGoalScenarioTerminal(fixture, t.signal) : undefined;
          if (mode === "rpc") await launchGoalScenarioRpc(fixture, t.signal);
          await reached(request.started.promise, t.signal, `${mode} ${control} active provider request`);
          assert.ok(scenarioToolNames(request.body).includes("killeros_goal_update"));
          assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "active");
          const observerCursor = parseJsonLines(fixture.observerFile).length;
          const rpcCursor = fixture.rpc?.currentSequence ?? 0;
          if (terminal) await terminal.submitEditorText(`/goal ${control}`, { signal: t.signal });
          else await scenarioRpcPrompt(fixture, `/goal ${control}`, t.signal);
          await reached(request.closed.promise, t.signal, `${mode} ${control} provider cancellation`);
          if (mode === "rpc") {
            await scenarioRpcSettled(fixture, rpcCursor, t.signal);
            await scenarioRpcNotice(fixture, rpcCursor, control === "pause" ? /Goal paused/u : /Goal cleared/u, t.signal, "info");
          } else {
            const settled = await scenarioObserverEvent(fixture, observerCursor, t.signal);
            assert.equal(settled.mode, "tui");
            assert.equal(settled.idle, true);
            assert.equal(settled.pending, false);
            await terminal?.waitForScreen(screen => screen.includes(control === "pause" ? "Goal paused" : "Goal cleared"),
              { signal: t.signal });
          }
          const terminalEntry = sessionGoalEntries(fixture.sessionFile).at(-1);
          assert.equal(terminalEntry?.event, control);
          if (control === "clear") assert.equal(terminalEntry?.state, null);
          else {
            assert.equal(terminalEntry?.state?.status, "paused");
            assert.equal(terminalEntry?.state?.objective, objective);
          }
          await closeGoalScenarioProcess(fixture);
          const durable = sessionGoalEntries(fixture.sessionFile).at(-1);
          assert.equal(control === "clear" ? durable?.state : durable?.state?.status, control === "clear" ? null : "paused");
          assert.equal(fixture.provider.requests.length, 1, "Explicit cancellation must not dispatch another goal turn");
        });
    }
  }
  for (const status of ["paused", "blocked", "complete"] as const) {
    await run(`clear-${status}-during-unrelated-work`, {
      session: { goal: { state: statusGoal(`${status} objective`, status), event: status } },
    }, async fixture => {
      const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
      const rpc = await launchGoalScenarioRpc(fixture, t.signal);
      const cursor = await scenarioRpcPrompt(fixture, "Finish this unrelated ordinary request", t.signal);
      await reached(request.started.promise, t.signal, `${status} unrelated provider request`);
      assert.doesNotMatch(scenarioMessageText(request.body), /Active KillerOS goal/u);
      const cleared = await scenarioRpcPrompt(fixture, "/goal clear", t.signal);
      await scenarioRpcNotice(fixture, cleared, /Goal cleared/u, t.signal, "info");
      assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.event, "clear");
      assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state, null);
      assert.equal((await scenarioRpcState(fixture, t.signal)).isStreaming, true,
        "Clearing an inactive goal must leave the held ordinary request running");
      request.release.release();
      await scenarioRpcSettled(fixture, cursor, t.signal);
      const entries = await scenarioRpcEntries(fixture, t.signal);
      const assistant = entries.filter(entry => entry.type === "message" && isRecord(entry.message)
        && entry.message.role === "assistant").at(-1);
      assert.ok(assistant && isRecord(assistant.message));
      assert.equal(assistant.message.stopReason, "stop");
      assert.ok(records(assistant.message.content).some(part => part.type === "text"
        && part.text === "The goal scenario request finished."), "The held ordinary response must finish normally after clear");
      await closeGoalScenarioProcess(fixture);
      assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state, null);
      assert.equal(fixture.provider.requests.length, 1);
      assert.ok(rpc.currentSequence >= cursor);
    });
  }
  for (const mode of ["tui", "rpc"] as const) {
    for (const control of ["pause", "clear"] as const) {
      await run(`${mode}-${control}-write-failure-recovery`, {
        session: { goal: { state: activeGoal(`Persist ${control} before abort`, Date.now()), event: "set" } },
        faultMessage: `${control} write failed`,
      }, async fixture => {
        const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
        const terminal = mode === "tui" ? await launchGoalScenarioTerminal(fixture, t.signal) : undefined;
        if (mode === "rpc") await launchGoalScenarioRpc(fixture, t.signal);
        await reached(request.started.promise, t.signal, `${mode} failed ${control} active request`);
        await setScenarioFault(fixture, true, true);
        const observerCursor = parseJsonLines(fixture.observerFile).length;
        const cursor = fixture.rpc?.currentSequence ?? 0;
        if (terminal) await terminal.submitEditorText(`/goal ${control}`, { signal: t.signal });
        else await scenarioRpcPrompt(fixture, `/goal ${control}`, t.signal);
        await reached(request.closed.promise, t.signal, `${mode} failed ${control} cancellation`);
        const failurePattern = new RegExp(`the requested ${control} could not be saved`, "u");
        if (terminal) {
          const settled = await scenarioObserverEvent(fixture, observerCursor, t.signal);
          assert.equal(settled.idle, true);
          assert.equal(settled.pending, false);
          await terminal.waitForScreen(screen => failurePattern.test(screen), { signal: t.signal });
          assert.ok(terminal.screen().includes("Automatic continuation is stopped"));
        } else {
          await scenarioRpcSettled(fixture, cursor, t.signal);
          const notice = await scenarioRpcNotice(fixture, cursor, failurePattern, t.signal, "error");
          assert.match(notice, failurePattern);
          assert.match(notice, /Automatic continuation is stopped/u);
        }
        const observed = await scenarioObserverEvent(fixture, observerCursor, t.signal);
        assert.ok(typeof observed.pid === "number");
        assert.equal(sessionGoalEntries(fixture.sessionFile).some(entry => entry.event === control), false,
          "The denied control write must not be durable");
        if (terminal) assert.ok(terminal.screen().includes("/goal paused"));
        else {
          const statusCursor = await scenarioRpcPrompt(fixture, "/goal", t.signal);
          await scenarioRpcNotice(fixture, statusCursor, /Goal paused/u, t.signal);
        }
        await setScenarioFault(fixture, false);
        const retryCursor = fixture.rpc?.currentSequence ?? 0;
        if (terminal) {
          await terminal.submitEditorText(`/goal ${control}`, { signal: t.signal });
          await terminal.waitForScreen(screen => screen.includes(control === "pause" ? "Goal pause saved" : "Goal cleared"),
            { signal: t.signal });
        } else {
          await scenarioRpcPrompt(fixture, `/goal ${control}`, t.signal);
          await scenarioRpcNotice(fixture, retryCursor, control === "pause" ? /Goal pause saved/u : /Goal cleared/u, t.signal, "info");
        }
        const recovered = sessionGoalEntries(fixture.sessionFile).at(-1);
        assert.equal(recovered?.event, control);
        assert.equal(control === "clear" ? recovered?.state : recovered?.state?.status, control === "clear" ? null : "paused");
        await closeGoalScenarioProcess(fixture);
        assertGoalAppendFaultAdapter(fixture, String(fixture.sessionFile), observed.pid);
        assert.equal(fixture.provider.requests.length, 1);
      });
    }
  }
  for (const control of ["pause", "clear"] as const) {
    await run(`rpc-${control}-first-write-failure`, {
      session: {}, faultMessage: "\x1b]2;owned\x07\x1b[31mtransient\x1b[0m\0 session write failure",
    }, async fixture => {
      const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
      const rpc = await launchGoalScenarioRpc(fixture, t.signal);
      await scenarioRpcPrompt(fixture, `/goal Safely ${control} this goal`, t.signal);
      await reached(request.started.promise, t.signal, `transient ${control} active request`);
      await setScenarioFault(fixture, true);
      const cursor = await scenarioRpcPrompt(fixture, `/goal ${control}`, t.signal);
      await reached(request.closed.promise, t.signal, `transient ${control} cancellation`);
      await scenarioRpcSettled(fixture, cursor, t.signal);
      const notice = await scenarioRpcNotice(fixture, cursor, /Automatic continuation is stopped/u, t.signal, "error");
      assert.equal(notice, control === "pause"
        ? "Goal paused: the requested pause could not be saved: transient session write failure\nAutomatic continuation is stopped. If session storage is still unavailable, retry /goal pause after it recovers."
        : "Goal paused: the requested clear could not be saved\nAutomatic continuation is stopped. Retry /goal clear to remove the goal.");
      const fallback = sessionGoalEntries(fixture.sessionFile).at(-1)?.state;
      assert.equal(fallback?.status, "paused");
      assert.equal(fallback?.result, `the requested ${control} could not be saved: transient session write failure`);
      assert.equal(fixture.provider.requests.length, 1);
      await setScenarioFault(fixture, false);
      if (control === "pause") {
        const resumed = fixture.provider.enqueue({ kind: "stop" }, { held: true });
        await scenarioRpcPrompt(fixture, "/goal resume", t.signal);
        await reached(resumed.started.promise, t.signal, "resume after transient pause");
        assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "active");
        assert.equal(SessionManager.open(String(fixture.sessionFile)).getEntries().filter(entry =>
          entry.type === "custom_message" && entry.customType === "killeros-goal-continuation").length, 2);
        const cleared = await scenarioRpcPrompt(fixture, "/goal clear", t.signal);
        await reached(resumed.closed.promise, t.signal, "clear after transient pause resume");
        await scenarioRpcSettled(fixture, cleared, t.signal);
        await scenarioRpcNotice(fixture, cleared, /Goal cleared/u, t.signal, "info");
        assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.event, "clear");
        assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state, null);
      }
      const processId = scenarioProcessId(fixture);
      await closeGoalScenarioProcess(fixture);
      assertGoalAppendFaultAdapter(fixture, String(fixture.sessionFile), processId);
      assert.equal(fixture.provider.requests.length, control === "pause" ? 2 : 1);
      assert.ok(rpc.currentSequence >= cursor);
    });
  }
  assert.deepEqual(totals, { piLaunches: 14, providerRequests: 16, naturalExits: 14 });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.pause-clear", histories: 14, inputVectors: 14, ...totals,
    unresolved: "private call ordering, scheduled-before-turn pause, and host abort failure are not established" }));
});

test("replacement, start, and edit write failures leave truthful state", { timeout: 240_000 }, async t => {
  const totals = { piLaunches: 0, providerRequests: 0, naturalExits: 0 };
  const run = async (label: string, options: GoalScenarioOptions, exercise: (fixture: GoalScenarioFixture) => Promise<void>) => {
    const summary = await runGoalScenarioHistory(t, "goals.persistence-failures", label, options, exercise);
    totals.piLaunches += summary.piLaunches;
    totals.providerRequests += summary.providerRequests;
    totals.naturalExits += summary.naturalExits;
  };
  const signal = t.signal;

  await run("active-replacement", { session: {}, faultMessage: "replacement write failed" }, async fixture => {
    const first = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "First step passed",
      nextAction: "Continue the original objective" }] }, { held: true });
    const followup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const rpc = await launchGoalScenarioRpc(fixture, signal);
    await scenarioRpcPrompt(fixture, "/goal Old objective", signal);
    await reached(first.started.promise, signal, "active replacement first turn");
    assert.ok(scenarioToolNames(first.body).includes("killeros_goal_update"));
    first.release.release();
    await reached(followup.started.promise, signal, "active replacement continuation");
    const accepted = toolResult(await scenarioRpcEntries(fixture, signal), "audit-1-0");
    assert.equal(accepted.isError, false);
    assert.equal(record(accepted.details).status, "continue");
    const originalRaw = readFileSync(String(fixture.sessionFile), "utf8");
    const processId = scenarioProcessId(fixture);
    await setScenarioFault(fixture, true);

    const cursor = rpc.currentSequence;
    const replacement = promiseOutcome(rpc.command("prompt", { message: "/goal New objective" }, { signal }));
    const confirmation = await rpc.waitFor(event => event.type === "extension_ui_request" && event.method === "confirm",
      { after: cursor, signal, timeoutMs: 20_000 });
    assert.equal(confirmation.title, "Replace active goal");
    assert.equal(confirmation.message, "Replace the current unfinished goal and discard its continuation state?");
    assert.equal(typeof confirmation.id, "string");
    await rpc.send({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
    const settleAfter = rpc.currentSequence;
    followup.release.release();
    await scenarioRpcSettled(fixture, settleAfter, signal);
    const response = await replacement;
    assert.equal(response.kind, "resolved");
    if (response.kind === "resolved") assert.equal(record(response.value.data).disposition, "handled");
    const notice = await scenarioRpcNotice(fixture, cursor, /Goal could not be replaced: replacement write failed/u, signal);
    assert.match(notice, /Old objective|Goal paused/u);

    // The denied replacement append still enters the live session branch before its bytes are
    // flushed, so the RPC view reports the attempt while the durable session file must not.
    const saved = rpcGoalEntries(await scenarioRpcEntries(fixture, signal));
    assert.ok(saved.some(entry => entry.event === "replace" && entry.state?.objective === "New objective"),
      "The replacement attempt must be visible in the live session view");
    assert.equal(saved.at(-1)?.event, "error");
    assert.equal(saved.at(-1)?.state?.status, "paused");
    assert.equal(saved.at(-1)?.state?.objective, "Old objective");
    assert.equal(saved.at(-1)?.state?.result, "Goal could not be replaced: replacement write failed");
    assert.equal(fixture.provider.requests.length, 2, "The replacement objective must not reach the provider");
    const afterRaw = readFileSync(String(fixture.sessionFile), "utf8");
    assert.ok(afterRaw.startsWith(originalRaw), "Only later successful appends may follow the pre-failure session bytes");
    const durable = sessionGoalEntries(fixture.sessionFile);
    assert.equal(durable.some(entry => entry.event === "replace"), false, "The denied replacement write must not be durable");
    assert.equal(durable.some(entry => entry.state?.objective === "New objective"), false);
    assert.equal(durable.at(-1)?.event, "error", "The durable session records the pause, not the replacement");
    const statusCursor = await scenarioRpcPrompt(fixture, "/goal", signal);
    assert.match(await scenarioRpcNotice(fixture, statusCursor, /Goal paused/u, signal), /Old objective/u);
    await closeGoalScenarioProcess(fixture);
    assert.equal(fixture.provider.requests.length, 2, "Shutdown must not dispatch either objective after replacement failure");
    assert.deepEqual(sessionGoalEntries(fixture.sessionFile), durable);
    assertGoalAppendFaultAdapter(fixture, String(fixture.sessionFile), processId);
  });

  for (const status of ["paused", "blocked"] as const) {
    const objective = `Original ${status} objective`;
    const now = Date.now();
    const state = { version: 1, revision: 3, objective, status, createdAt: now, updatedAt: now,
      activeMilliseconds: 0, turns: 3, blockedAuditStartTurn: 0, baselineTokens: 0,
      ...(status === "blocked" ? { result: "Blocked result" } : {}) };
    await run(`${status}-replacement`, { session: { goal: { state, event: status } },
      faultMessage: `${status} replacement failed` }, async fixture => {
      const rpc = await launchGoalScenarioRpc(fixture, signal);
      assert.equal(fixture.provider.requests.length, 0);
      const before = sessionGoalEntries(fixture.sessionFile);
      const rawBefore = readFileSync(String(fixture.sessionFile), "utf8");
      const processId = scenarioProcessId(fixture);
      await setScenarioFault(fixture, true);
      const cursor = rpc.currentSequence;
      const replacement = promiseOutcome(rpc.command("prompt", { message: "/goal Replacement objective" }, { signal }));
      const confirmation = await rpc.waitFor(event => event.type === "extension_ui_request" && event.method === "confirm",
        { after: cursor, signal, timeoutMs: 20_000 });
      assert.equal(confirmation.title, "Replace active goal");
      assert.equal(typeof confirmation.id, "string");
      await rpc.send({ type: "extension_ui_response", id: confirmation.id, confirmed: true });
      const response = await replacement;
      assert.equal(response.kind, "resolved");
      const notice = await scenarioRpcNotice(fixture, cursor, new RegExp(`${status} replacement failed`, "u"), signal);
      assert.match(notice, /Goal could not be replaced/u);
      const saved = rpcGoalEntries(await scenarioRpcEntries(fixture, signal));
      assert.ok(saved.some(entry => entry.event === "replace" && entry.state?.objective === "Replacement objective"),
        `${status}: the replacement attempt must be visible in the live session view`);
      assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before,
        `${status}: the denied append leaves the durable saved goal untouched`);
      assert.ok(readFileSync(String(fixture.sessionFile), "utf8").startsWith(rawBefore));
      assert.equal(fixture.provider.requests.length, 0);
      const statusCursor = await scenarioRpcPrompt(fixture, "/goal", signal);
      const statusNotice = await scenarioRpcNotice(fixture, statusCursor, new RegExp(`Goal ${status}`, "u"), signal);
      assert.match(statusNotice, new RegExp(objective, "u"));
      await closeGoalScenarioProcess(fixture);
      assert.equal(fixture.provider.requests.length, 0, `${status}: failed replacement must never dispatch`);
      assert.deepEqual(sessionGoalEntries(fixture.sessionFile), before,
        `${status}: shutdown must preserve the original durable goal`);
      assertGoalAppendFaultAdapter(fixture, String(fixture.sessionFile), processId);
    });
  }

  await run("first-start", { session: {}, faultMessage: "first write failed" }, async fixture => {
    await launchGoalScenarioRpc(fixture, signal);
    const rawBefore = readFileSync(String(fixture.sessionFile), "utf8");
    const processId = scenarioProcessId(fixture);
    await setScenarioFault(fixture, true);
    const cursor = await scenarioRpcPrompt(fixture, "/goal New objective", signal);
    assert.match(await scenarioRpcNotice(fixture, cursor, /Goal could not be started: first write failed/u, signal),
      /Goal could not be started: first write failed/u);
    assert.ok(rpcGoalEntries(await scenarioRpcEntries(fixture, signal))
      .some(entry => entry.event === "set" && entry.state?.objective === "New objective"),
      "The denied start must be visible in the live session view");
    assert.deepEqual(sessionGoalEntries(fixture.sessionFile), [], "The denied start must not be durable");
    assert.equal(fixture.provider.requests.length, 0);
    assert.equal(readFileSync(String(fixture.sessionFile), "utf8").includes('"customType":"killeros-goal"'), false);
    assert.ok(readFileSync(String(fixture.sessionFile), "utf8").startsWith(rawBefore));
    const statusCursor = await scenarioRpcPrompt(fixture, "/goal", signal);
    assert.match(await scenarioRpcNotice(fixture, statusCursor, /No goal/u, signal), /No goal/u);
    await closeGoalScenarioProcess(fixture);
    assert.equal(fixture.provider.requests.length, 0, "A denied first write must never dispatch");
    assert.deepEqual(sessionGoalEntries(fixture.sessionFile), [], "Shutdown must not persist the denied first goal");
    assertGoalAppendFaultAdapter(fixture, String(fixture.sessionFile), processId);
  });

  await run("edit", { session: {}, faultMessage: "edit write failed" }, async fixture => {
    const first = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "First step passed",
      nextAction: "Continue the original objective" }] }, { held: true });
    const followup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const rpc = await launchGoalScenarioRpc(fixture, signal);
    await scenarioRpcPrompt(fixture, "/goal Original objective", signal);
    await reached(first.started.promise, signal, "failed edit first turn");
    first.release.release();
    await reached(followup.started.promise, signal, "failed edit continuation");
    const processId = scenarioProcessId(fixture);
    const rawBefore = readFileSync(String(fixture.sessionFile), "utf8");
    await setScenarioFault(fixture, true);

    const cursor = rpc.currentSequence;
    const edit = promiseOutcome(rpc.command("prompt", { message: "/goal edit Revised objective" }, { signal }));
    const stateWhileHeld = await scenarioRpcState(fixture, signal);
    assert.equal(stateWhileHeld.isStreaming, true);
    followup.release.release();
    await scenarioRpcSettled(fixture, cursor, signal);
    const response = await edit;
    assert.equal(response.kind, "resolved");
    const notice = await scenarioRpcNotice(fixture, cursor, /Goal objective could not be updated: edit write failed/u, signal, "error");
    assert.match(notice, /Goal paused: Goal objective could not be updated: edit write failed/u);
    const saved = rpcGoalEntries(await scenarioRpcEntries(fixture, signal));
    assert.ok(saved.some(entry => entry.event === "edit" && entry.state?.objective === "Revised objective"),
      "The denied edit must be visible in the live session view");
    assert.equal(sessionGoalEntries(fixture.sessionFile).some(entry => entry.event === "edit"), false,
      "The denied edit must not be durable");
    assert.equal(saved.at(-1)?.state?.status, "paused");
    assert.equal(saved.at(-1)?.state?.objective, "Original objective");
    assert.equal(saved.at(-1)?.state?.result, "Goal objective could not be updated: edit write failed");
    assert.equal(saved.at(-1)?.state?.stopReason, "Goal objective could not be updated: edit write failed");
    assert.equal(fixture.provider.requests.length, 2);
    assert.ok(readFileSync(String(fixture.sessionFile), "utf8").startsWith(rawBefore));
    const statusCursor = await scenarioRpcPrompt(fixture, "/goal", signal);
    const statusNotice = await scenarioRpcNotice(fixture, statusCursor, /Goal paused/u, signal);
    assert.match(statusNotice, /Original objective/u);
    assert.match(statusNotice, /Reason · Goal objective could not be updated: edit write failed/u);
    await closeGoalScenarioProcess(fixture);
    const durableAfterClose = sessionGoalEntries(fixture.sessionFile);
    assert.equal(durableAfterClose.some(entry => entry.event === "edit"), false,
      "The denied edit must remain absent after orderly shutdown");
    assert.equal(durableAfterClose.at(-1)?.state?.objective, "Original objective");
    assert.equal(durableAfterClose.at(-1)?.state?.status, "paused");
    assertGoalAppendFaultAdapter(fixture, String(fixture.sessionFile), processId);
  });

  assert.deepEqual(totals, { piLaunches: 5, providerRequests: 4, naturalExits: 5 });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.persistence-failures", histories: 5, ...totals,
    adapter: "one owned append denied, unrelated appends forwarded, original restored at session_shutdown" }));
});

test("editing preserves identity, status, and the current proof contract", { timeout: 300_000 }, async t => {
  const totals = { piLaunches: 0, providerRequests: 0, naturalExits: 0 };
  const run = async (label: string, options: GoalScenarioOptions, exercise: (fixture: GoalScenarioFixture) => Promise<void>) => {
    const summary = await runGoalScenarioHistory(t, "goals.edit", label, options, exercise);
    totals.piLaunches += summary.piLaunches;
    totals.providerRequests += summary.providerRequests;
    totals.naturalExits += summary.naturalExits;
  };
  const signal = t.signal;

  await run("active-edit-after-continue", { session: {} }, async fixture => {
    const first = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "First step passed",
      nextAction: "Run the next step" }] }, { held: true });
    const firstFollowup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const activeTurn = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "Second step passed",
      nextAction: "Finish the original objective" }] }, { held: true });
    const activeFollowup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const editedContinuation = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const rpc = await launchGoalScenarioRpc(fixture, signal);
    const objective = "Original objective";
    const revised = "Revised objective";
    await scenarioRpcPrompt(fixture, `/goal ${objective}`, signal);
    await reached(first.started.promise, signal, "active edit first turn");
    assert.ok(scenarioToolNames(first.body).includes("killeros_goal_update"));
    first.release.release();
    await reached(firstFollowup.started.promise, signal, "active edit first continuation");
    firstFollowup.release.release();
    // An active goal dispatches its authorized next turn right after settling, so a mid-goal
    // settle is never idle-observable. The next turn reaching the provider is the barrier
    // that proves the previous run settled.
    await reached(activeTurn.started.promise, signal, "active edit second goal turn");

    const before = sessionGoalEntries(fixture.sessionFile).at(-1)?.state;
    assert.ok(before);
    assert.equal(before.status, "active");
    assert.equal(before.turns, 2);
    assert.ok(before.lastDecision);
    assert.ok(before.lastContinueReport);
    const continuationCount = goalContinuations(String(fixture.sessionFile)).length;
    const editCursor = rpc.currentSequence;
    const editing = promiseOutcome(rpc.command("prompt", { message: `/goal edit ${revised}` }, { signal }));
    const stateWhileHeld = await scenarioRpcState(fixture, signal);
    assert.equal(stateWhileHeld.isStreaming, true, "The public RPC state confirms the edit arrived during the active turn");
    activeTurn.release.release();
    await reached(activeFollowup.started.promise, signal, "active edit second continuation");
    const acceptedDuringEdit = toolResult(await scenarioRpcEntries(fixture, signal), "audit-3-0");
    assert.equal(acceptedDuringEdit.isError, false);
    assert.equal(record(acceptedDuringEdit.details).status, "continue");
    assert.equal(record(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.turnDecision).evidence, "Second step passed");
    activeFollowup.release.release();
    // The edit command holds continuation during the active turn and returns only after that
    // turn settles and the objective update is persisted; that resolution is the settlement
    // barrier here, and the edited goal's own continuation request proves it dispatched.
    const response = await editing;
    assert.equal(response.kind, "resolved");
    if (response.kind === "resolved") assert.equal(record(response.value.data).disposition, "handled");
    assert.match(await scenarioRpcNotice(fixture, editCursor, /Goal objective updated/u, signal), /Goal objective updated/u);
    await reached(editedContinuation.started.promise, signal, "edited goal continuation");
    assert.ok(scenarioToolNames(editedContinuation.body).includes("killeros_goal_update"));
    assert.match(scenarioMessageText(editedContinuation.body), /Active KillerOS goal/u);
    assert.match(scenarioMessageText(editedContinuation.body), new RegExp(revised, "u"));

    const goalEntries = sessionGoalEntries(fixture.sessionFile);
    const edit = goalEntries.filter(entry => entry.event === "edit").at(-1);
    assert.ok(edit?.state);
    const edited = edit.state;
    assert.equal(edited.objective, revised);
    assert.equal(edited.status, "active");
    assert.equal(edited.turns, before.turns);
    assert.equal(edited.createdAt, before.createdAt);
    assert.equal(edited.maxTurns, before.maxTurns);
    assert.ok(typeof edited.revision === "number" && typeof before.revision === "number");
    assert.ok(edited.revision > before.revision);
    assert.equal(edited.turnDecision, undefined);
    assert.equal(edited.lastDecision, undefined);
    assert.equal(edited.lastContinueReport, undefined);
    assert.equal(edited.blockerAudit, undefined);
    assert.equal(edited.turnPhase, "ready");
    const continuations = goalContinuations(String(fixture.sessionFile));
    assert.equal(continuations.length, continuationCount + 1);
    assert.match(continuations.at(-1) ?? "", new RegExp(revised, "u"));
    assert.doesNotMatch(continuations.at(-1) ?? "", new RegExp(objective, "u"));
    const finalEditCursor = rpc.currentSequence;
    editedContinuation.release.release();
    await scenarioRpcSettled(fixture, finalEditCursor, signal);
    assert.equal(fixture.provider.requests.length, 5);
  });

  await run("paused-edit-clears-blocker-audit", { session: {} }, async fixture => {
    const first = fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "blocked", blockerKey: "missing-credential",
      evidence: "The credential is still unavailable" }] }, { held: true });
    const firstFollowup = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const activeTurn = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    const rpc = await launchGoalScenarioRpc(fixture, signal);
    await scenarioRpcPrompt(fixture, "/goal Original objective", signal);
    await reached(first.started.promise, signal, "paused edit blocker audit");
    first.release.release();
    await reached(firstFollowup.started.promise, signal, "paused edit blocker follow-up");
    const audit = toolResult(await scenarioRpcEntries(fixture, signal), "audit-1-0");
    assert.equal(audit.isError, false);
    assert.equal(record(audit.details).status, "blocker-audit");
    assert.equal(record(audit.details).streak, 1);
    firstFollowup.release.release();
    // Same settlement barrier as the active edit: the paused pause dispatch follows the
    // audit decision, and the barrier is the next turn reaching the provider.
    await reached(activeTurn.started.promise, signal, "paused edit active request");

    const pauseCursor = rpc.currentSequence;
    const pausing = promiseOutcome(rpc.command("prompt", { message: "/goal pause" }, { signal }));
    await scenarioRpcState(fixture, signal);
    await reached(activeTurn.closed.promise, signal, "paused edit request cancellation");
    const pausedNotice = await scenarioRpcNotice(fixture, pauseCursor, /Goal paused/u, signal);
    assert.match(pausedNotice, /Goal paused/u);
    await scenarioRpcSettled(fixture, pauseCursor, signal);
    const pauseResponse = await pausing;
    assert.equal(pauseResponse.kind, "resolved");
    const paused = sessionGoalEntries(fixture.sessionFile).at(-1)?.state;
    assert.ok(paused);
    assert.equal(paused.status, "paused");
    assert.equal(record(paused.blockerAudit).streak, 1);
    const requestCount = fixture.provider.requests.length;
    const editCursor = await scenarioRpcPrompt(fixture, "/goal edit Revised objective", signal);
    assert.match(await scenarioRpcNotice(fixture, editCursor, /Goal objective updated/u, signal), /goal is paused/u);
    const edit = sessionGoalEntries(fixture.sessionFile).filter(entry => entry.event === "edit").at(-1)?.state;
    assert.ok(edit);
    assert.equal(edit.status, "paused");
    assert.equal(edit.objective, "Revised objective");
    assert.equal(edit.blockerAudit, undefined);
    assert.equal(edit.blockedAuditStartTurn, edit.turns);
    assert.equal(fixture.provider.requests.length, requestCount, "Editing a paused goal must not continue it");
    assert.equal(fixture.provider.requests.length, 3);
    assert.equal(rpcGoalEntries(await scenarioRpcEntries(fixture, signal)).at(-1)?.state?.status, "paused");
  });

  await run("edit-fallback-and-bare-edit", { session: {} }, async fixture => {
    const request = fixture.provider.enqueue({ kind: "stop" }, { held: true });
    await launchGoalScenarioRpc(fixture, signal);
    assert.deepEqual(sessionGoalEntries(fixture.sessionFile), []);
    const bareCursor = await scenarioRpcPrompt(fixture, "/goal edit", signal);
    assert.equal(await scenarioRpcNotice(fixture, bareCursor, /^Provide the new objective: \/goal edit <objective>$/u, signal, "error"),
      "Provide the new objective: /goal edit <objective>");
    assert.deepEqual(sessionGoalEntries(fixture.sessionFile), []);
    assert.equal(fixture.provider.requests.length, 0);

    const fallbackCursor = await scenarioRpcPrompt(fixture, "/goal edit the file", signal);
    assert.match(await scenarioRpcNotice(fixture, fallbackCursor, /Goal started/u, signal), /Goal started/u);
    await reached(request.started.promise, signal, "edit fallback goal request");
    assert.equal(sessionGoalEntries(fixture.sessionFile).find(entry => entry.event === "set")?.state?.objective, "edit the file");
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.event, "turn");
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.objective, "edit the file");
    request.release.release();
    await scenarioRpcSettled(fixture, fallbackCursor, signal);
    assert.equal(fixture.provider.requests.length, 1);
  });

  await run("file-rebaseline-and-file-to-prose", { session: {} }, async fixture => {
    const deliverableA = path.join(fixture.directory, "A.md");
    const targetY = path.join(fixture.directory, "Y.md");
    writeFileSync(deliverableA, "original A");
    writeFileSync(targetY, "original Y");
    const plans = [
      fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "Started A", nextAction: "Edit A" }] }, { held: true }),
      fixture.provider.enqueue({ kind: "stop" }, { held: true }),
      fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "Updated A", nextAction: "Edit the new target" }] }, { held: true }),
      fixture.provider.enqueue({ kind: "stop" }, { held: true }),
      fixture.provider.enqueue({ kind: "complete", evidence: "Check the new deliverable" }, { held: true }),
      fixture.provider.enqueue({ kind: "complete", evidence: "The changed new deliverable is verified" }, { held: true }),
      fixture.provider.enqueue({ kind: "stop" }, { held: true }),
      fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "Started a second file goal",
        nextAction: "Continue the file goal" }] }, { held: true }),
      fixture.provider.enqueue({ kind: "stop" }, { held: true }),
      fixture.provider.enqueue({ kind: "calls", decisions: [{ status: "continue", evidence: "Second file goal progress",
        nextAction: "Finish the second file goal" }] }, { held: true }),
      fixture.provider.enqueue({ kind: "stop" }, { held: true }),
      fixture.provider.enqueue({ kind: "complete", evidence: "The prose objective is verified" }, { held: true }),
      fixture.provider.enqueue({ kind: "stop" }, { held: true }),
    ];
    const rpc = await launchGoalScenarioRpc(fixture, signal);

    await scenarioRpcPrompt(fixture, `/goal Write the Markdown file to \`${deliverableA}\``, signal);
    await reached(plans[0].started.promise, signal, "file-to-file original goal");
    const original = sessionGoalEntries(fixture.sessionFile).at(-1)?.state;
    assert.ok(original);
    assert.equal(record(original.verification).path, deliverableA);
    writeFileSync(deliverableA, "changed A");
    plans[0].release.release();
    await reached(plans[1].started.promise, signal, "file-to-file original follow-up");
    plans[1].release.release();
    await reached(plans[2].started.promise, signal, "file-to-file edit turn");

    const editCursor = rpc.currentSequence;
    const editing = promiseOutcome(rpc.command("prompt", { message: `/goal edit Update \`${targetY}\`` }, { signal }));
    await scenarioRpcState(fixture, signal);
    plans[2].release.release();
    await reached(plans[3].started.promise, signal, "file-to-file edit follow-up");
    plans[3].release.release();
    const editResponse = await editing;
    assert.equal(editResponse.kind, "resolved");
    assert.match(await scenarioRpcNotice(fixture, editCursor, /Goal objective updated/u, signal), /Goal objective updated/u);
    await reached(plans[4].started.promise, signal, "edited file completion attempt");
    const fileEdit = sessionGoalEntries(fixture.sessionFile).filter(entry => entry.event === "edit").at(-1)?.state;
    assert.ok(fileEdit);
    assert.equal(fileEdit.objective, `Update \`${targetY}\``);
    const newVerification = record(fileEdit.verification);
    assert.equal(newVerification.kind, "file");
    assert.equal(newVerification.path, targetY);
    const oldPath = record(original.verification).path;
    assert.equal(oldPath, deliverableA);

    plans[4].release.release();
    await reached(plans[5].started.promise, signal, "failed file proof returned to model");
    const failedTool = toolResult(await scenarioRpcEntries(fixture, signal), "goal-complete-5");
    assert.equal(failedTool.isError, true);
    const proofError = toolContentText(failedTool);
    assert.match(proofError, /has not changed since the goal started/u);
    assert.ok(proofError.includes(targetY));
    assert.equal(proofError.includes(deliverableA), false);
    assert.equal(sessionGoalEntries(fixture.sessionFile).at(-1)?.state?.status, "active");
    // Earlier objectives remain in the transcript; only the latest goal directive must replace A.
    const currentDirective = records(plans[5].body?.messages).flatMap(message => {
      const text = typeof message.content === "string" ? message.content
        : Array.isArray(message.content) ? records(message.content)
          .flatMap(part => typeof part.text === "string" ? [part.text] : []).join("\n") : "";
      return text.includes("# KillerOS long-running goal turn") ? [text] : [];
    }).at(-1);
    assert.ok(typeof currentDirective === "string");
    assert.ok(currentDirective.includes(targetY));
    assert.equal(currentDirective.includes(deliverableA), false);
    writeFileSync(targetY, "re-baselined deliverable");
    plans[5].release.release();
    await reached(plans[6].started.promise, signal, "file completion follow-up");
    const completedTool = toolResult(await scenarioRpcEntries(fixture, signal), "goal-complete-6");
    assert.equal(completedTool.isError, false);
    assert.equal(record(completedTool.details).status, "complete");
    assert.equal(record(completedTool.details).verification, "file");
    const fileCompletionCursor = rpc.currentSequence;
    plans[6].release.release();
    await scenarioRpcSettled(fixture, fileCompletionCursor, signal);
    const completedFileGoal = sessionGoalEntries(fixture.sessionFile).filter(entry => entry.event === "complete").at(-1)?.state;
    assert.ok(completedFileGoal);
    assert.equal(completedFileGoal.status, "complete");
    assert.equal(record(completedFileGoal.verification).path, targetY);

    await scenarioRpcPrompt(fixture, `/goal Write the Markdown file to \`${deliverableA}\``, signal);
    await reached(plans[7].started.promise, signal, "file-to-prose original goal");
    const proseOriginal = sessionGoalEntries(fixture.sessionFile).at(-1)?.state;
    assert.ok(proseOriginal);
    assert.equal(record(proseOriginal.verification).kind, "file");
    assert.equal(record(proseOriginal.verification).path, deliverableA);
    plans[7].release.release();
    await reached(plans[8].started.promise, signal, "file-to-prose first follow-up");
    plans[8].release.release();
    await reached(plans[9].started.promise, signal, "file-to-prose active goal turn");

    const proseEditCursor = rpc.currentSequence;
    const proseEdit = promiseOutcome(rpc.command("prompt", { message: "/goal edit Improve the error messages" }, { signal }));
    await scenarioRpcState(fixture, signal);
    plans[9].release.release();
    await reached(plans[10].started.promise, signal, "file-to-prose edit follow-up");
    plans[10].release.release();
    const proseEditResponse = await proseEdit;
    assert.equal(proseEditResponse.kind, "resolved");
    assert.match(await scenarioRpcNotice(fixture, proseEditCursor, /Goal objective updated/u, signal), /Goal objective updated/u);
    await reached(plans[11].started.promise, signal, "prose completion");
    const proseEditEntry = sessionGoalEntries(fixture.sessionFile).filter(entry => entry.event === "edit").at(-1)?.state;
    assert.ok(proseEditEntry);
    assert.equal(proseEditEntry.objective, "Improve the error messages");
    assert.equal(proseEditEntry.verification, undefined);
    plans[11].release.release();
    await reached(plans[12].started.promise, signal, "prose completion follow-up");
    const proseCompletion = toolResult(await scenarioRpcEntries(fixture, signal), "goal-complete-12");
    assert.equal(proseCompletion.isError, false);
    assert.equal(record(proseCompletion.details).status, "complete");
    assert.equal(record(proseCompletion.details).verification, "model-reported");
    const proseCompletionCursor = rpc.currentSequence;
    plans[12].release.release();
    await scenarioRpcSettled(fixture, proseCompletionCursor, signal);
    const completedProseGoal = sessionGoalEntries(fixture.sessionFile).filter(entry => entry.event === "complete").at(-1)?.state;
    assert.ok(completedProseGoal);
    assert.equal(completedProseGoal.status, "complete");
    assert.equal(completedProseGoal.verification, undefined);
    assert.equal(record(completedProseGoal.lastDecision).verification, "model-reported");
    assert.equal(fixture.provider.requests.length, 13);
  });

  assert.deepEqual(totals, { piLaunches: 4, providerRequests: 22, naturalExits: 4 });
  t.diagnostic(JSON.stringify({ scenarioId: "goals.edit", histories: 4, inputVectors: 6, ...totals,
    fixtureGitLaunches: 0 }));
});
