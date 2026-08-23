import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const INIT_READ_TOOL = "killeros_init_read";
export const INIT_LIST_TOOL = "killeros_init_list";

const SNAPSHOT_LIMIT = 40 * 1024;
const AUTOMATIC_FILE_LIMIT = 8 * 1024;
const READ_LIMIT = 32 * 1024;
const PATH_LIMIT = 400;
const DIRECTORY_LIMIT = 120;
const DEPTH_LIMIT = 4;
const EXCLUDED_DIRS = new Set([
  ".agents", ".claude", ".git", ".next", ".pi", ".pytest_cache", ".turbo", ".venv", "__pycache__", "archive", "build", "coverage", "data", "dist", "logs", "node_modules", "target", "test-results", "vendor",
]);
const EXCLUDED_GUIDANCE = new Set([
  ".cursorrules", "agents.md", "agents.local.md", "claude.md", "claude.local.md", "copilot-instructions.md", "gemini.md", "memory.md", "skill.md",
]);
const ROOT_EVIDENCE = [
  "README.md", "README.rst", "README.txt", "CONTRIBUTING.md", "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Makefile", "Dockerfile", "compose.yaml", "compose.yml", "config.yaml", "config.yml", "tsconfig.json", "vite.config.ts", "vite.config.js", "eslint.config.js", "eslint.config.mjs",
] as const;
const NESTED_EVIDENCE = new Set(["package.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod"]);

export interface InitEvidenceIndex {
  projectRoot: string;
  canonicalPaths: ReadonlyMap<string, string>;
  snapshot: string;
}

export interface InitEvidenceBuildResult {
  index: InitEvidenceIndex;
}

function evidenceKey(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sensitiveEvidencePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const name = path.posix.basename(normalized);
  return /^\.env(?:\.|$)/u.test(name)
    || [".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials.json"].includes(name)
    || /^service-account.*\.json$/u.test(name)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(name);
}

function excludedPath(relativePath: string): boolean {
  const segments = relativePath.replaceAll("\\", "/").split("/");
  return segments.some((segment, index) =>
    (index < segments.length - 1 && EXCLUDED_DIRS.has(segment.toLowerCase()))
    || EXCLUDED_GUIDANCE.has(segment.toLowerCase()))
    || sensitiveEvidencePath(relativePath);
}

async function collectCandidates(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const queue: Array<{ relativePath: string; depth: number }> = [{ relativePath: "", depth: 0 }];
  let directoriesRead = 0;
  while (queue.length && files.length < PATH_LIMIT && directoriesRead < DIRECTORY_LIMIT) {
    const current = queue.shift()!;
    directoriesRead += 1;
    let entries;
    try {
      entries = await fs.readdir(path.join(projectRoot, current.relativePath), { withFileTypes: true });
    } catch (error) {
      if (!current.relativePath) throw error;
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= PATH_LIMIT) break;
      const relativePath = path.posix.join(current.relativePath.replaceAll("\\", "/"), entry.name);
      if (entry.isDirectory()) {
        if (current.depth < DEPTH_LIMIT && !EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          queue.push({ relativePath, depth: current.depth + 1 });
        }
      } else if (entry.isFile() && !excludedPath(relativePath)) {
        try {
          const stat = await fs.lstat(path.join(projectRoot, relativePath));
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) files.push(relativePath);
        } catch {
          // Files may disappear while the bounded map is collected.
        }
      }
    }
  }
  return files;
}

async function gitIgnoredPaths(projectRoot: string, candidates: readonly string[]): Promise<ReadonlySet<string>> {
  if (!candidates.length) return new Set();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    const child = spawn("git", ["-C", projectRoot, "check-ignore", "--stdin", "-z"], {
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("Git ignore inspection failed; /init did not build repository evidence"));
    };
    const succeed = (value: ReadonlySet<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail();
    }, 2_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 256 * 1024) {
        child.kill("SIGKILL");
        fail();
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.once("error", fail);
    child.stdin.once("error", () => {
      child.kill("SIGKILL");
      fail();
    });
    child.once("close", (code) => {
      if (code === 1) {
        if (stdout.length) fail();
        else succeed(new Set());
        return;
      }
      if (code !== 0 || !stdout.length || stdout.at(-1) !== 0) {
        fail();
        return;
      }
      let values: string[];
      try {
        values = new TextDecoder("utf-8", { fatal: true }).decode(stdout.subarray(0, -1)).split("\0");
      } catch {
        fail();
        return;
      }
      const candidateSet = new Set(candidates.map(evidenceKey));
      const ignored = new Set(values.map(evidenceKey));
      if (values.some((value) => !value || !candidateSet.has(evidenceKey(value))) || ignored.size !== values.length) {
        fail();
        return;
      }
      succeed(ignored);
    });
    child.stdin.end(`${candidates.join("\0")}\0`);
  });
}

function decodeCompleteUtf8(bytes: Buffer): string {
  return new StringDecoder("utf8").write(bytes);
}

function appendWithinLimit(current: string, section: string, limit: number): string {
  const remaining = limit - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(section, "utf8");
  return current + decodeCompleteUtf8(bytes.subarray(0, remaining));
}

