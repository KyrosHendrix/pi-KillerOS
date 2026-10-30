import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createPipeServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { throwScenarioFailure } from "./support/ScenarioFailure.ts";

import { repositoryRoot, piVersion, ReceiptGitProvider, createFamily, git, initRepository, writeProviderConfig, isRecord, sessionReceipts, fileSummary, runTurns, type Family, type RecordValue } from "./support/ReceiptGitScenario.ts";

test("real Pi receipts report only the response delta with bounded Git metadata", { timeout: 420_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const diagnostics: RecordValue[] = [];
  const directories: string[] = [];

  // Family A: one trusted session — basic delta, staged-only changes, canonical checks, HEAD change, recovery.
  {
    const family = createFamily(repositoryRoot, "delta");
    directories.push(family.directory);
    initRepository(family.project);
    writeFileSync(path.join(family.project, "rename-me.txt"), "rename\nkept\nstable\n");
    git(family.project, "add", "rename-me.txt");
    git(family.project, "commit", "-q", "-m", "rename source");
    const firstHead = git(family.project, "rev-parse", "HEAD").toString("ascii").trim();
    writeFileSync(path.join(family.project, "clean.txt"), "next\n");
    git(family.project, "add", "clean.txt");
    git(family.project, "commit", "-q", "-m", "future head");
    const nextHead = git(family.project, "rev-parse", "HEAD").toString("ascii").trim();
    git(family.project, "reset", "--hard", "-q", firstHead);
    writeFileSync(path.join(family.project, "dirty.txt"), "already dirty\n");
    writeFileSync(path.join(family.project, "preexisting.txt"), "preexisting\n");
    const receiptTemporaries = () => readdirSync(family.directory).filter(name => name.startsWith("killeros-change-receipt-")).sort();
    const temporariesBefore = receiptTemporaries();
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [
          {
            label: "delta turn", step: { kind: "text", content: "Delta response." },
            doneWhen: (screen) => screen.includes("Delta response."),
            mutate: () => {
              writeFileSync(path.join(family.project, "clean.txt"), "clean\nchanged\n");
              writeFileSync(path.join(family.project, "new.txt"), "one\ntwo\n");
              writeFileSync(path.join(family.project, "binary.bin"), Buffer.from([0, 9, 2, 9]));
              writeFileSync(path.join(family.project, "rename-me.txt"), "rename\nkept\nstable\nchanged\n");
              git(family.project, "mv", "rename-me.txt", "renamed.txt");
            },
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, { state: "available", totalFiles: 4, additions: 4, deletions: 0,
                files: [
                  { kind: "modified", path: "binary.bin", additions: 0, deletions: 0, detail: "binary" },
                  { kind: "modified", path: "clean.txt", additions: 1, deletions: 0 },
                  { kind: "added", path: "new.txt", additions: 2, deletions: 0 },
                  { kind: "renamed", path: "renamed.txt", previousPath: "rename-me.txt", additions: 1, deletions: 0 },
                ], omittedFiles: 0 });
              assert.deepEqual(receiptTemporaries(), temporariesBefore);
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "delta turn state");
              assert.equal(summary.totalFiles, 4, "Only the response delta is reported");
              assert.deepEqual(summary.additions, 4, "delta additions");
              assert.deepEqual(summary.deletions, 0, "delta deletions");
              const paths = summary.files.map((file) => `${String(file.kind)}:${String(file.path)}`);
              assert.deepEqual(paths, ["modified:binary.bin", "modified:clean.txt", "added:new.txt", "renamed:renamed.txt"], "delta file set");
              const renamed = summary.files.find((file) => file.kind === "renamed");
              assert.equal(renamed?.previousPath, "rename-me.txt", "rename keeps the previous path");
              assert.equal(renamed?.additions, 1, "rename counts only changed lines");
              const binary = summary.files.find((file) => file.path === "binary.bin");
              assert.equal(binary?.detail, "binary", "binary modifications carry no line counts");
              const status = git(family.project, "status", "--porcelain=v1", "-z").toString("utf8");
              assert.match(status, /dirty\.txt/u, "Preexisting dirt is untouched");
              assert.match(status, /preexisting\.txt/u, "Unrelated files stay out of the receipt");
            },
          },
          {
            label: "staged turn", step: { kind: "text", content: "Staged response." },
            doneWhen: (screen) => screen.includes("Staged response."),
            mutate: () => {
              // The settlement snapshot from the previous response is the new baseline; stage an index-only change
              // against the tracked clean.txt, whose index still holds the committed content.
              writeFileSync(path.join(family.project, "staged.patch"), [
                "diff --git a/clean.txt b/clean.txt",
                "index 8312631..0000000 100644",
                "--- a/clean.txt",
                "+++ b/clean.txt",
                "@@ -1 +1,2 @@",
                " clean",
                "+staged",
                "",
              ].join("\n"));
              git(family.project, "apply", "--cached", "staged.patch");
              rmSync(path.join(family.project, "staged.patch"));
            },
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, {
                state: "available", totalFiles: 1, additions: 1, deletions: 0,
                files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 0 }], omittedFiles: 0,
              }, "Index-only staged changes join the response delta");
              // Change HEAD after settlement and before the next request captures its baseline.
              git(family.project, "reset", "-q", "HEAD", "--", "clean.txt");
              git(family.project, "commit", "-q", "--allow-empty", "-m", "between responses");
            },
          },
          {
            label: "checks turn", step: { kind: "tools", commands: [
              "npm test",
              "npm run check",
              "npm test -- --runInBand",
              "API_TOKEN=secret npm test",
              "npm test || true",
              "node --test test/WorkedFor.sample.test.ts",
            ] },
            doneWhen: (screen) => screen.includes("$ node --test test/WorkedFor.sample.test.ts"),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "clean\nchanged\nagain\n"),
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, {
                state: "available", totalFiles: 1, additions: 1, deletions: 0,
                files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 0 }], omittedFiles: 0,
              }, "A new response refreshes its baseline after a between-response HEAD change");
              const checks = receipt.checks as RecordValue[];
              const byLabel = (left: RecordValue, right: RecordValue): number => String(left.label).localeCompare(String(right.label));
              // Checks record in event order; only the membership and outcomes are the oracle.
              assert.deepEqual([...checks].sort(byLabel), ([
                { label: "npm test", outcome: "failed" },
                { label: "npm run check", outcome: "failed" },
                { label: "node --test (focused)", outcome: "failed" },
              ] as RecordValue[]).sort(byLabel),
                "Only exact canonical commands are recorded; ambiguity, env prefixes, and compounds are ignored");
              assert.doesNotMatch(JSON.stringify(receipt), /WorkedFor\.sample\.test\.ts/u,
                "Focused check labels never persist the invoked path");
            },
          },
          {
            label: "head change turn", step: { kind: "text", content: "Head change response." },
            doneWhen: (screen) => screen.includes("Head change response."),
            mutate: () => {
              // Prepare commits before collection so this HEAD move emits no worktree event.
              git(family.project, "update-ref", "HEAD", nextHead);
            },
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, { state: "unavailable", reason: "error" },
                "A HEAD update without worktree events fails the receipt closed");
            },
          },
          {
            label: "recovery turn", step: { kind: "text", content: "Recovery response." },
            doneWhen: (screen) => screen.includes("Recovery response."),
            mutate: () => writeFileSync(path.join(family.project, "recovered.txt"), "recovered\n"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "recovery turn state");
              assert.deepEqual(summary.files, [{ kind: "added", path: "recovered.txt", additions: 1, deletions: 0 }],
                "The next response recovers with a fresh baseline at the new HEAD");
            },
          },
        ],
      });
      assert.equal(provider.requests.length, 6, "Each turn uses exactly its planned provider requests");
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "delta", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family B: inherited GIT_DIR/GIT_WORK_TREE selectors are ignored; the receipt owns the working directory's repo.
  {
    const requested = createFamily(repositoryRoot, "inherited-requested");
    const inherited = createFamily(repositoryRoot, "inherited-other");
    directories.push(requested.directory, inherited.directory);
    initRepository(requested.project);
    initRepository(inherited.project);
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(requested.agent, port);
      const familyWithSelectors: Family = { ...requested,
        env: { ...requested.env, GIT_DIR: path.join(inherited.project, ".git"), GIT_WORK_TREE: inherited.project } };
      await runTurns({
        family: familyWithSelectors, provider, signal: t.signal,
        turns: [{
          label: "inherited-only turn", step: { kind: "text", content: "Inherited-only response." },
          doneWhen: (screen) => screen.includes("Inherited-only response."),
          mutate: () => writeFileSync(path.join(inherited.project, "clean.txt"), "changed in the other repository\n"),
          verify: (receipt) => assert.deepEqual(receipt.changes, {
            state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0,
          }, "Changes in the inherited repository do not affect the requested repository"),
        }, {
          label: "inherited turn", step: { kind: "text", content: "Inherited response." },
          doneWhen: (screen) => screen.includes("Inherited response."),
          mutate: () => {
            writeFileSync(path.join(inherited.project, "clean.txt"), "changed in the other repository\n");
            writeFileSync(path.join(requested.project, "owned.txt"), "owned\n");
          },
          verify: (receipt) => {
            assert.deepEqual(receipt.changes, {
              state: "available", totalFiles: 1, additions: 1, deletions: 0,
              files: [{ kind: "added", path: "owned.txt", additions: 1, deletions: 0 }], omittedFiles: 0,
            }, "Inherited repository selectors are ignored; the working directory's repository owns the receipt");
          },
        }],
      });
      assert.equal(provider.requests.length, 2, "Both inherited-selector turns use exactly one request");
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "inherited", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family C: unborn repositories still produce receipts.
  {
    const family = createFamily(repositoryRoot, "unborn");
    directories.push(family.directory);
    git(family.project, "init", "-q");
    git(family.project, "config", "core.autocrlf", "false");
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [{
          label: "unborn turn", step: { kind: "text", content: "Unborn response." },
          doneWhen: (screen) => screen.includes("Unborn response."),
          mutate: () => writeFileSync(path.join(family.project, "new.txt"), "new\n"),
          verify: (receipt) => {
            assert.deepEqual(receipt.changes, {
              state: "available", totalFiles: 1, additions: 1, deletions: 0,
              files: [{ kind: "added", path: "new.txt", additions: 1, deletions: 0 }], omittedFiles: 0,
            }, "Unborn repositories produce receipts");
          },
        }],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "unborn", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family D: same-size rewrites with restored mtimes remain visible.
  {
    const family = createFamily(repositoryRoot, "mtime");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptGitProvider();
    try {
      const file = path.join(family.project, "clean.txt");
      const fixedTime = new Date(Date.now() - 60_000);
      fixedTime.setMilliseconds(0);
      writeFileSync(file, "AAAA\n");
      utimesSync(file, fixedTime, fixedTime);
      git(family.project, "add", "clean.txt");
      git(family.project, "commit", "-q", "-m", "controlled timestamp");
      const indexedStats = statSync(file, { bigint: true });
      writeFileSync(file, "AAAA\n");
      utimesSync(file, fixedTime, fixedTime);
      const restoredStats = statSync(file, { bigint: true });
      assert.equal(restoredStats.mtimeNs, indexedStats.mtimeNs, "the mtime fixture preserves index time exactly");
      assert.notEqual(restoredStats.ctimeNs, indexedStats.ctimeNs, "the mtime fixture executes the distinct ctime input");
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [{
          label: "mtime turn", step: { kind: "text", content: "Mtime response." },
          doneWhen: (screen) => screen.includes("Mtime response."),
          mutate: () => {
            writeFileSync(file, "BBBB\n");
            utimesSync(file, fixedTime, fixedTime);
          },
          verify: (receipt) => {
            const summary = fileSummary(receipt.changes);
            assert.equal(summary.state, "available", "mtime turn state");
            assert.deepEqual(summary.files, [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }],
              "Same-size rewrites with restored modification times remain visible");
          },
        }],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "mtime", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family E: repository discovery follows the working directory, not a parent repository.
  {
    const outer = createFamily(repositoryRoot, "nested");
    directories.push(outer.directory);
    const child = path.join(outer.project, "child");
    mkdirSync(child);
    initRepository(outer.project);
    writeFileSync(path.join(child, "outer.txt"), "outer\n");
    git(outer.project, "add", "child/outer.txt");
    git(outer.project, "commit", "-q", "-m", "outer child");
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(outer.agent, port);
      const childFamily: Family = { ...outer, project: child };
      await runTurns({
        family: childFamily, provider, signal: t.signal,
        turns: [{
          label: "outer ownership turn", step: { kind: "text", content: "Outer ownership response." },
          doneWhen: screen => screen.includes("Outer ownership response."),
          mutate: () => {},
          verify: receipt => {
            assert.deepEqual(receipt.changes, { state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0 });
            git(child, "init", "-q");
            git(child, "config", "core.autocrlf", "false");
            writeFileSync(path.join(child, "inner.txt"), "before\n");
            git(child, "add", "inner.txt");
            git(child, "commit", "-q", "-m", "nested fixture");
          },
        }, {
          label: "nested turn", step: { kind: "text", content: "Nested response." },
          doneWhen: (screen) => screen.includes("Nested response."),
          mutate: () => writeFileSync(path.join(child, "inner.txt"), "after\n"),
          verify: (receipt) => {
            const summary = fileSummary(receipt.changes);
            assert.equal(summary.state, "available", "nested turn state");
            assert.deepEqual(summary.files, [{ kind: "modified", path: "inner.txt", additions: 1, deletions: 1 }],
              "The repository owning the working directory is discovered, not a parent");
          },
        }],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "nested", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family F: the same native process replaces repository metadata between responses.
  {
    const family = createFamily(repositoryRoot, "metadata-replacement");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptGitProvider();
    try {
      writeProviderConfig(family.agent, await provider.listen());
      await runTurns({ family, provider, signal: t.signal, turns: [{
        label: "original metadata turn", step: { kind: "text", content: "Original metadata response." },
        doneWhen: screen => screen.includes("Original metadata response."), mutate: () => {},
        verify: receipt => {
          assert.equal(fileSummary(receipt.changes).state, "available");
          renameSync(path.join(family.project, ".git"), path.join(family.directory, "original.git"));
          git(family.directory, "init", "-q", "--separate-git-dir", path.join(family.directory, "replacement.git"), family.project);
          git(family.project, "config", "core.autocrlf", "false");
          git(family.project, "add", "clean.txt");
          git(family.project, "commit", "-q", "-m", "replacement fixture");
        },
      }, {
        label: "replacement metadata turn", step: { kind: "text", content: "Replacement metadata response." },
        doneWhen: screen => screen.includes("Replacement metadata response."),
        mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "replacement\n"),
        verify: receipt => assert.deepEqual(receipt.changes, { state: "available", totalFiles: 1,
          additions: 1, deletions: 1, files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }], omittedFiles: 0 }),
      }] });
    } catch (error) { failures.push(error); diagnostics.push({ family: "metadata-replacement", providerRequests: provider.requests.length }); }
    finally { try { await provider.close(); } catch (error) { failures.push(error); } }
  }

  if (failures.length > 0) {
    throwScenarioFailure({ directory: directories[0] ?? repositoryRoot, message: "Receipt-git delta scenario failed",
      errors: failures, diagnostics: JSON.stringify({ platform: process.platform, node: process.version, pi: piVersion, diagnostics }) });
  }
  for (const directory of directories) await removeDirectoryEventually(directory);
});

test("real Pi receipt mirrors Git content, symlink, CRLF, and settings semantics", { timeout: 420_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const diagnostics: RecordValue[] = [];
  const directories: string[] = [];

  // Family A: tracked and untracked symlinks compare destinations without following targets (capability-gated).
  let symlinksPermitted = true;
  const linkProbe = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-link-probe-"));
  try {
    symlinkSync("missing.txt", path.join(linkProbe, "dangling"));
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && ["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))) {
      symlinksPermitted = false;
      diagnostics.push({ family: "content-links", skipped: "Filesystem does not permit symlinks" });
    } else throw error;
  } finally {
    await removeDirectoryEventually(linkProbe);
  }
  if (symlinksPermitted) {
    const family = createFamily(repositoryRoot, "content-links");
    directories.push(family.directory);
    initRepository(family.project);
    const outside = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-link-target-"));
    directories.push(outside);
    const target = path.join(outside, "target.txt");
    writeFileSync(target, "one\ntwo\nthree\n");
    const provider = new ReceiptGitProvider();
    try {
      git(family.project, "config", "core.symlinks", "true");
      symlinkSync("missing.txt", path.join(family.project, "dangling"));
      symlinkSync(target, path.join(family.project, "tracked"));
      git(family.project, "add", "tracked");
      git(family.project, "commit", "-q", "-m", "tracked link");
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [{
          label: "link turn", step: { kind: "text", content: "Link response." },
          doneWhen: (screen) => screen.includes("Link response."),
          mutate: () => {
            symlinkSync(target, path.join(family.project, "file-link"));
            symlinkSync(outside, path.join(family.project, "directory-link"));
            rmSync(path.join(family.project, "tracked"));
            symlinkSync("missing.txt", path.join(family.project, "tracked"));
            writeFileSync(path.join(family.project, "clean.txt"), "clean\nchanged\n");
          },
          verify: (receipt) => {
            assert.deepEqual(receipt.changes, {
              state: "available", totalFiles: 4, additions: 4, deletions: 1,
              files: [
                { kind: "modified", path: "clean.txt", additions: 1, deletions: 0 },
                { kind: "added", path: "directory-link", additions: 1, deletions: 0 },
                { kind: "added", path: "file-link", additions: 1, deletions: 0 },
                { kind: "modified", path: "tracked", additions: 1, deletions: 1 },
              ], omittedFiles: 0,
            }, "Symlinks compare destinations without following targets; unchanged dangling links stay out of the delta");
            t.diagnostic(JSON.stringify({ source: "test/ChangeReceipt.test.ts:248#1", symlinksExecuted: true,
              providerRequests: provider.requests.length, changes: receipt.changes }));
          },
        }],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "content-links", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family B: core.symlinks=false placeholders stay clean, dirty placeholders report, and cached settings refresh.
  {
    const family = createFamily(repositoryRoot, "content-placeholder");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptGitProvider();
    try {
      git(family.project, "config", "core.symlinks", "false");
      writeFileSync(path.join(family.project, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      const link = path.join(family.project, "link");
      writeFileSync(link, "clean.txt");
      const id = git(family.project, "hash-object", "-w", "link").toString("utf8").trim();
      git(family.project, "update-index", "--add", "--cacheinfo", `120000,${id},link`);
      git(family.project, "add", "binary.bin");
      git(family.project, "commit", "-q", "-m", "symlink placeholder");
      assert.equal(git(family.project, "status", "--porcelain").toString("utf8"), "", "The committed placeholder starts clean");
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [
          {
            label: "clean placeholder turn", step: { kind: "text", content: "Clean placeholder response." },
            doneWhen: (screen) => screen.includes("Clean placeholder response."),
            mutate: () => {},
            verify: (receipt) => assert.deepEqual(receipt.changes, {
              state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0,
            }, "A clean core.symlinks=false placeholder contributes no response delta"),
          },
          {
            label: "placeholder turn", step: { kind: "text", content: "Placeholder response." },
            doneWhen: (screen) => screen.includes("Placeholder response."),
            mutate: () => {
              writeFileSync(link, "dirty.txt");
              renameSync(path.join(family.project, "binary.bin"), path.join(family.project, "renamed.bin"));
              writeFileSync(path.join(family.project, "renamed.bin"), Buffer.from([0, 1, 9, 3]));
            },
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, {
                state: "available", totalFiles: 2, additions: 1, deletions: 1,
                files: [
                  { kind: "modified", path: "link", additions: 1, deletions: 1 },
                  { kind: "renamed", path: "renamed.bin", previousPath: "binary.bin", additions: 0, deletions: 0, detail: "binary" },
                ], omittedFiles: 0,
              }, "Placeholder changes and a modified binary rename report together");
            },
          },
          {
            label: "restored turn", step: { kind: "text", content: "Restored response." },
            doneWhen: (screen) => screen.includes("Restored response."),
            mutate: () => {
              // Both the temporary change and the restore land inside this one collection window,
              // returning the file to the previous settlement's exact content.
              writeFileSync(link, "temporary\n");
              writeFileSync(link, "dirty.txt");
              writeFileSync(path.join(family.project, "clean.txt"), "clean\r\n");
            },
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, {
                state: "available", totalFiles: 1, additions: 0, deletions: 0,
                files: [{ kind: "modified", path: "clean.txt", additions: 0, deletions: 0 }], omittedFiles: 0,
              }, "Restored changes disappear and line-ending-only edits remain visible with zero line counts");
            },
          },
          {
            label: "symlink semantics turn", step: { kind: "text", content: "Semantics response." },
            doneWhen: (screen) => screen.includes("Semantics response."),
            mutate: () => git(family.project, "config", "core.symlinks", "true"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "symlink semantics turn stays available");
            },
          },
          {
            label: "settings refresh turn", step: { kind: "text", content: "Settings response." },
            doneWhen: (screen) => screen.includes("Settings response."),
            mutate: () => git(family.project, "config", "core.symlinks", "false"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "settings refresh state");
              assert.deepEqual(summary.files, [{ kind: "modified", path: "link", additions: 0, deletions: 0, detail: "mode" }],
                "Cached Git settings refresh between responses: the semantics change surfaces as a mode-only delta with zero line counts");
            },
          },
          {
            label: "refreshed settings baseline turn", step: { kind: "text", content: "Stable settings response." },
            doneWhen: (screen) => screen.includes("Stable settings response."),
            mutate: () => {},
            verify: (receipt) => assert.deepEqual(receipt.changes, {
              state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0,
            }, "The next response starts with the refreshed core.symlinks=false baseline"),
          },
        ],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "content-placeholder", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family C: CRLF normalization, forced attributes, skip-worktree, and attribute/binary distinctions.
  {
    const family = createFamily(repositoryRoot, "content-crlf");
    directories.push(family.directory);
    const project = family.project;
    git(project, "init", "-q");
    git(project, "config", "core.autocrlf", "true");
    writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "receipt-git-fixture", private: true,
      scripts: { test: "node -e \"process.exit(1)\"" } }));
    writeFileSync(path.join(project, "clean.txt"), "clean\r\n");
    writeFileSync(path.join(project, ".gitattributes"), [
      "forced-auto.txt text=auto eol=lf", "forced-eol.txt eol=lf", "forced-text.txt text eol=lf",
      "normalized.txt text eol=crlf", "automatic.txt text=auto", "automatic-lf.txt text=auto eol=lf",
      "binary.txt -text", "controls.txt text=auto", "forced.txt text",
    ].join("\n") + "\n");
    writeFileSync(path.join(project, "forced-auto.txt"), "line\r\n");
    writeFileSync(path.join(project, "forced-eol.txt"), "line\r\n");
    writeFileSync(path.join(project, "forced-text.txt"), "line\r\n");
    writeFileSync(path.join(project, "normalized.txt"), "text\n");
    writeFileSync(path.join(project, "automatic.txt"), "text\n");
    writeFileSync(path.join(project, "automatic-lf.txt"), "text\n");
    writeFileSync(path.join(project, "binary.txt"), Buffer.from([0, ...Buffer.from("text\n")]));
    writeFileSync(path.join(project, "controls.txt"), "\x01text\n");
    writeFileSync(path.join(project, "forced.txt"), Buffer.from([0, ...Buffer.from("text\n")]));
    writeFileSync(path.join(project, "raw.txt"), "text\n");
    writeFileSync(path.join(project, "default-normalized.txt"), "clean\r\n");
    git(project, "add", ".");
    git(project, "commit", "-q", "-m", "line ending fixtures");
    // The skip-worktree bit must precede the first baseline so the hidden deletion never enters a receipt.
    git(project, "update-index", "--skip-worktree", "clean.txt");
    rmSync(path.join(project, "clean.txt"));
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [
          {
            label: "default normalization turn", step: { kind: "text", content: "Default normalization response." },
            doneWhen: (screen) => screen.includes("Default normalization response."),
            mutate: () => {
              writeFileSync(path.join(project, "default-normalized.txt"), "clean\r\n");
              utimesSync(path.join(project, "default-normalized.txt"), new Date(0), new Date(0));
            },
            verify: (receipt) => assert.deepEqual(fileSummary(receipt.changes).files, [],
              "Default core.autocrlf=true normalization stays clean without the index stat cache"),
          },
          {
            label: "default content edit turn", step: { kind: "text", content: "Default content edit response." },
            doneWhen: (screen) => screen.includes("Default content edit response."),
            mutate: () => writeFileSync(path.join(project, "default-normalized.txt"), "changed\r\n"),
            verify: (receipt) => assert.deepEqual(fileSummary(receipt.changes).files, [
              { kind: "modified", path: "default-normalized.txt", additions: 1, deletions: 1 },
            ], "Default CRLF normalization preserves real edits with exact line counts"),
          },
          {
            label: "normalized rewrite turn", step: { kind: "text", content: "Normalized rewrite response." },
            doneWhen: (screen) => screen.includes("Normalized rewrite response."),
            mutate: () => {
              git(project, "config", "core.autocrlf", "false");
              // Rewriting every forced-LF file with identical CRLF content stays clean after normalization,
              // even with the index stat cache invalidated.
              for (const name of ["forced-auto.txt", "forced-eol.txt", "forced-text.txt"]) {
                writeFileSync(path.join(project, name), "line\r\n");
                utimesSync(path.join(project, name), new Date(0), new Date(0));
              }
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "normalized rewrite state");
              assert.deepEqual(summary.files, [],
                "CRLF rewrites under every forced-LF attribute combination stay clean without the stat cache");
            },
          },
          {
            label: "real edit turn", step: { kind: "text", content: "Real edit response." },
            doneWhen: (screen) => screen.includes("Real edit response."),
            mutate: () => {
              writeFileSync(path.join(project, "forced-auto.txt"), "changed\r\n");
              writeFileSync(path.join(project, "forced-eol.txt"), "changed\r\n");
              writeFileSync(path.join(project, "forced-text.txt"), "changed\r\n");
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "real edit state");
              assert.deepEqual(summary.files, [
                { kind: "modified", path: "forced-auto.txt", additions: 1, deletions: 1 },
                { kind: "modified", path: "forced-eol.txt", additions: 1, deletions: 1 },
                { kind: "modified", path: "forced-text.txt", additions: 1, deletions: 1 },
              ], "Real content edits remain visible with normalized line counts on both paths");
            },
          },
          {
            label: "attribute sweep turn", step: { kind: "text", content: "Attribute sweep response." },
            doneWhen: (screen) => screen.includes("Attribute sweep response."),
            mutate: () => {
              for (const name of ["normalized.txt", "automatic.txt", "automatic-lf.txt", "binary.txt", "controls.txt", "forced.txt", "raw.txt"]) {
                writeFileSync(path.join(project, name), readFileSync(path.join(project, name)).toString("latin1").replaceAll("\n", "\r\n"));
              }
              // clean.txt carries the setup skip-worktree bit and is already deleted; it must never report.
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "attribute sweep state");
              const paths = summary.files.map((file) => `${String(file.kind)}:${String(file.path)}`);
              assert.ok(!paths.some((entry) => entry.endsWith(":clean.txt")),
                "Skip-worktree entries are respected: the deleted clean.txt never reports");
              assert.deepEqual(paths.sort(), ["modified:binary.txt", "modified:controls.txt", "modified:raw.txt"],
                "Only non-normalizable content changes report; every normalizing attribute combination stays clean");
            },
          },
        ],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "content-crlf", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family D: incomplete index metadata fails closed.
  {
    const family = createFamily(repositoryRoot, "content-index");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [{
          label: "index corruption turn", step: { kind: "text", content: "Index response." },
          doneWhen: (screen) => screen.includes("Index response."),
          mutate: () => {
            const indexPath = path.join(family.project, ".git", "index");
            const index = readFileSync(indexPath);
            truncateSync(indexPath, Math.floor(index.length / 2));
          },
          verify: (receipt) => {
            const summary = fileSummary(receipt.changes);
            assert.equal(summary.state, "unavailable", "Incomplete index metadata fails closed");
            assert.equal(summary.reason, "error", "The bounded error reason is reported");
          },
        }],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "content-index", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  if (failures.length > 0) {
    throwScenarioFailure({ directory: directories[0] ?? repositoryRoot, message: "Receipt-git content scenario failed",
      errors: failures, diagnostics: JSON.stringify({ platform: process.platform, node: process.version, pi: piVersion, diagnostics }) });
  }
  for (const directory of directories) await removeDirectoryEventually(directory);
});

