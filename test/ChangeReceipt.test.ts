import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
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

test("focused Node test recognition stores one canonical label and rejects ambiguity", () => {
  assert.deepEqual(
    recognizedCheck("node --test test/WorkedFor.test.ts", false),
    { label: "node --test (focused)", outcome: "passed" },
  );
  assert.deepEqual(
    recognizedCheck("node --test --experimental-strip-types test/WorkedFor.test.ts", true),
    { label: "node --test (focused)", outcome: "failed" },
  );
  assert.deepEqual(
    recognizedCheck(" \tnode --test test\\WorkedFor.test.ts\t ", false),
    { label: "node --test (focused)", outcome: "passed" },
  );
  for (const command of [
    "node --test --help",
    "node --test --experimental-strip-types",
    "node --test --test-name-pattern name test/WorkedFor.test.ts",
    "node --test test/WorkedFor.test.ts test/Footer.test.ts",
    "node --test ../test/WorkedFor.test.ts",
    "node --test \"test/Worked For.test.ts\"",
    "node --test test/*.test.ts",
    "node --test test/WorkedFor.test.ts || true",
    "node --test test/WorkedFor.test.ts # focused",
    "API_TOKEN=secret node --test test/WorkedFor.test.ts",
    "node --test test/test-helper.ts",
    "node --test -test/WorkedFor.test.ts",
    "node --test /test/WorkedFor.test.ts",
    "node --test C:\\test\\WorkedFor.test.ts",
    "node --test https://example.test/WorkedFor.test.ts",
    "node --test test/./WorkedFor.test.ts",
    "node --test test/foo.test.TS",
    "node --test test/foo.test.tsx",
    "node --test test/$(printf WorkedFor).test.ts",
    "node --test test/WorkedFor.test.ts>receipt",
    "node --test test/WorkedFor.test.ts\n",
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

test("untracked and tracked symlinks compare destinations without following targets", async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "killeros-link-target-"));
  t.after(async () => {
    disposeChangeReceipts();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const target = path.join(outside, "target.txt");
  await writeFile(target, "one\ntwo\nthree\n");
  try {
    await symlink("missing.txt", path.join(root, "dangling"), "file");
  } catch (error) {
    if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))) {
      t.skip("Filesystem does not permit symlinks");
      return;
    }
    throw error;
  }
  git(root, "config", "core.symlinks", "true");
  await symlink(target, path.join(root, "tracked"), "file");
  git(root, "add", "tracked");
  git(root, "commit", "--quiet", "-m", "tracked link");
  const collection = await beginChangeReceipt(root);
  await symlink(target, path.join(root, "file-link"), "file");
  await symlink(outside, path.join(root, "directory-link"), "dir");
  await rm(path.join(root, "tracked"));
  await symlink("missing.txt", path.join(root, "tracked"), "file");
  await writeFile(path.join(root, "clean.txt"), "clean\nchanged\n");
  assert.deepEqual(await collection.finish(), {
    state: "available", totalFiles: 4, additions: 4, deletions: 1,
    files: [
      { kind: "modified", path: "clean.txt", additions: 1, deletions: 0 },
      { kind: "added", path: "directory-link", additions: 1, deletions: 0 },
      { kind: "added", path: "file-link", additions: 1, deletions: 0 },
      { kind: "modified", path: "tracked", additions: 1, deletions: 1 },
    ], omittedFiles: 0,
  });
});

test("finish detects an immediate write without waiting for watcher delivery", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = await beginChangeReceipt(root);

  writeFileSync(path.join(root, "clean.txt"), "immediate\n");

  assert.deepEqual(await collection.finish(), {
    state: "available",
    totalFiles: 1,
    additions: 1,
    deletions: 1,
    files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }],
    omittedFiles: 0,
  });
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

