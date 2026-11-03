import { describe, expect, test } from "bun:test";
import { getAllProviders } from "../src/core/llm/providers/index.js";
import {
  OUTPUT_LIMITS,
  STREAM_OUTPUT_FACTOR,
  streamOutputDecision,
} from "../src/core/llm/providers/output-limit.js";

// #2547: the claude-code adapter dropped the profile's maxOutputTokens, and a haiku reviewer step
// capped at 8,192 wrote 132,330 output tokens. Every adapter says how it bounds a call's output.
describe("provider output limits", () => {
  test("every provider adapter forwards maxOutputTokens or says why it cannot", () => {
    const ids = getAllProviders().map((provider) => provider.id);
    expect(ids.filter((id) => !(id in OUTPUT_LIMITS))).toEqual([]);
    expect(Object.keys(OUTPUT_LIMITS).filter((id) => !ids.includes(id))).toEqual([]);
    for (const how of Object.values(OUTPUT_LIMITS)) {
      if (typeof how === "object" && "none" in how) expect(how.none.length).toBeGreaterThan(20);
      if (typeof how === "object" && "stream" in how) expect(how.stream.length).toBeGreaterThan(20);
    }
  });
});

// #2660: Codex takes no output limit, so its app-server stream is guarded at twice the limit.
describe("the stream guard's rule", () => {
  test("codex is guarded on the stream; the rule stops past twice the limit", () => {
    expect(OUTPUT_LIMITS.codex).toEqual({ stream: expect.stringContaining("app-server") });
    expect(STREAM_OUTPUT_FACTOR).toBe(2);
    expect(streamOutputDecision({ maxOutputTokens: 100, streamedChars: 800 })).toEqual({
      limitTokens: 200,
      streamedTokens: 200,
      over: false,
    });
    expect(streamOutputDecision({ maxOutputTokens: 100, streamedChars: 801 }).over).toBe(true);
  });
});
