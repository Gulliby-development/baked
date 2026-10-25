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
      if (!["cost-forecast", "approval-scope", "initiative-forecast", "initiative-dollar-share", "initiative-plan-charge", "repeated_failure", "corrective_scope", "corrective_unowned_file", "upstream_symbol"].includes(id))
        expect(reason.modes).toEqual(["enforce"]);
    }
    expect(STOP_REASONS["cost-forecast"].modes).toEqual(STOP_MODES);
    // Shadow until its promotion (#1996): a policy cannot enforce it yet.
    expect(STOP_REASONS.repeated_failure.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.repeated_failure.defaultMode).toBe("shadow");
    expect(STOP_REASONS.upstream_symbol.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.upstream_symbol.defaultMode).toBe("shadow");
    const parse = (stopModes: unknown) => PolicySchema.safeParse({ ...defaultWorkflowPolicy, stopModes }).success;
    expect(parse({ "cost-forecast": "shadow", "approval-scope": "advisory" })).toBe(true);
    expect(parse({ cost: "shadow" })).toBe(false);
    expect(parse({ "run-budget": "advisory" })).toBe(false);
    expect(parse({ unknown: "shadow" })).toBe(false);
    expect(parse({ repeated_failure: "advisory" })).toBe(true);
    expect(parse({ repeated_failure: "enforce" })).toBe(false);
    // Shadow by default (#2133), enforceable through stopModes so its host decision can be turned on.
    expect(STOP_REASONS.corrective_unowned_file.defaultMode).toBe("shadow");
    expect(stopMode(defaultWorkflowPolicy, "corrective_unowned_file")).toBe("shadow");
    expect(parse({ corrective_unowned_file: "enforce" })).toBe(true);
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
