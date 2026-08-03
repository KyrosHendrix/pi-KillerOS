import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