test("oversized HEAD blobs are unavailable in loose and packed storage", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const largePath = path.join(root, "large.bin");
  await writeFile(largePath, "");
  await truncate(largePath, 128 * 1024 * 1024 + 1);
  git(root, "add", "large.bin");
  git(root, "commit", "--quiet", "-m", "large blob");

  const looseCollection = await beginChangeReceipt(root);
  await rm(largePath);
  assert.deepEqual(await looseCollection.finish(), { state: "unavailable", reason: "too-large" });

  git(root, "checkout", "--", "large.bin");
  git(root, "repack", "-ad");
  const packedCollection = await beginChangeReceipt(root);
  await rm(largePath);
  assert.deepEqual(await packedCollection.finish(), { state: "unavailable", reason: "too-large" });
});

test("total HEAD blob content is bounded across objects", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a-small.bin"), "x");
  const largePath = path.join(root, "b-large.bin");
  await writeFile(largePath, "");
  await truncate(largePath, 128 * 1024 * 1024);
  git(root, "add", "a-small.bin", "b-large.bin");
  git(root, "commit", "--quiet", "-m", "aggregate blob limit");

  const looseCollection = await beginChangeReceipt(root);
  await Promise.all([rm(path.join(root, "a-small.bin")), rm(largePath)]);
  assert.deepEqual(await looseCollection.finish(), { state: "unavailable", reason: "too-large" });

  git(root, "checkout", "--", "a-small.bin", "b-large.bin");
  git(root, "repack", "-ad");
  const packedCollection = await beginChangeReceipt(root);
  await Promise.all([rm(path.join(root, "a-small.bin")), rm(largePath)]);
  assert.deepEqual(await packedCollection.finish(), { state: "unavailable", reason: "too-large" });
});

test("truncated loose blobs fail as unavailable errors", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = git(root, "rev-parse", "HEAD:clean.txt").toString("ascii").trim();
  const objectPath = path.join(root, ".git", "objects", id.slice(0, 2), id.slice(2));
  const object = await readFile(objectPath);
  await chmod(objectPath, 0o644);
  await writeFile(objectPath, object.subarray(0, -1));

  const collection = await beginChangeReceipt(root);
  await rm(path.join(root, "clean.txt"));
  assert.deepEqual(await collection.finish(), { state: "unavailable", reason: "error" });
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

test("settlement disables filters configured after collection starts", async (t) => {
  const root = await fixture();
  const sentinelDirectory = await mkdtemp(path.join(os.tmpdir(), "killeros-filter-test-"));
  const sentinel = path.join(sentinelDirectory, "sentinel");
  const tripwire = path.join(root, "tripwire.cjs");
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(sentinelDirectory, { recursive: true, force: true }),
  ]));
  await writeFile(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'invoked');process.stdin.pipe(process.stdout);\n");
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=late\n");
  const collection = await beginChangeReceipt(root);

  git(root, "config", "filter.late.clean", `node \"${tripwire.replaceAll("\\", "/")}\" \"${sentinel.replaceAll("\\", "/")}\"`);
  await writeFile(path.join(root, "clean.txt"), "changed\n");
  await collection.finish();

  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("settlement disables a filter from an included config that appears after collection starts", async (t) => {
  const root = await fixture();
  const sentinelDirectory = await mkdtemp(path.join(os.tmpdir(), "killeros-filter-test-"));
  const sentinel = path.join(sentinelDirectory, "sentinel");
  const tripwire = path.join(sentinelDirectory, "tripwire.cjs");
  const includedConfig = path.join(root, ".git", "late-filter.config");
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(sentinelDirectory, { recursive: true, force: true }),
  ]));
  await writeFile(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'invoked');process.stdin.pipe(process.stdout);\n");
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=late\n");
  git(root, "add", ".gitattributes");
  git(root, "commit", "--quiet", "-m", "attributes");
  git(root, "config", "include.path", "late-filter.config");
  const collection = await beginChangeReceipt(root);

  await writeFile(includedConfig, `[filter "late"]\n\tclean = node "${tripwire.replaceAll("\\", "/")}" "${sentinel.replaceAll("\\", "/")}"\n`);
  await writeFile(path.join(root, "clean.txt"), "changed\n");
  const summary = await collection.finish();

  assert.equal(summary.state, "available");
  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("settlement disables a filter supplied by newly effective Git environment configuration", async (t) => {
  const root = await fixture();
  const sentinelDirectory = await mkdtemp(path.join(os.tmpdir(), "killeros-filter-test-"));
  const sentinel = path.join(sentinelDirectory, "sentinel");
  const tripwire = path.join(sentinelDirectory, "tripwire.cjs");
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(sentinelDirectory, { recursive: true, force: true }),
  ]));
  await writeFile(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'invoked');process.stdin.pipe(process.stdout);\n");
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=environment-late\n");
  git(root, "add", ".gitattributes");
  git(root, "commit", "--quiet", "-m", "attributes");
  const previousConfigEnvironment = new Map(
    Object.keys(process.env)
      .filter((key) => key.startsWith("GIT_CONFIG_"))
      .map((key) => [key, process.env[key]] as const),
  );
  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_CONFIG_")) delete process.env[key];
    }
    const collection = await beginChangeReceipt(root);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "filter.environment-late.clean";
    process.env.GIT_CONFIG_VALUE_0 = `node "${tripwire.replaceAll("\\", "/")}" "${sentinel.replaceAll("\\", "/")}"`;
    await writeFile(path.join(root, "clean.txt"), "changed\n");
    const summary = await collection.finish();

    assert.equal(summary.state, "available");
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("GIT_CONFIG_")) delete process.env[key];
    }
    for (const [key, value] of previousConfigEnvironment) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});

