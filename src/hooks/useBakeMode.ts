import { getThemeTokens } from "../core/theme/index.js";
import type { BakeMode } from "../types/index.js";

/** Shift+Tab cycles these; the legacy `auto` mode is full access now (`/permissions`). */
export const MODE_ORDER: BakeMode[] = ["default", "architect", "plan"];

export const MODE_LABELS: Record<BakeMode, string> = {
  default: "Default",
  architect: "Architect",
  plan: "Plan",
  auto: "Auto",
};

export function getModeColors(): Record<BakeMode, string> {
  const t = getThemeTokens();
  return {
    default: t.textMuted,
    architect: t.brand,
    plan: t.info,
    auto: t.success,
  };
}

export const MODE_COLORS: Record<BakeMode, string> = new Proxy({} as Record<BakeMode, string>, {
  get(_, prop: string) {
    return getModeColors()[prop as BakeMode];
  },
});

export function getModeLabel(mode: BakeMode): string {
  return MODE_LABELS[mode];
}

export function getModeColor(mode: BakeMode): string {
  return getModeColors()[mode];
}

export function cycleBakeMode(current: BakeMode): BakeMode {
  const idx = MODE_ORDER.indexOf(current);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? "default";
}
