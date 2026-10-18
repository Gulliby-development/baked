import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { affectedTestCheck } from "../src/core/workflows/affected-tests.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { executeGate } from "../src/core/workflows/gates.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #1548: a generated test that takes six seconds must pass its task and the full suite without a corrective.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const SLOW_TEST = `import { expect, test } from "bun:test";
import { limit } from "../src/handler.ts";
test("builds generated fixtures", async () => { await Bun.sleep(6000); expect(limit).toBe(8192); });
`;
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Shortener", problem: "No handler", outcome: "A handler", inScope: ["Handler"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Payloads over 8192 bytes are rejected", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a payload", when: "it is posted", then: "a payload over 8192 bytes is rejected", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne handler.\n## Decisions\nDEC-001: FR-001 caps payloads.\n## Components\nsrc/handler.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, path: string, dependsOn: string[]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [task("T001", "src/handler.ts", []), task("T002", "tests/handler.test.ts", ["T001"])];
const tests: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 120000, required: true, scope: "feature", envNames: [], writes: [] };
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
          writeFileSync(join(this.root, "tests/handler.test.ts"), current?.origin === "planned" ? SLOW_TEST : SLOW_TEST.replace("await Bun.sleep(6000); ", ""));
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

describe("scenario: suite and task per-test timeouts agree (#1548)", () => {
  test("a six-second test passes its written check and the suite without a corrective", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-suite-timeout-"));
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
    const checks = service.store.artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("checks/") && a.logical_path.endsWith(".json"))
      .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as { definition: Check; exitCode: number; output: string; reason: string });
    for (const id of ["tests-written", "tests"]) {
      const results = checks.filter((c) => c.definition?.id === id);
      expect(results.length).toBeGreaterThan(0);
      expect(results.filter((c) => c.exitCode !== 0).map((c) => c.output)).toEqual([]);
    }
    // Runtime flags must not alter evidence definitions or approved policy commands.
    expect(checks.every((c) => !c.definition.args.includes("--timeout"))).toBe(true);
    expect(executor.attempts.filter((a) => a.origin !== "planned")).toHaveLength(0);
    expect(errors.length ? service.store.readArtifact(run.runId, errors.at(-1)?.id ?? "") : "").toBe("");
    expect(done.status).toBe("completed");
    expect(JSON.parse(service.store.run(run.runId).policy_json).checks[0].args).toEqual(["test"]);
    const affected = affectedTestCheck([tests], ["tests/handler.test.ts"])!;
    const result = await executeGate(root, affected, new AbortController().signal);
    expect(result.status).toBe("passed");
  }, 90000);
});
