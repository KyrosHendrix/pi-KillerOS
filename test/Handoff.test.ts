import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HANDOFF_MAX_TOKENS,
  generateHandoffSummary,
  resolveHandoffMaxTokens,
} from "../killeros/handoff.ts";
import { extensionCommandContextTestAdapter } from "./PiTestAdapters.ts";

/** A ten-section document that passes KillerOS section validation. */
const COMPLETE_SUMMARY = [
  "## Objective",
  "Finish the release checks.",
  "",
  "## Current state",
  "Resume the saved work.",
  "",
  "## Decisions",
  "Keep the current approach.",
  "",
  "## Constraints",
  "Keep the source session unchanged.",
  "",
  "## Completed work",
  "Prior work is recorded in the source session.",
  "",
  "## Relevant artifacts",
  "Reference the existing plan.",
  "",
  "## Verification",
  "No new verification has run.",
  "",
  "## Blockers or open questions",
  "None.",
  "",
  "## Exact next action",
  "Inspect the existing plan.",
  "",
  "## Suggested skills",
  "No installed skill is required.",
].join("\n");

type CompleteOptions = { maxTokens?: number; signal?: AbortSignal };

type CompleteCall = {
  model: unknown;
  messages: unknown[];
  options: CompleteOptions;
};

function createContext(complete: (call: CompleteCall) => Promise<unknown>) {
  return extensionCommandContextTestAdapter({
    getSystemPromptOptions: () => ({ skills: [] }),
    model: { id: "test-model", provider: "test" },
    modelRegistry: {
      complete: async (_model: unknown, context: { messages: unknown[] }, options: CompleteOptions) => {
        return complete({ model: _model, messages: context.messages, options });
      },
    },
  });
}

function textResponse(text: string, stopReason: string): unknown {
  return { content: [{ type: "text", text }], stopReason };
}

test("generateHandoffSummary names the token budget when truncation cuts the summary", async () => {
  const context = createContext(async () => textResponse(COMPLETE_SUMMARY.slice(0, 60), "length"));
  await assert.rejects(
    () => generateHandoffSummary(context, "conversation", "", { maxTokens: DEFAULT_HANDOFF_MAX_TOKENS }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`exceeded its ${DEFAULT_HANDOFF_MAX_TOKENS}-token output budget`, "u"));
      assert.match(error.message, /Shorten the source session or raise the handoff token budget/u);
      assert.doesNotMatch(error.message, /did not finish/u);
      return true;
    },
  );
});

test("generateHandoffSummary returns a completed ten-section summary", async () => {
  const context = createContext(async () => textResponse(COMPLETE_SUMMARY, "stop"));
  const summary = await generateHandoffSummary(
    context,
    "conversation",
    "finish the release checks",
    { maxTokens: DEFAULT_HANDOFF_MAX_TOKENS },
  );
  assert.equal(summary, COMPLETE_SUMMARY);
});

test("generateHandoffSummary sends the configured budget as maxTokens", async () => {
  let sentMaxTokens: number | undefined;
  const context = createContext(async (call) => {
    sentMaxTokens = call.options.maxTokens;
    return textResponse(COMPLETE_SUMMARY, "stop");
  });
  await generateHandoffSummary(context, "conversation", "", { maxTokens: 8_192 });
  assert.equal(sentMaxTokens, 8_192);
});

test("generateHandoffSummary surfaces provider errors unchanged", async () => {
  const context = createContext(async () => ({
    content: [],
    stopReason: "error",
    errorMessage: "Upstream request failed (503)",
  }));
  await assert.rejects(
    () => generateHandoffSummary(context, "conversation", "", { maxTokens: DEFAULT_HANDOFF_MAX_TOKENS }),
    { message: "Upstream request failed (503)" },
  );
});

test("generateHandoffSummary keeps the generic failure for non-length abnormal stops", async () => {
  const context = createContext(async () => textResponse("", "aborted"));
  await assert.rejects(
    () => generateHandoffSummary(context, "conversation", "", { maxTokens: DEFAULT_HANDOFF_MAX_TOKENS }),
    { message: "The handoff summary did not finish" },
  );
});

test("budget resolution prefers valid options over killeros.json over the default", () => {
  assert.equal(resolveHandoffMaxTokens({}, undefined), DEFAULT_HANDOFF_MAX_TOKENS);
  assert.equal(resolveHandoffMaxTokens({ handoffMaxTokens: 16_384 }, undefined), 16_384);
  assert.equal(resolveHandoffMaxTokens({ handoffMaxTokens: 16_384 }, 1_024), 1_024);
  for (const invalid of [0, -5, 1.5, Number.NaN, "2048", null]) {
    assert.equal(resolveHandoffMaxTokens({ handoffMaxTokens: invalid }, undefined), DEFAULT_HANDOFF_MAX_TOKENS, `settings ${String(invalid)}`);
  }
  assert.equal(resolveHandoffMaxTokens({ handoffMaxTokens: 16_384 }, Number.NaN), 16_384);
});
