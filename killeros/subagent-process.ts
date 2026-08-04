import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_NODE_TIMER_MS = 2_147_483_647;

export const SUBAGENT_PROCESS_LIMITS = {
  jsonlLineBytes: 8 * 1024 * 1024,
  killGraceMs: 5_000,
  processExitWaitMs: 10_000,
} as const;

export const SUBAGENT_PROCESS_RETENTION = {
  jsonlMemoryBytes: 1 * 1024 * 1024,
  traceBytes: 2 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  outputBytes: 1 * 1024 * 1024,
} as const;

export type SubagentProcessStatus = "running" | "complete" | "failed" | "cancelled" | "limited";

export interface SubagentProcessUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  turns: number;
}

export interface SubagentProcessResult {
  status: SubagentProcessStatus;
  args: string[];
  trace: string[];
  traceBytes: number;
  traceTruncatedBytes: number;
  stderr: string;
  stderrBytes: number;
  stderrTruncatedBytes: number;
  output: string;
  outputBytes: number;
  outputTruncatedBytes: number;
  toolCallCount: number;
  usage: SubagentProcessUsage;
  model?: string;
  stopReason?: string;
  terminationReason?: string;
  errorMessage?: string;
  exitCode: number | null;
  exitConfirmed: boolean;
  durationMs: number;
}

export interface SubagentProcessChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

export interface SubagentProcessOptions {
  /** Exact Pi arguments. Include `--mode json` and either `--no-session` or an isolated session id and directory. */
  args: readonly string[];
  cwd: string;
  signal?: AbortSignal;
  limits?: Partial<SubagentProcessLimits>;
  retention?: Partial<SubagentProcessRetention>;
  environment?: NodeJS.ProcessEnv;
  onUpdate?: (result: Readonly<SubagentProcessResult>) => void;
  /** Test or embed hook. It receives the exact Pi arguments supplied above. */
  spawnProcess?: (args: string[], cwd: string, environment?: NodeJS.ProcessEnv) => SubagentProcessChild;
}

export interface SubagentProcessLimits {
  wallTimeMs?: number;
  jsonlLineBytes?: number;
  traceBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  quotaTokens?: number;
  quotaUsd?: number;
  killGraceMs: number;
  processExitWaitMs?: number;
}

export interface SubagentProcessRetention {
  jsonlMemoryBytes: number;
  traceBytes: number;
  stderrBytes: number;
  outputBytes: number;
}

export interface SubagentProcessHandle {
  readonly pid: number | undefined;
  /** True after the child close event, or when no child was spawned. */
  readonly hasExited: boolean;
  /** Resolves after the child close event, or when no child was spawned. */
  readonly exited: Promise<void>;
  readonly result: Promise<SubagentProcessResult>;
  /** Stop this child and retain any work received before it exits. */
  stop(reason?: string): void;
  /** Return a copy suitable for lifecycle status reports. */
  snapshot(): SubagentProcessResult;
}

function emptyUsage(): SubagentProcessUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
}

function addUsage(target: SubagentProcessUsage, source: Partial<SubagentProcessUsage> | undefined): void {
  if (!source) return;
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  target.cost.input += source.cost?.input ?? 0;
  target.cost.output += source.cost?.output ?? 0;
  target.cost.cacheRead += source.cost?.cacheRead ?? 0;
  target.cost.cacheWrite += source.cost?.cacheWrite ?? 0;
  target.cost.total += source.cost?.total ?? 0;
}

function validUsage(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const number = usage[field];
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || number < 0)) return false;
  }
  if (usage.cost === undefined) return true;
  if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) return false;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const number = (usage.cost as Record<string, unknown>)[field];
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || number < 0)) return false;
  }
  return true;
}

function cloneResult(result: SubagentProcessResult): SubagentProcessResult {
  return {
    ...result,
    args: [...result.args],
    trace: [...result.trace],
    usage: { ...result.usage, cost: { ...result.usage.cost } },
  };
}

function truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 };
  let end = maxBytes;
  while (end > 0 && Buffer.byteLength(bytes.subarray(0, end).toString("utf8"), "utf8") !== end) end -= 1;
  const truncated = bytes.subarray(0, end).toString("utf8");
  return { text: truncated, omittedBytes: bytes.length - end };
}

