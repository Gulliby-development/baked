import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import {
  answerInvalidatesAnalysis,
  clarificationResumeIndex,
  deferredBlockingProblems,
  deferredToChecks,
  demoteDeferred,
  namedPaths,
  narrowsVerification,
  planOnlyFindings,
  researchBudget,
} from "../src/core/workflows/clarification.js";
import { clarificationAnswers, clarificationKeys } from "../src/core/workflows/answers.js";
import { repeatedFacet } from "../src/core/workflows/analysis-notes.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { WorkflowFault } from "../src/core/workflows/errors.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const NOT_RUN = "No checks were run, so current lint, typecheck, and targeted-test outcomes are unknown";
const PROMPT =
  "Add a `totals` object to runUsage in src/core/workflows/usage.ts plus tests in tests/workflow-usage.test.ts";

describe("blocking items that later stages resolve", () => {
  test("check outcomes that were not run are deferred to the checks stage", () => {
    expect(deferredToChecks(NOT_RUN)).toBe(true);
    expect(deferredToChecks("Lint and typecheck results are unknown until checks execute")).toBe(true);
    expect(deferredToChecks("Should totals include cache-read tokens or only input and output?")).toBe(false);
    expect(deferredToChecks("Which test file should hold the new tests?")).toBe(false);
  });
  test("a blocking deferred item returns a correction and is demoted, others are kept", () => {
    const unknowns = [
      { question: NOT_RUN, blocking: true },
      { question: "Should totals include cache reads?", blocking: true },
      { question: NOT_RUN, blocking: false },
    ];
    const problems = deferredBlockingProblems(unknowns, (_, index) => unknowns[index]?.question ?? "");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Item 1");
    expect(demoteDeferred(unknowns, (q) => q.question).map((q) => q.blocking)).toEqual([false, true, false]);
  });
});

describe("policy checks narrower than the project's verification", () => {
  test("are the operator's choice, not a finding", () => {
    for (const text of [
      "The policy checks run only tests/workflow-usage.test.ts, not the full test suite required by AGENTS.md",
      "Verification lacks `bun test` and `bun run build`; the plan names only the targeted test file",
      "executionContract.checks omit the build step that project instructions require before merging",
    ])
      expect(narrowsVerification(text)).toBe(true);
    for (const text of [
      "AC-003 has no test in any task; T002 writes tests/workflow-usage.test.ts for AC-001 only",
      "plan.md says sorting is stable but FR-002 allows any order for ties",
      "Run `bun test tests/workflow-usage.test.ts` as the task check for T002",
    ])
      expect(narrowsVerification(text)).toBe(false);
  });
  test("a blocking finding about it returns a correction and is demoted", () => {
    const findings = [
      { description: "The policy runs only one test file instead of the full suite and no bun run build", blocking: true },
      { description: "FR-002 and plan.md disagree on the sort order for ties", blocking: true },
    ];
    const problems = deferredBlockingProblems(findings, (_, index) => findings[index]?.description ?? "");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("operator chose");
    expect(demoteDeferred(findings, (f) => f.description).map((f) => f.blocking)).toEqual([false, true]);
  });
});

describe("research budget", () => {
  test("scales with the files the request names", () => {
    expect(namedPaths(PROMPT)).toEqual(["src/core/workflows/usage.ts", "tests/workflow-usage.test.ts"]);
    const researcher = builtinProfiles.find((p) => p.id === "researcher");
    if (!researcher) throw new Error("researcher profile missing");
    const small = researchBudget(PROMPT, researcher, defaultWorkflowPolicy);
    expect(small.maxSteps).toBe(10);
    expect(small.maxTokens).toBe(10 * 14_000);
    // Only paths that exist count; a request that creates its files gets the step floor.
    const creating = researchBudget(PROMPT, researcher, defaultWorkflowPolicy, () => false);
    expect(creating.namedPaths).toEqual([]);
    expect(creating.maxSteps).toBe(researcher.maxSteps);
    const partial = researchBudget(PROMPT, researcher, defaultWorkflowPolicy, (path) => path.startsWith("src/"));
    expect(partial.namedPaths).toEqual(["src/core/workflows/usage.ts"]);
    expect(partial.maxSteps).toBe(10);
    const broad = researchBudget("Improve error handling across the CLI", researcher, defaultWorkflowPolicy);
    expect(broad.maxSteps).toBe(researcher.maxSteps);
    expect(broad.maxTokens).toBeUndefined();
    const capped = researchBudget(PROMPT, researcher, { ...defaultWorkflowPolicy, maxAttemptTokens: 50_000 });
    expect(capped.maxTokens).toBe(50_000);
  });
});

