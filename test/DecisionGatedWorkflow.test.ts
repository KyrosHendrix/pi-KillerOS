import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createDecisionGatedWorkflowAdapter } from "../killeros/decision-gated-workflow.ts";
import { registerQuestionTool, type QuestionDetails, type QuestionRunner } from "../killeros/question.ts";
import { registerWorkflowGate, type WorkflowAdapter } from "../killeros/workflow-gate.ts";

type TestHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface TestContextData {
  notifications: Array<{ message: string; type: string | undefined }>;
  ctx: ExtensionContext;
}

function createContext(mode: "tui" | "print" = "tui"): TestContextData {
  const notifications: TestContextData["notifications"] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui",
    cwd: process.cwd(),
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string, type?: string) => notifications.push({ message, type }),
    },
  } as unknown as ExtensionContext;
  return { notifications, ctx };
}

function createHarness(
  runner: QuestionRunner,
  adapters: readonly WorkflowAdapter[],
): {
  controller: ReturnType<typeof registerWorkflowGate>;
  emit: (eventName: string, event: unknown, ctx: ExtensionContext) => Promise<unknown>;
} {
  const handlers = new Map<string, TestHandler[]>();
  const api = {
    on(eventName: string, handler: TestHandler): void {
      const current = handlers.get(eventName) ?? [];
      current.push(handler);
      handlers.set(eventName, current);
    },
  } as unknown as ExtensionAPI;
  const controller = registerWorkflowGate(api, runner, adapters);
  return {
    controller,
    async emit(eventName, event, ctx): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        result = await handler(event, ctx);
        if (typeof result === "object" && result !== null && "block" in result && result.block === true) break;
      }
      return result;
    },
  };
}

function selected(answer: string): QuestionDetails {
  return { question: "Choose", options: ["Normal", "With docs"], answer, selectedIndex: 1, wasCustom: false };
}

function toolCall(toolName: string, input: Record<string, unknown> = {}): unknown {
  return { type: "tool_call", toolCallId: toolName, toolName, input };
}

test("workflow decisions reuse the registered question UI and structured result", async () => {
  let registered = false;
  let component: { handleInput: (data: string) => void } | undefined;
  const api = {
    on: () => {},
    registerTool: () => { registered = true; },
  } as unknown as ExtensionAPI;
  const runner = registerQuestionTool(api);
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    underline: (text: string) => text,
  };
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => { handleInput: (data: string) => void }) => {
        return new Promise((resolve) => {
          component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, getKeybindings(), resolve);
        });
      },
      notify: () => {},
    },
  } as unknown as ExtensionContext;
  assert.equal(registered, true);
  const resultPromise = runner.ask({ question: "Choose", options: [{ label: "Normal" }, { label: "With docs" }] }, undefined, ctx);
  await Promise.resolve();
  assert.ok(component);
  component.handleInput("\r");
  const result = await resultPromise;
  assert.equal(result.answer, "Normal");
});

test("Pi's public input, tool, and lifecycle contracts are the gate boundary", () => {
  const events: string[] = [];
  const api = {
    on: (eventName: string) => events.push(eventName),
  } as unknown as ExtensionAPI;
  registerWorkflowGate(api, { ask: async () => selected("Normal") }, [createDecisionGatedWorkflowAdapter()]);
  assert.deepEqual(events, [
    "input",
    "tool_call",
    "session_start",
    "session_shutdown",
    "session_tree",
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
    "agent_end",
  ]);
});

test("explicit activation owns the first question before the model turn", async () => {
  const events: string[] = [];
  let answer: (details: QuestionDetails) => void = () => {};
  const runner: QuestionRunner = {
    ask: async () => {
      events.push("question");
      return new Promise<QuestionDetails>((resolve) => { answer = resolve; });
    },
  };
  const adapter = createDecisionGatedWorkflowAdapter();
  const { controller, emit } = createHarness(runner, [adapter]);
  const { ctx } = createContext();

  const inputPromise = emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  await Promise.resolve();
  assert.deepEqual(events, ["question"]);
  assert.deepEqual(controller.getState(), {
    kind: "pending_decision",
    adapterId: "decision-gated-workflow",
    activation: "decision-gated-workflow",
  });
  assert.equal((await emit("tool_call", toolCall("read"), ctx) as { block: boolean }).block, true);

  events.push("before_agent_start");
  answer(selected("Normal"));
  const inputResult = await inputPromise as { action: string };
  assert.equal(inputResult.action, "continue");
  assert.deepEqual(events, ["question", "before_agent_start"]);
  assert.deepEqual(controller.getState(), {
    kind: "active",
    adapterId: "decision-gated-workflow",
    activation: "decision-gated-workflow",
    policyId: "normal",
  });
});

