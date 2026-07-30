import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import {
  CustomEditor,
  DynamicBorder,
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  decodeKittyPrintable,
  Editor,
  Key,
  matchesKey,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const COMMAND_BLUE_RGB = "120;169;255";
const FOOTER_REFRESH_INTERVAL_MS = 1_000;
const COMPACT_HEADER_MAX_WIDTH = 52;

const commandBlue = (text: string): string => `\x1B[38;2;${COMMAND_BLUE_RGB}m${text}\x1B[39m`;

function readPackageVersion(path: string | URL): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

const KILLEROS_VERSION = readPackageVersion(new URL("./package.json", import.meta.url));

const STARTUP_TIPS = [
  "Press Shift+Enter to insert a line break without sending.",
  "Run /variants to tune the model's reasoning depth.",
  "Type / to browse every command available in this session.",
] as const;

function resolveGitBranch(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
      windowsHide: true,
    }).trim();
    if (!branch) return undefined;
    return branch === "HEAD" ? "detached" : branch;
  } catch {
    return undefined;
  }
}

function shuffledTips(): string[] {
  const tips = [...STARTUP_TIPS];
  for (let index = tips.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [tips[index], tips[swapIndex]] = [tips[swapIndex]!, tips[index]!];
  }
  return tips;
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) return cwd;
  const normalizedHome = home.replace(/[\\/]+$/, "");
  const normalizedCwd = cwd.replace(/[\\/]+$/, "");
  if (normalizedCwd === normalizedHome) return "~";
  const separator = normalizedCwd.slice(normalizedHome.length, normalizedHome.length + 1);
  return normalizedCwd.startsWith(normalizedHome) && (separator === "/" || separator === "\\")
    ? `~${normalizedCwd.slice(normalizedHome.length)}`
    : cwd;
}

function padRight(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function compactBoxLine(content: string, width: number, theme: Theme): string {
  if (width < 4) return truncateToWidth(content, width, "");
  return `${theme.fg("dim", "│")} ${padRight(content, width - 4)} ${theme.fg("dim", "│")}`;
}

class PiStartupHeader {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly branch: string | undefined;
  private readonly tip: string;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, tip: string) {
    this.pi = pi;
    this.ctx = ctx;
    this.branch = resolveGitBranch(ctx.cwd);
    this.tip = tip;
  }

  private tipLines(width: number, theme: Theme): string[] {
    const indent = "  ";
    const text = `${theme.fg("text", theme.bold("Tip:"))}${theme.fg("dim", ` ${this.tip}`)}`;
    return wrapTextWithAnsi(text, width - indent.length)
      .map((line) => padRight(`${indent}${line}`, width));
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.ctx.ui.theme;
    if (width < 28) return [truncateToWidth(theme.fg("text", theme.bold("KillerOS")), width, "")];

    const panelWidth = Math.min(width, COMPACT_HEADER_MAX_WIDTH);
    const innerWidth = panelWidth - 4;
    const version = KILLEROS_VERSION ? theme.fg("dim", ` (v${KILLEROS_VERSION})`) : "";
    const identity = `${theme.fg("dim", "›")} ${theme.fg("text", theme.bold("KillerOS"))}${version}`;
    const thinkingLevel = this.pi.getThinkingLevel() as ThinkingLevel;
    const reasoning = this.ctx.model?.reasoning === false
      ? theme.fg("thinkingOff", "no reasoning")
      : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
    const agent = `${formatModel(this.ctx.model, theme)}${theme.fg("dim", " · ")}${reasoning}`;
    const directory = formatCwd(this.ctx.cwd);
    const repository = this.branch
      ? `${directory} ${theme.fg("dim", `· ${this.branch}`)}`
      : directory;
    const modelCommand = commandBlue("/model");
    const agentWidth = Math.max(0, innerWidth - visibleWidth(modelCommand) - 1);
    const agentCommand = `${truncateToWidth(agent, agentWidth, "…")} ${modelCommand}`;
    const border = (left: string, right: string): string => theme.fg("dim", `${left}${"─".repeat(panelWidth - 2)}${right}`);
    const lines = [
      border("╭", "╮"),
      compactBoxLine(identity, panelWidth, theme),
      compactBoxLine("", panelWidth, theme),
      compactBoxLine(agentCommand, panelWidth, theme),
      compactBoxLine(repository, panelWidth, theme),
      border("╰", "╯"),
      " ".repeat(panelWidth),
      ...this.tipLines(panelWidth, theme),
    ];
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

const ANSI_REGEX = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "").trim();
}

