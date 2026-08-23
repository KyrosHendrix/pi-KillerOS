import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRequestActivity } from "./killeros/activity.ts";
import { registerAutoCompaction } from "./killeros/auto-compaction.ts";
import {
  createSlashCommandResolver,
  registerAliases,
  registerSlashAutocomplete,
} from "./killeros/commands.ts";
import { registerFooter } from "./killeros/footer.ts";
import { registerGoal, registerGoalSettlement } from "./killeros/goals.ts";
import { registerHandoff } from "./killeros/handoff.ts";
import { registerLifecycleHooks } from "./killeros/hooks.ts";
import { registerInitCommand, registerInitSettlement } from "./killeros/init.ts";
import {
  registerCompletionNotifications,
  type CompletionNotificationDependencies,
} from "./killeros/notifications.ts";
import { registerCodexFastMode } from "./killeros/codex-fast.ts";
import { registerPersonalInstructions } from "./killeros/personal-instructions.ts";
import { registerQuestionTool } from "./killeros/question.ts";
import { createGoalRuntime, createInitRuntime } from "./killeros/runtime.ts";
import { registerShellUi } from "./killeros/shell-ui.ts";
import { registerVariants } from "./killeros/variants.ts";
import { registerWorkedFor } from "./killeros/worked-for.ts";

export { contextPercentRemaining, formatCost, formatContextProgress } from "./killeros/footer.ts";
export { executeHook } from "./killeros/hooks.ts";
export { INIT_WORKFLOW_PROMPT } from "./killeros/init.ts";
export { buildInitEvidence, listInitEvidence, readInitEvidence } from "./killeros/init-evidence.ts";
export { captureInitTargetBaseline, installInitAgentsFile, validateGeneratedGuidance, writeInitAgentsFile } from "./killeros/init-target.ts";
export interface KillerosOptions {
  completionNotifications?: CompletionNotificationDependencies;
}

export default function Killeros(pi: ExtensionAPI, options: KillerosOptions = {}): void {
  const initRuntime = createInitRuntime();
  const goalRuntime = createGoalRuntime();
  const commandResolver = createSlashCommandResolver(pi);
  registerShellUi(pi, commandResolver);
  registerGoal(pi, goalRuntime, initRuntime);
  registerPersonalInstructions(pi, initRuntime);
  registerQuestionTool(pi);
  registerAliases(pi);
  registerHandoff(pi, goalRuntime);
  registerSlashAutocomplete(pi, commandResolver);
  registerFooter(pi, goalRuntime);
  registerVariants(pi);
  registerCodexFastMode(pi);
  registerInitCommand(pi, initRuntime, goalRuntime);
  registerLifecycleHooks(pi);
  const goalCompaction = registerGoalSettlement(pi, goalRuntime, initRuntime);
  registerAutoCompaction(pi, { goal: goalCompaction });
  registerInitSettlement(pi, initRuntime);
  registerRequestActivity(pi);
  registerCompletionNotifications(pi, options.completionNotifications);
  registerWorkedFor(pi);
}
