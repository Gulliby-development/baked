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

/** A finding that returns to a defect an earlier correction of the run already addressed. */
export interface Contradiction {
  findingId: string;
  earlierId: string;
  earlierClaim: string;
  /** How the repeat was recognized: the reviewer named it, or the locations match. */
  via?: "repeatOf" | "location";
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
    /** The earlier finding the reviewer says this one repeats, when it said so. */
    repeatOf?: string | null;
    /** Whether the finding carries a reproduction the host ran (a static trace has none). */
    reproduced?: boolean;
  }[];
  contradictions: Contradiction[];
  /** What the `assume` rule does with this stop and why; absent when a person always decides. */
  hostRule?: HostRule;
}

/** The rule of `clarification: assume` for a stopped convergence, shown with the request. */
export interface HostRule {
  decision: "accept" | "extend" | "ask";
  /** The rules the host applies, in order. */
  rules: string[];
  /** Why the host chose `decision` for this stop. */
  why: string;
}

/** The limits of the `assume` rule for a stopped convergence. */
export const ASSUME_RULE = {
  /** Distinct findings that may remain and be accepted as known limitations. */
  maxFindings: 2,
  /** Rounds granted automatically after a contradiction stop. */
  extensions: 1,
} as const;

const ASSUME_RULES = [
  `Accept the findings as known limitations when every required check passes, at most ${String(ASSUME_RULE.maxFindings)} distinct findings remain, none is critical, and none is high with a reproduction the host ran.`,
  `On a contradiction stop, repair one more round before deciding (${String(ASSUME_RULE.extensions)} time per run): a repeated finding is often an incomplete earlier fix.`,
  "Otherwise ask a person.",
];

/**
 * The identity of a finding set: the same claims against the same criteria. A failed task check
 * names the corrective task that ran it, a new ID every round, so the ID is left out.
 */
export const findingSetHash = (findings: Review["findings"]): string =>
  hashJson(
    findings
      .map((f) => ({
        claim: f.claim.replace(/^Task T\d+ required check /, "Task required check "),
        criteria: f.criterionIds,
        impact: f.impact,
      }))
      .sort((a, b) => a.claim.localeCompare(b.claim)),
  );

const symbolTokens = (symbol: string | null | undefined): Set<string> =>
  new Set(
    (symbol ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_$]+/)
      .filter((token) => token.length > 1),
  );

/** Whether two locations name the same code: the same file and overlapping symbols. */
function sameLocation(
  earlier: Partial<Finding>,
  finding: Pick<Finding, "file" | "symbol" | "kind">,
): boolean {
  if (earlier.file !== finding.file) return false;
  const a = symbolTokens(earlier.symbol);
  const b = symbolTokens(finding.symbol);
  // Without a symbol the file is all that locates it, so the kind must agree too.
  if (!a.size && !b.size) return earlier.kind === finding.kind;
  return [...a].some((token) => b.has(token));
}

/**
 * The findings ledger: a finding that repeats one an earlier correction of the run already
 * addressed. A reviewer words the same defect differently each round and the finding ids change
 * with it (md-site F2, F2-2, F2-3 on one unreadable-file test; expenses-py A F-001..F-003 on
 * 28-digit Decimal), so the claim and the id are not the key. The reviewer is asked to name the
 * earlier finding (`repeatOf`) and that is the key: `repeatOf: null` says the defect is new, which
 * ends the false stops on one file or function that holds different defects (jsonshape, expenses-py
 * A `_share` underflow after overflow). A finding without the field (a reviewer that did not say)
 * falls back to the location: the same file, a shared symbol word and a shared criterion. The
 * second occurrence is a residual: another repair would likely undo the first one or chase the
 * same edge again, so a decision is requested instead.
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
  return findings.flatMap((finding): Contradiction[] => {
    if (finding.repeatOf === null) return [];
    const named = finding.repeatOf ? earlier.find((e) => e.id === finding.repeatOf) : undefined;
    if (named)
      return [
        {
          findingId: finding.id,
          earlierId: named.id,
          earlierClaim: named.body.claim ?? "",
          via: "repeatOf",
        },
      ];
    // A finding without a file has no location to recognize.
    if (!finding.file) return [];
    const match = earlier.find(
      (e) =>
        sameLocation(e.body, finding) &&
        (e.body.criterionIds ?? []).some((id) => finding.criterionIds.includes(id)),
    );
    return match
      ? [
          {
            findingId: finding.id,
            earlierId: match.id,
            earlierClaim: match.body.claim ?? "",
            via: "location",
          },
        ]
      : [];
  });
}

/**
 * The earlier findings a reviewer can name in `repeatOf`: those a correction of the run already
 * addressed. Capped so a long run does not grow the prompt.
 */