function isBorderLine(line: string): boolean {
  const unstyled = stripAnsi(line);
  return /^[─━═]+$/.test(unstyled) || /^───\s*[↓↑]/.test(unstyled) || /^─{3,}/.test(unstyled);
}

class PiCodeEditor extends CustomEditor {
  private readonly appKeybindings: KeybindingsManager;

  constructor(tui: TUI, theme: EditorTheme, appKeybindings: KeybindingsManager) {
    super(tui, theme, appKeybindings);
    this.appKeybindings = appKeybindings;
  }

  override handleInput(data: string): void {
    const isShiftEnter = data === "\x1B[13;2u"
      || data === "\x1B[13;2~"
      || data === "\x1B[27;2;13~"
      || data === "\x1B\r"
      || data === "\x1B\n"
      || this.appKeybindings.matches(data, "tui.input.newLine");
    if (isShiftEnter) {
      this.insertTextAtCursor("\n");
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    if (width < 4) return super.render(width);
    const innerWidth = width - 2;
    const lines = super.render(innerWidth);
    if (lines.length < 2) return lines.map((line) => truncateToWidth(line, width, ""));

    const gray = (text: string): string => `\x1B[90m${text}\x1B[39m`;
    let bottomBorderIndex = -1;
    for (let index = lines.length - 1; index >= 1; index -= 1) {
      if (isBorderLine(lines[index] ?? "")) {
        bottomBorderIndex = index;
        break;
      }
    }
    if (bottomBorderIndex < 0) bottomBorderIndex = lines.length - 1;

    const framed: string[] = [];
    const top = stripAnsi(lines[0] ?? "");
    const isScrolledHeader = top.includes("↑");
    if (isScrolledHeader) {
      const count = top.match(/↑\s*(\d+)/)?.[1] ?? "";
      const indicator = `${gray("─── ↑ ")}${count}${gray(" more ")}${gray("─".repeat(Math.max(0, width - 12 - count.length)))}`;
      framed.push(truncateToWidth(indicator, width, ""));
    } else {
      framed.push(gray("─".repeat(width)));
    }

    for (let index = 1; index < bottomBorderIndex; index += 1) {
      const prefix = index === 1 && !isScrolledHeader ? gray("❯ ") : "  ";
      framed.push(`${prefix}${padRight(lines[index] ?? "", innerWidth)}`);
    }

    const bottom = stripAnsi(lines[bottomBorderIndex] ?? "");
    if (bottom.includes("↓")) {
      const count = bottom.match(/↓\s*(\d+)/)?.[1] ?? "";
      const indicator = `${gray("─── ↓ ")}${count}${gray(" more ")}${gray("─".repeat(Math.max(0, width - 12 - count.length)))}`;
      framed.push(truncateToWidth(indicator, width, ""));
    } else {
      framed.push(gray("─".repeat(width)));
    }

    for (let index = bottomBorderIndex + 1; index < lines.length; index += 1) {
      framed.push(`  ${padRight(lines[index] ?? "", innerWidth)}`);
    }
    return framed.map((line) => truncateToWidth(line, width, ""));
  }
}

function reportError(ctx: ExtensionContext, area: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.ui.notify(`${area}: ${message}`, "error");
}

const ACTIVITY_WORDS = ["Brewing", "Pondering", "Tinkering", "Wrangling", "Noodling", "Cooking"] as const;

function registerShellUi(pi: ExtensionAPI): void {
  let activeHeader: PiStartupHeader | undefined;
  let activityWordIndex = 0;
  let tipDeck: string[] = [];
  const nextStartupTip = (): string => {
    if (tipDeck.length === 0) tipDeck = shuffledTips();
    return tipDeck.pop() ?? STARTUP_TIPS[0];
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setTheme("killeros");
      const startupTip = nextStartupTip();
      ctx.ui.setHeader(() => {
        activeHeader?.dispose();
        activeHeader = new PiStartupHeader(pi, ctx, startupTip);
        return activeHeader;
      });
      ctx.ui.setWorkingIndicator({
        frames: [
          ctx.ui.theme.fg("dim", "✻"),
          ctx.ui.theme.fg("muted", "✻"),
          ctx.ui.theme.fg("accent", "✻"),
          ctx.ui.theme.fg("muted", "✻"),
        ],
        intervalMs: 180,
      });
      ctx.ui.setHiddenThinkingLabel("└ Thinking…");
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new PiCodeEditor(tui, theme, keybindings));
    } catch (error) {
      reportError(ctx, "Killeros UI failed to initialize", error);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage(`${ACTIVITY_WORDS[activityWordIndex]}…`);
    activityWordIndex = (activityWordIndex + 1) % ACTIVITY_WORDS.length;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", () => {
    activeHeader?.dispose();
    activeHeader = undefined;
    activityWordIndex = 0;
  });
}

