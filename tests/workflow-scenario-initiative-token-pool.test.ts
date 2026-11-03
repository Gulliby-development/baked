import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { suggestedExtension } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { startApiServer } from "../src/core/api/server.js";
import {
  expectedChargedGate,
  FIRST_WAVE_HOLD_TEXT,
  type InitiativeView,
  planChargedGate,
  poolGrowthOf,
  type ShareGateRecord,
  type ShareGateView,
  shareShortfall,
} from "../src/core/workflows/initiatives/service.js";
import { chargeHold, poolBoundDecision, refreshedGrowth, stageReserveDecision } from "../src/core/workflows/initiatives/growth.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { STOP_REASONS } from "../src/core/workflows/stop-reasons.js";
import { newId } from "../src/core/workflows/store.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
import { adviceRatio, decisionRatio, HOST_POOL_GROWTHS, type PoolGrowthReason, timePoolExtensionDecision, planCharge, planShareDecision, poolExtensionDecision, poolForecast, tokenPool } from "../src/core/workflows/initiatives/token-pool.js";
import { initiativeActions } from "../src/core/workflows/initiatives/view-model.js";
import { openTrace, replayInitiativeStarts, replayPlanShare, replayPoolBounds, replayPoolGrowth, replayTimePoolGrowth } from "../src/core/workflows/trace.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// Bench round 66, nodepluck (#2042): the shared 30M token pool parked select at 14:40:20 with
// 27.7M used and three features unstarted while the $30 dollar cap had room. Nothing warned while
// the pool still had room, the block named no amount, and the person extended to 38M 3.8 minutes
// after the drive exited, 4.75M more than the initiative used.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const R66 = join(import.meta.dir, "fixtures", "bench-traces", "R66", "nodepluck.sqlite.gz");
const POOL = 30_000_000;

const waiting = (id: string, state: string, tokens: number, low: number, high: number, usd: number, usdLow: number, usdHigh: number) => ({
  id, state: state as "ready", share: { tokens, calls: 108, activeMs: 4_551_768 }, need: { low, high }, shareUsd: usd, needUsd: { low: usdLow, high: usdHigh },
});
const done = (id: string, state = "accepted") => ({ id, state: state as "accepted", share: null, need: null, shareUsd: null, needUsd: null });
/** The `feature.share_gate` park of select (seq 28), as R66 recorded it: no limits, used or pool. */
const r66Park: ShareGateRecord = {
  featureId: "select",
  verdict: "park",
  view: {
    initiativeId: "nodepluck",
    budget: {
      remaining: { tokens: 2_735_837, calls: 271, activeMs: 11_379_420 },
      cost: {
        capUsd: 30, tolerance: 0.25, ceilingUsd: 37.5, spentUsd: 23.06, reservedUsd: 2.39, remainingUsd: 4.55, forecastUsd: 26.82,
        measuredFeatures: 5, forecastBinding: true, forecastMode: "shadow", shareMode: "shadow", forecastNotice: null,
      },
    },
    features: [
      ...["base", "json", "syntax", "path", "eval", "lint"].map((id) => done(id)),
      waiting("select", "ready", 620_710, 792_405, 1_321_645, 1.03, 0.6938, 1.1572),
      done("readcmd", "in_progress"),
      waiting("cli", "waiting", 1_513_388, 1_574_674, 3_222_375, 2.51, 1.3838, 2.8317),
      waiting("docs", "waiting", 601_737, 550_035, 1_281_246, 1, 0.4965, 1.1565),
    ],
  },
  feature: { id: "select", share: { tokens: 620_710, calls: 108, activeMs: 4_551_768 }, need: { low: 792_405, high: 1_321_645 }, shareUsd: 1.03, needUsd: { low: 0.6938, high: 1.1572 } },
};
/** The same park with the pool's limit and used tokens, as a record from #2042 on holds them. */
const withPool = (view: ShareGateView, usedTokens = 27_264_163, cost: Partial<ShareGateView["budget"]["cost"]> = {}): ShareGateView => ({
  ...view,
  budget: {
    ...view.budget,
    cost: { ...view.budget.cost, ...cost },
    limits: { maxTotalTokens: POOL, maxAgentCalls: 400, maxActiveMs: 21_600_000 },
    used: { tokens: usedTokens, calls: 0, activeMs: 0 },
  },
});

describe("scenario: the shared token pool names its amounts and would grow inside the dollar cap (#2042, R66 nodepluck)", () => {
  test("the R66 block names the shortfall, the pool that covers the waiting highs and the dollar room, and its remedy carries the amount", () => {
    const view = withPool(r66Park.view);
    const advice = shareShortfall(view, r66Park.feature);
    expect(advice?.summary).toStartWith("The shared budget is short: select has 611128 tokens available after reserving the other waiting features' low estimates, below its estimate of 792405-1321645.");
    // 181,277 more starts select; 33.1M covers the high ends of select, cli and docs (3.1M more).
    expect(advice?.summary).toContain("select needs 181277 more tokens to start; a pool of 33.1M (33100000 tokens, 3100000 more than 30.0M) covers the high estimates of select, cli, docs.");
    expect(advice?.summary).toContain("The dollar cap has $4.55 left ($23.06 of $30.00 spent, forecast $26.82) and would pay for about 35.5M tokens at $0.85 per million.");
    expect(advice?.message).toEndWith("Raise it with baked workflow initiative extend nodepluck --tokens 33100000.");
    expect(advice?.remedies).toEqual([{ action: "extend", initiativeId: "nodepluck", suggestedTokens: 33_100_000 }]);
    // One key in the TUI and one click in the desktop app.
    expect(tuiRecoveryText(advice?.message ?? "", advice)).toContain("Press B to extend budget (to 33.1M tokens)");
    expect(desktopRecoveryText(advice?.message ?? "", advice)).toContain("Choose Extend to 33.1M tokens");
    // A record from before #2042 has no pool limit: the block keeps its words without an amount.
    expect(shareShortfall(r66Park.view, r66Park.feature)?.message).toEndWith("Raise it with baked workflow initiative extend nodepluck.");
  });

  test("in shadow the host would have extended the R66 pool by 3.1M at the 14:40:20 park, inside the $30 cap", () => {
    expect(poolGrowthOf(r66Park.view, r66Park.feature, POOL)).toMatchObject({ reason: "extend-within-dollars", wouldExtend: true, toTokens: 33_100_000, byTokens: 3_100_000 });
    // At R66's measured $0.85 per million the $30 cap pays for about 35.5M: the cover fits under it.
    expect(poolGrowthOf(withPool(r66Park.view), r66Park.feature)).toMatchObject({ wouldExtend: true, toTokens: 33_100_000 });
  });

  test("it never grows past the dollar cap: tokens-only pools, a forecast past the ceiling and a cap that pays for too few tokens hold", () => {
    // A person who set only --budget-tokens is not affected.
    const tokensOnly = withPool(r66Park.view, undefined, { capUsd: null, ceilingUsd: null, remainingUsd: null, forecastUsd: null });
    expect(shareShortfall(tokensOnly, r66Park.feature)?.remedies[0]?.suggestedTokens).toBe(33_100_000);
    expect(poolGrowthOf(tokensOnly, r66Park.feature)).toMatchObject({ wouldExtend: false, toTokens: null });
    expect(poolGrowthOf(withPool(r66Park.view, undefined, { forecastUsd: 38 }), r66Park.feature)?.wouldExtend).toBe(false);
    expect(poolGrowthOf(withPool(r66Park.view, undefined, { forecastUsd: null }), r66Park.feature)?.wouldExtend).toBe(false);
    // At $1.15 per million the cap pays for 26.0M: too few to start the waiting features.
    expect(poolGrowthOf(withPool(r66Park.view, 20_000_000), r66Park.feature)?.wouldExtend).toBe(false);
    // At $0.92 per million it pays for 32.5M: the extension stops at the cap's tokens, 0.6M short
    // of the highs' cover and still enough for every low estimate.
    expect(poolGrowthOf(withPool(r66Park.view, 25_000_000), r66Park.feature)).toMatchObject({ wouldExtend: true, toTokens: 32_500_000 });
    // A dollar block is not a token park: no pool decision.
    const dollars = withPool(r66Park.view, undefined, { shareMode: "enforce" });
    const priced = { ...r66Park.feature, needUsd: { low: 5, high: 6 } };
    expect(poolGrowthOf(dollars, priced)).toBeNull();
  });

  test("every pool growth the host records is registered with the cap that bounds it, in shadow", () => {
    const inputs = { initiativeId: "x", limitTokens: 10, usedTokens: 5, committedTokens: 5, forecastTokens: 20, ratio: null, features: 1, waiting: [{ id: "a", low: 6, high: 8 }], cost: { capUsd: 30, ceilingUsd: 30, spentUsd: 1, remainingUsd: 29, forecastUsd: 2 } };
    const decision = poolExtensionDecision(inputs, tokenPool(inputs));
    expect(Object.keys(HOST_POOL_GROWTHS)).toContain(decision.reason);
    for (const [reason, growth] of Object.entries(HOST_POOL_GROWTHS)) {
      expect(growth.defaultMode).toBe("shadow");
      // Growing for real is opt-in only where its pull request says so (#2241's stage reserve,
      // #2060's extension inside the dollar cap, which #2488's plan-time share gate shares); making
      // it the default is a pull request of its own.
      if (!["stage-reserve", "extend-within-dollars", "plan-share"].includes(reason)) expect(growth.modes as readonly string[]).not.toContain("on");
      expect(growth.boundBy).toContain("--budget-usd");
    }
    // A started feature run's remaining review and convergence (#2241): bounded by the
    // initiative's dollar cap with its tolerance, recorded as `decision.would_extend` in shadow
    // (tests/workflow-scenario-started-run-stage-reserve.test.ts).
    const stages = stageReserveDecision({ runId: "r", featureId: "get-command", stages: ["review"], stageReserveUsd: 0.3, runSpentUsd: 1.29, runReservedUsd: 0, requestedUsd: 0.02, boundUsd: 1.54, runHeldUsd: 1.54, spareUsd: 0, initiative: { committedUsd: 29.12, capUsd: 30, ceilingUsd: 37.5 } });
    expect(Object.keys(HOST_POOL_GROWTHS)).toContain(stages.reason);
    expect(HOST_POOL_GROWTHS["stage-reserve"].modes).toEqual(["off", "shadow", "on"]);
  });

  test("replay: on the R66 trace the measured forecast warns before the park, and the host would extend at the park", () => {
    const { store, dispose } = openTrace(R66);
    try {
      // The rule before #2042 never extends: the park replays as recorded.
      expect(replayPoolGrowth(store, () => null).flatMap((i) => i.poolGrowth)).toEqual([]);
      const [nodepluck] = replayPoolGrowth(store);
      expect(nodepluck?.poolGrowth).toEqual([{ featureId: "select", seq: 28, recorded: "hold", replayed: "extend", limitTokens: POOL, toTokens: 33_100_000 }]);
      expect(nodepluck?.newPoolGrowth).toBe(1);
      // With extendWithinDollars on (#2060) the host applies this extension: select starts on 33.1M
      // (3.1M more) instead of waiting for the person's 38M; the rule is the same in every mode.
      expect(HOST_POOL_GROWTHS["extend-within-dollars"]).toMatchObject({ modes: ["off", "shadow", "on"], defaultMode: "shadow" });
    } finally {
      dispose();
    }
    // Rewound with the budget and usage of each moment: syntax was accepted at 14:26:58 and lint
    // at 14:39:38 (the trace's run.state_changed events); select parked at 14:40:20.
    const syntax = Date.UTC(2026, 9, 24, 14, 26, 59, 558);
    const lint = Date.UTC(2026, 9, 24, 14, 39, 39, 627);
    const [replay] = replayInitiativeStarts(R66, { budgetAtStart: true, moments: [syntax, lint] });
    const at = (t: number) => replay?.starts.find((s) => s.at === t)?.pool;
    // With three measured features the blend weighs their 2.36x a third: 25.1M, under the pool. The
    // notice advises at the raw ratio (#2062): 31.8M, 13 minutes before select parked.
    expect(at(syntax)).toMatchObject({ limitTokens: POOL, usedTokens: 15_369_363, advice: { forecastTokens: 31_768_074, ratio: 2.36 }, suggestedTokens: 31_800_000 });
    expect(at(syntax)?.forecastTokens).toBeLessThan(POOL);
    expect(at(syntax)?.notice).toStartWith("At the measured 2.4x of the estimates the 10 features need about 31.8M tokens (25.1M at the blended 1.4x that budget decisions use; 15.4M used); the shared pool is 30.0M. Extend to 31.8M");
    // At lint the blend says 1.8x and 31.6M; the raw 2.2x says 33.2M, and the round used 33.25M.
    // The advice is what the $30 cap pays for at the measured rate (#2244), above both.
    expect(at(lint)?.notice).toBe("At the measured 2.2x of the estimates the 10 features need about 33.2M tokens (31.6M at the blended 1.8x that budget decisions use; 26.7M used); the shared pool is 30.0M. Extend to 36.0M, what the $30.00 cap pays for at $0.83 per million, so the pool stops no feature before the dollar cap does (baked workflow initiative extend nodepluck --tokens 36000000).");
    // No start before the third accepted feature warned: the estimate's point forecast stayed under the pool.
    expect(replay?.starts.filter((s) => s.at < syntax && s.pool?.notice)).toEqual([]);
    // Replayed on the final 38M budget, as the corpus gate did before #2061, nothing warns.
    const [final] = replayInitiativeStarts(R66, { budgetAtStart: false });
    expect(final?.starts.some((s) => s.pool?.notice)).toBe(false);
  }, 180000);
});

