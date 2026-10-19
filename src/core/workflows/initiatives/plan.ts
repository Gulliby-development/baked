/**
 * The split of an initiative into features (docs/workflows/runtime.md, "Initiatives"): the typed
 * `initiativePlan` contract the decomposer returns, its structural validation and the edits a
 * person may apply before approving the split. Nothing here runs a model or a command.
 */
import { z } from "zod";
import { matchGlob } from "../../platform/index.js";
import { hashJson } from "../../specs/hash.js";
import { canHold, deliverableKind } from "../../verification/deliverable-paths.js";
import { isCodePath } from "../check-policy.js";
import { WorkflowFault } from "../errors.js";
import { HOST_CONTENT_MAX_CHARS, SafeId } from "../schemas.js";

/** An initiative holds at least this many features; a smaller request is a single run. */
export const MIN_FEATURES = 3;
/** An initiative holds at most this many features; a larger request is split into stages first. */
export const MAX_FEATURES = 12;

const MAX_TEXT = 4000;
const Text = z.string().min(1).max(MAX_TEXT);
/**
 * Feature and initiative IDs are short, lower case slugs. A feature run's ID is
 * `INITIATIVE--FEATURE`, which must still be a valid workflow feature ID (at most 96 characters).
 */
export const InitiativeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const FeatureKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const PathPattern = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._\-/*]+$/)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").includes(".."),
    "Expected a relative pattern without ..",
  );

export const InitiativeFeatureSchema = z
  .object({
    id: FeatureKey,
    title: z.string().min(1).max(200),
    boundary: z
      .object({
        /** What the feature owns, in words. */
        scope: Text,
        /** Paths the feature may write, as globs. Empty when the decomposer cannot tell yet. */
        paths: z.array(PathPattern).max(50),
      })
      .strict(),
    /** The verifiable contract this feature provides to the features that depend on it. */
    contract: Text,
    /** Feature that delivers this feature's tests when its own boundary cannot hold them. */
    testedBy: FeatureKey.optional(),
    dependsOn: z.array(FeatureKey),
    /** The initiative completes only when every mandatory feature has an accepted result. */
    mandatory: z.boolean(),
    /** The workflow this feature's runs use; omitted, the initiative's default workflow. */
    workflow: SafeId.optional(),
    /** How much work the feature is; its budget share is weighted by it. Omitted, medium. */
    size: z.enum(["small", "medium", "large"]).optional(),
    /**
     * Files of the boundary whose whole content the request fixes (module stubs that hold only a
     * comment, a registration file of `pub mod` lines, an empty `__init__.py`). The feature's
     * run writes them in the host with no agent; later features replace the stubs through their
     * own boundary. A brief's 20-module skeleton cost 2.58M tokens as agent tasks (#1461).
     */
    skeleton: z
      .array(
        z.object({ path: PathPattern, content: z.string().max(HOST_CONTENT_MAX_CHARS) }).strict(),
      )
      .max(50)
      .optional(),
    /**
     * Why the feature stays whole although it holds a large share of the critical path: its parts
     * depend on each other (critical-path.ts, #1522). Absent when nobody asked.
     */
    serial: Text.optional(),
  })
  .strict();
export type InitiativeFeature = z.infer<typeof InitiativeFeatureSchema>;

export const InitiativePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(200),
    goals: z.array(Text).min(1).max(20),
    completionCriteria: z.array(Text).min(1).max(30),
    /** Bounds are checked by `planSizeProblem`, so an oversized split is refused with a reason. */
    features: z.array(InitiativeFeatureSchema).min(1).max(100),
    /**
     * Why the longest dependency chain stays as it is although it holds most of the work: each
     * feature on it needs the one before (critical-path.ts, #1551). Absent when nobody asked.
     */
    chain: Text.optional(),
  })
  .strict();
export type InitiativePlan = z.infer<typeof InitiativePlanSchema>;

export type FeatureSize = NonNullable<InitiativeFeature["size"]>;
export const FEATURE_SIZES: readonly FeatureSize[] = ["small", "medium", "large"];
/** Budget weight of a feature size: a medium feature takes the policy's per-run limits. */
const SIZE_WEIGHTS: Record<FeatureSize, number> = { small: 1, medium: 2, large: 4 };
export const sizeWeight = (feature: Pick<InitiativeFeature, "size">): number =>
  SIZE_WEIGHTS[feature.size ?? "medium"];

