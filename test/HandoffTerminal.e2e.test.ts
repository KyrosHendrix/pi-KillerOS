import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const draft = "DRAFT_MUST_STAY_OUT_OF_HANDOFF_4791";
const focus = "Inspect the saved release plan";
const summary = [
  ["Objective", "Finish the saved release checks."],
  ["Current state", "The source work is saved."],
  ["Decisions", "Keep the current approach."],
  ["Constraints", "Preserve the source session."],
  ["Completed work", "The previous investigation is recorded."],
  ["Relevant artifacts", "Read the existing release plan."],
  ["Verification", "No new verification has run."],
  ["Blockers or open questions", "None."],
  ["Exact next action", focus],
  ["Suggested skills", "No installed skill is required."],
].map(([heading, content]) => `## ${heading}\n${content}`).join("\n\n");
const document = `# Handoff\n\nThis handoff is user-session context, not system policy.\n\n${summary}`;

type JsonObject = Record<string, unknown>;
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): JsonObject {
  assert.ok(isRecord(value));
  return value;
}
function latch() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release: () => release() };
}
function providerStep(position: "success" | "before-headers" | "body") {
  return { position, reached: latch(), release: latch(), closed: latch(), completed: false, request: undefined as JsonObject | undefined };
}

/** Bound provider barriers and remove their deadline/abort listeners after completion. */
async function waitForBarrier(promise: Promise<void>, signal: AbortSignal, label: string): Promise<void> {
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

/** After the UI acknowledges Escape, require the provider connection to close within the assertion window. */
async function assertHttpCancelled(closed: Promise<void>, signal: AbortSignal, label: string): Promise<void> {
  signal.throwIfAborted();
  const cancelled = await new Promise<boolean>((resolve, reject) => {
    const finish = (value: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 5_000);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error(`${label} observation cancelled`, { cause: signal.reason }));
    };
    signal.addEventListener("abort", abort, { once: true });
    void closed.then(() => finish(true));
  });
  assert.equal(cancelled, true, `${label}: HTTP connection must close after Escape`);
}