test("real Pi receipt never executes repository-controlled Git code or filters", { timeout: 420_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const diagnostics: RecordValue[] = [];
  const directories: string[] = [];
  const sentinelAbsent = (filePath: string): void => {
    assert.equal(existsSync(filePath), false, `Repository-controlled code must never execute (${filePath})`);
  };
  // A tripwire writes its sentinel only if some Git extension point executes it.
  const writeTripwire = (directory: string): string => {
    const tripwire = path.join(directory, "tripwire.cjs");
    writeFileSync(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'invoked');process.stdin.pipe(process.stdout);\n");
    return tripwire;
  };
  const tripwireCommand = (tripwire: string, sentinel: string): string =>
    `"${process.execPath.replaceAll("\\", "/")}" "${tripwire.replaceAll("\\", "/")}" "${sentinel.replaceAll("\\", "/")}"`;
  const writeShims = (directory: string, sentinel: string): void => {
    const portable = sentinel.replaceAll("\\", "/").replaceAll('"', '\\"');
    const batch = `@echo off\r\necho executed> "${portable}"\r\n`;
    for (const name of ["where", "which", "git", "where.cmd", "where.bat", "which.cmd", "which.bat", "git.cmd", "git.bat"]) {
      writeFileSync(path.join(directory, name), batch);
    }
  };
  const safeStatus = (project: string): string =>
    git(project, "-c", "core.fsmonitor=false", "-c", "filter.tripwire.clean=", "-c", "filter.tripwire.process=",
      "-c", "filter.tripwire.required=false", "-c", "filter.late.clean=", "-c", "filter.included.clean=",
      "-c", "filter.branchlate.clean=", "-c", "filter.envlate.clean=", "status", "--porcelain=v1", "-z").toString("utf8");
  const objectInventory = (directory: string, prefix = ""): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? objectInventory(path.join(directory, entry.name), relative)
        : [`${relative}:${createHash("sha256").update(readFileSync(path.join(directory, entry.name))).digest("hex")}`];
    }).sort();

  // Family A: configured extension points and filters that appear mid-collection never execute.
  {
    const family = createFamily(repositoryRoot, "safety-filters");
    directories.push(family.directory);
    initRepository(family.project);
    const probe = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-safety-probe-"));
    directories.push(probe);
    const sentinel = path.join(probe, "sentinel");
    const tripwire = writeTripwire(probe);
    const provider = new ReceiptGitProvider();
    try {
      const project = family.project;
      const command = tripwireCommand(tripwire, sentinel);
      writeFileSync(path.join(project, ".gitattributes"), [
        "clean.txt filter=tripwire diff=tripwire", "late.txt filter=late", "included.txt filter=included",
        "branch.txt filter=branchlate", "env.txt filter=envlate",
      ].join("\n") + "\n");
      git(project, "add", ".gitattributes");
      writeFileSync(path.join(project, "preexisting.txt"), "original\n");
      git(project, "add", "preexisting.txt");
      git(project, "commit", "-q", "-m", "filter attributes");
      writeFileSync(path.join(project, "staged.txt"), "staged\n");
      git(project, "add", "staged.txt");
      writeFileSync(path.join(project, "preexisting.txt"), "unstaged\n");
      git(project, "config", "core.fsmonitor", command);
      git(project, "config", "filter.tripwire.clean", command);
      git(project, "config", "diff.tripwire.command", command);
      git(project, "config", "include.path", "late.config");
      git(project, "config", "includeIf.onbranch:trigger.path", "../trigger.config");
      const headBefore = git(project, "rev-parse", "HEAD").toString("utf8");
      const branchBefore = git(project, "branch", "--show-current").toString("utf8");
      const statusBefore = safeStatus(project);
      const indexBefore = readFileSync(path.join(project, ".git", "index"));
      const objectsBefore = objectInventory(path.join(project, ".git", "objects"));
      const stashBefore = git(project, "stash", "list").toString("utf8");
      // The environment-config filter rides the child env for the whole family (spawn-fixed; recorded honestly).
      family.env.GIT_CONFIG_COUNT = "1";
      family.env.GIT_CONFIG_KEY_0 = "filter.envlate.clean";
      family.env.GIT_CONFIG_VALUE_0 = tripwireCommand(tripwire, sentinel);
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [
          {
            label: "unchanged Git state turn", step: { kind: "text", content: "Unchanged Git state response." },
            doneWhen: (screen) => screen.includes("Unchanged Git state response."),
            mutate: () => {},
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, { state: "available", totalFiles: 0,
                additions: 0, deletions: 0, files: [], omittedFiles: 0 });
              sentinelAbsent(sentinel);
              assert.deepEqual(readFileSync(path.join(project, ".git", "index")), indexBefore);
              assert.deepEqual(objectInventory(path.join(project, ".git", "objects")), objectsBefore);
              assert.equal(git(project, "rev-parse", "HEAD").toString("utf8"), headBefore);
              assert.equal(git(project, "branch", "--show-current").toString("utf8"), branchBefore);
              assert.equal(git(project, "stash", "list").toString("utf8"), stashBefore);
              assert.equal(safeStatus(project), statusBefore);
            },
          },
          {
            label: "extension points turn", step: { kind: "text", content: "Extension response." },
            doneWhen: (screen) => screen.includes("Extension response."),
            mutate: () => writeFileSync(path.join(project, "clean.txt"), "clean\nchanged\n"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "Configured fsmonitor/filters never block the receipt");
              assert.deepEqual(summary.files, [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 0 }],
                "The receipt reports the real delta without invoking any extension point");
              sentinelAbsent(sentinel);
              assert.equal(git(project, "rev-parse", "HEAD").toString("utf8"), headBefore, "HEAD stays untouched");
              assert.equal(git(project, "branch", "--show-current").toString("utf8"), branchBefore, "Branch stays untouched");
              assert.equal(safeStatus(project).replace(/[^\u0000]*clean\.txt\u0000/u, ""), statusBefore, "Collection alters no other Git state");
            },
          },
          {
            label: "late filter turn", step: { kind: "text", content: "Late response." },
            doneWhen: (screen) => screen.includes("Late response."),
            mutate: () => {
              git(project, "config", "filter.late.clean", command);
              writeFileSync(path.join(project, "late.txt"), "late\n");
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "A filter configured after collection starts never executes");
              assert.ok(summary.files.some((file) => file.path === "late.txt"), "The late file still reports");
              sentinelAbsent(sentinel);
            },
          },
          {
            label: "included filter turn", step: { kind: "text", content: "Included response." },
            doneWhen: (screen) => screen.includes("Included response."),
            mutate: () => {
              writeFileSync(path.join(project, ".git", "late.config"), `[filter "included"]\n\tclean = ${command}\n`);
              writeFileSync(path.join(project, "included.txt"), "included\n");
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "A filter from a config included after collection starts never executes");
              assert.ok(summary.files.some((file) => file.path === "included.txt"), "The included file still reports");
              sentinelAbsent(sentinel);
            },
          },
          {
            label: "branch include turn", step: { kind: "text", content: "Branch response." },
            doneWhen: (screen) => screen.includes("Branch response."),
            mutate: () => {
              writeFileSync(path.join(project, "trigger.config"), `[filter "branchlate"]\n\tclean = ${command}\n`);
              git(project, "-c", "core.fsmonitor=false", "-c", "filter.tripwire.clean=",
                "-c", "filter.branchlate.clean=", "checkout", "-q", "-b", "trigger");
              writeFileSync(path.join(project, "branch.txt"), "branch\n");
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "A branch-conditional include activating mid-collection never executes");
              assert.ok(summary.files.some((file) => file.path === "branch.txt"), "The branch file still reports");
              sentinelAbsent(sentinel);
            },
          },
          {
            label: "environment filter turn", step: { kind: "text", content: "Environment response." },
            doneWhen: (screen) => screen.includes("Environment response."),
            mutate: () => writeFileSync(path.join(project, "env.txt"), "environment\n"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "A filter supplied through Git environment configuration never executes");
              assert.ok(summary.files.some((file) => file.path === "env.txt"), "The environment file still reports");
              sentinelAbsent(sentinel);
            },
          },
        ],
      });
      diagnostics.push({ family: "safety-filters", note: "environment filter present from process start (child env is spawn-fixed)" });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "safety-filters", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family B: promisor remotes are never fetched and promised blobs stay missing.
  {
    const parent = mkdtempSync(path.join(repositoryRoot, "node_modules", ".killeros-safety-promisor-"));
    directories.push(parent);
    const source = path.join(parent, "source");
    const clone = path.join(parent, "clone");
    git(parent, "init", "-q", source);
    writeFileSync(path.join(source, "file.txt"), "present\n");
    writeFileSync(path.join(source, "big.bin"), `${"x".repeat(10_000)}\n`);
    git(source, "add", ".");
    git(source, "commit", "-q", "-m", "fixture");
    const promised = git(source, "rev-parse", "HEAD:big.bin").toString("utf8").trim();
    execFileSync("git", ["clone", "-q", source, clone], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    for (const entry of readdirSync(path.join(clone, ".git", "objects", "pack"))) {
      if (!entry.endsWith(".pack")) continue;
      execFileSync("git", ["unpack-objects"], { cwd: clone, input: readFileSync(path.join(clone, ".git", "objects", "pack", entry)),
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    }
    for (const entry of readdirSync(path.join(clone, ".git", "objects", "pack"))) {
      rmSync(path.join(clone, ".git", "objects", "pack", entry));
    }
    rmSync(path.join(clone, ".git", "objects", promised.slice(0, 2), promised.slice(2)));
    git(clone, "remote", "add", "promisor", source);
    git(clone, "config", "extensions.partialClone", "promisor");
    git(clone, "config", "remote.promisor.promisor", "true");
    const objectInventory = (root: string): string[] => {
      const result: string[] = [];
      const walk = (directory: string, prefix: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
          else result.push(`${relative}:${createHash("sha256").update(readFileSync(path.join(directory, entry.name))).digest("hex")}`);
        }
      };
      walk(path.join(root, ".git", "objects"), "");
      return result.sort();
    };
    const before = objectInventory(clone);
    const envFamily = createFamily(repositoryRoot, "promisor-env");
    directories.push(envFamily.directory);
    const family: Family = { directory: parent, project: clone, agent: envFamily.agent, env: envFamily.env };
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [{
          label: "promisor turn", step: { kind: "text", content: "Promisor response." },
          doneWhen: (screen) => screen.includes("Promisor response."),
          mutate: () => {
            const staged = git(clone, "hash-object", "-w", "file.txt").toString("utf8").trim();
            git(clone, "update-index", "--cacheinfo", `100644,${staged},big.bin`);
          },
          verify: (receipt) => {
            const summary = fileSummary(receipt.changes);
            assert.equal(summary.state, "unavailable", "Promised blobs fail closed instead of fetching");
            assert.equal(summary.reason, "error", "The bounded error reason is reported");
          },
        }],
      });
      assert.deepEqual(objectInventory(clone), before,
        "No objects are fetched during the promisor turn");
      assert.equal(existsSync(path.join(clone, ".git", "objects", promised.slice(0, 2), promised.slice(2))), false,
        "The promised blob is still missing afterward");
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "promisor", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family C: repository-local shims, directory links, and missing executables fail closed.
  {
    const variants: Array<{ label: string; pathKind: "repo-shims" | "external-shims" | "junction" | "none"; expectAvailable: boolean }> = [
      { label: "repo-shims", pathKind: "repo-shims", expectAvailable: true },
      { label: "external-shims", pathKind: "external-shims", expectAvailable: false },
      { label: "junction", pathKind: "junction", expectAvailable: false },
      { label: "none", pathKind: "none", expectAvailable: false },
    ];
    for (const variant of variants) {
      const family = createFamily(repositoryRoot, `safety-exec-${variant.label}`);
      directories.push(family.directory);
      initRepository(family.project);
      const probe = mkdtempSync(path.join(repositoryRoot, "node_modules", `.killeros-safety-${variant.label}-`));
      directories.push(probe);
      const sentinel = path.join(probe, "sentinel");
      let extraPath: string;
      if (variant.pathKind === "none") {
        writeShims(family.project, sentinel);
        extraPath = ["", ".", family.project].join(path.delimiter);
      } else if (variant.pathKind === "repo-shims") {
        // Repository-local shims are written before launch so they never enter the response delta.
        writeShims(family.project, sentinel);
        extraPath = ["", ".", family.project].join(path.delimiter);
      } else {
        writeShims(probe, sentinel);
        extraPath = probe;
        if (variant.pathKind === "junction") {
          const junction = path.join(family.project, "bin");
          symlinkSync(probe, junction, "junction");
          extraPath = junction;
        }
      }
      family.env.PATH = variant.pathKind === "none" || variant.pathKind === "junction"
        ? extraPath : [extraPath, process.env.PATH ?? ""].join(path.delimiter);
      const provider = new ReceiptGitProvider();
      try {
        const port = await provider.listen();
        writeProviderConfig(family.agent, port);
        await runTurns({
          family, provider, signal: t.signal,
          turns: [{
            label: `${variant.label} turn`, step: { kind: "text", content: `${variant.label} response.` },
            doneWhen: (screen) => screen.includes(`${variant.label} response.`),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "clean\nchanged\n"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              if (variant.expectAvailable) {
                assert.equal(summary.state, "available",
                  `${variant.label}: repository-local executables are skipped; the safe system Git still serves the receipt`);
                assert.ok(summary.files.some((file) => file.path === "clean.txt"), "The real delta still reports");
              } else {
                assert.equal(summary.state, "unavailable",
                  `${variant.label}: without a trustworthy Git executable the receipt fails closed`);
                assert.notEqual(summary.state, "available", "Unavailable is never reported as an empty repository");
              }
              sentinelAbsent(sentinel);
            },
          }],
        });
      } catch (error) {
        failures.push(error);
        diagnostics.push({ family: `exec-${variant.label}`, providerRequests: provider.requests.length, providerErrors: provider.errors });
      } finally {
        try { await provider.close(); } catch (error) { failures.push(error); }
      }
    }
  }

  if (failures.length > 0) {
    throwScenarioFailure({ directory: directories[0] ?? repositoryRoot, message: "Receipt-git safety scenario failed",
      errors: failures, diagnostics: JSON.stringify({ platform: process.platform, node: process.version, pi: piVersion, diagnostics }) });
  }
  for (const directory of directories) await removeDirectoryEventually(directory);
});

