import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function reportError(ctx: ExtensionContext, area: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${area}: ${message}`, "error");
}
