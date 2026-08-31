import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { lstat, open, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inflate } from "node:zlib";

const GIT_TIMEOUT_MS = 1_000;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const SNAPSHOT_CONTENT_LIMIT = 128 * 1024 * 1024;
const MAX_DIFF_OPERATIONS = 500_000;
const MAX_FILES = 20;
const inflateAsync = promisify(inflate);

export type ChangeUnavailableReason = "not-git" | "timeout" | "too-large" | "error";

export type ChangedFile =
  | { kind: "added" | "modified" | "deleted"; path: string; additions: number; deletions: number; detail?: "binary" | "mode" }
  | { kind: "renamed"; path: string; previousPath: string; additions: number; deletions: number; detail?: "binary" | "mode" };

export type ChangeSummary =
  | { state: "available"; totalFiles: number; additions: number; deletions: number; files: ChangedFile[]; omittedFiles: number }
  | { state: "unavailable"; reason: ChangeUnavailableReason };

export type VerificationAttempt = { label: VerificationLabel; outcome: "passed" | "failed" };

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
const PACKAGE_SCRIPTS = ["test", "check", "lint", "typecheck", "build"] as const;
const GRADLE_COMMANDS = ["gradle", "gradlew", "gradlew.bat", "./gradlew", "./gradlew.bat", ".\\gradlew", ".\\gradlew.bat"] as const;

export const VERIFICATION_LABELS = [
  ...PACKAGE_MANAGERS.flatMap((manager) => [`${manager} test`, ...PACKAGE_SCRIPTS.map((script) => `${manager} run ${script}`)]),
  "python -m pytest", "py -m pytest", "node --test", "cargo clippy", "cargo check", "cargo test",
  "dotnet test", "mvn verify", "mvn test", "go test", "go vet", "pytest",
  ...GRADLE_COMMANDS.flatMap((command) => [`${command} test`, `${command} check`]),
].sort((left, right) => right.length - left.length) as readonly string[];

export type VerificationLabel = typeof VERIFICATION_LABELS[number];

export interface ChangeReceiptCollection {
  finish(): Promise<ChangeSummary>;
  dispose(): Promise<void>;
}

class GitFailure extends Error {
  readonly reason: Exclude<ChangeUnavailableReason, "not-git">;
  readonly stderr: Buffer;

  constructor(reason: Exclude<ChangeUnavailableReason, "not-git">, stderr = Buffer.alloc(0)) {
    super(reason);
    this.reason = reason;
    this.stderr = stderr;
  }
}

function runGit(cwd: string, args: readonly string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: GitFailure | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      failure = new GitFailure("timeout");
      child.kill();
    }, GIT_TIMEOUT_MS);
    timer.unref();
    const capture = (chunks: Buffer[], isStdout: boolean) => (chunk: Buffer): void => {
      const nextBytes = (isStdout ? stdoutBytes : stderrBytes) + chunk.length;
      if (nextBytes > GIT_OUTPUT_LIMIT) {
        failure = new GitFailure("too-large");
        child.kill();
        return;
      }
      if (isStdout) stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
      chunks.push(chunk);
    };
    child.stdout!.on("data", capture(stdout, true));
    child.stderr!.on("data", capture(stderr, false));
    if (input) child.stdin?.end(input);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitFailure("error"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new GitFailure("error", Buffer.concat(stderr)));
    });
  });
}

