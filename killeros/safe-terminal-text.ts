import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Remove terminal commands and unsafe controls while preserving line feeds. */
export function safeTerminalText(value: string): string {
  return stripTerminalSequences(value).replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, "");
}
