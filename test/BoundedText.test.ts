import assert from "node:assert/strict";
import test from "node:test";
import { BoundedText } from "../killeros/bounded-text.ts";
import { last } from "./ExtensionTestHarness.ts";

test("BoundedText limits collapsed rows and preserves full expanded text", () => {
  const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const collapsed = new BoundedText(source, 3).render(20);
  assert.equal(collapsed.length, 3);
  assert.match(last(collapsed) ?? "", /…/u);

  const expanded = new BoundedText(source).render(20);
  assert.equal(expanded.length, 20);
  assert.match(last(expanded) ?? "", /line 20/u);
});