function decode(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function missingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

type Repository = { root: string; gitDirectory: string; commonDirectory: string; objectDirectory: string; filterNames: readonly string[] };
const repositoryCache = new Map<string, Promise<Repository>>();

async function repository(cwd: string): Promise<Repository> {
  const cached = repositoryCache.get(cwd);
  if (cached) return cached;
  const pending = (async () => {
    const result = decode(await runGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"])).trimEnd().split(/\r?\n/u);
    const [root, gitDirectory, commonDirectory] = result;
    if (!root || !gitDirectory || !commonDirectory) throw new GitFailure("error");
    const configKeys = decode(await runGit(root, ["config", "--null", "--name-only", "--list"])).split("\0");
    const filterNames = [...new Set(configKeys.filter((key) => /^filter\..*\.(clean|process)$/u.test(key)).map((key) => key.slice("filter.".length, key.lastIndexOf("."))))];
    return { root, gitDirectory, commonDirectory, objectDirectory: path.join(commonDirectory, "objects"), filterNames };
  })();
  repositoryCache.set(cwd, pending);
  try {
    return await pending;
  } catch (error) {
    repositoryCache.delete(cwd);
    throw error;
  }
}

type DirtyFile = {
  path: string;
  headMode?: string;
  headObjectId?: string;
  indexMode?: string;
  indexObjectId?: string;
  mode?: string;
  content?: Buffer;
  contentObjectId?: string;
};

async function readBoundedFile(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new GitFailure("error");
    if (stats.size > limit) throw new GitFailure("too-large");
    const content = Buffer.alloc(stats.size + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await handle.read(content, length, content.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new GitFailure("too-large");
    return content.subarray(0, length);
  } finally {
    await handle.close();
  }
}

type Snapshot = { head: string; files: Map<string, DirtyFile> };
type RepositoryMonitor = {
  changedPaths: Set<string>;
  inUse: boolean;
  repo: Repository;
  snapshot: Snapshot;
  watchFailed: boolean;
  watchers: Array<ReturnType<typeof watch>>;
};

const repositoryMonitors = new Map<string, RepositoryMonitor>();

function discardMonitor(monitor: RepositoryMonitor): void {
  for (const watcher of monitor.watchers) watcher.close();
  repositoryMonitors.delete(monitor.repo.root);
}

async function snapshot(repo: Repository, paths?: readonly string[]): Promise<Snapshot> {
  const output = decode(await runGit(repo.root, [
    "-c", "core.fsmonitor=false",
    ...repo.filterNames.flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`]),
    "status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all",
    ...(paths ? ["--", ...paths] : []),
  ]));
  const records = output.split("\0").filter(Boolean);
  const headRecord = records.find((record) => record.startsWith("# branch.oid "));
  if (!headRecord) throw new Error("missing HEAD state");
  const files = new Map<string, DirtyFile>();
  for (const record of records) {
    if (record.startsWith("# ")) continue;
    if (record.startsWith("u ")) throw new Error("unmerged index");
    if (record.startsWith("? ")) {
      const filePath = record.slice(2);
      if (!filePath || filePath.endsWith("/")) continue;
      files.set(filePath, {
        ...files.get(filePath),
        path: filePath,
        indexMode: undefined,
        indexObjectId: undefined,
        mode: "100644",
        contentObjectId: undefined,
      });
      continue;
    }
    const match = /^1 (\S{2}) \S+ ([0-7]{6}) ([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) (.*)$/su.exec(record);
    if (!match) throw new Error("invalid status record");
    const [, status, headMode, indexMode, worktreeMode, headObjectId, indexObjectId, filePath] = match;
    if (!status || !headMode || !indexMode || !worktreeMode || !headObjectId || !indexObjectId || !filePath) throw new Error("incomplete status record");
    const worktreeChanged = status[1] !== ".";
    const selectedMode = worktreeChanged ? worktreeMode : indexMode;
    files.set(filePath, {
      ...files.get(filePath),
      path: filePath,
      headMode: headMode === "000000" ? undefined : headMode,
      headObjectId: /^0+$/u.test(headObjectId) ? undefined : headObjectId,
      indexMode: indexMode === "000000" ? undefined : indexMode,
      indexObjectId: /^0+$/u.test(indexObjectId) ? undefined : indexObjectId,
      mode: selectedMode === "000000" ? undefined : selectedMode,
      contentObjectId: worktreeChanged || /^0+$/u.test(indexObjectId) ? undefined : indexObjectId,
    });
  }
  let totalBytes = 0;
  for (const file of files.values()) {
    if (!file.mode || file.contentObjectId) continue;
    const absolutePath = path.join(repo.root, ...file.path.split("/"));
    file.content = file.mode === "120000"
      ? Buffer.from(await readlink(absolutePath))
      : await readBoundedFile(absolutePath, SNAPSHOT_CONTENT_LIMIT - totalBytes);
    totalBytes += file.content.length;
    if (totalBytes > SNAPSHOT_CONTENT_LIMIT) throw new GitFailure("too-large");
  }
  return { head: headRecord.slice("# branch.oid ".length), files };
}

async function snapshotKnownPaths(repo: Repository, baseline: Snapshot, paths: readonly string[]): Promise<Snapshot | undefined> {
  const files = new Map<string, DirtyFile>();
  let totalBytes = 0;
  for (const filePath of paths) {
    const previous = baseline.files.get(filePath);
    if (!previous) return undefined;
    try {
      const absolutePath = path.join(repo.root, ...filePath.split("/"));
      const stats = await lstat(absolutePath);
      const mode = stats.isSymbolicLink() ? "120000" : stats.mode & 0o111 ? "100755" : "100644";
      const content = stats.isSymbolicLink()
        ? Buffer.from(await readlink(absolutePath))
        : await readBoundedFile(absolutePath, SNAPSHOT_CONTENT_LIMIT - totalBytes);
      totalBytes += content.length;
      if (totalBytes > SNAPSHOT_CONTENT_LIMIT) throw new GitFailure("too-large");
      files.set(filePath, { ...previous, mode, content, contentObjectId: undefined });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      files.set(filePath, { ...previous, mode: undefined, content: undefined });
    }
  }
  return { head: baseline.head, files };
}

async function currentHead(repo: Repository): Promise<string> {
  const head = (await readBoundedFile(path.join(repo.gitDirectory, "HEAD"), 4_096)).toString("ascii").trim();
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) return head;
  const match = /^ref: (refs\/[^\0\r\n]+)$/u.exec(head);
  const reference = match?.[1];
  if (!reference || reference.includes("\\") || reference.split("/").some((part) => part === "." || part === "..")) throw new GitFailure("error");
  try {
    return (await readBoundedFile(path.join(repo.commonDirectory, ...reference.split("/")), 4_096)).toString("ascii").trim();
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
  try {
    const packed = (await readBoundedFile(path.join(repo.commonDirectory, "packed-refs"), GIT_OUTPUT_LIMIT)).toString("ascii");
    const packedMatch = new RegExp(`^([0-9a-f]{40}(?:[0-9a-f]{24})?) ${reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu").exec(packed);
    return packedMatch?.[1] ?? "(initial)";
  } catch (error) {
    if (missingFile(error)) return "(initial)";
    throw error;
  }
}

function observes(filePath: string, observedPaths: readonly string[]): boolean {
  return observedPaths.includes(".") || observedPaths.some((observed) => filePath === observed || filePath.startsWith(`${observed}/`) || observed.startsWith(`${filePath}/`));
}

async function refreshSnapshot(monitor: RepositoryMonitor, observedPaths: readonly string[], current = monitor.snapshot): Promise<Snapshot> {
  if (monitor.watchFailed || observedPaths.length > 200) return snapshot(monitor.repo);
  if (observedPaths.length === 0) return current;
  const scoped = await snapshotKnownPaths(monitor.repo, current, observedPaths) ?? await snapshot(monitor.repo, observedPaths);
  const files = new Map(current.files);
  for (const filePath of files.keys()) {
    if (observes(filePath, observedPaths)) files.delete(filePath);
  }
  for (const [filePath, file] of scoped.files) files.set(filePath, file);
  return { head: scoped.head, files };
}

function createMonitor(repo: Repository, initialSnapshot: Snapshot): RepositoryMonitor {
  const changedPaths = new Set<string>();
  const monitor: RepositoryMonitor = {
    changedPaths,
    inUse: false,
    repo,
    snapshot: initialSnapshot,
    watchFailed: false,
    watchers: [],
  };
  const observe = (
    directory: string,
    options: { recursive?: boolean },
    callback: (event: "change" | "rename", filename: string | null) => void,
  ): void => {
    try {
      const watcher = watch(directory, options, callback);
      watcher.unref();
      watcher.on("error", () => { monitor.watchFailed = true; });
      monitor.watchers.push(watcher);
    } catch {
      monitor.watchFailed = true;
    }
  };
  observe(repo.root, { recursive: true }, (event, filename) => {
    if (!filename) {
      monitor.watchFailed = true;
      return;
    }
    const normalized = String(filename).replaceAll("\\", "/");
    if (normalized === ".git" || normalized.startsWith(".git/")) return;
    changedPaths.add(event === "rename" ? path.posix.dirname(normalized) : normalized);
  });
  observe(repo.gitDirectory, {}, (_event, filename) => {
    if (filename && String(filename).replaceAll("\\", "/") === "index") changedPaths.add(".");
  });
  return monitor;
}

async function looseBlob(objectDirectory: string, id: string): Promise<Buffer | undefined> {
  try {
    const inflated = await inflateAsync(await readFile(path.join(objectDirectory, id.slice(0, 2), id.slice(2))));
    const separator = inflated.indexOf(0);
    if (separator < 0 || !inflated.subarray(0, separator).toString("ascii").startsWith("blob ")) throw new Error("invalid blob");
    return inflated.subarray(separator + 1);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadHeadBlobs(repo: Repository, ids: readonly string[]): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const content = await looseBlob(repo.objectDirectory, id);
    if (content) blobs.set(id, content);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const output = await runGit(repo.root, ["cat-file", "--batch"], Buffer.from(`${missing.join("\n")}\n`));
    let offset = 0;
    for (const id of missing) {
      const headerEnd = output.indexOf(10, offset);
      const match = /^([0-9a-f]+) blob (\d+)$/u.exec(output.subarray(offset, headerEnd).toString("ascii"));
      if (!match || match[1] !== id) throw new Error("invalid batch blob");
      const size = Number(match[2]);
      const start = headerEnd + 1;
      const end = start + size;
      if (output[end] !== 10) throw new Error("invalid batch body");
      blobs.set(id, output.subarray(start, end));
      offset = end + 1;
    }
  }
  return blobs;
}

type FileState = { mode: string; content: Buffer };

function lines(content: Buffer): string[] {
  return (content.toString("latin1").match(/[^\n]*\n|[^\n]+$/gu) ?? [])
    .map((line) => line.endsWith("\r\n") ? `${line.slice(0, -2)}\n` : line);
}

function sameFileState(left: FileState | undefined, right: FileState | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.mode !== right.mode) return false;
  if (left.content.equals(right.content)) return true;
  if (isBinary(left.content) || isBinary(right.content)) return false;
  const leftLines = lines(left.content);
  const rightLines = lines(right.content);
  return leftLines.length === rightLines.length && leftLines.every((line, index) => line === rightLines[index]);
}

function lineDelta(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const left = lines(before);
  const right = lines(after);
  const maximum = left.length + right.length;
  let frontier = new Map<number, number>([[1, 0]]);
  let operations = 0;
  for (let distance = 0; distance <= maximum; distance += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      operations += 1;
      if (operations > MAX_DIFF_OPERATIONS) throw new GitFailure("too-large");
      let x = diagonal === -distance || diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1)
        ? frontier.get(diagonal + 1) ?? 0
        : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < left.length && y < right.length && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      if (x >= left.length && y >= right.length) {
        return { additions: (distance + right.length - left.length) / 2, deletions: (distance + left.length - right.length) / 2 };
      }
      next.set(diagonal, x);
    }
    frontier = next;
  }
  throw new Error("line diff failed");
}

function isBinary(content: Buffer): boolean {
  return content.subarray(0, 8_000).includes(0);
}

function binarySimilarity(left: Buffer, right: Buffer): number {
  const maximum = Math.max(left.length, right.length);
  if (maximum === 0) return 1;
  let equalBytes = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] === right[index]) equalBytes += 1;
  }
  return equalBytes / maximum;
}

