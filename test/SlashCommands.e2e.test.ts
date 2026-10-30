import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function strings(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  return value.map((item: unknown) => { assert.equal(typeof item, "string"); return String(item); });
}

// The observer composes the editor installed by KillerOS. It never supplies a replacement editor or resolver.
async function fixture(t: TestContext, id: string, run: (actor: {
  launch(): PiTerminalProcess;
  read(): Record<string, unknown>;
  draft(terminal: PiTerminalProcess, text: string): Promise<Record<string, unknown>>;
  removeCommands(): void;
  requestSeen: Promise<void>;
}) => Promise<void>): Promise<void> {
  const temporary = realpathSync(tmpdir());
  for (let ancestor = temporary; ; ancestor = path.dirname(ancestor)) {
    assert.equal(existsSync(path.join(ancestor, ".git")), false, "Slash scratch must have no repository ancestor");
    if (path.dirname(ancestor) === ancestor) break;
  }
  const directory = mkdtempSync(path.join(temporary, ".killeros-slash-"));
  const terminals: PiTerminalProcess[] = [];
  const failures: unknown[] = [];
  let requests = 0;
  let cancelled = 0;
  let seen: (() => void) | undefined;
  const requestSeen = new Promise<void>(resolve => { seen = resolve; });
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    response.write(`data: ${JSON.stringify({ id: "slash", choices: [{ index: 0, delta: { content: "SLASH active barrier" }, finish_reason: null }] })}\n\n`);
    response.on("close", () => { cancelled++; });
    seen?.();
  });
  const report = path.join(directory, "report.json");
  const dynamic = path.join(directory, "dynamic.mjs");
  const removed = path.join(directory, "removed");
  try {
    symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = path.join(directory, "agent");
    const project = path.join(directory, "project");
    mkdirSync(agent); mkdirSync(project);
    mkdirSync(path.join(agent, "prompts")); mkdirSync(path.join(agent, "skills", "review"), { recursive: true });
    writeFileSync(path.join(agent, "prompts", "release.md"), "---\ndescription: Release fixture\n---\nRelease fixture");
    writeFileSync(path.join(agent, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review fixture\n---\nReview fixture");
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "slash-fixture": {
      api: "openai-completions", apiKey: "unused", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "local", name: "Slash fixture", reasoning: false, input: ["text"], contextWindow: 32000,
        maxTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    writeFileSync(dynamic, `import {existsSync} from "node:fs"; export default function(pi) { pi.registerCommand(existsSync(${JSON.stringify(removed)})?"new-command":"variants",{description:"Dynamic fixture",handler:async()=>{}}); }`);
    const base = path.join(directory, "base.mjs");
    writeFileSync(base, String.raw`import {existsSync} from "node:fs";
export default function(pi) {
  pi.registerCommand("unsafe\x1b]2;owned\x07",{description:"Unsafe fixture",handler:async()=>{}});
  pi.registerCommand("hostile",{description:"Run \x1b]2;owned\x07\x1b[31msafely\x1b[0m\0\nnext",handler:async()=>{}});
  pi.on("session_start",(_event,ctx)=>ctx.ui.addAutocompleteProvider(current=>({
    ...current,
    getSuggestions:async(lines,row,col,options)=>{
      const result=await current.getSuggestions(lines,row,col,options);
      if(lines[row].slice(0,col)!=="/" || existsSync(${JSON.stringify(removed)})) return result;
      return {prefix:"/",items:[...(result?.items??[]),{value:"/fallback ",label:"/fallback",description:"Fallback \x1b]2;owned\x07\x1b[31mcommand\x1b[0m\0"}]};
    },
    applyCompletion:current.applyCompletion.bind(current)
  })));
}`);
    const observer = path.join(directory, "observer.mjs");
    writeFileSync(observer, String.raw`import {writeFileSync,renameSync} from "node:fs";
import {CURSOR_MARKER,visibleWidth,stripTerminalSequences} from "@earendil-works/pi-tui";
export default function(pi) {
  const state={sessions:[],events:[],suggestions:{result:{items:[]}},commands:[]};
  const save=()=>{const target=${JSON.stringify(report)}+"."+process.hrtime.bigint().toString().padStart(24,"0")+".json";writeFileSync(target+".tmp",JSON.stringify(state));renameSync(target+".tmp",target);};
  pi.on("agent_end",(event,ctx)=>{state.events.push({event:"agent_end",idle:ctx.isIdle(),messages:event.messages.map(({role,stopReason})=>({role,stopReason}))});save();});
  pi.on("session_shutdown",(_event,ctx)=>{state.events.push({event:"shutdown",idle:ctx.isIdle()});save();});
  pi.on("session_start",(_event,ctx)=>{
    state.sessions.push(ctx.sessionManager.getSessionId());
    state.commands=pi.getCommands().map(({name,description,source})=>({name,description,source}));
    const factory=ctx.ui.getEditorComponent();
    if(!factory) throw Error("KillerOS editor missing");
    const [open,close]=ctx.ui.theme.fg("mdLink","SLASH_STYLE").split("SLASH_STYLE");
    ctx.ui.setEditorComponent((tui,theme,keys)=>{
      const editor=factory(tui,theme,keys);
      const render=editor.render.bind(editor);
      editor.render=width=>{
        const rows=render(width);
        const styled=rows.flatMap(row=>row.split(open).slice(1).map(part=>stripTerminalSequences(part.split(close)[0])));
        state.render={text:editor.getText(),width,columns:process.stdout.columns,rows,plain:rows.map(stripTerminalSequences),widths:rows.map(visibleWidth),styled,cursor:rows.some(row=>row.includes(CURSOR_MARKER))};
        save(); return rows;
      };
      const set=editor.setAutocompleteProvider.bind(editor);
      editor.setAutocompleteProvider=provider=>set({
        ...provider,
        getSuggestions:async(lines,row,col,options)=>{
          const result=await provider.getSuggestions(lines,row,col,options);
          state.suggestions={lines:[...lines],row,col,options,result};save();return result;
        },
        applyCompletion:provider.applyCompletion.bind(provider)
      });
      return editor;
    });
    save();ctx.ui.notify("SLASH observer ready","info");
  });
}`);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: directory, TMP: directory, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const read = (): Record<string, unknown> => {
      const snapshot = readdirSync(directory).filter(name => name.startsWith("report.json.") && name.endsWith(".json")).sort().at(-1);
      assert.ok(snapshot, "Observer has not published a snapshot");
      return record(JSON.parse(readFileSync(path.join(directory, snapshot), "utf8")));
    };
    await run({
      launch: () => {
        const terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 100, rows: 40,
          args: [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
            "--model", "slash-fixture/local", "--thinking", "off", "--tools", "read", "--offline", "--approve",
            "--no-context-files", "--no-themes", "--no-mcp", "--no-extensions",
            "--extension", base, "--extension", dynamic, "--extension", root, "--extension", observer] });
        terminals.push(terminal); return terminal;
      },
      read,
      draft: async (terminal, text) => {
        const current = String(record(read().render).text);
        for (let line = 0; line < current.split("\n").length; line++) terminal.write("\x1b[F\x15" + (line < current.split("\n").length - 1 ? "\x7f" : ""));
        await terminal.waitForScreen(() => record(read().render).text === "", { signal: t.signal });
        const after = terminal.sequence;
        terminal.write(`\x1b[200~${text}\x1b[201~`);
        if (text.includes("\t")) t.diagnostic(`Unproved exact editor storage for ${JSON.stringify(text)}: native Pi normalizes tabs to four spaces.`);
        await terminal.waitForScreen(() => record(read().render ?? {}).text === text.replaceAll("\t", "    "), { signal: t.signal, after });
        return record(read().render);
      },
      removeCommands: () => writeFileSync(removed, "removed"),
      requestSeen,
    });
    assert.equal(requests, id === "SL-03" ? 1 : 0);
    if (id === "SL-03") assert.equal(cancelled, 1);
  } catch (error) { failures.push(error); }
  for (const terminal of terminals) {
    try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics()); }
    catch (error) { failures.push(error); }
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (failures.length) {
    t.diagnostic(JSON.stringify({ directory, requests, cancelled, failures: failures.map(error => error instanceof Error ? { message: error.message, stack: error.stack } : String(error)) }));
    throw new AggregateError(failures, `${id} failed; fixture retained`);
  }
  await removeDirectoryEventually(directory);
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: id, piLaunches: terminals.length, providerRequests: requests, cancelled, cleanup: "natural" }));
}

