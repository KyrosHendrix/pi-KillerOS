import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COMPLETION_BELL_GLYPH,
  createNotificationPreferenceStore,
  formatNotificationTitle,
  registerCompletionNotifications,
} from "../killeros/notifications.ts";

function createTemporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-notification-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("notification preference defaults off and round-trips globally", (t) => {
  const directory = createTemporaryDirectory(t);
  const settingsPath = path.join(directory, "killeros.json");
  const store = createNotificationPreferenceStore(settingsPath);

  assert.equal(store.load(), false);
  store.save(true);
  assert.equal(store.load(), true);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { completionSound: true });
  assert.deepEqual(readdirSync(directory), ["killeros.json"]);
});

test("notification preference preserves unrelated settings", (t) => {
  const directory = createTemporaryDirectory(t);
  const settingsPath = path.join(directory, "killeros.json");
  writeFileSync(settingsPath, JSON.stringify({ futureSetting: "keep", completionSound: true }));

  createNotificationPreferenceStore(settingsPath).save(false);

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    futureSetting: "keep",
    completionSound: false,
  });
  assert.deepEqual(readdirSync(directory), ["killeros.json"]);
});

test("notification preference refuses to replace malformed settings", (t) => {
  const directory = createTemporaryDirectory(t);
  const settingsPath = path.join(directory, "killeros.json");
  writeFileSync(settingsPath, "{broken");
  const store = createNotificationPreferenceStore(settingsPath);

  assert.throws(() => store.load(), /JSON|Unexpected/u);
  assert.throws(() => store.save(true), /JSON|Unexpected/u);
  assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
  assert.deepEqual(readdirSync(directory), ["killeros.json"]);
});

test("notification preference refuses non-object settings roots", (t) => {
  const directory = createTemporaryDirectory(t);

  for (const [index, value] of [null, [], "enabled", 1, true].entries()) {
    const settingsPath = path.join(directory, `settings-${index}.json`);
    const original = JSON.stringify(value);
    writeFileSync(settingsPath, original);
    const store = createNotificationPreferenceStore(settingsPath);

    assert.throws(() => store.load(), /JSON object/u);
    assert.throws(() => store.save(true), /JSON object/u);
    assert.equal(readFileSync(settingsPath, "utf8"), original);
  }
  assert.equal(readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
});

test("notification preference creates a missing nested directory", (t) => {
  const directory = createTemporaryDirectory(t);
  const settingsPath = path.join(directory, "nested", "killeros.json");

  createNotificationPreferenceStore(settingsPath).save(true);

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { completionSound: true });
  assert.deepEqual(readdirSync(path.dirname(settingsPath)), ["killeros.json"]);
});

test("notification title follows Pi title shape and enabled suffix", () => {
  assert.equal(COMPLETION_BELL_GLYPH.codePointAt(0), 0xF009A);
  assert.equal(formatNotificationTitle("/", undefined, false), "π - /");
  assert.equal(formatNotificationTitle("/work/pi-KillerOS", undefined, false), "π - pi-KillerOS");
  assert.equal(formatNotificationTitle("/work/pi-KillerOS", undefined, true), `π - pi-KillerOS ${COMPLETION_BELL_GLYPH}`);
  assert.equal(
    formatNotificationTitle("/work/pi-KillerOS", "release check", true),
    `π - release check - pi-KillerOS ${COMPLETION_BELL_GLYPH}`,
  );
});

function createNotificationHarness(options = {}) {
  let saved = options.saved ?? false;
  let sessionName = options.sessionName;
  let idle = true;
  let pendingMessages = false;
  let selected;
  let rings = 0;
  let saves = 0;
  const commands = new Map();
  const handlers = new Map();
  const titles = [];
  const notices = [];
  const dependencies = {
    store: {
      load: () => {
        if (options.loadError) throw options.loadError;
        return saved;
      },
      save: (enabled) => {
        if (options.saveError) throw options.saveError;
        saves += 1;
        saved = enabled;
      },
    },
    ring: () => {
      if (options.ringError) throw options.ringError;
      rings += 1;
    },
  };
  const api = {
    getSessionName: () => sessionName,
    on: (event, handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: (name, command) => commands.set(name, command),
  };
  registerCompletionNotifications(api, dependencies);
  const ctx = {
    cwd: "/work/pi-KillerOS",
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    mode: options.mode ?? "tui",
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async () => selected,
      setTitle: (title) => titles.push(title),
    },
  };
  const emit = async (event, value = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
  };
  return {
    commands,
    ctx,
    emit,
    get rings() { return rings; },
    get saved() { return saved; },
    get saves() { return saves; },
    notices,
    setIdle: (value) => { idle = value; },
    setPendingMessages: (value) => { pendingMessages = value; },
    setSelected: (value) => { selected = value; },
    setSessionName: (value) => { sessionName = value; },
    titles,
  };
}

const assistantEnd = (stopReason) => ({ messages: [{ role: "assistant", stopReason }] });

async function enableNotifications(harness) {
  harness.setSelected("On");
  await harness.commands.get("notification").handler("", harness.ctx);
}

test("notification command starts off and enables without a preview", async () => {
  const harness = createNotificationHarness();

  await harness.emit("session_start");
  assert.ok(harness.commands.has("notification"));
  assert.equal(harness.commands.has("notifications"), false);
  assert.deepEqual(harness.titles, ["π - pi-KillerOS"]);
  assert.equal(harness.rings, 0);
  assert.equal(harness.saves, 0);

  await harness.commands.get("notification").handler("", harness.ctx);
  assert.equal(harness.saves, 0);
  assert.equal(harness.rings, 0);
  assert.deepEqual(harness.notices, []);
  assert.deepEqual(harness.titles, ["π - pi-KillerOS"]);

  await enableNotifications(harness);
  assert.equal(harness.saved, true);
  assert.equal(harness.saves, 1);
  assert.equal(harness.titles.at(-1), `π - pi-KillerOS ${COMPLETION_BELL_GLYPH}`);
  assert.equal(harness.rings, 0);
  assert.deepEqual(harness.notices.at(-1), { message: "Completion sound: On", level: "info" });
});

