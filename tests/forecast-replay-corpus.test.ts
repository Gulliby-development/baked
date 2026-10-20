import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { callCostRate, costRate } from "../src/core/workflows/budget.js";
import { shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { forecastSamples } from "../src/core/workflows/stage-price.js";
import { type CallRate, openTrace, replayInitiativeStarts, replayTrace } from "../src/core/workflows/trace.js";

// #1649, #1715: every recorded bench-round trace replays through the current host decisions: the
// forecast and cap code, the per-call cost cap (#1740), the first-response deadline of each model
// call, and the initiative share gate (#1707), asked both on its recorded inputs and with each start
// rewound and recomputed. A stop, cap growth or park the recorded run did not make fails the suite, unless
// accepted.json lists it for that run or initiative with the reason: the pull request that changes
// the decision says so in its diff.
const ROOT = join(import.meta.dir, "fixtures", "bench-traces");

interface Accepted {
  newStops?: number;
  newGrowth?: number;
  newFirstByteStops?: number;
  newCostStops?: number;
  newShareStops?: number;
  newStartStops?: number;
  reason: string;
}

function traces(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? traces(join(dir, entry.name))
      : entry.name.endsWith(".sqlite.gz")
        ? [join(dir, entry.name)]
        : [],
  ).sort();
}

const accepted = JSON.parse(readFileSync(join(ROOT, "accepted.json"), "utf8")) as Record<string, Accepted>;