function items(state: Record<string, unknown>): Record<string, unknown>[] {
  const result = record(state.suggestions).result;
  if (result === null || result === undefined) return [];
  const value = record(result).items;
  assert.ok(Array.isArray(value)); return value.map(record);
}

function reloaded(state: Record<string, unknown>): boolean {
  if (!Array.isArray(state.commands)) return false;
  const names = state.commands.map(record).map(command => command.name);
  return names.includes("new-command") && !names.includes("variants")
    && record(state.render ?? {}).text === "";
}

// Catalog ID: SL-01.
test("Slash tokenization, resolution, and highlighting agree in the live editor", { timeout: 240_000 }, async t => {
  await fixture(t, "SL-01", async actor => {
    const terminal = actor.launch();
    await terminal.waitForScreen(screen => screen.includes("SLASH observer ready"), { signal: t.signal });
    for (const [text, expected] of [
      ["/goal review this file", ["/goal"]], ["/go", []], ["/goalx", []], ["/does-not-exist", []],
      ["/src/index.ts", []], ["https://example.com", []], ["//comment", []], ["/goal,", []],
      ["prose /goal /variants", ["/goal", "/variants"]],
      ["/goal /variants\t/skill:review", ["/goal", "/variants", "/skill:review"]],
      ["https://example.com /src/index.ts //comment", []], ["\t/goal", ["/goal"]], ["(/goal", []],
      ["/settings /exit /handoff /release /skill:review", ["/settings", "/exit", "/handoff", "/release", "/skill:review"]],
    ] as const) {
      const rendered = await actor.draft(terminal, text);
      assert.deepEqual(rendered.styled, expected, text);
      assert.ok(strings(rendered.plain).join("\n").replaceAll(/\s+/gu, " ").includes(text.replaceAll(/\s+/gu, " ")), text);
    }
    const originalCursor = await actor.draft(terminal, "x /goal args");
    const after = terminal.sequence;
    terminal.write("\x01\x1b[C\x1b[C\x1b[C\x1b[C");
    await terminal.waitForScreen(() => record(actor.read().render).cursor === true, { signal: t.signal, after });
    const cursor = record(actor.read().render);
    assert.equal(cursor.text, "x /goal args");
    assert.equal(strings(cursor.styled).join(""), "/goal");
    assert.ok(strings(cursor.rows).join("\n").includes("\x1b_pi:fc\x07"));
    assert.ok(strings(cursor.plain).join("\n").includes("x /goal args"));
    assert.deepEqual(cursor.widths, originalCursor.widths);
    for (const text of ["prefix /go", "\t/goal"]) {
      await actor.draft(terminal, text);
      terminal.write("\t");
      await terminal.waitForScreen(() => items(actor.read()).some(item => item.label === "/goal"), { signal: t.signal });
    }
    for (const text of ["https://example.com", "(/goal"]) {
      await actor.draft(terminal, text); terminal.write("\t");
      await terminal.waitForScreen(() => strings(record(actor.read().suggestions).lines).join("\n") === text, { signal: t.signal });
      assert.ok(!items(actor.read()).some(item => item.label === "/goal"), text);
    }
    await actor.draft(terminal, "prefix /vari"); terminal.write("\t");
    await terminal.waitForScreen(() => {
      const state = actor.read();
      return JSON.stringify(record(state.suggestions).lines) === JSON.stringify(["prefix /vari"])
        && items(state).some(item => item.label === "/variants");
    }, { signal: t.signal });
    await terminal.waitForScreen(() => record(actor.read().render).text === "prefix /variants ", { signal: t.signal });
    actor.removeCommands();
    await actor.draft(terminal, "/reload"); terminal.write("\x1b[13u");
    await terminal.waitForScreen(() => reloaded(actor.read()), { signal: t.signal });
    assert.deepEqual((await actor.draft(terminal, "/variants /new-command")).styled, ["/new-command"]);
    await actor.draft(terminal, "prefix /new-com"); terminal.write("\t");
    await terminal.waitForScreen(() => {
      const state = actor.read();
      return JSON.stringify(record(state.suggestions).lines) === JSON.stringify(["prefix /new-com"])
        && items(state).some(item => item.label === "/new-command");
    }, { signal: t.signal });
    await terminal.waitForScreen(() => record(actor.read().render).text === "prefix /new-command ", { signal: t.signal });
    t.diagnostic("Token offsets and injected ANSI fragments are private; native cursor splitting and completion replacement are exercised.");
  });
});

