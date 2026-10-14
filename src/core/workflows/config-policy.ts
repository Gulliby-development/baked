import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowConfigSchema } from "./schemas.js";

export type WorkflowConfig = NonNullable<ReturnType<typeof WorkflowConfigSchema.parse>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Nested objects merge key by key; arrays, null and scalars replace the default. */
function mergeOver(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = mergeOver(base[key], value);
  return out;
}

/**
 * Parses a `workflows` block of a config file (#1049). A `policy` that names only some fields,
 * such as `autoApproval` and `checks`, is merged over `defaultWorkflowPolicy`, so a full policy
 * parses to exactly what it says and a partial one keeps the defaults for the rest. An invalid
 * block fails with one line that names the file and each wrong field, not a ZodError dump.
 */
export function parseWorkflowConfig(raw: unknown, source: string): WorkflowConfig {
  const block = isObject(raw) ? raw : {};
  const parsed = WorkflowConfigSchema.safeParse({
    ...block,
    policy: mergeOver(defaultWorkflowPolicy, block.policy),
  });
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map(
    (issue) => `workflows.${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid workflow settings in ${source}: ${problems.join("; ")}`);
}
