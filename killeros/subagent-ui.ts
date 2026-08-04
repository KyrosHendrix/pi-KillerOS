export type ThreadStatus = "queued" | "running" | "complete" | "failed" | "cancelled" | "limited" | "orphaned";

export interface ThreadUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  turns: number;
  cost?: number | { total: number };
}

export interface ThreadRecord {
  id: string;
  displayName?: string;
  attempt?: number;
  agent: string;
  task: string;
  status: ThreadStatus;
  usage: ThreadUsage;
  trace?: readonly string[];
  traceTruncatedBytes?: number;
  handoff?: string;
  output?: string;
  terminationReason?: string;
  errorMessage?: string;
  durationMs?: number;
  step?: number;
}

export const THREAD_BOARD_CONTROL_LABELS = {
  inspect: "Inspect",
  steer: "Steer",
  interrupt: "Interrupt",
  wait: "Wait",
  collect: "Collect",
  resume: "Resume",
  close: "Close",
} as const;

export type ThreadBoardControlId = keyof typeof THREAD_BOARD_CONTROL_LABELS;

export interface ThreadBoardControl {
  id: ThreadBoardControlId;
  label: (typeof THREAD_BOARD_CONTROL_LABELS)[ThreadBoardControlId];
  enabled: boolean;
}

export interface ThreadStateView {
  status: ThreadStatus;
  label: string;
  reason?: string;
  partialWork?: string;
}

export interface ThreadUsageView {
  label: string;
  turns: number;
  totalTokens: number;
  cost?: number;
  text: string;
}

export interface ThreadTraceView {
  label: "Trace";
  entries: readonly string[];
  truncatedBytes: number;
  summary: string;
}

export interface ThreadHandoffView {
  label: "Handoff";
  text: string;
  isPartial: boolean;
}

export interface ThreadListItem {
  record: ThreadRecord;
  id: string;
  displayName?: string;
  attempt?: number;
  agent: string;
  task: string;
  step?: number;
  state: ThreadStateView;
  usage: ThreadUsageView;
  selected: boolean;
}

export interface ThreadInspectionView {
  id: string;
  displayName?: string;
  attempt?: number;
  agent: string;
  task: string;
  step?: number;
  state: ThreadStateView;
  usage: ThreadUsageView;
  trace: ThreadTraceView;
  handoff: ThreadHandoffView;
  controls: readonly ThreadBoardControl[];
}

export interface ParentThreadBoard {
  title: string;
  active: readonly ThreadListItem[];
  done: readonly ThreadListItem[];
  selected?: ThreadInspectionView;
}

export interface ThreadBoardInput {
  threads: readonly ThreadRecord[];
  selectedThreadId?: string;
  closedThreadIds?: readonly string[];
  previous?: ParentThreadBoard;
  title?: string;
}

function isDone(status: ThreadStatus): boolean {
  return !["queued", "running"].includes(status);
}

function toRecord(item: ThreadListItem): ThreadRecord {
  return {
    ...item.record,
    trace: item.record.trace ? [...item.record.trace] : undefined,
    usage: { ...item.record.usage },
  };
}

function threadStatus(thread: Pick<ThreadRecord, "status" | "terminationReason">): ThreadStatus {
  const reason = thread.terminationReason;
  if (thread.status === "orphaned") return "orphaned";
  if (thread.status === "failed" || reason === "error" || reason === "spawn_error" || reason === "process_closed" || reason === "missing_assistant_message" || reason === "malformed_jsonl" || reason === "invalid_usage" || reason?.startsWith("exit_")) return "failed";
  if (thread.status === "cancelled" || reason === "abort" || reason === "interrupt") return "cancelled";
  if (thread.status === "complete" || reason === "completed") return "complete";
  return thread.status;
}

function threadReason(thread: Pick<ThreadRecord, "terminationReason" | "errorMessage">, status: ThreadStatus): string | undefined {
  if (status === "cancelled" && thread.terminationReason === "interrupt") return "Interrupted by user.";
  if (status === "cancelled" && thread.terminationReason === "abort") return "Cancelled by parent.";
  if (status === "failed" && thread.errorMessage && thread.terminationReason) return `${thread.terminationReason}: ${thread.errorMessage}`;
  if (status === "failed") return thread.errorMessage ?? thread.terminationReason ?? "Child process failed.";
  return thread.terminationReason;
}

