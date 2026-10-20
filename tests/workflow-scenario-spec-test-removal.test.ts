import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import type { Review } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R49, shexpand 2d6290c3 (#1628): a failed check's corrective added adapter tests;
// a spec review requested their removal, but the integrity guard demanded their restoration.
const path = "tests/linter_tests.rs";
const rust = (name: string, value: number) => `#[test]\nfn ${name}() {\n    assert_eq!(run(${value}), ${value});\n}\n`;
const retained = rust("retained", 1);
const adapters = ["lint_adapter_one", "lint_adapter_two", "lint_adapter_three"];
const added = adapters.map((name, i) => rust(name, i + 2)).join("\n");
type Mode = "names" | "pattern" | "silent" | "rename" | "delete" | "conflict" | "uncertain-conflict";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptedExecutor extends FixtureExecutor {
  store!: WorkflowStore;
  reviews = 0;
  corrections: string[][] = [];
  conflicted = false;
  constructor(private dir: string, private mode: Mode) { super(dir); }
  override async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { snapshotHash: string; extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    if (request.profile.output === "plan") {
      const response = await super.execute(request);
      const task = (response.output as { taskGraph: { tasks: Task[] } }).taskGraph.tasks[0]!;
      task.writes.push({ path, action: "create" });
      task.checkIds = ["tests-written"];
      return response;
    }
    if (request.profile.output === "implementation") {
      const task = request.task!;
      const file = join(this.dir, path);
      mkdirSync(join(this.dir, "tests"), { recursive: true });
      const base = this.mode === "delete" ? "" : retained;
      const conflicting = this.mode.endsWith("conflict");
      const findings = this.store.findings(request.runId).filter((f) => task.findingIds.includes(f.id)).map((f) => JSON.parse(f.body_json) as Review["findings"][number]);
      if (task.origin === "planned") {
        writeFileSync(join(this.dir, "value.txt"), "pending");
        writeFileSync(file, base);
      } else {
        this.corrections.push(findings.map((f) => f.claim));
        if (existsSync(file)) {
          const before = readFileSync(file, "utf8");
          this.store.artifact(request.runId, "pre-images", `pre-images/${hashBytes(before)}`, before);
        }
        if (findings.some((f) => f.claim.includes("required check tests-written failed"))) {
          writeFileSync(join(this.dir, "value.txt"), "ready");
          writeFileSync(file, base + added);
        } else if (findings.some((f) => f.claim.startsWith("Test integrity"))) {
          if (conflicting && !this.conflicted) {
            this.conflicted = true;
            // A resumed run can have a guard finding from before the spec's removal was known.
            const row = this.store.findings(request.runId).find((f) => f.id === "SPEC-OWNERSHIP")!;
            const spec = { ...(JSON.parse(row.body_json) as Review["findings"][number]), confidence: this.mode === "uncertain-conflict" ? 0.9 : 1, suggestedFix: `Remove ${adapters.join(", ")}` };
            const artifact = this.store.artifact(request.runId, "review", "reviews/updated-ownership.json", JSON.stringify(spec));
            this.store.addFinding(request.runId, spec, row.fingerprint, artifact.id);
            this.store.findingStatus(request.runId, spec.id, "resolved", row.repair_task_id);
            return { output: { schemaVersion: 1, taskId: task.id, outcome: "spec_conflict", summary: `SPEC-OWNERSHIP requests removal, but ${task.findingIds.join(", ")} requires restoration in ${path}`, evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
          }
          writeFileSync(file, conflicting ? base : base + added);
        } else if (this.mode === "delete") unlinkSync(file);
        else writeFileSync(file, this.mode === "rename" ? (base + added).replace("lint_adapter_one", "cli_adapter_one") : base);
      }
      return { output: { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Updated the adapter tests", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "review" && this.reviews++ === 0) {
      const suggestedFix = this.mode === "silent" || this.mode.endsWith("conflict") ? "Correct the scope of command verification" : this.mode === "delete" ? `Remove all tests from ${path}` : this.mode === "pattern" ? "Remove the lint_adapter_* tests" : `Remove ${adapters.join(", ")}`;
      return { output: { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation: "Wrong test ownership" }], findings: [{ id: "SPEC-OWNERSHIP", kind: "unrequested", severity: "high", basis: "spec", confidence: 1, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: path, symbol: null, evidenceIds, claim: "FR-001 assigns command tests to cli", impact: "Command tests are outside this module's scope", suggestedFix }] }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "refutation") return { output: { schemaVersion: 1, findingId: data.extra.finding?.id, decision: "confirmed", evidenceIds, explanation: "Confirmed the spec's ownership rule" }, inputTokens: 25, outputTokens: 25 };
    return super.execute(request);
  }
}

for (const mode of ["names", "pattern", "silent", "rename", "delete", "conflict", "uncertain-conflict"] as const) {
  test(`scenario: spec test removal ${mode} after a failed-check corrective (#1628)`, async () => {
    const policy = { ...fixturePolicy, checks: [...fixturePolicy.checks, { ...fixturePolicy.checks[0]!, id: "tests-written", scope: "task" as const }] };
    const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, mode) });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    executor.store = service.store;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    const claims = service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim);
    const guards = claims.filter((c) => c.startsWith("Test integrity"));
    expect(claims.some((c) => c.includes("required check tests-written failed"))).toBe(true);
    if (mode === "uncertain-conflict") {
      expect(guards.length).toBeGreaterThan(0);
      expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification" && r.status === "pending")).toHaveLength(1);
      expect((await service.get(run.runId)).status).toBe("waiting");
      return;
    }
    if (mode === "silent" || mode === "conflict") {
      expect(guards.some((c) => c.startsWith("Test integrity (test-removed)"))).toBe(true);
      if (mode === "conflict") {
        expect(executor.conflicted).toBe(true);
        expect(service.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("assumptions/conflicts/"))).toBe(true);
        expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toEqual([]);
      }
    }
    else {
      expect(guards).toEqual([]);
      expect(executor.corrections).toHaveLength(2);
      expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toEqual([]);
    }
    const file = join(fixture.root, path);
    if (mode === "delete") expect(existsSync(file)).toBe(false);
    else if (mode === "rename") expect(readFileSync(file, "utf8")).toContain("cli_adapter_one");
    else if (mode !== "silent") expect(readFileSync(file, "utf8")).toBe(retained);
    expect((await service.get(run.runId)).status).toBe("completed");
  }, 90_000);
}