/**
 * Problems of the dependency graph and identifiers. These go back to the decomposer at
 * submission so it can correct them; an empty list means the graph is a valid DAG.
 */
export function planStructureProblems(plan: InitiativePlan): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const feature of plan.features) {
    if (ids.has(feature.id)) problems.push(`duplicate feature ID ${feature.id}`);
    ids.add(feature.id);
  }
  for (const feature of plan.features) {
    if (new Set(feature.dependsOn).size !== feature.dependsOn.length)
      problems.push(`${feature.id} lists a dependency twice`);
    for (const dependency of feature.dependsOn) {
      if (dependency === feature.id) problems.push(`${feature.id} depends on itself`);
      else if (!ids.has(dependency))
        problems.push(`${feature.id} depends on unknown feature ${dependency}`);
    }
  }
  const cycle = findCycle(plan);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);
  return [...problems, ...skeletonProblems(plan)];
}

/** Reject a source-only split unless it names a test owner that runs after the source. */
export function testOwnershipProblems(plan: InitiativePlan): string[] {
  const problems: string[] = [];
  const reaches = (id: string, target: string, seen = new Set<string>()): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (
      plan.features
        .find((feature) => feature.id === id)
        ?.dependsOn.some((upstream) => reaches(upstream, target, seen)) ?? false
    );
  };
  for (const feature of plan.features) {
    const source = feature.boundary.paths.some(
      (path) =>
        isCodePath(path) &&
        !deliverableKind(path) &&
        !feature.skeleton?.some((file) => file.path === path),
    );
    if (!source || canHold(feature.boundary.paths, "test")) continue;
    const owner = plan.features.find((candidate) => candidate.id === feature.testedBy);
    if (
      !owner ||
      owner.id === feature.id ||
      !canHold(owner.boundary.paths, "test") ||
      !reaches(owner.id, feature.id)
    )
      problems.push(
        `${feature.id} has source paths but no writable test path. Add tests to its boundary or set testedBy to a feature with test paths that depends on it, and leave those tests out of this feature's criteria.`,
      );
  }
  return problems;
}

/**
 * Problems of the features' skeletons: each file is one literal path of its feature's boundary,
 * listed once in the whole split, so exactly one run writes it.
 */
function skeletonProblems(plan: InitiativePlan): string[] {
  const owner = new Map<string, string>();
  const problems: string[] = [];
  for (const feature of plan.features)
    for (const { path } of feature.skeleton ?? []) {
      if (GLOB.test(path))
        problems.push(`${feature.id}'s skeleton names a glob ${path}; list each file`);
      else if (!feature.boundary.paths.some((p) => patternsMeet(path, p)))
        problems.push(`${feature.id}'s skeleton file ${path} is outside its boundary paths`);
      const first = owner.get(path);
      if (first) problems.push(`${path} is in the skeleton of both ${first} and ${feature.id}`);
      else owner.set(path, feature.id);
    }
  return problems;
}

/** The refusal of a split outside 3..12 features, or null when the size fits one initiative. */
export function planSizeProblem(plan: InitiativePlan): string | null {
  const count = plan.features.length;
  if (count > MAX_FEATURES)
    return `The request needs ${count} features; one initiative holds at most ${MAX_FEATURES}. Split the request into stages and start one initiative per stage.`;
  if (count < MIN_FEATURES)
    return `The split has ${count} feature(s); an initiative needs at least ${MIN_FEATURES}. Run a smaller request as a single workflow run.`;
  return null;
}

/** Every problem of a plan: structure first, then the size bound. */
export function validateInitiativePlan(plan: InitiativePlan): string[] {
  const size = planSizeProblem(plan);
  return [...planStructureProblems(plan), ...testOwnershipProblems(plan), ...(size ? [size] : [])];
}

function findCycle(plan: InitiativePlan): string[] | null {
  const byId = new Map(plan.features.map((f) => [f.id, f] as const));
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "open");
    stack.push(id);
    for (const next of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(next) || next === id) continue;
      if (state.get(next) === "open") return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "closed");
    return null;
  };
  for (const feature of plan.features)
    if (!state.has(feature.id)) {
      const found = visit(feature.id);
      if (found) return found;
    }
  return null;
}

