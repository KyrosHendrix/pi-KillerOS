import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { beginChangeReceipt, disposeChangeReceipts } from "../killeros/change-receipt.ts";
import { inspectWorktreeWithoutFilters, passiveGitCommand, passiveGitEnv } from "../killeros/passive-git-status.ts";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { repositoryRoot, createFamily, git, initRepository } from "./support/ReceiptGitScenario.ts";

// The matrix checks KillerOS's own change detection against Git for every conversion case. It calls the shared
// detection and the receipt collector directly, the way worked-for.ts does for a request: begin, change files,
// finish. runtime-receipts.e2e.test.ts and runtime-receipt-git.e2e.test.ts cover the same collector inside real Pi.

const contents = new Map([
  ["lf", "one\ntwo\n"], ["crlf", "one\r\ntwo\r\n"], ["mixed", "one\r\ntwo\n"],
  ["no-final-newline", "one\r\ntwo"], ["empty", ""], ["lone-cr", "one\rtwo\r\n"],
  ["nul", "one\0\r\ntwo\r\n"], ["controls", "\x01one\r\ntwo\r\n"], ["terminal-eof", "one\r\ntwo\r\n\x1a"],
]);
const rewrites = new Map([...contents, ["edit", "one\r\nchanged\r\n"]]);
const attributes = ["", "* text=auto", "* text=auto eol=lf", "* text=auto eol=crlf", "* eol=lf", "* text", "* -text", "* binary",
  "* text=auto eol=lf\noverride-* -text", "* -text\noverride-* eol=lf !text"];

/** Runs `body` with HOME isolated in `directory`, as the Pi scenarios did, so user Git config cannot change the result. */
async function withIsolatedHome<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

for (const autoCrlf of ["false", "true", "input"] as const) {
  test(`native receipt paths agree with Git across the conversion matrix (autocrlf ${autoCrlf})`, { timeout: 120_000 }, async () => {
    const family = createFamily(repositoryRoot, `conversion-${autoCrlf}`);
    try {
      await withIsolatedHome(family.directory, async () => {
        initRepository(family.project);
        git(family.project, "config", "core.autocrlf", autoCrlf);
        git(family.project, "config", "core.safecrlf", "false");
        const cases: Array<{ file: string; content: string }> = [];
        for (const [index, attribute] of attributes.entries()) {
          const directory = `attributes-${index}`;
          mkdirSync(path.join(family.project, directory));
          writeFileSync(path.join(family.project, directory, ".gitattributes"), attribute + "\n");
          // Only attribute sets with an override-* rule treat override-prefixed paths differently;
          // elsewhere both prefixes match the same patterns, so a second copy would repeat the case.
          const prefixes = attribute.includes("override-") ? ["default", "override"] : ["default"];
          for (const [indexed, initial] of contents) for (const [working, content] of new Map([["same", initial], ...rewrites])) {
            for (const prefix of prefixes) {
              const file = `${directory}/${prefix}-${indexed}-${working}.txt`;
              cases.push({ file, content });
              writeFileSync(path.join(family.project, file), initial);
            }
          }
        }
        assert.equal(cases.length, 1188, "1,188 distinct attribute, index, and worktree cases for each autocrlf mode");
        git(family.project, "add", ".");
        git(family.project, "commit", "-q", "-m", "full conversion matrix");
        const indexIds = new Map(git(family.project, "ls-files", "-s", "-z").toString().split("\0").filter(Boolean).map(line => {
          const [metadata, file] = line.split("\t");
          assert.ok(metadata && file);
          return [file, metadata.split(" ")[1]];
        }));

        // One receipt spans every case: the baseline is the clean commit, and each file then takes its worktree bytes.
        const collection = await beginChangeReceipt(family.project);
        for (const row of cases) {
          writeFileSync(path.join(family.project, row.file), row.content);
          // An epoch timestamp defeats the index stat cache, so every comparison reads content.
          utimesSync(path.join(family.project, row.file), new Date(0), new Date(0));
        }
        const oracle = execFileSync("git", ["hash-object", "--stdin-paths"], { cwd: family.project,
          input: cases.map(row => row.file).join("\n") + "\n", encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
          .trim().split("\n");
        assert.equal(oracle.length, cases.length);
        const expected = cases.filter((row, index) => oracle[index] !== indexIds.get(row.file)).map(row => row.file).sort();
        assert.ok(expected.length > 0 && expected.length < cases.length, "The matrix mixes clean and changed cases");

        // Detection, shared by the footer and receipts, names exactly the paths Git's own conversion changes.
        const gitCommand = passiveGitCommand(family.project);
        assert.ok(gitCommand);
        const snapshot = await inspectWorktreeWithoutFilters(family.project, async (args) =>
          execFileSync(gitCommand, args, { cwd: family.project, env: passiveGitEnv(), maxBuffer: 64 * 1024 * 1024 }));
        assert.deepEqual([...snapshot.files.keys()].sort(), expected, `${autoCrlf}: every original path agrees with Git`);

        // The receipt counts the same changes and lists only paths from that set.
        const summary = await collection.finish();
        assert.equal(summary.state, "available", autoCrlf);
        if (summary.state !== "available") return;
        assert.equal(summary.totalFiles, expected.length, `${autoCrlf}: the receipt counts every changed path`);
        assert.equal(summary.files.length, Math.min(20, expected.length));
        for (const file of summary.files) assert.ok(expected.includes(file.path), `${autoCrlf}: ${file.path} changed according to Git`);
      });
    } finally {
      disposeChangeReceipts();
      await removeDirectoryEventually(family.directory);
    }
  });
}
