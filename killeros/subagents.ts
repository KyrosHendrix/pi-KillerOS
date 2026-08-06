import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSupportedThinkingLevels, StringEnum, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  getMarkdownTheme,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SubagentThreadRegistry, type SubagentThread, type SubagentThreadId, type SubagentThreadState } from "./subagent-lifecycle.ts";
import { MAX_NODE_TIMER_MS, runSubagentProcess, type SubagentProcessHandle, type SubagentProcessResult } from "./subagent-process.ts";
import { formatThreadBoard, formatThreadInspection, type ThreadRecord as ThreadBoardRecord } from "./subagent-ui.ts";

export const SUBAGENT_LIMITS = {
  maxTasks: 10,
  maxReadConcurrency: 4,
  toolOutputBytes: 50 * 1024,
  traceRetentionBytes: 8 * 1024 * 1024,
  stderrRetentionBytes: 1 * 1024 * 1024,
  taskOutputRetentionBytes: 1 * 1024 * 1024,
  threadRetentionRecords: 64,
  threadRetentionBytes: 128 * 1024 * 1024,
  roleFileBytes: 64 * 1024,
  taskCharacters: 20_000,
  killGraceMs: 5_000,
  defaultMaxTurns: 64,
  defaultQuotaTokens: 2_000_000,
  defaultWallTimeMs: 1_800_000,
  processExitWaitMs: 10_000,
} as const;

const WEB_TOOLS = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls", ...WEB_TOOLS]);
const WRITE_TOOLS = new Set(["bash", "edit", "write"]);
const KNOWN_TOOLS = new Set([...READ_TOOLS, ...WRITE_TOOLS]);
const SUBAGENT_WEB_EXTENSION = "npm:pi-web-access";
const INHERIT_SETTING = "inherit";
const MAX_RUNTIME_STEERING_MESSAGES = 20;
const ROLE_FIELDS = new Set(["name", "description", "access", "tools", "model", "thinking", "timeoutMs"]);

type ThinkingLevel = ModelThinkingLevel;
export type AgentAccess = "read" | "write";
export type AgentSource = "bundled" | "personal" | "project" | "inline";
export type AgentScope = "user" | "project" | "both";
export type SubagentStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "limited" | "orphaned";

export interface AgentRole {
  name: string;
  description: string;
  access: AgentAccess;
  tools: string[];
  model?: string;
  thinking?: string;
  timeoutMs?: number;
  prompt: string;
  source: AgentSource;
  filePath: string;
}

export interface InlineAgentRole {
  name: string;
  description: string;
  access: AgentAccess;
  tools: string[];
}

export type AgentSpec = string | InlineAgentRole;

export interface AgentDiscoveryResult {
  agents: AgentRole[];
  projectAgentsDir: string | null;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  turns: number;
}

export interface SubagentTaskResult {
  id: string;
  name?: string;
  attempt: number;
  agent: string;
  agentSource: AgentSource | "unknown";
  sourcePath?: string;
  task: string;
  access?: AgentAccess;
  status: SubagentStatus;
  model?: string;
  thinking?: ThinkingLevel;
  tools: string[];
  trace: string[];
  traceBytes: number;
  traceTruncatedBytes: number;
  stderr: string;
  stderrBytes: number;
  stderrTruncatedBytes: number;
  output: string;
  outputBytes: number;
  outputTruncatedBytes: number;
  toolCallCount: number;
  usage: SubagentUsage;
  durationMs: number;
  exitCode: number | null;
  exitConfirmed: boolean;
  terminationReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  executionNote?: string;
  results: SubagentTaskResult[];
  aggregateUsage: SubagentUsage;
  parentId?: string;
  threads?: SubagentThread[];
  activeThreads?: SubagentThread[];
  doneThreads?: SubagentThread[];
  selectedThreadId?: string;
  wait?: SubagentWaitSummary;
  backgroundStarted?: boolean;
}

export interface SubagentWaitSummary {
  targetThreadIds: string[];
  completedThreadIds: string[];
  pendingThreadIds: string[];
  timedOut: boolean;
  waitedMs: number;
}

export interface SubagentControlRequest {
  action: "list" | "inspect" | "wait" | "steer" | "interrupt" | "collect" | "resume" | "close";
  threadId?: string;
  all?: true;
  message?: string;
  task?: string;
  timeoutMs?: number;
}

export interface SubagentControlResult {
  text: string;
  details: SubagentDetails;
  usage: SubagentUsage;
}

export interface SubagentControlApi {
  execute(request: SubagentControlRequest, ctx: ExtensionContext): Promise<SubagentControlResult>;
}

export const SUBAGENT_PERSISTENCE_TYPE = "killeros-subagent-v1";

interface ModelContext {
  model?: Model<any>;
  thinkingLevel?: ThinkingLevel;
  modelRegistry: {
    getAvailable(): Model<any>[];
  };
}

interface ResolvedModel {
  model: string;
  thinking: ThinkingLevel;
  definition: Model<any>;
}

interface SpawnedProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
}

type SubagentLimits = { [Key in keyof typeof SUBAGENT_LIMITS]: number } & {
  wallTimeMs?: number;
  maxTurns?: number;
  jsonlLineBytes?: number;
  traceBytes?: number;
  stderrBytes?: number;
  taskOutputBytes?: number;
  quotaTokens?: number;
  quotaUsd?: number;
};

export interface SubagentRuntimeOptions {
  /** Explicit test or embedding role directory; KillerOS ships no bundled roles. */
  bundledAgentsDir?: string;
  userAgentsDir?: string;
  webExtension?: string;
  spawnProcess?: (args: string[], cwd: string, environment?: NodeJS.ProcessEnv) => SpawnedProcess;
  limits?: Partial<SubagentLimits>;
  /** Test and embedding compatibility mode; production spawns return immediately. */
  awaitSpawnCompletion?: boolean;
}

class AgentConfigurationError extends Error {
  constructor(filePath: string, field: string, message: string) {
    super(`${filePath} [${field}]: ${message}`);
    this.name = "AgentConfigurationError";
  }
}

function emptyUsage(): SubagentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    turns: 0,
  };
}

function addUsage(target: SubagentUsage, source: Partial<SubagentUsage> | undefined): void {
  if (!source) return;
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  target.cost.input += source.cost?.input ?? 0;
  target.cost.output += source.cost?.output ?? 0;
  target.cost.cacheRead += source.cost?.cacheRead ?? 0;
  target.cost.cacheWrite += source.cost?.cacheWrite ?? 0;
  target.cost.total += source.cost?.total ?? 0;
  target.turns += source.turns ?? 0;
}

function aggregateUsage(results: SubagentTaskResult[]): SubagentUsage {
  const total = emptyUsage();
  for (const result of results) addUsage(total, result.usage);
  return total;
}

function boundedText(text: string, maxBytes: number, marker: string): string {
  const capped = truncateUtf8(text, maxBytes);
  if (!capped.omittedBytes) return text;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return truncateUtf8(text, maxBytes).text;
  return `${truncateUtf8(text, maxBytes - markerBytes).text}${marker}`;
}

function readBoundedFile(filePath: string, maxBytes: number): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new AgentConfigurationError(filePath, "file", `exceeds ${maxBytes} bytes`);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function requiredString(frontmatter: Record<string, unknown>, filePath: string, field: string): string {
  const value = frontmatter[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new AgentConfigurationError(filePath, field, "must be a non-empty string");
  }
  return value.trim();
}

function optionalPositiveInteger(
  frontmatter: Record<string, unknown>,
  filePath: string,
  field: string,
  fallback?: number,
  maximum?: number,
): number | undefined {
  const value = frontmatter[field];
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || maximum !== undefined && parsed > maximum) {
    const bound = maximum === undefined ? "" : " no greater than " + maximum;
    throw new AgentConfigurationError(filePath, field, `must be a positive integer${bound}`);
  }
  return parsed;
}

function parseAgentFile(filePath: string, source: AgentSource, limits: SubagentLimits): AgentRole {
  const content = readBoundedFile(filePath, limits.roleFileBytes);
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (error) {
    throw new AgentConfigurationError(filePath, "frontmatter", error instanceof Error ? error.message : String(error));
  }
  const frontmatter = parsed.frontmatter;
  for (const field of Object.keys(frontmatter)) {
    if (!ROLE_FIELDS.has(field)) throw new AgentConfigurationError(filePath, field, "unknown role field");
  }

  const name = requiredString(frontmatter, filePath, "name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name)) {
    throw new AgentConfigurationError(filePath, "name", "must use 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  const description = requiredString(frontmatter, filePath, "description");
  if (description.length > 500) throw new AgentConfigurationError(filePath, "description", "must not exceed 500 characters");

  const accessValue = requiredString(frontmatter, filePath, "access");
  if (accessValue !== "read" && accessValue !== "write") {
    throw new AgentConfigurationError(filePath, "access", 'must be "read" or "write"');
  }
  const toolsValue = requiredString(frontmatter, filePath, "tools");
  const tools = [...new Set(toolsValue.split(",").map((tool) => tool.trim()).filter(Boolean))];
  if (tools.length === 0) throw new AgentConfigurationError(filePath, "tools", "must contain at least one tool");
  for (const tool of tools) {
    if (!KNOWN_TOOLS.has(tool)) throw new AgentConfigurationError(filePath, "tools", `unknown child tool ${JSON.stringify(tool)}`);
    if (accessValue === "read" && WRITE_TOOLS.has(tool)) {
      throw new AgentConfigurationError(filePath, "tools", `read-only roles cannot use ${tool}`);
    }
  }

  const prompt = parsed.body.trim();
  if (!prompt) throw new AgentConfigurationError(filePath, "prompt", "Markdown body must be non-empty");
  const modelValue = frontmatter.model;
  if (modelValue !== undefined && (typeof modelValue !== "string" || !modelValue.trim())) {
    throw new AgentConfigurationError(filePath, "model", "must be a non-empty string when provided");
  }
  const thinkingValue = frontmatter.thinking;
  if (thinkingValue !== undefined && (typeof thinkingValue !== "string" || !thinkingValue.trim())) {
    throw new AgentConfigurationError(filePath, "thinking", "must be a non-empty string when provided");
  }

  return {
    name,
    description,
    access: accessValue,
    tools,
    model: typeof modelValue === "string" ? modelValue.trim() : undefined,
    thinking: typeof thinkingValue === "string" ? thinkingValue.trim() : undefined,
    timeoutMs: optionalPositiveInteger(frontmatter, filePath, "timeoutMs", undefined, MAX_NODE_TIMER_MS),
    prompt,
    source,
    filePath,
  };
}

function loadAgentDirectory(dir: string, source: AgentSource, limits: SubagentLimits): AgentRole[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read ${source} agent directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const agents: AgentRole[] = [];
  const names = new Set<string>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const agent = parseAgentFile(path.join(dir, entry.name), source, limits);
    if (names.has(agent.name)) throw new AgentConfigurationError(agent.filePath, "name", `duplicate ${source} role ${JSON.stringify(agent.name)}`);
    names.add(agent.name);
    agents.push(agent);
  }
  return agents;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function findProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgentRoles(
  cwd: string,
  scope: AgentScope,
  projectTrusted: boolean,
  options: Pick<SubagentRuntimeOptions, "bundledAgentsDir" | "userAgentsDir" | "limits"> = {},
): AgentDiscoveryResult {
  const limits = { ...SUBAGENT_LIMITS, ...options.limits };
  const bundledDir = options.bundledAgentsDir;
  const userDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
  const wantsProject = scope === "project" || scope === "both";
  if (wantsProject && !projectTrusted) throw new Error("Project agents require a trusted project");
  const projectAgentsDir = wantsProject ? findProjectAgentsDir(cwd) : null;

  const layers: Array<{ dir: string; source: AgentSource }> = [];
  if (bundledDir) layers.push({ dir: bundledDir, source: "bundled" });
  if (scope === "user" || scope === "both") layers.push({ dir: userDir, source: "personal" });
  if (wantsProject && projectAgentsDir) layers.push({ dir: projectAgentsDir, source: "project" });

  const byName = new Map<string, AgentRole>();
  for (const layer of layers) {
    for (const agent of loadAgentDirectory(layer.dir, layer.source, limits)) byName.set(agent.name, agent);
  }
  return {
    agents: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    projectAgentsDir,
  };
}

function matchingModels(value: string, available: Model<any>[]): Model<any>[] {
  const slash = value.indexOf("/");
  if (slash >= 1 && slash < value.length - 1) {
    const provider = value.slice(0, slash);
    const id = value.slice(slash + 1);
    return available.filter((model) => model.provider === provider && model.id === id);
  }
  return available.filter((model) => model.id === value);
}

function splitModelAndThinking(value: string, filePath: string, available: Model<any>[]): { model: string; thinking?: string } {
  if (matchingModels(value, available).length > 0) return { model: value };
  const colon = value.lastIndexOf(":");
  if (colon < 0) return { model: value };
  const model = value.slice(0, colon);
  if (!model) throw new AgentConfigurationError(filePath, "model", "model identifier is missing");
  if (matchingModels(model, available).length > 0) return { model, thinking: value.slice(colon + 1) };
  return { model: value };
}

function resolveAvailableModel(value: string, filePath: string, available: Model<any>[]): Model<any> {
  const matches = matchingModels(value, available);
  if (matches.length === 0) throw new AgentConfigurationError(filePath, "model", `unavailable model ${JSON.stringify(value)}`);
  if (matches.length > 1) throw new AgentConfigurationError(filePath, "model", `ambiguous model ${JSON.stringify(value)}; use provider/model`);
  return matches[0]!;
}

function configuredSetting(override: string | undefined, roleSetting: string | undefined): string | undefined {
  const overrideValue = override?.trim();
  const roleValue = roleSetting?.trim();
  const selected = overrideValue && overrideValue !== INHERIT_SETTING ? overrideValue : roleValue;
  return selected && selected !== INHERIT_SETTING ? selected : undefined;
}

export function resolveAgentModel(
  agent: AgentRole,
  ctx: ModelContext,
  modelOverride?: string,
  thinkingOverride?: string,
): ResolvedModel {
  const inheritedThinking = ctx.thinkingLevel ?? "off";
  const configuredModel = configuredSetting(modelOverride, agent.model);
  const configuredThinking = configuredSetting(thinkingOverride, agent.thinking);
  let definition: Model<any> | undefined;
  let thinking: string = configuredThinking ?? inheritedThinking;

  if (configuredModel) {
    const available = ctx.modelRegistry.getAvailable();
    const requested = splitModelAndThinking(configuredModel, agent.filePath, available);
    thinking = configuredThinking ?? requested.thinking ?? inheritedThinking;
    definition = resolveAvailableModel(requested.model, agent.filePath, available);
  } else {
    definition = ctx.model;
    if (!definition) throw new AgentConfigurationError(agent.filePath, "model", "no active parent model is available to inherit");
  }

  const supportedThinking = getSupportedThinkingLevels(definition) as readonly string[];
  if (!supportedThinking.includes(thinking)) {
    throw new AgentConfigurationError(agent.filePath, "thinking", `${definition.provider}/${definition.id} does not support thinking level ${thinking}`);
  }
  return { model: `${definition.provider}/${definition.id}`, thinking: thinking as ThinkingLevel, definition };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript) {
    try {
      if (statSync(currentScript).isFile()) return { command: process.execPath, args: [currentScript, ...args] };
    } catch {
      // Fall through to the installed pi command.
    }
  }
  const executable = path.basename(process.execPath).toLocaleLowerCase();
  return /^(node|bun)(\.exe)?$/u.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

export function childProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment.PI_SESSION_FILE;
  delete childEnvironment.PI_SESSION_ID;
  return childEnvironment;
}

function defaultSpawnProcess(args: string[], cwd: string): SpawnedProcess {
  const invocation = getPiInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd,
    detached: process.platform !== "win32",
    env: childProcessEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as unknown as SpawnedProcess;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 };
  let truncated = bytes.subarray(0, maxBytes).toString("utf8");
  if (truncated.endsWith("�")) truncated = truncated.slice(0, -1);
  return { text: truncated, omittedBytes: bytes.length - Buffer.byteLength(truncated, "utf8") };
}

function makeQueuedResult(id: string, agent: string, task: string, step?: number, name?: string, attempt = 1): SubagentTaskResult {
  return {
    id,
    name,
    attempt,
    agent,
    agentSource: "unknown",
    task,
    status: "queued",
    tools: [],
    trace: [],
    traceBytes: 0,
    traceTruncatedBytes: 0,
    stderr: "",
    stderrBytes: 0,
    stderrTruncatedBytes: 0,
    output: "",
    outputBytes: 0,
    outputTruncatedBytes: 0,
    toolCallCount: 0,
    usage: emptyUsage(),
    durationMs: 0,
    exitCode: null,
    exitConfirmed: false,
    step,
  };
}

