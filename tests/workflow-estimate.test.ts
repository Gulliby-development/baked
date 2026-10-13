import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateFit, estimateLines } from "../src/components/workflow/format.js";
import {
  compareWithActual,
  DEFAULT_TASK_RANGE,
  estimateHistory,
  estimatePreRun,
  estimateStart,
  historyStorePaths,
  type PastRun,
  pricesFrom,
  project,
  rangeOf,
  rangeText,
} from "../src/core/workflows/estimate.js";
import { newId } from "../src/core/workflows/store.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const past = (patch: Partial<PastRun> = {}): PastRun => ({
  runId: newId(), status: "completed", tokens: 200000, calls: 20, activeMs: 600000, taskCount: 4,
  stageTokens: { research: 40000, specify: 20000, plan: 30000, analyze: 10000, implement: 80000, review: 20000, converge: 0 },
  taskTokens: 80000, ...patch,
});

describe("ranges from samples", () => {
  test("no samples give no range; one sample is widened; few use the spread; many use the middle half", () => {
    expect(rangeOf([])).toBeNull();
    expect(rangeOf([100000])).toEqual({ low: 70000, high: 140000 });
    expect(rangeOf([10, 30, 20])).toEqual({ low: 10, high: 30 });
    expect(rangeOf([1, 2, 3, 4, 5, 100])).toEqual({ low: 2, high: 5 });
    expect(rangeOf([Number.NaN, -1, 5])).toEqual({ low: 4, high: 7 });
  });
});

describe("estimate before a run starts", () => {
  test("without history it is a generic range and says so", () => {
    const estimate = estimateStart([]);
    expect(estimate.basis).toBe("defaults");
    expect(estimate.samples).toBe(0);
    expect(estimate.tokens.low).toBeGreaterThan(0);
    expect(estimate.tokens.high).toBeGreaterThan(estimate.tokens.low);
    expect(estimate.label).toContain("Estimate:");
    expect(estimate.label).toContain("generic range");
    expect(pricesFrom([]).task).toEqual(DEFAULT_TASK_RANGE);
  });
  test("with history it follows what this project's runs spent per stage and per task", () => {
    const history = [past(), past({ taskCount: 6, taskTokens: 240000, stageTokens: { research: 60000, specify: 30000, plan: 50000, analyze: 20000, implement: 240000, review: 40000 } })];
    const estimate = estimateStart(history);
    expect(estimate.basis).toBe("history");
    expect(estimate.samples).toBe(2);
    // Planning stages alone are known: research 40-60k, specify 20-30k, plan 30-50k, analyze 10-20k.
    expect(estimate.tokens.low).toBeGreaterThanOrEqual(100000);
    expect(estimate.label).toContain("from 2 earlier runs in this project");
    const narrower = estimateStart([past(), past(), past(), past()]);
    expect(narrower.tokens.high - narrower.tokens.low).toBeLessThan(estimate.tokens.high - estimate.tokens.low);
  });
  test("runs that never finished still price the stages they completed", () => {
    const prices = pricesFrom([past({ status: "failed", stageTokens: { research: 90000 }, taskCount: 0, taskTokens: 0 })]);
    expect(prices.stages.research).toEqual({ low: 63000, high: 126000 });
    expect(prices.samples).toBe(1);
    expect(prices.basis).toBe("history");
  });
  test("fit against a budget names the problem and the way out", () => {
    const estimate = { tokens: { low: 150000, high: 500000 }, basis: "history" as const, samples: 3, label: "Estimate: 150k-500k tokens" };
    const preset = (maxTotalTokens: number, checkpointTokens: number | null = null) => ({ maxTotalTokens, maxAgentCalls: 80, maxActiveMs: 3600000, checkpointTokens });
    expect(estimateFit(estimate, preset(400000))).toMatchObject({ warn: true, text: expect.stringContaining("high end is above") });
    expect(estimateFit(estimate, preset(100000))).toMatchObject({ warn: true, text: expect.stringContaining("low end is above") });
    expect(estimateFit(estimate, preset(800000))).toMatchObject({ warn: false, text: expect.stringContaining("fits") });
    expect(estimateFit(estimate, preset(1_000_000_000, 200000))).toMatchObject({ warn: false, text: expect.stringContaining("no token cap") });
  });
});

