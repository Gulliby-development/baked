import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { correctionTitle } from "../src/core/verification/convergence.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 23, cimatrix 5670e55c (#1146). A test task reports a defect in the
// renderer, and the host routes it to the renderer's owner. Before that correction runs, the
// README task finishes and its account names the same red tests and the renderer. Before the fix
// the host charged the README task with the failure again: a second finding with the README
// task's requirements and a second corrective task for the one defect.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Matrix", problem: "Output is missing", outcome: "Output renders", inScope: ["Render output", "Document it"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Output renders", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "The README documents it", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a matrix", when: "it renders", then: "the output is fine", method: "automated" }, { id: "AC-002", requirementIds: ["FR-002"], given: "the repository", when: "the README is read", then: "it documents the output", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA renderer, its test and a README.\n## Decisions\nDEC-001: FR-001 in render.txt.\n## Components\nrender.txt, render.test.txt, README.md\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "const r = await Bun.file('render.txt').text(); if (r !== 'fine') { console.log('--- FAIL: TestJSON (0.00s)'); console.log('--- FAIL: TestParseArgsHelp (0.00s)'); process.exit(1) }"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [tests] };
const planned = (id: string, path: string, requirement: string, criterion: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: [requirement], criterionIds: [criterion], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const plan = [planned("T001", "render.txt", "FR-001", "AC-001"), planned("T002", "render.test.txt", "FR-001", "AC-001", ["T001"]), planned("T003", "README.md", "FR-002", "AC-002", ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  titles: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["render.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: plan } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        let summary = "Wrote the file";
        if (task?.id === "T001") writeFileSync(join(this.root, "render.txt"), "keys without values");
        else if (task?.id === "T002") {
          writeFileSync(join(this.root, "render.test.txt"), "expects fine");
          summary = "TestJSON fails: render.txt emits keys without values; render.txt is outside this task's write scope.";
        } else if (task?.id === "T003") {
          writeFileSync(join(this.root, "README.md"), "# Matrix\n");
          summary = "Wrote the README. The tests check is still red for TestJSON and TestParseArgsHelp in render.txt, which this task does not write.";
        } else {
          this.titles.push(task?.title ?? "");
          writeFileSync(join(this.root, "render.txt"), "fine");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: ["AC-001", "AC-002"].map((criterionId) => ({ criterionId, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: cimatrix 5670e55c, a README task and failures already in correction (#1146)", () => {
  test("a failure an open finding names is not charged to the reporting task again", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-cimatrix-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Render the matrix and document it", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "render.txt"), "utf8")).toBe("fine");
    // The README task ran while the renderer's correction was still to come.
    expect(executor.implemented.indexOf("T003")).toBeLessThan(executor.implemented.indexOf("T004"));
    // One defect, one correction: the README task's report attached to the open finding.
    expect(service.store.run(run.runId).corrective_tasks).toBe(1);
    const report = JSON.parse(service.store.readArtifact(run.runId, service.store.latestArtifact(run.runId, "tasks/defects/T003.json")?.id ?? "")) as { findings: string[]; covered?: { checkId: string }[] };
    expect(report.findings).toEqual([]);
    expect(report.covered?.[0]?.checkId).toBe("tests");
    // The corrective task is titled by what its finding claims, not by the finding's id.
    expect(executor.titles[0]).toBe("Correct: Required check tests failed (render.txt)");
  });

  test("a corrective title names the claim and how many more findings it carries", () => {
    expect(correctionTitle([{ claim: "Required check tests failed", file: "internal/render/render.go" }])).toBe("Correct: Required check tests failed (internal/render/render.go)");
    expect(correctionTitle([{ claim: "Task T007 required check tests failed", file: null }, { claim: "Another", file: null }])).toBe("Correct: Task T007 required check tests failed and 1 more");
    expect(correctionTitle([{ claim: "x".repeat(200), file: null }]).length).toBeLessThan(140);
  });
});
