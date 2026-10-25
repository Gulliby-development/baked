import { confidenceOnlyNote, type FindingLabels, findingBlocks } from "../verification/findings.js";
import { type ReproOutcome, reproAllows } from "../verification/repro.js";
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
  };
}

/**
 * A finding the severity floor does not demote once the host reproduces it: it is based on the
 * spec and carries a repro. dirdrift-update 6b57dc61 completed with AC-005 failing because its
 * confirmed medium finding arrived after the first repair round (#801).
 */
const confirmable = (f: GateFinding): boolean => (f.basis ?? "spec") === "spec" && f.repro;

/**
 * The findings whose repro the review runs before deciding: those of a required reviewer, not a
 * sibling's, at a severity it blocks on, at a severity the run repairs or confirmable, and not
 * inferred. A claim kept a note only for its confidence competes too, as in the converge stage
 * (#1210, #1415).
 */
export function reviewGateCandidates(gate: ReviewGate): GateFinding[] {
  if (!gate.required) return [];
  return gate.findings.filter(
    (f) =>
      !f.sibling &&
      gate.blocking.includes(f.severity) &&
      (gate.severities.includes(f.severity) || confirmable(f)) &&
      (findingBlocks(labels(f), gate.minConfidence) ||
        confidenceOnlyNote(labels(f), gate.minConfidence)),
  );
}

/**
 * The findings (by ID) that start a correction. A candidate at a repaired severity passes the repro
 * gate (#155); one below it, or kept a note only for its confidence, repairs only when reproduced.
 */
export function reviewGateDecision(gate: ReviewGate): string[] {
  return reviewGateCandidates(gate)
    .filter((f) =>
      gate.severities.includes(f.severity) && !confidenceOnlyNote(labels(f), gate.minConfidence)
        ? reproAllows(labels(f), f.outcome ?? undefined, gate.reproAvailable)
        : f.outcome === "reproduced",
    )
    .map((f) => f.id);
}
