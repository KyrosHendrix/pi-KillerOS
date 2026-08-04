import assert from "node:assert/strict";
import test from "node:test";
import {
  formatThreadBoard,
  formatThreadControls,
} from "../killeros/subagent-ui.ts";
import {
  registerSlashAutocomplete,
  registerSubagentCommand,
} from "../killeros/commands.ts";

const activeThread = {
  id: "auth-audit",
  displayName: "auth-audit",
  agent: "reviewer",
  status: "running",
  task: "Review auth",
};

function controlResult(text = "ok", threads = [activeThread]) {
  return { text, details: { results: threads } };
}

function registerCommandHarness(execute) {
  let command;
  const pi = {
    registerCommand(name, options) {
      if (name === "subagents") command = options;
    },
  };
  registerSubagentCommand(pi, { execute });
  assert.ok(command);
  return command;
}

function context(mode, overrides = {}) {
  const prompts = [];
  const notifications = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    signal: undefined,
    ui: {
      select: async (title, options) => {
        prompts.push({ kind: "select", title, options });
        return options[0];
      },
      input: async (title) => {
        prompts.push({ kind: "input", title });
        return "Continue the review";
      },
      notify: (message, level) => notifications.push({ message, level }),
    },
    ...overrides,
  };
  return { ctx, prompts, notifications };
}

test("/subagents opens a TUI thread selector and runs the selected action", async () => {
  const calls = [];
  const command = registerCommandHarness(async (request) => {
    if (request.action === "list") return controlResult("threads");
    calls.push(request);
    return controlResult("Stopped");
  });
  const { ctx } = context("tui", {
    ui: {
      select: async (title, options) => title.includes("thread") ? options[0] : "Interrupt",
      input: async () => undefined,
      notify() {},
    },
  });

  await command.handler("", ctx);

  assert.deepEqual(calls, [{ action: "interrupt", threadId: "auth-audit" }]);
});

test("/subagents steer prompts for a message and preserves spaces", async () => {
  const calls = [];
  const command = registerCommandHarness((request) => {
    calls.push(request);
    return controlResult("queued");
  });
  const { ctx } = context("rpc");

  await command.handler("steer auth-audit review the error path", ctx);

  assert.deepEqual(calls, [{ action: "steer", threadId: "auth-audit", message: "review the error path" }]);
});

test("RPC command mode accepts explicit wait and resume syntax without prompting", async () => {
  const calls = [];
  const command = registerCommandHarness((request) => {
    calls.push(request);
    return controlResult("ok");
  });
  const { ctx, prompts } = context("rpc");

  await command.handler("wait auth-audit 5000", ctx);
  await command.handler("resume auth-audit Continue from the saved session", ctx);

  assert.deepEqual(calls, [
    { action: "wait", threadId: "auth-audit", timeoutMs: 5000 },
    { action: "resume", threadId: "auth-audit", task: "Continue from the saved session" },
  ]);
  assert.deepEqual(prompts, []);
});

test("explicit verbs map to the canonical control requests", async () => {
  const calls = [];
  const command = registerCommandHarness((request) => {
    calls.push(request);
    return controlResult("ok");
  });
  const { ctx } = context("rpc");

  for (const args of [
    "list",
    "inspect auth-audit",
    "wait auth-audit 2500",
    "steer auth-audit use the audit role",
    "interrupt all",
    "collect auth-audit",
    "resume auth-audit check the retry",
    "close auth-audit",
  ]) {
    await command.handler(args, ctx);
  }

  assert.deepEqual(calls, [
    { action: "list" },
    { action: "inspect", threadId: "auth-audit" },
    { action: "wait", threadId: "auth-audit", timeoutMs: 2500 },
    { action: "steer", threadId: "auth-audit", message: "use the audit role" },
    { action: "interrupt", threadId: "all" },
    { action: "collect", threadId: "auth-audit" },
    { action: "resume", threadId: "auth-audit", task: "check the retry" },
    { action: "close", threadId: "auth-audit" },
  ]);
});

test("invalid non-TUI command reports the exact grammar", async () => {
  const command = registerCommandHarness(() => controlResult("unused"));
  const { ctx } = context("rpc");

  await assert.rejects(() => command.handler("steer auth-audit", ctx), /requires a message/iu);
});

test("bare /subagents rejects in RPC, JSON, and print modes without prompting", async () => {
  for (const mode of ["rpc", "json", "print"]) {
    const calls = [];
    const command = registerCommandHarness((request) => {
      calls.push(request);
      return controlResult("unused");
    });
    const { ctx, prompts } = context(mode, {
      ui: {
        select: async () => { throw new Error("select must not run"); },
        input: async () => { throw new Error("input must not run"); },
        notify() {},
      },
    });

    await assert.rejects(() => command.handler("", ctx), /explicit verb/iu);
    assert.deepEqual(calls, []);
    assert.deepEqual(prompts, []);
  }
});

test("Wait and Resume controls follow the shared enabled-state rules", () => {
  const active = Object.fromEntries(formatThreadControls("running").map((control) => [control.id, control.enabled]));
  const done = Object.fromEntries(formatThreadControls("complete").map((control) => [control.id, control.enabled]));

  assert.equal(active.wait, true);
  assert.equal(active.resume, false);
  assert.equal(done.wait, false);
  assert.equal(done.resume, true);
});

test("thread board keeps names and attempts and labels orphaned records", () => {
  const board = formatThreadBoard({
    threads: [{
      id: "subagent-1",
      displayName: "auth-audit",
      attempt: 2,
      agent: "reviewer",
      task: "Review auth",
      status: "orphaned",
      terminationReason: "parent_restarted",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3, turns: 1 },
    }],
    selectedThreadId: "subagent-1",
  });

  assert.equal(board.done[0].displayName, "auth-audit");
  assert.equal(board.done[0].attempt, 2);
  assert.equal(board.selected.state.label, "Orphaned");
  assert.equal(board.selected.displayName, "auth-audit");
  assert.equal(board.selected.attempt, 2);
});

test("bare TUI labels orphaned threads as orphaned", async () => {
  const prompts = [];
  const command = registerCommandHarness(async (request) => {
    if (request.action === "list") return controlResult("threads", [{
      ...activeThread,
      status: "orphaned",
      terminationReason: "parent_restarted",
    }]);
    return controlResult("ok");
  });
  const { ctx } = context("tui", {
    ui: {
      select: async (title, options) => {
        prompts.push({ title, options });
        return options[0];
      },
      input: async () => undefined,
      notify() {},
    },
  });

  await command.handler("", ctx);

  assert.match(prompts[0].options[0], /orphaned/iu);
});

test("autocomplete exposes the canonical /subagents syntax once", async () => {
  let factory;
  const handlers = new Map();
  const pi = {
    getCommands: () => [{ name: "subagents", description: "Inspect and control child threads", source: "extension" }],
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  registerSlashAutocomplete(pi);
  const ctx = {
    mode: "tui",
    ui: {
      addAutocompleteProvider: (value) => { factory = value; },
    },
  };
  await handlers.get("session_start")({}, ctx);
  const current = {
    applyCompletion: () => undefined,
    getSuggestions: async () => ({ prefix: "/", items: [] }),
    shouldTriggerFileCompletion: () => true,
  };
  const provider = factory(current);
  const result = await provider.getSuggestions(["/sub"], 0, 4, {});
  const matches = result.items.filter((item) => item.label === "/subagents");

  assert.equal(matches.length, 1);
  assert.match(matches[0].description, /\/subagents \[list\|inspect\|wait\|steer\|interrupt\|collect\|resume\|close\] \[thread\]/u);
});
