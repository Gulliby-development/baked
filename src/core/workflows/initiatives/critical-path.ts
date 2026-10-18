import {
  boundaryFiles,
  type InitiativeFeature,
  type InitiativePlan,
  MAX_FEATURES,
  MIN_FEATURE_PATHS,
  namedFiles,
  sizeWeight,
} from "./plan.js";

/**
 * The critical-path check of a split (#1522, opt-in with `criticalPath: "split"`). Features on
 * the longest dependency chain run one after another however many runs the initiative may start at
 * once, so one large feature there sets the wall time: bench round 43 (intsmith) held five
 * independent modules in its arithmetic feature, which took 38% of the wall time, and the parallel
 * speedup was 1.04x. The decomposer is asked once, at submission, to split such a feature into
 * parts that run side by side, or to say why its parts belong in one run.
 */

/** A feature holding more than this share of the path's work is asked about. */
export const CRITICAL_SHARE = 0.35;

/** The work of a feature, in the units of its size weight: its size or half its files. */
export function featureWork(
  feature: Pick<InitiativeFeature, "boundary" | "size">,
  named: readonly string[],
): number {
  return Math.max(sizeWeight(feature), (boundaryFiles(feature, named)?.length ?? 0) / 2);
}

/** The longest chain of dependencies by work, first feature first. */
export function criticalPath(
  plan: InitiativePlan,
  named: readonly string[],
): { features: string[]; work: number } {
  const byId = new Map(plan.features.map((f) => [f.id, f] as const));
  const best = new Map<string, { work: number; path: string[] }>();
  const visit = (id: string, seen: Set<string>): { work: number; path: string[] } => {
    const known = best.get(id);
    if (known) return known;
    const feature = byId.get(id);
    if (!feature || seen.has(id)) return { work: 0, path: [] };
    const next = new Set(seen).add(id);
    const upstream = feature.dependsOn
      .map((d) => visit(d, next))
      .reduce((a, b) => (b.work > a.work ? b : a), { work: 0, path: [] as string[] });
    const result = {
      work: upstream.work + featureWork(feature, named),
      path: [...upstream.path, id],
    };
    best.set(id, result);
    return result;
  };
  const longest = plan.features
    .map((f) => visit(f.id, new Set()))
    .reduce((a, b) => (b.work > a.work ? b : a), { work: 0, path: [] as string[] });
  return { features: longest.path, work: longest.work };
}

/**
 * The features of the critical path that hold more than `CRITICAL_SHARE` of its work and enough
 * files for two features of their own, unless the decomposer said why they stay whole (`serial`).
 */
export function criticalPathFeatures(
  plan: InitiativePlan,
  request: string,
): { feature: InitiativeFeature; share: number; path: string[] }[] {
  if (plan.features.length >= MAX_FEATURES) return [];
  const named = namedFiles(request);
  const path = criticalPath(plan, named);
  if (path.features.length < 2 || path.work <= 0) return [];
  return path.features.flatMap((id) => {
    const feature = plan.features.find((f) => f.id === id);
    if (!feature || feature.serial) return [];
    const share = featureWork(feature, named) / path.work;
    const files = boundaryFiles(feature, named)?.length ?? 0;
    return share > CRITICAL_SHARE && files >= 2 * MIN_FEATURE_PATHS
      ? [{ feature, share, path: path.features }]
      : [];
  });
}

/** What goes back to the decomposer for each such feature. */
export function criticalPathProblems(plan: InitiativePlan, request: string): string[] {
  return criticalPathFeatures(plan, request).map(
    ({ feature, share, path }) =>
      `${feature.id} is ${Math.round(share * 100)}% of the critical path (${path.join(" -> ")}) by size and files, and features on that path run one after another. If its files form groups that do not depend on each other, split it into features with its dependsOn, each with at least ${MIN_FEATURE_PATHS} files, so they run side by side, and make the features that depend on it depend on every part. Otherwise set its serial to why its parts must stay in one feature.`,
  );
}

/**
 * Each feature's remaining path: its own work plus the longest chain of work of the features that
 * depend on it, directly or not. A ready feature with the longest remaining path starts first, since
 * the initiative cannot finish before that chain does (#1535).
 */
export function remainingPath(plan: InitiativePlan, named: readonly string[]): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const feature of plan.features)
    for (const upstream of feature.dependsOn)
      dependents.set(upstream, [...(dependents.get(upstream) ?? []), feature.id]);
  const byId = new Map(plan.features.map((f) => [f.id, f] as const));
  const memo = new Map<string, number>();
  const visit = (id: string, seen: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const feature = byId.get(id);
    if (!feature || seen.has(id)) return 0;
    const next = new Set(seen).add(id);
    const after = Math.max(0, ...(dependents.get(id) ?? []).map((d) => visit(d, next)));
    const work = featureWork(feature, named) + after;
    memo.set(id, work);
    return work;
  };
  for (const feature of plan.features) visit(feature.id, new Set());
  return memo;
}
