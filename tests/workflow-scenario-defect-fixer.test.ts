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

// Scenario of bench round 16, mdrefs d2b6bfb4 (#969). A test task reports formatting differences
// in another task's file; the run's required `fmt` check fails on that file and declares a fixer
// (`cargo fmt` there). Defect routing turned the failure into corrective tasks (1.8M tokens) for
// what the fixer settles mechanically. It now runs the fixer, journaled as `apply_fix`, and reruns
// the check; only a check that still fails becomes a corrective task.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Markdown refs", problem: "Values are missing", outcome: "Values exist", inScope: ["Create values"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Values are ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the tasks complete", then: "the values are ready", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nTwo sources and a test.\n## Decisions\nDEC-001: FR-001 needs both values.\n## Components\nvalue.txt, other.txt\n## Data\nText\n## Verification\nFormat check\n## Risks\nNone for fixture";
// The check rejects trailing whitespace, which its fixer removes, and the word BAD, which it cannot.
const fmt: Check = {
  id: "fmt",
  executable: "bun",
  args: ["-e", "const t = await Bun.file('other.txt').text(); if (t !== t.trim() || t.includes('BAD')) { console.log('Diff in other.txt'); process.exit(1) }"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
  fix: { executable: "bun", args: ["-e", "const f = process.argv.at(-1); await Bun.write(f, (await Bun.file(f).text()).trim())"] },
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [fmt] };
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  implemented: string[] = [];
  constructor(
    private root: string,
    private other: string,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt", "other.txt"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", "value.txt"), planned("T002", "other.txt"), planned("T003", "other.test.txt", ["T001", "T002"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task;
        this.implemented.push(task?.id ?? "");
        let summary = "Wrote the file";
        if (task?.id === "T001") writeFileSync(join(this.root, "value.txt"), "ready");
        else if (task?.id === "T002") writeFileSync(join(this.root, "other.txt"), this.other);
        else if (task?.id === "T003") {
          writeFileSync(join(this.root, "other.test.txt"), "expects fine");
          summary = "fmt fails on pre-existing formatting differences in other.txt, outside this task's write scope.";
        } else writeFileSync(join(this.root, "other.txt"), "fine");
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

async function runToEnd(other: string) {
  const root = mkdtempSync(join(tmpdir(), "baked-mdrefs-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, other);
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
  const defects = service.store.latestArtifact(run.runId, "tasks/defects/T003.json");
  const fixes = service.store
    .effects(run.runId)
    .filter((e) => e.kind === "file_patch" && JSON.parse(e.intent_json).tool === "apply_fix")
    .map((e) => JSON.parse(e.intent_json) as { path: string; checkId: string; taskId: string });
  return { root, executor, row: service.store.run(run.runId), status: done.status, defects, fixes };
}

describe("scenario: mdrefs d2b6bfb4, defect routing runs the check's fixer first (#969)", () => {
  test("a reported formatting defect is fixed by the host and starts no corrective task", async () => {
    const { root, executor, row, status, defects, fixes } = await runToEnd("fine  \n");
    expect(status).toBe("completed");
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("fine");
    expect(row.corrective_tasks).toBe(0);
    expect(executor.implemented).toEqual(["T001", "T002", "T003"]);
    expect(fixes).toContainEqual(expect.objectContaining({ path: "other.txt", checkId: "fmt", taskId: "T002" }));
    expect(JSON.parse(defects?.inline_content ?? "{}")).toMatchObject({
      files: ["other.txt"],
      checks: [{ checkId: "fmt", status: "passed", fixed: true }],
      findings: [],
    });
  });

  test("a check that still fails after its fixer becomes a corrective task of the owner", async () => {
    const { root, executor, row, status, fixes } = await runToEnd("fine BAD  \n");
    expect(status).toBe("completed");
    expect(readFileSync(join(root, "other.txt"), "utf8")).toBe("fine");
    expect(row.corrective_tasks).toBe(1);
    expect(executor.implemented.slice(0, 3)).toEqual(["T001", "T002", "T003"]);
    expect(executor.implemented).toHaveLength(4);
    expect(fixes).toContainEqual(expect.objectContaining({ path: "other.txt", checkId: "fmt", taskId: "T002" }));
  });
});
