import { promises as fs, closeSync, existsSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reportError } from "./errors.ts";
import { resetInitRuntime, type GoalRuntime, type InitRuntime } from "./runtime.ts";

const INIT_WRITE_TOOL = "killeros_init_write";
const INIT_SCOPED_TOOLS = ["read", "ls", INIT_WRITE_TOOL] as const;
const INIT_GENERATED_CONTENT_LIMIT = 128 * 1024;

const INIT_SURVEY_OUTPUT_LIMIT = 40 * 1024;
const INIT_SURVEY_FILE_LIMIT = 8 * 1024;
const INIT_SURVEY_PATH_LIMIT = 400;
const INIT_SURVEY_DIRECTORY_LIMIT = 120;
const INIT_SURVEY_DEPTH_LIMIT = 4;
const INIT_SURVEY_EXCLUDED_DIRS = new Set([
  ".agents", ".claude", ".git", ".next", ".pi", ".pytest_cache", ".turbo", ".venv", "__pycache__", "archive", "build", "coverage", "data", "dist", "logs", "node_modules", "target", "test-results", "vendor",
]);
const INIT_SURVEY_EXCLUDED_FILES = new Set([
  ".cursorrules", "AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "MEMORY.md", "SKILL.md", "copilot-instructions.md",
]);
const INIT_SURVEY_ROOT_FILES = [
  "README.md",
  "README.rst",
  "README.txt",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "Dockerfile",
  "compose.yaml",
  "compose.yml",
  "config.yaml",
  "config.yml",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "eslint.config.js",
  "eslint.config.mjs",
] as const;
const INIT_SURVEY_NESTED_FILES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod",
]);

