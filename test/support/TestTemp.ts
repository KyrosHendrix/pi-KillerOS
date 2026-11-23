import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import "./TimerResolution.ts";

const current = os.tmpdir();
if (path.basename(current) !== "killeros-tests") {
  const root = path.join(current, "killeros-tests");
  mkdirSync(root, { recursive: true });
  process.env.TEMP = root;
  process.env.TMP = root;
}
