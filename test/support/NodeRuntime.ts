import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function isBunRuntime(): boolean {
  return "bun" in process.versions;
}

let runtime: { executable: string; directory: string } | undefined;

function probeNode(candidate: string): string | undefined {
  let executable: string;
  try {
    executable = realpathSync.native(candidate);
    if (!statSync(executable).isFile()) return undefined;
  } catch {
    return undefined;
  }
  if (path.basename(executable).toLowerCase() !== "node.exe") return undefined;
  const probe = spawnSync(
    executable,
    ["-p", "('bun' in process.versions ? 'bun' : process.release.name)"],
    {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toUpperCase() !== "NODE_OPTIONS",
        ),
      ),
    },
  );
  return probe.status === 0 && probe.stdout.trim() === "node"
    ? executable
    : undefined;
}

function resolveNode(): string {
  const override = process.env.KILLEROS_NODE_EXECUTABLE;
  const preferred = override && probeNode(override);
  if (preferred) return preferred;
  if (!isBunRuntime()) return process.execPath;
  for (const entry of (process.env.PATH ?? process.env.Path ?? "").split(
    path.delimiter,
  )) {
    const directory = entry.trim().replace(/^"(.*)"$/u, "$1");
    if (!path.isAbsolute(directory)) continue;
    const executable = probeNode(path.join(directory, "node.exe"));
    if (executable) return executable;
  }
  throw new Error(
    "Cannot find Node.js. Put node.exe on PATH or set KILLEROS_NODE_EXECUTABLE.",
  );
}

function nodeRuntime() {
  if (!runtime) {
    const executable = resolveNode();
    runtime = { executable, directory: path.dirname(executable) };
  }
  return runtime;
}

export function nodeExecutable(): string {
  return nodeRuntime().executable;
}

export function nodeDirectory(): string {
  return nodeRuntime().directory;
}
