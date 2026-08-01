import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { runSubagentProcess, type SubagentProcessHandle, type SubagentProcessResult } from "./subagent-process.ts";
import { formatThreadBoard, formatThreadInspection, type ThreadRecord as ThreadBoardRecord } from "./subagent-ui.ts";

export const SUBAGENT_LIMITS = {
  maxTasks: 10,
  maxReadConcurrency: 4,
  toolOutputBytes: 50 * 1024,
  traceRetentionBytes: 8 * 1024 * 1024,
  stderrRetentionBytes: 1 * 1024 * 1024,
  taskOutputRetentionBytes: 1 * 1024 * 1024,
  roleFileBytes: 64 * 1024,
  taskCharacters: 20_000,
  killGraceMs: 5_000,
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
export type AgentSource = "bundled" | "personal" | "project";
export type AgentScope = "user" | "project" | "both";
export type SubagentStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "limited";

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
}

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
  jsonlLineBytes?: number;
  traceBytes?: number;
  stderrBytes?: number;
  taskOutputBytes?: number;
  quotaTokens?: number;
  quotaUsd?: number;
};

export interface SubagentRuntimeOptions {
  bundledAgentsDir?: string;
  userAgentsDir?: string;
  webExtension?: string;
  spawnProcess?: (args: string[], cwd: string, environment?: NodeJS.ProcessEnv) => SpawnedProcess;
  limits?: Partial<SubagentLimits>;
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
    timeoutMs: optionalPositiveInteger(frontmatter, filePath, "timeoutMs"),
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
  const bundledDir = options.bundledAgentsDir ?? fileURLToPath(new URL("./agents/", import.meta.url));
  const userDir = options.userAgentsDir ?? path.join(getAgentDir(), "agents");
  const wantsProject = scope === "project" || scope === "both";
  if (wantsProject && !projectTrusted) throw new Error("Project agents require a trusted project");
  const projectAgentsDir = wantsProject ? findProjectAgentsDir(cwd) : null;

