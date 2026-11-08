import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  watch,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const evidenceRoot = path.join(repositoryRoot, ".pi/compact-codex-20261023/settings");
const settingsModel = "settings-fixture/local";

type RecordValue = Record<string, unknown>;
type RpcCloseResult = Awaited<ReturnType<PiRpcProcess["close"]>>;
type TerminalCloseResult = Awaited<ReturnType<PiTerminalProcess["close"]>>;
type RpcOwner = {
  kind: "rpc";
  label: string;
  process: PiRpcProcess;
  pid: number;
  readinessPath: string;
  intentionalKill: boolean;
  result?: RpcCloseResult;
};
type TerminalOwner = {
  kind: "terminal";
  label: string;
  process: PiTerminalProcess;
  readinessPath: string;
  pid?: number;
  result?: TerminalCloseResult;
};
type OwnedProcess = RpcOwner | TerminalOwner;
type Gate = {
  label: string;
  expectedOperation: "linkSync" | "readFileSync" | "process.kill";
  acknowledgmentPath: string;
  releasePath: string;
  token: string;
  released: boolean;
};
type ProviderProbe = {
  baseUrl: string;
  get requestCount(): number;
  get faults(): readonly string[];
  close(): Promise<void>;
};
type CommandAttempt = {
  owner: RpcOwner;
  cursor: number;
  message: string;
  response: Promise<PromiseOutcome<RecordValue>>;
};
type PromiseOutcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown };

const externalIoExtensionSource = String.raw`import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const env = process.env;
const mode = env.KILLEROS_SETTINGS_ADAPTER || "observe";
const readyPath = env.KILLEROS_SETTINGS_READY;
const settingsPath = env.KILLEROS_SETTINGS_PATH;
const lockPath = settingsPath ? settingsPath + ".lock" : undefined;
const ackPath = env.KILLEROS_SETTINGS_ACK;
const releasePath = env.KILLEROS_SETTINGS_RELEASE;
const releaseToken = env.KILLEROS_SETTINGS_RELEASE_TOKEN;
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function writeJsonFile(filePath, value) {
  const temporaryPath = filePath + "." + process.pid + ".tmp";
  originalWriteFileSync(temporaryPath, JSON.stringify(value) + "\n", { encoding: "utf8", flag: "wx" });
  originalRenameSync(temporaryPath, filePath);
}

function waitForRelease() {
  if (!releasePath || !releaseToken) throw new Error("Settings adapter release paths are missing");
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const contents = originalReadFileSync(releasePath, "utf8");
      if (contents !== releaseToken + "\n") throw new Error("Settings adapter release token did not match");
      return;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    Atomics.wait(cell, 0, 0, 10);
  }
}

function readLockOwner(lockFile) {
  const value = JSON.parse(originalReadFileSync(lockFile, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.pid !== "number") {
    throw new Error("Settings lock did not contain a numeric owner PID");
  }
  return value.pid;
}

if (mode === "link-gate") {
  const originalLinkSync = fs.linkSync.bind(fs);
  let gated = false;
  fs.linkSync = function (source, destination) {
    if (!gated && settingsPath && lockPath && ackPath && samePath(destination, lockPath)) {
      gated = true;
      writeJsonFile(ackPath, {
        pid: process.pid,
        operation: "linkSync",
        source: path.resolve(source),
        destination: path.resolve(destination),
      });
      waitForRelease();
    }
    return originalLinkSync(source, destination);
  };
  syncBuiltinESMExports();
}

if (mode === "read-gate") {
  let gated = false;
  fs.readFileSync = function (filePath, ...args) {
    if (!gated && settingsPath && lockPath && ackPath && samePath(filePath, settingsPath) && fs.existsSync(lockPath)) {
      const lockPid = readLockOwner(lockPath);
      if (lockPid === process.pid) {
        gated = true;
        writeJsonFile(ackPath, {
          pid: process.pid,
          operation: "readFileSync",
          settingsPath: path.resolve(settingsPath),
          lockPath: path.resolve(lockPath),
          lockPid,
        });
        waitForRelease();
      }
    }
    return originalReadFileSync(filePath, ...args);
  };
  syncBuiltinESMExports();
}

if (mode === "stale-observer") {
  const stalePid = Number(env.KILLEROS_SETTINGS_STALE_PID);
  const replacementPid = Number(env.KILLEROS_SETTINGS_REPLACEMENT_PID);
  const tracePath = env.KILLEROS_SETTINGS_TRACE;
  const originalKill = process.kill.bind(process);
  let pausedAtStalePid = false;
  let recordedReplacement = false;
  process.kill = function (pid, signal) {
    if (!pausedAtStalePid && pid === stalePid && signal === 0) {
      try {
        return originalKill(pid, signal);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") throw error;
        pausedAtStalePid = true;
        if (!ackPath) throw new Error("Stale observer acknowledgment path is missing");
        writeJsonFile(ackPath, {
          pid: process.pid,
          operation: "process.kill",
          targetPid: stalePid,
          signal,
          errorCode: "ESRCH",
        });
        waitForRelease();
        throw error;
      }
    }
    if (!recordedReplacement && pid === replacementPid && signal === 0) {
      recordedReplacement = true;
      try {
        const result = originalKill(pid, signal);
        if (tracePath) writeJsonFile(tracePath, { pid: process.pid, targetPid: pid, signal, result: "returned" });
        return result;
      } catch (error) {
        if (tracePath) {
          const errorCode = error && typeof error === "object" && "code" in error ? error.code : "unknown";
          writeJsonFile(tracePath, { pid: process.pid, targetPid: pid, signal, result: "threw", errorCode });
        }
        throw error;
      }
    }
    return originalKill(pid, signal);
  };
}

export default function settingsExternalIoFixture(pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!readyPath) throw new Error("Settings fixture readiness path is missing");
    writeJsonFile(readyPath, { pid: process.pid, mode: ctx.mode });
  });
}
`;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: RecordValue, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new Error(`${field} must be a string`);
  return candidate;
}

