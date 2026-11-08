import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenarioId = "goals.file-baseline-race";
const scenarioTitle = "baseline capture rejects a file swapped between inspection and open";
const originalContent = "original";
const controlContent = "original-file";
const controlReplacementContent = "short";

type RecordValue = Record<string, unknown>;
type PromiseOutcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label = "JSON object"): RecordValue {
  if (!isRecord(value)) throw new Error(`Expected ${label} to be a JSON object`);
  return value;
}

function records(value: unknown, label = "JSON array"): RecordValue[] {
  if (!Array.isArray(value)) throw new Error(`Expected ${label} to be a JSON array`);
  return value.map((entry) => record(entry, label));
}

function parseJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  return parsed;
}

function stringField(value: RecordValue, name: string): string {
  const field = value[name];
  if (typeof field !== "string") throw new Error(`Expected string field ${name}`);
  return field;
}

function numberField(value: RecordValue, name: string): number {
  const field = value[name];
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`Expected numeric field ${name}`);
  return field;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function outcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value): PromiseOutcome<T> => ({ kind: "resolved", value }),
    (error: unknown): PromiseOutcome<T> => ({ kind: "rejected", error }),
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function goalEntries(entries: RecordValue[]): RecordValue[] {
  return entries.filter((entry) => entry.type === "custom" && entry.customType === "killeros-goal");
}

async function waitForJson(
  filePath: string,
  predicate: (value: RecordValue) => boolean,
  timeoutMs: number,
  label: string,
): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(filePath)) {
      const value = record(parseJson(readFileSync(filePath, "utf8")));
      if (predicate(value)) return value;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

async function waitForAdapterAcknowledgement(
  acknowledgementPath: string,
  failurePath: string,
  timeoutMs: number,
): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(failurePath)) {
      const failure = record(parseJson(readFileSync(failurePath, "utf8")));
      throw new Error(
        `Filesystem adapter failed during ${stringField(failure, "operation")}: ${stringField(failure, "message")}`,
      );
    }
    if (existsSync(acknowledgementPath)) {
      return record(parseJson(readFileSync(acknowledgementPath, "utf8")));
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the child acknowledgement after the goal baseline lstat");
    await sleep(10);
  }
}

const adapterSource = String.raw`
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const planPath = process.env.KILLEROS_FILE_RACE_PLAN;
if (!planPath) throw new Error("KILLEROS_FILE_RACE_PLAN is not set");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
function planPathValue(name) {
  if (typeof plan[name] !== "string") throw new Error("Invalid file-race plan path: " + name);
  return path.resolve(plan[name]);
}
const target = planPathValue("target");
const mixedTarget = planPathValue("mixedTarget");
const statusPath = planPathValue("status");
const acknowledgementPath = planPathValue("acknowledgement");
const mixedLstatAcknowledgementPath = planPathValue("mixedLstatAcknowledgement");
const mixedOpenAcknowledgementPath = planPathValue("mixedOpenAcknowledgement");
const failurePath = planPathValue("failure");
const barriers = {
  identityOpen: { release: planPathValue("release"), acknowledgement: acknowledgementPath },
  mixedLstat: { release: planPathValue("mixedLstatRelease"), acknowledgement: mixedLstatAcknowledgementPath },
  mixedOpen: { release: planPathValue("mixedOpenRelease"), acknowledgement: mixedOpenAcknowledgementPath },
};
const waitTimeoutMs = Number.isSafeInteger(plan.waitTimeoutMs) ? plan.waitTimeoutMs : 20_000;
const originalOpen = fsp.open;
const originalLstat = fsp.lstat;
const status = {
  adapterPid: process.pid,
  target,
  intercepts: 0,
  lstatIntercepts: 0,
  forwarded: 0,
  unrelatedForwarded: 0,
  repeatedTargetCalls: 0,
  identityOpenIntercepted: false,
  mixedOpenIntercepted: false,
  restored: false,
  targetOperationCompleted: false,
  events: [],
};
function writeJsonAtomic(filePath, value) {
  const temporary = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}
function recordEvent(event, extra = {}) {
  status.events.push({ at: new Date().toISOString(), event, ...extra });
  if (status.events.length > 16) status.events.shift();
}
function recordFailure(operation, error) {
  const failure = {
    adapterPid: process.pid,
    target,
    operation,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack || "").slice(0, 4_000) : null,
    recordedAt: new Date().toISOString(),
  };
  try {
    writeJsonAtomic(failurePath, failure);
  } catch (reportError) {
    process.stderr.write(JSON.stringify({
      adapterFailure: failure,
      failureReportError: reportError instanceof Error ? reportError.message : String(reportError),
    }) + "\n");
  }
}
function waitForRelease(releasePath, label) {
  const deadline = Date.now() + waitTimeoutMs;
  return new Promise((resolve, reject) => {
    function check() {
      if (fs.existsSync(releasePath)) {
        resolve(fs.readFileSync(releasePath, "utf8"));
      } else if (Date.now() >= deadline) {
        reject(new Error("File-race " + label + " barrier timed out after " + waitTimeoutMs + "ms"));
      } else {
        setTimeout(check, 10);
      }
    }
    check();
  });
}
const hashFile = (filePath) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
function restoreAdapter() {
  if (status.restored) return;
  fsp.open = originalOpen;
  fsp.lstat = originalLstat;
  syncBuiltinESMExports();
  status.restored = true;
  recordEvent("adapter-restored");
}
fsp.lstat = async function lstatWithMixedSnapshotBarrier(...args) {
  const filePath = args[0];
  const options = args[1];
  const isMixedTarget = typeof filePath === "string" && path.resolve(filePath).toLowerCase() === mixedTarget.toLowerCase();
  const wantsBigint = typeof options === "object" && options !== null && options.bigint === true;
  if (!isMixedTarget || !wantsBigint || status.lstatIntercepts > 0) {
    return originalLstat.apply(fsp, args);
  }
  status.lstatIntercepts += 1;
  let operation = "inspect mixed-snapshot target path";
  try {
    const inspected = await originalLstat.apply(fsp, args);
    const ack = {
      adapterPid: process.pid,
      target: mixedTarget,
      size: Number(inspected.size),
      exactSize: inspected.size.toString(),
      exactInode: inspected.ino.toString(),
      mtimeNs: inspected.mtimeNs.toString(),
      contentHash: hashFile(mixedTarget),
      acknowledgedAt: new Date().toISOString(),
    };
    operation = "publish mixed-snapshot lstat acknowledgement";
    writeJsonAtomic(barriers.mixedLstat.acknowledgement, ack);
    recordEvent("mixed-lstat-paused", { size: ack.size, exactInode: ack.exactInode });
    operation = "wait for parent lstat release";
    await waitForRelease(barriers.mixedLstat.release, "mixed lstat");
    recordEvent("mixed-lstat-release-observed");
    return inspected;
  } catch (error) {
    recordFailure(operation, error);
    restoreAdapter();
    throw error;
  }
};
fsp.open = async function openWithFileRace(...args) {
  const filePath = args[0];
  const isTarget = typeof filePath === "string" && path.resolve(filePath).toLowerCase() === target.toLowerCase();
  const isMixedTarget = typeof filePath === "string" && path.resolve(filePath).toLowerCase() === mixedTarget.toLowerCase();
  if (!isTarget && !isMixedTarget) {
    status.unrelatedForwarded += 1;
    return originalOpen.apply(fsp, args);
  }
  const stage = isTarget ? "identity" : "mixed";
  const stageIntercepted = stage === "identity" ? status.identityOpenIntercepted : status.mixedOpenIntercepted;
  if (stageIntercepted) {
    status.repeatedTargetCalls += 1;
    return originalOpen.apply(fsp, args);
  }
  if (stage === "identity") status.identityOpenIntercepted = true;
  else status.mixedOpenIntercepted = true;
  status.intercepts += 1;
  let releaseObserved = false;
  let operation = "inspect " + stage + " target path";
  try {
    const stageTarget = stage === "identity" ? target : mixedTarget;
    const barrier = stage === "identity" ? barriers.identityOpen : barriers.mixedOpen;
    const inspected = fs.lstatSync(stageTarget);
    const ack = {
      adapterPid: process.pid,
      target: stageTarget,
      size: inspected.size,
      inode: inspected.ino,
      exactInode: fs.lstatSync(stageTarget, { bigint: true }).ino.toString(),
      device: inspected.dev,
      mtimeMs: inspected.mtimeMs,
      contentHash: hashFile(stageTarget),
      acknowledgedAt: new Date().toISOString(),
    };
    operation = "publish " + stage + " open acknowledgement";
    writeJsonAtomic(barrier.acknowledgement, ack);
    recordEvent(stage + "-open-paused", { size: ack.size, contentHash: ack.contentHash });
    operation = "wait for parent " + stage + " open release";
    await waitForRelease(barrier.release, stage + " open");
    releaseObserved = true;
    recordEvent(stage + "-open-release-observed");
    if (stage === "mixed") restoreAdapter();
    if (!releaseObserved) throw new Error(stage + " open barrier was not released");
    operation = "forward " + stage + " target open";
    const handle = await originalOpen.apply(fsp, args);
    status.forwarded += 1;
    status.targetOperationCompleted = status.forwarded === 2;
    recordEvent(stage + "-open-completed");
    operation = "write final adapter status";
    writeJsonAtomic(statusPath, status);
    return handle;
  } catch (error) {
    recordFailure(operation, error);
    restoreAdapter();
    throw error;
  }
};
syncBuiltinESMExports();
recordEvent("adapter-armed");
writeJsonAtomic(statusPath, status);
`;