  const layers: Array<{ dir: string; source: AgentSource }> = [{ dir: bundledDir, source: "bundled" }];
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

function makeQueuedResult(id: string, agent: string, task: string, step?: number): SubagentTaskResult {
  return {
    id,
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
  target.durationMs = source.durationMs || Date.now() - startedAt;
  onChange(target);
}

async function runTask(options: RunTaskOptions): Promise<SubagentTaskResult> {
  const { agent, limits } = options;
  const result = makeQueuedResult(options.id, agent.name, options.task, options.step);
  result.agentSource = agent.source;
  result.sourcePath = agent.filePath;
  result.access = agent.access;
  result.tools = [...agent.tools];
  result.model = options.model.model;
  result.thinking = options.model.thinking;
  result.status = "running";
  const startedAt = Date.now();
  options.onChange(result);

  if (options.signal?.aborted) {
    result.status = "cancelled";
    result.terminationReason = "abort";
    result.durationMs = Date.now() - startedAt;
    options.onChange(result);
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
      options.onChange(result);
      return result;
    }
    const args = [
      "--mode", "json",
      "-p",
      "--session-dir", options.sessionDirectory,
      "--session-id", options.sessionId,
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
        ...(limits.jsonlLineBytes === undefined ? {} : { jsonlLineBytes: limits.jsonlLineBytes }),
        ...(limits.traceBytes === undefined ? {} : { traceBytes: limits.traceBytes }),
        ...(limits.stderrBytes === undefined ? {} : { stderrBytes: limits.stderrBytes }),
        ...(limits.taskOutputBytes === undefined ? {} : { outputBytes: limits.taskOutputBytes }),
        ...(limits.quotaTokens === undefined ? {} : { quotaTokens: limits.quotaTokens }),
        ...(limits.quotaUsd === undefined ? {} : { quotaUsd: limits.quotaUsd }),
        killGraceMs: limits.killGraceMs,
      },
      retention: {
        traceBytes: limits.traceRetentionBytes,
        stderrBytes: limits.stderrRetentionBytes,
        outputBytes: limits.taskOutputRetentionBytes,
      },
      onUpdate: (next) => applyProcessResult(result, next, startedAt, options.onChange),
    });
    options.onHandle?.(handle);
    const final = await handle.result;
    applyProcessResult(result, final, startedAt, options.onChange);
    return result;
  } catch (error) {
    result.status = options.signal?.aborted ? "cancelled" : "failed";
    result.terminationReason = options.signal?.aborted ? "abort" : "spawn_error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.durationMs = Date.now() - startedAt;
    options.onChange(result);
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

function createSubagentParams(limits: Pick<SubagentLimits, "maxTasks" | "maxReadConcurrency" | "taskCharacters">) {
  const taskSchema = Type.Object({
    agent: Type.String({ minLength: 1, maxLength: 64, description: "Agent role name" }),
    task: Type.String({ minLength: 1, maxLength: limits.taskCharacters, description: "Bounded task for the role" }),
  });
  const chainTaskSchema = Type.Object({
    agent: Type.String({ minLength: 1, maxLength: 64, description: "Agent role name" }),
    task: Type.String({ minLength: 1, maxLength: limits.taskCharacters, description: "Task with optional {previous} handoff placeholder" }),
  });
  return Type.Object({
    action: Type.Optional(StringEnum(["spawn", "list", "inspect", "steer", "interrupt", "collect", "close"] as const, {
      default: "spawn",
      description: "Thread lifecycle action",
    })),
    threadId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Stable child thread ID" })),
    message: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Bounded steering message; only valid with action steer" })),
    all: Type.Optional(Type.Boolean({ description: "Interrupt every active child thread" })),
    agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Agent role for single mode" })),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: limits.taskCharacters, description: "Task for single mode" })),
    tasks: Type.Optional(Type.Array(taskSchema, { minItems: 1, maxItems: limits.maxTasks, description: `Parallel role tasks: read-only roles run concurrently up to ${limits.maxReadConcurrency}; write-capable roles run serially in input order because all children share the parent worktree` })),
    chain: Type.Optional(Type.Array(chainTaskSchema, { minItems: 1, maxItems: limits.maxTasks, description: "Sequential role tasks; {previous} inserts the prior result" })),
    model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Model for every task as provider/model; inherit uses each role setting or the active parent" })),
    thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 16, description: "Thinking effort for every task: off, minimal, low, medium, high, xhigh, max, or inherit" })),
    agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, {
      default: "user",
      description: "Role sources: user includes bundled and personal; project includes bundled and trusted project; both includes all",
    })),
  });
}

type TaskInput = { agent: string; task: string };

type ToolUpdate = (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;

function requestedAgents(params: { agent?: string; tasks?: TaskInput[]; chain?: TaskInput[] }): string[] {
  if (params.agent) return [params.agent];
  return (params.tasks ?? params.chain ?? []).map((task) => task.agent);
}

function clipCharacters(text: string, maxCharacters: number, fromEnd = false): string {
  const characters = [...text];
  if (characters.length <= maxCharacters) return text;
  return (fromEnd ? characters.slice(-maxCharacters) : characters.slice(0, maxCharacters)).join("");
}

function buildSteeredTask(task: string, steering: readonly string[], maxCharacters: number): string {
  const steeringLabel = "\n\nParent steering:\n";
  const steeringText = clipCharacters(steering.join("\n"), Math.max(0, maxCharacters - [...steeringLabel].length), true);
  const required = [...steeringLabel, ...steeringText].length;
  const taskText = clipCharacters(task, Math.max(0, maxCharacters - required));
  return `${taskText}${steeringLabel}${steeringText}`;
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
  steering: string[];
  restarting: boolean;
  traceCount: number;
  startedAt: number;
  aggregate?: SubagentTaskResult;
  requestedReason?: string;
}

function parentThreadId(ctx: ExtensionContext): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (id) return `main:${id}`;
  } catch {
    // Test and RPC contexts may not expose a session manager.
  }
  return "main";
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
  return "queued";
}

function threadResult(thread: SubagentThread, source?: SubagentTaskResult): SubagentTaskResult {
  if (source) {
    const result = cloneResult(source);
    if (thread.state === "queued") result.status = "queued";
    else if (thread.state === "active") result.status = "running";
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
    terminationReason: thread.stopReason,
  };
}

