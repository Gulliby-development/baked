import { drag } from "d3-drag";
import { easeBackOut, easeCubicInOut } from "d3-ease";
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { type Selection, select } from "d3-selection";
import { timer } from "d3-timer";
import "d3-transition";
import { type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
import type { GraphEdge, GraphFrame, GraphUnit, GraphView } from "../../client/graph.js";
import {
  type Box,
  chipGrid,
  clipText,
  exitDistance,
  formatCount,
  gridHomes,
  isChip,
  isInside,
  isPile,
  rectCollide,
  unitFill,
  unitSize,
  visibleEdges,
  waffle,
} from "./layout.js";

/**
 * Draws the code graph with d3 into an SVG and keeps it moving: a live force simulation for the
 * top level, open folders as rigid frames laid out once, a grow animation when a folder opens,
 * fading outside the open folder, pan and zoom. React owns the state; the engine only draws it.
 */

export interface EngineCallbacks {
  onUnit(unit: GraphUnit): void;
  onCollapse(frameId: string): void;
  onEdge(edge: GraphEdge): void;
  onBackground(): void;
  onZoom(scale: number): void;
}

export interface EngineState {
  focus: string | null;
  selectedUnit: string | null;
  selectedEdge: string | null;
}

interface UnitBox extends SimulationNodeDatum {
  id: string;
  unit: GraphUnit;
  w: number;
  h: number;
  x: number;
  y: number;
  /** Position inside the owner frame. */
  lx: number;
  ly: number;
  /** Absolute position, refreshed every tick. */
  ax: number;
  ay: number;
  own: string | null;
  drawn?: string;
  frame?: false;
}

interface FrameBox extends SimulationNodeDatum {
  id: string;
  frame: true;
  info: GraphFrame;
  w: number;
  h: number;
  x: number;
  y: number;
  lx: number;
  ly: number;
  own: string | null;
  grow: number;
}

type Item = UnitBox | FrameBox;
type Link = SimulationLinkDatum<Item> & { pairs: number };

const FONT_MONO = '"IBM Plex Mono", ui-monospace, monospace';
const FONT_SANS = '"IBM Plex Sans", system-ui, sans-serif';
const EDGE = "var(--text-3)";
const ACCENT = "var(--accent)";

/** Light lines on a dark canvas read stronger, so faded links fade further there. */
function fadedEdge(): string {
  return document.documentElement.dataset.theme === "dark" ? "0.035" : "0.07";
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export class GraphEngine {
  private readonly svg: Selection<SVGSVGElement, unknown, null, undefined>;
  private readonly viewport: Selection<SVGGElement, unknown, null, undefined>;
  private readonly gFrames: Selection<SVGGElement, unknown, null, undefined>;
  private readonly gEdges: Selection<SVGGElement, unknown, null, undefined>;
  private readonly gUnits: Selection<SVGGElement, unknown, null, undefined>;
  private readonly zoomer: ZoomBehavior<SVGSVGElement, unknown>;
  private view: GraphView | null = null;
  private readonly units = new Map<string, UnitBox>();
  private readonly frames = new Map<string, FrameBox>();
  private readonly mainPos = new Map<string, [number, number]>();
  private mainNodes: Item[] = [];
  private shown: GraphEdge[] = [];
  private sim: Simulation<Item, Link> | null = null;
  private scale = 1;
  private fitAfter: string | null | undefined = undefined;
  private fitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly element: SVGSVGElement,
    private readonly callbacks: EngineCallbacks,
  ) {
    this.svg = select(element);
    this.svg.selectAll("*").remove();
    const defs = this.svg.append("defs");
    for (const [id, color, size] of [
      ["graph-arrow", EDGE, 11],
      ["graph-arrow-hi", ACCENT, 13],
    ] as const)
      defs
        .append("marker")
        .attr("id", id)
        .attr("viewBox", "0 0 10 10")
        .attr("refX", 9)
        .attr("refY", 5)
        .attr("markerUnits", "userSpaceOnUse")
        .attr("markerWidth", size)
        .attr("markerHeight", size)
        .attr("orient", "auto-start-reverse")
        .append("path")
        .attr("d", "M0 0 10 5 0 10z")
        .attr("fill", color);
    this.viewport = this.svg.append("g");
    this.gFrames = this.viewport.append("g");
    this.gEdges = this.viewport.append("g");
    this.gUnits = this.viewport.append("g");
    this.zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.06, 3])
      .on("zoom", (event: { transform: { k: number; toString(): string } }) => {
        this.viewport.attr("transform", event.transform.toString());
        this.scale = event.transform.k;
        this.applyDetail();
        this.callbacks.onZoom(this.scale);
      });
    this.svg.call(this.zoomer).on("dblclick.zoom", null);
    this.svg.on("click", (event: MouseEvent) => {
      if (event.target === element) this.callbacks.onBackground();
    });
  }

  destroy(): void {
    this.sim?.stop();
    clearTimeout(this.fitTimer);
    this.svg.on(".zoom", null).on("click", null);
    this.svg.selectAll("*").remove();
  }

  /** Draws a new level. `fit` zooms to a frame (its id), to everything (null), or keeps the camera. */
  setView(view: GraphView, state: EngineState, fit?: string | null): void {
    this.view = view;
    const keep = new Set(view.units.map((u) => u.id));
    for (const id of [...this.units.keys()]) if (!keep.has(id)) this.units.delete(id);
    for (const u of view.units) {
      const [w, h] = unitSize(view, u);
      const box = this.units.get(u.id) ?? this.newUnitBox(u);
      box.unit = u;
      box.w = w;
      box.h = h;
      box.own = u.owner;
      this.units.set(u.id, box);
    }
    const frameIds = new Set(view.frames.map((f) => f.id));
    for (const id of [...this.frames.keys()]) if (!frameIds.has(id)) this.frames.delete(id);
    const topFrames = view.frames.filter((f) => !f.owner).map((f) => this.layoutFrame(f));
    const topUnits = view.units.filter((u) => !u.owner).map((u) => this.units.get(u.id) as UnitBox);
    this.shown = visibleEdges(view, state.focus, state.selectedUnit, state.selectedEdge);
    this.mainNodes = [...topUnits, ...topFrames];
    for (const n of this.mainNodes) {
      const p = this.mainPos.get(n.id) ?? [
        (Math.random() - 0.5) * 400,
        (Math.random() - 0.5) * 300,
      ];
      n.x = p[0];
      n.y = p[1];
      n.vx = 0;
      n.vy = 0;
    }
    const links: Link[] = [];
    const seen = new Set<string>();
    for (const e of view.edges) {
      const a = this.itemUnder(e.from, null);
      const b = this.itemUnder(e.to, null);
      if (!a || !b || a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: a, target: b, pairs: e.pairs });
    }
    this.sim?.stop();
    this.sim = forceSimulation<Item, Link>(this.mainNodes)
      .force(
        "link",
        forceLink<Item, Link>(links)
          .id((d) => d.id)
          .distance((l) => 60 + ((l.source as Item).w + (l.target as Item).w) / 3)
          .strength((l) => Math.min(0.12, 0.02 * Math.log2(1 + l.pairs))),
      )
      .force(
        "charge",
        forceManyBody<Item>()
          .strength((d) => -Math.min(2600, d.w * 3.4))
          .distanceMax(900),
      )
      .force("x", forceX<Item>(0).strength(0.045))
      .force("y", forceY<Item>(0).strength(0.07))
      .force("collide", rectCollide<Item>(26))
      .alphaDecay(0.04)
      .on("tick", () => this.tick())
      .on("end", () => {
        if (this.fitAfter !== undefined) {
          const target = this.fitAfter;
          this.fitAfter = undefined;
          this.fit(target);
        }
      });
    this.draw();
    this.grow();
    this.paint(state);
    if (fit !== undefined) {
      this.fitAfter = fit;
      clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => this.fit(fit), 700);
    }
  }

  /** Repaints selection and fading without moving anything. */
  paint(state: EngineState): void {
    const view = this.view;
    if (!view) return;
    const next = visibleEdges(view, state.focus, state.selectedUnit, state.selectedEdge);
    if (next.map((e) => e.id).join() !== this.shown.map((e) => e.id).join()) {
      this.shown = next;
      this.drawEdges();
      this.tick();
    }
    const { focus } = state;
    const selectedUnit =
      state.selectedUnit && !view.frames.some((f) => f.id === state.selectedUnit)
        ? state.selectedUnit
        : null;
    const selectedEdge = state.selectedEdge;
    const fade = (on: boolean): string => (on ? "0.22" : "1");
    this.gUnits
      .selectAll<SVGGElement, UnitBox>("g.unit")
      .style("opacity", (d) => fade(focus !== null && !isInside(view, d.id, focus)))
      .each(function (d) {
        const selected = d.id === selectedUnit;
        select(this)
          .select("rect.body")
          .attr("stroke-width", selected ? 3.5 : 2);
        select(this)
          .select("rect.shadow")
          .attr("transform", selected ? "translate(2,2)" : null);
      });
    this.gFrames
      .selectAll<SVGGElement, FrameBox>("g.frame")
      .style("opacity", (d) =>
        fade(
          focus !== null &&
            d.id !== focus &&
            !isInside(view, d.id, focus) &&
            !isInside(view, focus, d.id),
        ),
      );
    const touches = (e: GraphEdge): boolean =>
      selectedUnit !== null && (e.from === selectedUnit || e.to === selectedUnit);
    this.gEdges
      .selectAll<SVGGElement, GraphEdge>("g.edge")
      .style("opacity", (e) => {
        if (selectedEdge) return e.id === selectedEdge ? "1" : "0.12";
        if (selectedUnit && !touches(e)) return "0.12";
        if (focus) {
          const a = isInside(view, e.from, focus);
          const b = isInside(view, e.to, focus);
          if (!a && !b) return fadedEdge();
          if (a !== b) return "0.3";
        }
        return "1";
      })
      .each(function (e) {
        const hi = e.id === selectedEdge || touches(e);
        select(this)
          .select("path.line")
          .attr("stroke", hi ? ACCENT : EDGE)
          .attr(
            "stroke-width",
            e.id === selectedEdge ? 5 : 1.2 + Math.min(3.2, Math.log2(1 + e.pairs) * 0.7),
          )
          .attr("marker-end", hi ? "url(#graph-arrow-hi)" : "url(#graph-arrow)");
        if (hi) select(this).raise();
      });
  }

  zoomBy(factor: number): void {
    this.svg.transition().duration(250).call(this.zoomer.scaleBy, factor);
  }

  /** Zooms to a frame, or to everything when `id` is null. */
  fit(id: string | null): void {
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    if (!width || !height) return;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    const add = (x: number, y: number, w: number, h: number): void => {
      x0 = Math.min(x0, x - w / 2);
      y0 = Math.min(y0, y - h / 2);
      x1 = Math.max(x1, x + w / 2);
      y1 = Math.max(y1, y + h / 2);
    };
    const frame = id ? this.frames.get(id) : undefined;
    if (frame) {
      const [x, y] = this.absolute(frame);
      add(x, y - 6, frame.w, frame.h + 12);
    } else for (const b of this.units.values()) add(b.ax, b.ay, b.w, b.h);
    if (!Number.isFinite(x0)) return;
    const pad = 60;
    const k = Math.min(
      1.25,
      Math.max(0.06, Math.min(width / (x1 - x0 + pad * 2), height / (y1 - y0 + pad * 2))),
    );
    const target = zoomIdentity
      .translate(width / 2, height / 2)
      .scale(k)
      .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    this.svg
      .transition()
      .duration(reducedMotion() ? 0 : 650)
      .ease(easeCubicInOut)
      .call(this.zoomer.transform, target);
  }

  private newUnitBox(u: GraphUnit): UnitBox {
    return { id: u.id, unit: u, w: 0, h: 0, x: 0, y: 0, lx: 0, ly: 0, ax: 0, ay: 0, own: u.owner };
  }

  /** The child of `owner` (a unit or frame id) that holds `id`. */
  private itemUnder(id: string, owner: string | null): string | null {
    const view = this.view as GraphView;
    const ownerOf = (x: string): string | null =>
      view.units.find((u) => u.id === x)?.owner ??
      view.frames.find((f) => f.id === x)?.owner ??
      null;
    let x = id;
    for (let o = ownerOf(x); o !== owner; o = ownerOf(x)) {
      if (!o) return null;
      x = o;
    }
    return x;
  }

  private layoutFrame(info: GraphFrame): FrameBox {
    const view = this.view as GraphView;
    const id = info.id;
    const kids: Item[] = [];
    for (const u of view.units) if (u.owner === id) kids.push(this.units.get(u.id) as UnitBox);
    for (const f of view.frames) if (f.owner === id) kids.push(this.layoutFrame(f));
    const old = this.frames.get(id);
    const asUnit = this.units.get(id);
    const box: FrameBox = {
      id,
      frame: true,
      info,
      w: 0,
      h: 0,
      x: old?.x ?? 0,
      y: old?.y ?? 0,
      lx: old?.lx ?? asUnit?.lx ?? 0,
      ly: old?.ly ?? asUnit?.ly ?? 0,
      own: info.owner,
      grow: old ? old.grow : 0,
    };
    const chipsOnly = kids.length > 0 && kids.every((k) => !k.frame && k.w < 30);
    if (chipsOnly) {
      const sorted = (kids as UnitBox[]).slice().sort((a, b) => b.unit.lines - a.unit.lines);
      chipGrid(sorted.length).forEach(([x, y], i) => {
        const k = sorted[i] as UnitBox;
        k.lx = x;
        k.ly = y;
      });
    } else if (kids.length) {
      const ids = new Set(kids.map((k) => k.id));
      const links: { source: string; target: string }[] = [];
      const seen = new Set<string>();
      for (const e of view.edges) {
        const a = this.itemUnder(e.from, id);
        const b = this.itemUnder(e.to, id);
        if (!a || !b || a === b || !ids.has(a) || !ids.has(b)) continue;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ source: a, target: b });
      }
      const fresh = kids.some((k) => k.lx === 0 && k.ly === 0);
      const cw = Math.max(...kids.map((k) => k.w)) + 22;
      const ch = Math.max(...kids.map((k) => k.h)) + 26;
      const homes = gridHomes(kids.length, cw, ch);
      const order = kids
        .slice()
        .sort(
          (a, b) => (b.frame ? b.w * b.h : b.unit.lines) - (a.frame ? a.w * a.h : a.unit.lines),
        );
      const home = new Map(
        order.map((k, i): [string, [number, number]] => [k.id, homes[i] ?? [0, 0]]),
      );
      type LocalNode = Box & SimulationNodeDatum & { item: Item; hx: number; hy: number };
      const nodes: LocalNode[] = kids.map((k) => {
        const [hx, hy] = home.get(k.id) ?? [0, 0];
        return {
          id: k.id,
          item: k,
          w: k.w,
          h: k.h,
          hx,
          hy,
          x: fresh ? hx : k.lx,
          y: fresh ? hy : k.ly,
        };
      });
      forceSimulation<LocalNode>(nodes)
        .stop()
        .force(
          "link",
          forceLink<LocalNode, SimulationLinkDatum<LocalNode>>(links)
            .id((d) => d.id)
            .distance((l) => 30 + ((l.source as LocalNode).w + (l.target as LocalNode).w) / 2.4)
            .strength(0.03),
        )
        .force("x", forceX<LocalNode>((d) => d.hx).strength(0.18))
        .force("y", forceY<LocalNode>((d) => d.hy).strength(0.18))
        .force("collide", rectCollide<LocalNode>(14))
        .tick(160);
      for (const n of nodes) {
        n.item.lx = n.x;
        n.item.ly = n.y;
      }
    }
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const k of kids) {
      x0 = Math.min(x0, k.lx - k.w / 2);
      y0 = Math.min(y0, k.ly - k.h / 2);
      x1 = Math.max(x1, k.lx + k.w / 2 + 4);
      y1 = Math.max(y1, k.ly + k.h / 2 + 4);
    }
    if (!kids.length) {
      x0 = -40;
      y0 = -40;
      x1 = 40;
      y1 = 40;
    }
    const pad = 24;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    for (const k of kids) {
      k.lx -= cx;
      k.ly -= cy - 10;
    }
    box.w = Math.max(x1 - x0 + pad * 2, 180);
    box.h = y1 - y0 + pad * 2 + 20;
    this.frames.set(id, box);
    return box;
  }

  private absolute(b: Item): [number, number] {
    if (!b.own) return [b.x, b.y];
    const parent = this.frames.get(b.own);
    if (!parent) return [0, 0];
    const [px, py] = this.absolute(parent);
    return [px + b.lx * parent.grow, py + b.ly * parent.grow];
  }

  /** Children of newly opened folders spill out of the folder's place. */
  private grow(): void {
    const growing = [...this.frames.values()].filter((f) => f.grow < 1);
    if (!growing.length) return;
    const start = performance.now();
    const reduce = reducedMotion();
    const ease = easeBackOut.overshoot(1.1);
    const t = timer(() => {
      const p = reduce ? 1 : Math.min(1, (performance.now() - start) / 520);
      for (const f of growing) f.grow = ease(p);
      this.tick();
      if (p >= 1) {
        for (const f of growing) f.grow = 1;
        t.stop();
        this.tick();
      }
    });
  }

  private applyDetail(): void {
    const far = this.scale < 0.5;
    this.gUnits.selectAll(".detail").style("display", far ? "none" : "");
  }

  private draw(): void {
    const view = this.view as GraphView;
    const callbacks = this.callbacks;
    const units = this.gUnits
      .selectAll<SVGGElement, UnitBox>("g.unit")
      .data([...this.units.values()], (d) => d.id);
    units.exit().remove();
    const entered = units
      .enter()
      .append("g")
      .attr("class", "unit")
      .attr("tabindex", 0)
      .attr("role", "button")
      .style("cursor", "pointer")
      .style("transition", reducedMotion() ? "none" : "opacity .35s ease")
      .on("click", (event: MouseEvent, d) => {
        if (event.defaultPrevented) return;
        event.stopPropagation();
        callbacks.onUnit(d.unit);
      })
      .on("keydown", (event: KeyboardEvent, d) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        callbacks.onUnit(d.unit);
      });
    const all = entered.merge(units);
    all.call(this.dragger<SVGGElement, UnitBox>());
    all.each(function (d) {
      const signature = `${d.w}|${d.unit.label}|${d.unit.kind}|${unitFill(view, d.unit)}|${d.unit.files}`;
      if (d.drawn === signature) return;
      d.drawn = signature;
      const g = select<SVGGElement, UnitBox>(this);
      g.selectAll("*").remove();
      g.attr(
        "aria-label",
        `${d.unit.label}, ${d.unit.kind === "file" ? `${d.unit.lines} lines` : `${d.unit.files} files`}`,
      );
      drawUnit(g, d, view);
    });
    this.drawEdges();
    const frames = [...this.frames.values()].sort((a, b) => a.info.depth - b.info.depth);
    const fs = this.gFrames.selectAll<SVGGElement, FrameBox>("g.frame").data(frames, (d) => d.id);
    fs.exit().remove();
    const fe = fs
      .enter()
      .append("g")
      .attr("class", "frame")
      .style("transition", reducedMotion() ? "none" : "opacity .35s ease");
    fe.append("rect")
      .attr("class", "back")
      .attr("rx", 10)
      .attr("fill", "var(--bg-sunken)")
      .attr("fill-opacity", 0.72)
      .attr("stroke", "var(--ink)")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "8 5");
    fe.append("rect")
      .attr("class", "tab")
      .attr("rx", 4)
      .attr("height", 24)
      .attr("fill", "var(--fill-accent)")
      .attr("stroke", "var(--ink)")
      .attr("stroke-width", 2)
      .style("cursor", "pointer")
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        callbacks.onCollapse(d.id);
      });
    fe.append("text")
      .attr("font-family", FONT_MONO)
      .attr("font-size", 12)
      .attr("font-weight", 600)
      .attr("fill", "var(--on-fill)")
      .style("pointer-events", "none");
    fe.select<SVGRectElement>("rect.back").call(this.dragger<SVGRectElement, FrameBox>());
    const allFrames = fe.merge(fs);
    allFrames.sort((a, b) => a.info.depth - b.info.depth);
    allFrames.each(function (d) {
      const g = select(this);
      const text = g.select<SVGTextElement>("text").text(`▾ ${d.info.label}  ✕`);
      const width = text.node()?.getComputedTextLength() ?? d.info.label.length * 7.5;
      g.select("rect.tab").attr("width", width + 20);
      g.select("rect.tab").attr("aria-label", `Close ${d.info.label}`);
    });
  }

  private drawEdges(): void {
    const callbacks = this.callbacks;
    const edges = this.gEdges
      .selectAll<SVGGElement, GraphEdge>("g.edge")
      .data(this.shown, (d) => d.id);
    edges.exit().remove();
    const entered = edges
      .enter()
      .append("g")
      .attr("class", "edge")
      .style("transition", reducedMotion() ? "none" : "opacity .35s ease");
    entered
      .append("path")
      .attr("class", "line")
      .attr("fill", "none")
      .attr("stroke-linecap", "round");
    entered
      .append("path")
      .attr("class", "hit")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 14)
      .style("cursor", "pointer")
      .on("click", (event: MouseEvent, d) => {
        event.stopPropagation();
        callbacks.onEdge(d);
      });
    entered
      .merge(edges)
      .select("path.line")
      .attr("stroke-dasharray", (d) => (d.typeOnly === d.pairs ? "5 5" : null))
      .attr("stroke", EDGE)
      .attr("stroke-width", (d) => 1.2 + Math.min(3.2, Math.log2(1 + d.pairs) * 0.7))
      .attr("marker-end", "url(#graph-arrow)");
  }

  private dragger<E extends SVGGElement | SVGRectElement, D extends Item>() {
    return drag<E, D>()
      .clickDistance(4)
      .subject((_event, d) => {
        // A frame's back rectangle drags the frame.
        return d;
      })
      .on("start", (event: { active: number }, d) => {
        const item = this.itemFor(d);
        if (item.own) return;
        if (!event.active) this.sim?.alphaTarget(0.25).restart();
        item.fx = item.x;
        item.fy = item.y;
      })
      .on("drag", (event: { x: number; y: number; dx: number; dy: number }, d) => {
        const item = this.itemFor(d);
        if (!item.own) {
          item.fx = event.x;
          item.fy = event.y;
        } else {
          item.lx += event.dx / (this.frames.get(item.own)?.grow || 1);
          item.ly += event.dy / (this.frames.get(item.own)?.grow || 1);
          this.tick();
        }
      })
      .on("end", (event: { active: number }, d) => {
        const item = this.itemFor(d);
        if (item.own) return;
        if (!event.active) this.sim?.alphaTarget(0);
        this.mainPos.set(item.id, [item.fx ?? item.x, item.fy ?? item.y]);
        item.fx = null;
        item.fy = null;
      });
  }

  /** Frames are recreated on every layout; resolve a dragged datum to the current box. */
  private itemFor(d: Item): Item {
    return (d.frame ? this.frames.get(d.id) : this.units.get(d.id)) ?? d;
  }

  private tick(): void {
    for (const n of this.mainNodes) this.mainPos.set(n.id, [n.x, n.y]);
    for (const b of this.units.values()) {
      const [x, y] = this.absolute(b);
      b.ax = x;
      b.ay = y;
    }
    const frames = this.frames;
    this.gUnits.selectAll<SVGGElement, UnitBox>("g.unit").attr("transform", (d) => {
      const g = d.own ? Math.max(0.01, Math.min(1, frames.get(d.own)?.grow ?? 1)) : 1;
      return `translate(${d.ax},${d.ay})${g < 1 ? ` scale(${g})` : ""}`;
    });
    const self = this;
    this.gFrames.selectAll<SVGGElement, FrameBox>("g.frame").each(function (d) {
      const current = frames.get(d.id) ?? d;
      const [x, y] = self.absolute(current);
      const g = Math.max(0.05, current.grow);
      const w = current.w * g;
      const h = current.h * g;
      const X = x - w / 2;
      const Y = y - h / 2;
      const s = select(this);
      s.select("rect.back").attr("x", X).attr("y", Y).attr("width", w).attr("height", h);
      s.select("rect.tab")
        .attr("x", X + 10)
        .attr("y", Y - 12);
      s.select("text")
        .attr("x", X + 20)
        .attr("y", Y + 5);
    });
    const units = this.units;
    this.gEdges.selectAll<SVGGElement, GraphEdge>("g.edge").each(function (e) {
      const a = units.get(e.from);
      const b = units.get(e.to);
      const paths = select(this).selectAll("path");
      if (!a || !b) return;
      let dx = b.ax - a.ax;
      let dy = b.ay - a.ay;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const off = e.mutual ? 3 : 0;
      const ox = -dy * off;
      const oy = dx * off;
      const ta = exitDistance(a.w, a.h, dx, dy);
      const tb = exitDistance(b.w, b.h, -dx, -dy);
      if (ta + tb >= len) {
        paths.attr("d", null);
        return;
      }
      paths.attr(
        "d",
        `M${a.ax + dx * ta + ox},${a.ay + dy * ta + oy}L${b.ax - dx * tb + ox},${b.ay - dy * tb + oy}`,
      );
    });
  }
}

