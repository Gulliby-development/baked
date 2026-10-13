import { afterEach, describe, expect, test } from "bun:test";
import { mergeConfigs } from "../src/config/index.js";
import { StartBody } from "../src/core/api/schemas.js";
import { planSettingsChange, settingsView } from "../src/core/settings/values.js";
import { startCostCap } from "../src/core/workflows/budget.js";
import { type DoctorDeps, preRunEstimate, runDoctor } from "../src/core/workflows/doctor.js";
import { estimatePreRun } from "../src/core/workflows/estimate.js";
import { prepareStart } from "../src/core/workflows/start.js";
import { costCapInput } from "../src/core/workflows/view.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { formatEstimate, preRunRequest } from "../src/headless/workflow-pre-run.js";
import type { AppConfig } from "../src/types/index.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A priced model, so a start with a cap is not refused for a missing price. */
const MODEL = "anthropic/claude-sonnet-4-6";

const healthy: DoctorDeps = {
  providerReady: async () => ({ known: true, ready: true }),
  which: (command) => `/usr/bin/${command}`,
  git: async (args) =>
    args[0] === "rev-parse" ? { code: 0, stdout: "true\n" } : { code: 0, stdout: "" },
};

function fixture() {
  const made = workflowFixture();
  cleanups.push(made.dispose);
  const config = { ...made.config, defaultModel: MODEL } as AppConfig;
  return { root: made.root, config };
}

describe("the cap a run starts with", () => {
  test("the requested cap wins, then the policy's, then the runBudget setting", () => {
    const setting = { runBudget: { maxCostUsd: 3 } };
    expect(startCostCap(1, { maxCostUsd: 2 }, setting)).toBe(1);
    expect(startCostCap(undefined, { maxCostUsd: 2 }, setting)).toBe(2);
    expect(startCostCap(undefined, { maxCostUsd: null }, setting)).toBe(3);
    expect(startCostCap(undefined, { maxCostUsd: null }, {})).toBeNull();
  });

  test("prepareStart freezes the requested or configured cap in the policy", async () => {
    const { root, config } = fixture();
    const base = { workflowId: "sdd", policy: fixturePolicy };
    expect((await prepareStart(root, config, base)).policy.maxCostUsd).toBeNull();
    expect((await prepareStart(root, config, { ...base, maxCostUsd: 4 })).policy.maxCostUsd).toBe(4);
    const withSetting = { ...config, runBudget: { maxCostUsd: 7 } };
    expect((await prepareStart(root, withSetting, base)).policy.maxCostUsd).toBe(7);
    // The run model has no price: a requested cap is refused as a policy cap is.
    await expect(
      prepareStart(root, { ...config, defaultModel: "fixture/model" }, { ...base, maxCostUsd: 4 }),
    ).rejects.toThrow(/no price is known for fixture\/model/);
  });
});

describe("estimate and doctor against the cap", () => {
  const price = { input: 2, cacheRead: 0.5, output: 10, match: "table" as const };
  const estimate = (maxCostUsd?: number | null) =>
    estimatePreRun({
      history: [],
      workflowId: "spike",
      stages: [{ id: "research", type: "agent", models: ["a/m"] }],
      maxTotalTokens: 10_000_000,
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
      price: () => price,
    });

  test("the estimate compares its cost range with the cap", () => {
    const { costUsd } = estimate();
    if (!costUsd) throw new Error("expected a priced estimate");
    expect(estimate().cost).toBeUndefined();
    expect(estimate(null).cost).toBeUndefined();
    expect(estimate(costUsd.high * 2).cost).toEqual({ maxCostUsd: costUsd.high * 2, fits: "yes" });
    const middle = (costUsd.low + costUsd.high) / 2;
    expect(estimate(middle).cost?.fits).toBe("maybe");
    expect(estimate(costUsd.low / 2).cost?.fits).toBe("no");
    expect(formatEstimate(estimate(costUsd.low / 2))).toContain("will very likely be passed");
  });

  test("--max-cost-usd reaches the estimate and the doctor warns when the cost may pass it", async () => {
    const { root, config } = fixture();
    const args = parseWorkflowArgs(["estimate", "sdd", "--max-cost-usd", "0.001"]);
    const low = await preRunEstimate(root, config, preRunRequest(args, root));
    expect(low.cost).toEqual({ maxCostUsd: 0.001, fits: "no" });
    const tight = await runDoctor(root, config, { workflowId: "sdd", maxCostUsd: 0.001 }, healthy);
    expect(tight.checks.find((c) => c.id === "budget.cost")).toMatchObject({
      status: "warn",
      title: "The run will very likely pass its cost cap",
    });
    const roomy = await runDoctor(root, config, { workflowId: "sdd", maxCostUsd: 100_000 }, healthy);
    expect(roomy.checks.some((c) => c.id === "budget.cost")).toBe(false);
    expect(roomy.estimate?.cost?.fits).toBe("yes");
  });
});

describe("surfaces", () => {
  test("the command line takes a positive number of dollars", () => {
    expect(
      parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--max-cost-usd", "2.5"]).flags,
    ).toMatchObject({ "max-cost-usd": "2.5" });
    for (const bad of ["0", "-1", "abc"])
      expect(() =>
        parseWorkflowArgs(["run", "--feature", "f", "--prompt", "p", "--max-cost-usd", bad]),
      ).toThrow(/--max-cost-usd requires a positive number/);
  });

  test("POST /v1/workflow/runs takes maxCostUsd", () => {
    const body = { commandId: "c1", feature: "f", prompt: "p" };
    expect(StartBody.parse({ ...body, maxCostUsd: 2.5 }).maxCostUsd).toBe(2.5);
    expect(() => StartBody.parse({ ...body, maxCostUsd: 0 })).toThrow();
  });

  test("the form field is empty, a cap, or invalid", () => {
    expect(costCapInput("")).toBeUndefined();
    expect(costCapInput(" $12.5 ")).toBe(12.5);
    expect(costCapInput("0")).toBeNull();
    expect(costCapInput("ten")).toBeNull();
  });

  test("the Cost cap setting is saved per scope and a project keeps the global policy", () => {
    const planned = planSettingsChange({}, { scope: "project", set: { "runBudget.maxCostUsd": 5 } });
    expect(planned.layer).toEqual({ runBudget: { maxCostUsd: 5 } });
    const global = { defaultModel: MODEL, workflows: { policy: fixturePolicy } } as AppConfig;
    const merged = mergeConfigs(global, planned.layer as Partial<AppConfig>);
    expect(merged.runBudget?.maxCostUsd).toBe(5);
    expect(merged.workflows?.policy.maxTotalTokens).toBe(fixturePolicy.maxTotalTokens);
    const view = settingsView({
      global: {},
      project: planned.layer ?? {},
      effective: merged,
      secret: () => "none",
    });
    expect(view.values["runBudget.maxCostUsd"]).toMatchObject({ value: 5, source: "project" });
    const cleared = planSettingsChange(planned.layer ?? {}, {
      scope: "project",
      set: { "runBudget.maxCostUsd": null },
    });
    expect(cleared.layer).toEqual({});
  });
});
