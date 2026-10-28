import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { callCostRate, costRate } from "../src/core/workflows/budget.js";
import { chargeHold, refreshedGrowth } from "../src/core/workflows/initiatives/growth.js";
import { costGrowthLimit, dollarShortfall, growthLimit, type ShareGateRecord, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { forecastSamples } from "../src/core/workflows/stage-price.js";
import { adaptiveFirstByteMs } from "../src/core/llm/provider-health.js";
import { planApprovalDecision } from "../src/core/workflows/auto-approval.js";
import { CAPACITY_PROBE, type SizingReport, type SizingSample, samplesFrom, testCaseRate } from "../src/core/workflows/sizing.js";
import { type CallRate, chainCosts, openTrace, type PlanPriceReplay, replayChainEscalation, replayEdgeRecord, replayInitiativeStarts, replayPlanApprovals, replayPlanPrices, replayActiveTimes, replayPoolBounds, replayTrace, type TestSplitRule } from "../src/core/workflows/trace.js";
import { type EdgeRecord, edgeCrashDecision } from "../src/core/verification/edge-inputs.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// #1649, #1715: every recorded bench-round trace replays through the current host decisions: the
// forecast and cap code, the per-call cost cap (#1740), the first-response deadline of each model
// call, the test task split of each sizing report (#1789), each usage-policy refusal (#1895), each finding-chain decision (#1959), each repeated corrective failure (#1996), each spec conflict decision for the request (#2016), each misquote host-fix decision (#2047), each decision for the request or the platform on checked evidence (#2032), each token-pool park's extension inside the dollar cap (#2042), each written-tests run whose declared-class filter selected no test (#2363), and the initiative share gate (#1707), asked both on its recorded inputs and with each start
// rewound and recomputed, and the plan auto-approval on the run state it was asked with (#1707). A
// stop, cap growth, park or approval decision the recorded run did not make fails the suite, unless
// accepted.json lists it for that run or initiative with the reason: the pull request that changes
// the decision says so in its diff.
const ROOT = join(import.meta.dir, "fixtures", "bench-traces");
/**
 * The mode the rounds before #2245 ran the plan charge in: open runs held at their limits. A test
 * that compares a replay with what a round's gate recorded replays it at that mode; one that asks
 * what the current code decides takes the default (`enforce`).
 */
const RECORDED_PLAN_CHARGE = { stopModes: { "initiative-plan-charge": "shadow" as const } };

interface Accepted {
  newStops?: number;
  newGrowth?: number;
  newFirstByteStops?: number;
  newCostStops?: number;
  newTestSplits?: number;
  newRecoveries?: number;
  newPolicyStops?: number;
  newChainDecisions?: number;
  newEdgeDecisions?: number;
  newRepeatStops?: number;
  newConflictDecisions?: number;
  newApplyDecisions?: number;
  newMisquoteFixes?: number;
  newIntegrityFindings?: number;
  newCaseRefusals?: number;
  newGateRepairs?: number;
  newConvergenceVerdicts?: number;
  newEvidenceDecisions?: number;
  newScopeStops?: number;
  newUnownedDecisions?: number;
  newConflictFinishes?: number;
  newDeferDecisions?: number;
  newSourceDefectRoutes?: number;
  newBaselineDecisions?: number;
  newSignatureDecisions?: number;
  newActiveTimes?: number;
  newShareStops?: number;
  newPoolGrowth?: number;
  newPoolBoundStops?: number;
  newStartStops?: number;
  newUnselectedStops?: number;
  newApprovalDeclines?: number;
  newAutoApprovals?: number;
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
/** The first round whose run states count sizing tasks as the current auto approval reads them. */
const APPROVAL_REPLAY_FROM = 52;

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
          newTestSplits: run.newTestSplits,
          newRecoveries: run.newRecoveries,
          newPolicyStops: run.newPolicyStops,
          newChainDecisions: run.newChainDecisions,
          newRepeatStops: run.newRepeatStops,
          newConflictDecisions: run.newConflictDecisions,
          newApplyDecisions: run.newApplyDecisions,
          newMisquoteFixes: run.newMisquoteFixes,
          newEdgeDecisions: run.newEdgeDecisions,
          newIntegrityFindings: run.newIntegrityFindings,
          newCaseRefusals: run.newCaseRefusals,
          newGateRepairs: run.newGateRepairs,
          newConvergenceVerdicts: run.newConvergenceVerdicts,
          newEvidenceDecisions: run.newEvidenceDecisions,
          newScopeStops: run.newScopeStops,
          newUnownedDecisions: run.newUnownedDecisions,
          newConflictFinishes: run.newConflictFinishes,
          newDeferDecisions: run.newDeferDecisions,
          newSourceDefectRoutes: run.newSourceDefectRoutes,
          newBaselineDecisions: run.newBaselineDecisions,
          newSignatureDecisions: run.newSignatureDecisions,
          newActiveTimes: run.newActiveTimes,
          newUnselectedStops: run.newUnselectedStops,
        }).toEqual({
          run: run.runId,
          newStops: allowed?.newStops ?? 0,
          newGrowth: allowed?.newGrowth ?? 0,
          newFirstByteStops: allowed?.newFirstByteStops ?? 0,
          newCostStops: allowed?.newCostStops ?? 0,
          newTestSplits: allowed?.newTestSplits ?? 0,
          newRecoveries: allowed?.newRecoveries ?? 0,
          newPolicyStops: allowed?.newPolicyStops ?? 0,
          newChainDecisions: allowed?.newChainDecisions ?? 0,
          newRepeatStops: allowed?.newRepeatStops ?? 0,
          newConflictDecisions: allowed?.newConflictDecisions ?? 0,
          newApplyDecisions: allowed?.newApplyDecisions ?? 0,
          newMisquoteFixes: allowed?.newMisquoteFixes ?? 0,
          newEdgeDecisions: allowed?.newEdgeDecisions ?? 0,
          newIntegrityFindings: allowed?.newIntegrityFindings ?? 0,
          newCaseRefusals: allowed?.newCaseRefusals ?? 0,
          newGateRepairs: allowed?.newGateRepairs ?? 0,
          newConvergenceVerdicts: allowed?.newConvergenceVerdicts ?? 0,
          newEvidenceDecisions: allowed?.newEvidenceDecisions ?? 0,
          newScopeStops: allowed?.newScopeStops ?? 0,
          newUnownedDecisions: allowed?.newUnownedDecisions ?? 0,
          newConflictFinishes: allowed?.newConflictFinishes ?? 0,
          newDeferDecisions: allowed?.newDeferDecisions ?? 0,
          newSourceDefectRoutes: allowed?.newSourceDefectRoutes ?? 0,
          newBaselineDecisions: allowed?.newBaselineDecisions ?? 0,
          newSignatureDecisions: allowed?.newSignatureDecisions ?? 0,
          newActiveTimes: allowed?.newActiveTimes ?? 0,
          newUnselectedStops: allowed?.newUnselectedStops ?? 0,
        });
      }
      // Run states before R52 counted the host's own test splits in `hostSplitTasks`, which the
      // graph's sizing slices now say (#1711): their approvals are not replayed as a gate.
      if (Number(/^R(\d+)\//.exec(name)?.[1]) >= APPROVAL_REPLAY_FROM) {
        const approvals = replayPlanApprovals(path);
        for (const runId of new Set(approvals.map((a) => a.runId))) {
          const allowed = accepted[`${name}#${runId}`];
          const own = approvals.filter((a) => a.runId === runId);
          expect({
            run: runId,
            newApprovalDeclines: own.filter((a) => a.recorded === "auto" && a.replayed === "person").length,
            newAutoApprovals: own.filter((a) => a.recorded === "person" && a.replayed === "auto").length,
          }).toEqual({
            run: runId,
            newApprovalDeclines: allowed?.newApprovalDeclines ?? 0,
            newAutoApprovals: allowed?.newAutoApprovals ?? 0,
          });
        }
      }
      for (const initiative of replay.initiatives) {
        const allowed = accepted[`${name}#${initiative.initiativeId}`];
        expect({
          initiative: initiative.initiativeId,
          newShareStops: initiative.newShareStops,
          newPoolGrowth: initiative.newPoolGrowth,
          newPoolBoundStops: initiative.newPoolBoundStops,
          newStartStops: initiative.newStartStops,
        }).toEqual({
          initiative: initiative.initiativeId,
          newShareStops: allowed?.newShareStops ?? 0,
          newPoolGrowth: allowed?.newPoolGrowth ?? 0,
          newPoolBoundStops: allowed?.newPoolBoundStops ?? 0,
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

  test("#2041: R66 nodepluck syntax's analyses cut at the 180 s adaptive floor; current main waits the ceiling after the first", () => {
    const path = join(ROOT, "R66", "nodepluck.sqlite.gz");
    const cut = (replay: ReturnType<typeof replayTrace>) =>
      replay.runs.flatMap((r) => r.firstByte.filter((b) => b.recorded === "stop" && b.stage === "analysis").map((b) => b.replayed));
    // The rule before #2041: twice the shape's p95 from the times alone, with no widening.
    const old = cut(replayTrace(path, { adaptiveFirstByte: (history, ceilingMs, model, call) => adaptiveFirstByteMs(ceilingMs, history.healthy(model, call.stage, call.effort).map((sample) => sample.ms)) }));
    expect(old.filter((replayed) => replayed === "stop")).toHaveLength(4);
    // R66 recorded no prompt sizes, so the first cut stays; every later attempt gets the ceiling.
    expect(cut(replayTrace(path)).filter((replayed) => replayed === "stop")).toHaveLength(1);
  }, 120000);
});

describe("plan auto-approval replays on recorded run states (#1707)", () => {
  test("#1711: R51 url-shortener and md-site, declined for 9 and 14 tasks of 8, approve on main", () => {
    // Before #1711 every slice sizing cut from one task counted against the limit.
    const sliced: typeof planApprovalDecision = (policy, state, ...rest) =>
      planApprovalDecision(policy, { ...state, graph: { ...state.graph, tasks: state.graph.tasks.map(({ sizingSlice: _, ...t }) => t) } }, ...rest);
    for (const [app, limit] of [
      ["url-shortener", "Limits: 9 tasks exceed 8 (4 added for sizing not counted)"],
      ["md-site", "Limits: 14 tasks exceed 8"],
    ] as const) {
      const path = join(ROOT, "R51", `${app}.sqlite.gz`);
      expect(replayPlanApprovals(path)).toEqual([expect.objectContaining({ recorded: "person", replayed: "auto", reasons: [] })]);
      expect(replayPlanApprovals(path, sliced)).toEqual([expect.objectContaining({ recorded: "person", replayed: "person", reasons: expect.arrayContaining([limit]) })]);
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

  test("#1767: R52 srcwhere forecasts near its final cost from its first starts, where the runner said $46.80", () => {
    // The runner's advisory (cost.forecast_advisory) said $46.80 at 2 of 12, and the replay at the
    // #1784 merge said the same. Planned features then took their stage weights from two one-task
    // runs and priced four fifths of their tokens at planning rates, and a two-path module like a
    // six-path one.
    const [replay] = replayInitiativeStarts(join(ROOT, "R52", "srcwhere.sqlite.gz"));
    const vlq = replay?.starts.find((b) => b.featureId === "vlq");
    expect(vlq).toMatchObject({ accepted: 2, replayed: "pass" });
    expect(vlq!.forecastUsd!).toBeLessThan(18.34 * 1.6);
    expect(vlq!.forecastUsd!).toBeLessThan(vlq!.ceilingUsd!);
    const ratios = replay!.starts.filter((b) => b.forecastUsd !== null).map((b) => b.forecastUsd! / replay!.finalUsd!);
    expect(Math.max(...ratios)).toBeLessThan(1.6);
    expect(replay?.newStartStops).toBe(0);
  }, 120000);

  test("#1890: R59 wheeltags prices its waiting features at its own stage mix, and pick-command could grow past where it stopped", () => {
    // R59's accepted features paid $1.95 per million tokens. Their stage rates at the history's
    // stage weights say $2.67 at pick-command's start, so the waiting features reserved too much:
    // pick-command started with $2.87 to grow into (this replay of main says $1.33) and stopped at
    // its $3.16 ceiling one corrective short. dead-command and expand-command then started on
    // what was left.
    const seen = new Map<string, { view: Parameters<typeof shareShortfall>[0]; feature: Parameters<typeof shareShortfall>[1] }>();
    const [replay] = replayInitiativeStarts(join(ROOT, "R59", "wheeltags.sqlite.gz"), {
      ...RECORDED_PLAN_CHARGE,
      gate: (view, feature) => {
        // The first call is the start's own gate; a plan charge's replay calls it again (#2124).
        if (!seen.has(feature.id)) seen.set(feature.id, { view, feature });
        return shareShortfall(view, feature);
      },
    });
    expect(replay?.newStartStops).toBe(0);
    const pick = seen.get("pick-command")!;
    const rate = pick.feature.needUsd!.low / pick.feature.need!.low;
    expect(rate * 1e6).toBeGreaterThan(1.8);
    expect(rate * 1e6).toBeLessThan(2.1);
    expect(costGrowthLimit(pick.view, "pick-command")!).toBeGreaterThan(3.16);
    expect(dollarShortfall(pick.view, pick.feature)).toBeNull();
    // At that price the two later starts are not short either: rewound to their own moments
    // (#2061) the initiative had spent $12.90 and $14.75, and their caps grow to $4.32 and $2.40
    // against lows of $2.22 and $0.72. Replayed on the final spend ($17.69) and the caps runs grew
    // to later, they read short against the cap.
    const [plain] = replayInitiativeStarts(join(ROOT, "R59", "wheeltags.sqlite.gz"), RECORDED_PLAN_CHARGE);
    expect(plain?.finalUsd).toBe(17.69);
    for (const id of ["dead-command", "expand-command"]) {
      const start = seen.get(id)!;
      expect(start.view.budget.cost).toMatchObject({ shareMode: "shadow", measuredFeatures: 2 });
      expect(start.view.budget.cost.spentUsd).toBeLessThan(15);
      expect(costGrowthLimit(start.view, id)!).toBeGreaterThan(start.feature.needUsd!.low);
      expect(dollarShortfall(start.view, start.feature)).toBeNull();
      expect(replay?.starts.find((b) => b.featureId === id)?.replayed).toBe("pass");
    }
    expect(plain?.starts.every((b) => b.shareWouldStop === null)).toBe(true);
    // #2218: the dollar-cap park records no would-stop either; no round of the corpus ran short.
    expect(plain?.starts.every((b) => b.capWouldStop === null)).toBe(true);
  }, 120000);

  test("#2061: every rewound start of R60 wheeltags reads the dollars its recorded share gate read", () => {
    // With the initiative's budget rewound to before its later $40 extension but each run's
    // dollars and caps left final, pick, dead, expand and front parked on "The shared dollar
    // budget is exhausted ... $0.00". The rewind now restores each run's tokens, dollars and
    // policy at the start too, so the gate reads what the round's gate read.
    const path = join(ROOT, "R60", "wheeltags.sqlite.gz");
    const trace = openTrace(path);
    let recorded: Map<string, ShareGateRecord["view"]["budget"]["cost"]>;
    try {
      recorded = new Map(
        (trace.store.connection.query("SELECT payload_json FROM initiative_events WHERE type='feature.share_gate' ORDER BY seq").all() as { payload_json: string }[])
          .map((r) => JSON.parse(r.payload_json) as ShareGateRecord)
          .map((r) => [r.featureId, r.view.budget.cost]),
      );
    } finally {
      trace.dispose();
    }
    const seen = new Map<string, ShareGateRecord["view"]["budget"]["cost"]>();
    const [replay] = replayInitiativeStarts(path, { ...RECORDED_PLAN_CHARGE, gate: (view, feature) => {
      // The first call is the start's own gate; a plan charge's replay calls it again (#2124).
      if (!seen.has(feature.id)) seen.set(feature.id, view.budget.cost);
      return shareShortfall(view, feature);
    } });
    expect(replay?.newStartStops).toBe(0);
    expect(seen.size).toBe(recorded.size);
    for (const [id, cost] of recorded) {
      const { capUsd, spentUsd, reservedUsd, remainingUsd, measuredFeatures } = cost;
      expect([id, seen.get(id)]).toEqual([id, expect.objectContaining({ capUsd, spentUsd, reservedUsd, remainingUsd, measuredFeatures })]);
    }
  }, 300000);

  test("#1714: R62 stepvet's dollar share is not checked before a feature is measured", () => {
    // R62 recorded two initiative-dollar-share would-stops, lines and stepexpr, both at
    // measuredFeatures 0 with every waiting feature's low reserved. Both started anyway, finished
    // and were accepted, with $3.67 of the $30 left unspent.
    const seen = new Map<string, { view: Parameters<typeof shareShortfall>[0]; feature: Parameters<typeof shareShortfall>[1] }>();
    replayInitiativeStarts(join(ROOT, "R62", "stepvet.sqlite.gz"), {
      ...RECORDED_PLAN_CHARGE,
      gate: (view, feature) => {
        // The first call is the start's own gate; a plan charge's replay calls it again (#2124).
        if (!seen.has(feature.id)) seen.set(feature.id, { view, feature });
        return shareShortfall(view, feature);
      },
    });
    for (const id of ["lines", "stepexpr"]) {
      const start = seen.get(id)!;
      expect(start.view.budget.cost.measuredFeatures).toBe(0);
      expect(costGrowthLimit(start.view, id)!).toBeLessThan(start.feature.needUsd!.low);
      expect(dollarShortfall(start.view, start.feature)).toBeNull();
    }
    // From three measured features the cap bounds the check again (#2099). stepscmd is not short
    // at its own moment: $12.58 spent and $8.88 remaining, as the round's share gate recorded, and
    // the round recorded no would-stop for it. Replayed on the final spend ($21.13 by its start's
    // count) and the caps runs grew to later, it read short (#2061).
    const later = seen.get("stepscmd")!;
    expect(later.view.budget.cost).toMatchObject({ measuredFeatures: 3, spentUsd: 12.58, remainingUsd: 8.88 });
    expect(dollarShortfall(later.view, later.feature)).toBeNull();
    const [replay] = replayInitiativeStarts(join(ROOT, "R62", "stepvet.sqlite.gz"));
    expect(replay?.finalUsd).toBe(26.33);
    expect(replay?.starts.filter((b) => b.shareWouldStop !== null).map((b) => b.featureId)).toEqual([]);
    // #2218: nor the dollar-cap park, at measured features and at none.
    expect(replay?.starts.filter((b) => b.capWouldStop !== null).map((b) => b.featureId)).toEqual([]);
  }, 120000);

  test("#2099: R67 ampwhy's dollar share gates record no would-stop before the dollar rate is measured", () => {
    // R67 ampwhy is not in the corpus; these are the gate inputs its decision.would_stop events
    // recorded. Cap $30, ceiling $37.50, shadow. reader and scanning were judged short at one
    // measured feature, started anyway and finished at $2.86 and $1.55; the initiative spent
    // $16.24 in all, so both would-stops were false.
    const finalUsd = 16.24;
    const gate = (remainingUsd: number, reservedUsd: number, low: number, high: number, measuredFeatures: number) => {
      const view = {
        initiativeId: "ampwhy",
        budget: {
          remaining: { tokens: 50_000_000, calls: 500, activeMs: 10_000_000 },
          cost: {
            capUsd: 30, tolerance: 0.25, ceilingUsd: 37.5, spentUsd: 30 - remainingUsd, reservedUsd: 0, remainingUsd,
            forecastUsd: null, measuredFeatures, forecastBinding: false, forecastMode: "enforce" as const, forecastNotice: null, shareMode: "shadow" as const,
          },
        },
        features: [
          { id: "f", state: "ready" as const, share: { tokens: 5_000_000, calls: 50, activeMs: 1_000_000 }, need: null, shareUsd: 3, needUsd: { low, high } },
          { id: "others", state: "waiting" as const, share: { tokens: 5_000_000, calls: 50, activeMs: 1_000_000 }, need: null, shareUsd: 3, needUsd: { low: reservedUsd, high: reservedUsd * 2 } },
        ],
      };
      return { view, feature: view.features[0]! };
    };
    // reader: $22.36 remaining, $1.45 spare against $4.26-$8.66; scanning: $18.67, $2.23 against $2.25-$4.66.
    for (const [remaining, spare, low, high] of [[22.36, 1.45, 4.26, 8.66], [18.67, 2.23, 2.25, 4.66]] as const) {
      const at1 = gate(remaining, remaining - spare, low, high, 1);
      expect(costGrowthLimit(at1.view, "f")!).toBeCloseTo(spare, 2);
      expect(dollarShortfall(at1.view, at1.feature)).toBeNull();
      // The other waiting features reserved more than the cap the initiative left unspent.
      expect(remaining - spare).toBeGreaterThan(30 - finalUsd);
      // The same inputs once three features have measured the rate still record one.
      const at3 = gate(remaining, remaining - spare, low, high, 3);
      expect(dollarShortfall(at3.view, at3.feature)).toStartWith("The shared dollar budget is short: f has $");
    }
  });

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

describe("plan approvals price their tasks at what earlier runs' tasks paid (#1792)", () => {
  test("R52's approvals, with R51 as history, bracket what their tasks cost where the typical mix priced them above it", () => {
    const history = traces(join(ROOT, "R51")).map(openTrace);
    const stores = history.map((h) => join(h.workspace, ".baked", "workflows.sqlite"));
    const replay = (with_: string[]) => traces(join(ROOT, "R52")).flatMap((path) => replayPlanPrices(path, with_));
    let current: PlanPriceReplay[];
    let typical: PlanPriceReplay[];
    try {
      current = replay(stores);
      // Before #1792 a plan was priced from the run's own attempts alone: at the typical task mix.
      typical = replay(null);
    } finally {
      for (const h of history) h.dispose();
    }
    const priced = (rows: PlanPriceReplay[]) => rows.filter((r) => r.replayed && r.actualUsd > 0);
    const below = (rows: PlanPriceReplay[]) => priced(rows).filter((r) => r.actualUsd < r.replayed!.low).length;
    const above = (rows: PlanPriceReplay[]) => priced(rows).filter((r) => r.actualUsd > r.replayed!.high).length;
    const error = (rows: PlanPriceReplay[]) =>
      priced(rows).reduce((sum, r) => sum + Math.abs(Math.log((2 * r.actualUsd) / (r.replayed!.low + r.replayed!.high))), 0) /
      priced(rows).length;
    expect(priced(current).length).toBe(18);
    expect(current.every((r) => r.rate === "history")).toBe(true);
    expect(typical.every((r) => r.rate === "default")).toBe(true);
    // The typical mix priced 14 of the 18 above what their tasks cost and none below; earlier
    // runs' prices put 5 above and 3 below, and halve the error of the range's middle.
    expect(below(typical)).toBeGreaterThanOrEqual(12);
    expect(above(typical)).toBe(0);
    expect(below(current)).toBeLessThanOrEqual(6);
    expect(above(current)).toBeLessThanOrEqual(6);
    expect(error(current)).toBeLessThan(error(typical) * 0.6);
    // R52 url-shortener: the approval showed $6.14 to $11.92, the tasks cost $2.81.
    const url = current.find((r) => r.recorded.low > 6 && r.recorded.low < 6.2);
    expect(url!.replayed!.low).toBeLessThan(url!.actualUsd);
    expect(url!.replayed!.high).toBeGreaterThan(url!.actualUsd);
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

  test("R70 evalpin: a raised reservation is checked at its raise, with the open total of that moment", () => {
    // suite-runner's correctness review reserved about 50k tokens at its start under a $5.37 cap and
    // raised to 138,552 before its second call, after the initiative had let the cap grow to $5.69.
    // Checked at the start with its largest reservation, both reviews were refused ($6.16 and $6.34
    // against $5.91); the run checked them at $6.16 against $6.26 and $5.88 against $5.91.
    const run = replayTrace(join(ROOT, "R70/evalpin.sqlite.gz")).runs.find((r) => r.featureId === "evalpin_suite-runner");
    const reviews = run!.costCap.filter((b) => b.stage === "review");
    expect(reviews.map((b) => [b.tokens, b.replayed, b.ceilingUsd])).toEqual([
      [138552, "pass", 6.26],
      [32883, "pass", 5.91],
    ]);
    expect(reviews[1]!.spentUsd + reviews[1]!.reservedUsd + reviews[1]!.requestedUsd).toBeCloseTo(5.88, 2);
    expect(run!.newCostStops).toBe(0);
  }, 120000);
});

describe("test task splits replay on recorded sizing reports (#1789)", () => {
  // The rule before #1789: with an observed case capacity, every test file above it and above five
  // cases split, whatever its price.
  const atCapacity: TestSplitRule = (cases, limit, estimate, cap) =>
    (limit?.cases ?? 0) > 0 ? cases > 5 && cases > (limit?.cases ?? 0) : (cases === 0 || cases > 5) && (estimate.low + estimate.high) / 2 > cap;
  const traces = ["R49/url-shortener.sqlite.gz", "R51/md-site.sqlite.gz", "R52/url-shortener.sqlite.gz"];

  test("the old rule reproduces the recorded splits at a capacity of 4; the current one keeps those files whole", () => {
    for (const name of traces) {
      const path = join(ROOT, name);
      const old = replayTrace(path, { testSplit: atCapacity }).runs.flatMap((r) => r.testSplits);
      expect(old.length).toBeGreaterThan(0);
      expect(old.every((b) => b.replayed === b.recorded)).toBe(true);
      const current = replayTrace(path).runs.flatMap((r) => r.testSplits);
      const kept = current.filter((b) => b.recorded === "split" && b.replayed === "whole");
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((b) => b.cases > 4 && b.cases <= CAPACITY_PROBE * 4)).toBe(true);
      expect(current.filter((b) => b.recorded === "whole" && b.replayed === "split")).toEqual([]);
    }
  }, 120000);

  test("a rule that splits every test task is caught as new splits", () => {
    const path = join(ROOT, "R52/url-shortener.sqlite.gz");
    expect(replayTrace(path, { testSplit: () => true }).runs.reduce((n, r) => n + r.newTestSplits, 0)).toBeGreaterThan(0);
    expect(replayTrace(path).runs.reduce((n, r) => n + r.newTestSplits, 0)).toBe(0);
  }, 120000);

  test("R62 stepvet: tagexpr's active time is sized at the initiative's own pace and covers what it used (#2336)", () => {
    // tagexpr was sized at the history's 135k tokens per minute to 2,100,000 ms, stopped there
    // (#1958) and finished at 2,457,115 ms after a raise; the initiative's finished runs had run at 71k.
    const { store, dispose } = openTrace(join(ROOT, "R62/stepvet.sqlite.gz"));
    try {
      const runId = "40060df8-bfac-4d9c-a5df-5904da9f92e6";
      const before = replayActiveTimes(store, runId, (history) => history);
      expect(before.map((b) => b.replayed.after)).toEqual(before.map((b) => b.recorded.after));
      const [plan] = replayActiveTimes(store, runId);
      expect(plan).toMatchObject({ report: "sizing/plan-0.json", recorded: { basis: "history", after: 2_100_000 }, replayed: { basis: "initiative", tokensPerMinute: 71_173 } });
      expect(plan?.replayed.after).toBeGreaterThan(store.run(runId).active_ms);
    } finally {
      dispose();
    }
  }, 120000);

  test("R56 hdrlens: the stalled analyze call that waited for the provider now climbs the recovery ladder (#1877)", () => {
    const path = join(ROOT, "R56/hdrlens.sqlite.gz");
    // Before #1877 a stall had no ladder: the replay with no rung matches the recording.
    const before = replayTrace(path, { stallRule: () => null }).runs.flatMap((r) => r.stallLadder);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((b) => b.recorded === "none" && b.replayed === "none")).toBe(true);
    const now = replayTrace(path).runs.flatMap((r) => r.stallLadder);
    expect(now.map((b) => [b.stage, b.model, b.replayed])).toEqual([
      ["analyze", "codex/gpt-6.1-sol", "fresh-session"],
    ]);
  }, 120000);
});

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

/** Finished features below and above the range of their initiative's first replayed start, by round. */
function rangeMisses(options: { recencyHalfLife?: number } = {}) {
  const rounds = new Map<number, { features: number; below: number; above: number }>();
  for (const name of readdirSync(ROOT, { recursive: true, encoding: "utf8" }).filter((p) => p.endsWith(".sqlite.gz"))) {
    const path = join(ROOT, name);
    const replays = replayInitiativeStarts(path, options);
    if (!replays.length) continue;
    const { store, dispose } = openTrace(path);
    const used = new Map<string, number>();
    const finished = new Set<string>();
    try {
      for (const row of store.connection
        .query("SELECT l.feature_id AS feature, r.token_usage AS tokens, r.status AS status FROM initiative_runs l JOIN runs r ON r.id=l.run_id")
        .all() as { feature: string; tokens: number; status: string }[]) {
        used.set(row.feature, (used.get(row.feature) ?? 0) + row.tokens);
        if (row.status === "completed") finished.add(row.feature);
      }
    } finally {
      dispose();
    }
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
  /** The rounds from `from` to `to`, both included. */
  const sum = (from: number, to = last) =>
    [...rounds]
      .filter(([round]) => round >= from && round <= to)
      .reduce((t, [, c]) => ({ features: t.features + c.features, below: t.below + c.below, above: t.above + c.above }), { features: 0, below: 0, above: 0 });
  return { all: sum(0), window: sum(last - RANGE_WINDOW + 1), r63to68: sum(63, 68) };
}

/** Rounds of the rolling window a range backtest bounds too (#2150). */
const RANGE_WINDOW = 6;
const quarterBound = (features: number) => 0.25 + 2 * Math.sqrt((0.25 * 0.75) / features);

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
  test("rounds 63 to 68 miss their range above the bound by default and within it at a half-life of 2; the rolling window is bounded", () => {
    const off = rangeMisses();
    expect(off.r63to68.features).toBe(60);
    expect(off.r63to68.below / off.r63to68.features).toBeGreaterThan(quarterBound(off.r63to68.features));
    const on = rangeMisses({ recencyHalfLife: 2 });
    for (const share of [on.r63to68, on.all]) {
      expect(share.below / share.features).toBeLessThanOrEqual(quarterBound(share.features));
      expect(share.above / share.features).toBeLessThanOrEqual(quarterBound(share.features));
    }
    expect(on.r63to68.below).toBeLessThan(off.r63to68.below);
    // The standing guard: the last six rounds, as the whole corpus is, within the bounds by default.
    expect(off.window.below / off.window.features).toBeLessThanOrEqual(quarterBound(off.window.features));
    expect(off.window.above / off.window.features).toBeLessThanOrEqual(quarterBound(off.window.features));
  }, 1200000);
});

describe("finding chains replay on recorded findings (#1981)", () => {
  // R62 md-site 8711b632 ran with chainRewrite off: six findings on `findDelimitedInline`, each the
  // next nesting of emphasis delimiter runs, and four correctives (T009-T012: 6.14M tokens, $5.92)
  // that patched one case each. Its trace was exported before finding bodies were kept, so the
  // review findings come from the run state's last two reviews (F1, F3, F4, F5) and the two
  // convergence findings (F2, F4-2) are lost: the chain the trace shows starts at F3.
  test("R62 md-site: with chainRewrite on, the findDelimitedInline chain rewrites at its second link with its repros as the battery", () => {
    const { store, dispose } = openTrace(join(ROOT, "R62/md-site.sqlite.gz"));
    try {
      const runId = "8711b632-62b7-45ad-9100-15b034464379";
      const replay = replayChainEscalation(store, runId);
      expect(replay.missingBodies).toEqual(["F2", "F4-2"]);
      expect(replay.steps.map((s) => [s.findingId, s.taskId, s.chain, s.decision, s.battery])).toEqual([
        ["F1", "T009", ["F1"], "patch", []],
        // F3 repeats F2, whose body the trace lost: the chain ends there.
        ["F3", "T011", ["F3"], "patch", []],
        ["F4", null, ["F3", "F4"], "rewrite", ["F3", "F4"]],
        ["F5", null, ["F3", "F4", "F5"], "rewrite", ["F3", "F4", "F5"]],
      ]);
      // A battery holds only findings with a repro, so each link of the chain carries its case.
      expect(store.findings(runId).map((f) => f.id)).toEqual(["F1", "F2", "F3", "F4", "F4-2", "F5"]);
      // Off, the same findings patch, as the round did, and nothing was recorded under chains/.
      expect(replayChainEscalation(store, runId, { policy: "off" }).steps.every((s) => s.decision === "patch")).toBe(true);
      expect(chainCosts(store, runId)).toEqual([]);
    } finally {
      dispose();
    }
  }, 120000);
});

describe("finding chains keyed by file and defect family (#2048)", () => {
  // R65 md-site 1e8e7465: F1 (`findDestinationEnd`, corrected by T009) and F3 (`renderInline`,
  // T011, `repeatOf: null`) were both nested inline constructs in src/markdown.ts, and each was a
  // chain of one. The trace predates `family`, so the replay reads the families a reviewer that
  // declares them would have given.
  test("R65 md-site: with F1 and F3 of one family, F3's corrective rewrites against both cases", () => {
    const { store, dispose } = openTrace(join(ROOT, "R65/md-site.sqlite.gz"));
    try {
      const runId = "1e8e7465-2238-44b0-adbd-dfc61aee4bb2";
      const row = (replay: ReturnType<typeof replayChainEscalation>, id: string) => {
        const step = replay.steps.find((s) => s.findingId === id);
        return step && [step.taskId, step.chain, step.family, step.decision, step.battery];
      };
      const recorded = replayChainEscalation(store, runId);
      // As recorded no finding names a family: the family column is empty and nothing changes.
      expect(recorded.steps.every((s) => s.family === null)).toBe(true);
      expect(row(recorded, "F3")).toEqual(["T011", ["F3"], null, "patch", []]);
      const families = { F1: "nested-inline-delimiters", F3: "Nested inline delimiters" };
      const declared = replayChainEscalation(store, runId, { families });
      expect(row(declared, "F1")).toEqual(["T009", ["F1"], "nested-inline-delimiters", "patch", []]);
      expect(row(declared, "F3")).toEqual(["T011", ["F1", "F3"], "nested-inline-delimiters", "rewrite", ["F1", "F3"]]);
      // F2 is on another file and names no family.
      expect(row(declared, "F2")).toEqual(["T010", ["F2"], null, "patch", []]);
      expect(replayChainEscalation(store, runId, { families, policy: "off" }).steps.every((s) => s.decision === "patch")).toBe(true);
    } finally {
      dispose();
    }
  }, 120000);

  // R66 expenses-py f02b4d32: F2 (`build_report`, T010 with F1) and F3 (`_share`, T011, 641k
  // tokens), both Decimal context precision in expenses/report.py; F1 (`render_table`) is another
  // defect on the same file.
  test("R66 expenses-py: with F2 and F3 of one family, F3's corrective rewrites against both cases", () => {
    const { store, dispose } = openTrace(join(ROOT, "R66/expenses-py.sqlite.gz"));
    try {
      const runId = "f02b4d32-69eb-44c4-8036-967e499f7995";
      const steps = (replay: ReturnType<typeof replayChainEscalation>) => replay.steps.map((s) => [s.findingId, s.taskId, s.chain, s.family, s.decision, s.battery]);
      expect(steps(replayChainEscalation(store, runId))).toEqual([
        ["F1", "T010", ["F1"], null, "patch", []],
        ["F2", "T010", ["F2"], null, "patch", []],
        ["F3", "T011", ["F3"], null, "patch", []],
      ]);
      const families = { F2: "decimal-context-precision", F3: "decimal-context-precision" };
      expect(steps(replayChainEscalation(store, runId, { families }))).toEqual([
        ["F1", "T010", ["F1"], null, "patch", []],
        ["F2", "T010", ["F2"], "decimal-context-precision", "patch", []],
        ["F3", "T011", ["F2", "F3"], "decimal-context-precision", "rewrite", ["F2", "F3"]],
      ]);
    } finally {
      dispose();
    }
  }, 120000);
});

describe("repeated corrective failures replay on recorded chains (#1996)", () => {
  test("R64 cfgquill lint: T006 fails as T005 did, a would-stop the round did not record; other chains do not repeat", () => {
    const replay = replayTrace(join(ROOT, "R64/cfgquill.sqlite.gz"));
    const lint = replay.runs.find((r) => r.runId.startsWith("a843cc11"));
    expect(lint?.repeatedFailures.map((b) => [b.taskId, b.previous, b.recorded, b.replayed, b.source])).toEqual([
      ["T005", null, null, "first", "findings"],
      ["T006", "T005", null, "repeat", "findings"],
    ]);
    expect(lint?.newRepeatStops).toBe(1);
    // Before #1996 nothing compared the rounds.
    const counted = replayTrace(join(ROOT, "R64/cfgquill.sqlite.gz"), { repeatRule: (previous) => (previous ? "progress" : "first") });
    expect(counted.runs.reduce((n, r) => n + r.newRepeatStops, 0)).toBe(0);
  }, 120000);
});

describe("edge probe crashes replay on recorded cases (#2136)", () => {
  test("R68 url-shortener T001: the two AC-007 crashes in src/storage.ts are findings of T001 once the record keeps their output", () => {
    // R68 url-shortener 67c90258 is not in the corpus; this is its `probes/edge/T001.json`, which
    // kept only status and reason, so its crash decisions cannot be replayed (null).
    const reason = "The command exited 1 without printing the claimed actual value";
    const r68: EdgeRecord = {
      schemaVersion: 1,
      taskId: "T001",
      languages: ["typescript"],
      cases: [
        { criterionId: "AC-007", status: "inconclusive", reason, decision: "pass" },
        { criterionId: "AC-007", status: "inconclusive", reason, decision: "pass" },
      ],
    };
    expect(replayEdgeRecord("probes/edge/T001.json", r68).map((b) => [b.recorded, b.replayed, b.crashRecorded, b.crashReplayed])).toEqual([
      ["pass", "pass", null, null],
      ["pass", "pass", null, null],
    ]);
    // The same cases with the output the pilot's later probes printed, as the record keeps it now.
    const output = 'error: Missing parameter "code"\n      at createLink (C:\\Users\\bench\\url-shortener\\src\\storage.ts:70:10)\n      at C:\\Users\\bench\\url-shortener\\[eval]:1:57\n\nBun v1.3.0 (Windows x64)\n';
    const kept: EdgeRecord = { ...r68, files: ["src/server.ts", "src/storage.ts"], cases: r68.cases.map((c) => ({ ...c, outputTail: output, crash: "pass" })) };
    const replayed = replayEdgeRecord("probes/edge/T001.json", kept);
    // edgeDecision is unchanged; the crash rule turns both into findings of T001, the defect's owner.
    expect(replayed.map((b) => [b.recorded, b.replayed, b.crashReplayed])).toEqual([
      ["pass", "pass", "finding"],
      ["pass", "pass", "finding"],
    ]);
    expect(edgeCrashDecision("inconclusive", output, kept.files!).actual).toBe('error: Missing parameter "code"');
  });
});

describe("own-plan feature need replays on recorded initiatives (#2043)", () => {
  // A feature whose run has a sized plan is priced at its plan's expected tokens (times the
  // measured plan-to-actual ratio) when that is above its class need. R65 uritpl ran without plan
  // ahead: at its syntax start the encode run's plan (expected 2.10M) raises encode's low end from
  // its class value (1.38M), and nothing else moves. The high end at every start is what it was
  // before the rule (R65 must not rise), and no start parks. R66 nodepluck, the round the issue
  // measured, has no trace in the corpus; its scenario test replays its numbers.
  test("R65 uritpl: the high end at every start is unchanged, encode's low end follows its plan", () => {
    const [replay] = replayInitiativeStarts(join(ROOT, "R65/uritpl.sqlite.gz"));
    expect(replay?.newStartStops).toBe(0);
    expect(replay?.starts.map((s) => [s.featureId, s.tokens?.high])).toEqual([
      ["base", 30_764_134],
      ["values", 31_330_378],
      ["encode", 31_330_378],
      ["syntax", 29_687_632],
      ["expansion", 27_316_895],
      ["problem", 23_100_637],
      ["cmd-read", 22_809_650],
      ["lint", 22_680_087],
      ["cmd-expand", 23_849_366],
      ["cli", 24_343_314],
      ["docs", 22_864_328],
    ]);
    const syntax = replay?.starts.find((s) => s.featureId === "syntax");
    // Before #2043: low 14,743,241, encode 1,381,658-3,513,129.
    expect(syntax?.tokens?.low).toBe(15_463_514);
    expect(syntax?.estimate.find((f) => f.featureId === "encode")).toEqual({ featureId: "encode", low: 2_101_931, high: 3_513_129 });
  }, 600000);
});

/** Finished test tasks of a trace's initiative feature runs, with the cases their sizing reports recorded. */
function featureTestTasks(path: string): Map<string, SizingSample[]> {
  const { store, workspace, dispose } = openTrace(path);
  try {
    const cases = new Map<string, number>();
    for (const { runId, id } of store.connection
      .query("SELECT run_id AS runId, id FROM artifacts WHERE logical_path LIKE 'sizing/plan-%' ORDER BY created_at, id")
      .all() as { runId: string; id: string }[])
      for (const task of (JSON.parse(store.readArtifact(runId, id)) as Partial<SizingReport>).tasks ?? [])
        if (task.kind === "test" && (task.cases ?? 0) > 0) cases.set(`${runId}/${task.taskId}`, task.cases ?? 0);
    const features = new Map(
      (store.connection.query("SELECT run_id AS runId, feature_id AS featureId FROM initiative_runs").all() as {
        runId: string;
        featureId: string;
      }[]).map((r) => [r.runId, r.featureId]),
    );
    const byFeature = new Map<string, SizingSample[]>();
    for (const sample of samplesFrom(join(workspace, ".baked", "workflows.sqlite"), "project")) {
      const feature = features.get(sample.runId);
      const count = cases.get(`${sample.runId}/${sample.taskId}`);
      if (sample.kind !== "test" || !feature || !count) continue;
      byFeature.set(feature, [...(byFeature.get(feature) ?? []), { ...sample, cases: count }]);
    }
    return byFeature;
  } finally {
    dispose();
  }
}

describe("a brief's test volume replays on recorded test tasks (#2055)", () => {
  // The traces' briefs are anonymized, so the cases each feature's sizing reports recorded stand in
  // for the volume a brief demands. Each finished feature is priced from its initiative's other
  // finished features (this project's runs, the rate's first basis): its test tasks' cases times
  // the cheapest of their rates is a floor of its need, and a floor above what the feature's test
  // tasks alone used is an overprice. A rate of single tasks would be no floor: they ran from 1,354
  // tokens a case, so 509 cases of nodepluck floored at 0.69M of its 15.24M test tokens. Per run the
  // floor binds: nodepluck's readcmd, 110 cases at 21,124 a case, is floored at 2.32M of the 4.04M
  // its test tasks used and the 6.24M the feature used. Above its test tokens: 20 of 162 features.
  test("a feature's test-volume floor stays under what its test tasks used, nodepluck's binds", () => {
    let features = 0;
    let above = 0;
    let readcmd: { floor: number; tokens: number } | null = null;
    for (const path of readdirSync(ROOT, { recursive: true, encoding: "utf8" })
      .filter((p) => p.endsWith(".sqlite.gz"))
      .map((p) => join(ROOT, p))) {
      if (!replayInitiativeStarts(path).length) continue;
      const tasks = featureTestTasks(path);
      for (const [featureId, own] of tasks) {
        const rate = testCaseRate([...tasks].filter(([id]) => id !== featureId).flatMap(([, s]) => s));
        if (rate.basis !== "project") continue;
        const cases = own.reduce((n, s) => n + (s.cases ?? 0), 0);
        const tokens = own.reduce((n, s) => n + s.tokens, 0);
        const floor = cases * rate.perCase.low;
        features++;
        if (floor > tokens) above++;
        if (path.endsWith("nodepluck.sqlite.gz") && featureId === "readcmd") readcmd = { floor, tokens };
      }
    }
    expect(features).toBeGreaterThanOrEqual(150);
    expect(above / features).toBeLessThanOrEqual(0.25 + 2 * Math.sqrt((0.25 * 0.75) / features));
    expect(readcmd).toEqual({ floor: 110 * 21_124, tokens: 4_044_583 });
  }, 600000);
});

describe("the plan charge replays on recorded initiatives (#2100, #2056)", () => {
  // An open feature run with a sized plan is held at the high end of its plan's need at the
  // measured ratio instead of its run limit, in shadow by default: no recorded decision moves, and
  // each rewound start reports what the charge frees (positive) or adds (negative) and the share
  // gate's verdict with it. R67 ampwhy, the round the issue measured (30.5M held at cli's gate for
  // runs that had used 0.05M-6.6M), has no trace in the corpus; its scenario test rebuilds the gate.
  // R66 nodepluck is the opposite round: its pool was short for use. The rewind restores each
  // run's policy at the moment (#2061), so an open run counts at the limit it had then (readcmd's
  // was 5.79M at the park, 7.24M at its end).
  test("R66 nodepluck: no start would park with the charge; base's plan adds tokens; select still parks at 14:40:20", () => {
    const park = Date.UTC(2026, 9, 24, 14, 40, 20);
    const [replay] = replayInitiativeStarts(join(ROOT, "R66", "nodepluck.sqlite.gz"), { budgetAtStart: true, moments: [park] });
    expect(replay?.newStartStops).toBe(0);
    const charged = replay?.starts.filter((s) => s.planCharge) ?? [];
    expect(charged.filter((s) => s.featureId).every((s) => s.planCharge?.replayed === "pass")).toBe(true);
    // #2056: base's plan priced its run 0.56M above its 4.36M limit at json's start.
    const json = replay?.starts.find((s) => s.featureId === "json")?.planCharge;
    expect(json?.runs).toEqual([{ featureId: "base", usedTokens: 317_456, limitTokens: 4_356_950, chargeTokens: 4_916_607 }]);
    expect(json?.releasedTokens).toBe(-559_657);
    // At the park, readcmd's plan frees 33k of its 5.79M limit; select still needs more than that.
    const atPark = replay?.starts.find((s) => s.at === park)?.planCharge;
    expect(atPark).toMatchObject({ featureId: "select", replayed: "park", releasedTokens: 33_117 });
    expect(atPark?.runs.map((r) => r.featureId)).toEqual(["readcmd"]);
  }, 600000);

  test("#2245: enforced with stopModes unset, R71 xmlvet's canonical parks at 04:48 with 4.7M left and one extend remedy", () => {
    // The promotion's true would-park (R71, shadow): at canonical's start the open runs held 20.6M
    // of the 30.0M pool at their limits, and 25.3M at their sized plans' need. scanner's plan
    // priced its run at 11.75M against an 8.0M limit (it used 12.10M); the share gate's size class
    // had put its need at 1.87M-5.62M. The pool ran short 65 minutes later (outline-command needed
    // 836,956 more at 05:53:56), so the park is early and true: the extension it asks for would
    // have been made while the operator was there instead of with the tree idle. The trace's
    // policy has no stopModes, so the replay takes the reason's default.
    const advice: { feature: string; mode: string | undefined; remaining: number; advice: ReturnType<typeof shareShortfall> }[] = [];
    const [replay] = replayInitiativeStarts(join(ROOT, "R71", "xmlvet.sqlite.gz"), {
      budgetAtStart: true,
      gate: (view, feature) => {
        const verdict = shareShortfall(view, feature);
        if (verdict) advice.push({ feature: feature.id, mode: view.budget.planCharge?.mode, remaining: view.budget.remaining.tokens, advice: verdict });
        return verdict;
      },
    });
    expect(replay?.newStartStops).toBe(1);
    const canonical = replay?.starts.find((s) => s.featureId === "canonical");
    expect(canonical?.replayed).toBe("park");
    expect(new Date(canonical?.at ?? 0).toISOString().slice(11, 16)).toBe("04:48");
    expect(canonical?.planCharge).toMatchObject({ limitCommittedTokens: 20_579_789, planCommittedTokens: 25_336_588, releasedTokens: -4_756_799, featureId: "canonical", replayed: "park" });
    expect(canonical?.planCharge?.runs.find((r) => r.featureId === "scanner")).toEqual({ featureId: "scanner", usedTokens: 739_992, limitTokens: 8_000_000, chargeTokens: 11_749_743 });
    // Every other start still passes, enforced.
    expect(replay?.starts.filter((s) => s.featureId !== "canonical").every((s) => s.replayed === "pass")).toBe(true);
    // The park is the share gate's own, in enforce: 4.7M left, and one extend remedy (#2042).
    const park = advice.find((a) => a.feature === "canonical");
    expect(park?.mode).toBe("enforce");
    expect(park?.remaining).toBe(30_000_000 - 25_336_588);
    expect(park?.advice?.summary).toStartWith("The shared budget is short: canonical has 25324 tokens available");
    expect(park?.advice?.remedies).toEqual([{ action: "extend", initiativeId: "xmlvet", suggestedTokens: 36_900_000 }]);
    // The other initiatives of the two rounds (their 39 would_release records) park no start
    // enforced: no false would-park. Nor does R60 wheeltags, whose dead an overpriced plan parked
    // before #2253.
    for (const trace of ["R70/namesound", "R70/evalpin", "R71/evalpin", "R60/wheeltags"])
      for (const other of replayInitiativeStarts(join(ROOT, `${trace}.sqlite.gz`), { budgetAtStart: true })) {
        expect(other.newStartStops).toBe(0);
        expect(other.starts.every((s) => s.planCharge === null || s.planCharge.replayed === "pass")).toBe(true);
      }
  }, 900000);
  test("#2253: R60 wheeltags parks no start with the charge, names held at its expected need; R71 xmlvet's canonical still parks", () => {
    // names' plan sized its run at 10.3M-14.1M against its 8.0M limit, unmeasured (ratio null);
    // it used 4.57M. At its high end the charged gate parked dead at 19:31:58 (154,373 short).
    // A plan whose low end is above its run's limit is held at its expected need while the ratio
    // is unmeasured: 10,645,303, still above the limit.
    const [wheeltags] = replayInitiativeStarts(join(ROOT, "R60", "wheeltags.sqlite.gz"), { budgetAtStart: true });
    expect(wheeltags?.newStartStops).toBe(0);
    expect(wheeltags?.starts.every((s) => s.planCharge === null || s.planCharge.replayed === "pass")).toBe(true);
    const dead = wheeltags?.starts.find((s) => s.featureId === "dead")?.planCharge;
    expect(dead?.runs.find((r) => r.featureId === "names")).toEqual({ featureId: "names", usedTokens: 351_910, limitTokens: 8_000_000, chargeTokens: 10_645_303 });
    // In dollars the same tokens at the task-call rate (planChargeUsd follows the token charge).
    const names = dead?.usd?.runs.find((r) => r.featureId === "names");
    expect(names?.chargeUsd).toBeCloseTo(10_645_303 * (dead?.usd?.taskRate ?? 0), 6);
    // scanner's plan straddles its 8.0M limit (4.26M-11.75M) and used 12.10M: the high end stays,
    // and canonical's would-park at 04:48 (4.7M of the 30.0M pool left) is kept.
    const [xmlvet] = replayInitiativeStarts(join(ROOT, "R71", "xmlvet.sqlite.gz"), { budgetAtStart: true });
    const canonical = xmlvet?.starts.find((s) => s.featureId === "canonical")?.planCharge;
    expect(canonical).toMatchObject({ planCommittedTokens: 25_336_588, featureId: "canonical", replayed: "park" });
    expect(canonical?.runs.find((r) => r.featureId === "scanner")?.chargeTokens).toBe(11_749_743);
    expect(xmlvet?.starts.filter((s) => s.planCharge?.replayed === "park").map((s) => s.featureId)).toEqual(["canonical"]);
  }, 600000);

  test("#2124: in dollars R62 stepvet's open runs are held at their plans at the task-call rate, and no start moves", () => {
    // Before #2124 an open run held max(spent + reserved, its maxCostUsd) of the dollar budget.
    // At stepscmd's start, rewound to that moment (#2061), the runs held $21.11 of the $30 cap
    // ($8.88 remaining, as the round's share gate recorded); lines' plan, priced at what the
    // initiative's task calls paid ($1.00 per million), holds $2.22 of its $2.41 cap, and the
    // four open runs together free $4.86. Before a task call is priced (lines' start) the runs
    // keep their caps.
    const [replay] = replayInitiativeStarts(join(ROOT, "R62", "stepvet.sqlite.gz"), { budgetAtStart: true });
    expect(replay?.newStartStops).toBe(0);
    expect(replay?.finalUsd).toBe(26.33);
    const first = replay?.starts.find((s) => s.featureId === "lines")?.planCharge?.usd;
    expect(first).toMatchObject({ taskRate: null, releasedUsd: 0 });
    expect(first?.runs).toEqual([{ featureId: "base", limitUsd: 2.41, chargeUsd: null }]);
    const steps = replay?.starts.find((s) => s.featureId === "stepscmd")?.planCharge;
    expect(steps?.replayed).toBe("pass");
    expect(steps?.usd?.taskRate! * 1e6).toBeCloseTo(1.0, 1);
    expect(steps?.usd?.limitCommittedUsd).toBeCloseTo(21.11, 2);
    expect(steps?.usd?.releasedUsd).toBeCloseTo(4.86, 2);
    expect(steps?.usd?.runs.find((r) => r.featureId === "lines")).toEqual({ featureId: "lines", limitUsd: 2.41, chargeUsd: expect.closeTo(2.22, 2) });
    for (const run of steps?.usd?.runs ?? []) expect(run.chargeUsd!).toBeLessThanOrEqual(run.limitUsd);
    // Every rewound start has a dollar side, and the plan charge decides no start differently.
    expect(replay?.starts.filter((s) => s.planCharge).every((s) => s.planCharge?.usd && s.planCharge.replayed === "pass")).toBe(true);
  }, 600000);
});

describe("initiative-pool-growth replays on recorded growth bounds (#2280)", () => {
  test("R73 flatelens commands: one would-stop, and the capped charge leaves its bounds at its share", () => {
    const { store, dispose } = openTrace(join(ROOT, "R73", "flatelens.sqlite.gz"));
    try {
      const bounds = replayPoolBounds(store).flatMap((i) => i.poolBounds);
      // Its first initiative-growth raised the 4.65M share to the base ceilings (8M, 12M) and $3.82 to
      // $19.30 with 5.66M tokens and $10.66 under the ceiling left after the others at its gate.
      expect(bounds.map((b) => ({ featureId: b.featureId, recorded: b.recorded, over: b.over.map((o) => [o.kind, o.value]), holdTokens: b.holdTokens, holdUsd: b.holdUsd }))).toEqual([
        { featureId: "commands", recorded: false, over: [["maxRunTokens", 8_000_000], ["extendToTokens", 12_000_000], ["maxRunCostUsd", 19.3]], holdTokens: 34_200_000 - 28_535_132, holdUsd: 10.66 },
      ]);
    } finally {
      dispose();
    }
    // The fix on initiative-1.json's recorded inputs: a 25.14M / $19.30 charge, 28.54M used by the
    // others and docs' 1.01M low waiting, $25.34 spent under the $36 ceiling.
    const hold = chargeHold({ charge: { tokens: 25_142_010, usd: 19.3 }, own: { usedTokens: 0, usedUsd: 0 }, pool: { limitTokens: 34_200_000, othersTokens: 28_535_132, waitingLowTokens: 1_012_900 }, dollars: { ceilingUsd: 36, othersUsd: 25.34 } });
    expect(hold).toMatchObject({ tokens: 4_651_968, usd: 10.66, cappedTokens: true, cappedUsd: true });
    const share = { ...fixturePolicy, maxTotalTokens: 4_651_968, maxCostUsd: 3.82, sizing: { maxRunTokens: 4_651_968, extendToTokens: 4_651_968, maxRunCostUsd: 3.82 } };
    const base = { ...fixturePolicy, sizing: { maxRunTokens: 8_000_000, extendToTokens: 12_000_000 } };
    const after = refreshedGrowth(share, base, { tokens: hold.tokens, usd: hold.usd!, calls: 0, activeMs: 0 }, { calls: 0, activeMs: 0 }, { tokens: 0, usd: 0, calls: 0, activeMs: 0 });
    // The token bounds stay at the share (4.65M, what the pool left after docs' low); the dollar
    // bound rises only to the $10.66 the ceiling leaves, not $19.30 to $24.08.
    expect(after?.sizing).toMatchObject({ maxRunTokens: 4_651_968, extendToTokens: 4_651_968, maxRunCostUsd: 10.66 });
  }, 120000);

  test("#2294: the last features of R71 xmlvet and R73 evalpin keep their bounds at the pool left", () => {
    // Both started on all the pool had left with no other feature waiting; their recorded refreshes
    // (spareTokens null) took the base ceilings. With a room that is never null, the view at their
    // start gate, the run holding its share, leaves no room: the refresh raises nothing, so neither
    // run's bound passes the pool and `initiative-pool-growth` has nothing to record there.
    const base = { ...fixturePolicy, sizing: { maxRunTokens: 8_000_000, extendToTokens: 12_000_000 } };
    for (const [round, app, featureId, share] of [["R71", "xmlvet", "cli-release", 6_630_531], ["R73", "evalpin", "delivery", 3_305_374]] as const) {
      const { store, dispose } = openTrace(join(ROOT, round, `${app}.sqlite.gz`));
      try {
        const gate = (store.connection.query("SELECT payload_json FROM initiative_events WHERE type='feature.share_gate' ORDER BY seq").all() as { payload_json: string }[])
          .map((g) => JSON.parse(g.payload_json) as ShareGateRecord)
          .filter((g) => g.featureId === featureId && g.verdict === "pass")
          .at(-1)!;
        expect(gate.view.budget.remaining.tokens).toBe(share);
        // Once its run holds its share, no feature waits and the pool has nothing left.
        const open = { ...gate.view, budget: { ...gate.view.budget, remaining: { ...gate.view.budget.remaining, tokens: gate.view.budget.remaining.tokens - share } }, features: gate.view.features.map((f) => ({ ...f, share: null })) };
        const room = growthLimit(open, featureId);
        expect(room).toBe(0);
        const policy = { ...fixturePolicy, maxTotalTokens: share, sizing: { maxRunTokens: share, extendToTokens: share } };
        const held = { tokens: share, usd: 0, calls: 0, activeMs: 0 };
        expect(refreshedGrowth(policy, base, held, { calls: 0, activeMs: 0 }, { tokens: room, usd: null, calls: 0, activeMs: 0 })).toBeNull();
        // The recorded refresh with the null room raised them to the base ceilings.
        expect(refreshedGrowth(policy, base, held, { calls: 0, activeMs: 0 }, { tokens: null, usd: null, calls: 0, activeMs: 0 })?.sizing).toMatchObject({ maxRunTokens: 8_000_000, extendToTokens: 12_000_000 });
      } finally {
        dispose();
      }
    }
  }, 120000);
});

describe("the dollar notice replays at the measured ratio (#2186)", () => {
  // The dollar notice prices the features still to run at the estimate's measured ratio itself
  // (`progress.rawRatio`), the forecast and its stop at the blend. R66 nodepluck, rewound to
  // syntax's acceptance (14:26:59) and lint's (14:39:39), the moments of #2062's token notice.
  test("R66 nodepluck: the measured ratio's forecast is nearer the final $28.45, and no notice warns under the $37.50 ceiling", () => {
    const syntax = Date.UTC(2026, 9, 24, 14, 26, 59, 558);
    const lint = Date.UTC(2026, 9, 24, 14, 39, 39, 627);
    const [replay] = replayInitiativeStarts(join(ROOT, "R66", "nodepluck.sqlite.gz"), { budgetAtStart: true, moments: [syntax, lint] });
    expect(replay?.finalUsd).toBeCloseTo(28.45, 2);
    const at = (t: number) => replay?.starts.find((s) => s.at === t);
    // At syntax the blend weighs the measured 1.55x a third (1.18x, $23.41), at lint 1.45x two thirds.
    expect(at(syntax)).toMatchObject({ spentUsd: 15.68, forecastUsd: 23.41, ceilingUsd: 37.5, advice: { forecastUsd: 24.25, ratio: 1.55, blendedRatio: 1.18 } });
    expect(at(lint)).toMatchObject({ spentUsd: 22.29, forecastUsd: 25.83, advice: { forecastUsd: 26.15, ratio: 1.45, blendedRatio: 1.3 } });
    // The round ended under its $30 cap: neither forecast passes the ceiling at any start, so
    // nothing warns, and no start parks.
    expect(replay?.starts.filter((s) => s.forecastNotice !== null)).toEqual([]);
    expect(replay?.newStartStops).toBe(0);
  }, 600000);
});
