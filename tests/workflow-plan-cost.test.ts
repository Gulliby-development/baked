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
  attempts: { id: string; stage: string; model: string | null; input: number; output: number }[],
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
        { inputTokens: a.input, outputTokens: a.output, cacheReadTokens: 0, toolCalls: 0, compactedBytes: 0 },
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
    const rate =
      (DEFAULT_MIX.input * price(SONNET).input +
        DEFAULT_MIX.cacheRead * price(SONNET).cacheRead +
        DEFAULT_MIX.output * price(SONNET).output) /
      1e6;
    expect(cost.implementation?.model).toBe(SONNET);
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