test("settlement disables filters activated by a branch-conditional include", async (t) => {
  const root = await fixture();
  const sentinelDirectory = await mkdtemp(path.join(os.tmpdir(), "killeros-branch-filter-test-"));
  const sentinel = path.join(sentinelDirectory, "sentinel");
  const tripwire = path.join(root, "tripwire.cjs");
  const includedConfig = path.join(root, "late-filter.config");
  t.after(async () => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(sentinelDirectory, { recursive: true, force: true }),
  ]));
  await writeFile(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'invoked');process.stdin.pipe(process.stdout);\n");
  await writeFile(includedConfig, `[filter \"late\"]\n\tclean = node \"${tripwire.replaceAll("\\", "/")}\" \"${sentinel.replaceAll("\\", "/")}\"\n`);
  git(root, "config", "includeIf.onbranch:trigger.path", includedConfig.replaceAll("\\", "/"));
  const collection = await beginChangeReceipt(root);

  git(root, "checkout", "--quiet", "-b", "trigger");
  await writeFile(path.join(root, ".gitattributes"), "*.txt filter=late\n");
  await writeFile(path.join(root, "clean.txt"), "changed\n");
  await rm(sentinel, { force: true });
  await collection.finish();

  await assert.rejects(readFile(sentinel), { code: "ENOENT" });
});

