import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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

const LOCK_RETRY_MILLISECONDS = 10;
const LOCK_TIMEOUT_MILLISECONDS = 10_000;

function readLockOwnerPid(lockPath: string): number | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!isSettings(value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
    return value.pid;
  } catch {
    return undefined;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

function moveLockAside(lockPath: string): boolean {
  const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  while (true) {
    try {
      renameSync(lockPath, stalePath);
      break;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      if (
        Date.now() >= deadline
        || !["EACCES", "EBUSY", "EPERM"].some((code) => hasErrorCode(error, code))
      ) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MILLISECONDS);
    }
  }
  rmSync(stalePath, { force: true });
  return true;
}

function recoverSettingsLock(lockPath: string, expectedPid: number): boolean {
  const recoveryPath = `${lockPath}.recovery`;
  try {
    mkdirSync(recoveryPath);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    // Recheck under exclusive recovery ownership; another waiter may have replaced the lock.
    return readLockOwnerPid(lockPath) === expectedPid && !isProcessRunning(expectedPid) && moveLockAside(lockPath);
  } finally {
    // ponytail: a crash during recovery leaves .recovery for manual removal; never steal it and risk lost writes.
    rmdirSync(recoveryPath);
  }
}

function acquireSettingsLock(settingsPath: string): () => void {
  const lockPath = `${settingsPath}.lock`;
  const ownerPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    while (true) {
      try {
        linkSync(ownerPath, lockPath);
        break;
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        const currentOwnerPid = readLockOwnerPid(lockPath);
        if (currentOwnerPid && !isProcessRunning(currentOwnerPid) && recoverSettingsLock(lockPath, currentOwnerPid)) continue;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for KillerOS settings lock: ${lockPath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MILLISECONDS);
      }
    }
  } finally {
    rmSync(ownerPath, { force: true });
  }

  return () => {
    moveLockAside(lockPath);
  };
}

export function createKillerosSettingsStore(
  settingsPath = join(getAgentDir(), "killeros.json"),
): KillerosSettingsStore {
  return {
    load: () => readStoredSettings(settingsPath),
    update: (patch) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      const releaseLock = acquireSettingsLock(settingsPath);
      const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const current = readStoredSettings(settingsPath);
        writeFileSync(
          temporaryPath,
          `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        renameSync(temporaryPath, settingsPath);
      } finally {
        try {
          rmSync(temporaryPath, { force: true });
        } finally {
          releaseLock();
        }
      }
    },
  };
}
