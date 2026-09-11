import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGitFileChangesRefresh,
  createGitStatusRefresh,
  resolveGitFileChanges,
  scheduleGitStatusFallback,
  scheduleGitStatusWatch,
  type GitFileChanges,
} from "../killeros/footer.ts";
import { passiveGitEnv, passiveStatusSafetyArgs, samePassiveFilters } from "../killeros/passive-git-status.ts";
import { createHarness, createTuiContext, disposeTestComponent, getHandlers, removeDirectoryEventually, theme, waitFor } from "./ExtensionTestHarness.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { themeTestAdapter } from "./PiTestAdapters.ts";

type TestStyle = {
  bold(text: string): string;
  fg(color: string, text: string): string;
};

type TestUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function usage(cost: number): TestUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

async function waitForGitWatch(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for watched Git status");
}

test("footer survives unavailable context telemetry", () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  ctx.getContextUsage = () => { throw new Error("usage unavailable"); };
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  assert.doesNotThrow(() => footer.render(80));
  assert.match(footer.render(80).join("\n"), /ctx —%/u);
  disposeTestComponent(footer);
});

test("footer scans session cost once until session content changes", async () => {
  const { handlers } = createHarness();
  const entries = [{ type: "message", message: { role: "assistant", usage: usage(1) } }];
  const { captured, ctx, tui } = createTuiContext(entries);
  let entryReads = 0;
  ctx.sessionManager.getEntries = () => {
    entryReads += 1;
    return entries;
  };
  for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });

  footer.render(120);
  footer.render(120);
  footer.render(120);
  assert.equal(entryReads, 1);

  entries.push({ type: "message", message: { role: "toolResult", usage: usage(2) } });
  for (const handler of getHandlers(handlers, "turn_end") ?? []) {
    await handler({ turnIndex: 0, message: {}, toolResults: [] }, ctx);
  }
  assert.match(footer.render(120).join("\n"), /\$3\.00/u);
  assert.equal(entryReads, 2);

  for (const handler of getHandlers(handlers, "session_compact") ?? []) {
    await handler({ compactionEntry: { details: {} } }, ctx);
  }
  footer.render(120);
  assert.equal(entryReads, 3);

  for (const handler of getHandlers(handlers, "session_tree") ?? []) await handler({}, ctx);
  footer.render(120);
  assert.equal(entryReads, 4);
  disposeTestComponent(footer);
});

test("footer includes assistant, tool, compaction, and branch-summary costs", () => {
  const { handlers } = createHarness();
  const entries = [
    { type: "message", message: { role: "assistant", usage: usage(1) } },
    { type: "message", message: { role: "toolResult", usage: usage(2) } },
    { type: "compaction", usage: usage(3) },
    { type: "branch_summary", usage: usage(4) },
  ];
  const { captured, ctx, tui } = createTuiContext(entries);
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  const footer = captured.footerFactory(tui, theme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  assert.match(footer.render(160).join("\n"), /\$10\.00/);
  disposeTestComponent(footer);
});

test("Git status uses a five-second deadline and settles timeouts as unavailable", async () => {
  let configuredTimeout: number | undefined;
  const result = await resolveGitFileChanges("repo", (_file, _args, options, callback) => {
    configuredTimeout = options.timeout;
    callback(new Error("timed out"), "");
  });

  assert.equal(configuredTimeout, 5_000);
  assert.equal(result, undefined);
});

test("passive Git status rejects incomplete or unsafe filter discovery", () => {
  assert.equal(passiveStatusSafetyArgs("filter.tripwire.clean"), undefined);
  assert.equal(passiveStatusSafetyArgs("filter.bad/name.clean\0"), undefined);
  assert.deepEqual(passiveStatusSafetyArgs("filter.tripwire.process\0filter.tripwire.clean\0"), [
    "-c", "core.fsmonitor=false",
    "-c", "filter.tripwire.clean=", "-c", "filter.tripwire.process=", "-c", "filter.tripwire.required=false",
  ]);
});

test("passive Git children run without PATH resolution or lazy fetching", () => {
  const env = passiveGitEnv();
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(env.GIT_NO_LAZY_FETCH, "1");
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path") assert.equal(value, "");
  }
  assert.ok(Object.keys(env).some((key) => key.toLowerCase() === "path"));
});

