import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { RunStatus, type RunPolicy, type Spec } from "../src/core/workflows/schemas.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { assertWorkspaceMutationAllowed, withinWorkflow, withWorkspaceMutation } from "../src/core/workflows/leases.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { parseWorkflowArgs, workflowHelp } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { gitBaseline, sourceManifest } from "../src/core/verification/snapshot.js";
import { fingerprint } from "../src/core/verification/findings.js";
import { ReviewSchema, PlanSchema, ImplementationSchema } from "../src/core/workflows/schemas.js";
import { workspacePath } from "../src/core/specs/validate.js";
import { planConsistencyProblems } from "../src/core/workflows/plan-consistency.js";
import { validateEvidence } from "../src/core/verification/evidence.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { applyWorkflowEvent } from "../src/stores/workflow.js";
import { AgentBus } from "../src/core/agents/agent-bus.js";
import { opensDependency } from "../src/core/agents/execution-result.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }], dependencies: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

class FixtureExecutor implements AgentExecutor {
  calls: string[] = [];
  constructor(private root: string, private repair = false) {}
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": {
        const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        writeFileSync(join(this.root, "value.txt"), this.repair && request.task?.id === "T001" ? "broken" : "ready");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] }; break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Command checked value" }], findings: [] }; break;
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Command checked the value" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}
function setup(repair = false, parent = tmpdir()) {
  const root = mkdtempSync(join(parent, "baked-workflow-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new FixtureExecutor(root, repair);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  return { root, executor, service, config };
}
async function start(service: NativeWorkflowService) {
  const request = { commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy };
  return { run: await service.start(request), request };
}
async function approve(service: NativeWorkflowService, runId: string) {
  const run = await service.get(runId); const request = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  expect(request).toBeDefined();
  return service.decide(runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "approve", requestId: request!.id, digest: request!.digest });
}
describe("durable SDD runtime", () => {
  test("run model overrides a stale session default without changing saved profiles or config", async () => {
    const { service, config } = setup();
    config.defaultModel = "none";
    const run = async (commandId: string, model?: string) => {
      const controller = new AbortController();
      controller.abort();
      return await executeWorkflowCommand(service, parseWorkflowArgs([
        "run", "--feature", "fixture", "--prompt", "Create ready value", "--command-id", commandId,
        ...(model === undefined ? [] : ["--model", model]),
      ]), controller.signal) as { runId: string };
    };
    await expect(run("missing-model")).rejects.toThrow("Select a model");
    const first = await run("first-model", "fixture/selected");
    const frozen = service.store.run(first.runId).profiles_json;
    expect(JSON.parse(frozen).find((profile: { id: string }) => profile.id === "researcher").model).toBe("fixture/selected");
    const second = await run("second-model", "fixture/switched");
    expect(JSON.parse(service.store.run(second.runId).profiles_json).find((profile: { id: string }) => profile.id === "researcher").model).toBe("fixture/switched");
    expect(service.store.run(first.runId).profiles_json).toBe(frozen);
    expect(config.defaultModel).toBe("none");
    await expect(run("missing-model-again")).rejects.toThrow("Select a model");
    await expect(run("first-model", "fixture/switched")).rejects.toThrow("different input");
    await expect(run("blank-model", "   ")).rejects.toThrow("Select a model");
  });
  test("SQLite busy prevents publication before its durable intent", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    writeFileSync(join(root, "value.txt"), "before");
    const step = service.store.beginStep(run.runId, "publication");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    service.leases.acquire("mutation", run.runId);
    const blocker = new Database(service.store.path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      expect(() => service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"))).toThrow(/locked|busy/i);
      expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("before");
      expect(service.store.effects(run.runId)).toHaveLength(0);
    } finally { blocker.exec("ROLLBACK"); blocker.close(); }
    service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"));
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("after");
  }, 15000);
  test("SQLite full rolls back the intent and leaves the source unchanged", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    writeFileSync(join(root, "value.txt"), "before");
    const step = service.store.beginStep(run.runId, "publication");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    service.leases.acquire("mutation", run.runId);
    // Limit the live SQLite connection, not the host disk. The trigger forces
    // page allocation inside the same transaction as the effect intent.
    const db = Reflect.get(service.store, "db") as Database;
    db.exec("CREATE TABLE fault_pages (data BLOB); CREATE TRIGGER fault_full BEFORE INSERT ON effects BEGIN INSERT INTO fault_pages VALUES (zeroblob(1048576)); END;");
    const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
    db.exec(`PRAGMA max_page_count=${pages + 1}`);
    try {
      expect(() => service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"))).toThrow(/full/i);
      expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("before");
      expect(service.store.effects(run.runId)).toHaveLength(0);
    } finally { db.exec("PRAGMA max_page_count=2147483646; DROP TRIGGER fault_full; DROP TABLE fault_pages;"); }
    service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"));
    expect(service.store.effects(run.runId)[0]?.status).toBe("applied");
  });
  test("a failed applied acknowledgement reconciles the written file after reopen", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    writeFileSync(join(root, "value.txt"), "before");
    const step = service.store.beginStep(run.runId, "publication");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    service.leases.acquire("mutation", run.runId);
    const db = new Database(service.store.path);
    try {
      db.exec("CREATE TRIGGER fault_ack BEFORE UPDATE ON effects WHEN NEW.status='applied' BEGIN SELECT RAISE(FAIL, 'injected acknowledgement failure'); END;");
      expect(() => service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"))).toThrow("acknowledgement failure");
      expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("after");
      expect(service.store.effects(run.runId)[0]?.status).toBe("unknown");
    } finally { db.exec("DROP TRIGGER fault_ack"); db.close(); }
    service.leases.release();
    const reopened = new NativeWorkflowService(root, service.config, new FixtureExecutor(root));
    try {
      reopened.leases.acquire("mutation", run.runId);
      expect(reopened.scheduler.journal.reconcile(run.runId)).toEqual([]);
      expect(reopened.store.effects(run.runId)[0]?.status).toBe("reconciled");
      expect(reopened.store.evidence(run.runId)).toHaveLength(0);
      expect(reopened.store.run(run.runId).status).not.toBe("completed");
    } finally { reopened.close(); }
  });
  test("newer storage schemas are preserved and rejected", async () => {
    const { root, service } = setup(); await start(service);
    const db = new Database(join(root, ".baked", "workflows.sqlite"));
    try { db.run("UPDATE schema_migrations SET version=version+10"); expect(() => new WorkflowStore(root)).toThrow("version"); expect(db.query("SELECT MIN(version) AS version FROM schema_migrations").get()).toEqual({ version: 11 }); }
    finally { db.close(); }
  });
  test("artifact rollback leaves no evidence pointing to an orphan blob", async () => {
    const { service } = setup(); const { run } = await start(service); let id = "";
    expect(() => service.store.transaction(() => { id = service.store.artifact(run.runId, "review", "orphan.json", "x".repeat(300000)).id; throw new Error("injected commit failure"); })).toThrow("injected");
    expect(service.store.artifacts(run.runId).some((a) => a.id === id)).toBe(false);
    expect(() => service.store.readArtifact(run.runId, id)).toThrow("Missing artifact");
    expect(service.store.evidence(run.runId)).toHaveLength(0);
  });
  test("unknown command effects wait for recovery without invoking an agent", async () => {
    const { service, executor } = setup(); const { run } = await start(service);
    const step = service.store.beginStep(run.runId, "interrupted-check");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    const effect = service.store.prepareEffect(run.runId, attempt, "command", { checkId: "check" }, null, null);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("interrupted_effect");
    expect(executor.calls).toHaveLength(0);
    expect(service.store.requests(run.runId).find((r) => r.kind === "recovery")?.body_json).toContain(effect);
    expect(service.store.attempts(run.runId)[0]?.status).toBe("interrupted");
  });
  test("a legacy write begun before the first run already holds a durable mutation lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-legacy-lease-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await withWorkspaceMutation(root, async () => {
      const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } }, new FixtureExecutor(root));
      try { const { run } = await start(service); await expect(service.drive(run.runId, new AbortController().signal)).rejects.toThrow("owned"); }
      finally { service.close(); }
    });
  });
  test("a skeptic can refute a finding without a needless repair round", async () => {
    const { service, executor } = setup(); const original = executor.execute.bind(executor);
    executor.execute = async (request) => {
      const context = JSON.parse(request.prompt.split("\n").at(-1)!);
      if (request.profile.output === "refutation") return { output: { schemaVersion: 1, findingId: context.extra.finding.id, decision: "refuted", evidenceIds: context.extra.evidence.map((e: { id: string }) => e.id), explanation: "Passing host check disproves the claim" }, inputTokens: 20, outputTokens: 30 };
      const result = await original(request);
      if (request.profile.output === "review") result.output = { ...ReviewSchema.parse(result.output), verdict: "changes_requested", findings: [{ id: "false-positive", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence.map((e: { id: string }) => e.id), claim: "Value might be wrong", impact: "Contract", suggestedFix: "Check value" }] };
      return result;
    };
    const { run } = await start(service); await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    expect(service.store.findings(run.runId)[0]?.status).toBe("refuted");
    expect(service.store.run(run.runId).repair_rounds).toBe(0);
  });
  test("nested ignore rules preserve Git tracked files and record user changes", async () => {
    const { root } = setup();
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", ".gitignore"), "*.log\n");
    writeFileSync(join(root, "src", "ignored.log"), "generated");
    writeFileSync(join(root, "src", "tracked.log"), "user file");
    expect(Bun.spawnSync(["git", "init", root]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", root, "add", "-f", "src/tracked.log"]).exitCode).toBe(0);
    const files = await sourceManifest(root);
    expect(files["src/ignored.log"]).toBeUndefined();
    expect(files["src/tracked.log"]).toBe(hashBytes("user file"));
    expect((await gitBaseline(root))?.tracked).toContain("src/tracked.log");
    expect((await gitBaseline(root))?.userChanges.length).toBeGreaterThan(0);
  });
  test("simultaneous decisions cannot both accept the same revision", async () => {
    const { service } = setup(); const { run } = await start(service);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    const request = service.store.requests(run.runId).find((r) => r.kind === "approval")!;
    const decisions = await Promise.allSettled([1, 2].map(() => service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: request.id, digest: request.digest })));
    expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  test("explicit revision adopts changed instructions and supersedes approval", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    await service.drive(run.runId, new AbortController().signal);
    const old = service.store.requests(run.runId).find((r) => r.kind === "approval")!;
    writeFileSync(join(root, "AGENTS.md"), "Use fixture conventions.\r\n");
    const artifacts = new WorkflowArtifacts(service);
    const request = { commandId: newId(), expectedInputHash: (await service.get(run.runId)).inputHash };
    const candidate = await artifacts.stageRevision(run.runId, request);
    expect(await artifacts.stageRevision(run.runId, request)).toEqual(candidate);
    await expect(artifacts.stageRevision(run.runId, { ...request, plan: "different" })).rejects.toThrow("different input");
    await service.revise(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision }, candidate.candidateHash);
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(service.store.requests(run.runId).find((r) => r.id === old.id)?.status).toBe("superseded");
    expect(service.store.requests(run.runId).find((r) => r.status === "pending")?.digest).not.toBe(old.digest);
  });
  test("a repeated resolved finding reopens and retains both review origins", async () => {
    const { service } = setup(); const { run } = await start(service);
    const finding = { id: "f-one", kind: "correctness" as const, severity: "high" as const, requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: null, symbol: null, evidenceIds: ["evidence"], claim: "Value is wrong", impact: "Breaks contract", suggestedFix: "Fix value" };
    const a = service.store.artifact(run.runId, "review", "a.json", "{}");
    const b = service.store.artifact(run.runId, "review", "b.json", "{}");
    service.store.addFinding(run.runId, finding, fingerprint(finding), a.id);
    service.store.findingStatus(run.runId, finding.id, "resolved");
    expect(service.store.addFinding(run.runId, { ...finding, id: "f-two" }, fingerprint(finding), b.id)).toBe(finding.id);
    expect(service.store.findings(run.runId)[0]?.status).toBe("open");
    expect(service.store.events(run.runId).filter((e) => e.type === "finding.recorded")).toHaveLength(2);
  });
  test("manual criteria wait for a trusted snapshot-bound decision", async () => {
    const { service, executor } = setup();
    const original = executor.execute.bind(executor);
    executor.execute = async (request) => { const result = await original(request); if (request.profile.output === "spec") result.output = { ...spec, requirements: spec.requirements.map((r) => ({ ...r, verification: "manual" })), criteria: spec.criteria.map((c) => ({ ...c, method: "manual" })) }; return result; };
    const { run } = await start(service);
    await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("manual_evidence");
    const pending = service.store.requests(run.runId).find((r) => r.kind === "manual_evidence")!;
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "manual-evidence", requestId: pending.id, criterionId: "AC-001", evidence: "Inspected the value in the fixture", accepted: true });
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
  });
  test("missing convergence coverage creates an authorized correction", async () => {
    const { service, executor } = setup(); const original = executor.execute.bind(executor); let convergence = 0;
    executor.execute = async (request) => {
      if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
        const context = JSON.parse(request.prompt.split("\n").at(-1)!);
        return { output: ImplementationSchema.parse({ schemaVersion: 1, taskId: request.task?.id, outcome: "already_satisfied", summary: "Existing implementation has host checks", evidenceIds: context.extra.evidence.map((e: { id: string }) => e.id), unresolved: [] }), inputTokens: 20, outputTokens: 30 };
      }
      const result = await original(request);
      if (request.profile.output === "convergence" && convergence++ === 0) result.output = { ...ReviewSchema.parse(result.output), coverage: [] };
      return result;
    };
    const { run } = await start(service); await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(service.store.run(run.runId).convergence_rounds).toBe(1);
    expect(service.store.state(run.runId).spec).toEqual(spec);
  });
  test("a failed task check repairs its predecessor before running descendants", async () => {
    const { service, executor, root } = setup(true); const original = executor.execute.bind(executor);
    executor.execute = async (request) => {
      if (request.task?.id === "T002") {
        expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
        writeFileSync(join(root, "dependent.txt"), "done");
        return { output: { schemaVersion: 1, taskId: "T002", outcome: "implemented", summary: "Dependent task", evidenceIds: [], unresolved: [] }, inputTokens: 20, outputTokens: 30 };
      }
      const result = await original(request);
      if (request.profile.output === "plan") {
        const plan = PlanSchema.parse(result.output); const base = plan.taskGraph.tasks[0]!;
        base.checkIds = ["check"];
        plan.taskGraph.tasks.push({ ...base, id: "T002", dependsOn: ["T001"], writes: [{ path: "dependent.txt", action: "create" }], checkIds: [] });
        result.output = plan;
      }
      return result;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create two dependent tasks", ownerLabel: "test", policy: { ...policy, checks: policy.checks.map((c) => ({ ...c, scope: "task" })) } });
    await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "dependent.txt"), "utf8")).toBe("done");
    expect(service.store.tasks(run.runId)).toHaveLength(3);
  });
  test("CLI rejects irrelevant flags, extra arguments and invalid numeric values", () => {
    for (const args of [["status", "run", "extra"], ["status", "run", "--accept"], ["list", "--limit", "1e2"], ["resume", "run", "--expected-revision", "-1"]]) expect(() => parseWorkflowArgs(args)).toThrow();
  });
  test("salvage cannot open an agent dependency even if a legacy flag says success", async () => {
    const bus = new AgentBus();
    const executionResult = { execution: "failed" as const, taskOutcome: "failed" as const, summary: "Provider failed", partialOutput: "Edited a file", effectIds: ["effect"], usage: null, usageComplete: false };
    expect(opensDependency(executionResult)).toBe(false);
    bus.setResult({ agentId: "parent", role: "code", task: "Edit", result: "Partial edits", success: true, executionResult });
    expect(bus.getResult("parent")?.success).toBe(false);
    await expect(bus.waitForAgent("parent", 50)).rejects.toThrow("failed");
  });
  test("all file action aliases are checked against the workspace boundary", () => {
    const { root } = setup();
    for (const path of ["../escape", "C:/escape", ".baked./config.json", "src/../secret", "src\\file", "file:stream", "NUL.txt"]) expect(() => workspacePath(root, path)).toThrow();
    expect(workspacePath(root, "new/file.ts")).toBe(join(root, "new/file.ts"));
  });
  test("an expired lease with a live owner cannot be taken over", async () => {
    const { service, root, config } = setup(); const { run } = await start(service);
    service.leases.acquire("execution", run.runId);
    const lease = service.store.lease("execution")!;
    service.store.transaction(() => service.store.putLease({ ...lease, expires_at: 1 }));
    const other = new NativeWorkflowService(root, config, new FixtureExecutor(root));
    try { expect(() => other.leases.acquire("execution", run.runId)).toThrow("owned"); } finally { other.close(); }
  });
  test("one service cannot run two writers under the same owner", async () => {
    const { service } = setup(); const { run } = await start(service);
    service.leases.acquire("execution", run.runId);
    expect(() => service.leases.acquire("execution", "other-run")).toThrow("Another run");
  });
  test("crash reconciliation distinguishes before, after and unknown file content", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    service.leases.acquire("execution", run.runId); service.leases.acquire("mutation", run.runId);
    const step = service.store.beginStep(run.runId, "fixture");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    writeFileSync(join(root, "after.txt"), "after");
    writeFileSync(join(root, "unknown.txt"), "user edit");
    const prepared = service.store.prepareEffect(run.runId, attempt, "file_patch", { path: "before.txt" }, null, hashBytes("after"));
    const applied = service.store.prepareEffect(run.runId, attempt, "file_patch", { path: "after.txt" }, null, hashBytes("after"));
    const uncertain = service.store.prepareEffect(run.runId, attempt, "file_patch", { path: "unknown.txt" }, hashBytes("before"), hashBytes("after"));
    expect(service.scheduler.journal.reconcile(run.runId)).toEqual([uncertain]);
    expect(service.store.effects(run.runId).find((e) => e.id === prepared)?.status).toBe("failed");
    expect(service.store.effects(run.runId).find((e) => e.id === applied)?.status).toBe("reconciled");
    expect(readFileSync(join(root, "unknown.txt"), "utf8")).toBe("user edit");
  });
  test("unknown usage remains reserved across database reopen", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    const step = service.store.beginStep(run.runId, "fixture");
    const attempt = service.store.reserve(run.runId, step, "fixture/model", policy.maxTotalTokens - 50, policy);
    service.store.finishAttempt(run.runId, attempt, "interrupted", null);
    const reopened = new WorkflowStore(root);
    try { expect(() => reopened.reserve(run.runId, step, "fixture/model", 100, policy)).toThrow("budget"); expect(reopened.attempts(run.runId)[0]?.usage_complete).toBe(0); } finally { reopened.close(); }
  });
  test("exit zero after source mutation is inconclusive and invalidates evidence", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    writeFileSync(join(root, "source.txt"), "before");
    const step = service.store.beginStep(run.runId, "fixture"); const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    const scope = new ProcessScope();
    try {
      const checked = await new CheckRunner(service.store, scope).run(run.runId, attempt, { ...policy.checks[0]!, args: ["-e", "await Bun.write('source.txt','after')"] }, new AbortController().signal);
      expect(checked.status).toBe("inconclusive");
      expect(() => validateEvidence(service.store, run.runId, checked.snapshotId, [checked.evidenceId])).toThrow("stale");
    } finally { await scope.stop(); }
  });
  test("missing executable never becomes a passing check", async () => {
    const { service } = setup(); const { run } = await start(service);
    const step = service.store.beginStep(run.runId, "fixture"); const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    const scope = new ProcessScope();
    try { const checked = await new CheckRunner(service.store, scope).run(run.runId, attempt, { ...policy.checks[0]!, executable: "baked-fixture-command-does-not-exist" }, new AbortController().signal); expect(checked.status).toBe("inconclusive"); } finally { await scope.stop(); }
  });
  test("evidence IDs cannot be borrowed from another run", async () => {
    const { service } = setup(); const first = await start(service); const second = await start(service);
    const snapshot = service.store.putSnapshot(first.run.runId, {});
    const artifact = service.store.artifact(first.run.runId, "review", "review.json", "{}");
    const evidence = service.store.addEvidence(first.run.runId, "review", snapshot.id, artifact.id);
    expect(() => validateEvidence(service.store, second.run.runId, snapshot.id, [evidence])).toThrow("Unknown");
  });
  test("a late manual edit of a rendered specification blocks approval", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    await service.drive(run.runId, new AbortController().signal);
    writeFileSync(join(root, "specs/fixture/spec.md"), "User revised the specification");
    await expect(approve(service, run.runId)).rejects.toThrow("Published artifact changed");
  });
  test("UI event projection ignores duplicate delivery and demands snapshot reload for gaps", async () => {
    const { service } = setup(); const { run } = await start(service);
    const projection = { snapshot: run, lastSeq: run.eventSeq };
    service.store.transaction(() => service.store.transition(run.runId, "paused", "user_pause"));
    const event = service.store.events(run.runId, run.eventSeq)[0]!;
    const once = applyWorkflowEvent(projection, event);
    expect(applyWorkflowEvent(once, event)).toBe(once);
    expect(applyWorkflowEvent(projection, { ...event, seq: event.seq + 2 })).toBe(projection);
    expect(once.snapshot?.status).toBe("paused");
  });
  test("redaction invalidates evidence without rewriting the historical hash", async () => {
    const { service } = setup(); const { run } = await start(service);
    const snapshot = service.store.putSnapshot(run.runId, {});
    const artifact = service.store.artifact(run.runId, "manual", "sensitive.txt", "sensitive fixture");
    const evidenceId = service.store.addEvidence(run.runId, "manual", snapshot.id, artifact.id);
    service.store.redact(run.runId, artifact.id, "Fixture redaction");
    expect(service.store.artifacts(run.runId).find((a) => a.id === artifact.id)?.content_hash).toBe(artifact.content_hash);
    expect(() => service.store.readArtifact(run.runId, artifact.id)).toThrow("hash mismatch");
    expect(() => validateEvidence(service.store, run.runId, snapshot.id, [evidenceId])).toThrow();
    expect((await service.get(run.runId)).verificationState).toBe("invalid");
  });
  test("source manifests include user files while excluding local runtime state", async () => {
    const { root } = setup(); writeFileSync(join(root, "source.ts"), "export const value = 1;");
    const manifest = await sourceManifest(root);
    expect(manifest["source.ts"]).toBe(hashBytes("export const value = 1;"));
    expect(Object.keys(manifest).some((path) => path.startsWith(".baked/"))).toBe(false);
  });
  test("start is idempotent and commands reject conflicting content", async () => {
    const { service, config } = setup(); const { run, request } = await start(service);
    config.defaultModel = "none";
    expect(await service.start(request)).toEqual(run);
    await expect(service.start({ ...request, prompt: "different" })).rejects.toThrow("different input");
    expect(service.store.events(run.runId).filter((e) => e.type === "run.created")).toHaveLength(1);
  });
  test("waits for exact approval then verifies code, checks and coverage", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.status).toBe("waiting"); expect(waiting.reason).toBe("approval");
    await approve(service, run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") throw new Error(JSON.stringify({ done, errors: service.store.artifacts(run.runId).filter((a) => a.kind === "diagnostic").map((a) => service.store.readArtifact(run.runId, a.id)) }));
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    expect(done.verificationState).toBe("current");
    expect(service.store.tasks(run.runId).every((t) => t.status === "verified")).toBe(true);
    expect(service.store.checks(run.runId).at(-1)?.status).toBe("passed");
    await expect(service.resume(run.runId, { commandId: newId(), expectedRevision: done.revision })).rejects.toThrow("Terminal");
  });
  test("auto approval inside the limits records the host decision and completes without a person", async () => {
    const { service } = setup();
    const auto: RunPolicy = { ...policy, autoApproval: { renewal: false, limits: { maxTasks: 1, maxFiles: 1, allowedPaths: ["*.txt"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: policy.maxTotalTokens } } };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: auto });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const request = service.store.requests(run.runId).find((r) => r.kind === "approval")!;
    expect(request.actor).toBe("auto-approval");
    expect(done.approvalDigest).toBe(request.digest);
    expect(JSON.parse(request.body_json).autoApproval.mode).toBe("limits");
    expect(service.store.events(run.runId).some((e) => e.type === "request.decided" && (e.payload as { actor: string }).actor === "auto-approval")).toBe(true);
  });
  test("auto approval outside the limits waits for a person with the reasons", async () => {
    const { service } = setup();
    const auto: RunPolicy = { ...policy, autoApproval: { renewal: false, limits: { maxTasks: 1, maxFiles: 1, allowedPaths: ["src/**"], allowDelete: false, allowNewDependencies: false, maxTotalTokens: policy.maxTotalTokens } } };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: auto });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending")!;
    expect(JSON.parse(request.body_json).autoApproval.declined).toContain("Limits: value.txt is outside the allowed paths");
  });
  test("a revision within the human approval is renewed automatically", async () => {
    const { service, root } = setup();
    const auto: RunPolicy = { ...policy, autoApproval: { renewal: true, limits: null } };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: auto });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(JSON.parse(service.store.requests(run.runId)[0]!.body_json).autoApproval.declined).toContain("Renewal: no earlier human approval in this run");
    await approve(service, run.runId);
    writeFileSync(join(root, "AGENTS.md"), "Use fixture conventions.\r\n");
    const candidate = await new WorkflowArtifacts(service).stageRevision(run.runId, { commandId: newId(), expectedInputHash: (await service.get(run.runId)).inputHash });
    await service.revise(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision }, candidate.candidateHash);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval");
    expect(approvals.map((r) => r.actor)).toEqual(["user", "auto-approval"]);
    expect(JSON.parse(approvals[1]!.body_json).autoApproval.mode).toBe("renewal");
  });
  test("failed command creates bounded correction and preserves approval root", async () => {
    const { service } = setup(true); const { run } = await start(service);
    await service.drive(run.runId, new AbortController().signal);
    const approved = await approve(service, run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    if (done.status !== "completed") throw new Error(JSON.stringify({ done, errors: service.store.artifacts(run.runId).filter((a) => a.kind === "diagnostic").map((a) => service.store.readArtifact(run.runId, a.id)) }));
    expect(done.approvalDigest).toBe(approved.approvalDigest);
    expect(service.store.state(run.runId).correctionHashes).toHaveLength(1);
    expect(service.store.tasks(run.runId)).toHaveLength(2);
  });
  test("plan-time sizing sends a plan above the run ceiling back to the planner once, then asks to split the feature", async () => {
    const sized: RunPolicy = { ...policy, sizing: { maxRunTokens: 100_000 } };
    const root = mkdtempSync(join(tmpdir(), "baked-workflow-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new FixtureExecutor(root);
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: sized } }, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: sized });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    expect(executor.calls.filter((call) => call === "plan")).toHaveLength(2);
    const paths = service.store.artifacts(run.runId).map((a) => a.logical_path);
    expect(paths).toContain("sizing/plan-0.json");
    expect(paths).toContain("sizing/plan-1.json");
    expect(service.store.state(run.runId).prompt).toContain("Sizing: the plan is too large");
    const question = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    expect(question?.body_json).toContain("initiative");
  });
  test("plan-time sizing raises the run budget to the price and passes each task its cap", async () => {
    const sized: RunPolicy = { ...policy, maxTotalTokens: 50_000, sizing: { maxRunTokens: 5_000_000 } };
    const root = mkdtempSync(join(tmpdir(), "baked-workflow-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const caps: (number | undefined)[] = [];
    const executor = new (class extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        if (request.profile.output === "implementation") caps.push(request.attemptTokens);
        return super.execute(request);
      }
    })(root);
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: sized } }, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: sized });
    await service.drive(run.runId, new AbortController().signal);
    const raised = JSON.parse(service.store.run(run.runId).policy_json) as RunPolicy;
    expect(raised.maxTotalTokens).toBeGreaterThan(50_000);
    expect(service.store.artifacts(run.runId).some((a) => a.logical_path === "policy-revisions/sizing-0.json")).toBe(true);
    await approve(service, run.runId);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    expect(caps).toEqual([250_000]);
  });
  test("failed checks against one task become one corrective task", async () => {
    const twoChecks: RunPolicy = { ...policy, checks: [policy.checks[0]!, { ...policy.checks[0]!, id: "check-again" }] };
    const root = mkdtempSync(join(tmpdir(), "baked-workflow-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: twoChecks } }, new FixtureExecutor(root, true));
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: twoChecks });
    await service.drive(run.runId, new AbortController().signal);
    await approve(service, run.runId);
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    const tasks = service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as { id: string; findingIds: string[]; description: string });
    expect(tasks).toHaveLength(2);
    expect(tasks[1]!.findingIds).toHaveLength(2);
    expect(tasks[1]!.description).toContain(`Finding ${tasks[1]!.findingIds[1]}`);
  });
  test("stale approval and manual source changes never execute implementation", async () => {
    const { service, root, executor } = setup(); const { run } = await start(service);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    const request = service.store.requests(run.runId)[0]!;
    await expect(service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision - 1 }, { kind: "approve", requestId: request.id, digest: request.digest })).rejects.toThrow("revision");
    await approve(service, run.runId);
    writeFileSync(join(root, "outside.txt"), "user change");
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("input_changed");
    expect(executor.calls).not.toContain("implementation");
  });
  test("status is read-only and independent of the executor", async () => {
    const { service, executor } = setup(); const { run } = await start(service);
    const before = await service.get(run.runId);
    const status = await executeWorkflowCommand(service, parseWorkflowArgs(["status", run.runId]), new AbortController().signal);
    expect(status).toMatchObject(before); expect(executor.calls).toHaveLength(0);
    expect(await service.get(run.runId)).toEqual(before);
  });
  test("events survive reopening and replay has monotonic seq", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    await service.drive(run.runId, new AbortController().signal);
    const second = new NativeWorkflowService(root, service.config, undefined, true);
    try { const events = second.store.events(run.runId); expect(events.length).toBeGreaterThan(5); expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); expect(await second.get(run.runId)).toEqual(await service.get(run.runId)); } finally { second.close(); }
  });
  test("workspace lease excludes another tab and read-only profile cannot edit", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    service.leases.acquire("execution", run.runId); service.leases.acquire("mutation", run.runId);
    expect(() => assertWorkspaceMutationAllowed(root)).toThrow("owns this workspace");
    expect(() => withinWorkflow(service.leases.owner, () => assertWorkspaceMutationAllowed(root))).not.toThrow();
    service.store.transaction(() => service.store.transition(run.runId, "running"));
    const profile = JSON.parse(service.store.run(run.runId).profiles_json).find((p: { id: string }) => p.id === "reviewer");
    const guard = new WorkflowToolPolicy(service.store, service.leases, run.runId, "test", profile, policy);
    expect(() => guard.validate("edit_file", { path: "value.txt" })).toThrow("not allowed");
    expect(() => guard.validate("read", { path: "../outside" })).toThrow();
  });
  test("export has no provider payloads and retention protects active runs", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    const artifacts = new WorkflowArtifacts(service);
    const exported = await artifacts.exportRun(run.runId, join(root, "export"));
    expect(readFileSync(join(exported.path, "manifest.json"), "utf8")).not.toContain("providerOptions");
    expect(await artifacts.gc({ before: "2999-01-01", dryRun: true })).toEqual({ runIds: [], bytes: 0 });
    mkdirSync(join(root, "import")); writeFileSync(join(root, "import", "spec.json"), JSON.stringify(spec));
    const imported = await artifacts.importCandidate({ commandId: newId(), source: "spec-kit", sourcePath: join(root, "import"), featureId: "fixture" });
    expect(imported.candidateHash).toHaveLength(64);
  });
  test("workflow list status filter returns only matching runs with the existing response shape", async () => {
    const { service } = setup();
    const runs = [await start(service), await start(service), await start(service)];
    for (const [index, status] of (["completed", "failed", "completed"] as const).entries())
      service.store.transaction(() => service.store.transition(runs[index]!.run.runId, status));

    const result = await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["list", "--status", "completed"]),
      new AbortController().signal,
    ) as { items: { runId: string; status: string }[]; cursor?: string };

    expect(result.items.map((run) => run.runId)).toEqual(
      service.store.list(100).items.filter((run) => run.status === "completed").map((run) => run.runId),
    );
    expect(result.items.every((run) => run.status === "completed")).toBe(true);
    expect(Object.keys(result)).toEqual(["items"]);
  });
  test("workflow help documents the list status option and its values (AC-005)", () => {
    const list = workflowHelp.split("\n").find((line) => line.startsWith("list "));
    expect(list).toContain("[--status STATUS]");
    for (const status of RunStatus.options) expect(workflowHelp).toContain(status);
  });
  test("runtime guide documents the list status filter and its values (AC-006)", () => {
    const guide = readFileSync(join(import.meta.dir, "../docs/workflows/runtime.md"), "utf8");
    const paragraph = guide.split(/\n\s*\n/).find((part) => part.includes("baked workflow list") && part.includes("--status STATUS"));
    expect(paragraph).toBeDefined();
    for (const status of RunStatus.options) expect(paragraph).toContain(`\`${status}\``);
  });
  test("workflow list rejects an unsupported status and names every valid status", () => {
    expect(() => parseWorkflowArgs(["list", "--status", "unknown"])).toThrow(
      'Invalid --status value "unknown". Valid statuses: created, running, waiting, paused, blocked, completed, failed, cancelled',
    );
  });
  test("workflow list intersects status and feature filters", async () => {
    const { service } = setup();
    const create = (featureId: string) => service.start({
      commandId: newId(), featureId, workflowId: "sdd", prompt: "List fixture",
      ownerLabel: "test", policy,
    });
    const matching = await create("feature-a");
    const otherStatus = await create("feature-a");
    const otherFeature = await create("feature-b");
    service.store.transaction(() => service.store.transition(matching.runId, "completed"));
    service.store.transaction(() => service.store.transition(otherStatus.runId, "failed"));
    service.store.transaction(() => service.store.transition(otherFeature.runId, "completed"));

    const result = await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["list", "--status", "completed", "--feature", "feature-a"]),
      new AbortController().signal,
    ) as { items: { runId: string; featureId: string; status: string }[] };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ runId: matching.runId, featureId: "feature-a", status: "completed" });
  });
  test("workflow list applies status filtering before pagination and preserves ordering and cursors", async () => {
    const { service } = setup();
    const runs: Awaited<ReturnType<typeof start>>[] = [];
    for (let index = 0; index < 5; index++) runs.push(await start(service));
    const statuses = ["failed", "completed", "failed", "completed", "completed"] as const;
    const db = new Database(service.store.path);
    try {
      for (const [index, item] of runs.entries()) {
        service.store.transaction(() => service.store.transition(item.run.runId, statuses[index]!));
        db.run("UPDATE runs SET created_at=? WHERE id=?", [1000 + index * 1000, item.run.runId]);
      }
    } finally { db.close(); }

    const allRuns = service.store.list(100).items;
    const sortedIds = [...allRuns].sort((a, b) => {
      const left = service.store.run(a.runId);
      const right = service.store.run(b.runId);
      return right.created_at - left.created_at || right.id.localeCompare(left.id);
    }).map((run) => run.runId);
    expect(allRuns.map((run) => run.runId)).toEqual(sortedIds);
    const matchingIds = allRuns.filter((run) => run.status === "completed").map((run) => run.runId);
    expect(matchingIds).toHaveLength(3);

    const firstPage = await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["list", "--status", "completed", "--limit", "2"]),
      new AbortController().signal,
    ) as { items: { runId: string; status: string }[]; cursor?: string };
    expect(firstPage.items.map((run) => run.runId)).toEqual(matchingIds.slice(0, 2));
    expect(firstPage.items.every((run) => run.status === "completed")).toBe(true);
    expect(firstPage.cursor).toBe(matchingIds[1]);

    const secondPage = await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["list", "--status", "completed", "--limit", "2", "--cursor", firstPage.cursor!]),
      new AbortController().signal,
    ) as { items: { runId: string; status: string }[]; cursor?: string };
    expect(secondPage.items.map((run) => run.runId)).toEqual(matchingIds.slice(2));
    expect(secondPage.items.every((run) => run.status === "completed")).toBe(true);
    expect(secondPage.cursor).toBeUndefined();
    expect(Object.keys(firstPage).sort()).toEqual(["cursor", "items"]);
  });
  test("CLI rejects unknown options and missing values", () => {
    expect(() => parseWorkflowArgs(["run", "--secret-mode"])).toThrow();
    expect(() => parseWorkflowArgs(["run", "--feature"])).toThrow();
  });
  test("scoped cancellation terminates only owned processes", async () => {
    const scope = new ProcessScope(); const controller = new AbortController();
    const unrelated = Bun.spawn([process.execPath, "-e", "setTimeout(()=>{},5000)"], { stdout: "ignore", stderr: "ignore" });
    try {
      const result = scope.execute(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd: tmpdir(), env: process.env, timeoutMs: 15000, signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      expect((await result).cancelled).toBe(true); expect(unrelated.exitCode).toBeNull();
    } finally { unrelated.kill("SIGKILL"); await unrelated.exited; await scope.stop(); }
  }, 10000);
});

