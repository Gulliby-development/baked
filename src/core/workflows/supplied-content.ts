import {
  type CaseContext,
  criterionCases,
  missingCases,
  writtenTestPaths,
} from "../verification/criteria-cases.js";
import type { Analysis, Spec, TaskGraph } from "./schemas.js";
import { suppliedBlocks } from "./sizing.js";

/**
 * Criteria checked at analysis against file content the request supplies verbatim (#2006, part b
 * of #2000's fix). R64 mdtoc-update: the request gave tests/version.test.ts in full, AC-006 named a
 * literal that file lacks, and only the task-end case walk found it, after an implementer session
 * (237,581 tokens) and a second refusal (323,183 tokens). The host now runs the same case walk on
 * the supplied text at analysis, with no model call: a criterion literal that no supplied test file
 * of the task holds is a finding for the spec author, never a refusal for an implementer.
 *
 * A test file counts as supplied when the request gives exactly one fenced block for it
 * (`suppliedBlocks`, the reader pricing and the host apply decision use) and the task creates the
 * file or the prose before the block says it is the whole file. A task is checked only when every
 * test file it writes is supplied, and a case is raised only when no other task that carries the
 * criterion writes a test file of its own, since the walk lets a sibling's test hold a case.
 */
export const SUPPLIED_PREFIX = "SUPPLIED-";

export function isSuppliedContentFinding(finding: { id: string }): boolean {
  return finding.id.startsWith(SUPPLIED_PREFIX);
}

/** The test files each task writes whose whole content the request supplies, by task id. */
export function suppliedTestFiles(
  request: string,
  graph: Pick<TaskGraph, "tasks">,
): Map<string, { path: string; content: string }[]> {
  const paths = [...new Set(graph.tasks.flatMap((t) => writtenTestPaths(t)))];
  const blocks = suppliedBlocks(request, paths);
  const out = new Map<string, { path: string; content: string }[]>();
  for (const task of graph.tasks) {
    const tests = writtenTestPaths(task);
    const files = tests.flatMap((path) => {
      const supplied = blocks.get(path) ?? [];
      const [block] = supplied;
      const write = task.writes.find((w) => w.path === path);
      if (supplied.length !== 1 || block?.kind !== "file") return [];
      if (!block.whole && write?.action !== "create") return [];
      return [{ path, content: block.content }];
    });
    if (tests.length && files.length === tests.length) out.set(task.id, files);
  }
  return out;
}

/** One blocking finding per criterion whose literals a task's supplied test files do not hold. */
export function suppliedContentFindings(
  spec: Spec,
  graph: Pick<TaskGraph, "tasks">,
  request: string,
  context: Pick<CaseContext, "checks">,
): Analysis["findings"] {
  const supplied = suppliedTestFiles(request, graph);
  const missing = new Map<string, { task: string; paths: string[]; literals: string[] }[]>();
  for (const task of graph.tasks) {
    const files = supplied.get(task.id);
    if (!files) continue;
    const cases = criterionCases(spec, task, { checks: context.checks, tasks: graph.tasks });
    const open = missingCases(
      cases,
      files.map((f) => f.content),
    ).filter(
      // A sibling that carries the criterion and writes its own test file may test the case.
      (c) =>
        !graph.tasks.some(
          (other) =>
            other.id !== task.id &&
            other.criterionIds.includes(c.criterionId) &&
            writtenTestPaths(other).length > 0 &&
            !supplied.has(other.id),
        ),
    );
    for (const c of open) {
      const entries = missing.get(c.criterionId) ?? [];
      let entry = entries.find((e) => e.task === task.id);
      if (!entry) {
        entry = { task: task.id, paths: files.map((f) => f.path), literals: [] };
        entries.push(entry);
      }
      if (!entry.literals.includes(c.literal)) entry.literals.push(c.literal);
      missing.set(c.criterionId, entries);
    }
  }
  return [...missing].flatMap(([criterionId, entries]) => {
    const criterion = spec.criteria.find((c) => c.id === criterionId);
    if (!criterion) return [];
    const listed = entries
      .map(
        (e) =>
          `${e.literals.map((l) => JSON.stringify(l)).join(", ")} (task ${e.task} writes only ${e.paths.join(", ")})`,
      )
      .join("; ");
    return [
      {
        id: `${SUPPLIED_PREFIX}${criterionId}`,
        kind: "inconsistency" as const,
        refs: ["spec.json", criterionId],
        description:
          `Supplied content: ${criterionId} names ${listed}, but the request gives the content of those test files verbatim and it does not contain ${entries.length === 1 && entries[0]?.literals.length === 1 ? "that literal" : "those literals"}. The task-end case walk would refuse the implementer for it. The request outranks the criterion: rewrite ${criterionId} so the supplied content satisfies it (quote what the supplied file tests), or move the literal to a criterion a task with a test file of its own carries.`.slice(
            0,
            16000,
          ),
        blocking: true,
      },
    ];
  });
}