test("real Pi receipt bounds diff work, blob storage, and repository formats", { timeout: 480_000 }, async (t: TestContext) => {
  const failures: unknown[] = [];
  const diagnostics: RecordValue[] = [];
  const directories: string[] = [];

  // Family A: reftable repositories produce receipts, reject HEAD moves, and fail closed on truncated blobs.
  {
    const family = createFamily(repositoryRoot, "limits-reftable");
    directories.push(family.directory);
    git(family.project, "init", "-q", "--ref-format=reftable");
    git(family.project, "config", "core.autocrlf", "false");
    writeFileSync(path.join(family.project, "clean.txt"), "clean\n");
    git(family.project, "add", ".");
    git(family.project, "commit", "-q", "-m", "reftable baseline");
    const firstHead = git(family.project, "rev-parse", "HEAD").toString("ascii").trim();
    writeFileSync(path.join(family.project, "clean.txt"), "next\n");
    git(family.project, "add", "clean.txt");
    git(family.project, "commit", "-q", "-m", "prebuilt next reftable head");
    const nextHead = git(family.project, "rev-parse", "HEAD").toString("ascii").trim();
    git(family.project, "reset", "-q", "--hard", firstHead);
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [
          {
            label: "reftable changed turn", step: { kind: "text", content: "Reftable changed response." },
            doneWhen: (screen) => screen.includes("Reftable changed response."),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "changed\n"),
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, { state: "available", totalFiles: 1,
                additions: 1, deletions: 1, files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }],
                omittedFiles: 0 }, "The complete reftable delta is exact");
            },
          },
          {
            label: "reftable unchanged turn", step: { kind: "text", content: "Reftable unchanged response." },
            doneWhen: (screen) => screen.includes("Reftable unchanged response."),
            mutate: () => undefined,
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, { state: "available", totalFiles: 0,
                additions: 0, deletions: 0, files: [], omittedFiles: 0 });
            },
          },
          {
            label: "reftable head move turn", step: { kind: "text", content: "Reftable head response." },
            doneWhen: (screen) => screen.includes("Reftable head response."),
            mutate: () => {
              git(family.project, "update-ref", "HEAD", nextHead);
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "unavailable", "A HEAD update without worktree events invalidates the receipt");
              assert.equal(summary.reason, "error", "The bounded error reason is reported");
            },
          },
          {
            label: "reftable truncated turn", step: { kind: "text", content: "Reftable truncated response." },
            doneWhen: (screen) => screen.includes("Reftable truncated response."),
            mutate: () => {
              git(family.project, "reset", "-q", "--hard");
              const id = git(family.project, "rev-parse", "HEAD:clean.txt").toString("utf8").trim();
              const objectPath = path.join(family.project, ".git", "objects", id.slice(0, 2), id.slice(2));
              const object = readFileSync(objectPath);
              chmodSync(objectPath, 0o644);
              truncateSync(objectPath, object.length - 1);
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "unavailable", "A truncated loose blob fails as an unavailable error");
              assert.equal(summary.reason, "error", "The bounded error reason is reported");
            },
          },
        ],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "limits-reftable", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Family B: divergent diff work and oversized response files stop at the limits; the next response recovers.
  {
    const family = createFamily(repositoryRoot, "limits-response");
    directories.push(family.directory);
    initRepository(family.project);
    const provider = new ReceiptGitProvider();
    try {
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: [
          {
            label: "divergent turn", step: { kind: "text", content: "Divergent response." },
            doneWhen: (screen) => screen.includes("Divergent response."),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"),
              Array.from({ length: 1_200 }, (_, index) => `replacement ${index}\n`).join("")),
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, { state: "unavailable", reason: "too-large" },
                "Large divergent text stops at the diff work limit");
            },
          },
          {
            label: "oversized response turn", step: { kind: "text", content: "Oversized response." },
            doneWhen: (screen) => screen.includes("Oversized response."),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"), Buffer.alloc(128 * 1024 * 1024 + 1)),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "unavailable", "An oversized response file fails before diffing");
              assert.equal(summary.reason, "too-large", "The bounded too-large reason is reported");
            },
          },
          {
            label: "poisoned baseline turn", step: { kind: "text", content: "Poisoned response." },
            doneWhen: (screen) => screen.includes("Poisoned response."),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "clean\nchanged\n"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "unavailable", "The overflowing file still on disk poisons the next baseline");
              assert.equal(summary.reason, "too-large", "The bounded too-large reason persists");
            },
          },
          {
            label: "recovery turn", step: { kind: "text", content: "Recovery response." },
            doneWhen: (screen) => screen.includes("Recovery response."),
            mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "clean\nchanged again\n"),
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "available", "Once the oversized file is replaced, the next baseline recovers");
              assert.deepEqual(summary.files, [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }],
                "The recovered response reports the real text delta");
            },
          },
        ],
      });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: "limits-response", providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  // Preserve both storage layouts and the original baseline-before-deletion histories.
  for (const variant of ["below-packed", "oversized-loose", "oversized-packed", "aggregate-loose", "aggregate-packed"] as const) {
    const oversized = variant.startsWith("oversized");
    const aggregate = variant.startsWith("aggregate");
    const negative = oversized || aggregate;
    const family = createFamily(repositoryRoot, `limits-blobs-${variant}`);
    directories.push(family.directory);
    git(family.project, "init", "-q");
    git(family.project, "config", "core.autocrlf", "false");
    const largePath = path.join(family.project, "large.bin");
    if (negative) {
      writeFileSync(largePath, "");
      truncateSync(largePath, 128 * 1024 * 1024 + (oversized ? 1 : 0));
    }
    const midPath = path.join(family.project, negative ? "mid.bin" : "large.bin");
    if (!negative) writeFileSync(midPath, Buffer.alloc(16 * 1024 * 1024 + 1));
    writeFileSync(path.join(family.project, "small.bin"), "x");
    git(family.project, "add", ".");
    git(family.project, "commit", "-q", "-m", "blob fixtures");
    if (variant.endsWith("packed")) git(family.project, "repack", "-ad", "-q");
    const provider = new ReceiptGitProvider();
    try {
      if (negative) {
        const blob = git(family.project, "rev-parse", "HEAD:large.bin").toString("ascii").trim();
        assert.equal(existsSync(path.join(family.project, ".git", "objects", blob.slice(0, 2), blob.slice(2))),
          variant.endsWith("loose"), `${variant} must execute its specified object storage layout`);
      }
      if (!negative) {
        const blob = git(family.project, "rev-parse", "HEAD:large.bin").toString("ascii").trim();
        assert.match(blob, /^[0-9a-f]{40,64}$/u);
        assert.equal(existsSync(path.join(family.project, ".git", "objects", blob.slice(0, 2), blob.slice(2))), false,
          "The below-limit HEAD blob must not be stored loose");
        git(family.project, "cat-file", "-e", blob);
      }
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      await runTurns({
        family, provider, signal: t.signal,
        turns: negative ? [
          {
            label: "oversized blob turn", step: { kind: "text", content: "Oversized response." },
            doneWhen: (screen) => screen.includes("Oversized response."),
            mutate: () => {
              rmSync(largePath);
              rmSync(path.join(family.project, "small.bin"));
            },
            verify: (receipt) => {
              const summary = fileSummary(receipt.changes);
              assert.equal(summary.state, "unavailable", "An oversized HEAD blob is unavailable in object storage");
              assert.equal(summary.reason, "too-large", "The bounded too-large reason is reported");
            },
          },
        ] : [
          {
            label: "below limit packed turn", step: { kind: "text", content: "Below response." },
            doneWhen: (screen) => screen.includes("Below response."),
            mutate: () => rmSync(midPath),
            verify: (receipt) => {
              assert.deepEqual(receipt.changes, {
                state: "available", totalFiles: 1, additions: 0, deletions: 0,
                files: [{ kind: "deleted", path: "large.bin", additions: 0, deletions: 0, detail: "binary" }], omittedFiles: 0,
              }, "The below-limit packed deletion reports as binary");
            },
          },
        ],
      });
      diagnostics.push({ family: `limits-blobs-${variant}`, negative, aggregate });
    } catch (error) {
      failures.push(error);
      diagnostics.push({ family: `limits-blobs-${variant}`, providerRequests: provider.requests.length, providerErrors: provider.errors });
    } finally {
      try { await provider.close(); } catch (error) { failures.push(error); }
    }
  }

  if (failures.length > 0) {
    throwScenarioFailure({ directory: directories[0] ?? repositoryRoot, message: "Receipt-git limits scenario failed",
      errors: failures, diagnostics: JSON.stringify({ platform: process.platform, node: process.version, pi: piVersion, diagnostics }) });
  }
  for (const directory of directories) await removeDirectoryEventually(directory);
});

