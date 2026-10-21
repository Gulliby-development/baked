import { afterEach, describe, expect, test } from "bun:test";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import {
  crossPlatformAnalysisNote,
  crossPlatformCriterionRequired,
  crossPlatformNote,
} from "../src/core/workflows/cross-platform.js";
import {
  asksUnrequiredPlatforms,
  CROSS_PLATFORM_CRITERION,
  HOST_REQUIRED_ANALYSIS_RULE,
  HOST_REQUIRED_CRITERIA,
} from "../src/core/workflows/host-required-criteria.js";
import { deliverableProblems, requestCoverage } from "../src/core/workflows/request-coverage.js";
import { newId } from "../src/core/workflows/store.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R56 hdrlens (#1831): the brief says "Keep the project cross-platform (Windows, macOS, Linux)" and
// "No CI workflow is wanted". The specify note told the author to write only host-checkable
// criteria, but the analysis table said the host requires a three-OS criterion whenever the
// request names other operating systems, so freshness, cookies and front looped specify, plan and
// analyze twice over the missing criterion (1.02M tokens, 13 minutes on the critical path).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const NO_CI_REQUEST =
  "Create ready value. Keep the project cross-platform (Windows, macOS, Linux). No CI workflow is wanted: do not add a `.github` folder.";
const CI_REQUEST = "Create ready value. It must run on Windows, macOS and Linux, checked by a CI workflow.";
// The front analysis of R56 (07:25:57), with the spec ids of the fixture.
const R56_FINDING =
  "The request says 'Keep the project cross-platform (Windows, macOS, Linux)'. FR-001 only requires the checks to pass on this host; no criterion covers Windows, macOS and Linux.";

describe("the cross-platform criterion has one condition in every reader (#1831)", () => {
  test("the table's predicate, the author's note and the reviewer's note agree", () => {
    const requests = [NO_CI_REQUEST, CI_REQUEST, "Create ready value.", "It must run on Windows and Linux.", "Support Linux and macOS without GitHub Actions."];
    for (const request of requests) {
      const required = CROSS_PLATFORM_CRITERION.required(request, "/nonexistent");
      expect(required).toBe(crossPlatformCriterionRequired(request, "/nonexistent"));
      expect(crossPlatformNote(request, "/nonexistent")?.includes(CROSS_PLATFORM_CRITERION.outcome) ?? false).toBe(required);
      expect(crossPlatformAnalysisNote(request, "/nonexistent")?.startsWith("The host requires a criterion") ?? false).toBe(required);
    }
    expect(crossPlatformCriterionRequired(NO_CI_REQUEST, "/nonexistent")).toBe(false);
    expect(crossPlatformAnalysisNote(NO_CI_REQUEST, "/nonexistent")).toContain("wants no CI");
    expect(crossPlatformAnalysisNote("Create ready value.", "/nonexistent")).toBeNull();
  });

  test("every host-required entry states its condition through a predicate the reviewer reads", () => {
    const reviewer = builtinProfiles.find((p) => p.id === "spec-reviewer")?.instructions ?? "";
    expect(reviewer).toContain(HOST_REQUIRED_ANALYSIS_RULE);
    for (const c of HOST_REQUIRED_CRITERIA) {
      expect(typeof c.required).toBe("function");
      expect(HOST_REQUIRED_ANALYSIS_RULE).toContain(c.condition);
    }
    expect(CROSS_PLATFORM_CRITERION.condition).toContain("does not turn CI down");
    expect(HOST_REQUIRED_ANALYSIS_RULE).toContain("the request wants no CI");
  });

  test("a blocking coverage finding asking for other operating systems is recognised only when the request turns CI down", () => {
    const finding = { kind: "coverage", blocking: true, description: R56_FINDING };
    expect(asksUnrequiredPlatforms(finding, NO_CI_REQUEST, "/nonexistent")).toBe(true);
    expect(asksUnrequiredPlatforms({ ...finding, kind: "scope" }, NO_CI_REQUEST, "/nonexistent")).toBe(true);
    expect(asksUnrequiredPlatforms(finding, CI_REQUEST, "/nonexistent")).toBe(false);
    expect(asksUnrequiredPlatforms(finding, "Create ready value.", "/nonexistent")).toBe(false);
    expect(asksUnrequiredPlatforms({ ...finding, kind: "inconsistency" }, NO_CI_REQUEST, "/nonexistent")).toBe(false);
    expect(asksUnrequiredPlatforms({ ...finding, description: "FR-002 drops the --json flag the request names." }, NO_CI_REQUEST, "/nonexistent")).toBe(false);
  });

  test("tonemath-update: the host's own words for the criterion are an accepted deliverable quote", () => {
    const quote = "add a criterion that the product's tests pass on Windows, macOS and Linux";
    const spec: Spec = {
      ...fixtureSpec,
      deliverables: [...(fixtureSpec.deliverables ?? []), { quote, requirementIds: [fixtureSpec.requirements[0]?.id ?? "FR-001"] }],
    };
    const request = "Add a unicode feature. The project's CI runs on three operating systems.";
    expect(deliverableProblems(spec, request).filter((p) => p.includes(quote))).toEqual([]);
    expect(requestCoverage(spec, request).find((row) => row.deliverable === quote)?.mapped).toBe(true);
    // An invented quote is still rejected.
    const invented = { ...spec, deliverables: [{ quote: "add a release workflow", requirementIds: ["FR-001"] }] };
    expect(deliverableProblems(invented, request).some((p) => p.includes("is not a passage of the request"))).toBe(true);
  });

  async function scenario(prompt: string) {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    let analyses = 0;
    const analysisPrompts: string[] = [];
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: fixtureSpec, inputTokens: 25, outputTokens: 25 };
      if (request.profile.output === "analysis") {
        analyses++;
        analysisPrompts.push(request.prompt);
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: "needs_revision",
            findings: [{ id: "F-001", kind: "coverage", refs: ["spec.json", "FR-001"], description: R56_FINDING, blocking: true }],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string } };
        plan.taskGraph.specHash = hashJson(fixtureSpec);
        plan.taskGraph.planHash = hashBytes(plan.markdown);
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: fixture.policy });
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    return { snapshot, analyses, analysisPrompts, calls: executor.calls, state: service.store.state(run.runId) };
  }

  test("hdrlens front: the finding is a note when the request wants no CI, and the run reaches approval after one pass", async () => {
    const { snapshot, analyses, analysisPrompts, calls, state } = await scenario(NO_CI_REQUEST);
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(analyses).toBe(1);
    expect(calls.filter((c) => c === "plan")).toHaveLength(1);
    expect(state).toMatchObject({ analysisPassed: true, analysisReplans: 0 });
    expect(analysisPrompts[0]).toContain("wants no CI, so the host requires no criterion");
  }, 60000);

  test("when the request asks for CI, the same finding still blocks", async () => {
    const { snapshot, analyses, analysisPrompts } = await scenario(CI_REQUEST);
    expect(snapshot.reason === "approval" && analyses === 1).toBe(false);
    expect(analysisPrompts[0]).toContain(`The host requires a criterion that ${CROSS_PLATFORM_CRITERION.outcome}`);
  }, 60000);
});
