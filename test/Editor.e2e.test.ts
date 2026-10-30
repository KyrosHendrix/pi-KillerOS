import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

// Catalog ID: ED-01. Assertions run on the actual component installed in native Pi.
test("Bordered editor, native navigation, autocomplete, and custom-factory preservation", { timeout: 240_000 }, async (t) => {
  const directory = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "killeros-editor-")));
  for (let ancestor = directory; ; ancestor = path.dirname(ancestor)) {
    assert.equal(existsSync(path.join(ancestor, ".git")), false, "Editor fixtures must not discover an ancestor Git repository");
    if (path.dirname(ancestor) === ancestor) break;
  }
  const dependencyLink = path.join(directory, "node_modules");
  const errors: unknown[] = [];
  const terminals: PiTerminalProcess[] = [];
  const screens: Record<string, string> = {};
  const requests: string[] = [];
  const faults: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) { assert.ok(chunk instanceof Uint8Array); chunks.push(Buffer.from(chunk)); }
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages));
      const last: unknown = body.messages.at(-1);
      assert.ok(typeof last === "object" && last !== null && "role" in last && last.role === "user" && "content" in last);
      const content: unknown = last.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: unknown) => {
        assert.ok(typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string");
        return part.text;
      }).join("") : undefined;
      assert.equal(text, "edited alpha\nbeta");
      requests.push(text);
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: "editor", model: "local", choices: [{ index: 0, delta: { content: "Editor interaction done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => { faults.push(error); response.writeHead(500); response.end(); });
  });
  try {
    symlinkSync(path.join(root, "node_modules"), dependencyLink, "junction");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = path.join(directory, "agent");
    const project = path.join(directory, "project");
    mkdirSync(agent);
    mkdirSync(project);
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(path.join(agent, "keybindings.json"), JSON.stringify({ "tui.altScreen.top": ["ctrl+home", "alt+t"] }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "editor-fixture": {
      api: "openai-completions", apiKey: "unused", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "local", name: "Editor fixture", reasoning: false, input: ["text"], contextWindow: 32000,
        maxTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    const report = path.join(directory, "report.json");
    const readPhysical = (): unknown => {
      const name = existsSync(path.join(directory, "physical.json")) ? "physical.json" : undefined;
      return name === undefined ? undefined : JSON.parse(readFileSync(path.join(directory, name), "utf8"));
    };
    const history = SessionManager.create(project, path.join(directory, "sessions"));
    history.appendMessage({ role: "user", content: "EDITOR transcript beginning", timestamp: Date.now() });
    history.appendMessage({ role: "assistant", content: [{ type: "text", text: Array.from({ length: 80 }, (_, i) => `Transcript marker ${i}`).join("\n") + "\nEDITOR transcript latest" }],
      api: "openai-completions", provider: "editor-fixture", model: "local", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const sessionFile = history.getSessionFile();
    assert.ok(sessionFile);
    const observer = path.join(directory, "editor.mjs");
    writeFileSync(observer, String.raw`import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
export default function(pi) {
  let editor, provider, keybindings, theme;
  pi.on("session_start", (_event, ctx) => {
    const factory = ctx.ui.getEditorComponent();
    assert.ok(factory);
    theme = ctx.ui.theme;
    ctx.ui.setEditorComponent((tui, editorTheme, keys) => {
      keybindings = keys;
      editor = factory(tui, editorTheme, keys);
      const render=editor.render.bind(editor);
      editor.render=width=>{
        const rows=render(width);
        const file = ${JSON.stringify(path.join(directory, "physical.json"))};
        writeFileSync(file + ".tmp",JSON.stringify({width,columns:process.stdout.columns,text:editor.getText(),rows:rows.map(stripTerminalSequences),widths:rows.map(visibleWidth)}));
        const deadline = Date.now() + 1_000;
        for (;;) {
          try { renameSync(file + ".tmp", file); break; }
          catch (error) {
            if (!error || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
        }
        if(width===60 && editor.getText()==="/" && rows.some(row=>row.includes("/auto-compact"))) {
          const lines=rows.map(stripTerminalSequences);
          writeFileSync(${JSON.stringify(path.join(directory, "alignment.json"))},JSON.stringify({
            border:lines[0],prompt:lines[1],aligned:lines.slice(2).every(line=>line.startsWith("  "))
          }));
        }
        return rows;
      };
      const setProvider = editor.setAutocompleteProvider.bind(editor);
      editor.setAutocompleteProvider = value => {
        provider = value;
        setProvider({
          ...value,
          getSuggestions: async (lines, row, col, options) => {
            const requestLines = [...lines];
            const result = await value.getSuggestions(lines, row, col, options);
            if (result && !options.signal.aborted && editor.getText() === "/"
              && requestLines.length === 1 && requestLines[0] === "/" && row === 0 && col === 1) {
              const file = ${JSON.stringify(path.join(directory, "suggestions-"))} + process.hrtime.bigint().toString().padStart(24, "0") + ".json";
              writeFileSync(file + ".tmp", JSON.stringify({ lines: requestLines, row, col, result }));
              renameSync(file + ".tmp", file);
            }
            return result;
          },
          applyCompletion: value.applyCompletion.bind(value),
          shouldTriggerFileCompletion: value.shouldTriggerFileCompletion?.bind(value),
        });
      };
      return editor;
    });
  });
  pi.registerCommand("fixture-editor", { description: "Check the live editor public component", handler: async (_args, ctx) => {
    try {
      const plain = width => editor.render(width).map(stripTerminalSequences);
      editor.setText(""); editor.focused = true;
      const empty = plain(40);
      assert.equal(empty[0], "─".repeat(40)); assert.equal(empty.length, 2);
      assert.match(empty[1], /^❯\u00a0Try "/u); assert.equal(visibleWidth(editor.render(40)[1]), 40);
      assert.doesNotMatch(empty[1], /─/u);
      assert.ok(editor.render(40)[1].includes("\x1b_pi:c\x07"));
      editor.focused=false;assert.ok(!editor.render(40)[1].includes("\x1b_pi:c\x07"));editor.focused=true;
      for(let width=1;width<=180;width++) {
        const rows=editor.render(width);
        assert.equal(visibleWidth(rows[0]),width,"border "+width);
        assert.equal(rows.length,2,"empty rows "+width);
        assert.ok(rows.every(row=>visibleWidth(row)<=width),"empty width "+width);
      }
      editor.setText("/model");
      assert.equal(plain(40)[1].slice(0,8),"❯\u00a0/model");
      assert.doesNotMatch(editor.render(40).join("\n"),/Try "|\x1b\[34m/u);
      assert.deepEqual(editor.render(0),[]);
      for(let width=1;width<=180;width++) assert.ok(editor.render(width).every(row=>visibleWidth(row)<=width),"typed width "+width);
      editor.setText("first");editor.handleInput("\x1b[13;2u");editor.handleInput("second");
      assert.equal(editor.getText(),"first\nsecond");
      const multi=plain(40);assert.equal(multi[0],"─".repeat(40));
      assert.match(multi[1],/^❯\u00a0first/u);assert.match(multi[2],/^  second/u);
      editor.setText("wrapped text ".repeat(20));
      const wrapped=plain(24);assert.equal(wrapped[0],"─".repeat(24));
      assert.match(wrapped[1],/^  ↑ \d+ more/u);assert.ok(wrapped.slice(2).every(row=>row.startsWith("  ")));
      editor.handleInput("\x1b[5~");assert.match(plain(24).at(-1),/^  ↓ \d+ more/u);
      for(const [home,end,top,bottom] of [["\x1b[H","\x1b[F","\x1b[1;5H","\x1b[1;5F"],["\x1b[7~","\x1b[8~","\x1b[7;5~","\x1b[8;5~"]]) {
        assert.equal(keybindings.matches(home,"tui.altScreen.top"),false);
        assert.equal(keybindings.matches(end,"tui.altScreen.bottom"),false);
        assert.equal(keybindings.matches(top,"tui.altScreen.top"),true);
        assert.equal(keybindings.matches(bottom,"tui.altScreen.bottom"),true);
        editor.setText("first\nsecond");editor.handleInput(home);editor.handleInput("A");assert.equal(editor.getText(),"first\nAsecond");
        editor.handleInput(bottom);editor.handleInput("B");assert.equal(editor.getText(),"first\nABsecond");
        editor.handleInput(end);editor.handleInput("C");assert.equal(editor.getText(),"first\nABsecondC");
        editor.handleInput(top);editor.handleInput("D");assert.equal(editor.getText(),"first\nABsecondCD");
      }
      editor.setText("hello");
      for(const focused of [false,true]) { editor.focused=focused;assert.ok(editor.render(20)[1].startsWith(theme.fg("text","❯\u00a0")+"hello")); }
      const result=await provider.getSuggestions(["/"],0,1,{});
      for(const command of ["logout","fork","clone","resume"]) {
        const item=result.items.find(item=>item.label==="/"+command);assert.ok(item);
        assert.doesNotMatch(item.description,new RegExp("/"+command+" \\["));
      }
      assert.ok(result.items.some(item=>item.label==="/exit"));
      for(const [line,col,expected] of [["/go",3,"/goal "],["/gokeep",3,"/goal keep"],["/go keep",3,"/goal  keep"],["prefix /go   keep",10,"prefix /goal    keep"],["prefix\t/go\t \tkeep",10,"prefix\t/goal \t \tkeep"]]) {
        const suggestions=await provider.getSuggestions([line],0,col,{});
        const goal=suggestions.items.find(item=>item.label==="/goal");assert.ok(goal);
        assert.deepEqual(provider.applyCompletion([line],0,col,goal,suggestions.prefix),{lines:[expected],cursorLine:0,cursorCol:line.startsWith("prefix")?13:6});
      }
      editor.setText("");editor.focused=true;
      writeFileSync(${JSON.stringify(report)},JSON.stringify({ok:true,widths:180,completionCases:5,navigationEncodings:2}));
      ctx.ui.notify("EDITOR assertions complete","info");
    } catch(error) {writeFileSync(${JSON.stringify(report)},JSON.stringify({error:String(error),stack:error.stack}));ctx.ui.notify("EDITOR assertions failed","error");}
  }});
}`);
    const custom = path.join(directory, "custom.mjs");
    writeFileSync(custom, String.raw`import assert from "node:assert/strict";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
export default function(pi) {
  const factory=(tui,theme,keys)=>new class extends CustomEditor {render(width){return ["CUSTOM FACTORY",...super.render(width)];}}(tui,theme,keys);
  pi.on("session_start",(_event,ctx)=>ctx.ui.setEditorComponent(factory));
  pi.registerCommand("fixture-custom",{description:"Check retained factory identity",handler:async(_args,ctx)=>{
    assert.equal(ctx.ui.getEditorComponent(),factory);ctx.ui.notify("CUSTOM identity preserved","info");
  }});
}`);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: directory, TMP: directory, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const launch = (extensions: string[]): PiTerminalProcess => {
      const terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 60, rows: 30,
        args: [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
          "--model", "editor-fixture/local", "--session", sessionFile, "--thinking", "off", "--tools", "read", "--offline", "--approve",
          "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
          ...extensions.flatMap(extension => ["--extension", extension])] });
      terminals.push(terminal);
      return terminal;
    };
    const terminal = launch([root, observer]);
    await terminal.waitForScreen(screen => screen.includes("❯") && screen.includes('Try "') && screen.includes("EDITOR transcript latest"), { signal: t.signal });
    await terminal.submitEditorText("/fixture-editor", { signal: t.signal });
    await terminal.waitForScreen(screen => screen.includes("EDITOR assertions"), { signal: t.signal });
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { ok: true, widths: 180, completionCases: 5, navigationEncodings: 2 });
    for (const [state, draft] of [["empty", ""], ["typed", "/model"], ["multiline", "first\nsecond"], ["wrapped", "wrapped text ".repeat(20)]]) {
      assert.ok(state !== undefined && draft !== undefined);
      if (draft !== "") terminal.write(`\x1b[200~${draft}\x1b[201~`);
      await terminal.waitForScreen(() => {
        const value = readPhysical();
        return typeof value === "object" && value !== null && "text" in value && value.text === draft;
      }, { signal: t.signal });
      for (let width = 1; width <= 180; width++) {
        const after = terminal.sequence;
        terminal.resize(width, 40);
        await terminal.waitForScreen((screen) => {
          const value = readPhysical();
          if (typeof value !== "object" || value === null || !("width" in value) || value.width !== width
            || !("columns" in value) || value.columns !== width) return false;
          assert.ok("text" in value && value.text === draft, `${state} draft at ${width}`);
          assert.ok("rows" in value && Array.isArray(value.rows) && value.rows.every((row: unknown) => typeof row === "string"));
          assert.equal(value.rows[0], "─".repeat(width), `${state} producer border at ${width}`);
          assert.ok("widths" in value && Array.isArray(value.widths));
          assert.ok(value.widths.every((size: unknown) => typeof size === "number" && size <= width), `${state} producer overflow at ${width}`);
          if (state === "empty") assert.equal(value.rows.length, 2, `empty row count at ${width}`);
          if (state === "typed" && width >= 9) assert.equal(value.rows.length, 2, `typed row count at ${width}`);
          if (state === "multiline") assert.ok(value.rows.length >= 3, `multiline rows at ${width}`);
          if (state === "multiline" && width >= 9) assert.equal(value.rows.length, 3, `multiline row count at ${width}`);
          if (state === "wrapped" && width < 100) assert.ok(value.rows.length > 2, `wrapped rows at ${width}`);
          return screen.split("\n").includes("─".repeat(width));
        }, { signal: t.signal, after });
      }
      terminal.resize(60, 30);
      await terminal.waitForScreen((screen) => screen.includes("─".repeat(60)), { signal: t.signal });
      for (let line = 0; line < draft.split("\n").length; line++) {
        terminal.write("\x1b[F\x15" + (line < draft.split("\n").length - 1 ? "\x7f" : ""));
      }
      await terminal.waitForScreen(() => {
        const value = readPhysical();
        return typeof value === "object" && value !== null && "text" in value && value.text === "";
      }, { signal: t.signal });
    }
    terminal.write("/");
    screens.autocomplete = await terminal.waitForScreen(screen => screen.includes("/auto-compact"), { signal: t.signal });
    const suggestionsFile = readdirSync(directory).filter(name => /^suggestions-\d{24}\.json$/u.test(name)).sort().at(-1);
    assert.ok(suggestionsFile, "source-167: native autocomplete published its slash request");
    const suggestionSnapshot: unknown = JSON.parse(readFileSync(path.join(directory, suggestionsFile), "utf8"));
    assert.ok(typeof suggestionSnapshot === "object" && suggestionSnapshot !== null && "lines" in suggestionSnapshot
      && "row" in suggestionSnapshot && "col" in suggestionSnapshot && "result" in suggestionSnapshot);
    assert.deepEqual([suggestionSnapshot.lines, suggestionSnapshot.row, suggestionSnapshot.col], [["/"], 0, 1]);
    const suggestionResult = suggestionSnapshot.result;
    assert.ok(typeof suggestionResult === "object" && suggestionResult !== null && "items" in suggestionResult
      && Array.isArray(suggestionResult.items));
    for (const command of ["logout", "fork", "clone", "resume"]) {
      const item: unknown = suggestionResult.items.find((value: unknown) => typeof value === "object" && value !== null
        && "label" in value && value.label === `/${command}`);
      assert.ok(typeof item === "object" && item !== null && "description" in item && typeof item.description === "string",
        `source-167: native autocomplete must offer /${command} with a description`);
      assert.doesNotMatch(item.description, new RegExp(`/${command} \\[`, "u"),
        `source-167: /${command} must not advertise unsupported arguments`);
    }
    assert.ok(suggestionResult.items.some((value: unknown) => typeof value === "object" && value !== null
      && "label" in value && value.label === "/exit"), "source-167: native autocomplete must offer /exit");
    t.diagnostic(JSON.stringify({ source: "test/Editor.test.ts:167#1", request: [suggestionSnapshot.lines, suggestionSnapshot.row, suggestionSnapshot.col],
      items: suggestionResult.items.filter((value: unknown) => typeof value === "object" && value !== null && "label" in value
        && ["/logout", "/fork", "/clone", "/resume", "/exit"].includes(String(value.label))) }));
    const alignment: unknown = JSON.parse(readFileSync(path.join(directory, "alignment.json"), "utf8"));
    assert.ok(typeof alignment === "object" && alignment !== null && "border" in alignment && "prompt" in alignment && "aligned" in alignment);
    assert.equal(alignment.border, "─".repeat(60));
    assert.equal(typeof alignment.prompt, "string");
    assert.match(String(alignment.prompt), /^❯\u00a0\//u);
    assert.equal(alignment.aligned, true);
    const rows = screens.autocomplete.split("\n");
    const prompt = rows.findIndex(row => /^❯\u00a0\//u.test(row));
    assert.ok(prompt > 0);
    assert.equal(rows[prompt - 1], "─".repeat(60));
    assert.ok(rows.slice(prompt + 1).some(row => row.includes("/auto-compact")));
    assert.ok(rows.slice(prompt + 1).filter(row => /\/auto-compact|\/goal/u.test(row)).every(row => row.startsWith("  ")));
    terminal.write("\x1b");
    await terminal.waitForScreen(screen => !screen.includes("/auto-compact") && screen.includes("❯"), { signal: t.signal });
    // Source 209 case 1 through native Tab: the accepted completion keeps the trailing space before later text.
    terminal.write("\x15");
    terminal.write("/go");
    await terminal.waitForScreen(screen => screen.split("\n").some(line => line.includes("❯") && line.trimEnd().endsWith("/go"))
      && screen.includes("/goal") && !screen.includes("/auto-compact"), { signal: t.signal });
    terminal.write("\t");
    await terminal.waitForScreen(screen => screen.split("\n").some(line => line.includes("❯") && line.trimEnd().endsWith("/goal"))
      && !screen.includes("/logout"), { signal: t.signal });
    terminal.write("keep");
    screens.completion = await terminal.waitForScreen(screen => screen.split("\n").some(line => line.includes("❯") && line.includes("/goal keep")), { signal: t.signal });
    terminal.write("\x15");
    await terminal.waitForScreen(screen => !screen.includes("/goal keep"), { signal: t.signal });
    terminal.write("\x15");
    terminal.write("first\x1b[13;2usecond");
    screens.multiline = await terminal.waitForScreen(screen => screen.includes("first") && screen.includes("second"), { signal: t.signal });
    terminal.write("\x1b[HA\x1b[1;5FB\x1b[FC\x1b[1;5HD");
    screens.navigation = await terminal.waitForScreen(screen => screen.includes("ABsecondCD"), { signal: t.signal });
    terminal.write("\x1b[F\x15\x7f\x15");
    await terminal.waitForScreen(() => {
      const value = readPhysical();
      return typeof value === "object" && value !== null && "text" in value && value.text === "";
    }, { signal: t.signal });
    terminal.write("first\x1b[13;2usecond");
    await terminal.waitForScreen(screen => screen.includes("first") && screen.includes("second"), { signal: t.signal });
    const beforeLegacyNavigation = terminal.sequence;
    terminal.write("\x1b[7~A\x1b[8;5~B\x1b[8~C\x1b[7;5~D");
    screens.navigationLegacy = await terminal.waitForScreen(screen => screen.includes("ABsecondCD"), { signal: t.signal, after: beforeLegacyNavigation });
    terminal.write("\x03");
    await terminal.waitForScreen(screen => !screen.includes("ABsecondCD"), { signal: t.signal });
    terminal.write("\x1b[200~alpha\nbeta\x1b[201~");
    await terminal.waitForScreen(screen => screen.includes("alpha") && screen.includes("beta"), { signal: t.signal });
    terminal.write("\x1b[A\x01edited ");
    screens.edited = await terminal.waitForScreen(screen => screen.includes("edited alpha") && screen.includes("beta"), { signal: t.signal });
    const beforeScroll = terminal.sequence;
    terminal.write("\x1b[5~");
    screens.pageUp = await terminal.waitForScreen(screen => screen.includes("Jump to latest message") && screen.includes("edited alpha") && screen.includes("beta"), { signal: t.signal, after: beforeScroll });
    terminal.write("\x1bt");
    screens.top = await terminal.waitForScreen(screen => screen.includes("EDITOR transcript beginning") && screen.includes("KillerOS")
      && screen.includes("Jump to latest message") && !screen.includes("EDITOR transcript latest"), { signal: t.signal });
    terminal.write("\x1b[1;5F");
    screens.bottom = await terminal.waitForScreen(screen => screen.includes("EDITOR transcript latest") && screen.includes("edited alpha") && screen.includes("beta"), { signal: t.signal });
    terminal.write("\x1b[13u");
    await terminal.waitForScreen(screen => screen.includes("Editor interaction done"), { signal: t.signal });
    assert.deepEqual(faults, []);
    assert.deepEqual(requests, ["edited alpha\nbeta"]);
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    const alternate = launch([custom, root]);
    await alternate.waitForScreen(screen => screen.includes("CUSTOM FACTORY"), { signal: t.signal });
    alternate.write("\x1b[200~/fixture-custom\x1b[201~");
    await alternate.waitForScreen(screen => screen.includes("/fixture-custom"), { signal: t.signal });
    alternate.write("\x1b[13u");
    await alternate.waitForScreen(screen => screen.includes("CUSTOM identity preserved"), { signal: t.signal });
    alternate.write("\x1b[200~/exit\x1b[201~");
    await alternate.waitForScreen(screen => screen.includes("/exit"), { signal: t.signal });
    alternate.write("\x1b[13u");
    await alternate.waitForScreen(screen => screen.includes("To resume this session:"), { signal: t.signal });
    assert.deepEqual(await alternate.close(), { code: 0, forced: false });
  } catch (error) { errors.push(error); }
  for (const terminal of terminals) {
    try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics()); }
    catch (error) { errors.push(error); }
  }
  try {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } catch (error) { errors.push(error); }
  try { if (existsSync(dependencyLink)) unlinkSync(dependencyLink); }
  catch (error) { errors.push(error); }
  if (errors.length) {
    throwScenarioFailure({ directory, message: "ED-01 failed; fixture retained for diagnosis", errors,
      diagnostics: JSON.stringify({ screens, terminals: terminals.map(terminal => terminal.diagnostics()) }) });
  }
  await removeDirectoryEventually(directory);
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: "ED-01", piLaunches: terminals.length, providerRequests: requests.length,
    physicalResizes: 720, nativeCompletionCases: 1, navigationEncodings: 2, cleanup: "natural",
    retiredByStaticReview: ["test/Editor.test.ts:43#1:45-46 source-shape regexes"],
    unproved: ["test/PiExtensionContract.test.ts:190#1 questions and packed-package allocations remain in their original registration"] }));
});