const GLOB = /[*?[\]{}]/;
/** Whether a boundary path is a glob pattern rather than one file. */
export const isGlobPath = (path: string): boolean => GLOB.test(path);
/**
 * Whether two boundary patterns name a common file: the same pattern, or a literal path of one
 * that the other's glob matches. Two different globs are not compared.
 */
function patternsMeet(a: string, b: string): boolean {
  if (a === b) return true;
  if (!GLOB.test(a) && GLOB.test(b)) return matchGlob(a, b);
  if (!GLOB.test(b) && GLOB.test(a)) return matchGlob(b, a);
  return false;
}

/**
 * The files a feature's boundary names, for the estimate's per-path rate: 0 when it names a glob,
 * since `src/format/**` is one entry and any number of files. Bench round 38 (stoptable): with
 * glob boundaries the path floor never applied, and a finished glob feature would count its whole
 * cost against one path (#1387).
 */
export function literalPathCount(feature: Pick<InitiativeFeature, "boundary">): number {
  const { paths } = feature.boundary;
  return paths.some((path) => GLOB.test(path)) ? 0 : paths.length;
}

/** A feature's literal boundary paths for the estimate: those it owns, and placeholders. */
export interface BoundaryPathCount {
  /** Paths no later feature lists: the feature writes them in full. */
  paths: number;
  /** Paths a later feature lists too: the feature creates a placeholder that one fills. */
  placeholders: number;
  /** Files of the feature's own skeleton: the host writes them, so they cost no tokens (#1550). */
  skeleton: number;
}

