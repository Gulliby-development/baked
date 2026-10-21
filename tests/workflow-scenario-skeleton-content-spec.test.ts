import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { InitiativeFeature, InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { featurePrompt } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeRow } from "../src/core/workflows/initiatives/store.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { hostFileSpecProblems } from "../src/core/workflows/task-graph.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 57, modeplan (C#/.NET, #1847). The decomposer gave foundation 16
// host-written stubs holding "// Implementation is owned by a later feature." The feature's request
// said the split fixes their whole content but did not say what it is, so the spec author asked
// which comment the stubs hold and wrote "// Implementation deferred to its owning feature." into
// AC-001. The planner used the real text, analysis raised the inconsistency, and a second specify,
// plan and analyze round cost 407k tokens and 8.8 minutes at the head of the critical path. R56
// hdrlens base (Go) had the same finding on its stub comment.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const STUB = "// Implementation is owned by a later feature.\n";
const GROUPS = ["Apply/Steps", "Plan/Planner", "Match/Matcher", "Audit/Auditor", "Tree/Tree", "Cli"];
const SKELETON = GROUPS.map((g) => ({ path: `src/Modeplan/${g}.cs`, content: STUB }));
const feature = (id: string, paths: string[], dependsOn: string[], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
  id, title: id, boundary: { scope: `Own the ${id} code`, paths }, contract: `${id} works`, dependsOn, mandatory: true, size: "medium", ...extra,
});
const modeplan: InitiativePlan = {
  schemaVersion: 1, title: "modeplan", goals: ["A file-mode planner"], completionCriteria: ["Every command works"],
  features: [
    feature("foundation", ["src/Modeplan/Base/Text.cs", "tests/Modeplan.Tests/TextTests.cs", ...SKELETON.map((s) => s.path)], [], { skeleton: SKELETON }),
    feature("apply", ["src/Modeplan/Apply/Steps.cs", "tests/Modeplan.Tests/ApplyTests.cs"], ["foundation"]),
    feature("plan", ["src/Modeplan/Plan/Planner.cs", "src/Modeplan/Match/Matcher.cs", "tests/Modeplan.Tests/PlanTests.cs"], ["foundation"]),
    feature("front", ["src/Modeplan/Audit/*.cs", "src/Modeplan/Tree/Tree.cs", "src/Modeplan/Cli.cs", "tests/Modeplan.Tests/CliTests.cs"], ["apply", "plan"]),
  ],
};

const requirement = (id: string, text: string) => ({ id, text, priority: "must" as const, verification: "automated" as const, sourceRefs: [] });
const criterion = (id: string, then: string) => ({ id, requirementIds: ["FR-001"], given: "the foundation feature is delivered", when: "a later-layer stub file is read", then, method: "automated" as const });
const spec = (then: string): Spec => ({
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Foundation", problem: "No base layer", outcome: "Base exists",
  inScope: ["Base layer and stubs"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [requirement("FR-001", "The later-layer stubs keep the content the split fixes")],
  criteria: [criterion("AC-001", then)], dependencies: [],
});
const invented = spec('each stub contains exactly "// Implementation deferred to its owning feature."');
const quoted = spec('each stub contains exactly "// Implementation is owned by a later feature."');

describe("host-written stub content reaches the spec author (#1847)", () => {
  test("the feature's request quotes the content of every stub", () => {
    const row = { id: "modeplan", prompt: "Build modeplan." } as InitiativeRow;
    const foundation = modeplan.features[0] as InitiativeFeature;
    const prompt = featurePrompt(row, modeplan, foundation, []);
    for (const { path } of SKELETON) expect(prompt).toContain(`- ${path}: ${JSON.stringify(STUB)}`);
    expect(prompt).toContain("Quote the content exactly wherever a requirement, criterion, plan or test names it");
    // Each stub a later feature fills is named with it; a glob boundary counts (front's Audit/*.cs).
    expect(prompt).toContain("src/Modeplan/Apply/Steps.cs (apply)");
    expect(prompt).toContain("src/Modeplan/Audit/Auditor.cs (front)");
    // foundation was not merged with a filler, so it implements none of its stubs.
    expect(prompt).not.toContain("This feature implements");
  });

  test("a criterion that rewords a stub's comment is a spec problem naming the real content", () => {
    const [problem, ...rest] = hostFileSpecProblems(invented, SKELETON);
    expect(rest).toEqual([]);
    expect(problem).toContain('AC-001 quotes "// Implementation deferred to its owning feature."');
    expect(problem).toContain(JSON.stringify(STUB.trim()));
    expect(hostFileSpecProblems(quoted, SKELETON)).toEqual([]);
    expect(hostFileSpecProblems(invented, null)).toEqual([]);
    // A quoted comment in a sentence about something else is not a stub's content.
    const other = spec('the CLI prints "// generated by modeplan" as the first line of a plan');
    const header = { ...other, requirements: [requirement("FR-001", "The CLI prints a header")], criteria: other.criteria.map((c) => ({ ...c, when: "a plan is printed" })) };
    expect(hostFileSpecProblems(header, SKELETON)).toEqual([]);
  });

  test("the same holds for the comment syntax of other languages", () => {
    const python = [{ path: "modeplan/plan.py", content: "# Filled by the plan feature.\n" }];
    const reworded = spec("plan.py holds `# To be implemented by plan.`");
    expect(hostFileSpecProblems(reworded, python)[0]).toContain('"# To be implemented by plan."');
    expect(hostFileSpecProblems(spec("plan.py holds `# Filled by the plan feature.`"), python)).toEqual([]);
    const ocaml = [{ path: "lib/plan.ml", content: "(* Filled by the plan feature. *)\n" }];
    expect(hostFileSpecProblems(spec('the stub holds "(* TODO *)"'), ocaml)).toHaveLength(1);
    const lua = [{ path: "plan.lua", content: "-- Filled by the plan feature.\n" }];
    expect(hostFileSpecProblems(spec('the stub holds "-- Filled by the plan feature."'), lua)).toEqual([]);
  });

  test("a run with host files sends the reworded spec back to its author before planning", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-skeleton-spec-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor();
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Build the foundation.", ownerLabel: "test", policy, hostFiles: SKELETON });
    await service.drive(run.runId, new AbortController().signal);
    expect(executor.specErrors[0]?.join("\n")).toContain("AC-001 quotes");
    expect(service.store.state(run.runId).spec?.criteria[0]?.then).toBe(quoted.criteria[0]?.then);
  });
});

class SpecExecutor implements AgentExecutor {
  specErrors: string[][] = [];
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    const markdown = "# Plan\n## Context\nStubs.\n## Decisions\nDEC-001: FR-001 keeps the stubs.\n## Components\nsrc\n## Data\nNone\n## Verification\ncheck\n## Risks\nNone for fixture";
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] };
        break;
      case "spec": {
        const errors = request.validate?.(invented) ?? [];
        this.specErrors.push(errors);
        output = errors.length ? quoted : invented;
        break;
      }
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(quoted), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Write the stubs", description: "Host-written stubs", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: SKELETON.map((s) => ({ ...s, action: "create" as const })), readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
        break;
      case "analysis":
        output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 10, outputTokens: 10 };
  }
}
