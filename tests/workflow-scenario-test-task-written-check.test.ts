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

// Scenario of bench round 43 (#1518). url-shortener b9ca003e and md-site 5d69c69e: the bun plans
// gave their test tasks only typecheck and lint, so a worker did not know it could run
// `tests-written`; a test with a wrong expectation failed that check after the attempt and became
// a corrective task with a cold context and the union of the plan's files (41 and 23 percent of
// the two runs). The task is now told the check, and a failure after it submits sends it back to
// itself once with the output before a correction is opened.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const TEST = (expected: string) => `import { expect, test } from "bun:test";
import { slug } from "../src/slug.ts";
test("slug lowercases", () => { expect(slug("A")).toBe("${expected}"); });
`;

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Slugs", problem: "No slugs", outcome: "Slugs", inScope: ["Slugs"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Slugs are lowercase", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a title", when: "it is slugged", then: "it is lowercase", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA slug helper and its test.\n## Decisions\nDEC-001: FR-001 in the helper.\n## Components\nsrc/slug.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "src/slug.ts"), planned("T002", "tests/slug.test.ts", ["T001"])];
const tests: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 15000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [tests] };

interface Seen {
  id: string;
  origin: string;
  writtenTestsCheck?: { checkId: string; paths: string[]; note: string };
  cutOffChecks?: { failed: { id: string }[]; note: string };
}

class ScriptedExecutor implements AgentExecutor {
  attempts: Seen[] = [];
  constructor(private root: string) {}
  private write(path: string, text: string) {
    mkdirSync(join(this.root, path, ".."), { recursive: true });
    writeFileSync(join(this.root, path), text);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/slug.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        const extra = data.extra as Pick<Seen, "writtenTestsCheck" | "cutOffChecks">;
        this.attempts.push({ id: task.id, origin: task.origin, ...(extra.writtenTestsCheck ? { writtenTestsCheck: extra.writtenTestsCheck } : {}), ...(extra.cutOffChecks ? { cutOffChecks: extra.cutOffChecks } : {}) });
        if (task.id === "T001") this.write("src/slug.ts", "export const slug = (h: string) => h.toLowerCase();\n");
        // The first attempt's expectation is wrong; the attempt that sees the failure fixes it.
        else this.write("tests/slug.test.ts", TEST(extra.cutOffChecks || task.origin !== "planned" ? "a" : "A"));
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: url-shortener b9ca003e, a test task without a suite check (#1518)", () => {
  test("is told its tests-written check and repairs its own failing test without a correction", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-test-task-written-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Lowercase slugs", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const t002 = executor.attempts.filter((a) => a.id === "T002");
    expect(t002[0]?.writtenTestsCheck).toMatchObject({ checkId: "tests-written", paths: ["tests/slug.test.ts"] });
    expect(t002[0]?.writtenTestsCheck?.note).toContain("request_check tests-written");
    // The code task writes no test, so it is not told the check.
    expect(executor.attempts.find((a) => a.id === "T001")?.writtenTestsCheck).toBeUndefined();
    expect(t002).toHaveLength(2);
    expect(t002[1]?.cutOffChecks?.failed.map((f) => f.id)).toEqual(["tests-written"]);
    expect(executor.attempts.filter((a) => a.origin !== "planned")).toEqual([]);
    expect(service.store.findings(run.runId).map((f) => (JSON.parse(f.body_json) as { claim: string }).claim)).not.toContain("Task T002 required check tests-written failed");
  }, 120000);
});
