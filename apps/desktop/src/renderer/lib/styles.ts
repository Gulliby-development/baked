// Class strings shared across screens for the layout and text patterns that have no component of
// their own. Combine them with `cn` so a screen's own utilities replace conflicting ones. Rules for
// descendants sit in `:where()`, so a utility on the descendant itself still wins.

/** A screen's content column; its h1 is the page title. */
export const PAGE =
  "flex max-w-[1200px] flex-col gap-4 px-7 py-[22px] [:where(&)_h1]:m-0 [:where(&)_h1]:text-[24px] [:where(&)_h1]:font-bold [:where(&)_h1]:tracking-[-0.01em]";

/** A small uppercase mono heading above a section or panel. */
export const LABEL =
  "m-0 font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-dim-foreground";

/** The muted sentence under a page title. */
export const LEDE = "m-0 text-[13px] text-muted-foreground";

/** A column that lets its text truncate. */
export const STACK = "flex min-w-0 flex-col";

/** A single truncated mono line under a name. */
export const SUB_LINE = "truncate font-mono text-[12px] text-dim-foreground";

/** An outlined panel with the full hard shadow. */
export const PANEL =
  "rounded-base border-2 border-border bg-background px-4 py-[14px] shadow-shadow";

/** A grid of panels that wraps at 280px. */
export const GRID_CARDS = "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3";

/** A selectable row button in a list; `aria-pressed` marks the selected one. */
export const ITEM =
  "flex w-full cursor-pointer gap-3 rounded-base border-2 border-border bg-background px-[14px] py-3 text-left [font:inherit] text-soft-foreground hover:bg-hover aria-pressed:bg-selected aria-pressed:text-foreground aria-pressed:shadow-sm-hard";

/** A plain data table: thin rules between rows, an ink rule under the mono header. */
export const TABLE =
  "w-full border-collapse [:where(&)_td]:border-b [:where(&)_td]:border-b-[color:var(--line)] [:where(&)_td]:px-3 [:where(&)_td]:py-[9px] [:where(&)_td]:text-left [:where(&)_td]:whitespace-nowrap [:where(&)_th]:border-b-2 [:where(&)_th]:border-b-border [:where(&)_th]:px-3 [:where(&)_th]:py-[9px] [:where(&)_th]:text-left [:where(&)_th]:whitespace-nowrap [:where(&)_th]:font-mono [:where(&)_th]:text-[11px] [:where(&)_th]:font-bold [:where(&)_th]:uppercase [:where(&)_th]:tracking-[0.08em] [:where(&)_th]:text-muted-foreground";

/** A labelled control row: the first child takes the free width. */
export const FIELD =
  "flex min-h-10 flex-wrap items-center gap-[14px] [:where(&)>:first-child]:min-w-[200px] [:where(&)>:first-child]:flex-1";

/** A checkbox with its label. */
export const CHECK = "flex min-h-9 items-center gap-2.5";

/** A small status dot; add one of DOT_TONE for its colour. */
export const DOT = "size-2 flex-none rounded-full bg-[var(--text-4)]";

export const DOT_TONE = {
  ok: "bg-[var(--ok)]",
  warn: "bg-[var(--warn)]",
  err: "bg-[var(--err)]",
  busy: "bg-[var(--info)]",
} as const;
