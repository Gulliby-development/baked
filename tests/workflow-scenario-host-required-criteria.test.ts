import { afterEach, describe, expect, test } from "bun:test";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { crossPlatformNote } from "../src/core/workflows/cross-platform.js";
import {
  CROSS_PLATFORM_CRITERION,
  HOST_REQUIRED_ANALYSIS_RULE,
  HOST_REQUIRED_CRITERIA,
  hostRequiredIds,
  objectsToHostRequired,
  VIEWPORT_CRITERION,
} from "../src/core/workflows/host-required-criteria.js";
import { newId } from "../src/core/workflows/store.js";
import type { Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// R52 md-site (#1765): the specify rule demands a 1280 px viewport criterion for UI pages, the
// analysis raised it as scope the request does not ask for, and the run ran specify three times and
// plan and analyze four times (740k tokens) until the fourth pass was turned into an amendment.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const VIEWPORT_SPEC: Spec = {
  ...fixtureSpec,
  requirements: [
    ...fixtureSpec.requirements,
    { id: "NFR-001", text: "Generated index and content pages fit a 1280 px wide viewport without horizontal scrolling.", priority: "must", verification: "post-release", sourceRefs: [] },
  ],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-011", requirementIds: ["NFR-001"], given: "the generated pages", when: "a browser opens them at 1280 px", then: "no page scrolls horizontally", method: "post-release" },
  ],
};
const VIEWPORT_FINDING =
  "NFR-001 and AC-011 add mandatory viewport behavior (no horizontal scrolling at 1280 px) that the request does not ask for. Remove the 1280 px/no-horizontal-scrolling acceptance requirement.";

const CROSS_SPEC: Spec = {
  ...fixtureSpec,
  requirements: [
    ...fixtureSpec.requirements,
    { id: "NFR-002", text: "The tests pass on every supported operating system.", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-012", requirementIds: ["NFR-002"], given: "the CI workflow", when: "it runs", then: "the tests pass on ubuntu-latest, macos-latest and windows-latest in a matrix", method: "automated" },
  ],
};
const CROSS_FINDING = "AC-012 adds a CI matrix on Windows, macOS and Linux that the request does not ask for.";

describe("host-required criteria are never scope findings (#1765)", () => {
  test("both prompts read the one table", () => {
    const profile = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect(profile("spec-author")).toContain(`add a criterion that ${VIEWPORT_CRITERION.outcome}`);
    expect(profile("spec-reviewer")).toContain(HOST_REQUIRED_ANALYSIS_RULE);
    for (const c of HOST_REQUIRED_CRITERIA) expect(HOST_REQUIRED_ANALYSIS_RULE).toContain(c.outcome);
    expect(crossPlatformNote("It must run on Windows and Linux.", "/nonexistent")).toContain(CROSS_PLATFORM_CRITERION.outcome);
  });

  test("a scope finding citing only host-required ids is recognised; one citing other ids is not", () => {
    const ids = hostRequiredIds(VIEWPORT_SPEC, HOST_REQUIRED_CRITERIA);
    expect([...ids].sort()).toEqual(["AC-011", "NFR-001"]);
    const finding = { kind: "scope", blocking: true, refs: ["spec.json"], description: VIEWPORT_FINDING };
    expect(objectsToHostRequired(finding, ids, HOST_REQUIRED_CRITERIA)).toBe(true);
    expect(objectsToHostRequired({ ...finding, description: `${VIEWPORT_FINDING} AC-001 also adds a flag.` }, ids, HOST_REQUIRED_CRITERIA)).toBe(false);
    expect(objectsToHostRequired({ ...finding, kind: "inconsistency" }, ids, HOST_REQUIRED_CRITERIA)).toBe(false);
    expect(objectsToHostRequired({ ...finding, refs: [], description: "The spec adds a requirement that pages fit a 1280 px viewport without horizontal scrolling; the request does not ask for it." }, ids, HOST_REQUIRED_CRITERIA)).toBe(true);
    const cross = hostRequiredIds(CROSS_SPEC, [CROSS_PLATFORM_CRITERION]);
    expect([...cross].sort()).toEqual(["AC-012", "NFR-002"]);
  });

  async function scenario(spec: Spec, finding: string, prompt: string) {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    let analyses = 0;
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
      if (request.profile.output === "analysis") {
        analyses++;
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: "needs_revision",
            findings: [{ id: "F-001", kind: "scope", refs: ["spec.json"], description: finding, blocking: true }],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: { specHash: string; planHash: string; tasks: { criterionIds: string[] }[] } };
        const automated = spec.criteria.filter((c) => c.method === "automated").map((c) => c.id);
        for (const id of automated) if (!plan.taskGraph.tasks.some((t) => t.criterionIds.includes(id))) plan.taskGraph.tasks[0]?.criterionIds.push(id);
        plan.taskGraph.specHash = hashJson(spec);
        plan.taskGraph.planHash = hashBytes(plan.markdown);
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy: fixture.policy });
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    return { snapshot, analyses, calls: executor.calls, state: service.store.state(run.runId) };
  }

  test("md-site: the viewport finding is a note and the run reaches approval after one pass", async () => {
    const { snapshot, analyses, calls, state } = await scenario(VIEWPORT_SPEC, VIEWPORT_FINDING, "Pages share a simple HTML layout.");
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(analyses).toBe(1);
    expect(calls.filter((c) => c === "plan")).toHaveLength(1);
    expect(state).toMatchObject({ analysisPassed: true, analysisReplans: 0 });
  }, 60000);

  test("the cross-platform criterion a request asks for is a note too", async () => {
    const { snapshot, analyses } = await scenario(CROSS_SPEC, CROSS_FINDING, "Create ready value. It must run on Windows and Linux.");
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(analyses).toBe(1);
  }, 60000);

  test("without the request asking, the cross-platform finding still blocks", async () => {
    const { snapshot, analyses } = await scenario(CROSS_SPEC, CROSS_FINDING, "Create ready value.");
    expect(snapshot.reason === "approval" && analyses === 1).toBe(false);
  }, 60000);
});
