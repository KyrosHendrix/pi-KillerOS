import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { safeTerminalText } from "./safe-terminal-text.ts";

async function confirmNewSession(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm("Start new session", "Start a new session and leave the current history?");
}

export function registerAliases(pi: ExtensionAPI): void {
  const startNewSession = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (!await confirmNewSession(ctx)) return;
    if (!ctx.isIdle()) ctx.abort();
    await ctx.waitForIdle();
    await ctx.newSession();
  };
  pi.registerCommand("clear", { description: "Start a new session after confirmation", handler: startNewSession });
  pi.registerCommand("exit", {
    description: "Quit Pi gracefully",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) ctx.abort();
      ctx.shutdown();
    },
  });
}

interface CommandInfo {
  name: string;
  description?: string;
  category: "Built-in" | "Extension" | "Prompt" | "Skill";
  syntaxHint?: string;
}

export interface SlashCommandToken {
  name: string;
  start: number;
  end: number;
}

export interface SlashCommandResolver {
  clearFallbackCommands(): void;
  updateFallbackCommands(items: readonly AutocompleteItem[]): void;
  getCommandCatalog(baseSuggestions?: readonly AutocompleteItem[]): ReadonlyMap<string, CommandInfo>;
  isValidCommand(name: string): boolean;
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
  goal: "/goal [objective|pause|resume|clear]",
  handoff: "/handoff [next-session focus]",
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

const SLASH_COMMAND_PREFIX_PATTERN = /(?:^|[ \t])\/([^\s/]*)$/u;
const SLASH_COMMAND_TOKEN_PATTERN = /(?:^|[ \t])\/([^\s/]+)(?=$|[ \t])/gu;

function safeCommandName(name: string): string | undefined {
  const safe = safeTerminalText(name).replaceAll("\n", "").trim();
  return safe === name && safe && !/[\s/]/u.test(safe) ? safe : undefined;
}

export function getSlashCommandPrefix(line: string): { prefix: string; slashIndex: number } | undefined {
  const match = SLASH_COMMAND_PREFIX_PATTERN.exec(line);
  if (!match || match.index === undefined) return undefined;
  const prefix = match[1] ?? "";
  const slashIndex = match.index + (match[0].startsWith("/") ? 0 : 1);
  return { prefix, slashIndex };
}

export function findSlashCommandTokens(line: string): SlashCommandToken[] {
  const tokens: SlashCommandToken[] = [];
  for (const match of line.matchAll(SLASH_COMMAND_TOKEN_PATTERN)) {
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    const start = match.index + (match[0].startsWith("/") ? 0 : 1);
    tokens.push({ name, start, end: start + name.length + 1 });
  }
  return tokens;
}

function commandNameFromAutocompleteItem(item: AutocompleteItem): string {
  const name = (item.value || item.label).replace(/^\//u, "").trim().split(/\s+/u)[0] ?? "";
  return safeCommandName(name) ?? "";
}

export function createSlashCommandResolver(
  pi: Pick<ExtensionAPI, "getCommands">,
): SlashCommandResolver {
  let fallbackCommands = new Map<string, string | undefined>();

  const getCommandCatalog = (baseSuggestions: readonly AutocompleteItem[] = []): ReadonlyMap<string, CommandInfo> => {
    const commands = new Map<string, CommandInfo>();
    BUILTIN_COMMANDS.forEach((command) => commands.set(command.name, {
      ...command,
      category: "Built-in",
      syntaxHint: COMMAND_SYNTAX_HINTS[command.name],
    }));

    for (const command of pi.getCommands()) {
      const name = safeCommandName(command.name);
      if (!name) continue;
      const category: CommandInfo["category"] = command.source === "skill"
        ? "Skill"
        : command.source === "prompt"
          ? "Prompt"
          : "Extension";
      commands.set(name, {
        name,
        description: command.description === undefined
          ? undefined
          : safeTerminalText(command.description).replaceAll("\n", " "),
        category,
        syntaxHint: COMMAND_SYNTAX_HINTS[name],
      });
    }

    const baseCommands = baseSuggestions.length > 0
      ? new Map(baseSuggestions.map((item) => [commandNameFromAutocompleteItem(item), item.description] as const))
      : fallbackCommands;
    for (const [name, description] of baseCommands) {
      if (name && !commands.has(name)) {
        commands.set(name, {
          name,
          description: description === undefined ? undefined : safeTerminalText(description).replaceAll("\n", " "),
          category: "Built-in",
        });
      }
    }
    return commands;
  };

  return {
    clearFallbackCommands() {
      fallbackCommands = new Map<string, string | undefined>();
    },
    updateFallbackCommands(items) {
      fallbackCommands = new Map(
        items.map((item) => [commandNameFromAutocompleteItem(item), item.description] as const)
          .filter(([name]) => Boolean(name)),
      );
    },
    getCommandCatalog,
    isValidCommand(name) {
      return getCommandCatalog().has(name);
    },
  };
}

function scoreCommandMatch(name: string, prefix: string): number {
  if (!prefix) return 1;
  const normalizedName = name.toLowerCase();
  const normalizedPrefix = prefix.toLowerCase();
  if (normalizedName.startsWith(normalizedPrefix)) return 100;
  if (normalizedName.split(/[:\-_]/).some((token) => token.startsWith(normalizedPrefix))) return 80;
  if (normalizedName.includes(normalizedPrefix)) return 50;
  return 0;
}

export function registerSlashAutocomplete(
  pi: ExtensionAPI,
  resolver: SlashCommandResolver = createSlashCommandResolver(pi),
): SlashCommandResolver {
  const usage = new Map<string, number>();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    resolver.clearFallbackCommands();
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ["/"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const prefixMatch = getSlashCommandPrefix(beforeCursor);
        if (!prefixMatch) return current.getSuggestions(lines, cursorLine, cursorCol, options);

        const prefix = prefixMatch.prefix.toLowerCase();
        const baseSuggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        resolver.updateFallbackCommands(baseSuggestions?.items ?? []);
        const commands = resolver.getCommandCatalog(baseSuggestions?.items ?? []);

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
        const commandName = "killerosCommand" in item && typeof item.killerosCommand === "string"
          ? item.killerosCommand
          : undefined;
        if (!commandName) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        usage.set(commandName, (usage.get(commandName) ?? 0) + 1);
        const line = lines[cursorLine] ?? "";
        const beforeCursor = line.slice(0, cursorCol);
        const afterCursor = line.slice(cursorCol);
        const prefixMatch = getSlashCommandPrefix(beforeCursor);
        if (!prefixMatch) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        const slashIndex = prefixMatch.slashIndex;
        const newBefore = beforeCursor.slice(0, slashIndex) + item.value;
        const nextLines = [...lines];
        nextLines[cursorLine] = newBefore + afterCursor;
        return { lines: nextLines, cursorLine, cursorCol: newBefore.length };
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
  return resolver;
}
