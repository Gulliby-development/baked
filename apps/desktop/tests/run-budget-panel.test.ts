import { describe, expect, test } from "bun:test";
import { budgetPanelNeeded } from "../src/renderer/screens/runs/model.ts";

// #1435: the service extends a run blocked for another reason once its spent and reserved cost
// reaches 95% of the cap, so the run screen opens its Budget panel (with Extend) by the same rule.
describe("budgetPanelNeeded", () => {
  const blocked = (reason: string, spent: number, reserved?: number) => ({
    status: "blocked" as const,
    reason,
    estimatedCostUsd: spent,
    maxCostUsd: 1,
    ...(reserved !== undefined ? { reservedCostUsd: reserved } : {}),
  });

  test("opens for a near-cap block counting the reserved cost", () => {
    expect(budgetPanelNeeded(blocked("invalid_output", 0.9, 0.06))).toBe(true);
    expect(budgetPanelNeeded(blocked("invalid_output", 0.9))).toBe(false);
    expect(budgetPanelNeeded(blocked("invalid_output", 0.9, 0.04))).toBe(false);
  });

  test("opens for budget and provider stops, not for an attempt-cap stop or a running run", () => {
    expect(budgetPanelNeeded(blocked("budget_exhausted", 0.1))).toBe(true);
    expect(budgetPanelNeeded(blocked("provider_unavailable", 0.1))).toBe(true);
    // A usage-policy refusal offers the switch to another model (#1895).
    expect(budgetPanelNeeded(blocked("provider_policy", 0.1))).toBe(true);
    expect(budgetPanelNeeded(blocked("attempt_cap", 0.99))).toBe(false);
    expect(budgetPanelNeeded({ ...blocked("invalid_output", 0.99), status: "running" })).toBe(false);
  });
});
