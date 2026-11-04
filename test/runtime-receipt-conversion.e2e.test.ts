import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { removeDirectoryEventually } from "./support/FileCleanup.ts";
import { repositoryRoot, ReceiptGitProvider, createFamily, git, initRepository, writeProviderConfig, fileSummary, runTurns } from "./support/ReceiptGitScenario.ts";

const contents = new Map([
  ["lf", "one\ntwo\n"], ["crlf", "one\r\ntwo\r\n"], ["mixed", "one\r\ntwo\n"],
  ["no-final-newline", "one\r\ntwo"], ["empty", ""], ["lone-cr", "one\rtwo\r\n"],
  ["nul", "one\0\r\ntwo\r\n"], ["controls", "\x01one\r\ntwo\r\n"], ["terminal-eof", "one\r\ntwo\r\n\x1a"],
]);
const rewrites = new Map([...contents, ["edit", "one\r\nchanged\r\n"]]);
const attributes = ["", "* text=auto", "* text=auto eol=lf", "* text=auto eol=crlf", "* eol=lf", "* text", "* -text", "* binary",
  "* text=auto eol=lf\noverride-* -text", "* -text\noverride-* eol=lf !text"];

/**
 * Each autocrlf mode's batches are dealt across this many tests, so the scheduler can run them in parallel.
 * Batches are independent: each starts from its own committed baseline, so a part runs only its own batches.
 */
const parts = 3;

for (const autoCrlf of ["false", "true", "input"] as const) for (let part = 0; part < parts; part++) {
  test(`native receipt paths agree with Git across the conversion matrix (autocrlf ${autoCrlf}, part ${part + 1}/${parts})`, { timeout: 300_000 }, async t => {
    const family = createFamily(repositoryRoot, `conversion-${autoCrlf}-${part}`);
    const provider = new ReceiptGitProvider();
    try {
      initRepository(family.project);
      git(family.project, "config", "core.autocrlf", autoCrlf);
      git(family.project, "config", "core.safecrlf", "false");
      const cases: Array<{ file: string; initial: string; content: string }> = [];
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
            cases.push({ file, initial, content });
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
      for (const row of cases) writeFileSync(path.join(family.project, row.file), row.content);
      const oracle = execFileSync("git", ["hash-object", "--stdin-paths"], { cwd: family.project,
        input: cases.map(row => row.file).join("\n") + "\n", encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
        .trim().split("\n");
      assert.equal(oracle.length, cases.length);
      const expected = new Set(cases.filter((row, index) => oracle[index] !== indexIds.get(row.file)).map(row => row.file));
      for (const row of cases) rmSync(path.join(family.project, row.file));
      // Each response retains at most twenty paths. Commit the next small baseline between
      // responses so every original oracle comparison remains visible without scanning 1,188 files per turn.
      const batches: Array<typeof cases> = [];
      let batch: typeof cases = [];
      let changed = 0;
      for (const row of cases) {
        if (expected.has(row.file) && changed === 20) { batches.push(batch); batch = []; changed = 0; }
        batch.push(row);
        if (expected.has(row.file)) changed++;
      }
      if (batch.length) batches.push(batch);
      assert.equal(batches.reduce((sum, rows) => sum + rows.length, 0), cases.length, "The batches cover every case once");
      const owned = batches.filter((_, index) => index % parts === part);
      const prepare = (rows: typeof cases): void => {
        for (const row of rows) writeFileSync(path.join(family.project, row.file), row.initial);
        git(family.project, "add", "-A");
        git(family.project, "commit", "-q", "-m", "next conversion baseline");
      };
      prepare(owned[0] ?? []);
      const port = await provider.listen();
      // This matrix observes durable receipts; regular mode avoids fullscreen transcript redraws.
      writeProviderConfig(family.agent, port, "regular");
      await runTurns({ family, provider, signal: t.signal, turns: owned.map((rows, index) => ({
        label: `Conversion ${autoCrlf} part ${part + 1} batch ${index}`, step: { kind: "text", content: `Conversion ${autoCrlf} part ${part + 1} batch ${index} response.` },
        doneWhen: screen => screen.includes(`Conversion ${autoCrlf} part ${part + 1} batch ${index} response.`),
        mutate: () => { for (const row of rows) { writeFileSync(path.join(family.project, row.file), row.content); utimesSync(path.join(family.project, row.file), new Date(0), new Date(0)); } },
        verify: receipt => {
          const summary = fileSummary(receipt.changes);
          assert.equal(summary.state, "available", `${autoCrlf}/${part}/${index}`);
          const names = rows.filter(row => expected.has(row.file)).map(row => row.file).sort();
          assert.deepEqual(summary.files.map(file => file.path), names, `${autoCrlf}/${part}/${index}: every original path agrees with Git`);
          assert.equal(summary.totalFiles, names.length);
          const next = owned[index + 1];
          if (next) {
            for (const row of rows) rmSync(path.join(family.project, row.file));
            prepare(next);
          }
        },
      })) });
      assert.equal(provider.requests.length, owned.length);
      t.diagnostic(JSON.stringify({ scenarioId: "runtime.receipt-conversion-matrix", autoCrlf, part: part + 1, parts, piLaunches: 1,
        providerRequests: owned.length, inputCases: owned.reduce((sum, rows) => sum + rows.length, 0),
        oracle: "actual Git hash-object for every path", cleanup: "natural" }));
    } finally {
      await provider.close();
      await removeDirectoryEventually(family.directory);
    }
  });
}
