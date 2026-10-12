import { effectiveMode, type Gate, type GateBinding, type WorkflowV2 } from "./definition.js";

/**
 * A workflow as a production line: its stages in order with the contracts each one takes and
 * makes, and the transitions that send work back to an earlier stage. Front ends draw it (the
 * desktop conveyor, the terminal stage row); nothing here runs a workflow.
 */
export interface LineStage {
  id: string;
  type: WorkflowV2["stages"][number]["type"];
  consumes: string[];
  produces: string;
  /** An approval a person gives; an `auto` approval is decided by the runtime. */
  human: boolean;
  /** The stage's own gates, then the gates on the transitions that leave it, in order. */
  gates: LineGate[];
}

/** A gate where it stands on the line, described in words. */
export interface LineGate {
  id: string;
  /** null when the library has no gate with this ID; the definition then does not validate. */
  type: Gate["type"] | null;
  /** `required` blocks the line when it fails; `advisory` only reports. */
  mode: "required" | "advisory";
  /** What the gate does, in a short sentence. */
  does: string;
  /** The transition the gate guards; null for a gate of the stage itself. */
  transition: { id: string; to: string; on: string } | null;
}

/** A transition back to the same or an earlier stage: a repair loop. */
export interface LineLoop {
  from: string;
  to: string;
  on: string;
  carries: string;
}

export interface WorkflowLine {
  stages: LineStage[];
  loops: LineLoop[];
}

const argv = (executable: string, args: readonly string[]): string =>
  [executable, ...args].join(" ");

/** What a gate does, in words, for a person reading the workflow. */
export function gateDoes(gate: Gate): string {
  switch (gate.type) {
    case "command":
      return `Runs ${argv(gate.command.executable, gate.command.args)}`;
    case "human":
      return `Asks a person: ${gate.human.prompt}`;
    case "ai-review":
      return gate.review.dimension === "custom" && gate.review.instructions
        ? `AI review: ${gate.review.instructions}`
        : `AI ${gate.review.dimension} review`;
    case "ai-acceptance":
      return `AI walk-through of ${argv(gate.acceptance.start.executable, gate.acceptance.start.args)}: ${gate.acceptance.scenario.title}`;
  }
}

function lineGate(
  binding: GateBinding,
  library: ReadonlyMap<string, Gate>,
  transition: LineGate["transition"],
): LineGate {
  const gate = library.get(binding.gateId);
  return {
    id: binding.gateId,
    type: gate?.type ?? null,
    mode: gate ? effectiveMode(binding, gate) : (binding.mode ?? "required"),
    does: gate ? gateDoes(gate) : "Unknown gate: no gate with this ID in the library",
    transition,
  };
}

/** The line of a definition; `library` resolves its gate IDs (an empty map lists them unknown). */
export function workflowLine(
  definition: WorkflowV2,
  library: ReadonlyMap<string, Gate> = new Map(),
): WorkflowLine {
  const stages = definition.stages.map((stage) => ({
    id: stage.id,
    type: stage.type,
    consumes: [...stage.consumes],
    produces: stage.produces,
    human: stage.type === "approval" && stage.decision === "human",
    gates: [
      ...(stage.type === "check" || stage.type === "review"
        ? stage.gates.map((b) => lineGate(b, library, null))
        : []),
      ...definition.transitions
        .filter((t) => t.from === stage.id)
        .flatMap((t) => t.gates.map((b) => lineGate(b, library, { id: t.id, to: t.to, on: t.on }))),
    ],
  }));
  const index = new Map(stages.map((stage, i) => [stage.id, i]));
  const loops = definition.transitions
    .filter((t) => {
      const from = index.get(t.from);
      const to = t.to === "done" ? undefined : index.get(t.to);
      return from !== undefined && to !== undefined && to <= from;
    })
    .map((t) => ({ from: t.from, to: t.to, on: t.on, carries: t.carries }));
  return { stages, loops };
}

/** The latest result of a gate in a run. */
export interface GateResult {
  status: "passed" | "failed" | "inconclusive" | "skipped";
  mode: "required" | "advisory";
  attempts: number;
  flaky: boolean;
}

/** A gate of a run's stage with its last result; `last` is null until it ran in this run. */
export interface RunGate extends LineGate {
  last: GateResult | null;
}

/**
 * The gates of each stage of a run's line with their last results, by stage ID. A v1 check stage
 * records its command gates as checks, so `checks` fills in where no gate result exists.
 */
export function runGates(
  line: WorkflowLine,
  gateResults: Readonly<Record<string, GateResult>>,
  checks: readonly { check_id: string; status: string }[] = [],
): Record<string, RunGate[]> {
  const results = new Map<string, GateResult>();
  for (const check of checks)
    if (check.status === "passed" || check.status === "failed" || check.status === "inconclusive")
      results.set(check.check_id, {
        status: check.status,
        mode: "required",
        attempts: 1,
        flaky: false,
      });
  for (const [id, result] of Object.entries(gateResults)) results.set(id, result);
  return Object.fromEntries(
    line.stages.map((stage) => [
      stage.id,
      stage.gates.map((gate) => ({ ...gate, last: results.get(gate.id) ?? null })),
    ]),
  );
}
