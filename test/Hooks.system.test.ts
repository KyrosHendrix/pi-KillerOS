import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { executeHook } from "../Killeros.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";

type HookProcess = NonNullable<Parameters<typeof executeHook>[4]>;
const run = promisify(execFile);
const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  await new Promise<void>((resolve, reject) => {
    const check = setInterval(() => {
      try {
        if (isAlive(pid)) return;
        clearInterval(check);
        clearTimeout(deadline);
        resolve();
      } catch (error) {
        clearInterval(check);
        clearTimeout(deadline);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }, 10);
    const deadline = setTimeout(() => {
      clearInterval(check);
      reject(new Error(`Owned hook PID ${pid} did not exit`));
    }, 10_000);
  });
}

async function stopProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  try {
    await run(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    if (isAlive(pid)) throw error;
  }
  await waitForExit(pid);
}

/** Starts a real owned process and waits for its complete readiness line before testing cleanup. */
async function startProcess(t: TestContext, source = "") {
  const child = spawn(process.execPath, ["-e", `
    process.stdout.write(String(process.pid) + "\\n");
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
    ${source}
  `], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned child has exited");
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const values: unknown[] = await once(lines, "line", { signal: t.signal });
    const line = values[0];
    assert.equal(line, String(child.pid), "readiness includes the complete owned PID");
  } finally {
    lines.close();
  }
  return { child, closed };
}

function timeoutCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
}

// Catalog ID: HK-03.
test("Exported executeHook enforces real timeout, abort, and resource cleanup contracts", {
  timeout: 30_000,
}, async (t) => {
  let childLaunches = 0;
  const command = `"${process.execPath}" -e "setTimeout(() => { console.log('out'); console.error('err'); }, 20)"`;
  const normalSignals: Array<NodeJS.Signals | number | undefined> = [];
  const normal = await executeHook({ command, cwd: process.cwd(), environment: {}, timeoutMs: Number.NaN,
    spawnProcess: (text, options) => {
      childLaunches += 1;
      const child = spawn(text, options);
      return { pid: child.pid, stdout: child.stdout, stderr: child.stderr,
        on: (event, listener) => child.on(event, listener),
        once: (event, listener) => child.once(event, listener),
        kill: (signal) => { normalSignals.push(signal); return child.kill(signal); } };
    } });
  assert.deepEqual(normal, { code: 0, stdout: "out\n", stderr: "err\n",
    timedOut: false, cancelled: false, exitUnconfirmed: false }, "NaN timeout uses the default and the child succeeds");
  assert.deepEqual(normalSignals, [], "NaN timeout does not attempt termination");

  const beforeAbort = new AbortController();
  beforeAbort.abort();
  let spawned = false;
  const preAborted = await executeHook({ command, cwd: process.cwd(), environment: {}, signal: beforeAbort.signal,
    spawnProcess: (text, options) => { spawned = true; return spawn(text, options); } });
  assert.equal(spawned, false, "an already cancelled hook never spawns");
  assert.deepEqual(preAborted, { code: 130, stdout: "", stderr: "", timedOut: false,
    cancelled: true, exitUnconfirmed: false });

  const stuck = await startProcess(t);
  childLaunches += 1;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const refuseTermination: HookProcess = () => ({ stdout: stuck.child.stdout, stderr: stuck.child.stderr,
    on: (event, listener) => stuck.child.on(event, listener),
    once: (event, listener) => stuck.child.once(event, listener),
    kill: (signal) => { signals.push(signal); return true; } });
  const timeoutsBeforeStuck = timeoutCount();
  const stuckResult = await executeHook({ command: "owned adapter", cwd: process.cwd(), environment: {}, timeoutMs: 1_000,
    spawnProcess: refuseTermination });
  assert.equal(stuckResult.code, 124);
  assert.equal(stuckResult.timedOut, true);
  assert.equal(stuckResult.cancelled, false);
  assert.equal(stuckResult.exitUnconfirmed, true, "withholding PID and ignoring signals cannot confirm cleanup");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(timeoutCount(), timeoutsBeforeStuck, "bounded uncertain cleanup releases its timers");
  signals.length = 0;
  const ignoredAbort = new AbortController();
  const cancelledPromise = executeHook({ command: "same surviving owned adapter", cwd: process.cwd(), environment: {},
    spawnProcess: refuseTermination, signal: ignoredAbort.signal });
  ignoredAbort.abort();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.code, 130);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.timedOut, false);
  assert.equal(cancelled.exitUnconfirmed, true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"], "a survivor receives both cancellation signals too");
  assert.equal(timeoutCount(), timeoutsBeforeStuck, "the second cleanup attempt releases all timers");
  stuck.child.stdin.end();
  await stuck.closed;

  for (const stage of ["running", "during-spawn"] as const) {
    const owned = await startProcess(t);
    childLaunches += 1;
    const controller = new AbortController();
    const cancellationSignals: Array<NodeJS.Signals | number | undefined> = [];
    const spawnProcess: HookProcess = () => {
      if (stage === "during-spawn") controller.abort();
      return { stdout: owned.child.stdout, stderr: owned.child.stderr,
        on: (event, listener) => owned.child.on(event, listener),
        once: (event, listener) => owned.child.once(event, listener),
        kill: (signal) => { cancellationSignals.push(signal); return owned.child.kill(signal); } };
    };
    const baseline = timeoutCount();
    const resultPromise = executeHook({ command: "owned adapter", cwd: process.cwd(), environment: {},
      spawnProcess, signal: controller.signal });
    if (stage === "running") controller.abort();
    const result = await resultPromise;
    await owned.closed;
    assert.equal(result.code, 130, stage);
    assert.equal(result.cancelled, true, stage);
    assert.equal(result.timedOut, false, stage);
    assert.equal(result.exitUnconfirmed, false, stage);
    assert.deepEqual(cancellationSignals, ["SIGTERM"], stage);
    assert.equal(timeoutCount(), baseline, `${stage}: cancellation releases its timers`);
  }

  const baseline = timeoutCount();
  const fast = await executeHook({ command: `"${process.execPath}" -e "process.exit(0)"`,
    cwd: process.cwd(), environment: {}, timeoutMs: 5_000,
    spawnProcess: (text, options) => { childLaunches += 1; return spawn(text, options); } });
  assert.equal(fast.code, 0);
  assert.equal(fast.timedOut, false);
  assert.equal(fast.exitUnconfirmed, false);
  assert.equal(timeoutCount(), baseline, "a fast actual child leaves no hook timer");
  assert.equal(childLaunches, 5);
  t.diagnostic(JSON.stringify({ scenarioId: "HK-03", piLaunches: 0, primaryChildLaunches: childLaunches,
    boundary: "public root executeHook with real processes; PID withholding is an explicit adapter fault model",
    remaining: "synchronous-completion adapter ordering belongs to HK-05" }));
});

