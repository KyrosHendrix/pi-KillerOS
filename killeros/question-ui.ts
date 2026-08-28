import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export interface DisplayOption {
  label: string;
  description?: string;
  preview?: string;
  originalIndex: number;
  isOther: boolean;
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

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001F\u007F-\u009F]/u.test(data);
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function decodeQuestionFilterInput(data: string): string | undefined {
  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable !== undefined) return isPrintableInput(kittyPrintable) ? kittyPrintable : undefined;

  const pasteStart = "\x1B[200~";
  const pasteEnd = "\x1B[201~";
  const startIndex = data.indexOf(pasteStart);
  const endIndex = data.indexOf(pasteEnd, startIndex + pasteStart.length);
  if (startIndex >= 0 && endIndex >= 0) {
    return data
      .slice(startIndex + pasteStart.length, endIndex)
      .replace(/\r\n|\r|\n/gu, "")
      .replace(/\t/gu, "    ")
      .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "");
  }

  return isPrintableInput(data) ? data : undefined;
}

function removeLastGrapheme(value: string): string {
  const segments = [...graphemeSegmenter.segment(value)];
  const last = segments.at(-1);
  return last ? value.slice(0, last.index) : "";
}

function inputCharacterCount(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

export function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundedRenderLine(value: string, width: number, suffix: string): string {
  return truncateToWidth(value.replace(/\r\n|\r|\n/gu, " "), width, suffix);
}

function visibleOptionRange(total: number, selected: number, capacity: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, capacity));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
  return { start, end: Math.min(total, start + size) };
}

