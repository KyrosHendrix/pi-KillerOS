import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAliases, registerSlashAutocomplete } from "./killeros/commands.ts";
import { registerConcisePrompt } from "./killeros/concise.ts";
import { registerFooter } from "./killeros/footer.ts";
import { registerGoal, registerGoalSettlement } from "./killeros/goals.ts";
import { registerLifecycleHooks } from "./killeros/hooks.ts";
import { registerInitCommand, registerInitSettlement } from "./killeros/init.ts";
import {
  registerCompletionNotifications,
  type CompletionNotificationDependencies,
} from "./killeros/notifications.ts";
import { registerPersonalInstructions } from "./killeros/personal-instructions.ts";
import { registerQuestionTool } from "./killeros/question.ts";
import { createGoalRuntime, createInitRuntime } from "./killeros/runtime.ts";
import { registerShellUi } from "./killeros/shell-ui.ts";
import { registerVariants } from "./killeros/variants.ts";

export { CONCISE_SYSTEM_PROMPT, isConciseEnabled, isConcisedEnabled } from "./killeros/concise.ts";
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
  registerShellUi(pi);
  registerConcisePrompt(pi);
  registerGoal(pi, goalRuntime, initRuntime);
  registerPersonalInstructions(pi, initRuntime);
  registerQuestionTool(pi);
  registerAliases(pi);
  registerSlashAutocomplete(pi);
  registerFooter(pi, goalRuntime);
  registerVariants(pi);
  registerInitCommand(pi, initRuntime, goalRuntime);
  registerLifecycleHooks(pi);
  registerGoalSettlement(pi, goalRuntime, initRuntime);
  registerInitSettlement(pi, initRuntime);
  registerCompletionNotifications(pi, options.completionNotifications);
}
