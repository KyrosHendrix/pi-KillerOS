import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Converts unknown caught values into text suitable for user-facing errors. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reportError(ctx: ExtensionContext, area: string, error: unknown): void {
  ctx.ui.notify(`${area}: ${errorMessage(error)}`, "error");
}
