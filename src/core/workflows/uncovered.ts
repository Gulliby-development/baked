import type { Spec } from "./schemas.js";

/**
 * A criterion the planner cannot cover. R11 (url-shortener 6735ff55): the spec author added a
 * CI-matrix criterion the request never asked for; covering it needed `.github/workflows/ci.yml`,
 * which the approval limits forbid, and the planner cannot edit the spec. The plan was rejected
 * for "uncovered criterion AC-009" 11 times until a person removed it (#780).
 */
const UNCOVERED = /^uncovered criterion (AC-\d+)$/;

/** The criterion an `uncovered criterion` package problem names, or null for another problem. */
export function uncoveredCriterion(problem: string): string | null {
  return UNCOVERED.exec(problem.trim())?.[1] ?? null;
}

/** Submissions in one plan stage that may leave the same criterion uncovered before it stops. */
export const UNCOVERED_SUBMISSIONS = 2;

/** The plan lines that name a criterion: the planner's reason for leaving it uncovered. */
export function plannerNote(markdown: string, criterionId: string): string {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(criterionId));
  const note = lines.join(" ").replace(/\s+/g, " ");
  return note.length > 400 ? `${note.slice(0, 397)}...` : note;
}

function describe(spec: Spec, id: string, markdown: string): string {
  const criterion = spec.criteria.find((c) => c.id === id);
  const text = criterion
    ? ` (${criterion.requirementIds.join(", ")}: given ${criterion.given}, when ${criterion.when}, then ${criterion.then})`
    : "";
  const note = plannerNote(markdown, id);
  return `The planner cannot cover criterion ${id}${text}.${note ? ` Planner: ${note}` : ""}`;
}

/** Correction input for the spec author when the plan stage goes back to specify. */
export function uncoveredSpecNote(spec: Spec, ids: readonly string[], markdown: string): string {
  return `Plan stage: ${ids.map((id) => describe(spec, id, markdown)).join(" ")} The request is authoritative: remove each such criterion, and a requirement only it verifies, unless the request asks for it; when the request does ask for it, rewrite it so a task within the approved scope can verify it.`;
}

/** Blocking scope findings for a person when the criteria stay uncovered after a spec revision. */
export function uncoveredFindings(spec: Spec, ids: readonly string[], markdown: string) {
  return ids.map((id, index) => ({
    id: `PLAN-SCOPE-${String(index + 1)}`,
    kind: "scope" as const,
    refs: ["spec.json", id],
    description: `${describe(spec, id, markdown)} Remove it from the spec, or say how a task may verify it.`,
    blocking: true,
  }));
}