// Bench round 75, maskback (#2367): the park of maps on a 24.0M pool suggested the 31.5M that
// covers the waiting highs while the same message said the $30 cap pays for about 26.4M; the loop
// read the sentence and extended to 26.4M. The R66 park at other measured rates stands in for it.
describe("scenario: a park on the token pool suggests what the dollar cap pays for (#2367, R75 maskback)", () => {
  const exhausted = { ...r66Park.feature, share: { tokens: 0, calls: 108, activeMs: 4_551_768 } };

  test("a cover above the cap's tokens suggests the cap's tokens, rounded down, in the remedy and the message", () => {
    // At $0.92 per million the $30 cap pays for about 32.5M, below the 33.1M cover.
    const view = withPool(r66Park.view, 25_000_000);
    const advice = shareShortfall(view, r66Park.feature);
    expect(advice?.summary).toContain("covers the high estimates of select, cli, docs.");
    expect(advice?.summary).toContain("would pay for about 32.5M tokens at $0.92 per million, so extend to 32.5M (32500000 tokens).");
    expect(advice?.message).toEndWith("Raise it with baked workflow initiative extend nodepluck --tokens 32500000.");
    expect(advice?.remedies).toEqual([{ action: "extend", initiativeId: "nodepluck", suggestedTokens: 32_500_000 }]);
    expect(tuiRecoveryText(advice?.message ?? "", advice)).toContain("Press B to extend budget (to 32.5M tokens)");
    expect(desktopRecoveryText(advice?.message ?? "", advice)).toContain("Choose Extend to 32.5M tokens");
    // The remedy is the pool the host's own extension would grow to.
    expect(poolGrowthOf(view, r66Park.feature)).toMatchObject({ toTokens: 32_500_000 });
    // The exhausted pool names the same amount.
    const empty = shareShortfall(view, exhausted);
    expect(empty?.summary).toContain("A pool of 33.1M tokens covers the high estimates of the waiting features. The $30.00 cap would pay for about 32.5M tokens at $0.92 per million, so extend to 32.5M (32500000 tokens).");
    expect(empty?.remedies[0]).toMatchObject({ action: "extend", suggestedTokens: 32_500_000 });
    expect(empty?.remedies[0]?.suggestedUsd).toBeUndefined();
  });

  test("when the cap pays for too few tokens to start the waiting features, the remedy raises the cap with the pool", () => {
    // At $1.15 per million the cap pays for about 26.0M, below the 30.0M pool: 33.1M costs $38.17.
    const view = withPool(r66Park.view, 20_000_000);
    const advice = shareShortfall(view, r66Park.feature);
    expect(advice?.summary).toContain("would pay for about 26.0M tokens at $1.15 per million, too few to start the waiting features: a pool of 33.1M also needs a dollar cap of $38.17.");
    expect(advice?.message).toEndWith("Raise it with baked workflow initiative extend nodepluck --tokens 33100000 --budget-usd 38.17.");
    expect(advice?.remedies).toEqual([{ action: "extend", initiativeId: "nodepluck", suggestedTokens: 33_100_000, suggestedUsd: 38.17 }]);
    expect(tuiRecoveryText(advice?.message ?? "", advice)).toContain("Press B to extend budget (to 33.1M tokens and $38.17)");
    const empty = shareShortfall(view, exhausted);
    expect(empty?.summary).toContain("The $30.00 cap would pay for about 26.0M tokens at $1.15 per million, too few to start the waiting features: a pool of 33.1M also needs a dollar cap of $38.17.");
    expect(empty?.remedies[0]).toMatchObject({ suggestedTokens: 33_100_000, suggestedUsd: 38.17 });
  });

  test("a cover the cap pays for, or a pool with no dollar cap, suggests the cover", () => {
    expect(shareShortfall(withPool(r66Park.view), r66Park.feature)?.remedies).toEqual([{ action: "extend", initiativeId: "nodepluck", suggestedTokens: 33_100_000 }]);
    const tokensOnly = withPool(r66Park.view, 20_000_000, { capUsd: null, ceilingUsd: null, remainingUsd: null, forecastUsd: null });
    expect(shareShortfall(tokensOnly, r66Park.feature)?.remedies).toEqual([{ action: "extend", initiativeId: "nodepluck", suggestedTokens: 33_100_000 }]);
    expect(shareShortfall(tokensOnly, exhausted)?.remedies[0]).toMatchObject({ suggestedTokens: 33_100_000 });
  });
});

describe("scenario: a scripted initiative whose features cost more than their estimates (#2042)", () => {
  async function scenario(maxTotalTokens: number, featureUsd: number | Record<string, number>, options: { capUsd?: number | null; extendWithinDollars?: "off" | "shadow" | "on" } = {}) {
    const history = await historyFixture(1, { taskShare: 0.4 });
    cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(5, featureUsd, [history.root], { skeleton: false, maxTotalTokens, ...options });
    cleanups.push(() => result.fixture.dispose());
    const { initiatives, fixture } = result;
    /** Drives until a feature run completes, or the drive stops on its own. */
    const driveOne = async (): Promise<InitiativeView> => {
      const controller = new AbortController();
      const unwatch = fixture.service.store.observe((e) => {
        if (e.type === "run.state_changed" && e.payload.to === "completed") controller.abort();
      });
      try { return await initiatives.drive("values", controller.signal); } finally { unwatch(); }
    };
    const events = (type: string) => initiatives.events("values").filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
    return { ...result, driveOne, events };
  }

  test("the token forecast warns at a share gate that passes, before any park, on every surface", async () => {
    // f2 costs twice its estimate; at f3's start used plus the calibrated need is above the 7M pool.
    const { initiatives, driveOne, events } = await scenario(7_000_000, { f1: 1.2, f2: 2.6, f3: 1.2, f4: 2.6, f5: 2.6 });
    let view = await driveOne();
    expect(view.features.filter((f) => f.state === "accepted").map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(view.next).toMatchObject({ kind: "start", featureId: "f3" });
    expect(view.budget.forecastNotice).toBe(view.budget.pool?.notice ?? "");
    // The $30 cap pays for more than the 7.0M pool: the notice advises what it pays for (#2244).
    expect(view.budget.forecastNotice).toMatch(/^At the estimates so far the 5 features need about 7\.\dM tokens \(2\.9M used\); the shared pool is 7\.0M\. Extend to (\d+\.\d)M, what the \$30\.00 cap pays for at \$\d\.\d\d per million, so the pool stops no feature before the dollar cap does \(baked workflow initiative extend values --tokens \d+\)\.$/);
    const suggested = view.budget.pool?.suggestedTokens ?? 0;
    expect(suggested).toBeGreaterThan(7_000_000);
    // The TUI's B form and the desktop's one-click extend take the suggested pool.
    expect(initiativeActions(view, false).find((a) => a.key === "B")?.input?.initial).toBe(String(suggested));
    expect(suggestedExtension(view)).toEqual({ tokens: suggested });
    view = await driveOne();
    expect(view.features.find((f) => f.id === "f3")?.state).toBe("accepted");
    const gates = events("feature.share_gate") as unknown as ShareGateRecord[];
    expect(gates.map((g) => [g.featureId, g.verdict])).toEqual([["f1", "pass"], ["f2", "pass"], ["f3", "pass"]]);
    expect(gates[2]?.view.budget.pool?.notice).toContain("the shared pool is 7.0M");
    expect(gates[1]?.view.budget.pool?.notice).toBeNull();
    expect(events("budget.forecast_notice")).toEqual([expect.objectContaining({ limitTokens: 7_000_000, suggestedTokens: suggested })]);
    // The CLI prints the same view.
    const shown = (await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "values"]), new AbortController().signal)) as InitiativeView;
    expect(shown.budget.pool).toEqual(initiatives.view("values").budget.pool);
  }, 120000);

  test("a park on the pool records the shadow extension with its inputs and leaves the pool as the person set it", async () => {
    // Every feature costs 2.2 times the history's: f3's low no longer fits the 8.6M pool.
    const { initiatives, fixture, driveOne, events } = await scenario(8_600_000, 2.2);
    await driveOne();
    let view = await initiatives.drive("values", new AbortController().signal);
    expect(view.next).toMatchObject({ kind: "blocked", featureId: "f3" });
    expect(view.next.message).toContain("f3 needs 801705 more tokens to start; a pool of 9.5M (9500000 tokens, 900000 more than 8.6M) covers the high estimates of f3, f4, f5.");
    expect(view.next.recovery?.remedies[0]).toEqual({ action: "extend", initiativeId: "values", suggestedTokens: 9_500_000 });
    expect(initiativeActions(view, false).find((a) => a.key === "B")?.input?.initial).toBe("9500000");
    const park = (events("feature.share_gate") as unknown as ShareGateRecord[]).find((g) => g.verdict === "park");
    expect(park?.poolGrowth).toEqual({ mode: "shadow", wouldExtend: true, toTokens: 9_500_000, byTokens: 900_000 });
    expect(park?.view.budget.limits?.maxTotalTokens).toBe(8_600_000);
    const [extend] = events("decision.would_extend");
    expect(extend).toMatchObject({ reason: "extend-within-dollars", mode: "shadow", featureId: "f3", toTokens: 9_500_000, byTokens: 900_000 });
    expect(extend?.inputs).toMatchObject({ limitTokens: 8_600_000, waiting: [{ id: "f3" }, { id: "f4" }, { id: "f5" }], cost: { capUsd: 30 } });
    expect(String(extend?.summary)).toEndWith("f3 would start.");
    // Every growth the host records is registered with the cap that bounds it.
    for (const event of events("decision.would_extend")) expect(Object.keys(HOST_POOL_GROWTHS)).toContain(String(event.reason));
    // Shadow changes nothing: the pool, the parked feature and the next step stay.
    view = await initiatives.drive("values", new AbortController().signal);
    expect(view.budget.limits.maxTotalTokens).toBe(8_600_000);
    expect(view.features.find((f) => f.id === "f3")?.runId).toBeNull();
    expect(events("decision.would_extend")).toHaveLength(1);
    // The desktop reads the same view through the local API.
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => { await server.stop(); });
    const response = await fetch(`${server.url}/v1/initiatives/values`, { headers: { Authorization: `Bearer ${server.token}` } });
    const served = (await response.json()) as InitiativeView;
    expect(served.next.recovery).toEqual(view.next.recovery);
    expect(suggestedExtension(served)).toEqual({ tokens: 9_500_000 });
    // Extending to the suggested amount starts f3.
    view = await initiatives.extendBudget("values", { commandId: "extend-to-suggested", expectedRevision: view.revision }, { maxTotalTokens: 9_500_000 });
    expect(view.next).toMatchObject({ kind: "start", featureId: "f3" });
  }, 120000);

  test("with extendWithinDollars on the host grows the pool inside the dollar cap and the parked feature starts (#2060)", async () => {
    const { initiatives, driveOne, events } = await scenario(8_600_000, 2.2, { extendWithinDollars: "on" });
    await driveOne();
    const view = await driveOne();
    // The same park as in shadow, decided the same way, and applied: f3 starts on the host's 9.5M.
    const park = (events("feature.share_gate") as unknown as ShareGateRecord[]).find((g) => g.verdict === "park");
    expect(park?.featureId).toBe("f3");
    expect(park?.poolGrowth).toEqual({ mode: "on", wouldExtend: true, toTokens: 9_500_000, byTokens: 900_000 });
    const decided = park ? poolGrowthOf(park.view, park.feature) : null;
    const extended = events("budget.extended").filter((e) => e.by === "host");
    expect(extended).toHaveLength(1);
    expect(extended[0]).toMatchObject({ by: "host", reason: "extend-within-dollars", featureId: "f3", previous: { maxTotalTokens: 8_600_000 }, next: { maxTotalTokens: decided?.toTokens }, toTokens: 9_500_000, byTokens: 900_000 });
    expect(extended[0]?.inputs).toMatchObject({ limitTokens: 8_600_000, waiting: [{ id: "f3" }, { id: "f4" }, { id: "f5" }], cost: { capUsd: 30 } });
    expect(String(extended[0]?.summary)).toEndWith("f3 starts.");
    // Every host growth is registered with the cap that bounds it, and its mode allows `on`.
    expect(HOST_POOL_GROWTHS[extended[0]?.reason as PoolGrowthReason].modes).toContain("on");
    // It never raised a dollar, call or time limit, and recorded no would-extend beside it.
    expect(extended[0]?.next).toMatchObject({ maxAgentCalls: (extended[0]?.previous as { maxAgentCalls: number }).maxAgentCalls, maxActiveMs: (extended[0]?.previous as { maxActiveMs: number }).maxActiveMs });
    expect(view.budget.cost.capUsd).toBe(30);
    expect(view.budget.limits.maxTotalTokens).toBe(9_500_000);
    expect(view.features.find((f) => f.id === "f3")?.runId).not.toBeNull();
    expect(events("decision.would_extend").filter((e) => e.reason === "extend-within-dollars")).toEqual([]);
  }, 120000);

  test("with extendWithinDollars on a first-wave park records that the host waits for a measurement and names the manual extend (#2471, R79 deltaglue)", async () => {
    // The 2.0M pool is below the 2.73M the five lows sum to: f1 parks at the first gate, before
    // any feature is accepted, so there is no measured dollar forecast for `on` to act on.
    const { initiatives, fixture, events } = await scenario(2_000_000, 2.2, { extendWithinDollars: "on" });
    const view = await initiatives.drive("values", new AbortController().signal);
    expect(view.next).toMatchObject({ kind: "blocked", featureId: "f1" });
    expect(view.budget.cost.measuredFeatures).toBe(0);
    const park = (events("feature.share_gate") as unknown as ShareGateRecord[]).find((g) => g.verdict === "park");
    expect(park?.poolGrowth).toEqual({ mode: "on", hold: "no measurement", wouldExtend: false, toTokens: null, byTokens: null });
    expect(events("budget.extended").filter((e) => e.by === "host")).toEqual([]);
    expect(view.budget.limits.maxTotalTokens).toBe(2_000_000);
    // The park message names the extend command, then why the host did not make it.
    const hold = "extendWithinDollars: on waits for the first accepted feature's measured dollar forecast before the host grows the pool, so extend by hand with the command named here.";
    expect(view.next.message).toContain("Raise it with baked workflow initiative extend values --tokens 5500000.");
    expect(view.next.message).toEndWith(hold);
    expect(view.next.recovery?.summary).toEndWith(hold);
    expect(view.next.recovery?.remedies[0]).toEqual({ action: "extend", initiativeId: "values", suggestedTokens: 5_500_000 });
    // The forecast notice, which names its own extend, says the same.
    expect(view.budget.forecastNotice).toContain("(baked workflow initiative extend values --tokens");
    expect(view.budget.forecastNotice).toEndWith(hold);
    // Every surface reads the same text: the TUI and the desktop render the message, the CLI and
    // the local API serve the view.
    expect(tuiRecoveryText(view.next.message, view.next.recovery)).toContain(hold);
    expect(desktopRecoveryText(view.next.message, view.next.recovery)).toContain(hold);
    const shown = (await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "values"]), new AbortController().signal)) as InitiativeView;
    expect(shown.next.message).toEndWith(hold);
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => { await server.stop(); });
    const response = await fetch(`${server.url}/v1/initiatives/values`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(((await response.json()) as InitiativeView).next.recovery?.summary).toEndWith(hold);
    // In shadow the park records the same hold, and its message names no `on` it does not run in.
    const shadow = await scenario(2_000_000, 2.2, { extendWithinDollars: "shadow" });
    const shadowView = await shadow.initiatives.drive("values", new AbortController().signal);
    const shadowPark = (shadow.events("feature.share_gate") as unknown as ShareGateRecord[]).find((g) => g.verdict === "park");
    expect(shadowPark?.poolGrowth).toEqual({ mode: "shadow", hold: "no measurement", wouldExtend: false, toTokens: null, byTokens: null });
    expect(shadowView.next.message).not.toContain("extendWithinDollars");
  });

  test("with extendWithinDollars off, or with only a token pool, a park records no extension", async () => {
    for (const options of [{ extendWithinDollars: "off" as const }, { capUsd: null }]) {
      const { initiatives, driveOne, events } = await scenario(8_600_000, 2.2, options);
      await driveOne();
      const view = await initiatives.drive("values", new AbortController().signal);
      expect(view.next).toMatchObject({ kind: "blocked", featureId: "f3" });
      expect(view.next.recovery?.remedies[0]?.suggestedTokens).toBe(9_500_000);
      const park = (events("feature.share_gate") as unknown as ShareGateRecord[]).find((g) => g.verdict === "park");
      expect(park?.poolGrowth?.wouldExtend ?? false).toBe(false);
      expect(events("decision.would_extend")).toEqual([]);
    }
  }, 240000);
});

