import { createHook, type AsyncHook } from "node:async_hooks";
import xterm from "@xterm/headless";
import { hasNative, spawn, type IPty } from "zigpty";

type TerminalCloseResult = { code: number; forced: boolean; failure?: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One native terminal, with parsed screens, bounded raw diagnostics, and owned shutdown. */
export class PiTerminalProcess {
  private readonly pty: IPty;
  private readonly terminal: xterm.Terminal;
  private readonly changed = new Set<() => void>();
  private raw = Buffer.alloc(0);
  private exitCode: number | undefined;
  private parsedSequence = 0;
  private pendingWrites = 0;
  private readonly nativeResources = new Set<number>();
  private nativeResourcesCreated = 0;
  private readonly nativeCleanupHook: AsyncHook;
  private closing: Promise<TerminalCloseResult> | undefined;

  constructor(options: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols?: number; rows?: number }) {
    if (!hasNative) throw new Error("A native PTY binding is required; pipe fallback is not terminal coverage");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;
    this.terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 200 });
    let spawning = true;
    this.nativeCleanupHook = createHook({
      init: (id, type) => {
        if (spawning && type.startsWith("zigpty")) { this.nativeResources.add(id); this.nativeResourcesCreated++; }
      },
      destroy: (id) => {
        if (!this.nativeResources.delete(id)) return;
        for (const notify of this.changed) notify();
      },
    }).enable();
    try {
      this.pty = spawn(options.file, options.args, { cwd: options.cwd, env, cols, rows, name: "xterm-256color", encoding: null });
    } catch (error) {
      this.nativeCleanupHook.disable();
      this.terminal.dispose();
      throw error;
    } finally { spawning = false; }
    this.terminal.onData((data) => { if (this.exitCode === undefined) this.pty.write(data); });
    this.pty.onData((data) => {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      this.raw = Buffer.concat([this.raw, bytes]).subarray(-32_768);
      this.pendingWrites++;
      this.terminal.write(bytes, () => {
        this.pendingWrites--;
        this.parsedSequence++;
        for (const notify of this.changed) notify();
      });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const notify of this.changed) notify();
    });
  }

  get sequence(): number { return this.parsedSequence; }

  screen(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  diagnostics(): string {
    return JSON.stringify({ exitCode: this.exitCode, nativeResources: this.nativeResources.size, nativeResourcesCreated: this.nativeResourcesCreated, sequence: this.sequence, screen: this.screen(), rawBase64: this.raw.toString("base64") }).slice(-65_536);
  }

  write(data: string): void {
    if (this.exitCode !== undefined) throw new Error(`Terminal child already exited: ${this.diagnostics()}`);
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  async waitForScreen(predicate: (screen: string) => boolean, options: { signal: AbortSignal; after?: number; timeoutMs?: number }): Promise<string> {
    if (options.signal.aborted) throw new Error("Terminal screen wait cancelled", { cause: options.signal.reason });
    return await new Promise<string>((resolve, reject) => {
      const clean = (): void => {
        clearTimeout(timer);
        this.changed.delete(check);
        options.signal.removeEventListener("abort", abort);
      };
      const abort = (): void => { clean(); reject(new Error("Terminal screen wait cancelled", { cause: options.signal.reason })); };
      const check = (): void => {
        try {
          const screen = this.screen();
          if (this.sequence > (options.after ?? -1) && predicate(screen)) { clean(); resolve(screen); }
          else if (this.exitCode !== undefined && this.pendingWrites === 0) { clean(); reject(new Error(`Terminal exited before expected screen: ${this.diagnostics()}`)); }
        } catch (error) { clean(); reject(error instanceof Error ? error : new Error(String(error))); }
      };
      const timer = setTimeout(() => {
        clean();
        reject(new Error(`Terminal screen timeout: ${this.diagnostics()}`));
      }, options.timeoutMs ?? 15_000);
      this.changed.add(check);
      options.signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  async close(): Promise<TerminalCloseResult> {
    this.closing ??= this.closeOwned();
    return await this.closing;
  }

  private async waitForExit(timeoutMs: number): Promise<number | undefined> {
    if (this.exitCode !== undefined) return this.exitCode;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.pty.exited, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async closeOwned(): Promise<TerminalCloseResult> {
    let writeFailure: unknown;
    let killFailure: unknown;
    const closeFailures: unknown[] = [];
    let closeAttempted = false;
    const closeOwnedPty = (): void => {
      if (closeAttempted || this.pty.exitCode !== null) return;
      closeAttempted = true;
      try { this.pty.close(); }
      catch (error) { closeFailures.push(error); }
    };
    try {
      // Pi's public clear and exit actions also handle an unfinished editor draft.
      if (this.exitCode === undefined) {
        try { this.pty.write("\x03\x04"); }
        catch (error) { writeFailure = error; }
      }
      let code = await this.waitForExit(5_000);
      const forced = code === undefined && this.pty.exitCode === null;
      if (code === undefined && !forced) code = this.pty.exitCode ?? undefined;
      if (forced) {
        // Check the native handle's state before either escalation or close can act on it.
        if (this.pty.exitCode === null) {
          try { this.pty.kill("SIGKILL"); }
          catch (error) { killFailure = error; }
        }
        if (killFailure !== undefined) closeOwnedPty();
        code = await this.waitForExit(5_000);
        if (code === undefined && this.pty.exitCode !== null) code = this.pty.exitCode;
        if (code === undefined) {
          closeOwnedPty();
          code = await this.waitForExit(5_000);
        }
      }
      if (code === undefined) {
        throw new Error(`Terminal cleanup could not be confirmed: ${this.diagnostics()}`);
      }

      // Exit notification precedes native callback destruction and queued screen parsing.
      await new Promise<void>((resolve, reject) => {
        const check = (): void => {
          if (this.pendingWrites !== 0 || this.nativeResources.size !== 0) return;
          clearTimeout(timer);
          this.changed.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          this.changed.delete(check);
          reject(new Error(`Terminal native/parser cleanup timed out: ${this.diagnostics()}`));
        }, 3_000);
        this.changed.add(check);
        // Native handle close and destroy hooks flush on successive event-loop turns.
        setImmediate(() => setImmediate(check));
        check();
      });
      const failures = [writeFailure, killFailure, ...closeFailures].filter((error) => error !== undefined);
      const failure = failures.map(errorText).join("; ");
      return { code, forced, ...(failure ? { failure } : {}) };
    } catch (error) {
      const failures = [writeFailure, killFailure, ...closeFailures].filter((failure) => failure !== undefined);
      if (failures.length > 0) throw new AggregateError([error, ...failures], `Terminal cleanup failed: ${errorText(error)}`);
      throw error;
    } finally {
      this.nativeCleanupHook.disable();
      if (this.exitCode !== undefined && this.pendingWrites === 0 && this.nativeResources.size === 0) this.terminal.dispose();
    }
  }
}
