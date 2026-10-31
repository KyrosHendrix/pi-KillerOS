import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const lifecycle = [
  { event: "set", label: "Goal started", color: "111;174;178" },
  { event: "replace", label: "Goal replaced", color: "111;174;178" },
  { event: "edit", label: "Goal objective edited", color: "111;174;178" },
  { event: "resume", label: "Goal resumed", color: "111;174;178" },
  { event: "pause", label: "Goal paused", color: "189;163;108" },
  { event: "limit", label: "Goal paused", color: "189;163;108", result: "Turn limit reached (20/20)." },
  { event: "error", label: "Goal paused", color: "200;120;108", result: "provider unavailable" },
  { event: "clear", label: "Goal cleared", color: "128;128;128" },
];
const decisions = [
  { status: "continue", evidence: "first step passed", nextAction: "run the next step", label: "Progress recorded", color: "111;174;178" },
  { status: "blocker-audit", evidence: "still waiting", blockerKey: "missing-credential", streak: 2, label: "Blocker audit 2/3", color: "189;163;108" },
  { status: "blocked", evidence: "no credentials", blockerKey: "missing-credential", streak: 3, label: "Goal blocked", color: "200;120;108" },
  { status: "complete", evidence: "all checks passed", label: "Goal completed", color: "143;168;139" },
];

function goalState({ status = "active", objective = "run", result }: {
  status?: "active" | "paused" | "complete";
  objective?: string;
  result?: string;
} = {}) {
  return { version: 1, revision: 1, objective, status, createdAt: 1, updatedAt: 1,
    activeMilliseconds: 0, turns: 1, blockedAuditStartTurn: 0, baselineTokens: 0,
    ...(status === "active" ? { activeStartedAt: 1 } : {}),
    ...(result === undefined ? {} : { result }),
  };
}

