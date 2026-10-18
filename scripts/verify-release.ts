import { readFileSync } from "node:fs";
import { extractReleaseSection } from "./release-notes.ts";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function versionOf(value: unknown, path: string): string {
  if (typeof value !== "object" || value === null || !("version" in value) || typeof value.version !== "string") {
    throw new Error(`${path} has no string version`);
  }
  return value.version;
}

try {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.KILLEROS_RELEASE !== "true") {
    throw new Error("Only the verified GitHub release workflow may publish killeros");
  }

  const version = versionOf(readJson("package.json"), "package.json");
  const packageLock = readJson("package-lock.json");
  const lockVersion = versionOf(packageLock, "package-lock.json");
  const rootVersion = typeof packageLock === "object"
    && packageLock !== null
    && "packages" in packageLock
    && typeof packageLock.packages === "object"
    && packageLock.packages !== null
    && "" in packageLock.packages
    ? versionOf(packageLock.packages[""], "package-lock.json root package")
    : undefined;
  if (version !== lockVersion || version !== rootVersion) {
    throw new Error("package.json and package-lock.json versions do not match");
  }

  if (extractReleaseSection(readFileSync("CHANGELOG.md", "utf8"), version) === null) {
    throw new Error(`CHANGELOG.md has no section for version ${version}`);
  }
  const readme = readFileSync("README.md", "utf8");
  // Check all version pins, including examples wrapped onto another line.
  const pinnedVersions = [...readme.matchAll(/@v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/gu)]
    .map((match) => match[1]);
  if (pinnedVersions.length === 0 || pinnedVersions.some((pinned) => pinned !== version)) {
    throw new Error(`README.md does not reference @v${version} in the pinned release example`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
