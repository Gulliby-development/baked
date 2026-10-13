import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runActions } from "../src/components/workflow/format.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";

// Bench round 16 (#971): a person edited a file while the run was stopped, and the run blocked on
// input_changed with only "restore or fork" as ways out. Resuming with acceptWorkspace keeps the
// edit, records who accepted it, and continues from where the run stopped.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Ready value", problem: "The value is missing", outcome: "The value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value.txt holds ready", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne value.\n## Decisions\nDEC-001: FR-001 writes value.txt.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nThe value check\n## Risks\nNone for fixture";
const check: Check = { id: "value", executable: "bun", args: ["-e", "if ((await Bun.file('value.txt').text()) !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };
const task: Task = { id: "T001", title: "Write value.txt", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };

class ScriptedExecutor implements AgentExecutor {
  implementations = 0;
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const coverage = () => [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        this.implementations += 1;
        writeFileSync(join(this.root, "value.txt"), "ready");
        output = { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [] };
        break;
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: coverage(), findings: [] }; break;
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: coverage(), findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

/** A run approved and then blocked because a person wrote notes.md in the workspace. */
async function blocked() {
  const root = mkdtempSync(join(tmpdir(), "baked-accept-workspace-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "README.md"), "fixture\n");
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create the ready value in value.txt.", ownerLabel: "test", policy });
  const runId = started.runId;
  await service.drive(runId, new AbortController().signal);
  const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  writeFileSync(join(root, "README.md"), "fixture, edited by a person\n");
  const stopped = await service.drive(runId, new AbortController().signal);
  return { root, executor, service, runId, stopped };
}

describe("scenario: a person's edit while the run is stopped (#971)", () => {
  test("the block names the changed file and how to keep it", async () => {
    const { service, runId, stopped, executor } = await blocked();
    expect(stopped).toMatchObject({ status: "blocked", reason: "input_changed" });
    expect(executor.implementations).toBe(0);
    const diagnostic = service.store.artifacts(runId).filter((a) => a.kind === "diagnostic").at(-1);
    const text = diagnostic ? service.store.readArtifact(runId, diagnostic.id) : "";
    expect(text).toContain("README.md");
    expect(text).toContain("--accept-workspace");
    expect((await service.outsideChanges(runId)).map((c) => c.path)).toEqual(["README.md"]);
    expect(runActions(stopped).map((a) => a.action)).toContain("accept-workspace");
  });

  test("a plain resume blocks again; accepting keeps the edit and the run continues", async () => {
    const { root, service, runId, executor } = await blocked();
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision });
    expect(await service.drive(runId, new AbortController().signal)).toMatchObject({ status: "blocked", reason: "input_changed" });
    await service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { acceptWorkspace: true });
    const done = await service.drive(runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(executor.implementations).toBe(1);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("fixture, edited by a person\n");
    const accepted = service.store.artifacts(runId).filter((a) => a.kind === "recovery" && a.logical_path.startsWith("operator/accepted-workspace-"));
    expect(accepted).toHaveLength(1);
    const record = JSON.parse(service.store.readArtifact(runId, accepted[0]!.id)) as { acceptedBy: string; changes: { path: string }[] };
    expect(record).toMatchObject({ acceptedBy: "operator", changes: [{ path: "README.md" }] });
  });

  test("accepting with nothing changed outside the run is refused", async () => {
    const { root, service, runId } = await blocked();
    writeFileSync(join(root, "README.md"), "fixture\n");
    await expect(service.resume(runId, { commandId: newId(), expectedRevision: (await service.get(runId)).revision }, { acceptWorkspace: true })).rejects.toThrow("no outside changes");
  });

  test("the headless CLI takes --accept-workspace on resume", () => {
    const args = parseWorkflowArgs(["resume", "RUN", "--expected-revision", "3", "--accept-workspace"]);
    expect(args.flags["accept-workspace"]).toBe(true);
  });
});
