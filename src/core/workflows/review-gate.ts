import { type NotesCriterion, notesPass, testOrDocFile } from "../verification/convergence-stop.js";
import { confidenceOnlyNote, type FindingLabels, findingBlocks } from "../verification/findings.js";
import { convergenceReproGated, type ReproOutcome, reproAllows } from "../verification/repro.js";
import type { Review } from "./schemas.js";

type Finding = Review["findings"][number];

/**
 * What the review gate knows of a finding: its labels and whether a repro showed it, never the
 * claim, file or repro text, so a bench trace keeps it (#1715).
 */
export interface GateFinding {
  id: string;
  severity: Finding["severity"];
  kind: Finding["kind"];
  basis: NonNullable<Finding["basis"]> | null;
  confidence: number | null;
  /** The finding carries a repro. */
  repro: boolean;
  /** Another reviewer of the run already reported it, so it stays a note. */
  sibling: boolean;
  /** Its repro's outcome, run only for a candidate while a program can run it. */
  outcome: ReproOutcome["status"] | null;
  /**
   * The reviewer set `noRepro`: it says no command can show the claim, so a repro it also attached
   * is no evidence (#2194). Absent in gates recorded before it.
   */
  noRepro?: boolean;
  /**
   * `edgeCrashDecision` on an inconclusive repro's output against the finding's file (#2152,
   * shadow, `reproCrash`): `finding` when the repro crashed inside that file. Absent when the
   * repro was not inconclusive, and in records before #2152.
   */
  crash?: "finding" | "pass";
}

export interface ReviewGate {
  /** The reviewer's key: the gate ID for a v2 workflow, the dimension for v1. */
  reviewer: string;
  required: boolean;
  /** The severities the reviewer blocks on. */
  blocking: readonly string[];
  /** The severities the run repairs this round. */
  severities: readonly string[];
  minConfidence: number;
  /** One of the run's checks starts a program a repro may run. */
  reproAvailable: boolean;
  findings: GateFinding[];
}

/** Each review's gate is recorded as `review-gate/<reviewer>-<id>.json` (kind `review-gate`, kept in bench traces). */
export const REVIEW_GATE_KIND = "review-gate";
export const REVIEW_GATE_DIR = "review-gate/";

export interface ReviewGateRecord extends ReviewGate {
  schemaVersion: 1;
  /** The finding IDs that started a correction. */
  repaired: string[];
}

const labels = (f: GateFinding): FindingLabels => ({
  severity: f.severity,
  kind: f.kind,
  ...(f.basis ? { basis: f.basis } : {}),
  ...(f.confidence === null ? {} : { confidence: f.confidence }),
});

export function gateFinding(
  finding: Finding,
  sibling: boolean,
  outcome: ReproOutcome["status"] | undefined,
): GateFinding {
  return {
    id: finding.id,
    severity: finding.severity,
    kind: finding.kind,
    basis: finding.basis ?? null,
    confidence: finding.confidence ?? null,
    repro: finding.repro !== undefined,
    sibling,
    outcome: outcome ?? null,
    noRepro: !!finding.noRepro?.trim(),
  };
}

/**
 * A finding whose reproduction is evidence: one the reviewer did not mark `noRepro`. skillplumb
 * 9cdc5669 (R69) repaired a 0.1-confidence README note for 250k tokens because its repro, which
 * needed the README setup the host marked not_run, printed the error the note quoted; the note's
 * own `noRepro` said that setup was missing (#2194).
 */
const reproEvidence = (f: GateFinding): boolean => !f.noRepro;

/**
 * A finding the severity floor does not demote once the host reproduces it: it is based on the
 * spec and carries a repro. dirdrift-update 6b57dc61 completed with AC-005 failing because its
 * confirmed medium finding arrived after the first repair round (#801).
 */
const confirmable = (f: GateFinding): boolean =>
  (f.basis ?? "spec") === "spec" && f.repro && reproEvidence(f);

/**
 * The findings whose repro the review runs before deciding: those of a required reviewer, not a
 * sibling's, at a severity it blocks on, at a severity the run repairs or confirmable, and not
 * inferred. A claim kept a note only for its confidence competes too, as in the converge stage
 * (#1210, #1415), unless its reviewer marked it `noRepro`.
 */
