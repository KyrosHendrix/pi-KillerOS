import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InitRuntime } from "./runtime.ts";

const PERSONAL_INSTRUCTIONS_FILE = "AGENTS.local.md";
const PERSONAL_INSTRUCTIONS_LIMIT = 32 * 1024;

function readBoundedText(filePath: string, limit = PERSONAL_INSTRUCTIONS_LIMIT): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.alloc(limit + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const decoder = new StringDecoder("utf8");
    const content = decoder.write(buffer.subarray(0, Math.min(bytesRead, limit)));
    if (!content.trim()) return undefined;
    return bytesRead > limit
      ? `${content}\n\n[Personal instructions truncated by KillerOS]`
      : content;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore cleanup failures after a bounded best-effort read.
      }
    }
  }
}

/** Checks path containment using host filesystem casing rules. */
function pathInside(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reads one stable, unlinked import from inside Pi's agent directory. */
function readImportedText(filePath: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const allowedPath = path.resolve(getAgentDir());
    const requestedPath = path.resolve(filePath);
    if (!pathInside(allowedPath, requestedPath)) return undefined;

    const allowedRealPath = realpathSync(allowedPath);
    const requestedRealPath = realpathSync(requestedPath);
    if (!pathInside(allowedRealPath, requestedRealPath)) return undefined;

    let current = allowedPath;
    for (const segment of path.relative(allowedPath, requestedPath).split(path.sep)) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return undefined;
    }

    const pathStat = lstatSync(requestedPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1) return undefined;
    descriptor = openSync(requestedPath, "r");
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile() || openedStat.nlink !== 1
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) return undefined;

    const buffer = Buffer.alloc(PERSONAL_INSTRUCTIONS_LIMIT + 1);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > PERSONAL_INSTRUCTIONS_LIMIT) return undefined;
    const content = new StringDecoder("utf8").write(buffer.subarray(0, bytesRead));
    return content.trim() ? content : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Ignore cleanup failures after rejecting or reading an import.
      }
    }
  }
}

export function resolvePersonalInstructions(cwd: string): string | undefined {
  const local = readBoundedText(path.join(cwd, PERSONAL_INSTRUCTIONS_FILE));
  if (!local) return undefined;

  const importMatch = local.trim().match(/^@(.+)$/u);
  let content = local;
  if (importMatch) {
    const requestedPath = (importMatch[1] ?? "").trim();
    const importedPath = requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
      ? path.join(os.homedir(), requestedPath.slice(2))
      : path.resolve(cwd, requestedPath);
    const imported = readImportedText(importedPath);
    if (!imported) return undefined;
    content = imported;
  }
  return `<personal_instructions>\n${content}\n</personal_instructions>`;
}

export function registerPersonalInstructions(pi: ExtensionAPI, initState: InitRuntime): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (initState.active || !ctx.isProjectTrusted()) return;
    const personal = resolvePersonalInstructions(ctx.cwd);
    if (!personal) return;
    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        personal,
      ].join("\n"),
    };
  });
}
