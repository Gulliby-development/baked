/** Proposed v2 contracts. Not imported by the BAKED runtime. See workflow-v2-design.md. */
import { z } from "zod";
import { RelativePath, SafeId } from "./contracts";

const Text = z.string().min(1).max(16000);
const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const UniqueStrings = z.array(z.string().min(1)).refine((xs) => new Set(xs).size === xs.length);

/** Typed outputs a stage can hand to the next one. The first eight are the v1 results. */
export const ContractId = z.enum([
  "research", "spec", "plan", "analysis", "implementation", "review", "convergence", "refutation",
  // New in v2.
  "report", // Spike: findings and a recommendation, never a code change.
  "diff", // Review only: a frozen diff the host produced.
  "decision", // A human or auto-approval decision bound to a digest.
  "gates", // The recorded results of the gates of a check stage.
]);

export const Outcome = z.enum(["passed", "changes_requested", "failed"]);
/** A condition is one equality on one field of the carried contract. No expressions, no code. */
export const Predicate = z.object({
  field: z.string().regex(/^\$\.[a-zA-Z][a-zA-Z0-9_]{0,31}(\.[a-zA-Z][a-zA-Z0-9_]{0,31}){0,3}$/),
  equals: z.union([z.string().max(64), z.number(), z.boolean()]),
}).strict();

const PathPattern = z.string().min(1).max(256).regex(/^[A-Za-z0-9._\-/*]+$/)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "Expected a relative pattern without ..");

// --- Gates -----------------------------------------------------------------------------------

const GateCommon = {
  schemaVersion: z.literal(1),
  id: SafeId,
  description: Text,
  /** required blocks the transition; advisory is recorded and shown but never blocks or closes anything. */
  required: z.boolean(),
  /** task: after each task; feature: once on the whole result; transition: once when the transition is taken. */
  scope: z.enum(["task", "feature", "transition"]),
  timeoutMs: z.number().int().min(1000).max(3600000),
  /** A failed exit is retried only if listed; inconclusive and timeout are the usual infrastructure cases. */
  retries: z.object({
    max: z.number().int().min(0).max(3),
    retryOn: z.array(z.enum(["inconclusive", "timeout", "failed"])),
  }).strict(),
  evidence: z.object({
    kind: z.enum(["exit", "artifact", "decision", "review", "recording"]),
    keepOutputLines: z.number().int().min(0).max(400),
    artifactPaths: z.array(RelativePath),
  }).strict(),
};
export const CommandGate = z.object({
  ...GateCommon, type: z.literal("command"),
  command: z.object({
    executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)),
    cwd: z.union([z.literal("."), RelativePath]), envNames: UniqueStrings, writes: z.array(RelativePath),
  }).strict(),
  /** Set on a gate a model wrote from an accepted walk-through (see the AI acceptance gate). */
  provenance: z.object({
    generatedFrom: SafeId, testPath: RelativePath, testHash: z.string().regex(/^[a-f0-9]{64}$/),
    approvedBy: z.literal("human"), approvedAt: z.string().datetime(),
  }).strict().optional(),
}).strict();
export const HumanGate = z.object({
  ...GateCommon, type: z.literal("human"),
  human: z.object({
    prompt: Text, answer: z.enum(["approve", "evidence", "text"]),
    /** The decision names the digest it covers, so an old decision cannot approve new content. */
    bindsDigest: z.boolean(),
  }).strict(),
}).strict();
export const AiReviewGate = z.object({
  ...GateCommon, type: z.literal("ai-review"),
  review: z.object({
    profileId: SafeId,
    dimension: z.enum(["correctness", "security", "language", "criteria", "custom"]),
    instructions: Text.optional(),
    blockingSeverities: z.array(z.enum(["critical", "high", "medium", "low"])),
    /** A critical or high finding is closed only by a skeptic with counter-evidence. */
    skepticProfileId: SafeId.nullable(),
    /** A named built-in condition, for example the security trigger; not an expression. */
    appliesWhen: z.enum(["always", "security-sensitive"]),
  }).strict(),
}).strict();
export const AiAcceptanceGate = z.object({
  ...GateCommon, type: z.literal("ai-acceptance"),
  acceptance: z.object({
    scenario: z.object({ title: Text, steps: z.array(Text).min(1).max(30), expectations: z.array(Text).min(1).max(30) }).strict(),
    start: z.object({
      executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)),
      cwd: z.union([z.literal("."), RelativePath]), envNames: UniqueStrings,
      readyWhen: z.object({ url: z.string().url().optional(), logIncludes: z.string().max(200).optional() }).strict(),
    }).strict(),
    driver: z.enum(["browser", "terminal"]),
    /** Everything is denied unless listed. These are the only grants the walk-through receives. */
    capabilities: z.object({
      spawnApp: z.boolean(),
      listenPorts: z.array(z.number().int().min(1024).max(65535)).max(4),
      outboundHosts: z.array(z.string().max(253)).max(8),
      writePaths: z.array(RelativePath).max(4),
    }).strict(),
    promote: z.object({
      commandGateId: SafeId, testPath: RelativePath, framework: z.enum(["playwright", "cli-script"]),
      stableRuns: z.number().int().min(2).max(5),
    }).strict(),
  }).strict(),
}).strict();
export const GateSchema = z.discriminatedUnion("type", [CommandGate, HumanGate, AiReviewGate, AiAcceptanceGate]);
export type Gate = z.infer<typeof GateSchema>;

