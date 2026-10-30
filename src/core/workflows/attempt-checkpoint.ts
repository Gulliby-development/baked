import { canonical } from "../specs/hash.js";
import type { RunPolicy } from "./schemas.js";
import type { AttemptUsageRecord } from "./step-budget.js";
import { recordWouldFinish, stopMode } from "./stop-reasons.js";
import type { WorkflowStore } from "./store.js";

/**
 * The green checkpoint of an implementer attempt (#2470, shadow). R79 deltaglue chunks T004: at
 * 23:19:17 every required check of the task (`tests-affected`, `tests`, `typecheck`, `lint`)
 * passed inside the attempt; the model edited on, the checks failed, and at 23:19:40 the attempt
 * ended at its all-token cap and the run blocked `attempt_cap`. The host finish after a stop
 * (`hostFinishAfterStop`, #1978) looks only at the state an attempt ends in, so the green state
 * was lost. The attempt now records that state (`attempts/<attempt>/checkpoint.json`), and an
 * unfinished end whose final checks fail records `decision.would_finish` with its evidence. The
 * decision changes nothing yet: restoring the checkpoint and finishing the task is a pull request
 * of its own after a bench round with no false would-finish.
 */

/** The logical path of an attempt's checkpoint record. */
export const checkpointPath = (attemptId: string) => `attempts/${attemptId}/checkpoint.json`;

export type CheckpointRepro = "passed" | "reproduced" | "none";

export interface AttemptCheckpoint {
  schemaVersion: 1;
  attemptId: string;
  taskId: string | null;
  /** The task's required checks the attempt can run itself (`request_check`). */
  required: string[];
  /** The journal position of the green state: the attempt's journaled file edits until then. */
  position: number;
  /** The checks that passed on that state, with the evidence of each run. */
  checks: string[];
  evidenceIds: string[];
  /** The findings' repro on that state (`run_repro`), `none` when it was not run there. */
  repro: CheckpointRepro;
  /**
   * The attempt's tokens (all tokens, cache reads included) of the steps finished before the one
   * whose check run made the state green.
   */
  tokens: number;
  /**
   * What came after: the journal position at the latest required check run, and the required
   * checks whose latest run, on edits past the checkpoint, failed.
   */
  after: { position: number; failed: string[] };
}

/**
 * Follows the required check runs of one attempt and records the latest state on which every
 * required check passed. A check run counts for the journal position it ran at; an edit after a
 * run makes it stale, so the checkpoint needs a passing run of each required check at the same
 * position.
 */
export class CheckpointTracker {
  private readonly latest = new Map<
    string,
    { status: string; position: number; evidenceId: string }
  >();
  private repro: { status: Exclude<CheckpointRepro, "none">; position: number } | null = null;
  private checkpoint: AttemptCheckpoint | null = null;
  constructor(
    private readonly meta: { attemptId: string; taskId: string | null; required: string[] },
    private readonly save: (checkpoint: AttemptCheckpoint) => void,
  ) {}
  /** A run of a check at journal position `position`, with the attempt's tokens so far. */
  check(
    checkId: string,
    status: string,
    evidenceId: string,
    position: number,
    tokens: number,
  ): void {
    const { required } = this.meta;
    if (!required.includes(checkId)) return;
    this.latest.set(checkId, { status, position, evidenceId });
    const green = required.every((id) => {
      const run = this.latest.get(id);
      return run?.status === "passed" && run.position === position;
    });
    if (green) {
      this.checkpoint = {
        schemaVersion: 1,
        attemptId: this.meta.attemptId,
        taskId: this.meta.taskId,
        required: [...required],
        position,
        checks: [...required],
        evidenceIds: required.map((id) => this.latest.get(id)?.evidenceId ?? ""),
        repro: this.repro?.position === position ? this.repro.status : "none",
        tokens,
        after: { position, failed: [] },
      };
      this.persist();
      return;
    }
    const checkpoint = this.checkpoint;
    if (!checkpoint) return;
    checkpoint.after = {
      position: Math.max(checkpoint.after.position, position),
      failed: required.filter((id) => {
        const run = this.latest.get(id);
        return run?.status === "failed" && run.position > checkpoint.position;
      }),
    };
    this.persist();
  }
  /** A run of the findings' repro at journal position `position`. */
  reproRan(reproduced: boolean, position: number): void {
    this.repro = { status: reproduced ? "reproduced" : "passed", position };
    if (this.checkpoint?.position === position) {
      this.checkpoint.repro = this.repro.status;
      this.persist();
    }
  }
  private persist(): void {
    if (this.checkpoint) this.save(structuredClone(this.checkpoint));
  }
}

