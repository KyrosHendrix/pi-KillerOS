import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type ActivityMessage =
  | { kind: "prompt" }
  | { kind: "tool"; toolName: string }
  | { kind: "tool-result"; failed: boolean }
  | { kind: "responding" };

function safeToolName(toolName: string): string {
  const normalized = toolName.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return truncateToWidth(normalized || "tool", 32, "…");
}

export function formatActivityMessage(message: ActivityMessage, theme: Theme): string {
  let verb: string;
  let detail: string;

  switch (message.kind) {
    case "prompt":
      verb = "Mapping…";
      detail = "understanding request";
      break;
    case "tool-result":
      verb = message.failed ? "Recovering…" : "Reviewing…";
      detail = message.failed ? "tool failed" : "reading the result";
      break;
    case "responding":
      verb = "Responding…";
      detail = "assembling the answer";
      break;
    case "tool":
      switch (message.toolName.trim().toLowerCase()) {
        case "read":
        case "grep":
        case "find":
        case "ls":
          verb = "Inspecting…";
          detail = "reading relevant code";
          break;
        case "edit":
        case "write":
          verb = "Changing…";
          detail = "editing";
          break;
        case "bash":
          verb = "Running…";
          detail = "command";
          break;
        default:
          verb = "Working…";
          detail = `using ${safeToolName(message.toolName)}`;
      }
      break;
  }

  return `${theme.fg("accent", verb)} ${theme.fg("dim", `(${theme.bold("esc")} to interrupt · ${detail})`)}`;
}

export function registerRequestActivity(pi: ExtensionAPI): void {
  let active = false;

  const clear = (ctx?: ExtensionContext): void => {
    if (ctx?.mode === "tui") {
      ctx.ui.setWorkingMessage();
    }
    active = false;
  };

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = true;
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "prompt" }, ctx.ui.theme));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !active) return;
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "tool", toolName: event.toolName }, ctx.ui.theme));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.mode !== "tui" || !active) return;
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "tool-result", failed: event.isError }, ctx.ui.theme));
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui" || !active || event.assistantMessageEvent.type !== "text_start") return;
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "responding" }, ctx.ui.theme));
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || !active || !ctx.isIdle?.() || ctx.hasPendingMessages?.()) return;
    clear(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
}
