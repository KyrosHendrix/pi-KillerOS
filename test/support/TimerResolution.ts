/**
 * Raises this process's Windows timer resolution to 1 ms. Best effort and silent.
 *
 * Windows wakes timers on a 15.6 ms system tick by default, so `setTimeout(1)` takes 16 ms and Pi's
 * 16 ms render throttle takes 31 ms. Scenarios wait on thousands of render frames and polls, so the
 * default tick roughly doubles every terminal step. `timeBeginPeriod` applies only to the process
 * that calls it, so test processes import this module through TestTemp.ts, and the Pi drivers
 * preload it into each Pi child with `piTimerResolutionOptions`.
 */
import { pathToFileURL } from "node:url";

type WinmmLibrary = { functions: { timeBeginPeriod(milliseconds: number): number } };
type NodeFfi = { dlopen(path: string, definitions: { timeBeginPeriod: { arguments: ["uint32"]; return: "uint32" } }): WinmmLibrary };

if (process.platform === "win32") {
  // node:ffi warns that it is experimental on first load. Pi children and tests check stderr, so hide only that warning.
  const emitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("FFI")) return;
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  };
  try {
    // A variable specifier keeps TypeScript from requiring declarations that @types/node does not ship yet.
    const specifier = "node:ffi";
    const ffi = await import(specifier) as NodeFfi;
    ffi.dlopen("winmm.dll", { timeBeginPeriod: { arguments: ["uint32"], return: "uint32" } }).functions.timeBeginPeriod(1);
  } catch { /* Without node:ffi or winmm, timers keep the default tick; tests stay correct, only slower. */ } finally {
    process.emitWarning = emitWarning;
  }
}

/** Adds this module as a preload to a child environment's NODE_OPTIONS, keeping any options it already has. */
export function piTimerResolutionOptions(env: NodeJS.ProcessEnv): void {
  const preload = `--import="${pathToFileURL(import.meta.filename).href}"`;
  if (!env.NODE_OPTIONS?.includes(preload)) env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload;
}