test("regression: interrupted task check is repeated before opening dependent gate", async () => {
  const { service, executor, root } = setup();
  const taskPolicy = { ...policy, checks: policy.checks.map(c => ({ ...c, scope: "task" as const })) };
  const original = executor.execute.bind(executor);
  let dependentStartedWithoutPass = false;
  executor.execute = async request => {
    if (request.task?.id === "T002") {
      dependentStartedWithoutPass = !service.store.checks(request.runId).some(c => c.check_id === "check" && c.status === "passed");
      writeFileSync(join(root, "dependent.txt"), "dependent");
      return { output: { schemaVersion: 1, taskId: "T002", outcome: "implemented", summary: "dependent", evidenceIds: [], unresolved: [] }, inputTokens: 20, outputTokens: 30 };
    }
    const result = await original(request);
    if (request.profile.output === "plan") {
      const p = PlanSchema.parse(result.output);
      p.taskGraph.tasks[0]!.checkIds = ["check"];
      p.taskGraph.tasks.push({ ...p.taskGraph.tasks[0]!, id: "T002", dependsOn: ["T001"], writes: [{ path: "dependent.txt", action: "create" }], checkIds: [] });
      result.output = p;
    }
    return result;
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "review", policy: taskPolicy });
  await service.drive(run.runId, new AbortController().signal);
  await approve(service, run.runId);
  const checks = service.scheduler.checks.run.bind(service.scheduler.checks);
  let interrupt = true;
  service.scheduler.checks.run = async (...args) => {
    if (interrupt) { interrupt = false; throw new Error("injected interruption before task check"); }
    return checks(...args);
  };
  await service.drive(run.runId, new AbortController().signal);
  expect(service.store.tasks(run.runId).find(t => t.id === "T001")?.status).toBe("implemented");
  expect(service.store.checks(run.runId)).toHaveLength(0);
  await service.drive(run.runId, new AbortController().signal);
  expect(dependentStartedWithoutPass).toBe(false);

});

