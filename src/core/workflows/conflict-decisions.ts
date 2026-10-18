import { canonical } from "../specs/hash.js";
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
const SETTLED_CONFLICTS = 12;
const SETTLED_REPORT_CHARS = 600;

/** A conflict a task reported and how the run settled it, by an assumption or a person. */
export interface SettledConflict {
  path: string;
  taskId: string;
  settled: string;
  report?: string;
}

/**
 * The conflicts the run already settled, newest last (#1519): reviewers get them so that a
 * finding does not ask again for what an assumption or a person decided against. intsmith
 * ca6f3023 (bench round 43): T004 recorded that the request's ban on generated test inputs wins,
 * and the review still asked for a loop over the whole interval (2.0M tokens of correctives).
 */
export function settledConflicts(store: WorkflowStore, runId: string): SettledConflict[] {
  const assumed = store
    .artifacts(runId)
    .filter((a) => a.logical_path.startsWith(CONFLICT_ASSUMPTION_PREFIX))
    .flatMap((a): SettledConflict[] => {
      try {
        const body = JSON.parse(store.readArtifact(runId, a.id)) as {
          taskId?: unknown;
          assumed?: unknown;
          summary?: unknown;
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
