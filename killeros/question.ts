import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BoundedText } from "./bounded-text.ts";
import { CUSTOM_INPUT_HISTORY_BYTES, CUSTOM_INPUT_HISTORY_LIMIT, FILTER_QUERY_MAX_BYTES, FILTER_QUERY_MAX_CHARACTERS, MultipleResultText, oneLine, openQuestionUi, type DisplayOption } from "./question-ui.ts";
import { safeTerminalText } from "./safe-terminal-text.ts";

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
  mode: Type.Optional(StringEnum(["single", "multiple"] as const, {
    description: "Choose one answer or multiple answers; defaults to single",
  })),
  minSelections: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: "Minimum answers required in multiple mode; defaults to 1. Single mode accepts only an explicit 1/1 bounds pair",
  })),
  maxSelections: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    description: "Maximum answers allowed in multiple mode; defaults to all options plus one custom answer. Single mode accepts only an explicit 1/1 bounds pair",
  })),
});

type QuestionParamsValue = Static<typeof QuestionParams>;

type NormalizedQuestionSelection =
  | { mode: "single"; minSelections: 1; maxSelections: 1 }
  | { mode: "multiple"; minSelections: number; maxSelections: number };

function normalizeQuestionSelection(params: QuestionParamsValue): NormalizedQuestionSelection {
  const mode = params.mode ?? "single";
  if (mode === "single") {
    const hasSelectionBounds = params.minSelections !== undefined || params.maxSelections !== undefined;
    if (hasSelectionBounds && (params.minSelections !== 1 || params.maxSelections !== 1)) {
      throw new Error("Single-select question bounds must be omitted or both be 1");
    }
    return { mode, minSelections: 1, maxSelections: 1 };
  }

  const maximumAvailable = params.options.length + 1;
  const minSelections = params.minSelections ?? 1;
  const maxSelections = params.maxSelections ?? maximumAvailable;
  if (minSelections > maxSelections) {
    throw new Error("Question minimum selections cannot exceed maximum selections");
  }
  if (maxSelections > maximumAvailable) {
    throw new Error(`Question allows at most ${maximumAvailable} selections including one custom answer`);
  }
  return { mode, minSelections, maxSelections };
}

interface SingleQuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  selectedIndex?: number;
  wasCustom?: boolean;
  cancelled?: boolean;
}

interface MultipleQuestionDetails {
  question: string;
  options: string[];
  mode: "multiple";
  answers: string[];
  selectedIndices: number[];
  customAnswer?: string;
  cancelled?: boolean;
}