const emptyChanges = { state: "available", totalFiles: 0, additions: 0, deletions: 0, files: [], omittedFiles: 0 };

test("receipt oversized response resets to an empty next baseline", { timeout: 120_000 }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "oversized-recovery");
  initRepository(family.project);
  const provider = new ReceiptGitProvider();
  try {
    writeProviderConfig(family.agent, await provider.listen());
    const target = path.join(family.project, "clean.txt");
    await runTurns({ family, provider, signal: t.signal, turns: [
      {
        label: "oversize recovery first", step: { kind: "text", content: "Oversize recovery first response." },
        doneWhen: (screen) => screen.includes("Oversize recovery first response."),
        mutate: () => { writeFileSync(target, ""); truncateSync(target, 128 * 1024 * 1024 + 1); },
        verify: (receipt) => {
          assert.deepEqual(receipt.changes, { state: "unavailable", reason: "too-large" });
          writeFileSync(target, "clean\n");
        },
      },
      {
        label: "oversize recovery second", step: { kind: "text", content: "Oversize recovery second response." },
        doneWhen: (screen) => screen.includes("Oversize recovery second response."), mutate: () => {},
        verify: (receipt) => assert.deepEqual(receipt.changes, emptyChanges),
      },
    ] });
    assert.equal(provider.requests.length, 2);
  } finally {
    await provider.close();
    await removeDirectoryEventually(family.directory);
  }
});