test(scenarioTitle, { timeout: 90_000 }, async () => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const scratch = mkdtempSync(path.join(os.tmpdir(), "killeros-file-baseline-race-"));
  const project = path.join(scratch, "project");
  const agent = path.join(scratch, "agent");
  const sessions = path.join(scratch, "sessions");
  const requested = path.join(project, "requested.md");
  const replacement = path.join(project, "replacement.md");
  const original = path.join(project, "original.md");
  const control = path.join(project, "control.md");
  const controlReplacement = path.join(project, "control-replacement.md");
  const controlOriginal = path.join(project, "control-original.md");
  const planPath = path.join(scratch, "race-plan.json");
  const releasePath = path.join(scratch, "open-release");
  const mixedLstatReleasePath = path.join(scratch, "mixed-lstat-release");
  const mixedOpenReleasePath = path.join(scratch, "mixed-open-release");
  const adapterStatusPath = path.join(scratch, "adapter-status.json");
  const adapterAcknowledgementPath = path.join(scratch, "adapter-acknowledgement.json");
  const mixedLstatAcknowledgementPath = path.join(scratch, "mixed-lstat-acknowledgement.json");
  const mixedOpenAcknowledgementPath = path.join(scratch, "mixed-open-acknowledgement.json");
  const adapterFailurePath = path.join(scratch, "adapter-failure.json");
  const adapterPath = path.join(scratch, "fs-open-adapter.cjs");
  const identityBarrier = { path: releasePath, released: false };
  const mixedLstatBarrier = { path: mixedLstatReleasePath, released: false };
  const mixedOpenBarrier = { path: mixedOpenReleasePath, released: false };
  let providerRequestCount = 0;
  const providerFaults: string[] = [];
  const errors: unknown[] = [];
  const cleanup = {
    piLaunches: 0,
    otherOwnedChildLaunches: 0,
    rpcCommands: 0,
    forced: null as boolean | null,
    exitCode: null as number | null,
    exitSignal: null as NodeJS.Signals | null,
    treeCleanupError: null as string | null,
    serverClosed: false,
    scratchRemoved: false,
  };
  let rpc: PiRpcProcess | undefined;
  let serverListening = false;
  let adapterStatus: RecordValue | undefined;
  let adapterAcknowledgementEvidence: string | undefined;
  let mixedLstatAcknowledgementEvidence: string | undefined;
  let mixedOpenAcknowledgementEvidence: string | undefined;
  let adapterStatusEvidence: string | undefined;
  let adapterFailureEvidence: string | undefined;
  let identityNumericInodeCollision: boolean | undefined;

  const server = createServer((request, response) => {
    const requestNumber = ++providerRequestCount;
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      let byteCount = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        byteCount += chunk.length;
        assert.ok(byteCount <= 1_048_576, "fixture provider request exceeded 1 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(parseJson(Buffer.concat(chunks).toString("utf8")));
      assert.equal(body.model, "local");
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `file-baseline-race-${requestNumber}`,
        model: "local",
        choices: [{ index: 0, delta: { content: "No turn decision." }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      providerFaults.push(errorText(error).slice(0, 4_000));
      if (!response.destroyed) {
        response.writeHead(500, { connection: "close" });
        response.end("File-baseline fixture rejected the request");
      }
    });
  });

  const releaseBarrier = (barrier: { path: string; released: boolean }): void => {
    if (barrier.released) return;
    barrier.released = true;
    try {
      writeFileSync(barrier.path, "release\n");
    } catch (error) {
      errors.push(error);
    }
  };

  try {
    mkdirSync(project);
    mkdirSync(agent);
    mkdirSync(sessions);
    writeFileSync(adapterPath, adapterSource, "utf8");

    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    writeFileSync(requested, originalContent);
    writeFileSync(replacement, originalContent);
    writeFileSync(control, controlContent);
    writeFileSync(controlReplacement, controlReplacementContent);
    utimesSync(requested, timestamp, timestamp);
    utimesSync(replacement, timestamp, timestamp);
    const controlTimestampSeconds = 1_767_225_600.123456;
    utimesSync(control, controlTimestampSeconds, controlTimestampSeconds);
    utimesSync(controlReplacement, controlTimestampSeconds, controlTimestampSeconds);
    const originalStats = statSync(requested);
    const replacementStats = statSync(replacement);
    assert.equal(readFileSync(requested, "utf8"), readFileSync(replacement, "utf8"));
    assert.equal(originalStats.size, replacementStats.size);
    assert.equal(originalStats.mtimeMs, replacementStats.mtimeMs);
    assert.equal(originalStats.dev, replacementStats.dev);
    // Windows file IDs exceed 2^53, so numeric inode values can collide for distinct files.
    const originalExactInode = statSync(requested, { bigint: true }).ino;
    assert.notEqual(originalExactInode, statSync(replacement, { bigint: true }).ino,
      "the equal-content replacement must have a different file identity");
    identityNumericInodeCollision = originalStats.ino === replacementStats.ino;

    writeFileSync(planPath, JSON.stringify({
      target: requested,
      mixedTarget: control,
      release: releasePath,
      mixedLstatRelease: mixedLstatReleasePath,
      mixedOpenRelease: mixedOpenReleasePath,
      status: adapterStatusPath,
      acknowledgement: adapterAcknowledgementPath,
      mixedLstatAcknowledgement: mixedLstatAcknowledgementPath,
      mixedOpenAcknowledgement: mixedOpenAcknowledgementPath,
      failure: adapterFailurePath,
      waitTimeoutMs: 30_000,
    }, null, 2));

    const provider = await new Promise<{ port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Fixture provider did not bind a TCP port"));
          return;
        }
        resolve({ port: address.port });
      });
    });
    serverListening = true;

    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "off",
    }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({
      providers: {
        "baseline-race-local": {
          api: "openai-completions",
          apiKey: "fixture-only",
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: [{
            id: "local",
            name: "Local file baseline fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }));

    const session = SessionManager.create(project, sessions);
    session.appendMessage({
      role: "user",
      content: "Fixture session for the file-baseline race.",
      timestamp: Date.now(),
    });
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);

    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    const inheritedPath = inherited.get("path");
    const environment: NodeJS.ProcessEnv = {
      HOME: scratch,
      USERPROFILE: scratch,
      APPDATA: scratch,
      LOCALAPPDATA: scratch,
      TEMP: scratch,
      TMP: scratch,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      KILLEROS_FILE_RACE_PLAN: planPath,
      NODE_OPTIONS: `--require "${adapterPath.replaceAll("\\", "/")}"`,
      PATH: inheritedPath
        ? `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`
        : path.dirname(process.execPath),
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = inherited.get(key.toLowerCase());
      if (value !== undefined) environment[key] = value;
    }

    const owner = rpc = new PiRpcProcess({
      cliPath: path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      cwd: project,
      env: environment,
      args: [
        "--mode", "rpc",
        "--model", "baseline-race-local/local",
        "--thinking", "off",
        "--tools", "killeros_goal_update",
        "--session", sessionFile,
        "--offline",
        "--approve",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-mcp",
        "--no-extensions",
        "--extension", repositoryRoot,
      ],
    });
    cleanup.piLaunches += 1;

    const command = async (type: string, fields: RecordValue = {}, timeoutMs = 15_000) => {
      cleanup.rpcCommands += 1;
      return await owner.command(type, fields, { timeoutMs });
    };
    const state = async (): Promise<RecordValue> => record((await command("get_state")).data);
    const entries = async (): Promise<RecordValue[]> => records(record((await command("get_entries")).data).entries);

    const initialState = await state();
    assert.equal(initialState.isStreaming, false);
    assert.equal(initialState.isCompacting, false);
    assert.equal(initialState.pendingMessageCount, 0);
    assert.equal(initialState.sessionFile, sessionFile);
    const commandsResponse = await command("get_commands");
    const commandNames = records(record(commandsResponse.data).commands).map((entry) => stringField(entry, "name"));
    assert.ok(commandNames.includes("goal"), "the installed KillerOS extension must register /goal");
    assert.equal(goalEntries(await entries()).length, 0);

    const raceMessage = `/goal Create the file at \`${requested}\``;
    const raceCursor = owner.currentSequence;
    const raceOutcome = outcome(command("prompt", { message: raceMessage }, 30_000));
    try {
      const ack = await waitForAdapterAcknowledgement(adapterAcknowledgementPath, adapterFailurePath, 20_000);
      const childDiagnostics = record(parseJson(owner.diagnostics()));
      assert.equal(numberField(ack, "adapterPid"), numberField(childDiagnostics, "pid"));
      assert.equal(path.resolve(stringField(ack, "target")).toLowerCase(), path.resolve(requested).toLowerCase());
      assert.equal(numberField(ack, "size"), originalStats.size);
      assert.equal(numberField(ack, "mtimeMs"), originalStats.mtimeMs);
      assert.equal(numberField(ack, "device"), originalStats.dev);
      assert.equal(stringField(ack, "exactInode"), originalExactInode.toString());
      assert.equal(stringField(ack, "contentHash"), sha256(originalContent));

      renameSync(requested, original);
      renameSync(replacement, requested);
      const replacementAtPath = statSync(requested);
      assert.equal(readFileSync(requested, "utf8"), originalContent);
      assert.equal(replacementAtPath.size, numberField(ack, "size"));
      assert.equal(replacementAtPath.mtimeMs, numberField(ack, "mtimeMs"));
      assert.equal(replacementAtPath.dev, numberField(ack, "device"));
      assert.notEqual(statSync(requested, { bigint: true }).ino.toString(), stringField(ack, "exactInode"));
      assert.equal(sha256(readFileSync(requested)), stringField(ack, "contentHash"));
      assert.equal(readFileSync(original, "utf8"), originalContent);
      assert.equal(replacementAtPath.ino, replacementStats.ino);
      assert.equal(replacementAtPath.ino === originalStats.ino, identityNumericInodeCollision);
    } finally {
      releaseBarrier(identityBarrier);
    }

    const raceResult = await raceOutcome;
    if (raceResult.kind === "rejected") throw raceResult.error;
    assert.equal(raceResult.value.success, true);
    assert.equal(record(raceResult.value.data).disposition, "handled");

    const raceNotice = await owner.waitFor(
      (entry) => entry.type === "extension_ui_request"
        && entry.method === "notify",
      { after: raceCursor, timeoutMs: 15_000 },
    );
    assert.equal(raceNotice.message, "Goal could not be started: Goal deliverable changed while it was being inspected",
      "the swapped identity must reject baseline capture");
    assert.equal(raceNotice.notifyType, "error");
    const failedEntries = await entries();
    assert.equal(goalEntries(failedEntries).length, 0, "the rejected baseline must not persist a goal");
    const stateAfterRace = await state();
    assert.equal(stateAfterRace.isStreaming, false);
    assert.equal(stateAfterRace.isCompacting, false);
    assert.equal(stateAfterRace.pendingMessageCount, 0);
    assert.equal(providerRequestCount, 0, "a rejected /goal must not start provider work");

    const statusCursor = owner.currentSequence;
    const statusResponse = await command("prompt", { message: "/goal" });
    assert.equal(record(statusResponse.data).disposition, "handled");
    const noGoalNotice = await owner.waitFor(
      (entry) => entry.type === "extension_ui_request"
        && entry.method === "notify"
        && typeof entry.message === "string"
        && entry.message.startsWith("No goal is set."),
      { after: statusCursor, timeoutMs: 10_000 },
    );

    const controlMessage = `/goal Create the file at \`${control}\``;
    const controlCursor = owner.currentSequence;
    const controlOutcome = outcome(command("prompt", { message: controlMessage }, 30_000));
    try {
      const lstatAck = await waitForAdapterAcknowledgement(
        mixedLstatAcknowledgementPath,
        adapterFailurePath,
        20_000,
      );
      const lstatDiagnostics = record(parseJson(owner.diagnostics()));
      assert.equal(numberField(lstatAck, "adapterPid"), numberField(lstatDiagnostics, "pid"));
      assert.equal(path.resolve(stringField(lstatAck, "target")).toLowerCase(), path.resolve(control).toLowerCase());
      assert.equal(numberField(lstatAck, "size"), Buffer.byteLength(controlContent));
      assert.equal(stringField(lstatAck, "exactSize"), String(Buffer.byteLength(controlContent)));
      assert.equal(stringField(lstatAck, "contentHash"), sha256(controlContent));

      renameSync(control, controlOriginal);
      renameSync(controlReplacement, control);
      const shortFileAtPath = statSync(control, { bigint: true });
      assert.equal(Number(shortFileAtPath.size), Buffer.byteLength(controlReplacementContent));
      assert.notEqual(shortFileAtPath.ino.toString(), stringField(lstatAck, "exactInode"));
      assert.equal(readFileSync(control, "utf8"), controlReplacementContent);
      releaseBarrier(mixedLstatBarrier);

      const openAck = await waitForAdapterAcknowledgement(
        mixedOpenAcknowledgementPath,
        adapterFailurePath,
        20_000,
      );
      assert.equal(numberField(openAck, "adapterPid"), numberField(lstatDiagnostics, "pid"));
      assert.equal(path.resolve(stringField(openAck, "target")).toLowerCase(), path.resolve(control).toLowerCase());
      assert.equal(numberField(openAck, "size"), Buffer.byteLength(controlReplacementContent));
      assert.equal(stringField(openAck, "contentHash"), sha256(controlReplacementContent));

      renameSync(control, controlReplacement);
      renameSync(controlOriginal, control);
      const restoredControl = statSync(control, { bigint: true });
      assert.equal(Number(restoredControl.size), Buffer.byteLength(controlContent));
      assert.equal(restoredControl.ino.toString(), stringField(lstatAck, "exactInode"));
      assert.equal(readFileSync(control, "utf8"), controlContent);
    } finally {
      releaseBarrier(mixedLstatBarrier);
      releaseBarrier(mixedOpenBarrier);
    }

    const controlResponse = await controlOutcome;
    if (controlResponse.kind === "rejected") throw controlResponse.error;
    assert.equal(controlResponse.value.success, true);
    assert.equal(record(controlResponse.value.data).disposition, "handled");
    const controlNotice = await owner.waitFor(
      (entry) => entry.type === "extension_ui_request"
        && entry.method === "notify"
        && typeof entry.message === "string"
        && entry.message.startsWith("Goal started."),
      { after: controlCursor, timeoutMs: 10_000 },
    );
    await owner.waitFor((entry) => entry.type === "agent_settled", { after: controlCursor, timeoutMs: 45_000 });

    const stateAfterControl = await state();
    assert.equal(stateAfterControl.isStreaming, false);
    assert.equal(stateAfterControl.isCompacting, false);
    assert.equal(stateAfterControl.pendingMessageCount, 0);
    assert.equal(providerRequestCount, 1, "the unmodified control must issue one provider request");
    assert.deepEqual(providerFaults, []);

    const controlEntries = goalEntries(await entries());
    assert.equal(controlEntries.length, 3);
    const events = controlEntries.map((entry) => stringField(record(entry.data), "event"));
    assert.deepEqual(events, ["set", "turn", "error"]);
    const lastGoal = controlEntries.at(-1);
    assert.ok(lastGoal);
    const goalData = record(lastGoal.data);
    const savedState = record(goalData.state);
    assert.equal(savedState.status, "paused");
    assert.equal(savedState.turns, 1);
    assert.equal(savedState.stopReason, "no turn decision");
    assert.equal(savedState.objective, controlMessage.slice("/goal ".length));
    const verification = record(savedState.verification);
    assert.equal(verification.kind, "file");
    assert.equal(path.resolve(stringField(verification, "path")).toLowerCase(), path.resolve(control).toLowerCase());
    const baseline = record(verification.baseline);
    assert.equal(baseline.exists, true);
    assert.equal(baseline.size, Buffer.byteLength(controlContent));
    assert.equal(baseline.mtimeMs, statSync(control).mtimeMs);
    assert.equal(baseline.contentHash, sha256(controlContent));
    assert.equal(readFileSync(control, "utf8"), controlContent);

    adapterStatus = await waitForJson(
      adapterStatusPath,
      (value) => value.restored === true && value.targetOperationCompleted === true,
      10_000,
      "filesystem adapter restoration and target-open completion",
    );
    assert.equal(existsSync(adapterFailurePath), false, "the filesystem adapter must not report an operation failure");
    assert.equal(numberField(adapterStatus, "intercepts"), 2);
    assert.equal(numberField(adapterStatus, "lstatIntercepts"), 1);
    assert.equal(numberField(adapterStatus, "forwarded"), 2);
    assert.equal(numberField(adapterStatus, "repeatedTargetCalls"), 0);
    assert.equal(adapterStatus.restored, true);
    assert.equal(adapterStatus.targetOperationCompleted, true);
    const adapterEvents = records(adapterStatus.events).map((entry) => stringField(entry, "event"));
    assert.deepEqual(adapterEvents, [
      "adapter-armed",
      "identity-open-paused",
      "identity-open-release-observed",
      "identity-open-completed",
      "mixed-lstat-paused",
      "mixed-lstat-release-observed",
      "mixed-open-paused",
      "mixed-open-release-observed",
      "adapter-restored",
      "mixed-open-completed",
    ]);
    assert.equal(noGoalNotice.notifyType, "info");
    assert.equal(controlNotice.notifyType, "info");
    assert.equal(cleanup.piLaunches, 1);
    assert.equal(cleanup.otherOwnedChildLaunches, 0);
    assert.equal(cleanup.rpcCommands, 10);
  } catch (error) {
    errors.push(error);
  } finally {
    releaseBarrier(identityBarrier);
    releaseBarrier(mixedLstatBarrier);
    releaseBarrier(mixedOpenBarrier);
    if (rpc) {
      try {
        const closed = await rpc.close();
        cleanup.forced = closed.forced;
        cleanup.exitCode = closed.exit.code;
        cleanup.exitSignal = closed.exit.signal;
        cleanup.treeCleanupError = closed.treeCleanupError ?? null;
        if (closed.forced) errors.push(new Error(`Pi RPC child required forced cleanup: ${rpc.diagnostics()}`));
        if (closed.exit.code !== 0 || closed.exit.signal !== null) errors.push(new Error(`Pi RPC child exited unexpectedly: ${rpc.diagnostics()}`));
        if (closed.treeCleanupError !== undefined) errors.push(new Error(`Pi RPC tree cleanup failed: ${closed.treeCleanupError}`));
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      if (existsSync(adapterAcknowledgementPath)) {
        adapterAcknowledgementEvidence = readFileSync(adapterAcknowledgementPath, "utf8").slice(0, 8_000);
      }
      if (existsSync(mixedLstatAcknowledgementPath)) {
        mixedLstatAcknowledgementEvidence = readFileSync(mixedLstatAcknowledgementPath, "utf8").slice(0, 8_000);
      }
      if (existsSync(mixedOpenAcknowledgementPath)) {
        mixedOpenAcknowledgementEvidence = readFileSync(mixedOpenAcknowledgementPath, "utf8").slice(0, 8_000);
      }
      if (existsSync(adapterStatusPath)) {
        adapterStatusEvidence = readFileSync(adapterStatusPath, "utf8").slice(0, 8_000);
      }
      if (existsSync(adapterFailurePath)) {
        adapterFailureEvidence = readFileSync(adapterFailurePath, "utf8").slice(0, 8_000);
      }
    } catch (error) {
      errors.push(new Error(`Could not preserve filesystem adapter diagnostics: ${errorText(error)}`));
    }
    if (serverListening) {
      try {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        cleanup.serverClosed = true;
      } catch (error) {
        errors.push(error);
      }
    } else {
      cleanup.serverClosed = true;
    }

    try {
      await removeDirectoryEventually(scratch);
      cleanup.scratchRemoved = !existsSync(scratch);
      if (!cleanup.scratchRemoved) throw new Error(`Owned scratch directory remains: ${scratch}`);
    } catch (error) {
      errors.push(error);
      try {
        await removeDirectoryEventually(scratch);
        cleanup.scratchRemoved = !existsSync(scratch);
        if (!cleanup.scratchRemoved) errors.push(new Error(`Owned scratch directory remains: ${scratch}`));
      } catch (retryError) {
        errors.push(retryError);
      }
    }
  }

  if (adapterFailureEvidence !== undefined) {
    errors.push(new Error("Filesystem adapter reported an operation failure; see adapterFailure diagnostics"));
  }

  if (errors.length > 0) {
    let failureDirectory: string;
    try {
      failureDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-${scenarioId}-`));
    } catch (error) {
      throw new AggregateError([...errors, error], `${scenarioId} could not create failure evidence`);
    }

    const diagnostics = JSON.stringify({
      scenarioId,
      scenarioTitle,
      mode: "rpc",
      node: process.version,
      platform: process.platform,
      scratch,
      cleanup,
      identityNumericInodeCollision,
      adapterAcknowledgement: adapterAcknowledgementEvidence,
      mixedLstatAcknowledgement: mixedLstatAcknowledgementEvidence,
      mixedOpenAcknowledgement: mixedOpenAcknowledgementEvidence,
      adapterStatus: adapterStatusEvidence,
      adapterFailure: adapterFailureEvidence,
      providerFaults: providerFaults.slice(0, 4),
      providerRequests: providerRequestCount,
      rpc: rpc?.diagnostics().slice(0, 16 * 1024),
    }, null, 2);
    try {
      throwScenarioFailure({
        directory: failureDirectory,
        message: `${scenarioId} failed`,
        errors,
        diagnostics,
      });
    } catch (error) {
      if (!existsSync(path.join(failureDirectory, "failure.txt"))) {
        try {
          await removeDirectoryEventually(failureDirectory);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `${scenarioId} failed and failure evidence cleanup failed`);
        }
      }
      throw error;
    }
  }
});

// Shared fixtures for the remaining goal completion verification scenarios.
// Every scenario drives fresh installed Pi CLI processes through public RPC or
// terminal input against a loopback scripted provider with exact planned
// responses, and every race is held at an observed provider or acknowledged
// filesystem barrier on an owned path.

type ScenarioContext = { readonly signal: AbortSignal; diagnostic(message: string): void };
type RpcBatch = { label: string; first: number; through: number; records: number };
type ProviderOutcome = "finished" | "closed";
type ProviderRequest = { index: number; body: RecordValue; completion: Promise<ProviderOutcome> };
type ProviderBarrier = { released: Promise<void>; release(): void };
type ProviderPlan = { kind: "stop" }
  | { kind: "goal"; decision: RecordValue }
  | { kind: "held"; barrier: ProviderBarrier; decision?: RecordValue };
type SavedGoalEntry = { id: string; event: string; state: RecordValue | null };
type ProviderWaiter = {
  count: number;
  resolve(request: ProviderRequest): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

const goalStartNotice = "Goal started. Each turn must record continue, complete, or a blocker decision before another turn starts.";
const goalReplaceNotice = "Goal replaced. Each turn must record continue, complete, or a blocker decision before another turn starts.";
const goalFixtureProvider = "goal-verification-local";
const goalFixtureModel = "local";
const abortedToolResultText = "This operation was aborted";

function makeBarrier(): ProviderBarrier {
  let resolveRelease: () => void = () => {};
  let isReleased = false;
  const released = new Promise<void>((resolve) => { resolveRelease = resolve; });
  return {
    released,
    release() {
      if (isReleased) return;
      isReleased = true;
      resolveRelease();
    },
  };
}

class LocalProvider {
  readonly faults: string[] = [];
  readonly requests: ProviderRequest[] = [];
  private readonly server: Server;
  private readonly plans: ProviderPlan[] = [];
  private readonly waiters = new Set<ProviderWaiter>();
  private readonly barriers: ProviderBarrier[] = [];
  private readonly handlers = new Set<Promise<void>>();
  private address = "";

  constructor() {
    this.server = createServer((request, response) => {
      const handling = this.handle(request, response);
      this.handlers.add(handling);
      void handling.then(
        () => this.handlers.delete(handling),
        (error: unknown) => {
          if (this.faults.length < 16) this.faults.push(errorText(error).slice(0, 4_000));
          this.handlers.delete(handling);
        },
      );
    });
  }

  get baseUrl(): string {
    if (!this.address) throw new Error("The loopback goal verification provider is not listening");
    return this.address;
  }

  get requestCount(): number {
    return this.requests.length;
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The loopback goal verification provider did not receive a TCP address"));
          return;
        }
        this.address = `http://127.0.0.1:${address.port}/v1`;
        resolve();
      });
    });
  }

  /** Holds the next request's response; an optional goal decision is delivered after the barrier releases. */
  holdNextRequest(decision?: RecordValue): ProviderBarrier {
    const barrier = makeBarrier();
    this.barriers.push(barrier);
    this.plans.push({ kind: "held", barrier, ...(decision === undefined ? {} : { decision }) });
    return barrier;
  }

  queueGoalDecision(decision: RecordValue): void {
    this.plans.push({ kind: "goal", decision }, { kind: "stop" });
  }

  async waitForRequest(count: number, signal?: AbortSignal): Promise<ProviderRequest> {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid provider request count ${count}`);
    const existing = this.requests[count - 1];
    if (existing) return existing;
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Provider wait was cancelled");
    return await new Promise<ProviderRequest>((resolve, reject) => {
      const waiter: ProviderWaiter = {
        count,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`Timed out waiting for provider request ${count}`));
        }, 30_000),
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal) {
        waiter.abort = () => {
          this.removeWaiter(waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Provider wait was cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  releaseAll(): void {
    for (const barrier of this.barriers) barrier.release();
  }

  async close(): Promise<void> {
    this.releaseAll();
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        this.server.close((error) => error ? reject(error) : resolve());
      });
      const timer = setTimeout(() => this.server.closeAllConnections(), 5_000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
    await Promise.all([...this.handlers]);
    if (this.faults.length > 0) throw new Error(`Loopback provider recorded fixture faults: ${this.faults.slice(0, 4).join("; ")}`);
    if (this.waiters.size > 0) throw new Error(`${this.waiters.size} provider request waiters were never resolved`);
    if (this.plans.length > 0) throw new Error(`${this.plans.length} planned provider responses were never consumed`);
  }

  private removeWaiter(waiter: ProviderWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.waiters.delete(waiter);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        throw new Error(`Unexpected provider request ${request.method} ${request.url}`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Provider request chunk was not bytes");
        bytes += chunk.length;
        if (bytes > 1_048_576) throw new Error("Provider request exceeded 1 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const body = record(parseJson(Buffer.concat(chunks).toString("utf8")));
      const index = this.requests.length + 1;
      let resolveCompletion: (outcome: ProviderOutcome) => void = () => {};
      const completion = new Promise<ProviderOutcome>((resolve) => { resolveCompletion = resolve; });
      response.once("finish", () => resolveCompletion("finished"));
      response.once("close", () => resolveCompletion(response.writableFinished ? "finished" : "closed"));
      const observed = { index, body, completion };
      this.requests.push(observed);
      for (const waiter of [...this.waiters]) {
        if (waiter.count !== index) continue;
        this.removeWaiter(waiter);
        waiter.resolve(observed);
      }
      const plan = this.plans.shift() ?? { kind: "stop" as const };
      const effective: Exclude<ProviderPlan, { kind: "held" }> = plan.kind === "held"
        ? (plan.decision === undefined ? { kind: "stop" } : { kind: "goal", decision: plan.decision })
        : plan;
      if (plan.kind === "held") await plan.barrier.released;
      if (response.destroyed || response.writableEnded) return;
      const delta = effective.kind === "goal"
        ? { tool_calls: [{ index: 0, id: `goal-decision-${index}`, type: "function",
          function: { name: "killeros_goal_update", arguments: JSON.stringify(effective.decision) } }] }
        : { content: "The scripted request has settled." };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({
        id: `goal-verification-${index}`,
        model: "local",
        choices: [{ index: 0, delta, finish_reason: effective.kind === "goal" ? "tool_calls" : "stop" }],
      })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      if (this.faults.length < 16) this.faults.push(errorText(error).slice(0, 4_000));
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { connection: "close" });
        response.end("Goal verification fixture provider failure");
      }
    }
  }
}

type GoalFixtureOptions = {
  seedSession?: (session: SessionManager) => void;
  probe?: { observerPath: string; abortAcknowledgementPath?: string };
  adapterPlan?: {
    target: string;
    holdCall: number;
    acknowledgementPath: string;
    releasePath: string;
    statusPath: string;
    failurePath: string;
    waitTimeoutMs: number;
  };
};

type GoalFixture = {
  directory: string;
  project: string;
  agent: string;
  sessionFile: string;
  currentSessionFile: string;
  currentSessionId: string;
  provider: LocalProvider;
  rpc: PiRpcProcess;
  launchOptions: ConstructorParameters<typeof PiRpcProcess>[0];
  batches: RpcBatch[];
  acknowledgedSequence: number;
  signal: AbortSignal;
  adapterScriptPath?: string;
};

/** Builds one isolated goal fixture: owned project, saved session, loopback provider, fresh installed Pi RPC child. */
async function createGoalFixture(
  parentDirectory: string,
  label: string,
  signal: AbortSignal,
  options: GoalFixtureOptions = {},
): Promise<GoalFixture> {
  const directory = path.join(parentDirectory, label);
  let ownsDirectory = false;
  let provider: LocalProvider | undefined;
  let rpc: PiRpcProcess | undefined;
  let adapterScriptPath: string | undefined;
  try {
    mkdirSync(directory);
    ownsDirectory = true;
    const agent = path.join(directory, "agent");
    const project = path.join(directory, "project");
    const sessions = path.join(directory, "sessions");
    const temporary = path.join(directory, "tmp");
    mkdirSync(agent);
    mkdirSync(project);
    // Keep receipt scans inside the fixture rather than the enclosing checkout.
    execFileSync("git", ["init", "--quiet"], { cwd: project, stdio: "pipe" });
    mkdirSync(sessions);
    mkdirSync(temporary);

    provider = new LocalProvider();
    await provider.listen();
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      defaultThinkingLevel: "off",
    }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({
      providers: {
        [goalFixtureProvider]: {
          api: "openai-completions",
          apiKey: "fixture-only",
          baseUrl: provider.baseUrl,
          models: [{
            id: goalFixtureModel,
            name: "Local goal verification fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 128_000,
            maxTokens: 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    }));

    const session = SessionManager.create(project, sessions);
    session.appendMessage({ role: "user", content: `Goal verification fixture: ${label}.`, timestamp: Date.now() });
    options.seedSession?.(session);
    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile, `the native fixture session must be saved before Pi starts for ${label}`);

    const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
    const inheritedPath = inherited.get("path");
    const environment: NodeJS.ProcessEnv = {
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: directory,
      LOCALAPPDATA: directory,
      TEMP: temporary,
      TMP: temporary,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PATH: inheritedPath
        ? `${path.dirname(process.execPath)}${path.delimiter}${inheritedPath}`
        : path.dirname(process.execPath),
    };
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      const value = inherited.get(key.toLowerCase());
      if (value !== undefined) environment[key] = value;
    }
    const args = [
      "--mode", "rpc",
      "--model", `${goalFixtureProvider}/${goalFixtureModel}`,
      "--thinking", "off",
      "--tools", "killeros_goal_update",
      "--session", sessionFile,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
    ];
    if (options.probe) {
      const probePath = path.join(directory, "goal-race-probe.ts");
      writeFileSync(probePath, raceProbeSource(), "utf8");
      environment.KILLEROS_GOAL_RACE_OBSERVER = options.probe.observerPath;
      if (options.probe.abortAcknowledgementPath) {
        environment.KILLEROS_GOAL_RACE_ABORT_ACK = options.probe.abortAcknowledgementPath;
      }
      args.push("--extension", probePath);
    }
    if (options.adapterPlan) {
      adapterScriptPath = path.join(directory, "goal-verification-adapter.cjs");
      writeFileSync(adapterScriptPath, raceAdapterSource(), "utf8");
      const planPath = path.join(directory, "goal-verification-plan.json");
      writeFileSync(planPath, JSON.stringify({
        target: options.adapterPlan.target,
        holdCall: options.adapterPlan.holdCall,
        acknowledgement: options.adapterPlan.acknowledgementPath,
        release: options.adapterPlan.releasePath,
        status: options.adapterPlan.statusPath,
        failure: options.adapterPlan.failurePath,
        waitTimeoutMs: options.adapterPlan.waitTimeoutMs,
      }, null, 2));
      environment.KILLEROS_GOAL_VERIFICATION_PLAN = planPath;
      environment.NODE_OPTIONS = `--require "${adapterScriptPath.replaceAll("\\", "/")}"`;
    }

    const launchOptions = {
      cliPath: path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      cwd: project,
      env: environment,
      args,
    };
    rpc = new PiRpcProcess(launchOptions);
    return {
      directory,
      project,
      agent,
      sessionFile,
      currentSessionFile: sessionFile,
      currentSessionId: "",
      provider,
      rpc,
      launchOptions,
      batches: [],
      acknowledgedSequence: 0,
      signal,
      ...(adapterScriptPath === undefined ? {} : { adapterScriptPath }),
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    provider?.releaseAll();
    if (rpc) {
      try {
        const closed = await rpc.close();
        if (closed.forced) cleanupErrors.push(new Error(`Pi CLI required forced setup-failure cleanup: ${JSON.stringify(closed)}`));
        if (closed.exit.code !== 0) cleanupErrors.push(new Error(`Pi CLI exited with ${closed.exit.code} during setup failure`));
        if (closed.treeCleanupError !== undefined) cleanupErrors.push(new Error(`Pi CLI tree cleanup was uncertain during setup failure: ${closed.treeCleanupError}`));
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (provider) {
      try { await provider.close(); } catch (closeError) { cleanupErrors.push(closeError); }
    }
    if (ownsDirectory) {
      try { await removeDirectoryEventually(directory); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    throw new AggregateError([error, ...cleanupErrors], `${label}: goal verification fixture setup failed\n${rpc?.diagnostics() ?? "rpc not started"}`);
  }
}

/** Confirms the real KillerOS extension registered /goal and the child is idle without provider traffic. */
async function initializeGoalFixture(fixture: GoalFixture, label: string, expectNoGoal = true): Promise<void> {
  const state = await goalState(fixture);
  assert.equal(stringField(state, "sessionFile"), fixture.currentSessionFile, `${label}: startup session file`);
  fixture.currentSessionId = stringField(state, "sessionId");
  assertGoalIdle(state, `${label}: startup`);
  const commandsResponse = await goalRpcCommand(fixture, "get_commands");
  const commands = records(record(commandsResponse.data, "get_commands data").commands, "registered commands");
  assert.ok(commands.some((command) => stringField(command, "name") === "goal"), `${label}: /goal must be registered`);
  assert.equal(fixture.provider.requestCount, 0, `${label}: startup must not make a provider request`);
  if (expectNoGoal) {
    assert.equal(savedGoalEntries(await goalEntriesOf(fixture)).length, 0, `${label}: the fixture starts without a goal`);
  }
  acknowledgeGoalBatch(fixture, `${label}: startup`);
}

async function goalRpcCommand(fixture: GoalFixture, type: string, fields: RecordValue = {}, timeoutMs = 30_000): Promise<RecordValue> {
  return await fixture.rpc.command(type, fields, { timeoutMs, signal: fixture.signal });
}

async function goalState(fixture: GoalFixture): Promise<RecordValue> {
  return record((await goalRpcCommand(fixture, "get_state")).data, "RPC state");
}

async function goalEntriesOf(fixture: GoalFixture): Promise<RecordValue[]> {
  const data = record((await goalRpcCommand(fixture, "get_entries")).data, "RPC entries response");
  return records(data.entries, "saved session entries");
}

/** Returns the killeros-goal custom entries with their durable event and state. */
function savedGoalEntries(entries: RecordValue[]): SavedGoalEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== "killeros-goal") return [];
    const data = record(entry.data, "saved goal entry data");
    const state = data.state === null ? null : record(data.state, "saved goal state");
    return [{ id: stringField(entry, "id"), event: stringField(data, "event"), state }];
  });
}

function savedGoalEvent(entries: SavedGoalEntry[], event: string, label: string): SavedGoalEntry {
  let entry: SavedGoalEntry | undefined;
  for (const candidate of entries) {
    if (candidate.event === event) entry = candidate;
  }
  assert.ok(entry, `${label}: expected a saved goal event ${event}`);
  return entry;
}

function lastSavedGoal(entries: SavedGoalEntry[], label: string): SavedGoalEntry {
  const entry = entries.at(-1);
  assert.ok(entry, `${label}: expected a saved KillerOS goal entry`);
  return entry;
}

function goalToolResults(entries: RecordValue[]): RecordValue[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = record(entry.message, "session message entry");
    return message.role === "toolResult" && message.toolName === "killeros_goal_update" ? [message] : [];
  });
}

function assertCompletedGoalResult(entries: RecordValue[], verification: "file" | "model-reported", label: string): void {
  const result = goalToolResults(entries).at(-1);
  assert.ok(result, `${label}: the completion must return a native tool result`);
  assert.equal(result.isError, false, `${label}: the completion tool must succeed`);
  const details = record(result.details, `${label}: completion details`);
  assert.equal(details.status, "complete");
  assert.equal(details.verification, verification);
}

function toolResultText(message: RecordValue): string {
  const content = records(message.content, "tool result content");
  return content.map((part) => stringField(part, "text")).join("\n");
}

/** Decides whether the provider request body carried the exact text (JSON escaping is compared in both forms). */
function providerBodyIncludes(body: RecordValue, text: string): boolean {
  const raw = JSON.stringify(body);
  return raw.includes(text) || raw.includes(JSON.stringify(text).slice(1, -1));
}

function acknowledgeGoalBatch(fixture: GoalFixture, label: string): void {
  const through = fixture.rpc.currentSequence;
  const first = fixture.rpc.firstSequence;
  const count = fixture.rpc.retainedRecordCount;
  assert.equal(first, fixture.acknowledgedSequence + 1, `${label}: retained RPC evidence must be contiguous`);
  assert.equal(count, through - fixture.acknowledgedSequence, `${label}: acknowledge the complete retained RPC batch`);
  fixture.rpc.acknowledge(through);
  assert.equal(fixture.rpc.retainedRecordCount, 0, `${label}: the acknowledged RPC batch must be released`);
  fixture.batches.push({ label, first, through, records: count });
  fixture.acknowledgedSequence = through;
}

function assertGoalIdle(state: RecordValue, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: Pi must not still be streaming`);
  assert.equal(state.isCompacting, false, `${label}: Pi must not still be compacting`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no follow-up may remain queued`);
}

async function waitForGoalSettled(fixture: GoalFixture, after: number, label: string): Promise<void> {
  await fixture.rpc.waitFor((entry) => entry.type === "agent_settled", {
    after,
    timeoutMs: 45_000,
    signal: fixture.signal,
  });
  assertGoalIdle(await goalState(fixture), label);
}

/** Waits for exactly `count` agent_settled records after the cursor and returns the final settlement's sequence. */
async function waitForGoalSettlements(fixture: GoalFixture, after: number, count: number, label: string): Promise<number> {
  let cursor = after;
  for (let settled = 0; settled < count; settled += 1) {
    const stored = await fixture.rpc.waitForRecord((entry) => entry.type === "agent_settled", {
      after: cursor,
      timeoutMs: 45_000,
      signal: fixture.signal,
    });
    assert.ok(stored.sequence > cursor, `${label}: each settlement advances the observation cursor`);
    cursor = stored.sequence;
  }
  return cursor;
}

async function waitForGoalNotification(
  fixture: GoalFixture,
  after: number,
  expectedMessage: string | ((message: string) => boolean),
  expectedType: string,
  label: string,
): Promise<RecordValue> {
  const notification = await fixture.rpc.waitFor(
    (entry) => entry.type === "extension_ui_request"
      && entry.method === "notify"
      && typeof entry.message === "string"
      && (typeof expectedMessage === "string" ? entry.message === expectedMessage : expectedMessage(entry.message)),
    { after, timeoutMs: 20_000, signal: fixture.signal },
  );
  assert.equal(notification.notifyType, expectedType, `${label}: notification type`);
  return notification;
}

async function submitGoalPrompt(fixture: GoalFixture, text: string, label: string, timeoutMs = 30_000): Promise<RecordValue> {
  const response = await goalRpcCommand(fixture, "prompt", { message: text }, timeoutMs);
  return record(response.data, `${label} prompt response`);
}

/** Submits an ordinary user message that starts a real agent run. */
async function submitOrdinaryPrompt(fixture: GoalFixture, text: string, label: string): Promise<RecordValue> {
  const data = await submitGoalPrompt(fixture, text, label);
  assert.equal(data.disposition, "started", `${label}: the ordinary message must start a run`);
  return data;
}

/** Resets to a verified fresh saved session so sequential vectors cannot share goal state. */
async function assertFreshGoalSession(fixture: GoalFixture, label: string): Promise<void> {
  const beforeRequests = fixture.provider.requestCount;
  const previousFile = fixture.currentSessionFile;
  const previousId = fixture.currentSessionId;
  const cursor = fixture.rpc.currentSequence;
  const response = await goalRpcCommand(fixture, "new_session");
  const data = record(response.data, `${label} new_session response`);
  assert.equal(data.cancelled, false, `${label}: native new_session must commit`);
  const state = await goalState(fixture);
  const sessionFile = stringField(state, "sessionFile");
  const sessionId = stringField(state, "sessionId");
  assert.notEqual(sessionFile, previousFile, `${label}: new_session must select a new saved session file`);
  assert.notEqual(sessionId, previousId, `${label}: new_session must select a new session identity`);
  assertGoalIdle(state, label);
  assert.equal(savedGoalEntries(await goalEntriesOf(fixture)).length, 0, `${label}: the new session must not inherit a goal`);
  assert.equal(fixture.provider.requestCount, beforeRequests, `${label}: reset must not make a provider request`);
  fixture.currentSessionFile = sessionFile;
  fixture.currentSessionId = sessionId;
  assert.ok(fixture.rpc.currentSequence > cursor, `${label}: the reset must have a public RPC response`);
  acknowledgeGoalBatch(fixture, `reset:${label}`);
}

async function closeGoalFixture(fixture: GoalFixture, label: string): Promise<unknown[]> {
  const errors: unknown[] = [];
  fixture.provider.releaseAll();
  try {
    const closed = await fixture.rpc.close();
    if (closed.forced) errors.push(new Error(`${label}: Pi CLI required forced cleanup: ${JSON.stringify(closed)}`));
    if (closed.exit.code !== 0 || closed.exit.signal !== null) {
      errors.push(new Error(`${label}: Pi CLI exited unexpectedly: ${fixture.rpc.diagnostics()}`));
    }
    if (closed.treeCleanupError !== undefined) errors.push(new Error(`${label}: Pi CLI tree cleanup was uncertain: ${closed.treeCleanupError}`));
    acknowledgeGoalBatch(fixture, `${label}: natural-shutdown`);
  } catch (error) {
    errors.push(error);
  }
  try {
    for (const request of fixture.provider.requests) {
      await request.completion;
    }
    await fixture.provider.close();
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

async function removeGoalDirectory(directory: string, label: string, errors: unknown[]): Promise<void> {
  try {
    await removeDirectoryEventually(directory);
    assert.equal(existsSync(directory), false, `${label}: remove the owned fixture directory`);
  } catch (error) {
    errors.push(error);
  }
}

/** Reads a JSON acknowledgement file the child writes, failing fast on the child's recorded failure file. */
async function waitForPlanJson(
  acknowledgementPath: string,
  failurePath: string | undefined,
  timeoutMs: number,
  label: string,
): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (failurePath !== undefined && existsSync(failurePath)) {
      const failure = record(parseJson(readFileSync(failurePath, "utf8")));
      throw new Error(`${label}: child-side barrier failed during ${stringField(failure, "operation")}: ${stringField(failure, "message")}`);
    }
    if (existsSync(acknowledgementPath)) return record(parseJson(readFileSync(acknowledgementPath, "utf8")));
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** Reads the newline-delimited JSON observer file the fixture probe extension appends to. */
function readProbeEvents(observerPath: string): RecordValue[] {
  if (!existsSync(observerPath)) return [];
  return readFileSync(observerPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => record(parseJson(line), `observer[${index}]`));
}

function probeEventCount(events: RecordValue[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

async function waitForProbeEvent(
  observerPath: string,
  predicate: (event: RecordValue) => boolean,
  timeoutMs: number,
  label: string,
): Promise<RecordValue> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const event = readProbeEvents(observerPath).find(predicate);
    if (event) return event;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the probe event ${label}; observed: ${JSON.stringify(readProbeEvents(observerPath).slice(0, 40))}`);
    }
    await sleep(10);
  }
}

