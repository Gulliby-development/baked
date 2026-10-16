import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { validatePackage } from "../src/core/specs/validate.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { featurePrompt } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeRow } from "../src/core/workflows/initiatives/store.js";
import { type RunPolicy, type Spec, specMeasureCriteria, type TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Bench round 32, notesift: the brief's closing rule for the spec author.
const BRIEF_RULE = "Keep feature specifications compact: at most 40 acceptance criteria across the initiative, grouped by core, store, features, and command line/delivery";

const requirement = (id: string, text: string) => ({ id, text, priority: "must" as const, verification: "automated" as const, sourceRefs: [] });
const criterion = (id: string, requirementIds: string[], then: string, given = "the workspace") => ({ id, requirementIds, given, when: "the run completes", then, method: "automated" as const });
const fixed: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [requirement("FR-001", "value.txt holds ready")], criteria: [criterion("AC-001", ["FR-001"], "value.txt holds ready")], dependencies: [] };
// notesift cli 3e5a9c3e AC-005: the initiative goal turned into a criterion about the specs.
const withMeasure: Spec = {
  ...fixed,
  requirements: [...fixed.requirements, requirement("FR-002", "Feature specifications stay within the initiative-wide maximum of 40 acceptance criteria")],
  criteria: [...fixed.criteria, criterion("AC-002", ["FR-002"], "the feature specifications contain at most 40 acceptance criteria in total", "the accepted specs/notesift_*/spec.json files")],
};

describe("a criterion that measures the specification (#1310)", () => {
  test("is recognised; criteria about the product are kept", () => {
    expect(specMeasureCriteria(withMeasure)).toEqual(["AC-002"]);
    const measures = [
      criterion("AC-003", ["FR-001"], "the number of acceptance criteria across the initiative is 40 or fewer"),
      criterion("AC-004", ["FR-001"], "the specs total 54 criteria and are consolidated to 40"),
      criterion("AC-005", ["FR-001"], "specs/notesift_tags/spec.json lists the tag criteria"),
    ];
    expect(specMeasureCriteria({ criteria: measures })).toEqual(["AC-003", "AC-004", "AC-005"]);
    const product = [
      criterion("AC-006", ["FR-001"], "the search accepts at most 40 filter criteria and rejects the 41st"),
      criterion("AC-007", ["FR-001"], "the README lists the acceptance criteria of the release"),
      criterion("AC-008", ["FR-001"], "the todo list shows at most 5 tasks per page"),
      criterion("AC-009", ["FR-001"], "the OpenAPI spec file declares the /notes route"),
    ];
    expect(specMeasureCriteria({ criteria: product })).toEqual([]);
  });

  test("goes back to the spec author before the planner sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-measure-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor();
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value. Keep the specification to at most 40 acceptance criteria.", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.specErrors[0]?.join("\n")).toContain("criterion AC-002 measures the specification or plan");
    expect(service.store.state(run.runId).spec?.criteria.map((c) => c.id)).toEqual(["AC-001"]);
  });
});

describe("an initiative goal about writing specs (#1310)", () => {
  test("reaches feature runs as a spec-writing rule, not as a product goal", () => {
    const initiative: InitiativePlan = {
      schemaVersion: 1,
      title: "notesift",
      goals: ["Notes can be searched by tag", BRIEF_RULE],
      completionCriteria: ["The CLI searches notes"],
      features: [{ id: "cli", title: "Command line", boundary: { scope: "The CLI", paths: ["src/cli/**"] }, contract: "notesift command", dependsOn: [], mandatory: true }],
    };
    const row = { id: "init-1", prompt: "Build notesift." } as InitiativeRow;
    const prompt = featurePrompt(row, initiative, initiative.features[0] as InitiativePlan["features"][number], []);
    const goals = prompt.slice(prompt.indexOf("Initiative goals:"), prompt.indexOf("Rules for writing"));
    expect(goals).toContain("Notes can be searched by tag");
    expect(goals).not.toContain("40 acceptance criteria");
    expect(prompt).toContain(`Rules for writing this feature's specification`);
    expect(prompt.slice(prompt.indexOf("Rules for writing"))).toContain(BRIEF_RULE);
  });
});

describe("a plan task that writes accepted specs (#1310)", () => {
  test("is rejected with a message naming the boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-write-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const markdown = "# Plan\n## Context\nx\n## Decisions\nDEC-001: FR-001.\n## Components\nx\n## Data\nx\n## Verification\nx\n## Risks\nx";
    const graph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixed), planHash: hashBytes(markdown), tasks: [{ id: "T000", title: "Consolidate specs", description: "Trim upstream criteria", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "specs/notesift_tags/spec.json", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Criteria limit" }] };
    expect(() => validatePackage(root, fixed, markdown, graph)).toThrow(/protected write specs\/notesift_tags\/spec\.json: accepted specifications are host-owned/);
  });
});

class SpecExecutor implements AgentExecutor {
  specErrors: string[][] = [];
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
        break;
      case "spec": {
        output = withMeasure;
        const errors = request.validate?.(output) ?? [];
        this.specErrors.push(errors);
        if (errors.length) output = fixed;
        break;
      }
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixed), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
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
