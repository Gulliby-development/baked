import { existsSync } from "node:fs";
import { isTestFile as isLanguageTestFile } from "../intelligence/language-traits.js";
import { workspacePath } from "../specs/validate.js";
import type { AgentProfile, Spec, TaskGraph } from "./schemas.js";
import { fileKind, SLICE_PART, SPLIT_PART } from "./sizing.js";
import type { Task } from "./types.js";

/** Cross-artifact checks that analysis would otherwise spend model rounds on. */
export const PLAN_CONSISTENCY_CHECKS = [
  "every task, requirement and criterion ID named in the plan exists in the task graph or spec",
  "no task creates a file that already exists unless an earlier task deletes it",
  "tasks that write the same path are ordered by dependencies",
  "every read hint exists or is created by the task or an earlier task",
  "every task reference exists or is created by an earlier task",
  "a task that writes a module index (lib.rs, main.rs, mod.rs, __init__.py, index.ts) runs after the tasks that create the module files beside it",
  "a task with checks that creates a Rust module file also writes the lib.rs, main.rs, mod.rs or parent module file (src/parser.rs for src/parser/lexer.rs) that declares it, so its checks compile it",
  "code created after a task creates the entry point (main, cli, app, server, program) is wired in by a task that writes the entry point and runs after it",
  "a documentation task that runs the program to capture its output runs after the tasks that write the program's entry points",
  "each task has its own description, and no task's description tells it to create a file another task writes",
];

/** A file that declares or re-exports the modules next to it. */
const MODULE_INDEX = /(?:^|\/)(?:(?:lib|main|mod)\.rs|__init__\.py|index\.[cm]?[jt]sx?)$/;
/** The module files an index declares, by the index's language: a sibling file or a child directory's index. */
const SIBLINGS: Array<{ index: RegExp; file: RegExp; child: RegExp }> = [
  { index: /\.rs$/, file: /\.rs$/, child: /(?:^|\/)mod\.rs$/ },
  { index: /\.py$/, file: /\.py$/, child: /(?:^|\/)__init__\.py$/ },
  { index: /\.[cm]?[jt]sx?$/, file: /\.[cm]?[jt]sx?$/, child: /(?:^|\/)index\.[cm]?[jt]sx?$/ },
];
const dirOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

/**
 * A Rust module file other than a crate root or `mod.rs`: in the 2018 layout `src/parser.rs`
 * declares the modules in `src/parser/` (#1412).
 */
const isRustParentModule = (path: string): boolean =>
  path.endsWith(".rs") && !MODULE_INDEX.test(path);

/** Whether `file` is a module that the module index at `index` declares. */
function declaredBy(index: string, file: string): boolean {
  if (isRustParentModule(index)) {
    const dir = index.slice(0, -".rs".length);
    if (!file.endsWith(".rs") || !file.startsWith(`${dir}/`)) return false;
    const fileDir = dirOf(file);
    if (fileDir === dir) return !MODULE_INDEX.test(file);
    return /(?:^|\/)mod\.rs$/.test(file) && dirOf(fileDir) === dir;
  }
  const rule = SIBLINGS.find((r) => r.index.test(index));
  if (!rule || file === index || !rule.file.test(file)) return false;
  const dir = dirOf(index);
  const fileDir = dirOf(file);
  if (fileDir === dir) return !MODULE_INDEX.test(file);
  return rule.child.test(file) && dirOf(fileDir) === dir;
}

/**
 * A task that writes a module index (`lib.rs`, `mod.rs`, a parent module such as `src/parser.rs`,
 * `__init__.py`, `index.ts`) waits for the tasks that create the module files it declares.
 * Planners gave a crate's `lib.rs` and its `parse.rs` to parallel tasks; the index then named
 * modules that did not exist in its own worktree, and every check of it failed until a sibling
 * merged (bench round 08, commitbump). A dependency that would close a cycle is not added.
 */