test("regression: trusted recovery cancellation preserves history and releases stale ownership", async () => {
  const { service } = setup(); const { run } = await start(service);
  const step = service.store.beginStep(run.runId, "crashed-check");
  const attempt = service.store.reserve(run.runId, step, null, 0, policy);
  const effect = service.store.prepareEffect(run.runId, attempt, "command", { checkId: "check" }, null, null);
  service.store.putLease({ resource: "execution", owner_id: "dead-owner", owner_epoch: 1, run_id: run.runId, expires_at: 0, process_identity_json: JSON.stringify({ pid: 2147483647 }) });
  const resumed = await service.resume(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision });
  const request = service.store.requests(run.runId).find(r => r.kind === "recovery")!;
  expect(request).toBeDefined();
  const cancelled = await service.decide(run.runId, { commandId: newId(), expectedRevision: resumed.revision }, { kind: "recovery", requestId: request.id, effectId: effect, resolution: "cancel", evidence: "Process is stopped, abandon run" });
  expect(cancelled.status).toBe("cancelled");
  const next = await start(service);
  expect((await service.drive(next.run.runId, new AbortController().signal)).reason).toBe("approval");
  expect(service.store.effects(run.runId).find((item) => item.id === effect)?.status).toBe("prepared");
  await expect(service.resume(run.runId, { commandId: newId(), expectedRevision: cancelled.revision })).rejects.toThrow("Terminal runs");

});

