import { useThemeStore } from "./store.js";
import { BUILTIN_THEMES, DARK_THEME, THEME_META, type ThemeTokens } from "./tokens.js";

export function resolveThemeName(name: string): "dark" | "light" {
  return name === "light" || name.includes("light") || name === "catppuccin-latte"
    ? "light"
    : "dark";
}

export function resolveTheme(name: string): ThemeTokens {
  return BUILTIN_THEMES[resolveThemeName(name)] ?? DARK_THEME;
}

function blendBgOpacity(hex: string, opacity: number): string {
  if (opacity <= 0) return "transparent";
  if (opacity >= 100) return hex;
  const h = hex.replace("#", "");
  const r = Math.round((Number.parseInt(h.slice(0, 2), 16) * opacity) / 100);
  const g = Math.round((Number.parseInt(h.slice(2, 4), 16) * opacity) / 100);
  const b = Math.round((Number.parseInt(h.slice(4, 6), 16) * opacity) / 100);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function scaleColor(hex: string, factor: number): string {
  const h = hex.replace("#", "");
  const r = Math.min(255, Math.round(Number.parseInt(h.slice(0, 2), 16) * factor));
  const g = Math.min(255, Math.round(Number.parseInt(h.slice(2, 4), 16) * factor));
  const b = Math.min(255, Math.round(Number.parseInt(h.slice(4, 6), 16) * factor));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

const BORDER_STRENGTH_FACTOR: Record<BorderStrength, number> = {
  default: 1.0,
  strong: 1.8,
  op: 2.8,
};

export type BorderStrength = "default" | "strong" | "op";

interface TransparencyOptions {
  userMessageOpacity?: number;
  diffOpacity?: number;
  borderStrength?: BorderStrength;
}

/** Resolve theme and push to Zustand store */
export function applyTheme(
  name: string,
  transparent?: boolean,
  opts?: number | TransparencyOptions,
): void {
  // Backward compat: bare number = userMessageOpacity
  const tOpts: TransparencyOptions =
    typeof opts === "number" ? { userMessageOpacity: opts } : (opts ?? {});

  let tokens = resolveTheme(name);
  if (transparent && resolveThemeName(name) === "dark") {
    tokens = { ...tokens, bgApp: "transparent" };
    const msgOp = tOpts.userMessageOpacity;
    if (msgOp != null && msgOp < 100) {
      tokens = { ...tokens, bgUser: blendBgOpacity(tokens.bgUser, msgOp) };
    }
    const diffOp = tOpts.diffOpacity;
    if (diffOp != null && diffOp < 100) {
      tokens = {
        ...tokens,
        diffAddedBg: blendBgOpacity(tokens.diffAddedBg, diffOp),
        diffRemovedBg: blendBgOpacity(tokens.diffRemovedBg, diffOp),
      };
    }
  }
  // Border strength applies regardless of transparent mode
  const bdrStr = tOpts.borderStrength;
  if (bdrStr && bdrStr !== "default") {
    const strength = BORDER_STRENGTH_FACTOR[bdrStr];
    const f = resolveThemeName(name) === "light" ? 1 / strength : strength;
    tokens = {
      ...tokens,
      border: scaleColor(tokens.border, f),
      textFaint: scaleColor(tokens.textFaint, f),
      textSubtle: scaleColor(tokens.textSubtle, f),
    };
  }
  useThemeStore.getState().setTheme(resolveThemeName(name), tokens);
}

export interface ResolvedThemeInfo {
  id: string;
  label: string;
  description: string;
  variant: "dark" | "light";
  isCustom: boolean;
  brand: string;
  brandSecondary: string;
  bgPrimary: string;
  textPrimary: string;
}

export function listThemes(): ResolvedThemeInfo[] {
  return Object.entries(BUILTIN_THEMES).map(([id, tokens]) => ({
    id,
    ...(THEME_META[id] ?? { label: id, description: "", variant: "dark" as const }),
    isCustom: false,
    brand: tokens.brand,
    brandSecondary: tokens.brandSecondary,
    bgPrimary: tokens.bgPrimary,
    textPrimary: tokens.textPrimary,
  }));
}

export function listThemeNames(): string[] {
  return Object.keys(BUILTIN_THEMES);
}
