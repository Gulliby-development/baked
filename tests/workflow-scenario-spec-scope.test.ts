import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { contradictoryScope, narrowingBounds, type RunPolicy, type Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 22 (#1120, split out of #1113). cfgtrace b4dc83b2 listed a CI workflow in inScope and
// kept it in outOfScope; analysis returned the spec for it three times, implement started with the
// finding open, and review raised it against spec.json at the end, so the run blocked
// `input_changed` after 5.84M tokens. keeplint ada519a3 wrote 50 files and 4,096 characters as
// bounds against the brief's non-narrowing rule, raised by analysis on its fourth return.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const requirement = (id: string, text: string) => ({ id, text, priority: "must" as const, verification: "automated" as const, sourceRefs: [] });
const criterion = (id: string, requirementIds: string[], then: string) => ({ id, requirementIds, given: "the workspace", when: "the task completes", then, method: "automated" as const });
const fixed: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value", "Add a GitHub Actions CI workflow that runs the checks"], outOfScope: ["Release automation"], assumptions: [], openQuestions: [], requirements: [requirement("FR-001", "value.txt holds ready")], criteria: [criterion("AC-001", ["FR-001"], "value.txt holds ready")], dependencies: [] };

describe("deterministic scope checks at spec acceptance (#1120)", () => {
  test("an outOfScope line that excludes what an inScope line includes", () => {
    expect(contradictoryScope({ ...fixed, outOfScope: ["CI workflows", "Release automation"] })).toEqual(["CI workflows"]);
    expect(contradictoryScope({ ...fixed, outOfScope: ["Values to create"] })).toEqual(["Values to create"]);
    // Narrower exclusions that add a word of their own are not contradictions.
    expect(contradictoryScope({ ...fixed, outOfScope: ["CI on macOS", "Deploy workflow", "Release automation"] })).toEqual([]);
  });

  test("numeric bounds as exclusions only when the request calls limits non-narrowing", () => {
    const bounded: Spec = {
      ...fixed,
      outOfScope: ["Inputs with more than 50 files", "Release automation"],
      criteria: [
        ...fixed.criteria,
        criterion("AC-002", ["FR-001"], "lines up to 4,096 characters are linted; longer lines are outside the checked domain"),
        criterion("AC-003", ["FR-001"], "a 10,000-line file is linted"),
      ],
    };
    const request = "Lint the files. Any limit you need is a non-narrowing assumption.";
    expect(narrowingBounds(bounded, request)).toEqual({ outOfScope: ["Inputs with more than 50 files"], criteria: ["AC-002"] });
    expect(narrowingBounds(bounded, "Lint the files.")).toEqual({ outOfScope: [], criteria: [] });
  });

  test("a contradictory spec goes back to the spec author before the planner sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-scope-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor({ ...fixed, outOfScope: ["CI workflows", "Inputs with more than 50 files"] });
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const prompt = "Create ready value with a CI workflow. Any limit you need is a non-narrowing assumption.";
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    const errors = executor.specErrors[0]?.join("\n") ?? "";
    expect(errors).toContain('outOfScope line "CI workflows" excludes what inScope includes');
    expect(errors).toContain('outOfScope line "Inputs with more than 50 files" states a numeric bound');
    expect(service.store.state(run.runId).spec?.outOfScope).toEqual(["Release automation"]);
  });
});

describe("a blocking spec finding that survives the last analysis return (#1120)", () => {
  test("is settled by a spec amendment that every later agent reads", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const finding = { id: "F-001", kind: "scope", refs: ["spec.json", "AC-001"], description: "outOfScope still lists the CI workflow that the request does not ask to exclude", blocking: true };
    let analyses = 0;
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        analyses += 1;
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [finding] }, inputTokens: 25, outputTokens: 25 };
      }
      return original(request);
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(analyses).toBeGreaterThanOrEqual(2);
    const amendment = service.store.latestArtifact(run.runId, "amendments/analysis-F-001.json");
    expect(amendment).toBeTruthy();
    expect(JSON.parse(service.store.readArtifact(run.runId, amendment?.id ?? ""))).toMatchObject({ authority: "request", source: "analysis", criterionIds: ["AC-001"] });
    const note = "analysis found that the approved spec still disagrees with the request after its last revision";
    expect(executor.prompts.implementation?.at(-1)).toContain(note);
    expect(executor.prompts.review?.at(-1) ?? executor.prompts.convergence?.at(-1)).toContain(note);
  });

  test("a finding about the plan or tasks records no amendment", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const finding = { id: "F-001", kind: "scope", refs: ["plan.md", "T001"], description: "T001 restricts value.txt to one line, which the request does not ask for", blocking: true };
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [finding] }, inputTokens: 25, outputTokens: 25 };
      }
      return original(request);
    };
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    expect(service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("amendments/"))).toEqual([]);
  });
});

class SpecExecutor implements AgentExecutor {
  specErrors: string[][] = [];
  constructor(private first: Spec) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
        break;
      case "spec": {
        output = this.first;
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
