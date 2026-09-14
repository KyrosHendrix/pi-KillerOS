import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { modelDisplayName } from "./display.ts";

export type ActivityMessage =
  | { kind: "prompt" }
  | { kind: "tool"; toolName: string }
  | { kind: "tool-result"; failed: boolean }
  | { kind: "responding" };

function safeToolName(toolName: string): string {
  const normalized = toolName.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return truncateToWidth(normalized || "tool", 32, "…");
}

export function formatActivityMessage(message: ActivityMessage, theme: Theme, modelId?: string): string {
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
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }

  const suffix = modelDisplayName({ id: modelId }) || "unknown model";
  return `${theme.fg("accent", verb)} ${theme.fg("dim", `(${theme.bold("esc")} to interrupt · ${detail})`)}${theme.fg("dim", ` · ${suffix}`)}`;
}

export function registerRequestActivity(pi: ExtensionAPI): void {
  let active = false;
  let activeModel: string | undefined;

  const render = (message: ActivityMessage, ctx: ExtensionContext): void => {
    ctx.ui.setWorkingMessage(formatActivityMessage(message, ctx.ui.theme, activeModel));
  };

  const clear = (ctx?: ExtensionContext): void => {
    active = false;
    activeModel = undefined;
    if (ctx?.mode === "tui") {
      ctx.ui.setWorkingMessage();
    }
  };

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!active) activeModel = ctx.model?.id;
    active = true;
    render({ kind: "prompt" }, ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !active) return;
    render({ kind: "tool", toolName: event.toolName }, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.mode !== "tui" || !active) return;
    render({ kind: "tool-result", failed: event.isError }, ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui" || !active || event.assistantMessageEvent.type !== "text_start") return;
    render({ kind: "responding" }, ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || !active || !ctx.isIdle?.() || ctx.hasPendingMessages?.()) return;
    clear(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
}