test("receipt restored changes and isolated non-Git projects remain truthful", { timeout: 120_000 }, async (t: TestContext) => {
  const repo = createFamily(repositoryRoot, "restored");
  const outside = createFamily(repositoryRoot, "outside");
  const isolated = mkdtempSync(path.join(os.tmpdir(), "killeros-non-git-"));
  const provider = new ReceiptGitProvider();
  try {
    initRepository(repo.project);
    assert.throws(() => git(isolated, "rev-parse", "--show-toplevel"), "Non-Git fixture must not have a repository ancestor");
    const port = await provider.listen();
    writeProviderConfig(repo.agent, port);
    writeProviderConfig(outside.agent, port);
    await runTurns({ family: repo, provider, signal: t.signal, turns: [{
      label: "restored change", step: { kind: "text", content: "Restored response." },
      doneWhen: (screen) => screen.includes("Restored response."),
      mutate: () => { writeFileSync(path.join(repo.project, "clean.txt"), "temporary\n"); writeFileSync(path.join(repo.project, "clean.txt"), "clean\n"); },
      verify: (receipt) => assert.deepEqual(receipt.changes, emptyChanges),
    }] });
    await runTurns({ family: { ...outside, project: isolated }, provider, signal: t.signal, turns: [{
      label: "outside repository", step: { kind: "text", content: "Outside response." },
      doneWhen: (screen) => screen.includes("Outside response."), mutate: () => {},
      verify: (receipt) => assert.deepEqual(receipt.changes, { state: "unavailable", reason: "not-git" }),
    }] });
    assert.equal(provider.requests.length, 2);
  } finally {
    await provider.close();
    await removeDirectoryEventually(repo.directory);
    await removeDirectoryEventually(outside.directory);
    await removeDirectoryEventually(isolated);
  }
});

