import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { callCostRate, costRate } from "../src/core/workflows/budget.js";
import { forecastSamples } from "../src/core/workflows/stage-price.js";
import { type CallRate, openTrace, replayTrace } from "../src/core/workflows/trace.js";

// #1649, #1715: every recorded bench-round trace replays through the current host decisions: the
// forecast and cap code, the per-call cost cap (#1740), the first-response deadline of each model
// call, and the initiative share gate (#1707). A stop, cap growth or park the recorded run did not make fails the suite, unless
// accepted.json lists it for that run or initiative with the reason: the pull request that changes
// the decision says so in its diff.
const ROOT = join(import.meta.dir, "fixtures", "bench-traces");

interface Accepted {
  newStops?: number;
  newGrowth?: number;
  newFirstByteStops?: number;
  newCostStops?: number;
  newShareStops?: number;
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
        expect({ initiative: initiative.initiativeId, newShareStops: initiative.newShareStops }).toEqual({
          initiative: initiative.initiativeId,
          newShareStops: allowed?.newShareStops ?? 0,
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
