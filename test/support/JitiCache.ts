import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi transpiles TypeScript extensions with jiti, which caches output under os.tmpdir()/jiti.
 * Scenarios give every Pi launch a private TEMP, so each launch would otherwise re-transpile
 * KillerOS (about 0.8 s of a 1.1 s startup).
 *
 * Each launch's TEMP/jiti is a directory junction to one shared cache, so launches read and write
 * it directly. Copying entries in and out instead cost seconds per launch once the cache grew,
 * because antivirus scanning applies to every copied script.
 *
 * jiti names entries by source path and ends each with a hash of the source text, rejecting any
 * entry whose hash no longer matches. A stale or partial file therefore only costs a re-transpile;
 * it can never run outdated code. Removing TEMP recursively unlinks the junction, not its target.
 */
const sharedCache = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".cache", "killeros-test-jiti");

/** Points a launch's jiti cache at the shared cache before Pi starts. Best effort. */
export function shareJitiCache(env: NodeJS.ProcessEnv): void {
  const temp = env.TEMP ?? env.TMP;
  if (!temp) return;
  try {
    mkdirSync(sharedCache, { recursive: true });
    mkdirSync(temp, { recursive: true });
    symlinkSync(sharedCache, path.join(temp, "jiti"), "junction");
  } catch { /* an existing cache or link stays as it is; jiti transpiles what it lacks */ }
}
