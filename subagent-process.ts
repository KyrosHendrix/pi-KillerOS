import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export const SUBAGENT_PROCESS_LIMITS = {
  wallTimeMs: 600_000,
  jsonlLineBytes: 32 * 1024 * 1024,
  traceBytes: 2 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  outputBytes: 50 * 1024,
  quotaTokens: 1_000_000,
  quotaUsd: 10,
  killGraceMs: 5_000,
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
  usage: SubagentProcessUsage;
  model?: string;
  stopReason?: string;
  terminationReason?: string;
  errorMessage?: string;
  exitCode: number | null;
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
  /** Exact Pi arguments. Include `--mode json` and `--no-session`. */
  args: readonly string[];
  cwd: string;
  signal?: AbortSignal;
  limits?: Partial<SubagentProcessLimits>;
  onUpdate?: (result: Readonly<SubagentProcessResult>) => void;
  /** Test or embed hook. It receives the exact Pi arguments supplied above. */
  spawnProcess?: (args: string[], cwd: string) => SubagentProcessChild;
}

export interface SubagentProcessLimits {
  wallTimeMs: number;
  jsonlLineBytes: number;
  traceBytes: number;
  stderrBytes: number;
  outputBytes: number;
  quotaTokens: number;
  quotaUsd: number;
  killGraceMs: number;
}

