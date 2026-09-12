import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

// Passive Git inspection must not start fsmonitor, clean/process filters,
// a promisor fetch, or a repository-supplied executable. Config discovery
// and status run in separate Git processes, so a filter configured between
// them would be absent from the safety overrides. Callers close that gap
// two ways: automatic Git children run with passiveGitEnv, where an empty
// PATH stops bare filter commands from resolving, and each scan re-reads
// discovery after status and skips the result when the effective filter set
// changed mid-scan.
//
// Executable discovery itself is passive: it never starts a command shell,
// locator process, or other helper executable, and never executes a bare
// program name. It scans absolute search-path entries for an absolute Git
// path outside the inspected repository and fails closed when none exists.
export const PASSIVE_GIT_CONFIG_ARGS = ["config", "--includes", "--null", "--name-only", "--list"] as const;

const SAFE_FILTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

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

// Absolute Git binary outside the inspected repository, or undefined when
// no safe candidate exists. Never starts a helper process and never
// returns a bare command name, so opening a repository cannot execute a
// repository-local locator or Git executable. Empty and relative
// search-path entries are ignored because they can resolve against the
// current directory. A candidate that resolves through a link returns its
// final path only when that path is also outside the repository.
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
    if (directory === "" || directory.trim() === "") continue;
    if (!path.isAbsolute(directory)) continue;
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
      if (!path.isAbsolute(resolved)) continue;
      if (insideInspected(resolved, root)) continue;
      return resolved;
    }
  }
  return undefined;
}

// Lists effective clean/process filter drivers in discovery order, or
// undefined when discovery output is incomplete or names a driver the
// safety overrides cannot represent.
export function passiveFilterNames(config: string): string[] | undefined {
  const records = config.split("\0");
  if (records.at(-1) !== "") return undefined;
  const names = new Set<string>();
  for (const key of records) {
    if (!key) continue;
    const name = /^filter\.(.*)\.(?:clean|process)$/us.exec(key)?.[1];
    if (name === undefined) continue;
    if (!SAFE_FILTER_NAME.test(name)) return undefined;
    names.add(name);
  }
  return [...names];
}

// Builds safe overrides from null-delimited `git config --name-only --list`
// output. Returns undefined when output is incomplete or names an unsafe
// filter, so the caller skips the status call.
export function passiveStatusSafetyArgs(config: string): string[] | undefined {
  const names = passiveFilterNames(config);
  if (!names) return undefined;
  return ["-c", "core.fsmonitor=false", ...names.flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`])];
}

export function samePassiveFilters(before: string, after: string): boolean {
  const earlier = passiveFilterNames(before);
  const later = passiveFilterNames(after);
  if (!earlier || !later) return false;
  if (earlier.length !== later.length) return false;
  const ordered = [...later].sort();
  return [...earlier].sort().every((name, index) => name === ordered[index]);
}

// Environment for automatic Git children: no optional locks, no lazy fetch
// from a promisor remote, and no PATH so a filter command that becomes
// effective after discovery cannot resolve a bare command name. Absolute
// filter paths are still possible; callers detect mid-scan config changes
// with samePassiveFilters and skip those results.
export function passiveGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
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