// Catalog ID: HK-05.
test("Exported executeHook contains adapter stream errors and synchronous cleanup", { timeout: 60_000 }, async (t) => {
  const root = mkdtempSync(path.join(import.meta.dirname, "../node_modules/.killeros-hook-consumer-"));
  try {
    const npmCli = [path.dirname(process.execPath), ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)]
      .map((directory) => path.join(directory, "node_modules/npm/bin/npm-cli.js")).find(existsSync);
    assert.ok(npmCli, "the package consumer requires the installed npm CLI");
    const config = path.join(root, "empty.npmrc");
    writeFileSync(config, "");
    writeFileSync(`${config}.global`, "");
    const result = await run(process.execPath, [npmCli, "--userconfig", config, "--globalconfig", `${config}.global`,
      "--loglevel", "error", "pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: path.join(import.meta.dirname, ".."), timeout: 30_000, windowsHide: true,
      env: { ...process.env, npm_config_cache: path.join(root, "npm-cache"), npm_config_update_notifier: "false" },
    });
    const archives: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(archives) && archives.length === 1);
    const archive: unknown = archives[0];
    assert.ok(typeof archive === "object" && archive !== null && "filename" in archive && typeof archive.filename === "string");
    await run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      ["-xf", path.join(root, archive.filename), "-C", root], { timeout: 30_000, windowsHide: true });
    const packed = await createJiti(import.meta.url).import<typeof import("../Killeros.ts")>(path.join(root, "package/Killeros.ts"));
    assert.equal(typeof packed.executeHook, "function", "the packed root exports the actual public hook API");

    const streamFault = await startProcess(t);
    const faultResultPromise = packed.executeHook({ command: "owned stream fault", cwd: root, environment: {},
      spawnProcess: () => streamFault.child });
    streamFault.child.stdout.destroy(new Error("stdout failed"));
    streamFault.child.stderr.destroy(new Error("stderr failed"));
    streamFault.child.stdin.end();
    const fault = await faultResultPromise;
    await streamFault.closed;
    assert.match(fault.stderr, /stdout failed/u);
    assert.match(fault.stderr, /stderr failed/u);
    assert.equal(fault.timedOut, false);
    assert.equal(fault.cancelled, false);

    const dataOnly = await startProcess(t, `process.stdin.once("data", () => {
      process.stdout.write("data-only stdout"); process.stderr.write("data-only stderr"); process.exit(0);
    });`);
    const dataResultPromise = packed.executeHook({ command: "owned data-only adapter", cwd: root, environment: {},
      spawnProcess: () => ({
        stdout: { on: (event, listener) => { assert.equal(event, "data"); return dataOnly.child.stdout.on(event, listener); } },
        stderr: { on: (event, listener) => { assert.equal(event, "data"); return dataOnly.child.stderr.on(event, listener); } },
        kill: (signal) => dataOnly.child.kill(signal),
        on: (event, listener) => dataOnly.child.on(event, listener),
        once: (event, listener) => dataOnly.child.once(event, listener),
      }) });
    dataOnly.child.stdin.write("output");
    const data = await dataResultPromise;
    await dataOnly.closed;
    assert.equal(data.code, 0);
    assert.equal(data.stdout, "data-only stdout");
    assert.equal(data.stderr, "data-only stderr");

    const failure = await packed.executeHook("missing executable adapter", root, {}, 1_000, () => {
      const invocation = spawnSync(path.join(root, "missing-node.exe"), [], { windowsHide: true });
      assert.ok(invocation.error, "a real executable lookup fails before the adapter throws");
      throw new Error("process could not start", { cause: invocation.error });
    });
    assert.deepEqual(failure, { code: 1, stdout: "", stderr: "process could not start",
      timedOut: false, cancelled: false, exitUnconfirmed: false });

    for (const action of ["completion", "abort"] as const) {
      const reaped = await startProcess(t);
      reaped.child.stdin.end();
      await reaped.closed;
      const controller = new AbortController();
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      let notifyClose: ((code: number | null) => void) | undefined;
      const baseline = timeoutCount();
      const synchronous = await packed.executeHook({ command: "reaped real process adapter", cwd: root,
        environment: {}, timeoutMs: 50, signal: controller.signal,
        spawnProcess: () => {
          if (action === "abort") controller.abort();
          return {
            stdout: reaped.child.stdout, stderr: reaped.child.stderr,
            on: (event, listener) => reaped.child.on(event, listener),
            once: (_event, listener) => {
              notifyClose = listener;
              if (action === "completion") listener(0);
            },
            kill: (signal) => { signals.push(signal); notifyClose?.(null); return true; },
          };
        } });
      assert.equal(synchronous.code, action === "abort" ? 130 : 0, action);
      assert.equal(synchronous.cancelled, action === "abort", action);
      assert.equal(synchronous.timedOut, false, action);
      assert.equal(synchronous.exitUnconfirmed, false, action);
      assert.deepEqual(signals, action === "abort" ? ["SIGTERM"] : [], action);
      assert.equal(timeoutCount(), baseline, `${action}: synchronous public adapter leaves no timer`);
    }
    t.diagnostic(JSON.stringify({ scenarioId: "HK-05", piLaunches: 0, primaryChildLaunches: 4,
      failedExecutableLookups: 1, packagePreparationChildren: 2,
      boundary: "packed public root; actual child streams and reaped child handles with explicit synchronous adapter delivery" }));
  } finally {
    await removeDirectoryEventually(root);
    assert.equal(existsSync(root), false, "the packed public consumer is removed");
  }
});

