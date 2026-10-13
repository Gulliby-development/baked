import { describe, expect, test } from "bun:test";
import { evaluateAutoApproval } from "../src/core/workflows/auto-approval.js";
import {
  deliverableProblems,
  quotesRequest,
  requestCoverage,
  unmappedDeliverables,
} from "../src/core/workflows/request-coverage.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import { fixturePolicy, fixtureSpec } from "./helpers/workflow-fixture.js";

const request = "Build envguard, a TypeScript CLI on Bun that checks .env files. Tests and a README. Publishing to npm can wait.";
const spec = (deliverables: Spec["deliverables"]): Spec => ({ ...fixtureSpec, deliverables });
const cli = { quote: "a TypeScript CLI on Bun", requirementIds: ["FR-001"] };

describe("request coverage", () => {
  test("a quote matches the request ignoring case, quotes and whitespace", () => {
    expect(quotesRequest("typescript  CLI on bun", request)).toBe(true);
    expect(quotesRequest("“Tests and a README.”", request)).toBe(true);
    expect(quotesRequest("a Python CLI", request)).toBe(false);
    expect(quotesRequest(" . ", request)).toBe(false);
  });
  test("every deliverable maps to requirements or to an exclusion the request states", () => {
    const covered = spec([cli, { quote: "Publishing to npm", requirementIds: [], outOfScope: "Publishing to npm can wait" }]);
    expect(deliverableProblems(covered, request)).toEqual([]);
    expect(unmappedDeliverables(covered, request)).toEqual([]);
    expect(requestCoverage(covered, request)).toEqual([
      { deliverable: "a TypeScript CLI on Bun", requirementIds: ["FR-001"], criterionIds: ["AC-001"], outOfScope: null, mapped: true },
      { deliverable: "Publishing to npm", requirementIds: [], criterionIds: [], outOfScope: "Publishing to npm can wait", mapped: true },
    ]);
  });
  test("an exclusion the request does not state is sent back and keeps the deliverable unmapped", () => {
    // envguard 45495079: the CLI the request asked for was put out of scope.
    const excluded = spec([{ quote: "a TypeScript CLI on Bun", requirementIds: [], outOfScope: "Implementing the CLI is a later phase" }]);
    expect(deliverableProblems(excluded, request).join(" ")).toContain("is not a passage of the request");
    expect(unmappedDeliverables(excluded, request)).toEqual(["a TypeScript CLI on Bun"]);
  });
  test("missing, invented and unmapped deliverables are sent back", () => {
    expect(deliverableProblems(spec(undefined), request).join(" ")).toContain("deliverables is empty");
    expect(unmappedDeliverables(spec(undefined), request)).toEqual(["the spec lists no deliverables of the request"]);
    const problems = deliverableProblems(spec([
      { quote: "a web dashboard", requirementIds: ["FR-001"] },
      { quote: "Tests and a README", requirementIds: [] },
      { quote: "a TypeScript CLI on Bun", requirementIds: ["FR-009"] },
      { quote: "checks .env files", requirementIds: ["FR-001"], outOfScope: "Publishing to npm can wait" },
    ]), request).join("\n");
    expect(problems).toContain('"a web dashboard" is not a passage of the request');
    expect(problems).toContain('"Tests and a README" maps to no requirement');
    expect(problems).toContain("unknown requirement FR-009");
    expect(problems).toContain("keep one of them");
  });
  test("a request that describes no program and an initiative feature need no list", () => {
    expect(deliverableProblems(spec(undefined), "Fix the typo in the changelog")).toEqual([]);
    expect(deliverableProblems(spec(undefined), "")).toEqual([]);
    expect(unmappedDeliverables(spec(undefined), "")).toEqual([]);
  });
  test("auto approval declines while a deliverable is unmapped", () => {
    const policy = { ...fixturePolicy, autoApproval: { renewal: false, limits: { maxTasks: 5, maxFiles: 5, allowedPaths: ["**"], allowDelete: false, maxTotalTokens: fixturePolicy.maxTotalTokens } } };
    const graph = { schemaVersion: 1 as const, featureId: "fixture", revision: 1, specHash: "a".repeat(64), planHash: "a".repeat(64), tasks: [{ id: "T001", title: "t", description: "d", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/cli.ts", action: "create" as const }], readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "r" }] };
    const manifest = {} as Parameters<typeof evaluateAutoApproval>[1];
    const declined = evaluateAutoApproval(policy, manifest, spec([{ ...cli, requirementIds: [] }]), graph, [], [], { request });
    expect(declined.approval).toBeNull();
    expect(declined.reasons).toContain("Request deliverable not covered by the spec: a TypeScript CLI on Bun");
    expect(evaluateAutoApproval(policy, manifest, spec([cli]), graph, [], [], { request }).approval?.mode).toBe("limits");
  });
});
