import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 22, ratesim 029a5aec (#1112): sizing priced the skeleton task T001 (three manifests)
// above one attempt and sent the run back to plan. The planner wrote the whole plan again (170k
// tokens, $1.30) although the run's policy had `revision: "patch"`. A sizing split now pends a patch
// of the plan, like an analysis finding, and falls back to a new plan when the patch does not apply.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Rate simulator", problem: "No simulator exists", outcome: "A simulator runs", inScope: ["Simulate rates"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Rates are simulated", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a rate table", when: "it is simulated", then: "the totals are printed", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA simulator and its tests.\n## Decisions\nDEC-001: FR-001 in src/sim.ts.\n## Components\nsrc/sim.ts, tests/sim.test.ts\n## Data\nRates\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned = (id: string, paths: string[], dependsOn: string[] = []): Task => ({ id, title: `create ${paths.join(", ")}`, description: `create ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", ["src/sim.ts", "src/rates.ts", "src/main.ts"]), planned("T002", ["tests/sim.test.ts"], ["T001"])];

class ScriptedExecutor implements AgentExecutor {
  outputs: string[] = [];
  revisions: { artifact: string; findings: { kind: string; description: string }[] }[] = [];
  constructor(private revise: unknown) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; extra: { revision?: { artifact: string; findings: { kind: string; description: string }[] } } };
    this.outputs.push(request.profile.output);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "revision":
        if (data.extra.revision) this.revisions.push(data.extra.revision);
        output = this.revise;
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

const split = { schemaVersion: 1, operations: [
  { op: "set", path: "taskGraph/tasks/T001/writes", value: [{ path: "src/sim.ts", action: "create" }] },
  { op: "add", path: "taskGraph/tasks", value: planned("T003", ["src/rates.ts"]) },
  { op: "add", path: "taskGraph/tasks", value: planned("T004", ["src/main.ts"], ["T001", "T003"]) },
  { op: "set", path: "taskGraph/tasks/T002/dependsOn", value: ["T001", "T003", "T004"] },
] };

async function runToApproval(executor: ScriptedExecutor, revision?: "patch") {
  const root = mkdtempSync(join(tmpdir(), "baked-sizing-patch-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check], sizing: { maxAttemptTokens: 10_000 }, ...(revision ? { revision } : {}) };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write a rate simulator.", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? service.store.readArtifact(run.runId, artifact.id) : null;
  };
  return { approval, read };
}

describe("scenario: ratesim 029a5aec, a sizing split answered by a patch (#1112)", () => {
  test("the planner splits the oversized task with edit operations instead of a new plan", async () => {
    const executor = new ScriptedExecutor(split);
    const { approval, read } = await runToApproval(executor, "patch");
    expect(approval).toBeDefined();
    expect(JSON.parse(read("sizing/plan-0.json") ?? "{}")).toMatchObject({ decision: "split-tasks" });
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "revision", "analysis"]);
    expect(executor.revisions[0]?.artifact).toBe("plan");
    expect(executor.revisions[0]?.findings[0]?.kind).toBe("sizing");
    expect(executor.revisions[0]?.findings[0]?.description).toContain("T001 writes 3 files");
    const graph = JSON.parse(read("tasks.json") ?? "{}") as { tasks: Task[] };
    expect(graph.tasks.map((t) => t.id).sort()).toEqual(["T001", "T002", "T003", "T004"]);
    expect(graph.tasks.find((t) => t.id === "T001")?.writes.map((w) => w.path)).toEqual(["src/sim.ts"]);
    expect(JSON.parse(read("revisions/plan-1.json") ?? "{}")).toMatchObject({ accepted: true });
  });

  test("without the policy the plan is written again, as before", async () => {
    const executor = new ScriptedExecutor(split);
    const { approval } = await runToApproval(executor);
    expect(approval).toBeDefined();
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "plan", "analysis"]);
  });

  test("a patch that does not apply falls back to a new plan", async () => {
    const executor = new ScriptedExecutor({ schemaVersion: 1, operations: [{ op: "remove", path: "taskGraph/tasks/T009" }] });
    const { approval, read } = await runToApproval(executor, "patch");
    expect(approval).toBeDefined();
    expect(executor.outputs.filter((o) => o !== "research")).toContain("plan");
    expect(executor.outputs.filter((o) => o === "plan")).toHaveLength(2);
    expect(JSON.parse(read("revisions/plan-1.json") ?? "{}")).toMatchObject({ accepted: false });
  });
});
