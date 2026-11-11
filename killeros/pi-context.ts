import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

/** Goals and proactive compaction run only where Pi keeps a live session between requests. */
export function isAutomationMode(ctx: Pick<ExtensionContext, "mode">): boolean {
  return ctx.mode === "tui" || ctx.mode === "rpc";
}

/** Returns Pi's context usage, or undefined when the host cannot report it. */
export function readContextUsage(ctx: Pick<ExtensionContext, "getContextUsage">): ReturnType<ExtensionContext["getContextUsage"]> {
  try {
    return ctx.getContextUsage();
  } catch {
    return undefined;
  }
}

/** Returns the usage a session entry records: assistant and tool-result messages, compactions, and branch summaries. */
export function entryUsage(entry: SessionEntry) {
  if (entry.type === "message") {
    return entry.message.role === "assistant" || entry.message.role === "toolResult" ? entry.message.usage : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
}

function isAssistant<Message extends { role: string }>(message: Message): message is Extract<Message, { role: "assistant" }> {
  return message.role === "assistant";
}

/** Finds the final assistant message of a finished agent run. */
export function lastAssistantMessage<Message extends { role: string }>(
  messages: readonly Message[],
): Extract<Message, { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && isAssistant(message)) return message;
  }
  return undefined;
}

/** Whether Pi settled a request because it was aborted. */
export function wasAborted(event: object): boolean {
  return "aborted" in event && event.aborted === true;
}
