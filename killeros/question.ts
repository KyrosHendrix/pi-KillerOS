import { type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  Editor,
  Markdown,
  truncateToWidth,
  wrapTextWithAnsi,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BoundedText } from "./bounded-text.ts";

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200, description: "Display label for the option" }),
  description: Type.Optional(Type.String({ maxLength: 500, description: "Optional detail shown for the selected option" })),
  preview: Type.Optional(Type.String({ maxLength: 8_000, description: "Optional markdown proposal preview shown for the selected option" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 1_000, description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, {
    minItems: 1,
    maxItems: 9,
    description: "Between 1 and 9 options for the user to choose from",
  }),
});

interface DisplayOption {
  label: string;
  description?: string;
  preview?: string;
  originalIndex: number;
  isOther: boolean;
}

interface QuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  selectedIndex?: number;
  wasCustom?: boolean;
  cancelled?: boolean;
}

type QuestionSelection =
  | { kind: "selected"; answer: string; originalIndex: number }
  | { kind: "custom"; answer: string }
  | { kind: "cancelled" }
  | { kind: "aborted" };

const CUSTOM_INPUT_MAX_CHARACTERS = 4_000;
const CUSTOM_INPUT_HISTORY_LIMIT = 100;
const CUSTOM_INPUT_HISTORY_BYTES = 64 * 1024;
const FILTER_QUERY_MAX_CHARACTERS = 4_000;
const FILTER_QUERY_MAX_BYTES = 16_000;

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

function oneLine(value: string): string {
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
  visible[rowLimit - 1] = truncateToWidth(visible[rowLimit - 1]!, width, "…");
  return visible;
}

