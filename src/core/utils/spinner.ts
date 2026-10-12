/**
 * The one spinner of the terminal UI: a half block turning clockwise. Tabs, tool rows,
 * compaction, the tool-rail phase header and popups all use it. The glyphs are in CP437,
 * so Windows console fonts render them without falling back to missing-glyph boxes.
 */
export const SPINNER_FRAMES: readonly string[] = ["▀", "▐", "▄", "▌"];

/** Milliseconds between spinner frames. */
export const SPINNER_TICK_MS = 150;

export function spinnerGlyph(tick: number): string {
  const n = SPINNER_FRAMES.length;
  return SPINNER_FRAMES[((tick % n) + n) % n] as string;
}
