import { afterEach, describe, expect, test } from "bun:test";
import type { ShareGateRecord } from "../src/core/workflows/initiatives/service.js";
import { splitPreviewLine } from "../src/core/workflows/initiatives/split-preview.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// Bench round 92 (#2640 follow-up): undoweave and tailclose ran with `sizing.fewPathPrice: true`.
// The preview at the split approval and every `feature.share_gate` record carried no word of the
// few-path share, so the round could not tell whether the rule priced a feature or why not (in a
// first split no finished feature of a size prices it, so it cannot). The preview and the record
// now carry, per feature, whether it applied, why, and its range before and after; off, neither.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scenario(fewPathPrice: boolean) {
  const history = await historyFixture(5, { taskShare: 0.4 });
  cleanups.push(() => history.dispose());
  const result = await plannedForecastScenario(3, 5, [history.root], {
    skeleton: false,
    approve: false,
    ...(fewPathPrice ? { fewPathPrice } : {}),
  });
  cleanups.push(() => result.fixture.dispose());
  const preview = result.initiatives.view("values").budget.preview;
  if (!preview) throw new Error("No budget preview at the split approval");
  const decision = result.view.pendingDecisions.find((d) => d.scope === "initiative")!;
  await result.initiatives.approve("values", result.identity(), {
    requestId: decision.requestId,
    digest: decision.digest,
  });
  const controller = new AbortController();
  const unwatch = result.fixture.service.store.observe((event) => {
    if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
  });
  try {
    await result.initiatives.drive("values", controller.signal);
  } finally {
    unwatch();
  }
  const gates = result.initiatives
    .events("values", 0, 1000)
    .filter((e) => e.type === "feature.share_gate")
    .map((e) => e.payload as ShareGateRecord);
  return { preview, gates };
}

describe("scenario: R92, the preview and the share-gate record name the few-path share (#2640)", () => {
  test("on: each waiting feature's record says the rule did not apply and why; the share gate records its own", async () => {
    const { preview, gates } = await scenario(true);
    expect(Object.keys(preview.fewPathShare ?? {})).toEqual(["f1", "f2", "f3"]);
    for (const record of Object.values(preview.fewPathShare ?? {})) {
      expect(record).toMatchObject({ applied: false, reason: "no-pool", paths: 1 });
      expect(record.after).toEqual(record.before);
    }
    expect(splitPreviewLine(preview)).toEndWith(" Few-path share: applied to none; kept 3 no-pool.");
    expect(gates[0]?.featureId).toBe("f1");
    expect(gates[0]?.feature.fewPathShare).toMatchObject({ applied: false, reason: "no-pool" });
  });

  test("off: neither the preview nor the share-gate record carries it", async () => {
    const { preview, gates } = await scenario(false);
    expect(preview.fewPathShare).toBeUndefined();
    expect(splitPreviewLine(preview)).not.toContain("Few-path share");
    expect(gates[0]?.featureId).toBe("f1");
    expect(gates[0]?.feature.fewPathShare).toBeUndefined();
  });
});

test("the preview line names each feature the rule priced, with its share and its low end before and after", () => {
  const preview = {
    planRevision: 1, lows: {}, expected: {}, high: {}, sumLow: 1_000_000, sumExpected: 1_500_000, sumHigh: 2_000_000,
    limitTokens: 4_000_000, capTokens: null, usdPerMillion: null, firstGate: null, suggestedTokens: null, notice: null,
    fewPathShare: {
      cli: { applied: true, reason: "fewer-paths" as const, share: 0.577, paths: 1, medianPaths: 3, before: { low: 900_000, high: 1_400_000 }, after: { low: 519_000, high: 808_000 } },
      license: { applied: true, reason: "legal" as const, paths: 1, before: { low: 600_000, high: 900_000 }, after: { low: 158_000, high: 480_000 } },
      docs: { applied: false, reason: "documentation" as const, before: { low: 550_000, high: 860_000 }, after: { low: 550_000, high: 860_000 } },
    },
  };
  expect(splitPreviewLine(preview)).toEndWith(
    " Few-path share: cli x0.577 (low 900k to 519k), license at the path rate (low 600k to 158k); kept 1 documentation.",
  );
});
