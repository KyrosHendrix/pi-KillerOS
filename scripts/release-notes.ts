// scripts/release-notes.ts
// Extracts the changelog section for one version. Consumed by .github/workflows/release.yml.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface ChangelogSection {
  version: string;
  lines: string[];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function extractReleaseSection(text: string, version: string): string | null {
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }
  const sections: ChangelogSection[] = [];
  let current: ChangelogSection | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^## \[([^\]]+)\]/);
    if (match && match[1] !== "Unreleased") {
      current = { version: match[1], lines: [line] };
      sections.push(current);
    } else if (match) {
      current = null;
    } else if (current) {
      current.lines.push(line);
    }
  }
  const section = sections.find((entry) => entry.version === version) ?? null;
  return section === null ? null : section.lines.join("\n").trim();
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [changelogPath, version] = process.argv.slice(2);
  if (changelogPath === undefined || version === undefined) {
    console.error("usage: node scripts/release-notes.ts <changelog.md> <version>");
    process.exit(2);
  }
  let changelogText: string;
  try {
    changelogText = readFileSync(changelogPath, "utf8");
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`cannot read changelog ${changelogPath}: ${code ?? message}`);
    process.exit(1);
  }
  const section = extractReleaseSection(changelogText, version);
  if (section === null) {
    console.error(`CHANGELOG.md has no section for version ${version}`);
    process.exit(1);
  }
  console.log(section);
}
