import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { replayInitiativeStarts } from "../src/core/workflows/trace.js";
import { featureUsage, quarterBound, ROOT } from "./helpers/replay-corpus.js";

// Part of the bench-trace replay corpus (tests/forecast-replay-corpus.test.ts), in a file of its own
// because it replays each initiative's first start over the whole corpus twice.

/** Finished features below and above the range of their initiative's first replayed start, by round. */
function rangeMisses(options: { recencyHalfLife?: number } = {}) {
  // Only the first start's estimate is read, so the later starts are rewound through, not priced.
  const rounds = new Map<number, { features: number; below: number; above: number }>();
  for (const name of readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".sqlite.gz"))) {
    const path = join(ROOT, name);
    const replays = replayInitiativeStarts(path, { ...options, firstStartOnly: true });
    if (!replays.length) continue;
    const { used, finished } = featureUsage(path);
    const round = Number(/R(\d+)/.exec(name)?.[1]);
    const counts = rounds.get(round) ?? { features: 0, below: 0, above: 0 };
    for (const replay of replays)
      for (const f of replay.starts[0]?.estimate ?? []) {
        const tokens = used.get(f.featureId);
        if (tokens === undefined || !finished.has(f.featureId)) continue;
        counts.features++;
        if (tokens < f.low) counts.below++;
        if (tokens > f.high) counts.above++;
      }
    rounds.set(round, counts);
  }
  /** The rounds from `from` to `to`, both included. */
  const sum = (from: number, to = Number.POSITIVE_INFINITY) =>
    [...rounds]
      .filter(([round]) => round >= from && round <= to)
      .reduce((t, [, c]) => ({ features: t.features + c.features, below: t.below + c.below, above: t.above + c.above }), { features: 0, below: 0, above: 0 });
  // The window is the last rounds the corpus holds, not the last round numbers: traces pull requests
  // land out of order, and R87's on a main that ended at R80 made a window of R87 alone, 6 features
  // whose two standard errors no single round's spread fits (#2753).
  const held = [...rounds.keys()].sort((a, b) => a - b);
  const window = held.slice(-RANGE_WINDOW);
  return { all: sum(0), window: sum(window[0] ?? 0), windowRounds: window, r63to68: sum(63, 68) };
}

/** Rounds of the corpus the rolling window holds, the last ones it has (#2150). */
const RANGE_WINDOW = 6;

describe("the size pools' ranges over the last rounds (#2150)", () => {
  // The whole-corpus share hides a trend: rounds 63 to 68 put 24 of 60 finished features below
  // their range (40%, above the 36.2% bound of 60), rounds 45 to 61 37 of 156 (24%). 20 of the 24
  // were priced by the size pool, which weighs round 45's features as much as the last round's.
  // `sizing.recencyHalfLife: 2` halves a feature's weight for every two initiatives started after
  // its own: rounds 63 to 68 then put 20 of 60 (33.3%) below, and the whole corpus stays within
  // its bounds. The rolling window is bounded by default too: with round 69 it is rounds 64 to
  // 69, 16 of 59 below and 11 above, within the bounds without the weighting (12 and 18 with it).
  // Round 73 turned the window against the weighting: rounds 68 to 73 put 27 of 72 features above
  // their range with it (37.5%, above the 35.2% bound of 72; R73 alone 9 of 18: flatelens, the
  // first Lua initiative, 6 of 8, evalpin 3 of 10) and 21 above, 10 below without it. The
  // weighting stays opt-in and is not to be switched on on these figures: it fixes rounds 63 to
  // 68 and the whole corpus, not the last six rounds.
  // R74 ladlemath, the first PHP initiative, put 7 of its 12 features above their range, and
  // rounds 70 to 75 at 31 of 90 above (the bound is 30.7). A language with fewer than three
  // finished features in the pool now gets a high end from first-language ratios (#2398): 17 of
  // 90 above, ladlemath 1, flatelens 4.
  // The R87, R90 and R91 traces put the window above the bound below the range: R83 to R91 at 23
  // of 62 (37.1%, the bound 36.0%; R87's alone 22 of 54 and R90's 22 of 57 on the mains they were
  // opened on), 11 of them medium features of one to three paths priced at the no-fit medium
  // pool's low end (1.11M-1.25M). The few-path share (#2640), the default since #2893, prices
  // them at the root of their share of the pool's median paths: 15 of 62. It brings rounds 63 to
  // 68 within the bound by default too, from 24 of 60 below to 18.
  test("rounds 63 to 68 and the rolling window are within the bound by default and at a half-life of 2", () => {
    const off = rangeMisses();
    expect(off.r63to68.features).toBe(60);
    expect(off.r63to68.below / off.r63to68.features).toBeLessThanOrEqual(quarterBound(off.r63to68.features));
    expect(off.r63to68.above / off.r63to68.features).toBeLessThanOrEqual(quarterBound(off.r63to68.features));
    const on = rangeMisses({ recencyHalfLife: 2 });
    for (const share of [on.r63to68, on.all]) {
      expect(share.below / share.features).toBeLessThanOrEqual(quarterBound(share.features));
      expect(share.above / share.features).toBeLessThanOrEqual(quarterBound(share.features));
    }
    expect(on.r63to68.below).toBeLessThan(off.r63to68.below);
    // The standing guard: the last six rounds, as the whole corpus is, within the bounds by default.
    expect(off.windowRounds).toHaveLength(RANGE_WINDOW);
    expect(off.window.below / off.window.features).toBeLessThanOrEqual(quarterBound(off.window.features));
    expect(off.window.above / off.window.features).toBeLessThanOrEqual(quarterBound(off.window.features));
  }, 1200000);
});
