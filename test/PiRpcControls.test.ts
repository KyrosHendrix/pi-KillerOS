import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess, type PiRpcRecord } from "./support/PiRpcProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const driver = new URL("./support/PiRpcProcess.ts", import.meta.url).href;
const scenarioId = "runtime.system-rpc-controls";
const scenarioTitle = "RPC driver controls report faults without unauthorized writes or PID escalation";
const faults = ["cancelled", "parent-exit", "stdin-closed"] as const;
type RpcFault = (typeof faults)[number];

function parentSource(fault: RpcFault, release: string, descendant: string): string {
  return `
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const fault = ${JSON.stringify(fault)};
const emit = (value) => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
  detached: true,
  env: { ...process.env, OWNED_PARENT: String(process.pid), RELEASE_FILE: ${JSON.stringify(release)} },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.unref();
child.once('spawn', () => {
  const ownership = { pid: child.pid, parentPid: process.pid };
  writeFileSync(process.env.READY_FILE, JSON.stringify(ownership) + String.fromCharCode(10));
  emit({ type: 'descendant_ready', ...ownership });
});
const commands = [];
let buffer = '';
process.stdin.setEncoding('utf8');
if (fault === 'stdin-closed') {
  const deadline = setTimeout(() => process.exit(2), 6000);
  const releaseCheck = setInterval(() => {
    if (!existsSync(process.env.RELEASE_FILE)) return;
    clearInterval(releaseCheck);
    clearTimeout(deadline);
  }, 5);
  process.stdin.once('data', (data) => {
    if (data.includes('"type":"forbidden"')) writeFileSync(process.env.FORBIDDEN_WRITE_FILE, 'forbidden');
    process.stdin.destroy();
  });
} else {
  process.stdin.on('data', (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf(String.fromCharCode(10))) >= 0) {
      const packet = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      commands.push(packet.type);
      if (packet.type === 'forbidden') writeFileSync(process.env.FORBIDDEN_WRITE_FILE, 'forbidden');
      if (fault === 'cancelled') {
        emit({ type: 'response', id: packet.id, success: true, data: { commands: [...commands] } });
      } else if (packet.type === 'exit-now') {
        process.stdin.destroy();
      }
    }
  });
}
process.stdin.on('end', () => process.stdin.destroy());
emit({ type: 'ready' });
`;
}

