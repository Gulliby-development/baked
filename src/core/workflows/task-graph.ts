import { hashJson } from "../specs/hash.js";
import type { TaskGraph } from "./schemas.js";
import type { TaskRow } from "./store.js";
import type { RuntimeState, Task } from "./types.js";
export function hasTaskGate(row: TaskRow, gates: RuntimeState["taskGates"]): boolean {
  const gate = gates[row.id];
  return (
    !!gate &&
    gate.generation === row.generation &&
    gate.snapshotId === row.snapshot_id &&
    gate.definitionHash === hashJson(JSON.parse(row.definition_json))
  );
}
export function readyTasks(
  graph: TaskGraph,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"] = {},
): Task[] {
  const statuses = new Map(rows.map((r) => [r.id, r.status]));
  return graph.tasks.filter(
    (t) =>
      ["pending", "invalidated", "interrupted"].includes(statuses.get(t.id) ?? "pending") &&
      t.dependsOn.every((dep) =>
        rows.some(
          (row) =>
            row.id === dep &&
            (row.status === "verified" ||
              (row.status === "implemented" && hasTaskGate(row, gates))),
        ),
      ),
  );
}
/**
 * Tasks whose implementation a package revision keeps instead of implementing them again. This
 * holds only when the plan is unchanged, the spec is unchanged apart from added acceptance
 * criteria, and no task's write scope changed (no task added or removed either), and then for an
 * implemented task whose own definition is unchanged apart from added criteria, that depends only
 * on kept tasks and shares no file with a task that is implemented again. Its evidence is still
 * invalidated: its task checks and the run's checks run again on the current snapshot, and the
 * run's review covers the criteria it gained.
 */
export function reusableImplementations(
  before: RuntimeState,
  after: RuntimeState,
  rows: TaskRow[],
): Set<string> {
  const kept = new Set<string>();
  const graph = after.graph;
  if (!before.graph || !graph || !before.spec || !after.spec) return kept;
  const scope = (tasks: TaskGraph["tasks"]) =>
    hashJson(Object.fromEntries(tasks.map((task) => [task.id, task.writes])));
  if (
    !onlyAddsCriteria(before.spec, after.spec) ||
    before.plan !== after.plan ||
    scope(before.graph.tasks) !== scope(graph.tasks)
  )
    return kept;
  for (const task of graph.tasks) {
    const row = rows.find((entry) => entry.id === task.id);
    if (
      row &&
      ["implemented", "verified"].includes(row.status) &&
      row.snapshot_id !== null &&
      sameApartFromAddedCriteria(JSON.parse(row.definition_json) as Task, task)
    )
      kept.add(task.id);
  }
  for (let changed = true; changed; ) {
    changed = false;
    const redone = new Set(
      graph.tasks.filter((t) => !kept.has(t.id)).flatMap((t) => t.writes.map((w) => w.path)),
    );
    for (const task of graph.tasks)
      if (
        kept.has(task.id) &&
        (task.dependsOn.some((dep) => !kept.has(dep)) ||
          task.writes.some((write) => redone.has(write.path)))
      ) {
        kept.delete(task.id);
        changed = true;
      }
  }
  return kept;
}
/** The revision number aside, `after` keeps every criterion of `before` and adds only criteria. */
function onlyAddsCriteria(
  before: NonNullable<RuntimeState["spec"]>,
  after: NonNullable<RuntimeState["spec"]>,
): boolean {
  const rest = ({ revision: _r, criteria: _c, ...spec }: NonNullable<RuntimeState["spec"]>) => spec;
  const criteria = new Map(after.criteria.map((c) => [c.id, hashJson(c)] as const));
  return (
    hashJson(rest(before)) === hashJson(rest(after)) &&
    before.criteria.every((c) => criteria.get(c.id) === hashJson(c))
  );
}
/** The task is unchanged apart from criterion IDs added to its list. */
function sameApartFromAddedCriteria(before: Task, after: Task): boolean {
  const { criterionIds: was, ...rest } = before;
  const { criterionIds: now, ...next } = after;
  return hashJson(rest) === hashJson(next) && was.every((id) => now.includes(id));
}
