import { afterEach, describe, expect, test } from "bun:test";
import { ACTIVE_FLUSH_MS } from "../src/core/workflows/scheduler.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Holds the research call long enough for the run row to be written, then reads it. */
class SlowResearch extends FixtureExecutor {
  store: WorkflowStore | null = null;
  /** `runs.active_ms` as another process would read it while the drive is still running. */
  seen: number | null = null;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "research" && this.seen === null) {
      await Bun.sleep(ACTIVE_FLUSH_MS * 2.5);
      this.seen = this.store?.run(request.runId).active_ms ?? null;
    }
    return super.execute(request);
  }
}

describe("active time of a run (#1038)", () => {
  test("is on the run row while the process drives it, so a process that dies keeps it", async () => {
    // Bench round 19, logslice-update: a process drove the run for 25 minutes and was killed;
    // after the resume the run reported 1.2 minutes, the resumed process's share only.
    const fx = workflowFixture({ executor: (root) => new SlowResearch(root) });
    cleanups.push(() => fx.dispose());
    fx.executor.store = fx.service.store;
    const run = await fx.start();
    const started = performance.now();
    await fx.service.drive(run.runId, new AbortController().signal);
    const wall = performance.now() - started;
    expect(fx.executor.seen).toBeGreaterThanOrEqual(ACTIVE_FLUSH_MS * 2 - 50);
    // The figure at the end is still the whole drive, counted once: never more than the drive's
    // own wall time, however slow the runner is.
    const total = fx.service.store.run(run.runId).active_ms;
    expect(total).toBeGreaterThanOrEqual(ACTIVE_FLUSH_MS * 2.5 - 50);
    expect(total).toBeLessThanOrEqual(Math.ceil(wall) + 1);
  }, 30000);
});
