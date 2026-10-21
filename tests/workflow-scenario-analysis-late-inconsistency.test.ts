import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { newFacet, requestRequirements, requestSettles } from "../src/core/workflows/analysis-notes.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Analysis, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 56, hdrlens base 38dd8595 (#1830). Two earlier analysis passes spent the
// run's reroute budget (a scope finding plus an inconsistency, then the scope finding again). The
// third pass raised a new inconsistency the spec author had introduced while reconciling them:
// "AC-004 requires a failing ReadStdin test double, but FR-005 forbids named test types", with
// FR-005 restating the brief. No branch was left, and the run asked a person (2 min of wait at the
// head of the initiative, 175k tokens of rerun) for the finding's own first option.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const BRIEF = "Build hdrlens base IO.\nReadFile fails when the path is absent. A test file declares no named type.";
const specWith = (sourceRefs: string[]): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "hdrlens base", problem: "No IO layer", outcome: "Shared IO", inScope: ["IO"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [
    { id: "FR-004", text: "ReadFile fails with '<path>: cannot read the file' when the path is absent", priority: "must", verification: "automated", sourceRefs: ["request"] },
    { id: "FR-005", text: "A test file declares no named type", priority: "must", verification: "automated", sourceRefs },
  ],
  criteria: [{ id: "AC-004", requirementIds: ["FR-004", "FR-005"], given: "MemIO", when: "a read fails", then: "it prints '<stdin>: cannot read the file'", method: "automated" }],
  dependencies: [],
});
const markdown = "# Plan\n## Context\nIO.\n## Decisions\nDEC-001: FR-004 and FR-005 use MemIO.\n## Components\nio.go\n## Data\nBytes\n## Verification\nTests\n## Risks\nNone";
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [{ id: "tests", executable: "go", args: ["test", "./..."], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

type Finding = Analysis["findings"][number];
const SCOPE: Finding = { id: "F-001", kind: "scope", refs: ["spec.json", "inScope"], description: "spec.json adds a CI matrix that the request does not ask for.", blocking: true };
const STUBS: Finding = { id: "F-002", kind: "inconsistency", refs: ["spec.json", "FR-001", "plan.md"], description: "The stub comment wording in FR-001 contradicts plan.md DEC-002.", blocking: true };
const DOUBLE: Finding = { id: "F-001", kind: "inconsistency", refs: ["spec.json", "AC-004", "FR-005"], description: "AC-004 requires 'a failing ReadStdin test double' and '<stdin>: cannot read the file', but FR-005 forbids 'named test types' and MemIO always returns its supplied Stdin. Reconcile AC-004 with the test-type restriction (for example, remove the mandatory failing-stdin double while testing read-error handling through a missing in-memory file, or drop the stdin case).", blocking: true };

class ScriptedExecutor implements AgentExecutor {
  specs = 0;
  analyses = 0;
  prompts: string[] = [];
  constructor(private sourceRefs: string[], private passes: Finding[][]) {}
  async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as { inputHash: string; spec: Spec | null };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "Empty", facts: [], unknowns: [], constraints: [], suggestedScope: ["io.go"] }; break;
      case "spec":
        this.specs++;
        this.prompts.push(request.prompt);
        output = specWith(this.sourceRefs);
        break;
      case "plan": {
        const spec = data.spec ?? specWith(this.sourceRefs);
        const graph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Implement IO", description: "Implement", requirementIds: ["FR-004", "FR-005"], criterionIds: ["AC-004"], dependsOn: [], profileId: "implementer", writes: [{ path: "io.go", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" }] };
        output = { schemaVersion: 1, markdown, taskGraph: graph };
        break;
      }
      case "analysis": {
        const findings = this.passes[this.analyses++] ?? [];
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: findings.some((f) => f.blocking) ? "needs_revision" : "pass", findings };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function plan(executor: ScriptedExecutor) {
  const root = mkdtempSync(join(tmpdir(), "baked-late-inconsistency-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: BRIEF, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const pending = (kind: string) => service.store.requests(run.runId).filter((r) => r.kind === kind && r.status === "pending");
  return { service, runId: run.runId, pending };
}

describe("scenario: hdrlens base 38dd8595, a late inconsistency after the reroute budget (#1830)", () => {
  test("a finding that sets the artifacts against a requirement restating the request is settled for the request", async () => {
    const executor = new ScriptedExecutor(["request"], [[SCOPE, STUBS], [SCOPE], [DOUBLE]]);
    const { service, runId, pending } = await plan(executor);
    expect(pending("clarification")).toHaveLength(0);
    expect(pending("approval")).toHaveLength(1);
    expect(executor.analyses).toBe(3);
    expect(service.store.state(runId)).toMatchObject({ analysisPassed: true });
    const assumed = service.store.latestArtifact(runId, "assumptions/analysis.json");
    expect(assumed && service.store.readArtifact(runId, assumed.id)).toContain("FR-005 forbids");
  }, 60000);

  test("a new inconsistency gets a defect round of its own instead of a person", async () => {
    const executor = new ScriptedExecutor([], [[SCOPE, STUBS], [SCOPE], [DOUBLE], []]);
    const { service, runId, pending } = await plan(executor);
    expect(pending("clarification")).toHaveLength(0);
    expect(executor.analyses).toBe(4);
    expect(executor.specs).toBe(4);
    expect(executor.prompts.at(-1)).toContain("concrete inconsistencies that already survived one correction");
    expect(executor.prompts.at(-1)).toContain("failing ReadStdin test double");
    expect(service.store.state(runId)).toMatchObject({ analysisPassed: true, lateDefectRounds: 1 });
  }, 60000);

  test("late defect rounds stop at the cap and a survivor still asks", async () => {
    const other = (n: number): Finding => ({ ...DOUBLE, id: `F-00${n}`, refs: ["spec.json", `AC-00${n}`], description: `AC-00${n} contradicts FR-00${n} in the stdin case.` });
    const executor = new ScriptedExecutor([], [[SCOPE, STUBS], [SCOPE], [DOUBLE], [other(5)], [other(6)]]);
    const { service, runId, pending } = await plan(executor);
    expect(executor.analyses).toBe(5);
    expect(pending("clarification")).toHaveLength(1);
    expect(service.store.state(runId)).toMatchObject({ lateDefectRounds: 2 });
  }, 60000);

  test("an inconsistency on refs an earlier pass raised, naming no request requirement, still asks", async () => {
    const again: Finding = { ...STUBS, description: "The stub comment wording in FR-001 still contradicts plan.md DEC-002." };
    const executor = new ScriptedExecutor([], [[SCOPE, STUBS], [SCOPE], [again]]);
    const { pending } = await plan(executor);
    expect(executor.analyses).toBe(3);
    expect(pending("clarification")).toHaveLength(1);
  }, 60000);
});

describe("late inconsistency helpers", () => {
  test("a requirement restating the request counts as the request's side", () => {
    expect(requestRequirements(DOUBLE.description, specWith(["request"]))).toEqual(["FR-005"]);
    expect(requestRequirements(DOUBLE.description, specWith([]))).toEqual([]);
    expect(requestSettles(DOUBLE, specWith(["request"]))).toBe(true);
    expect(requestSettles(DOUBLE)).toBe(false);
    expect(requestSettles({ ...DOUBLE, description: "AC-004 mentions FR-005 in passing." }, specWith(["request"]))).toBe(false);
  });

  test("a new facet is an inconsistency on refs no earlier pass raised", () => {
    expect(newFacet(DOUBLE, [SCOPE, STUBS])).toBe(true);
    expect(newFacet(DOUBLE, [{ kind: "scope", refs: ["FR-005", "spec.json", "AC-004"] }])).toBe(false);
    expect(newFacet(SCOPE, [])).toBe(false);
  });
});
