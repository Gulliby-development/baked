/**
 * The `harden` preset (#641): strengthen the tests of existing code without changing it. Tasks
 * write only test files (and a manifest, for a test library); the code files the plan names in
 * its read hints are the module under test. The mutation gate plants its mutants in that module
 * instead of in added lines, once at approval for the score before and in every checks stage
 * after, and is `required` by the preset, so each surviving mutant becomes a test to write.
 */
import { isCodePath } from "../check-policy.js";
import { isTestCodePath } from "./duplication.js";
import { isManifestPath } from "./manifests.js";

export const HARDEN_PRESET = "harden";
/** The mutation result of the module's tests as they were at approval. */
export const QUALITY_MUTATION_BASELINE = "quality/mutation-baseline.json";

interface PlannedTask {
  id: string;
  writes: { path: string; action: string }[];
  readHints: string[];
}

/** What a harden plan may not do: write or delete anything but test files and manifests. */
export function hardenPlanProblems(tasks: PlannedTask[]): string[] {
  const problems: string[] = [];
  for (const task of tasks)
    for (const write of task.writes) {
      if (write.action === "delete")
        problems.push(`A harden run deletes nothing: ${task.id} deletes ${write.path}`);
      else if (!isTestCodePath(write.path) && !isManifestPath(write.path))
        problems.push(
          `A harden run writes only test files and manifests: ${task.id} writes ${write.path}`,
        );
    }
  if (!hardenTargets(tasks).length)
    problems.push(
      "Name the code files of the module under test in the tasks' readHints; the host plants its mutants there",
    );
  return problems;
}

/** The module under test: the non-test code files the tasks read. */
export function hardenTargets(tasks: Pick<PlannedTask, "readHints">[]): string[] {
  return [
    ...new Set(
      tasks.flatMap((t) => t.readHints).filter((path) => isCodePath(path) && !isTestCodePath(path)),
    ),
  ].sort();
}

/** What the agents of a harden run are told, by the stage they run. */
export function hardenNote(output: string): string | null {
  if (output === "spec")
    return "This run hardens the tests of existing code and changes no production file. Write the requirements and criteria as the behavior the code has now (read it), so tests can pin it down; mark criteria that hold over an input domain with property.";
  if (output === "plan")
    return "This run hardens the tests of existing code. Every task writes only test files (and a package manifest to add a test library such as a property-testing one); no task creates, modifies or deletes production code. Name the module's code files in each task's readHints: the host plants mutants there before and after the tasks and blocks until the tests kill them.";
  if (output === "implementation")
    return "This run hardens the tests of existing code: write and edit only test files, never production code. Assert what the code does now, including edge cases and error paths, so that a change to a condition, boundary or constant fails a test. If the code looks wrong, do not change it: test its current behavior and name the suspected bug in summary.";
  return null;
}
