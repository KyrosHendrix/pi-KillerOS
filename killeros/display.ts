import os from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.ts";

/** Formats a terminal-safe, single-line project path with home abbreviation. */
export function formatCwd(cwd: string): string {
  const safeCwd = safeTerminalText(cwd).replaceAll("\n", "");
  const home = safeTerminalText(process.env.HOME || process.env.USERPROFILE || os.homedir()).replaceAll("\n", "");
  if (!home) return safeCwd;
  const normalizedHome = home.replace(/[\\/]+$/, "");
  const normalizedCwd = safeCwd.replace(/[\\/]+$/, "");
  const comparedHome = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;
  const comparedCwd = process.platform === "win32" ? normalizedCwd.toLowerCase() : normalizedCwd;
  if (comparedCwd === comparedHome) return "~";
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  return comparedCwd.startsWith(comparedHome) && (separator === "/" || separator === "\\")
    ? `~${normalizedCwd.slice(normalizedHome.length)}`
    : safeCwd;
}

export function padRight(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function formatTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "0s";
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(Math.max(0, value));
  if (rounded < 1_000) return `${rounded}`;
  if (rounded >= 1_000_000) {
    const precision = rounded >= 10_000_000 ? 0 : 1;
    return `${Number((rounded / 1_000_000).toFixed(precision))}M`;
  }
  const precision = rounded >= 100_000 ? 0 : 1;
  const inK = Number((rounded / 1_000).toFixed(precision));
  if (inK >= 1_000) return `${Number((rounded / 1_000_000).toFixed(1))}M`;
  return `${inK}k`;
}

/** Resolves a terminal-safe model display name, preferring the name over the id. */
export function modelDisplayName(model: { name?: string; id?: string }): string {
  const name = safeTerminalText(model.name ?? "").replaceAll("\n", "").trim();
  if (name) return name;
  return safeTerminalText(model.id ?? "").replaceAll("\n", "").trim();
}
