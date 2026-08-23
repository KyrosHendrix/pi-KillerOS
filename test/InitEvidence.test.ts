import assert from "node:assert/strict";
import test from "node:test";
import { listInitEvidence, type InitEvidenceIndex } from "../killeros/init-evidence.ts";

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
