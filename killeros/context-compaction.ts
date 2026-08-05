import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { compact, SettingsManager } from "@earendil-works/pi-coding-agent";
import { pauseGoalAfterFailure } from "./goals.ts";
import type { CompactionRuntime, GoalRuntime } from "./runtime.ts";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
type CompactionMessage = CompactionPreparation["messagesToSummarize"][number];
type MessageRecord = Record<string, unknown>;

const warnedRuntimes = new WeakSet<CompactionRuntime>();
const inFlightTimers = new WeakMap<CompactionRuntime, NodeJS.Timeout>();
const abortCleanups = new WeakMap<CompactionRuntime, () => void>();
const compactionFailureHandlers = new WeakMap<CompactionRuntime, () => void>();
const FILE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])?[A-Za-z0-9_@.-]+(?:[\\/][A-Za-z0-9_@.-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|html|py|rs|go|java|kt|rb|php|vue|svelte|yaml|yml|toml|sh|sql)\b/giu;
const PATH_KEYS = new Set(["path", "file", "filepath", "file_path", "filename", "target"]);
const MAX_MESSAGE_TEXT = 1_000;
const MAX_CONTEXT_ITEMS = 80;
const MAX_FILES = 40;
const MAX_PREVIOUS_SUMMARY = 6_000;
const MAX_CUSTOM_INSTRUCTIONS = 4_000;
const COMPACTION_STATE_TIMEOUT_MS = 5 * 60_000;
const DETERMINISTIC_FALLBACK_PREFIX = "This summary was produced deterministically without model understanding. Verify its details before relying on it.";
const COMPACTION_ACCURACY_WARNING = "Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

type NotificationLevel = Parameters<ExtensionContext["ui"]["notify"]>[1];

function asRecord(value: unknown): MessageRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as MessageRecord;
}

function compactText(value: string, limit = MAX_MESSAGE_TEXT): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, limit);
}

function textFromContent(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const text: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.text === "string") text.push(record.text);
    if (record.type === "toolCall" && typeof record.name === "string") {
      text.push(`Called ${record.name}`);
    }
  }
  return text;
}

function messageText(message: CompactionMessage): string {
  const record = asRecord(message);
  if (!record) return "";

  const text = textFromContent(record.content);
  if (typeof record.summary === "string") text.unshift(record.summary);
  return compactText(text.join(" "));
}

function messageRole(message: CompactionMessage): string {
  const role = asRecord(message)?.role;
  return typeof role === "string" && role.trim() ? role : "context";
}

function extractMessages(preparation: CompactionPreparation): Array<{ role: string; text: string }> {
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const extracted: Array<{ role: string; text: string }> = [];
  for (const message of messages) {
    const text = messageText(message);
    if (text) extracted.push({ role: messageRole(message), text });
    if (extracted.length >= MAX_CONTEXT_ITEMS) break;
  }
  return extracted;
}

function addPath(paths: Set<string>, value: string): void {
  const path = value.trim().replace(/^['"`([{<]+|['"`.,;:!?)}\]>]+$/gu, "");
  if (!path || path.includes("://") || path.length > 512 || paths.size >= MAX_FILES) return;
  paths.add(path);
}

function extractFilePaths(text: string, paths: Set<string>): void {
  FILE_PATH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_PATTERN.exec(text)) !== null) {
    addPath(paths, match[0]);
  }
}

function collectPaths(value: unknown, paths: Set<string>, depth = 0): void {
  if (paths.size >= MAX_FILES || depth > 4) return;
  if (typeof value === "string") {
    extractFilePaths(value, paths);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, depth + 1);
    return;
  }

  const record = asRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    const normalizedKey = key.toLocaleLowerCase();
    if (PATH_KEYS.has(normalizedKey) || normalizedKey === "content" || normalizedKey === "text" || normalizedKey === "summary" || normalizedKey === "arguments" || normalizedKey === "input") {
      collectPaths(item, paths, depth + 1);
    }
  }
}

function collectMessagePaths(preparation: CompactionPreparation): Set<string> {
  const paths = new Set<string>();
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  for (const message of messages) collectPaths(message, paths);
  return paths;
}

