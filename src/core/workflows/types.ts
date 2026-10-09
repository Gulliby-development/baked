import { z } from "zod";
import {
  type AgentProfile,
  InputManifestSchema,
  ReviewSchema,
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