test("unknown skills pass through and pending state denies every tool", async () => {
  let answer: (details: QuestionDetails) => void = () => {};
  const runner: QuestionRunner = {
    ask: async () => new Promise<QuestionDetails>((resolve) => { answer = resolve; }),
  };
  const adapter = createDecisionGatedWorkflowAdapter();
  const { controller, emit } = createHarness(runner, [adapter]);
  const { ctx } = createContext();
  const sentinel = new URL("./fixtures/decision-gated-workflow/sentinel.txt", import.meta.url);
  const before = readFileSync(sentinel);

  assert.equal(await emit("input", { type: "input", text: "/skill:unregistered" }, ctx), undefined);
  const inputPromise = emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  await Promise.resolve();
  const blockedRoute = await emit("input", { type: "input", text: "/skill:unregistered" }, ctx) as { action: string };
  assert.equal(blockedRoute.action, "handled");
  for (const toolName of ["read", "edit", "write", "bash", "custom_mutator", "question"]) {
    const result = await emit("tool_call", toolCall(toolName), ctx) as { block: boolean };
    assert.equal(result.block, true, toolName);
  }
  assert.deepEqual(readFileSync(sentinel), before);
  answer(selected("Normal"));
  await inputPromise;
  assert.equal(controller.getState().kind, "active");
  const normalEdit = await emit("tool_call", toolCall("edit", { path: "test/fixtures/decision-gated-workflow/sentinel.txt" }), ctx) as { block: boolean };
  assert.equal(normalEdit.block, true);
  assert.deepEqual(readFileSync(sentinel), before);
});

test("Normal and With docs policies keep their own allowlists", async () => {
  let answer: (details: QuestionDetails) => void = () => {};
  const runner: QuestionRunner = {
    ask: async () => new Promise<QuestionDetails>((resolve) => { answer = resolve; }),
  };
  const adapter = createDecisionGatedWorkflowAdapter();
  const { controller, emit } = createHarness(runner, [adapter]);
  const { ctx } = createContext();

  const normalInput = emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  await Promise.resolve();
  answer(selected("Normal"));
  await normalInput;
  assert.equal(await emit("tool_call", toolCall("read"), ctx), undefined);
  assert.equal((await emit("tool_call", toolCall("edit", { path: "README.md" }), ctx) as { block: boolean }).block, true);
  assert.equal((await emit("tool_call", toolCall("bash", { command: "echo no" }), ctx) as { block: boolean }).block, true);
  assert.equal(await controller.cancel(), true);

  answer = () => {};
  const docsInput = emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  await Promise.resolve();
  answer(selected("With docs"));
  await docsInput;
  assert.equal(await emit("tool_call", toolCall("edit", { path: "docs/adr/0001-example.md" }), ctx), undefined);
  assert.equal((await emit("tool_call", toolCall("edit", { path: "src/index.ts" }), ctx) as { block: boolean }).block, true);
  assert.equal((await emit("tool_call", toolCall("write", { path: "docs/notes.md" }), ctx) as { block: boolean }).block, true);
  assert.equal(await controller.finish(), true);
  assert.deepEqual(controller.getState(), { kind: "inactive" });
});

