import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequestActivity } from "./killeros/activity.ts";
import { registerAutoCompaction } from "./killeros/auto-compaction.ts";
import {
  createSlashCommandResolver,
  registerAliases,
  registerSlashAutocomplete,
} from "./killeros/commands.ts";
import { registerFooter } from "./killeros/footer.ts";
import { registerGoalInterface } from "./killeros/goal-interface.ts";
import { registerGoalRuntime } from "./killeros/goal-runtime.ts";
import { registerGoalSettlement } from "./killeros/goal-settlement.ts";
import { registerHandoff } from "./killeros/handoff.ts";
import { registerLifecycleHooks } from "./killeros/hooks.ts";
import {
  registerCompletionNotifications,
  type CompletionNotificationDependencies,
} from "./killeros/notifications.ts";
import { registerCodexFastMode } from "./killeros/codex-fast.ts";
import { registerPersonalInstructions } from "./killeros/personal-instructions.ts";
import { registerQuestionTool } from "./killeros/question.ts";
import { createGoalRuntime } from "./killeros/runtime.ts";
import { registerShellUi } from "./killeros/shell-ui.ts";
import { registerWorkedFor } from "./killeros/worked-for.ts";

export { contextPercentRemaining, formatCost, formatContextProgress } from "./killeros/footer.ts";
export { executeHook } from "./killeros/hooks.ts";
export interface KillerosOptions {
  completionNotifications?: CompletionNotificationDependencies;
  /** Output-token budget for /handoff summaries; invalid values fall back to killeros.json, then the default. */
  handoffMaxTokens?: number;
}

export default function Killeros(pi: ExtensionAPI, options: KillerosOptions = {}): void {
  const goalRuntime = createGoalRuntime();
  const commandResolver = createSlashCommandResolver(pi);
  registerShellUi(pi, commandResolver);
  registerGoalInterface(pi, goalRuntime);
  registerGoalRuntime(pi, goalRuntime);
  registerPersonalInstructions(pi);
  registerQuestionTool(pi);
  registerAliases(pi);
  registerHandoff(pi, goalRuntime, options.handoffMaxTokens);
  registerSlashAutocomplete(pi, commandResolver);
  registerFooter(pi, goalRuntime);
  registerCodexFastMode(pi);
  registerLifecycleHooks(pi);
  registerWorkedFor(pi);
  const goalCompaction = registerGoalSettlement(pi, goalRuntime);
  registerAutoCompaction(pi, { goal: goalCompaction });
  registerRequestActivity(pi);
  registerCompletionNotifications(pi, options.completionNotifications);
}
