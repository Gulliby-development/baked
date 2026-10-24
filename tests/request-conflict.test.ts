import { describe, expect, test } from "bun:test";
import {
  checkedSides,
  conflictCriteria,
  reauditVerdicts,
  requestConflictDecision,
  sidesSettle,
} from "../src/core/workflows/request-conflict.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// #2016: a conflict between a criterion and the request is decided on quotes the host checks, not
// on the report's wording.

const EXAMPLE = 't.txt:3:11: UT104 variable "id" appears again (first at column 7)';
const WRONG = 't.txt:1:6: UT104 variable "a" appears again (first at column 2)';
const REQUEST = `COLUMN is the 1-based code-point position of the variable name. For \`/x y/{id}{id}\` it prints \`${EXAMPLE}\`.`;
const spec: Pick<Spec, "criteria" | "requirements"> = {
  requirements: [{ id: "FR-005", text: "A problem names the 1-based code-point column", priority: "must", verification: "automated", sourceRefs: ["request"] }],
  criteria: [
    { id: "AC-005", requirementIds: ["FR-005"], given: "the template `{a}{a}`", when: "check runs", then: `it prints \`${WRONG}\``, method: "automated" },
    { id: "AC-009", requirementIds: ["FR-005"], given: "a person", when: "they read the help", then: "it is clear", method: "manual" },
  ],
};
const input = (over: Partial<Parameters<typeof requestConflictDecision>[0]> = {}) => ({
  sides: [],
  foreignTests: 0,
  criterionIds: [],
  reaudit: null,
  reauditedBefore: false,
  ...over,
});

describe("checkedSides", () => {
  test("checks each reported quote against its criterion, requirement or the request", () => {
    expect(
      checkedSides(spec, REQUEST, "", [
        { kind: "criterion", ref: "AC-005", quote: WRONG },
        { kind: "criterion", ref: "AC-005", quote: "t.txt:1:5" },
        { kind: "requirement", ref: "FR-005", quote: "1-based code-point column" },
        { kind: "request", quote: EXAMPLE },
        { kind: "request", quote: "column 5" },
        { kind: "test", ref: "tests/test_cli.py", quote: "assert col == 5" },
      ]).map((s) => [s.kind, s.verified]),
    ).toEqual([
      ["criterion", true],
      ["criterion", false],
      ["requirement", true],
      ["request", true],
      // Too short to show a side of its own.
      ["request", false],
      ["test", true],
    ]);
  });

  test("a request quote the criterion also holds is not a side against it", () => {
    const sides = checkedSides(spec, `${REQUEST} The template {a}{a} is an example.`, "", [
      { kind: "criterion", ref: "AC-005", quote: WRONG },
      { kind: "request", quote: "the template `{a}{a}`" },
    ]);
    expect(sides.map((s) => s.verified)).toEqual([true, false]);
    expect(sidesSettle(sides)).toBe(false);
  });

  test("without reported sides, reads the cited criteria and the quoted spans the request holds", () => {
    const whatever = `AC-005 conflicts with what the detailed contract shows: \`${EXAMPLE}\`, and "column five or six".`;
    const sides = checkedSides(spec, REQUEST, whatever, undefined);
    expect(sides).toEqual([
      { kind: "criterion", ref: "AC-005", verified: true, source: "report" },
      { kind: "request", ref: null, verified: true, source: "report" },
    ]);
    expect(sidesSettle(sides)).toBe(true);
    // The same report without the quote names no request side, whatever its words.
    expect(sidesSettle(checkedSides(spec, REQUEST, "AC-005 contradicts the request, which defines name columns.", undefined))).toBe(false);
  });
});

describe("requestConflictDecision", () => {
  const settling = checkedSides(spec, REQUEST, "", [
    { kind: "criterion", ref: "AC-005", quote: WRONG },
    { kind: "request", quote: EXAMPLE },
  ]);
  test("the request wins on verified sides, unless a test the run did not write is involved", () => {
    expect(requestConflictDecision(input({ sides: settling }))).toBe("request");
    expect(requestConflictDecision(input({ sides: settling, foreignTests: 1 }))).toBe("none");
  });
  test("a cited criterion without a verified request side asks the re-audit once", () => {
    expect(requestConflictDecision(input({ criterionIds: ["AC-005"] }))).toBe("reaudit");
    expect(requestConflictDecision(input({ criterionIds: ["AC-005"], reauditedBefore: true }))).toBe("none");
    expect(requestConflictDecision(input())).toBe("none");
  });
  test("the re-audit settles only with a mismatch whose quote the request holds", () => {
    const verdict = (quoteVerified: boolean) => [{ criterionId: "AC-005", matches: !quoteVerified, quoteVerified }];
    expect(requestConflictDecision(input({ criterionIds: ["AC-005"], reaudit: verdict(true) }))).toBe("request");
    expect(requestConflictDecision(input({ criterionIds: ["AC-005"], reaudit: verdict(false) }))).toBe("none");
  });
});

describe("reauditVerdicts", () => {
  test("checks each mismatch's quote against the request", () => {
    const row = { criterionId: "AC-005", row: WRONG, recomputed: "column 5", derivation: "name columns" };
    expect(reauditVerdicts([{ ...row, matches: false, quote: EXAMPLE }], ["AC-005"], REQUEST)).toEqual([{ criterionId: "AC-005", matches: false, quoteVerified: true }]);
    expect(reauditVerdicts([{ ...row, matches: false, quote: "column 5 for {a}{a}" }], ["AC-005"], REQUEST)).toEqual([{ criterionId: "AC-005", matches: true, quoteVerified: false }]);
    expect(reauditVerdicts([{ ...row, matches: false }], ["AC-005"], REQUEST)[0]?.quoteVerified).toBe(false);
    expect(reauditVerdicts([], ["AC-005"], REQUEST)).toEqual([{ criterionId: "AC-005", matches: true, quoteVerified: false }]);
  });
});

test("conflictCriteria takes automated criteria the report or its sides name", () => {
  expect(conflictCriteria(spec, "AC-009 and AC-005 disagree", undefined).map((c) => c.id)).toEqual(["AC-005"]);
  expect(conflictCriteria(spec, "the column is wrong", [{ kind: "criterion", ref: "AC-005", quote: WRONG }]).map((c) => c.id)).toEqual(["AC-005"]);
});