test("receipt rejects a loose blob corrupted before collection", { timeout: 120_000 }, async (t: TestContext) => {
  const family = createFamily(repositoryRoot, "precorrupt");
  initRepository(family.project);
  const provider = new ReceiptGitProvider();
  try {
    const id = git(family.project, "rev-parse", "HEAD:clean.txt").toString("ascii").trim();
    const objectPath = path.join(family.project, ".git", "objects", id.slice(0, 2), id.slice(2));
    const object = readFileSync(objectPath);
    chmodSync(objectPath, 0o644);
    truncateSync(objectPath, object.length - 1);
    writeProviderConfig(family.agent, await provider.listen());
    await runTurns({ family, provider, signal: t.signal, turns: [{
      label: "precorrupt deletion", step: { kind: "text", content: "Precorrupt response." },
      doneWhen: (screen) => screen.includes("Precorrupt response."),
      mutate: () => rmSync(path.join(family.project, "clean.txt")),
      verify: (receipt) => assert.deepEqual(receipt.changes, { state: "unavailable", reason: "error" }),
    }] });
    assert.equal(provider.requests.length, 1);
  } finally {
    await provider.close();
    await removeDirectoryEventually(family.directory);
  }
});

// Catalog ID: runtime.receipt-late-environment-filter.
test("receipt disables a Git environment filter activated after its native baseline", { timeout: 45_000 }, async t => {
  const family = createFamily(repositoryRoot, "late-environment-filter");
  const provider = new ReceiptGitProvider();
  const sentinel = path.join(family.directory, "filter-executed");
  const observation = path.join(family.directory, "environment-observation.json");
  const extension = path.join(family.directory, "environment-filter.mjs");
  const tripwire = path.join(family.directory, "tripwire.cjs");
  let failure: unknown;
  const cleanup: unknown[] = [];
  try {
    initRepository(family.project);
    writeFileSync(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'executed');process.stdin.pipe(process.stdout);\n");
    writeFileSync(path.join(family.project, ".gitattributes"), "clean.txt filter=environment-late\n");
    git(family.project, "add", ".gitattributes");
    git(family.project, "commit", "-q", "-m", "late environment filter attributes");
    const command = `"${process.execPath.replaceAll("\\", "/")}" "${tripwire.replaceAll("\\", "/")}" "${sentinel.replaceAll("\\", "/")}"`;
    git(family.project, "-c", `filter.environment-late.clean=${command}`, "hash-object", "--path=clean.txt", "clean.txt");
    assert.equal(readFileSync(sentinel, "utf8"), "executed", "The actual Git filter is an effective execution tripwire");
    rmSync(sentinel);
    writeFileSync(extension, `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
export default function(pi) {
  let requests = 0;
  pi.on("before_provider_request", () => {
    requests++;
    assert.equal(requests,1);
    assert.equal(process.env.GIT_CONFIG_COUNT,undefined);
    process.env.GIT_CONFIG_COUNT="1";
    process.env.GIT_CONFIG_KEY_0="filter.environment-late.clean";
    process.env.GIT_CONFIG_VALUE_0=${JSON.stringify(command)};
    writeFileSync(${JSON.stringify(observation)},JSON.stringify({pid:process.pid,event:"before_provider_request",
      requests,count:process.env.GIT_CONFIG_COUNT,key:process.env.GIT_CONFIG_KEY_0,value:process.env.GIT_CONFIG_VALUE_0}));
  });
}`);
    const port = await provider.listen();
    writeProviderConfig(family.agent, port);
    await runTurns({ family, provider, signal: t.signal, extensions: [extension], turns: [{
      label: "Activate environment filter after baseline", step: { kind: "text", content: "Late environment filter response." },
      doneWhen: screen => screen.includes("Late environment filter response."),
      mutate: () => {
        const observed: unknown = JSON.parse(readFileSync(observation, "utf8"));
        assert.ok(isRecord(observed));
        assert.equal(observed.event, "before_provider_request");
        assert.equal(observed.requests, 1);
        assert.equal(observed.count, "1");
        assert.equal(observed.key, "filter.environment-late.clean");
        assert.equal(observed.value, command);
        writeFileSync(path.join(family.project, "clean.txt"), "changed\n");
      },
      verify: receipt => {
        assert.deepEqual(receipt.changes, { state: "available", totalFiles: 1, additions: 1, deletions: 1,
          files: [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }], omittedFiles: 0 });
        assert.equal(existsSync(sentinel), false, "The newly effective environment filter never executes during settlement");
      },
    }] });
    assert.equal(provider.requests.length, 1);
  } catch (error) { failure = error; }
  finally { try { await provider.close(); } catch (error) { cleanup.push(error); } }
  if (failure !== undefined || cleanup.length) throwScenarioFailure({ directory: family.directory,
    message: "Late environment filter failed", errors: [...(failure === undefined ? [] : [failure]), ...cleanup],
    diagnostics: JSON.stringify({ providerRequests: provider.requests.length, providerErrors: provider.errors }) });
  await removeDirectoryEventually(family.directory);
  assert.equal(existsSync(family.directory), false);
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-late-environment-filter", piLaunches: 1,
    providerRequests: 1, effectiveTripwire: true, naturalExit: true, scratchRemoved: true }));
});

