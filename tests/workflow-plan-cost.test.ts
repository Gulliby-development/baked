import { describe, expect, test } from "bun:test";
import { planCostText as desktopPlanCostText } from "../apps/desktop/src/renderer/lib/plan-cost.js";
import { findPricing } from "../src/core/llm/pricing.js";
import { DEFAULT_MIX } from "../src/core/workflows/estimate.js";
import { type PlanCost, planCostOf, planCostText } from "../src/core/workflows/plan-cost.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import type { ArtifactRow, AttemptRow, StepRow, WorkflowStore } from "../src/core/workflows/store.js";

// stmtsplit e29347c1 (#1019): planning on claude cost $5.88 of $9.97, and the plan approval showed
// neither. It now shows planning so far by model next to the tasks' price from sizing.

const runId = "run-1";
const OPUS = "anthropic/claude-opus-4-6";
const SONNET = "anthropic/claude-sonnet-4-6";

function artifact(id: string, kind: string, path: string, content: string): ArtifactRow {
  return {
    run_id: runId,
    id,
    kind,
    logical_path: path,
    revision: 1,
    content_hash: "fixture-hash",
    byte_length: Buffer.byteLength(content),
    inline_content: content,
    blob_path: null,
  };
}

/** A store with one attempt per stage, each `input` tokens in and `output` out on `model`. */
function makeStore(
  attempts: { id: string; stage: string; model: string | null; input: number; output: number; cacheRead?: number }[],
  sizing?: { model: string | null; taskTokens: { low: number; expected: number; high: number } },
): WorkflowStore {
  const rows: AttemptRow[] = attempts.map((a) => ({
    id: a.id,
    step_id: `step-${a.id}`,
    model_id: a.model,
    status: "completed",
    reserved_tokens: 0,
    used_tokens: a.input + a.output,
    usage_complete: 1,
    input_hash: "input-hash",
  }));
  const steps: StepRow[] = attempts.map((a) => ({
    id: `step-${a.id}`,
    stage_id: a.stage,
    parent_step_id: null,
    generation: 0,
    status: "completed",
  }));
  const artifacts: ArtifactRow[] = attempts.map((a) => {
    const usage: AttemptUsageRecord = {
      schemaVersion: 1,
      profileId: "planner",
      taskId: null,
      maxSteps: 10,
      maxTokens: 1_000_000,
      stopReason: "submitted",
      finalizedBy: null,
      totalTokens: a.input + a.output,
      steps: [
        { inputTokens: a.input, outputTokens: a.output, cacheReadTokens: a.cacheRead ?? 0, toolCalls: 0, compactedBytes: 0 },
      ],
    };
    return artifact(`usage-${a.id}`, "usage", `attempts/${a.id}/usage.json`, JSON.stringify(usage));
  });
  if (sizing) {
    artifacts.push(artifact("sizing-1", "sizing", "sizing/plan-1.json", JSON.stringify({ taskTokens: { low: 1, expected: 1, high: 1 }, model: null })));
    artifacts.push(artifact("sizing-2", "sizing", "sizing/plan-2.json", JSON.stringify(sizing)));
  }
  const byId = new Map(artifacts.map((a) => [a.id, a.inline_content ?? ""]));
  return {
    steps: () => steps,
    attempts: () => rows,
    attemptTaskGenerations: () => new Map(),
    artifacts: () => artifacts,
    latestArtifact: (_id: string, path: string) => artifacts.find((a) => a.logical_path === path) ?? null,
    readArtifact: (_id: string, id: string) => {
      const content = byId.get(id);
      if (content === undefined) throw new Error(`Missing fixture artifact ${id}`);
      return content;
    },
  } as unknown as WorkflowStore;
}

const price = (model: string) => {
  const pricing = findPricing(model)?.pricing;
  if (!pricing) throw new Error(`No price for ${model}`);
  return pricing;
};

const defaultRate = (model: string) =>
  (DEFAULT_MIX.input * price(model).input + DEFAULT_MIX.cacheRead * price(model).cacheRead + DEFAULT_MIX.output * price(model).output) /
  1e6;

