import type { RunList, RunSnapshot, RunState } from "../../shared/api.js";
import { ApiError, call } from "./api.js";
import type { WorkflowLine } from "./start.js";
import { type RunStatus, workflow } from "./workflow.js";

/**
 * Read access to workflow runs for the run screens: the run list, a run's artifacts, usage and
 * event log, and the workflow definitions. Shapes mirror `src/core/workflows/` and
 * `src/headless/workflow.ts`; only the fields the screens read are declared.
 */

/** `GET .../checks` (`src/core/workflows/follow.ts`). */
export interface PullRequestChecks {
  runId: string;
  branch: string;
  commit: string;
  pullRequest: { number: number; url: string } | null;
  state: "none" | "pending" | "passed" | "failed";
  checks: {
    name: string;
    state: "pending" | "passed" | "failed";
    detail: string;
    url: string | null;
  }[];
  /** With failed checks: the fix-ci run to start; deliver it as a follow-up of this run. */
  fix?: { workflowId: string; featureId: string; prompt: string; followUp: string };
  /** With `reviews`: the unresolved review threads and requested changes of the pull request. */
  reviews?: {
    state: "clear" | "changes";
    threads: {
      id: string;
      outdated: boolean;
      path: string;
      line: number | null;
      comments: { author: string; body: string; url: string }[];
    }[];
    changesRequested: { author: string; body: string; url: string }[];
  };
  /** With review changes asked for: the quick-fix run to start and the threads its delivery answers. */
  repair?: {
    workflowId: string;
    featureId: string;
    prompt: string;
    followUp: string;
    threads: string[];
  };
}

export interface RunRow extends RunSnapshot {
  reason?: string;
}

export interface RunRequest {
  id: string;
  kind: string;
  status: string;
  digest: string;
  body_json: string | null;
}

export interface RunDetailStatus extends Omit<RunStatus, "requests"> {
  reason?: string;
  requests: RunRequest[];
  /**
   * The run's worktree (`worktreeView` in src/core/workflows/worktree.ts); `present` is false once
   * delivery or a discard removed it. Null for runs in the working copy; absent from older backends.
   */
  worktree?: RunWorktree | null;
  /**
   * The effective models of the run by role and stage (`routingSummary` in
   * src/core/workflows/routing.ts). Null before routing was recorded; absent from older backends.
   */
  routing?: RunRouting | null;
  /**
   * The stages after the implementation a fork can start at (`forkStages` in
   * src/core/workflows/fork-stage.ts); absent from older backends.
   */
  forkStages?: string[];
}

export interface RunRouting {
  runModel: string;
  /** The run model overrode the configured routes (`--model-strict`). */
  strict: boolean;
  warnings: string[];
  effective: { target: string; model: string; source: string; fallback?: string[] }[];
}

export interface RunWorktree {
  path: string;
  branch: string;
  present: boolean;
}

/** The outcomes `baked workflow recover` records for an effect of unknown outcome. */
export type RecoveryResolution = "record-applied" | "record-not-applied" | "retry" | "cancel";

/** One entry of `GET /v1/workflow/runs/:id/artifacts`. */
export interface ArtifactEntry {
  id: string;
  kind: string;
  path: string;
  revision: number;
  hash: string;
  bytes: number;
}

/** `GET /v1/workflow/runs/:id/usage` (`runUsage` in src/core/workflows/usage.ts). */
export interface RunUsage {
  totalTokens: number;
  stages: { stage: string; attempts: number; tokens: number }[];
  models: { model: string; attempts: number; tokens: number }[];
  attempts: { attemptId: string; stage: string; model: string | null; status: string }[];
}

export interface DefinitionSummary {
  id: string;
  stages: string[];
  line?: WorkflowLine;
}

