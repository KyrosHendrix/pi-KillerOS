import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { removeDirectoryEventually } from "./FileCleanup.ts";
import { repositoryRoot, ReceiptGitProvider, createFamily, git, initRepository, writeProviderConfig, fileSummary, runTurns } from "./ReceiptGitScenario.ts";

const autoCrlf: unknown = workerData;
assert.ok(autoCrlf === "false" || autoCrlf === "true" || autoCrlf === "input");
assert.ok(parentPort);
const port = parentPort;
const controller = new AbortController();
port.on("message", (message: unknown) => { if (message === "abort") controller.abort(); });
const signal = controller.signal;
  const contents = new Map([
    ["lf", "one\ntwo\n"], ["crlf", "one\r\ntwo\r\n"], ["mixed", "one\r\ntwo\n"],
    ["no-final-newline", "one\r\ntwo"], ["empty", ""], ["lone-cr", "one\rtwo\r\n"],
    ["nul", "one\0\r\ntwo\r\n"], ["controls", "\x01one\r\ntwo\r\n"], ["terminal-eof", "one\r\ntwo\r\n\x1a"],
  ]);
  const rewrites = new Map([...contents, ["edit", "one\r\nchanged\r\n"]]);
  const attributes = ["", "* text=auto", "* text=auto eol=lf", "* text=auto eol=crlf", "* eol=lf", "* text", "* -text", "* binary",
    "* text=auto eol=lf\noverride-* -text", "* -text\noverride-* eol=lf !text"];

const result = await (async () => {
    const family = createFamily(repositoryRoot, `conversion-${autoCrlf}`);
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
        for (const [indexed, initial] of contents) for (const [working, content] of new Map([["same", initial], ...rewrites])) {
          for (const prefix of ["default", "override"]) {
            const file = `${directory}/${prefix}-${indexed}-${working}.txt`;
            cases.push({ file, initial, content });
            writeFileSync(path.join(family.project, file), initial);
          }
        }
      }
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
      // responses so every original oracle comparison remains visible without scanning 1,980 files per turn.
      const batches: Array<typeof cases> = [];
      let batch: typeof cases = [];
      let changed = 0;
      for (const row of cases) {
        if (expected.has(row.file) && changed === 20) { batches.push(batch); batch = []; changed = 0; }
        batch.push(row);
        if (expected.has(row.file)) changed++;
      }
      if (batch.length) batches.push(batch);
      const prepare = (batch: typeof cases): void => {
        for (const row of batch) writeFileSync(path.join(family.project, row.file), row.initial);
        git(family.project, "add", "-A");
        git(family.project, "commit", "-q", "-m", "next conversion baseline");
      };
      prepare(batches[0] ?? []);
      const port = await provider.listen();
      // This matrix observes durable receipts; regular mode avoids fullscreen transcript redraws.
      writeProviderConfig(family.agent, port, "regular");
      await runTurns({ family, provider, signal, uniqueSettlement: true, turns: batches.map((batch, index) => ({
        label: `Conversion ${autoCrlf} batch ${index}`, step: { kind: "text", content: `Conversion ${autoCrlf} batch ${index} response.` },
        doneWhen: screen => screen.includes(`Conversion ${autoCrlf} batch ${index} response.`),
        mutate: () => { for (const row of batch) { writeFileSync(path.join(family.project, row.file), row.content); utimesSync(path.join(family.project, row.file), new Date(0), new Date(0)); } },
        verify: receipt => {
          const summary = fileSummary(receipt.changes);
          assert.equal(summary.state, "available", `${autoCrlf}/${index}`);
          const names = batch.filter(row => expected.has(row.file)).map(row => row.file).sort();
          assert.deepEqual(summary.files.map(file => file.path), names, `${autoCrlf}/${index}: every original path agrees with Git`);
          assert.equal(summary.totalFiles, names.length);
          const next = batches[index + 1];
          if (next) {
            for (const row of batch) rmSync(path.join(family.project, row.file));
            prepare(next);
          }
        },
      })) });
      assert.equal(provider.requests.length, batches.length);
      return { inputs: cases.length, turns: batches.length };
    } finally {
      await provider.close();
      await removeDirectoryEventually(family.directory);
    }
})();
port.postMessage(result);
port.close();
