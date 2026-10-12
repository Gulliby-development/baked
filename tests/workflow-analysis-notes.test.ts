import { describe, expect, test } from "bun:test";
import { assumable, isCountNit, restrictsRequest, knownRisks, supersedeResearch } from "../src/core/workflows/analysis-notes.js";

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