// Catalog ID: SL-02.
test("Editor and autocomplete use the shared resolver, theme role, and safe widths", { timeout: 240_000 }, async t => {
  await fixture(t, "SL-02", async actor => {
    const terminal = actor.launch();
    await terminal.waitForScreen(screen => screen.includes("SLASH observer ready"), { signal: t.signal });
    const multiline = await actor.draft(terminal, "/goal review\n/variants");
    assert.deepEqual(multiline.styled, ["/goal", "/variants"]);
    assert.equal(multiline.cursor, true);
    for (let width = 1; width <= 100; width++) {
      const after = terminal.sequence;
      terminal.resize(width, 40);
      await terminal.waitForScreen(() => {
        const rendered = record(actor.read().render);
        if (rendered.width !== width || rendered.columns !== width) return false;
        assert.equal(rendered.text, "/goal review\n/variants");
        assert.ok(Array.isArray(rendered.widths));
        assert.ok(rendered.widths.every((size: unknown) => typeof size === "number" && size <= width), `producer width ${width}`);
        return true;
      }, { signal: t.signal, after });
    }
    terminal.resize(100, 40);
    await terminal.waitForScreen(() => record(actor.read().render).width === 100, { signal: t.signal });
    await actor.draft(terminal, "/"); terminal.write("\t");
    await terminal.waitForScreen(() => items(actor.read()).some(item => item.label === "/fallback"), { signal: t.signal });
    const suggestions = items(actor.read());
    assert.ok(suggestions.some(item => item.label === "/goal"));
    assert.equal(suggestions.find(item => item.label === "/hostile")?.description, "[Extension] Run safely next");
    assert.equal(suggestions.find(item => item.label === "/fallback")?.description, "[Built-in] Fallback command");
    assert.ok(!suggestions.some(item => String(item.label).includes("unsafe")));
    assert.equal(suggestions.find(item => item.label === "/auto-compact")?.description,
      "[Extension] /auto-compact [status|on|off|<percent>] — Inspect or change automatic compaction");
    assert.equal(suggestions.find(item => item.label === "/handoff")?.description,
      "[Extension] /handoff [next-session focus] — Create a fresh session with a continuation handoff");
    assert.deepEqual((await actor.draft(terminal, "/fallback ")).styled, ["/fallback"]);
    assert.ok(!terminal.titles.includes("owned"));
    actor.removeCommands();
    await actor.draft(terminal, "/reload"); terminal.write("\x1b[13u");
    await terminal.waitForScreen(() => reloaded(actor.read()), { signal: t.signal });
    await actor.draft(terminal, "/"); terminal.write("\t");
    await terminal.waitForScreen(() => {
      const state = actor.read();
      return JSON.stringify(record(state.suggestions).lines) === JSON.stringify(["/"])
        && items(state).some(item => item.label === "/new-command")
        && !items(state).some(item => item.label === "/variants" || item.label === "/fallback");
    }, { signal: t.signal });
    assert.ok(items(actor.read()).some(item => item.label === "/goal"));
    assert.ok(!items(actor.read()).some(item => item.label === "/fallback"));
    assert.deepEqual((await actor.draft(terminal, "/variants")).styled, []);
    assert.deepEqual((await actor.draft(terminal, "/fallback ")).styled, []);
    t.diagnostic("Unproved exact source inputs: hostile /handoff metadata is /hostile because KillerOS owns handoff; removing all commands/goal cannot use native unregister. Legacy cases retained.");
  });
});

