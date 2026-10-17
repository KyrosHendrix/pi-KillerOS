import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { passiveGitCommand, passiveGitEnv } from "../killeros/passive-git-status.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const personalMarker = "KILLEROS_STARTUP_PERSONAL_INSTRUCTIONS";
const setupMarker = "KILLEROS_STARTUP_SYSTEM_SECTION";
const queuedMarker = "KILLEROS_STARTUP_QUEUED_NOTE";
const piVersion = record(JSON.parse(readFileSync(path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"))).version;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map(record);
}

function goalState(entries: Record<string, unknown>[]): Record<string, unknown> {
  const entry = entries.filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
  assert.ok(entry);
  return record(record(entry.data).state);
}

for (const [scenario, trusted] of [
  ["continuation", true], ["startup abort", true],
  ["continuation", false], ["startup abort", false],
] as const) {
  test(`installed Pi startup preserves ${scenario}, ${trusted ? "trusted" : "untrusted"} instructions, and reload`, {
    timeout: 60_000, skip: piRpcShutdownSkip,
  }, async (t) => {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-startup-"));
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    const probe = path.join(directory, "probe.ts");
    const session = path.join(directory, "session.jsonl");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const env: NodeJS.ProcessEnv = {
      HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: directory, TMP: directory, PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    };
    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) {
      const value = inherited.get(key.toLowerCase());
      if (value !== undefined) env[key] = value;
    }
    const emptyGitConfig = path.join(directory, "empty-git-config");
    writeFileSync(emptyGitConfig, "");
    Object.assign(env, { GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_SYSTEM: emptyGitConfig, GIT_CONFIG_NOSYSTEM: "1" });
    const git = passiveGitCommand(cwd, env);
    assert.ok(git);
    execFileSync(git, ["init", "--quiet"], { cwd, env: passiveGitEnv(env), timeout: 15_000 });
    writeFileSync(path.join(cwd, "AGENTS.local.md"), personalMarker);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      cacheWarming: "off", compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 }, retry: { enabled: false },
    }));
    writeFileSync(probe, `
import { writeFileSync } from "node:fs";
export default function (pi) {
  let cancelNext = false;
  pi.on("session_before_compact", (event) => {
    writeFileSync(${JSON.stringify(path.join(agentDir, "killeros.json"))}, JSON.stringify({autoCompaction:{enabled:false,percentRemaining:100}}));
    return {compaction:{summary:"Startup ordinary-task summary", firstKeptEntryId:event.preparation.firstKeptEntryId, tokensBefore:event.preparation.tokensBefore}};
  });
  pi.on("session_compact", () => { pi.appendEntry("startup-compaction", {saved:true}); });
  pi.registerCommand("prime-startup", { description: "Prime the next run", handler: async () => {
    cancelNext = ${scenario === "startup abort"};
    pi.sendMessage({customType:"startup-queued-note", content:${JSON.stringify(queuedMarker)}, display:false}, {deliverAs:"nextTurn"});
  }});
  pi.registerCommand("startup-reload", { description: "Reload the real extension runtime", handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.on("before_agent_start", (event, ctx) => {
    pi.appendEntry("startup-probe", {messageType:event.messageType, idle:ctx.isIdle()});
    if (cancelNext) { cancelNext = false; ctx.abort(); }
    return {systemPrompt:event.systemPrompt + "\\n" + ${JSON.stringify(setupMarker)},
      message:{customType:"startup-handler-note", content:"Startup handler ran", display:false}};
  });
}
`);
    let rpc: PiRpcProcess | undefined;
    let ordinary = false;
    let ordinaryRequests = 0;
    let finalTurnAfter = 0;
    const requests: Array<{ ordinary: boolean; roles: unknown[]; personalCount: number }> = [];
    const faults: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.equal(request.headers.authorization, "Bearer local-startup-key");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          assert.ok(chunk instanceof Uint8Array);
          size += chunk.length;
          assert.ok(size <= 1_048_576);
          chunks.push(Buffer.from(chunk));
        }
        const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const messages = records(body.messages);
        const text = JSON.stringify(messages);
        const step = requests.length;
        const personalCount = text.split(personalMarker).length - 1;
        requests.push({ ordinary, roles: messages.map((message) => message.role), personalCount });
        assert.equal(personalCount, trusted ? 1 : 0,
          "Personal instructions must appear once in trusted projects and never in untrusted projects, including after tool calls");
        assert.equal(text.split(setupMarker).length - 1, 1, "Custom-run system setup must survive tool follow-ups");
        if (step === 0 && scenario === "continuation") assert.ok(text.includes(queuedMarker), "The custom run must receive pending nextTurn messages");
        assert.ok(rpc);
        if (ordinary || step % 2 === 0) finalTurnAfter = rpc.currentSequence;
        const continued = scenario === "continuation" && step === 0;
        const tools = body.tools === undefined ? [] : records(body.tools).map((tool) => record(tool.function).name);
        let delta: Record<string, unknown>;
        let finishReason = "stop";
        if (ordinary) {
          assert.equal(tools.includes("killeros_goal_update"), false);
          ordinaryRequests++;
          assert.ok(ordinaryRequests <= (scenario === "continuation" ? 2 : 1), "Compaction may recover ordinary work only once");
          if (ordinaryRequests === 2) assert.ok(text.includes("Startup ordinary-task summary"));
          delta = { content: ordinaryRequests === 2 ? "Ordinary startup request resumed" : "Ordinary startup request finished" };
        } else if (step % 2 === 0) {
          assert.ok(step < (scenario === "continuation" ? 4 : 2), "No extra goal turn may start");
          assert.ok(tools.includes("killeros_goal_update"));
          const decision = continued
            ? { status: "continue", evidence: "First startup request verified", nextAction: "Verify the second request" }
            : { status: "complete", evidence: "All startup requests verified" };
          delta = { tool_calls: [{ index: 0, id: `startup-${step}`, type: "function", function: {
            name: "killeros_goal_update", arguments: JSON.stringify(decision),
          } }] };
          finishReason = "tool_calls";
        } else {
          assert.ok(messages.some((message) => message.role === "tool"));
          delta = { content: "Goal startup response finished" };
        }
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(`data: ${JSON.stringify({ id: `startup-${step}`, model: "local", choices: [{ index: 0, delta, finish_reason: finishReason }], usage: { prompt_tokens: 2_000, completion_tokens: 20, total_tokens: 2_020 } })}\n\ndata: [DONE]\n\n`);
      })().catch((error: unknown) => {
        faults.push(error instanceof Error ? error.message : String(error));
        if (!response.destroyed) {
          response.writeHead(500, { connection: "close" });
          response.end("Startup fixture rejected the request");
        }
      });
    });
    const cleanupFailures: unknown[] = [];
    let failure: unknown;
    try {
      await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
        "startup-local": {
          baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-startup-key",
          models: [{ id: "local", name: "Local startup check", reasoning: false, input: ["text"], contextWindow: 100_000,
            maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      } }));
      const owner = rpc = new PiRpcProcess({
        cliPath: path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd, env,
        args: ["--mode", "rpc", "--model", "startup-local/local", "--thinking", "off", "--tools", "killeros_goal_update",
          "--session", session, "--offline", trusted ? "--approve" : "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
          "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot, "--extension", probe],
      });
      const data = (response: PiRpcRecord): Record<string, unknown> => record(response.data);
      const entries = async (): Promise<Record<string, unknown>[]> => records(data(await owner.command("get_entries", {}, { signal: t.signal })).entries);
      await rpc.command("get_state", {}, { signal: t.signal });
      await rpc.command("prompt", { message: "/prime-startup" }, { signal: t.signal });
      const startedAfter = rpc.currentSequence;
      await rpc.command("prompt", { message: "/goal Verify startup lifecycle" }, { signal: t.signal });
      if (scenario === "startup abort") {
        const settled = await rpc.waitFor((event) => event.type === "agent_settled", { after: startedAfter, signal: t.signal });
        assert.equal(settled.aborted, true);
        assert.equal(requests.length, 0, "Aborting during setup must prevent provider work");
        assert.equal(goalState(await entries()).status, "paused");
        await rpc.command("prompt", { message: "/goal resume" }, { signal: t.signal });
      }
      await rpc.waitFor((event) => {
        if (event.type !== "entry_appended") return false;
        const entry = record(event.entry);
        return entry.type === "custom" && entry.customType === "killeros-goal" && record(entry.data).event === "complete";
      }, { after: startedAfter, signal: t.signal });
      await rpc.waitFor((event) => event.type === "agent_settled", { after: finalTurnAfter, signal: t.signal });
      const completed = await entries();
      assert.equal(goalState(completed).status, "complete");
      assert.equal(goalState(completed).turns, 2, "Custom startup must not double-count goal turns");
      assert.equal(requests.length, scenario === "continuation" ? 4 : 2);
      assert.deepEqual(faults, []);
      await rpc.command("prompt", { message: "/startup-reload" }, { signal: t.signal });
      assert.equal(goalState(await entries()).status, "complete");
      const beforeOrdinary = requests.length;
      ordinary = true;
      if (scenario === "continuation") {
        writeFileSync(path.join(agentDir, "killeros.json"), JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 100 } }));
        await rpc.command("set_auto_compaction", { enabled: true }, { signal: t.signal });
      }
      const ordinaryAfter = rpc.currentSequence;
      await rpc.command("prompt", { message: "Verify an ordinary request after reload" }, { signal: t.signal });
      const finalText = scenario === "continuation" ? "Ordinary startup request resumed" : "Ordinary startup request finished";
      await rpc.waitFor((event) => event.type === "agent_end" && records(event.messages).some((message) => message.role === "assistant"
        && records(message.content).some((part) => part.type === "text" && part.text === finalText)), { after: ordinaryAfter, signal: t.signal });
      await rpc.waitFor((event) => event.type === "agent_settled", { after: finalTurnAfter, signal: t.signal });
      assert.equal(requests.length, beforeOrdinary + (scenario === "continuation" ? 2 : 1));
      assert.equal(data(await rpc.command("get_state", {}, { signal: t.signal })).pendingMessageCount, 0);
      const finalEntries = await entries();
      assert.equal(goalState(finalEntries).turns, 2);
      const probes = finalEntries.filter((entry) => entry.type === "custom" && entry.customType === "startup-probe").map((entry) => record(entry.data));
      assert.deepEqual(probes.map((entry) => entry.messageType), scenario === "continuation" ? ["custom", "custom", "user", "custom"] : ["custom", "custom", "user"]);
      assert.equal(finalEntries.filter((entry) => entry.type === "custom" && entry.customType === "startup-compaction").length, scenario === "continuation" ? 1 : 0);
      assert.ok(probes.every((entry) => entry.idle === false), "Pi must remain busy throughout startup handlers");
      assert.deepEqual(faults, []);
    } catch (error) { failure = error; }
    finally {
      if (rpc) {
        try {
          const closed = await rpc.close();
          assert.equal(closed.exit.code, 0);
          assert.equal(closed.forced, false);
          assert.equal(closed.treeCleanupError, undefined);
        } catch (error) { cleanupFailures.push(error); }
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
    if (failure !== undefined || cleanupFailures.length) {
      throwScenarioFailure({ directory, message: `Pi startup ${scenario} failed with project trust ${trusted}`,
        errors: [...(failure === undefined ? [] : [failure]), ...cleanupFailures],
        diagnostics: JSON.stringify({ scenario, trusted, node: process.version, piVersion, requests, faults, rpc: rpc?.diagnostics() }),
      });
    }
    await removeDirectoryEventually(directory);
  });
}
