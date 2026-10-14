import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { deliverableProblems, repairDeliverables } from "../src/core/workflows/request-coverage.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { repairUncoveredCriteria } from "../src/core/workflows/uncovered.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const REQUEST = "Build the cronsay CLI that prints the next run of a cron line. No CI workflow is wanted.";

// R19 cronsay-update: the planner implemented FR-001 but listed only AC-001; AC-002 sent the plan
// back. logslice-update: a deliverable the request turns down had no outOfScope quote (#1037).
const spec: Spec = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  title: "Fixture",
  problem: "No next-run output",
  outcome: "The CLI prints the next run",
  inScope: ["cronsay CLI"],
  outOfScope: ["CI configuration"],
  assumptions: [],
  openQuestions: [],
  requirements: [
    { id: "FR-001", text: "The cronsay CLI prints the next run of a cron line", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { id: "AC-001", requirementIds: ["FR-001"], given: "a cron line", when: "cronsay runs", then: "it prints the next run", method: "automated" },
    { id: "AC-002", requirementIds: ["FR-001"], given: "an invalid cron line", when: "cronsay runs", then: "it exits with code 2", method: "automated" },
  ],
  dependencies: [],
  deliverables: [
    { quote: "the cronsay CLI", requirementIds: ["FR-001"] },
    { quote: "CI workflow", requirementIds: [] },
  ],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
const markdown = "# Plan\n## Context\nCreate cronsay.\n## Decisions\nDEC-001: FR-001 prints the next run.\n## Components\ncronsay.ts\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";
const task = (id: string, title: string, path: string, criterionIds: string[], dependsOn: string[] = []) => ({ id, title, description: title, requirementIds: ["FR-001"], criterionIds, dependsOn, profileId: "implementer", writes: [{ path, action: "create" as const }], readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Required behavior" });
const graph = (tasks: ReturnType<typeof task>[]): TaskGraph => ({ schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks });

/** Resubmits each output while the host rejects it, as an author does, and records the errors. */
class Executor implements AgentExecutor {
  calls: string[] = [];
  specErrors: string[][] = [];
  planErrors: string[][] = [];
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["cronsay.ts"] };
        break;
      case "spec":
        output = spec;
        this.specErrors.push(request.validate?.(output) ?? []);
        break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: graph([task("T001", "Implement cronsay", "cronsay.ts", ["AC-001"]), task("T002", "Test cronsay exit codes", "cronsay.test.ts", ["AC-001"], ["T001"])]) };
        this.planErrors.push(request.validate?.(output) ?? []);
        break;
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("host repair of one-error spec and plan rejections (#1037)", () => {
  test("a missing criterion id and an unmapped deliverable reach approval with no second author call", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-repair-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const executor = new Executor();
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis"]);
    expect(executor.specErrors).toEqual([[]]);
    expect(executor.planErrors).toEqual([[]]);

    const state = service.store.state(run.runId);
    expect(state.spec?.deliverables?.[1]).toEqual({ quote: "CI workflow", requirementIds: [], outOfScope: "No CI workflow is wanted." });
    // AC-002 is about exit codes: it goes to the test task, which shares the words.
    expect(state.graph?.tasks.map((t) => t.criterionIds)).toEqual([["AC-001"], ["AC-001", "AC-002"]]);
    const paths = service.store.artifacts(run.runId).map((a) => a.logical_path);
    expect(paths).toContain("spec-repairs/deliverables.json");
    expect(paths).toContain("plan-repairs/uncovered.json");
  });
});

describe("repairUncoveredCriteria", () => {
  const plan = { markdown, taskGraph: graph([task("T001", "Implement cronsay", "cronsay.ts", ["AC-001"])]) };

  test("leaves a criterion whose requirements no task implements", () => {
    const other: Spec = { ...spec, criteria: [...spec.criteria, { id: "AC-003", requirementIds: ["NFR-001"], given: "a push", when: "CI runs", then: "the matrix passes", method: "automated" }] };
    const { plan: next, repaired } = repairUncoveredCriteria(other, plan);
    expect(repaired).toEqual([{ criterionId: "AC-002", taskId: "T001" }]);
    expect(next.taskGraph.tasks[0]?.criterionIds).toEqual(["AC-001", "AC-002"]);
    // The submission itself is not changed.
    expect(plan.taskGraph.tasks[0]?.criterionIds).toEqual(["AC-001"]);
  });

  test("skips post-release criteria and returns a complete plan as it is", () => {
    const later: Spec = { ...spec, criteria: [spec.criteria[0], { ...spec.criteria[1], method: "post-release" }] as Spec["criteria"] };
    const result = repairUncoveredCriteria(later, plan);
    expect(result.repaired).toEqual([]);
    expect(result.plan).toBe(plan);
  });
});

describe("repairDeliverables", () => {
  test("maps to the requirement that names the deliverable", () => {
    const loose: Spec = { ...spec, deliverables: [{ quote: "cronsay CLI", requirementIds: [] }] };
    const { spec: next, repaired } = repairDeliverables(loose, REQUEST);
    expect(repaired).toEqual(["cronsay CLI"]);
    expect(next.deliverables?.[0]?.requirementIds).toEqual(["FR-001"]);
    expect(deliverableProblems(next, REQUEST)).toEqual([]);
  });

  test("uses an outOfScope entry that quotes the request", () => {
    const quoted: Spec = { ...spec, outOfScope: ["No CI workflow is wanted"] };
    expect(repairDeliverables(quoted, REQUEST).spec.deliverables?.[1]?.outOfScope).toBe("No CI workflow is wanted");
  });

  test("leaves a deliverable nothing names to the author", () => {
    const stray: Spec = { ...spec, deliverables: [{ quote: "a man page", requirementIds: [] }] };
    const result = repairDeliverables(stray, `${REQUEST} Ship a man page.`);
    expect(result.repaired).toEqual([]);
    expect(deliverableProblems(result.spec, `${REQUEST} Ship a man page.`)).toHaveLength(1);
  });
});
