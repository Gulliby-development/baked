import type { RunList, RunSnapshot, RunState } from "../../shared/api.js";
import { ApiError, call } from "./api.js";
import { type RunStatus, workflow } from "./workflow.js";

/**
 * Read access to workflow runs for the run screens: the run list, a run's artifacts, usage and
 * event log, and the workflow definitions. Shapes mirror `src/core/workflows/` and
 * `src/headless/workflow.ts`; only the fields the screens read are declared.
 */

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
}

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
  };
  "task.state_changed": { taskId: string; from: string; to: string; generation: number };
  "artifact.committed": { artifactId: string; kind: string; hash: string };
  "check.finished": { checkId: string; evidenceId: string; status: string };
  "finding.recorded": { findingId: string; artifactId: string };
  "criterion.assessed": { criterionId: string; snapshotId: string; verdict: string };
  "request.created": { requestId: string; kind: string; digest: string };
  "request.decided": { requestId: string; status: string; actor: string };
  "effect.reconciled": { effectId: string; status: string };
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
  /** Continues a run past a soft checkpoint (API group B, capability `setup`). */
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
