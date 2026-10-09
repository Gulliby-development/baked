/** Workflow v1 contracts. Kept compatible with design/sdd-workflows/contracts.ts. */
import { z } from "zod";

export const SafeId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes(":") &&
      [...p].every((character) => character.charCodeAt(0) >= 32) &&
      p.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "Expected a canonical relative POSIX path",
  );
const Text = z.string().min(1).max(16000);
const RequirementId = z.string().regex(/^(FR|NFR|SC)-[0-9]{3,6}$/);
const CriterionId = z.string().regex(/^AC-[0-9]{3,6}$/);
const TaskId = z.string().regex(/^T[0-9]{3,6}$/);
const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const UniqueStrings = z.array(z.string().min(1)).refine((xs) => new Set(xs).size === xs.length);

export const SpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureId: SafeId,
    revision: z.number().int().positive(),
    title: Text,
    problem: Text,
    outcome: Text,
    inScope: z.array(Text).min(1),
    outOfScope: z.array(Text),
    assumptions: z.array(Text),
    openQuestions: z.array(
      z.object({ id: SafeId, question: Text, blocking: z.boolean() }).strict(),
    ),
    requirements: z
      .array(
        z
          .object({
            id: RequirementId,
            text: Text,
            priority: z.enum(["must", "should"]),
            verification: z.enum(["automated", "manual", "post-release"]),
            sourceRefs: z.array(Text),
          })
          .strict(),
      )
      .min(1),
    criteria: z
      .array(
        z
          .object({
            id: CriterionId,
            requirementIds: z.array(RequirementId).min(1),
            given: Text,
            when: Text,
            // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the versioned acceptance-criterion contract.
            then: Text,
            method: z.enum(["automated", "manual", "post-release"]),
          })
          .strict(),
      )
      .min(1),
    dependencies: z.array(z.object({ featureId: SafeId, contractHash: Hash }).strict()),
  })
  .strict();

export const TaskSchema = z
  .object({
    id: TaskId,
    title: Text,
    description: Text,
    requirementIds: z.array(RequirementId).min(1),
    criterionIds: z.array(CriterionId).min(1),
    dependsOn: z.array(TaskId),
    profileId: SafeId,
    writes: z.array(
      z.object({ path: RelativePath, action: z.enum(["create", "modify", "delete"]) }).strict(),
    ),
    readHints: z.array(RelativePath),
    checkIds: z.array(SafeId),
    origin: z.enum(["planned", "repair", "convergence"]),
    findingIds: z.array(SafeId),
    rationale: Text,
  })
  .strict();

export const TaskGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureId: SafeId,
    revision: z.number().int().positive(),
    specHash: Hash,
    planHash: Hash,
    tasks: z.array(TaskSchema).min(1).max(500),
  })
  .strict();

export const CheckSchema = z
  .object({
    id: SafeId,
    executable: z.string().min(1).max(512),
    args: z.array(z.string().max(2048)),
    cwd: z.union([z.literal("."), RelativePath]),
    timeoutMs: z.number().int().min(1000).max(3600000),
    required: z.boolean(),
    scope: z.enum(["task", "feature"]),
    envNames: UniqueStrings,
    writes: z.array(RelativePath),
  })
  .strict();

/**
 * Opt-in approval without a person (workflow v2 design, section 5.2). Frozen with the policy, so
 * it is part of the approval digest. `renewal` re-approves a revised package that stays within
 * the last human approval of the run; `limits` approves a package inside the stated bounds.
 */
