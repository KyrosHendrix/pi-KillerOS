import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const CONCISE_SYSTEM_PROMPT = `
# Concise output rules
1. Start with the answer or next action; omit conversational preambles.
2. Use numbered steps only when order matters, with one bounded action per step.
3. Finish the primary task before mentioning optional follow-up work.
4. State failures directly and include the recovery action.
5. Keep lists focused; group long inventories under clear headings.
6. Do not invent time estimates, completion claims, or facts.
7. Preserve exact code, commands, paths, quoted text, warnings, and user-requested formats.
8. Omit recap sections and generic closing pleasantries.
`.trim();

export function isConcisedEnabled(): boolean {
  return true;
}

export function registerConcisePrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CONCISE_SYSTEM_PROMPT}`,
  }));
}
