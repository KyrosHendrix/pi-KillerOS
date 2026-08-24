import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { hasErrorCode } from "./errors.ts";

const TARGET_LIMIT = 128 * 1024;
const REQUIRED_GUIDANCE_HEADINGS = [
  "# AGENTS.md",
  "## 1. Think Before Coding",
  "## 2. Simplicity First",
  "## 3. Surgical Changes",
  "## 4. Goal-Driven Execution",
] as const;

export type InitTargetBaseline =
  | { exists: false }
  | {
      exists: true;
      content: string;
      digest: string;
      dev: number;
      ino: number;
      mode: number;
      nlink: number;
    };

export interface InitInstallOperations {
  renameFile?: typeof fs.rename;
  linkFile?: typeof fs.link;
  unlinkFile?: typeof fs.unlink;
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function captureExistingTarget(targetPath: string): Promise<Extract<InitTargetBaseline, { exists: true }>> {
  const pathStat = await fs.lstat(targetPath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1) {
    throw new Error("/init requires root AGENTS.md to be absent or a regular, non-linked file");
  }
  if (pathStat.size > TARGET_LIMIT) throw new Error(`/init root AGENTS.md exceeds ${TARGET_LIMIT} bytes`);
  const handle = await fs.open(targetPath, constants.O_RDONLY);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.nlink !== 1
      || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error("/init target changed while /init was inspecting it");
    }
    if (openedStat.size > TARGET_LIMIT) throw new Error(`/init root AGENTS.md exceeds ${TARGET_LIMIT} bytes`);
    const bytes = await handle.readFile();
    if (bytes.length > TARGET_LIMIT) throw new Error(`/init root AGENTS.md exceeds ${TARGET_LIMIT} bytes`);
    return {
      exists: true,
      content: bytes.toString("utf8"),
      digest: digest(bytes),
      dev: openedStat.dev,
      ino: openedStat.ino,
      mode: openedStat.mode,
      nlink: openedStat.nlink,
    };
  } finally {
    await handle.close();
  }
}