export const AutoApprovalSchema = z
  .object({
    renewal: z.boolean(),
    limits: z
      .object({
        maxTasks: z.number().int().min(1).max(500),
        maxFiles: z.number().int().min(1).max(500),
        allowedPaths: z.array(z.string().min(1).max(512)).min(1),
        allowDelete: z.boolean(),
        allowNewDependencies: z.literal(false),
        maxTotalTokens: z.number().int().min(1000),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => value.renewal || value.limits !== null, "Auto approval requires limits");

export const PolicySchema = z
  .object({
    maxConcurrentReadAgents: z.number().int().min(1).max(8),
    maxConcurrentWriters: z.literal(1),
    maxAgentSteps: z.number().int().min(1).max(100),
    maxAgentCalls: z.number().int().min(1).max(1000),
    maxTotalTokens: z.number().int().min(1000),
    /** Token cap for one agent attempt (one task or stage call); defaults at runtime. */
    maxAttemptTokens: z.number().int().min(1000).optional(),
    maxActiveMs: z.number().int().min(1000),
    maxCostUsd: z.number().positive().nullable(),
    /**
     * Soft checkpoints: when set, the run pauses for a decision each time it would spend past the
     * next multiple of this many tokens. Used with an uncapped token limit (see UNCAPPED_TOKENS).
     */
    checkpointTokens: z.number().int().min(10000).nullable().default(null),
    maxRepairRounds: z.number().int().min(0).max(5),
    maxConvergenceRounds: z.number().int().min(0).max(5),
    maxCorrectiveTasks: z.number().int().min(0).max(100),
    scopeApproval: z.literal("required"),
    reviewProfiles: z
      .object({ correctness: SafeId, security: SafeId, language: SafeId.nullable() })
      .strict(),
    skepticProfileId: SafeId,
    forceSecurityReview: z.boolean(),
    allowedTools: UniqueStrings,
    network: z.enum(["deny", "ask", "allow"]),
    checks: z.array(CheckSchema),
    autoApproval: AutoApprovalSchema.nullable().optional(),
  })
  .strict();

export const ProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafeId,
    version: Semver,
    description: Text,
    role: z.enum([
      "researcher",
      "spec-author",
      "planner",
      "implementer",
      "reviewer",
      "spec-auditor",
      "reporter",
    ]),
    model: z.string().min(1),
    context: z.enum([
      "research",
      "specification",
      "planning",
      "implementation",
      "review",
      "convergence",
    ]),
    instructions: Text,
    skills: z.array(z.object({ id: SafeId, hash: Hash }).strict()),
    allowedTools: UniqueStrings,
    output: z.enum([
      "research",
      "spec",
      "plan",
      "analysis",
      "implementation",
      "review",
      "convergence",
      "refutation",
      "report",
    ]),
    maxSteps: z.number().int().min(1).max(100),
    maxOutputTokens: z.number().int().min(256).max(65536),
  })
  .strict();

export const StageKind = z.enum([
  "research",
  "specify",
  "plan",
  "analyze",
  "approve",
  "task-graph",
  "checks",
  "review",
  "converge",
  "learn",
]);
export const WorkflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafeId,
    version: Semver,
    description: Text,
    stages: z
      .array(
        z
          .object({
            id: SafeId,
            kind: StageKind,
            profileId: SafeId.optional(),
            repairTo: SafeId.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export const RunStatus = z.enum([
  "created",
  "running",
  "waiting",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export const StepStatus = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "skipped",
  "invalidated",
]);
export const TaskStatus = z.enum([
  "pending",
  "running",
  "implemented",
  "verified",
  "blocked",
  "failed",
  "cancelled",
  "invalidated",
]);
export const ReasonCode = z.enum([
  "clarification",
  "approval",
  "manual_evidence",
  "user_pause",
  "owner_lost",
  "input_changed",
  "workspace_busy",
  "budget_exhausted",
  "checkpoint",
  "no_progress",
  "verification_failed",
  "provider_unavailable",
  "tool_denied",
  "storage_failure",
  "invalid_output",
  "interrupted_effect",
  "dependency_failed",
  "none",
]);

export const ReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotHash: Hash,
    verdict: z.enum(["pass", "changes_requested", "inconclusive"]),
    coverage: z.array(
      z
        .object({
          criterionId: CriterionId,
          verdict: z.enum(["pass", "fail", "inconclusive", "deferred"]),
          evidenceIds: z.array(SafeId),
          explanation: Text,
        })
        .strict(),
    ),
    findings: z
      .array(
        z
          .object({
            id: SafeId,
            kind: z.enum([
              "correctness",
              "security",
              "missing",
              "partial",
              "contradicts",
              "unrequested",
            ]),
            severity: z.enum(["critical", "high", "medium", "low"]),
            requirementIds: z.array(RequirementId),
            criterionIds: z.array(CriterionId),
            file: RelativePath.nullable(),
            symbol: z.string().nullable(),
            evidenceIds: z.array(SafeId).min(1),
            claim: Text,
            impact: Text,
            suggestedFix: Text,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const ImplementationSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskId,
    outcome: z.enum(["implemented", "already_satisfied", "blocked", "failed"]),
    summary: Text,
    evidenceIds: z.array(SafeId),
    unresolved: z.array(Text),
  })
  .strict();

export const ResearchSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: Text,
    facts: z.array(z.object({ statement: Text, paths: z.array(RelativePath) }).strict()),
    unknowns: z.array(z.object({ question: Text, blocking: z.boolean() }).strict()),
    constraints: z.array(Text),
    suggestedScope: z.array(Text),
  })
  .strict();
/** The written result of a Spike: findings and a recommendation, never a code change. */
export const ReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: Text,
    findings: z
      .array(z.object({ title: Text, detail: Text, paths: z.array(RelativePath) }).strict())
      .max(50),
    recommendation: z
      .object({
        kind: z.enum(["proceed", "do-not-proceed", "research-more", "needs-decision"]),
        text: Text,
      })
      .strict(),
    openQuestions: z.array(Text).max(20),
  })
  .strict();
export const PlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    markdown: z.string().min(1).max(240000),
    taskGraph: TaskGraphSchema,
  })
  .strict();
