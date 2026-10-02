import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BoundedText } from "../killeros/bounded-text.ts";
import { last } from "./ExtensionTestHarness.ts";

test("collapsed and expanded Unicode transcript lines fit widths zero through eighty", () => {
  for (const source of ["中", "中日文".repeat(30), "😀👩‍💻".repeat(20), "e\u0301".repeat(100), "long ".repeat(100), "中\n😀\ne\u0301\n".repeat(10)]) {
    for (const limit of [undefined, 1, 3]) {
      for (let width = 0; width <= 80; width += 1) {
        const lines = new BoundedText(source, limit).render(width);
        if (width === 0) assert.deepEqual(lines, []);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}, limit ${limit}, source ${source}`);
      }
    }
  }
  assert.ok(new BoundedText("中").render(2).join("").includes("中"));
});

test("BoundedText limits collapsed rows and preserves full expanded text", () => {
  const source = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const collapsed = new BoundedText(source, 3).render(20);
  assert.equal(collapsed.length, 3);
  assert.match(last(collapsed) ?? "", /…/u);

  const expanded = new BoundedText(source).render(20);
  assert.equal(expanded.length, 20);
  assert.match(last(expanded) ?? "", /line 20/u);
});
