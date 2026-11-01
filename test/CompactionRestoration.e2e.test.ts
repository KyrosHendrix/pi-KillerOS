import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const histories = ["marker-compaction", "marker-only", "compaction-first", "later-transition", "malformed-active"] as const;
type History = typeof histories[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}
function entries(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

const observer = String.raw`import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const session = process.env.RESTORATION_SESSION;
const log = process.env.RESTORATION_OBSERVER;
const attempt = process.env.RESTORATION_WRITE_ATTEMPT;
const append = fs.appendFileSync.bind(fs);
const restoreAppend = fs.appendFileSync;
if (process.env.RESTORATION_DENY_GOAL_WRITE === "1") {
  fs.appendFileSync = function(file, data, ...args) {
    if (typeof file === "string" && path.resolve(file).toLowerCase() === session.toLowerCase()
      && String(data).includes('"customType":"killeros-goal"')) {
      append(attempt, JSON.stringify({ pid: process.pid, operation: "appendFileSync", file }) + "\n");
      throw new Error("session storage unavailable");
    }
    return append(file, data, ...args);
  };
  syncBuiltinESMExports();
  fs.writeFileSync(process.env.RESTORATION_ADAPTER_READY, JSON.stringify({ pid: process.pid,
    operation: "appendFileSync", file: session, error: "session storage unavailable" }));
}
export default function(pi) {
  let compacting = false;
  pi.registerCommand("restoration-state", { description: "Observe restoration without starting a turn", handler: async (label, ctx) => {
    fs.writeFileSync(process.env.RESTORATION_STATE, JSON.stringify({ label, mode: ctx.mode,
      isStreaming: !ctx.isIdle(), isCompacting: compacting, pendingMessageCount: ctx.hasPendingMessages() ? 1 : 0,
      entries: ctx.sessionManager.getEntries(), branch: ctx.sessionManager.getBranch() }));
    ctx.ui.notify("Restoration observed " + label, "info");
  }});
  pi.registerCommand("restoration-control", { description: "Prove the owned storage fault rejects public appendEntry", handler: async (_args, ctx) => {
    pi.appendEntry("restoration-forwarding-control", { forwarded: true });
    let error;
    try { pi.appendEntry("killeros-goal", { positiveControl: true }); }
    catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
    fs.writeFileSync(process.env.RESTORATION_CONTROL, JSON.stringify({ error, session: ctx.sessionManager.getSessionFile() }));
    if (ctx.mode === "tui") ctx.ui.notify("Restoration control complete", "info");
  }});
  for (const name of ["session_start", "session_before_compact", "session_compact", "agent_start", "agent_settled", "session_shutdown"]) {
    pi.on(name, (event, ctx) => {
      if (name === "session_before_compact") compacting = true;
      if (name === "session_compact") compacting = false;
      append(log, JSON.stringify({ type: name, mode: ctx.mode,
        reason: event.reason, idle: ctx.isIdle(), pending: ctx.hasPendingMessages() }) + "\n");
    });
  }
  pi.on("session_shutdown", () => {
    try { append(log, JSON.stringify({ type: "adapter_restored" }) + "\n"); }
    finally { fs.appendFileSync = restoreAppend; syncBuiltinESMExports(); }
  });
}
`;

async function runHistory(history: History, mode: "rpc" | "tui", t: TestContext): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(path.join(tmpdir(), ".killeros-compaction-restore-"));
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const sessions = path.join(directory, "sessions");
  for (const folder of [project, agent, sessions]) mkdirSync(folder);
  const observerFile = path.join(directory, "observer.jsonl");
  const writeAttempt = path.join(directory, "write-attempt.json");
  const adapterReady = path.join(directory, "adapter-ready.json");
  const stateFile = path.join(directory, "state.json");
  const controlFile = path.join(directory, "control.json");
  const requests: Record<string, unknown>[] = [];
  const faults: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576);
        chunks.push(Buffer.from(chunk));
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push(body);
      assert.equal(history, "marker-only", "Only the explicitly requested live manual summary may call a provider");
      assert.ok(requests.length <= 2, "Native split summarization may require at most two requests, never a recovery turn");
      assert.match(JSON.stringify(body.messages), /summar|checkpoint/iu, "Every request is native summarization, not a goal continuation");
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `summary-${requests.length}`, model: "local",
        choices: [{ index: 0, delta: { content: "## Goal\nPreserve the saved paused objective.\n## Progress\nHistorical work is retained.\n## Next steps\nWait for explicit user instructions." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(error);
      if (!response.destroyed && !response.writableEnded) { response.writeHead(500, { connection: "close" }); response.end("Restoration fixture failed"); }
    });
  });
  let rpc: PiRpcProcess | undefined;
  let terminal: PiTerminalProcess | undefined;
  let positiveControl = false;
  let controlAttemptBytes = "";
  const errors: unknown[] = [];
  let before = "";
  let after = "";
  let eventLog: Record<string, unknown>[] = [];
  let liveCompactions = 0;
  let sessionFile: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off", defaultThinkingLevel: "off",
      retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "restoration-local": {
      api: "openai-completions", apiKey: "restoration-fixture-only", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "local", name: "restoration local", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 2_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const session = SessionManager.create(project, sessions);
    session.appendModelChange("restoration-local", "local");
    session.appendThinkingLevelChange("off");
    const first = session.appendMessage({ role: "user", content: "Preserve the original saved work.", timestamp: Date.now() });
    const usage = { input: 2_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 2_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "Previous verified work. ".repeat(40) }],
      api: "openai-completions", provider: "restoration-local", model: "local", stopReason: "stop", usage, timestamp: Date.now() });
    const kept = session.appendMessage({ role: "user", content: "Keep the most recent historical request.", timestamp: Date.now() });
    session.appendMessage({ role: "assistant", content: [{ type: "text", text: "The latest historical request is saved." }],
      api: "openai-completions", provider: "restoration-local", model: "local", stopReason: "stop", usage, timestamp: Date.now() });
    const now = Date.now();
    const state = { version: 1, revision: 4, objective: "Resume the exact saved goal", status: "paused",
      createdAt: now - 60_000, updatedAt: now - 1_000, activeMilliseconds: 20_000, turns: 2,
      blockedAuditStartTurn: 0, baselineTokens: 0, resumeAfterManualCompaction: true };
    if (history === "compaction-first") session.appendCompaction("Preserved earlier work.", first, 80_000);
    session.appendCustomEntry("killeros-goal", { version: 1, event: "error", state: history === "malformed-active"
      ? { ...state, status: "active", activeStartedAt: now } : state });
    if (["marker-compaction", "later-transition", "malformed-active"].includes(history)) {
      session.appendCompaction("Continue with the first unfinished verification step.", kept, 80_000);
    }
    if (history === "later-transition") session.appendCustomEntry("killeros-goal", { version: 1, event: "pause",
      state: { ...state, revision: 5, resumeAfterManualCompaction: undefined } });
    sessionFile = session.getSessionFile();
    assert.ok(sessionFile && existsSync(sessionFile), "The historical file must be durable before launch");
    before = readFileSync(sessionFile, "utf8");
    const originalEntries = entries(before.trim().split(/\r?\n/u).slice(1).map((line): unknown => JSON.parse(line)));
    const extension = path.join(directory, "observer.mjs");
    writeFileSync(extension, observer);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory,
      PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
      RESTORATION_SESSION: sessionFile, RESTORATION_OBSERVER: observerFile, RESTORATION_WRITE_ATTEMPT: writeAttempt,
      RESTORATION_ADAPTER_READY: adapterReady,
      RESTORATION_STATE: stateFile, RESTORATION_CONTROL: controlFile,
      RESTORATION_DENY_GOAL_WRITE: history === "marker-compaction" ? "1" : "0" };
    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) env[key] = inherited.get(key.toLowerCase());
    const args = ["--model", "restoration-local/local", "--thinking", "off", "--tools", "killeros_goal_update",
        "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", extension, "--extension", repositoryRoot];
    if (mode === "rpc") rpc = new PiRpcProcess({ cliPath, cwd: project, env, args: ["--mode", "rpc", ...args] });
    else {
      terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 120, rows: 36, args: [cliPath, ...args] });
      await terminal.waitForScreen(screen => screen.includes("❯"), { signal: t.signal });
    }
    let observations = 0;
    const command = async (name: string): Promise<Record<string, unknown>> => {
      if (rpc) return record((await rpc.command(name, {}, { signal: t.signal, timeoutMs: 30_000 })).data);
      assert.ok(terminal);
      if (name === "compact") {
        await terminal.submitEditorText("/compact", { signal: t.signal });
        await terminal.waitForScreen(screen => /Compacted/iu.test(screen), { signal: t.signal, timeoutMs: 30_000 });
      }
      const label = String(++observations);
      await terminal.submitEditorText(`/restoration-state ${label}`, { signal: t.signal });
      await terminal.waitForScreen(screen => screen.includes(`Restoration observed ${label}`), { signal: t.signal });
      const state = record(JSON.parse(readFileSync(stateFile, "utf8")));
      assert.equal(state.label, label);
      assert.equal(state.mode, "tui");
      assert.deepEqual(state.branch, state.entries, "Every historical goal and compaction is on the native selected branch");
      assert.doesNotMatch(terminal.screen(), /could not be resumed|session storage unavailable|extension error/iu,
        "Native restoration must not display a recovery persistence error");
      return name === "compact" ? { summary: "Native TUI compaction completed" } : state;
    };
    const initial = await command("get_state");
    assert.equal(initial.isStreaming, false);
    assert.equal(initial.isCompacting, false);
    assert.equal(initial.pendingMessageCount, 0);
    assert.deepEqual(entries((await command("get_entries")).entries), originalEntries,
      "Startup must not append any goal, message, or compaction entry");
    assert.equal(requests.length, 0);
    assert.equal(readFileSync(sessionFile, "utf8"), before, "Restore must not rewrite or append to the original session");
    if (history === "marker-compaction") {
      const acknowledgement = record(JSON.parse(readFileSync(adapterReady, "utf8")));
      assert.equal(typeof acknowledgement.pid, "number");
      if (rpc) assert.equal(acknowledgement.pid, record(JSON.parse(rpc.diagnostics())).pid);
      assert.equal(acknowledgement.operation, "appendFileSync");
      assert.equal(acknowledgement.file, sessionFile);
      assert.equal(acknowledgement.error, "session storage unavailable");
    }
    if (history === "marker-only") {
      const compact = await command("compact");
      assert.equal(typeof compact.summary, "string");
      const final = await command("get_state");
      assert.equal(final.isStreaming, false);
      assert.equal(final.isCompacting, false);
      assert.equal(final.pendingMessageCount, 0);
      const finalEntries = entries((await command("get_entries")).entries);
      const added = finalEntries.slice(originalEntries.length);
      assert.equal(added.filter((entry) => entry.type === "compaction").length, 1);
      assert.equal(added.some((entry) => entry.type === "custom" && entry.customType === "killeros-goal"), false);
      assert.equal(added.some((entry) => entry.type === "custom_message" || entry.type === "message"), false,
        "A later live manual compaction cannot revive stale saved eligibility");
      liveCompactions = 1;
      assert.ok(requests.length >= 1 && requests.length <= 2);
    }
    after = readFileSync(sessionFile, "utf8");
    assert.ok(after.startsWith(before), "Native manual compaction may append, never rewrite, historical entries");
    const through = rpc?.currentSequence ?? 0;
    let cursor = 0;
    while (cursor < through) {
      assert.ok(rpc);
      const stored = await rpc.waitForRecord(() => true, { after: cursor, signal: t.signal });
      cursor = stored.sequence;
      assert.notEqual(stored.value.type, "agent_start", "Restoration and idle manual compaction grant no agent turn");
      assert.notEqual(stored.value.type === "extension_ui_request" && stored.value.method === "notify", true,
        "A restored goal with no live manual eligibility emits no notification");
    }
    rpc?.acknowledge(through);
    assert.equal(existsSync(writeAttempt), false, "No goal persistence was attempted through the acknowledged failure adapter");
    if (history === "marker-compaction") {
      // The positive control follows every denial oracle, so it cannot supply recovery evidence.
      if (rpc) await rpc.command("prompt", { message: "/restoration-control" }, { signal: t.signal });
      else {
        assert.ok(terminal);
        await terminal.submitEditorText("/restoration-control", { signal: t.signal });
        await terminal.waitForScreen(screen => screen.includes("Restoration control complete"), { signal: t.signal });
      }
      const control = record(JSON.parse(readFileSync(controlFile, "utf8")));
      assert.equal(control.error, "session storage unavailable");
      assert.equal(control.session, sessionFile);
      controlAttemptBytes = readFileSync(writeAttempt, "utf8");
      const attempt = record(JSON.parse(controlAttemptBytes));
      assert.equal(attempt.file, sessionFile);
      assert.equal(attempt.operation, "appendFileSync");
      assert.equal(attempt.pid, record(JSON.parse(readFileSync(adapterReady, "utf8"))).pid);
      const controlled = readFileSync(sessionFile, "utf8");
      assert.ok(controlled.startsWith(after));
      const forwarded = entries(controlled.slice(after.length).trim().split(/\r?\n/u).map((line): unknown => JSON.parse(line)));
      assert.equal(forwarded.length, 1, "The adapter must forward only the unrelated public append and reject the goal append");
      assert.equal(record(forwarded[0]).customType, "restoration-forwarding-control");
      assert.deepEqual(record(forwarded[0]).data, { forwarded: true });
      after = controlled;
      positiveControl = true;
    }
  } catch (error) { errors.push(error); }
  if (rpc) {
    try { assert.deepEqual(await rpc.close(), { exit: { code: 0, signal: null }, forced: false }); }
    catch (error) { errors.push(error); }
  }
  if (terminal) {
    try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics()); }
    catch (error) { errors.push(error); }
  }
  try {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    assert.deepEqual(faults, []);
    if (rpc) {
      const acknowledged = record(JSON.parse(rpc.diagnostics())).acknowledgedSequence;
      assert.ok(typeof acknowledged === "number");
      let cursor = acknowledged;
      while (cursor < rpc.currentSequence) {
        const stored = await rpc.waitForRecord(() => true, { after: cursor, signal: t.signal });
        cursor = stored.sequence;
        assert.notEqual(stored.value.type, "agent_start", "Shutdown must not start delayed recovery");
        assert.notEqual(stored.value.type, "extension_error", "Extension errors must not masquerade as denied recovery");
        assert.notEqual(stored.value.type === "extension_ui_request" && stored.value.method === "notify", true);
      }
      rpc.acknowledge(cursor);
    }
    assert.equal(requests.length, history === "marker-only" ? 2 : 0,
      "Orderly exit must leave exactly the native split summaries and no recovery or retry request");
    assert.ok(sessionFile);
    assert.equal(readFileSync(sessionFile, "utf8"), after, "Shutdown must not persist delayed recovery work");
    assert.equal(existsSync(writeAttempt), positiveControl, "Only the explicit positive control may reach the installed fault adapter");
    if (positiveControl) assert.equal(readFileSync(writeAttempt, "utf8"), controlAttemptBytes, "Shutdown must not attempt another denied write");
    if (existsSync(observerFile)) eventLog = readFileSync(observerFile, "utf8").trim().split(/\r?\n/u).map((line) => record(JSON.parse(line)));
    assert.equal(eventLog.filter((event) => event.type === "session_start").length, 1);
    assert.equal(eventLog.filter((event) => event.type === "session_shutdown").length, 1);
    assert.equal(eventLog.filter((event) => event.type === "adapter_restored").length, 1);
    assert.equal(eventLog.filter((event) => event.type === "agent_start" || event.type === "agent_settled").length, 0);
    assert.equal(eventLog.filter((event) => event.type === "session_compact").length, liveCompactions);
  } catch (error) { errors.push(error); }
  if (errors.length) throwScenarioFailure({ directory, message: `Compaction restoration ${history} failed`, errors,
    diagnostics: JSON.stringify({ history, mode, requests, eventLog, before, after, rpc: rpc?.diagnostics(), terminal: terminal?.diagnostics() }) });
  await removeDirectoryEventually(directory);
  assert.equal(existsSync(directory), false);
  return { history, mode, positiveControl, piLaunches: 1, providerRequests: requests.length, liveCompactions, naturalExit: true, scratchRemoved: true };
}

// Catalog ID: compaction-restored-session-recovery-denial.
test("Restored sessions never infer manual-recovery eligibility from persisted history", { timeout: 180_000 }, async (t) => {
  const observations: Record<string, unknown>[] = [];
  for (const mode of ["rpc", "tui"] as const) {
    for (const history of histories) observations.push(await runHistory(history, mode, t));
  }
  assert.equal(observations.length, 10);
  t.diagnostic(JSON.stringify({ scenarioId: "compaction-restored-session-recovery-denial", piLaunches: 10, observations }));
});
