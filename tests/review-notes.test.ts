import { describe, expect, test } from "bun:test";
import { addReviewNotes, noteReason } from "../src/core/verification/review-notes.js";
import type { Review } from "../src/core/workflows/schemas.js";
import { siblingOwner } from "../src/core/verification/initiative-ownership.js";
import type { ReviewNote, RuntimeState } from "../src/core/workflows/types.js";

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
    expect(noteReason(finding({}), ["high"], 0.5)).toBe("inferred");
    expect(noteReason(finding({ basis: "spec", confidence: 0.3 }), ["low"], 0.5)).toBe("confidence");
    expect(noteReason(finding({ basis: "spec" }), ["high"], 0.5)).toBe("severity");
    expect(noteReason(finding({ basis: "spec", severity: "high" }), ["high"], 0.5)).toBe("repro");
  });
});

test("ownership respects current, shared, glob and Windows paths", () => {
  const bounds: RuntimeState["initiativeBounds"] = { featureId: "adapters", features: [
    { id: "entry", scope: "Entry", paths: ["tests/**", "shared.py"] },
    { id: "adapters", scope: "Adapters", paths: ["shared.py", "src/*.py"] },
  ] };
  expect(siblingOwner("tests/test_x.py", bounds)?.id).toBe("entry");
  expect(siblingOwner(".\\tests\\test_x.py", bounds)?.id).toBe("entry");
  for (const file of [null, "shared.py", "src/adapter.py", "unowned.py"]) expect(siblingOwner(file, bounds)).toBeUndefined();
  expect(siblingOwner("tests/test_x.py", null)).toBeUndefined();
  expect(siblingOwner("tests/test_x.py", { ...bounds, featureId: "missing" })).toBeUndefined();
});
