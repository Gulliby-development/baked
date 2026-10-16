import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { DEFAULT_MIN_CASES, requiredCases } from "../src/core/workflows/affected-tests.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 36 (#1367). url-shortener 4c3137f0: T003 "Add storage property tests"
// planned "at least 100 generated inputs per criterion". Its `tests-written` check timed out
// (60 s, no result) and the host note said to keep generated samples to "tens"; corrective T006
// cut the tests to 32 cases, the review asked for 100 again (F1, then F1-2), and the chain of
// three correctives cost 3.14M tokens, 56 percent of the run. The timeout note and the
// corrective now carry the number the task requires.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const NEVER_ENDS = `import { test } from "bun:test";
test("stores every generated dataset", () => { while (true) {} });
`;
const PASSES = `import { expect, test } from "bun:test";
import { limit } from "../src/handler.ts";
test("rejects seeded oversized payloads", () => { expect(limit).toBe(8192); });
`;

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Shortener", problem: "No handler", outcome: "A handler", inScope: ["Handler"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Payloads over 8192 bytes are rejected", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a payload", when: "it is posted", then: "a payload over 8192 bytes is rejected", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne handler.\n## Decisions\nDEC-001: FR-001 caps payloads.\n## Components\nsrc/handler.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, path: string, dependsOn: string[], description = `Write ${path}`): Task => ({ id, title: `Write ${path}`, description, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [task("T001", "src/handler.ts", []), task("T002", "tests/handler.test.ts", ["T001"], "Add property tests of the payload cap with at least 100 generated inputs per criterion")];
const tests: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 8000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [tests] };

class ScriptedExecutor implements AgentExecutor {
  attempts: { id: string; origin: string; description: string }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/handler.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const current = request.task;
        this.attempts.push({ id: current?.id ?? "", origin: current?.origin ?? "", description: current?.description ?? "" });
        const writes = current?.writes.map((w) => w.path) ?? [];
        if (writes.includes("src/handler.ts")) {
          mkdirSync(join(this.root, "src"), { recursive: true });
          writeFileSync(join(this.root, "src/handler.ts"), "export const limit = 8192;\n");
        }
        if (writes.includes("tests/handler.test.ts")) {
          mkdirSync(join(this.root, "tests"), { recursive: true });
          writeFileSync(join(this.root, "tests/handler.test.ts"), current?.origin === "planned" ? NEVER_ENDS : PASSES);
        }
        output = { schemaVersion: 1, taskId: current?.id, outcome: "implemented", summary: "Wrote files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The tests pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: url-shortener 4c3137f0, a property test task that requires 100 generated inputs times out (#1367)", () => {
  test("the timeout note and the correction keep the 100 inputs instead of asking for tens", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-case-count-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Cap payloads at 8192 bytes and test it", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const written = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("checks/tests-written/"));
    const first = JSON.parse(service.store.readArtifact(run.runId, written[0]?.id ?? "{}")) as { reason: string; output: string; definition: Check };
    expect(first).toMatchObject({ reason: "timeout_no_result", definition: { minCases: 100 } });
    expect(first.output).toContain("The task requires at least 100 generated inputs: do not reduce that number.");
    expect(first.output).not.toContain("tens");
    const corrective = executor.attempts.find((a) => a.origin !== "planned");
    expect(corrective?.description).toContain("Keep at least 100 generated inputs, as T002 requires");
    // The correction's own run of the check knows the number from its text.
    const second = JSON.parse(service.store.readArtifact(run.runId, written.at(-1)?.id ?? "{}")) as { definition: Check };
    expect(written.length).toBeGreaterThan(1);
    expect(second.definition.minCases).toBe(100);
  }, 90000);
});

describe("requiredCases (#1367)", () => {
  test("takes the largest count the task names, 100 for a property task naming none, nothing otherwise", () => {
    expect(requiredCases("Add storage property tests: at least 100 generated inputs per criterion, AC-004 with at least 1,000 links")).toBe(100);
    expect(requiredCases("Run at least 250 randomly generated cases and at least 40 examples")).toBe(250);
    expect(requiredCases("Add property tests of the parser")).toBe(DEFAULT_MIN_CASES);
    expect(requiredCases("Write tests/handler.test.ts")).toBeUndefined();
  });
});
