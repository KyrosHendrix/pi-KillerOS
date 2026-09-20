import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createKillerosSettingsStore } from "../killeros/settings.ts";

function createTemporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "killeros-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function startSettingsUpdate(settingsPath: string, startPath: string, patch: Readonly<Record<string, unknown>>) {
  const moduleUrl = new URL("../killeros/settings.ts", import.meta.url).href;
  const script = `
    import { existsSync } from "node:fs";
    import { createKillerosSettingsStore } from ${JSON.stringify(moduleUrl)};
    process.stdout.write("ready\\n");
    while (!existsSync(process.env.START_PATH)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    createKillerosSettingsStore(process.env.SETTINGS_PATH).update(JSON.parse(process.env.PATCH));
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      PATCH: JSON.stringify(patch),
      SETTINGS_PATH: settingsPath,
      START_PATH: startPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const ready = new Promise<void>((resolve) => {
    child.stdout.once("data", () => resolve());
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`settings writer exited with ${String(code ?? signal)}: ${stderr}`));
    });
  });
  return { completed, ready };
}

test("an exited settings writer does not leave the settings lock stuck", async (t) => {
  const directory = createTemporaryDirectory(t);
  const settingsPath = path.join(directory, "killeros.json");
  const lockPath = `${settingsPath}.lock`;
  writeFileSync(settingsPath, JSON.stringify({ futureSetting: "keep" }));

  const moduleUrl = new URL("../killeros/settings.ts", import.meta.url).href;
  const script = `
    import { createKillerosSettingsStore } from ${JSON.stringify(moduleUrl)};
    const patch = {
      get abandoned() {
        process.stdout.write("locked\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return true;
      },
    };
    createKillerosSettingsStore(process.env.SETTINGS_PATH).update(patch);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    env: { ...process.env, SETTINGS_PATH: settingsPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  assert.equal(existsSync(lockPath), true);
  child.kill();
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));

  createKillerosSettingsStore(settingsPath).update({ completionSound: true });

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    futureSetting: "keep",
    completionSound: true,
  });
  assert.deepEqual(readdirSync(directory), ["killeros.json"]);
});

test("concurrent settings updates preserve every successful write", async (t) => {
  const directory = createTemporaryDirectory(t);
  const settingsPath = path.join(directory, "killeros.json");
  const startPath = path.join(directory, "start");
  writeFileSync(settingsPath, JSON.stringify({ futureSetting: { retained: true } }));

  const patches: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { autoCompaction: { enabled: false, percentRemaining: 22 } },
    { completionSound: true },
    ...Array.from({ length: 10 }, (_, index) => ({ [`concurrentSetting${index}`]: index })),
  ];
  const writers = patches.map((patch) => startSettingsUpdate(settingsPath, startPath, patch));
  await Promise.all(writers.map(({ ready }) => ready));
  writeFileSync(startPath, "go");
  await Promise.all(writers.map(({ completed }) => completed));

  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), Object.assign(
    { futureSetting: { retained: true } },
    ...patches,
  ));
});
