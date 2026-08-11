import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const WORKED_FOR_ENTRY_TYPE = "killeros-worked-for";
const WORKED_FOR_ENTRY_VERSION = 1;

interface WorkedForEntryData {
  version: typeof WORKED_FOR_ENTRY_VERSION;
  milliseconds: number;
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

function isWorkedForEntryData(data: unknown): data is WorkedForEntryData {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Partial<WorkedForEntryData>;
  return candidate.version === WORKED_FOR_ENTRY_VERSION
    && typeof candidate.milliseconds === "number"
    && Number.isFinite(candidate.milliseconds)
    && candidate.milliseconds >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerWorkedFor(
  pi: ExtensionAPI,
  now: () => number = Date.now,
): void {
  let startedAt: number | undefined;

  pi.registerEntryRenderer<WorkedForEntryData>(WORKED_FOR_ENTRY_TYPE, (entry, _options, theme) => {
    if (!isWorkedForEntryData(entry.data)) return undefined;
    return new Text(
      theme.fg("dim", `✻ Worked for ${formatWorkedForDuration(entry.data.milliseconds)}`),
      0,
      0,
    );
  });

  pi.on("session_start", () => {
    startedAt = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt !== undefined) return;
    startedAt = now();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || startedAt === undefined) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const milliseconds = Math.max(0, now() - startedAt);
    startedAt = undefined;
    try {
      pi.appendEntry<WorkedForEntryData>(WORKED_FOR_ENTRY_TYPE, {
        version: WORKED_FOR_ENTRY_VERSION,
        milliseconds,
      });
    } catch (error) {
      ctx.ui.notify(`Worked-for timing could not be saved: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
  });
}
