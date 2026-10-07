import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GOAL_EVIDENCE_LIMIT, parseGoalState } from "../killeros/goal-state.ts";
import {
  createHarness, createTuiContext, emitSequentially, getCommand, getTool, theme,
} from "./ExtensionTestHarness.ts";

type Harness = ReturnType<typeof createHarness>;
type Context = ReturnType<typeof createTuiContext>["ctx"];

async function emit(harness: Harness, ctx: Context, event: string, data: Record<string, unknown> = {}) {
  return emitSequentially(harness.handlers.get(event), data, ctx);
}

async function begin(harness: Harness, ctx: Context) {
  const results = await emit(harness, ctx, "before_agent_start", { systemPrompt: "Base prompt" });
  ctx.isProjectTrusted = () => false;
  await emit(harness, ctx, "agent_start");
  return results.map((result) => result?.systemPrompt ?? "").join("\n");
}

async function settle(harness: Harness, ctx: Context) {
  await emit(harness, ctx, "agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await emit(harness, ctx, "agent_settled");
}

function saved(harness: Harness) {
  const entry = harness.appendedEntries.filter((entry) => entry.customType === "killeros-goal").at(-1);
  assert.ok(entry);
  const state = parseGoalState(entry.data.state);
  assert.ok(state, "saved goal must parse after restore");
  return state;
}

function update(harness: Harness, ctx: Context, params: Record<string, unknown>, signal = new AbortController().signal) {
  return getTool(harness, "killeros_goal_update").execute("decision", params, signal, () => {}, ctx);
}

async function block(harness: Harness, ctx: Context, objective = "Audit the whole objective") {
  await getCommand(harness, "goal").handler(objective, ctx);
  for (let turn = 1; turn <= 3; turn++) {
    await begin(harness, ctx);
    const result = await update(harness, ctx, { status: "blocked", blockerKey: "external", evidence: `Missing prerequisite ${turn}` });
    assert.equal(result.details.status, turn === 3 ? "blocked" : "blocker-audit");
    if (turn < 3) await settle(harness, ctx);
  }
  assert.equal(saved(harness).status, "blocked");
  assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
}

test("later real file work completes the same blocked goal without resume, clear, or an automatic turn", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-complete-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "report.md");
  const objective = `Write the Markdown file to \`${target}\` and verify its contents`;
  const harness = createHarness();
  const { ctx, captured, tui } = createTuiContext();
  await emit(harness, ctx, "session_start");
  await block(harness, ctx, objective);
  const blocked = saved(harness);
  const footer = captured.footerFactory(tui, theme, { getGitBranch: () => undefined, onBranchChange: () => () => {} });
  t.after(() => footer.dispose?.());
  assert.match(footer.render(160).join("\n"), /\/goal blocked/u);
  await assert.rejects(update(harness, ctx, { status: "complete", evidence: "Too early" }), /no active|later ordinary request/iu);
  await settle(harness, ctx);

  const prompt = await begin(harness, ctx);
  assert.equal(harness.activeTools.includes("killeros_goal_update"), true, "a later blocked request must declare completion");
  assert.match(prompt, /Status: blocked/u);
  assert.ok(prompt.includes(objective));
  writeFileSync(target, "Verified original deliverable\n");
  assert.equal(readFileSync(target, "utf8"), "Verified original deliverable\n");
  const result = await update(harness, ctx, { status: "complete", evidence: "Read the report and checked every acceptance criterion" });
  assert.equal(result.details.status, "complete");
  assert.equal(result.details.verification, "file");
  const completed = saved(harness);
  for (const key of ["objective", "createdAt", "baselineTokens", "verification", "turns", "maxTurns", "activeMilliseconds"] as const) {
    assert.deepEqual(completed[key], blocked[key], key);
  }
  assert.equal(completed.revision, blocked.revision + 1);
  assert.equal(completed.blockerAudit, undefined);
  assert.deepEqual(completed.lastDecision, {
    kind: "complete", turn: 3, evidence: result.details.evidence, verification: "file",
  });
  assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
  assert.doesNotMatch(footer.render(160).join("\n"), /\/goal/u);
  await assert.rejects(update(harness, ctx, { status: "complete", evidence: "Duplicate" }), /no active/iu);
  await settle(harness, ctx);
  assert.equal(harness.sentMessages.length, 3);
  assert.equal(harness.appendedEntries.filter((entry) => entry.data.event === "complete").length, 1);
  assert.equal(harness.appendedEntries.filter((entry) => entry.data.event === "blocked").length, 1);
  ctx.mode = "rpc";
  let summary = "";
  ctx.ui.notify = (message) => { summary = message; };
  await getCommand(harness, "goal").handler("", ctx);
  assert.match(summary, /Goal complete/u);
  assert.match(summary, /Read the report/u);
});