function requirePid(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer PID`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function jsonObject(text: string, label: string): RecordValue {
  const value: unknown = JSON.parse(text);
  return requireRecord(value, label);
}

function waitForJsonFile(
  filePath: string,
  signal: AbortSignal,
  label: string,
  timeoutMs = 30_000,
): Promise<RecordValue> {
  return new Promise<RecordValue>((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: unknown, value?: RecordValue): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", onAbort);
       if (error !== undefined) {
         reject(error instanceof Error ? error : new Error("Settings file wait failed with a non-Error value", { cause: error }));
       }
      else if (value !== undefined) resolve(value);
      else reject(new Error(`${label} completed without a value`));
    };
    const onAbort = (): void => finish(new Error(`${label} wait cancelled`, { cause: signal.reason }));
    const read = (): void => {
      try {
        finish(undefined, jsonObject(readFileSync(filePath, "utf8"), label));
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) return;
        finish(error);
      }
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      watcher = watch(path.dirname(filePath), (_event, filename) => {
        if (filename === null || filename.toString() === path.basename(filePath)) read();
      });
    } catch (error) {
      finish(error);
      return;
    }
    watcher.on("error", (error) => finish(error));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    read();
  });
}

function outcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value): PromiseOutcome<T> => ({ kind: "resolved", value }),
    (error: unknown): PromiseOutcome<T> => ({ kind: "rejected", error }),
  );
}

function boundedJson(value: unknown, limit = 32_768): string {
  return JSON.stringify(value, null, 2).slice(0, limit);
}

function captureEnvironment(): string {
  return JSON.stringify(Object.entries(process.env).sort(([left], [right]) => left.localeCompare(right)));
}

function isolatedEnvironment(
  home: string,
  agentDirectory: string,
  additional: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const inherited = new Map(Object.entries(process.env).map(([key, value]) => [key.toLowerCase(), value]));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PATH"]) {
    const value = inherited.get(key.toLowerCase());
    if (value !== undefined) env[key] = value;
  }
  const appData = path.join(home, "appdata");
  const localAppData = path.join(home, "localappdata");
  const temporary = path.join(home, "tmp");
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mkdirSync(temporary, { recursive: true });
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temporary,
    TMP: temporary,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    ...additional,
  });
  return env;
}

function createProviderProbe(): Promise<ProviderProbe> {
  const requests: Array<{ method: string; url: string }> = [];
  const faults: string[] = [];
  const activeHandlers = new Set<Promise<void>>();
  const server: Server = createServer((request, response) => {
    const handler = handleRequest(request, response);
    activeHandlers.add(handler);
    void handler.then(
      () => activeHandlers.delete(handler),
      (error: unknown) => {
        if (faults.length < 8) faults.push(error instanceof Error ? error.message : String(error));
        activeHandlers.delete(handler);
      },
    );
  });

  async function handleRequest(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      requests.push({ method: request.method ?? "", url: request.url ?? "" });
      let bytes = 0;
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Provider probe received a non-byte request chunk");
        bytes += chunk.byteLength;
        if (bytes > 1_048_576) throw new Error("Unexpected provider request exceeded 1 MiB");
      }
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(503, { connection: "close" });
        response.end("Settings scenarios must not call the provider");
      }
    } catch (error) {
      if (faults.length < 8) faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(500, { connection: "close" });
        response.end("Provider probe failed");
      }
    }
  }

  return new Promise<ProviderProbe>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Provider probe did not receive a TCP address"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        get requestCount() { return requests.length; },
        get faults() { return faults; },
        async close() {
          if (server.listening) {
            await new Promise<void>((closeResolve, closeReject) => {
              server.close((error) => error ? closeReject(error) : closeResolve());
            });
          }
          await Promise.all([...activeHandlers]);
          assert.deepEqual(faults, [], "Provider probe must not record fixture faults");
        },
      });
    });
  });
}

function writePiConfiguration(agentDirectory: string, providerUrl: string, killerosSettings: RecordValue): string {
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(path.join(agentDirectory, "settings.json"), JSON.stringify({
    cacheWarming: "off",
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
    retry: { enabled: false },
    defaultThinkingLevel: "off",
  }, null, 2));
  writeFileSync(path.join(agentDirectory, "models.json"), JSON.stringify({ providers: {
    "settings-fixture": {
      api: "openai-completions",
      apiKey: "settings-fixture-only",
      baseUrl: providerUrl,
      models: [{
        id: "local",
        name: "Settings E2E fixture",
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  } }, null, 2));
  const settingsPath = path.join(agentDirectory, "killeros.json");
  writeFileSync(settingsPath, `${JSON.stringify(killerosSettings, null, 2)}\n`, "utf8");
  return settingsPath;
}

function writeExternalIoExtension(root: string): string {
  const extensionPath = path.join(root, "settings-external-io-fixture.mjs");
  writeFileSync(extensionPath, externalIoExtensionSource, "utf8");
  return extensionPath;
}

function makeGate(
  project: string,
  label: string,
  expectedOperation: Gate["expectedOperation"],
): Gate {
  return {
    label,
    expectedOperation,
    acknowledgmentPath: path.join(project, `${label}.ack.json`),
    releasePath: path.join(project, `${label}.release`),
    token: `${label}:${randomUUID()}`,
    released: false,
  };
}

function gateEnvironment(gate: Gate, adapter: string, settingsPath: string): Record<string, string> {
  return {
    KILLEROS_SETTINGS_ADAPTER: adapter,
    KILLEROS_SETTINGS_PATH: settingsPath,
    KILLEROS_SETTINGS_ACK: gate.acknowledgmentPath,
    KILLEROS_SETTINGS_RELEASE: gate.releasePath,
    KILLEROS_SETTINGS_RELEASE_TOKEN: gate.token,
    KILLEROS_SETTINGS_READY: path.join(path.dirname(gate.acknowledgmentPath), `${gate.label}.ready.json`),
  };
}

function releaseGate(gate: Gate): void {
  if (gate.released) return;
  const temporaryPath = `${gate.releasePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${gate.token}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, gate.releasePath);
  gate.released = true;
}

function makeRpcOwner(options: {
  label: string;
  home: string;
  project: string;
  agentDirectory: string;
  sessionPath: string;
  extensionPath: string;
  readinessPath: string;
  additionalEnvironment?: Readonly<Record<string, string>>;
}): RpcOwner {
  const env = isolatedEnvironment(options.home, options.agentDirectory, {
    ...options.additionalEnvironment,
    KILLEROS_SETTINGS_READY: options.readinessPath,
  });
  const rpcProcess = new PiRpcProcess({
    cliPath,
    cwd: options.project,
    env,
    args: [
      "--mode", "rpc",
      "--model", settingsModel,
      "--thinking", "off",
      "--no-tools",
      "--session", options.sessionPath,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", options.extensionPath,
    ],
  });
  const diagnostics = jsonObject(rpcProcess.diagnostics(), `${options.label} Pi diagnostics`);
  return {
    kind: "rpc",
    label: options.label,
    process: rpcProcess,
    pid: requirePid(diagnostics.pid, `${options.label} Pi PID`),
    readinessPath: options.readinessPath,
    intentionalKill: false,
  };
}

