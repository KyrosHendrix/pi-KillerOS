import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { scheduleGitStatusFallback, scheduleGitStatusWatch } from "../killeros/footer.ts";

// Footer Git timing runs on mocked timers so its exact boundaries are checked without wall-clock waits.
// Footer.e2e.test.ts covers the installed watcher, scans, and rendering in real Pi.

type WatchHarness = { change: () => void; fail: () => void; advance: (ms: number) => void; refreshes: () => number; stop: () => void; closed: () => boolean };

function watchHarness(t: TestContext): WatchHarness {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let onChange: (() => void) | undefined;
  let onError: (() => void) | undefined;
  let closed = false;
  let refreshes = 0;
  const stop = scheduleGitStatusWatch("C:\\project", () => { refreshes++; }, (_cwd, changed, failed) => {
    onChange = changed;
    onError = failed;
    return () => { closed = true; };
  });
  assert.ok(onChange && onError, "The watcher must subscribe to changes and errors");
  // Mock timers start a timer scheduled inside a callback from the end of the current tick, so advance 1 ms at a time.
  const advance = (ms: number): void => { for (let elapsed = 0; elapsed < ms; elapsed++) t.mock.timers.tick(1); };
  return { change: onChange, fail: onError, advance, refreshes: () => refreshes, stop, closed: () => closed };
}

test("footer fallback rescans every 30 seconds until disposed", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let refreshes = 0;
  const stop = scheduleGitStatusFallback(() => { refreshes++; });
  t.mock.timers.tick(29_999);
  assert.equal(refreshes, 0, "No fallback scan before 30 seconds");
  t.mock.timers.tick(1);
  assert.equal(refreshes, 1, "The first fallback scan runs at 30 seconds");
  t.mock.timers.tick(30_000);
  assert.equal(refreshes, 2, "Fallback scans repeat every 30 seconds");
  stop();
  t.mock.timers.tick(90_000);
  assert.equal(refreshes, 2, "A disposed fallback never scans again");
});

test("footer watch debounces a burst into one scan after 250 ms", (t) => {
  const watch = watchHarness(t);
  watch.change();
  watch.advance(100);
  watch.change();
  watch.change();
  watch.advance(149);
  assert.equal(watch.refreshes(), 0, "Changes inside the debounce window do not scan yet");
  watch.advance(1);
  assert.equal(watch.refreshes(), 1, "The burst scans once, 250 ms after its first change");
  watch.advance(10_000);
  assert.equal(watch.refreshes(), 1, "A burst without later changes scans only once");
});

test("footer watch throttles sustained changes to one scan per five seconds", (t) => {
  const watch = watchHarness(t);
  // Thirteen changes 400 ms apart span 5.2 seconds of sustained activity. The first scans at 250 ms,
  // and its five-second cooldown ends at 5,250 ms.
  for (let index = 0; index < 13; index++) {
    watch.change();
    watch.advance(400);
  }
  assert.equal(watch.refreshes(), 1, "One scan runs before the five-second cooldown ends");
  watch.advance(299);
  assert.equal(watch.refreshes(), 1, "Changes queued during the cooldown wait for it, then debounce again");
  watch.advance(1);
  assert.equal(watch.refreshes(), 2, "Queued changes scan at 5,500 ms, 5.25 seconds after the first scan");
  watch.advance(10_000);
  assert.equal(watch.refreshes(), 2, "Queued changes collapse into one later scan");
});

test("footer watch stops on watcher errors and on disposal", (t) => {
  const failed = watchHarness(t);
  failed.change();
  failed.fail();
  failed.advance(10_000);
  assert.equal(failed.refreshes(), 0, "A watcher error cancels the pending scan");
  assert.ok(failed.closed(), "A watcher error closes the watcher");
  failed.change();
  failed.advance(10_000);
  assert.equal(failed.refreshes(), 0, "A stopped watch ignores later changes");
});

test("footer watch disposal closes the watcher and cancels the pending scan", (t) => {
  const watch = watchHarness(t);
  watch.change();
  watch.stop();
  watch.advance(10_000);
  assert.equal(watch.refreshes(), 0);
  assert.ok(watch.closed());
});

test("the installed footer starts the 30-second fallback", () => {
  // Real Pi would need a 30-second idle wait to observe the fallback, so its wiring is checked at the call site.
  const source = readFileSync(new URL("../killeros/footer.ts", import.meta.url), "utf8");
  assert.match(source, /const stopFallback = scheduleGitStatusFallback\(gitStatus\.request\);/u);
});
