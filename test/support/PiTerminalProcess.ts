import { createHook, type AsyncHook } from "node:async_hooks";
import { release } from "node:os";
import xterm from "@xterm/headless";
import { hasNative, spawn, type IPty } from "zigpty";
import { shareJitiCache } from "./JitiCache.ts";
import { piTimerResolutionOptions } from "./TimerResolution.ts";

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
  private parsedBells = 0;
  private parsedTitles = 0;
  private readonly parsedTitleHistory: string[] = [];
  private pendingWrites = 0;
  private readonly nativeResources = new Set<number>();
  private nativeResourcesCreated = 0;
  private readonly nativeCleanupHook: AsyncHook;
  private closing: Promise<TerminalCloseResult> | undefined;

  constructor(options: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; cols?: number; rows?: number; onTitle?: (title: string) => void; onBell?: () => void }) {
    if (!hasNative) throw new Error("A native PTY binding is required; pipe fallback is not terminal coverage");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.env)) if (value !== undefined) env[key] = value;
    piTimerResolutionOptions(env);
    const cols = options.cols ?? 100;
    const rows = options.rows ?? 30;
    this.terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 200,
      windowsPty: { backend: "conpty", buildNumber: Number(release().split(".")[2]) } });
    this.terminal.onBell(() => { this.parsedBells++; options.onBell?.(); });
    this.terminal.onTitleChange((title) => {
      this.parsedTitles++;
      this.parsedTitleHistory.push(title);
      if (this.parsedTitleHistory.length > 32) this.parsedTitleHistory.shift();
      options.onTitle?.(title);
    });
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
    shareJitiCache(options.env);
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
  get bellCount(): number { return this.parsedBells; }
  get titleCount(): number { return this.parsedTitles; }
  get titles(): readonly string[] { return this.parsedTitleHistory; }

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

  /** Paste short lines without autocomplete, then observe echo before sending a separate Enter key. */
  async submitEditorText(text: string, options: { signal: AbortSignal }): Promise<void> {
    const after = this.sequence;
    this.write(text.length <= 1_000 && !text.includes("\n") ? `\x1b[200~${text}\x1b[201~` : text);
    await this.waitForScreen((screen) => screen.split("\n").some((line) => line.includes("❯") && line.includes(text)),
      { signal: options.signal, after });
    this.write("\x1b[13u");
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
          // ConPTY can split a synchronized frame across callbacks. Do not act on its partial screen.
          if (this.pendingWrites === 0 && !this.terminal.modes.synchronizedOutputMode
            && this.sequence > (options.after ?? -1) && predicate(screen)) { clean(); resolve(screen); }
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

  async close(options: { force?: boolean } = {}): Promise<TerminalCloseResult> {
    this.closing ??= this.closeOwned(options.force === true);
    return await this.closing;
  }

  private async waitForExit(timeoutMs: number): Promise<number | undefined> {
    if (this.exitCode !== undefined) return this.exitCode;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.pty.exited, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async closeOwned(force: boolean): Promise<TerminalCloseResult> {
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
      // Normal cleanup sends Pi's interrupt and exit keys; fault scenarios can require immediate termination.
      if (this.exitCode === undefined) {
        if (force) {
          try { this.pty.kill("SIGKILL"); }
          catch (error) { killFailure = error; }
        } else {
          try { this.pty.write("\x03\x04"); }
          catch (error) { writeFailure = error; }
        }
      }
      // Windows may finish Pi's shutdown output before the native process and PTY close.
      // Keep a bounded grace period before classifying that cleanup as forced.
      let code = await this.waitForExit(force ? 5_000 : 15_000);
      const forced = force || (code === undefined && this.pty.exitCode === null);
      if (code === undefined && this.pty.exitCode !== null) code = this.pty.exitCode ?? undefined;
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
