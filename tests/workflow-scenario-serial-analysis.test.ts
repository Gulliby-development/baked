import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { procedureCriteria, type RunPolicy, type Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const requirement = (id: string, text: string) => ({ id, text, priority: "must" as const, verification: "automated" as const, sourceRefs: [] });
const criterion = (id: string, requirementIds: string[], then: string, when = "the task completes") => ({ id, requirementIds, given: "the workspace", when, then, method: "automated" as const });
const fixed: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [requirement("FR-001", "value.txt holds ready")], criteria: [criterion("AC-001", ["FR-001"], "value.txt holds ready")], dependencies: [] };
// tplfill-update 1c9082bc: the brief's working step became AC-007.
const withProcedure: Spec = {
  ...fixed,
  requirements: [...fixed.requirements, requirement("FR-002", "Run cargo test --no-fail-fast before editing any test")],
  criteria: [...fixed.criteria, criterion("AC-002", ["FR-002"], "cargo test --no-fail-fast was run before editing any test", "the implementer changes tests")],
};

describe("a criterion about how the implementer works (#1113)", () => {
  test("is recognised; criteria about the result are kept", () => {
    expect(procedureCriteria(withProcedure)).toEqual(["AC-002"]);
    const checkpoint = criterion("AC-003", ["FR-001"], "the intermediate test checkpoint passes");
    expect(procedureCriteria({ ...fixed, criteria: [checkpoint] })).toEqual(["AC-003"]);
    const results = [
      criterion("AC-004", ["FR-001"], "cargo test --no-fail-fast passes"),
      criterion("AC-005", ["FR-001"], "the new value is used", "the user runs the tool after editing the config file"),
      criterion("AC-006", ["FR-001"], "the formatter runs before writing the output file"),
    ];
    expect(procedureCriteria({ ...fixed, criteria: results })).toEqual([]);
  });

  test("goes back to the spec author before the planner and analysis see it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-procedure-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor();
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.specErrors[0]?.join("\n")).toContain("criterion AC-002 describes how the implementer works");
    expect(service.store.state(run.runId).spec?.criteria.map((c) => c.id)).toEqual(["AC-001"]);
  });
});

describe("analysis passes after a return (#1113)", () => {
  test("see the blocking findings earlier passes raised", async () => {
    // keeplint-update ada519a3: four passes, one new blocking finding each.
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const extras: Record<string, unknown>[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; extra?: Record<string, unknown> };
        extras.push(data.extra ?? {});
        const first = extras.length === 1;
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: first ? "needs_revision" : "pass",
            findings: first
              ? [{ id: "F001", kind: "ambiguity", refs: ["spec.json", "AC-001"], description: "AC-001 does not say whether value.txt ends with a newline", blocking: true }]
              : [],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      return original(request);
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    expect(extras.length).toBeGreaterThanOrEqual(2);
    expect(extras[0]?.earlierFindings).toBeUndefined();
    expect(extras[1]?.earlierFindings).toEqual([
      { kind: "ambiguity", refs: ["spec.json", "AC-001"], description: "AC-001 does not say whether value.txt ends with a newline" },
    ]);
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
        output = withProcedure;
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