export async function captureInitTargetBaseline(targetPath: string): Promise<InitTargetBaseline> {
  try {
    return await captureExistingTarget(targetPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { exists: false };
    throw error;
  }
}

function sameBaseline(left: InitTargetBaseline, right: InitTargetBaseline): boolean {
  if (!left.exists) return !right.exists;
  if (!right.exists) return false;
  return left.digest === right.digest
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink;
}

async function installedCandidateMatches(
  targetPath: string,
  candidate: Extract<InitTargetBaseline, { exists: true }>,
): Promise<boolean> {
  try {
    const pathStat = await fs.lstat(targetPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 2) return false;
    const handle = await fs.open(targetPath, constants.O_RDONLY);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.nlink !== 2
        || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino
        || openedStat.size > TARGET_LIMIT) return false;
      const bytes = await handle.readFile();
      return bytes.length <= TARGET_LIMIT
        && openedStat.dev === candidate.dev
        && openedStat.ino === candidate.ino
        && openedStat.mode === candidate.mode
        && digest(bytes) === candidate.digest;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeCandidateName(candidatePath: string, unlinkFile: typeof fs.unlink): Promise<void> {
  try {
    await unlinkFile(candidatePath);
  } catch {
    // The target is already committed through an exclusive hard link. Temporary-name
    // cleanup is best effort and must not turn that successful commit into a false failure.
  }
}

export function validateGeneratedGuidance(content: string): string | undefined {
  const size = Buffer.byteLength(content, "utf8");
  if (size < 1 || size > TARGET_LIMIT) return `/init output must be between 1 and ${TARGET_LIMIT} UTF-8 bytes`;
  if (content.split("\n", 1)[0] !== "# AGENTS.md") return "generated guidance must start with the exact # AGENTS.md heading";
  let previous = -1;
  for (const heading of REQUIRED_GUIDANCE_HEADINGS) {
    const matches = [...content.matchAll(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "gmu"))];
    if (matches.length !== 1) return `generated guidance must contain ${heading} exactly once`;
    const match = matches[0];
    if (!match) return `generated guidance must contain ${heading} exactly once`;
    const index = match.index;
    if (index <= previous) return "generated guidance headings must occur in the required order";
    previous = index;
  }
  if (/\[(?:FILL IN|exact|confirmed)/iu.test(content)) return "generated guidance contains an unresolved template marker";
  return undefined;
}

function recoveryPath(targetPath: string): string {
  return path.join(path.dirname(targetPath), `.killeros-init-recovery-${randomUUID()}.md`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/** Installs generated guidance atomically and preserves any target changed after baseline capture. */
export async function installInitAgentsFile(
  targetPath: string,
  content: string,
  baseline: InitTargetBaseline,
  operations: InitInstallOperations = {},
): Promise<void> {
  const validationError = validateGeneratedGuidance(content);
  if (validationError) throw new Error(validationError);
  const renameFile = operations.renameFile ?? fs.rename;
  const linkFile = operations.linkFile ?? fs.link;
  const unlinkFile = operations.unlinkFile ?? fs.unlink;

  return withFileMutationQueue(targetPath, async () => {
    const current = await captureInitTargetBaseline(targetPath);
    if (!sameBaseline(current, baseline)) {
      throw new Error("/init target changed while /init was generating; the newer AGENTS.md was preserved");
    }

    const tempDirectory = await fs.mkdtemp(path.join(path.dirname(targetPath), ".killeros-init-"));
    const candidatePath = path.join(tempDirectory, "candidate.md");
    const heldPath = path.join(tempDirectory, "held.md");
    let held = false;
    let installed = false;
    let candidate: Extract<InitTargetBaseline, { exists: true }> | undefined;
    let retainedRecovery: string | undefined;
    try {
      const handle = await fs.open(candidatePath, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      candidate = await captureExistingTarget(candidatePath);
      if (!baseline.exists) {
        try {
          await linkFile(candidatePath, targetPath);
          installed = true;
        } catch (error) {
          if (hasErrorCode(error, "EEXIST")) {
            throw new Error("/init target changed while /init was generating; the newer AGENTS.md was preserved");
          }
          throw error;
        }
        if (!await installedCandidateMatches(targetPath, candidate)) {
          throw new Error("/init target changed while /init was generating; the newer AGENTS.md was preserved");
        }
        await removeCandidateName(candidatePath, unlinkFile);
        installed = false;
        return;
      }

      // Node cannot lock arbitrary external writers. The exclusive links, held-target
      // boundary, final held-file hash, and Pi mutation queue make installation fail closed.
      await renameFile(targetPath, heldPath);
      held = true;
      const moved = await captureExistingTarget(heldPath);
      if (!sameBaseline(moved, baseline)) {
        if (!await pathExists(targetPath)) {
          await renameFile(heldPath, targetPath);
          held = false;
          throw new Error("/init target changed while /init was generating; the newer AGENTS.md was preserved");
        }
        retainedRecovery = recoveryPath(targetPath);
        await renameFile(heldPath, retainedRecovery);
        held = false;
        throw new Error(`/init target changed while /init was generating; both versions were preserved; recovery file: ${retainedRecovery}`);
      }

      try {
        await linkFile(candidatePath, targetPath);
        installed = true;
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          retainedRecovery = recoveryPath(targetPath);
          await renameFile(heldPath, retainedRecovery);
          held = false;
          throw new Error(`/init target changed while /init was generating; the newer AGENTS.md was preserved; recovery file: ${retainedRecovery}`);
        }
        throw error;
      }

      const finalHeld = await captureExistingTarget(heldPath);
      if (!sameBaseline(finalHeld, baseline) || !await installedCandidateMatches(targetPath, candidate)) {
        throw new Error("/init target changed while /init was generating; the newer AGENTS.md was preserved");
      }
      await unlinkFile(heldPath);
      held = false;
      await removeCandidateName(candidatePath, unlinkFile);
      installed = false;
    } catch (error) {
      if (held) {
        if (installed && candidate && await installedCandidateMatches(targetPath, candidate)) {
          try {
            await unlinkFile(targetPath);
            installed = false;
          } catch {
            // A different writer may have replaced the linked candidate.
          }
        }
        if (!await pathExists(targetPath)) {
          try {
            await renameFile(heldPath, targetPath);
            held = false;
          } catch {
            // The original error remains primary; cleanup below retains bytes if needed.
          }
        }
        if (held) {
          retainedRecovery = recoveryPath(targetPath);
          try {
            await renameFile(heldPath, retainedRecovery);
            held = false;
          } catch {
            // Leave the non-empty temporary directory rather than deleting held bytes.
          }
        }
      }
      if (retainedRecovery && error instanceof Error && !error.message.includes(retainedRecovery)) {
        throw new Error(`${error.message}; recovery file: ${retainedRecovery}`, { cause: error });
      }
      throw error;
    } finally {
      try {
        await fs.rm(tempDirectory, { recursive: !held, force: !held });
      } catch {
        // A retained held file is safer than deleting ambiguous user bytes.
      }
    }
  });
}

export async function writeInitAgentsFile(
  targetPath: string,
  content: string,
  renameFile: typeof fs.rename = fs.rename,
): Promise<void> {
  const baseline = await captureInitTargetBaseline(targetPath);
  return installInitAgentsFile(targetPath, content, baseline, { renameFile });
}
