import type { LineLoop, LineStage, WorkflowLine } from "../../client/start.js";
import type { IconName } from "../../components/Icon.js";
import { type PipelineStage, type PipelineState, stageLabel } from "./model.js";

/**
 * The run as a production line (the conveyor on the run screen and the recipe cards of New run):
 * each stage is a station that takes contracts and makes one, and repair loops send work back.
 * Pure: the screens pass in the pipeline and the definition's line.
 */

export type StationType = LineStage["type"] | "finish";

/** Sections of the run screen; each station opens the ones about what it makes. */
export const SECTIONS = [
  "overview",
  "decision",
  "tasks",
  "changes",
  "spec",
  "plan",
  "checks",
  "criteria",
  "findings",
  "report",
] as const;
export type Section = (typeof SECTIONS)[number];
export const SECTION_LABEL: Record<Section, string> = {
  overview: "Overview",
  decision: "Decision",
  tasks: "Tasks",
  changes: "Changes",
  spec: "Spec",
  plan: "Plan",
  checks: "Checks",
  criteria: "Criteria",
  findings: "Findings",
  report: "Report",
};

export interface Station {
  id: string;
  label: string;
  type: StationType;
  consumes: string[];
  /** The contract the station makes; null for the finish station. */
  produces: string | null;
  human: boolean;
  state: PipelineState;
  /** 1 for the first pass; higher after a repair loop sent work back. */
  round: number;
}

/** The finish station's ID: transitions name it `done`. */
export const FINISH = "done";

/** A stage's role guessed from its ID, for backends that do not send the line. */
function guess(id: string): Omit<LineStage, "id"> {
  const base = { consumes: [], human: false };
  if (/approv/.test(id)) return { ...base, type: "approval", produces: "decision", human: true };
  if (/implement|build|fix/.test(id)) return { ...base, type: "tasks", produces: "implementation" };
  if (/check|verify|reproduce/.test(id)) return { ...base, type: "check", produces: "gates" };
  if (/review/.test(id)) return { ...base, type: "review", produces: "review" };
  if (/converge/.test(id)) return { ...base, type: "reflection", produces: "convergence" };
  if (/learn/.test(id)) return { ...base, type: "learn", produces: "report" };
  return { ...base, type: "agent", produces: id };
}

/** The line of a definition: the backend's when sent, else one guessed from the stage IDs. */
export function lineOf(
  stageIds: readonly string[],
  line: WorkflowLine | null | undefined,
): WorkflowLine {
  if (line?.stages.length) return line;
  return { stages: stageIds.map((id) => ({ id, ...guess(id) })), loops: [] };
}

/**
 * The stations of a run: the pipeline's stages in order with their line entries, then the finish
 * station. `rounds` maps a stage ID to its latest generation (0 for the first pass).
 */
export function stations(
  pipeline: readonly PipelineStage[],
  line: WorkflowLine,
  rounds: ReadonlyMap<string, number>,
  runStatus: string,
): Station[] {
  const byId = new Map(line.stages.map((s) => [s.id, s]));
  const list: Station[] = pipeline.map((stage) => {
    const entry = byId.get(stage.id) ?? { id: stage.id, ...guess(stage.id) };
    return {
      id: stage.id,
      label: stage.label,
      type: entry.type,
      consumes: entry.consumes,
      produces: entry.produces,
      human: entry.human,
      state: stage.state,
      round: (rounds.get(stage.id) ?? 0) + 1,
    };
  });
  const last = list.at(-1);
  list.push({
    id: FINISH,
    label: "Done",
    type: "finish",
    consumes: last?.produces ? [last.produces] : [],
    produces: null,
    human: false,
    state:
      runStatus === "completed"
        ? "done"
        : runStatus === "failed" || runStatus === "cancelled"
          ? "failed"
          : "pending",
    round: 1,
  });
  return list;
}

/** A stage's icon, from what it makes and its role: research, spec, plan, implement and so on. */
export function stageIcon(station: Pick<Station, "id" | "type" | "produces">): IconName {
  if (station.type === "finish") return "accept";
  if (station.type === "tasks") return "implement";
  if (station.type === "check") return "checks";
  if (station.type === "review" || station.type === "reflection") return "review";
  if (station.type === "approval") return "attention";
  if (station.type === "learn") return "run-memory";
  if (station.produces === "spec" || /spec/.test(station.id)) return "spec";
  if (station.produces === "plan" || /plan/.test(station.id)) return "plan";
  if (/accept/.test(station.id)) return "accept";
  return "research";
}

/** The icon for a stage's state; none for a stage that has not started. */
export const STATE_ICON: Partial<Record<PipelineState, IconName>> = {
  done: "ok",
  current: "running",
  waiting: "waiting",
  failed: "failed",
};