export interface SubagentProcessHandle {
  readonly pid: number | undefined;
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

function traceMessage(message: any): string[] {
  if (!Array.isArray(message?.content)) return [];
  const entries: string[] = [];
  for (const part of message.content) {
    if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
    entries.push(`${part.name} ${truncateUtf8(JSON.stringify(part.arguments ?? {}), 2_000).text}`);
  }
  return entries;
}

function appendTrace(result: SubagentProcessResult, entries: string[], maxBytes: number): boolean {
  let truncated = false;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry, "utf8");
    const retained = truncateUtf8(entry, Math.max(0, maxBytes - result.traceBytes));
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

function normalizeLimits(overrides: Partial<SubagentProcessLimits> | undefined): SubagentProcessLimits {
  const limits = { ...SUBAGENT_PROCESS_LIMITS, ...overrides };
  for (const name of ["wallTimeMs", "jsonlLineBytes", "traceBytes", "stderrBytes", "outputBytes", "killGraceMs"] as const) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  for (const name of ["quotaTokens", "quotaUsd"] as const) {
    const value = limits[name];
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  }
  return limits;
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

function defaultSpawnProcess(args: string[], cwd: string): SubagentProcessChild {
  const invocation = getPiInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    detached: process.platform !== "win32",
    env: subagentProcessEnvironment(),
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
 * model, tools, prompt, and extension flags. This runner never applies a turn cap.
 */
export function runSubagentProcess(options: SubagentProcessOptions): SubagentProcessHandle {
  const args = [...options.args];
  if (!hasJsonMode(args)) throw new Error("Subagent Pi arguments must include --mode json");
  if (!args.includes("--no-session")) throw new Error("Subagent Pi arguments must include --no-session");
  const limits = normalizeLimits(options.limits);
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
    usage: emptyUsage(),
    exitCode: null,
    durationMs: 0,
  };
  let child: SubagentProcessChild | undefined;
  let closed = false;
  let finishing = false;
  let requestedStatus: Exclude<SubagentProcessStatus, "running" | "complete"> | undefined;
  let requestedReason: string | undefined;
  let stdoutLine = Buffer.alloc(0);
  let stdoutLineBytes = 0;
  let stderr = Buffer.alloc(0);
  let outputBytesSeen = 0;
  let forceTimer: NodeJS.Timeout | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let resolveResult!: (result: SubagentProcessResult) => void;
  const result = new Promise<SubagentProcessResult>((resolve) => { resolveResult = resolve; });

  const publish = (): void => options.onUpdate?.(cloneResult(state));
  const finish = (code: number | null): void => {
    if (closed || finishing) return;
    finishing = true;
    if (stdoutLineBytes && !requestedStatus) {
      const finalLine = stdoutLine.toString("utf8", 0, stdoutLineBytes);
      stdoutLine = Buffer.alloc(0);
      stdoutLineBytes = 0;
      processLine(finalLine);
    }
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
    } else if (code !== 0 || state.errorMessage || state.stopReason && state.stopReason !== "stop" && state.stopReason !== "toolUse") {
      state.status = "failed";
      state.terminationReason ??= code === null ? "process_closed" : `exit_${code}`;
    } else if (state.usage.turns === 0) {
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
      settleTimer = setTimeout(() => finish(null), 1_000);
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
      if (state.usage.totalTokens > limits.quotaTokens) {
        requestTermination("limited", "quota_tokens", `Child token usage exceeds ${limits.quotaTokens}`);
      } else if (state.usage.cost.total > limits.quotaUsd) {
        requestTermination("limited", "quota_cost", `Child cost exceeds $${limits.quotaUsd}`);
      }
      if (appendTrace(state, traceMessage(message), limits.traceBytes)) {
        requestTermination("limited", "trace_limit", `Retained child trace exceeds ${limits.traceBytes} bytes`);
      }
      const output = textContent(message);
      if (output) {
        const capped = truncateUtf8(output, limits.outputBytes);
        state.output = capped.text;
        state.outputTruncatedBytes = capped.omittedBytes;
        outputBytesSeen += Buffer.byteLength(output, "utf8");
        state.outputBytes = outputBytesSeen;
        state.outputTruncatedBytes = Math.max(state.outputTruncatedBytes, outputBytesSeen - limits.outputBytes);
        if (outputBytesSeen > limits.outputBytes) requestTermination("limited", "output_limit", `Child output exceeds ${limits.outputBytes} bytes`);
      }
      if (typeof message.model === "string") state.model = message.provider ? `${message.provider}/${message.model}` : message.model;
      if (typeof message.stopReason === "string") {
        state.stopReason = message.stopReason;
        if (message.stopReason === "stop" || message.stopReason === "toolUse") state.errorMessage = undefined;
        else state.terminationReason = message.stopReason;
      }
      if (typeof message.errorMessage === "string") state.errorMessage = message.errorMessage;
      if (message.stopReason === "length") requestTermination("limited", "model_output_limit");
      publish();
    } else if (event?.type === "tool_result_end" && event.message) {
      const name = typeof event.message.toolName === "string" ? event.message.toolName : "tool";
      if (appendTrace(state, [`${name} result${event.message.isError ? " (error)" : ""}`], limits.traceBytes)) {
        requestTermination("limited", "trace_limit", `Retained child trace exceeds ${limits.traceBytes} bytes`);
      }
      publish();
    }
  };
  const appendStdout = (fragment: Buffer): boolean => {
    const nextBytes = stdoutLineBytes + fragment.length;
    if (nextBytes > limits.jsonlLineBytes) {
      requestTermination("limited", "jsonl_line_limit", `Child JSONL line exceeds ${limits.jsonlLineBytes} bytes`);
      return false;
    }
    if (nextBytes > stdoutLine.length) {
      const nextCapacity = Math.min(limits.jsonlLineBytes, Math.max(nextBytes, stdoutLine.length * 2, 4_096));
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
      child = (options.spawnProcess ?? defaultSpawnProcess)(args, options.cwd);
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (requestedStatus) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < buffer.length && !requestedStatus) {
          const newline = buffer.indexOf(0x0a, offset);
          const end = newline < 0 ? buffer.length : newline;
          if (!appendStdout(buffer.subarray(offset, end))) return;
          if (newline < 0) return;
          const line = stdoutLine.toString("utf8", 0, stdoutLineBytes);
          stdoutLine = Buffer.alloc(0);
          stdoutLineBytes = 0;
          processLine(line);
          offset = newline + 1;
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = buffer.subarray(0, Math.max(0, limits.stderrBytes - stderr.length));
        if (retained.length) stderr = Buffer.concat([stderr, retained]);
        state.stderrTruncatedBytes += buffer.length - retained.length;
        if (buffer.length > retained.length) requestTermination("limited", "stderr_limit", `Child stderr exceeds ${limits.stderrBytes} bytes`);
      });
      child.on("error", (error) => requestTermination("failed", "spawn_error", error.message));
      child.once("close", finish);
      timeoutTimer = setTimeout(() => requestTermination("limited", "wall_time_limit"), limits.wallTimeMs);
      options.signal?.addEventListener("abort", abortHandler, { once: true });
      if (options.signal?.aborted) abortHandler();
    } catch (error) {
      requestTermination("failed", "spawn_error", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    get pid() { return child?.pid; },
    result,
    stop(reason = "stopped") { requestTermination("cancelled", reason); },
    snapshot: () => cloneResult(state),
  };
}
