import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatThreadControls, type ThreadStatus } from "./subagent-ui.ts";

export type SubagentControlAction = "list" | "inspect" | "wait" | "steer" | "interrupt" | "collect" | "resume" | "close";

export interface SubagentControlRequest {
  action: SubagentControlAction;
  threadId?: string;
  all?: true;
  message?: string;
  task?: string;
  timeoutMs?: number;
}

interface SubagentControlThread {
  id: string;
  displayName?: string;
  name?: string;
  agent?: string;
  role?: string;
  task?: string;
  prompt?: string;
  status?: string;
  state?: string;
}

export interface SubagentControlDetails {
  results?: readonly SubagentControlThread[];
  threads?: readonly SubagentControlThread[];
}

export interface SubagentControlResult {
  text: string;
  details?: SubagentControlDetails;
  usage?: unknown;
}

export interface SubagentControlApi {
  execute(request: SubagentControlRequest, ctx: ExtensionContext): Promise<SubagentControlResult>;
}

export interface SubagentToolLike {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{
    content?: readonly { type: string; text?: string }[];
    details?: unknown;
    usage?: unknown;
  }>;
}

export function createSubagentControlApi(tool: SubagentToolLike): SubagentControlApi {
  return {
    async execute(request, ctx) {
      const toolRequest = request.action === "interrupt" && request.threadId === "all"
        ? { action: "interrupt", all: true }
        : request;
      const result = await tool.execute("subagents-command", toolRequest, ctx.signal, undefined, ctx);
      const text = result.content?.find((item) => item.type === "text")?.text ?? "";
      return {
        text,
        details: result.details as SubagentControlDetails | undefined,
        usage: result.usage,
      };
    },
  };
}

async function confirmNewSession(ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm("Start new session", "Start a new session and leave the current history?");
}

export function registerAliases(pi: ExtensionAPI): void {
  const startNewSession = async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
    await ctx.waitForIdle();
    if (!await confirmNewSession(ctx)) return;
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
  goal: "/goal [objective|clear|edit|pause|resume]",
  variants: "/variants [level]",
  subagents: "/subagents [list|inspect|wait|steer|interrupt|collect|resume|close] [thread]",
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

const SUBAGENT_COMMAND_USAGE = "/subagents [list|inspect|wait|steer|interrupt|collect|resume|close] [thread]";

function subagentCommandError(message: string): Error {
  return new Error(`${message} Usage: ${SUBAGENT_COMMAND_USAGE}`);
}

function parseThreadReference(action: SubagentControlAction, tail: string): string {
  const reference = tail.match(/^(\S+)(?:\s+([\s\S]*))?$/u)?.[1];
  if (!reference) throw subagentCommandError(`/subagents ${action} requires a thread reference.`);
  return reference;
}

function parseExplicitSubagentCommand(args: string): SubagentControlRequest {
  const trimmed = args.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  if (!match) throw subagentCommandError("/subagents requires an explicit verb outside TUI.");
  const action = match[1]!.toLocaleLowerCase() as SubagentControlAction;
  const tail = match[2]?.trim() ?? "";

  if (action === "list") {
    if (tail) throw subagentCommandError("/subagents list does not accept arguments.");
    return { action };
  }
  if (action === "wait") {
    if (!tail) return { action };
    const parts = tail.split(/\s+/u);
    if (parts.length > 2) throw subagentCommandError("/subagents wait accepts one thread reference and one timeout-ms value.");
    if (parts.length === 1 && /^\d+$/u.test(parts[0]!)) {
      return { action, timeoutMs: parseTimeout(parts[0]!) };
    }
    const request: SubagentControlRequest = { action, threadId: parts[0] };
    if (parts[1] !== undefined) request.timeoutMs = parseTimeout(parts[1]);
    return request;
  }
  if (action === "steer") {
    const referenceAndMessage = tail.match(/^(\S+)(?:\s+([\s\S]+))?$/u);
    if (!referenceAndMessage?.[1]) throw subagentCommandError("/subagents steer requires a thread reference.");
    if (!referenceAndMessage[2]?.trim()) throw subagentCommandError("/subagents steer requires a message.");
    return { action, threadId: referenceAndMessage[1], message: referenceAndMessage[2] };
  }
  if (action === "resume") {
    const referenceAndTask = tail.match(/^(\S+)(?:\s+([\s\S]+))?$/u);
    if (!referenceAndTask?.[1]) throw subagentCommandError("/subagents resume requires a thread reference.");
    return {
      action,
      threadId: referenceAndTask[1],
      ...(referenceAndTask[2] ? { task: referenceAndTask[2] } : {}),
    };
  }
  if (action === "inspect" || action === "interrupt" || action === "collect" || action === "close") {
    const threadId = parseThreadReference(action, tail);
    if (tail.slice(threadId.length).trim()) throw subagentCommandError(`/subagents ${action} accepts one thread reference.`);
    return { action, threadId };
  }
  throw subagentCommandError(`Unknown /subagents action ${JSON.stringify(match[1])}.`);
}

function parseTimeout(value: string): number {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw subagentCommandError("/subagents wait timeout-ms must be a non-negative integer.");
  }
  return timeoutMs;
}