describe("projection of a running run", () => {
  const stages = (statuses: Record<string, "done" | "running" | "pending">) =>
    ["research", "specify", "plan", "analyze", "implement", "review", "converge"].map((id) => ({ id, status: statuses[id] ?? "pending" }));
  const history = [past(), past(), past()];
  test("after the plan, remaining work is the open tasks times the task cost plus the later stages", () => {
    const base = { history, spentTokens: 100000, activeMs: 600000, maxTokens: 400000 };
    const early = project({ ...base, stages: stages({ research: "done", specify: "done", plan: "done", analyze: "done", implement: "running" }), tasks: { total: 4, done: 0 } });
    const later = project({ ...base, stages: stages({ research: "done", specify: "done", plan: "done", analyze: "done", implement: "running" }), tasks: { total: 4, done: 3 } });
    expect(later.remaining.high).toBeLessThan(early.remaining.high);
    expect(early.total.low).toBe(100000 + early.remaining.low);
    // Task cost is 20k per task in this history; four open tasks plus review and converge.
    expect(early.remaining.low).toBeGreaterThanOrEqual(80000);
    expect(early.label).toContain("Estimate: about");
    expect(early.basis).toBe("history");
  });
  test("burn rate comes from tokens and active minutes, and the budget forecast names a stage", () => {
    const result = project({ history, spentTokens: 120000, activeMs: 600000, maxTokens: 150000, stages: stages({ research: "done", specify: "done", plan: "done", analyze: "done", implement: "running" }), tasks: { total: 5, done: 0 } });
    expect(result.tokensPerMinute).toBe(12000);
    expect(result.minutesLeft).toBe(3);
    expect(result.exhaustsAt.typical).toBe("implement");
    expect(result.exhaustsAt.high).toBe("implement");
    const roomy = project({ history, spentTokens: 120000, activeMs: 600000, maxTokens: 5_000_000, stages: stages({ research: "done", specify: "done", plan: "done", analyze: "done", implement: "running" }), tasks: { total: 5, done: 0 } });
    expect(roomy.exhaustsAt).toEqual({ typical: null, high: null });
  });
  test("the spend inside the running stage is not counted twice, and a very young run has no burn rate", () => {
    const common = { history, spentTokens: 30000, activeMs: 10000, maxTokens: 400000, tasks: null, stages: stages({ research: "running" }) };
    const fresh = project(common);
    const spent = project({ ...common, runningStageSpent: 30000 });
    expect(spent.remaining.low).toBeLessThan(fresh.remaining.low);
    expect(fresh.tokensPerMinute).toBeNull();
    expect(fresh.minutesLeft).toBeNull();
  });
});

