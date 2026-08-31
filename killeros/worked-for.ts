import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { StopReason } from "@earendil-works/pi-ai";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  beginChangeReceipt,
  disposeChangeReceipts,
  recognizedVerification,
  VERIFICATION_LABELS,
  type ChangeReceiptCollection,
  type ChangeSummary,
  type ChangedFile,
  type VerificationAttempt,
} from "./change-receipt.ts";
import { formatTokens } from "./display.ts";
import { errorMessage } from "./errors.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

const WORKED_FOR_ENTRY_TYPE = "killeros-worked-for";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const CANONICAL_CHECKS = new Set<string>(VERIFICATION_LABELS);

interface WorkedForEntryDataV1 {
  version: 1;
  milliseconds: number;
}

export type WorkedForOutcome = "done" | "stopped" | "failed";

interface WorkedForEntryDataV2 {
  version: 2;
  milliseconds: number;
  outcome: WorkedForOutcome;
}

interface WorkedForEntryDataV3 {
  version: 3;
  milliseconds: number;
  outcome: WorkedForOutcome;
  tokens: number;
}

export interface WorkedForEntryDataV4 {
  version: 4;
  milliseconds: number;
  outcome: WorkedForOutcome;
  tokens: number;
  changes: ChangeSummary;
  checks: VerificationAttempt[];
  omittedChecks: { passed: number; failed: number };
}

type WorkedForEntryData = WorkedForEntryDataV1 | WorkedForEntryDataV2 | WorkedForEntryDataV3 | WorkedForEntryDataV4;

const OUTCOMES = {
  done: { marker: "✓", label: "Done", color: "success" },
  stopped: { marker: "■", label: "Stopped", color: "warning" },
  failed: { marker: "×", label: "Failed", color: "error" },
} as const satisfies Record<WorkedForOutcome, { marker: string; label: string; color: string }>;

function isWorkedForOutcome(value: unknown): value is WorkedForOutcome {
  return value === "done" || value === "stopped" || value === "failed";
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return !value.split(/[\\/]/u).includes("..");
}

function parseFile(value: unknown): ChangedFile | undefined {
  if (!record(value) || !validPath(value.path) || !integer(value.additions) || !integer(value.deletions)) return undefined;
  if (value.detail !== undefined && value.detail !== "binary" && value.detail !== "mode") return undefined;
  const detail: "binary" | "mode" | undefined = value.detail === "binary" || value.detail === "mode" ? value.detail : undefined;
  if (detail && (value.additions !== 0 || value.deletions !== 0)) return undefined;
  const shared = {
    path: value.path,
    additions: value.additions,
    deletions: value.deletions,
    ...(detail ? { detail } : {}),
  };
  if (value.kind === "renamed") {
    if (!validPath(value.previousPath)) return undefined;
    return { kind: "renamed", previousPath: value.previousPath, ...shared };
  }
  if (value.previousPath !== undefined || value.kind !== "added" && value.kind !== "modified" && value.kind !== "deleted") return undefined;
  return { kind: value.kind, ...shared };
}

function parseChanges(value: unknown): ChangeSummary | undefined {
  if (!record(value)) return undefined;
  if (value.state === "unavailable") {
    return value.reason === "not-git" || value.reason === "timeout" || value.reason === "too-large" || value.reason === "error"
      ? { state: "unavailable", reason: value.reason }
      : undefined;
  }
  if (value.state !== "available" || !integer(value.totalFiles) || !integer(value.additions) || !integer(value.deletions)
    || !integer(value.omittedFiles) || !Array.isArray(value.files) || value.files.length > 20) return undefined;
  const files = value.files.map(parseFile);
  if (files.some((file) => !file)) return undefined;
  const parsed = files as ChangedFile[];
  if (value.totalFiles !== parsed.length + value.omittedFiles) return undefined;
  if (value.omittedFiles === 0) {
    if (value.additions !== parsed.reduce((total, file) => total + file.additions, 0)
      || value.deletions !== parsed.reduce((total, file) => total + file.deletions, 0)) return undefined;
  }
  return {
    state: "available",
    totalFiles: value.totalFiles,
    additions: value.additions,
    deletions: value.deletions,
    files: parsed,
    omittedFiles: value.omittedFiles,
  };
}

