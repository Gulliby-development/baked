import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { replayInitiativeStarts } from "../src/core/workflows/trace.js";
import { featureUsage, quarterBound, ROOT } from "./helpers/replay-corpus.js";

// Part of the bench-trace replay corpus (tests/forecast-replay-corpus.test.ts), in a file of its own
// because it replays every initiative start of the corpus twice and takes minutes on a CI runner.

/** Finished features below and above the range of their initiative's first replayed start. */
function rangeMisses(fewPathPrice: boolean) {
  const rounds = new Map<number, { features: number; below: number; above: number }>();
  for (const name of readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".sqlite.gz"))) {
    const path = join(ROOT, name);
    const replays = replayInitiativeStarts(path, fewPathPrice ? { fewPathPrice } : {});
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
  const last = Math.max(...rounds.keys());
  const sum = (from: number) =>
    [...rounds]
      .filter(([round]) => round >= from)
      .reduce((t, [, c]) => ({ features: t.features + c.features, below: t.below + c.below, above: t.above + c.above }), { features: 0, below: 0, above: 0 });
  return { all: sum(0), window: sum(last - 5) };
}

describe("few-path features priced at a share of their size pool (#2640)", () => {
  // Without a path fit a size pool's middle half priced a one-path feature like one of the pool's
  // usual paths, and nothing about its paths could lower its low end. With `sizing.fewPathPrice`
  // a feature below the pool's median path weight takes the square root of that share of the
  // pool's range (documentation features excepted), and a feature of legal files alone the path
  // rate. On rounds 45 to 80 (361 finished features) it moves 90 below / 72 above to 71 / 78, a
  // quarter each way being the aim; with rounds 81 to 89 replayed too (438), 114 / 86 to 88 / 92,
  // and rounds 84 to 89 from 18 / 12 to 11 / 12 of 56. The plain ratio over the median moved rounds
  // 45 to 80 to 58 / 85, past the aim, and the ratio over the first quartile (75 / 77) put three
  // of R86 binlayer's one-path medium features above their high end; the root over the first
  // quartile moved only 5 (85 / 73).
  test("fewer features below their range, both shares within their bounds, on the whole corpus and the last six rounds", () => {
    const off = rangeMisses(false);
    const on = rangeMisses(true);
    expect(on.all.features).toBe(off.all.features);
    expect(on.all.below).toBeLessThan(off.all.below);
    expect(on.all.below).toBeLessThanOrEqual(on.all.above + 0.05 * on.all.features);
    for (const share of [on.all, on.window]) {
      expect(share.below / share.features).toBeLessThanOrEqual(quarterBound(share.features));
      expect(share.above / share.features).toBeLessThanOrEqual(quarterBound(share.features));
    }
  }, 1200000);
});
