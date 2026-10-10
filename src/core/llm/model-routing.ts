import { z } from "zod";
import type { AgentProfile } from "../agents/profiles/schema.js";
import { WorkflowFault } from "../workflows/errors.js";

/**
 * Model routing for workflow agents. Profiles and workflow definitions live in the repository and
 * name a logical class (`$fast`, `$review`, ...) or a concrete model; the user's or project's
 * `modelRouting` turns classes, roles, profiles and workflow stages into concrete models.
 */

const ClassName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
/** A concrete model ID (`provider/model`) or a class reference (`$name`). */
const RouteRef = z
  .string()
  .trim()
  .min(1)
  .refine((v) => !v.startsWith("$") || ClassName.safeParse(v.slice(1)).success, {
    message: "Class references are $ followed by a lowercase name",
  });
const Role = z.enum([
  "researcher",
  "spec-author",
  "planner",
  "implementer",
  "reviewer",
  "spec-auditor",
  "reporter",
  "acceptance-walker",
  "acceptance-writer",
]);
export type RoutedRole = z.infer<typeof Role>;
export const ROUTED_ROLES = Role.options;

export const ModelRoutingSchema = z
  .object({
    /** Class name (without `$`) to a model ID. */
    classes: z.record(ClassName, z.string().trim().min(1)).optional(),
    roles: z.partialRecord(Role, RouteRef).optional(),
    profiles: z.record(z.string(), RouteRef).optional(),
    workflows: z
      .record(z.string(), z.object({ stages: z.record(z.string(), RouteRef).optional() }).strict())
      .optional(),
  })
  .strict();
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

/** Built-in classes. Each falls back to the legacy router slot, then to the run model. */
export const BUILTIN_CLASSES = ["active", "coding", "review"] as const;

export interface RoutingInputs {
  /** The run model: the tab's model or `--model`. */
  runModel: string;
  routing?: ModelRouting | undefined;
  /** Legacy `taskRouter.ember` / `taskRouter.verify`, used when the class is not configured. */
  legacy?: { coding?: string | undefined; review?: string | undefined };
}

export interface Resolved {
  model: string;
  /** Where the decision came from, for example `modelRouting.roles.researcher`. */
  source: string;
}

/** Parses the config section; a malformed section is a definition error, not a silent default. */
export function parseModelRouting(value: unknown): ModelRouting | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = ModelRoutingSchema.safeParse(value);
  if (!parsed.success)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `Invalid modelRouting: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

/** Resolves a reference to a model. Classes resolve one level deep, so they cannot form cycles. */
export function resolveRef(ref: string, origin: string, inputs: RoutingInputs): Resolved {
  if (!ref.startsWith("$")) return { model: ref, source: origin };
  const name = ref.slice(1);
  const configured = inputs.routing?.classes?.[name];
  if (configured) {
    if (configured.startsWith("$"))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `modelRouting.classes.${name} must name a model, not another class`,
      );
    return { model: configured, source: `modelRouting.classes.${name}` };
  }
  if (name === "active") return { model: inputs.runModel, source: "run model" };
  if (name === "coding" && inputs.legacy?.coding)
    return { model: inputs.legacy.coding, source: "taskRouter.ember" };
  if (name === "review" && inputs.legacy?.review)
    return { model: inputs.legacy.review, source: "taskRouter.verify" };
  if ((BUILTIN_CLASSES as readonly string[]).includes(name))
    return { model: inputs.runModel, source: `run model (class $${name} not set)` };
  throw new WorkflowFault(
    "INVALID_DEFINITION",
    `Unknown model class $${name} (${origin}); define it in modelRouting.classes`,
  );
}

/**
 * The model of a profile outside any stage-level route: `profiles.<id>`, then `roles.<role>`,
 * then the profile's own model or class.
 */
export function resolveProfileModel(
  profile: Pick<AgentProfile, "id" | "role" | "model">,
  inputs: RoutingInputs,
): Resolved {
  const byProfile = inputs.routing?.profiles?.[profile.id];
  if (byProfile) return resolveRef(byProfile, `modelRouting.profiles.${profile.id}`, inputs);
  const byRole = inputs.routing?.roles?.[profile.role];
  if (byRole) return resolveRef(byRole, `modelRouting.roles.${profile.role}`, inputs);
  return resolveRef(profile.model, `profile ${profile.id}`, inputs);
}

/** Parses `stage=ref,stage=ref` from the command line. */
export function parseRouteOverrides(value: string): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const part of value.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const at = entry.indexOf("=");
    const stage = at > 0 ? entry.slice(0, at).trim() : "";
    const ref = at > 0 ? entry.slice(at + 1).trim() : "";
    if (!stage || !RouteRef.safeParse(ref).success)
      throw new WorkflowFault("INVALID_DEFINITION", `Invalid route "${entry}"; use STAGE=MODEL`);
    routes[stage] = ref;
  }
  return routes;
}

export interface StageRoute extends Resolved {
  stageId: string;
}

/**
 * Stage-level routes of one workflow: a start override wins over `workflows.<id>.stages`. A route
 * for a stage the definition does not have is rejected, so a typo does not silently do nothing.
 */
export function resolveStageRoutes(
  workflowId: string,
  stageIds: readonly string[],
  overrides: Record<string, string> | undefined,
  inputs: RoutingInputs,
): StageRoute[] {
  const configured = inputs.routing?.workflows?.[workflowId]?.stages ?? {};
  const known = new Set(stageIds);
  for (const [origin, routes] of [
    [`modelRouting.workflows.${workflowId}.stages`, configured],
    ["route override", overrides ?? {}],
  ] as const)
    for (const stageId of Object.keys(routes))
      if (!known.has(stageId))
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `${origin} names stage ${stageId}, which workflow ${workflowId} does not have (stages: ${stageIds.join(", ")})`,
        );
  const routes: StageRoute[] = [];
  for (const stageId of stageIds) {
    const override = overrides?.[stageId];
    const ref = override ?? configured[stageId];
    if (!ref) continue;
    const origin = override
      ? `route override ${stageId}`
      : `modelRouting.workflows.${workflowId}.stages.${stageId}`;
    routes.push({ stageId, ...resolveRef(ref, origin, inputs) });
  }
  return routes;
}

/** Merges a project layer over the global one, section by section and workflow by workflow. */
export function mergeModelRouting(
  base: ModelRouting | undefined,
  layer: ModelRouting | undefined,
): ModelRouting | undefined {
  if (!layer) return base;
  if (!base) return layer;
  const workflows: NonNullable<ModelRouting["workflows"]> = { ...base.workflows };
  for (const [id, entry] of Object.entries(layer.workflows ?? {}))
    workflows[id] = { stages: { ...workflows[id]?.stages, ...entry.stages } };
  return {
    classes: { ...base.classes, ...layer.classes },
    roles: { ...base.roles, ...layer.roles },
    profiles: { ...base.profiles, ...layer.profiles },
    workflows,
  };
}

/** The frozen routing record a run keeps, so resume, fork and revise use the same models. */
export const RoutingRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    runModel: z.string(),
    profiles: z.record(z.string(), z.object({ model: z.string(), source: z.string() }).strict()),
    stages: z.record(z.string(), z.object({ model: z.string(), source: z.string() }).strict()),
  })
  .strict();
export type RoutingRecord = z.infer<typeof RoutingRecordSchema>;
export const ROUTING_ARTIFACT = "routing.json";
