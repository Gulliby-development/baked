import { afterEach, describe, expect, test } from "bun:test";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { suggestedExtension } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { startApiServer } from "../src/core/api/server.js";
import { type InitiativeView, splitDollarPool } from "../src/core/workflows/initiatives/service.js";
import { type PoolInputs, tokenPool } from "../src/core/workflows/initiatives/token-pool.js";
import { initiativeActions } from "../src/core/workflows/initiatives/view-model.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// Bench round 71, xmlvet (#2244): a 30.0M token pool beside a $30 cap at about $0.85 per million.
// The cap paid for about 35M tokens; the split approval said nothing about the pool, the token
// notice advised 31.6M at 1.7x and 50.9M at 3.1x, and the pool stopped every feature for 19.6
// minutes with dollars left. The round used 35.84M.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: the split approval names the pool the dollar cap pays for (#2244)", () => {
  async function awaiting(maxTotalTokens: number, capUsd: number | null = 30) {
    const history = await historyFixture(1, { taskShare: 0.4 });
    cleanups.push(() => history.dispose());
    const result = await plannedForecastScenario(5, 1, [history.root], { skeleton: false, maxTotalTokens, capUsd, approve: false });
    cleanups.push(() => result.fixture.dispose());
    return result;
  }

  test("a $30 cap that pays for more than a 20.0M pool warns and offers --tokens at what it pays for, on every surface", async () => {
    // The history prices the waiting features at $1.17 per million: $30 pays for 25.6M tokens.
    const { initiatives, fixture } = await awaiting(20_000_000);
    const view = initiatives.view("values");
    expect(view.next.kind).toBe("await_split_approval");
    expect(view.next.message).toStartWith("The $30.00 cap pays for about 25.6M tokens at $1.17 per million, the estimate's price for the waiting features, more than the shared pool (20.0M): the pool, not the dollar cap, would stop features first.");
    expect(view.next.message).toContain(`Use baked workflow initiative extend values --tokens 25600000 --expected-revision ${view.revision}.`);
    expect(view.next.recovery?.remedies).toEqual([{ action: "extend", initiativeId: "values", suggestedTokens: 25_600_000 }]);
    // TUI: the next line and the B form's amount.
    expect(tuiRecoveryText(view.next.message, view.next.recovery)).toContain("the pool, not the dollar cap, would stop features first");
    expect(initiativeActions(view, false).find((a) => a.key === "B")?.input?.initial).toBe("25600000");
    // Desktop: the same view through the local API, its text and its one-click extend.
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => { await server.stop(); });
    const response = await fetch(`${server.url}/v1/initiatives/values`, { headers: { Authorization: `Bearer ${server.token}` } });
    const served = (await response.json()) as InitiativeView;
    expect(served.next.recovery).toEqual(view.next.recovery);
    expect(desktopRecoveryText(served.next.message, served.next.recovery)).toContain("The $30.00 cap pays for about 25.6M tokens");
    expect(suggestedExtension(served)).toEqual({ tokens: 25_600_000 });
    // Headless: `initiative show` prints the same next step.
    const shown = (await executeInitiativeCommand(initiatives, parseInitiativeArgs(["show", "values"]), new AbortController().signal)) as InitiativeView;
    expect(shown.next).toEqual(view.next);
    // Extending to the suggested pool leaves nothing to warn about.
    const extended = await initiatives.extendBudget("values", { commandId: "extend-to-dollars", expectedRevision: view.revision }, { maxTotalTokens: 25_600_000 });
    expect(extended.next.message).toBe("Approve the split (plan revision 1) or edit it.");
  }, 120000);

  test("a pool above what the cap pays for, or a pool without a cap, says nothing", async () => {
    for (const [pool, cap] of [[30_000_000, 30], [20_000_000, null]] as const) {
      const { initiatives } = await awaiting(pool, cap);
      const view = initiatives.view("values");
      expect(view.next.message).toBe("Approve the split (plan revision 1) or edit it.");
      expect(view.next.recovery).toBeUndefined();
    }
  }, 240000);

  test("xmlvet's numbers: $30 at $0.87 per million against 30.0M names 34.4M, inside the dollars", () => {
    const view = { budget: { used: { tokens: 0 }, cost: { capUsd: 30, spentUsd: 0 } } };
    // Five waiting features priced at $0.87 per million at their lows.
    const waiting = Array.from({ length: 5 }, () => ({ tokens: { low: 2_000_000, high: 4_000_000 }, costUsd: { low: 1.74, high: 3.48 } }));
    expect(splitDollarPool(view, waiting, 30_000_000)).toEqual({ capUsd: 30, usdPerMillion: expect.closeTo(0.87, 9), tokens: 34_400_000 });
    // Dollars already spent are paid at their own rate: the used tokens count, the rest is priced.
    const spent = { budget: { used: { tokens: 4_000_000 }, cost: { capUsd: 30, spentUsd: 6 } } };
    expect(splitDollarPool(spent, waiting, 30_000_000)?.tokens).toBe(31_500_000);
    expect(splitDollarPool(view, waiting, 34_500_000)).toBeNull();
    expect(splitDollarPool(view, [{ tokens: { low: 1, high: 2 }, costUsd: null }], 30_000_000)).toBeNull();
  });
});

