import type { ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.ts";

export interface DisplayOption {
  label: string;
  answer: string;
  description?: string;
  preview?: string;
  originalIndex: number;
}

export type QuestionSelection =
  | { kind: "selected"; answer: string; originalIndex: number }
  | { kind: "custom"; answer: string }
  | { kind: "multiple"; answers: string[]; selectedIndices: number[]; customAnswer?: string }
  | { kind: "cancelled" }
  | { kind: "aborted" };

export const CUSTOM_INPUT_MAX_CHARACTERS = 4_000;
export const CUSTOM_INPUT_HISTORY_LIMIT = 100;
export const CUSTOM_INPUT_HISTORY_BYTES = 64 * 1024;
export const FILTER_QUERY_MAX_CHARACTERS = 4_000;
export const FILTER_QUERY_MAX_BYTES = 16_000;

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function inputCharacterCount(value: string): number {
  return [...value].length;
}

function compactMultipleAnswers(answers: readonly string[], width: number): string {
  const prefix = "✓ ";
  if (answers.length === 0) return truncateToWidth(prefix + "No answers", width, "…");
  const visible: string[] = [];
  for (const [index, answer] of answers.entries()) {
    const remaining = answers.length - index - 1;
    const candidate = [...visible, oneLine(answer)].join(", ");
    const suffix = remaining > 0 ? `, +${remaining} more` : "";
    if (visibleWidth(prefix + candidate + suffix) > width) break;
    visible.push(oneLine(answer));
  }
  if (visible.length === answers.length) return prefix + visible.join(", ");
  const hidden = answers.length - visible.length;
  if (visible.length === 0) return truncateToWidth(`${prefix}+${hidden} more`, width, "…");
  return truncateToWidth(`${prefix}${visible.join(", ")}, +${hidden} more`, width, "…");
}

export class MultipleResultText {
  private readonly answers: readonly string[];
  private readonly expanded: boolean;
  private readonly customAnswer: string | undefined;
  private readonly color: (name: ThemeColor, text: string) => string;

  constructor(
    answers: readonly string[],
    expanded: boolean,
    customAnswer: string | undefined,
    color: (name: ThemeColor, text: string) => string,
  ) {
    this.answers = answers;
    this.expanded = expanded;
    this.customAnswer = customAnswer;
    this.color = color;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (!this.expanded) return [this.color("accent", compactMultipleAnswers(this.answers, width))];
    return this.answers.flatMap((answer) => wrapTextWithAnsi(
      `${this.color("success", "✓ ")}${answer === this.customAnswer ? this.color("muted", "(wrote) ") : ""}${this.color("accent", answer)}`,
      width,
    ));
  }

  invalidate(): void {}
}

type Choice<T> = { label: string; value: T };
type DialogSize = { width: number; rows: number };
type MainAction =
  | { kind: "option"; option: DisplayOption }
  | { kind: "custom" }
  | { kind: "submit" }
  | { kind: "actions" };
type MoreAction = "filter" | "clear" | "history" | "remove" | "review" | "question";
class QuestionAborted extends Error {}

function dialogSize(): DialogSize {
  return { width: Math.max(1, (process.stdout.columns || 80) - 6), rows: process.stdout.rows || 24 };
}

export async function openQuestionUi(config: {
  ctx: ExtensionContext;
  signal: AbortSignal;
  question: string;
  options: DisplayOption[];
  mode: "single" | "multiple";
  minSelections: number;
  maxSelections: number;
  customInputHistory: readonly string[];
  rememberCustomInput: (value: string) => boolean;
}): Promise<QuestionSelection> {
  const { ctx, signal, question, options, mode, minSelections, maxSelections, customInputHistory, rememberCustomInput } = config;
  const selected = new Set<number>();
  let customAnswer: string | undefined;
  let filter = "";
  const checkAbort = (): void => { if (signal.aborted) throw new QuestionAborted(); };
  const count = (): number => selected.size + (customAnswer === undefined ? 0 : 1);
  const notifyMaximum = (): void => ctx.ui.notify(`Select at most ${maxSelections} answer${maxSelections === 1 ? "" : "s"}`, "error");

  // Resize dismisses only this native step. Rebuild its pages without losing question state.
  async function nativeRequest(request: (stepSignal: AbortSignal) => Promise<string | undefined>) {
    checkAbort();
    const resize = new AbortController();
    const onResize = (): void => resize.abort();
    process.stdout.on("resize", onResize);
    try {
      const value = await request(AbortSignal.any([signal, resize.signal]));
      checkAbort();
      return resize.signal.aborted ? { kind: "resize" as const } : { kind: "result" as const, value };
    } finally {
      process.stdout.off("resize", onResize);
    }
  }

  async function choose<T>(title: string | ((size: DialogSize) => string), entries: Choice<T>[]): Promise<T | undefined> {
    let start = 0;
    while (true) {
      const size = dialogSize();
      const text = typeof title === "string" ? title.split("\n").slice(0, 2).map((line) => truncateToWidth(oneLine(line), size.width, "…")).join("\n") : title(size);
      // Reserve native borders, hints, header/footer, and both page controls.
      const capacity = Math.max(1, size.rows - 13 - text.split("\n").length);
      start = Math.min(start, Math.max(0, entries.length - 1));
      const page = entries.slice(start, start + capacity);
      const labels = page.map((entry, index) => truncateToWidth(`${start + index + 1}. ${oneLine(entry.label)}`, size.width, "…"));
      const next = "Next choices";
      const previous = "Previous choices";
      const offered = [...labels, ...(start + capacity < entries.length ? [next] : []), ...(start > 0 ? [previous] : [])];
      const response = await nativeRequest((stepSignal) => ctx.ui.select(text, offered, { signal: stepSignal }));
      checkAbort();
      if (response.kind === "resize") continue;
      if (response.value === undefined) return undefined;
      if (response.value === next && offered.includes(next)) { start += capacity; continue; }
      if (response.value === previous && offered.includes(previous)) { start = Math.max(0, start - capacity); continue; }
      const index = labels.indexOf(response.value);
      const entry = page[index];
      if (!entry) throw new Error("Native question selection does not match an offered choice");
      return entry.value;
    }
  }

  async function input(title: string, placeholder = ""): Promise<string | undefined> {
    checkAbort();
    const size = dialogSize();
    // Pi reflows native input on resize. Keep its component and in-progress draft.
    const value = await ctx.ui.input(truncateToWidth(title, size.width, "…"), truncateToWidth(oneLine(placeholder), size.width, "…"), { signal });
    checkAbort();
    return value;
  }

  async function review(content: string): Promise<void> {
    let page = 0;
    let pages = 1;
    while (true) {
      const action = await choose<"next" | "previous" | "back">((size) => {
        const lines = wrapTextWithAnsi(content, size.width);
        const capacity = Math.max(1, size.rows - 18);
        pages = Math.max(1, Math.ceil(lines.length / capacity));
        page = Math.min(page, pages - 1);
        return [`Review ${page + 1}/${pages}`, ...lines.slice(page * capacity, (page + 1) * capacity)].join("\n");
      }, [ { label: "Next page", value: "next" }, { label: "Previous page", value: "previous" }, { label: "Back", value: "back" } ]);
      if (action === undefined || action === "back") return;
      if (action === "next") page = Math.min(page + 1, pages - 1);
      else page = Math.max(0, page - 1);
    }
  }

  function acceptCustom(raw: string): QuestionSelection | undefined {
    checkAbort();
    const answer = safeTerminalText(raw).trim();
    if (!answer) { ctx.ui.notify("Enter a nonempty custom answer", "error"); return; }
    if (inputCharacterCount(raw.trim()) > CUSTOM_INPUT_MAX_CHARACTERS) {
      ctx.ui.notify(`Custom answers are limited to ${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()} characters`, "error");
      return;
    }
    if (mode === "multiple" && customAnswer === undefined && count() >= maxSelections) { notifyMaximum(); return; }
    if (!rememberCustomInput(answer)) { ctx.ui.notify(`Custom answer history is limited to ${CUSTOM_INPUT_HISTORY_BYTES} bytes`, "error"); return; }
    if (mode === "single") return { kind: "custom", answer };
    customAnswer = answer;
  }

  try {
    while (true) {
      checkAbort();
      const query = filter.trim().toLowerCase();
      const visible = options.filter((option) => !query || option.label.toLowerCase().includes(query) || option.description?.toLowerCase().includes(query));
      const entries: Choice<MainAction>[] = visible.map((option) => ({
        label: `${mode === "multiple" ? selected.has(option.originalIndex) ? "[x] " : "[ ] " : ""}${option.label}${option.description ? ` · ${oneLine(option.description)}` : ""}`,
        value: { kind: "option", option },
      }));
      if (mode === "multiple") entries.push({ label: "Submit answers", value: { kind: "submit" } });
      entries.push({ label: customAnswer === undefined ? "Custom answer" : "Edit custom answer", value: { kind: "custom" } }, { label: "More actions", value: { kind: "actions" } });
      const summary = mode === "multiple" ? `Selected ${count()} · choose ${minSelections}–${maxSelections}` : "Choose one answer";
      const action = await choose(`${summary}${filter ? " · filtered" : ""}\n${question}`, entries);
      checkAbort();
      if (action === undefined) return { kind: "cancelled" };
      switch (action.kind) {
        case "option":
          if (mode === "single") return { kind: "selected", answer: action.option.answer, originalIndex: action.option.originalIndex };
          if (selected.has(action.option.originalIndex)) selected.delete(action.option.originalIndex);
          else if (count() >= maxSelections) notifyMaximum();
          else selected.add(action.option.originalIndex);
          break;
        case "submit": {
          if (count() < minSelections) { ctx.ui.notify(`Select at least ${minSelections} answer${minSelections === 1 ? "" : "s"}`, "error"); break; }
          const ordered = options.filter((option) => selected.has(option.originalIndex));
          return { kind: "multiple", answers: [...ordered.map((option) => option.answer), ...(customAnswer === undefined ? [] : [customAnswer])], selectedIndices: ordered.map((option) => option.originalIndex), ...(customAnswer === undefined ? {} : { customAnswer }) };
        }
        case "custom": {
          const raw = await input("Custom answer", customAnswer);
          if (raw !== undefined) { const result = acceptCustom(raw); if (result) return result; }
          break;
        }
        case "actions": {
          const more: Choice<MoreAction>[] = [ { label: "Filter options", value: "filter" }, { label: "Review question", value: "question" }, { label: "Review option details", value: "review" } ];
          if (filter) more.push({ label: "Clear filter", value: "clear" });
          if (customInputHistory.length > 0) more.push({ label: "Recent answers", value: "history" });
          if (customAnswer !== undefined) more.push({ label: "Remove custom answer", value: "remove" });
          const extra = await choose("More actions", more);
          checkAbort();
          switch (extra) {
            case undefined: break;
            case "clear": filter = ""; break;
            case "remove": customAnswer = undefined; break;
            case "question": await review(question); break;
            case "review": {
              const option = await choose("Review option details", options.map((option) => ({ label: option.label, value: option })));
              if (option) await review([option.label, option.description, option.preview].filter((value) => value !== undefined).join("\n\n"));
              break;
            }
            case "filter": {
              const raw = await input("Filter options", filter);
              checkAbort();
              if (raw !== undefined) {
                if (inputCharacterCount(raw) > FILTER_QUERY_MAX_CHARACTERS || Buffer.byteLength(raw, "utf8") > FILTER_QUERY_MAX_BYTES) ctx.ui.notify(`Question filters are limited to ${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} characters and ${FILTER_QUERY_MAX_BYTES.toLocaleString()} bytes`, "error");
                else filter = safeTerminalText(raw);
              }
              break;
            }
            case "history": {
              const answer = await choose("Recent answers", [...customInputHistory].reverse().map((answer) => ({ label: answer, value: answer })));
              if (answer !== undefined) { const result = acceptCustom(answer); if (result) return result; }
              break;
            }
            default: { const exhaustive: never = extra; return exhaustive; }
          }
          break;
        }
        default: { const exhaustive: never = action; return exhaustive; }
      }
    }
  } catch (error) {
    if (error instanceof QuestionAborted) return { kind: "aborted" };
    throw error;
  }
}
