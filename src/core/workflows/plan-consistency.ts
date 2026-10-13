import { existsSync } from "node:fs";
import { workspacePath } from "../specs/validate.js";
import type { AgentProfile, Spec, TaskGraph } from "./schemas.js";

/** Cross-artifact checks that analysis would otherwise spend model rounds on. */
export const PLAN_CONSISTENCY_CHECKS = [
  "every task, requirement and criterion ID named in the plan exists in the task graph or spec",
  "no task creates a file that already exists unless an earlier task deletes it",
  "tasks that write the same path are ordered by dependencies",
  "every read hint exists or is created by the task or an earlier task",
  "a task that writes a module index (lib.rs, main.rs, mod.rs, __init__.py, index.ts) runs after the tasks that create the module files beside it",
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

/** Whether `file` is a module that the module index at `index` declares. */
function declaredBy(index: string, file: string): boolean {
  const rule = SIBLINGS.find((r) => r.index.test(index));
  if (!rule || file === index || !rule.file.test(file)) return false;
  const dir = dirOf(index);
  const fileDir = dirOf(file);
  if (fileDir === dir) return !MODULE_INDEX.test(file);
  return rule.child.test(file) && dirOf(fileDir) === dir;
}

/**
 * A task that writes a module index (`lib.rs`, `mod.rs`, `__init__.py`, `index.ts`) waits for the
 * tasks that create the module files it declares. Planners gave a crate's `lib.rs` and its
 * `parse.rs` to parallel tasks; the index then named modules that did not exist in its own
 * worktree, and every check of it failed until a sibling merged (bench round 08, commitbump). A
 * dependency that would close a cycle is not added.
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
    const indexes = task.writes.filter((w) => w.action !== "delete" && MODULE_INDEX.test(w.path));
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
      return next.length === task.dependsOn.length ? task : { ...task, dependsOn: next };
    }),
  };
}

/**
 * A task waits for the tasks that write a file it reads (`readHints`). Planners left such tasks
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
    const reads = task.readHints.filter((path) => !task.writes.some((w) => w.path === path));
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
      return next.length === task.dependsOn.length ? task : { ...task, dependsOn: next };
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
): TaskGraph {
  const implementers = profiles.filter((p) => p.output === "implementation").map((p) => p.id);
  const fallback = implementers.includes("implementer") ? "implementer" : implementers[0];
  if (!fallback || graph.tasks.every((task) => implementers.includes(task.profileId))) return graph;
  return {
    ...graph,
    tasks: graph.tasks.map((task) =>
      implementers.includes(task.profileId) ? task : { ...task, profileId: fallback },
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
  return problems;
}
