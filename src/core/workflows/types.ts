import { z } from "zod";
import {
  type AgentProfile,
  Hash,
  InputManifestSchema,
  ReviewSchema,
  SafeId,
  SpecSchema,
  TaskGraphSchema,
} from "./schemas.js";

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
    verificationState: z.enum(["not_verified", "current", "stale", "invalid"]),
    instructionText: z.string(),
    frozenFiles: z.record(z.string(), z.string()),
    repairPredecessors: z.record(z.string(), z.string()).default({}),
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
  })
  .strict();
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type Task = z.infer<typeof import("./schemas.js").TaskSchema>;
export type Check = z.infer<typeof import("./schemas.js").CheckSchema>;
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
  /**
   * Semantic checks on a submitted result. Errors are returned to the agent so it can resubmit
   * a corrected result in the same conversation, a bounded number of times.
   */
  validate?: (output: unknown) => string[];
  /** Directory the agent reads, edits and checks in; defaults to the run's workspace. */
  root?: string;
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