function collectFileOperationPaths(preparation: CompactionPreparation): Set<string> {
  const paths = new Set<string>();
  const fileOps = asRecord(preparation.fileOps);
  if (!fileOps) return paths;

  for (const key of ["written", "edited"]) {
    const values = fileOps[key];
    if (values instanceof Set) {
      for (const value of values) {
        if (typeof value === "string") addPath(paths, value);
      }
    } else if (Array.isArray(values)) {
      for (const value of values) {
        if (typeof value === "string") addPath(paths, value);
      }
    }
  }
  return paths;
}

function quoteText(value: string, limit: number): string {
  const text = value.trim().slice(0, limit);
  return text
    .split(/\r?\n/gu)
    .map((line) => `> ${line}`)
    .join("\n");
}

function retainSummaryEdges(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n...[previous summary truncated]...\n";
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available * 0.6);
  return `${value.slice(0, headLength)}${marker}${value.slice(-(available - headLength))}`;
}

function evidenceLine(item: { role: string; text: string }): string {
  return `- [${item.role}] ${compactText(item.text, 320)}`;
}

function recentMatches(
  messages: Array<{ role: string; text: string }>,
  predicate: (item: { role: string; text: string }) => boolean,
  limit: number,
): string[] {
  return messages.filter(predicate).slice(-limit).map(evidenceLine);
}

function buildProgress(messages: Array<{ role: string; text: string }>): string[] {
  const done = recentMatches(
    messages,
    (item) => item.role === "assistant" && /\b(?:added|built|changed|completed|created|done|fixed|implemented|modified|removed|resolved|updated|verified|passed|finished)\b/iu.test(item.text),
    4,
  );
  const inProgress = recentMatches(
    messages,
    (item) => !done.includes(evidenceLine(item)),
    3,
  );

  const lines = ["### Done"];
  lines.push(...(done.length ? done : ["- No completed work was clearly reported in the retained context."]));
  lines.push("", "### In Progress", ...(inProgress.length ? inProgress : ["- The retained context does not state the current work clearly."]));
  return lines;
}

function buildKeyDecisions(messages: Array<{ role: string; text: string }>): string[] {
  const decisions = recentMatches(
    messages,
    (item) => /\b(?:decid(?:e|ed)|chose|choose|instead|must|should|will|avoid|required|prefer|keep)\b/iu.test(item.text),
    4,
  );
  return ["- Extracted from conversation context.", ...(decisions.length ? decisions : ["- No explicit decisions were found in the retained context."])];
}

function buildModifiedFiles(preparation: CompactionPreparation, messages: Array<{ role: string; text: string }>): string[] {
  const exact = collectFileOperationPaths(preparation);
  if (exact.size) return [...exact].map((path) => `- ${path}`);

  const mentioned = collectMessagePaths(preparation);
  if (!mentioned.size) return ["- No modified files were recorded in the retained context."];

  const evidence = messages.some((item) => /\b(?:add(?:ed)?|chang(?:ed|ing)|creat(?:ed|ing)|edit(?:ed|ing)|fix(?:ed|ing)|modif(?:ied|y|ying)|updat(?:ed|ing)|writ(?:e|ten|ing)|remov(?:e|ed|ing))\b/iu.test(item.text));
  return [
    evidence
      ? "- Files mentioned with a change action (no structured file-operation record was retained):"
      : "- Files mentioned in the retained context (no structured file-operation record was retained):",
    ...[...mentioned].map((path) => `- ${path}`),
  ];
}

function buildStructuredSummary(
  preparation: CompactionPreparation,
  goalObjective: string | undefined,
  customInstructions: string | undefined,
): string {
  const messages = extractMessages(preparation);
  const firstUserMessage = messages.find((item) => item.role === "user");
  const goal = goalObjective?.trim()
    ? compactText(goalObjective, 4_000)
    : firstUserMessage
      ? compactText(firstUserMessage.text, 4_000)
      : "No explicit goal was retained; continue from the latest context.";

  const nextSteps = [
    "- Continue the task from where it was interrupted by compaction.",
    "- Re-read any files that were being edited to verify current state.",
  ];
  if (goalObjective?.trim()) nextSteps.push("- Keep the active goal moving until it is complete or clearly blocked.");
  if (customInstructions?.trim()) {
    nextSteps.push("", "Custom Instructions:", quoteText(customInstructions, MAX_CUSTOM_INSTRUCTIONS));
  }

  return [
    DETERMINISTIC_FALLBACK_PREFIX,
    "",
    "# KillerOS Compaction Summary",
    "",
    ...(preparation.previousSummary?.trim()
      ? ["## Previous Summary", quoteText(retainSummaryEdges(preparation.previousSummary, MAX_PREVIOUS_SUMMARY), MAX_PREVIOUS_SUMMARY), ""]
      : []),
    "## Goal",
    goal,
    "",
    "## Progress",
    ...buildProgress(messages),
    "",
    "## Key Decisions",
    ...buildKeyDecisions(messages),
    "",
    "## Next Steps",
    ...nextSteps,
    "",
    "## Modified Files",
    ...buildModifiedFiles(preparation, messages),
    ...(customInstructions?.trim()
      ? ["", "## Custom Instructions", quoteText(customInstructions, MAX_CUSTOM_INSTRUCTIONS)]
      : []),
  ].join("\n");
}

