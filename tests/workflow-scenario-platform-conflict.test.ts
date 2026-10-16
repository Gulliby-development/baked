import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { namesPlatformLimit } from "../src/core/workflows/analysis-notes.js";
import { ReviewSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 38, url-shortener 0cf3a1af T009 (#1384). Under clarification assume, a
// finding demanded the literal Unicode Location header for an IDN URL, which an HTTP header cannot
// carry (Bun's Headers reject a value that is not a ByteString). The brief only says "redirect with
// 302 to the stored URL". The corrective reported the conflict and the run waited for a person;
// the detour cost about 4.0M of 8.9M tokens.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policy: RunPolicy = {
  ...fixturePolicy,
  clarification: "assume",
  checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "const v = await Bun.file('value.txt').text(); if (v !== 'ready') process.exit(1)"] }],
};
// The finding's repro expects the literal value; the code prints its serialized form.
const repro = { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "literal", actual: "ready" };
const PLATFORM =
  "AC-005 demands the exact stored Unicode Location, but HTTP headers cannot carry non-ASCII bytes: Bun's Headers reject the value as not a ByteString (platform limit). Nearest feasible behavior: send the punycode host.";

class PlatformConflict extends FixtureExecutor {
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
        return { output: { ...base, outcome: "spec_conflict", summary: PLATFORM, unresolved: ["Allow the serialized form, or find another mechanism?"] }, inputTokens: 25, outputTokens: 25 };
      return { output: { ...base, outcome: "already_satisfied", summary: "The serialized form is what the platform can send", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" && this.reviews++ === 0)
      result.output = {
        ...ReviewSchema.parse(result.output),
        verdict: "changes_requested",
        findings: [{ id: "literal", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: "The Location is not the exact stored Unicode URL", impact: "Wrong header", suggestedFix: "Send the literal value", repro }],
      };
    return result;
  }
}

describe("scenario: url-shortener 0cf3a1af, a criterion against the platform under assume (#1384)", () => {
  test("the nearest feasible behavior is assumed and recorded, the repro stops gating, and nobody is asked", async () => {
    const fixture = workflowFixture({ policy, executor: (root) => new PlatformConflict(root) });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toHaveLength(0);
    expect(done.status).toBe("completed");
    expect(executor.corrections).toHaveLength(2);
    expect(executor.corrections[1]).toContain("platform cannot do what a criterion");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    const assumptions = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("assumptions/conflicts/"));
    expect(assumptions).toHaveLength(1);
    expect(service.store.readArtifact(run.runId, assumptions[0]!.id)).toContain("nearest feasible behavior");
  }, 90_000);
});

describe("a conflict report that names a platform limit", () => {
  test("is told apart from a conflict between the spec and a test", () => {
    expect(namesPlatformLimit(PLATFORM)).toBe(true);
    expect(namesPlatformLimit("The HTTP header cannot carry the literal IDN")).toBe(true);
    expect(namesPlatformLimit("The runtime does not accept a lone surrogate in a file name")).toBe(true);
    expect(namesPlatformLimit("The spec says 404 but tests/api.test.ts expects 400")).toBe(false);
    expect(namesPlatformLimit("The repro demands the literal value while the spec's check demands ready")).toBe(false);
  });
});