export const CorrectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentDigest: Hash,
    parentGraphHash: Hash,
    rule: z.literal("bounded-correction"),
    newGraphHash: Hash,
    findingIds: z.array(SafeId).min(1),
    taskIds: z.array(TaskId).min(1),
    roundKind: z.enum(["repair", "convergence"]),
    round: z.number().int().positive(),
  })
  .strict();
export const AnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputHash: Hash,
    verdict: z.enum(["pass", "needs_revision", "inconclusive"]),
    findings: z
      .array(
        z
          .object({
            id: SafeId,
            kind: z.enum(["ambiguity", "inconsistency", "scope", "coverage"]),
            refs: z.array(z.string().min(1)).min(1),
            description: Text,
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const RefutationSchema = z
  .object({
    schemaVersion: z.literal(1),
    findingId: SafeId,
    decision: z.enum(["confirmed", "refuted", "inconclusive"]),
    evidenceIds: z.array(SafeId),
    explanation: Text,
  })
  .strict()
  .refine(
    (r) => r.decision === "inconclusive" || r.evidenceIds.length > 0,
    "A conclusion requires evidence",
  );
export const WorkflowConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    importsEnabled: z.boolean().default(false),
    defaultWorkflow: SafeId.default("sdd"),
    policy: PolicySchema,
  })
  .strict();
export const InputManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureId: SafeId,
    workflowHash: Hash,
    policyHash: Hash,
    profileHashes: z.record(SafeId, Hash),
    skillHashes: z.record(SafeId, Hash),
    instructionHashes: z.array(z.object({ source: z.string().min(1), hash: Hash }).strict()),
    constitutionHash: Hash.nullable(),
    specHash: Hash.nullable(),
    planHash: Hash.nullable(),
    rootGraphHash: Hash.nullable(),
    effectiveGraphHash: Hash.nullable(),
    correctionHashes: z.array(Hash),
    baselineSnapshotId: SafeId.nullable(),
    dependencyContracts: z.array(
      z.object({ featureId: SafeId, contractHash: Hash, artifactHash: Hash }).strict(),
    ),
  })
  .strict();