async function buildModelSummary(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) {
  const model = ctx.model;
  if (!model) throw new Error("No model is available for compaction");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const provider = ctx.modelRegistry.getProvider(model.provider);
  const streamFn = provider
    ? provider.streamSimple.bind(provider)
    : undefined;
  const retry = SettingsManager.create(ctx.cwd, undefined, {
    projectTrusted: ctx.isProjectTrusted(),
  }).getRetrySettings();

  return compact(
    event.preparation,
    model,
    auth.apiKey,
    auth.headers,
    event.customInstructions,
    event.signal,
    ctx.thinkingLevel,
    streamFn,
    auth.env,
    retry,
  );
}

function exactPercentRemaining(ctx: ExtensionContext): number | null {
  let usage: ReturnType<ExtensionContext["getContextUsage"]>;
  try {
    usage = ctx.getContextUsage();
  } catch {
    return null;
  }
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;
  if (usage.tokens === null || !Number.isFinite(usage.tokens)) return null;

  const percentRemaining = ((usage.contextWindow - usage.tokens) / usage.contextWindow) * 100;
  return Math.max(0, Math.min(100, percentRemaining));
}

export function contextPercentRemaining(ctx: ExtensionContext): number | null {
  const percentRemaining = exactPercentRemaining(ctx);
  return percentRemaining === null ? null : Math.round(percentRemaining);
}

function resetCompactionState(runtime: CompactionRuntime, clearTimestamp = false): void {
  runtime.compactionInFlight = false;
  runtime.automaticCompactionAwaitingHook = false;
  runtime.automaticCompactionPending = false;
  warnedRuntimes.delete(runtime);
  const timer = inFlightTimers.get(runtime);
  if (timer) clearTimeout(timer);
  inFlightTimers.delete(runtime);
  abortCleanups.get(runtime)?.();
  abortCleanups.delete(runtime);
  if (clearTimestamp) runtime.lastCompactionAt = undefined;
}

function isCurrentCompaction(runtime: CompactionRuntime, operationId: number): boolean {
  return runtime.compactionInFlight && runtime.compactionOperationId === operationId;
}

function armCompactionTimeout(runtime: CompactionRuntime, operationId: number): void {
  // ponytail: recover stale state after five minutes because Pi exposes no failed-compaction extension event; replace with that event if Pi adds one.
  const timer = setTimeout(() => {
    if (!isCurrentCompaction(runtime, operationId)) return;
    const onFailure = compactionFailureHandlers.get(runtime);
    resetCompactionState(runtime);
    compactionFailureHandlers.delete(runtime);
    onFailure?.();
  }, COMPACTION_STATE_TIMEOUT_MS);
  timer.unref();
  inFlightTimers.set(runtime, timer);
}