export function withModuleDependencies(graph: TaskGraph): TaskGraph {
  const deps = new Map(graph.tasks.map((task) => [task.id, [...task.dependsOn]]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps.get(from) ?? []).some((id) => reaches(id, to, seen));
  };
  for (const task of graph.tasks) {
    const indexes = task.writes.filter(
      (w) => w.action !== "delete" && (MODULE_INDEX.test(w.path) || isRustParentModule(w.path)),
    );
    if (!indexes.length) continue;
    for (const other of graph.tasks) {
      if (other.id === task.id || reaches(task.id, other.id) || reaches(other.id, task.id))
        continue;
      const declares = other.writes.some(
        (w) => w.action === "create" && indexes.some((index) => declaredBy(index.path, w.path)),
      );
      if (declares) deps.get(task.id)?.push(other.id);
    }
  }
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const next = deps.get(task.id) ?? task.dependsOn;
      return next.length === task.dependsOn.length &&
        next.every((id, index) => id === task.dependsOn[index])
        ? task
        : { ...task, dependsOn: next };
    }),
  };
}

/** The files a task reads before it writes: its read hints and its reference. */
const readsOf = (task: Pick<Task, "readHints" | "reference">): string[] =>
  task.reference ? [...task.readHints, task.reference] : task.readHints;

/**
 * Each file a task with a reference writes, mapped to that reference, for the correctness review.
 * A file written by several tasks keeps the reference of the last one.
 */
export function fileReferences(graph: Pick<TaskGraph, "tasks">): Record<string, string> {
  const references: Record<string, string> = {};
  for (const task of graph.tasks)
    if (task.reference)
      for (const write of task.writes)
        if (write.action !== "delete" && write.path !== task.reference)
          references[write.path] = task.reference;
  return references;
}

/**
 * A task waits for the tasks that write a file it reads (`readHints` and `reference`). Planners left such tasks
 * without a dependency, so both ran in the same wave and the reader's checks failed on the file
 * its sibling had not written yet (zoneslot-update c941a83a: 208k of repair; contrastgrid 14%).
 * A file the task writes itself adds nothing, and a dependency that would close a cycle is not
 * added: of two tasks that read each other's files, the first in the plan waits.
 */
export function withReadDependencies(graph: TaskGraph): TaskGraph {
  const deps = new Map(graph.tasks.map((task) => [task.id, [...task.dependsOn]]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps.get(from) ?? []).some((id) => reaches(id, to, seen));
  };
  for (const task of graph.tasks) {
    const reads = readsOf(task).filter((path) => !task.writes.some((w) => w.path === path));
    if (!reads.length) continue;
    for (const other of graph.tasks) {
      if (other.id === task.id || reaches(task.id, other.id) || reaches(other.id, task.id))
        continue;
      if (other.writes.some((w) => w.action !== "delete" && reads.includes(w.path)))
        deps.get(task.id)?.push(other.id);
    }
  }
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const next = deps.get(task.id) ?? task.dependsOn;
      return next.length === task.dependsOn.length &&
        next.every((id, index) => id === task.dependsOn[index])
        ? task
        : { ...task, dependsOn: next };
    }),
  };
}

/**
 * A task names an implementation profile. A planner that wrote its own role or another unknown
 * profile on its tasks had the whole plan rejected and planned again (bench round 09, commitbump
 * dde8747e: `"profileId": "planner"` on all 7 tasks, 4 plan attempts); the host now gives such a
 * task the default implementer: `implementer` when it is an implementation profile, else the
 * first one. Without any implementation profile the graph is left for validation to reject.
 */
export function withImplementationProfiles(
  graph: TaskGraph,
  profiles: readonly Pick<AgentProfile, "id" | "output">[],
  /** The tasks stage's own profile (#832): it replaces the default `implementer`. */
  stageProfile?: string,
): TaskGraph {
  const implementers = profiles.filter((p) => p.output === "implementation").map((p) => p.id);
  const preferred = stageProfile && implementers.includes(stageProfile) ? stageProfile : undefined;
  const fallback =
    preferred ?? (implementers.includes("implementer") ? "implementer" : implementers[0]);
  const keeps = (id: string) => implementers.includes(id) && !(preferred && id === "implementer");
  if (!fallback || graph.tasks.every((task) => keeps(task.profileId))) return graph;
  return {
    ...graph,
    tasks: graph.tasks.map((task) =>
      keeps(task.profileId) ? task : { ...task, profileId: fallback },
    ),
  };
}

