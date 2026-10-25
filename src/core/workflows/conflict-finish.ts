/**
 * The host's finish of a task whose spec conflict it settled, when the attempt that reported the
 * conflict already did what the settlement asks (#2033, follow-up of #2016). R65 uritpl cli T003:
 * the test already asserted the request's column 5 and the checks passed, yet the session after
 * the settlement (410,310 tokens) only recorded that. When a settled-conflict branch whose
 * settlement the attempt's tree can already satisfy (the request wins, the requirements win, the
 * platform's nearest behavior holds) settles, and the attempt changed files, the host walks the
 * task's criteria cases with the overruled criteria released, checks that its test files hold no
 * literal of an overruled criterion (a passing test that does still follows the losing side),
 * checks the host's row blocks and runs the task's required checks (the written-tests check among
 * them) on the attempt's tree.
 * When all hold the task goes on as implemented without another session, as the host finish of a
 * stopped corrective does (#1978, `tasks/<task>/host-finish.json`); otherwise the session opens as
 * before. A branch whose settlement asks for an edit (a test the run wrote, or another task's
 * test, that contradicts the spec) never finishes here.
 *
 * Every such settlement records its inputs as `conflicts/finish/<task>-<branch>.json` (kind
 * `conflict-finish`, kept in bench traces, no prose), replayed by `replayConflictFinishes`. With
 * the policy field `conflictFinish` absent the decision is shadow: the case walk and the row
 * blocks are recorded, the checks are not run, and the session opens.
 */
export const CONFLICT_FINISH_KIND = "conflict-finish";
export const CONFLICT_FINISH_DIR = "conflicts/finish/";

/** The settled-conflict branches whose settlement the attempt's tree may already satisfy. */
export type ConflictFinishBranch = "request" | "requirements" | "reaudited" | "platform";

export interface ConflictFinishCheck {
  id: string;
  status: "passed" | "failed";
}

export interface ConflictFinishInput {
  branch: ConflictFinishBranch;
  /** Files the attempt changed. */
  edits: number;
  /** The host's row blocks are intact; null when the task has none. */
  rows: boolean | null;
  /** Cases of the task's criteria, the overruled ones released, that its test files do not hold. */
  cases: number;
  /** Cases of the overruled criteria that the task's test files still hold: a test that follows them. */
  overruled: number;
  /** The task's required checks on the attempt's tree, in order, up to the first failure; null when not run. */
  checks: ConflictFinishCheck[] | null;
}

/** What `conflicts/finish/<task>-<branch>.json` records. */
export interface ConflictFinishRecord extends ConflictFinishInput {
  taskId: string;
  /** `shadow`: recorded only, the session opens; `on`: the host finishes when the decision holds. */
  mode: "shadow" | "on";
  /** The assumption that settled the conflict. */
  settledBy: string;
  finish: boolean;
}

export type ConflictFinishRule = (input: ConflictFinishInput) => boolean;

/**
 * Whether the tree before the checks may finish: edits, intact rows, no open case, and no test
 * that still follows an overruled criterion.
 */
export const conflictFinishReady = (input: Omit<ConflictFinishInput, "checks">): boolean =>
  input.edits > 0 && input.rows !== false && input.cases === 0 && input.overruled === 0;

/**
 * The one rule for whether the host finishes a task whose conflict it settled: the attempt
 * changed files, its row blocks are intact, its test files hold every case of its criteria with
 * the overruled ones released and no literal of the overruled ones, and at least one required
 * check ran and every one passed.
 */
export const conflictFinishDecision: ConflictFinishRule = (input) =>
  conflictFinishReady(input) &&
  input.checks !== null &&
  input.checks.length > 0 &&
  input.checks.every((c) => c.status === "passed");

export const conflictFinishPath = (taskId: string, branch: ConflictFinishBranch): string =>
  `${CONFLICT_FINISH_DIR}${taskId}-${branch}.json`;
