import type { RunPolicy, WorkflowDefinition } from "../schemas.js";
import type { ContractId, Stage, Transition, WorkflowV2 } from "./definition.js";

const AGENT_PRODUCES: Record<string, ContractId> = {
  research: "research",
  specify: "spec",
  plan: "plan",
  analyze: "analysis",
};
const AGENT_CONSUMES: Record<string, ContractId[]> = {
  research: [],
  specify: ["research"],
  plan: ["spec"],
  analyze: ["spec", "plan"],
};

/** ID of the AI review gate of a v1 review dimension. */
export const reviewGateId = (dimension: string): string => `${dimension}-review`;

/**
 * Reads a stored v1 definition as its v2 equivalent. Stored runs are never rewritten: the runtime
 * keeps `definition_json` as it was written and interprets it through this function, so the stage
 * order, the repair targets and the gates of the built-in sdd stay what they were. The v1 policy
 * supplies the gates: `policy.checks` become command gates by ID, and the review profiles become
 * AI review gates named `<dimension>-review`.
 */
export function upgradeWorkflowV1(v1: WorkflowDefinition, policy: RunPolicy): WorkflowV2 {
  const writer = v1.stages.find((s) => s.kind === "task-graph");
  const stages: Stage[] = v1.stages.map((s): Stage => {
    switch (s.kind) {
      case "research":
      case "specify":
      case "plan":
      case "analyze":
        return {
          id: s.id,
          type: "agent",
          profileId: s.profileId ?? "",
          consumes: AGENT_CONSUMES[s.kind] ?? [],
          produces: AGENT_PRODUCES[s.kind] ?? "research",
          effects: "none",
        };
      case "approve":
        return {
          id: s.id,
          type: "approval",
          consumes: ["spec", "plan", "analysis"],
          produces: "decision",
          effects: "none",
          decision: "human",
          covers: [writer?.id ?? "implement"],
        };
      case "task-graph":
        return {
          id: s.id,
          type: "tasks",
          consumes: ["spec", "plan", "decision"],
          produces: "implementation",
          effects: "workspace-write",
        };
      case "checks":
        return {
          id: s.id,
          type: "check",
          consumes: ["implementation"],
          produces: "gates",
          effects: "none",
          gates: policy.checks.filter((c) => c.scope === "feature").map((c) => ({ gateId: c.id })),
        };
      case "review": {
        const dimensions = [
          "correctness",
          "security",
          ...(policy.reviewProfiles.language ? ["language"] : []),
        ];
        return {
          id: s.id,
          type: "review",
          consumes: ["spec", "implementation", "gates"],
          produces: "review",
          effects: "none",
          gates: dimensions.map((d) => ({ gateId: reviewGateId(d) })),
        };
      }
      case "converge":
        return {
          id: s.id,
          type: "reflection",
          profileId: s.profileId ?? "",
          consumes: ["spec", "review", "gates"],
          produces: "convergence",
          effects: "none",
        };
      case "learn":
        return {
          id: s.id,
          type: "learn",
          consumes: ["convergence"],
          produces: "report",
          effects: "none",
        };
    }
    throw new Error(`Unknown v1 stage kind ${String((s as { kind: string }).kind)}`);
  });
  const transitions: Transition[] = [];
  v1.stages.forEach((s, i) => {
    const stage = stages[i] as Stage;
    const next = v1.stages[i + 1];
    const taskGates =
      s.kind === "task-graph"
        ? policy.checks.filter((c) => c.scope === "task").map((c) => ({ gateId: c.id }))
        : [];
    transitions.push({
      id: `${s.id}-${next?.id ?? "done"}`,
      from: s.id,
      to: next?.id ?? "done",
      on: "passed",
      carries: stage.produces,
      gates: taskGates,
    });
    if (s.repairTo) {
      const rounds = s.kind === "converge" ? policy.maxConvergenceRounds : policy.maxRepairRounds;
      transitions.push({
        id: `${s.id}-repair`,
        from: s.id,
        to: s.repairTo,
        on: s.kind === "checks" ? "failed" : "changes_requested",
        carries: stage.produces,
        gates: [],
        loop: { maxIterations: Math.max(1, rounds) },
      });
    }
  });
  return {
    schemaVersion: 2,
    id: v1.id,
    version: "2.0.0",
    description: v1.description,
    preset: "full",
    inputs: ["request"],
    entry: v1.stages[0]?.id ?? "research",
    stages,
    transitions,
    limits: { maxStageVisits: 40 },
    autoApproval: null,
  };
}
