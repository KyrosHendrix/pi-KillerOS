import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hostFiles, hostTests, moduleTests, selectTests } from "../scripts/test-changed.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const modules = readdirSync(new URL("../killeros/", import.meta.url)).filter((file) => file.endsWith(".ts")).sort();
const testFiles = readdirSync(new URL("./", import.meta.url)).filter((file) => /\.test\.[cm]?ts$/u.test(file)).map((file) => `test/${file}`).sort();

test("changed-test selection maps every KillerOS module to existing tests", () => {
  assert.deepEqual(Object.keys(moduleTests).sort(), modules, "Every module needs an entry, and every entry a module");
  for (const file of [...Object.values(moduleTests).flat(), ...hostTests]) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} must exist`);
  for (const module of modules) {
    const selected = selectTests([`killeros/${module}`]).filter((file) => file !== "test/RepositoryContracts.test.ts");
    assert.ok(selected.length > 0, `killeros/${module} must select at least one runtime test`);
  }
});

test("every test file is selected by a change to the code it covers", () => {
  // Support files are excluded: every scenario imports a Pi driver, which would make any test look mapped.
  const sources = [
    ...modules.map((module) => `killeros/${module}`), ...hostFiles,
    "scripts/verify-release.ts", "scripts/release-notes.ts", "scripts/test-changed.ts", "scripts/test-shard.ts", "themes/killeros.json",
  ];
  const reachable = new Set(sources.flatMap((source) => selectTests([source])));
  // These cover the test drivers themselves and are selected when test/support changes.
  const harnessTests = ["test/PiRpcControls.test.ts", "test/PiTerminalControls.test.ts", "test/ScenarioFailure.test.ts"];
  assert.deepEqual(testFiles.filter((file) => !reachable.has(file)), harnessTests, "Map new tests in scripts/test-changed.ts");
  for (const file of harnessTests) assert.ok(readdirSync(new URL("./support/", import.meta.url)).some((support) => selectTests([`test/support/${support}`]).includes(file)), file);
});

test("changed-test selection follows importers, support files, host files, and path references", () => {
  // safe-terminal-text has no owner tests of its own; every module that renders text imports it.
  const shared = selectTests(["killeros/safe-terminal-text.ts"]);
  for (const file of ["test/Question.e2e.test.ts", "test/Footer.e2e.test.ts", "test/Handoff.e2e.test.ts"]) assert.ok(shared.includes(file), file);
  // bounded-text is imported by goal-interface and question, so their tests cover it too.
  const bounded = selectTests(["killeros/bounded-text.ts"]);
  for (const file of ["test/BoundedText.e2e.test.ts", "test/Goals.e2e.test.ts", "test/Question.e2e.test.ts"]) assert.ok(bounded.includes(file), file);
  assert.ok(!bounded.includes("test/Footer.e2e.test.ts"), "A module must not select tests of code that does not import it");
  // No other module imports codex-fast.
  assert.deepEqual(selectTests(["killeros/codex-fast.ts"]), ["test/RepositoryContracts.test.ts", "test/runtime-fast.e2e.test.ts"]);

  // JitiCache is imported by both Pi drivers, so terminal and RPC scenarios depend on it.
  const cache = selectTests(["test/support/JitiCache.ts"]);
  for (const file of ["test/Footer.e2e.test.ts", "test/Goals.e2e.test.ts", "test/PiRpcControls.test.ts"]) assert.ok(cache.includes(file), file);

  assert.ok(selectTests(["package.json"]).includes("test/PiExtensionContract.test.ts"));
  assert.ok(selectTests(["scripts/verify-release.ts"]).includes("test/verify-release.test.ts"));
  // Built from parts: a literal path here would make this file one of the tests that name it.
  assert.deepEqual(selectTests([[".github", "workflows", "ci.yml"].join("/")]), ["test/RepositoryContracts.test.ts"]);
  assert.ok(selectTests(["README.md"]).includes("test/runtime-package.e2e.test.ts"), "Packaging tests read the README");
  assert.deepEqual(selectTests(["test/Theme.test.ts"]), ["test/RepositoryContracts.test.ts", "test/Theme.test.ts"]);
});

test("test:changed dry run prints the selection without running it", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/test-changed.ts", "--dry-run", "killeros/codex-fast.ts"],
    { cwd: root, encoding: "utf8" });
  assert.match(output, /1 changed path\(s\) select 2 test file\(s\):/u);
  assert.match(output, /test\/runtime-fast\.e2e\.test\.ts/u);
  assert.doesNotMatch(output, /^ℹ tests/mu, "A dry run must not start the test runner");
});
