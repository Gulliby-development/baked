import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { replayInitiativeStarts } from "../src/core/workflows/trace.js";
import { featureUsage, ROOT } from "./helpers/replay-corpus.js";

// Part of the bench-trace replay corpus (tests/forecast-replay-corpus.test.ts), in a file of its own
// because it replays every initiative start of the corpus and takes minutes on a CI runner.

describe("initiative feature ranges replay against what the features used (#1806, #1813)", () => {
  // At each initiative's first replayed start, the features that used less than the low end of
  // the range the current estimate gives them, and more than its high end. A feature's range is
  // the middle half of comparable finished features, so a quarter of the features fall below it
  // and a quarter above by construction. The bound is that quarter plus two standard errors of a
  // share of n features (sqrt(0.25 * 0.75 / n)): a share at exactly a quarter fails about half the
  // time by chance, as R57 did (33 of 130, 25.4%, modeplan's four cheap 4-path C# features below
  // the medium pool's 1.19M; R51 sedstep, also C#, was above, so the language is no signal), while
  // the first-quartile path floor #1806 removed (37 of 104, 36%, against 33.5%) still fails it.
  // A share, not a count, so each round's new traces keep the bound (a count of 29 failed when R55
  // added routeshadow's 2 of 10). R45-R54: a path floor at the first quartile put 37 of 104 below,
  // 11 of R54 lanewalk's 12 as the round recorded; from the lowest rate 29 (28%, #1806); light
  // features priced as runs of their own workflow 25 (24%) and lanewalk 5 (#1813).
  // Only finished features count (a run of the feature completed): a blocked, paused or waiting
  // run's tokens are a lower bound of what the feature costs, not its cost. R68 ewvet's codec and
  // read-commands waited behind the blocked scanner after their plan stages (0.26M and 0.58M against
  // low ends of 1.77M and 1.11M) and counted as below; with them and R58/R59 wheeltags' five blocked
  // or paused features the share was 73 of 237 (30.8%), on finished features it is 66 of 228 (28.9%).
  test("a quarter of the finished features start below their range and a quarter above it, within two standard errors", () => {
    let lanewalk = 0;
    let below = 0;
    let above = 0;
    let features = 0;
    for (const path of readdirSync(ROOT, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".sqlite.gz"))
      .map((p) => join(ROOT, p))) {
      const replays = replayInitiativeStarts(path);
      if (!replays.length) continue;
      const { used, finished } = featureUsage(path);
      for (const replay of replays)
        for (const f of replay.starts[0]?.estimate ?? []) {
          const tokens = used.get(f.featureId);
          if (tokens === undefined || !finished.has(f.featureId)) continue;
          features++;
          if (tokens < f.low) below++;
          if (tokens < f.low && path.endsWith("lanewalk.sqlite.gz")) lanewalk++;
          if (tokens > f.high) above++;
        }
    }
    expect(features).toBeGreaterThanOrEqual(104);
    const bound = 0.25 + 2 * Math.sqrt((0.25 * 0.75) / features);
    expect(below / features).toBeLessThanOrEqual(bound);
    expect(above / features).toBeLessThanOrEqual(bound);
    expect(lanewalk).toBeLessThanOrEqual(5);
  }, 600000);
});
