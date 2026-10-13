import type { DefinitionSummary, LineStage, WorkflowLine } from "../../client/start.js";
import type { BindingView, EditorView, Outcome, StageView } from "../../client/workflow-editor.js";
import { FINISH, lineOf, type Station } from "../runs/line-model.js";
import { stageLabel } from "../runs/model.js";

/**
 * The Workflows screen as a studio: the gallery of definitions, the walkthrough that plays a run
 * along a definition's line, and the graph editor's geometry. Pure: the screens pass in the
 * definitions and the editor view.
 */

// ---------------------------------------------------------------- gallery

export type Family = "full" | "spec" | "quick" | "repair" | "read";

export const FAMILY_LABEL: Record<Family, string> = {
  full: "Spec-driven · full",
  spec: "Spec-driven",
  quick: "Quick",
  repair: "Repair",
  read: "Read only",
};

/** What kind of recipe a definition is, from what it writes and the stations on its line. */
export function familyOf(definition: DefinitionSummary): Family {
  const line = lineOf(definition.stages, definition.line);
  const types = new Set(line.stages.map((s) => s.type));
  if (!definition.writes) return "read";
  if (line.stages[0]?.type === "check") return "repair";
  if (types.has("reflection") || types.has("learn")) return "full";
  if (line.stages.length <= 5) return "quick";
  return "spec";
}

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

const outcomeVerb = (on: string): string =>
  on === "failed"
    ? "failed"
    : on === "changes_requested"
      ? "asked for changes"
      : on.replaceAll("_", " ");

// ---------------------------------------------------------------- walkthrough

export type Scenario = "happy" | "failed" | "changes";
export const SCENARIO_LABEL: Record<Scenario, string> = {
  happy: "Everything passes",
  failed: "A check fails once",
  changes: "Review asks for changes",
};

/** The scenarios a line can play: a failure or a change request needs a loop that takes it. */
export function scenariosFor(line: WorkflowLine): Scenario[] {
  const list: Scenario[] = ["happy"];
  if (line.loops.some((l) => l.on === "failed")) list.push("failed");
  if (line.loops.some((l) => l.on === "changes_requested")) list.push("changes");
  return list;
}

/** One step of the walkthrough. `at` is the station the step happens at. */
export type WalkEvent =
  | { kind: "work"; at: number }
  | { kind: "fail"; at: number; outcome: string }
  /** A loop sent the work back from `from` to `at`, carrying a contract. */
  | { kind: "back"; at: number; from: number; carries: string };

export interface Walkthrough {
  /** The definition's stations, then the finish station. */
  stations: (Pick<LineStage, "id" | "type" | "produces" | "consumes" | "human" | "gates"> & {
    finish?: true;
  })[];
  loops: WorkflowLine["loops"];
  events: WalkEvent[];
}

/**
 * The steps of a run along the line: each station works in turn, and in the failure or change
 * scenario the first loop that takes it sends the work back once.
 */
export function walkthrough(line: WorkflowLine, scenario: Scenario): Walkthrough {
  const last = line.stages.at(-1);
  const stations: Walkthrough["stations"] = [
    ...line.stages,
    {
      id: FINISH,
      type: "agent",
      produces: "result",
      consumes: last ? [last.produces] : [],
      human: false,
      gates: [],
      finish: true,
    },
  ];
  const index = new Map(stations.map((s, i) => [s.id, i]));
  const wanted =
    scenario === "failed" ? "failed" : scenario === "changes" ? "changes_requested" : null;
  const loop = wanted ? line.loops.find((l) => l.on === wanted) : undefined;
  const events: WalkEvent[] = [];
  let looped = false;
  for (let i = 0; i < stations.length; i++) {
    const back = loop ? index.get(loop.to) : undefined;
    const previous = events.at(-1);
    if (previous?.kind === "fail" && loop && back === i)
      events.push({ kind: "back", at: i, from: previous.at, carries: loop.carries });
    else events.push({ kind: "work", at: i });
    if (loop && !looped && stations[i]?.id === loop.from && back !== undefined && back <= i) {
      looped = true;
      events.push({ kind: "fail", at: i, outcome: loop.on });
      i = back - 1;
    }
  }
  return { stations, loops: line.loops, events };
}

export type WalkState = "pending" | "current" | "done" | "failed";
export interface WalkFrame {
  states: WalkState[];
  /** How many times each station has worked so far. */
  rounds: number[];
  event: WalkEvent;
}