function parseV4(data: Record<string, unknown>): WorkedForEntryDataV4 | undefined {
  try {
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_PAYLOAD_BYTES) return undefined;
  } catch {
    return undefined;
  }
  if (!integer(data.milliseconds) || !integer(data.tokens) || !isWorkedForOutcome(data.outcome)) return undefined;
  const changes = parseChanges(data.changes);
  if (!changes || !Array.isArray(data.checks) || data.checks.length > 20 || !record(data.omittedChecks)
    || !integer(data.omittedChecks.passed) || !integer(data.omittedChecks.failed)) return undefined;
  if (data.omittedChecks.passed + data.omittedChecks.failed > 0 && data.checks.length !== 20) return undefined;
  const checks: VerificationAttempt[] = [];
  for (const check of data.checks) {
    if (!record(check) || typeof check.label !== "string" || !CANONICAL_CHECKS.has(check.label)
      || check.outcome !== "passed" && check.outcome !== "failed") return undefined;
    checks.push({ label: check.label, outcome: check.outcome });
  }
  return {
    version: 4,
    milliseconds: data.milliseconds,
    outcome: data.outcome,
    tokens: data.tokens,
    changes,
    checks,
    omittedChecks: { passed: data.omittedChecks.passed, failed: data.omittedChecks.failed },
  };
}

function sessionTokenTotal(ctx: ExtensionContext): number | undefined {
  try {
    let total = 0;
    for (const entry of ctx.sessionManager.getEntries()) {
      const tokens = entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
        ? entry.message.usage?.totalTokens
        : (entry.type === "compaction" || entry.type === "branch_summary")
          ? entry.usage?.totalTokens
          : undefined;
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) total += tokens;
    }
    return total;
  } catch {
    return undefined;
  }
}

