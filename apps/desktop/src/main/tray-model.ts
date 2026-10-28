import type { AttentionItem, DesktopProject } from "../shared/api.js";
import { blockingCount } from "../shared/attention.js";

/**
 * What closing the window does: with "keep running in tray" on and a run still working in an
 * open project, the window hides and the app stays in the tray; otherwise it closes as usual.
 */
export function closeAction(options: {
  quitting: boolean;
  keepRunningInTray: boolean;
  projects: DesktopProject[];
}): "hide" | "close" {
  if (options.quitting || !options.keepRunningInTray) return "close";
  return options.projects.some((p) => p.open && p.overview.activeRuns > 0) ? "hide" : "close";
}

/** What `closeToTray` needs from the window, the tray and the project list. */
export interface CloseToTray {
  /** The window as it was when Close was pressed. */
  window: { hide(): void; destroy(): void; isVisible(): boolean; isDestroyed(): boolean };
  showTray(): void;
  hideTray(): void;
  /** The fresh project list, which can take seconds (it runs the CLI). */
  projects(): Promise<DesktopProject[]>;
  decide(projects: DesktopProject[]): "hide" | "close";
}

/**
 * Closing with "keep running in tray" on: the window hides and the tray shows at once, and the
 * fresh project list then decides whether the app really closes. A window shown again while the
 * list loads (a toast or tray click) stays; waiting for the list first kept the window up for
 * seconds and hid it again after such a click (#2391).
 */
export async function closeToTray(close: CloseToTray): Promise<"hide" | "close" | "reopened"> {
  close.window.hide();
  close.showTray();
  const projects = await close.projects();
  if (close.window.isDestroyed()) return "close";
  if (close.window.isVisible()) return "reopened";
  const action = close.decide(projects);
  if (action === "close") {
    close.hideTray();
    close.window.destroy();
  }
  return action;
}

export interface TrayModel {
  tooltip: string;
  /** The "N need you" menu entry; null when nothing blocks. */
  needYou: string | null;
  /** The dock or taskbar badge: the number of blocking items. */
  badge: number;
}

export function trayModel(items: AttentionItem[]): TrayModel {
  const blocking = blockingCount(items);
  return {
    tooltip: blocking ? `BAKED: ${blocking} need you` : "BAKED",
    needYou: blocking ? `${blocking} need you` : null,
    badge: blocking,
  };
}

/** The text of the taskbar overlay badge: the count up to 9, then "9+"; null clears the badge. */
export function badgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count > 9 ? "9+" : String(Math.floor(count));
}

/** 3x5 pixel glyphs of the badge digits and "+", one string per row. */
const GLYPHS: Record<string, readonly string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  "+": ["...", ".#.", "###", ".#.", "..."],
};

type Rgb = readonly [number, number, number];
/** BAKED palette (src/renderer/styles/tokens.css): `--fill-accent`, `--ink` and `--on-fill`. */
export const BADGE_FILL: Rgb = [0xff, 0x9d, 0x52];
export const BADGE_RING: Rgb = [0x00, 0x00, 0x00];
export const BADGE_TEXT: Rgb = [0x19, 0x14, 0x10];

/**
 * The Windows taskbar overlay badge as raw BGRA pixels for `nativeImage.createFromBitmap`: an
 * orange disc with a black ring and the label in a pixel font. Windows has no badge count
 * (`app.setBadgeCount` covers macOS and Unity only), so the count is drawn here.
 */
export function badgeBitmap(label: string, size = 32): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const at = (y * size + x) * 4;
    pixels[at] = b;
    pixels[at + 1] = g;
    pixels[at + 2] = r;
    pixels[at + 3] = 255;
  };
  const centre = (size - 1) / 2;
  const radius = size / 2;
  const ring = Math.max(1, Math.round(size / 16));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      if (distance <= radius - ring) put(x, y, BADGE_FILL);
      else if (distance <= radius) put(x, y, BADGE_RING);
    }
  const chars = [...label].filter((c) => GLYPHS[c]);
  if (!chars.length) return pixels;
  // The largest whole scale whose text fits the disc, with one glyph pixel between characters.
  const columns = chars.length * 4 - 1;
  const room = Math.floor((size - 4 * ring) * 0.75);
  const scale = Math.max(1, Math.min(Math.floor(room / columns), Math.floor(room / 5)));
  const left = Math.round((size - columns * scale) / 2);
  const top = Math.round((size - 5 * scale) / 2);
  chars.forEach((char, i) => {
    GLYPHS[char]?.forEach((row, gy) => {
      [...row].forEach((cell, gx) => {
        if (cell !== "#") return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            put(left + (i * 4 + gx) * scale + dx, top + gy * scale + dy, BADGE_TEXT);
      });
    });
  });
  return pixels;
}
