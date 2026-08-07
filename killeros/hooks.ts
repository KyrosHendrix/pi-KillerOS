import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportError } from "./errors.ts";
import { MAX_NODE_TIMER_MS } from "./limits.ts";

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
  exitUnconfirmed: boolean;
}

const HOOK_EVENTS: readonly KillerosHookEvent[] = ["tool_call", "tool_result", "agent_settled"];
const HOOK_OUTPUT_LIMIT = 16 * 1024;

function loadKillerosHooks(ctx: ExtensionContext): KillerosHookConfig {
  const configPath = path.join(ctx.cwd, CONFIG_DIR_NAME, "killeros-hooks.json");
  if (!existsSync(configPath)) return {};
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify(`Ignored untrusted project hooks in ${configPath}`, "warning");
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as KillerosHookConfig;
    const hooks: KillerosHookConfig["hooks"] = {};
    for (const event of HOOK_EVENTS) {
      const candidates = parsed.hooks?.[event];
      if (!Array.isArray(candidates)) continue;
      hooks[event] = candidates.filter((hook, index) => {
        const valid = hook
          && typeof hook.command === "string"
          && hook.command.trim().length > 0
          && (hook.matcher === undefined || typeof hook.matcher === "string")
          && (hook.timeoutMs === undefined || Number.isSafeInteger(hook.timeoutMs) && hook.timeoutMs > 0 && hook.timeoutMs <= MAX_NODE_TIMER_MS);
        if (!valid) {
          ctx.ui.notify(`Ignored invalid ${event} hook ${index + 1} in ${configPath}`, "warning");
          return false;
        }
        if (hook.matcher && hook.matcher !== "*") {
          try {
            new RegExp(hook.matcher, "u");
          } catch {
            ctx.ui.notify(`Ignored ${event} hook ${index + 1}: invalid matcher ${JSON.stringify(hook.matcher)}`, "warning");
            return false;
          }
        }
        return true;
      });
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

function appendBounded(current: string, chunk: Buffer | string): string {
  if (current.length >= HOOK_OUTPUT_LIMIT) return current;
  return (current + chunk.toString()).slice(0, HOOK_OUTPUT_LIMIT);
}

function terminateHookProcess(child: ReturnType<typeof spawn>, force: boolean): void {
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

export function executeHook(command: string, cwd: string, environment: Record<string, string>, timeoutMs = 30_000, spawnProcess: typeof spawn = spawn): Promise<HookExecutionResult> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, {
      cwd,
      env: { ...process.env, ...environment },
      detached: process.platform !== "win32",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let completed = false;
    let timedOut = false;
    let exitUnconfirmed = false;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = (code: number, unconfirmed = false): void => {
      if (completed) return;
      completed = true;
      exitUnconfirmed = unconfirmed;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve({ code, stdout, stderr, timedOut, exitUnconfirmed });
    };
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      stderr = appendBounded(stderr, error.message);
      finish(timedOut ? 124 : 1);
    });
    child.once("close", (code) => finish(timedOut ? 124 : code ?? 1));
    timer = setTimeout(() => {
      timedOut = true;
      terminateHookProcess(child, false);
      forceTimer = setTimeout(() => {
        if (completed) return;
        terminateHookProcess(child, true);
        settleTimer = setTimeout(() => finish(124, true), 1_000);
      }, 1_000);
    }, Math.max(1_000, Math.min(timeoutMs, 300_000)));
  });
}

function hookEnvironment(event: KillerosHookEvent, toolName = "", payload: unknown = {}): Record<string, string> {
  return {
    KILLEROS_EVENT: event,
    KILLEROS_TOOL: toolName,
    KILLEROS_PAYLOAD: JSON.stringify(payload).slice(0, 8_000),
  };
}

function hookFailureMessage(hook: KillerosHook, result: HookExecutionResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return `Hook failed${result.timedOut ? " (timed out)" : ""}${result.exitUnconfirmed ? " (process exit unconfirmed)" : ""}: ${hook.command}\n${detail}`;
}

export function registerLifecycleHooks(pi: ExtensionAPI): void {
  let config: KillerosHookConfig = {};
  pi.on("session_start", (_event, ctx) => { config = loadKillerosHooks(ctx); });

  pi.on("tool_call", async (event, ctx) => {
    for (const hook of config.hooks?.tool_call ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await executeHook(
        hook.command,
        ctx.cwd,
        hookEnvironment("tool_call", event.toolName, event.input),
        hook.timeoutMs,
      );
      if (result.code !== 0) {
        const reason = hookFailureMessage(hook, result);
        ctx.ui.notify(reason, "error");
        return { block: true, reason };
      }
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    for (const hook of config.hooks?.tool_result ?? []) {
      if (!matchesHook(hook, event.toolName)) continue;
      const result = await executeHook(
        hook.command,
        ctx.cwd,
        hookEnvironment("tool_result", event.toolName, {
          input: event.input,
          isError: event.isError,
        }),
        hook.timeoutMs,
      );
      if (result.code !== 0) ctx.ui.notify(hookFailureMessage(hook, result), "error");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    for (const hook of config.hooks?.agent_settled ?? []) {
      const result = await executeHook(
        hook.command,
        ctx.cwd,
        hookEnvironment("agent_settled"),
        hook.timeoutMs,
      );
      if (result.code !== 0) ctx.ui.notify(hookFailureMessage(hook, result), "error");
    }
  });
}
