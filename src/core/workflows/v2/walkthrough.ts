import type { DefinitionSummary } from "./definitions.js";
import type { LineStage, WorkflowLine } from "./line.js";

/**
 * A run played along a workflow's line, for front ends that explain a definition before it runs:
 * its family, the line as one row of text, and the steps of a run in which everything passes, a
 * check fails once or a review asks for changes. Pure; nothing here runs a workflow.
 */

export type Family = "full" | "spec" | "quick" | "repair" | "read";

export const FAMILY_LABEL: Record<Family, string> = {
  full: "Spec-driven · full",
  spec: "Spec-driven",
  quick: "Quick",
  repair: "Repair",
  read: "Read only",
};

/** What kind of recipe a definition is, from what it writes and the stations on its line. */
export function familyOf(definition: Pick<DefinitionSummary, "line" | "writes">): Family {
  const stages = definition.line.stages;
  const types = new Set(stages.map((s) => s.type));
  if (!definition.writes) return "read";
  if (stages[0]?.type === "check") return "repair";
  if (types.has("reflection") || types.has("learn")) return "full";
  if (stages.length <= 5) return "quick";
  return "spec";
}

/**
 * The line as one row: stations joined by arrows, `⟲` after a station a repair loop leaves from.
 * A definition without line entries shows its stage IDs.
 */
export function lineText(definition: Pick<DefinitionSummary, "line" | "stages">): string {
  const { stages, loops } = definition.line;
  if (!stages.length) return definition.stages.join(" → ");
  const looping = new Set(loops.map((l) => l.from));
  return stages.map((s) => (looping.has(s.id) ? `${s.id} ⟲` : s.id)).join(" → ");
}

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

/** The ID of the station after the last stage, where a finished run arrives. */
export const FINISH = "done";

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

/** The first step at a station. */
export const stepAt = (walk: Walkthrough, station: number): number =>
  Math.max(
    0,
    walk.events.findIndex((e) => e.at === station && e.kind !== "fail"),
  );

export const outcomeVerb = (on: string): string =>
  on === "failed"
    ? "failed"
    : on === "changes_requested"
      ? "asked for changes"
      : on.replaceAll("_", " ");

const listText = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

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