/**
 * The requirement ids of a task follow from the criteria it owns: every requirement its criteria
 * verify, plus the ones the planner listed that exist in the spec. The planner is no longer
 * rejected (and asked for a complete 30-60k token plan again) over a mapping the spec already
 * holds (bench round 7: keeplint, pkgdrift and mouse-mover plans). An id the spec lacks is dropped.
 */
export function withDerivedRequirements(spec: Spec, graph: TaskGraph): TaskGraph {
  const known = new Set(spec.requirements.map((r) => r.id));
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const derived = task.criterionIds.flatMap(
        (id) => spec.criteria.find((c) => c.id === id)?.requirementIds ?? [],
      );
      if (!derived.length) return task;
      const requirementIds = [
        ...new Set([...task.requirementIds.filter((id) => known.has(id)), ...derived]),
      ].filter((id) => known.has(id));
      return requirementIds.length === task.requirementIds.length &&
        requirementIds.every((id, index) => id === task.requirementIds[index])
        ? task
        : { ...task, requirementIds };
    }),
  };
}

function ancestorsOf(graph: TaskGraph, id: string): Set<string> {
  const ancestors = new Set<string>();
  const pending = [...(graph.tasks.find((t) => t.id === id)?.dependsOn ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (ancestors.has(next)) continue;
    ancestors.add(next);
    pending.push(...(graph.tasks.find((t) => t.id === next)?.dependsOn ?? []));
  }
  return ancestors;
}

/**
 * Rust module files that the task creating them does not declare. Cargo compiles only the files
 * reachable from `lib.rs` or `main.rs` through `mod` lines, so a module that a later task
 * registers is not built by the creating task's checks. idpeek a270ff5a (bench round 31) gave
 * every `pub mod` line to its last source task: per-task clippy never compiled six modules and
 * found 11 errors at once, a 1.15M-token corrective (#1299).
 */
export function undeclaredRustModules(workspace: string, graph: TaskGraph): string[] {
  const written = new Set(
    graph.tasks.flatMap((t) => t.writes.filter((w) => w.action !== "delete").map((w) => w.path)),
  );
  const present = (path: string): boolean =>
    written.has(path) || existsSync(workspacePath(workspace, path));
  const problems: string[] = [];
  for (const task of graph.tasks) {
    if (!task.checkIds.length) continue;
    for (const write of task.writes) {
      const file = write.path;
      if (write.action !== "create" || !file.endsWith(".rs") || isTestFile(file)) continue;
      if (MODULE_INDEX.test(file) && !/(?:^|\/)mod\.rs$/.test(file)) continue;
      const dir = dirOf(/(?:^|\/)mod\.rs$/.test(file) ? dirOf(file) : file);
      const indexes = [
        ...["lib.rs", "main.rs", "mod.rs"].map((name) => (dir ? `${dir}/${name}` : name)),
        ...(dir ? [`${dir}.rs`] : []),
      ].filter((index) => declaredBy(index, file) && present(index));
      if (!indexes.length || task.writes.some((w) => indexes.includes(w.path))) continue;
      problems.push(
        `${task.id} creates the Rust module ${file} but does not write ${indexes.join(" or ")}, which declares it, so ${task.id}'s checks (${task.checkIds.join(", ")}) never compile it and its errors surface only after the task that adds the mod line. Add ${indexes[0]} to ${task.id}'s writes and declare the module there; the host orders tasks that write the same index.`,
      );
    }
  }
  return problems;
}

/** A file a program starts from, which has to construct or register the components it runs. */
const ENTRY_POINT =
  /(?:^|\/)(?:main|cli|app|server|program)\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift)$/i;
const isTestFile = (path: string): boolean =>
  isLanguageTestFile(path) ||
  /[._-](?:test|spec)\.\w+$|(?:^|\/)test_[^/]+$/i.test(path) ||
  /[a-z]Tests?\.\w+$/.test(path);
const extensionOf = (path: string): string => path.slice(path.lastIndexOf(".")).toLowerCase();

/**
 * Entry points that code created after them never reaches. A task that creates the entry point
 * early (a CLI delegating to a handler interface) and later tasks that create the components,
 * with no task writing the entry point after them, leave the shipped command unable to run
 * them; the first review finds it (linehunk f0b66451: `Cli.run` delegated to a `CommandHandler`
 * that no task installed, about 470k tokens of review and correction).
 */