describe("scenario: an open feature run with a sized plan is charged at its plan's need (#2100, #2056)", () => {
  /** f1 accepted, f2's run open with its plan sized and its tasks started. */
  async function sized(mode?: "shadow" | "enforce", planChargeExpected?: "off" | "shadow" | "on") {
    const history = await historyFixture(1, { taskShare: 0.4 });
    cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(5, 1, [history.root], { skeleton: false, maxTotalTokens: 30_000_000, ...(mode ? { stopModes: { "initiative-plan-charge": mode } } : {}), ...(planChargeExpected ? { planChargeExpected } : {}) });
    cleanups.push(() => result.fixture.dispose());
    const { initiatives, fixture } = result;
    const driveUntil = async (stop: (type: string) => boolean): Promise<void> => {
      const controller = new AbortController();
      const unwatch = fixture.service.store.observe((e) => { if (stop(e.type)) controller.abort(); });
      try { await initiatives.drive("values", controller.signal); } finally { unwatch(); }
    };
    await driveUntil((type) => type === "task.state_changed");
    const events = () => initiatives.events("values").filter((e) => e.type === "decision.would_release").map((e) => e.payload as Record<string, unknown>);
    return { ...result, driveUntil, events };
  }

  test("in shadow the pool keeps holding f2's run limit and a would_release event records what its plan frees", async () => {
    const { initiatives, driveUntil, events } = await sized("shadow");
    const view = initiatives.view("values");
    const f2 = view.features.find((f) => f.id === "f2");
    const charge = view.budget.planCharge;
    expect(charge).toMatchObject({ mode: "shadow", ratio: null, runs: [{ featureId: "f2", runId: f2?.runId }] });
    const run = charge?.runs[0];
    // One accepted feature measures no ratio: the charge is the plan's own high end.
    expect(run?.chargeTokens).toBe(Math.max(run?.usedTokens ?? 0, run?.plan.high ?? 0));
    expect(run?.chargeTokens).toBeLessThan(run?.limitTokens ?? 0);
    expect(charge?.releasedTokens).toBe((run?.limitTokens ?? 0) - (run?.chargeTokens ?? 0));
    expect(charge?.planCommittedTokens).toBe((charge?.limitCommittedTokens ?? 0) - (charge?.releasedTokens ?? 0));
    // Shadow: committed, reserved and remaining are what they were before #2100.
    expect(view.budget.pool?.committedTokens).toBe(charge?.limitCommittedTokens);
    expect(view.budget.remaining.tokens).toBe(30_000_000 - (charge?.limitCommittedTokens ?? 0));
    expect(view.budget.reserved.tokens).toBe((charge?.limitCommittedTokens ?? 0) - view.budget.used.tokens);
    // #2124: in dollars the run is held at its plan's tokens at f1's task-call rate, never below
    // what it spent and reserved, instead of its dollar cap; in shadow the remaining dollars stay.
    const usd = charge?.usd;
    expect(usd?.taskRate).toBeGreaterThan(0);
    expect(run?.chargeUsd).toBeCloseTo(Math.max(run?.usedUsd ?? 0, (run?.chargeTokens ?? 0) * (usd?.taskRate ?? 0)), 9);
    expect(run?.chargeUsd).toBeLessThan(run?.limitUsd ?? 0);
    expect(usd?.releasedUsd).toBeCloseTo((run?.limitUsd ?? 0) - (run?.chargeUsd ?? 0), 9);
    expect(view.budget.cost.remainingUsd).toBe(Math.floor((30 - (usd?.limitCommittedUsd ?? 0)) * 100) / 100);
    // The next drive records it once per run and plan, before it drives the run on.
    await driveUntil(() => true);
    await driveUntil(() => true);
    expect(events()).toEqual([expect.objectContaining({
      reason: "initiative-plan-charge", mode: "shadow", featureId: "f2", key: `run-${f2?.runId}-${run?.plan.high}`,
      releasedTokens: charge?.releasedTokens, wouldStart: false, wouldPark: false,
    })]);
    expect(events()[0]?.releasedUsd).toBeGreaterThan(0);
    expect(events()[0]?.usd).toMatchObject({ taskRate: usd?.taskRate });
    expect(String(events()[0]?.summary)).toMatch(/^f2's plan prices its run at [\d.]+[kM] tokens \([\d.]+[kM] used\): holding that instead of its [\d.]+M limit frees [\d.]+M tokens of the pool\. In dollars it holds \$[\d.]+ at the task-call rate instead of \$[\d.]+, which frees \$[\d.]+ of the dollar budget\.$/);
  }, 120000);

  test("with stopModes unset (enforce since #2245) the pool holds f2 at its plan charge, never below what it used, and the run still finishes", async () => {
    // The promotion: no stopModes entry enforces the charge, as `"enforce"` did before.
    const { initiatives, events, driveUntil } = await sized();
    const view = initiatives.view("values");
    const charge = view.budget.planCharge;
    expect(charge?.mode).toBe("enforce");
    expect(charge?.releasedTokens).toBeGreaterThan(0);
    expect(view.budget.pool?.committedTokens).toBe(charge?.planCommittedTokens);
    expect(view.budget.remaining.tokens).toBe(30_000_000 - (charge?.planCommittedTokens ?? 0));
    expect(view.budget.reserved.tokens).toBeGreaterThanOrEqual(0);
    for (const run of charge?.runs ?? []) expect(run.chargeTokens).toBeGreaterThanOrEqual(run.usedTokens);
    // #2124: the dollar budget holds f2 at its plan charge in dollars too.
    expect(charge?.usd?.releasedUsd).toBeGreaterThan(0);
    expect(view.budget.cost.remainingUsd).toBe(Math.floor((30 - (charge?.usd?.planCommittedUsd ?? 0)) * 100) / 100);
    for (const run of charge?.runs ?? []) expect(run.chargeUsd).toBeGreaterThanOrEqual(run.usedUsd ?? 0);
    // The waiting features share what the charge leaves: more than under the run's limit.
    const share = (v: InitiativeView) => v.features.filter((f) => f.share).reduce((n, f) => n + (f.share?.tokens ?? 0), 0);
    expect(share(view)).toBe(view.budget.remaining.tokens);
    expect(share(view)).toBeGreaterThan(30_000_000 - (charge?.limitCommittedTokens ?? 0));
    // Enforced, nothing is recorded as would-be.
    await driveUntil((type) => type === "run.state_changed");
    expect(events()).toEqual([]);
    const done = await initiatives.drive("values", new AbortController().signal);
    expect(done.features.find((f) => f.id === "f2")?.state).toBe("accepted");
  }, 180000);
  // #2534: before a ratio is measured, `planChargeExpected` decides the plan point the pool holds.
  test("planChargeExpected shadow (the default) holds f2 at its plan's high end and records the charge at its expected need beside it", async () => {
    const { initiatives } = await sized();
    const charge = initiatives.view("values").budget.planCharge;
    const run = charge?.runs[0];
    const plan = run?.plan;
    expect(plan?.expected).toBeLessThan(plan?.high ?? 0);
    expect(charge?.point).toBeUndefined();
    expect(run?.chargeTokens).toBe(Math.max(run?.usedTokens ?? 0, plan?.high ?? 0));
    const expected = charge?.expected;
    expect(expected).toMatchObject({ mode: "enforce", ratio: null, point: "expected" });
    expect(expected?.runs[0]?.chargeTokens).toBe(Math.max(run?.usedTokens ?? 0, plan?.low ?? 0, plan?.expected ?? 0));
    expect(expected?.planCommittedTokens).toBeLessThan(charge?.planCommittedTokens ?? 0);
    // Shadow: the pool holds the high end.
    expect(initiatives.view("values").budget.pool?.committedTokens).toBe(charge?.planCommittedTokens);
  }, 120000);

  test("planChargeExpected on holds f2 at its plan's expected need, never below what it used, and the run still finishes", async () => {
    const { initiatives } = await sized(undefined, "on");
    const view = initiatives.view("values");
    const charge = view.budget.planCharge;
    const run = charge?.runs[0];
    expect(charge).toMatchObject({ mode: "enforce", ratio: null, point: "expected" });
    expect(charge?.expected).toBeUndefined();
    expect(run?.chargeTokens).toBe(Math.max(run?.usedTokens ?? 0, run?.plan.low ?? 0, run?.plan.expected ?? 0));
    expect(run?.chargeTokens).toBeLessThan(run?.plan.high ?? 0);
    expect(view.budget.pool?.committedTokens).toBe(charge?.planCommittedTokens);
    expect(view.budget.remaining.tokens).toBe(30_000_000 - (charge?.planCommittedTokens ?? 0));
    const done = await initiatives.drive("values", new AbortController().signal);
    expect(done.features.find((f) => f.id === "f2")?.state).toBe("accepted");
  }, 180000);

  test("planChargeExpected off holds the high end and records nothing beside it", async () => {
    const { initiatives } = await sized(undefined, "off");
    const charge = initiatives.view("values").budget.planCharge;
    expect(charge?.point).toBeUndefined();
    expect(charge?.expected).toBeUndefined();
    expect(charge?.runs[0]?.chargeTokens).toBe(Math.max(charge?.runs[0]?.usedTokens ?? 0, charge?.runs[0]?.plan.high ?? 0));
  }, 120000);
});

// Bench round 67, ampwhy (#2100): 11 features, planAhead, 3 slots. The split's warning made the
// loop extend the 30M pool to 38,579,615; the initiative used 12.2M. At cli's gate the pool held
// 30.5M for runs that had used 0.05M to 6.6M each, because an open run counts at its limit (its
// start share: base 4.90M, reader 4.85M, codecs, checking and cli 6.31M, decode-explain and
// other-commands 3.73M) while the planned-ahead runs' own plans expected 0.37M to 2.1M. The R67
// trace is not in the corpus: the gate below is rebuilt from the issue's figures, the open runs at
// their class shares and the accepted features at the rest of the recorded 30.5M.
describe("scenario: R67 ampwhy's gates with open runs held at their plan's need (#2100, R66 nodepluck)", () => {
  const ratio = 1.19;
  const openRuns = [
    { featureId: "reader", runId: "r-reader", usedTokens: 3_100_000, limitTokens: 4_850_000, plan: { low: 1_600_000, expected: 2_000_000, high: 2_900_000 } },
    { featureId: "codecs", runId: "r-codecs", usedTokens: 900_000, limitTokens: 6_310_000, plan: { low: 450_000, expected: 630_000, high: 950_000 } },
    { featureId: "checking", runId: "r-checking", usedTokens: 300_000, limitTokens: 6_310_000, plan: { low: 250_000, expected: 370_000, high: 600_000 } },
    { featureId: "decode-explain", runId: "r-decode", usedTokens: 50_000, limitTokens: 3_730_000, plan: { low: 800_000, expected: 1_100_000, high: 1_700_000 } },
    { featureId: "other-commands", runId: "r-other", usedTokens: 1_400_000, limitTokens: 3_730_000, plan: { low: 700_000, expected: 1_000_000, high: 1_500_000 } },
  ];
  const acceptedUsed = 30_500_000 - openRuns.reduce((n, r) => n + r.limitTokens, 0);
  const usedTokens = acceptedUsed + openRuns.reduce((n, r) => n + r.usedTokens, 0);
  const calls = { calls: 120, activeMs: 3_600_000 };
  /** cli's gate under a pool of `limit`, as `view()` computes it in `mode`. */
  const cliGate = (limit: number, mode: "shadow" | "enforce", priced = openRuns): ShareGateView => {
    const charge = planCharge(mode, ratio, 30_500_000, priced);
    const committed = mode === "enforce" ? (charge?.planCommittedTokens ?? 0) : 30_500_000;
    const remaining = Math.max(0, limit - committed);
    // cli and docs wait; their token shares split what remains by their high ends.
    const cliTokens = Math.floor((remaining * 6_310_000) / (6_310_000 + 1_200_000));
    return {
      initiativeId: "ampwhy",
      budget: {
        remaining: { tokens: remaining, calls: 400, activeMs: 10_000_000 },
        cost: { capUsd: null, tolerance: 0, ceilingUsd: null, spentUsd: 9.4, reservedUsd: 0, remainingUsd: null, forecastUsd: null, measuredFeatures: 4, forecastBinding: false, forecastMode: "enforce", shareMode: "shadow", forecastNotice: null },
        limits: { maxTotalTokens: limit, maxAgentCalls: 1000, maxActiveMs: 21_600_000 },
        used: { tokens: usedTokens, calls: 0, activeMs: 0 },
        planCharge: charge,
      },
      features: [
        ...["values", "entities", "base", "scanning"].map((id) => done(id)),
        ...openRuns.map((r) => done(r.featureId, "in_progress")),
        { id: "cli", state: "ready", share: { tokens: cliTokens, ...calls }, need: { low: 2_200_000, high: 6_310_000 } },
        { id: "docs", state: "waiting", share: { tokens: remaining - cliTokens, ...calls }, need: { low: 500_000, high: 1_200_000 } },
      ],
    };
  };
  const cli = (view: ShareGateView) => {
    const feature = view.features.find((f) => f.id === "cli");
    return { id: "cli", share: feature?.share ?? null, need: feature?.need ?? null, shareUsd: null };
  };

  test("the charge is each plan's high end at the measured ratio, never below used: 13.4M against 30.5M at the limits", () => {
    const charge = planCharge("shadow", ratio, 30_500_000, openRuns);
    // reader used more than its plan's high end: it is held at its use.
    expect(charge?.runs.map((r) => [r.featureId, r.chargeTokens])).toEqual([
      ["reader", 3_100_000], ["codecs", 950_000], ["checking", 600_000], ["decode-explain", 1_700_000], ["other-commands", 1_500_000],
    ]);
    expect(charge?.planCommittedTokens).toBe(acceptedUsed + 7_850_000);
    expect(charge?.releasedTokens).toBe(17_080_000);
    // A plan whose expected tokens at the ratio pass its high end is held there (#2043's need).
    expect(planCharge("shadow", 3, 0, [{ ...openRuns[2]!, usedTokens: 0 }])?.runs[0]?.chargeTokens).toBe(1_110_000);
  });

  test("shadow: under the 30M pool the limits park cli, and the charged gate would start it", () => {
    const view = cliGate(30_000_000, "shadow");
    expect(view.budget.remaining.tokens).toBe(0);
    expect(shareShortfall(view, cli(view))?.summary).toStartWith("The shared budget is exhausted: cli would start with 0 tokens");
    const charged = planChargedGate(view);
    expect(charged?.budget.remaining.tokens).toBe(30_000_000 - (acceptedUsed + 7_850_000));
    expect(charged?.budget.pool).toBeUndefined();
    expect(shareShortfall(charged as ShareGateView, cli(charged as ShareGateView))).toBeNull();
    // The 38.6M extension the loop made started cli at the limits too: the charge was what it bought.
    const extended = cliGate(38_579_615, "shadow");
    expect(shareShortfall(extended, cli(extended))).toBeNull();
  });

  test("enforce: cli starts under the 30M pool, and the gate needs no charged view", () => {
    const view = cliGate(30_000_000, "enforce");
    expect(view.budget.remaining.tokens).toBe(30_000_000 - (acceptedUsed + 7_850_000));
    expect(shareShortfall(view, cli(view))).toBeNull();
    expect(planChargedGate(view)).toBeNull();
  });

  test("#2056: a plan priced above its run's limit adds tokens, and can park a feature the limits start", () => {
    // Only decode-explain's plan is sized, at 4.5M-6.0M: above its 3.73M limit, the charge holds
    // 2.27M more; the other open runs keep their limits.
    const decode = { ...openRuns[3]!, plan: { low: 4_500_000, expected: 5_000_000, high: 6_000_000 } };
    const charge = planCharge("shadow", ratio, 30_500_000, [decode]);
    expect(charge?.runs[0]?.chargeTokens).toBe(6_000_000);
    expect(charge?.releasedTokens).toBe(-2_270_000);
    // Under a 33.5M pool the limits leave 3.0M and start cli; the charge leaves 0.73M.
    const gate = cliGate(33_500_000, "shadow", [decode]);
    expect(shareShortfall(gate, cli(gate))).toBeNull();
    const charged = planChargedGate(gate) as ShareGateView;
    expect(charged.budget.remaining.tokens).toBe(730_000);
    expect(shareShortfall(charged, cli(charged))?.summary).toStartWith("The shared budget is short: cli has 230000 tokens available");
    // Enforced, the pool reserves the plan and cli waits for an extension.
    const enforced = cliGate(33_500_000, "enforce", [decode]);
    expect(enforced.budget.remaining.tokens).toBe(730_000);
    expect(shareShortfall(enforced, cli(enforced))?.remedies[0]?.action).toBe("extend");
  });

  test("R66 nodepluck: at select's park readcmd's plan frees 33k, select still parks and the block names its amount", () => {
    // At the 14:40:20 park readcmd had used 5,320,506 of a limit of 5,793,784 (the recorded
    // committed less what the other runs used), and its plan prices it at 5,760,667: the pool was
    // short for use, not for reservations.
    const readcmd = { featureId: "readcmd", runId: "r-readcmd", usedTokens: 5_320_506, limitTokens: 5_793_784, plan: { low: 4_100_000, expected: 4_500_000, high: 5_760_667 } };
    const view = withPool(r66Park.view, 26_790_885);
    const charge = planCharge("shadow", null, POOL - view.budget.remaining.tokens, [readcmd]);
    expect(charge?.releasedTokens).toBe(33_117);
    const charged = planChargedGate({ ...view, budget: { ...view.budget, planCharge: charge } }) as ShareGateView;
    const select = { ...r66Park.feature, share: charged.features.find((f) => f.id === "select")?.share ?? null };
    const advice = shareShortfall(charged, select);
    expect(advice?.summary).toStartWith("The shared budget is short: select has 644245 tokens available after reserving the other waiting features' low estimates");
    expect(advice?.summary).toContain("select needs 148160 more tokens to start; a pool of 33.1M");
    expect(advice?.remedies).toEqual([{ action: "extend", initiativeId: "nodepluck", suggestedTokens: 33_100_000 }]);
  });
});

describe("scenario: the notice advises at the measured ratio, decisions keep the blend (#2062)", () => {
  // Three accepted features used twice their 1M lows; three wait at 1M lows each.
  const features = [
    ...["f1", "f2", "f3"].map((id) => ({ id, accepted: true, skeleton: false, spent: 2_000_000, low: 1_000_000, expected: 1_500_000 })),
    ...["f4", "f5", "f6"].map((id) => ({ id, accepted: false, skeleton: false, spent: 0, low: 1_000_000, expected: 1_500_000 })),
  ];
  const inputs = (forecast: NonNullable<ReturnType<typeof poolForecast>>, advice: boolean) => ({
    initiativeId: "values",
    limitTokens: 11_000_000,
    usedTokens: 6_000_000,
    committedTokens: 6_000_000,
    forecastTokens: forecast.forecastTokens,
    ratio: forecast.ratio,
    ...(advice ? { advice: forecast.advice } : {}),
    features: 6,
    waiting: ["f4", "f5", "f6"].map((id) => ({ id, low: 1_000_000, high: 2_000_000 })),
    cost: { capUsd: null, ceilingUsd: null, spentUsd: 0, remainingUsd: null, forecastUsd: null },
  });

  test("three measured features at 2x warn although the blend still fits the pool", () => {
    // The blend weighs the measured 2x a third at three features: 1.33x.
    expect(decisionRatio(6_000_000, 3_000_000, 3)).toBeCloseTo(4 / 3, 9);
    expect(adviceRatio(6_000_000, 3_000_000, 3)).toBe(2);
    expect(adviceRatio(6_000_000, 3_000_000, 2)).toBeNull();
    const forecast = poolForecast(6_000_000, features);
    expect(forecast).toEqual({ forecastTokens: 10_000_000, ratio: 1.33, advice: { forecastTokens: 12_000_000, ratio: 2 } });
    const pool = tokenPool(inputs(forecast!, true));
    expect(pool.notice).toBe("At the measured 2.0x of the estimates the 6 features need about 12.0M tokens (10.0M at the blended 1.3x that budget decisions use; 6.0M used); the shared pool is 11.0M. Extend to 12.0M (baked workflow initiative extend values --tokens 12000000).");
    expect(pool.suggestedTokens).toBe(12_000_000);
    // What a block or a park reads keeps the blend: the forecast fits, nothing is suggested.
    expect(pool.forecastTokens).toBe(10_000_000);
    expect(tokenPool(inputs(forecast!, false))).toMatchObject({ notice: null, suggestedTokens: null, advice: null });
  });

  test("the advice ratio is capped like the blend", () => {
    expect(adviceRatio(60_000_000, 3_000_000, 3)).toBe(5);
  });
});

// Bench round 73, flatelens (#2280): commands started with 28.54M of the 34.2M pool used and
// $25.34 of the $30 cap spent (20 percent tolerance, $36 ceiling). Its plan was charged 31.20M
// tokens and $24.08 (enforced plan charge, #2100), its growth bounds were raised to that charge,
// and it used 12.92M: the initiative ended at 41.45M of its 34.2M pool, 21 percent over.
describe("scenario: flatelens R73 commands' bounds stay inside the pool and the ceiling (#2280)", () => {
  const LIMIT = 34_200_000;
  const OTHERS = 28_540_000;
  const CHARGE = 31_200_000;
  const base: RunPolicy = { ...fixturePolicy, sizing: { maxRunTokens: 40_000_000, extendToTokens: 60_000_000 } };
  const commands: RunPolicy = { ...fixturePolicy, maxTotalTokens: 4_650_000, maxCostUsd: 3.82, sizing: { maxRunTokens: 4_650_000, extendToTokens: 4_650_000, maxRunCostUsd: 3.82 } };
  /** commands' bounds after a refresh with `held` and the room the pool and cap leave (none). */
  const refreshed = (held: { tokens: number; usd: number }) =>
    refreshedGrowth(commands, base, { ...held, calls: 0, activeMs: 0 }, { calls: 0, activeMs: 0 }, { tokens: 0, usd: 0, calls: 0, activeMs: 0 });

  test("a charge above the pool raises the bounds no further than the 5.66M the pool has left", () => {
    const hold = chargeHold({ charge: { tokens: CHARGE, usd: null }, own: { usedTokens: 0, usedUsd: 0 }, pool: { limitTokens: LIMIT, othersTokens: OTHERS, waitingLowTokens: 0 }, dollars: null });
    expect(hold).toMatchObject({ tokens: LIMIT - OTHERS, cappedTokens: true });
    const after = refreshed({ tokens: hold.tokens, usd: 3.82 });
    expect(after?.sizing?.maxRunTokens).toBe(5_660_000);
    expect(after?.sizing?.extendToTokens).toBe(5_660_000);
    // The rule before #2280 held the charge: the run could take 31.2M with 5.66M left.
    expect(refreshed({ tokens: CHARGE, usd: 3.82 })?.sizing?.maxRunTokens).toBe(CHARGE);
    // The waiting features' lows come out of it too, and a run never holds less than it used.
    expect(chargeHold({ charge: { tokens: CHARGE, usd: null }, own: { usedTokens: 0, usedUsd: 0 }, pool: { limitTokens: LIMIT, othersTokens: OTHERS, waitingLowTokens: 1_000_000 }, dollars: null }).tokens).toBe(4_660_000);
    expect(chargeHold({ charge: { tokens: CHARGE, usd: null }, own: { usedTokens: 7_000_000, usedUsd: 0 }, pool: { limitTokens: LIMIT, othersTokens: OTHERS, waitingLowTokens: 0 }, dollars: null }).tokens).toBe(7_000_000);
  });

  test("a dollar charge above the ceiling raises the dollar bound no further than the ceiling leaves after the others", () => {
    // $4.66 left under the $30 cap, $10.66 under the $36 ceiling; the charge was $24.08.
    const hold = chargeHold({ charge: { tokens: CHARGE, usd: 24.08 }, own: { usedTokens: 0, usedUsd: 0 }, pool: { limitTokens: LIMIT, othersTokens: OTHERS, waitingLowTokens: 0 }, dollars: { ceilingUsd: 36, othersUsd: 25.34 } });
    expect(hold).toMatchObject({ usd: 10.66, cappedUsd: true });
    expect(refreshed({ tokens: hold.tokens, usd: hold.usd! })?.sizing?.maxRunCostUsd).toBe(10.66);
    expect(refreshed({ tokens: CHARGE, usd: 24.08 })?.sizing?.maxRunCostUsd).toBe(24.08);
    // Without a dollar cap there is nothing to hold the dollars to.
    expect(chargeHold({ charge: { tokens: CHARGE, usd: 24.08 }, own: { usedTokens: 0, usedUsd: 0 }, pool: { limitTokens: LIMIT, othersTokens: OTHERS, waitingLowTokens: 0 }, dollars: null }).usd).toBe(24.08);
  });

  test("a charge that fits keeps today's bounds", () => {
    // 10M used by the others, a 2M low waiting: 22.2M left for a run charged 15M and $8.
    const hold = chargeHold({ charge: { tokens: 15_000_000, usd: 8 }, own: { usedTokens: 1_000_000, usedUsd: 0.5 }, pool: { limitTokens: LIMIT, othersTokens: 10_000_000, waitingLowTokens: 2_000_000 }, dollars: { ceilingUsd: 36, othersUsd: 12 } });
    expect(hold).toEqual({ tokens: 15_000_000, usd: 8, cappedTokens: false, cappedUsd: false });
  });

  test("the shadow reason records a bound or an auto-extend hard ceiling above what the pool holds", () => {
    expect(STOP_REASONS["initiative-pool-growth"]).toMatchObject({ defaultMode: "shadow", modes: ["shadow", "advisory"] });
    // R73's auto-extend hard ceilings (33.56M) and its $24.08 bound, against 5.66M and $10.66.
    const decision = poolBoundDecision({ runId: "r", featureId: "commands", limitTokens: LIMIT, othersUsedTokens: OTHERS, ceilingUsd: 36, othersSpentUsd: 25.34, tokens: [{ kind: "maxRunTokens", value: CHARGE }, { kind: "hardCeiling", value: 33_560_000 }], usd: [{ kind: "maxRunCostUsd", value: 24.08 }] });
    expect(decision).toMatchObject({ reason: "initiative-pool-growth", wouldStop: true, holdTokens: 5_660_000, holdUsd: 10.66 });
    expect(decision.over.map((b) => b.kind)).toEqual(["maxRunTokens", "hardCeiling", "maxRunCostUsd"]);
    // The capped bounds pass.
    expect(poolBoundDecision({ runId: "r", featureId: "commands", limitTokens: LIMIT, othersUsedTokens: OTHERS, ceilingUsd: 36, othersSpentUsd: 25.34, tokens: [{ kind: "maxRunTokens", value: 5_660_000 }], usd: [{ kind: "maxRunCostUsd", value: 10.66 }] }).wouldStop).toBe(false);
  });

  test("a dollar bound within half a cent of the ceiling less the others' spend passes (#2321)", () => {
    const decide = (ceilingUsd: number, othersSpentUsd: number, bound: number) =>
      poolBoundDecision({ runId: "r", featureId: "commands", limitTokens: LIMIT, othersUsedTokens: 0, ceilingUsd, othersSpentUsd, tokens: [], usd: [{ kind: "maxRunCostUsd", value: bound }] }).wouldStop;
    // fast-check seed 291173649: $1.665 against a $1.66 ceiling, exactly at the tolerance.
    expect(decide(1.6600000000000001, 0, 1.665)).toBe(false);
    // A ceiling with a fraction of a cent: $1.668 is under $1.669, though the cent-floored hold is $1.66.
    expect(decide(1.669, 0, 1.668)).toBe(false);
    expect(decide(36, 25.34, 10.665)).toBe(false);
    expect(decide(36, 25.34, 10.67)).toBe(true);
  });

  const plan: InitiativePlan = {
    schemaVersion: 1, title: "Flatelens", goals: ["Create the CLI"], completionCriteria: ["The CLI is ready"],
    features: ["core", "commands", "docs"].map((id) => ({
      id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
      contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
    })),
  };

  test("the initiative refreshes commands' bounds to what the pool holds and records a planted bound above it", async () => {
    const fixture = workflowFixture();
    fixture.config.defaultModel = "anthropic/claude-sonnet-4-6";
    cleanups.push(async () => fixture.dispose());
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixturePolicy, maxTotalTokens: 4_650_000, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 40_000_000, maxRunCostUsd: 100 } };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "flatelens", prompt: "Create the CLI", plan, policy, model: "anthropic/claude-sonnet-4-6", ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: LIMIT, maxAgentCalls: 1000, maxActiveMs: 21_600_000 }, costBudget: { maxCostUsd: 36, costTolerance: "off" } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("flatelens", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean>; refreshGrowth(id: string, featureId: string, runId: string): void; view(id: string): InitiativeView };
    expect(await service.startFeature("flatelens", "commands")).toBe(true);
    const runId = initiatives.view("flatelens").features.find((f) => f.id === "commands")!.runId!;
    const store = fixture.service.store;
    // commands' start-time bounds in R73: its 4.65M share and $3.82.
    const started = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    store.setPolicy(runId, { ...started, sizing: { ...started.sizing, maxRunTokens: 4_650_000, maxRunCostUsd: 3.82 } });
    // The view at commands' start in R73: the others used 28.54M and spent $25.34, and the pool
    // and the dollars hold commands at its enforced plan charge.
    const real = service.view.bind(initiatives);
    service.view = (id: string) => {
      const v = real(id);
      return {
        ...v,
        features: v.features.map((f) => (f.share !== null && f.id !== "commands" ? { ...f, need: { low: 0, high: 1_000_000 } } : f)),
        budget: {
          ...v.budget,
          used: { ...v.budget.used, tokens: OTHERS },
          reserved: { ...v.budget.reserved, tokens: CHARGE },
          remaining: { ...v.budget.remaining, tokens: 0 },
          cost: { ...v.budget.cost, ceilingUsd: 36, spentUsd: 25.34, reservedUsd: 24.08, remainingUsd: 0 },
          planCharge: { mode: "enforce", ratio: 1.2, runs: [{ featureId: "commands", runId, usedTokens: 0, limitTokens: 4_650_000, plan: { low: 14_700_000, expected: 20_000_000, high: 26_100_000 }, chargeTokens: CHARGE, usedUsd: 0, limitUsd: 3.82, chargeUsd: 24.08 }], limitCommittedTokens: OTHERS + 4_650_000, planCommittedTokens: OTHERS + CHARGE, releasedTokens: 4_650_000 - CHARGE, usd: null },
        },
      } as InitiativeView;
    };
    service.refreshGrowth("flatelens", "commands", runId);
    const refreshedPolicy = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    // The rule before #2280 raised them to the charge, 31.2M and $24.08.
    expect(refreshedPolicy.sizing!.maxRunTokens!).toBe(LIMIT - OTHERS);
    expect(refreshedPolicy.sizing!.maxRunCostUsd!).toBe(10.66);
    const wouldStops = () => store.eventsOfType(runId, "decision.would_stop").filter((e) => e.type === "decision.would_stop" && e.payload.reason === "initiative-pool-growth");
    expect(wouldStops()).toHaveLength(0);
    // A bound above the pool, as R73's auto-extends left it, is recorded once with its inputs.
    store.setPolicy(runId, { ...refreshedPolicy, sizing: { ...refreshedPolicy.sizing, maxRunTokens: CHARGE } });
    service.refreshGrowth("flatelens", "commands", runId);
    service.refreshGrowth("flatelens", "commands", runId);
    const recorded = wouldStops();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toMatchObject({ mode: "shadow", inputs: { limitTokens: LIMIT, othersUsedTokens: OTHERS, holdTokens: LIMIT - OTHERS } });
  });
});

