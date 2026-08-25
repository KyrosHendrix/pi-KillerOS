import { closeSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

export function resolvePersonalInstructions(cwd: string): string | undefined {
  const localPath = path.join(cwd, PERSONAL_INSTRUCTIONS_FILE);
  const local = readBoundedText(localPath);
  if (!local) return undefined;

  const importMatch = local.trim().match(/^@(.+)$/u);
  let content = local;
  if (importMatch) {
    const requestedPath = (importMatch[1] ?? "").trim();
    const importedPath = requestedPath.startsWith("~/") || requestedPath.startsWith("~\\")
      ? path.join(os.homedir(), requestedPath.slice(2))
      : path.resolve(cwd, requestedPath);
    content = readBoundedText(importedPath) ?? local;
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
