import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-ai";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { piRpcShutdownSkip } from "./support/PiCliCompatibility.ts";
import { PiRpcProcess } from "./support/PiRpcProcess.ts";
import { PiTerminalProcess } from "./support/PiTerminalProcess.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = path.join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const providerName = "questions-local";
const modelId = "local-model";
/** CSI-u Enter: a bare CR can arrive as Shift+Enter through ConPTY in the main editor. */
const editorEnter = "\x1b[13u";
const dialogConfirm = editorEnter;
const dialogDown = "\x1b[B";
const dialogUp = "\x1b[A";
const dialogCancel = "\x1b";
const expandToggle = "\x0f";
const pageUp = "\x1b[5~";
const jumpLatest = "\x1b[1;5F";
const abortedMessage = /Question cancelled because the agent operation was aborted/u;
const nativeAbortNotice = /Error: This operation was aborted/u;
const fixtureAbort = "\x1b[24~";
const fixtureNew = "\x1b[23~";
const fixtureNavigate = "\x1b[21~";
const fixtureShutdown = "\x1b[20~";

type RecordValue = Record<string, unknown>;
type ProviderToolCall = { name: string; arguments: RecordValue };
type ProviderStep =
  | { kind: "text"; content: string }
  | { kind: "calls"; calls: ProviderToolCall[] };
type Option = { label: string; description?: string; preview?: string };

type Family = {
  directory: string;
  project: string;
  agent: string;
  temporary: string;
  env: NodeJS.ProcessEnv;
};

function isRecordValue(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): RecordValue {
  if (!isRecordValue(value)) throw new Error(`Expected ${label} to be an object`);
  return value;
}

function stringField(value: RecordValue, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected ${label} ${key} to be a string`);
  return field;
}

/** Loopback provider: exact scripted tool-call/text responses, request capture, no live service. */
class QuestionProvider {
  readonly requests: RecordValue[] = [];
  readonly faults: string[] = [];
  private readonly steps: ProviderStep[] = [];
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => {
      void (async () => {
        assert.equal(request.method, "POST", "The question fixture only serves POST requests");
        assert.equal(request.url, "/v1/chat/completions", "The question fixture only serves the completions endpoint");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          assert.ok(chunk instanceof Uint8Array, "The question provider received a non-byte chunk");
          size += chunk.length;
          assert.ok(size <= 4_194_304, "The question provider request exceeded the bounded body size");
          chunks.push(Buffer.from(chunk));
        }
        const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")), "provider request body");
        assert.equal(stringField(body, "model", "provider request"), modelId);
        this.requests.push(body);
        const step = this.steps.shift();
        if (step === undefined) throw new Error(`Unexpected provider request ${this.requests.length}`);
        const delta = step.kind === "calls"
          ? { tool_calls: step.calls.map((call, index) => ({ index, id: `question-call-${this.requests.length}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : { content: step.content };
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(`data: ${JSON.stringify({
          id: `questions-${this.requests.length}`,
          model: modelId,
          choices: [{ index: 0, delta, finish_reason: step.kind === "calls" ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
        })}\n\ndata: [DONE]\n\n`);
      })().catch((error: unknown) => {
        this.faults.push(error instanceof Error ? error.message : String(error));
        if (!response.destroyed && !response.writableEnded) {
          response.writeHead(500, { connection: "close" });
          response.end("Question fixture rejected request");
        }
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 10_000;
  }

  get baseUrl(): string {
    const address = this.server.address();
    if (!this.server.listening || !address || typeof address === "string") throw new Error("The question provider is not listening");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  plan(...steps: ProviderStep[]): void {
    this.steps.push(...steps);
  }

  questionCall(question: string, options: Option[], extra: RecordValue = {}): ProviderStep {
    return { kind: "calls", calls: [{ name: "question", arguments: { question, options, ...extra } }] };
  }

  text(content: string): ProviderStep {
    return { kind: "text", content };
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.closeAllConnections();
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    assert.deepEqual(this.faults, [], "the question provider must not record fixture faults");
    assert.equal(this.steps.length, 0, `every planned provider step must be consumed (${this.steps.length} remain)`);
  }
}

function createFamily(root: string, name: string): Family {
  for (let parent = tmpdir(); ; parent = path.dirname(parent)) {
    assert.equal(existsSync(path.join(parent, ".git")), false, "Question scratch must have no repository ancestor");
    if (path.dirname(parent) === parent) break;
  }
  const directory = mkdtempSync(path.join(tmpdir(), `.killeros-question-${name}-`));
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "junction");
  const project = path.join(directory, "project");
  const agent = path.join(directory, "agent");
  const temporary = path.join(directory, "tmp");
  const appData = path.join(directory, "appdata");
  const localAppData = path.join(directory, "localappdata");
  for (const folder of [project, agent, temporary, appData, localAppData]) mkdirSync(folder);
  const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, APPDATA: appData, LOCALAPPDATA: localAppData,
    TEMP: temporary, TMP: temporary,
    PATH: path.dirname(process.execPath), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
    const value = Object.entries(process.env).find(([entry]) => entry.toLowerCase() === key.toLowerCase())?.[1];
    if (value !== undefined) env[key] = value;
  }
  return { directory, project, agent, temporary, env };
}

