import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("shell startup contains no synchronous child process call", () => {
  const source = readFileSync(new URL("../killeros/shell-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /execFileSync/u);
});
