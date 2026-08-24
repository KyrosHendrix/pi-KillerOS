import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CustomEditor,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatCwd, padRight } from "./display.ts";
import {
  createSlashCommandResolver,
  findSlashCommandTokens,
  type SlashCommandResolver,
} from "./commands.ts";
import { reportError } from "./errors.ts";
import { formatModel } from "./footer.ts";
import { LEVEL_COLORS } from "./variants.ts";

const COMPACT_HEADER_MAX_WIDTH = 52;

function readPackageVersion(path: string | URL): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object"
      && value !== null
      && "version" in value
      && typeof value.version === "string"
      ? value.version
      : undefined;
  } catch {
    return undefined;
  }
}

const KILLEROS_VERSION = readPackageVersion(new URL("../package.json", import.meta.url));

const STARTUP_TIPS = [
  "Press Shift+Enter to insert a line break without sending.",
  "Run /variants to tune the model's reasoning depth.",
  "Type / to browse every command available in this session.",
  "Run /notification to enable a terminal bell when work settles.",
  "Run /goal <objective> to keep long-running work moving across turns.",
  "Run /init to generate root AGENTS.md from bounded repository evidence.",
  "Run /handoff [focus] to continue work in a fresh linked session.",
  "Run /codex-fast to toggle priority requests for Codex models.",
  "Run /clear to start a fresh session after confirmation.",
  "Ask the agent to show a short choice list when you need to decide.",
] as const;

const EDITOR_SUGGESTIONS = [
  'Try "how does <filepath> work?"',
  'Try "find edge cases in <filepath>"',
  'Try "simplify <filepath> without changing behavior"',
  'Try "write tests for <filepath>"',
  'Try "trace this failure to its first bad state"',
  'Try "review this diff against <spec>"',
  'Try "explain why this test fails"',
  'Try "find the smallest safe fix for <issue>"',
  'Try "map the data flow through <feature>"',
  'Try "draft an implementation plan for <feature>"',
] as const;

export function resolveGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 500,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch ? branch === "HEAD" ? "detached" : branch : undefined);
      },
    );
  });
}

function shuffledDeck(values: readonly string[]): string[] {
  const deck = [...values];
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = deck[index];
    const swap = deck[swapIndex];
    if (current === undefined || swap === undefined) continue;
    deck[index] = swap;
    deck[swapIndex] = current;
  }
  return deck;
}

let tipDeck: string[] = [];
let editorSuggestionDeck: string[] = [];

function nextStartupTip(): string {
  if (tipDeck.length === 0) tipDeck = shuffledDeck(STARTUP_TIPS);
  return tipDeck.pop() ?? STARTUP_TIPS[0];
}

function nextEditorSuggestion(): string {
  if (editorSuggestionDeck.length === 0) editorSuggestionDeck = shuffledDeck(EDITOR_SUGGESTIONS);
  return editorSuggestionDeck.pop() ?? EDITOR_SUGGESTIONS[0];
}

function compactBoxLine(content: string, width: number, theme: Theme): string {
  if (width < 4) return truncateToWidth(content, width, "");
  return `${theme.fg("dim", "│")} ${padRight(content, width - 4)} ${theme.fg("dim", "│")}`;
}

class PiStartupHeader {
  private readonly pi: ExtensionAPI;
  private readonly ctx: ExtensionContext;
  private readonly tip: string;
  private readonly tui: TUI;
  private branch: string | undefined;
  private disposed = false;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, tip: string, tui: TUI) {
    this.pi = pi;
    this.ctx = ctx;
    this.tip = tip;
    this.tui = tui;
    void resolveGitBranch(ctx.cwd).then((branch) => {
      if (this.disposed) return;
      this.branch = branch;
      this.tui.requestRender();
    });
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
    const thinkingLevel = this.pi.getThinkingLevel();
    const reasoning = this.ctx.model?.reasoning === false
      ? theme.fg("thinkingOff", "no reasoning")
      : theme.fg(LEVEL_COLORS[thinkingLevel], thinkingLevel);
    const agent = `${formatModel(this.ctx.model, theme)}${theme.fg("dim", " · ")}${reasoning}`;
    const directory = formatCwd(this.ctx.cwd);
    const repository = this.branch
      ? `${directory} ${theme.fg("dim", `· ${this.branch}`)}`
      : directory;
    const modelCommand = theme.fg("mdLink", "/model");
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
  dispose(): void {
    this.disposed = true;
  }
}

