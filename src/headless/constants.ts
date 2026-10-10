import { getThemeTokens } from "../core/theme/index.js";
import { CURRENT_VERSION } from "../core/version.js";
import type { BakeMode } from "../types/index.js";

export const RST = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";

function hexToAnsi(hex: string): string {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

export function PURPLE(): string {
  return hexToAnsi(getThemeTokens().brand);
}
export function RED(): string {
  return hexToAnsi(getThemeTokens().brandSecondary);
}
export function GREEN(): string {
  return hexToAnsi(getThemeTokens().success);
}
export function YELLOW(): string {
  return hexToAnsi(getThemeTokens().warning);
}

export const VALID_MODES: BakeMode[] = ["default", "architect", "plan", "auto"];

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_ABORT = 130;

export const VERSION = CURRENT_VERSION;
