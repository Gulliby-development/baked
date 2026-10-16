import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 35, url-shortener 651b2693 T009 (#1350). A corrective task met a host
// repro that contradicts the spec and asked which side is right. The person answered "the repro
// is wrong, keep the implementation"; the repro still gated the task, so it changed nothing,
// reported the conflict again, and the host asked the same question twice more (0.95M tokens).

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "const v = await Bun.file('value.txt').text(); if (v !== 'ready') process.exit(1)"] }],
};
// The repro expects what the spec's literal wording says; the person decides the code is right.
const repro = { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "literal", actual: "ready" };
const answer = "The host repro is wrong for this input: the implementation is right. Keep it as it is.";

/** The first review finds a defect with a repro; the correction reports a spec conflict, twice. */
class ConflictedCorrection extends FixtureExecutor {
  corrections = 0;
  reviews = 0;
  override async execute(request: ExecutionRequest) {
    const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    if (request.profile.output === "refutation")
      return { output: { schemaVersion: 1, findingId: context.extra.finding?.id, decision: "confirmed", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], explanation: "The repro prints ready" }, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
      this.calls.push("implementation");
      this.corrections++;
      const base = { schemaVersion: 1, taskId: request.task?.id, evidenceIds: [], unresolved: [] as string[] };
      if (this.corrections <= 2)
        return { output: { ...base, outcome: "spec_conflict", summary: "The repro demands the literal value while the spec's check demands ready", unresolved: ["Which one is right?"] }, inputTokens: 25, outputTokens: 25 };
      return { output: { ...base, outcome: "already_satisfied", summary: "Kept the implementation as the answer says", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" && this.reviews++ === 0)
      result.output = {
        ...ReviewSchema.parse(result.output),
        verdict: "changes_requested",
        findings: [{ id: "literal", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: "The value is not the literal one", impact: "Wrong value", suggestedFix: "Write literal", repro }],
      };
    return result;
  }
}

describe("scenario: url-shortener T009, an answered spec conflict asked three times (#1350)", () => {
  test("the answer decides the task's findings and the same conflict is not asked again", async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new ConflictedCorrection(root) });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    let current = await service.drive(run.runId, new AbortController().signal);
    const asked = () => service.store.requests(run.runId).filter((r) => r.kind === "clarification");
    for (let round = 0; round < 4 && current.status !== "completed"; round++) {
      const pending = asked().find((r) => r.status === "pending");
      if (!pending) break;
      const question = (JSON.parse(pending.body_json) as { questions: { id: string }[] }).questions[0]!.id;
      expect(question).toStartWith("SPEC-CONFLICT-");
      await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: pending.id, answers: { [question]: answer } });
      current = await service.drive(run.runId, new AbortController().signal);
    }
    expect(current.status).toBe("completed");
    expect(asked()).toHaveLength(1);
    expect(executor.corrections).toBe(3);
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    const decisions = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("decisions/clarification-"));
    expect(decisions).toHaveLength(1);
    const decision = JSON.parse(service.store.readArtifact(run.runId, decisions[0]!.id)) as { findingIds: string[]; answer: string };
    expect(decision.findingIds.length).toBe(1);
    expect(decision.answer).toContain("Keep it as it is");
  }, 90_000);
});
