import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "./killeros/subagents.ts";
import {
  createSubagentControlApi,
  registerAliases,
  registerSlashAutocomplete,
  registerSubagentCommand,
  type SubagentControlApi,
  type SubagentToolLike,
} from "./killeros/commands.ts";
import { registerConcisePrompt } from "./killeros/concise.ts";
import { registerContextCompaction } from "./killeros/context-compaction.ts";
import { registerFooter } from "./killeros/footer.ts";
import { registerGoal, registerGoalSettlement } from "./killeros/goals.ts";
import { registerLifecycleHooks } from "./killeros/hooks.ts";
import { registerInitCommand, registerInitSettlement } from "./killeros/init.ts";
import { registerPersonalInstructions } from "./killeros/personal-instructions.ts";
import { registerQuestionTool } from "./killeros/question.ts";
import { createCompactionRuntime, createGoalRuntime, createInitRuntime } from "./killeros/runtime.ts";
import { registerShellUi } from "./killeros/shell-ui.ts";
import { registerVariants } from "./killeros/variants.ts";

export { CONCISE_SYSTEM_PROMPT, isConcisedEnabled } from "./killeros/concise.ts";
export { contextPercentRemaining } from "./killeros/context-compaction.ts";
export { formatCost, formatContextProgress } from "./killeros/footer.ts";
export { executeHook } from "./killeros/hooks.ts";
export { INIT_WORKFLOW_PROMPT, writeInitAgentsFile } from "./killeros/init.ts";

export default function Killeros(pi: ExtensionAPI): void {
  const initRuntime = createInitRuntime();
  const goalRuntime = createGoalRuntime();
  const compactionRuntime = createCompactionRuntime();
  registerShellUi(pi);
  registerConcisePrompt(pi);
  registerGoal(pi, goalRuntime, initRuntime);
  registerPersonalInstructions(pi, initRuntime);
  registerQuestionTool(pi);
  let subagentTool: SubagentToolLike | undefined;
  const registrationPi = new Proxy(pi, {
    get(target, property, receiver) {
      if (property === "registerTool") {
        return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
          if (tool.name === "subagent") subagentTool = tool as unknown as SubagentToolLike;
          return target.registerTool(tool);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const subagents = registerSubagentTool(registrationPi);
  const subagentControl = (subagents as unknown as SubagentControlApi | undefined)
    ?? (subagentTool ? createSubagentControlApi(subagentTool) : undefined);
  registerSubagentCommand(pi, subagentControl);
  registerAliases(pi);
  registerSlashAutocomplete(pi);
  registerFooter(pi, goalRuntime);
  registerVariants(pi);
  registerInitCommand(pi, initRuntime, goalRuntime);
  registerLifecycleHooks(pi);
  registerContextCompaction(pi, compactionRuntime, goalRuntime);
  registerGoalSettlement(pi, goalRuntime, initRuntime, compactionRuntime);
  registerInitSettlement(pi, initRuntime);
}
