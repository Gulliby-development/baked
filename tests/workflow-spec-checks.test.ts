import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  type RunPolicy,
  type Spec,
  hostBoundCriteria,
  manualRepositoryCriteria,
  specCoverageProblems,
  validateSpecCoverage,
  validateTaskGraph,
} from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

const requirement = (id: string) => ({ id, text: `${id} holds`, priority: "must" as const, verification: "automated" as const, sourceRefs: [] });
const criterion = (id: string, requirementIds: string[]) => ({ id, requirementIds, given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" as const });
// The mdtoc spec shape (run 9db0dfdd): FR-001 has no criterion.
const base: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [requirement("FR-001"), requirement("FR-002")], criteria: [criterion("AC-001", ["FR-002"])], dependencies: [] };
const fixed: Spec = { ...base, criteria: [criterion("AC-001", ["FR-002"]), criterion("AC-002", ["FR-001"])] };

describe("spec-side checks", () => {
  test("a requirement without a criterion is a spec defect with an actionable message", () => {
    expect(validateSpecCoverage(base)).toEqual(["requirement without criterion FR-001", "engineering requirement deferred FR-001"]);
    const [message] = specCoverageProblems(base);
    expect(message).toContain("requirement without criterion FR-001");
    expect(message).toContain("requirementIds");
    expect(specCoverageProblems(fixed)).toEqual([]);
  });
  test("a manual criterion about a repository file is sent back to the spec author", () => {
    const readme = { ...criterion("AC-003", ["FR-001"]), given: "the README.md", when: "a person reads it", then: "it lists the install command", method: "manual" as const };
    const spec: Spec = { ...fixed, criteria: [...fixed.criteria, readme] };
    expect(manualRepositoryCriteria(spec)).toEqual(["AC-003"]);
    expect(specCoverageProblems(spec).join(" ")).toContain("criterion AC-003 is about a file in the repository");
    // A behavior only a person can observe stays manual.
    const visual = { ...readme, id: "AC-004", given: "the app in a browser", when: "a person opens it", then: "the layout looks balanced" };
    expect(specCoverageProblems({ ...fixed, criteria: [...fixed.criteria, visual] })).toEqual([]);
    expect(specCoverageProblems({ ...fixed, criteria: [...fixed.criteria, { ...readme, method: "automated" as const }] })).toEqual([]);
  });
  test("a manual criterion about a property of the code is sent back to the spec author", () => {
    // logslice 242ff843 AC-021: three reviews passed it, converge still asked a person.
    const streaming = { ...criterion("AC-021", ["FR-001"]), given: "a large input", when: "a reviewer inspects it", then: "input is iterated line by line and not read fully", method: "manual" as const };
    const spec: Spec = { ...fixed, criteria: [...fixed.criteria, streaming] };
    expect(manualRepositoryCriteria(spec)).toEqual(["AC-021"]);
    expect(specCoverageProblems(spec).join(" ")).toContain("criterion AC-021 is about a file in the repository or a property of its code");
  });
  test("an automated criterion only other platforms can prove is sent back to the spec author", () => {
    // propdrift eea2e0e9 AC-008: blocked at converge, two identical convergence calls.
    const crossOs = { ...criterion("AC-005", ["FR-001"]), given: "the CLI", when: "it runs", then: "MIT license terms are present and behavior is confirmed on Windows, macOS, and Linux" };
    const crossBrowser = { ...criterion("AC-006", ["FR-001"]), given: "the page", when: "opened in Chrome and Firefox", then: "the layout renders" };
    const device = { ...criterion("AC-007", ["FR-001"]), given: "the app", when: "installed on a real device", then: "it starts" };
    const generic = { ...criterion("AC-008", ["FR-001"]), given: "the tool", when: "it runs", then: "it is cross-platform" };
    const spec: Spec = { ...fixed, criteria: [...fixed.criteria, crossOs, crossBrowser, device, generic] };
    expect(hostBoundCriteria(spec)).toEqual(["AC-005", "AC-006", "AC-007", "AC-008"]);
    expect(specCoverageProblems(spec).join(" ")).toContain("criterion AC-005 is automated but claims behavior on other operating systems");
    // Checkable here: a CI matrix file, a simulated platform, one named OS, or a manual criterion.
    const matrix = { ...crossOs, then: "the CI workflow runs the tests on a matrix of ubuntu-latest, macos-latest and windows-latest" };
    const simulated = { ...crossOs, then: "paths built with path.win32 and path.posix both resolve on Windows and Linux" };
    const oneOs = { ...crossOs, then: "the script runs on Linux" };
    const manual = { ...crossOs, method: "manual" as const };
    for (const c of [matrix, simulated, oneOs, manual]) expect(hostBoundCriteria({ ...fixed, criteria: [...fixed.criteria, c] })).toEqual([]);
    // "edge case" is not the Edge browser.
    expect(hostBoundCriteria({ ...fixed, criteria: [...fixed.criteria, { ...crossOs, then: "Chrome handles the edge case" }] })).toEqual([]);
  });
  test("the task graph check still reports the spec defects", () => {
    const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "", planHash: "", tasks: [] };
    expect(validateTaskGraph(base, graph)).toContain("requirement without criterion FR-001");
  });
});

const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";

class SpecExecutor implements AgentExecutor {
  calls: string[] = [];
  specErrors: string[][] = [];
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
        break;
      case "spec": {
        output = base;
        const errors = request.validate?.(output) ?? [];
        this.specErrors.push(errors);
        if (errors.length) output = fixed;
        break;
      }
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixed), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001", "FR-002"], criterionIds: ["AC-001", "AC-002"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } };
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

describe("the specify stage", () => {
  test("corrects a spec with an uncovered requirement before the planner sees it", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-spec-checks-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new SpecExecutor();
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.specErrors[0]?.[0]).toContain("requirement without criterion FR-001");
    expect(service.store.state(run.runId).spec?.criteria.map((c) => c.id)).toEqual(["AC-001", "AC-002"]);
    expect(executor.calls.filter((c) => c === "spec")).toHaveLength(1);
  });
});
