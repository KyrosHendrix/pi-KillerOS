import { stripTerminalSequences } from "@earendil-works/pi-tui";

export function safeTerminalText(value: string): string {
  return stripTerminalSequences(value).replace(
    /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu,
    "",
  );
}
