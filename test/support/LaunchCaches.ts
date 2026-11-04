import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Scenarios give every Pi launch a private TEMP, and Pi keeps two caches under os.tmpdir():
 *
 * - jiti transpiles TypeScript extensions into TEMP/jiti. Without sharing, each launch would
 *   re-transpile KillerOS (about 0.8 s of a 1.1 s startup).
 * - Pi's CLI calls module.enableCompileCache(), which stores V8 code caches for its bundle in
 *   TEMP/node-compile-cache. Without sharing, each launch compiles the bundle again (about 0.12 s).
 *
 * Each launch's cache directories are directory junctions to one shared cache per kind, so launches
 * read and write them directly and Pi's environment stays unchanged. Copying entries in and out
 * instead cost seconds per launch once the caches grew, because antivirus scanning applies to every
 * copied script.
 *
 * Both caches validate entries against their source: jiti ends each entry with a hash of the source
 * text, and V8 code caches carry the source hash and a checksum. A stale or partial entry therefore
 * only costs a recompile; it can never run outdated code. Removing TEMP recursively unlinks the
 * junctions, not their targets.
 */
const sharedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".cache");
const caches = [
  { link: "jiti", target: path.join(sharedRoot, "killeros-test-jiti") },
  { link: "node-compile-cache", target: path.join(sharedRoot, "killeros-test-compile") },
] as const;

/** Points a launch's jiti and V8 compile caches at the shared caches before Pi starts. Best effort. */
export function shareLaunchCaches(env: NodeJS.ProcessEnv): void {
  const temp = env.TEMP ?? env.TMP;
  if (!temp) return;
  for (const { link, target } of caches) {
    try {
      mkdirSync(target, { recursive: true });
      mkdirSync(temp, { recursive: true });
      symlinkSync(target, path.join(temp, link), "junction");
    } catch { /* an existing cache or link stays as it is; Pi compiles what it lacks */ }
  }
}