function writeProviderConfig(agent: string, provider: QuestionProvider, fullscreen: boolean, outputPad?: 0 | 1): string {
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
    ...(fullscreen ? { tuiMode: "fullscreen", theme: "killeros" } : {}),
    ...(outputPad === undefined ? {} : { outputPad }),
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    defaultThinkingLevel: "off",
  }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { [providerName]: {
    baseUrl: provider.baseUrl, api: "openai-completions", apiKey: "question-fixture-only",
    models: [{ id: modelId, name: "Question fixture model", reasoning: false, input: ["text"], contextWindow: 200_000,
      maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  return path.join(agent, "..", "session.jsonl");
}

function terminalArgs(sessionFile: string, tools: string): string[] {
  return ["--model", `${providerName}/${modelId}`, "--thinking", "off", "--tools", tools,
    "--session", sessionFile, "--offline", "--approve", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-extensions", "--extension", repositoryRoot];
}

/** Staged editor submission: write the text, observe it on the editor line, then send explicit CSI-u Enter. */
async function submitEditorText(terminal: PiTerminalProcess, text: string, options: { signal: AbortSignal }): Promise<void> {
  await terminal.submitEditorText(text, options);
}

type ChoiceView = { entries: Array<{ position: number; text: string }>; selected: number | undefined; dialogTitle: string };

/** Reads the focused native selector: dialog title lines, ordered offered entries, and the cursor row. */
function readChoices(screen: string): ChoiceView {
  const lines = screen.split("\n");
  const entries: Array<{ position: number; text: string }> = [];
  let selected: number | undefined;
  let firstEntryLine = -1;
  for (let index = 0; index < lines.length; index++) {
    // Selector rows render as "→ N. label" for the cursor row and "  N. label" otherwise,
    // optionally indented by the dialog container; other transcript rows never match the body shapes.
    const rawLine = lines[index] ?? "";
    const arrowMatch = /^ ?→ (.*)$/u.exec(rawLine);
    const plainMatch = /^ +(.*)$/u.exec(rawLine);
    const body = (arrowMatch?.[1] ?? plainMatch?.[1])?.trimEnd();
    if (body === undefined) continue;
    const numbered = /^(\d+)\.\s(.*)$/u.exec(body);
    const isPager = body === "Next choices" || body === "Previous choices";
    if (!numbered && !isPager) continue;
    if (firstEntryLine === -1) firstEntryLine = index;
    const position = entries.length + 1;
    entries.push({ position, text: numbered ? `${numbered[1]}. ${numbered[2]}` : body });
    if (arrowMatch) selected = position;
  }
  const titleLines: string[] = [];
  for (let index = firstEntryLine - 1; index >= 0 && titleLines.length < 2; index--) {
    const line = (lines[index] ?? "").trim();
    if (line) titleLines.unshift(line);
    else if (titleLines.length > 0) break;
  }
  return { entries, selected, dialogTitle: titleLines.join("\n") };
}

/** An entry offered only by the main question selector, never by its sub-dialogs. */
const mainSelectorEntry = /^\d+\. (Custom answer|Edit custom answer)$/u;
const moreActionsTitle = /^More actions$/u;
const recentAnswersTitle = /^Recent answers$/u;
const reviewChooserTitle = /^Review option details$/u;

/** Confirms an offered entry and waits for its dialog state to change, not merely for another spinner frame. */
async function chooseOffered(terminal: PiTerminalProcess, target: RegExp, label: string, options: { signal: AbortSignal }): Promise<string> {
  // Capture the cursor at entry so stale pre-action frames can never satisfy the wait.
  const entryCursor = terminal.sequence;
  const screen = await terminal.waitForScreen((candidate) => {
    const view = readChoices(candidate);
    return view.selected !== undefined && view.entries.some((entry) => target.test(entry.text));
  }, { signal: options.signal, after: entryCursor });
  const view = readChoices(screen);
  const wanted = view.entries.find((entry) => target.test(entry.text));
  assert.ok(wanted, `${label}: the dialog must offer an entry matching ${String(target)}`);
  assert.ok(view.selected !== undefined, `${label}: the dialog must show a selected entry`);
  if (wanted.position !== view.selected) {
    const moves = terminal.sequence;
    const distance = wanted.position - view.selected;
    terminal.write((distance > 0 ? dialogDown : dialogUp).repeat(Math.abs(distance)));
    await terminal.waitForScreen((candidate) => readChoices(candidate).selected === wanted.position,
      { signal: options.signal, after: moves });
  }
  const confirmed = terminal.sequence;
  const before = readChoices(terminal.screen());
  const identity = JSON.stringify({ entries: before.entries, title: before.dialogTitle });
  const priorScreen = terminal.screen();
  terminal.write(dialogConfirm);
  await terminal.waitForScreen((candidate) => {
    const current = readChoices(candidate);
    return current.selected === undefined
      || JSON.stringify({ entries: current.entries, title: current.dialogTitle }) !== identity
      || candidate.split("\n").some(line => /Select at (?:most|least) \d+ answers?/u.test(line) && !priorScreen.includes(line));
  }, { signal: options.signal, after: confirmed });
  return wanted.text;
}

/** Waits for a native text-input dialog with the given title (selector rows replaced by an input row). */
async function waitForInputDialog(terminal: PiTerminalProcess, title: string, options: { signal: AbortSignal }): Promise<string> {
  return await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.trim() === title)
    && screen.split("\n").some((line) => /^\s*>/u.test(line)) && readChoices(screen).selected === undefined,
  { signal: options.signal });
}

/**
 * Waits for a focused selector whose screen mentions title. Spinner animation emits fresh frames of the
 * previous dialog, so callers pass entry/dialogTitle discriminators whenever the title is ambiguous.
 */
async function waitForSelector(terminal: PiTerminalProcess, title: string | RegExp, options: {
  signal: AbortSignal;
  after?: number;
  entry?: RegExp;
  dialogTitle?: RegExp;
}): Promise<string> {
  const matches = (screen: string): boolean => typeof title === "string" ? screen.includes(title) : title.test(screen);
  const entryCursor = options.after ?? terminal.sequence;
  return await terminal.waitForScreen((screen) => {
    if (!matches(screen)) return false;
    const view = readChoices(screen);
    if (view.selected === undefined) return false;
    if (options.entry !== undefined && !view.entries.some((entry) => options.entry!.test(entry.text))) return false;
    if (options.dialogTitle !== undefined && !options.dialogTitle.test(view.dialogTitle)) return false;
    return true;
  }, { signal: options.signal, after: entryCursor });
}

/** Pastes a literal value into the focused input dialog, waits for the echo, and submits it. */
async function submitInputDialog(terminal: PiTerminalProcess, value: string, options: { signal: AbortSignal }): Promise<{ echo: string; after: number }> {
  const pasted = terminal.sequence;
  terminal.write(`\x1b[200~${value}\x1b[201~`);
  // CSI in native Input can erase the prompt; observe the pasted tail before confirming.
  const tail = [...value.replace(/[\u0000-\u001f\u007f]/gu, "")].slice(-6).join("");
  const echo = await terminal.waitForScreen((screen) => screen.split("\n").some((line) => (line.trimStart().startsWith(">") || value.includes("\x1b[2J")) && line.includes(tail)),
    { signal: options.signal, after: pasted });
  const after = terminal.sequence;
  terminal.write(dialogConfirm);
  return { echo, after };
}

type QuestionResult = { content: string; rawContent: unknown; details: RecordValue | undefined; isError: boolean | undefined };

/** Reads persisted question tool results; tolerates the brief ENOENT window during atomic session rewrites. */
function readQuestionResults(sessionFile: string): QuestionResult[] {
  const results: QuestionResult[] = [];
  const parse = (content: string): void => {
    for (const line of content.split(/\r?\n/u)) {
      if (!line) continue;
      const entry: unknown = JSON.parse(line);
      if (!isRecordValue(entry) || entry.type !== "message") continue;
      const message = record(entry.message, "session entry message");
      if (message.role !== "toolResult" || message.toolName !== "question") continue;
      const rawContent = message.content;
      const text = typeof rawContent === "string" ? rawContent
        : Array.isArray(rawContent) ? rawContent.map((part) => isRecordValue(part) && typeof part.text === "string" ? part.text : "").join("") : "";
      results.push({ content: text, rawContent, details: isRecordValue(message.details) ? message.details : undefined,
        isError: message.isError === true ? true : undefined });
    }
  };
  for (let attempt = 0; ; attempt++) {
    try {
      parse(readFileSync(sessionFile, "utf8"));
      return results;
    } catch (error) {
      if (attempt >= 20 || !(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Bounded durability wait for a fixture control file whose content satisfies the predicate. */
function waitForControlFile(file: string, accept: (content: string) => boolean, label: string, timeoutMs = 10_000): string {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(file) && accept(readFileSync(file, "utf8"))) return readFileSync(file, "utf8");
    if (Date.now() > deadline) throw new Error(`${label}: timed out waiting for ${path.basename(file)}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** Bounded durability wait until the session file persists the expected number of question results. */
function waitForResultCount(sessionFile: string, expected: number, label: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readQuestionResults(sessionFile).length >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`${label}: timed out waiting for ${expected} persisted question results (found ${readQuestionResults(sessionFile).length})`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** The vector-labelled question result for one turn, asserted against the durable session. */
function singleResult(sessionFile: string, index: number, label: string): QuestionResult {
  const results = readQuestionResults(sessionFile);
  const result = results[index];
  assert.ok(result, `${label}: expected question result ${index + 1}, found ${results.length}`);
  return result;
}

function providerToolDeclaration(body: RecordValue, label: string): RecordValue {
  const tools = body.tools;
  assert.ok(Array.isArray(tools), `${label}: the provider request must declare tools`);
  const entry = tools.find((tool): tool is RecordValue => isRecordValue(tool) && isRecordValue(tool.function) && tool.function.name === "question");
  assert.ok(entry, `${label}: the question tool must be declared to the model`);
  return record(entry.function, `${label} question declaration`);
}

function messageText(body: RecordValue): string {
  const messages = body.messages;
  assert.ok(Array.isArray(messages));
  return JSON.stringify(messages);
}

function rowCountsWith(screen: string, pattern: RegExp): number {
  return screen.split("\n").filter((line) => pattern.test(line.trimStart())).length;
}

/** Requires the actual collapsed call before checking its single-selection presentation. */
function assertSingleCall(screen: string, question: string): void {
  const rows = screen.split("\n");
  const index = rows.findIndex(row => row.includes(`question ${question}`));
  assert.ok(index >= 0, `The collapsed call is visible for ${question}`);
  assert.doesNotMatch(rows.slice(index, index + 2).join("\n"), /multi-select|\[ \]/iu,
    `The collapsed single-select call has no multiple-selection markers: ${question}`);
}

// Catalog ID: Q-01.
test("Question schema, bounds, model-only exposure, and non-TUI rejection", { timeout: 300_000, skip: piRpcShutdownSkip }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "schema");
  const provider = new QuestionProvider();
  const providers = [provider];
  let terminal: PiTerminalProcess | undefined;
  let rpc: PiRpcProcess | undefined;
  const screens: RecordValue = {};
  const observations: RecordValue[] = [];
  const failures: unknown[] = [];
  let printProvider: QuestionProvider | undefined;
  let jsonProvider: QuestionProvider | undefined;
  let sessionFile = "";

  try {
    // Family A: one TUI process carrying the provider-visible schema, the bound matrix, and two-call serialization.
    await provider.listen();
    sessionFile = writeProviderConfig(family.agent, provider, true);
    provider.plan(
      provider.questionCall("Schema omitted bounds", [{ label: "Alpha" }]),
      provider.text("Q1T1 DONE"),
      provider.questionCall("Schema explicit single bounds", [{ label: "Alpha" }], { mode: "single", minSelections: 1, maxSelections: 1 }),
      provider.text("Q1T2 DONE"),
      { kind: "calls", calls: [
        { name: "question", arguments: { question: "Invalid min only", options: [{ label: "Alpha" }], minSelections: 1 } },
        { name: "question", arguments: { question: "Invalid one of two", options: [{ label: "Alpha" }], minSelections: 1, maxSelections: 2 } },
      ] },
      provider.text("Q1T3 DONE"),
      { kind: "calls", calls: [
        { name: "question", arguments: { question: "Invalid max only", options: [{ label: "Alpha" }], maxSelections: 1 } },
        { name: "question", arguments: { question: "Invalid single two of two", options: [{ label: "Alpha" }], mode: "single", minSelections: 2, maxSelections: 2 } },
      ] },
      provider.text("Q1T4 DONE"),
      { kind: "calls", calls: [
        { name: "question", arguments: { question: "Invalid multiple min over max", options: [{ label: "Alpha" }], mode: "multiple", minSelections: 2, maxSelections: 1 } },
        { name: "question", arguments: { question: "Invalid multiple max three", options: [{ label: "Alpha" }], mode: "multiple", maxSelections: 3 } },
      ] },
      provider.text("Q1T5 DONE"),
      { kind: "calls", calls: [{ name: "question", arguments: { question: "Invalid ranked mode", options: [{ label: "Alpha" }], mode: "ranked" } }] },
      provider.text("Q1T6 DONE"),
      provider.questionCall("Nine option maximum ten", Array.from({ length: 9 }, (_, index) => ({ label: `Wide ${index + 1}` })), { mode: "multiple", maxSelections: 10 }),
      provider.text("Q1T7 DONE"),
      provider.questionCall("Multiple one of two", [{ label: "Alpha" }], { mode: "multiple", minSelections: 1, maxSelections: 2 }),
      provider.text("Q1T8 DONE"),
      { kind: "calls", calls: [
        { name: "question", arguments: { question: "Sequential first", options: [{ label: "First pick" }, { label: "First other" }] } },
        { name: "question", arguments: { question: "Sequential second", options: [{ label: "Second pick" }, { label: "Second other" }] } },
      ] },
      provider.text("Q1T9 DONE"),
      provider.questionCall("Single mode without bounds", [{ label: "Alpha" }], { mode: "single" }),
      provider.text("Q1T10 DONE"),
      provider.questionCall("Default mode with single bounds", [{ label: "Alpha" }], { minSelections: 1, maxSelections: 1 }),
      provider.text("Q1T11 DONE"),
    );
    terminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...terminalArgs(sessionFile, "question")],
      cwd: family.project, env: family.env, cols: 100, rows: 30 });
    screens.ready = await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });

    // Vector schema:mode-enum: exact provider-visible mode property; ranked is not offered.
    await submitEditorText(terminal, "q1 turn one", { signal: t.signal });
    screens.t1Dialog = await waitForSelector(terminal, "Schema omitted bounds", { signal: t.signal });
    assert.match(String(screens.t1Dialog), /Choose one answer/u, "schema:mode-enum: the default selector renders single mode");
    await chooseOffered(terminal, /1\. Alpha/u, "schema:mode-enum", { signal: t.signal });
    screens.t1Done = await terminal.waitForScreen((screen) => screen.includes("Q1T1 DONE"), { signal: t.signal });
    assertSingleCall(String(screens.t1Done), "Schema omitted bounds");
    const schemaDeclaration = providerToolDeclaration(provider.requests[0] ?? {}, "schema capture");
    const parameters = record(schemaDeclaration.parameters, "schema parameters");
    const properties = record(parameters.properties, "schema properties");
    assert.deepEqual(record(properties.mode, "schema mode"), {
      type: "string", enum: ["single", "multiple"], description: "Choose one answer or multiple answers; defaults to single",
    }, "schema:mode-enum: the provider-visible mode property is exactly single/multiple; ranked is omitted");
    assert.ok(Array.isArray(parameters.required), "schema:mode-enum: required fields are provider-visible");
    assert.ok(!parameters.required.includes("mode"), "schema:mode-enum: selection mode is optional");
    for (const bound of ["minSelections", "maxSelections"]) {
      assert.equal(record(properties[bound], `schema ${bound}`).type, "integer", `schema:mode-enum: ${bound} is an integer bound`);
    }
    assert.equal(record(properties.question, "schema question").maxLength, 1_000, "schema:mode-enum: the question text bound is provider-visible");
    assert.equal(record(properties.options, "schema options").maxItems, 9, "schema:mode-enum: at most nine options are provider-visible");
    let result = singleResult(sessionFile, 0, "bounds:single-omitted");
    assert.deepEqual([result.details?.answer, result.details?.selectedIndex, result.details?.wasCustom, "mode" in (result.details ?? {})],
      ["Alpha", 1, false, false], "bounds:single-omitted: omitted bounds with one option open the dialog without a mode field");

    // Vector bounds:single-1-1: explicit 1/1 single bounds are accepted.
    await submitEditorText(terminal, "q1 turn two", { signal: t.signal });
    await waitForSelector(terminal, "Schema explicit single bounds", { signal: t.signal });
    await chooseOffered(terminal, /1\. Alpha/u, "bounds:single-1-1", { signal: t.signal });
    const t2Done = await terminal.waitForScreen((screen) => screen.includes("Q1T2 DONE"), { signal: t.signal });
    assertSingleCall(t2Done, "Schema explicit single bounds");
    result = singleResult(sessionFile, 1, "bounds:single-1-1");
    assert.deepEqual([result.details?.answer, result.details?.selectedIndex, "mode" in (result.details ?? {})],
      ["Alpha", 1, false], "bounds:single-1-1: explicit 1/1 bounds behave like omitted bounds");

    // Vectors bounds:single-min-only and bounds:single-1-2: two invalid calls in one message reject without dialogs.
    await submitEditorText(terminal, "q1 turn three", { signal: t.signal });
    screens.t3Done = await terminal.waitForScreen((screen) => screen.includes("Q1T3 DONE"), { signal: t.signal });
    for (const question of ["Invalid min only", "Invalid one of two"]) {
      assert.ok(String(screens.t3Done).includes(`question question="${question}"`),
        `Invalid call uses Pi's generic renderer fallback: ${question}`);
    }
    assert.ok(!String(screens.t3Done).includes("Choose one answer"),
      "bounds:single-min-only: invalid single bounds never open a selector dialog");
    assert.ok(readChoices(String(screens.t3Done)).selected === undefined,
      "bounds:single-1-2: no dialog remains open after both invalid calls settle");
    const t3Messages = messageText(provider.requests[5] ?? {});
    assert.match(t3Messages, /Single-select question bounds must be omitted or both be 1/u,
      "bounds:single-min-only: the schema error reaches the provider follow-up before any dialog");
    assert.match(t3Messages, /Invalid one of two[\s\S]*Single-select question bounds must be omitted or both be 1/u,
      "bounds:single-1-2: the second invalid call in the same message is also rejected");

    // Vectors bounds:single-max-only and bounds:single-2-2.
    await submitEditorText(terminal, "q1 turn four", { signal: t.signal });
    const t4Done = await terminal.waitForScreen((screen) => screen.includes("Q1T4 DONE"), { signal: t.signal });
    for (const question of ["Invalid max only", "Invalid single two of two"]) {
      assert.ok(t4Done.includes(`question question="${question}"`),
        `Invalid call uses Pi's generic renderer fallback: ${question}`);
    }
    assert.ok(readChoices(t4Done).selected === undefined, "Both rejected calls settle without an open selector");
    const resultCallIds = SessionManager.open(sessionFile).getEntries().flatMap(entry =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "question"
        ? [entry.message.toolCallId] : []);
    for (const [offset, toolCallId] of ["question-call-5-0", "question-call-5-1", "question-call-7-0", "question-call-7-1"].entries()) {
      const rejected = singleResult(sessionFile, 2 + offset, `single-bound rejection ${toolCallId}`);
      assert.equal(resultCallIds[2 + offset], toolCallId, "Each invalid input has its own durable error result in call order");
      assert.equal(rejected.isError, true);
      assert.match(rejected.content, /^(?:Error: )?Single-select question bounds must be omitted or both be 1$/u);
    }
    const t4Messages = messageText(provider.requests[7] ?? {});
    assert.match(t4Messages, /Invalid max only[\s\S]*Single-select question bounds must be omitted or both be 1/u,
      "bounds:single-max-only: a lone maximum is rejected before rendering");
    assert.match(t4Messages, /Invalid single two of two[\s\S]*Single-select question bounds must be omitted or both be 1/u,
      "bounds:single-2-2: explicit 2/2 single bounds are rejected before rendering");

    // Vectors bounds:multi-2-1 and bounds:multi-max-3-one-option.
    await submitEditorText(terminal, "q1 turn five", { signal: t.signal });
    const t5Done = await terminal.waitForScreen((screen) => screen.includes("Q1T5 DONE"), { signal: t.signal });
    for (const question of ["Invalid multiple min over max", "Invalid multiple max three"]) {
      assert.ok(t5Done.includes(`question question="${question}"`),
        `Invalid call uses Pi's generic renderer fallback: ${question}`);
    }
    const t5Messages = messageText(provider.requests[9] ?? {});
    assert.match(t5Messages, /Question minimum selections cannot exceed maximum selections/u,
      "bounds:multi-2-1: a minimum above the maximum is rejected before rendering");
    assert.match(t5Messages, /Question allows at most 2 selections including one custom answer/u,
      "bounds:multi-max-3-one-option: one option allows at most two selections");

    const multipleErrors = [
      "Question minimum selections cannot exceed maximum selections",
      "Question allows at most 2 selections including one custom answer",
    ];
    const multipleCallIds = SessionManager.open(sessionFile).getEntries().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "question"
        ? [entry.message.toolCallId] : []);
    for (const [offset, expected] of multipleErrors.entries()) {
      const rejected = singleResult(sessionFile, 6 + offset, "multiple-bound rejection " + offset);
      assert.equal(multipleCallIds[6 + offset], "question-call-9-" + offset,
        "Each invalid multiple bound persists an error for its own native call identity");
      assert.equal(rejected.isError, true);
      assert.equal(rejected.content.replace(/^Error: /u, ""), expected);
      assert.equal(rejected.details?.answer, undefined);
      assert.equal(rejected.details?.answers, undefined);
    }
    assert.equal(readChoices(terminal.screen()).selected, undefined,
      "Invalid multiple bounds leave no interactive selector after settlement");

    // Vector schema:ranked-rejected: the schema boundary rejects the undocumented mode.
    await submitEditorText(terminal, "q1 turn six", { signal: t.signal });
    await terminal.waitForScreen((screen) => screen.includes("Q1T6 DONE"), { signal: t.signal });
    assert.match(messageText(provider.requests[11] ?? {}), /Validation failed for tool/u,
      "schema:ranked-rejected: a ranked mode call fails at the schema boundary");

    // Vector bounds:multi-max-10-nine-options: nine options make a maximum of ten valid; Escape cancels the open dialog.
    await submitEditorText(terminal, "q1 turn seven", { signal: t.signal });
    screens.t7Dialog = await waitForSelector(terminal, "Nine option maximum ten", { signal: t.signal });
    assert.match(String(screens.t7Dialog), /Selected 0 · choose 1–10/u, "bounds:multi-max-10-nine-options: the valid wide bound renders its range");
    terminal.write(dialogCancel);
    await terminal.waitForScreen((screen) => screen.includes("Q1T7 DONE") && readChoices(screen).selected === undefined,
      { signal: t.signal });
    result = singleResult(sessionFile, 9, "bounds:multi-max-10-nine-options");
    assert.deepEqual([result.details?.cancelled, result.details?.answers, result.details?.selectedIndices],
      [true, [], []], "bounds:multi-max-10-nine-options: cancelling a valid wide dialog discards pending answers");

    // Vector bounds:multi-1-2: a complete multi-select answer under the accepted bound.
    await submitEditorText(terminal, "q1 turn eight", { signal: t.signal });
    await waitForSelector(terminal, "Multiple one of two", { signal: t.signal });
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "bounds:multi-1-2", { signal: t.signal });
    await waitForSelector(terminal, "Multiple one of two", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Submit answers/u, "bounds:multi-1-2", { signal: t.signal });
    await terminal.waitForScreen((screen) => screen.includes("Q1T8 DONE"), { signal: t.signal });
    result = singleResult(sessionFile, 10, "bounds:multi-1-2");
    assert.deepEqual([result.details?.mode, result.details?.answers, result.details?.selectedIndices],
      ["multiple", ["Alpha"], [1]], "bounds:multi-1-2: one predefined option plus a custom slot accepts the source 1/2 bounds");

    // Vector sequential:two-calls: one dialog at a time, order preserved end to end.
    await submitEditorText(terminal, "q1 turn nine", { signal: t.signal });
    screens.t9First = await waitForSelector(terminal, "Sequential first", { signal: t.signal });
    assert.equal(readQuestionResults(sessionFile).length, 11,
      "sequential:two-calls: neither pending call publishes a result before the first answer");
    assert.equal(provider.requests.length, 17,
      "sequential:two-calls: no provider follow-up runs while the first dialog is pending");
    assert.ok(!readChoices(String(screens.t9First)).entries.some((entry) => /Second pick/u.test(entry.text)),
      "sequential:two-calls: the second question dialog may not open while the first is pending");
    await chooseOffered(terminal, /1\. First pick/u, "sequential:two-calls", { signal: t.signal });
    screens.t9Second = await waitForSelector(terminal, "Sequential second", { signal: t.signal, entry: /\d+\. Second pick/u });
    assert.equal(readQuestionResults(sessionFile).length, 12,
      "sequential:two-calls: only the first answer persists while the second dialog is pending");
    assert.equal(provider.requests.length, 17,
      "sequential:two-calls: the provider waits for both sequential answers");
    assert.ok(readChoices(String(screens.t9Second)).entries.some((entry) => /Second pick/u.test(entry.text))
      && !readChoices(String(screens.t9Second)).entries.some((entry) => /First pick/u.test(entry.text)),
      "sequential:two-calls: the second question dialog opens only after the first answer");
    await chooseOffered(terminal, /1\. Second pick/u, "sequential:two-calls", { signal: t.signal });
    await terminal.waitForScreen((screen) => screen.includes("Q1T9 DONE"), { signal: t.signal });
    const t9Messages = messageText(provider.requests[17] ?? {});
    const firstAnswer = t9Messages.indexOf("User selected: First pick");
    const secondAnswer = t9Messages.indexOf("User selected: Second pick");
    assert.ok(firstAnswer >= 0 && secondAnswer > firstAnswer,
      "sequential:two-calls: both answers publish in call order to the provider follow-up");
    const t9Results = readQuestionResults(sessionFile).slice(11, 13);
    assert.deepEqual(t9Results.map((entry) => entry.details?.answer), ["First pick", "Second pick"],
      "sequential:two-calls: the durable session preserves the execution order");
    // The accepted-bound source matrix also distinguishes an explicit mode from explicit bounds.
    for (const [offset, question] of ["Single mode without bounds", "Default mode with single bounds"].entries()) {
      await submitEditorText(terminal, `q1 accepted ${offset}`, { signal: t.signal });
      const dialog = await waitForSelector(terminal, question, { signal: t.signal });
      assert.match(dialog, /Choose one answer/u);
      assert.doesNotMatch(dialog, /multi-select|\[ \]/iu);
      terminal.write(dialogCancel);
      const done = await terminal.waitForScreen(screen => screen.includes(`Q1T${10 + offset} DONE`), { signal: t.signal });
      assertSingleCall(done, question);
      const accepted = singleResult(sessionFile, 13 + offset, `bounds:accepted-${offset}`);
      assert.equal(accepted.details?.cancelled, true);
      assert.ok(accepted.details && !("mode" in accepted.details), "Accepted single bounds retain the single-result shape");
    }
    assert.equal(provider.requests.length, 22, "the TUI schema family uses exactly its planned provider requests");
    const tuiClose = await terminal.close();
    assert.deepEqual([tuiClose.code, tuiClose.forced], [0, false], "the TUI schema family exits naturally");
    terminal = undefined;
    observations.push({ family: "tui", providerRequests: provider.requests.length, questionResults: 15 });

    // Family B: one RPC process with codemode — the question tool stays model-visible but script-unreachable,
    // and a model-issued call is rejected with the interactive-mode requirement and no custom UI.
    const rpcProvider = new QuestionProvider();
    providers.push(rpcProvider);
    await rpcProvider.listen();
    const rpcDirectory = path.join(family.directory, "rpc");
    const rpcAgent = path.join(rpcDirectory, "agent");
    const rpcProject = path.join(rpcDirectory, "project");
    for (const folder of [rpcAgent, rpcProject]) mkdirSync(folder, { recursive: true });
    const rpcSession = writeProviderConfig(rpcAgent, rpcProvider, false);
    rpcProvider.plan(
      { kind: "calls", calls: [{ name: "codemode", arguments: { code: [
        "let outcome;",
        "try {",
        "  await tools.question({ question: \"Script question\", options: [{ label: \"Nope\" }] });",
        "  outcome = JSON.stringify({ callable: true });",
        "} catch (error) {",
        "  outcome = JSON.stringify({ callable: false, error: String(error && error.message) });",
        "}",
        "return outcome;",
      ].join("\n") } }] },
      rpcProvider.text("Q1 RPC SCRIPT DONE"),
      rpcProvider.questionCall("Rpc boundary question", [{ label: "Alpha" }]),
      rpcProvider.text("Q1 RPC ASK DONE"),
    );
    rpc = new PiRpcProcess({ cliPath, cwd: rpcProject, env: { ...family.env, PI_CODING_AGENT_DIR: rpcAgent },
      args: ["--mode", "rpc", ...terminalArgs(rpcSession, "question,codemode"), "--extension", "builtin:codemode"] });
    const state = record((await rpc.command("get_state", {}, { timeoutMs: 30_000, signal: t.signal })).data, "RPC state");
    assert.equal(stringField(state, "sessionFile", "RPC"), rpcSession);
    let uiDialogCount = 0;
    const uiObserverController = new AbortController();
    const uiObserver = rpc.waitForRecord((entry) => {
      if (entry.type === "extension_ui_request" && ["select", "input", "confirm", "custom"].includes(String(entry.method))) uiDialogCount += 1;
      return false;
    }, { timeoutMs: 150_000, signal: uiObserverController.signal });
    void uiObserver.catch(() => undefined);

    let cursor = rpc.currentSequence;
    await rpc.command("prompt", { message: "run the script" }, { timeoutMs: 30_000, signal: t.signal });
    await rpc.waitFor((entry) => entry.type === "agent_settled", { after: cursor, timeoutMs: 90_000, signal: t.signal });
    const scriptRequest = rpcProvider.requests[0];
    assert.ok(scriptRequest, "model-only: the script turn must reach the provider");
    const rpcDeclaration = providerToolDeclaration(scriptRequest, "model-only");
    assert.deepEqual(record(record(rpcDeclaration.parameters, "model-only schema").properties, "model-only schema properties").mode,
      { type: "string", enum: ["single", "multiple"], description: "Choose one answer or multiple answers; defaults to single" },
      "model-only: the question tool keeps its exact schema beside codemode");
    const rpcToolNames = (Array.isArray(scriptRequest.tools) ? scriptRequest.tools : [])
      .map((tool) => isRecordValue(tool) && isRecordValue(tool.function) ? String(tool.function.name) : "");
    assert.ok(rpcToolNames.includes("codemode"), "model-only: the codemode tool is declared in the same request");
    const scriptFollowUp = rpcProvider.requests[1];
    assert.ok(scriptFollowUp, "model-only: the script follow-up must reach the provider");
    assert.match(messageText(scriptFollowUp), /\\"callable\\":false/u, "model-only: a codemode script cannot reach the question tool");
    assert.doesNotMatch(messageText(scriptFollowUp), /\\"callable\\":true/u, "model-only: no script path may call the question tool");

    cursor = rpc.currentSequence;
    await rpc.command("prompt", { message: "ask me the boundary question" }, { timeoutMs: 30_000, signal: t.signal });
    await rpc.waitFor((entry) => entry.type === "agent_settled", { after: cursor, timeoutMs: 90_000, signal: t.signal });
    const rejectionFollowUp = rpcProvider.requests[3];
    assert.ok(rejectionFollowUp, "rpc: the rejected call must reach the provider follow-up");
    assert.match(messageText(rejectionFollowUp), /The question tool requires interactive TUI mode/u,
      "rpc: a model-issued question call is rejected with the interactive-mode requirement");
    uiObserverController.abort(new Error("UI observation finished"));
    assert.equal(uiDialogCount, 0, "rpc: the rejected question opens no custom UI dialog");
    const rpcResults = readQuestionResults(rpcSession);
    assert.equal(rpcResults.length, 1, "rpc: exactly one question result persists");
    assert.deepEqual(rpcResults[0], {
      content: "The question tool requires interactive TUI mode",
      rawContent: [{ type: "text", text: "The question tool requires interactive TUI mode" }],
      details: {}, isError: true,
    }, "rpc: the complete durable error preserves the exact native rejection message");
    const rpcClose = await rpc.close();
    assert.deepEqual([rpcClose.exit.code, rpcClose.forced], [0, false], "the RPC family exits naturally");
    rpc = undefined;
    observations.push({ family: "rpc", providerRequests: rpcProvider.requests.length, uiDialogRequests: uiDialogCount });

    // Families C and D: print and JSON one-shots reject the interactive question and exit naturally.
    const runOneShot = async (mode: "print" | "json"): Promise<{ stdout: string; provider: QuestionProvider }> => {
      const directory = path.join(family.directory, mode);
      const agent = path.join(directory, "agent");
      const project = path.join(directory, "project");
      mkdirSync(agent, { recursive: true });
      mkdirSync(project, { recursive: true });
      const oneShotProvider = new QuestionProvider();
      providers.push(oneShotProvider);
      await oneShotProvider.listen();
      const session = writeProviderConfig(agent, oneShotProvider, false);
      oneShotProvider.plan(
        oneShotProvider.questionCall(`Boundary question ${mode}`, [{ label: "Alpha" }]),
        oneShotProvider.text(`Q1 ${mode.toUpperCase()} DONE`),
      );
      const invocation = promisify(execFile)(process.execPath,
        [cliPath, "--print", ...(mode === "json" ? ["--mode", "json"] : []), ...terminalArgs(session, "question"), `ask the ${mode} boundary question`],
        { cwd: project, env: { ...family.env, PI_CODING_AGENT_DIR: agent }, timeout: 60_000, maxBuffer: 2_097_152, signal: t.signal });
      invocation.child.stdin?.end();
      const runResult = await invocation;
      assert.equal(invocation.child.exitCode, 0, `${mode}: Pi must exit naturally`);
      assert.match(runResult.stdout, new RegExp(`Q1 ${mode.toUpperCase()} DONE`, "u"), `${mode}: the scripted settlement reaches stdout`);
      const followUp = oneShotProvider.requests[1];
      assert.ok(followUp, `${mode}: the rejected call must reach the provider follow-up`);
      assert.match(messageText(followUp), /The question tool requires interactive TUI mode/u,
        `${mode}: a model-issued question call is rejected with the interactive-mode requirement`);
      const results = readQuestionResults(session);
      assert.equal(results.length, 1, `${mode}: exactly one question result persists`);
      assert.deepEqual(results[0], {
        content: "The question tool requires interactive TUI mode",
        rawContent: [{ type: "text", text: "The question tool requires interactive TUI mode" }],
        details: {}, isError: true,
      }, `${mode}: the complete durable error preserves the exact native rejection message`);
      return { stdout: runResult.stdout, provider: oneShotProvider };
    };
    const printRun = await runOneShot("print");
    printProvider = printRun.provider;
    observations.push({ family: "print", providerRequests: printProvider.requests.length });
    const jsonRun = await runOneShot("json");
    jsonProvider = jsonRun.provider;
    const jsonEvents = jsonRun.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const settledEvent = jsonEvents.map((line) => record(JSON.parse(line), "JSON mode event")).find((event) => event.type === "agent_settled");
    assert.ok(settledEvent !== undefined && settledEvent.aborted === false, "json: the run settles without abort in JSON events");
    assert.ok(jsonEvents.some((line) => line.includes("The question tool requires interactive TUI mode")),
      "json: the tool error is observable in JSON event output");
    observations.push({ family: "json", providerRequests: jsonProvider.requests.length });

    await provider.close();
    await rpcProvider.close();
    await printProvider.close();
    await jsonProvider.close();
    t.diagnostic(JSON.stringify({ scenarioId: "Q-01", piLaunches: 4, observations }));
  } catch (error) {
    failures.push(error);
  } finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-01 TUI cleanup: ${JSON.stringify(result)}`));
      } catch (error) { failures.push(error); }
    }
    if (rpc) {
      try {
        const result = await rpc.close();
        if (result.exit.code !== 0 || result.forced) failures.push(new Error(`Q-01 RPC cleanup: ${JSON.stringify(result)}`));
      } catch (error) { failures.push(error); }
    }
    for (const closing of providers) {
      try { await closing.close(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Q-01 question schema and mode-boundary scenario failed",
      errors: failures,
      diagnostics: JSON.stringify({ scenarioId: "Q-01", platform: process.platform, node: process.version,
        providerRequests: provider.requests.length, providerFaults: provider.faults, observations, screens,
        terminal: terminal?.diagnostics(), rpc: rpc?.diagnostics() }, null, 2) });
  }
  await removeDirectoryEventually(family.directory);
});

// Catalog ID: Q-02.
test("Native question selection, filtering, custom answers, and count limits", { timeout: 300_000 }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "native");
  const control = path.join(family.directory, "control");
  mkdirSync(control);
  const extension = path.join(family.directory, "question-observer.ts");
  writeFileSync(extension, questionControlExtensionSource(control));
  const provider = new QuestionProvider();
  let terminal: PiTerminalProcess | undefined;
  const screens: RecordValue = {};
  const failures: unknown[] = [];
  let sessionFile = "";

  try {
    await provider.listen();
    sessionFile = writeProviderConfig(family.agent, provider, true);
    provider.plan(
      provider.questionCall("Duplicate labels", [{ label: "Custom answer" }, { label: "Custom answer" }]),
      provider.text("Q2T1 DONE"),
      provider.questionCall("Filter while selecting", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple", minSelections: 2, maxSelections: 2 }),
      provider.text("Q2T2 DONE"),
      provider.questionCall("Cancel the multi answer", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple" }),
      provider.text("Q2T3 DONE"),
      provider.questionCall("Count limits", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple", maxSelections: 1 }),
      provider.text("Q2T4 DONE"),
      provider.questionCall("Edit the custom answer", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple", maxSelections: 2 }),
      provider.text("Q2T5 DONE"),
      provider.questionCall("Cancel custom input", [{ label: "Alpha" }, { label: "Beta" }]),
      provider.text("Q2T6 DONE"),
      provider.questionCall("Unicode and control answers", [{ label: "Alpha" }]),
      provider.text("Q2T7 DONE"),
      provider.questionCall("Strip typed controls", [{ label: "Alpha" }]),
      provider.text("Q2T8 DONE"),
      provider.questionCall("Bypass the maximum", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple", maxSelections: 1 }),
      provider.text("Q2T9 DONE"),
      provider.questionCall("Description filter", [{ label: "Alpha" }, { label: "Beta", description: "Second choice" }]),
      provider.text("Q2T10 DONE"),
      provider.questionCall("Oversized filter", [{ label: "Alpha" }], { mode: "multiple" }),
      provider.text("Q2T11 DONE"),
      provider.questionCall("Strip typed ANSI controls", [{ label: "Alpha" }]),
      provider.text("Q2T12 DONE"),
    );
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
      cwd: family.project, env: family.env, cols: 100, rows: 30 });
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
    let settlements = 0;
    const settle = async (marker: string): Promise<string> => {
      assert.ok(terminal);
      const screen = await terminal.waitForScreen((candidate) => candidate.includes(marker), { signal: t.signal });
      const expected = ++settlements;
      const content = waitForControlFile(path.join(control, "settled.json"), (text) => {
        const event = record(JSON.parse(text), "native settlement");
        return event.count === expected;
      }, marker);
      assert.deepEqual(record(JSON.parse(content), "native settlement"),
        { count: expected, idle: true, pending: false, aborted: false }, `${marker}: native final settlement`);
      return screen;
    };

    // Vector selection:duplicate-labels: identical labels keep their own index.
    await submitEditorText(terminal, "q2 turn one", { signal: t.signal });
    screens.t1 = await waitForSelector(terminal, "Duplicate labels", { signal: t.signal });
    const chosen = await chooseOffered(terminal, /^2\. Custom answer/u, "selection:duplicate-labels", { signal: t.signal });
    assert.equal(chosen, "2. Custom answer", "selection:duplicate-labels: the second duplicate is its own offered entry");
    await settle("Q2T1 DONE");
    let result = singleResult(sessionFile, 0, "selection:duplicate-labels");
    assert.deepEqual(result, {
      content: "User selected: Custom answer",
      rawContent: [{ type: "text", text: "User selected: Custom answer" }],
      details: { question: "Duplicate labels", options: ["Custom answer", "Custom answer"],
        answer: "Custom answer", selectedIndex: 2, wasCustom: false },
      isError: undefined,
    }, "selection:duplicate-labels: duplicate labels preserve the complete result and selected index");

    // Vector filter:hidden-selections: a filtered-out checked option survives with its original index.
    await submitEditorText(terminal, "q2 turn two", { signal: t.signal });
    await waitForSelector(terminal, "Filter while selecting", { signal: t.signal });
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "filter:hidden-selections", { signal: t.signal });
    screens.t2Checked = await waitForSelector(terminal, "Filter while selecting", { signal: t.signal, entry: mainSelectorEntry });
    assert.match(String(screens.t2Checked), /\[x\] Alpha/u, "filter:hidden-selections: Alpha is checked before filtering");
    await chooseOffered(terminal, /More actions/u, "filter:hidden-selections", { signal: t.signal });
    await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
    await chooseOffered(terminal, /Filter options/u, "filter:hidden-selections", { signal: t.signal });
    await waitForInputDialog(terminal, "Filter options", { signal: t.signal });
    await submitInputDialog(terminal, "bEtA", { signal: t.signal });
    screens.t2Filtered = await waitForSelector(terminal, "Filter while selecting", { signal: t.signal, entry: mainSelectorEntry });
    assert.match(String(screens.t2Filtered), /filtered/u, "filter:hidden-selections: the selector reports the active filter");
    assert.ok(!/\[.\] Alpha/u.test(String(screens.t2Filtered)), "filter:hidden-selections: Alpha is hidden by the case-insensitive filter");
    assert.match(String(screens.t2Filtered), /\[ \] Beta/u, "filter:hidden-selections: Beta stays offered under the filter");
    await chooseOffered(terminal, /\[ \] Beta/u, "filter:hidden-selections", { signal: t.signal });
    await waitForSelector(terminal, "Filter while selecting", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Submit answers/u, "filter:hidden-selections", { signal: t.signal });
    await settle("Q2T2 DONE");
    result = singleResult(sessionFile, 1, "filter:hidden-selections");
    assert.deepEqual(result.details, { question: "Filter while selecting", options: ["Alpha", "Beta"],
      mode: "multiple", answers: ["Alpha", "Beta"], selectedIndices: [1, 2] },
    "filter:hidden-selections: the hidden selection submits with its original index and complete details");

    // Vector cancel:multi-select: Escape discards pending multi-select answers.
    await submitEditorText(terminal, "q2 turn three", { signal: t.signal });
    await waitForSelector(terminal, "Cancel the multi answer", { signal: t.signal });
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "cancel:multi-select", { signal: t.signal });
    await waitForSelector(terminal, "Cancel the multi answer", { signal: t.signal, entry: mainSelectorEntry });
    terminal.write(dialogCancel);
    await settle("Q2T3 DONE");
    result = singleResult(sessionFile, 2, "cancel:multi-select");
    assert.deepEqual(result, { content: "User cancelled the question",
      rawContent: [{ type: "text", text: "User cancelled the question" }],
      details: { question: "Cancel the multi answer", options: ["Alpha", "Beta"], mode: "multiple",
        answers: [], selectedIndices: [], cancelled: true }, isError: undefined },
    "cancel:multi-select: cancellation discards the pending answer and preserves complete result metadata");

    const resizeWarningHistory = async (rows: 30 | 600, marker: string): Promise<void> => {
      assert.ok(terminal);
      const after = terminal.sequence;
      terminal.resize(100, rows);
      await terminal.waitForScreen(screen => screen.includes(marker) && screen.includes("❯"), { signal: t.signal, after });
    };
    await resizeWarningHistory(600, "Q2T3 DONE");
    const warningsAfter = (screen: string, marker: string): string[] => {
      const boundary = screen.indexOf(marker);
      assert.ok(boundary >= 0, `Warning history must retain the completed turn ${marker}`);
      // Native notifications append to the transcript; resizing can reveal older startup warnings.
      return screen.slice(boundary + marker.length).split("\n").map(line => line.trim())
        .filter(line => /^(?:Error|Warning): /u.test(line));
    };

    // Vector counts:invalid-and-toggle: notifications preserve selections and allow toggling off.
    await submitEditorText(terminal, "q2 turn four", { signal: t.signal });
    await waitForSelector(terminal, "Count limits", { signal: t.signal });
    const countRequests = provider.requests.length;
    await chooseOffered(terminal, /Submit answers/u, "counts:invalid-and-toggle", { signal: t.signal });
    screens.t4Min = await terminal.waitForScreen((screen) => screen.includes("Error: Select at least 1 answer"),
      { signal: t.signal });
    assert.match(String(screens.t4Min), /\[ \] Alpha/u, "counts:invalid-and-toggle: the failed submit keeps the selection state");
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "counts:invalid-and-toggle", { signal: t.signal });
    await waitForSelector(terminal, "Count limits", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /2\. \[ \] Beta/u, "counts:invalid-and-toggle", { signal: t.signal });
    screens.t4Max = await terminal.waitForScreen((screen) => screen.includes("Error: Select at most 1 answer")
      && readChoices(screen).entries.some(entry => /1\. \[x\] Alpha/u.test(entry.text))
      && readChoices(screen).entries.some(entry => /2\. \[ \] Beta/u.test(entry.text)), { signal: t.signal });
    assert.equal(readQuestionResults(sessionFile).length, 3,
      "counts:invalid-and-toggle: rejected submissions publish no partial result");
    assert.equal(provider.requests.length, countRequests,
      "counts:invalid-and-toggle: rejected submissions do not advance the provider");
    await chooseOffered(terminal, /1\. \[x\] Alpha/u, "counts:invalid-and-toggle", { signal: t.signal });
    screens.t4Toggled = await waitForSelector(terminal, "Count limits", { signal: t.signal, entry: mainSelectorEntry });
    assert.ok(!/\[x\] Alpha/u.test(String(screens.t4Toggled)), "counts:invalid-and-toggle: toggling off clears the checked row");
    await chooseOffered(terminal, /2\. \[ \] Beta/u, "counts:invalid-and-toggle", { signal: t.signal });
    await waitForSelector(terminal, "Count limits", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Submit answers/u, "counts:invalid-and-toggle", { signal: t.signal });
    await settle("Q2T4 DONE");
    result = singleResult(sessionFile, 3, "counts:invalid-and-toggle");
    assert.deepEqual(result.details, { question: "Count limits", options: ["Alpha", "Beta"], mode: "multiple",
      answers: ["Beta"], selectedIndices: [2] },
    "counts:invalid-and-toggle: the toggled-off answer is absent and Beta retains its original index");

    assert.ok(terminal.screen().includes("Q2T1 DONE"), "Count-warning history remains visible from the first completed turn");
    assert.deepEqual(warningsAfter(terminal.screen(), "Q2T3 DONE"),
      ["Error: Select at least 1 answer", "Error: Select at most 1 answer"],
      "Invalid-count sequence publishes exactly one minimum and one maximum notification in order");

    await resizeWarningHistory(30, "Q2T4 DONE");

    // Vector custom:edit-remove: the custom answer can be replaced, cancelled, removed, and re-entered.
    await submitEditorText(terminal, "q2 turn five", { signal: t.signal });
    await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal });
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "custom:edit-remove", { signal: t.signal });
    await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Custom answer/u, "custom:edit-remove", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, " First ", { signal: t.signal });
    screens.t5Padded = await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal, entry: mainSelectorEntry });
    assert.match(String(screens.t5Padded), /Selected 2/u, "custom:edit-remove: the trimmed custom answer counts toward the selection");
    await chooseOffered(terminal, /Edit custom answer/u, "custom:edit-remove", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    terminal.write(dialogCancel);
    await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Edit custom answer/u, "custom:edit-remove", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, "Edited", { signal: t.signal });
    await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /More actions/u, "custom:edit-remove", { signal: t.signal });
    await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
    await chooseOffered(terminal, /Remove custom answer/u, "custom:edit-remove", { signal: t.signal });
    screens.t5Removed = await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal, entry: mainSelectorEntry });
    assert.ok(!readChoices(String(screens.t5Removed)).entries.some((entry) => /Remove custom answer/u.test(entry.text)),
      "custom:edit-remove: removal drops the remove action");
    await chooseOffered(terminal, /Custom answer/u, "custom:edit-remove", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, "Final", { signal: t.signal });
    await waitForSelector(terminal, "Edit the custom answer", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Submit answers/u, "custom:edit-remove", { signal: t.signal });
    await settle("Q2T5 DONE");
    result = singleResult(sessionFile, 4, "custom:edit-remove");
    assert.deepEqual(result, { content: "User selected multiple answers:\n- Alpha\n- Final",
      rawContent: [{ type: "text", text: "User selected multiple answers:\n- Alpha\n- Final" }],
      details: { question: "Edit the custom answer", options: ["Alpha", "Beta"], mode: "multiple",
        answers: ["Alpha", "Final"], selectedIndices: [1], customAnswer: "Final" }, isError: undefined },
    "custom:edit-remove: the complete result preserves the predefined choice and final custom answer");

    // Vector custom:input-cancel: cancelling the custom input returns to the selector.
    await submitEditorText(terminal, "q2 turn six", { signal: t.signal });
    await waitForSelector(terminal, "Cancel custom input", { signal: t.signal });
    await chooseOffered(terminal, /Custom answer/u, "custom:input-cancel", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    terminal.write(dialogCancel);
    screens.t6Back = await waitForSelector(terminal, "Cancel custom input", { signal: t.signal, entry: mainSelectorEntry });
    assert.match(String(screens.t6Back), /Choose one answer/u, "custom:input-cancel: the single selector returns after input cancellation");
    await chooseOffered(terminal, /2\. Beta/u, "custom:input-cancel", { signal: t.signal });
    await settle("Q2T6 DONE");
    result = singleResult(sessionFile, 5, "custom:input-cancel");
    assert.deepEqual(result.details, { question: "Cancel custom input", options: ["Alpha", "Beta"],
      answer: "Beta", selectedIndex: 2, wasCustom: false },
    "custom:input-cancel: the complete predefined-choice details survive the cancelled input");

    // Vectors custom:unicode-limits and custom:4-000-astral: validation notifications and the exact boundary.
    await submitEditorText(terminal, "q2 turn seven", { signal: t.signal });
    await waitForSelector(terminal, "Unicode and control answers", { signal: t.signal });
    const reopenInput = async (): Promise<void> => {
      assert.ok(terminal);
      await chooseOffered(terminal, /Custom answer/u, "custom:unicode-limits", { signal: t.signal });
      await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    };
    const pendingRequests = provider.requests.length;
    for (const { value, message, count } of [
      { value: "  ", message: "Error: Enter a nonempty custom answer", count: 1 },
      { value: "𐐀".repeat(4_001), message: "Error: Custom answers are limited to 4,000 characters", count: 1 },
      { value: "\u0007" + "𐐀".repeat(4_000), message: "Error: Custom answers are limited to 4,000 characters", count: 2 },
      { value: "\x1b[2J" + "𐐀".repeat(4_000), message: "Error: Custom answers are limited to 4,000 characters", count: 3 },
    ]) {
      await reopenInput();
      const { echo, after } = await submitInputDialog(terminal, value, { signal: t.signal });
      const previousNotices = echo.split(message).length - 1;
      await terminal.waitForScreen(screen => readChoices(screen).selected !== undefined
        && screen.split(message).length - 1 >= Math.max(count, previousNotices + 1), { signal: t.signal, after });
      assert.equal(readQuestionResults(sessionFile).length, 6, "custom:unicode-limits: rejected input publishes no partial answer");
      assert.equal(provider.requests.length, pendingRequests, "custom:unicode-limits: rejected input does not advance the provider");
    }
    await reopenInput();
    await submitInputDialog(terminal, "𐐀".repeat(4_000), { signal: t.signal });
    await settle("Q2T7 DONE");
    result = singleResult(sessionFile, 6, "custom:4-000-astral");
    const astralAnswer = result.details?.answer;
    assert.ok(typeof astralAnswer === "string", "custom:4-000-astral: the custom answer persists as text");
    assert.equal([...astralAnswer].length, 4_000,
      "custom:4-000-astral: exactly 4,000 astral characters are accepted");
    assert.equal(astralAnswer, "𐐀".repeat(4_000), "custom:4-000-astral: every accepted character is preserved");
    assert.match(result.content, /User wrote: /u, "custom:4-000-astral: the custom answer publishes as written text");

    // Vector custom:strip-controls: typed control characters are stripped from the answer.
    await submitEditorText(terminal, "q2 turn eight", { signal: t.signal });
    await waitForSelector(terminal, "Strip typed controls", { signal: t.signal });
    await chooseOffered(terminal, /Custom answer/u, "custom:strip-controls", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, "safe\u0007answer\u0000", { signal: t.signal });
    await settle("Q2T8 DONE");
    result = singleResult(sessionFile, 7, "custom:strip-controls");
    assert.equal(result.details?.answer, "safeanswer", "custom:strip-controls: control characters never reach the published answer");

    await resizeWarningHistory(600, "Q2T8 DONE");

    // Vector custom:max-bypass: a custom answer cannot exceed the selection maximum.
    await submitEditorText(terminal, "q2 turn nine", { signal: t.signal });
    await waitForSelector(terminal, "Bypass the maximum", { signal: t.signal });
    const bypassRequests = provider.requests.length;
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "custom:max-bypass", { signal: t.signal });
    await waitForSelector(terminal, "Bypass the maximum", { signal: t.signal, entry: mainSelectorEntry });
    await chooseOffered(terminal, /Custom answer/u, "custom:max-bypass", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    const bypassInput = await submitInputDialog(terminal, "Other", { signal: t.signal });
    const maximumNotice = "Error: Select at most 1 answer";
    const previousMaximumNotices = bypassInput.echo.split(maximumNotice).length - 1;
    screens.t9Bypass = await terminal.waitForScreen((screen) =>
      screen.split(maximumNotice).length - 1 > previousMaximumNotices,
    { signal: t.signal, after: bypassInput.after });
    assert.ok(!readChoices(String(screens.t9Bypass)).entries.some((entry) => /Edit custom answer/u.test(entry.text)),
      "custom:max-bypass: the rejected custom answer does not attach");
    assert.match(String(screens.t9Bypass), /1\. \[x\] Alpha/u,
      "custom:max-bypass: rejecting the custom answer preserves the predefined selection");
    assert.equal(readQuestionResults(sessionFile).length, 8,
      "custom:max-bypass: rejecting the custom answer publishes no partial result");
    assert.equal(provider.requests.length, bypassRequests,
      "custom:max-bypass: rejecting the custom answer does not advance the provider");
    await chooseOffered(terminal, /Submit answers/u, "custom:max-bypass", { signal: t.signal });
    await settle("Q2T9 DONE");
    result = singleResult(sessionFile, 8, "custom:max-bypass");
    assert.deepEqual(result.details, { question: "Bypass the maximum", options: ["Alpha", "Beta"], mode: "multiple",
      answers: ["Alpha"], selectedIndices: [1] },
    "custom:max-bypass: only the allowed selection submits with no rejected custom metadata");

    assert.ok(terminal.screen().includes("Q2T1 DONE"), "Custom-maximum warning history remains visible from the first completed turn");
    assert.deepEqual(warningsAfter(terminal.screen(), "Q2T8 DONE"),
      ["Error: Select at most 1 answer"], "Rejected custom answer publishes exactly one maximum warning");

    await resizeWarningHistory(30, "Q2T9 DONE");

    // Vector filter:description-and-zero: description matching, zero matches, cancelled edit, clear, and reuse.
    await submitEditorText(terminal, "q2 turn ten", { signal: t.signal });
    await waitForSelector(terminal, "Description filter", { signal: t.signal });
    const openMoreActions = async (): Promise<void> => {
      assert.ok(terminal);
      await chooseOffered(terminal, /More actions/u, "filter:description-and-zero", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
    };
    const openFilterInput = async (): Promise<void> => {
      await openMoreActions();
      assert.ok(terminal);
      await chooseOffered(terminal, /Filter options/u, "filter:description-and-zero", { signal: t.signal });
      await waitForInputDialog(terminal, "Filter options", { signal: t.signal });
    };
    await openFilterInput();
    await submitInputDialog(terminal, "missing", { signal: t.signal });
    screens.t10Zero = await waitForSelector(terminal, "Description filter", { signal: t.signal, entry: mainSelectorEntry });
    assert.ok(!readChoices(String(screens.t10Zero)).entries.some((entry) => /Alpha|Beta/u.test(entry.text)),
      "filter:description-and-zero: zero matches hide every option row");
    await openFilterInput();
    terminal.write(dialogCancel);
    await waitForSelector(terminal, "Description filter", { signal: t.signal, entry: mainSelectorEntry });
    await openMoreActions();
    await chooseOffered(terminal, /Clear filter/u, "filter:description-and-zero", { signal: t.signal });
    screens.t10Cleared = await waitForSelector(terminal, "Description filter", { signal: t.signal, entry: mainSelectorEntry });
    assert.match(String(screens.t10Cleared), /Second choice/u, "filter:description-and-zero: clearing restores description rows");
    await openFilterInput();
    await submitInputDialog(terminal, "SECOND", { signal: t.signal });
    screens.t10Second = await waitForSelector(terminal, "Description filter", { signal: t.signal, entry: mainSelectorEntry });
    assert.ok(!readChoices(String(screens.t10Second)).entries.some((entry) => entry.text.includes("Alpha")),
      "filter:description-and-zero: SECOND matches only the description row");
    await chooseOffered(terminal, /^1\. Beta · Second choice$/u, "filter:description-and-zero", { signal: t.signal });
    await settle("Q2T10 DONE");
    result = singleResult(sessionFile, 9, "filter:description-and-zero");
    assert.equal(result.details?.selectedIndex, 2, "filter:description-and-zero: the filtered predefined choice keeps its index");

    // Vector filter:oversized: the 4,001-character filter is rejected; 4,000 applies without losing checked options.
    await submitEditorText(terminal, "q2 turn eleven", { signal: t.signal });
    await waitForSelector(terminal, "Oversized filter", { signal: t.signal });
    await chooseOffered(terminal, /1\. \[ \] Alpha/u, "filter:oversized", { signal: t.signal });
    await waitForSelector(terminal, "Oversized filter", { signal: t.signal, entry: mainSelectorEntry });
    await openFilterInput();
    await submitInputDialog(terminal, "𐐀".repeat(4_001), { signal: t.signal });
    screens.t11Rejected = await terminal.waitForScreen(
      (screen) => screen.includes("Error: Question filters are limited to 4,000 characters and 16,000 bytes"), { signal: t.signal });
    assert.match(String(screens.t11Rejected), /\[x\] Alpha/u, "filter:oversized: the rejected filter preserves checked options");
    await openFilterInput();
    await submitInputDialog(terminal, "𐐀".repeat(4_000), { signal: t.signal });
    screens.t11Applied = await waitForSelector(terminal, "Oversized filter", { signal: t.signal, entry: mainSelectorEntry });
    assert.match(String(screens.t11Applied), /Selected 1/u, "filter:oversized: the applied astral filter keeps the hidden selection counted");
    await chooseOffered(terminal, /Submit answers/u, "filter:oversized", { signal: t.signal });
    await settle("Q2T11 DONE");
    result = singleResult(sessionFile, 10, "filter:oversized");
    assert.deepEqual([result.details?.answers, result.details?.selectedIndices],
      [["Alpha"], [1]], "filter:oversized: the hidden checked option submits under the maximum filter");

    await submitEditorText(terminal, "q2 turn twelve", { signal: t.signal });
    await waitForSelector(terminal, "Strip typed ANSI controls", { signal: t.signal });
    await chooseOffered(terminal, /Custom answer/u, "custom:strip-ansi", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, "safe\x1b[2Janswer\u0007", { signal: t.signal });
    await settle("Q2T12 DONE");
    assert.equal(singleResult(sessionFile, 11, "custom:strip-ansi").details?.answer, "safeanswer",
      "custom:strip-ansi: ANSI and BEL are removed from the source's exact custom input");

    assert.equal(provider.requests.length, 24, "the native selection family uses exactly its planned provider requests");
    assert.deepEqual(await terminal.close(), { code: 0, forced: false }, "the native selection family exits naturally");
    terminal = undefined;
    await provider.close();
    t.diagnostic(JSON.stringify({ scenarioId: "Q-02", piLaunches: 1, providerRequests: 24, questionResults: 12 }));
  } catch (error) {
    failures.push(error);
  } finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-02 cleanup: ${JSON.stringify(result)}`));
      } catch (error) { failures.push(error); }
    }
    try { await provider.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Q-02 native question selection scenario failed",
      errors: failures,
      diagnostics: JSON.stringify({ scenarioId: "Q-02", lastScreen: terminal?.screen().trim().slice(-4000), platform: process.platform, node: process.version,
        providerRequests: provider.requests.length, providerFaults: provider.faults, screens,
        sessionResults: sessionFile === "" ? 0 : readQuestionResults(sessionFile).length,
        terminal: terminal?.diagnostics() }, null, 2) });
  }
  await removeDirectoryEventually(family.directory);
});