/** A descendant acknowledges its complete PID and writes only after an explicit external release. */
async function startTree(t: TestContext, directory: string) {
  mkdirSync(directory);
  const ready = path.join(directory, "ready");
  const release = path.join(directory, "release");
  const marker = path.join(directory, "late-marker");
  const script = path.join(directory, "tree.cjs");
  writeFileSync(ready, "");
  const descendantSource = `
    const fs = require("node:fs");
    const [ready, release, marker] = process.argv.slice(1);
    const pid = String(process.pid);
    fs.writeFileSync(ready, pid.slice(0, 1));
    process.nextTick(() => fs.appendFileSync(ready, pid.slice(1) + "\\n"));
    const watcher = fs.watch(require("node:path").dirname(release), () => {
      if (!fs.existsSync(release)) return;
      fs.writeFileSync(marker, "late");
      watcher.close();
    });
  `;
  const source = `
    const fs = require("node:fs");
    const child = require("node:child_process").spawn(process.execPath,
      ["-e", ${JSON.stringify(descendantSource)}, ${JSON.stringify(ready)}, ${JSON.stringify(release)}, ${JSON.stringify(marker)}],
      { detached: true, stdio: "ignore", windowsHide: true });
    const timer = setInterval(() => {
      const contents = fs.readFileSync(${JSON.stringify(ready)}, "utf8");
      if (!/^[1-9]\\d*\\n$/.test(contents)) return;
      clearInterval(timer);
      console.log(JSON.stringify([process.pid, Number(contents)]));
    }, 10);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(0));
  `;
  writeFileSync(script, source);
  const shell = spawn(`"${process.execPath}" "${script}"`, {
    shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, PATH: "" },
  });
  const closed = once(shell, "close");
  const pids: number[] = [];
  if (shell.pid) pids.push(shell.pid);
  t.after(async () => {
    const errors: unknown[] = [];
    if (/^[1-9]\d*\n$/u.test(readFileSync(ready, "utf8"))) pids.push(Number(readFileSync(ready, "utf8")));
    for (const pid of new Set(pids)) {
      try { await stopProcess(pid); } catch (error) { errors.push(error); }
    }
    await closed;
    if (errors.length) throw new AggregateError(errors, "Owned hook tree cleanup failed");
  });
  const lines = createInterface({ input: shell.stdout });
  try {
    const values: unknown[] = await once(lines, "line", { signal: t.signal });
    assert.equal(typeof values[0], "string");
    const parsed: unknown = JSON.parse(String(values[0]));
    assert.ok(Array.isArray(parsed) && parsed.length === 2);
    for (const value of parsed) {
      assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
      pids.push(value);
    }
    assert.match(readFileSync(ready, "utf8"), /^[1-9]\d*\n$/u, "readiness requires complete PID contents");
  } finally {
    lines.close();
  }
  const descendantPid = pids.at(-1);
  assert.ok(descendantPid);
  return { shell, closed, pids, descendantPid, marker, release, script, source };
}