// Real filesystem notification loss and a write during an owned file read exercise settlement rescanning.
test("receipt settlement rescans without watcher delivery and while filters change", { timeout: 60_000 }, async t => {
  const family = createFamily(repositoryRoot, "scan-races");
  const provider = new ReceiptGitProvider();
  const observation = path.join(family.directory, "scan-observation.json");
  const sentinel = path.join(family.directory, "filter-executed");
  const tripwire = path.join(family.directory, "filter.cjs");
  const extension = path.join(family.directory, "scan-races.mjs");
  try {
    initRepository(family.project);
    writeFileSync(path.join(family.project, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 1));
    writeFileSync(path.join(family.project, "late.txt"), "before\n");
    writeFileSync(path.join(family.project, ".gitattributes"), "*.txt filter=race\n");
    git(family.project, "add", ".");
    git(family.project, "commit", "-q", "-m", "scan race baseline");
    writeFileSync(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'executed');process.stdin.pipe(process.stdout);");
    const command = [process.execPath, tripwire, sentinel].map(part => `"${part.replaceAll("\\", "/")}"`).join(" ");
    git(family.project, "-c", `filter.race.clean=${command}`, "hash-object", "--path=clean.txt", "clean.txt");
    assert.equal(readFileSync(sentinel, "utf8"), "executed");
    rmSync(sentinel);
    const gitFile = execFileSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/u)[0];
    assert.ok(gitFile);
    writeFileSync(extension, `import fs from "node:fs";
import promises from "node:fs/promises";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const project=${JSON.stringify(family.project)}, output=${JSON.stringify(observation)};
const originalWatch=fs.watch, originalOpen=promises.open, originalSpawn=cp.spawn;
let turn=0, dropped=0, late=false, baselineFilters=0, settlementFilters=0, active=0;
const report=()=>fs.writeFileSync(output,JSON.stringify({turn,dropped,late,baselineFilters,settlementFilters}));
fs.watch=function(directory,...args){
 const index=args.findIndex(arg=>typeof arg==="function");
 if(String(directory).toLowerCase()===project.toLowerCase()&&index>=0){
  const callback=args[index];args[index]=(...event)=>{if(turn===1){dropped++;report();return;}callback(...event);};
 }
 return originalWatch.call(this,directory,...args);
};
promises.open=async function(file,...args){
 if(turn===2&&!late&&String(file)===project+"\\\\large.bin"){
  late=true;fs.writeFileSync(project+"\\\\late.txt","after\\n");report();
 }
 return await originalOpen.call(this,file,...args);
};
cp.spawn=function(file,args,...rest){
 const normalize=value=>String(value).replaceAll("\\\\","/").toLowerCase();
 const own=Array.isArray(args)&&args.includes("ls-files")&&normalize(rest[0]?.cwd)===normalize(project);
 if(!own)return originalSpawn.call(this,file,args,...rest);
 if(active++===0)cp.execFileSync(${JSON.stringify(gitFile)},["-C",project,"config","filter.race.clean",${JSON.stringify(command)}],{windowsHide:true});
 if(turn===0)baselineFilters++;else settlementFilters++;report();
 const child=originalSpawn.call(this,file,args,...rest);
 child.once("close",()=>{if(--active===0)cp.execFileSync(${JSON.stringify(gitFile)},["-C",project,"config","--unset-all","filter.race.clean"],{windowsHide:true});});
 return child;
};
syncBuiltinESMExports();
export default function(pi){
 pi.on("before_provider_request",()=>{turn++;report();});
 pi.on("session_shutdown",()=>{fs.watch=originalWatch;promises.open=originalOpen;cp.spawn=originalSpawn;syncBuiltinESMExports();report();});
}`);
    const port = await provider.listen();
    writeProviderConfig(family.agent, port);
    await runTurns({ family, provider, signal: t.signal, extensions: [extension], turns: [
      { label: "Immediate unwatched write", step: { kind: "text", content: "Immediate scan response." },
        doneWhen: screen => screen.includes("Immediate scan response."),
        mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "changed\n"),
        verify: receipt => assert.deepEqual(fileSummary(receipt.changes).files,
          [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }]) },
      { label: "Write during native file read", step: { kind: "text", content: "Racing scan response." },
        doneWhen: screen => screen.includes("Racing scan response."),
        mutate: () => writeFileSync(path.join(family.project, "large.bin"), Buffer.alloc(32 * 1024 * 1024, 2)),
        verify: receipt => assert.deepEqual(fileSummary(receipt.changes).files.map(file => file.path), ["large.bin", "late.txt"]) },
    ] });
    const observed: unknown = JSON.parse(readFileSync(observation, "utf8"));
    assert.ok(isRecord(observed));
    assert.equal(observed.turn, 2);
    assert.equal(observed.late, true, "The late write occurs inside the actual file-open boundary");
    assert.ok(typeof observed.dropped === "number" && observed.dropped > 0, "Actual worktree watcher callbacks were withheld");
    assert.ok(typeof observed.baselineFilters === "number" && observed.baselineFilters > 0);
    assert.ok(typeof observed.settlementFilters === "number" && observed.settlementFilters > 0);
    assert.equal(existsSync(sentinel), false, "No effective filter executes during baseline or settlement metadata reads");
    assert.equal(provider.requests.length, 2);
  } finally {
    await provider.close();
    await removeDirectoryEventually(family.directory);
  }
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-scan-races", piLaunches: 1, providerRequests: 2,
    effectiveTripwire: true, watcherFault: "withheld real callbacks", lateWrite: "owned file open", cleanup: "natural" }));
});

test("native receipt paths agree with Git across the complete conversion matrix", { timeout: 240_000 }, async t => {
  const runGroup = async (autoCrlf: "false" | "true" | "input"): Promise<{ inputs: number; turns: number }> => {
    const worker = new Worker(new URL("./support/receipt-git-conversion-worker.ts", import.meta.url), {
      workerData: autoCrlf, execArgv: ["--experimental-strip-types"],
    });
    const cancel = (): void => { worker.postMessage("abort"); };
    t.signal.addEventListener("abort", cancel, { once: true });
    if (t.signal.aborted) cancel();
    let result: unknown;
    let failure: unknown;
    worker.once("message", value => { result = value; });
    worker.once("error", error => { failure = error; });
    const code = await new Promise<number>(resolve => worker.once("exit", resolve));
    t.signal.removeEventListener("abort", cancel);
    if (failure !== undefined || code !== 0) throw new Error(`Conversion group ${autoCrlf} failed (exit ${code})`, { cause: failure });
    assert.ok(isRecord(result) && typeof result.inputs === "number" && typeof result.turns === "number");
    return { inputs: result.inputs, turns: result.turns };
  };
  const results = await Promise.allSettled((["false", "true", "input"] as const).map(runGroup));
  const failures = results.filter(result => result.status === "rejected").map(result => new Error("Conversion group failed", { cause: result.reason }));
  if (failures.length) throw new AggregateError(failures, "Native conversion groups failed");
  const completed = results.filter(result => result.status === "fulfilled").map(result => result.value);
  const inputs = completed.reduce((sum, group) => sum + group.inputs, 0);
  const turns = completed.reduce((sum, group) => sum + group.turns, 0);
  assert.equal(inputs, 5940);
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-conversion-matrix", piLaunches: 3, providerRequests: turns,
    inputCases: inputs, oracle: "actual Git hash-object for every path", cleanup: "natural" }));
});

