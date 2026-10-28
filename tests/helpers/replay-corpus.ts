// The bench-trace replay corpus, shared by tests/forecast-replay-corpus*.test.ts. The corpus is
// split over several files so each fits in an `OS tests` shard (AGENTS.md); the decision counters
// and accepted.json stay in tests/forecast-replay-corpus.test.ts.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openTrace } from "../../src/core/workflows/trace.js";

export const ROOT = join(import.meta.dir, "..", "fixtures", "bench-traces");

/** Every trace under `dir`, sorted. */
export function traces(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? traces(join(dir, entry.name))
        : entry.name.endsWith(".sqlite.gz")
          ? [join(dir, entry.name)]
          : [],
    )
    .sort();
}

/** Tokens each initiative feature's runs used in a trace, and the features one of whose runs completed. */
export function featureUsage(path: string): { used: Map<string, number>; finished: Set<string> } {
  const { store, dispose } = openTrace(path);
  const used = new Map<string, number>();
  const finished = new Set<string>();
  try {
    for (const row of store.connection
      .query(
        "SELECT l.feature_id AS feature, r.token_usage AS tokens, r.status AS status FROM initiative_runs l JOIN runs r ON r.id=l.run_id",
      )
      .all() as { feature: string; tokens: number; status: string }[]) {
      used.set(row.feature, (used.get(row.feature) ?? 0) + row.tokens);
      if (row.status === "completed") finished.add(row.feature);
    }
  } finally {
    dispose();
  }
  return { used, finished };
}

/** A quarter plus two standard errors of a share of `features` (sqrt(0.25 * 0.75 / n)). */
export const quarterBound = (features: number) => 0.25 + 2 * Math.sqrt((0.25 * 0.75) / features);
