import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 23, mdtoc-update 20f81464 (#1143). Every check passes, then the
// convergence walker marks AC-001 fail, explains why in the coverage, and names no finding. The
// host threw OUTPUT_INVALID "Coverage is incomplete without an actionable finding" after the
// attempt was accepted, and the run ended blocked with no chance for the walker to add it. Now the
// walker is told once inside its attempt; a walker that keeps its answer gets a finding from its
// own explanation, and the run repairs.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Table of contents", problem: "No table of contents", outcome: "A table of contents is written", inScope: ["Write a table of contents"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Nested headings are listed", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a document with nested headings", when: "the table is written", then: "nested headings are listed", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne writer.\n## Decisions\nDEC-001: FR-001 lists headings.\n## Components\ntoc.txt\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "if (!(await Bun.file('toc.txt').text()).includes('ready')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check] };
const planned: Task = { id: "T001", title: "Write toc.txt", description: "Write toc.txt", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "toc.txt", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
const explanation = "Nested headings are not listed: toc.txt only has the top level";

class ScriptedExecutor implements AgentExecutor {
  implemented: { id: string; claims: string[] }[] = [];
  advice: string[] = [];
  constructor(
    private root: string,
    private addsFinding: boolean,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; findings?: { claim: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["toc.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push({ id: task?.id ?? "", claims: JSON.stringify(data.extra).match(/Nested headings are not listed[^"]*/g) ?? [] });
        writeFileSync(join(this.root, "toc.txt"), task?.origin === "planned" ? "ready" : "ready nested");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote toc.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] }; break;
      case "convergence": {
        if (readFileSync(join(this.root, "toc.txt"), "utf8").includes("nested")) {
          output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Nested headings are listed" }], findings: [] };
          break;
        }
        // The mdtoc-update walker: the criterion fails, the explanation says why, no finding.
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "inconclusive", coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds, explanation }], findings: [] };
        // The agent executor runs the stage's validation on submit_result and hands the errors back.
        const errors = request.validate?.(output) ?? [];
        this.advice.push(...errors);
        if (errors.length && this.addsFinding)
          output = { ...(output as object), verdict: "changes_requested", findings: [{ id: "F-001", kind: "missing", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "toc.txt", symbol: null, evidenceIds, claim: explanation, impact: "The table misses nested headings", suggestedFix: "List nested headings" }] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(addsFinding: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-mdtoc-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, addsFinding);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write a table of contents", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { done, executor, service, runId: started.runId };
}

describe("scenario: mdtoc-update 20f81464, a failed criterion without a finding (#1143)", () => {
  test("the walker is told inside its attempt and adds the finding, and the run repairs", async () => {
    const { done, executor, service, runId } = await run(true);
    expect(executor.advice).toHaveLength(1);
    expect(executor.advice[0]).toContain("AC-001 have the verdict fail, but no finding names them");
    expect(done.status).toBe("completed");
    expect(executor.implemented.map((t) => t.id)).toHaveLength(2);
    expect(service.store.run(runId).corrective_tasks).toBe(1);
    expect(readFileSync(join(service.store.workspace, "toc.txt"), "utf8")).toBe("ready nested");
  });

  test("a walker that keeps its answer gets a finding from its explanation, not invalid_output", async () => {
    const { done, executor, service, runId } = await run(false);
    expect(executor.advice).toHaveLength(1);
    expect(done.status).toBe("completed");
    expect(service.store.run(runId).corrective_tasks).toBe(1);
    // The correction carries the walker's explanation as its claim.
    expect(executor.implemented[1]?.claims[0]).toStartWith(explanation);
  });
});