export function unwiredEntryPoints(graph: TaskGraph): string[] {
  const ancestors = new Map(graph.tasks.map((t) => [t.id, ancestorsOf(graph, t.id)]));
  const problems: string[] = [];
  for (const entry of graph.tasks)
    for (const write of entry.writes) {
      if (write.action !== "create" || !ENTRY_POINT.test(write.path) || isTestFile(write.path))
        continue;
      const extension = extensionOf(write.path);
      // A later write to any file the entry task created (the entry point, a registry it imports)
      // can wire the new code in.
      const seam = new Set(
        entry.writes
          .filter(
            (w) =>
              w.action === "create" && !isTestFile(w.path) && extensionOf(w.path) === extension,
          )
          .map((w) => w.path),
      );
      const writers = graph.tasks.filter(
        (t) => t.id !== entry.id && t.writes.some((w) => seam.has(w.path) && w.action !== "delete"),
      );
      const unwired = graph.tasks.filter(
        (task) =>
          ancestors.get(task.id)?.has(entry.id) &&
          task.writes.some(
            (w) =>
              w.action === "create" &&
              !seam.has(w.path) &&
              !isTestFile(w.path) &&
              extensionOf(w.path) === extension,
          ) &&
          !writers.some((w) => w.id === task.id || ancestors.get(w.id)?.has(task.id)),
      );
      if (unwired.length)
        problems.push(
          `${entry.id} creates the entry point ${write.path}, but ${unwired.map((t) => t.id).join(", ")} create code after it and no task that writes ${write.path} (or another file ${entry.id} creates) runs after them, so nothing wires that code into it. Add ${write.path} as a modify write to a task that depends on them, or let ${entry.id} depend on them.`,
        );
    }
  return problems;
}

/** A file the program's command starts from: an entry point, a Python `__main__.py`, or a script under `bin/`. */
const isCommandEntry = (path: string): boolean =>
  !isTestFile(path) &&
  (ENTRY_POINT.test(path) ||
    /(?:^|\/)__main__\.py$/.test(path) ||
    /(?:^|\/)bin\/[^/]+$/.test(path));
/** Task text that asks to run the program and show what it prints. */
const RUNS_PROGRAM =
  /\b(?:run|runs|running|execute|executing|invoke|invoking|capture|captured|capturing)\b[^.]*\b(?:command|cli|tool|program|binary|output)\b|\b(?:example|sample|captured|actual|real|worked)[- ](?:output|session|run|example)s?\b/i;

/** Prose files a documentation task writes beside its docs: a licence, a notice, the authors. */
const PROSE_FILE = /(?:^|\/)(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS)(?:[.-][\w.-]+)?$/i;
const isProse = (path: string): boolean => fileKind(path) === "docs" || PROSE_FILE.test(path);

/** Whether every file a task writes is documentation (a licence or notice beside it included). */
export function writesOnlyDocs(task: Pick<Task, "writes">): boolean {
  const files = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  return files.length > 0 && files.every(isProse);
}

