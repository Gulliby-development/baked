import { afterEach, describe, expect, test } from "bun:test";
import { startApiServer } from "../src/core/api/server.js";
import type { InitiativeView, ShareGateRecord } from "../src/core/workflows/initiatives/service.js";
import { splitPreviewLine } from "../src/core/workflows/initiatives/split-preview.js";
import { newId } from "../src/core/workflows/store.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// Bench round 81, ratdec (#2502): a 4.0M pool and a $25 cap for three features whose lows summed
// to 8.12M. The awaiting_approval view had `pool: null`, `forecastNotice: null` and no per-feature
// need, so the person extended to 5.6M on a guess, approved, and the first share gate parked
// exact-cli ten seconds later; a second extend by hand to what the cap paid for (11.8M) started it
// 5.5 minutes after. Here the history prices three chained features at 1.68M + 2.99M + 2.99M low
// (7.66M, above the 4.0M pool) and 11.5M expected, at $1.17 per million.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function awaiting() {
  const history = await historyFixture(5, { taskShare: 0.4 });
  cleanups.push(() => history.dispose());
  const result = await plannedForecastScenario(3, 5, [history.root], {
    skeleton: false,
    maxTotalTokens: 4_000_000,
    capUsd: 25,
    approve: false,
  });
  cleanups.push(() => result.fixture.dispose());
  return result;
}

// The one amount is the high end with margin (19.1M), below what the cap pays for (21.4M, #2525).
const NOTICE_END =
  "Extend to 19.1M, the high end with margin (baked workflow initiative extend values --tokens 19145290); the $25.00 cap would pay for about 21.4M at $1.17 per million.";

describe("scenario: the split approval previews the budget before approval (#2502)", () => {
  test("a 4.0M pool below the lows: the preview names the lows, the expected tokens, what the cap pays for and the park, and its amount starts the first feature", async () => {
    const { initiatives, fixture } = await awaiting();
    const view = initiatives.view("values");
    expect(view.status).toBe("awaiting_approval");
    const preview = view.budget.preview;
    expect(preview).toMatchObject({
      planRevision: 1,
      limitTokens: 4_000_000,
      usdPerMillion: 1.17,
      suggestedTokens: 19_145_290,
      firstGate: { featureId: "f1", verdict: "park" },
    });
    expect(Object.keys(preview?.lows ?? {})).toEqual(["f1", "f2", "f3"]);
    expect(preview?.sumLow).toBeGreaterThan(4_000_000);
    expect(preview?.sumExpected).toBeGreaterThan(preview?.sumLow ?? 0);
    expect(preview?.sumHigh).toBeGreaterThan(preview?.sumExpected ?? 0);
    // Above the lows: it starts every waiting feature at its low, and stays inside the cap's pool.
    expect(preview?.capTokens).toBeGreaterThanOrEqual(21_300_000);
    expect(preview?.suggestedTokens).toBeGreaterThan(preview?.sumLow ?? 0);
    expect(preview?.firstGate?.need?.low).toBe(preview?.lows.f1);
    expect(preview?.firstGate?.shareTokens).toBeLessThan(preview?.lows.f1 ?? 0);
    // The split approval ends with the forecast notice's sentence and its one-line command.
    expect(preview?.notice).toStartWith(
      "At the estimates so far the 3 features expect about 11.5M tokens and up to 15.3M at the high end",
    );
    expect(preview?.notice).toEndWith(NOTICE_END);
    expect(view.next.kind).toBe("await_split_approval");
    expect(view.next.message).toEndWith(NOTICE_END);
    // The request event carries the same preview and sentence.
    const request = initiatives.events("values").find((e) => e.type === "request.created")
      ?.payload as { kind: string; budgetPreview: { suggestedTokens: number; sumLow: number }; text: string };
    expect(request.kind).toBe("split_approval");
    expect(request.budgetPreview).toMatchObject({
      suggestedTokens: 19_145_290,
      sumLow: preview?.sumLow,
    });
    expect(request.text).toBe(preview?.notice ?? "");
    expect(splitPreviewLine(preview!)).toContain("the first share gate would park f1");

    // Applied before approval, the amount starts the first feature without a park.
    await initiatives.extendBudget(
      "values",
      { commandId: newId(), expectedRevision: view.revision },
      { maxTotalTokens: 19_145_290 },
    );
    const extended = initiatives.view("values");
    expect(extended.budget.preview?.firstGate?.verdict).toBe("pass");
    expect(extended.budget.preview?.suggestedTokens).toBeNull();
    const decision = extended.pendingDecisions.find((d) => d.scope === "initiative")!;
    await initiatives.approve(
      "values",
      { commandId: newId(), expectedRevision: extended.revision },
      { requestId: decision.requestId, digest: decision.digest },
    );
    expect(initiatives.view("values").budget.preview).toBeNull();
    const controller = new AbortController();
    const unwatch = fixture.service.store.observe((event) => {
      if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
    });
    try {
      await initiatives.drive("values", controller.signal);
    } finally {
      unwatch();
    }
    const gates = initiatives
      .events("values", 0, 1000)
      .filter((e) => e.type === "feature.share_gate")
      .map((e) => e.payload as ShareGateRecord);
    expect(gates[0]).toMatchObject({ featureId: "f1", verdict: "pass" });
    expect(gates.filter((g) => g.verdict === "park")).toEqual([]);
  });

  test("headless: initiative show and the drive at the split approval print the preview", async () => {
    const { initiatives } = await awaiting();
    const signal = new AbortController().signal;
    for (const argv of [["show", "values"], ["drive", "values"]]) {
      const shown = (await executeInitiativeCommand(
        initiatives,
        parseInitiativeArgs(argv),
        signal,
      )) as InitiativeView;
      expect(shown.budget.preview).toMatchObject({
        suggestedTokens: 19_145_290,
        firstGate: { featureId: "f1", verdict: "park" },
      });
      expect(shown.next.message).toEndWith(NOTICE_END);
    }
  });

  test("API: GET /v1/initiatives/:id serves the preview and the split approval's extend", async () => {
    const { initiatives, fixture } = await awaiting();
    const server = await startApiServer({ service: fixture.service, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
    });
    const response = await fetch(`${server.url}/v1/initiatives/values`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    const served = (await response.json()) as InitiativeView;
    expect(served.budget.preview).toEqual(initiatives.view("values").budget.preview);
    expect(served.budget.preview?.suggestedTokens).toBe(19_145_290);
    expect(served.next.message).toEndWith(NOTICE_END);
    expect(served.next.recovery?.remedies).toEqual([
      { action: "extend", initiativeId: "values", suggestedTokens: 19_145_290 },
    ]);
  });
});
