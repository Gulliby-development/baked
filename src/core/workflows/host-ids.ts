/**
 * The ids the host gives the parts of a spec and a task graph (#1871). The schemas, the agent
 * instructions and the normaliser are all built from this one table, so a model reads the format
 * the schema checks, and an id a model wrote in another common shape (`R1`, `REQ-2`, `AC1`, `T1`)
 * is renamed to it before validation instead of costing the whole result a second call.
 */

export const HOST_ID_FORMATS = {
  requirement: { pattern: /^(FR|NFR|SC)-[0-9]{3,6}$/, examples: "FR-001, NFR-001 or SC-001" },
  criterion: { pattern: /^AC-[0-9]{3,6}$/, examples: "AC-001" },
  task: { pattern: /^T[0-9]{3,6}$/, examples: "T001" },
} as const;

/** The sentence the spec author's instructions state the formats in. */
export const SPEC_ID_RULE = `Requirement ids are ${HOST_ID_FORMATS.requirement.examples} (functional, non-functional, success criterion), criterion ids are ${HOST_ID_FORMATS.criterion.examples}, and criteria and deliverables reference requirements by exactly those ids.`;

/** Spellings a model uses for each kind, with the host prefix each one maps to. */
const SPELLINGS: Record<keyof typeof HOST_ID_FORMATS, [RegExp, (prefix: string) => string]> = {
  requirement: [
    /^\s*(FR|NFR|SC|REQ|R|F)[\s_.-]*0*([0-9]{1,6})\s*$/i,
    (prefix) => {
      const upper = prefix.toUpperCase();
      return upper === "NFR" || upper === "SC" ? `${upper}-` : "FR-";
    },
  ],
  criterion: [/^\s*(AC|A|C)[\s_.-]*0*([0-9]{1,6})\s*$/i, () => "AC-"],
  task: [/^\s*(TASK|T)[\s_.-]*0*([0-9]{1,6})\s*$/i, () => "T"],
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The renaming of `ids` to the host format, or null when nothing needs renaming or the result
 * would not be a set of distinct valid ids (the schema then refuses with its own issues).
 */
function renaming(kind: keyof typeof HOST_ID_FORMATS, ids: unknown[]): Map<string, string> | null {
  const { pattern } = HOST_ID_FORMATS[kind];
  const [spelling, prefix] = SPELLINGS[kind];
  const map = new Map<string, string>();
  for (const id of ids) {
    if (typeof id !== "string") return null;
    if (pattern.test(id)) continue;
    const match = spelling.exec(id);
    if (!match) return null;
    map.set(id, `${prefix(match[1] ?? "")}${(match[2] ?? "").padStart(3, "0")}`);
  }
  if (!map.size) return null;
  const renamed = ids.map((id) => map.get(id as string) ?? (id as string));
  return new Set(renamed).size === renamed.length ? map : null;
}

const rename = (map: Map<string, string> | null, value: unknown): unknown =>
  map && typeof value === "string" ? (map.get(value) ?? value) : value;

const renameAll = (map: Map<string, string> | null, value: unknown): unknown =>
  Array.isArray(value) ? value.map((v) => rename(map, v)) : value;

/** A submitted spec with its requirement and criterion ids, and every reference, in host format. */
export function normalizeSpecIds(value: Record<string, unknown>): Record<string, unknown> {
  const requirements = Array.isArray(value.requirements) ? value.requirements : null;
  const criteria = Array.isArray(value.criteria) ? value.criteria : null;
  if (!requirements?.every(isRecord) || !criteria?.every(isRecord)) return value;
  const ids = renaming(
    "requirement",
    requirements.map((r) => r.id),
  );
  const criterionIds = renaming(
    "criterion",
    criteria.map((c) => c.id),
  );
  if (!ids && !criterionIds) return value;
  const deliverables = value.deliverables;
  return {
    ...value,
    requirements: requirements.map((r) => ({ ...r, id: rename(ids, r.id) })),
    criteria: criteria.map((c) => ({
      ...c,
      id: rename(criterionIds, c.id),
      requirementIds: renameAll(ids, c.requirementIds),
    })),
    ...(Array.isArray(deliverables)
      ? {
          deliverables: deliverables.map((d) =>
            isRecord(d) ? { ...d, requirementIds: renameAll(ids, d.requirementIds) } : d,
          ),
        }
      : {}),
  };
}

/** A submitted task graph with its task ids, and the dependencies on them, in host format. */
export function normalizeTaskIds(graph: Record<string, unknown>): Record<string, unknown> {
  const tasks = Array.isArray(graph.tasks) ? graph.tasks : null;
  if (!tasks?.every(isRecord)) return graph;
  const ids = renaming(
    "task",
    tasks.map((t) => t.id),
  );
  if (!ids) return graph;
  return {
    ...graph,
    tasks: tasks.map((t) => ({
      ...t,
      id: rename(ids, t.id),
      dependsOn: renameAll(ids, t.dependsOn),
    })),
  };
}
