import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeTerminalText } from "./safe-terminal-text.ts";

/** Checks a caught value for one exact string error code. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

/** Converts unknown caught values into text suitable for user-facing errors. */
export function errorMessage(error: unknown): string {
  return safeTerminalText(error instanceof Error ? error.message : String(error));
}

export function reportError(ctx: ExtensionContext, area: string, error: unknown): void {
  ctx.ui.notify(`${area}: ${errorMessage(error)}`, "error");
}