describe("scenario: R73 evalpin's last feature grows no further than the pool left (#2294)", () => {
  const LIMIT = 23_900_000;
  const OTHERS = 20_594_626;
  const SHARE = LIMIT - OTHERS;
  const plan: InitiativePlan = {
    schemaVersion: 1, title: "Evalpin", goals: ["Create the CLI"], completionCriteria: ["The CLI is ready"],
    features: ["results", "commands", "delivery"].map((id) => ({
      id, title: id, size: "medium", workflow: "sdd", boundary: { scope: id, paths: [`${id}.txt`] },
      contract: `${id}.txt contains ready`, dependsOn: [], mandatory: true,
    })),
  };

  test("with no feature waiting, delivery's refresh keeps its 3.31M bounds and records no would-stop", async () => {
    const fixture = workflowFixture();
    fixture.config.defaultModel = "anthropic/claude-sonnet-4-6";
    cleanups.push(async () => fixture.dispose());
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixturePolicy, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 8_000_000, extendToTokens: 12_000_000 } };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "evalpin", prompt: "Create the CLI", plan, policy, model: "anthropic/claude-sonnet-4-6", ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: LIMIT, maxAgentCalls: 1000, maxActiveMs: 18_000_000 } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("evalpin", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean>; refreshGrowth(id: string, featureId: string, runId: string): void; view(id: string): InitiativeView };
    expect(await service.startFeature("evalpin", "delivery")).toBe(true);
    const runId = initiatives.view("evalpin").features.find((f) => f.id === "delivery")!.runId!;
    const store = fixture.service.store;
    // delivery's start in R73: its share is all the pool had left after the others' 20.59M.
    const started = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    store.setPolicy(runId, { ...started, maxTotalTokens: SHARE, sizing: { ...started.sizing, maxRunTokens: SHARE, extendToTokens: SHARE } });
    // Every other feature is accepted: none waits for a run, so none has an estimate.
    const real = service.view.bind(initiatives);
    service.view = (id: string) => {
      const v = real(id);
      return {
        ...v,
        features: v.features.map((f) => ({ ...f, share: null, need: null })),
        budget: {
          ...v.budget,
          used: { ...v.budget.used, tokens: OTHERS },
          reserved: { ...v.budget.reserved, tokens: SHARE },
          remaining: { ...v.budget.remaining, tokens: 0 },
        },
      } as InitiativeView;
    };
    service.refreshGrowth("evalpin", "delivery", runId);
    const after = JSON.parse(store.run(runId).policy_json) as RunPolicy;
    // The rule before #2294 took the base ceilings: 8M and 12M with 3.31M left.
    expect(after.sizing).toMatchObject({ maxRunTokens: SHARE, extendToTokens: SHARE });
    const wouldStops = store.eventsOfType(runId, "decision.would_stop").filter((e) => e.type === "decision.would_stop" && e.payload.reason === "initiative-pool-growth");
    expect(wouldStops).toHaveLength(0);
  });

  test("an unestimated plan's first start grows to its share, not the base ceilings", async () => {
    const fixture = workflowFixture();
    fixture.config.defaultModel = "anthropic/claude-sonnet-4-6";
    cleanups.push(async () => fixture.dispose());
    const initiatives = new InitiativeService(fixture.service);
    const policy: RunPolicy = { ...fixturePolicy, maxAgentCalls: 1000, costForecast: "off", sizing: { maxRunTokens: 8_000_000, extendToTokens: 12_000_000 } };
    const view = await initiatives.start({ commandId: newId(), initiativeId: "evalpin", prompt: "Create the CLI", plan, policy, model: "anthropic/claude-sonnet-4-6", ownerLabel: "test", keepFeatures: true, featureAutoApproval: null, budget: { maxTotalTokens: 3_000_000, maxAgentCalls: 1000, maxActiveMs: 18_000_000 } });
    const request = view.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve("evalpin", { commandId: newId(), expectedRevision: view.revision }, { requestId: request.requestId, digest: request.digest });
    const service = initiatives as unknown as { startFeature(id: string, featureId: string): Promise<boolean> };
    expect(initiatives.view("evalpin").features.every((f) => f.need === null)).toBe(true);
    expect(await service.startFeature("evalpin", "commands")).toBe(true);
    const runId = initiatives.view("evalpin").features.find((f) => f.id === "commands")!.runId!;
    const started = JSON.parse(fixture.service.store.run(runId).policy_json) as RunPolicy;
    // results and delivery reserve their whole 1M shares: commands grows to the 1M left of the 3M pool.
    expect(started.sizing).toMatchObject({ maxRunTokens: 1_000_000, extendToTokens: 1_000_000 });
  });
});

