import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { hideGitConsole, passiveWorktreeSettings, type PassiveGitRunner } from "../killeros/passive-git-status.ts";

// Hiding a console child starts a second process, conhost.exe, per Git call. A process with a console lets
// its Git children share it, so only a process without one may hide them.

const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "..", "killeros", "passive-git-status.ts")).href;

test("a process with a console keeps automatic Git children on it", () => {
  assert.equal(hideGitConsole(), false, "The test process has a console");
});

test("a process started on a hidden console keeps Git children on that console without creating files", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-git-console-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Editors start Pi this way: windowsHide gives the child a hidden console of its own.
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval",
    `const { hideGitConsole } = await import(${JSON.stringify(moduleUrl)}); console.log(hideGitConsole());`],
  { cwd: directory, encoding: "utf8", windowsHide: true }).trim();
  assert.equal(output, "false");
  assert.equal(existsSync(path.join(directory, "CONOUT$")), false, "The console check opens the device, never a file named CONOUT$");
});

/** A runner that answers the single settings read with `records`, as `git config -z --get-regexp` prints them. */
function configOutput(...records: string[]): PassiveGitRunner {
  return async (args) => {
    assert.ok(args.includes("--get-regexp") && args.includes("--type=bool-or-str"), "Settings come from one normalized Git read");
    return Buffer.from([...records, "killeros.probe\ntrue"].map((record) => `${record}\0`).join(""));
  };
}

test("worktree settings follow Git's --get rules for every scope in one read", async () => {
  assert.deepEqual(await passiveWorktreeSettings(configOutput()), { autoCrlf: "false", fileMode: true, symlinks: true },
    "Unset keys take Git's defaults");
  assert.deepEqual(await passiveWorktreeSettings(configOutput(
    "core.autocrlf\ntrue", "core.symlinks\nfalse", "core.filemode\nfalse",
    "core.filemode\ntrue", "core.symlinks", "core.autocrlf\nInput",
  )), { autoCrlf: "input", fileMode: true, symlinks: true }, "The last value wins, and a key without a value is true");
});

test("worktree settings fail closed on values Git cannot read as booleans or on incomplete output", async () => {
  await assert.rejects(passiveWorktreeSettings(configOutput("core.filemode\nbogus", "core.filemode\ntrue")), /core\.filemode/u,
    "Like --type=bool, any unreadable value fails the scan even when a later value is valid");
  await assert.rejects(passiveWorktreeSettings(async () => Buffer.from("core.filemode\ntrue\0")), /incomplete/u,
    "Output without the probe key was cut short");
});
