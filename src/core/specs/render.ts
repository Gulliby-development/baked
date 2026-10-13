import type { Spec, TaskGraph } from "./schema.js";

export function renderSpec(spec: Spec): string {
  return [
    `# ${spec.title}`,
    "",
    `Feature: ${spec.featureId}; revision: ${spec.revision}`,
    "",
    "## Problem",
    spec.problem,
    "",
    "## Outcome",
    spec.outcome,
    "",
    "## Scope",
    ...spec.inScope.map((s) => `- ${s}`),
    "",
    "## Out of scope",
    ...spec.outOfScope.map((s) => `- ${s}`),
    "",
    ...(spec.assumptions.length
      ? ["## Assumptions", ...spec.assumptions.map((a) => `- ${a}`), ""]
      : []),
    "## Requirements",
    ...spec.requirements.map((r) => `- ${r.id} [${r.priority}; ${r.verification}] ${r.text}`),
    "",
    "## Acceptance criteria",
    ...spec.criteria.map(
      (c) =>
        `- ${c.id} (${c.requirementIds.join(", ")}; ${c.method}${c.property ? `; property over ${c.property}` : ""}): Given ${c.given}; when ${c.when}; then ${c.then}`,
    ),
    "",
    "## Open questions",
    ...spec.openQuestions.map((q) => `- ${q.id}${q.blocking ? " [blocking]" : ""}: ${q.question}`),
    "",
  ].join("\n");
}
export function renderTasks(graph: TaskGraph): string {
  return [
    `# Tasks for ${graph.featureId}`,
    "",
    ...graph.tasks.flatMap((t) => [
      `## ${t.id}: ${t.title}`,
      t.description,
      `Requirements: ${t.requirementIds.join(", ")}`,
      `Criteria: ${t.criterionIds.join(", ")}`,
      `Depends on: ${t.dependsOn.join(", ") || "none"}`,
      `Profile: ${t.profileId}`,
      ...t.writes.map((w) => `- ${w.action}: ${w.path}`),
      `Checks: ${t.checkIds.join(", ")}`,
      `Rationale: ${t.rationale}`,
      "",
    ]),
  ].join("\n");
}
