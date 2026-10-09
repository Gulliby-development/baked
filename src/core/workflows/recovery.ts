import type { EffectJournal } from "./effects.js";
import type { WorkflowStore } from "./store.js";

export function recoverRun(store: WorkflowStore, journal: EffectJournal, runId: string): boolean {
  const unknown = journal.reconcile(runId);
  store.transaction(() => {
    for (const attempt of store.attempts(runId).filter((a) => a.status === "running")) {
      store.finishAttempt(runId, attempt.id, "interrupted", null);
      store.finishStep(runId, attempt.step_id, "interrupted");
    }
    for (const task of store.tasks(runId).filter((t) => t.status === "running"))
      store.taskStatus(runId, task.id, "invalidated");
    if (unknown.length) {
      for (const effectId of unknown) {
        if (
          !store
            .requests(runId)
            .some(
              (r) =>
                r.kind === "recovery" &&
                r.status === "pending" &&
                JSON.parse(r.body_json).effectId === effectId,
            )
        )
          store.request(runId, "recovery", store.run(runId).input_hash, { effectId });
      }
      store.transition(runId, "waiting", "interrupted_effect");
    }
  });
  return unknown.length === 0;
}
