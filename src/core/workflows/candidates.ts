import { createHash } from "node:crypto";

/**
 * Best-of-N candidates (#642): a planned task implemented several times, each in its own worktree,
 * and one candidate selected for integration. This module holds the policy bounds and the
 * selection; the scheduler runs the candidates and records what this decides.
 */

/** Upper bound of `candidates` and `maxCandidates`. */
export const MAX_CANDIDATES = 8;
/** `maxCandidates` when the policy leaves it out. */
export const DEFAULT_MAX_CANDIDATES = 4;

/** How many candidates each planned task of a run gets: 1 means the task runs once. */
export function candidateCount(policy: { candidates?: number | undefined }): number {
  return policy.candidates ?? 1;
}

/** One finished candidate, as the selection sees it. */
export interface CandidateResult {
  /** 1-based position among the task's candidates. */
  index: number;
  outcome: "done" | "rejected" | "interrupted";
  /** Required task checks that did not pass; empty when every one passed. */
  failedChecks: string[];
  /** Hash of the candidate's changed files with whitespace normalized; null without a result. */
  fingerprint: string | null;
  /** Added plus removed lines of the candidate's patch. */
  changedLines: number;
  /** The critic's score, when the critic judged this candidate. */
  score: number | null;
  error?: string;
}

export interface CandidateSelection {
  /** The candidate to integrate, or null when none finished its implementation. */
  winner: number | null;
  method: "only" | "vote" | "critic" | "smallest" | "fewest-failures" | "none";
  reason: string;
  /** Candidates that finished and passed every required task check. */
  passing: number[];
  /** Passing candidates grouped by identical normalized change, largest group first. */
  clusters: number[][];
  /** The candidates the vote could not separate. */
  finalists: number[];
}

/**
 * A change's identity for the vote: each changed file's content with trailing whitespace dropped,
 * runs of whitespace collapsed and blank lines removed, so candidates that differ only in layout
 * count as the same change.
 */
export function normalizedFingerprint(files: readonly [string, string | null][]): string {
  const hash = createHash("sha256");
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`${path}\0`);
    if (content === null) hash.update("\0deleted\0");
    else
      hash.update(
        content
          .split(/\r?\n/)
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n"),
      );
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Added plus removed lines of a unified diff. */
export function changedLineCount(patch: string): number {
  return patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    ).length;
}

const passes = (r: CandidateResult): boolean => r.outcome === "done" && !r.failedChecks.length;
const smaller = (a: CandidateResult, b: CandidateResult): number =>
  a.changedLines - b.changedLines || a.index - b.index;
const best = (results: CandidateResult[]): CandidateResult | undefined =>
  [...results].sort(smaller)[0];
const list = (indexes: number[]): string => indexes.join(", ");

/** Passing candidates grouped by fingerprint, the largest group first, then the smallest change. */
export function voteClusters(results: CandidateResult[]): CandidateResult[][] {
  const groups = new Map<string, CandidateResult[]>();
  for (const r of results.filter(passes)) {
    const key = r.fingerprint ?? `#${String(r.index)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((group) => [...group].sort(smaller))
    .sort(
      (a, b) => b.length - a.length || smaller(a[0] as CandidateResult, b[0] as CandidateResult),
    );
}

/**
 * The candidates the critic should score: every passing one when the calibrated critic decides,
 * else the finalists of a tied vote; empty when the vote or the checks already decide.
 */
export function candidatesToJudge(results: CandidateResult[], criticDecides: boolean): number[] {
  const passing = results.filter(passes);
  if (passing.length < 2) return [];
  if (criticDecides) return passing.map((r) => r.index);
  const clusters = voteClusters(results);
  const top = clusters[0]?.length ?? 0;
  const tied = clusters.filter((c) => c.length === top);
  return tied.length > 1 ? tied.map((c) => (c[0] as CandidateResult).index) : [];
}

/**
 * Picks the candidate to integrate. Candidates that did not finish or failed a required task
 * check drop out; the passing ones vote by identical normalized change. A calibrated critic in
 * `select` mode (`criticDecides`) picks the best-scored passing candidate instead of the vote;
 * otherwise critic scores break a tie between finalists, and the smallest change breaks what
 * is left. When no candidate passes, the one with the fewest failing checks goes on to repair.
 */
export function selectCandidate(
  results: CandidateResult[],
  criticDecides = false,
): CandidateSelection {
  const passing = results.filter(passes);
  const clusters = voteClusters(results);
  const base = {
    passing: passing.map((r) => r.index),
    clusters: clusters.map((c) => c.map((r) => r.index)),
  };
  const total = results.length;
  if (!passing.length) {
    const done = results
      .filter((r) => r.outcome === "done")
      .sort((a, b) => a.failedChecks.length - b.failedChecks.length || smaller(a, b));
    const first = done[0];
    if (!first)
      return {
        ...base,
        winner: null,
        method: "none",
        reason: `None of the ${String(total)} candidates finished its implementation`,
        finalists: [],
      };
    return {
      ...base,
      winner: first.index,
      method: "fewest-failures",
      reason: `No candidate passed its required checks; candidate ${String(first.index)} failed the fewest (${first.failedChecks.join(", ")}) and goes on to repair`,
      finalists: done.map((r) => r.index),
    };
  }
  if (passing.length === 1) {
    const only = passing[0] as CandidateResult;
    return {
      ...base,
      winner: only.index,
      method: "only",
      reason: `Only candidate ${String(only.index)} of ${String(total)} passed its required checks`,
      finalists: [only.index],
    };
  }
  const scored = (pool: CandidateResult[]): CandidateResult | undefined =>
    [...pool]
      .filter((r) => r.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || smaller(a, b))[0];
  if (criticDecides) {
    const top = scored(passing);
    if (top)
      return {
        ...base,
        winner: top.index,
        method: "critic",
        reason: `The calibrated critic scored candidate ${String(top.index)} highest (${(top.score ?? 0).toFixed(2)}) of the ${String(passing.length)} candidates that passed their checks`,
        finalists: passing.map((r) => r.index),
      };
  }
  const size = clusters[0]?.length ?? 0;
  const tied = clusters.filter((c) => c.length === size);
  if (tied.length === 1) {
    const winner = (tied[0] as CandidateResult[])[0] as CandidateResult;
    return {
      ...base,
      winner: winner.index,
      method: "vote",
      reason: `${String(size)} of the ${String(passing.length)} candidates that passed their checks made the same change`,
      finalists: [winner.index],
    };
  }
  const finalists = tied.map((c) => c[0] as CandidateResult);
  const lead =
    size > 1
      ? `Candidates ${list(finalists.map((r) => r.index))} tied in the vote (${String(size)} each)`
      : `The ${String(passing.length)} candidates that passed their checks all made different changes`;
  const judged = scored(finalists);
  if (judged)
    return {
      ...base,
      winner: judged.index,
      method: "critic",
      reason: `${lead}; the critic scored candidate ${String(judged.index)} highest (${(judged.score ?? 0).toFixed(2)})`,
      finalists: finalists.map((r) => r.index),
    };
  const smallest = best(finalists) as CandidateResult;
  return {
    ...base,
    winner: smallest.index,
    method: "smallest",
    reason: `${lead}; candidate ${String(smallest.index)} makes the smallest change (${String(smallest.changedLines)} lines)`,
    finalists: finalists.map((r) => r.index),
  };
}
