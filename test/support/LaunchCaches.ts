import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sharedRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  ".cache",
);
const caches = [
  { link: "jiti", target: path.join(sharedRoot, "killeros-test-jiti") },
  {
    link: "node-compile-cache",
    target: path.join(sharedRoot, "killeros-test-compile"),
  },
] as const;

export function shareLaunchCaches(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const temp = env.TEMP ?? env.TMP;
  if (!temp) return env;
  for (const { link, target } of caches) {
    try {
      mkdirSync(target, { recursive: true });
      mkdirSync(temp, { recursive: true });
      symlinkSync(target, path.join(temp, link), "junction");
    } catch {
      continue;
    }
  }
  return env;
}
