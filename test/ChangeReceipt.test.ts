import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  beginChangeReceipt,
  disposeChangeReceipts,
  recognizedCheck,
  CHECK_LABELS,
} from "../killeros/change-receipt.ts";

after(disposeChangeReceipts);

function git(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "killeros-change-test-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "killeros@example.invalid");
  git(root, "config", "user.name", "KillerOS test");
  await writeFile(path.join(root, "clean.txt"), "clean\n");
  await writeFile(path.join(root, "dirty.txt"), "before\n");
  await writeFile(path.join(root, "rename-me.txt"), "rename\nkept\nstable\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

async function inventory(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await inventory(absolute, relative));
    else result.push(`${relative}:${createHash("sha256").update(await readFile(absolute)).digest("hex")}`);
  }
  return result.sort();
}

test("check recognition stores only exact canonical commands", () => {
  for (const command of CHECK_LABELS) {
    assert.deepEqual(recognizedCheck(` \t${command}\t `, false), { label: command, outcome: "passed" });
  }
  for (const command of [
    "npm test --if-present",
    "npm test --ignore-scripts",
    "npm test --help",
    "npm test -- --runInBand",
    "node --test --help",
    "pytest tests/unit",
    "go test ./...",
    "API_TOKEN=secret npm test",
    "npm test || true",
    "npm test && npm run build",
    "npm test\nnpm run build",
  ]) {
    assert.equal(recognizedCheck(command, false), undefined, command);
  }
});

test("Git collection reports only the response delta and cleans its temporary directory", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "dirty.txt"), "already dirty\n");
  await writeFile(path.join(root, "preexisting.txt"), "preexisting\n");
  const tempBefore = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("killeros-change-receipt-")));
  const collection = await beginChangeReceipt(path.join(root, ".git", ".."));

  await writeFile(path.join(root, "clean.txt"), "clean\nchanged\n");
  await writeFile(path.join(root, "new.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 9, 2, 3]));
  await writeFile(path.join(root, "rename-me.txt"), "rename\nkept\nstable\nchanged\n");
  git(root, "mv", "rename-me.txt", "renamed.txt");
  const summary = await collection.finish();

  assert.deepEqual(summary, {
    state: "available",
    totalFiles: 4,
    additions: 4,
    deletions: 0,
    files: [
      { kind: "modified", path: "binary.bin", additions: 0, deletions: 0, detail: "binary" },
      { kind: "modified", path: "clean.txt", additions: 1, deletions: 0 },
      { kind: "added", path: "new.txt", additions: 2, deletions: 0 },
      { kind: "renamed", path: "renamed.txt", previousPath: "rename-me.txt", additions: 1, deletions: 0 },
    ],
    omittedFiles: 0,
  });
  const status = git(root, "status", "--porcelain=v1", "-z").toString("utf8");
  assert.match(status, /dirty\.txt/u);
  assert.match(status, /preexisting\.txt/u);
  const tempAfter = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("killeros-change-receipt-")));
  assert.deepEqual(tempAfter, tempBefore);
});

test("settlement includes changes that arrive while changed paths are being read", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const largePath = path.join(root, "large.bin");
  await writeFile(largePath, Buffer.alloc(32 * 1024 * 1024, 1));
  await writeFile(path.join(root, "late.txt"), "before\n");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "large fixture");
  await writeFile(largePath, Buffer.alloc(32 * 1024 * 1024, 2));
  const collection = await beginChangeReceipt(root);

  await writeFile(largePath, Buffer.alloc(32 * 1024 * 1024, 3));
  await delay(50);
  const lateWrite = delay(1).then(() => writeFile(path.join(root, "late.txt"), "after\n"));
  const summary = await collection.finish();
  await lateWrite;

  assert.equal(summary.state, "available");
  if (summary.state !== "available") return;
  assert.deepEqual(summary.files.map((file) => file.path), ["large.bin", "late.txt"]);
});

test("index-only staged changes are included in the response delta", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = await beginChangeReceipt(root);
  const patchPath = path.join(root, "change.patch");
  await writeFile(patchPath, [
    "diff --git a/clean.txt b/clean.txt",
    "index 8312631..0000000 100644",
    "--- a/clean.txt",
    "+++ b/clean.txt",
    "@@ -1 +1,2 @@",
    " clean",
    "+staged",
    "",
  ].join("\n"));
  git(root, "apply", "--cached", "change.patch");
  await rm(patchPath);

  assert.deepEqual(await collection.finish(), {
    state: "available",
    totalFiles: 1,
    additions: 1,
    deletions: 0,
    files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 0 }],
    omittedFiles: 0,
  });
});

test("modified binary renames remain one changed file", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = await beginChangeReceipt(root);
  await rename(path.join(root, "binary.bin"), path.join(root, "renamed.bin"));
  await writeFile(path.join(root, "renamed.bin"), Buffer.from([0, 1, 9, 3]));

  assert.deepEqual(await collection.finish(), {
    state: "available",
    totalFiles: 1,
    additions: 0,
    deletions: 0,
    files: [{ kind: "renamed", path: "renamed.bin", previousPath: "binary.bin", additions: 0, deletions: 0, detail: "binary" }],
    omittedFiles: 0,
  });
});