describe("clarification resume point", () => {
  test("only an answer to the approval stage keeps the analysis verdict", () => {
    expect(answerInvalidatesAnalysis("approve")).toBe(false);
    for (const kind of ["research", "specify", "analyze", "plan", undefined]) expect(answerInvalidatesAnalysis(kind)).toBe(true);
  });
  const stages = sddWorkflow.stages;
  const at = (id: string) => stages.findIndex((s) => s.id === id);
  test("research continues with specify, specify repeats itself", () => {
    expect(clarificationResumeIndex(stages, at("research"), { questions: [] })).toBe(at("specify"));
    expect(clarificationResumeIndex(stages, at("specify"), { questions: [] })).toBe(at("specify"));
  });
  test("analysis repeats the earliest stage its findings refer to, since an answer may cover any of them", () => {
    const finding = (refs: string[], blocking = true) => ({ id: "F", kind: "coverage", refs, description: "x", blocking });
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["plan.md", "tasks.json"])] })).toBe(at("plan"));
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["plan.md"]), finding(["NFR-001", "AC-004"])] })).toBe(at("specify"));
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["spec.json"], false), finding(["tasks.json"])] })).toBe(at("specify"));
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["plan.md"], false), finding(["tasks.json"])] })).toBe(at("plan"));
  });
});

describe("plan-only analysis findings", () => {
  const finding = (kind: string, refs: string[], blocking = true) => ({ kind, refs, blocking });
  test("coverage and inconsistency gaps in plan artifacts qualify", () => {
    expect(planOnlyFindings([finding("coverage", ["tasks.json"]), finding("inconsistency", ["plan.md", "T002"])])).toHaveLength(2);
    expect(planOnlyFindings([finding("coverage", ["tasks.json"]), finding("ambiguity", ["spec.json"], false)])).toHaveLength(1);
  });
  test("a coverage gap in the tasks qualifies even when it names the criteria it misses", () => {
    const refs = ["spec.json:AC-002", "spec.json:AC-006", "plan.md:Verification", "tasks.json:T001"];
    expect(planOnlyFindings([finding("coverage", refs)])).toHaveLength(1);
    expect(planOnlyFindings([finding("coverage", ["T002", "AC-003"])])).toHaveLength(1);
  });
  test("a coverage gap that names a requirement or the spec itself goes to the spec author (#1893)", () => {
    // Bench round 59, jsonshape 2f1c8ef1: F-001 went to the planner twice before specify ran.
    const r59 = ["spec.json:FR-006", "spec.json:AC-007", "plan.md:Verification"];
    expect(planOnlyFindings([finding("coverage", r59)])).toEqual([]);
    expect(planOnlyFindings([finding("coverage", ["NFR-002", "tasks.json"])])).toEqual([]);
    expect(planOnlyFindings([finding("coverage", ["spec.json", "plan.md:Tasks"])])).toEqual([]);
    expect(planOnlyFindings([finding("coverage", ["plan.md:Tasks", "T003"])])).toHaveLength(1);
    expect(planOnlyFindings([finding("inconsistency", ["plan.md", "T002"])])).toHaveLength(1);
  });
  test("a spec reference, another kind or no blocking finding keeps the person in the loop", () => {
    expect(planOnlyFindings([finding("coverage", ["tasks.json"]), finding("coverage", ["AC-002"])])).toEqual([]);
    expect(planOnlyFindings([finding("inconsistency", ["plan.md", "spec.json:FR-002"])])).toEqual([]);
    expect(planOnlyFindings([finding("ambiguity", ["plan.md"])])).toEqual([]);
    expect(planOnlyFindings([finding("coverage", ["plan.md"], false)])).toEqual([]);
  });
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }], dependencies: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";

