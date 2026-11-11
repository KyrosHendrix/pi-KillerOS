import {
  spawn,
  type SpawnOptionsWithStdioTuple,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, reportError } from "./errors.ts";
import { readUnlinkedFile, UnstableFileError } from "./file-identity.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";
import { isRecord } from "./guards.ts";

type KillerosHookEvent = "tool_call" | "tool_result" | "agent_settled";

interface KillerosHook {
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

interface KillerosHookConfig {
  hooks?: Partial<Record<KillerosHookEvent, KillerosHook[]>>;
}

interface HookExecutionResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  exitUnconfirmed: boolean;
}

interface HookOutputStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

interface HookChildProcess {
  readonly pid?: number;
  readonly stdout: HookOutputStream;
  readonly stderr: HookOutputStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}
type HookSpawnOptions = SpawnOptionsWithStdioTuple<"ignore", "pipe", "pipe">;
export type HookSpawnProcess = (command: string, options: HookSpawnOptions) => HookChildProcess;

export interface ExecuteHookOptions {
  command: string;
  cwd: string;
  environment: Record<string, string>;
  timeoutMs?: number;
  spawnProcess?: HookSpawnProcess;
  signal?: AbortSignal;
}

const HOOK_EVENTS: readonly KillerosHookEvent[] = ["tool_call", "tool_result", "agent_settled"];
const HOOK_CONFIG_FILE = "killeros-hooks.json";
const HOOK_CONFIG_LIMIT = 64 * 1024;
const HOOK_OUTPUT_LIMIT = 16 * 1024;
const HOOK_PAYLOAD_LIMIT = 8_000;
const HOOK_TIMEOUT_DEFAULT_MS = 30_000;
const HOOK_TIMEOUT_MAX_MS = 300_000;

// Reads executable project configuration through a bounded, project-local file descriptor.
function readHookConfig(configPath: string, projectRoot: string): string {
  const actualPath = realpathSync(configPath);
  const expectedPath = path.join(realpathSync(projectRoot), CONFIG_DIR_NAME, HOOK_CONFIG_FILE);
  const samePath = actualPath.toLowerCase() === expectedPath.toLowerCase();
  if (!samePath) {
    throw new Error("Hook config must be stored in the real project .pi directory");
  }

  let read: ReturnType<typeof readUnlinkedFile>;
  try {
    read = readUnlinkedFile(configPath, HOOK_CONFIG_LIMIT);
  } catch (error) {
    if (!(error instanceof UnstableFileError)) throw error;
    throw new Error(error.reason === "changed" ? "Hook config changed while being opened" : "Hook config must be a regular, non-linked file");
  }
  if (read.truncated) throw new Error(`Hook config exceeds ${HOOK_CONFIG_LIMIT} bytes`);
  return read.content.toString("utf8");
}

function loadKillerosConfig(ctx: ExtensionContext): KillerosHookConfig {
  const configPath = path.join(ctx.cwd, CONFIG_DIR_NAME, HOOK_CONFIG_FILE);
  if (!existsSync(configPath)) return {};
  const displayPath = safeTerminalText(configPath).replaceAll("\n", "");
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(`Ignored untrusted project hooks in ${displayPath}`, "warning");
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(readHookConfig(configPath, ctx.cwd));
    if (!isRecord(parsed)) throw new Error("Hook config must contain a JSON object");
    const parsedHooks = parsed.hooks;
    if (parsedHooks !== undefined && !isRecord(parsedHooks)) {
      throw new Error("Hook config hooks must contain a JSON object");
    }

    const hooks: KillerosHookConfig["hooks"] = {};
    for (const event of HOOK_EVENTS) {
      const candidates = parsedHooks?.[event];
      if (!Array.isArray(candidates)) continue;
      const accepted: KillerosHook[] = [];
      for (const [index, candidate] of candidates.entries()) {
        if (!isRecord(candidate)) {
          ctx.ui.notify(`Ignored invalid ${event} hook ${index + 1} in ${displayPath}`, "warning");
          continue;
        }
        const { command, matcher, timeoutMs } = candidate;
        if (event === "agent_settled" && matcher !== undefined) {
          ctx.ui.notify(`Ignored ${event} hook ${index + 1}: matchers are only valid for tool events`, "warning");
          continue;
        }
        if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > HOOK_TIMEOUT_MAX_MS)) {
          ctx.ui.notify(`Ignored ${event} hook ${index + 1}: timeoutMs must be an integer from 1 to ${HOOK_TIMEOUT_MAX_MS}`, "warning");
          continue;
        }
        if (typeof command !== "string" || command.trim().length === 0
          || matcher !== undefined && typeof matcher !== "string") {
          ctx.ui.notify(`Ignored invalid ${event} hook ${index + 1} in ${displayPath}`, "warning");
          continue;
        }
        if (matcher && matcher !== "*") {
          try {
            new RegExp(matcher, "u");
          } catch {
            ctx.ui.notify(`Ignored ${event} hook ${index + 1}: invalid matcher ${JSON.stringify(matcher)}`, "warning");
            continue;
          }
        }
        accepted.push({
          command,
          ...(matcher === undefined ? {} : { matcher }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
      }
      hooks[event] = accepted;
    }

    return { hooks };
  } catch (error) {
    reportError(ctx, `Invalid ${CONFIG_DIR_NAME}/${HOOK_CONFIG_FILE}`, error);
    return {};
  }
}

