export interface ThemeTokens {
  // Brand
  brand: string;
  brandSecondary: string;
  brandDim: string;
  brandAlt: string;

  // Semantic status
  error: string;
  success: string;
  warning: string;
  info: string;
  amber: string;

  // Text hierarchy
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDim: string;
  textFaint: string;
  textSubtle: string;

  // Backgrounds
  bgApp: string;
  bgPopup: string;
  bgPopupHighlight: string;
  bgOverlay: string;
  bgPrimary: string;
  bgSecondary: string;
  bgElevated: string;
  bgInput: string;
  bgBanner: string;
  bgBannerError: string;
  bgUser: string;

  // Borders
  border: string;
  borderFocused: string;
  borderActive: string;
  borderSlash: string;

  // Diff
  diffAddedBg: string;
  diffRemovedBg: string;
  diffAddedSign: string;
  diffRemovedSign: string;

  // Accents
  accentUser: string;
  accentAssistant: string;
  accentSystem: string;
}

export const DARK_THEME: ThemeTokens = {
  brand: "#ff9d52",
  brandSecondary: "#ffd0a0",
  brandDim: "#493022",
  brandAlt: "#edb77e",
  error: "#ff8e86",
  success: "#accd94",
  warning: "#f2c575",
  info: "#eac8a3",
  amber: "#f2c575",
  textPrimary: "#fff4e5",
  textSecondary: "#e5d4c1",
  textMuted: "#c2ac96",
  textDim: "#b59d87",
  textFaint: "#a88e77",
  textSubtle: "#68513f",
  bgApp: "#191410",
  bgPopup: "#241c16",
  bgPopupHighlight: "#4b3020",
  bgOverlay: "#100c09",
  bgPrimary: "#191410",
  bgSecondary: "#201913",
  bgElevated: "#30241b",
  bgInput: "#191410",
  bgBanner: "#392719",
  bgBannerError: "#45241f",
  bgUser: "#302219",
  border: "#795a40",
  borderFocused: "#ffd0a0",
  borderActive: "#ff9d52",
  borderSlash: "#edb77e",
  diffAddedBg: "#263222",
  diffRemovedBg: "#40251f",
  diffAddedSign: "#accd94",
  diffRemovedSign: "#ff8e86",
  accentUser: "#ffd0a0",
  accentAssistant: "#ff9d52",
  accentSystem: "#c2ac96",
};

export const LIGHT_THEME: ThemeTokens = {
  brand: "#9b3d09",
  brandSecondary: "#78340f",
  brandDim: "#f3d5b7",
  brandAlt: "#91451a",
  error: "#b02e25",
  success: "#426b2f",
  warning: "#815007",
  info: "#755039",
  amber: "#815007",
  textPrimary: "#302015",
  textSecondary: "#57402d",
  textMuted: "#71563f",
  textDim: "#7d624c",
  textFaint: "#82644a",
  textSubtle: "#c4a586",
  bgApp: "#fffaf2",
  bgPopup: "#fff3e2",
  bgPopupHighlight: "#f3d5b7",
  bgOverlay: "#f1e3d0",
  bgPrimary: "#fffaf2",
  bgSecondary: "#fcf0df",
  bgElevated: "#f6e6d1",
  bgInput: "#fffaf2",
  bgBanner: "#f6dfc1",
  bgBannerError: "#ffe0d8",
  bgUser: "#f8e7d1",
  border: "#aa825d",
  borderFocused: "#78340f",
  borderActive: "#a7440b",
  borderSlash: "#91451a",
  diffAddedBg: "#e8efdb",
  diffRemovedBg: "#fbe3dc",
  diffAddedSign: "#426b2f",
  diffRemovedSign: "#b02e25",
  accentUser: "#78340f",
  accentAssistant: "#a7440b",
  accentSystem: "#71563f",
};

export interface ThemeMeta {
  label: string;
  description: string;
  variant: "dark" | "light";
}
export const THEME_META: Record<string, ThemeMeta> = {
  dark: {
    label: "Baked Dark",
    description: "Warm crust, cream text and orange accents",
    variant: "dark",
  },
  light: {
    label: "Baked Light",
    description: "Flour-white surfaces and toasted orange accents",
    variant: "light",
  },
};
export const BUILTIN_THEMES: Record<string, ThemeTokens> = { dark: DARK_THEME, light: LIGHT_THEME };

export function normalizeTokenKey(key: string): string {
  return key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