test("regression: heartbeat failure retains ownership until child stops", async () => {
  const { service, root, config } = setup(); const { run } = await start(service);
  service.leases.acquire("execution", run.runId);
  service.leases.acquire("mutation", run.runId);
  let started!: () => void;
  const spawned = new Promise<void>(resolve => { started = resolve; });
  let ended = false;
  const processResult = service.scheduler.processes.execute(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: root, env: process.env, timeoutMs: 5000, signal: new AbortController().signal, onSpawn: () => started() }).finally(() => { ended = true; });
  await spawned;
  const db = new Database(service.store.path);
  const competitor = new NativeWorkflowService(root, config, new FixtureExecutor(root));
  try {
    db.exec("CREATE TRIGGER injected_heartbeat_failure BEFORE INSERT ON workspace_leases BEGIN SELECT RAISE(FAIL, 'injected heartbeat write failure'); END;");
    Reflect.get(service.leases, "heartbeat").call(service.leases);
    db.exec("DROP TRIGGER injected_heartbeat_failure");
    expect(() => competitor.leases.acquire("execution", run.runId)).toThrow("owned");
    expect(() => competitor.leases.acquire("mutation", run.runId)).toThrow("owned");
    expect(service.leases.signal.aborted).toBe(true);
    expect(ended).toBe(false);
    expect(service.store.lease("mutation")?.owner_id).toBe(service.leases.owner);

  } finally {
    await service.scheduler.processes.stop(); await processResult; competitor.close(); db.close();
  }
});

