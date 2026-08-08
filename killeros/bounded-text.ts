import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export class BoundedText implements Component {
  private readonly text: string;
  private readonly maxRows?: number;

  constructor(text: string, maxRows?: number) {
    this.text = text;
    this.maxRows = maxRows;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const lines = new Text(this.text, 0, 0).render(width);
    if (this.maxRows === undefined || lines.length <= this.maxRows) return lines;
    const rowLimit = Math.max(1, this.maxRows);
    const visible = lines.slice(0, rowLimit);
    const suffix = " …";
    const last = visible.at(-1) ?? "";
    visible[rowLimit - 1] = `${truncateToWidth(last, Math.max(0, width - visibleWidth(suffix)), "")}${suffix}`;
    return visible.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
}
