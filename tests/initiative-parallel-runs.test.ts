import { describe, expect, test } from "bun:test";
import { criticalPathSummary, planWidth } from "../src/core/workflows/initiatives/critical-path.js";
import { parallelRunCap } from "../src/core/workflows/schemas.js";

// #1822: the slot count from the plan is its width, the most features none of which depends on
// another, so a serial head and tail do not shrink it and transitive edges do not widen it.

const plan = (edges: Record<string, string[]>) => ({
  features: Object.entries(edges).map(([id, dependsOn]) => ({ id, dependsOn })),
});

describe("plan width", () => {
  test("bench round 55, routeshadow: six independent features between a serial head and tail", () => {
    const middle = ["matching", "relations", "building", "summary", "export", "tree"];
    const routeshadow = plan({
      base: [],
      model: ["base"],
      ...Object.fromEntries(middle.map((id) => [id, ["model"]])),
      front: ["matching", "relations", "building", "summary"],
      docs: ["front", "export", "tree"],
    });
    expect(planWidth(routeshadow)).toBe(6);
  });

  test("a chain is one wide, independent features are as wide as they are many", () => {
    expect(planWidth(plan({ a: [], b: ["a"], c: ["b"], d: ["c"] }))).toBe(1);
    expect(planWidth(plan({ a: [], b: [], c: [] }))).toBe(3);
    expect(planWidth(plan({}))).toBe(0);
  });

  test("dependencies through another feature count, so two parallel chains are two wide", () => {
    // a1 -> a2 -> a3 and b1 -> b2: a1 and a3 are not independent though no edge joins them.
    expect(planWidth(plan({ a1: [], a2: ["a1"], a3: ["a2"], b1: [], b2: ["b1"] }))).toBe(2);
    // A diamond: b and c run together; the transitive edge d -> a widens nothing.
    expect(planWidth(plan({ a: [], b: ["a"], c: ["a"], d: ["b", "c", "a"] }))).toBe(2);
  });

  test("an unknown dependency or a cycle does not break the count", () => {
    expect(planWidth(plan({ a: ["missing"], b: [] }))).toBe(2);
    expect(planWidth(plan({ a: ["b"], b: ["a"], c: [] }))).toBeGreaterThanOrEqual(1);
  });
});

test("the split approval's summary carries the plan width", () => {
  const split = {
    features: ["a", "b", "c"].map((id) => ({ id, title: id, dependsOn: [], size: "small", boundary: { paths: [`${id}.txt`] } })),
  };
  // biome-ignore lint/suspicious/noExplicitAny: a minimal plan for the summary
  expect(criticalPathSummary(split as any, "", 2)?.width).toBe(3);
});

test("the cap is maxParallelRuns, else 3 with the plan's width and 2 without", () => {
  expect(parallelRunCap({})).toBe(2);
  expect(parallelRunCap({ workflows: { parallelRunsFromPlan: true } })).toBe(3);
  expect(parallelRunCap({ workflows: { parallelRunsFromPlan: true, maxParallelRuns: 5 } })).toBe(5);
  expect(parallelRunCap({ workflows: { maxParallelRuns: 1 } })).toBe(1);
});
