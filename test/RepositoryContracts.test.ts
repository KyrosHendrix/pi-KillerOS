import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { Session } from "node:inspector";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING } from "../killeros/auto-compaction.ts";
import { lifecycles } from "../scripts/test-suite.ts";
import Killeros from "../Killeros.ts";

type PackageJson = {
  version: string;
  os: string[];
  engines: Record<string, string>;
  scripts: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

type TypeScriptConfig = {
  compilerOptions: { strict: true };
  include: string[];
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isUnknownRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isPackageJson(value: unknown): value is PackageJson {
  return (
    isUnknownRecord(value) &&
    typeof value.version === "string" &&
    Array.isArray(value.os) &&
    value.os.every((os) => typeof os === "string") &&
    isStringRecord(value.engines) &&
    isStringRecord(value.scripts) &&
    isStringRecord(value.peerDependencies) &&
    isStringRecord(value.devDependencies)
  );
}

function isTypeScriptConfig(value: unknown): value is TypeScriptConfig {
  return (
    isUnknownRecord(value) &&
    isUnknownRecord(value.compilerOptions) &&
    value.compilerOptions.strict === true &&
    Array.isArray(value.include) &&
    value.include.every((entry) => typeof entry === "string")
  );
}

const packageValue: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const tsconfigValue: unknown = JSON.parse(
  readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"),
);
assert.ok(isPackageJson(packageValue));
assert.ok(isTypeScriptConfig(tsconfigValue));
const packageJson = packageValue;
const tsconfig = tsconfigValue;
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf8",
);
const ci = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const release = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("peer ranges require the pinned Pi minimums and reject older and next-major versions", () => {
  assert.deepEqual(Object.keys(packageJson.peerDependencies).sort(), [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]);
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import semver from "semver";
    const { peerDependencies, devDependencies } = JSON.parse(readFileSync("package.json", "utf8"));
    for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
      const key = "@earendil-works/" + name;
      const minimum = devDependencies[key];
      assert.equal(semver.valid(minimum), minimum, key + " must have an exact development pin");
      assert.equal(semver.prerelease(minimum), null, key + " must use a stable release");
      const { major, minor, patch } = semver.parse(minimum);
      const ceiling = major + 1;
      const previous = patch > 0 ? major + "." + minor + "." + (patch - 1)
        : minor > 0 ? major + "." + (minor - 1) + ".999999" : (major - 1) + ".999999.999999";
      const range = peerDependencies[key];
      assert.equal(range, ">=" + minimum + " <" + ceiling, key);
      for (const [version, supported] of [[previous, false], [minimum + "-rc.1", false], [minimum, true], [major + ".999999.999999", true], [ceiling + ".0.0", false]]) {
        assert.equal(semver.satisfies(version, range), supported, key + "@" + version);
      }
    }
    const typeboxMinimum = semver.minVersion(peerDependencies.typebox);
    assert.ok(typeboxMinimum);
    assert.equal(semver.satisfies(devDependencies.typebox, peerDependencies.typebox), true);
    assert.equal(semver.satisfies("2.0.0", peerDependencies.typebox), false);
  `,
    ],
    { cwd: repositoryRoot, stdio: "pipe" },
  );
  const minimum =
    packageJson.devDependencies["@earendil-works/pi-coding-agent"];
  const ceiling = Number(minimum.split(".")[0]) + 1;
  assert.ok(readme.includes(`Pi ${minimum} or later below ${ceiling}.0.0`));
  assert.match(readme, /Users on older Node or Pi versions must upgrade/u);
});

test("unreleased notes state only the current Pi minimum", () => {
  const unreleased = changelog.split(/^## \[/mu)[1];
  assert.ok(unreleased?.startsWith("Unreleased]"));
  const minimums = [
    ...unreleased.matchAll(
      /minimum supported Pi version[^\n]*?to (\d+\.\d+\.\d+)/gu,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    minimums,
    minimums.length === 0
      ? []
      : [packageJson.devDependencies["@earendil-works/pi-coding-agent"]],
  );
});

test("public TUI guidance preserves Pi defaults and documents regular-mode scrollback", () => {
  assert.match(readme, /Pi defaults to fullscreen/u);
  assert.match(readme, /`--tui-mode regular`/u);
  assert.match(readme, /`"tuiMode": "regular"`/u);
  assert.match(readme, /terminal-owned scrollback/u);
  assert.match(
    readme,
    /KillerOS leaves Pi's `tuiMode` and `quietStartup` preferences unchanged/u,
  );
});

test("lockfile matches the exact Pi development pins", () => {
  const lock: unknown = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  assert.ok(isUnknownRecord(lock));
  assert.ok(isUnknownRecord(lock.packages));
  const root = lock.packages[""];
  assert.ok(isUnknownRecord(root));
  assert.deepEqual(root.devDependencies, packageJson.devDependencies);
  assert.deepEqual(root.peerDependencies, packageJson.peerDependencies);
  assert.deepEqual(root.os, packageJson.os);
  for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
    const lockedPackage: unknown =
      lock.packages[`node_modules/@earendil-works/${name}`];
    assert.ok(isUnknownRecord(lockedPackage));
    assert.equal(
      lockedPackage.version,
      packageJson.devDependencies[`@earendil-works/${name}`],
      name,
    );
  }
});

test("locked brace expansion bounds deeply nested patterns", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { expand } from "brace-expansion";
    import braceExpansion from "brace-expansion/package.json" with { type: "json" };

    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    assert.equal(braceExpansion.version, lock.packages["node_modules/brace-expansion"].version);

    const shallow = expand("{a,b}");
    assert.deepEqual(shallow, ["a", "b"]);

    const deepPattern = "{".repeat(10_000) + "a,b" + "}".repeat(10_000);
    const deep = expand(deepPattern);
    assert.ok(deep.length <= 2);
    assert.ok(deep.every((value) => value.length <= deepPattern.length));
    assert.ok(deep.reduce((length, value) => length + value.length, 0) <= deepPattern.length);
    process.stdout.write("ok");
  `,
    ],
    {
      cwd: repositoryRoot,
      env: {
        PATH: path.dirname(process.execPath),
        SystemRoot: process.env.SystemRoot,
      },
      maxBuffer: 1_024,
      timeout: 5_000,
      stdio: "pipe",
    },
  ).toString();
  assert.equal(output, "ok");
});