/** File paths a request names, such as `src/cli.ts` or `AddCommand.java`. */
export function namedFiles(text: string): string[] {
  const found = text.matchAll(
    /(?:^|[\s`'"([])(?:\.\/)?((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?=$|[\s`'"),.;:\]])/gm,
  );
  return [...new Set([...found].map((m) => m[1] as string))];
}

/**
 * The files a feature's boundary stands for: its paths when they are all literal, or its literal
 * paths and the files the request names that its globs match. Null when a glob matches no named
 * file, since its size is then unknown. fecsmith R42 front (`commands/*Command.java` for eight
 * commands the brief named) was priced like a four-file feature and used 2.2 times the high end
 * (#1504). A bare file name matches a glob's last segment when it names more than an extension.
 */
export function boundaryFiles(
  feature: Pick<InitiativeFeature, "boundary">,
  named: readonly string[],
): string[] | null {
  const { paths } = feature.boundary;
  const globs = paths.filter((p) => GLOB.test(p));
  if (!globs.length) return [...new Set(paths)];
  // A bare name matches the glob's last segment only when that segment names more than an
  // extension: `*Command.java` takes `AddCommand.java`, `*.java` takes nothing bare.
  const tail = (glob: string) => glob.split("/").at(-1) ?? glob;
  const specific = (glob: string) =>
    /\w/.test(
      tail(glob)
        .replace(/\.[^.]*$/, "")
        .replace(/[*?]/g, ""),
    );
  const matches = (file: string, glob: string) =>
    matchGlob(file, glob) ||
    matchGlob(file, `**/${glob}`) ||
    (!file.includes("/") && specific(glob) && matchGlob(file, tail(glob)));
  const matched = named.filter((file) => globs.some((glob) => matches(file, glob)));
  if (!matched.length) return null;
  return [...new Set([...paths.filter((p) => !GLOB.test(p)), ...matched])];
}

/**
 * Every feature's literal boundary paths, each counted in full only in the last feature in plan
 * order that lists it and as a placeholder in the earlier ones. A skeleton-first split lists its
 * module stubs in the first feature and again in the features that fill them: bench round 40
 * (tonemath) listed 48 paths for 33 files, and the first feature's path floor came out 1.54 times
 * what it used (#1464). A file of the feature's own skeleton counts apart, at no cost: the host
 * writes it with no agent (#1461), and bench round 45 (grundykit) priced 22 such stubs at a third
 * of a path each, 2.1M to 3.1M tokens the feature never used (#1550). A glob boundary counts the files of the request it
 * matches (`boundaryFiles`); one that matches none counts no paths and claims none.
 */
export function boundaryPathCounts(
  plan: Pick<InitiativePlan, "features">,
  request = "",
): Map<string, BoundaryPathCount> {
  const named = namedFiles(request);
  const files = new Map(plan.features.map((f) => [f.id, boundaryFiles(f, named)]));
  const owner = new Map<string, string>();
  for (const f of plan.features) for (const path of files.get(f.id) ?? []) owner.set(path, f.id);
  return new Map(
    plan.features.map((f): [string, BoundaryPathCount] => {
      const paths = files.get(f.id);
      if (!paths?.length) return [f.id, { paths: 0, placeholders: 0, skeleton: 0 }];
      const own = new Set((f.skeleton ?? []).map((file) => file.path));
      const skeleton = paths.filter((path) => own.has(path)).length;
      const placeholders = paths.filter(
        (path) => !own.has(path) && owner.get(path) !== f.id,
      ).length;
      return [f.id, { paths: paths.length - placeholders - skeleton, placeholders, skeleton }];
    }),
  );
}

/** The boundary patterns of `a` that meet one of `b`'s. */
export function sharedPaths(a: InitiativeFeature, b: InitiativeFeature): string[] {
  return a.boundary.paths.filter((p) => b.boundary.paths.some((q) => patternsMeet(p, q)));
}

/**
 * The plan with features that may write a common file put in order: the later one in plan order
 * depends on the nearest earlier one it shares a file with, unless a dependency path already
 * joins them. Siblings that each add a line to one registration file (lib.rs, mod.rs, an index)
 * otherwise run side by side and their accepted results cannot be merged (sketchfold: hll,
 * frequent, hist and member each added `pub mod` to src/lib.rs, #1336). Features in `fixed`
 * (those with a run) keep their dependencies. An earlier feature in `noContract` (its workflow
 * writes no spec, such as a `quick` leaf) cannot be built on, so it depends on the later one
 * instead when that one can provide a contract (#1406).
 */
export function sequenceSharedPaths(
  plan: InitiativePlan,
  fixed: ReadonlySet<string> = new Set(),
  noContract: ReadonlySet<string> = new Set(),
): { plan: InitiativePlan; added: { featureId: string; dependsOn: string; paths: string[] }[] } {
  const features = plan.features.map((f) => ({ ...f, dependsOn: [...f.dependsOn] }));
  const byId = new Map(features.map((f) => [f.id, f] as const));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop() ?? "";
      if (id === to) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(byId.get(id)?.dependsOn ?? []));
    }
    return false;
  };
  const added: { featureId: string; dependsOn: string; paths: string[] }[] = [];
  for (const [j, later] of features.entries()) {
    if (fixed.has(later.id)) continue;
    for (let i = j - 1; i >= 0; i--) {
      const earlier = features[i];
      if (!earlier) continue;
      const paths = sharedPaths(later, earlier);
      if (!paths.length || reaches(later.id, earlier.id) || reaches(earlier.id, later.id)) continue;
      const [dependent, upstream] =
        noContract.has(earlier.id) && !noContract.has(later.id) && !fixed.has(earlier.id)
          ? [earlier, later]
          : [later, earlier];
      dependent.dependsOn.push(upstream.id);
      added.push({ featureId: dependent.id, dependsOn: upstream.id, paths });
    }
  }
  return added.length ? { plan: { ...plan, features }, added } : { plan, added };
}

/**
 * Features in dependency order. Among the features whose dependencies are done, the one listed
 * first in the plan comes first, so the order is stable across revisions that keep the list.
 */
export function topologicalOrder(plan: InitiativePlan): InitiativeFeature[] {
  const done = new Set<string>();
  const order: InitiativeFeature[] = [];
  const known = new Set(plan.features.map((f) => f.id));
  while (order.length < plan.features.length) {
    const next = plan.features.find(
      (f) => !done.has(f.id) && f.dependsOn.every((d) => done.has(d) || !known.has(d)),
    );
    if (!next) throw new WorkflowFault("CYCLE_DETECTED", "Initiative features form a cycle");
    done.add(next.id);
    order.push(next);
  }
  return order;
}