describe("scenario: the forecast notice advises the pool the dollar cap pays for, whatever the ratio (#2244)", () => {
  // 20.0M used for $17.40: $0.87 per million, so the $30 cap pays for 34.4M tokens.
  const inputs = (ratio: number, capUsd: number | null = 30): PoolInputs => ({
    initiativeId: "xmlvet",
    limitTokens: 30_000_000,
    usedTokens: 20_000_000,
    committedTokens: 22_000_000,
    forecastTokens: Math.round(20_000_000 + 7_000_000 * Math.min(ratio, 1.3)),
    ratio: Math.min(ratio, 1.3),
    advice: { forecastTokens: Math.round(20_000_000 + 7_000_000 * ratio), ratio },
    features: 8,
    waiting: [{ id: "outline-command", low: 1_900_000, high: 5_600_000 }],
    cost: { capUsd, ceilingUsd: capUsd === null ? null : capUsd * 1.25, spentUsd: 17.4, remainingUsd: capUsd === null ? null : capUsd - 17.4, forecastUsd: 31.4 },
  });

  test("at 1.7x and at 3.0x the notice advises the same 34.4M", () => {
    const low = tokenPool(inputs(1.7));
    const high = tokenPool(inputs(3));
    expect(low.suggestedTokens).toBe(34_400_000);
    expect(high.suggestedTokens).toBe(34_400_000);
    expect(low.notice).toBe("At the measured 1.7x of the estimates the 8 features need about 31.9M tokens (29.1M at the blended 1.3x that budget decisions use; 20.0M used); the shared pool is 30.0M. Extend to 34.4M, what the $30.00 cap pays for at $0.87 per million, so the pool stops no feature before the dollar cap does (baked workflow initiative extend xmlvet --tokens 34400000).");
    expect(high.notice).toContain("need about 41.0M tokens");
    expect(high.notice).toContain("Extend to 34.4M, what the $30.00 cap pays for at $0.87 per million");
  });

  test("without a cap, or with a cap that pays for less than the pool, the ratio forecast advises as before", () => {
    expect(tokenPool(inputs(1.7, null)).suggestedTokens).toBe(31_900_000);
    expect(tokenPool(inputs(3, null)).suggestedTokens).toBe(41_000_000);
    const short = tokenPool(inputs(1.7, 25));
    expect(short.suggestedTokens).toBe(31_900_000);
    expect(short.notice).toEndWith("Extend to 31.9M (baked workflow initiative extend xmlvet --tokens 31900000); the $25.00 cap would pay for about 28.7M at $0.87 per million.");
    // A forecast that fits the pool advises nothing, whatever the cap pays for.
    expect(tokenPool({ ...inputs(1), advice: null })).toMatchObject({ notice: null, suggestedTokens: null });
  });
});