function markCompactionInFlight(
  runtime: CompactionRuntime,
  signal: AbortSignal,
  onFailure?: () => void,
): number | null {
  const expectedAutomaticHook = runtime.automaticCompactionAwaitingHook;
  if (runtime.compactionInFlight && !expectedAutomaticHook) return null;
  const operationId = expectedAutomaticHook
    ? runtime.compactionOperationId
    : runtime.compactionOperationId + 1;
  resetCompactionState(runtime);
  if (!expectedAutomaticHook) {
    compactionFailureHandlers.delete(runtime);
    runtime.compactionOperationId = operationId;
    if (onFailure) compactionFailureHandlers.set(runtime, onFailure);
  }
  runtime.compactionInFlight = true;
  const onAbort = (): void => {
    if (!isCurrentCompaction(runtime, operationId)) return;
    const failure = compactionFailureHandlers.get(runtime);
    resetCompactionState(runtime);
    compactionFailureHandlers.delete(runtime);
    failure?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  abortCleanups.set(runtime, () => signal.removeEventListener("abort", onAbort));
  armCompactionTimeout(runtime, operationId);
  if (signal.aborted) {
    onAbort();
    return null;
  }
  return operationId;
}

function markAutomaticCompactionInFlight(runtime: CompactionRuntime): number {
  resetCompactionState(runtime);
  compactionFailureHandlers.delete(runtime);
  const operationId = runtime.compactionOperationId + 1;
  runtime.compactionOperationId = operationId;
  runtime.compactionInFlight = true;
  runtime.automaticCompactionAwaitingHook = true;
  armCompactionTimeout(runtime, operationId);
  return operationId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(ctx: ExtensionContext, message: string, level: NotificationLevel): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // The compaction callback can run after session replacement; stale UI must not escape the detached task.
  }
}

function notifyCompactionFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  compactionRuntime: CompactionRuntime,
  goalRuntime: GoalRuntime,
  error: unknown,
): void {
  resetCompactionState(compactionRuntime);
  compactionRuntime.automaticCompactionArmed = true;
  compactionFailureHandlers.delete(compactionRuntime);
  let goalWasPaused = false;
  if (goalRuntime.continuationHeldForCompaction) {
    goalRuntime.continuationHeldForCompaction = false;
    goalRuntime.continuationHeld = false;
    pauseGoalAfterFailure(
      pi,
      goalRuntime,
      ctx,
      `automatic context compaction failed: ${errorMessage(error)}`,
      "Run /compact to retry context compaction, then /goal resume.",
    );
    goalWasPaused = true;
    goalRuntime.requestRender?.();
  }
  if (!goalWasPaused) {
    notify(ctx, `Automatic context compaction failed: ${errorMessage(error)}. Run /compact to try again.`, "error");
  }
}

function notifyPiCompactionFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  compactionRuntime: CompactionRuntime,
  goalRuntime: GoalRuntime,
  error: unknown,
): void {
  resetCompactionState(compactionRuntime);
  compactionRuntime.automaticCompactionArmed = true;
  compactionFailureHandlers.delete(compactionRuntime);
  if (goalRuntime.continuationHeldForCompaction) {
    goalRuntime.continuationHeldForCompaction = false;
    goalRuntime.continuationHeld = false;
    pauseGoalAfterFailure(
      pi,
      goalRuntime,
      ctx,
      `context compaction failed: ${errorMessage(error)}`,
      "Run /compact to retry context compaction, then /goal resume.",
    );
    goalRuntime.requestRender?.();
  }
}

function requestAutomaticCompaction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  compactionRuntime: CompactionRuntime,
  goalRuntime: GoalRuntime,
  percentRemaining: number | null,
): void {
  const sessionGeneration = compactionRuntime.sessionGeneration;
  compactionRuntime.automaticCompactionArmed = false;
  const operationId = markAutomaticCompactionInFlight(compactionRuntime);
  const handleFailure = (error: unknown, fromCleanup = false): void => {
    if (sessionGeneration !== compactionRuntime.sessionGeneration
      || compactionRuntime.compactionOperationId !== operationId
      || (!fromCleanup && !compactionRuntime.compactionInFlight)) return;
    try {
      notifyCompactionFailure(pi, ctx, compactionRuntime, goalRuntime, error);
    } catch {
      resetCompactionState(compactionRuntime);
      compactionFailureHandlers.delete(compactionRuntime);
    }
  };
  compactionFailureHandlers.set(compactionRuntime, () => handleFailure(new Error("compaction timed out or was cancelled"), true));
  try {
    ctx.compact({
      onError: handleFailure,
    });
  } catch (error) {
    handleFailure(error);
    return;
  }

  const percent = percentRemaining === null ? "the threshold" : `${percentRemaining}% remaining`;
  notify(ctx, `Context ${percent}. Compacting automatically.`, "info");
}

