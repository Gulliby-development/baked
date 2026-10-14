import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { applyRevision } from "../src/core/workflows/revision-patch.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 20, statevet a93faa86 (#1058): each return from analyze wrote the whole spec and the
// whole plan again. Four rounds cost $5.31 to change one field. Under `revision: "patch"` the author
// answers a few findings with edit operations the host applies.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "PNG stripper", problem: "PNG files carry metadata", outcome: "Chunks are stripped", inScope: ["Strip chunks"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Ancillary chunks are stripped", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a PNG with tEXt chunks", when: "it is stripped", then: "only critical chunks remain", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nA stripper and its tests.\n## Decisions\nDEC-001: FR-001 in src/strip.ts.\n## Components\nsrc/strip.ts, tests/strip.test.ts\n## Data\nBytes\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const planned = (id: string, path: string, dependsOn: string[] = []): Task => ({ id, title: `create ${path}`, description: `create ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "src/strip.ts"), planned("T002", "tests/strip.test.ts", ["T001"])];

type Finding = { id: string; kind: string; refs: string[]; description: string; blocking: boolean };
const planFinding: Finding = { id: "F1", kind: "inconsistency", refs: ["plan.md"], description: "The Risks section says none, but corrupt PNG input is a risk the plan must name", blocking: true };
const specFinding: Finding = { id: "F1", kind: "ambiguity", refs: ["spec.json:AC-001"], description: "AC-001 does not say what happens to a corrupt PNG", blocking: true };

class ScriptedExecutor implements AgentExecutor {
  outputs: string[] = [];
  analyses = 0;
  constructor(
    private finding: Finding,
    private revise: (target: string) => unknown,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; extra: { revision?: { artifact: string } } };
    this.outputs.push(request.profile.output);
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": {
        this.analyses++;
        const fail = this.analyses === 1;
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: fail ? "needs_revision" : "pass", findings: fail ? [this.finding] : [] };
        break;
      }
      case "revision": output = this.revise(data.extra.revision?.artifact ?? ""); break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

const risk = { schemaVersion: 1, operations: [{ op: "replaceText", path: "markdown", find: "None for fixture", replace: "Corrupt input is rejected with an error" }, { op: "set", path: "taskGraph/tasks/T001/rationale", value: "Strips chunks and rejects corrupt input" }] };

async function runToApproval(executor: ScriptedExecutor, revision?: "patch", clarification?: "assume") {
  const root = mkdtempSync(join(tmpdir(), "baked-patch-revision-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check], ...(revision ? { revision } : {}), ...(clarification ? { clarification } : {}) };
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write a PNG chunk stripper.", ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? service.store.readArtifact(run.runId, artifact.id) : null;
  };
  return { approval, read };
}

describe("scenario: statevet a93faa86, a plan finding answered by a patch (#1058)", () => {
  test("the planner patches the plan instead of writing it again", async () => {
    const executor = new ScriptedExecutor(planFinding, () => risk);
    const { approval, read } = await runToApproval(executor, "patch");
    expect(approval).toBeDefined();
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "revision", "analysis"]);
    expect(read("plan.md")).toContain("Corrupt input is rejected with an error");
    const graph = JSON.parse(read("tasks.json") ?? "{}") as { tasks: Task[] };
    expect(graph.tasks.find((t) => t.id === "T001")?.rationale).toBe("Strips chunks and rejects corrupt input");
    expect(JSON.parse(read("revisions/plan-1.json") ?? "{}")).toMatchObject({ accepted: true });
  });

  test("without the policy the plan is written again, as before", async () => {
    const executor = new ScriptedExecutor(planFinding, () => risk);
    const { approval } = await runToApproval(executor);
    expect(approval).toBeDefined();
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "plan", "analysis"]);
  });

  test("a patch that does not apply falls back to writing the plan again", async () => {
    const bad = { schemaVersion: 1, operations: [{ op: "set", path: "taskGraph/tasks/T009/rationale", value: "No such task" }] };
    const executor = new ScriptedExecutor(planFinding, () => bad);
    const { approval, read } = await runToApproval(executor, "patch");
    expect(approval).toBeDefined();
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "revision", "plan", "analysis"]);
    const record = JSON.parse(read("revisions/plan-1.json") ?? "{}") as { accepted: boolean; problems: string[] };
    expect(record.accepted).toBe(false);
    expect(record.problems[0]).toContain("no element T009");
  });

  test("a spec finding patches the spec, then the plan", async () => {
    const executor = new ScriptedExecutor(specFinding, (target) =>
      target === "spec"
        ? { schemaVersion: 1, operations: [{ op: "set", path: "criteria/AC-001/then", value: "only critical chunks remain, and a corrupt PNG is rejected" }] }
        : risk,
    );
    const { approval, read } = await runToApproval(executor, "patch", "assume");
    expect(approval).toBeDefined();
    expect(executor.outputs.filter((o) => o !== "research")).toEqual(["spec", "plan", "analysis", "revision", "revision", "analysis"]);
    const stored = JSON.parse(read("spec.json") ?? "{}") as Spec;
    expect(stored.criteria[0]?.then).toBe("only critical chunks remain, and a corrupt PNG is rejected");
    expect(read("plan.md")).toContain("Corrupt input is rejected with an error");
  });
});

describe("applyRevision", () => {
  const document = { markdown: "a b c", list: [{ id: "T1", x: 1 }, { id: "T2", x: 2 }], tags: ["a"] };

  test("addresses list elements by id or index and leaves the input alone", () => {
    const { value, errors } = applyRevision(document, [
      { op: "set", path: "list/T2/x", value: 3 },
      { op: "remove", path: "list/0" },
      { op: "add", path: "tags", value: "b" },
      { op: "replaceText", path: "markdown", find: "b", replace: "B" },
    ]);
    expect(errors).toEqual([]);
    expect(value).toEqual({ markdown: "a B c", list: [{ id: "T2", x: 3 }], tags: ["a", "b"] });
    expect(document.list).toHaveLength(2);
  });

  test("names each operation that does not apply", () => {
    const { errors } = applyRevision(document, [
      { op: "add", path: "markdown", value: "x" },
      { op: "replaceText", path: "markdown", find: "z", replace: "y" },
      { op: "remove", path: "list/T9" },
    ]);
    expect(errors).toHaveLength(3);
    expect(errors[1]).toContain("occurs 0 times");
  });
});