test("eligible settlements ring exactly once and final errors ring", async () => {
  const harness = createNotificationHarness({ saved: true });
  await harness.emit("session_start");

  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("stop"));
  await harness.emit("agent_settled");
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 1);

  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("error"));
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 2);
});

test("manual aborts and settlement without an active request stay silent", async () => {
  const harness = createNotificationHarness({ saved: true });
  await harness.emit("session_start");
  await harness.emit("agent_settled");

  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("aborted"));
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 0);
});

test("retries and automatic continuation ring only at the final idle boundary", async () => {
  const harness = createNotificationHarness({ saved: true });
  await harness.emit("session_start");
  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("error"));
  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("stop"));
  assert.equal(harness.rings, 0);
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 1);

  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("stop"));
  harness.setIdle(false);
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 1);

  harness.setIdle(true);
  harness.setPendingMessages(true);
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 1);

  harness.setPendingMessages(false);
  await harness.emit("agent_start");
  await harness.emit("agent_end", assistantEnd("stop"));
  await harness.emit("agent_settled");
  assert.equal(harness.rings, 2);
});

test("disabled and non-TUI notification runtimes never ring or set titles", async () => {
  const disabled = createNotificationHarness();
  await disabled.emit("session_start");
  await disabled.emit("agent_start");
  await disabled.emit("agent_end", assistantEnd("stop"));
  await disabled.emit("agent_settled");
  assert.equal(disabled.rings, 0);

  for (const mode of ["rpc", "json", "print"]) {
    const harness = createNotificationHarness({ mode, saved: true });
    await harness.emit("session_start");
    await harness.emit("agent_start");
    await harness.emit("agent_end", assistantEnd("stop"));
    await harness.emit("agent_settled");
    assert.deepEqual(harness.titles, []);
    assert.equal(harness.rings, 0);
    await harness.commands.get("notification").handler("", harness.ctx);
    assert.deepEqual(harness.notices.at(-1), { message: "/notification requires TUI mode", level: "error" });
  }
});

test("notification title tracks session names and disabling removes the glyph", async () => {
  const harness = createNotificationHarness({ saved: true });
  await harness.emit("session_start");
  harness.setSessionName("release check");
  await harness.emit("session_info_changed");
  assert.equal(harness.titles.at(-1), `π - release check - pi-KillerOS ${COMPLETION_BELL_GLYPH}`);

  harness.setSelected("Off");
  await harness.commands.get("notification").handler("", harness.ctx);
  assert.equal(harness.titles.at(-1), "π - release check - pi-KillerOS");
});

test("default notification output is exactly one standard BEL byte", (t) => {
  const agentDirectory = createTemporaryDirectory(t);
  writeFileSync(path.join(agentDirectory, "killeros.json"), JSON.stringify({ completionSound: true }));
  const moduleUrl = new URL("../killeros/notifications.ts", import.meta.url).href;
  const script = `
    import { registerCompletionNotifications } from ${JSON.stringify(moduleUrl)};
    const handlers = new Map();
    const api = {
      getSessionName: () => undefined,
      on: (name, handler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerCommand() {},
    };
    registerCompletionNotifications(api);
    const ctx = {
      cwd: process.cwd(),
      hasPendingMessages: () => false,
      isIdle: () => true,
      mode: "tui",
      ui: { notify() {}, setTitle() {} },
    };
    for (const handler of handlers.get("session_start")) await handler({}, ctx);
    for (const handler of handlers.get("agent_start")) await handler({}, ctx);
    for (const handler of handlers.get("agent_end")) {
      await handler({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
    }
    for (const handler of handlers.get("agent_settled")) await handler({}, ctx);
  `;

  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    encoding: null,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    timeout: 10_000,
  });

  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  assert.deepEqual([...result.stdout], [0x07]);
  assert.equal(result.stderr.length, 0);
});

test("notification failures stay contained and preserve disabled state", async () => {
  const loadFailure = createNotificationHarness({ loadError: new Error("invalid JSON") });
  await loadFailure.emit("session_start");
  assert.deepEqual(loadFailure.titles, ["π - pi-KillerOS"]);
  assert.deepEqual(loadFailure.notices, [{
    message: "Completion sound settings could not be read: invalid JSON",
    level: "error",
  }]);

  const saveFailure = createNotificationHarness({ saveError: new Error("read-only settings") });
  await saveFailure.emit("session_start");
  await enableNotifications(saveFailure);
  assert.equal(saveFailure.saved, false);
  assert.equal(saveFailure.rings, 0);
  assert.equal(saveFailure.titles.at(-1), "π - pi-KillerOS");
  assert.deepEqual(saveFailure.notices.at(-1), {
    message: "Completion sound setting could not be saved: read-only settings",
    level: "error",
  });

  const ringFailure = createNotificationHarness({ saved: true, ringError: new Error("stdout closed") });
  await ringFailure.emit("session_start");
  await ringFailure.emit("agent_start");
  await ringFailure.emit("agent_end", assistantEnd("stop"));
  await ringFailure.emit("agent_settled");
  assert.deepEqual(ringFailure.notices.at(-1), {
    message: "Completion sound failed: stdout closed",
    level: "error",
  });
});
