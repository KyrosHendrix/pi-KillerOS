import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuestionDetails } from "./question.ts";
import type { WorkflowAdapter, WorkflowPolicy, WorkflowToolAuthorization } from "./workflow-gate.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "question"] as const;

const DOCUMENTATION_PATHS: readonly RegExp[] = [
  /^(?:docs\/)?(?:glossary|context-map)(?:\.md|\/|$)/u,
  /^docs\/adr\/[^/]+\.md$/u,
];

function relativePath(input: Readonly<Record<string, unknown>>, ctx: ExtensionContext): string | undefined {
  if (typeof input.path !== "string" || input.path.trim().length === 0) return;
  const absolute = path.resolve(ctx.cwd, input.path);
  const relative = path.relative(ctx.cwd, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  return relative.replaceAll(path.sep, "/").toLocaleLowerCase();
}

function authorizeDocumentationTool(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  ctx: ExtensionContext,
): WorkflowToolAuthorization {
  if (toolName !== "edit" && toolName !== "write") return true;
  const target = relativePath(input, ctx);
  if (target && DOCUMENTATION_PATHS.some((pattern) => pattern.test(target))) return true;
  return "With docs policy permits writes only to the agreed glossary, context-map, and ADR paths";
}

const NORMAL_POLICY: WorkflowPolicy = {
  id: "normal",
  allowedTools: READ_ONLY_TOOLS,
};

const WITH_DOCS_POLICY: WorkflowPolicy = {
  id: "with-docs",
  allowedTools: [...READ_ONLY_TOOLS, "edit", "write"],
  authorizeTool: authorizeDocumentationTool,
};

const POLICIES = [NORMAL_POLICY, WITH_DOCS_POLICY] as const;

function selectedAnswer(details: QuestionDetails): string | undefined {
  if (!("answer" in details) || details.answer === null) return;
  return details.answer;
}

export function createDecisionGatedWorkflowAdapter(): WorkflowAdapter {
  return {
    id: "decision-gated-workflow",
    activation: "decision-gated-workflow",
    question: {
      question: "Choose the policy for this workflow before the model starts",
      options: [
        {
          label: "Normal",
          description: "Interview and read-only work; implementation files stay protected.",
        },
        {
          label: "With docs",
          description: "Allow only agreed glossary, context-map, or ADR documentation writes.",
        },
      ],
    },
    policies: POLICIES,
    selectPolicy(details) {
      switch (selectedAnswer(details)) {
        case "Normal": return NORMAL_POLICY;
        case "With docs": return WITH_DOCS_POLICY;
        default: return undefined;
      }
    },
  };
}
