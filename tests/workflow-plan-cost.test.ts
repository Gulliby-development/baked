import { describe, expect, test } from "bun:test";
import { planCostText as desktopPlanCostText } from "../apps/desktop/src/renderer/lib/plan-cost.js";
import { findPricing } from "../src/core/llm/pricing.js";
import { DEFAULT_MIX, type TokenMix } from "../src/core/workflows/estimate.js";
import { type PlanCost, planCostOf, planCostText, planCostWarning, plannedRunTokens } from "../src/core/workflows/plan-cost.js";
import { taskTotal, verificationTokens } from "../src/core/workflows/sizing.js";
import { forecastRate, TASK_MIX } from "../src/core/workflows/stage-price.js";
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

let stamp = 0;

/** A store with one attempt per stage, each `input` tokens in and `output` out on `model`. */
function makeStore(
  attempts: { id: string; stage: string; model: string | null; input: number; output: number; cacheRead?: number }[],
  sizing?: { model: string | null; taskTokens: { low: number; expected: number; high: number }; [key: string]: unknown },
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
    latestArtifacts: (_id: string, pattern: string) => {
      const like = new RegExp(`^${pattern.split("%").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      return artifacts.filter((a, i) => like.test(a.logical_path) && artifacts.findIndex((b) => b.logical_path === a.logical_path) === i);
    },
    readArtifact: (_id: string, id: string) => {
      const content = byId.get(id);
      if (content === undefined) throw new Error(`Missing fixture artifact ${id}`);
      return content;
    },
    readArtifactJson: (_id: string, row: ArtifactRow) => JSON.parse(byId.get(row.id) ?? "null"),
    priceStamp: () => `stamp-${(stamp += 1)}`,
  } as unknown as WorkflowStore;
}

const price = (model: string) => {
  const pricing = findPricing(model)?.pricing;
  if (!pricing) throw new Error(`No price for ${model}`);
  return pricing;
};

const rateAt = (model: string, mix: TokenMix) =>
  (mix.input * price(model).input + mix.cacheRead * price(model).cacheRead + mix.output * price(model).output) / 1e6;
const defaultRate = (model: string) => rateAt(model, DEFAULT_MIX);

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
  // A task attempt that read 90 percent of its input from the cache.
  const task = (model: string) => ({ id: "t1", stage: "task-T001", model, input: 200_000, output: 10_000, cacheRead: 180_000 });

  test("the tasks are priced at what the run's task attempts on the model paid per token", () => {
    const cost = planCostOf(makeStore([...cached(SONNET), task(SONNET)], sizing), runId);
    const paid = (20_000 * price(SONNET).input + 180_000 * price(SONNET).cacheRead + 10_000 * price(SONNET).output) / 1e6 / 210_000;
    expect(cost.implementation?.rate).toBe("run");
    expect(cost.implementation?.usd.low).toBeCloseTo(3_000_000 * paid, 6);
    expect(cost.implementation?.usd.high).toBeCloseTo(5_000_000 * paid, 6);
    expect(planCostText(cost)).toEndWith(`on ${SONNET} at this run's dollars per token so far`);
  });

  test("on a model whose tasks have not run, the run's task mix prices it", () => {
    const cost = planCostOf(makeStore([...cached(OPUS), task(OPUS)], sizing), runId);
    const p = price(SONNET);
    const mix = (20_000 * p.input + 180_000 * p.cacheRead + 10_000 * p.output) / 1e6 / 210_000;
    expect(cost.implementation?.rate).toBe("mix");
    expect(cost.implementation?.usd.low).toBeCloseTo(3_000_000 * mix, 6);
    expect(desktopPlanCostText(cost)).toBe(planCostText(cost));
  });

  test("before any task ran, a task loop's typical mix prices them, below the default mix", () => {
    const cost = planCostOf(makeStore(cached(SONNET), sizing), runId);
    expect(cost.implementation).toMatchObject({ rate: "default", usd: { low: 3_000_000 * rateAt(SONNET, TASK_MIX) } });
    // The default mix priced the stoptable plans at about twice what their tasks paid.
    expect(cost.implementation?.usd.low ?? 0).toBeLessThan(0.75 * 3_000_000 * defaultRate(SONNET));
    expect(planCostText(cost)).toEndWith(`on ${SONNET}`);
  });

  test("without any measured attempt the task mix prices them", () => {
    const cost = planCostOf(makeStore([{ id: "host", stage: "check", model: null, input: 0, output: 0 }], sizing), runId);
    expect(cost.implementation).toMatchObject({ rate: "default", usd: { low: 3_000_000 * rateAt(SONNET, TASK_MIX) } });
  });
});

