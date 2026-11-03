import { describe, expect, test } from "bun:test";
import { computeModelCost, modelsByCost } from "../src/stores/statusbar.js";

const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

describe("modelsByCost (#2785)", () => {
  test("orders models by their own cost, not by their tokens", () => {
    // 1M Haiku input costs $1.00; 100k Opus 4.1 input costs $1.50.
    const breakdown = {
      "claude-haiku-4-5": usage(1_000_000),
      "claude-opus-4-1": usage(100_000),
    };
    expect(computeModelCost("claude-opus-4-1", usage(100_000))).toBeGreaterThan(
      computeModelCost("claude-haiku-4-5", usage(1_000_000)),
    );
    expect(modelsByCost(breakdown).map(([id]) => id)).toEqual([
      "claude-opus-4-1",
      "claude-haiku-4-5",
    ]);
  });

  test("an empty breakdown gives no rows", () => {
    expect(modelsByCost({})).toEqual([]);
  });
});