/** A durable workflow event (`EventSchema`), payload by event type. */
export interface EventPayloads {
  "run.created": { featureId: string };
  "run.state_changed": { from: RunState; to: RunState; reason: string; revision: number };
  "stage.started": { stepId: string; stageId: string; generation: number };
  "stage.finished": { stepId: string; status: string; artifactId: string | null };
  "attempt.started": { attemptId: string; stepId: string; modelId: string | null };
  "attempt.finished": {
    attemptId: string;
    status: string;
    usageComplete: boolean;
    usedTokens: number | null;
    /** `usedTokens` is estimated because the provider reported no usage. */
    usageEstimated?: true;
    /** Why a failed attempt failed. */
    error?: { code: string; message: string };
  };
  "attempt.advisory": {
    attemptId: string;
    signal: "repeated-reads" | "no-edits" | "same-failure" | "no-edit-tool";
    action: "steered" | "stopped";
    detail: string;
  };
  /** A stop reason in shadow or advisory mode would have stopped the run (#1714). */
  "decision.would_stop": {
    reason: string;
    mode: "shadow" | "advisory";
    key: string;
    summary: string;
    inputs: Record<string, unknown>;
  };
  "task.state_changed": {
    taskId: string;
    from: string;
    to: string;
    generation: number;
    /** Why the task was interrupted (restart, continue_at_cap, worker_lost, ...). */
    cause?: string;
    detail?: string;
    /** The next attempt starts from this attempt's edits. */
    carried?: true;
  };
  "artifact.committed": { artifactId: string; kind: string; hash: string };
  "check.finished": { checkId: string; evidenceId: string; status: string };
  "finding.recorded": { findingId: string; artifactId: string };
  "criterion.assessed": { criterionId: string; snapshotId: string; verdict: string };
  "request.created": { requestId: string; kind: string; digest: string };
  "request.decided": { requestId: string; status: string; actor: string };
  "effect.reconciled": { effectId: string; status: string };
  "run.rerouted": {
    artifactId: string;
    runModel: { from: string; to: string };
    changes: { target: string; from: string; to: string }[];
  };
  "budget.updated": {
    usedTokens: number;
    reservedTokens: number;
    activeMs: number;
    estimatedCostUsd: number | null;
  };
  "snapshot.invalidated": { snapshotId: string; reason: string };
  "transition.taken": { transitionId: string; from: string; to: string; outcome: string };
  "gate.finished": {
    gateId: string;
    mode: string;
    status: string;
    attempts: number;
    flaky: boolean;
    evidenceId: string | null;
  };
  "acceptance.phase": { gateId: string; phase: string; detail: string | null };
  "wait.progress": {
    stageId: string;
    deadline: string;
    intervalSeconds: number;
    pending: string[];
    polls: number;
  };
  "tool.started": { attemptId: string; tool: string };
  "tool.phase": { attemptId: string; tool: string; phase: string };
  "tool.finished": {
    attemptId: string;
    tool: string;
    status: "ok" | "error" | "deadline";
    durationMs: number;
  };
}
export type EventType = keyof EventPayloads;
export type WorkflowEvent = {
  [K in EventType]: { seq: number; at: string; runId: string; type: K; payload: EventPayloads[K] };
}[EventType];

const runPath = (runId: string, action?: string): string =>
  `/v1/workflow/runs/${encodeURIComponent(runId)}${action ? `/${action}` : ""}`;

const EVENT_PAGE = 1000;
/** A run's event log is read in pages; a log longer than this keeps only its latest part. */
const MAX_EVENTS = 20_000;

