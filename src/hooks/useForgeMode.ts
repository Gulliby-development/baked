import { getThemeTokens } from "../core/theme/index.js";
import type { ForgeMode } from "../types/index.js";

export const MODE_ORDER: ForgeMode[] = ["default", "architect", "plan", "auto"];

export const MODE_LABELS: Record<ForgeMode, string> = {
  default: "Default",
  architect: "Architect",
  plan: "Plan",
  auto: "Auto",
};

export function getModeColors(): Record<ForgeMode, string> {
  const t = getThemeTokens();
  return {
    default: t.textMuted,
    architect: t.brand,
    plan: t.info,
    auto: t.success,
  };
}

export const MODE_COLORS: Record<ForgeMode, string> = new Proxy({} as Record<ForgeMode, string>, {
  get(_, prop: string) {
    return getModeColors()[prop as ForgeMode];
  },
});

export function getModeLabel(mode: ForgeMode): string {
  return MODE_LABELS[mode];
}

export function getModeColor(mode: ForgeMode): string {
  return getModeColors()[mode];
}

export function cycleForgeMode(current: ForgeMode): ForgeMode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? "default";
}
