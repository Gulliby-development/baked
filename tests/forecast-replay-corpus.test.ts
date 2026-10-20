import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { forecastSamples } from "../src/core/workflows/forecast-price.js";
import { shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { replayInitiativeStarts, replayTrace } from "../src/core/workflows/trace.js";

// #1649, #1715: every recorded bench-round trace replays through the current host decisions: the
// forecast and cap code, the first-response deadline of each model call, and the initiative share
// gate (#1707), asked both on its recorded inputs and with each start rewound and recomputed. A stop, cap growth or park the recorded run did not make fails the suite, unless
// accepted.json lists it for that run or initiative with the reason: the pull request that changes
// the decision says so in its diff.
const ROOT = join(import.meta.dir, "fixtures", "bench-traces");

interface Accepted {
  newStops?: number;
  newGrowth?: number;
  newFirstByteStops?: number;
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
        }).toEqual({
          run: run.runId,
          newStops: allowed?.newStops ?? 0,
          newGrowth: allowed?.newGrowth ?? 0,
          newFirstByteStops: allowed?.newFirstByteStops ?? 0,
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
