import { describe, expect, test } from "bun:test";
import {
  builtinProfiles,
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
    expect(text("implementer")).toContain("decoding of the real entry point. Take a license holder");
  });

  test("the reviewer checks the real entry point's decoding", () => {
    expect(text("reviewer")).toContain(INPUT_BYTES_REVIEW_RULE);
    expect(INPUT_BYTES_REVIEW_RULE).toContain("a lenient decoder replaces invalid bytes");
  });
});
