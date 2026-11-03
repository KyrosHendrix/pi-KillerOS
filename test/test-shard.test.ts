import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assignShards, parseShard, testFiles, testSeconds, unmeasuredSeconds } from "../scripts/test-shard.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("every test file runs in exactly one shard for any shard count", () => {
  const files = testFiles();
  assert.ok(files.includes("test/RepositoryContracts.test.ts") && files.includes("test/test-shard.test.ts"));
  assert.ok(files.every((file) => /^test\/[^/]+\.test\.[^/]+$/u.test(file)), "Only files the npm test glob matches");
  for (let total = 1; total <= 10; total++) {
    const assigned = assignShards(files, total).flatMap((shard) => shard.files);
    assert.deepEqual([...assigned].sort(), files, `${total} shard(s) must cover each file once`);
  }
});

test("shard timings name only existing test files", () => {
  for (const file of Object.keys(testSeconds)) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `Remove stale timing ${file}`);
});

test("shards balance estimated time and keep unmeasured files", () => {
  const shards = assignShards(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts", "test/new.test.ts"], 2);
  assert.deepEqual(shards.map((shard) => shard.seconds), [unmeasuredSeconds * 3, unmeasuredSeconds * 2]);

  const measured = assignShards(["test/Question.e2e.test.ts", "test/Footer.e2e.test.ts", "test/runtime-receipts.e2e.test.ts", "test/Theme.test.ts"], 2);
  assert.deepEqual(measured.map((shard) => shard.files), [
    ["test/Question.e2e.test.ts", "test/Theme.test.ts"],
    ["test/runtime-receipts.e2e.test.ts", "test/Footer.e2e.test.ts"],
  ], "The slowest files go to different shards, longest first");
});

test("shard selectors must be <index>/<total> within range", () => {
  assert.deepEqual(parseShard("3/6"), { index: 3, total: 6 });
  for (const value of ["0/6", "7/6", "1", "1/0", "a/b", "1/6/2"]) assert.throws(() => parseShard(value), /<index>\/<total>/u, value);
});

test("dry run prints every shard without running tests", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/test-shard.ts", "2/3", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.match(output, /^shard 1\/3: ~\d+s$/mu);
  assert.match(output, /^shard 3\/3: ~\d+s$/mu);
  assert.match(output, /^ {2}test\/Question\.e2e\.test\.ts$/mu);
  assert.doesNotMatch(output, /^ℹ tests/mu, "A dry run must not start the test runner");
});
