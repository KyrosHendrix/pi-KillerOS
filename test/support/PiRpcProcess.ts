import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export type PiRpcRecord = Record<string, unknown>;

type StoredRecord = { sequence: number; value: PiRpcRecord };
type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };
type RpcWaiter = {
  after: number;
  predicate: (record: PiRpcRecord) => boolean;
  resolve: (record: PiRpcRecord) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
};

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDS = 256;
const MAX_DIAGNOSTIC_CHARS = 32 * 1024;

function isRecord(value: unknown): value is PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns one Pi CLI RPC child and bounds protocol input, waits, diagnostics, and shutdown. */
export class PiRpcProcess {
  private readonly child: ChildProcess;
  private readonly decoder = new StringDecoder("utf8");
  private readonly records: StoredRecord[] = [];
  private readonly waiters = new Set<RpcWaiter>();
  private readonly closed: Promise<ProcessExit>;
  private stdoutBuffer = "";
  private stderr = "";
  private sequence = 0;
  private nextCommandId = 0;
  private failure: Error | undefined;
  private exit: ProcessExit | undefined;
  private closePromise: Promise<{ exit: ProcessExit; forced: boolean; treeCleanupError?: string }> | undefined;

  constructor(options: { cliPath: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(process.execPath, [options.cliPath, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = this.child.stdout;
    const stderr = this.child.stderr;
    if (!stdout || !stderr || !this.child.stdin) throw new Error("Pi RPC process did not expose piped stdio");

    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exit = { code, signal };
        this.rejectWaiters(new Error(`Pi CLI exited (${code ?? "unknown"}/${signal ?? "no signal"})`));
        resolve(this.exit);
      });
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error: Error) => this.fail(error));
    stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
  }

  get currentSequence(): number {
    return this.sequence;
  }

  diagnostics(): string {
    const records = this.records.slice(-32).map(({ sequence, value }) => ({
      sequence,
      record: JSON.stringify(value).slice(0, 2_000),
    }));
    return JSON.stringify({
      pid: this.child.pid,
      exit: this.exit,
      failure: this.failure?.message,
      stderr: this.stderr,
      recentRecords: records,
    }, null, 2).slice(-MAX_DIAGNOSTIC_CHARS);
  }

  async send(value: PiRpcRecord): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || this.exit) throw new Error(`Pi RPC stdin is closed: ${this.diagnostics()}`);
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async command(
    type: string,
    fields: PiRpcRecord = {},
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PiRpcRecord> {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Pi CLI command was cancelled");
    const id = `killeros-cli-${++this.nextCommandId}`;
    const after = this.sequence;
    await this.send({ ...fields, id, type });
    const response = await this.waitFor(
      (record) => record.type === "response" && record.id === id,
      { after, timeoutMs: options.timeoutMs ?? 15_000, signal: options.signal },
    );
    if (response.success !== true) {
      const description = typeof response.error === "string"
        ? response.error
        : response.error === undefined
          ? "unknown error"
          : JSON.stringify(response.error) ?? "<unserializable error>";
      throw new Error(`Pi RPC ${type} failed: ${description}\n${this.diagnostics()}`);
    }
    return response;
  }

  async waitFor(
    predicate: (record: PiRpcRecord) => boolean,
    options: { after?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<PiRpcRecord> {
    if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Pi CLI wait was cancelled");
    const after = options.after ?? 0;
    for (const stored of this.records) {
      if (stored.sequence > after && predicate(stored.value)) return stored.value;
    }
    if (this.failure) throw new Error(`${this.failure.message}\n${this.diagnostics()}`, { cause: this.failure });
    if (this.exit) throw new Error(`Pi CLI exited before the expected RPC record\n${this.diagnostics()}`);

    return await new Promise<PiRpcRecord>((resolve, reject) => {
      const waiter: RpcWaiter = {
        after,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`Timed out waiting for a Pi RPC record after ${options.timeoutMs ?? 15_000}ms\n${this.diagnostics()}`));
        }, options.timeoutMs ?? 15_000),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      if (options.signal) {
        waiter.abort = () => {
          this.removeWaiter(waiter);
          reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Pi CLI wait was cancelled"));
        };
        options.signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  async close(timeoutMs = 5_000): Promise<{ exit: ProcessExit; forced: boolean; treeCleanupError?: string }> {
    this.closePromise ??= this.closeOwned(timeoutMs);
    return await this.closePromise;
  }

  private async closeOwned(timeoutMs: number): Promise<{ exit: ProcessExit; forced: boolean; treeCleanupError?: string }> {
    if (this.child.stdin && !this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    let exit = await this.waitForExit(timeoutMs);
    if (exit) return { exit, forced: false };

    let treeCleanupError: string | undefined;
    let forced = false;
    const pid = this.child.pid;
    // `close` waits for inherited pipes; native exit may already have released the PID.
    if (pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) {
      treeCleanupError = "Pi CLI ownership could not be confirmed for forced cleanup";
    } else if (process.platform === "win32") {
      forced = true;
      const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
      try {
        execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 3_000, windowsHide: true });
      } catch (error) {
        treeCleanupError = errorText(error);
        this.child.kill("SIGKILL");
      }
    } else {
      forced = true;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        treeCleanupError = errorText(error);
        this.child.kill("SIGKILL");
      }
    }
    exit = await this.waitForExit(5_000);
    if (!exit) throw new Error(`Pi CLI cleanup could not be confirmed${treeCleanupError ? `: ${treeCleanupError}` : ""}\n${this.diagnostics()}`);
    return { exit, forced, ...(treeCleanupError === undefined ? {} : { treeCleanupError }) };
  }

  private async waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    if (this.exit) return this.exit;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.closed,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.failure) return;
    this.stdoutBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_RECORD_BYTES && !this.stdoutBuffer.includes("\n")) {
      this.fail(new Error(`Pi RPC record exceeded ${MAX_RECORD_BYTES} bytes`));
      this.stdoutBuffer = "";
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
        this.fail(new Error(`Pi RPC record exceeded ${MAX_RECORD_BYTES} bytes`));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.fail(new Error(`Pi RPC emitted invalid JSON: ${errorText(error)}`));
        return;
      }
      if (!isRecord(parsed)) {
        this.fail(new Error("Pi RPC emitted a non-object record"));
        return;
      }
      this.publish(parsed);
      if (this.failure) return;
    }
  }

  private publish(value: PiRpcRecord): void {
    if (this.records.length >= MAX_RECORDS) {
      this.fail(new Error(`Pi RPC exceeded the ${MAX_RECORDS}-record driver limit`));
      return;
    }
    const stored = { sequence: ++this.sequence, value };
    this.records.push(stored);
    for (const waiter of this.waiters) {
      if (stored.sequence <= waiter.after) continue;
      try {
        if (waiter.predicate(value)) {
          this.removeWaiter(waiter);
          waiter.resolve(value);
        }
      } catch (error) {
        this.removeWaiter(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectWaiters(this.failure);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      this.removeWaiter(waiter);
      waiter.reject(error);
    }
  }

  private removeWaiter(waiter: RpcWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener("abort", waiter.abort);
    this.waiters.delete(waiter);
  }
}
