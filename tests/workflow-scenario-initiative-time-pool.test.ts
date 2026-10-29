import { afterEach, describe, expect, test } from "bun:test";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import {
  InitiativeService,
  type InitiativeView,
  shareShortfall,
  timeShortfall,
} from "../src/core/workflows/initiatives/service.js";
import { HOST_POOL_GROWTHS } from "../src/core/workflows/initiatives/token-pool.js";
import { replayTimePoolGrowth } from "../src/core/workflows/trace.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { type Remedy, RemedySchema } from "../src/core/workflows/remedies.js";
import { activeTimeLimit, type SizingReport } from "../src/core/workflows/sizing.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R74 ladlemath (#2336): 12 features, 3 at once, a shared time of 6 h. Every feature run was sized
// at the history's 134k tokens per active minute while the initiative's own finished runs ran at
// about 58k; three runs stopped "Active deadline exhausted" and the initiative stopped on its
// shared time. The tokens carried a forecast notice and a suggested pool; the time had neither,
// and the blocked feature runs offered a plain resume, which stops again at once (#2226).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MINUTE = 60_000;
/** The history's pace, and the initiative's own: half of it. */
const HISTORY_PACE = 120_000;
const OWN_PACE = 60_000;
const FIRST_WAVE = ["kitchen", "recipe", "inspect"];

