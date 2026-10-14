import { afterEach, describe, expect, test } from "bun:test";
import type { Review, RunPolicy, Task } from "../src/core/workflows/schemas.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 19, expenses-py e0c0447d (#1033). One defect in expenses/report.py was
// reported by several test tasks; the same finding was recorded four times and each report opened
// its own corrective task. Two of them ran after another correction had already fixed the file and
// ended `already_satisfied` for 110k and 140k tokens; two more were still pending.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scenario: expenses-py e0c0447d, one defect and four corrective tasks (#1033)", () => {
  /** A completed fixture run and the scheduler's private steps this scenario drives. */
  async function completed() {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    const state = service.store.state(run.runId);
    const policy = JSON.parse(service.store.run(run.runId).policy_json) as RunPolicy;
    const scheduler = service.scheduler as unknown as {
      recordFindings(runId: string, review: Review): Review["findings"];
      repair(...args: unknown[]): void;
      implementTask(...args: unknown[]): Promise<void>;
    };
    const record = (finding: Partial<Review["findings"][number]>) =>
      scheduler.recordFindings(run.runId, {
        schemaVersion: 1,
        snapshotHash: state.workspaceHash ?? "",
        verdict: "changes_requested",
        coverage: [],
        findings: [{ id: "new", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: ["E1"], claim: "The value is wrong", impact: "The report is wrong", suggestedFix: "Fix the report", ...finding }],
      });
    const corrections = () =>
      service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as Task).filter((t) => t.origin !== "planned");
    return { fixture, service, run, state, policy, scheduler, record, corrections };
  }

  test("a correction whose failing check passes once the files changed runs no worker", async () => {
    const { fixture, service, run, state, policy, scheduler, record, corrections } = await completed();
    // The check failed on files that have changed since and passes on the current files, as when
    // another correction fixed the cause first.
    const failed = service.store.transaction(() => {
      const earlier = service.store.putSnapshot(run.runId, { "value.txt": "broken" }).id;
      const output = service.store.artifact(run.runId, "diagnostic", "checks/earlier.json", "{}");
      return { id: service.store.addEvidence(run.runId, "command", earlier, output.id) };
    });
    scheduler.repair(run.runId, state, policy, record({ claim: "Required check check failed", evidenceIds: [failed.id] }), "repair", "task");
    const [correction] = corrections();
    if (!correction) throw new Error("no correction");
    const profiles = JSON.parse(service.store.run(run.runId).profiles_json) as unknown[];
    const step = service.store.beginStep(run.runId, "implement-again", null);
    const before = fixture.executor.calls.filter((c) => c === "implementation").length;
    await scheduler.implementTask(run.runId, step, state, policy, profiles, new AbortController().signal, correction, false);
    expect(fixture.executor.calls.filter((c) => c === "implementation")).toHaveLength(before);
    expect(service.store.tasks(run.runId).find((t) => t.id === correction.id)?.status).toBe("implemented");
    expect(service.store.latestArtifact(run.runId, `tasks/${correction.id}/already-passing.json`)).toBeTruthy();
  });

  test("a finding reported again while its correction waits gets no second correction", async () => {
    const { run, state, policy, scheduler, record, corrections } = await completed();
    // Three test tasks report the same defect; the same finding id comes back each time.
    for (let i = 0; i < 3; i++)
      scheduler.repair(run.runId, state, policy, record({ symbol: "format_table", claim: "An empty report crashes format_table" }), "repair", "task");
    expect(corrections()).toHaveLength(1);
    // Another defect still gets its own correction.
    scheduler.repair(run.runId, state, policy, record({ symbol: "totals", claim: "Totals ignore refunds" }), "repair", "task");
    expect(corrections()).toHaveLength(2);
  });
});
