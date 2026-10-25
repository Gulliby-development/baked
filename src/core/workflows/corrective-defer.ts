/**
 * Whether a blocked corrective ends the run at once, or the host first runs the ready tasks it
 * does not hold (#2109). skillcomb (bench round 67, #2094): a corrective blocked
 * `out_of_scope_failure` and the run stopped with eight independent test tasks never started,
 * so the resume after a person fixed the files had to run them all. A corrective blocks its own
 * chain only: the tasks that read the files it would have fixed stay held, and every other ready
 * task can run before the run reports the blocked chain.
 *
 * Each corrective that blocks records its inputs as `blocks/correctives/<task>-<n>.json` (kind
 * `corrective-defer`, kept in bench traces, no prose): the stop's code and reason, the ready
 * tasks it does not hold and the run's writers. `correctiveDeferDecision` decides; with the policy
 * field `correctiveDefer` absent the decision is shadow (recorded, the run ends as before), and
 * `replayCorrectiveDefers` (`trace.ts`) decides each record again.
 */
export const DEFER_KIND = "corrective-defer";
export const DEFER_DIR = "blocks/correctives/";

export interface CorrectiveDeferInput {
  /** The ready tasks the blocked corrective, and those blocked before it, do not hold. */
  ready: string[];
  /** The run's concurrent writers. */
  writers: number;
}

/** What `blocks/correctives/<task>-<n>.json` records. */
export interface CorrectiveDeferRecord extends CorrectiveDeferInput {
  taskId: string;
  /** `shadow`: recorded only, the run ends; `on`: the host runs the ready tasks first. */
  mode: "shadow" | "on";
  /** The stop's fault code and reason. */
  code: string;
  reason: string | null;
  /** The correctives blocked earlier in the same drive, whose holds stay in place. */
  parked: string[];
  defer: boolean;
}

export type CorrectiveDeferRule = (input: CorrectiveDeferInput) => boolean;

/** The one rule: run the ready tasks the blocked chains do not hold first, when there are any. */
export const correctiveDeferDecision: CorrectiveDeferRule = (input) =>
  input.writers > 0 && input.ready.length > 0;

export const correctiveDeferPath = (taskId: string, n: number): string =>
  `${DEFER_DIR}${taskId}-${String(n)}.json`;
