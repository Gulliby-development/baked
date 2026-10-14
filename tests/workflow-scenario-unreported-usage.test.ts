import { afterEach, describe, expect, test } from "bun:test";
import { runUsage } from "../src/core/workflows/usage.js";
import { runUsageMarkdown } from "../src/core/workflows/usage-markdown.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 20 (#1057): 7 Codex attempts in 4 runs (spec and plan revisions such
// as colfit 448c01af, a 15 KB revised spec) finished with no usage report and were recorded as 0
// tokens and $0, so run totals and the cost cap missed them.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The spec author's provider reports no usage; the executor charges its size estimate. */
class UnreportedSpecExecutor extends FixtureExecutor {
  override async execute(request: ExecutionRequest) {
    const response = await super.execute(request);
    if (request.profile.output !== "spec") return response;
    return { ...response, inputTokens: 9_000, outputTokens: 3_800, usageComplete: false, usageEstimated: true };
  }
}

describe("scenario: bench round 20, a spec attempt whose provider reported no usage (#1057)", () => {
  test("the run is charged the estimate and the usage report names the estimated attempt", async () => {
    const fixture = workflowFixture({ executor: (root) => new UnreportedSpecExecutor(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    const { store } = fixture.service;
    const spec = store.events(run.runId, 0, 10000).find(
      (e) => e.type === "attempt.finished" && (e.payload as { usageEstimated?: boolean }).usageEstimated === true,
    );
    expect(spec?.payload).toMatchObject({ usedTokens: 12_800, usageComplete: false, usageEstimated: true });
    // Every other fixture call costs 50 tokens; the spec attempt adds its estimate.
    expect(store.run(run.runId).token_usage).toBeGreaterThanOrEqual(12_800);
    const attempt = store.attempts(run.runId).find((a) => a.used_tokens === 12_800);
    expect(attempt?.usage_complete).toBe(1);
  }, 60000);

  test("the usage Markdown counts attempts whose tokens are estimated", () => {
    const row = {
      attemptId: "a1", stage: "specify", model: "codex/gpt-6-luna", status: "completed", usedTokens: 12_800, steps: 1,
      peakInputTokens: 0, inputTokens: 9_000, outputTokens: 3_800, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05,
      effort: null, compactedBytes: 0, stopReason: "submitted" as const, finalizedBy: null, toolBackends: [], tools: [],
      unreportedResponses: 0, usageEstimated: true,
    };
    const markdown = runUsageMarkdown({
      runId: "r1", totalTokens: 12_800,
      totals: { tokens: 12_800, steps: 1, cacheReadTokens: 0, cacheWriteTokens: 0, compactedBytes: 0 },
      stages: [], models: [], toolBackends: [], tools: [], attempts: [row],
    });
    expect(markdown).toContain("- Estimated usage: 1 attempts whose provider reported no usage");
    expect(runUsage).toBeDefined();
  });
});