export const CONCISE_SYSTEM_PROMPT = `
# Concise output rules
1. Start with the answer or next action; omit conversational preambles.
2. Use numbered steps only when order matters, with one bounded action per step.
3. Finish the primary task before mentioning optional follow-up work.
4. State failures directly and include the recovery action.
5. Keep lists focused; group long inventories under clear headings.
6. Do not invent time estimates, completion claims, or facts.
7. Preserve exact code, commands, paths, quoted text, warnings, and user-requested formats.
8. Omit recap sections and generic closing pleasantries.
`.trim();

export function isConcisedEnabled(): boolean {
  return true;
}

function registerConcisePrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${CONCISE_SYSTEM_PROMPT}`,
  }));
}

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 200, description: "Display label for the option" }),
  description: Type.Optional(Type.String({ maxLength: 500, description: "Optional detail shown for the selected option" })),
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

const customInputHistory: string[] = [];

function rememberCustomInput(value: string): void {
  const existingIndex = customInputHistory.indexOf(value);
  if (existingIndex >= 0) customInputHistory.splice(existingIndex, 1);
  customInputHistory.push(value);
  if (customInputHistory.length > 100) customInputHistory.shift();
}

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

function registerQuestionTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof QuestionParams, QuestionDetails>({
    name: "question",
    label: "Question",
    description: "Ask one interactive multiple-choice question. Provide 1-9 concise options. The user can filter options or type a custom answer.",
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

        editor.onSubmit = (value) => {
          const answer = value.trim();
          if (answer) {
            rememberCustomInput(answer);
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
            editor.handleInput(data);
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
            filterQuery += printableInput;
            optionIndex = 0;
            refresh();
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

async function confirmNewSession(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm("Start new session", "Start a new session and leave the current history?");
}

function registerAliases(pi: ExtensionAPI): void {
  const startNewSession = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await ctx.waitForIdle();
    if (!await confirmNewSession(ctx)) return;
    await ctx.newSession();
  };
  pi.registerCommand("clear", { description: "Start a new session after confirmation", handler: startNewSession });
  pi.registerCommand("exit", {
    description: "Quit Pi gracefully",
    handler: async (_args, ctx) => ctx.shutdown(),
  });
}

interface CommandInfo {
  name: string;
  description?: string;
  category: "Built-in" | "Extension" | "Prompt" | "Skill";
  syntaxHint?: string;
}

const BUILTIN_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "scoped-models", description: "Configure models for Ctrl+P cycling" },
  { name: "export", description: "Export the current session" },
  { name: "import", description: "Import and resume a JSONL session" },
  { name: "share", description: "Share the session as a secret GitHub gist" },
  { name: "copy", description: "Copy the last agent message" },
  { name: "name", description: "Set the session display name" },
  { name: "session", description: "Show session usage and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Fork from a previous user message" },
  { name: "clone", description: "Duplicate the session at the current position" },
  { name: "tree", description: "Navigate the session tree" },
  { name: "trust", description: "Save the project trust decision" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload extensions and resources" },
  { name: "quit", description: "Quit Pi" },
];

const COMMAND_SYNTAX_HINTS: Readonly<Record<string, string>> = {
  variants: "/variants [level]",
  model: "/model [provider/model]",
  "scoped-models": "/scoped-models",
  login: "/login [provider]",
  export: "/export [filename]",
  import: "/import [path]",
  name: "/name [session-name]",
};

interface TaggedAutocompleteItem extends AutocompleteItem {
  killerosCommand?: string;
}

function scoreCommandMatch(name: string, prefix: string): number {
  if (!prefix) return 1;
  const normalizedName = name.toLocaleLowerCase();
  const normalizedPrefix = prefix.toLocaleLowerCase();
  if (normalizedName.startsWith(normalizedPrefix)) return 100;
  if (normalizedName.split(/[:\-_]/).some((token) => token.startsWith(normalizedPrefix))) return 80;
  if (normalizedName.includes(normalizedPrefix)) return 50;
  return 0;
}

function registerSlashAutocomplete(pi: ExtensionAPI): void {
  const usage = new Map<string, number>();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["/"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const match = beforeCursor.match(/(?:^|[ \t])\/([^\s/]*)$/);
        if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const prefix = (match[1] ?? "").toLocaleLowerCase();
        const baseSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const commands = new Map<string, CommandInfo>();
        BUILTIN_COMMANDS.forEach((command) => commands.set(command.name, {
          ...command,
          category: "Built-in",
          syntaxHint: COMMAND_SYNTAX_HINTS[command.name],
        }));

        for (const command of pi.getCommands()) {
          const category: CommandInfo["category"] = command.source === "skill"
            ? "Skill"
            : command.source === "prompt"
              ? "Prompt"
              : "Extension";
          commands.set(command.name, {
            name: command.name,
            description: command.description,
            category,
            syntaxHint: COMMAND_SYNTAX_HINTS[command.name],
          });
        }

        for (const item of baseSuggestions?.items ?? []) {
          const name = (item.value || item.label).replace(/^\//, "").trim().split(/\s+/)[0] ?? "";
          if (name && !commands.has(name)) {
            commands.set(name, { name, description: item.description, category: "Built-in" });
          }
        }

        const ranked = [...commands.values()]
          .map((command) => ({
            command,
            score: scoreCommandMatch(command.name, prefix) + Math.min((usage.get(command.name) ?? 0) * 2, 15),
          }))
          .filter(({ command }) => scoreCommandMatch(command.name, prefix) > 0)
          .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name));
        if (!ranked.length) return baseSuggestions;

        return {
          prefix: `/${prefix}`,
          items: ranked.map(({ command }): TaggedAutocompleteItem => {
            const syntax = command.syntaxHint ? `${command.syntaxHint} — ` : "";
            return {
              value: `/${command.name} `,
              label: `/${command.name}`,
              description: `[${command.category}] ${syntax}${command.description ?? ""}`.trim(),
              killerosCommand: command.name,
            };
          }),
        };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const tagged = item as TaggedAutocompleteItem;
        if (!tagged.killerosCommand) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        usage.set(tagged.killerosCommand, (usage.get(tagged.killerosCommand) ?? 0) + 1);
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        let afterCursor = line.slice(cursorCol);
        const match = beforeCursor.match(/(?:^|[ \t])\/([^\s/]*)$/);
        if (!match || match.index === undefined) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        const slashIndex = match.index + (match[0].startsWith("/") ? 0 : 1);
        const newBefore = beforeCursor.slice(0, slashIndex) + item.value;
        if (item.value.endsWith(" ") && afterCursor.startsWith(" ")) afterCursor = afterCursor.trimStart();
        const nextLines = [...lines];
        nextLines[cursorLine] = newBefore + afterCursor;
        return { lines: nextLines, cursorLine, cursorCol: newBefore.length };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const ALL_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Maximum",
};
const LEVEL_DESCRIPTIONS: Readonly<Record<ThinkingLevel, string>> = {
  off: "No extended reasoning",
  minimal: "Brief reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extensive reasoning",
  max: "Maximum supported reasoning",
};
const LEVEL_COLORS: Readonly<Record<ThinkingLevel, ThemeColor>> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};
const LEVEL_ALIASES: Readonly<Record<string, ThinkingLevel>> = {
  quick: "minimal",
  fast: "minimal",
  light: "low",
  balanced: "medium",
  deep: "high",
  maximum: "max",
  none: "off",
};

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (ALL_LEVELS as readonly string[]).includes(value);
}

function resolveThinkingLevel(input: string): ThinkingLevel | undefined {
  const normalized = input.trim().toLocaleLowerCase();
  return isThinkingLevel(normalized) ? normalized : LEVEL_ALIASES[normalized];
}

function supportedLevels(model: ExtensionContext["model"]): ThinkingLevel[] {
  if (!model?.reasoning) return ["off"];
  return ALL_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" || mapped !== undefined;
  });
}

function modelLabel(model: ExtensionContext["model"]): string {
  return model ? `${model.provider}/${model.id}` : "unknown model";
}

function registerVariants(pi: ExtensionAPI): void {
  const setLevel = (ctx: ExtensionContext, level: ThinkingLevel): void => {
    const supported = supportedLevels(ctx.model);
    if (!supported.includes(level)) {
      ctx.ui.notify(`${LEVEL_LABELS[level]} is not supported by ${modelLabel(ctx.model)}. Supported: ${supported.join(", ")}`, "warning");
      return;
    }
    pi.setThinkingLevel(level);
    ctx.ui.notify(`Thinking: ${LEVEL_LABELS[level]}`, "info");
  };

  pi.registerCommand("variants", {
    description: "Set reasoning level: off, minimal, low, medium, high, xhigh, or max",
    handler: async (args, ctx) => {
      if (args.trim()) {
        const level = resolveThinkingLevel(args);
        if (!level) {
          ctx.ui.notify(`Unknown reasoning level "${args.trim()}". Use: ${ALL_LEVELS.join(", ")}`, "error");
          return;
        }
        setLevel(ctx, level);
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Use /variants <level> outside TUI mode", "error");
        return;
      }

      const supported = supportedLevels(ctx.model);
      if (supported.length === 1) {
        ctx.ui.notify(`${modelLabel(ctx.model)} does not support extended reasoning`, "info");
        return;
      }
      const current = pi.getThinkingLevel() as ThinkingLevel;
      const items = supported.map((level) => ({
        value: level,
        label: level === current ? `${LEVEL_LABELS[level]} ← current` : LEVEL_LABELS[level],
        description: LEVEL_DESCRIPTIONS[level],
      }));
      const selected = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Thinking variants")), 1, 0));
        container.addChild(new Text(theme.fg("dim", `Model: ${modelLabel(ctx.model)}`), 1, 0));
        container.addChild(new Text("", 0, 0));
        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        selectList.onSelect = (item) => done(isThinkingLevel(item.value) ? item.value : null);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Text("", 0, 0));
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
        return {
          render: (width) => container.render(width).map((line) => truncateToWidth(line, width, "")),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });
      if (selected) setLevel(ctx, selected);
    },
  });
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "$—";
  return `$${usd.toFixed(2)}`;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatTokens(value: number): string {
  const amount = Math.max(0, value);
  if (amount < 1_000) return `${Math.round(amount)}`;
  if (amount >= 1_000_000) {
    const precision = amount >= 10_000_000 ? 0 : 1;
    return `${Number((amount / 1_000_000).toFixed(precision))}M`;
  }
  const precision = amount >= 100_000 ? 0 : 1;
  return `${Number((amount / 1_000).toFixed(precision))}k`;
}

export function formatContextProgress(tokensUsed: number | null, contextWindow: number, theme: Theme): string {
  if (tokensUsed === null) return theme.fg("dim", "—% left (—)");
  const windowSize = contextWindow > 0 ? contextWindow : 128_000;
  const remaining = Math.max(0, Math.min(windowSize, windowSize - Math.max(0, tokensUsed)));
  const percentLeft = Math.max(0, Math.min(100, Math.round((remaining / windowSize) * 100)));
  const color: ThemeColor = percentLeft < 20 ? "error" : percentLeft <= 50 ? "warning" : "success";
  const action = percentLeft < 15 ? " · /compact" : "";
  return theme.fg(color, `${percentLeft}% left (${formatTokens(remaining)})${action}`);
}

function sumSessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") total += entry.message.usage.cost.total;
    else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      total += entry.message.usage.cost.total;
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      total += entry.usage.cost.total;
    }
  }
  return total;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai-responses": "Azure OpenAI",
  "github-copilot": "GitHub Copilot",
  "google-vertex": "Google Vertex",
  "openai-codex": "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  ollama: "Ollama",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  deepseek: "DeepSeek",
  github: "GitHub",
  llm: "LLM",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

function formatProviderName(provider: string): string {
  const normalized = provider.trim();
  const known = PROVIDER_LABELS[normalized.toLocaleLowerCase()];
  if (known) return known;
  return normalized
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => PROVIDER_WORDS[word.toLocaleLowerCase()] ?? `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ") || "Unknown provider";
}