/**
 * Child-scoped Node filesystem adapter for completion verification races.
 * Armed through NODE_OPTIONS --require inside the Pi child; the holdCall-th
 * open of the owned target path is acknowledged to the parent and held until
 * the parent releases it, then restored so later opens forward unchanged.
 */
function raceAdapterSource(): string {
  return String.raw`
"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { syncBuiltinESMExports } = require("node:module");
const path = require("node:path");
const planPath = process.env.KILLEROS_GOAL_VERIFICATION_PLAN;
if (!planPath) throw new Error("KILLEROS_GOAL_VERIFICATION_PLAN is not set");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
function requiredPath(name) {
  if (typeof plan[name] !== "string") throw new Error("Invalid goal verification plan path: " + name);
  return path.resolve(plan[name]);
}
const target = requiredPath("target");
const holdCall = plan.holdCall;
if (!Number.isSafeInteger(holdCall) || holdCall < 1) throw new Error("Invalid goal verification holdCall");
const statusPath = requiredPath("status");
const acknowledgementPath = requiredPath("acknowledgement");
const releasePath = requiredPath("release");
const failurePath = requiredPath("failure");
const waitTimeoutMs = Number.isSafeInteger(plan.waitTimeoutMs) ? plan.waitTimeoutMs : 30_000;
const originalOpen = fsp.open;
const status = {
  target,
  holdCall,
  intercepts: 0,
  forwarded: 0,
  unrelatedForwarded: 0,
  restored: false,
  targetOperationCompleted: false,
  events: [],
};
function writeJsonAtomic(filePath, value) {
  const temporary = filePath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, filePath);
}
function recordEvent(event, extra = {}) {
  status.events.push({ event, ...extra });
  if (status.events.length > 16) status.events.shift();
}
function recordFailure(operation, error) {
  const failure = {
    operation,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack || "").slice(0, 4_000) : null,
    recordedAt: new Date().toISOString(),
  };
  try {
    writeJsonAtomic(failurePath, failure);
  } catch (reportError) {
    process.stderr.write(JSON.stringify({ adapterFailure: failure, failureReportError: String(reportError) }) + "\n");
  }
}
function waitForRelease() {
  const deadline = Date.now() + waitTimeoutMs;
  return new Promise((resolve, reject) => {
    function check() {
      if (fs.existsSync(releasePath)) resolve(fs.readFileSync(releasePath, "utf8"));
      else if (Date.now() >= deadline) reject(new Error("Goal verification barrier timed out after " + waitTimeoutMs + "ms"));
      else setTimeout(check, 10);
    }
    check();
  });
}
function restoreAdapter() {
  if (status.restored) return;
  fsp.open = originalOpen;
  syncBuiltinESMExports();
  status.restored = true;
  recordEvent("adapter-restored");
}
fsp.open = async function openWithVerificationBarrier(...args) {
  const filePath = args[0];
  const isTarget = typeof filePath === "string" && path.resolve(filePath).toLowerCase() === target.toLowerCase();
  if (!isTarget) {
    status.unrelatedForwarded += 1;
    return originalOpen.apply(fsp, args);
  }
  status.forwarded += 1;
  if (status.forwarded !== holdCall || status.intercepts > 0) {
    return originalOpen.apply(fsp, args);
  }
  status.intercepts += 1;
  let operation = "inspect verification target";
  try {
    const inspected = fs.lstatSync(target);
    const acknowledgement = {
      size: inspected.size,
      inode: inspected.ino,
      exactInode: fs.lstatSync(target, { bigint: true }).ino.toString(),
      device: inspected.dev,
      mtimeMs: inspected.mtimeMs,
      contentHash: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
      acknowledgedAt: new Date().toISOString(),
    };
    operation = "publish verification barrier acknowledgement";
    writeJsonAtomic(acknowledgementPath, acknowledgement);
    recordEvent("verification-open-paused", { call: status.forwarded });
    operation = "wait for parent verification release";
    await waitForRelease();
    recordEvent("verification-open-release-observed");
    restoreAdapter();
    operation = "forward verification target open";
    const handle = await originalOpen.apply(fsp, args);
    status.targetOperationCompleted = true;
    recordEvent("verification-open-completed");
    writeJsonAtomic(statusPath, status);
    return handle;
  } catch (error) {
    recordFailure(operation, error);
    restoreAdapter();
    throw error;
  }
};
syncBuiltinESMExports();
recordEvent("adapter-armed");
writeJsonAtomic(statusPath, status);
`;
}