const planOf = (workflow: string): InitiativePlan => ({
  schemaVersion: 1,
  title: "Ladle",
  goals: ["Create ladle"],
  completionCriteria: ["Ladle is ready"],
  features: [...FIRST_WAVE, "head"].map((id) => ({
    id,
    title: id,
    size: "medium",
    workflow,
    boundary: { scope: id, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`,
    dependsOn: [],
    mandatory: true,
  })),
});

/** Writes each feature's spec and plan under the feature run's own id. */
class FeatureExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      spec: Spec | null;
      extra: { featureId?: string };
    };
    const spec: Spec = data.spec ?? { ...fixtureSpec, featureId: data.extra.featureId ?? "fixture" };
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output !== "plan") return super.execute(request);
    const path = `${spec.featureId.split("_").at(-1)}.txt`;
    const markdown = `# Plan\n## Context\nCreate ${path}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${path}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
    const taskGraph = {
      schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
      tasks: [{ id: "T001", title: `Create ${path}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
    };
    return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
  }
}

/** Marks a run finished with `tokens` used over `minutes` of active time and `calls` agent calls. */
function finish(store: WorkflowStore, runId: string, tokens: number, minutes: number, calls = 0): void {
  store.connection.run("UPDATE runs SET status='completed', token_usage=?, active_ms=?, agent_calls=? WHERE id=?", [
    tokens,
    minutes * MINUTE,
    calls,
    runId,
  ]);
}

/** The first wave's agent calls per run in the calls scenario: 100 calls per million tokens (#2345). */
const OWN_CALLS = (OWN_PACE * 20) / 10_000;

/**
 * An initiative whose first wave of three features finished at `OWN_PACE`, beside five earlier
 * runs of the project at `HISTORY_PACE`, with `timeMs` of shared active time.
 */
async function ladle(workflow: "sdd" | "quick", timeMs: number, calls = { limit: 10_000, perRun: 0 }, workflows: { timePoolGrowth?: "off" | "shadow" } = {}) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    maxTotalTokens: 10_000_000,
    maxAgentCalls: 1000,
    costForecast: "off",
    clarification: "assume",
    sizing: { maxRunTokens: 10_000_000 },
  };
  const fixture = workflowFixture({ policy, executor: (root) => new FeatureExecutor(root) });
  cleanups.push(fixture.dispose);
  fixture.config.workflows = { ...fixture.config.workflows, ...workflows } as typeof fixture.config.workflows;
  const store = fixture.service.store;
  for (let i = 0; i < 5; i++) {
    const run = await fixture.start(`earlier-${i}`);
    finish(store, run.runId, HISTORY_PACE * 20, 20);
  }
  const initiatives = new InitiativeService(fixture.service);
  const view = await initiatives.start({
    commandId: newId(),
    initiativeId: "ladle",
    prompt: "Create ladle",
    plan: planOf(workflow),
    policy,
    model: "fixture/model",
    ownerLabel: "test",
    keepFeatures: true,
    featureAutoApproval: null,
    budget: { maxTotalTokens: 200_000_000, maxAgentCalls: calls.limit, maxActiveMs: timeMs },
  });
  const request = view.pendingDecisions.find((d) => d.scope === "initiative");
  if (!request) throw new Error("no split approval");
  await initiatives.approve(
    "ladle",
    { commandId: newId(), expectedRevision: view.revision },
    { requestId: request.requestId, digest: request.digest },
  );
  const starter = initiatives as unknown as {
    startFeature(id: string, featureId: string): Promise<boolean>;
    noteTimeForecast(view: InitiativeView, featureId: string | null): void;
    noteCallsForecast(view: InitiativeView, featureId: string | null): void;
  };
  const runOf = (featureId: string): string => {
    const runId = initiatives.view("ladle").features.find((f) => f.id === featureId)?.runId;
    if (!runId) throw new Error(`${featureId} has no run`);
    return runId;
  };
  for (const id of FIRST_WAVE) {
    expect(await starter.startFeature("ladle", id)).toBe(true);
    finish(store, runOf(id), OWN_PACE * 20, 20, calls.perRun);
  }
  return { fixture, store, initiatives, starter, runOf };
}

/** Drives a run until its plan is sized and its approval waits. */
async function sized(
  fixture: ReturnType<typeof workflowFixture>,
  runId: string,
): Promise<SizingReport> {
  const store = fixture.service.store;
  for (let i = 0; i < 6; i++) {
    const report = store.latestArtifact(runId, "sizing/plan-0.json");
    if (report) return JSON.parse(store.readArtifact(runId, report.id)) as SizingReport;
    const run = await fixture.service.get(runId);
    if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
  }
  const run = await fixture.service.get(runId);
  throw new Error(`run ${runId} was never sized: ${run.status} ${run.reason} ${run.stageId} ${JSON.stringify(store.requests(runId).map((r) => [r.kind, r.status]))} ${store.artifacts(runId).filter((a) => a.kind === "diagnostic").map((a) => store.readArtifact(runId, a.id)).join(" | ")}`);
}

describe("scenario: R74 ladlemath, a feature run's active time follows the initiative's pace (#2336)", () => {
  for (const workflow of ["sdd", "quick"] as const) {
    test(`the second wave is sized at the initiative's own pace (${workflow === "sdd" ? "v1" : "v2"} sizing)`, async () => {
      const { fixture, store, starter, runOf } = await ladle(workflow, 600 * MINUTE);
      expect(await starter.startFeature("ladle", "head")).toBe(true);
      const head = runOf("head");
      const report = await sized(fixture, head);
      expect(report.activeTime).toMatchObject({
        basis: "initiative",
        tokensPerMinute: OWN_PACE,
        runs: 3,
        ownRates: [OWN_PACE, OWN_PACE, OWN_PACE],
        history: { basis: "history", tokensPerMinute: HISTORY_PACE, runs: 8 },
      });
      const needed = Math.min(report.runTokens + report.repairReserve, report.budgetAfter);
      expect(report.activeTime.estimatedMs).toBe(Math.round((needed / OWN_PACE) * MINUTE));
      expect(report.activeTime.after).toBe(
        activeTimeLimit({
          neededTokens: needed,
          tokensPerMinute: OWN_PACE,
          maxActiveMs: report.activeTime.before,
          maxRunTokens: report.maxRunTokens,
        }).after,
      );
      // The limit the run holds is the one its own pace asks for.
      const policy = JSON.parse(store.run(head).policy_json) as RunPolicy;
      expect(policy.maxActiveMs).toBe(Math.max(report.activeTime.after, report.activeTime.before));
      expect(report.reasons.join(" ")).not.toContain("tokens per minute (the median of 8 earlier runs)");
    }, 60000);
  }

  test("a faster initiative keeps the history's pace as its floor", async () => {
    const { fixture, store, starter, runOf } = await ladle("sdd", 600 * MINUTE);
    for (const id of FIRST_WAVE) finish(store, runOf(id), HISTORY_PACE * 2 * 20, 20);
    expect(await starter.startFeature("ladle", "head")).toBe(true);
    const report = await sized(fixture, runOf("head"));
    expect(report.activeTime).toMatchObject({ basis: "history", ownRates: [240_000, 240_000, 240_000] });
  }, 60000);
});

describe("scenario: the shared time has a forecast, a notice and an amount (#2336)", () => {
  test("a pool whose summed time passes its limit records the time notice", async () => {
    // 60 min used by the first wave; head's tokens still to run at 60k a minute pass 61 min.
    const { initiatives, starter } = await ladle("sdd", 61 * MINUTE);
    const view = initiatives.view("ladle");
    const time = view.budget.time;
    expect(time?.pace).toEqual({ tokensPerMinute: OWN_PACE, basis: "initiative", runs: 3 });
    expect(time?.usedMs).toBe(60 * MINUTE);
    expect(time?.forecastMs).toBeGreaterThan(61 * MINUTE);
    expect(time?.suggestedMs).toBeGreaterThan(time?.forecastMs ?? 0);
    expect(view.budget.timeNotice).toContain(`--time-ms ${time?.suggestedMs}`);
    starter.noteTimeForecast(view, null);
    starter.noteTimeForecast(initiatives.view("ladle"), null);
    const events = initiatives.store.eventsOfType("ladle", "budget.time_notice");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ limitMs: 61 * MINUTE, suggestedMs: time?.suggestedMs });
  }, 60000);

  test("a time forecast past the limit while the token pool has room records one shadow time-pool would-extend (#2346)", async () => {
    const { store, initiatives, starter } = await ladle("sdd", 61 * MINUTE);
    const view = initiatives.view("ladle");
    starter.noteTimeForecast(view, null);
    starter.noteTimeForecast(initiatives.view("ladle"), null);
    // Once per time and token limit: the first wave's last start already passed 61 min.
    const extends_ = initiatives.store.eventsOfType("ladle", "decision.would_extend") as Record<string, unknown>[];
    expect(extends_).toHaveLength(1);
    const inputs = extends_[0]?.inputs as { forecastMs: number; suggestedMs: number; usedMs: number };
    expect(inputs).toMatchObject({ limitMs: 61 * MINUTE, tokensPerMinute: OWN_PACE, limitTokens: 200_000_000, cost: { capUsd: null } });
    expect(inputs.forecastMs).toBeGreaterThan(61 * MINUTE);
    // The 200M pool runs far longer at 60k a minute: the suggestion is not held back.
    expect(extends_[0]).toMatchObject({ reason: "time-pool", mode: "shadow", key: `time-pool-${61 * MINUTE}-200000000`, toMs: inputs.suggestedMs, byMs: inputs.suggestedMs - 61 * MINUTE });
    expect(String(extends_[0]?.summary)).toContain(`the shared time would grow from 61 to ${Math.round(inputs.suggestedMs / MINUTE)} min`);
    expect(Object.keys(HOST_POOL_GROWTHS)).toContain(String(extends_[0]?.reason));
    // Shadow changes no limit.
    expect(initiatives.view("ladle").budget.limits.maxActiveMs).toBe(61 * MINUTE);
    // The corpus hook decides the recorded share gates again: the same extensions, none new.
    const [replayed] = replayTimePoolGrowth(store);
    expect(replayed?.timeGrowth.some((b) => b.recorded === "extend" && b.replayed === "extend")).toBe(true);
    expect(replayed?.newTimeGrowth).toBe(0);
  }, 60000);

  test("with timePoolGrowth off a time forecast past the limit records no would-extend (#2346)", async () => {
    const { initiatives, starter } = await ladle("sdd", 61 * MINUTE, undefined, { timePoolGrowth: "off" });
    starter.noteTimeForecast(initiatives.view("ladle"), null);
    expect(initiatives.store.eventsOfType("ladle", "budget.time_notice")).toHaveLength(1);
    expect(initiatives.store.eventsOfType("ladle", "decision.would_extend")).toEqual([]);
  }, 60000);

  test("the pool's block on spent time carries suggestedTimeMs on its extend remedy", async () => {
    // The first wave used the whole 60 min: head would start with no time (the start gate's block).
    const { initiatives } = await ladle("sdd", 60 * MINUTE);
    const view = initiatives.view("ladle");
    const head = view.features.find((f) => f.id === "head");
    expect(head?.share?.activeMs).toBe(0);
    const block = head ? shareShortfall(view, head) : null;
    const extend = block?.remedies.find((r) => r.action === "extend");
    expect(extend?.suggestedTimeMs).toBeGreaterThan(60 * MINUTE);
    expect(extend?.suggestedTimeMs).toBe(view.budget.time?.suggestedMs ?? -1);
    expect(block?.message).toContain(`--time-ms ${extend?.suggestedTimeMs}`);
  }, 60000);

  test("a feature run blocked on its active deadline names extend with an amount before resume", async () => {
    const { fixture, store, initiatives, starter, runOf } = await ladle("sdd", 600 * MINUTE);
    expect(await starter.startFeature("ladle", "head")).toBe(true);
    const head = runOf("head");
    await sized(fixture, head);
    await fixture.approve(head);
    const limit = (JSON.parse(store.run(head).policy_json) as RunPolicy).maxActiveMs;
    store.transaction(() => {
      store.addActiveTime(head, limit - store.run(head).active_ms);
      store.transition(head, "blocked", "budget_exhausted");
    });
    const feature = initiatives.view("ladle").features.find((f) => f.id === "head");
    const remedies = feature?.recovery?.remedies ?? [];
    expect(remedies.map((r) => r.action)).toEqual(["extend", "resume"]);
    // head holds the whole room of the 600 min shared time and its raise passes it: the extend it
    // names first is the shared time's (#2414); with room it is the run's (the R76 cases below).
    expect(remedies[0]).toMatchObject({ initiativeId: "ladle" });
    expect(remedies[0]?.suggestedTimeMs).toBeGreaterThan(600 * MINUTE);
    expect(feature?.blockers[0]).toContain(`initiative extend ladle --time-ms ${remedies[0]?.suggestedTimeMs}`);
    expect(feature?.blockers[0]).toContain(`ran out at ${limit / MINUTE} of ${limit / MINUTE} min`);
    expect(store.run(head).status).toBe("blocked");
  }, 60000);
});

/** Records an attempt of `runId` that waited `silentMs` before its calls answered (#2414). */
function silent(store: WorkflowStore, runId: string, silentMs: number): void {
  store.transaction(() =>
    store.artifact(runId, "usage", `attempts/${newId()}/usage.json`, JSON.stringify({ schemaVersion: 1, silentMs, steps: [] })),
  );
}

describe("scenario: R76 hintsieve, the clean pace is recorded in shadow beside the deciding one (#2414)", () => {
  test("the time notice records the clean pace and its inputs; its own pace still decides", async () => {
    const { initiatives, store, runOf } = await ladle("sdd", 61 * MINUTE);
    // kitchen and recipe each waited 12 minutes on a silent call that finally answered.
    silent(store, runOf("kitchen"), 12 * MINUTE);
    silent(store, runOf("recipe"), 12 * MINUTE);
    const view = initiatives.view("ladle");
    const time = view.budget.time;
    expect(time?.pace).toEqual({ tokensPerMinute: OWN_PACE, basis: "initiative", runs: 3 });
    // No history of other initiatives is measured here, so the shadow takes the clean median.
    const clean = (OWN_PACE * 20) / 8;
    expect(time?.cleanPace?.pace).toEqual({ tokensPerMinute: clean, basis: "initiative", runs: 3 });
    expect(time?.cleanPace?.rates.toSorted()).toEqual([OWN_PACE, clean, clean].toSorted());
    expect(time?.cleanPace?.silentMs).toBe(24 * MINUTE);
    expect(time?.cleanPace?.forecastMs).toBeLessThan(time?.forecastMs ?? 0);
    expect(view.budget.timeNotice).toContain(`At ${OWN_PACE / 1000}k tokens per active minute`);
    // The notice the first wave raised recorded the clean pace beside the one that decided it.
    const [event] = initiatives.store.eventsOfType("ladle", "budget.time_notice");
    expect(event).toMatchObject({
      pace: { tokensPerMinute: OWN_PACE, basis: "initiative", runs: 2 },
      cleanPace: { pace: { tokensPerMinute: OWN_PACE, basis: "initiative", runs: 2 }, rates: [OWN_PACE, OWN_PACE], silentMs: 0 },
    });
  }, 60000);

  test("from four finished runs the clean pace is their median without the silence; run sizing still decides as before", async () => {
    const { fixture, initiatives, store, starter, runOf } = await ladle("sdd", 600 * MINUTE);
    silent(store, runOf("kitchen"), 10 * MINUTE);
    silent(store, runOf("recipe"), 10 * MINUTE);
    expect(await starter.startFeature("ladle", "head")).toBe(true);
    const head = runOf("head");
    const report = await sized(fixture, head);
    expect(report.activeTime).toMatchObject({ basis: "initiative", tokensPerMinute: OWN_PACE, runs: 3 });
    const recorded = JSON.parse(store.readArtifact(head, store.latestArtifact(head, "sizing/plan-0.json")!.id)) as {
      cleanPace?: { basis: string; tokensPerMinute: number; rates: number[]; silentMs: number; after: number };
    };
    // Three clean runs: the shadow keeps the history's pace.
    expect(recorded.cleanPace).toMatchObject({ basis: "history", tokensPerMinute: HISTORY_PACE, silentMs: 20 * MINUTE });
    expect(recorded.cleanPace?.rates.toSorted()).toEqual([OWN_PACE, OWN_PACE * 2, OWN_PACE * 2].toSorted());
    finish(store, head, OWN_PACE * 20, 20);
    const time = initiatives.view("ladle").budget.time;
    expect(time?.pace).toEqual({ tokensPerMinute: OWN_PACE, basis: "initiative", runs: 4 });
    expect(time?.cleanPace?.pace).toEqual({ tokensPerMinute: (OWN_PACE + OWN_PACE * 2) / 2, basis: "initiative", runs: 4 });
  }, 60000);
});

describe("scenario: R76 schemamask io, a run block's time is held to what the shared time grants (#2414)", () => {
  /** head blocked on its spent deadline, with the shared time `roomMs` above what is committed. */
  async function blockedHead(roomMs: number) {
    const made = await ladle("sdd", 600 * MINUTE);
    const { fixture, store, initiatives, starter, runOf } = made;
    expect(await starter.startFeature("ladle", "head")).toBe(true);
    const head = runOf("head");
    await sized(fixture, head);
    await fixture.approve(head);
    const limit = (JSON.parse(store.run(head).policy_json) as RunPolicy).maxActiveMs;
    store.transaction(() => {
      store.addActiveTime(head, limit - store.run(head).active_ms);
      store.transition(head, "blocked", "budget_exhausted");
    });
    const committed = initiatives.view("ladle").budget.time?.committedMs ?? 0;
    const row = initiatives.store.get("ladle");
    const settings = initiatives.store.settings(row);
    if (!settings.budget) throw new Error("no shared budget");
    initiatives.store.setSettings("ladle", { ...settings, budget: { ...settings.budget, maxActiveMs: committed + roomMs } });
    const feature = initiatives.view("ladle").features.find((f) => f.id === "head");
    return { head, limit, poolLimit: committed + roomMs, feature, remedies: feature?.recovery?.remedies ?? [] };
  }

  test("a raise above the room suggests what the shared time grants and names the shared time's extend", async () => {
    const { head, limit, poolLimit, feature, remedies } = await blockedHead(5 * MINUTE);
    expect(remedies.map((r) => r.action)).toEqual(["extend", "extend", "resume"]);
    const [run, pool] = remedies;
    expect(run).toMatchObject({ runId: head });
    // On main the run's suggestion was its own pace's whole raise, above the shared limit.
    expect(run?.suggestedTimeMs).toBeLessThanOrEqual(poolLimit);
    expect(run?.suggestedTimeMs).toBeLessThanOrEqual(limit + 5 * MINUTE);
    expect(run?.suggestedTimeMs).toBeGreaterThan(limit);
    expect(pool).toMatchObject({ initiativeId: "ladle" });
    expect(pool?.suggestedTimeMs).toBeGreaterThan(poolLimit);
    expect(feature?.blockers[0]).toContain(`baked workflow initiative extend ladle --time-ms ${pool?.suggestedTimeMs}`);
    expect(feature?.blockers[0]).toContain(`--time-ms ${run?.suggestedTimeMs} --resume`);
    for (const remedy of remedies) RemedySchema.parse(remedy);
  }, 60000);

  test("with no room the block names the shared time's extend first and no run amount", async () => {
    const { poolLimit, feature, remedies } = await blockedHead(0);
    expect(remedies.map((r) => r.action)).toEqual(["extend", "resume"]);
    expect(remedies[0]).toMatchObject({ initiativeId: "ladle" });
    expect(remedies[0]?.runId).toBeUndefined();
    expect(remedies[0]?.suggestedTimeMs).toBeGreaterThan(poolLimit);
    expect(feature?.blockers[0]).toContain("no room left");
  }, 60000);

  test("a raise within the room is unchanged", async () => {
    const { head, limit, remedies } = await blockedHead(600 * MINUTE);
    expect(remedies.map((r) => r.action)).toEqual(["extend", "resume"]);
    expect(remedies[0]).toMatchObject({ runId: head });
    expect(remedies[0]?.suggestedTimeMs).toBeGreaterThan(limit);
  }, 60000);
});

// R76 schemamask (#2413): check, generation and validate started on 1.9 to 4.2 min of shared time
// against lows of 9 to 30 min at the pace then. Each stopped on its active deadline within 4 min
// and waited 16 to 26 min for a person. The share gate's floor is one second.
describe("scenario: R76 schemamask, a feature starts on less time than its low estimate (#2413)", () => {
  const timeWouldStops = (initiatives: InitiativeService) =>
    initiatives.store
      .eventsOfType("ladle", "decision.would_stop")
      .filter((p) => (p as { reason?: string }).reason === "initiative-time-share") as {
      mode: string;
      featureId: string;
      remedy: Remedy & { suggestedTimeMs: number };
      inputs: { availableMs: number; needMs: { low: number } };
    }[];
  /** Head's estimate as schemamask's validate had it: 10 to 20 min at the initiative's 60k a minute. */
  const HEAD_NEED = { low: 10 * OWN_PACE, high: 20 * OWN_PACE };
  const estimated = (initiatives: InitiativeService): void => {
    // The fixture's history is unsized, so its estimate is on defaults and names no need.
    (initiatives as unknown as { featureNeeds(): Map<string, typeof HEAD_NEED> }).featureNeeds = () =>
      new Map([["head", HEAD_NEED]]);
  };

  test("a start on a time share below its low records an initiative-time-share would-stop with the time that starts it", async () => {
    // The first wave used 60 of 61 min: head's share is 1 min, its low at 60k a minute is longer.
    const { initiatives, starter } = await ladle("sdd", 61 * MINUTE);
    estimated(initiatives);
    const view = initiatives.view("ladle");
    const head = view.features.find((f) => f.id === "head");
    if (!head) throw new Error("no head");
    expect(head.need).toEqual(HEAD_NEED);
    expect(head.share?.activeMs).toBeGreaterThan(1000);
    expect(shareShortfall(view, head)).toBeNull();
    const short = timeShortfall(view, head);
    expect(short?.availableMs).toBe(1 * MINUTE);
    expect(short?.needMs).toEqual({ low: 10 * MINUTE, high: 20 * MINUTE });

    // Shadow: the start goes ahead and the would-stop is recorded once, with the remedy's amount.
    expect(await starter.startFeature("ladle", "head")).toBe(true);
    const events = timeWouldStops(initiatives);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mode: "shadow", featureId: "head", remedy: { action: "extend" } });
    expect(RemedySchema.safeParse(events[0]?.remedy).success).toBe(true);
    const suggested = events[0]?.remedy.suggestedTimeMs ?? 0;
    expect(suggested % (15 * MINUTE)).toBe(0);
    expect(suggested - 61 * MINUTE).toBeGreaterThanOrEqual((short?.needMs.low ?? 0) - (short?.availableMs ?? 0));
    expect(suggested).toBeGreaterThanOrEqual(view.budget.time?.suggestedMs ?? 0);
  }, 60000);

  test("a start whose time share covers its low records none", async () => {
    const { initiatives, starter } = await ladle("sdd", 600 * MINUTE);
    estimated(initiatives);
    const head = initiatives.view("ladle").features.find((f) => f.id === "head");
    expect(head ? timeShortfall(initiatives.view("ladle"), head) : "no head").toBeNull();
    expect(await starter.startFeature("ladle", "head")).toBe(true);
    expect(timeWouldStops(initiatives)).toHaveLength(0);
  }, 60000);
});

