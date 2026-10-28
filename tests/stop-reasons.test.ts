import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { PolicySchema } from "../src/core/workflows/schemas.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { STOP_MODES, STOP_REASONS, stopFault, stopMode } from "../src/core/workflows/stop-reasons.js";

// #1714: every stop site is a registered reason with a mode, so a new or changed stop can ship in
// shadow and record what it would have done before it stops a bench round.

const root = join(import.meta.dir, "..");

describe("stop reasons", () => {
  test("every stopping fault in src is made by stopFault with a registered reason", () => {
    const offenders: string[] = [];
    for (const file of new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })) {
      if (file.endsWith("stop-reasons.ts")) continue;
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/new\s+WorkflowFault\(\s*"BUDGET_EXHAUSTED"/g)) {
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${relative(root, join(root, file))}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("a stopFault carries the reason as details.reason", () => {
    const fault = stopFault("cost", "The next model call would pass the run's cost cap", { spentUsd: 1 });
    expect(fault.code).toBe("BUDGET_EXHAUSTED");
    expect(fault.details).toEqual({ reason: "cost", spentUsd: 1 });
  });

  test("hard limits take only enforce; the forecasts and the approval scope take every mode", () => {
    for (const [id, reason] of Object.entries(STOP_REASONS)) {
      expect(reason.modes).toContain(reason.defaultMode);
      if (!["cost-forecast", "approval-scope", "initiative-forecast", "initiative-dollar-share", "initiative-dollar-cap", "initiative-plan-charge", "initiative-pool-growth", "repeated_failure", "corrective_scope", "corrective_unowned_file", "repeat_without_change", "corrective_restores_removed", "edge_crash_finding", "repro_blind", "upstream_symbol", "baseline_unrepairable", "baseline_signature", "check-config-approval", "ci_check_drift", "committed_tree", "host-resume-on-stored-limit", "cost_refusal_wait"].includes(id))
        expect(reason.modes).toEqual(["enforce"]);
    }
    expect(STOP_REASONS["cost-forecast"].modes).toEqual(STOP_MODES);
    // Shadow until its promotion (#1996): a policy cannot enforce it yet.
    expect(STOP_REASONS.repeated_failure.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.repeated_failure.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2137).
    expect(STOP_REASONS.repeat_without_change.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.repeat_without_change.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2277): a corrective that restores the previous one's removal.
    expect(STOP_REASONS.corrective_restores_removed.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.corrective_restores_removed.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2136): a crash inside the probed task's file is not a finding yet.
    expect(STOP_REASONS.edge_crash_finding.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.edge_crash_finding.defaultMode).toBe("shadow");
    expect(STOP_REASONS.repro_blind.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.repro_blind.defaultMode).toBe("shadow");
    expect(STOP_REASONS.upstream_symbol.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.upstream_symbol.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2215): a required check failing at baseline outside the plan.
    expect(STOP_REASONS.baseline_unrepairable.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.baseline_unrepairable.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2295): a baseline failure matched only by its shaped signature.
    expect(STOP_REASONS.baseline_signature.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.baseline_signature.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2284): a delivered CI command no configured check runs.
    expect(STOP_REASONS.ci_check_drift.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.ci_check_drift.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2225): a static check that fails on the feature's commit only.
    expect(STOP_REASONS.committed_tree.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.committed_tree.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2226): a blocked run whose stored limits grew past its usage.
    expect(STOP_REASONS["host-resume-on-stored-limit"].modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS["host-resume-on-stored-limit"].defaultMode).toBe("shadow");
    // Shadow until its promotion (#2249): a cost refusal at review that would wait on its extend.
    expect(STOP_REASONS.cost_refusal_wait.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.cost_refusal_wait.defaultMode).toBe("shadow");
    // Shadow until its promotion (#2218): an initiative that would pause on its dollar cap.
    expect(STOP_REASONS["initiative-dollar-cap"].modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS["initiative-dollar-cap"].defaultMode).toBe("shadow");
    // Shadow until its promotion (#2280): a feature run's bound above the pool or the ceiling.
    expect(STOP_REASONS["initiative-pool-growth"].modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS["initiative-pool-growth"].defaultMode).toBe("shadow");
    const parse = (stopModes: unknown) => PolicySchema.safeParse({ ...defaultWorkflowPolicy, stopModes }).success;
    expect(parse({ ci_check_drift: "advisory" })).toBe(true);
    expect(parse({ ci_check_drift: "enforce" })).toBe(false);
    // Promoted (#2245) after R70 and R71: enforced with stopModes unset, shadow still on request.
    expect(STOP_REASONS["initiative-plan-charge"].defaultMode).toBe("enforce");
    expect(stopMode(defaultWorkflowPolicy, "initiative-plan-charge")).toBe("enforce");
    expect(parse({ "initiative-plan-charge": "shadow" })).toBe(true);
    expect(parse({ "cost-forecast": "shadow", "approval-scope": "advisory" })).toBe(true);
    expect(parse({ cost: "shadow" })).toBe(false);
    expect(parse({ "run-budget": "advisory" })).toBe(false);
    expect(parse({ unknown: "shadow" })).toBe(false);
    expect(parse({ repeated_failure: "advisory" })).toBe(true);
    expect(parse({ repeated_failure: "enforce" })).toBe(false);
    expect(parse({ baseline_unrepairable: "advisory" })).toBe(true);
    expect(parse({ baseline_unrepairable: "enforce" })).toBe(false);
    // Shadow by default (#2133), enforceable through stopModes so its host decision can be turned on.
    expect(STOP_REASONS.corrective_unowned_file.defaultMode).toBe("shadow");
    expect(stopMode(defaultWorkflowPolicy, "corrective_unowned_file")).toBe("shadow");
    expect(parse({ corrective_unowned_file: "enforce" })).toBe(true);
    // Shadow by default (#2221) for the check configs auto-approval did not protect before.
    expect(stopMode(defaultWorkflowPolicy, "check-config-approval")).toBe("shadow");
    expect(parse({ "check-config-approval": "enforce" })).toBe(true);
  });

  test("the mode is the explicit entry, else the legacy advisory forecast, else the default", () => {
    expect(stopMode(defaultWorkflowPolicy, "cost-forecast")).toBe("enforce");
    expect(stopMode({ ...defaultWorkflowPolicy, costForecast: "advise" }, "cost-forecast")).toBe("advisory");
    expect(stopMode({ ...defaultWorkflowPolicy, costForecast: "advise", stopModes: { "cost-forecast": "shadow" } }, "cost-forecast")).toBe("shadow");
    expect(stopMode({ ...defaultWorkflowPolicy, costForecast: "advise" }, "approval-scope")).toBe("enforce");
  });

  test("a policy without stopModes keeps its hash", () => {
    expect("stopModes" in PolicySchema.parse(defaultWorkflowPolicy)).toBe(false);
  });
});
