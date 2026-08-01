import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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

export const SUBAGENT_LIMITS = {
  maxTasks: 8,
  maxReadConcurrency: 4,
  defaultTurns: 8,
  maxTurns: 12,
  defaultTimeoutMs: 300_000,
  maxTimeoutMs: 600_000,
  jsonlLineBytes: 32 * 1024 * 1024,
  traceBytes: 2 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  taskOutputBytes: 50 * 1024,
  toolOutputBytes: 50 * 1024,
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
const ROLE_FIELDS = new Set(["name", "description", "access", "tools", "model", "thinking", "maxTurns", "timeoutMs"]);

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
  maxTurns: number;
  timeoutMs: number;
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
  stderrTruncatedBytes: number;
  output: string;
  outputTruncatedBytes: number;
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
  results: SubagentTaskResult[];
  aggregateUsage: SubagentUsage;
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

type SubagentLimits = { [Key in keyof typeof SUBAGENT_LIMITS]: number };

export interface SubagentRuntimeOptions {
  bundledAgentsDir?: string;
  userAgentsDir?: string;
  webExtension?: string;
  spawnProcess?: (args: string[], cwd: string) => SpawnedProcess;
  createTaskId?: (index: number) => string;
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
  fallback: number,
  maximum: number,
): number {
  const value = frontmatter[field];
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new AgentConfigurationError(filePath, field, `must be a positive integer no greater than ${maximum}`);
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
    maxTurns: optionalPositiveInteger(frontmatter, filePath, "maxTurns", limits.defaultTurns, limits.maxTurns),
    timeoutMs: optionalPositiveInteger(frontmatter, filePath, "timeoutMs", limits.defaultTimeoutMs, limits.maxTimeoutMs),
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

function terminateProcess(child: SpawnedProcess, force: boolean): void {
  if (process.platform === "win32" && force && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return;
    } catch {
      // Fall back to the direct child when process-group signaling is unavailable.
    }
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, omittedBytes: 0 };
  let truncated = bytes.subarray(0, maxBytes).toString("utf8");
  if (truncated.endsWith("�")) truncated = truncated.slice(0, -1);
  return { text: truncated, omittedBytes: bytes.length - Buffer.byteLength(truncated, "utf8") };
}

function textContent(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n");
}

function traceMessage(message: any): string[] {
  if (!Array.isArray(message?.content)) return [];
  const entries: string[] = [];
  for (const part of message.content) {
    if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
    const args = truncateUtf8(JSON.stringify(part.arguments ?? {}), 2_000).text;
    entries.push(`${part.name} ${args}`);
  }
  return entries;
}

function appendTrace(result: SubagentTaskResult, entries: string[], maxBytes: number): void {
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry, "utf8");
    const remaining = Math.max(0, maxBytes - result.traceBytes);
    const retained = truncateUtf8(entry, remaining).text;
    const retainedBytes = Buffer.byteLength(retained, "utf8");
    if (retained) result.trace.push(retained);
    result.traceBytes += retainedBytes;
    result.traceTruncatedBytes += entryBytes - retainedBytes;
  }
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
    stderrTruncatedBytes: 0,
    output: "",
    outputTruncatedBytes: 0,
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
  spawnProcess: (args: string[], cwd: string) => SpawnedProcess;
  webExtension?: string;
  projectTrusted: boolean;
  limits: SubagentLimits;
  onChange: (result: SubagentTaskResult) => void;
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
  let child: SpawnedProcess | undefined;
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
      "--no-session",
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
    child = options.spawnProcess(args, options.cwd);

    let stdoutLineBuffer = Buffer.alloc(0);
    let stdoutLineBytes = 0;
    let rawStderrBytes = 0;
    let requestedStatus: SubagentStatus | undefined;
    let requestedReason: string | undefined;
    let closed = false;
    let malformedError: string | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const requestTermination = (status: "failed" | "cancelled" | "limited", reason: string, errorMessage?: string): void => {
      if (requestedStatus) return;
      requestedStatus = status;
      requestedReason = reason;
      if (errorMessage) result.errorMessage = errorMessage;
      terminateProcess(child!, false);
      forceTimer = setTimeout(() => {
        if (closed) return;
        terminateProcess(child!, true);
        settleTimer = setTimeout(() => {
          if (!closed) finish(null);
        }, 1_000);
      }, limits.killGraceMs);
    };

    const processLine = (line: string): void => {
      if (!line.trim() || requestedStatus) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch (error) {
        malformedError = error instanceof Error ? error.message : String(error);
        requestTermination("failed", "malformed_jsonl", `Malformed child JSONL: ${malformedError}`);
        return;
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        const message = event.message;
        result.usage.turns += 1;
        addUsage(result.usage, { ...message.usage, turns: 0 });
        appendTrace(result, traceMessage(message), limits.traceBytes);
        const output = textContent(message);
        if (output) {
          const capped = truncateUtf8(output, limits.taskOutputBytes);
          result.output = capped.text;
          result.outputTruncatedBytes = capped.omittedBytes;
        }
        if (typeof message.model === "string") result.model = message.provider ? `${message.provider}/${message.model}` : message.model;
        const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
        if (stopReason === "stop" || stopReason === "toolUse") {
          result.terminationReason = undefined;
          result.errorMessage = undefined;
        } else if (stopReason) {
          result.terminationReason = stopReason;
        }
        if (typeof message.errorMessage === "string") result.errorMessage = message.errorMessage;
        if (stopReason === "length") requestTermination("limited", "model_output_limit");
        if (result.usage.turns > agent.maxTurns || result.usage.turns >= agent.maxTurns && stopReason === "toolUse") {
          requestTermination("limited", "turn_limit");
        }
        options.onChange(result);
      } else if (event?.type === "agent_end" && event.willRetry === true) {
        if (result.usage.turns >= agent.maxTurns) {
          requestTermination("limited", "turn_limit");
          options.onChange(result);
        }
      } else if (event?.type === "tool_result_end" && event.message) {
        const toolName = typeof event.message.toolName === "string" ? event.message.toolName : "tool";
        appendTrace(result, [`${toolName} result${event.message.isError ? " (error)" : ""}`], limits.traceBytes);
        options.onChange(result);
      }
    };

    const appendStdoutLine = (fragment: Buffer): boolean => {
      const nextBytes = stdoutLineBytes + fragment.length;
      if (nextBytes > limits.jsonlLineBytes) {
        requestTermination("limited", "jsonl_line_limit", `Child JSONL line exceeds ${limits.jsonlLineBytes} bytes`);
        return false;
      }
      if (nextBytes > stdoutLineBuffer.length) {
        const nextCapacity = Math.min(limits.jsonlLineBytes, Math.max(nextBytes, stdoutLineBuffer.length * 2, 4_096));
        const expanded = Buffer.allocUnsafe(nextCapacity);
        stdoutLineBuffer.copy(expanded, 0, 0, stdoutLineBytes);
        stdoutLineBuffer = expanded;
      }
      fragment.copy(stdoutLineBuffer, stdoutLineBytes);
      stdoutLineBytes = nextBytes;
      return true;
    };

    const processStdoutLine = (): void => {
      const line = stdoutLineBuffer.toString("utf8", 0, stdoutLineBytes);
      stdoutLineBuffer = Buffer.alloc(0);
      stdoutLineBytes = 0;
      processLine(line);
    };

    let finish!: (code: number | null) => void;
    const closedPromise = new Promise<void>((resolve) => {
      finish = (code: number | null): void => {
        if (closed) return;
        closed = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (settleTimer) clearTimeout(settleTimer);
        if (stdoutLineBytes > 0 && !requestedStatus) processStdoutLine();
        result.exitCode = code;
        if (requestedStatus) {
          result.status = requestedStatus;
          result.terminationReason = requestedReason;
        } else if (result.terminationReason === "length") {
          result.status = "limited";
          result.terminationReason = "model_output_limit";
        } else if (code !== 0 || result.errorMessage || result.terminationReason) {
          result.status = "failed";
          result.terminationReason ??= code === null ? "process_closed" : `exit_${code}`;
        } else if (result.usage.turns === 0) {
          result.status = "failed";
          result.terminationReason = "missing_assistant_message";
          result.errorMessage = "Child exited without an assistant response";
        } else {
          result.status = "complete";
          result.terminationReason = "completed";
        }
        result.durationMs = Date.now() - startedAt;
        options.onChange(result);
        resolve();
      };
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (requestedStatus) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length && !requestedStatus) {
        const newline = buffer.indexOf(0x0a, offset);
        const end = newline < 0 ? buffer.length : newline;
        if (!appendStdoutLine(buffer.subarray(offset, end))) return;
        if (newline < 0) return;
        processStdoutLine();
        offset = newline + 1;
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (requestedStatus) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, limits.stderrBytes - rawStderrBytes);
      rawStderrBytes += buffer.length;
      if (remaining > 0) result.stderr += buffer.subarray(0, remaining).toString("utf8");
      result.stderrTruncatedBytes = Math.max(0, rawStderrBytes - limits.stderrBytes);
      if (rawStderrBytes > limits.stderrBytes) requestTermination("limited", "stderr_limit");
    });
    child.on("error", (error) => requestTermination("failed", "spawn_error", error.message));
    child.once("close", finish);

    const timeoutTimer = setTimeout(() => requestTermination("limited", "timeout"), agent.timeoutMs);
    const abortHandler = (): void => requestTermination("cancelled", "abort");
    if (options.signal?.aborted) abortHandler();
    else options.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      await closedPromise;
    } finally {
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abortHandler);
    }
    if (!result.output && result.stderr && (result.status as SubagentStatus) !== "complete") {
      result.errorMessage ??= result.stderr.trim();
    }
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

const TaskSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 64, description: "Agent role name" }),
  task: Type.String({ minLength: 1, maxLength: SUBAGENT_LIMITS.taskCharacters, description: "Bounded task for the role" }),
});

const ChainTaskSchema = Type.Object({
  agent: Type.String({ minLength: 1, maxLength: 64, description: "Agent role name" }),
  task: Type.String({ minLength: 1, maxLength: SUBAGENT_LIMITS.taskCharacters, description: "Task with optional {previous} handoff placeholder" }),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Agent role for single mode" })),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: SUBAGENT_LIMITS.taskCharacters, description: "Task for single mode" })),
  tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: SUBAGENT_LIMITS.maxTasks, description: "Parallel role tasks" })),
  chain: Type.Optional(Type.Array(ChainTaskSchema, { minItems: 1, maxItems: SUBAGENT_LIMITS.maxTasks, description: "Sequential role tasks; {previous} inserts the prior result" })),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Model for every task as provider/model; inherit uses each role setting or the active parent" })),
  thinking: Type.Optional(Type.String({ minLength: 1, maxLength: 16, description: "Thinking effort for every task: off, minimal, low, medium, high, xhigh, max, or inherit" })),
  agentScope: Type.Optional(StringEnum(["user", "project", "both"] as const, {
    default: "user",
    description: "Role sources: user includes bundled and personal; project includes bundled and trusted project; both includes all",
  })),
});

