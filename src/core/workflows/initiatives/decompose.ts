import type { WorkflowV2 } from "../v2/definition.js";

/** The workflow an initiative runs to propose its split. It is not offered as a user preset. */
export const DECOMPOSE_WORKFLOW_ID = "initiative-decompose";

/**
 * One agent stage: the `decomposer` profile returns an `initiativePlan`. It changes no file and
 * asks for no approval inside the run; the initiative asks for the approval of the split.
 */
export const decomposeWorkflow: WorkflowV2 = {
  schemaVersion: 2,
  id: DECOMPOSE_WORKFLOW_ID,
  version: "1.0.0",
  description: "Propose the split of a large request into features with contracts and a dependency DAG.",
  preset: "custom",
  inputs: ["request"],
  entry: "decompose",
  stages: [
    {
      id: "decompose",
      type: "agent",
      profileId: "decomposer",
      consumes: [],
      produces: "initiativePlan",
      effects: "none",
    },
  ],
  transitions: [
    {
      id: "decompose-done",
      from: "decompose",
      to: "done",
      on: "passed",
      carries: "initiativePlan",
      gates: [],
    },
  ],
  limits: { maxStageVisits: 4 },
  autoApproval: null,
};