/** The line after the first `step + 1` events. */
export function frameAt(walk: Walkthrough, step: number): WalkFrame {
  const states: WalkState[] = walk.stations.map(() => "pending");
  const rounds = walk.stations.map(() => 0);
  const upto = Math.max(0, Math.min(step, walk.events.length - 1));
  let event: WalkEvent = walk.events[0] ?? { kind: "work", at: 0 };
  for (let k = 0; k <= upto; k++) {
    const e = walk.events[k];
    if (!e) break;
    event = e;
    if (e.kind === "fail") {
      states[e.at] = "failed";
      continue;
    }
    if (e.kind === "back") for (let j = e.at; j <= e.from; j++) states[j] = "pending";
    states.forEach((s, j) => {
      if (s === "current") states[j] = "done";
    });
    states[e.at] = walk.stations[e.at]?.finish ? "done" : "current";
    rounds[e.at] = (rounds[e.at] ?? 0) + 1;
  }
  return { states, rounds, event };
}

/**
 * The walkthrough's frame as conveyor stations, so the gallery and the editor play it on the same
 * conveyor as the run screen: an approval waits for you, gates turn green once their station
 * passed and red where it failed.
 */
export function walkStations(walk: Walkthrough, frame: WalkFrame): Station[] {
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

/** The first step at a station, for jumping there from a click. */
export const stepAt = (walk: Walkthrough, station: number): number =>
  Math.max(
    0,
    walk.events.findIndex((e) => e.at === station && e.kind !== "fail"),
  );

/** What the walkthrough says about a step, in plain words. */
export function narrate(walk: Walkthrough, event: WalkEvent): { title: string; text: string } {
  const station = walk.stations[event.at];
  if (!station) return { title: "", text: "" };
  if (event.kind === "fail")
    return {
      title: `${station.id} ${outcomeVerb(event.outcome)}`,
      text: "The line does not move on. What went wrong is packed into a contract that rides back along the repair loop.",
    };
  if (event.kind === "back") {
    const from = walk.stations[event.from]?.id ?? "";
    return {
      title: `Back at ${station.id} with the ${event.carries}`,
      text: `${station.id} works again with what ${from} found. Only the stations from ${station.id} on run again; everything before it stays as it was.`,
    };
  }
  if (station.finish)
    return {
      title: "Done",
      text: "Every station passed. The report has the result and how to deliver it.",
    };
  const takes = station.consumes.filter((c) => c !== "request");
  const inputs = takes.length ? `the ${listText(takes)}` : "your goal";
  switch (station.type) {
    case "agent":
      return {
        title: station.id,
        text: `An agent works from ${inputs} and writes the ${station.produces}. Nothing in your files changes yet.`,
      };
    case "approval":
      return {
        title: station.id,
        text: station.human
          ? `The line waits for you to approve ${inputs}. Nothing is written to your files before that.`
          : `Approves ${inputs} on its own when its rules allow.`,
      };
    case "tasks":
      return {
        title: station.id,
        text: "Writers carry out the approved tasks and change your files, each task in its own working set.",
      };
    case "check":
      return {
        title: station.id,
        text: "Runs the project's checks on the result. When one fails, the gates travel back so the writers see what broke.",
      };
    case "wait":
      return {
        title: station.id,
        text: "Runs its gates again every interval until they pass or its time runs out, with no model calls.",
      };
    case "review":
      return {
        title: station.id,
        text: "A reviewer compares the change with what was asked. A change request sends the review back to the writers.",
      };
    case "reflection":
      return {
        title: station.id,
        text: "Checks every criterion again. Until the result converges, the gaps go back to the writers.",
      };
    case "learn":
      return { title: station.id, text: "Records what this run taught, for the next runs." };
  }
}

const listText = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

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

/**
 * The transition a drag from one station to another adds: forward on `passed`, backward on the
 * stage's other outcome with the smallest loop bound offered. Null with the reason when the
 * editor would refuse it.
 */
export function linkFor(
  stage: StageView,
  to: string,
  view: EditorView,
): { ok: true; on: Outcome; loop: number | null } | { ok: false; reason: string } {
  if (!stage.transitionChoices.to.includes(to))
    return { ok: false, reason: `${stage.id} cannot lead to ${to}.` };
  const order = new Map(view.stages.map((s, i) => [s.id, i]));
  const back = to !== FINISH && (order.get(to) ?? 0) <= (order.get(stage.id) ?? 0);
  const taken = new Set(stage.targets.flatMap((t) => (t.transition ? [t.transition.on] : [])));
  const outcomes = stage.transitionChoices.on.filter((o) =>
    back ? o !== "passed" : o === "passed",
  );
  const on = outcomes.find((o) => !taken.has(o));
  if (!on)
    return {
      ok: false,
      reason: outcomes.length
        ? `${stage.id} already has a transition on ${outcomes.map((o) => o.replaceAll("_", " ")).join(" and ")}. Remove it first.`
        : `${stage.id} only passes, so it cannot send work back. Loops start at checks, reviews and convergence.`,
    };
  const loops = stage.transitionChoices.loop.filter((n): n is number => n !== null);
  return { ok: true, on, loop: back ? (loops[0] ?? null) : null };
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
