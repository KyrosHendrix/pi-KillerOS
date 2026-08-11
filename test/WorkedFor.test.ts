import assert from "node:assert/strict";
import test from "node:test";
import { formatWorkedForDuration, registerWorkedFor } from "../killeros/worked-for.ts";

function createWorkedForHarness(mode = "tui") {
  let currentTime = 0;
  let appendError;
  let idle = true;
  let pendingMessages = false;
  const appendedEntries = [];
  const handlers = new Map();
  const notices = [];
  const renderers = new Map();
  const api = {
    appendEntry: (customType, data) => {
      if (appendError) throw appendError;
      appendedEntries.push({ customType, data });
    },
    on: (event, handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerEntryRenderer: (customType, renderer) => renderers.set(customType, renderer),
  };
  const ctx = {
    hasPendingMessages: () => pendingMessages,
    isIdle: () => idle,
    mode,
    ui: { notify: (message, level) => notices.push({ message, level }) },
  };
  registerWorkedFor(api, () => currentTime);

  return {
    appendedEntries,
    emit: async (event) => {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
    notices,
    renderers,
    setAppendError: (error) => { appendError = error; },
    setIdle: (value) => { idle = value; },
    setPendingMessages: (value) => { pendingMessages = value; },
    setTime: (milliseconds) => { currentTime = milliseconds; },
  };
}

const theme = { fg: (_color, text) => text };

test("worked-for durations use compact mixed units with a one-second minimum", () => {
  assert.equal(formatWorkedForDuration(0), "1s");
  assert.equal(formatWorkedForDuration(999), "1s");
  assert.equal(formatWorkedForDuration(8_999), "8s");
  assert.equal(formatWorkedForDuration(60_000), "1m 00s");
  assert.equal(formatWorkedForDuration(125_999), "2m 05s");
  assert.equal(formatWorkedForDuration(3_600_000), "1h 00m");
  assert.equal(formatWorkedForDuration(4_379_999), "1h 12m");
  assert.equal(formatWorkedForDuration(-1), "1s");
  assert.equal(formatWorkedForDuration(Number.NaN), "1s");
});

test("a settled TUI run appends one durable timing entry measured from its first start", async () => {
  const harness = createWorkedForHarness();
  await harness.emit("session_start");
  harness.setTime(1_000);
  await harness.emit("agent_start");
  harness.setTime(4_000);
  await harness.emit("agent_start");
  harness.setTime(9_000);
  await harness.emit("agent_settled");
  await harness.emit("agent_settled");

  assert.deepEqual(harness.appendedEntries, [{
    customType: "killeros-worked-for",
    data: { version: 1, milliseconds: 8_000 },
  }]);
});

test("automatic continuations keep one timer running until the final idle settlement", async () => {
  const harness = createWorkedForHarness();
  harness.setTime(1_000);
  await harness.emit("agent_start");

  harness.setTime(4_000);
  harness.setIdle(false);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, []);

  harness.setIdle(true);
  harness.setPendingMessages(true);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, []);

  harness.setPendingMessages(false);
  harness.setTime(9_000);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, [{
    customType: "killeros-worked-for",
    data: { version: 1, milliseconds: 8_000 },
  }]);
});

test("the durable entry renders as one dim line and rejects malformed saved data", () => {
  const harness = createWorkedForHarness();
  const renderer = harness.renderers.get("killeros-worked-for");
  const component = renderer({ data: { version: 1, milliseconds: 125_000 } }, {}, theme);

  assert.deepEqual(component.render(80).map((line) => line.trimEnd()), ["✻ Worked for 2m 05s"]);
  for (const data of [undefined, {}, { version: 2, milliseconds: 1_000 }, { version: 1, milliseconds: -1 }]) {
    assert.equal(renderer({ data }, {}, theme), undefined);
  }
});

test("non-TUI modes and settlements without a started run append nothing", async () => {
  for (const mode of ["rpc", "json", "print"]) {
    const harness = createWorkedForHarness(mode);
    await harness.emit("session_start");
    await harness.emit("agent_start");
    await harness.emit("agent_settled");
    assert.deepEqual(harness.appendedEntries, [], mode);
  }

  const tui = createWorkedForHarness();
  await tui.emit("agent_settled");
  assert.deepEqual(tui.appendedEntries, []);
});

test("session boundaries discard unfinished timing and save failures stay contained", async () => {
  const harness = createWorkedForHarness();
  harness.setTime(1_000);
  await harness.emit("agent_start");
  await harness.emit("session_shutdown");
  harness.setTime(9_000);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, []);

  await harness.emit("agent_start");
  harness.setAppendError(new Error("session unavailable"));
  harness.setTime(10_000);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.notices, [{
    message: "Worked-for timing could not be saved: session unavailable",
    level: "error",
  }]);

  harness.setAppendError(undefined);
  await harness.emit("agent_settled");
  assert.deepEqual(harness.appendedEntries, []);
});