function modelDisplayName(model: NonNullable<ExtensionContext["model"]>): string {
  return model.name?.trim() || model.id;
}

function formatModel(model: ExtensionContext["model"], theme: Theme, includeProvider = true): string {
  if (!model) return theme.fg("dim", "No model");
  const name = theme.fg("text", theme.bold(modelDisplayName(model)));
  return includeProvider ? `${name} ${theme.fg("dim", formatProviderName(model.provider))}` : name;
}

function compactDirectory(cwd: string): string {
  if (cwd === "~" || cwd === "/" || /^[A-Za-z]:[\\/]?$/u.test(cwd)) return cwd;
  const normalized = cwd.replace(/\\/gu, "/").replace(/\/$/u, "");
  const finalSegment = normalized.split("/").at(-1);
  return finalSegment ? `…/${finalSegment}` : cwd;
}

function joinFooterParts(parts: string[], theme: Theme): string {
  return parts.filter(Boolean).join(theme.fg("dim", " · "));
}

function footerRowFits(left: string, right: string, width: number): boolean {
  const contentWidth = visibleWidth(left) + (right ? visibleWidth(right) + 1 : 0);
  return contentWidth + 2 <= width;
}

function renderFooterRow(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width < 3) return " ".repeat(width);

  const innerWidth = width - 2;
  if (!right) return ` ${padRight(left, innerWidth)} `;

  const clippedRight = truncateToWidth(right, innerWidth, "");
  const rightWidth = visibleWidth(clippedRight);
  const leftBudget = Math.max(0, innerWidth - rightWidth - 1);
  const clippedLeft = truncateToWidth(left, leftBudget, "…");
  const gap = " ".repeat(Math.max(0, innerWidth - visibleWidth(clippedLeft) - rightWidth));
  return ` ${clippedLeft}${gap}${clippedRight} `;
}

