import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { rewriteTargets, scanTestIntegrity, strengthenTargets } from "../src/core/workflows/test-integrity.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 21 (#1069). url-shortener ded6fba8: review finding F003 (`contradicts`) said the
// test suite opened real network ports against AC-005's port-free rule. T012 rewrote the server
// test around an injected bootstrap (35 assertions to 33), the test-integrity guard blocked it as
// dropped assertions, and T013 spent 167k tokens adding one back. cfgtrace 424e275b: a ruff BLE001
// finding, three tests rewritten (66 to 60), another corrective of 426k tokens.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ported = 'it("serves the value", () => { const server = listen(0); expect(server.port).toBeGreaterThan(0); expect(get(server)).toBe("ready"); expect(read()).toBe("ready"); });\n';
const injected = 'it("serves the value", () => { const app = bootstrap({ listen: false }); expect(handle(app)).toBe("ready"); expect(read()).toBe("ready"); });\n';
const finding = (kind: string, claim: string, file = "value.test.ts") => ({ kind, file, claim, suggestedFix: "Rewrite value.test.ts around an injected bootstrap" });

test("the files a correction's finding asks to rewrite", () => {
  expect([...rewriteTargets([finding("contradicts", "value.test.ts opens a real network port, contrary to AC-001's port-free rule")])]).toEqual(["value.test.ts"]);
  expect([...rewriteTargets([finding("correctness", "ruff BLE001: broad except in tests/test_watch.py", "tests/test_watch.py")])]).toEqual(["tests/test_watch.py"]);
  // A correctness finding without a lint rule, a source file and the guard's own finding do not qualify.
  expect([...rewriteTargets([finding("correctness", "value.test.ts asserts the wrong value")])]).toEqual([]);
  expect([...rewriteTargets([finding("contradicts", "server.ts opens a port", "server.ts")])]).toEqual([]);
  expect([...rewriteTargets([finding("contradicts", "Test integrity (assertions): task T001 assertions dropped")])]).toEqual([]);
});

test("a rewrite may drop assertions but not test cases, skips or every assertion", () => {
  const rewrites = new Set(["value.test.ts"]);
  const scan = (after: string) => scanTestIntegrity([{ path: "value.test.ts", before: ported, after }], { rewrites }).map((f) => f.rule);
  expect(scan(injected)).toEqual([]);
  expect(scanTestIntegrity([{ path: "value.test.ts", before: ported, after: injected }]).map((f) => f.rule)).toEqual(["assertions"]);
  expect(scan('it("serves the value", () => { bootstrap({ listen: false }); });\n')).toEqual(["assertions"]);
  expect(scan(injected.replace("it(", "it.skip("))).toEqual(["skip"]);
  expect(scan("// removed\n")).toEqual(["test-count", "assertions"]);
});

// Bench round 41 (#1481). fpbits front 6967cc3b: review finding F1 (`partial`) said the boundary
// tests only counted separators, checked the final row and a prefix. T012 replaced those checks
// with full expected outputs (24 assertions to 23); the guard flagged it and T013 spent 391k
// tokens adding one assertion back.
const loose = 'it("prints the table", () => { expect(out).toContain("1 | one"); expect(out).toContain("3 | three"); expect(out.split("\\n").length).toBe(4); });\n';
const strict = 'it("prints the table", () => { expect(out).toBe("1 | one\\n2 | two\\n3 | three\\n"); });\n';
const weakClaim = "The table regression omits the complete literal expected output: it only checks the first and last rows and counts lines";

test("the files a correction's finding says check too little", () => {
  expect([...strengthenTargets([finding("partial", weakClaim)])]).toEqual(["value.test.ts"]);
  expect([...strengthenTargets([finding("missing", "value.test.ts has no case for an empty table")])]).toEqual(["value.test.ts"]);
  expect([...strengthenTargets([finding("correctness", "value.test.ts only checks a prefix of the diagnostic")])]).toEqual(["value.test.ts"]);
  // A wrong expectation, a source file and the guard's own finding do not qualify.
  expect([...strengthenTargets([finding("correctness", "value.test.ts asserts the wrong value")])]).toEqual([]);
  expect([...strengthenTargets([finding("partial", weakClaim, "table.ts")])]).toEqual([]);
  expect([...strengthenTargets([finding("partial", "Test integrity (assertions): task T001 assertions dropped")])]).toEqual([]);
});