async function eligible(objective = "Audit the whole objective") {
  const harness = createHarness();
  const { ctx } = createTuiContext();
  await block(harness, ctx, objective);
  await settle(harness, ctx);
  await begin(harness, ctx);
  return { harness, ctx };
}

async function restore(state: unknown, mode = "tui", savedSession = true) {
  const harness = createHarness();
  const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "blocked", state } }];
  const { ctx } = createTuiContext(entries);
  ctx.mode = mode;
  ctx.sessionManager.getSessionFile = () => savedSession ? "saved.jsonl" : "";
  await emit(harness, ctx, "session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.sentMessages.length, 0, "restore alone must not start a request");
  assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
  return { harness, ctx };
}

test("ordinary work has no mandatory decision and eligibility lasts through provider results only until settlement", async () => {
  const { harness, ctx } = await eligible();
  const blocked = saved(harness);
  const entriesBefore = harness.appendedEntries.length;
  await emit(harness, ctx, "agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: "Selected model is at capacity" }] });
  assert.equal(harness.activeTools.includes("killeros_goal_update"), true);
  await settle(harness, ctx);
  assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
  assert.equal(harness.appendedEntries.length, entriesBefore);
  assert.deepEqual(saved(harness), blocked);
  await assert.rejects(update(harness, ctx, { status: "complete", evidence: "Outside a request" }), /later ordinary request/u);
  await begin(harness, ctx);
  await settle(harness, ctx);
  assert.deepEqual(saved(harness), blocked, "an unrelated successful request cannot complete the objective");
  assert.equal(harness.sentMessages.length, 3);
});

test("blocked completion rejects other decisions and invalid evidence without consuming permission", async () => {
  const { harness, ctx } = await eligible();
  const blocked = saved(harness);
  for (const status of ["continue", "blocked", "pause", "resume", "clear", "replace", "unknown"]) {
    await assert.rejects(update(harness, ctx, { status, evidence: "Attempt", nextAction: "More work", blockerKey: "external" }), /only complete/u);
  }
  for (const evidence of ["", "  ", "x".repeat(GOAL_EVIDENCE_LIMIT + 1), 42]) {
    await assert.rejects(update(harness, ctx, { status: "complete", evidence }), /Goal evidence/u);
  }
  assert.deepEqual(saved(harness), blocked);
  const result = await update(harness, ctx, { status: "complete", evidence: "  Audited\x1b[31m all criteria\u0007\nChecked results  " });
  assert.equal(result.details.verification, "model-reported");
  assert.equal(result.details.evidence, "Audited all criteria\nChecked results");
  assert.equal(saved(harness).result, result.details.evidence);
  assert.equal(harness.sentMessages.length, 3);
});

test("blocked file completion retains exact-path and original content proof, including retry after failure", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-proof-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.md");
  const wrong = path.join(directory, "wrong.md");
  writeFileSync(target, "Original baseline");
  const { harness, ctx } = await eligible(`Write the Markdown file to \`${target}\``);
  const blocked = saved(harness);
  const complete = () => update(harness, ctx, { status: "complete", evidence: "Checked the file" });
  await assert.rejects(complete(), /has not changed/u);
  rmSync(target);
  writeFileSync(wrong, "Wrong destination");
  await assert.rejects(complete(), /required path/u);
  mkdirSync(target);
  await assert.rejects(complete(), /regular file/u);
  rmSync(target, { recursive: true });
  try {
    symlinkSync(wrong, target, "file");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM"].includes(String(error.code))) throw error;
    t.diagnostic("File symlink creation unavailable on this platform");
  }
  // Both an unavailable symlink and an actual symlink must fail regular-file proof.
  await assert.rejects(complete(), /regular file/u);
  rmSync(target, { force: true });
  assert.deepEqual(saved(harness), blocked);
  writeFileSync(target, "Changed original deliverable");
  assert.equal((await complete()).details.verification, "file");
  assert.deepEqual(saved(harness).verification, blocked.verification);
  await settle(harness, ctx);
  assert.equal(harness.sentMessages.length, 3);

  assert.ok(blocked.verification?.baseline.exists);
  const unavailable = await restore({
    ...blocked,
    verification: { ...blocked.verification, baseline: { ...blocked.verification.baseline, contentHash: null } },
  });
  await begin(unavailable.harness, unavailable.ctx);
  await assert.rejects(update(unavailable.harness, unavailable.ctx, { status: "complete", evidence: "Unprovable" }), /content cannot be verified/u);
  assert.equal(unavailable.harness.appendedEntries.length, 0);
});