/** Criterion or requirement text that asks the documentation to show what the program prints. */
const SHOWS_OUTPUT =
  /\b(?:example|sample|worked|expected|actual|real|captured)[- ](?:output|block|session|run|example|invocation)s?\b|\boutput\b[^.]*\b(?:copied|pasted|captured|shown|printed|reproduced)\b|\b(?:copied|pasted|captured|shown|printed|reproduced)\b[^.]*\boutput\b|```/i;

/** What a task asks for: its own text, its read hints, and the requirements and criteria it covers. */
function taskAsk(task: TaskGraph["tasks"][number], spec?: Pick<Spec, "requirements" | "criteria">) {
  const criteria = (spec?.criteria ?? [])
    .filter((c) => task.criterionIds.includes(c.id))
    .map((c) => `${c.given}. ${c.when}. ${c.then}`);
  const requirements = (spec?.requirements ?? [])
    .filter((r) => task.requirementIds.includes(r.id))
    .map((r) => r.text);
  return {
    own: `${task.title}\n${task.description}\n${task.readHints.join("\n")}`,
    covered: [...criteria, ...requirements].join("\n"),
  };
}

/**
 * A documentation task that runs the program to capture its output waits for the tasks that
 * write the program's entry points. Planners gave such a README no dependency, so it ran in the
 * first wave, found no command in its worktree and blocked the run, and the retry wrote the
 * output without running anything (bench round 12, cfgtrace 4018a791: 0.70M and one resume). The
 * ask is read from the task's text and read hints and from the criteria and requirements it
 * covers, and a licence beside the README keeps it a documentation task: "Write README and MIT
 * license" whose AC-009 asks for the reference example's output got no edge (round 16, cfgtrace
 * 49dbf63b and logclump 6d6d1350). Such a task is never a prerequisite of code or tests, so a
 * planner edge from a task that writes them to it is dropped first: cfgtrace 6474504a planned
 * `T001.dependsOn = ["T012"]` (the package after its README), the cycle guard then declined the
 * right edge, and the README ran first and stopped the run with 0 of 12 tasks done (#1012). A
 * task that reads a file the documentation task writes keeps its edge. A dependency that would
 * still close a cycle is not added.
 */
export function withCommandDependencies(
  graph: TaskGraph,
  spec?: Pick<Spec, "requirements" | "criteria">,
): TaskGraph {
  const deps = new Map(graph.tasks.map((task) => [task.id, [...task.dependsOn]]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps.get(from) ?? []).some((id) => reaches(id, to, seen));
  };
  const showsOutput = graph.tasks.filter((task) => {
    if (!writesOnlyDocs(task)) return false;
    const ask = taskAsk(task, spec);
    return (
      RUNS_PROGRAM.test(ask.own) || SHOWS_OUTPUT.test(ask.own) || SHOWS_OUTPUT.test(ask.covered)
    );
  });
  const docs = new Map(
    showsOutput.map((task) => [
      task.id,
      task.writes.filter((w) => w.action !== "delete").map((w) => w.path),
    ]),
  );
  // A task that reads what the documentation task writes keeps its edge: a README test reads
  // README.md and can only pass after it (statevet a93faa86 lost T012 -> T011, and the analyzer
  // raised the missing edge for five generations, #1054).
  for (const other of graph.tasks)
    if (!writesOnlyDocs(other) && other.writes.some((w) => w.action !== "delete")) {
      const reads = readsOf(other);
      deps.set(
        other.id,
        (deps.get(other.id) ?? []).filter((id) => {
          const written = docs.get(id);
          return !written || written.some((path) => reads.includes(path));
        }),
      );
    }
  for (const task of showsOutput) {
    for (const other of graph.tasks) {
      if (other.id === task.id || reaches(task.id, other.id) || reaches(other.id, task.id))
        continue;
      if (other.writes.some((w) => w.action !== "delete" && isCommandEntry(w.path)))
        deps.get(task.id)?.push(other.id);
    }
  }
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const next = deps.get(task.id) ?? task.dependsOn;
      return next.length === task.dependsOn.length &&
        next.every((id, index) => id === task.dependsOn[index])
        ? task
        : { ...task, dependsOn: next };
    }),
  };
}

export function planConsistencyProblems(
  workspace: string,
  spec: Spec,
  plan: string,
  graph: TaskGraph,
  /** True for an existing file that only this run (or the run it was forked from) created. */
  createdByRun: (path: string) => boolean = () => false,
  /** The run's policy lets independent tasks write the same path (integrated by an integrator). */
  overlappingWrites = false,
): string[] {
  const problems: string[] = [];
  const known = new Set([
    ...graph.tasks.map((t) => t.id),
    ...spec.requirements.map((r) => r.id),
    ...spec.criteria.map((c) => c.id),
  ]);
  const named = new Set(plan.match(/\b(?:T\d{3,6}|(?:FR|NFR|SC|AC)-\d{3,6})\b/g) ?? []);
  for (const id of named)
    if (!known.has(id))
      problems.push(
        `plan names ${id}, which is not in the ${id.startsWith("T") ? "task graph" : "spec"}`,
      );

  const ancestors = new Map(graph.tasks.map((t) => [t.id, ancestorsOf(graph, t.id)]));
  const exists = (path: string): boolean => existsSync(workspacePath(workspace, path));
  for (const task of graph.tasks) {
    const earlier = graph.tasks.filter((t) => ancestors.get(task.id)?.has(t.id));
    for (const write of task.writes) {
      if (
        write.action === "create" &&
        exists(write.path) &&
        !createdByRun(write.path) &&
        !earlier.some((t) => t.writes.some((w) => w.path === write.path && w.action === "delete"))
      )
        problems.push(`${task.id} creates ${write.path}, which already exists; use modify`);
      if (
        write.action === "modify" &&
        !exists(write.path) &&
        !earlier.some((t) => t.writes.some((w) => w.path === write.path && w.action === "create"))
      )
        problems.push(
          `${task.id} modifies ${write.path}, which does not exist and no earlier task creates it; depend on the task that creates it, or use create`,
        );
    }
    for (const hint of task.readHints) {
      if (
        !exists(hint) &&
        ![task, ...earlier].some((t) =>
          t.writes.some((w) => w.path === hint && w.action === "create"),
        )
      )
        problems.push(`${task.id} read hint ${hint} does not exist and no earlier task creates it`);
    }
    if (
      task.reference &&
      !exists(task.reference) &&
      !earlier.some((t) => t.writes.some((w) => w.path === task.reference && w.action === "create"))
    )
      problems.push(
        `${task.id} reference ${task.reference} does not exist and no earlier task creates it; name an existing file that shows the pattern, or leave reference out`,
      );
  }
  if (!overlappingWrites)
    for (const [index, task] of graph.tasks.entries())
      for (const other of graph.tasks.slice(index + 1)) {
        const shared = task.writes.find((w) => other.writes.some((o) => o.path === w.path));
        if (
          shared &&
          !ancestors.get(task.id)?.has(other.id) &&
          !ancestors.get(other.id)?.has(task.id)
        )
          problems.push(
            `${task.id} and ${other.id} both write ${shared.path} without a dependency between them`,
          );
      }
  problems.push(...unwiredEntryPoints(graph));
  problems.push(...undeclaredRustModules(workspace, graph));
  problems.push(...copiedTaskTexts(graph));
  return problems;
}

/** A file name a description tells its task to create: "Create DiffIgnoreStyleTests.cs ...". */
const CREATES_FILE =
  /\b(?:create|add|write)s?\s+(?:(?:a|an|the|new)\s+){0,2}`?([\w./-]*\w\.[A-Za-z][A-Za-z0-9]{0,5})\b`?/gi;
const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * Tasks whose description was copied from another task (#1377). vtsnap-update b436e161 (bench
 * round 37): T003, T004 and T005 had the same title and description, "Create
 * DiffIgnoreStyleTests.cs following CliTests layout ...", while T004 and T005 modify CliTests.cs
 * and DocsTests.cs, so two tasks worked from an instruction outside their write scope.
 */
export function copiedTaskTexts(graph: TaskGraph): string[] {
  const problems: string[] = [];
  const text = (description: string): string =>
    description.replace(/\s+/g, " ").trim().toLowerCase();
  const byText = new Map<string, string[]>();
  for (const task of graph.tasks) {
    const key = text(task.description);
    if (key.length < 20) continue;
    byText.set(key, [...(byText.get(key) ?? []), task.id]);
  }
  for (const ids of byText.values())
    if (ids.length > 1)
      problems.push(
        `${ids.join(", ")} have the same description; give each task the description of its own writes`,
      );
  for (const task of graph.tasks) {
    // A sizing split part keeps its task's description, which names the other parts' files.
    if (task.description.includes(SPLIT_PART) || task.description.includes(SLICE_PART)) continue;
    const own = new Set(task.writes.map((w) => baseName(w.path)));
    for (const match of task.description.matchAll(CREATES_FILE)) {
      const name = baseName(match[1] ?? "");
      if (!name || own.has(name)) continue;
      const writer = graph.tasks.find(
        (other) => other.id !== task.id && other.writes.some((w) => baseName(w.path) === name),
      );
      if (writer)
        problems.push(
          `${task.id}'s description says to create ${name}, which ${writer.id} writes and ${task.id} does not; describe the files ${task.id} writes`,
        );
    }
  }
  return problems;
}
