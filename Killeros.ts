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

const BRAND_RGB = "215;119;87";
const LEFT_PANEL_WIDTH = 42;
const LOGO_CELL = "███";
const LOGO_ANIMATION_INTERVAL_MS = 120;
const TIP_ROTATION_INTERVAL_MS = 5_000;
const FOOTER_REFRESH_INTERVAL_MS = 1_000;

const brand = (text: string): string => `\x1B[38;2;${BRAND_RGB}m${text}\x1B[39m`;

interface LogoFrame {
  phase: number;
  active: "left" | "top" | "right" | "none";
  ax: number;
  ay: number;
  flash: boolean;
  white: boolean;
}

const LOGO_FRAMES: LogoFrame[] = [
  ...Array.from({ length: 4 }, (_, ay): LogoFrame => ({ phase: 0, active: "left", ax: 2, ay, flash: false, white: false })),
  ...Array.from({ length: 3 }, (_, ay): LogoFrame => ({ phase: 1, active: "top", ax: 2, ay, flash: false, white: false })),
  ...Array.from({ length: 5 }, (_, ay): LogoFrame => ({ phase: 2, active: "right", ax: 5, ay, flash: false, white: false })),
  { phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
  { phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
  { phase: 3, active: "none", ax: 0, ay: 0, flash: false, white: false },
  { phase: 3, active: "none", ax: 0, ay: 0, flash: true, white: false },
  { phase: 4, active: "none", ax: 0, ay: 0, flash: false, white: false },
  { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
  { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
  { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: false },
  { phase: 5, active: "none", ax: 0, ay: 0, flash: false, white: true },
  { phase: 6, active: "none", ax: 0, ay: 0, flash: false, white: false },
];

function extractProvider(model: ExtensionContext["model"]): string {
  return model?.provider ?? "";
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

function center(text: string, width: number): string {
  if (width <= 0) return "";
  const textWidth = visibleWidth(text);
  if (textWidth >= width) return truncateToWidth(text, width, "");
  return `${" ".repeat(Math.floor((width - textWidth) / 2))}${text}`;
}

function padRight(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function hasCell(y: number, x: number, cells: string): boolean {
  return cells.split(" ").includes(`${y},${x}`);
}

function hasPiece(y: number, x: number, py: number, px: number, cells: string): boolean {
  return cells.split(" ").some((item) => {
    const [dy, dx] = item.split(",").map(Number);
    return y === py + dy && x === px + dx;
  });
}

type LogoColor = "cyan" | "red" | "green" | "orange" | "flash" | "white" | "brand" | "panel";

function colorCell(color: LogoColor): string {
  switch (color) {
    case "cyan": return `\x1B[36m${LOGO_CELL}\x1B[39m`;
    case "red": return `\x1B[31m${LOGO_CELL}\x1B[39m`;
    case "green": return `\x1B[32m${LOGO_CELL}\x1B[39m`;
    case "orange":
    case "flash": return `\x1B[33m${LOGO_CELL}\x1B[39m`;
    case "white": return `\x1B[97m${LOGO_CELL}\x1B[39m`;
    case "brand": return brand(LOGO_CELL);
    default: return " ".repeat(LOGO_CELL.length);
  }
}

function logoCellColor(frame: LogoFrame, y: number, x: number): LogoColor {
  if (frame.white) {
    return hasCell(y, x, "3,2 3,3 3,4 4,2 4,4 5,2 5,3 5,5 6,2 6,5") ? "white" : "panel";
  }
  if (frame.flash && y === 6 && x >= 1 && x <= 6) return "flash";
  if (frame.active === "left" && hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 1,1 2,0")) return "red";
  if (frame.active === "top" && hasPiece(y, x, frame.ay, frame.ax, "0,0 0,1 0,2 1,2")) return "cyan";
  if (frame.active === "right" && hasPiece(y, x, frame.ay, frame.ax, "0,0 1,0 2,0 2,1")) return "green";
  if (frame.phase === 6) {
    return hasCell(y, x, "3,2 3,3 3,4 4,4 4,2 5,2 5,3 5,5 6,2 6,5") ? "brand" : "panel";
  }
  if (frame.phase === 4) {
    if (hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
    if (hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
    if (hasCell(y, x, "4,5 5,5")) return "green";
    return "panel";
  }
  if (frame.phase >= 5) {
    if (hasCell(y, x, "3,2 3,3 3,4 4,4")) return "cyan";
    if (hasCell(y, x, "4,2 5,2 5,3 6,2")) return "red";
    if (hasCell(y, x, "5,5 6,5")) return "green";
    return "panel";
  }
  if (frame.phase <= 3 && hasCell(y, x, "6,1 6,2 6,3 6,4")) return "orange";
  if (frame.phase >= 2 && hasCell(y, x, "2,2 2,3 2,4 3,4")) return "cyan";
  if (frame.phase >= 1 && hasCell(y, x, "3,2 4,2 4,3 5,2")) return "red";
  if (frame.phase >= 3 && hasCell(y, x, "4,5 5,5 6,5 6,6")) return "green";
  return "panel";
}

function piLogoFrame(frameIndex: number): string[] {
  const frame = LOGO_FRAMES[frameIndex % LOGO_FRAMES.length]!;
  const lines: string[] = [];
  for (let y = 1; y <= 7; y += 1) {
    let line = "";
    for (let x = 1; x <= 8; x += 1) line += colorCell(logoCellColor(frame, y, x));
    lines.push(line);
  }
  return lines;
}

function borderLine(left: string, label: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return brand(truncateToWidth(left, 1, ""));
  const edgeWidth = visibleWidth(left) + visibleWidth(right);
  if (width <= edgeWidth) return brand(truncateToWidth(left + right, width, ""));
  const available = width - edgeWidth;
  const clippedLabel = truncateToWidth(label, Math.max(0, available - 2), "");
  const labelWidth = visibleWidth(clippedLabel);
  if (labelWidth === 0 || available < labelWidth + 2) {
    return `${brand(left)}${brand("─".repeat(available))}${brand(right)}`;
  }
  const fill = available - labelWidth - 2;
  const before = Math.min(3, fill);
  const after = fill - before;
  return `${brand(left)}${brand("─".repeat(before))} ${clippedLabel} ${brand("─".repeat(after))}${brand(right)}`;
}

function boxedLine(content: string, width: number): string {
  if (width <= 0) return "";
  if (width <= 2) return truncateToWidth(content, width, "");
  return `${brand("│")}${padRight(content, width - 2)}${brand("│")}`;
}

function twoColumn(left: string, right: string, leftWidth: number, rightWidth: number): string {
  return `${padRight(left, leftWidth)} ${brand("│")} ${padRight(right, rightWidth)}`;
}

const TIP_SETS = [
  [
    "",
    "Shortcuts & Commands",
    "/variants  — model reasoning",
    "/compact   — compress context",
    "/model     — choose a model",
    "────────────────────────",
    "Keybindings",
    "Shift+Enter — new line",
    "Esc         — cancel generation",
    "Ctrl+C      — interrupt agent",
  ],
  [
    "",
    "Session",
    "/new      — start a session",
    "/name     — name this session",
    "/session  — usage and stats",
    "────────────────────────",
    "Workflow",
    "Give Pi a goal and constraints",
    "Ask it to run the relevant tests",
    "Review changes before committing",
  ],
  [
    "",
    "Useful Commands",
    "/copy    — copy last response",
    "/tree    — navigate branches",
    "/reload  — reload resources",
    "────────────────────────",
    "Extension locations",
    "Global: ~/.pi/agent/extensions",
    "Project: .pi/extensions",
    "Reload after making changes",
  ],
  [
    "",
    "Navigation",
    "Up/Down  — command history",
    "Tab      — autocomplete",
    "Ctrl+L   — clear the screen",
    "────────────────────────",
    "Good defaults",
    "Keep edits scoped",
    "Test after refactoring",
    "Verify output before committing",
  ],
] as const;

function getTipLines(index: number, theme: Theme): string[] {
  const selected = TIP_SETS[index % TIP_SETS.length] ?? TIP_SETS[0];
  return selected.map((line, lineIndex) => {
    if (lineIndex === 1 || lineIndex === 6) return brand(theme.bold(line));
    if (line.startsWith("─")) return brand(line);
    if (line.startsWith("/")) {
      const [command, ...rest] = line.split(" ");
      return `${theme.fg("accent", command ?? "")}${theme.fg("dim", ` ${rest.join(" ")}`)}`;
    }
    return theme.fg(lineIndex > 6 ? "muted" : "dim", line);
  });
}

class PiStartupHeader {
  private frame = 0;
  private tipIndex = 0;
  private animationTimer?: ReturnType<typeof setInterval>;
  private tipTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly tui: TUI,
  ) {
    this.animationTimer = setInterval(() => {
      if (this.disposed) return;
      if (this.frame >= LOGO_FRAMES.length - 1) {
        this.stopAnimation();
        return;
      }
      this.frame += 1;
      this.tui.requestRender();
      if (this.frame >= LOGO_FRAMES.length - 1) this.stopAnimation();
    }, LOGO_ANIMATION_INTERVAL_MS);
    this.animationTimer.unref?.();

    this.tipTimer = setInterval(() => {
      if (this.disposed) return;
      this.tipIndex = (this.tipIndex + 1) % TIP_SETS.length;
      this.tui.requestRender();
    }, TIP_ROTATION_INTERVAL_MS);
    this.tipTimer.unref?.();
  }

  private stopAnimation(): void {
    if (!this.animationTimer) return;
    clearInterval(this.animationTimer);
    this.animationTimer = undefined;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.ctx.ui.theme;
    if (width < 16) return [truncateToWidth(theme.fg("accent", `Pi v${VERSION}`), width, "")];

    const innerWidth = width - 2;
    const isTwoColumn = innerWidth >= 64;
    const provider = extractProvider(this.ctx.model);
    const rawModel = this.ctx.model?.id ?? this.ctx.model?.name;
    const model = rawModel
      ? provider && !rawModel.startsWith(`${provider}/`) ? `${provider}/${rawModel}` : rawModel
      : "Default model";
    const effort = this.pi.getThinkingLevel();
    const cwd = formatCwd(this.ctx.cwd);
    const leftWidth = isTwoColumn ? Math.min(LEFT_PANEL_WIDTH, Math.floor(innerWidth * 0.55)) : innerWidth;
    const rightWidth = isTwoColumn ? innerWidth - leftWidth - 3 : 0;
    const logoLines = leftWidth >= 24
      ? piLogoFrame(this.frame).map((line) => center(line, leftWidth))
      : ["", "", center(brand(theme.bold("Pi Coding Agent")), leftWidth), "", "", "", ""];
    const modelText = leftWidth < 34 ? `${model} (${effort})` : `${model} with ${effort} effort`;
    const leftLines = [
      ...logoLines,
      center(theme.bold("Let's build something great"), leftWidth),
      center(theme.fg("muted", truncateToWidth(modelText, leftWidth, "…")), leftWidth),
      center(theme.fg("dim", truncateToWidth(cwd, leftWidth, "…")), leftWidth),
    ];
    const tipLines = isTwoColumn ? getTipLines(this.tipIndex, theme) : [];
    const lines = [borderLine("╭", `${brand("Pi")} v${VERSION}`, "╮", width)];
    for (let index = 0; index < leftLines.length; index += 1) {
      const content = isTwoColumn
        ? twoColumn(leftLines[index] ?? "", tipLines[index] ?? "", leftWidth, rightWidth)
        : padRight(leftLines[index] ?? "", leftWidth);
      lines.push(boxedLine(content, width));
    }
    lines.push(borderLine("╰", "", "╯", width));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    if (this.tipTimer) {
      clearInterval(this.tipTimer);
      this.tipTimer = undefined;
    }
  }
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
  constructor(tui: TUI, theme: EditorTheme, private readonly appKeybindings: KeybindingsManager) {
    super(tui, theme, appKeybindings);
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

function registerShellUi(pi: ExtensionAPI): void {
  let activeHeader: PiStartupHeader | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setHeader((tui) => {
        activeHeader?.dispose();
        activeHeader = new PiStartupHeader(pi, ctx, tui);
        return activeHeader;
      });
      ctx.ui.setWorkingIndicator({
        frames: ["◐", "◓", "◑", "◒"].map((frame) => ctx.ui.theme.fg("accent", frame)),
        intervalMs: 120,
      });
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new PiCodeEditor(tui, theme, keybindings));
    } catch (error) {
      reportError(ctx, "Killeros UI failed to initialize", error);
    }
  });

  pi.on("session_shutdown", () => {
    activeHeader?.dispose();
    activeHeader = undefined;
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
  return data.length > 0 && !/[\u0000-\u001F\u007F]/u.test(data);
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
        let historyIndex = -1;
        let savedDraft = "";
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
          historyIndex = -1;
          savedDraft = "";
          refresh();
        };

        const enterCustomMode = (): void => {
          editMode = true;
          historyIndex = -1;
          savedDraft = "";
          refresh();
        };

        const handleInput = (data: string): void => {
          if (editMode) {
            if (matchesKey(data, Key.escape)) {
              editMode = false;
              editor.setText("");
              historyIndex = -1;
              savedDraft = "";
              refresh();
              return;
            }
            if (matchesKey(data, Key.up) && customInputHistory.length > 0) {
              if (historyIndex < 0) {
                savedDraft = editor.getText();
                historyIndex = customInputHistory.length - 1;
              } else if (historyIndex > 0) {
                historyIndex -= 1;
              }
              editor.setText(customInputHistory[historyIndex] ?? "");
              refresh();
              return;
            }
            if (matchesKey(data, Key.down) && historyIndex >= 0) {
              if (historyIndex < customInputHistory.length - 1) {
                historyIndex += 1;
                editor.setText(customInputHistory[historyIndex] ?? "");
              } else {
                historyIndex = -1;
                editor.setText(savedDraft);
              }
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
              filterQuery = Array.from(filterQuery).slice(0, -1).join("");
              optionIndex = 0;
              refresh();
            }
            return;
          }
          if (/^[1-9]$/.test(data)) {
            const selected = visibleOptions[Number(data) - 1];
            if (!selected) return;
            if (selected.isOther) enterCustomMode();
            else finish({ kind: "selected", answer: selected.label, originalIndex: selected.originalIndex });
            return;
          }
          if (isPrintableInput(data)) {
            filterQuery += data;
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
  pi.registerCommand("quit", {
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
  logout: "/logout [provider]",
  export: "/export [filename]",
  import: "/import [path]",
  name: "/name [session-name]",
  fork: "/fork [name]",
  clone: "/clone [name]",
  resume: "/resume [session-id]",
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

export function resolveShortcutHint(): string {
  return process.env.PI_SHORTCUT_HINT?.trim() || "/variants";
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
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 0 : 1)}M`;
  return `${(amount / 1_000).toFixed(amount >= 100_000 ? 0 : 1)}k`;
}

export function formatContextProgress(tokensUsed: number | null, contextWindow: number, theme: Theme): string {
  if (tokensUsed === null) return theme.fg("dim", "[░░░░░░░░░░] —");
  const windowSize = contextWindow > 0 ? contextWindow : 128_000;
  const remaining = Math.max(0, Math.min(windowSize, windowSize - Math.max(0, tokensUsed)));
  const percentLeft = Math.max(0, Math.min(100, Math.round((remaining / windowSize) * 100)));
  const filled = Math.round((percentLeft / 100) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const color: ThemeColor = percentLeft < 20 ? "error" : percentLeft <= 50 ? "warning" : "success";
  const warning = percentLeft < 15 ? " ⚠ /compact" : "";
  return theme.fg(color, `[${bar}] ${percentLeft}% left (${formatTokens(remaining)})${warning}`);
}

function sumSessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      total += entry.message.usage.cost.total;
    }
  }
  return total;
}

function formatModel(model: ExtensionContext["model"], theme: Theme): string {
  if (!model) return theme.fg("dim", "no model");
  return `${theme.fg("dim", `${model.provider}/`)}${theme.fg("accent", model.id)}`;
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
            : theme.fg(LEVEL_COLORS[thinkingLevel], LEVEL_LABELS[thinkingLevel]);
          const usage = ctx.getContextUsage();
          const context = formatContextProgress(usage?.tokens ?? null, usage?.contextWindow ?? 128_000, theme);
          const branch = footerData.getGitBranch();
          const parts = [
            formatModel(model, theme),
            level,
            context,
            branch ? theme.fg("dim", branch) : "",
            theme.fg("dim", formatTime(Date.now() - sessionStart)),
          ];
          const cost = sumSessionCost(ctx);
          if (cost > 0) parts.push(theme.fg("dim", formatCost(cost)));
          const hint = resolveShortcutHint();
          if (hint) parts.push(theme.fg("dim", hint));
          const separator = theme.fg("dim", "·");
          const left = ` ${parts.filter(Boolean).join(`  ${separator}  `)} `;
          const rightBudget = Math.max(0, width - visibleWidth(left) - 1);
          const right = theme.fg("dim", truncateToWidth(cwd, rightBudget, "…"));
          const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
          return [truncateToWidth(left + gap + right, width, "")];
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
