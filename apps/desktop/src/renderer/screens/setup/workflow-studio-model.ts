import {
  familyOf as coreFamilyOf,
  type Family,
  outcomeVerb,
  type WalkFrame,
  type Walkthrough,
} from "../../../../../../src/core/workflows/v2/walkthrough.js";
import type { DefinitionSummary, LineStage, WorkflowLine } from "../../client/start.js";
import type {
  BindingView,
  EditorView,
  InsertableStage,
  Outcome,
  StageView,
} from "../../client/workflow-editor.js";
import { FINISH, lineOf, type Station } from "../runs/line-model.js";
import { stageLabel } from "../runs/model.js";

/**
 * The Workflows screen as a studio: the gallery of definitions, the walkthrough that plays a run
 * along a definition's line, and the graph editor's geometry. Pure: the screens pass in the
 * definitions and the editor view.
 */

// The walkthrough itself (families, scenarios, events, frames and narration) is the core model the
// terminal's Workflows screen plays too.
export {
  FAMILY_LABEL,
  type Family,
  frameAt,
  narrate,
  SCENARIO_LABEL,
  type Scenario,
  scenariosFor,
  stepAt,
  type WalkEvent,
  type WalkFrame,
  type WalkState,
  type Walkthrough,
  walkthrough,
} from "../../../../../../src/core/workflows/v2/walkthrough.js";

// ---------------------------------------------------------------- gallery

/** What kind of recipe a definition is, from what it writes and the stations on its line. */
export const familyOf = (definition: DefinitionSummary): Family =>
  coreFamilyOf({ line: lineOf(definition.stages, definition.line), writes: definition.writes });

/** Every gate on a line: a station's own and those on its transitions, each counted once. */
export function gateCount(line: WorkflowLine): number {
  const ids = new Set<string>();
  for (const stage of line.stages)
    for (const gate of stage.gates ?? [])
      ids.add(`${stage.id}:${gate.transition?.id ?? ""}:${gate.id}`);
  return ids.size;
}

/** The small facts a gallery card lists. */
export function cardFacts(definition: DefinitionSummary): string[] {
  const line = lineOf(definition.stages, definition.line);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const facts = [plural(line.stages.length, "station", "stations")];
  const gates = gateCount(line);
  if (gates) facts.push(plural(gates, "gate", "gates"));
  if (line.loops.length) facts.push(plural(line.loops.length, "repair loop", "repair loops"));
  facts.push(definition.writes ? "changes files" : "read only");
  if (definition.execution === "worktree") facts.push("worktrees");
  return facts;
}

/** Whether a definition matches the gallery's search text: its ID, description or a stage. */
export function matches(definition: DefinitionSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [definition.id, definition.description, ...definition.stages].some((text) =>
    text.toLowerCase().includes(q),
  );
}

