import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

export const CHILD_TOOL_BUDGET_ENV = "PI_KILLEROS_TOOL_BUDGET";

export interface ChildToolBudget {
	soft?: number;
	hard: number;
	block: "*" | string[];
}

export function parseChildToolBudget(value: string | undefined): ChildToolBudget | undefined {
	if (!value?.trim()) return undefined;
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const hard = parsed.hard;
		const soft = parsed.soft;
		const block = parsed.block;
		if (typeof hard !== "number" || !Number.isSafeInteger(hard) || hard < 1) return undefined;
		if (soft !== undefined && (typeof soft !== "number" || !Number.isSafeInteger(soft) || soft < 1 || soft > hard)) return undefined;
		if (block !== "*" && (!Array.isArray(block) || block.length === 0 || block.some((tool) => typeof tool !== "string" || !tool.trim()))) return undefined;
		return {
			hard,
			...(soft === undefined ? {} : { soft }),
			block: block === "*" ? "*" : [...new Set((block as string[]).map((tool) => tool.trim()))],
		};
	} catch {
		return undefined;
	}
}

function softNudge(budget: ChildToolBudget, calls: number): string {
	return `Tool budget soft limit reached after ${calls} tool call${calls === 1 ? "" : "s"} (soft ${budget.soft}, hard ${budget.hard}). Stop starting new browsing/search work and finalize from the context you already have.`;
}

function shouldBlock(budget: ChildToolBudget, toolName: string, calls: number): boolean {
	return calls > budget.hard && (budget.block === "*" || budget.block.includes(toolName));
}

export default function registerSubagentBudget(pi: ExtensionAPI): void {
	const budget = parseChildToolBudget(process.env[CHILD_TOOL_BUDGET_ENV]);
	if (!budget) return;
	let calls = 0;
	let nudged = false;
	const sendUserMessage = (pi as unknown as {
		sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => unknown;
	}).sendUserMessage;

	pi.on("tool_call", (event): ToolCallEventResult | void => {
		calls += 1;
		if (!nudged && budget.soft !== undefined && calls >= budget.soft) {
			nudged = true;
			try {
				sendUserMessage?.(softNudge(budget, calls), { deliverAs: "steer" });
			} catch {
				// The hard block below remains authoritative if steering is unavailable.
			}
		}
		if (!shouldBlock(budget, event.toolName, calls)) return undefined;
		return {
			block: true,
			reason: `Tool budget hard limit reached after ${calls} tool calls (hard ${budget.hard}). Finalize from the context you already have.`,
		};
	});
}