export function earlierFindings(
  store: WorkflowStore,
  runId: string,
): {
  id: string;
  criterionIds: string[];
  file: string | null;
  symbol: string | null;
  claim: string;
}[] {
  return store
    .findings(runId)
    .filter((row) => row.repair_task_id)
    .slice(-30)
    .map((row) => {
      const body = JSON.parse(row.body_json) as Partial<Finding>;
      return {
        id: row.id,
        criterionIds: body.criterionIds ?? [],
        file: body.file ?? null,
        symbol: body.symbol ?? null,
        claim: (body.claim ?? "").slice(0, 300),
      };
    });
}

/** What the reviewer is told next to the earlier findings. */
export const REPEAT_NOTE =
  "earlierFindings are findings a correction of this run already addressed. Set repeatOf on every finding: the id of the earlier finding when it is the same defect (the same root cause, even if the file, symbol or wording changed or the earlier fix was only partial), and null when it is a different defect, even in the same file or function.";

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

/** Distinct findings: a finding that repeats another counts with it. */
const distinctFindings = (findings: ConvergenceRequestBody["findings"]): number =>
  new Set(findings.map((f) => f.repeatOf ?? f.id)).size;

/**
 * What the `assume` rule does with a stopped convergence. The share of failing criteria is not
 * the measure (2 of 7 criteria is 28.6% and one defect in a shared function fails 2 or 3 of
 * them): the count of distinct findings is. Under `assume` and with every required check
 * passing, at most `ASSUME_RULE.maxFindings` distinct findings none critical and none high with
 * a reproduction the host ran are accepted as known limitations. A contradiction stop first
 * repairs one more round (jsonshape 079329e3: the repeat was an incomplete fix and one more round
 * repaired it). Everything else goes to a person, with the reason in the request.
 */
export function assumeDecision(
  policy: RunPolicy,
  state: Pick<RuntimeState, "autoExtensions">,
  stop: Pick<ConvergenceStop, "reason">,
  body: Pick<ConvergenceRequestBody, "checksPassing" | "criteria" | "findings">,
): HostRule | null {
  if (policy.clarification !== "assume") return null;
  const count = distinctFindings(body.findings);
  const rules = [...ASSUME_RULES];
  if (stop.reason === "contradiction" && state.autoExtensions < ASSUME_RULE.extensions)
    return {
      decision: "extend",
      rules,
      why: `A finding repeats an earlier one: one more round is granted before the residual is judged (${String(count)} distinct finding(s) now).`,
    };
  const blockers: string[] = [];
  if (!body.checksPassing) blockers.push("a required check does not pass");
  if (body.criteria.total === 0) blockers.push("the spec has no criteria");
  if (count > ASSUME_RULE.maxFindings)
    blockers.push(
      `${String(count)} distinct findings remain (at most ${String(ASSUME_RULE.maxFindings)} are accepted)`,
    );
  for (const f of body.findings) {
    if (f.severity === "critical") blockers.push(`${f.id} is critical`);
    else if (f.severity === "high" && f.reproduced !== false)
      blockers.push(`${f.id} is high with a reproduction`);
  }
  return blockers.length
    ? { decision: "ask", rules, why: `A person decides: ${blockers.join("; ")}.` }
    : {
        decision: "accept",
        rules,
        why: `Every required check passes and ${String(count)} distinct finding(s) remain, none critical and none high with a reproduction.`,
      };
}

/**
 * Raises the limits that stopped a convergence just far enough for `findings` to be repaired now
 * and records them as decided, so the same stop does not ask again. A person's "one more round"
 * and the automatic extension of the `assume` rule both use it.
 */
