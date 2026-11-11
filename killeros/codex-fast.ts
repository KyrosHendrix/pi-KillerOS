import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodexFastEnabled, isCodexFastModel, toggleCodexFast } from "./codex-fast-state.ts";
import { isRecord } from "./guards.ts";

export function registerCodexFastMode(pi: ExtensionAPI): void {
  pi.registerCommand("codex-fast", {
    description: "Toggle or report Codex fast mode",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "status") {
        ctx.ui.notify(`Codex fast mode: ${isCodexFastEnabled() ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (trimmed) {
        ctx.ui.notify("Usage: /codex-fast [status]", "error");
        return;
      }

      const enabled = toggleCodexFast();
      ctx.ui.notify(`Fast ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodexFastEnabled() || !isCodexFastModel(ctx.model) || !isRecord(event.payload)) {
      return event.payload;
    }
    // The hook exposes no dispatched provider/API. Native requests must match the selected model.
    if (ctx.model?.provider === "openai" && event.payload.model !== ctx.model.id) return event.payload;
    return { ...event.payload, service_tier: "priority" };
  });
}