type TaskInput = { agent: string; task: string };

type ToolUpdate = (partial: { content: Array<{ type: "text"; text: string }>; details: SubagentDetails }) => void;

function requestedAgents(params: { agent?: string; tasks?: TaskInput[]; chain?: TaskInput[] }): string[] {
  if (params.agent) return [params.agent];
  return (params.tasks ?? params.chain ?? []).map((task) => task.agent);
}

function formatUsage(usage: SubagentUsage): string {
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`, `${usage.totalTokens} tokens`];
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function taskSummary(result: SubagentTaskResult): string {
  return `${result.id} · ${result.agent} · ${result.status} · ${formatUsage(result.usage)}`;
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
  const capped = truncateUtf8(text, Math.max(0, maxBytes - Buffer.byteLength(marker)));
  return capped.omittedBytes ? `${capped.text}${marker}` : text;
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

export function registerSubagentTool(pi: ExtensionAPI, options: SubagentRuntimeOptions = {}): void {
  const limits = { ...SUBAGENT_LIMITS, ...options.limits };
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;

  pi.registerTool({
    name: "subagent",
    label: "Subagents",
    description: "Delegate one task, up to eight parallel tasks, or a sequential chain to isolated Pi child roles. Set model as provider/model and thinking as a separate supported effort level; both apply to every task in the call. Bundled and personal roles are available by default; trusted project roles require project/both scope and confirmation. Children have explicit local and web tools, load pi-web-access explicitly, discover skills, keep arbitrary extensions and prompt templates disabled, and enforce at most 12 turns, ten minutes, a 32 MiB JSONL line, 2 MiB retained trace, 64 KiB stderr, and 50 KiB returned output per task.",
    promptSnippet: "Delegate bounded specialist work to isolated KillerOS subagents",
    promptGuidelines: [
      "Use subagent for clearly separable specialist work; prefer read-only scout, planner, reviewer, or security roles before a writer.",
      "Do not request multiple write-capable subagents in one parallel batch.",
      "Every child can load relevant skills with read and can use web_search, source_check, fetch_content, and get_search_content for external research.",
      "When the user names a model or thinking effort, pass model and thinking separately; use inherit when the active parent or role setting should decide.",
    ],
    parameters: SubagentParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
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
      if (hasParallel) {
        const writers = inputs.filter((input) => roles.get(input.agent)!.access === "write");
        if (writers.length > 1) throw new Error("Parallel batches may contain at most one write-capable subagent; writers are serialized");
      }

      const invocationPrefix = randomUUID().slice(0, 8);
      const createTaskId = options.createTaskId ?? ((index: number) => `${invocationPrefix}-${index + 1}`);
      const results = inputs.map((input, index) => makeQueuedResult(createTaskId(index), input.agent, input.task, hasChain ? index + 1 : undefined));
      const emit = (message = `${mode}: ${results.filter((result) => !["queued", "running"].includes(result.status)).length}/${results.length} settled`): void => {
        (onUpdate as ToolUpdate | undefined)?.({
          content: [{ type: "text", text: message }],
          details: cloneDetails(mode, scope, discovery.projectAgentsDir, results),
        });
      };
      const runAt = async (index: number, task: string): Promise<void> => {
        if (signal?.aborted) {
          results[index] = { ...results[index]!, status: "cancelled", terminationReason: "abort" };
          emit();
          return;
        }
        const input = inputs[index]!;
        if ([...task].length > limits.taskCharacters) {
          results[index] = {
            ...results[index]!,
            status: "failed",
            terminationReason: "task_limit",
            errorMessage: `Expanded task exceeds ${limits.taskCharacters} characters`,
          };
          emit();
          return;
        }
        results[index] = await runTask({
          cwd: ctx.cwd,
          agent: roles.get(input.agent)!,
          task,
          id: results[index]!.id,
          step: results[index]!.step,
          model: resolvedModels.get(input.agent)!,
          signal,
          webExtension: options.webExtension,
          projectTrusted: ctx.isProjectTrusted(),
          spawnProcess,
          limits,
          onChange: (next) => {
            results[index] = cloneResult(next);
            emit();
          },
        });
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
        for (const result of results) {
          if (result.status === "queued") {
            result.status = signal?.aborted ? "cancelled" : "failed";
            result.terminationReason = signal?.aborted ? "abort" : "chain_stopped";
          }
        }
      } else if (hasParallel) {
        const readIndexes = inputs.map((input, index) => ({ input, index })).filter(({ input }) => roles.get(input.agent)!.access === "read");
        const writerIndex = inputs.findIndex((input) => roles.get(input.agent)!.access === "write");
        await mapReadTasks(readIndexes, limits.maxReadConcurrency, async ({ index }) => runAt(index, inputs[index]!.task));
        if (writerIndex >= 0) await runAt(writerIndex, inputs[writerIndex]!.task);
      } else {
        await runAt(0, inputs[0]!.task);
      }

      const details = cloneDetails(mode, scope, discovery.projectAgentsDir, results);
      return {
        content: [{ type: "text", text: buildToolContent(mode, details.results, limits.toolOutputBytes) }],
        details,
        usage: details.aggregateUsage,
      };
    },

    renderCall(args, theme) {
      const scope = args.agentScope ?? "user";
      if (args.tasks?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `parallel ${args.tasks.length}`)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
      if (args.chain?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `chain ${args.chain.length}`)}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent ?? "…")}${theme.fg("dim", ` · ${scope}`)}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }
      if (!expanded) {
        const lines = details.results.map((task) => {
          const status = theme.fg(statusColor(task.status), `${statusIcon(task.status)} ${task.status}`);
          return `${status} ${theme.fg("toolTitle", theme.bold(task.agent))}${theme.fg("dim", ` · ${task.id} · ${formatUsage(task.usage)}`)}`;
        });
        lines.push(theme.fg("dim", `Total · ${formatUsage(details.aggregateUsage)} · Ctrl+O to expand`));
        return new Text(lines.join("\n"), 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("toolTitle", theme.bold(`Subagents · ${details.mode}`)), 0, 0));
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
