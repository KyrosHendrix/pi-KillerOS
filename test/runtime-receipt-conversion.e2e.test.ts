import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { isRecord } from "./support/ReceiptGitScenario.ts";

// The conversion matrix runs in its own file so the scheduler can overlap it with the other receipt-git scenarios.
test("native receipt paths agree with Git across the complete conversion matrix", { timeout: 420_000 }, async t => {
  const runGroup = async (autoCrlf: "false" | "true" | "input"): Promise<{ inputs: number; turns: number }> => {
    const worker = new Worker(new URL("./support/receipt-git-conversion-worker.ts", import.meta.url), {
      workerData: autoCrlf, execArgv: ["--experimental-strip-types"],
    });
    const cancel = (): void => { worker.postMessage("abort"); };
    t.signal.addEventListener("abort", cancel, { once: true });
    if (t.signal.aborted) cancel();
    let result: unknown;
    let failure: unknown;
    worker.once("message", value => { result = value; });
    worker.once("error", error => { failure = error; });
    const code = await new Promise<number>(resolve => worker.once("exit", resolve));
    t.signal.removeEventListener("abort", cancel);
    // Nested causes are truncated by the reporter, so the worker's own error text goes in the message.
    const detail = failure instanceof Error ? failure.stack ?? failure.message : String(failure);
    if (failure !== undefined || code !== 0) throw new Error(`Conversion group ${autoCrlf} failed (exit ${code}): ${detail}`, { cause: failure });
    assert.ok(isRecord(result) && typeof result.inputs === "number" && typeof result.turns === "number");
    return { inputs: result.inputs, turns: result.turns };
  };
  const results = await Promise.allSettled((["false", "true", "input"] as const).map(runGroup));
  const failures = results.filter(result => result.status === "rejected").map(result => new Error("Conversion group failed", { cause: result.reason }));
  if (failures.length) throw new AggregateError(failures, "Native conversion groups failed");
  const completed = results.filter(result => result.status === "fulfilled").map(result => result.value);
  const inputs = completed.reduce((sum, group) => sum + group.inputs, 0);
  const turns = completed.reduce((sum, group) => sum + group.turns, 0);
  assert.equal(inputs, 3564, "1,188 distinct attribute, index, and worktree cases for each autocrlf mode");
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-conversion-matrix", piLaunches: 3, providerRequests: turns,
    inputCases: inputs, oracle: "actual Git hash-object for every path", cleanup: "natural" }));
});
