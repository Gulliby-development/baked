import { canonical, hashJson } from "../../specs/hash.js";
import type { RunPolicy, Spec, WorkflowDefinition } from "../schemas.js";
import { WorkflowSchema } from "../schemas.js";
import type { Check, RuntimeState } from "../types.js";
import {
  effectiveMode,
  type Gate,
  type GateBinding,
  GateSchema,
  HostAutoApprovalSchema,
  type Stage,
  stageGates,
  type WorkflowV2,
  WorkflowV2Schema,
} from "./definition.js";
import { gateToCheck } from "./library.js";

/** The definition a run was started from, as stored in `definition_json`. */
export type RunDefinition =
  | { schemaVersion: 1; definition: WorkflowDefinition }
  | { schemaVersion: 2; definition: WorkflowV2 };

export function parseRunDefinition(json: string): RunDefinition {
  const raw = JSON.parse(json) as { schemaVersion?: unknown };
  return raw.schemaVersion === 2
    ? { schemaVersion: 2, definition: WorkflowV2Schema.parse(raw) }
    : { schemaVersion: 1, definition: WorkflowSchema.parse(raw) };
}

/** The v1 stage mechanism that executes a v2 stage; `report` and `decompose` are the ones v2 adds. */
export type StageKind =
  | WorkflowDefinition["stages"][number]["kind"]
  | "report"
  | "decompose"
  | "wait";

const AGENT_KINDS: Partial<Record<Stage["produces"], StageKind>> = {
  research: "research",
  spec: "specify",
  plan: "plan",
  analysis: "analyze",
  report: "report",
  initiativePlan: "decompose",
};

/** The mechanism of a v2 stage, or null for an agent stage whose contract no agent may submit. */
export function stageKind(stage: Stage): StageKind | null {
  switch (stage.type) {
    case "agent":
      return AGENT_KINDS[stage.produces] ?? null;
    case "approval":
      return "approve";
    case "tasks":
      return "task-graph";
    case "check":
      return "checks";
    case "review":
      return "review";
    case "reflection":
      return "converge";
    case "learn":
      return "learn";
    case "wait":
      return "wait";
  }
}

/** The profile output each agent mechanism requires. */
export const KIND_OUTPUT: Partial<Record<StageKind, string>> = {
  research: "research",
  specify: "spec",
  plan: "plan",
  analyze: "analysis",
  report: "report",
  decompose: "initiativePlan",
  converge: "convergence",
};

export function stageProfileId(stage: Stage): string | undefined {
  return stage.type === "agent" || stage.type === "reflection" ? stage.profileId : undefined;
}

export const produces = (definition: WorkflowV2, contract: Stage["produces"]): boolean =>
  definition.stages.some((s) => s.produces === contract);

/** The outcome of a host-made spec: the request restated, not a result (#1219). */
export const HOST_SPEC_OUTCOME = "The request is done as stated.";

/**
 * The specification of a definition without a spec stage. Quick fix, Spike and Review only have
 * no specification, but the plan validation, the reviewers and acceptance work on requirement and
 * criterion IDs. The host states the request as the single requirement: automated when a required
 * command gate can check it, otherwise manual, so a person confirms it.
 */
export function hostSpec(featureId: string, prompt: string, automated: boolean): Spec {
  const text = prompt.trim().slice(0, 4000);
  const title = text.split("\n")[0]?.slice(0, 120) || featureId;
  return {
    schemaVersion: 1,
    featureId,
    revision: 1,
    title,
    problem: text,
    outcome: HOST_SPEC_OUTCOME,
    inScope: [text],
    outOfScope: [],
    assumptions: ["The request is the whole specification; this definition has no spec stage."],
    openQuestions: [],
    requirements: [
      {
        id: "FR-001",
        text,
        priority: "must",
        verification: automated ? "automated" : "manual",
        sourceRefs: [],
      },
    ],
    criteria: [
      {
        id: "AC-001",
        requirementIds: ["FR-001"],
        given: "the workspace before the run",
        when: "the run completes",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the versioned acceptance-criterion contract.
        then: "the request is done as stated",
        method: automated ? "automated" : "manual",
      },
    ],
    dependencies: [],
  };
}

