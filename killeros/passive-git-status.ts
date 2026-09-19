import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import path from "node:path";

const WORKTREE_CONTENT_LIMIT = 128 * 1024 * 1024;
const PASSIVE_METADATA_ARGS = ["-c", "core.fsmonitor=false"] as const;

export type PassiveGitRunner = (args: readonly string[]) => Promise<Buffer>;

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
};

type IndexEntry = {
  mode: string;
  objectId: string;
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
    base = realpathSync(start);
  } catch {
    base = start;
  }
  let current = base;
  for (;;) {
    try {
      if (existsSync(path.join(current, ".git"))) {
        try {
          return realpathSync(current);
        } catch {
          return current;
        }
      }
    } catch {
      // Unreadable directory: keep walking toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return base;
}

function insideInspected(candidate: string, root: string): boolean {
  if (process.platform === "win32") {
    const normalizedCandidate = path.win32.normalize(candidate).toLowerCase();
    const normalizedRoot = path.win32.normalize(root).toLowerCase();
    const trimmed = normalizedRoot.length > 3 && normalizedRoot.endsWith(path.win32.sep)
      ? normalizedRoot.slice(0, -1)
      : normalizedRoot;
    if (normalizedCandidate === trimmed) return true;
    return normalizedCandidate.startsWith(`${trimmed}${path.win32.sep}`);
  }
  const normalizedCandidate = path.normalize(candidate);
  const normalizedRoot = path.normalize(root);
  const trimmed = normalizedRoot.length > 1 && normalizedRoot.endsWith(path.sep)
    ? normalizedRoot.slice(0, -1)
    : normalizedRoot;
  if (normalizedCandidate === trimmed) return true;
  return normalizedCandidate.startsWith(`${trimmed}${path.sep}`);
}

/** Returns an absolute Git binary outside the inspected repository without starting a locator process. */
export function passiveGitCommand(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = inspectedRoot(cwd);
  if (!root) return undefined;
  const entries = searchPathEntries(env);
  if (entries.length === 0) return undefined;
  const windows = process.platform === "win32";
  const baseNames = windows ? ["git", ...pathExtensionEntries(env).map((extension) => `git${extension}`)] : ["git"];
  for (const raw of entries) {
    if (raw === "" || raw.trim() === "") continue;
    const directory = unquoted(raw);
    if (directory === "" || directory.trim() === "" || !path.isAbsolute(directory)) continue;
    for (const base of baseNames) {
      const candidate = path.join(directory, base);
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      if (!windows) {
        try {
          accessSync(candidate, constants.X_OK);
        } catch {
          continue;
        }
      }
      let resolved: string;
      try {
        resolved = realpathSync(candidate);
      } catch {
        continue;
      }
      if (path.isAbsolute(resolved) && !insideInspected(resolved, root)) return resolved;
    }
  }
  return undefined;
}

/** Environment for automatic Git children, with locks, lazy fetches, and PATH command resolution disabled. */
export function passiveGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" };
  let hasPath = false;
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") {
      env[key] = "";
      hasPath = true;
    }
  }
  if (!hasPath) env.PATH = "";
  return env;
}

function decode(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function parseIndex(output: Buffer): Map<string, IndexEntry> {
  const text = decode(output);
  const pattern = /([HS]) ([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])\t([^\0]*)\0  ctime: \d+:\d+\n  mtime: (\d+):(\d+)\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: (\d+)\tflags: [0-9a-f]+\n/gu;
  const entries = new Map<string, IndexEntry>();
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index !== end) throw new Error("invalid index metadata");
    end = match.index + match[0].length;
    const [, tag, mode, objectId, stage, filePath, seconds, nanoseconds, size] = match;
    if (!tag || !mode || !objectId || !stage || filePath === undefined || !seconds || !nanoseconds || !size || stage !== "0") {
      throw new Error("unsupported index entry");
    }
    entries.set(filePath, {
      mode,
      objectId,
      mtimeNanoseconds: BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds),
      size: BigInt(size),
      skipWorktree: tag === "S",
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

async function readFileState(root: string, entry: IndexEntry | undefined, filePath: string, remaining: number): Promise<{ mode: string; content?: Buffer; statsMatch: boolean }> {
  const absolutePath = path.join(root, ...filePath.split("/"));
  const stats = await lstat(absolutePath, { bigint: true });
  const mode = stats.isSymbolicLink() ? "120000" : stats.isFile() ? stats.mode & 0o111n ? "100755" : "100644" : "";
  if (!mode) throw new Error("unsupported worktree entry");
  const statsMatch = entry !== undefined
    && entry.mode === mode
    && entry.size === stats.size
    && entry.mtimeNanoseconds === stats.mtimeNs;
  if (statsMatch) return { mode, statsMatch };
  if (!stats.isSymbolicLink() && stats.size > BigInt(remaining)) throw new Error("worktree content limit exceeded");
  const content = stats.isSymbolicLink() ? Buffer.from(await readlink(absolutePath)) : await readBounded(absolutePath, remaining);
  return { mode, content, statsMatch };
}

async function readBounded(filePath: string, limit: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > limit) throw new Error("worktree content limit exceeded");
    const content = Buffer.alloc(stats.size + 1);
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await handle.read(content, length, content.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stats.size) throw new Error("worktree changed while reading");
    return content.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function blobObjectId(content: Buffer, length: number): string {
  const algorithm = length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
}

/**
 * Reads index and tree metadata with Git, then inspects worktree files with Node.
 * No Git command in this path asks Git to convert worktree content, so clean and process filters cannot start.
 */
export async function inspectWorktreeWithoutFilters(root: string, runGit: PassiveGitRunner): Promise<PassiveWorktreeSnapshot> {
  const [indexOutput, untrackedOutput, resolvedHead] = await Promise.all([
    runGit([...PASSIVE_METADATA_ARGS, "ls-files", "--cached", "--stage", "--debug", "-t", "-z", "--full-name"]),
    runGit([...PASSIVE_METADATA_ARGS, "ls-files", "--others", "--exclude-standard", "-z", "--full-name"]),
    runGit(["rev-parse", "--verify", "HEAD"]).then(decode, () => ""),
  ]);
  const head = resolvedHead.trim();
  if (head && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) throw new Error("invalid HEAD");
  const index = parseIndex(indexOutput);
  const tree = head ? parseTree(await runGit(["ls-tree", "-r", "-z", "--full-tree", head])) : new Map<string, TreeEntry>();
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
        mode = process.platform === "win32" && indexEntry.mode !== "120000" ? indexEntry.mode : state.mode;
        content = state.content;
        if (content) contentBytes += content.length;
        worktreeChanged = !state.statsMatch && (mode !== indexEntry.mode || !content || blobObjectId(content, indexEntry.objectId.length) !== indexEntry.objectId);
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") worktreeChanged = true;
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
    const state = await readFileState(root, undefined, filePath, WORKTREE_CONTENT_LIMIT - contentBytes);
    if (!state.content) throw new Error("missing untracked content");
    contentBytes += state.content.length;
    const previous = files.get(filePath);
    files.set(filePath, { ...previous, path: filePath, mode: state.mode, content: state.content, contentObjectId: undefined });
  }
  return { head: head || "(initial)", files };
}
