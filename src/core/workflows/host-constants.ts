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
