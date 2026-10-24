import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { suggestedExtension } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { startApiServer } from "../src/core/api/server.js";
import {
  type InitiativeView,
  poolGrowthOf,
  type ShareGateRecord,
  type ShareGateView,
  shareShortfall,
} from "../src/core/workflows/initiatives/service.js";
import { HOST_POOL_GROWTHS, poolExtensionDecision, tokenPool } from "../src/core/workflows/initiatives/token-pool.js";
import { initiativeActions } from "../src/core/workflows/initiatives/view-model.js";
import { openTrace, replayInitiativeStarts, replayPoolGrowth } from "../src/core/workflows/trace.js";
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
    for (const growth of Object.values(HOST_POOL_GROWTHS)) {
      expect(growth.defaultMode).toBe("shadow");
      expect(growth.modes as readonly string[]).not.toContain("on");
      expect(growth.boundBy).toContain("--budget-usd");
    }
  });

  test("replay: on the R66 trace the measured forecast warns before the park, and the host would extend at the park", () => {
    const { store, dispose } = openTrace(R66);
    try {
      // The rule before #2042 never extends: the park replays as recorded.
      expect(replayPoolGrowth(store, () => null).flatMap((i) => i.poolGrowth)).toEqual([]);
      const [nodepluck] = replayPoolGrowth(store);
      expect(nodepluck?.poolGrowth).toEqual([{ featureId: "select", seq: 28, recorded: "hold", replayed: "extend", limitTokens: POOL, toTokens: 33_100_000 }]);
      expect(nodepluck?.newPoolGrowth).toBe(1);
    } finally {
      dispose();
    }
    // Rewound with the budget and usage of each moment: syntax was accepted at 14:26:58 and lint
    // at 14:39:38 (the trace's run.state_changed events); select parked at 14:40:20.
    const syntax = Date.UTC(2026, 9, 24, 14, 26, 59, 558);
    const lint = Date.UTC(2026, 9, 24, 14, 39, 39, 627);
    const [replay] = replayInitiativeStarts(R66, { budgetAtStart: true, moments: [syntax, lint] });
    const at = (t: number) => replay?.starts.find((s) => s.at === t)?.pool;
    // With three measured features the blend weighs their 2.2x a third: 25.1M, under the pool.
    expect(at(syntax)).toMatchObject({ limitTokens: POOL, usedTokens: 15_369_363, notice: null });
    expect(at(syntax)?.forecastTokens).toBeLessThan(POOL);
    // With five, the measured 1.8x says 31.6M (the round used 33.25M): the notice, before the park.
    expect(at(lint)?.notice).toBe("At the measured 1.8x of the estimates the 10 features need about 31.6M tokens (26.7M used); the shared pool is 30.0M. Extend to 32.4M (baked workflow initiative extend nodepluck --tokens 32400000); the $30.00 cap would pay for about 33.4M at $0.90 per million.");
    // No start before then warned: the estimate's point forecast stayed under the pool.
    expect(replay?.starts.filter((s) => s.at < lint && s.pool?.notice)).toEqual([]);
    // The corpus gate replays starts on the final 38M budget, under which nothing warns.
    const [final] = replayInitiativeStarts(R66);
    expect(final?.starts.some((s) => s.pool?.notice)).toBe(false);
  }, 180000);
});

describe("scenario: a scripted initiative whose features cost more than their estimates (#2042)", () => {
  async function scenario(maxTotalTokens: number, featureUsd: number | Record<string, number>, options: { capUsd?: number | null; extendWithinDollars?: "off" | "shadow" } = {}) {
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
    expect(view.budget.forecastNotice).toMatch(/^At the estimates so far the 5 features need about 7\.\dM tokens \(2\.9M used\); the shared pool is 7\.0M\. Extend to 7\.\dM \(baked workflow initiative extend values --tokens 7\d{6}\); the \$30\.00 cap would pay for about \d+\.\dM at \$\d\.\d\d per million\.$/);
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
