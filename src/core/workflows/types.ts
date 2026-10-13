import { z } from "zod";
import type { RouteEffort } from "../llm/model-routing.js";
import {
  type AgentProfile,
  Hash,
  InputManifestSchema,
  ReviewSchema,
  SafeId,
  SpecSchema,
  TaskGraphSchema,
} from "./schemas.js";

/** The GitHub issue a run was started from (`workflow run --issue`); its delivery closes it. */
export const IssueSourceSchema = z
  .object({
    /** `owner/name` on the configured GitHub host. */
    repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    number: z.number().int().positive(),
    url: z.string(),
    title: z.string(),
  })
  .strict();
export type IssueSource = z.infer<typeof IssueSourceSchema>;

export const WorktreeStateSchema = z
  .object({
    /** Path relative to the project root, `.baked/worktrees/RUN_ID/main`. */
    path: z.string().min(1),
    branch: z.string().min(1),
    /** The baseline HEAD the branch was created from. */
    baseHead: z.string().regex(/^[0-9a-f]{40,64}$/),
    /** The commit of the accepted changes on the branch, recorded at acceptance. */
    commit: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
    /** Uncommitted user changes inside the approved scope the user chose to leave out. */
    excludedUserChanges: z.array(z.string()),
  })
  .strict();
export type WorktreeState = z.infer<typeof WorktreeStateSchema>;
/**
 * A finding the run was accepted with: convergence stopped with it open and the user (or the
 * `assume` rule) decided it does not block acceptance. The run report lists them.
 */
