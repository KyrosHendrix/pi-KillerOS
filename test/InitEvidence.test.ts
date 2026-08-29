import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInitEvidence, type InitEvidenceIndex, listInitEvidence, readInitEvidence } from "../killeros/init-evidence.ts";
import {
  buildInitEvidence as buildInitEvidenceFromKilleros,
  listInitEvidence as listInitEvidenceFromKilleros,
  readInitEvidence as readInitEvidenceFromKilleros,
} from "../Killeros.ts";

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

test("/init truncation preserves complete UTF-8 characters", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-utf8-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "README.md"), `${"a".repeat(8_191)}😀`, "utf8");
    writeFileSync(path.join(directory, "src", "large.ts"), `${"b".repeat(32_767)}😀`, "utf8");

    const { index } = await buildInitEvidenceFromKilleros(directory);

    assert.doesNotMatch(index.snapshot, /�/u);
    assert.doesNotMatch(await readInitEvidenceFromKilleros(index, "src/large.ts"), /�/u);
    assert.ok(Buffer.byteLength(index.snapshot, "utf8") <= 40 * 1024);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init evidence excludes secrets, ignored files, links, and paths outside the frozen map", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-read-scope-"));
  try {
    execFileSync("git", ["init"], { cwd: directory, stdio: "ignore", windowsHide: true });
    writeFileSync(path.join(directory, ".gitignore"), ".env.local\nignored.ts\n");
    writeFileSync(path.join(directory, "allowed.ts"), "export const allowed = true;\n");
    for (const name of [".env", ".env.local", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials.json", "service-account-prod.json", "private.pem", "private.key", "private.p12", "private.pfx", "private.jks", "private.keystore", "AGENTS.md", "CLAUDE.md", "ignored.ts"]) {
      writeFileSync(path.join(directory, name), "SECRET\n");
    }
    let linked = false;
    try {
      symlinkSync("allowed.ts", path.join(directory, "linked.ts"), "file");
      linked = true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code))) throw error;
    }
    writeFileSync(path.join(directory, "hard-link-source.ts"), "linked\n");
    try {
      linkSync(path.join(directory, "hard-link-source.ts"), path.join(directory, "hard-linked.ts"));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EACCES", "EPERM", "UNKNOWN"].includes(String(error.code))) throw error;
    }

    const { index } = await buildInitEvidenceFromKilleros(directory);
    assert.match(index.snapshot, /allowed\.ts/u);
    assert.doesNotMatch(index.snapshot, /\.env|\.npmrc|private\.pem|ignored\.ts|CLAUDE\.md/u);
    assert.match(await readInitEvidenceFromKilleros(index, "allowed.ts"), /allowed = true/u);
    assert.deepEqual(listInitEvidenceFromKilleros(index), [...listInitEvidenceFromKilleros(index)].sort());
    for (const unavailable of [".env", ".env.local", ".npmrc", "private.pem", "ignored.ts", "AGENTS.md", "../outside", path.resolve(directory, "allowed.ts"), "~/secret", "file:///secret", "missing.ts", "hard-linked.ts", ...(linked ? ["linked.ts"] : [])]) {
      await assert.rejects(readInitEvidenceFromKilleros(index, unavailable), /not available to \/init|rejects/u, unavailable);
    }

    writeFileSync(path.join(directory, "created-after-map.ts"), "late\n");
    await assert.rejects(readInitEvidenceFromKilleros(index, "created-after-map.ts"), /not available to \/init/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("/init fails closed without exposing a custom ignored file when Git is unavailable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-init-no-git-"));
  try {
    writeFileSync(path.join(directory, ".gitignore"), "private-notes.txt\n");
    writeFileSync(path.join(directory, "private-notes.txt"), "PRIVATE NOTES MUST NOT ENTER EVIDENCE\n");
    execFileSync(process.execPath, [
      "--input-type=module",
      "--experimental-strip-types",
      "--eval",
      `
        import { buildInitEvidence } from "./killeros/init-evidence.ts";
        try {
          await buildInitEvidence(process.env.KILLEROS_TEST_DIRECTORY);
          throw new Error("/init unexpectedly built an evidence index");
        } catch (error) {
          if (!String(error.message).includes("Git ignore inspection failed")) throw error;
        }
      `,
    ], {
      cwd: path.resolve("."),
      env: { ...process.env, KILLEROS_TEST_DIRECTORY: directory, PATH: "" },
      stdio: "pipe",
      windowsHide: true,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