describe("scenario: the shared calls have a forecast, a notice and an amount (#2345)", () => {
  test("a pool whose calls forecast passes its limit records the calls notice once per limit", async () => {
    // 360 calls used by the first wave at 100 calls per million tokens; head's tokens pass 361.
    const { initiatives, starter } = await ladle("sdd", 600 * MINUTE, { limit: 3 * OWN_CALLS + 1, perRun: OWN_CALLS });
    const view = initiatives.view("ladle");
    const calls = view.budget.calls;
    expect(calls?.pace).toEqual({ callsPerMillion: 100, basis: "initiative", runs: 3 });
    expect(calls?.usedCalls).toBe(3 * OWN_CALLS);
    expect(calls?.forecastCalls).toBeGreaterThan(3 * OWN_CALLS + 1);
    expect(calls?.suggestedCalls).toBeGreaterThan(calls?.forecastCalls ?? 0);
    expect((calls?.suggestedCalls ?? 0) % 50).toBe(0);
    expect(view.budget.callsNotice).toContain(`--calls ${calls?.suggestedCalls}`);
    starter.noteCallsForecast(view, null);
    starter.noteCallsForecast(initiatives.view("ladle"), null);
    const events = initiatives.store.eventsOfType("ladle", "budget.calls_notice");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ limitCalls: 3 * OWN_CALLS + 1, suggestedCalls: calls?.suggestedCalls });
  }, 60000);

  test("the pool's block on spent calls carries suggestedCalls on its extend remedy", async () => {
    // The first wave made every call of the limit: head would start with none (the start gate's block).
    const { initiatives } = await ladle("sdd", 600 * MINUTE, { limit: 3 * OWN_CALLS, perRun: OWN_CALLS });
    const view = initiatives.view("ladle");
    const head = view.features.find((f) => f.id === "head");
    expect(head?.share?.calls).toBe(0);
    const block = head ? shareShortfall(view, head) : null;
    const extend = block?.remedies.find((r) => r.action === "extend");
    expect(extend?.suggestedCalls).toBeGreaterThan(3 * OWN_CALLS);
    expect(extend?.suggestedCalls).toBe(Math.max(view.budget.calls?.suggestedCalls ?? 0, view.budget.calls?.coverCalls ?? 0));
    expect(block?.message).toContain(`--calls ${extend?.suggestedCalls}`);
    expect(RemedySchema.parse(extend)).toEqual(extend as Remedy);
  }, 60000);

  test("without finished runs that made calls, the calls have no pace and no notice", async () => {
    const { initiatives } = await ladle("sdd", 600 * MINUTE);
    const calls = initiatives.view("ladle").budget.calls;
    expect(calls?.pace).toBeNull();
    expect(calls?.notice).toBeNull();
  }, 60000);
});