export const LimitationSchema = z
  .object({
    findingId: z.string(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    kind: z.string(),
    criterionIds: z.array(z.string()),
    file: z.string().nullable(),
    symbol: z.string().nullable(),
    claim: z.string(),
    impact: z.string(),
    /**
     * Who accepted it: a person, the `assume` rule when the checks passed, or the notes rule (a
     * low `partial` finding behind verified behavior, accepted without a decision).
     */
    decidedBy: z.enum(["user", "assume", "notes"]),
    /** Convergence rounds the run had used when the finding was accepted. */
    round: z.number().int().nonnegative(),
  })
  .strict();
export type Limitation = z.infer<typeof LimitationSchema>;
export const RuntimeStateSchema = z
  .object({
    prompt: z.string(),
    ownerLabel: z.string(),
    stageIndex: z.number().int().nonnegative(),
    manifest: InputManifestSchema,
    spec: SpecSchema.nullable(),
    plan: z.string().nullable(),
    graph: TaskGraphSchema.nullable(),
    rootGraph: TaskGraphSchema.nullable(),
    research: z.string().nullable(),
    analysisPassed: z.boolean(),
    snapshotId: z.string().nullable(),
    workspaceHash: z.string().nullable(),
    expectedFiles: z.record(z.string(), z.string()).nullable(),
    reviews: z.record(z.string(), ReviewSchema),
    /**
     * Criteria a required reviewer could not establish after its one re-prompt, by reviewer key:
     * the converge stage gets them as evidence gaps and settles them with a test or a check.
     */
    reviewGaps: z
      .record(z.string(), z.array(z.object({ criterionId: z.string(), explanation: z.string() })))
      .default({}),
    convergence: ReviewSchema.nullable(),
    approvalRoot: z.string().nullable(),
    correctionHashes: z.array(z.string()),
    published: z.record(z.string(), z.string()),
    manualCriteria: z.record(
      z.string(),
      z.object({ evidenceId: z.string(), snapshotId: z.string() }),
    ),
    deferredCriteria: z.array(z.string()),
    previousFindingSet: z.string().nullable(),
    noProgressRounds: z.number().int(),
    /** Convergence rounds a person allowed beyond `maxConvergenceRounds` ("one more round"). */
    extraConvergenceRounds: z.number().int().nonnegative().default(0),
    /** Corrective tasks a person allowed beyond `maxCorrectiveTasks` with that decision. */
    extraCorrectiveTasks: z.number().int().nonnegative().default(0),
    /** Rounds the `assume` rule granted by itself after a contradiction stop (at most one). */
    autoExtensions: z.number().int().nonnegative().default(0),
    /** Findings a person already decided to repair; the convergence stop does not ask again. */
    decidedFindings: z.array(z.string()).default([]),
    /** Findings the run is accepted with (known limitations). */
    limitations: z.array(LimitationSchema).default([]),
    verificationState: z.enum(["not_verified", "current", "stale", "invalid"]),
    instructionText: z.string(),
    frozenFiles: z.record(z.string(), z.string()),
    repairPredecessors: z.record(z.string(), z.string()).default({}),
    /**
     * Planned files a failed task check named outside the failing task's own writes, by finding ID:
     * the correction of that finding may also write them, through the tasks that own them.
     */
    repairScope: z.record(z.string(), z.array(z.string())).default({}),
    /** Attempt token cap per planned task, set by plan-time sizing; corrections use their base's. */
    taskBudgets: z.record(z.string(), z.number().int().positive()).default({}),
    /** Step cap per planned task from plan-time sizing (test tasks); corrections use their base's. */
    taskSteps: z.record(z.string(), z.number().int().positive()).default({}),
    /** The request as the user wrote it; `prompt` grows with host notes and clarifications. */
    requestText: z.string().default(""),
    /** Whether the request-coverage finding was raised; it is raised once per run. */
    coverageRaised: z.boolean().default(false),
    /** Tasks the host added by splitting oversized test tasks; they do not count against the auto-approval task limit. */
    hostSplitTasks: z.number().int().nonnegative().default(0),
    /**
     * Planned tasks whose task check failed only on files that tasks still to run own, by the
     * owners they wait for. The check runs again once the owners are done; no repair starts.
     */
    deferredChecks: z.record(z.string(), z.array(z.string())).default({}),
    /** Times plan-time sizing sent the plan back to be split; it does so once. */
    sizingReplans: z.number().int().nonnegative().default(0),
    /**
     * Continuations per task: an attempt that stopped at its step or token cap after editing
     * files gets one more with caps raised by half instead of blocking the run.
     */
    taskContinuations: z.record(z.string(), z.number().int().nonnegative()).default({}),
    /**
     * Automatic restarts per task: a batch task whose worker was lost runs once more before the
     * run blocks with `owner_lost`.
     */
    taskRestarts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    /** Times a run blocked with `owner_lost` was resumed without a person (`clarification: assume`). */
    ownerLostResumes: z.number().int().nonnegative().default(0),
    /** Times a run blocked with `step_stalled` resumed by itself (`workflows.stall.autoResumes`). */
    stallResumes: z.number().int().nonnegative().default(0),
    /** Times a run blocked with `provider_unavailable` resumed by itself after a provider outage. */
    providerResumes: z.number().int().nonnegative().default(0),
    /**
     * Edits a batch task's attempt left in its worktree when it continues at its cap or restarts after a lost worker, by task and
     * path: the hash before and after (null for absent). The worktree is removed, so the next
     * attempt gets them applied to its new worktree.
     */
    taskCarry: z
      .record(
        z.string(),
        z.record(
          z.string(),
          z.object({ before: z.string().nullable(), after: z.string().nullable() }),
        ),
      )
      .default({}),
    /** Times analyze sent plan-only findings back to the planner instead of a person; once. */
    analysisReplans: z.number().int().nonnegative().default(0),
    taskGates: z
      .record(
        z.string(),
        z.object({
          generation: z.number().int().nonnegative(),
          snapshotId: z.string(),
          definitionHash: z.string(),
          evidenceIds: z.array(z.string()),
        }),
      )
      .default({}),
    /** Where a run of a schema 2 definition stands; null for a run of a v1 definition. */
    position: z
      .object({
        /** The current stage, or `done` once the last transition was taken. */
        stageId: z.string(),
        visits: z.record(z.string(), z.number().int().nonnegative()),
        loops: z.record(z.string(), z.number().int().nonnegative()),
        /** Stage visits in the whole run, bounded by `limits.maxStageVisits`. */
        total: z.number().int().nonnegative(),
        /**
         * The outcome of the current visit once it is decided. The transition is taken from it, so
         * a run that waits on a transition gate or an approval resumes there without repeating the
         * stage.
         */
        outcome: z.enum(["passed", "changes_requested", "failed"]).nullable(),
        /** Findings of the decided outcome; they become corrective tasks when the target writes. */
        findings: z.array(z.string()),
        repairKind: z.enum(["repair", "convergence"]).nullable(),
        /** The deadline of the current wait stage visit (epoch ms); a resumed visit keeps it. */
        wait: z
          .object({
            stageId: z.string(),
            visit: z.number().int().nonnegative(),
            startedAt: z.number().int(),
            deadlineAt: z.number().int(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .nullable()
      .default(null),
    /** Canonical report of a report stage. */
    report: z.string().nullable().default(null),
    /** Canonical split proposed by a decompose stage. */
    initiativePlan: z.string().nullable().default(null),
    /**
     * Upstream contracts the host pins for a feature of an initiative. When set, they replace the
     * dependencies the spec author returns, so readiness is decided by the initiative and not by
     * model output. Null for a run outside an initiative.
     */
    hostDependencies: z
      .array(z.object({ featureId: SafeId, contractHash: Hash }).strict())
      .nullable()
      .default(null),
    /** The frozen diff a review-only run reviews. */
    diff: z
      .object({ artifactId: z.string(), hash: z.string(), files: z.array(z.string()) })
      .strict()
      .nullable()
      .default(null),
    /**
     * The project working set rendered at run creation (artifact `project/working-set.md`);
     * the agents that start the run read it. Null without a project or working set.
     */
    workingSet: z
      .object({ artifactId: z.string(), hash: z.string(), files: z.array(z.string()) })
      .strict()
      .nullable()
      .default(null),
    /**
     * Project memory rendered at run creation (artifact `project/run-memory.md`): what earlier runs
     * of the workspace learned. Research, specification and planning read it. Null when empty.
     */
    projectMemory: z
      .object({ artifactId: z.string(), hash: z.string() })
      .strict()
      .nullable()
      .default(null),
    /**
     * The run's own Git worktree once it exists (worktree execution mode). From then on the run
     * reads, edits, checks and snapshots there; the project working copy is never written.
     */
    worktree: WorktreeStateSchema.nullable().default(null),
    /** Latest result per gate of a schema 2 definition. */
    gateResults: z
      .record(
        z.string(),
        z.object({
          status: z.enum(["passed", "failed", "inconclusive", "skipped"]),
          mode: z.enum(["required", "advisory"]),
          snapshotId: z.string().nullable(),
          evidenceId: z.string().nullable(),
          attempts: z.number().int().nonnegative(),
          flaky: z.boolean(),
        }),
      )
      .default({}),
    /** Lifecycle of each AI acceptance gate of a schema 2 definition, by gate ID. */
    acceptance: z
      .record(
        z.string(),
        z
          .object({
            phase: z.enum([
              "awaiting_approval",
              "promoted",
              "discarded",
              "inconclusive",
              "unstable",
              "skipped",
            ]),
            /** The snapshot the walk-through ran on; a new snapshot walks again. */
            snapshotId: z.string().nullable(),
            /** The attempt of the walk-through model; its steps are under acceptance/GATE/ATTEMPT/. */
            attemptId: z.string().nullable(),
            verdict: z.enum(["passed", "failed", "inconclusive"]).nullable(),
            reason: z.string().nullable(),
            evidenceId: z.string().nullable(),
            requestId: z.string().nullable(),
            /** The verified test, kept as an artifact until a person decides. */
            testArtifactId: z.string().nullable(),
            testHash: z.string().nullable(),
            /** The hash at the test path in the workspace when the walk-through started. */
            baseTestHash: z.string().nullable(),
            rewrites: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .default({}),
    issue: IssueSourceSchema.nullable().default(null),
  })
  .strict();
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type Task = z.infer<typeof import("./schemas.js").TaskSchema>;
export type Check = z.infer<typeof import("./schemas.js").CheckSchema>;
/**
 * A tool the host offers for one attempt, instead of the tool registry. The AI acceptance gate
 * gives its walk-through model only such tools.
 */
export interface HostTool {
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}
export interface ExecutionRequest {
  runId: string;
  attemptId: string;
  profile: AgentProfile;
  prompt: string;
  task?: Task;
  signal: AbortSignal;
  maxSteps: number;
  /** Token cap for this attempt when the stage sets one below the policy cap. */
  maxTokens?: number;
  /** A sized task's attempt cap; replaces the policy cap, which may be smaller. */
  attemptTokens?: number;
  /**
   * Semantic checks on a submitted result. Errors are returned to the agent so it can resubmit
   * a corrected result in the same conversation, a bounded number of times.
   */
  validate?: (output: unknown) => string[];
  /** Directory the agent reads, edits and checks in; defaults to the run's workspace. */
  root?: string;
  /**
   * When set, the attempt gets exactly these tools (filtered by the profile) and the result tool,
   * and no tool of the registry.
   */
  hostTools?: Record<string, HostTool>;
  /**
   * Facts the host knows that the one-step format correction needs, because that step sees only
   * the previous text: the snapshot hash and the evidence ids a result may cite.
   */
  formatHints?: string;
  /** Reasoning effort from the attempt's model route; unset keeps the configured default. */
  effort?: RouteEffort;
}
export interface ExecutionResponse {
  output: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface AgentExecutor {
  execute(request: ExecutionRequest): Promise<ExecutionResponse>;
  dispose?(): void;
}
export interface Snapshot {
  id: string;
  hash: string;
  files: Record<string, string>;
}
