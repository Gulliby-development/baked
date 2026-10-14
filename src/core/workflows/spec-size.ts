import type { Spec } from "./schemas.js";

/**
 * Spec size against the request (#1013). Every later stage receives the whole spec, so its size is
 * paid again at each stage at that stage's price. Bench round 18: the claude series wrote 41 to 48
 * criteria (47 to 54 KB) in 4 of 4 runs by turning each example of the brief into a criterion of
 * its own, while the codex runs of the same brief shape wrote 6 to 12; the 43-criterion spec also
 * carried a contradiction that cost a second plan and analysis. The spec author is told the size
 * the request calls for, and a spec far above it goes back once before the planner reads it.
 */

/** Criteria a request with few examples may always have. */
export const SPEC_CRITERIA_FLOOR = 12;
/** Criteria allowed per example or item the request lists. */
const CRITERIA_PER_EXAMPLE = 2;

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;
const FENCE = /^\s*(?:```|~~~)/;

/**
 * The examples and items a request lists: list items, table rows below a header and fenced code
 * blocks. Lines inside a code block do not count on their own.
 */
export function requestExamples(request: string): number {
  let count = 0;
  let fenced = false;
  let tableRows = 0;
  const closeTable = () => {
    // A table's first row is its header.
    count += Math.max(0, tableRows - 1);
    tableRows = 0;
  };
  for (const line of request.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      if (!fenced) count++;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (TABLE_ROW.test(line)) {
      if (!TABLE_SEPARATOR.test(line)) tableRows++;
      continue;
    }
    closeTable();
    if (LIST_ITEM.test(line)) count++;
  }
  closeTable();
  return count;
}

/** The most criteria a spec of the request should need. */
export function criteriaLimit(request: string): number {
  return Math.max(SPEC_CRITERIA_FLOOR, CRITERIA_PER_EXAMPLE * requestExamples(request));
}

const GROUPS =
  "Write one criterion per behavior group, not one per example: inputs that exercise the same behavior go into one criterion as a table inside its `then` (input | expected result), and a separate criterion is only for behavior that differs.";

/** What the spec author is told about the size of the spec. */
export function specSizeNote(request: string): string {
  const examples = requestExamples(request);
  return `${GROUPS} The request lists ${String(examples)} examples or items, so the spec needs at most about ${String(criteriaLimit(request))} criteria; every later stage reads the whole spec, so each extra criterion is paid again at every stage.`;
}

/** The size correction for a spec whose criteria exceed the request's limit, or none. */
export function specSizeProblems(spec: Spec, request: string): string[] {
  const limit = criteriaLimit(request);
  if (spec.criteria.length <= limit) return [];
  return [
    `The spec has ${String(spec.criteria.length)} criteria for a request that lists ${String(requestExamples(request))} examples or items (at most about ${String(limit)} expected). ${GROUPS} Merge the criteria of each behavior group, keep every requirement linked to a criterion, and submit the compact spec.`,
  ];
}