test("all shipped TypeScript entry points use strict checking", () => {
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.deepEqual(tsconfig.include, [
    "Killeros.ts",
    "scripts/**/*.ts",
    "test/**/*.ts",
  ]);
});

test("public compaction documentation states the configurable default", () => {
  assert.ok(
    readme
      .toLowerCase()
      .includes(
        `compaction triggers by default at ${DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING}% tokens remaining`,
      ),
  );
  assert.match(readme, /"autoCompaction"/u);
  assert.match(readme, /"enabled": true/u);
  assert.ok(
    readme.includes(
      `"percentRemaining": ${DEFAULT_AUTO_COMPACTION_PERCENT_REMAINING}`,
    ),
  );
});

test("Bun lint honors repository ignores and production restrictions", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "killeros-lint-"));
  try {
    copyFileSync(
      path.join(repositoryRoot, "bunfig.toml"),
      path.join(fixture, "bunfig.toml"),
    );
    writeFileSync(path.join(fixture, "clean.ts"), "export {};\n");
    for (const file of [
      ".pi/verification/probe.ts",
      "docs/probe.ts",
      "Killeros.ts",
      "killeros/probe.ts",
      "scripts/probe.ts",
      "test/probe.ts",
    ]) {
      mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
      writeFileSync(
        path.join(fixture, file),
        [
          'import { spawnSync } from "node:child_process";',
          'var command = "git".toLocaleLowerCase();',
          "export const result = command.toLocaleUpperCase();",
          "export { spawnSync };",
          "Promise.resolve(1);",
        ].join("\n"),
      );
    }
    const lint = (file: string) => {
      const result = spawnSync(
        "bun",
        [
          "lint",
          "--no-script",
          "--type-aware",
          "--max-warnings=0",
          "clean.ts",
          file,
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.ifError(result.error);
      return { status: result.status, output: result.stdout + result.stderr };
    };
    for (const file of [".pi/verification/probe.ts", "docs/probe.ts"]) {
      const { status, output } = lint(file);
      assert.equal(status, 0, output);
    }
    for (const file of [
      "Killeros.ts",
      "killeros/probe.ts",
      "scripts/probe.ts",
      "test/probe.ts",
    ]) {
      const { status, output } = lint(file);
      assert.equal(status, 1, output);
      assert.match(output, /no-var/u);
      if (file === "Killeros.ts" || file.startsWith("killeros/")) {
        assert.match(
          output,
          /no-restricted-imports.*spawnSync.*Start child processes asynchronously; a synchronous call freezes Pi's terminal\./u,
        );
        assert.deepEqual(
          [
            ...output.matchAll(/no-restricted-properties.*?'(toLocale\w+)'/gu),
          ].map(([, property]) => property),
          ["toLocaleLowerCase", "toLocaleUpperCase"],
        );
        assert.equal(
          output.split(
            "Use toLowerCase or toUpperCase; locale-aware casing changes identifiers in some locales.",
          ).length,
          3,
        );
      } else {
        assert.doesNotMatch(output, /no-restricted-(?:imports|properties)/u);
      }
      if (file.startsWith("test/")) {
        assert.doesNotMatch(output, /no-floating-promises/u);
      } else {
        assert.match(output, /no-floating-promises/u);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const codeql = readFileSync(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);
const testedTree = readFileSync(
  new URL("../.github/actions/tested-tree/action.yml", import.meta.url),
  "utf8",
);
const parallelJobs = [
  "typecheck",
  "lint",
  "format",
  "audit-and-release",
  "publication-lifecycle",
  "quality-tests",
  "pi-latest-check",
  "pi-latest-tests",
];

function ciJob(name: string) {
  const jobs = ci.slice(ci.search(/^jobs:\s*$/mu));
  const source = new RegExp(
    `^  ${name}:\\r?\\n(?:(?: {4,}.*)?\\r?\\n)*`,
    "mu",
  ).exec(jobs)?.[0];
  assert.ok(source, `CI must define ${name}`);
  return source;
}

test("CI, CodeQL, and releases pin remote actions and Node.js", () => {
  const nodeVersion = readFileSync(
    new URL("../.node-version", import.meta.url),
    "utf8",
  ).trim();
  assert.equal(nodeVersion, "26.13.0");
  assert.equal(packageJson.engines.node, `>=${nodeVersion} <27`);
  for (const workflow of [ci, codeql, release]) {
    const actions = [...workflow.matchAll(/^\s+uses: (\S+)/gmu)].map(
      (match) => match[1],
    );
    assert.ok(actions.length > 0);
    for (const action of actions) {
      if (!action.startsWith("./"))
        assert.match(action, /^[\w./-]+@[a-f0-9]{40}$/u);
    }
    const versions = [
      ...workflow.matchAll(/^          node-version: (.+)$/gmu),
    ].map((match) => match[1]);
    assert.equal(
      versions.length,
      actions.filter((action) => action.startsWith("actions/setup-node@"))
        .length,
    );
    for (const version of versions) assert.equal(version, `'${nodeVersion}'`);
    assert.match(workflow, /defaults:\s+run:\s+shell: bash/u);
    for (const checkout of workflow.matchAll(
      /uses: actions\/checkout@[^\n]+\n\s+with:\n(?: {10}[^\n]+\n)*/gu,
    )) {
      if (workflow !== release)
        assert.match(checkout[0], /persist-credentials: false/u);
    }
  }
  const triggers = (workflow: string) =>
    /^on:\r?\n[\s\S]+?(?=^\S)/mu.exec(workflow)?.[0];
  assert.ok(triggers(ci));
  assert.equal(
    triggers(codeql)?.replaceAll("\r\n", "\n"),
    triggers(ci)?.replaceAll("\r\n", "\n"),
  );
  assert.match(codeql, /security-events: write/u);
  assert.match(codeql, /^    name: CodeQL$/mu);
  assert.match(
    codeql,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
  );
  const codeqlActions = [
    ...codeql.matchAll(
      /uses: github\/codeql-action\/(init|analyze)@([a-f0-9]{40})/gu,
    ),
  ];
  assert.deepEqual(
    codeqlActions.map((match) => match[1]),
    ["init", "analyze"],
  );
  assert.equal(codeqlActions[0][2], codeqlActions[1][2]);
  assert.doesNotMatch(ci, /github\/codeql-action/u);
});

test("CI runs Bun quality jobs in parallel and aggregates their results", () => {
  const typecheck = "bun check --no-script";
  const lint = "bun lint --no-script --type-aware --max-warnings=0 .";
  const format = "bun fmt --no-script --check";
  assert.equal(
    packageJson.scripts.check,
    [typecheck, lint, format].join(" && "),
  );
  assert.equal(packageJson.scripts.test, "bun scripts/test-suite.ts");
  assert.equal(
    packageJson.scripts["test:changed"],
    "bun scripts/test-changed.ts",
  );
  const jobs = ci.slice(ci.search(/^jobs:\s*$/mu));
  assert.deepEqual(
    [...jobs.matchAll(/^  ([\w-]+):$/gmu)].map((match) => match[1]),
    ["plan", ...parallelJobs, "quality"],
  );
  const gate = ciJob("quality");
  assert.match(gate, /^    name: Quality$/mu);
  assert.match(gate, /^    if: always\(\)$/mu);
  assert.ok(gate.includes(`needs: [plan, ${parallelJobs.join(", ")}]`));
  assert.ok(gate.includes('test "$PLAN_RESULT" = success'));
  for (const job of parallelJobs) {
    const source = ciJob(job);
    assert.match(source, /^    needs: plan$/mu);
    if (job !== "pi-latest-check")
      assert.match(source, /needs\.plan\.outputs\.skip == 'false'/u);
    const windows = [
      "publication-lifecycle",
      "quality-tests",
      "pi-latest-tests",
    ].includes(job);
    assert.ok(
      source.includes(`runs-on: ${windows ? "windows" : "ubuntu"}-latest`),
    );
    const result = `${job.replaceAll("-", "_").toUpperCase()}_RESULT`;
    assert.ok(gate.includes(`${result}: ${"$"}{{ needs.${job}.result }}`));
    assert.ok(gate.includes(`"$${result}"`));
    if (job === "pi-latest-tests")
      assert.match(
        source,
        /^    if: .*needs\.plan\.outputs\.pi-latest-full-suite == 'true'/mu,
      );
    if (job.startsWith("pi-latest")) {
      assert.match(
        source,
        /npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false/u,
      );
    }
  }
  for (const job of [
    "typecheck",
    "lint",
    "quality-tests",
    "pi-latest-check",
    "pi-latest-tests",
  ]) {
    const source = ciJob(job);
    assert.match(source, /bun-version: canary/u);
    assert.match(source, /uses: actions\/cache@[a-f0-9]{40}/u);
    assert.match(source, /path: ~\/\.bun\/install\/cache/u);
    assert.match(source, /bun install --frozen-lockfile --ignore-scripts/u);
    assert.match(
      source,
      /git diff --exit-code -- package\.json package-lock\.json/u,
    );
  }
  assert.ok(ciJob("typecheck").includes(`run: ${typecheck}`));
  assert.ok(ciJob("lint").includes(`run: ${lint}`));
  assert.ok(ciJob("format").includes(`run: ${format}`));
  const latest = ciJob("pi-latest-check").replaceAll("\r\n", "\n");
  assert.match(latest, /^    name: Pi compatibility \(latest\)$/mu);
  assert.match(latest, /^    if: needs\.plan\.outputs\.skip != 'true'$/mu);
  assert.match(
    latest,
    /Verify resolved Pi packages match the lockfile\s+if: needs\.plan\.outputs\.pi-latest-full-suite == 'false'[\s\S]+package-lock\.json/u,
  );
  for (const step of [
    "Set up Node.js",
    "Set up Bun",
    "Cache Bun packages",
    "Install locked dependencies",
    "Install matched Pi packages",
    "Verify package files are unchanged",
    "Type check and lint against matched Pi",
  ]) {
    assert.ok(
      latest.includes(
        `- name: ${step}\n        if: needs.plan.outputs.pi-latest-full-suite == 'true'`,
      ),
      step,
    );
  }
  assert.match(gate, /true\)\s+expected=skipped/u);
  assert.match(gate, /false\)\s+expected=success/u);
  assert.match(gate, /test "\$PI_LATEST_CHECK_RESULT" = "\$expected"/u);
  assert.match(gate, /test "\$PI_LATEST_TESTS_RESULT" = "\$latest"/u);
  assert.ok(latest.includes(`${typecheck} &`));
  assert.ok(latest.includes(`${lint} &`));
  assert.match(
    latest,
    /wait "\$check_pid" \|\| status=1\s+wait "\$lint_pid" \|\| status=1\s+exit "\$status"/u,
  );
  assert.match(
    ciJob("audit-and-release"),
    /npm audit --audit-level=moderate --package-lock-only --ignore-scripts --no-fund/u,
  );
  for (const job of ["format", "audit-and-release", "publication-lifecycle"]) {
    assert.doesNotMatch(ciJob(job), /bun install|npm ci/u);
  }
});

test("planned shards use reachable PR tests and repeat the full suite for matched newer Pi", () => {
  const plan = ciJob("plan");
  assert.match(plan, /fetch-depth: 2/u);
  assert.match(plan, /bun-version: canary/u);
  const caps =
    /max_shards=(\d+)\s+if \[\[ "\$PI_LATEST_FULL_SUITE" == true \]\]; then\s+max_shards=(\d+)\s+fi/u.exec(
      plan,
    );
  assert.ok(caps);
  const lockedCap = Number(caps[1]);
  const compatibilityCap = Number(caps[2]);
  assert.equal(lockedCap, 12);
  assert.equal(compatibilityCap, 7);
  const nonMatrixJobs = parallelJobs.filter(
    (job) => !ciJob(job).includes("    strategy:"),
  ).length;
  assert.ok(nonMatrixJobs + lockedCap <= 20);
  assert.ok(nonMatrixJobs + compatibilityCap * 2 <= 20);
  assert.match(
    plan,
    /--ci-plan --diff-base HEAD\^1 --diff-head HEAD --max-shards "\$max_shards" --target-shard-seconds 22 --concurrency 2 --lifecycle-repeats 2/u,
  );
  assert.match(
    plan,
    /--ci-plan --full --max-shards "\$max_shards" --target-shard-seconds 22 --concurrency 2 --lifecycle-repeats 2[^\n]+write_plan ""/u,
  );
  assert.match(
    plan,
    /--ci-plan --full --max-shards "\$max_shards" --target-shard-seconds 22 --concurrency 2 --lifecycle-repeats 2[^\n]+write_plan pi-latest-/u,
  );
  const target = /^          PI_TARGET: '([^']+)'$/mu.exec(plan)?.[1];
  assert.equal(
    target,
    packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
  );
  assert.equal((ci.match(/npm view /gu) ?? []).length, 1);
  assert.match(
    plan,
    /npm view "@earendil-works\/pi-coding-agent@\$PI_TARGET" version dependencies --json/u,
  );
  for (const name of Object.keys(packageJson.peerDependencies))
    assert.ok(plan.includes(`"${name}":`));
  assert.match(
    plan,
    /version !== locked\["node_modules\/" \+ name\]\?\.version/u,
  );
  for (const [job, prefix] of [
    ["quality-tests", ""],
    ["pi-latest-tests", "pi-latest-"],
  ]) {
    const source = ciJob(job);
    for (const output of [
      "files",
      "lifecycles",
      "shard-count",
      "shards",
      "concurrency",
      "lifecycle-repeats",
    ]) {
      assert.ok(source.includes(`needs.plan.outputs.${prefix}${output}`));
    }
    assert.ok(source.includes(`fromJSON(needs.plan.outputs.${prefix}shards)`));
    assert.match(source, /bun scripts\/test-suite\.ts --shard /u);
    assert.match(
      source,
      /--files="\$TEST_FILES" --lifecycles="\$TEST_LIFECYCLES"/u,
    );
    assert.match(source, /--target-shard-seconds 22/u);
    assert.match(
      source,
      /if: failure\(\)\s+uses: actions\/upload-artifact@[a-f0-9]{40}/u,
    );
    assert.match(
      source,
      /path: node_modules\/\.killeros-\*\/failure\.txt\s+include-hidden-files: true/u,
    );
  }
  const cancellation = lifecycles.find(
    (lifecycle) => lifecycle.name === "Pi cancellation",
  );
  assert.ok(cancellation);
  for (const [file, title] of [
    [
      "Goals.e2e.test.ts",
      "continuation dispatch respects idle, pending, and cancellation gates",
    ],
    [
      "runtime-native-provider.e2e.test.ts",
      "active faux provider retries preserve goal ownership until settlement",
    ],
    [
      "CompactionTrigger.e2e.test.ts",
      "Cancelled ordinary and goal compaction cannot recover after an aborted settlement",
    ],
  ]) {
    assert.ok(cancellation.pattern.split("|").includes(title));
    assert.ok(cancellation.files.some((path) => path === `test/${file}`));
    assert.ok(
      [
        ...readFileSync(new URL(`./${file}`, import.meta.url), "utf8").matchAll(
          /\btest\(\s*"([^"]+)"/gu,
        ),
      ].some(([, name]) => name === title),
    );
  }
});

