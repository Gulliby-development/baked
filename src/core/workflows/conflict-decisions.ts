import { canonical } from "../specs/hash.js";
import { namesPlatformLimit } from "./analysis-notes.js";
import type { WorkflowStore } from "./store.js";

/** Where a person's answer to a task's spec conflict is recorded (#1350). */
export const CONFLICT_DECISION_PREFIX = "decisions/clarification-";

/** A person's answer to `SPEC-CONFLICT-<task>`, bound to the findings the task corrects. */
export interface ConflictDecision {
  requestId: string;
  taskId: string;
  /** Findings the answer decides: their repros no longer gate the task. */
  findingIds: string[];
  answer: string;
  /**
   * The criteria the conflict contested (#1709): a person's answer overrules their rows for the
   * task, so the case walk no longer demands the literals the answer replaced.
   */
  criterionIds?: string[];
}

/** Records the answer as a decision of the run. */
export function recordConflictDecision(
  store: WorkflowStore,
  runId: string,
  decision: ConflictDecision,
): void {
  store.artifact(
    runId,
    "decision",
    `${CONFLICT_DECISION_PREFIX}${decision.requestId}.json`,
    canonical(decision),
  );
}

/** The run's spec conflict decisions, oldest first. */
export function conflictDecisions(store: WorkflowStore, runId: string): ConflictDecision[] {
  return store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith(CONFLICT_DECISION_PREFIX))
    .flatMap((a) => {
      try {
        const body = JSON.parse(store.readArtifact(runId, a.id)) as Partial<ConflictDecision>;
        return typeof body.taskId === "string" &&
          typeof body.answer === "string" &&
          typeof body.requestId === "string" &&
          Array.isArray(body.findingIds)
          ? [
              {
                requestId: body.requestId,
                taskId: body.taskId,
                findingIds: body.findingIds.filter((id): id is string => typeof id === "string"),
                answer: body.answer,
                ...(Array.isArray(body.criterionIds)
                  ? {
                      criterionIds: body.criterionIds.filter(
                        (id): id is string => typeof id === "string",
                      ),
                    }
                  : {}),
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
}

/** Findings a person's spec conflict answer decided. */
export function decidedFindingIds(store: WorkflowStore, runId: string): Set<string> {
  return new Set(conflictDecisions(store, runId).flatMap((d) => d.findingIds));
}

/** Where an assumption that settled a task's spec conflict under `clarification: assume` lives. */
export const CONFLICT_ASSUMPTION_PREFIX = "assumptions/conflicts/";
/** Where the platform limits a finished task declared live (#1536). */
export const DECLARED_LIMIT_PREFIX = "assumptions/limits/";
const DECLARED_LIMITS = 5;
const LIMIT_CLAIM_CHARS = 600;

/** A platform limit a task met and worked around with the nearest feasible behavior. */
export interface PlatformLimit {
  claim: string;
  evidence?: string;
}

/**
 * The platform limits an `implemented` or `already_satisfied` result declares: its typed
 * `platformLimits`, else the sentences of its summary that name one, as the implementer rule asks
 * ("platform limit: Fetch headers cannot carry raw non-ASCII text"). A blocked or unfinished result
 * declares none: its limit is not yet a decision.
 */
export function declaredPlatformLimits(result: {
  outcome: string;
  summary: string;
  platformLimits?: PlatformLimit[] | undefined;
}): PlatformLimit[] {
  if (result.outcome !== "implemented" && result.outcome !== "already_satisfied") return [];
  if (result.platformLimits?.length) return result.platformLimits.slice(0, DECLARED_LIMITS);
  return result.summary
    .split(/(?<=[.;])\s+|\n+/)
    .filter(namesPlatformLimit)
    .slice(0, DECLARED_LIMITS)
    .map((claim) => ({ claim: claim.trim().slice(0, LIMIT_CLAIM_CHARS) }));
}

/**
 * Records the limits a finished task declared as a settled conflict, so reviews judge the nearest
 * feasible behavior and do not raise the impossible requirement again (#1536). url-shortener
 * ae4b9d3d (bench round 44): T005 wrote "Platform limit: Fetch headers cannot carry raw non-ASCII
 * text" in an implemented result, the next review asked for the raw Location again, and T006 paid
 * 1.2M tokens to report the same limit as a spec conflict. Unchanged limits are not written again.
 */
export function recordDeclaredLimits(
  store: WorkflowStore,
  runId: string,
  taskId: string,
  limits: PlatformLimit[],
): void {
  if (!limits.length) return;
  const path = `${DECLARED_LIMIT_PREFIX}${taskId}.json`;
  const content = canonical({
    taskId,
    declared: true,
    limits,
    summary: limits.map((l) => l.claim).join(" "),
    assumed: `The platform cannot do what one side demands: the nearest feasible behavior task ${taskId} implemented holds`,
  });
  const latest = store.latestArtifact(runId, path);
  if (latest && store.readArtifact(runId, latest.id) === content) return;
  store.artifact(runId, "assumption", path, content);
}
const SETTLED_CONFLICTS = 12;
const SETTLED_REPORT_CHARS = 600;

/**
 * A conflict a task reported and how the run settled it, by an assumption or a person, or a
 * platform limit a finished task declared (`declared`).
 */
export interface SettledConflict {
  path: string;
  taskId: string;
  settled: string;
  report?: string;
  declared?: true;
}

/**
 * The conflicts the run already settled, newest last (#1519): reviewers get them so that a
 * finding does not ask again for what an assumption or a person decided against. intsmith
 * ca6f3023 (bench round 43): T004 recorded that the request's ban on generated test inputs wins,
 * and the review still asked for a loop over the whole interval (2.0M tokens of correctives).
 */
export function settledConflicts(store: WorkflowStore, runId: string): SettledConflict[] {
  const rows = store
    .artifacts(runId)
    .filter(
      (a) =>
        a.logical_path.startsWith(CONFLICT_ASSUMPTION_PREFIX) ||
        a.logical_path.startsWith(DECLARED_LIMIT_PREFIX),
    );
  // A path written again (a later attempt's limits) counts once, at its latest revision.
  const latest = rows.filter(
    (a, index) => !rows.slice(index + 1).some((b) => b.logical_path === a.logical_path),
  );
  const assumed = latest.flatMap((a): SettledConflict[] => {
    try {
      const body = JSON.parse(store.readArtifact(runId, a.id)) as {
        taskId?: unknown;
        assumed?: unknown;
        summary?: unknown;
        declared?: unknown;
      };
      if (typeof body.taskId !== "string" || typeof body.assumed !== "string") return [];
      return [
        {
          path: a.logical_path,
          taskId: body.taskId,
          settled: body.assumed,
          ...(typeof body.summary === "string"
            ? { report: body.summary.slice(0, SETTLED_REPORT_CHARS) }
            : {}),
          ...(body.declared === true ? { declared: true as const } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
  // An assumption also records itself as a decision; only a person's answers are added here.
  const answered = conflictDecisions(store, runId)
    .filter((d) => !d.requestId.startsWith("assumed-"))
    .map((d) => ({
      path: `${CONFLICT_DECISION_PREFIX}${d.requestId}.json`,
      taskId: d.taskId,
      settled: d.answer,
    }));
  return [...assumed, ...answered].slice(-SETTLED_CONFLICTS);
}