test("passive filter comparison detects mid-scan configuration changes", () => {
  assert.equal(samePassiveFilters("filter.a.clean\0", "filter.a.clean\0"), true);
  assert.equal(samePassiveFilters("filter.a.clean\0", "filter.a.clean\0filter.b.process\0"), false);
  assert.equal(samePassiveFilters("filter.a.clean", "filter.a.clean\0"), false);
  assert.equal(samePassiveFilters("filter.bad/name.clean\0", "filter.bad/name.clean\0"), false);
});

test("footer Git status skips results when filters change mid-scan", async () => {
  const discovered = "filter.early.clean\0";
  const changed = "filter.early.clean\0filter.late.clean\0";
  let calls = 0;
  let statusEnv: NodeJS.ProcessEnv | undefined;
  const result = await resolveGitFileChanges("repo", (_file, args, options, callback) => {
    calls += 1;
    if (args.includes("config")) {
      callback(null, calls === 1 ? discovered : changed);
      return;
    }
    statusEnv = options.env;
    callback(null, " M changed.txt\0");
  });

  assert.equal(result, undefined);
  assert.equal(calls, 3);
  assert.equal(statusEnv?.GIT_NO_LAZY_FETCH, "1");
});

test("footer Git status accepts results when filters are stable mid-scan", async () => {
  const discovered = "filter.early.clean\0";
  const result = await resolveGitFileChanges("repo", (_file, args, _options, callback) => {
    if (args.includes("config")) {
      callback(null, discovered);
      return;
    }
    callback(null, " M changed.txt\0");
  });

  assert.deepEqual(result, { modified: 1, added: 0, deleted: 0 });
});

