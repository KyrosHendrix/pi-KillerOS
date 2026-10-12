import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./ExtensionTestHarness.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const driver = new URL("./support/PiRpcProcess.ts", import.meta.url).href;

for (const fault of ["cancelled", "parent-exit"] as const) {
  test(`RPC driver controls ${fault} without unauthorized writes or PID escalation`, { timeout: 30_000 }, async (t) => {
    const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-rpc-control-"));
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: directory, TMP: directory, PATH: path.dirname(process.execPath) };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    const script = path.join(directory, "control.mjs");
    writeFileSync(script, `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { PiRpcProcess } from ${JSON.stringify(driver)};
const fault = ${JSON.stringify(fault)};
const directory = ${JSON.stringify(directory)};
const release = directory + '/release';
const parentScript = directory + '/parent.mjs';
const descendant = "const fs = require('node:fs'); const parent = Number(process.env.OWNED_PARENT); const emit = type => process.stdout.write(JSON.stringify({type}) + String.fromCharCode(10)); const timer = setInterval(() => { try { process.kill(parent, 0); } catch (error) { if (error.code !== 'ESRCH') throw error; clearInterval(timer); emit('parent_exited'); const barrier = setInterval(() => { if (fs.existsSync(process.env.RELEASE)) { clearInterval(barrier); clearTimeout(deadline); emit('descendant_done'); } }, 5); } }, 5); const deadline = setTimeout(() => { process.exitCode = 2; clearInterval(timer); process.exit(2); }, 6000);";
writeFileSync(parentScript, fault === 'cancelled' ? \
"const emit = value => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10)); const commands = []; let buffer = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { buffer += data; let newline; while ((newline = buffer.indexOf(String.fromCharCode(10))) >= 0) { const packet = JSON.parse(buffer.slice(0,newline)); buffer = buffer.slice(newline + 1); commands.push(packet.type); emit({type:'response', id:packet.id, success:true, data:{commands:[...commands]}}); } }); emit({type:'ready'});" : \
"import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['-e', " + JSON.stringify(descendant) + "], {detached:true, env:{...process.env, OWNED_PARENT:String(process.pid), RELEASE:" + JSON.stringify(release) + "}, stdio:['ignore','inherit','inherit']}); child.unref(); process.stdin.on('data', () => process.stdin.destroy()); process.stdin.on('end', () => process.stdin.destroy()); process.stdout.write(JSON.stringify({type:'ready'}) + String.fromCharCode(10));");
// Shield destructive escalation only in this disposable process. Native exits and pipes stay real.
let unsafeEscalations = 0;
childProcess.execFileSync = () => { unsafeEscalations++; throw new Error('unsafe PID escalation attempted'); };
syncBuiltinESMExports();
const kill = process.kill;
process.kill = (pid, ...args) => { if (pid < 0) { unsafeEscalations++; throw new Error('unsafe group escalation attempted'); } return kill(pid, ...args); };
const owner = new PiRpcProcess({cliPath:parentScript, args:[], cwd:directory, env:process.env});
let failure;
let cleanup;
let releaseTimer;
let state;
try {
  await owner.waitFor(record => record.type === 'ready', {timeoutMs:5000});
  if (fault === 'cancelled') {
    const cancellation = new AbortController();
    const reason = new Error('owned cancellation');
    cancellation.abort(reason);
    await assert.rejects(owner.waitFor(record => record.type === 'ready', {signal:cancellation.signal}), error => error === reason);
    await assert.rejects(owner.command('forbidden', {}, {signal:cancellation.signal}), error => error === reason);
    state = await owner.command('state');
    assert.deepEqual(state.data.commands, ['state']);
    cleanup = await owner.close();
    assert.equal(cleanup.forced, false);
  } else {
    await owner.send({type:'exit-now'});
    await owner.waitFor(record => record.type === 'parent_exited', {timeoutMs:5000});
    const closing = owner.close(1);
    // The grace timer is registered first on this same event loop. Release the explicit pipe barrier afterwards.
    releaseTimer = setTimeout(() => writeFileSync(release, 'go'), 50);
    cleanup = await closing;
    assert.equal(cleanup.forced, false);
    assert.match(cleanup.treeCleanupError, /ownership could not be confirmed/);
    state = await owner.waitFor(record => record.type === 'descendant_done');
  }
  assert.equal(cleanup.exit.code, 0);
  assert.equal(cleanup.exit.signal, null);
  assert.equal(unsafeEscalations, 0);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
finally {
  clearTimeout(releaseTimer);
  writeFileSync(release, 'go');
  try { cleanup = await owner.close(); }
  catch (error) { failure = (failure ?? '') + '\\nCleanup: ' + String(error); }
}
console.log(JSON.stringify({type:'rpc_control_result', fault, failure, state, cleanup, unsafeEscalations, diagnostics:owner.diagnostics()}));
process.exitCode = failure ? 1 : 0;
`);
    const owner = new PiRpcProcess({ cliPath: script, args: [], cwd: directory, env });
    let result: PiRpcRecord | undefined;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      result = await owner.waitFor((record) => record.type === "rpc_control_result", { signal: t.signal, timeoutMs: 20_000 });
      assert.equal(result.failure, undefined, JSON.stringify(result));
      assert.equal(result.unsafeEscalations, 0);
      assert.equal(result.fault, fault);
      assert.ok(typeof result.diagnostics === "string" && result.diagnostics.length <= 32_768);
      const cleanup = await owner.close();
      assert.equal(cleanup.exit.code, 0);
      assert.equal(cleanup.exit.signal, null);
      assert.equal(cleanup.forced, false);
    } catch (error) { failure = error; }
    finally {
      try {
        const cleanup = await owner.close();
        if (cleanup.forced || cleanup.treeCleanupError) cleanupFailures.push(new Error(JSON.stringify(cleanup)));
      } catch (error) { cleanupFailures.push(error); }
    }
    if (failure || cleanupFailures.length) {
      t.diagnostic(JSON.stringify({ scenario: `rpc-${fault}`, directory, node: process.version, platform: process.platform,
        executable: process.execPath, sanitizedCliArgs: [script], result, diagnostics: owner.diagnostics() }));
      throw new AggregateError([...(failure ? [failure] : []), ...cleanupFailures], "RPC subprocess control failed");
    }
    await removeDirectoryEventually(directory);
  });
}