describe("bench-round traces replay without new forecast stops or growth (#1649)", () => {
  const found = traces(ROOT);
  test("every accepted deviation names a trace in the corpus and a reason", () => {
    const names = new Set(found.map((path) => relative(ROOT, path).replaceAll("\\", "/")));
    for (const [key, entry] of Object.entries(accepted)) {
      expect(names.has(key.split("#")[0] ?? "")).toBe(true);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });
  for (const path of found) {
    const name = relative(ROOT, path).replaceAll("\\", "/");
    test(name, () => {
      const replay = replayTrace(path);
      for (const run of replay.runs) {
        const allowed = accepted[`${name}#${run.runId}`];
        const stops = run.boundaries.filter((b) => b.replayed === "stop" && b.recorded !== "stop");
        const growth = run.boundaries.filter((b) => b.replayed === "grow" && b.recorded === "pass");
        expect({
          run: run.runId,
          newStops: stops.length,
          newGrowth: growth.length,
          newFirstByteStops: run.newFirstByteStops,
          newCostStops: run.newCostStops,
        }).toEqual({
          run: run.runId,
          newStops: allowed?.newStops ?? 0,
          newGrowth: allowed?.newGrowth ?? 0,
          newFirstByteStops: allowed?.newFirstByteStops ?? 0,
          newCostStops: allowed?.newCostStops ?? 0,
        });
      }
      for (const initiative of replay.initiatives) {
        const allowed = accepted[`${name}#${initiative.initiativeId}`];
        expect({
          initiative: initiative.initiativeId,
          newShareStops: initiative.newShareStops,
          newStartStops: initiative.newStartStops,
        }).toEqual({
          initiative: initiative.initiativeId,
          newShareStops: allowed?.newShareStops ?? 0,
          newStartStops: allowed?.newStartStops ?? 0,
        });
      }
    }, 120000);
  }
});

describe("the first-response deadline replays on recorded calls (#1715)", () => {
  test("the 60 s limit of #1613 ends R50's buffered spec calls as outages, current main does not (#1639)", () => {
    for (const name of ["R50/url-shortener.sqlite.gz", "R50/md-site.sqlite.gz"]) {
      const path = join(ROOT, name);
      const old = replayTrace(path, { firstByteLimit: () => 60_000 }).runs.flatMap((r) =>
        r.firstByte.filter((b) => b.replayed === "stop" && b.recorded === "pass"),
      );
      expect(old.map((b) => [b.provider, b.stage])).toContainEqual(["codex", "spec"]);
      expect(old.every((b) => b.firstByteMs !== null && b.firstByteMs > 60_000)).toBe(true);
      expect(replayTrace(path).runs.reduce((n, r) => n + r.newFirstByteStops, 0)).toBe(0);
    }
  }, 120000);
});

describe("initiative starts replay on rewound traces (#1707)", () => {
  const selwhy = join(ROOT, "R50", "selwhy.sqlite.gz");
  // Before #1659 a forecast over the ceiling stopped the next start from the first measured feature.
  const bindingAtOnce: Parameters<typeof replayInitiativeStarts>[1] = {
    gate: (view, feature) =>
      shareShortfall({ ...view, budget: { ...view.budget, cost: { ...view.budget.cost, forecastBinding: true } } }, feature),
  };

  test("#1643: selwhy at 1 of 12 forecasts near its final cost on main, and a forecast without measured prices stops it", () => {
    const [current] = replayInitiativeStarts(selwhy);
    expect(current?.finalUsd).toBeCloseTo(23.63, 2);
    const start = current?.starts.find((b) => b.featureId === "selector-core");
    expect(start).toMatchObject({ accepted: 1, features: 12, spentUsd: 0.72, ceilingUsd: 37.5, replayed: "pass" });
    expect(start!.forecastUsd!).toBeGreaterThan(23.63 * 0.75);
    expect(start!.forecastUsd!).toBeLessThan(23.63 * 1.25);
    expect(current?.newStartStops).toBe(0);
    expect(replayInitiativeStarts(selwhy, bindingAtOnce)[0]?.newStartStops).toBe(0);

    // R50 stopped here on $72.98 against the $37.50 ceiling. The commit before #1644 (0ff8dac3)
    // forecasts $71.49 on this rewound trace. Its price samples alone, the run's own usage, still
    // forecast well above main; with none at all the start stops as it did in R50.
    const own = replayInitiativeStarts(selwhy, { priceSamples: (store, runIds) => forecastSamples(store, runIds) })[0];
    expect(own?.starts.find((b) => b.featureId === "selector-core")?.forecastUsd).toBeGreaterThan(start!.forecastUsd! * 1.3);
    const unmeasured = replayInitiativeStarts(selwhy, { ...bindingAtOnce, priceSamples: () => [] })[0];
    const stopped = unmeasured?.starts.find((b) => b.featureId === "selector-core");
    expect(stopped?.replayed).toBe("park");
    expect(stopped!.forecastUsd!).toBeGreaterThan(stopped!.ceilingUsd!);
  }, 120000);

  test("the rewound forecast is the one the runner recorded: R52 srcwhere's advisory at vlq", () => {
    // The runner's advisory (cost.forecast_advisory) said $46.80 at 2 of 12. Planned features are
    // routed with the runner's model routing from the trace; on the default routing every stage ran
    // on the initiative's model and the replay said $49.99.
    const [replay] = replayInitiativeStarts(join(ROOT, "R52", "srcwhere.sqlite.gz"));
    expect(replay?.starts.find((b) => b.featureId === "vlq")).toMatchObject({ accepted: 2, forecastUsd: 46.8, replayed: "pass" });
  }, 120000);

  test("the rewind sees only what existed at each start, its history stores included", () => {
    const [replay] = replayInitiativeStarts(selwhy);
    const starts = replay!.starts;
    expect(starts.map((b) => b.featureId)[0]).toBe("skeleton");
    expect(starts.every((b, i) => i === 0 || b.at >= starts[i - 1]!.at)).toBe(true);
    expect(starts.every((b, i) => i === 0 || b.spentUsd >= starts[i - 1]!.spentUsd)).toBe(true);
    expect(starts.at(-1)!.spentUsd).toBeLessThan(replay!.finalUsd!);
    // R45 to R49 are in the corpus; the stores before them are not.
    expect(replay!.missingHistory).toHaveLength(14);
    expect(replay!.missingHistory.some((p) => p.includes("R49/shexpand"))).toBe(false);
    const none = replayInitiativeStarts(selwhy, { historyTrace: () => null })[0]!;
    expect(none.missingHistory).toHaveLength(19);
    expect(none.starts.find((b) => b.featureId === "selector-core")?.forecastUsd).not.toBe(
      starts.find((b) => b.featureId === "selector-core")?.forecastUsd,
    );
  }, 120000);
});

describe("the per-call cost cap replays on recorded reservations (#1740)", () => {
  // The rate before #1740: a stage without finished attempts took the run's blended price so far.
  const blended: CallRate = (store, runId, stage, model, samples = []) => {
    const priced = samples.filter((a) => a.status !== "running" && a.costUsd !== null && (a.usedTokens ?? 0) > 0);
    if (priced.some((a) => a.stage === stage)) return callCostRate(store, runId, stage, model, samples);
    const run = store.run(runId);
    const spent = run.estimated_cost_microusd !== null
      ? run.estimated_cost_microusd / 1e6
      : priced.length ? priced.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) : null;
    return costRate(spent, run.token_usage, model);
  };
  const path = join(ROOT, "R51/commitbump-update.sqlite.gz");

  test("a stage's first call is priced near what it paid, on its own model and mix (R51 commitbump-update)", () => {
    const paid = new Map<string, number>();
    const { store, dispose } = openTrace(path);
    try {
      for (const run of store.connection.query("SELECT id FROM runs").all() as { id: string }[])
        for (const a of forecastSamples(store, [run.id]))
          if (a.costUsd !== null && a.usedTokens) paid.set(a.attemptId, a.costUsd / a.usedTokens);
    } finally {
      dispose();
    }
    const firstCalls = (rate?: CallRate) => {
      const seen = new Set<string>();
      return replayTrace(path, rate ? { callRate: rate } : {}).runs.flatMap((run) =>
        run.costCap.filter((b) => !seen.has(b.stage) && seen.add(b.stage) && paid.has(b.attemptId)),
      );
    };
    const off = (b: { attemptId: string; requestedUsd: number; tokens: number }) =>
      Math.abs(Math.log(b.requestedUsd / b.tokens / (paid.get(b.attemptId) ?? 1)));
    const before = new Map(firstCalls(blended).map((b) => [b.stage, off(b)]));
    const after = new Map(firstCalls().map((b) => [b.stage, off(b)]));
    // Planning ran one-step Opus calls that never read the cache; the blended price of research
    // before them priced specify at a twentieth of what it paid, and the first Sonnet task call
    // at about three times.
    for (const stage of ["specify", "plan", "implement"]) {
      expect(before.get(stage)).toBeGreaterThan(Math.log(2));
      expect(after.get(stage)).toBeLessThan(Math.log(2.5));
    }
  }, 120000);

  test("a rate that prices every call above the cap stops the recorded attempts, the current one does not", () => {
    const stops = (rate?: CallRate) =>
      replayTrace(path, rate ? { callRate: rate } : {}).runs.reduce((n, run) => n + run.newCostStops, 0);
    expect(stops(() => 1)).toBeGreaterThan(0);
    expect(stops()).toBe(0);
  }, 120000);
});
