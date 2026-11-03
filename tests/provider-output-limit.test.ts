import { describe, expect, test } from "bun:test";
import { getAllProviders } from "../src/core/llm/providers/index.js";
import { OUTPUT_LIMITS } from "../src/core/llm/providers/output-limit.js";

// #2547: the claude-code adapter dropped the profile's maxOutputTokens, and a haiku reviewer step
// capped at 8,192 wrote 132,330 output tokens. Every adapter says how it bounds a call's output.
describe("provider output limits", () => {
  test("every provider adapter forwards maxOutputTokens or says why it cannot", () => {
    const ids = getAllProviders().map((provider) => provider.id);
    expect(ids.filter((id) => !(id in OUTPUT_LIMITS))).toEqual([]);
    expect(Object.keys(OUTPUT_LIMITS).filter((id) => !ids.includes(id))).toEqual([]);
    for (const how of Object.values(OUTPUT_LIMITS)) {
      if (typeof how === "object" && "none" in how) expect(how.none.length).toBeGreaterThan(20);
    }
  });
});
