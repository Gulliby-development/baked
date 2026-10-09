import { WorkflowSchema } from "../schemas.js";
export const sddWorkflow = WorkflowSchema.parse({
  schemaVersion: 1,
  id: "sdd",
  version: "1.1.0",
  description: "Accepted requirements, implementation and coverage verification.",
  stages: [
    { id: "research", kind: "research", profileId: "researcher" },
    { id: "specify", kind: "specify", profileId: "spec-author" },
    { id: "plan", kind: "plan", profileId: "planner" },
    { id: "analyze", kind: "analyze", profileId: "spec-reviewer" },
    { id: "approve", kind: "approve" },
    { id: "implement", kind: "task-graph" },
    { id: "checks", kind: "checks", repairTo: "implement" },
    { id: "review", kind: "review", profileId: "reviewer", repairTo: "implement" },
    { id: "converge", kind: "converge", profileId: "spec-auditor", repairTo: "implement" },
    { id: "learn", kind: "learn" },
  ],
});