/**
 * Fixture extension observing the real goal tool run through Pi's public
 * extension API. It records lifecycle events, acknowledges when the active
 * run's abort signal has fired, and attempts public tree navigation through a
 * real extension command. It never imports KillerOS or replaces a Pi method.
 */
function raceProbeSource(): string {
  return String.raw`
import { appendFileSync, writeFileSync } from "node:fs";

const observerPath = process.env.KILLEROS_GOAL_RACE_OBSERVER;
if (!observerPath) throw new Error("KILLEROS_GOAL_RACE_OBSERVER is not set");
const abortAcknowledgementPath = process.env.KILLEROS_GOAL_RACE_ABORT_ACK ?? "";
let sequence = 0;
function record(type, details = {}) {
  appendFileSync(observerPath, JSON.stringify({ sequence: ++sequence, type, ...details }) + "\n", "utf8");
}

export default function goalRaceProbe(pi) {
  pi.on("session_start", (_event, ctx) => record("session_start", { mode: ctx.mode }));
  pi.on("session_before_tree", (event) => record("session_before_tree", { targetId: event.preparation.targetId }));
  pi.on("session_tree", (event) => record("session_tree", { newLeafId: event.newLeafId, oldLeafId: event.oldLeafId }));
  const pendingPollers = new Map();
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "killeros_goal_update") return;
    const signal = ctx.signal;
    record("goal_tool_start", {
      signalPresent: signal !== undefined,
      signalAborted: signal?.aborted ?? null,
    });
    if (!signal || !abortAcknowledgementPath) return;
    const deadline = Date.now() + 120_000;
    const poll = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(poll);
        pendingPollers.delete(event.toolCallId);
        record("goal_signal_abort_poll_timeout", {});
        return;
      }
      if (!signal.aborted) return;
      clearInterval(poll);
      pendingPollers.delete(event.toolCallId);
      record("goal_signal_aborted", {});
      try {
        writeFileSync(abortAcknowledgementPath, JSON.stringify({ observedAt: new Date().toISOString() }));
      } catch (error) {
        record("goal_signal_abort_ack_failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }, 5);
    pendingPollers.set(event.toolCallId, poll);
  });
  pi.on("tool_execution_end", (event) => {
    const poll = pendingPollers.get(event.toolCallId);
    if (poll === undefined) return;
    clearInterval(poll);
    pendingPollers.delete(event.toolCallId);
  });
  pi.registerCommand("fixture-goal-tree", {
    description: "Attempt public Pi tree navigation through the real extension command context",
    handler: async (argument, ctx) => {
      const [action, targetId] = argument.split(" ");
      if (action !== "navigate" || !targetId) throw new Error("Unknown fixture-goal-tree request");
      try {
        const result = await ctx.navigateTree(targetId, { summarize: false });
        record("navigation_result", { outcome: result.cancelled ? "cancelled" : "committed", targetId });
      } catch (error) {
        record("navigation_result", {
          outcome: "rejected",
          message: error instanceof Error ? error.message : String(error),
          targetId,
        });
      }
    },
  });
}
`;
}

/** Parent-owned release file for a child-held filesystem barrier; releases at most once. */
class FileBarrier {
  private readonly releasePath: string;
  private released = false;

  constructor(releasePath: string) {
    this.releasePath = releasePath;
  }

  release(errors: unknown[]): void {
    if (this.released) return;
    this.released = true;
    try {
      writeFileSync(this.releasePath, "release\n");
    } catch (error) {
      errors.push(error);
    }
  }
}

type RaceVectorRun = (fixture: GoalFixture, vectorErrors: unknown[], directory: string) => Promise<RecordValue>;