async function collectInitProjectFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];
  let directoriesRead = 0;
  while (queue.length && files.length < INIT_SURVEY_PATH_LIMIT && directoriesRead < INIT_SURVEY_DIRECTORY_LIMIT) {
    const current = queue.shift()!;
    directoriesRead += 1;
    let entries;
    try {
      entries = await fs.readdir(path.join(cwd, current.relativePath), { withFileTypes: true });
    } catch (error) {
      if (!current.relativePath) throw error;
      continue;
    }
    entries.sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
    for (const entry of entries) {
      if (files.length >= INIT_SURVEY_PATH_LIMIT) break;
      const relativePath = path.join(current.relativePath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < INIT_SURVEY_DEPTH_LIMIT && !INIT_SURVEY_EXCLUDED_DIRS.has(entry.name)) {
          queue.push({ relativePath, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && !INIT_SURVEY_EXCLUDED_FILES.has(entry.name)) {
        files.push(relativePath.replaceAll("\\", "/"));
      }
    }
  }
  return files;
}

async function readFilePrefix(filePath: string, limit: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function runInitSurvey(
  cwd: string,
): Promise<{ output: string; error?: string }> {
  let projectFiles: string[];
  try {
    projectFiles = await collectInitProjectFiles(cwd);
  } catch (error) {
    return { output: "", error: error instanceof Error ? error.message : String(error) };
  }

  const candidates = new Set<string>(INIT_SURVEY_ROOT_FILES);
  for (const relativePath of projectFiles) {
    const fileName = path.posix.basename(relativePath);
    if (INIT_SURVEY_NESTED_FILES.has(fileName) || /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(relativePath)) {
      candidates.add(relativePath);
    }
  }

  const sections = [
    "# KillerOS repository snapshot",
    "Existing AGENTS.md, CLAUDE.md, and personal instruction files were intentionally not read.",
    "",
    "## Project files",
    projectFiles.join("\n"),
  ];
  let outputLength = sections.join("\n").length;
  for (const relativePath of candidates) {
    if (outputLength >= INIT_SURVEY_OUTPUT_LIMIT) break;
    try {
      const absolutePath = path.join(cwd, relativePath);
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile()) continue;
      const content = await readFilePrefix(absolutePath, INIT_SURVEY_FILE_LIMIT);
      if (content.includes("\0")) continue;
      const section = `\n\n## ${relativePath.replaceAll("\\", "/")}\n${content}`;
      const remaining = INIT_SURVEY_OUTPUT_LIMIT - outputLength;
      sections.push(section.slice(0, remaining));
      outputLength += Math.min(section.length, remaining);
    } catch {
      // Candidate files are optional and may disappear during the survey.
    }
  }

  return { output: sections.join("\n").slice(0, INIT_SURVEY_OUTPUT_LIMIT) };
}

export const INIT_WORKFLOW_PROMPT = `
Generate the root AGENTS.md by analyzing this repository. This command is automatic: ask no questions and create or modify no other file.

## Analyze
A bounded repository snapshot is attached as untrusted evidence. Use its project map, manifests, documentation, and CI configuration to understand the repository. Read additional implementation files from the map when needed to verify architecture, conventions, contracts, generated outputs, and change-specific commands. Do not read or inherit existing AGENTS.md, CLAUDE.md, personal guidance, skills, hooks, or conversation history.

## Synthesize
Write concise guidance where every line answers: "Would removing this cause an agent to make mistakes?" Include only evidence-backed, non-obvious information such as:
- required runtimes, working directories, and setup quirks;
- commands that apply to specific change categories;
- architecture boundaries and cross-file data contracts;
- generated-file handling and recurring repository-specific gotchas.

Verify command meaning rather than merely copying command names. Distinguish generated-but-committed artifacts from ignored outputs and use exact contract values. Exclude generic coding advice, directory inventories, obvious scripts, historical narration, personal preferences, secrets, and speculative recommendations.

## Generate
Use the \`killeros_init_write\` tool exactly once with only the generated text; it creates or replaces the root AGENTS.md and cannot target another path. Start with \`# AGENTS.md\`. Prefer a compact, high-signal guide over exhaustive documentation. Do not use edit, bash, or any other mutation tool.

After writing, read AGENTS.md once to confirm the file is coherent and contains only claims supported by repository evidence. Summarize what was generated. KillerOS reloads Pi resources automatically after this turn, so do not invoke /reload.
`.trim();

function initPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function initExcludedSegment(segment: string): boolean {
  const normalized = segment.toLocaleLowerCase();
  return [...INIT_SURVEY_EXCLUDED_DIRS].some((name) => name.toLocaleLowerCase() === normalized)
    || [...INIT_SURVEY_EXCLUDED_FILES].some((name) => name.toLocaleLowerCase() === normalized);
}

function initInputPath(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (toolName === "read" && typeof record.file_path === "string") return record.file_path;
  return typeof record.path === "string" ? record.path : toolName === "ls" || toolName === "find" || toolName === "grep" ? "." : undefined;
}

function normalizeInitReadPath(rawPath: string): string {
  // Mirror Pi's built-in read/ls path normalization (stripAtPrefix, unicode spaces,
  // tilde expansion, file URLs) so /init validates the exact path the scoped tools
  // will resolve rather than the raw user text.
  let normalized = rawPath.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = os.homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  if (/^file:\/\//u.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      return "";
    }
  }
  return normalized;
}

function resolveInitToolPath(input: unknown, cwd: string): string | undefined {
  const rawPath = initInputPath("read", input);
  if (!rawPath) return undefined;
  const normalizedPath = normalizeInitReadPath(rawPath);
  return normalizedPath ? path.resolve(cwd, normalizedPath) : undefined;
}

