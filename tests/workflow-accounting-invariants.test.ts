import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonical } from "../src/core/specs/hash.js";
import { type CostForecast, costForecast, kindRatio } from "../src/core/workflows/cost-forecast.js";
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