/** Creates one race fixture, runs the vector, and closes the process even when the vector fails. */
async function runGoalRaceVector(
  artifactDirectory: string,
  label: string,
  signal: AbortSignal,
  buildOptions: (directory: string) => GoalFixtureOptions,
  run: RaceVectorRun,
): Promise<RecordValue> {
  const directory = path.join(artifactDirectory, label);
  const fixture = await createGoalFixture(artifactDirectory, label, signal, buildOptions(directory));
  let runError: { error: unknown } | undefined;
  let observation: RecordValue = {};
  const vectorErrors: unknown[] = [];
  try {
    observation = await run(fixture, vectorErrors, directory);
  } catch (error) {
    runError = { error };
  }
  vectorErrors.push(...await closeGoalFixture(fixture, label));
  await removeGoalDirectory(fixture.directory, label, vectorErrors);
  const combined = [...(runError === undefined ? [] : [runError.error]), ...vectorErrors];
  if (combined.length > 0) {
    const summary = combined.map((error) => errorText(error).slice(0, 2_000)).join("\n---\n").slice(0, 8_000);
    throw new AggregateError(combined, `${label} failed or did not clean up naturally\n${summary}\n${fixture.rpc.diagnostics().slice(0, 8_000)}`);
  }
  return observation;
}

type RaceAdapterPlan = NonNullable<GoalFixtureOptions["adapterPlan"]>;

function buildAdapterPlan(directory: string, target: string, holdCall: number): RaceAdapterPlan {
  return {
    target,
    holdCall,
    acknowledgementPath: path.join(directory, "verification-acknowledgement.json"),
    releasePath: path.join(directory, "verification-release"),
    statusPath: path.join(directory, "verification-adapter-status.json"),
    failurePath: path.join(directory, "verification-adapter-failure.json"),
    waitTimeoutMs: 30_000,
  };
}

/** Drives one saved blocked goal through its three blocker-decision turns at the real boundary. */
async function blockGoalThroughDecisions(
  fixture: GoalFixture,
  signal: AbortSignal,
  target: string,
  label: string,
): Promise<RecordValue> {
  for (const turn of [1, 2, 3]) {
    fixture.provider.queueGoalDecision({
      status: "blocked",
      blockerKey: "external",
      evidence: `Missing prerequisite ${turn}`,
    });
  }
  const startCursor = fixture.rpc.currentSequence;
  await submitGoalPrompt(fixture, `/goal Fix \`${target}\``, `${label}: start`);
  await waitForGoalNotification(fixture, startCursor, goalStartNotice, "info", `${label}: start notice`);
  for (const request of [1, 2, 3, 4, 5, 6]) {
    await fixture.provider.waitForRequest(request, signal);
  }
  await waitForGoalSettlements(fixture, startCursor, 3, `${label}: three blocker turns`);
  const entries = savedGoalEntries(await goalEntriesOf(fixture));
  assert.deepEqual(entries.map((entry) => entry.event), ["set", "turn", "blocker-audit", "turn", "blocker-audit", "turn", "blocked"],
    `${label}: three accepted blocker decisions must block the goal`);
  const blocked = lastSavedGoal(entries, `${label}: blocked state`).state;
  assert.ok(blocked, `${label}: the blocked state must be persisted`);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.turns, 3);
  const audit = record(blocked.blockerAudit, `${label}: blocker audit`);
  assert.equal(audit.streak, 3);
  assert.equal(audit.key, "external");
  acknowledgeGoalBatch(fixture, `${label}: blocked setup`);
  return { objective: blocked.objective, turns: blocked.turns };
}

