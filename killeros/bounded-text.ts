import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** A transcript component laid out once per width: Pi renders every transcript component on every frame. */
export abstract class WidthCachedComponent implements Component {
  private cached?: { width: number; lines: string[] };

  /** Returns the lines for `width`, reusing the last layout while the width is unchanged. */
  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cached?.width !== width) this.cached = { width, lines: this.layout(width) };
    return this.cached.lines;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  protected abstract layout(width: number): string[];
}

/** Transcript text wrapped to the width and, when `maxRows` is set, cut to that many rows with an ellipsis. */
export class BoundedText extends WidthCachedComponent {
  private readonly text: string;
  private readonly maxRows?: number;

  constructor(text: string, maxRows?: number) {
    super();
    this.text = text;
    this.maxRows = maxRows;
  }

  /** Wraps the text to `width`; past `maxRows`, keeps the first rows and ends the last one with an ellipsis. */
  protected layout(width: number): string[] {
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