export function formatThreadState(thread: Pick<ThreadRecord, "status" | "terminationReason" | "errorMessage">): ThreadStateView {
  const status = threadStatus(thread);
  const reason = threadReason(thread, status);
  if (status === "complete") return { status, label: "Complete" };
  if (status === "failed") return { status, label: "Failed", reason, partialWork: "Failed before completion. Any saved output is partial work." };
  if (status === "cancelled") return { status, label: "Stopped", reason, partialWork: "Stopped before completion. Any saved output is partial work." };
  if (status === "limited") return { status, label: "Limited", reason, partialWork: "Stopped at a limit before completion. Any saved output is partial work." };
  if (status === "orphaned") return { status, label: "Orphaned", reason, partialWork: "The parent session restarted before completion. Any saved output is partial work." };
  if (status === "running") return { status, label: "Running", reason };
  return { status, label: "Queued", reason };
}

export function formatThreadUsage(usage: ThreadUsage): ThreadUsageView {
  const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`, `${usage.totalTokens} tokens`];
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  return { label: "Usage", turns: usage.turns, totalTokens: usage.totalTokens, cost, text: parts.join(" · ") };
}

export function formatThreadTrace(thread: Pick<ThreadRecord, "trace" | "traceTruncatedBytes">): ThreadTraceView {
  const entries = [...(thread.trace ?? [])];
  const truncatedBytes = thread.traceTruncatedBytes ?? 0;
  return {
    label: "Trace",
    entries,
    truncatedBytes,
    summary: truncatedBytes ? `${entries.length} entries; ${truncatedBytes} B omitted` : `${entries.length} entries`,
  };
}

export function formatThreadHandoff(thread: Pick<ThreadRecord, "status" | "terminationReason" | "handoff" | "output">): ThreadHandoffView {
  const text = thread.handoff ?? thread.output ?? "No handoff yet.";
  return { label: "Handoff", text, isPartial: threadStatus(thread) !== "complete" };
}

export function formatThreadControls(status: ThreadStatus): readonly ThreadBoardControl[] {
  const active = !isDone(status);
  return [
    { id: "inspect", label: THREAD_BOARD_CONTROL_LABELS.inspect, enabled: true },
    { id: "steer", label: THREAD_BOARD_CONTROL_LABELS.steer, enabled: active },
    { id: "interrupt", label: THREAD_BOARD_CONTROL_LABELS.interrupt, enabled: active },
    { id: "wait", label: THREAD_BOARD_CONTROL_LABELS.wait, enabled: active },
    { id: "collect", label: THREAD_BOARD_CONTROL_LABELS.collect, enabled: isDone(status) },
    { id: "resume", label: THREAD_BOARD_CONTROL_LABELS.resume, enabled: isDone(status) },
    { id: "close", label: THREAD_BOARD_CONTROL_LABELS.close, enabled: isDone(status) },
  ];
}

export function formatThreadInspection(thread: ThreadRecord): ThreadInspectionView {
  return {
    id: thread.id,
    displayName: thread.displayName,
    attempt: thread.attempt,
    agent: thread.agent,
    task: thread.task,
    step: thread.step,
    state: formatThreadState(thread),
    usage: formatThreadUsage(thread.usage),
    trace: formatThreadTrace(thread),
    handoff: formatThreadHandoff(thread),
    controls: formatThreadControls(thread.status),
  };
}

function formatThreadListItem(thread: ThreadRecord, selectedThreadId: string | undefined): ThreadListItem {
  return {
    record: { ...thread, trace: thread.trace ? [...thread.trace] : undefined, usage: { ...thread.usage } },
    id: thread.id,
    displayName: thread.displayName,
    attempt: thread.attempt,
    agent: thread.agent,
    task: thread.task,
    step: thread.step,
    state: formatThreadState(thread),
    usage: formatThreadUsage(thread.usage),
    selected: thread.id === selectedThreadId,
  };
}

export function formatThreadBoard(input: ThreadBoardInput): ParentThreadBoard {
  const closed = new Set(input.closedThreadIds);
  const current = new Map(input.threads.filter((thread) => !closed.has(thread.id)).map((thread) => [thread.id, thread]));
  const retained = input.previous?.done
    .filter((thread) => !closed.has(thread.id) && !current.has(thread.id))
    .map(toRecord) ?? [];
  const threads = [...current.values(), ...retained];
  const active = threads.filter((thread) => !isDone(thread.status)).map((thread) => formatThreadListItem(thread, input.selectedThreadId));
  const done = threads.filter((thread) => isDone(thread.status)).map((thread) => formatThreadListItem(thread, input.selectedThreadId));
  const selectedThread = input.selectedThreadId ? threads.find((thread) => thread.id === input.selectedThreadId) : undefined;
  return {
    title: input.title ?? "Threads",
    active,
    done,
    selected: selectedThread ? formatThreadInspection(selectedThread) : undefined,
  };
}
