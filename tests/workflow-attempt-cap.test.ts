import { afterEach, describe, expect, test } from "bun:test";
import { headline, runActions } from "../src/components/workflow/format.js";
import { attemptCapFault } from "../src/core/workflows/agent-executor.js";
import { attentionMessage } from "../src/core/workflows/attention-notify.js";
import { reasonText } from "../src/core/workflows/reasons.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The first implementation attempt runs out of its token cap without submitting, as md-site 00ae0ac0 did. */
class CappedOnce extends FixtureExecutor {
  capped = false;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation" && !this.capped) {
      this.capped = true;
      this.calls.push("implementation");
      throw attemptCapFault(request.profile.id, 374_264, 374_264);
    }
    return super.execute(request);
  }
}

async function driveUntilStopped(fixture: ReturnType<typeof workflowFixture>, runId: string) {
  for (let i = 0; i < 12; i++) {
    const run = await fixture.service.get(runId);
    if (run.status === "blocked" || run.status === "completed") return run;
    if (run.pendingRequestIds.length) await fixture.approve(runId);
    else if (run.status === "paused" || run.status === "created") await fixture.resume(runId);
    await fixture.service.drive(runId, new AbortController().signal);
  }
  return fixture.service.get(runId);
}

describe("an attempt stopped at its token cap (#935)", () => {
  test("blocks with attempt_cap, refuses an extension with the way out, and a resume finishes the task", async () => {
    const fixture = workflowFixture({ executor: (root) => new CappedOnce(root) });
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    const blocked = await driveUntilStopped(fixture, run.runId);
    // The run budget is far from used up: the stop is the attempt's cap, not budget_exhausted.
    expect(blocked).toMatchObject({ status: "blocked", reason: "attempt_cap" });
    expect(reasonText(blocked.reason)).toContain("resuming continues the task");
    expect(attentionMessage({ kind: blocked.reason, request_id: null })).toBe("Blocked: needs a resume");
    const view = headline(blocked, [], false);
    expect(view.next).toContain("Press R to retry");
    expect(runActions(blocked).map((a) => a.key)).toContain("R");
    expect(runActions(blocked).map((a) => a.key)).not.toContain("B");

    await expect(
      service.extendBudget(run.runId, { commandId: newId(), expectedRevision: blocked.revision }, { maxTotalTokens: 3_000_000 }),
    ).rejects.toThrow("attempt's token cap, not on its budget: resume it");

    await fixture.resume(run.runId);
    const done = await driveUntilStopped(fixture, run.runId);
    expect(done.status).toBe("completed");
    expect(fixture.executor.calls.filter((c) => c === "implementation")).toHaveLength(2);
  });
});
