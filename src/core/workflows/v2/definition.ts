/**
 * Workflow definitions of schema version 2 (docs/workflows/v2-design.md, sections
 * 3 to 6): stages joined by transitions, typed contracts between them and gates on the
 * transitions. Definitions are data; nothing here runs a command or a model.
 */
import { z } from "zod";
import { MAX_CANDIDATES } from "../candidates.js";
import { RelativePath, SafeId } from "../schemas.js";

const Text = z.string().min(1).max(16000);
const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const UniqueStrings = z.array(z.string().min(1)).refine((xs) => new Set(xs).size === xs.length);

/** Typed outputs a stage can hand to the next one. The first eight are the v1 results. */
export const ContractId = z.enum([
  "research",
  "spec",
  "plan",
  "analysis",
  "implementation",
  "review",
  "convergence",
  "refutation",
  "report",
  "initiativePlan",
  "diff",
  "decision",
  "gates",
]);
export type ContractId = z.infer<typeof ContractId>;

export const Outcome = z.enum(["passed", "changes_requested", "failed"]);
export type Outcome = z.infer<typeof Outcome>;

/** A condition is one equality on one field of the carried contract. No expressions, no code. */
export const Predicate = z
  .object({
    field: z.string().regex(/^\$\.[a-zA-Z][a-zA-Z0-9_]{0,31}(\.[a-zA-Z][a-zA-Z0-9_]{0,31}){0,3}$/),
    equals: z.union([z.string().max(64), z.number(), z.boolean()]),
  })
  .strict();
export type Predicate = z.infer<typeof Predicate>;

const PathPattern = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._\-/*]+$/)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").includes(".."),
    "Expected a relative pattern without ..",
  );

// --- Gates -----------------------------------------------------------------------------------

/** The most one-shot commands a terminal walk-through declares. */
export const MAX_ACCEPTANCE_COMMANDS = 20;

