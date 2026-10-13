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

// Scenario of bench round 13, cfgtrace 276e4858 (#839). Two source tasks each fail their own lint
// check once, so two task-level corrections run during the implement stage; the second correction
// leaves a defect in its file. A test task then reports that defect in a file it may not write.
// Before the fix both corrections spent the two repair rounds, nothing acted on the test task's
// report, and the checks stage stopped with `no_progress ... maxRepairRounds (2)`.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Config trace", problem: "Values are missing", outcome: "Values exist", inScope: ["Create values"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Values are ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the tasks complete", then: "the values are ready", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nTwo sources and a test.\n## Decisions\nDEC-001: FR-001 needs both values.\n## Components\nvalue.txt, other.txt\n## Data\nText\n## Verification\nLint and tests\n## Risks\nNone for fixture";
const bun = (script: string, id: string, scope: "task" | "feature"): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope, envNames: [], writes: [] });
const lint = (file: string, id: string) =>
  bun(`const t = await Bun.file(${JSON.stringify(file)}).text(); if (t.includes("LINT")) { console.log("${file}: lint error"); process.exit(1) }`, id, "task");
const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  maxRepairRounds: 2,
  checks: [
    lint("value.txt", "lint-value"),
    lint("other.txt", "lint-other"),
    bun("const v = await Bun.file('value.txt').text(); const o = await Bun.file('other.txt').text(); if (v !== 'ready' || o !== 'fine') { console.log('AssertionError: expected fine'); process.exit(1) }", "tests", "feature"),
  ],
};
const planned = (id: string, path: string, checkIds: string[], dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt", "other.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", "value.txt", ["lint-value"]), planned("T002", "other.txt", ["lint-other"]), planned("T003", "other.test.txt", [], ["T001", "T002"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        const writes = task?.writes.map((w) => w.path) ?? [];
        let summary = "Wrote the file";
        if (task?.id === "T003") {
          writeFileSync(join(this.root, "other.test.txt"), "expects fine");
          summary = "The test fails: other.txt holds wrong where fine is expected; other.txt is outside this task's write scope.";
        } else if (task?.origin === "planned") {
          // Both planned writes fail their lint check.
          const path = writes[0] ?? "";
          writeFileSync(join(this.root, path), path === "value.txt" ? "ready LINT" : "fine LINT");
        } else if (task?.description.includes("lint-value")) {
          writeFileSync(join(this.root, "value.txt"), "ready");
        } else if (task?.description.includes("lint-other")) {
          // The lint correction passes lint but leaves the defect the test task reports.
          writeFileSync(join(this.root, "other.txt"), "wrong");
        } else {
          writeFileSync(join(this.root, "other.txt"), "fine");
        }
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: cfgtrace 276e4858, repair rounds and defect routing (#839)", () => {
  test("task-level corrections spend no repair round and the reported defect reaches its owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-cfgtrace-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create two dependent tasks", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("fine");
    const row = service.store.run(run.runId);
    // Three lint corrections (T004 also runs T002's lint check while other.txt still fails it) and
    // the routed defect: four task-level corrections, no repair round.
    expect(row.repair_rounds).toBe(0);
    expect(row.corrective_tasks).toBe(4);
    // The owner's correction ran right after the test task reported the defect.
    expect(executor.implemented.slice(-2)).toEqual(["T003", "T007"]);
    expect(service.store.latestArtifact(run.runId, "tasks/defects/T003.json")).toBeTruthy();
  });
});