function drawUnit(
  g: Selection<SVGGElement, UnitBox, null, undefined>,
  d: UnitBox,
  view: GraphView,
): void {
  const u = d.unit;
  const { w, h } = d;
  const fill = unitFill(view, u);
  const ink = fill === "var(--bg-raised)" ? "var(--text)" : "var(--on-fill)";
  if (isChip(view, u)) {
    g.append("rect")
      .attr("class", "shadow")
      .attr("x", -w / 2 + 2)
      .attr("y", -h / 2 + 2)
      .attr("width", w)
      .attr("height", h)
      .attr("rx", 3)
      .attr("fill", "var(--ink)");
    g.append("rect")
      .attr("class", "body")
      .attr("x", -w / 2)
      .attr("y", -h / 2)
      .attr("width", w)
      .attr("height", h)
      .attr("rx", 3)
      .attr("fill", fill)
      .attr("stroke", "var(--ink)")
      .attr("stroke-width", 2);
    g.append("title").text(`${u.path}\n${u.lines} lines`);
    return;
  }
  if (isPile(u.kind)) {
    for (const o of [8, 4])
      g.append("rect")
        .attr("x", -w / 2 + o)
        .attr("y", -h / 2 + o)
        .attr("width", w)
        .attr("height", h)
        .attr("rx", 6)
        .attr("fill", "var(--bg-panel)")
        .attr("stroke", "var(--ink)")
        .attr("stroke-width", 2);
  } else
    g.append("rect")
      .attr("class", "shadow")
      .attr("x", -w / 2 + 4)
      .attr("y", -h / 2 + 4)
      .attr("width", w)
      .attr("height", h)
      .attr("rx", 6)
      .attr("fill", "var(--ink)");
  g.append("rect")
    .attr("class", "body")
    .attr("x", -w / 2)
    .attr("y", -h / 2)
    .attr("width", w)
    .attr("height", h)
    .attr("rx", 6)
    .attr("fill", fill)
    .attr("stroke", "var(--ink)")
    .attr("stroke-width", 2);
  const lx = -w / 2 + 10;
  const text = (cls: string, x: number, y: number, value: string, sans = false, size = 12) =>
    g
      .append("text")
      .attr("class", cls)
      .attr("x", x)
      .attr("y", y)
      .attr("fill", ink)
      .attr("font-family", sans ? FONT_SANS : FONT_MONO)
      .attr("font-size", size)
      .attr("font-weight", sans ? 600 : 400)
      .style("pointer-events", "none")
      .text(value);
  if (u.kind === "dir") {
    text("", lx, -h / 2 + 20, clipText(`▸ ${u.label}`, w - 18, 7.8), true, 13);
    text(
      "detail",
      lx,
      -h / 2 + 37,
      clipText(`${formatCount(u.files)} files · ${formatCount(u.lines)} lines`, w - 18, 6.7),
      false,
      11,
    ).attr("opacity", 0.8);
    const wf = waffle(u.files, u.keys, w);
    const squares = g.append("g").attr("class", "detail");
    for (let i = 0; i < wf.count; i++)
      squares
        .append("rect")
        .attr("x", lx + (i % wf.cols) * 9)
        .attr("y", -h / 2 + 48 + Math.floor(i / wf.cols) * 9)
        .attr("width", 7)
        .attr("height", 7)
        .attr("fill", "var(--on-fill)")
        .attr("opacity", i < wf.keyed ? 0.9 : 0.28);
    g.append("title").text(
      `${u.path}\n${u.files} files${wf.per > 1 ? `; one square = ${wf.per} files` : ""}. Click to open.`,
    );
  } else if (isPile(u.kind)) {
    text("", lx, -h / 2 + 22, u.label, true, 13);
    text(
      "detail",
      lx,
      -h / 2 + 39,
      clipText(`${formatCount(u.files)} files · ${formatCount(u.lines)} lines`, w - 18, 6.7),
      false,
      11,
    ).attr("opacity", 0.8);
    g.append("title").text(`${u.label} in ${u.path || "the project root"}. Click to show them.`);
  } else {
    text("detail", lx, 4, clipText(u.label, w - (u.key ? 34 : 18), 7.3));
    if (u.key) text("", w / 2 - 20, 4, "★").attr("font-weight", 700);
    g.append("title").text(`${u.path}\n${u.lines} lines · ${u.symbols} symbols`);
  }
}