function controlThreads(result: SubagentControlResult): SubagentControlThread[] {
  const details = result.details;
  if (!details) return [];
  const results = [...(details.results ?? [])];
  const threads = [...(details.threads ?? [])];
  const candidates = results.length ? results : threads;
  return candidates.filter((thread) => thread && typeof thread.id === "string" && thread.state !== "closed" && thread.status !== "closed");
}

function threadStatus(thread: SubagentControlThread): ThreadStatus {
  const status = (thread.status ?? thread.state ?? "queued").toLocaleLowerCase();
  if (status === "active" || status === "running") return "running";
  if (status === "done" || status === "complete" || status === "closed") return "complete";
  if (status === "stopped" || status === "cancelled") return "cancelled";
  if (status === "limited") return "limited";
  if (status === "orphaned") return "orphaned";
  if (status === "failed") return "failed";
  return "queued";
}

function threadLabel(thread: SubagentControlThread): string {
  const name = thread.displayName ?? thread.name ?? thread.agent ?? thread.role ?? thread.id;
  return `${name} · ${thread.id} · ${threadStatus(thread)}`;
}

function selectedThread(threads: readonly SubagentControlThread[], labels: readonly string[], choice: string): SubagentControlThread | undefined {
  const index = labels.indexOf(choice);
  if (index >= 0) return threads[index];
  return threads.find((thread) => thread.id === choice || thread.displayName === choice || thread.name === choice);
}

async function executeSubagentControl(
  control: SubagentControlApi | undefined,
  request: SubagentControlRequest,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!control) throw new Error("Subagent control API is not available.");
  const result = await control.execute(request, ctx);
  if (result?.text) ctx.ui.notify(result.text, "info");
}

async function runTuiSubagentCommand(control: SubagentControlApi | undefined, ctx: ExtensionCommandContext): Promise<void> {
  if (!control) throw new Error("Subagent control API is not available.");
  const listed = await control.execute({ action: "list" }, ctx);
  const threads = controlThreads(listed);
  if (!threads.length) {
    ctx.ui.notify("No child threads.", "info");
    return;
  }

  const labels = threads.map(threadLabel);
  const selected = await ctx.ui.select("Select a thread", labels);
  if (selected === undefined) return;
  const thread = selectedThread(threads, labels, selected);
  if (!thread) return;

  const controls = formatThreadControls(threadStatus(thread)).filter((item) => item.enabled);
  const controlLabels = controls.map((item) => item.label);
  const selectedControl = await ctx.ui.select("Select a control", controlLabels);
  if (selectedControl === undefined) return;
  const chosen = controls.find((item) => item.label === selectedControl || item.id === selectedControl);
  if (!chosen) return;

  const request: SubagentControlRequest = { action: chosen.id, threadId: thread.id };
  if (chosen.id === "steer") {
    const message = await ctx.ui.input("Steer child thread", "Message");
    if (message === undefined || !message.trim()) return;
    request.message = message;
  } else if (chosen.id === "resume") {
    const task = await ctx.ui.input("Resume child thread", "Optional task");
    if (task === undefined) return;
    if (task) request.task = task;
  }
  await executeSubagentControl(control, request, ctx);
}

export function registerSubagentCommand(pi: ExtensionAPI, control?: SubagentControlApi | void): void {
  const api = control && typeof control.execute === "function" ? control : undefined;
  pi.registerCommand("subagents", {
    description: "Inspect and control child threads",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        if (ctx.mode !== "tui") throw subagentCommandError("/subagents requires an explicit verb outside TUI.");
        await runTuiSubagentCommand(api, ctx);
        return;
      }
      await executeSubagentControl(api, parseExplicitSubagentCommand(args), ctx);
    },
  });
}

export function registerSlashAutocomplete(pi: ExtensionAPI): void {
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

        if (!commands.has("subagents")) {
          commands.set("subagents", {
            name: "subagents",
            description: "Inspect and control child threads",
            category: "Extension",
            syntaxHint: COMMAND_SYNTAX_HINTS.subagents,
          });
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
