import { describe, expect, test } from "bun:test";
import { addReviewNotes, noteReason } from "../src/core/verification/review-notes.js";
import type { Review } from "../src/core/workflows/schemas.js";
import type { ReviewNote } from "../src/core/workflows/types.js";

const finding = (fields: Partial<Review["findings"][number]>): Review["findings"][number] => ({
  id: "LANG-001",
  kind: "maintainability",
  severity: "low",
  basis: "inferred",
  requirementIds: [],
  criterionIds: ["AC-001"],
  file: "src/main.rs",
  symbol: null,
  evidenceIds: ["E1"],
  claim: "Every writeln! result is discarded with let _",
  impact: "A failed write goes unnoticed",
  suggestedFix: "Propagate the error",
  ...fields,
});

describe("review notes", () => {
  // commitbump dde8747e: LANG-001 came back as L001 in the next round with repeatOf null (#715).
  test("a note re-raised in a later snapshot under another id and wording repeats the earlier one", () => {
    const notes: ReviewNote[] = [];
    addReviewNotes(notes, "language", "S1", [{ finding: finding({}), reason: "inferred" }]);
    addReviewNotes(notes, "language", "S2", [
      { finding: finding({ id: "L001", claim: "writeln! errors are ignored" }), reason: "inferred" },
      { finding: finding({ id: "L002", file: "src/lib.rs" }), reason: "inferred" },
    ]);
    expect(notes.map((n) => [n.findingId, n.repeatOf])).toEqual([
      ["LANG-001", null],
      ["L001", "LANG-001"],
      ["L002", null],
    ]);
  });

  test("a resumed stage does not add the same note twice, and notes of one snapshot do not repeat each other", () => {
    const notes: ReviewNote[] = [];
    const first = [{ finding: finding({}), reason: "inferred" as const }];
    addReviewNotes(notes, "language", "S1", first);
    addReviewNotes(notes, "language", "S1", first);
    addReviewNotes(notes, "correctness", "S1", [{ finding: finding({ id: "F1" }), reason: "severity" }]);
    expect(notes.map((n) => [n.source, n.findingId, n.repeatOf])).toEqual([
      ["language", "LANG-001", null],
      ["correctness", "F1", null],
    ]);
  });

  test("the reason names why the finding starts no correction", () => {
    expect(noteReason(finding({}), false, ["high"])).toBe("inferred");
    expect(noteReason(finding({ basis: "spec" }), true, ["high"])).toBe("severity");
    expect(noteReason(finding({ basis: "spec", severity: "high" }), true, ["high"])).toBe("repro");
  });
});