/**
 * The part of a feature a run is bound to. A title change (rename) keeps the run; a change of the
 * boundary, the contract, the dependencies or whether it is mandatory needs a new run.
 */
export function featureDigest(feature: InitiativeFeature): string {
  return hashJson({
    boundary: feature.boundary,
    contract: feature.contract,
    dependsOn: [...feature.dependsOn].sort(),
    mandatory: feature.mandatory,
    ...(feature.testedBy ? { testedBy: feature.testedBy } : {}),
    // Another workflow is another run; the size only weighs the next budget share.
    ...(feature.workflow ? { workflow: feature.workflow } : {}),
    // Left out when there is none, so features approved before skeletons keep their digest.
    ...(feature.skeleton?.length ? { skeleton: feature.skeleton } : {}),
  });
}

/**
 * The skeleton files of a split feature that part `index` keeps: each file goes to the first part
 * whose paths name it, so it keeps one owner.
 */
function partSkeleton(
  original: InitiativeFeature,
  parts: readonly { paths?: string[] | undefined }[],
  index: number,
): Pick<InitiativeFeature, "skeleton"> {
  const names = (i: number, path: string) =>
    (parts[i]?.paths ?? original.boundary.paths).some((p) => patternsMeet(path, p));
  const kept = (original.skeleton ?? []).filter(
    ({ path }) => parts.findIndex((_, i) => names(i, path)) === index,
  );
  return kept.length ? { skeleton: kept } : {};
}

/** Edits a person may apply to a proposed split. Each one produces a new plan revision. */
export const SplitEditSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("merge"),
      /** Two or more features become one. */
      featureIds: z.array(FeatureKey).min(2),
      /** ID of the merged feature; defaults to the first merged ID. */
      id: FeatureKey.optional(),
      title: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("split"),
      featureId: FeatureKey,
      into: z
        .array(
          z
            .object({
              id: FeatureKey,
              title: z.string().min(1).max(200),
              scope: Text.optional(),
              paths: z.array(PathPattern).max(50).optional(),
              contract: Text.optional(),
            })
            .strict(),
        )
        .min(2),
    })
    .strict(),
  z.object({ op: z.literal("remove"), featureId: FeatureKey }).strict(),
  z
    .object({ op: z.literal("rename"), featureId: FeatureKey, title: z.string().min(1).max(200) })
    .strict(),
  /** The workflow a feature runs; the initiative checks that it can run the feature. */
  z.object({ op: z.literal("workflow"), featureId: FeatureKey, workflow: SafeId }).strict(),
  z
    .object({
      op: z.literal("size"),
      featureId: FeatureKey,
      size: z.enum(["small", "medium", "large"]),
    })
    .strict(),
]);
export type SplitEdit = z.infer<typeof SplitEditSchema>;

const unique = <T>(values: T[]): T[] => [...new Set(values)];

/** A merged feature keeps the workflow of its largest part; its size is the parts' total. */
function largestOf(features: InitiativeFeature[]): Pick<InitiativeFeature, "workflow" | "size"> {
  const largest = features.reduce((a, b) => (sizeWeight(b) > sizeWeight(a) ? b : a));
  const total = features.reduce((sum, f) => sum + sizeWeight(f), 0);
  const size: FeatureSize = total <= 1 ? "small" : total <= 2 ? "medium" : "large";
  return { ...(largest.workflow ? { workflow: largest.workflow } : {}), size };
}

/**
 * The features of `plan` with `featureIds` combined into one, placed where the first of them was:
 * its boundary, contract and dependencies are the parts' together, and dependents of a part
 * depend on it. The result is not validated.
 */