/** Why a gate definition is unsafe or contradictory; an empty list means it can be used. */
export function validateGate(gate: Gate): string[] {
  const errors: string[] = [];
  if (gate.type === "ai-acceptance") {
    if (gate.required) errors.push(`${gate.id}: an AI walk-through is advisory until its test is promoted`);
    if (gate.scope !== "feature") errors.push(`${gate.id}: an acceptance walk-through runs on the whole result`);
    const grants = gate.acceptance.capabilities;
    if (grants.listenPorts.length > 0 && !grants.spawnApp) errors.push(`${gate.id}: ports need spawnApp`);
    if (grants.outboundHosts.some((h) => h === "*" || h.includes("*"))) errors.push(`${gate.id}: outbound hosts must be exact`);
    if (gate.acceptance.promote.commandGateId === gate.id) errors.push(`${gate.id}: the promoted gate needs its own ID`);
  }
  if (gate.type === "command" && gate.provenance && gate.provenance.testPath.startsWith("..")) errors.push(`${gate.id}: bad test path`);
  if (gate.type === "human" && gate.scope === "task") errors.push(`${gate.id}: a human gate does not run per task`);
  if (gate.retries.max > 0 && gate.retries.retryOn.length === 0) errors.push(`${gate.id}: retries need retryOn`);
  if (gate.type !== "command" && gate.retries.retryOn.includes("failed")) errors.push(`${gate.id}: only command gates may retry a failed result`);
  return errors;
}

// --- Workflow definition v2 ------------------------------------------------------------------

export const GateBinding = z.object({
  gateId: SafeId,
  /** Overrides the library default for this workflow only; the effective value is shown at approval. */
  mode: z.enum(["required", "advisory"]).optional(),
}).strict();

