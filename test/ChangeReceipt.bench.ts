import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test, { after } from "node:test";
import { beginChangeReceipt, disposeChangeReceipts } from "../killeros/change-receipt.ts";

after(disposeChangeReceipts);

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("change collection stays within the 100 ms p95 budget", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "killeros-change-bench-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "killeros@example.invalid");
  git(root, "config", "user.name", "KillerOS benchmark");
  for (let index = 0; index < 200; index += 1) {
    await writeFile(path.join(root, `tracked-${index.toString().padStart(3, "0")}.txt`), `tracked ${index}\n`);
  }
  await writeFile(path.join(root, "binary.bin"), Buffer.alloc(1024 * 1024, 7));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  for (let index = 0; index < 20; index += 1) {
    await writeFile(path.join(root, `tracked-${index.toString().padStart(3, "0")}.txt`), `pre-existing ${index}\n`);
  }
  for (let index = 0; index < 10; index += 1) {
    await writeFile(path.join(root, `untracked-${index}.txt`), `untracked ${index}\n`);
  }

  const durations: number[] = [];
  for (let cycle = 0; cycle < 110; cycle += 1) {
    const baselineStartedAt = performance.now();
    const collection = await beginChangeReceipt(root);
    const baselineDuration = performance.now() - baselineStartedAt;
    for (let index = 20; index < 25; index += 1) {
      await writeFile(path.join(root, `tracked-${index.toString().padStart(3, "0")}.txt`), `cycle ${cycle}\n`);
    }
    const settlementStartedAt = performance.now();
    const summary = await collection.finish();
    const duration = baselineDuration + performance.now() - settlementStartedAt;
    assert.equal(summary.state, "available");
    if (cycle >= 10) durations.push(duration);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Infinity;
  t.diagnostic(`p95 ${p95.toFixed(1)} ms`);
  assert.ok(p95 <= 100, `p95 ${p95.toFixed(1)} ms exceeded 100 ms`);
});