export function registerQuestionTool(pi: ExtensionAPI): void {
  const customInputHistory: string[] = [];
  let customInputHistoryBytes = 0;
  const clearCustomInputHistory = (): void => {
    customInputHistory.length = 0;
    customInputHistoryBytes = 0;
  };
  const rememberCustomInput = (value: string): boolean => {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > CUSTOM_INPUT_HISTORY_BYTES) return false;
    const existingIndex = customInputHistory.indexOf(value);
    if (existingIndex >= 0) {
      customInputHistoryBytes -= Buffer.byteLength(customInputHistory[existingIndex]!, "utf8");
      customInputHistory.splice(existingIndex, 1);
    }
    while (customInputHistory.length >= CUSTOM_INPUT_HISTORY_LIMIT || customInputHistoryBytes + bytes > CUSTOM_INPUT_HISTORY_BYTES) {
      const removed = customInputHistory.shift();
      if (removed !== undefined) customInputHistoryBytes -= Buffer.byteLength(removed, "utf8");
    }
    customInputHistory.push(value);
    customInputHistoryBytes += bytes;
    return true;
  };
  const inputCharacterCount = (value: string): number => {
    let count = 0;
    for (const _character of value) count += 1;
    return count;
  };
  pi.on("session_start", clearCustomInputHistory);
  pi.on("session_tree", clearCustomInputHistory);
  pi.on("session_shutdown", clearCustomInputHistory);

  pi.registerTool<typeof QuestionParams, QuestionDetails>({
    name: "question",
    label: "Question",
    description: `Ask one interactive multiple-choice question. Provide 1-9 concise options. The user can filter options or type a custom answer. Filter queries are limited to ${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} characters and ${FILTER_QUERY_MAX_BYTES.toLocaleString()} bytes.`,
    promptSnippet: "Ask the user one multiple-choice question when a decision is required to proceed",
    promptGuidelines: [
      "Use question only when user input is required to choose between concrete alternatives; do not use question for rhetorical or optional follow-up prompts.",
    ],
    parameters: QuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error("The question tool requires interactive TUI mode");
      if (signal?.aborted) throw new Error("Question cancelled before it opened");

      const options: DisplayOption[] = [
        ...params.options.map((option, index) => ({
          label: option.label,
          description: option.description,
          preview: option.preview,
          originalIndex: index + 1,
          isOther: false,
        })),
        {
          label: "Type a custom answer",
          originalIndex: params.options.length + 1,
          isOther: true,
        },
      ];

      let finishFromAbort: (() => void) | undefined;
      const resultPromise = ctx.ui.custom<QuestionSelection>((tui, theme, keybindings, done) => {
        let optionIndex = 0;
        let editMode = false;
        let filterQuery = "";
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

        const keyHint = (
          keybinding: Parameters<typeof keybindings.getKeys>[0],
          description: string,
        ): string => {
          const keyText = keybindings.getKeys(keybinding)
            .join("/")
            .split("/")
            .map((key) => key
              .split("+")
              .map((part) => process.platform === "darwin" && part.toLocaleLowerCase() === "alt" ? "option" : part)
              .join("+"))
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
          const query = filterQuery.trim().toLocaleLowerCase();
          return options.filter((option) => option.isOther
            || query.length === 0
            || option.label.toLocaleLowerCase().includes(query)
            || option.description?.toLocaleLowerCase().includes(query));
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

        const appendFilterInput = (value: string): void => {
          const nextCharacters = inputCharacterCount(filterQuery) + inputCharacterCount(value);
          const nextBytes = Buffer.byteLength(filterQuery, "utf8") + Buffer.byteLength(value, "utf8");
          if (nextCharacters > FILTER_QUERY_MAX_CHARACTERS || nextBytes > FILTER_QUERY_MAX_BYTES) {
            ctx.ui.notify(
              `Question filters are limited to ${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} characters and ${FILTER_QUERY_MAX_BYTES.toLocaleString()} bytes`,
              "error",
            );
            return;
          }
          filterQuery += value;
          optionIndex = 0;
          refresh();
        };

        editor.onSubmit = (value) => {
          const answer = value.trim();
          if (answer) {
            if (inputCharacterCount(answer) > CUSTOM_INPUT_MAX_CHARACTERS) {
              ctx.ui.notify(`Custom answers are limited to ${CUSTOM_INPUT_MAX_CHARACTERS} characters`, "error");
              return;
            }
            if (!rememberCustomInput(answer)) {
              ctx.ui.notify(`Custom answer history is limited to ${CUSTOM_INPUT_HISTORY_BYTES} bytes`, "error");
              return;
            }
            finish({ kind: "custom", answer });
            return;
          }
          editMode = false;
          editor.setText("");
          refresh();
        };

        const enterCustomMode = (): void => {
          editMode = true;
          refresh();
        };

        const handleInput = (data: string): void => {
          if (editMode) {
            if (keybindings.matches(data, "tui.select.cancel")) {
              editMode = false;
              editor.setText("");
              refresh();
              return;
            }
            const before = editor.getExpandedText();
            editor.handleInput(data);
            const after = editor.getExpandedText();
            if (inputCharacterCount(after) > CUSTOM_INPUT_MAX_CHARACTERS) {
              editor.setText(before);
              ctx.ui.notify(`Custom answers are limited to ${CUSTOM_INPUT_MAX_CHARACTERS} characters`, "error");
            }
            refresh();
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
            } else {
              finish({ kind: "cancelled" });
            }
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
          const printableInput = decodeQuestionFilterInput(data);
          const isPasteInput = data.includes("\x1B[200~");
          if (!isPasteInput && printableInput && /^[1-9]$/.test(printableInput)) {
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
          const renderWidth = width;
          const rowBudget = Math.max(1, tui.terminal.rows);
          if (cachedLines && cachedWidth === renderWidth && cachedRows === rowBudget) return cachedLines;
          const visibleOptions = filteredOptions();
          if (optionIndex >= visibleOptions.length) optionIndex = Math.max(0, visibleOptions.length - 1);
          const selected = visibleOptions[optionIndex];
          const position = `Option ${Math.min(optionIndex + 1, visibleOptions.length)}/${visibleOptions.length}`;
          const expandedAnswer = editor.getExpandedText();
          const answerCount = inputCharacterCount(expandedAnswer).toLocaleString();
          const filterCount = inputCharacterCount(filterQuery).toLocaleString();
          const compactDraft = expandedAnswer.replace(/\r\n|\r|\n/gu, " ↵ ") || "Type an answer";

          if (rowBudget <= 2) {
            const compact = editMode
              ? [`Answer ${answerCount}/${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()}`, compactDraft]
              : [`${selected ? `> ${selected.label}` : "No matching options"} · ${position}`];
            cachedWidth = renderWidth;
            cachedRows = rowBudget;
            cachedLines = compact.slice(0, rowBudget).map((line) => boundedRenderLine(line, renderWidth, "…"));
            return cachedLines;
          }

          if (rowBudget <= 5) {
            const compact = [
              ...boundedQuestionLines(params.question, renderWidth, Math.max(1, rowBudget - 3)),
              editMode
                ? `Answer ${answerCount}/${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()}`
                : `${selected ? `> ${selected.label}` : "No matching options"} · ${position}`,
              editMode
                ? compactDraft
                : filterQuery
                  ? `Filter ${filterCount}/${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()}`
                  : position,
              editMode
                ? `${keyHint("tui.input.submit", "submit")} • ${keyHint("tui.select.cancel", "options")}`
                : `${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`,
            ];
            cachedWidth = renderWidth;
            cachedRows = rowBudget;
            cachedLines = compact.slice(0, rowBudget).map((line) => boundedRenderLine(line, renderWidth, "…"));
            return cachedLines;
          }

          const questionLines = boundedQuestionLines(params.question, renderWidth, Math.max(1, rowBudget - 5));
          const contentRows = rowBudget - questionLines.length - 4;
          const optionCapacity = Math.max(1, Math.min(5, Math.ceil(contentRows / 2)));
          const detailCapacity = Math.max(0, contentRows - optionCapacity);
          const { start, end } = visibleOptionRange(visibleOptions.length, optionIndex, optionCapacity);
          const hiddenAbove = start > 0 ? `↑ ${start}` : "";
          const hiddenBelowCount = visibleOptions.length - end;
          const hiddenBelow = hiddenBelowCount > 0 ? `↓ ${hiddenBelowCount}` : "";
          const hiddenStatus = [hiddenAbove, hiddenBelow].filter(Boolean).join(" · ");
          const progress = editMode
            ? `Answer ${answerCount}/${CUSTOM_INPUT_MAX_CHARACTERS.toLocaleString()}`
            : filterQuery
              ? `Filter ${filterCount}/${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} · ${position}`
              : `${position}${hiddenStatus ? ` · ${hiddenStatus}` : ""}`;
          const hint = editMode
            ? `${keyHint("tui.input.submit", "submit")} • ${keyHint("tui.select.cancel", "options")}`
            : `${keyHint("tui.select.up", "up")} • ${keyHint("tui.select.down", "down")} • ${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", filterQuery ? "clear filter" : "cancel")}`;
          const lines: string[] = [
            theme.fg("accent", "─".repeat(renderWidth)),
            ...questionLines.map((line) => theme.fg("text", line)),
            theme.fg("muted", truncateToWidth(` ${progress}`, renderWidth, "…")),
          ];

          if (editMode) {
            const editorLines = editor.render(renderWidth);
            const draftLines = editorLines.length > 2 ? editorLines.slice(1, -1) : editorLines;
            lines.push(...(draftLines.length > 0 ? draftLines : ["Type an answer"]).slice(-contentRows));
          } else {
            for (let index = start; index < end; index += 1) {
              const option = visibleOptions[index]!;
              const isSelected = index === optionIndex;
              const prefix = isSelected ? "> " : "  ";
              const color: ThemeColor = isSelected ? "accent" : "text";
              lines.push(theme.fg(color, truncateToWidth(`${prefix}${index + 1}. ${option.label}`, renderWidth, "…")));
            }

            const detailLines: string[] = [];
            if (selected?.description) detailLines.push(...wrapTextWithAnsi(theme.fg("muted", selected.description), renderWidth));
            if (selected?.preview) {
              detailLines.push(theme.fg("accent", theme.bold("Proposal preview")));
              detailLines.push(...new Markdown(
                selected.preview,
                0,
                0,
                {
                  heading: (text) => theme.fg("accent", theme.bold(text)),
                  link: (text) => theme.fg("accent", text),
                  linkUrl: (text) => theme.fg("dim", text),
                  code: (text) => theme.fg("mdCode", text),
                  codeBlock: (text) => theme.fg("mdCodeBlock", text),
                  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
                  quote: (text) => theme.fg("mdQuote", text),
                  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
                  hr: (text) => theme.fg("mdHr", text),
                  listBullet: (text) => theme.fg("mdListBullet", text),
                  bold: (text) => theme.bold(text),
                  italic: (text) => theme.italic(text),
                  strikethrough: (text) => theme.strikethrough(text),
                  underline: (text) => theme.underline(text),
                },
                { color: (text) => theme.fg("muted", text) },
              ).render(renderWidth));
            }
            if (detailCapacity > 0 && detailLines.length > detailCapacity) {
              const visibleDetailRows = Math.max(0, detailCapacity - 1);
              lines.push(...detailLines.slice(0, visibleDetailRows));
              const hiddenRows = detailLines.length - visibleDetailRows;
              lines.push(theme.fg("dim", `… ${hiddenRows} more line${hiddenRows === 1 ? "" : "s"}`));
            } else {
              lines.push(...detailLines.slice(0, detailCapacity));
            }
          }

          lines.push(theme.fg("dim", truncateToWidth(` ${hint}`, renderWidth, "…")));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedWidth = renderWidth;
          cachedRows = rowBudget;
          cachedLines = lines.slice(0, rowBudget).map((line) => boundedRenderLine(line, renderWidth, ""));
          return cachedLines;
        };

        let focused = false;
        return {
          get focused(): boolean { return focused; },
          set focused(value: boolean) {
            focused = value;
            editor.focused = value;
          },
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

      const simpleOptions = params.options.map((option) => option.label);
      if (result.kind === "aborted") throw new Error("Question cancelled because the agent operation was aborted");
      if (result.kind === "cancelled") {
        return {
          content: [{ type: "text", text: "User cancelled the question" }],
          details: { question: params.question, options: simpleOptions, answer: null, cancelled: true },
        };
      }
      if (result.kind === "custom") {
        return {
          content: [{ type: "text", text: `User wrote: ${result.answer}` }],
          details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: true },
        };
      }
      return {
        content: [{ type: "text", text: `User selected: ${result.answer}` }],
        details: {
          question: params.question,
          options: simpleOptions,
          answer: result.answer,
          selectedIndex: result.originalIndex,
          wasCustom: false,
        },
      };
    },

    renderCall(args, theme, context) {
      if (!context.expanded) {
        const summary = `${theme.fg("toolTitle", theme.bold("question "))}${theme.fg("muted", oneLine(args.question))}\n${theme.fg("dim", `  ${args.options.length} option${args.options.length === 1 ? "" : "s"}`)}`;
        return new BoundedText(summary, 3);
      }

      const lines = [`${theme.fg("toolTitle", theme.bold("question "))}${theme.fg("muted", args.question)}`];
      args.options.forEach((option, index) => {
        lines.push(theme.fg("text", `${index + 1}. ${option.label}`));
        if (option.description) lines.push(theme.fg("muted", `   ${option.description}`));
        if (option.preview) lines.push(theme.fg("dim", option.preview));
      });
      lines.push(theme.fg("text", `${args.options.length + 1}. Type a custom answer`));
      return new BoundedText(lines.join("\n"));
    },

    renderResult(result, options, theme) {
      const details = result.details;
      if (!details) {
        const first = result.content[0];
        return new BoundedText(first?.type === "text" ? first.text : "", options.expanded ? undefined : 3);
      }
      if (details.cancelled || details.answer === null) return new BoundedText(theme.fg("warning", "Cancelled"));
      if (details.wasCustom) {
        const text = `${theme.fg("success", "✓ ")}${theme.fg("muted", "(wrote) ")}${theme.fg("accent", details.answer)}`;
        return new BoundedText(text, options.expanded ? undefined : 3);
      }
      return new BoundedText(`${theme.fg("success", "✓ ")}${theme.fg("accent", details.answer)}`);
    },
  });
}
