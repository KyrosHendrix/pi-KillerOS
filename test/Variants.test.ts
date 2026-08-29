import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, getCommand, last, requireInteractive, theme, type TestInteractive, type TestModel, type TestTui } from "./ExtensionTestHarness.ts";

type TestNotification = { message: string; level?: string };

type TestCustomFactory<T> = (
  tui: TestTui,
  theme: Theme,
  keybindings: ReturnType<typeof getKeybindings>,
  done: (value: T) => void,
) => unknown;

type VariantsContext = {
  mode: "tui";
  model: TestModel;
  ui: {
    custom<T>(factory: TestCustomFactory<T>): Promise<T>;
    notify(message: string, level?: string): void;
  };
};

async function startVariants({
  terminalRows = 40,
  current = "high",
  keybindings = getKeybindings(),
}: {
  terminalRows?: number;
  current?: string;
  keybindings?: ReturnType<typeof getKeybindings>;
} = {}) {
  const harness = createHarness();
  const selectedLevels: string[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const tui: TestTui = { requestRender() {}, terminal: { rows: terminalRows } };
  let component: TestInteractive | undefined;
  harness.api.getThinkingLevel = () => current;
  harness.api.setThinkingLevel = (level: string) => { selectedLevels.push(level); };
  const ctx: VariantsContext = {
    mode: "tui",
    model: {
      provider: "test",
      id: "reasoner",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
    ui: {
      custom: <T>(factory: TestCustomFactory<T>) => new Promise<T>((resolve) => {
        component = requireInteractive(factory(tui, theme, keybindings, resolve));
      }),
      notify: (message: string, level?: string) => { notifications.push({ message, level }); },
    },
  };
  const result = getCommand(harness, "variants").handler("", ctx);
  assert.ok(component);
  return { ...harness, component, notifications, result, selectedLevels, tui };
}

test("/variants validates direct levels and model support", async () => {
  const { api, commands } = createHarness();
  const selectedLevels: string[] = [];
  const notifications: TestNotification[] = [];
  api.setThinkingLevel = (level) => selectedLevels.push(level);
  const ctx = {
    mode: "tui",
    model: {
      provider: "\x1b]2;owned\x07\x1b[31mtest\x1b[0m",
      id: "reasoner\nspoof\0",
      reasoning: true,
    },
    ui: {
      custom: () => { throw new Error("direct variants must not open the selector"); },
      notify: (message: string, level?: string) => notifications.push({ message, level }),
    },
  };
  const variants = getCommand(commands, "variants");

  await variants.handler("deep", ctx);
  await variants.handler("xhigh", ctx);
  await variants.handler("\x1b]2;owned\x07\x1b[31munknown\x1b[0m\nspoof\0", ctx);

  assert.deepEqual(selectedLevels, ["high"]);
  assert.match(notifications[0].message, /Thinking: High/u);
  assert.match(notifications[1].message, /Extra High is not supported/u);
  assert.match(notifications[1].message, /test\/reasonerspoof/u);
  assert.doesNotMatch(notifications[1].message, /\x1b|\x07|\0|\n/u);
  assert.match(notifications[2].message, /Unknown reasoning level/u);
  assert.match(notifications[2].message, /"unknownspoof"/u);
  assert.doesNotMatch(notifications[2].message, /\x1b|\x07|\0|\n/u);

  await variants.handler("", { ...ctx, model: { provider: "test", id: "plain", reasoning: false } });
  assert.match(notifications[3].message, /does not support extended reasoning/u);

  await variants.handler("", { ...ctx, mode: "rpc" });
  assert.match(notifications[4].message, /Use \/variants <level> outside TUI mode/u);
});

test("/variants initially focuses the current level and submits it", async () => {
  const variants = await startVariants({ current: "high" });
  const rendered = variants.component.render(80).join("\n");

  assert.match(rendered, /→ High ← current/u);
  variants.component.handleInput("\r");
  await variants.result;
  assert.deepEqual(variants.selectedLevels, ["high"]);
});

test("/variants stays within terminal bounds and preserves focus across resizes", async () => {
  const variants = await startVariants({ current: "high" });
  variants.component.handleInput("\x1B[B");

  for (const rows of [12, 8, 7, 4, 3, 2, 1, 0]) {
    variants.tui.terminal.rows = rows;
    const rendered = variants.component.render(24);
    assert.ok(rendered.length <= rows, `${rendered.length} rows rendered into a ${rows}-row terminal`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 24));
  }

  variants.tui.terminal.rows = 12;
  const fullLayout = variants.component.render(24);
  assert.equal(fullLayout.length, 12);
  assert.match(fullLayout.join("\n"), /→ Extra High/u);
  assert.match(last(fullLayout) ?? "", /^─+$/u);
  assert.deepEqual(variants.component.render(0), []);
  variants.component.handleInput("\r");
  await variants.result;
  assert.deepEqual(variants.selectedLevels, ["xhigh"]);
});

test("/variants follows remapped selector bindings and cancellation", async () => {
  const previous = getKeybindings();
  const remapped = new TuiKeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.down": "ctrl+n",
    "tui.select.up": "ctrl+p",
    "tui.select.confirm": "ctrl+y",
    "tui.select.cancel": "ctrl+g",
  });
  setKeybindings(remapped);
  try {
    const variants = await startVariants({ current: "high", keybindings: remapped });
    variants.component.handleInput("\x1B[B");
    assert.match(variants.component.render(80).join("\n"), /→ High ← current/u);
    variants.component.handleInput("\x0E");
    const rendered = variants.component.render(80).join("\n");
    assert.match(rendered, /→ Extra High/u);
    assert.match(rendered, /ctrl\+p.*ctrl\+n/u);
    variants.component.handleInput("\x07");
    await variants.result;
    assert.deepEqual(variants.selectedLevels, []);
  } finally {
    setKeybindings(previous);
  }
});
