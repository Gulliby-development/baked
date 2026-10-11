import { hashJson } from "../specs/hash.js";
import type { Review, RunPolicy } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { Limitation, RuntimeState } from "../workflows/types.js";

type Finding = Review["findings"][number];

/**
 * Why convergence cannot start another correction round, and what a person decides then.
 * `rounds` and `tasks` are the policy limits, `repeat` is the same finding set twice in a row, and
 * `contradiction` is a finding on a symbol an earlier correction of the run already changed for
 * the same criterion (md-site F004 reversed the fix of F001).
 */
export type ConvergenceStopReason = "rounds" | "tasks" | "repeat" | "contradiction";

/** A finding that returns to a (criterion, file, symbol) an earlier correction already fixed. */
export interface Contradiction {
  findingId: string;
  earlierId: string;
  earlierClaim: string;
}

export interface ConvergenceStop {
  reason: ConvergenceStopReason;
  /** The policy setting that was reached, or null for `repeat` and `contradiction`. */
  setting: "maxConvergenceRounds" | "maxCorrectiveTasks" | null;
  limit: number | null;
  round: number;
  contradictions: Contradiction[];
}

/** What a convergence decision request carries; every surface renders it. */
export interface ConvergenceRequestBody {
  topic: "convergence";
  reason: ConvergenceStopReason;
  setting: ConvergenceStop["setting"];
  limit: number | null;
  round: number;
  /** One sentence for a person who sees only the headline. */
  summary: string;
  checksPassing: boolean;
  criteria: {
    total: number;
    passing: number;
    failing: { id: string; verdict: string; explanation: string }[];
  };
  findings: {
    id: string;
    severity: Finding["severity"];
    kind: Finding["kind"];
    criterionIds: string[];
    file: string | null;
    symbol: string | null;
    claim: string;
    impact: string;
    suggestedFix: string;
  }[];
  contradictions: Contradiction[];
}

/** The identity of a finding set: the same claims against the same criteria. */
export const findingSetHash = (findings: Review["findings"]): string =>
  hashJson(
    findings
      .map((f) => ({ claim: f.claim, criteria: f.criterionIds, impact: f.impact }))
      .sort((a, b) => a.claim.localeCompare(b.claim)),
  );

/**
 * The findings ledger: a finding keyed by (criterion, file, symbol) that an earlier correction of
 * the run already addressed. The new finding contradicts that fix when it names the same symbol
 * for the same criterion, so another repair would likely undo the first one.
 */
export function contradictions(
  store: WorkflowStore,
  runId: string,
  findings: Review["findings"],
): Contradiction[] {
  const live = new Set(findings.map((f) => f.id));
  const earlier = store
    .findings(runId)
    .filter((row) => row.repair_task_id && !live.has(row.id))
    .map((row) => ({ id: row.id, body: JSON.parse(row.body_json) as Partial<Finding> }));
  return findings.flatMap((finding) => {
    if (!finding.file || !finding.symbol) return [];
    const match = earlier.find(
      (e) =>
        e.body.file === finding.file &&
        e.body.symbol === finding.symbol &&
        (e.body.criterionIds ?? []).some((id) => finding.criterionIds.includes(id)),
    );
    return match
      ? [{ findingId: finding.id, earlierId: match.id, earlierClaim: match.body.claim ?? "" }]
      : [];
  });
}

/**
 * The reason the next convergence round must not start without a decision, or null when
 * `appendCorrections` may go on. Reads state, changes nothing.
 */
export function convergenceStop(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  findings: Review["findings"],
): ConvergenceStop | null {
  const run = store.run(runId);
  const round = run.convergence_rounds + 1;
  const limit = policy.maxConvergenceRounds + state.extraConvergenceRounds;
  const cap = policy.maxCorrectiveTasks + state.extraCorrectiveTasks;
  const found = contradictions(store, runId, findings).filter(
    (c) => !state.decidedFindings.includes(c.findingId),
  );
  const stop = (
    reason: ConvergenceStopReason,
    setting: ConvergenceStop["setting"],
    value: number | null,
  ): ConvergenceStop => ({ reason, setting, limit: value, round, contradictions: found });
  if (round > limit) return stop("rounds", "maxConvergenceRounds", limit);
  if (run.corrective_tasks + findings.length > cap) return stop("tasks", "maxCorrectiveTasks", cap);
  if (state.previousFindingSet === findingSetHash(findings)) return stop("repeat", null, null);
  if (found.length) return stop("contradiction", null, null);
  return null;
}

