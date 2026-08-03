import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "./killeros/subagents.ts";
import { registerAliases, registerSlashAutocomplete } from "./killeros/commands.ts";
import { registerConcisePrompt } from "./killeros/concise.ts";
import { registerFooter } from "./killeros/footer.ts";
import { registerGoal, registerGoalSettlement } from "./killeros/goals.ts";
import { registerLifecycleHooks } from "./killeros/hooks.ts";
import { registerInitCommand, registerInitSettlement } from "./killeros/init.ts";
import { registerPersonalInstructions } from "./killeros/personal-instructions.ts";
import { registerQuestionTool } from "./killeros/question.ts";
import { createGoalRuntime, createInitRuntime } from "./killeros/runtime.ts";
import { registerShellUi } from "./killeros/shell-ui.ts";
import { registerVariants } from "./killeros/variants.ts";

export { CONCISE_SYSTEM_PROMPT, isConcisedEnabled } from "./killeros/concise.ts";
export { formatCost, formatContextProgress } from "./killeros/footer.ts";
export { executeHook } from "./killeros/hooks.ts";
export { INIT_WORKFLOW_PROMPT, writeInitAgentsFile } from "./killeros/init.ts";

export default function Killeros(pi: ExtensionAPI): void {
  const initRuntime = createInitRuntime();
  const goalRuntime = createGoalRuntime();
  registerShellUi(pi);
  registerConcisePrompt(pi);
  registerGoal(pi, goalRuntime, initRuntime);
  registerPersonalInstructions(pi, initRuntime);
  registerQuestionTool(pi);
  registerSubagentTool(pi);
  registerAliases(pi);
  registerSlashAutocomplete(pi);
  registerFooter(pi, goalRuntime);
  registerVariants(pi);
  registerInitCommand(pi, initRuntime, goalRuntime);
  registerLifecycleHooks(pi);
  registerGoalSettlement(pi, goalRuntime, initRuntime);
  registerInitSettlement(pi, initRuntime);
}
