import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { suggestedExtension } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { startApiServer } from "../src/core/api/server.js";
import {
  type InitiativeView,
  planChargedGate,
  poolGrowthOf,
  type ShareGateRecord,
  type ShareGateView,
  shareShortfall,
} from "../src/core/workflows/initiatives/service.js";
import { stageReserveDecision } from "../src/core/workflows/initiatives/growth.js";
import { adviceRatio, decisionRatio, HOST_POOL_GROWTHS, planCharge, poolExtensionDecision, poolForecast, tokenPool } from "../src/core/workflows/initiatives/token-pool.js";
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
    for (const [reason, growth] of Object.entries(HOST_POOL_GROWTHS)) {
      expect(growth.defaultMode).toBe("shadow");
      // Growing for real is opt-in only where its pull request says so (#2241's stage reserve);
      // making it the default is a pull request of its own.
      if (reason !== "stage-reserve") expect(growth.modes as readonly string[]).not.toContain("on");
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
  async function sized(mode?: "shadow" | "enforce") {
    const history = await historyFixture(1, { taskShare: 0.4 });
    cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(5, 1, [history.root], { skeleton: false, maxTotalTokens: 30_000_000, ...(mode ? { stopModes: { "initiative-plan-charge": mode } } : {}) });
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
