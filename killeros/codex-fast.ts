import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodexFastEnabled, toggleCodexFast } from "./codex-fast-state.ts";

const CODEX_PROVIDER = "openai-codex";
type RequestPayload = Record<string, unknown>;

function isRequestPayload(value: unknown): value is RequestPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerCodexFastMode(pi: ExtensionAPI): void {
  pi.registerCommand("codex-fast", {
    description: "Toggle Codex fast mode",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /codex-fast", "error");
        return;
      }

      const enabled = toggleCodexFast();
      ctx.ui.notify(`Fast ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodexFastEnabled() || ctx.model?.provider !== CODEX_PROVIDER || !isRequestPayload(event.payload)) {
      return event.payload;
    }
    return { ...event.payload, service_tier: "priority" };
  });
}
