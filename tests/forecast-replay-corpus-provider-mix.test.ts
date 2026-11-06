import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { findPricing } from "../src/core/llm/pricing.js";
import { DEFAULT_MIX, forecastSamples, providerFamily, providerTaskMix, TASK_MIX } from "../src/core/workflows/stage-price.js";
import { openTrace } from "../src/core/workflows/trace.js";
import type { AttemptUsageRow } from "../src/core/workflows/usage.js";
import { ROOT, traces } from "./helpers/replay-corpus.js";

// #2963 backtest: the Claude Code attempts of R99 to R102, the rounds of the corpus that ran
// Claude stages, priced at the per-provider mix (`providerTaskMix`, with cache writes) and at the
// blended mix (`TASK_MIX`, `DEFAULT_MIX`), each on the attempt's own price card, against what the
// attempts paid (`attemptCost`). The per-provider mixes were measured on these rounds, so this
// pins them to the corpus; R103, whose Claude track the issue reports at $3.40 to $3.90 per Mtok
// against a $2.40 forecast, is not in the corpus.
const ROUNDS = ["R99", "R100", "R101", "R102"];

function claudeAttempts(): AttemptUsageRow[] {
  return ROUNDS.flatMap((round) =>
    traces(join(ROOT, round)).flatMap((path) => {
      const { store, dispose } = openTrace(path);
      try {
        const runs = (store.connection.query("SELECT id FROM runs").all() as { id: string }[]).map((r) => r.id);
        return forecastSamples(store, runs).filter(
          (a) => a.model !== null && providerFamily(a.model) === "claude" && a.costUsd !== null && (a.usedTokens ?? 0) > 0 && a.inputTokens !== null && a.outputTokens !== null,
        );
      } finally {
        dispose();
      }
    }),
  );
}

/** Dollars per Mtok the attempts paid, and what each mix prices their tokens at. */
function backtest(rows: AttemptUsageRow[], implement: boolean) {
  let paid = 0;
  let perProvider = 0;
  let blended = 0;
  let tokens = 0;
  for (const a of rows) {
    if ((a.stage === "implement") !== implement) continue;
    const price = findPricing(a.model!)!.pricing;
    const mix = providerTaskMix(a.model!, a.stage);
    const old = a.stage === "implement" ? TASK_MIX : DEFAULT_MIX;
    const used = a.usedTokens ?? 0;
    paid += a.costUsd ?? 0;
    perProvider += (used * (mix.input * price.input + mix.cacheRead * price.cacheRead + mix.cacheWrite * price.cacheWrite + mix.output * price.output)) / 1e6;
    blended += (used * (old.input * price.input + old.cacheRead * price.cacheRead + old.output * price.output)) / 1e6;
    tokens += used;
  }
  return { tokens, paid: (paid / tokens) * 1e6, perProvider: (perProvider / tokens) * 1e6, blended: (blended / tokens) * 1e6 };
}

describe("replay corpus: per-provider token mix against what Claude attempts paid (#2963)", () => {
  const rows = claudeAttempts();

  test("the corpus holds Claude Code task and single-call attempts that wrote to the cache", () => {
    expect(rows.some((a) => a.stage === "implement")).toBe(true);
    expect(rows.some((a) => a.stage !== "implement")).toBe(true);
    expect(rows.every((a) => (a.cacheWriteTokens ?? 0) > 0)).toBe(true);
  });

  for (const implement of [true, false])
    test(`${implement ? "task" : "single-call stage"} attempts: the per-provider mix lands within 5% of paid, closer than the blended mix`, () => {
      const result = backtest(rows, implement);
      expect(result.tokens).toBeGreaterThan(0);
      const off = (rate: number) => Math.abs(rate - result.paid) / result.paid;
      expect(off(result.perProvider)).toBeLessThan(0.05);
      expect(off(result.perProvider)).toBeLessThan(off(result.blended));
      // The blended mix prices them low: it has no cache-write share.
      expect(result.blended).toBeLessThan(result.paid);
    });
});