const GateCommon = {
  schemaVersion: z.literal(1),
  id: SafeId,
  description: Text,
  /** required blocks the transition; advisory is recorded and shown but never blocks or closes anything. */
  required: z.boolean(),
  /** task: after each task; feature: once on the whole result; transition: once when the transition is taken. */
  scope: z.enum(["task", "feature", "transition"]),
  timeoutMs: z.number().int().min(1000).max(3600000),
  retries: z
    .object({
      max: z.number().int().min(0).max(3),
      retryOn: z.array(z.enum(["inconclusive", "timeout", "failed"])),
    })
    .strict(),
  evidence: z
    .object({
      kind: z.enum(["exit", "artifact", "decision", "review", "recording"]),
      keepOutputLines: z.number().int().min(0).max(400),
      artifactPaths: z.array(RelativePath),
    })
    .strict(),
};
export const CommandGate = z
  .object({
    ...GateCommon,
    type: z.literal("command"),
    command: z
      .object({
        executable: z.string().min(1).max(512),
        args: z.array(z.string().max(2048)),
        cwd: z.union([z.literal("."), RelativePath]),
        envNames: UniqueStrings,
        writes: z.array(RelativePath),
        /** A fixer for what the command reports; the file path is appended (see `Check.fix`). */
        fix: z
          .object({ executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)) })
          .strict()
          .optional(),
        /** A second fixer tier run after `fix` (see `Check.fixUnsafe`). */
        fixUnsafe: z
          .object({ executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)) })
          .strict()
          .optional(),
        /** `json`: a custom gate whose JSON report decides the result (see `Check.report`). */
        report: z.enum(["exit", "json"]).optional(),
      })
      .strict(),
    /** Set on a gate written from an accepted AI walk-through; the test file is pinned by hash. */
    provenance: z
      .object({
        generatedFrom: SafeId,
        testPath: RelativePath,
        testHash: z.string().regex(/^[a-f0-9]{64}$/),
        approvedBy: z.literal("human"),
        approvedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const HumanGate = z
  .object({
    ...GateCommon,
    type: z.literal("human"),
    human: z
      .object({
        prompt: Text,
        answer: z.enum(["approve", "evidence", "text"]),
        /** The decision names the digest it covers, so an old decision cannot approve new content. */
        bindsDigest: z.boolean(),
      })
      .strict(),
  })
  .strict();
export const AiReviewGate = z
  .object({
    ...GateCommon,
    type: z.literal("ai-review"),
    review: z
      .object({
        profileId: SafeId,
        dimension: z.enum(["correctness", "security", "language", "criteria", "custom"]),
        instructions: Text.optional(),
        blockingSeverities: z.array(z.enum(["critical", "high", "medium", "low"])),
        /** A critical or high finding is closed only by a skeptic with counter-evidence. */
        skepticProfileId: SafeId.nullable(),
        /** A named built-in condition, for example the security trigger; not an expression. */
        appliesWhen: z.enum(["always", "security-sensitive"]),
      })
      .strict(),
  })
  .strict();
export const AiAcceptanceGate = z
  .object({
    ...GateCommon,
    type: z.literal("ai-acceptance"),
    acceptance: z
      .object({
        scenario: z
          .object({
            title: Text,
            steps: z.array(Text).min(1).max(30),
            expectations: z.array(Text).max(30),
            /**
             * `manual` adds the run's manual acceptance criteria to the expectations when the gate
             * runs, so a walk-through bound once checks every spec it meets.
             */
            fromCriteria: z.literal("manual").optional(),
          })
          .strict(),
        start: z
          .object({
            executable: z.string().min(1).max(512),
            args: z.array(z.string().max(2048)),
            cwd: z.union([z.literal("."), RelativePath]),
            envNames: UniqueStrings,
            readyWhen: z
              .object({
                url: z.string().url().optional(),
                logIncludes: z.string().max(200).optional(),
              })
              .strict(),
          })
          .strict(),
        /**
         * Terminal driver: one-shot commands the walk-through runs in order with `command_run`,
         * each an argv without a shell, in `start.cwd` with `start.envNames`.
         */
        commands: z
          .array(
            z
              .object({
                executable: z.string().min(1).max(512),
                args: z.array(z.string().max(2048)),
              })
              .strict(),
          )
          .max(MAX_ACCEPTANCE_COMMANDS)
          .optional(),
        driver: z.enum(["browser", "terminal"]),
        /** Everything is denied unless listed. These are the only grants the walk-through receives. */
        capabilities: z
          .object({
            spawnApp: z.boolean(),
            listenPorts: z.array(z.number().int().min(1024).max(65535)).max(4),
            outboundHosts: z.array(z.string().max(253)).max(8),
            writePaths: z.array(RelativePath).max(4),
          })
          .strict(),
        promote: z
          .object({
            commandGateId: SafeId,
            testPath: RelativePath,
            framework: z.enum(["playwright", "cli-script"]),
            stableRuns: z.number().int().min(2).max(5),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const GateSchema = z.discriminatedUnion("type", [
  CommandGate,
  HumanGate,
  AiReviewGate,
  AiAcceptanceGate,
]);
export type Gate = z.infer<typeof GateSchema>;
export type CommandGateDefinition = z.infer<typeof CommandGate>;

/** Why a gate definition is unsafe or contradictory; an empty list means it can be used. */
export function validateGate(gate: Gate): string[] {
  const errors: string[] = [];
  if (gate.type === "ai-acceptance") {
    if (gate.required)
      errors.push(`${gate.id}: an AI walk-through is advisory until its test is promoted`);
    if (gate.scope !== "feature")
      errors.push(`${gate.id}: an acceptance walk-through runs on the whole result`);
    if (!gate.acceptance.scenario.expectations.length && !gate.acceptance.scenario.fromCriteria)
      errors.push(`${gate.id}: the scenario needs an expectation, or fromCriteria "manual"`);
    const grants = gate.acceptance.capabilities;
    if (grants.listenPorts.length > 0 && !grants.spawnApp)
      errors.push(`${gate.id}: ports need spawnApp`);
    if (grants.outboundHosts.some((h) => h.includes("*")))
      errors.push(`${gate.id}: outbound hosts must be exact`);
    if (gate.acceptance.commands?.length && gate.acceptance.driver !== "terminal")
      errors.push(`${gate.id}: commands run only with the terminal driver`);
    if (gate.acceptance.promote.commandGateId === gate.id)
      errors.push(`${gate.id}: the promoted gate needs its own ID`);
    // The walk-through and its test never touch run state, Git metadata or definitions.
    const protectedPath = (p: string) =>
      p === "." || /^(\.baked|\.git|baked)(\/|$)/i.test(p) || /(^|\/)\.env(\.|$)/i.test(p);
    if (grants.writePaths.some(protectedPath))
      errors.push(
        `${gate.id}: write paths must not include the workspace root or workflow metadata`,
      );
    if (protectedPath(gate.acceptance.promote.testPath))
      errors.push(`${gate.id}: the test path must not be workflow metadata`);
  }
  if (gate.type === "human" && gate.scope === "task")
    errors.push(`${gate.id}: a human gate does not run per task`);
  if (gate.retries.max > 0 && gate.retries.retryOn.length === 0)
    errors.push(`${gate.id}: retries need retryOn`);
  if (gate.type !== "command" && gate.retries.retryOn.includes("failed"))
    errors.push(`${gate.id}: only command gates may retry a failed result`);
  return errors;
}

// --- Workflow definition v2 ------------------------------------------------------------------

export const GateBinding = z
  .object({
    gateId: SafeId,
    /** Overrides the library default for this workflow only; the effective value is shown at approval. */
    mode: z.enum(["required", "advisory"]).optional(),
  })
  .strict();
export type GateBinding = z.infer<typeof GateBinding>;

const StageCommon = { id: SafeId, title: Text.optional() };
export const StageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...StageCommon,
      type: z.literal("agent"),
      profileId: SafeId,
      consumes: z.array(ContractId),
      produces: ContractId,
      effects: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...StageCommon,
      type: z.literal("tasks"),
      consumes: z.array(ContractId),
      produces: ContractId,
      effects: z.literal("workspace-write"),
      /**
       * The implementation profile the stage's tasks run on when the plan names the default
       * `implementer` (#832); a task naming another implementation profile keeps it.
       */
      profileId: SafeId.optional(),
      /**
       * Best-of-N (#642): each planned task is implemented this many times in separate worktrees
       * and one candidate is selected. A run's `--candidates` overrides it; needs worktree execution.
       */
      candidates: z.number().int().min(2).max(MAX_CANDIDATES).optional(),
    })
    .strict(),
  z
    .object({
      ...StageCommon,
      type: z.literal("check"),
      consumes: z.array(ContractId),
      produces: z.literal("gates"),
      effects: z.literal("none"),
      gates: z.array(GateBinding).min(1),
    })
    .strict(),
  // Polls its command gates by host code, no model call, until they pass or the timeout.
  z
    .object({
      ...StageCommon,
      type: z.literal("wait"),
      consumes: z.array(ContractId),
      produces: z.literal("gates"),
      effects: z.literal("none"),
      gates: z.array(GateBinding).min(1),
      intervalSeconds: z.number().int().min(5).max(3600),
      timeoutMinutes: z.number().int().min(1).max(1440),
    })
    .strict(),
  z
    .object({
      ...StageCommon,
      type: z.literal("approval"),
      consumes: z.array(ContractId).min(1),
      produces: z.literal("decision"),
      effects: z.literal("none"),
      decision: z.enum(["human", "auto"]),
      /** The write stages whose scope this approval authorizes. */
      covers: z.array(SafeId).min(1),
    })
    .strict(),
  z
    .object({
      ...StageCommon,
      type: z.literal("review"),
      consumes: z.array(ContractId),
      produces: z.literal("review"),
      effects: z.literal("none"),
      gates: z.array(GateBinding).min(1),
    })
    .strict(),
  z
    .object({
      ...StageCommon,
      type: z.literal("reflection"),
      profileId: SafeId,
      consumes: z.array(ContractId),
      produces: z.literal("convergence"),
      effects: z.literal("none"),
    })
    .strict(),
  z
    .object({
      ...StageCommon,
      type: z.literal("learn"),
      consumes: z.array(ContractId),
      produces: z.literal("report"),
      effects: z.literal("none"),
    })
    .strict(),
]);
export type Stage = z.infer<typeof StageSchema>;
/** The gate bindings a stage runs itself: check, review and wait stages. */
export const stageGates = (stage: Stage): GateBinding[] => ("gates" in stage ? stage.gates : []);

/** The most rounds a loop may run; the editor recommends RECOMMENDED_LOOP_ROUNDS or fewer. */
export const MAX_LOOP_ROUNDS = 50;
export const RECOMMENDED_LOOP_ROUNDS = 5;

export const TransitionSchema = z
  .object({
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
    loop: z
      .object({ maxIterations: z.number().int().min(1).max(MAX_LOOP_ROUNDS) })
      .strict()
      .optional(),
  })
  .strict();
export type Transition = z.infer<typeof TransitionSchema>;

export const DefinitionAutoApprovalSchema = z
  .object({
    enabled: z.literal(true),
    maxTasks: z.number().int().min(1).max(20),
    maxFiles: z.number().int().min(1).max(50),
    allowedPaths: z.array(PathPattern).min(1).max(20),
    allowDelete: z.boolean(),
    /** Never configurable: lockfiles, package manifests and CI files always need a human. */
    allowNewDependencies: z.literal(false),
    maxTotalTokens: z.number().int().min(1000),
  })
  .strict();

export const PRESETS = [
  "quick",
  "quick-fix",
  "standard",
  "full",
  "best-of-n",
  "spike",
  "review-only",
  "fix-ci",
  "harden",
  "tdd",
] as const;
export const WorkflowV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: SafeId,
    version: Semver,
    description: Text,
    preset: z.enum([...PRESETS, "custom"]),
    /** What the run starts with: the request text, or a frozen diff the host produced (review only). */
    inputs: z.array(z.enum(["request", "diff"])).min(1),
    entry: SafeId,
    stages: z.array(StageSchema).min(1).max(32),
    transitions: z.array(TransitionSchema).min(1).max(128),
    limits: z.object({ maxStageVisits: z.number().int().min(1).max(100) }).strict(),
    autoApproval: DefinitionAutoApprovalSchema.nullable(),
    /**
     * Where the run edits files: the project working copy (`inline`, the default) or its own Git
     * worktree on the branch `baked/wf/RUN_ID` (`worktree`). Frozen into the run policy.
     */
    execution: z.enum(["inline", "worktree"]).optional(),
    /**
     * Whether the run writes its spec, plan and task graph to `specs/<feature>/` in the project.
     * Absent means yes; with false they stay run artifacts only.
     */
    publish: z.boolean().optional(),
    /**
     * Tests first for runs of this definition (`criteria` or `all`); it overrides the policy's
     * `testsFirst` at start. Absent leaves it to the policy.
     */
    testsFirst: z.enum(["off", "criteria", "all"]).optional(),
  })
  .strict();
export type WorkflowV2 = z.infer<typeof WorkflowV2Schema>;

/**
 * Why a definition cannot run in a worktree, or null. A definition that reviews the working
 * copy's diff needs that diff, which a fresh worktree would not contain.
 */
export function worktreeRefusal(definition: Pick<WorkflowV2, "inputs">): string | null {
  return definition.inputs.includes("diff")
    ? "A definition that reviews the working copy's diff runs inline; a worktree would not contain that diff"
    : null;
}

/** Outcomes each stage type can report. A rejected approval pauses the run and takes no transition. */
export const STAGE_OUTCOMES: Record<Stage["type"], readonly Outcome[]> = {
  agent: ["passed"],
  tasks: ["passed"],
  approval: ["passed"],
  learn: ["passed"],
  check: ["passed", "failed"],
  wait: ["passed", "failed"],
  review: ["passed", "changes_requested"],
  reflection: ["passed", "changes_requested"],
};

const RESERVED = /^(task|dimension|skeptic)-/;

/**
 * Structural checks of a v2 definition before a run: references, contract flow, determinism,
 * bounded loops, reachability, gate scopes and the approval invariant. `gates` maps a library ID
 * to its definition. Every problem is reported, not only the first; an empty list means the
 * definition can start a run.
 */
export function validateWorkflowV2(
  workflow: WorkflowV2,
  gates: ReadonlyMap<string, Gate>,
): string[] {
  const errors: string[] = [];
  const stages = new Map(workflow.stages.map((s) => [s.id, s] as const));
  if (stages.size !== workflow.stages.length) errors.push("duplicate stage ID");
  if (new Set(workflow.transitions.map((t) => t.id)).size !== workflow.transitions.length)
    errors.push("duplicate transition ID");
  for (const stage of workflow.stages) {
    if (RESERVED.test(stage.id) || stage.id === "done")
      errors.push(`reserved stage ID ${stage.id}`);
    if (stage.type === "approval" && stage.decision === "auto" && !workflow.autoApproval)
      errors.push(`auto approval ${stage.id} without autoApproval limits`);
    if (stage.type === "approval")
      for (const target of stage.covers)
        if (stages.get(target)?.effects !== "workspace-write")
          errors.push(`${stage.id} covers ${target}, which does not write`);
  }
  if (!stages.has(workflow.entry)) errors.push(`unknown entry ${workflow.entry}`);

  const outgoing = new Map<string, Transition[]>();
  for (const t of workflow.transitions) {
    if (!stages.has(t.from)) errors.push(`${t.id}: unknown source ${t.from}`);
    if (t.to !== "done" && !stages.has(t.to)) errors.push(`${t.id}: unknown target ${t.to}`);
    const producer = stages.get(t.from);
    if (producer && t.carries !== producer.produces)
      errors.push(`${t.id}: carries ${t.carries} but ${t.from} produces ${producer.produces}`);
    outgoing.set(t.from, [...(outgoing.get(t.from) ?? []), t]);
    for (const binding of t.gates) {
      const gate = gates.get(binding.gateId);
      if (!gate) {
        errors.push(`${t.id}: unknown gate ${binding.gateId}`);
        continue;
      }
      if (gate.scope === "task" && producer?.type !== "tasks")
        errors.push(`${t.id}: task gate ${gate.id} only follows a tasks stage`);
      if (gate.type === "ai-review")
        errors.push(`${t.id}: AI review gate ${gate.id} belongs to a review stage`);
      if (gate.type === "ai-acceptance" && binding.mode === "required")
        errors.push(`${t.id}: AI walk-through ${gate.id} cannot be required`);
    }
  }
  for (const stage of workflow.stages) {
    if (stage.type !== "check" && stage.type !== "review" && stage.type !== "wait") continue;
    const wanted = stage.type === "review" ? "ai-review" : "command";
    for (const binding of stage.gates) {
      const gate = gates.get(binding.gateId);
      if (!gate) errors.push(`${stage.id}: unknown gate ${binding.gateId}`);
      else if (gate.type !== wanted)
        errors.push(`${stage.id}: a ${stage.type} stage runs ${wanted} gates only`);
      else if (gate.scope === "task")
        errors.push(`${stage.id}: task gate ${gate.id} runs after each task, not in a stage`);
      else if (stage.type === "wait" && gate.type === "command" && gate.command.writes.length)
        errors.push(`${stage.id}: a wait stage polls command gates that write nothing`);
    }
  }
  for (const t of workflow.transitions) {
    const type = stages.get(t.from)?.type;
    if (type && !STAGE_OUTCOMES[type].includes(t.on))
      errors.push(`${t.id}: a ${type} stage cannot end ${t.on}`);
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
        if (fallback.length !== 1)
          errors.push(`${from}: conditional ${outcome} transitions need one fallback`);
        const fields = new Set(conditional.map((e) => e.when?.field));
        const values = new Set(conditional.map((e) => String(e.when?.equals)));
        if (fields.size > 1 || values.size !== conditional.length)
          errors.push(`${from}: ${outcome} conditions overlap`);
      }
    }
    if (!edges.some((e) => e.on === "passed")) errors.push(`${from}: no passed transition`);
  }
  for (const stage of workflow.stages)
    if (!outgoing.has(stage.id)) errors.push(`${stage.id}: no outgoing transition`);

  // Reachability from the entry, and a path to completion from every stage.
  const forward = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
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
  for (const id of stages.keys())
    if (reachable.has(id) && !forward(id).has("done")) errors.push(`${id} cannot reach completion`);

  // Loops: every back edge found by depth-first search must be marked and bounded.
  const state = new Map<string, "open" | "closed">();
  const visit = (id: string): void => {
    state.set(id, "open");
    for (const e of outgoing.get(id) ?? []) {
      if (e.to === "done") continue;
      if (state.get(e.to) === "open") {
        if (!e.loop) errors.push(`${e.id}: back edge ${id} to ${e.to} is not a bounded loop`);
      } else if (!state.has(e.to)) visit(e.to);
    }
    state.set(id, "closed");
  };
  if (stages.has(workflow.entry)) visit(workflow.entry);
  for (const e of workflow.transitions)
    if (e.loop && e.to !== "done" && !forward(e.to).has(e.from))
      errors.push(`${e.id}: loop marker on an edge that closes no cycle`);

  // Data flow: a stage may only consume contracts every path to it has already produced.
  const available = new Map<string, Set<string>>();
  const order: string[] = [];
  const seenOrder = new Set<string>();
  const walk = (id: string): void => {
    if (seenOrder.has(id) || !stages.has(id)) return;
    seenOrder.add(id);
    for (const e of outgoing.get(id) ?? []) if (!e.loop) walk(e.to);
    order.push(id);
  };
  walk(workflow.entry);
  order.reverse();
  available.set(workflow.entry, new Set<string>(workflow.inputs));
  for (const id of order) {
    const stage = stages.get(id);
    const here = new Set([...(available.get(id) ?? []), ...(stage ? [stage.produces] : [])]);
    for (const e of outgoing.get(id) ?? []) {
      if (e.loop || e.to === "done") continue;
      const known = available.get(e.to);
      available.set(e.to, known ? new Set([...known].filter((c) => here.has(c))) : here);
    }
  }
  for (const stage of workflow.stages)
    for (const needed of stage.consumes)
      if (!available.get(stage.id)?.has(needed))
        errors.push(`${stage.id} consumes ${needed}, which some path does not produce`);

  // The approval invariant: no path from the entry reaches a stage that writes files without
  // passing an approval that covers it. Back edges are ignored; a loop re-enters through the same approval.
  for (const writer of workflow.stages.filter((s) => s.effects === "workspace-write")) {
    const approvals = new Set(
      workflow.stages
        .filter((s) => s.type === "approval" && s.covers.includes(writer.id))
        .map((s) => s.id),
    );
    const seen = new Set<string>();
    const stack = [workflow.entry];
    let bypass = false;
    while (stack.length && !bypass) {
      const id = stack.pop() as string;
      if (seen.has(id) || approvals.has(id)) continue;
      seen.add(id);
      if (id === writer.id) bypass = true;
      else for (const e of outgoing.get(id) ?? []) if (!e.loop && e.to !== "done") stack.push(e.to);
    }
    if (bypass) errors.push(`${writer.id} can run without an approval that covers it`);
    if (approvals.size === 0) errors.push(`${writer.id} has no approval stage`);
  }

  if (workflow.limits.maxStageVisits < workflow.stages.length)
    errors.push("maxStageVisits is lower than the number of stages");
  return errors;
}

/** The effective mode of a binding: the workflow's override, or the gate's own default. */
export function effectiveMode(binding: GateBinding, gate: Gate): "required" | "advisory" {
  if (gate.type === "ai-acceptance") return "advisory";
  return binding.mode ?? (gate.required ? "required" : "advisory");
}

/** The first transition that answers `outcome` for `stage`, given the carried contract. */
export function selectTransition(
  workflow: WorkflowV2,
  stageId: string,
  outcome: Outcome,
  carried: unknown,
): Transition | undefined {
  const group = workflow.transitions.filter((t) => t.from === stageId && t.on === outcome);
  return group.find((t) => t.when && predicateHolds(t.when, carried)) ?? group.find((t) => !t.when);
}

export function predicateHolds(predicate: Predicate, value: unknown): boolean {
  let current: unknown = value;
  for (const key of predicate.field.slice(2).split(".")) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current === predicate.equals;
}
