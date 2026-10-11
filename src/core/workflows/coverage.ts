import type { TaskGraph } from "./schemas.js";
import { SOURCE_FILE as SOURCE, type WorkspaceKind } from "./workspace-facts.js";

/**
 * Request coverage on a new project. A request that describes a program with noun phrases
 * ("TypeScript CLI on Bun ... Tests and a README") produced a package that wrote only a README and
 * a LICENSE in 4 of 5 new apps, because the researcher found no code and read the absence as the
 * task. The host knows two facts the model inferred wrongly: whether the workspace has source
 * code (see workspace-facts.ts), and what the plan writes.
 */
/** Words that name a program, library or service as the thing to build. */
const DELIVERABLE =
  /\b(cli|command[- ]line|app|application|api|server|service|library|package|tool|script|program|module|website|bot|daemon|plugin|extension|endpoint|tests?)\b/i;

/** Whether the request describes something to build, as opposed to documentation only. */
export function describesProgram(prompt: string): boolean {
  return DELIVERABLE.test(prompt);
}

/** True when no task writes source or test code: only docs, licenses, manifests and configs. */
export function writesNoCode(graph: TaskGraph): boolean {
  const writes = graph.tasks.flatMap((task) => task.writes);
  return writes.length > 0 && writes.every((write) => !SOURCE.test(write.path));
}

export interface CoverageFinding {
  id: string;
  kind: "scope";
  refs: string[];
  description: string;
  blocking: true;
}

/**
 * A blocking scope finding when a request that describes a program leads, in a workspace without
 * source code, to a plan that writes no code. It refers to the spec, so the answer or the replan
 * goes back to the specify stage like any finding about the spec.
 */
export function coverageFinding(
  prompt: string,
  workspace: WorkspaceKind,
  graph: TaskGraph,
): CoverageFinding | null {
  if (workspace === "source" || !describesProgram(prompt) || !writesNoCode(graph)) return null;
  const paths = [...new Set(graph.tasks.flatMap((task) => task.writes.map((w) => w.path)))];
  return {
    id: "COVERAGE-1",
    kind: "scope",
    refs: ["spec.json", "tasks.json"],
    description: `The workspace has no source files and the request describes a program to build, but the tasks write only ${paths.join(", ")}. A program the request describes is the deliverable; it is not out of scope because it does not exist yet. Cover it in the spec (requirements and criteria for the program and its tests, nothing it describes in outOfScope) and plan the source and test files, unless the request asks for documentation only.`,
    blocking: true,
  };
}
