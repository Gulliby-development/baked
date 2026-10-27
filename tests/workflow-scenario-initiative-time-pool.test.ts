import { afterEach, describe, expect, test } from "bun:test";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService, type InitiativeView, shareShortfall } from "../src/core/workflows/initiatives/service.js";
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

/** Marks a run finished with `tokens` used over `minutes` of active time. */
function finish(store: WorkflowStore, runId: string, tokens: number, minutes: number): void {
  store.connection.run("UPDATE runs SET status='completed', token_usage=?, active_ms=? WHERE id=?", [
    tokens,
    minutes * MINUTE,
    runId,
  ]);
}

/**
 * An initiative whose first wave of three features finished at `OWN_PACE`, beside five earlier
 * runs of the project at `HISTORY_PACE`, with `timeMs` of shared active time.
 */
async function ladle(workflow: "sdd" | "quick", timeMs: number) {
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
    budget: { maxTotalTokens: 200_000_000, maxAgentCalls: 10_000, maxActiveMs: timeMs },
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
  };
  const runOf = (featureId: string): string => {
    const runId = initiatives.view("ladle").features.find((f) => f.id === featureId)?.runId;
    if (!runId) throw new Error(`${featureId} has no run`);
    return runId;
  };
  for (const id of FIRST_WAVE) {
    expect(await starter.startFeature("ladle", id)).toBe(true);
    finish(store, runOf(id), OWN_PACE * 20, 20);
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
    expect(remedies[0]).toMatchObject({ runId: head });
    expect(remedies[0]?.suggestedTimeMs).toBeGreaterThan(limit);
    expect(feature?.blockers[0]).toContain(`--time-ms ${remedies[0]?.suggestedTimeMs} --resume`);
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
    calls: { limit: "maxAgentCalls", pending: "#2345" },
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
