import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { carriesOver, changedSince, inReviewScope, onlyRepeatsNotes } from "../src/core/workflows/re-review.js";
import { loopSharesFrom } from "../src/core/workflows/sizing.js";
import { type Review, ReviewSchema } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, ReviewNote } from "../src/core/workflows/types.js";
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

  test("a clean pass with no change in scope carries over", () => {
    const prior = (review: Review) => ({ review, snapshotId: "S1" });
    expect(carriesOver("language", prior(passed()), ["README.md"], [])).toBe(true);
    expect(carriesOver("language", prior(passed()), ["src/main.go"], [])).toBe(false);
    expect(carriesOver("correctness", prior(passed()), ["README.md"], [])).toBe(false);
    const open = { ...passed(), coverage: [{ criterionId: "AC-001", verdict: "inconclusive", evidenceIds: [], explanation: "?" }] } as Review;
    expect(carriesOver("language", prior(open), [], [])).toBe(false);
  });

  test("a review that only repeated its notes carries over whatever changed", () => {
    const finding = { id: "LANG-001", kind: "correctness", severity: "low", file: "cli.go", symbol: "Run" } as Review["findings"][number];
    const review = { ...passed([finding]), verdict: "pass" } as Review;
    const note = (snapshotId: string, repeatOf: string | null) =>
      ({ findingId: "LANG-001", source: "language", snapshotId, repeatOf }) as ReviewNote;
    const prior = { review, snapshotId: "S2" };
    // Raised for the first time in S2: it runs again after the correction.
    expect(onlyRepeatsNotes("language", prior, [note("S2", null)])).toBe(false);
    expect(carriesOver("language", prior, ["cli.go"], [note("S2", null)])).toBe(false);
    // Raised again in S2 after S1: nothing new, so it stands.
    const notes = [note("S1", null), note("S2", "LANG-001")];
    expect(carriesOver("language", prior, ["cli.go"], notes)).toBe(true);
    // A finding that started a correction has no note, so the dimension checks the fix.
    const second = { ...finding, id: "LANG-002" };
    expect(carriesOver("language", { review: { ...review, findings: [finding, second] }, snapshotId: "S2" }, ["cli.go"], notes)).toBe(false);
    expect(carriesOver("language", { review, snapshotId: null }, ["cli.go"], notes)).toBe(false);
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
    expect(service.store.run(run.runId).review_rounds).toBe(1);
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
  test("stops re-running a dimension once it only repeats its notes (#1016)", async () => {
    const checks = fixturePolicy.checks.map((c) => ({
      ...c,
      args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"],
    }));
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, checks, forceSecurityReview: true },
    });
    fixtures.push(fixture);
    const { executor, service } = fixture;
    const reviews: string[] = [];
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
      // Each correction changes the value file, so every dimension sees a change in its files.
      if (request.task?.id === "T002") writeFileSync(join(fixture.root, "value.txt"), "ready\n");
      if (request.task?.id === "T003") writeFileSync(join(fixture.root, "value.txt"), "ready\n\n");
      if (request.profile.output !== "review") return result;
      const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
        extra: { dimension: string; evidence: { id: string }[] };
      };
      const { dimension, evidence } = context.extra;
      reviews.push(dimension);
      const round = reviews.filter((d) => d === dimension).length;
      const base = {
        requirementIds: ["FR-001"],
        criterionIds: ["AC-001"],
        file: "value.txt",
        evidenceIds: evidence.map((e) => e.id),
        impact: "Contract",
        suggestedFix: "Fix it",
      };
      const review = ReviewSchema.parse(result.output);
      // Correctness finds a new defect in its first two rounds; security raises the same
      // unsure finding every round, which starts no correction.
      if (dimension === "correctness" && round <= 2)
        result.output = {
          ...review,
          verdict: "changes_requested",
          findings: [{ ...base, id: `F${round}`, kind: "missing", severity: "high", symbol: `step${round}`, claim: `Defect ${round}` }],
        };
      if (dimension === "security")
        result.output = {
          ...review,
          findings: [{ ...base, id: "S1", kind: "security", severity: "low", confidence: 0.1, symbol: "value", claim: "The value file is world readable" }],
        };
      return result;
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const final = await service.drive(run.runId, new AbortController().signal);
    expect(final.status).toBe("completed");
    expect(service.store.run(run.runId).review_rounds).toBe(2);
    // Security raised a new note in round one and only repeated it after the first correction;
    // after the second correction its review stands.
    expect(reviews.filter((d) => d === "correctness")).toHaveLength(3);
    expect(reviews.filter((d) => d === "security")).toHaveLength(2);
    expect(
      service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("reviews/carried-security-")),
    ).toHaveLength(1);
  }, 30000);
});
