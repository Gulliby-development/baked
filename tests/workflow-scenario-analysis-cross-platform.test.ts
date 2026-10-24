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
import { hostBoundCriteria, repairHostBoundCriteria, type Spec } from "../src/core/workflows/schemas.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

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

// Answers to the adversarial review of #1952 (#1964): the three readers of the cross-platform
// decision did not agree on their inputs, and the host's own fallback was judged by the rule that
// produced it.
describe("the cross-platform decision reads one request everywhere (#1964)", () => {
  // R61 taskplan: the only criterion of its requirement asks for the CI jobs' results.
  const ciResults: Spec = {
    ...fixtureSpec,
    requirements: [...fixtureSpec.requirements, { id: "FR-009", text: "The tests pass on the three CI platforms", priority: "must", verification: "automated", sourceRefs: ["request"] }],
    criteria: [
      ...fixtureSpec.criteria,
      { id: "AC-009", requirementIds: ["FR-009"], given: "the delivered revision on ubuntu-latest, macos-latest and windows-latest", when: "the CI matrix runs", then: "each CI job provides evidence that the tests pass", method: "automated" },
    ],
  };

  test("A1: the host's fallback for a CI-results criterion is not host-bound, and a second repair changes nothing", () => {
    expect(hostBoundCriteria(ciResults)).toEqual(["AC-009"]);
    const repaired = repairHostBoundCriteria(ciResults);
    expect(repaired.spec.criteria.find((c) => c.id === "AC-009")?.method).toBe("post-release");
    const fallback = repaired.spec.criteria.find((c) => c.requirementIds.includes("FR-009") && c.method === "automated");
    expect(fallback?.given).toBe("the delivered tree on this host");
    expect(hostBoundCriteria(repaired.spec)).toEqual([]);
    expect(repairHostBoundCriteria(repaired.spec)).toEqual({ spec: repaired.spec, repaired: [] });
  });

  class AskingResearch extends FixtureExecutor {
    asked = false;
    specPrompts: string[] = [];
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "spec") this.specPrompts.push(request.prompt);
      const result = await super.execute(request);
      if (request.profile.output !== "research" || this.asked) return result;
      this.asked = true;
      return { ...result, output: { ...(result.output as Record<string, unknown>), unknowns: [{ question: "Which platforms must it support?", blocking: true }] } };
    }
  }

  async function answered(prompt: string, answer: string) {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const executor = new AskingResearch(fixture.root);
    (fixture.service.scheduler as unknown as { executor: FixtureExecutor }).executor = executor;
    const { service } = fixture;
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: fixture.policy });
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("clarification");
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    if (!request) throw new Error("no clarification");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision }, { kind: "answer", requestId: request.id, answers: { "0": answer } });
    await fixture.resume(run.runId);
    await service.drive(run.runId, new AbortController().signal);
    return { specPrompt: executor.specPrompts.at(-1) ?? "", spec: service.store.state(run.runId).spec };
  }

  test("A3: an answer that adds the platforms reaches the author note and the host-written criterion", async () => {
    const { specPrompt, spec } = await answered("Create ready value.", CI_REQUEST);
    expect(specPrompt).toContain(CROSS_PLATFORM_CRITERION.outcome);
    expect(spec?.criteria.some((c) => CROSS_PLATFORM_CRITERION.matches(c.when))).toBe(true);
  }, 60000);

  test("A3: an answer that turns CI down removes the host-written criterion", async () => {
    const { specPrompt, spec } = await answered("Create ready value. It must run on Windows, macOS and Linux.", "No CI workflow is wanted: do not add a `.github` folder.");
    expect(specPrompt).not.toContain(CROSS_PLATFORM_CRITERION.outcome);
    expect(spec?.criteria.some((c) => CROSS_PLATFORM_CRITERION.matches(c.when))).toBe(false);
  }, 60000);

  test("A2: a revised spec with a CI-results criterion is repaired before it is staged", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    // The CI-results criterion joins a requirement the graph already covers.
    const revised: Spec = { ...fixtureSpec, criteria: [...fixtureSpec.criteria, { ...(ciResults.criteria.at(-1) as Spec["criteria"][number]), requirementIds: ["FR-001"] }] };
    const candidate = await new WorkflowArtifacts(service).stageRevision(run.runId, { commandId: newId(), expectedInputHash: (await service.get(run.runId)).inputHash, spec: revised });
    const staged = JSON.parse(service.store.readArtifact(run.runId, candidate.reportArtifactId)) as { state: { spec: Spec }; repairs?: { hostBound: string[] } };
    expect(staged.state.spec.criteria.find((c) => c.id === "AC-009")?.method).toBe("post-release");
    expect(hostBoundCriteria(staged.state.spec)).toEqual([]);
    expect(staged.repairs?.hostBound).toEqual(["AC-009"]);
  }, 60000);
});
