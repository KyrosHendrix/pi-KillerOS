import path from "node:path";

export type CheckAttempt = { label: CheckLabel; outcome: "passed" | "failed" };

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
const PACKAGE_SCRIPTS = ["test", "check", "lint", "typecheck", "build"] as const;
const GRADLE_COMMANDS = ["gradle", "gradlew", "gradlew.bat", "./gradlew", "./gradlew.bat", ".\\gradlew", ".\\gradlew.bat"] as const;
const PACKAGE_CHECK_LABELS = PACKAGE_MANAGERS.flatMap((manager) => [
  `${manager} test`,
  ...PACKAGE_SCRIPTS.map((script) => `${manager} run ${script}` as const),
] as const);
const GRADLE_CHECK_LABELS = GRADLE_COMMANDS.flatMap((command) => [
  `${command} test`,
  `${command} check`,
] as const);

const CHECK_LABELS = [
  ...PACKAGE_CHECK_LABELS,
  "python -m pytest", "py -m pytest", "node --test", "cargo clippy", "cargo check", "cargo test",
  "dotnet test", "mvn verify", "mvn test", "go test", "go vet", "pytest",
  ...GRADLE_CHECK_LABELS,
] as const;

const FOCUSED_CHECK_LABEL = "node --test (focused)";
const FOCUSED_TEST_UNSAFE_CHARACTERS = [
  '"', "'", "`", "$", ";", "&", "|", "<", ">", "*", "?", "[", "]", "{", "}", "(", ")", "#", "!",
] as const;

type CheckLabel = typeof CHECK_LABELS[number] | typeof FOCUSED_CHECK_LABEL;

/** Most checks a receipt lists individually; later ones are only counted. */
export const MAX_RECEIPT_CHECKS = 20;

/** Accepts a persisted label only when KillerOS could have recognized it. */
export function parseCheckLabel(value: unknown): CheckLabel | undefined {
  return CHECK_LABELS.find((candidate) => candidate === value) ?? (value === FOCUSED_CHECK_LABEL ? FOCUSED_CHECK_LABEL : undefined);
}

function isFocusedTestFile(value: string): boolean {
  if (value.startsWith("-") || value.startsWith("~") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value) || /[\s\p{Cc}]/u.test(value)
    || FOCUSED_TEST_UNSAFE_CHARACTERS.some((character) => value.includes(character))) return false;
  const segments = value.split(/[\\/]/u);
  const filename = segments.at(-1);
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && filename !== undefined
    && filename.includes(".test.")
    && /\.(?:js|cjs|mjs|ts|cts|mts)$/u.test(filename);
}

export function recognizedCheck(command: unknown, failed: boolean): CheckAttempt | undefined {
  if (typeof command !== "string") return undefined;
  const normalized = command.replace(/^[\t ]+|[\t ]+$/gu, "");
  const outcome = failed ? "failed" : "passed";
  const label = CHECK_LABELS.find((candidate) => normalized === candidate);
  if (label) return { label, outcome };
  const focused = /^node --test(?: --experimental-strip-types)? ([^ \t]+)$/u.exec(normalized);
  if (!focused?.[1] || !isFocusedTestFile(focused[1])) return undefined;
  return { label: FOCUSED_CHECK_LABEL, outcome };
}
