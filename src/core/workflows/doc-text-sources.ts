import type { Spec } from "./schemas.js";

/**
 * The text whose escaped string literals a run's changed documents must not copy (`docTextProblems`,
 * #2549): the run's own requirements and criteria, the stated request, and the spec documents of the
 * upstream features its worktree holds (`baseFiles` under `specs/`, #2046). A docs feature of an
 * initiative quotes its upstream features' literals, which its own spec never holds (#2921, R97
 * holefill: `\"DEFAULT\"` from the reports spec stayed in the README).
 */
export function docTextSources(
  spec: Pick<Spec, "requirements" | "criteria">,
  request: string,
  baseFiles: readonly { path: string; content: string }[],
): string {
  return [
    ...spec.requirements.map((r) => r.text),
    ...spec.criteria.flatMap((c) => [c.given, c.when, c.then]),
    request,
    ...baseFiles.filter((file) => file.path.startsWith("specs/")).map((file) => file.content),
  ].join("\n");
}