function stripAnsi(text: string): string {
  return stripTerminalSequences(text).trim();
}

function isBorderLine(line: string): boolean {
  const unstyled = stripAnsi(line);
  return /^[─━═]+$/.test(unstyled) || /^───\s*[↓↑]/.test(unstyled) || /^─{3,}/.test(unstyled);
}

function isScrolledTopBorder(line: string): boolean {
  const unstyled = stripAnsi(line);
  return unstyled.includes("↑");
}

interface RenderChunk {
  text: string;
  plainStart: number;
  isAnsi: boolean;
}

function extractTerminalSequence(text: string, position: number): { code: string; length: number } | undefined {
  if (text[position] !== "\x1B") return undefined;
  const next = text[position + 1];
  if (next === "[") {
    let end = position + 2;
    while (end < text.length && !/[\x40-\x7E]/u.test(text[end] ?? "")) end += 1;
    if (end < text.length) return { code: text.slice(position, end + 1), length: end + 1 - position };
    return undefined;
  }
  if (next === "]" || next === "_") {
    let end = position + 2;
    while (end < text.length) {
      if (text[end] === "\x07") return { code: text.slice(position, end + 1), length: end + 1 - position };
      if (text[end] === "\x1B" && text[end + 1] === "\\") {
        return { code: text.slice(position, end + 2), length: end + 2 - position };
      }
      end += 1;
    }
    return undefined;
  }
  if (next !== undefined) return { code: text.slice(position, position + 2), length: 2 };
  return undefined;
}

/** Styles valid slash-command tokens while preserving embedded terminal control sequences. */
export function highlightSlashCommands(
  line: string,
  isValidCommand: (name: string) => boolean,
  styleCommand: (token: string) => string,
): string {
  const chunks: RenderChunk[] = [];
  let plain = "";
  let index = 0;
  while (index < line.length) {
    const ansi = extractTerminalSequence(line, index);
    if (ansi) {
      chunks.push({ text: ansi.code, plainStart: plain.length, isAnsi: true });
      index += ansi.length;
      continue;
    }

    const start = index;
    const plainStart = plain.length;
    while (index < line.length && !extractTerminalSequence(line, index)) {
      plain += line[index] ?? "";
      index += 1;
    }
    chunks.push({
      text: line.slice(start, index),
      plainStart,
      isAnsi: false,
    });
  }

  const tokens = findSlashCommandTokens(plain).filter((token) => isValidCommand(token.name));
  if (tokens.length === 0) return line;

  return chunks.map((chunk) => {
    if (chunk.isAnsi) return chunk.text;
    let output = "";
    let offset = 0;
    while (offset < chunk.text.length) {
      const plainIndex = chunk.plainStart + offset;
      const token = tokens.find(({ start, end }) => plainIndex >= start && plainIndex < end);
      if (!token) {
        const nextTokenStart = tokens.find(({ start }) => start > plainIndex)?.start;
        const end = nextTokenStart === undefined
          ? chunk.text.length
          : Math.min(chunk.text.length, nextTokenStart - chunk.plainStart);
        output += chunk.text.slice(offset, end);
        offset = end;
        continue;
      }

      const tokenEnd = Math.min(chunk.text.length, token.end - chunk.plainStart);
      output += styleCommand(chunk.text.slice(offset, tokenEnd));
      offset = tokenEnd;
    }
    return output;
  }).join("");
}

