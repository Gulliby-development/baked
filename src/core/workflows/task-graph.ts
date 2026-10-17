import { hashJson } from "../specs/hash.js";
import { failingFilesInOutput, failingPathsInOutput } from "../verification/convergence.js";
import { isDocFile } from "../verification/doc-examples.js";
import { isTestFile } from "./affected-tests.js";
import { writtenCodePaths } from "./check-policy.js";
import type { TaskGraph } from "./schemas.js";
import type { TaskRow } from "./store.js";
import { isTestPath } from "./test-integrity.js";
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
  const ready = graph.tasks.filter(
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
  // A documentation task a corrective invalidated waits until the correctives that are running
  // or ready have finished, then reruns once: a README rerun after each source corrective is
  // redone by the next one (cfgtrace 14b1da41 T011 ran four times for 902k tokens, #1211).
  const correcting = graph.tasks.some(
    (t) =>
      t.origin !== "planned" &&
      (statuses.get(t.id) === "running" || ready.some((r) => r.id === t.id)),
  );
  // So does a planned task whose earlier implementation passed its gate and that declares checks:
  // its checks run in the host before its agent, and a whole-project check (`pytest -q`,
  // `go test ./...`) stays red until the other correctives land, so the agent reran tasks that
  // were already right (zonevet cc41bbb9, ecfit 25614519: 1.07M tokens, #1248).
  const settledByChecks = (t: Task): boolean =>
    t.origin === "planned" && t.checkIds.length > 0 && gates[t.id]?.definitionHash === hashJson(t);
  return correcting
    ? ready.filter(
        (t) => !(statuses.get(t.id) === "invalidated" && (documentsOnly(t) || settledByChecks(t))),
      )
    : ready;
}

/**
 * Whether the host writes the task's files itself: every write creates or replaces a file with
 * the content the plan fixed, so no agent attempt runs (#1460). A task that also deletes, or has a
 * write without content, is an agent task.
 */
export function hostWritten(task: Pick<Task, "writes">): boolean {
  return (
    task.writes.length > 0 &&
    task.writes.every((w) => w.action !== "delete" && w.content !== undefined)
  );
}

/**
 * Plan problems of host-written content (#1460): a task that carries content on only some of its
 * writes, or on a delete, would have its content ignored and an agent write the files instead.
 */
export function hostContentProblems(graph: Pick<TaskGraph, "tasks">): string[] {
  return graph.tasks.flatMap((task) => {
    const carried = task.writes.filter((w) => w.content !== undefined);
    if (!carried.length || hostWritten(task)) return [];
    return [
      `Task ${task.id} gives content to ${carried.map((w) => w.path).join(", ")} but not to every write, or deletes a file; the host writes a task's files only when every write carries its content and none deletes. Put the files with fixed content in a task of their own, or remove their content.`,
    ];
  });
}

/**
 * Plan problems of a run whose files are fixed before planning (an initiative feature's skeleton,
 * #1461): every file is written by one host-written task with exactly its content, and no other
 * task creates it.
 */
export function hostFileProblems(
  graph: Pick<TaskGraph, "tasks">,
  files: readonly { path: string; content: string }[] | null,
): string[] {
  if (!files?.length) return [];
  const owners = new Set<string>();
  const wrong: string[] = [];
  for (const file of files) {
    const writer = graph.tasks.find(
      (t) =>
        hostWritten(t) && t.writes.some((w) => w.path === file.path && w.content === file.content),
    );
    if (writer) owners.add(writer.id);
    else wrong.push(file.path);
  }
  const creators = graph.tasks.filter(
    (t) =>
      !owners.has(t.id) &&
      t.writes.some((w) => w.action === "create" && files.some((f) => f.path === w.path)),
  );
  const problems: string[] = [];
  if (wrong.length || owners.size > 1)
    problems.push(
      `extra.hostFiles fixes the content of ${files.map((f) => f.path).join(", ")}: write all of them in one task whose writes carry exactly that content${wrong.length ? `; ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not written that way` : ""}.`,
    );
  for (const task of creators)
    problems.push(
      `Task ${task.id} creates a file of extra.hostFiles; the host-written task creates it, so modify it after that task instead.`,
    );
  return problems;
}

/** Whether a task writes only documentation: Markdown, a README, a licence or a changelog. */
export function documentsOnly(task: Task): boolean {
  return (
    task.origin === "planned" &&
    task.writes.length > 0 &&
    task.writes.every(
      (w) =>
        isDocFile(w.path) ||
        /^(licen[cs]e|copying|notice|changelog|authors)(\.[a-z]+)?$/i.test(
          w.path.split("/").at(-1) ?? "",
        ),
    )
  );
}

/**
 * Whether `text` names `path`: the path itself, or a module path's dotted form (`pkg.__main__`).
 * The dotted form followed by `/` or `.` and another component is a prefix of a longer path or
 * module (`ignorewhy/globs.py`), so it names that, not the package's `__init__.py` (#1031).
 */
