import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { appendCorrections } from "../src/core/verification/convergence.js";
import { fingerprint } from "../src/core/verification/findings.js";
import { requestedDeliverable } from "../src/core/verification/deliverable-paths.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeSettings } from "../src/core/workflows/initiatives/store.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";
import { planStructureProblems } from "../src/core/workflows/initiatives/plan.js";
import { QUALITY_MUTATION, type MutationResult } from "../src/core/workflows/quality/mutation.js";

// R47 crossmill (#1590): adapters cannot finish because entry owns the acceptance-test file
// their review asks them to create. Reduce the stored initiative to those two features.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const policy: RunPolicy = { ...fixturePolicy, checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "0"] }] };
const finding = (file: string, evidenceIds: string[] = []): Review["findings"][number] => ({
  id: "F001", kind: "missing", severity: "medium", basis: "spec",
  requirementIds: ["FR-001"], criterionIds: ["AC-001"], file, symbol: null, evidenceIds,
  claim: "The required acceptance work has not been delivered",
  impact: "Acceptance work is missing", suggestedFix: `Deliver ${file}`,
});

class ScriptedExecutor implements AgentExecutor {
  corrections: Task[] = [];
  seenBounds: unknown[] = [];
  constructor(private file: string, private stage: "review" | "convergence", private shape: Partial<Review["findings"][number]> = {}, private mutation = false) {}
  async execute(request: ExecutionRequest) {
    const data = Object.assign({}, ...request.prompt.split("\n").slice(-2).map((line) => JSON.parse(line))) as {
      inputHash: string; snapshotHash: string; spec: Spec | null;
      extra: { featureId?: string; dimension?: string; initiativeBounds?: unknown; evidence?: { id: string }[] };
    };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const featureId = data.spec?.featureId ?? data.extra.featureId ?? "";
    const adapter = featureId.endsWith("_adapters");
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Two feature fixture", facts: [], unknowns: [], constraints: [], suggestedScope: [] }; break;
      case "spec": output = { ...fixtureSpec, featureId: data.extra.featureId }; break;
      case "plan": {
        const spec = data.spec!;
        const file = adapter ? (this.mutation ? "src/adapter.ts" : "adapter.txt") : this.file;
        const markdown = `# Plan\n## Context\nCreate ${file}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${file}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: `Create ${file}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: file, action: this.mutation && !adapter ? "modify" : "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "mutants": output = { schemaVersion: 1, mutants: [] }; break;
      case "implementation": {
        if (request.task?.origin !== "planned") this.corrections.push(request.task!);
        for (const write of request.task?.writes ?? []) {
          const file = join(request.root!, write.path);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, this.mutation
            ? (adapter ? "export function answer(value: number) { return value + 1; }\n" : 'import { expect, test } from "bun:test";\nimport { answer } from "../src/adapter";\ntest("answer", () => { expect(answer(2)).toBe(3); expect(answer(0)).toBe(1); });\n')
            : "ready");
        }
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote ready", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence": {
        this.seenBounds.push(data.extra.initiativeBounds);
        const raises = !this.mutation && adapter && request.profile.output === this.stage && (this.stage === "convergence" || data.extra.dimension === "correctness");
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: raises ? "changes_requested" : "pass", coverage: [{ criterionId: "AC-001", verdict: raises ? "fail" : "pass", evidenceIds, explanation: raises ? "Acceptance work belongs to entry" : "Checks pass" }], findings: raises ? [{ ...finding(this.file, evidenceIds), ...this.shape }] : [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function scenario(file: string, stage: "review" | "convergence", legacy = false, shape: Partial<Review["findings"][number]> = {}, mutation = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-sibling-owner-"));
  const executor = new ScriptedExecutor(file, stage, shape, mutation);
  if (mutation) {
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, file), 'import { test } from "bun:test"; test("placeholder", () => {});\n');
  }
  const runPolicy = mutation ? { ...policy, mutation: "required" as const, mutationEngine: "built-in" as const, mutationBudgetMs: 20000, checks: [{ ...policy.checks[0]!, args: ["test", file] }] } : policy;
  const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: runPolicy } }, executor);
  cleanups.push(async () => { await service.shutdown(); service.close(); await removeTempDir(root); });
  const initiatives = new InitiativeService(service);
  const split: InitiativePlan = { schemaVersion: 1, title: "Crossmill", goals: ["Adapters and entry work"], completionCriteria: ["All work delivered"], features: [
    { id: "adapters", title: "Adapters", boundary: { scope: "Command adapters", paths: [mutation ? "src/adapter.ts" : "adapter.txt"] }, contract: "Adapters are ready; entry delivers acceptance tests", dependsOn: [], mandatory: true, workflow: "sdd" },
    { id: "entry", title: "Entry", boundary: { scope: "Entry and integration acceptance", paths: [file] }, contract: "Entry is ready", dependsOn: ["adapters"], mandatory: true, workflow: "sdd" },
  ] };
  const settings: InitiativeSettings = { workflowId: "sdd", basePolicy: runPolicy, budget: null, costBudget: null, featureAutoApproval: null, autoApprovalConfirmation: null, model: null, ownerLabel: "test", featureIssues: {}, forecastStop: false, keepFeatures: true, splitCriticalPath: false, lightContracts: false };
  // Seed the reduced approved plan directly: proposing a new initiative requires three features,
  // which is unrelated to this ownership regression. Drive still uses real feature scheduling.
  initiatives.store.transaction(() => {
    initiatives.store.create({ id: "crossmill", title: split.title, prompt: "Build adapters and entry", status: "active", settings, decomposeRunId: null });
    const revision = initiatives.store.addRevision("crossmill", split, { maxTotalTokens: 2_000_000, maxAgentCalls: 200, maxActiveMs: 3_600_000 }, hashJson(split), "user", null);
    initiatives.store.approve("crossmill", revision, hashJson(split));
  });
  let recovered = false;
  for (let i = 0; i < 8; i++) {
    const view = await initiatives.drive("crossmill", new AbortController().signal);
    if (view.status === "completed") break;
    const adapterRun = initiatives.store.current("crossmill", "adapters");
    if (legacy && !recovered && adapterRun && service.store.run(adapterRun.run_id).reason === "input_changed") {
      const runId = adapterRun.run_id;
      expect(service.store.run(runId).status).toBe("blocked");
      const state = service.store.state(runId);
      state.initiativeBounds = null;
      service.store.transaction(() => {
        // Simulate the persisted state of the old binary, including its blocking finding.
        const findings = service.store.findings(runId);
        expect(findings.length).toBeGreaterThan(0);
        for (const finding of findings) service.store.findingStatus(runId, finding.id, "confirmed");
        service.store.saveState(runId, state);
      });
      await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision });
      recovered = true;
      continue;
    }
    const approvals = view.pendingDecisions.filter((d) => d.kind === "approval" && d.runId);
    if (!approvals.length) break;
    for (const approval of approvals) {
      const runId = approval.runId!;
      if (legacy && !recovered) {
        const state = service.store.state(runId);
        // Hide the sibling until review stops, reproducing a binary without ownership routing.
        if (state.initiativeBounds)
          state.initiativeBounds.features = state.initiativeBounds.features.filter((feature) => feature.id === "adapters");
        service.store.transaction(() => service.store.saveState(runId, state));
      }
      await service.decide(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { kind: "approve", requestId: approval.requestId, digest: approval.digest });
    }
  }
  if (legacy) expect(recovered).toBe(true);
  const runId = initiatives.store.current("crossmill", "adapters")!.run_id;
  return { root, executor, service, initiatives, runId };
}