function textContent(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function toolCallCount(message: any): number {
  if (!Array.isArray(message?.content)) return 0;
  return message.content.filter((part: any) => part?.type === "toolCall").length;
}

function traceMessage(message: any): string[] {
  if (!Array.isArray(message?.content)) return [];
  const entries: string[] = [];
  for (const part of message.content) {
    if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
    entries.push(`${part.name} ${truncateUtf8(JSON.stringify(part.arguments ?? {}), 2_000).text}`);
  }
  return entries;
}

function appendTrace(result: SubagentProcessResult, entries: string[], maxBytes: number | undefined): boolean {
  let truncated = false;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry, "utf8");
    const retained = truncateUtf8(entry, maxBytes === undefined ? entryBytes : Math.max(0, maxBytes - result.traceBytes));
    if (retained.text) result.trace.push(retained.text);
    result.traceBytes += Buffer.byteLength(retained.text, "utf8");
    result.traceTruncatedBytes += entryBytes - Buffer.byteLength(retained.text, "utf8");
    truncated ||= retained.omittedBytes > 0;
  }
  return truncated;
}

function hasJsonMode(args: readonly string[]): boolean {
  return args.some((arg, index) => arg === "--mode=json" || arg === "--mode" && args[index + 1] === "json");
}

function hasIsolatedSession(args: readonly string[]): boolean {
  const sessionId = args.indexOf("--session-id");
  const sessionDir = args.indexOf("--session-dir");
  return sessionId >= 0 && typeof args[sessionId + 1] === "string"
    && sessionDir >= 0 && typeof args[sessionDir + 1] === "string";
}

function normalizeLimits(overrides: Partial<SubagentProcessLimits> | undefined): SubagentProcessLimits {
  const limits = { ...SUBAGENT_PROCESS_LIMITS, ...overrides };
  for (const name of ["wallTimeMs", "jsonlLineBytes", "traceBytes", "stderrBytes", "outputBytes", "killGraceMs", "processExitWaitMs"] as const) {
    const value = limits[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0 || value > MAX_NODE_TIMER_MS
      && (name === "wallTimeMs" || name === "killGraceMs" || name === "processExitWaitMs"))) {
      const bound = name === "wallTimeMs" || name === "killGraceMs" || name === "processExitWaitMs" ? ` no greater than ${MAX_NODE_TIMER_MS}` : "";
      throw new RangeError(`${name} must be a positive safe integer${bound}`);
    }
  }
  for (const name of ["quotaTokens", "quotaUsd"] as const) {
    const value = limits[name];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError(`${name} must be a positive finite number`);
  }
  return limits;
}

function normalizeRetention(overrides: Partial<SubagentProcessRetention> | undefined): SubagentProcessRetention {
  const retention = { ...SUBAGENT_PROCESS_RETENTION, ...overrides };
  for (const name of ["jsonlMemoryBytes", "traceBytes", "stderrBytes", "outputBytes"] as const) {
    const value = retention[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  return retention;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    try {
      if (statSync(currentScript).isFile()) return { command: process.execPath, args: [currentScript, ...args] };
    } catch {
      // Use the installed Pi command when the current script is not a file.
    }
  }
  return /^(node|bun)(\.exe)?$/u.test(path.basename(process.execPath).toLocaleLowerCase())
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

/** Remove parent session identity so the child always starts an isolated session. */
export function subagentProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.PI_SESSION_FILE;
  delete childEnvironment.PI_SESSION_ID;
  return childEnvironment;
}

function defaultSpawnProcess(args: string[], cwd: string, environment?: NodeJS.ProcessEnv): SubagentProcessChild {
  const invocation = getPiInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    detached: process.platform !== "win32",
    env: subagentProcessEnvironment({ ...process.env, ...environment }),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as SubagentProcessChild;
}

function terminateProcess(child: SubagentProcessChild, force: boolean): void {
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
      // A custom child may not own a process group.
    }
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The child may have already exited.
  }
}

/**
 * Run one isolated Pi JSON process. The caller owns all Pi arguments, including
 * model, tools, prompt, and extension flags. Resource limits are opt-in.
 */
