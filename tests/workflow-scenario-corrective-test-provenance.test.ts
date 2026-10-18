import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { settledConflicts } from "../src/core/workflows/conflict-decisions.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 43, intsmith arithmetic ca6f3023 (#1519): T011 corrected F1 by adding the
// width-10000 prime-interval test, T012 corrected F2 in another file with every file of the
// feature in scope and replaced that test with a scalar one. The totals stayed level, so the
// guard only saw one assertion fewer; T013 added `assert is_prime(...)` back and convergence
// raised F1 again (2.0M tokens of correctives).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const scalar = 'test("scalar cases", () => {\n  expect(read()).toBe("ready");\n});\n';
const interval = 'test("interval workload", () => {\n  expect(primes(10000)).toBe(1229);\n});\n';
const literal = 'test("literal cases", () => {\n  expect(primes(10)).toBe(4);\n});\n';

class ProvenanceExecutor extends FixtureExecutor {
  store: WorkflowStore | null = null;
  reviews = 0;
  /** The claims of the findings each correction corrected, in order. */
  corrections: string[][] = [];
  reviewExtras: Record<string, unknown>[] = [];
  constructor(private dir: string) {
    super(dir);
  }
  private keep(runId: string, path: string) {
    if (!existsSync(path)) return;
    // Keep the earlier content, as the edit tools do, so the guard compares before and after.
    const before = readFileSync(path, "utf8");
    this.store?.artifact(runId, "pre-images", `pre-images/${hashBytes(before)}`, before);
  }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const test = join(this.dir, "value.test.ts");
    switch (request.profile.output) {
      case "plan": {
        const result = await super.execute(request);
        (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: "value.test.ts", action: "create" });
        return result;
      }
      case "implementation": {
        const task = request.task;
        if (task?.origin === "planned") {
          writeFileSync(join(this.dir, "value.txt"), "ready");
          writeFileSync(test, scalar);
        } else {
          const claims = (this.store?.findings(request.runId) ?? [])
            .filter((f) => task?.findingIds.includes(f.id))
            .map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
          this.corrections.push(claims);
          this.keep(request.runId, test);
          const current = readFileSync(test, "utf8");
          if (claims.some((c) => c.includes("interval workload test"))) writeFileSync(test, current + interval);
          else if (claims.some((c) => c.startsWith("Test integrity"))) writeFileSync(test, scalar + interval + literal);
          else {
            // The correction of F2: in scope for every file, it swaps the interval test.
            writeFileSync(join(this.dir, "value.txt"), "ready");
            writeFileSync(test, current.replace(interval, literal));
          }
        }
        return { output: { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
      }
      case "review": {
        this.reviews++;
        this.reviewExtras.push(data.extra);
        if (this.reviews > 1) return super.execute(request);
        const finding = (id: string, file: string, claim: string) => ({ id, kind: "missing", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file, symbol: null, evidenceIds, claim, impact: "AC-001 is not verified", suggestedFix: claim });
        return {
          output: {
            schemaVersion: 1,
            snapshotHash: data.snapshotHash,
            verdict: "changes_requested",
            coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Two gaps" }],
            findings: [finding("F1", "value.test.ts", "value.test.ts has no interval workload test for AC-001"), finding("F2", "value.txt", "value.txt lacks the trailing state AC-001 names")],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      case "refutation":
        return { output: { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds, explanation: "Confirmed" }, inputTokens: 25, outputTokens: 25 };
      default:
        return super.execute(request);
    }
  }
}

test("a correction of another finding may not swap out the test a sibling correction added", async () => {
  const fixture = workflowFixture({ executor: (root) => new ProvenanceExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  executor.store = service.store;
  const run = await fixture.start();
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  const guard = claims.filter((c) => c.startsWith("Test integrity"));
  expect(guard).toHaveLength(1);
  expect(guard[0]).toContain("Test integrity (test-removed)");
  expect(guard[0]).toContain('removed test "interval workload", which');
  // The guard's correction restored the interval test; the final suite holds both findings' tests.
  expect(readFileSync(join(fixture.root, "value.test.ts"), "utf8")).toContain("interval workload");
  expect(executor.corrections.at(-1)?.[0]).toStartWith("Test integrity (test-removed)");
  expect((await service.get(run.runId)).status).toBe("completed");
});

test("reviewers get the conflicts the run settled", async () => {
  const fixture = workflowFixture({ executor: (root) => new ProvenanceExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  executor.store = service.store;
  const run = await fixture.start();
  await service.drive(run.runId, new AbortController().signal);
  const assumed = { taskId: "T004", summary: "A full interval needs a loop, which the request forbids", unresolved: [], assumed: "The approved spec and the request win over tests/test_primes.py, which this run wrote" };
  service.store.artifact(run.runId, "assumption", "assumptions/conflicts/T004.json", JSON.stringify(assumed));
  expect(settledConflicts(service.store, run.runId)).toEqual([{ path: "assumptions/conflicts/T004.json", taskId: "T004", settled: assumed.assumed, report: assumed.summary }]);
  await fixture.approve(run.runId);
  await service.drive(run.runId, new AbortController().signal);
  expect(executor.reviewExtras[0]?.settledConflicts).toEqual(settledConflicts(service.store, run.runId));
});

test("the reviewer and the spec auditor rank settled conflicts above a suggested fix", async () => {
  const { builtinProfiles } = await import("../src/core/agents/profiles/builtin.js");
  for (const id of ["reviewer", "spec-auditor"]) {
    const text = builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect(text).toContain("extra.settledConflicts");
    expect(text).toContain("A rule the request states and a settled conflict outrank a suggested fix");
  }
});
