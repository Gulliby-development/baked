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

// Scenario of bench round 30, zonevet cc41bbb9 and ecfit 25614519 (#1248). The checks stage
// fails two feature checks and starts two correctives. The first one lands and invalidates a
// finished task that reads its file; that task's declared feature checks run in the host before
// its agent, but the second corrective has not run yet, so the whole-project check is still red
// and the agent reruns a task that was already right (1.07M tokens across two runs).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "zonevet", problem: "No checker", outcome: "A checker", inScope: ["Checker"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "The checker validates zones", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a zone", when: "the checker runs", then: "it reports problems", method: "automated" }],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nThree modules.\n## Decisions\nDEC-001: FR-001 needs a parser, an address module and a report.\n## Components\na.ts, b.ts, c.ts\n## Data\nText\n## Verification\nChecks\n## Risks\nNone";
// Whole-project checks, as `pytest -q` and `go test ./...` are: each fails until its module is corrected.
const check = (id: string, file: string): Check => ({
  id,
  executable: "bun",
  args: ["-e", `if (!(await Bun.file('${file}').text()).includes('v2')) { console.log('${file}: expected v2'); process.exit(1) }`],
  cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [],
});
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check("parse", "a.ts"), check("addr", "b.ts")] };
const planned = (id: string, path: string, extra: Partial<Task> = {}): Task => ({ id, title: `Write ${path}`, description: `Write ${path}.`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Code", ...extra });
const tasks = [
  planned("T001", "a.ts", { checkIds: ["parse"] }),
  planned("T002", "b.ts", { checkIds: ["addr"] }),
  // The report reads the parser and declares both whole-project checks.
  planned("T003", "c.ts", { dependsOn: ["T001"], readHints: ["a.ts"], checkIds: ["parse", "addr"] }),
];

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["a.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        // The planned modules are written as v1; a correction writes v2.
        for (const write of task?.writes ?? [])
          writeFileSync(join(this.root, write.path), task?.origin === "planned" ? `export const v = "v1"; // ${task.id}\n` : `export const v = "v2";\n`);
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

describe("scenario: zonevet cc41bbb9, a dependent invalidated while another corrective is pending (#1248)", () => {
  test("the dependent waits for the pending corrective and is settled by its checks without its agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-rerun-after-correctives-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build zonevet", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toContain("v2");
    expect(readFileSync(join(root, "b.ts"), "utf8")).toContain("v2");
    // Both modules were corrected, and the corrective of the parser invalidated the report.
    expect(executor.implemented.filter((id) => !["T001", "T002", "T003"].includes(id))).toHaveLength(2);
    const report = service.store.tasks(run.runId).find((t) => t.id === "T003");
    expect(report?.generation).toBeGreaterThan(0);
    // The report's agent ran once: its checks settled the invalidation after both correctives.
    expect(executor.implemented.filter((id) => id === "T003")).toHaveLength(1);
    expect(readFileSync(join(root, "c.ts"), "utf8")).toContain("T003");
  }, 60000);
});