test("active policies survive ordinary prompts and serialize terminal cleanup", async () => {
  let answer: (details: QuestionDetails) => void = () => {};
  const runner: QuestionRunner = {
    ask: async () => new Promise<QuestionDetails>((resolve) => { answer = resolve; }),
  };
  let releaseFinish: () => void = () => {};
  let finishStarted: () => void = () => {};
  const finishReady = new Promise<void>((resolve) => { finishStarted = resolve; });
  const finishRelease = new Promise<void>((resolve) => { releaseFinish = resolve; });
  const baseAdapter = createDecisionGatedWorkflowAdapter();
  const adapter: WorkflowAdapter = {
    ...baseAdapter,
    onFinish: async () => {
      finishStarted();
      await finishRelease;
    },
  };
  const secondPolicy = { id: "second-policy", allowedTools: ["read"] } as const;
  const secondAdapter: WorkflowAdapter = {
    id: "second-workflow",
    activation: "second-workflow",
    question: { question: "Second", options: [{ label: "Use" }] },
    policies: [secondPolicy],
    selectPolicy: () => secondPolicy,
  };
  const { controller, emit } = createHarness(runner, [adapter, secondAdapter]);
  const { ctx } = createContext();

  const activation = emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  await Promise.resolve();
  answer(selected("Normal"));
  await activation;
  assert.equal((await emit("input", { type: "input", text: "an unrelated prompt" }, ctx)), undefined);
  assert.equal((await emit("input", { type: "input", text: "/skill:second-workflow" }, ctx) as { action: string }).action, "handled");
  assert.equal(controller.getState().kind, "active");

  const finishing = controller.finish();
  await finishReady;
  assert.deepEqual(controller.getState(), {
    kind: "terminal_cleanup",
    adapterId: "decision-gated-workflow",
    activation: "decision-gated-workflow",
    reason: "finish",
  });
  assert.equal((await emit("tool_call", toolCall("read"), ctx) as { block: boolean }).block, true);
  assert.equal(await controller.cancel(), false);
  releaseFinish();
  await finishing;
  assert.deepEqual(controller.getState(), { kind: "inactive" });
  assert.equal(await emit("tool_call", toolCall("read"), ctx), undefined);
});

test("agent failures clear the active policy even when failure cleanup rejects", async () => {
  let failure: unknown;
  const baseAdapter = createDecisionGatedWorkflowAdapter();
  const adapter: WorkflowAdapter = {
    ...baseAdapter,
    onFailure: async (error) => {
      failure = error;
      throw new Error("cleanup failed");
    },
  };
  const { controller, emit } = createHarness({ ask: async () => selected("Normal") }, [adapter]);
  const { ctx, notifications } = createContext();

  await emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  assert.equal(controller.getState().kind, "active");
  await emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", errorMessage: "provider unavailable" }],
  }, ctx);
  assert.deepEqual(controller.getState(), { kind: "inactive" });
  assert.ok(failure instanceof Error);
  assert.match(notifications.at(-1)?.message ?? "", /provider unavailable/u);
});

test("cancellation, non-TUI mode, lifecycle reset, and adapter reuse fail closed", async () => {
  let answer: (details: QuestionDetails) => void = () => {};
  const runner: QuestionRunner = {
    ask: async () => new Promise<QuestionDetails>((resolve) => { answer = resolve; }),
  };
  const secondPolicy = { id: "second-policy", allowedTools: ["read"] } as const;
  const secondAdapter: WorkflowAdapter = {
    id: "second-workflow",
    activation: "second-workflow",
    question: { question: "Second", options: [{ label: "Use" }] },
    policies: [secondPolicy],
    selectPolicy: (details) => "answer" in details && details.answer === "Use" ? secondPolicy : undefined,
  };
  const adapter = createDecisionGatedWorkflowAdapter();
  const { controller, emit } = createHarness(runner, [adapter, secondAdapter]);
  const { ctx, notifications } = createContext();

  const pending = emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, ctx);
  await Promise.resolve();
  await emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.deepEqual(controller.getState(), { kind: "inactive" });
  answer({ question: "Choose", options: ["Normal"], answer: "Normal", selectedIndex: 1, wasCustom: false });
  await pending;

  const printContext = createContext("print");
  const printResult = await emit("input", { type: "input", text: "/skill:decision-gated-workflow" }, printContext.ctx) as { action: string };
  assert.equal(printResult.action, "handled");
  assert.match(printContext.notifications[0]?.message ?? "", /requires interactive TUI mode/u);

  const secondInput = emit("input", { type: "input", text: "/skill:second-workflow" }, ctx);
  await Promise.resolve();
  answer({ question: "Second", options: ["Use"], answer: "Use", selectedIndex: 1, wasCustom: false });
  await secondInput;
  assert.deepEqual(controller.getState(), {
    kind: "active",
    adapterId: "second-workflow",
    activation: "second-workflow",
    policyId: "second-policy",
  });
  assert.equal(await emit("tool_call", toolCall("read"), ctx), undefined);
  assert.equal((await emit("tool_call", toolCall("write"), ctx) as { block: boolean }).block, true);
  assert.equal(notifications.length, 0);
});
