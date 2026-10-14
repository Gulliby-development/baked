import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { crossPlatformNote, forbidsCi } from "../src/core/workflows/cross-platform.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { type Check, type RunPolicy, type Spec, repairHostBoundCriteria, specCoverageProblems, SpecSchema, type Task, validateSpecCoverage } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 18, stmtsplit e29347c1 (#1015). The request said the program "must behave and print
// identically on Windows, macOS and Linux" and "No CI workflow is wanted". The spec author wrote
// an automated criterion about the three systems; the spec check rejected the whole 51 KB spec
// and suggested a CI matrix, and the second attempt cost another $0.97.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = "Create the ready value in value.txt. The value must be written identically on Windows, macOS and Linux. No CI workflow is wanted.";
const crossOs = { id: "AC-002", requirementIds: ["FR-002"], given: "the program", when: "it runs", then: "it prints identically on Windows, macOS and Linux", method: "automated" as const };
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Ready value", problem: "The value is missing", outcome: "The value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The value is ready", priority: "must", verification: "automated", sourceRefs: [] }, { id: "FR-002", text: "Output is the same on every operating system", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value.txt holds ready", method: "automated" }, crossOs], dependencies: [] };
const markdown = "# Plan\n## Context\nOne value.\n## Decisions\nDEC-001: FR-001 writes value.txt.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nThe value check\n## Risks\nNone for fixture";
const check: Check = { id: "value", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };

class ScriptedExecutor implements AgentExecutor {
  specs: ExecutionRequest[] = [];
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] }; break;
      case "spec": this.specs.push(request); output = spec; break;
      case "plan": {
        // The plan covers the criterion the host added for what this host proves.
        const task: Task = { id: "T001", title: "Write value.txt", description: "Write ready", requirementIds: ["FR-001", "FR-002"], criterionIds: ["AC-001", "AC-003"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(repairHostBoundCriteria(spec).spec), planHash: hashBytes(markdown), tasks: [task] } };
        break;
      }
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: stmtsplit e29347c1, a criterion about other operating systems (#1015)", () => {
  test("the host makes the criterion checkable instead of sending the whole spec back", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-os-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor();
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
    const waiting = await service.drive(started.runId, new AbortController().signal);
    expect({ status: waiting.status, reason: waiting.reason }).toEqual({ status: "waiting", reason: "approval" });
    // One spec attempt, and its input steered away from a CI matrix the request turns down.
    expect(executor.specs).toHaveLength(1);
    expect(executor.specs[0]?.prompt).toContain("wants no CI");
    const stored = service.store.latestArtifact(started.runId, "spec.json");
    const saved = SpecSchema.parse(JSON.parse(service.store.readArtifact(started.runId, stored?.id ?? "")));
    expect(saved.criteria.find((c) => c.id === "AC-002")?.method).toBe("post-release");
    expect(saved.criteria.find((c) => c.id === "AC-003")).toMatchObject({ requirementIds: ["FR-002"], method: "automated" });
    expect(validateSpecCoverage(saved)).toEqual([]);
    expect(service.store.latestArtifact(started.runId, "spec-repairs/host-bound.json")).toBeTruthy();
  });
});

describe("a request that turns CI down", () => {
  test("is recognised", () => {
    for (const request of [REQUEST, "Do not add a CI workflow.", "Ship it without GitHub Actions.", "CI is not wanted here."]) expect(forbidsCi(request)).toBe(true);
    for (const request of ["Add a CI workflow that runs the tests on Windows and Linux.", "Create the ready value."]) expect(forbidsCi(request)).toBe(false);
  });
  test("gets no CI matrix in the author's note or the spec check's hint", () => {
    expect(crossPlatformNote(REQUEST, tmpdir())).not.toContain("tests pass on Windows, macOS and Linux");
    expect(crossPlatformNote("It must run on Windows and Linux.", tmpdir())).toContain("tests pass on Windows, macOS and Linux");
    expect(specCoverageProblems(spec, undefined, { ciForbidden: true }).join(" ")).not.toContain("ubuntu-latest");
    expect(specCoverageProblems(spec).join(" ")).toContain("ubuntu-latest");
  });
});