export function reviewGateCandidates(gate: ReviewGate): GateFinding[] {
  if (!gate.required) return [];
  return gate.findings.filter(
    (f) =>
      !f.sibling &&
      gate.blocking.includes(f.severity) &&
      (gate.severities.includes(f.severity) || confirmable(f)) &&
      (findingBlocks(labels(f), gate.minConfidence) ||
        (confidenceOnlyNote(labels(f), gate.minConfidence) && reproEvidence(f))),
  );
}

/**
 * Whether the repro gate lets a finding start a correction (`reproAllows`), or with `crash` also
 * when its inconclusive repro crashed inside the finding's own file (#2152). The `crash` form is
 * the shadow rule of `edge_crash_finding`: decided and recorded, not yet applied.
 */
const gateAllows = (f: GateFinding, available: boolean, crash: boolean): boolean =>
  reproAllows(labels(f), f.outcome ?? undefined, available) ||
  (crash && f.outcome === "inconclusive" && f.crash === "finding");

/**
 * The findings (by ID) that start a correction. A candidate at a repaired severity passes the repro
 * gate (#155); one below it, or kept a note only for its confidence, repairs only when reproduced.
 * `crash` decides with the shadow crash rule (`gateAllows`).
 */
export function reviewGateDecision(gate: ReviewGate, crash = false): string[] {
  return reviewGateCandidates(gate)
    .filter((f) =>
      gate.severities.includes(f.severity) && !confidenceOnlyNote(labels(f), gate.minConfidence)
        ? gateAllows(f, gate.reproAvailable, crash)
        : f.outcome === "reproduced",
    )
    .map((f) => f.id);
}

/**
 * The findings the repro gate keeps notes that the shadow crash rule would repair (#2152): their
 * repro was inconclusive and crashed inside the finding's own file. Each records an
 * `edge_crash_finding` would-stop; nothing changes until the reason is promoted with #2136's.
 */
export function reviewGateCrashKeeps(gate: ReviewGate): string[] {
  const decided = new Set(reviewGateDecision(gate));
  return reviewGateDecision(gate, true).filter((id) => !decided.has(id));
}

/** What the convergence gate knows of a finding: the review gate's labels and what the notes rule reads. */
export interface ConvergenceGateFinding extends GateFinding {
  /** The finding is on a test or documentation file. */
  testOrDoc: boolean;
  criterionIds: string[];
}

export interface ConvergenceGate {
  /** The severities the run repairs this round. */
  severities: readonly string[];
  minConfidence: number;
  /** Every required check passes on the reviewed snapshot. */
  checksPass: boolean;
  /** One of the run's checks starts a program a repro may run. */
  reproAvailable: boolean;
  /** The walker was offered `run_repro`, so an unshown claim is held to its repro (#930). */
  canRepro: boolean;
  /** Each criterion's verdict (after initiative deferral) and evidence count. */
  criteria: NotesCriterion[];
  /** The criteria that fail or are inconclusive and automated, before the gate. */
  failing: string[];
  findings: ConvergenceGateFinding[];
}

/**
 * `repair` starts a correction; `notes` and `repro` are known limitations accepted by the notes
 * rule or the repro gate; `note` is a review note.
 */
export type ConvergenceVerdict = "repair" | "notes" | "repro" | "note";

export interface ConvergenceDecision {
  verdicts: { id: string; verdict: ConvergenceVerdict }[];
  /** The criteria still failing: those not named only by notes and unshown claims. */
  failing: string[];
  /** The claims below high severity the host did not reproduce, whatever their verdict. */
  unreproduced: string[];
}

/** Each convergence gate is recorded as `convergence-gate/<id>.json` (kind `convergence-gate`, kept in bench traces). */
export const CONVERGENCE_GATE_KIND = "convergence-gate";
export const CONVERGENCE_GATE_DIR = "convergence-gate/";

export interface ConvergenceGateRecord extends ConvergenceGate {
  schemaVersion: 1;
  decision: ConvergenceDecision;
}