test("footer Git status does not execute a configured filesystem monitor", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-footer-fsmonitor-"));
  try {
    const sentinel = path.join(directory, ".git", "fsmonitor-executed");
    const monitor = path.join(directory, "fsmonitor.cjs");
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(monitor, "require('node:fs').writeFileSync(process.argv[2], 'executed'); process.stdout.write('0\\n');\n");
    writeFileSync(path.join(directory, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=KillerOS Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: directory });
    execFileSync("git", ["config", "core.fsmonitor", `node "${monitor.replaceAll("\\", "/")}" "${sentinel.replaceAll("\\", "/")}"`], { cwd: directory });
    writeFileSync(path.join(directory, "tracked.txt"), "changed\n");

    assert.deepEqual(await resolveGitFileChanges(directory), { modified: 1, added: 0, deleted: 0 });
    assert.equal(existsSync(sentinel), false);
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("footer Git status does not execute configured clean filters", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-footer-clean-filter-"));
  try {
    const sentinel = path.join(directory, "filter-executed");
    const filter = path.join(directory, "clean-filter.cjs");
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(filter, "require('node:fs').writeFileSync(process.argv[2], 'executed'); process.stdin.pipe(process.stdout);\n");
    writeFileSync(path.join(directory, "tracked.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=KillerOS Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: directory });
    writeFileSync(path.join(directory, ".gitattributes"), "*.txt filter=tripwire\n");
    execFileSync("git", ["add", ".gitattributes"], { cwd: directory });
    execFileSync("git", ["-c", "user.name=KillerOS Test", "-c", "user.email=test@example.com", "commit", "-qm", "attributes"], { cwd: directory });
    execFileSync("git", ["config", "filter.tripwire.clean", `node \"${filter.replaceAll("\\", "/")}\" \"${sentinel.replaceAll("\\", "/")}\"`], { cwd: directory });
    writeFileSync(path.join(directory, "tracked.txt"), "changed\n");

    assert.deepEqual(await resolveGitFileChanges(directory), { modified: 1, added: 0, deleted: 0 });
    assert.equal(existsSync(sentinel), false);
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("footer Git status keeps the last successful result through failure and accepts clean recovery", async () => {
  const dirty: GitFileChanges = { modified: 2, added: 1, deleted: 1 };
  const clean: GitFileChanges = { modified: 0, added: 0, deleted: 0 };
  const pending: Array<(changes: GitFileChanges | undefined) => void> = [];
  const results: GitFileChanges[] = [];
  const refresh = createGitFileChangesRefresh(
    "repo",
    (changes) => results.push(changes),
    () => new Promise((resolve) => pending.push(resolve)),
  );

  refresh.request();
  pending.shift()?.(dirty);
  await new Promise((resolve) => setImmediate(resolve));
  refresh.request();
  pending.shift()?.(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [dirty]);

  refresh.request();
  pending.shift()?.(clean);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(results, [dirty, clean]);
  refresh.dispose();
});

test("footer Git status reports no result when filter discovery fails", async () => {
  const calls: string[][] = [];
  const result = await resolveGitFileChanges("repo", (_file, args, _options, callback) => {
    calls.push(args);
    callback(new Error("config unavailable"), "");
  });

  assert.equal(result, undefined);
  assert.deepEqual(calls, [["-C", "repo", "config", "--includes", "--null", "--name-only", "--list"]]);
});

test("footer Git status recovers after an unavailable initial refresh without recreation", async () => {
  const dirty: GitFileChanges = { modified: 1, added: 0, deleted: 0 };
  const outcomes: Array<GitFileChanges | undefined> = [undefined, dirty];
  const results: GitFileChanges[] = [];
  const refresh = createGitFileChangesRefresh("repo", (changes) => results.push(changes), async () => outcomes.shift());

  refresh.request();
  refresh.request();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(results, [dirty]);
  refresh.dispose();
});

test("footer Git refresh contains rejected scans and runs queued recovery", async () => {
  const results: Array<number | undefined> = [];
  let attempts = 0;
  const refresh = createGitStatusRefresh("repo", (count) => results.push(count), async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("Git failed");
    return 3;
  });

  refresh.request();
  refresh.request();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(results, [undefined, 3]);
  refresh.dispose();
});

test("createGitStatusRefresh preserves its changed-file count callback", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-footer-count-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(path.join(directory, "untracked.txt"), "new\n");
    let result: unknown;
    const refresh = createGitStatusRefresh(directory, (count) => { result = count; });
    refresh.request();
    await waitFor(() => result !== undefined);
    refresh.dispose();
    assert.equal(result, 1);
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("footer Git status coalesces concurrent refreshes and ignores late disposal results", async () => {
  const pending: Array<(count: number | undefined) => void> = [];
  const results: Array<number | undefined> = [];
  let requests = 0;
  const refresh = createGitStatusRefresh("repo", (count) => results.push(count), async () => {
    requests += 1;
    return await new Promise<number | undefined>((resolve) => pending.push(resolve));
  });

  refresh.request();
  refresh.request();
  refresh.request();
  assert.equal(requests, 1);
  pending.shift()?.(6);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  assert.deepEqual(results, [6]);

  refresh.dispose();
  pending.shift()?.(4);
  await new Promise((resolve) => setImmediate(resolve));
  refresh.request();
  assert.equal(requests, 2);
  assert.deepEqual(results, [6]);
});

test("footer Git status uses a 30-second fallback independent of rendering", () => {
  let tick: (() => void) | undefined;
  let intervalMs: number | undefined;
  let stopped = false;
  let requests = 0;
  const stop = scheduleGitStatusFallback(() => { requests += 1; }, (refresh, interval) => {
    tick = refresh;
    intervalMs = interval;
    return () => { stopped = true; };
  });

  assert.equal(intervalMs, 30_000);
  tick?.();
  assert.equal(requests, 1);
  stop();
  assert.equal(stopped, true);
});

test("footer Git status debounces filesystem bursts before throttling refreshes", () => {
  let changed: (() => void) | undefined;
  let failed: (() => void) | undefined;
  let tick: (() => void) | undefined;
  let watchStopped = false;
  let timersStopped = 0;
  let requests = 0;
  const delays: number[] = [];
  const stop = scheduleGitStatusWatch(
    "repo",
    () => { requests += 1; },
    (_cwd, onChange, onError) => {
      changed = onChange;
      failed = onError;
      return () => { watchStopped = true; };
    },
    (refresh, delay) => {
      delays.push(delay);
      tick = refresh;
      return () => { timersStopped += 1; };
    },
  );

  changed?.();
  changed?.();
  assert.equal(requests, 0);
  tick?.();
  assert.equal(requests, 1);
  assert.deepEqual(delays, [250, 5_000]);

  changed?.();
  failed?.();
  tick?.();
  assert.equal(requests, 1);
  assert.equal(watchStopped, true);
  assert.equal(timersStopped, 1);

  stop();
});

test("footer Git status bounds refreshes during sustained filesystem activity", () => {
  let changed: (() => void) | undefined;
  let now = 0;
  let requests = 0;
  const timers: Array<{ dueAt: number; refresh: () => void; stopped: boolean }> = [];
  scheduleGitStatusWatch(
    "repo",
    () => { requests += 1; },
    (_cwd, onChange) => {
      changed = onChange;
      return () => {};
    },
    (refresh, delay) => {
      const timer = { dueAt: now + delay, refresh, stopped: false };
      timers.push(timer);
      return () => { timer.stopped = true; };
    },
  );
  const advance = (milliseconds: number): void => {
    now += milliseconds;
    for (const timer of timers) {
      if (!timer.stopped && timer.dueAt <= now) {
        timer.stopped = true;
        timer.refresh();
      }
    }
  };

  changed?.();
  advance(250);
  changed?.();
  advance(4_750);
  assert.equal(requests, 1);
  advance(250);
  advance(250);

  assert.equal(requests, 2);
});

test("footer shows colored modified, added, and deleted file counts and hides clean status", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-footer-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(path.join(directory, `modified-${index}.txt`), "initial\n");
    }
    writeFileSync(path.join(directory, "renamed.txt"), "initial\n");
    writeFileSync(path.join(directory, "deleted.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=KillerOS Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: directory });

    for (let index = 1; index <= 6; index += 1) {
      writeFileSync(path.join(directory, `modified-${index}.txt`), "changed\n");
    }
    execFileSync("git", ["mv", "renamed.txt", "moved.txt"], { cwd: directory });
    rmSync(path.join(directory, "deleted.txt"));
    writeFileSync(path.join(directory, "untracked.txt"), "new\n");

    const { handlers } = createHarness();
    const { captured, ctx, tui } = createTuiContext();
    ctx.cwd = directory;
    for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);
    const gitTheme = themeTestAdapter({
      ...theme,
      fg: (color: string, text: string) => ["warning", "success", "error"].includes(color)
        ? `<${color}>${text}</${color}>`
        : text,
    });
    const footer = captured.footerFactory(tui, gitTheme, {
      getGitBranch: () => "dev",
      onBranchChange: () => () => {},
    });

    await waitFor(() => footer.render(120).join("\n").includes(
      "dev · ±9 [<warning>~7</warning> <success>+1</success> <error>−1</error>]",
    ));
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=KillerOS Test", "-c", "user.email=test@example.com", "commit", "-qm", "save changes"], { cwd: directory });
    await waitForGitWatch(() => {
      const rendered = footer.render(120).join("\n");
      return /\bdev\b/u.test(rendered) && !rendered.includes("±");
    });
    writeFileSync(path.join(directory, "external.txt"), "changed outside Pi\n");
    await waitForGitWatch(() => footer.render(120).join("\n").includes(
      "dev · ±1 [<warning>~0</warning> <success>+1</success> <error>−0</error>]",
    ));
    disposeTestComponent(footer);
  } finally {
    await removeDirectoryEventually(directory);
  }
});

test("footer shows a compact active goal turn limit", async () => {
  const now = Date.now();
  const goal = {
    version: 1,
    revision: 1,
    objective: "Limited work",
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeMilliseconds: 0,
    activeStartedAt: now,
    turns: 3,
    blockedAuditStartTurn: 0,
    baselineTokens: 0,
    maxTurns: 8,
  };
  const entries = [{ type: "custom", customType: "killeros-goal", data: { version: 1, event: "turn", state: goal } }];
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext(entries);
  ctx.hasPendingMessages = () => true;
  for (const handler of getHandlers(handlers, "session_start")) await handler({}, ctx);
  const footer = captured.footerFactory(tui, theme, { getGitBranch: () => "main", onBranchChange: () => () => {} });
  assert.match(footer.render(120).join("\n"), /\/goal is active 3\/8/u);
  disposeTestComponent(footer);
});

test("footer cuts down by priority while preserving model and context", () => {
  const { handlers } = createHarness();
  const entries = [{ type: "message", message: { role: "assistant", usage: usage(10) } }];
  const { captured, ctx, tui } = createTuiContext(entries);
  ctx.cwd = path.join(path.parse(process.cwd()).root, "work", "a-very-long-workspace-directory-name", "pi-KillerOS");
  ctx.model = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 1_050_000,
  };
  ctx.getContextUsage = () => ({ tokens: 50_000, contextWindow: 1_050_000 });
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  const quietTheme: { fg(color: string, text: string): string } = {
    ...theme,
    fg: (color, text) => color === "borderMuted" ? `<borderMuted>${text}</borderMuted>` : text,
  };
  const footer = captured.footerFactory(tui, quietTheme, {
    getGitBranch: () => "main",
    onBranchChange: () => () => {},
  });

  const wideRender = footer.render(160);
  assert.equal(wideRender.length, 3);
  assert.equal(wideRender[0], `<borderMuted>${"─".repeat(160)}</borderMuted>`);
  const widePrimary = wideRender[1] ?? "";
  const wideSecondary = wideRender[2] ?? "";
  assert.match(widePrimary, /gpt-5\.6-sol openai · high · ctx 5%/u);
  assert.match(widePrimary, /\d+s · \$10\.00/u);
  assert.match(wideSecondary, /main/u);
  const normalizedHome = (process.env.HOME || process.env.USERPROFILE || os.homedir()).replace(/[\\/]+$/u, "");
  const normalizedCwd = ctx.cwd.replace(/[\\/]+$/u, "");
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  const displayedCwd = normalizedCwd === normalizedHome
    ? "~"
    : normalizedCwd.startsWith(normalizedHome) && /^[\\/]/u.test(separator)
      ? `~${normalizedCwd.slice(normalizedHome.length)}`
      : ctx.cwd;
  assert.ok(wideSecondary.includes(`\x1B[38;2;240;248;154m${displayedCwd}\x1B[39m`));

  const focused = footer.render(44);
  assert.match(focused[1] ?? "", /gpt-5\.6-sol openai · high · ctx 5%/u);
  assert.match(focused[2] ?? "", /…\/pi-KillerOS/u);
  assert.doesNotMatch(focused[1] ?? "", /\d+s|\$10\.00/u);

  const compact = footer.render(32);
  assert.match(compact[1] ?? "", /gpt-5\.6-sol openai · ctx 5%/u);
  assert.match(compact[2] ?? "", /main/u);
  assert.match(compact[2] ?? "", /…\/pi-KillerOS/u);

  const tiny = footer.render(19);
  assert.doesNotMatch(tiny[2] ?? "", /pi-KillerOS/u);

  const emergency = footer.render(26)[1] ?? "";
  assert.match(emergency, /gpt-5\.6-sol/u);
  assert.match(emergency, /ctx 5%/u);
  assert.doesNotMatch(emergency, /openai/u);

  for (let width = 1; width <= 180; width += 1) {
    const lines = footer.render(width);
    assert.equal(lines.length, 3, `footer rows at width ${width}`);
    assert.equal(lines[0], `<borderMuted>${"─".repeat(width)}</borderMuted>`);
    assert.ok(lines.slice(1).every((line) => [...line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")].length === width), `footer width mismatch at ${width}`);
  }
  disposeTestComponent(footer);
});

test("footer uses model metadata and formats unknown provider names", () => {
  const { handlers } = createHarness();
  const { captured, ctx, tui } = createTuiContext();
  ctx.model = {
    id: "raw-model-v1",
    name: "Pro\x1b]2;owned\x07\x1b[31mfessional\x1b[0m\0\n Model",
    provider: "my-\x1b]2;owned\x07\x1b[31mprivate\x1b[0m\0\n-ai",
    reasoning: true,
  };
  for (const handler of getHandlers(handlers, "session_start")) handler({}, ctx);

  const semanticTheme: TestStyle = {
    bold: (text) => `\x1B[1m${text}\x1B[22m`,
    fg: (color, text) => color === "text"
      ? `\x1B[37m${text}\x1B[39m`
      : color === "dim" ? `\x1B[90m${text}\x1B[39m` : text,
  };
  const footer = captured.footerFactory(tui, semanticTheme, {
    getGitBranch: () => undefined,
    onBranchChange: () => () => {},
  });
  const firstRender = footer.render(120)[1] ?? "";
  assert.match(firstRender, /\x1B\[37mraw-model-v1\x1B\[39m/u);
  assert.match(firstRender, /\x1B\[90mmy private ai\x1B\[39m/u);

  for (const handler of getHandlers(handlers, "model_select")) {
    handler({ model: {
      ...ctx.model,
      id: "Next\x1b]2;owned\x07\x1b[31m Model\x1b[0m\0",
      name: "\x1b]2;owned\x07\x1b[31m\x1b[0m\0",
      provider: "future_provider",
    } });
  }
  const updated = (footer.render(120)[1] ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(updated, /next model future provider/u);

  for (const handler of getHandlers(handlers, "model_select")) {
    handler({ model: { ...ctx.model, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" } });
  }
  const deepSeek = (footer.render(120)[1] ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(deepSeek, /deepseek-v4-flash deepseek/u);
  disposeTestComponent(footer);
});
