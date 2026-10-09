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
      ["pending", "invalidated"].includes(statuses.get(t.id) ?? "pending") &&
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
