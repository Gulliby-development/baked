import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { bansPropertyTests, propertyTestsOf } from "../src/core/workflows/quality/properties.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 15, envguard 8b8b7022 and structpad 6c8758ed (#953). Under
// `--clarification assume` a task stopped with spec_conflict whose one side is what the request
// states ("the request's explicit ban on property-based tests"); the run waited for a person, who
// answered "defer to the brief". The request settles it: the task runs again with that decision.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = "Create the ready value in value.txt. Use plain example tests only, no property-based tests.";
const CONFLICT = "AC-001 is marked property, which conflicts with the request's explicit ban on property-based tests.";
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Ready value", problem: "The value is missing", outcome: "The value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value.txt holds ready", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne value.\n## Decisions\nDEC-001: FR-001 writes value.txt.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nThe value check\n## Risks\nNone for fixture";
const check: Check = { id: "value", executable: "bun", args: ["-e", "if ((await Bun.file('value.txt').text()) !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [check] };
const task: Task = { id: "T001", title: "Write value.txt", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };

class ScriptedExecutor implements AgentExecutor {
  implementations: ExecutionRequest[] = [];
  constructor(private root: string, private conflict: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const coverage = () => [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        this.implementations.push(request);
        // The first attempt meets the conflict; the next one follows the decision it was given.
        if (this.implementations.length === 1) {
          output = { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: this.conflict, evidenceIds: [], unresolved: [] };
          break;
        }
        writeFileSync(join(this.root, "value.txt"), "ready");
        output = { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: coverage(), findings: [] }; break;
      case "convergence": output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: coverage(), findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function run(conflict: string) {
  const root = mkdtempSync(join(tmpdir(), "baked-request-conflict-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new ScriptedExecutor(root, conflict);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  return { root, executor, service, runId: started.runId, done };
}

describe("scenario: envguard 8b8b7022, a spec conflict the request settles (#953)", () => {
  test("under assume the request wins once and the task runs again without asking a person", async () => {
    const { root, executor, service, runId, done } = await run(CONFLICT);
    expect(service.store.requests(runId).some((r) => r.kind === "clarification")).toBe(false);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    expect(executor.implementations).toHaveLength(2);
    expect(executor.implementations[1]?.prompt).toContain("The request is authoritative");
    expect(executor.implementations[1]?.prompt).toContain(CONFLICT);
    expect(service.store.latestArtifact(runId, "assumptions/conflicts/T001.json")).toBeTruthy();
  });

  test("a conflict between the spec and a test alone still asks a person", async () => {
    const { service, runId, done } = await run("tests/value.test.ts expects 'done' where AC-001 says ready.");
    expect(done.status).toBe("waiting");
    expect(service.store.requests(runId).some((r) => r.kind === "clarification" && r.status === "pending")).toBe(true);
    expect(service.store.latestArtifact(runId, "assumptions/conflicts/T001.json")).toBeNull();
  });
});

describe("a request that bans property-based tests", () => {
  test("turns the property-test mode off whatever the preset", () => {
    for (const request of [
      REQUEST,
      "Write tests without property-based testing.",
      "Do not use Hypothesis or generated tests.",
      "Example-based tests only.",
    ])
      expect(bansPropertyTests(request)).toBe(true);
    expect(propertyTestsOf({ propertyTests: "auto" }, "standard", REQUEST)).toBe("off");
  });
  test("leaves the mode alone otherwise", () => {
    for (const request of ["Add property-based tests for the parser.", "Create the ready value in value.txt."])
      expect(bansPropertyTests(request)).toBe(false);
    expect(propertyTestsOf({ propertyTests: "auto" }, "standard", "Add property-based tests for the parser.")).toBe("auto");
  });
});
