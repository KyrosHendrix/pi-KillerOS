import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readlink, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { inspectWorktreeWithoutFilters, passiveGitCommand, passiveGitEnv } from "../killeros/passive-git-status.ts";

const gitCommand = passiveGitCommand(process.cwd()) ?? assert.fail("expected a safe system Git");
const env = {
  ...passiveGitEnv(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
  GIT_ATTR_NOSYSTEM: "1",
};

function git(root: string, args: readonly string[], input?: string): Buffer {
  return execFileSync(gitCommand, [...args], { cwd: root, env, input, stdio: ["pipe", "pipe", "pipe"] });
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "killeros-passive-git-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "killeros@example.invalid"]);
  git(root, ["config", "user.name", "KillerOS test"]);
  git(root, ["config", "core.safecrlf", "false"]);
  return root;
}

const contents = new Map([
  ["lf", "one\ntwo\n"],
  ["crlf", "one\r\ntwo\r\n"],
  ["mixed", "one\r\ntwo\n"],
  ["no-final-newline", "one\r\ntwo"],
  ["empty", ""],
  ["lone-cr", "one\rtwo\r\n"],
  ["nul", "one\0\r\ntwo\r\n"],
  ["controls", "\x01one\r\ntwo\r\n"],
  ["terminal-eof", "one\r\ntwo\r\n\x1a"],
]);
const rewrites = new Map([
  ...contents,
  ["edit", "one\r\nchanged\r\n"],
]);
const attributes = [
  "", "* text=auto", "* text=auto eol=lf", "* text=auto eol=crlf",
  "* eol=lf", "* text", "* -text", "* binary",
  "* text=auto eol=lf\noverride-* -text",
  "* -text\noverride-* eol=lf !text",
];

test("passive content comparison agrees with Git's conversion oracle", async (t) => {
  for (const attribute of attributes) {
    for (const autoCrlf of ["false", "true", "input"]) {
      await t.test(JSON.stringify({ attribute, autoCrlf }), async (t) => {
        const root = await fixture(t);
        git(root, ["config", "core.autocrlf", autoCrlf]);
        await writeFile(path.join(root, ".gitattributes"), `${attribute}\n`);
        const cases: Array<{ file: string; indexed: string; working: string; content: string }> = [];
        for (const [indexed, initialContent] of contents) {
          for (const [working, content] of new Map([["same", initialContent], ...rewrites])) {
            for (const prefix of ["default", "override"]) {
              const file = `${prefix}-${indexed}-${working}.txt`;
              cases.push({ file, indexed, working, content });
              await writeFile(path.join(root, file), initialContent);
            }
          }
        }
        git(root, ["add", "."]);
        git(root, ["commit", "--quiet", "-m", "conversion matrix"]);
        const indexIds = new Map(git(root, ["ls-files", "-s"]).toString().trim().split("\n").map((record) => {
          const [metadata, file] = record.split("\t");
          assert.ok(metadata && file);
          return [file, metadata.split(" ")[1]];
        }));
        for (const { file, content } of cases) {
          await writeFile(path.join(root, file), content);
          // Force content comparison even on files with unchanged bytes and coarse timestamps.
          await utimes(path.join(root, file), new Date(0), new Date(0));
        }
        // These isolated repositories have no filters. Batch hashing applies each file's attributes,
        // just like hash-object --path=<file> <file>, without one Git process per matrix row.
        const oracleIds = git(root, ["hash-object", "--stdin-paths"], cases.map(({ file }) => file).join("\n") + "\n")
          .toString().trim().split("\n");
        assert.equal(oracleIds.length, cases.length);
        const snapshot = await inspectWorktreeWithoutFilters(root, async (args) => git(root, args));
        for (const [position, { file, indexed, working }] of cases.entries()) {
          const indexId = indexIds.get(file);
          const oracleId = oracleIds[position];
          assert.ok(indexId && oracleId);
          assert.equal(snapshot.files.has(file), oracleId !== indexId,
            JSON.stringify({ attribute, autoCrlf, file, indexed, working, indexId, oracleId }));
        }
      });
    }
  }
});

test("passive mode comparison agrees with Git for executable changes", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "file"), "one\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "mode fixture"]);
  await chmod(path.join(root, "file"), 0o755);
  for (const fileMode of ["true", "false"]) {
    git(root, ["config", "core.filemode", fileMode]);
    const oracleChanged = git(root, ["diff-files", "--name-only"]).toString().trim() === "file";
    assert.equal(oracleChanged, fileMode === "true");
    const snapshot = await inspectWorktreeWithoutFilters(root, async (args) => git(root, args));
    assert.equal(snapshot.files.has("file"), oracleChanged);
  }
});

test("passive symlink comparison hashes destinations without text conversion", async (t) => {
  const root = await fixture(t);
  try {
    await symlink("one\r\ntwo", path.join(root, "link"), "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(String(error.code))) {
      t.skip("Filesystem does not permit these symlinks");
      return;
    }
    throw error;
  }
  git(root, ["config", "core.symlinks", "true"]);
  await writeFile(path.join(root, ".gitattributes"), "* text eol=lf\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "symlink fixture"]);
  const indexId = git(root, ["rev-parse", ":link"]).toString().trim();
  for (const destination of ["one\r\ntwo", "one\ntwo", "changed"]) {
    await rm(path.join(root, "link"));
    await symlink(destination, path.join(root, "link"), "file");
    const oracleId = git(root, ["hash-object", "--no-filters", "--stdin"], await readlink(path.join(root, "link"))).toString().trim();
    const snapshot = await inspectWorktreeWithoutFilters(root, async (args) => git(root, args));
    assert.equal(snapshot.files.has("link"), oracleId !== indexId, JSON.stringify({ destination, indexId, oracleId }));
  }
});