test("receipts neither fetch promised blobs nor report verified changes", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "killeros-partial-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "source");
  const root = path.join(parent, "clone");
  git(parent, "init", "--quiet", "source");
  git(source, "config", "user.email", "killeros@example.invalid");
  git(source, "config", "user.name", "KillerOS test");
  await writeFile(path.join(source, "file.txt"), "present\n");
  await writeFile(path.join(source, "big.bin"), `${"x".repeat(10_000)}\n`);
  git(source, "add", ".");
  git(source, "commit", "--quiet", "-m", "fixture");
  const promised = git(source, "rev-parse", "HEAD:big.bin").toString().trim();

  execFileSync("git", ["clone", "--quiet", source, root], { stdio: ["ignore", "pipe", "pipe"] });
  git(root, "config", "user.email", "killeros@example.invalid");
  git(root, "config", "user.name", "KillerOS test");
  for (const entry of await readdir(path.join(root, ".git", "objects", "pack"))) {
    if (!entry.endsWith(".pack")) continue;
    const pack = await readFile(path.join(root, ".git", "objects", "pack", entry));
    execFileSync("git", ["unpack-objects"], { cwd: root, input: pack, stdio: ["pipe", "pipe", "pipe"] });
  }
  for (const entry of await readdir(path.join(root, ".git", "objects", "pack"))) {
    await rm(path.join(root, ".git", "objects", "pack", entry));
  }
  await rm(path.join(root, ".git", "objects", promised.slice(0, 2), promised.slice(2)));
  git(root, "remote", "add", "promisor", source);
  git(root, "config", "extensions.partialClone", "promisor");
  git(root, "config", "remote.promisor.promisor", "true");
  assert.throws(() => execFileSync(
    "git",
    ["cat-file", "-e", promised],
    { cwd: root, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  ));
  const beforeObjects = await inventory(path.join(root, ".git", "objects"));

  const collection = await beginChangeReceipt(root);
  const staged = git(root, "hash-object", "-w", "file.txt").toString().trim();
  git(root, "update-index", "--cacheinfo", `100644,${staged},big.bin`);
  assert.deepEqual(await collection.finish(), { state: "unavailable", reason: "error" });

  assert.deepEqual(await inventory(path.join(root, ".git", "objects")), beforeObjects);
  assert.throws(() => execFileSync(
    "git",
    ["cat-file", "-e", promised],
    { cwd: root, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  ));
});

test("line-ending-only edits remain visible with normalized line counts", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const collection = await beginChangeReceipt(root);

  await writeFile(path.join(root, "clean.txt"), "clean\r\n");

  assert.deepEqual(await collection.finish(), {
    state: "available",
    totalFiles: 1,
    additions: 0,
    deletions: 0,
    files: [{ kind: "modified", path: "clean.txt", additions: 0, deletions: 0 }],
    omittedFiles: 0,
  });
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

async function writeReceiptShims(repository: string, sentinel: string): Promise<void> {
  const portable = sentinel.replaceAll("\\", "/").replaceAll('"', '\\"');
  const shell = `#!/bin/sh\nprintf executed > "${portable}"\n`;
  for (const name of ["where", "which", "git"]) {
    const shim = path.join(repository, name);
    await writeFile(shim, shell);
    try {
      await chmod(shim, 0o755);
    } catch {
      // Windows repositories do not need the executable bit.
    }
  }
  const batch = `@echo off\r\necho executed> "${portable}"\r\n`;
  for (const name of ["where.cmd", "where.bat", "which.cmd", "which.bat", "git.cmd", "git.bat"]) {
    await writeFile(path.join(repository, name), batch);
  }
}

async function sentinelAbsent(filePath: string): Promise<void> {
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
}

test("change receipt never runs repository-local locator or Git shims", async (t) => {
  const root = await fixture();
  const probe = await mkdtemp(path.join(os.tmpdir(), "killeros-receipt-probe-"));
  const sentinel = path.join(probe, "sentinel");
  t.after(() => rm(probe, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReceiptShims(root, sentinel);
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = ["", ".", root, ...(previousPath ?? "").split(path.delimiter)].join(path.delimiter);
    process.chdir(root);
    const collection = await beginChangeReceipt(root);
    await writeFile(path.join(root, "clean.txt"), "changed\n");
    const summary = await collection.finish();
    assert.equal(summary.state, "available");
    await sentinelAbsent(sentinel);
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("change receipt fails closed without a safe Git executable", async (t) => {
  const root = await fixture();
  const probe = await mkdtemp(path.join(os.tmpdir(), "killeros-receipt-closed-probe-"));
  const sentinel = path.join(probe, "sentinel");
  t.after(() => rm(probe, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeReceiptShims(root, sentinel);
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = ["", ".", root].join(path.delimiter);
    process.chdir(root);
    const summary = await (await beginChangeReceipt(root)).finish();
    assert.equal(summary.state, "unavailable");
    assert.notEqual(summary.state, "available");
    await sentinelAbsent(sentinel);
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
