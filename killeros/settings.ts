import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hasErrorCode } from "./errors.ts";

export type KillerosSettings = Record<string, unknown>;

export interface KillerosSettingsStore {
  load(): KillerosSettings;
  update(patch: Readonly<Record<string, unknown>>): void;
}

function isSettings(value: unknown): value is KillerosSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredSettings(settingsPath: string): KillerosSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isSettings(parsed)) throw new Error("KillerOS settings must contain a JSON object");
    return parsed;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return {};
    throw error;
  }
}

export function createKillerosSettingsStore(
  settingsPath = join(getAgentDir(), "killeros.json"),
): KillerosSettingsStore {
  return {
    load: () => readStoredSettings(settingsPath),
    update: (patch) => {
      const current = readStoredSettings(settingsPath);
      mkdirSync(dirname(settingsPath), { recursive: true });
      const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(
          temporaryPath,
          `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        renameSync(temporaryPath, settingsPath);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    },
  };
}
