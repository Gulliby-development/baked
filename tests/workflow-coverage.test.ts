import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { coverageFinding, describesProgram, writesNoCode } from "../src/core/workflows/coverage.js";
import { workspaceFacts } from "../src/core/workflows/workspace-facts.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "baked-coverage-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const BRIEF = "TypeScript CLI on Bun that slices log files by time. Tests and a README.";

function graphOf(...paths: string[]): TaskGraph {
  return {
    schemaVersion: 1,
    featureId: "fixture",
    revision: 1,
    specHash: "a".repeat(64),
    planHash: "b".repeat(64),
    tasks: paths.map((path, index) => ({
      id: `T00${index + 1}`,
      title: "Task",
      description: "Task",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: "implementer",
      writes: [{ path, action: "create" as const }],
      readHints: [],
      checkIds: [],
      origin: "planned" as const,
      findingIds: [],
      rationale: "Required",
    })),
  };
}

describe("workspace kind", () => {
  test("a folder without source files holds no source, whatever else it holds", () => {
    const root = temp();
    expect(workspaceFacts(root).kind).toBe("empty");
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(root, "README.md"), "# Readme");
    writeFileSync(join(root, "package.json"), "{}");
    expect(workspaceFacts(root).kind).toBe("scaffold");
  });
  test("a source file at any of the first levels makes it source", () => {
    const root = temp();
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "a.py"), "");
    expect(workspaceFacts(root).kind).toBe("source");
  });
});

describe("request coverage finding", () => {
  test("describing a program and planning only docs on an empty workspace is a blocking scope finding", () => {
    const finding = coverageFinding(BRIEF, "scaffold", graphOf("README.md", "LICENSE", "package.json"));
    expect(finding?.blocking).toBe(true);
    expect(finding?.kind).toBe("scope");
    expect(finding?.refs).toContain("spec.json");
    expect(finding?.description).toContain("README.md, LICENSE, package.json");
  });
  test("no finding when code is planned, the workspace has code, or the request is about documentation", () => {
    expect(coverageFinding(BRIEF, "scaffold", graphOf("README.md", "src/cli.ts"))).toBeNull();
    expect(coverageFinding(BRIEF, "source", graphOf("README.md"))).toBeNull();
    expect(coverageFinding("Write the contributing guide and a license", "scaffold", graphOf("CONTRIBUTING.md", "LICENSE"))).toBeNull();
    expect(writesNoCode(graphOf("tests/a.test.ts"))).toBe(false);
    expect(describesProgram("Add a REST API with tests")).toBe(true);
  });
});

const spec: Spec = {
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  title: "Fixture",
  problem: "Missing docs",
  outcome: "Docs exist",
  inScope: ["README"],
  outOfScope: ["The CLI"],
  assumptions: [],
  openQuestions: [],
  requirements: [{ id: "FR-001", text: "Readme exists", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "readme exists", method: "automated" }],
  dependencies: [],
};

class DocsOnlyExecutor implements AgentExecutor {
  calls: ExecutionRequest[] = [];
  async execute(request: ExecutionRequest) {
    this.calls.push(request);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    switch (request.profile.output) {
      case "research":
        return { output: { schemaVersion: 1, summary: "No source", facts: [], unknowns: [], constraints: [], suggestedScope: ["README.md"] }, inputTokens: 1, outputTokens: 1 };
      case "spec":
        return { output: spec, inputTokens: 1, outputTokens: 1 };
      case "plan": {
        const markdown = "# Plan\n## Context\nDocs.\n## Decisions\nDEC-001: FR-001 needs a readme.\n## Components\nREADME.md\n## Data\nText\n## Verification\nCheck\n## Risks\nNone";
        const task = graphOf("README.md").tasks[0];
        return { output: { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }, inputTokens: 1, outputTokens: 1 };
      }
      case "analysis":
        return { output: { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }, inputTokens: 1, outputTokens: 1 };
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
  }
}

describe("the analysis stage", () => {
  test("a docs-only plan for a described program stops for the spec even when the analysis passes it", async () => {
    const root = temp();
    writeFileSync(join(root, "package.json"), "{}");
    const policy: RunPolicy = { ...defaultWorkflowPolicy };
    const executor = new DocsOnlyExecutor();
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } }, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: BRIEF, ownerLabel: "test", policy });
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("clarification");
    const question = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    expect(question?.body_json).toContain("COVERAGE-1");
    expect(service.store.state(run.runId).analysisPassed).toBe(false);
    // The agents are told the workspace is empty.
    const research = executor.calls.find((call) => call.profile.output === "research");
    expect(research?.prompt).toContain('"workspaceFacts"');
    expect(research?.prompt).toContain('"kind":"scaffold"');
    // Every stage that reads the workspace gets the same host inventory, and the run page shows it.
    for (const output of ["spec", "plan", "analysis"])
      expect(executor.calls.find((call) => call.profile.output === output)?.prompt).toContain('"workspaceFacts"');
    expect(service.store.artifacts(run.runId).some((a) => a.logical_path === "facts/workspace.json")).toBe(true);
  });
  test("the research, specification and analysis instructions state the rule", () => {
    const text = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect(text("researcher")).toContain("workspaceFacts");
    expect(text("spec-author")).toContain("never outOfScope");
    expect(text("spec-reviewer")).toContain("request too");
  });
});
