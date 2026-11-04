import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function readHistory(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8").trim().split("\n").map(line => record(JSON.parse(line)));
}

// Catalog ID: runtime.package-preferences.
test("packed KillerOS activates, reloads, and preserves Pi display preferences", { timeout: 180_000 }, async (t) => {
  const directory = mkdtempSync(path.join(root, "node_modules/.killeros-runtime-package-"));
  const pack = path.join(directory, "pack");
  const consumer = path.join(directory, "consumer");
  const errors: unknown[] = [];
  const histories: Record<string, unknown>[] = [];
  let terminal: PiTerminalProcess | undefined;
  let rpc: PiRpcProcess | undefined;
  let piLaunches = 0;
  let npmLaunches = 0;
  let archiveHash: string | undefined;
  try {
    mkdirSync(pack);
    mkdirSync(consumer);
    const npmCli = process.env.KILLEROS_TEST_NPM_CLI ?? process.env.npm_execpath ??
      [path.dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)]
        .map(directory => path.join(directory, "node_modules/npm/bin/npm-cli.js")).find(existsSync);
    assert.ok(npmCli && existsSync(npmCli), "Cannot locate npm-cli.js without a shell");
    const userConfig = path.join(directory, "empty.npmrc");
    const globalConfig = path.join(directory, "global.npmrc");
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const npmEnv = { ...process.env };
    delete npmEnv.npm_config_allow_scripts;
    delete npmEnv.NPM_CONFIG_ALLOW_SCRIPTS;
    const npm = (args: string[], cwd: string): string => {
      npmLaunches++;
      return execFileSync(process.execPath, [npmCli, "--userconfig", userConfig, "--globalconfig", globalConfig,
        "--loglevel", "error", ...args], { cwd, env: npmEnv, encoding: "utf8", timeout: 60_000, maxBuffer: 4_194_304 });
    };
    npm(["pack", "--pack-destination", pack], root);
    const archives = readdirSync(pack).filter(file => file.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    const archive = path.join(pack, archives[0]);
    archiveHash = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    npm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save", "--legacy-peer-deps", archive], consumer);
    const installed = path.join(consumer, "node_modules/killeros");
    const manifest = record(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")));
    const identity = record(JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")));
    assert.equal(identity.name, "killeros");
    assert.equal(identity.version, manifest.version);
    assert.deepEqual(identity.os, ["win32"]);
    const piManifest = record(JSON.parse(readFileSync(path.join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")));
    assert.equal(typeof piManifest.version, "string");
    for (const file of ["Killeros.ts", "README.md", "CHANGELOG.md", "themes/killeros.json"]) {
      assert.ok(existsSync(path.join(installed, file)), `Packed package is missing ${file}`);
    }

    for (const mode of ["tui", "rpc", "print", "json"] as const) {
      const owned = path.join(consumer, mode);
      const cwd = path.join(owned, "project");
      const agent = path.join(owned, "agent");
      const history = path.join(owned, "history.jsonl");
      const settings = path.join(agent, "settings.json");
      const probe = path.join(owned, "consumer.ts");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(agent);
      writeFileSync(settings, "{}\n");
      assert.equal(readFileSync(settings, "utf8"), "{}\n");
      const expectedSettings = mode === "tui" ? { lastChangelogVersion: piManifest.version, theme: "killeros" } : {};
      const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
      const env: NodeJS.ProcessEnv = {
        HOME: owned, USERPROFILE: owned, APPDATA: owned, LOCALAPPDATA: owned, TEMP: owned, TMP: owned,
        PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      };
      for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) env[key] = inherited.get(key.toLowerCase());
      const emptyGit = path.join(owned, "empty-git-config");
      writeFileSync(emptyGit, "");
      Object.assign(env, { GIT_CONFIG_GLOBAL: emptyGit, GIT_CONFIG_SYSTEM: emptyGit, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" });
      const gitFixture = path.join(owned, "git-fixture");
      if (mode === "tui") {
        mkdirSync(gitFixture);
        execFileSync("git", ["init", "-q"], { cwd: gitFixture, env, timeout: 30_000 });
        writeFileSync(path.join(gitFixture, "untracked.txt"), "new\n");
      }
      writeFileSync(probe, `
import assert from "node:assert/strict";
import {appendFileSync, readFileSync} from "node:fs";
import * as entry from "killeros/Killeros.ts";
import {createGitStatusRefresh} from "killeros/killeros/footer.ts";
const history = ${JSON.stringify(history)};
const save = value => appendFileSync(history, JSON.stringify(value) + "\\n");
export default function(pi) {
  for (const name of ["default", "contextPercentRemaining", "formatCost", "formatContextProgress", "executeHook"]) assert.equal(typeof entry[name], "function", name);
  // These are public packed-root consumer inputs, not simulated Pi application execution.
  for (const [tokens, contextWindow, expected] of [[89600,128000,30],[64000,128000,50],[200000,128000,0],[-1,128000,100],[null,128000,null],[1,0,null]]) {
    assert.equal(entry.contextPercentRemaining({getContextUsage:()=>({tokens,contextWindow})}), expected);
  }
  assert.equal(entry.contextPercentRemaining({getContextUsage:()=>undefined}), null);
  assert.equal(entry.contextPercentRemaining({getContextUsage:()=>{throw Error("unavailable")}}), null);
  for (const [value, expected] of [[0,"$0.00"],[1.234,"$1.23"],[NaN,"$—"],[Infinity,"$—"],[-Infinity,"$—"]]) assert.equal(entry.formatCost(value), expected);
  const theme = {fg:(color,text)=>"<"+color+">"+text+"</"+color+">"};
  for (const [tokens, capacity, expected] of ${JSON.stringify([
    [0, 1_000_000, "<success>ctx 100% (1M/1M)</success>"],
    [151_000, 1_000_000, "<success>ctx 85% (849K/1M)</success>"],
    [300_000, 1_000_000, "<success>ctx 70% (700K/1M)</success>"],
    [50_000, 1_050_000, "<success>ctx 95% (1M/1.05M)</success>"],
    [500_000, 1_000_000, "<warning>ctx 50% (500K/1M)</warning>"],
    [700_000, 1_000_000, "<warning>ctx 30% (300K/1M)</warning>"],
    [800_000, 1_000_000, "<warning>ctx 20% (200K/1M)</warning>"],
    [810_000, 1_000_000, "<error>ctx 19% (190K/1M)</error>"],
    [850_000, 1_000_000, "<error>ctx 15% (150K/1M)</error>"],
    [860_000, 1_000_000, "<error>ctx 14% (140K/1M)</error>"],
    [999_999.5, 1_000_000, "<error>ctx 0% (0/1M)</error>"],
    [1_000_000, 1_000_000, "<error>ctx 0% (0/1M)</error>"],
    [1_100_000, 1_000_000, "<error>ctx 0% (0/1M)</error>"],
    [-1, 1_000_000, "<success>ctx 100% (1M/1M)</success>"],
    [0, 0, "<dim>ctx —%</dim>"], [0, -1, "<dim>ctx —%</dim>"],
    [null, 1_000_000, "<dim>ctx —% (1M)</dim>"],
  ])}) assert.equal(entry.formatContextProgress(tokens, capacity, theme), expected);
  for (const invalid of [NaN,Infinity,-Infinity]) {
    assert.equal(entry.formatContextProgress(64000,invalid,theme), "<dim>ctx —%</dim>");
    assert.equal(entry.formatContextProgress(invalid,1000000,theme), "<dim>ctx —% (1M)</dim>");
  }
  const plain = {fg:(_color,text)=>text};
  assert.equal(entry.formatContextProgress(845001,1000000,plain,true), "ctx 15% (154.99K/1M) · /compact");
  assert.equal(entry.formatContextProgress(844999,1000000,plain,true), "ctx 16% (155K/1M)");
  assert.equal(entry.formatContextProgress(850000,1000000,plain,true,"capacity"), "ctx 15% (1M) · /compact");
  assert.equal(entry.formatContextProgress(850000,1000000,plain,true,"percentage"), "ctx 15% · /compact");
  assert.doesNotMatch(entry.formatContextProgress(50000,1050000,plain), /[█░]/u);
  pi.registerCommand("package-reload", {description:"Reload the native runtime", handler:async (_args,ctx)=>{await ctx.reload();}});
  pi.registerCommand("package-exit", {description:"Exit without a model request", handler:async (_args,ctx)=>{ctx.shutdown();}});
  pi.on("session_shutdown", (event,ctx)=>{
    save({kind:"shutdown",reason:event.reason});
    if(event.reason === "reload") globalThis.__killerosPackageOldContext = ctx;
  });
  pi.on("session_start", async (event,ctx)=>{
    try {
    if (ctx.mode === "tui" && event.reason === "startup") {
      let refresh;
      let timer;
      try {
        const count = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Git count callback timed out")), 10000);
          refresh = createGitStatusRefresh(${JSON.stringify(gitFixture)}, resolve);
          refresh.request();
        });
        assert.equal(count, 1);
      } finally {
        clearTimeout(timer);
        refresh?.dispose();
      }
    }
    assert.equal(ctx.mode, ${JSON.stringify(mode)});
    const settings = pi.getSettings();
    assert.equal(settings.tuiMode, undefined);
    assert.equal(settings.quietStartup, undefined);
    assert.deepEqual(settings, ${JSON.stringify(expectedSettings)});
    const diskSettings = JSON.parse(readFileSync(${JSON.stringify(settings)},"utf8"));
    assert.equal(diskSettings.tuiMode, undefined);
    assert.equal(diskSettings.quietStartup, undefined);
    assert.deepEqual(diskSettings, ${JSON.stringify(expectedSettings)});
    if(event.reason === "reload") {
      assert.ok(globalThis.__killerosPackageOldContext);
      assert.throws(()=>globalThis.__killerosPackageOldContext.mode,/stale/u);
      delete globalThis.__killerosPackageOldContext;
    }
    const commands = pi.getCommands().map(command=>command.name);
    assert.ok(commands.includes("goal"));
    assert.equal(new Set(commands).size, commands.length);
    const tools = pi.getAllTools().filter(tool=>["question","killeros_goal_update"].includes(tool.name)).map(tool=>({name:tool.name,exposure:tool.exposure}));
    assert.deepEqual(tools.map(tool=>tool.name).sort(), ["killeros_goal_update","question"]);
    assert.ok(tools.every(tool=>tool.exposure === "model-only"));
    save({kind:"start",reason:event.reason,mode:ctx.mode,commands,tools,settings,publicVectors:true});
    if(ctx.mode === "tui") ctx.ui.notify("PACKAGE_READY_"+event.reason,"info");
    } catch(error) { save({kind:"failure",error:String(error),stack:error.stack,settings:pi.getSettings()}); throw error; }
  });
}
`);
      const args = ["--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--no-extensions", "--extension", installed, "--extension", probe, "--session", path.join(owned, "session.jsonl")];
      if (mode === "tui") {
        piLaunches++;
        terminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...args], cwd, env });
        await terminal.waitForScreen(screen => screen.includes("PACKAGE_READY_startup"), { signal: t.signal });
        const after = terminal.sequence;
        await terminal.submitEditorText("/package-reload", { signal: t.signal });
        await terminal.waitForScreen(screen => screen.includes("Reloaded keybindings, extensions, skills, prompts, themes, and context files"), { signal: t.signal, after });
        const closed = await terminal.close();
        assert.deepEqual(closed, { code: 0, forced: false }, terminal.diagnostics());
        terminal = undefined;
      } else if (mode === "rpc") {
        piLaunches++;
        rpc = new PiRpcProcess({ cliPath, args: ["--mode", "rpc", ...args], cwd, env });
        await rpc.command("get_state", {}, { signal: t.signal });
        await rpc.command("prompt", { message: "/package-reload" }, { signal: t.signal });
        await rpc.command("get_state", {}, { signal: t.signal });
        const closed = await rpc.close();
        assert.equal(closed.exit.code, 0, rpc.diagnostics());
        assert.equal(closed.exit.signal, null);
        assert.equal(closed.forced, false);
        assert.equal(closed.treeCleanupError, undefined);
        rpc = undefined;
      } else {
        for (let launch = 0; launch < 2; launch++) {
          piLaunches++;
          const invocation = promisify(execFile)(process.execPath, [cliPath, "--print", ...(mode === "json" ? ["--mode", "json"] : []),
            ...args, "/package-exit"], { cwd, env, timeout: 30_000, maxBuffer: 1_048_576, signal: t.signal });
          invocation.child.stdin?.end();
          const result = await invocation;
          assert.doesNotMatch(result.stderr, /Extension error|Failed to load extension|AssertionError/u);
        }
      }
      const finalSettings = record(JSON.parse(readFileSync(settings, "utf8")));
      assert.equal(finalSettings.tuiMode, undefined, mode);
      assert.equal(finalSettings.quietStartup, undefined, mode);
      assert.deepEqual(finalSettings, expectedSettings, mode);
      const events = readHistory(history);
      assert.deepEqual(events.map(event => `${String(event.kind)}:${String(event.reason)}`), mode === "tui" || mode === "rpc"
        ? ["start:startup", "shutdown:reload", "start:reload", "shutdown:quit"]
        : ["start:startup", "shutdown:quit", "start:startup", "shutdown:quit"], mode);
      const starts = events.filter(event => event.kind === "start");
      assert.equal(starts.length, 2);
      assert.deepEqual(starts[0].commands, starts[1].commands, mode);
      assert.deepEqual(starts[0].tools, starts[1].tools, mode);
      assert.deepEqual(starts[0].settings, starts[1].settings, mode);
      assert.ok(starts.every(event => event.publicVectors === true && event.mode === mode));
      histories.push({ mode, events });
    }
    assert.equal(piLaunches, 6);
    assert.equal(npmLaunches, 2);
  } catch (error) {
    errors.push(error);
    for (const mode of ["tui", "rpc", "print", "json"]) {
      const history = path.join(consumer, mode, "history.jsonl");
      if (existsSync(history)) t.diagnostic(readFileSync(history, "utf8"));
    }
    t.diagnostic(error instanceof Error ? error.message.slice(0, 2_000) : String(error));
  }
  finally {
    if (terminal) {
      try { const closed = await terminal.close(); assert.deepEqual(closed, { code: 0, forced: false }); }
      catch (error) { errors.push(error); }
    }
    if (rpc) {
      try { const closed = await rpc.close(); assert.equal(closed.exit.code, 0); assert.equal(closed.forced, false); assert.equal(closed.treeCleanupError, undefined); }
      catch (error) { errors.push(error); }
    }
    try { await removeDirectoryEventually(directory); assert.equal(existsSync(directory), false); }
    catch (error) { errors.push(error); }
    t.diagnostic(JSON.stringify({ scenarioId: "runtime.package-preferences", archiveHash, piLaunches, npmLaunches, histories, removed: !existsSync(directory) }));
  }
  if (errors.length > 0) throw new AggregateError(errors, "Packed package preferences scenario failed");
});
