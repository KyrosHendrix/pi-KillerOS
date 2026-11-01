import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi transpiles TypeScript extensions with jiti, which caches output under os.tmpdir()/jiti.
 * Scenarios give every Pi launch a private TEMP, so each launch would otherwise re-transpile
 * KillerOS (about 0.8 s of a 1.1 s startup). These helpers share that cache across launches.
 *
 * jiti names entries by source path and ends each with a hash of the source text, rejecting any
 * entry whose hash no longer matches. A stale or partial file therefore only costs a re-transpile;
 * it can never run outdated code.
 */
const sharedCache = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", ".cache", "killeros-test-jiti");

function launchCache(env: NodeJS.ProcessEnv): string | undefined {
  const temp = env.TEMP ?? env.TMP;
  return temp ? path.join(temp, "jiti") : undefined;
}

function entries(directory: string): string[] {
  try { return readdirSync(directory).filter(name => name.endsWith(".mjs") || name.endsWith(".cjs") || name.endsWith(".js")); }
  catch { return []; }
}

/** Copies shared entries into a launch's private cache before Pi starts. Best effort. */
export function seedJitiCache(env: NodeJS.ProcessEnv): void {
  const target = launchCache(env);
  if (!target || !existsSync(sharedCache)) return;
  try { mkdirSync(target, { recursive: true }); } catch { return; }
  for (const name of entries(sharedCache)) {
    const destination = path.join(target, name);
    if (existsSync(destination)) continue;
    try { copyFileSync(path.join(sharedCache, name), destination); } catch { /* jiti transpiles this entry itself */ }
  }
}

/** Publishes entries Pi wrote during a launch so later launches start warm. Best effort. */
export function harvestJitiCache(env: NodeJS.ProcessEnv): void {
  const source = launchCache(env);
  if (!source) return;
  const names = entries(source);
  if (names.length === 0) return;
  try { mkdirSync(sharedCache, { recursive: true }); } catch { return; }
  for (const name of names) {
    const from = path.join(source, name);
    const to = path.join(sharedCache, name);
    try {
      const content = readFileSync(from);
      if (existsSync(to) && readFileSync(to).equals(content)) continue;
      // Rename publishes complete files; a concurrent reader sees either the old or the new entry.
      const staged = `${to}.${process.pid}.tmp`;
      copyFileSync(from, staged);
      try { renameSync(staged, to); } finally { rmSync(staged, { force: true }); }
    } catch { /* another launch may hold the entry open; the next harvest retries */ }
  }
}
