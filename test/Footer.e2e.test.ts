import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeDirectoryEventually } from "./ExtensionTestHarness.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// Provider usage enters through Pi's real transport, not a replacement context API.
test("installed Pi terminal updates context capacity and the settings-driven compact hint", { timeout: 90_000 }, async (t) => {
  const directory = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-footer-"));
  const agent = path.join(directory, "agent");
  const temporary = path.join(directory, "tmp");
  mkdirSync(agent);
  mkdirSync(temporary);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TEMP: temporary, TMP: temporary,
    PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  let usedTokens = 850_000;
  let requestCount = 0;
  const faults: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        assert.ok(chunk instanceof Uint8Array);
        size += chunk.length;
        assert.ok(size < 1_048_576);
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.method, "POST");
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(typeof body === "object" && body !== null && "model" in body);
      assert.ok(body.model === "million" || body.model === "fractional");
      requestCount++;
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ id: `footer-${requestCount}`, model: body.model,
        choices: [{ index: 0, delta: { content: `Budget response ${requestCount}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: usedTokens - 1, completion_tokens: 1, total_tokens: usedTokens },
      })}\n\ndata: [DONE]\n\n`);
    })().catch((error: unknown) => {
      faults.push(error instanceof Error ? error.message : String(error));
      if (!response.destroyed) { response.writeHead(500, { connection: "close" }); response.end("Footer fixture rejected request"); }
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  let terminal: PiTerminalProcess | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  const screens: Record<string, string> = {};
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("No footer provider port"));
      });
    });
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen", cacheWarming: "off",
      compaction: { enabled: false }, retry: { enabled: false }, defaultThinkingLevel: "off" }));
    writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { "killeros-footer": {
      baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "footer-fixture-key",
      models: [{ id: "million", contextWindow: 1_000_000 }, { id: "fractional", contextWindow: 1_050_000 }].map((model) => ({
        ...model, name: model.id, reasoning: false, input: ["text"], maxTokens: 2_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    } } }));
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
        "--model", "killeros-footer/million", "--thinking", "off", "--tools", "read", "--session", path.join(directory, "session.jsonl"),
        "--offline", "--approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp",
        "--no-extensions", "--extension", path.join(repositoryRoot, "Killeros.ts")], cwd: directory, env, cols: 120, rows: 30 });
    const footerLine = (screen: string): string => screen.split("\n").find((line) => /ctx (?:\d+|—)%/u.test(line)) ?? "";
    const command = async (text: string, predicate: (screen: string) => boolean): Promise<string> => {
      assert.ok(terminal);
      const after = terminal.sequence;
      terminal.write(`${text}\r`);
      return await terminal.waitForScreen(predicate, { signal: t.signal, after });
    };
    screens.startup = await terminal.waitForScreen((screen) => footerLine(screen).includes("(1M/1M)"), { signal: t.signal });
    screens.default = await command("low budget", (screen) => footerLine(screen).includes("ctx 15% (150K/1M)"));
    assert.doesNotMatch(footerLine(screens.default), /\/compact/u);
    screens.off = await command("/auto-compact off", (screen) => footerLine(screen).includes("/compact"));
    assert.match(footerLine(screens.off), /ctx 15% \(150K\/1M\) · \/compact/u);
    screens.threshold = await command("/auto-compact 80", (screen) => screen.includes("threshold: 80%"));
    assert.match(footerLine(screens.threshold), /\/compact/u);
    screens.on = await command("/auto-compact on", (screen) => screen.includes("on at 80%") && !footerLine(screen).includes("/compact"));
    screens.offAgain = await command("/auto-compact off", (screen) => footerLine(screen).includes("/compact"));
    usedTokens = 800_000;
    screens.warning = await command("higher budget", (screen) => footerLine(screen).includes("ctx 20% (200K/1M)"));
    assert.doesNotMatch(footerLine(screens.warning), /\/compact/u);
    screens.switched = await command("/model killeros-footer/fractional", (screen) => footerLine(screen).includes("fractional") && footerLine(screen).includes("/1.05M)"));
    usedTokens = 1_000_000;
    screens.fractional = await command("fractional budget", (screen) => footerLine(screen).includes("ctx 5% (50K/1.05M)"));
    assert.match(footerLine(screens.fractional), /\/compact/u);
    const settingsPath = path.join(agent, "killeros.json");
    const malformed = "{ invalid settings";
    writeFileSync(settingsPath, malformed);
    screens.failedWrite = await command("/auto-compact on", (screen) => screen.includes("could not be saved"));
    assert.match(footerLine(screens.failedWrite), /\/compact/u, "A failed write must retain the last displayed preference");
    assert.equal(readFileSync(settingsPath, "utf8"), malformed);
    screens.failedRead = await command("/auto-compact status", (screen) => screen.includes("could not be read") && !footerLine(screen).includes("/compact"));
    assert.equal(readFileSync(settingsPath, "utf8"), malformed);
    screens.failedReload = await command("/reload", (screen) => screen.includes("Reloaded") && !footerLine(screen).includes("/compact"));
    assert.match(footerLine(screens.failedReload), /ctx 5% \(50K\/1\.05M\)/u);
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.reloaded = await command("/reload", (screen) => screen.includes("Reloaded") && footerLine(screen).includes("/compact"));
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: true, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.externalOn = await command("updated preference", (screen) => screen.includes("Budget response 4") && !footerLine(screen).includes("/compact"));
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.externalOff = await command("updated preference again", (screen) => screen.includes("Budget response 5") && footerLine(screen).includes("/compact"));
    writeFileSync(settingsPath, malformed);
    screens.turnReadFailure = await command("unreadable preference", (screen) => screen.includes("settings could not be read") && !footerLine(screen).includes("/compact"));
    assert.equal(readFileSync(settingsPath, "utf8"), malformed);
    writeFileSync(settingsPath, JSON.stringify({ autoCompaction: { enabled: false, percentRemaining: 80 }, unrelated: "preserved" }));
    screens.restored = await command("/auto-compact status", (screen) => footerLine(screen).includes("/compact"));
    const afterResize = terminal.sequence;
    terminal.resize(58, 30);
    screens.capacityOnly = await terminal.waitForScreen((screen) => /ctx 5% \(1\.05M\)/u.test(footerLine(screen)), { signal: t.signal, after: afterResize });
    const beforeNarrow = terminal.sequence;
    terminal.resize(34, 30);
    screens.percentageOnly = await terminal.waitForScreen((screen) => /ctx 5% · \/compact/u.test(footerLine(screen)) && !footerLine(screen).includes("1.05M"), { signal: t.signal, after: beforeNarrow });
    assert.ok(screens.percentageOnly.split("\n").every((line) => [...line].length <= 34));
    assert.deepEqual(faults, []);
    assert.equal(requestCount, 6, "Settings commands, model selection, and reload must not start model requests");
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
  } catch (error) { failure = error; }
  finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) cleanupFailures.push(new Error(`Footer terminal cleanup: ${JSON.stringify(result)}`));
      } catch (error) { cleanupFailures.push(error); }
    }
    if (server.listening) {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      } catch (error) { cleanupFailures.push(error); }
    }
  }
  if (failure !== undefined || cleanupFailures.length > 0 || faults.length > 0) {
    t.diagnostic(JSON.stringify({ directory, platform: process.platform, node: process.version, screens, faults, requestCount, terminal: terminal?.diagnostics() }));
    throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures, ...faults.map((fault) => new Error(fault))], "Footer TUI scenario failed");
  }
  await removeDirectoryEventually(directory);
});
