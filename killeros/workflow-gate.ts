import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { QuestionDetails, QuestionParamsValue, QuestionRunner } from "./question.ts";

export type WorkflowToolAuthorization = true | false | string;

export interface WorkflowPolicy {
  id: string;
  allowedTools: readonly string[];
  authorizeTool?: (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    ctx: ExtensionContext,
  ) => WorkflowToolAuthorization;
}

export interface WorkflowAdapter {
  id: string;
  /** The existing single explicit skill activation API. */
  activation?: string;
  /** Additional explicit skill activations that share this adapter policy. */
  activations?: readonly string[];
  question: QuestionParamsValue;
  policies: readonly WorkflowPolicy[];
  selectPolicy: (details: QuestionDetails) => WorkflowPolicy | undefined;
  onActivated?: (policy: WorkflowPolicy, details: QuestionDetails) => void | Promise<void>;
  onFinish?: () => void | Promise<void>;
  onCancel?: (reason: string) => void | Promise<void>;
  onFailure?: (error: unknown) => void | Promise<void>;
}

export type WorkflowGateState =
  | { kind: "inactive" }
  | { kind: "pending_decision"; adapterId: string; activation: string }
  | { kind: "active"; adapterId: string; activation: string; policyId: string }
  | { kind: "terminal_cleanup"; adapterId: string; activation: string; reason: WorkflowTerminalReason };

export interface WorkflowGateController {
  getState(): WorkflowGateState;
  finish(): Promise<boolean>;
  cancel(reason?: string): Promise<boolean>;
}

export type WorkflowTerminalReason = "finish" | "cancel" | "fail" | "session-reset";

type InternalState =
  | { kind: "inactive" }
  | {
    kind: "pending_decision";
    adapter: WorkflowAdapter;
    activation: string;
    abortController: AbortController;
    token: symbol;
  }
  | { kind: "active"; adapter: WorkflowAdapter; activation: string; policy: WorkflowPolicy; token: symbol }
  | { kind: "terminal_cleanup"; adapter: WorkflowAdapter; activation: string; reason: WorkflowTerminalReason; token: symbol };

const ACTIVATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function explicitSkillActivation(text: string): string | undefined {
  if (!text.startsWith("/skill:")) return;
  const spaceIndex = text.indexOf(" ");
  const activation = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(activation) ? activation : undefined;
}

