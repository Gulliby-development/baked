import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { withHostConstants } from "../src/core/workflows/host-constants.js";
import { HOST_ID_FORMATS, SPEC_ID_RULE } from "../src/core/workflows/host-ids.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, PlanSchema, ProfileSchema, SpecSchema } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// Bench rounds 57 and 58 (#1871): Codex gpt-6-astra's first spec submission was refused in 25 of
// 26 specify attempts, always only for its ids: requirements R1, R2, ... and criteria that
// referenced them, a format the spec-author instructions never stated. Every specify stage paid a
// second call writing the whole spec again (R57 modeplan: 484 s and 179k tokens over 8 attempts).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The shape of the recorded R58 wheeltags base submission: ids R1..R3 and AC1..AC3. */
function codexSpec(ids = { requirements: ["R1", "R2", "R3"], criteria: ["AC1", "AC2", "AC3"] }) {
  return {
    schemaVersion: 1,
    featureId: "fixture",
    revision: 1,
    title: "Tags",
    problem: "No tags",
    outcome: "Tags exist",
    inScope: ["Tags"],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    requirements: ids.requirements.map((id) => ({ id, text: `Requirement ${id}`, priority: "must", verification: "automated", sourceRefs: [] })),
    criteria: ids.criteria.map((id, i) => ({
      id,
      requirementIds: [ids.requirements[i % ids.requirements.length]],
      given: "a workspace",
      when: "the command runs",
      then: "it prints the tag",
      method: "automated",
    })),
    dependencies: [],
    deliverables: [{ quote: "a tag command", requirementIds: [ids.requirements[0]] }],
  };
}

const spec = withHostConstants("spec", SpecSchema);