function rawOutput(terminal: PiTerminalProcess): string {
  const diagnostic: unknown = JSON.parse(terminal.diagnostics());
  assert.ok(typeof diagnostic === "object" && diagnostic !== null && "rawBase64" in diagnostic
    && typeof diagnostic.rawBase64 === "string");
  // Keep foreground resets so a stale color cannot satisfy the role oracle.
  return Buffer.from(diagnostic.rawBase64, "base64").toString("utf8")
    .replace(/\x1b\[([0-9;]*)[A-Za-z]/gu, (escape: string, parameters: string) =>
      escape.endsWith("m") && parameters !== "49" ? escape : "")
    .replace(/[\r\n]/gu, "");
}

function section(screen: string, start: string, end: string): string {
  const from = screen.indexOf(start);
  const to = screen.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Expected visible section ${start} through ${end}`);
  return screen.slice(from + start.length, to);
}

// Catalog ID: GUI-01. Historical rendering is not proof that a live goal can produce every saved shape.
test("Goal transcript and update renderers sanitize controls, stay compact, and expose lifecycle history", { timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-ui-"));
  const project = path.join(root, "project");
  const agent = path.join(root, "agent");
  const sessions = path.join(root, "sessions");
  const temporary = path.join(root, "tmp");
  for (const directory of [project, agent, sessions, temporary]) mkdirSync(directory);
  let requests = 0;
  type Plan = { kind: "tool"; calls: Record<string, unknown>[] } | { kind: "text"; text: string };
  const plans: Plan[] = [];
  const providerFaults: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        chunks.push(Buffer.from(chunk));
        assert.ok(chunks.reduce((size, bytes) => size + bytes.length, 0) <= 1_048_576);
      }
      JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests++;
      const plan = plans.shift();
      assert.ok(plan, "No model request is allowed outside the scripted live goal");
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      const delta = plan.kind === "text" ? { role: "assistant", content: plan.text } : {
        role: "assistant", tool_calls: plan.calls.map((args, index) => ({ index, id: `gui-${requests}-${index}`,
          type: "function", function: { name: "killeros_goal_update", arguments: JSON.stringify(args) } })),
      };
      response.write(`data: ${JSON.stringify({ id: `gui-${requests}`, object: "chat.completion.chunk", model: "local",
        choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: `gui-${requests}`, object: "chat.completion.chunk", model: "local",
        choices: [{ index: 0, delta: {}, finish_reason: plan.kind === "text" ? "stop" : "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      providerFaults.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { connection: "close" });
      response.end();
    });
  });
  let terminal: PiTerminalProcess | undefined;
  const failures: unknown[] = [];
  const screens: Record<string, string> = {};
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Goal UI provider did not receive a port"));
      });
    });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
      defaultThinkingLevel: "off", theme: "killeros", toolOutputExpanded: false,
    }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "goal-ui": {
      api: "openai-completions", apiKey: "goal-ui-fixture", baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{ id: "local", name: "Goal UI fixture", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 64, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const files: Record<string, string> = {};
    for (const name of ["lifecycle", "long", "controls", "fallback", "oversized", "live"]) {
      const session = SessionManager.create(project, sessions);
      session.appendMessage({ role: "user", content: `gui-history-${name}`, timestamp: 1 });
      if (name === "lifecycle") {
        for (const item of lifecycle) {
          session.appendCustomEntry("killeros-goal", { version: 1, event: item.event,
            state: item.event === "clear" ? null : {
              ...goalState({ status: ["pause", "limit", "error"].includes(item.event) ? "paused" : "active", result: item.result }),
              ...(item.event === "error" ? { stopReason: item.result } : {}),
            } });
        }
        for (const event of ["turn", "checkpoint", "continue", "blocker-audit", "blocked", "complete"]) {
          session.appendCustomEntry("killeros-goal", { version: 1, event, state: goalState({ objective: `hidden-${event}` }) });
        }
      } else if (name === "long") {
        session.appendCustomEntry("killeros-goal", { version: 1, event: "set", state: goalState({ objective: "Objective ".repeat(400) }) });
      } else if (name === "controls") {
        session.appendCustomEntry("killeros-goal", { version: 1, event: "error",
          state: goalState({ status: "complete", objective: "safespoof\nnext", result: "safespoof\nnext" }) });
      } else if (name === "oversized") {
        session.appendCustomEntry("killeros-goal", { version: 1, event: "set", state: goalState({ objective: "X".repeat(8_000) }) });
      }
      if (name === "controls" || name === "fallback") {
        const id = `gui-saved-${name}`;
        session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "killeros_goal_update",
          arguments: { status: "complete" } }], api: "openai-completions", provider: "goal-ui", model: "local",
          stopReason: "toolUse", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        session.appendMessage({ role: "toolResult", toolCallId: id, toolName: "killeros_goal_update", content: [],
          details: name === "controls" ? { status: "complete", evidence: "safe\x1b[2Jspoof\x07\nnext" } : {},
          isError: false, timestamp: 3 });
      }
      session.appendCustomEntry("killeros-goal", { version: 1, event: "complete",
        state: goalState({ status: "complete", objective: "hidden-terminal-state" }) });
      session.appendMessage({ role: "user", content: `gui-ready-${name}`, timestamp: 4 });
      const file = session.getSessionFile();
      assert.ok(file, `${name}: public SessionManager must persist the history`);
      files[name] = file;
    }
    const extension = path.join(root, "select-history.ts");
    writeFileSync(extension, `export default function(pi) {
  let settlements = 0;
  pi.on("agent_settled", (_event, ctx) => ctx.ui.notify("gui-native-settled:" + (++settlements) + " idle=" + ctx.isIdle() + " pending=" + ctx.hasPendingMessages(), "info"));
  pi.registerCommand("gui-frame", { description: "Acknowledge a physical terminal resize", handler: async (args, ctx) => {
    ctx.ui.notify("gui-frame:" + args + ":" + process.stdout.columns, "info");
  }});
  const files = ${JSON.stringify(files)};
  pi.registerCommand("gui-session", { description: "Open an exact historical rendering fixture", handler: async (args, ctx) => {
    const file = files[args.split(" ")[0]];
    if (!file) throw new Error("Unknown goal history fixture");
    const result = await ctx.switchSession(file);
    if (result.cancelled) throw new Error("Goal history switch was cancelled");
  }});
}
`);
    const env: NodeJS.ProcessEnv = {
      HOME: root, USERPROFILE: root, APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"),
      TEMP: temporary, TMP: temporary, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const first = files.lifecycle;
    assert.ok(first);
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 120, rows: 220,
      args: [cliPath, "--model", "goal-ui/local", "--thinking", "off", "--tools", "read,killeros_goal_update", "--offline", "--approve",
        "--session", first, "--session-dir", sessions, "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot, "--extension", extension],
    });
    await terminal.waitForScreen(screen => screen.includes("gui-ready-lifecycle"), { signal: t.signal });
    for (const width of [120, 80, 40]) {
      terminal.resize(width, 220);
      for (const name of ["lifecycle", "long", "controls", "fallback", "oversized"]) {
        const cursor = terminal.sequence;
        await terminal.submitEditorText(`/gui-session ${name} ${width}`, { signal: t.signal });
        const collapsed = await terminal.waitForScreen(screen => screen.includes(`gui-ready-${name}`)
          && screen.includes("Resumed session"), { signal: t.signal, after: cursor });
        screens[`${name}-${width}-collapsed`] = collapsed;
        const raw = rawOutput(terminal);
        if (name === "lifecycle") {
          const rows = section(collapsed, "gui-history-lifecycle", "gui-ready-lifecycle")
            .split("\n").map(line => line.trim()).filter(Boolean);
          assert.equal(rows.length, 8, `one collapsed row per lifecycle event at ${width}`);
          for (const [index, item] of lifecycle.entries()) {
            assert.ok(rows[index]?.startsWith(item.label));
            assert.doesNotMatch(rows[index] ?? "", /✻|Ⅱ|✓|→/u);
            assert.ok(raw.includes(`\x1b[38;2;${item.color}m${item.label}`), `${item.event}: native theme role at ${width}`);
          }
          assert.ok(rows[0]?.includes("Goal started · run"));
          if (width >= 80) assert.ok(rows[5]?.includes("Goal paused · Turn limit reached (20/20)."),
            "the collapsed limit row preserves its complete reason at the original source width");
          assert.equal(rows.at(-1), "Goal cleared");
          assert.doesNotMatch(collapsed, /hidden-(?:turn|checkpoint|continue|blocker-audit|blocked|complete|terminal-state)/u);
        } else if (name === "long") {
          assert.equal(collapsed.split("\n").filter(line => line.includes("Objective")).length, 1,
            "long objective occupies one collapsed row");
        } else if (name === "fallback") {
          assert.equal(collapsed.split("\n").filter(line => line.trim() === "Goal updated").length, 1,
            "a saved empty-details result renders the fallback through the native history loader");
          assert.ok(raw.includes("\x1b[38;2;128;128;128mGoal updated"), "the fallback uses the native dim theme role");
        } else if (name === "oversized") {
          assert.doesNotMatch(collapsed, /Goal started|XXXXX/u, "the 8,000-character saved objective is rejected, not claimed as rendered coverage");
        }
        const expandAfter = terminal.sequence;
        terminal.write("\x0f");
        const expanded = await terminal.waitForScreen(screen => screen.includes("Tool output: expanded"), { signal: t.signal, after: expandAfter });
        screens[`${name}-${width}-expanded`] = expanded;
        if (name === "long") {
          assert.equal((expanded.match(/Objective/gu) ?? []).length, 400, "the complete source objective survives expansion");
        } else if (name === "controls") {
          const normalized = expanded.split("\n").map(line => line.trim()).join("\n");
          assert.equal((normalized.match(/safespoof\nnext/gu) ?? []).length, 2,
            "both the saved entry and unsafe saved tool result retain the source line break");
          assert.doesNotMatch(expanded, /\[2J|gui-owned/u);
          assert.equal(terminal.bellCount, 0);
          assert.ok(terminal.titles.every(title => !title.includes("gui-owned")));
        } else if (name === "lifecycle") {
          assert.ok(expanded.includes("provider unavailable"));
          assert.ok(expanded.includes("run"));
          assert.ok(expanded.includes("Turn limit reached (20/20)."));
        }
        const collapseAfter = terminal.sequence;
        terminal.write("\x0f");
        await terminal.waitForScreen(screen => screen.includes("Tool output: collapsed"), { signal: t.signal, after: collapseAfter });
      }
    }
    assert.equal(requests, 0, "restored history renders without starting an agent turn");
    terminal.resize(120, 220);
    await terminal.submitEditorText("/gui-session live", { signal: t.signal });
    await terminal.waitForScreen(screen => screen.includes("gui-ready-live") && screen.includes("Resumed session"), { signal: t.signal });
    const pair = (calls: Record<string, unknown>[], text: string): void => {
      plans.push({ kind: "tool", calls }, { kind: "text", text });
    };
    pair([{ status: "continue", evidence: "first step passed", nextAction: "run the next step" }], "gui-continue-ended");
    pair([{ status: "blocked", blockerKey: "missing-credential", evidence: "safe\x1b[2Jspoof\x07\nnext\nosc\x1b]2;gui-owned\x07safe\nline" }], "gui-first-audit-ended");
    pair([{ status: "blocked", blockerKey: "missing-credential", evidence: "still waiting" }], "gui-second-audit-ended");
    pair([{ status: "blocked", blockerKey: "missing-credential", evidence: "no credentials" }], "gui-blocked-ended");
    pair([{ status: "complete", evidence: "E".repeat(2_000) }, { status: "complete", evidence: "second completion must fail" }], "gui-completion-ended");
    pair([{ status: "complete", evidence: "all checks passed" }], "gui-final-ended");
    await terminal.submitEditorText("/goal Render real decisions", { signal: t.signal });
    await terminal.waitForScreen(screen => screen.includes("gui-native-settled:4 idle=true pending=false") && screen.includes("/goal blocked"), { signal: t.signal });
    assert.equal(requests, 8, "the blocker audit consumes four accounted goal turns");
    await terminal.submitEditorText("Complete the same saved blocked goal", { signal: t.signal });
    await terminal.waitForScreen(screen => screen.includes("gui-native-settled:5 idle=true pending=false"), { signal: t.signal });
    assert.equal(requests, 10);
    await terminal.submitEditorText("/goal Render the final completed decision", { signal: t.signal });
    await terminal.waitForScreen(screen => screen.includes("gui-native-settled:6 idle=true pending=false"), { signal: t.signal });
    assert.equal(requests, 12);
    for (const width of [120, 80, 40]) {
      const resizedAfter = terminal.sequence;
      terminal.resize(width, 220);
      await terminal.submitEditorText(`/gui-frame ${width}`, { signal: t.signal });
      const collapsed = await terminal.waitForScreen(screen => screen.includes("gui-final-ended")
        && screen.includes(`gui-frame:${width}:${width}`)
        && screen.split("\n").some(line => line === "─".repeat(width)), { signal: t.signal, after: resizedAfter });
      screens[`live-${width}-collapsed`] = collapsed;
      const collapsedEvidence = section(collapsed, "Goal completed", "goal complete");
      assert.ok(collapsedEvidence.split("\n").filter(line => line.trim()).length <= 1,
        `long goal evidence occupies at most one collapsed row: ${JSON.stringify(collapsedEvidence)}`);
      const errorEnd = collapsed.indexOf("gui-completion-ended");
      const collapsedError = collapsed.slice(collapsed.lastIndexOf("goal complete", errorEnd), errorEnd);
      if (width >= 80) {
        assert.match(collapsedError.split("\n").map(line => line.trim()).filter(Boolean).join("\n"),
          /^goal complete\nThere is no active KillerOS goal to update$/u,
          "collapsed result renders the real goal error");
      }
      assert.doesNotMatch(collapsedError, /undefined|Blocker audit/u);
      const raw = rawOutput(terminal);
      for (const item of decisions) {
        const rows = collapsed.split("\n").filter(line => line.includes(item.label));
        assert.equal(rows.length, item.status === "complete" ? 2 : 1, `${item.status}: one row per actual decision`);
        for (const row of rows) assert.doesNotMatch(row, /✻|Ⅱ|✓|→|!/u);
        assert.ok(raw.includes(`\x1b[38;2;${item.color}m${item.label}`), `${item.status}: native decision theme role`);
      }
      const expandAfter = terminal.sequence;
      terminal.write("\x0f");
      const expanded = await terminal.waitForScreen(screen => screen.includes("Tool output: expanded"), { signal: t.signal, after: expandAfter });
      screens[`live-${width}-expanded`] = expanded;
      const normalized = expanded.split("\n").map(line => line.trim()).join("\n");
      assert.match(normalized, /safespoof\nnext\noscsafe\nline/u);
      assert.ok(expanded.includes("first step passed"));
      const evidence = section(expanded, "Goal completed ·", "goal complete").replace(/\s+/gu, "");
      assert.equal(evidence, "E".repeat(2_000));
      const expandedErrorEnd = expanded.indexOf("gui-completion-ended");
      const expandedError = expanded.slice(expanded.lastIndexOf("goal complete", expandedErrorEnd), expandedErrorEnd);
      assert.match(expandedError.replace(/\s+/gu, " ").trim(), /^goal complete There is no active KillerOS goal to update$/u);
      assert.doesNotMatch(expandedError, /undefined|Blocker audit/u);
      assert.doesNotMatch(expanded, /undefined|\[2J|gui-owned/u);
      assert.equal(terminal.bellCount, 0);
      assert.ok(terminal.titles.every(title => !title.includes("gui-owned")));
      const collapseAfter = terminal.sequence;
      terminal.write("\x0f");
      await terminal.waitForScreen(screen => screen.includes("Tool output: collapsed"), { signal: t.signal, after: collapseAfter });
    }
    assert.deepEqual(plans, []);
    assert.deepEqual(providerFaults, []);
  } catch (error) { failures.push(error); }
  if (terminal) {
    try {
      const closed = await terminal.close();
      assert.equal(closed.code, 0);
      assert.equal(closed.forced, false);
      assert.equal(closed.failure, undefined);
    } catch (error) { failures.push(error); }
  }
  try {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { failures.push(error); }
  if (failures.length > 0) {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-ui-failure-"));
    throwScenarioFailure({ directory, message: "GUI-01 historical TUI rendering failed", errors: failures,
      diagnostics: JSON.stringify({ root, requests, screens, terminal: terminal?.diagnostics() }, null, 2) });
  }
  await removeDirectoryEventually(root);
  assert.equal(existsSync(root), false);
  t.diagnostic(JSON.stringify({ scenarioId: "GUI-01", piLaunches: 1, providerRequests: requests,
    historyFixtures: 6, widths: [120, 80, 40], expandedAndCollapsed: true,
    qualification: "pending fault qualification and source-equivalence review" }));
});

