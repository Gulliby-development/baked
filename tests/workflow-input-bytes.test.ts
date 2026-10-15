import { describe, expect, test } from "bun:test";
import {
  builtinProfiles,
  INPUT_BYTES_ANALYZE_RULE,
  INPUT_BYTES_PLAN_RULE,
  INPUT_BYTES_REVIEW_RULE,
  INPUT_BYTES_TEST_RULE,
} from "../src/core/agents/profiles/builtin.js";

// R28 lockorder 8ce14645: `Cli.Run` took a TextReader, so 211 tests never put an invalid UTF-8 byte
// on standard input, and the review found nothing while stdin was decoded leniently (#1249).
describe("a criterion about the bytes of an input channel", () => {
  const text = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";

  test("the planner adds a process-level test for it", () => {
    expect(text("planner")).toContain(INPUT_BYTES_PLAN_RULE);
    expect(INPUT_BYTES_PLAN_RULE).toContain("starts the built program as a process");
  });

  test("the implementer writes that test with the exact bytes on the channel", () => {
    expect(text("implementer")).toContain(INPUT_BYTES_TEST_RULE);
    expect(INPUT_BYTES_TEST_RULE).toContain("writes those exact bytes to that channel");
    expect(text("implementer")).toContain("a test passes it those exact bytes. Take a license holder");
  });

  test("the reviewer checks the real entry point's decoding", () => {
    expect(text("reviewer")).toContain(INPUT_BYTES_REVIEW_RULE);
    expect(INPUT_BYTES_REVIEW_RULE).toContain("a lenient decoder replaces invalid bytes");
  });

  // R31 pgnvet 3f03497b and idpeek a270ff5a: the rule outranked a brief whose tests are hermetic,
  // and the spec reviewer, which did not know it, raised the conflict seven times (#1297).
  test("a request that keeps the tests hermetic outranks the process test", () => {
    for (const rule of [INPUT_BYTES_PLAN_RULE, INPUT_BYTES_TEST_RULE])
      expect(rule).toContain("When the request or the accepted spec says the tests are hermetic");
    expect(INPUT_BYTES_REVIEW_RULE).toContain("a missing process test is not a finding");
  });

  test("the spec reviewer knows the rule and when the request rules it out", () => {
    expect(text("spec-reviewer")).toContain(INPUT_BYTES_ANALYZE_RULE);
    expect(INPUT_BYTES_ANALYZE_RULE).toContain("never report the absence of a process test");
  });
});
