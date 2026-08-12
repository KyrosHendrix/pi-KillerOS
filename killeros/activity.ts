import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";

const WORK_TRAIL_KEY = "killeros-work-trail";
const NARROW_TRAIL_WIDTH = 48;
const MAX_TRAIL_ITEMS = 4;

const TOOL_PHASES: ReadonlyMap<string, Exclude<RequestActivityPhase, "prompt" | "result">> = new Map([
  ["read", "inspect"],
  ["grep", "inspect"],
  ["find", "inspect"],
  ["ls", "inspect"],
  ["edit", "change"],
  ["write", "change"],
  ["bash", "command"],
]);

const PHASE_LABELS = {
  prompt: "Prompt",
  inspect: "Inspect",
  change: "Change",
  command: "Command",
  tool: "Tool",
  result: "Result",
} as const satisfies Record<RequestActivityPhase, string>;

export type RequestActivityPhase = "prompt" | "inspect" | "change" | "command" | "tool" | "result";
export type RequestActivityPhaseStatus = "active" | "done" | "failed";

export interface RequestActivityItem {
  phase: RequestActivityPhase;
  status: RequestActivityPhaseStatus;
}

export type ActivityMessage =
  | { kind: "prompt" }
  | { kind: "tool"; phase: Exclude<RequestActivityPhase, "prompt" | "result">; toolName: string }
  | { kind: "tool-result"; failed: boolean }
  | { kind: "responding" };

export function activityPhaseForTool(toolName: string): Exclude<RequestActivityPhase, "prompt" | "result"> {
  const normalized = toolName.trim().toLocaleLowerCase();
  return TOOL_PHASES.get(normalized) ?? "tool";
}

function safeToolName(toolName: string): string {
  const normalized = toolName.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return truncateToWidth(normalized || "tool", 32, "…");
}

export function formatActivityMessage(message: ActivityMessage, theme: Theme): string {
  let verb: string;
  let detail: string;

  switch (message.kind) {
    case "prompt":
      verb = "Mapping…";
      detail = "understanding request";
      break;
    case "tool-result":
      verb = message.failed ? "Recovering…" : "Reviewing…";
      detail = message.failed ? "tool failed" : "reading the result";
      break;
    case "responding":
      verb = "Responding…";
      detail = "assembling the answer";
      break;
    case "tool":
      if (message.phase === "inspect") {
        verb = "Inspecting…";
        detail = "reading relevant code";
      } else if (message.phase === "change") {
        verb = "Changing…";
        detail = "editing";
      } else if (message.phase === "command") {
        verb = "Running…";
        detail = "command";
      } else {
        verb = "Working…";
        detail = `using ${safeToolName(message.toolName)}`;
      }
      break;
  }

  return `${theme.fg("accent", verb)} ${theme.fg("dim", `(${theme.bold("esc")} to interrupt · ${detail})`)}`;
}

export class RequestActivityTrail {
  private items: RequestActivityItem[] = [];

  getItems(): readonly RequestActivityItem[] {
    return this.items;
  }

  activate(phase: RequestActivityPhase): void {
    const previous = this.items.at(-1);
    if (previous?.phase === phase) {
      previous.status = "active";
      return;
    }

    for (const item of this.items) {
      if (item.status === "active") item.status = "done";
    }
    this.items.push({ phase, status: "active" });
    this.items = this.items.slice(-MAX_TRAIL_ITEMS);
  }

  failCurrent(): void {
    const current = this.items.at(-1);
    if (current) current.status = "failed";
  }

  completeCurrent(): void {
    const current = this.items.at(-1);
    if (current) current.status = "done";
  }
}

export function renderWorkTrail(
  items: readonly RequestActivityItem[],
  width: number,
  theme: Theme,
): string[] {
  if (width <= 0 || items.length === 0) return [];
  if (width < NARROW_TRAIL_WIDTH) {
    let active: RequestActivityItem | undefined;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.status !== "active") continue;
      active = item;
      break;
    }
    if (!active) return [];
    return [truncateToWidth(`${theme.fg("accent", "›")} ${PHASE_LABELS[active.phase]}`, width, "")];
  }

  const visibleItems = items.slice(-MAX_TRAIL_ITEMS);
  const rendered = visibleItems.map((item) => {
    const marker = item.status === "done" ? "✓" : item.status === "failed" ? "×" : "›";
    const color = item.status === "done" ? "success" : item.status === "failed" ? "error" : "accent";
    return `${PHASE_LABELS[item.phase]} ${theme.fg(color, marker)}`;
  }).join(theme.fg("dim", "  "));
  return [truncateToWidth(rendered, width, "")];
}

class WorkTrailComponent {
  private readonly trail: RequestActivityTrail;
  private readonly tui: TUI;
  private readonly theme: Theme;

  constructor(
    trail: RequestActivityTrail,
    tui: TUI,
    theme: Theme,
  ) {
    this.trail = trail;
    this.tui = tui;
    this.theme = theme;
  }

  render(width: number): string[] {
    return renderWorkTrail(this.trail.getItems(), width, this.theme);
  }

  invalidate(): void {
    this.tui.requestRender();
  }
}

export function registerRequestActivity(pi: ExtensionAPI): void {
  let trail: RequestActivityTrail | undefined;
  let component: WorkTrailComponent | undefined;

  const updateTrail = (): void => component?.invalidate();
  const clear = (ctx?: ExtensionContext): void => {
    if (ctx?.mode === "tui") {
      ctx.ui.setWorkingMessage();
      ctx.ui.setWidget(WORK_TRAIL_KEY, undefined);
    }
    trail = undefined;
    component = undefined;
  };

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!trail) {
      const requestTrail = new RequestActivityTrail();
      requestTrail.activate("prompt");
      trail = requestTrail;
      ctx.ui.setWidget(
        WORK_TRAIL_KEY,
        (tui, theme) => {
          component = new WorkTrailComponent(requestTrail, tui, theme);
          return component;
        },
        { placement: "aboveEditor" },
      );
    }
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "prompt" }, ctx.ui.theme));
    updateTrail();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.mode !== "tui" || !trail) return;
    const phase = activityPhaseForTool(event.toolName);
    trail.activate(phase);
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "tool", phase, toolName: event.toolName }, ctx.ui.theme));
    updateTrail();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.mode !== "tui" || !trail) return;
    if (event.isError) trail.failCurrent();
    else trail.completeCurrent();
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "tool-result", failed: event.isError }, ctx.ui.theme));
    updateTrail();
  });

  pi.on("message_update", (event, ctx) => {
    if (ctx.mode !== "tui" || !trail || event.assistantMessageEvent.type !== "text_start") return;
    trail.activate("result");
    ctx.ui.setWorkingMessage(formatActivityMessage({ kind: "responding" }, ctx.ui.theme));
    updateTrail();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || !trail || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    clear(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
}
