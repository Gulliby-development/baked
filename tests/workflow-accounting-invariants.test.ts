import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonical } from "../src/core/specs/hash.js";
import { type CostForecast, costForecast, kindRatio } from "../src/core/workflows/cost-forecast.js";
import { POOL_STEP, planCharge, planChargeTokens, poolExtensionDecision, poolForecast, tokenPool } from "../src/core/workflows/initiatives/token-pool.js";
import { chargeHold, poolBoundDecision, refreshedGrowth, stageReserveDecision } from "../src/core/workflows/initiatives/growth.js";
import { CALLS_STEP, callsPool, callsRaise } from "../src/core/workflows/initiatives/calls-pool.js";
import { dollarCapPark, expectedSplitUsd, growthLimit, type ShareGateView } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { type TaskKind, verificationTokens } from "../src/core/workflows/sizing.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import type { Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Property-based invariants of the run's cost forecast (#1721). Accounting bugs were found one
// scenario at a time: an open task's spent tokens counted twice (#1648) and repricing per open
// attempt (#1647). These properties check the forecast over generated runs instead.
//
// A new accounting quantity adds its invariant here in the same pull request (AGENTS.md).

const MODEL = "anthropic/claude-sonnet-4-6";
/** Below this many finished tasks of a kind, its own ratio does not price its open tasks. */
const MIN_SAMPLE = 3;
/** Enough runs to find the edges, few enough that the file stays a few seconds long. */
const RUNS = 20;
const KINDS: TaskKind[] = ["code", "test", "docs"];

/** One planned task of a generated run. */
interface TaskSeed {
  kind: TaskKind;
  low: number;
  high: number;
  state: "finished" | "open" | "cancelled";
  /** Tokens the finished task used. */
  used: number;
  /** An open task's attempt in flight: tokens recorded so far and tokens it reserved. */
  inFlight: { used: number; reserved: number } | null;
}

const taskSeed = (state?: TaskSeed["state"]): fc.Arbitrary<TaskSeed> =>
  fc
    .record({
      kind: fc.constantFrom(...KINDS),
      low: fc.integer({ min: 10_000, max: 400_000 }),
      span: fc.integer({ min: 0, max: 400_000 }),
      state: state ? fc.constant(state) : fc.constantFrom<TaskSeed["state"]>("finished", "open", "open", "cancelled"),
      used: fc.integer({ min: 0, max: 2_000_000 }),
      inFlight: fc.option(
        fc.record({ used: fc.integer({ min: 0, max: 600_000 }), reserved: fc.integer({ min: 1, max: 600_000 }) }),
        { nil: null },
      ),
    })
    .map(({ span, ...seed }) => ({
      ...seed,
      high: seed.low + span,
      inFlight: seed.state === "open" ? seed.inFlight : null,
    }));

/** A run with a priced plan: at least the minimum sample finished and one task still open. */
const runSeed = fc
  .tuple(
    fc.array(taskSeed("finished"), { minLength: MIN_SAMPLE, maxLength: 4 }),
    fc.array(taskSeed("open"), { minLength: 1, maxLength: 3 }),
    fc.array(taskSeed(), { maxLength: 3 }),
    fc.integer({ min: 0, max: 3_000_000 }),
  )
  .map(([finished, open, rest, planning]) => ({ tasks: [...finished, ...open, ...rest], planning }));
type RunSeed = { tasks: TaskSeed[]; planning: number };

/** Every token is input: one price per token, so a change of the forecast is never a change of rate. */
function usage(tokens: number): AttemptUsageRecord {
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 20_000_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: tokens,
    steps: [{ inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }],
  };
}

const taskId = (i: number) => `T${String(i + 1).padStart(3, "0")}`;
const task = (id: string): Task => ({ id, title: id, description: id, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: `src/${id}.ts`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: id });

let fixture: ReturnType<typeof workflowFixture>;
beforeAll(() => {
  fixture = workflowFixture({ policy: { ...fixturePolicy, maxCostUsd: null } });
  fixture.config.defaultModel = MODEL;
});
afterAll(async () => {
  await fixture.dispose();
});

/** Seeding runs uncapped; the forecast is then read under this cap and the `auto` tolerance. */
const capped = (policy: RunPolicy): RunPolicy => ({ ...policy, maxCostUsd: 10_000, costTolerance: "auto" });

/** A fresh run of the shared fixture in the generated state. */
async function seedRun(seed: RunSeed) {
  const store = fixture.service.store;
  const base: RunPolicy = { ...fixturePolicy, maxAgentCalls: 10_000, maxTotalTokens: 1_000_000_000, maxCostUsd: null };
  const { runId } = await fixture.start();
  store.transaction(() => store.transition(runId, "running"));
  store.setPolicy(runId, base);
  const tasks = seed.tasks.map((_, i) => task(taskId(i)));
  store.transaction(() =>
    store.syncTasks(runId, { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "b".repeat(64), tasks }),
  );
  store.artifact(
    runId,
    "sizing",
    "sizing/plan-0.json",
    canonical({
      schemaVersion: 3,
      model: MODEL,
      tasks: seed.tasks.map((t, i) => ({ taskId: taskId(i), kind: t.kind, files: 1, estimate: { low: t.low, high: t.high }, attemptTokens: 600_000, attemptSteps: null, oversized: false })),
    }),
  );
  const spend = (stage: string, tokens: number) => {
    const stepId = store.beginStep(runId, stage);
    const attempt = store.reserve(runId, stepId, MODEL, 1000, base);
    store.transaction(() => {
      store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(tokens)));
      store.finishAttempt(runId, attempt, "completed", tokens);
    });
  };
  /** Attempts in flight by task, so a test can finish one. */
  const inFlight = new Map<string, string>();
  if (seed.planning > 0) spend("plan", seed.planning);
  seed.tasks.forEach((t, i) => {
    const id = taskId(i);
    if (t.state === "finished") {
      spend(`task-${id}`, t.used);
      store.transaction(() => store.taskStatus(runId, id, "implemented"));
    } else if (t.state === "cancelled") {
      store.transaction(() => store.taskStatus(runId, id, "cancelled"));
    } else if (t.inFlight) {
      const stepId = store.beginStep(runId, `task-${id}`);
      const attempt = store.reserve(runId, stepId, MODEL, t.inFlight.reserved, base);
      store.recordAttemptUsage(runId, attempt, t.inFlight.used);
      store.transaction(() => store.taskStatus(runId, id, "running"));
      inFlight.set(id, attempt);
    }
  });
  const policy = capped(base);
  store.setPolicy(runId, policy);
  return { store, runId, policy, inFlight };
}