// Catalog ID: HK-04.
test("Windows hook cleanup terminates descendants or reports bounded uncertainty", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(path.join(import.meta.dirname, "../node_modules/.killeros-hook-trees-"));
  try {
    const emptyPathConsumer = path.join(root, "empty-path.mjs");
    writeFileSync(emptyPathConsumer, `
      import assert from "node:assert/strict";
      import { spawn, execFileSync } from "node:child_process";
      import { once } from "node:events";
      import { createInterface } from "node:readline";
      import { setTimeout } from "node:timers/promises";
      import { executeHook } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "../Killeros.ts")).href)};
      assert.equal(process.env.PATH, "");
      const command = ${JSON.stringify(`"${process.execPath}" -e "console.log(process.pid);setInterval(() => {}, 1000)"`)};
      const shell = spawn(command, {shell:true,stdio:["ignore","pipe","pipe"],windowsHide:true});
      const closed = once(shell, "close");
      const pids = [shell.pid];
      const alive = pid => {
        try { process.kill(pid,0); return true; }
        catch(error) { assert.equal(error.code,"ESRCH"); return false; }
      };
      try {
          const lines = createInterface({input:shell.stdout});
          const [line] = await once(lines,"line",{signal:AbortSignal.timeout(10000)});
          lines.close();
          assert.match(line,/^[1-9]\\d*$/);
          pids.push(Number(line));
          const result = await executeHook({command,cwd:process.cwd(),environment:{},timeoutMs:100,spawnProcess:()=>shell});
           assert.equal(result.code,124);
           assert.equal(result.timedOut,true);
           for(const pid of pids) {
            const deadline = Date.now()+10000;
            while(alive(pid) && Date.now()<deadline) await setTimeout(10);
             assert.equal(alive(pid),false,"absolute taskkill stops both owned PIDs without PATH lookup");
           }
           await closed;
          console.log(JSON.stringify({result,pids,callerPath:process.env.PATH,exited:true}));
        } finally {
        for(const pid of pids) if(alive(pid)) execFileSync(${JSON.stringify(taskkill)},["/pid",String(pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});
        await closed;
      }
    `);
    const emptyPath = await run(process.execPath, ["--experimental-strip-types", emptyPathConsumer], {
      cwd: root, env: { ...process.env, PATH: "" }, timeout: 20_000, windowsHide: true,
    });
    const emptyPathResult: unknown = JSON.parse(emptyPath.stdout);
    assert.ok(typeof emptyPathResult === "object" && emptyPathResult !== null && "exited" in emptyPathResult
      && emptyPathResult.exited === true && "callerPath" in emptyPathResult && emptyPathResult.callerPath === "");
    let childLaunches = 3;
    const naturalTree = await startTree(t, path.join(root, "natural-shell"));
    childLaunches += 3;
    assert.ok(naturalTree.shell.pid, "the natural hook has a real shell PID");
    assert.equal(naturalTree.pids.length, 3, "the shell, hook parent and detached descendant are known");
    const naturalResult = await executeHook({ command: "owned natural tree", cwd: root, environment: { PATH: "" },
      timeoutMs: 100, spawnProcess: () => naturalTree.shell });
    assert.equal(naturalResult.code, 124);
    assert.equal(naturalResult.timedOut, true);
    assert.equal(readFileSync(naturalTree.script, "utf8"), naturalTree.source);
    assert.equal(existsSync(naturalTree.marker), false, "the natural descendant has not been released");
    if (!naturalResult.exitUnconfirmed) {
      t.diagnostic(JSON.stringify({ scenarioId: "HK-04", naturalResult, confirmedBranchExecuted: true }));
      // No manual termination or release may precede this proof of confirmed cleanup.
      for (const pid of naturalTree.pids) await waitForExit(pid);
      writeFileSync(naturalTree.release, "write");
      assert.equal(existsSync(naturalTree.marker), false);
    } else {
      t.diagnostic(JSON.stringify({ scenarioId: "HK-04", naturalResult, confirmedBranchExecuted: false }));
    }
    for (const pid of naturalTree.pids) await stopProcess(pid);
    await naturalTree.closed;
    for (const variant of ["shell-close", "shell-close-cancel", "disabled-cleanup"] as const) {
      const tree = await startTree(t, path.join(root, variant));
      childLaunches += 3;
      const controller = new AbortController();
      const spawnProcess: HookProcess = () => ({
        get pid() {
          if (variant === "disabled-cleanup") return undefined;
          // This public adapter closes the actual shell while cleanup owns the actual descendant PID.
          tree.shell.kill();
          return tree.descendantPid;
        },
        stdout: tree.shell.stdout, stderr: tree.shell.stderr,
        on: (event, listener) => tree.shell.on(event, listener),
        once: (event, listener) => tree.shell.once(event, listener),
        kill: () => true,
      });
      const execution = executeHook({ command: "owned tree adapter", cwd: root, environment: { PATH: "" },
        timeoutMs: 100, spawnProcess, signal: controller.signal });
      if (variant === "shell-close-cancel") controller.abort();
      const result = await execution;
      assert.equal(result.code, variant === "shell-close-cancel" ? 130 : 124, variant);
      assert.equal(result.timedOut, variant !== "shell-close-cancel", variant);
      assert.equal(result.cancelled, variant === "shell-close-cancel", variant);
      assert.equal(readFileSync(tree.script, "utf8"), tree.source, "the script is never confused with its output marker");
      assert.equal(existsSync(tree.marker), false, "the descendant has not been released before cleanup");
      if (variant === "disabled-cleanup") {
        assert.equal(result.exitUnconfirmed, true, "a surviving owned tree cannot be reported stopped");
        assert.ok(isAlive(tree.descendantPid));
        const marked = new Promise<void>((resolve, reject) => {
          const watcher = watch(path.dirname(tree.marker), () => {
            if (!existsSync(tree.marker)) return;
            watcher.close();
            clearTimeout(deadline);
            resolve();
          });
          const deadline = setTimeout(() => {
            watcher.close();
            reject(new Error("The disabled-cleanup control did not detect its surviving descendant"));
          }, 10_000);
        });
        writeFileSync(tree.release, "write");
        await marked;
        assert.equal(readFileSync(tree.marker, "utf8"), "late");
      } else {
        // Confirm all owned PIDs are gone before releasing the attempted late write.
        for (const pid of tree.pids) {
          if (pid !== tree.descendantPid) await stopProcess(pid);
          else await waitForExit(pid);
        }
        writeFileSync(tree.release, "write");
        assert.equal(existsSync(tree.marker), false, `${variant}: exited descendants cannot write later`);
      }
      await stopProcess(tree.descendantPid);
      for (const pid of tree.pids) await stopProcess(pid);
      await tree.closed;
    }
    assert.equal(childLaunches, 15);
    t.diagnostic(JSON.stringify({ scenarioId: "HK-04", piLaunches: 0, primaryChildLaunches: childLaunches,
      termination: "absolute Windows taskkill; natural shell tree and explicit shell-close/PID-withholding adapters",
      negativeBarrier: "natural confirmed cleanup checks every PID before release or manual stop; disabled cleanup writes after release",
      cleanup: "all owned PIDs reaped" }));
  } finally {
    t.after(async () => {
      await removeDirectoryEventually(root);
      assert.equal(existsSync(root), false);
    });
  }
});