function makeTerminalOwner(options: {
  label: string;
  home: string;
  project: string;
  agentDirectory: string;
  sessionPath: string;
  extensionPath: string;
  readinessPath: string;
  additionalEnvironment?: Readonly<Record<string, string>>;
}): TerminalOwner {
  const env = isolatedEnvironment(options.home, options.agentDirectory, {
    ...options.additionalEnvironment,
    KILLEROS_SETTINGS_READY: options.readinessPath,
  });
  const terminalProcess = new PiTerminalProcess({
    file: process.execPath,
    args: [
      cliPath,
      "--model", settingsModel,
      "--thinking", "off",
      "--no-tools",
      "--session", options.sessionPath,
      "--offline",
      "--approve",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--no-extensions",
      "--extension", repositoryRoot,
      "--extension", options.extensionPath,
    ],
    cwd: options.project,
    env,
    cols: 100,
    rows: 30,
  });
  return {
    kind: "terminal",
    label: options.label,
    process: terminalProcess,
    readinessPath: options.readinessPath,
  };
}

async function initializeRpc(owner: RpcOwner, signal: AbortSignal): Promise<void> {
  const ready = await waitForJsonFile(owner.readinessPath, signal, `${owner.label} readiness`);
  assert.equal(requirePid(ready.pid, `${owner.label} readiness PID`), owner.pid);
  assert.equal(requireString(ready, "mode"), "rpc");
  const stateResponse = await owner.process.command("get_state", {}, { timeoutMs: 30_000, signal });
  const state = requireRecord(stateResponse.data, `${owner.label} startup state`);
  assertIdle(state, `${owner.label} startup`);
  const commandResponse = await owner.process.command("get_commands", {}, { timeoutMs: 30_000, signal });
  const commandData = requireRecord(commandResponse.data, `${owner.label} commands`);
  const commands = requireArray(commandData.commands, `${owner.label} command list`).map((entry) => requireRecord(entry, "Pi command"));
  assert.ok(commands.some((command) => command.name === "auto-compact" && command.source === "extension"));
}

async function initializeTerminal(owner: TerminalOwner, signal: AbortSignal): Promise<void> {
  const ready = await waitForJsonFile(owner.readinessPath, signal, `${owner.label} readiness`);
  owner.pid = requirePid(ready.pid, `${owner.label} readiness PID`);
  assert.equal(requireString(ready, "mode"), "tui");
  await owner.process.waitForScreen(
    (screen) => screen.includes("KillerOS") || screen.includes("›"),
    { signal, timeoutMs: 30_000 },
  );
}

function assertIdle(state: RecordValue, label: string): void {
  assert.equal(state.isStreaming, false, `${label}: Pi must not be streaming`);
  assert.equal(state.isCompacting, false, `${label}: Pi must not be compacting`);
  assert.equal(state.pendingMessageCount, 0, `${label}: no messages may remain queued`);
}

function beginRpcCommand(owner: RpcOwner, message: string, signal: AbortSignal): CommandAttempt {
  const cursor = owner.process.currentSequence;
  return {
    owner,
    cursor,
    message,
    response: outcome(owner.process.command("prompt", { message }, { timeoutMs: 60_000, signal })),
  };
}

async function finishRpcCommand(
  attempt: CommandAttempt,
  notification: (message: string) => boolean,
  expectedType: "info" | "error",
  signal: AbortSignal,
): Promise<void> {
  const result = await attempt.response;
  if (result.kind === "rejected") {
    throw new Error(`${attempt.owner.label} ${attempt.message} prompt failed`, { cause: result.error });
  }
  const data = requireRecord(result.value.data, `${attempt.owner.label} ${attempt.message} response`);
  assert.equal(data.disposition, "handled", `${attempt.owner.label}: extension command must be acknowledged as handled`);
  const notify = await attempt.owner.process.waitFor(
    (record) => record.type === "extension_ui_request"
      && record.method === "notify"
      && typeof record.message === "string"
      && notification(record.message),
    { after: attempt.cursor, timeoutMs: 20_000, signal },
  );
  assert.equal(notify.notifyType ?? "info", expectedType, `${attempt.owner.label}: command notification type`);
  const stateResponse = await attempt.owner.process.command("get_state", {}, { timeoutMs: 30_000, signal });
  assertIdle(requireRecord(stateResponse.data, `${attempt.owner.label} post-command state`), `${attempt.owner.label} post-command`);
}

async function runRpcCommand(
  owner: RpcOwner,
  message: string,
  expectedNotification: (message: string) => boolean,
  signal: AbortSignal,
): Promise<void> {
  await finishRpcCommand(beginRpcCommand(owner, message, signal), expectedNotification, "info", signal);
}

async function waitForGate(gate: Gate, owner: OwnedProcess, signal: AbortSignal): Promise<RecordValue> {
  const acknowledgment = await waitForJsonFile(gate.acknowledgmentPath, signal, `${gate.label} acknowledgment`);
  assert.equal(requireString(acknowledgment, "operation"), gate.expectedOperation, `${gate.label}: operation-specific barrier`);
  const pid = owner.kind === "rpc" ? owner.pid : requirePid(owner.pid, `${owner.label} Pi PID`);
  assert.equal(requirePid(acknowledgment.pid, `${gate.label} acknowledgment PID`), pid);
  return acknowledgment;
}

function settingsSidecars(agentDirectory: string): string[] {
  return readdirSync(agentDirectory).filter((name) => name.startsWith("killeros.json.")).sort();
}

function assertNoSettingsSidecars(agentDirectory: string, label: string): void {
  assert.deepEqual(settingsSidecars(agentDirectory), [], `${label}: no settings lock, temp, stale, or recovery files may remain`);
}

function assertOnlySettingsLock(agentDirectory: string, label: string): void {
  assert.deepEqual(settingsSidecars(agentDirectory), ["killeros.json.lock"], `${label}: only the settings lock may remain`);
}

function assertSettingsLockAndWaitingOwner(agentDirectory: string, ownerPid: number, label: string): void {
  const sidecars = settingsSidecars(agentDirectory);
  assert.equal(sidecars.length, 2, `${label}: the replacement lock and one waiting owner's temp file must remain`);
  assert.equal(sidecars[0], "killeros.json.lock", `${label}: the live replacement lock must remain`);
  assert.ok(sidecars[1]?.startsWith(`killeros.json.lock.${ownerPid}.`), `${label}: the other sidecar must belong to the paused observer`);
  assert.ok(sidecars[1]?.endsWith(".tmp"), `${label}: the paused observer must still own its acquisition temp file`);
}

function settingsAt(settingsPath: string, label: string): RecordValue {
  return jsonObject(readFileSync(settingsPath, "utf8"), label);
}

