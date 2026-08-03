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
9. Use a pragmatic style: direct, plain, and focused on the task.
`.trim();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyConciseModelSettings(payload: unknown, api: unknown, modelId: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;

  const supportsSummary = api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses";
  const supportsVerbosity = api === "openai-codex-responses"
    || api === "openai-responses" && typeof modelId === "string" && /^gpt-5(?:[.-]|$)/u.test(modelId);
  let updated = payload;
  if (supportsVerbosity) {
    updated = {
      ...updated,
      text: { ...(isRecord(payload.text) ? payload.text : {}), verbosity: "low" },
    };
  }
  if (supportsSummary && isRecord(payload.reasoning)) {
    updated = { ...updated, reasoning: { ...payload.reasoning, summary: "concise" } };
  }
  return updated;
}

export function isConcisedEnabled(): boolean {
  return true;
}

export function registerConcisePrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CONCISE_SYSTEM_PROMPT}`,
  }));
  pi.on("before_provider_request", (event, ctx) => applyConciseModelSettings(event.payload, ctx.model?.api, ctx.model?.id));
}