describe("ids a model writes in another shape are renamed to the host's (#1871)", () => {
  test("R1 and AC1 ids, and every reference to them, become FR-001 and AC-001", () => {
    const parsed = spec.parse(codexSpec()) as ReturnType<typeof codexSpec>;
    expect(parsed.requirements.map((r) => r.id)).toEqual(["FR-001", "FR-002", "FR-003"]);
    expect(parsed.criteria.map((c) => [c.id, c.requirementIds])).toEqual([
      ["AC-001", ["FR-001"]],
      ["AC-002", ["FR-002"]],
      ["AC-003", ["FR-003"]],
    ]);
    expect(parsed.deliverables[0]?.requirementIds).toEqual(["FR-001"]);
  });

  test("each spelling keeps its kind; ids already in host format stay", () => {
    const parsed = spec.parse(codexSpec({ requirements: ["FR-001", "REQ-2", "NFR1", "sc_4", "F 5"], criteria: ["AC-001", "C2", "ac.3"] })) as ReturnType<typeof codexSpec>;
    expect(parsed.requirements.map((r) => r.id)).toEqual(["FR-001", "FR-002", "NFR-001", "SC-004", "FR-005"]);
    expect(parsed.criteria.map((c) => c.id)).toEqual(["AC-001", "AC-002", "AC-003"]);
  });

  test("ids that cannot be renamed, or would collide, are still refused with the schema's issues", () => {
    expect(spec.safeParse(codexSpec({ requirements: ["LOGIN", "R2", "R3"], criteria: ["AC1", "AC2", "AC3"] })).success).toBe(false);
    // R1 would become FR-001, which another requirement already is.
    const collision = spec.safeParse(codexSpec({ requirements: ["FR-001", "R1", "R3"], criteria: ["AC-001", "AC-002", "AC-003"] }));
    expect(collision.success).toBe(false);
    expect(JSON.stringify(collision.error?.issues)).toContain("requirements");
  });

  test("a plan's task ids T1, T2 and the dependencies on them become T001, T002", () => {
    const task = (id: string, dependsOn: string[]) => ({
      id, title: id, description: "Write", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer",
      writes: [{ path: `${id}.txt`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
    });
    const plan = withHostConstants("plan", PlanSchema).parse({
      schemaVersion: 1, markdown: "# Plan",
      taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, tasks: [task("T1", []), task("task-2", ["T1"])] },
    }) as { taskGraph: { tasks: { id: string; dependsOn: string[] }[] } };
    expect(plan.taskGraph.tasks.map((t) => [t.id, t.dependsOn])).toEqual([["T001", []], ["T002", ["T001"]]]);
  });

  test("the submission's own prose cites the renamed ids in host form, but not inside paths or longer ids", () => {
    const value = codexSpec({ requirements: ["R1", "R2", "R12"], criteria: ["AC1", "AC2", "AC3"] });
    value.criteria[0] = { ...value.criteria[0]!, then: "it prints the tag, as R2 requires (AC1 covers R12), not src/R1.py or R1-legacy" };
    const parsed = spec.parse(value) as ReturnType<typeof codexSpec>;
    expect(parsed.criteria[0]?.then).toBe("it prints the tag, as FR-002 requires (AC-001 covers FR-012), not src/R1.py or R1-legacy");
    const task = (id: string, dependsOn: string[], description: string) => ({
      id, title: id, description, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer",
      writes: [{ path: `${id}.txt`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: `Needed before ${dependsOn[0] ?? "the end"}`,
    });
    const plan = withHostConstants("plan", PlanSchema).parse({
      schemaVersion: 1, markdown: "# Plan\n\nT1 lays down the skeleton; T2 builds on T1.",
      taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, tasks: [task("T1", [], "Write it"), task("T2", ["T1"], "Extend T1's output")] },
    }) as { markdown: string; taskGraph: { tasks: { description: string; rationale: string }[] } };
    expect(plan.markdown).toBe("# Plan\n\nT001 lays down the skeleton; T002 builds on T001.");
    expect(plan.taskGraph.tasks[1]).toMatchObject({ description: "Extend T001's output", rationale: "Needed before T001" });
  });

  test("the spec author's and the planner's instructions state the formats the schema checks", () => {
    for (const { pattern, examples } of Object.values(HOST_ID_FORMATS))
      for (const example of examples.split(/, | or /)) expect(pattern.test(example)).toBe(true);
    const profile = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect(profile("spec-author")).toContain(SPEC_ID_RULE);
    expect(profile("planner")).toContain("Task ids are T001");
  });
});

describe("submit_result with a spec (#1871)", () => {
  async function author(submissions: unknown[]) {
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
        const next = submissions[Math.min(call, submissions.length - 1)];
        const id = `c${call++}`;
        // A string is a step that ends on prose instead of a call.
        return typeof next === "string"
          ? { content: [{ type: "text", text: next }], finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } }, warnings: [] }
          : {
        content: [{ type: "tool-call", toolCallId: id, toolName: "submit_result", input: JSON.stringify(next) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } },
        warnings: [],
      };
      },
    });
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const specAuthor = profiles.find((p) => p.output === "spec");
    if (!specAuthor) throw new Error("spec profile missing");
    const profile: AgentProfile = { ...specAuthor, model: "openai/fixture-model" };
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, fixture.policy);
    const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    const request: ExecutionRequest = { runId: run.runId, attemptId, profile, prompt: "Specify the fixture", signal: new AbortController().signal, maxSteps: 4 };
    const result = await executor.execute(request);
    const diagnostics = store.artifacts(run.runId).filter((a) => a.kind === "diagnostic").map((a) => a.logical_path);
    return { result, calls: () => call, diagnostics, store, runId: run.runId };
  }

  test("the recorded R58 first submission is accepted in one call", async () => {
    const { result, calls } = await author([codexSpec()]);
    expect(calls()).toBe(1);
    expect((result.output as { requirements: { id: string }[] }).requirements[0]?.id).toBe("FR-001");
  });

  test("a submission the schema refuses is kept as a diagnostic before the corrected one is accepted", async () => {
    const { result, calls, diagnostics } = await author([codexSpec({ requirements: ["LOGIN", "R2", "R3"], criteria: ["AC1", "AC2", "AC3"] }), codexSpec()]);
    expect(calls()).toBe(2);
    expect(result.output).toMatchObject({ requirements: [{ id: "FR-001" }, { id: "FR-002" }, { id: "FR-003" }] });
    expect(diagnostics.some((path) => /attempts\/[^/]+\/invalid-1\.json$/.test(path))).toBe(true);
  });

  test("a refused submission after a prose ending is kept as well", async () => {
    const refused = codexSpec({ requirements: ["LOGIN", "R2", "R3"], criteria: ["AC1", "AC2", "AC3"] });
    const { result, calls, diagnostics } = await author(["The spec is ready.", refused, codexSpec()]);
    expect(calls()).toBe(3);
    expect(result.output).toMatchObject({ requirements: [{ id: "FR-001" }, { id: "FR-002" }, { id: "FR-003" }] });
    expect(diagnostics.some((path) => /attempts\/[^/]+\/invalid-1\.json$/.test(path))).toBe(true);
  });
});