export function grantRound(
  store: WorkflowStore,
  runId: string,
  state: RuntimeState,
  policy: RunPolicy,
  findings: readonly { id: string }[],
): void {
  const run = store.run(runId);
  state.extraConvergenceRounds = Math.max(
    state.extraConvergenceRounds,
    run.convergence_rounds + 1 - policy.maxConvergenceRounds,
  );
  state.extraCorrectiveTasks = Math.max(
    state.extraCorrectiveTasks,
    run.corrective_tasks + findings.length - policy.maxCorrectiveTasks,
  );
  state.previousFindingSet = null;
  state.noProgressRounds = 0;
  state.decidedFindings = [...new Set([...state.decidedFindings, ...findings.map((f) => f.id)])];
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
          : "a finding repeats one an earlier correction of the run already addressed";
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
      ...(f.repeatOf !== undefined ? { repeatOf: f.repeatOf } : {}),
      reproduced: f.repro !== undefined,
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

const TEST_OR_DOC_PATH =
  /(?:^|\/)(?:tests?|__tests__|spec|specs|docs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|\.(?:md|mdx|rst)$/i;

/** Whether a path is a test or documentation file, the only place a medium finding may pass with notes. */
export const testOrDocFile = (file: string | null): boolean =>
  file !== null && TEST_OR_DOC_PATH.test(file.replaceAll("\\", "/"));

/**
 * Whether a finding passes with notes instead of starting a repair: it is `partial` (test
 * strength or documentation completeness, not a defect in behavior), every required check passes
 * and each criterion it names has evidence in the review. Low severity qualifies; medium does too
 * when the finding is on a test or documentation file only, since the behavior is verified and the
 * gap is in how well it is pinned or described (md-site and url-shortener B spent about 600k each
 * on such findings). zoneslot 409f3022 F-001 (the Kolkata test did not assert every UTC column)
 * cost 263k, 23% of its run, while the behavior was already verified. A `missing` finding on a test
 * or documentation file qualifies as well: reviewers label an absent test or README section
 * `missing` rather than `partial` (all 5 such repairs in round R06, about 635k), and the gap is the
 * same kind when every criterion it names has evidence. A low `correctness` or `contradicts`
 * finding qualifies too: with every required check passing it is a detail the checks accept
 * (junitdigest 3e5be74b spent about 1.1M each on `time.After` in a test helper and `%q` in an
 * error message, #744), not a reason for another convergence round.
 */
export function passesWithNotes(
  finding: Finding,
  coverage: Review["coverage"],
  checksPass: boolean,
): boolean {
  return (
    checksPass &&
    (finding.severity === "low" ||
      (finding.severity === "medium" && testOrDocFile(finding.file))) &&
    (finding.kind === "partial" ||
      (finding.kind === "missing" && testOrDocFile(finding.file)) ||
      (finding.severity === "low" &&
        (finding.kind === "correctness" || finding.kind === "contradicts"))) &&
    finding.criterionIds.length > 0 &&
    finding.criterionIds.every(
      (id) => (coverage.find((c) => c.criterionId === id)?.evidenceIds.length ?? 0) > 0,
    )
  );
}

/** Criteria whose failing verdict a known limitation covers. */
export const limitedCriteria = (state: Pick<RuntimeState, "limitations">): Set<string> =>
  new Set(state.limitations.flatMap((l) => l.criterionIds));

/**
 * Records criteria that convergence could not verify, and that no finding names, as known
 * limitations. A criterion only another environment can prove (propdrift eea2e0e9 AC-008, "behavior
 * is confirmed on Windows, macOS, and Linux", on a single-host runner) comes back `inconclusive`:
 * the reviewer cannot raise a defect for a limit of the environment, and a repair has nothing to
 * change. Returns the limitations added.
 */
export function noteUnverifiedCriteria(
  state: Pick<RuntimeState, "limitations">,
  coverage: Review["coverage"],
  criterionIds: string[],
  round: number,
): Limitation[] {
  const added: Limitation[] = [];
  for (const criterionId of criterionIds) {
    const findingId = `unverified-${criterionId}`;
    if (state.limitations.some((l) => l.findingId === findingId)) continue;
    const explanation = coverage.find((c) => c.criterionId === criterionId)?.explanation ?? "";
    const limitation: Limitation = {
      findingId,
      severity: "low",
      kind: "unverified",
      criterionIds: [criterionId],
      file: null,
      symbol: null,
      claim: `Criterion ${criterionId} could not be verified on this host${explanation ? `: ${explanation.replace(/\s+/g, " ").slice(0, 400)}` : ""}`,
      impact: "The evidence needs an environment or device the run does not have",
      decidedBy: "notes",
      round,
    };
    state.limitations.push(limitation);
    added.push(limitation);
  }
  return added;
}
