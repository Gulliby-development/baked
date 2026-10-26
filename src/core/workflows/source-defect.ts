import { normalizeLiteral } from "../verification/criteria-cases.js";

/**
 * A planned test task's failing check whose expected values are the literals of its own criteria
 * is a source defect of the finished sibling that wrote the code under test (#2220). namesound
 * soundex T003 (bench round 70): three rspec examples expected `"B1905"`, the criterion's value,
 * and `RefinedSoundex.key` of the finished T002 returned another string. A wrong-value assertion
 * names only the spec file and its line, so `failureOwner` kept the failure with the test task:
 * two sessions (545k tokens, 11 minutes) that changed nothing before the corrective that may write
 * the source opened and fixed it.
 *
 * `sourceDefectInput` reads the expected side of every assertion in the output (rspec, bun and
 * Jest, Minitest, testify, xUnit, JUnit, Dart, ExUnit, Rust `right:`, Go `want`, pytest
 * `assert a == b`, XCTest, PHPUnit, alcotest) and compares each with the case walk's literals of
 * the task's criteria. When every expected value is one of them, and the finished planned tasks
 * that carry those criteria wrote the sources the failing tests import, `sourceDefectDecision`
 * routes the failure to those tasks as the frame-located `finished` owner of #1564 does: no
 * continuation of the test task, and its corrective writes the tests and those sources at the
 * first failing check. A test whose expected value is not a criterion's literal keeps the current
 * path: the test may be what is wrong.
 *
 * Each decision records `source-defect/tasks/<task>-<signature>.json` (kind `source-defect`,
 * kept in bench traces: counts, task ids and paths, never literals). With the policy field
 * `sourceDefectRoute` absent the decision is shadow (recorded, the owner stays the test task);
 * `replaySourceDefects` (`trace.ts`) decides each record again.
 */
export const SOURCE_DEFECT_KIND = "source-defect";
export const SOURCE_DEFECT_DIR = "source-defect/tasks/";

export interface SourceDefectInput {
  /** The task is planned and writes only tests. */
  testTask: boolean;
  /** The ordinary owner located the failure in the task's own files only (`self`). */
  self: boolean;
  /** The expected values the failing output states. */
  expected: number;
  /** Those of them that equal a literal of the task's criteria. */
  matched: number;
  /** Finished planned tasks carrying the matched criteria that wrote a source the tests import. */
  owners: string[];
  /** Those sources. */
  files: string[];
}

/** What `source-defect/tasks/<task>-<signature>.json` records. */
export interface SourceDefectRecord extends SourceDefectInput {
  schemaVersion: 1;
  taskId: string;
  /** `shadow`: recorded only, the owner stays the test task; `on`: the failure routes. */
  mode: "shadow" | "on";
  /** The criteria whose literals the expected values matched. */
  criterionIds: string[];
  route: boolean;
}

export type SourceDefectRule = (input: SourceDefectInput) => boolean;

/** The one rule: every expected value is a criterion's literal, and a finished sibling wrote the code. */
export const sourceDefectDecision: SourceDefectRule = (input) =>
  input.testTask &&
  input.self &&
  input.expected > 0 &&
  input.matched === input.expected &&
  input.owners.length > 0 &&
  input.files.length > 0;

export const sourceDefectPath = (taskId: string, signature: string): string =>
  `${SOURCE_DEFECT_DIR}${taskId}-${signature}.json`;

/** Words only (`objects to be the same.`, `this output:`): a framework's prose, not a value. */
const PROSE = /^[a-z]+(?:\s+[a-z]+)+\s*[.:]?$/i;

/**
 * The expected side of one assertion line, by the conventions of the supported test frameworks,
 * or "" for a line whose value follows on the next line (`Expected:` alone).
 */
const EXPECTED: readonly RegExp[] = [
  // rspec, bun and Jest, Minitest, testify, xUnit, Dart, alcotest (`Expected: x`), JUnit
  // (`expected: <x> but was: <y>`), Zig (`expected x, found y`), Go (`expected x, got y`).
  /\bexpected(?:\s*:\s*|\s+)(.*?)(?:\s*,?\s+(?:but\s+(?:was|got)|found|got|actual|received)\b.*)?$/i,
  // Go: `got "x", want "y"`, `want: y`.
  /\bwant(?:ed)?(?:\s*:\s*|\s+)(.+?)$/i,
  // Rust `assert_eq!(actual, expected)` and ExUnit `assert actual == expected`: `right: y`.
  /^\s*right\s*:\s*(.+)$/i,
  // pytest: `assert 'x' == 'y'`.
  /\bassert\s+.+?\s*==\s*(.+)$/,
  // XCTest: `("x") is not equal to ("y")`.
  /\bis not equal to\s*(.+?)(?:\s*-\s.*)?$/i,
  // PHPUnit: `Failed asserting that 'x' matches expected 'y'.`
  /\bmatches expected\s+(.+)$/i,
];

/** A value as the test spells it: without quotes, brackets, a type tag or a trailing period. */
function bare(value: string): string {
  let text = value
    .trim()
    .replace(/^\((?:string|number|integer|boolean)\)\s*/i, "")
    .replace(/[.,;]$/, "")
    .trim();
  for (;;) {
    const pair =
      /^(?:"(.*)"|'(.*)'|`(.*)`|<(.*)>|\((.*)\)|\[(.*)\]|`"(.*)"'|b'(.*)'|b"(.*)")$/s.exec(text);
    const inner = pair?.slice(1).find((part) => part !== undefined);
    if (inner === undefined || inner === text) return text;
    text = inner.trim();
  }
}

/** The expected values of the assertions a failing check's output prints, as the tests spell them. */
export function expectedValues(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const values: string[] = [];
  let diff = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    // PHPUnit's diff: `--- Expected` / `+++ Actual`, then `-'x'` / `+'y'`.
    if (/^\s*---\s*Expected\b/i.test(line)) {
      diff = true;
      continue;
    }
    if (diff) {
      const removed = /^\s*-(?!--)(.+)$/.exec(line)?.[1];
      if (removed) values.push(bare(removed));
      if (!line.trim()) diff = false;
      continue;
    }
    for (const pattern of EXPECTED) {
      const found = pattern.exec(line);
      if (!found) continue;
      let value = (found[1] ?? "").trim();
      if (!value) value = (lines.slice(index + 1).find((next) => next.trim()) ?? "").trim();
      if (value && !PROSE.test(value)) values.push(bare(value));
      break;
    }
  }
  return [...new Set(values.filter(Boolean))];
}

/**
 * Which expected values of the output are literals of the given criterion cases, and the criteria
 * they came from. Both sides are compared as the tests spell them, escapes decoded.
 */
export function criterionExpected(
  output: string,
  cases: readonly { criterionId: string; literal: string }[],
): { expected: number; matched: number; criterionIds: string[] } {
  const values = expectedValues(output);
  const criteria = new Set<string>();
  let matched = 0;
  for (const value of values) {
    const spelled = normalizeLiteral(value);
    const hits = cases.filter(
      (c) =>
        normalizeLiteral(c.literal) === spelled || normalizeLiteral(bare(c.literal)) === spelled,
    );
    if (!hits.length) continue;
    matched++;
    for (const hit of hits) criteria.add(hit.criterionId);
  }
  return { expected: values.length, matched, criterionIds: [...criteria].sort() };
}
