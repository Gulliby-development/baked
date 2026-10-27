import { hashJson } from "../specs/hash.js";
import {
  failingFilesInOutput,
  failingPathsInOutput,
  isTestOf,
  missingPlannedPaths,
} from "../verification/convergence.js";
import { isDocFile } from "../verification/doc-examples.js";
import { writtenCodePaths } from "./check-policy.js";
import type { Spec, TaskGraph } from "./schemas.js";
import type { TaskRow } from "./store.js";
import { isTestPath } from "./test-integrity.js";
import type { RuntimeState, Task } from "./types.js";

function taskDependsOn(
  graph: TaskGraph,
  from: string,
  to: string,
  waitingFor: RuntimeState["waitingFor"],
  seen = new Set<string>(),
): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return [
    ...(graph.tasks.find((t) => t.id === from)?.dependsOn ?? []),
    ...(waitingFor[from] ?? []),
  ].some((id) => taskDependsOn(graph, id, to, waitingFor, seen));
}

/**
 * Whether `id` waits for `task`: it depends on it, or `task` is a corrective and `id` depends on a
 * task it corrects, which the corrective's hold in `readyTasks` keeps from running until the
 * corrective is done. Such a task can never be what the corrective waits for: skillcomb T024
 * (bench round 67, #2094) waited for T017, the later slice of the file it was correcting, while
 * T017 waited for T024's predecessor T010.
 */
export function waitsOnRepaired(
  graph: TaskGraph,
  id: string,
  task: Task,
  waitingFor: RuntimeState["waitingFor"],
  predecessors: RuntimeState["repairPredecessors"],
): boolean {
  return [
    task,
    ...(task.origin === "planned" ? [] : correctedTasks(graph, task, predecessors)),
  ].some((target) => taskDependsOn(graph, id, target.id, waitingFor));
}

/**
 * The files a corrective's hold in `readyTasks` covers, by task ID, when they are fewer than its
 * writes: those its findings point at, which its first attempt may write (`narrowCorrectionWrites`),
 * until it widens. A test-check corrective writes the union of its related tasks' writes, and its
 * hold kept every task depending on any of them waiting for the whole run (skillcomb R67, #2109).
 */
export type RepairHolds = Readonly<Record<string, readonly string[]>>;

/** Whether the task uses files the repair writes, through its dependencies or explicit reads. */
function affectedByRepair(
  graph: TaskGraph,
  task: Task,
  repair: Task,
  waitingFor: RuntimeState["waitingFor"],
  holds: RepairHolds = {},
): boolean {
  const paths = holds[repair.id] ?? repair.writes.map((w) => w.path);
  return (
    (!documentsOnly(task) &&
      graph.tasks.some(
        (base) =>
          base.origin === "planned" &&
          taskDependsOn(graph, task.id, base.id, waitingFor) &&
          base.writes.some((w) => paths.includes(w.path)),
      )) ||
    task.readHints.some((path) => paths.includes(path)) ||
    task.writes.some(
      (w) => paths.includes(w.path) || paths.some((source) => isTestOf(w.path, source)),
    )
  );
}
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
  predecessors: RuntimeState["repairPredecessors"] = {},
  holds: RepairHolds = {},
  parked: readonly string[] = [],
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
  const available = correcting
    ? ready.filter(
        (t) => !(statuses.get(t.id) === "invalidated" && (documentsOnly(t) || settledByChecks(t))),
      )
    : ready;
  // A task-level repair settles a known defect before downstream tasks test it again (#1612).
  // Keep unrelated work available to parallel writers, and retain dependency order on resume.
  // A blocked repair the drive parked to run independent work first keeps its hold (#2109).
  const repairs = graph.tasks.filter(
    (t) =>
      t.origin === "repair" &&
      (parked.includes(t.id) ||
        ["pending", "running", "invalidated", "interrupted"].includes(
          statuses.get(t.id) ?? "pending",
        )) &&
      t.findingIds.some((id) =>
        graph.tasks.some(
          (base) =>
            base.id === predecessors[id] &&
            base.origin === "planned" &&
            ["implemented", "verified", "blocked"].includes(statuses.get(base.id) ?? "pending"),
        ),
      ),
  );
  const affected = (task: Task, repair: Task): boolean =>
    task.origin === "planned" &&
    !taskDependsOn(graph, repair.id, task.id, waitingFor) &&
    affectedByRepair(graph, task, repair, waitingFor, holds);
  // Move a repair to the first ready task it holds back. Earlier unrelated tasks keep their
  // order, including a document's first run, whose dependency is not a failing code check.
  const order = new Map(available.map((t, index) => [t, index]));
  for (const repair of repairs) {
    if (!order.has(repair)) continue;
    const first = available.findIndex((t) => affected(t, repair));
    if (first >= 0) order.set(repair, Math.min(order.get(repair) ?? first, first));
  }
  return available
    .filter((t) => !repairs.some((repair) => affected(t, repair)))
    .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
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
 * Whether two contents differ in whitespace only, as a formatter lays them out. A planner that
 * formatted the split's stubs for the project's formatter check had its plan refused and wrote a
 * second host task to format them (bench round 50, selwhy, #1662).
 */
function sameLayoutFree(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const words = (text: string) => text.replace(/\s+/g, " ").trim();
  return a === b || words(a) === words(b);
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
        hostWritten(t) &&
        t.writes.some((w) => w.path === file.path && sameLayoutFree(w.content, file.content)),
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
      `extra.hostFiles fixes the content of ${files.map((f) => f.path).join(", ")}: write all of them in one task whose writes carry exactly that content${wrong.length ? `; ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not written that way` : ""}. Whitespace may follow the project's formatter; nothing else may differ.`,
    );
  for (const task of creators)
    problems.push(
      `Task ${task.id} creates a file of extra.hostFiles; the host-written task creates it, so modify it after that task instead.`,
    );
  return problems;
}

