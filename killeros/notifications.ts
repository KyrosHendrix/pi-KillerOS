import { basename } from "node:path";
import type { StopReason } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.ts";
import { lastAssistantMessage, wasAborted } from "./pi-context.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";
import { createKillerosSettingsStore } from "./settings.ts";

export interface NotificationPreferenceStore {
  load(): boolean;
  save(enabled: boolean): void;
}

export interface CompletionNotificationDependencies {
  store: NotificationPreferenceStore;
  ring(): void;
}

const COMPLETION_BELL_GLYPH = "󰂚";

function createNotificationPreferenceStore(): NotificationPreferenceStore {
  const settings = createKillerosSettingsStore();
  return {
    load: () => settings.load().completionSound === true,
    save: (enabled) => {
      settings.update({ completionSound: enabled });
    },
  };
}

function formatNotificationTitle(
  cwd: string,
  sessionName: string | undefined,
  enabled: boolean,
): string {
  const directory = basename(cwd) || cwd;
  const base = sessionName ? `π - ${sessionName} - ${directory}` : `π - ${directory}`;
  return safeTerminalText(enabled ? `${base} ${COMPLETION_BELL_GLYPH}` : base).replaceAll("\n", "");
}

/** The completion sound preference and the terminal title that shows it. */
interface CompletionNotifications {
  /** Rewrites the terminal title; the shell header calls it because Pi resets the title after session binding. */
  applyTitle: (ctx: ExtensionContext) => void;
  /** Registers the /notification command and the request handlers that ring on settlement. */
  register: () => void;
}

export function createCompletionNotifications(
  pi: ExtensionAPI,
  dependencies?: CompletionNotificationDependencies,
): CompletionNotifications {
  const runtime = dependencies ?? {
    store: createNotificationPreferenceStore(),
    ring: () => { process.stdout.write("\x07"); },
  };
  let enabled = false;
  let requestPending = false;
  let lastStopReason: StopReason | undefined;

  const applyTitle = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(formatNotificationTitle(ctx.cwd, pi.getSessionName(), enabled));
  };

  const register = (): void => {
    pi.registerCommand("notification", {
      description: "Configure the completion sound",
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/notification requires TUI mode", "error");
          return;
        }
        const selected = await ctx.ui.select("Completion sound", [
          enabled ? "On ← current" : "On",
          enabled ? "Off" : "Off ← current",
        ]);
        if (!selected) return;
        const nextEnabled = selected.startsWith("On");
        try {
          runtime.store.save(nextEnabled);
        } catch (error) {
          ctx.ui.notify(`Completion sound setting could not be saved: ${errorMessage(error)}`, "error");
          return;
        }
        enabled = nextEnabled;
        applyTitle(ctx);
        ctx.ui.notify(`Completion sound: ${enabled ? "On" : "Off"}`, "info");
      },
    });

    pi.on("session_start", (_event, ctx) => {
      requestPending = false;
      lastStopReason = undefined;
      if (ctx.mode !== "tui") return;
      try {
        enabled = runtime.store.load();
      } catch (error) {
        enabled = false;
        ctx.ui.notify(`Completion sound settings could not be read: ${errorMessage(error)}`, "error");
      }
      applyTitle(ctx);
    });

    pi.on("session_info_changed", (_event, ctx) => applyTitle(ctx));

    pi.on("agent_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      requestPending = true;
      lastStopReason = undefined;
    });

    pi.on("agent_end", (event, ctx) => {
      if (ctx.mode !== "tui" || !requestPending) return;
      lastStopReason = lastAssistantMessage(event.messages)?.stopReason;
    });

    pi.on("agent_settled", (event, ctx) => {
      if (!requestPending || ctx.mode !== "tui") return;
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
      requestPending = false;
      if (!enabled || wasAborted(event) || lastStopReason === "aborted") return;
      try {
        runtime.ring();
      } catch (error) {
        ctx.ui.notify(`Completion sound failed: ${errorMessage(error)}`, "error");
      }
    });

    pi.on("session_shutdown", () => {
      requestPending = false;
      lastStopReason = undefined;
    });
  };

  return { applyTitle, register };
}