/** Author exact legacy payloads through public storage, never through live input adapters. */
function makeHistoricalSource(family: Family, label: string, variant: "controls" | "multiple" = "controls") {
  const unsafe = "safe\x1b[2Jspoof\u0007\nnext";
  const source = SessionManager.create(family.project, path.join(family.directory, "source-sessions"));
  const callId = "historical-question-" + label;
  const marker = "QUESTION HISTORICAL " + label;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const args: JsonObject = variant === "multiple"
    ? { question: "Choose all", options: [{ label: "Alpha" }, { label: "Beta" }], mode: "multiple", minSelections: 1, maxSelections: 2 }
    : { question: unsafe, options: [{ label: unsafe, description: unsafe, preview: unsafe }] };
  const details: JsonObject = variant === "multiple"
    ? { question: "Choose all", options: ["Alpha", "Beta", "Gamma", "Delta"], mode: "multiple",
      answers: ["Alpha", "Beta", "Gamma", "Delta"], selectedIndices: [1, 2, 3, 4] }
    : { question: unsafe, options: [unsafe], answer: unsafe, wasCustom: true };
  source.appendModelChange(providerName, modelId);
  source.appendMessage({ role: "user", content: "Historical question " + label, timestamp: 1 });
  source.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "question", arguments: args }],
    api: "openai-completions", provider: providerName, model: modelId, usage, stopReason: "toolUse", timestamp: 2 });
  source.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "question",
    content: [{ type: "text", text: variant === "multiple" ? "User selected multiple answers" : unsafe }],
    details, isError: false, timestamp: 3 });
  source.appendMessage({ role: "assistant", content: [{ type: "text", text: marker }],
    api: "openai-completions", provider: providerName, model: modelId, usage, stopReason: "stop", timestamp: 4 });
  const file = source.getSessionFile();
  assert.ok(file);
  const branch = source.getBranch();
  assert.equal(branch.length, 5);
  assert.equal(source.getTree().length, 1);
  assert.equal(source.getHeader()?.cwd, family.project);
  assert.equal(source.getHeader()?.parentSession, undefined);
  for (const [index, entry] of branch.entries()) assert.equal(entry.parentId, branch[index - 1]?.id ?? null);
  const messages = branch.filter(entry => entry.type === "message").map(entry => entry.message);
  const call = messages.find(message => message.role === "assistant" && message.stopReason === "toolUse");
  const result = messages.find(message => message.role === "toolResult");
  assert.ok(call?.role === "assistant" && result?.role === "toolResult");
  assert.deepEqual(call.content, [{ type: "toolCall", id: callId, name: "question", arguments: args }]);
  assert.equal(result.toolCallId, callId);
  assert.deepEqual(result.details, details);
  return { file, branch, marker, callId, args, details };
}

