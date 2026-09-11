import { execFileSync } from "node:child_process";

// Passive Git inspection must not start fsmonitor, clean/process filters,
// or a promisor fetch. Config discovery and status run in separate Git
// processes, so a filter configured between them would be absent from the
// safety overrides. Callers close that gap two ways: automatic Git children
// run with passiveGitEnv, where an empty PATH stops bare filter commands
// from resolving, and each scan re-reads discovery after status and skips
// the result when the effective filter set changed mid-scan.
export const PASSIVE_GIT_CONFIG_ARGS = ["config", "--includes", "--null", "--name-only", "--list"] as const;

const SAFE_FILTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

let cachedGitCommand: string | undefined;

// Absolute Git binary path so automatic scans can sanitize PATH (which
// Node uses to resolve the child binary on some platforms) without losing
// Git itself. Falls back to "git" when discovery fails, preserving the
// callers' existing unavailable behavior.
export function passiveGitCommand(): string {
  cachedGitCommand ??= (() => {
    try {
      const found = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], {
        encoding: "utf8",
        windowsHide: true,
      }).split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
      return found ?? "git";
    } catch {
      return "git";
    }
  })();
  return cachedGitCommand;
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
