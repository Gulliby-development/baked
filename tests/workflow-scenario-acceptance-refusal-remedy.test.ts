import { afterEach, describe, expect, test } from "bun:test";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { runActions } from "../src/components/workflow/format.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { assertAcceptance } from "../src/core/verification/acceptance.js";
import { acceptanceRefused } from "../src/core/workflows/acceptance-refusal.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { errorRecovery, type RecoveryAdvice } from "../src/core/workflows/remedies.js";
import { retryRefused } from "../src/core/workflows/remedies-model.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import type { ExecutionRequest, RunSnapshot } from "../src/core/workflows/types.js";
import { readWorkflowView } from "../src/core/workflows/view.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";
import { expectRecovery } from "./helpers/workflow-remedies.js";

// Scenario of bench round 94, md-site 6b1daed3 (#2879). Acceptance refused the finished run with
// "Unresolved findings remain" (findings stranded at the repair cap, #2878): the block offered no
// remedy, and after a second block only the invalid-output advice to switch the stage's model,
// which cannot change what a host predicate reads. Every acceptance refusal now names its object
// and the command that changes it, on every surface (`stopRecovery`: the CLI status, the TUI and
// the desktop through `baked serve`), and no refusal offers a model switch.
//
// | Predicate group | Object named             | Remedies                  |
// | --------------- | ------------------------ | ------------------------- |
// | findings        | finding id and status    | fork (from review), revise, cancel |
// | check           | check id                 | fork (from checks), revise, cancel |
// | review          | review and its verdict   | fork (from review), revise, cancel |
// | task            | task id and status       | fork, revise, cancel      |
// | decision        | request id, its command  | cancel (answering resumes) |
//
// A new predicate in `acceptance()` adds its row here: "every predicate" fails on a refusal with
// no recovery.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

/** The fixture run, with an open finding the review left behind (a stranded finding, #2878). */
function strandedFixture() {
  const f = workflowFixture();
  cleanups.push(f.dispose);
  const original = f.executor.execute.bind(f.executor);
  const ref = { runId: "" };
  f.executor.execute = async (request: ExecutionRequest) => {
    const out = await original(request);
    if (request.profile.output === "review")
      f.service.store.addFinding(
        ref.runId,
        { id: "F-STRAND" } as never,
        hashBytes("stranded finding"),
        "review",
      );
    return out;
  };
  return { ...f, ref };
}

async function blockedAtAcceptance(f: ReturnType<typeof strandedFixture>): Promise<string> {
  const run = await f.start();
  f.ref.runId = run.runId;
  expect(await f.service.drive(run.runId, signal())).toMatchObject({ status: "waiting" });
  await f.approve(run.runId);
  expect(await f.service.drive(run.runId, signal())).toMatchObject({
    status: "blocked",
    reason: "invalid_output",
  });
  return run.runId;
}

const cli = (f: ReturnType<typeof strandedFixture>, argv: string[]) =>
  executeWorkflowCommand(f.service, parseWorkflowArgs(argv), signal()) as Promise<
    RunSnapshot & { recovery?: RecoveryAdvice; stopDetail?: string | null }
  >;

function expectAcceptanceAdvice(advice: RecoveryAdvice | undefined, runId: string): void {
  expect(advice).toBeDefined();
  const actions = advice?.remedies.map((r) => r.action) ?? [];
  expect(actions).toEqual(["fork", "revise", "cancel"]);
  expect(actions).not.toContain("reroute");
  expect(advice?.message).toContain("F-STRAND");
  expect(advice?.message).toContain(`baked workflow fork ${runId} --from-stage`);
  expect(advice?.summary).toContain("F-STRAND");
}

