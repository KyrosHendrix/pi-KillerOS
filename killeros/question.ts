import { type ExtensionAPI, type ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  Editor,
  Key,
  Markdown,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorTheme,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

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
      const resultPromise = ctx.ui.custom<QuestionSelection>((tui, theme, _keybindings, done) => {
        let optionIndex = 0;
        let editMode = false;
        let filterQuery = "";
        let cachedWidth: number | undefined;
        let cachedLines: string[] | undefined;
        let completed = false;

        const finish = (selection: QuestionSelection): void => {
          if (completed) return;
          completed = true;
          done(selection);
        };
        finishFromAbort = () => finish({ kind: "aborted" });

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
            if (matchesKey(data, Key.escape)) {
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
          if (matchesKey(data, Key.up)) {
            optionIndex = Math.max(0, optionIndex - 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = Math.min(visibleOptions.length - 1, optionIndex + 1);
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const selected = visibleOptions[optionIndex];
            if (!selected) return;
            if (selected.isOther) enterCustomMode();
            else finish({ kind: "selected", answer: selected.label, originalIndex: selected.originalIndex });
            return;
          }
          if (matchesKey(data, Key.escape)) {
            if (filterQuery) {
              filterQuery = "";
              optionIndex = 0;
              refresh();
            } else {
              finish({ kind: "cancelled" });
            }
            return;
          }
          if (matchesKey(data, Key.backspace)) {
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
          if (printableInput) {
            appendFilterInput(printableInput);
          }
        };

        const render = (width: number): string[] => {
          const renderWidth = Math.max(1, width);
          if (cachedLines && cachedWidth === renderWidth) return cachedLines;
          const lines: string[] = [];
          const addWrapped = (text: string): void => {
            lines.push(...wrapTextWithAnsi(text, renderWidth));
          };
          const addWrappedWithPrefix = (prefix: string, text: string): void => {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= renderWidth) {
              addWrapped(prefix + text);
              return;
            }
            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
            const continuation = " ".repeat(prefixWidth);
            wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
          };

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          addWrappedWithPrefix(" ", theme.fg("text", params.question));
          lines.push("");
          if (!editMode && filterQuery) {
            addWrappedWithPrefix(" ", `${theme.fg("muted", "Filter: ")}${theme.fg("accent", filterQuery)}`);
            lines.push("");
          }

          const visibleOptions = filteredOptions();
          if (optionIndex >= visibleOptions.length) optionIndex = Math.max(0, visibleOptions.length - 1);
          visibleOptions.forEach((option, index) => {
            const selected = index === optionIndex;
            const prefix = selected ? theme.fg("accent", "> ") : "  ";
            const color: ThemeColor = selected ? "accent" : "text";
            addWrappedWithPrefix(prefix, theme.fg(color, `${index + 1}. ${option.label}`));
            if (selected && option.description) {
              addWrappedWithPrefix("    ", theme.fg("muted", option.description));
            }
          });

          const selectedPreview = visibleOptions[optionIndex]?.preview;
          if (!editMode && selectedPreview) {
            const footerRows = 3;
            const previewChromeRows = 2;
            const availableRows = tui.terminal.rows - lines.length - footerRows;
            if (availableRows > previewChromeRows) {
              lines.push("");
              addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Proposal preview")));
              const markdownLines = new Markdown(
                selectedPreview,
                1,
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
              ).render(renderWidth);
              const maxPreviewRows = Math.min(12, availableRows - previewChromeRows);
              if (markdownLines.length <= maxPreviewRows) {
                lines.push(...markdownLines);
              } else {
                const visiblePreviewRows = Math.max(0, maxPreviewRows - 1);
                lines.push(...markdownLines.slice(0, visiblePreviewRows));
                const hiddenRows = markdownLines.length - visiblePreviewRows;
                lines.push(theme.fg("dim", ` … ${hiddenRows} more line${hiddenRows === 1 ? "" : "s"}`));
              }
            }
          }

          if (editMode) {
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
            editor.render(Math.max(1, renderWidth - 2)).forEach((line) => lines.push(` ${line}`));
          }

          lines.push("");
          const hint = editMode
            ? `Enter submit • Esc options${customInputHistory.length ? " • ↑↓ history" : ""}`
            : filterQuery
              ? "1-9 select • ↑↓ navigate • Enter select • Esc clear filter"
              : "1-9 select • type to filter • ↑↓ navigate • Enter select • Esc cancel";
          addWrappedWithPrefix(" ", theme.fg("dim", hint));
          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedWidth = renderWidth;
          cachedLines = lines.map((line) => truncateToWidth(line, renderWidth, ""));
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

    renderCall(args, theme) {
      let text = `${theme.fg("toolTitle", theme.bold("question "))}${theme.fg("muted", args.question)}`;
      if (args.options.length) {
        const numbered = [...args.options.map((option) => option.label), "Type a custom answer"]
          .map((option, index) => `${index + 1}. ${option}`);
        text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled || details.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      if (details.wasCustom) {
        return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", "(wrote) ")}${theme.fg("accent", details.answer)}`, 0, 0);
      }
      return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", details.answer)}`, 0, 0);
    },
  });
}
