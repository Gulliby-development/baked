import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { carriesOver, changedSince, inReviewScope } from "../src/core/workflows/re-review.js";
import { loopSharesFrom } from "../src/core/workflows/sizing.js";
import { type Review, ReviewSchema } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const passed = (findings: Review["findings"] = []): Review =>
  ({
    schemaVersion: 1,
    snapshotHash: "a".repeat(64),
    verdict: findings.length ? "changes_requested" : "pass",
    coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: [], explanation: "ok" }],
    findings,
  }) as Review;

describe("re-review scope", () => {
  test("changed paths are those whose hash differs, appears or disappears", () => {
    expect(changedSince({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" })).toEqual(["b", "c", "d"]);
  });

  test("each dimension looks at its own files", () => {
    expect(inReviewScope("language", "src/main.go")).toBe(true);
    expect(inReviewScope("language", "README.md")).toBe(false);
    expect(inReviewScope("security", "src/auth/login.ts")).toBe(true);
    expect(inReviewScope("security", "value.txt")).toBe(false);
    expect(inReviewScope("correctness", "README.md")).toBe(true);
  });

  test("only a clean pass with no change in scope carries over", () => {
    expect(carriesOver("language", passed(), ["README.md"])).toBe(true);
    expect(carriesOver("language", passed(), ["src/main.go"])).toBe(false);
    expect(carriesOver("correctness", passed(), ["README.md"])).toBe(false);
    const open = { ...passed(), coverage: [{ criterionId: "AC-001", verdict: "inconclusive", evidenceIds: [], explanation: "?" }] } as Review;
    expect(carriesOver("language", open, [])).toBe(false);
  });
});

describe("a review round after a correction", () => {
  const fixtures: ReturnType<typeof workflowFixture>[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });

  test("keeps a passed dimension whose files did not change and briefs the one that runs again", async () => {
    // The check accepts a trailing newline, so the repair task can change the file.
    const checks = fixturePolicy.checks.map((c) => ({
      ...c,
      args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"],
    }));
    const fixture = workflowFixture({ policy: { ...fixturePolicy, checks, forceSecurityReview: true } });
    fixtures.push(fixture);
    const { executor, service } = fixture;
    const reviews: { dimension: string; extra: Record<string, unknown> }[] = [];
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "refutation") {
        const extra = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}").extra;
        return {
          output: { schemaVersion: 1, findingId: extra.finding.id, decision: "confirmed", evidenceIds: extra.evidence.map((e: { id: string }) => e.id), explanation: "Holds" },
          inputTokens: 20,
          outputTokens: 30,
        };
      }
      const result = await original(request);
      if (request.task?.id === "T002") writeFileSync(join(fixture.root, "value.txt"), "ready\n");
      if (request.profile.output !== "review") return result;
      const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
        extra: { dimension: string; evidence: { id: string }[] } & Record<string, unknown>;
      };
      reviews.push({ dimension: context.extra.dimension, extra: context.extra });
      const first = reviews.filter((r) => r.dimension === "correctness").length === 1;
      if (context.extra.dimension === "correctness" && first)
        result.output = {
          ...ReviewSchema.parse(result.output),
          verdict: "changes_requested",
          findings: [
            {
              id: "F1",
              kind: "missing",
              severity: "high",
              requirementIds: ["FR-001"],
              criterionIds: ["AC-001"],
              file: "value.txt",
              symbol: null,
              evidenceIds: context.extra.evidence.map((e) => e.id),
              claim: "The value lacks a newline",
              impact: "Contract",
              suggestedFix: "Add it",
            },
          ],
        };
      return result;
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const final = await service.drive(run.runId, new AbortController().signal);
    expect(final.status).toBe("completed");
    expect(service.store.run(run.runId).repair_rounds).toBe(1);
    // Round one ran both dimensions; round two ran correctness only.
    expect(reviews.map((r) => r.dimension).sort()).toEqual(["correctness", "correctness", "security"]);
    const rerun = reviews.filter((r) => r.dimension === "correctness")[1]?.extra.previousRound as {
      findings: { id: string }[];
      changedFiles: string[];
    };
    expect(rerun.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(rerun.changedFiles).toEqual(["value.txt"]);
    expect(String((rerun as { correctionPatch?: string }).correctionPatch)).toContain("value.txt");
    expect(
      service.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("reviews/carried-security-")),
    ).toBe(true);
    // The repair round is the run's loop: a share of its first pass that sizing calibrates from.
    const shares = loopSharesFrom(join(fixture.root, ".baked", "workflows.sqlite"));
    expect(shares).toHaveLength(1);
    expect(shares[0]).toBeGreaterThan(0);
  }, 30000);
});