/**
 * Every budget dimension of the shared pool has a measured rate, a forecast notice and a suggested
 * amount on its `extend` remedy (AGENTS.md). A dimension still without them names the open issue
 * that adds them; a new limit of the pool fails here until it joins the table.
 */
describe("every shared budget dimension forecasts and suggests (#2336, #2042)", () => {
  type Place = readonly [keyof InitiativeView["budget"], string];
  const DIMENSIONS: Record<
    string,
    { limit: string } & ({ rate: Place; notice: Place; remedy: keyof Remedy } | { pending: string })
  > = {
    tokens: { limit: "maxTotalTokens", rate: ["pool", "ratio"], notice: ["pool", "notice"], remedy: "suggestedTokens" },
    time: { limit: "maxActiveMs", rate: ["time", "pace"], notice: ["time", "notice"], remedy: "suggestedTimeMs" },
    dollars: { limit: "capUsd", rate: ["pool", "usdPerMillion"], notice: ["cost", "forecastNotice"], remedy: "suggestedUsd" },
    calls: { limit: "maxAgentCalls", rate: ["calls", "pace"], notice: ["calls", "notice"], remedy: "suggestedCalls" },
  };

  test("each dimension has its rate, notice and remedy amount, or names the issue that adds them", async () => {
    const { initiatives } = await ladle("sdd", 61 * MINUTE);
    const budget = initiatives.view("ladle").budget as unknown as Record<string, Record<string, unknown> | null>;
    const limits = [...Object.keys(budget.limits ?? {}), "capUsd"];
    expect(limits.sort()).toEqual(Object.values(DIMENSIONS).map((d) => d.limit).sort());
    for (const [name, dimension] of Object.entries(DIMENSIONS)) {
      if ("pending" in dimension) {
        expect(dimension.pending, name).toMatch(/^#\d+$/);
        continue;
      }
      for (const [field, key] of [dimension.rate, dimension.notice]) {
        const holder = budget[field];
        expect(holder !== null && typeof holder === "object" && key in holder, `${name}: budget.${field}.${key}`).toBe(true);
      }
      expect(Object.keys(RemedySchema.shape), name).toContain(dimension.remedy);
    }
  }, 60000);
});
