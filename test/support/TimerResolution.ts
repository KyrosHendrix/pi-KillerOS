import { pathToFileURL } from "node:url";

type WinmmLibrary = {
  functions: { timeBeginPeriod(milliseconds: number): number };
};
type NodeFfi = {
  dlopen(
    path: string,
    definitions: {
      timeBeginPeriod: { arguments: ["uint32"]; return: "uint32" };
    },
  ): WinmmLibrary;
};

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
    const ffi = (await import(specifier)) as NodeFfi;
    ffi
      .dlopen("winmm.dll", {
        timeBeginPeriod: { arguments: ["uint32"], return: "uint32" },
      })
      .functions.timeBeginPeriod(1);
  } catch {
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function piTimerResolutionOptions(env: NodeJS.ProcessEnv): void {
  const preload = `--import="${pathToFileURL(import.meta.filename).href}"`;
  if (!env.NODE_OPTIONS?.includes(preload))
    env.NODE_OPTIONS = env.NODE_OPTIONS
      ? `${env.NODE_OPTIONS} ${preload}`
      : preload;
}
