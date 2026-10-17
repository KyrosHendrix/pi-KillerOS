import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("installed Pi restores saved tools without reviving goals and preserves exclusions and model-only decisions", {
  timeout: 90_000, skip: piRpcShutdownSkip,
}, async (t) => {
  const directory = mkdtempSync(path.join(root, "node_modules/.killeros-restore-"));
  const cwd = path.join(directory, "project");
  const agentDir = path.join(directory, "agent");
  mkdirSync(cwd); mkdirSync(agentDir);
  const probe = path.join(directory, "probe.ts");
  const session = path.join(directory, "session.jsonl");
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    TEMP: directory, TMP: directory, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) env[key] = inherited.get(key.toLowerCase());
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read"], cacheWarming: "off",
    compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(probe, `export default function(pi) {
    pi.registerCommand("restore-loadout", {description:"Set native tools",handler:async()=>{pi.setActiveTools(["read","grep","question"]);}});
    pi.registerCommand("restore-inspect", {description:"Inspect native tools",handler:async()=>{pi.appendEntry("restore-inventory",{active:pi.getActiveTools(),tools:pi.getAllTools().filter(t=>["question","killeros_goal_update"].includes(t.name)).map(t=>({name:t.name,exposure:t.exposure}))});}});
    pi.registerCommand("restore-reload", {description:"Reload",handler:async(_args,ctx)=>{await ctx.reload();}});
  }`);
  let expectedTools = ["read", "grep", "question"];
  let count = 0;
  const faults: string[] = [];
  const requestTools: string[][] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer restore-local-key");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) { assert.ok(chunk instanceof Uint8Array); size += chunk.length; assert.ok(size <= 1_048_576); chunks.push(Buffer.from(chunk)); }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const names = records(body.tools).map(tool => String(record(tool.function).name)).sort();
      requestTools.push(names);
      assert.deepEqual(names, [...expectedTools].sort());
      const last = records(body.messages).at(-1); assert.ok(last);
      const lastText = typeof last.content === "string" ? last.content
        : records(last.content).map(part => { assert.ok(typeof part.text === "string"); return part.text; }).join("");
      let delta: Record<string, unknown> = { content: "Restored request finished" };
      let finish = "stop";
      if (names.includes("killeros_goal_update")) {
        delta = { tool_calls: [{ index: 0, id: "restore-complete", type: "function", function: { name: "killeros_goal_update",
          arguments: JSON.stringify({ status: "complete", evidence: "Restored tool selection verified" }) } }] };
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
  const entries = async () => { assert.ok(rpc); return records(record((await rpc.command("get_entries", {}, { signal: t.signal })).data).entries); };
  const run = async (message: string) => {
    assert.ok(rpc);
    const after = rpc.currentSequence;
    await rpc.command("prompt", { message }, { signal: t.signal });
    await rpc.waitFor(event => event.type === "agent_settled", { after, signal: t.signal });
    assert.deepEqual(faults, []);
  };
  const close = async () => { if (!rpc) return; const closed = await rpc.close(); assert.equal(closed.forced, false); assert.equal(closed.exit.code, 0); assert.equal(closed.treeCleanupError, undefined); rpc = undefined; };
  const start = async (tools: string[] = []) => {
    rpc = new PiRpcProcess({ cliPath: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), cwd, env,
      args: ["--mode", "rpc", "--model", "restore-local/local", "--thinking", "off", "--session", session, "--offline", "--no-approve",
        "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
        "--extension", root, "--extension", probe, "--extension", "builtin:codemode", ...tools] });
    await rpc.command("get_state", {}, { signal: t.signal });
  };
  const inventory = async (decisionsRegistered = true) => {
    assert.ok(rpc);
    await rpc.command("prompt", { message: "/restore-inspect" }, { signal: t.signal });
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
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "restore-local": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "restore-local-key",
      models: [{ id: "local", name: "Restore local", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    await start();
    assert.ok(rpc); await rpc.command("prompt", { message: "/restore-loadout" }, { signal: t.signal });
    await run("Save native tools");
    assert.equal(count, 1);
    await close();
    expectedTools = ["grep", "question", "codemode"];
    await start(["--tools", "+codemode,-read"]);
    await inventory();
    assert.equal(count, 1, "Restoration and inspection must not start provider work");
    await run("Inspect restored tools");
    expectedTools.push("killeros_goal_update");
    await run("/goal Verify restored loadout");
    const goal = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(goal); assert.equal(record(record(goal.data).state).status, "complete");
    assert.equal(record(record(goal.data).state).turns, 1);
    assert.ok(rpc); await rpc.command("prompt", { message: "/restore-reload" }, { signal: t.signal });
    await inventory();
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
    const excluded = (await entries()).filter(entry => entry.type === "custom" && entry.customType === "killeros-goal").at(-1);
    assert.ok(excluded); assert.equal(record(record(excluded.data).state).status, "paused");
    assert.equal(record(record(excluded.data).state).turns, 0);
    assert.equal(count, before);
    await run("Explicit selection remains authoritative");
    assert.equal(count, 7);
    assert.deepEqual(faults, []);
  } catch (error) {
    failure = error;
  } finally {
    try { await close(); } catch (error) { cleanupErrors.push(error); }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (failure !== undefined || cleanupErrors.length > 0) {
    throwScenarioFailure({ directory, message: "Saved tool restoration failed", errors: [failure, ...cleanupErrors],
      diagnostics: JSON.stringify({ node: process.version, requests: count, requestTools, faults, rpc: rpc?.diagnostics() }),
    });
  }
  t.diagnostic(JSON.stringify({ node: process.version, requests: count, requestTools }));
  await removeDirectoryEventually(directory);
});