// Catalog ID: goals.completion-races.
test("completion loses ownership when cancelled or restored mid-verification", { timeout: 480_000 }, async (t: ScenarioContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const artifactDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-completion-races-"));
  const observations: RecordValue[] = [];
  const errors: unknown[] = [];
  try {
    // Vector: an active goal completion cancelled before the model decision reached verification.
    observations.push(await runGoalRaceVector(artifactDirectory, "active-cancel-before", t.signal, () => ({}), async (fixture) => {
      const target = path.join(fixture.project, "target.md");
      writeFileSync(target, "stale deliverable");
      await initializeGoalFixture(fixture, "active-cancel-before");

      const barrier = fixture.provider.holdNextRequest();
      let abortOutcome: PromiseOutcome<RecordValue> | undefined;
      const startCursor = fixture.rpc.currentSequence;
      try {
        await submitGoalPrompt(fixture, `/goal Write the Markdown file to \`${target}\``, "active-cancel-before: start");
        await waitForGoalNotification(fixture, startCursor, goalStartNotice, "info", "active-cancel-before: start notice");
        const firstRequest = await fixture.provider.waitForRequest(1, t.signal);
        assert.equal(firstRequest.body.model, goalFixtureModel, "the loopback model must receive the goal turn");
        assert.ok(providerBodyIncludes(firstRequest.body, target), "the goal turn must carry the objective");

        abortOutcome = await outcome(goalRpcCommand(fixture, "abort", {}, 60_000));
        assert.equal(await firstRequest.completion, "closed", "the abort must cancel the held provider request");
      } finally {
        barrier.release();
      }
      if (abortOutcome.kind === "rejected") throw abortOutcome.error;
      assert.equal(abortOutcome.value.success, true, "the abort command must succeed");
      await waitForGoalSettlements(fixture, startCursor, 1, "active-cancel-before: aborted settlement");
      assertGoalIdle(await goalState(fixture), "active-cancel-before: after abort");

      const abortedEntries = savedGoalEntries(await goalEntriesOf(fixture));
      assert.deepEqual(abortedEntries.map((entry) => entry.event), ["set", "turn", "error"],
        "an aborted goal turn must append no completion and settle through the error pause");
      const paused = lastSavedGoal(abortedEntries, "active-cancel-before: paused state").state;
      assert.ok(paused, "the paused goal state must be persisted");
      assert.equal(paused.status, "paused", "the aborted turn pauses the goal");
      assert.equal(paused.turns, 1, "the aborted turn stays accounted");
      assert.equal(paused.turnDecision, undefined, "no decision may persist from the aborted request");
      assert.equal(paused.resumeAfterManualCompaction, true, "the aborted turn is preserved for recovery");
      const abortedNotice = await fixture.rpc.waitFor(
        (entry) => entry.type === "extension_ui_request" && entry.method === "notify"
          && typeof entry.message === "string" && entry.message.startsWith("Goal paused because the turn was aborted"),
        { after: startCursor, timeoutMs: 10_000, signal: t.signal },
      );
      assert.equal(abortedNotice.notifyType, "warning", "the aborted-turn pause must warn");
      assert.equal(goalToolResults(await goalEntriesOf(fixture)).length, 0,
        "the cancelled completion must not reach the goal tool");
      acknowledgeGoalBatch(fixture, "active-cancel-before: aborted turn");

      // A later authorized completion succeeds.
      fixture.provider.queueGoalDecision({ status: "complete", evidence: "Completed after the cancelled attempt" });
      writeFileSync(target, "changed deliverable after cancellation");
      const resumeCursor = fixture.rpc.currentSequence;
      await submitGoalPrompt(fixture, "/goal resume", "active-cancel-before: resume");
      await waitForGoalNotification(fixture, resumeCursor, "Goal resumed", "info", "active-cancel-before: resume notice");
      const decisionRequest = await fixture.provider.waitForRequest(2, t.signal);
      const followUpRequest = await fixture.provider.waitForRequest(3, t.signal);
      await waitForGoalSettled(fixture, resumeCursor, "active-cancel-before: completed settlement");
      assert.equal(await decisionRequest.completion, "finished");
      assert.equal(await followUpRequest.completion, "finished");
      const completedEntries = savedGoalEntries(await goalEntriesOf(fixture));
      assert.deepEqual(completedEntries.map((entry) => entry.event), ["set", "turn", "error", "resume", "turn", "complete"],
        "the later completion must append exactly one complete event");
      const completed = lastSavedGoal(completedEntries, "active-cancel-before: completed state").state;
      assert.ok(completed, "the completed goal state must be persisted");
      assert.equal(completed.status, "complete");
      assert.equal(completed.turns, 2);
      const lastDecision = record(completed.lastDecision, "completed last decision");
      assert.equal(lastDecision.kind, "complete");
      assert.equal(lastDecision.verification, "file");
      assert.equal(lastDecision.turn, 2);
      const verification = record(completed.verification, "completed verification");
      assert.equal(stringField(verification, "path"), target);
      assert.equal(fixture.provider.requestCount, 3, "the cancelled and later completions issue exactly three requests");
      return { vector: "active-cancel-before", providerRequests: 3 };
    }));

    // Vector: an active goal completion cancelled while its file verification runs.
    observations.push(await runGoalRaceVector(artifactDirectory, "active-cancel-during", t.signal,
      (directory) => ({
        probe: {
          observerPath: path.join(directory, "probe-observer.jsonl"),
          abortAcknowledgementPath: path.join(directory, "abort-acknowledgement.json"),
        },
        adapterPlan: buildAdapterPlan(directory, path.join(directory, "project", "target.md"), 2),
      }),
      async (fixture, vectorErrors, directory) => {
        const target = path.join(fixture.project, "target.md");
        writeFileSync(target, "stale deliverable");
        await initializeGoalFixture(fixture, "active-cancel-during");
        const acknowledgementPath = path.join(directory, "verification-acknowledgement.json");
        const releasePath = path.join(directory, "verification-release");
        const statusPath = path.join(directory, "verification-adapter-status.json");
        const failurePath = path.join(directory, "verification-adapter-failure.json");
        const abortAcknowledgementPath = path.join(directory, "abort-acknowledgement.json");
        const observerPath = path.join(directory, "probe-observer.jsonl");
        const barrier = new FileBarrier(releasePath);
        // Hold the decision response so the deliverable changes after the goal baselined it
        // and the parked verification is a real in-flight change check.
        const decisionBarrier = fixture.provider.holdNextRequest({
          status: "complete",
          evidence: "Verified the changed deliverable",
        });

        try {
          const startCursor = fixture.rpc.currentSequence;
          await submitGoalPrompt(fixture, `/goal Write the Markdown file to \`${target}\``, "active-cancel-during: start");
          await waitForGoalNotification(fixture, startCursor, goalStartNotice, "info", "active-cancel-during: start notice");
          const firstRequest = await fixture.provider.waitForRequest(1, t.signal);
          writeFileSync(target, "changed deliverable during the goal");
          decisionBarrier.release();
          assert.equal(await firstRequest.completion, "finished", "the decision response must finish");
          const acknowledgement = await waitForPlanJson(acknowledgementPath, failurePath, 30_000,
            "active-cancel-during: the verification open acknowledgement");
          assert.equal(numberField(acknowledgement, "size"), Buffer.byteLength("changed deliverable during the goal"));
          assert.equal(stringField(acknowledgement, "contentHash"), sha256("changed deliverable during the goal"));

          // The abort command resolves only after the parked run settles, so it is
          // observed through the probe's signal acknowledgement before the barrier releases.
          const beforeAbortCursor = fixture.rpc.currentSequence;
          const abortOutcome = outcome(goalRpcCommand(fixture, "abort", {}, 90_000));
          await waitForJson(abortAcknowledgementPath, () => true, 30_000,
            "active-cancel-during: the probe acknowledgement that the run signal fired");
          barrier.release(vectorErrors);
          const settled = await abortOutcome;
          if (settled.kind === "rejected") throw settled.error;
          assert.equal(settled.value.success, true, "the abort command must succeed");
          await waitForGoalSettlements(fixture, beforeAbortCursor, 1, "active-cancel-during: aborted settlement");
        } catch (error) {
          barrier.release(vectorErrors);
          throw error;
        }
        assertGoalIdle(await goalState(fixture), "active-cancel-during: after abort");

        const toolResults = goalToolResults(await goalEntriesOf(fixture));
        assert.equal(toolResults.length, 1, "the cancelled verification must produce exactly one goal tool result");
        const failedResult = toolResults[0];
        if (failedResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
        assert.equal(failedResult.isError, true, "the cancelled verification must fail");
        assert.equal(toolResultText(failedResult), abortedToolResultText, "the cancellation must surface as an abort error");
        const abortedEntries = savedGoalEntries(await goalEntriesOf(fixture));
        assert.deepEqual(abortedEntries.map((entry) => entry.event), ["set", "turn", "error"],
          "the cancelled verification must append no completion");
        const paused = lastSavedGoal(abortedEntries, "active-cancel-during: paused state").state;
        assert.ok(paused, "the paused goal state must be persisted");
        assert.equal(paused.status, "paused");
        assert.equal(paused.turns, 1);
        assert.equal(paused.turnDecision, undefined);
        acknowledgeGoalBatch(fixture, "active-cancel-during: aborted turn");

        // A later authorized completion succeeds.
        fixture.provider.queueGoalDecision({ status: "complete", evidence: "Verified after the cancelled attempt" });
        writeFileSync(target, "changed deliverable after cancellation");
        const resumeCursor = fixture.rpc.currentSequence;
        await submitGoalPrompt(fixture, "/goal resume", "active-cancel-during: resume");
        await waitForGoalNotification(fixture, resumeCursor, "Goal resumed", "info", "active-cancel-during: resume notice");
        await fixture.provider.waitForRequest(2, t.signal);
        await fixture.provider.waitForRequest(3, t.signal);
        await waitForGoalSettled(fixture, resumeCursor, "active-cancel-during: completed settlement");
        const completedEntries = savedGoalEntries(await goalEntriesOf(fixture));
        assert.deepEqual(completedEntries.map((entry) => entry.event), ["set", "turn", "error", "resume", "turn", "complete"],
          "the later completion must append exactly one complete event");
        const completed = lastSavedGoal(completedEntries, "active-cancel-during: completed state").state;
        assert.ok(completed, "the completed goal state must be persisted");
        assert.equal(completed.status, "complete");
        const completedDecision = record(completed.lastDecision, "active-cancel-during: completed decision");
        assert.equal(completedDecision.verification, "file");
        assert.equal(fixture.provider.requestCount, 3, "the cancelled and later completions issue exactly three requests");

        const adapterStatus = await waitForJson(statusPath, (value) => value.restored === true && value.targetOperationCompleted === true,
          10_000, "active-cancel-during: filesystem adapter restoration");
        assert.equal(existsSync(failurePath), false, "the filesystem adapter must not report an operation failure");
        assert.equal(numberField(adapterStatus, "intercepts"), 1);
        assert.equal(numberField(adapterStatus, "forwarded"), 2);
        assert.equal(adapterStatus.restored, true);
        const probeEvents = readProbeEvents(observerPath);
        assert.equal(probeEventCount(probeEvents, "goal_signal_aborted"), 1,
          "the probe must observe the run signal fire while the verification was held");
        assert.equal(vectorErrors.length, 0, "the verification barrier must release cleanly");
        return { vector: "active-cancel-during", providerRequests: 3 };
      }));

    // Vector: a committed tree navigation attempt during file verification is refused by Pi,
    // the owned completion stays valid, and a later committed navigation restores the other goal.
    const restoredObjective = "Goal restored from another branch";
    const restoredGoalTimestamp = Date.now();
    observations.push(await runGoalRaceVector(artifactDirectory, "restore-race", t.signal,
      (directory) => ({
        seedSession: (session: SessionManager) => {
          session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "The seeded branch keeps an earlier paused goal." }],
            api: "openai-completions",
            provider: goalFixtureProvider,
            model: goalFixtureModel,
            stopReason: "stop",
            timestamp: restoredGoalTimestamp,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          });
          session.appendCustomEntry("killeros-goal", {
            version: 1,
            event: "set",
            state: {
              version: 1,
              revision: 1,
              objective: restoredObjective,
              status: "paused",
              createdAt: restoredGoalTimestamp,
              updatedAt: restoredGoalTimestamp,
              activeMilliseconds: 0,
              turns: 0,
              blockedAuditStartTurn: 0,
              baselineTokens: 0,
              maxTurns: 20,
            },
          });
        },
        probe: { observerPath: path.join(directory, "probe-observer.jsonl") },
        adapterPlan: buildAdapterPlan(directory, path.join(directory, "project", "target.md"), 2),
      }),
      async (fixture, vectorErrors, directory) => {
        const target = path.join(fixture.project, "target.md");
        writeFileSync(target, "stale deliverable");
        await initializeGoalFixture(fixture, "restore-race", false);
        const seededEntries = savedGoalEntries(await goalEntriesOf(fixture));
        assert.equal(seededEntries.length, 1, "the seeded session restores exactly one goal entry");
        const restoredEntry = seededEntries[0];
        if (restoredEntry === undefined) throw new Error("Unreachable: the seeded goal entry was asserted present");
        assert.equal(restoredEntry.event, "set");
        assert.equal(restoredEntry.state?.objective, restoredObjective,
          "the seeded paused goal must restore at startup without a provider request");
        assert.equal(restoredEntry.state?.status, "paused");
        const restoredEntryId = restoredEntry.id;

        const acknowledgementPath = path.join(directory, "verification-acknowledgement.json");
        const releasePath = path.join(directory, "verification-release");
        const failurePath = path.join(directory, "verification-adapter-failure.json");
        const observerPath = path.join(directory, "probe-observer.jsonl");
        const barrier = new FileBarrier(releasePath);
        // Hold the decision response so the deliverable changes after the replace baselined it.
        const decisionBarrier = fixture.provider.holdNextRequest({
          status: "complete",
          evidence: "Verified the deliverable before navigation",
        });

        try {
          const replaceCursor = fixture.rpc.currentSequence;
          const replaceOutcome = outcome(fixture.rpc.command(
            "prompt",
            { message: `/goal Write the Markdown file to \`${target}\`` },
            { timeoutMs: 30_000, signal: t.signal },
          ));
          const confirmation = await fixture.rpc.waitFor(
            (entry) => entry.type === "extension_ui_request" && entry.method === "confirm",
            { after: replaceCursor, timeoutMs: 20_000, signal: t.signal },
          );
          assert.equal(confirmation.title, "Replace active goal", "the paused seeded goal must require replacement confirmation");
          await fixture.rpc.send({ type: "extension_ui_response", id: stringField(confirmation, "id"), confirmed: true });
          const replaceResponse = await replaceOutcome;
          if (replaceResponse.kind === "rejected") throw replaceResponse.error;
          assert.equal(record(replaceResponse.value.data, "replace prompt response").disposition, "handled");
          await waitForGoalNotification(fixture, replaceCursor, goalReplaceNotice, "info", "restore-race: replace notice");
          const firstRequest = await fixture.provider.waitForRequest(1, t.signal);
          writeFileSync(target, "changed deliverable during the goal");
          decisionBarrier.release();
          assert.equal(await firstRequest.completion, "finished", "the decision response must finish");
          await waitForPlanJson(acknowledgementPath, failurePath, 30_000,
            "restore-race: the verification open acknowledgement");

          const entriesBeforeNavigation = savedGoalEntries(await goalEntriesOf(fixture));
          assert.deepEqual(entriesBeforeNavigation.map((entry) => entry.event), ["set", "replace", "turn"],
            "the replaced goal must have its verification turn in flight");

          // Real navigation attempt through the public extension command path while the
          // verification is parked: Pi refuses navigation while the response streams.
          await submitGoalPrompt(fixture, `/fixture-goal-tree navigate ${restoredEntryId}`, "restore-race: navigation attempt");
          const rejection = await waitForProbeEvent(observerPath,
            (event) => event.type === "navigation_result" && event.outcome === "rejected",
            30_000, "restore-race: the refused mid-run navigation attempt");
          assert.equal(rejection.message, "Wait for the current response to finish before navigating the session tree.",
            "Pi must refuse committed navigation while the run streams");
          assert.equal(stringField(rejection, "targetId"), restoredEntryId);
          const eventsDuringAttempt = readProbeEvents(observerPath);
          assert.equal(probeEventCount(eventsDuringAttempt, "session_before_tree"), 0,
            "the refused navigation must not reach the cancellable tree hook");
          assert.equal(probeEventCount(eventsDuringAttempt, "session_tree"), 0,
            "the refused navigation must not commit a tree move");
          assert.deepEqual(savedGoalEntries(await goalEntriesOf(fixture)), entriesBeforeNavigation,
            "the refused navigation must not change the saved goal history");

          const beforeReleaseCursor = fixture.rpc.currentSequence;
          barrier.release(vectorErrors);
          await waitForGoalSettled(fixture, beforeReleaseCursor, "restore-race: owned completion settlement");
        } catch (error) {
          barrier.release(vectorErrors);
          throw error;
        }
        const completedEntries = savedGoalEntries(await goalEntriesOf(fixture));
        assert.deepEqual(completedEntries.map((entry) => entry.event), ["set", "replace", "turn", "complete"],
          "the owned completion must complete exactly once after the refused navigation");
        const completed = lastSavedGoal(completedEntries, "restore-race: completed state").state;
        assert.ok(completed, "the completed goal state must be persisted");
        assert.equal(completed.status, "complete");
        const completedDecision = record(completed.lastDecision, "restore-race: completed decision");
        assert.equal(completedDecision.verification, "file");
        assert.equal(fixture.provider.requestCount, 2, "the owned completion issues only its decision and follow-up requests");
        acknowledgeGoalBatch(fixture, "restore-race: owned completion");

        // After settlement a real committed navigation fires session_tree and restores the other goal.
        const navigationCursor = fixture.rpc.currentSequence;
        await submitGoalPrompt(fixture, `/fixture-goal-tree navigate ${restoredEntryId}`, "restore-race: committed navigation");
        const commit = await waitForProbeEvent(observerPath,
          (event) => event.type === "navigation_result" && event.outcome === "committed",
          30_000, "restore-race: the committed after-settlement navigation");
        assert.equal(stringField(commit, "targetId"), restoredEntryId);
        const eventsAfterCommit = readProbeEvents(observerPath);
        assert.equal(probeEventCount(eventsAfterCommit, "session_before_tree"), 1,
          "the committed navigation passes the cancellable tree hook");
        assert.equal(probeEventCount(eventsAfterCommit, "session_tree"), 1,
          "the committed navigation fires exactly one session_tree");
        await submitGoalPrompt(fixture, "/goal", "restore-race: restored status check");
        await waitForGoalNotification(fixture, navigationCursor,
          (message) => message.includes(restoredObjective) && message.startsWith("Goal paused"),
          "info", "restore-race: the restored goal status");
        assert.equal(vectorErrors.length, 0, "the verification barrier must release cleanly");
        return { vector: "restore-race", providerRequests: 2 };
      }));

    // Vector: a blocked goal completion cancelled before verification preserves the blocked state.
    observations.push(await runGoalRaceVector(artifactDirectory, "blocked-cancel-before", t.signal, () => ({}),
      async (fixture) => {
        const target = path.join(fixture.project, "target.md");
        writeFileSync(target, "Original blocked deliverable");
        await initializeGoalFixture(fixture, "blocked-cancel-before");
        await blockGoalThroughDecisions(fixture, t.signal, target, "blocked-cancel-before");
        const blockedEntries = savedGoalEntries(await goalEntriesOf(fixture));
        const blockedToolResultCount = goalToolResults(await goalEntriesOf(fixture)).length;
        assert.equal(blockedToolResultCount, 3, "the three blocker decisions must reach the goal tool");

        const barrier = fixture.provider.holdNextRequest();
        let abortOutcome: PromiseOutcome<RecordValue> | undefined;
        const eligibleCursor = fixture.rpc.currentSequence;
        try {
          await submitOrdinaryPrompt(fixture, "Please finish the blocked goal now.",
            "blocked-cancel-before: eligible request");
          const eligibleRequest = await fixture.provider.waitForRequest(7, t.signal);
          assert.ok(providerBodyIncludes(eligibleRequest.body, "Status: blocked"),
            "the eligible request must carry the blocked goal prompt");

          abortOutcome = await outcome(goalRpcCommand(fixture, "abort", {}, 60_000));
          assert.equal(await eligibleRequest.completion, "closed", "the abort must cancel the held eligible request");
        } finally {
          barrier.release();
        }
        if (abortOutcome.kind === "rejected") throw abortOutcome.error;
        assert.equal(abortOutcome.value.success, true, "the abort command must succeed");
        await waitForGoalSettlements(fixture, eligibleCursor, 1, "blocked-cancel-before: settlements including the aborted request");
        assertGoalIdle(await goalState(fixture), "blocked-cancel-before: after abort");
        assert.deepEqual(savedGoalEntries(await goalEntriesOf(fixture)), blockedEntries,
          "the cancelled blocked completion must append nothing and preserve the blocked state");
        assert.equal(goalToolResults(await goalEntriesOf(fixture)).length, blockedToolResultCount,
          "the cancelled blocked completion must not reach the goal tool");
        assert.equal(fixture.provider.requestCount, 7, "three blocked turns and one cancelled eligible request");
        return { vector: "blocked-cancel-before", providerRequests: 7 };
      }));

    // Vector: a blocked goal completion cancelled during hashing preserves the blocked state.
    observations.push(await runGoalRaceVector(artifactDirectory, "blocked-cancel-during", t.signal,
      (directory) => ({
        probe: {
          observerPath: path.join(directory, "probe-observer.jsonl"),
          abortAcknowledgementPath: path.join(directory, "abort-acknowledgement.json"),
        },
        adapterPlan: buildAdapterPlan(directory, path.join(directory, "project", "target.md"), 2),
      }),
      async (fixture, vectorErrors, directory) => {
        const target = path.join(fixture.project, "target.md");
        writeFileSync(target, "Original blocked deliverable");
        await initializeGoalFixture(fixture, "blocked-cancel-during");
        await blockGoalThroughDecisions(fixture, t.signal, target, "blocked-cancel-during");
        const blockedEntries = savedGoalEntries(await goalEntriesOf(fixture));

        const acknowledgementPath = path.join(directory, "verification-acknowledgement.json");
        const releasePath = path.join(directory, "verification-release");
        const failurePath = path.join(directory, "verification-adapter-failure.json");
        const abortAcknowledgementPath = path.join(directory, "abort-acknowledgement.json");
        const observerPath = path.join(directory, "probe-observer.jsonl");
        const barrier = new FileBarrier(releasePath);
        const eligibleCursor = fixture.rpc.currentSequence;
        // Hold the completion decision so the deliverable changes before the parked verification.
        const decisionBarrier = fixture.provider.holdNextRequest({
          status: "complete",
          evidence: "Blocked completion attempt",
        });
        try {
          await submitOrdinaryPrompt(fixture, "Please finish the blocked goal now.",
            "blocked-cancel-during: eligible request");
          const eligibleRequest = await fixture.provider.waitForRequest(7, t.signal);
          writeFileSync(target, "Changed blocked deliverable");
          decisionBarrier.release();
          assert.equal(await eligibleRequest.completion, "finished", "the completion decision must finish");
          const acknowledgement = await waitForPlanJson(acknowledgementPath, failurePath, 30_000,
            "blocked-cancel-during: the verification open acknowledgement");
          assert.equal(numberField(acknowledgement, "size"), Buffer.byteLength("Changed blocked deliverable"));

          const abortOutcome = outcome(goalRpcCommand(fixture, "abort", {}, 90_000));
          await waitForJson(abortAcknowledgementPath, () => true, 30_000,
            "blocked-cancel-during: the probe acknowledgement that the run signal fired");
          barrier.release(vectorErrors);
          const settled = await abortOutcome;
          if (settled.kind === "rejected") throw settled.error;
          assert.equal(settled.value.success, true, "the abort command must succeed");
        } catch (error) {
          barrier.release(vectorErrors);
          throw error;
        }
        await waitForGoalSettlements(fixture, eligibleCursor, 1, "blocked-cancel-during: settlements including the aborted request");
        assertGoalIdle(await goalState(fixture), "blocked-cancel-during: after abort");
        const toolResults = goalToolResults(await goalEntriesOf(fixture));
        assert.equal(toolResults.length, 4, "the cancelled blocked completion must add one failed tool result to the three blocker decisions");
        const failedResult = toolResults.at(-1);
        if (failedResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
        assert.equal(failedResult.isError, true);
        assert.equal(toolResultText(failedResult), abortedToolResultText);
        assert.deepEqual(savedGoalEntries(await goalEntriesOf(fixture)), blockedEntries,
          "the cancelled blocked completion must append nothing and preserve the blocked state");
        assert.equal(fixture.provider.requestCount, 7, "three blocked turns and one cancelled eligible request");
        const probeEvents = readProbeEvents(observerPath);
        assert.equal(probeEventCount(probeEvents, "goal_signal_aborted"), 1,
          "the probe must observe the run signal fire while the blocked verification was held");
        assert.equal(vectorErrors.length, 0, "the verification barrier must release cleanly");
        return { vector: "blocked-cancel-during", providerRequests: 7 };
      }));

    // Vector: a blocked goal completion retried after a cancelled attempt completes the same saved goal.
    observations.push(await runGoalRaceVector(artifactDirectory, "blocked-cancel-retry", t.signal,
      (directory) => ({
        probe: {
          observerPath: path.join(directory, "probe-observer.jsonl"),
          abortAcknowledgementPath: path.join(directory, "abort-acknowledgement.json"),
        },
        adapterPlan: buildAdapterPlan(directory, path.join(directory, "project", "target.md"), 2),
      }),
      async (fixture, vectorErrors, directory) => {
        const target = path.join(fixture.project, "target.md");
        writeFileSync(target, "Original blocked deliverable");
        await initializeGoalFixture(fixture, "blocked-cancel-retry");
        await blockGoalThroughDecisions(fixture, t.signal, target, "blocked-cancel-retry");
        const blockedEntries = savedGoalEntries(await goalEntriesOf(fixture));

        const acknowledgementPath = path.join(directory, "verification-acknowledgement.json");
        const releasePath = path.join(directory, "verification-release");
        const failurePath = path.join(directory, "verification-adapter-failure.json");
        const abortAcknowledgementPath = path.join(directory, "abort-acknowledgement.json");
        const barrier = new FileBarrier(releasePath);
        const eligibleCursor = fixture.rpc.currentSequence;
        // Hold the completion decision so the deliverable changes before the parked verification.
        const decisionBarrier = fixture.provider.holdNextRequest({
          status: "complete",
          evidence: "Cancelled blocked attempt",
        });
        try {
          await submitOrdinaryPrompt(fixture, "Please finish the blocked goal now.",
            "blocked-cancel-retry: eligible request");
          const eligibleRequest = await fixture.provider.waitForRequest(7, t.signal);
          writeFileSync(target, "Changed blocked deliverable");
          decisionBarrier.release();
          assert.equal(await eligibleRequest.completion, "finished", "the completion decision must finish");
          await waitForPlanJson(acknowledgementPath, failurePath, 30_000,
            "blocked-cancel-retry: the verification open acknowledgement");

          const abortOutcome = outcome(goalRpcCommand(fixture, "abort", {}, 90_000));
          await waitForJson(abortAcknowledgementPath, () => true, 30_000,
            "blocked-cancel-retry: the probe acknowledgement that the run signal fired");
          barrier.release(vectorErrors);
          const settled = await abortOutcome;
          if (settled.kind === "rejected") throw settled.error;
          assert.equal(settled.value.success, true, "the abort command must succeed");
        } catch (error) {
          barrier.release(vectorErrors);
          throw error;
        }
        await waitForGoalSettlements(fixture, eligibleCursor, 1, "blocked-cancel-retry: settlements including the aborted request");
        assert.deepEqual(savedGoalEntries(await goalEntriesOf(fixture)), blockedEntries,
          "the cancelled blocked completion must preserve the blocked state before the retry");
        acknowledgeGoalBatch(fixture, "blocked-cancel-retry: cancelled attempt");

        // A later eligible ordinary request may complete only the same saved blocked goal.
        fixture.provider.queueGoalDecision({ status: "complete", evidence: "Completed on the retry after cancellation" });
        const retryCursor = fixture.rpc.currentSequence;
        await submitOrdinaryPrompt(fixture, "Please finish the blocked goal now.",
          "blocked-cancel-retry: retry request");
        const retryDecision = await fixture.provider.waitForRequest(8, t.signal);
        const retryFollowUp = await fixture.provider.waitForRequest(9, t.signal);
        await waitForGoalSettled(fixture, retryCursor, "blocked-cancel-retry: completed settlement");
        assert.equal(await retryDecision.completion, "finished");
        assert.equal(await retryFollowUp.completion, "finished");
        const completedEntries = savedGoalEntries(await goalEntriesOf(fixture));
        assert.deepEqual(completedEntries.map((entry) => entry.event),
          ["set", "turn", "blocker-audit", "turn", "blocker-audit", "turn", "blocked", "complete"],
          "the retry must append exactly one complete event to the blocked history");
        const completed = lastSavedGoal(completedEntries, "blocked-cancel-retry: completed state").state;
        assert.ok(completed, "the completed goal state must be persisted");
        assert.equal(completed.status, "complete");
        assert.equal(completed.turns, 3, "the blocked completion grants no new goal turn");
        assert.equal(completed.blockerAudit, undefined, "completion clears the blocker audit");
        const completedDecision = record(completed.lastDecision, "blocked-cancel-retry: completed decision");
        assert.equal(completedDecision.kind, "complete");
        assert.equal(completedDecision.verification, "file");
        assert.equal(completedDecision.turn, 3);
        assert.equal(completed.result, "Completed on the retry after cancellation");
        const verification = record(completed.verification, "blocked-cancel-retry: verification");
        assert.equal(stringField(verification, "path"), target);
        const retryToolResults = goalToolResults(await goalEntriesOf(fixture));
        assert.equal(retryToolResults.length, 5,
          "three blocker decisions, one aborted attempt, and one successful retry must reach the goal tool");
        const retryResult = retryToolResults.at(-1);
        if (retryResult === undefined) throw new Error("Unreachable: the retry tool result was asserted present");
        assert.equal(retryResult.isError, false, "the retry must succeed");
        assert.equal(toolResultText(retryResult), "Goal verified complete at " + target + ": Completed on the retry after cancellation");
        assert.equal(fixture.provider.requestCount, 9, "three blocked turns, one cancelled attempt, and one retry");
        assert.equal(vectorErrors.length, 0, "the verification barrier must release cleanly");
        return { vector: "blocked-cancel-retry", providerRequests: 9 };
      }));
  } catch (error) {
    errors.push(error);
  }
  await removeGoalDirectory(artifactDirectory, "completion-races: root", errors);
  if (errors.length > 0) {
    throw new AggregateError(errors, "goals.completion-races failed");
  }
  assert.equal(observations.length, 6, "the catalog input domain contains exactly six race vectors");
  t.diagnostic(JSON.stringify({
    scenarioId: "goals.completion-races",
    piLaunches: 6,
    providerRequests: observations.reduce((total, observation) => total + numberField(observation, "providerRequests"), 0),
    observations,
    cleanup: "natural",
  }));
});

