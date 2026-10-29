import { canonical } from "../specs/hash.js";
import { type EffectJournal, effectFile, fileHash } from "./effects.js";
import { commandProcessMayRun } from "./leases.js";
import type { Decision, RunPolicy } from "./schemas.js";
import { stopMode } from "./stop-reasons.js";
import type { EffectRow, WorkflowStore } from "./store.js";

export function recoverRun(store: WorkflowStore, journal: EffectJournal, runId: string): boolean {
  const unknown = journal.reconcile(runId);
  store.transaction(() => {
    for (const attempt of store.attempts(runId).filter((a) => a.status === "running")) {
      store.finishAttempt(runId, attempt.id, "interrupted", null);
      store.finishStep(runId, attempt.step_id, "interrupted");
    }
    // Child steps of a stage that threw have no running attempt of their own (#1745).
    store.endOpenSteps(runId, null, "running", "interrupted");
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
          store.request(runId, "recovery", store.run(runId).input_hash, {
            effectId,
            ...checkRecoveryNote(store, runId, effectId),
          });
      }
      noteInterruptedChecks(store, runId, unknown, "drive");
      store.transition(runId, "waiting", "interrupted_effect");
    }
  });
  return unknown.length === 0;
}

/**
 * What the host would do with a command effect of unknown outcome (#2415): a check's command
 * (its intent names a `checkId`: a feature check, a task-end `-written` check or a formatter
 * gate run as a check) whose process is gone is settled as not applied (`failed`, no effect),
 * because the checks stage runs the check again and its evidence is bound to the snapshot hash.
 * Null for any other effect: a delivery must not be repeated, an acceptance walk-through's
 * command is not a check, and file effects are settled from their hashes.
 */
export interface InterruptedCheckDecision {
  effectId: string;
  checkId: string;
  definitionHash: string | null;
  /** The root the check ran in, relative to the project root; "" for the project root. */
  root: string;
  pid: number | null;
  /** The recorded process (and its scope) is gone, so the command cannot still run. */
  processGone: boolean;
  settle: boolean;
}

export function interruptedCheckDecision(
  effect: Pick<EffectRow, "id" | "kind" | "status" | "intent_json">,
  processMayRun: (intentJson: string) => boolean = commandProcessMayRun,
): InterruptedCheckDecision | null {
  if (effect.kind !== "command" || !["prepared", "unknown"].includes(effect.status)) return null;
  const intent = JSON.parse(effect.intent_json) as {
    checkId?: unknown;
    definitionHash?: unknown;
    root?: unknown;
    pid?: unknown;
  };
  if (typeof intent.checkId !== "string") return null;
  const processGone = !processMayRun(effect.intent_json);
  return {
    effectId: effect.id,
    checkId: intent.checkId,
    definitionHash: typeof intent.definitionHash === "string" ? intent.definitionHash : null,
    root: typeof intent.root === "string" ? intent.root : "",
    pid: typeof intent.pid === "number" ? intent.pid : null,
    processGone,
    settle: processGone,
  };
}

/** The note a recovery request of an interrupted check carries, so a person knows retry is safe. */
export function checkRecoveryNote(
  store: WorkflowStore,
  runId: string,
  effectId: string,
): { note?: string } {
  const effect = store.effects(runId).find((e) => e.id === effectId);
  const decision = effect ? interruptedCheckDecision(effect) : null;
  if (!decision?.settle) return {};
  return {
    note: `Check ${decision.checkId} was running when the host stopped, and its process is gone. The check runs again at its stage, so retry is safe and needs no evidence file.`,
  };
}

/**
 * Records, in shadow, the interrupted checks the host would settle itself (#2415): one
 * `decision.would_resume` event per effect (`effect-<id>`) under `host-settle-interrupted-check`,
 * with the decision's inputs. The recovery request stays with the person. Call inside a store
 * transaction. Returns the decisions it recorded.
 */
export function noteInterruptedChecks(
  store: WorkflowStore,
  runId: string,
  effectIds: string[],
  at: "drive" | "resume" | "acceptance",
): InterruptedCheckDecision[] {
  const policy = JSON.parse(store.run(runId).policy_json) as RunPolicy;
  const mode = stopMode(policy, "host-settle-interrupted-check");
  if (mode === "enforce") return [];
  const effects = store.effects(runId);
  const seen = new Set(
    store
      .eventsOfType(runId, "decision.would_resume")
      .flatMap((e) =>
        e.type === "decision.would_resume" && e.payload.reason === "host-settle-interrupted-check"
          ? [e.payload.key]
          : [],
      ),
  );
  const recorded: InterruptedCheckDecision[] = [];
  for (const effectId of effectIds) {
    const effect = effects.find((e) => e.id === effectId);
    const decision = effect ? interruptedCheckDecision(effect) : null;
    const key = `effect-${effectId}`;
    if (!decision?.settle || seen.has(key)) continue;
    seen.add(key);
    store.emit(runId, {
      type: "decision.would_resume",
      payload: {
        reason: "host-settle-interrupted-check",
        mode,
        key,
        summary:
          `The host would settle check ${decision.checkId}'s interrupted command as not applied (host stopped) and continue the run; the check runs again at its stage.`.slice(
            0,
            1000,
          ),
        inputs: { ...decision, at, cause: "host stopped" },
      },
    });
    recorded.push(decision);
  }
  return recorded;
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
 * steps are left for a person; a check's command whose process is gone is recorded as one the
 * host would settle (`noteInterruptedChecks`, shadow, #2415). Returns the settled effect IDs.
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
      ...checkRecoveryNote(store, runId, effectId),
    });
  }
  noteInterruptedChecks(store, runId, effectIds, "acceptance");
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

/** The note a recovery decision without evidence records (#2415), one line per resolution. */
export function recoveryNote(
  resolution: Extract<Decision, { kind: "recovery" }>["resolution"],
): string {
  return {
    retry: "Retry chosen without evidence: the command runs again at its stage.",
    "record-not-applied": "Recorded as not applied without evidence.",
    "record-applied": "Recorded as applied without evidence.",
    cancel: "Run cancelled without evidence.",
  }[resolution];
}

/** A recovery decision with its evidence, the generated note when none was given (#2415). */
export function withRecoveryNote(decision: Decision): Decision {
  return decision.kind === "recovery" && !decision.evidence?.trim()
    ? { ...decision, evidence: recoveryNote(decision.resolution) }
    : decision;
}