function cloneResult(result: SubagentTaskResult): SubagentTaskResult {
  return {
    ...result,
    tools: [...result.tools],
    trace: [...result.trace],
    usage: { ...result.usage, cost: { ...result.usage.cost } },
  };
}

function mergeTaskResults(
  previous: SubagentTaskResult | undefined,
  next: SubagentTaskResult,
  maxTraceBytes?: number,
  maxStderrBytes?: number,
): SubagentTaskResult {
  if (!previous) return cloneResult(next);
  const merged = cloneResult(next);
  const trace: string[] = [];
  let traceBytes = 0;
  let traceTruncatedBytes = previous.traceTruncatedBytes + next.traceTruncatedBytes;
  for (const entry of [...previous.trace, ...next.trace]) {
    const retained = truncateUtf8(entry, maxTraceBytes === undefined ? Buffer.byteLength(entry, "utf8") : Math.max(0, maxTraceBytes - traceBytes));
    if (retained.text) trace.push(retained.text);
    const retainedBytes = Buffer.byteLength(retained.text, "utf8");
    traceBytes += retainedBytes;
    traceTruncatedBytes += retained.omittedBytes;
  }
  merged.trace = trace;
  merged.traceBytes = traceBytes;
  merged.traceTruncatedBytes = traceTruncatedBytes;
  const stderr = [previous.stderr, next.stderr].filter(Boolean).join("\n");
  const retainedStderr = truncateUtf8(stderr, maxStderrBytes === undefined ? Buffer.byteLength(stderr, "utf8") : maxStderrBytes);
  merged.stderr = retainedStderr.text;
  merged.stderrBytes = previous.stderrBytes + next.stderrBytes;
  merged.stderrTruncatedBytes = previous.stderrTruncatedBytes + next.stderrTruncatedBytes + retainedStderr.omittedBytes;
  merged.output = next.output || previous.output;
  merged.outputBytes = previous.outputBytes + next.outputBytes;
  merged.outputTruncatedBytes = previous.outputTruncatedBytes + next.outputTruncatedBytes;
  merged.toolCallCount = previous.toolCallCount + next.toolCallCount;
  merged.usage = emptyUsage();
  addUsage(merged.usage, previous.usage);
  addUsage(merged.usage, next.usage);
  merged.durationMs = previous.durationMs + next.durationMs;
  return merged;
}

function cloneDetails(mode: SubagentDetails["mode"], scope: AgentScope, projectAgentsDir: string | null, results: SubagentTaskResult[]): SubagentDetails {
  const cloned = results.map(cloneResult);
  return { mode, agentScope: scope, projectAgentsDir, results: cloned, aggregateUsage: aggregateUsage(cloned) };
}

async function writeRolePrompt(agent: AgentRole): Promise<{ directory: string; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "killeros-subagent-"));
  const filePath = path.join(directory, `${agent.name.replace(/[^A-Za-z0-9_.-]/gu, "_")}.md`);
  await writeFile(filePath, agent.prompt, { encoding: "utf8", mode: 0o600 });
  return { directory, filePath };
}

interface RunTaskOptions {
  cwd: string;
  agent: AgentRole;
  task: string;
  id: string;
  displayName: string;
  attempt: number;
  step?: number;
  model: ResolvedModel;
  signal?: AbortSignal;
  spawnProcess: (args: string[], cwd: string, environment?: NodeJS.ProcessEnv) => SpawnedProcess;
  webExtension?: string;
  projectTrusted: boolean;
  limits: SubagentLimits;
  sessionDirectory: string;
  sessionId: string;
  timeoutMs?: number;
  onChange: (result: SubagentTaskResult) => void;
  onHandle?: (handle: SubagentProcessHandle) => void;
}

function applyProcessResult(
  target: SubagentTaskResult,
  source: Readonly<SubagentProcessResult>,
  startedAt: number,
  onChange: (result: SubagentTaskResult) => void,
): void {
  target.status = source.status;
  target.trace = [...source.trace];
  target.traceBytes = source.traceBytes;
  target.traceTruncatedBytes = source.traceTruncatedBytes;
  target.stderr = source.stderr;
  target.stderrBytes = source.stderrBytes;
  target.stderrTruncatedBytes = source.stderrTruncatedBytes;
  target.output = source.output;
  target.outputBytes = source.outputBytes;
  target.outputTruncatedBytes = source.outputTruncatedBytes;
  target.toolCallCount = source.toolCallCount;
  target.usage = { ...source.usage, cost: { ...source.usage.cost } };
  target.model = source.model ?? target.model;
  target.terminationReason = source.terminationReason;
  target.errorMessage = source.errorMessage;
  target.exitCode = source.exitCode;
  target.exitConfirmed = source.exitConfirmed;
  target.durationMs = source.durationMs || Date.now() - startedAt;
  onChange(target);
}

async function runTask(options: RunTaskOptions): Promise<SubagentTaskResult> {
  const { agent, limits } = options;
  const result = makeQueuedResult(options.id, agent.name, options.task, options.step, options.displayName, options.attempt);
  result.agentSource = agent.source;
  result.sourcePath = agent.filePath;
  result.access = agent.access;
  result.tools = [...agent.tools];
  result.model = options.model.model;
  result.thinking = options.model.thinking;
  result.status = "running";
  const startedAt = Date.now();
  const notify = (changed: SubagentTaskResult): void => {
    try {
      options.onChange(changed);
    } catch {
      // Host update callbacks are telemetry; a throwing callback must not fail the task.
    }
  };
  notify(result);

  if (options.signal?.aborted) {
    result.status = "cancelled";
    result.terminationReason = "abort";
    result.durationMs = Date.now() - startedAt;
    notify(result);
    return result;
  }

  let promptDirectory: string | undefined;
  try {
    const prompt = await writeRolePrompt(agent);
    promptDirectory = prompt.directory;
    if (options.signal?.aborted) {
      result.status = "cancelled";
      result.terminationReason = "abort";
      result.durationMs = Date.now() - startedAt;
      notify(result);
      return result;
    }
    const args = [
      "--mode", "json",
      "-p",
      "--session-dir", options.sessionDirectory,
      "--session-id", options.sessionId,
      "--name", options.displayName,
      "--no-extensions",
      "--extension", options.webExtension ?? SUBAGENT_WEB_EXTENSION,
      "--no-prompt-templates",
      options.projectTrusted ? "--approve" : "--no-approve",
      "--model", options.model.model,
      "--thinking", options.model.thinking,
      "--tools", agent.tools.join(","),
      "--append-system-prompt", prompt.filePath,
      `Task: ${options.task}`,
    ];
    const handle = runSubagentProcess({
      args,
      cwd: options.cwd,
      signal: options.signal,
      spawnProcess: options.spawnProcess,
      limits: {
        ...(options.timeoutMs === undefined ? {} : { wallTimeMs: options.timeoutMs }),
        ...(limits.maxTurns === undefined ? {} : { maxTurns: limits.maxTurns }),
        ...(limits.jsonlLineBytes === undefined ? {} : { jsonlLineBytes: limits.jsonlLineBytes }),
        ...(limits.traceBytes === undefined ? {} : { traceBytes: limits.traceBytes }),
        ...(limits.stderrBytes === undefined ? {} : { stderrBytes: limits.stderrBytes }),
        ...(limits.taskOutputBytes === undefined ? {} : { outputBytes: limits.taskOutputBytes }),
        ...(limits.quotaTokens === undefined ? {} : { quotaTokens: limits.quotaTokens }),
        ...(limits.quotaUsd === undefined ? {} : { quotaUsd: limits.quotaUsd }),
        killGraceMs: limits.killGraceMs,
        processExitWaitMs: limits.processExitWaitMs,
      },
      retention: {
        traceBytes: limits.traceRetentionBytes,
        stderrBytes: limits.stderrRetentionBytes,
        outputBytes: limits.taskOutputRetentionBytes,
      },
      onUpdate: (next) => applyProcessResult(result, next, startedAt, notify),
    });
    options.onHandle?.(handle);
    const final = await handle.result;
    applyProcessResult(result, final, startedAt, notify);
    return result;
  } catch (error) {
    result.status = options.signal?.aborted ? "cancelled" : "failed";
    result.terminationReason = options.signal?.aborted ? "abort" : "spawn_error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.durationMs = Date.now() - startedAt;
    notify(result);
    return result;
  } finally {
    if (promptDirectory) {
      try {
        await rm(promptDirectory, { recursive: true, force: true });
      } catch {
        // Temporary prompt cleanup is best effort after child termination.
      }
    }
  }
}

async function mapReadTasks<T>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

function waitForConfirmedProcessExit(handle: SubagentProcessHandle, timeoutMs = 1_000): Promise<boolean> {
  if (handle.hasExited) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(exited);
    };
    timeout = setTimeout(() => finish(handle.hasExited), timeoutMs);
    void handle.exited.then(() => finish(true));
  });
}

const SUBAGENT_ACTION = {
  spawn: "spawn",
  list: "list",
  inspect: "inspect",
  steer: "steer",
  interrupt: "interrupt",
  collect: "collect",
  wait: "wait",
  resume: "resume",
  close: "close",
} as const;
type SubagentAction = typeof SUBAGENT_ACTION[keyof typeof SUBAGENT_ACTION];

type SpawnOptions = {
  model?: string;
  thinking?: string;
  agentScope?: AgentScope;
};

type SpawnSingleRequest = SpawnOptions & {
  action?: "spawn";
  agent?: AgentSpec;
  task: string;
  name?: string;
};

type SpawnParallelRequest = SpawnOptions & {
  action?: "spawn";
  tasks: TaskInput[];
  writerConcurrency?: number;
};

type SpawnChainRequest = SpawnOptions & {
  action?: "spawn";
  chain: TaskInput[];
};

export type NormalizedSubagentRequest =
  | { kind: "spawn-single"; input: SpawnSingleRequest }
  | { kind: "spawn-parallel"; input: SpawnParallelRequest }
  | { kind: "spawn-chain"; input: SpawnChainRequest }
  | { kind: "list"; input: { action: "list" } }
  | { kind: "inspect"; input: { action: "inspect"; threadId: string } }
  | { kind: "steer"; input: { action: "steer"; threadId: string; message: string } }
  | { kind: "interrupt-one"; input: { action: "interrupt"; threadId: string } }
  | { kind: "interrupt-all"; input: { action: "interrupt"; all: true } }
  | { kind: "collect"; input: { action: "collect"; threadId: string } }
  | { kind: "wait"; input: { action: "wait"; threadId?: string; all?: true; timeoutMs: number } }
  | { kind: "resume"; input: { action: "resume"; threadId: string; task?: string } }
  | { kind: "close"; input: { action: "close"; threadId: string } };

type SubagentRequestParse =
  | { ok: true; request: NormalizedSubagentRequest }
  | { ok: false; message: string };

const SUBAGENT_ACTIONS = Object.values(SUBAGENT_ACTION);
const SPAWN_OPTION_FIELDS = ["model", "thinking", "agentScope"] as const;
const THREAD_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._ -]{0,47}$";
const THREAD_NAME_RE = new RegExp(THREAD_NAME_PATTERN, "u");
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;

export function validateThreadName(name: string): void {
  if (!name.trim()) throw new Error("Invalid subagent request: name must be a non-empty string.");
  if ([...name].length > 48 || !THREAD_NAME_RE.test(name)) {
    throw new Error(`Invalid subagent request: name must match ${THREAD_NAME_PATTERN}.`);
  }
}

function optionalThreadName(record: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(record, "name")) return undefined;
  const value = record.name;
  if (typeof value !== "string") throw new Error("Invalid subagent request: name must be a non-empty string.");
  validateThreadName(value);
  return value;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function requireAction(value: unknown): SubagentAction {
  if (typeof value !== "string" || !SUBAGENT_ACTIONS.includes(value as SubagentAction)) {
    throw new Error(`Invalid subagent request: action must be one of ${SUBAGENT_ACTIONS.join(", ")}.`);
  }
  return value as SubagentAction;
}

function requireTextField(record: Record<string, unknown>, field: string, maxLength: number): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid subagent request: ${field} must be a non-empty string.`);
  }
  if ([...value].length > maxLength) {
    throw new Error(`Invalid subagent request: ${field} must be no longer than ${maxLength} characters.`);
  }
  return value;
}

function requireOnlyFields(record: Record<string, unknown>, allowed: readonly string[], action: string): void {
  const allowedFields = new Set(allowed);
  const invalid = Object.keys(record).find((field) => !allowedFields.has(field));
  if (invalid) throw new Error(`Invalid subagent request: field ${JSON.stringify(invalid)} is not valid with action ${JSON.stringify(action)}.`);
}

function parseAgentSpec(value: unknown): AgentSpec | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    if (!value.length) throw new Error("Invalid subagent request: agent must be a non-empty role name or inline role.");
    if ([...value].length > 64) throw new Error("Invalid subagent request: agent must be no longer than 64 characters.");
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid subagent request: agent must be a role name, inline role, or omitted.");
  }
  const role = requireRecord(value, "inline role");
  for (const field of Object.keys(role)) {
    if (!["name", "description", "access", "tools"].includes(field)) {
      throw new AgentConfigurationError("inline role", field, "unknown role field");
    }
  }
  const name = requiredString(role, "inline role", "name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name)) {
    throw new AgentConfigurationError("inline role", "name", "must use 1-64 letters, numbers, dots, underscores, or hyphens");
  }
  const description = requiredString(role, "inline role", "description");
  if (description.length > 500) throw new AgentConfigurationError("inline role", "description", "must not exceed 500 characters");
  const access = requiredString(role, "inline role", "access");
  if (access !== "read" && access !== "write") {
    throw new AgentConfigurationError("inline role", "access", 'must be "read" or "write"');
  }
  if (!Array.isArray(role.tools) || role.tools.length === 0) {
    throw new AgentConfigurationError("inline role", "tools", "must contain at least one tool");
  }
  const tools = [...new Set(role.tools.map((tool) => {
    if (typeof tool !== "string" || !tool.trim()) {
      throw new AgentConfigurationError("inline role", "tools", "must contain non-empty tool names");
    }
    return tool.trim();
  }))];
  for (const tool of tools) {
    if (!KNOWN_TOOLS.has(tool)) throw new AgentConfigurationError("inline role", "tools", `unknown child tool ${JSON.stringify(tool)}`);
    if (access === "read" && WRITE_TOOLS.has(tool)) {
      throw new AgentConfigurationError("inline role", "tools", `read-only roles cannot use ${tool}`);
    }
  }
  return { name, description, access, tools };
}

function inlineAgentRole(role: InlineAgentRole): AgentRole {
  return {
    ...role,
    prompt: role.description,
    source: "inline",
    filePath: `inline:${role.name}`,
  };
}

function activeParentTools(pi: ExtensionAPI): Set<string> | undefined {
  const getActiveTools = (pi as unknown as { getActiveTools?: () => string[] }).getActiveTools;
  return typeof getActiveTools === "function" ? new Set(getActiveTools.call(pi)) : undefined;
}

function validateAgentTools(agent: AgentRole, parentTools: ReadonlySet<string> | undefined): void {
  if (!parentTools) return;
  const unavailable = agent.tools.find((tool) => !parentTools.has(tool));
  if (unavailable) throw new Error(`Role ${JSON.stringify(agent.name)} tool ${JSON.stringify(unavailable)} is not active for the parent`);
}

function genericAgentRole(parentTools: ReadonlySet<string> | undefined): AgentRole {
  const tools = [...READ_TOOLS].filter((tool) => !parentTools || parentTools.has(tool));
  if (tools.length === 0) throw new Error("No read-only child tools are active for the parent");
  return {
    name: "generic",
    description: "Complete the assigned task and return the result to the parent.",
    access: "read",
    tools,
    prompt: "Complete the assigned task and return the result to the parent.",
    source: "inline",
    filePath: "inline:generic",
  };
}

function cloneAgentRole(agent: AgentRole): AgentRole {
  return { ...agent, tools: [...agent.tools] };
}

function restorePersistedAgent(value: unknown): AgentRole | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const role = value as Record<string, unknown>;
  const name = role.name;
  const description = role.description;
  const access = role.access;
  const tools = role.tools;
  const prompt = role.prompt;
  const source = role.source;
  const filePath = role.filePath;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(name)) return undefined;
  if (typeof description !== "string" || !description.trim() || description.length > 500) return undefined;
  if (access !== "read" && access !== "write") return undefined;
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => typeof tool !== "string" || !KNOWN_TOOLS.has(tool))) return undefined;
  const uniqueTools = [...new Set(tools as string[])];
  if (uniqueTools.length !== tools.length || access === "read" && uniqueTools.some((tool) => WRITE_TOOLS.has(tool))) return undefined;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > SUBAGENT_LIMITS.roleFileBytes) return undefined;
  if (source !== "bundled" && source !== "personal" && source !== "project" && source !== "inline") return undefined;
  if (typeof filePath !== "string" || !filePath) return undefined;
  const optionalString = (field: string): string | undefined => {
    const item = role[field];
    return item === undefined ? undefined : typeof item === "string" && item.trim() ? item : undefined;
  };
  const timeoutMs = role.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_NODE_TIMER_MS)) return undefined;
  return {
    name,
    description,
    access,
    tools: uniqueTools,
    model: optionalString("model"),
    thinking: optionalString("thinking"),
    timeoutMs: typeof timeoutMs === "number" ? timeoutMs : undefined,
    prompt,
    source,
    filePath,
  };
}

function parseTaskInputs(value: unknown, field: "tasks" | "chain", limits: Pick<SubagentLimits, "maxTasks" | "taskCharacters">): TaskInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid subagent request: ${field} must be a non-empty array.`);
  }
  if (value.length > limits.maxTasks) throw new Error(`At most ${limits.maxTasks} subagent tasks are allowed`);
  return value.map((entry, index) => {
    const task = requireRecord(entry, `${field}[${index}]`);
    requireOnlyFields(task, ["agent", "task", "name"], `spawn ${field}`);
    const name = optionalThreadName(task);
    const agent = parseAgentSpec(task.agent);
    return {
      ...(agent === undefined ? {} : { agent }),
      task: requireTextField(task, "task", limits.taskCharacters),
      ...(name === undefined ? {} : { name }),
    };
  });
}