async function validateAndRead(projectRoot: string, absolutePath: string, limit: number): Promise<{ content: string; truncated: boolean }> {
  const relative = path.relative(projectRoot, absolutePath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path is not available to /init");
  }
  let current = projectRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("/init rejects symbolic-link and junction paths");
  }
  const pathStat = await fs.lstat(absolutePath);
  if (!pathStat.isFile() || pathStat.nlink !== 1) throw new Error("/init rejects linked and non-regular files");
  const handle = await fs.open(absolutePath, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink !== 1
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error("/init file changed while it was being opened");
    }
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, Math.min(bytesRead, limit));
    if (data.includes(0)) throw new Error("/init rejects binary files");
    return { content: decodeCompleteUtf8(data), truncated: bytesRead > limit };
  } finally {
    await handle.close();
  }
}

function normalizeRequestedPath(requestedPath: string): string {
  if (!requestedPath || requestedPath.trim() !== requestedPath || requestedPath.startsWith("~")
    || /^file:/iu.test(requestedPath) || path.isAbsolute(requestedPath)) {
    throw new Error("path is not available to /init");
  }
  const normalized = requestedPath.replaceAll("\\", "/");
  if (!normalized || normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new Error("path is not available to /init");
  }
  return normalized.replace(/^\.\//u, "");
}

export async function buildInitEvidence(projectRoot: string): Promise<InitEvidenceBuildResult> {
  const candidates = await collectCandidates(projectRoot);
  const ignored = await gitIgnoredPaths(projectRoot, candidates);
  const canonicalPaths = new Map<string, string>();
  for (const relativePath of candidates) {
    if (!ignored.has(evidenceKey(relativePath))) canonicalPaths.set(evidenceKey(relativePath), relativePath);
  }

  let snapshot = [
    "# KillerOS repository snapshot",
    "Root AGENTS.md is protected policy and is intentionally not part of this untrusted evidence.",
    "",
    "## Project files",
    [...canonicalPaths.values()].join("\n"),
  ].join("\n");
  snapshot = appendWithinLimit("", snapshot, SNAPSHOT_LIMIT);
  const automatic = new Set<string>(ROOT_EVIDENCE);
  for (const relativePath of canonicalPaths.values()) {
    const name = path.posix.basename(relativePath);
    if (NESTED_EVIDENCE.has(name) || /^\.github\/workflows\/[^/]+\.ya?ml$/iu.test(relativePath)) automatic.add(relativePath);
  }
  for (const requested of automatic) {
    const relativePath = canonicalPaths.get(evidenceKey(requested));
    if (!relativePath || Buffer.byteLength(snapshot, "utf8") >= SNAPSHOT_LIMIT) continue;
    try {
      const result = await validateAndRead(projectRoot, path.join(projectRoot, relativePath), AUTOMATIC_FILE_LIMIT);
      const suffix = result.truncated ? "\n[truncated by /init]" : "";
      snapshot = appendWithinLimit(snapshot, `\n\n## ${relativePath}\n${result.content}${suffix}`, SNAPSHOT_LIMIT);
    } catch {
      // A mapped file may become unsafe or disappear before snapshot creation.
    }
  }
  return { index: { projectRoot, canonicalPaths, snapshot } };
}

export async function readInitEvidence(index: InitEvidenceIndex, requestedPath: string): Promise<string> {
  const normalized = normalizeRequestedPath(requestedPath);
  const relativePath = index.canonicalPaths.get(evidenceKey(normalized));
  if (!relativePath) throw new Error(`${requestedPath} is not available to /init`);
  const result = await validateAndRead(index.projectRoot, path.join(index.projectRoot, relativePath), READ_LIMIT);
  return result.truncated ? `${result.content}\n[truncated by /init at ${READ_LIMIT} bytes]` : result.content;
}

export async function readGeneratedInitTarget(projectRoot: string, targetPath: string): Promise<string> {
  const result = await validateAndRead(projectRoot, targetPath, READ_LIMIT);
  return result.truncated ? `${result.content}\n[truncated by /init at ${READ_LIMIT} bytes]` : result.content;
}

export function listInitEvidence(index: InitEvidenceIndex, requestedPath = "."): string[] {
  const prefix = requestedPath === "." ? "" : normalizeRequestedPath(requestedPath).replace(/\/$/u, "");
  const prefixWithSlash = prefix ? `${prefix}/` : "";
  const evidencePrefix = evidenceKey(prefixWithSlash);
  const children = new Set<string>();
  let found = !prefix;
  for (const relativePath of index.canonicalPaths.values()) {
    if (!evidenceKey(relativePath).startsWith(evidencePrefix)) continue;
    const remainder = relativePath.slice(prefixWithSlash.length);
    if (!remainder) continue;
    found = true;
    children.add(remainder.split("/")[0]!);
  }
  if (!found) throw new Error(`${requestedPath} is not available to /init`);
  return [...children].sort((left, right) => left.localeCompare(right)).slice(0, PATH_LIMIT);
}
