// What `sizing.fewPathPrice` did to each feature (#2640), as the estimate, the split's budget
// preview and the `feature.share_gate` record carry it. Record only: nothing decides on it.
// Free of Node imports: the desktop renderer reads it through the split preview.

/** A token range as the estimate writes one. */
interface Range {
  low: number;
  high: number;
}

/**
 * Why the few-path rule did or did not price a feature:
 * - `fewer-paths`: fewer paths than its size pool's median, in a pool with no path fit; applied.
 * - `legal`: legal files alone (a `LICENSE`), priced at the path rate; applied.
 * - `documentation`: documents the program, so its documented surface prices it; kept.
 * - `not-fewer`: at or above its pool's median paths; kept.
 * - `path-fit`: its pool's path fit placed it by its paths; kept.
 * - `no-pool`: no finished features of its size price it yet (the first split of a project); kept.
 * - `no-paths`: its boundary names no paths, or its pool's features name none; kept.
 */
export type FewPathReason =
  | "fewer-paths"
  | "legal"
  | "documentation"
  | "not-fewer"
  | "path-fit"
  | "no-pool"
  | "no-paths";

/**
 * The few-path rule on one feature, with `sizing.fewPathPrice` on (R92: the knob was on and no
 * record said whether it priced anything). `before` is the range the rule replaced and `after`
 * the one it set, before the floors that may raise it; equal when it did not apply. `share` is
 * the square root of `paths` over the pool's `medianPaths` (`fewer-paths` only).
 */
export interface FewPathShareRecord {
  applied: boolean;
  reason: FewPathReason;
  share?: number;
  paths?: number;
  medianPaths?: number;
  before: Range;
  after: Range;
}

/**
 * The record of the rule: applied for `legal`, and for `fewer-paths` with its `share`; kept with
 * `reason` otherwise.
 */
export function fewPathShareRecord(input: {
  reason: FewPathReason;
  before: Range;
  after: Range;
  share?: number | null;
  paths?: number;
  medianPaths?: number;
}): FewPathShareRecord {
  const share = input.reason === "fewer-paths" ? input.share : null;
  return {
    applied: input.reason === "legal" || typeof share === "number",
    reason: input.reason,
    ...(typeof share === "number" ? { share: Math.round(share * 1000) / 1000 } : {}),
    ...(input.paths ? { paths: input.paths } : {}),
    ...(input.medianPaths ? { medianPaths: input.medianPaths } : {}),
    before: { low: Math.round(input.before.low), high: Math.round(input.before.high) },
    after: { low: Math.round(input.after.low), high: Math.round(input.after.high) },
  };
}

/** A token count as the estimates write it (`tokenText`): 840k, 2.4M. */
const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;

/**
 * The few-path rule in one sentence, for the split preview line (#2640): the features it priced,
 * each with its share or reason and its low end before and after, and how many it kept by reason.
 * Empty without records (the knob off).
 */
export function fewPathShareText(records: Record<string, FewPathShareRecord>): string {
  const entries = Object.entries(records);
  if (!entries.length) return "";
  const applied = entries
    .filter(([, r]) => r.applied)
    .map(
      ([id, r]) =>
        `${id} ${r.reason === "legal" ? "at the path rate" : `x${r.share}`} (low ${tokens(r.before.low)} to ${tokens(r.after.low)})`,
    );
  const kept = new Map<FewPathReason, number>();
  for (const [, r] of entries) if (!r.applied) kept.set(r.reason, (kept.get(r.reason) ?? 0) + 1);
  const keptText = [...kept].map(([reason, n]) => `${n} ${reason}`).join(", ");
  return ` Few-path share: ${applied.length ? applied.join(", ") : "applied to none"}${keptText ? `; kept ${keptText}` : ""}.`;
}
