import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, Repro, Review, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 14, cfgtrace2 e88a14dd (#930). The checks pass, then the convergence
// walker fails a criterion on a static medium correctness claim (an integer above 4300 digits
// raises) with noRepro "run_repro is not available". Before the fix the walker was not offered
// run_repro, the claim started a corrective task (about 1.1M tokens for two such claims) and the
// run blocked in it. Now the walker gets run_repro, and a medium claim the host does not reproduce
// starts no correction: it is a known limitation of the criterion it fails.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Dotenv values", problem: "Values are not parsed", outcome: "Values are parsed", inScope: ["Parse values"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Integer values are parsed", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a dotenv file", when: "it is parsed", then: "integer values are parsed", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne parser.\n## Decisions\nDEC-001: FR-001 parses integers.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('value.txt').text(); if (!t.includes('ready')) { console.log('AssertionError'); process.exit(1) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned: Task = { id: "T001", title: "Write value.txt", description: "Write value.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
// Prints how value.txt handles a very long integer: "handled" once a correction added it.
const bigRepro: Repro = { executable: "bun", args: ["-e", "const t = await Bun.file('value.txt').text(); console.log(t.includes('big') ? 'handled' : 'raises')"], expected: "handled", actual: "raises" };

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  convergence: ExecutionRequest[] = [];
  advice: string[] = [];
  constructor(
    private root: string,
    private claim: Partial<Review["findings"][number]>,
    /** lockorder 6487b225 (#1225): a repair round first, then an inconclusive convergence. */
    private afterRepair = false,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        writeFileSync(join(this.root, "value.txt"), task?.origin !== "planned" ? "ready big" : this.afterRepair ? "pending" : "ready");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] }; break;
      case "convergence": {
        this.convergence.push(request);
        if (!this.afterRepair && readFileSync(join(this.root, "value.txt"), "utf8").includes("big")) {
          output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
          break;
        }
        const finding = { id: "F-003", kind: "correctness", severity: "medium", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds, claim: "A valid unquoted decimal integer can raise an uncaught ValueError", impact: "Parsing a long integer fails", suggestedFix: "Handle integers above the conversion limit", ...this.claim };
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [{ criterionId: "AC-001", verdict: this.afterRepair ? "inconclusive" : "fail", evidenceIds, explanation: "Long integers raise" }], findings: [finding] };
        // The agent executor runs the stage's validation on submit_result; the walker keeps its
        // answer after the advice, as the cfgtrace2 walker would have.
        this.advice.push(...(request.validate?.(output) ?? []));
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(claim: Partial<Review["findings"][number]>, afterRepair = false) {
  const root = mkdtempSync(join(tmpdir(), "baked-cfgtrace2-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, claim, afterRepair);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Parse dotenv integers", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { done, executor, service, runId: started.runId };
}

describe("scenario: cfgtrace2 e88a14dd, unreproduced convergence findings (#930)", () => {
  test("a static medium claim with a no-tool noRepro is a limitation, not a corrective task", async () => {
    const { done, executor, service, runId } = await run({ noRepro: "run_repro is not available among the exposed tools; static finding based on the default integer conversion limit" });
    // The walker is offered run_repro and told so once.
    const offered = executor.convergence[0];
    expect(offered?.profile.allowedTools).toContain("run_repro");
    expect(offered?.hostTools?.run_repro).toBeDefined();
    expect(executor.advice.join("\n")).toContain("offers run_repro");
    expect(done.status).toBe("completed");
    expect(executor.implemented).toEqual(["T001"]);
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    // The claim failed AC-001, so it is accepted as a known limitation the run report names.
    const limitations = service.store.state(runId).limitations;
    expect(limitations.map((l) => [l.decidedBy, l.criterionIds])).toEqual([["repro", ["AC-001"]]]);
  });

  test("a medium claim whose repro the host refutes starts no correction", async () => {
    const { done, service, runId } = await run({ repro: { ...bigRepro, actual: "overflows" } });
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).corrective_tasks).toBe(0);
    expect(service.store.state(runId).limitations.map((l) => l.decidedBy)).toEqual(["repro"]);
  });

  test("after a repair round, the only unreproduced claim on an inconclusive criterion is a limitation (#1225)", async () => {
    // lockorder 6487b225 (bench round 27): medium is below the repair floor after the first round
    // (here a failed check's repair), so the claim repaired only through its inconclusive
    // criterion. That criterion left the failing set before the claim was recorded, and acceptance
    // threw "Criterion AC-005 did not pass" after all 17 tasks were done.
    const { done, service, runId } = await run({ confidence: 0.99, noRepro: "the runner accepts only dotnet arguments, not stdin content" }, true);
    expect(service.store.run(runId).corrective_tasks).toBe(1);
    expect(done.status).toBe("completed");
    const limitations = service.store.state(runId).limitations;
    expect(limitations.map((l) => [l.decidedBy, l.criterionIds])).toEqual([["repro", ["AC-001"]]]);
  });

  test("a medium claim the host reproduces still starts a correction", async () => {
    const { done, executor, service, runId } = await run({ repro: bigRepro });
    expect(done.status).toBe("completed");
    expect(executor.implemented).toHaveLength(2);
    expect(service.store.run(runId).corrective_tasks).toBe(1);
    expect(readFileSync(join(service.store.workspace, "value.txt"), "utf8")).toBe("ready big");
    expect(service.store.latestArtifact(runId, "repro")).toBeDefined();
  });
});
