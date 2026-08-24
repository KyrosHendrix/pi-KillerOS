import assert from "node:assert/strict";
import test from "node:test";
import { hasErrorCode } from "../killeros/errors.ts";

test("error-code narrowing rejects non-error thrown values", () => {
  for (const value of [null, "ENOENT", 1, true, [], { code: null }]) {
    assert.equal(hasErrorCode(value, "ENOENT"), false);
  }
  assert.equal(hasErrorCode({ code: "ENOENT" }, "ENOENT"), true);
  assert.equal(hasErrorCode({ code: "EEXIST" }, "ENOENT"), false);
});