test("main reuses only successful same-repository PR runs with a matching full coverage artifact", () => {
  const plan = ciJob("plan");
  assert.match(
    plan,
    /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\s+continue-on-error: true\s+uses: \.\/\.github\/actions\/tested-tree/u,
  );
  assert.match(plan, /pi-packages: \$\{\{ steps\.pi\.outputs\.packages \}\}/u);
  assert.match(
    plan,
    /steps\.tested\.outcome == 'success' && steps\.tested\.outputs\.skip == 'true'/u,
  );
  const gate = ciJob("quality");
  assert.equal((ci.match(/name: tested-full-tree-v2-/gu) ?? []).length, 1);
  assert.match(
    gate,
    /id: proof\s+if: >-\s+success\(\) &&\s+github\.event_name == 'pull_request' &&\s+github\.base_ref == 'main' &&\s+github\.event\.pull_request\.head\.repo\.full_name == github\.repository &&\s+needs\.plan\.outputs\.full-suite == 'true'/u,
  );
  assert.match(
    gate,
    /if: steps\.proof\.outcome == 'success'\s+uses: actions\/upload-artifact@[a-f0-9]{40}/u,
  );
  assert.match(
    gate,
    /\{version: 2, tree: \$tree, fullSuite: true, piPackages: \$piPackages\}/u,
  );
  assert.match(
    gate,
    /name: tested-full-tree-v2-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ needs\.plan\.outputs\.tree \}\}/u,
  );
  assert.match(
    testedTree,
    /merge_commit_sha[^\n]+head\.repo\.full_name[^\n]+head\.sha/u,
  );
  assert.match(
    testedTree,
    /event=pull_request&status=success[^\n]+head_repository\.full_name/u,
  );
  assert.match(testedTree, /name="tested-full-tree-v2-\$pr-\$attempt-\$tree"/u);
  assert.match(testedTree, /gh run download "\$run"[^\n]+--name "\$name"/u);
  assert.match(
    testedTree,
    /\.version == 2 and\s+\.fullSuite == true and \.tree == \$tree and \.piPackages == \$piPackages/u,
  );
  assert.doesNotMatch(testedTree, /name="tested-tree-/u);
});