function parseSpawnOptions(record: Record<string, unknown>): SpawnOptions {
  const options: SpawnOptions = {};
  if (Object.hasOwn(record, "model")) options.model = requireTextField(record, "model", 256);
  if (Object.hasOwn(record, "thinking")) options.thinking = requireTextField(record, "thinking", 16);
  if (Object.hasOwn(record, "agentScope")) {
    const scope = record.agentScope;
    if (scope !== "user" && scope !== "project" && scope !== "both") {
      throw new Error('Invalid subagent request: agentScope must be "user", "project", or "both".');
    }
    options.agentScope = scope;
  }
  return options;
}

export function normalizeSubagentRequest(
  value: unknown,
  limits: Pick<SubagentLimits, "maxTasks" | "taskCharacters"> = SUBAGENT_LIMITS,
): NormalizedSubagentRequest {
  const record = requireRecord(value, "subagent request");
  const action = record.action === undefined ? SUBAGENT_ACTION.spawn : requireAction(record.action);

  if (action !== "steer" && action !== "spawn" && Object.hasOwn(record, "message")) {
    throw new Error('Invalid subagent request: message is only valid with action "steer". Use {"action":"steer","threadId":"...","message":"..."}.');
  }

  if (action === "spawn") {
    const hasSingle = Object.hasOwn(record, "agent") || Object.hasOwn(record, "task") || Object.hasOwn(record, "message");
    const hasParallel = Object.hasOwn(record, "tasks");
    const hasChain = Object.hasOwn(record, "chain");
    if (Number(hasSingle) + Number(hasParallel) + Number(hasChain) !== 1) {
      throw new Error("Invalid subagent request: choose exactly one spawn shape: agent + task, tasks, or chain.");
    }
    if (Object.hasOwn(record, "writerConcurrency") && !hasParallel) {
      throw new Error("Invalid subagent request: writerConcurrency is only valid with parallel tasks.");
    }
    const actionField = Object.hasOwn(record, "action") ? { action: "spawn" as const } : {};
    const options = parseSpawnOptions(record);
    if (hasSingle) {
      requireOnlyFields(record, ["action", "agent", "task", "message", "name", ...SPAWN_OPTION_FIELDS], "spawn single");
      if (Object.hasOwn(record, "task") && Object.hasOwn(record, "message")) {
        throw new Error("Invalid subagent request: spawn single cannot combine task with its message alias.");
      }
      const name = optionalThreadName(record);
      return {
        kind: "spawn-single",
        input: {
          ...actionField,
          agent: parseAgentSpec(record.agent),
          task: requireTextField(record, Object.hasOwn(record, "message") ? "message" : "task", limits.taskCharacters),
          ...(name === undefined ? {} : { name }),
          ...options,
        },
      };
    }
    if (hasParallel) {
      requireOnlyFields(record, ["action", "tasks", "writerConcurrency", ...SPAWN_OPTION_FIELDS], "spawn parallel");
      let writerConcurrency: number | undefined;
      if (Object.hasOwn(record, "writerConcurrency")) {
        writerConcurrency = record.writerConcurrency as number;
        if (!Number.isSafeInteger(writerConcurrency) || writerConcurrency < 1 || writerConcurrency > limits.maxTasks) {
          throw new Error(`writerConcurrency must be a positive integer no greater than ${limits.maxTasks}`);
        }
      }
      return {
        kind: "spawn-parallel",
        input: {
          ...actionField,
          tasks: parseTaskInputs(record.tasks, "tasks", limits),
          ...(writerConcurrency === undefined ? {} : { writerConcurrency }),
          ...options,
        },
      };
    }
    requireOnlyFields(record, ["action", "chain", ...SPAWN_OPTION_FIELDS], "spawn chain");
    return {
      kind: "spawn-chain",
      input: { ...actionField, chain: parseTaskInputs(record.chain, "chain", limits), ...options },
    };
  }

  if (action === "list") {
    requireOnlyFields(record, ["action"], action);
    return { kind: "list", input: { action } };
  }
  if (action === "inspect" || action === "collect" || action === "close") {
    requireOnlyFields(record, ["action", "threadId"], action);
    const input = { action, threadId: requireTextField(record, "threadId", 128) };
    return { kind: action, input } as NormalizedSubagentRequest;
  }
  if (action === "steer") {
    requireOnlyFields(record, ["action", "threadId", "message"], action);
    return {
      kind: "steer",
      input: {
        action,
        threadId: requireTextField(record, "threadId", 128),
        message: requireTextField(record, "message", 4_000),
      },
    };
  }

  if (action === "wait") {
    requireOnlyFields(record, ["action", "threadId", "all", "timeoutMs"], action);
    const hasThreadId = Object.hasOwn(record, "threadId");
    const hasAll = Object.hasOwn(record, "all");
    if (hasThreadId && hasAll || hasAll && record.all !== true) {
      throw new Error('Invalid subagent request: action "wait" cannot combine threadId with all: true.');
    }
    const timeoutValue = record.timeoutMs === undefined ? DEFAULT_WAIT_TIMEOUT_MS : record.timeoutMs;
    if (typeof timeoutValue !== "number" || !Number.isSafeInteger(timeoutValue) || timeoutValue <= 0 || timeoutValue > MAX_WAIT_TIMEOUT_MS) {
      throw new Error(`Invalid subagent request: timeoutMs must be a positive integer no greater than ${MAX_WAIT_TIMEOUT_MS}.`);
    }
    return {
      kind: "wait",
      input: {
        action,
        ...(hasThreadId ? { threadId: requireTextField(record, "threadId", 128) } : {}),
        ...(hasAll || !hasThreadId ? { all: true as const } : {}),
        timeoutMs: timeoutValue,
      },
    };
  }

  if (action === "resume") {
    requireOnlyFields(record, ["action", "threadId", "task"], action);
    return {
      kind: "resume",
      input: {
        action,
        threadId: requireTextField(record, "threadId", 128),
        ...(Object.hasOwn(record, "task") ? { task: requireTextField(record, "task", limits.taskCharacters) } : {}),
      },
    };
  }

  requireOnlyFields(record, ["action", "threadId", "all"], action);
  const hasThreadId = Object.hasOwn(record, "threadId");
  const hasAll = Object.hasOwn(record, "all");
  if (Number(hasThreadId) + Number(hasAll) !== 1 || hasAll && record.all !== true) {
    throw new Error('Invalid subagent request: action "interrupt" requires exactly one of threadId or all: true.');
  }
  if (hasThreadId) {
    return { kind: "interrupt-one", input: { action, threadId: requireTextField(record, "threadId", 128) } };
  }
  return { kind: "interrupt-all", input: { action, all: true } };
}

export function tryNormalizeSubagentRequest(
  value: unknown,
  limits: Pick<SubagentLimits, "maxTasks" | "taskCharacters"> = SUBAGENT_LIMITS,
): SubagentRequestParse {
  try {
    return { ok: true, request: normalizeSubagentRequest(value, limits) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function prepareSubagentRequest(
  value: unknown,
  limits: Pick<SubagentLimits, "maxTasks" | "taskCharacters">,
): NormalizedSubagentRequest {
  const record = requireRecord(value, "subagent request");
  const action = record.action ?? SUBAGENT_ACTION.spawn;
  if (action === SUBAGENT_ACTION.spawn && Object.hasOwn(record, "threadId")) {
    const { threadId: _generatedThreadId, ...spawnRecord } = record;
    return normalizeSubagentRequest(spawnRecord, limits);
  }
  return normalizeSubagentRequest(record, limits);
}

function createSubagentParams(limits: Pick<SubagentLimits, "maxTasks" | "maxReadConcurrency" | "taskCharacters">) {
  const inlineAgentSchema = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$" }),
    description: Type.String({ minLength: 1, maxLength: 500 }),
    access: StringEnum(["read", "write"] as const),
    tools: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
  }, { additionalProperties: false, description: "Optional role definition for this spawn; tools must be active for the parent" });
  const agentSchema = Type.Union([
    Type.String({ minLength: 1, maxLength: 64, description: "Optional custom role name from an approved agents folder" }),
    inlineAgentSchema,
  ]);
  const taskSchema = Type.Object({
    agent: Type.Optional(agentSchema),
    task: Type.String({ minLength: 1, maxLength: limits.taskCharacters, description: "Bounded task; omitted agent uses the generic read-only child" }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 48, pattern: THREAD_NAME_PATTERN, description: "Parent-scoped child display name" })),
  }, { additionalProperties: false });
  const chainTaskSchema = Type.Object({
    agent: Type.Optional(agentSchema),
    task: Type.String({ minLength: 1, maxLength: limits.taskCharacters, description: "Task with optional {previous}; omitted agent uses the generic read-only child" }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 48, pattern: THREAD_NAME_PATTERN, description: "Parent-scoped child display name" })),
  }, { additionalProperties: false });
  const threadId = Type.String({ minLength: 1, maxLength: 128, description: "Existing child thread ID; omit when spawning because KillerOS creates it" });
  return Type.Object({
    action: Type.Optional(StringEnum(SUBAGENT_ACTIONS, { default: SUBAGENT_ACTION.spawn, description: "Spawn, list, inspect, steer, interrupt, collect, wait, resume, or close. Omit threadId when spawning" })),
    threadId: Type.Optional(threadId),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 48, pattern: THREAD_NAME_PATTERN, description: "Parent-scoped child display name" })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: Math.max(4_000, limits.taskCharacters), description: `Spawn task alias up to ${limits.taskCharacters.toLocaleString("en-US")} characters; steer message up to 4,000 characters` })),
    all: Type.Optional(Type.Literal(true, { description: "Target every active or queued child thread for interrupt or wait" })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WAIT_TIMEOUT_MS, description: "Wait timeout in milliseconds; defaults to 30 seconds" })),
    agent: Type.Optional(agentSchema),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: limits.taskCharacters, description: "Task for single mode" })),
    tasks: Type.Optional(Type.Array(taskSchema, { minItems: 1, maxItems: limits.maxTasks, description: `Parallel role tasks: read-only batches run concurrently up to ${limits.maxReadConcurrency}; batches with writers use one shared slot by default. Set writerConcurrency to opt into a larger shared pool; concurrent writers share the parent worktree, so callers must prove path ownership` })),
    writerConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.maxTasks, description: `Optional shared-pool cap for parallel tasks that include writers. Defaults to 1 when writers are selected; values above 1 opt into concurrent shared-worktree writes. Concurrent writers must prove path ownership` })),
    chain: Type.Optional(Type.Array(chainTaskSchema, { minItems: 1, maxItems: limits.maxTasks, description: "Sequential role tasks; {previous} inserts the prior result" })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Optional model for every task as provider/model; omitted or inherit uses the selected role default, then the active parent. Set this when the user requires one model for the batch" })),
    thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 16, description: "Optional thinking effort for every task: off, minimal, low, medium, high, xhigh, max, or inherit. Omitted or inherit uses the selected role default, then the active parent" })),
    agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, {
      default: "user",
      description: "Custom role sources: user includes personal; project includes trusted project; both includes both",
    })),
  }, { additionalProperties: false });
}

type ToolUpdate = (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;

function clipCharacters(text: string, maxCharacters: number, fromEnd = false): string {
  const characters = [...text];
  if (characters.length <= maxCharacters) return text;
  return (fromEnd ? characters.slice(-maxCharacters) : characters.slice(0, maxCharacters)).join("");
}

function codePointLength(text: string): number {
  let length = 0;
  for (const _character of text) length += 1;
  return length;
}

function expandChainTask(template: string, previous: string, maxCharacters: number): string | undefined {
  const placeholder = "{previous}";
  let occurrences = 0;
  let searchFrom = 0;
  while (true) {
    const index = template.indexOf(placeholder, searchFrom);
    if (index < 0) break;
    occurrences += 1;
    searchFrom = index + placeholder.length;
  }
  if (occurrences === 0) return codePointLength(template) <= maxCharacters ? template : undefined;

  const expandedCharacters = codePointLength(template) + occurrences * (codePointLength(previous) - codePointLength(placeholder));
  if (expandedCharacters > maxCharacters) return undefined;

  const pieces: string[] = [];
  let start = 0;
  while (true) {
    const index = template.indexOf(placeholder, start);
    if (index < 0) {
      pieces.push(template.slice(start));
      break;
    }
    pieces.push(template.slice(start, index), previous);
    start = index + placeholder.length;
  }
  return pieces.join("");
}

function buildSteeredTask(task: string, steering: readonly string[], maxCharacters: number): string {
  const steeringLabel = "\n\nParent steering:\n";
  const steeringText = clipCharacters(steering.join("\n"), Math.max(0, maxCharacters - [...steeringLabel].length), true);
  const required = [...steeringLabel, ...steeringText].length;
  const taskText = clipCharacters(task, Math.max(0, maxCharacters - required));
  return `${taskText}${steeringLabel}${steeringText}`;
}

export type TaskInput = { agent?: AgentSpec; task: string; name?: string };

function steeredTaskWouldExceedLimit(task: string, steering: readonly string[], maxCharacters: number): boolean {
  if (!steering.length) return false;
  return codePointLength(task)
    + codePointLength("\n\nParent steering:\n")
    + codePointLength(steering.join("\n")) > maxCharacters;
}

function formatUsage(usage: SubagentUsage): string {
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`, `${usage.totalTokens} tokens`];
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function buildToolContent(mode: SubagentDetails["mode"], results: SubagentTaskResult[], maxBytes: number): string {
  const sections = results.map((result) => {
    const heading = `### ${result.id} · ${result.agent} · ${result.status}`;
    const reason = result.terminationReason && result.terminationReason !== "completed" ? `\nReason: ${result.terminationReason}` : "";
    const body = result.output || result.errorMessage || result.stderr.trim() || "(no output)";
    const truncation = result.outputTruncatedBytes ? `\n\n[Task output truncated: ${result.outputTruncatedBytes} bytes omitted; bounded detail is available when expanded.]` : "";
    return `${heading}${reason}\n\n${body}${truncation}`;
  });
  const complete = results.filter((result) => result.status === "complete").length;
  const text = `${mode}: ${complete}/${results.length} complete · ${formatUsage(aggregateUsage(results))}\n\n${sections.join("\n\n---\n\n")}`;
  const marker = "\n\n[Combined subagent output truncated to 50 KiB; inspect the expanded tool result for bounded per-task details.]";
  return boundedText(text, maxBytes, marker);
}

function statusColor(status: SubagentStatus): "accent" | "success" | "error" | "warning" | "muted" {
  if (status === "running") return "accent";
  if (status === "complete") return "success";
  if (status === "failed") return "error";
  if (status === "limited" || status === "cancelled") return "warning";
  return "muted";
}

function statusIcon(status: SubagentStatus): string {
  if (status === "running") return "✻";
  if (status === "complete") return "✓";
  if (status === "failed") return "✗";
  if (status === "queued") return "○";
  return "!";
}

interface ActiveThreadRuntime {
  controller: AbortController;
  handle?: SubagentProcessHandle;
  handles: Set<SubagentProcessHandle>;
  task: string;
  steering: string[];
  restarting: boolean;
  traceCount: number;
  startedAt: number;
  sessionGeneration: number;
  aggregate?: SubagentTaskResult;
  requestedReason?: string;
}

interface ChildSession {
  id: string;
  directory: string;
}

interface ThreadMetadata {
  displayName: string;
  attempt: number;
  session: ChildSession;
  persistentSession: boolean;
  agent?: AgentRole;
  thinking?: ThinkingLevel;
}

