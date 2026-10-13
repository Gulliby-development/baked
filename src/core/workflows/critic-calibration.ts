/**
 * Calibration of the critic from the project's outcome log (#646 step 3). A critic only earns a say
 * in what a run does (`select`, `earlyStop`) once its scores separate attempts that held up from
 * those that did not on this project's own history: a judge trained on benchmarks scored near
 * random on production outcomes, and value came from project-specific labels.
 */
import type { CriticOutcomeRow } from "./store.js";

/** Labelled attempts needed before the critic is trusted, and per class. */
export const MIN_CALIBRATION_SAMPLES = 20;
export const MIN_CALIBRATION_CLASS = 5;
/** Ranking quality below which the scores are not used to decide anything. */
export const MIN_CALIBRATION_AUC = 0.65;
/** Share of an attempt's added lines that must survive for it to count as kept. */
const KEPT_SURVIVAL = 0.5;

export interface CriticCalibration {
  samples: number;
  good: number;
  bad: number;
  /** Probability that a good attempt scores above a bad one; null without both classes. */
  auc: number | null;
  /** The score at or above which an attempt is predicted good; null when not calibrated. */
  threshold: number | null;
  calibrated: boolean;
  /** Why the critic is not calibrated, when it is not. */
  reason: string | null;
}

/**
 * Whether an attempt held up: good when its checks passed and nothing later undid it, bad when it
 * needed a repair, its run failed, its delivery was reverted or most of its lines are gone. Null
 * when nothing labels it yet.
 */
export function outcomeLabel(row: CriticOutcomeRow): "good" | "bad" | null {
  const lost = row.survival_final === 1 && row.survival !== null && row.survival < KEPT_SURVIVAL;
  if (
    row.task_result === "repaired" ||
    row.acceptance === "rejected" ||
    row.delivery === "reverted" ||
    lost
  )
    return "bad";
  return row.task_result === "passed" ? "good" : null;
}

/** Area under the ROC curve of `scores` separating good from bad (ties count half). */
function auc(good: number[], bad: number[]): number {
  let wins = 0;
  for (const g of good) for (const b of bad) wins += g > b ? 1 : g === b ? 0.5 : 0;
  return wins / (good.length * bad.length);
}

/** Calibrates the critic from labelled rows: AUC and the threshold with the best Youden index. */
export function calibrateCritic(rows: readonly CriticOutcomeRow[]): CriticCalibration {
  const labelled = rows.flatMap((r) => {
    const label = outcomeLabel(r);
    return label ? [{ score: r.score, label }] : [];
  });
  const good = labelled.filter((l) => l.label === "good").map((l) => l.score);
  const bad = labelled.filter((l) => l.label === "bad").map((l) => l.score);
  const base = { samples: labelled.length, good: good.length, bad: bad.length };
  const area = good.length && bad.length ? auc(good, bad) : null;
  const refuse = (reason: string): CriticCalibration => ({
    ...base,
    auc: area,
    threshold: null,
    calibrated: false,
    reason,
  });
  if (labelled.length < MIN_CALIBRATION_SAMPLES)
    return refuse(
      `${String(labelled.length)} of ${String(MIN_CALIBRATION_SAMPLES)} labelled attempts`,
    );
  if (good.length < MIN_CALIBRATION_CLASS || bad.length < MIN_CALIBRATION_CLASS)
    return refuse(
      `needs at least ${String(MIN_CALIBRATION_CLASS)} attempts that held up and ${String(MIN_CALIBRATION_CLASS)} that did not (${String(good.length)} and ${String(bad.length)})`,
    );
  if (area === null || area < MIN_CALIBRATION_AUC)
    return refuse(
      `scores do not separate outcomes well enough (AUC ${(area ?? 0).toFixed(2)}, needs ${MIN_CALIBRATION_AUC.toFixed(2)})`,
    );
  let best = { threshold: 1, j: -1 };
  for (const t of [...new Set(labelled.map((l) => l.score))].sort((a, b) => a - b)) {
    const tpr = good.filter((s) => s >= t).length / good.length;
    const fpr = bad.filter((s) => s >= t).length / bad.length;
    if (tpr - fpr > best.j) best = { threshold: t, j: tpr - fpr };
  }
  return { ...base, auc: area, threshold: best.threshold, calibrated: true, reason: null };
}

/**
 * Earlier attempts of the project shown to the critic as examples: up to two that held up and two
 * that did not, newest first, each with its score, outcome and weakest rubric item.
 */
export function criticExamples(
  rows: readonly CriticOutcomeRow[],
  limit = 2,
): { score: number; outcome: "held up" | "did not hold up"; weakest: string }[] {
  const pick = (label: "good" | "bad") =>
    rows
      .filter((r) => outcomeLabel(r) === label)
      .slice(-limit)
      .reverse()
      .map((r) => {
        const rubric = JSON.parse(r.rubric_json) as Record<string, { score: number; note: string }>;
        const [name, item] = Object.entries(rubric).sort(
          ([, a], [, b]) => a.score - b.score,
        )[0] ?? ["", { score: 0, note: "" }];
        return {
          score: r.score,
          outcome: label === "good" ? ("held up" as const) : ("did not hold up" as const),
          weakest: name ? `${name} ${item.score.toFixed(2)}: ${item.note}` : "",
        };
      });
  return [...pick("good"), ...pick("bad")];
}

/** The attempt `select` keeps among candidates of one task: the highest critic score. */
export function selectAttempt<T extends { score: number | null }>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  for (const c of candidates)
    if (c.score !== null && (best === null || c.score > (best.score ?? -1))) best = c;
  return best;
}
