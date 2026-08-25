import {
  spawn,
  type SpawnOptionsWithStdioTuple,
} from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorMessage, reportError } from "./errors.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

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
const HOOK_CONFIG_LIMIT = 64 * 1024;
const HOOK_OUTPUT_LIMIT = 16 * 1024;
const HOOK_PAYLOAD_LIMIT = 8_000;
const HOOK_TIMEOUT_MAX_MS = 300_000;

// Reads executable project configuration through a bounded, project-local file descriptor.
function readHookConfig(configPath: string, projectRoot: string): string {
  const actualPath = realpathSync(configPath);
  const expectedPath = path.join(realpathSync(projectRoot), CONFIG_DIR_NAME, "killeros-hooks.json");
  const samePath = process.platform === "win32"
    ? actualPath.toLowerCase() === expectedPath.toLowerCase()
    : actualPath === expectedPath;
  if (!samePath) {
    throw new Error("Hook config must be stored in the real project .pi directory");
  }

  const linkedFile = lstatSync(configPath);
  if (!linkedFile.isFile() || linkedFile.nlink !== 1) {
    throw new Error("Hook config must be a regular, non-linked file");
  }
  if (linkedFile.size > HOOK_CONFIG_LIMIT) {
    throw new Error(`Hook config exceeds ${HOOK_CONFIG_LIMIT} bytes`);
  }

  const descriptor = openSync(configPath, "r");
  try {
    const openedFile = fstatSync(descriptor);
    if (!openedFile.isFile() || openedFile.nlink !== 1) {
      throw new Error("Hook config must be a regular, non-linked file");
    }
    if (openedFile.dev !== linkedFile.dev || openedFile.ino !== linkedFile.ino) {
      throw new Error("Hook config changed while being opened");
    }

    const contents = Buffer.alloc(HOOK_CONFIG_LIMIT + 1);
    let bytesRead = 0;
    while (bytesRead < contents.length) {
      const count = readSync(descriptor, contents, bytesRead, contents.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > HOOK_CONFIG_LIMIT) {
      throw new Error(`Hook config exceeds ${HOOK_CONFIG_LIMIT} bytes`);
    }
    return contents.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadKillerosHooks(ctx: ExtensionContext): KillerosHookConfig {
  const configPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "killeros-hooks.json");
  if (!existsSync(configPath)) return {};
  const displayPath = safeTerminalText(configPath).replaceAll("\n", "");
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(`Ignored untrusted project hooks in ${displayPath}`, "warning");
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(readHookConfig(configPath, ctx.cwd));
    if (!isUnknownRecord(parsed)) throw new Error("Hook config must contain a JSON object");
    const parsedHooks = parsed.hooks;
    if (parsedHooks !== undefined && !isUnknownRecord(parsedHooks)) {
      throw new Error("Hook config hooks must contain a JSON object");
    }

    const hooks: KillerosHookConfig["hooks"] = {};
    for (const event of HOOK_EVENTS) {
      const candidates = parsedHooks?.[event];
      if (!Array.isArray(candidates)) continue;
      const accepted: KillerosHook[] = [];
      for (const [index, candidate] of candidates.entries()) {
        if (!isUnknownRecord(candidate)) {
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
    reportError(ctx, `Invalid ${CONFIG_DIR_NAME}/killeros-hooks.json`, error);
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

function terminateHookProcess(child: HookChildProcess, force: boolean): void {
  if (process.platform === "win32" && force && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // Fall back to the shell itself when a custom child has no process group.
    }
  }
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
    timeoutMs = 30_000,
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
      detached: process.platform !== "win32",
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
      terminateHookProcess(child, false);
      forceTimer = setTimeout(() => {
        if (completed) return;
        terminateHookProcess(child, true);
        settleTimer = setTimeout(() => finish(terminationCode(), true), 1_000);
      }, 1_000);
    };
    const abort = (): void => beginTermination("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) beginTermination("cancelled");
    child.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    child.on("error", (error) => {
      appendBounded(stderr, error.message);
      finish(termination ? terminationCode() : 1);
    });
    child.once("close", (code) => finish(termination ? terminationCode() : code ?? 1));
    timer = setTimeout(() => beginTermination("timeout"), Math.max(1, Math.min(timeoutMs, HOOK_TIMEOUT_MAX_MS)));
  });
}

function serializeHookPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload) ?? "null";
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

export function registerLifecycleHooks(pi: ExtensionAPI): void {
  let config: KillerosHookConfig = {};
  pi.on("session_start", (_event, ctx) => { config = loadKillerosHooks(ctx); });

  pi.on("tool_call", async (event, ctx) => {
    for (const hook of config.hooks?.tool_call ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await executeHook({
        command: hook.command,
        cwd: ctx.cwd,
        environment: hookEnvironment("tool_call", event.toolName, event.input),
        timeoutMs: hook.timeoutMs,
        spawnProcess: spawn,
        signal: ctx.signal,
      });
      if (result.cancelled) return { block: true, reason: "Hook cancelled because the parent request was aborted" };
      if (result.code !== 0) {
        const reason = hookFailureMessage(result);
        ctx.ui.notify(reason, "error");
        return { block: true, reason };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    for (const hook of config.hooks?.tool_result ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await executeHook({
        command: hook.command,
        cwd: ctx.cwd,
        environment: hookEnvironment("tool_result", event.toolName, {
          input: event.input,
          isError: event.isError,
        }),
        timeoutMs: hook.timeoutMs,
        spawnProcess: spawn,
        signal: ctx.signal,
      });
      if (result.cancelled) break;
      if (result.code !== 0) ctx.ui.notify(hookFailureMessage(result), "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    for (const hook of config.hooks?.agent_settled ?? []) {
      const result = await executeHook({
        command: hook.command,
        cwd: ctx.cwd,
        environment: hookEnvironment("agent_settled"),
        timeoutMs: hook.timeoutMs,
        spawnProcess: spawn,
        signal: ctx.signal,
      });
      if (result.cancelled) break;
      if (result.code !== 0) ctx.ui.notify(hookFailureMessage(result), "error");
    }
  });
}
