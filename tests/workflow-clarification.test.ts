import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import {
  clarificationResumeIndex,
  deferredBlockingProblems,
  deferredToChecks,
  demoteDeferred,
  namedPaths,
  narrowsVerification,
  researchBudget,
} from "../src/core/workflows/clarification.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

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
    expect(small.maxSteps).toBe(8);
    expect(small.maxTokens).toBe(8 * 14_000);
    const broad = researchBudget("Improve error handling across the CLI", researcher, defaultWorkflowPolicy);
    expect(broad.maxSteps).toBe(researcher.maxSteps);
    expect(broad.maxTokens).toBeUndefined();
    const capped = researchBudget(PROMPT, researcher, { ...defaultWorkflowPolicy, maxAttemptTokens: 50_000 });
    expect(capped.maxTokens).toBe(50_000);
  });
});

describe("clarification resume point", () => {
  const stages = sddWorkflow.stages;
  const at = (id: string) => stages.findIndex((s) => s.id === id);
  test("research continues with specify, specify repeats itself", () => {
    expect(clarificationResumeIndex(stages, at("research"), { questions: [] })).toBe(at("specify"));
    expect(clarificationResumeIndex(stages, at("specify"), { questions: [] })).toBe(at("specify"));
  });
  test("analysis repeats the earliest stage its blocking findings refer to", () => {
    const finding = (refs: string[], blocking = true) => ({ id: "F", kind: "coverage", refs, description: "x", blocking });
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["plan.md", "tasks.json"])] })).toBe(at("plan"));
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["plan.md"]), finding(["NFR-001", "AC-004"])] })).toBe(at("specify"));
    expect(clarificationResumeIndex(stages, at("analyze"), { findings: [finding(["spec.json"], false), finding(["tasks.json"])] })).toBe(at("plan"));
  });
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists", inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }], dependencies: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };
const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\ncheck\n## Risks\nNone for fixture";

/** Scripted agents: research may ask once, analysis may raise one plan finding once. */
class ScriptedExecutor implements AgentExecutor {
  calls: string[] = [];
  requests: ExecutionRequest[] = [];
  constructor(private script: { researchUnknowns?: { question: string; blocking: boolean }[]; planFinding?: boolean }) {}
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
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }] } }; break;
      case "analysis": {
        const ask = this.script.planFinding === true;
        this.script.planFinding = false;
        output = ask
          ? { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [{ id: "F1", kind: "coverage", refs: ["tasks.json"], description: "Task order unclear", blocking: true }] }
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
    expect(executor.requests[0]?.maxSteps).toBe(6);
    expect(executor.requests[0]?.maxTokens).toBe(6 * 14_000);
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
  test("a plan finding from analysis resumes at plan and keeps the spec", async () => {
    const executor = new ScriptedExecutor({ planFinding: true });
    const service = setup(executor);
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("clarification");
    await answerPending(service, run.runId);
    expect(service.store.state(run.runId).stageIndex).toBe(2);
    expect((await service.drive(run.runId, new AbortController().signal)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "plan", "analysis"]);
  });
});