export function formatWorkedForDuration(milliseconds: number): string {
  const boundedMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  const totalSeconds = Math.max(1, Math.floor(boundedMilliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${(totalSeconds % 60).toString().padStart(2, "0")}s`;
  return `${Math.floor(totalMinutes / 60)}h ${(totalMinutes % 60).toString().padStart(2, "0")}m`;
}

function parseWorkedForEntryData(data: unknown): WorkedForEntryData | undefined {
  if (!record(data) || !("version" in data) || !("milliseconds" in data)) return undefined;
  if (data.version === 4) return parseV4(data);
  if (typeof data.milliseconds !== "number" || !Number.isFinite(data.milliseconds) || data.milliseconds < 0) return undefined;
  if (data.version === 1) return { version: 1, milliseconds: data.milliseconds };
  if (!("outcome" in data) || !isWorkedForOutcome(data.outcome)) return undefined;
  if (data.version === 2) return { version: 2, milliseconds: data.milliseconds, outcome: data.outcome };
  if (data.version !== 3 || typeof data.tokens !== "number" || !Number.isFinite(data.tokens) || data.tokens < 0) return undefined;
  return { version: 3, milliseconds: data.milliseconds, outcome: data.outcome, tokens: data.tokens };
}

function safePath(value: string): string {
  return safeTerminalText(value).replaceAll("\n", "⏎");
}

class WorkedForV4Component implements Component {
  private readonly data: WorkedForEntryDataV4;
  private readonly expanded: boolean;
  private readonly theme: Theme;

  constructor(
    data: WorkedForEntryDataV4,
    expanded: boolean,
    theme: Theme,
  ) {
    this.data = data;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const { data, theme } = this;
    const outcome = OUTCOMES[data.outcome];
    const lines = [
      `${theme.fg(outcome.color, `${outcome.marker} ${outcome.label}`)}${theme.fg("dim", ` · ${formatWorkedForDuration(data.milliseconds)} · ↑ ${formatTokens(data.tokens)} tokens`)}`,
    ];
    if (data.changes.state === "unavailable") lines.push(theme.fg("dim", "  Changes unavailable"));
    else if (data.changes.totalFiles === 0) lines.push(theme.fg("dim", "  No files changed"));
    else {
      const count = `${data.changes.totalFiles} ${data.changes.totalFiles === 1 ? "file" : "files"}`;
      lines.push(`${theme.fg("accent", `  ${width < 40 ? count : `Changed ${count}`}`)}${theme.fg("dim", " · ")}${theme.fg("success", `+${data.changes.additions}`)} ${theme.fg("error", `−${data.changes.deletions}`)}`);
    }
    const passed = data.checks.filter((check) => check.outcome === "passed").length + data.omittedChecks.passed;
    const failed = data.checks.filter((check) => check.outcome === "failed").length + data.omittedChecks.failed;
    const totalChecks = passed + failed;
    if (totalChecks === 0) {
      if (data.changes.state === "available" && data.changes.totalFiles > 0) lines.push(theme.fg("warning", "  Not verified"));
    } else if (totalChecks === 1) {
      const check = data.checks[0];
      if (check?.outcome === "passed") lines.push(`${theme.fg("success", `  ${width < 40 ? "Check:" : "Verified:"} ${check.label} ✓`)}`);
      else if (check) lines.push(theme.fg("error", `  ${width < 40 ? "Check:" : "Verification failed:"} ${check.label} ×`));
    } else if (failed === 0) {
      lines.push(theme.fg("success", `  ${width < 40 ? "Check:" : "Verified:"} ${passed} passed`));
    } else {
      lines.push(`  ${theme.fg("error", "Verification:")} ${theme.fg("success", `${passed} passed`)}${theme.fg("dim", " · ")}${theme.fg("error", `${failed} failed`)}`);
    }
    if (this.expanded && data.changes.state === "available") {
      for (const file of data.changes.files) {
        const marker = file.kind === "added" ? "A" : file.kind === "deleted" ? "D" : file.kind === "renamed" ? "R" : "M";
        const label = file.kind === "renamed" ? `${safePath(file.previousPath)} → ${safePath(file.path)}` : safePath(file.path);
        const prefix = `    ${marker} `;
        const detail = file.detail ? ` ${file.detail}` : ` +${file.additions} −${file.deletions}`;
        const labelWidth = width - visibleWidth(prefix) - visibleWidth(detail);
        const fittedLabel = labelWidth > 0 ? truncateToWidth(label, labelWidth, "…") : "";
        const styledDetail = file.detail
          ? theme.fg("dim", detail)
          : `${theme.fg("success", ` +${file.additions}`)} ${theme.fg("error", `−${file.deletions}`)}`;
        lines.push(`${theme.fg("accent", `${prefix}${fittedLabel}`)}${styledDetail}`);
      }
      if (data.changes.omittedFiles > 0) lines.push(theme.fg("dim", `    … ${data.changes.omittedFiles} more files`));
    }
    if (this.expanded) {
      for (const check of data.checks) lines.push(theme.fg(check.outcome === "passed" ? "success" : "error", `    ${check.outcome === "passed" ? "✓" : "×"} ${check.label}`));
      const omitted = data.omittedChecks.passed + data.omittedChecks.failed;
      if (omitted > 0) lines.push(theme.fg("dim", `    … ${omitted} more checks`));
    }
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }

  invalidate(): void {}
}

export function workedForOutcome(stopReason: StopReason | undefined): WorkedForOutcome {
  if (stopReason === "stop") return "done";
  if (stopReason === "aborted") return "stopped";
  return "failed";
}

type ActiveReceipt = {
  startedAt: number;
  startedTokens: number | undefined;
  stopReason: StopReason | undefined;
  collection: Promise<ChangeReceiptCollection>;
  checks: VerificationAttempt[];
  omittedChecks: { passed: number; failed: number };
};

function fitPayload(data: WorkedForEntryDataV4): WorkedForEntryDataV4 {
  if (data.changes.state === "unavailable") return data;
  const changes = { ...data.changes, files: [...data.changes.files] };
  const fitted = { ...data, changes };
  while (changes.files.length > 0 && Buffer.byteLength(JSON.stringify(fitted), "utf8") > MAX_PAYLOAD_BYTES) {
    changes.files.pop();
    changes.omittedFiles += 1;
  }
  return fitted;
}

export function registerWorkedFor(
  pi: ExtensionAPI,
  now: () => number = Date.now,
  collect: (cwd: string) => Promise<ChangeReceiptCollection> = beginChangeReceipt,
): void {
  let active: ActiveReceipt | undefined;
  let collectionNoticeShown = false;

  pi.registerEntryRenderer<WorkedForEntryData>(WORKED_FOR_ENTRY_TYPE, (entry, options, theme) => {
    const data = parseWorkedForEntryData(entry.data);
    if (!data) return undefined;
    if (data.version === 1) return new Text(theme.fg("dim", `✻ Worked for ${formatWorkedForDuration(data.milliseconds)}`), 0, 0);
    if (data.version === 4) return new WorkedForV4Component(data, options.expanded, theme);
    const outcome = OUTCOMES[data.outcome];
    const tokens = data.version === 3 ? ` · ↑ ${formatTokens(data.tokens)} tokens` : "";
    return new Text(`${theme.fg(outcome.color, `${outcome.marker} ${outcome.label}`)}${theme.fg("dim", ` · ${formatWorkedForDuration(data.milliseconds)}${tokens}`)}`, 0, 0);
  });

  pi.on("session_start", async () => {
    const stale = active;
    active = undefined;
    collectionNoticeShown = false;
    if (stale) await (await stale.collection).dispose();
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" || active) return;
    const state: ActiveReceipt = {
      startedAt: now(),
      startedTokens: sessionTokenTotal(ctx),
      stopReason: undefined,
      collection: collect(ctx.cwd),
      checks: [],
      omittedChecks: { passed: 0, failed: 0 },
    };
    active = state;
    const collection = await state.collection;
    if (active !== state) await collection.dispose();
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    if (ctx.mode !== "tui" || !active || event.toolName !== "bash" && event.toolName !== "powershell") return;
    const check = recognizedVerification(event.input.command, event.isError);
    if (!check) return;
    if (active.checks.length < 20) active.checks.push(check);
    else active.omittedChecks[check.outcome] += 1;
  });

  pi.on("agent_end", (event, ctx) => {
    if (ctx.mode !== "tui" || !active) return;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message?.role !== "assistant") continue;
      active.stopReason = message.stopReason;
      break;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !active) return;
    const settled = active;
    active = undefined;
    const changes = await (await settled.collection).finish();
    if (changes.state === "unavailable" && changes.reason !== "not-git" && !collectionNoticeShown) {
      collectionNoticeShown = true;
      ctx.ui.notify(`Change receipt unavailable: ${changes.reason}`, "warning");
    }
    const settledTokens = sessionTokenTotal(ctx);
    const data = fitPayload({
      version: 4,
      milliseconds: Math.max(0, now() - settled.startedAt),
      outcome: workedForOutcome(settled.stopReason),
      tokens: settled.startedTokens === undefined || settledTokens === undefined ? 0 : Math.max(0, settledTokens - settled.startedTokens),
      changes,
      checks: settled.checks,
      omittedChecks: settled.omittedChecks,
    });
    try {
      pi.appendEntry<WorkedForEntryDataV4>(WORKED_FOR_ENTRY_TYPE, data);
    } catch (error) {
      ctx.ui.notify(`Worked-for timing could not be saved: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    const stale = active;
    active = undefined;
    if (stale) await (await stale.collection).dispose();
    disposeChangeReceipts();
  });
}