const StageCommon = { id: SafeId, title: Text.optional() };
export const StageSchema = z.discriminatedUnion("type", [
  // A read-only agent that submits one typed result.
  z.object({ ...StageCommon, type: z.literal("agent"), profileId: SafeId, consumes: z.array(ContractId), produces: ContractId, effects: z.literal("none") }).strict(),
  // The v1 task-graph stage: the only kind of stage that edits project files.
  z.object({ ...StageCommon, type: z.literal("tasks"), consumes: z.array(ContractId), produces: ContractId, effects: z.literal("workspace-write") }).strict(),
  // Runs its gates on a frozen snapshot without a model.
  z.object({ ...StageCommon, type: z.literal("check"), consumes: z.array(ContractId), produces: z.literal("gates"), effects: z.literal("none"), gates: z.array(GateBinding).min(1) }).strict(),
  // A decision bound to a digest of the contracts it covers.
  z.object({
    ...StageCommon, type: z.literal("approval"), consumes: z.array(ContractId).min(1), produces: z.literal("decision"), effects: z.literal("none"),
    decision: z.enum(["human", "auto"]),
    /** The write stages whose scope this approval authorizes. */
    covers: z.array(SafeId).min(1),
  }).strict(),
  // Model review of a snapshot or a diff. Each ai-review gate is one reviewer in a fresh context.
  z.object({ ...StageCommon, type: z.literal("review"), consumes: z.array(ContractId), produces: z.literal("review"), effects: z.literal("none"), gates: z.array(GateBinding).min(1) }).strict(),
  // Coverage of every criterion; may append bounded corrective tasks through a loop edge.
  z.object({ ...StageCommon, type: z.literal("reflection"), profileId: SafeId, consumes: z.array(ContractId), produces: z.literal("convergence"), effects: z.literal("none") }).strict(),
  // Optional last stage: a project-memory candidate from confirmed findings. Never blocks completion.
  z.object({ ...StageCommon, type: z.literal("learn"), consumes: z.array(ContractId), produces: z.literal("report"), effects: z.literal("none") }).strict(),
]);
export type Stage = z.infer<typeof StageSchema>;

export const TransitionSchema = z.object({
  id: SafeId,
  from: SafeId,
  /** "done" is the single completion node. */
  to: z.union([SafeId, z.literal("done")]),
  on: Outcome,
  when: Predicate.optional(),
  /** The typed output of `from`, validated before the transition is taken. */
  carries: ContractId,
  /** Ordered. All required gates must pass before the next stage starts. */
  gates: z.array(GateBinding).max(12),
  /** Marks a back edge. Every cycle must contain one. */
  loop: z.object({ maxIterations: z.number().int().min(1).max(5) }).strict().optional(),
}).strict();
export type Transition = z.infer<typeof TransitionSchema>;

export const AutoApprovalSchema = z.object({
  /** The human opted in for this workflow, inside these limits. Stored in the definition and its hash. */
  enabled: z.literal(true),
  maxTasks: z.number().int().min(1).max(20),
  maxFiles: z.number().int().min(1).max(50),
  allowedPaths: z.array(PathPattern).min(1).max(20),
  allowDelete: z.boolean(),
  /** Never configurable: lockfiles, package manifests and CI files always need a human. */
  allowNewDependencies: z.literal(false),
  maxTotalTokens: z.number().int().min(1000),
}).strict();

export const WorkflowV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: SafeId, version: Semver, description: Text,
  preset: z.enum(["quick-fix", "standard", "full", "spike", "review-only", "custom"]),
  /** What the run starts with: the request text, or a frozen diff the host produced (review only). */
  inputs: z.array(z.enum(["request", "diff"])).min(1),
  entry: SafeId,
  stages: z.array(StageSchema).min(1).max(32),
  transitions: z.array(TransitionSchema).min(1).max(128),
  limits: z.object({ maxStageVisits: z.number().int().min(1).max(100) }).strict(),
  autoApproval: AutoApprovalSchema.nullable(),
}).strict();
export type WorkflowV2 = z.infer<typeof WorkflowV2Schema>;

const RESERVED = /^(task|dimension|skeptic)-/;

/**
 * Structural checks of a v2 definition before a run: references, contract flow, determinism,
 * bounded loops, reachability, gate scopes and the approval invariant. `gates` maps a library ID to
 * its definition. An empty list means the definition can start a run.
 */
