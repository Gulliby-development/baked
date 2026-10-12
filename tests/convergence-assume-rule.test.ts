import { describe, expect, test } from "bun:test";
import { assumeDecision } from "../src/core/verification/convergence-stop.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";

const assume = { ...defaultWorkflowPolicy, clarification: "assume" as const };
const finding = (id: string, extra: Record<string, unknown> = {}) => ({
  id, severity: "medium" as const, kind: "missing" as const, criterionIds: ["AC-001"], file: null, symbol: null, claim: id, impact: "i", suggestedFix: "f", ...extra,
});
const body = (findings: ReturnType<typeof finding>[], failing = 2, total = 7, checksPassing = true) => ({
  checksPassing,
  criteria: { total, passing: total - failing, failing: Array.from({ length: failing }, (_, i) => ({ id: `AC-00${String(i + 1)}`, verdict: "fail", explanation: "x" })) },
  findings,
});
const fresh = { autoExtensions: 0 };

describe("the assume rule counts distinct findings", () => {
  test("2 of 7 criteria failing is accepted: the share of criteria is not the measure (url B, jsonshape)", () => {
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1")], 2, 7))?.decision).toBe("accept");
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1"), finding("F2")], 3, 7))?.decision).toBe("accept");
  });
  test("three distinct findings ask, and findings repeating one cause count once", () => {
    const three = [finding("F1"), finding("F2"), finding("F3")];
    const ruled = assumeDecision(assume, fresh, { reason: "rounds" }, body(three));
    expect(ruled?.decision).toBe("ask");
    expect(ruled?.why).toContain("3 distinct findings");
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1"), finding("F2", { repeatOf: "F1" }), finding("F3", { repeatOf: "F1" })]))?.decision).toBe("accept");
  });
  test("critical, a high finding with a reproduction and a failing check ask; a static high finding does not", () => {
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1", { severity: "critical" })]))?.decision).toBe("ask");
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1", { severity: "high", reproduced: true })]))?.decision).toBe("ask");
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1", { severity: "high", reproduced: false })]))?.decision).toBe("accept");
    expect(assumeDecision(assume, fresh, { reason: "rounds" }, body([finding("F1")], 2, 7, false))?.decision).toBe("ask");
  });
  test("a contradiction extends once, then is judged like any other stop", () => {
    expect(assumeDecision(assume, fresh, { reason: "contradiction" }, body([finding("F1", { severity: "critical" })]))?.decision).toBe("extend");
    expect(assumeDecision(assume, { autoExtensions: 1 }, { reason: "contradiction" }, body([finding("F1")]))?.decision).toBe("accept");
  });
  test("a policy that asks has no host rule", () => {
    expect(assumeDecision(defaultWorkflowPolicy, fresh, { reason: "rounds" }, body([finding("F1")]))).toBeNull();
  });
});
