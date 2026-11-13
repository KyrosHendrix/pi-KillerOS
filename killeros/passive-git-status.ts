import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { spawn } from "node:child_process";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";
import { hasErrorCode } from "./errors.ts";

export const WORKTREE_CONTENT_LIMIT = 128 * 1024 * 1024;
const PASSIVE_METADATA_ARGS = ["-c", "core.fsmonitor=false"] as const;

export type PassiveGitRunner = (args: readonly string[]) => Promise<Buffer>;

let consoleAttached: boolean | undefined;

/**
 * Whether automatic Git children must start with Node's `windowsHide`. That flag starts a console child with
 * CREATE_NO_WINDOW, which gives it a hidden console of its own and so a second process, conhost.exe, for every
 * Git call. A process that already has a console, visible or hidden, lets its children share it without opening
 * a window, so only a process without one hides them. The console device opens exactly when one is attached.
 */
export function hideGitConsole(): boolean {
  if (consoleAttached === undefined) {
    try {
      closeSync(openSync("\\\\.\\CONOUT$", "w"));
      consoleAttached = true;
    } catch {
      consoleAttached = false;
    }
  }
  return !consoleAttached;
}

/** Revs-only returns empty output for an unborn HEAD; command failures still reject. */
export async function resolvePassiveHead(runGit: PassiveGitRunner): Promise<string> {
  const head = decode(await runGit(["rev-parse", "--revs-only", "--end-of-options", "HEAD"])).trim();
  if (head && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) throw new Error("invalid HEAD");
  return head || "(initial)";
}

export type PassiveWorktreeFile = {
  path: string;
  headMode?: string;
  headObjectId?: string;
  indexMode?: string;
  indexObjectId?: string;
  mode?: string;
  content?: Buffer;
  contentObjectId?: string;
};

export type PassiveWorktreeSnapshot = {
  head: string;
  files: Map<string, PassiveWorktreeFile>;
  fileMode: boolean;
  symlinks: boolean;
};

/** Settings that decide how worktree bytes and modes compare with the index. */
type PassiveWorktreeSettings = Pick<PassiveWorktreeSnapshot, "fileMode" | "symlinks"> & { autoCrlf: string };

/**
 * Reads core.autocrlf, core.filemode, and core.symlinks in one Git process instead of one each, because
 * every scan needs all three and each Git start costs tens of milliseconds on Windows.
 *
 * Git normalizes values with --type=bool-or-str, so this matches `--type=bool --get`: the last value of a key
 * wins, a missing key takes Git's default, and any value Git cannot read as a bool fails the scan. The
 * command-line probe key always matches, so the read succeeds when the repository sets none of the keys.
 */
export async function passiveWorktreeSettings(runGit: PassiveGitRunner): Promise<PassiveWorktreeSettings> {
  const output = decode(await runGit(["-c", "killeros.probe=true", "config", "-z", "--type=bool-or-str", "--get-regexp",
    "^(core\\.(autocrlf|filemode|symlinks)|killeros\\.probe)$"]));
  const values = new Map<string, string[]>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    const key = separator < 0 ? record : record.slice(0, separator);
    values.set(key, [...values.get(key) ?? [], separator < 0 ? "true" : record.slice(separator + 1)]);
  }
  if (!values.has("killeros.probe")) throw new Error("incomplete Git settings");
  /** Returns a boolean setting's last value, true when unset, and throws when any value is not a Git boolean. */
  const bool = (key: string): boolean => {
    const all = values.get(key) ?? ["true"];
    if (all.some((value) => value !== "true" && value !== "false")) throw new Error(`invalid ${key}`);
    return all.at(-1) === "true";
  };
  return {
    autoCrlf: (values.get("core.autocrlf")?.at(-1) ?? "false").trim().toLowerCase(),
    fileMode: bool("core.filemode"),
    symlinks: bool("core.symlinks"),
  };
}

export function passiveWorktreeMode(
  actual: string,
  indexed: string | undefined,
  settings: Pick<PassiveWorktreeSnapshot, "fileMode" | "symlinks">,
): string {
  if (actual === "100644" || actual === "100755") {
    if (indexed === "120000" && !settings.symlinks) return indexed;
    if ((indexed === "100644" || indexed === "100755") && !settings.fileMode) return indexed;
  }
  return actual;
}