// Catalog ID: GUI-02. Persisted elapsed time avoids an hour-long wait without changing the native clock.
test("Goal footer status and completion history survive lifecycle transitions", { timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-footer-"));
  const project = path.join(root, "pi-KillerOS");
  const agent = path.join(root, "agent");
  const sessions = path.join(root, "sessions");
  const temporary = path.join(root, "tmp");
  const readFooter = (): unknown => {
    const name = readdirSync(root).filter(name => /^footer-\d{24}\.json$/u.test(name)).sort().at(-1);
    return name === undefined ? undefined : JSON.parse(readFileSync(path.join(root, name), "utf8"));
  };
  for (const directory of [project, agent, sessions, temporary]) mkdirSync(directory);
  type Reply = { kind: "text"; text: string } | { kind: "blocked" | "complete"; evidence: string };
  const scripted = new Map<number, Reply>();
  const pending = new Map<number, ServerResponse>();
  const arrivals = new EventEmitter();
  const providerFaults: string[] = [];
  let requests = 0;
  const reply = (number: number, plan: Reply): void => {
    const response = pending.get(number);
    assert.ok(response && !response.destroyed, `provider response ${number} is still owned`);
    pending.delete(number);
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const delta = plan.kind === "text" ? { role: "assistant", content: plan.text } : {
      role: "assistant", tool_calls: [{ index: 0, id: `gui-footer-${number}`, type: "function",
        function: { name: "killeros_goal_update", arguments: JSON.stringify({ status: plan.kind,
          evidence: plan.evidence, ...(plan.kind === "blocked" ? { blockerKey: "missing-credential" } : {}) }) } }],
    };
    response.write(`data: ${JSON.stringify({ id: `gui-footer-${number}`, object: "chat.completion.chunk", model: "local",
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: `gui-footer-${number}`, object: "chat.completion.chunk", model: "local",
      choices: [{ index: 0, delta: {}, finish_reason: plan.kind === "text" ? "stop" : "tool_calls" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const server = createServer((request, response) => {
    void (async () => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        bytes += chunk.length;
        assert.ok(bytes <= 1_048_576, "bounded provider request");
        chunks.push(Buffer.from(chunk));
      }
      JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const number = ++requests;
      pending.set(number, response);
      response.once("close", () => pending.delete(number));
      const plan = scripted.get(number);
      if (plan) { scripted.delete(number); reply(number, plan); }
      arrivals.emit("request");
    })().catch((error: unknown) => {
      providerFaults.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { connection: "close" });
      response.end();
      arrivals.emit("request");
    });
  });
  const waitForRequest = async (number: number): Promise<void> => {
    const signal = AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]);
    while (requests < number && providerFaults.length === 0) await once(arrivals, "request", { signal });
    assert.deepEqual(providerFaults, []);
    assert.equal(requests, number, "only the expected model request starts");
  };
  const footer = (_screen: string, width: number): string[] => {
    const value = readFooter();
    assert.ok(typeof value === "object" && value !== null && "width" in value && value.width === width);
    assert.ok("columns" in value && value.columns === width, "the actual native footer follows the PTY width");
    assert.ok("rows" in value && Array.isArray(value.rows) && value.rows.every((row: unknown) => typeof row === "string"));
    const rows = value.rows.map((row: unknown) => { assert.ok(typeof row === "string"); return row; });
    assert.equal(rows.length, 3, "the actual footer producer returns three rows");
    assert.ok(rows.every(line => visibleWidth(line) === width), "all producer rows fill their actual width");
    return rows;
  };
  const footerReady = (width: number): boolean => {
    const value = readFooter();
    return typeof value === "object" && value !== null && "width" in value && value.width === width
      && "columns" in value && value.columns === width;
  };
  let terminal: PiTerminalProcess | undefined;
  let rpc: PiRpcProcess | undefined;
  let terminalClosed = false;
  let rpcClosed = false;
  const failures: unknown[] = [];
  const screens: Record<string, string> = {};
  let checkedWidths = 0;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Goal footer provider did not receive a port"));
      });
    });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false },
      retry: { enabled: false }, defaultThinkingLevel: "off", theme: "killeros" }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "goal-footer": {
      api: "openai-completions", apiKey: "goal-footer-fixture", baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [{ id: "local", name: "Goal footer fixture", reasoning: false, input: ["text"], contextWindow: 100_000,
        maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const files: Record<string, string> = {};
    for (const item of [
      { name: "seconds", activeMilliseconds: 10_000, turns: 0, maxTurns: 20 },
      { name: "minutes", activeMilliseconds: 125_000, turns: 0, maxTurns: 20 },
      { name: "hours", activeMilliseconds: 3_725_000, turns: 0, maxTurns: 20 },
      { name: "unlimited", activeMilliseconds: 10_000, turns: 2 },
    ]) {
      const session = SessionManager.create(project, sessions);
      session.appendMessage({ role: "user", content: `gui-footer-${item.name}`, timestamp: 1 });
      session.appendCustomEntry("killeros-goal", { version: 1, event: "set", state: {
        ...goalState({ objective: "Keep working" }), activeMilliseconds: item.activeMilliseconds,
        turns: item.turns, ...(item.maxTurns === undefined ? {} : { maxTurns: item.maxTurns }), turnPhase: "ready",
      } });
      const file = session.getSessionFile();
      assert.ok(file);
      files[item.name] = file;
    }
    const extension = path.join(root, "footer-observer.ts");
    writeFileSync(extension, `import { renameSync, writeFileSync } from "node:fs";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
export default function(pi) {
  let observingFooter = false;
  pi.on("session_start", (_event, ctx) => {
    if (observingFooter) return;
    observingFooter = true;
    const setFooter = ctx.ui.setFooter.bind(ctx.ui);
    ctx.ui.setFooter = factory => setFooter(factory === undefined ? undefined : (...args) => {
      const component = factory(...args);
      const render = component.render.bind(component);
      component.render = width => {
        const rows = render(width);
        const file = ${JSON.stringify(path.join(root, "footer-"))} + process.hrtime.bigint().toString().padStart(24, "0") + ".json";
        writeFileSync(file + ".tmp", JSON.stringify({ width, columns: process.stdout.columns, rows: rows.map(stripTerminalSequences) }));
        renameSync(file + ".tmp", file);
        return rows;
      };
      return component;
    });
  });
  let settlements = 0;
  pi.on("agent_settled", (_event, ctx) => ctx.ui.notify("gui-footer-settled:" + (++settlements) + " idle=" + ctx.isIdle() + " pending=" + ctx.hasPendingMessages(), "info"));
  const files = ${JSON.stringify(files)};
  pi.registerCommand("gui-footer-session", { description: "Open a public duration history", handler: async (args, ctx) => {
    const file = files[args];
    if (!file) throw new Error("Unknown goal footer history");
    const result = await ctx.switchSession(file);
    if (result.cancelled) throw new Error("Goal footer history switch cancelled");
  }});
}
`);
    const env: NodeJS.ProcessEnv = { HOME: root, USERPROFILE: root, APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "localappdata"), TEMP: temporary, TMP: temporary,
      PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const secondsFile = files.seconds;
    const unlimitedFile = files.unlimited;
    assert.ok(secondsFile && unlimitedFile);
    const args = [cliPath, "--model", "goal-footer/local", "--thinking", "off", "--tools", "read,killeros_goal_update",
      "--offline", "--approve", "--session-dir", sessions, "--no-context-files", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-mcp", "--no-extensions", "--extension", extension, "--extension", repositoryRoot];
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 160, rows: 34,
      args: [...args, "--session", secondsFile] });
    await waitForRequest(1);
    screens.seconds = await terminal.waitForScreen(screen => screen.split("\n").at(-1)?.trimEnd().endsWith("/goal active · 1/20 · 10s") === true,
      { signal: t.signal, timeoutMs: 25_000 });
    assert.ok(footer(screens.seconds, 160)[2]?.trimEnd().endsWith("/goal active · 1/20 · 10s"));
    assert.ok(rawOutput(terminal).includes("\x1b[38;2;111;174;178m/goal active"), "native active-goal theme role");
    assert.doesNotMatch(footer(screens.seconds, 160)[2] ?? "", /✻|\/goal is active|pi-KillerOS/u);
    for (let width = 1; width <= 180; width++) {
      const after = terminal.sequence;
      terminal.resize(width, 34);
      const screen = await terminal.waitForScreen(() => footerReady(width), { signal: t.signal, after });
      const rows = footer(screen, width);
      if (width === 20) { assert.match(rows[2] ?? "", /\/goal active/u); screens.narrow = screen; }
      if (width === 180) screens.wide = screen;
      checkedWidths++;
    }
    assert.equal(checkedWidths, 180);
    assert.equal(requests, 1, "all 180 native resizes preserve the same held request");
    terminal.resize(160, 34);
    for (const item of [
      { name: "minutes", duration: "2m 05s", width: 40, count: "1/20", request: 2 },
      { name: "hours", duration: "1h 02m 05s", width: 40, count: "1/20", request: 3 },
      { name: "unlimited", duration: "10s", width: 160, count: "3 turns", request: 4 },
    ]) {
      await terminal.submitEditorText("/goal pause", { signal: t.signal });
      screens[`pause-before-${item.name}`] = await terminal.waitForScreen(screen => screen.includes(`/goal paused`)
        && screen.includes("gui-footer-settled:1 idle=true pending=false"), { signal: t.signal });
      const paused = footer(screens[`pause-before-${item.name}`] ?? "", 160)[2] ?? "";
      assert.ok(paused.trimEnd().endsWith("/goal paused"));
      assert.doesNotMatch(paused, /Ⅱ|\/goal is paused/u);
      await terminal.submitEditorText(`/gui-footer-session ${item.name}`, { signal: t.signal });
      await waitForRequest(item.request);
      terminal.resize(item.width, 34);
      screens[item.name] = await terminal.waitForScreen(screen => footerReady(item.width)
        && screen.split("\n").at(-1)?.trimEnd()
          .endsWith(`/goal active · ${item.count} · ${item.duration}`) === true, { signal: t.signal, timeoutMs: 25_000 });
      assert.ok(footer(screens[item.name] ?? "", item.width)[2]?.trimEnd().endsWith(`/goal active · ${item.count} · ${item.duration}`));
      terminal.resize(160, 34);
      await terminal.waitForScreen(() => footerReady(160), { signal: t.signal });
    }
    scripted.set(5, { kind: "text", text: "gui-footer-audit-one-ended" });
    scripted.set(6, { kind: "blocked", evidence: "still waiting" });
    scripted.set(7, { kind: "text", text: "gui-footer-audit-two-ended" });
    scripted.set(8, { kind: "blocked", evidence: "no credentials" });
    scripted.set(9, { kind: "text", text: "gui-footer-blocked-ended" });
    reply(4, { kind: "blocked", evidence: "credential missing" });
    screens.blocked = await terminal.waitForScreen(screen => screen.split("\n").at(-1)?.trimEnd().endsWith("/goal blocked") === true
      && screen.includes("gui-footer-settled:3 idle=true pending=false"), { signal: t.signal, timeoutMs: 30_000 });
    assert.equal(requests, 9);
    const blocked = footer(screens.blocked, 160)[2] ?? "";
    assert.ok(blocked.trimEnd().endsWith("/goal blocked"));
    assert.doesNotMatch(blocked, /! goal|\/goal is blocked/u);
    scripted.set(10, { kind: "complete", evidence: "All checks passed" });
    scripted.set(11, { kind: "text", text: "gui-footer-completed-ended" });
    await terminal.submitEditorText("Complete the same saved blocked goal", { signal: t.signal });
    screens.complete = await terminal.waitForScreen(screen => screen.includes("gui-footer-settled:4 idle=true pending=false"), { signal: t.signal });
    assert.doesNotMatch(footer(screens.complete, 160).join("\n"), /\/goal (?:active|paused|blocked|complete)/u);
    assert.ok(footer(screens.complete, 160)[2]?.includes("pi-KillerOS"), "completion restores the workspace directory");
    assert.equal(requests, 11);
    await terminal.submitEditorText("/goal", { signal: t.signal });
    screens.panel = await terminal.waitForScreen(screen => screen.includes("Goal complete") && screen.includes("All checks passed")
      && screen.includes("→ Clear goal"), { signal: t.signal });
    const panelCursor = terminal.sequence;
    terminal.write("\x1b");
    await terminal.waitForScreen(screen => !screen.includes("→ Clear goal") && screen.includes("❯"),
      { signal: t.signal, after: panelCursor });
    const closed = await terminal.close();
    terminalClosed = true;
    assert.equal(closed.code, 0);
    assert.equal(closed.forced, false);
    assert.equal(closed.failure, undefined);
    rpc = new PiRpcProcess({ cliPath, cwd: project, env, args: [...args.slice(1), "--mode", "rpc", "--session", unlimitedFile] });
    await rpc.command("get_state", {}, { signal: t.signal });
    const after = rpc.currentSequence;
    await rpc.command("prompt", { message: "/goal" }, { signal: t.signal });
    const notice = await rpc.waitFor(record => record.type === "extension_ui_request" && record.method === "notify"
      && typeof record.message === "string" && record.message.includes("Goal complete") && record.message.includes("All checks passed"),
    { signal: t.signal, after });
    assert.ok(typeof notice.message === "string");
    assert.match(notice.message, /Goal complete/u);
    assert.match(notice.message, /All checks passed/u);
    assert.equal(requests, 11, "TUI and RPC /goal history inspection start no model turn");
    assert.deepEqual(scripted.size, 0);
    assert.deepEqual(providerFaults, []);
    const rpcExit = await rpc.close();
    rpcClosed = true;
    assert.equal(rpcExit.exit.code, 0);
    assert.equal(rpcExit.forced, false);
    assert.equal(rpcExit.treeCleanupError, undefined);
  } catch (error) { failures.push(error); }
  if (terminal && !terminalClosed) {
    try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics()); }
    catch (error) { failures.push(error); }
  }
  if (rpc && !rpcClosed) {
    try {
      const result = await rpc.close();
      assert.equal(result.exit.code, 0);
      assert.equal(result.forced, false);
      assert.equal(result.treeCleanupError, undefined);
    } catch (error) { failures.push(error); }
  }
  try {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { failures.push(error); }
  if (failures.length > 0) {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-footer-failure-"));
    throwScenarioFailure({ directory, message: "GUI-02 native footer lifecycle failed", errors: failures,
      diagnostics: JSON.stringify({ root, requests, checkedWidths, providerFaults, screens,
        terminal: terminal?.diagnostics(), rpc: rpc?.diagnostics() }, null, 2) });
  }
  await removeDirectoryEventually(root);
  assert.equal(existsSync(root), false);
  t.diagnostic(JSON.stringify({ scenarioId: "GUI-02", piLaunches: 2, providerRequests: requests, checkedWidths,
    durations: ["10s", "2m 05s", "1h 02m 05s"], historicalUndefinedLimit: "3 turns", qualification: "pending" }));
});