test("a HEAD update without worktree events invalidates the response receipt", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstHead = git(root, "rev-parse", "HEAD").toString("ascii").trim();
  await writeFile(path.join(root, "clean.txt"), "next\n");
  git(root, "add", "clean.txt");
  git(root, "commit", "--quiet", "-m", "next");
  const nextHead = git(root, "rev-parse", "HEAD").toString("ascii").trim();
  git(root, "reset", "--hard", "--quiet", firstHead);

  const collection = await beginChangeReceipt(root);
  git(root, "update-ref", "HEAD", nextHead);
  assert.deepEqual(await collection.finish(), { state: "unavailable", reason: "error" });
});

test("large divergent text changes stop at the diff work limit", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = await beginChangeReceipt(root);
  await writeFile(path.join(root, "clean.txt"), Array.from({ length: 1_200 }, (_, index) => `replacement ${index}\n`).join(""));
  assert.deepEqual(await collection.finish(), { state: "unavailable", reason: "too-large" });
});

test("oversized response files fail before diffing and reset the next baseline", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "clean.txt");
  const collection = await beginChangeReceipt(root);
  await writeFile(target, Buffer.alloc(128 * 1024 * 1024 + 1));
  assert.deepEqual(await collection.finish(), { state: "unavailable", reason: "too-large" });

  await writeFile(target, "clean\n");
  const nextCollection = await beginChangeReceipt(root);
  assert.deepEqual(await nextCollection.finish(), {
    state: "available",
    totalFiles: 0,
    additions: 0,
    deletions: 0,
    files: [],
    omittedFiles: 0,
  });
});

test("restored changes disappear and unavailable repositories stay truthful", async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "killeros-not-git-"));
  t.after(async () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const collection = await beginChangeReceipt(root);
  await writeFile(path.join(root, "clean.txt"), "temporary\n");
  await writeFile(path.join(root, "clean.txt"), "clean\n");
  assert.deepEqual(await collection.finish(), {
    state: "available",
    totalFiles: 0,
    additions: 0,
    deletions: 0,
    files: [],
    omittedFiles: 0,
  });
  assert.deepEqual(await (await beginChangeReceipt(outside)).finish(), { state: "unavailable", reason: "not-git" });
});

test("collection leaves Git state untouched and does not invoke configured extension points", async (t) => {
  const root = await fixture();
  const sentinel = path.join(root, "sentinel");
  const tripwire = path.join(root, "tripwire.cjs");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'invoked'); process.stdout.write('0\\n');\n");
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=tripwire diff=tripwire\n");
  git(root, "config", "core.fsmonitor", `node \"${tripwire.replaceAll("\\", "/")}\" \"${sentinel.replaceAll("\\", "/")}\"`);
  git(root, "config", "filter.tripwire.clean", `node \"${tripwire.replaceAll("\\", "/")}\" \"${sentinel.replaceAll("\\", "/")}\"`);
  git(root, "config", "diff.tripwire.command", `node \"${tripwire.replaceAll("\\", "/")}\" \"${sentinel.replaceAll("\\", "/")}\"`);
  await writeFile(path.join(root, "dirty.txt"), "staged\n");
  git(root, "-c", "core.fsmonitor=false", "add", "dirty.txt");
  await writeFile(path.join(root, "clean.txt"), "unstaged\n");
  await rm(sentinel, { force: true });
  const safeStatusArgs = ["-c", "core.fsmonitor=false", "-c", "filter.tripwire.clean=", "-c", "filter.tripwire.process=", "-c", "filter.tripwire.required=false", "status", "--porcelain=v1", "-z"];
  const beforeStatus = git(root, ...safeStatusArgs);
  const beforeIndex = await readFile(path.join(root, ".git", "index"));
  const beforeObjects = await inventory(path.join(root, ".git", "objects"));
  const beforeHead = git(root, "rev-parse", "HEAD");
  const beforeBranch = git(root, "branch", "--show-current");
  const beforeStash = git(root, "stash", "list");

  const collection = await beginChangeReceipt(root);
  assert.deepEqual(await collection.finish(), { state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0 });
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });

  assert.deepEqual(git(root, ...safeStatusArgs), beforeStatus);
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), beforeIndex);
  assert.deepEqual(await inventory(path.join(root, ".git", "objects")), beforeObjects);
  assert.deepEqual(git(root, "rev-parse", "HEAD"), beforeHead);
  assert.deepEqual(git(root, "branch", "--show-current"), beforeBranch);
  assert.deepEqual(git(root, "stash", "list"), beforeStash);
});

test("mode-only changes carry no line count", { skip: process.platform === "win32" }, async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = await beginChangeReceipt(root);
  await chmod(path.join(root, "clean.txt"), 0o755);
  assert.deepEqual(await collection.finish(), {
    state: "available",
    totalFiles: 1,
    additions: 0,
    deletions: 0,
    files: [{ kind: "modified", path: "clean.txt", additions: 0, deletions: 0, detail: "mode" }],
    omittedFiles: 0,
  });
});