function controlSource(fault: RpcFault, directory: string, parentScript: string, release: string): string {
  return `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PiRpcProcess } from ${JSON.stringify(driver)};

const fault = ${JSON.stringify(fault)};
const release = ${JSON.stringify(release)};
const forbiddenWrite = process.env.FORBIDDEN_WRITE_FILE;
let unsafeEscalations = 0;
// Shield destructive escalation only in this disposable process. Native exits and pipes stay real.
const executeFile = childProcess.execFileSync;
let ownedPid;
childProcess.execFileSync = (file, args, ...options) => {
  if (String(file).toLowerCase().endsWith('taskkill.exe') && args?.includes(String(ownedPid))) {
    unsafeEscalations += 1;
    throw new Error('unsafe PID escalation attempted');
  }
  return executeFile(file, args, ...options);
};
syncBuiltinESMExports();
const kill = process.kill;
process.kill = (pid, ...args) => {
  if (ownedPid !== undefined && pid === -ownedPid) {
    unsafeEscalations += 1;
    throw new Error('unsafe group escalation attempted');
  }
  return kill(pid, ...args);
};

const owner = new PiRpcProcess({ cliPath: ${JSON.stringify(parentScript)}, args: [], cwd: ${JSON.stringify(directory)}, env: process.env });
ownedPid = JSON.parse(owner.diagnostics()).pid;
let failure;
const cleanupErrors = [];
let cleanup;
let closeOperation;
let closeSettled = false;
let releaseAttempted = false;
let state;
let readiness;
let parentExited;
let descendantDone;
let ownership;
let descendantGone = false;

const errorText = (error) => error instanceof Error ? error.stack || error.message : String(error);
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
};
const releaseDescendant = () => {
  if (releaseAttempted) return;
  releaseAttempted = true;
  writeFileSync(release, 'go');
};

try {
  const [readyRecord, descendantRecord] = await Promise.all([
    owner.waitForRecord((record) => record.type === 'ready', { timeoutMs: 5000 }),
    owner.waitForRecord((record) => record.type === 'descendant_ready', { timeoutMs: 5000 }),
  ]);
  const parentPid = JSON.parse(owner.diagnostics()).pid;
  const descendantPid = descendantRecord.value.pid;
  readiness = JSON.parse(readFileSync(process.env.READY_FILE, 'utf8'));
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0, 'parent PID is valid');
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'descendant PID is valid');
  assert.notEqual(descendantPid, parentPid);
  assert.equal(descendantRecord.value.parentPid, parentPid);
  assert.deepEqual(readiness, { pid: descendantPid, parentPid }, 'the complete readiness file matches the emitted owned PIDs');
  const readySequence = Math.max(readyRecord.sequence, descendantRecord.sequence);

  if (fault === 'cancelled') {
    const cancellation = new AbortController();
    const reason = new Error('owned cancellation');
    cancellation.abort(reason);
    await assert.rejects(owner.waitFor((record) => record.type === 'ready', { signal: cancellation.signal }), (error) => error === reason);
    await assert.rejects(owner.command('forbidden', {}, { signal: cancellation.signal }), (error) => error === reason);
    state = await owner.command('state');
    assert.deepEqual(state.data.commands, ['state']);
    assert.equal(existsSync(forbiddenWrite), false, 'cancelled command must not create its write marker');
    releaseDescendant();
    closeOperation = owner.close();
  } else if (fault === 'stdin-closed') {
    const rejectedWrite = assert.rejects(owner.send({ type: 'closed-input', data: 'x'.repeat(1024 * 1024) }), /EOF|EPIPE|closed|destroyed/i);
    releaseDescendant();
    await rejectedWrite;
    assert.match(JSON.parse(owner.diagnostics()).failure, /EOF|EPIPE|closed|destroyed/i);
    assert.equal(existsSync(forbiddenWrite), false, 'closed input must not create its write marker');
    closeOperation = owner.close();
  } else {
    const parentExitWait = owner.waitForRecord((record) => record.type === 'parent_exited', { after: readySequence, timeoutMs: 5000 });
    await owner.send({ type: 'exit-now' });
    parentExited = await parentExitWait;
    assert.equal(parentExited.value.pid, descendantPid);
    assert.equal(parentExited.value.parentPid, parentPid);
    assert.equal(parentExited.value.observedBy, 'ESRCH');
    assert.equal(gone(descendantPid), false, 'the owned descendant remains alive at the observed parent-exit boundary');
    assert.equal(existsSync(forbiddenWrite), false, 'parent exit must not create the forbidden write marker');
    closeOperation = owner.close(0);
    releaseDescendant();
  }

  if (!closeOperation) closeOperation = owner.close();
  try {
    cleanup = await closeOperation;
    closeSettled = true;
  } catch (error) {
    closeSettled = true;
    throw error;
  }
  if (fault === 'parent-exit') {
    assert.equal(cleanup.forced, false);
    assert.match(cleanup.treeCleanupError, /ownership could not be confirmed/);
  } else {
    assert.equal(cleanup.forced, false);
    assert.equal(cleanup.treeCleanupError, undefined);
  }

  if (fault === 'stdin-closed') {
    parentExited = { value: JSON.parse(readFileSync(process.env.PARENT_EXIT_FILE, 'utf8')) };
  } else if (!parentExited) {
    parentExited = await owner.waitForRecord((record) => record.type === 'parent_exited', { after: readySequence, timeoutMs: 5000 });
  }
  assert.equal(parentExited.value.pid, descendantPid);
  assert.equal(parentExited.value.parentPid, parentPid);
  assert.equal(parentExited.value.observedBy, 'ESRCH');
  if (fault !== 'stdin-closed') {
    descendantDone = await owner.waitForRecord((record) => record.type === 'descendant_done', {
      after: parentExited.sequence,
      timeoutMs: 5000,
    });
  }
  const completion = JSON.parse(readFileSync(process.env.DONE_FILE, 'utf8'));
  assert.deepEqual(completion, { pid: descendantPid, parentPid, completed: true, releaseObserved: true });
  if (descendantDone) {
    assert.equal(descendantDone.value.pid, descendantPid);
    assert.equal(descendantDone.value.parentPid, parentPid);
    assert.equal(descendantDone.value.completed, true);
    assert.equal(descendantDone.value.releaseObserved, true);
  }
  assert.equal(existsSync(forbiddenWrite), false, 'no vector may create the forbidden write marker');
  descendantGone = gone(descendantPid);
  assert.equal(descendantGone, true, 'the owned descendant exits naturally after release');
  assert.equal(cleanup.exit.code, 0);
  assert.equal(cleanup.exit.signal, null);
  assert.equal(unsafeEscalations, 0);
  ownership = {
    parentPid,
    descendantPid,
    readiness,
    completion,
    readySequence,
    parentExitedSequence: parentExited.sequence ?? null,
    completionSequence: descendantDone?.sequence ?? null,
    descendantGone,
  };
} catch (error) {
  failure = errorText(error);
} finally {
  try {
    if (!releaseAttempted) releaseDescendant();
  } catch (error) {
    cleanupErrors.push(errorText(error));
  }
  if (!closeOperation) closeOperation = owner.close();
  if (!closeSettled) {
    try {
      cleanup = await closeOperation;
      closeSettled = true;
    } catch (error) {
      closeSettled = true;
      cleanupErrors.push(errorText(error));
    }
  }
  childProcess.execFileSync = executeFile;
  process.kill = kill;
  syncBuiltinESMExports();
}
const failures = [...(failure === undefined ? [] : [failure]), ...cleanupErrors];
console.log(JSON.stringify({
  type: 'rpc_control_result', fault, failure, cleanupErrors, state, ownership,
  parentPid: ownership?.parentPid,
  descendantPid: ownership?.descendantPid,
  readiness: ownership?.readiness,
  completion: ownership?.completion,
  descendantGone,
  forbiddenWriteAbsent: !existsSync(forbiddenWrite),
  childLaunches: ['parent', 'descendant'],
  cleanup,
  unsafeEscalations,
  diagnostics: owner.diagnostics(),
}));
process.exitCode = failures.length > 0 ? 1 : 0;
`;
}

