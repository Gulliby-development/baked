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
 * holds only when the spec and plan are unchanged and no task's write scope changed (no task
 * added or removed either), and then for an implemented task whose own definition is unchanged,
 * that depends only on kept tasks and shares no file with a task that is implemented again. Its
 * evidence is still invalidated: its task checks and the run's checks run again on the current
 * snapshot.
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
    hashJson(before.spec) !== hashJson(after.spec) ||
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
      hashJson(JSON.parse(row.definition_json)) === hashJson(task)
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
