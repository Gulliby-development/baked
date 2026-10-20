import { afterEach, describe, expect, test } from "bun:test";
import { growCostCapToForecast } from "../src/core/workflows/budget.js";
import { PolicySchema, type Task } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #1704: R50 selwhy markup grew its cap to $3.01 on a forecast, and the sizing refresh two
// minutes later wrote the drive's older copy of the policy back: the cap fell to $2.32.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Grows the stored dollar cap during the plan attempt, from its own copy, as the executor does. */
class GrowingExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  grownTo: number | null = null;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan" && this.grownTo === null) {
      const own = PolicySchema.parse(JSON.parse(this.store.run(request.runId).policy_json));
      growCostCapToForecast(this.store, request.runId, own, 9, 0);
      this.grownTo = own.maxCostUsd;
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      // Enough test files that the sized price passes the starting token budget.
      const plan = result.output as { taskGraph: { tasks: Task[] } };
      const template = plan.taskGraph.tasks[0]!;
      plan.taskGraph.tasks = Array.from({ length: 20 }, (_, i) => ({
        ...template,
        id: `T${String(i + 1).padStart(3, "0")}`,
        title: `Create test ${i + 1}`,
        description: `Create test file ${i + 1}`,
        dependsOn: i ? [`T${String(i).padStart(3, "0")}`] : [],
        writes: [{ path: `tests/value${i}.test.ts`, action: "create" as const }],
      }));
    }
    return result;
  }
}

describe("scenario: the sizing raise keeps a cap the executor grew (#1704)", () => {
  test("the plan's sizing raise writes the grown cap, not the drive's older one", async () => {
    const policy = {
      ...fixturePolicy,
      maxAgentCalls: 1000,
      maxTotalTokens: 3_200_000,
      maxCostUsd: 2,
      sizing: { maxRunTokens: 20_000_000, maxRunCostUsd: 20 },
    };
    const fixture = workflowFixture({ policy, executor: (root) => new GrowingExecutor(root) });
    cleanups.push(fixture.dispose);
    fixture.config.defaultModel = "anthropic/claude-sonnet-4-6";
    const store = fixture.service.store;
    fixture.executor.store = store;
    const { runId } = await fixture.start();
    await fixture.service.drive(runId, new AbortController().signal);
    expect(fixture.executor.grownTo).toBe(9);
    const revisions = store
      .artifacts(runId)
      .filter((a) => a.kind === "policy-revision")
      .map((a) => JSON.parse(store.readArtifact(runId, a.id)) as { kind: string; previous: { maxCostUsd?: number }; next: { maxTotalTokens?: number; maxCostUsd?: number } });
    const sizing = revisions.find((r) => r.kind === "sizing");
    // The sizing raise happened after the growth and grew the token budget.
    expect(sizing?.next.maxTotalTokens).toBeGreaterThan(3_200_000);
    expect(sizing?.previous.maxCostUsd ?? 9).toBe(9);
    const stored = PolicySchema.parse(JSON.parse(store.run(runId).policy_json));
    expect(stored.maxCostUsd).toBeGreaterThanOrEqual(9);
  }, 60000);
});
