import { describe, expect, test } from "bun:test";
import {
  costGrowthLimit,
  featurePolicy,
  growthLimit,
  guardGrowth,
  type InitiativeSettings,
  type InitiativeView,
  rebaseView,
} from "../src/core/workflows/initiatives/service.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// #1417: a rebased feature's new run was split from what remains by size and passed no growth
// limits, so a large rebased feature took most of the budget, could grow to the base ceiling, and
// left a waiting feature below its estimate. It now shares by need and grows as a start does.

const settings = {
  basePolicy: { ...fixturePolicy, maxCostUsd: 8, sizing: { maxRunTokens: 50_000_000 } },
  costBudget: { maxCostUsd: 20, costTolerance: "off" },
  featureAutoApproval: null,
} as unknown as InitiativeSettings;

const view = {
  budget: {
    remaining: { tokens: 10_000_000, calls: 100, activeMs: 3_600_000 },
    cost: { remainingUsd: 10 },
  },
  features: [
    // api has a run (no share) and is rebased; docs waits and needs 6M to 7M.
    { id: "api", size: "large", share: null, shareUsd: null, need: null },
    {
      id: "docs",
      size: "small",
      share: { tokens: 10_000_000, calls: 100, activeMs: 3_600_000 },
      shareUsd: 10,
      need: { low: 6_000_000, high: 7_000_000 },
    },
  ],
} as unknown as InitiativeView;

describe("scenario: a rebased feature shares the budget as a starting one (#1417)", () => {
  test("the rebased run's share is by need, and it grows only into what the waiting features leave", () => {
    const current = rebaseView(view, "api", { low: 2_000_000, high: 3_000_000 });
    const api = current.features.find((f) => f.id === "api");
    const docs = current.features.find((f) => f.id === "docs");
    // By need, 3 of 10 parts; split by size (large 4, small 1) api took 8M and left docs 2M.
    expect(api?.share?.tokens).toBe(3_000_000);
    expect(api?.shareUsd).toBe(3);
    expect(docs?.share?.tokens).toBe(7_000_000);
    expect(docs?.share?.tokens ?? 0).toBeGreaterThanOrEqual(docs?.need?.low ?? 0);
    // Calls and time still split by size.
    expect(api?.share?.calls).toBe(80);

    const share = { ...(api?.share ?? { tokens: 0, calls: 0, activeMs: 0 }), ...guardGrowth(current, "api", settings.basePolicy) };
    expect(share.calls).toBeGreaterThanOrEqual(80);
    const feature = { id: "api", title: "api", boundary: { scope: "api", paths: ["src/api.ts"] }, contract: "api", dependsOn: [], mandatory: true };
    // 10M less docs' 6M low end; without the limit the run could grow to the base's 50M.
    expect(growthLimit(current, "api")).toBe(4_000_000);
    const policy = featurePolicy(settings, share, feature, true, growthLimit(current, "api"), api?.shareUsd ?? null, costGrowthLimit(current, "api"));
    expect(policy.maxTotalTokens).toBe(3_000_000);
    expect(policy.sizing?.maxRunTokens).toBe(4_000_000);
    expect(policy.maxCostUsd).toBe(3);
  });

  test("an unknown feature leaves the view as it is", () => {
    expect(rebaseView(view, "nope", null)).toBe(view);
  });
});