test("a strengthened test may merge assertions but must hold more expected text", () => {
  const scan = (after: string, strengthens = ["value.test.ts"]) => scanTestIntegrity([{ path: "value.test.ts", before: loose, after }], { strengthens: new Set(strengthens) }).map((f) => f.rule);
  expect(scan(strict)).toEqual([]);
  // Without the finding, or with the finding on another file, the drop is flagged.
  expect(scan(strict, [])).toEqual(["assertions"]);
  expect(scan(strict, ["other.test.ts"])).toEqual(["assertions"]);
  // Fewer assertions and less expected text is weaker, not stronger.
  expect(scan('it("prints the table", () => { expect(out).toContain("1 | one"); });\n')).toEqual(["assertions"]);
  expect(scan(strict.replace("it(", "it.skip("))).toEqual(["skip"]);
  expect(scan("// removed\n")).toEqual(["test-count", "assertions"]);
});

class RewriteExecutor extends FixtureExecutor {
  implementations = 0;
  reviews = 0;
  store: WorkflowStore | null = null;
  constructor(
    private dir: string,
    private mode: "rewrite" | "strengthen" = "rewrite",
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    switch (request.profile.output) {
      case "plan": {
        const result = await super.execute(request);
        (result.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]?.writes.push({ path: "value.test.ts", action: "create" });
        return result;
      }
      case "implementation": {
        this.implementations++;
        writeFileSync(join(this.dir, "value.txt"), "ready");
        const path = join(this.dir, "value.test.ts");
        if (request.task?.origin !== "planned") {
          // Keep the earlier content, as the edit tools do, so the guard compares the counts.
          const before = readFileSync(path, "utf8");
          this.store?.artifact(request.runId, "pre-images", `pre-images/${hashBytes(before)}`, before);
        }
        const [planned, corrected] = this.mode === "rewrite" ? [ported, injected] : [loose, strict];
        writeFileSync(path, request.task?.origin === "planned" ? planned : corrected);
        return { output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
      }
      case "review": {
        this.reviews++;
        if (this.reviews > 1) return super.execute(request);
        const raised = this.mode === "strengthen" ? { id: "F1", kind: "partial", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.test.ts", symbol: null, evidenceIds, claim: weakClaim, impact: "A wrong middle row passes", suggestedFix: "Compare the whole output with the complete expected literal" } : { id: "F003", kind: "contradicts", severity: "high", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.test.ts", symbol: null, evidenceIds, claim: "value.test.ts opens a real network port, contrary to AC-001's port-free rule", impact: "The suite needs a free port", suggestedFix: "Rewrite the server test in value.test.ts around an injected bootstrap that opens no port" };
        return { output: { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "The test opens a port" }], findings: [raised] }, inputTokens: 25, outputTokens: 25 };
      }
      case "refutation":
        return { output: { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds, explanation: "The test listens on a port" }, inputTokens: 25, outputTokens: 25 };
      default:
        return super.execute(request);
    }
  }
}

test("the correction that rewrites the test the finding names passes without another corrective", async () => {
  const fixture = workflowFixture({ executor: (root) => new RewriteExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  executor.store = service.store;
  const run = await fixture.start();
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  expect(claims.filter((c) => c.startsWith("Test integrity"))).toEqual([]);
  expect(executor.implementations).toBe(2);
  expect((await service.get(run.runId)).status).toBe("completed");
});

test("the correction that strengthens the test the finding names passes without another corrective", async () => {
  const fixture = workflowFixture({ executor: (root) => new RewriteExecutor(root, "strengthen") });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  executor.store = service.store;
  const run = await fixture.start();
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
  expect(claims.filter((c) => c.startsWith("Test integrity"))).toEqual([]);
  expect(executor.implementations).toBe(2);
  expect((await service.get(run.runId)).status).toBe("completed");
});