// Bench round 38, stoptable (#1386): codex attempts were 70 to 80 percent cache reads and cost $0.8
// to $1.2 per million tokens. Priced at the default mix, the four plan approvals showed $19.2 to
// $36.1 for features that cost $11.82 in all, planning and reviews included.
describe("scenario: plan cost priced at the run's measured rate (#1386)", () => {
  const sizing = { model: SONNET, taskTokens: { low: 3_000_000, expected: 4_000_000, high: 5_000_000 } };
  // Planning attempts that read 75 percent of their tokens from the cache.
  const cached = (model: string) => [
    { id: "spec", stage: "specify", model, input: 900_000, output: 100_000, cacheRead: 750_000 },
    { id: "plan", stage: "plan", model, input: 450_000, output: 50_000, cacheRead: 375_000 },
  ];

  test("the tasks are priced at what the run's attempts on the model paid per token", () => {
    const cost = planCostOf(makeStore(cached(SONNET), sizing), runId);
    const paid = cost.planning.usd / 1_500_000;
    expect(cost.implementation?.rate).toBe("run");
    expect(cost.implementation?.usd.low).toBeCloseTo(3_000_000 * paid, 6);
    expect(cost.implementation?.usd.high).toBeCloseTo(5_000_000 * paid, 6);
    // The default mix priced the same plan well above what a token actually cost.
    expect(cost.implementation?.usd.low ?? 0).toBeLessThan(0.75 * 3_000_000 * defaultRate(SONNET));
    expect(planCostText(cost)).toEndWith(`on ${SONNET} at this run's dollars per token so far`);
  });

  test("on a model the run has not paid yet, the run's token mix prices it", () => {
    const cost = planCostOf(makeStore(cached(OPUS), sizing), runId);
    const p = price(SONNET);
    const mix = (1_125_000 * p.cacheRead + 225_000 * p.input + 150_000 * p.output) / 1e6 / 1_500_000;
    expect(cost.implementation?.rate).toBe("mix");
    expect(cost.implementation?.usd.low).toBeCloseTo(3_000_000 * mix, 6);
    expect(desktopPlanCostText(cost)).toBe(planCostText(cost));
  });

  test("without any measured attempt the default mix stays", () => {
    const cost = planCostOf(makeStore([{ id: "host", stage: "check", model: null, input: 0, output: 0 }], sizing), runId);
    expect(cost.implementation).toMatchObject({ rate: "default", usd: { low: 3_000_000 * defaultRate(SONNET) } });
    expect(planCostText(cost)).toEndWith(`on ${SONNET}`);
  });
});

describe("plan approval cost (#1019)", () => {
  test("planning is split by model and the tasks are priced from the latest sizing", () => {
    const store = makeStore(
      [
        { id: "spec", stage: "specify", model: OPUS, input: 200_000, output: 20_000 },
        { id: "plan", stage: "plan", model: OPUS, input: 100_000, output: 10_000 },
        { id: "research", stage: "research", model: SONNET, input: 50_000, output: 5_000 },
      ],
      { model: SONNET, taskTokens: { low: 1_000_000, expected: 1_500_000, high: 2_000_000 } },
    );
    const cost = planCostOf(store, runId);
    const opus = (300_000 * price(OPUS).input + 30_000 * price(OPUS).output) / 1e6;
    const sonnet = (50_000 * price(SONNET).input + 5_000 * price(SONNET).output) / 1e6;
    expect(cost.planning.complete).toBe(true);
    expect(cost.planning.models.map((m) => [m.model, m.stages])).toEqual([
      [OPUS, ["specify", "plan"]],
      [SONNET, ["research"]],
    ]);
    expect(cost.planning.models[0]?.usd).toBeCloseTo(opus, 6);
    expect(cost.planning.usd).toBeCloseTo(opus + sonnet, 6);
    // The run's own sonnet attempt paid this per token (#1386).
    const rate = sonnet / 55_000;
    expect(cost.implementation?.model).toBe(SONNET);
    expect(cost.implementation?.rate).toBe("run");
    expect(cost.implementation?.usd.low).toBeCloseTo(1_000_000 * rate, 6);
    expect(cost.implementation?.usd.high).toBeCloseTo(2_000_000 * rate, 6);
  });

  test("an unpriced model marks planning partial and leaves the tasks unpriced", () => {
    const cost = planCostOf(
      makeStore(
        [
          { id: "spec", stage: "specify", model: "fixture/model", input: 1_000, output: 100 },
          { id: "plan", stage: "plan", model: SONNET, input: 1_000, output: 100 },
        ],
        { model: "fixture/model", taskTokens: { low: 1, expected: 2, high: 3 } },
      ),
      runId,
    );
    expect(cost.planning.complete).toBe(false);
    expect(cost.planning.models.map((m) => m.model)).toEqual([SONNET]);
    expect(cost.implementation).toBeNull();
    expect(planCostOf(makeStore([]), runId)).toEqual({
      planning: { usd: 0, complete: true, models: [] },
      implementation: null,
    });
  });

  test("the approval line reads the same in the terminal and the desktop app", () => {
    const cost: PlanCost = {
      planning: {
        usd: 5.876,
        complete: true,
        models: [
          { model: OPUS, usd: 5.5, stages: ["specify", "plan"] },
          { model: SONNET, usd: 0.376, stages: ["research"] },
        ],
      },
      implementation: { model: SONNET, usd: { low: 2.1, high: 14.6 } },
    };
    const text = `Planning so far about $5.88 (${OPUS} $5.50, ${SONNET} $0.38); the planned tasks about $2.10–$15 on ${SONNET}`;
    expect(planCostText(cost)).toBe(text);
    expect(desktopPlanCostText(cost)).toBe(text);
    const partial: PlanCost = {
      planning: { usd: 0, complete: false, models: [] },
      implementation: null,
    };
    expect(planCostText(partial)).toBe("Planning so far about $0.00 (partial: a model has no price)");
    expect(desktopPlanCostText(partial)).toBe(planCostText(partial));
  });
});
