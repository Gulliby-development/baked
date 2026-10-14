import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 24, stmtsplit-update T007/T008 (#1158). The review reproduced a defect
// with its repro; the corrective task changed nothing, reported already_satisfied, and the host
// accepted it, so the next review found the same defect and the next correction closed it the
// same way: 546k tokens with the repro still reproducing.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [
    {
      ...fixturePolicy.checks[0]!,
      args: ["-e", "const v = await Bun.file('value.txt').text(); if (v !== 'ready' && v !== 'fixed') process.exit(1)"],
    },
  ],
};
const repro = { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "fixed", actual: "ready" };

/** Reviews find the value unfixed while it is; a correction first claims it is already fixed. */
class ClaimsSatisfied extends FixtureExecutor {
  corrections = 0;
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    if (request.profile.output === "refutation")
      return { output: { schemaVersion: 1, findingId: context.extra.finding?.id, decision: "confirmed", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], explanation: "The repro prints ready" }, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
      this.calls.push("implementation");
      this.corrections++;
      if (this.corrections === 1)
        return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "already_satisfied", summary: "The value is already correct", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
      writeFileSync(join(this.dir, "value.txt"), "fixed");
      return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Fixed the value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" && readFileSync(join(this.dir, "value.txt"), "utf8") === "ready")
      result.output = {
        ...ReviewSchema.parse(result.output),
        verdict: "changes_requested",
        findings: [{ id: "unfixed", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: "The value is not fixed", impact: "Wrong value", suggestedFix: "Write fixed", repro }],
      };
    return result;
  }
}

describe("scenario: stmtsplit-update T007/T008, already_satisfied with a live repro (#1158)", () => {
  test("a correction that claims its reproduced finding is fixed is refused while the repro still shows it", async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new ClaimsSatisfied(root) });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const finished = await service.drive(run.runId, new AbortController().signal);
    expect(finished.status).toBe("completed");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("fixed");
    expect(executor.corrections).toBe(2);
    // The refusal keeps the correction in its task: no further review finds the same defect.
    expect(executor.calls.filter((call) => call === "review")).toHaveLength(2);
    const checks = service.store.artifacts(run.runId).filter((a) => /^tasks\/[^/]+\/repro-check-/.test(a.logical_path));
    expect(checks.length).toBeGreaterThan(0);
    const first = JSON.parse(service.store.readArtifact(run.runId, checks[0]!.id)) as { outcomes: { status: string }[] };
    expect(first.outcomes[0]?.status).toBe("reproduced");
  });
});
