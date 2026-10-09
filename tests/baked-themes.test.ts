import { afterEach, expect, test } from "bun:test";
import { applyTheme, listThemeNames, listThemes, resolveTheme } from "../src/core/theme/loader.js";
import { useThemeStore } from "../src/core/theme/store.js";
import { DARK_THEME, LIGHT_THEME } from "../src/core/theme/tokens.js";

afterEach(() => applyTheme("dark", false));

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
}

test("only the two Baked palettes are selectable", () => {
  expect(listThemeNames()).toEqual(["dark", "light"]);
  expect(listThemes().map((theme) => theme.label)).toEqual(["Baked Dark", "Baked Light"]);
});

test("old selections resolve to a valid theme and normalize the active name", () => {
  expect(resolveTheme("baked-coffee")).toBe(DARK_THEME);
  expect(resolveTheme("github-light")).toBe(LIGHT_THEME);
  expect(resolveTheme("catppuccin-latte")).toBe(LIGHT_THEME);
  applyTheme("removed-custom-theme");
  expect(useThemeStore.getState().name).toBe("dark");
});

test("both palettes have complete colors and readable body text and orange accents", () => {
  for (const theme of [DARK_THEME, LIGHT_THEME]) {
    for (const value of Object.values(theme)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    for (const bg of [theme.bgApp, theme.bgPopup, theme.bgPopupHighlight]) {
      for (const fg of [theme.textPrimary, theme.textSecondary, theme.textMuted, theme.brand]) {
        const light = Math.max(luminance(fg), luminance(bg));
        const dark = Math.min(luminance(fg), luminance(bg));
        expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

test("transparent variants do not mutate the built-in palettes", () => {
  applyTheme("dark", true, { userMessageOpacity: 0, diffOpacity: 0 });
  expect(useThemeStore.getState().tokens.bgApp).toBe("transparent");
  expect(useThemeStore.getState().tokens.bgUser).toBe("transparent");
  expect(LIGHT_THEME.bgApp).toBe("#fffaf2");
  applyTheme("light", false);
  expect(useThemeStore.getState().tokens).toBe(LIGHT_THEME);
});

test("light text surfaces stay opaque even with legacy transparency settings", () => {
  for (const opacity of [0, 20, 50, 100]) {
    applyTheme("light", true, { userMessageOpacity: opacity, diffOpacity: opacity });
    expect(useThemeStore.getState().tokens.bgApp).toBe(LIGHT_THEME.bgApp);
    expect(useThemeStore.getState().tokens.bgUser).toBe(LIGHT_THEME.bgUser);
  }
});