export function validateWorkflowV2(workflow: WorkflowV2, gates: ReadonlyMap<string, Gate>): string[] {
  const errors: string[] = [];
  const stages = new Map(workflow.stages.map((s) => [s.id, s] as const));
  if (stages.size !== workflow.stages.length) errors.push("duplicate stage ID");
  if (new Set(workflow.transitions.map((t) => t.id)).size !== workflow.transitions.length) errors.push("duplicate transition ID");
  for (const stage of workflow.stages) {
    if (RESERVED.test(stage.id) || stage.id === "done") errors.push(`reserved stage ID ${stage.id}`);
    if (stage.type === "approval" && stage.decision === "auto" && !workflow.autoApproval) errors.push(`auto approval ${stage.id} without autoApproval limits`);
    if (stage.type === "approval") {
      for (const target of stage.covers) if (stages.get(target)?.effects !== "workspace-write") errors.push(`${stage.id} covers ${target}, which does not write`);
    }
  }
  if (!stages.has(workflow.entry)) errors.push(`unknown entry ${workflow.entry}`);

  const outgoing = new Map<string, Transition[]>();
  for (const t of workflow.transitions) {
    if (!stages.has(t.from)) errors.push(`${t.id}: unknown source ${t.from}`);
    if (t.to !== "done" && !stages.has(t.to)) errors.push(`${t.id}: unknown target ${t.to}`);
    const producer = stages.get(t.from);
    if (producer && t.carries !== producer.produces) errors.push(`${t.id}: carries ${t.carries} but ${t.from} produces ${producer.produces}`);
    outgoing.set(t.from, [...(outgoing.get(t.from) ?? []), t]);
    for (const binding of t.gates) {
      const gate = gates.get(binding.gateId);
      if (!gate) { errors.push(`${t.id}: unknown gate ${binding.gateId}`); continue; }
      if (gate.scope === "task" && producer?.type !== "tasks") errors.push(`${t.id}: task gate ${gate.id} only follows a tasks stage`);
    }
  }
  // A check stage runs command gates and a review stage runs ai-review gates, nothing else.
  for (const stage of workflow.stages) {
    if (stage.type !== "check" && stage.type !== "review") continue;
    const wanted = stage.type === "check" ? "command" : "ai-review";
    for (const binding of stage.gates) {
      const gate = gates.get(binding.gateId);
      if (!gate) errors.push(`${stage.id}: unknown gate ${binding.gateId}`);
      else if (gate.type !== wanted) errors.push(`${stage.id}: a ${stage.type} stage runs ${wanted} gates only`);
    }
  }
  // Which outcomes a stage can report. A rejected approval pauses the run and takes no transition.
  const OUTCOMES: Record<Stage["type"], readonly string[]> = {
    agent: ["passed"], tasks: ["passed"], approval: ["passed"], learn: ["passed"],
    check: ["passed", "failed"], review: ["passed", "changes_requested"], reflection: ["passed", "changes_requested"],
  };
  for (const t of workflow.transitions) {
    const type = stages.get(t.from)?.type;
    if (type && !OUTCOMES[type].includes(t.on)) errors.push(`${t.id}: a ${type} stage cannot end ${t.on}`);
  }

  // Determinism: per (stage, outcome) either one unconditional edge, or conditions on one field plus a fallback.
  for (const [from, edges] of outgoing) {
    for (const outcome of Outcome.options) {
      const group = edges.filter((e) => e.on === outcome);
      if (group.length === 0) continue;
      const fallback = group.filter((e) => !e.when);
      if (fallback.length > 1) errors.push(`${from}: two unconditional ${outcome} transitions`);
      const conditional = group.filter((e) => e.when);
      if (conditional.length > 0) {
        if (fallback.length !== 1) errors.push(`${from}: conditional ${outcome} transitions need one fallback`);
        const fields = new Set(conditional.map((e) => e.when?.field));
        const values = new Set(conditional.map((e) => String(e.when?.equals)));
        if (fields.size > 1 || values.size !== conditional.length) errors.push(`${from}: ${outcome} conditions overlap`);
      }
    }
    if (!edges.some((e) => e.on === "passed")) errors.push(`${from}: no passed transition`);
  }
  for (const stage of workflow.stages) if (!outgoing.has(stage.id)) errors.push(`${stage.id}: no outgoing transition`);

  // Reachability from the entry, and a path to completion from every stage.
  const forward = (start: string): Set<string> => {
    const seen = new Set<string>(); const stack = [start];
    while (stack.length) {
      const id = stack.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of outgoing.get(id) ?? []) stack.push(e.to);
    }
    return seen;
  };
  const reachable = forward(workflow.entry);
  for (const id of stages.keys()) if (!reachable.has(id)) errors.push(`unreachable stage ${id}`);
  if (!reachable.has("done")) errors.push("completion is unreachable");
  for (const id of stages.keys()) if (reachable.has(id) && !forward(id).has("done")) errors.push(`${id} cannot reach completion`);

  // Loops: every back edge found by depth-first search must be marked and bounded.
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string): void => {
    state.set(id, "open");
    for (const e of outgoing.get(id) ?? []) {
      if (e.to === "done") continue;
      if (state.get(e.to) === "open") { if (!e.loop) errors.push(`${e.id}: back edge ${id} to ${e.to} is not a bounded loop`); }
      else if (!state.has(e.to)) visit(e.to);
    }
    state.set(id, "closed");
  };
  if (stages.has(workflow.entry)) visit(workflow.entry);
  for (const e of workflow.transitions) if (e.loop && state.size > 0) {
    // A marked loop that is not a back edge is harmless but misleading.
    const target = e.to;
    if (target !== "done" && !forward(target).has(e.from)) errors.push(`${e.id}: loop marker on an edge that closes no cycle`);
  }

  // Data flow: a stage may only consume contracts every path to it has already produced.
  const available = new Map<string, Set<string> | null>();
  const produced = (id: string): string[] => { const s = stages.get(id); return s ? [s.produces] : []; };
  const order: string[] = []; const seenOrder = new Set<string>();
  const walk = (id: string): void => { if (seenOrder.has(id) || !stages.has(id)) return; seenOrder.add(id); for (const e of outgoing.get(id) ?? []) if (!e.loop) walk(e.to); order.push(id); };
  walk(workflow.entry);
  order.reverse();
  available.set(workflow.entry, new Set<string>(workflow.inputs));
  for (const id of order) {
    const here = new Set([...(available.get(id) ?? []), ...produced(id)]);
    for (const e of outgoing.get(id) ?? []) {
      if (e.loop || e.to === "done") continue;
      const known = available.get(e.to);
      available.set(e.to, known ? new Set([...known].filter((c) => here.has(c))) : here);
    }
  }
  for (const stage of workflow.stages) {
    for (const needed of stage.consumes) {
      if (!available.get(stage.id)?.has(needed)) errors.push(`${stage.id} consumes ${needed}, which some path does not produce`);
    }
  }

  // The approval invariant: no path from the entry reaches a stage that writes files without passing
  // an approval that covers it. Back edges are ignored; a loop re-enters through the same approval.
  for (const writer of workflow.stages.filter((s) => s.effects === "workspace-write")) {
    const approvals = new Set(workflow.stages.filter((s) => s.type === "approval" && s.covers.includes(writer.id)).map((s) => s.id));
    const seen = new Set<string>(); const stack = [workflow.entry]; let bypass = false;
    while (stack.length && !bypass) {
      const id = stack.pop() as string;
      if (seen.has(id) || approvals.has(id)) continue;
      seen.add(id);
      if (id === writer.id) { bypass = true; break; }
      for (const e of outgoing.get(id) ?? []) if (!e.loop && e.to !== "done") stack.push(e.to);
    }
    if (bypass) errors.push(`${writer.id} can run without an approval that covers it`);
    if (approvals.size === 0) errors.push(`${writer.id} has no approval stage`);
    else {
      const autoOnly = [...approvals].every((a) => (stages.get(a) as Stage & { decision?: string }).decision === "auto");
      if (autoOnly && !workflow.autoApproval) errors.push(`${writer.id} is covered only by an auto approval without limits`);
    }
  }

  // Runtime cap on stage visits; the definition must leave room for one pass through every stage.
  if (workflow.limits.maxStageVisits < workflow.stages.length) errors.push("maxStageVisits is lower than the number of stages");
  return errors;
}

