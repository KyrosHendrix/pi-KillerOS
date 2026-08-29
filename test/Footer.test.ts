import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitStatusRefresh, scheduleGitStatusFallback } from "../killeros/footer.ts";
import { createHarness, createTuiContext, disposeTestComponent, getHandlers, removeDirectoryEventually, theme, waitFor } from "./ExtensionTestHarness.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  assert.match(footer.render(80).join("\n"), /—% left \(—\)/u);
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
    for (const handler of getHandlers(handlers, "turn_end")) handler({}, ctx);
    await waitFor(() => {
      const rendered = footer.render(120).join("\n");
      return /\bdev\b/u.test(rendered) && !rendered.includes("±");
    });
    writeFileSync(path.join(directory, "external.txt"), "changed outside Pi\n");
    for (const handler of getHandlers(handlers, "session_compact")) handler({}, ctx);
    await waitFor(() => footer.render(120).join("\n").includes(
      "dev · ±1 [<warning>~0</warning> <success>+1</success> <error>−0</error>]",
    ));
    disposeTestComponent(footer);
  } finally {
    await removeDirectoryEventually(directory);
  }
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
  assert.match(widePrimary, /GPT-5\.6 Sol OpenAI · high · 95% left \(1M\)/u);
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

  const focused = footer.render(48);
  assert.match(focused[1] ?? "", /GPT-5\.6 Sol OpenAI · high · 95% left \(1M\)/u);
  assert.match(focused[2] ?? "", /…\/pi-KillerOS/u);
  assert.doesNotMatch(focused[1] ?? "", /\d+s|\$10\.00/u);

  const compact = footer.render(40);
  assert.match(compact[1] ?? "", /GPT-5\.6 Sol OpenAI · 95% left \(1M\)/u);
  assert.match(compact[2] ?? "", /main/u);
  assert.match(compact[2] ?? "", /…\/pi-KillerOS/u);

  const tiny = footer.render(19);
  assert.doesNotMatch(tiny[2] ?? "", /pi-KillerOS/u);

  const emergency = footer.render(35)[1] ?? "";
  assert.match(emergency, /GPT-5\.6 Sol/u);
  assert.match(emergency, /95% left \(1M\)/u);
  assert.doesNotMatch(emergency, /OpenAI/u);

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
  assert.match(firstRender, /\x1B\[37m\x1B\[1mProfessional Model\x1B\[22m\x1B\[39m/u);
  assert.match(firstRender, /\x1B\[90mMy Private AI\x1B\[39m/u);

  for (const handler of getHandlers(handlers, "model_select")) {
    handler({ model: {
      ...ctx.model,
      id: "Next\x1b]2;owned\x07\x1b[31m Model\x1b[0m\0",
      name: "\x1b]2;owned\x07\x1b[31m\x1b[0m\0",
      provider: "future_provider",
    } });
  }
  const updated = (footer.render(120)[1] ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(updated, /Next Model Future Provider/u);

  for (const handler of getHandlers(handlers, "model_select")) {
    handler({ model: { ...ctx.model, id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek" } });
  }
  const deepSeek = (footer.render(120)[1] ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");
  assert.match(deepSeek, /DeepSeek V4 Flash DeepSeek/u);
  disposeTestComponent(footer);
});
