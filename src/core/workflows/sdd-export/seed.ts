import { hashBytes, hashJson } from "../../specs/hash.js";
import { validatePackage } from "../../specs/validate.js";
import { WorkflowFault } from "../errors.js";
import { type Spec, SpecSchema, type TaskGraph, TaskGraphSchema } from "../schemas.js";
import type { RuntimeState } from "../types.js";

/** Where a seeded run records the package its spec, plan and tasks came from. */
export const IMPORT_SEED_ARTIFACT = "import/seed.json";

/**
 * Accepted documents of an exported feature (#2208): a run started with them skips specify and
 * plan and begins at analysis, so its plan is analyzed and approved again in this checkout.
 */
export interface StartSeed {
  spec: Spec;
  plan: string;
  graph: TaskGraph;
  /** The package the documents came from, recorded with the run. */
  source: { kind: "run" | "initiative"; id: string; manifestHash: string; gitHead: string | null };
}

/**
 * Puts a seed into the state of a run being created: the spec and the graph take the run's
 * feature ID and the dependencies the run pins (none for a run of no initiative), the hashes are
 * computed again and the package is validated against this workspace. The caller places the run
 * at its analysis stage.
 */
export function seedState(
  state: RuntimeState,
  seed: StartSeed,
  featureId: string,
  dependencies: Spec["dependencies"] | null,
  workspace: string,
): void {
  const spec = SpecSchema.parse({ ...seed.spec, featureId, dependencies: dependencies ?? [] });
  const plan = seed.plan;
  const graph = TaskGraphSchema.parse({
    ...seed.graph,
    featureId,
    specHash: hashJson(spec),
    planHash: hashBytes(plan),
  });
  try {
    validatePackage(workspace, spec, plan, graph);
  } catch (error) {
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `The imported spec, plan and tasks of ${seed.spec.featureId} do not fit this workspace: ${error instanceof Error ? error.message : String(error)}`,
      { reason: "seed_invalid" },
    );
  }
  state.spec = spec;
  state.plan = plan;
  state.graph = graph;
  state.rootGraph = structuredClone(graph);
  state.manifest.specHash = hashJson(spec);
  state.manifest.planHash = hashBytes(plan);
  state.manifest.rootGraphHash = hashJson(graph);
  state.manifest.effectiveGraphHash = hashJson(graph);
}
