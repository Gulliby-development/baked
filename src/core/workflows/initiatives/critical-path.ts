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

/** A chain holding at least this share of the split's work is asked about (#1551). */
export const CHAIN_SHARE = 0.8;
/** A chain needs at least this many features to be asked about. */
export const CHAIN_FEATURES = 5;

/** The total work of a split, in the units of `featureWork`. */
export function totalWork(plan: InitiativePlan, named: readonly string[]): number {
  return plan.features.reduce((sum, f) => sum + featureWork(f, named), 0);
}

/**
 * The critical path when it is a long chain that holds most of the split's work, unless the
 * decomposer said why it stays (`chain`). Bench round 45 (grundykit): 8 of 9 features ran in
 * series, the largest of them 16% of the path, so the share check of one feature never asked, and
 * the speedup was 1.08x (#1551).
 */
export function criticalChain(
  plan: InitiativePlan,
  request: string,
): { path: string[]; share: number } | null {
  // Dropping unnecessary edges needs no extra feature slot, even at the split's maximum.
  if (plan.chain || plan.features.length > MAX_FEATURES) return null;
  const named = namedFiles(request);
  const path = criticalPath(plan, named);
  const total = totalWork(plan, named);
  if (path.features.length < CHAIN_FEATURES || total <= 0) return null;
  const share = path.work / total;
  return share >= CHAIN_SHARE ? { path: path.features, share } : null;
}

/**
 * The critical path of a split for its approval: the chain, its share of the work, and the most
 * the split can gain over one feature at a time with `parallelRuns` runs at once (total work over
 * the longer of the path and an even spread).
 */
export function criticalPathSummary(
  plan: InitiativePlan,
  request: string,
  parallelRuns: number,
): { features: string[]; workShare: number; speedup: number; chain: string | null } | null {
  const named = namedFiles(request);
  const path = criticalPath(plan, named);
  const total = totalWork(plan, named);
  if (path.features.length === 0 || total <= 0) return null;
  const bound = Math.max(path.work, total / Math.max(1, parallelRuns));
  return {
    features: path.features,
    workShare: path.work / total,
    speedup: total / bound,
    chain: plan.chain ?? null,
  };
}

/** What goes back to the decomposer for each such feature, and for a long chain. */
export function criticalPathProblems(plan: InitiativePlan, request: string): string[] {
  const chain = criticalChain(plan, request);
  return [
    ...criticalFeatureProblems(plan, request),
    ...(chain
      ? [
          `The longest dependency chain (${chain.path.join(" -> ")}) holds ${Math.round(chain.share * 100)}% of the split's work by size and files, and features on it run one after another. Check each dependsOn edge on it: a feature depends only on the features whose code or contract its own tasks use (a command adapter on its own module, not on every module the program has), so drop the others. Where one feature serves dependents that need different parts of it, split it by those parts, each with at least ${MIN_FEATURE_PATHS} files, so each dependent waits only for its part. If every feature on the chain needs the one before, set the plan's chain to why.`,
        ]
      : []),
  ];
}

function criticalFeatureProblems(plan: InitiativePlan, request: string): string[] {
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
