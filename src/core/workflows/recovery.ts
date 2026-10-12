import { canonical } from "../specs/hash.js";
import { type EffectJournal, effectFile, fileHash } from "./effects.js";
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

/** The task a step belongs to (`task-T003`), or null for any other step. */
const stepTask = (stageId: string): string | null =>
  stageId.startsWith("task-") ? stageId.slice("task-".length) : null;

/**
 * Settles the file effects that an attempt of a finished task left unknown. A failed `edit_file`
 * of a task attempt stays `unknown` when its worktree is removed before anything observes the
 * file (stampbook bb9c6161: the run finished every stage and then stopped at acceptance, with 1.74M
 * of work undelivered). When the task is implemented or verified and an attempt of it that started
 * at or after the effect's own attempt completed, the checks and reviews ran on the result and the
 * effect no longer decides anything: it is recorded as `failed` (it has no effect on the result)
 * and listed in a `recovery` artifact as superseded. Commands, deliveries and effects of other
 * steps are left for a person. Returns the settled effect IDs.
 */
export function settleSupersededEffects(store: WorkflowStore, runId: string): string[] {
  const steps = new Map(store.steps(runId).map((s) => [s.id, s]));
  const attempts = new Map(store.attempts(runId).map((a) => [a.id, a]));
  const finished = new Set(
    store
      .tasks(runId)
      .filter((t) => ["implemented", "verified"].includes(t.status))
      .map((t) => t.id),
  );
  const settled: { effectId: string; taskId: string; attemptId: string; by: string }[] = [];
  for (const effect of store.effects(runId)) {
    if (effect.kind !== "file_patch" && effect.kind !== "artifact_write") continue;
    if (!["prepared", "unknown"].includes(effect.status)) continue;
    const attempt = attempts.get(effect.attempt_id);
    const taskId = attempt ? stepTask(steps.get(attempt.step_id)?.stage_id ?? "") : null;
    if (!attempt || !taskId || !finished.has(taskId)) continue;
    const by = [...attempts.values()].find(
      (a) =>
        a.status === "completed" &&
        a.started_at >= attempt.started_at &&
        stepTask(steps.get(a.step_id)?.stage_id ?? "") === taskId,
    );
    if (by) settled.push({ effectId: effect.id, taskId, attemptId: effect.attempt_id, by: by.id });
  }
  if (!settled.length) return [];
  store.transaction(() => {
    for (const item of settled) store.effectStatus(runId, item.effectId, "failed");
    store.artifact(
      runId,
      "recovery",
      `superseded-effects/${settled[0]?.effectId ?? "none"}.json`,
      canonical({
        effects: settled,
        outcome:
          "unknown effects of task attempts that a later or the same completed attempt superseded; settled as failed at acceptance",
      }),
    );
  });
  return settled.map((s) => s.effectId);
}

/**
 * Opens the recovery requests for the unreconciled effects acceptance found, so the run waits for
 * a decision with the choices in front of the person instead of blocking `no_progress` with no
 * request (stampbook bb9c6161 needed a manual resume to see the request).
 */
export function requestRecovery(store: WorkflowStore, runId: string, effectIds: string[]): void {
  const effects = store.effects(runId);
  for (const effectId of effectIds) {
    const open = store
      .requests(runId)
      .some(
        (r) =>
          r.kind === "recovery" &&
          r.status === "pending" &&
          (JSON.parse(r.body_json) as { effectId?: string }).effectId === effectId,
      );
    const effect = effects.find((e) => e.id === effectId);
    if (open || !effect) continue;
    store.request(runId, "recovery", store.run(runId).input_hash, {
      effectId,
      intent: JSON.parse(effect.intent_json),
      stoppedAt: "acceptance",
      note: "An edit of the run did not report whether it was applied. Check the file: if the change is not there, choose record-not-applied; if it is, record-applied. cancel ends the whole run.",
    });
  }
  store.transition(runId, "waiting", "interrupted_effect");
}

/**
 * Decides the file edits an interrupted attempt left `prepared` or `unknown` from the files, the
 * choice an operator makes with `record-applied` or `record-not-applied`: a file that still has
 * its pre-image was not written (`failed`), a file that differs from it was (`applied`, with the
 * hash it has now). Commands and deliveries are left alone. Call inside a store transaction.
 * Returns the settled effect IDs.
 */
export function settleInterruptedEdits(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
): string[] {
  const settled: string[] = [];
  for (const effect of store.effects(runId)) {
    if (effect.attempt_id !== attemptId || effect.kind !== "file_patch") continue;
    if (!["prepared", "unknown"].includes(effect.status) || effect.after_hash !== null) continue;
    let current: string | null;
    try {
      current = fileHash(effectFile(store.workspace, effect.intent_json));
    } catch {
      continue;
    }
    if (current === effect.before_hash) store.effectStatus(runId, effect.id, "failed");
    else store.finishFileEffect(runId, effect.id, current);
    settled.push(effect.id);
  }
  if (settled.length)
    store.artifact(
      runId,
      "recovery",
      `stalled-edits/${settled[0]}.json`,
      canonical({
        attemptId,
        effects: settled,
        outcome: "edits of a stalled attempt settled from the file hashes",
      }),
    );
  return settled;
}