export const runs = {
  list: (key: string, query: { limit?: number; status?: string; cursor?: string } = {}) => {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.status) params.set("status", query.status);
    if (query.cursor) params.set("cursor", query.cursor);
    return call<RunList & { items: RunRow[] }>(key, "GET", `/v1/workflow/runs?${params}`);
  },
  status: (key: string, runId: string) => call<RunDetailStatus>(key, "GET", runPath(runId)),
  artifacts: (key: string, runId: string) =>
    call<ArtifactEntry[]>(key, "GET", runPath(runId, "artifacts")),
  readArtifact: async (key: string, runId: string, artifactId: string): Promise<string> =>
    (
      await call<{ content: string }>(
        key,
        "GET",
        `${runPath(runId, "artifacts")}?file=${encodeURIComponent(artifactId)}`,
      )
    ).content,
  usage: (key: string, runId: string) => call<RunUsage>(key, "GET", runPath(runId, "usage")),
  /** `GET /v1/workflow/runs/:id/report`: the run report in Markdown (src/core/workflows/run-report.ts). */
  /** One read of the checks on the commit the run's latest delivery pushed (`follow --once`). */
  checks: (key: string, runId: string, reviews = false) =>
    call<PullRequestChecks>(
      key,
      "GET",
      `${runPath(runId, "checks")}${reviews ? "?reviews=true" : ""}`,
    ),
  report: async (key: string, runId: string): Promise<string> =>
    (await call<{ runId: string; markdown: string }>(key, "GET", runPath(runId, "report")))
      .markdown,
  eventsPage: (key: string, runId: string, after: number, limit = EVENT_PAGE) =>
    call<{ events: WorkflowEvent[]; lastSeq: number }>(
      key,
      "GET",
      `${runPath(runId, "events")}?after=${after}&limit=${limit}`,
    ),
  /** Every event after `after`, page by page. */
  events: async (key: string, runId: string, after = 0): Promise<WorkflowEvent[]> => {
    const all: WorkflowEvent[] = [];
    let seq = after;
    for (;;) {
      const page = await runs.eventsPage(key, runId, seq);
      all.push(...page.events);
      if (page.events.length < EVENT_PAGE || page.lastSeq <= seq) break;
      seq = page.lastSeq;
      if (all.length > MAX_EVENTS) all.splice(0, all.length - MAX_EVENTS);
    }
    return all;
  },
  eventsPath: (runId: string) => runPath(runId, "events"),
  definitions: (key: string) => call<DefinitionSummary[]>(key, "GET", "/v1/workflow/definitions"),
  capabilities: async (key: string): Promise<string[]> =>
    (await call<{ capabilities?: string[] }>(key, "GET", "/v1/health")).capabilities ?? [],
  /** Manual evidence for an acceptance criterion (API group B, capability `setup`). */
  evidence: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    requestId: string,
    evidence: string,
    accepted: boolean,
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "evidence"), {
      commandId: crypto.randomUUID(),
      expectedRevision: run.revision,
      requestId,
      evidence,
      accepted,
    }),
  /** Settles an interrupted effect (API group B, capability `setup`). */
  recover: (
    key: string,
    run: Pick<RunSnapshot, "runId" | "revision">,
    decision: {
      requestId: string;
      effectId: string;
      resolution: RecoveryResolution;
      evidence: string;
    },
  ) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "recover"), {
      commandId: crypto.randomUUID(),
      expectedRevision: run.revision,
      ...decision,
    }),
  /**
   * A new run from this one's spec and plan; it waits for a new approval. With `fromStage` it
   * starts at that stage with this run's approval and changes instead. Returns the new run.
   */
  fork: (key: string, run: Pick<RunSnapshot, "runId" | "revision">, fromStage?: string) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "fork"), {
      commandId: crypto.randomUUID(),
      expectedRevision: run.revision,
      ...(fromStage ? { fromStage } : {}),
    }),
  /** Removes an ended run's worktree and deletes its branch. */
  discardWorktree: (key: string, run: Pick<RunSnapshot, "runId" | "revision">) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "discard-worktree"), {
      commandId: crypto.randomUUID(),
      expectedRevision: run.revision,
    }),
  /**
   * Accepts the findings of a stopped convergence as known limitations (API group B, capability
   * `setup`); the run then goes on to acceptance.
   */
  accept: (key: string, run: Pick<RunSnapshot, "runId" | "revision">, requestId: string) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "accept"), {
      commandId: crypto.randomUUID(),
      expectedRevision: run.revision,
      requestId,
    }),
  /**
   * Continues a run past a soft checkpoint, or allows one more repair round on a stopped
   * convergence (API group B, capability `setup`).
   */
  continue: (key: string, run: Pick<RunSnapshot, "runId" | "revision">, requestId: string) =>
    call<RunSnapshot>(key, "POST", runPath(run.runId, "continue"), {
      commandId: crypto.randomUUID(),
      expectedRevision: run.revision,
      requestId,
    }),
};

/**
 * Approves a pending request with the request's own digest; the run's `approvalDigest` is null
 * until something was approved. The only caller of `workflow.approve` in the run screens, so the
 * shared signature `approve(key, run, {id, digest}, excludeUserChanges?)` lands in one place.
 */
export const approveRequest = (
  key: string,
  run: Pick<RunSnapshot, "runId" | "revision">,
  request: { id: string; digest: string },
  excludeUserChanges = false,
) =>
  workflow.approve(key, { ...run, approvalDigest: request.digest }, request.id, excludeUserChanges);

/** `POST /v1/workflow/gc`: the ended runs a cleanup removes, or removed, and their artifact bytes. */
export interface GcResult {
  runIds: string[];
  bytes: number;
}

/** One run's directory under `.baked/worktrees` (`GET /v1/workflow/worktrees`). */
export interface RunWorktreeUsage {
  runId: string;
  path: string;
  bytes: number;
  worktrees: { name: string; bytes: number }[];
  status: string;
  featureId: string | null;
  removable: boolean;
  kept?: string;
}

export interface WorktreeReport {
  worktrees: RunWorktreeUsage[];
  bytes: number;
  trashBytes: number;
}

/** `POST /v1/workflow/worktrees/clean`: the runs whose worktrees a cleanup removes, or removed. */
export interface WorktreeCleanup {
  runIds: string[];
  bytes: number;
  dryRun: boolean;
  warnings: string[];
}

/** Worktree sizes and cleanup (`worktrees` capability). */
export const WORKTREES_CAPABILITY = "worktrees";

/** `POST /v1/workflow/import`: a candidate under `.baked/workflow-imports/HASH`. */
export interface ImportResult {
  candidateHash: string;
  warnings: string[];
  unsupported: string[];
}

