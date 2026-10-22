import { afterEach, describe, expect, test } from "bun:test";
import { ExecutionClock, EXECUTION_GAP_MS, executionTimeout } from "../src/core/workflows/execution-clock.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { silentMs, touchProgress, withDeadline } from "../src/core/workflows/stall.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { suspendClock } from "./helpers/suspend-clock.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: host suspend does not spend a run's active deadline (#1610)", () => {
  test.each([true, false])("the run continues without extend, deadline callback first: %s", async (deadlineFirst) => {
    let wake: ReturnType<typeof suspendClock> | undefined;
    let jumped = false;
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, maxActiveMs: 60_000 },
      executor: (root) => new (class ScriptedExecutor extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output === "implementation" && !jumped) {
            jumped = true;
            touchProgress(request.runId);
            const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, fixture.config);
            // Keep the real attempt watchdog, substituting only the model/provider call.
            Object.defineProperty(native, "runAttempt", { value: async (watched: ExecutionRequest) => {
              await withDeadline("read", 30_000, async () => {
                // Let withDeadline arm its timer before the host goes to sleep.
                await Bun.sleep(0);
                wake!.jump(2 * 60 * 60_000, deadlineFirst);
                await Bun.sleep(10);
                watched.signal.throwIfAborted();
                expect(silentMs(request.runId)).toBeLessThan(5_000);
                const lease = fixture.service.store.lease("execution");
                expect(lease?.expires_at).toBeGreaterThan(Date.now());
                expect(JSON.parse(lease?.process_identity_json ?? "{}").stalledSince).toBeUndefined();
                expect(fixture.service.store.snapshot(request.runId).stalled).toBeUndefined();
              });
              return { output: {}, inputTokens: 0, outputTokens: 0 };
            } });
            try { await native.execute(request); }
            finally { native.dispose(); }
          }
          return super.execute(request);
        }
      })(root),
    });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    wake = suspendClock();
    try {
      const result = await fixture.service.drive(run.runId, signal);
      expect(jumped).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.activeMs).toBeLessThan(60_000);
      expect(fixture.service.store.state(run.runId).stallResumes).toBe(0);
      expect(JSON.parse(fixture.service.store.run(run.runId).policy_json).maxActiveMs).toBe(60_000);
    } finally {
      wake.restore();
    }
  });
});

describe("execution clock", () => {
  test.each([true, false])("excludes suspend when the OS monotonic clock advances: %s", (monotonicAdvances) => {
    let wall = 1_000_000;
    let mono = 0;
    const clock = new ExecutionClock(() => wall, () => mono);
    for (let i = 0; i < 30; i++) { wall += 1000; mono += 1000; clock.now(); }
    const before = clock.now();
    wall += 7_200_000;
    mono += monotonicAdvances ? 7_200_000 : 1000;
    expect(clock.now() - before).toBeLessThanOrEqual(1000);
    expect(clock.since(1_000_000)).toBe(31_000);
    for (let i = 0; i < 30; i++) { wall += 1000; mono += 1000; clock.now(); }
    expect(clock.now()).toBe(61_000);
    wall -= 60_000; mono += 1000;
    expect(clock.now()).toBe(62_000);
  });

  test("ordinary silence still uses up its execution deadline", async () => {
    let now = 0;
    let expired = false;
    const cancel = executionTimeout(() => { expired = true; }, 20, { now: () => now });
    try {
      now = 21;
      await Bun.sleep(40);
      expect(expired).toBe(true);
    } finally { cancel(); }
    expect(EXECUTION_GAP_MS).toBe(15_000);
  });
});
