import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StopReason } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";

const WORKED_FOR_ENTRY_TYPE = "killeros-worked-for";

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

type WorkedForEntryData = WorkedForEntryDataV1 | WorkedForEntryDataV2;

const OUTCOMES = {
  done: { marker: "✓", label: "Done", color: "success" },
  stopped: { marker: "■", label: "Stopped", color: "warning" },
  failed: { marker: "×", label: "Failed", color: "error" },
} as const satisfies Record<WorkedForOutcome, { marker: string; label: string; color: string }>;

function isWorkedForOutcome(value: unknown): value is WorkedForOutcome {
  return value === "done" || value === "stopped" || value === "failed";
}

export function formatWorkedForDuration(milliseconds: number): string {
  const boundedMilliseconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  const totalSeconds = Math.max(1, Math.floor(boundedMilliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${(totalSeconds % 60).toString().padStart(2, "0")}s`;
  }

  return `${Math.floor(totalMinutes / 60)}h ${(totalMinutes % 60).toString().padStart(2, "0")}m`;
}

function parseWorkedForEntryData(data: unknown): WorkedForEntryData | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  if (!("version" in data) || !("milliseconds" in data)) return undefined;
  if (typeof data.milliseconds !== "number" || !Number.isFinite(data.milliseconds) || data.milliseconds < 0) {
    return undefined;
  }
  if (data.version === 1) return { version: 1, milliseconds: data.milliseconds };
  if (data.version !== 2 || !("outcome" in data) || !isWorkedForOutcome(data.outcome)) {
    return undefined;
  }
  return { version: 2, milliseconds: data.milliseconds, outcome: data.outcome };
}

export function workedForOutcome(stopReason: StopReason | undefined): WorkedForOutcome {
  if (stopReason === "stop") return "done";
  if (stopReason === "aborted") return "stopped";
  return "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerWorkedFor(
  pi: ExtensionAPI,
  now: () => number = Date.now,
): void {
  let startedAt: number | undefined;
  let stopReason: StopReason | undefined;

  pi.registerEntryRenderer<WorkedForEntryData>(WORKED_FOR_ENTRY_TYPE, (entry, _options, theme) => {
    const data = parseWorkedForEntryData(entry.data);
    if (!data) return undefined;
    if (data.version === 1) {
      return new Text(
        theme.fg("dim", `✻ Worked for ${formatWorkedForDuration(data.milliseconds)}`),
        0,
        0,
      );
    }
    const outcome = OUTCOMES[data.outcome];
    return new Text(
      `${theme.fg(outcome.color, `${outcome.marker} ${outcome.label}`)}${theme.fg("dim", ` · ${formatWorkedForDuration(data.milliseconds)}`)}`,
      0,
      0,
    );
  });

  pi.on("session_start", () => {
    startedAt = undefined;
    stopReason = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt !== undefined) return;
    startedAt = now();
  });

  pi.on("agent_end", (event, ctx) => {
    if (ctx.mode !== "tui" || startedAt === undefined) return;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message?.role !== "assistant") continue;
      stopReason = message.stopReason;
      break;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt === undefined) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const milliseconds = Math.max(0, now() - startedAt);
    const outcome = workedForOutcome(stopReason);
    startedAt = undefined;
    stopReason = undefined;
    try {
      pi.appendEntry<WorkedForEntryDataV2>(WORKED_FOR_ENTRY_TYPE, {
        version: 2,
        milliseconds,
        outcome,
      });
    } catch (error) {
      ctx.ui.notify(`Worked-for timing could not be saved: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
    stopReason = undefined;
  });
}
