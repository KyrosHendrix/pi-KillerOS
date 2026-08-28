import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInitEvidence, listInitEvidence, readInitEvidence, type InitEvidenceIndex } from "../killeros/init-evidence.ts";

// Temporarily simulates platform-specific path semantics for each assertion.
function withPlatform(platformName: NodeJS.Platform, action: () => void): void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { value: platformName });
  try {
    action();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

test("/init rejects sensitive paths and secret-bearing content without exposing values", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-secrets-"));
  const fixtures = new Map([
    ["private-key.txt", "-----BEGIN PRIVATE KEY-----\nLIVE_PRIVATE_KEY\n"],
    ["provider.txt", `token=${"ghp_"}${"A".repeat(36)}\n`],
    ["remote.txt", "url=https://user:LIVE_URL_PASSWORD@example.com/private\n"],
    ["settings.txt", "api_key: LIVE_SECRET_123\n"],
  ]);
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, "README.md"), "# Safe project\n");
    writeFileSync(path.join(directory, "config.yaml"), "api_key: CONFIG_LIVE_SECRET\n");
    for (const [name, content] of fixtures) writeFileSync(path.join(directory, name), content);
    for (const relativePath of [".aws/credentials", ".docker/config.json", ".kube/config", "secrets.json", "access-token.txt"]) {
      const absolutePath = path.join(directory, relativePath);
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, "SECRET_PATH_VALUE\n");
    }

    const { index } = await buildInitEvidence(directory);
    assert.match(index.snapshot, /Safe project/u);
    for (const secret of ["CONFIG_LIVE_SECRET", "LIVE_PRIVATE_KEY", "LIVE_URL_PASSWORD", "LIVE_SECRET_123", `${"ghp_"}${"A".repeat(36)}`]) {
      assert.doesNotMatch(index.snapshot, new RegExp(secret, "u"));
    }
    for (const relativePath of [".aws/credentials", ".docker/config.json", ".kube/config", "secrets.json", "access-token.txt"]) {
      assert.equal([...index.canonicalPaths.values()].includes(relativePath), false, relativePath);
    }
    for (const [name, content] of fixtures) {
      const secret = content.trim().split(/[:=\n]/u).at(-1) ?? content.trim();
      await assert.rejects(readInitEvidence(index, name), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not available to \/init/u);
        assert.doesNotMatch(error.message, new RegExp(secret, "u"));
        return true;
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init lists Windows evidence directories without requiring their stored casing", () => {
  const windowsIndex: InitEvidenceIndex = {
    projectRoot: "C:\\project",
    canonicalPaths: new Map([["src/package.json", "Src/package.json"]]),
    snapshot: "",
  };

  withPlatform("win32", () => {
    assert.deepEqual(listInitEvidence(windowsIndex, "src"), ["package.json"]);
    assert.deepEqual(listInitEvidence(windowsIndex, "SRC"), ["package.json"]);
  });

  const posixIndex: InitEvidenceIndex = {
    projectRoot: "/project",
    canonicalPaths: new Map([["Src/package.json", "Src/package.json"]]),
    snapshot: "",
  };

  withPlatform("linux", () => {
    assert.deepEqual(listInitEvidence(posixIndex, "Src"), ["package.json"]);
    assert.throws(() => listInitEvidence(posixIndex, "src"), /not available to \/init/u);
  });
});
