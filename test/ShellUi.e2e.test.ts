import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-shell-"));
  const agent = path.join(directory, "agent");
  const project = path.join(directory, "pi-KillerOS");
  const temporary = path.join(directory, "tmp");
  for (const item of [agent, project, temporary]) mkdirSync(item);
  mkdirSync(path.join(project, ".pi"));
  writeFileSync(path.join(project, ".pi/settings.json"), "{}");
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "shell-fixture": {
    api: "openai-completions", apiKey: "unused", baseUrl: "http://127.0.0.1:1/v1",
    models: [{ id: "test-model", name: "test-model", reasoning: true, input: ["text"], contextWindow: 100000, maxTokens: 16,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const extension = path.join(directory, "observe.ts");
  writeFileSync(extension, `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
export default function (pi: ExtensionAPI) {
  pi.on("project_trust", () => ({ trusted: process.env.SHELL_UNTRUSTED === "1" ? "no" : "yes", remember: false }));
  pi.registerCommand("shell-observe", { description: "Observe native session readiness", handler: (args, ctx) => {
    ctx.ui.notify("shell-observed-" + args + "-trusted=" + ctx.isProjectTrusted() + "-theme=" + ctx.ui.theme.name, "info");
  } });
  pi.registerCommand("shell-git", { description: "Acknowledge owned external Git callbacks", handler: async (args, ctx) => {
    const adapter = process.env.SHELL_GIT_ADAPTER;
    if (!adapter) throw new Error("Shell Git adapter was not configured");
    const barrier = createRequire(import.meta.url)(adapter);
    await barrier.finish(args);
    ctx.ui.notify("shell-git-" + args + "-" + barrier.snapshot(), "info");
  } });
}
`);
  // Adapt only the owned external branch lookup; execute real Git and preserve its result.
  const adapter = path.join(directory, "git-barrier.cjs");
  writeFileSync(adapter, `const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.execFile;
const calls = [];
const immediate = () => new Promise(resolve => setImmediate(resolve));
cp.execFile = function(file, args, options, callback) {
  if (!/^(git|git.exe)$/i.test(require("node:path").basename(file)) || !Array.isArray(args) || args.length !== 5 || args[0] !== "-C"
      || args[1] !== process.env.SHELL_GIT_CWD || args.slice(2).join(" ") !== "rev-parse --abbrev-ref HEAD") {
    return Reflect.apply(original, this, arguments);
  }
  let ready, delivered;
  const call = { ready: new Promise(resolve => { ready = resolve; }),
    delivered: new Promise(resolve => { delivered = resolve; }), release: undefined, done: false };
  calls.push(call);
  if (process.env.SHELL_GIT_CONFIG) options = { ...options, env: { ...options.env, GIT_CONFIG_GLOBAL: process.env.SHELL_GIT_CONFIG } };
  return original(file, args, options, (...result) => {
    const deliver = () => { callback(...result); call.done = true; delivered(); };
    if (process.env.SHELL_GIT_HOLD === "1" && calls.indexOf(call) === 0) call.release = deliver;
    else deliver();
    ready();
  });
};
syncBuiltinESMExports();
exports.finish = async action => {
  await Promise.all(calls.map(call => call.ready));
  if (action === "release") for (const call of calls) { call.release?.(); call.release = undefined; }
  await Promise.all(calls.filter(call => !call.release).map(call => call.delivered));
  await immediate();
  await immediate();
};
exports.snapshot = () => "started=" + calls.length + "-completed=" + calls.filter(call => call.done).length;
process.once("exit", () => { cp.execFile = original; syncBuiltinESMExports(); });
`);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: temporary, TMP: temporary,
    PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    COLORTERM: "truecolor" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  const start = (cwd = project, extraEnv: NodeJS.ProcessEnv = {}) => new PiTerminalProcess({ file: process.execPath,
    args: [cli, "--model", "shell-fixture/test-model", "--thinking", "high", "--tools", "read", "--no-session", "--offline",
      "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions",
      "--extension", root, "--extension", extension], cwd, env: { ...env, ...extraEnv }, cols: 120, rows: 45 });
  return { directory, project, agent, start, adapter };
}

// Catalog ID: SH-02. Native terminals have positive columns; width zero needs a separate reachability disposition.
test("Header masthead and startup tips stay fixed per session and exhaust their decks", { timeout: 120_000 }, async (t) => {
  const setup = fixture();
  const terminal = setup.start();
  const errors: unknown[] = [];
  const screens: Record<string, string> = {};
  const tips: string[] = [];
  const suggestions: string[] = [];
  try {
    screens.startup = await terminal.waitForScreen(screen => screen.includes("Tip:") && screen.includes('❯\u00a0Try "'), { signal: t.signal });
    const manifest: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest && typeof manifest.version === "string");
    const lines = screens.startup.split("\n");
    const first = lines.findIndex(line => line.startsWith("██████"));
    assert.equal(lines[first], `██████   Pi ${PI_VERSION} | KillerOS ${manifest.version}`);
    assert.equal(lines[first + 1], "▓▓▓▓▓▓   model: test-model high");
    assert.equal(lines[first + 2], "░░░░░░   directory: ~\\pi-KillerOS");
    assert.equal(lines[first + 3], "");
    assert.match(lines[first + 4] ?? "", /^Tip: /u);
    const header = lines.slice(first, first + 5).join("\n");
    assert.doesNotMatch(header, /context|╭|╰|│|READY|MCP adapter|Web access|KILLEROS/u);
    const diagnostic: unknown = JSON.parse(terminal.diagnostics());
    assert.ok(typeof diagnostic === "object" && diagnostic !== null && "rawBase64" in diagnostic && typeof diagnostic.rawBase64 === "string");
    const raw = Buffer.from(diagnostic.rawBase64, "base64").toString("utf8");
    assert.doesNotMatch(raw.slice(raw.indexOf("██████"), raw.indexOf("▓▓▓▓▓▓")), /\x1b\[1m/u, "identity is not bold");
    assert.match(raw, /\x1b\[38;2;242;242;242mPi ?\x1b\[38;2;128;128;128m/u, "native text color for Pi");
    assert.ok(raw.includes("\x1b[38;2;128;128;128mmodel: \x1b[38;2;242;242;242m"), "native dim model label");
    // ConPTY's physical minimum is two columns.
    for (let width = 2; width <= 100; width++) {
      const after = terminal.sequence;
      terminal.resize(width, 300);
      const screen = await terminal.waitForScreen(value => value.split("\n").some(line => line === "─".repeat(width))
        && (width < 28
          ? value.split("\n").find(line => line.trim().length > 0)?.trimEnd() === "KillerOS".slice(0, width)
          : value.includes("██████")), { signal: t.signal, after });
      assert.ok(screen.split("\n").every(line => [...line].length <= width), `width ${width}: rows fit`);
      if (width < 28) {
        const firstVisibleLine = screen.split("\n").find(line => line.trim().length > 0);
        assert.equal(firstVisibleLine?.trimEnd(), "KillerOS".slice(0, width), `width ${width}: compact masthead`);
      }
      screens[`width-${width}`] = screen;
    }
    terminal.resize(160, 45);
    await terminal.waitForScreen(screen => screen.includes("Tip:") && screen.includes('❯\u00a0Try "'), { signal: t.signal });
    for (let index = 0; index < 10; index++) {
      if (index > 0) {
        const after = terminal.sequence;
        await terminal.submitEditorText("/new", { signal: t.signal });
        await terminal.waitForScreen(screen => screen.includes("New session started") && screen.includes("Tip:")
          && screen.includes('❯\u00a0Try "') && !screen.includes(`shell-observed-${index - 1}-`), { signal: t.signal, after });
      }
      const current = terminal.screen();
      const tip = current.split("\n").find(line => line.startsWith("Tip:"));
      const suggestion = current.split("\n").find(line => line.startsWith('❯\u00a0Try "'));
      assert.ok(tip && suggestion);
      tips.push(tip);
      suggestions.push(suggestion);
      const after = terminal.sequence;
      await terminal.submitEditorText(`/shell-observe ${index}`, { signal: t.signal });
      screens[`session-${index}`] = await terminal.waitForScreen(screen => screen.includes(`shell-observed-${index}-trusted=true-theme=killeros`)
        && screen.split("\n").some(line => line.startsWith('❯\u00a0Try "')), { signal: t.signal, after });
      const rendered = screens[`session-${index}`]?.split("\n") ?? [];
      assert.equal(rendered.find(line => line.startsWith("Tip:")), tip, `session ${index}: tip survives native render`);
      assert.equal(rendered.find(line => line.startsWith('❯\u00a0Try "')), suggestion, `session ${index}: suggestion survives native render`);
    }
    assert.equal(new Set(tips.slice(0, 9)).size, 9);
    assert.equal(new Set(tips).size, 9);
    assert.equal(new Set(suggestions).size, 10);
  } catch (error) { errors.push(error); }
  const terminalDiagnostics = terminal.diagnostics();
  try { assert.deepEqual(await terminal.close(), { code: 0, forced: false }); } catch (error) { errors.push(error); }
  try { await removeDirectoryEventually(setup.directory); assert.equal(existsSync(setup.directory), false); } catch (error) { errors.push(error); }
  if (errors.length) throwScenarioFailure({ directory: mkdtempSync(path.join(root, "node_modules", ".killeros-SH-02-failure-")),
    message: "SH-02 failed", errors, diagnostics: JSON.stringify({ screens, tips, suggestions, terminal: terminalDiagnostics }) });
  t.diagnostic(JSON.stringify({ scenarioId: "SH-02", piLaunches: 1, sessions: 10, widths: 99, providerRequests: 0, cleanup: "natural" }));
});