function registerFooter(pi: ExtensionAPI): void {
  let currentModel: ExtensionContext["model"];
  let thinkingLevel: ThinkingLevel = "off";
  let activeTui: TUI | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const sessionStart = Date.now();
    currentModel = ctx.model;
    thinkingLevel = pi.getThinkingLevel() as ThinkingLevel;
    const cwd = formatCwd(ctx.cwd);

    ctx.ui.setFooter((tui, theme, footerData) => {
      activeTui = tui;
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const refreshTimer = setInterval(() => tui.requestRender(), FOOTER_REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
      return {
        dispose() {
          unsubscribe();
          clearInterval(refreshTimer);
          if (activeTui === tui) activeTui = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          if (width <= 0) return [];
          const model = currentModel ?? ctx.model;
          const level = model?.reasoning === false
            ? theme.fg("thinkingOff", "no reasoning")
            : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
          const usage = ctx.getContextUsage();
          const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 128_000;
          const context = formatContextProgress(usage?.tokens ?? null, contextWindow, theme);
          const branch = footerData.getGitBranch();
          const signature = formatModel(model, theme);
          const fullDirectory = theme.fg("dim", cwd);
          const focusedDirectory = theme.fg("dim", compactDirectory(cwd));
          const rich = joinFooterParts([
            signature,
            level,
            context,
            branch ? theme.fg("dim", branch) : "",
            theme.fg("dim", formatTime(Date.now() - sessionStart)),
            theme.fg("dim", formatCost(sumSessionCost(ctx))),
          ], theme);
          const focused = joinFooterParts([signature, context], theme);

          if (footerRowFits(rich, fullDirectory, width)) {
            return [renderFooterRow(rich, fullDirectory, width)];
          }
          if (footerRowFits(rich, focusedDirectory, width)) {
            return [renderFooterRow(rich, focusedDirectory, width)];
          }
          if (footerRowFits(focused, focusedDirectory, width)) {
            return [renderFooterRow(focused, focusedDirectory, width)];
          }
          if (footerRowFits(focused, "", width)) {
            return [renderFooterRow(focused, "", width)];
          }

          const essentialModel = formatModel(model, theme, false);
          return [renderFooterRow(essentialModel, context, width)];
        },
      };
    });
  });

  pi.on("model_select", (event) => {
    currentModel = event.model;
    activeTui?.requestRender();
  });
  pi.on("thinking_level_select", (event) => {
    thinkingLevel = event.level;
    activeTui?.requestRender();
  });
  pi.on("session_shutdown", () => {
    activeTui = undefined;
  });
}

export default function Killeros(pi: ExtensionAPI): void {
  registerShellUi(pi);
  registerConcisePrompt(pi);
  registerQuestionTool(pi);
  registerAliases(pi);
  registerSlashAutocomplete(pi);
  registerFooter(pi);
  registerVariants(pi);
}
