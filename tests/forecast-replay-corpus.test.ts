import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { callCostRate, costRate } from "../src/core/workflows/budget.js";
import { costGrowthLimit, dollarShortfall, shareShortfall } from "../src/core/workflows/initiatives/service.js";
import { forecastSamples } from "../src/core/workflows/stage-price.js";
import { adaptiveFirstByteMs } from "../src/core/llm/provider-health.js";
import { planApprovalDecision } from "../src/core/workflows/auto-approval.js";
import { CAPACITY_PROBE } from "../src/core/workflows/sizing.js";
import { type CallRate, chainCosts, openTrace, type PlanPriceReplay, replayChainEscalation, replayEdgeRecord, replayInitiativeStarts, replayPlanApprovals, replayPlanPrices, replayTrace, type TestSplitRule } from "../src/core/workflows/trace.js";
import { type EdgeRecord, edgeCrashDecision } from "../src/core/verification/edge-inputs.js";

// #1649, #1715: every recorded bench-round trace replays through the current host decisions: the
// forecast and cap code, the per-call cost cap (#1740), the first-response deadline of each model
// call, the test task split of each sizing report (#1789), each usage-policy refusal (#1895), each finding-chain decision (#1959), each repeated corrective failure (#1996), each spec conflict decision for the request (#2016), each misquote host-fix decision (#2047), each decision for the request or the platform on checked evidence (#2032), each token-pool park's extension inside the dollar cap (#2042), and the initiative share gate (#1707), asked both on its recorded inputs and with each start
// rewound and recomputed, and the plan auto-approval on the run state it was asked with (#1707). A
// stop, cap growth, park or approval decision the recorded run did not make fails the suite, unless
// accepted.json lists it for that run or initiative with the reason: the pull request that changes
// the decision says so in its diff.
const ROOT = join(import.meta.dir, "fixtures", "bench-traces");

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
  newShareStops?: number;
  newPoolGrowth?: number;
  newStartStops?: number;
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
          newStartStops: initiative.newStartStops,
        }).toEqual({
          initiative: initiative.initiativeId,
          newShareStops: allowed?.newShareStops ?? 0,
          newPoolGrowth: allowed?.newPoolGrowth ?? 0,
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
      gate: (view, feature) => {
        seen.set(feature.id, { view, feature });
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
    // At that price the two later starts look short against the cap, but at two measured features
    // the rule counts the remaining dollars to the $37.50 ceiling (#2099): the initiative spent
    // $17.69 in the end, so their would-stops would have been false.
    const [plain] = replayInitiativeStarts(join(ROOT, "R59", "wheeltags.sqlite.gz"));
    expect(plain?.finalUsd).toBe(17.69);
    for (const id of ["dead-command", "expand-command"]) {
      const start = seen.get(id)!;
      expect(start.view.budget.cost).toMatchObject({ shareMode: "shadow", measuredFeatures: 2 });
      expect(costGrowthLimit(start.view, id)!).toBeLessThan(start.feature.needUsd!.low);
      expect(dollarShortfall(start.view, start.feature)).toBeNull();
      expect(replay?.starts.find((b) => b.featureId === id)?.replayed).toBe("pass");
    }
    expect(plain?.starts.every((b) => b.shareWouldStop === null)).toBe(true);
  }, 120000);

  test("#1714: R62 stepvet's dollar share is not checked before a feature is measured", () => {
    // R62 recorded two initiative-dollar-share would-stops, lines and stepexpr, both at
    // measuredFeatures 0 with every waiting feature's low reserved. Both started anyway, finished
    // and were accepted, with $3.67 of the $30 left unspent.
    const seen = new Map<string, { view: Parameters<typeof shareShortfall>[0]; feature: Parameters<typeof shareShortfall>[1] }>();
    replayInitiativeStarts(join(ROOT, "R62", "stepvet.sqlite.gz"), {
      gate: (view, feature) => {
        seen.set(feature.id, { view, feature });
        return shareShortfall(view, feature);
      },
    });
    for (const id of ["lines", "stepexpr"]) {
      const start = seen.get(id)!;
      expect(start.view.budget.cost.measuredFeatures).toBe(0);
      expect(costGrowthLimit(start.view, id)!).toBeLessThan(start.feature.needUsd!.low);
      expect(dollarShortfall(start.view, start.feature)).toBeNull();
    }
    // From three measured features the cap bounds the check again (#2099), and the replay keeps
    // the would-stop next to what the initiative spent in the end.
    const later = seen.get("stepscmd")!;
    expect(later.view.budget.cost.measuredFeatures).toBe(3);
    expect(dollarShortfall(later.view, later.feature)).toStartWith("The shared dollar budget is short: stepscmd has $");
    const [replay] = replayInitiativeStarts(join(ROOT, "R62", "stepvet.sqlite.gz"));
    expect(replay?.starts.find((b) => b.featureId === "stepscmd")?.shareWouldStop).toMatchObject({ measuredFeatures: 3, finalUsd: 26.33 });
    expect(replay?.starts.filter((b) => b.shareWouldStop !== null).map((b) => b.featureId)).toEqual(["stepscmd"]);
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
      ["expansion", 27_540_739],
      ["problem", 23_100_637],
      ["cmd-read", 22_809_650],
      ["lint", 22_834_018],
      ["cmd-expand", 24_446_096],
      ["cli", 24_679_293],
      ["docs", 22_864_328],
    ]);
    const syntax = replay?.starts.find((s) => s.featureId === "syntax");
    // Before #2043: low 14,743,241, encode 1,381,658-3,513,129.
    expect(syntax?.tokens?.low).toBe(15_463_514);
    expect(syntax?.estimate.find((f) => f.featureId === "encode")).toEqual({ featureId: "encode", low: 2_101_931, high: 3_513_129 });
  }, 600000);
});

describe("the plan charge replays on recorded initiatives (#2100, #2056)", () => {
  // An open feature run with a sized plan is held at the high end of its plan's need at the
  // measured ratio instead of its run limit, in shadow by default: no recorded decision moves, and
  // each rewound start reports what the charge frees (positive) or adds (negative) and the share
  // gate's verdict with it. R67 ampwhy, the round the issue measured (30.5M held at cli's gate for
  // runs that had used 0.05M-6.6M), has no trace in the corpus; its scenario test rebuilds the gate.
  // R66 nodepluck is the opposite round: its pool was short for use. The rewind keeps each run's
  // final policy, so an open run counts at the limit it grew to later, and what the charge frees
  // here is an upper bound (readcmd's limit was 5.79M at the park, 7.24M at its end).
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
    // At the park, readcmd's plan frees at most 1.48M; select still needs more than that.
    const atPark = replay?.starts.find((s) => s.at === park)?.planCharge;
    expect(atPark).toMatchObject({ featureId: "select", replayed: "park", releasedTokens: 1_481_563 });
    expect(atPark?.runs.map((r) => r.featureId)).toEqual(["readcmd"]);
  }, 600000);
});