function mergeFeatures(
  plan: InitiativePlan,
  featureIds: string[],
  mergedId?: string,
  title?: string,
): InitiativeFeature[] {
  const merged = unique(featureIds).map((featureId) => {
    const feature = plan.features.find((f) => f.id === featureId);
    if (!feature) throw new WorkflowFault("NOT_FOUND", `Unknown feature ${featureId}`);
    return feature;
  });
  if (merged.length < 2)
    throw new WorkflowFault("INVALID_DEFINITION", "Merge needs two different features");
  const ids = new Set(merged.map((f) => f.id));
  const id = mergedId ?? merged[0]?.id ?? "";
  if (!ids.has(id) && plan.features.some((f) => f.id === id))
    throw new WorkflowFault("INVALID_DEFINITION", `Feature ${id} already exists`);
  const testOwners = unique(
    merged.flatMap((feature) =>
      feature.testedBy && !ids.has(feature.testedBy) ? [feature.testedBy] : [],
    ),
  );
  const paths = unique(merged.flatMap((feature) => feature.boundary.paths));
  if (testOwners.length > 1 && !canHold(paths, "test"))
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "Merged source features need one test owner or writable test paths",
    );
  const combined: InitiativeFeature = {
    id,
    title: title ?? merged.map((f) => f.title).join(" + "),
    boundary: {
      scope: merged.map((f) => f.boundary.scope).join("\n"),
      paths,
    },
    contract: merged.map((f) => f.contract).join("\n"),
    dependsOn: unique(merged.flatMap((f) => f.dependsOn)).filter((d) => !ids.has(d)),
    mandatory: merged.some((f) => f.mandatory),
    ...(testOwners[0] && !canHold(paths, "test") ? { testedBy: testOwners[0] } : {}),
    ...largestOf(merged),
    ...(merged.some((f) => f.skeleton?.length)
      ? { skeleton: merged.flatMap((f) => f.skeleton ?? []) }
      : {}),
  };
  const position = plan.features.findIndex((f) => ids.has(f.id));
  const features: InitiativeFeature[] = [];
  for (const [index, feature] of plan.features.entries()) {
    if (index === position) features.push(combined);
    if (ids.has(feature.id)) continue;
    features.push({
      ...feature,
      ...(feature.testedBy && ids.has(feature.testedBy) ? { testedBy: id } : {}),
      dependsOn: unique(feature.dependsOn.map((d) => (ids.has(d) ? id : d))),
    });
  }
  return features;
}

/** A feature with fewer boundary paths than this is merged into its small siblings (#1352). */
export const MIN_FEATURE_PATHS = 3;
/** Small siblings are merged into features of at most this many paths. */
export const MAX_MERGED_PATHS = 8;

/**
 * The decomposer's split with small siblings merged: features with one or two boundary paths, the
 * same dependencies and the same `mandatory` become one feature of at most `MAX_MERGED_PATHS`
 * paths, while the split keeps at least `MIN_FEATURES`. Every feature run pays fixed stages
 * (research, specification, planning, analysis, review) besides its tasks; six one-file features
 * of narrowfit spent 67 to 80 percent of their 3.13M tokens there (bench round 35, #1352). A
 * feature without paths, or with a glob among them, is left alone, since its size is unknown.
 * Siblings with the same dependencies never depend on each other, so a merge cannot form a cycle.
 */
export function mergeSmallSiblings(
  plan: InitiativePlan,
  options: { byDependents?: boolean } = {},
): {
  plan: InitiativePlan;
  merged: { featureId: string; from: string[] }[];
} {
  // With `byDependents`, siblings merge only when the same features depend on them: a merged
  // feature makes every dependent of each part wait for all parts. Bench round 45 (grundykit)
  // merged table, period, misere and wythoff, so solve, which needs only table, waited for the
  // other three, and 8 of 9 features ran in series (#1551).
  const dependents = new Map<string, string[]>();
  if (options.byDependents)
    for (const feature of plan.features)
      for (const upstream of feature.dependsOn)
        dependents.set(upstream, [...(dependents.get(upstream) ?? []), feature.id]);
  const groups = new Map<string, string[]>();
  for (const feature of plan.features) {
    // A glob boundary is any number of files, so its size is unknown, like no paths (#1405).
    const paths = literalPathCount(feature);
    if (paths === 0 || paths >= MIN_FEATURE_PATHS) continue;
    const after = options.byDependents
      ? `|${[...(dependents.get(feature.id) ?? [])].sort().join(",")}`
      : "";
    const key = `${[...feature.dependsOn].sort().join(",")}|${feature.mandatory}|${feature.testedBy ?? ""}${after}`;
    groups.set(key, [...(groups.get(key) ?? []), feature.id]);
  }
  let current = plan;
  const merged: { featureId: string; from: string[] }[] = [];
  for (const group of groups.values()) {
    let rest = group;
    while (rest.length >= 2) {
      const room = current.features.length - MIN_FEATURES + 1;
      // Parts are added while the merged feature stays a run's worth and its texts fit.
      const parts: InitiativeFeature[] = [];
      for (const id of rest) {
        const feature = current.features.find((f) => f.id === id);
        if (!feature || parts.length >= room) break;
        const next = [...parts, feature];
        const fits = (text: (f: InitiativeFeature) => string) =>
          next.map(text).join("\n").length <= MAX_TEXT;
        const paths = new Set(next.flatMap((f) => f.boundary.paths)).size;
        if (paths > MAX_MERGED_PATHS || !fits((f) => f.boundary.scope) || !fits((f) => f.contract))
          break;
        parts.push(feature);
      }
      rest = rest.slice(Math.max(1, parts.length));
      if (parts.length < 2) continue;
      const ids = parts.map((f) => f.id);
      const joined = parts.map((f) => f.title).join(" + ");
      const title =
        joined.length <= 200 ? joined : `${parts[0]?.title} and ${parts.length - 1} more`;
      current = {
        ...current,
        features: mergeFeatures(current, ids, undefined, title.slice(0, 200)),
      };
      merged.push({ featureId: ids[0] ?? "", from: ids });
    }
  }
  return { plan: current, merged };
}