function resetForSessionBoundary(compactionRuntime: CompactionRuntime): void {
  compactionRuntime.sessionGeneration += 1;
  resetCompactionState(compactionRuntime, true);
  compactionRuntime.automaticCompactionArmed = true;
  compactionFailureHandlers.delete(compactionRuntime);
}

export function registerContextCompaction(
  pi: ExtensionAPI,
  compactionRuntime: CompactionRuntime,
  goalRuntime: GoalRuntime,
): void {
  pi.on("session_start", () => {
    resetForSessionBoundary(compactionRuntime);
  });

  pi.on("session_tree", () => {
    resetForSessionBoundary(compactionRuntime);
  });

  pi.on("session_shutdown", () => {
    resetForSessionBoundary(compactionRuntime);
  });

  pi.on("turn_end", (_event, ctx) => {
    const exactRemaining = exactPercentRemaining(ctx);
    if (exactRemaining === null) return;
    const percentRemaining = Math.round(exactRemaining);
    if (exactRemaining > compactionRuntime.thresholdPercent) {
      compactionRuntime.automaticCompactionArmed = true;
      compactionRuntime.automaticCompactionPending = false;
      warnedRuntimes.delete(compactionRuntime);
      return;
    }
    if (compactionRuntime.compactionInFlight) return;
    if (!compactionRuntime.automaticCompactionArmed) return;

    compactionRuntime.automaticCompactionPending = true;
    if (warnedRuntimes.has(compactionRuntime)) return;
    warnedRuntimes.add(compactionRuntime);
    notify(
      ctx,
      `Context ${percentRemaining}% remaining. Automatic compaction will start when this run settles.`,
      "warning",
    );
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (compactionRuntime.compactionInFlight) return;
    if (goalRuntime.goalTurnInFlight
      && (goalRuntime.lastStopReason === "error" || goalRuntime.lastStopReason === "aborted")) return;
    const exactRemaining = exactPercentRemaining(ctx);
    const percentRemaining = exactRemaining === null ? null : Math.round(exactRemaining);
    if (exactRemaining !== null && exactRemaining > compactionRuntime.thresholdPercent) {
      compactionRuntime.automaticCompactionArmed = true;
      compactionRuntime.automaticCompactionPending = false;
      warnedRuntimes.delete(compactionRuntime);
      return;
    }
    if (percentRemaining === null && !compactionRuntime.automaticCompactionPending) return;
    if (!compactionRuntime.automaticCompactionArmed) return;
    if (exactRemaining !== null && exactRemaining <= compactionRuntime.thresholdPercent) {
      compactionRuntime.automaticCompactionPending = true;
    }
    if (!compactionRuntime.automaticCompactionPending) return;

    requestAutomaticCompaction(pi, ctx, compactionRuntime, goalRuntime, percentRemaining);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const expectedAutomaticHook = compactionRuntime.automaticCompactionAwaitingHook;
    const sessionGeneration = compactionRuntime.sessionGeneration;
    const operationId = markCompactionInFlight(
      compactionRuntime,
      event.signal,
      expectedAutomaticHook
        ? undefined
        : () => {
          if (sessionGeneration !== compactionRuntime.sessionGeneration) return;
          try {
            notifyPiCompactionFailure(
              pi,
              ctx,
              compactionRuntime,
              goalRuntime,
              new Error("compaction timed out or was cancelled"),
            );
          } catch {
            resetCompactionState(compactionRuntime);
            compactionFailureHandlers.delete(compactionRuntime);
          }
        },
    );
    if (operationId === null) return { cancel: true };

    try {
      return { compaction: await buildModelSummary(event, ctx) };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      notify(ctx, `Model compaction failed: ${errorMessage(error)}. Using the deterministic fallback.`, "warning");
      const goalObjective = goalRuntime.state?.status === "active"
        ? goalRuntime.state.objective
        : undefined;
      const summary = buildStructuredSummary(event.preparation, goalObjective, event.customInstructions);

      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { killerosDeterministicFallback: true },
        },
      };
    }
  });

  pi.on("session_compact", (event, ctx) => {
    resetCompactionState(compactionRuntime);
    compactionFailureHandlers.delete(compactionRuntime);
    compactionRuntime.lastCompactionAt = Date.now();
    if (asRecord(event.compactionEntry.details)?.killerosDeterministicFallback === true) {
      notify(ctx, COMPACTION_ACCURACY_WARNING, "warning");
    }
  });
}