/** What the forecast still expects to spend in dollars, beyond what is spent and reserved. */
function remainingUsd(store: WorkflowStore, runId: string, forecast: CostForecast): number {
  const { spentUsd, reservedUsd } = store.costUsage(runId);
  return forecast.projectedUsd - spentUsd - reservedUsd;
}

/** Equal up to floating-point summation order. */
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

describe("cost forecast invariants (#1721)", () => {
  test("the forecast is never below what the run spent and reserved", async () => {
    await fc.assert(
      fc.asyncProperty(runSeed, async (seed) => {
        const { store, runId, policy } = await seedRun(seed);
        const forecast = costForecast(store, runId, policy);
        expect(forecast).not.toBeNull();
        if (!forecast) return;
        const { spentUsd, reservedUsd } = store.costUsage(runId);
        expect(Number.isFinite(forecast.projectedUsd)).toBe(true);
        expect(forecast.spentUsd).toBe(spentUsd);
        expect(forecast.projectedUsd).toBeGreaterThanOrEqual(forecast.spentUsd);
        expect(forecast.projectedUsd + 1e-9).toBeGreaterThanOrEqual(spentUsd + reservedUsd);
        expect(forecast.remainingTokens).toBeGreaterThanOrEqual(0);
        expect(forecast.ceilingUsd).toBeGreaterThanOrEqual(forecast.capUsd);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);

  // Finishing a task moves what it used from the forecast into the spent dollars. Its kind's
  // ratio may rise with it and raise the price of the kind's other open tasks: that is a
  // measurement, so the property holds whenever the kind's ratio does not rise.
  test("finishing a task never raises the remaining forecast", async () => {
    const finishing = runSeed.chain((seed) =>
      fc.record({
        seed: fc.constant(seed),
        // An open task to finish, and what its attempt in flight used by the end.
        pick: fc.nat({ max: seed.tasks.length - 1 }),
        extra: fc.integer({ min: 0, max: 600_000 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(finishing, async ({ seed, pick, extra }) => {
        const open = seed.tasks.flatMap((t, i) => (t.state === "open" ? [i] : []));
        const index = open[pick % open.length] ?? 0;
        // Another task stays open, so the forecast exists after the finish.
        fc.pre(open.length >= 2);
        const target = seed.tasks[index] as TaskSeed;
        const mid = (t: TaskSeed) => (t.low + t.high) / 2;
        const finishedOfKind = seed.tasks.filter((t) => t.state === "finished" && t.kind === target.kind);
        const ratioOf = (tasks: { used: number; mid: number }[]) =>
          kindRatio(tasks.reduce((s, t) => s + t.used, 0) / tasks.reduce((s, t) => s + t.mid, 0), tasks.length);
        const before = finishedOfKind.length ? ratioOf(finishedOfKind.map((t) => ({ used: t.used, mid: mid(t) }))) : 1;
        const final = (target.inFlight?.used ?? 0) + extra;
        const after = ratioOf([...finishedOfKind.map((t) => ({ used: t.used, mid: mid(t) })), { used: final, mid: mid(target) }]);
        fc.pre(after <= before);
        const { store, runId, policy, inFlight } = await seedRun(seed);
        const first = costForecast(store, runId, policy);
        expect(first).not.toBeNull();
        if (!first) return;
        const firstRemaining = remainingUsd(store, runId, first);
        const id = taskId(index);
        const running = inFlight.get(id);
        store.transaction(() => {
          if (running) {
            store.artifact(runId, "usage", `attempts/${running}/usage.json`, canonical(usage(final)));
            store.finishAttempt(runId, running, "completed", final);
          }
          store.taskStatus(runId, id, "implemented");
        });
        if (!running) {
          const stepId = store.beginStep(runId, `task-${id}`);
          const attempt = store.reserve(runId, stepId, MODEL, 1000, policy);
          store.transaction(() => {
            store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(usage(final)));
            store.finishAttempt(runId, attempt, "completed", final);
          });
        }
        const next = costForecast(store, runId, policy);
        expect(next).not.toBeNull();
        if (!next) return;
        expect(next.openTasks).toBe(first.openTasks - 1);
        expect(next.remainingTokens).toBeLessThanOrEqual(first.remainingTokens);
        expect(remainingUsd(store, runId, next)).toBeLessThanOrEqual(firstRemaining + 1e-9);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);

  // #1648: the tokens an open task's attempt used or holds are already in the spent and reserved
  // dollars, so the forecast takes them off the task's price, never below zero.
  test("an open task's attempt in flight is counted once", async () => {
    const counted = runSeed.chain((seed) =>
      fc.record({ seed: fc.constant(seed), pick: fc.nat({ max: 10 }), used: fc.integer({ min: 0, max: 600_000 }), reserved: fc.integer({ min: 1, max: 600_000 }) }),
    );
    await fc.assert(
      fc.asyncProperty(counted, async ({ seed, pick, used, reserved }) => {
        const open = seed.tasks.flatMap((t, i) => (t.state === "open" ? [i] : []));
        const index = open[pick % open.length] ?? 0;
        const without = { ...seed, tasks: seed.tasks.map((t, i) => (i === index ? { ...t, inFlight: null } : t)) };
        const within = { ...seed, tasks: seed.tasks.map((t, i) => (i === index ? { ...t, inFlight: { used, reserved } } : t)) };
        const a = await seedRun(without);
        const b = await seedRun(within);
        const fa = costForecast(a.store, a.runId, a.policy);
        const fb = costForecast(b.store, b.runId, b.policy);
        expect(fa).not.toBeNull();
        expect(fb).not.toBeNull();
        if (!fa || !fb) return;
        const target = seed.tasks[index] as TaskSeed;
        // The open task's share of the forecast before its attempt: price times its kind's ratio.
        const finished = seed.tasks.filter((t) => t.state === "finished" && t.kind === target.kind);
        const priced = finished.reduce((sum, t) => sum + (t.low + t.high) / 2, 0);
        const ratio = finished.length ? kindRatio(finished.reduce((sum, t) => sum + t.used, 0) / priced, finished.length) : 1;
        const share = ((target.low + target.high) / 2) * ratio;
        const held = Math.max(used, reserved);
        expect(Math.abs(fa.remainingTokens - fb.remainingTokens - Math.min(held, share))).toBeLessThanOrEqual(1);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);

  // #1647: the price samples are cached per run and read again only when they can change.
  test("repricing twice equals pricing once, and a cached price equals a fresh one", async () => {
    // A change between the two readings: none, a finished attempt whose cache reads move the
    // implementation rate, or a new reservation alone, which leaves the price samples as they are.
    const change = fc.oneof(
      fc.constant({ kind: "none" as const }),
      fc.record({ kind: fc.constant("spend" as const), tokens: fc.integer({ min: 1, max: 900_000 }), cachedPercent: fc.integer({ min: 10, max: 90 }) }),
      fc.record({ kind: fc.constant("reserve" as const), tokens: fc.integer({ min: 1, max: 600_000 }) }),
    );
    const agree = (store: WorkflowStore, runId: string, policy: RunPolicy) => {
      const once = costForecast(store, runId, policy);
      const twice = costForecast(store, runId, policy);
      expect(twice).toEqual(once);
      expect(store.costUsage(runId)).toEqual(store.costUsage(runId));
      // Another connection to the same database has no cached samples.
      const fresh = new WorkflowStore(store.workspace, true);
      try {
        const uncached = costForecast(fresh, runId, policy);
        expect(uncached?.remainingTokens).toBe(once?.remainingTokens);
        expect(close(uncached?.projectedUsd ?? Number.NaN, once?.projectedUsd ?? Number.NaN)).toBe(true);
        const cost = fresh.costUsage(runId);
        expect(close(cost.reservedUsd, store.costUsage(runId).reservedUsd)).toBe(true);
        expect(close(cost.spentUsd, store.costUsage(runId).spentUsd)).toBe(true);
      } finally {
        fresh.close();
      }
    };
    await fc.assert(
      fc.asyncProperty(runSeed, change, async (seed, next) => {
        const { store, runId, policy } = await seedRun(seed);
        agree(store, runId, policy);
        const open = seed.tasks.findIndex((t) => t.state === "open");
        if (next.kind !== "none") {
          const stepId = store.beginStep(runId, `task-${taskId(open)}`);
          const attempt = store.reserve(runId, stepId, MODEL, next.tokens, policy);
          if (next.kind === "spend") {
            const record = usage(next.tokens);
            const step = record.steps[0];
            if (step) step.cacheReadTokens = Math.round((next.tokens * next.cachedPercent) / 100);
            store.transaction(() => {
              store.artifact(runId, "usage", `attempts/${attempt}/usage.json`, canonical(record));
              store.finishAttempt(runId, attempt, "completed", next.tokens);
            });
          }
        }
        agree(store, runId, policy);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);

  // Splitting an open task into two of the same kind whose prices add up to its price leaves the
  // forecast where it was; only the plan's task count, and with it the `auto` tolerance, changes.
  test("splitting an open task keeps the forecast total within its tolerance", async () => {
    const splitting = runSeed.chain((seed) =>
      fc.record({ seed: fc.constant(seed), pick: fc.nat({ max: 10 }), share: fc.double({ min: 0, max: 1, noNaN: true }) }),
    );
    await fc.assert(
      fc.asyncProperty(splitting, async ({ seed, pick, share }) => {
        // Only a task without attempts splits evenly: what an attempt used belongs to one half.
        const idle = seed.tasks.flatMap((t, i) => (t.state === "open" && !t.inFlight ? [i] : []));
        fc.pre(idle.length > 0);
        const index = idle[pick % idle.length] ?? 0;
        const target = seed.tasks[index] as TaskSeed;
        const lowA = Math.floor(target.low * share);
        const highA = Math.floor(target.high * share);
        const halves: TaskSeed[] = [
          { ...target, low: lowA, high: highA },
          { ...target, low: target.low - lowA, high: target.high - highA },
        ];
        const split = { ...seed, tasks: [...seed.tasks.slice(0, index), ...halves, ...seed.tasks.slice(index + 1)] };
        const whole = await seedRun(seed);
        const parts = await seedRun(split);
        const a = costForecast(whole.store, whole.runId, whole.policy);
        const b = costForecast(parts.store, parts.runId, parts.policy);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        if (!a || !b) return;
        expect(b.openTasks).toBe(a.openTasks + 1);
        // `remainingTokens` is rounded to whole tokens once, after the sum.
        expect(Math.abs(b.remainingTokens - a.remainingTokens)).toBeLessThanOrEqual(1);
        const tolerance = Math.min(a.ceilingUsd / a.capUsd, b.ceilingUsd / b.capUsd) - 1;
        expect(Math.abs(b.projectedUsd - a.projectedUsd)).toBeLessThanOrEqual(a.projectedUsd * tolerance);
        expect(close(b.projectedUsd, a.projectedUsd)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);

  test("a kind's own ratio needs the minimum sample", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 20, noNaN: true }), fc.nat({ max: 20 }), (measured, count) => {
        const ratio = kindRatio(measured, count);
        if (count < MIN_SAMPLE) expect(ratio).toBe(1);
        else if (count >= 2 * MIN_SAMPLE - 1) expect(close(ratio, measured)).toBe(true);
        // In between it moves from the plan's price toward the measured ratio, never past it.
        else expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(Math.abs(measured - 1) + 1e-12);
      }),
      { numRuns: 200 },
    );
  });

  // #1648: one finished test task at 3x priced every open test task at 3x.
  test("what finished tasks of an under-sampled kind used does not price its open tasks", async () => {
    const underSampled = fc
      .tuple(
        // The measured kinds give the forecast its minimum sample; `docs` stays under it.
        fc.array(taskSeed("finished").map((t) => ({ ...t, kind: t.kind === "docs" ? ("code" as const) : t.kind })), { minLength: MIN_SAMPLE, maxLength: 4 }),
        fc.array(taskSeed("finished").map((t) => ({ ...t, kind: "docs" as const })), { maxLength: MIN_SAMPLE - 1 }),
        fc.array(taskSeed("open").map((t) => ({ ...t, kind: "docs" as const })), { minLength: 1, maxLength: 3 }),
        fc.array(fc.integer({ min: 0, max: 3_000_000 }), { minLength: MIN_SAMPLE - 1, maxLength: MIN_SAMPLE - 1 }),
      )
      .map(([measured, docs, open, other]) => ({ measured, docs, open, other }));
    await fc.assert(
      fc.asyncProperty(underSampled, async ({ measured, docs, open, other }) => {
        const a = await seedRun({ tasks: [...measured, ...docs, ...open], planning: 0 });
        const changed = docs.map((t, i) => ({ ...t, used: other[i] ?? 0 }));
        const b = await seedRun({ tasks: [...measured, ...changed, ...open], planning: 0 });
        const fa = costForecast(a.store, a.runId, a.policy);
        const fb = costForecast(b.store, b.runId, b.policy);
        expect(fa).not.toBeNull();
        expect(fb).not.toBeNull();
        if (!fa || !fb) return;
        expect(fb.remainingTokens).toBe(fa.remainingTokens);
        expect(close(remainingUsd(b.store, b.runId, fb), remainingUsd(a.store, a.runId, fa))).toBe(true);
        // Below the minimum sample each open task costs its plan midpoint less what its attempt
        // in flight already holds, plus the final review and convergence.
        const own = open.reduce((sum, t) => sum + Math.max(0, (t.low + t.high) / 2 - (t.inFlight ? Math.max(t.inFlight.used, t.inFlight.reserved) : 0)), 0);
        expect(Math.abs(fa.remainingTokens - (own + verificationTokens()))).toBeLessThanOrEqual(0.5);
      }),
      { numRuns: RUNS },
    );
  }, 60_000);
});

// The initiative token pool's forecast, its suggested sizes and the shadow extension inside the
// dollar cap (#2042).
describe("token pool invariants (#2042)", () => {
  const poolFeature = fc.record({
    low: fc.integer({ min: 1, max: 5_000_000 }),
    span: fc.integer({ min: 0, max: 5_000_000 }),
  }).map(({ low, span }) => ({ low, high: low + span }));
  const poolSeed = fc.record({
    limitTokens: fc.integer({ min: 1_000_000, max: 60_000_000 }),
    usedTokens: fc.integer({ min: 0, max: 50_000_000 }),
    held: fc.integer({ min: 0, max: 10_000_000 }),
    forecast: fc.option(fc.integer({ min: 0, max: 80_000_000 }), { nil: null }),
    waiting: fc.array(poolFeature, { minLength: 0, maxLength: 5 }),
    capUsd: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
    spentUsd: fc.double({ min: 0, max: 100, noNaN: true }),
    forecastUsd: fc.option(fc.double({ min: 0, max: 150, noNaN: true }), { nil: null }),
  }).map((s) => ({
    initiativeId: "pool",
    limitTokens: s.limitTokens,
    usedTokens: s.usedTokens,
    committedTokens: s.usedTokens + s.held,
    forecastTokens: s.forecast === null ? null : Math.max(s.forecast, s.usedTokens),
    ratio: null,
    features: s.waiting.length + 1,
    waiting: s.waiting.map((f, i) => ({ id: `f${i}`, ...f })),
    cost: { capUsd: s.capUsd, ceilingUsd: s.capUsd === null ? null : s.capUsd * 1.25, spentUsd: s.spentUsd, remainingUsd: s.capUsd === null ? null : Math.max(0, s.capUsd - s.spentUsd), forecastUsd: s.forecastUsd },
  }));
  const lows = (i: { committedTokens: number; waiting: { low: number }[] }) => i.committedTokens + i.waiting.reduce((n, f) => n + f.low, 0);
  const highs = (i: { committedTokens: number; waiting: { high: number }[] }) => i.committedTokens + i.waiting.reduce((n, f) => n + f.high, 0);

  test("the suggested pool covers the forecast and every waiting low; the cover covers every high", () => {
    fc.assert(fc.property(poolSeed, (inputs) => {
      const pool = tokenPool(inputs);
      expect(pool.coverTokens % POOL_STEP).toBe(0);
      expect(pool.coverTokens).toBeGreaterThanOrEqual(highs(inputs));
      expect(pool.coverTokens - highs(inputs)).toBeLessThan(POOL_STEP);
      const over = inputs.forecastTokens !== null && inputs.forecastTokens > inputs.limitTokens;
      expect(pool.suggestedTokens !== null).toBe(over);
      expect(pool.notice !== null).toBe(over);
      if (pool.suggestedTokens !== null) {
        expect(pool.suggestedTokens % POOL_STEP).toBe(0);
        // A cap that pays for more than the pool advises what it pays for, never more (#2244).
        const byDollars = pool.capTokens !== null && Math.floor(pool.capTokens / POOL_STEP) * POOL_STEP > inputs.limitTokens;
        if (byDollars) {
          expect(pool.suggestedTokens).toBe(Math.floor((pool.capTokens ?? 0) / POOL_STEP) * POOL_STEP);
          expect(pool.suggestedTokens).toBeGreaterThan(inputs.limitTokens);
          expect(pool.notice).toContain("so the pool stops no feature before the dollar cap does");
        } else {
          expect(pool.suggestedTokens).toBeGreaterThanOrEqual(inputs.forecastTokens ?? 0);
          expect(pool.suggestedTokens).toBeGreaterThanOrEqual(lows(inputs));
        }
      }
    }), { numRuns: 200 });
  });

  test("the extension stays inside the person's dollar cap and starts every waiting feature", () => {
    fc.assert(fc.property(poolSeed, (inputs) => {
      const pool = tokenPool(inputs);
      const decision = poolExtensionDecision(inputs, pool);
      if (inputs.cost.capUsd === null || inputs.cost.forecastUsd === null) expect(decision.wouldExtend).toBe(false);
      if (!decision.wouldExtend) return;
      const to = decision.toTokens ?? 0;
      expect(to).toBeGreaterThan(inputs.limitTokens);
      expect(decision.byTokens).toBe(to - inputs.limitTokens);
      expect(to).toBeLessThanOrEqual(pool.coverTokens);
      expect(to - inputs.committedTokens).toBeGreaterThanOrEqual(lows(inputs) - inputs.committedTokens);
      expect(inputs.cost.forecastUsd ?? Infinity).toBeLessThanOrEqual(inputs.cost.ceilingUsd ?? -1);
      if (pool.capTokens !== null) expect(to).toBeLessThanOrEqual(pool.capTokens);
    }), { numRuns: 300 });
  });

  test("the measured forecast is never below what was used", () => {
    const feature = fc.record({
      accepted: fc.boolean(), skeleton: fc.boolean(), spent: fc.integer({ min: 0, max: 5_000_000 }),
      low: fc.option(fc.integer({ min: 1, max: 5_000_000 }), { nil: null }), expected: fc.integer({ min: 0, max: 5_000_000 }),
    });
    fc.assert(fc.property(fc.array(feature, { minLength: 3, maxLength: 10 }), (seeds) => {
      const features = seeds.map((f, i) => ({ id: `f${i}`, ...f }));
      const used = features.reduce((n, f) => n + f.spent, 0);
      const forecast = poolForecast(used, features);
      const measured = features.filter((f) => f.accepted && !f.skeleton && (f.low ?? 0) > 0);
      if (measured.length < 3 || measured.every((f) => f.spent === 0)) return;
      expect(forecast).not.toBeNull();
      expect(forecast?.forecastTokens ?? 0).toBeGreaterThanOrEqual(used);
    }), { numRuns: 200 });
  });
});

// The plan charge (#2100, #2056): an open feature run with a sized plan is held at the high end of
// its plan's need at the measured ratio, never below its use, instead of max(used, limit).
describe("plan charge invariants (#2100)", () => {
  const openRun = fc.record({
    usedTokens: fc.integer({ min: 0, max: 8_000_000 }),
    limitTokens: fc.integer({ min: 100_000, max: 8_000_000 }),
    low: fc.integer({ min: 10_000, max: 6_000_000 }),
    expected: fc.option(fc.integer({ min: 0, max: 6_000_000 }), { nil: undefined }),
    span: fc.integer({ min: 0, max: 4_000_000 }),
  }).map((r, i) => ({
    featureId: `f${i}`, runId: `r${i}`, usedTokens: r.usedTokens, limitTokens: r.limitTokens,
    plan: { low: r.low, high: r.low + r.span, ...(r.expected === undefined ? {} : { expected: Math.max(r.low, r.expected) }) },
  }));
  const seed = fc.record({
    finished: fc.integer({ min: 0, max: 20_000_000 }),
    unplanned: fc.integer({ min: 0, max: 10_000_000 }),
    ratio: fc.option(fc.double({ min: 0.3, max: 3, noNaN: true }), { nil: null }),
    runs: fc.array(openRun, { minLength: 1, maxLength: 6 }),
  });
  const held = (r: { usedTokens: number; limitTokens: number }) => Math.max(r.usedTokens, r.limitTokens);

  test("the charge is never below what a run used, and the pool never below what all runs used", () => {
    fc.assert(fc.property(seed, ({ finished, unplanned, ratio, runs }) => {
      const limitCommitted = finished + unplanned + runs.reduce((n, r) => n + held(r), 0);
      const charge = planCharge("enforce", ratio, limitCommitted, runs);
      expect(charge).not.toBeNull();
      for (const run of charge?.runs ?? []) expect(run.chargeTokens).toBeGreaterThanOrEqual(run.usedTokens);
      const used = finished + runs.reduce((n, r) => n + r.usedTokens, 0);
      expect(charge?.planCommittedTokens ?? 0).toBeGreaterThanOrEqual(used);
    }), { numRuns: 300 });
  });

  test("it is exactly the plan's need both ways: never above the open runs' limits unless a plan prices above its limit", () => {
    fc.assert(fc.property(seed, ({ finished, unplanned, ratio, runs }) => {
      const limitCommitted = finished + unplanned + runs.reduce((n, r) => n + held(r), 0);
      const charge = planCharge("shadow", ratio, limitCommitted, runs);
      for (const run of charge?.runs ?? []) {
        expect(run.chargeTokens).toBe(planChargeTokens(run.usedTokens, run.plan, ratio, run.limitTokens));
        const expected = Math.round((run.plan.expected ?? run.plan.low) * (ratio ?? 1));
        // #2253: unmeasured, a plan whose low end is above the run's limit is held at its expected
        // need (never below its low end, so still above the limit), not at its high end.
        const contradicts = ratio === null && run.plan.low > run.limitTokens;
        const need = contradicts ? Math.max(run.plan.low, expected) : Math.max(run.plan.high, expected);
        expect(run.chargeTokens).toBe(Math.max(run.usedTokens, need));
        if (contradicts) expect(run.chargeTokens).toBeGreaterThan(run.limitTokens);
        else expect(run.chargeTokens).toBeGreaterThanOrEqual(run.plan.high);
        if (need <= run.limitTokens) expect(run.chargeTokens).toBeLessThanOrEqual(held(run));
      }
      const fits = (charge?.runs ?? []).every((r) => r.chargeTokens <= held(r));
      if (fits) expect(charge?.planCommittedTokens ?? 0).toBeLessThanOrEqual(limitCommitted);
    }), { numRuns: 300 });
  });

  test("what the charge frees is counted once, and a run that ends returns its charge to the pool once", () => {
    fc.assert(fc.property(seed, ({ finished, unplanned, ratio, runs }) => {
      const limitCommitted = finished + unplanned + runs.reduce((n, r) => n + held(r), 0);
      const charge = planCharge("shadow", ratio, limitCommitted, runs);
      if (!charge) return;
      expect(charge.releasedTokens).toBe(charge.runs.reduce((n, r) => n + held(r) - r.chargeTokens, 0));
      expect(charge.limitCommittedTokens - charge.planCommittedTokens).toBe(charge.releasedTokens);
      // The first run ends: it counts at its use, and the others keep their charges.
      const [ended, ...rest] = charge.runs;
      if (!ended) return;
      const after = planCharge("shadow", ratio, limitCommitted - held(ended) + ended.usedTokens, rest);
      const planAfter = after?.planCommittedTokens ?? limitCommitted - held(ended) + ended.usedTokens;
      expect(planAfter).toBe(charge.planCommittedTokens - ended.chargeTokens + ended.usedTokens);
    }), { numRuns: 300 });
  });
  test("in dollars (#2124) the charge is never below what a run spent and reserved, and holds the cap while the task-call rate is unmeasured", () => {
    const dollars = fc.record({
      taskRate: fc.option(fc.double({ min: 1e-8, max: 2e-5, noNaN: true }), { nil: null }),
      otherUsd: fc.double({ min: 0, max: 30, noNaN: true }),
      usd: fc.array(fc.record({ used: fc.double({ min: 0, max: 10, noNaN: true }), cap: fc.double({ min: 0, max: 10, noNaN: true }) }), { minLength: 6, maxLength: 6 }),
    });
    fc.assert(fc.property(seed, dollars, ({ finished, unplanned, ratio, runs }, { taskRate, otherUsd, usd }) => {
      const priced = runs.map((r, i) => ({ ...r, usedUsd: usd[i]!.used, limitUsd: Math.max(usd[i]!.used, usd[i]!.cap) }));
      const limitCommittedUsd = otherUsd + priced.reduce((n, r) => n + r.limitUsd, 0);
      const limitCommitted = finished + unplanned + runs.reduce((n, r) => n + held(r), 0);
      const charge = planCharge("shadow", ratio, limitCommitted, priced, { taskRate, limitCommittedUsd })!;
      for (const run of charge.runs) {
        if (taskRate === null) expect(run.chargeUsd).toBeNull();
        else {
          expect(run.chargeUsd!).toBeGreaterThanOrEqual(run.usedUsd!);
          expect(run.chargeUsd!).toBeCloseTo(Math.max(run.usedUsd!, run.chargeTokens * taskRate), 9);
        }
      }
      const released = charge.runs.reduce((n, r) => n + (r.chargeUsd === null || r.chargeUsd === undefined ? 0 : r.limitUsd! - r.chargeUsd), 0);
      expect(charge.usd!.releasedUsd).toBeCloseTo(released, 9);
      expect(charge.usd!.limitCommittedUsd - charge.usd!.planCommittedUsd).toBeCloseTo(charge.usd!.releasedUsd, 9);
      // The dollar budget never holds less than what every run spent and reserved.
      const spent = otherUsd + priced.reduce((n, r) => n + r.usedUsd, 0);
      expect(charge.usd!.planCommittedUsd).toBeGreaterThanOrEqual(spent - 1e-9);
      if (taskRate === null) expect(charge.usd!.releasedUsd).toBe(0);
      // Without a dollar budget there is no dollar side, and the tokens do not change.
      const plain = planCharge("shadow", ratio, limitCommitted, runs)!;
      expect(plain.usd).toBeNull();
      expect(plain.planCommittedTokens).toBe(charge.planCommittedTokens);
    }), { numRuns: 300 });
  });
});

describe("dollar cap park invariants (#2218)", () => {
  const seed = fc.record({
    capUsd: fc.double({ min: 1, max: 60, noNaN: true }),
    heldShare: fc.double({ min: 0, max: 1, noNaN: true }),
    releasedUsd: fc.double({ min: -5, max: 5, noNaN: true }),
    lowUsd: fc.double({ min: 0.01, max: 10, noNaN: true }),
    forecastUsd: fc.option(fc.double({ min: 0, max: 90, noNaN: true }), { nil: null }),
  });
  const viewOf = ({ capUsd, heldShare, releasedUsd, lowUsd, forecastUsd }: { capUsd: number; heldShare: number; releasedUsd: number; lowUsd: number; forecastUsd: number | null }) => {
    const limitCommittedUsd = capUsd * heldShare;
    const remainingUsd = Math.floor((capUsd - limitCommittedUsd) * 100) / 100;
    const feature = { id: "next", state: "ready", share: { tokens: 1, calls: 1, activeMs: 1 }, need: null, needUsd: { low: lowUsd, high: lowUsd * 2 } };
    return { feature, remainingUsd, limitCommittedUsd, view: {
      initiativeId: "i", features: [feature],
      budget: { remaining: { tokens: 1, calls: 1, activeMs: 1 },
        cost: { capUsd, tolerance: 0, ceilingUsd: capUsd, spentUsd: 0, reservedUsd: 0, remainingUsd, forecastUsd, measuredFeatures: 3, forecastBinding: false, forecastMode: "enforce", forecastNotice: null, shareMode: "shadow" },
        planCharge: { mode: "shadow", ratio: null, runs: [], limitCommittedTokens: 0, planCommittedTokens: 0, releasedTokens: 0,
          usd: { taskRate: 1, limitCommittedUsd, planCommittedUsd: limitCommittedUsd - releasedUsd, releasedUsd } } },
    } as unknown as ShareGateView };
  };

  test("the dollars left count each open run once, at its plan charge, and the remedy covers the low and the forecast", () => {
    fc.assert(fc.property(seed, (s) => {
      const { view, feature, remainingUsd } = viewOf(s);
      const park = dollarCapPark(view, feature);
      const left = Math.max(0, remainingUsd + s.releasedUsd);
      if (park === null) {
        expect(left).toBeGreaterThanOrEqual(s.lowUsd - 0.005);
        return;
      }
      expect(park.leftUsd).toBeCloseTo(left, 1);
      expect(park.leftUsd).toBeLessThan(s.lowUsd);
      // In enforce `remainingUsd` already holds the charge: it is not counted a second time.
      const enforced = { ...view, budget: { ...view.budget, planCharge: { ...view.budget.planCharge!, mode: "enforce" as const } } };
      const again = dollarCapPark(enforced, feature);
      if (again) expect(again.leftUsd).toBeCloseTo(Math.max(0, remainingUsd), 1);
      // The extension starts the feature at its low, and pays for the forecast when one exists.
      expect(park.suggestedUsd + park.leftUsd - s.capUsd).toBeGreaterThanOrEqual(s.lowUsd - 1e-6);
      if (s.forecastUsd !== null) expect(park.suggestedUsd).toBeGreaterThanOrEqual(s.forecastUsd - 1e-6);
    }), { numRuns: 300 });
  });

  test("the split's expected dollars lie between its lows and highs, and the features it says the cap pays for fit", () => {
    const feature = fc.record({ low: fc.double({ min: 0.01, max: 10, noNaN: true }), span: fc.double({ min: 0, max: 10, noNaN: true }), at: fc.double({ min: 0, max: 3, noNaN: true }) });
    fc.assert(fc.property(fc.array(feature, { minLength: 1, maxLength: 12 }), fc.double({ min: 0, max: 20, noNaN: true }), fc.double({ min: 0, max: 60, noNaN: true }), (features, spentUsd, remainingUsd) => {
      const estimates = features.map((f) => ({ costUsd: { low: f.low, high: f.low + f.span }, tokens: { low: 1_000_000, high: 2_000_000 }, expectedTokens: Math.round(1_000_000 * f.at) }));
      const e = expectedSplitUsd(estimates, { spentUsd, remainingUsd })!;
      const lows = features.reduce((n, f) => n + f.low, 0);
      const highs = features.reduce((n, f) => n + f.low + f.span, 0);
      expect(e.waitingUsd).toBeGreaterThanOrEqual(lows - 1e-6);
      expect(e.waitingUsd).toBeLessThanOrEqual(highs + 0.01);
      expect(e.totalUsd).toBeGreaterThanOrEqual(spentUsd + lows - 1e-6);
      expect(e.paid).toBeLessThanOrEqual(features.length);
      const expectedOf = (i: number) => Math.min(features[i]!.low + features[i]!.span, Math.max(features[i]!.low, features[i]!.low * features[i]!.at));
      const paidUsd = Array.from({ length: e.paid }, (_, i) => expectedOf(i)).reduce((n, x) => n + x, 0);
      expect(paidUsd).toBeLessThanOrEqual(remainingUsd + 1e-6);
      if (e.paid < features.length) expect(paidUsd + expectedOf(e.paid)).toBeGreaterThan(remainingUsd);
    }), { numRuns: 300 });
  });
});

// A started feature run's remaining stages (#2241): the growth pays for them and never takes the
// initiative past its dollar ceiling.
describe("stage reserve invariants (#2241)", () => {
  const seed = fc.record({
    runSpentUsd: fc.double({ min: 0, max: 20, noNaN: true }),
    runReservedUsd: fc.double({ min: 0, max: 2, noNaN: true }),
    requestedUsd: fc.double({ min: 0, max: 2, noNaN: true }),
    stageReserveUsd: fc.double({ min: 0.001, max: 3, noNaN: true }),
    boundOver: fc.double({ min: -1, max: 3, noNaN: true }),
    othersUsd: fc.double({ min: 0, max: 60, noNaN: true }),
    capUsd: fc.double({ min: 1, max: 60, noNaN: true }),
    tolerance: fc.double({ min: 0, max: 0.5, noNaN: true }),
  });

  test("the grown bound covers spent, reserved and the stages, and the initiative stays under its ceiling", () => {
    fc.assert(fc.property(seed, (s) => {
      const boundUsd = Math.max(0.01, Math.round((s.runSpentUsd + s.runReservedUsd + s.boundOver) * 100) / 100);
      const runHeldUsd = Math.max(boundUsd, s.runSpentUsd + s.runReservedUsd);
      const ceilingUsd = s.capUsd * (1 + s.tolerance);
      const inputs = { runId: "r", featureId: "f", stages: ["review", "converge"], stageReserveUsd: s.stageReserveUsd, runSpentUsd: s.runSpentUsd, runReservedUsd: s.runReservedUsd, requestedUsd: s.requestedUsd, boundUsd, runHeldUsd, spareUsd: 0, initiative: { committedUsd: s.othersUsd + runHeldUsd, capUsd: s.capUsd, ceilingUsd } };
      const decision = stageReserveDecision(inputs);
      const need = s.runSpentUsd + s.runReservedUsd + Math.max(s.requestedUsd, s.stageReserveUsd);
      // The suggested cap always pays for the stages, by less than a cent more.
      expect(decision.suggestedUsd).toBeGreaterThanOrEqual(need - 1e-9);
      expect(decision.suggestedUsd - need).toBeLessThan(0.01 + 1e-9);
      if (!decision.wouldExtend) {
        expect(decision.toUsd).toBeNull();
        return;
      }
      expect(decision.toUsd).toBe(decision.suggestedUsd);
      expect(decision.toUsd!).toBeGreaterThan(boundUsd);
      expect(s.othersUsd + decision.toUsd!).toBeLessThanOrEqual(ceilingUsd + 1e-9);
    }), { numRuns: 300 });
  });
});

describe("charge growth invariants (#2280)", () => {
  const seed = fc.record({
    limitTokens: fc.integer({ min: 1_000_000, max: 60_000_000 }),
    othersTokens: fc.integer({ min: 0, max: 70_000_000 }),
    waitingLowTokens: fc.integer({ min: 0, max: 10_000_000 }),
    usedTokens: fc.integer({ min: 0, max: 20_000_000 }),
    chargeTokens: fc.integer({ min: 0, max: 40_000_000 }),
    boundTokens: fc.integer({ min: 10_000, max: 20_000_000 }),
    ceilingUsd: fc.double({ min: 1, max: 60, noNaN: true }),
    othersUsd: fc.double({ min: 0, max: 70, noNaN: true }),
    usedUsd: fc.double({ min: 0, max: 20, noNaN: true }),
    chargeUsd: fc.double({ min: 0, max: 40, noNaN: true }),
    boundUsd: fc.double({ min: 0.01, max: 20, noNaN: true }),
  });

  test("used plus open runs' bounds never exceeds the pool or the ceiling unless a bound was already there or the run used it", () => {
    fc.assert(fc.property(seed, (s) => {
      const usedTokens = Math.min(s.usedTokens, s.chargeTokens);
      const usedUsd = Math.min(s.usedUsd, s.chargeUsd);
      const hold = chargeHold({
        charge: { tokens: s.chargeTokens, usd: s.chargeUsd },
        own: { usedTokens, usedUsd },
        pool: { limitTokens: s.limitTokens, othersTokens: s.othersTokens, waitingLowTokens: s.waitingLowTokens },
        dollars: { ceilingUsd: s.ceilingUsd, othersUsd: s.othersUsd },
      });
      // Never above the charge, never below what the run used.
      expect(hold.tokens).toBeLessThanOrEqual(s.chargeTokens);
      expect(hold.tokens).toBeGreaterThanOrEqual(usedTokens);
      expect(hold.usd!).toBeLessThanOrEqual(s.chargeUsd);
      expect(hold.usd!).toBeGreaterThanOrEqual(usedUsd);
      // The pool counts the run at its charge: the room (growthLimit, costGrowthLimit) is what is
      // left after it, the others and the lows.
      const roomTokens = Math.max(0, s.limitTokens - s.othersTokens - s.chargeTokens - s.waitingLowTokens);
      const roomUsd = Math.max(0, s.ceilingUsd - s.othersUsd - s.chargeUsd);
      const policy: RunPolicy = { ...fixturePolicy, maxCostUsd: s.boundUsd, sizing: { maxRunTokens: s.boundTokens, extendToTokens: s.boundTokens, maxRunCostUsd: s.boundUsd } };
      const base: RunPolicy = { ...fixturePolicy, sizing: { maxRunTokens: 100_000_000, extendToTokens: 100_000_000 } };
      const after = refreshedGrowth(policy, base, { tokens: hold.tokens, usd: hold.usd!, calls: 0, activeMs: 0 }, { calls: 0, activeMs: 0 }, { tokens: roomTokens, usd: roomUsd, calls: 0, activeMs: 0 }) ?? policy;
      for (const bound of [after.sizing!.maxRunTokens!, after.sizing!.extendToTokens!])
        if (bound > s.boundTokens && bound > usedTokens) expect(s.othersTokens + s.waitingLowTokens + bound).toBeLessThanOrEqual(s.limitTokens);
      const usd = after.sizing!.maxRunCostUsd!;
      if (usd > s.boundUsd && usd > usedUsd + 0.01) expect(s.othersUsd + usd).toBeLessThanOrEqual(s.ceilingUsd + 0.01);
    }), { numRuns: 300 });
  });

  test("a bound the shadow reason passes fits the pool less the others' use and the ceiling less their spend", () => {
    fc.assert(fc.property(seed, (s) => {
      const decision = poolBoundDecision({ runId: "r", featureId: "f", limitTokens: s.limitTokens, othersUsedTokens: s.othersTokens, ceilingUsd: s.ceilingUsd, othersSpentUsd: s.othersUsd, tokens: [{ kind: "maxRunTokens", value: s.boundTokens }], usd: [{ kind: "maxRunCostUsd", value: s.boundUsd }] });
      const fits = s.othersTokens + s.boundTokens <= s.limitTokens && s.othersUsd + s.boundUsd <= s.ceilingUsd + 0.005;
      if (fits) expect(decision.wouldStop).toBe(false);
      if (s.othersTokens + s.boundTokens > s.limitTokens) expect(decision.wouldStop).toBe(true);
      if (s.othersUsd + s.boundUsd > s.ceilingUsd + 0.006) expect(decision.wouldStop).toBe(true);
    }), { numRuns: 300 });
  });
});

describe("token growth room invariants (#2294)", () => {
  const seed = fc.record({
    remainingTokens: fc.integer({ min: 0, max: 30_000_000 }),
    heldTokens: fc.integer({ min: 10_000, max: 20_000_000 }),
    boundTokens: fc.integer({ min: 10_000, max: 20_000_000 }),
    waiting: fc.array(fc.record({ share: fc.integer({ min: 0, max: 10_000_000 }), low: fc.option(fc.integer({ min: 0, max: 10_000_000 })) }), { maxLength: 4 }),
  });

  test("an initiative run's token room is never null, and a raised bound never passes what it holds plus the pool left", () => {
    fc.assert(fc.property(seed, (s) => {
      const view = {
        budget: { remaining: { tokens: s.remainingTokens, calls: 0, activeMs: 0 } },
        features: [
          { id: "run", share: null, need: null },
          ...s.waiting.map((w, i) => ({ id: `w${i}`, share: { tokens: w.share, calls: 0, activeMs: 0 }, need: w.low === null ? null : { low: w.low, high: w.low } })),
        ],
      } as unknown as Pick<ShareGateView, "budget" | "features">;
      const room = growthLimit(view, "run");
      expect(room).not.toBeNull();
      expect(room).toBeGreaterThanOrEqual(0);
      expect(room).toBeLessThanOrEqual(s.remainingTokens);
      // With nothing estimated, the waiting features keep their whole shares.
      if (s.waiting.every((w) => w.low === null))
        expect(room).toBe(Math.max(0, s.remainingTokens - s.waiting.reduce((sum, w) => sum + w.share, 0)));
      const policy: RunPolicy = { ...fixturePolicy, sizing: { maxRunTokens: s.boundTokens, extendToTokens: s.boundTokens } };
      const base: RunPolicy = { ...fixturePolicy, sizing: { maxRunTokens: 8_000_000, extendToTokens: 12_000_000 } };
      const after = refreshedGrowth(policy, base, { tokens: s.heldTokens, usd: 0, calls: 0, activeMs: 0 }, { calls: 0, activeMs: 0 }, { tokens: room, usd: null, calls: 0, activeMs: 0 }) ?? policy;
      for (const bound of [after.sizing!.maxRunTokens!, after.sizing!.extendToTokens!])
        if (bound > s.boundTokens) expect(bound).toBeLessThanOrEqual(s.heldTokens + s.remainingTokens);
    }), { numRuns: 300 });
  });
});

describe("calls pool invariants (#2345)", () => {
  const callsSeed = fc.record({
    limitCalls: fc.integer({ min: 1, max: 5_000 }),
    usedCalls: fc.integer({ min: 0, max: 5_000 }),
    heldCalls: fc.integer({ min: 0, max: 2_000 }),
    usedTokens: fc.integer({ min: 0, max: 50_000_000 }),
    forecast: fc.option(fc.integer({ min: 0, max: 80_000_000 }), { nil: null }),
    callsPerMillion: fc.option(fc.integer({ min: 1, max: 500 }), { nil: null }),
    waitingHighTokens: fc.integer({ min: 0, max: 20_000_000 }),
  }).map((s) => ({
    initiativeId: "calls",
    limitCalls: s.limitCalls,
    usedCalls: s.usedCalls,
    committedCalls: s.usedCalls + s.heldCalls,
    usedTokens: s.usedTokens,
    forecastTokens: s.forecast === null ? null : Math.max(s.forecast, s.usedTokens),
    pace: s.callsPerMillion === null ? null : { callsPerMillion: s.callsPerMillion, basis: "initiative" as const, runs: 2 },
    waitingHighTokens: s.waitingHighTokens,
    features: 3,
  }));

  test("the forecast never falls below the used calls; a suggestion is above the forecast and the limit, on the step", () => {
    fc.assert(fc.property(callsSeed, (inputs) => {
      const calls = callsPool(inputs);
      if (calls.forecastCalls !== null) expect(calls.forecastCalls).toBeGreaterThanOrEqual(inputs.usedCalls);
      if (calls.coverCalls !== null) expect(calls.coverCalls).toBeGreaterThanOrEqual(inputs.committedCalls);
      expect(calls.notice !== null).toBe(calls.suggestedCalls !== null);
      if (calls.suggestedCalls !== null) {
        expect(calls.suggestedCalls % CALLS_STEP).toBe(0);
        expect(calls.suggestedCalls).toBeGreaterThan(Math.max(inputs.limitCalls, calls.forecastCalls ?? 0) - 1);
        expect(calls.notice).toContain(`--calls ${calls.suggestedCalls}`);
      }
      const raise = callsRaise(calls);
      if (raise !== null) expect(raise).toBeGreaterThan(inputs.limitCalls);
      if (inputs.pace === null) expect(calls.forecastCalls).toBeNull();
    }), { numRuns: 300 });
  });
});