test("cancelled blocked completion before or during real file verification appends no completion", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.md");
  writeFileSync(target, "Original");
  const { harness, ctx } = await eligible(`Fix \`${target}\``);
  writeFileSync(target, "Updated");
  const blocked = saved(harness);
  for (const phase of ["before", "during"]) {
    const controller = new AbortController();
    if (phase === "before") controller.abort();
    const pending = update(harness, ctx, { status: "complete", evidence: "Verified" }, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(saved(harness), blocked);
  }
  assert.equal((await update(harness, ctx, { status: "complete", evidence: "Verified after cancellation" })).details.status, "complete");
});

test("asynchronous blocked completion loses ownership on user mutations and committed lifecycle changes", async (t) => {
  for (const mutation of ["clear", "resume", "replace", "session_start", "session_tree", "session_shutdown"]) {
    await t.test(mutation, async (subtest) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-race-"));
      subtest.after(() => rmSync(directory, { recursive: true, force: true }));
      const target = path.join(directory, "target.md");
      writeFileSync(target, "Original");
      const { harness, ctx } = await eligible(`Fix \`${target}\``);
      const blocked = saved(harness);
      writeFileSync(target, "Changed");
      const pending = update(harness, ctx, { status: "complete", evidence: "Old snapshot" });
      // Register the rejection before yielding to file I/O or lifecycle handlers.
      const rejected = assert.rejects(pending, /Goal changed while completion was being verified/u);
      if (mutation === "replace") await getCommand(harness, "goal").handler("Replacement objective", ctx);
      else if (mutation === "clear" || mutation === "resume") await getCommand(harness, "goal").handler(mutation, ctx);
      else {
        // Same text and revision on another branch still have a different lifecycle and snapshot.
        ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "blocked", state: blocked } }];
        await emit(harness, ctx, mutation, { reason: mutation === "session_start" ? "reload" : "switch" });
      }
      await rejected;
      assert.equal(harness.appendedEntries.some((entry) => entry.data.event === "complete"), false);
      if (mutation === "replace") assert.equal(saved(harness).objective, "Replacement objective");
      if (mutation === "resume") assert.equal(saved(harness).status, "active");
      if (mutation === "clear") assert.equal(harness.appendedEntries.at(-1)?.data.state, null);
    });
  }
});

test("competing blocked completion attempts append at most one terminal event", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-duplicate-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.md");
  const { harness, ctx } = await eligible(`Fix \`${target}\``);
  writeFileSync(target, "Created and checked");
  const attempts = await Promise.allSettled([1, 2].map(() => update(harness, ctx, { status: "complete", evidence: "Whole objective checked" })));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  assert.equal(harness.appendedEntries.filter((entry) => entry.data.event === "complete").length, 1);
  assert.equal(saved(harness).status, "complete");
});