function assertPublicContentionSettings(settingsPath: string, agentDirectory: string, label: string): void {
  const settings = settingsAt(settingsPath, label);
  assert.deepEqual(settings.futureSetting, { retained: true }, `${label}: preserve unrelated settings`);
  assert.equal(settings.completionSound, true, `${label}: preserve the notification writer's update`);
  const autoCompaction = requireRecord(settings.autoCompaction, `${label} auto-compaction settings`);
  assert.equal(autoCompaction.percentRemaining, 70, `${label}: preserve the threshold writer's update`);
  assert.equal(autoCompaction.enabled, false, `${label}: preserve the successful disable writes before normalization`);
  assertNoSettingsSidecars(agentDirectory, label);
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrorCode(error, "ESRCH");
  }
}

function assertPidGone(pid: number, label: string): void {
  let error: unknown;
  try {
    process.kill(pid, 0);
  } catch (caught) {
    error = caught;
  }
  assert.ok(isErrorCode(error, "ESRCH"), `${label}: owned PID ${pid} must be confirmed gone`);
}

function createExitedPidChild(options: { home: string; agentDirectory: string; cwd: string }): number {
  const environment = isolatedEnvironment(options.home, options.agentDirectory);
  const child = spawnSync(process.execPath, [
    "-e",
    'process.stdout.write(JSON.stringify({ pid: process.pid, ready: "settings-dead-pid-child" }) + "\\n")',
  ], {
    cwd: options.cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  assert.equal(child.error, undefined, "The owned dead-PID child must launch and exit");
  assert.equal(child.status, 0, `The owned dead-PID child must exit successfully: ${child.stderr}`);
  assert.equal(child.signal, null, "The owned dead-PID child must exit naturally");
  assert.equal(child.stdout.endsWith("\n"), true, "The complete child readiness record must end with a newline");
  const ready = jsonObject(child.stdout.slice(0, -1), "owned dead-PID child readiness");
  const pid = requirePid(ready.pid, "owned dead-PID child PID");
  assert.equal(pid, requirePid(child.pid, "spawned dead-PID child PID"));
  assert.equal(requireString(ready, "ready"), "settings-dead-pid-child");
  assertPidGone(pid, "owned dead-PID child");
  return pid;
}

async function closeOwnedProcess(owner: OwnedProcess): Promise<void> {
  if (owner.kind === "rpc") {
    if (owner.result) return;
    owner.result = await owner.process.close();
    if (owner.intentionalKill) {
      assert.equal(owner.result.forced, false, `${owner.label}: the test must not delegate its intentional kill to the driver`);
      assert.equal(owner.result.treeCleanupError, undefined, `${owner.label}: owned process exit must be confirmed`);
      assertPidGone(owner.pid, owner.label);
      return;
    }
    assert.equal(owner.result.exit.code, 0, `${owner.label}: Pi must exit naturally with code 0`);
    assert.equal(owner.result.exit.signal, null, `${owner.label}: Pi must not exit from a signal`);
    assert.equal(owner.result.forced, false, `${owner.label}: Pi shutdown must not be forced`);
    assert.equal(owner.result.treeCleanupError, undefined, `${owner.label}: Pi process-tree cleanup must be confirmed`);
    return;
  }
  if (owner.result) return;
  owner.result = await owner.process.close();
  assert.equal(owner.result.code, 0, `${owner.label}: Pi TUI must exit naturally with code 0`);
  assert.equal(owner.result.forced, false, `${owner.label}: Pi TUI shutdown must not be forced`);
  assert.equal(owner.result.failure, undefined, `${owner.label}: native terminal cleanup must succeed`);
}

async function cleanupResources(options: {
  gates: Gate[];
  owners: OwnedProcess[];
  provider?: ProviderProbe;
  directory?: string;
}): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const gate of options.gates) {
    try {
      releaseGate(gate);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const owner of [...options.owners].reverse()) {
    try {
      await closeOwnedProcess(owner);
    } catch (error) {
      errors.push(error);
    }
  }
  if (options.provider) {
    try {
      await options.provider.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (options.directory && existsSync(options.directory)) {
    try {
      await removeDirectoryEventually(options.directory);
      assert.equal(existsSync(options.directory), false, "The owned settings fixture directory must be removed");
    } catch (error) {
      errors.push(error);
      try {
        await removeDirectoryEventually(options.directory);
        assert.equal(existsSync(options.directory), false, "The owned settings fixture directory must be removed on cleanup retry");
      } catch (retryError) {
        errors.push(retryError);
      }
    }
  }
  return errors;
}

async function throwWithFailureEvidence(options: {
  message: string;
  errors: unknown[];
  diagnostics: string;
}): Promise<never> {
  let reportDirectory: string;
  try {
    mkdirSync(evidenceRoot, { recursive: true });
    reportDirectory = mkdtempSync(path.join(evidenceRoot, "settings-failure-"));
  } catch (error) {
    throw new AggregateError([...options.errors, error], `${options.message}; failure evidence directory could not be created`);
  }
  try {
    throwScenarioFailure({
      directory: reportDirectory,
      message: options.message,
      errors: options.errors,
      diagnostics: options.diagnostics,
    });
  } catch (error) {
    if (!existsSync(path.join(reportDirectory, "failure.txt"))) {
      try {
        if (readdirSync(reportDirectory).length === 0) await removeDirectoryEventually(reportDirectory);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${options.message}; empty failure evidence cleanup failed`);
      }
    }
    throw error;
  }
}

function processSnapshot(owners: OwnedProcess[]): RecordValue[] {
  return owners.map((owner) => owner.kind === "rpc"
    ? {
      label: owner.label,
      kind: owner.kind,
      pid: owner.pid,
      result: owner.result,
      diagnostics: owner.process.diagnostics().slice(0, 12_000),
    }
    : {
      label: owner.label,
      kind: owner.kind,
      pid: owner.pid,
      result: owner.result,
      diagnostics: owner.process.diagnostics().slice(0, 12_000),
    });
}

async function waitForTuiScreen(
  owner: TerminalOwner,
  predicate: (screen: string) => boolean,
  after: number,
  signal: AbortSignal,
  label: string,
): Promise<string> {
  return await owner.process.waitForScreen(predicate, { signal, after, timeoutMs: 20_000 }).catch((error: unknown) => {
    throw new Error(`${owner.label}: timed out or exited before ${label}\n${owner.process.diagnostics()}`, { cause: error });
  });
}

async function waitForTuiNotificationSelection(owner: TerminalOwner, signal: AbortSignal): Promise<void> {
  const selectionAfter = await startTuiNotificationSelection(owner, signal);
  await finishTuiNotificationSelection(owner, selectionAfter, signal);
}

async function startTuiNotificationSelection(owner: TerminalOwner, signal: AbortSignal): Promise<number> {
  const after = owner.process.sequence;
  owner.process.write("/notification\r");
  const dialog = await waitForTuiScreen(
    owner,
    (screen) => screen.includes("Completion sound") && screen.includes("On") && screen.includes("Off"),
    after,
    signal,
    "the notification choice dialog",
  );
  assert.match(dialog, /Completion sound/u);
  const selectionAfter = owner.process.sequence;
  owner.process.write("\r");
  return selectionAfter;
}

async function finishTuiNotificationSelection(owner: TerminalOwner, selectionAfter: number, signal: AbortSignal): Promise<void> {
  await waitForTuiScreen(owner, (screen) => screen.includes("Completion sound: On"), selectionAfter, signal, "the saved notification choice");
}

async function runTuiCommand(
  owner: TerminalOwner,
  command: string,
  predicate: (screen: string) => boolean,
  signal: AbortSignal,
  label: string,
): Promise<string> {
  const after = owner.process.sequence;
  owner.process.write(`${command}\r`);
  return await waitForTuiScreen(owner, predicate, after, signal, label);
}

async function saveFailureIfNeeded(options: {
  message: string;
  primaryError: unknown;
  cleanupErrors: unknown[];
  diagnostics: RecordValue;
}): Promise<void> {
  const errors = [
    ...(options.primaryError === undefined ? [] : [options.primaryError]),
    ...options.cleanupErrors,
  ];
  if (errors.length === 0) return;
  await throwWithFailureEvidence({
    message: options.message,
    errors,
    diagnostics: boundedJson(options.diagnostics),
  });
}

// Catalog ID: SET-01.
test("Settings updates derive from the current file and preserve unrelated fields", { timeout: 180_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const environmentBefore = captureEnvironment();
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-settings-set-01-"));
  const agentDirectory = path.join(directory, "agent");
  const notificationProject = path.join(directory, "notification-project");
  const compactionProject = path.join(directory, "compaction-project");
  mkdirSync(notificationProject);
  mkdirSync(compactionProject);
  const owners: OwnedProcess[] = [];
  const gates: Gate[] = [];
  let provider: ProviderProbe | undefined;
  let settingsPath = "";
  let primaryError: unknown;
  try {
    provider = await createProviderProbe();
    settingsPath = writePiConfiguration(agentDirectory, provider.baseUrl, {
      futureSetting: { retained: "settings-e2e" },
      autoCompaction: { enabled: true, percentRemaining: 40 },
      completionSound: false,
    });
    const extensionPath = writeExternalIoExtension(directory);

    const notificationProjectHome = path.join(directory, "notification-home");
    const notificationReady = path.join(notificationProjectHome, "notification.ready.json");
    mkdirSync(notificationProjectHome);
    const notification = makeTerminalOwner({
      label: "notification setting",
      home: notificationProjectHome,
      project: notificationProject,
      agentDirectory,
      sessionPath: path.join(notificationProject, "session.jsonl"),
      extensionPath,
      readinessPath: notificationReady,
    });
    owners.push(notification);
    await initializeTerminal(notification, t.signal);
    await waitForTuiNotificationSelection(notification, t.signal);
    assert.deepEqual(settingsAt(settingsPath, "notification settings after /notification"), {
      futureSetting: { retained: "settings-e2e" },
      autoCompaction: { enabled: true, percentRemaining: 40 },
      completionSound: true,
    });
    assertNoSettingsSidecars(agentDirectory, "successful /notification update");
    await closeOwnedProcess(notification);

    const compactionHome = path.join(directory, "compaction-home");
    const compactionReady = path.join(compactionHome, "compaction.ready.json");
    mkdirSync(compactionHome);
    const compaction = makeTerminalOwner({
      label: "auto-compaction setting",
      home: compactionHome,
      project: compactionProject,
      agentDirectory,
      sessionPath: path.join(compactionProject, "session.jsonl"),
      extensionPath,
      readinessPath: compactionReady,
    });
    owners.push(compaction);
    await initializeTerminal(compaction, t.signal);
    await runTuiCommand(
      compaction,
      "/auto-compact 70",
      (screen) => screen.includes("Automatic compaction threshold: 70% remaining (on)"),
      t.signal,
      "the successful auto-compaction setting notification",
    );
    assert.deepEqual(settingsAt(settingsPath, "settings after /auto-compact 70"), {
      futureSetting: { retained: "settings-e2e" },
      autoCompaction: { enabled: true, percentRemaining: 70 },
      completionSound: true,
    });
    assertNoSettingsSidecars(agentDirectory, "successful /auto-compact update");

    const malformed = "{\"futureSetting\":\"keep\",\"autoCompaction\":";
    writeFileSync(settingsPath, malformed, "utf8");
    await runTuiCommand(
      compaction,
      "/auto-compact off",
      (screen) => screen.includes("Automatic compaction setting could not be saved"),
      t.signal,
      "the malformed-settings error notification",
    );
    assert.equal(readFileSync(settingsPath, "utf8"), malformed, "A failed public update must leave malformed settings byte-identical");
    assertNoSettingsSidecars(agentDirectory, "failed malformed-settings update");
    assert.equal(provider.requestCount, 0, "Settings commands must not start model requests");
    assert.deepEqual(provider.faults, []);
    assert.equal(captureEnvironment(), environmentBefore, "The test must not mutate the runner environment");
    t.diagnostic(JSON.stringify({
      scenarioId: "SET-01",
      processModes: ["tui", "tui"],
      piLaunches: owners.length,
      providerRequests: provider.requestCount,
      publicCommandVectors: ["/notification => On", "/auto-compact 70", "/auto-compact off with malformed settings"],
      settingsSidecarsAfterCompletion: settingsSidecars(agentDirectory),
    }));
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = await cleanupResources({ gates, owners, provider, directory });
  await saveFailureIfNeeded({
    message: "SET-01 settings update scenario failed or did not clean up naturally",
    primaryError,
    cleanupErrors,
    diagnostics: {
      scenarioId: "SET-01",
      mode: "tui",
      node: process.version,
      settingsPath,
      settings: settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").slice(0, 4_000) : "missing",
      providerRequests: provider?.requestCount ?? 0,
      providerFaults: provider?.faults.slice(0, 8) ?? [],
      processes: processSnapshot(owners),
    },
  });
});

// Catalog ID: SET-02.
test("An exited settings writer does not leave the settings lock stuck", { timeout: 180_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-settings-set-02-"));
  const agentDirectory = path.join(directory, "agent");
  const writerProject = path.join(directory, "writer-project");
  const survivorProject = path.join(directory, "survivor-project");
  mkdirSync(writerProject);
  mkdirSync(survivorProject);
  const owners: OwnedProcess[] = [];
  const gates: Gate[] = [];
  let provider: ProviderProbe | undefined;
  let settingsPath = "";
  let primaryError: unknown;
  let intentionalKillIssued = false;
  try {
    provider = await createProviderProbe();
    settingsPath = writePiConfiguration(agentDirectory, provider.baseUrl, {
      futureSetting: "keep",
      autoCompaction: { enabled: true, percentRemaining: 40 },
    });
    const extensionPath = writeExternalIoExtension(directory);
    const writerGate = makeGate(writerProject, "abandoned-writer", "readFileSync");
    gates.push(writerGate);
    const writerHome = path.join(directory, "writer-home");
    mkdirSync(writerHome);
    const writer = makeRpcOwner({
      label: "abandoned settings writer",
      home: writerHome,
      project: writerProject,
      agentDirectory,
      sessionPath: path.join(writerProject, "session.jsonl"),
      extensionPath,
      readinessPath: path.join(writerProject, "abandoned-writer.ready.json"),
      additionalEnvironment: gateEnvironment(writerGate, "read-gate", settingsPath),
    });
    owners.push(writer);
    await initializeRpc(writer, t.signal);

    const survivorHome = path.join(directory, "survivor-home");
    mkdirSync(survivorHome);
    const survivorReady = path.join(survivorProject, "survivor.ready.json");
    const survivor = makeRpcOwner({
      label: "settings lock survivor",
      home: survivorHome,
      project: survivorProject,
      agentDirectory,
      sessionPath: path.join(survivorProject, "session.jsonl"),
      extensionPath,
      readinessPath: survivorReady,
    });
    owners.push(survivor);
    await initializeRpc(survivor, t.signal);

    const abandonedAttempt = beginRpcCommand(writer, "/auto-compact off", t.signal);
    const acknowledgment = await waitForGate(writerGate, writer, t.signal);
    assert.equal(acknowledgment.operation, "readFileSync");
    assert.equal(acknowledgment.settingsPath, path.resolve(settingsPath));
    assert.equal(acknowledgment.lockPath, path.resolve(`${settingsPath}.lock`));
    assert.equal(requirePid(acknowledgment.pid, "abandoned writer adapter PID"), writer.pid);
    assert.equal(requirePid(acknowledgment.lockPid, "settings lock owner PID"), writer.pid);
    assert.equal(isPidRunning(writer.pid), true, "The settings lock owner must be the live owned Pi process");
    assert.equal(requirePid(settingsAt(`${settingsPath}.lock`, "lock owner record").pid, "settings lock PID"), writer.pid);
    assertOnlySettingsLock(agentDirectory, "writer paused after lock acquisition");
    assert.deepEqual(settingsAt(settingsPath, "settings before intentional writer termination"), {
      futureSetting: "keep",
      autoCompaction: { enabled: true, percentRemaining: 40 },
    });

    writer.intentionalKill = true;
    process.kill(writer.pid, "SIGKILL");
    intentionalKillIssued = true;
    await closeOwnedProcess(writer);
    const abandonedResult = await abandonedAttempt.response;
    assert.equal(abandonedResult.kind, "rejected", "The killed public command must not receive a success response");
    assert.equal(provider.requestCount, 0);

    await runRpcCommand(
      survivor,
      "/auto-compact 70",
      (message) => message === "Automatic compaction threshold: 70% remaining (on)",
      t.signal,
    );
    assert.deepEqual(settingsAt(settingsPath, "settings after stale-lock recovery"), {
      futureSetting: "keep",
      autoCompaction: { enabled: true, percentRemaining: 70 },
    });
    assertNoSettingsSidecars(agentDirectory, "recovered settings write");
    assert.deepEqual(provider.faults, []);
    t.diagnostic(JSON.stringify({
      scenarioId: "SET-02",
      processModes: ["rpc", "rpc"],
      piLaunches: owners.length,
      intentionalWriterPid: writer.pid,
      intentionalKillIssued,
      publicCommands: ["/auto-compact off (killed after lock acquisition)", "/auto-compact 70 (survivor)"],
      providerRequests: provider.requestCount,
      settingsSidecarsAfterRecovery: settingsSidecars(agentDirectory),
    }));
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = await cleanupResources({ gates, owners, provider, directory });
  await saveFailureIfNeeded({
    message: "SET-02 abandoned settings lock scenario failed or did not clean up naturally",
    primaryError,
    cleanupErrors,
    diagnostics: {
      scenarioId: "SET-02",
      mode: "rpc",
      node: process.version,
      settingsPath,
      intentionalKillIssued,
      settings: settingsPath && existsSync(settingsPath) ? readFileSync(settingsPath, "utf8").slice(0, 4_000) : "missing",
      providerRequests: provider?.requestCount ?? 0,
      providerFaults: provider?.faults.slice(0, 8) ?? [],
      processes: processSnapshot(owners),
    },
  });
});

// Catalog ID: SET-03.
test("Concurrent settings writers preserve every successful write and stale observers cannot remove a new lock", { timeout: 360_000 }, async (t: TestContext) => {
  assert.equal(process.platform, "win32", "KillerOS supports Windows only");
  const environmentBefore = captureEnvironment();
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-settings-set-03-"));
  const contentionAgent = path.join(directory, "contention-agent");
  const owners: OwnedProcess[] = [];
  const gates: Gate[] = [];
  let provider: ProviderProbe | undefined;
  let contentionSettingsPath = "";
  let staleSettingsPath = "";
  let primaryError: unknown;
  const phaseCounts = {
    contentionRpcWriters: 0,
    contentionTuiWriters: 0,
    staleRaceRpcWriters: 0,
    ownedDeadPidChildren: 0,
    publicCommandVectors: 0,
  };
  let exitedPid: number | undefined;

  try {
    provider = await createProviderProbe();
    contentionSettingsPath = writePiConfiguration(contentionAgent, provider.baseUrl, {
      futureSetting: { retained: true },
      autoCompaction: { enabled: true, percentRemaining: 40 },
      completionSound: false,
    });
    const extensionPath = writeExternalIoExtension(directory);

    const rpcWriters: RpcOwner[] = [];
    const rpcGates: Gate[] = [];
    for (let index = 0; index < 11; index += 1) {
      const label = `contention-rpc-${index + 1}`;
      const project = path.join(directory, label);
      const home = path.join(directory, `${label}-home`);
      mkdirSync(project);
      mkdirSync(home);
      const gate = makeGate(project, `${label}-link`, "linkSync");
      gates.push(gate);
      rpcGates.push(gate);
      const owner = makeRpcOwner({
        label,
        home,
        project,
        agentDirectory: contentionAgent,
        sessionPath: path.join(project, "session.jsonl"),
        extensionPath,
        readinessPath: path.join(project, `${label}.ready.json`),
        additionalEnvironment: gateEnvironment(gate, "link-gate", contentionSettingsPath),
      });
      rpcWriters.push(owner);
      owners.push(owner);
    }
    phaseCounts.contentionRpcWriters = rpcWriters.length;

    const tuiProject = path.join(directory, "contention-tui");
    const tuiHome = path.join(directory, "contention-tui-home");
    mkdirSync(tuiProject);
    mkdirSync(tuiHome);
    const tuiGate = makeGate(tuiProject, "contention-tui-link", "linkSync");
    gates.push(tuiGate);
    const tuiReady = path.join(tuiProject, "contention-tui.ready.json");
    const tuiWriter = makeTerminalOwner({
      label: "contention TUI notification writer",
      home: tuiHome,
      project: tuiProject,
      agentDirectory: contentionAgent,
      sessionPath: path.join(tuiProject, "session.jsonl"),
      extensionPath,
      readinessPath: tuiReady,
      additionalEnvironment: gateEnvironment(tuiGate, "link-gate", contentionSettingsPath),
    });
    owners.push(tuiWriter);
    phaseCounts.contentionTuiWriters = 1;

    await Promise.all([
      ...rpcWriters.map((owner) => initializeRpc(owner, t.signal)),
      initializeTerminal(tuiWriter, t.signal),
    ]);

    const firstWaveCommands = rpcWriters.map((owner, index) => {
      const message = index % 2 === 0 ? "/auto-compact off" : "/auto-compact 70";
      phaseCounts.publicCommandVectors += 1;
      return beginRpcCommand(owner, message, t.signal);
    });
    const tuiSelectionAfter = await startTuiNotificationSelection(tuiWriter, t.signal);
    phaseCounts.publicCommandVectors += 1;

    const acknowledgments = await Promise.all([
      ...rpcWriters.map((owner, index) => {
        const gate = rpcGates[index];
        assert.ok(gate, `RPC writer ${index + 1} must have its own lock barrier`);
        return waitForGate(gate, owner, t.signal);
      }),
      waitForGate(tuiGate, tuiWriter, t.signal),
    ]);
    for (const acknowledgment of acknowledgments) {
      assert.equal(
        requireString(acknowledgment, "destination"),
        path.resolve(`${contentionSettingsPath}.lock`),
        "Every contention barrier must pause the real lock-link operation for the shared settings file",
      );
    }
    assert.equal(acknowledgments.length, 12, "All eleven RPC writers and the TUI writer must reach the acknowledged barrier");
    for (const gate of gates.slice(0, 12)) releaseGate(gate);

    await Promise.all(firstWaveCommands.map((attempt) => finishRpcCommand(
      attempt,
      (message) => message.startsWith("Automatic compaction:") || message.startsWith("Automatic compaction threshold:"),
      "info",
      t.signal,
    )));
    await finishTuiNotificationSelection(tuiWriter, tuiSelectionAfter, t.signal);
    assertPublicContentionSettings(contentionSettingsPath, contentionAgent, "first public contention wave");

    const secondWave = rpcWriters.map((owner, index) => {
      const message = index % 2 === 0 ? "/auto-compact 70" : "/auto-compact off";
      phaseCounts.publicCommandVectors += 1;
      return runRpcCommand(
        owner,
        message,
        (notification) => message.endsWith("70")
          ? notification.startsWith("Automatic compaction threshold: 70% remaining (")
          : notification.startsWith("Automatic compaction: off"),
        t.signal,
      );
    });
    await Promise.all(secondWave);
    assertPublicContentionSettings(contentionSettingsPath, contentionAgent, "second public contention wave");

    const normalizer = rpcWriters.at(0);
    assert.ok(normalizer, "The contention phase must retain an owned RPC process for final normalization");
    phaseCounts.publicCommandVectors += 1;
    await runRpcCommand(
      normalizer,
      "/auto-compact 70",
      (notification) => notification.startsWith("Automatic compaction threshold: 70% remaining ("),
      t.signal,
    );
    phaseCounts.publicCommandVectors += 1;
    await runRpcCommand(
      normalizer,
      "/auto-compact off",
      (notification) => notification === "Automatic compaction: off (threshold 70%)",
      t.signal,
    );
    assert.deepEqual(settingsAt(contentionSettingsPath, "settings after all twelve contention writers"), {
      futureSetting: { retained: true },
      autoCompaction: { enabled: false, percentRemaining: 70 },
      completionSound: true,
    });
    assertNoSettingsSidecars(contentionAgent, "completed concurrent public updates");

    const staleAgent = path.join(directory, "stale-agent");
    const staleObserverProject = path.join(directory, "stale-observer");
    const replacementProject = path.join(directory, "stale-replacement");
    const deadPidHome = path.join(directory, "dead-pid-home");
    const deadPidAgent = path.join(directory, "dead-pid-agent");
    const observerHome = path.join(directory, "stale-observer-home");
    const replacementHome = path.join(directory, "stale-replacement-home");
    mkdirSync(staleObserverProject);
    mkdirSync(replacementProject);
    mkdirSync(observerHome);
    mkdirSync(replacementHome);
    staleSettingsPath = writePiConfiguration(staleAgent, provider.baseUrl, {
      futureSetting: { staleRace: true },
      autoCompaction: { enabled: true, percentRemaining: 40 },
    });
    exitedPid = createExitedPidChild({ home: deadPidHome, agentDirectory: deadPidAgent, cwd: directory });
    phaseCounts.ownedDeadPidChildren = 1;
    writeFileSync(`${staleSettingsPath}.lock`, `${JSON.stringify({ pid: exitedPid })}\n`, "utf8");
    assert.equal(requirePid(settingsAt(`${staleSettingsPath}.lock`, "seeded stale lock").pid, "seeded stale owner PID"), exitedPid);
    assertPidGone(exitedPid, "seeded stale lock owner");

    const staleObserverGate = makeGate(staleObserverProject, "stale-observer", "process.kill");
    const replacementGate = makeGate(replacementProject, "stale-replacement", "readFileSync");
    gates.push(staleObserverGate, replacementGate);
    const observerTracePath = path.join(staleObserverProject, "replacement-pid-probe.json");
    const replacement = makeRpcOwner({
      label: "replacement settings writer",
      home: replacementHome,
      project: replacementProject,
      agentDirectory: staleAgent,
      sessionPath: path.join(replacementProject, "session.jsonl"),
      extensionPath,
      readinessPath: path.join(replacementProject, "stale-replacement.ready.json"),
      additionalEnvironment: gateEnvironment(replacementGate, "read-gate", staleSettingsPath),
    });
    const observer = makeRpcOwner({
      label: "delayed stale-lock observer",
      home: observerHome,
      project: staleObserverProject,
      agentDirectory: staleAgent,
      sessionPath: path.join(staleObserverProject, "session.jsonl"),
      extensionPath,
      readinessPath: path.join(staleObserverProject, "stale-observer.ready.json"),
      additionalEnvironment: {
        ...gateEnvironment(staleObserverGate, "stale-observer", staleSettingsPath),
        KILLEROS_SETTINGS_STALE_PID: String(exitedPid),
        KILLEROS_SETTINGS_TRACE: observerTracePath,
        KILLEROS_SETTINGS_REPLACEMENT_PID: String(replacement.pid),
      },
    });
    owners.push(observer, replacement);
    phaseCounts.staleRaceRpcWriters = 2;
    assert.equal(isPidRunning(replacement.pid), true, "The replacement PID must belong to a live owned Pi process");

    await Promise.all([
      initializeRpc(observer, t.signal),
      initializeRpc(replacement, t.signal),
    ]);
    phaseCounts.publicCommandVectors += 1;
    const observerAttempt = beginRpcCommand(observer, "/auto-compact off", t.signal);
    const staleAcknowledgment = await waitForGate(staleObserverGate, observer, t.signal);
    assert.equal(requirePid(staleAcknowledgment.targetPid, "stale PID probe target"), exitedPid);
    assert.equal(staleAcknowledgment.signal, 0);
    assert.equal(staleAcknowledgment.errorCode, "ESRCH");
    assert.equal(requirePid(settingsAt(`${staleSettingsPath}.lock`, "stale lock during held observation").pid, "stale lock PID"), exitedPid);

    phaseCounts.publicCommandVectors += 1;
    const replacementAttempt = beginRpcCommand(replacement, "/auto-compact 70", t.signal);
    const replacementAcknowledgment = await waitForGate(replacementGate, replacement, t.signal);
    assert.equal(replacementAcknowledgment.settingsPath, path.resolve(staleSettingsPath));
    assert.equal(replacementAcknowledgment.lockPath, path.resolve(`${staleSettingsPath}.lock`));
    assert.equal(requirePid(replacementAcknowledgment.lockPid, "replacement lock owner PID"), replacement.pid);
    assert.equal(requirePid(settingsAt(`${staleSettingsPath}.lock`, "replacement lock while writer is paused").pid, "replacement lock PID"), replacement.pid);
    assertSettingsLockAndWaitingOwner(staleAgent, observer.pid, "replacement writer paused while holding its new lock");

    releaseGate(staleObserverGate);
    const replacementProbe = await waitForJsonFile(observerTracePath, t.signal, "stale observer replacement-PID probe");
    assert.equal(requirePid(replacementProbe.pid, "stale observer Pi PID"), observer.pid);
    assert.equal(requirePid(replacementProbe.targetPid, "replacement process probe PID"), replacement.pid);
    assert.equal(replacementProbe.signal, 0);
    assert.equal(replacementProbe.result, "returned");
    assert.equal(requirePid(settingsAt(`${staleSettingsPath}.lock`, "lock after delayed stale observer resumes").pid, "lock after stale observer resumes"), replacement.pid);
    assertSettingsLockAndWaitingOwner(staleAgent, observer.pid, "delayed stale observer must not remove the replacement lock");

    releaseGate(replacementGate);
    await Promise.all([
      finishRpcCommand(
        observerAttempt,
        (message) => message === "Automatic compaction: off (threshold 70%)",
        "info",
        t.signal,
      ),
      finishRpcCommand(
        replacementAttempt,
        (message) => message === "Automatic compaction threshold: 70% remaining (on)",
        "info",
        t.signal,
      ),
    ]);
    assert.deepEqual(settingsAt(staleSettingsPath, "settings after delayed stale-lock observer race"), {
      futureSetting: { staleRace: true },
      autoCompaction: { enabled: false, percentRemaining: 70 },
    });
    assertNoSettingsSidecars(staleAgent, "completed stale-owner race writes");
    assert.equal(owners.length, 14, "SET-03 must launch twelve contention and two stale-race Pi processes");
    assert.equal(provider.requestCount, 0, "Public settings commands must not start model requests");
    assert.deepEqual(provider.faults, []);
    assert.equal(captureEnvironment(), environmentBefore, "The test must not mutate the runner environment");
    t.diagnostic(JSON.stringify({
      scenarioId: "SET-03",
      processModes: ["rpc", "tui"],
      piLaunches: owners.length,
      phaseCounts,
      exitedPid,
      publicCommandVectors: [
        "11 RPC writers each run /auto-compact off and /auto-compact 70",
        "one TUI writer selects /notification On",
        "two final normalization commands preserve enabled=false and percentRemaining=70",
        "stale-observer RPC /auto-compact off",
        "replacement RPC /auto-compact 70",
      ],
      providerRequests: provider.requestCount,
      contentionSettings: settingsAt(contentionSettingsPath, "contention final state"),
      staleRaceSettings: settingsAt(staleSettingsPath, "stale-race final state"),
      contentionSidecars: settingsSidecars(contentionAgent),
      staleRaceSidecars: settingsSidecars(staleAgent),
    }));
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = await cleanupResources({ gates, owners, provider, directory });
  await saveFailureIfNeeded({
    message: "SET-03 settings concurrency scenario failed or did not clean up naturally",
    primaryError,
    cleanupErrors,
    diagnostics: {
      scenarioId: "SET-03",
      mode: "rpc and tui",
      node: process.version,
      contentionSettingsPath,
      staleSettingsPath,
      phaseCounts,
      exitedPid,
      contentionSettings: contentionSettingsPath && existsSync(contentionSettingsPath)
        ? readFileSync(contentionSettingsPath, "utf8").slice(0, 4_000)
        : "missing",
      staleRaceSettings: staleSettingsPath && existsSync(staleSettingsPath)
        ? readFileSync(staleSettingsPath, "utf8").slice(0, 4_000)
        : "missing",
      providerRequests: provider?.requestCount ?? 0,
      providerFaults: provider?.faults.slice(0, 8) ?? [],
      processes: processSnapshot(owners),
    },
  });
});
