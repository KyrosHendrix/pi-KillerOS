import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../killeros/guards.ts";
import { nodeDirectory, nodeExecutable } from "./NodeRuntime.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let template: ReturnType<typeof buildTemplate> | undefined;

function buildTemplate(directory: string) {
  const pack = path.join(directory, "pack");
  const consumer = path.join(directory, "consumer");
  const userConfig = path.join(directory, "user.npmrc");
  const globalConfig = path.join(directory, "global.npmrc");
  mkdirSync(pack);
  mkdirSync(consumer);
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );

  const npmCli = [
    process.env.KILLEROS_TEST_NPM_CLI,
    process.env.npm_execpath,
    ...[
      nodeDirectory(),
      ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter),
    ].map((directory) =>
      path.join(directory, "node_modules/npm/bin/npm-cli.js"),
    ),
  ].find(
    (candidate) =>
      candidate &&
      path.basename(candidate) === "npm-cli.js" &&
      existsSync(candidate),
  );
  assert.ok(npmCli, "Cannot locate npm-cli.js without a shell");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^npm_config_|^node_options$/iu.test(key),
    ),
  );
  const npm = (args: string[], cwd: string) =>
    execFileSync(
      nodeExecutable(),
      [
        path.resolve(npmCli),
        "--userconfig",
        userConfig,
        "--globalconfig",
        globalConfig,
        "--cache",
        path.join(directory, "npm-cache"),
        "--loglevel",
        "error",
        "--no-update-notifier",
        "--ignore-scripts",
        ...args,
      ],
      { cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 4_194_304 },
    );

  const packed: unknown = JSON.parse(
    npm(["pack", "--json", "--pack-destination", pack], repositoryRoot),
  );
  let entry: unknown;
  if (Array.isArray(packed)) {
    assert.equal(packed.length, 1, "npm pack must report exactly one archive");
    entry = packed[0];
  } else {
    assert.ok(isRecord(packed), "Invalid npm pack output");
    assert.deepEqual(
      Object.keys(packed),
      ["killeros"],
      "npm pack must report exactly one KillerOS archive",
    );
    entry = packed.killeros;
  }
  assert.ok(isRecord(entry), "Invalid npm pack archive metadata");
  assert.ok(
    typeof entry.filename === "string" &&
      typeof entry.integrity === "string" &&
      Array.isArray(entry.files) &&
      entry.files.length > 0,
    "npm pack must report the archive filename, integrity, and files",
  );
  const archives = readdirSync(pack).filter((file) => file.endsWith(".tgz"));
  assert.equal(
    archives.length,
    1,
    "npm pack must produce exactly one KillerOS archive",
  );
  const archiveName = archives[0];
  assert.equal(archiveName, entry.filename, "Archive name must match npm pack");
  const archive = path.join(pack, archiveName);
  const bytes = readFileSync(archive);
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const archiveHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    integrity,
    entry.integrity,
    "Archive bytes must match npm pack integrity",
  );

  npm(
    [
      "install",
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--legacy-peer-deps",
      archive,
    ],
    consumer,
  );
  assert.deepEqual(
    readFileSync(archive),
    bytes,
    "npm install must leave the packed archive intact",
  );
  assert.ok(
    !existsSync(path.join(consumer, "node_modules", "@earendil-works")),
    "The template must not install a second Pi",
  );
  const installedPackage = path.join(consumer, "node_modules", "killeros");
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(installedPackage, "package.json"), "utf8"),
  );
  assert.ok(
    typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      manifest.name === "killeros" &&
      "version" in manifest &&
      typeof manifest.version === "string" &&
      "os" in manifest,
    "Invalid packed KillerOS manifest",
  );
  assert.ok(
    manifest.version === entry.version,
    "Installed KillerOS version must match npm pack",
  );
  assert.deepEqual(manifest.os, ["win32"]);
  for (const file of [
    "Killeros.ts",
    "README.md",
    "CHANGELOG.md",
    "themes/killeros.json",
  ]) {
    assert.ok(
      existsSync(path.join(installedPackage, file)),
      `Packed package is missing ${file}`,
    );
  }
  const metadata = Object.freeze({
    version: manifest.version,
    archiveName,
    archiveHash,
    integrity,
  });
  return { archive, installedPackage, metadata };
}

function packageTemplate() {
  if (template) return template;
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-packed-"));
  try {
    template = buildTemplate(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  process.once("exit", () =>
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 }),
  );
  return template;
}

export function packedPackage(): Readonly<{
  version: string;
  archiveName: string;
  archiveHash: string;
  integrity: string;
}> {
  return packageTemplate().metadata;
}

export function materializePackedConsumer(directory: string): string {
  const { installedPackage } = packageTemplate();
  const consumer = path.resolve(directory);
  mkdirSync(consumer, { recursive: true });
  assert.deepEqual(
    readdirSync(consumer),
    [],
    "The packed consumer directory must be empty",
  );
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
    { flag: "wx" },
  );
  const installed = path.join(consumer, "node_modules", "killeros");
  cpSync(installedPackage, installed, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  return installed;
}

export function materializePackedArchive(directory: string): string {
  const { archive, metadata } = packageTemplate();
  const destination = path.resolve(directory, metadata.archiveName);
  mkdirSync(directory, { recursive: true });
  copyFileSync(archive, destination, constants.COPYFILE_EXCL);
  return destination;
}