test("cancelled navigation preserves a valid blocked completion request", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-navigation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.md");
  const { harness, ctx } = await eligible(`Fix \`${target}\``);
  writeFileSync(target, "Created");
  const pending = update(harness, ctx, { status: "complete", evidence: "Verified original branch" });
  await emit(harness, ctx, "session_before_tree", { targetId: "cancelled-target" });
  // No session_tree notification is sent when Pi cancels navigation.
  assert.equal((await pending).details.status, "complete");
});

test("failed blocked completion persistence preserves the blocked state and allows a later retry", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-blocked-storage-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.md");
  writeFileSync(target, "Original baseline");
  const { harness, ctx } = await eligible(`Fix \`${target}\``);
  writeFileSync(target, "Verified deliverable");
  const blocked = saved(harness);
  const append = harness.api.appendEntry;
  harness.api.appendEntry = () => { throw new Error("Session storage unavailable"); };
  await assert.rejects(update(harness, ctx, { status: "complete", evidence: "All criteria checked" }), /Session storage unavailable/u);
  assert.deepEqual(saved(harness), blocked);
  assert.equal(harness.activeTools.includes("killeros_goal_update"), true);
  await settle(harness, ctx);
  harness.api.appendEntry = append;
  await begin(harness, ctx);
  assert.equal((await update(harness, ctx, { status: "complete", evidence: "Rechecked after storage recovery" })).details.status, "complete");
  assert.equal(harness.sentMessages.length, 3);
});

test("legacy positive-turn blocked state completes at its existing limit without new accounting; zero-turn closure fails", async () => {
  const original = await eligible();
  const { lastDecision: _decision, blockerAudit: _audit, ...legacy } = saved(original.harness);
  for (const turns of [3, 0]) {
    const state = { ...legacy, turns, blockedAuditStartTurn: 0, maxTurns: 3, activeMilliseconds: 1234 };
    assert.ok(parseGoalState(state));
    const { harness, ctx } = await restore(state);
    await begin(harness, ctx);
    const pending = update(harness, ctx, { status: "complete", evidence: "Audited legacy objective" });
    if (turns === 0) {
      await assert.rejects(pending, /zero-turn blocked goal/u);
      assert.equal(harness.appendedEntries.length, 0);
    } else {
      assert.equal((await pending).details.verification, "model-reported");
      const completed = saved(harness);
      assert.equal(completed.turns, 3);
      assert.equal(completed.maxTurns, 3);
      assert.equal(completed.activeMilliseconds, 1234);
      assert.equal(completed.lastDecision?.turn, 3);
      const restored = await restore(completed);
      await begin(restored.harness, restored.ctx);
      assert.equal(restored.harness.activeTools.includes("killeros_goal_update"), false);
    }
  }
});

test("blocked completion remains unavailable in unsupported modes, unsaved sessions, and other saved statuses", async () => {
  const original = await eligible();
  const blocked = saved(original.harness);
  for (const [mode, savedSession] of [["print", true], ["json", true], ["tui", false], ["rpc", false]] as const) {
    const { harness, ctx } = await restore(blocked, mode, savedSession);
    await begin(harness, ctx);
    assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
    await assert.rejects(update(harness, ctx, { status: "complete", evidence: "Unsupported" }), /require TUI or RPC mode|require a saved session/u);
    assert.equal(harness.appendedEntries.length, 0);
  }
  for (const status of ["paused", "complete", "absent"] as const) {
    const { lastDecision: _decision, blockerAudit: _audit, ...base } = blocked;
    const { harness, ctx } = await restore(status === "absent" ? null : { ...base, status });
    await begin(harness, ctx);
    assert.equal(harness.activeTools.includes("killeros_goal_update"), false);
    await assert.rejects(update(harness, ctx, { status: "complete", evidence: "Unsupported" }), /no active/u);
    assert.equal(harness.appendedEntries.length, 0);
  }
});
