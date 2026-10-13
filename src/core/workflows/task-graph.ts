import { hashJson } from "../specs/hash.js";
import { pathsInOutput } from "../verification/convergence.js";
import { writtenCodePaths } from "./check-policy.js";
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
  waitingFor: RuntimeState["waitingFor"] = {},
): Task[] {
  const statuses = new Map(rows.map((r) => [r.id, r.status]));
  return graph.tasks.filter(
    (t) =>
      ["pending", "invalidated", "interrupted"].includes(statuses.get(t.id) ?? "pending") &&
      [...t.dependsOn, ...(waitingFor[t.id] ?? [])].every((dep) =>
        rows.some(
          (row) =>
            row.id === dep &&
            (row.status === "verified" ||
              (row.status === "implemented" && hasTaskGate(row, gates))),
        ),
      ),
  );
}

/** Whether `text` names `path`: the path itself, or a module path's dotted form (`pkg.__main__`). */
function namesPath(text: string, path: string): boolean {
  if (text.includes(path)) return true;
  const stem = path.replace(/\.[^./]+$/, "");
  if (!stem.includes("/")) return false;
  const dotted = stem.replaceAll("/", ".").replace(/\.__init__$/, "");
  return new RegExp(`(?:^|[^\\w.])${dotted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`).test(
    text,
  );
}

/**
 * The unfinished tasks that a task reporting `blocked` should wait for: tasks that write a file
 * its account names (a missing `cfgtrace.__main__` the CLI task has not written yet), that it does
 * not already wait for and that do not wait for it. A planner left a README that captures CLI
 * output without a dependency on the CLI task; it ran first, blocked and stopped the run (bench
 * round 12, cfgtrace 4018a791). A task that is blocked, failed or cancelled is not waited for.
 */
export function missingArtifactOwners(
  graph: TaskGraph,
  rows: TaskRow[],
  task: Task,
  account: { summary: string; unresolved: readonly string[] },
  waitingFor: RuntimeState["waitingFor"] = {},
): string[] {
  const text = [account.summary, ...account.unresolved].join("\n");
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const edges = (id: string): string[] => [
    ...(graph.tasks.find((t) => t.id === id)?.dependsOn ?? []),
    ...(waitingFor[id] ?? []),
  ];
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return edges(from).some((id) => reaches(id, to, seen));
  };
  return graph.tasks
    .filter(
      (other) =>
        other.id !== task.id &&
        !["implemented", "verified", "blocked", "failed", "cancelled"].includes(
          status.get(other.id) ?? "pending",
        ) &&
        !reaches(task.id, other.id) &&
        !reaches(other.id, task.id) &&
        other.writes.some(
          (w) =>
            w.action !== "delete" &&
            !task.writes.some((own) => own.path === w.path) &&
            namesPath(text, w.path),
        ),
    )
    .map((other) => other.id);
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

/**
 * Code files that the graph's other tasks will still write: tasks that are neither verified nor
 * implemented with a current gate. A task-end check does not hold the task to their contents.
 */
export function pendingCodePaths(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"],
  task: Task,
): string[] {
  const done = (id: string): boolean =>
    rows.some(
      (r) =>
        r.id === id &&
        (r.status === "verified" || (r.status === "implemented" && hasTaskGate(r, gates))),
    );
  const own = new Set(task.writes.map((w) => w.path));
  return [
    ...new Set(
      (graph?.tasks ?? [])
        .filter((t) => t.id !== task.id && !done(t.id))
        .flatMap((t) => writtenCodePaths(t))
        .filter((path) => !own.has(path)),
    ),
  ];
}
/**
 * The tasks still to run that the failure of a task check waits for, or none when the failure is
 * the task's own. They are the owners of every planned file the output names, and the owners of
 * the files the task reads (`readHints`) that another task writes: a TypeScript import error names
 * the importing file, which is the task's own (zoneslot-update c941a83a: App.tsx read overlap.ts
 * of a task in the same wave). The failure is the task's own when nothing it reads is pending and
 * the output names a file the task may write, names no planned file, or an owner cannot run
 * before the task (it depends on it, so waiting would never end).
 */
export function pendingOwners(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"],
  task: Task,
  output: string,
): string[] {
  if (!graph) return [];
  const done = (id: string): boolean =>
    rows.some(
      (r) =>
        r.id === id &&
        (r.status === "verified" || (r.status === "implemented" && hasTaskGate(r, gates))),
    );
  const dependsOn = (id: string, target: string, seen = new Set<string>()): boolean => {
    for (const dep of graph.tasks.find((t) => t.id === id)?.dependsOn ?? []) {
      if (dep === target) return true;
      if (seen.has(dep)) continue;
      seen.add(dep);
      if (dependsOn(dep, target, seen)) return true;
    }
    return false;
  };
  const writers = (path: string) =>
    graph.tasks.filter(
      (t) =>
        t.id !== task.id &&
        t.writes.some((w) => w.path === path && w.action !== "delete") &&
        !done(t.id),
    );
  const own = (path: string) => task.writes.some((w) => w.path === path);
  const read = new Set(
    task.readHints
      .filter((path) => !own(path))
      .flatMap(writers)
      .filter((t) => !dependsOn(t.id, task.id))
      .map((t) => t.id),
  );
  const named = pathsInOutput(output, graph.tasks);
  if (!named.length || named.some(own)) return [...read];
  const owners = new Set(read);
  for (const path of named) {
    const pending = graph.tasks.filter(
      (t) => t.id !== task.id && t.writes.some((w) => w.path === path) && !done(t.id),
    );
    if (!pending.length || pending.some((t) => dependsOn(t.id, task.id))) return [...read];
    for (const t of pending) owners.add(t.id);
  }
  return [...owners];
}
