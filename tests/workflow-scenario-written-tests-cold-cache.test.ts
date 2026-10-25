import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2162: on a cold Windows runner the first `go test` of a task's new file spent the whole 60 s
// of `tests-written` compiling, timed out without a result, and sent the finished task back to its
// worker; the same check ran in 5.6 s the next time. Here the test file hangs on its first run
// only (the cold cache) and passes after it, so the check's first timeout must not fail the task.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// The marker lives outside the workspace: a file the check writes there would make its result unstable.
const coldTest = (marker: string) => `import { existsSync, writeFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { limit } from "../src/handler.ts";
test("rejects oversized payloads", () => {
  if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, ""); while (true) {} }
  expect(limit).toBe(8192);
});
`;

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Limit", problem: "No handler", outcome: "A handler", inScope: ["Handler"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Payloads over 8192 bytes are rejected", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a payload", when: "it is posted", then: "a payload over 8192 bytes is rejected", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne handler.\n## Decisions\nDEC-001: FR-001 caps payloads.\n## Components\nsrc/handler.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, path: string, dependsOn: string[]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [task("T001", "src/handler.ts", []), task("T002", "tests/handler.test.ts", ["T001"])];
const tests: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 5000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [tests] };

class ScriptedExecutor implements AgentExecutor {
  attempts: { id: string; origin: string }[] = [];
  constructor(private root: string, private marker: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/handler.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const current = request.task;
        this.attempts.push({ id: current?.id ?? "", origin: current?.origin ?? "" });
        const writes = current?.writes.map((w) => w.path) ?? [];
        if (writes.includes("src/handler.ts")) {
          mkdirSync(join(this.root, "src"), { recursive: true });
          writeFileSync(join(this.root, "src/handler.ts"), "export const limit = 8192;\n");
        }
        if (writes.includes("tests/handler.test.ts")) {
          mkdirSync(join(this.root, "tests"), { recursive: true });
          writeFileSync(join(this.root, "tests/handler.test.ts"), coldTest(this.marker));
        }
        output = { schemaVersion: 1, taskId: current?.id, outcome: "implemented", summary: "Wrote files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The tests pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: a written test whose first run builds a cold cache (#2162)", () => {
  test("the first timeout reruns the check once, and the task is not sent back to its worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-cold-cache-"));
    const outside = mkdtempSync(join(tmpdir(), "baked-cold-marker-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => rmSync(outside, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root, join(outside, "warm"));
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
    expect(executor.attempts).toEqual([{ id: "T001", origin: "planned" }, { id: "T002", origin: "planned" }]);
    const written = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("checks/tests-written/"));
    const first = JSON.parse(service.store.readArtifact(run.runId, written[0]?.id ?? "{}"));
    expect(first).toMatchObject({ reason: "exit", timedOut: false, exitCode: 0 });
    expect(first.output).toContain("was run once more");
  }, 90000);
});
