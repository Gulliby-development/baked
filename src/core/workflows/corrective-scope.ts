import { isStaticCheck } from "./check-policy.js";
import { isTestCheck } from "./quality/mutation.js";
import { type RecoveryAdvice, recoveryAdvice } from "./remedies.js";
import type { Review, RunPolicy } from "./schemas.js";
import type { WorkflowStore } from "./store.js";
import type { RuntimeState } from "./types.js";

/**
 * Whether a task-level corrective can write the files its own diagnostics name (#2094). skillcomb
 * (bench round 67): the sizing split cut tests/test_fields.py into T010 (create) and T017
 * (modify, after T010). T010 left seven ruff ISC004 hits in the file, and its corrective T024 was
 * built without it: a task-level repair may not take over a test file whose later slice has still
 * to run (#1612), so T024 got the three source files of T010's related tasks instead. Six sessions
 * (1.89M tokens) edited code the task was told not to change, the hold of `readyTasks` kept eight
 * independent test tasks waiting on those source files, and the run blocked
 * `out_of_scope_failure` only after the sessions were paid.
 *
 * The rule: a corrective for a failed required check that is not a test check writes the files
 * the check names that the failing task itself writes (`ownScope`), also while a later slice
 * still writes them; a later slice depends on the failing task, so it reads the corrected file.
 * A diagnostics-only corrective (a linter, formatter or type checker, `diagnosticsOnly`) writes
 * only the failing task's own files, never the related tasks' sources. A failing test check keeps
 * #1612: its defect is usually in the source the test reaches, and the later slice adds tests.
 *
 * The precondition is recorded when the corrective is created and again before each of its
 * sessions as `scope/tasks/<task>.json` (kind `corrective-scope`, kept in bench traces), and a
 * corrective that misses one of its diagnosed files records a `corrective_scope` would-stop
 * (shadow): no model can write a file outside its scope. `replayCorrectiveScopes` (`trace.ts`)
 * decides each record again.
 */
export const SCOPE_KIND = "corrective-scope";
/** One record per task-level corrective of a failed non-test check: `scope/tasks/<task>.json`. */
export const SCOPE_TASKS_DIR = "scope/tasks/";

/** The check a task-level finding names: `Task T001 required check lint failed`. */
const TASK_CHECK_FAILED = /^Task \S+ required check (\S+) failed$/;

/** How a task-level finding of a failed required check is corrected, or null for any other finding. */
export function checkRepairKind(
  policy: Pick<RunPolicy, "checks">,
  finding: Pick<Review["findings"][number], "claim">,
): "diagnostics" | "build" | null {
  const id = TASK_CHECK_FAILED.exec(finding.claim)?.[1];
  const check = id ? policy.checks.find((c) => c.id === id) : undefined;
  if (!check || isTestCheck(check)) return null;
  return isStaticCheck(check) ? "diagnostics" : "build";
}

type ScopeState = Pick<RuntimeState, "repairScope" | "repairPredecessors" | "graph">;

/** The files in a finding's repair scope that the failing task (its predecessor) itself writes. */
export function ownScope(state: ScopeState, findingId: string): string[] {
  const base = state.graph?.tasks.find((t) => t.id === state.repairPredecessors[findingId]);
  if (!base) return [];
  return (state.repairScope[findingId] ?? []).filter((path) =>
    base.writes.some((w) => w.path === path && w.action !== "delete"),
  );
}

/**
 * The files a corrective of `finding` must be able to write: those its failed non-test check
 * names in the failing task's own files. Empty for a test check and every other finding.
 */
export function diagnosedFiles(
  state: ScopeState,
  policy: Pick<RunPolicy, "checks">,
  finding: Pick<Review["findings"][number], "id" | "claim">,
): string[] {
  return checkRepairKind(policy, finding) ? ownScope(state, finding.id) : [];
}

/**
 * Whether a finding is corrected as diagnostics only: a linter, formatter or type checker named
 * only files the failing task writes. Its corrective writes the failing task's own files and no
 * related task's sources (#2094, #1067).
 */