/** A quoted text that opens like a comment line in one of the supported languages. */
const COMMENT_QUOTE = /^(?:\/\/|\/\*|#|--|\(\*|;|%|<!--)/;

/**
 * Spec problems of a run whose files are fixed before planning: a requirement or criterion that
 * quotes a comment as a stub's content must quote the content the split fixes. The spec author of
 * bench round 57 modeplan foundation wrote "// Implementation deferred to its owning feature."
 * where the skeleton held "// Implementation is owned by a later feature.", and analysis found the
 * inconsistency only after a plan: a second specify, plan and analyze round of 407k tokens (#1847).
 * A quote counts when its sentence names a host-written file or a stub, placeholder or skeleton.
 */
export function hostFileSpecProblems(
  spec: Pick<Spec, "requirements" | "criteria">,
  files: readonly { path: string; content: string }[] | null,
): string[] {
  if (!files?.length) return [];
  const known = new Set(
    files.flatMap((f) => [f.content.trim(), ...f.content.split("\n").map((l) => l.trim())]),
  );
  const names = files.flatMap((f) => [f.path, f.path.split("/").at(-1) ?? f.path]);
  const aboutStubs = (text: string) =>
    /\b(?:stubs?|placeholders?|skeleton)\b/i.test(text) || names.some((n) => text.includes(n));
  const sentences = [
    ...spec.requirements.map((r) => ({ id: r.id, text: r.text })),
    ...spec.criteria.map((c) => ({ id: c.id, text: `${c.given} ${c.when} ${c.then}` })),
  ];
  const fixed = [...new Set(files.map((f) => JSON.stringify(f.content.trim())))].slice(0, 5);
  return sentences.flatMap(({ id, text }) => {
    if (!aboutStubs(text)) return [];
    const quotes = [...text.matchAll(/`([^`\n]+)`|"([^"\n]+)"/g)].map((m) =>
      (m[1] ?? m[2] ?? "").trim(),
    );
    const wrong = quotes.filter((q) => COMMENT_QUOTE.test(q) && !known.has(q));
    return wrong.map(
      (q) =>
        `${id} quotes ${JSON.stringify(q)} as the content of a host-written file, but the split fixes that content (extra.hostFiles): ${fixed.join(", ")}. Quote it exactly or leave the content out of ${id}.`,
    );
  });
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
  predecessors: RuntimeState["repairPredecessors"] = {},
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
        !waitsOnRepaired(graph, other.id, task, waitingFor, predecessors) &&
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

/**
 * The unfinished planned tasks that create the paths a failed check of `task` says do not exist,
 * when that is all it names of the plan's files: `ruff check src tests` after the task that
 * writes `src/` fails with E902 on `tests` until the task that writes `tests/` runs (rpn 09a1c786
 * blocked T001 and its correctives for 482k tokens, #1913). None when `task` itself writes under
 * such a path or the output names a file it writes: the failure is then its own.
 */
export function pathCreators(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"],
  task: Task,
  output: string,
): string[] {
  if (!graph) return [];
  const missing = missingPlannedPaths(output, graph.tasks);
  if (!missing.length) return [];
  const own = (path: string) => task.writes.some((w) => w.path === path);
  if (missing.some(own) || failingFilesInOutput(output, [task]).length) return [];
  const done = (id: string): boolean =>
    rows.some(
      (r) =>
        r.id === id &&
        (r.status === "verified" || (r.status === "implemented" && hasTaskGate(r, gates))),
    );
  return graph.tasks
    .filter(
      (t) =>
        t.id !== task.id &&
        t.origin === "planned" &&
        !done(t.id) &&
        t.writes.some((w) => w.action !== "delete" && missing.includes(w.path)),
    )
    .map((t) => t.id);
}

export interface FailureOwner {
  kind: "self" | "unowned" | "pending" | "test-update" | "creates" | "finished";
  owners: string[];
  files: string[];
}

/** Assertion values or messages, independent of the test name and diagnostic location. */
export function assertionFailureSignature(output: string): string {
  const outputLines = Bun.stripANSI(output).split(/\r?\n/);
  const assertions: string[] = [];
  for (let index = 0; index < outputLines.length; index++) {
    let assertion =
      /\b(expected\s*[:<].*|(?:received|actual)\s*:.*|(?:left|right)\s*:.*|(?:got|want)(?::\s*|\s+).*|assert\s+.+|AssertionError:\s*.+|assertion failed:\s*.+)/i.exec(
        outputLines[index] ?? "",
      )?.[1];
    if (!assertion) continue;
    // Array/object headers alone identify no value. Keep their complete multiline value;
    // truncated output must not make unrelated assertions match (#1612).
    if (/^(?:expected|received|actual|left|right)\s*:\s*[[{]/i.test(assertion)) {
      const balance = (line: string): number => {
        const unquoted = line.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
        return (unquoted.match(/[[{]/g)?.length ?? 0) - (unquoted.match(/[\]}]/g)?.length ?? 0);
      };
      let depth = balance(assertion);
      while (depth > 0 && index + 1 < outputLines.length) {
        const next = outputLines[++index] ?? "";
        depth += balance(next);
        assertion += `\n${next}`;
      }
      if (depth !== 0) return "";
    }
    if (/^(?:expected|received|actual|left|right)\s*:\s*$/i.test(assertion)) return "";
    assertions.push(
      assertion
        .split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)
        .map((part, i) => (i % 2 ? part : part.replace(/\s+/g, " ")))
        .join("")
        .trim(),
    );
  }
  return [...new Set(assertions)].sort().join("\n");
}

export interface PendingFindingFailure {
  taskId: string;
  output: string;
}

/** Only nonempty, equal assertions from durable check evidence identify a shared failure. */
export function sameFailureAsOpenFinding(
  output: string,
  findings: readonly PendingFindingFailure[],
): string[] {
  const signature = assertionFailureSignature(output);
  return signature
    ? [
        ...new Set(
          findings
            .filter((f) => assertionFailureSignature(f.output) === signature)
            .map((f) => f.taskId),
        ),
      ]
    : [];
}

/** One ownership decision for task checks, continuations, reports and request_check. */
export function failureOwner(
  graph: TaskGraph | null | undefined,
  rows: TaskRow[],
  gates: RuntimeState["taskGates"],
  task: Task,
  output: string,
  options: {
    crossProfile?: boolean;
    pendingFindings?: readonly PendingFindingFailure[];
    waitingFor?: RuntimeState["waitingFor"];
    /** The predecessors of findings, so a corrective never waits for a task it holds (#2094). */
    predecessors?: RuntimeState["repairPredecessors"];
    /** The narrowed holds of open correctives, as `readyTasks` reads them (#2109). */
    holds?: RepairHolds;
  } = {},
): FailureOwner {
  const files = failingFilesInOutput(output, graph?.tasks ?? []);
  const waitingFor = options.waitingFor ?? {};
  const matching =
    task.origin === "planned"
      ? sameFailureAsOpenFinding(output, options.pendingFindings ?? []).filter(
          (id) =>
            graph?.tasks.some(
              (t) =>
                t.id === id &&
                t.origin === "repair" &&
                !taskDependsOn(graph, id, task.id, waitingFor) &&
                affectedByRepair(graph, task, t, waitingFor, options.holds),
            ) &&
            rows.some(
              (r) =>
                r.id === id &&
                (["pending", "running", "invalidated", "interrupted"].includes(r.status) ||
                  (r.status === "implemented" && !hasTaskGate(r, gates))),
            ),
        )
      : [];
  if (matching.length) return { kind: "pending", owners: matching, files };
  const updaters = testUpdateOwners(graph, rows, gates, task, output);
  if (updaters.length) return { kind: "test-update", owners: updaters, files };
  const pending = task.origin === "planned" ? pendingOwners(graph, rows, gates, task, output) : [];
  if (pending.length) return { kind: "pending", owners: pending, files };
  const creators = pathCreators(graph, rows, gates, task, output);
  if (creators.length)
    return graph &&
      creators.some((id) =>
        waitsOnRepaired(graph, id, task, waitingFor, options.predecessors ?? {}),
      )
      ? { kind: "creates", owners: creators, files }
      : { kind: "pending", owners: creators, files };
  const done = new Set(
    rows.filter((r) => ["implemented", "verified"].includes(r.status)).map((r) => r.id),
  );
  // Assertion excerpts can include imports. Only diagnostic locations and stack frames
  // establish a production owner; an import printed beside a failing assertion does not.
  const frames = output
    .split(/\r?\n/)
    .filter(
      (line) =>
        /:\d+|:\[\d+,\d+\]|^\s*at\s|^\s*File ["'].*["'], line \d+/.test(line) &&
        !/declared here|declaration is here/.test(line),
    )
    .join("\n");
  const located = new Set([
    ...failingPathsInOutput(output, graph?.tasks ?? []),
    ...failingFilesInOutput(frames, graph?.tasks ?? []),
  ]);
  const owned = files.filter(
    (path) => located.has(path) && !isTestPath(path) && !task.writes.some((w) => w.path === path),
  );
  const owners = (graph?.tasks ?? []).filter(
    (t) =>
      t.id !== task.id &&
      t.origin === "planned" &&
      (options.crossProfile || t.profileId === task.profileId) &&
      done.has(t.id) &&
      t.writes.some((w) => w.action !== "delete" && owned.includes(w.path)),
  );
  const sources = owned.filter((path) => owners.some((t) => t.writes.some((w) => w.path === path)));
  if (sources.length) return { kind: "finished", owners: owners.map((t) => t.id), files: sources };
  return {
    kind: files.some((path) => task.writes.some((w) => w.path === path)) ? "self" : "unowned",
    owners: [],
    files,
  };
}

/** Advice returned with a failed request_check; evidence and write permissions stay unchanged. */
export function failureOwnerNote(owner: FailureOwner): string | undefined {
  if (owner.kind === "test-update")
    return `This failure belongs to ${owner.owners.join(", ")}, which has not finished updating the failing tests. Stop rerunning this check and submit your work; the host hands the failure to that task and checks the integrated result.`;
  if (owner.kind === "creates")
    return `This failure names paths that do not exist yet; ${owner.owners.join(", ")} creates them after this task. Submit your work; the host checks the integrated result when those tasks run.`;
  if (owner.kind === "pending")
    return `This failure waits for ${owner.owners.join(", ")}, which has not finished. Submit your work; the host reruns the check after those tasks finish.`;
  if (owner.kind === "finished")
    return `This failure names ${owner.files.join(", ")}, owned by ${owner.owners.join(", ")}, outside this task's writes. Keep the required tests and submit your work without unresolved items; the host routes a correction to those files. Do not rewrite tests to hide the failure.`;
  return undefined;
}

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
  if (!named.length || !named.every(isTestPath)) return [];
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
