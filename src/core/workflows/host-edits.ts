import type { HostEdit } from "./host-edits-model.js";
import type { TaskGraph } from "./schemas.js";

export type { HostEdit } from "./host-edits-model.js";

export const HOST_EDITS_PATH = "host-edits.json";
export const HOST_ADDITIONS = [
  "The host derives module, read, test and command dependencies and covering checkIds.",
  "Sizing can split test tasks by file or criterion and append scope and batching guidance.",
  "Tasks carrying complete file content run through the host; counts are computed after edits.",
  "Describe the planned work without claiming that its checks, dependencies or task counts are final.",
];

/** Capture each transformation while its input still identifies the planner's contribution. */
export function recordGraphEdits(
  before: TaskGraph,
  after: TaskGraph,
  kind: string,
  edits?: HostEdit[],
  origins: ReadonlyMap<string, string> = new Map(),
): TaskGraph {
  if (!edits) return after;
  for (const task of after.tasks) {
    const original = before.tasks.find((t) => t.id === (origins.get(task.id) ?? task.id));
    if (!before.tasks.some((t) => t.id === task.id))
      edits.push({
        task: task.id,
        field: "$task",
        kind,
        before: null,
        after: structuredClone(task),
        text: "",
      });
    if (!original) continue;
    for (const field of Object.keys(task) as Array<keyof typeof task>) {
      const old = original[field] ?? null;
      const next = task[field] ?? null;
      if (JSON.stringify(old) === JSON.stringify(next)) continue;
      // For new parts, record inherited planner text separately from appended host text.
      const text =
        typeof old === "string" && typeof next === "string" && next.startsWith(old)
          ? next.slice(old.length).trim()
          : "";
      edits.push({
        task: task.id,
        field,
        kind,
        before: structuredClone(old),
        after: structuredClone(next),
        text,
      });
    }
  }
  return after;
}

/** Reverse host transformations for checks that judge the planner's own task text. */
export function plannerGraph(graph: TaskGraph, edits: readonly HostEdit[] = []): TaskGraph {
  const created = new Set(edits.filter((edit) => edit.field === "$task").map((edit) => edit.task));
  let tasks = structuredClone(graph.tasks).filter((task) => !created.has(task.id));
  for (const edit of [...edits].reverse()) {
    if (!edit.task || created.has(edit.task)) continue;
    tasks = tasks.map((task) => {
      if (task.id !== edit.task || !(edit.field in task)) return task;
      const restored = { ...task, [edit.field]: edit.before };
      if (edit.before === null) delete (restored as Record<string, unknown>)[edit.field];
      return restored;
    });
  }
  return { ...graph, tasks };
}

const normalized = (text: string): string => text.replace(/\s+/g, " ").trim();

function addedValues(edit: HostEdit): string[] {
  if (edit.text) return [edit.text];
  if (Array.isArray(edit.after) && Array.isArray(edit.before)) {
    const before = new Set(edit.before.map((value: unknown) => JSON.stringify(value)));
    return edit.after
      .filter((value: unknown) => !before.has(JSON.stringify(value)))
      .filter((value: unknown): value is string => typeof value === "string");
  }
  if (typeof edit.after === "string" && !["description", "title"].includes(edit.field))
    return [edit.after];
  if (edit.before === null && edit.after !== null && edit.field !== "$task")
    return [JSON.stringify(edit.after)];
  return [];
}

/** Demote only evidence wholly owned by the host, never a mixed spec/planner conflict. */
export function hostOnlyEvidence(
  finding: { kind: string; refs: readonly string[]; description: string },
  edits: readonly HostEdit[],
  plan: string,
): HostEdit[] {
  if (finding.kind !== "inconsistency") return [];
  const quoted = /"([^"\n]+)"|`([^`\n]+)`|'([^'\n]{4,})'/g;
  const quotes = [...finding.description.matchAll(quoted)].map((match) =>
    normalized(match[1] ?? match[2] ?? match[3] ?? ""),
  );
  const all = [...finding.refs, finding.description.replace(quoted, " ")].join(" ");
  if (/\b(?:AC|FR|NFR|SC)-\d+\b|\bspec\.json\b/.test(all)) return [];
  const named = new Set(all.match(/\bT\d{3,}\b/g) ?? []);
  const fields = finding.refs.flatMap((ref) => {
    const path = ref.replace(/^tasks\.json[#/]?/, "").replace(/^#?\/?tasks\//, "");
    const match = /^(T\d{3,})[/.#:]([A-Za-z]+)$/.exec(path);
    return match ? [{ task: match[1], field: match[2] }] : [];
  });
  const matches = edits.filter((edit) => {
    if (edit.field === "$task" || (edit.task && named.size && !named.has(edit.task))) return false;
    if (
      fields.length &&
      !fields.some((field) => field.task === edit.task && field.field === edit.field)
    )
      return false;
    const values = addedValues(edit).map(normalized);
    return (
      quotes.some((quote) => values.some((value) => value.includes(quote))) ||
      (fields.some((field) => field.task === edit.task && field.field === edit.field) &&
        values.length > 0)
    );
  });
  if (!matches.length) return [];
  if (
    fields.some(
      (field) => !matches.some((edit) => edit.task === field.task && edit.field === field.field),
    )
  )
    return [];
  if (
    [...named].some(
      (id) => !matches.some((edit) => edit.task === id || addedValues(edit).includes(id)),
    )
  )
    return [];
  if (
    quotes.some(
      (quote) =>
        normalized(plan).includes(quote) ||
        matches.some(
          (edit) => typeof edit.before === "string" && normalized(edit.before).includes(quote),
        ) ||
        !matches.some((edit) =>
          addedValues(edit).some((value) => normalized(value).includes(quote)),
        ),
    )
  )
    return [];
  if (
    finding.refs.some(
      (ref) =>
        ref !== "tasks.json" &&
        ref !== HOST_EDITS_PATH &&
        !/^T\d{3,}$/.test(ref) &&
        !fields.some((field) => {
          const path = ref.replace(/^tasks\.json[#/]?/, "").replace(/^#?\/?tasks\//, "");
          return (
            path === `${field.task}.${field.field}` ||
            path === `${field.task}/${field.field}` ||
            path === `${field.task}:${field.field}`
          );
        }) &&
        ref !== "plan.md",
    )
  )
    return [];
  // A broad reference needs an exact host quote; a task ID alone does not prove ownership.
  return quotes.length || fields.length ? matches : [];
}
