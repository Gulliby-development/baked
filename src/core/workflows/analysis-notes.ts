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
  // An inconsistency is a concrete defect in the artifacts (two things that cannot both hold, often
  // with a reproduction), not an open decision: assuming it away only moves it to review, where it
  // returned as a repair loop (md-site: a path collision between two generated files).
  return finding.kind !== "scope" && finding.kind !== "inconsistency";
}

/** Whether a blocking finding is a defect the analysis must see fixed rather than assumed. */
export function persistentDefect(finding: { kind: string; blocking: boolean }): boolean {
  return finding.blocking && finding.kind === "inconsistency";
}

/** What the host tells the spec author when a defect survived the assumption reroute. */
export const DEFECT_NOTE =
  "These findings are concrete inconsistencies that already survived one correction. Do not assume them away and do not weaken the spec to hide them: change the artifacts so that both statements hold (rename, split or reorder), or state in the spec which side is wrong and remove it.";

/**
 * The assumptions the analysis recorded, as known risks for the agents that review the result: an
 * assumption nobody verified is where a defect that analysis could not settle is most likely to be.
 */
export function knownRisks(artifact: string | null): {
  note: string;
  assumed: { id: string; kind: string; refs: string[]; description: string }[];
} | null {
  if (!artifact) return null;
  try {
    const parsed = JSON.parse(artifact) as {
      assumed?: { id?: unknown; kind?: unknown; refs?: unknown; description?: unknown }[];
    };
    const assumed = (parsed.assumed ?? []).flatMap((item) =>
      typeof item.description === "string"
        ? [
            {
              id: String(item.id ?? ""),
              kind: String(item.kind ?? ""),
              refs: Array.isArray(item.refs) ? item.refs.map(String) : [],
              description: item.description.slice(0, 600),
            },
          ]
        : [],
    );
    return assumed.length
      ? {
          note: "The analysis could not settle these findings and recorded them as assumptions. Check the result against each of them first; a failure here is a finding, not an accepted risk.",
          assumed,
        }
      : null;
  } catch {
    return null;
  }
}