/** The mini line of a card: stations side by side and the repair loops as arcs under them. */
export const MINI_STEP = 28;
export const MINI_SIZE = 22;
export interface MiniLine {
  width: number;
  stations: { id: string; type: LineStage["type"]; produces: string; human: boolean; x: number }[];
  loops: { d: string; title: string }[];
}
export function miniLine(line: WorkflowLine): MiniLine {
  const index = new Map(line.stages.map((s, i) => [s.id, i]));
  const center = (i: number) => i * MINI_STEP + MINI_SIZE / 2;
  return {
    width: Math.max(MINI_SIZE, line.stages.length * MINI_STEP - (MINI_STEP - MINI_SIZE)),
    stations: line.stages.map((s, i) => ({
      id: s.id,
      type: s.type,
      produces: s.produces,
      human: s.human,
      x: i * MINI_STEP,
    })),
    loops: line.loops.flatMap((loop, k) => {
      const from = index.get(loop.from);
      const to = index.get(loop.to);
      if (from === undefined || to === undefined) return [];
      const a = center(from);
      const b = center(to);
      const depth = MINI_SIZE + 8 + k * 5;
      return [
        {
          d: `M ${a} ${MINI_SIZE} C ${a} ${depth}, ${b} ${depth}, ${b} ${MINI_SIZE}`,
          title: `${loop.from} ${outcomeVerb(loop.on)}: back to ${loop.to}`,
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------- walkthrough

/**
 * The walkthrough's frame as conveyor stations, so the gallery and the editor play it on the same
 * conveyor as the run screen: an approval waits for you, gates turn green once their station
 * passed and red where it failed.
 */
export function walkStations(walk: Walkthrough<LineStage>, frame: WalkFrame): Station[] {
  return walk.stations.map((s, i) => {
    const state = frame.states[i] ?? "pending";
    const status = state === "done" ? "passed" : state === "failed" ? "failed" : null;
    return {
      id: s.id,
      label: s.finish ? "Done" : stageLabel(s.id),
      type: s.finish ? "finish" : s.type,
      consumes: s.consumes,
      produces: s.finish ? null : s.produces,
      human: s.human,
      state: state === "current" && s.type === "approval" && s.human ? "waiting" : state,
      round: Math.max(1, frame.rounds[i] ?? 0),
      gates: (s.gates ?? []).map((g) => ({
        ...g,
        last: status ? { status, mode: g.mode, attempts: 1, flaky: false } : null,
      })),
    };
  });
}

// ---------------------------------------------------------------- graph

export const NODE_W = 160;
export const NODE_H = 64;
export const GRID = 20;
const COL = 200;
const ROW = 200;
const MAGNET = 14;

export interface Point {
  x: number;
  y: number;
}
export type Layout = Record<string, Point>;

/** Stations in rows of at most four, left to right, the finish station last. */
export function defaultLayout(stageIds: readonly string[]): Layout {
  const ids = [...stageIds, FINISH];
  const perRow = Math.min(4, ids.length);
  const layout: Layout = {};
  ids.forEach((id, i) => {
    layout[id] = { x: 40 + (i % perRow) * COL, y: 60 + Math.floor(i / perRow) * ROW };
  });
  return layout;
}

/** A saved layout with every station placed: unknown IDs dropped, new stations from the default. */
export function mergeLayout(stageIds: readonly string[], saved: Layout | null): Layout {
  const base = defaultLayout(stageIds);
  if (!saved) return base;
  const out: Layout = {};
  for (const id of [...stageIds, FINISH]) {
    const p = saved[id];
    out[id] =
      p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : (base[id] as Point);
  }
  return out;
}

/** The board size that holds every station with a margin for the loops under them. */
export function boardSize(layout: Layout): { width: number; height: number } {
  const points = Object.values(layout);
  return {
    width: Math.max(720, ...points.map((p) => p.x + NODE_W + 60)),
    height: Math.max(520, ...points.map((p) => p.y + NODE_H + 160)),
  };
}

/**
 * Where a dragged station lands: it pulls into line with another station within a few pixels
 * (with a guide through both centres), else stays where the pointer put it.
 */
export function magnet(
  id: string,
  at: Point,
  layout: Layout,
): { point: Point; guideX: number | null; guideY: number | null } {
  let { x, y } = at;
  let guideX: number | null = null;
  let guideY: number | null = null;
  for (const [other, p] of Object.entries(layout)) {
    if (other === id) continue;
    if (guideY === null && Math.abs(p.y - y) < MAGNET) {
      y = p.y;
      guideY = p.y + NODE_H / 2;
    }
    if (guideX === null && Math.abs(p.x - x) < MAGNET) {
      x = p.x;
      guideX = p.x + NODE_W / 2;
    }
  }
  return { point: { x: Math.max(0, x), y: Math.max(0, y) }, guideX, guideY };
}

/** The grid point nearest to a dropped station. */
export const snap = (p: Point): Point => ({
  x: Math.max(0, Math.round(p.x / GRID) * GRID),
  y: Math.max(0, Math.round(p.y / GRID) * GRID),
});

/** The station under a point, the topmost first. */
export function nodeAt(layout: Layout, p: Point, order: readonly string[]): string | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i] as string;
    const n = layout[id];
    if (n && p.x >= n.x && p.x <= n.x + NODE_W && p.y >= n.y && p.y <= n.y + NODE_H) return id;
  }
  return null;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  on: Outcome;
  loop: number | null;
  /** It goes back to the same or an earlier station. */
  back: boolean;
  bindings: BindingView[];
  d: string;
  mid: Point;
}

/** A transition's curve: forward to the right, down to a later row, or a loop under the line. */
export function edgePath(
  a: Point,
  b: Point,
  back: boolean,
  lane: number,
): { d: string; mid: Point } {
  let s: Point;
  let t: Point;
  let c1: Point;
  let c2: Point;
  if (back) {
    s = { x: a.x + NODE_W / 2 + 14, y: a.y + NODE_H };
    t = { x: b.x + NODE_W / 2 - 14, y: b.y + NODE_H + 2 };
    const low = Math.max(a.y, b.y) + NODE_H + 46 + lane * 26;
    c1 = { x: s.x, y: low };
    c2 = { x: t.x, y: low };
  } else if (b.x >= a.x + NODE_W - 4) {
    s = { x: a.x + NODE_W, y: a.y + NODE_H / 2 };
    t = { x: b.x - 2, y: b.y + NODE_H / 2 };
    const dx = Math.max(30, (t.x - s.x) / 2);
    c1 = { x: s.x + dx, y: s.y };
    c2 = { x: t.x - dx, y: t.y };
  } else if (b.y >= a.y) {
    s = { x: a.x + NODE_W / 2, y: a.y + NODE_H };
    t = { x: b.x + NODE_W / 2, y: b.y - 2 };
    const dy = Math.max(40, (t.y - s.y) / 2);
    c1 = { x: s.x, y: s.y + dy };
    c2 = { x: t.x, y: t.y - dy };
  } else {
    s = { x: a.x + NODE_W / 2, y: a.y };
    t = { x: b.x + NODE_W / 2, y: b.y + NODE_H + 2 };
    const dy = Math.max(40, (s.y - t.y) / 2);
    c1 = { x: s.x, y: s.y - dy };
    c2 = { x: t.x, y: t.y + dy };
  }
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    d: `M ${r(s.x)} ${r(s.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(t.x)} ${r(t.y)}`,
    mid: {
      x: r((s.x + 3 * c1.x + 3 * c2.x + t.x) / 8),
      y: r((s.y + 3 * c1.y + 3 * c2.y + t.y) / 8),
    },
  };
}

/** The transitions of an editor view as curves between the stations of a layout. */
export function graphEdges(view: EditorView, layout: Layout): GraphEdge[] {
  const order = new Map([
    ...view.stages.map((s, i) => [s.id, i] as const),
    [FINISH, view.stages.length],
  ]);
  let lane = 0;
  return view.stages.flatMap((stage) =>
    stage.targets.flatMap((target) => {
      const t = target.target;
      const transition = target.transition;
      if (t.kind !== "transition" || !transition) return [];
      const a = layout[stage.id];
      const b = layout[transition.to];
      if (!a || !b) return [];
      const back =
        (order.get(transition.to) ?? Number.POSITIVE_INFINITY) <= (order.get(stage.id) ?? -1);
      const { d, mid } = edgePath(a, b, back, back ? lane++ : 0);
      return [
        {
          id: t.id,
          from: stage.id,
          to: transition.to,
          on: transition.on,
          loop: transition.loop,
          back,
          bindings: target.bindings,
          d,
          mid,
        },
      ];
    }),
  );
}

/** The edge whose middle is nearest a point, within reach of a drop. */
export function edgeNear(edges: readonly GraphEdge[], p: Point, reach = 40): GraphEdge | null {
  let best: GraphEdge | null = null;
  let dist = reach;
  for (const e of edges) {
    const d = Math.hypot(e.mid.x - p.x, e.mid.y - p.y);
    if (d < dist) {
      dist = d;
      best = e;
    }
  }
  return best;
}

/** "passes", "fails", "asks for changes": how a sentence about a transition reads. */
export const OUTCOME_WHEN: Record<Outcome, string> = {
  passed: "passes",
  failed: "fails",
  changes_requested: "asks for changes",
};

/** A choice of outcome in the new-arrow dialog, with why it is taken when it is. */
export interface ArrowOutcome {
  on: Outcome;
  taken: string | null;
}
export interface ArrowDraft {
  /** The arrow goes back along the line (or to the same station), so it is a loop with rounds. */
  back: boolean;
  outcomes: ArrowOutcome[];
  /** The outcome picked first: the free one that fits the direction, else any free one. */
  on: Outcome | null;
  /** The rounds a new loop starts with. */
  rounds: number;
}

/**
 * What the new-arrow dialog offers for an arrow from `stage` to `to`, or why there can be none.
 * Forward arrows usually carry `passed` and arrows back a failure, but any free outcome is allowed.
 */
export function arrowDraft(
  stage: StageView,
  to: string,
  view: EditorView,
): { ok: true; draft: ArrowDraft } | { ok: false; reason: string } {
  if (to === stage.id) return { ok: false, reason: "An arrow goes to another station." };
  if (!stage.transitionChoices.to.includes(to))
    return { ok: false, reason: `${stage.id} cannot lead to ${to}.` };
  const order = new Map(view.stages.map((s, i) => [s.id, i]));
  const back = to !== FINISH && (order.get(to) ?? 0) <= (order.get(stage.id) ?? 0);
  const used = new Map(
    stage.targets.flatMap((t) =>
      t.transition ? [[t.transition.on, t.transition.to] as const] : [],
    ),
  );
  const outcomes = stage.transitionChoices.on.map((on) => {
    const target = used.get(on);
    return {
      on,
      taken: target === undefined ? null : `already goes to ${target === FINISH ? "done" : target}`,
    };
  });
  const free = outcomes.filter((o) => o.taken === null).map((o) => o.on);
  const fits = free.find((on) => (back ? on !== "passed" : on === "passed"));
  return {
    ok: true,
    draft: { back, outcomes, on: fits ?? free[0] ?? null, rounds: 3 },
  };
}

/** The gates the library offers: every gate some target of the view can bind, with its summary. */
export function gateLibrary(view: EditorView): { id: string; summary: string }[] {
  const seen = new Map<string, string>();
  for (const stage of view.stages)
    for (const target of stage.targets)
      for (const option of target.options)
        if (!seen.has(option.gateId)) seen.set(option.gateId, option.summary);
  return [...seen]
    .map(([id, summary]) => ({ id, summary }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The line of the definition in the editor, so the walkthrough plays the working copy: stages,
 * gates and loops come from the view, the contracts each stage takes and whether a person acts
 * there from the definition's line when the backend sent one.
 */
export function lineFromView(view: EditorView, known?: WorkflowLine): WorkflowLine {
  const byId = new Map((known?.stages ?? []).map((s) => [s.id, s]));
  const order = new Map(view.stages.map((s, i) => [s.id, i]));
  const stages: LineStage[] = view.stages.map((stage) => {
    const entry = byId.get(stage.id);
    return {
      id: stage.id,
      type: stage.type,
      consumes: entry?.consumes ?? [],
      produces: stage.produces,
      human: entry?.human ?? stage.type === "approval",
      gates: stage.targets.flatMap((t) =>
        t.bindings.map((b) => {
          const gate = entry?.gates?.find((g) => g.id === b.gateId);
          return {
            id: b.gateId,
            type: gate?.type ?? null,
            mode: b.mode === "advisory" ? ("advisory" as const) : ("required" as const),
            does: b.summary ?? gate?.does ?? b.gateId,
            transition:
              t.target.kind === "transition" && t.transition
                ? { id: t.target.id, to: t.transition.to, on: t.transition.on }
                : null,
          };
        }),
      ),
    };
  });
  const loops = view.stages.flatMap((stage) =>
    stage.targets.flatMap((t) => {
      const tr = t.transition;
      if (!tr || (order.get(tr.to) ?? Number.POSITIVE_INFINITY) > (order.get(stage.id) ?? -1))
        return [];
      const carried = known?.loops.find((l) => l.from === stage.id && l.on === tr.on)?.carries;
      return [{ from: stage.id, to: tr.to, on: tr.on, carries: carried ?? stage.produces }];
    }),
  );
  return { stages, loops };
}

/** The stations a custom workflow can add, in words, in the order the palette shows them. */
export const NEW_STATIONS: { type: InsertableStage; name: string; what: string }[] = [
  { type: "check", name: "Check", what: "runs gates on the work, no model calls" },
  { type: "review", name: "Review", what: "a model reviews the work and may ask for changes" },
  { type: "approval", name: "Approval", what: "waits for you to approve before it goes on" },
  { type: "wait", name: "Wait", what: "polls command gates until they pass or time out" },
];
const NEW_ID: Record<InsertableStage, string> = {
  check: "check",
  review: "review",
  approval: "approve",
  wait: "wait",
};

/** The id the editor gives a new station of `type`, as core `insertStage` picks it. */
export function newStationId(view: EditorView, type: InsertableStage): string {
  const taken = new Set(view.stages.map((s) => s.id));
  for (const s of view.stages)
    for (const t of s.targets) if (t.target.kind === "transition") taken.add(t.target.id);
  const base = NEW_ID[type];
  let id = base;
  for (let n = 2; taken.has(id) || taken.has(`${id}-passed`); n++) id = `${base}-${n}`;
  return id;
}

/** Why a new station cannot go on this arrow, or null when it can. */
export function stationSpot(edge: Pick<GraphEdge, "loop" | "back">): string | null {
  return edge.loop !== null || edge.back
    ? "A station goes on a forward arrow, not on a loop."
    : null;
}