/** The station to show when the user has not picked one: where the run is, or where it ended. */
export function focusStation(list: readonly Station[]): string {
  const live = list.find((s) => s.state === "waiting") ?? list.find((s) => s.state === "current");
  if (live) return live.id;
  const failed = list.find((s) => s.state === "failed" && s.id !== FINISH);
  if (failed) return failed.id;
  const finish = list.at(-1);
  if (finish && finish.state !== "pending") return finish.id;
  return list.find((s) => s.state === "pending")?.id ?? FINISH;
}

/** The run screen sections a station opens, the first being its default. */
export function sectionsOf(station: Pick<Station, "type" | "produces">): Section[] {
  if (station.type === "finish") return ["overview", "report", "criteria"];
  if (station.type === "tasks") return ["tasks", "changes"];
  if (station.type === "approval") return ["decision", "spec", "plan"];
  if (station.type === "check") return ["checks", "criteria"];
  if (station.type === "review") return ["findings", "criteria"];
  if (station.type === "reflection") return ["criteria", "findings"];
  if (station.type === "learn") return ["report"];
  if (station.produces === "spec") return ["spec", "criteria"];
  if (station.produces === "plan") return ["plan"];
  return ["overview"];
}

const list = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const OUTCOME: Record<string, string> = {
  failed: "fails",
  changes_requested: "asks for changes",
  passed: "passes",
};

/** One plain sentence on what the station does. */
export function describe(station: Station, loops: readonly LineLoop[]): string {
  const back = loops.find((l) => l.from === station.id && l.to !== station.id);
  const sendsBack = back
    ? ` When it ${OUTCOME[back.on] ?? back.on.replaceAll("_", " ")}, its ${back.carries} contract goes back to ${stageLabel(back.to)}.`
    : "";
  const inputs = station.consumes.filter((c) => c !== "request");
  switch (station.type) {
    case "agent":
      return `An agent works from ${inputs.length ? `the ${list(inputs)}` : "your goal"} and writes the ${station.produces}.${sendsBack}`;
    case "tasks":
      return `Writers carry out the tasks and change your files.${sendsBack}`;
    case "check":
      return `Runs the project's checks on the result.${sendsBack}`;
    case "approval":
      return station.human
        ? `Waits for you to approve the ${list(inputs)}. Nothing is written to your files before that.`
        : `Approves the ${list(inputs)} on its own when its rules allow.`;
    case "review":
      return `A reviewer compares the change with what was asked.${sendsBack}`;
    case "reflection":
      return `Checks every criterion again until the result converges.${sendsBack}`;
    case "learn":
      return "Records what this run taught, for the next runs.";
    case "finish":
      return station.state === "done"
        ? "Every station passed. The report has the result and how to deliver it."
        : "The run is finished when the last station passes.";
  }
}

export const TYPE_LABEL: Record<StationType, string> = {
  agent: "agent",
  tasks: "writers",
  check: "checks",
  approval: "approval",
  review: "review",
  reflection: "reflection",
  learn: "learn",
  finish: "finish",
};

/** A repair loop's lane text, e.g. `Checks failed: back with gates`. */
export function loopText(loop: LineLoop, fromLabel: string): string {
  const outcome =
    loop.on === "failed"
      ? "failed"
      : loop.on === "changes_requested"
        ? "asked for changes"
        : loop.on.replaceAll("_", " ");
  return `${fromLabel} ${outcome}: back with ${loop.carries}`;
}

/**
 * What moved between two renders of the line, for the tray animation: a contract handed to the
 * next station when a stage finished, or carried back along a loop when an earlier stage restarted.
 */
export type Handoff =
  | { kind: "forward"; from: number; to: number; contract: string }
  | { kind: "repair"; from: number; to: number; contract: string };

export function handoff(
  before: readonly Station[],
  after: readonly Station[],
  loops: readonly LineLoop[],
): Handoff | null {
  if (before.length !== after.length) return null;
  const moving = (s: Station): boolean => s.state === "current" || s.state === "waiting";
  const was = before.findIndex(moving);
  const now = after.findIndex(moving);
  if (now >= 0 && was >= 0 && now < was) {
    const loop = loops.find((l) => l.from === after[was]?.id && l.to === after[now]?.id);
    return {
      kind: "repair",
      from: was,
      to: now,
      contract: loop?.carries ?? after[was]?.produces ?? "",
    };
  }
  for (let i = 0; i < after.length - 1; i++) {
    const a = after[i];
    const b = before[i];
    if (a && b && a.state === "done" && b.state !== "done" && a.produces)
      return { kind: "forward", from: i, to: i + 1, contract: a.produces };
  }
  return null;
}

/** A stage's icon from its ID alone, for lists that do not load the run's line. */
export function stageIconOf(id: string): IconName {
  return stageIcon({ id, ...guess(id) });
}
