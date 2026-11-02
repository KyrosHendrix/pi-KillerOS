import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Loaded with `--import` by the test commands. Points TEMP and TMP at one dedicated root,
 * %TEMP%\killeros-tests, so every scenario's scratch files, Git fixtures, and Pi launches share
 * one folder that a local antivirus exclusion can target without excluding all of %TEMP%.
 *
 * os.tmpdir() reads these variables on every call, and test files and Pi children inherit them.
 */
const current = os.tmpdir();
if (path.basename(current) !== "killeros-tests") {
  const root = path.join(current, "killeros-tests");
  mkdirSync(root, { recursive: true });
  process.env.TEMP = root;
  process.env.TMP = root;
}
