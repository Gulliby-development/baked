import { afterEach, describe, expect, test } from "bun:test";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import {
  assumable,
  hostDependencyEdges,
  isCountNit,
  isHostEdgeNit,
  knownRisks,
  restrictsRequest,
  supersedeResearch,
} from "../src/core/workflows/analysis-notes.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const task = (id: string, path: string, dependsOn: string[] = [], readHints: string[] = []) => ({
  id,
  title: id,
  description: id,
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn,
  profileId: "implementer",
  writes: [{ path, action: "create" as const }],
  readHints,
  checkIds: [],
  origin: "planned" as const,
  findingIds: [],
  rationale: id,
});
const graph = (...tasks: ReturnType<typeof task>[]): TaskGraph => ({
  schemaVersion: 1,
  featureId: "fixture",
  revision: 1,
  specHash: "a".repeat(64),
  planHash: "b".repeat(64),
  tasks,
});

describe("dependency edges the host adds (dirdrift)", () => {
  // The planner gave T007 one edge; the host appended the code tasks that share its criterion.
  const g = graph(
    task("T003", "src/scan.ts"),
    task("T004", "src/diff.ts"),
    task("T007", "tests/scan.test.ts", ["T003", "T004"]),
    task("T008", "src/report.ts", ["T003"], ["src/diff.ts"]),
  );
  test("lists the stored edges the host would add whatever the planner wrote", () => {
    // T008 -> T003 is the planner's own; the read-hint edge T008 -> T004 is not in the stored graph.
    expect(hostDependencyEdges(g)).toEqual([
      { task: "T007", dependsOn: "T003" },
      { task: "T007", dependsOn: "T004" },
    ]);
  });
  test("a finding about those edges is a note; one naming a planner edge is kept", () => {
    const edges = hostDependencyEdges(g);
    const ids = g.tasks.map((t) => t.id);
    const finding = (refs: string[], description: string) => ({ refs, description });
    expect(
      isHostEdgeNit(
        finding(["tasks.json", "T007"], "T007 dependsOn T003 and T004, but plan.md says no dependency between tasks"),
        edges,
        ids,
      ),
    ).toBe(true);
    expect(isHostEdgeNit(finding(["T008"], "T008 depends on T003 although plan.md lists none"), edges, ids)).toBe(false);
    expect(isHostEdgeNit(finding(["T007"], "T007 tests a behaviour no criterion names"), edges, ids)).toBe(false);
    expect(isHostEdgeNit(finding(["T007"], "T007 dependsOn T003 only"), [], ids)).toBe(false);
  });
});

describe("count nits", () => {
  test("a finding that only compares task or file counts is recognised (jsondelta, cronsay)", () => {
    expect(isCountNit("plan.md says 14 files, but the task graph lists 12 files")).toBe(true);
    expect(isCountNit("The plan says 8 tasks while tasks.json has 9 tasks")).toBe(true);
  });
  test("a finding that names a requirement, task or a single count is kept", () => {
    expect(isCountNit("plan.md says 8 tasks while tasks.json has 9 tasks; AC-004 is covered by none")).toBe(false);
    expect(isCountNit("T004 writes 3 files that T002 also writes, 2 files overlap")).toBe(false);
    expect(isCountNit("The plan needs 3 files for the parser")).toBe(false);
  });
});

describe("an analysis finding about host-added edges", () => {
  test("is told to the analyzer, kept as a note and does not stop the run", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    const prompts: string[] = [];
    const markdown =
      "# Plan\n## Context\nCreate value.txt and its test.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nT002 tests T001\n## Risks\nNone";
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "plan")
        return {
          output: {
            schemaVersion: 1,
            markdown,
            taskGraph: {
              ...graph(task("T001", "value.txt"), task("T002", "tests/value.test.ts")),
              specHash: hashJson(fixtureSpec),
              planHash: hashBytes(markdown),
            },
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      if (request.profile.output === "analysis") {
        prompts.push(request.prompt);
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: "needs_revision",
            findings: [
              {
                id: "F-001",
                kind: "inconsistency",
                refs: ["tasks.json", "T002"],
                description: "T002 dependsOn T001 in tasks.json, but plan.md says there is no dependency between tasks",
                blocking: true,
              },
            ],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      return original(request);
    };
    const run = await fixture.start();
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(prompts.at(-1)).toContain("T002 after T001");
    // Passed on the first analysis: no reroute to the planner and no question for a person.
    expect(service.store.state(run.runId)).toMatchObject({ analysisPassed: true, analysisReplans: 0 });
  });
});

describe("answers to analysis findings", () => {
  const research = {
    schemaVersion: 1 as const,
    summary: "No existing project files were inspected",
    facts: [{ statement: "Links are relative", paths: [] }],
    unknowns: [],
    constraints: [],
    suggestedScope: [],
  };
  test("the research gets a superseding fact that names the finding and the answer", () => {
    const patched = supersedeResearch(
      research,
      [{ id: "F-002", description: "Research says links are relative; the spec says absolute" }],
      { "F-002": "Use absolute links" },
    );
    expect(patched.facts).toHaveLength(2);
    expect(patched.facts[0]?.statement).toContain("Superseded by the user's answer");
    expect(patched.facts[0]?.statement).toContain("Use absolute links");
    expect(patched.facts[0]?.statement).toContain("links are relative");
    expect(patched.facts[1]).toEqual(research.facts[0]);
  });
  test("an answer that matches no finding is still recorded", () => {
    const patched = supersedeResearch(research, [], { "Q-1": "Yes" });
    expect(patched.facts[0]?.statement).toContain("(Q-1): Yes");
  });
  test("scope findings are never settled by an assumption", () => {
    expect(assumable({ kind: "scope", blocking: true })).toBe(false);
    expect(assumable({ kind: "ambiguity", blocking: true })).toBe(true);
    expect(assumable({ kind: "inconsistency", blocking: true })).toBe(false);
  });
});

describe("a scope finding that adds a restriction the request lacks", () => {
  const base = { id: "F-001", kind: "scope", blocking: true };
  test("is recognised by its wording", () => {
    expect(restrictsRequest({ ...base, description: "The spec restricts ISO 8601 input to three forms; the request names no such limit" })).toBe(true);
    expect(restrictsRequest({ ...base, description: "FR-002 excludes root-relative links, which the request does not exclude" })).toBe(true);
  });
  test("is not recognised for a dropped clause, the host coverage finding or another kind", () => {
    expect(restrictsRequest({ ...base, description: "The spec omits the --json flag the request asks for" })).toBe(false);
    expect(restrictsRequest({ id: "COVERAGE-1", kind: "scope", blocking: true, description: "No task limits itself to source files" })).toBe(false);
    expect(restrictsRequest({ ...base, kind: "ambiguity", description: "restricts the forms" })).toBe(false);
    expect(restrictsRequest({ ...base, blocking: false, description: "restricts the forms" })).toBe(false);
  });
});

describe("known risks for reviewers", () => {
  test("the assumptions of analysis reach the reviewers as risks to check first", () => {
    const risks = knownRisks(JSON.stringify({ assumed: [{ id: "F-001", kind: "ambiguity", refs: ["spec.json"], description: "Zero total shows 0%" }] }));
    expect(risks?.assumed).toEqual([{ id: "F-001", kind: "ambiguity", refs: ["spec.json"], description: "Zero total shows 0%" }]);
    expect(risks?.note).toContain("Check the result against each of them first");
    expect(knownRisks(null)).toBeNull();
    expect(knownRisks("not json")).toBeNull();
    expect(knownRisks(JSON.stringify({ assumed: [] }))).toBeNull();
  });
});
