import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/**
 * Transcript text wrapped to the width and, when `maxRows` is set, cut to that many rows with an ellipsis.
 * Pi renders every transcript component on every frame, so the lines are cached per width.
 */
export class BoundedText implements Component {
  private readonly text: string;
  private readonly maxRows?: number;
  private cached?: { width: number; lines: string[] };

  constructor(text: string, maxRows?: number) {
    this.text = text;
    this.maxRows = maxRows;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cached?.width !== width) this.cached = { width, lines: this.layout(width) };
    return this.cached.lines;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  private layout(width: number): string[] {
    const lines = new Text(this.text, 0, 0).render(width).map((line) => truncateToWidth(line, width, ""));
    if (this.maxRows === undefined || lines.length <= this.maxRows) return lines;
    const rowLimit = Math.max(1, this.maxRows);
    const visible = lines.slice(0, rowLimit);
    const suffix = " …";
    const last = visible.at(-1) ?? "";
    visible[rowLimit - 1] = `${truncateToWidth(last, Math.max(0, width - visibleWidth(suffix)), "")}${suffix}`;
    return visible.map((line) => truncateToWidth(line, width, ""));
  }
}
