import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
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
type ToolTraceEvent =
  | { kind: "start" | "end"; toolName: string }
  | { kind: "question-result"; toolName: "question"; isError: true };

test("installed Pi restores saved tools without reviving goals", {
  timeout: 90_000, skip: piRpcShutdownSkip,
}, async (t) => {
  const directory = mkdtempSync(path.join(root, "node_modules/.killeros-restore-"));
  const cwd = path.join(directory, "project");
  const agentDir = path.join(directory, "agent");
  const probe = path.join(directory, "probe.ts");
  const session = path.join(directory, "session.jsonl");
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    TEMP: directory, TMP: directory, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) env[key] = inherited.get(key.toLowerCase());
  let expectedTools = ["read", "grep", "question"];
  let count = 0;
  const faults: string[] = [];
  const requestTools: string[][] = [];
  const toolTrace: ToolTraceEvent[] = [];
  let questionBarrierStartedTools: string[] | undefined;
  let resolveQuestionResult: ((startedTools: string[]) => void) | undefined;
  const questionResultObserved = new Promise<string[]>((resolve) => { resolveQuestionResult = resolve; });
  let releaseQuestionResult: (() => void) | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) { assert.ok(chunk instanceof Uint8Array); size += chunk.length; assert.ok(size <= 1_048_576); chunks.push(Buffer.from(chunk)); }
        const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (request.url === "/fixture-event") {
          const kind = body.kind;
          const toolName = body.toolName;
          if (typeof kind !== "string" || typeof toolName !== "string") throw new Error("Malformed fixture event");
        if (kind === "start" || kind === "end") {
          toolTrace.push({ kind, toolName });
        } else if (kind === "question-result") {
          assert.equal(toolName, "question");
          assert.ok(body.isError === true);
          toolTrace.push({ kind, toolName: "question", isError: true });
          const startedTools = toolTrace.filter(event => event.kind === "start").map(event => event.toolName);
          const released = new Promise<void>((resolve) => { releaseQuestionResult = resolve; });
          resolveQuestionResult?.(startedTools);
          await released;
        } else {
          assert.fail(`Unexpected fixture event: ${String(kind)}`);
        }
        response.writeHead(204, { connection: "close" });
        response.end();
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer restore-local-key");
      const names = records(body.tools).map(tool => String(record(tool.function).name)).sort();
      requestTools.push(names);
      assert.deepEqual(names, [...expectedTools].sort());
      const last = records(body.messages).at(-1); assert.ok(last);
      const lastText = typeof last.content === "string" ? last.content
        : records(last.content).map(part => { assert.ok(typeof part.text === "string"); return part.text; }).join("");
      let delta: Record<string, unknown> = { content: "Restored request finished" };
      let finish = "stop";
      if (names.includes("killeros_goal_update")) {
        delta = { tool_calls: [
          { index: 0, id: "restore-question", type: "function", function: { name: "question", arguments: JSON.stringify({
            question: "Confirm the restored tool decision flow", options: [{ label: "Continue" }],
          }) } },
          { index: 1, id: "restore-complete", type: "function", function: { name: "killeros_goal_update",
            arguments: JSON.stringify({ status: "complete", evidence: "Restored tool selection verified" }) } },
        ] };
        finish = "tool_calls";
        expectedTools = expectedTools.filter(name => name !== "killeros_goal_update");
      } else if (last.role === "user" && lastText === "Try nested decisions") {
        delta = { tool_calls: [{ index: 0, id: "restore-nested", type: "function", function: { name: "codemode", arguments: JSON.stringify({
          code: 'for (const name of ["question", "killeros_goal_update"]) { try { await tools[name]({}); text("Unexpected nested call"); } catch(error) { text(error.message); } }',
        }) } }] };
        finish = "tool_calls";
      }
      count++;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `restore-${count}`, model: "local", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(String(error));
      if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Rejected fixture request"); }
    });
  });
  let rpc: PiRpcProcess | undefined;
  const state = async () => {
    assert.ok(rpc);
    return record((await rpc.command("get_state", {}, { signal: t.signal })).data);
  };
  const assertIdle = async () => {
    const current = await state();
    assert.equal(current.isStreaming, false);
    assert.equal(current.isCompacting, false);
    assert.equal(current.pendingMessageCount, 0);
  };
  const entries = async () => { assert.ok(rpc); return records(record((await rpc.command("get_entries", {}, { signal: t.signal })).data).entries); };
  const run = async (message: string) => {
    assert.ok(rpc);
    const after = rpc.currentSequence;
    await rpc.command("prompt", { message }, { signal: t.signal });
    await rpc.waitFor(event => event.type === "agent_settled", { after, signal: t.signal });
    await assertIdle();
    assert.deepEqual(faults, []);
  };
  const runRestoredDecision = async (message: string) => {
    assert.ok(rpc);
    toolTrace.length = 0;
    const after = rpc.currentSequence;
    const prompt = rpc.command("prompt", { message }, { signal: t.signal });
    type PromptOutcome = { kind: "success" } | { kind: "failure"; error: unknown };
    const promptOutcome: Promise<PromptOutcome> = prompt.then(
      (): PromptOutcome => ({ kind: "success" }),
      (error: unknown): PromptOutcome => ({ kind: "failure", error }),
    );
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startedTools = await Promise.race([
        questionResultObserved,
        new Promise<never>((_resolve, reject) => {
          barrierTimer = setTimeout(() => reject(new Error("Question result barrier was not acknowledged")), 15_000);
        }),
      ]);
      questionBarrierStartedTools = startedTools;
      assert.deepEqual(startedTools, ["question"], "The following goal update must not start while the question result is held");
    } finally {
      if (barrierTimer !== undefined) clearTimeout(barrierTimer);
      const release = releaseQuestionResult;
      releaseQuestionResult = undefined;
      release?.();
    }
    const promptResult = await promptOutcome;
    if (promptResult.kind === "failure") throw promptResult.error;
    await rpc.waitFor(event => event.type === "agent_settled", { after, signal: t.signal });
    await assertIdle();
    assert.deepEqual(toolTrace, [
      { kind: "start", toolName: "question" },
      { kind: "question-result", toolName: "question", isError: true },
      { kind: "end", toolName: "question" },
      { kind: "start", toolName: "killeros_goal_update" },
      { kind: "end", toolName: "killeros_goal_update" },
    ]);
    assert.deepEqual(faults, []);
  };
  const close = async () => { if (!rpc) return; const closed = await rpc.close(); assert.equal(closed.forced, false); assert.equal(closed.exit.code, 0); assert.equal(closed.treeCleanupError, undefined); rpc = undefined; };
  const start = async (tools: string[] = []) => {
    rpc = new PiRpcProcess({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd, env,
      args: ["--mode", "rpc", "--model", "restore-local/local", "--thinking", "off", "--session", session, "--offline", "--no-approve",
        "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
        "--extension", root, "--extension", probe, "--extension", "builtin:codemode", ...tools] });
    await assertIdle();
  };
  const inventory = async (decisionsRegistered = true) => {
    assert.ok(rpc);
    const requestsBefore = count;
    await rpc.command("prompt", { message: "/restore-inspect" }, { signal: t.signal });
    await assertIdle();
    assert.equal(count, requestsBefore, "Tool inspection must not start provider work");
    const entry = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "restore-inventory").at(-1);
    assert.ok(entry);
    const data = record(entry.data);
    assert.deepEqual(records(data.tools).map(tool => [tool.name, tool.exposure]), decisionsRegistered
      ? [["killeros_goal_update", "model-only"], ["question", "model-only"]] : []);
    assert.ok(Array.isArray(data.active));
    const active: unknown[] = data.active;
    assert.ok(active.every(name => typeof name === "string"));
    assert.deepEqual([...active].sort(), [...expectedTools].sort());
  };
  let failure: { error: unknown } | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    mkdirSync(cwd); mkdirSync(agentDir);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read"], cacheWarming: "off",
      compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(probe, `export default function(pi) {
    pi.registerCommand("restore-loadout", {description:"Set native tools",handler:async()=>{pi.setActiveTools(["read","grep","question"]);}});
    pi.registerCommand("restore-inspect", {description:"Inspect native tools",handler:async()=>{pi.appendEntry("restore-inventory",{active:pi.getActiveTools(),tools:pi.getAllTools().filter(t=>["question","killeros_goal_update"].includes(t.name)).map(t=>({name:t.name,exposure:t.exposure}))});}});
    pi.registerCommand("restore-reload", {description:"Reload",handler:async(_args,ctx)=>{await ctx.reload();}});
    const fixtureUrl = process.env.RESTORATION_FIXTURE_URL;
    if (typeof fixtureUrl !== "string") throw new Error("RESTORATION_FIXTURE_URL is required");
    const report = async (event) => {
      const response = await fetch(fixtureUrl + "/fixture-event", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(event)});
      if (!response.ok) throw new Error("Fixture event endpoint returned " + response.status);
    };
    pi.on("tool_execution_start", event => report({kind:"start",toolName:event.toolName}));
    pi.on("tool_execution_end", event => report({kind:"end",toolName:event.toolName}));
    // Keep the real question result callback open until the parent acknowledges its start snapshot.
    pi.on("tool_result", event => event.toolName === "question" && event.parentToolCallId === undefined
      ? report({kind:"question-result",toolName:event.toolName,isError:event.isError}) : undefined);
  }`);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    env.RESTORATION_FIXTURE_URL = `http://127.0.0.1:${address.port}`;
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "restore-local": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "restore-local-key",
      models: [{ id: "local", name: "Restore local", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await start();
    assert.ok(rpc); await rpc.command("prompt", { message: "/restore-loadout" }, { signal: t.signal });
    await assertIdle();
    await run("Save native tools");
    assert.equal(count, 1);
    await close();
    expectedTools = ["grep", "question", "codemode"];
    await start(["--tools", "+codemode,-read"]);
    await inventory();
    assert.equal(count, 1, "Restoration and inspection must not start provider work");
    await run("Inspect restored tools");
    expectedTools.push("killeros_goal_update");
    await runRestoredDecision("/goal Verify restored loadout");
    const goal = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(goal); assert.equal(record(record(goal.data).state).status, "complete");
    assert.equal(record(record(goal.data).state).turns, 1);
    assert.ok(rpc);
    const decisionMessages = records(record((await rpc.command("get_messages", {}, { signal: t.signal })).data).messages);
    const questionResult = decisionMessages.find(message => message.role === "toolResult" && message.toolCallId === "restore-question");
    assert.ok(questionResult); assert.equal(questionResult.isError, true);
    assert.match(JSON.stringify(questionResult.content), /question tool requires interactive TUI/u);
    const completedRequests = count;
    assert.ok(rpc); await rpc.command("prompt", { message: "/restore-reload" }, { signal: t.signal });
    await inventory();
    assert.equal(count, completedRequests, "Native reload must not resume a completed goal");
    const reloadedGoal = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(reloadedGoal); assert.equal(record(record(reloadedGoal.data).state).status, "complete");
    assert.equal(record(record(reloadedGoal.data).state).turns, 1);
    await run("Try nested decisions");
    assert.ok(rpc); const messages = records(record((await rpc.command("get_messages", {}, { signal: t.signal })).data).messages);
    const nested = messages.find(message => message.role === "toolResult" && message.toolCallId === "restore-nested");
    assert.ok(nested); assert.equal(nested.isError, false);
    const output = JSON.stringify(nested.content);
    assert.match(output, /tools\.question does not exist/u); assert.match(output, /tools\.killeros_goal_update does not exist/u);
    assert.doesNotMatch(output, /Unexpected nested call/u);
    await close();
    expectedTools = ["read"];
    await start(["--tools", "read", "--exclude-tools", "killeros_*"]);
    await inventory(false);
    const before = count;
    assert.ok(rpc); await rpc.command("prompt", { message: "/goal Excluded restored goal" }, { signal: t.signal });
    await assertIdle();
    const excluded = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(excluded); assert.equal(record(record(excluded.data).state).status, "paused");
    assert.equal(record(record(excluded.data).state).turns, 0);
    assert.equal(count, before);
    await run("Explicit selection remains authoritative");
    assert.equal(count, 7);
    assert.deepEqual(faults, []);
  } catch (error) {
    failure = { error };
  } finally {
    try { await close(); } catch (error) { cleanupErrors.push(error); }
    if (server.listening) {
      try { server.closeAllConnections(); } catch (error) { cleanupErrors.push(error); }
      try {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      } catch (error) { cleanupErrors.push(error); }
    }
  }

  try {
    await removeDirectoryEventually(directory);
    assert.equal(existsSync(directory), false, "Remove the owned restoration project directory");
  } catch (error) { cleanupErrors.push(error); }

  const errors = [...(failure === undefined ? [] : [failure.error]), ...cleanupErrors];
  if (errors.length > 0) {
    let failureDirectory: string;
    try {
      failureDirectory = mkdtempSync(path.join(root, "node_modules", ".killeros-runtime.tool-restoration-"));
    } catch (error) {
      throw new AggregateError([...errors, error], "runtime.tool-restoration could not create failure evidence");
    }
    try {
      throwScenarioFailure({
        directory: failureDirectory,
        message: "Saved tool restoration failed",
        errors,
        diagnostics: JSON.stringify({ node: process.version, requests: count, requestTools, questionBarrierStartedTools, toolTrace, faults, rpc: rpc?.diagnostics() }),
      });
    } catch (error) {
      if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
        try { await removeDirectoryEventually(failureDirectory); }
        catch (cleanupError) {
          throw new AggregateError([...errors, error, cleanupError], "runtime.tool-restoration failed and failure evidence cleanup failed");
        }
      }
      throw error;
    }
  }
  t.diagnostic(JSON.stringify({ node: process.version, requests: count, requestTools, questionBarrierStartedTools, toolTrace }));
});