async function runHistoricalQuestionRendering(t: TestContext) {
  const family = createFamily(repositoryRoot, "render-history");
  const provider = new QuestionProvider();
  const control = path.join(family.directory, "control");
  mkdirSync(control);
  const extension = path.join(family.directory, "historical-observer.ts");
  let terminal: PiTerminalProcess | undefined;
  const failures: unknown[] = [];
  const observations: RecordValue[] = [];
  try {
    await provider.listen();
    writeProviderConfig(family.agent, provider, true);
    const sources = [makeHistoricalSource(family, "A"), makeHistoricalSource(family, "B"),
      makeHistoricalSource(family, "C", "multiple")];
    writeFileSync(extension, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";',
      'const control = ' + JSON.stringify(control) + ';',
      'const files = ' + JSON.stringify(sources.map(source => source.file)) + ';',
      'const write = (name: string, data: unknown) => { const dest = path.join(control, name); fs.writeFileSync(dest + ".tmp", JSON.stringify(data)); fs.renameSync(dest + ".tmp", dest); };',
      'const snapshot = (ctx: ExtensionContext) => ({ file: ctx.sessionManager.getSessionFile(), branch: ctx.sessionManager.getBranch(), idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });',
      'export default function(pi: ExtensionAPI) {',
      '  pi.on("session_start", (_event, ctx) => { write("loaded.json", snapshot(ctx)); });',
      '  pi.registerCommand("fixture-render-source", { description: "Open an owned historical rendering fixture", handler: async (args, ctx) => {',
      '    const index = Number(args.trim() || "1"); const target = files[index];',
      '    if (!Number.isInteger(index) || !target) throw new Error("Unknown historical fixture");',
      '    await ctx.waitForIdle();',
      '    const result = await ctx.switchSession(target, { withSession: async fresh => { write("replacement.json", snapshot(fresh)); } });',
      '    write("switch-result.json", { ...result, file: target });',
      '  }});',
      '}',
    ].join("\n"));
    const first = sources[0];
    const second = sources[1];
    assert.ok(first && second);
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, ...terminalArgs(first.file, "question"), "--extension", extension],
      cwd: family.project, env: family.env, cols: 80, rows: 40 });
    const inspect = async (source: ReturnType<typeof makeHistoricalSource>, name: string): Promise<void> => {
      assert.ok(terminal);
      const assertNoInjectedErase = (): void => {
        assert.ok(terminal);
        const diagnostics = record(JSON.parse(terminal.diagnostics()), "historical terminal");
        const raw = Buffer.from(stringField(diagnostics, "rawBase64", "historical terminal"), "base64").toString("utf8");
        assert.doesNotMatch(raw, /safe(?:(?!spoof)[\s\S])*\x1b\[2J(?:(?!safe)[\s\S])*spoof/u,
          "Historical unsafe payload never emits an erase between safe and spoof");
      };
      await terminal.waitForScreen(screen => screen.includes(source.marker) && screen.includes("❯"), { signal: t.signal });
      const loaded = record(JSON.parse(waitForControlFile(path.join(control, name), text => {
        return record(JSON.parse(text), "native historical observation").file === source.file;
      }, source.marker)), "historical observation");
      assert.equal(loaded.file, source.file);
      assert.equal(loaded.idle, true);
      assert.equal(loaded.pending, false);
      assert.ok(Array.isArray(loaded.branch));
      assert.deepEqual(loaded.branch.slice(0, source.branch.length), source.branch,
        "The native selected branch preserves every original owned entry and raw unsafe payload");
      assertNoInjectedErase();
      assert.equal(terminal.bellCount, 0, "Historical unsafe custom rendering never rings the parsed bell");
      assert.match(terminal.screen(), /\(wrote\)/u, "The actual custom-result branch renders");
      if (rowCountsWith(terminal.screen(), /safespoof/u) < 5) {
        const before = terminal.sequence;
        terminal.write(expandToggle);
        await terminal.waitForScreen(screen => {
          assertNoInjectedErase();
          return rowCountsWith(screen, /safespoof/u) === 5;
        },
          { signal: t.signal, after: before });
      }
      const screen = terminal.screen();
      assert.equal(rowCountsWith(screen, /safespoof/u), 5, "All four call fields and the custom result render sanitized");
      assert.equal(rowCountsWith(screen, /^next$/u), 5, "All original call/result line breaks remain separate rows");
      for (const pattern of [/question safespoof\s*$/u, /\(wrote\) safespoof\s*$/u]) {
        const rows = screen.split("\n");
        const index = rows.findIndex(row => pattern.test(row));
        assert.ok(index >= 0 && rows[index + 1]?.trim() === "next", "Both original expanded renderers preserve the unsafe payload's newline");
      }
      assert.doesNotMatch(screen, /\[2J/u);
      assert.equal(terminal.bellCount, 0, "Expanded historical source fields never emit BEL");
      const diagnostics = record(JSON.parse(terminal.diagnostics()), "historical terminal");
      const raw = Buffer.from(stringField(diagnostics, "rawBase64", "historical terminal"), "base64");
      assert.ok(raw.length < 32_768, "Historical raw output is complete rather than a retained tail");
      assert.equal(raw.includes(Buffer.from("safe\x1b[2Jspoof")), false);
      observations.push({ file: source.file, branch: loaded.branch, screen, bellCount: terminal.bellCount,
        rawBase64: raw.toString("base64"), rawBytes: raw.length });
    };
    await inspect(first, "loaded.json");
    await submitEditorText(terminal, "/fixture-render-source", { signal: t.signal });
    const switched = record(JSON.parse(waitForControlFile(path.join(control, "switch-result.json"), text => {
      const result = record(JSON.parse(text), "native switch result");
      return result.cancelled === false && result.file === second.file;
    }, "source192 switch")), "switch result");
    assert.equal(switched.cancelled, false);
    await inspect(second, "replacement.json");
    assert.ok(!terminal.screen().includes(first.marker), "The committed switch selects the second history only");

    // The imported four-answer result deliberately preserves source 211's two-option 1/2 call.
    const multiple = sources[2];
    assert.ok(multiple);
    await submitEditorText(terminal, "/fixture-render-source 2", { signal: t.signal });
    const multiSwitch = record(JSON.parse(waitForControlFile(path.join(control, "switch-result.json"), text => {
      const result = record(JSON.parse(text), "multiple history switch");
      return result.cancelled === false && result.file === multiple.file;
    }, "multiple history switch")), "multiple switch");
    assert.equal(multiSwitch.file, multiple.file);
    const multiLoaded = record(JSON.parse(waitForControlFile(path.join(control, "replacement.json"), text => {
      return record(JSON.parse(text), "multiple history").file === multiple.file;
    }, "multiple history")), "multiple observation");
    assert.ok(Array.isArray(multiLoaded.branch));
    assert.deepEqual(multiLoaded.branch.slice(0, multiple.branch.length), multiple.branch);
    assert.equal(multiLoaded.idle, true);
    assert.equal(multiLoaded.pending, false);
    await terminal.waitForScreen(screen => screen.includes(multiple.marker), { signal: t.signal });
    let cursor = terminal.sequence;
    terminal.resize(40, 30);
    terminal.write(expandToggle);
    const collapsed40 = await terminal.waitForScreen(screen => /multi-select[\s\S]*choose 1–2/u.test(screen)
      && !/\[ \][^\n]*Alpha/u.test(screen)
      && screen.split("\n").every(line => visibleWidth(line) <= 40), { signal: t.signal, after: cursor });
    cursor = terminal.sequence;
    terminal.write(expandToggle);
    const expanded40 = await terminal.waitForScreen(screen => /\[ \][^\n]*Alpha/u.test(screen)
      && screen.split("\n").every(line => visibleWidth(line) <= 40),
      { signal: t.signal, after: cursor });
    cursor = terminal.sequence;
    terminal.resize(24, 30);
    terminal.write(expandToggle);
    const collapsed24 = await terminal.waitForScreen(screen => screen.includes("Alpha") && screen.includes("+2 more")
      && screen.split("\n").every(line => visibleWidth(line) <= 24),
      { signal: t.signal, after: cursor });
    cursor = terminal.sequence;
    terminal.write(expandToggle);
    const expanded24 = await terminal.waitForScreen(screen => rowCountsWith(screen, /^✓ (Alpha|Beta|Gamma|Delta)/u) === 4
      && screen.split("\n").every(line => visibleWidth(line) <= 24),
      { signal: t.signal, after: cursor });
    for (const answer of ["Alpha", "Beta", "Gamma", "Delta"]) assert.match(expanded24, new RegExp(answer, "u"));
    observations.push({ file: multiple.file, branch: multiLoaded.branch, collapsed40, expanded40, collapsed24, expanded24 });
    assert.deepEqual(await terminal.close(), { code: 0, forced: false });
    terminal = undefined;
    assert.equal(provider.requests.length, 0, "Historical viewing starts no agent turn or provider request");
    for (const source of sources) {
      const reopened = SessionManager.open(source.file);
      assert.equal(reopened.getTree().length, 1);
      assert.deepEqual(reopened.getBranch().slice(0, source.branch.length), source.branch,
        "Loading/navigation never rewrites source parents or raw message payloads");
    }
    await provider.close();
  } catch (error) { failures.push(error); }
  finally {
    if (terminal) {
      try { const result = await terminal.close(); if (result.code !== 0 || result.forced || result.failure) failures.push(new Error("Historical cleanup: " + JSON.stringify(result))); }
      catch (error) { failures.push(error); }
    }
    try { await provider.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throwScenarioFailure({ directory: family.directory, message: "Historical question rendering failed", errors: failures,
    diagnostics: JSON.stringify({ observations, terminal: terminal?.diagnostics(), requests: provider.requests.length }, null, 2) });
  await removeDirectoryEventually(family.directory);
  return { piLaunches: 1, providerRequests: 0, observations };
}

// Catalog ID: Q-03.
test("Question transcript renderers strip controls, bound collapsed rows, and expand completely", { timeout: 300_000 }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "render");
  const control = path.join(family.directory, "control");
  mkdirSync(control);
  const extension = path.join(family.directory, "render-observer.ts");
  writeFileSync(extension, questionControlExtensionSource(control));
  const provider = new QuestionProvider();
  let terminal: PiTerminalProcess | undefined;
  const screens: Record<string, string> = {};
  const failures: unknown[] = [];
  let sessionFile = "";
  const unsafeText = "safe\u001b[2Jspoof\u0007\nnext";
  const oscLabel = "osc\u001b]0;evil-title\u0007label";
  const unsafeDescription = "dsc\u001b[2Jkeep\u0007row";
  const unsafePreview = "pvw\u001b]0;evil-title\u0007row";
  const longQuestion = "Q".repeat(1_000);
  const nineOptions: Option[] = Array.from({ length: 9 }, (_, index) => ({
    label: `Option ${index + 1} ${"L".repeat(180)}`,
    description: `Description ${index + 1}`,
    preview: `# Preview ${index + 1}`,
  }));

  try {
    await provider.listen();
    sessionFile = writeProviderConfig(family.agent, provider, true, 1);
    provider.plan(
      provider.questionCall(unsafeText, [{ label: oscLabel, description: unsafeDescription, preview: unsafePreview }]),
      provider.text("Q3T1 DONE"),
      provider.questionCall("Controls in the answer", [{ label: "Alpha" }]),
      provider.text("Q3T2 DONE"),
      provider.questionCall("Multi overflow rendering", [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }, { label: "Delta" }],
        { mode: "multiple", minSelections: 1, maxSelections: 4 }),
      provider.text("Q3T3 DONE"),
      provider.questionCall(longQuestion, nineOptions),
      provider.text("Q3T4 DONE"),
      provider.questionCall("Long custom rendering", [{ label: "Alpha" }]),
      provider.text("Q3T5 DONE"),
    );
    terminal = new PiTerminalProcess({ file: process.execPath,
      args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
      cwd: family.project, env: family.env, cols: 80, rows: 30 });
    await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
    const bellsBefore = terminal.bellCount;
    const titlesBefore = terminal.titleCount;
    let settlements = 0;
    const settle = async (marker: string): Promise<void> => {
      assert.ok(terminal);
      await terminal.waitForScreen((screen) => screen.includes(marker), { signal: t.signal });
      const expected = ++settlements;
      const content = waitForControlFile(path.join(control, "settled.json"), (text) => {
        const event = record(JSON.parse(text), "render settlement");
        return event.count === expected;
      }, marker);
      assert.deepEqual(record(JSON.parse(content), "render settlement"),
        { count: expected, idle: true, pending: false, aborted: false }, `${marker}: native final settlement`);
    };
    const assertWidthBound = async (width: number, label: string, content: (screen: string) => boolean): Promise<string> => {
      assert.ok(terminal);
      const before = terminal.sequence;
      terminal.resize(width, 30);
      return await terminal.waitForScreen(
        (screen) => content(screen) && screen.split("\n").every((line) => [...line].length <= width),
        { signal: t.signal, after: before });
    };
    // Pi adds one column on each side of tool output and three blank rows between
    // the user message and the renderer. Keep every renderer row, including blanks.
    const collapsedToolRows = async (userMessage: string, end: string, settledMarker: string): Promise<string[]> => {
      assert.ok(terminal);
      const before = terminal.sequence;
      terminal.resize(42, 60);
      const screen = await terminal.waitForScreen((value) => value.split("\n").some(line => line.trim() === userMessage)
        && value.includes(end) && value.includes(settledMarker)
        && value.split("\n").some(line => line === "─".repeat(42))
        && value.split("\n").every(line => visibleWidth(line) <= 42), { signal: t.signal, after: before });
      screens[`collapsed:${userMessage}:42`] = screen;
      const rows = screen.split("\n");
      const start = rows.findIndex(line => line.trim() === userMessage);
      let finish = -1;
      for (let index = start + 1; index < rows.length; index++) {
        if (rows[index]?.includes(end)) finish = index;
      }
      assert.ok(start >= 0 && finish > start, `collapsed transcript boundaries: ${userMessage}`);
      const between = rows.slice(start + 1, finish);
      assert.deepEqual(between.slice(0, 3).map(line => line.trim()), ["", "", ""],
        "Pi's user and tool padding precedes the renderer");
      return between.slice(3);
    };
    const expandUntilVisible = async (needle: RegExp, label: string): Promise<string> => {
      assert.ok(terminal);
      for (let attempt = 0; attempt < 30; attempt++) {
        if (needle.test(terminal.screen())) return terminal.screen();
        const before = terminal.sequence;
        const frame = terminal.screen();
        terminal.write(pageUp);
        try {
          await terminal.waitForScreen((candidate) => candidate !== frame, { signal: t.signal, after: before, timeoutMs: 4_000 });
        } catch {
          // A page-up at the transcript top may not produce a new frame; keep the bounded search going.
        }
      }
      throw new Error(`${label}: ${String(needle)} never became visible while paging the expanded transcript`);
    };

    // Vector controls:stripped: unsafe question text is sanitized in dialog and transcript, with no parsed bells or titles.
    await submitEditorText(terminal, "q3 turn one", { signal: t.signal });
    screens.t1Dialog = await waitForSelector(terminal, "spoof", { signal: t.signal });
    assert.match(screens.t1Dialog, /safespoof next/u, "controls:stripped: the dialog title strips ANSI and BEL and flattens the break");
    assert.match(screens.t1Dialog, /osclabel/u, "controls:stripped: an OSC sequence is removed from the option label");
    await chooseOffered(terminal, /1\. osclabel/u, "controls:stripped", { signal: t.signal });
    await settle("Q3T1 DONE");
    assert.equal(terminal.bellCount, bellsBefore, "controls:stripped: a BEL payload never rings the parsed bell");
    assert.equal(terminal.titleCount, titlesBefore, "controls:stripped: an OSC payload never changes the parsed title");
    // Expanded: the sanitized line break survives as its own transcript row and the option detail renders sanitized.
    const t1ExpandCursor = terminal.sequence;
    terminal.write(expandToggle);
    await terminal.waitForScreen((screen) => screen.includes("dsckeeprow") && screen.includes("pvwrow"),
      { signal: t.signal, after: t1ExpandCursor });
    const t1Expanded = terminal.screen();
    assert.equal(terminal.bellCount, bellsBefore, "controls:stripped: expanded call/result fields never ring");
    assert.equal(terminal.titleCount, titlesBefore, "controls:stripped: expanded previews never change the title");
    const expandedDiagnostics = record(JSON.parse(terminal.diagnostics()), "expanded renderer diagnostics");
    const expandedRaw = Buffer.from(stringField(expandedDiagnostics, "rawBase64", "expanded renderer"), "base64");
    assert.ok(expandedRaw.length < 32_768, "controls:stripped: the first expanded raw capture is complete, not a tail");
    for (const payload of ["safe\u001b[2Jspoof", "dsc\u001b[2Jkeep", "\u001b]0;evil-title\u0007"]) {
      assert.equal(expandedRaw.includes(Buffer.from(payload)), false, "controls:stripped: untrusted controls never reach raw output");
    }
    const expandedControlObservation = { bellDelta: terminal.bellCount - bellsBefore,
      titleDelta: terminal.titleCount - titlesBefore, rawBytes: expandedRaw.length };
    {
      const lines = t1Expanded.split("\n");
      const breakIndex = lines.findIndex((line) => /safespoof\s*$/u.test(line));
      assert.ok(breakIndex >= 0 && /^next$/u.test((lines[breakIndex + 1] ?? "").trim()),
        "controls:stripped: the expanded transcript preserves the line break as a separate row");
    }
    const t1CollapseCursor = terminal.sequence;
    terminal.write(expandToggle);
    await terminal.waitForScreen((screen) => !screen.includes("pvwrow") && !screen.includes("dsckeeprow"),
      { signal: t.signal, after: t1CollapseCursor });

    // Vector controls:answer-stripped: typed control characters are stripped from the published custom answer.
    await submitEditorText(terminal, "q3 turn two", { signal: t.signal });
    await waitForSelector(terminal, "Controls in the answer", { signal: t.signal });
    await chooseOffered(terminal, /Custom answer/u, "controls:answer-stripped", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, "safe\u0007spoof\u0000next", { signal: t.signal });
    await settle("Q3T2 DONE");
    const controlsResult = singleResult(sessionFile, 1, "controls:answer-stripped");
    assert.equal(controlsResult.details?.answer, "safespoofnext", "controls:answer-stripped: controls never reach the published answer");

    // Vectors multi:range and multi:overflow: the range row, the exact overflow count, and every expanded answer.
    await submitEditorText(terminal, "q3 turn three", { signal: t.signal });
    screens.t3Call = await waitForSelector(terminal, "Multi overflow rendering", { signal: t.signal });
    assert.match(screens.t3Call, /choose 1–4/u, "multi:range: the multi-select call shows its exact range");
    for (const label of ["Alpha", "Beta", "Gamma", "Delta"]) {
      await chooseOffered(terminal, new RegExp(`\\[ \\] ${label}`, "u"), "multi:overflow", { signal: t.signal });
      await waitForSelector(terminal, "Multi overflow rendering", { signal: t.signal, entry: mainSelectorEntry });
    }
    await chooseOffered(terminal, /Submit answers/u, "multi:overflow", { signal: t.signal });
    await settle("Q3T3 DONE");
    screens.t3Overflow24 = await assertWidthBound(24, "multi:overflow", (screen) => screen.includes("+2 more"));
    assert.match(screens.t3Overflow24, /Alpha/u, "multi:overflow: the collapsed result keeps the first answer at width 24");
    assert.ok(screens.t3Overflow24.split("\n").some((line) => /\+2 more/u.test(line)),
      "multi:overflow: the collapsed result reports the exact overflow count");
    const t3ExpandCursor = terminal.sequence;
    terminal.resize(80, 30);
    terminal.write(expandToggle);
    screens.t3Expanded = await terminal.waitForScreen((screen) => rowCountsWith(screen, /^✓ (Alpha|Beta|Gamma|Delta)/u) >= 4,
      { signal: t.signal, after: t3ExpandCursor });
    for (const label of ["Alpha", "Beta", "Gamma", "Delta"]) {
      assert.ok(screens.t3Expanded.includes(label), `multi:overflow: the expanded result includes ${label}`);
    }
    const t3CollapseCursor = terminal.sequence;
    terminal.write(expandToggle);
    await terminal.waitForScreen((screen) => rowCountsWith(screen, /^✓ (Alpha|Beta|Gamma|Delta)/u) === 1,
      { signal: t.signal, after: t3CollapseCursor });

    // The original renderer contract bounds collapsed calls and custom answers to three rows, not one.
    await submitEditorText(terminal, "q3 turn four", { signal: t.signal });
    screens.t4Dialog = await waitForSelector(terminal, "QQQQ", { signal: t.signal });
    const collapsedCall = screens.t4Dialog.split(/\n\s*─+\s*\n/u)[0];
    assert.match(collapsedCall ?? "", /question/u, "The call transcript precedes the native selector border");
    assert.ok(!collapsedCall?.includes("Option 9"), "collapsed:big-question: option 9 is not rendered in the collapsed call");
    assert.ok(!collapsedCall?.includes("Description 9"), "collapsed:big-question: descriptions are not rendered in the collapsed call");
    await chooseOffered(terminal, /1\. Option 1/u, "collapsed:big-question", { signal: t.signal });
    await settle("Q3T4 DONE");
    const boundedQuestion = (screen: string) => {
      const rows = screen.split("\n").filter(line => /Q{6,}|^\s*question\s*$/u.test(line));
      return rows.length > 0 && rows.length <= 3 && rows.some(line => line.includes("…"));
    };
    screens.t4Collapsed80 = await terminal.waitForScreen(boundedQuestion, { signal: t.signal });
    assert.ok(boundedQuestion(screens.t4Collapsed80), "collapsed:big-question: the call has at most three rows and a truncation marker");
    const callRows40 = await collapsedToolRows("q3 turn four", "✓ Option 1", "Q3T4 DONE");
    assert.equal(callRows40[0]?.trim(), "question", "collapsed:big-question: the call begins at the renderer boundary");
    assert.match(callRows40[1] ?? "", /^\s*Q{6,}/u, "collapsed:big-question: the long question wraps after the tool name");
    assert.ok(callRows40.length > 0 && callRows40.length <= 3,
      `collapsed:big-question: every call row fits the source's width-40 bound: ${JSON.stringify(callRows40)}`);
    screens.t4Collapsed40 = await assertWidthBound(40, "collapsed:big-question", boundedQuestion);
    screens.t4Collapsed24 = await assertWidthBound(24, "collapsed:big-question", boundedQuestion);
    assert.ok(!screens.t4Collapsed24.includes("Preview 9"), "collapsed:big-question: previews stay hidden collapsed");

    // Vector expanded:nine-options: option 9, description 9, and preview 9 render only when expanded.
    const t4ExpandResizeCursor = terminal.sequence;
    terminal.resize(80, 30);
    terminal.write(expandToggle);
    await terminal.waitForScreen((screen) => screen !== screens.t4Collapsed24, { signal: t.signal, after: t4ExpandResizeCursor });
    screens.t4Expanded = await expandUntilVisible(/Preview 9/u, "expanded:nine-options");
    screens.t4ExpandedOption = await expandUntilVisible(/Option 9/u, "expanded:nine-options");
    assert.ok([screens.t4Expanded, screens.t4ExpandedOption].some(screen => String(screen).includes("Option 9")),
      "expanded:nine-options: the ninth option renders across the expanded transcript pages");
    assert.ok([screens.t4Expanded, screens.t4ExpandedOption].some(screen => String(screen).includes("Description 9")),
      "expanded:nine-options: the ninth description renders across the expanded transcript pages");
    const expanded40Cursor = terminal.sequence;
    terminal.resize(40, 30);
    terminal.write(jumpLatest);
    await terminal.waitForScreen(screen => screen.includes("❯") && !screen.includes("Jump to latest"),
      { signal: t.signal, after: expanded40Cursor });
    screens.t4Preview40 = await expandUntilVisible(/Preview 9/u, "expanded:nine-options-40");
    screens.t4Option40 = await expandUntilVisible(/Option 9/u, "expanded:nine-options-40");
    assert.ok([screens.t4Preview40, screens.t4Option40].some(screen => screen.includes("Description 9")));
    const expandedData40 = Math.max(...[screens.t4Preview40, screens.t4Option40].map(screen => screen.split("\n")
      .filter(line => /Q{6,}|L{6,}|Option 9|Description 9|Preview 9/u.test(line)).join("\n").length));
    const collapsedData40 = screens.t4Collapsed40.split("\n")
      .filter(line => /Q{6,}|^\s*question\s*$/u.test(line)).join("\n");
    assert.ok(expandedData40 > collapsedData40.length, "expanded:nine-options: source width 40 reveals more data than collapsed");
    await assertWidthBound(24, "expanded:nine-options", screen => rowCountsWith(screen, /Q{6,}|L{6,}/u) > 3);
    const t4JumpCursor = terminal.sequence;
    terminal.resize(80, 30);
    terminal.write(jumpLatest);
    await terminal.waitForScreen(screen => screen.includes("❯") && !screen.includes("Jump to latest"), { signal: t.signal, after: t4JumpCursor });
    const t4CollapseCursor = terminal.sequence;
    terminal.write(expandToggle);
    await terminal.waitForScreen((screen) => !screen.includes("Preview 9") && screen.includes("❯"),
      { signal: t.signal, after: t4CollapseCursor });

    // Vector collapsed:long-answer and expanded:long-answer: a 4,000-character custom answer.
    await submitEditorText(terminal, "q3 turn five", { signal: t.signal });
    await waitForSelector(terminal, "Long custom rendering", { signal: t.signal });
    await chooseOffered(terminal, /Custom answer/u, "collapsed:long-answer", { signal: t.signal });
    await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
    await submitInputDialog(terminal, "A".repeat(4_000), { signal: t.signal });
    await settle("Q3T5 DONE");
    const boundedAnswer = (screen: string) => {
      const rows = screen.split("\n").filter(line => /A{6,}|\(wrote\)/u.test(line));
      return rows.length > 0 && rows.length <= 3 && rows.some(line => line.includes("…"));
    };
    screens.t5Collapsed = await terminal.waitForScreen(boundedAnswer, { signal: t.signal });
    assert.ok(boundedAnswer(screens.t5Collapsed), "collapsed:long-answer: the answer has at most three rows and a truncation marker");
    assert.match(screens.t5Collapsed, /\(wrote\)/u, "collapsed:long-answer: the custom marker renders");
    screens.t5Collapsed40 = await assertWidthBound(40, "collapsed:long-answer", boundedAnswer);
    screens.t5Collapsed24 = await assertWidthBound(24, "collapsed:long-answer", boundedAnswer);
    const callAndResultRows40 = await collapsedToolRows("q3 turn five", "Q3T5 DONE", "Q3T5 DONE");
    assert.match(callAndResultRows40[0] ?? "", /question\s+Long custom rendering/u);
    assert.match(callAndResultRows40[1] ?? "", /1 option/u);
    assert.deepEqual(callAndResultRows40.slice(-2).map(line => line.trim()), ["", ""],
      "Pi's tool box and assistant spacing follow the result");
    const resultRows40 = callAndResultRows40.slice(2, -2);
    assert.match(resultRows40[0] ?? "", /✓\s*\(wrote\)/u, "collapsed:long-answer: the result begins at the renderer boundary");
    assert.ok(resultRows40.length > 0 && resultRows40.length <= 3,
      `collapsed:long-answer: every result row fits the source's width-40 bound: ${JSON.stringify(resultRows40)}`);
    t.diagnostic(JSON.stringify({ source: "test/Question.test.ts:227#1", rendererWidth: 40, callRows40, resultRows40 }));
    const t5ExpandCursor = terminal.sequence;
    terminal.resize(80, 30);
    terminal.write(expandToggle);
    await terminal.waitForScreen((screen) => screen.split("\n").some((line) => /^A{40,}$/u.test(line.trim())),
      { signal: t.signal, after: t5ExpandCursor });
    screens.t5Expanded = terminal.screen();
    assert.ok(rowCountsWith(screens.t5Expanded, /A{6,}/u) > 1, "expanded:long-answer: the long answer spans many expanded rows");
    const fullAnswerCursor = terminal.sequence;
    terminal.resize(80, 90);
    const renderedAnswerCharacters = (screen: string): number => screen.split("\n")
      .filter(line => /^(?:✓ \(wrote\) )?A{6,}/u.test(line.trim()))
      .reduce((total, line) => total + (line.match(/A/gu) ?? []).length, 0);
    screens.t5Complete = await terminal.waitForScreen(screen => renderedAnswerCharacters(screen) === 4_000,
      { signal: t.signal, after: fullAnswerCursor });
    assert.equal(renderedAnswerCharacters(screens.t5Complete), 4_000,
      "expanded:long-answer: the terminal renders every character of the expanded answer");
    const complete40Cursor = terminal.sequence;
    terminal.resize(40, 150);
    screens.t5Complete40 = await terminal.waitForScreen(screen => renderedAnswerCharacters(screen) === 4_000
      && screen.split("\n").every(line => visibleWidth(line) <= 40), { signal: t.signal, after: complete40Cursor });
    assert.equal(renderedAnswerCharacters(screens.t5Complete40), 4_000,
      "expanded:long-answer: all 4,000 source characters also render at width 40");
    const longAnswer = singleResult(sessionFile, 4, "expanded:long-answer").details?.answer;
    assert.equal(typeof longAnswer === "string" ? longAnswer.length : 0, 4_000,
      "expanded:long-answer: the durable custom answer is exactly 4,000 characters");
    const multiResult = singleResult(sessionFile, 2, "multi:overflow");
    assert.deepEqual(multiResult.details?.answers, ["Alpha", "Beta", "Gamma", "Delta"],
      "multi:overflow: all four answers persist for the renderer");

    assert.equal(provider.requests.length, 10, "the rendering family uses exactly its planned provider requests");
    const bellDelta = terminal.bellCount - bellsBefore;
    const titleDelta = terminal.titleCount - titlesBefore;
    assert.deepEqual(await terminal.close(), { code: 0, forced: false }, "the rendering family exits naturally");
    terminal = undefined;
    await provider.close();
    t.diagnostic(JSON.stringify({ family: "Q-03-live", piLaunches: 1, providerRequests: 10,
      expandedControlObservation, parsedBellDelta: bellDelta, parsedTitleDelta: titleDelta }));
  } catch (error) {
    failures.push(error);
  } finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-03 cleanup: ${JSON.stringify(result)}`));
      } catch (error) { failures.push(error); }
    }
    try { await provider.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Q-03 question rendering scenario failed",
      errors: failures,
      diagnostics: JSON.stringify({ scenarioId: "Q-03", platform: process.platform, node: process.version,
        providerRequests: provider.requests.length, providerFaults: provider.faults,
        sessionResults: sessionFile === "" ? 0 : readQuestionResults(sessionFile).length,
        terminal: terminal?.diagnostics(), screens }, null, 2) });
  }
  await removeDirectoryEventually(family.directory);
  const historical = await runHistoricalQuestionRendering(t);
  t.diagnostic(JSON.stringify({ scenarioId: "Q-03", piLaunches: 2, providerRequests: 10, historical }));
});

// Catalog ID: Q-04.
test("Question history, preview paging, resize, and draft preservation", { timeout: 180_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const observations: RecordValue[] = [];
  let piLaunches = 0;

  // Family A: reuse and dedup, cancelled sub-steps, preview paging, resize, and the byte bound, in one long session.
  {
    const family = createFamily(repositoryRoot, "history");
    const control = path.join(family.directory, "control");
    mkdirSync(control);
    const extension = path.join(family.directory, "session-observer.ts");
    writeFileSync(extension, questionControlExtensionSource(control));
    const provider = new QuestionProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    let sessionFile = "";
    try {
      await provider.listen();
      sessionFile = writeProviderConfig(family.agent, provider, true);
      provider.plan(
        provider.questionCall("History first", [{ label: "Alpha" }]), provider.text("Q4H1 DONE"),
        provider.questionCall("History second", [{ label: "Alpha" }]), provider.text("Q4H2 DONE"),
        provider.questionCall("History first again", [{ label: "Alpha" }]), provider.text("Q4H3 DONE"),
        provider.questionCall("History reuse", [{ label: "Alpha" }]), provider.text("Q4H4 DONE"),
        provider.questionCall("Saved answer", [{ label: "Alpha" }]), provider.text("Q4H5 DONE"),
        provider.questionCall("Cancelled sub-steps", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple" }), provider.text("Q4H6 DONE"),
        provider.questionCall("Preview paging", [{ label: "Alpha", description: "Description", preview: Array.from({ length: 19 }, (_, index) => `preview-line-${index}`).join("\n") }, { label: "Beta" }], { mode: "multiple" }), provider.text("Q4H7 DONE"),
        provider.questionCall("Resize multi", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple" }), provider.text("Q4H8 DONE"),
        provider.questionCall("Resize draft", [{ label: "Alpha" }]), provider.text("Q4H9 DONE"),
        provider.questionCall("No history after new session", [{ label: "Alpha" }, { label: "Beta" }]), provider.text("Q4H11 DONE"),
      );
      for (let index = 0; index < 6; index++) {
        provider.plan(provider.questionCall(`Byte bound ${index}`, [{ label: "Alpha" }]), provider.text(`Q4B${index} DONE`));
      }
      provider.plan(provider.questionCall("Byte bound reuse", [{ label: "Alpha" }]), provider.text("Q4B6 DONE"));
      provider.plan(provider.questionCall("Option paging", Array.from({ length: 9 }, (_, index) => ({
        label: `Choice ${index + 1} ${"L".repeat(180)}`,
      }))), provider.text("Q4P DONE"));

      terminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
        cwd: family.project, env: family.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
      let settlements = 0;
      const settle = async (marker: string): Promise<void> => {
        assert.ok(terminal);
        await terminal.waitForScreen((screen) => screen.includes(marker), { signal: t.signal });
        const expected = ++settlements;
        const content = waitForControlFile(path.join(control, "settled.json"), (text) =>
          record(JSON.parse(text), "native settlement").count === expected, marker);
        assert.deepEqual(record(JSON.parse(content), "native settlement"),
          { count: expected, idle: true, pending: false, aborted: false }, `${marker}: native final settlement`);
      };
      const customAnswer = async (question: string, value: string, label: string): Promise<void> => {
        assert.ok(terminal);
        await submitEditorText(terminal, label, { signal: t.signal });
        await waitForSelector(terminal, question, { signal: t.signal });
        await chooseOffered(terminal, /Custom answer/u, label, { signal: t.signal });
        await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
        await submitInputDialog(terminal, value, { signal: t.signal });
      };

      // Vectors history:dedup: First, Second, First reuse complete answers without duplicates.
      await customAnswer("History first", "First", "q4 a1");
      await settle("Q4H1 DONE");
      assert.equal(singleResult(sessionFile, 0, "history:first").details?.answer, "First");
      await customAnswer("History second", "Second", "q4 a2");
      await settle("Q4H2 DONE");
      assert.equal(singleResult(sessionFile, 1, "history:second").details?.answer, "Second");
      await customAnswer("History first again", "First", "q4 a3");
      await settle("Q4H3 DONE");
      assert.equal(singleResult(sessionFile, 2, "history:first-again").details?.answer, "First");
      await submitEditorText(terminal, "q4 a4", { signal: t.signal });
      await waitForSelector(terminal, "History reuse", { signal: t.signal });
      await chooseOffered(terminal, /More actions/u, "history:dedup", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Recent answers/u, "history:dedup", { signal: t.signal });
      screens.recentDedup = await waitForSelector(terminal, "Recent answers", { signal: t.signal, dialogTitle: recentAnswersTitle });
      assert.deepEqual(readChoices(String(screens.recentDedup)).entries.map((entry) => entry.text), ["1. First", "2. Second"],
        "history:dedup: recent answers deduplicate First and keep submission order");
      await chooseOffered(terminal, /2\. Second/u, "history:dedup", { signal: t.signal });
      await settle("Q4H4 DONE");
      let result = singleResult(sessionFile, 3, "history:dedup");
      assert.equal(result.details?.answer, "Second", "history:dedup: a reused answer publishes without retyping");

      // Setup for cancelled sub-steps: one more saved custom answer.
      await customAnswer("Saved answer", "Saved", "q4 a5");
      await settle("Q4H5 DONE");
      assert.equal(singleResult(sessionFile, 4, "history:saved").details?.answer, "Saved");

      // Vector history:cancelled-steps: canceled history and review steps preserve the selection.
      await submitEditorText(terminal, "q4 a6", { signal: t.signal });
      await waitForSelector(terminal, "Cancelled sub-steps", { signal: t.signal });
      await chooseOffered(terminal, /1\. \[ \] Alpha/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "Cancelled sub-steps", { signal: t.signal, entry: mainSelectorEntry });
      await chooseOffered(terminal, /More actions/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Recent answers/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "Recent answers", { signal: t.signal, dialogTitle: recentAnswersTitle });
      terminal.write(dialogCancel);
      await waitForSelector(terminal, "Cancelled sub-steps", { signal: t.signal, entry: mainSelectorEntry });
      await chooseOffered(terminal, /More actions/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Review option details/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "Review option details", { signal: t.signal, dialogTitle: reviewChooserTitle });
      terminal.write(dialogCancel);
      await waitForSelector(terminal, "Cancelled sub-steps", { signal: t.signal, entry: mainSelectorEntry });
      await chooseOffered(terminal, /More actions/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Review option details/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, "Review option details", { signal: t.signal, dialogTitle: reviewChooserTitle });
      await chooseOffered(terminal, /1\. Alpha/u, "history:cancelled-steps", { signal: t.signal });
      await waitForSelector(terminal, /Review 1\//u, { signal: t.signal });
      terminal.write(dialogCancel);
      screens.cancelledStepsBack = await waitForSelector(terminal, "Cancelled sub-steps", { signal: t.signal, entry: mainSelectorEntry });
      assert.match(String(screens.cancelledStepsBack), /\[x\] Alpha/u, "history:cancelled-steps: the selection survives cancelled sub-steps");
      await chooseOffered(terminal, /Submit answers/u, "history:cancelled-steps", { signal: t.signal });
      await settle("Q4H6 DONE");
      result = singleResult(sessionFile, 5, "history:cancelled-steps");
      assert.deepEqual(result.details?.answers, ["Alpha"], "history:cancelled-steps: only the surviving selection submits");

      // Vector preview:paging: 23 review lines page next four times and previous once at rows 23.
      const previewResize = terminal.sequence;
      terminal.resize(100, 23);
      await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.trim() === "─".repeat(100)),
        { signal: t.signal, after: previewResize });
      await submitEditorText(terminal, "q4 a7", { signal: t.signal });
      await waitForSelector(terminal, "Preview paging", { signal: t.signal });
      await chooseOffered(terminal, /1\. \[ \] Alpha/u, "preview:paging", { signal: t.signal });
      await waitForSelector(terminal, "Preview paging", { signal: t.signal, entry: mainSelectorEntry });
      await chooseOffered(terminal, /More actions/u, "preview:paging", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Review option details/u, "preview:paging", { signal: t.signal });
      await waitForSelector(terminal, "Review option details", { signal: t.signal, dialogTitle: reviewChooserTitle });
      await chooseOffered(terminal, /1\. Alpha/u, "preview:paging", { signal: t.signal });
      const seenPreviewLines = new Set<string>();
      const capturePreview = (screen: string): void => {
        for (const match of screen.matchAll(/preview-line-\d+/gu)) seenPreviewLines.add(match[0]);
      };
      screens.previewPage1 = await waitForSelector(terminal, /Review 1\/5/u, { signal: t.signal });
      capturePreview(String(screens.previewPage1));
      assert.ok(String(screens.previewPage1).includes("Description"), "preview:paging: the description renders on the first page");
      for (let nextPage = 2; nextPage <= 5; nextPage++) {
        await chooseOffered(terminal, /Next page/u, "preview:paging", { signal: t.signal });
        screens[`previewPage${nextPage}`] = await waitForSelector(terminal, new RegExp(`Review ${nextPage}/5`, "u"), { signal: t.signal });
        capturePreview(String(screens[`previewPage${nextPage}`]));
      }
      await chooseOffered(terminal, /Previous page/u, "preview:paging", { signal: t.signal });
      screens.previewBack = await waitForSelector(terminal, /Review 4\/5/u, { signal: t.signal });
      capturePreview(String(screens.previewBack));
      await chooseOffered(terminal, /Back/u, "preview:paging", { signal: t.signal });
      screens.previewReturn = await waitForSelector(terminal, "Preview paging", { signal: t.signal, entry: mainSelectorEntry });
      assert.match(String(screens.previewReturn), /\[x\] Alpha/u, "preview:paging: selected answers survive review paging");
      await chooseOffered(terminal, /Submit answers/u, "preview:paging", { signal: t.signal });
      await settle("Q4H7 DONE");
      result = singleResult(sessionFile, 6, "preview:paging");
      assert.deepEqual(result.details?.answers, ["Alpha"], "preview:paging: the reviewed selection submits");
      for (let index = 0; index < 19; index++) {
        assert.ok(seenPreviewLines.has(`preview-line-${index}`), `preview:paging: preview-line-${index} was rendered across pages`);
      }
      const restoreResize = terminal.sequence;
      terminal.resize(100, 30);
      await terminal.waitForScreen((screen) => screen.split("\n").some((line) => line.trim() === "─".repeat(100)),
        { signal: t.signal, after: restoreResize });

      // Vector resize:multi-select: a resize rebuilds the step without losing selected answers.
      await submitEditorText(terminal, "q4 a8", { signal: t.signal });
      await waitForSelector(terminal, "Resize multi", { signal: t.signal });
      await chooseOffered(terminal, /1\. \[ \] Alpha/u, "resize:multi-select", { signal: t.signal });
      const multiResizeCursor = terminal.sequence;
      terminal.resize(96, 26);
      screens.multiResized = await waitForSelector(terminal, "Resize multi", { signal: t.signal, after: multiResizeCursor });
      assert.ok(terminal.sequence > multiResizeCursor, "resize:multi-select: the resize dismissed and rebuilt the step");
      assert.match(String(screens.multiResized), /Selected 1/u, "resize:multi-select: the rebuilt step reports the selection count");
      assert.match(String(screens.multiResized), /\[x\] Alpha/u, "resize:multi-select: the selected answer survives the rebuild");
      await chooseOffered(terminal, /Submit answers/u, "resize:multi-select", { signal: t.signal });
      await settle("Q4H8 DONE");
      result = singleResult(sessionFile, 7, "resize:multi-select");
      assert.deepEqual(result.details?.answers, ["Alpha"], "resize:multi-select: the rebuilt step submits the preserved answer");

      // Vector resize:text-draft: a resize during text input preserves the draft.
      await submitEditorText(terminal, "q4 a9", { signal: t.signal });
      await waitForSelector(terminal, "Resize draft", { signal: t.signal });
      await chooseOffered(terminal, /Custom answer/u, "resize:text-draft", { signal: t.signal });
      await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
      const draftCursor = terminal.sequence;
      terminal.write("\x1b[200~Draft after resize\x1b[201~");
      await terminal.waitForScreen((screen) => screen.includes("Draft after resize"), { signal: t.signal, after: draftCursor });
      const draftResizeCursor = terminal.sequence;
      terminal.resize(90, 28);
      screens.draftResized = await terminal.waitForScreen((screen) => screen.includes("Draft after resize") && screen.includes("Custom answer"),
        { signal: t.signal, after: draftResizeCursor });
      assert.ok(readChoices(String(screens.draftResized)).selected === undefined, "resize:text-draft: the input dialog is not dismissed by resize");
      terminal.write(dialogConfirm);
      await settle("Q4H9 DONE");
      result = singleResult(sessionFile, 8, "resize:text-draft");
      assert.equal(result.details?.answer, "Draft after resize", "resize:text-draft: the draft submits intact after resize");

      // Vector history:session-clear: /new clears recent-answer history.
      const previousSessionFile = sessionFile;
      await submitEditorText(terminal, "/new", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("New session started"), { signal: t.signal });
      sessionFile = waitForControlFile(path.join(control, "session-file"),
        content => content !== previousSessionFile && content !== "none" && content.trim().length > 0, "history:session-clear");
      settlements = 0; // Pi reloads extension instances when replacing the session.
      assert.equal(readQuestionResults(previousSessionFile).length, 9, "Session replacement preserves the original nine results");
      await submitEditorText(terminal, "q4 a11", { signal: t.signal });
      await waitForSelector(terminal, "No history after new session", { signal: t.signal });
      await chooseOffered(terminal, /More actions/u, "history:session-clear", { signal: t.signal });
      screens.clearedMore = await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      assert.ok(!readChoices(String(screens.clearedMore)).entries.some((entry) => /Recent answers/u.test(entry.text)),
        "history:session-clear: a new session offers no recent answers");
      terminal.write(dialogCancel);
      await waitForSelector(terminal, "No history after new session", { signal: t.signal, entry: mainSelectorEntry });
      await chooseOffered(terminal, /1\. Alpha/u, "history:session-clear", { signal: t.signal });
      await settle("Q4H11 DONE");
      result = singleResult(sessionFile, 0, "history:session-clear");
      assert.equal(result.details?.answer, "Alpha", "history:session-clear: ordinary selection still answers after the reset");

      // Vector history:byte-bound: six ~16 KB answers evict all but the newest four.
      for (let index = 0; index < 6; index++) {
        await customAnswer(`Byte bound ${index}`, `${index}:` + "𐐀".repeat(3_998), `q4 b${index}`);
        await settle(`Q4B${index} DONE`);
        assert.equal(singleResult(sessionFile, 1 + index, `history:byte-${index}`).details?.answer,
          `${index}:` + "𐐀".repeat(3_998), "Each complete byte-bound answer persists before eviction");
      }
      await submitEditorText(terminal, "q4 b6", { signal: t.signal });
      await waitForSelector(terminal, "Byte bound reuse", { signal: t.signal });
      await chooseOffered(terminal, /More actions/u, "history:byte-bound", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Recent answers/u, "history:byte-bound", { signal: t.signal });
      screens.byteChoices = await waitForSelector(terminal, "Recent answers", { signal: t.signal, dialogTitle: recentAnswersTitle });
      {
        const view = readChoices(String(screens.byteChoices));
        assert.equal(view.entries.length, 4, "history:byte-bound: only the newest four entries survive the byte bound");
        assert.ok(!view.entries.some((entry) => /[01]:/u.test(entry.text)), "history:byte-bound: the two oldest entries were evicted");
      }
      await chooseOffered(terminal, /1\. 5:/u, "history:byte-bound", { signal: t.signal });
      await settle("Q4B6 DONE");
      result = singleResult(sessionFile, 7, "history:byte-bound");
      assert.equal(result.details?.answer, "5:" + "𐐀".repeat(3_998),
        "history:byte-bound: the newest entry under the byte bound is reusable");

      // Vector options:paging: short terminals bound offered rows and preserve the ninth option's identity.
      const pagingResize = terminal.sequence;
      terminal.resize(80, 20);
      await terminal.waitForScreen(screen => screen.split("\n").some(line => line.trim() === "─".repeat(80)),
        { signal: t.signal, after: pagingResize });
      await submitEditorText(terminal, "q4 paging", { signal: t.signal });
      screens.optionPage = await waitForSelector(terminal, "Option paging", { signal: t.signal });
      const firstPage = readChoices(String(screens.optionPage));
      assert.ok(firstPage.dialogTitle.split("\n").length + firstPage.entries.length <= 12,
        "options:paging: the title and offered choices fit the source twelve-row budget");
      assert.ok(firstPage.entries.every(entry => visibleWidth(entry.text) <= 74),
        `options:paging: every offered choice fits the source 74-column budget: ${JSON.stringify(firstPage)}`);
      assert.ok(firstPage.entries.some(entry => entry.text === "Next choices"));
      await chooseOffered(terminal, /^Next choices$/u, "options:paging", { signal: t.signal });
      await waitForSelector(terminal, "Option paging", { signal: t.signal, entry: /9\. Choice 9/u });
      await chooseOffered(terminal, /9\. Choice 9/u, "options:paging", { signal: t.signal });
      await settle("Q4P DONE");
      const ninth = singleResult(sessionFile, 8, "options:paging");
      assert.equal(ninth.details?.selectedIndex, 9);
      assert.equal(ninth.details?.answer, `Choice 9 ${"L".repeat(180)}`,
        "options:paging: clipping the offered label does not truncate the published answer");

      assert.equal(provider.requests.length, 36, "the history family uses exactly its planned provider requests");
      assert.deepEqual(await terminal.close(), { code: 0, forced: false }, "the history family exits naturally");
      terminal = undefined;
      await provider.close();
      assert.equal(readQuestionResults(previousSessionFile).length + readQuestionResults(sessionFile).length, 18);
      observations.push({ family: "history", providerRequests: 36, questionResults: 18 });
    } catch (error) {
      failures.push(error);
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-04 history cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throwScenarioFailure({ directory: family.directory, message: "Q-04 history family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-04", family: "history", providerRequests: provider.requests.length,
          providerFaults: provider.faults, terminal: terminal?.diagnostics(), screens }, null, 2) });
    }
    await removeDirectoryEventually(family.directory);
  }

  t.diagnostic(JSON.stringify({ scenarioId: "Q-04", piLaunches, observations }));
});

// Independent of Q-04's history/reset workflow: one session must retain all 101 submissions.
test("Question history retains the newest hundred distinct answers", { timeout: 180_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const observations: RecordValue[] = [];
  let piLaunches = 0;

  // The 100-entry bound — 101 distinct answers, then paged lookup of the oldest survivor.
  {
    const family = createFamily(repositoryRoot, "hundred");
    const control = path.join(family.directory, "control");
    mkdirSync(control);
    const extension = path.join(family.directory, "session-observer.ts");
    writeFileSync(extension, questionControlExtensionSource(control));
    const provider = new QuestionProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    let sessionFile = "";
    try {
      await provider.listen();
      sessionFile = writeProviderConfig(family.agent, provider, true);
      for (let index = 0; index <= 100; index++) {
        provider.plan(provider.questionCall(`HQ-${index} pick`, [{ label: `Choice ${index}` }]), provider.text(`H${index} DONE`));
      }
      provider.plan(provider.questionCall("Hundred lookup", [{ label: "Alpha" }]), provider.text("HLAST DONE"));

      terminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
        cwd: family.project, env: family.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
      let settlements = 0;
      const settle = async (marker: string): Promise<void> => {
        assert.ok(terminal);
        await terminal.waitForScreen((screen) => screen.includes(marker), { signal: t.signal });
        const expected = ++settlements;
        const content = waitForControlFile(path.join(control, "settled.json"), (text) =>
          record(JSON.parse(text), "native settlement").count === expected, marker);
        assert.deepEqual(record(JSON.parse(content), "native settlement"),
          { count: expected, idle: true, pending: false, aborted: false }, `${marker}: native final settlement`);
      };
      for (let index = 0; index <= 100; index++) {
        await submitEditorText(terminal, `h${index}`, { signal: t.signal });
        await waitForSelector(terminal, `HQ-${index} pick`, { signal: t.signal });
        await chooseOffered(terminal, /Custom answer/u, `hundred:${index}`, { signal: t.signal });
        await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
        await submitInputDialog(terminal, `answer-${index}`, { signal: t.signal });
        await settle(`H${index} DONE`);
        assert.equal(singleResult(sessionFile, index, `hundred:${index}`).details?.answer, `answer-${index}`);
      }

      // Vector history:entry-bound: only the newest 100 distinct answers remain.
      await submitEditorText(terminal, "hlookup", { signal: t.signal });
      await waitForSelector(terminal, "Hundred lookup", { signal: t.signal });
      await chooseOffered(terminal, /More actions/u, "history:entry-bound", { signal: t.signal });
      await waitForSelector(terminal, "More actions", { signal: t.signal, dialogTitle: moreActionsTitle });
      await chooseOffered(terminal, /Recent answers/u, "history:entry-bound", { signal: t.signal });
      screens.firstPage = await waitForSelector(terminal, "Recent answers", { signal: t.signal, dialogTitle: recentAnswersTitle });
      assert.match(readChoices(String(screens.firstPage)).entries[0]?.text ?? "", /answer-100/u,
        "history:entry-bound: the newest answer leads the history");
      const seenAnswers = new Set<string>();
      const captureAnswers = (screen: string): void => {
        for (const match of screen.matchAll(/answer-\d+/gu)) seenAnswers.add(match[0]);
      };
      captureAnswers(String(screens.firstPage));
      let pages = 1;
      for (; pages <= 30; pages++) {
        assert.ok(terminal);
        if (!readChoices(terminal.screen()).entries.some((entry) => entry.text === "Next choices")) break;
        await chooseOffered(terminal, /Next choices/u, "history:entry-bound", { signal: t.signal });
        const page = await waitForSelector(terminal, "Recent answers", { signal: t.signal, dialogTitle: recentAnswersTitle });
        captureAnswers(page);
      }
      assert.ok(terminal && !readChoices(terminal.screen()).entries.some((entry) => entry.text === "Next choices"),
        "history:entry-bound: paging reaches the final page");
      assert.ok(seenAnswers.has("answer-1"), "history:entry-bound: the 100th distinct answer is reachable through paging");
      assert.ok(!seenAnswers.has("answer-0"), "history:entry-bound: the 101st distinct answer was evicted");
      assert.deepEqual([...seenAnswers].sort(), Array.from({ length: 100 }, (_, index) => `answer-${index + 1}`).sort(),
        "history:entry-bound: every one of the newest hundred distinct answers remains reachable");
      await chooseOffered(terminal, /answer-1$/u, "history:entry-bound", { signal: t.signal });
      await settle("HLAST DONE");
      const result = singleResult(sessionFile, 101, "history:entry-bound");
      assert.equal(result.details?.answer, "answer-1", "history:entry-bound: the oldest surviving answer is reusable");

      assert.equal(provider.requests.length, 204, "the hundred family uses exactly its planned provider requests");
      assert.deepEqual(await terminal.close(), { code: 0, forced: false }, "the hundred family exits naturally");
      terminal = undefined;
      await provider.close();
      observations.push({ family: "hundred", providerRequests: 204, questionResults: 102, historyPages: pages });
    } catch (error) {
      failures.push(error);
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-04 hundred cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throwScenarioFailure({ directory: family.directory, message: "Q-04 hundred family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-04", family: "hundred", providerRequests: provider.requests.length,
          providerFaults: provider.faults, terminal: terminal?.diagnostics(), screens }, null, 2) });
    }
    await removeDirectoryEventually(family.directory);
  }

  t.diagnostic(JSON.stringify({ scenarioId: "Q-04-entry-bound", piLaunches, observations }));
});

/** Fixture extension source: public marker input, armed behaviors, and session observation for Q-05. */
function questionControlExtensionSource(controlDirectory: string): string {
  return `import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const control = ${JSON.stringify(controlDirectory)};
const write = (name: string, data: string): void => { fs.writeFileSync(path.join(control, name), data); };

export default function (pi: ExtensionAPI) {
  let commandContext: ExtensionCommandContext | undefined;
  let questionDepth = 0;
  let abortOnConfirm = "";
  let navigateTargetId: string | undefined;
  let settlements = 0;
  pi.on("agent_settled", (event, ctx) => {
    const destination = path.join(control, "settled.json");
    const temporary = destination + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify({ count: ++settlements, idle: ctx.isIdle(),
      pending: ctx.hasPendingMessages(), aborted: event.aborted }));
    fs.renameSync(temporary, destination);
  });
  pi.on("session_start", (_event, ctx) => {
    write("session-file", ctx.sessionManager.getSessionFile() ?? "none");
    ctx.ui.onTerminalInput((data) => {
      if (questionDepth > 0 && abortOnConfirm && matchesKey(data, "enter")) {
        const mode = abortOnConfirm;
        abortOnConfirm = "";
        const abort = () => {
          write("race-fired", "yes");
          ctx.abort();
        };
        if (mode === "between") queueMicrotask(abort);
        else queueMicrotask(() => queueMicrotask(() => queueMicrotask(abort)));
        return undefined;
      }
      if (matchesKey(data, "f12")) { write("abort-marker", "yes"); ctx.abort(); return { consume: true }; }
      if (matchesKey(data, "f11")) {
        write("new-requested", "yes");
        void commandContext?.newSession().then(
          (result) => write("new-result", JSON.stringify(result)),
          (error: unknown) => write("new-refused", String((error as Error | undefined)?.message ?? error)),
        );
        return { consume: true };
      }
      if (matchesKey(data, "f10")) {
        write("nav-requested", "yes");
        void commandContext?.navigateTree(navigateTargetId ?? "fixture-unused").then(
          (result) => write("nav-result", JSON.stringify(result)),
          (error: unknown) => write("nav-refused", String((error as Error | undefined)?.message ?? error)),
        );
        return { consume: true };
      }
      if (matchesKey(data, "f9")) { write("shutdown-requested", "yes"); ctx.shutdown(); return { consume: true }; }
      return undefined;
    });
  });
  pi.on("session_shutdown", () => { write("session-shutdown-seen", "yes"); });
  pi.on("tool_execution_start", (event) => { if (String((event as { toolName?: unknown }).toolName) === "question") questionDepth += 1; });
  pi.on("tool_execution_end", (event) => { if (String((event as { toolName?: unknown }).toolName) === "question") questionDepth -= 1; });
  pi.registerCommand("fixture-arm", {
    description: "Arm the question control fixture",
    handler: async (args, ctx) => {
      commandContext = ctx;
      const mode = String(args ?? "").trim();
      abortOnConfirm = mode === "race" || mode === "between" ? mode : "";
      if (mode.startsWith("nav")) {
        const entries = ctx.sessionManager.getEntries() as Array<{ id: string; type: string; message?: { role?: string } }>;
        const target = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
        navigateTargetId = target?.id;
        write("nav-target", navigateTargetId ?? "none");
      }
      write("armed", mode);
      ctx.ui.notify(\`fixture armed: \${mode}\`);
    },
  });
}
`;
}

// Catalog ID: Q-05.
test("Question cancellation and invalidation never publish a late answer", { timeout: 420_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const observations: RecordValue[] = [];
  let piLaunches = 0;

  // Family A: Esc cancellation, public aborts at both dialog steps, the late-answer race, and the kill barrier.
  {
    const family = createFamily(repositoryRoot, "cancel");
    const control = path.join(family.directory, "control");
    mkdirSync(control);
    const extension = path.join(family.directory, "question-control.ts");
    writeFileSync(extension, questionControlExtensionSource(control));
    const provider = new QuestionProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    let sessionFile = "";
    try {
      await provider.listen();
      sessionFile = writeProviderConfig(family.agent, provider, true);
      provider.plan(
        provider.questionCall("Esc selector question", [{ label: "Alpha" }, { label: "Beta" }], { mode: "multiple" }),
        provider.text("Q5A1 DONE"),
        provider.questionCall("Esc input question", [{ label: "Alpha" }, { label: "Beta" }]),
        provider.text("Q5A2 DONE"),
        provider.questionCall("Abort selector question", [{ label: "Alpha" }], { mode: "multiple" }),
        provider.questionCall("Abort input question", [{ label: "Alpha" }], { mode: "multiple" }),
        provider.questionCall("Race question", [{ label: "Race option" }]),
        provider.questionCall("Between steps question", [{ label: "Race option" }], { mode: "multiple" }),
        provider.questionCall("Kill question", [{ label: "Kill option" }]),
      );
      terminal = new PiTerminalProcess({ file: process.execPath,
        args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
        cwd: family.project, env: family.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
      waitForControlFile(path.join(control, "session-file"), (content) => content.trim().length > 0, "startup session file");

      // Vector cancel:esc-selector: Escape discards the pending multi-select answer.
      await submitEditorText(terminal, "q5 a1", { signal: t.signal });
      await waitForSelector(terminal, "Esc selector question", { signal: t.signal });
      await chooseOffered(terminal, /1\. \[ \] Alpha/u, "cancel:esc-selector", { signal: t.signal });
      await waitForSelector(terminal, "Esc selector question", { signal: t.signal, entry: mainSelectorEntry });
      terminal.write(dialogCancel);
      await terminal.waitForScreen((screen) => screen.includes("Q5A1 DONE"), { signal: t.signal });
      let result = singleResult(sessionFile, 0, "cancel:esc-selector");
      assert.deepEqual([result.details?.cancelled, result.details?.answers], [true, []],
        "cancel:esc-selector: Escape at the selector discards pending answers");

      // Vector cancel:esc-input: Escape at the custom input returns to the selector without an answer.
      await submitEditorText(terminal, "q5 a2", { signal: t.signal });
      await waitForSelector(terminal, "Esc input question", { signal: t.signal });
      await chooseOffered(terminal, /Custom answer/u, "cancel:esc-input", { signal: t.signal });
      await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
      terminal.write(dialogCancel);
      await waitForSelector(terminal, "Esc input question", { signal: t.signal, entry: mainSelectorEntry });
      await chooseOffered(terminal, /2\. Beta/u, "cancel:esc-input", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("Q5A2 DONE"), { signal: t.signal });
      result = singleResult(sessionFile, 1, "cancel:esc-input");
      assert.deepEqual([result.details?.answer, result.details?.wasCustom], ["Beta", false],
        "cancel:esc-input: a cancelled custom input publishes no custom answer");

      // Vector abort:selector: a public abort while the selector is visibly open rejects without an answer.
      let requestsBefore = provider.requests.length;
      await submitEditorText(terminal, "q5 a3", { signal: t.signal });
      screens.abortSelectorOpen = await waitForSelector(terminal, "Abort selector question", { signal: t.signal });
      const abortSelectorCursor = terminal.sequence;
      terminal.write(fixtureAbort);
      screens.abortSelectorClosed = await terminal.waitForScreen(
        (screen) => readChoices(screen).selected === undefined && nativeAbortNotice.test(screen), { signal: t.signal, after: abortSelectorCursor });
      assert.ok(!String(screens.abortSelectorClosed).includes("User selected: Alpha"),
        "abort:selector: the late answer is never published");
      assert.equal(provider.requests.length, requestsBefore + 1,
        "abort:selector: the aborted turn makes no follow-up provider request");
      waitForResultCount(sessionFile, 3, "abort:selector");
      result = singleResult(sessionFile, 2, "abort:selector");
      assert.match(result.content, abortedMessage, "abort:selector: the rejection is the abort message");
      assert.equal(result.isError, true, "abort:selector: the abort result is an error");

      // Vector abort:input: the same public abort with the custom input dialog visibly open.
      requestsBefore = provider.requests.length;
      await submitEditorText(terminal, "q5 a4", { signal: t.signal });
      await waitForSelector(terminal, "Abort input question", { signal: t.signal });
      await chooseOffered(terminal, /Custom answer/u, "abort:input", { signal: t.signal });
      screens.abortInputOpen = await waitForInputDialog(terminal, "Custom answer", { signal: t.signal });
      const abortInputCursor = terminal.sequence;
      terminal.write(fixtureAbort);
      await terminal.waitForScreen((screen) => readChoices(screen).selected === undefined && nativeAbortNotice.test(screen),
        { signal: t.signal, after: abortInputCursor });
      assert.equal(provider.requests.length, requestsBefore + 1, "abort:input: the aborted turn makes no follow-up provider request");
      waitForResultCount(sessionFile, 4, "abort:input");
      result = singleResult(sessionFile, 3, "abort:input");
      assert.match(result.content, abortedMessage, "abort:input: the input-step abort rejects with the abort message");

      // The source's abort-between-steps callback window still needs a public-boundary equivalence review.

      // Vector race:late-answer: the abort fires as the confirm key arrives; the answer must not publish.
      requestsBefore = provider.requests.length;
      for (const [index, mode, title] of [[0, "race", "Race question"], [1, "between", "Between steps question"]] as const) {
      requestsBefore = provider.requests.length;
      await submitEditorText(terminal, `/fixture-arm ${mode}`, { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes(`fixture armed: ${mode}`), { signal: t.signal });
      await submitEditorText(terminal, "q5 a5", { signal: t.signal });
      await waitForSelector(terminal, title, { signal: t.signal });
      const raceCursor = terminal.sequence;
      terminal.write(dialogConfirm);
      await terminal.waitForScreen((screen) => readChoices(screen).selected === undefined && nativeAbortNotice.test(screen), { signal: t.signal, after: raceCursor });
      waitForControlFile(path.join(control, "race-fired"), (content) => content === "yes", "race:late-answer");
      assert.equal(provider.requests.length, requestsBefore + 1,
        "race:late-answer: no follow-up provider request may consume the late answer");
      waitForResultCount(sessionFile, 5 + index, "race:late-answer");
      result = singleResult(sessionFile, 4 + index, "race:late-answer");
      assert.match(result.content, abortedMessage, "race:late-answer: the confirmed choice is discarded");
      assert.ok(!result.content.includes("Race option"), "race:late-answer: the late answer never reaches the tool result");
      assert.ok(!messageText(provider.requests[provider.requests.length - 1] ?? {}).includes("User selected: Race option"),
        "race:late-answer: the late answer never reaches the provider");
      }

      // Vector shutdown:hard-kill: an open dialog publishes nothing when the process dies.
      await submitEditorText(terminal, "q5 a6", { signal: t.signal });
      screens.killOpen = await waitForSelector(terminal, "Kill question", { signal: t.signal });
      const killedResults = readQuestionResults(sessionFile).length;
      const killClose = await terminal.close({ force: true });
      assert.equal(killClose.forced, true, "The hard-shutdown vector must not send graceful cancellation keys");
      assert.equal(killClose.failure, undefined, "Owned process and native parser cleanup must be confirmed");
      screens.killClose = JSON.stringify(killClose);
      const afterKill = readQuestionResults(sessionFile);
      assert.equal(afterKill.length, killedResults, "shutdown:hard-kill: the pending question publishes no result");
      for (const killed of afterKill) assert.ok(!killed.content.includes("Kill option"),
        "shutdown:hard-kill: no answer for the killed question is published");
      terminal = undefined;
      observations.push({ family: "cancel", providerRequests: provider.requests.length,
        abortedResults: afterKill.filter((entry) => abortedMessage.test(entry.content)).length, killClose: killClose.forced });
      await provider.close();
    } catch (error) {
      failures.push(error);
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-05 cancel cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throwScenarioFailure({ directory: family.directory, message: "Q-05 cancellation family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-05", family: "cancel", providerRequests: provider.requests.length,
          providerFaults: provider.faults, terminal: terminal?.diagnostics(), screens }, null, 2) });
    }
    await removeDirectoryEventually(family.directory);

    // Family A2: a fresh process still publishes questions after the hard shutdown.
    const recoveryFamily = createFamily(repositoryRoot, "recover");
    const recoveryProvider = new QuestionProvider();
    let recoveryTerminal: PiTerminalProcess | undefined;
    try {
      await recoveryProvider.listen();
      const recoverySession = writeProviderConfig(recoveryFamily.agent, recoveryProvider, true);
      recoveryProvider.plan(
        recoveryProvider.questionCall("Recovery question", [{ label: "Recovered" }]),
        recoveryProvider.text("Q5R1 DONE"),
      );
      recoveryTerminal = new PiTerminalProcess({ file: process.execPath, args: [cliPath, ...terminalArgs(recoverySession, "question")],
        cwd: recoveryFamily.project, env: recoveryFamily.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await recoveryTerminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
      await submitEditorText(recoveryTerminal, "q5 r1", { signal: t.signal });
      await waitForSelector(recoveryTerminal, "Recovery question", { signal: t.signal });
      await chooseOffered(recoveryTerminal, /1\. Recovered/u, "shutdown:fresh-question", { signal: t.signal });
      await recoveryTerminal.waitForScreen((screen) => screen.includes("Q5R1 DONE"), { signal: t.signal });
      const recoveryResult = singleResult(recoverySession, 0, "shutdown:fresh-question");
      assert.equal(recoveryResult.details?.answer, "Recovered",
        "shutdown:fresh-question: a fresh question publishes normally after the hard shutdown of a pending one");
      assert.deepEqual(await recoveryTerminal.close(), { code: 0, forced: false }, "the recovery family exits naturally");
      recoveryTerminal = undefined;
      await recoveryProvider.close();
      observations.push({ family: "recover", providerRequests: 2 });
    } catch (error) {
      failures.push(error);
    } finally {
      if (recoveryTerminal) {
        try {
          const result = await recoveryTerminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-05 recovery cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await recoveryProvider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throwScenarioFailure({ directory: recoveryFamily.directory, message: "Q-05 recovery family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-05", family: "recover", providerRequests: recoveryProvider.requests.length,
          providerFaults: recoveryProvider.faults, terminal: recoveryTerminal?.diagnostics() }, null, 2) });
    }
    await removeDirectoryEventually(recoveryFamily.directory);
  }

  // Family B: session replacement during a pending question aborts it and allows a fresh question afterward.
  {
    const family = createFamily(repositoryRoot, "newsession");
    const control = path.join(family.directory, "control");
    mkdirSync(control);
    const extension = path.join(family.directory, "question-control.ts");
    writeFileSync(extension, questionControlExtensionSource(control));
    const provider = new QuestionProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    let sessionFile = "";
    try {
      await provider.listen();
      sessionFile = writeProviderConfig(family.agent, provider, true);
      provider.plan(
        provider.questionCall("Invalidate question", [{ label: "Alpha" }]),
        provider.questionCall("Fresh question", [{ label: "Fresh" }]),
        provider.text("Q5N2 DONE"),
      );
      terminal = new PiTerminalProcess({ file: process.execPath,
        args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
        cwd: family.project, env: family.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });
      const firstSessionFile = waitForControlFile(path.join(control, "session-file"), (content) => content.trim().length > 0, "startup session file");
      assert.equal(firstSessionFile.trim(), sessionFile, "startup: the fixture observes the initial session file");

      // Vector invalidate:session-start: a public new-session request closes the open dialog.
      await submitEditorText(terminal, "/fixture-arm new", { signal: t.signal });
      await terminal.waitForScreen(screen => screen.includes("fixture armed: new"), { signal: t.signal });
      await submitEditorText(terminal, "q5 n1", { signal: t.signal });
      screens.newDialogOpen = await waitForSelector(terminal, "Invalidate question", { signal: t.signal });
      const newCursor = terminal.sequence;
      terminal.write(fixtureNew);
      await terminal.waitForScreen(screen => readChoices(screen).selected === undefined && screen.includes("❯") && !screen.includes("Invalidate question"),
        { signal: t.signal, after: newCursor });
      waitForControlFile(path.join(control, "new-result"), (content) => content.includes("\"cancelled\":false"), "invalidate:session-start");
      const secondSessionFile = waitForControlFile(path.join(control, "session-file"),
        (content) => content.trim().length > 0 && content.trim() !== sessionFile, "invalidate:session-start");
      assert.notEqual(secondSessionFile.trim(), sessionFile, "invalidate:session-start: the runtime replaced the session file");
      waitForResultCount(sessionFile, 1, "invalidate:session-start");
      const invalidated = readQuestionResults(sessionFile);
      assert.equal(invalidated.length, 1, "invalidate:session-start: the aborted turn persists before replacement");
      assert.match(invalidated[0]?.content ?? "", abortedMessage, "invalidate:session-start: the open question rejects with the abort message");

      // A fresh question works in the replacement session.
      await submitEditorText(terminal, "q5 n2", { signal: t.signal });
      await waitForSelector(terminal, "Fresh question", { signal: t.signal });
      await chooseOffered(terminal, /1\. Fresh/u, "invalidate:fresh-question", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("Q5N2 DONE"), { signal: t.signal });
      const freshResults = readQuestionResults(secondSessionFile.trim());
      assert.equal(freshResults.length, 1, "invalidate:fresh-question: the replacement session records the fresh question");
      assert.equal(freshResults[0]?.details?.answer, "Fresh", "invalidate:fresh-question: the fresh answer publishes in the new session");
      assert.equal(provider.requests.length, 3, "the session-replacement family uses exactly its planned provider requests");
      assert.deepEqual(await terminal.close(), { code: 0, forced: false }, "the session-replacement family exits naturally");
      terminal = undefined;
      await provider.close();
      observations.push({ family: "newsession", providerRequests: 3 });
    } catch (error) {
      failures.push(error);
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-05 newsession cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throwScenarioFailure({ directory: family.directory, message: "Q-05 session-replacement family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-05", family: "newsession", providerRequests: provider.requests.length,
          providerFaults: provider.faults, terminal: terminal?.diagnostics(), screens }, null, 2) });
    }
    await removeDirectoryEventually(family.directory);
  }

  // Family C: committed tree navigation refuses while a question is pending, then commits once idle.
  {
    const family = createFamily(repositoryRoot, "tree");
    const control = path.join(family.directory, "control");
    mkdirSync(control);
    const extension = path.join(family.directory, "question-control.ts");
    writeFileSync(extension, questionControlExtensionSource(control));
    const provider = new QuestionProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    let sessionFile = "";
    try {
      await provider.listen();
      sessionFile = writeProviderConfig(family.agent, provider, true);
      provider.plan(
        provider.questionCall("Navigation question", [{ label: "Alpha" }]),
        provider.text("Q5T1 DONE"),
        provider.questionCall("Post navigation question", [{ label: "After" }]),
        provider.text("Q5T2 DONE"),
      );
      terminal = new PiTerminalProcess({ file: process.execPath,
        args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
        cwd: family.project, env: family.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });

      // Vector invalidate:tree-refused: navigation refuses while the question is pending and the dialog survives.
      await submitEditorText(terminal, "/fixture-arm nav-refuse", { signal: t.signal });
      await terminal.waitForScreen(screen => screen.includes("fixture armed: nav-refuse"), { signal: t.signal });
      await submitEditorText(terminal, "q5 t1", { signal: t.signal });
      screens.treeDialogOpen = await waitForSelector(terminal, "Navigation question", { signal: t.signal });
      const refusedCursor = terminal.sequence;
      terminal.write(fixtureNavigate);
      const refusal = waitForControlFile(path.join(control, "nav-refused"),
        (content) => content.includes("finish before navigating"), "invalidate:tree-refused");
      screens.treeDialogAfterRefusal = await waitForSelector(terminal, "Navigation question", { signal: t.signal, after: refusedCursor });
      assert.match(refusal, /Wait for the current response to finish before navigating/u,
        "invalidate:tree-refused: the public navigation refuses during a pending question");
      assert.ok(!abortedMessage.test(String(screens.treeDialogAfterRefusal)),
        "invalidate:tree-refused: the refused navigation does not abort the pending question");
      await chooseOffered(terminal, /1\. Alpha/u, "invalidate:tree-refused", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("Q5T1 DONE"), { signal: t.signal });

      // Vector invalidate:tree-commit: the same navigation commits once idle, through the real session_tree path.
      await submitEditorText(terminal, "/fixture-arm nav-commit", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("fixture armed: nav-commit"), { signal: t.signal });
      const commitCursor = terminal.sequence;
      terminal.write(fixtureNavigate);
      await terminal.waitForScreen((screen) => screen.includes("Navigated to selected point"), { signal: t.signal, after: commitCursor });
      waitForControlFile(path.join(control, "nav-result"), (content) => content.includes("\"cancelled\":false"), "invalidate:tree-commit");

      // A fresh question works after the committed navigation.
      await submitEditorText(terminal, "q5 t2", { signal: t.signal });
      await waitForSelector(terminal, "Post navigation question", { signal: t.signal });
      await chooseOffered(terminal, /1\. After/u, "invalidate:tree-fresh", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("Q5T2 DONE"), { signal: t.signal });
      const treeResults = readQuestionResults(sessionFile);
      assert.equal(treeResults.length, 2, "invalidate:tree-fresh: both the pending and the fresh question publish");
      assert.deepEqual(await terminal.close(), { code: 0, forced: false }, "the tree family exits naturally");
      terminal = undefined;
      await provider.close();
      observations.push({ family: "tree", providerRequests: 4 });
    } catch (error) {
      failures.push(error);
    } finally {
      if (terminal) {
        try {
          const result = await terminal.close();
          if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-05 tree cleanup: ${JSON.stringify(result)}`));
        } catch (error) { failures.push(error); }
      }
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throwScenarioFailure({ directory: family.directory, message: "Q-05 tree family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-05", family: "tree", providerRequests: provider.requests.length,
          providerFaults: provider.faults, terminal: terminal?.diagnostics(), screens }, null, 2) });
    }
    await removeDirectoryEventually(family.directory);
  }

  // Family D: a shutdown request defers while a question is pending, then exits gracefully after settlement.
  {
    const family = createFamily(repositoryRoot, "shutdown");
    const control = path.join(family.directory, "control");
    mkdirSync(control);
    const extension = path.join(family.directory, "question-control.ts");
    writeFileSync(extension, questionControlExtensionSource(control));
    const provider = new QuestionProvider();
    let terminal: PiTerminalProcess | undefined;
    const screens: RecordValue = {};
    let sessionFile = "";
    try {
      await provider.listen();
      sessionFile = writeProviderConfig(family.agent, provider, true);
      provider.plan(
        provider.questionCall("Deferred shutdown question", [{ label: "Settled" }]),
        provider.text("Q5S1 DONE"),
      );
      terminal = new PiTerminalProcess({ file: process.execPath,
        args: [cliPath, ...terminalArgs(sessionFile, "question"), "--extension", extension],
        cwd: family.project, env: family.env, cols: 100, rows: 30 });
      piLaunches += 1;
      await terminal.waitForScreen((screen) => screen.includes("KillerOS") && screen.includes("❯"), { signal: t.signal });

      // Vector shutdown:deferred: the request does not exit mid-question; the dialog stays open and answerable.
      await submitEditorText(terminal, "q5 s1", { signal: t.signal });
      screens.shutdownDialogOpen = await waitForSelector(terminal, "Deferred shutdown question", { signal: t.signal });
      terminal.write(fixtureShutdown);
      waitForControlFile(path.join(control, "shutdown-requested"), (content) => content === "yes", "shutdown:deferred");
      screens.shutdownStillOpen = await terminal.waitForScreen((screen) => screen.includes("Deferred shutdown question")
        && readChoices(screen).selected !== undefined, { signal: t.signal });
      assert.match(String(screens.shutdownStillOpen), /1\. Settled/u,
        "shutdown:deferred: a pending question defers the shutdown request and remains answerable");
      await chooseOffered(terminal, /1\. Settled/u, "shutdown:deferred", { signal: t.signal });
      await terminal.waitForScreen((screen) => screen.includes("Q5S1 DONE"), { signal: t.signal });
      const shutdownResult = singleResult(sessionFile, 0, "shutdown:deferred");
      assert.equal(shutdownResult.details?.answer, "Settled", "shutdown:deferred: the answered question publishes before exit");
      const shutdownClose = await terminal.close();
      screens.shutdownClose = JSON.stringify(shutdownClose);
      assert.deepEqual([shutdownClose.code, shutdownClose.forced], [0, false],
        "shutdown:deferred: the deferred request exits gracefully after settlement");
      terminal = undefined;
      waitForControlFile(path.join(control, "session-shutdown-seen"), (content) => content === "yes", "shutdown:deferred");
      await provider.close();
      observations.push({ family: "shutdown", providerRequests: 2 });
    } catch (error) {
      failures.push(error);
  } finally {
    if (terminal) {
      try {
        const result = await terminal.close();
        if (result.code !== 0 || result.forced || result.failure) failures.push(new Error(`Q-05 shutdown cleanup: ${JSON.stringify(result)}`));
      } catch (error) { failures.push(error); }
    }
    try { await provider.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    throwScenarioFailure({ directory: family.directory, message: "Q-05 shutdown family failed",
        errors: failures,
        diagnostics: JSON.stringify({ scenarioId: "Q-05", family: "shutdown", providerRequests: provider.requests.length,
          providerFaults: provider.faults, terminal: terminal?.diagnostics(), screens }, null, 2) });
    }
    await removeDirectoryEventually(family.directory);
  }

  t.diagnostic(JSON.stringify({ scenarioId: "Q-05", piLaunches, observations,
    obligationReviews: {
      "abort:between-steps": "Forwarding the native multiple-selector confirmation and aborting in the first queued microtask rejects before another dialog or partial answer can publish.",
      "race:late-answer": "The public terminal-input listener forwards Enter, then aborts after three nested microtasks, preserving the original late-resolution race without replacing the native selector.",
      "invalidate:session-tree-during-pending": "Committed navigation refuses while a question run is active (public navigateTree guard); the real refusal path is asserted and the same navigation commits once idle.",
    } }));
});
