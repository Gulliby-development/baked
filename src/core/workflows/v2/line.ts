import type { WorkflowV2 } from "./definition.js";

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

export function workflowLine(definition: WorkflowV2): WorkflowLine {
  const stages = definition.stages.map((stage) => ({
    id: stage.id,
    type: stage.type,
    consumes: [...stage.consumes],
    produces: stage.produces,
    human: stage.type === "approval" && stage.decision === "human",
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