type GoalDecision = RecordValue;

/** Checks the decision before settlement can pause a goal whose proof was rejected. */
async function inspectFileDecision(fixture: GoalFixture, request: number, barrier: ProviderBarrier, label: string): Promise<void> {
  try {
    await fixture.provider.waitForRequest(request, fixture.signal);
    const entries = await goalEntriesOf(fixture);
    const result = goalToolResults(entries).at(-1);
    assert.ok(result, `${label}: the follow-up must follow a real goal tool result`);
    const saved = savedGoalEntries(entries);
    const state = lastSavedGoal(saved, label).state;
    assert.ok(state);
    assert.equal(state.status, result.isError === true ? "active" : "complete",
      `${label}: rejected file proof must preserve the active goal before settlement`);
    if (result.isError === true) assert.equal(saved.some((entry) => entry.event === "complete"), false);
    else assertCompletedGoalResult(entries, "file", label);
  } finally {
    barrier.release();
  }
}

/** Starts a file goal and lets its first authorized turn settle with the planned decision. */
async function runFileGoalStartTurn(
  fixture: GoalFixture,
  signal: AbortSignal,
  objective: string,
  label: string,
  decision?: GoalDecision,
  mutateDuringTurn?: () => void,
): Promise<SavedGoalEntry[]> {
  const decisionBarrier = decision === undefined ? undefined : fixture.provider.holdNextRequest(decision);
  const followUp = decision === undefined ? undefined : fixture.provider.holdNextRequest();
  const expectedRequest = fixture.provider.requestCount + 1;
  const cursor = fixture.rpc.currentSequence;
  try {
    await submitGoalPrompt(fixture, `/goal ${objective}`, `${label}: start`);
    await waitForGoalNotification(fixture, cursor, goalStartNotice, "info", `${label}: start notice`);
    const turnRequest = await fixture.provider.waitForRequest(expectedRequest, signal);
    assert.ok(providerBodyIncludes(turnRequest.body, objective), `${label}: the goal turn must carry the objective`);
    mutateDuringTurn?.();
  } finally {
    decisionBarrier?.release();
  }
  // A turn without an accepted decision produces no native tool follow-up request.
  if (followUp !== undefined) await inspectFileDecision(fixture, expectedRequest + 1, followUp, label);
  await waitForGoalSettled(fixture, cursor, `${label}: start turn settlement`);
  return savedGoalEntries(await goalEntriesOf(fixture));
}

/** Resumes a paused file goal and lets its next authorized turn settle with the planned decision. */
async function runFileGoalResumeTurn(
  fixture: GoalFixture,
  signal: AbortSignal,
  label: string,
  decision: GoalDecision,
): Promise<SavedGoalEntry[]> {
  fixture.provider.holdNextRequest(decision).release();
  const followUp = fixture.provider.holdNextRequest();
  const expectedRequest = fixture.provider.requestCount + 1;
  const cursor = fixture.rpc.currentSequence;
  await submitGoalPrompt(fixture, "/goal resume", `${label}: resume`);
  await waitForGoalNotification(fixture, cursor, "Goal resumed", "info", `${label}: resume notice`);
  await fixture.provider.waitForRequest(expectedRequest, signal);
  await inspectFileDecision(fixture, expectedRequest + 1, followUp, label);
  await waitForGoalSettled(fixture, cursor, `${label}: resumed turn settlement`);
  return savedGoalEntries(await goalEntriesOf(fixture));
}