/** Scripted agents: research may ask once, analysis may raise one plan finding a given number of times. */
class ScriptedExecutor implements AgentExecutor {
  calls: string[] = [];
  requests: ExecutionRequest[] = [];
  constructor(private script: { researchUnknowns?: { question: string; blocking: boolean }[]; planFinding?: number; specQuestion?: boolean; findingRefs?: string[]; findingKind?: string; findingText?: string; findingTexts?: string[]; nonBlocking?: boolean }) {}
  private analyses = 0;
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    this.requests.push(request);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
    let output: unknown;
    switch (request.profile.output) {
      case "research": {
        output = { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: this.script.researchUnknowns ?? [], constraints: [], suggestedScope: ["value.txt"] };
        const errors = request.validate?.(output) ?? [];
        if (errors.length) output = { ...(output as object), unknowns: [] };
        break;
      }
      case "spec": {
        output = this.script.specQuestion ? { ...spec, openQuestions: [{ id: "Q-1", question: "What does a zero total show?", blocking: true }] } : spec;
        const errors = request.validate?.(output) ?? [];
        if (errors.length) output = { ...spec, assumptions: ["What does a zero total show? Assumed: 0%, because nothing was spent."] };
        break;
      }
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      case "analysis": {
        const ask = (this.script.planFinding ?? 0) > 0;
        const text = this.script.findingTexts?.[this.analyses++] ?? this.script.findingText;
        this.script.planFinding = Math.max(0, (this.script.planFinding ?? 0) - 1);
        output = ask
          ? { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [{ id: "F1", kind: this.script.findingKind ?? "coverage", refs: this.script.findingRefs ?? ["tasks.json"], description: text ?? "Task order unclear", blocking: !this.script.nonBlocking }] }
          : { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      }
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function setup(executor: ScriptedExecutor) {
  const root = mkdtempSync(join(tmpdir(), "baked-clarify-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  return service;
}
async function answerPending(service: NativeWorkflowService, runId: string) {
  const run = await service.get(runId);
  const request = service.store.requests(runId).find((r) => r.kind === "clarification" && r.status === "pending");
  if (!request) throw new Error("No pending clarification");
  return service.decide(runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "answer", requestId: request.id, answers: { "Q-1": "Use the existing format" } });
}

describe("answering a clarification", () => {
  test("a research question resumes at specify without repeating research", async () => {
    const executor = new ScriptedExecutor({ researchUnknowns: [{ question: "Which output format should the value use?", blocking: true }] });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value in value.txt", ownerLabel: "test", policy });
    const waiting = await service.drive(run.runId, new AbortController().signal);
    expect(waiting.reason).toBe("clarification");
    expect(executor.calls).toEqual(["research"]);
    // value.txt does not exist yet, so the request names nothing to read: the profile limit.
    expect(executor.requests[0]?.maxSteps).toBe(12);
    expect(executor.requests[0]?.maxTokens).toBeUndefined();
    await answerPending(service, run.runId);
    expect(service.store.state(run.runId).stageIndex).toBe(1);
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis"]);
    const specPrompt = executor.requests[1]?.prompt ?? "";
    expect(specPrompt).toContain("User clarification (answers the questions of the research stage; they are resolved)");
    expect(specPrompt).toContain("Use the existing format");
    expect(service.store.state(run.runId).research).toContain('"blocking":false');
  });
  test("research does not stop for check outcomes it cannot produce", async () => {
    const executor = new ScriptedExecutor({ researchUnknowns: [{ question: NOT_RUN, blocking: true }] });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
  });
  test("a plan-only finding from analysis goes back to the planner without a person", async () => {
    const executor = new ScriptedExecutor({ planFinding: 1 });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "plan", "analysis"]);
    expect(executor.requests[4]?.prompt).toContain("Task order unclear");
    expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
  });
  test("a plan finding that survives the replan asks a person and resumes at plan", async () => {
    const executor = new ScriptedExecutor({ planFinding: 2 });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    await answerPending(service, run.runId);
    expect(service.store.state(run.runId).stageIndex).toBe(2);
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "plan", "analysis", "plan", "analysis"]);
  });
  test("needs_revision with only non-blocking findings passes the analysis as notes", async () => {
    const executor = new ScriptedExecutor({ planFinding: 1, nonBlocking: true, findingKind: "ambiguity", findingRefs: ["spec.json:FR-001"] });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis"]);
    expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
  });
  test("a blocking finding that only compares task or file counts is a note; the model is given the host counts", async () => {
    const executor = new ScriptedExecutor({ planFinding: 1, findingKind: "inconsistency", findingRefs: ["plan.md", "tasks.json"], findingText: "plan.md says 8 tasks and 14 files, but tasks.json has 9 tasks and 12 files" });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis"]);
    expect(executor.requests[3]?.prompt).toContain('"hostCounts":{"files":1,"tasks":1}');
    // The facts are the ones taken before research: the run's own published specs are not in them.
    expect(executor.requests[3]?.prompt).toContain('"kind":"empty"');
  });
  test("an answer to an analysis finding supersedes the research it contradicts", async () => {
    const executor = new ScriptedExecutor({ planFinding: 2 });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    const current = await service.get(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: request?.id ?? "", answers: { F1: "The order is by name" } });
    const research = service.store.state(run.runId).research ?? "";
    expect(research).toContain("Superseded by the user's answer");
    expect(research).toContain("Task order unclear");
    expect(research).toContain("The order is by name");
  });
  describe("with clarification: assume", () => {
    const assume: RunPolicy = { ...policy, clarification: "assume" };
    const startAssume = (service: NativeWorkflowService) =>
      service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: assume });
    test("a research question is settled by its agent and nobody is asked", async () => {
      const executor = new ScriptedExecutor({ researchUnknowns: [{ question: "Which output format should the value use?", blocking: true }] });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(executor.calls).toEqual(["research", "spec", "plan", "analysis"]);
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
    });
    test("a spec question becomes a recorded assumption", async () => {
      const executor = new ScriptedExecutor({ specQuestion: true });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(service.store.state(run.runId).spec?.assumptions[0]).toContain("Assumed: 0%");
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
    });
    test("a spec finding from analysis goes back to specify before a person", async () => {
      const executor = new ScriptedExecutor({ planFinding: 1, findingKind: "ambiguity", findingRefs: ["spec.json:FR-001"] });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "spec", "plan", "analysis"]);
      expect(executor.requests[4]?.prompt).toContain("Assumed:");
    });
    test("the start request turns it on and the approval lists the assumptions", async () => {
      const executor = new ScriptedExecutor({ specQuestion: true });
      const service = setup(executor);
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy, clarification: "assume" });
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      const approval = service.store.requests(run.runId).find((r) => r.kind === "approval");
      expect(JSON.parse(approval?.body_json ?? "{}").assumptions).toEqual(["What does a zero total show? Assumed: 0%, because nothing was spent."]);
      const published = readFileSync(join(service.workspace, "specs/fixture/spec.md"), "utf8");
      expect(published).toContain("## Assumptions\n- What does a zero total show? Assumed: 0%");
    });
    test("the start request can ask under an assuming policy; asking keeps the policy hash", async () => {
      const service = setup(new ScriptedExecutor({ specQuestion: true }));
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: assume, clarification: "ask" });
      expect(JSON.parse(service.store.run(run.runId).policy_json).clarification).toBeUndefined();
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    });
    test("a finding that survives the reroute is recorded as an assumption, not asked", async () => {
      const executor = new ScriptedExecutor({ planFinding: 2, findingKind: "ambiguity", findingRefs: ["spec.json:FR-001"] });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
      const recorded = service.store.artifacts(run.runId).find((a) => a.logical_path === "assumptions/analysis.json");
      expect(recorded?.kind).toBe("assumption");
    });
    // md-site: root index.md maps to index-page.html, which collides with a real index-page.md.
    const collision = "Root index.md maps to index-page.html, which collides with the real index-page.md";
    test("an inconsistency that survives the reroute goes back to the spec once more, with its text", async () => {
      const executor = new ScriptedExecutor({ planFinding: 2, findingKind: "inconsistency", findingRefs: ["spec.json:FR-001"], findingText: collision });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "spec", "plan", "analysis", "spec", "plan", "analysis"]);
      expect(executor.requests[7]?.prompt).toContain("Do not assume them away");
      expect(executor.requests[7]?.prompt).toContain(collision);
      expect(service.store.artifacts(run.runId).some((a) => a.logical_path === "assumptions/analysis.json")).toBe(false);
    });
    test("an inconsistency that survives both reroutes is asked, never recorded as an assumption", async () => {
      const executor = new ScriptedExecutor({ planFinding: 3, findingKind: "inconsistency", findingRefs: ["spec.json:FR-001"], findingText: collision });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
      expect(service.store.artifacts(run.runId).some((a) => a.logical_path === "assumptions/analysis.json")).toBe(false);
    });
    // url-shortener 7277eb0c (bench round 26, #1209): three passes raised one "usable unchanged as
    // the Location header" contract with the same refs, one facet each, and the survivor asked a
    // person for the default the finding itself offered.
    const refs = ["spec.json:FR-003", "spec.json:AC-002", "plan.md:DEC-005", "tasks.json:T002"];
    const facets = [
      "An accepted URL with an embedded newline or control character cannot be used unchanged as the Location header",
      "An accepted URL with surrounding ASCII spaces cannot be used unchanged as the Location header",
      "An accepted URL with an emoji fails the ByteString conversion of the Location header: permit a URL-serialized, percent-encoded Location, or define an explicit header-representable acceptance restriction",
    ];
    test("another facet of an earlier inconsistency that offers alternatives is settled with its default, not asked", async () => {
      const executor = new ScriptedExecutor({ planFinding: 3, findingKind: "inconsistency", findingRefs: refs, findingTexts: facets });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
      const assumed = service.store.latestArtifact(run.runId, "assumptions/analysis.json");
      if (!assumed) throw new Error("No assumptions artifact");
      expect(service.store.readArtifact(run.runId, assumed.id)).toContain("percent-encoded Location");
    });
    test("a repeated facet without alternatives, or under ask, still goes to a person", async () => {
      const plain = facets.map((f) => f.replace(/: permit .*$/, ""));
      const service = setup(new ScriptedExecutor({ planFinding: 3, findingKind: "inconsistency", findingRefs: refs, findingTexts: plain }));
      expect((await service.drive((await startAssume(service)).runId, new AbortController().signal)).reason).toBe("clarification");
      const asking = setup(new ScriptedExecutor({ planFinding: 3, findingKind: "inconsistency", findingRefs: refs, findingTexts: facets }));
      const run = await asking.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
      expect((await asking.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    });
    test("only a different inconsistency with the same refs counts as another facet", () => {
      const finding = { kind: "inconsistency", blocking: true, refs, description: facets[2] ?? "" };
      const earlier = [{ kind: "inconsistency", refs: [...refs].reverse(), description: facets[0] ?? "" }];
      expect(repeatedFacet(finding, earlier)).toBe(true);
      expect(repeatedFacet(finding, [{ ...earlier[0], refs: ["spec.json:FR-001"] } as (typeof earlier)[number]])).toBe(false);
      expect(repeatedFacet(finding, [{ ...earlier[0], kind: "scope" } as (typeof earlier)[number]])).toBe(false);
      expect(repeatedFacet(finding, [{ ...earlier[0], description: finding.description } as (typeof earlier)[number]])).toBe(false);
      expect(repeatedFacet({ ...finding, blocking: false }, earlier)).toBe(false);
    });
    // md-site, url B and zoneslot (round 06): the spec's domain became a restriction the request lacks.
    const restriction = "FR-003 restricts the accepted ISO 8601 forms to extended date-times; the request names no such limit";
    test("a scope finding that adds a restriction gets one more return with the request as authority, then is assumed", async () => {
      const executor = new ScriptedExecutor({ planFinding: 3, findingKind: "scope", findingRefs: ["spec.json"], findingText: restriction });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "spec", "plan", "analysis", "spec", "plan", "analysis"]);
      expect(executor.requests[7]?.prompt).toContain("The request is authoritative");
      expect(executor.requests[7]?.prompt).toContain(restriction);
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
      expect(service.store.artifacts(run.runId).some((a) => a.logical_path === "assumptions/analysis.json")).toBe(true);
    });
    test("a scope finding that adds a restriction still asks when clarification is ask", async () => {
      const service = setup(new ScriptedExecutor({ planFinding: 3, findingKind: "scope", findingRefs: ["spec.json"], findingText: restriction }));
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    });
    // url-shortener 88548a10 (round 14): the spec author added a three-OS CI requirement the brief
    // never mentions; under assume the run still asked a person twice.
    const addition =
      "AC-009 makes passing CI on Windows, macOS, and Linux an acceptance condition the request does not ask for";
    test("a scope finding that adds an unrequested requirement is decided for the request, then assumed", async () => {
      const executor = new ScriptedExecutor({ planFinding: 3, findingKind: "scope", findingRefs: ["spec.json:FR-009", "spec.json:AC-009"], findingText: addition });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(executor.requests[7]?.prompt).toContain("requirements, criteria and tasks the request does not ask for");
      expect(executor.requests[7]?.prompt).toContain(addition);
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
      const assumed = service.store.latestArtifact(run.runId, "assumptions/analysis.json");
      if (!assumed) throw new Error("No assumptions artifact");
      expect(service.store.readArtifact(run.runId, assumed.id)).toContain("AC-009");
    });
    // cfgtrace 832775c7 (round 15): an inconsistency between a spec assumption and the request.
    const settled = "A spec assumption excludes tests/**, while the request allows changes under tests/";
    test("an inconsistency that the request settles is decided for the request, then assumed", async () => {
      const executor = new ScriptedExecutor({ planFinding: 3, findingKind: "inconsistency", findingRefs: ["spec.json"], findingText: settled });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
      expect(executor.requests[7]?.prompt).toContain("The request is authoritative");
      expect(executor.requests[7]?.prompt).toContain(settled);
      expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
      expect(service.store.latestArtifact(run.runId, "assumptions/analysis.json")).toBeTruthy();
    });
    test("a scope finding that survives still goes to a person", async () => {
      const executor = new ScriptedExecutor({ planFinding: 2, findingKind: "scope", findingRefs: ["spec.json"] });
      const service = setup(executor);
      const run = await startAssume(service);
      expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    });
  });
});

