/**
 * Border glyph palettes for `<box customBorderChars={…}>`.
 *
 * OpenTUI lets us swap the 11 glyphs used to render a box border. We expose
 * three pre-built sets:
 *
 *  - HEAVY_RAIL: solid block (▌) — the legacy Baked rail. Strong identity,
 *    used for top-level messages and major chat rails.
 *  - LIGHT_RAIL: vertical line (│) — single-cell, breathes more, ideal for
 *    nested tools, dialogs, inline previews.
 *  - DOUBLE_RAIL: double-line (║) — for emphasis (warnings, errors) without
 *    pulling in heavy block weight.
 *  - TREE_PIPE / TREE_SPACE: existing tree-connector pair, re-exported here
 *    so call sites import one module instead of two.
 *
 * Every set fills all 11 slots with the same glyph because `<box>` only
 * renders the border edges that are listed in the `border` prop — when a
 * caller passes `border={["left"]}` only the vertical glyph is drawn, etc.
 */

type BorderSet = Readonly<{
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  topT: string;
  bottomT: string;
  leftT: string;
  rightT: string;
  cross: string;
}>;

function fill(glyph: string): BorderSet {
  return {
    topLeft: glyph,
    topRight: glyph,
    bottomLeft: glyph,
    bottomRight: glyph,
    horizontal: glyph,
    vertical: glyph,
    topT: glyph,
    bottomT: glyph,
    leftT: glyph,
    rightT: glyph,
    cross: glyph,
  } as const;
}

/** Solid left-rail. The default Baked identity. */
export const HEAVY_RAIL: BorderSet = fill("▌");

/** Single vertical line — calmer rail for nested or compact rows. */
export const LIGHT_RAIL: BorderSet = fill("│");

/** Double vertical line — emphasis without going to block weight. */
export const DOUBLE_RAIL: BorderSet = fill("║");

/** Dotted vertical — ambient/inert content (collapsed checkpoints, etc.). */
export const DOTTED_RAIL: BorderSet = fill("┊");

/** Tree-connector glyphs — vertical pipe with an explicit "still going" weight. */
export const TREE_PIPE: BorderSet = fill("│");

/** Tree-connector glyph used to render the last child (empty space). */
export const TREE_SPACE: BorderSet = fill(" ");

/** Named alias for `HEAVY_RAIL` — keeps existing call sites readable. */
export const RAIL_BORDER = HEAVY_RAIL;

export type { BorderSet };
