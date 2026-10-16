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