// --- Migration from v1 -----------------------------------------------------------------------

/**
 * Reads a stored v1 definition as its v2 equivalent. Stored runs are never rewritten: the runtime
 * keeps `definition_json` as it was written and interprets it through this function, so the stage
 * order, the repair targets and the gates of the built-in sdd stay what they were.
 * The v1 policy supplies the gates: `policy.checks` become command gates by ID, and the review
 * profiles become ai-review gates named `<dimension>-review`.
 */
export function upgradeWorkflowV1(v1: import("./contracts").WorkflowDefinition, policy: import("./contracts").RunPolicy): WorkflowV2 {
  const produces: Record<string, z.infer<typeof ContractId>> = { research: "research", specify: "spec", plan: "plan", analyze: "analysis" };
  const consumes: Record<string, z.infer<typeof ContractId>[]> = { research: [], specify: ["research"], plan: ["spec"], analyze: ["spec", "plan"] };
  const writer = v1.stages.find((s) => s.kind === "task-graph");
  const stages: Stage[] = v1.stages.map((s): Stage => {
    switch (s.kind) {
      case "research": case "specify": case "plan": case "analyze":
        return { id: s.id, type: "agent", profileId: s.profileId as string, consumes: consumes[s.kind] as z.infer<typeof ContractId>[], produces: produces[s.kind] as z.infer<typeof ContractId>, effects: "none" };
      case "approve": return { id: s.id, type: "approval", consumes: ["spec", "plan", "analysis"], produces: "decision", effects: "none", decision: "human", covers: [writer?.id ?? "implement"] };
      case "task-graph": return { id: s.id, type: "tasks", consumes: ["spec", "plan", "decision"], produces: "implementation", effects: "workspace-write" };
      case "checks": return { id: s.id, type: "check", consumes: ["implementation"], produces: "gates", effects: "none", gates: policy.checks.filter((c) => c.scope === "feature").map((c) => ({ gateId: c.id })) };
      case "review": {
        const dimensions = ["correctness", "security", ...(policy.reviewProfiles.language ? ["language"] : [])];
        return { id: s.id, type: "review", consumes: ["spec", "implementation", "gates"], produces: "review", effects: "none", gates: dimensions.map((d) => ({ gateId: `${d}-review` })) };
      }
      case "converge": return { id: s.id, type: "reflection", profileId: s.profileId as string, consumes: ["spec", "review", "gates"], produces: "convergence", effects: "none" };
      case "learn": return { id: s.id, type: "learn", consumes: ["convergence"], produces: "report", effects: "none" };
    }
  });
  const transitions: Transition[] = [];
  v1.stages.forEach((s, i) => {
    const stage = stages[i] as Stage;
    const next = v1.stages[i + 1];
    const taskGates = s.kind === "task-graph" ? policy.checks.filter((c) => c.scope === "task").map((c) => ({ gateId: c.id })) : [];
    transitions.push({ id: `${s.id}-${next?.id ?? "done"}`, from: s.id, to: next?.id ?? "done", on: "passed", carries: stage.produces, gates: taskGates });
    if (s.repairTo) {
      const rounds = s.kind === "converge" ? policy.maxConvergenceRounds : policy.maxRepairRounds;
      transitions.push({
        id: `${s.id}-repair`, from: s.id, to: s.repairTo, on: s.kind === "checks" ? "failed" : "changes_requested",
        carries: stage.produces, gates: [], loop: { maxIterations: Math.max(1, rounds) },
      });
    }
  });
  return {
    schemaVersion: 2, id: v1.id, version: "2.0.0", description: v1.description, preset: "full", inputs: ["request"],
    entry: v1.stages[0]?.id as string, stages, transitions, limits: { maxStageVisits: 40 }, autoApproval: null,
  };
}
