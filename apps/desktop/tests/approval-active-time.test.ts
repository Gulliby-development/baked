import { describe, expect, test } from "bun:test";
import { activeTimeText } from "../src/renderer/lib/active-time.ts";

describe("approval active-time line", () => {
  test("names the rate, the estimate against maxActiveMs and the raised cap", () => {
    const time = { tokensPerMinute: 90_000, basis: "history" as const, runs: 4, before: 3_600_000 };
    expect(activeTimeText({ ...time, estimatedMs: 5_700_000, after: 7_200_000 })).toBe(
      "Estimated active time at the observed rate (90k tokens per minute, the median of 4 runs): 95 min against maxActiveMs 60 min; sizing raised the cap to 120 min",
    );
    expect(
      activeTimeText({ ...time, basis: "default", estimatedMs: 5_700_000, after: 3_600_000 }),
    ).toBe(
      "Estimated active time at the observed rate (90k tokens per minute, the default rate): 95 min against maxActiveMs 60 min; the run may stop at the cap",
    );
    expect(activeTimeText({ ...time, estimatedMs: 600_000, after: 3_600_000 })).toEndWith(
      "10 min against maxActiveMs 60 min",
    );
  });
});
