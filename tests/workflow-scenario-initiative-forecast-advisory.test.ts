import { afterEach, describe, expect, test } from "bun:test";
import { startApiServer } from "../src/core/api/server.js";
import { costText } from "../src/core/workflows/initiatives/forms.js";
import { type InitiativeView, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { FORECAST_BINDING_FEATURES, type InitiativeEvent } from "../src/core/workflows/initiatives/store.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { costLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// R50 selwhy (#1659): after the $0.62 skeleton, the forecast said $44.69, then $72.98 under the
// next formula, against a $37.50 ceiling. Each stopped the initiative for a person, 2 h 24 min in
// all, and the initiative finished at $23.53. A forecast from no measured feature only advises.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const advisories = (events: InitiativeEvent[]) => events.filter((e) => e.type === "cost.forecast_advisory");

describe("scenario: an initiative forecast from the skeleton alone advises (#1659, R50 selwhy)", () => {
  for (const forecast of [44.69, 72.98])
    test(`a $${forecast} forecast against the $37.50 ceiling starts the next feature and notes it once`, async () => {
      // History prices each planned feature so that the eleven after the skeleton forecast about `forecast`.
      const history = await historyFixture((forecast - 0.62) / 11);
      cleanups.push(() => history.dispose());
      const { fixture, initiatives, view } = await plannedForecastScenario(12, 0.62, [history.root]);
      cleanups.push(() => fixture.dispose());
      const cost = view.budget.cost;
      expect(cost).toMatchObject({ ceilingUsd: 37.5, measuredFeatures: 0, forecastBinding: false });
      expect(cost.forecastUsd).toBeGreaterThan(37.5);
      expect(cost.forecastNotice).toContain(`advisory until ${FORECAST_BINDING_FEATURES} features are measured (0 so far)`);
      expect(costText(cost)).toContain("(advisory: 0 measured features)");
      expect(costLine(view)).toContain("(advisory: 0 measured features)");
      expect(shareShortfall(view, view.features[1]!)).toBeNull();
      expect(view.next).toMatchObject({ kind: "start", featureId: "f2" });

      // The next drive starts f2 and records the warning once.
      const controller = new AbortController();
      const unwatch = fixture.service.store.observe((event) => {
        if (event.type === "run.state_changed" && event.payload.to === "completed") controller.abort();
      });
      let driven: InitiativeView;
      try { driven = await initiatives.drive("values", controller.signal); } finally { unwatch(); }
      expect(driven.features.find((f) => f.id === "f2")?.runId).not.toBeNull();
      const notes = advisories(initiatives.events("values"));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.payload).toMatchObject({ featureId: "f2", ceilingUsd: 37.5, measuredFeatures: 0 });

      // The headless CLI and the local API show the same event.
      const cli = await executeInitiativeCommand(initiatives, parseInitiativeArgs(["events", "values"]), controller.signal);
      expect(advisories(cli as InitiativeEvent[])).toEqual(notes);
      const server = await startApiServer({ service: fixture.service, log: () => {} });
      cleanups.push(async () => { await server.stop(); });
      const response = await fetch(`${server.url}/v1/initiatives/values/events`, { headers: { Authorization: `Bearer ${server.token}`, Accept: "application/json" } });
      expect(response.status).toBe(200);
      expect(advisories(((await response.json()) as { events: InitiativeEvent[] }).events)).toEqual(notes);
    }, 60000);

  test("money spent and reserved still stops a start, and a measured forecast stops it too", async () => {
    const history = await historyFixture(44.07 / 11);
    cleanups.push(() => history.dispose());
    const { fixture, view } = await plannedForecastScenario(12, 0.62, [history.root]);
    cleanups.push(() => fixture.dispose());
    const next = view.features[1]!;
    // The dollars left after what was spent and what open runs hold do not cover a start.
    const spent = { ...view, features: view.features.map((f) => (f.id === next.id ? { ...f, shareUsd: 0 } : f)) };
    expect(shareShortfall(spent, { ...next, shareUsd: 0 })?.message).toContain("The shared dollar budget is exhausted");
    // Five measured features make the same forecast binding.
    const measured = { ...view, budget: { ...view.budget, cost: { ...view.budget.cost, measuredFeatures: FORECAST_BINDING_FEATURES, forecastBinding: true, forecastNotice: null } } };
    expect(shareShortfall(measured, next)?.message).toContain("above its $37.50 ceiling");
  }, 60000);
});
