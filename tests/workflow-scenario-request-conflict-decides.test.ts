import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Audit of 2026-10-17 (#1407), sibling of #1384. Under clarification assume, a corrective task whose
// finding demands what the request contradicts reports spec_conflict naming the request side. The
// request wins, but the task's findings stayed undecided: the retry implements the request, the
// repro still reproduces, and the second conflict report asked a person in an assume run.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policy: RunPolicy = {
  ...fixturePolicy,
  clarification: "assume",
  checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "const v = await Bun.file('value.txt').text(); if (v !== 'ready') process.exit(1)"] }],
};
// The finding's repro expects the value the request rules out; the code prints what the request states.
const repro = { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "literal", actual: "ready" };
const CONFLICT =
  "Finding literal demands the literal value, but the request states that value.txt holds ready. The finding contradicts the request.";

class RequestConflict extends FixtureExecutor {
  corrections: string[] = [];
  reviews = 0;
  override async execute(request: ExecutionRequest) {
    const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    if (request.profile.output === "refutation")
      return { output: { schemaVersion: 1, findingId: context.extra.finding?.id, decision: "confirmed", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], explanation: "The repro prints ready" }, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
      this.calls.push("implementation");
      this.corrections.push(request.prompt);
      const base = { schemaVersion: 1, taskId: request.task?.id, evidenceIds: [], unresolved: [] as string[] };
      if (this.corrections.length === 1)
        return { output: { ...base, outcome: "spec_conflict", summary: CONFLICT, unresolved: ["Keep ready, or write the literal value?"] }, inputTokens: 25, outputTokens: 25 };
      return { output: { ...base, outcome: "already_satisfied", summary: "value.txt holds ready, as the request states", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" && this.reviews++ === 0)
      result.output = {
        ...ReviewSchema.parse(result.output),
        verdict: "changes_requested",
        findings: [{ id: "literal", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: "value.txt does not hold the literal value", impact: "Wrong value", suggestedFix: "Write the literal value", repro }],
      };
    return result;
  }
}

describe("scenario: a corrective whose finding contradicts the request, under assume (#1407)", () => {
  test("the request wins, the decision frees the finding's repro, and nobody is asked", async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new RequestConflict(root) });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toHaveLength(0);
    expect(done.status).toBe("completed");
    expect(executor.corrections).toHaveLength(2);
    expect(executor.corrections[1]).toContain("The request is authoritative");
    expect(executor.corrections[1]).toContain("no longer gate the task");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    const decisions = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("decisions/clarification-assumed-"));
    expect(decisions).toHaveLength(1);
    expect(service.store.readArtifact(run.runId, decisions[0]!.id)).toContain("The request is authoritative");
  }, 90_000);
});