describe("answers file shape (#1463)", () => {
  test("a flat object passes, the stored {answers} shape is unwrapped, anything else names the problem", () => {
    expect(clarificationAnswers({ "Q-1": "Zero" })).toEqual({ "Q-1": "Zero" });
    expect(clarificationAnswers({ answers: { "Q-1": "Zero" } })).toEqual({ "Q-1": "Zero" });
    // A question whose id is "answers" stays a flat answer.
    expect(clarificationAnswers({ answers: "Zero" })).toEqual({ answers: "Zero" });
    const fault = (raw: unknown, expected: string[] = []) => {
      try {
        clarificationAnswers(raw, expected);
      } catch (error) {
        return error as WorkflowFault;
      }
      throw new Error("No fault");
    };
    const nested = fault({ "Q-1": ["a"] }, ["Q-1"]);
    expect(nested.code).toBe("INVALID_DEFINITION");
    expect(nested.message).toBe(
      'Answers must be a JSON object of strings; question id "Q-1" has an array value. The request asks about Q-1. Expected a JSON object of strings keyed by question id, for example {"Q-1": "your answer"}.',
    );
    expect(fault({ answers: { "Q-1": 3 } }).message).toContain('question id "Q-1" has a number value');
    expect(fault({ "Q-1": "a", other: { x: 1 } }).message).toContain('question id "other" has an object value');
    expect(fault(["a"], ["SPEC-CONFLICT-T006"]).message).toBe(
      'Answers must be a JSON object of strings, not an array. The request asks about SPEC-CONFLICT-T006. Expected a JSON object of strings keyed by question id, for example {"SPEC-CONFLICT-T006": "your answer"}.',
    );
    expect(fault({}).message).toContain("Answers are empty.");
  });
  test("the request's keys are its question or finding ids", () => {
    expect(clarificationKeys({ questions: [{ id: "Q-1" }, {}] })).toEqual(["Q-1", "Q2"]);
    expect(clarificationKeys({ findings: [{ id: "SPEC-CONFLICT-T006" }] })).toEqual(["SPEC-CONFLICT-T006"]);
    expect(clarificationKeys({})).toEqual([]);
  });

  async function waitingOnQuestion() {
    const service = setup(new ScriptedExecutor({ specQuestion: true }));
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    if (!request) throw new Error("No pending clarification");
    return { service, runId: run.runId, request };
  }

  test("the CLI accepts the wrapped file and names the expected ids for a wrong one", async () => {
    const { service, runId, request } = await waitingOnQuestion();
    const file = join(service.store.workspace, "answers.json");
    const answer = async (body: unknown) => {
      writeFileSync(file, JSON.stringify(body));
      const revision = (await service.get(runId)).revision;
      return executeWorkflowCommand(
        service,
        parseWorkflowArgs(["answer", runId, "--request", request.id, "--answers-file", file, "--expected-revision", String(revision), "--no-resume"]),
        new AbortController().signal,
      );
    };
    await expect(answer({ answers: { "Q-1": ["Zero"] } })).rejects.toThrow(
      'question id "Q-1" has an array value. The request asks about Q-1.',
    );
    expect(service.store.requests(runId).find((r) => r.id === request.id)?.status).toBe("pending");
    await answer({ answers: { "Q-1": "Zero shows 0%" } });
    const decided = service.store.requests(runId).find((r) => r.id === request.id);
    expect(decided?.status).not.toBe("pending");
    expect(decided?.answer_json).toContain("Zero shows 0%");
  });

  test("the local API accepts the wrapped answers and answers 400 with the problem otherwise", async () => {
    const { service, runId, request } = await waitingOnQuestion();
    const configDir = mkdtempSync(join(tmpdir(), "baked-answer-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-answer-home-"));
    const server = await startApiServer({ service, pollMs: 20, configDir, homeDir, log: () => {} });
    cleanups.push(() => {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    });
    try {
      const post = async (answers: unknown) =>
        fetch(`${server.url}/v1/workflow/runs/${runId}/answer`, {
          method: "POST",
          headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ commandId: newId(), expectedRevision: (await service.get(runId)).revision, requestId: request.id, answers }),
        });
      const wrong = await post({ "Q-1": { text: "Zero" } });
      expect(wrong.status).toBe(400);
      const error = ((await wrong.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("INVALID_DEFINITION");
      expect(error.message).toContain('question id "Q-1" has an object value. The request asks about Q-1.');
      expect((await post({ answers: { "Q-1": "Zero shows 0%" } })).status).toBe(200);
      expect(service.store.requests(runId).find((r) => r.id === request.id)?.answer_json).toContain("Zero shows 0%");
    } finally {
      await server.stop();
    }
  });
});