/**
 * Applies one edit and returns the new plan. The result is validated as a whole: an edit that
 * leaves fewer than three features, an unknown ID or a cycle is refused.
 */
export function applySplitEdit(plan: InitiativePlan, edit: SplitEdit): InitiativePlan {
  const find = (id: string): InitiativeFeature => {
    const feature = plan.features.find((f) => f.id === id);
    if (!feature) throw new WorkflowFault("NOT_FOUND", `Unknown feature ${id}`);
    return feature;
  };
  let features: InitiativeFeature[];
  switch (edit.op) {
    case "rename": {
      find(edit.featureId);
      features = plan.features.map((f) =>
        f.id === edit.featureId ? { ...f, title: edit.title } : f,
      );
      break;
    }
    case "workflow":
    case "size": {
      find(edit.featureId);
      const change = edit.op === "workflow" ? { workflow: edit.workflow } : { size: edit.size };
      features = plan.features.map((f) => (f.id === edit.featureId ? { ...f, ...change } : f));
      break;
    }
    case "remove": {
      find(edit.featureId);
      // Dependents lose the edge; what they needed from the removed feature is now out of scope.
      features = plan.features
        .filter((f) => f.id !== edit.featureId)
        .map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => d !== edit.featureId) }));
      break;
    }
    case "merge": {
      features = mergeFeatures(plan, edit.featureIds, edit.id, edit.title);
      break;
    }
    case "split": {
      const original = find(edit.featureId);
      const parts = edit.into.map((part) => part.id);
      if (new Set(parts).size !== parts.length)
        throw new WorkflowFault("INVALID_DEFINITION", "Split parts need different IDs");
      for (const id of parts)
        if (id !== original.id && plan.features.some((f) => f.id === id))
          throw new WorkflowFault("INVALID_DEFINITION", `Feature ${id} already exists`);
      const replacements: InitiativeFeature[] = edit.into.map((part, index) => ({
        id: part.id,
        title: part.title,
        boundary: {
          scope: part.scope ?? original.boundary.scope,
          paths: part.paths ?? original.boundary.paths,
        },
        contract: part.contract ?? original.contract,
        ...(original.testedBy ? { testedBy: original.testedBy } : {}),
        dependsOn: original.dependsOn,
        mandatory: original.mandatory,
        ...(original.workflow ? { workflow: original.workflow } : {}),
        ...partSkeleton(original, edit.into, index),
      }));
      features = plan.features.flatMap((f) =>
        f.id === original.id
          ? replacements
          : [
              {
                ...f,
                // A dependent of the split feature depends on every part.
                dependsOn: unique(f.dependsOn.flatMap((d) => (d === original.id ? parts : [d]))),
              },
            ],
      );
      break;
    }
  }
  const next = InitiativePlanSchema.parse({ ...plan, features });
  const problems = validateInitiativePlan(next);
  if (problems.length) throw new WorkflowFault("INVALID_DEFINITION", problems.join("\n"));
  return next;
}
