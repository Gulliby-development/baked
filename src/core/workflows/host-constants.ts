/**
 * Fields of a submitted result that only the host knows, filled before the result is validated,
 * and ids in a shape other than the host's renamed to it (`host-ids.ts`).
 * A model that writes a wrong schema version or invents a hash has done nothing wrong worth a
 * rejection: the schema version is a constant, and the plan's hashes are replaced with the
 * accepted spec's and plan's when the task graph is stored.
 */
import { z } from "zod";
import { normalizePlanIds, normalizeSpecIds } from "./host-ids.js";

/** Stands in for a plan hash the model left out or got wrong; the scheduler binds the real one. */
const PENDING_HASH = "0".repeat(64);
const HASH = /^[a-f0-9]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The literal a schema's top-level `schemaVersion` must have, or undefined when it has none. */
function schemaVersionOf(schema: z.ZodType): unknown {
  if (!(schema instanceof z.ZodObject)) return undefined;
  const field = (schema.shape as Record<string, z.ZodType>).schemaVersion;
  return field instanceof z.ZodLiteral ? field.value : undefined;
}

/**
 * The fields `fillHostConstants` fills or the scheduler rebinds, per output, as dotted paths; `*`
 * applies to every output. The advertised tool schema makes each optional (#1929), so the list
 * and the filling cannot drift: a host-filled field is added here, never left required.
 */
export const HOST_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "*": ["schemaVersion"],
  analysis: ["inputHash"],
  plan: [
    "taskGraph.schemaVersion",
    "taskGraph.revision",
    "taskGraph.specHash",
    "taskGraph.planHash",
  ],
};

const HOST_NOTE = "Filled by the host; leave it out.";

/** `schema` with the field at `path` optional and described as host-filled, when it has one. */
function hostFieldOptional(schema: z.ZodType, path: readonly string[]): z.ZodType {
  const [key, ...rest] = path;
  if (!(schema instanceof z.ZodObject) || key === undefined) return schema;
  const field = (schema.shape as Record<string, z.ZodType>)[key];
  if (!field) return schema;
  // A hash pattern is dropped too: the model has no way to compute the digest it describes.
  const replaced = rest.length
    ? hostFieldOptional(field, rest)
    : (field instanceof z.ZodString ? z.string() : field).optional().describe(HOST_NOTE);
  return schema.safeExtend({ [key]: replaced });
}

/**
 * The schema a model is shown for an `output`'s submission: the result schema with every host
 * field optional. A model that will not invent a plan hash otherwise never submits (php-slugify
 * 151471f5). Only its JSON schema is used; submissions are validated by `withHostConstants`.
 */
export function advertisedSchema(output: string, schema: z.ZodType): z.ZodType {
  return [...(HOST_FIELDS["*"] ?? []), ...(HOST_FIELDS[output] ?? [])].reduce(
    (advertised, path) => hostFieldOptional(advertised, path.split(".")),
    schema,
  );
}

/** `value` with the host-known fields of an `output` result set. */
export function fillHostConstants(output: string, version: unknown, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const filled: Record<string, unknown> = { ...value };
  if (version !== undefined) filled.schemaVersion = version;
  // The analysis is bound to the manifest the host gave it; a hand-copied hash (d0f55591 transposed
  // two characters) is replaced by the scheduler, so a missing or malformed one is no rejection.
  if (
    output === "analysis" &&
    (typeof filled.inputHash !== "string" || !HASH.test(filled.inputHash))
  )
    filled.inputHash = PENDING_HASH;
  // Ids are labels the host names: one written as R1 or T1 is renamed, not refused (#1871).
  if (output === "spec") return normalizeSpecIds(filled);
  if (output === "plan" && isRecord(filled.taskGraph)) {
    const renamed = normalizePlanIds(filled);
    const graph: Record<string, unknown> = {
      ...(renamed.taskGraph as Record<string, unknown>),
      schemaVersion: 1,
    };
    for (const key of ["specHash", "planHash"])
      if (typeof graph[key] !== "string" || !HASH.test(graph[key] as string))
        graph[key] = PENDING_HASH;
    if (!Number.isInteger(graph.revision) || (graph.revision as number) < 1) graph.revision = 1;
    return { ...renamed, taskGraph: graph };
  }
  return filled;
}

/** The submission schema of an `output`: the result schema behind the host-known fields. */
export function withHostConstants(output: string, schema: z.ZodType): z.ZodType {
  const version = schemaVersionOf(schema);
  return z.preprocess((value) => fillHostConstants(output, version, value), schema);
}