function isCancelled(details: QuestionDetails): boolean {
  if (details.cancelled) return true;
  return "answer" in details && details.answer === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicState(state: InternalState): WorkflowGateState {
  if (state.kind === "inactive") return state;
  if (state.kind === "pending_decision") {
    return {
      kind: state.kind,
      adapterId: state.adapter.id,
      activation: state.activation,
    };
  }
  if (state.kind === "terminal_cleanup") {
    return {
      kind: state.kind,
      adapterId: state.adapter.id,
      activation: state.activation,
      reason: state.reason,
    };
  }
  return {
    kind: state.kind,
    adapterId: state.adapter.id,
    activation: state.activation,
    policyId: state.policy.id,
  };
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "error"): void {
  ctx.ui.notify(message, type);
}

function isKnownPolicy(adapter: WorkflowAdapter, policy: WorkflowPolicy): boolean {
  return adapter.policies.includes(policy);
}

async function invokeCleanup(callback: (() => void | Promise<void>) | undefined): Promise<void> {
  try {
    await callback?.();
  } catch {
    // Cleanup callbacks are best effort; the gate must still reach a terminal state.
  }
}

async function invokeCancel(
  callback: ((reason: string) => void | Promise<void>) | undefined,
  reason: string,
): Promise<void> {
  try {
    await callback?.(reason);
  } catch {
    // Cleanup callbacks are best effort; the gate must still reach a terminal state.
  }
}

async function invokeFailure(
  callback: ((error: unknown) => void | Promise<void>) | undefined,
  error: unknown,
): Promise<void> {
  try {
    await callback?.(error);
  } catch {
    // Cleanup callbacks are best effort; the gate must still reach a terminal state.
  }
}

export function registerWorkflowGate(
  pi: ExtensionAPI,
  questionRunner: QuestionRunner,
  adapters: readonly WorkflowAdapter[],
): WorkflowGateController {
  const adaptersByActivation = new Map<string, WorkflowAdapter>();
  for (const adapter of adapters) {
    if (!adapter.id.trim()) throw new Error("Decision-gated workflow adapters require an id");
    if (adapter.activations !== undefined && !Array.isArray(adapter.activations)) {
      throw new Error(`Workflow adapter ${adapter.id} activations must be an array`);
    }
    const activations = [
      ...(adapter.activation === undefined ? [] : [adapter.activation]),
      ...(adapter.activations ?? []),
    ];
    if (activations.length === 0) {
      throw new Error(`Workflow adapter ${adapter.id} must register at least one explicit skill activation`);
    }
    for (const activation of activations) {
      if (typeof activation !== "string" || !ACTIVATION_PATTERN.test(activation)) {
        throw new Error(`Invalid decision-gated workflow activation: ${activation}`);
      }
      if (adaptersByActivation.has(activation)) {
        throw new Error(`Duplicate decision-gated workflow activation: ${activation}`);
      }
      adaptersByActivation.set(activation, adapter);
    }
    if (adapter.policies.length === 0) throw new Error(`Workflow adapter ${adapter.id} has no policies`);
  }

  let state: InternalState = { kind: "inactive" };

  const transitionToCleanup = (
    current: Exclude<InternalState, { kind: "inactive" } | { kind: "terminal_cleanup" }>,
    reason: WorkflowTerminalReason,
  ): symbol => {
    state = {
      kind: "terminal_cleanup",
      adapter: current.adapter,
      activation: current.activation,
      reason,
      token: current.token,
    };
    if (current.kind === "pending_decision") current.abortController.abort();
    return current.token;
  };

  const finishCleanup = (token: symbol): void => {
    if (state.kind === "terminal_cleanup" && state.token === token) state = { kind: "inactive" };
  };

  const finish = async (): Promise<boolean> => {
    if (state.kind !== "active") return false;
    const active = state;
    const token = transitionToCleanup(active, "finish");
    await invokeCleanup(active.adapter.onFinish);
    finishCleanup(token);
    return true;
  };

  const cancel = async (reason = "Workflow cancelled"): Promise<boolean> => {
    if (state.kind === "inactive" || state.kind === "terminal_cleanup") return false;
    const current = state;
    const token = transitionToCleanup(current, "cancel");
    await invokeCancel(current.adapter.onCancel, reason);
    finishCleanup(token);
    return true;
  };

  const fail = async (
    adapter: WorkflowAdapter,
    token: symbol,
    error: unknown,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (state.kind === "inactive" || state.kind === "terminal_cleanup") return;
    if (state.adapter !== adapter || state.token !== token) return;
    const cleanupToken = transitionToCleanup(state, "fail");
    await invokeFailure(adapter.onFailure, error);
    finishCleanup(cleanupToken);
    notify(ctx, `Decision-gated workflow was not activated: ${errorMessage(error)}`);
  };

  pi.on("input", async (event, ctx) => {
    if ((state.kind === "pending_decision" || state.kind === "terminal_cleanup") && event.text.startsWith("/skill:")) {
      notify(ctx, "A decision-gated workflow is waiting for its structured question; skill routing is blocked", "warning");
      return { action: "handled" };
    }
    const activation = explicitSkillActivation(event.text);
    if (!activation) return;

    const adapter = adaptersByActivation.get(activation);
    if (!adapter) return;

    if (state.kind === "active") {
      notify(ctx, `Cannot start /skill:${activation} while a decision-gated workflow is active`, "warning");
      return { action: "handled" };
    }
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      notify(ctx, `The /skill:${activation} workflow requires interactive TUI mode`);
      return { action: "handled" };
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      notify(ctx, `The /skill:${activation} workflow can start only when Pi is idle`, "warning");
      return { action: "handled" };
    }

    const abortController = new AbortController();
    const token = Symbol();
    state = { kind: "pending_decision", adapter, activation, abortController, token };
    let details: QuestionDetails;
    try {
      details = await questionRunner.ask(adapter.question, abortController.signal, ctx);
    } catch (error) {
      if (state.kind !== "pending_decision" || state.adapter !== adapter || state.token !== token) {
        return { action: "handled" };
      }
      await fail(adapter, token, error, ctx);
      return { action: "handled" };
    }

    if (state.kind !== "pending_decision" || state.adapter !== adapter || state.token !== token) {
      return { action: "handled" };
    }
    if (isCancelled(details)) {
      await cancel("Decision question cancelled");
      notify(ctx, `The /skill:${activation} workflow was cancelled`, "warning");
      return { action: "handled" };
    }

    let policy: WorkflowPolicy | undefined;
    try {
      policy = adapter.selectPolicy(details);
    } catch (error) {
      await fail(adapter, token, error, ctx);
      return { action: "handled" };
    }
    if (!policy || !isKnownPolicy(adapter, policy)) {
      await fail(adapter, token, new Error("The structured answer did not select a registered policy"), ctx);
      return { action: "handled" };
    }

    try {
      await adapter.onActivated?.(policy, details);
    } catch (error) {
      if (state.kind !== "pending_decision" || state.adapter !== adapter || state.token !== token) {
        return { action: "handled" };
      }
      await fail(adapter, token, error, ctx);
      return { action: "handled" };
    }
    if (state.kind !== "pending_decision" || state.adapter !== adapter || state.token !== token) {
      return { action: "handled" };
    }
    state = { kind: "active", adapter, activation, policy, token };
    return { action: "continue" };
  });

  pi.on("tool_call", (event: ToolCallEvent, ctx) => {
    if (state.kind === "inactive") return;
    if (state.kind === "pending_decision" || state.kind === "terminal_cleanup") {
      return {
        block: true,
        reason: "A decision-gated workflow is waiting for its structured question; no model tool calls are allowed yet",
      };
    }

    const { policy } = state;
    if (!policy.allowedTools.includes(event.toolName)) {
      return {
        block: true,
        reason: `Tool ${event.toolName} is not allowed by decision-gated policy ${policy.id}`,
      };
    }
    const authorization = policy.authorizeTool?.(event.toolName, event.input, ctx) ?? true;
    if (authorization === true) return;
    return {
      block: true,
      reason: typeof authorization === "string"
        ? authorization
        : `Tool ${event.toolName} is denied by decision-gated policy ${policy.id}`,
    };
  });

  const resetForLifecycle = async (reason: string): Promise<void> => {
    if (state.kind === "inactive" || state.kind === "terminal_cleanup") return;
    const current = state;
    const token = transitionToCleanup(current, "session-reset");
    await invokeCancel(current.adapter.onCancel, reason);
    finishCleanup(token);
  };

  pi.on("session_start", () => resetForLifecycle("Session lifecycle reset"));
  pi.on("session_shutdown", () => resetForLifecycle("Session lifecycle reset"));
  pi.on("session_tree", () => resetForLifecycle("Session tree reset"));
  pi.on("session_before_switch", () => resetForLifecycle("Session switch reset"));
  pi.on("session_before_fork", () => resetForLifecycle("Session fork reset"));
  pi.on("session_before_tree", () => resetForLifecycle("Session tree reset"));

  pi.on("agent_end", async (event, ctx) => {
    if (state.kind !== "active") return;

    let failureMessage: string | undefined;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message?.role === "assistant" && message.errorMessage) {
        failureMessage = message.errorMessage;
        break;
      }
    }
    if (failureMessage === undefined) return;

    const active = state;
    await fail(active.adapter, active.token, new Error(failureMessage), ctx);
  });

  return {
    getState: () => publicState(state),
    finish,
    cancel,
  };
}

export { explicitSkillActivation };