// ponytail: fuzzy rename matching is quadratic up to 400 pairs; use Git's diff engine if larger rename batches matter.
async function compare(repo: Repository, baseline: Snapshot, settlement: Snapshot): Promise<ChangeSummary> {
  if (baseline.head !== settlement.head) throw new Error("HEAD changed during response");
  const paths = new Set([...baseline.files.keys(), ...settlement.files.keys()]);
  const ids = [...paths].flatMap((filePath) => {
    const sources = [baseline.files.get(filePath), settlement.files.get(filePath)];
    return sources.flatMap((source) => [source?.headObjectId, source?.indexObjectId, source?.contentObjectId].filter((id): id is string => Boolean(id)));
  });
  const headBlobs = await loadHeadBlobs(repo, ids);
  const current = (file: DirtyFile | undefined, fallback: DirtyFile | undefined): FileState | undefined => {
    if (file) {
      if (!file.mode) return undefined;
      const content = file.content ?? (file.contentObjectId ? headBlobs.get(file.contentObjectId) : undefined);
      if (!content) throw new Error("missing selected blob");
      return { mode: file.mode, content };
    }
    if (!fallback?.headMode || !fallback.headObjectId) return undefined;
    const content = headBlobs.get(fallback.headObjectId);
    if (!content) throw new Error("missing HEAD blob");
    return { mode: fallback.headMode, content };
  };
  const indexed = (file: DirtyFile | undefined, fallback: DirtyFile | undefined): FileState | undefined => {
    if (file) {
      if (!file.indexMode || !file.indexObjectId) return undefined;
      const content = headBlobs.get(file.indexObjectId);
      if (!content) throw new Error("missing index blob");
      return { mode: file.indexMode, content };
    }
    if (!fallback?.headMode || !fallback.headObjectId) return undefined;
    const content = headBlobs.get(fallback.headObjectId);
    if (!content) throw new Error("missing HEAD blob");
    return { mode: fallback.headMode, content };
  };
  const removed: Array<{ path: string; file: FileState }> = [];
  const added: Array<{ path: string; file: FileState }> = [];
  const modified: Array<{ path: string; before: FileState; after: FileState }> = [];
  for (const filePath of paths) {
    const beforeEntry = baseline.files.get(filePath);
    const afterEntry = settlement.files.get(filePath);
    const worktreeBefore = current(beforeEntry, afterEntry);
    const worktreeAfter = current(afterEntry, beforeEntry);
    const indexBefore = indexed(beforeEntry, afterEntry);
    const indexAfter = indexed(afterEntry, beforeEntry);
    const [before, after] = sameFileState(worktreeBefore, worktreeAfter)
      ? [indexBefore, indexAfter]
      : [worktreeBefore, worktreeAfter];
    if (sameFileState(before, after)) continue;
    if (!before && after) added.push({ path: filePath, file: after });
    else if (before && !after) removed.push({ path: filePath, file: before });
    else if (before && after) modified.push({ path: filePath, before, after });
  }

  const renames = new Map<string, { path: string; file: FileState; additions: number; deletions: number }>();
  const consumedAdditions = new Set<string>();
  for (const oldFile of removed) {
    const exact = added.find((candidate) => !consumedAdditions.has(candidate.path) && candidate.file.content.equals(oldFile.file.content));
    if (!exact) continue;
    renames.set(oldFile.path, { ...exact, additions: 0, deletions: 0 });
    consumedAdditions.add(exact.path);
  }
  if (removed.length * added.length <= 400) {
    for (const oldFile of removed) {
      if (renames.has(oldFile.path)) continue;
      const oldIsBinary = isBinary(oldFile.file.content);
      let best: { path: string; file: FileState; additions: number; deletions: number; score: number } | undefined;
      for (const candidate of added) {
        if (consumedAdditions.has(candidate.path) || isBinary(candidate.file.content) !== oldIsBinary) continue;
        const delta = oldIsBinary ? { additions: 0, deletions: 0 } : lineDelta(oldFile.file.content, candidate.file.content);
        const score = oldIsBinary
          ? binarySimilarity(oldFile.file.content, candidate.file.content)
          : (lines(oldFile.file.content).length + lines(candidate.file.content).length - delta.additions - delta.deletions)
            / (2 * Math.max(lines(oldFile.file.content).length, lines(candidate.file.content).length, 1));
        if (score >= 0.5 && (!best || score > best.score)) best = { ...candidate, ...delta, score };
      }
      if (!best) continue;
      renames.set(oldFile.path, best);
      consumedAdditions.add(best.path);
    }
  }

  const changes: ChangedFile[] = [];
  for (const oldFile of removed) {
    const rename = renames.get(oldFile.path);
    if (rename) {
      const binary = isBinary(oldFile.file.content) || isBinary(rename.file.content);
      changes.push({ kind: "renamed", path: rename.path, previousPath: oldFile.path, additions: rename.additions, deletions: rename.deletions, ...(binary ? { detail: "binary" as const } : oldFile.file.mode !== rename.file.mode && rename.additions === 0 && rename.deletions === 0 ? { detail: "mode" as const } : {}) });
      continue;
    }
    const binary = isBinary(oldFile.file.content);
    changes.push({ kind: "deleted", path: oldFile.path, additions: 0, deletions: binary ? 0 : lines(oldFile.file.content).length, ...(binary ? { detail: "binary" as const } : {}) });
  }
  for (const newFile of added) {
    if (consumedAdditions.has(newFile.path)) continue;
    const binary = isBinary(newFile.file.content);
    changes.push({ kind: "added", path: newFile.path, additions: binary ? 0 : lines(newFile.file.content).length, deletions: 0, ...(binary ? { detail: "binary" as const } : {}) });
  }
  for (const file of modified) {
    const binary = isBinary(file.before.content) || isBinary(file.after.content);
    const delta = binary || file.before.content.equals(file.after.content) ? { additions: 0, deletions: 0 } : lineDelta(file.before.content, file.after.content);
    changes.push({ kind: "modified", path: file.path, ...delta, ...(binary ? { detail: "binary" as const } : file.before.mode !== file.after.mode && file.before.content.equals(file.after.content) ? { detail: "mode" as const } : {}) });
  }
  changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const additions = changes.reduce((total, file) => total + file.additions, 0);
  const deletions = changes.reduce((total, file) => total + file.deletions, 0);
  return { state: "available", totalFiles: changes.length, additions, deletions, files: changes.slice(0, MAX_FILES), omittedFiles: Math.max(0, changes.length - MAX_FILES) };
}