describe("replay: initiative-pool-growth on the recorded bounds (#2280)", () => {
  const trace = (round: string, app: string) => join(import.meta.dir, "fixtures", "bench-traces", round, `${app}.sqlite.gz`);

  test("R72 jvmsig never ran short of its pool: no run's bound passes it", () => {
    const { store, dispose } = openTrace(trace("R72", "jvmsig"));
    try {
      expect(replayPoolBounds(store).flatMap((i) => i.poolBounds)).toEqual([]);
    } finally {
      dispose();
    }
  });

  test("R71 xmlvet: cli-release, the last feature, took the base policy's 12M hard ceiling with 11.71M of the extended pool left", () => {
    // No waiting feature had an estimate, so the token room was null and `refreshedGrowth` took
    // the base ceilings. The run used 3.47M; the record is true and costs nothing in shadow.
    const { store, dispose } = openTrace(trace("R71", "xmlvet"));
    try {
      const bounds = replayPoolBounds(store).flatMap((i) => i.poolBounds);
      expect(bounds.map((b) => ({ featureId: b.featureId, over: b.over.map((o) => [o.kind, o.value]), holdTokens: b.holdTokens }))).toEqual([
        { featureId: "cli-release", over: [["extendToTokens", 12_000_000]], holdTokens: 41_800_000 - 30_091_967 },
      ]);
      // The rule that never stops records nothing.
      expect(replayPoolBounds(store, (inputs) => ({ ...poolBoundDecision(inputs), wouldStop: false })).flatMap((i) => i.poolBounds)).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe("the shared time's host growth, in shadow (#2346)", () => {
  const MIN = 60_000;
  // 400 min used of 360, forecast 598 min at 58k a minute; the 30M pool has 12M left (207 min).
  const base = { initiativeId: "ladle", limitMs: 360 * MIN, usedMs: 400 * MIN, forecastMs: 598 * MIN, suggestedMs: 750 * MIN, tokensPerMinute: 58_000, limitTokens: 30_000_000, usedTokens: 18_000_000, cost: { capUsd: 30, ceilingUsd: 37.5, forecastUsd: 26 } };

  test("it is registered with the caps that bound it, shadow by default", () => {
    expect(HOST_POOL_GROWTHS["time-pool"]).toMatchObject({ modes: ["off", "shadow"], defaultMode: "shadow" });
    expect(HOST_POOL_GROWTHS["time-pool"].boundBy).toContain("--budget-tokens");
  });

  test("it extends to the notice's suggestion, held to what the token pool runs at the pace", () => {
    const decision = timePoolExtensionDecision(base);
    // 400 min used plus 12M tokens at 58k a minute (207 min) = 607 min, rounded down to 600.
    expect(decision).toMatchObject({ reason: "time-pool", wouldExtend: true, toMs: 600 * MIN, byMs: 240 * MIN });
    expect(decision.capMs).toBe(400 * MIN + Math.round((12_000_000 / 58_000) * MIN));
    // A larger pool lets the whole suggestion through.
    expect(timePoolExtensionDecision({ ...base, limitTokens: 60_000_000 })).toMatchObject({ wouldExtend: true, toMs: 750 * MIN });
    // Without a dollar cap the token pool alone bounds it.
    expect(timePoolExtensionDecision({ ...base, cost: { capUsd: null, ceilingUsd: null, forecastUsd: null } })).toMatchObject({ wouldExtend: true, toMs: 600 * MIN });
  });

  test("it holds while the time fits, without a pace, past the dollar ceiling, or with the token pool spent", () => {
    const holds = [
      { ...base, forecastMs: 300 * MIN, suggestedMs: null },
      { ...base, tokensPerMinute: null, forecastMs: null, suggestedMs: null },
      { ...base, cost: { capUsd: 30, ceilingUsd: 37.5, forecastUsd: null } },
      { ...base, cost: { capUsd: 30, ceilingUsd: 37.5, forecastUsd: 40 } },
      { ...base, usedMs: 350 * MIN, usedTokens: 30_000_000 },
    ];
    for (const inputs of holds) expect(timePoolExtensionDecision(inputs)).toMatchObject({ wouldExtend: false, toMs: null, byMs: null });
  });

  test("replay: R75's share gates with a shared time never passed it, so the rule records no extension", () => {
    for (const app of ["latcell", "maskback"]) {
      const { store, dispose } = openTrace(join(import.meta.dir, "fixtures", "bench-traces", "R75", `${app}.sqlite.gz`));
      try {
        const [replay] = replayTimePoolGrowth(store);
        expect(replay?.timeGrowth.length).toBeGreaterThan(0);
        expect(replay?.timeGrowth.every((b) => b.recorded === "hold" && b.replayed === "hold")).toBe(true);
        expect(replay?.newTimeGrowth).toBe(0);
      } finally {
        dispose();
      }
    }
  });
});

// Bench round 80, deltaglue (#2488): the cli feature's own plan sized 17.46M against the 3.38M its
// start share gave its run, while frames and assembly were accepted and the $30 cap paid for
// about 24M. The run went on under assume and stopped budget_exhausted with 17 of 24 tasks left;
// `extendWithinDollars: on` acted only at a share-gate park, so it never did. Here f3 plans 24
// tasks, about 4 times its 2.1M share, on a 6.0M pool after f1 and f2 are accepted.
describe("scenario: a feature run's own plan above its share asks the initiative before its first task (#2488, R80 deltaglue)", () => {
  async function planShareScenario(extendWithinDollars: "off" | "shadow" | "on") {
    const history = await historyFixture(1, { taskShare: 0.4 });
    cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(4, 1, [history.root], { skeleton: false, globPaths: true, maxTotalTokens: 6_000_000, extendWithinDollars, tasks: { f3: 24 } });
    cleanups.push(() => result.fixture.dispose());
    const { initiatives, fixture } = result;
    // What the pool and f3's run held when f3's first task started.
    let atTask1: { poolTokens: number; ceilingTokens: number | undefined } | null = null;
    const executor = fixture.executor as unknown as { execute: (request: { profile: { output: string }; task?: { id: string }; runId: string }) => Promise<unknown> };
    const execute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      const run = initiatives.view("values").features.find((f) => f.id === "f3")?.runId;
      if (!atTask1 && request.runId === run && request.profile.output === "implementation") {
        const policy = JSON.parse(fixture.service.store.run(run).policy_json) as RunPolicy;
        atTask1 = { poolTokens: initiatives.view("values").budget.limits.maxTotalTokens, ceilingTokens: policy.sizing?.maxRunTokens };
      }
      return execute(request);
    };
    let view = initiatives.view("values");
    for (let i = 0; i < 4 && !["blocked", "done"].includes(view.next.kind); i++) view = await initiatives.drive("values", new AbortController().signal);
    const runId = view.features.find((f) => f.id === "f3")?.runId ?? "";
    const store = fixture.service.store;
    const events = (type: string) => initiatives.events("values").filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
    const artifacts = (prefix: string) => store.artifacts(runId).filter((a) => a.logical_path.startsWith(prefix)).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as Record<string, unknown>);
    // f3's start share: its run's token limit at the share gate it passed.
    const gate = (events("feature.share_gate") as unknown as ShareGateRecord[]).find((g) => g.featureId === "f3" && g.verdict === "pass");
    return { view, runId, store, events, artifacts, atTask1: atTask1 as { poolTokens: number; ceilingTokens: number | undefined } | null, share: gate?.feature.share?.tokens ?? 0 };
  }

  test("shadow records the would-extend with its inputs before the tasks and changes nothing", async () => {
    const { view, runId, store, events, artifacts, share } = await planShareScenario("shadow");
    // The plan is about four times the start share; f1 and f2 were accepted, so the dollar forecast is measured.
    const [plan] = artifacts("sizing/plan-0.json") as { runTokens: number; decision: string }[];
    expect(plan?.decision).toBe("split-feature");
    expect(plan!.runTokens).toBeGreaterThan(4 * share);
    const extend = events("decision.would_extend").filter((e) => e.reason === "plan-share");
    expect(extend).toHaveLength(1);
    expect(extend[0]).toMatchObject({ reason: "plan-share", mode: "shadow", featureId: "f3", runId });
    expect(extend[0]?.toTokens as number).toBeGreaterThan(6_000_000);
    expect(extend[0]?.ceilingTokens as number).toBeGreaterThan(4 * share);
    expect(extend[0]?.inputs).toMatchObject({ runId, featureId: "f3", pool: { limitTokens: 6_000_000, cost: { capUsd: 30, measuredFeatures: 2 } } });
    expect(String(extend[0]?.summary)).toEndWith("f3 would run its tasks within its plan.");
    // Registered with the cap that bounds it, in the same mode as the share gate's extension.
    expect(HOST_POOL_GROWTHS["plan-share"]).toMatchObject({ modes: ["off", "shadow", "on"], defaultMode: "shadow" });
    expect(HOST_POOL_GROWTHS["plan-share"].boundBy).toContain("--budget-usd");
    // Shadow changes nothing: the pool stays as the person set it and the run stops mid-tasks as before.
    expect(events("budget.extended").filter((e) => e.by === "host")).toEqual([]);
    expect(view.budget.limits.maxTotalTokens).toBe(6_000_000);
    expect(store.run(runId).status).toBe("blocked");
    expect(store.run(runId).reason).toContain("budget_exhausted");
    expect(events("decision.would_stop").filter((e) => e.reason === "initiative-plan-share")).toEqual([]);
  });

  test("on grows the pool inside the dollar cap and the run's ceiling before task 1, and the run finishes its tasks", async () => {
    const { view, runId, events, artifacts, atTask1, share } = await planShareScenario("on");
    const extended = events("budget.extended").filter((e) => e.by === "host" && e.gate === "plan-share");
    expect(extended).toHaveLength(1);
    const [grown] = extended;
    expect(grown).toMatchObject({ by: "host", reason: "extend-within-dollars", gate: "plan-share", featureId: "f3", runId, previous: { maxTotalTokens: 6_000_000 }, next: { maxTotalTokens: grown?.toTokens } });
    expect(HOST_POOL_GROWTHS[grown?.reason as PoolGrowthReason].modes).toContain("on");
    // Inside the dollar cap: the extension the share gate's own rule decides on the same pool, with
    // the run's need beside the waiting features, and no dollar, call or time limit raised.
    const inputs = grown?.inputs as { pool: Parameters<typeof poolExtensionDecision>[0]; othersUsedTokens: number };
    expect(grown?.next).toMatchObject({ maxAgentCalls: (grown?.previous as { maxAgentCalls: number }).maxAgentCalls, maxActiveMs: (grown?.previous as { maxActiveMs: number }).maxActiveMs });
    expect(view.budget.cost.capUsd).toBe(30);
    // The run's ceiling grew with it, held to the grown pool less what the other runs used (#2468).
    expect(grown?.ceilingTokens as number).toBeGreaterThan(4 * share);
    expect(grown?.ceilingTokens as number).toBeLessThanOrEqual((grown?.toTokens as number) - inputs.othersUsedTokens);
    const [revision] = artifacts("policy-revisions/initiative-") as { kind: string; next: { sizing: { maxRunTokens: number } } }[];
    expect(revision).toMatchObject({ kind: "plan-share", next: { sizing: { maxRunTokens: grown?.ceilingTokens } } });
    // Both before f3's first task: the plan was sized again on the grown ceiling, with no assumption.
    expect(atTask1).toEqual({ poolTokens: grown?.toTokens as number, ceilingTokens: grown?.ceilingTokens as number });
    const sized = artifacts("sizing/plan-0.json") as { decision: string; budgetAfter: number }[];
    expect(sized.map((s) => s.decision)).toEqual(["split-feature", "raise-budget"]);
    expect(artifacts("assumptions/")).toEqual([]);
    // The run never stopped on its share in the middle of its tasks.
    expect(artifacts("policy-revisions/auto-")).toEqual([]);
    expect(view.features.find((f) => f.id === "f3")?.state).toBe("accepted");
    expect(events("decision.would_stop").filter((e) => e.reason === "initiative-plan-share")).toEqual([]);
    expect(events("decision.would_extend").filter((e) => e.reason === "plan-share")).toEqual([]);
  });

  test("off records the would-stop with the extend that answers it and keeps today's behavior", async () => {
    const { view, runId, store, events, artifacts } = await planShareScenario("off");
    const stops = events("decision.would_stop").filter((e) => e.reason === "initiative-plan-share");
    expect(stops).toHaveLength(1);
    expect(STOP_REASONS["initiative-plan-share"]).toMatchObject({ modes: ["shadow", "advisory"], defaultMode: "shadow" });
    expect(stops[0]).toMatchObject({ reason: "initiative-plan-share", mode: "shadow", featureId: "f3", runId, remedy: { action: "extend", initiativeId: "values" } });
    // The pool the cap pays for that covers f3's plan beside the waiting f4 (`affordableTokens`).
    const remedy = stops[0]?.remedy as { suggestedTokens: number; suggestedUsd?: number };
    expect(remedy.suggestedTokens).toBeGreaterThan(6_000_000);
    expect(remedy.suggestedUsd).toBeUndefined();
    expect(String(stops[0]?.summary)).toContain("f3 would park before its tasks with the extend that answers it");
    // Nothing else changes: the run goes on under assume and stops on its share mid-tasks.
    expect(artifacts("assumptions/sizing.json")).toHaveLength(1);
    expect(events("budget.extended").filter((e) => e.by === "host")).toEqual([]);
    expect(events("decision.would_extend")).toEqual([]);
    expect(view.budget.limits.maxTotalTokens).toBe(6_000_000);
    expect(store.run(runId).status).toBe("blocked");
    expect(store.run(runId).reason).toContain("budget_exhausted");
  });

  test("replay: R80 deltaglue's cli would have grown the pool and its ceiling before its first task", () => {
    const { store, dispose } = openTrace(join(import.meta.dir, "fixtures", "bench-traces", "R80", "deltaglue.sqlite.gz"));
    try {
      // The rule before #2488 asked nothing: the run went on under assume.
      const none = () => ({ ...planShareDecision({ runId: "", featureId: "", usedTokens: 0, limitTokens: 1, ceilingTokens: 1, baseCeilingTokens: null, plan: { low: 0, high: 0 }, planRatio: null, heldTokens: 0, othersUsedTokens: 0, pool: { initiativeId: "", limitTokens: 1, usedTokens: 0, committedTokens: 0, forecastTokens: null, ratio: null, features: 0, waiting: [], cost: { capUsd: null, ceilingUsd: null, spentUsd: 0, remainingUsd: null, forecastUsd: null } } }), over: false });
      expect(replayPlanShare(store, none).flatMap((i) => i.planShare).map((b) => b.replayed)).toEqual(["none"]);
      const [deltaglue] = replayPlanShare(store);
      // At 16.0M against the 3.38M start share, with frames and assembly accepted ($11.42 forecast
      // inside the $34.50 ceiling): the pool grows from 7.1M to 20.2M, inside the 27.3M the $30 cap
      // pays for, and the run's ceiling to the base policy's 12.0M.
      expect(deltaglue?.planShare).toEqual([{ featureId: "cli", runId: "25985b82-052c-4dd3-8127-f0f140bc1625", recorded: "none", replayed: "extend", needTokens: 15_951_603, ceilingTokens: 3_382_994, toTokens: 20_200_000, toCeilingTokens: 12_000_000, suggestedTokens: 20_200_000 }]);
      expect(deltaglue?.newPlanShare).toBe(1);
    } finally {
      dispose();
    }
  });
});

// Bench round 82, tinyflate (#2523): deflate, planned ahead beside core, sized its plan at 4.41M
// against its 4.14M ceiling at 22:21:31, before any feature was accepted. The plan-time share gate
// recorded an `initiative-plan-share` would-stop with `hold: "no measurement"` and was asked once
// per run and ceiling, so nothing asked it again when core was accepted at 22:25, the moment the
// hold lifted; deflate grew its own limit and finished inside the 19.6M pool, so the would-stop
// was false. Here f1 and f2 start together under plan ahead, f2 plans 24 tasks, and f1's tasks
// wait until f2 is sized, so f2's gate runs with no feature measured.
describe("scenario: a share-gate hold for no measurement is asked again when the first feature is accepted (#2523, R82 tinyflate)", () => {
  async function firstWaveScenario(extendWithinDollars: "shadow" | "on", maxTotalTokens: number, tasks: Record<string, number>) {
    const history = await historyFixture(1, { taskShare: 0.4 });
    cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(4, 1, [history.root], { skeleton: false, globPaths: true, maxTotalTokens, extendWithinDollars, tasks, planAhead: true, approve: false });
    cleanups.push(() => result.fixture.dispose());
    const { initiatives, fixture } = result;
    const store = fixture.service.store;
    const runOf = (featureId: string) => initiatives.view("values").features.find((f) => f.id === featureId)?.runId ?? null;
    // f1's first task waits until f2 has a run that is sized, or has parked without one.
    let held = false;
    const executor = fixture.executor as unknown as { execute: (request: { profile: { output: string }; runId: string }) => Promise<unknown> };
    const execute = executor.execute.bind(executor);
    executor.execute = async (request) => {
      if (!held && request.runId === runOf("f1") && request.profile.output === "implementation") {
        held = true;
        const ready = () => {
          const f2 = runOf("f2");
          if (f2) return store.artifacts(f2).some((a) => a.logical_path.startsWith("sizing/"));
          return initiatives.events("values").some((e) => e.type === "feature.share_gate" && (e.payload as ShareGateRecord).featureId === "f2");
        };
        for (const deadline = Date.now() + 20_000; !ready() && Date.now() < deadline; ) await Bun.sleep(20);
      }
      return execute(request);
    };
    const decision = result.view.pendingDecisions.find((d) => d.scope === "initiative");
    await initiatives.approve("values", result.identity(), { requestId: decision?.requestId ?? "", digest: decision?.digest ?? "" });
    let view = initiatives.view("values");
    for (let i = 0; i < 6 && view.status !== "completed" && view.next.kind !== "blocked"; i++) view = await initiatives.drive("values", new AbortController().signal);
    const all = initiatives.events("values");
    const seq = (match: (type: string, payload: Record<string, unknown>) => boolean) => all.findIndex((e) => match(e.type, e.payload as Record<string, unknown>));
    const events = (type: string) => all.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);
    return { view, store, events, seq, runOf };
  }
  const isHold = (type: string, p: Record<string, unknown>) => type === "decision.would_stop" && p.reason === "initiative-plan-share" && p.hold === "no measurement";

  test("on: the plan-share hold of a first-wave run grows the pool and its ceiling once the first feature is accepted", async () => {
    const { view, store, events, seq, runOf } = await firstWaveScenario("on", 6_000_000, { f2: 24 });
    const runId = runOf("f2") ?? "";
    const [hold, ...more] = events("decision.would_stop").filter((e) => e.reason === "initiative-plan-share");
    expect(more).toEqual([]);
    expect(hold).toMatchObject({ featureId: "f2", runId, hold: "no measurement", inputs: { pool: { limitTokens: 6_000_000, cost: { measuredFeatures: 0 } } } });
    expect(String(hold?.summary)).toEndWith(FIRST_WAVE_HOLD_TEXT);
    // Asked again after f1 was accepted: the pool and f2's ceiling grow inside the dollar cap.
    const extended = events("budget.extended").filter((e) => e.by === "host" && e.gate === "plan-share");
    expect(extended).toHaveLength(1);
    expect(extended[0]).toMatchObject({ reason: "extend-within-dollars", featureId: "f2", runId, previous: { maxTotalTokens: 6_000_000 }, inputs: { pool: { cost: { measuredFeatures: 1 } } } });
    expect(extended[0]?.ceilingTokens as number).toBeGreaterThan((hold?.inputs as { ceilingTokens: number }).ceilingTokens);
    expect(seq((type, p) => type === "budget.extended" && p.gate === "plan-share")).toBeGreaterThan(seq(isHold));
    const revision = store.artifacts(runId).filter((a) => a.logical_path.startsWith("policy-revisions/initiative-")).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as { kind: string; next: { sizing: { maxRunTokens: number } } });
    expect(revision.find((r) => r.kind === "plan-share")?.next.sizing.maxRunTokens).toBe(extended[0]?.ceilingTokens as number);
    // No stale would-stop remains: the run's latest plan-share record is the extension.
    expect(replayPlanShare(store).flatMap((i) => i.planShare).find((b) => b.runId === runId)?.recorded).toBe("extend");
    expect(view.budget.limits.maxTotalTokens).toBe(extended[0]?.toTokens as number);
    expect(view.status).toBe("completed");
  });

  test("shadow: the same hold records the would-extend once the first feature is accepted, and changes nothing", async () => {
    const { view, store, events, seq, runOf } = await firstWaveScenario("shadow", 6_000_000, { f2: 24 });
    const runId = runOf("f2") ?? "";
    const [hold] = events("decision.would_stop").filter((e) => e.reason === "initiative-plan-share");
    expect(hold).toMatchObject({ featureId: "f2", runId, mode: "shadow", hold: "no measurement" });
    // Shadow does not run `on`, so its summary names no `on` wait.
    expect(String(hold?.summary)).not.toContain("extendWithinDollars");
    const extend = events("decision.would_extend").filter((e) => e.reason === "plan-share");
    expect(extend).toHaveLength(1);
    expect(extend[0]).toMatchObject({ mode: "shadow", featureId: "f2", runId, inputs: { pool: { limitTokens: 6_000_000, cost: { measuredFeatures: 1 } } } });
    expect(seq((type, p) => type === "decision.would_extend" && p.reason === "plan-share")).toBeGreaterThan(seq(isHold));
    expect(replayPlanShare(store).flatMap((i) => i.planShare).find((b) => b.runId === runId)?.recorded).toBe("extend");
    expect(events("budget.extended").filter((e) => e.by === "host")).toEqual([]);
    expect(view.budget.limits.maxTotalTokens).toBe(6_000_000);
  });

  // The park path's one-shot hold (#2471) had the same shape: f2, ready under plan ahead, parked
  // on the 3.0M pool with `hold: "no measurement"`, and a drive that retried it returned on the
  // earlier park, so after f1 was accepted the initiative stayed blocked with the cap's room.
  test("on: a first-wave park held for no measurement grows the pool and starts once the first feature is accepted", async () => {
    const { view, events } = await firstWaveScenario("on", 3_000_000, {});
    const parks = (events("feature.share_gate") as unknown as ShareGateRecord[]).filter((g) => g.featureId === "f2" && g.verdict === "park");
    expect(parks.map((g) => g.poolGrowth)).toEqual([
      { mode: "on", hold: "no measurement", wouldExtend: false, toTokens: null, byTokens: null },
      { mode: "on", wouldExtend: true, toTokens: 3_500_000, byTokens: 500_000 },
    ]);
    expect(parks[1]?.view.budget.cost.measuredFeatures).toBe(1);
    // f2's park grows the pool once, first. On a slower machine (Windows CI) f3 and f4 can reach
    // their own parks later, after the measurement, and the host grows the pool for them too.
    const extended = events("budget.extended").filter((e) => e.by === "host");
    expect(extended.filter((e) => e.featureId === "f2")).toHaveLength(1);
    expect(extended[0]).toMatchObject({ reason: "extend-within-dollars", featureId: "f2", previous: { maxTotalTokens: 3_000_000 }, toTokens: 3_500_000 });
    // Every host growth answers a park decided with the measurement, never one held without it.
    const decided = (events("feature.share_gate") as unknown as ShareGateRecord[]).filter((g) => g.poolGrowth?.wouldExtend);
    expect(extended.map((e) => [e.featureId, e.toTokens])).toEqual(decided.map((g) => [g.featureId, g.poolGrowth?.toTokens]));
    expect(decided.every((g) => g.view.budget.cost.measuredFeatures >= 1)).toBe(true);
    expect(view.status).toBe("completed");
  });

  test("shadow: the same park records the would-extend once the first feature is accepted, and stays parked", async () => {
    const { view, events } = await firstWaveScenario("shadow", 3_000_000, {});
    const parks = (events("feature.share_gate") as unknown as ShareGateRecord[]).filter((g) => g.featureId === "f2" && g.verdict === "park");
    expect(parks.map((g) => g.poolGrowth)).toEqual([
      { mode: "shadow", hold: "no measurement", wouldExtend: false, toTokens: null, byTokens: null },
      { mode: "shadow", wouldExtend: true, toTokens: 3_500_000, byTokens: 500_000 },
    ]);
    expect(events("decision.would_extend").filter((e) => e.reason === "extend-within-dollars")).toEqual([expect.objectContaining({ featureId: "f2", toTokens: 3_500_000 })]);
    expect(events("budget.extended").filter((e) => e.by === "host")).toEqual([]);
    expect(view.next).toMatchObject({ kind: "blocked", featureId: "f2" });
    expect(view.budget.limits.maxTotalTokens).toBe(3_000_000);
  });
});

// Bench rounds 82 and 83 (#2534): before a plan-to-actual ratio is measured the plan charge held
// each open run at its plan's high end. R82 tinyflate held core at 8.05M (it used 3.02M), inflate
// at 6.89M (4.88M) and deflate at 6.49M (4.54M): 21.5M committed against the 19.6M pool for runs
// that used 12.4M, and deflate's plan-time share gate recorded a false `initiative-plan-share`
// would-stop at 22:21:31 on its 4.41M plan against its 4,140,106 ceiling. R83 pnmforge (cap $25,
// extendWithinDollars on) parked geometry at minute 36 (share 399k, need low 1.14M) on charges
// of 18.98M of the 19.6M pool while the runs had used 4.7M; tone recorded a plan-share
// would-stop on the same charges, the host extended the pool by 2.7M, the initiative finished at
// 16.17M, and geometry started at minute 66. Neither trace is in the corpus: the highs, limits,
// uses and pools below are the issues', and the plans' lows and expected points, which the
// issues do not give, are rebuilt between each run's use and its high end.
describe("replay: unmeasured plans held at their expected need instead of their high end (#2534, R82 tinyflate, R83 pnmforge)", () => {
  const POOL_19_6 = 19_600_000;
  const run = (featureId: string, usedTokens: number, limitTokens: number, plan: { low: number; expected: number; high: number }) => ({ featureId, runId: `r-${featureId}`, usedTokens, limitTokens, plan });
  /** A gate at the open runs' limits (the plan charge in shadow), for `planChargedGate` to charge. */
  const gateAt = (initiativeId: string, limitCommitted: number, usedTokens: number, waiting: { id: string; low: number; high: number }[], cost: Partial<ShareGateView["budget"]["cost"]> = {}): ShareGateView => ({
    initiativeId,
    budget: {
      remaining: { tokens: Math.max(0, POOL_19_6 - limitCommitted), calls: 400, activeMs: 10_000_000 },
      cost: { capUsd: 25, tolerance: 0.25, ceilingUsd: 31.25, spentUsd: 4, reservedUsd: 0, remainingUsd: 21, forecastUsd: null, measuredFeatures: 0, forecastBinding: false, forecastMode: "shadow", shareMode: "shadow", forecastNotice: null, ...cost },
      limits: { maxTotalTokens: POOL_19_6, maxAgentCalls: 1000, maxActiveMs: 21_600_000 },
      used: { tokens: usedTokens, calls: 0, activeMs: 0 },
    },
    features: waiting.map((f) => ({ id: f.id, state: "ready", share: { tokens: 0, calls: 100, activeMs: 3_600_000 }, need: { low: f.low, high: f.high }, shareUsd: 4, needUsd: null })),
  });
  const charged = (view: ShareGateView, charge: ReturnType<typeof planCharge>) => planChargedGate({ ...view, budget: { ...view.budget, planCharge: charge } }) as ShareGateView;
  const feature = (view: ShareGateView, id: string) => {
    const f = view.features.find((g) => g.id === id);
    return { id, share: f?.share ?? null, need: f?.need ?? null, shareUsd: f?.shareUsd ?? null };
  };

  describe("R82 tinyflate", () => {
    const SPLIT = 70_000;
    // The first starter, core, held 9.99M; deflate, the third, its 3.79M start share.
    const open = (used: [number, number, number]) => [
      run("core", used[0], 9_990_000, { low: 2_900_000, expected: 4_400_000, high: 8_050_000 }),
      run("inflate", used[1], 5_750_000, { low: 3_300_000, expected: 4_600_000, high: 6_890_000 }),
      run("deflate", used[2], 3_790_000, { low: 3_000_000, expected: 4_200_000, high: 6_490_000 }),
    ];
    const limits = SPLIT + 9_990_000 + 5_750_000 + 3_790_000;
    const atGate = open([1_600_000, 1_000_000, 570_000]);

    test("at the high end the charges oversubscribe the 19.6M pool; at the expected need they hold 13.3M, near the 12.4M the runs used", () => {
      const high = planCharge("enforce", null, limits, atGate);
      expect(high?.runs.map((r) => r.chargeTokens)).toEqual([8_050_000, 6_890_000, 6_490_000]);
      expect(high?.planCommittedTokens).toBe(21_500_000);
      expect(high?.point).toBeUndefined();
      const expected = planCharge("enforce", null, limits, atGate, undefined, "expected");
      expect(expected?.point).toBe("expected");
      expect(expected?.runs.map((r) => r.chargeTokens)).toEqual([4_400_000, 4_600_000, 4_200_000]);
      expect(expected?.planCommittedTokens).toBe(13_270_000);
      expect(expected?.planCommittedTokens).toBeLessThan(POOL_19_6);
      // Never below what a run used: at the runs' final use inflate and deflate hold their use.
      const end = planCharge("enforce", null, limits, open([3_020_000, 4_880_000, 4_540_000]), undefined, "expected");
      expect(end?.runs.map((r) => r.chargeTokens)).toEqual([4_400_000, 4_880_000, 4_540_000]);
      // A measured ratio keeps the high end at that ratio, whatever the point.
      expect(planCharge("enforce", 1.2, limits, atGate, undefined, "expected")?.runs.map((r) => r.chargeTokens)).toEqual(planCharge("enforce", 1.2, limits, atGate)?.runs.map((r) => r.chargeTokens));
      // A plan without expected tasks (before #2043) keeps its high end.
      expect(planCharge("enforce", null, 0, [{ ...atGate[0]!, plan: { low: 2_900_000, high: 8_050_000 } }], undefined, "expected")?.runs[0]?.chargeTokens).toBe(8_050_000);
    });

    test("deflate's plan-time share gate: the high end records the false would-stop, the expected need asks nothing", () => {
      // deflate's plan at 22:21:31, sized before its later 6.49M plan: 4.41M at the high end.
      const plan = { low: 3_000_000, expected: 3_600_000, high: 4_410_000 };
      const inputs = (point: "high" | "expected") => {
        const charge = planCharge("enforce", null, limits, [atGate[0]!, atGate[1]!, { ...atGate[2]!, plan }], undefined, point);
        return {
          runId: "r-deflate", featureId: "deflate", usedTokens: 570_000, limitTokens: 3_790_000, ceilingTokens: 4_140_106, baseCeilingTokens: 12_000_000,
          plan, planRatio: null, planPoint: point, heldTokens: charge?.runs[2]?.chargeTokens ?? 0, othersUsedTokens: 2_670_000,
          pool: { initiativeId: "tinyflate", limitTokens: POOL_19_6, usedTokens: 3_240_000, committedTokens: charge?.planCommittedTokens ?? 0, forecastTokens: null, ratio: null, features: 5, waiting: [{ id: "cli", low: 900_000, high: 2_000_000 }, { id: "docs", low: 300_000, high: 700_000 }], cost: { capUsd: 25, ceilingUsd: 31.25, spentUsd: 2.6, remainingUsd: 22.4, forecastUsd: null } },
        };
      };
      const high = planShareDecision(inputs("high"));
      expect(high).toMatchObject({ needTokens: 4_410_000, over: true, wouldExtend: false });
      const expected = planShareDecision(inputs("expected"));
      expect(expected).toMatchObject({ needTokens: 3_600_000, over: false, wouldExtend: false });
      // Without the point the inputs a recorded gate replays keep the high end.
      const { planPoint: _, ...recorded } = inputs("high");
      expect(planShareDecision(recorded).needTokens).toBe(4_410_000);
    });
  });

  describe("R83 pnmforge", () => {
    const SPLIT = 200_000;
    // Only tone is named among the open runs at minute 36; the others are open-a and open-b.
    const open = [
      run("tone", 1_200_000, 6_000_000, { low: 2_900_000, expected: 3_900_000, high: 6_200_000 }),
      run("open-a", 2_000_000, 7_000_000, { low: 3_100_000, expected: 4_300_000, high: 7_100_000 }),
      run("open-b", 1_300_000, 5_000_000, { low: 2_400_000, expected: 3_400_000, high: 5_480_000 }),
    ];
    const limits = SPLIT + 6_000_000 + 7_000_000 + 5_000_000;
    const used = SPLIT + 1_200_000 + 2_000_000 + 1_300_000;
    const waiting = [{ id: "geometry", low: 1_140_000, high: 2_200_000 }, { id: "docs", low: 600_000, high: 1_220_000 }];

    test("minute 36: the high-end charges hold 18.98M and park geometry on a 399k share; the expected need starts it", () => {
      expect(used).toBe(4_700_000);
      const base = gateAt("pnmforge", limits, used, waiting);
      const high = planCharge("shadow", null, limits, open);
      expect(high?.planCommittedTokens).toBe(18_980_000);
      const parked = charged(base, high);
      expect(parked.budget.remaining.tokens).toBe(620_000);
      expect(feature(parked, "geometry").share?.tokens).toBe(398_830);
      expect(shareShortfall(parked, feature(parked, "geometry"))?.summary).toStartWith("The shared budget is short: geometry");
      const expected = planCharge("shadow", null, limits, open, undefined, "expected");
      expect(expected?.planCommittedTokens).toBe(11_800_000);
      const started = charged(base, expected);
      expect(started.budget.remaining.tokens).toBe(7_800_000);
      expect(shareShortfall(started, feature(started, "geometry"))).toBeNull();
    });

    test("shadow: the enforced gate parks geometry and the gate at the expected need, which the would_release record reads, starts it", () => {
      const high = planCharge("enforce", null, limits, open);
      const expected = planCharge("enforce", null, limits, open, undefined, "expected");
      const base = gateAt("pnmforge", limits, used, waiting);
      // The enforced view: the pool holds the high end, and `planCharge.expected` rides beside it.
      const enforced = charged(base, { ...high!, mode: "shadow" });
      const view: ShareGateView = { ...enforced, budget: { ...enforced.budget, planCharge: { ...high!, expected: expected! } } };
      expect(shareShortfall(view, feature(view, "geometry"))).not.toBeNull();
      const atExpected = expectedChargedGate(view);
      expect(atExpected?.budget.remaining.tokens).toBe(7_800_000);
      expect(shareShortfall(atExpected!, feature(atExpected!, "geometry"))).toBeNull();
      // Without the expected charge, or with the plan charge itself in shadow, there is no such gate.
      expect(expectedChargedGate({ ...view, budget: { ...view.budget, planCharge: high } })).toBeNull();
      expect(expectedChargedGate({ ...view, budget: { ...view.budget, planCharge: { ...high!, mode: "shadow", expected: expected! } } })).toBeNull();
    });

    test("the extension inside the $25 cap rested on the high-end charges: at the expected need nothing parks to extend for", () => {
      // After the first accepted feature the dollar forecast is measured ($21.38 inside $31.25),
      // at the round's $0.95 per million tokens ($15.31 for 16.17M).
      const measured = { measuredFeatures: 1, forecastUsd: 21.38, spentUsd: 4.45, remainingUsd: 20.55 };
      const base = gateAt("pnmforge", limits, used, waiting, measured);
      const parked = charged(base, planCharge("shadow", null, limits, open));
      const growth = poolGrowthOf(parked, feature(parked, "geometry"));
      // The round's host extension was +2.7M to 22.3M; on these figures it is +2.8M to 22.4M.
      expect(growth).toMatchObject({ wouldExtend: true, toTokens: 22_400_000, byTokens: 2_800_000 });
      const started = charged(base, planCharge("shadow", null, limits, open, undefined, "expected"));
      expect(shareShortfall(started, feature(started, "geometry"))).toBeNull();
      expect(poolGrowthOf(started, feature(started, "geometry"))).toBeNull();
    });

    test("tone's plan-share would-stop rested on its plan's high end above its 6.0M start share", () => {
      const tone = open[0]!;
      const inputs = (point: "high" | "expected") => {
        const charge = planCharge("enforce", null, limits, open, undefined, point);
        return {
          runId: tone.runId, featureId: "tone", usedTokens: tone.usedTokens, limitTokens: tone.limitTokens, ceilingTokens: tone.limitTokens, baseCeilingTokens: 12_000_000,
          plan: tone.plan, planRatio: null, planPoint: point, heldTokens: charge?.runs[0]?.chargeTokens ?? 0, othersUsedTokens: used - tone.usedTokens,
          pool: { initiativeId: "pnmforge", limitTokens: POOL_19_6, usedTokens: used, committedTokens: charge?.planCommittedTokens ?? 0, forecastTokens: null, ratio: null, features: 6, waiting: waiting.map((w) => ({ ...w })), cost: { capUsd: 25, ceilingUsd: 31.25, spentUsd: 4, remainingUsd: 21, forecastUsd: null } },
        };
      };
      expect(planShareDecision(inputs("high"))).toMatchObject({ needTokens: 6_200_000, over: true });
      expect(planShareDecision(inputs("expected"))).toMatchObject({ needTokens: 3_900_000, over: false });
    });
  });
});