// Catalog ID: SL-03.
test("Goal completions and /exit follow lifecycle contracts", { timeout: 240_000 }, async t => {
  await fixture(t, "SL-03", async actor => {
    const idle = actor.launch();
    await idle.waitForScreen(screen => screen.includes("SLASH observer ready"), { signal: t.signal });
    const commands = actor.read().commands;
    assert.ok(Array.isArray(commands));
    const extensionCommands = strings(commands.map(record).filter(command => command.source === "extension").map(command => command.name));
    const fixtureCommands = new Set(["variants", "hostile", "unsafe\x1b]2;owned\x07"]);
    assert.deepEqual(extensionCommands.filter(name => !fixtureCommands.has(name)).sort(),
      ["auto-compact", "codex-fast", "exit", "goal", "handoff", "notification"]);
    assert.ok(!extensionCommands.includes("quit")); assert.ok(!extensionCommands.includes("new"));
    assert.equal(commands.map(record).find(command => command.name === "goal")?.description, "Set a non-command objective or view the current goal");
    await actor.draft(idle, "/goal x"); idle.write("\x7f");
    let completion: Record<string, unknown> = {};
    await idle.waitForScreen(() => {
      const state = actor.read();
      const suggestions = record(state.suggestions);
      if (record(state.render).text !== "/goal " || suggestions.row !== 0 || suggestions.col !== 6
        || JSON.stringify(suggestions.lines) !== JSON.stringify(["/goal "])) return false;
      if (!items(state).some(item => item.value === "clear")) return false;
      completion = state;
      return true;
    }, { signal: t.signal });
    assert.deepEqual(items(completion).map(item => item.value), ["clear", "edit", "pause", "resume"]);
    const before = strings(actor.read().sessions).at(-1);
    assert.ok(before);
    await actor.draft(idle, "/new"); idle.write("\x1b[13u");
    await idle.waitForScreen(() => {
      const sessions = actor.read().sessions;
      return Array.isArray(sessions) && sessions.at(-1) !== before;
    }, { signal: t.signal });
    const sessions = strings(actor.read().sessions);
    assert.notEqual(sessions.at(-1), before);
    await idle.submitEditorText("/exit", { signal: t.signal });
    assert.deepEqual(await idle.close(), { code: 0, forced: false });
    assert.deepEqual(actor.read().events, [{ event: "shutdown", idle: true }]);
    const active = actor.launch();
    await active.waitForScreen(screen => screen.includes("SLASH observer ready"), { signal: t.signal });
    await active.submitEditorText("hold slash request", { signal: t.signal });
    await active.waitForScreen(screen => screen.includes("SLASH active barrier"), { signal: t.signal });
    await actor.requestSeen;
    await active.submitEditorText("/exit", { signal: t.signal });
    assert.deepEqual(await active.close(), { code: 0, forced: false });
    const events = actor.read().events;
    assert.ok(Array.isArray(events));
    assert.deepEqual(events.map(record).map(event => event.event), ["agent_end", "shutdown"]);
    const ended = record(events[0]);
    assert.ok(Array.isArray(ended.messages));
    assert.ok(ended.messages.map(record).some(message => message.role === "assistant" && message.stopReason === "aborted"));
    assert.equal(record(events[1]).idle, true);
    t.diagnostic("Native active exit records an aborted assistant response before idle shutdown and closes the streaming provider; exact method calls and close ordering remain unproved.");
  });
});