// Catalog ID: goals.file-proof.
test("file completion proves the exact deliverable changed", { timeout: 420_000 }, async (t: ScenarioContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const artifactDirectory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-goal-file-proof-"));
  const observations: RecordValue[] = [];
  const errors: unknown[] = [];
  try {
    // Process 1: rejection shapes — missing, directory, symlink, wrong path, unchanged content.
    const rejections = await createGoalFixture(artifactDirectory, "rejection-shapes", t.signal);
    let piLaunches = 1;
    try {
      await initializeGoalFixture(rejections, "rejection-shapes");
      const complete = { status: "complete", evidence: "Verified the deliverable" } as const;

      // Vector: a missing deliverable is rejected as not a regular file, then completes once written.
      const missing = path.join(rejections.project, "missing.md");
      const missingEntries = await runFileGoalStartTurn(rejections, t.signal, `Create the file at \`${missing}\``, "file-proof: missing", complete);
      assert.deepEqual(savedGoalEvent(missingEntries, "set", "file-proof: missing baseline").state?.verification,
        { kind: "file", path: missing, baseline: { exists: false } });
      const missingToolResults = goalToolResults(await goalEntriesOf(rejections));
      assert.equal(missingToolResults.length, 1, "the first attempt reaches the goal tool exactly once");
      const missingResult = missingToolResults.at(-1);
      if (missingResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
      assert.equal(missingResult.isError, true, "completing a missing deliverable must fail");
      assert.equal(toolResultText(missingResult), `Goal deliverable is not a regular file at the required path: ${missing}`);
      assert.ok(!missingEntries.some((entry) => entry.event === "complete"), "the rejected attempt must not complete the goal");
      const missingPaused = lastSavedGoal(missingEntries, "file-proof: missing paused").state;
      assert.ok(missingPaused, "the paused state must persist");
      assert.equal(missingPaused.status, "paused");
      assert.equal(missingPaused.turns, 1);
      await waitForGoalNotification(rejections, rejections.acknowledgedSequence, (message) => message.startsWith("Goal paused: no turn decision"),
        "error", "file-proof: missing rejection notice");
      acknowledgeGoalBatch(rejections, "file-proof: missing rejected");
      writeFileSync(missing, "created deliverable");
      const missingDone = await runFileGoalResumeTurn(rejections, t.signal, "file-proof: missing written", complete);
      const missingComplete = savedGoalEvent(missingDone, "complete", "file-proof: missing complete");
      assert.equal(missingComplete.state?.status, "complete");
      assert.equal(record(missingComplete.state?.lastDecision, "file-proof: missing decision").verification, "file");
      acknowledgeGoalBatch(rejections, "file-proof: missing completed");
      await assertFreshGoalSession(rejections, "file-proof: missing reset");
      observations.push({ vector: "missing-deliverable", requests: 4, outcome: "rejected-then-completed" });

      // Vector: a directory at the required path is not a regular file.
      const directory = path.join(rejections.project, "directory.md");
      const directoryEntries = await runFileGoalStartTurn(rejections, t.signal, `Create the file at \`${directory}\``, "file-proof: directory", complete,
        () => { mkdirSync(directory); });
      const directoryResults = goalToolResults(await goalEntriesOf(rejections));
      assert.equal(directoryResults.length, 1, "the fresh-session directory attempt reaches the goal tool exactly once");
      const directoryResult = directoryResults.at(-1);
      if (directoryResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
      assert.equal(directoryResult.isError, true);
      assert.equal(toolResultText(directoryResult), `Goal deliverable is not a regular file at the required path: ${directory}`);
      assert.ok(!directoryEntries.some((entry) => entry.event === "complete"));
      acknowledgeGoalBatch(rejections, "file-proof: directory rejected");
      await assertFreshGoalSession(rejections, "file-proof: directory reset");
      observations.push({ vector: "directory-deliverable", requests: 2, outcome: "rejected" });

      // Vector: a symlink at the required path is not a regular file.
      const wrong = path.join(rejections.project, "wrong.md");
      writeFileSync(wrong, "wrong destination");
      const linked = path.join(rejections.project, "linked.md");
      {
        const linkedEntries = await runFileGoalStartTurn(rejections, t.signal, `Create the file at \`${linked}\``, "file-proof: symlink", complete,
          () => { symlinkSync(wrong, linked, "file"); });
        const linkedResults = goalToolResults(await goalEntriesOf(rejections));
        assert.equal(linkedResults.length, 1, "the fresh-session symlink attempt reaches the goal tool exactly once");
        const linkedResult = linkedResults.at(-1);
        if (linkedResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
        assert.equal(linkedResult.isError, true, "a symlink deliverable must fail regular-file proof");
        assert.equal(toolResultText(linkedResult), `Goal deliverable is not a regular file at the required path: ${linked}`);
        assert.ok(!linkedEntries.some((entry) => entry.event === "complete"));
      }
      acknowledgeGoalBatch(rejections, "file-proof: symlink settled");
      await assertFreshGoalSession(rejections, "file-proof: symlink reset");
      observations.push({ vector: "symlink-deliverable", requests: 2, outcome: "rejected" });

      // Vector: deliverable content at a different path cannot satisfy the exact required path.
      const wrongPathTarget = path.join(rejections.project, "required.md");
      const wrongPathEntries = await runFileGoalStartTurn(rejections, t.signal, `Create the file at \`${wrongPathTarget}\``, "file-proof: wrong path", complete);
      const wrongPathResults = goalToolResults(await goalEntriesOf(rejections));
      const wrongPathResult = wrongPathResults.at(-1);
      if (wrongPathResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
      assert.equal(wrongPathResult.isError, true);
      const wrongPathText = toolResultText(wrongPathResult);
      assert.equal(wrongPathText, `Goal deliverable is not a regular file at the required path: ${wrongPathTarget}`,
        "the rejection must name the exact required path");
      assert.equal(wrongPathText.includes("wrong.md"), false, "the rejection must not accept the sibling wrong file");
      assert.ok(!wrongPathEntries.some((entry) => entry.event === "complete"));
      assert.equal(existsSync(wrongPathTarget), false, "failed proof must not create the required path");
      assert.equal(readFileSync(wrong, "utf8"), "wrong destination", "failed proof must not write the sibling or symlink target");
      acknowledgeGoalBatch(rejections, "file-proof: wrong path rejected");
      await assertFreshGoalSession(rejections, "file-proof: wrong path reset");
      observations.push({ vector: "wrong-path", requests: 2, outcome: "rejected" });

      // Vector: an unchanged pre-existing deliverable is rejected as not changed.
      const unchanged = path.join(rejections.project, "unchanged.md");
      writeFileSync(unchanged, "stale deliverable");
      const unchangedEntries = await runFileGoalStartTurn(rejections, t.signal, `Write the Markdown file to \`${unchanged}\``, "file-proof: unchanged", complete);
      const unchangedResults = goalToolResults(await goalEntriesOf(rejections));
      const unchangedResult = unchangedResults.at(-1);
      if (unchangedResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
      assert.equal(unchangedResult.isError, true);
      assert.equal(toolResultText(unchangedResult), `Goal deliverable has not changed since the goal started: ${unchanged}`);
      assert.ok(!unchangedEntries.some((entry) => entry.event === "complete"));
      acknowledgeGoalBatch(rejections, "file-proof: unchanged rejected");
      observations.push({ vector: "unchanged-deliverable", requests: 2, outcome: "rejected" });

      await assertFreshGoalSession(rejections, "file-proof: same-goal reset");
      const required = path.join(rejections.project, "same-goal-required.md");
      const sibling = path.join(rejections.project, "same-goal-sibling.md");
      writeFileSync(sibling, "wrong destination");
      const objective = `Write the Markdown file to \`${required}\``;
      const firstDecision = rejections.provider.holdNextRequest(complete);
      const retries = [
        rejections.provider.holdNextRequest(complete),
        rejections.provider.holdNextRequest(complete),
        rejections.provider.holdNextRequest(complete),
      ];
      const finalResponse = rejections.provider.holdNextRequest();
      const firstRequest = rejections.provider.requestCount + 1;
      const cursor = rejections.rpc.currentSequence;
      try {
        await submitGoalPrompt(rejections, `/goal ${objective}`, "file-proof: same-goal start");
        await waitForGoalNotification(rejections, cursor, goalStartNotice, "info", "file-proof: same-goal start notice");
        await rejections.provider.waitForRequest(firstRequest, t.signal);
        const initial = savedGoalEntries(await goalEntriesOf(rejections));
        const initialSet = savedGoalEvent(initial, "set", "file-proof: same-goal baseline");
        assert.deepEqual(initialSet.state?.verification, { kind: "file", path: required, baseline: { exists: false } });
        firstDecision.release();

        for (const [index, barrier] of retries.entries()) {
          const request = await rejections.provider.waitForRequest(firstRequest + index + 1, t.signal);
          const entries = await goalEntriesOf(rejections);
          const results = goalToolResults(entries);
          assert.equal(results.length, index + 1, "each request follows exactly one additional tool attempt");
          const result = results[index];
          assert.ok(result);
          assert.equal(result.isError, true, `file-proof: same-goal rejection ${index + 1}`);
          const rejection = `Goal deliverable is not a regular file at the required path: ${required}`;
          assert.equal(toolResultText(result), rejection);
          assert.ok(providerBodyIncludes(request.body, rejection), "the next native request contains the rejected tool result");
          const saved = savedGoalEntries(entries);
          assert.equal(savedGoalEvent(saved, "set", "file-proof: same-goal set").id, initialSet.id);
          assert.equal(saved.some((entry) => entry.event === "complete"), false);
          const state = lastSavedGoal(saved, "file-proof: same-goal active").state;
          assert.ok(state);
          assert.equal(state.status, "active");
          assert.equal(state.turns, 1);
          assert.deepEqual(state.verification, initialSet.state?.verification);
          assert.equal(readFileSync(sibling, "utf8"), "wrong destination");
          if (index === 0) {
            assert.equal(existsSync(required), false);
            mkdirSync(required);
          } else if (index === 1) {
            assert.equal(lstatSync(required).isDirectory(), true, "the rejected required path is a directory");
            rmSync(required, { recursive: true });
            symlinkSync(sibling, required, "file");
          } else {
            assert.equal(lstatSync(required).isSymbolicLink(), true, "the rejected required path is a real symlink");
            assert.equal(readFileSync(required, "utf8"), "wrong destination");
            rmSync(required);
            writeFileSync(required, "correct destination");
          }
          barrier.release();
        }
        await rejections.provider.waitForRequest(firstRequest + 4, t.signal);
        const entries = await goalEntriesOf(rejections);
        assert.equal(goalToolResults(entries).length, 4);
        assertCompletedGoalResult(entries, "file", "file-proof: same-goal completion");
        const result = goalToolResults(entries).at(-1);
        assert.ok(result);
        assert.equal(toolResultText(result), `Goal verified complete at ${required}: ${complete.evidence}`);
        const saved = savedGoalEntries(entries);
        assert.equal(savedGoalEvent(saved, "set", "file-proof: same-goal completed set").id, initialSet.id);
        const completed = lastSavedGoal(saved, "file-proof: same-goal complete");
        assert.equal(completed.event, "complete");
        assert.equal(completed.state?.status, "complete");
        assert.deepEqual(completed.state?.verification, initialSet.state?.verification);
        assert.equal(readFileSync(required, "utf8"), "correct destination");
        assert.equal(readFileSync(sibling, "utf8"), "wrong destination");
        finalResponse.release();
        await waitForGoalSettled(rejections, cursor, "file-proof: same-goal settlement");
        const settled = lastSavedGoal(savedGoalEntries(await goalEntriesOf(rejections)), "file-proof: same-goal settled");
        assert.equal(settled.event, "complete");
        assert.equal(settled.state?.status, "complete");
        acknowledgeGoalBatch(rejections, "file-proof: same-goal completed");
      } finally {
        firstDecision.release();
        for (const barrier of retries) barrier.release();
        finalResponse.release();
      }
      observations.push({ vector: "same-goal-rejections-and-success", requests: 5, outcome: "rejected-then-completed" });

      assert.equal(rejections.provider.requestCount, 17,
        "the rejection-shapes process issues exactly the planned provider requests");
    } finally {
      errors.push(...await closeGoalFixture(rejections, "file-proof: rejection-shapes"));
      await removeGoalDirectory(rejections.directory, "file-proof: rejection-shapes", errors);
    }

    // Process 2: change proofs — changed, mtime-only, restored timestamp, and the large-file metadata tradeoff.
    const changes = await createGoalFixture(artifactDirectory, "change-proofs", t.signal);
    piLaunches += 1;
    try {
      await initializeGoalFixture(changes, "change-proofs");
      const complete = { status: "complete", evidence: "Verified the changed deliverable" } as const;

      // Vector: a changed pre-existing deliverable completes with file verification.
      const changed = path.join(changes.project, "changed.md");
      writeFileSync(changed, "stale deliverable");
      const beforeReopen = await runFileGoalStartTurn(changes, t.signal, `Write the Markdown file to \`${changed}\``, "file-proof: changed baselined");
      const originalVerification = savedGoalEvent(beforeReopen, "set", "file-proof: original baseline").state?.verification;
      assert.deepEqual(originalVerification, { kind: "file", path: changed, baseline: expectedFileBaseline(changed) });
      acknowledgeGoalBatch(changes, "file-proof: before reopen");
      const closed = await changes.rpc.close();
      assert.equal(closed.forced, false, "the baseline process must exit naturally before restoration");
      assert.deepEqual(closed.exit, { code: 0, signal: null });
      assert.equal(closed.treeCleanupError, undefined);
      changes.rpc = new PiRpcProcess(changes.launchOptions);
      changes.acknowledgedSequence = 0;
      piLaunches += 1;
      assertGoalIdle(await goalState(changes), "file-proof: reopened baseline");
      assert.deepEqual(lastSavedGoal(savedGoalEntries(await goalEntriesOf(changes)), "file-proof: restored baseline").state?.verification,
        originalVerification, "reopening must preserve the exact saved baseline");
      const unchangedRestored = await runFileGoalResumeTurn(changes, t.signal, "file-proof: unchanged after reopen", complete);
      assert.ok(!unchangedRestored.some((entry) => entry.event === "complete"));
      const restoredRejection = goalToolResults(await goalEntriesOf(changes)).at(-1);
      assert.ok(restoredRejection);
      assert.equal(restoredRejection.isError, true);
      assert.equal(toolResultText(restoredRejection), `Goal deliverable has not changed since the goal started: ${changed}`);
      acknowledgeGoalBatch(changes, "file-proof: restored unchanged rejected");
      writeFileSync(changed, "changed deliverable");
      const changedEntries = await runFileGoalResumeTurn(changes, t.signal, "file-proof: changed", complete);
      const changedComplete = savedGoalEvent(changedEntries, "complete", "file-proof: changed complete");
      assert.equal(changedComplete.state?.status, "complete");
      assert.equal(record(changedComplete.state?.lastDecision, "file-proof: changed decision").verification, "file");
      acknowledgeGoalBatch(changes, "file-proof: changed completed");
      await assertFreshGoalSession(changes, "file-proof: changed reset");
      observations.push({ vector: "changed-deliverable", requests: 5, outcome: "reopened-rejected-then-completed" });

      // Vector: a timestamp-only change is rejected because content comparison ignores mtime.
      const baselineTime = new Date("2026-01-01T00:00:00.000Z");
      const laterTime = new Date("2026-01-02T00:00:00.000Z");
      const mtimeOnly = path.join(changes.project, "mtime-only.md");
      writeFileSync(mtimeOnly, "stale deliverable");
      utimesSync(mtimeOnly, baselineTime, baselineTime);
      await runFileGoalStartTurn(changes, t.signal, `Write the Markdown file to \`${mtimeOnly}\``, "file-proof: mtime-only baselined");
      utimesSync(mtimeOnly, laterTime, laterTime);
      const mtimeAttempt = await runFileGoalResumeTurn(changes, t.signal, "file-proof: mtime-only attempt", complete);
      const mtimeResults = goalToolResults(await goalEntriesOf(changes));
      const mtimeResult = mtimeResults.at(-1);
      if (mtimeResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
      assert.equal(mtimeResult.isError, true, "a timestamp-only change must be rejected");
      assert.equal(toolResultText(mtimeResult), `Goal deliverable has not changed since the goal started: ${mtimeOnly}`);
      assert.ok(!mtimeAttempt.some((entry) => entry.event === "complete"));
      acknowledgeGoalBatch(changes, "file-proof: mtime-only rejected");
      await assertFreshGoalSession(changes, "file-proof: mtime-only reset");
      observations.push({ vector: "mtime-only-change", requests: 3, outcome: "rejected" });

      // Vector: changed content with a restored baseline timestamp completes.
      const restored = path.join(changes.project, "restored.md");
      writeFileSync(restored, "stale");
      utimesSync(restored, baselineTime, baselineTime);
      await runFileGoalStartTurn(changes, t.signal, `Write the Markdown file to \`${restored}\``, "file-proof: restored baselined");
      writeFileSync(restored, "fresh");
      utimesSync(restored, baselineTime, baselineTime);
      assert.equal(statSync(restored).size, 5, "content proof must detect a same-size edit with the original timestamp");
      const restoredEntries = await runFileGoalResumeTurn(changes, t.signal, "file-proof: restored attempt", complete);
      const restoredComplete = savedGoalEvent(restoredEntries, "complete", "file-proof: restored complete");
      assert.equal(restoredComplete.state?.status, "complete");
      assert.equal(record(restoredComplete.state?.lastDecision, "file-proof: restored decision").verification, "file");
      acknowledgeGoalBatch(changes, "file-proof: restored completed");
      await assertFreshGoalSession(changes, "file-proof: restored reset");
      observations.push({ vector: "content-change-restored-timestamp", requests: 3, outcome: "completed" });

      // Vector: a file larger than 64 MiB stores size without a content hash and proves through metadata.
      const large = path.join(changes.project, "large.bin");
      writeFileSync(large, "x");
      truncateSync(large, 64 * 1024 * 1024 + 1);
      const largeBaselineMtime = statSync(large).mtimeMs;
      const largeEntries = await runFileGoalStartTurn(changes, t.signal, `Write the Markdown file to \`${large}\``, "file-proof: large", complete);
      const largeSetEntry = savedGoalEvent(largeEntries, "set", "file-proof: large set");
      const largeVerification = record(largeSetEntry.state?.verification, "file-proof: large verification");
      assert.equal(largeVerification.kind, "file");
      assert.equal(stringField(largeVerification, "path"), large);
      const largeBaseline = record(largeVerification.baseline, "file-proof: large baseline");
      assert.equal(largeBaseline.exists, true);
      assert.equal(numberField(largeBaseline, "size"), 64 * 1024 * 1024 + 1);
      assert.equal(largeBaseline.contentHash, undefined, "files over 64 MiB must not store a content hash");
      assert.ok(!largeEntries.some((entry) => entry.event === "complete"), "the unchanged large file must not complete");
      acknowledgeGoalBatch(changes, "file-proof: large unchanged");
      const handle = openSync(large, "r+");
      try {
        writeSync(handle, "changed first byte");
      } finally {
        closeSync(handle);
      }
      assert.equal(statSync(large).size, 64 * 1024 * 1024 + 1, "the large-file change must keep its size");
      const largeDone = await runFileGoalResumeTurn(changes, t.signal, "file-proof: large changed", complete);
      const largeComplete = savedGoalEvent(largeDone, "complete", "file-proof: large complete");
      assert.equal(largeComplete.state?.status, "complete");
      assert.equal(record(largeComplete.state?.lastDecision, "file-proof: large decision").verification, "file");
      const largeKeptVerification = record(largeComplete.state?.verification, "file-proof: large kept verification");
      assert.equal(numberField(record(largeKeptVerification.baseline, "file-proof: large kept baseline"), "size"), 64 * 1024 * 1024 + 1);
      assert.notEqual(statSync(large).mtimeMs, largeBaselineMtime);
      acknowledgeGoalBatch(changes, "file-proof: large completed");
      observations.push({ vector: "large-metadata-proof", requests: 4, outcome: "rejected-then-completed" });

      assert.equal(changes.provider.requestCount, 15, "the change-proofs history issues exactly the planned provider requests");
    } finally {
      errors.push(...await closeGoalFixture(changes, "file-proof: change-proofs"));
      await removeGoalDirectory(changes.directory, "file-proof: change-proofs", errors);
    }

    // Process 3: a restored verification whose content hash is null fails closed.
    const nullHashTarget = path.join(artifactDirectory, "null-hash-restore", "project", "target.md");
    const nullHash = await createGoalFixture(artifactDirectory, "null-hash-restore", t.signal, {
      seedSession: (session) => {
        writeFileSync(nullHashTarget, "Original deliverable");
        const stats = statSync(nullHashTarget);
        session.appendCustomEntry("killeros-goal", {
          version: 1,
          event: "set",
          state: {
            version: 1,
            revision: 1,
            objective: "Write the Markdown file to the restored deliverable",
            status: "paused",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            activeMilliseconds: 0,
            turns: 0,
            blockedAuditStartTurn: 0,
            baselineTokens: 0,
            maxTurns: 20,
            verification: {
              kind: "file",
              path: nullHashTarget,
              baseline: { exists: true, size: stats.size, mtimeMs: stats.mtimeMs, contentHash: null },
            },
          },
        });
      },
    });
    piLaunches += 1;
    try {
      await initializeGoalFixture(nullHash, "file-proof: null-hash", false);
      const seededEntries = savedGoalEntries(await goalEntriesOf(nullHash));
      assert.equal(seededEntries.length, 1, "the seeded null-hash goal must restore");
      assert.equal(seededEntries[0]?.state?.status, "paused");
      const seededVerification = seededEntries[0]?.state?.verification;
      assert.deepEqual(seededVerification, { kind: "file", path: nullHashTarget,
        baseline: { exists: true, size: statSync(nullHashTarget).size, mtimeMs: statSync(nullHashTarget).mtimeMs, contentHash: null } });
      acknowledgeGoalBatch(nullHash, "file-proof: null-hash startup");
      const nullHashEntries = await runFileGoalResumeTurn(nullHash, t.signal, "file-proof: null-hash attempt",
        { status: "complete", evidence: "Attempted with an unverifiable baseline" });
      const nullHashResults = goalToolResults(await goalEntriesOf(nullHash));
      const nullHashResult = nullHashResults.at(-1);
      if (nullHashResult === undefined) throw new Error("Unreachable: the tool result was asserted present");
      assert.equal(nullHashResult.isError, true, "a null content baseline must fail closed");
      assert.equal(toolResultText(nullHashResult), `Goal deliverable content cannot be verified: ${nullHashTarget}`);
      assert.ok(!nullHashEntries.some((entry) => entry.event === "complete"), "the unverifiable attempt must not complete");
      const nullHashPaused = lastSavedGoal(nullHashEntries, "file-proof: null-hash paused").state;
      assert.ok(nullHashPaused, "the paused state must persist");
      assert.equal(nullHashPaused.status, "paused");
      assert.deepEqual(nullHashPaused.verification, seededVerification, "a failed proof must preserve the exact malformed baseline");
      assert.equal(readFileSync(nullHashTarget, "utf8"), "Original deliverable", "failed verification must not write the deliverable");
      assert.equal(nullHash.provider.requestCount, 2, "the null-hash process issues exactly the resume turn requests");
      observations.push({ vector: "null-content-baseline", requests: 2, outcome: "rejected" });
    } finally {
      errors.push(...await closeGoalFixture(nullHash, "file-proof: null-hash"));
      await removeGoalDirectory(nullHash.directory, "file-proof: null-hash", errors);
    }

    assert.equal(observations.length, 11, "the file-proof scenario contains exactly eleven histories");
    assert.equal(piLaunches, 4, "the scenario launches three fixtures and reopens the saved baseline once");
  } catch (error) {
    errors.push(error);
  }
  await removeGoalDirectory(artifactDirectory, "file-proof: root", errors);
  if (errors.length > 0) {
    throw new AggregateError(errors, "goals.file-proof failed");
  }
  t.diagnostic(JSON.stringify({
    scenarioId: "goals.file-proof",
    piLaunches: 4,
    providerRequests: observations.reduce((total, observation) => total + (typeof observation.requests === "number" ? observation.requests : 0), 0),
    observations,
    cleanup: "natural",
  }));
});

function expectedFileBaseline(filePath: string): RecordValue {
  if (!existsSync(filePath)) return { exists: false };
  const stats = statSync(filePath);
  return { exists: true, size: stats.size, mtimeMs: stats.mtimeMs, contentHash: sha256(readFileSync(filePath)) };
}
