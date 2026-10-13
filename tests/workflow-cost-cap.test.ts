import { afterEach, describe, expect, test } from "bun:test";
import { findPricing } from "../src/core/llm/pricing.js";
import { canonical } from "../src/core/specs/hash.js";
import { newId } from "../src/core/workflows/store.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { budgetLimitText, canExtend, extensionText } from "../src/components/workflow/format.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
/** Token and call limits far above what the tests spend, so only the cost cap can stop a call. */
const ROOMY: RunPolicy = { ...fixturePolicy, maxTotalTokens: 10_000_000, maxAgentCalls: 1000 };
const INPUT = (findPricing(MODEL)?.pricing.input ?? 0) / 1e6;

/** Usage of one attempt with only uncached input, so it costs `input` at the input price. */
function usage(input: number): AttemptUsageRecord {
  return {
    schemaVersion: 1,
    profileId: "implementer",
    taskId: null,
    maxSteps: 10,
    maxTokens: 1_000_000,
    stopReason: "submitted",
    finalizedBy: null,
    totalTokens: input,
    steps: [
      {
        step: 1,
        inputTokens: input,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        toolCalls: 0,
        compactedBytes: 0,
      },
    ],
  };
}

function fixture(policy: RunPolicy = fixturePolicy) {
  const made = workflowFixture({ policy });
  cleanups.push(made.dispose);
  return made;
}

/** A running run whose store calls take `policy`, with a helper that spends priced attempts. */
async function runningRun(policy: RunPolicy) {
  const made = fixture();
  const { store } = made.service;
  const run = await made.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const stepId = store.beginStep(run.runId, "fixture");
  const spend = (input: number) => {
    const id = store.reserve(run.runId, stepId, MODEL, 1000, policy);
    store.transaction(() => {
      store.artifact(run.runId, "usage", `attempts/${id}/usage.json`, canonical(usage(input)));
      store.finishAttempt(run.runId, id, "completed", input);
    });
  };
  return { store, runId: run.runId, stepId, spend };
}

describe("cost cap (maxCostUsd)", () => {
  test("a start is refused when a model the run can call has no price", async () => {
    const made = fixture();
    const start = made.service.start({
      commandId: newId(),
      featureId: "capped",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      policy: { ...fixturePolicy, maxCostUsd: 5 },
    });
    await expect(start).rejects.toThrow(/no price is known for fixture\/model/);
  });

  test("a start on priced models keeps the cap and reports it in status", async () => {
    const made = fixture();
    const run = await made.service.start({
      commandId: newId(),
      featureId: "capped",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      model: MODEL,
      policy: { ...fixturePolicy, maxCostUsd: 5 },
    });
    expect(made.service.store.snapshot(run.runId).maxCostUsd).toBe(5);
    // A run without a cap leaves the field out.
    const plain = await made.start("plain");
    expect("maxCostUsd" in made.service.store.snapshot(plain.runId)).toBe(false);
  });

  test("a model call that would pass the cap stops the run's budget", async () => {
    const cap = 1_000_000 * INPUT; // the price of one million uncached input tokens
    const capped = { ...ROOMY, maxCostUsd: cap };
    const { store, runId, stepId, spend } = await runningRun(capped);
    spend(900_000);
    expect(store.snapshot(runId).estimatedCostUsd).toBeCloseTo(0.9 * cap, 6);
    // At the run's rate so far, 200k more tokens pass the cap; the same call has no cap without one.
    expect(() => store.reserve(runId, stepId, MODEL, 200_000, capped)).toThrow(
      /would pass the run's cost cap/,
    );
    expect(() => store.reserve(runId, stepId, MODEL, 200_000, ROOMY)).not.toThrow();
  });

  test("open attempts reserve against the remaining cost, so the last wave does not overrun", async () => {
    const cap = 1_000_000 * INPUT;
    const capped = { ...ROOMY, maxCostUsd: cap };
    const { store, runId, stepId, spend } = await runningRun(capped);
    spend(400_000);
    // 600k tokens of cost are left: one 400k attempt fits, a second parallel one does not.
    store.reserve(runId, stepId, MODEL, 400_000, capped);
    expect(() => store.reserve(runId, stepId, MODEL, 400_000, capped)).toThrow(
      /would pass the run's cost cap/,
    );
    const usage = store.costUsage(runId);
    expect(usage.spentUsd).toBeCloseTo(0.4 * cap, 6);
    expect(usage.reservedUsd).toBeCloseTo(0.4 * cap, 6);
  });

  test("a model without a price cannot spend under a cap", async () => {
    const capped = { ...fixturePolicy, maxCostUsd: 5 };
    const { store, runId, stepId } = await runningRun(capped);
    expect(() => store.reserve(runId, stepId, "local/unknown-thing", 10, capped)).toThrow(
      /No price is known for local\/unknown-thing/,
    );
  });

  test("extending a run stopped on its cap doubles the cap; a lower or new cap is refused", async () => {
    const made = fixture();
    const { service } = made;
    const run = await service.start({
      commandId: newId(),
      featureId: "capped",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      model: MODEL,
      policy: { ...fixturePolicy, maxCostUsd: 2 },
    });
    const block = (id: string) =>
      service.store.transaction(() => service.store.transition(id, "blocked", "budget_exhausted"));
    block(run.runId);
    const command = async (id: string) => ({
      commandId: newId(),
      expectedRevision: (await service.get(id)).revision,
    });
    // The TUI offers the raise with the cap in it.
    const view = readWorkflowView(service, run.runId).budget;
    expect(canExtend(view)).toBe(true);
    expect(extensionText(view)).toContain("cost cap $2.00 → $4.00");
    expect(budgetLimitText(view)).toContain("cost cap");
    await expect(
      service.extendBudget(run.runId, await command(run.runId), { maxCostUsd: 1 }),
    ).rejects.toThrow(/can only be raised: cost \$2/);
    const extended = await service.extendBudget(run.runId, await command(run.runId));
    expect(extended.maxCostUsd).toBe(4);
    // The CLI names a cap of its own.
    block(run.runId);
    const signal = new AbortController().signal;
    const revision = String((await service.get(run.runId)).revision);
    const raised = (await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["extend", run.runId, "--expected-revision", revision, "--cost-usd", "7.5"]),
      signal,
    )) as { maxCostUsd?: number };
    expect(raised.maxCostUsd).toBe(7.5);
    expect(() =>
      parseWorkflowArgs(["extend", run.runId, "--expected-revision", "1", "--cost-usd", "-1"]),
    ).toThrow("positive number");

    const plain = await made.start("plain");
    block(plain.runId);
    await expect(
      service.extendBudget(plain.runId, await command(plain.runId), { maxCostUsd: 3 }),
    ).rejects.toThrow(/no cost cap to raise/);
  });
});