describe("execution root (parallel worktrees phase 0)", () => {
  test("checks and tool paths resolve inside an explicit root, not the project workspace", async () => {
    const { service, root } = setup(); const { run } = await start(service);
    const tree = mkdtempSync(join(tmpdir(), "baked-worktree-"));
    cleanups.push(() => rmSync(tree, { recursive: true, force: true }));
    writeFileSync(join(tree, "value.txt"), "ready");
    writeFileSync(join(root, "value.txt"), "broken");
    const step = service.store.beginStep(run.runId, "fixture"); const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    const check = { ...policy.checks[0]!, args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"] };
    const scope = new ProcessScope();
    try {
      expect((await new CheckRunner(service.store, scope).run(run.runId, attempt, check, new AbortController().signal)).status).toBe("failed");
      expect((await new CheckRunner(service.store, scope).run(run.runId, attempt, check, new AbortController().signal, tree)).status).toBe("passed");
    } finally { await scope.stop(); }
    service.store.transaction(() => service.store.transition(run.runId, "running"));
    const profile = JSON.parse(service.store.run(run.runId).profiles_json).find((p: { id: string }) => p.id === "reviewer");
    const guard = new WorkflowToolPolicy(service.store, service.leases, run.runId, "test", profile, policy, undefined, tree);
    expect(guard.path(join(tree, "src", "a.ts"))).toBe("src/a.ts");
    expect(() => guard.path(join(root, "value.txt"))).toThrow();
    expect(() => guard.path(".baked/workflows.sqlite")).toThrow("Protected");
  });
});

describe("full disk during file writes", () => {
  test("a workspace or evidence write that runs out of space leaves no partial file and no false evidence", async () => {
    const { spyOn } = await import("bun:test");
    const { existsSync, readdirSync } = await import("node:fs");
    const { fileWriter } = await import("../src/core/workflows/atomic-write.js");
    const { service, root } = setup(); const { run } = await start(service);
    writeFileSync(join(root, "value.txt"), "before");
    const step = service.store.beginStep(run.runId, "publication");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    service.leases.acquire("mutation", run.runId);
    const tempFiles = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tmp")) : [];
    // Like a real full disk: part of the content lands in the temp file, then the write fails.
    const write = spyOn(fileWriter, "writeFileSync").mockImplementation((path, data) => {
      writeFileSync(path as string, String(data).slice(0, 8));
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    try {
      expect(() => service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"))).toThrow("ENOSPC");
      expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("before");
      expect(tempFiles(root)).toEqual([]);
      expect(service.store.effects(run.runId)[0]?.status).toBe("unknown");
      const artifacts = service.store.artifacts(run.runId).length;
      expect(() => service.store.transaction(() => service.store.artifact(run.runId, "check", "checks/big.json", "x".repeat(300 * 1024)))).toThrow("ENOSPC");
      expect(service.store.artifacts(run.runId).length).toBe(artifacts);
      expect(tempFiles(join(root, ".baked", "workflow-runs"))).toEqual([]);
    } finally { write.mockRestore(); }
    // Reconcile finds the original content, so the write is marked not applied and is safe to retry.
    expect(service.scheduler.journal.reconcile(run.runId)).toEqual([]);
    expect(service.store.effects(run.runId)[0]?.status).toBe("failed");
    service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"));
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("after");
  });
});

// Release gate on a real small volume, e.g. `mount -t tmpfs -o size=8m tmpfs <dir>` on Linux.
const fullVolume = process.env.BAKED_FULL_VOLUME_DIR;
describe.skipIf(!fullVolume)("full disk on a real volume", () => {
  test("running out of space leaves the original file, no temp files and no false evidence", async () => {
    const { existsSync, readdirSync, openSync, writeSync, closeSync, ftruncateSync, fstatSync } = await import("node:fs");
    const { service, root } = setup(false, fullVolume);
    const { run } = await start(service);
    writeFileSync(join(root, "value.txt"), "before");
    const step = service.store.beginStep(run.runId, "publication");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    service.leases.acquire("mutation", run.runId);
    const tempFiles = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tmp")) : [];
    // Fill the volume, then free 256 KiB so SQLite can still commit small rows while 1 MiB writes fail.
    const filler = join(fullVolume!, `filler-${newId()}`);
    const fd = openSync(filler, "w");
    try {
      const chunk = Buffer.alloc(64 * 1024, 1);
      try { for (;;) writeSync(fd, chunk); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe("ENOSPC"); }
      ftruncateSync(fd, Math.max(0, fstatSync(fd).size - 256 * 1024));
      const large = "x".repeat(1024 * 1024);
      expect(() => service.scheduler.journal.publish(run.runId, attempt, "value.txt", large, hashBytes("before"))).toThrow("ENOSPC");
      expect(service.store.effects(run.runId)[0]?.status).toBe("unknown");
      expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("before");
      expect(tempFiles(root)).toEqual([]);
      const artifacts = service.store.artifacts(run.runId).length;
      expect(() => service.store.transaction(() => service.store.artifact(run.runId, "check", "checks/big.json", large))).toThrow(/ENOSPC|SQLITE_FULL|full/i);
      expect(service.store.artifacts(run.runId).length).toBe(artifacts);
      expect(tempFiles(join(root, ".baked", "workflow-runs"))).toEqual([]);
    } finally {
      closeSync(fd);
      rmSync(filler, { force: true });
    }
    // With space back, reconcile marks the unapplied write failed and a retry succeeds.
    expect(service.scheduler.journal.reconcile(run.runId)).toEqual([]);
    expect(service.store.effects(run.runId)[0]?.status).toBe("failed");
    service.scheduler.journal.publish(run.runId, attempt, "value.txt", "after", hashBytes("before"));
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("after");
  });
});

describe("runtime-decided tasks and plan consistency", () => {
  test("a task without writes is closed by its task checks without an agent call", async () => {
    const { service, executor } = setup();
    const original = executor.execute.bind(executor);
    executor.execute = async (request) => {
      const result = await original(request);
      if (request.profile.output === "plan") {
        const plan = PlanSchema.parse(result.output);
        plan.taskGraph.tasks.push({ ...plan.taskGraph.tasks[0]!, id: "T002", title: "Verify value", dependsOn: ["T001"], writes: [], checkIds: ["check"] });
        result.output = plan;
      }
      return result;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create and verify value", ownerLabel: "test", policy: { ...policy, checks: policy.checks.map((c) => ({ ...c, scope: "task" as const })) } });
    await service.drive(run.runId, new AbortController().signal); await approve(service, run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(executor.calls.filter((c) => c === "implementation")).toHaveLength(1);
    expect(service.store.checks(run.runId).filter((c) => c.check_id === "check" && c.status === "passed").length).toBeGreaterThanOrEqual(2);
  });
  test("plan validation rejects IDs the plan names but the graph and spec lack", async () => {
    const { service, executor } = setup();
    const original = executor.execute.bind(executor);
    let feedback: string[] = [];
    executor.execute = async (request) => {
      const result = await original(request);
      if (request.profile.output === "plan") {
        const plan = PlanSchema.parse(result.output);
        plan.markdown += "\nT005 runs the suite for AC-009.";
        plan.taskGraph.planHash = hashBytes(plan.markdown);
        feedback = request.validate?.(plan) ?? [];
        result.output = plan;
      }
      return result;
    };
    const { run } = await start(service);
    await service.drive(run.runId, new AbortController().signal);
    expect(feedback).toContain("plan names T005, which is not in the task graph");
    expect(feedback).toContain("plan names AC-009, which is not in the spec");
    expect(executor.calls).not.toContain("analysis");
  });
  test("analysis stops on mechanical defects without a model call", async () => {
    const { service, executor, root } = setup();
    const scheduler = service.scheduler as unknown as { publish: (...args: unknown[]) => Promise<void> };
    const publish = scheduler.publish.bind(service.scheduler);
    let published = 0;
    scheduler.publish = async (...args) => {
      // The second publication opens analysis; the planned create target appears just before it.
      if (++published === 2) writeFileSync(join(root, "value.txt"), "user file");
      return publish(...args);
    };
    const { run } = await start(service);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.status).toBe("waiting"); expect(waiting.reason).toBe("clarification");
    expect(executor.calls).not.toContain("analysis");
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification");
    expect(request?.body_json).toContain("T001 creates value.txt, which already exists; use modify");
  });
  test("plan consistency requires ordered writers and reachable read hints", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-consistency-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "shared.txt"), "x");
    const task = { id: "T001", title: "A", description: "A", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "shared.txt", action: "modify" as const }], readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "A" };
    const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(""), tasks: [
      task,
      { ...task, id: "T002", readHints: ["new.txt", "later.txt"] },
      { ...task, id: "T003", dependsOn: ["T002"], writes: [{ path: "later.txt", action: "create" as const }, { path: "new.txt", action: "create" as const }], readHints: ["new.txt"] },
    ] };
    expect(planConsistencyProblems(root, spec, "T001 T002 T003 FR-001 AC-001", graph)).toEqual([
      "T002 read hint new.txt does not exist and no earlier task creates it",
      "T002 read hint later.txt does not exist and no earlier task creates it",
      "T001 and T002 both write shared.txt without a dependency between them",
    ]);
  });
});
