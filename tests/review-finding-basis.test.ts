import { describe, expect, test } from "bun:test";
import { findingBlocks } from "../src/core/verification/findings.js";
import type { Review } from "../src/core/workflows/schemas.js";

const finding = (fields: Partial<Review["findings"][number]>): Review["findings"][number] => ({
  id: "F1",
  kind: "correctness",
  severity: "high",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file: null,
  symbol: null,
  evidenceIds: ["E1"],
  claim: "The parser rejects the basic ISO 8601 format",
  impact: "A user cannot enter 20250101T000000Z",
  suggestedFix: "Accept the basic format",
  ...fields,
});

describe("review finding basis", () => {
  test("a finding the spec names blocks, also without a basis", () => {
    expect(findingBlocks(finding({ basis: "spec" }))).toBe(true);
    expect(findingBlocks(finding({}))).toBe(true);
  });

  test("an inferred finding is a note unless it is a security finding or critical", () => {
    expect(findingBlocks(finding({ basis: "inferred" }))).toBe(false);
    expect(findingBlocks(finding({ basis: "inferred", kind: "security" }))).toBe(true);
    expect(findingBlocks(finding({ basis: "inferred", severity: "critical" }))).toBe(true);
  });
});
