import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { resolveGitFileChanges } from "../killeros/footer.ts";

// The footer scans every trusted session's repository automatically, so a hostile checkout must not run code through it.
// These call the footer's real scan against real Git; no Pi launch is needed to reach that boundary.

type HostileRepository = { root: string; project: string; alternate: string; outside: string; sentinels: string[] };

/** Runs fixture Git with the runner's own PATH, which the scanner under test never uses. */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "K", GIT_AUTHOR_EMAIL: "k@example.test",
      GIT_COMMITTER_NAME: "K", GIT_COMMITTER_EMAIL: "k@example.test" } });
}

/** A repository whose config, attributes, and checked-in shims each write a sentinel file if Git or a shim runs them. */
function hostileRepository(t: TestContext): HostileRepository {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "killeros-footer-git-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  const alternate = path.join(root, "alternate");
  mkdirSync(project);
  mkdirSync(outside);
  mkdirSync(alternate);
  // A second repository with different changes: leaking an inherited selector would report its counts instead.
  git(alternate, "init", "--quiet", "--initial-branch=main");
  writeFileSync(path.join(alternate, "tracked.txt"), "alternate\n");
  git(alternate, "add", ".");
  git(alternate, "commit", "--quiet", "-m", "alternate");
  for (const name of ["one", "two", "three", "four", "five"]) writeFileSync(path.join(alternate, `${name}.txt`), "untracked\n");
  const tripwire = path.join(root, "tripwire.cjs");
  writeFileSync(tripwire, "require('node:fs').writeFileSync(process.argv[2], 'executed'); process.stdin.pipe(process.stdout);\n");
  const command = (sentinel: string): string => [process.execPath, tripwire, sentinel].map((part) => `"${part.replaceAll("\\", "/")}"`).join(" ");
  const sentinels = ["filter", "fsmonitor", "textconv", "shim"].map((name) => path.join(root, `${name}-ran`));
  const [filter, fsmonitor, textconv, shim] = sentinels;

  git(project, "init", "--quiet", "--initial-branch=main");
  for (const file of ["modified.txt", "deleted.txt", "renamed.txt"]) writeFileSync(path.join(project, file), `${file}\n`);
  writeFileSync(path.join(project, ".gitattributes"), "*.txt filter=tripwire diff=tripwire\n");
  for (const name of ["git.cmd", "git.bat", "git.exe"]) writeFileSync(path.join(project, name), `@echo off\r\n"${process.execPath}" "${tripwire}" "${shim}"\r\n`);
  git(project, "add", ".");
  git(project, "commit", "--quiet", "-m", "baseline");
  writeFileSync(path.join(project, "modified.txt"), "changed\n");
  unlinkSync(path.join(project, "deleted.txt"));
  git(project, "mv", "renamed.txt", "moved.txt");
  writeFileSync(path.join(project, "added.txt"), "new\n");

  // Installed last: fixture Git itself would run these.
  git(project, "config", "filter.tripwire.clean", command(filter));
  git(project, "config", "filter.tripwire.smudge", command(filter));
  git(project, "config", "core.fsmonitor", command(fsmonitor));
  git(project, "config", "diff.tripwire.textconv", command(textconv));
  return { root, project, alternate, outside, sentinels };
}

/** Puts the repository's shims first on PATH and selects another repository, as a hostile shell profile could. */
function hostileEnvironment(t: TestContext, repository: HostileRepository): void {
  const saved = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.PATH = `${repository.project}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.GIT_DIR = path.join(repository.alternate, ".git");
  process.env.GIT_WORK_TREE = repository.alternate;
}

test("the footer counts a hostile repository's changes without running its filters, monitors, or shims", async (t) => {
  const repository = hostileRepository(t);
  hostileEnvironment(t, repository);
  // modified.txt and the rename (same blob, new path) are modified, added.txt is added, and deleted.txt is deleted.
  assert.deepEqual(await resolveGitFileChanges(repository.project), { modified: 2, added: 1, deleted: 1 });
  assert.deepEqual(repository.sentinels.filter(existsSync).map((file) => path.basename(file)), [],
    "Repository-owned filters, fsmonitor, textconv, and Git shims never run");
});

test("an inherited GIT_DIR cannot make a non-repository directory report another repository's changes", async (t) => {
  const repository = hostileRepository(t);
  hostileEnvironment(t, repository);
  assert.equal(await resolveGitFileChanges(repository.outside), undefined, "A directory outside every repository has no Git status");
  assert.deepEqual(repository.sentinels.filter(existsSync), []);
});

test("an untrusted project starts no Git process", async (t) => {
  const repository = hostileRepository(t);
  const started: string[][] = [];
  // The scan swallows executor errors, so the spy records calls instead of throwing.
  const execute = (_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void): void => {
    started.push(args);
    callback(new Error("recorded"), "");
  };
  assert.equal(await resolveGitFileChanges(repository.project, execute, false), undefined);
  assert.deepEqual(started, [], "An untrusted project must not start Git");
});