test("native receipts preserve Windows alias and symlink safety", { timeout: 60_000 }, async t => {
  const outcomes: RecordValue[] = [];
  for (const kind of ["alias", "symlink"] as const) {
    const family = createFamily(repositoryRoot, `native-${kind}`);
    const provider = new ReceiptGitProvider();
    try {
      initRepository(family.project);
      const port = await provider.listen();
      writeProviderConfig(family.agent, port);
      if (kind === "alias") {
        const canonical = path.resolve(family.project);
        const alias = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:KILLEROS_SHORT_PATH).ShortPath"],
        { env: { ...process.env, KILLEROS_SHORT_PATH: canonical }, encoding: "utf8", windowsHide: true, timeout: 10_000 }).trim();
        if (alias.toLowerCase() === canonical.toLowerCase()) {
          outcomes.push({ kind, capability: "Filesystem does not provide an 8.3 alias", piLaunches: 0 });
          continue;
        }
        const sentinel = path.join(family.directory, "shim-executed");
        for (const name of ["where", "which", "git", "where.cmd", "where.bat", "which.cmd", "which.bat", "git.cmd", "git.bat"]) {
          writeFileSync(path.join(canonical, name), `@echo off\r\necho executed> "${sentinel}"\r\n`);
        }
        family.env.PATH = alias + path.delimiter + (process.env.PATH ?? "");
        await runTurns({ family: { ...family, project: alias }, provider, signal: t.signal, turns: [{
          label: "Safe scan through short alias", step: { kind: "text", content: "Alias response." },
          doneWhen: screen => screen.includes("Alias response."),
          mutate: () => writeFileSync(path.join(canonical, "clean.txt"), "changed\n"),
          verify: receipt => {
            const summary = fileSummary(receipt.changes);
            assert.equal(summary.state, "available");
            assert.deepEqual(summary.files, [{ kind: "modified", path: "clean.txt", additions: 1, deletions: 1 }]);
            assert.equal(existsSync(sentinel), false);
          },
        }] });
        outcomes.push({ kind, capability: "8.3 alias exercised", piLaunches: 1, requests: 1 });
      } else {
        const link = path.join(family.project, "link");
        try { symlinkSync("one\r\ntwo", link, "file"); }
        catch (error) {
          if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(String(error.code))) {
            outcomes.push({ kind, capability: "Filesystem does not permit the original symlink", piLaunches: 0 });
            continue;
          }
          throw error;
        }
        git(family.project, "config", "core.symlinks", "true");
        writeFileSync(path.join(family.project, ".gitattributes"), "* text eol=lf\n");
        git(family.project, "add", ".");
        git(family.project, "commit", "-q", "-m", "exact symlink destination");
        const indexId = git(family.project, "rev-parse", ":link").toString().trim();
        await runTurns({ family, provider, signal: t.signal, turns: ["one\r\ntwo", "one\ntwo", "changed"].map((destination, index) => ({
          label: `Symlink destination ${index}`, step: { kind: "text", content: `Symlink response ${index}.` },
          doneWhen: screen => screen.includes(`Symlink response ${index}.`),
          mutate: () => { rmSync(link); symlinkSync(destination, link, "file"); },
          verify: receipt => {
            const oracle = execFileSync("git", ["hash-object", "--no-filters", "--stdin"], { cwd: family.project,
              input: destination, encoding: "utf8", windowsHide: true }).trim();
            const summary = fileSummary(receipt.changes);
            assert.equal(summary.state, "available");
            assert.deepEqual(summary.files.map(file => file.path), oracle === indexId ? [] : ["link"]);
          },
        })) });
        outcomes.push({ kind, capability: "original destinations exercised", piLaunches: 1, requests: 3 });
      }
    } finally {
      await provider.close();
      await removeDirectoryEventually(family.directory);
    }
  }
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-windows-paths", outcomes, cleanup: "natural" }));
});

test("native receipt timeouts stay quiet and denied timing saves recover", { timeout: 60_000 }, async t => {
  const family = createFamily(repositoryRoot, "timeout-save");
  const provider = new ReceiptGitProvider();
  const sockets = new Set<Socket>();
  const pipe = `\\\\.\\pipe\\killeros-receipt-timeout-${process.pid}-${Date.now()}`;
  const server = createPipeServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const marker = path.join(family.directory, "timeout-exit.json");
  const extension = path.join(family.directory, "external-faults.mjs");
  const session = path.join(family.directory, "session.jsonl");
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const icacls = path.join(windows, "System32", "icacls.exe");
  let denied = false;
  let sid = "";
  let connections = 0;
  server.on("connection", () => { connections++; });
  const closePipe = async (): Promise<void> => {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  };
  try {
    initRepository(family.project);
    const config = path.join(family.project, ".git/config");
    const originalConfig = readFileSync(config, "utf8");
    const identity = execFileSync(path.join(windows, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    sid = /S-1-[0-9-]+/u.exec(identity)?.[0] ?? "";
    assert.notEqual(sid, "");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
    writeFileSync(extension, `import cp from "node:child_process";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
const original=cp.spawn;
cp.spawn=function(file,args,...rest){
 const child=original.call(this,file,args,...rest);
 if(new Error().stack?.includes("change-receipt"))child.once("exit",(code,signal)=>{
  if(signal)fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({code,signal,pid:child.pid}));
 });
 return child;
};syncBuiltinESMExports();
export default function(pi){
 let prompt="";pi.on("before_agent_start",event=>{prompt=event.prompt;});
 pi.on("agent_before_settle",()=>{if(prompt==="Deny timing save")cp.execFileSync(${JSON.stringify(icacls)},
  [${JSON.stringify(session)},"/deny",${JSON.stringify(`*${sid}:(W)`)}],{windowsHide:true,timeout:10000});});
 pi.on("session_shutdown",()=>{cp.spawn=original;syncBuiltinESMExports();});
}`);
    const port = await provider.listen();
    writeProviderConfig(family.agent, port);
    const releasePipe = async (): Promise<void> => {
      for (let attempt = 0; attempt < 1500; attempt++) {
        if (existsSync(marker)) {
          const exit: unknown = JSON.parse(readFileSync(marker, "utf8"));
          assert.ok(isRecord(exit));
          assert.equal(exit.signal, "SIGTERM", "The real receipt deadline terminates its actual Git child");
          await closePipe();
          return;
        }
        await delay(10, undefined, { signal: t.signal });
      }
      assert.fail("The native Git timeout never terminated its child");
    };
    const history = runTurns({ family, provider, signal: t.signal, extensions: [extension], turns: [
      { label: "Timeout actual Git read", step: { kind: "text", content: "Timeout response." },
        doneWhen: screen => screen.includes("Timeout response."),
        mutate: () => { git(family.project, "config", "include.path", pipe.replaceAll("\\", "/")); },
        verify: receipt => {
          assert.deepEqual(receipt.changes, { state: "unavailable", reason: "timeout" });
          assert.ok(connections > 0, "Git really opened the owned blocked config pipe");
          writeFileSync(config, originalConfig);
        } },
      { label: "Recover after Git timeout", step: { kind: "text", content: "Timeout recovery response." },
        doneWhen: screen => screen.includes("Timeout recovery response."),
        mutate: () => writeFileSync(path.join(family.project, "clean.txt"), "changed\n"),
        verify: (receipt, screen) => {
          assert.equal(fileSummary(receipt.changes).state, "available");
          assert.doesNotMatch(screen, /Change receipt unavailable/u, "Timeout produces inline fallback without a warning");
        } },
      { label: "Deny timing save", step: { kind: "text", content: "Denied save response." }, receiptDelta: 0,
        screenMarker: "Worked-for timing could not be saved:",
        doneWhen: screen => screen.includes("Denied save response."),
        mutate: () => { denied = true; },
        afterSettlement: () => {
          execFileSync(icacls, [session, "/remove:d", `*${sid}`], { windowsHide: true, timeout: 10_000 });
          denied = false;
        },
        verify: (_receipt, screen) => {
          assert.equal(sessionReceipts(session).length, 2, "The denied append publishes no partial receipt");
          assert.equal(screen.split("Worked-for timing could not be saved:").length - 1, 1);
        } },
      { label: "Recover after denied save", step: { kind: "text", content: "Save recovery response." },
        doneWhen: screen => screen.includes("Save recovery response."), mutate: () => {},
        verify: (receipt, screen) => {
          assert.equal(receipt.outcome, "done");
          assert.equal(sessionReceipts(session).length, 3, "A later native task saves exactly once");
          assert.equal(screen.split("Worked-for timing could not be saved:").length - 1, 1, "No duplicate save warning");
        } },
    ] });
    const results = await Promise.allSettled([history, releasePipe()]);
    const failures = results.filter(result => result.status === "rejected").map(result => new Error("Receipt fault history failed", { cause: result.reason }));
    if (failures.length) throw new AggregateError(failures, "Native receipt faults failed");
    assert.equal(provider.requests.length, 4);
  } finally {
    await closePipe();
    if (denied && existsSync(session)) execFileSync(icacls, [session, "/remove:d", `*${sid}`], { windowsHide: true, timeout: 10_000 });
    await provider.close();
    await removeDirectoryEventually(family.directory);
  }
  t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-timeout-save", piLaunches: 1, providerRequests: 4,
    blockedGitConnections: connections, nativeTimeout: true, aclRestored: true, cleanup: "natural" }));
});
