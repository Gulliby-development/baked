import { afterEach, describe, expect, test } from "bun:test";
import { costText } from "../src/core/workflows/initiatives/forms.js";
import { type InitiativeView, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeEvent } from "../src/core/workflows/initiatives/store.js";
import { costLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// #1714: the initiative's forecast stop is the registered reason `initiative-forecast`. In shadow
// or advisory mode a binding forecast above the ceiling records what it would have stopped and
// the next feature starts, so a bench round measures the stop before it can hold an initiative.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const wouldStops = (events: InitiativeEvent[]) => events.filter((e) => e.type === "decision.would_stop");

async function scenario(mode?: "shadow" | "advisory") {
  // The eleven features after the skeleton forecast about $44.69 against the $37.50 ceiling.
  const history = await historyFixture((44.69 - 0.62) / 11);
  cleanups.push(() => history.dispose());
  const run = await plannedForecastScenario(12, 0.62, [history.root], {
    forecastStop: true,
    ...(mode ? { stopModes: { "initiative-forecast": mode } } : {}),
  });
  cleanups.push(() => run.fixture.dispose());
  return run;
}

async function driveOnce(run: Awaited<ReturnType<typeof scenario>>): Promise<InitiativeView> {
  const controller = new AbortController();
  const unwatch = run.fixture.service.store.observe((event) => {
    if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
  });
  try { return await run.initiatives.drive("values", controller.signal); } finally { unwatch(); }
}

describe("scenario: the initiative forecast stop in shadow and advisory mode (#1714)", () => {
  test("enforce, the default, holds the next feature on a binding forecast", async () => {
    const { view } = await scenario();
    expect(view.budget.cost).toMatchObject({ forecastBinding: true, forecastMode: "enforce", forecastNotice: null });
    expect(view.budget.cost.forecastUsd).toBeGreaterThan(37.5);
    expect(shareShortfall(view, view.features[1]!)?.message).toContain("above its $37.50 ceiling");
  }, 60000);

  for (const mode of ["shadow", "advisory"] as const)
    test(`${mode}: the next feature starts and the would-stop is recorded once`, async () => {
      const run = await scenario(mode);
      const cost = run.view.budget.cost;
      expect(cost).toMatchObject({ forecastBinding: true, forecastMode: mode });
      expect(cost.forecastUsd).toBeGreaterThan(37.5);
      expect(shareShortfall(run.view, run.view.features[1]!)).toBeNull();
      expect(run.view.next).toMatchObject({ kind: "start", featureId: "f2" });
      if (mode === "advisory") {
        expect(cost.forecastNotice).toContain("The forecast stop is advisory");
        expect(costText(cost)).toContain("(advisory)");
        expect(costLine(run.view)).toContain("(advisory)");
      } else {
        expect(cost.forecastNotice).toBeNull();
        expect(costText(cost)).not.toContain("advisory");
      }

      const driven = await driveOnce(run);
      expect(driven.features.find((f) => f.id === "f2")?.runId).not.toBeNull();
      const records = wouldStops(run.initiatives.events("values"));
      expect(records).toHaveLength(1);
      expect(records[0]?.payload).toMatchObject({
        reason: "initiative-forecast",
        mode,
        featureId: "f2",
        key: "usd-m0",
        inputs: { ceilingUsd: 37.5, measuredFeatures: 0 },
      });
      expect((records[0]?.payload as { summary: string }).summary).toContain("f2 would not start");
    }, 120000);
});
