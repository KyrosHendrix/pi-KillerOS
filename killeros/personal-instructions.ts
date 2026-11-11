import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readUnlinkedFile } from "./file-identity.ts";

const PERSONAL_INSTRUCTIONS_FILE = "AGENTS.local.md";
const PERSONAL_INSTRUCTIONS_LIMIT = 32 * 1024;

/** Reads the project instructions file, keeping the first `limit` bytes of an oversized file with a truncation note. */
function readBoundedText(filePath: string): string | undefined {
  try {
    const { content, truncated } = readUnlinkedFile(filePath, PERSONAL_INSTRUCTIONS_LIMIT);
    const text = new StringDecoder("utf8").write(content);
    if (!text.trim()) return undefined;
    return truncated ? `${text}\n\n[Personal instructions truncated by KillerOS]` : text;
  } catch {
    return undefined;
  }
}

/** Checks path containment using Windows filesystem casing rules. */
function pathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reads one stable, unlinked import from inside Pi's agent directory. */
function readImportedText(filePath: string): string | undefined {
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

    const { content, truncated } = readUnlinkedFile(requestedPath, PERSONAL_INSTRUCTIONS_LIMIT);
    if (truncated) return undefined;
    const text = new StringDecoder("utf8").write(content);
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function resolvePersonalInstructions(cwd: string): string | undefined {
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

export function registerPersonalInstructions(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
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