export const EventType = z.enum([
  "run.created",
  "run.state_changed",
  "stage.started",
  "stage.finished",
  "attempt.started",
  "attempt.finished",
  "task.state_changed",
  "artifact.committed",
  "check.finished",
  "finding.recorded",
  "criterion.assessed",
  "request.created",
  "request.decided",
  "effect.reconciled",
  "budget.updated",
  "snapshot.invalidated",
  "transition.taken",
  "gate.finished",
]);
const EventBase = {
  schemaVersion: z.literal(1),
  eventId: SafeId,
  runId: SafeId,
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
};
export const EventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...EventBase,
      type: z.literal("run.created"),
      payload: z.object({ featureId: SafeId, inputHash: Hash }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("run.state_changed"),
      payload: z
        .object({
          from: RunStatus,
          to: RunStatus,
          reason: ReasonCode,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("stage.started"),
      payload: z
        .object({ stepId: SafeId, stageId: SafeId, generation: z.number().int().nonnegative() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("stage.finished"),
      payload: z
        .object({ stepId: SafeId, status: StepStatus, artifactId: SafeId.nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("attempt.started"),
      payload: z
        .object({ attemptId: SafeId, stepId: SafeId, modelId: z.string().nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("attempt.finished"),
      payload: z
        .object({
          attemptId: SafeId,
          status: z.enum(["completed", "failed", "interrupted", "cancelled"]),
          usageComplete: z.boolean(),
          usedTokens: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("task.state_changed"),
      payload: z
        .object({
          taskId: TaskId,
          from: TaskStatus,
          to: TaskStatus,
          generation: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("artifact.committed"),
      payload: z.object({ artifactId: SafeId, kind: z.string(), hash: Hash }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("check.finished"),
      payload: z
        .object({
          checkId: SafeId,
          evidenceId: SafeId,
          status: z.enum(["passed", "failed", "inconclusive"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("finding.recorded"),
      payload: z.object({ findingId: SafeId, artifactId: SafeId }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("criterion.assessed"),
      payload: z
        .object({
          criterionId: CriterionId,
          snapshotId: SafeId,
          verdict: z.enum(["pass", "fail", "inconclusive", "deferred"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("request.created"),
      payload: z
        .object({
          requestId: SafeId,
          kind: z.enum(["approval", "clarification", "manual_evidence", "recovery", "checkpoint"]),
          digest: Hash,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("request.decided"),
      payload: z
        .object({
          requestId: SafeId,
          status: z.enum(["accepted", "rejected", "superseded"]),
          actor: z.enum(["user", "system-invalidation", "auto-approval"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("effect.reconciled"),
      payload: z
        .object({
          effectId: SafeId,
          status: z.enum(["applied", "unknown", "reconciled", "failed"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("budget.updated"),
      payload: z
        .object({
          usedTokens: z.number().int().nonnegative(),
          reservedTokens: z.number().int().nonnegative(),
          activeMs: z.number().int().nonnegative(),
          estimatedCostUsd: z.number().nonnegative().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("snapshot.invalidated"),
      payload: z
        .object({
          snapshotId: SafeId,
          reason: z.enum(["input_changed", "source_changed", "evidence_missing", "redacted"]),
        })
        .strict(),
    })
    .strict(),
  // Written only for runs of a schema 2 definition.
  z
    .object({
      ...EventBase,
      type: z.literal("transition.taken"),
      payload: z
        .object({
          transitionId: SafeId,
          from: SafeId,
          to: SafeId,
          outcome: z.enum(["passed", "changes_requested", "failed"]),
          contractHash: Hash.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("gate.finished"),
      payload: z
        .object({
          gateId: SafeId,
          transitionId: SafeId.nullable(),
          mode: z.enum(["required", "advisory"]),
          status: z.enum(["passed", "failed", "inconclusive", "skipped"]),
          attempts: z.number().int().nonnegative(),
          flaky: z.boolean(),
          evidenceId: SafeId.nullable(),
        })
        .strict(),
    })
    .strict(),
]);

export type Spec = z.infer<typeof SpecSchema>;
export type TaskGraph = z.infer<typeof TaskGraphSchema>;
export type InputManifest = z.infer<typeof InputManifestSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type RunPolicy = z.infer<typeof PolicySchema>;
export type AgentProfile = z.infer<typeof ProfileSchema>;
export type RunState = z.infer<typeof RunStatus>;
export type StageState = z.infer<typeof StepStatus>;
export type Reason = z.infer<typeof ReasonCode>;
export type Review = z.infer<typeof ReviewSchema>;

export interface RunSnapshot {
  runId: string;
  featureId: string;
  status: RunState;
  reason: Reason;
  revision: number;
  eventSeq: number;
  stageId: string | null;
  approvalDigest: string | null;
  inputHash: string;
  workspaceHash: string | null;
  tokenUsage: number;
  activeMs: number;
  estimatedCostUsd: number | null;
  verificationState: "not_verified" | "current" | "stale" | "invalid";
  pendingRequestIds: string[];
}
export type WorkflowEvent = z.infer<typeof EventSchema>;
export interface CommandIdentity {
  commandId: string;
  expectedRevision: number;
}
export interface StartRequest {
  commandId: string;
  workflowId: string;
  featureId: string;
  prompt: string;
  policy: RunPolicy;
  ownerLabel: string;
  /** Model selected for this run; resolved profile models are frozen at start. */
  model?: string;
}
export type Decision =
  | { requestId: string; kind: "approve"; digest: string }
  | { requestId: string; kind: "reject"; explanation: string }
  | { requestId: string; kind: "continue" }
  | { requestId: string; kind: "answer"; answers: Record<string, string> }
  | {
      requestId: string;
      kind: "manual-evidence";
      criterionId: string;
      evidence: string;
      accepted: boolean;
    }
  | {
      requestId: string;
      kind: "recovery";
      effectId: string;
      resolution: "record-applied" | "record-not-applied" | "retry" | "cancel";
      evidence: string;
    };
export const DecisionSchema: z.ZodType<Decision> = z.discriminatedUnion("kind", [
  z.object({ requestId: SafeId, kind: z.literal("approve"), digest: Hash }).strict(),
  z.object({ requestId: SafeId, kind: z.literal("reject"), explanation: Text }).strict(),
  z.object({ requestId: SafeId, kind: z.literal("continue") }).strict(),
  z
    .object({
      requestId: SafeId,
      kind: z.literal("answer"),
      answers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      requestId: SafeId,
      kind: z.literal("manual-evidence"),
      criterionId: CriterionId,
      evidence: Text,
      accepted: z.boolean(),
    })
    .strict(),
  z
    .object({
      requestId: SafeId,
      kind: z.literal("recovery"),
      effectId: SafeId,
      resolution: z.enum(["record-applied", "record-not-applied", "retry", "cancel"]),
      evidence: Text,
    })
    .strict(),
]);
export interface WorkflowService {
  start(request: StartRequest): Promise<RunSnapshot>;
  get(runId: string): Promise<RunSnapshot>;
  list(opts: {
    featureId?: string;
    status?: RunState;
    limit: number;
    cursor?: string;
  }): Promise<{ items: RunSnapshot[]; cursor?: string }>;
  drive(runId: string, signal: AbortSignal): Promise<RunSnapshot>;
  pause(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  cancel(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  resume(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  decide(runId: string, command: CommandIdentity, decision: Decision): Promise<RunSnapshot>;
  revise(runId: string, command: CommandIdentity, candidateHash: string): Promise<RunSnapshot>;
  fork(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  /** Restores the files the run's uncommitted task edits changed, where nobody changed them since. */
  undo(runId: string, command: CommandIdentity, paths?: string[]): Promise<RunSnapshot>;
  /** Raises the token/call/time limits of a run that stopped on its budget; the run stays paused. */
  extendBudget(
    runId: string,
    command: CommandIdentity,
    limits?: Partial<import("./budget.js").BudgetLimits>,
  ): Promise<RunSnapshot>;
  events(runId: string, afterSeq: number, signal: AbortSignal): AsyncIterable<WorkflowEvent>;
}

export type WorkflowErrorCode =
  | "INVALID_DEFINITION"
  | "INVALID_REFERENCE"
  | "CYCLE_DETECTED"
  | "VERSION_UNSUPPORTED"
  | "REVISION_CONFLICT"
  | "COMMAND_CONFLICT"
  | "STALE_DECISION"
  | "WORKSPACE_BUSY"
  | "INPUT_CHANGED"
  | "CAPABILITY_DENIED"
  | "OUTPUT_INVALID"
  | "BUDGET_EXHAUSTED"
  | "CHECKPOINT_REACHED"
  | "STORAGE_CORRUPT"
  | "ARTIFACT_MISSING"
  | "RECOVERY_REQUIRED"
  | "RUN_TERMINAL"
  | "NOT_FOUND";
export interface WorkflowError {
  code: WorkflowErrorCode;
  message: string;
  runId?: string;
  retryable: boolean;
  details: Record<string, unknown>;
}
export interface ArtifactService {
  read(runId: string, artifactId: string): Promise<{ content: Uint8Array; hash: string }>;
  importCandidate(request: {
    commandId: string;
    source: "spec-kit" | "ecc" | "markdown-edit";
    sourcePath: string;
    featureId: string;
  }): Promise<{ candidateHash: string; warnings: string[]; unsupported: string[] }>;
  stageRevision(
    runId: string,
    request: {
      commandId: string;
      expectedInputHash: string;
      spec?: Spec;
      plan?: string;
      graph?: TaskGraph;
      policy?: RunPolicy;
    },
  ): Promise<{ candidateHash: string; reportArtifactId: string }>;
  exportRun(runId: string, destination: string): Promise<{ manifestHash: string; path: string }>;
  exportProgress(runId: string): Promise<{ path: string }>;
  gc(request: { before: string; dryRun: boolean }): Promise<{ runIds: string[]; bytes: number }>;
  redact(runId: string, artifactId: string, reason: string): Promise<void>;
}

/** Semantic validation supplements schema validation. Runtime must also validate paths against realpath. */
export function validateTaskGraph(spec: Spec, graph: TaskGraph): string[] {
  const errors: string[] = [];
  if (spec.featureId !== graph.featureId) errors.push("feature mismatch");
  const requirements = new Set(spec.requirements.map((r) => r.id));
  const criteria = new Set(spec.criteria.map((c) => c.id));
  if (requirements.size !== spec.requirements.length || criteria.size !== spec.criteria.length)
    errors.push("duplicate spec ID");
  for (const c of spec.criteria)
    for (const id of c.requirementIds)
      if (!requirements.has(id)) errors.push(`unknown requirement ${id}`);
  for (const r of spec.requirements) {
    const linked = spec.criteria.filter((c) => c.requirementIds.includes(r.id));
    if (linked.length === 0) errors.push(`requirement without criterion ${r.id}`);
    if (r.verification !== "post-release" && linked.every((c) => c.method === "post-release"))
      errors.push(`engineering requirement deferred ${r.id}`);
  }
  const tasks = new Map(graph.tasks.map((t) => [t.id, t]));
  if (tasks.size !== graph.tasks.length) errors.push("duplicate task ID");
  for (const task of graph.tasks) {
    for (const id of task.requirementIds)
      if (!requirements.has(id)) errors.push(`unknown requirement ${id}`);
    for (const id of task.criterionIds)
      if (!criteria.has(id)) errors.push(`unknown criterion ${id}`);
    for (const id of task.criterionIds) {
      const criterion = spec.criteria.find((c) => c.id === id);
      if (criterion && !criterion.requirementIds.some((r) => task.requirementIds.includes(r)))
        errors.push(
          `criterion mapping mismatch ${task.id}/${id}: ${id} verifies ${criterion.requirementIds.join(", ")}, but ${task.id} lists ${task.requirementIds.join(", ") || "no requirements"}`,
        );
    }
    for (const id of task.dependsOn) if (!tasks.has(id)) errors.push(`unknown dependency ${id}`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      errors.push(`duplicate dependency ${task.id}`);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) {
      errors.push(`cycle at ${id}`);
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of tasks.get(id)?.dependsOn ?? []) visit(dep);
    active.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  for (const criterion of spec.criteria) {
    if (
      criterion.method !== "post-release" &&
      !graph.tasks.some((t) => t.criterionIds.includes(criterion.id))
    )
      errors.push(`uncovered criterion ${criterion.id}`);
  }
  return errors;
}

export function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const ids = new Set(workflow.stages.map((s) => s.id));
  if (ids.size !== workflow.stages.length) errors.push("duplicate stage ID");
  const kinds = workflow.stages.map((s) => s.kind);
  const required = [
    "research",
    "specify",
    "plan",
    "analyze",
    "approve",
    "task-graph",
    "checks",
    "review",
    "converge",
  ] as const;
  let previous = -1;
  for (const kind of required) {
    const index = kinds.indexOf(kind);
    if (index <= previous || index < 0 || kinds.lastIndexOf(kind) !== index)
      errors.push(`missing, repeated or unordered ${kind}`);
    previous = index;
  }
  if (
    kinds.filter((k) => k === "learn").length > 1 ||
    (kinds.includes("learn") && kinds.at(-1) !== "learn")
  )
    errors.push("learn must be last");
  for (const stage of workflow.stages) {
    if (/^(task|dimension|skeptic)-/.test(stage.id)) errors.push(`reserved stage ID ${stage.id}`);
    const agentStage = ["research", "specify", "plan", "analyze", "review", "converge"].includes(
      stage.kind,
    );
    if (agentStage !== Boolean(stage.profileId)) errors.push(`invalid profile binding ${stage.id}`);
    if (stage.kind === "checks" || stage.kind === "review" || stage.kind === "converge") {
      if (
        !stage.repairTo ||
        workflow.stages.find((s) => s.id === stage.repairTo)?.kind !== "task-graph"
      )
        errors.push(`invalid repair target ${stage.id}`);
    } else if (stage.repairTo !== undefined) errors.push(`unexpected repair target ${stage.id}`);
  }
  return errors;
}