describe("scenario: sibling-owned review findings do not deadlock an initiative (#1590)", () => {
  test("criterion coverage does not request tests, while code coverage does", () => {
    expect(requestedDeliverable({ kind: "missing", claim: "Criterion AC-001 has no coverage", suggestedFix: "Implement or demonstrate AC-001 within approved task scope and repeat checks." })).toBeNull();
    expect(requestedDeliverable({ kind: "missing", claim: "Code coverage is missing", suggestedFix: "Supply code coverage" })).toBe("test");
  });

  for (const mode of ["merge", "keep", "different-dependents"] as const) {
    test(`test ownership follows the proposed split: ${mode}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "baked-merged-test-owner-"));
      const split: InitiativePlan = { schemaVersion: 1, title: "Split", goals: ["Adapters work"], completionCriteria: ["All delivered"], features: [
        { id: "adapters", title: "Adapters", boundary: { scope: "Adapters", paths: ["src/a.py"] }, contract: "Adapters work", dependsOn: [], mandatory: true },
        { id: "tests", title: "Tests", boundary: { scope: "Tests", paths: ["tests/test_a.py"] }, contract: "Adapters tested", dependsOn: [], mandatory: true },
        { id: "docs", title: "Docs", boundary: { scope: "Docs", paths: ["docs/commands.md"] }, contract: "Commands documented", dependsOn: ["tests"], mandatory: true },
        { id: "notes", title: "Notes", boundary: { scope: "Notes", paths: ["notes.txt"] }, contract: "Notes written", dependsOn: ["docs"], mandatory: true },
      ] };
      const executor: AgentExecutor = { async execute(request) {
        expect(request.profile.output).toBe("initiativePlan");
        const problems = request.validate?.(split) ?? [];
        if (mode === "merge") {
          expect(problems).toEqual([]);
          return { output: split, inputTokens: 20, outputTokens: 30 };
        }
        expect(problems.join("\n")).toContain("testedBy");
        const repaired = { ...split, features: split.features.map((feature) => feature.id === "adapters"
          ? { ...feature, boundary: { ...feature.boundary, paths: [...feature.boundary.paths, "tests/unit_a.py"] } }
          : feature) };
        expect(request.validate?.(repaired)).toEqual([]);
        return { output: repaired, inputTokens: 20, outputTokens: 30 };
      } };
      const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } }, executor);
      cleanups.push(async () => { await service.shutdown(); service.close(); await removeTempDir(root); });
      const initiatives = new InitiativeService(service);
      await initiatives.start({ commandId: newId(), initiativeId: "split", prompt: "Build adapters, tests and docs", ownerLabel: "test", policy, keepFeatures: mode === "keep", splitCriticalPath: mode === "different-dependents" });
      const view = await initiatives.drive("split", new AbortController().signal);
      expect(view.status).toBe("awaiting_approval");
      const proposed = initiatives.store.plan(initiatives.store.revision("split", initiatives.store.get("split").plan_revision!));
      expect(proposed.features).toHaveLength(mode === "merge" ? 3 : 4);
      expect(proposed.features[0]?.boundary.paths).toContain(mode === "merge" ? "tests/test_a.py" : "tests/unit_a.py");
    }, 60000);
  }

  test("#1594 decomposition returns a source-only boundary for a named test owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-test-owner-plan-"));
    const split: InitiativePlan = { schemaVersion: 1, title: "Split", goals: ["Adapters work"], completionCriteria: ["All delivered"], features: [
      { id: "adapters", title: "Adapters", boundary: { scope: "Adapters", paths: ["src/a.py", "src/b.py", "src/c.py"] }, contract: "Adapters work", dependsOn: [], mandatory: true },
      { id: "entry", title: "Entry tests", boundary: { scope: "Acceptance", paths: ["tests/test_x.py"] }, contract: "Adapters tested", dependsOn: ["adapters"], mandatory: true },
      { id: "docs", title: "Docs", boundary: { scope: "Docs", paths: ["docs/commands.md"] }, contract: "Commands documented", dependsOn: [], mandatory: true },
    ] };
    let sentBack = false;
    const executor: AgentExecutor = { async execute(request) {
      expect(request.profile.output).toBe("initiativePlan");
      expect(request.validate?.(split).join("\n")).toContain("testedBy");
      sentBack = true;
      const repaired = { ...split, features: split.features.map((feature) => feature.id === "adapters" ? { ...feature, testedBy: "entry" } : feature) };
      expect(request.validate?.(repaired)).toEqual([]);
      expect(planStructureProblems(repaired)).toEqual([]);
      return { output: repaired, inputTokens: 20, outputTokens: 30 };
    } };
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } }, executor);
    cleanups.push(async () => { await service.shutdown(); service.close(); await removeTempDir(root); });
    const initiatives = new InitiativeService(service);
    await initiatives.start({ commandId: newId(), initiativeId: "split", prompt: "Build adapters, tests and docs", ownerLabel: "test", policy, keepFeatures: true });
    const view = await initiatives.drive("split", new AbortController().signal);
    expect(sentBack).toBe(true);
    expect(view.status).toBe("awaiting_approval");
    const proposed = initiatives.store.plan(initiatives.store.revision("split", initiatives.store.get("split").plan_revision!));
    expect(proposed.features[0]?.testedBy).toBe("entry");
  }, 60000);

  test("#1594 spec submission returns criteria whose evidence only a sibling can deliver", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-test-owner-spec-"));
    const delegate = new ScriptedExecutor("tests/test_x.py", "review");
    let validated = false;
    const executor: AgentExecutor = { async execute(request) {
      const result = await delegate.execute(request);
      if (request.profile.output === "spec") {
        const spec = result.output as Spec;
        for (const then of ["tests/test_x.py covers the adapters", "Acceptance tests are delivered with adapter coverage"]) {
          const bad = { ...spec, criteria: [{ ...spec.criteria[0]!, then }] };
          expect(request.validate?.(bad).join("\n")).toContain("outside adapters");
        }
        expect(request.validate?.(spec)).toEqual([]);
        validated = true;
      }
      return result;
    } };
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } }, executor);
    cleanups.push(async () => { await service.shutdown(); service.close(); await removeTempDir(root); });
    const snapshot = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Make adapter ready", policy, ownerLabel: "test", initiativeBounds: { featureId: "adapters", features: [
      { id: "adapters", scope: "Adapter", paths: ["adapter.txt"], testedBy: "entry" },
      { id: "entry", scope: "Tests", paths: ["tests/test_x.py"] },
    ] } });
    await service.drive(snapshot.runId, new AbortController().signal);
    expect(validated).toBe(true);
    expect((await service.get(snapshot.runId)).status).toBe("waiting");
  }, 60000);
  for (const stage of ["review", "convergence"] as const) {
    for (const [label, file, shape] of [
      ["pathless tests", "tests/test_x.py", { file: null, claim: "The required adapter acceptance tests have not been delivered", suggestedFix: "Supply the handwritten in-memory adapter tests" }],
      ["claim-only path", "tests/test_x.py", { file: null, claim: "Missing acceptance coverage in tests/test_x.py", suggestedFix: "Deliver acceptance coverage" }],
      ["docs path", "docs/commands.md", { file: null, claim: "Missing docs/commands.md", suggestedFix: "Deliver documentation" }],
    ] as const) {
      test(`#1594 ${stage}: ${label} defers to entry without an implementer attempt`, async () => {
        const { executor, service, initiatives, runId } = await scenario(file, stage, false, shape);
        expect(await service.get(runId)).toMatchObject({ status: "completed" });
        expect(initiatives.view("crossmill").status).toBe("completed");
        expect(executor.corrections).toEqual([]);
        expect(service.store.run(runId).corrective_tasks).toBe(0);
        const state = service.store.state(runId);
        expect(state.limitations).toEqual([]);
        expect(state.reviewNotes).toContainEqual(expect.objectContaining({ reason: "owned_by_sibling", claim: expect.stringContaining("feature entry") }));
        const report = runReport(service.store, runId);
        expect(report).not.toContain("## Known limitations");
        if (stage === "convergence") expect(report).toContain("Final review: **deferred to entry**");
        const fallback = { ...finding(file), ...shape, id: "F-pathless-fallback" };
        const before = state.graph?.tasks.length;
        service.store.transaction(() => {
          for (const [kind, scope] of [["convergence", "round"], ["repair", "review"], ["repair", "task"]] as const)
            appendCorrections(service.store, runId, state, policy, [fallback], kind, scope);
        });
        expect(state.graph?.tasks.length).toBe(before);
        expect(() => service.store.transaction(() => appendCorrections(service.store, runId,
          { ...state, initiativeBounds: null }, policy, [{ ...finding(file), file: null, claim: "Acceptance tests are missing", suggestedFix: "Add tests" }], "repair", "task"))).toThrow("writable test path");
      }, 60000);
    }
  }

  test("#1594 the test owner's mutation gate measures deferred source after tests land", async () => {
    const { service, initiatives, executor, runId } = await scenario("tests/adapter.test.ts", "review", false, {}, true);
    expect(await service.get(runId)).toMatchObject({ status: "completed" });
    expect(initiatives.view("crossmill").status).toBe("completed");
    expect(executor.corrections).toEqual([]);
    expect(service.store.latestArtifact(runId, QUALITY_MUTATION)).toBeNull();
    const deferred = service.store.latestArtifact(runId, "quality/mutation-deferred.json");
    expect(deferred).toBeTruthy();
    const entry = initiatives.store.current("crossmill", "entry")!.run_id;
    const artifact = service.store.latestArtifact(entry, QUALITY_MUTATION)!;
    expect(artifact).toBeTruthy();
    const result = JSON.parse(service.store.readArtifact(entry, artifact.id)) as MutationResult;
    expect(result.mutants.length).toBeGreaterThan(0);
    expect(result.mutants.every((mutant) => mutant.file === "src/adapter.ts" && mutant.status === "killed")).toBe(true);
  }, 60000);
  for (const stage of ["review", "convergence"] as const) {
    for (const file of ["tests/test_x.py", "docs/commands.md", "src/entry.py"]) {
      test(`${stage}: ${file} is a note naming entry and both features finish`, async () => {
        const { root, executor, service, initiatives, runId } = await scenario(file, stage);
        expect(await service.get(runId)).toMatchObject({ status: "completed" });
        expect(initiatives.view("crossmill").status).toBe("completed");
        expect(executor.corrections).toEqual([]);
        const state = service.store.state(runId);
        expect(state.reviewNotes).toContainEqual(expect.objectContaining({ file, reason: "owned_by_sibling", claim: expect.stringContaining("feature entry") }));
        expect(executor.seenBounds.every(Boolean)).toBe(true);
        expect(runReport(service.store, runId)).toContain("Owned by initiative feature entry");
        expect(readFileSync(join(root, file), "utf8")).toBe("ready");
        expect(service.store.events(runId).some((event) => JSON.stringify(event).includes('"input_changed"'))).toBe(false);
      }, 60000);
    }
  }

  test("correction fallback keeps a sibling finding as a note without spending a round", async () => {
    const { service, runId } = await scenario("src/entry.py", "review");
    const state = service.store.state(runId);
    const before = state.graph?.tasks.length;
    const rounds = service.store.run(runId).convergence_rounds;
    const fallback = { ...finding("src/entry.py"), id: "F-fallback" };
    service.store.transaction(() => {
      const artifact = service.store.artifact(runId, "review", "reviews/fallback.json", JSON.stringify(fallback));
      service.store.addFinding(runId, fallback, fingerprint(fallback), artifact.id);
      for (const [kind, scope] of [["convergence", "round"], ["repair", "review"], ["repair", "task"]] as const)
        appendCorrections(service.store, runId, state, policy, [fallback], kind, scope);
    });
    expect(state.graph?.tasks.length).toBe(before);
    expect(service.store.run(runId).convergence_rounds).toBe(rounds);
    expect(state.reviewNotes).toContainEqual(expect.objectContaining({ findingId: "F-fallback", reason: "owned_by_sibling" }));
    expect(service.store.findings(runId).find((finding) => finding.id === fallback.id)?.status).toBe("resolved");
    expect(() => service.store.transaction(() => appendCorrections(service.store, runId, state, policy, [finding("unowned.py")], "convergence"))).toThrow("unowned.py");
  }, 60000);

  test("a run saved before boundary metadata existed recovers its approved owners on resume", async () => {
    const { service, runId, initiatives } = await scenario("tests/test_x.py", "review", true);
    expect(await service.get(runId)).toMatchObject({ status: "completed" });
    expect(initiatives.view("crossmill").status).toBe("completed");
    expect(service.store.state(runId).reviewNotes).toContainEqual(expect.objectContaining({ reason: "owned_by_sibling", claim: expect.stringContaining("feature entry") }));
    expect(service.store.findings(runId).every((finding) => ["resolved", "refuted"].includes(finding.status))).toBe(true);
  }, 60000);
});