export function diagnosticsOnly(
  state: ScopeState,
  policy: Pick<RunPolicy, "checks">,
  finding: Pick<Review["findings"][number], "id" | "claim">,
): boolean {
  const scope = state.repairScope[finding.id] ?? [];
  return (
    checkRepairKind(policy, finding) === "diagnostics" &&
    scope.length > 0 &&
    ownScope(state, finding.id).length === scope.length
  );
}

export type ScopeDecision = "fits" | "refuse";

/** What `scope/tasks/<task>.json` records: the precondition's inputs and its decision. */
export interface ScopeRecord {
  taskId: string;
  /** Where the precondition was checked: when the corrective was created, or before a session. */
  at: "create" | "start";
  /** The tasks whose failed checks the corrective corrects. */
  failing: string[];
  /** The checks that failed. */
  checks: string[];
  /** The files those checks name in the failing tasks' own files. */
  diagnosed: string[];
  /** The corrective's write scope. */
  writes: string[];
  /** The diagnosed files outside its write scope. */
  missing: string[];
  decision: ScopeDecision;
}

/** The diagnosed files a corrective cannot write; `replayCorrectiveScopes` takes another rule. */
export type ScopeRule = (diagnosed: readonly string[], writes: readonly string[]) => string[];

export const missingDiagnosed: ScopeRule = (diagnosed, writes) =>
  diagnosed.filter((path) => !writes.includes(path));

/** The precondition of one corrective, decided on its findings and write scope. */
export function scopeRecord(
  state: ScopeState,
  policy: Pick<RunPolicy, "checks">,
  task: { id: string; writes: { path: string; action: string }[] },
  findings: Pick<Review["findings"][number], "id" | "claim">[],
  at: ScopeRecord["at"],
  rule: ScopeRule = missingDiagnosed,
): ScopeRecord | null {
  const own = findings.filter((f) => checkRepairKind(policy, f));
  if (!own.length) return null;
  const diagnosed = [...new Set(own.flatMap((f) => ownScope(state, f.id)))];
  const writes = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  const missing = rule(diagnosed, writes);
  return {
    taskId: task.id,
    at,
    failing: [
      ...new Set(own.map((f) => state.repairPredecessors[f.id]).filter((id): id is string => !!id)),
    ],
    checks: [...new Set(own.map((f) => TASK_CHECK_FAILED.exec(f.claim)?.[1] ?? ""))],
    diagnosed,
    writes,
    missing,
    decision: missing.length ? "refuse" : "fits",
  };
}

/** Every precondition record of a run, in the order they were written. */
export function scopeRecords(
  store: Pick<WorkflowStore, "artifacts" | "readArtifact">,
  runId: string,
): ScopeRecord[] {
  const records: ScopeRecord[] = [];
  for (const artifact of store.artifacts(runId)) {
    if (artifact.kind !== SCOPE_KIND || !artifact.logical_path.startsWith(SCOPE_TASKS_DIR))
      continue;
    try {
      records.push(JSON.parse(store.readArtifact(runId, artifact.id)) as ScopeRecord);
    } catch {}
  }
  return records;
}

/**
 * What a person can do about a corrective that cannot write the files its failing check names
 * (`out_of_scope_failure`): fix them in the workspace and resume with the change accepted, or
 * revise the plan so a task may write them. A plain resume would start the same sessions again.
 */
export function outOfScopeAdvice(runId: string, message: string, paths: string[]): RecoveryAdvice {
  const files = paths.slice(0, 5).join(", ");
  return recoveryAdvice(
    `${message} Fix ${files} yourself and resume with \`baked workflow resume ${runId} --accept-workspace\`, or revise the plan so a task may write them (\`baked workflow revise ${runId}\`); a plain resume starts the same correction again.`,
    `A correction cannot write ${files}, which its failing check names. Fix the files and accept the change, or revise the plan.`,
    { action: "accept-workspace", runId },
    { action: "revise", runId },
    { action: "cancel", runId },
  );
}