class PiCodeEditor extends CustomEditor {
  private readonly appKeybindings: KeybindingsManager;
  private readonly runtimeTheme: Theme;
  private readonly suggestion: string;
  private readonly commandResolver: SlashCommandResolver;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    appKeybindings: KeybindingsManager,
    runtimeTheme: Theme,
    suggestion: string,
    commandResolver: SlashCommandResolver,
  ) {
    super(tui, theme, appKeybindings);
    this.appKeybindings = appKeybindings;
    this.runtimeTheme = runtimeTheme;
    this.suggestion = suggestion;
    this.commandResolver = commandResolver;
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
    if (width <= 0) return [];
    const innerWidth = Math.max(1, width - 2);
    const lines = super.render(innerWidth);
    if (lines.length < 2) return ["", ...lines.map((line) => truncateToWidth(line, width, ""))];
    let bottomBorderIndex = lines.length - 1;
    for (let index = lines.length - 1; index >= 1; index -= 1) {
      if (isBorderLine(lines[index] ?? "")) {
        bottomBorderIndex = index;
        break;
      }
    }

    const dim = (text: string): string => this.runtimeTheme.fg("dim", text);
    const rendered: string[] = [];
    const top = stripAnsi(lines[0] ?? "");
    const isScrolledHeader = isScrolledTopBorder(lines[0] ?? "");
    if (isScrolledHeader) {
      const count = top.match(/↑\s*(\d+)/)?.[1] ?? "";
      rendered.push(truncateToWidth(dim(`  ↑ ${count} more`), width, ""));
    }

    for (let index = 1; index < bottomBorderIndex; index += 1) {
      const isPromptLine = index === 1 && !isScrolledHeader;
      const prefix = isPromptLine
        ? this.runtimeTheme.fg(this.focused ? "accent" : "dim", "❯\u00A0")
        : "  ";
      let content = lines[index] ?? "";
      if (isPromptLine && this.getText() === "") {
        const first = this.suggestion.slice(0, 1);
        const rest = this.suggestion.slice(1);
        const cursorMarker = this.focused ? CURSOR_MARKER : "";
        content = `${cursorMarker}\x1B[7m${dim(first)}\x1B[27m${dim(rest)}`;
      }
      if (this.getText() !== "") {
        content = highlightSlashCommands(
          content,
          (name) => this.commandResolver.isValidCommand(name),
          (token) => this.runtimeTheme.fg("mdLink", token),
        );
      }
      rendered.push(`${prefix}${padRight(content, innerWidth)}`);
    }

    const bottom = stripAnsi(lines[bottomBorderIndex] ?? "");
    if (bottom.includes("↓")) {
      const count = bottom.match(/↓\s*(\d+)/)?.[1] ?? "";
      rendered.push(truncateToWidth(dim(`  ↓ ${count} more`), width, ""));
    }

    for (let index = bottomBorderIndex + 1; index < lines.length; index += 1) {
      rendered.push(`  ${padRight(lines[index] ?? "", innerWidth)}`);
    }
    return ["", ...rendered.map((line) => truncateToWidth(line, width, ""))];
  }
}

const ACTIVITY_FRAMES = [
  "·", "✢", "✱", "✶", "✻", "✽",
  "✽", "✻", "✶", "✱", "✢", "·",
] as const;
const ACTIVITY_FRAME_INTERVAL_MS = 120;

let killerosEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;

export function registerShellUi(
  pi: ExtensionAPI,
  commandResolver: SlashCommandResolver = createSlashCommandResolver(pi),
): void {
  let activeHeader: PiStartupHeader | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      ctx.ui.setTheme("killeros");
      const startupTip = nextStartupTip();
      ctx.ui.setHeader((tui) => {
        activeHeader?.dispose();
        activeHeader = new PiStartupHeader(pi, ctx, startupTip, tui);
        return activeHeader;
      });
      ctx.ui.setWorkingIndicator({
        frames: ACTIVITY_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
        intervalMs: ACTIVITY_FRAME_INTERVAL_MS,
      });
      ctx.ui.setHiddenThinkingLabel("└ Thinking…");
      const existingEditorFactory = ctx.ui.getEditorComponent?.();
      if (!existingEditorFactory || existingEditorFactory === killerosEditorFactory) {
        const editorSuggestion = nextEditorSuggestion();
        killerosEditorFactory = (tui, editorTheme, keybindings) =>
          new PiCodeEditor(tui, editorTheme, keybindings, ctx.ui.theme, editorSuggestion, commandResolver);
        ctx.ui.setEditorComponent(killerosEditorFactory);
      }
    } catch (error) {
      reportError(ctx, "Killeros UI failed to initialize", error);
    }
  });

  pi.on("session_shutdown", () => {
    activeHeader?.dispose();
    activeHeader = undefined;
  });
}
