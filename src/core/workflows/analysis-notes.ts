import type { z } from "zod";
import type { ResearchSchema, TaskGraph } from "./schemas.js";

type Research = z.infer<typeof ResearchSchema>;

/**
 * Helpers for the analysis and clarification loop. Runs of bench round 02 spent about 30 of 48
 * operator actions on it: findings that only counted tasks or files, answers that left the
 * research the analyzer reads unchanged, and non-blocking findings that failed the stage.
 */

/** Counts the host computes from the task graph; models are told not to compare them. */
export function hostCounts(graph: TaskGraph): { tasks: number; files: number } {
  return {
    tasks: graph.tasks.length,
    files: new Set(graph.tasks.flatMap((task) => task.writes.map((write) => write.path))).size,
  };
}

const COUNT = /\b\d+\s+(?:distinct\s+|unique\s+|code\s+)?(?:tasks?|files?)\b/gi;
const COUNT_CONTEXT =
  /\b(says|states|claims|lists|shows|counts|reports|declares|mentions|has|have|contains|totals?)\b/i;

/**
 * A finding whose substance is a task or file count mismatch ("plan says 8 tasks, graph has 9").
 * The host knows both numbers, so such a finding is a note: at least two counts and no other
 * defect named (no requirement, criterion or task ID that is not part of the count).
 */
export function isCountNit(description: string): boolean {
  const counts = description.match(COUNT) ?? [];
  if (counts.length < 2 || !COUNT_CONTEXT.test(description)) return false;
  const numbers = new Set(counts.map((count) => count.match(/\d+/)?.[0]));
  if (numbers.size < 2) return false;
  const rest = description.replace(COUNT, " ");
  return !/\b(FR|NFR|AC|SC)-\d+/.test(rest) && !/\bT\d{3,}\b/.test(rest);
}

/**
 * Marks research statements as superseded by an answer to an analysis clarification, so the
 * analyzer stops reading the fact the answer contradicts. The statement names the finding the
 * person answered and the answer; the research text it contradicts is left in place, flagged as
 * stale by the new fact at the top.
 */
export function supersedeResearch(
  research: Research,
  findings: readonly { id?: unknown; description?: unknown }[],
  answers: Readonly<Record<string, string>>,
): Research {
  const facts = Object.entries(answers).map(([key, answer]) => {
    const finding = findings.find((f) => f.id === key);
    const about =
      finding && typeof finding.description === "string"
        ? ` to "${finding.description.slice(0, 300)}"`
        : "";
    return {
      statement: `Superseded by the user's answer${about} (${key}): ${answer.slice(0, 1000)}. Any earlier research statement that contradicts this answer is stale; do not raise it again.`,
      paths: [],
    };
  });
  return { ...research, facts: [...facts, ...research.facts] };
}

/** Whether a blocking finding may be settled by a recorded assumption instead of a person. */
export function assumable(finding: { kind: string; blocking: boolean }): boolean {
  // A scope finding says the spec drops what the request asked for; only the person decides that.
  return finding.kind !== "scope";
}
