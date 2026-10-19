import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { appendCorrections } from "../src/core/verification/convergence.js";
import { fingerprint } from "../src/core/verification/findings.js";
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
  constructor(private file: string, private stage: "review" | "convergence") {}
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
        const file = adapter ? "adapter.txt" : this.file;
        const markdown = `# Plan\n## Context\nCreate ${file}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${file}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: `Create ${file}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: file, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        if (request.task?.origin !== "planned") this.corrections.push(request.task!);
        for (const write of request.task?.writes ?? []) {
          const file = join(request.root!, write.path);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, "ready");
        }
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote ready", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence": {
        this.seenBounds.push(data.extra.initiativeBounds);
        const raises = adapter && request.profile.output === this.stage && (this.stage === "convergence" || data.extra.dimension === "correctness");
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: raises ? "changes_requested" : "pass", coverage: [{ criterionId: "AC-001", verdict: raises ? "fail" : "pass", evidenceIds, explanation: raises ? "Acceptance work belongs to entry" : "Checks pass" }], findings: raises ? [finding(this.file, evidenceIds)] : [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function scenario(file: string, stage: "review" | "convergence", legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-sibling-owner-"));
  const executor = new ScriptedExecutor(file, stage);
  const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } }, executor);
  cleanups.push(async () => { await service.shutdown(); service.close(); await removeTempDir(root); });
  const initiatives = new InitiativeService(service);
  const split: InitiativePlan = { schemaVersion: 1, title: "Crossmill", goals: ["Adapters and entry work"], completionCriteria: ["All work delivered"], features: [
    { id: "adapters", title: "Adapters", boundary: { scope: "Command adapters", paths: ["adapter.txt"] }, contract: "Adapters are ready", dependsOn: [], mandatory: true, workflow: "sdd" },
    { id: "entry", title: "Entry", boundary: { scope: "Entry and integration acceptance", paths: [file] }, contract: "Entry is ready", dependsOn: ["adapters"], mandatory: true, workflow: "sdd" },
  ] };
  const settings: InitiativeSettings = { workflowId: "sdd", basePolicy: policy, budget: null, costBudget: null, featureAutoApproval: null, autoApprovalConfirmation: null, model: null, ownerLabel: "test", featureIssues: {}, forecastStop: false, keepFeatures: true, splitCriticalPath: false };
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