function matchesHook(hook: KillerosHook, value: string): boolean {
  if (!hook.matcher || hook.matcher === "*") return true;
  try {
    return new RegExp(hook.matcher, "u").test(value);
  } catch {
    return false;
  }
}

interface HookOutputBuffer {
  bytes: number;
  decoder: StringDecoder;
  text: string;
}

function appendBounded(output: HookOutputBuffer, chunk: Buffer | string): void {
  const remaining = HOOK_OUTPUT_LIMIT - output.bytes;
  if (remaining <= 0) return;
  const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  const captured = bytes.subarray(0, remaining);
  output.bytes += captured.length;
  output.text += output.decoder.write(captured);
}

/** Terminates a Windows hook tree without depending on the caller's PATH. */
function terminateWindowsHookTree(child: HookChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const taskkill = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "taskkill.exe")
        : "taskkill";
      const killer = spawn(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve(false));
      killer.once("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function terminateHookProcess(child: HookChildProcess, force: boolean): void {
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The hook may have already exited.
  }
}

export function executeHook(options: ExecuteHookOptions): Promise<HookExecutionResult>;
/** @deprecated Use the object-argument form. The positional adapter will be removed in the next major release. */
export function executeHook(
  command: string,
  cwd: string,
  environment: Record<string, string>,
  timeoutMs?: number,
  spawnProcess?: HookSpawnProcess,
  signal?: AbortSignal,
): Promise<HookExecutionResult>;
export function executeHook(
  optionsOrCommand: ExecuteHookOptions | string,
  legacyCwd?: string,
  legacyEnvironment?: Record<string, string>,
  legacyTimeoutMs?: number,
  legacySpawnProcess?: HookSpawnProcess,
  legacySignal?: AbortSignal,
): Promise<HookExecutionResult> {
  const options: ExecuteHookOptions = typeof optionsOrCommand === "string"
    ? {
        command: optionsOrCommand,
        cwd: legacyCwd ?? process.cwd(),
        environment: legacyEnvironment ?? {},
        ...(legacyTimeoutMs === undefined ? {} : { timeoutMs: legacyTimeoutMs }),
        ...(legacySpawnProcess === undefined ? {} : { spawnProcess: legacySpawnProcess }),
        ...(legacySignal === undefined ? {} : { signal: legacySignal }),
      }
    : optionsOrCommand;
  const {
    command,
    cwd,
    environment,
    timeoutMs = HOOK_TIMEOUT_DEFAULT_MS,
    spawnProcess = spawn,
    signal,
  } = options;
  if (signal?.aborted) {
    return Promise.resolve({ code: 130, stdout: "", stderr: "", timedOut: false, cancelled: true, exitUnconfirmed: false });
  }
  let child: HookChildProcess;
  try {
    child = spawnProcess(command, {
      cwd,
      env: { ...process.env, ...environment },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({ code: 1, stdout: "", stderr: errorMessage(error), timedOut: false, cancelled: false, exitUnconfirmed: false });
  }
  return new Promise((resolve) => {
    const stdout: HookOutputBuffer = { bytes: 0, decoder: new StringDecoder("utf8"), text: "" };
    const stderr: HookOutputBuffer = { bytes: 0, decoder: new StringDecoder("utf8"), text: "" };
    let completed = false;
    let termination: "timeout" | "cancelled" | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let windowsCleanupPending = false;
    const finish = (code: number, exitUnconfirmed = false): void => {
      if (completed) return;
      completed = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", abort);
      stdout.text += stdout.decoder.end();
      stderr.text += stderr.decoder.end();
      resolve({
        code,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut: termination === "timeout",
        cancelled: termination === "cancelled",
        exitUnconfirmed,
      });
    };
    const terminationCode = (): number => termination === "cancelled" ? 130 : 124;
    const beginTermination = (reason: "timeout" | "cancelled"): void => {
      if (completed || termination) return;
      termination = reason;
      if (child.pid) {
        windowsCleanupPending = true;
        void terminateWindowsHookTree(child).then((confirmed) => {
          if (completed) return;
          if (!confirmed) terminateHookProcess(child, true);
          finish(terminationCode(), !confirmed);
          windowsCleanupPending = false;
        });
        settleTimer = setTimeout(() => {
          terminateHookProcess(child, true);
          finish(terminationCode(), true);
          windowsCleanupPending = false;
        }, 2_000);
        return;
      }
      forceTimer = setTimeout(() => {
        if (completed) return;
        terminateHookProcess(child, true);
        if (completed) return;
        settleTimer = setTimeout(() => {
          finish(terminationCode(), true);
        }, 1_000);
      }, 1_000);
      terminateHookProcess(child, false);
    };
    const abort = (): void => beginTermination("cancelled");
    child.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    const captureStreamError = (error: Error): void => appendBounded(stderr, error.message);
    if (child.stdout instanceof EventEmitter) child.stdout.on("error", captureStreamError);
    if (child.stderr instanceof EventEmitter) child.stderr.on("error", captureStreamError);
    child.on("error", (error) => {
      appendBounded(stderr, error.message);
      if (!windowsCleanupPending) finish(termination ? terminationCode() : 1);
    });
    child.once("close", (code) => {
      if (!windowsCleanupPending) {
        finish(termination ? terminationCode() : code ?? 1);
      }
    });
    if (completed) return;
    const boundedTimeoutMs = Number.isNaN(timeoutMs)
      ? HOOK_TIMEOUT_DEFAULT_MS
      : Math.max(1, Math.min(timeoutMs, HOOK_TIMEOUT_MAX_MS));
    timer = setTimeout(() => beginTermination("timeout"), boundedTimeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) beginTermination("cancelled");
  });
}

function serializeHookPayload(payload: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? "null";
  } catch {
    return JSON.stringify({ serializationError: true });
  }
  if (serialized.length <= HOOK_PAYLOAD_LIMIT) return serialized;
  const previewLength = Math.floor((HOOK_PAYLOAD_LIMIT - 64) / 2);
  return JSON.stringify({ truncated: true, preview: serialized.slice(0, previewLength) });
}

function hookEnvironment(event: KillerosHookEvent, toolName = "", payload: unknown = {}): Record<string, string> {
  return {
    KILLEROS_EVENT: event,
    KILLEROS_TOOL: toolName,
    KILLEROS_PAYLOAD: serializeHookPayload(payload),
  };
}

function hookFailureMessage(result: HookExecutionResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return safeTerminalText(`Hook failed${result.timedOut ? " (timed out)" : ""}${result.exitUnconfirmed ? " (process exit unconfirmed)" : ""}\n${detail}`);
}

function runHook(hook: KillerosHook, ctx: ExtensionContext, environment: Record<string, string>): Promise<HookExecutionResult> {
  return executeHook({ command: hook.command, cwd: ctx.cwd, environment, timeoutMs: hook.timeoutMs, signal: ctx.signal });
}

/** Runs hooks that observe an event: failures are reported, and cancellation of the parent request stops the rest. */
async function runObserverHooks(hooks: readonly KillerosHook[], ctx: ExtensionContext, environment: Record<string, string>): Promise<void> {
  for (const hook of hooks) {
    const result = await runHook(hook, ctx, environment);
    if (result.cancelled) break;
    if (result.code !== 0) ctx.ui.notify(hookFailureMessage(result), "error");
  }
}

export function registerLifecycleHooks(pi: ExtensionAPI): void {
  let config: KillerosHookConfig = {};
  pi.on("session_start", (_event, ctx) => { config = loadKillerosConfig(ctx); });

  pi.on("tool_call", async (event, ctx) => {
    for (const hook of config.hooks?.tool_call ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await runHook(hook, ctx, hookEnvironment("tool_call", event.toolName, event.input));
      if (result.cancelled) return { block: true, reason: "Hook cancelled because the parent request was aborted" };
      if (result.code !== 0) {
        const reason = hookFailureMessage(result);
        ctx.ui.notify(reason, "error");
        return { block: true, reason };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const hooks = (config.hooks?.tool_result ?? []).filter((hook) => matchesHook(hook, event.toolName));
    if (hooks.length === 0) return;
    await runObserverHooks(hooks, ctx, hookEnvironment("tool_result", event.toolName, { input: event.input, isError: event.isError }));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const hooks = config.hooks?.agent_settled ?? [];
    if (hooks.length > 0) await runObserverHooks(hooks, ctx, hookEnvironment("agent_settled"));
  });
}