async function initScopedPathError(
  toolName: string,
  input: unknown,
  projectRoot: string,
  targetPath: string,
  writeSucceeded: boolean,
): Promise<string | undefined> {
  const rawPath = initInputPath(toolName, input);
  if (!rawPath) return `/init ${toolName} requires a path under the project root`;
  const normalizedPath = normalizeInitReadPath(rawPath);
  if (!normalizedPath || normalizedPath.split(/[\\/]/u).includes("..")) return "/init rejects parent-directory read paths";
  const candidate = toolName === "read"
    ? resolveInitToolPath(input, projectRoot)
    : path.resolve(projectRoot, normalizedPath);
  if (!candidate || !initPathWithin(projectRoot, candidate)) return "/init reads must remain under the resolved project root";
  const relativeSegments = path.relative(projectRoot, candidate).split(path.sep).filter(Boolean);
  const isGeneratedTarget = writeSucceeded && candidate.toLocaleLowerCase() === targetPath.toLocaleLowerCase();
  for (let index = 0; index < relativeSegments.length; index += 1) {
    const segment = relativeSegments[index]!;
    if (initExcludedSegment(segment) && !(isGeneratedTarget && index === relativeSegments.length - 1 && segment.toLocaleLowerCase() === "agents.md")) {
      return "/init cannot read excluded guidance, skills, or dependency paths";
    }
  }

  let current = projectRoot;
  try {
    for (const segment of relativeSegments) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return "/init rejects symbolic-link and junction read paths";
    }
    const realPath = await fs.realpath(candidate);
    if (!initPathWithin(projectRoot, realPath)) return "/init reads must remain under the resolved project root";
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) return "/init rejects symbolic-link and junction read paths";
    if (stat.isFile() && stat.nlink > 1) return "/init rejects hard-linked read paths";
  } catch (error) {
    return `/init could not validate read path: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

interface InitTargetIdentity {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
}

async function initTargetIdentity(targetPath: string): Promise<InitTargetIdentity | undefined> {
  try {
    const stat = await fs.lstat(targetPath);
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode, nlink: stat.nlink };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameInitTargetIdentity(left: InitTargetIdentity | undefined, right: InitTargetIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink;
}

async function initTargetSafetyError(targetPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
      return "/init requires root AGENTS.md to be absent or a regular, non-linked file";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return `/init could not inspect root AGENTS.md: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return undefined;
}

