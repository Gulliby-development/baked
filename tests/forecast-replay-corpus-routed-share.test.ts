import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { forecastSamples } from "../src/core/workflows/stage-price.js";
import { openTrace, replayInitiativeStarts } from "../src/core/workflows/trace.js";
import { ROOT, traces } from "./helpers/replay-corpus.js";

// Part of the bench-trace replay corpus (tests/forecast-replay-corpus.test.ts), in a file of its own
// because it replays every start of the Claude-routed initiatives of R103 to R105.
//
// #2963: from R103 on, the bench's Claude track ran research, specify, plan, analyze, review and
// convergence on an Opus-tier route and the tasks on a Sonnet-tier one. A feature no accepted
// feature of its workflow measured was priced at the history's stage ranges, measured on Codex runs
// whose task loops took most of the tokens: R103's first features at $2.39 per Mtok, paid $3.32 to
// $3.90. Each feature is compared at its start with what its runs paid per token.
const ROUNDS = ["R103", "R104", "R105"];

interface Priced {
  trace: string;
  feature: string;
  shown: number;
  routed: number;
  paid: number;
}

/** Dollars per token each feature's runs paid, over every run linked to it. */
function paidByFeature(path: string): Map<string, number> {
  const { store, dispose } = openTrace(path);
  try {
    const runs = new Map<string, string[]>();
    for (const l of store.connection.query("SELECT feature_id, run_id FROM initiative_runs").all() as { feature_id: string; run_id: string }[])
      runs.set(l.feature_id, [...(runs.get(l.feature_id) ?? []), l.run_id]);
    return new Map(
      [...runs].map(([feature, ids]) => {
        const rows = forecastSamples(store, ids).filter((a) => a.costUsd !== null && (a.usedTokens ?? 0) > 0);
        const tokens = rows.reduce((sum, a) => sum + (a.usedTokens ?? 0), 0);
        return [feature, rows.reduce((sum, a) => sum + (a.costUsd ?? 0), 0) / tokens];
      }),
    );
  } finally {
    dispose();
  }
}

/** Every Claude-routed feature start the current code prices at its routes' stage shares. */
function routedStarts(): Priced[] {
  const priced: Priced[] = [];
  for (const path of ROUNDS.flatMap((round) => traces(join(ROOT, round)))) {
    const paid = paidByFeature(path);
    if (!paid.size) continue;
    const seen = new Set<string>();
    replayInitiativeStarts(path, {
      gate: (view, feature) => {
        // The first call is the start's own gate; a plan charge's replay calls it again (#2124).
        if (!seen.has(feature.id) && feature.need && feature.needUsd && feature.routedShare) {
          const tokens = feature.need.low + feature.need.high;
          const routed = feature.routedShare.costUsd;
          priced.push({
            trace: path.split(/[\\/]/).slice(-2).join("/"),
            feature: feature.id,
            shown: (feature.needUsd.low + feature.needUsd.high) / tokens,
            routed: (routed.low + routed.high) / tokens,
            paid: paid.get(feature.id) ?? Number.NaN,
          });
        }
        seen.add(feature.id);
        return shareShortfall(view, feature);
      },
    });
  }
  return priced;
}

const off = (rate: number, paid: number) => rate / paid - 1;
const perMtok = (n: number) => `$${(n * 1e6).toFixed(2)}`;

describe("replay corpus: Claude-routed feature prices at their routes' stage shares (#2963)", () => {
  const priced = routedStarts();
  for (const p of priced)
    console.log(`#2963 ${p.trace} ${p.feature}: shown ${perMtok(p.shown)}, routed ${perMtok(p.routed)}, paid ${perMtok(p.paid)}`);

  test("R103: the first features and the first quick features, shown at $2.20 to $2.39 per Mtok, are priced within 20% of what they paid", () => {
    const r103 = priced.filter((p) => p.trace.startsWith("R103/"));
    expect(r103.map((p) => `${p.trace}:${p.feature}`).sort()).toEqual([
      "R103/blockset.sqlite.gz:core",
      "R103/blockset.sqlite.gz:gaps",
      "R103/topcut.sqlite.gz:chain",
      "R103/topcut.sqlite.gz:core",
    ]);
    for (const p of r103) {
      // The shown price is a quarter or more under what they paid; the routed one is not under by
      // more than 5% and at most 20% over.
      expect(p.shown * 1e6).toBeLessThan(2.4);
      expect(off(p.shown, p.paid)).toBeLessThan(-0.25);
      expect(off(p.routed, p.paid)).toBeGreaterThan(-0.05);
      expect(off(p.routed, p.paid)).toBeLessThan(0.2);
    }
  });

  test("R103 to R105: the routed price is never more than 5% under what a feature paid, and closer on average than the shown one", () => {
    expect(priced.length).toBeGreaterThanOrEqual(12);
    expect(priced.every((p) => p.paid > 0)).toBe(true);
    for (const p of priced) expect(off(p.routed, p.paid)).toBeGreaterThan(-0.05);
    const mean = (pick: (p: Priced) => number) => priced.reduce((sum, p) => sum + Math.abs(off(pick(p), p.paid)), 0) / priced.length;
    expect(mean((p) => p.routed)).toBeLessThan(mean((p) => p.shown));
  });
});