// Bench round 51, commitbump-update (#1712): Opus planned in one-step calls that wrote the prompt
// cache and never read it, and the approval priced the Sonnet tasks at that mix: $5.04 to $14.90,
// "priced up to $16" against a $12 cap. The four task attempts cost $0.42 for 402,191 tokens,
// about $1.04 per million; T001 read 62,773 of its 68,674 input tokens from the cache.
describe("scenario: a first-use provider's plan is not priced at its planning calls' mix (#1712)", () => {
  const planning = ["research", "specify", "plan", "analyze"].map((stage) => ({
    id: stage,
    stage,
    model: OPUS,
    input: 60_000,
    output: 6_000,
  }));
  const sizing = {
    model: SONNET,
    taskTokens: { low: 1_112_721, expected: 2_201_295, high: 3_289_869 },
  };

  test("the tasks are priced within twice what the Sonnet tasks paid per token", () => {
    const cost = planCostOf(makeStore(planning, sizing), runId);
    const perToken = (cost.implementation?.usd.high ?? 0) / sizing.taskTokens.high;
    const paid = 0.42 / 402_191;
    expect(perToken).toBeLessThan(2 * paid);
    expect(perToken).toBeGreaterThan(paid / 2);
    // The planning calls' mix priced every task token as uncached input.
    const planningMix = (240_000 * price(SONNET).input + 24_000 * price(SONNET).output) / 1e6 / 264_000;
    expect(perToken).toBeLessThan(planningMix / 2);
  });

  test("the run forecast prices a task stage without samples at the same task mix", () => {
    expect(forecastRate([], "implement", SONNET)).toBeCloseTo(rateAt(SONNET, TASK_MIX), 12);
    expect(forecastRate([], "review", SONNET)).toBeCloseTo(defaultRate(SONNET), 12);
  });

  test("a range taken from other models' tasks says so in the terminal and the desktop app", () => {
    const rate = (model: string | null) => ({
      create: { perFile: { low: 1, high: 2 }, samples: 9, basis: "history", model },
      modify: { perFile: { low: 1, high: 2 }, samples: 0, basis: "defaults", model: null },
    });
    const borrowed = { ...sizing, rates: { code: rate(null), test: rate(null), docs: rate(null), manifest: rate(null) } };
    const cost = planCostOf(makeStore(planning, borrowed), runId);
    expect(cost.implementation?.otherModels).toBe(true);
    expect(planCostText(cost)).toContain("token range from other models' tasks");
    expect(desktopPlanCostText(cost)).toBe(planCostText(cost));
    const own = { ...sizing, rates: { code: rate(SONNET), test: rate(SONNET), docs: rate(SONNET), manifest: rate(SONNET) } };
    expect(planCostOf(makeStore(planning, own), runId).implementation?.otherModels).toBeUndefined();
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
    // No task ran yet: a task loop's typical mix prices the tasks, not the planning calls (#1712).
    const rate = rateAt(SONNET, TASK_MIX);
    expect(cost.implementation?.model).toBe(SONNET);
    expect(cost.implementation?.rate).toBe("default");
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
    // Before its first task a plan is priced at what earlier runs' tasks on the model paid (#1792).
    const history: PlanCost = { ...cost, implementation: { ...cost.implementation!, rate: "history" } };
    expect(planCostText(history)).toBe(`${text} at what earlier runs' tasks on it paid per token`);
    expect(desktopPlanCostText(history)).toBe(planCostText(history));
  });

  test("a sized plan forecasts the whole run, not its tasks alone (#1418)", () => {
    // 2M spent on research, spec and plan; two tasks of 1.5M to 2.5M each, so 3M to 5M of tasks.
    const tasks = [{ estimate: { low: 1_500_000, high: 2_500_000 } }, { estimate: { low: 1_500_000, high: 2_500_000 } }];
    const price = taskTotal(tasks.map((t) => t.estimate)).price;
    const verification = verificationTokens();
    const store = makeStore([], {
      model: null,
      tasks,
      taskTokens: { low: 3_000_000, expected: 4_000_000, high: 5_000_000 },
      runTokens: Math.round(2_000_000 + price + verification),
      repairReserve: 500_000,
    });
    const planned = plannedRunTokens(store, runId);
    expect(planned?.low).toBeCloseTo(2_000_000 + verification + 3_000_000, -1);
    expect(planned?.high).toBeCloseTo(2_000_000 + verification + 5_000_000 + 500_000, -1);
    // A report from before `runTokens` gives its tasks alone.
    const old = makeStore([], { model: null, taskTokens: { low: 3_000_000, expected: 4_000_000, high: 5_000_000 } });
    expect(plannedRunTokens(old, runId)).toEqual({ low: 3_000_000, high: 5_000_000 });
    expect(plannedRunTokens(makeStore([]), runId)).toBeNull();
  });
});

// Bench round 42, fecsmith front (#1503): the plan was priced $6.75-$11.29 with planning against
// an $8 cap and a $9.20 ceiling, and its approval said nothing about dollars.
describe("planCostWarning", () => {
  const cost = {
    planning: { usd: 0.9, complete: true, models: [] },
    implementation: { model: "codex/gpt-6-luna", usd: { low: 5.85, high: 10.39 } },
  };
  test("warns when the priced high end passes the cap with its tolerance", () => {
    expect(planCostWarning(cost, 8, 0.15)).toBe(
      "The plan is priced up to $11 with planning, above the run's $8.00 cap with its tolerance: the cost forecast may stop the run before it finishes. Approve a smaller plan, or extend the run's cap.",
    );
  });
  test("is quiet when the cap may grow far enough, when it fits, or when nothing is priced", () => {
    expect(planCostWarning(cost, 8, 0.15, 19)).toBeNull();
    expect(planCostWarning(cost, 12, 0)).toBeNull();
    expect(planCostWarning({ ...cost, implementation: null }, 8, 0)).toBeNull();
    expect(planCostWarning(cost, null, 0)).toBeNull();
    expect(planCostWarning(cost, 8, 0, 9)).toContain("and the $9.00 it may grow to");
  });
});