export function namesPath(text: string, path: string): boolean {
  if (text.includes(path)) return true;
  const stem = path.replace(/\.[^./]+$/, "");
  if (!stem.includes("/")) return false;
  const dotted = stem.replaceAll("/", ".").replace(/\.__init__$/, "");
  return new RegExp(
    `(?:^|[^\\w.])${dotted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w]|[./\\\\]\\w)`,
  ).test(text);
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
  const named = failingFilesInOutput(output, graph.tasks);
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

/** A Rust integration test, `tests/*.rs` of a crate, which `cargo test` runs as its own binary. */
const isRustTestFile = (path: string): boolean => /(?:^|\/)tests\/[^/]+\.rs$/.test(path);

/**
 * The unfinished planned tasks that update the existing tests a failed check of `task` names, when
 * every file the output names is such a test: tests the task itself does not write and that a
 * later task of the plan rewrites. The plan already knows the change breaks them (bench round 14,
 * mdtoc-update: T001 changed `parseArgs`, T003 "Update existing CLI option expectations" depends on
 * it), so the failure is that task's to settle, not a regression of `task`. Unlike
 * `pendingOwners`, the owners may depend on `task`: nothing waits for them.
 */
export function testUpdateOwners(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"],
  task: Task,
  output: string,
): string[] {
  if (!graph || task.origin !== "planned") return [];
  // Where the output locates failures, only those files count: a type error in a test names the
  // source declaration it disagrees with in an indented line (mdtoc-update 952805a8, #972).
  const located = failingPathsInOutput(output, graph.tasks);
  const named = located.length ? located : failingFilesInOutput(output, graph.tasks);
  if (!named.length || !named.every((path) => isTestFile(path) || isRustTestFile(path))) return [];
  if (named.some((path) => task.writes.some((w) => w.path === path))) return [];
  const owners = new Set<string>();
  for (const path of named) {
    const pending = pendingWriters(graph, rows, gates, task, path);
    if (!pending.length) return [];
    for (const id of pending) owners.add(id);
  }
  return [...owners];
}

/**
 * The planned tasks other than `task` that write `path` and have not finished: a repair of
 * `task` must leave the file to them (mdtoc-update 952805a8: a corrective task rewrote the tests
 * four later tasks update, #972).
 */
export function pendingWriters(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"],
  task: Pick<Task, "id">,
  path: string,
): string[] {
  const done = (id: string): boolean =>
    rows.some(
      (r) =>
        r.id === id &&
        (r.status === "verified" || (r.status === "implemented" && hasTaskGate(r, gates))),
    );
  return (graph?.tasks ?? [])
    .filter(
      (t) =>
        t.id !== task.id &&
        t.origin === "planned" &&
        t.writes.some((w) => w.path === path && w.action !== "delete") &&
        !done(t.id),
    )
    .map((t) => t.id);
}

/**
 * The planned tasks a corrective task corrects, following correctives of correctives through the
 * predecessors of their findings.
 */
export function correctedTasks(
  graph: TaskGraph,
  task: Task,
  predecessors: RuntimeState["repairPredecessors"],
  seen = new Set<string>(),
): Task[] {
  if (task.origin === "planned") return [task];
  if (seen.has(task.id)) return [];
  seen.add(task.id);
  return task.findingIds.flatMap((id) => {
    const base = graph.tasks.find((t) => t.id === predecessors[id]);
    return base && base.id !== task.id ? correctedTasks(graph, base, predecessors, seen) : [];
  });
}

/**
 * The other corrective tasks still to finish that are correcting every test file a corrective
 * task's failed check names, or none. Parallel correctives of test tasks that share one test
 * command each ran the others' failing tests and opened a corrective of themselves for defects
 * their siblings were still fixing (md-site 337d16db: T011 to T013, 1.45M tokens, #1285). Such a
 * check runs again once those correctives are done. A failure in a test file of the task's own
 * planned tasks, or in one no other corrective is fixing, is the task's own.
 */
export function siblingCorrections(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  task: Task,
  output: string,
  predecessors: RuntimeState["repairPredecessors"],
): string[] {
  if (!graph || task.origin === "planned") return [];
  const named = failingFilesInOutput(output, graph.tasks).filter(isTestPath);
  if (!named.length) return [];
  const writes = (tasks: Task[], path: string) =>
    tasks.some((t) => t.writes.some((w) => w.path === path && w.action !== "delete"));
  if (named.some((path) => writes(correctedTasks(graph, task, predecessors), path))) return [];
  // Only correctives whose agent has still to finish: one that is implemented and waits for its
  // checks is in the same position, and two of them waiting for each other would wait forever.
  const status = new Map(rows.map((r) => [r.id, r.status]));
  const running = graph.tasks.filter(
    (t) =>
      t.id !== task.id &&
      t.origin !== "planned" &&
      ["pending", "running", "invalidated", "interrupted"].includes(status.get(t.id) ?? "pending"),
  );
  const siblings = new Set<string>();
  for (const path of named) {
    const fixing = running.filter((t) => writes(correctedTasks(graph, t, predecessors), path));
    if (!fixing.length) return [];
    for (const t of fixing) siblings.add(t.id);
  }
  return [...siblings];
}
