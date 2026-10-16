import { afterEach, describe, expect, test } from "bun:test";
import { evaluateAutoApproval } from "../src/core/workflows/auto-approval.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const share = 300000;
const tiered = (ceiling: number): RunPolicy => ({
  ...fixturePolicy,
  maxTotalTokens: share,
  sizing: { maxRunTokens: ceiling },
  autoApproval: {
    renewal: false,
    limits: {
      maxTasks: 5,
      maxFiles: 10,
      allowedPaths: ["**"],
      allowDelete: false,
      allowNewDependencies: false,
      maxTotalTokens: share,
    },
  },
});

describe("tiered approval and the host's own budget growth (#1309)", () => {
  // notesift R32: links started with a 1.20M share, the planning floor raised it to 3.21M, and the
  // tiered limit (the share) declined a plan that was accepted unchanged.
  test("a feature whose budget the planning floor raised above its share is approved without a person", async () => {
    const fixture = workflowFixture({ policy: tiered(5_000_000) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const store = fixture.service.store;
    store.artifact(
      run.runId,
      "estimate",
      "estimates/start.json",
      JSON.stringify({ tokens: { low: 1_000_000, high: 3_200_000 } }),
    );
    await fixture.service.drive(run.runId, new AbortController().signal);
    expect(JSON.parse(store.run(run.runId).policy_json).maxTotalTokens).toBe(3_200_000);
    const request = store.requests(run.runId).find((r) => r.kind === "approval");
    expect(request?.actor).toBe("auto-approval");
    expect(JSON.parse(request?.body_json ?? "{}").autoApproval.mode).toBe("limits");
  });

  const graph = {
    tasks: [
      {
        id: "T-001",
        title: "Value",
        description: "Write the value",
        dependsOn: [],
        writes: [{ path: "value.txt", action: "create" as const }],
        reads: [],
        criteria: ["AC-001"],
        verification: [],
      },
    ],
  } as unknown as Parameters<typeof evaluateAutoApproval>[3];
  const manifest = {} as Parameters<typeof evaluateAutoApproval>[1];

  test("a budget the run started with above the share still needs a person", () => {
    const policy = { ...tiered(5_000_000), maxTotalTokens: 400000 };
    const result = evaluateAutoApproval(policy, manifest, fixtureSpec, graph, [], [], { hostGrowthTokens: 0 });
    expect(result.approval).toBeNull();
    expect(result.reasons).toContain(`Limits: the token budget 400000 exceeds ${share}`);
  });

  test("host growth past the sizing ceiling still needs a person", () => {
    const policy = { ...tiered(1_000_000), maxTotalTokens: 1_500_000 };
    const result = evaluateAutoApproval(policy, manifest, fixtureSpec, graph, [], [], {
      hostGrowthTokens: 1_200_000,
    });
    expect(result.approval).toBeNull();
    expect(result.reasons).toContain("Limits: the token budget 1500000 exceeds the sizing ceiling 1000000");
  });
});
