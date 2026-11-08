import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOM_INPUT_HISTORY_BYTES, CUSTOM_INPUT_HISTORY_LIMIT, createCustomInputHistory } from "../killeros/question-ui.ts";

// Question.e2e.test.ts covers reuse, deduplication, and the Recent answers dialog in real Pi.

test("custom answer history keeps the newest hundred distinct answers", () => {
  const history = createCustomInputHistory();
  for (let index = 0; index <= CUSTOM_INPUT_HISTORY_LIMIT; index++) assert.equal(history.remember(`answer-${index}`), true);
  assert.equal(history.entries.length, 100);
  assert.equal(history.entries[0], "answer-1", "The 101st distinct answer evicts the oldest");
  assert.equal(history.entries.at(-1), "answer-100");
});

test("custom answer history moves a repeated answer to the newest slot without growing", () => {
  const history = createCustomInputHistory();
  for (const answer of ["First", "Second", "First"]) history.remember(answer);
  assert.deepEqual(history.entries, ["Second", "First"]);
});

test("custom answer history bounds total bytes and rejects one oversized answer", () => {
  const history = createCustomInputHistory();
  const quarter = "é".repeat(CUSTOM_INPUT_HISTORY_BYTES / 8);
  const answers = ["a", "b", "c", "d", "e"].map((prefix) => prefix + quarter.slice(1));
  for (const answer of answers) assert.equal(history.remember(answer), true);
  assert.deepEqual(history.entries, answers.slice(1), "A fifth quarter-sized answer evicts the oldest");
  assert.equal(history.remember("x".repeat(CUSTOM_INPUT_HISTORY_BYTES + 1)), false);
  assert.deepEqual(history.entries, answers.slice(1), "A rejected answer leaves history unchanged");
  history.clear();
  assert.deepEqual(history.entries, []);
  assert.equal(history.remember("x".repeat(CUSTOM_INPUT_HISTORY_BYTES)), true, "Clearing releases the byte budget");
});
