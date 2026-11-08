import assert from "node:assert/strict";
import test from "node:test";
import { containsLikelySecret } from "../killeros/secret-detector.ts";

// Handoff refuses to save a summary this detector flags, so each pattern needs a value that must match
// and a near miss that must not. Handoff.e2e.test.ts covers the refusal in real Pi.
// Values are assembled from parts so no complete credential-shaped string sits in the repository.

const repeat = (character: string, count: number): string => character.repeat(count);

// Tokens match anywhere in the text.
const tokens: ReadonlyArray<readonly [label: string, value: string]> = [
  ["private key", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`],
  ["encrypted private key", `-----BEGIN ${"ENCRYPTED"} PRIVATE KEY-----`],
  ["AWS access key", `AKIA${repeat("Q", 16)}`],
  ["AWS session key", `ASIA${repeat("7", 16)}`],
  ["Google API key", `AIza${repeat("b", 35)}`],
  ["GitHub token", `ghp_${repeat("a", 36)}`],
  ["GitHub server token", `ghs_${repeat("Z", 40)}`],
  ["GitHub fine-grained token", `github_pat_${repeat("x", 22)}`],
  ["GitLab token", `glpat-${repeat("k", 20)}`],
  ["npm token", `npm_${repeat("n", 36)}`],
  ["OpenAI key", `sk-${repeat("o", 40)}`],
  ["Anthropic key", `sk-ant-${repeat("a", 40)}`],
  ["OpenAI project key", `sk-proj-${repeat("p", 40)}`],
  ["Stripe live key", `sk_live_${repeat("s", 24)}`],
  ["Slack token", `xoxb-${repeat("1", 12)}`],
  ["URL credentials", `https://deploy:${"hunter2"}@example.test/repo.git`],
];

// Key/value assignments match only at the start of a line, so prose that mentions a password is not flagged.
const assignments: ReadonlyArray<readonly [label: string, value: string]> = [
  ["assignment", `api_key = "${"abc123"}"`],
  ["YAML password", `password: ${"correct-horse"}`],
  ["bulleted token", `- GITHUB_TOKEN: ${"value"}`],
  ["bold secret", `**client_secret**: ${"value"}`],
];

test("every token pattern flags a real-shaped value, alone and inside prose", () => {
  for (const [label, value] of tokens) {
    assert.equal(containsLikelySecret(value), true, `${label} alone`);
    assert.equal(containsLikelySecret(`## Context\n\nThe run used ${value} before stopping.\n`), true, `${label} in prose`);
  }
});

test("every assignment pattern flags a credential line in a summary, but not a mid-sentence mention", () => {
  for (const [label, value] of assignments) {
    assert.equal(containsLikelySecret(value), true, `${label} alone`);
    assert.equal(containsLikelySecret(`## Context\n\n${value}\n\nThe run stopped.\n`), true, `${label} on its own line`);
    assert.equal(containsLikelySecret(`The run set ${value} earlier.`), false, `${label} mid-sentence is prose`);
  }
});

test("Markdown quotes and tables cannot hide an assignment", () => {
  assert.equal(containsLikelySecret(`> > password: ${"hunter2"}`), true, "Nested blockquote");
  assert.equal(containsLikelySecret(`| password | ${"hunter2"} |`), true, "Table row");
  assert.equal(containsLikelySecret(`| Setting | Value |\n| --- | --- |\n| api_key | ${"abc123"} |`), true, "Table body row");
});

test("near misses and ordinary handoff prose are not credentials", () => {
  const ordinary = [
    "## Goal\nFinish the settings migration and run npm run check.",
    "The token budget is 4,000 and the password field is now required.",
    "Rotate the API key in the dashboard; do not paste it here.",
    "Use AKIA-style prefixes only in docs.",
    `AKIA${repeat("Q", 15)}`,
    `ghp_${repeat("a", 35)}`,
    `sk-${repeat("o", 19)}`,
    `xoxb-${repeat("1", 9)}`,
    "https://example.test/repo.git",
    "https://user@example.test/repo.git",
    "-----BEGIN PUBLIC KEY-----",
    "password:",
  ];
  for (const text of ordinary) assert.equal(containsLikelySecret(text), false, JSON.stringify(text));
});
