import { closeSync, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from "node:fs";

/**
 * Compares Windows file identity from bigint stats. Node's numeric `ino` is a double, so
 * distinct 64-bit file IDs above 2^53 can collapse to one value and hide a swapped file.
 */
export function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Why a file was refused: it is not one regular, single-link file, or it was swapped while being opened. */
export class UnstableFileError extends Error {
  readonly reason: "not-regular" | "changed";

  constructor(reason: UnstableFileError["reason"]) {
    super(reason === "changed" ? "File changed while being opened" : "File must be a regular, non-linked file");
    this.reason = reason;
  }
}

/** Reads up to `limit` bytes of a regular, single-link file through a descriptor proven to be the inspected path. */
export function readUnlinkedFile(filePath: string, limit: number): { content: Buffer; truncated: boolean } {
  const linked = lstatSync(filePath, { bigint: true });
  if (!linked.isFile() || linked.nlink !== 1n) throw new UnstableFileError("not-regular");
  const descriptor = openSync(filePath, "r");
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) throw new UnstableFileError("not-regular");
    if (!sameFileIdentity(opened, linked)) throw new UnstableFileError("changed");
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    return { content: buffer.subarray(0, Math.min(bytesRead, limit)), truncated: bytesRead > limit };
  } finally {
    closeSync(descriptor);
  }
}