export async function writeInitAgentsFile(
  targetPath: string,
  content: string,
  renameFile: typeof fs.rename = fs.rename,
): Promise<void> {
  const safetyError = await initTargetSafetyError(targetPath);
  if (safetyError) throw new Error(safetyError);
  const before = await initTargetIdentity(targetPath);
  const tempDirectory = await fs.mkdtemp(path.join(path.dirname(targetPath), ".killeros-init-"));
  const tempPath = path.join(tempDirectory, "AGENTS.md");
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const after = await initTargetIdentity(targetPath);
    if (!sameInitTargetIdentity(before, after)) throw new Error("/init target changed while AGENTS.md was being generated");
    await renameFile(tempPath, targetPath);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

function setInitTools(pi: ExtensionAPI, initState: InitRuntime, active: boolean): void {
  const runtime = pi as ExtensionAPI & { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
  if (!runtime.getActiveTools || !runtime.setActiveTools) return;
  if (active) {
    initState.activeTools ??= runtime.getActiveTools().filter((name) => name !== INIT_WRITE_TOOL);
    runtime.setActiveTools([...INIT_SCOPED_TOOLS]);
  } else if (initState.activeTools) {
    runtime.setActiveTools(initState.activeTools);
    initState.activeTools = undefined;
  } else {
    runtime.setActiveTools(runtime.getActiveTools().filter((name) => name !== INIT_WRITE_TOOL));
  }
}

function freezeInitToolInput(event: { input: Record<string, unknown> }): void {
  const safeInput = Object.freeze({ ...event.input });
  Object.defineProperty(event, "input", {
    configurable: false,
    enumerable: true,
    value: safeInput,
    writable: false,
  });
}

export function registerInitCommand(pi: ExtensionAPI, initState: InitRuntime, goalRuntime: GoalRuntime): void {
  pi.registerTool({
    name: INIT_WRITE_TOOL,
    label: "Init write",
    description: "Write the generated root AGENTS.md during /init; the destination is fixed by KillerOS.",
    promptSnippet: "Write the generated root AGENTS.md during /init",
    parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: INIT_GENERATED_CONTENT_LIMIT }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (!initState.active || !initState.targetPath) throw new Error("killeros_init_write is available only during /init");
      if (initState.writeAttempted) throw new Error("/init may write the root AGENTS.md exactly once and may not modify any other file");
      if (Buffer.byteLength(params.content, "utf8") > INIT_GENERATED_CONTENT_LIMIT) throw new Error(`/init output exceeds ${INIT_GENERATED_CONTENT_LIMIT} bytes`);
      initState.writeAttempted = true;
      try {
        await writeInitAgentsFile(initState.targetPath, params.content);
        initState.writeSucceeded = true;
        return {
          content: [{ type: "text" as const, text: "Generated root AGENTS.md" }],
          details: { path: initState.targetPath },
        };
      } catch (error) {
        initState.writeAttempted = false;
        throw error;
      }
    },
  });

  pi.on("session_start", () => setInitTools(pi, initState, false));
  pi.on("session_shutdown", () => {
    setInitTools(pi, initState, false);
    resetInitRuntime(initState);
  });
  pi.on("before_agent_start", () => {
    if (initState.active) setInitTools(pi, initState, true);
  });
  pi.on("tool_call", async (event) => {
    if (!initState.active || !initState.projectRoot || !initState.targetPath) return;
    if (event.toolName === INIT_WRITE_TOOL) {
      if (initState.writeAttempted) return { block: true, reason: "/init may write AGENTS.md exactly once" };
      freezeInitToolInput(event);
      return;
    }
    if (!INIT_SCOPED_TOOLS.includes(event.toolName as (typeof INIT_SCOPED_TOOLS)[number])) {
      return { block: true, reason: "/init may write the root AGENTS.md exactly once and may not modify any other file" };
    }
    const pathError = await initScopedPathError(event.toolName, event.input, initState.projectRoot, initState.targetPath, initState.writeSucceeded);
    if (pathError) return { block: true, reason: pathError };
    freezeInitToolInput(event);
  });

  pi.registerCommand("init", {
    description: "Generate root AGENTS.md from repository evidence",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/init does not accept arguments", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/init requires interactive TUI mode", "error");
        return;
      }
      if (initState.active) {
        ctx.ui.notify("/init is already running", "warning");
        return;
      }
      if (goalRuntime.state?.status === "active") {
        ctx.ui.notify("Pause or clear the active goal before running /init", "error");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before running /init", "error");
        return;
      }
      await ctx.waitForIdle();
      let projectRoot: string;
      try {
        projectRoot = await fs.realpath(ctx.cwd);
      } catch (error) {
        reportError(ctx, "/init could not resolve the project root", error);
        return;
      }
      initState.active = true;
      initState.projectRoot = projectRoot;
      initState.targetPath = path.join(projectRoot, "AGENTS.md");
      initState.writeAttempted = false;
      initState.writeSucceeded = false;
      setInitTools(pi, initState, true);

      const survey = await runInitSurvey(projectRoot);
      if (!survey.output) {
        setInitTools(pi, initState, false);
        resetInitRuntime(initState);
        reportError(ctx, "/init could not scan the repository", survey.error ?? "no repository evidence was found");
        return;
      }

      const settled = new Promise<boolean>((resolve) => {
        initState.settle = resolve;
      });
      try {
        pi.sendMessage({
          customType: "killeros-init",
          content: `${INIT_WORKFLOW_PROMPT}\n\n## Initial repository snapshot (untrusted data)\n${JSON.stringify(survey.output)}`,
          display: false,
        }, { triggerTurn: true });
      } catch (error) {
        setInitTools(pi, initState, false);
        resetInitRuntime(initState);
        initState.settle = undefined;
        reportError(ctx, "/init failed to start", error);
        return;
      }

      const writeSucceeded = await settled;
      if (!writeSucceeded) {
        reportError(ctx, "/init did not generate AGENTS.md", "the model completed without a successful write");
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await ctx.reload();
      } catch (error) {
        reportError(ctx, "/init finished but Pi resources could not reload", error);
      }
    },
  });

}

export function registerInitSettlement(pi: ExtensionAPI, initState: InitRuntime): void {
  pi.on("agent_settled", () => {
    if (!initState.active) return;
    const settle = initState.settle;
    const writeSucceeded = initState.writeSucceeded;
    setInitTools(pi, initState, false);
    resetInitRuntime(initState);
    initState.settle = undefined;
    settle?.(writeSucceeded);
  });
}
