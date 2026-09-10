// Passive `git status` must not start fsmonitor or clean/process filters.
export const PASSIVE_GIT_CONFIG_ARGS = ["config", "--includes", "--null", "--name-only", "--list"] as const;

const SAFE_FILTER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// Builds safe overrides from null-delimited `git config --name-only --list`
// output. Returns undefined when output is incomplete or names an unsafe
// filter, so the caller skips the status call.
export function passiveStatusSafetyArgs(config: string): string[] | undefined {
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
  return ["-c", "core.fsmonitor=false", ...[...names].flatMap((name) => ["-c", `filter.${name}.clean=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`])];
}
