import { afterEach, describe, expect, test } from "bun:test";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { runUsageMarkdown } from "../src/core/workflows/usage-markdown.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 24 (#936): cfgtrace T008 ran 10 attempts over several repair reruns, and the usage
// report folded them into one row, so the cost of each rerun could not be read.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("usage by task generation (#936)", () => {
  test("a task's rerun after a repair invalidated it is its own row", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    const store = service.store;
    const policy = JSON.parse(store.run(run.runId).policy_json) as RunPolicy;
    // A repair invalidates T001 and its rerun takes two attempts.
    store.transaction(() => store.taskStatus(run.runId, "T001", "invalidated"));
    const step = store.transaction(() => store.beginStep(run.runId, "task-T001"));
    for (const used of [70, 30]) {
      const attempt = store.reserve(run.runId, step, "fixture/model", 100, policy);
      store.transaction(() => store.finishAttempt(run.runId, attempt, "completed", used));
    }
    const usage = runUsage(store, run.runId);
    const first = usage.tasks.find((t) => t.taskId === "T001" && t.generation === 0);
    expect(first?.attempts).toBeGreaterThan(0);
    expect(usage.tasks.find((t) => t.taskId === "T001" && t.generation === 1)).toMatchObject({
      attempts: 2,
      tokens: 100,
    });
    expect(usage.attempts.filter((a) => a.taskGeneration === 1)).toHaveLength(2);
    expect(usage.attempts.find((a) => a.stage === "plan")?.taskId).toBeNull();
    const markdown = runUsageMarkdown(usage);
    expect(markdown).toContain("## By task generation");
    expect(markdown).toContain("| T001 generation 1 | 2 | 100 |");
  });
});