export function initialPosition(definition: WorkflowV2): NonNullable<RuntimeState["position"]> {
  return {
    stageId: definition.entry,
    visits: { [definition.entry]: 1 },
    loops: {},
    total: 1,
    outcome: null,
    findings: [],
    repairKind: null,
  };
}

/** Every gate binding of a definition, with where it is bound. */
export function bindingsOf(definition: WorkflowV2): {
  binding: GateBinding;
  stageId: string | null;
  transitionId: string | null;
  /** Set for a gate a wait stage polls: it watches the outside world, not the run's work. */
  wait?: true;
}[] {
  return [
    ...definition.stages.flatMap((s) =>
      stageGates(s).map((binding) => ({
        binding,
        stageId: s.id,
        transitionId: null,
        ...(s.type === "wait" ? { wait: true as const } : {}),
      })),
    ),
    ...definition.transitions.flatMap((t) =>
      t.gates.map((binding) => ({ binding, stageId: null, transitionId: t.id })),
    ),
  ];
}

/**
 * The gates a run of the definition uses, resolved from the library when the run starts. They are
 * frozen with the run, so a later edit of a gate file does not change a started run.
 */
export function frozenGates(definition: WorkflowV2, library: ReadonlyMap<string, Gate>): Gate[] {
  const ids = [...new Set(bindingsOf(definition).map((b) => b.binding.gateId))].sort();
  return ids.map((id) => {
    const gate = library.get(id);
    if (!gate) throw new Error(`Unknown gate ${id}`);
    return GateSchema.parse(gate);
  });
}

/**
 * The command gates of a run as v1 checks: the check runner, the planner's task checks and the
 * acceptance predicate keep working on `policy.checks`. A gate bound as required anywhere is
 * required.
 */
export function checksOf(definition: WorkflowV2, gates: readonly Gate[]): Check[] {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const checks = new Map<string, Check>();
  // A wait stage's gates are polled by that stage only, never planned as task checks or accepted.
  for (const { binding, wait } of bindingsOf(definition)) {
    if (wait) continue;
    const gate = byId.get(binding.gateId);
    if (gate?.type !== "command") continue;
    const check = gateToCheck(gate, binding);
    const previous = checks.get(gate.id);
    checks.set(gate.id, previous?.required ? previous : check);
  }
  return [...checks.values()];
}

/** One AI reviewer of a review stage, from its gate binding. */
export interface Reviewer {
  /** Key of the review in the run state: the gate ID for v2, the dimension for v1. */
  key: string;
  dimension: string;
  profileId: string;
  skepticProfileId: string | null;
  blocking: readonly string[];
  required: boolean;
  appliesWhen: Extract<Gate, { type: "ai-review" }>["review"]["appliesWhen"];
}

export function reviewersOf(stage: Stage, gates: readonly Gate[]): Reviewer[] {
  if (stage.type !== "review") return [];
  return stage.gates.map((binding) => {
    const gate = gates.find((g) => g.id === binding.gateId);
    if (gate?.type !== "ai-review")
      throw new Error(`Review stage ${stage.id} binds ${binding.gateId}, not an AI review gate`);
    return {
      key: gate.id,
      dimension: gate.review.dimension,
      profileId: gate.review.profileId,
      skepticProfileId: gate.review.skepticProfileId,
      blocking: gate.review.blockingSeverities,
      required: effectiveMode(binding, gate) === "required",
      appliesWhen: gate.review.appliesWhen,
    };
  });
}

