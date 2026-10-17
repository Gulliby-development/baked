import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Sibling of #1353 (#1411). The host grew a feature's dollar cap with its tokens only on
// auto-growth; the sizing raise after plan sizing grew the tokens alone. A feature that started
// with a $1.46 share and was sized to twice its tokens stopped on the $1.46 cap at about half of
// them, with initiative dollars unspent.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;

/** The fixture executor on a priced model: every call records its tokens as input, so they cost. */
class PricedExecutor extends FixtureExecutor {
  service?: NativeWorkflowService;
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    const tokens = result.inputTokens + result.outputTokens;
    this.service?.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, canonical({ schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null, maxSteps: request.maxSteps, maxTokens: tokens, stopReason: "submitted", finalizedBy: null, totalTokens: tokens, steps: [{ step: 1, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, compactedBytes: 0 }] }));
    return result;
  }
}

// Research spends most of the starting budget, so sizing prices the plan above it; the task then
// spends past the starting cap while it still fits the sized tokens.
const tokens = (output: string) =>
  output === "research" ? 2_900_000 : output === "implementation" ? 300_000 : 20_000;

function fixture(policy: RunPolicy) {
  const base = workflowFixture();
  cleanups.push(base.dispose);
  const executor = new PricedExecutor(base.root, tokens);
  const config = { ...base.config, defaultModel: MODEL, workflows: { ...base.config.workflows, policy } };
  const service = new NativeWorkflowService(base.root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  return service;
}

async function drive(service: NativeWorkflowService, policy: RunPolicy) {
  const { runId } = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  for (let i = 0; i < 12; i++) {
    const run = await service.get(runId);
    if (run.status === "blocked" || run.status === "completed") break;
    const request = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (request) await service.decide(runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    else if (run.status === "paused" || run.status === "created") await service.resume(runId, { commandId: newId(), expectedRevision: run.revision });
    await service.drive(runId, new AbortController().signal);
  }
  return runId;
}

// The cap prices the starting tokens, as an initiative's dollar share does.
const share: RunPolicy = {
  ...fixturePolicy,
  maxTotalTokens: 3_200_000,
  maxCostUsd: Math.ceil(3_200_000 * INPUT * 100) / 100,
};

describe("scenario: the sizing raise grows a feature's dollar cap with its tokens (#1411)", () => {
  test("a sized feature spends past its starting cap without a cost stop, and the revision records the cap", async () => {
    const policy = { ...share, sizing: { maxRunTokens: 20_000_000, maxRunCostUsd: 100 } };
    const service = fixture(policy);
    const runId = await drive(service, policy);
    const { store } = service;
    const run = await service.get(runId);
    expect(run.status).toBe("completed");
    expect(store.costUsage(runId).spentUsd).toBeGreaterThan(share.maxCostUsd ?? 0);
    const sizing = store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("policy-revisions/sizing-"))
      .map((a) => JSON.parse(store.readArtifact(runId, a.id)))
      .at(-1);
    const grown = Math.ceil(((share.maxCostUsd ?? 0) * sizing.next.maxTotalTokens) / share.maxTotalTokens * 100) / 100;
    expect(sizing).toMatchObject({
      kind: "sizing",
      approvedBy: "sizing",
      previous: { maxTotalTokens: 3_200_000, maxCostUsd: share.maxCostUsd },
      next: { maxCostUsd: grown },
    });
    expect(sizing.next.maxTotalTokens).toBeGreaterThan(3_200_000);
  });

  test("without sizing.maxRunCostUsd the sizing raise leaves a cap someone set, and the run stops on it", async () => {
    const policy = { ...share, sizing: { maxRunTokens: 20_000_000 } };
    const service = fixture(policy);
    const runId = await drive(service, policy);
    const run = await service.get(runId);
    expect(run).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    expect(JSON.parse(service.store.run(runId).policy_json).maxCostUsd).toBe(share.maxCostUsd);
  });
});
