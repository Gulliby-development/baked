import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 23, cimatrix 5670e55c T010 (#1144). The README and licence task reads
// the CLI it documents and has no required check of its own. A correction of the CLI invalidated
// it; its rerun found nothing to change, and the run stopped because no required check confirmed
// the work was done, though the files were exactly what its first implementation wrote.
// Since #1211 such a correction no longer reruns the README task's agent; a rerun that does
// happen (its README changed) is still accepted when nothing changed since its first implementation.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "cimatrix", problem: "No CLI", outcome: "A CLI with a README", inScope: ["CLI", "README"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [
    { id: "FR-001", text: "The CLI prints the matrix", priority: "must", verification: "automated", sourceRefs: [] },
    { id: "FR-002", text: "The README documents usage and the licence is MIT", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { id: "AC-001", requirementIds: ["FR-001"], given: "a config", when: "the CLI runs", then: "it prints the matrix", method: "automated" },
    { id: "AC-002", requirementIds: ["FR-002"], given: "the repository", when: "a reader opens it", then: "it has a README with usage and an MIT licence", method: "automated" },
  ],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nA CLI and its README.\n## Decisions\nDEC-001: FR-001 and FR-002 need a CLI and a README.\n## Components\nsrc/cli.ts, README.md\n## Data\nText\n## Verification\nChecks\n## Risks\nNone";
// The project's check is for code; it fails until the CLI is corrected.
const cliCheck: Check = {
  id: "cli",
  executable: "bun",
  args: ["-e", "if (!(await Bun.file('src/cli.ts').text()).includes('matrix')) { console.log('src/cli.ts: prints nothing'); process.exit(1) }"],
  cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [cliCheck] };
const cli: Task = { id: "T001", title: "Implement the CLI", description: "Print the matrix.", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/cli.ts", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Code" };
const docs: Task = { id: "T002", title: "Write README and MIT licence", description: "Document the CLI's usage and add the MIT licence.", requirementIds: ["FR-002"], criterionIds: ["AC-002"], dependsOn: ["T001"], profileId: "implementer", writes: [{ path: "README.md", action: "create" }, { path: "LICENSE", action: "create" }], readHints: ["src/cli.ts"], checkIds: [], origin: "planned", findingIds: [], rationale: "Docs" };

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/cli.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [cli, docs] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        if (task?.writes.some((w) => w.path === "src/cli.ts"))
          // The first implementation forgets the output; the correction adds it.
          writeFileSync(join(this.root, "src/cli.ts"), task.origin === "planned" ? "export {};\n" : 'console.log("matrix");\n');
        else {
          // The README describes the CLI's usage, which the correction does not change.
          writeFileSync(join(this.root, "README.md"), "# cimatrix\n\nUsage: cimatrix CONFIG\n");
          writeFileSync(join(this.root, "LICENSE"), "MIT\n");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: spec.criteria.map((c) => ({ criterionId: c.id, verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" })), findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: cimatrix 5670e55c, a no-op rerun of a README task without a required check (#1144)", () => {
  test("the rerun is accepted because its files are what its first implementation wrote", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-noop-docs-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build cimatrix with a README and an MIT licence", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    const docsRow = service.store.tasks(run.runId).find((t) => t.id === "T002");
    // The correction of the CLI changed none of the README task's files: the task kept its
    // implementation and its agent ran once (idpeek a270ff5a reran it twice for 645k tokens, #1211).
    expect(executor.implemented.some((id) => !["T001", "T002"].includes(id))).toBe(true);
    expect(docsRow?.generation).toBe(0);
    expect(executor.implemented.filter((id) => id === "T002")).toHaveLength(1);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("Usage");

    // A rerun that does happen (a corrective changed its README) and finds the files as its
    // first implementation wrote them is accepted; a file changed since the task wrote it still
    // needs a check to show the work is done.
    service.store.taskStatus(run.runId, "T002", "invalidated");
    const satisfied = () => {
      const child = service.store.beginStep(run.runId, "implement-rerun");
      return (service.scheduler as unknown as { correctionSatisfied: (...args: unknown[]) => Promise<true | string> })
        .correctionSatisfied(run.runId, service.store.state(run.runId), child, policy, docs, { taskId: "T002", outcome: "implemented", unresolved: [] }, new AbortController().signal, root);
    };
    expect(await satisfied()).toBe(true);
    writeFileSync(join(root, "README.md"), "# cimatrix\n");
    expect(await satisfied()).toBe("it changed none of its files and no required check of it confirms the work is already done");
  }, 60000);
});
