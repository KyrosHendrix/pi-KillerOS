import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth } from "@earendil-works/pi-tui";

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
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
export const LEVEL_COLORS: Readonly<Record<ThinkingLevel, ThemeColor>> = {
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
  return ALL_LEVELS.some((level) => level === value);
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

export function registerVariants(pi: ExtensionAPI): void {
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
      const current = pi.getThinkingLevel();
      const items = supported.map((level) => ({
        value: level,
        label: level === current ? `${LEVEL_LABELS[level]} ← current` : LEVEL_LABELS[level],
        description: LEVEL_DESCRIPTIONS[level],
      }));
      const selected = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, keybindings, done) => {
        const listTheme = {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        };
        let selectList: SelectList | undefined;
        let visibleOptionRows = 0;

        const chromeFor = (rowBudget: number): "full" | "compact" | "none" => (
          rowBudget >= 8 ? "full" : rowBudget >= 4 ? "compact" : "none"
        );
        const visibleRowsFor = (rowBudget: number): number => {
          const chrome = chromeFor(rowBudget);
          const chromeRows = chrome === "full" ? 5 : chrome === "compact" ? 2 : 0;
          const availableListRows = Math.max(1, rowBudget - chromeRows);
          return availableListRows >= items.length
            ? items.length
            : Math.max(1, availableListRows - 1);
        };
        const ensureSelectList = (nextVisibleOptionRows: number): SelectList => {
          if (selectList && visibleOptionRows === nextVisibleOptionRows) return selectList;
          const selectedValue = selectList?.getSelectedItem()?.value ?? current;
          const nextSelectList = new SelectList(items, nextVisibleOptionRows, listTheme);
          const selectedIndex = items.findIndex((item) => item.value === selectedValue);
          nextSelectList.setSelectedIndex(Math.max(0, selectedIndex));
          nextSelectList.onSelect = (item) => done(isThinkingLevel(item.value) ? item.value : null);
          nextSelectList.onCancel = () => done(null);
          selectList = nextSelectList;
          visibleOptionRows = nextVisibleOptionRows;
          return nextSelectList;
        };

        const border = new DynamicBorder((text: string) => theme.fg("accent", text));
        const title = ` ${theme.fg("accent", theme.bold("Thinking variants"))}`;
        const model = ` ${theme.fg("dim", `Model: ${modelLabel(ctx.model)}`)}`;
        const keyHint = (keybinding: Parameters<typeof keybindings.getKeys>[0], description: string): string => {
          const keyText = keybindings.getKeys(keybinding)
            .join("/")
            .split("/")
            .map((key) => key.split("+").map((part) => process.platform === "darwin" && part.toLocaleLowerCase() === "alt" ? "option" : part).join("+"))
            .join("/");
          return theme.fg("dim", keyText) + theme.fg("muted", ` ${description}`);
        };
        const controls = ` ${theme.fg("dim", `${keyHint("tui.select.up", "up")} • ${keyHint("tui.select.down", "down")} • ${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`)}`;

        const render = (width: number): string[] => {
          const rowBudget = Math.max(0, tui.terminal.rows);
          if (width <= 0 || rowBudget === 0) return [];
          const chrome = chromeFor(rowBudget);
          const list = ensureSelectList(visibleRowsFor(rowBudget));
          const lines: string[] = [];

          if (chrome === "full") lines.push(...border.render(width));
          if (chrome !== "none") lines.push(title);
          if (chrome === "full") lines.push(model);
          lines.push(...list.render(width));
          if (chrome !== "none") lines.push(controls);
          if (chrome === "full") lines.push(...border.render(width));

          return lines.slice(0, rowBudget).map((line) => truncateToWidth(line, width, ""));
        };

        return {
          render,
          invalidate: () => selectList?.invalidate(),
          handleInput: (data) => {
            ensureSelectList(visibleRowsFor(Math.max(1, tui.terminal.rows))).handleInput(data);
            tui.requestRender();
          },
        };
      });
      if (selected) setLevel(ctx, selected);
    },
  });
}