export function convergenceGateFinding(
  finding: Finding,
  sibling: boolean,
  outcome: ReproOutcome["status"] | undefined,
): ConvergenceGateFinding {
  return {
    ...gateFinding(finding, sibling, outcome),
    testOrDoc: testOrDocFile(finding.file),
    criterionIds: [...finding.criterionIds],
  };
}

const notesOf = (gate: ConvergenceGate): Set<string> =>
  new Set(
    gate.findings
      .filter((f) => f.sibling || notesPass(f, gate.criteria, gate.checksPass))
      .map((f) => f.id),
  );

/**
 * The findings whose repro the converge stage runs: below high severity, or kept a note only for
 * their confidence (#1210) and not marked `noRepro` (#2194), and not a sibling's.
 */
export function convergenceReproCandidates(gate: ConvergenceGate): ConvergenceGateFinding[] {
  return gate.findings.filter(
    (f) =>
      !f.sibling &&
      (convergenceReproGated(labels(f)) ||
        (confidenceOnlyNote(labels(f), gate.minConfidence) && reproEvidence(f))) &&
      f.repro &&
      gate.reproAvailable,
  );
}

/**
 * The convergence gate. A low `partial` finding behind verified behavior passes with notes. Below
 * high severity, a correctness claim the host does not reproduce, and any claim its repro refutes,
 * is a known limitation when it would have repaired (cfgtrace2 e88a14dd, #930), and a criterion
 * only such findings name is accepted with them. A finding still repairs below the severity floor
 * when it is why a criterion fails: acceptance needs every automated criterion to pass.
 */
export function convergenceGateDecision(gate: ConvergenceGate, crash = false): ConvergenceDecision {
  const notes = notesOf(gate);
  const blocks = (f: ConvergenceGateFinding): boolean =>
    findingBlocks(
      labels(f),
      gate.minConfidence,
      confidenceOnlyNote(labels(f), gate.minConfidence) &&
        reproEvidence(f) &&
        f.outcome === "reproduced",
    );
  const unreproduced = new Set(
    gate.canRepro
      ? gate.findings
          .filter(
            (f) =>
              convergenceReproGated(labels(f)) && !notes.has(f.id) && !gateAllows(f, true, crash),
          )
          .map((f) => f.id)
      : [],
  );
  const failing = new Set(gate.failing);
  const repairing = (f: ConvergenceGateFinding): boolean =>
    (gate.severities.includes(f.severity) && blocks(f)) ||
    f.criterionIds.some((id) => failing.has(id));
  const noted = new Set(
    gate.findings.filter((f) => !f.sibling && notes.has(f.id) && repairing(f)).map((f) => f.id),
  );
  const unshown = new Set(
    gate.findings.filter((f) => unreproduced.has(f.id) && repairing(f)).map((f) => f.id),
  );
  // Taken while `failing` still holds the criteria they explain (lockorder 6487b225, #1225).
  for (const id of [...failing]) {
    const named = gate.findings.filter((f) => f.criterionIds.includes(id));
    if (named.length && named.every((f) => notes.has(f.id) || unreproduced.has(f.id)))
      failing.delete(id);
  }
  const repair = (f: ConvergenceGateFinding): boolean =>
    !notes.has(f.id) &&
    !unreproduced.has(f.id) &&
    ((gate.severities.includes(f.severity) && blocks(f)) ||
      f.criterionIds.some((id) => failing.has(id)));
  return {
    verdicts: gate.findings.map((f) => ({
      id: f.id,
      verdict: repair(f)
        ? "repair"
        : noted.has(f.id)
          ? "notes"
          : unshown.has(f.id)
            ? "repro"
            : "note",
    })),
    failing: [...failing],
    unreproduced: [...unreproduced],
  };
}

/**
 * The convergence findings the gate does not repair that the shadow crash rule would (#2152), as
 * `reviewGateCrashKeeps` for the review gate.
 */
export function convergenceGateCrashKeeps(gate: ConvergenceGate): string[] {
  const repaired = (decision: ConvergenceDecision) =>
    decision.verdicts.filter((v) => v.verdict === "repair").map((v) => v.id);
  const decided = new Set(repaired(convergenceGateDecision(gate)));
  return repaired(convergenceGateDecision(gate, true)).filter((id) => !decided.has(id));
}