function verificationLabel(command: string): VerificationLabel | undefined {
  if (/\r|\n|[&|;<>]/u.test(command)) return undefined;
  const trimmed = command.replace(/^[\t ]+/u, "");
  return VERIFICATION_LABELS.find((label) => trimmed === label || trimmed.startsWith(label) && /^[\t ]/u.test(trimmed.slice(label.length)));
}

export function recognizedVerification(command: unknown, failed: boolean): VerificationAttempt | undefined {
  if (typeof command !== "string") return undefined;
  const label = verificationLabel(command);
  return label ? { label, outcome: failed ? "failed" : "passed" } : undefined;
}

export async function beginChangeReceipt(cwd: string): Promise<ChangeReceiptCollection> {
  try {
    const repo = await repository(cwd);
    let monitor = repositoryMonitors.get(repo.root);
    if (!monitor) {
      monitor = createMonitor(repo, await snapshot(repo));
      repositoryMonitors.set(repo.root, monitor);
    }
    if (monitor.inUse) throw new Error("change collection already active");
    const idleChanges = [...monitor.changedPaths];
    monitor.changedPaths.clear();
    try {
      monitor.snapshot = await refreshSnapshot(monitor, idleChanges);
    } catch (error) {
      discardMonitor(monitor);
      throw error;
    }
    const baseline = monitor.snapshot;
    monitor.inUse = true;
    let disposed = false;
    return {
      finish: async () => {
        if (disposed) return { state: "unavailable", reason: "error" };
        disposed = true;
        try {
          let settlement = baseline;
          do {
            const observedPaths = [...monitor.changedPaths];
            monitor.changedPaths.clear();
            settlement = await refreshSnapshot(monitor, observedPaths, settlement);
          } while (monitor.changedPaths.size > 0);
          if (await currentHead(repo) !== baseline.head) throw new Error("HEAD changed during response");
          const summary = await compare(repo, baseline, settlement);
          monitor.snapshot = settlement;
          return summary;
        } catch (error) {
          discardMonitor(monitor);
          return { state: "unavailable", reason: error instanceof GitFailure ? error.reason : "error" };
        } finally {
          monitor.inUse = false;
        }
      },
      dispose: async () => {
        disposed = true;
        monitor.inUse = false;
      },
    };
  } catch (error) {
    const reason = error instanceof GitFailure && decode(error.stderr).includes("not a git repository")
      ? "not-git" as const
      : error instanceof GitFailure ? error.reason : "error";
    return { finish: async () => ({ state: "unavailable", reason }), dispose: async () => undefined };
  }
}

export function disposeChangeReceipts(): void {
  for (const monitor of repositoryMonitors.values()) discardMonitor(monitor);
  repositoryMonitors.clear();
  repositoryCache.clear();
}
