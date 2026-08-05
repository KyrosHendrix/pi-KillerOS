import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const product = readFileSync(new URL("../PRODUCT.md", import.meta.url), "utf8");
const design = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

test("peer ranges enforce the documented lower bounds", () => {
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-ai": ">=0.82.1",
    "@earendil-works/pi-coding-agent": ">=0.82.1",
    "@earendil-works/pi-tui": ">=0.82.1",
    "pi-web-access": ">=0.17.1",
    typebox: ">=1.1.38 <2",
  });
});

test("product and design docs match current runtime contracts", () => {
  assert.match(readme, /writerConcurrency[\s\S]*one shared slot|one shared slot[\s\S]*writerConcurrency/u);
  assert.doesNotMatch(readme, /no default[^.]*JSONL[- ]line/iu);
  assert.match(readme, /bounded default JSONL record|8 MiB|8 MiB JSONL/u);
  assert.match(product, /retained telemetry/u);
  assert.doesNotMatch(product, /context remaining, and loaded package capabilities/u);
  assert.match(design, /dynamic|package version|v<package version>/iu);
  assert.doesNotMatch(design, /\(v1\.2\.0\)/u);
  assert.match(changelog, /one shared slot[\s\S]*8 MiB[\s\S]*scoped atomic/u);
  assert.doesNotMatch(changelog, /Removed default child wall-time, JSONL-line/iu);
  assert.match(readme, /display name|named child|--name/iu);
  assert.match(readme, /action `wait`|`wait` action/iu);
  assert.match(readme, /action `resume`|`resume` action/iu);
  assert.match(readme, /30 minutes|1_800_000|1,800,000/iu);
  assert.match(readme, /64 turns/iu);
  assert.match(readme, /2,000,000 reported tokens/iu);
  assert.match(readme, /static launch receipt/iu);
  assert.match(readme, /\/subagents/iu);
  assert.match(product, /parent session|appendEntry|persistent child session/iu);
  assert.match(design, /orphaned|parent_restarted/iu);
  assert.match(changelog, /named|wait|resume|30-minute/iu);
});
