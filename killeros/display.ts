import os from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) return cwd;
  const normalizedHome = home.replace(/[\\/]+$/, "");
  const normalizedCwd = cwd.replace(/[\\/]+$/, "");
  const comparedHome = process.platform === "win32" ? normalizedHome.toLocaleLowerCase() : normalizedHome;
  const comparedCwd = process.platform === "win32" ? normalizedCwd.toLocaleLowerCase() : normalizedCwd;
  if (comparedCwd === comparedHome) return "~";
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  return comparedCwd.startsWith(comparedHome) && (separator === "/" || separator === "\\")
    ? `~${normalizedCwd.slice(normalizedHome.length)}`
    : cwd;
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
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const amount = Math.max(0, value);
  if (amount < 1_000) return `${Math.round(amount)}`;
  if (amount >= 1_000_000) {
    const precision = amount >= 10_000_000 ? 0 : 1;
    return `${Number((amount / 1_000_000).toFixed(precision))}M`;
  }
  const precision = amount >= 100_000 ? 0 : 1;
  return `${Number((amount / 1_000).toFixed(precision))}k`;
}