function boundedQuestionLines(question: string, width: number, rowLimit: number): string[] {
  const wrapped = wrapTextWithAnsi(question.replace(/\s+/gu, " ").trim(), width);
  if (wrapped.length <= rowLimit) return wrapped;
  const visible = wrapped.slice(0, rowLimit);
  const finalIndex = rowLimit - 1;
  const finalLine = visible[finalIndex];
  if (finalLine !== undefined) visible[finalIndex] = truncateToWidth(finalLine, width, "…");
  return visible;
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

export async function openQuestionUi(config: {
  ctx: ExtensionContext;
  signal?: AbortSignal;
  question: string;
  options: DisplayOption[];
  originalOptions: readonly { label: string }[];
  mode: "single" | "multiple";
  minSelections: number;
  maxSelections: number;
  customInputHistory: readonly string[];
  rememberCustomInput: (value: string) => boolean;
}): Promise<QuestionSelection> {
  const {
    ctx,
    signal,
    question,
    options: displayOptions,
    originalOptions,
    mode,
    minSelections,
    maxSelections,
    customInputHistory,
    rememberCustomInput,
  } = config;
  const options = displayOptions;
      let finishFromAbort: (() => void) | undefined;
      const resultPromise = ctx.ui.custom<QuestionSelection>((tui, theme, keybindings, done) => {
        let optionIndex = 0;
        type EditMode = "none" | "filter" | "custom";
        let editMode: EditMode = "none";
        let filterQuery = "";
        const selectedOriginalIndices = new Set<number>();
        let customAnswer: string | undefined;
        let cachedWidth: number | undefined;
        let cachedRows: number | undefined;
        let cachedLines: string[] | undefined;
        let completed = false;

        const finish = (selection: QuestionSelection): void => {
          if (completed) return;
          completed = true;
          done(selection);
        };
        finishFromAbort = () => finish({ kind: "aborted" });

        const keyHint = (keybinding: Parameters<typeof keybindings.getKeys>[0], description: string): string => {
          const keyText = keybindings.getKeys(keybinding)
            .join("/")
            .split("/")
            .map((key) => key.split("+").map((part) => process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part).join("+"))
            .join("/");
          return theme.fg("dim", keyText) + theme.fg("muted", ` ${description}`);
        };

        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg("accent", text),
          selectList: {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        };
        const editor = new Editor(tui, editorTheme);
        customInputHistory.forEach((value) => editor.addToHistory(value));

        const filteredOptions = (): DisplayOption[] => {
          const query = filterQuery.trim().toLowerCase();
          return options.filter((option) => option.isOther
            || query.length === 0
            || option.label.toLowerCase().includes(query)
            || option.description?.toLowerCase().includes(query));
        };
        const selectedCount = (): number => selectedOriginalIndices.size + (customAnswer === undefined ? 0 : 1);
        const orderedMultipleSelection = () => {
          const selectedIndices = [...selectedOriginalIndices].sort((left, right) => left - right);
          const predefined = selectedIndices.map((index) => {
            const option = originalOptions[index - 1];
            if (!option) throw new Error("Question selection no longer matches an available option");
            return option.label;
          });
          return {
            answers: customAnswer === undefined ? predefined : [...predefined, customAnswer],
            selectedIndices,
            ...(customAnswer === undefined ? {} : { customAnswer }),
          };
        };

        const invalidate = (): void => {
          cachedWidth = undefined;
          cachedRows = undefined;
          cachedLines = undefined;
          editor.invalidate();
        };
        const refresh = (): void => {
          invalidate();
          tui.requestRender();
        };
        const notifyFilterLimit = (): void => ctx.ui.notify(
          `Question filters are limited to ${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} characters and ${FILTER_QUERY_MAX_BYTES.toLocaleString()} bytes`,
          "error",
        );
        const appendFilterInput = (value: string): void => {
          const next = filterQuery + value;
          if (inputCharacterCount(next) > FILTER_QUERY_MAX_CHARACTERS || Buffer.byteLength(next, "utf8") > FILTER_QUERY_MAX_BYTES) {
            notifyFilterLimit();
            return;
          }
          filterQuery = next;
          optionIndex = 0;
          refresh();
        };
        const togglePredefined = (option: DisplayOption): void => {
          if (selectedOriginalIndices.has(option.originalIndex)) {
            selectedOriginalIndices.delete(option.originalIndex);
            refresh();
            return;
          }
          if (selectedCount() >= maxSelections) {
            ctx.ui.notify(`Select at most ${maxSelections} answer${maxSelections === 1 ? "" : "s"}`, "error");
            return;
          }
          selectedOriginalIndices.add(option.originalIndex);
          refresh();
        };
        const enterCustomMode = (): void => {
          editMode = "custom";
          editor.setText(mode === "multiple" ? customAnswer ?? "" : "");
          refresh();
        };
        const enterFilterMode = (): void => {
          editMode = "filter";
          editor.setText(filterQuery);
          refresh();
        };

        editor.onSubmit = (value) => {
          if (editMode === "filter") {
            filterQuery = value;
            optionIndex = 0;
            editMode = "none";
            editor.setText("");
            refresh();
            return;
          }
          const answer = value.trim();
          if (answer) {
            if (inputCharacterCount(answer) > CUSTOM_INPUT_MAX_CHARACTERS) {
              ctx.ui.notify(`Custom answers are limited to ${CUSTOM_INPUT_MAX_CHARACTERS} characters`, "error");
              return;
            }
            if (mode === "multiple") {
              const addsSelection = customAnswer === undefined;
              if (addsSelection && selectedCount() >= maxSelections) {
                editor.setText(value);
                ctx.ui.notify(`Select at most ${maxSelections} answer${maxSelections === 1 ? "" : "s"}`, "error");
                refresh();
                return;
              }
              if (!rememberCustomInput(answer)) {
                editor.setText(value);
                ctx.ui.notify(`Custom answer history is limited to ${CUSTOM_INPUT_HISTORY_BYTES} bytes`, "error");
                refresh();
                return;
              }
              customAnswer = answer;
              editMode = "none";
              editor.setText("");
              refresh();
              return;
            }
            if (!rememberCustomInput(answer)) {
              ctx.ui.notify(`Custom answer history is limited to ${CUSTOM_INPUT_HISTORY_BYTES} bytes`, "error");
              return;
            }
            finish({ kind: "custom", answer });
            return;
          }
          editMode = "none";
          editor.setText("");
          refresh();
        };

        const handleEditorInput = (data: string): void => {
          if (keybindings.matches(data, "tui.select.cancel")) {
            editMode = "none";
            editor.setText("");
            refresh();
            return;
          }
          const before = editor.getExpandedText();
          editor.handleInput(data);
          const after = editor.getExpandedText();
          const overLimit = editMode === "filter"
            ? inputCharacterCount(after) > FILTER_QUERY_MAX_CHARACTERS || Buffer.byteLength(after, "utf8") > FILTER_QUERY_MAX_BYTES
            : inputCharacterCount(after) > CUSTOM_INPUT_MAX_CHARACTERS;
          if (overLimit) {
            editor.setText(before);
            if (editMode === "filter") notifyFilterLimit();
            else ctx.ui.notify(`Custom answers are limited to ${CUSTOM_INPUT_MAX_CHARACTERS} characters`, "error");
          }
          refresh();
        };

        const handleInput = (data: string): void => {
          if (editMode !== "none") {
            handleEditorInput(data);
            return;
          }

          const visibleOptions = filteredOptions();
          if (optionIndex >= visibleOptions.length) optionIndex = Math.max(0, visibleOptions.length - 1);
          const pageSize = Math.max(1, Math.min(5, Math.ceil(Math.max(1, tui.terminal.rows - 5) / 2)));
          if (keybindings.matches(data, "tui.select.up")) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.down")) {
            optionIndex = Math.min(visibleOptions.length - 1, optionIndex + 1);
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.pageUp")) {
            optionIndex = Math.max(0, optionIndex - pageSize);
            refresh();
            return;
          }
          if (keybindings.matches(data, "tui.select.pageDown")) {
            optionIndex = Math.min(visibleOptions.length - 1, optionIndex + pageSize);
            refresh();
            return;
          }

          const printableInput = decodeQuestionFilterInput(data);
          const isPasteInput = data.includes("\x1B[200~");
          if (mode === "multiple") {
            const selected = visibleOptions[optionIndex];
            if (!isPasteInput && printableInput === " ") {
              if (!selected) return;
              if (selected.isOther) {
                if (customAnswer !== undefined) {
                  customAnswer = undefined;
                  refresh();
                }
              } else togglePredefined(selected);
              return;
            }
            if (!isPasteInput && printableInput === "/") {
              enterFilterMode();
              return;
            }
            if (!isPasteInput && printableInput && /^[1-9]$/u.test(printableInput)) {
              const numbered = visibleOptions[Number(printableInput) - 1];
              if (!numbered) return;
              if (numbered.isOther) enterCustomMode();
              else togglePredefined(numbered);
              return;
            }
            if (keybindings.matches(data, "tui.select.confirm")) {
              if (selected?.isOther) {
                enterCustomMode();
              } else if (selectedCount() < minSelections) {
                ctx.ui.notify(`Select at least ${minSelections} answer${minSelections === 1 ? "" : "s"}`, "error");
              } else {
                finish({ kind: "multiple", ...orderedMultipleSelection() });
              }
              return;
            }
            if (keybindings.matches(data, "tui.select.cancel")) {
              if (filterQuery) {
                filterQuery = "";
                optionIndex = 0;
                refresh();
              } else finish({ kind: "cancelled" });
              return;
            }
            return;
          }

          if (keybindings.matches(data, "tui.select.confirm")) {
            const selected = visibleOptions[optionIndex];
            if (!selected) return;
            if (selected.isOther) enterCustomMode();
            else finish({ kind: "selected", answer: selected.label, originalIndex: selected.originalIndex });
            return;
          }
          if (keybindings.matches(data, "tui.select.cancel")) {
            if (filterQuery) {
              filterQuery = "";
              optionIndex = 0;
              refresh();
            } else finish({ kind: "cancelled" });
            return;
          }
          if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
            if (filterQuery) {
              filterQuery = removeLastGrapheme(filterQuery);
              optionIndex = 0;
              refresh();
            }
            return;
          }
          if (!isPasteInput && printableInput && /^[1-9]$/u.test(printableInput)) {
            const selected = visibleOptions[Number(printableInput) - 1];
            if (!selected) return;
            if (selected.isOther) enterCustomMode();
            else finish({ kind: "selected", answer: selected.label, originalIndex: selected.originalIndex });
            return;
          }
          if (printableInput) appendFilterInput(printableInput);
        };

        const render = (width: number): string[] => {
          if (width <= 0) return [];
          const rowBudget = tui.terminal.rows;
          if (rowBudget <= 0) return [];
          if (cachedLines && cachedWidth === width && cachedRows === rowBudget) return cachedLines;
          const visibleOptions = filteredOptions();
          if (optionIndex >= visibleOptions.length) optionIndex = Math.max(0, visibleOptions.length - 1);
          const selected = visibleOptions[optionIndex];
          const position = `Option ${Math.min(optionIndex + 1, visibleOptions.length)}/${visibleOptions.length}`;
          const editorText = editor.getExpandedText();
          const editorCount = inputCharacterCount(editorText).toLocaleString();
          const filterCount = inputCharacterCount(editMode === "filter" ? editorText : filterQuery).toLocaleString();
          const compactDraft = editorText.replace(/\r\n|\r|\n/gu, " ↵ ") || (editMode === "filter" ? "Type a filter" : "Type an answer");
          const selectionRange = minSelections === maxSelections ? `${minSelections}` : `${minSelections}–${maxSelections}`;
          const selectionStatus = `Selected ${selectedCount()} · required ${selectionRange}`;
          const optionLabel = (option: DisplayOption, index: number): string => {
            if (mode === "single") return `${index === optionIndex ? ">" : " "} ${index + 1}. ${option.label}`;
            const checked = option.isOther ? customAnswer !== undefined : selectedOriginalIndices.has(option.originalIndex);
            const label = option.isOther && customAnswer !== undefined ? `Custom: ${oneLine(customAnswer)}` : option.label;
            return `${index === optionIndex ? ">" : " "} ${checked ? "[x]" : "[ ]"} ${index + 1}. ${label}`;
          };
          const browseHint = mode === "multiple"
            ? `space toggle • / filter • ${keyHint("tui.select.confirm", selected?.isOther ? (customAnswer ? "edit custom" : "add custom") : "submit")} • ${keyHint("tui.select.cancel", filterQuery ? "clear filter" : "cancel")}`
            : `${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`;
          const editHint = `${keyHint("tui.input.submit", editMode === "filter" ? "apply" : "submit")} • ${keyHint("tui.select.cancel", "options")}`;

          let lines: string[];
          if (rowBudget <= 2) {
            if (editMode !== "none") lines = [`${editMode === "filter" ? "Filter" : "Answer"} ${editMode === "filter" ? filterCount : editorCount}/${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()}`, compactDraft];
            else if (mode === "multiple") {
              const focusedRow = selected ? optionLabel(selected, optionIndex) : "";
              const compactSelectionStatus = visibleWidth(selectionStatus) <= width
                ? selectionStatus
                : `Selected ${selectedCount()}`;
              lines = focusedRow && visibleWidth(focusedRow) <= width
                ? [focusedRow, compactSelectionStatus]
                : [compactSelectionStatus, focusedRow];
            } else lines = [`${selected ? `> ${selected.label}` : "No matching options"} · ${position}`];
          } else if (rowBudget <= 5) {
            lines = [
              ...boundedQuestionLines(question, width, Math.max(1, rowBudget - 3)),
              editMode !== "none"
                ? `${editMode === "filter" ? "Filter" : "Answer"} ${editMode === "filter" ? filterCount : editorCount}/${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()}`
                : selected ? optionLabel(selected, optionIndex) : "No matching options",
              editMode !== "none" ? compactDraft : mode === "multiple" ? selectionStatus : filterQuery ? `Filter ${filterCount}/${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()}` : position,
              editMode !== "none" ? editHint : browseHint,
            ];
          } else {
            const questionLines = boundedQuestionLines(question, width, Math.max(1, rowBudget - 5));
            const contentRows = rowBudget - questionLines.length - 4;
            const optionCapacity = Math.max(1, Math.min(5, Math.ceil(contentRows / 2)));
            const detailCapacity = Math.max(0, contentRows - optionCapacity);
            const { start, end } = visibleOptionRange(visibleOptions.length, optionIndex, optionCapacity);
            const hiddenAbove = start > 0 ? `↑ ${start}` : "";
            const hiddenBelowCount = visibleOptions.length - end;
            const hiddenBelow = hiddenBelowCount > 0 ? `↓ ${hiddenBelowCount}` : "";
            const hiddenStatus = [hiddenAbove, hiddenBelow].filter(Boolean).join(" · ");
            const progress = editMode === "filter"
              ? `Filter ${filterCount}/${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()}`
              : editMode === "custom"
                ? `Answer ${editorCount}/${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()}`
                : mode === "multiple"
                  ? `${selectionStatus}${hiddenStatus ? ` · ${hiddenStatus}` : ""}`
                  : filterQuery ? `Filter ${filterCount}/${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} · ${position}` : `${position}${hiddenStatus ? ` · ${hiddenStatus}` : ""}`;
            const navigationHint = editMode !== "none" ? editHint : mode === "multiple"
              ? `${keyHint("tui.select.up", "up")} • ${keyHint("tui.select.down", "down")} • ${browseHint}`
              : `${keyHint("tui.select.up", "up")} • ${keyHint("tui.select.down", "down")} • ${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", filterQuery ? "clear filter" : "cancel")}`;
            lines = [
              theme.fg("accent", "─".repeat(width)),
              ...questionLines.map((line) => theme.fg("text", line)),
              theme.fg("muted", truncateToWidth(` ${progress}`, width, "…")),
            ];
            if (editMode !== "none") {
              const editorLines = editor.render(width);
              const draftLines = editorLines.length > 2 ? editorLines.slice(1, -1) : editorLines;
              lines.push(...(draftLines.length > 0 ? draftLines : [editMode === "filter" ? "Type a filter" : "Type an answer"]).slice(-contentRows));
            } else {
              for (let index = start; index < end; index += 1) {
                const option = visibleOptions[index];
                if (!option) continue;
                const color: ThemeColor = index === optionIndex ? "accent" : "text";
                lines.push(theme.fg(color, truncateToWidth(optionLabel(option, index), width, "…")));
              }
              const detailLines: string[] = [];
              if (selected?.description) detailLines.push(...wrapTextWithAnsi(theme.fg("muted", selected.description), width));
              if (selected?.preview) {
                detailLines.push(theme.fg("accent", theme.bold("Proposal preview")));
                detailLines.push(...new Markdown(selected.preview, 0, 0, {
                  heading: (text) => theme.fg("accent", theme.bold(text)), link: (text) => theme.fg("accent", text),
                  linkUrl: (text) => theme.fg("dim", text), code: (text) => theme.fg("mdCode", text),
                  codeBlock: (text) => theme.fg("mdCodeBlock", text), codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
                  quote: (text) => theme.fg("mdQuote", text), quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
                  hr: (text) => theme.fg("mdHr", text), listBullet: (text) => theme.fg("mdListBullet", text),
                  bold: (text) => theme.bold(text), italic: (text) => theme.italic(text), strikethrough: (text) => theme.strikethrough(text),
                  underline: (text) => theme.underline(text),
                }, { color: (text) => theme.fg("muted", text) }).render(width));
              }
              if (detailCapacity > 0 && detailLines.length > detailCapacity) {
                const visibleDetailRows = Math.max(0, detailCapacity - 1);
                lines.push(...detailLines.slice(0, visibleDetailRows));
                const hiddenRows = detailLines.length - visibleDetailRows;
                lines.push(theme.fg("dim", `… ${hiddenRows} more line${hiddenRows === 1 ? "" : "s"}`));
              } else lines.push(...detailLines.slice(0, detailCapacity));
            }
            lines.push(theme.fg("dim", truncateToWidth(` ${navigationHint}`, width, "…")));
            lines.push(theme.fg("accent", "─".repeat(width)));
          }
          cachedWidth = width;
          cachedRows = rowBudget;
          cachedLines = lines.slice(0, rowBudget).map((line) => boundedRenderLine(line, width, rowBudget <= 5 ? "…" : ""));
          return cachedLines;
        };

        let focused = false;
        return {
          get focused(): boolean { return focused; },
          set focused(value: boolean) { focused = value; editor.focused = value; },
          render,
          handleInput,
          invalidate,
        };
      });

      const abortHandler = (): void => finishFromAbort?.();
      signal?.addEventListener("abort", abortHandler, { once: true });
      if (signal?.aborted) abortHandler();
      let result: QuestionSelection;
      try {
        result = await resultPromise;
      } finally {
        signal?.removeEventListener("abort", abortHandler);
      }

  return result;
}