type IndexEntry = {
  mode: string;
  objectId: string;
  eolAttributes: string;
  ctimeNanoseconds: bigint;
  mtimeNanoseconds: bigint;
  size: bigint;
  skipWorktree: boolean;
};

type TreeEntry = { mode: string; objectId: string };

function searchPathEntries(env: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "path" && typeof value === "string") values.push(value);
  }
  const entries: string[] = [];
  for (const value of values) entries.push(...value.split(path.delimiter));
  return entries;
}

function pathExtensionEntries(env: NodeJS.ProcessEnv): string[] {
  let raw: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "pathext" && typeof value === "string") {
      raw = value;
      break;
    }
  }
  raw ??= ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL";
  return raw.split(";").map((entry) => entry.trim()).filter(Boolean).map((entry) => entry.startsWith(".") ? entry : `.${entry}`);
}

function unquoted(entry: string): string {
  if (entry.length >= 2) {
    const first = entry[0];
    const last = entry[entry.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return entry.slice(1, -1);
  }
  return entry;
}

function inspectedRoot(cwd: string): string | undefined {
  if (!cwd || typeof cwd !== "string") return undefined;
  let start: string;
  try {
    start = path.resolve(cwd);
  } catch {
    return undefined;
  }
  let base: string;
  try {
    base = realpathSync.native(start);
  } catch {
    base = start;
  }
  let current = base;
  for (;;) {
    try {
      if (existsSync(path.join(current, ".git"))) {
        try {
          return realpathSync.native(current);
        } catch {
          return current;
        }
      }
    } catch {
      // An unreadable directory cannot hold the repository marker we look for.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return base;
}

function insideInspected(candidate: string, root: string): boolean {
  const normalizedCandidate = path.normalize(candidate).toLowerCase();
  const normalizedRoot = path.normalize(root).toLowerCase();
  const trimmed = normalizedRoot.length > 3 && normalizedRoot.endsWith(path.sep)
    ? normalizedRoot.slice(0, -1)
    : normalizedRoot;
  if (normalizedCandidate === trimmed) return true;
  return normalizedCandidate.startsWith(`${trimmed}${path.sep}`);
}

function traversesInspected(candidate: string, root: string): boolean {
  let current = path.dirname(candidate);
  for (;;) {
    try {
      if (insideInspected(realpathSync.native(current), root)) return true;
    } catch {
      return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Returns an absolute Git binary outside the inspected repository without starting a locator process. */
export function passiveGitCommand(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = inspectedRoot(cwd);
  if (!root) return undefined;
  const entries = searchPathEntries(env);
  if (entries.length === 0) return undefined;
  const baseNames = ["git", ...pathExtensionEntries(env).map((extension) => `git${extension}`)];
  for (const raw of entries) {
    if (raw === "" || raw.trim() === "") continue;
    const directory = unquoted(raw);
    if (directory === "" || directory.trim() === "" || !path.isAbsolute(directory)) continue;
    for (const base of baseNames) {
      const candidate = path.join(directory, base);
      if (insideInspected(candidate, root)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      let resolved: string;
      try {
        resolved = realpathSync.native(candidate);
      } catch {
        continue;
      }
      if (path.isAbsolute(resolved) && !insideInspected(resolved, root) && !traversesInspected(candidate, root)) return resolved;
    }
  }
  return undefined;
}

/** Environment for automatic Git children, without inherited repository selection or PATH command resolution, and with untranslated messages. */
export function passiveGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const selectors = [
    "GIT_DIR",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
  ];
  let hasPath = false;
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (selectors.includes(normalized)
      || normalized === "GIT_OPTIONAL_LOCKS"
      || normalized === "GIT_NO_LAZY_FETCH"
      || normalized === "LC_ALL"
      || normalized === "LANGUAGE") {
      delete env[key];
    } else if (normalized === "PATH") {
      env[key] = "";
      hasPath = true;
    }
  }
  if (!hasPath) env.PATH = "";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  // Receipts recognize "not a git repository" by its text, and translated Git prints it in the user's language.
  env.LC_ALL = "C";
  return env;
}

export function decode(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function parseIndex(output: Buffer): Map<string, IndexEntry> {
  const text = decode(output);
  const pattern = /([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])\t([^\t]*)\t([^\0]*)\0  ctime: (\d+):(\d+)\n  mtime: (\d+):(\d+)\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: (\d+)\tflags: ([0-9a-f]+)\n/gu;
  const entries = new Map<string, IndexEntry>();
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== end) throw new Error("invalid index metadata");
    end = match.index + match[0].length;
    const [, mode, objectId, stage, eolAttributes, filePath, ctimeSeconds, ctimeNanoseconds, mtimeSeconds, mtimeNanoseconds, size, flags] = match;
    if (!mode || !objectId || !stage || eolAttributes === undefined || filePath === undefined || !ctimeSeconds || !ctimeNanoseconds || !mtimeSeconds || !mtimeNanoseconds || !size || !flags || stage !== "0") {
      throw new Error("unsupported index entry");
    }
    entries.set(filePath, {
      mode,
      objectId,
      eolAttributes: eolAttributes.trim(),
      ctimeNanoseconds: BigInt(ctimeSeconds) * 1_000_000_000n + BigInt(ctimeNanoseconds),
      mtimeNanoseconds: BigInt(mtimeSeconds) * 1_000_000_000n + BigInt(mtimeNanoseconds),
      size: BigInt(size),
      skipWorktree: (Number.parseInt(flags, 16) & 0x40000000) !== 0,
    });
  }
  if (end !== text.length) throw new Error("incomplete index metadata");
  return entries;
}

function parseTree(output: Buffer): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const record of decode(output).split("\0")) {
    if (!record) continue;
    const match = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t([^\0]+)$/u.exec(record);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error("invalid tree entry");
    entries.set(match[3], { mode: match[1], objectId: match[2] });
  }
  return entries;
}

function parsePaths(output: Buffer): string[] {
  const records = decode(output).split("\0");
  if (records.at(-1) !== "") throw new Error("incomplete path list");
  return records.slice(0, -1);
}

function worktreeMode(stats: BigIntStats): string {
  if (stats.isSymbolicLink()) return "120000";
  if (!stats.isFile()) throw new Error("unsupported worktree entry");
  return stats.mode & 0o111n ? "100755" : "100644";
}

async function worktreeContent(absolutePath: string, stats: BigIntStats, limit: number): Promise<Buffer> {
  if (stats.isSymbolicLink()) return Buffer.from(await readlink(absolutePath));
  if (stats.size > BigInt(limit)) throw new PassiveGitFailure("too-large");
  return readBoundedFile(absolutePath, limit);
}

/** Reads one worktree file's mode and bytes, within `limit` bytes for regular files. */
export async function readWorktreeFile(root: string, filePath: string, limit: number): Promise<{ mode: string; content: Buffer }> {
  const absolutePath = path.join(root, ...filePath.split("/"));
  const stats = await lstat(absolutePath, { bigint: true });
  return { mode: worktreeMode(stats), content: await worktreeContent(absolutePath, stats, limit) };
}

async function readFileState(root: string, entry: IndexEntry | undefined, filePath: string, remaining: number): Promise<{ mode: string; content?: Buffer; statsMatch: boolean }> {
  const absolutePath = path.join(root, ...filePath.split("/"));
  const stats = await lstat(absolutePath, { bigint: true });
  const mode = worktreeMode(stats);
  const statsMatch = entry !== undefined
    && entry.mode === mode
    && entry.size === stats.size
    && entry.ctimeNanoseconds === stats.ctimeNs
    && entry.mtimeNanoseconds === stats.mtimeNs;
  if (statsMatch) return { mode, statsMatch };
  return { mode, content: await worktreeContent(absolutePath, stats, remaining), statsMatch };
}

/** Reads a regular file of at most `limit` bytes, failing if it grows while being read. */
async function readBoundedFile(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new PassiveGitFailure("error");
    if (stats.size > limit) throw new PassiveGitFailure("too-large");
    const content = Buffer.alloc(stats.size + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await handle.read(content, length, content.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stats.size) throw new PassiveGitFailure("error");
    return content.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function blobObjectId(content: Buffer, length: number): string {
  const algorithm = length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
}

function matchesIndex(content: Buffer, entry: IndexEntry, autoCrlf: string): boolean {
  if (blobObjectId(content, entry.objectId.length) === entry.objectId) return true;
  if (entry.mode === "120000" || !content.includes(Buffer.from("\r\n"))) return false;
  const attributes = entry.eolAttributes;
  // eol controls checkout bytes; text files still normalize CRLF when compared with the index.
  if (attributes === "-text") return false;
  const automatic = attributes.startsWith("text=auto") || !attributes;
  if (!attributes && !["true", "input"].includes(autoCrlf)) return false;
  if (automatic) {
    // Match Git's convert_is_binary heuristic, including its terminal EOF exception.
    let printable = 0;
    let nonprintable = 0;
    for (let index = 0; index < content.length; index += 1) {
      const byte = content[index];
      if (byte === 0 || byte === 13 && content[index + 1] !== 10) return false;
      if (byte === 13 || byte === 10 || byte === 26 && index === content.length - 1) continue;
      if (byte === 127 || byte < 32 && ![8, 9, 12, 27].includes(byte)) nonprintable += 1;
      else printable += 1;
    }
    if (Math.floor(printable / 128) < nonprintable) return false;
  }
  const normalized = Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
  return blobObjectId(normalized, entry.objectId.length) === entry.objectId;
}

/**
 * Reads index and tree metadata with Git, then inspects worktree files with Node.
 * No Git command in this path asks Git to convert worktree content, so clean and process filters cannot start.
 * With `untracked` set to "paths", untracked files are listed with their mode and their bytes stay unread.
 */
export async function inspectWorktreeWithoutFilters(root: string, runGit: PassiveGitRunner, untracked: "content" | "paths" = "content"): Promise<PassiveWorktreeSnapshot> {
  const [indexOutput, untrackedOutput, head, { autoCrlf, ...settings }] = await Promise.all([
    runGit([...PASSIVE_METADATA_ARGS, "ls-files", "--cached", "--debug", "-z", "--full-name",
      "--format=%(objectmode) %(objectname) %(stage)%x09%(eolattr)%x09%(path)"]),
    runGit([...PASSIVE_METADATA_ARGS, "ls-files", "--others", "--exclude-standard", "-z", "--full-name"]),
    resolvePassiveHead(runGit),
    passiveWorktreeSettings(runGit),
  ]);
  const index = parseIndex(indexOutput);
  const tree = head !== "(initial)" ? parseTree(await runGit(["ls-tree", "-r", "-z", "--full-tree", head])) : new Map<string, TreeEntry>();
  const files = new Map<string, PassiveWorktreeFile>();
  let contentBytes = 0;

  for (const filePath of new Set([...tree.keys(), ...index.keys()])) {
    const headEntry = tree.get(filePath);
    const indexEntry = index.get(filePath);
    if (headEntry?.mode === "160000" || indexEntry?.mode === "160000") continue;
    const staged = headEntry?.mode !== indexEntry?.mode || headEntry?.objectId !== indexEntry?.objectId;
    let mode: string | undefined;
    let content: Buffer | undefined;
    let worktreeChanged = false;
    if (indexEntry && !indexEntry.skipWorktree) {
      try {
        const state = await readFileState(root, indexEntry, filePath, WORKTREE_CONTENT_LIMIT - contentBytes);
        mode = passiveWorktreeMode(state.mode, indexEntry.mode, settings);
        content = state.content;
        if (content) contentBytes += content.length;
        worktreeChanged = !state.statsMatch && (mode !== indexEntry.mode || !content || !matchesIndex(content, indexEntry, autoCrlf));
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) worktreeChanged = true;
        else throw error;
      }
    }
    if (!staged && !worktreeChanged) continue;
    files.set(filePath, {
      path: filePath,
      headMode: headEntry?.mode,
      headObjectId: headEntry?.objectId,
      indexMode: indexEntry?.mode,
      indexObjectId: indexEntry?.objectId,
      mode: worktreeChanged ? mode : indexEntry?.mode,
      ...(worktreeChanged && content ? { content } : indexEntry ? { contentObjectId: indexEntry.objectId } : {}),
    });
  }

  for (const filePath of parsePaths(untrackedOutput)) {
    if (untracked === "paths") {
      const stats = await lstat(path.join(root, ...filePath.split("/")), { bigint: true });
      files.set(filePath, { ...files.get(filePath), path: filePath, mode: worktreeMode(stats), contentObjectId: undefined });
      continue;
    }
    const state = await readFileState(root, undefined, filePath, WORKTREE_CONTENT_LIMIT - contentBytes);
    if (!state.content) throw new Error("missing untracked content");
    contentBytes += state.content.length;
    const previous = files.get(filePath);
    files.set(filePath, { ...previous, path: filePath, mode: state.mode, content: state.content, contentObjectId: undefined });
  }
  return { head, files, ...settings };
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

/** Why passive Git metadata is unavailable: the command failed, ran past its timeout, or exceeded an output or content bound. */
export class PassiveGitFailure extends Error {
  readonly reason: "error" | "timeout" | "too-large";
  readonly stderr: Buffer;

  constructor(reason: PassiveGitFailure["reason"], stderr = Buffer.alloc(0)) {
    super(reason);
    this.reason = reason;
    this.stderr = stderr;
  }
}

/** Resolves the passive Git binary, treating a failed PATH inspection as no safe binary. */
function safeGitCommand(cwd: string): string | undefined {
  try {
    return passiveGitCommand(cwd);
  } catch {
    return undefined;
  }
}

/** Runs the passive Git binary in `cwd` with optional stdin and bounded output, rejecting with a PassiveGitFailure. Pass `command` to reuse one lookup across a scan. */
export function runPassiveGit(
  cwd: string,
  args: readonly string[],
  { input, stdoutLimit = GIT_OUTPUT_LIMIT, command = safeGitCommand(cwd) }: { input?: Buffer; stdoutLimit?: number; command?: string } = {},
): Promise<Buffer> {
  if (!command) return Promise.reject(new PassiveGitFailure("error"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: passiveGitEnv(),
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: hideGitConsole(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: PassiveGitFailure | undefined;
    let settled = false;
    const timer = setTimeout(() => {
      failure = new PassiveGitFailure("timeout");
      child.kill();
    }, GIT_TIMEOUT_MS);
    timer.unref();
    const capture = (chunks: Buffer[], isStdout: boolean) => (chunk: Buffer): void => {
      const nextBytes = (isStdout ? stdoutBytes : stderrBytes) + chunk.length;
      if (nextBytes > (isStdout ? stdoutLimit : GIT_OUTPUT_LIMIT)) {
        failure = new PassiveGitFailure("too-large");
        child.kill();
        return;
      }
      if (isStdout) stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
      chunks.push(chunk);
    };
    child.stdout?.on("data", capture(stdout, true));
    child.stderr?.on("data", capture(stderr, false));
    if (input) child.stdin?.end(input);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PassiveGitFailure("error"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new PassiveGitFailure("error", Buffer.concat(stderr)));
    });
  });
}

export interface GitFileChanges {
  modified: number;
  added: number;
  deleted: number;
}

/** Counts changed files for a trusted project without asking Git to inspect worktree content; undefined when unavailable. */
export async function resolveGitFileChanges(cwd: string, trusted: boolean): Promise<GitFileChanges | undefined> {
  if (!trusted) return undefined;
  try {
    const command = safeGitCommand(cwd);
    if (!command) return undefined;
    const root = decode(await runPassiveGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { command })).trim();
    if (!path.isAbsolute(root)) return undefined;
    // Counting needs each untracked path, not its bytes, so large untracked files cost nothing and cannot exceed the content limit.
    const snapshot = await inspectWorktreeWithoutFilters(root, (args) => runPassiveGit(root, args, { command }), "paths");
    const changes: GitFileChanges = { modified: 0, added: 0, deleted: 0 };
    const deletedObjectIds: string[] = [];
    const addedObjectIds: string[] = [];
    for (const file of snapshot.files.values()) {
      if (!file.mode) {
        changes.deleted += 1;
        if (!file.indexMode && file.headObjectId) deletedObjectIds.push(file.headObjectId);
      } else if (!file.headMode) {
        changes.added += 1;
        if (file.indexObjectId) addedObjectIds.push(file.indexObjectId);
      } else changes.modified += 1;
    }
    for (const objectId of deletedObjectIds) {
      const match = addedObjectIds.indexOf(objectId);
      if (match < 0) continue;
      addedObjectIds.splice(match, 1);
      changes.deleted -= 1;
      changes.added -= 1;
      changes.modified += 1;
    }
    return changes;
  } catch {
    return undefined;
  }
}

/** Resolves the current branch for a trusted project, "detached" for a detached HEAD, or undefined when unavailable. */
export async function resolveGitBranch(cwd: string, trusted: boolean): Promise<string | undefined> {
  if (!trusted) return undefined;
  try {
    const branch = (await runPassiveGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], { stdoutLimit: 64 * 1024 })).toString("utf8").trim();
    return branch === "HEAD" ? "detached" : branch || undefined;
  } catch {
    return undefined;
  }
}
