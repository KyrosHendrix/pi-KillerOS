import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionEntry = ReturnType<
  ExtensionContext["sessionManager"]["getEntries"]
>[number];

export function isAutomationMode(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

export function readContextUsage(
  ctx: Pick<ExtensionContext, "getContextUsage">,
): ReturnType<ExtensionContext["getContextUsage"]> {
  try {
    return ctx.getContextUsage();
  } catch {
    return undefined;
  }
}

export function entryUsage(entry: SessionEntry) {
  if (entry.type === "message") {
    return entry.message.role === "assistant" ||
      entry.message.role === "toolResult"
      ? entry.message.usage
      : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
}

function isAssistant<Message extends { role: string }>(
  message: Message,
): message is Extract<Message, { role: "assistant" }> {
  return message.role === "assistant";
}

export function lastAssistantMessage<Message extends { role: string }>(
  messages: readonly Message[],
): Extract<Message, { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && isAssistant(message)) return message;
  }
  return undefined;
}

export function wasAborted(event: object): boolean {
  return "aborted" in event && event.aborted === true;
}