describe("scenario: R94 md-site 6b1daed3, an acceptance refusal carries its remedy (#2879)", () => {
  test("the first block names the open finding and offers fork, revise or cancel on every surface", async () => {
    const f = strandedFixture();
    const runId = await blockedAtAcceptance(f);
    const store = f.service.store;
    expect(acceptanceRefused(store, runId)).toBe(true);
    // The recorded advice, read by every surface.
    const advice = stopRecovery(store, runId);
    expectAcceptanceAdvice(advice, runId);
    expectRecovery(advice?.message ?? "", advice, "fork");
    // Headless CLI and the desktop through `baked serve` (GET /v1/workflow/runs/ID is `status`).
    const status = await cli(f, ["status", runId]);
    expectAcceptanceAdvice(status.recovery, runId);
    expect(status.stopDetail).toContain("Unresolved findings remain: F-STRAND (open)");
    expect(desktopRecoveryText(status.stopDetail ?? "", status.recovery)).toContain("F-STRAND");
    // The run view of the TUI.
    const view = readWorkflowView(f.service, runId);
    expectAcceptanceAdvice(view.details.recovery, runId);
    expect(tuiRecoveryText("", view.details.recovery)).toContain("press F to fork");
    expect(retryRefused(view.snapshot, view.details.recovery)).toBe(false);
    // The repeat guard's view (#2201) leads with switch model; this block does not.
    const actions = runActions(view.snapshot, null, "spare/model", false, view.details.recovery?.remedies ?? []);
    expect(actions[0]?.action).toBe("resume");
  });

  test("after a second block the advice is still the acceptance advice, not a model switch", async () => {
    const f = strandedFixture();
    const runId = await blockedAtAcceptance(f);
    const before = f.service.store.state(runId).prompt;
    // A plain resume is not refused by the repeat guard: acceptance decides again.
    await f.resume(runId);
    expect(await f.service.drive(runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
    // No model was told to correct a host predicate.
    expect(f.service.store.state(runId).prompt).toBe(before);
    await f.resume(runId);
    expect(await f.service.drive(runId, signal())).toMatchObject({ status: "blocked", reason: "invalid_output" });
    const status = await cli(f, ["status", runId]);
    expectAcceptanceAdvice(status.recovery, runId);
    expect(status.recovery?.message).not.toContain("reroute");
    const view = readWorkflowView(f.service, runId);
    expect(retryRefused(view.snapshot, view.details.recovery)).toBe(false);
    const actions = runActions(view.snapshot, null, "spare/model", false, view.details.recovery?.remedies ?? []);
    expect(actions[0]?.action).toBe("resume");
  });
});

describe("every acceptance predicate group refuses with a remedy that names its object (#2879)", () => {
  /** A finished run: acceptance holds, and each case breaks one predicate in memory or the store. */
  async function accepted() {
    const f = workflowFixture();
    cleanups.push(f.dispose);
    const run = await f.start();
    await f.service.drive(run.runId, signal());
    await f.approve(run.runId);
    expect(await f.service.drive(run.runId, signal())).toMatchObject({ status: "completed" });
    const store = f.service.store;
    const policy = PolicySchema.parse(JSON.parse(store.run(run.runId).policy_json));
    const refusal = (state = store.state(run.runId)): WorkflowFault => {
      try {
        assertAcceptance(store, run.runId, state, policy);
      } catch (error) {
        if (error instanceof WorkflowFault) return error;
        throw error;
      }
      throw new Error("acceptance held");
    };
    // The run as it is passes.
    expect(() => assertAcceptance(store, run.runId, store.state(run.runId), policy)).not.toThrow();
    return { f, store, runId: run.runId, refusal };
  }

  function expectRemedy(fault: WorkflowFault, object: string, first: string): RecoveryAdvice {
    const advice = errorRecovery(fault);
    expect(advice).toBeDefined();
    expect(fault.details.hostPredicate).toBe("acceptance");
    expect(advice?.message).toContain(object);
    expect(advice?.summary).toContain(object);
    expect(advice?.remedies[0]?.action).toBe(first as never);
    expect(advice?.remedies.map((r) => r.action)).not.toContain("reroute");
    return advice as RecoveryAdvice;
  }

  test("findings: the open finding's id, and a fork from the review", async () => {
    const { store, runId, refusal } = await accepted();
    store.addFinding(runId, { id: "F-OPEN" } as never, hashBytes("open finding"), "review");
    const advice = expectRemedy(refusal(), "F-OPEN", "fork");
    expect(advice.message).toContain(`baked workflow fork ${runId} --from-stage review`);
  });

  test("check: the required check's id, and a fork from the checks", async () => {
    const { store, runId, refusal } = await accepted();
    const state = store.state(runId);
    state.snapshotId = "snapshot-elsewhere";
    const advice = expectRemedy(refusal(state), "Required check check", "fork");
    expect(advice.message).toContain(`baked workflow fork ${runId} --from-stage checks`);
  });

  test("review: the inconclusive review, and a fork from the review", async () => {
    const { store, runId, refusal } = await accepted();
    const state = store.state(runId);
    const review = state.reviews.correctness;
    if (!review) throw new Error("no correctness review");
    state.reviews.correctness = { ...review, verdict: "inconclusive" };
    const advice = expectRemedy(refusal(state), "correctness review", "fork");
    expect(advice.message).toContain("inconclusive");
    expect(advice.message).toContain(`baked workflow fork ${runId} --from-stage review`);
  });

  test("task: the task that is not implemented", async () => {
    const { store, runId, refusal } = await accepted();
    store.taskStatus(runId, "T001", "blocked");
    expectRemedy(refusal(), "Task T001", "fork");
  });

  test("decision: the pending request and the command that answers it", async () => {
    const { store, runId, refusal } = await accepted();
    const requestId = store.request(runId, "clarification", "d".repeat(64), { questions: [] });
    const fault = refusal();
    expect(fault.code).toBe("STALE_DECISION");
    const advice = errorRecovery(fault);
    expect(fault.details.hostPredicate).toBe("acceptance");
    expect(advice?.summary).toContain(requestId);
    expect(advice?.message).toContain(`baked workflow answer ${runId} --request ${requestId}`);
    expect(advice?.remedies.map((r) => r.action)).not.toContain("reroute");
  });
});
