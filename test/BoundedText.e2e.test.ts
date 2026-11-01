import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, symlinkSync,
  writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = ["long ".repeat(100), "中", "中日文".repeat(30), "😀👩‍💻".repeat(20), "e\u0301".repeat(100),
  "中\n😀\ne\u0301\n".repeat(10),
  Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")] as const;

type SourceIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type BoundedScenario = {
  id: "BT-01" | "BT-02";
  sourceIndices: readonly [SourceIndex, ...SourceIndex[]];
};

/** Pi discovers repository and Git state by walking upward, so fixtures live outside the checkout. */
function assertFixtureOutsideGit(directory: string): void {
  for (const candidate of new Set([directory, realpathSync(directory)])) {
    for (let ancestor = candidate; ; ancestor = path.dirname(ancestor)) {
      if (existsSync(path.join(ancestor, ".git"))) throw new Error(`BoundedText fixture has a Git ancestor: ${ancestor}`);
      if (path.dirname(ancestor) === ancestor) break;
    }
  }
}

/** Removes only this run's temp root after confirming its dependency entry is still the owned junction. */
async function removeFixtureRoot(directory: string): Promise<void> {
  const temp = realpathSync(os.tmpdir());
  assert.equal(path.dirname(directory), temp, "BoundedText cleanup must target an owned temp directory");
  assert.ok(path.basename(directory).startsWith(".killeros-bounded-text-"));
  assert.equal(realpathSync(directory), directory, "BoundedText root must remain a physical directory");
  const dependencies = path.join(directory, "node_modules");
  let dependencyEntry: ReturnType<typeof lstatSync> | undefined;
  try {
    dependencyEntry = lstatSync(dependencies);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (dependencyEntry) {
    assert.ok(dependencyEntry.isSymbolicLink(), "BoundedText dependencies must remain an owned junction");
    assert.equal(realpathSync(dependencies).toLowerCase(), realpathSync(path.join(root, "node_modules")).toLowerCase(),
      "BoundedText dependencies must still target the checkout dependencies");
    rmdirSync(dependencies);
  }
  await removeDirectoryEventually(directory);
}

function transcriptBlock(screen: string, begin: string, end: string): string[] {
  const rows = screen.split("\n").map(row => row.trimEnd());
  const start = rows.findIndex(row => row.trim() === begin);
  const finish = rows.findIndex((row, index) => index > start && row.trim() === end);
  assert.ok(start >= 0 && finish > start, `native transcript markers ${begin}/${end} must delimit the tool`);
  return rows.slice(start + 1, finish).filter(row => row.trim() !== "");
}

// Both scenarios drive the real native renderers, starting directly at their first owned history.
async function runBoundedScenario(t: TestContext, { id, sourceIndices }: BoundedScenario): Promise<void> {
  const directory = mkdtempSync(path.join(realpathSync(os.tmpdir()), ".killeros-bounded-text-"));
  const dependencies = path.join(directory, "node_modules");
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "project");
  const sessions = path.join(directory, "sessions");
  const files = new Map<SourceIndex, string>();
  const errors: unknown[] = [];
  let terminal: PiTerminalProcess | undefined;
  let lastScreen = "";
  let lastVector: unknown;
  try {
    assertFixtureOutsideGit(directory);
    symlinkSync(realpathSync(path.join(root, "node_modules")), dependencies, "junction");
    for (const folder of [agent, project, sessions]) mkdirSync(folder);
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
      compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "bounded-fixture": {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "bounded-fixture-key",
      models: [{ id: "local", name: "Bounded fixture", reasoning: false, input: ["text"], contextWindow: 32000,
        maxTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }));
    for (const index of sourceIndices) {
      const source = sources[index];
      const session = SessionManager.create(project, sessions);
      session.appendMessage({ role: "user", content: `Bounded history ${index}`, timestamp: 1 });
      session.appendCustomMessageEntry("bounded-marker", "§", true);
      for (const [toolName, after] of [["question", "¶"], ["killeros_goal_update", "¤"]] as const) {
        const id = `${toolName}-${index}`;
        session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: toolName,
          arguments: toolName === "question" ? { question: "Q", options: [{ label: "Yes" }] } : { status: "complete" } }],
        api: "openai-completions", provider: "bounded-fixture", model: "local", stopReason: "toolUse", timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        session.appendMessage({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text: source }],
          details: undefined, isError: toolName === "killeros_goal_update", timestamp: 1 });
        session.appendCustomMessageEntry("bounded-marker", after, true);
      }
      // A trailing native message publishes the PTY width without changing the delimited tool blocks.
      session.appendCustomMessageEntry("bounded-width", "width", true);
      const file = session.getSessionFile();
      assert.ok(file);
      files.set(index, file);
    }
    const observer = path.join(directory, "bounded.mjs");
    writeFileSync(observer, `import { Text, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
export default function(pi) {
  let observed = {};
  let sourceIndex = -1;
  let requests = 0;
  const published = new Set();
  pi.on("session_start", (_event, ctx) => {
    sourceIndex = ${JSON.stringify([...files])}.find(([, file]) => file === ctx.sessionManager.getSessionFile())?.[0] ?? -1;
    observed = {};
  });
  pi.registerToolRenderer((name, next) => {
    const renderer = next();
    if (!["question", "killeros_goal_update"].includes(name) || !renderer?.renderResult) return renderer;
    return { ...renderer, renderResult(result, options, theme, context) {
      const component = renderer.renderResult(result, options, theme, context);
      return { render(width) {
        const rows = component.render(width);
        observed[name] = { width, columns: process.stdout.columns, expanded: options.expanded,
          rows: rows.map(stripTerminalSequences), widths: rows.map(visibleWidth) };
        const key = sourceIndex + "-" + options.expanded + "-" + process.stdout.columns;
        const complete = sourceIndex >= 0 && ["question", "killeros_goal_update"].every(tool =>
          observed[tool]?.columns === process.stdout.columns && observed[tool]?.expanded === options.expanded);
        if (complete && !published.has(key)) {
          const file = ${JSON.stringify(path.join(directory, "producer-"))} + key + "-" + randomUUID() + ".json";
          writeFileSync(file + ".tmp", JSON.stringify(observed), { flag: "wx" });
          renameSync(file + ".tmp", file);
          published.add(key);
        }
        return rows;
      }, invalidate() { component.invalidate?.(); } };
    }};
  });
  pi.registerShortcut("ctrl+alt+r", { description: "Repaint bounded transcript", handler: async (ctx) => {
    let terminalUI;
    await ctx.ui.custom((tui, _theme, _keys, done) => {
      terminalUI = tui;
      setImmediate(() => done(undefined));
      return new Text("", 0, 0);
    });
    terminalUI.requestRender(true);
    writeFileSync(${JSON.stringify(path.join(directory, "repaint-"))} + sourceIndex + ".json", JSON.stringify({ columns: process.stdout.columns }));
  }});
  pi.registerMessageRenderer("bounded-marker", message => new Text(message.content, 0, 0));
  pi.registerMessageRenderer("bounded-width", () => {
    const probe = new Text("", 0, 0);
    return { render(width) {
      probe.setText("[I" + sourceIndex + "W" + process.stdout.columns + "W]");
      return probe.render(width);
    }, invalidate() { probe.invalidate(); } };
  });
  pi.registerCommand("bounded-switch", { description: "Select saved native tool results", handler: async (args, ctx) => {
    const file = ${JSON.stringify(Object.fromEntries(files))}[Number(args)];
    if (!file) throw new Error("Unknown bounded history");
    if ((await ctx.switchSession(file)).cancelled) throw new Error("Bounded history switch cancelled");
  }});
  pi.on("before_provider_request", () => { requests++; throw new Error("Bounded transcript inspection must not start model work"); });
  pi.on("session_shutdown", () => { writeFileSync(${JSON.stringify(path.join(directory, "requests.json"))}, JSON.stringify(requests)); });
}`);
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      TEMP: directory, TMP: directory, PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const firstIndex = sourceIndices[0];
    const first = files.get(firstIndex);
    assert.ok(first);
    terminal = new PiTerminalProcess({ file: process.execPath, cwd: project, env, cols: 80, rows: 80,
      args: [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        "--model", "bounded-fixture/local", "--thinking", "off", "--tools", "question,killeros_*", "--session", first,
        "--session-dir", sessions, "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-mcp", "--no-extensions", "--extension", root, "--extension", observer] });
    await terminal.waitForScreen(screen => screen.includes(`Bounded history ${firstIndex}`) && screen.includes("¤") && screen.includes("❯"), { signal: t.signal });
    for (const [position, index] of sourceIndices.entries()) {
      const source = sources[index];
      if (position > 0) {
        await terminal.submitEditorText(`/bounded-switch ${index}`, { signal: t.signal });
        await terminal.waitForScreen(screen => screen.includes(`Bounded history ${index}`) && screen.includes("¤"), { signal: t.signal });
      }
      terminal.write("z");
      await terminal.waitForScreen(screen => screen.includes("❯\u00a0z"), { signal: t.signal });
      for (const expanded of [false, true]) {
        if (expanded) terminal.write("\x0f");
        for (let width = 1; width <= 80; width++) {
          lastVector = { index, expanded, width };
          const after = terminal.sequence;
          const producerRows = new Map<string, string[]>();
          // Keep both complete tool blocks visible without repainting 1,600 mostly empty rows at every width.
          const rows = width < 20 ? 1_600 : Math.max(300, Math.ceil(source.length * 4 / (width - 4)) + 200);
          terminal.resize(width, rows);
          let repainted = false;
          const activeTerminal = terminal;
          lastScreen = await terminal.waitForScreen(screen => {
            const prefix = `producer-${index}-${expanded}-${width}-`;
            const snapshot = readdirSync(directory).find(name => name.startsWith(prefix) && name.endsWith(".json"));
            if (snapshot === undefined) return false;
            const observed: unknown = JSON.parse(readFileSync(path.join(directory, snapshot), "utf8"));
            if (typeof observed !== "object" || observed === null) return false;
            for (const name of ["question", "killeros_goal_update"]) {
              if (!(name in observed)) return false;
              const item: unknown = Reflect.get(observed, name);
              if (typeof item !== "object" || item === null || !("columns" in item) || item.columns !== width
                || !("expanded" in item) || item.expanded !== expanded) return false;
              assert.ok("width" in item && typeof item.width === "number");
              const contentWidth = item.width;
              assert.ok("rows" in item && Array.isArray(item.rows) && item.rows.every((row: unknown) => typeof row === "string"));
              producerRows.set(name, item.rows);
              if (contentWidth <= 0) assert.deepEqual(item.rows, [], "zero-width native nested results render no rows");
              assert.ok("widths" in item && Array.isArray(item.widths));
              assert.ok(item.widths.every((size: unknown) => typeof size === "number" && size <= contentWidth), "producer rows fit their actual native content width");
              if (!expanded) assert.ok(item.rows.length <= (name === "question" ? 3 : 1), "producer obeys its collapsed row limit");
              if (index === 6 && width === 22 && name === "question") {
                assert.equal(contentWidth, 20, "The multiline source reaches its original 20-cell renderer width");
                assert.equal(item.rows.length, expanded ? 20 : 3);
                if (expanded) {
                  assert.deepEqual(item.rows.map(row => row.trimEnd()),
                    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
                } else {
                  assert.deepEqual(item.rows.slice(0, 2).map(row => row.trimEnd()), ["line 1", "line 2"]);
                  assert.match(item.rows.at(-1)?.trimEnd() ?? "", /^line 3 +…$/u);
                }
              }
              if (expanded && width === 80) {
                const compact = (text: string): string => text.replace(/\s/gu, "");
                assert.equal(compact(item.rows.join("")), compact(source), "producer preserves every expanded source character before terminal cell parsing");
                if (index === 3) assert.equal(item.rows.map(row => row.trimEnd()).join(""), source, "emoji producer frame preserves every grapheme");
                if (index === 0) {
                  const expected = [...Array.from({ length: 6 }, () => "long ".repeat(14) + "long"), "long ".repeat(9) + "long"];
                  assert.deepEqual(item.rows.map(row => row.trimEnd()), expected, "producer preserves spaces within each wrapped row");
                }
              }
            }
            if (expanded && width === 80) {
              if (!repainted) {
                repainted = true;
                activeTerminal.write("\x1b[114;7u");
                return false;
              }
              if (!existsSync(path.join(directory, `repaint-${index}.json`))) return false;
            }
            const screenRows = screen.split("\n");
            // Fullscreen chrome can differ from the PTY width (the failing run showed a 79-cell
            // editor border at 80 columns). The trailing native message renders the current session
            // and PTY width; joining rows keeps its token visible when it wraps at width 1.
            if (!screenRows.join("").includes(`[I${index}W${width}W]`)) return false;
            if (expanded && width === 80 && !screen.includes("❯\u00a0z")) return false;
            const markers = ["§", "¶", "¤"].map(marker => screenRows.findIndex(row => row.trim() === marker));
            if (markers[0] < 0 || markers[1] <= markers[0] || markers[2] <= markers[1]) return false;
            // ConPTY/xterm interpret emoji and combining cells differently from Pi. The producer
            // assertion checks every source grapheme; compare parsed rows for ASCII and CJK.
            if (expanded && (width === 80 && index < 3 || index === 6 && width === 22)) {
              for (const [name, begin, end] of [["question", "§", "¶"], ["killeros_goal_update", "¶", "¤"]] as const) {
                const expected = producerRows.get(name)?.map(row => row.trim()).filter(row => row !== "");
                if (!expected) return false;
                const actual = transcriptBlock(screen, begin, end).slice(-expected.length).map(row => row.trim());
                if (actual.length !== expected.length || actual.some((row, index) => row !== expected[index])) return false;
              }
            }
            return true;
          }, { signal: t.signal, after, timeoutMs: 5000 });
          const question = transcriptBlock(lastScreen, "§", "¶");
          const goal = transcriptBlock(lastScreen, "¶", "¤");
          if (expanded && (width === 80 && index < 3 || index === 6 && width === 22)) {
            for (const [name, block] of [["question", question], ["killeros_goal_update", goal]] as const) {
              const produced = producerRows.get(name);
              assert.ok(produced);
              const expected = produced.map(row => row.trim()).filter(row => row !== "");
              assert.deepEqual(block.slice(-expected.length).map(row => row.trim()), expected, `${name} result rows match the parsed terminal`);
              if (index === 0 && width === 80) {
                assert.deepEqual(block.slice(-7).map(row => row.trim()),
                  [...Array.from({ length: 6 }, () => "long ".repeat(14) + "long"), "long ".repeat(9) + "long"],
                  `${name} terminal preserves spaces and wrap positions`);
              }
            }
          }
          if (!expanded && width >= 4) {
            assert.ok(question.length <= 6, `question call/result must each stay within three rows: ${JSON.stringify(lastVector)}`);
            // The goal call is an ordinary Text; only its result is bounded to one row.
            if (width >= 20) assert.ok(goal.length <= 2, "goal call plus collapsed result uses at most two rows");
          }
          if (index === 1 && width === 4) assert.ok(question.join("").includes("中"), "a two-cell CJK result survives its native two-cell content width");
          if (index === 6 && width === 40) {
            if (expanded) {
              for (let line = 1; line <= 20; line++) assert.ok(question.some(row => row.trim() === `line ${line}`), `expanded line ${line}`);
              assert.equal(question.at(-1)?.trim(), "line 20");
            } else {
              assert.deepEqual(question.slice(-3, -1).map(row => row.trim()), ["line 1", "line 2"]);
              assert.match(question.at(-1)?.trim() ?? "", /^line 3 +…$/u);
              assert.ok(goal.at(-1)?.includes("…"), "one-row goal result is visibly truncated");
            }
          }
        }
      }
      assert.ok(lastScreen.includes("❯\u00a0z"), "resizing and expansion preserve the editor draft");
      terminal.write("\x15\x0f");
    }
  } catch (error) { errors.push(error); }
  if (terminal) {
    try {
      assert.deepEqual(await terminal.close(), { code: 0, forced: false }, terminal.diagnostics());
      assert.equal(JSON.parse(readFileSync(path.join(directory, "requests.json"), "utf8")), 0, "no provider requests occur");
    }
    catch (error) { errors.push(error); }
  }
  if (errors.length) {
    // CI collects failure.txt from the checkout; this artifact directory never becomes a child cwd.
    const failure = mkdtempSync(path.join(root, "node_modules", ".killeros-bounded-failure-"));
    throwScenarioFailure({ directory: failure, message: `${id} native transcript failed`, errors,
      diagnostics: JSON.stringify({ directory, lastVector, lastScreen, terminal: terminal?.diagnostics() }) });
  }
  await removeFixtureRoot(directory);
  assert.equal(existsSync(directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: id, piLaunches: 1, sources: sourceIndices.length, widths: [1, 80],
    limits: [1, 3, "expanded"], cleanup: "natural",
    zeroWidthDisposition: "Pi Box clamps nested content widths to at least one cell",
    parsedUnicodeLimitation: "Emoji and combining fidelity is checked at the actual producer before ConPTY/xterm" }));
}

// Catalog ID: BT-01. Actual native producer rows preserve Unicode within every usable width.
test("Collapsed and expanded Unicode transcript text fits every usable terminal width", { timeout: 240_000 }, async (t) => {
  await runBoundedScenario(t, { id: "BT-01", sourceIndices: [0, 1, 2, 3, 4, 5] });
});

// Catalog ID: BT-02. This independent history proves the exact collapsed and expanded row contract.
test("Collapsed and expanded multiline transcript text preserves all rows", { timeout: 60_000 }, async (t) => {
  await runBoundedScenario(t, { id: "BT-02", sourceIndices: [6] });
});
