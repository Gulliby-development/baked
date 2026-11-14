import { afterEach, describe, expect, test } from "bun:test";
import type { ShareGateRecord } from "../src/core/workflows/initiatives/service.js";
import { forecastSamples } from "../src/core/workflows/stage-price.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { historyFixture, plannedForecastScenario, type Routes } from "./helpers/initiative-planned-forecast.js";

// #2963, R103's Claude track: research, specify, plan, analyze, review and convergence ran on an
// Opus-tier route, the tasks on a Sonnet-tier one. The first features were priced at the history's
// stage ranges, measured on Codex runs whose task loops took most of the tokens, so three quarters
// of the price sat on the cheap task stage: $2.39 per Mtok against $3.32 to $3.90 paid. Here the
// history holds three such Codex runs and two runs of the initiative's own routes, and the price
// at the stage shares those two measured (`routedShare`) is recorded beside the shown one.
const OPUS = "claude-code/claude-opus-4-8";
const SONNET = "claude-code/claude-sonnet-4-6";
const CODEX = "codex/gpt-5.4";
const CLAUDE: Routes = {
  model: OPUS,
  modelRouting: { workflows: { sdd: { stages: { implement: { model: SONNET } } } }, specifyOnSonnet: false },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Dollars per token every attempt of the store's runs paid together, one value per run. */
function paidRates(store: WorkflowStore, runIds: string[]): number[] {
  return runIds.map((runId) => {
    const rows = forecastSamples(store, [runId]).filter((a) => a.costUsd !== null && (a.usedTokens ?? 0) > 0);
    const tokens = rows.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
    return rows.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) / tokens;
  });
}

async function scenario(routedStageShare?: "off" | "shadow" | "on") {
  const histories = [];
  for (const [mix, routes] of [
    [{ taskShare: 0.9 }, { model: CODEX }],
    [{ taskShare: 0.9 }, { model: CODEX }],
    [{ taskShare: 0.9 }, { model: CODEX }],
    [{ taskShare: 0.25, planCache: 0.3 }, CLAUDE],
    [{ taskShare: 0.5, planCache: 0.3 }, CLAUDE],
  ] as const) {
    const history = await historyFixture(2, mix, routes);
    cleanups.push(() => history.dispose());
    histories.push(history);
  }
  const result = await plannedForecastScenario(3, 2, histories.map((h) => h.root), {
    mix: { taskShare: 0.35, planCache: 0.3 }, skeleton: false, routes: CLAUDE, ...(routedStageShare ? { routedStageShare } : {}),
  });
  cleanups.push(() => result.fixture.dispose());
  const claude = histories.slice(3).flatMap((h) => paidRates(h.service.store, h.service.store.history().map((r) => r.runId)));
  const store = result.fixture.service.store;
  const f1 = result.view.features[0]!;
  const gate = result.initiatives
    .events("values")
    .filter((e) => e.type === "feature.share_gate")
    .map((e) => e.payload as ShareGateRecord)
    .find((g) => g.featureId === "f1")!;
  const paid = [...claude, ...paidRates(store, [f1.runId!])];
  return { gate, paid, f1, store };
}

const rate = (usd: { low: number; high: number }, tokens: { low: number; high: number }) => (usd.low + usd.high) / (tokens.low + tokens.high);

describe("scenario: a feature on Opus-tier stages and Sonnet-tier tasks is priced at its routes' stage shares (#2963, R103)", () => {
  test("in shadow, the default, the shown price stays under what the routes paid and the routed one lands within it", async () => {
    const { gate, paid, f1, store } = await scenario();
    expect(f1.state).toBe("accepted");
    // The feature's own run mixes the two routes.
    const models = new Set(forecastSamples(store, [f1.runId!]).map((a) => `${a.stage === "implement" ? "task" : "stage"}:${a.model}`));
    expect(models).toContain(`task:${SONNET}`);
    expect(models).toContain(`stage:${OPUS}`);
    const [low, high] = [Math.min(...paid), Math.max(...paid)];
    const feature = gate.feature;
    const shown = rate(feature.needUsd!, feature.need!);
    const routed = feature.routedShare;
    const shadow = routed ? rate(routed.costUsd, feature.need!) : null;
    const usd = (n: number | null) => (n === null ? "none" : `$${(n * 1e6).toFixed(2)}`);
    console.log(`#2963 scenario: paid ${usd(low)}-${usd(high)} per Mtok, shown ${usd(shown)}, routed shadow ${usd(shadow)}`);
    expect(shown).toBeLessThan(low);
    expect(routed?.mode).toBe("shadow");
    expect(routed?.blendedCostUsd).toEqual(feature.needUsd!);
    expect(shadow!).toBeGreaterThanOrEqual(low);
    expect(shadow!).toBeLessThanOrEqual(high);
  }, 300000);

  test("`on` prices the feature at the routed shares, `off` records none", async () => {
    const shadow = await scenario();
    const on = await scenario("on");
    expect(on.gate.feature.routedShare?.mode).toBe("on");
    expect(on.gate.feature.needUsd!.low).toBeCloseTo(shadow.gate.feature.routedShare!.costUsd.low, 9);
    expect(on.gate.feature.routedShare!.blendedCostUsd!.low).toBeCloseTo(shadow.gate.feature.needUsd!.low, 9);
    const off = await scenario("off");
    expect(off.gate.feature.routedShare).toBeUndefined();
    expect(off.gate.feature.needUsd!.low).toBeCloseTo(shadow.gate.feature.needUsd!.low, 9);
  }, 600000);
});