function threadBoardRecord(result: SubagentTaskResult): ThreadBoardRecord {
  return {
    id: result.id,
    agent: result.agent,
    task: result.task,
    status: result.status,
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

export function registerSubagentTool(pi: ExtensionAPI, options: SubagentRuntimeOptions = {}): void {
  const limits = { ...SUBAGENT_LIMITS, ...options.limits };
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const threads = new SubagentThreadRegistry();
  const activeRuntimes = new Map<string, ActiveThreadRuntime>();
  const savedResults = new Map<string, SubagentTaskResult>();

  const detailsFor = (
    parentId: string,
    mode: SubagentDetails["mode"] = "single",
    scope: AgentScope = "user",
    projectAgentsDir: string | null = null,
    selectedThreadId?: string,
  ): SubagentDetails => {
    const all = threads.listAll().filter((thread) => thread.parentId === parentId);
    const visible = all.filter((thread) => thread.state !== "closed");
    const results = visible.map((thread) => threadResult(thread, savedResults.get(thread.id)));
    return {
      ...cloneDetails(mode, scope, projectAgentsDir, results),
      parentId,
      threads: all,
      activeThreads: all.filter((thread) => thread.state === "active"),
      doneThreads: all.filter((thread) => ["done", "failed", "stopped"].includes(thread.state)),
      selectedThreadId,
    };
  };

  const threadBoardText = (parentId: string, selectedThreadId?: string): string => {
    const details = detailsFor(parentId, "single", "user", null, selectedThreadId);
    const active = details.activeThreads ?? [];
    const done = details.doneThreads ?? [];
    const row = (thread: SubagentThread): string => `- ${thread.id} · ${thread.role} · ${thread.state} · ${thread.prompt}`;
    const lines = [
      `parent ${parentId}`,
      `Active (${active.length})`,
      ...(active.length ? active.map(row) : ["- none"]),
      `Done (${done.length})`,
      ...(done.length ? done.map(row) : ["- none"]),
      "Controls: inspect · steer · interrupt · collect · close",
    ];
    if (selectedThreadId) {
      const selected = details.threads?.find((thread) => thread.id === selectedThreadId);
      if (selected) {
        lines.push(`Inspect ${selected.id}: ${selected.state}`);
        lines.push(`Role: ${selected.role}`);
        lines.push(`Model: ${selected.model}`);
        lines.push(`Tools: ${selected.tools.join(", ")}`);
        lines.push(`Trace: ${selected.trace.length} entries`);
        if (selected.result) lines.push(`Handoff: ${selected.result}`);
        if (selected.stopReason) lines.push(`Reason: ${selected.stopReason}`);
      }
    }
    return boundedText(lines.join("\n"), limits.toolOutputBytes, "\n\n[Thread board truncated; inspect a child thread for its bounded detail.]");
  };

  const syncThread = (threadId: SubagentThreadId, next: SubagentTaskResult, runtime?: ActiveThreadRuntime): SubagentTaskResult => {
    const effective = mergeTaskResults(runtime?.aggregate, next, limits.traceRetentionBytes, limits.stderrRetentionBytes);
    if (runtime?.requestedReason && next.status === "cancelled") effective.terminationReason = runtime.requestedReason;
    savedResults.set(threadId, cloneResult(effective));
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
    const handoff = effective.output ? { summary: effective.output } : undefined;
    thread = threads.patch(threadId, { usage: threadUsage(effective.usage), result: effective.output || undefined, handoff });
    const restartPending = runtime?.restarting === true && ["cancelled", "complete"].includes(next.status);
    if (restartPending) return effective;
    if (effective.status === "complete") {
      threads.complete(threadId, { usage: threadUsage(effective.usage), result: effective.output || undefined, handoff });
    } else if (effective.status === "failed") {
      threads.fail(threadId, {
        usage: threadUsage(effective.usage),
        result: effective.output || undefined,
        handoff,
        message: effective.errorMessage ?? effective.terminationReason ?? "child failed",
        code: effective.terminationReason,
      });
    } else if (effective.status === "cancelled" || effective.status === "limited") {
      threads.stop(threadId, {
        usage: threadUsage(effective.usage),
        result: effective.output || undefined,
        handoff,
        reason: effective.terminationReason ?? (effective.status === "limited" ? "resource_limit" : "interrupted"),
      });
    }
    return effective;
  };

  if (typeof pi.on === "function") {
    pi.on("session_shutdown", () => {
      for (const runtime of activeRuntimes.values()) {
        runtime.restarting = false;
        runtime.requestedReason = "session_shutdown";
        runtime.handle?.stop("session_shutdown");
        runtime.controller.abort();
      }
      threads.dispose();
    });
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagents",
    description: `Spawn and manage named child threads. Children finish naturally. Parallel tasks run read-only roles concurrently up to ${limits.maxReadConcurrency}, then run write-capable roles serially in input order because all children share the parent worktree. The message parameter is only valid with action steer. Use action list, inspect, steer, interrupt, collect, and close to manage active and completed handoffs.`,
    promptSnippet: "Delegate bounded specialist work to isolated KillerOS subagents",
    promptGuidelines: [
      "Use subagent for clearly separable specialist work; prefer read-only scout, planner, reviewer, or security roles before a writer.",
      `Parallel tasks run read-only roles concurrently up to ${limits.maxReadConcurrency}, then queue write-capable roles in input order because all children share the parent worktree.`,
      "Every child can load relevant skills with read and can use web_search, source_check, fetch_content, and get_search_content for external research.",
      "When the user names a model or thinking effort, pass model and thinking separately; use inherit when the active parent or role setting should decide.",
      "Keep completed and stopped threads inspectable until the parent explicitly closes them.",
    ],
    parameters: createSubagentParams(limits),
    executionMode: "parallel",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action ?? "spawn";
      if (params.message !== undefined && action !== "steer") {
        throw new Error("message is only valid with action steer");
      }
      const parentId = parentThreadId(ctx);
      const actionDetails = (selectedThreadId?: string): SubagentDetails => detailsFor(parentId, "single", params.agentScope ?? "user", null, selectedThreadId);
      const actionResult = (text: string, selectedThreadId?: string) => {
        const details = actionDetails(selectedThreadId);
        return {
          content: [{ type: "text" as const, text: boundedText(text, limits.toolOutputBytes, "\n\n[Thread action output truncated.]") }],
          details,
          usage: details.aggregateUsage,
        };
      };

      if (action === "list") return actionResult(threadBoardText(parentId));
      if (action === "inspect") {
        if (!params.threadId) throw new Error("inspect requires threadId");
        const thread = threads.inspect(params.threadId as SubagentThreadId);
        if (!thread || thread.parentId !== parentId) throw new Error(`Unknown child thread ${JSON.stringify(params.threadId)}`);
        return actionResult(threadBoardText(parentId, params.threadId), params.threadId);
      }
      if (action === "steer") {
        if (!params.threadId || !params.message) throw new Error("steer requires threadId and message");
        const threadId = params.threadId as SubagentThreadId;
        const thread = threads.inspect(threadId);
        if (!thread || thread.parentId !== parentId) throw new Error(`Unknown child thread ${JSON.stringify(params.threadId)}`);
        threads.steer(threadId, params.message);
        const runtime = activeRuntimes.get(params.threadId);
        if (runtime) {
          runtime.steering.push(params.message);
          if (runtime.steering.length > MAX_RUNTIME_STEERING_MESSAGES) runtime.steering.splice(0, runtime.steering.length - MAX_RUNTIME_STEERING_MESSAGES);
          runtime.restarting = true;
          runtime.requestedReason = "steer";
          runtime.handle?.stop("steer");
        }
        return actionResult(`Steering queued for ${params.threadId}. The child keeps the same thread and handoff record.`, params.threadId);
      }
      if (action === "interrupt") {
        if (!params.all && !params.threadId) throw new Error("interrupt requires threadId or all=true");
        let targets: SubagentThread[];
        if (params.all) {
          targets = threads.listActive().filter((thread) => thread.parentId === parentId);
        } else {
          const target = threads.inspect(params.threadId as SubagentThreadId);
          if (!target || target.parentId !== parentId) throw new Error(`Unknown child thread ${JSON.stringify(params.threadId)}`);
          if (target.state !== "active" && target.state !== "queued") {
            throw new Error(`Cannot interrupt thread ${params.threadId} from ${target.state}`);
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
        return actionResult(params.all ? "Interrupt requested for all active child threads." : `Interrupt requested for ${params.threadId}.`);
      }
      if (action === "collect") {
        if (!params.threadId) throw new Error("collect requires threadId");
        const thread = threads.inspect(params.threadId as SubagentThreadId);
        if (!thread || thread.parentId !== parentId) throw new Error(`Unknown child thread ${JSON.stringify(params.threadId)}`);
        const collected = threads.collect(params.threadId as SubagentThreadId);
        return actionResult(`Collected ${params.threadId}: ${collected.result ?? collected.failure?.message ?? collected.stopReason ?? "no handoff"}`, params.threadId);
      }
      if (action === "close") {
        if (!params.threadId) throw new Error("close requires threadId");
        const thread = threads.inspect(params.threadId as SubagentThreadId);
        if (!thread || thread.parentId !== parentId) throw new Error(`Unknown child thread ${JSON.stringify(params.threadId)}`);
        threads.close(params.threadId as SubagentThreadId);
        return actionResult(`Closed ${params.threadId}. Its result record remains inspectable.`, params.threadId);
      }

      const scope: AgentScope = params.agentScope ?? "user";
      const hasSingleFields = params.agent !== undefined || params.task !== undefined;
      const hasParallel = params.tasks !== undefined;
      const hasChain = params.chain !== undefined;
      const hasSingle = hasSingleFields && Boolean(params.agent && params.task);
      if (Number(hasSingleFields) + Number(hasParallel) + Number(hasChain) !== 1
        || hasSingleFields && !hasSingle
        || hasParallel && params.tasks!.length === 0
        || hasChain && params.chain!.length === 0) {
        throw new Error("Provide exactly one subagent mode: agent + task, tasks, or chain");
      }

      const discovery = discoverAgentRoles(ctx.cwd, scope, ctx.isProjectTrusted(), options);
      const roles = new Map(discovery.agents.map((agent) => [agent.name, agent]));
      const requested = requestedAgents(params);
      for (const name of requested) {
        if (!roles.has(name)) {
          const available = discovery.agents.map((agent) => `${agent.name} (${agent.source})`).join(", ") || "none";
          throw new Error(`Unknown subagent ${JSON.stringify(name)}. Available: ${available}`);
        }
      }

      const projectRoles = [...new Set(requested.map((name) => roles.get(name)!).filter((role) => role.source === "project"))];
      if (projectRoles.length) {
        if (!ctx.hasUI) throw new Error("Project-local subagents require interactive confirmation");
        const approved = await ctx.ui.confirm(
          "Run project-local subagents?",
          `Roles: ${projectRoles.map((role) => role.name).join(", ")}\nSources:\n${projectRoles.map((role) => role.filePath).join("\n")}\n\nThese trusted repository files control child prompts and tools.`,
        );
        if (!approved) throw new Error("Project-local subagents were not approved");
      }

      const resolvedModels = new Map<string, ResolvedModel>();
      for (const name of new Set(requested)) {
        resolvedModels.set(name, resolveAgentModel(roles.get(name)!, ctx, params.model, params.thinking));
      }

      const mode: SubagentDetails["mode"] = hasParallel ? "parallel" : hasChain ? "chain" : "single";
      const inputs: TaskInput[] = hasSingle
        ? [{ agent: params.agent!, task: params.task! }]
        : hasParallel ? params.tasks! : params.chain!;
      if (inputs.length > limits.maxTasks) throw new Error(`At most ${limits.maxTasks} subagent tasks are allowed`);
      const readIndexes = hasParallel
        ? inputs.map((input, index) => ({ input, index })).filter(({ input }) => roles.get(input.agent)!.access === "read")
        : [];
      const writerIndexes = hasParallel
        ? inputs.map((input, index) => ({ input, index })).filter(({ input }) => roles.get(input.agent)!.access === "write").map(({ index }) => index)
        : [];
      const executionNote = hasParallel
        ? writerIndexes.length
          ? `Parallel schedule: read-only tasks run concurrently up to ${limits.maxReadConcurrency}; write-capable tasks are queued (serialized) in input order because all children share the parent worktree.`
          : `Parallel schedule: read-only tasks run concurrently up to ${limits.maxReadConcurrency}.`
        : undefined;

      const inFlight = threads.listAll().filter((thread) => ["queued", "active"].includes(thread.state)).length;
      if (inFlight + inputs.length > limits.maxTasks) {
        throw new Error(`At most ${limits.maxTasks} child threads may be active at once`);
      }

      const threadRecords = inputs.map((input, index) => threads.spawn({
        parentId: parentId as SubagentThreadId,
        role: input.agent,
        prompt: input.task,
        model: resolvedModels.get(input.agent)!.model,
        tools: roles.get(input.agent)!.tools,
        capabilityBoundary: threadCapabilityBoundary(roles.get(input.agent)!),
      }));
      const results = threadRecords.map((thread, index) => {
        return makeQueuedResult(thread.id, inputs[index]!.agent, inputs[index]!.task, hasChain ? index + 1 : undefined);
      });
      const emit = (message = `${mode}: ${results.filter((result) => !["queued", "running"].includes(result.status)).length}/${results.length} settled`): void => {
        const board = detailsFor(parentId, mode, scope, discovery.projectAgentsDir);
        const currentResults = results.map(cloneResult);
        (onUpdate as ToolUpdate | undefined)?.({
          content: [{ type: "text", text: message }],
          details: { ...board, executionNote, results: currentResults, aggregateUsage: aggregateUsage(currentResults) },
        });
      };
      const runAt = async (index: number, task: string): Promise<void> => {
        const threadId = threadRecords[index]!.id;
        const initialThread = threads.inspect(threadId);
        if (signal?.aborted) {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: "abort" };
          if (initialThread?.state === "queued" || initialThread?.state === "active") threads.stop(threadId, { reason: "abort" });
          savedResults.set(threadId, cloneResult(results[index]!));
          emit();
          return;
        }
        if (!initialThread) return;
        if (initialThread.state === "closed") {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: initialThread.stopReason ?? "disposed" };
          savedResults.set(threadId, cloneResult(results[index]!));
          emit();
          return;
        }
        if (initialThread.state === "stopped") {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: initialThread.stopReason ?? "interrupted" };
          savedResults.set(threadId, cloneResult(results[index]!));
          emit();
          return;
        }
        if (initialThread.state !== "queued") return;
        const input = inputs[index]!;
        threads.begin(threadId);
        if ([...task].length > limits.taskCharacters) {
          results[index] = {
            ...results[index]!,
            status: "failed",
            terminationReason: "task_limit",
            errorMessage: `Expanded task exceeds ${limits.taskCharacters} characters`,
          };
          threads.fail(threadId, { message: results[index]!.errorMessage ?? "Expanded task exceeds the task limit", code: "task_limit" });
          savedResults.set(threadId, cloneResult(results[index]!));
          emit();
          return;
        }
        let sessionDirectory: string;
        try {
          sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "killeros-subagent-session-"));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results[index] = {
            ...results[index]!,
            status: "failed",
            terminationReason: "session_error",
            errorMessage: message,
          };
          threads.fail(threadId, { message, code: "session_error" });
          savedResults.set(threadId, cloneResult(results[index]!));
          emit();
          return;
        }
        const sessionId = `killeros-${threadId.replace(/[^A-Za-z0-9_.-]/gu, "_")}`;
        const controller = new AbortController();
        const abortParent = (): void => controller.abort();
        if (signal) {
          if (signal.aborted) controller.abort();
          else signal.addEventListener("abort", abortParent, { once: true });
        }
        const runtime: ActiveThreadRuntime = { controller, steering: [], restarting: false, traceCount: 0, startedAt: Date.now() };
        activeRuntimes.set(threadId, runtime);
        const agent = roles.get(input.agent)!;
        const queuedSteering = initialThread.steering.map((entry) => entry.message);
        let currentTask = queuedSteering.length ? buildSteeredTask(task, queuedSteering, limits.taskCharacters) : task;
        const stopForBudget = (reason: string, message: string): void => {
          const limited = cloneResult(runtime.aggregate ?? results[index]!);
          limited.status = "limited";
          limited.terminationReason = reason;
          limited.errorMessage = message;
          runtime.aggregate = limited;
          results[index] = cloneResult(limited);
          savedResults.set(threadId, cloneResult(limited));
          if (!threads.isDisposed && threads.inspect(threadId)?.state === "active") {
            threads.stop(threadId, {
              usage: threadUsage(limited.usage),
              result: limited.output || undefined,
              handoff: limited.output ? { summary: limited.output } : undefined,
              reason,
            });
          }
          emit();
        };
        try {
          while (true) {
            const aggregate = runtime.aggregate;
            const wallTimeMs = agent.timeoutMs ?? limits.wallTimeMs;
            const remainingWallTimeMs = wallTimeMs === undefined ? undefined : wallTimeMs - (Date.now() - runtime.startedAt);
            const usedTraceBytes = (aggregate?.traceBytes ?? 0) + (aggregate?.traceTruncatedBytes ?? 0);
            const usedStderrBytes = aggregate?.stderrBytes ?? 0;
            const usedOutputBytes = aggregate?.outputBytes ?? 0;
            const usedTokens = aggregate?.usage.totalTokens ?? 0;
            const usedCost = aggregate?.usage.cost.total ?? 0;
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
            if (limits.quotaTokens !== undefined && usedTokens >= limits.quotaTokens) {
              stopForBudget("quota_tokens", `Child thread exceeds ${limits.quotaTokens} tokens`);
              break;
            }
            if (limits.quotaUsd !== undefined && usedCost >= limits.quotaUsd) {
              stopForBudget("quota_cost", `Child thread exceeds $${limits.quotaUsd}`);
              break;
            }
            runtime.traceCount = 0;
            const next = await runTask({
              cwd: ctx.cwd,
              agent: roles.get(input.agent)!,
              task: currentTask,
              id: results[index]!.id,
              step: results[index]!.step,
              model: resolvedModels.get(input.agent)!,
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
                ...(limits.quotaTokens === undefined ? {} : { quotaTokens: limits.quotaTokens - usedTokens }),
                ...(limits.quotaUsd === undefined ? {} : { quotaUsd: limits.quotaUsd - usedCost }),
              },
              timeoutMs: remainingWallTimeMs,
              onHandle: (handle) => { runtime.handle = handle; },
              onChange: (changed) => {
                results[index] = syncThread(threadId, changed, runtime);
                emit();
              },
            });
            next.task = task;
            runtime.aggregate = mergeTaskResults(runtime.aggregate, next, limits.traceRetentionBytes, limits.stderrRetentionBytes);
            runtime.aggregate.task = task;
            results[index] = cloneResult(runtime.aggregate);
            savedResults.set(threadId, cloneResult(runtime.aggregate));
            const shouldRestart = runtime.steering.length > 0 && !controller.signal.aborted && (runtime.restarting || next.status === "complete" || next.status === "cancelled");
            if (!shouldRestart) break;
            const steering = runtime.steering.splice(0);
            runtime.restarting = false;
            runtime.requestedReason = undefined;
            if (!threads.isDisposed && threads.inspect(threadId)?.state === "active") {
              threads.patch(threadId, {
                usage: threadUsage(runtime.aggregate.usage),
                result: runtime.aggregate.output || undefined,
                handoff: runtime.aggregate.output ? { summary: runtime.aggregate.output } : undefined,
              });
            }
            currentTask = buildSteeredTask(task, steering, limits.taskCharacters);
          }
        } finally {
          activeRuntimes.delete(threadId);
          signal?.removeEventListener("abort", abortParent);
          try {
            await rm(sessionDirectory, { recursive: true, force: true });
          } catch {
            // Temporary child session cleanup is best effort after process termination.
          }
        }
        emit();
      };

      const settleQueued = (reason: string): void => {
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index]!;
          if (result.status !== "queued") continue;
          const thread = threads.inspect(threadRecords[index]!.id);
          const alreadyStopped = thread?.state === "stopped";
          result.status = signal?.aborted || alreadyStopped ? "cancelled" : "failed";
          result.terminationReason = alreadyStopped
            ? thread.stopReason ?? "interrupted"
            : signal?.aborted ? "abort" : reason;
          if (thread?.state === "queued" || thread?.state === "active") {
            threads.stop(threadRecords[index]!.id, { reason: result.terminationReason });
          }
          savedResults.set(threadRecords[index]!.id, cloneResult(result));
        }
      };

      emit(`${mode}: ${results.length} queued`);
      if (hasChain) {
        let previous = "";
        for (let index = 0; index < inputs.length; index += 1) {
          const task = inputs[index]!.task.replaceAll("{previous}", previous);
          await runAt(index, task);
          if (results[index]!.status !== "complete") break;
          previous = results[index]!.output;
        }
        settleQueued("chain_stopped");
      } else if (hasParallel) {
        try {
          await mapReadTasks(readIndexes, limits.maxReadConcurrency, async ({ index }) => runAt(index, inputs[index]!.task));
          for (const index of writerIndexes) await runAt(index, inputs[index]!.task);
        } finally {
          settleQueued("parallel_stopped");
        }
      } else {
        await runAt(0, inputs[0]!.task);
      }

      const board = detailsFor(parentId, mode, scope, discovery.projectAgentsDir);
      const currentResults = results.map(cloneResult);
      const details: SubagentDetails = { ...board, executionNote, results: currentResults, aggregateUsage: aggregateUsage(currentResults) };
      return {
        content: [{ type: "text", text: buildToolContent(mode, details.results, limits.toolOutputBytes) }],
        details,
        usage: details.aggregateUsage,
      };
    },

    renderCall(args, theme) {
      const scope = args.agentScope ?? "user";
      if (args.action && args.action !== "spawn") return new Text(`${theme.fg("toolTitle", theme.bold("threads "))}${theme.fg("accent", args.action)}${theme.fg("dim", args.threadId ? ` · ${args.threadId}` : "")}`, 0, 0);
      if (args.tasks?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `parallel ${args.tasks.length} · readers first; writers serial`)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
      if (args.chain?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `chain ${args.chain.length}`)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "…")}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }
      const board = formatThreadBoard({
        title: `Subagents · ${details.mode}`,
        threads: details.results.map(threadBoardRecord),
        selectedThreadId: details.selectedThreadId,
      });
      if (!expanded) {
        const lines = [
          theme.fg("toolTitle", theme.bold(`Active (${board.active.length})`)),
          ...board.active.map((task) => `${theme.fg("accent", "✻")} ${theme.fg("toolTitle", theme.bold(task.agent))}${theme.fg("dim", ` · ${task.id} · ${task.state.label} · ${task.usage.text}`)}`),
          theme.fg("toolTitle", theme.bold(`Done (${board.done.length})`)),
          ...board.done.map((task) => `${theme.fg(task.state.status === "complete" ? "success" : "warning", `${task.state.label}`)} ${theme.fg("toolTitle", theme.bold(task.agent))}${theme.fg("dim", ` · ${task.id} · ${task.usage.text}`)}`),
        ];
        if (details.executionNote) lines.push(theme.fg("dim", details.executionNote));
        lines.push(theme.fg("dim", `Total · ${formatUsage(details.aggregateUsage)} · Ctrl+O to expand`));
        return new Text(lines.join("\n"), 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("toolTitle", theme.bold(`Subagents · ${details.mode}`)), 0, 0));
      container.addChild(new Text(theme.fg("dim", `Active ${board.active.length} · Done ${board.done.length} · Controls: Inspect · Steer · Interrupt · Collect · Close`), 0, 0));
      if (details.executionNote) container.addChild(new Text(theme.fg("dim", details.executionNote), 0, 0));
      if (board.selected) {
        const inspection = formatThreadInspection(threadBoardRecord(details.results.find((task) => task.id === board.selected!.id)!));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", `Inspect ${inspection.id} · ${inspection.state.label} · ${inspection.usage.text}`), 0, 0));
        for (const entry of inspection.trace.entries) container.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("toolOutput", entry)}`, 0, 0));
      }
      for (const task of details.results) {
        container.addChild(new Spacer(1));
        const status = theme.fg(statusColor(task.status), `${statusIcon(task.status)} ${task.status}`);
        container.addChild(new Text(`${status} ${theme.fg("accent", task.agent)}${theme.fg("dim", ` · ${task.id} · ${task.agentSource}`)}`, 0, 0));
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
  });
}