/** The value a transition's `when` reads: the contract the stage produced, as the host holds it. */
export function carriedValue(state: RuntimeState, stage: Stage): unknown {
  switch (stage.produces) {
    case "research":
      return state.research ? JSON.parse(state.research) : null;
    case "spec":
      return state.spec;
    case "plan":
      return state.graph ? { markdown: state.plan, taskGraph: state.graph } : null;
    case "analysis":
      return { verdict: state.analysisPassed ? "pass" : "needs_revision" };
    case "review": {
      const reviews = Object.values(state.reviews);
      return {
        verdict: reviews.some((r) => r.verdict === "changes_requested")
          ? "changes_requested"
          : "pass",
      };
    }
    case "convergence":
      return state.convergence;
    case "report":
      return state.report ? JSON.parse(state.report) : null;
    case "initiativePlan":
      return state.initiativePlan ? JSON.parse(state.initiativePlan) : null;
    case "decision":
      return { digest: state.approvalRoot };
    case "gates":
      return {
        verdict: Object.values(state.gateResults).some(
          (r) => r.mode === "required" && r.status !== "passed" && r.status !== "skipped",
        )
          ? "fail"
          : "pass",
      };
    default:
      return null;
  }
}

/** What a user confirms to turn on a definition's auto approval: the hash of its limits. */
export const autoApprovalHash = (limits: NonNullable<WorkflowV2["autoApproval"]>): string =>
  hashJson(limits);

/** The limits of auto approval in words, for the confirmation a person types and the refusal. */
export function describeAutoApproval(limits: NonNullable<WorkflowV2["autoApproval"]>): string {
  return [
    `at most ${limits.maxTasks} tasks`,
    `${limits.maxFiles} files`,
    `paths ${limits.allowedPaths.join(", ")}`,
    limits.allowDelete ? "deletions allowed" : "no deletions",
    "no new dependencies",
    `a token budget up to ${limits.maxTotalTokens}`,
  ].join("; ");
}

/**
 * The run policy's auto approval for a v2 definition. Auto approval is a property of the
 * definition: a definition without an auto approval stage never approves on its own, whatever the
 * project's policy says.
 */
export function autoApprovalOf(definition: WorkflowV2): RunPolicy["autoApproval"] {
  const auto = definition.autoApproval;
  if (!auto || !definition.stages.some((s) => s.type === "approval" && s.decision === "auto"))
    return null;
  return autoApprovalPolicy(auto);
}

/**
 * A shipped preset whose human approval stages approve within limits the host sets: an initiative
 * with tiered approval runs a small leaf feature on `quick` and approves its plan within the
 * feature's boundary, as a schema 1 workflow does with the same limits (#1374). The host's limits
 * keep the run policy's ceilings, not a definition author's 20-path cap (#1458).
 */
export function withBoundaryApproval(
  definition: WorkflowV2,
  limits: NonNullable<NonNullable<RunPolicy["autoApproval"]>["limits"]>,
): (WorkflowV2 & { autoApproval: NonNullable<WorkflowV2["autoApproval"]> }) | null {
  const parsed = HostAutoApprovalSchema.safeParse({ enabled: true, ...limits });
  if (!parsed.success) return null;
  return {
    ...definition,
    autoApproval: parsed.data,
    stages: definition.stages.map((s) =>
      s.type === "approval" && s.decision === "human" ? { ...s, decision: "auto" } : s,
    ),
  };
}

/** The run policy form of auto approval limits; renewal is never on for limits set by a host. */
export function autoApprovalPolicy(
  auto: NonNullable<WorkflowV2["autoApproval"]>,
): RunPolicy["autoApproval"] {
  return {
    renewal: false,
    limits: {
      maxTasks: auto.maxTasks,
      maxFiles: auto.maxFiles,
      allowedPaths: auto.allowedPaths,
      allowDelete: auto.allowDelete,
      allowNewDependencies: false,
      maxTotalTokens: auto.maxTotalTokens,
    },
  };
}

export const contractText = (value: unknown): string | null =>
  value === null || value === undefined ? null : canonical(value);
