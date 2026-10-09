/**
 * The split of an initiative into features (design/sdd-workflows/next-implementation.md, section
 * 3): the typed `initiativePlan` contract the decomposer returns, its structural validation and
 * the edits a person may apply before approving the split. Nothing here runs a model or a command.
 */
import { z } from "zod";
import { hashJson } from "../../specs/hash.js";
import { WorkflowFault } from "../errors.js";

/** An initiative holds at least this many features; a smaller request is a single run. */
export const MIN_FEATURES = 3;
/** An initiative holds at most this many features; a larger request is split into stages first. */
export const MAX_FEATURES = 12;

const Text = z.string().min(1).max(4000);
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
    dependsOn: z.array(FeatureKey),
    /** The initiative completes only when every mandatory feature has an accepted result. */
    mandatory: z.boolean(),
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
  })
  .strict();
export type InitiativePlan = z.infer<typeof InitiativePlanSchema>;

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
  return [...planStructureProblems(plan), ...(size ? [size] : [])];
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
  });
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
]);
export type SplitEdit = z.infer<typeof SplitEditSchema>;

const unique = <T>(values: T[]): T[] => [...new Set(values)];

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
    case "remove": {
      find(edit.featureId);
      // Dependents lose the edge; what they needed from the removed feature is now out of scope.
      features = plan.features
        .filter((f) => f.id !== edit.featureId)
        .map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => d !== edit.featureId) }));
      break;
    }
    case "merge": {
      const merged = unique(edit.featureIds).map(find);
      if (merged.length < 2)
        throw new WorkflowFault("INVALID_DEFINITION", "Merge needs two different features");
      const ids = new Set(merged.map((f) => f.id));
      const id = edit.id ?? merged[0]?.id ?? "";
      if (!ids.has(id) && plan.features.some((f) => f.id === id))
        throw new WorkflowFault("INVALID_DEFINITION", `Feature ${id} already exists`);
      const combined: InitiativeFeature = {
        id,
        title: edit.title ?? merged.map((f) => f.title).join(" + "),
        boundary: {
          scope: merged.map((f) => f.boundary.scope).join("\n"),
          paths: unique(merged.flatMap((f) => f.boundary.paths)),
        },
        contract: merged.map((f) => f.contract).join("\n"),
        dependsOn: unique(merged.flatMap((f) => f.dependsOn)).filter((d) => !ids.has(d)),
        mandatory: merged.some((f) => f.mandatory),
      };
      const position = plan.features.findIndex((f) => ids.has(f.id));
      features = [];
      for (const [index, feature] of plan.features.entries()) {
        if (index === position) features.push(combined);
        if (ids.has(feature.id)) continue;
        features.push({
          ...feature,
          dependsOn: unique(feature.dependsOn.map((d) => (ids.has(d) ? id : d))),
        });
      }
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
      const replacements: InitiativeFeature[] = edit.into.map((part) => ({
        id: part.id,
        title: part.title,
        boundary: {
          scope: part.scope ?? original.boundary.scope,
          paths: part.paths ?? original.boundary.paths,
        },
        contract: part.contract ?? original.contract,
        dependsOn: original.dependsOn,
        mandatory: original.mandatory,
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
