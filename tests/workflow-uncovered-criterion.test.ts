import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { clarificationResumeIndex } from "../src/core/workflows/clarification.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { plannerNote, uncoveredCriterion, uncoveredFindings, uncoveredSpecNote } from "../src/core/workflows/uncovered.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// R11 url-shortener 6735ff55: the spec author added a CI matrix the request never asked for (#780).
const base: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }], dependencies: [] };
const withCi: Spec = {
  ...base,
  requirements: [...base.requirements, { id: "NFR-001", text: "CI runs the tests on every OS", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [...base.criteria, { id: "AC-002", requirementIds: ["NFR-001"], given: "a push", when: "CI runs", then: "the suite passes on Windows, macOS and Linux", method: "automated" }],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
const markdown = (names: boolean) =>
  `# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.${names ? "\nDEC-002: AC-002 needs a .github CI workflow, which the approval limits prohibit; it should be removed from the spec." : ""}\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture`;

/** The spec author adds AC-002 until told otherwise; the planner never covers it, as in R11. */
class Executor implements AgentExecutor {
  calls: string[] = [];
  prompts: string[] = [];
  /** Submission errors the planner saw, one list per submission. */
  planErrors: string[][] = [];
  spec = withCi;
  constructor(private script: { dropOnNote: boolean; namesCriterion: boolean }) {}
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    this.prompts.push(request.prompt);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
        break;
      case "spec":
        this.spec = this.script.dropOnNote && request.prompt.includes("The planner cannot cover criterion AC-002") ? { ...base, revision: 2 } : withCi;
        output = this.spec;
        break;
      case "plan": {
        const text = markdown(this.script.namesCriterion && this.spec === withCi);
        output = { schemaVersion: 1, markdown: text, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(this.spec), planHash: hashBytes(text), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        // The planner resubmits the same plan while it is rejected, at most three times.
        for (let i = 0; i < 3; i++) {
          const errors = request.validate?.(output) ?? [];
          this.planErrors.push(errors);
          if (!errors.length) break;
        }
        break;
      }
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function setup(executor: Executor) {
  const root = mkdtempSync(join(tmpdir(), "baked-uncovered-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  return service;
}
const start = (service: NativeWorkflowService) =>
  service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });

describe("a criterion the planner cannot cover", () => {
  test("stops the plan loop after a second submission and goes back to the spec author with the planner's reason", async () => {
    const executor = new Executor({ dropOnNote: true, namesCriterion: true });
    const service = setup(executor);
    const run = await start(service);
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "spec", "plan", "analysis"]);
    // One rejection, then the same uncovered criterion is accepted as one the plan cannot cover.
    expect(executor.planErrors.slice(0, 2)).toEqual([["uncovered criterion AC-002"], []]);
    const specPrompt = executor.prompts[3] ?? "";
    expect(specPrompt).toContain("The planner cannot cover criterion AC-002");
    expect(specPrompt).toContain("approval limits prohibit");
    expect(service.store.state(run.runId).uncoveredReturned).toEqual(["AC-002"]);
    expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
  });

  test("a spec that keeps the criterion asks a person, and the answer resumes at specify", async () => {
    const executor = new Executor({ dropOnNote: false, namesCriterion: true });
    const service = setup(executor);
    const run = await start(service);
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("clarification");
    expect(executor.calls).toEqual(["research", "spec", "plan", "spec", "plan"]);
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    const body = JSON.parse(request?.body_json ?? "{}") as { findings: { kind: string; refs: string[]; description: string; blocking: boolean }[] };
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({ kind: "scope", refs: ["spec.json", "AC-002"], blocking: true });
    expect(body.findings[0]?.description).toContain("Remove it from the spec");
    const current = await service.get(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: request?.id ?? "", answers: { "PLAN-SCOPE-1": "Remove it" } });
    expect(service.store.state(run.runId).stageIndex).toBe(sddWorkflow.stages.findIndex((s) => s.id === "specify"));
  });

  test("a plan that does not name the criterion is still rejected for it", async () => {
    const executor = new Executor({ dropOnNote: false, namesCriterion: false });
    const service = setup(executor);
    const run = await start(service);
    await service.drive(run.runId, new AbortController().signal);
    expect(executor.planErrors[1]).toEqual(["uncovered criterion AC-002"]);
    expect(executor.calls.filter((c) => c === "spec")).toHaveLength(1);
    expect(service.store.state(run.runId).uncoveredReturned).toEqual([]);
  });
});

describe("uncovered criterion helpers", () => {
  test("read the criterion from the package problem and the planner's reason from the plan", () => {
    expect(uncoveredCriterion("uncovered criterion AC-009")).toBe("AC-009");
    expect(uncoveredCriterion("Unknown checks for T001")).toBeNull();
    expect(plannerNote(markdown(true), "AC-002")).toContain("DEC-002");
    expect(plannerNote(markdown(false), "AC-002")).toBe("");
  });
  test("the spec note and the finding quote the criterion", () => {
    expect(uncoveredSpecNote(withCi, ["AC-002"], markdown(true))).toContain("then the suite passes on Windows, macOS and Linux");
    const [finding] = uncoveredFindings(withCi, ["AC-002"], markdown(true));
    expect(finding?.refs).toEqual(["spec.json", "AC-002"]);
    const stages = sddWorkflow.stages;
    const at = (id: string) => stages.findIndex((s) => s.id === id);
    expect(clarificationResumeIndex(stages, at("plan"), { findings: [finding] })).toBe(at("specify"));
  });
});
