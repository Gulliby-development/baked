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

// Scenario of bench round 17, structpad-update 6d048155 (#1001). The checks pass and the review
// raises one low finding about README wording (two backslashes in a table). It started a corrective
// task that cost 663k tokens over three attempts and stopped on the attempt cap. With the policy's
// `lowFindings: "note"` the finding is a review note and the run completes without a correction;
// without the setting it is repaired as before.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Table docs", problem: "The table is undocumented", outcome: "The README documents the table", inScope: ["Document the table"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The README documents the table", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the README", when: "it is read", then: "the table is documented", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne README.\n## Decisions\nDEC-001: FR-001 is one README section.\n## Components\nREADME.md\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "await Bun.file('README.md').text()"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned: Task = { id: "T001", title: "Write README.md", description: "Write README.md", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "README.md", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };

class ScriptedExecutor implements AgentExecutor {
  corrections: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { dimension?: string; evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["README.md"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        if (task?.origin !== "planned") this.corrections.push(task?.id ?? "");
        writeFileSync(join(this.root, "README.md"), task?.origin === "planned" ? "| a \\\\| b |" : "| a \\| b |");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote README.md", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": {
        const doubled = readFileSync(join(this.root, "README.md"), "utf8").includes("\\\\");
        if (data.extra.dimension !== "correctness" || !doubled) { output = pass; break; }
        const finding = { id: "F001", kind: "contradicts", severity: "low", basis: "spec", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "README.md", symbol: null, evidenceIds, claim: "The README table escapes the pipe with two backslashes", impact: "The table renders a stray backslash", suggestedFix: "Use one backslash" };
        output = { ...pass, findings: [finding] };
        break;
      }
      case "convergence": output = pass; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(policy: RunPolicy) {
  const root = mkdtempSync(join(tmpdir(), "baked-structpad-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Document the table", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { done, executor, notes: service.store.state(started.runId).reviewNotes };
}

describe("scenario: structpad-update 6d048155, a low README finding (#1001)", () => {
  test("with lowFindings note the low finding is a review note and starts no correction", async () => {
    const { done, executor, notes } = await run({ ...defaultWorkflowPolicy, checks: [check], lowFindings: "note" });
    expect(done.status).toBe("completed");
    expect(executor.corrections).toEqual([]);
    expect(notes.map((n) => [n.findingId, n.reason])).toEqual([["F001", "severity"]]);
  });

  test("without the setting the low finding is repaired as before", async () => {
    const { done, executor } = await run({ ...defaultWorkflowPolicy, checks: [check] });
    expect(done.status).toBe("completed");
    expect(executor.corrections).toHaveLength(1);
  });
});