/** Runs one fresh control vector and reports only bounded failure evidence on error. */
async function runFault(fault: RpcFault, t: TestContext): Promise<void> {
  const startedAt = Date.now();
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-rpc-control-"));
  const script = path.join(directory, "control.mjs");
  const errors: unknown[] = [];
  let owner: PiRpcProcess | undefined;
  let result: PiRpcRecord | undefined;

  try {
    const release = path.join(directory, "release");
    const parentScript = path.join(directory, "parent.mjs");
    const descendant = `
const fs = require('node:fs');
const writeFileSync = fs.writeFileSync;
const parentPid = Number(process.env.OWNED_PARENT);
const pid = process.pid;
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ type, pid, parentPid, ...fields }) + String.fromCharCode(10));
const deadline = setTimeout(() => {
  writeFileSync(process.env.DONE_FILE, JSON.stringify({ pid, parentPid, completed: false, releaseObserved: false }) + String.fromCharCode(10));
  process.exit(2);
}, 6000);
const timer = setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    clearInterval(timer);
    const parentExit = { pid, parentPid, observedBy: 'ESRCH' };
    writeFileSync(process.env.PARENT_EXIT_FILE, JSON.stringify(parentExit) + String.fromCharCode(10));
    emit('parent_exited', parentExit);
    const barrier = setInterval(() => {
      if (fs.existsSync(process.env.RELEASE_FILE)) {
        clearInterval(barrier);
        clearTimeout(deadline);
        const completion = { pid, parentPid, completed: true, releaseObserved: true };
        writeFileSync(process.env.DONE_FILE, JSON.stringify(completion) + String.fromCharCode(10));
        emit('descendant_done', completion);
      }
    }, 5);
  }
}, 5);
`;
    writeFileSync(parentScript, parentSource(fault, release, descendant));
    const env: NodeJS.ProcessEnv = {
      HOME: directory,
      USERPROFILE: directory,
      TEMP: directory,
      TMP: directory,
      PATH: path.dirname(process.execPath),
      READY_FILE: path.join(directory, "ready.json"),
      PARENT_EXIT_FILE: path.join(directory, "parent-exited.json"),
      DONE_FILE: path.join(directory, "done.json"),
      RELEASE_FILE: release,
      FORBIDDEN_WRITE_FILE: path.join(directory, "forbidden-write"),
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      if (value !== undefined) env[key] = value;
    }
    writeFileSync(script, controlSource(fault, directory, parentScript, release));
    owner = new PiRpcProcess({ cliPath: script, args: [], cwd: directory, env });

    try {
      result = await owner.waitFor((record) => record.type === "rpc_control_result", {
        signal: t.signal,
        timeoutMs: 20_000,
      });
      assert.equal(result.failure, undefined, `${fault}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.cleanupErrors, [], `${fault}: cleanup errors are aggregated without being lost`);
      assert.equal(result.unsafeEscalations, 0, `${fault}: no unsafe PID escalation`);
      assert.equal(result.fault, fault, `${fault}: the control identifies the actual fault`);
      assert.ok(typeof result.parentPid === "number" && Number.isSafeInteger(result.parentPid) && result.parentPid > 0,
        `${fault}: the parent PID is validated`);
      assert.ok(typeof result.descendantPid === "number" && Number.isSafeInteger(result.descendantPid) && result.descendantPid > 0,
        `${fault}: the descendant PID is validated`);
      assert.notEqual(result.descendantPid, result.parentPid, `${fault}: the owned PIDs are distinct`);
      assert.deepEqual(result.readiness, { pid: result.descendantPid, parentPid: result.parentPid },
        `${fault}: complete readiness-file contents match both validated PIDs`);
      assert.deepEqual(result.completion, {
        pid: result.descendantPid,
        parentPid: result.parentPid,
        completed: true,
        releaseObserved: true,
      }, `${fault}: the descendant completed naturally after the explicit release`);
      assert.equal(result.descendantGone, true, `${fault}: the owned descendant is gone`);
      assert.equal(result.forbiddenWriteAbsent, true, `${fault}: forbidden command writes leave no marker`);
      assert.deepEqual(result.childLaunches, ["parent", "descendant"], `${fault}: both real fixture processes ran`);
      assert.ok(typeof result.diagnostics === "string" && result.diagnostics.length <= 32_768,
        `${fault}: control diagnostics stay bounded`);
      const cleanup = await owner.close();
      assert.equal(cleanup.exit.code, 0, `${fault}: outer control exits naturally`);
      assert.equal(cleanup.exit.signal, null, `${fault}: outer control has no signal exit`);
      assert.equal(cleanup.forced, false, `${fault}: outer control is not forced`);
    } catch (error) {
      errors.push(error);
    } finally {
      if (owner) {
        try {
          const cleanup = await owner.close();
          if (cleanup.forced || cleanup.treeCleanupError) errors.push(new Error(`${fault}: outer cleanup ${JSON.stringify(cleanup)}`));
        } catch (error) {
          errors.push(error);
        }
      }
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      await removeDirectoryEventually(directory);
      assert.equal(existsSync(directory), false, `${fault}: remove the complete owned fixture directory`);
    } catch (error) {
      errors.push(error);
    }
  }

  if (Date.now() - startedAt > 30_000) {
    errors.push(new Error(`${scenarioId} ${fault} exceeded the original 30-second vector budget`));
  }
  if (errors.length > 0) {
    let failureDirectory: string;
    try {
      failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-${scenarioId}-${fault}-`));
    } catch (error) {
      throw new AggregateError([...errors, error], `${scenarioId} ${fault} could not create failure evidence`);
    }
    try {
      throwScenarioFailure({
        directory: failureDirectory,
        message: `${scenarioId} ${fault} failed`,
        errors,
        diagnostics: JSON.stringify({
          scenario: scenarioId,
          fault,
          directory,
          node: process.version,
          platform: process.platform,
          executable: process.execPath,
          sanitizedCliArgs: [script],
          result,
          diagnostics: owner?.diagnostics(),
        }).slice(0, 32_768),
      });
    } catch (error) {
      if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
        try {
          await removeDirectoryEventually(failureDirectory);
        } catch (cleanupError) {
          throw new AggregateError([...errors, error, cleanupError], `${scenarioId} ${fault} failed and failure evidence cleanup failed`);
        }
      }
      throw error;
    }
  }
}

test(scenarioTitle, { timeout: 95_000 }, async (t) => {
  for (const fault of faults) {
    await runFault(fault, t);
  }
});