type QuestionDetails = SingleQuestionDetails | MultipleQuestionDetails;

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
      const existing = customInputHistory[existingIndex];
      if (existing !== undefined) customInputHistoryBytes -= Buffer.byteLength(existing, "utf8");
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
  pi.on("session_start", clearCustomInputHistory);
  pi.on("session_tree", clearCustomInputHistory);
  pi.on("session_shutdown", clearCustomInputHistory);

  const questionTool: ToolDefinition<typeof QuestionParams, QuestionDetails> = {
    name: "question",
    label: "Question",
    description: `Ask one interactive multiple-choice question. Provide 1-9 concise options. Single-select is the default; opt into bounded multi-select with mode "multiple". The user can filter options or type a custom answer. Filter queries are limited to ${FILTER_QUERY_MAX_CHARACTERS.toLocaleString()} characters and ${FILTER_QUERY_MAX_BYTES.toLocaleString()} bytes.`,
    promptSnippet: "Ask the user one multiple-choice question when a decision is required to proceed",
    promptGuidelines: [
      "Use question only when user input is required to choose between concrete alternatives; do not use question for rhetorical or optional follow-up prompts.",
      "Use multiple mode only when the user may need to choose more than one answer; ordinary either/or decisions remain single-select.",
    ],
    parameters: QuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { mode, minSelections, maxSelections } = normalizeQuestionSelection(params);
      if (ctx.mode !== "tui") throw new Error("The question tool requires interactive TUI mode");
      if (signal?.aborted) throw new Error("Question cancelled before it opened");

      const question = safeTerminalText(params.question);
      const options: DisplayOption[] = [
        ...params.options.map((option, index) => ({
          label: safeTerminalText(option.label),
          description: option.description === undefined ? undefined : safeTerminalText(option.description),
          preview: option.preview === undefined ? undefined : safeTerminalText(option.preview),
          originalIndex: index + 1,
          isOther: false,
        })),
        { label: "Type a custom answer", originalIndex: params.options.length + 1, isOther: true },
      ];

      const result = await openQuestionUi({
        ctx,
        signal,
        question,
        options,
        originalOptions: params.options,
        mode,
        minSelections,
        maxSelections,
        customInputHistory,
        rememberCustomInput,
      });

      const simpleOptions = params.options.map((option) => option.label);
      if (result.kind === "aborted") throw new Error("Question cancelled because the agent operation was aborted");
      if (result.kind === "cancelled" && mode === "multiple") {
        return {
          content: [{ type: "text", text: "User cancelled the question" }],
          details: { question: params.question, options: simpleOptions, mode: "multiple", answers: [], selectedIndices: [], cancelled: true },
        };
      }
      if (result.kind === "multiple") {
        return {
          content: [{ type: "text", text: `User selected multiple answers:\n${result.answers.map((answer) => `- ${answer}`).join("\n")}` }],
          details: {
            question: params.question, options: simpleOptions, mode: "multiple", answers: result.answers,
            selectedIndices: result.selectedIndices, ...(result.customAnswer === undefined ? {} : { customAnswer: result.customAnswer }),
          },
        };
      }
      if (result.kind === "cancelled") {
        return { content: [{ type: "text", text: "User cancelled the question" }], details: { question: params.question, options: simpleOptions, answer: null, cancelled: true } };
      }
      if (result.kind === "custom") {
        return { content: [{ type: "text", text: `User wrote: ${result.answer}` }], details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: true } };
      }
      return {
        content: [{ type: "text", text: `User selected: ${result.answer}` }],
        details: { question: params.question, options: simpleOptions, answer: result.answer, selectedIndex: result.originalIndex, wasCustom: false },
      };
    },

    renderCall(args, theme, context) {
      const { mode, minSelections: minimum, maxSelections: maximum } = normalizeQuestionSelection(args);
      const multiple = mode === "multiple";
      const question = safeTerminalText(args.question);
      const options = args.options.map((option) => ({
        label: safeTerminalText(option.label),
        description: option.description === undefined ? undefined : safeTerminalText(option.description),
        preview: option.preview === undefined ? undefined : safeTerminalText(option.preview),
      }));
      if (!context.expanded) {
        const title = multiple ? "question (multi-select) " : "question ";
        const detail = multiple ? `${options.length} options · choose ${minimum}–${maximum}` : `${options.length} option${options.length === 1 ? "" : "s"}`;
        return new BoundedText(`${theme.fg("toolTitle", theme.bold(title))}${theme.fg("muted", oneLine(question))}\n${theme.fg("dim", `  ${detail}`)}`, 3);
      }
      const title = multiple ? "question (multi-select) " : "question ";
      const lines = [`${theme.fg("toolTitle", theme.bold(title))}${theme.fg("muted", question)}`];
      if (multiple) lines.push(theme.fg("dim", `${options.length} options · choose ${minimum}–${maximum}`));
      options.forEach((option, index) => {
        lines.push(theme.fg("text", `${multiple ? "[ ] " : ""}${index + 1}. ${option.label}`));
        if (option.description) lines.push(theme.fg("muted", `   ${option.description}`));
        if (option.preview) lines.push(theme.fg("dim", option.preview));
      });
      lines.push(theme.fg("text", `${multiple ? "[ ] " : ""}${options.length + 1}. Type a custom answer`));
      return new BoundedText(lines.join("\n"));
    },

    renderResult(result, options, theme) {
      const details = result.details;
      if (!details) {
        const first = result.content[0];
        return new BoundedText(first?.type === "text" ? safeTerminalText(first.text) : "", options.expanded ? undefined : 3);
      }
      if (details.cancelled || ("answer" in details && details.answer === null)) return new BoundedText(theme.fg("warning", "Cancelled"));
      if ("mode" in details && details.mode === "multiple") {
        const answers = details.answers.map(safeTerminalText);
        const customAnswer = details.customAnswer === undefined ? undefined : safeTerminalText(details.customAnswer);
        return new MultipleResultText(answers, options.expanded, customAnswer, theme.fg.bind(theme));
      }
      if (!("answer" in details) || details.answer === null) return new BoundedText("");
      const answer = safeTerminalText(details.answer);
      if (details.wasCustom) {
        return new BoundedText(`${theme.fg("success", "✓ ")}${theme.fg("muted", "(wrote) ")}${theme.fg("accent", answer)}`, options.expanded ? undefined : 3);
      }
      return new BoundedText(`${theme.fg("success", "✓ ")}${theme.fg("accent", answer)}`);
    },
  };
  pi.registerTool(questionTool);
}
