/** Narrows parsed or caught values to a plain, non-array object whose fields can be inspected. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
