import { hashJson } from "../specs/hash.js";
import type { RunPolicy, Spec, TaskGraph } from "./schemas.js";
import { isTestPath } from "./test-integrity.js";
import type { Task } from "./types.js";

/**
 * Tests first (#632). Failing tests written before the code are the best-evidenced correctness
 * filter (Otter, Agentless, AlphaCodium), and tests that implementers write share their wrong
 * assumptions. With `testsFirst` on, the plan has a test task for each criterion, the test tasks
 * run before any code task, the host requires each new test to fail for the right reason, a
 * person approves the tests, and the code is implemented until they pass. The approved test files
 * are read-only for code tasks.
 */

export type TestsFirstMode = "off" | "criteria" | "all";
export const testsFirstOf = (policy: Pick<RunPolicy, "testsFirst">): TestsFirstMode =>
  policy.testsFirst ?? "off";

/** A task that writes only test files. */
export function isTestTask(task: Pick<Task, "writes">): boolean {
  const written = task.writes.filter((w) => w.action !== "delete");
  return written.length > 0 && written.every((w) => isTestPath(w.path));
}

/** The criteria that need a test written first under the mode. */
export function testsFirstCriteria(spec: Pick<Spec, "criteria">, mode: TestsFirstMode): string[] {
  if (mode === "off") return [];
  return spec.criteria
    .filter((c) => (mode === "all" ? c.method !== "post-release" : c.method === "automated"))
    .map((c) => c.id);
}

/** What the planner is told when tests come first. */
export function testsFirstNote(mode: TestsFirstMode, criteria: string[]): string {
  return `Tests come first (${mode}). Plan a task that writes only test files for each of these criteria: ${criteria.join(", ")}; a test task may cover several criteria. Each test task names a task-scope check that runs its tests (for example the test command), depends on no code task, and writes tests that fail now because the behavior is missing, not because the test is broken. Code tasks list the criteria they implement; the host makes them wait for the test tasks of their criteria and for a person to approve the tests, and code tasks may not change those test files.`;
}

/** Submission errors for a plan under tests first; returned to the planner. */
export function testsFirstProblems(
  spec: Pick<Spec, "criteria">,
  graph: Pick<TaskGraph, "tasks">,
  policy: Pick<RunPolicy, "testsFirst" | "checks">,
): string[] {
  const mode = testsFirstOf(policy);
  if (mode === "off") return [];
  const tests = graph.tasks.filter(isTestTask);
  const problems = testsFirstCriteria(spec, mode)
    .filter((id) => !tests.some((t) => t.criterionIds.includes(id)))
    .map(
      (id) =>
        `Criterion ${id} has no test task: tests come first, so plan a task that writes only test files for it.`,
    );
  const taskChecks = new Set(policy.checks.filter((c) => c.scope === "task").map((c) => c.id));
  for (const task of tests)
    if (!task.checkIds.some((id) => taskChecks.has(id)))
      problems.push(
        `Test task ${task.id} names no task-scope check, so the host cannot see its tests fail before the code exists. Add the check that runs its tests (one of: ${[...taskChecks].join(", ") || "none configured"}).`,
      );
  return problems;
}

/**
 * The task order under tests first: a test task depends on no code task (dependencies on code
 * that another rule or the planner added are dropped), and a code task waits for the test tasks
 * that share one of its criteria. No cycle can form: every new edge goes from code to tests.
 */
export function withTestsFirstOrder(graph: TaskGraph): TaskGraph {
  const tests = new Set(graph.tasks.filter(isTestTask).map((t) => t.id));
  const tasks = graph.tasks.map((task) => {
    if (tests.has(task.id))
      return { ...task, dependsOn: task.dependsOn.filter((id) => tests.has(id)) };
    const added = graph.tasks
      .filter(
        (test) =>
          tests.has(test.id) &&
          !task.dependsOn.includes(test.id) &&
          test.criterionIds.some((id) => task.criterionIds.includes(id)),
      )
      .map((test) => test.id);
    return added.length ? { ...task, dependsOn: [...task.dependsOn, ...added] } : task;
  });
  return { ...graph, tasks };
}

export interface CheckedRun {
  checkId: string;
  status: "passed" | "failed" | "inconclusive";
  output?: string;
}

const BROKEN =
  /\b(SyntaxError|ParseError|IndentationError|TabError|syntax error|unexpected token|error TS1\d{3}|expected one of|unterminated)\b/i;
const basename = (path: string): string => path.split("/").at(-1) ?? path;

/**
 * Whether a tests-first task's checks show its tests failing for the right reason on the code as
 * it is: at least one check fails, a failing output names one of the task's test files, and no
 * failing output shows that a test file itself does not parse. Null when red; otherwise why not.
 */
export function redProblem(
  task: Pick<Task, "writes" | "id">,
  results: CheckedRun[],
): string | null {
  if (!results.length) return `Test task ${task.id} has no task check, so its tests never ran.`;
  const failed = results.filter((r) => r.status === "failed");
  if (!failed.length)
    return results.some((r) => r.status === "inconclusive")
      ? `The checks of test task ${task.id} were inconclusive; the tests must fail clearly before the code exists.`
      : `The tests of task ${task.id} already pass before the change: they do not test the missing behavior. Write tests that fail until the criteria are implemented.`;
  const files = task.writes.filter((w) => w.action !== "delete").map((w) => w.path);
  const names = files.map(basename);
  const mentions = (output: string) => names.some((name) => output.includes(name));
  if (!failed.some((r) => r.output && mentions(r.output)))
    return `The checks of test task ${task.id} fail, but their output names none of its test files (${files.join(", ")}): the failure is not these tests. Make sure the task check runs them.`;
  const broken = failed.find((r) => r.output && BROKEN.test(r.output) && mentions(r.output));
  if (broken)
    return `A test file of task ${task.id} does not load (check ${broken.checkId} reports a syntax error): the tests must fail on their assertions or on the missing code, not on a broken test.`;
  return null;
}

/** The digest a person approves: the test files and their content. */
export function testsDigest(tests: { path: string; content: string }[]): string {
  return hashJson(tests.map((t) => ({ path: t.path, hash: hashJson(t.content) })));
}