/** Whether every required check passed on the current snapshot; false without required checks. */
export function requiredChecksPass(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
): boolean {
  const ids = policy.checks.filter((c) => c.required).map((c) => c.id);
  if (!ids.length || !state.snapshotId) return false;
  const results = store.checks(runId);
  return ids.every((id) => {
    const last = results
      .filter((c) => c.check_id === id && c.snapshot_id === state.snapshotId)
      .at(-1);
    return last?.status === "passed" && last.validity === "current";
  });
}

/** The share of criteria that may fail for `clarification: assume` to accept the residual. */
export const ASSUME_FAILING_SHARE = 0.25;

/**
 * Whether the `assume` rule accepts the stopped convergence without asking: every required check
 * passes, only a small share of the criteria fail, and no remaining finding is critical or high.
 */
export function assumeAccepts(
  policy: RunPolicy,
  body: Pick<ConvergenceRequestBody, "checksPassing" | "criteria" | "findings">,
): boolean {
  return (
    policy.clarification === "assume" &&
    body.checksPassing &&
    body.criteria.total > 0 &&
    body.criteria.failing.length / body.criteria.total <= ASSUME_FAILING_SHARE &&
    body.findings.every((f) => f.severity !== "critical" && f.severity !== "high")
  );
}

/** The request body for a stopped convergence. */
export function convergenceBody(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  stop: ConvergenceStop,
  findings: Review["findings"],
): ConvergenceRequestBody {
  const coverage = state.convergence?.coverage ?? [];
  const automated = new Set(
    (state.spec?.criteria ?? []).filter((c) => c.method === "automated").map((c) => c.id),
  );
  const failing = coverage
    .filter(
      (c) => c.verdict === "fail" || (c.verdict === "inconclusive" && automated.has(c.criterionId)),
    )
    .map((c) => ({ id: c.criterionId, verdict: c.verdict, explanation: c.explanation }));
  const total = state.spec?.criteria.length ?? coverage.length;
  const cause =
    stop.reason === "rounds"
      ? `the ${stop.limit} convergence round(s) the policy allows are used`
      : stop.reason === "tasks"
        ? `the ${stop.limit} corrective task(s) the policy allows are used`
        : stop.reason === "repeat"
          ? "the last repair left the same findings"
          : "a new finding contradicts the fix of an earlier one on the same symbol";
  return {
    topic: "convergence",
    reason: stop.reason,
    setting: stop.setting,
    limit: stop.limit,
    round: stop.round,
    summary: `Convergence stopped: ${cause}. ${findings.length} finding(s) remain; ${failing.length} of ${total} criteria do not pass.`,
    checksPassing: requiredChecksPass(store, runId, state, policy),
    criteria: { total, passing: Math.max(0, total - failing.length), failing },
    findings: findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      kind: f.kind,
      criterionIds: f.criterionIds,
      file: f.file,
      symbol: f.symbol,
      claim: f.claim,
      impact: f.impact,
      suggestedFix: f.suggestedFix,
    })),
    contradictions: stop.contradictions,
  };
}

/**
 * Accepts the findings of a stopped convergence as known limitations: the run goes on to
 * acceptance with them open, and the report lists them. Findings leave the open set.
 */
export function acceptResidual(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  body: { findings: Omit<ConvergenceRequestBody["findings"][number], "suggestedFix">[] },
  decidedBy: Limitation["decidedBy"],
): void {
  const round = store.run(runId).convergence_rounds;
  for (const finding of body.findings) {
    if (state.limitations.some((l) => l.findingId === finding.id)) continue;
    state.limitations.push({
      findingId: finding.id,
      severity: finding.severity,
      kind: finding.kind,
      criterionIds: finding.criterionIds,
      file: finding.file,
      symbol: finding.symbol,
      claim: finding.claim,
      impact: finding.impact,
      decidedBy,
      round,
    });
    store.findingStatus(runId, finding.id, "resolved");
  }
}

/**
 * Whether a finding passes with notes instead of starting a repair: it is low severity and
 * `partial` (test strength or documentation completeness, not a defect in behavior), every
 * required check passes and each criterion it names has evidence in the review. zoneslot 409f3022
 * F-001 (the Kolkata test did not assert every UTC column) cost 263k, 23% of its run, while the
 * behavior was already verified.
 */
export function passesWithNotes(
  finding: Finding,
  coverage: Review["coverage"],
  checksPass: boolean,
): boolean {
  return (
    checksPass &&
    finding.severity === "low" &&
    finding.kind === "partial" &&
    finding.criterionIds.length > 0 &&
    finding.criterionIds.every(
      (id) => (coverage.find((c) => c.criterionId === id)?.evidenceIds.length ?? 0) > 0,
    )
  );
}

/** Criteria whose failing verdict a known limitation covers. */
export const limitedCriteria = (state: Pick<RuntimeState, "limitations">): Set<string> =>
  new Set(state.limitations.flatMap((l) => l.criterionIds));