export function runSubagentProcess(options: SubagentProcessOptions): SubagentProcessHandle {
  const args = [...options.args];
  if (!hasJsonMode(args)) throw new Error("Subagent Pi arguments must include --mode json");
  if (!args.includes("--no-session") && !hasIsolatedSession(args)) {
    throw new Error("Subagent Pi arguments must include --no-session or an isolated --session-id and --session-dir");
  }
  const limits = normalizeLimits(options.limits);
  const retention = normalizeRetention(options.retention);
  const startedAt = Date.now();
  const state: SubagentProcessResult = {
    status: "running",
    args,
    trace: [],
    traceBytes: 0,
    traceTruncatedBytes: 0,
    stderr: "",
    stderrBytes: 0,
    stderrTruncatedBytes: 0,
    output: "",
    outputBytes: 0,
    outputTruncatedBytes: 0,
    toolCallCount: 0,
    usage: emptyUsage(),
    exitCode: null,
    exitConfirmed: false,
    durationMs: 0,
  };
  let child: SubagentProcessChild | undefined;
  let processExited = false;
  let closed = false;
  let finishing = false;
  let requestedStatus: Exclude<SubagentProcessStatus, "running" | "complete"> | undefined;
  let requestedReason: string | undefined;
  let stdoutLine = Buffer.alloc(0);
  let stdoutLineBytes = 0;
  let stdoutLineSpoolDirectory: string | undefined;
  let stdoutLineSpoolDescriptor: number | undefined;
  let stderr = Buffer.alloc(0);
  let outputBytesSeen = 0;
  let forceTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let hasUsableAssistantResponse = false;
  let resolveResult!: (result: SubagentProcessResult) => void;
  let resolveExited!: () => void;
  const result = new Promise<SubagentProcessResult>((resolve) => { resolveResult = resolve; });
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  const markExited = (): void => {
    if (processExited) return;
    processExited = true;
    resolveExited();
  };

  const clearStdoutLine = (): void => {
    if (stdoutLineSpoolDescriptor !== undefined) {
      try {
        closeSync(stdoutLineSpoolDescriptor);
      } catch (error) {
        state.errorMessage ??= `Could not close child JSONL spool: ${error instanceof Error ? error.message : String(error)}`;
      }
      stdoutLineSpoolDescriptor = undefined;
    }
    if (stdoutLineSpoolDirectory) {
      try {
        rmSync(stdoutLineSpoolDirectory, { recursive: true, force: true });
      } catch (error) {
        state.errorMessage ??= `Could not remove child JSONL spool: ${error instanceof Error ? error.message : String(error)}`;
      }
      stdoutLineSpoolDirectory = undefined;
    }
    stdoutLine = Buffer.alloc(0);
    stdoutLineBytes = 0;
  };
  const readStdoutLine = (): string => {
    if (stdoutLineSpoolDirectory) {
      const filePath = path.join(stdoutLineSpoolDirectory, "line.jsonl");
      try {
        if (stdoutLineSpoolDescriptor !== undefined) {
          closeSync(stdoutLineSpoolDescriptor);
          stdoutLineSpoolDescriptor = undefined;
        }
        return readFileSync(filePath, "utf8");
      } catch (error) {
        state.errorMessage ??= `Could not read child JSONL spool: ${error instanceof Error ? error.message : String(error)}`;
        return "";
      } finally {
        clearStdoutLine();
      }
    }
    const line = stdoutLine.toString("utf8", 0, stdoutLineBytes);
    clearStdoutLine();
    return line;
  };

  const publish = (): void => {
    if (!options.onUpdate) return;
    try {
      options.onUpdate(cloneResult(state));
    } catch {
      // Update callbacks are best-effort telemetry: a throwing callback must
      // neither escape into the host event loop nor strand the result promise.
    }
  };
  const finish = (code: number | null): void => {
    if (closed || finishing) return;
    finishing = true;
    if (!child || processExited) markExited();
    if (stdoutLineBytes && !requestedStatus) processLine(readStdoutLine());
    else clearStdoutLine();
    closed = true;
    if (forceTimer) clearTimeout(forceTimer);
    if (settleTimer) clearTimeout(settleTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    options.signal?.removeEventListener("abort", abortHandler);
    state.stderr = stderr.toString("utf8");
    state.stderrBytes = stderr.length + state.stderrTruncatedBytes;
    state.exitCode = code;
    if (requestedStatus) {
      state.status = requestedStatus;
      state.terminationReason = requestedReason;
    } else if (code !== 0 || state.errorMessage || state.stopReason === "error" || state.stopReason === "aborted") {
      state.status = state.stopReason === "aborted" ? "cancelled" : "failed";
      state.terminationReason ??= code === null ? "process_closed" : `exit_${code}`;
    } else if (state.stopReason !== undefined && !["stop", "length", "toolUse"].includes(state.stopReason)) {
      state.status = "failed";
      state.terminationReason = state.stopReason;
    } else if (!hasUsableAssistantResponse) {
      state.status = "failed";
      state.terminationReason = "missing_assistant_message";
      state.errorMessage = "Child exited without an assistant response";
    } else {
      state.status = "complete";
      state.terminationReason = "completed";
    }
    if (!state.output && state.stderr && state.status !== "complete") state.errorMessage ??= state.stderr.trim();
    state.durationMs = Date.now() - startedAt;
    publish();
    resolveResult(cloneResult(state));
  };
  const requestTermination = (status: Exclude<SubagentProcessStatus, "running" | "complete">, reason: string, errorMessage?: string): void => {
    if (requestedStatus || closed) return;
    requestedStatus = status;
    requestedReason = reason;
    if (errorMessage) state.errorMessage = errorMessage;
    if (!child) {
      finish(null);
      return;
    }
    terminateProcess(child, false);
    forceTimer = setTimeout(() => {
      if (closed || !child) return;
      terminateProcess(child, true);
      settleTimer = setTimeout(() => finish(null), limits.processExitWaitMs ?? 1_000);
    }, limits.killGraceMs);
  };
  const processLine = (line: string): void => {
    if (!line.trim() || requestedStatus) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      requestTermination("failed", "malformed_jsonl", `Malformed child JSONL: ${message}`);
      return;
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (!validUsage(message.usage)) {
        requestTermination("failed", "invalid_usage", "Child assistant usage must contain non-negative numbers");
        return;
      }
      state.usage.turns += 1;
      addUsage(state.usage, { ...message.usage, turns: 0 });
      state.toolCallCount += toolCallCount(message);
      if (limits.quotaTokens !== undefined && state.usage.totalTokens > limits.quotaTokens) {
        requestTermination("limited", "quota_tokens", `Child token usage exceeds ${limits.quotaTokens}`);
      } else if (limits.quotaUsd !== undefined && state.usage.cost.total > limits.quotaUsd) {
        requestTermination("limited", "quota_cost", `Child cost exceeds $${limits.quotaUsd}`);
      }
      const traceTruncatedBefore = state.traceTruncatedBytes;
      appendTrace(state, traceMessage(message), Math.min(retention.traceBytes, limits.traceBytes ?? retention.traceBytes));
      if (limits.traceBytes !== undefined && state.traceTruncatedBytes > traceTruncatedBefore && state.traceBytes >= limits.traceBytes) {
        requestTermination("limited", "trace_limit", `Retained child trace exceeds ${limits.traceBytes} bytes`);
      }
      const output = textContent(message);
      if (output) {
        const outputLimit = Math.min(retention.outputBytes, limits.outputBytes ?? retention.outputBytes);
        const capped = truncateUtf8(output, outputLimit);
        state.output = capped.text;
        state.outputTruncatedBytes = capped.omittedBytes;
        outputBytesSeen += Buffer.byteLength(output, "utf8");
        state.outputBytes = outputBytesSeen;
        state.outputTruncatedBytes = Math.max(state.outputTruncatedBytes, outputBytesSeen - (limits.outputBytes ?? retention.outputBytes));
        if (limits.outputBytes !== undefined && outputBytesSeen > limits.outputBytes) requestTermination("limited", "output_limit", `Child output exceeds ${limits.outputBytes} bytes`);
      }
      if (typeof message.model === "string") state.model = message.provider ? `${message.provider}/${message.model}` : message.model;
      if (typeof message.stopReason === "string") {
        state.stopReason = message.stopReason;
        if (message.stopReason === "stop" || message.stopReason === "toolUse") state.errorMessage = undefined;
        else state.terminationReason = message.stopReason;
        if (output.trim() && (message.stopReason === "stop" || message.stopReason === "length")) {
          hasUsableAssistantResponse = true;
        }
      }
      if (typeof message.errorMessage === "string") state.errorMessage = message.errorMessage;
      publish();
    } else if (event?.type === "tool_result_end" && event.message) {
      const name = typeof event.message.toolName === "string" ? event.message.toolName : "tool";
      const traceTruncatedBefore = state.traceTruncatedBytes;
      appendTrace(state, [`${name} result${event.message.isError ? " (error)" : ""}`], Math.min(retention.traceBytes, limits.traceBytes ?? retention.traceBytes));
      if (limits.traceBytes !== undefined && state.traceTruncatedBytes > traceTruncatedBefore && state.traceBytes >= limits.traceBytes) {
        requestTermination("limited", "trace_limit", `Retained child trace exceeds ${limits.traceBytes} bytes`);
      }
      publish();
    }
  };
  const appendStdout = (fragment: Buffer): boolean => {
    const nextBytes = stdoutLineBytes + fragment.length;
    if (limits.jsonlLineBytes !== undefined && nextBytes > limits.jsonlLineBytes) {
      requestTermination("limited", "jsonl_line_limit", `Child JSONL line exceeds ${limits.jsonlLineBytes} bytes`);
      return false;
    }
    if (nextBytes > retention.jsonlMemoryBytes) {
      try {
        if (stdoutLineSpoolDescriptor === undefined) {
          stdoutLineSpoolDirectory = mkdtempSync(path.join(os.tmpdir(), "killeros-jsonl-"));
          stdoutLineSpoolDescriptor = openSync(path.join(stdoutLineSpoolDirectory, "line.jsonl"), "w");
          if (stdoutLineBytes) writeSync(stdoutLineSpoolDescriptor, stdoutLine);
          stdoutLine = Buffer.alloc(0);
        }
        if (fragment.length) writeSync(stdoutLineSpoolDescriptor, fragment);
      } catch (error) {
        requestTermination("failed", "jsonl_spool_error", `Could not spool child JSONL: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
      stdoutLineBytes = nextBytes;
      return true;
    }
    if (nextBytes > stdoutLine.length) {
      const nextCapacity = limits.jsonlLineBytes === undefined
        ? Math.max(nextBytes, stdoutLine.length * 2, 4_096)
        : Math.min(limits.jsonlLineBytes, Math.max(nextBytes, stdoutLine.length * 2, 4_096));
      const expanded = Buffer.allocUnsafe(nextCapacity);
      stdoutLine.copy(expanded, 0, 0, stdoutLineBytes);
      stdoutLine = expanded;
    }
    fragment.copy(stdoutLine, stdoutLineBytes);
    stdoutLineBytes = nextBytes;
    return true;
  };
  const abortHandler = (): void => requestTermination("cancelled", "abort");

  publish();
  if (options.signal?.aborted) {
    abortHandler();
  } else {
    try {
      child = options.spawnProcess
        ? options.spawnProcess(args, options.cwd, options.environment)
        : defaultSpawnProcess(args, options.cwd, options.environment);
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (requestedStatus) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length && !requestedStatus) {
          const newline = buffer.indexOf(0x0a, offset);
          const end = newline < 0 ? buffer.length : newline;
          if (!appendStdout(buffer.subarray(offset, end))) return;
          if (newline < 0) return;
          processLine(readStdoutLine());
          offset = newline + 1;
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const stderrLimit = Math.min(retention.stderrBytes, limits.stderrBytes ?? retention.stderrBytes);
        const retained = buffer.subarray(0, Math.max(0, stderrLimit - stderr.length));
        if (retained.length) stderr = Buffer.concat([stderr, retained]);
        state.stderrTruncatedBytes += buffer.length - retained.length;
        if (limits.stderrBytes !== undefined && stderr.length + state.stderrTruncatedBytes > limits.stderrBytes) {
          requestTermination("limited", "stderr_limit", `Child stderr exceeds ${limits.stderrBytes} bytes`);
        }
      });
      child.on("error", (error) => requestTermination("failed", "spawn_error", error.message));
      child.once("close", (code) => {
        state.exitConfirmed = true;
        markExited();
        finish(code);
      });
      if (limits.wallTimeMs !== undefined) timeoutTimer = setTimeout(() => requestTermination("limited", "wall_time_limit"), limits.wallTimeMs);
      options.signal?.addEventListener("abort", abortHandler, { once: true });
      if (options.signal?.aborted) abortHandler();
    } catch (error) {
      requestTermination("failed", "spawn_error", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    get pid() { return child?.pid; },
    get hasExited() { return processExited; },
    exited,
    result,
    stop(reason = "stopped") { requestTermination("cancelled", reason); },
    snapshot: () => cloneResult(state),
  };
}