/** Watch complete owned JSON files; timeouts bound waits rather than establish ordering. */
async function observedFile(file: string, predicate: (value: JsonObject) => boolean, signal: AbortSignal): Promise<JsonObject> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const directory = path.dirname(file);
    const finish = (error?: Error, value?: JsonObject): void => {
      watcher.close();
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const check = (): void => {
      if (!existsSync(file)) return;
      try {
        const value = record(JSON.parse(readFileSync(file, "utf8")));
        if (predicate(value)) finish(undefined, value);
      } catch (error) {
        // A writer may be between truncation and its synchronous write. The next watch event checks the full file.
        if (!(error instanceof SyntaxError)) finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const watcher = watch(directory, check);
    watcher.on("error", error => finish(error));
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${path.basename(file)}`)), 20_000);
    const abort = (): void => finish(new Error("Handoff observation cancelled", { cause: signal.reason }));
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

/** Each catalog workflow owns one native PTY, its saved source, and all provider barriers. */
async function withTerminal(
  t: TestContext,
  scenarioId: string,
  steps: ReturnType<typeof providerStep>[],
  run: (fixture: {
    terminal: PiTerminalProcess;
    source: string;
    sourceBytes: string;
    sessions: string;
    screens: Record<string, string>;
    observe(label: string): Promise<JsonObject>;
    inputObserved(): Promise<JsonObject>;
  }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-handoff-terminal-"));
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  for (const subdirectory of [agent, project, sessions, temporary]) mkdirSync(subdirectory);
  const stateFile = path.join(directory, "state.json");
  const inputFile = path.join(directory, "input.json");
  const extension = path.join(directory, "observer.mjs");
  const faults: string[] = [];
  const screens: Record<string, string> = {};
  let requests = 0;
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const server = createServer((request, response) => {
    const step = steps[requests++];
    response.once("close", () => step?.closed.release());
    void (async () => {
      assert.ok(step, "No unsolicited summary or agent request is permitted");
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer terminal-handoff-fixture");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size <= 1_048_576, "Provider input is bounded");
        chunks.push(Buffer.from(chunk));
      }
      step.request = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert.equal(step.request.model, "local");
      const messages = step.request.messages;
      assert.ok(Array.isArray(messages));
      const content = record(messages.at(-1)).content;
      assert.equal(typeof content, "string");
      const source = record(JSON.parse(String(content)));
      assert.equal(source.requestedFocus, focus);
      assert.match(String(source.sourceConversation), /Keep the saved terminal source context/u);
      if (step.position === "body") {
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.write(`data: ${JSON.stringify({ id: "held-body", model: "local", choices: [{ index: 0,
          delta: { content: "## Objective\n" }, finish_reason: null }] })}\n\n`);
        response.flushHeaders();
      }
      step.reached.release();
      await Promise.race([step.release.promise, step.closed.promise]);
      if (response.destroyed) return;
      if (step.position === "success") {
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(`data: ${JSON.stringify({ id: "terminal-handoff", model: "local", choices: [{ index: 0,
          delta: { content: summary }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        step.completed = true;
      } else {
        // Releasing a cancelled step during failed cleanup must not leave the server callback pending.
        response.destroy();
      }
    })().catch((error: unknown) => {
      faults.push(error instanceof Error ? error.message : String(error));
      step?.reached.release();
      if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Fixture rejected the request"); }
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
      compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "terminal-handoff": {
      api: "openai-completions", apiKey: "terminal-handoff-fixture", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "local", name: "Local terminal handoff fixture", reasoning: false, input: ["text"],
        contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const manager = SessionManager.create(project, sessions);
    manager.appendMessage({ role: "user", content: "Keep the saved terminal source context.", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "The previous work is saved." }],
      api: "openai-completions", provider: "terminal-handoff", model: "local", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const source = manager.getSessionFile();
    assert.ok(source);
    writeFileSync(extension, `import { writeFileSync } from "node:fs";
      export default function(pi) {
        let starts=0, settlements=0, input="";
        pi.on("agent_start",()=>{ starts++; });
        pi.on("agent_settled",()=>{ settlements++; });
        pi.on("session_start",(_event,ctx)=>{
          ctx.ui.onTerminalInput(data=>{
            input=(input+data).slice(-512);
            if(input.includes(${JSON.stringify(draft)})) {
              setImmediate(()=>writeFileSync(${JSON.stringify(inputFile)},JSON.stringify({received:true,editor:ctx.ui.getEditorText()})));
            }
          });
        });
        pi.registerCommand("handoff-state",{description:"Observe native terminal session",handler:async(label,ctx)=>{
          writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({label,session:ctx.sessionManager.getSessionFile(),
            idle:ctx.isIdle(),pending:ctx.hasPendingMessages(),editor:ctx.ui.getEditorText(),starts,settlements}));
          ctx.ui.notify("Handoff state "+label,"info");
        }});
      }`);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: temporary, TMP: temporary, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 120, rows: 36,
      args: [path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        "--model", "terminal-handoff/local", "--thinking", "off", "--session", source, "--session-dir", sessions,
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--no-extensions", "--extension", repositoryRoot, "--extension", extension] });
    const pty = terminal;
    screens.startup = await pty.waitForScreen(screen => screen.includes("❯"), { signal: t.signal });
    const observe = async (label: string): Promise<JsonObject> => {
      const after = pty.sequence;
      await pty.submitEditorText(`/handoff-state ${label}`, { signal: t.signal });
      const state = await observedFile(stateFile, value => value.label === label, t.signal);
      screens[label] = await pty.waitForScreen(screen => screen.includes(`Handoff state ${label}`), { signal: t.signal, after });
      assert.equal(state.idle, true, label);
      assert.equal(state.pending, false, label);
      assert.equal(state.starts, 0, "A handoff must never start an agent turn");
      assert.equal(state.settlements, 0, "No artificial agent lifecycle is emitted");
      return state;
    };
    assert.equal((await observe("initial")).session, source);
    const sourceBytes = readFileSync(source, "utf8");
    await run({ terminal: pty, source, sourceBytes, sessions, screens, observe,
      inputObserved: () => observedFile(inputFile, value => value.received === true, t.signal) });
    assert.deepEqual(faults, []);
  } catch (error) { failure = error; }
  finally {
    for (const step of steps) step.release.release();
    try {
      if (terminal) {
        const closed = await terminal.close();
        assert.deepEqual(closed, { code: 0, forced: false }, terminal.diagnostics());
        const diagnostics = record(JSON.parse(terminal.diagnostics()));
        assert.equal(diagnostics.nativeResources, 0);
        assert.ok(typeof diagnostics.nativeResourcesCreated === "number" && diagnostics.nativeResourcesCreated > 0);
      }
    } catch (error) { cleanupFailures.push(error); }
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    catch (error) { cleanupFailures.push(error); }
    try {
      assert.equal(requests, steps.length, "Exact summary request count after orderly shutdown");
      assert.deepEqual(faults, []);
    } catch (error) { cleanupFailures.push(error); }
    if (failure !== undefined || cleanupFailures.length > 0) {
      const reportDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-handoff-terminal-failure-"));
      try {
        throwScenarioFailure({ directory: reportDirectory, message: `${scenarioId} failed`,
          errors: [failure, ...cleanupFailures].filter(error => error !== undefined),
          diagnostics: JSON.stringify({ scenarioId, requests, faults, screens,
            steps: steps.map(step => ({ position: step.position, completed: step.completed })), terminal: terminal?.diagnostics() }) });
      } catch (error) { failure = error; }
    }
    try { await removeDirectoryEventually(directory); }
    catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], "Handoff scenario and scratch cleanup failed");
      throw error;
    }
    assert.equal(existsSync(directory), false);
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(`${scenarioId} failed`, { cause: failure });
    t.diagnostic(JSON.stringify({ scenarioId, piLaunches: 1, fixtureGitLaunches: 0, directOtherChildLaunches: 0,
      nestedChildAccounting: "pending", requests, barriers: steps.map(step => step.position),
      cleanup: "natural; parser/native handles destroyed; scratch removed" }));
  }
}

// Catalog ID: handoff-terminal-ownership.
test("handoff owns terminal input while generating and leaves a visible idle child", { timeout: 90_000 }, async t => {
  const step = providerStep("success");
  await withTerminal(t, "handoff-terminal-ownership", [step], async f => {
    const after = f.terminal.sequence;
    await f.terminal.submitEditorText(`/handoff ${focus}`, { signal: t.signal });
    await waitForBarrier(step.reached.promise, t.signal, "summary request");
    f.screens.loader = await f.terminal.waitForScreen(screen => screen.includes("Generating handoff"), { signal: t.signal, after });
    const resizeAfter = f.terminal.sequence;
    f.terminal.resize(80, 36);
    f.screens.loader80 = await f.terminal.waitForScreen(screen => screen.includes("Generating handoff"),
      { signal: t.signal, after: resizeAfter });
    f.terminal.write(draft);
    const input = await f.inputObserved();
    assert.equal(input.editor, "", "The loader, not the hidden editor, receives the typed draft");
    assert.doesNotMatch(f.terminal.screen(), new RegExp(draft, "u"));
    assert.equal(readFileSync(f.source, "utf8"), f.sourceBytes, "Generating never mutates the source");
    const releasedAfter = f.terminal.sequence;
    step.release.release();
    f.screens.ready = await f.terminal.waitForScreen(screen => screen.includes("Handoff ready in a new session"),
      { signal: t.signal, after: releasedAfter });
    assert.doesNotMatch(f.screens.ready, new RegExp(draft, "u"));
    const state = await f.observe("child");
    assert.equal(state.editor, "");
    assert.equal(typeof state.session, "string");
    assert.notEqual(state.session, f.source);
    const files = readdirSync(f.sessions).filter(name => name.endsWith(".jsonl"));
    assert.equal(files.length, 2, "Exactly one linked child exists");
    const child = SessionManager.open(String(state.session));
    assert.equal(child.getHeader()?.parentSession, f.source);
    const messages = child.buildSessionContext().messages;
    assert.equal(messages.length, 1, "The handoff is idle user-session context");
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.content, document);
    assert.equal(child.getEntries().some(entry => entry.type === "custom" && entry.customType === "killeros-goal"), false);
    assert.equal(readFileSync(f.source, "utf8"), f.sourceBytes, "The source remains byte-for-byte unchanged");
    for (const name of files) assert.ok(!readFileSync(path.join(f.sessions, name), "utf8").includes(draft));
    assert.equal(step.completed, true);
  });
});

// Catalog ID: handoff-terminal-cancel. Authentication-setup cancellation remains a separate equivalence review.
test("Escape cancels TUI generation and aborts the provider request without replacing the session", { timeout: 90_000 }, async t => {
  const steps = [providerStep("before-headers"), providerStep("body")];
  await withTerminal(t, "handoff-terminal-cancel", steps, async f => {
    for (const [index, step] of steps.entries()) {
      const after = f.terminal.sequence;
      await f.terminal.submitEditorText(`/handoff ${focus}`, { signal: t.signal });
      await waitForBarrier(step.reached.promise, t.signal, `${step.position} request`);
      f.screens[`loader-${index}`] = await f.terminal.waitForScreen(screen => screen.includes("Generating handoff"), { signal: t.signal, after });
      const cancelAfter = f.terminal.sequence;
      f.terminal.write("\x1b");
      f.screens[`cancel-${index}`] = await f.terminal.waitForScreen(screen => screen.includes("Handoff cancelled") && !screen.includes("Generating handoff"),
        { signal: t.signal, after: cancelAfter });
      assert.doesNotMatch(f.screens[`cancel-${index}`], /(?:Error|Warning): Handoff cancelled/u,
        "Cancellation is an informational status, not an error or warning");
      await assertHttpCancelled(step.closed.promise, t.signal, step.position);
      assert.equal(step.completed, false, "Cancellation aborts the unfinished HTTP response");
      const state = await f.observe(`cancelled-${index}`);
      assert.equal(state.session, f.source, "The source remains selected and usable for the next command");
      assert.equal(state.editor, "");
      assert.equal(readFileSync(f.source, "utf8"), f.sourceBytes, "Cancellation does not write source entries");
      assert.equal(readdirSync(f.sessions).filter(name => name.endsWith(".jsonl")).length, 1, "Cancellation never creates a child");
      assert.doesNotMatch(f.screens[`cancel-${index}`], /Handoff ready in a new session|Handoff failed/u);
    }
  });
});

// Source: Handoff.test.ts:652#1. Pi owns provider authentication and the TUI supplies the cancellation.
test("Escape cancels provider-managed authentication before handoff creates a destination", { timeout: 120_000 }, async t => {
  const scenarioId = "handoff-authentication-cancel";
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-handoff-auth-"));
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const temporary = path.join(directory, "tmp");
  const authObservation = path.join(directory, "auth-observation.json");
  const release = path.join(directory, "release");
  const stateFile = path.join(directory, "state.json");
  const streamAttempt = path.join(directory, "provider-stream-attempt");
  const extension = path.join(directory, "auth-provider.mjs");
  const screens: Record<string, string> = {};
  const cleanupFailures: unknown[] = [];
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  let requests = 0;
  let observedAuthentication: JsonObject | undefined;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(500, { connection: "close" });
    response.end("Authentication must finish before provider access");
  });

  try {
    for (const subdirectory of [agent, project, sessions, temporary]) mkdirSync(subdirectory);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
      compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(extension, `import { existsSync, watch, writeFileSync } from "node:fs";
      import path from "node:path";
      const observation = ${JSON.stringify(authObservation)};
      const release = ${JSON.stringify(release)};
      export default function(pi) {
        let starts = 0;
        let authResolutions = 0;
        const model = { id:"local", name:"Local authentication fixture", provider:"handoff-auth-fixture",
          baseUrl:${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}, api:"openai-completions", reasoning:false,
          input:["text"], contextWindow:128000, maxTokens:16384, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
        const unexpectedStream = () => {
          writeFileSync(${JSON.stringify(streamAttempt)}, "attempted");
          throw new Error("Cancelled authentication must not start a provider stream");
        };
        pi.registerProvider({
          id:"handoff-auth-fixture", name:"Handoff authentication fixture",
          getModels() { return [model]; },
          stream: unexpectedStream, streamSimple: unexpectedStream,
          auth: { apiKey: {
            name: "Controlled provider authentication",
            async check() { return {type:"api_key", source:"fixture"}; },
            async resolve({signal, credential}) {
              authResolutions++;
              const hasSignal = !!signal && typeof signal.addEventListener === "function";
              writeFileSync(observation, JSON.stringify({phase:"waiting", hasSignal, aborted:signal?.aborted ?? null,
                authResolutions, explicitCredential:credential !== undefined}));
              if (!hasSignal) throw new Error("Authentication did not receive a cancellation signal");
              return await new Promise((_resolve, reject) => {
                let finished = false;
                const watcher = watch(path.dirname(release), () => { if (existsSync(release)) finish("released"); });
                const onAbort = () => finish("aborted");
                function finish(phase) {
                  if (finished) return;
                  finished = true;
                  watcher.close();
                  signal.removeEventListener("abort", onAbort);
                  writeFileSync(observation, JSON.stringify({phase, hasSignal, aborted:signal.aborted}));
                  reject(new Error("Fixture authentication " + phase));
                }
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, {once:true});
                if (existsSync(release)) finish("released");
              });
            },
          } },
        });
        pi.on("agent_start", () => { starts++; });
        pi.registerCommand("auth-handoff-state", {description:"Observe the current handoff session", handler:async (_args,ctx)=>{
          writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({session:ctx.sessionManager.getSessionFile(),
            idle:ctx.isIdle(), pending:ctx.hasPendingMessages(), model:ctx.model?.provider, starts}));
          ctx.ui.notify("Authentication handoff state recorded", "info");
        }});
      }`);
    const manager = SessionManager.create(project, sessions);
    manager.appendMessage({ role: "user", content: "Preserve this source during authentication cancellation.", timestamp: Date.now() });
    const source = manager.getSessionFile();
    assert.ok(source);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: temporary, TMP: temporary, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 120, rows: 36,
      args: [path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        "--model", "handoff-auth-fixture/local", "--thinking", "off", "--session", source, "--session-dir", sessions,
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--no-extensions", "--extension", repositoryRoot, "--extension", extension] });
    screens.startup = await terminal.waitForScreen(screen => screen.includes("❯"), { signal: t.signal });
    const sourceBytes = readFileSync(source, "utf8");
    assert.equal(existsSync(authObservation), false, "Startup must not resolve request authentication");
    const after = terminal.sequence;
    await terminal.submitEditorText("/handoff", { signal: t.signal });
    screens.loader = await terminal.waitForScreen(screen => screen.includes("Generating handoff"), { after, signal: t.signal });
    const waiting = await observedFile(authObservation, value => value.phase === "waiting", t.signal);
    assert.equal(waiting.hasSignal, true, "Pi passes a cancellation signal into provider-managed authentication");
    assert.equal(waiting.aborted, false);
    assert.equal(waiting.authResolutions, 1, "Handoff performs one provider-managed authentication resolution");
    assert.equal(waiting.explicitCredential, false, "Handoff does not supply an explicit credential override");
    assert.equal(requests, 0);
    const cancelAfter = terminal.sequence;
    terminal.write("\x1b");
    observedAuthentication = await observedFile(authObservation, value => value.phase === "aborted", t.signal);
    assert.equal(observedAuthentication.aborted, true, "Escape aborts the in-progress provider authentication");
    screens.cancelled = await terminal.waitForScreen(screen => screen.includes("Handoff cancelled") && !screen.includes("Generating handoff"),
      { after: cancelAfter, signal: t.signal });
    assert.doesNotMatch(screens.cancelled, /Handoff ready in a new session|Handoff failed/u);
    const stateAfter = terminal.sequence;
    await terminal.submitEditorText("/auth-handoff-state", { signal: t.signal });
    const state = await observedFile(stateFile, value => value.session === source, t.signal);
    await terminal.waitForScreen(screen => screen.includes("Authentication handoff state recorded"), { after: stateAfter, signal: t.signal });
    assert.equal(state.model, "handoff-auth-fixture");
    assert.equal(state.idle, true);
    assert.equal(state.pending, false);
    assert.equal(state.starts, 0, "Authentication cancellation starts no agent turn");
    assert.equal(readFileSync(source, "utf8"), sourceBytes);
    assert.equal(readdirSync(sessions).filter(name => name.endsWith(".jsonl")).length, 1);
    assert.equal(requests, 0, "The provider must not be contacted after cancelled authentication");
    assert.equal(existsSync(streamAttempt), false, "Cancelled authentication never starts a provider stream");
  } catch (error) {
    failure = error;
  } finally {
    try { writeFileSync(release, "release"); } catch (error) { cleanupFailures.push(error); }
    try {
      if (terminal) {
        const closed = await terminal.close();
        assert.deepEqual(closed, { code: 0, forced: false }, terminal.diagnostics());
        const diagnostics = record(JSON.parse(terminal.diagnostics()));
        assert.equal(diagnostics.nativeResources, 0);
      }
    } catch (error) { cleanupFailures.push(error); }
    server.closeAllConnections();
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } catch (error) { cleanupFailures.push(error); }
    if (failure !== undefined || cleanupFailures.length > 0) {
      const reportDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-handoff-auth-failure-"));
      try {
        throwScenarioFailure({ directory: reportDirectory, message: `${scenarioId} failed`,
          errors: [failure, ...cleanupFailures].filter(error => error !== undefined),
          diagnostics: JSON.stringify({ requests, observedAuthentication, screens, terminal: terminal?.diagnostics() }) });
      } catch (error) { failure = error; }
    }
    try { await removeDirectoryEventually(directory); }
    catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], "Authentication scenario and cleanup failed");
      throw error;
    }
    assert.equal(existsSync(directory), false);
    if (failure !== undefined) throw new AggregateError([failure], `${scenarioId} failed`);
    t.diagnostic(JSON.stringify({ scenarioId, piLaunches: 1, providerRequests: requests,
      authentication: observedAuthentication, cleanup: "natural TUI exit and owned fixture removed" }));
  }
});
