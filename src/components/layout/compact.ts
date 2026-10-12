/** Terminals narrower or shorter than this get the compact layout. */
export const COMPACT_COLUMNS = 80;
export const COMPACT_ROWS = 24;

/** Compact layout: numbered tabs, a palette-only footer and a shorter header. */
export function isCompactTerminal(columns: number, rows: number): boolean {
  return columns < COMPACT_COLUMNS || rows < COMPACT_ROWS;
}
