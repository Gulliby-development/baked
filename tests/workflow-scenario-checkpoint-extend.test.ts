import { afterEach, describe, expect, test } from "bun:test";
import { extensionText, offersExtend } from "../src/components/workflow/format.js";
import { proposeExtension, UNCAPPED_TOKENS } from "../src/core/workflows/budget.js";
import { PolicySchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2667: a `checkpoints` run has no token cap (UNCAPPED_TOKENS, above the 50M a single extension
// may raise tokens to). The run screen offered B after a call or cost stop and the service refused
// it: the kept 1e9 token limit failed the ceiling check, or the proposal "raised" it to 50M.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MODEL = "anthropic/claude-sonnet-4-6";
const checkpoints = (extra: Partial<RunPolicy> = {}): RunPolicy => ({
  ...fixturePolicy,
  maxTotalTokens: UNCAPPED_TOKENS,
  checkpointTokens: 1_000_000,
  ...extra,
});

describe("extending a checkpoints run (#2667)", () => {
  test("a run stopped on its call limit raises its calls and keeps its uncapped tokens", async () => {
    const fixture = workflowFixture({ policy: checkpoints({ maxAgentCalls: 3 }) });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    let state = await service.get(run.runId);
    for (let i = 0; i < 12 && state.status !== "blocked" && state.status !== "completed"; i++) {
      if (state.pendingRequestIds.length) await fixture.approve(run.runId);
      else if (state.status === "paused" || state.status === "created")
        await fixture.resume(run.runId);
      await service.drive(run.runId, new AbortController().signal);
      state = await service.get(run.runId);
    }
    expect(state).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
    // What the run screen offers is what the extension writes.
    const view = readWorkflowView(service, run.runId).budget;
    expect(offersExtend(state, view)).toBe(true);
    expect(extensionText(view)).toBe("calls 3 → 6");

    const extended = await service.extendBudget(run.runId, {
      commandId: newId(),
      expectedRevision: state.revision,
    });
    expect(extended).toMatchObject({ status: "paused", reason: "none" });
    const policy = PolicySchema.parse(JSON.parse(service.store.run(run.runId).policy_json));
    expect(policy).toMatchObject({
      maxAgentCalls: 6,
      maxTotalTokens: UNCAPPED_TOKENS,
      checkpointTokens: 1_000_000,
    });
  });

  test("a capped run blocked with its calls at 80% raises its calls; tokens are not lowered to 50M", async () => {
    const fixture = workflowFixture({ policy: checkpoints() });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await service.start({
      commandId: newId(),
      featureId: "capped",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      model: MODEL,
      policy: checkpoints({ maxCostUsd: 2, maxAgentCalls: 10 }),
    });
    service.store.db.run("UPDATE runs SET agent_calls=8 WHERE id=?", [run.runId]);
    service.store.transaction(() =>
      service.store.transition(run.runId, "blocked", "budget_exhausted"),
    );
    const view = readWorkflowView(service, run.runId).budget;
    // Nothing but the calls explains the stop, so tokens are proposed to double: to 50M, a
    // lowering, before the fix.
    expect(extensionText(view)).toBe("calls 10 → 20");

    const extended = await service.extendBudget(run.runId, {
      commandId: newId(),
      expectedRevision: (await service.get(run.runId)).revision,
    });
    expect(extended.maxCostUsd).toBe(2);
    const policy = PolicySchema.parse(JSON.parse(service.store.run(run.runId).policy_json));
    expect(policy).toMatchObject({ maxAgentCalls: 20, maxTotalTokens: UNCAPPED_TOKENS });
  });

  test("the proposal never lowers a limit above its ceiling", () => {
    const usage = { tokens: 0, heldTokens: 0, inFlightTokens: 0, calls: 9, activeMs: 0 };
    const current = { maxTotalTokens: UNCAPPED_TOKENS, maxAgentCalls: 10, maxActiveMs: 3_600_000 };
    expect(proposeExtension(current, usage)).toEqual({ ...current, maxAgentCalls: 20 });
    // A limit above its ceiling and nothing else to raise: no extension, not a lower one.
    expect(proposeExtension(current, { ...usage, calls: 0 })).toBeNull();
  });
});
