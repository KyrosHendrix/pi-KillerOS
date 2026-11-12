import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Resolves once every Git child in the trace2 event file `trace` has exited and none has started for
 * `quietMs`. Reports how long it waited and how many children were running when it first looked.
 *
 * Windows refuses to move or rename a path while a Git child has it, or a file inside it, open. A
 * scenario that moves repository metadata under a running Pi waits here first and then moves it once.
 * Pi's first footer scan of a new repository changes .git/objects, which its own watcher answers with
 * a second scan after a 250 ms debounce. The quiet period outlasts that debounce and the 500 ms watch
 * cooldown the footer scenarios use, so the wait cannot end in the gap between two scans.
 */
export async function gitReadersFinished(
  trace: string,
  signal: AbortSignal,
  quietMs = 1_000,
): Promise<{ waitedMs: number; runningAtEntry: number }> {
  const startedAt = Date.now();
  let runningAtEntry: number | undefined;
  let seen = "";
  let changedAt = startedAt;
  while (true) {
    const contents = existsSync(trace) ? readFileSync(trace, "utf8") : "";
    if (contents !== seen) {
      seen = contents;
      changedAt = Date.now();
    }
    // Git appends whole lines; a line still being written is counted on the next read.
    const events = contents.slice(0, contents.lastIndexOf("\n") + 1).split("\n").filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .map((entry) => typeof entry === "object" && entry !== null && "event" in entry ? entry.event : undefined);
    const running = events.filter((event) => event === "start").length - events.filter((event) => event === "exit").length;
    runningAtEntry ??= running;
    if (events.length > 0 && running === 0 && Date.now() - changedAt >= quietMs) {
      return { waitedMs: Date.now() - startedAt, runningAtEntry };
    }
    assert.ok(Date.now() - startedAt < 20_000, `Git readers did not finish: ${running} still running after ${events.length} trace events`);
    await delay(25, undefined, { signal });
  }
}
