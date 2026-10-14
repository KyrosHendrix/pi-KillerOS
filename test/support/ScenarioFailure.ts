import { writeFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

export function throwScenarioFailure(options: {
  directory: string;
  message: string;
  errors: unknown[];
  diagnostics: string;
}): never {
  const failure = new AggregateError(options.errors, options.message);
  const errors = inspect(failure, { depth: 8, customInspect: false, maxArrayLength: 20, maxStringLength: 4_096 }).slice(0, 16_384);
  const report = `${errors}\n${options.diagnostics.slice(0, 49_151)}`;
  try {
    writeFileSync(path.join(options.directory, "failure.txt"), report, "utf8");
  } catch (error) {
    throw new AggregateError([...options.errors, error], `${options.message}\n${report}\nCould not save failure report: ${inspect(error).slice(0, 2_000)}`);
  }
  throw new AggregateError(options.errors, `${options.message}\n${report}`);
}