export type ImportSource = "spec-kit" | "ecc" | "markdown-edit";

/** Export, redact, cleanup and import of runs (`run-maintenance` capability). */
export const RUN_MAINTENANCE_CAPABILITY = "run-maintenance";

export const runMaintenance = {
  /** Writes `manifest.json` into a new directory under `.baked/exports/`; returns where. */
  exportRun: (key: string, runId: string) =>
    call<{ path: string; manifestHash: string }>(key, "POST", runPath(runId, "export"), {}),
  /** Replaces an artifact's content with a tombstone and invalidates evidence built on it. */
  redact: (key: string, runId: string, artifactId: string, reason: string) =>
    call<{ redacted: true }>(key, "POST", runPath(runId, "redact"), { artifactId, reason }),
  /** Ended runs older than 30 days and `before`; `dryRun` only lists them. */
  gc: (key: string, before: string, dryRun: boolean) =>
    call<GcResult>(key, "POST", "/v1/workflow/gc", { before, dryRun }),
  /** Run and task worktrees on disk, largest first. */
  worktrees: (key: string) => call<WorktreeReport>(key, "GET", "/v1/workflow/worktrees"),
  /** Removes the worktrees of ended and unknown runs; branches stay. */
  cleanWorktrees: (key: string, dryRun: boolean) =>
    call<WorktreeCleanup>(key, "POST", "/v1/workflow/worktrees/clean", { dryRun }),
  /** Reads a local Spec Kit, ECC or Markdown directory into an inert candidate. */
  importCandidate: (
    key: string,
    request: { source: ImportSource; path: string; featureId: string },
  ) => call<ImportResult>(key, "POST", "/v1/workflow/import", request),
};

/** The group of `docs/desktop/api.md` that adds evidence, continue and recover. */
export const GROUP_B_CAPABILITY = "setup";

export const isNotFound = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;

export const errorText = (error: unknown): string =>
  isNotFound(error)
    ? "Needs a newer BAKED: this backend does not have the endpoint."
    : error instanceof Error
      ? error.message
      : String(error);

/** The `workspace-rollback` report an undo writes (`RollbackReport` in src/core/workflows/rollback.ts). */
export interface RollbackReport {
  reason: string;
  restored: { path: string; from: string | null; to: string | null; keptAs: string | null }[];
  kept: { path: string; reason: string }[];
}

export const ROLLBACK_KIND = "workspace-rollback";

/**
 * Undoes a run's uncommitted task edits and returns the report the undo wrote, or null when the
 * run had nothing left to undo (no new rollback artifact appeared).
 */
export async function undoRun(
  key: string,
  run: Pick<RunSnapshot, "runId" | "revision">,
): Promise<RollbackReport | null> {
  const rollbacks = async (): Promise<string[]> =>
    (await runs.artifacts(key, run.runId)).filter((a) => a.kind === ROLLBACK_KIND).map((a) => a.id);
  const before = new Set(await rollbacks());
  await workflow.undo(key, run);
  const after = (await rollbacks()).find((id) => !before.has(id));
  if (!after) return null;
  return JSON.parse(await runs.readArtifact(key, run.runId, after)) as RollbackReport;
}

/** `GET /v1/workflow/compare` (`run-compare` capability). */
export const RUN_COMPARE_CAPABILITY = "run-compare";

/** One side of `RunComparison` (src/core/workflows/compare.ts). */
export interface ComparedRun {
  runId: string;
  featureId: string;
  workflowId: string | null;
  status: string;
  reason: string;
  routes: { target: string; model: string }[];
  tokens: number;
  costUsd: number | null;
  activeMs: number;
  agentCalls: number;
  repairRounds: number;
  /** Absent from a server older than the review round counter. */
  reviewRounds?: number;
  correctiveTasks: number;
  stages: { stage: string; attempts: number; tokens: number }[];
  models: { model: string; tokens: number }[];
  checks: { passed: number; failed: number };
  findings: { critical: number; high: number; medium: number; low: number };
  openFindings: number;
  limitations: number;
}

/** Two runs side by side, an A/B of one feature with two routing maps. */
export interface RunComparison {
  a: ComparedRun;
  b: ComparedRun;
  sameFeature: boolean;
  sameWorkflow: boolean;
  routeDifferences: { target: string; a: string | null; b: string | null }[];
  stages: { stage: string; a: number | null; b: number | null }[];
  delta: { tokens: number; costUsd: number | null; activeMs: number };
  /** The same comparison as Markdown, for copying. */
  markdown: string;
}

export const runCompare = {
  compare: (key: string, a: string, b: string) =>
    call<RunComparison>(
      key,
      "GET",
      `/v1/workflow/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    ),
};
