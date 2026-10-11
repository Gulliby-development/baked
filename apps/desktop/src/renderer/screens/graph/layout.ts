import type { GraphEdge, GraphFrame, GraphUnit, GraphView } from "../../client/graph.js";

/**
 * Pure layout helpers of the Graph section; the d3 drawing is in engine.ts.
 *
 * The layout is hierarchical: each open folder places its children once on a centred grid
 * (biggest blocks nearest the middle, then nudged by their links) and moves as one rigid box in
 * the live top-level simulation, so open folders stay compact.
 */

export interface Box {
  id: string;
  w: number;
  h: number;
  x: number;
  y: number;
  fx?: number | null | undefined;
  fy?: number | null | undefined;
}

/** Pushes overlapping rectangles apart along the axis of least overlap; a d3 force. */
export function rectCollide<T extends Box>(pad: number) {
  let nodes: T[] = [];
  const force = (): void => {
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i] as T;
        const b = nodes[j] as T;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + pad - Math.abs(dx);
        const oy = (a.h + b.h) / 2 + pad - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const fa = a.fx != null ? 0 : 1;
        const fb = b.fx != null ? 0 : 1;
        const total = fa + fb || 1;
        if (ox < oy) {
          const s = (ox * (dx < 0 ? -1 : 1)) / total;
          a.x -= s * fa;
          b.x += s * fb;
        } else {
          const s = (oy * (dy < 0 ? -1 : 1)) / total;
          a.y -= s * fa;
          b.y += s * fb;
        }
      }
  };
  force.initialize = (n: T[]): void => {
    nodes = n;
  };
  return force;
}

/** Grid cells around the origin for `count` blocks of at most `cw` x `ch`, nearest first. */
export function gridHomes(count: number, cw: number, ch: number): [number, number][] {
  const cols = Math.max(1, Math.round(Math.sqrt(((count * 1.1 * ch) / cw) * 1.6)));
  const rows = Math.ceil(count / cols);
  const cells: [number, number][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      cells.push([(c - (cols - 1) / 2) * cw, (r - (rows - 1) / 2) * ch]);
  cells.sort((a, b) => Math.hypot(a[0] / 1.5, a[1]) - Math.hypot(b[0] / 1.5, b[1]));
  return cells.slice(0, count);
}

/** Positions of a pile's small files: a grid, biggest first. */
export function chipGrid(count: number, cell = 24): [number, number][] {
  const cols = Math.max(4, Math.ceil(Math.sqrt(count * 1.6)));
  return Array.from({ length: count }, (_, i) => [(i % cols) * cell, Math.floor(i / cols) * cell]);
}

/** Where a line from a rectangle's centre in direction (dx, dy) leaves it, as a distance. */
export function exitDistance(w: number, h: number, dx: number, dy: number, pad = 4): number {
  const hw = w / 2 + pad;
  const hh = h / 2 + pad;
  return Math.min(
    Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY,
    Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY,
  );
}

export function isPile(kind: GraphUnit["kind"]): boolean {
  return kind === "pile" || kind === "dirpile";
}

export function frameOf(view: GraphView, id: string): GraphFrame | undefined {
  return view.frames.find((f) => f.id === id);
}

/** The frame a unit or frame sits in. */
export function ownerOf(view: GraphView, id: string): string | null {
  const unit = view.units.find((u) => u.id === id);
  if (unit) return unit.owner;
  return frameOf(view, id)?.owner ?? null;
}

/** Whether `id` sits inside the frame `ancestor` (at any depth); everything is inside null. */
export function isInside(view: GraphView, id: string, ancestor: string | null): boolean {
  if (!ancestor) return true;
  for (let o = ownerOf(view, id); o; o = frameOf(view, o)?.owner ?? null)
    if (o === ancestor) return true;
  return false;
}

/** A unit drawn as a small square: a file inside an open pile. */
export function isChip(view: GraphView, unit: GraphUnit): boolean {
  if (unit.kind !== "file" || !unit.owner) return false;
  return frameOf(view, unit.owner)?.kind === "pile";
}

/** Block size in canvas pixels. */
export function unitSize(view: GraphView, unit: GraphUnit): [number, number] {
  if (unit.kind === "dir") {
    const s = Math.sqrt(unit.lines);
    return [Math.round(Math.min(300, Math.max(140, 96 + s * 0.6))), 86];
  }
  if (isPile(unit.kind)) return [156, 52];
  if (isChip(view, unit)) return [18, 18];
  return [Math.round(Math.min(210, Math.max(104, 76 + Math.sqrt(unit.lines) * 1.5))), 34];
}

/**
 * The edges worth drawing: each block keeps its two strongest links in and out (three inside the
 * open folder), plus every link of the selected block and the selected link itself.
 */
export function visibleEdges(
  view: GraphView,
  focus: string | null,
  selectedUnit: string | null,
  selectedEdge: string | null,
): GraphEdge[] {
  const keep = new Set<string>();
  const out = new Map<string, number>();
  const into = new Map<string, number>();
  const sorted = view.edges.slice().sort((a, b) => b.pairs - a.pairs || b.weight - a.weight);
  for (const e of sorted) {
    const o = out.get(e.from) ?? 0;
    const i = into.get(e.to) ?? 0;
    const inFocus = focus !== null && isInside(view, e.from, focus) && isInside(view, e.to, focus);
    const limit = inFocus ? 3 : 2;
    if (o < limit || i < limit) {
      keep.add(e.id);
      out.set(e.from, o + 1);
      into.set(e.to, i + 1);
    }
  }
  return view.edges.filter(
    (e) =>
      keep.has(e.id) || e.from === selectedUnit || e.to === selectedUnit || e.id === selectedEdge,
  );
}

/** Text cut to fit `px` at about `charWidth` pixels per character. */
export function clipText(text: string, px: number, charWidth: number): string {
  const n = Math.floor(px / charWidth);
  return text.length > n ? `${text.slice(0, Math.max(1, n - 1))}…` : text;
}

/** Squares of a folder's waffle: one per file, or one per `per` files when it is big. */
export function waffle(
  files: number,
  keys: number,
  width: number,
): { count: number; keyed: number; per: number; cols: number } {
  const cols = Math.floor((width - 20) / 9);
  const per = Math.max(1, Math.ceil(files / (cols * 3)));
  const count = Math.ceil(files / per);
  return { count, keyed: Math.min(count, Math.ceil(keys / per)), per, cols };
}

export const TONE_FILL = [
  "var(--fill-accent)",
  "var(--fill-warn)",
  "var(--fill-ok)",
  "var(--fill-info)",
] as const;

export function toneFill(tone: number): string {
  return TONE_FILL[tone] ?? "var(--bg-raised)";
}

export function unitFill(view: GraphView, unit: GraphUnit): string {
  if (isChip(view, unit)) return unit.lines >= 120 ? toneFill(unit.tone) : "var(--bg-raised)";
  if (unit.kind === "file")
    return unit.key ? "var(--fill-accent)" : unit.test ? "var(--fill-info)" : "var(--bg-raised)";
  if (isPile(unit.kind)) return "var(--bg-raised)";
  return toneFill(unit.tone);
}

/** The shortest readable name of a path for lists. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return n.toLocaleString("en-US");
}
