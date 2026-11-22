import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

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
    const events = contents
      .slice(0, contents.lastIndexOf("\n") + 1)
      .split("\n")
      .filter(Boolean)
      .map((line): unknown => JSON.parse(line))
      .map((entry) =>
        typeof entry === "object" && entry !== null && "event" in entry
          ? entry.event
          : undefined,
      );
    const running =
      events.filter((event) => event === "start").length -
      events.filter((event) => event === "exit").length;
    runningAtEntry ??= running;
    if (
      events.length > 0 &&
      running === 0 &&
      Date.now() - changedAt >= quietMs
    ) {
      return { waitedMs: Date.now() - startedAt, runningAtEntry };
    }
    assert.ok(
      Date.now() - startedAt < 20_000,
      `Git readers did not finish: ${running} still running after ${events.length} trace events`,
    );
    await delay(25, undefined, { signal });
  }
}