test("quality checks validate current metadata and test the release-pinned npm lifecycle", () => {
  const auditJob = ciJob("audit-and-release");
  const qualityJob = ciJob("publication-lifecycle");
  assert.match(
    auditJob,
    /- name: Validate release metadata\s+env:\s+KILLEROS_RELEASE: 'true'\s+run: node --experimental-strip-types scripts\/verify-release\.ts/u,
  );
  assert.equal((auditJob.match(/KILLEROS_RELEASE:/gu) ?? []).length, 1);
  assert.doesNotMatch(ci.split("jobs:")[0], /KILLEROS_RELEASE/u);
  assert.doesNotMatch(auditJob.split("steps:")[0], /KILLEROS_RELEASE/u);
  const publishingNpm = /npm install --global npm@(\d+\.\d+\.\d+)/u.exec(
    release,
  )?.[1];
  assert.ok(publishingNpm);
  assert.match(release, /npm prefix --global >> "\$GITHUB_PATH"/u);
  assert.ok(qualityJob.includes(`npm@${publishingNpm}`));
  assert.match(
    qualityJob,
    /- name: Provision publishing npm\s+run: \|\s+mkdir -p node_modules\s+npm install/u,
  );
  assert.match(
    qualityJob,
    /npm install --prefix "\$RUNNER_TEMP\/killeros-publishing-npm" --ignore-scripts --no-audit --no-fund --no-package-lock --no-save npm@/u,
  );
  assert.match(
    qualityJob,
    /- name: Test publication lifecycle with publishing npm\s+env:\s+KILLEROS_TEST_NPM_CLI: \$\{\{ runner\.temp \}\}\/killeros-publishing-npm\/node_modules\/npm\/bin\/npm-cli\.js\s+run: node --test --test-force-exit --experimental-strip-types --test-name-pattern="publication lifecycle" test\/verify-release\.test\.ts/u,
  );
  assert.doesNotMatch(qualityJob, /npm install --global/u);
  const lifecycleTests = readFileSync(
    new URL("./verify-release.test.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    lifecycleTests,
    /\btest\(\s*"publication lifecycle /u,
    "The pinned-npm entry point must select a retained test",
  );
});

function assertPublicationBoundary(workflow: string): void {
  const publishStep =
    /      - name: Publish package to npm\r?\n[\s\S]*?(?=\r?\n      - name:)/u.exec(
      workflow,
    )?.[0];
  assert.ok(publishStep);
  assert.match(
    publishStep,
    /if: steps\.metadata\.outputs\.publish_npm == 'true'/u,
  );
  assert.match(publishStep, /env:\s+KILLEROS_RELEASE: 'true'/u);
  assert.match(publishStep, /run: npm publish \. --ignore-scripts=false\s*$/u);
  assert.doesNotMatch(publishStep, /scripts\/verify-release\.ts/u);
}

test("publication boundary requires directory publication with lifecycle scripts explicitly enabled", () => {
  assertPublicationBoundary(release);
  for (const command of [
    "npm publish",
    "npm publish .",
    "npm publish killeros.tgz --ignore-scripts=false",
    "npm publish . --ignore-scripts=true",
  ]) {
    const invalid = release.replace(
      "npm publish . --ignore-scripts=false",
      command,
    );
    assert.throws(() => assertPublicationBoundary(invalid), command);
  }
});

test("GitHub releases require green current main and consistent package provenance", () => {
  assert.match(release, /workflow_run:/u);
  assert.match(
    release,
    /workflows: \[CI, CodeQL\]\s+types: \[completed\]\s+branches: \[main\]/u,
  );
  assert.match(
    release,
    /^    if: github\.event\.workflow_run\.event == 'push' && github\.event\.workflow_run\.conclusion == 'success'$/mu,
  );
  assert.match(release, /github\.event\.workflow_run\.head_sha/u);
  assert.match(release, /git fetch --no-tags origin main/u);
  assert.match(release, /CURRENT_MAIN=.*origin\/main/u);
  assert.match(release, /Verified commit .* is stale/u);
  const gate =
    /for workflow in ci\.yml codeql\.yml; do[\s\S]+?echo "publish=true"/u.exec(
      release,
    )?.[0];
  assert.ok(gate);
  assert.match(release, /actions: read/u);
  assert.match(release, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(
    gate,
    /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$workflow\/runs"[^\n]+\n\s+-f branch=main -f event=push -f head_sha="\$SHA"/u,
  );
  assert.match(gate, /"\$run_sha" != "\$SHA" \|\| "\$run_branch" != main/u);
  assert.match(
    gate,
    /"\$status" != completed[\s\S]+?pending=true[\s\S]+?"\$conclusion" != success[\s\S]+?exit 1/u,
  );
  assert.match(
    gate,
    /if \[\[ "\$pending" == true \]\]; then\s+echo "publish=false" >> "\$GITHUB_OUTPUT"\s+exit 0/u,
  );
  assert.match(release, /PREVIOUS_VERSION.*VERSION/su);
  assert.match(release, /packageJson\.version !== packageLock\.version/u);
  assert.match(release, /scripts\/release-notes\.ts CHANGELOG\.md/u);
  assert.match(release, /> "\$RUNNER_TEMP\/killeros-release-notes\.md"/u);
  assert.match(
    release,
    /--notes-file "\$RUNNER_TEMP\/killeros-release-notes\.md"/u,
  );
  assert.match(release, /Existing tag.*verified commit/u);
  assert.match(release, /git ls-remote[^\n]+\|\| TAG_LOOKUP_STATUS=\$\?/u);
  assert.match(
    release,
    /TAG_LOOKUP_STATUS != 2[\s\S]+exit "\$TAG_LOOKUP_STATUS"/u,
  );
  assert.doesNotMatch(release, /push:\s*\n\s*tags:/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" version/u);
  assert.match(release, /npm view "killeros@\$\{VERSION\}" gitHead/u);
  assert.match(release, /npm package.*verified commit/u);
  assert.match(release, /publish_npm/u);
  assert.equal(
    packageJson.scripts.prepublishOnly,
    "node --experimental-strip-types scripts/verify-release.ts",
  );
  assert.match(release, /KILLEROS_RELEASE: 'true'/u);
  assertPublicationBoundary(release);
  assert.ok(
    release.indexOf("Existing tag") <
      release.indexOf("- name: Publish package to npm"),
  );
  assert.match(
    release,
    /sync-dev:\s+name: Sync main back into dev\s+needs: release/su,
  );
  assert.match(
    release,
    /publish:\s+\$\{\{ steps\.metadata\.outputs\.publish \}\}/u,
  );
  assert.match(
    release,
    /if: needs\.release\.result == 'success' && needs\.release\.outputs\.publish == 'true'/u,
  );
  assert.match(release, /MAIN_SHA:.*workflow_run\.head_sha/u);
  assert.match(release, /git merge-base --is-ancestor "\$MAIN_SHA" HEAD/u);
  assert.match(release, /git merge --ff-only "\$MAIN_SHA"/u);
  assert.match(release, /refs\/heads\/dev/u);
  assert.match(
    readme,
    /CI and CodeQL must both pass for the same commit on `main` before publication/u,
  );
  assert.match(readme, /do not push version tags manually/iu);
});

test("public README documents current requirements and commands", () => {
  assert.deepEqual(packageJson.os, ["win32"]);
  assert.match(readme, /KillerOS supports Windows only/u);
  const escapedVersion = packageJson.version.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  assert.match(readme, new RegExp(`@v${escapedVersion}`, "u"));
  const nodeVersion = readFileSync(
    new URL("../.node-version", import.meta.url),
    "utf8",
  ).trim();
  assert.ok(readme.includes(`Node.js ${nodeVersion} or later within Node 26`));
  assert.match(readme, /\/goal <objective>/u);
  assert.match(readme, /^\/goal edit/mu);
  assert.match(readme, /^\/goal pause/mu);
  assert.match(readme, /^\/goal resume/mu);
  assert.match(readme, /^\/goal clear/mu);
  for (const command of [
    "codex-fast",
    "notification",
    "handoff",
    "new",
    "exit",
  ] as const) {
    assert.match(readme, new RegExp(`^/${command}(?:\\s|$)`, "mu"));
  }
  assert.match(readme, /^\/handoff \[focus\]/mu);
  assert.match(readme, /off by default/iu);
  assert.match(readme, /Nerd Font/iu);
  assert.match(readme, /settled.*token usage/iu);
  assert.match(readme, /question.*single-select and multi-select/iu);
});

test("public guidance uses Pi's native sampling and project MCP settings", () => {
  assert.match(readme, /samplingParamsByThinkingLevel/u);
  assert.match(readme, /\/thinking/u);
  assert.match(readme, /models\.md#configure-sampling-by-thinking-level/u);
  assert.match(readme, /\.pi\/mcp\.json/u);
  assert.match(readme, /mcp\.md#configure-servers/u);
  assert.match(readme, /trusted project/iu);
});

test("public guidance documents native wildcard filtering, image reads, and MCP selection", () => {
  assert.match(
    readme,
    /Pi's native `--tools` and `--exclude-tools` support `\*` patterns/u,
  );
  assert.match(readme, /Quote patterns .*shell does not expand them/u);
  assert.match(
    readme,
    /allowlist must include `question`.*permit `killeros_goal_update`/u,
  );
  assert.match(readme, /Excluding the goal tool pauses goals/u);
  assert.match(readme, /cli\.md#tools/u);
  assert.match(
    readme,
    /Pi codemode.*`tools\.read\(\)`.*image block.*`image\(\)`/u,
  );
  assert.match(
    readme,
    /nonempty `--tools` list with no `mcp__` entry preserves MCP tool availability/u,
  );
  assert.match(readme, /`--tools codemode` does not disable MCP connections/u);
  assert.match(readme, /Use `--no-mcp` to disable MCP connections/u);
  assert.match(readme, /mcp\.md#control-tool-exposure/u);
});

test("agent_settled handlers run receipt, goal settlement, activity, sound, then project hooks", () => {
  const handlers: unknown[] = [];
  const host: unknown = new Proxy(() => undefined, {
    get: (_target, key) =>
      key === "on"
        ? (event: string, handler: unknown) => {
            if (event === "agent_settled") handlers.push(handler);
          }
        : host,
    apply: () => host,
  });
  Killeros(host as ExtensionAPI);

  const session = new Session();
  const scripts = new Map<string, string>();
  session.on("Debugger.scriptParsed", ({ params }) =>
    scripts.set(params.scriptId, params.url),
  );
  session.connect();
  const probe = Symbol.for("killeros.settled-handler");
  try {
    session.post("Debugger.enable");

    const definingModule = (objectId: string): string | undefined => {
      let module: string | undefined;
      session.post(
        "Runtime.getProperties",
        { objectId },
        (error, properties) => {
          assert.ifError(error);
          const internal = (name: string) =>
            properties.internalProperties?.find(
              (property) => property.name === name,
            )?.value;
          const location: unknown = internal("[[FunctionLocation]]")?.value;
          const target = internal("[[TargetFunction]]")?.objectId;
          if (
            isUnknownRecord(location) &&
            typeof location.scriptId === "string"
          ) {
            const url = scripts.get(location.scriptId);
            if (url) module = path.basename(fileURLToPath(url), ".ts");
          } else if (target) module = definingModule(target);
        },
      );
      return module;
    };
    const defining = handlers.map((handler) => {
      Reflect.set(globalThis, probe, handler);
      let module: string | undefined;
      session.post(
        "Runtime.evaluate",
        { expression: `globalThis[Symbol.for("killeros.settled-handler")]` },
        (error, value) => {
          assert.ifError(error);
          module = definingModule(value.result.objectId ?? "");
        },
      );
      assert.ok(module, "The inspector must locate every handler");
      return module;
    });
    const order = [
      "worked-for",
      "goal-settlement",
      "activity",
      "notifications",
      "hooks",
    ];
    assert.deepEqual(
      defining.filter((module) => order.includes(module)),
      order,
      "A slow project hook must not delay the receipt or sound, and its file edits must stay out of the agent's receipt",
    );
  } finally {
    Reflect.deleteProperty(globalThis, probe);
    session.disconnect();
  }
});
