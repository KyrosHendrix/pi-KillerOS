import type { BigIntStats } from "node:fs";

/**
 * Compares Windows file identity from bigint stats. Node's numeric `ino` is a double, so
 * distinct 64-bit file IDs above 2^53 can collapse to one value and hide a swapped file.
 */
export function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
