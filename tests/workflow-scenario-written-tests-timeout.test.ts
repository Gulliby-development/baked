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

// Scenario of bench round 32 (#1308). url-shortener f1648a92: T003's property test ran one
// synchronous loop of about 10k file-database transactions, so `tests-written` timed out after
// 60 s with no test line printed, counted as inconclusive, and the run blocked
// `verification_failed` with nothing to repair. Here T002's first attempt writes a test that
// spins without printing a result; its correction writes one that passes.

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
const task = (id: string, path: string, dependsOn: string[]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [task("T001", "src/handler.ts", []), task("T002", "tests/handler.test.ts", ["T001"])];
const tests: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 8000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [tests] };

class ScriptedExecutor implements AgentExecutor {
  attempts: { id: string; origin: string }[] = [];
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
        this.attempts.push({ id: current?.id ?? "", origin: current?.origin ?? "" });
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

describe("scenario: url-shortener f1648a92, a written test that never prints a result (#1308)", () => {
  test("the silent timeout is a failure of the task that wrote the test, and its correction repairs it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-silent-timeout-"));
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
    const errors = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("errors/"));
    expect(errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "").toBe("");
    expect(done.status).toBe("completed");
    // T002's own file ran after it, failed before it hung, and a correction of T002 fixed it.
    const written = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("checks/tests-written/"));
    const first = JSON.parse(service.store.readArtifact(run.runId, written[0]?.id ?? "{}"));
    expect(first).toMatchObject({ reason: "timeout_no_result", timedOut: true, definition: { args: ["test", "./tests/handler.test.ts"], timeoutMs: 8000 } });
    expect(executor.attempts.filter((a) => a.origin !== "planned")).toHaveLength(1);
  }, 90000);
});
