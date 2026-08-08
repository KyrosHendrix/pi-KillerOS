import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CustomEditor,
  DynamicBorder,
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { formatCwd, padRight } from "./display.ts";
import { reportError } from "./errors.ts";
import { formatModel } from "./footer.ts";
import { LEVEL_COLORS, type ThinkingLevel } from "./variants.ts";

const COMPACT_HEADER_MAX_WIDTH = 52;

function readPackageVersion(path: string | URL): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
    return typeof value.version === "string" ? value.version : undefined;
  } catch {
    return undefined;
  }
}

const KILLEROS_VERSION = readPackageVersion(new URL("../package.json", import.meta.url));

const STARTUP_TIPS = [
  "Press Shift+Enter to insert a line break without sending.",
  "Run /variants to tune the model's reasoning depth.",
  "Type / to browse every command available in this session.",
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

function shuffledTips(): string[] {
  const tips = [...STARTUP_TIPS];
  for (let index = tips.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [tips[index], tips[swapIndex]] = [tips[swapIndex]!, tips[index]!];
  }
  return tips;
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
    const thinkingLevel = this.pi.getThinkingLevel() as ThinkingLevel;
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
  private readonly runtimeTheme: Theme;

  constructor(tui: TUI, theme: EditorTheme, appKeybindings: KeybindingsManager, runtimeTheme: Theme) {
    super(tui, theme, appKeybindings);
    this.appKeybindings = appKeybindings;
    this.runtimeTheme = runtimeTheme;
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

    const gray = (text: string): string => this.runtimeTheme.fg("dim", text);
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

const ACTIVITY_WORDS = ["Brewing", "Pondering", "Tinkering", "Wrangling", "Noodling", "Cooking"] as const;

export function registerShellUi(pi: ExtensionAPI): void {
  let activeHeader: PiStartupHeader | undefined;
  let activityDeck: string[] = [];
  let lastActivityWord: string | undefined;
  let activityTimer: ReturnType<typeof setInterval> | undefined;
  let tipDeck: string[] = [];
  const nextStartupTip = (): string => {
    if (tipDeck.length === 0) tipDeck = shuffledTips();
    return tipDeck.pop() ?? STARTUP_TIPS[0];
  };
  const refillActivityDeck = (): void => {
    activityDeck = [...ACTIVITY_WORDS];
    for (let index = activityDeck.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [activityDeck[index], activityDeck[swapIndex]] = [activityDeck[swapIndex]!, activityDeck[index]!];
    }
    if (activityDeck.length > 1 && activityDeck.at(-1) === lastActivityWord) {
      [activityDeck[0], activityDeck[activityDeck.length - 1]] = [activityDeck.at(-1)!, activityDeck[0]!];
    }
  };
  const nextActivityWord = (): string => {
    if (activityDeck.length === 0) refillActivityDeck();
    const word = activityDeck.pop() ?? ACTIVITY_WORDS[0];
    lastActivityWord = word;
    return word;
  };
  const clearActivityTimer = (): void => {
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = undefined;
  };

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
      clearActivityTimer();
      ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "✻")] });
      ctx.ui.setHiddenThinkingLabel("└ Thinking…");
      ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
        new PiCodeEditor(tui, editorTheme, keybindings, ctx.ui.theme));
    } catch (error) {
      reportError(ctx, "Killeros UI failed to initialize", error);
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    clearActivityTimer();
    const updateWorkingWord = (): void => ctx.ui.setWorkingMessage(`${nextActivityWord()}…`);
    updateWorkingWord();
    activityTimer = setInterval(updateWorkingWord, 2_500);
    activityTimer.unref?.();
  });

  pi.on("agent_end", (_event, ctx) => {
    clearActivityTimer();
    if (ctx.mode === "tui") ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", () => {
    clearActivityTimer();
    activeHeader?.dispose();
    activeHeader = undefined;
    activityDeck = [];
    lastActivityWord = undefined;
  });
}