type ThreadSnapshot = SubagentThread & {
  displayName?: string;
  attempt?: number;
  session?: ChildSession;
};

function parentThreadId(ctx: ExtensionContext): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (id) return `main:${id}`;
  } catch {
    // Test and RPC contexts may not expose a session manager.
  }
  return "main";
}

function defaultThreadName(role: string, existing: readonly ThreadSnapshot[]): string {
  const names = new Set(existing.map((thread) => thread.displayName?.toLocaleLowerCase() ?? thread.role.toLocaleLowerCase()));
  const base = role.length <= 48 ? role : role.slice(0, 48);
  if (!names.has(base.toLocaleLowerCase()) && THREAD_NAME_RE.test(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, 48 - suffixText.length)}${suffixText}`;
    if (THREAD_NAME_RE.test(candidate) && !names.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error(`Could not allocate a unique display name for role ${JSON.stringify(role)}`);
}

function safeSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_");
}

function childSessionPath(ctx: ExtensionContext, threadId: string): ChildSession | undefined {
  try {
    const directoryRoot = ctx.sessionManager?.getSessionDir?.();
    if (typeof directoryRoot !== "string" || !directoryRoot) return undefined;
    const rawParentId = ctx.sessionManager?.getSessionId?.() ?? parentThreadId(ctx);
    const id = `killeros-${safeSessionId(threadId)}`;
    return {
      id,
      directory: path.join(directoryRoot, "killeros-subagents", safeSessionId(rawParentId), safeSessionId(threadId)),
    };
  } catch {
    return undefined;
  }
}

function threadDisplayName(thread: ThreadSnapshot, metadata: Map<string, ThreadMetadata>): string {
  return thread.displayName ?? metadata.get(thread.id)?.displayName ?? thread.role;
}

function threadAttempt(thread: ThreadSnapshot, metadata: Map<string, ThreadMetadata>): number {
  return thread.attempt ?? metadata.get(thread.id)?.attempt ?? 1;
}

function threadSession(thread: ThreadSnapshot, metadata: Map<string, ThreadMetadata>): ChildSession | undefined {
  return thread.session ?? metadata.get(thread.id)?.session;
}

function threadView(thread: SubagentThread, metadata: Map<string, ThreadMetadata>): ThreadSnapshot {
  const view = { ...thread } as ThreadSnapshot;
  const known = metadata.get(thread.id);
  if (view.displayName === undefined && known) view.displayName = known.displayName;
  if (view.attempt === undefined && known) view.attempt = known.attempt;
  const isPendingSession = view.session?.id === "killeros-pending"
    || view.session?.directory === path.join(os.tmpdir(), "killeros-subagent-pending");
  if ((view.session === undefined || isPendingSession) && known) view.session = { ...known.session };
  return view;
}

function threadCapabilityBoundary(agent: AgentRole): {
  filesystem: "read" | "write";
  network: "none" | "read";
  process: "none" | "limited";
  childThreads: false;
} {
  return {
    filesystem: agent.access,
    network: agent.tools.some((tool) => WEB_TOOLS.has(tool)) ? "read" : "none",
    process: agent.tools.includes("bash") ? "limited" : "none",
    childThreads: false,
  };
}

function threadUsage(usage: SubagentUsage): SubagentThread["usage"] {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    costUsd: usage.cost.total,
    turns: usage.turns,
  };
}

function legacyStatus(state: SubagentThreadState): SubagentStatus {
  if (state === "active") return "running";
  if (state === "done" || state === "closed") return "complete";
  if (state === "failed") return "failed";
  if (state === "stopped") return "cancelled";
  if (state === "orphaned") return "orphaned";
  return "queued";
}

function threadResult(thread: SubagentThread, source?: SubagentTaskResult): SubagentTaskResult {
  if (source) {
    const result = cloneResult(source);
    if (thread.state === "queued") result.status = "queued";
    else if (thread.state === "active") result.status = "running";
    else if (thread.state === "orphaned") result.status = "orphaned";
    return result;
  }
  return {
    ...makeQueuedResult(thread.id, thread.role, thread.prompt),
    status: legacyStatus(thread.state),
    agentSource: "unknown",
    model: thread.model,
    tools: [...thread.tools],
    trace: thread.trace.map((event) => event.message ?? event.kind),
    usage: {
      input: thread.usage.inputTokens,
      output: thread.usage.outputTokens,
      cacheRead: thread.usage.cacheReadTokens,
      cacheWrite: thread.usage.cacheWriteTokens,
      totalTokens: thread.usage.totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: thread.usage.costUsd },
      turns: thread.usage.turns,
    },
    output: thread.result ?? "",
    toolCallCount: 0,
    exitConfirmed: false,
    terminationReason: thread.stopReason,
  };
}

function restorePersistedResult(value: unknown, thread: ThreadSnapshot): SubagentTaskResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, any>;
  const statuses = new Set<SubagentStatus>(["queued", "running", "complete", "failed", "cancelled", "limited"]);
  const agentSources = new Set<SubagentTaskResult["agentSource"]>(["bundled", "personal", "project", "inline", "unknown"]);
  if (typeof source.id !== "string" || source.id !== thread.id) return undefined;
  const status = source.status ?? (thread.state === "done" ? "complete" : thread.state === "failed" ? "failed" : "cancelled");
  if (typeof status !== "string" || !statuses.has(status as SubagentStatus)) return undefined;
  if (thread.state === "done" && status !== "complete") return undefined;
  if (thread.state === "failed" && status !== "failed") return undefined;
  if (thread.state === "stopped" && !["cancelled", "limited"].includes(status)) return undefined;
  if (thread.state === "closed") return undefined;
  const rawOutput = source.output === undefined ? thread.result ?? "" : source.output;
  if (typeof rawOutput !== "string") return undefined;
  const output = truncateUtf8(rawOutput, 256 * 1024).text;
  const usage = source.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const usageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "turns"];
  if (usageFields.some((field) => typeof usage[field] !== "number" || !Number.isFinite(usage[field]) || usage[field] < 0)) return undefined;
  if (!usage.cost || typeof usage.cost !== "object" || Array.isArray(usage.cost)) return undefined;
  const costFields = ["input", "output", "cacheRead", "cacheWrite", "total"];
  if (costFields.some((field) => typeof usage.cost[field] !== "number" || !Number.isFinite(usage.cost[field]) || usage.cost[field] < 0)) return undefined;
  const outputBytes = source.outputBytes === undefined ? Buffer.byteLength(output, "utf8") : source.outputBytes;
  const outputTruncatedBytes = source.outputTruncatedBytes === undefined ? 0 : source.outputTruncatedBytes;
  const durationMs = source.durationMs === undefined ? 0 : source.durationMs;
  if (![outputBytes, outputTruncatedBytes, durationMs].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0)) return undefined;
  const exitCode = source.exitCode === undefined || source.exitCode === null ? null : source.exitCode;
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || exitCode < 0)) return undefined;
  if (source.terminationReason !== undefined && typeof source.terminationReason !== "string") return undefined;
  if (source.errorMessage !== undefined && typeof source.errorMessage !== "string") return undefined;
  if (source.exitConfirmed !== undefined && typeof source.exitConfirmed !== "boolean") return undefined;
  if (source.agentSource !== undefined && (typeof source.agentSource !== "string" || !agentSources.has(source.agentSource as SubagentTaskResult["agentSource"]))) return undefined;
  const attempt = Number.isSafeInteger(source.attempt) && source.attempt > 0 ? source.attempt : thread.attempt;
  const result = makeQueuedResult(
    thread.id,
    typeof source.agent === "string" && source.agent ? clipCharacters(source.agent, 64) : thread.role,
    typeof source.task === "string" && source.task ? clipCharacters(source.task, 20_000) : thread.prompt,
    undefined,
    typeof source.name === "string" && source.name ? clipCharacters(source.name, 48) : thread.displayName,
    attempt,
  );
  result.status = status as SubagentStatus;
  result.agentSource = source.agentSource ?? "unknown";
  result.output = output;
  result.outputBytes = outputBytes;
  result.outputTruncatedBytes = outputTruncatedBytes;
  result.usage = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: { input: usage.cost.input, output: usage.cost.output, cacheRead: usage.cost.cacheRead, cacheWrite: usage.cost.cacheWrite, total: usage.cost.total },
    turns: usage.turns,
  };
  result.terminationReason = source.terminationReason;
  result.errorMessage = source.errorMessage;
  result.durationMs = durationMs;
  result.exitCode = exitCode;
  result.exitConfirmed = source.exitConfirmed === true;
  return result;
}

function threadBoardRecord(result: SubagentTaskResult): ThreadBoardRecord {
  return {
    id: result.id,
    displayName: result.name,
    attempt: result.attempt,
    agent: result.agent,
    task: result.task,
    status: result.status as ThreadBoardRecord["status"],
    usage: {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      totalTokens: result.usage.totalTokens,
      turns: result.usage.turns,
      cost: result.usage.cost.total,
    },
    trace: result.trace,
    traceTruncatedBytes: result.traceTruncatedBytes,
    handoff: result.output,
    output: result.output,
    terminationReason: result.terminationReason,
    errorMessage: result.errorMessage,
    durationMs: result.durationMs,
    step: result.step,
  };
}

export function registerSubagentTool(pi: ExtensionAPI, options: SubagentRuntimeOptions = {}): SubagentControlApi {
  const limits = { ...SUBAGENT_LIMITS, ...options.limits };
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  let threads = new SubagentThreadRegistry();
  const activeRuntimes = new Map<string, ActiveThreadRuntime>();
  const threadMetadata = new Map<string, ThreadMetadata>();
  type ThreadResource = { directory: string; persistent: boolean; handles: Set<SubagentProcessHandle> };
  const threadResources = new Map<string, ThreadResource>();
  const backgroundBatches = new Set<Promise<unknown>>();
  const savedResults = new Map<string, SubagentTaskResult>();
  const evictedThreadParents = new Map<string, string | undefined>();
  let terminalCleanupQueue: Promise<void> = Promise.resolve();
  let sessionGeneration = 0;
  let persistenceWarning: string | undefined;

  const persistText = (value: string | undefined, maxBytes: number): string | undefined => {
    if (value === undefined) return undefined;
    return truncateUtf8(value, maxBytes).text;
  };
  const lifecycleOutput = (value: string | undefined): string | undefined => value?.trim() ? value : undefined;
  const persistenceAppend = (record: Record<string, unknown>): void => {
    const appendEntry = (pi as unknown as { appendEntry?: (type: string, data: unknown) => void }).appendEntry;
    if (!appendEntry) return;
    try {
      appendEntry.call(pi, SUBAGENT_PERSISTENCE_TYPE, record);
    } catch (error) {
      persistenceWarning ??= `Subagent persistence is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const persistedThread = (thread: ThreadSnapshot): Record<string, unknown> => {
    const session = threadSession(thread, threadMetadata) ?? { id: `killeros-${safeSessionId(thread.id)}`, directory: "" };
    const metadata = threadMetadata.get(thread.id);
    const agent = metadata?.agent;
    return {
      id: thread.id,
      parentId: thread.parentId,
      displayName: threadDisplayName(thread, threadMetadata),
      attempt: threadAttempt(thread, threadMetadata),
      role: thread.role,
      prompt: clipCharacters(thread.prompt, limits.taskCharacters),
      model: thread.model,
      tools: thread.tools.slice(0, 32).map((tool) => clipCharacters(tool, 64)),
      ...(agent ? {
        roleDefinition: {
          name: agent.name,
          description: persistText(agent.description, 500),
          access: agent.access,
          tools: agent.tools.slice(0, 32).map((tool) => clipCharacters(tool, 64)),
          model: agent.model,
          thinking: agent.thinking,
          timeoutMs: agent.timeoutMs,
          prompt: persistText(agent.prompt, limits.roleFileBytes),
          source: agent.source,
          filePath: persistText(agent.filePath, 4_000),
        },
        thinking: metadata?.thinking,
      } : {}),
      capabilityBoundary: { ...thread.capabilityBoundary },
      session: { ...session },
      state: thread.state,
      usage: { ...thread.usage },
      handoff: thread.handoff
        ? { ...thread.handoff, summary: persistText(thread.handoff.summary, 256 * 1024) }
        : undefined,
      result: persistText(thread.result, 256 * 1024),
      failure: thread.failure ? { ...thread.failure, message: clipCharacters(thread.failure.message, 512) } : undefined,
      stopReason: thread.stopReason,
      evicted: thread.evicted,
      timestamps: { ...thread.timestamps },
      version: thread.version,
      trace: thread.trace.slice(-64).map((entry) => ({
        ...entry,
        message: persistText(entry.message, 64 * 1024),
      })),
      steering: thread.steering.slice(-20).map((entry) => ({ ...entry, message: clipCharacters(entry.message, 4_000) })),
    };
  };
  const recordSpawn = (thread: SubagentThread): void => {
    const view = threadView(thread, threadMetadata);
    persistenceAppend({ version: 1, event: "spawn", parentId: view.parentId, thread: persistedThread(view) });
  };
  const recordSnapshot = (thread: SubagentThread, result?: SubagentTaskResult): void => {
    const view = threadView(thread, threadMetadata);
    persistenceAppend({
      version: 1,
      event: "snapshot",
      parentId: view.parentId,
      id: view.id,
      thread: persistedThread(view),
      ...(result ? {
        result: {
          id: result.id,
          name: result.name,
          agent: result.agent,
          agentSource: result.agentSource,
          task: clipCharacters(result.task, limits.taskCharacters),
          status: result.status,
          output: persistText(result.output, 256 * 1024),
          outputBytes: result.outputBytes,
          outputTruncatedBytes: result.outputTruncatedBytes,
          usage: result.usage,
          terminationReason: result.terminationReason,
          errorMessage: persistText(result.errorMessage, 8 * 1024),
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          exitConfirmed: result.exitConfirmed,
          attempt: result.attempt,
        },
      } : {}),
    });
  };
  const recordClose = (thread: SubagentThread): void => {
    const view = threadView(thread, threadMetadata);
    persistenceAppend({ version: 1, event: "close", parentId: view.parentId, id: view.id, closedAt: view.timestamps.closedAt ?? Date.now() });
  };
  let unsubscribePersistence = (): void => {};
  const attachPersistence = (): void => {
    unsubscribePersistence = threads.subscribe((change) => {
      if (["complete", "fail", "stop", "interrupt", "resume"].includes(change.type)) {
        recordSnapshot(change.thread, savedResults.get(change.thread.id));
      } else if (change.type === "close") {
        recordClose(change.thread);
      }
    });
  };

  const restoreRecords = (
    entries: readonly unknown[],
    parentId: string,
    expectedSession?: (threadId: string) => ChildSession | undefined,
  ): Array<{ thread: ThreadSnapshot; result?: SubagentTaskResult; agent?: AgentRole; thinking?: ThinkingLevel }> => {
    const records = new Map<string, { thread: ThreadSnapshot; result?: SubagentTaskResult; agent?: AgentRole; thinking?: ThinkingLevel }>();
    for (const entry of entries) {
      try {
        if (!entry || typeof entry !== "object") continue;
        const candidate = entry as Record<string, unknown>;
        if (candidate.type !== "custom" || candidate.customType !== SUBAGENT_PERSISTENCE_TYPE) continue;
        const data = candidate.data;
        if (!data || typeof data !== "object") continue;
        const record = data as Record<string, any>;
        if (record.version !== 1 || typeof record.parentId !== "string" || record.parentId !== parentId) continue;
        if (record.event === "spawn" || record.event === "snapshot") {
          const rawThread = record.thread;
          if (!rawThread || typeof rawThread !== "object" || typeof rawThread.id !== "string" || rawThread.parentId !== parentId) continue;
          if (typeof rawThread.role !== "string" || typeof rawThread.prompt !== "string" || typeof rawThread.model !== "string") continue;
          const thread = { ...rawThread } as ThreadSnapshot;
          const agent = rawThread.roleDefinition === undefined ? undefined : restorePersistedAgent(rawThread.roleDefinition);
          if (rawThread.roleDefinition !== undefined && !agent) continue;
          const thinking = rawThread.thinking === undefined
            ? undefined
            : typeof rawThread.thinking === "string" && rawThread.thinking.trim() ? rawThread.thinking as ThinkingLevel : undefined;
          if (rawThread.thinking !== undefined && thinking === undefined) continue;
          thread.prompt = clipCharacters(thread.prompt, limits.taskCharacters);
          thread.result = typeof rawThread.result === "string" ? persistText(rawThread.result, 256 * 1024) : rawThread.result;
          thread.tools = Array.isArray(rawThread.tools) ? rawThread.tools.slice(0, 32) : [];
          thread.trace = Array.isArray(rawThread.trace) ? rawThread.trace.slice(-64) : [];
          thread.steering = Array.isArray(rawThread.steering) ? rawThread.steering.slice(-20) : [];
          thread.displayName = typeof rawThread.displayName === "string" ? rawThread.displayName : rawThread.role;
          thread.attempt = Number.isSafeInteger(rawThread.attempt) && rawThread.attempt > 0 ? rawThread.attempt : 1;
          const trustedSession = expectedSession?.(thread.id);
          const rawSession = rawThread.session && typeof rawThread.session === "object" ? rawThread.session : undefined;
          if (trustedSession && rawSession
            && (String(rawSession.id ?? trustedSession.id) !== trustedSession.id
              || String(rawSession.directory ?? trustedSession.directory) !== trustedSession.directory)) continue;
          thread.session = trustedSession ?? {
            id: `killeros-${safeSessionId(thread.id)}`,
            directory: "",
          };
          if (thread.state === "queued" || thread.state === "active") {
            thread.state = "orphaned" as SubagentThreadState;
            thread.stopReason = "parent_restarted";
          }
          const result = record.result === undefined ? undefined : restorePersistedResult(record.result, thread);
          if (record.result !== undefined && !result) continue;
          records.set(thread.id, { thread, result, agent, thinking });
        } else if (record.event === "close" && typeof record.id === "string") {
          const previous = records.get(record.id);
          if (!previous) continue;
          if (typeof record.closedAt !== "number" || !Number.isFinite(record.closedAt) || record.closedAt < 0) continue;
          previous.thread.state = "closed";
          previous.thread.evicted = true;
          previous.thread.prompt = "[closed thread prompt evicted]";
          previous.thread.result = undefined;
          previous.thread.trace = [];
          previous.thread.steering = [];
          previous.thread.handoff = undefined;
          previous.thread.timestamps = { ...previous.thread.timestamps, closedAt: record.closedAt };
          previous.result = undefined;
        }
      } catch {
        // A malformed custom entry must not prevent the parent session from starting.
        continue;
      }
    }
    return [...records.values()];
  };

  const installRestoredThreads = (restored: Array<{ thread: ThreadSnapshot; result?: SubagentTaskResult; agent?: AgentRole; thinking?: ThinkingLevel }>): void => {
    if (!restored.length) return;
    const ids = [...restored.map(({ thread }) => thread.id)];
    let idIndex = 0;
    const oldThreads = threads;
    unsubscribePersistence();
    threads = new SubagentThreadRegistry({ createId: () => ids[idIndex++] ?? `subagent-${Date.now()}` });
    attachPersistence();
    for (const entry of restored) {
      try {
        const thread = entry.thread;
        const created = (threads as any).hydrate
          ? (threads as any).hydrate(thread)
          : threads.spawn({
            parentId: thread.parentId as SubagentThreadId,
            role: thread.role,
            prompt: thread.prompt,
            model: thread.model,
            tools: thread.tools,
            capabilityBoundary: thread.capabilityBoundary,
            displayName: thread.displayName,
            attempt: thread.attempt,
            session: thread.session,
          } as any);
        threadMetadata.set(created.id, {
          displayName: thread.displayName ?? thread.role,
          attempt: thread.attempt ?? 1,
          session: thread.session ?? { id: `killeros-${safeSessionId(thread.id)}`, directory: "" },
          persistentSession: Boolean(thread.session?.directory),
          ...(entry.agent ? { agent: cloneAgentRole(entry.agent) } : {}),
          ...(entry.thinking ? { thinking: entry.thinking } : {}),
        });
        if (entry.result) saveResult(created.id, entry.result);
        if (!(threads as any).hydrate) {
          if (thread.state === "done") {
            threads.begin(created.id);
            const output = lifecycleOutput(thread.result ?? entry.result?.output);
            threads.complete(created.id, { result: output });
          } else if (thread.state === "failed") {
            threads.begin(created.id);
            threads.fail(created.id, { message: thread.failure?.message ?? entry.result?.errorMessage ?? "restored failure" });
          } else if (thread.state === "stopped" || thread.state === "orphaned") {
            threads.stop(created.id, { reason: thread.stopReason ?? "parent_restarted" });
          }
          if (thread.state === "closed") {
            if (threads.inspect(created.id)?.state === "queued") threads.begin(created.id);
            if (threads.inspect(created.id)?.state === "active") threads.stop(created.id, { reason: thread.stopReason ?? "closed" });
            threads.close(created.id);
          }
        }
      } catch {
        // Skip malformed or conflicting records and keep the rest of the board usable.
        continue;
      }
    }
    if (oldThreads !== threads && !oldThreads.isDisposed) oldThreads.dispose();
  };

  attachPersistence();
  const maxClosedThreads = Number.isSafeInteger(limits.threadRetentionRecords) && limits.threadRetentionRecords > 0
    ? limits.threadRetentionRecords
    : SUBAGENT_LIMITS.threadRetentionRecords;

  const stopActiveRuntimes = (reason: string): void => {
    for (const runtime of activeRuntimes.values()) {
      runtime.restarting = false;
      runtime.requestedReason = reason;
      runtime.handle?.stop(reason);
      runtime.controller.abort();
    }
  };

  const rememberEvictedThreads = (threadsToRemember: readonly SubagentThread[]): void => {
    for (const thread of threadsToRemember) evictedThreadParents.set(thread.id, thread.parentId);
    while (evictedThreadParents.size > maxClosedThreads) {
      const oldest = evictedThreadParents.keys().next().value;
      if (oldest === undefined) break;
      evictedThreadParents.delete(oldest);
    }
  };
  const pruneClosedThreads = (): void => {
    if (threads.isDisposed) return;
    rememberEvictedThreads(threads.pruneClosed(maxClosedThreads));
  };

  const resultBytes = (result: SubagentTaskResult): number => Buffer.byteLength([
    result.task,
    ...result.trace,
    result.stderr,
    result.output,
    result.errorMessage ?? "",
  ].join("\n"), "utf8");
  const cleanupTerminalThread = async (
    threadId: string,
    resource: ThreadResource | undefined,
    metadata: ThreadMetadata | undefined,
  ): Promise<boolean> => {
    const exits = resource
      ? await Promise.all([...resource.handles].map((handle) => waitForConfirmedProcessExit(handle, limits.processExitWaitMs)))
      : [];
    if (!exits.every(Boolean)) {
      for (const handle of resource?.handles ?? []) {
        if (!handle.hasExited) {
          void handle.exited.then(() => queueTerminalCleanup(threadId)).catch(() => {});
        }
      }
      return false;
    }
    const directory = resource?.directory ?? metadata?.session.directory;
    if ((resource?.persistent || metadata?.persistentSession) && directory) {
      await rm(directory, { recursive: true, force: true });
    }
    if (threadResources.get(threadId) === resource) threadResources.delete(threadId);
    return true;
  };
  const queueTerminalCleanup = (threadId: string): Promise<boolean> => {
    const resource = threadResources.get(threadId);
    const metadata = threadMetadata.get(threadId);
    const generation = sessionGeneration;
    const cleanup = terminalCleanupQueue.then(() => generation === sessionGeneration
      ? cleanupTerminalThread(threadId, resource, metadata)
      : false);
    terminalCleanupQueue = cleanup.then(() => undefined, () => undefined);
    return cleanup;
  };
  const waitForTerminalCleanup = async (): Promise<void> => {
    await terminalCleanupQueue;
  };
  const trimSavedResults = (): void => {
    const candidates = threads.listAll()
      .filter((thread) => ["done", "failed", "stopped"].includes(thread.state))
      .sort((left, right) => left.timestamps.createdAt - right.timestamps.createdAt);
    const retainedBytes = (): number => [...savedResults.values()].reduce((total, result) => total + resultBytes(result), 0);
    while ((savedResults.size > limits.threadRetentionRecords || retainedBytes() > limits.threadRetentionBytes) && candidates.length) {
      const candidate = candidates.shift()!;
      savedResults.delete(candidate.id);
      const current = threads.inspect(candidate.id);
      if (current && ["done", "failed", "stopped"].includes(current.state)) {
        threads.close(candidate.id);
        void queueTerminalCleanup(candidate.id).catch(() => {});
      }
    }
    pruneClosedThreads();
  };
  const saveResult = (threadId: string, result: SubagentTaskResult): void => {
    savedResults.delete(threadId);
    savedResults.set(threadId, cloneResult(result));
    trimSavedResults();
  };

  const detailsFor = (
    parentId: string,
    mode: SubagentDetails["mode"] = "single",
    scope: AgentScope = "user",
    projectAgentsDir: string | null = null,
    selectedThreadId?: string,
  ): SubagentDetails => {
    const all = threads.listAll().filter((thread) => thread.parentId === parentId);
    const visible = all.filter((thread) => thread.state !== "closed").map((thread) => threadView(thread, threadMetadata));
    const selectedClosed = selectedThreadId
      ? all.find((thread) => thread.id === selectedThreadId && thread.state === "closed")
      : undefined;
    const listed = selectedClosed ? [...visible, threadView(selectedClosed, threadMetadata)] : visible;
    const results = visible.map((thread) => {
      const result = threadResult(thread, savedResults.get(thread.id));
      result.name = threadDisplayName(thread, threadMetadata);
      result.attempt = threadAttempt(thread, threadMetadata);
      return result;
    });
    return {
      ...cloneDetails(mode, scope, projectAgentsDir, results),
      parentId,
      executionNote: persistenceWarning,
      threads: listed,
      activeThreads: visible.filter((thread) => thread.state === "active"),
      doneThreads: visible.filter((thread) => ["done", "failed", "stopped", "orphaned"].includes(thread.state)),
      selectedThreadId,
    };
  };

  const threadBoardText = (parentId: string, selectedThreadId?: string): string => {
    const details = detailsFor(parentId, "single", "user", null, selectedThreadId);
    const active = details.activeThreads ?? [];
    const done = details.doneThreads ?? [];
    const row = (thread: ThreadSnapshot): string => `- ${threadDisplayName(thread, threadMetadata)} · ${thread.role} · ${thread.id} · ${thread.state} · ${thread.prompt}`;
    const lines = [
      `parent ${parentId}`,
      `Active (${active.length})`,
      ...(active.length ? active.map(row) : ["- none"]),
      `Done (${done.length})`,
      ...(done.length ? done.map(row) : ["- none"]),
      "Controls: inspect · wait · steer · interrupt · collect · resume · close",
    ];
    if (selectedThreadId) {
      const selected = details.threads?.find((thread) => thread.id === selectedThreadId);
      if (selected) {
        lines.push(`Inspect ${selected.id}: ${selected.state}`);
        lines.push(`Name: ${threadDisplayName(selected, threadMetadata)}`);
        lines.push(`Attempt: ${threadAttempt(selected, threadMetadata)}`);
        lines.push(`Role: ${selected.role}`);
        lines.push(`Model: ${selected.model}`);
        lines.push(`Tools: ${selected.tools.join(", ")}`);
        lines.push(`Trace: ${selected.trace.length} entries`);
        if (selected.result) lines.push(`Handoff: ${selected.result}`);
        if (selected.stopReason) lines.push(`Reason: ${selected.stopReason}`);
        if (selected.evicted) lines.push("Retention: heavy thread data was evicted after close");
      }
    }
    return boundedText(lines.join("\n"), limits.toolOutputBytes, "\n\n[Thread board truncated; inspect a child thread for its bounded detail.]");
  };

  const syncThread = (threadId: SubagentThreadId, next: SubagentTaskResult, runtime?: ActiveThreadRuntime): SubagentTaskResult => {
    const effective = mergeTaskResults(runtime?.aggregate, next, limits.traceRetentionBytes, limits.stderrRetentionBytes);
    if (runtime?.requestedReason && next.status === "cancelled") effective.terminationReason = runtime.requestedReason;
    if (runtime && runtime.sessionGeneration !== sessionGeneration) return effective;
    saveResult(threadId, effective);
    let thread = threads.inspect(threadId);
    if (!thread || threads.isDisposed) return effective;
    if (thread.state === "queued" && next.status === "running") {
      thread = threads.begin(threadId);
    }
    if (thread.state !== "active") return effective;
    if (runtime && next.trace.length < runtime.traceCount) runtime.traceCount = 0;
    const from = runtime?.traceCount ?? 0;
    let retainedTraceBytes = thread.trace.reduce((total, entry) => total + Buffer.byteLength(entry.message ?? "", "utf8"), 0);
    for (const entry of next.trace.slice(from)) {
      const retained = truncateUtf8(entry, limits.traceRetentionBytes === undefined
        ? Buffer.byteLength(entry, "utf8")
        : Math.max(0, limits.traceRetentionBytes - retainedTraceBytes));
      if (retained.text) {
        threads.trace(threadId, { kind: "child", message: retained.text });
        retainedTraceBytes += Buffer.byteLength(retained.text, "utf8");
      }
    }
    if (runtime) runtime.traceCount = next.trace.length;
    const output = lifecycleOutput(effective.output);
    const handoff = output ? { summary: output } : undefined;
    thread = threads.patch(threadId, { usage: threadUsage(effective.usage), result: output, handoff });
    const restartPending = runtime?.restarting === true && ["cancelled", "complete"].includes(next.status);
    if (restartPending) return effective;
    if (effective.status === "complete") {
      threads.complete(threadId, { usage: threadUsage(effective.usage), result: output, handoff });
    } else if (effective.status === "failed") {
      threads.fail(threadId, {
        usage: threadUsage(effective.usage),
        result: output,
        handoff,
        message: effective.errorMessage ?? effective.terminationReason ?? "child failed",
        code: effective.terminationReason,
      });
    } else if (effective.status === "cancelled" || effective.status === "limited") {
      threads.stop(threadId, {
        usage: threadUsage(effective.usage),
        result: output,
        handoff,
        reason: effective.terminationReason ?? (effective.status === "limited" ? "resource_limit" : "interrupted"),
      });
    }
    return effective;
  };

  const resolveOwnedThread = (reference: string, parentId: string): ThreadSnapshot | undefined => {
    const registry = threads as any;
    const resolved = typeof registry.resolve === "function" ? registry.resolve(reference, parentId as SubagentThreadId) : undefined;
    if (resolved && resolved.parentId === parentId) return threadView(resolved, threadMetadata);
    const exact = threads.inspect(reference as SubagentThreadId);
    if (exact && exact.parentId === parentId) return threadView(exact, threadMetadata);
    const folded = reference.toLocaleLowerCase();
    return threads.listAll()
      .filter((thread) => thread.parentId === parentId)
      .map((thread) => threadView(thread, threadMetadata))
      .find((thread) => threadDisplayName(thread, threadMetadata).toLocaleLowerCase() === folded);
  };

  const terminalThread = (thread: ThreadSnapshot): boolean => ["done", "failed", "stopped", "orphaned", "closed"].includes(thread.state as string);

  const waitForThreads = async (ids: readonly string[], timeoutMs: number): Promise<SubagentWaitSummary> => {
    const startedAt = Date.now();
    const targetIds = [...ids];
    const status = (): { completed: string[]; pending: string[] } => {
      const completed: string[] = [];
      const pending: string[] = [];
      for (const id of targetIds) {
        const thread = threads.inspect(id as SubagentThreadId);
        if (thread && terminalThread(threadView(thread, threadMetadata))) completed.push(id);
        else pending.push(id);
      }
      return { completed, pending };
    };
    const initial = status();
    if (!initial.pending.length) {
      return { targetThreadIds: targetIds, completedThreadIds: initial.completed, pendingThreadIds: [], timedOut: false, waitedMs: 0 };
    }
    const registry = threads as any;
    if (typeof registry.waitForTerminal === "function") {
      const result = await registry.waitForTerminal(targetIds as SubagentThreadId[], timeoutMs);
      return {
        targetThreadIds: targetIds,
        completedThreadIds: [...(result.completedThreadIds ?? [])],
        pendingThreadIds: [...(result.pendingThreadIds ?? [])],
        timedOut: result.timedOut === true,
        waitedMs: result.waitedMs ?? Date.now() - startedAt,
      };
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let unsubscribe = (): void => {};
      const finish = (timedOut: boolean): void => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        const current = status();
        resolve({
          targetThreadIds: targetIds,
          completedThreadIds: current.completed,
          pendingThreadIds: current.pending,
          timedOut,
          waitedMs: Date.now() - startedAt,
        });
      };
      unsubscribe = threads.subscribe(() => {
        if (!status().pending.length) finish(false);
      });
      timer = setTimeout(() => finish(true), timeoutMs);
      if (!status().pending.length) finish(false);
    });
  };

  const resumeThread = (target: ThreadSnapshot, prompt: string | undefined): ThreadSnapshot => {
    const registry = threads as any;
    const previousResult = savedResults.get(target.id);
    savedResults.delete(target.id);
    if (typeof registry.resume === "function") {
      try {
        const resumed = registry.resume(target.id as SubagentThreadId, prompt);
        const metadata = threadMetadata.get(target.id);
        if (metadata) metadata.attempt += 1;
        return threadView(resumed, threadMetadata);
      } catch (error) {
        if (previousResult) saveResult(target.id, previousResult);
        throw error;
      }
    }
    try {
      const snapshots = threads.listAll().filter((thread) => thread.state !== "closed");
      const ids = snapshots.map((thread) => thread.id);
      let idIndex = 0;
      unsubscribePersistence();
      const previous = threads;
      threads = new SubagentThreadRegistry({ createId: () => ids[idIndex++]! });
      attachPersistence();
      let resumed: ThreadSnapshot | undefined;
      for (const snapshot of snapshots) {
        const metadata = threadMetadata.get(snapshot.id) ?? {
          displayName: threadDisplayName(snapshot, threadMetadata),
          attempt: threadAttempt(snapshot, threadMetadata),
          session: threadSession(snapshot, threadMetadata) ?? { id: `killeros-${safeSessionId(snapshot.id)}`, directory: "" },
          persistentSession: Boolean(threadSession(snapshot, threadMetadata)?.directory),
        };
        const nextPrompt = snapshot.id === target.id && prompt ? prompt : snapshot.prompt;
        const created = threads.spawn({
          parentId: snapshot.parentId,
          role: snapshot.role,
          prompt: nextPrompt,
          model: snapshot.model,
          tools: snapshot.tools,
          capabilityBoundary: snapshot.capabilityBoundary,
          displayName: metadata.displayName,
          attempt: snapshot.id === target.id ? metadata.attempt + 1 : metadata.attempt,
          session: metadata.session,
        } as any);
        metadata.attempt = snapshot.id === target.id ? metadata.attempt + 1 : metadata.attempt;
        threadMetadata.set(snapshot.id, metadata);
        if (snapshot.id === target.id) {
          resumed = threadView(created, threadMetadata);
          continue;
        }
        if (snapshot.state === "done") {
          threads.begin(created.id);
          threads.complete(created.id, { result: snapshot.result });
        } else if (snapshot.state === "failed") {
          threads.begin(created.id);
          threads.fail(created.id, { message: snapshot.failure?.message ?? "restored failure" });
        } else if (snapshot.state === "stopped" || snapshot.state === "orphaned") {
          threads.stop(created.id, { reason: snapshot.stopReason ?? "stopped" });
        }
      }
      if (!resumed) throw new Error(`Unknown child thread ${JSON.stringify(target.id)}`);
      if (!previous.isDisposed) previous.dispose();
      return resumed;
    } catch (error) {
      if (previousResult) saveResult(target.id, previousResult);
      throw error;
    }
  };

  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      sessionGeneration += 1;
      stopActiveRuntimes("session_start");
      threadResources.clear();
      persistenceWarning = undefined;
      unsubscribePersistence();
      threads.dispose();
      threads = new SubagentThreadRegistry();
      threadMetadata.clear();
      savedResults.clear();
      evictedThreadParents.clear();
      activeRuntimes.clear();
      attachPersistence();
      const entries = (ctx as ExtensionContext | undefined)?.sessionManager?.getEntries?.();
      if (Array.isArray(entries)) {
        const extensionContext = ctx as ExtensionContext;
        installRestoredThreads(restoreRecords(
          entries,
          parentThreadId(extensionContext),
          (threadId) => childSessionPath(extensionContext, threadId),
        ));
      }
    });
    pi.on("session_shutdown", async () => {
      sessionGeneration += 1;
      stopActiveRuntimes("session_shutdown");
      await Promise.allSettled([...backgroundBatches]);
      unsubscribePersistence();
      for (const thread of threads.listAll()) {
        if (["done", "failed", "stopped", "orphaned"].includes(thread.state as string)) {
          recordSnapshot(thread, savedResults.get(thread.id));
        }
      }
      threadResources.clear();
      threads.dispose();
      threadMetadata.clear();
      savedResults.clear();
      evictedThreadParents.clear();
    });
  }

  const toolDefinition: Parameters<ExtensionAPI["registerTool"]>[0] = {
    name: "subagent",
    label: "Subagents",
    description: `Spawn and manage named child threads. A task-only spawn creates a generic read-only child; agent may name an optional custom role from an approved agents folder or provide an inline { name, description, access, tools } role. On spawn, message aliases task. Parallel tasks with write-capable roles use one shared slot; read-only batches run concurrently up to ${limits.maxReadConcurrency}. Write-capable tasks are serialized in the shared parent worktree. Use action list, inspect, wait, steer, interrupt, collect, resume, and close to manage child handoffs.`,
    promptSnippet: "Delegate bounded work to isolated KillerOS subagents",
    promptGuidelines: [
      "Omit agent for a generic read-only child; use an approved custom role name or inline role when the task needs a specific prompt or write access.",
      "Parallel tasks with write-capable roles use one shared slot because all children share the parent worktree.",
      "Every child can load relevant skills with read and can use web_search, source_check, fetch_content, and get_search_content for external research.",
      "Default model and thinking are inherited. If the user requires one model for the batch, pass model; set thinking only when requested, and use inherit to follow the selected role default or active parent.",
      "Keep completed and stopped threads inspectable until the parent explicitly closes them.",
    ],
    parameters: createSubagentParams(limits),
    prepareArguments(args) {
      return prepareSubagentRequest(args, limits).input;
    },
    executionMode: "parallel",

    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const request = normalizeSubagentRequest(rawParams, limits);
      const parentId = parentThreadId(ctx);
      const actionDetails = (selectedThreadId?: string): SubagentDetails => detailsFor(parentId, "single", "user", null, selectedThreadId);
      const actionResult = (text: string, selectedThreadId?: string) => {
        const details = actionDetails(selectedThreadId);
        return {
          content: [{ type: "text" as const, text: boundedText(text, limits.toolOutputBytes, "\n\n[Thread action output truncated.]") }],
          details,
          usage: details.aggregateUsage,
        };
      };

      if (request.kind === "list") return actionResult(threadBoardText(parentId));
      if (request.kind === "inspect") {
        const { threadId } = request.input;
        const thread = resolveOwnedThread(threadId, parentId);
        if (!thread) {
          if (evictedThreadParents.get(threadId) === parentId) {
            return actionResult(`Thread ${threadId} was evicted from bounded retention; its heavy data is no longer available.`, threadId);
          }
          throw new Error(`Unknown child thread ${JSON.stringify(threadId)}`);
        }
        return actionResult(threadBoardText(parentId, thread.id), thread.id);
      }
      if (request.kind === "steer") {
        const { threadId, message } = request.input;
        const thread = resolveOwnedThread(threadId, parentId);
        if (!thread) throw new Error(`Unknown child thread ${JSON.stringify(threadId)}`);
        const brandedThreadId = thread.id as SubagentThreadId;
        const runtime = activeRuntimes.get(thread.id);
        const pendingCount = runtime ? runtime.steering.length : thread.steering.length;
        if (pendingCount >= MAX_RUNTIME_STEERING_MESSAGES) {
          throw new Error(`Steering queue is full (${MAX_RUNTIME_STEERING_MESSAGES} pending messages); wait for the child restart or interrupt the thread first`);
        }
        const pendingSteering = runtime
          ? [...runtime.steering, message]
          : [...thread.steering.map((entry) => entry.message), message];
        const baseTask = runtime?.task ?? thread.prompt;
        if (steeredTaskWouldExceedLimit(baseTask, pendingSteering, limits.taskCharacters)) {
          throw new Error(`Steering would exceed the ${limits.taskCharacters}-character task limit; shorten the message or wait for the child restart`);
        }
        threads.steer(brandedThreadId, message);
        if (runtime) {
          runtime.steering.push(message);
          runtime.restarting = true;
          runtime.requestedReason = "steer";
          runtime.handle?.stop("steer");
        }
        return actionResult(`Steering queued for ${threadDisplayName(thread, threadMetadata)} (${thread.id}). The child keeps the same thread and handoff record.`, thread.id);
      }
      if (request.kind === "interrupt-one" || request.kind === "interrupt-all") {
        let targets: SubagentThread[];
        if (request.kind === "interrupt-all") {
          targets = threads.listAll().filter((thread) => thread.parentId === parentId && (thread.state === "active" || thread.state === "queued"));
        } else {
          const { threadId } = request.input;
          const target = resolveOwnedThread(threadId, parentId);
          if (!target) throw new Error(`Unknown child thread ${JSON.stringify(threadId)}`);
          if (target.state !== "active" && target.state !== "queued") {
            throw new Error(`Cannot interrupt thread ${threadId} from ${target.state}`);
          }
          targets = [target];
        }
        for (const thread of targets) {
          if (thread.parentId !== parentId) continue;
          const runtime = activeRuntimes.get(thread.id);
          if (runtime) {
            runtime.restarting = false;
            runtime.requestedReason = "interrupt";
            runtime.handle?.stop("interrupt");
            runtime.controller.abort();
          } else if (thread.state === "active" || thread.state === "queued") {
            threads.stop(thread.id, { reason: "interrupt" });
          }
        }
        return actionResult(request.kind === "interrupt-all"
          ? "Interrupt requested for all active and queued child threads."
          : `Interrupt requested for ${targets[0]?.id} (${threadDisplayName(targets[0] as ThreadSnapshot, threadMetadata)}).`);
      }
      if (request.kind === "collect") {
        const { threadId } = request.input;
        const thread = resolveOwnedThread(threadId, parentId);
        if (!thread) throw new Error(`Unknown child thread ${JSON.stringify(threadId)}`);
        const collected = threads.collect(thread.id as SubagentThreadId);
        return actionResult(`Collected ${threadDisplayName(thread, threadMetadata)} (${thread.id}): ${collected.result ?? collected.failure?.message ?? collected.stopReason ?? "no handoff"}`, thread.id);
      }
      if (request.kind === "wait") {
        const target = request.input.threadId ? resolveOwnedThread(request.input.threadId, parentId) : undefined;
        if (request.input.threadId && !target) throw new Error(`Unknown child thread ${JSON.stringify(request.input.threadId)}`);
        const targets = target
          ? [target]
          : threads.listAll().filter((thread) => thread.parentId === parentId && (thread.state === "queued" || thread.state === "active"));
        const wait = await waitForThreads(targets.map((thread) => thread.id), request.input.timeoutMs);
        const details = actionDetails(target?.id);
        details.wait = wait;
        return {
          content: [{ type: "text" as const, text: boundedText(
            wait.timedOut
              ? `Wait timed out after ${wait.waitedMs}ms. Pending: ${wait.pendingThreadIds.join(", ") || "none"}.`
              : `Wait complete after ${wait.waitedMs}ms. Completed: ${wait.completedThreadIds.join(", ") || "none"}.`,
            limits.toolOutputBytes,
            "\n\n[Thread action output truncated.]",
          ) }],
          details,
          usage: details.aggregateUsage,
        };
      }
      if (request.kind === "close") {
        const { threadId } = request.input;
        const thread = resolveOwnedThread(threadId, parentId);
        if (!thread) throw new Error(`Unknown child thread ${JSON.stringify(threadId)}`);
        if (thread.state === "queued" || thread.state === "active") {
          throw new Error(`Cannot close thread ${thread.id} from ${thread.state}`);
        }
        const exitConfirmed = await queueTerminalCleanup(thread.id);
        if (!exitConfirmed) {
          const current = savedResults.get(thread.id);
          if (current) {
            const failed = cloneResult(current);
            failed.status = "failed";
            failed.terminationReason = "process_exit_unconfirmed";
            failed.exitConfirmed = false;
            failed.errorMessage = "Child process exit was not confirmed before close";
            saveResult(thread.id, failed);
            recordSnapshot(thread, failed);
          }
        }
        threads.close(thread.id as SubagentThreadId);
        savedResults.delete(thread.id);
        pruneClosedThreads();
        return actionResult(exitConfirmed
          ? `Closed ${threadDisplayName(thread, threadMetadata)} (${thread.id}). Heavy trace and handoff data were evicted; a tombstone remains inspectable.`
          : `Closed ${threadDisplayName(thread, threadMetadata)} (${thread.id}); process exit was not confirmed, so its session directory was retained.`, thread.id);
      }

      let resumeTarget: ThreadSnapshot | undefined;
      let resumePrompt: string | undefined;
      let resumeAgent: AgentRole | undefined;
      const parentTools = activeParentTools(pi);
      const isResume = request.kind === "resume";
      if (isResume) {
        const target = resolveOwnedThread(request.input.threadId, parentId);
        if (!target) throw new Error(`Unknown child thread ${JSON.stringify(request.input.threadId)}`);
        if (!terminalThread(target) || target.state === "closed") {
          throw new Error(`Cannot resume thread ${target.id} from ${target.state}`);
        }
        resumeAgent = threadMetadata.get(target.id)?.agent;
        if (!resumeAgent && target.role === "generic") resumeAgent = genericAgentRole(parentTools);
        if (!resumeAgent && savedResults.get(target.id)?.agentSource === "inline") {
          throw new Error(`Cannot resume inline role ${JSON.stringify(target.role)}; inline roles are scoped to one spawn`);
        }
        resumePrompt = request.input.task;
        resumeTarget = target;
      }
      const spawnRequest = (isResume
        ? {
          kind: "spawn-single",
          input: {
            agent: resumeAgent ?? resumeTarget!.role,
            task: resumePrompt ?? resumeTarget!.prompt,
            model: resumeTarget!.model,
            ...(threadMetadata.get(resumeTarget!.id)?.thinking
              ? { thinking: threadMetadata.get(resumeTarget!.id)!.thinking }
              : {}),
          },
        }
        : request) as Extract<NormalizedSubagentRequest, { kind: "spawn-single" | "spawn-parallel" | "spawn-chain" }>;
      const params = spawnRequest.input;
      const scope: AgentScope = params.agentScope ?? "user";
      const hasParallel = spawnRequest.kind === "spawn-parallel";
      const hasChain = spawnRequest.kind === "spawn-chain";
      const writerConcurrencyOverride = hasParallel ? spawnRequest.input.writerConcurrency : undefined;

      const discovery = discoverAgentRoles(ctx.cwd, scope, ctx.isProjectTrusted(), options);
      const roles = new Map(discovery.agents.map((agent) => [agent.name, agent]));
      const rawInputs: TaskInput[] = spawnRequest.kind === "spawn-single"
        ? [{ agent: spawnRequest.input.agent, task: spawnRequest.input.task, ...(spawnRequest.input.name ? { name: spawnRequest.input.name } : {}) }]
        : spawnRequest.kind === "spawn-parallel" ? spawnRequest.input.tasks : spawnRequest.input.chain;
      const rolesForInputs = rawInputs.map((input) => {
        if (isResume && resumeAgent && input.agent === resumeAgent) {
          const role = cloneAgentRole(resumeAgent);
          validateAgentTools(role, parentTools);
          return role;
        }
        if (input.agent === undefined) return genericAgentRole(parentTools);
        if (typeof input.agent !== "string") {
          const role = inlineAgentRole(input.agent);
          validateAgentTools(role, parentTools);
          return role;
        }
        const selected = roles.get(input.agent);
        if (selected) return selected;
        const available = discovery.agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
        throw new Error(`Unknown custom subagent ${JSON.stringify(input.agent)}. Available: ${available}`);
      });
      rolesForInputs.forEach((role) => validateAgentTools(role, parentTools));
      const inputs: Array<Omit<TaskInput, "agent"> & { agent: string }> = rawInputs.map((input, index) => ({
        ...input,
        agent: rolesForInputs[index]!.name,
      }));

      const projectRoles = [...new Set(rolesForInputs.filter((role) => role.source === "project"))];
      if (projectRoles.length) {
        if (!ctx.hasUI) throw new Error("Project-local subagents require interactive confirmation");
        const approved = await ctx.ui.confirm(
          "Run project-local subagents?",
          `Roles: ${projectRoles.map((role) => role.name).join(", ")}\nSources:\n${projectRoles.map((role) => role.filePath).join("\n")}\n\nThese trusted repository files control child prompts and tools.`,
        );
        if (!approved) throw new Error("Project-local subagents were not approved");
      }

      const resolvedModels = rolesForInputs.map((role) => resolveAgentModel(role, ctx, params.model, params.thinking));

      const mode: SubagentDetails["mode"] = hasParallel ? "parallel" : hasChain ? "chain" : "single";
      if (inputs.length > limits.maxTasks) throw new Error(`At most ${limits.maxTasks} subagent tasks are allowed`);
      const readIndexes = hasParallel
        ? inputs.map((input, index) => ({ input, index })).filter(({ index }) => rolesForInputs[index]!.access === "read")
        : [];
      const writerIndexes = hasParallel
        ? inputs.map((input, index) => ({ input, index })).filter(({ index }) => rolesForInputs[index]!.access === "write").map(({ index }) => index)
        : [];
      if (writerConcurrencyOverride !== undefined && writerIndexes.length === 0) {
        throw new Error("writerConcurrency requires at least one write-capable role");
      }
      if (writerIndexes.length > 0 && writerConcurrencyOverride !== undefined && writerConcurrencyOverride > 1) {
        throw new Error("writerConcurrency above 1 is not allowed for write-capable tasks because child threads share the parent worktree; use 1");
      }
      const writerConcurrency = writerConcurrencyOverride ?? (writerIndexes.length > 0 ? 1 : limits.maxReadConcurrency);
      const useSharedParallelPool = hasParallel && writerIndexes.length > 0;
      const scheduleNote = hasParallel
        ? writerIndexes.length
          ? `Parallel schedule: all tasks run through a shared pool of up to ${writerConcurrency}${writerConcurrencyOverride === undefined ? " (safe default)" : " (explicit)"}. Write-capable tasks are serialized in the shared parent worktree.`
          : `Parallel schedule: read-only tasks run concurrently up to ${limits.maxReadConcurrency}.`
        : undefined;
      const executionNote = scheduleNote;

      const inFlight = threads.listAll().filter((thread) => ["queued", "active"].includes(thread.state)).length;
      if (inFlight + inputs.length > limits.maxTasks) {
        throw new Error(`At most ${limits.maxTasks} child threads may be active at once`);
      }

      const existingThreads = threads.listAll().filter((thread) => thread.parentId === parentId).map((thread) => threadView(thread, threadMetadata));
      const allocatedNames = new Set<string>();
      if (isResume) {
        resumeTarget = resumeThread(resumeTarget!, resumePrompt);
        const metadata = threadMetadata.get(resumeTarget.id);
        if (metadata) {
          metadata.agent = cloneAgentRole(rolesForInputs[0]!);
          metadata.thinking = resolvedModels[0]!.thinking;
        }
      }
      const threadRecords = isResume
        ? [resumeTarget!]
        : inputs.map((input, index) => {
        const allocated = [...allocatedNames].map((name) => ({ role: name, displayName: name } as ThreadSnapshot));
        const displayName = input.name ?? defaultThreadName(input.agent, [...existingThreads, ...allocated]);
        validateThreadName(displayName);
        const duplicate = [...existingThreads, ...allocated]
          .some((thread) => threadDisplayName(thread, threadMetadata).toLocaleLowerCase() === displayName.toLocaleLowerCase());
        if (duplicate) throw new Error(`Child display name ${JSON.stringify(displayName)} already exists for this parent`);
        allocatedNames.add(displayName.toLocaleLowerCase());
        const thread = threads.spawn({
          parentId: parentId as SubagentThreadId,
          role: input.agent,
          prompt: input.task,
          model: resolvedModels[index]!.model,
          tools: rolesForInputs[index]!.tools,
          capabilityBoundary: threadCapabilityBoundary(rolesForInputs[index]!),
          displayName,
          attempt: 1,
          session: { id: "killeros-pending", directory: path.join(os.tmpdir(), "killeros-subagent-pending") },
        } as any);
        const session = childSessionPath(ctx, thread.id) ?? { id: `killeros-${safeSessionId(thread.id)}`, directory: "" };
        threadMetadata.set(thread.id, {
          displayName,
          attempt: 1,
          session,
          persistentSession: Boolean(session.directory),
          agent: cloneAgentRole(rolesForInputs[index]!),
          thinking: resolvedModels[index]!.thinking,
        });
        recordSpawn(thread);
        return thread;
      });
      const results = threadRecords.map((thread, index) => {
        const metadata = threadMetadata.get(thread.id)!;
        return makeQueuedResult(thread.id, inputs[index]!.agent, inputs[index]!.task, hasChain ? index + 1 : undefined, metadata.displayName, metadata.attempt);
      });
      const batchSessionGeneration = sessionGeneration;
      const liveWidgetKey = `killeros-subagents:${results[0]!.id}`;
      const showLiveWidget = options.awaitSpawnCompletion !== true && ctx.hasUI;
      const updateLiveWidget = (currentResults: SubagentTaskResult[]): void => {
        if (!showLiveWidget) return;
        const board = formatThreadBoard({
          title: `Subagents · ${mode} · live`,
          threads: currentResults.map(threadBoardRecord),
        });
        const row = (task: (typeof board.active)[number]): string => `${task.state.label} · ${task.displayName ?? task.agent} · ${task.usage.text}`;
        try {
          ctx.ui.setWidget(liveWidgetKey, [
            board.title,
            `Active (${board.active.length})`,
            ...(board.active.length ? board.active.map(row) : ["None"]),
            `Done (${board.done.length})`,
            ...(board.done.length ? board.done.map(row) : ["None"]),
            `Total · ${formatUsage(aggregateUsage(currentResults))}`,
          ]);
        } catch {
          // Live UI updates must not fail the child batch.
        }
      };
      const clearLiveWidget = (): void => {
        if (!showLiveWidget) return;
        try {
          ctx.ui.setWidget(liveWidgetKey, undefined);
        } catch {
          // The session may close before the child batch settles.
        }
      };
      let updatesOpen = true;
      const emit = (message = `${mode}: ${results.filter((result) => !["queued", "running"].includes(result.status)).length}/${results.length} settled`): void => {
        if (batchSessionGeneration !== sessionGeneration) return;
        const board = detailsFor(parentId, mode, scope, discovery.projectAgentsDir, isResume ? resumeTarget?.id : undefined);
        const currentResults = results.map(cloneResult);
        updateLiveWidget(currentResults);
        if (!updatesOpen) return;
        try {
          (onUpdate as ToolUpdate | undefined)?.({
            content: [{ type: "text", text: message }],
            details: { ...board, executionNote, results: currentResults, aggregateUsage: aggregateUsage(currentResults) },
          });
        } catch {
          // Host update callbacks are telemetry; failures must not fail the batch.
        }
      };
      const failQueuedTask = (index: number, reason: string, message: string): void => {
        if (batchSessionGeneration !== sessionGeneration) return;
        const threadId = threadRecords[index]!.id;
        const thread = threads.inspect(threadId);
        if (thread?.state === "queued") threads.begin(threadId);
        results[index] = {
          ...results[index]!,
          status: "failed",
          terminationReason: reason,
          errorMessage: message,
        };
        if (threads.inspect(threadId)?.state === "active") threads.fail(threadId, { message, code: reason });
        saveResult(threadId, results[index]!);
        emit();
      };
      const runAt = async (index: number, task: string): Promise<void> => {
        if (batchSessionGeneration !== sessionGeneration) {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: "session_start" };
          return;
        }
        const threadId = threadRecords[index]!.id;
        const initialThread = threads.inspect(threadId);
        if (signal?.aborted) {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: "abort" };
          if (initialThread?.state === "queued" || initialThread?.state === "active") threads.stop(threadId, { reason: "abort" });
          saveResult(threadId, results[index]!);
          emit();
          return;
        }
        if (!initialThread) return;
        if (initialThread.state === "closed") {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: initialThread.stopReason ?? "disposed" };
          saveResult(threadId, results[index]!);
          emit();
          return;
        }
        if (initialThread.state === "stopped") {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: initialThread.stopReason ?? "interrupted" };
          saveResult(threadId, results[index]!);
          emit();
          return;
        }
        if (initialThread.state !== "queued") return;
        const input = inputs[index]!;
        threads.begin(threadId);
        const queuedSteering = initialThread.steering.map((entry) => entry.message);
        if (codePointLength(task) > limits.taskCharacters) {
          failQueuedTask(index, "task_limit", `Expanded task exceeds ${limits.taskCharacters} characters`);
          return;
        }
        if (steeredTaskWouldExceedLimit(task, queuedSteering, limits.taskCharacters)) {
          failQueuedTask(index, "steering_task_limit", `Expanded task plus steering exceeds ${limits.taskCharacters} characters`);
          return;
        }
        const controller = new AbortController();
        const runtime: ActiveThreadRuntime = {
          controller,
          handles: new Set(),
          task,
          steering: [],
          restarting: false,
          traceCount: 0,
          startedAt: Date.now(),
          sessionGeneration: batchSessionGeneration,
          aggregate: isResume ? savedResults.get(threadId) && cloneResult(savedResults.get(threadId)!) : undefined,
        };
        const abortFromParent = (): void => {
          runtime.restarting = false;
          runtime.requestedReason = "abort";
          runtime.handle?.stop("abort");
          controller.abort();
        };
        signal?.addEventListener("abort", abortFromParent, { once: true });
        if (signal?.aborted) abortFromParent();
        activeRuntimes.set(threadId, runtime);
        let sessionDirectory: string;
        let persistentSession = false;
        try {
          const metadata = threadMetadata.get(threadId)!;
          if (metadata.persistentSession && metadata.session.directory) {
            sessionDirectory = metadata.session.directory;
            await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
            persistentSession = true;
          } else {
            sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "killeros-subagent-session-"));
          }
          const existingResource = threadResources.get(threadId);
          threadResources.set(threadId, existingResource ?? { directory: sessionDirectory, persistent: persistentSession, handles: new Set() });
          const resource = threadResources.get(threadId)!;
          resource.directory = sessionDirectory;
          resource.persistent = persistentSession || resource.persistent;
        } catch (error) {
          signal?.removeEventListener("abort", abortFromParent);
          if (activeRuntimes.get(threadId) === runtime) activeRuntimes.delete(threadId);
          if (runtime.sessionGeneration !== sessionGeneration) {
            results[index] = { ...results[index]!, status: "cancelled", terminationReason: runtime.requestedReason ?? "session_start" };
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          results[index] = {
            ...results[index]!,
            status: "failed",
            terminationReason: "session_error",
            errorMessage: message,
          };
          threads.fail(threadId, { message, code: "session_error" });
          saveResult(threadId, results[index]!);
          emit();
          return;
        }
        const currentThread = threads.inspect(threadId);
        if (controller.signal.aborted || threads.isDisposed || currentThread?.state !== "active") {
          signal?.removeEventListener("abort", abortFromParent);
          if (activeRuntimes.get(threadId) === runtime) activeRuntimes.delete(threadId);
          if (!persistentSession) {
            try {
              await rm(sessionDirectory, { recursive: true, force: true });
            } catch {
              // Temporary child session cleanup is best effort before process startup.
            }
          }
          if (runtime.sessionGeneration !== sessionGeneration) {
            results[index] = { ...results[index]!, status: "cancelled", terminationReason: runtime.requestedReason ?? "session_start" };
            return;
          }
          const reason = runtime.requestedReason ?? currentThread?.stopReason ?? (threads.isDisposed ? "session_shutdown" : "interrupted");
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: reason };
          if (!threads.isDisposed && currentThread?.state === "active") threads.stop(threadId, { reason });
          saveResult(threadId, results[index]!);
          emit();
          return;
        }
        const metadata = threadMetadata.get(threadId)!;
        const sessionId = metadata.session.id;
        const agent = rolesForInputs[index]!;
        let currentTask = queuedSteering.length ? buildSteeredTask(task, queuedSteering, limits.taskCharacters) : task;
        const stopForBudget = (reason: string, message: string): void => {
          if (runtime.sessionGeneration !== sessionGeneration) return;
          const limited = cloneResult(runtime.aggregate ?? results[index]!);
          limited.status = "limited";
          limited.terminationReason = reason;
          limited.errorMessage = message;
          runtime.aggregate = limited;
          results[index] = cloneResult(limited);
          saveResult(threadId, limited);
          if (!threads.isDisposed && threads.inspect(threadId)?.state === "active") {
            const output = lifecycleOutput(limited.output);
            threads.stop(threadId, {
              usage: threadUsage(limited.usage),
              result: output,
              handoff: output ? { summary: output } : undefined,
              reason,
            });
          }
          emit();
        };
        try {
          while (true) {
            const aggregate = runtime.aggregate;
            const wallTimeMs = limits.wallTimeMs ?? agent.timeoutMs ?? limits.defaultWallTimeMs;
            const remainingWallTimeMs = wallTimeMs === undefined ? undefined : wallTimeMs - (Date.now() - runtime.startedAt);
            const usedTraceBytes = (aggregate?.traceBytes ?? 0) + (aggregate?.traceTruncatedBytes ?? 0);
            const usedStderrBytes = aggregate?.stderrBytes ?? 0;
            const usedOutputBytes = aggregate?.outputBytes ?? 0;
            const usedTokens = aggregate?.usage.totalTokens ?? 0;
            const usedCost = aggregate?.usage.cost.total ?? 0;
            const usedTurns = aggregate?.usage.turns ?? 0;
            const maxTurns = limits.maxTurns ?? limits.defaultMaxTurns;
            const quotaTokens = limits.quotaTokens ?? limits.defaultQuotaTokens;
            if (remainingWallTimeMs !== undefined && remainingWallTimeMs <= 0) {
              stopForBudget("wall_time_limit", `Child thread exceeds ${wallTimeMs} ms`);
              break;
            }
            if (limits.traceBytes !== undefined && usedTraceBytes >= limits.traceBytes) {
              stopForBudget("trace_limit", `Child thread retains more than ${limits.traceBytes} trace bytes`);
              break;
            }
            if (limits.stderrBytes !== undefined && usedStderrBytes >= limits.stderrBytes) {
              stopForBudget("stderr_limit", `Child thread emits more than ${limits.stderrBytes} stderr bytes`);
              break;
            }
            if (limits.taskOutputBytes !== undefined && usedOutputBytes >= limits.taskOutputBytes) {
              stopForBudget("output_limit", `Child thread emits more than ${limits.taskOutputBytes} output bytes`);
              break;
            }
            if (usedTurns >= maxTurns) {
              stopForBudget("turn_limit", `Child thread reaches ${maxTurns} turns`);
              break;
            }
            if (usedTokens >= quotaTokens) {
              stopForBudget("quota_tokens", `Child thread reaches ${quotaTokens} tokens`);
              break;
            }
            if (limits.quotaUsd !== undefined && usedCost >= limits.quotaUsd) {
              stopForBudget("quota_cost", `Child thread exceeds $${limits.quotaUsd}`);
              break;
            }
            runtime.traceCount = 0;
            const next = await runTask({
              cwd: ctx.cwd,
              agent,
              task: currentTask,
              id: results[index]!.id,
              displayName: metadata.displayName,
              attempt: metadata.attempt,
              step: results[index]!.step,
              model: resolvedModels[index]!,
              signal: controller.signal,
              webExtension: options.webExtension,
              projectTrusted: ctx.isProjectTrusted(),
              spawnProcess,
              sessionDirectory,
              sessionId,
              limits: {
                ...limits,
                ...(limits.traceBytes === undefined ? {} : { traceBytes: limits.traceBytes - usedTraceBytes }),
                ...(limits.stderrBytes === undefined ? {} : { stderrBytes: limits.stderrBytes - usedStderrBytes }),
                ...(limits.taskOutputBytes === undefined ? {} : { taskOutputBytes: limits.taskOutputBytes - usedOutputBytes }),
                maxTurns: maxTurns - usedTurns,
                quotaTokens: quotaTokens - usedTokens,
                ...(limits.quotaUsd === undefined ? {} : { quotaUsd: limits.quotaUsd - usedCost }),
              },
              timeoutMs: remainingWallTimeMs,
              onHandle: (handle) => {
                runtime.handle = handle;
                runtime.handles.add(handle);
                threadResources.get(threadId)?.handles.add(handle);
              },
              onChange: (changed) => {
                results[index] = syncThread(threadId, changed, runtime);
                emit();
              },
            });
            next.task = task;
            runtime.aggregate = mergeTaskResults(runtime.aggregate, next, limits.traceRetentionBytes, limits.stderrRetentionBytes);
            runtime.aggregate.task = task;
            if (next.status === "cancelled" && runtime.requestedReason !== undefined) {
              runtime.aggregate.terminationReason = runtime.requestedReason;
            }
            results[index] = cloneResult(runtime.aggregate);
            if (runtime.sessionGeneration === sessionGeneration) saveResult(threadId, runtime.aggregate);
            const shouldRestart = runtime.sessionGeneration === sessionGeneration
              && runtime.steering.length > 0
              && !controller.signal.aborted
              && (runtime.restarting || next.status === "complete" || next.status === "cancelled");
            if (!shouldRestart) break;
            const previousHandle = runtime.handle;
            if (previousHandle && !(await waitForConfirmedProcessExit(previousHandle))) {
              if (runtime.sessionGeneration !== sessionGeneration || controller.signal.aborted || threads.isDisposed) {
                const cancelled = cloneResult(runtime.aggregate ?? results[index]!);
                cancelled.status = "cancelled";
                cancelled.terminationReason = runtime.requestedReason ?? (threads.isDisposed ? "session_shutdown" : "abort");
                runtime.aggregate = cancelled;
                results[index] = cloneResult(cancelled);
                if (runtime.sessionGeneration === sessionGeneration) {
                  saveResult(threadId, cancelled);
                  if (!threads.isDisposed && threads.inspect(threadId)?.state === "active") {
                    const output = lifecycleOutput(cancelled.output);
                    threads.stop(threadId, {
                      usage: threadUsage(cancelled.usage),
                      result: output,
                      handoff: output ? { summary: output } : undefined,
                      reason: cancelled.terminationReason,
                    });
                  }
                  emit();
                }
                break;
              }
              const message = "Child process exit was not confirmed before the steering restart";
              const unconfirmed = cloneResult(runtime.aggregate ?? results[index]!);
              unconfirmed.status = "failed";
              unconfirmed.terminationReason = "process_exit_unconfirmed";
              unconfirmed.errorMessage = message;
              runtime.aggregate = unconfirmed;
              results[index] = cloneResult(unconfirmed);
              if (runtime.sessionGeneration === sessionGeneration) saveResult(threadId, unconfirmed);
              if (runtime.sessionGeneration === sessionGeneration && !threads.isDisposed && threads.inspect(threadId)?.state === "active") {
                const output = lifecycleOutput(unconfirmed.output);
                threads.fail(threadId, {
                  usage: threadUsage(unconfirmed.usage),
                  result: output,
                  handoff: output ? { summary: output } : undefined,
                  message,
                  code: "process_exit_unconfirmed",
                });
              }
              emit();
              break;
            }
            if (runtime.sessionGeneration !== sessionGeneration || controller.signal.aborted || threads.isDisposed) break;
            const steering = runtime.steering.splice(0);
            runtime.restarting = false;
            runtime.requestedReason = undefined;
            if (!threads.isDisposed && threads.inspect(threadId)?.state === "active") {
              const output = lifecycleOutput(runtime.aggregate.output);
              threads.patch(threadId, {
                usage: threadUsage(runtime.aggregate.usage),
                result: output,
                handoff: output ? { summary: output } : undefined,
              });
            }
            if (steeredTaskWouldExceedLimit(task, steering, limits.taskCharacters)) {
              const failed = cloneResult(runtime.aggregate ?? results[index]!);
              failed.status = "failed";
              failed.terminationReason = "steering_task_limit";
              failed.errorMessage = `Expanded task plus steering exceeds ${limits.taskCharacters} characters`;
              runtime.aggregate = failed;
              results[index] = cloneResult(failed);
              if (runtime.sessionGeneration === sessionGeneration) {
                saveResult(threadId, failed);
                if (!threads.isDisposed && threads.inspect(threadId)?.state === "active") {
                  const output = lifecycleOutput(failed.output);
                  threads.fail(threadId, {
                    usage: threadUsage(failed.usage),
                    result: output,
                    handoff: output ? { summary: output } : undefined,
                    message: failed.errorMessage,
                    code: failed.terminationReason,
                  });
                }
                emit();
              }
              break;
            }
            currentTask = buildSteeredTask(task, steering, limits.taskCharacters);
          }
        } finally {
          signal?.removeEventListener("abort", abortFromParent);
          if (activeRuntimes.get(threadId) === runtime) activeRuntimes.delete(threadId);
          const handles = [...runtime.handles];
          const exitStates = await Promise.all(handles.map((handle) => waitForConfirmedProcessExit(handle, limits.processExitWaitMs)));
          const allExited = exitStates.every(Boolean);
          if (!allExited) {
            const unconfirmed = cloneResult(runtime.aggregate ?? results[index]!);
            const requestedReason = runtime.requestedReason;
            const strongReasons = new Set(["abort", "interrupt", "session_start", "session_shutdown", "malformed_jsonl", "invalid_usage", "spawn_error"]);
            if (!requestedReason || !strongReasons.has(requestedReason)) {
              unconfirmed.status = "failed";
              unconfirmed.terminationReason = "process_exit_unconfirmed";
              unconfirmed.errorMessage = "Child process exit was not confirmed before cleanup";
            }
            unconfirmed.exitConfirmed = false;
            runtime.aggregate = unconfirmed;
            results[index] = cloneResult(unconfirmed);
            if (runtime.sessionGeneration === sessionGeneration) {
              saveResult(threadId, unconfirmed);
              const current = threads.inspect(threadId);
              if (current?.state === "active") {
                if (unconfirmed.status === "failed") {
                  const output = lifecycleOutput(unconfirmed.output);
                  threads.fail(threadId, {
                    usage: threadUsage(unconfirmed.usage),
                    result: output,
                    handoff: output ? { summary: output } : undefined,
                    message: unconfirmed.errorMessage ?? "Child process exit was not confirmed before cleanup",
                    code: unconfirmed.terminationReason,
                  });
                } else {
                  threads.stop(threadId, { reason: unconfirmed.terminationReason ?? "process_exit_unconfirmed" });
                }
              }
              emit();
            }
          } else if (!persistentSession) {
            try {
              await rm(sessionDirectory, { recursive: true, force: true });
            } catch {
              // Temporary child session cleanup is best effort after process termination.
            }
          }
          if (allExited && runtime.sessionGeneration === sessionGeneration) threadResources.delete(threadId);
        }
        emit();
      };

      const settleQueued = (reason: string): void => {
        if (batchSessionGeneration !== sessionGeneration) {
          for (const result of results) {
            if (result.status === "queued") {
              result.status = "cancelled";
              result.terminationReason = "session_start";
            }
          }
          return;
        }
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]!;
          if (result.status !== "queued") continue;
          const thread = threads.inspect(threadRecords[index]!.id);
          const alreadyStopped = thread?.state === "stopped";
          result.status = signal?.aborted || alreadyStopped || reason === "chain_stopped" ? "cancelled" : "failed";
          result.terminationReason = alreadyStopped
            ? thread.stopReason ?? "interrupted"
            : signal?.aborted ? "abort" : reason;
          if (thread?.state === "queued" || thread?.state === "active") {
            threads.stop(threadRecords[index]!.id, { reason: result.terminationReason });
          }
          saveResult(threadRecords[index]!.id, result);
        }
      };

      const finishBatch = async () => {
        if (hasChain) {
          let previous = "";
          for (let index = 0; index < inputs.length; index += 1) {
            const task = expandChainTask(inputs[index]!.task, previous, limits.taskCharacters);
            if (task === undefined) {
              failQueuedTask(index, "task_limit", `Expanded task exceeds ${limits.taskCharacters} characters`);
              break;
            }
            await runAt(index, task);
            if (results[index]!.status !== "complete") break;
            previous = results[index]!.output;
          }
          settleQueued("chain_stopped");
        } else if (hasParallel) {
          try {
            if (useSharedParallelPool) {
              const indexes = inputs.map((_, index) => index);
              await mapReadTasks(indexes, writerConcurrency, async (index) => runAt(index, inputs[index]!.task));
            } else {
              await mapReadTasks(readIndexes, limits.maxReadConcurrency, async ({ index }) => runAt(index, inputs[index]!.task));
              for (const index of writerIndexes) await runAt(index, inputs[index]!.task);
            }
          } finally {
            settleQueued("parallel_stopped");
          }
        } else {
          await runAt(0, inputs[0]!.task);
        }

        await waitForTerminalCleanup();
        const board = detailsFor(parentId, mode, scope, discovery.projectAgentsDir, isResume ? resumeTarget?.id : undefined);
        const currentResults = results.map(cloneResult);
        const details: SubagentDetails = { ...board, executionNote, results: currentResults, aggregateUsage: aggregateUsage(currentResults) };
        const toolContent = buildToolContent(mode, details.results, limits.toolOutputBytes);
        return {
          content: [{
            type: "text" as const,
            text: executionNote
              ? boundedText(`${executionNote}\n\n${toolContent}`, limits.toolOutputBytes, "\n\n[Spawn output truncated.]")
              : toolContent,
          }],
          details,
          usage: details.aggregateUsage,
        };
      };

      emit(`${mode}: ${results.length} queued`);
      if (options.awaitSpawnCompletion === true) {
        const foregroundBatch = finishBatch();
        backgroundBatches.add(foregroundBatch);
        try {
          return await foregroundBatch;
        } finally {
          backgroundBatches.delete(foregroundBatch);
        }
      }

      const queuedBoard = detailsFor(parentId, mode, scope, discovery.projectAgentsDir, isResume ? resumeTarget?.id : undefined);
      const queuedResults = results.map(cloneResult);
      const queuedDetails: SubagentDetails = {
        ...queuedBoard,
        backgroundStarted: true,
        executionNote,
        results: queuedResults,
        aggregateUsage: aggregateUsage(queuedResults),
      };
      const threadList = threadRecords.map((thread) => `${threadDisplayName(threadView(thread, threadMetadata), threadMetadata)} (${thread.id})`).join(", ");
      const reportUndeliveredFollowUp = (outcome: "settled" | "failed"): void => {
        if (!ctx.hasUI) return;
        try {
          ctx.ui.notify(`Subagent batch ${outcome}, but its follow-up could not be delivered. Use list or collect for the saved result.`, "warning");
        } catch {
          // The thread registry still retains the result when the UI is closing.
        }
      };
      updatesOpen = false;
      const backgroundBatch = finishBatch().then((completed) => {
        if (batchSessionGeneration !== sessionGeneration
          || threads.isDisposed
          || signal?.aborted
          || completed.details.results.some((result) => result.terminationReason === "abort")) return;
        try {
          pi.sendMessage({
            customType: "killeros-subagent-settled",
            content: `Subagent batch settled: ${threadList}\n\n${completed.content[0].text}`,
            display: true,
          }, { triggerTurn: true, deliverAs: "followUp" });
        } catch {
          reportUndeliveredFollowUp("settled");
        }
      }).catch((error) => {
        if (batchSessionGeneration !== sessionGeneration || threads.isDisposed || signal?.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        try {
          pi.sendMessage({
            customType: "killeros-subagent-settled",
            content: `Subagent batch failed: ${threadList}\n\n${message}`,
            display: true,
          }, { triggerTurn: true, deliverAs: "followUp" });
        } catch {
          reportUndeliveredFollowUp("failed");
        }
      }).finally(clearLiveWidget);
      backgroundBatches.add(backgroundBatch);
      void backgroundBatch.finally(() => backgroundBatches.delete(backgroundBatch));
      return {
        content: [{
          type: "text",
          text: boundedText(`${executionNote ? `${executionNote}\n\n` : ""}${isResume ? "Resumed" : "Started"} child threads: ${threadList}. They continue in the background. Live progress appears above the editor while they run; use list, inspect, wait, steer, interrupt, collect, resume, or close for current details.`, limits.toolOutputBytes, "\n\n[Spawn output truncated.]"),
        }],
        details: queuedDetails,
        usage: queuedDetails.aggregateUsage,
      };
    },

    renderCall(args, theme) {
      let renderArgs = args;
      try {
        renderArgs = prepareSubagentRequest(args, limits).input;
      } catch {
        // Strict rendering below displays malformed requests as invalid.
      }
      const parsed = tryNormalizeSubagentRequest(renderArgs, limits);
      if (!parsed.ok) {
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))}${theme.fg("error", " · invalid request")}`, 0, 0);
      }
      const request = parsed.request;
      if (!request.kind.startsWith("spawn-")) {
        const threadId = "threadId" in request.input ? request.input.threadId : undefined;
        return new Text(`${theme.fg("toolTitle", theme.bold("threads "))}${theme.fg("accent", request.input.action ?? "spawn")}${theme.fg("dim", threadId ? ` · ${threadId}` : "")}`, 0, 0);
      }
      const spawnRequest = request as Extract<NormalizedSubagentRequest, { kind: "spawn-single" | "spawn-parallel" | "spawn-chain" }>;
      const scope = spawnRequest.input.agentScope ?? "user";
      if (spawnRequest.kind === "spawn-parallel") {
        const schedule = spawnRequest.input.writerConcurrency === undefined ? "parallel default" : `shared pool ${spawnRequest.input.writerConcurrency}`;
        return new Text(`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `parallel ${spawnRequest.input.tasks.length} · ${schedule}`)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
      }
      if (spawnRequest.kind === "spawn-chain") return new Text(`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `chain ${spawnRequest.input.chain.length}`)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
      const agentName = spawnRequest.input.agent === undefined
        ? "generic"
        : typeof spawnRequest.input.agent === "string" ? spawnRequest.input.agent : spawnRequest.input.agent.name;
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", agentName)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }
      if (details.backgroundStarted) {
        const lines = [
          theme.fg("toolTitle", theme.bold(`Started in background (${details.results.length})`)),
          ...details.results.map((task) => `${theme.fg("toolTitle", theme.bold(task.name ?? task.agent))}${theme.fg("dim", ` Â· role ${task.agent} Â· ${task.id} Â· attempt ${task.attempt ?? 1}`)}`),
        ];
        if (details.executionNote) lines.push(theme.fg("dim", details.executionNote));
        lines.push(theme.fg("dim", "Live status appears below while child threads run."));
        return new Text(lines.join("\n"), 0, 0);
      }
      const board = formatThreadBoard({
        title: `Subagents · ${details.mode}`,
        threads: details.results.map(threadBoardRecord),
        selectedThreadId: details.selectedThreadId,
      });
      if (!expanded) {
        const lines = [
          theme.fg("toolTitle", theme.bold(`Active (${board.active.length})`)),
          ...board.active.map((task) => `${theme.fg("accent", "✻")} ${theme.fg("toolTitle", theme.bold(task.displayName ?? task.agent))}${theme.fg("dim", ` · role ${task.agent} · ${task.id} · attempt ${task.attempt ?? 1} · ${task.state.label} · ${task.usage.text}`)}`),
          theme.fg("toolTitle", theme.bold(`Done (${board.done.length})`)),
          ...board.done.map((task) => `${theme.fg(task.state.status === "complete" ? "success" : "warning", `${task.state.label}`)} ${theme.fg("toolTitle", theme.bold(task.displayName ?? task.agent))}${theme.fg("dim", ` · role ${task.agent} · ${task.id} · attempt ${task.attempt ?? 1} · ${task.usage.text}`)}`),
        ];
        if (details.executionNote) lines.push(theme.fg("dim", details.executionNote));
        lines.push(theme.fg("dim", `Total · ${formatUsage(details.aggregateUsage)} · Ctrl+O to expand`));
        return new Text(lines.join("\n"), 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("toolTitle", theme.bold(`Subagents · ${details.mode}`)), 0, 0));
      container.addChild(new Text(theme.fg("dim", `Active ${board.active.length} · Done ${board.done.length} · Controls: Inspect · Steer · Interrupt · Wait · Collect · Resume · Close`), 0, 0));
      if (details.executionNote) container.addChild(new Text(theme.fg("dim", details.executionNote), 0, 0));
      if (board.selected) {
        const inspection = formatThreadInspection(threadBoardRecord(details.results.find((task) => task.id === board.selected!.id)!));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", `Inspect ${inspection.displayName ?? inspection.agent} · ${inspection.state.label} · ${inspection.id} · ${inspection.usage.text}`), 0, 0));
        for (const entry of inspection.trace.entries) container.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("toolOutput", entry)}`, 0, 0));
      }
      for (const task of details.results) {
        container.addChild(new Spacer(1));
        const status = theme.fg(statusColor(task.status), `${statusIcon(task.status)} ${task.status}`);
        container.addChild(new Text(`${status} ${theme.fg("accent", task.name ?? task.agent)}${theme.fg("dim", ` · role ${task.agent} · ${task.id} · attempt ${task.attempt} · ${task.agentSource}`)}`, 0, 0));
        container.addChild(new Text(theme.fg("dim", `${task.model ?? "no model"} · ${task.thinking ?? "off"} · ${task.tools.join(", ")} · ${formatUsage(task.usage)} · ${task.durationMs}ms`), 0, 0));
        container.addChild(new Text(theme.fg("muted", `Task: ${task.task}`), 0, 0));
        for (const entry of task.trace) container.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("toolOutput", entry)}`, 0, 0));
        if (task.traceTruncatedBytes || task.stderrTruncatedBytes || task.outputTruncatedBytes) {
          container.addChild(new Text(theme.fg("warning", `Truncated · trace ${task.traceTruncatedBytes} B · stderr ${task.stderrTruncatedBytes} B · output ${task.outputTruncatedBytes} B`), 0, 0));
        }
        if (task.output) container.addChild(new Markdown(task.output, 0, 0, getMarkdownTheme()));
        else if (task.errorMessage || task.stderr) container.addChild(new Text(theme.fg("error", task.errorMessage || task.stderr), 0, 0));
      }
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Total · ${formatUsage(details.aggregateUsage)}`), 0, 0));
      return container;
    },
  };
  pi.registerTool(toolDefinition);
  return {
    async execute(controlRequest: SubagentControlRequest, ctx: ExtensionContext): Promise<SubagentControlResult> {
      const result = await toolDefinition.execute("subagent-control", controlRequest, undefined, undefined, ctx);
      const first = result.content[0];
      const details = result.details as SubagentDetails;
      return {
        text: first?.type === "text" ? first.text : "",
        details,
        usage: (result.usage as SubagentUsage | undefined) ?? details.aggregateUsage,
      };
    },
  };
}