/** How an attempt ended unfinished: its token or step cap, the progress watcher, or a stall. */
export type UnfinishedEnd = "tokens" | "steps" | "watcher" | "stall";

export interface WouldFinish {
  stoppedBy: UnfinishedEnd;
  /** The checkpoint's journal position and the position the attempt's checks ended at. */
  position: number;
  journalEnd: number;
  checks: string[];
  evidenceIds: string[];
  repro: CheckpointRepro;
  /** The required checks that failed on the edits after the checkpoint. */
  failedAfter: string[];
  /** The tokens the attempt spent after the checkpoint; null when its total is unknown. */
  tokensAfter: number | null;
}

/**
 * Whether the host would finish the task from the attempt's checkpoint: the attempt ended
 * unfinished, it had a state on which every required check passed, and its required checks failed
 * on the edits after it. Null otherwise, also when the final state was never checked.
 */
export function checkpointWouldFinish(
  checkpoint: AttemptCheckpoint | null,
  end: { stoppedBy: UnfinishedEnd | null; totalTokens: number | null },
): WouldFinish | null {
  if (!checkpoint || !end.stoppedBy) return null;
  if (!checkpoint.after.failed.length || checkpoint.after.position <= checkpoint.position)
    return null;
  return {
    stoppedBy: end.stoppedBy,
    position: checkpoint.position,
    journalEnd: checkpoint.after.position,
    checks: checkpoint.checks,
    evidenceIds: checkpoint.evidenceIds,
    repro: checkpoint.repro,
    failedAfter: checkpoint.after.failed,
    tokensAfter: end.totalTokens === null ? null : Math.max(0, end.totalTokens - checkpoint.tokens),
  };
}

/** How the usage record says an attempt was stopped, as `hostFinishAfterStop` reads it. */
export function usageStoppedBy(record: AttemptUsageRecord | undefined): UnfinishedEnd | null {
  if (record?.finalizedBy) return record.finalizedBy;
  return record?.stopReason === "tokens" || record?.stopReason === "steps"
    ? record.stopReason
    : null;
}

/** The latest checkpoint record of an attempt, or null. */
export function readCheckpoint(store: WorkflowStore, runId: string, attemptId: string) {
  const row = store.latestArtifact(runId, checkpointPath(attemptId));
  return row ? store.readArtifactJson<AttemptCheckpoint>(runId, row) : null;
}

/** Writes an attempt's checkpoint record. */
export function saveCheckpoint(
  store: WorkflowStore,
  runId: string,
  checkpoint: AttemptCheckpoint,
): void {
  store.transaction(() =>
    store.artifact(
      runId,
      "attempt-context",
      checkpointPath(checkpoint.attemptId),
      canonical(checkpoint),
    ),
  );
}

/**
 * Reads the attempt's checkpoint at an unfinished end and records `decision.would_finish` (reason
 * `attempt_green_checkpoint`) when the host would finish the task from it, once per attempt. It
 * never changes the end: a failure to read or record leaves the attempt's path as it was.
 */
export function recordCheckpointWouldFinish(
  store: WorkflowStore,
  runId: string,
  attemptId: string,
  stoppedBy: UnfinishedEnd | null,
): boolean {
  try {
    const checkpoint = readCheckpoint(store, runId, attemptId);
    if (!checkpoint) return false;
    const usageRow = store.latestArtifact(runId, `attempts/${attemptId}/usage.json`);
    const usage = usageRow
      ? store.readArtifactJson<AttemptUsageRecord>(runId, usageRow)
      : undefined;
    const totalTokens =
      usage?.totalTokens ?? store.attempts(runId).find((a) => a.id === attemptId)?.used_tokens;
    const decision = checkpointWouldFinish(checkpoint, {
      stoppedBy,
      totalTokens: totalTokens ?? null,
    });
    if (!decision) return false;
    const policy = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    const mode = stopMode(policy, "attempt_green_checkpoint");
    if (mode === "enforce") return false;
    return recordWouldFinish(store, runId, {
      mode,
      key: `attempt-${attemptId}`,
      summary: `Task ${checkpoint.taskId ?? "?"} passed every required check (${decision.checks.join(", ")}) at edit ${decision.position} of attempt ${attemptId}${decision.repro === "passed" ? " with its findings' repro passing" : ""}, then edited on, failed ${decision.failedAfter.join(", ")} and ended unfinished (${stoppedBy}): the host would finish the task from that state${decision.tokensAfter !== null ? ` (${decision.tokensAfter} tokens after it)` : ""}`,
      inputs: { taskId: checkpoint.taskId, attemptId, ...decision },
    });
  } catch {
    return false;
  }
}