describe("estimates in a real run", () => {
  test("every run keeps its starting estimate; later runs learn from earlier ones; completion is compared", async () => {
    const fixture = workflowFixture({ policy: fixturePolicy, tokensPerCall: 3000 });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const complete = async () => {
      const run = await fixture.start();
      for (let i = 0; i < 8; i++) {
        const state = await service.get(run.runId);
        if (state.status === "completed") break;
        if (state.pendingRequestIds.length) await fixture.approve(run.runId);
        else if (state.status === "paused" || state.status === "created") await fixture.resume(run.runId);
        await service.drive(run.runId, new AbortController().signal);
      }
      return run.runId;
    };
    const first = await complete();
    const firstView = readWorkflowView(service, first);
    expect(firstView.estimate.saved).toMatchObject({ basis: "defaults", samples: 0, maxTokens: fixturePolicy.maxTotalTokens });
    expect(firstView.estimate.projection).toBeNull();
    expect(firstView.estimate.comparison?.text).toMatch(/^Estimated .* at the start; actual /);
    expect(firstView.snapshot.status).toBe("completed");

    // The second run is estimated from the first (cache window skipped by a new store read).
    const { readHistory } = await import("../src/core/workflows/estimate.js");
    expect(readHistory(service.store, 0).filter((r) => r.status === "completed")).toHaveLength(1);
    // Each past run names the definition it started from, so the editor can price one workflow.
    expect(readHistory(service.store, 0)[0]?.workflowId).toBe("sdd");
    const second = await complete();
    const saved = readWorkflowView(service, second).estimate.saved!;
    expect(saved.basis).toBe("workflow-history");
    expect(saved.samples).toBe(1);
    // The first run really spent about 3000 tokens per model call, which the new range reflects.
    const actualFirst = firstView.snapshot.tokenUsage;
    expect(saved.tokens.low).toBeLessThan(actualFirst * 2);
    expect(compareWithActual(saved, actualFirst).text).toContain(rangeText(saved.tokens));
  });

  test("start estimates also learn from the stores a policy names in sizing.historyStores", async () => {
    const other = workflowFixture({ policy: fixturePolicy, tokensPerCall: 3000 });
    cleanups.push(other.dispose);
    const run = await other.start();
    for (let i = 0; i < 8; i++) {
      const state = await other.service.get(run.runId);
      if (state.status === "completed") break;
      if (state.pendingRequestIds.length) await other.approve(run.runId);
      else if (state.status === "paused" || state.status === "created") await other.resume(run.runId);
      await other.service.drive(run.runId, new AbortController().signal);
    }
    const here = mkdtempSync(join(tmpdir(), "baked-estimate-"));
    cleanups.push(() => rmSync(here, { recursive: true, force: true }));
    expect(estimateHistory(null, here, { sizing: undefined })).toEqual([]);
    const policy = { sizing: { historyStores: [other.service.workspace, join(here, "missing")] } };
    const history = estimateHistory(null, here, policy, 0);
    expect(history.map((r) => [r.runId, r.source])).toEqual([[run.runId, "shared"]]);
    // A store named twice, or this project's own store, is read once.
    expect(historyStorePaths(here, { sizing: { historyStores: [here, other.service.workspace, `${other.service.workspace}/`] } })).toEqual([
      join(other.service.workspace, ".baked", "workflows.sqlite"),
    ]);
    const estimate = estimatePreRun({ history, workflowId: "sdd", stages: [{ id: "plan", type: "agent", models: [] }], maxTotalTokens: 800000, price: () => null });
    expect(estimate.basis).toBe("workflow-history");
    expect(estimate.label).toContain("from 1 earlier run of sdd, 1 of them from other projects");
  });

  test("a run in progress shows a re-estimate and a forecast the panel can render", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, maxTotalTokens: 40000 }, tokensPerCall: 9000 });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    const view = readWorkflowView(service, run.runId);
    const projection = view.estimate.projection;
    expect(projection).not.toBeNull();
    expect(projection!.total.low).toBeGreaterThanOrEqual(view.snapshot.tokenUsage);
    const lines = estimateLines(view.estimate, view.stages).map((l) => l.text);
    expect(lines[0]).toContain("Estimate: about");
    expect(lines.join("\n")).toContain("Forecast:");
  });
});

test("comparison words match the outcome", () => {
  const saved = { schemaVersion: 1 as const, at: 0, tokens: { low: 100000, high: 200000 }, basis: "history" as const, samples: 2, maxTokens: 400000 };
  expect(compareWithActual(saved, 150000)).toMatchObject({ verdict: "within", text: expect.stringContaining("inside the range") });
  expect(compareWithActual(saved, 50000)).toMatchObject({ verdict: "below", text: expect.stringContaining("below the range") });
  expect(compareWithActual(saved, 250000)).toMatchObject({ verdict: "above", text: expect.stringContaining("above the range") });
});
