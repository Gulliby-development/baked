import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { passesWithNotes } from "../src/core/verification/convergence-stop.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { uncommittedEdits } from "../src/core/workflows/rollback.js";
import type { RunPolicy, Spec, WorkflowEvent } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { type AgentExecutor, type ExecutionRequest, RuntimeStateSchema } from "../src/core/workflows/types.js";
import type { Gate, WorkflowV2 } from "../src/core/workflows/v2/definition.js";
import { builtinPresets, instantiatePreset } from "../src/core/workflows/v2/definitions.js";
import { confirmGates, loadGateLibrary } from "../src/core/workflows/v2/library.js";
import { upgradeWorkflowV1 } from "../src/core/workflows/v2/upgrade.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { executeDefinitionCommand } from "../src/headless/workflow-definitions.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists",
  inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }],
  dependencies: [],
};
const valueCheck = {
  id: "check", executable: "bun", args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"],
  cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [valueCheck] };
/** A repro that shows the claimed value, run with the program the value check starts. */
const oldValueRepro = { executable: "bun", args: ["-e", "console.log('old')"], expected: "ready", actual: "old" };

interface Behavior {
  /** Implementations that write a broken value before the fixture writes the right one. */
  broken?: number;
  /** Convergence rounds that report a new gap each before passing. */
  gaps?: number;
  /** Implementations that stop at their token cap after a partial edit. */
  capped?: number;
  /** Severity of the convergence gaps; high by default. */
  gapSeverity?: "high" | "medium" | "low";
  /** The kind of the convergence gaps; `missing` by default. */
  gapKind?: "missing" | "partial";
  /** Acceptance criteria of the spec, all covered by the one task; 1 by default. */
  criteria?: number;
  /** The symbol every convergence gap names, so a later gap can contradict an earlier fix. */
  gapSymbol?: string;
  /** Every gap names the same file and no symbol, as a reviewer rewording one defect does. */
  gapSameLocation?: boolean;
  /** An edit effect of the first attempt of `task` (or of the convergence review, which nothing supersedes) stays unknown, as after a failed edit_file whose worktree was removed. */
  unknownEffect?: "task" | "converge";
  /** The symbol of the gap of each round, in order; overrides `gapSymbol`. */
  gapSymbols?: string[];
  /** The `repeatOf` of the gap of a round: an earlier finding id, null for a new defect, absent when the reviewer did not say. */
  gapRepeatOf?: (round: number) => string | null | undefined;
  /** The gaps carry a reproduction the host can run. */
  gapRepro?: boolean;
  /** Convergence reports AC-001 inconclusive with no finding, as for a criterion only another operating system can prove. */
  unverifiable?: boolean;
  /** A spec that names another feature than the run's. */
  renamedFeature?: boolean;
  reviewVerdict?: "pass" | "changes_requested";
  /** Fields that replace those of the medium correctness finding a review requesting changes reports. */
  reviewFinding?: {
    severity?: string;
    kind?: string;
    basis?: "spec" | "inferred";
    repro?: { executable: string; args: string[]; expected: string; actual: string } | undefined;
  };
  /** Analyses that report one blocking finding before passing. */
  analysisFindings?: number;
  findingKind?: string;
  findingRefs?: string[];
}

class V2Executor implements AgentExecutor {
  calls: string[] = [];
  prompts: string[] = [];
  analyses = 0;
  /** Set by setup; a capped attempt records its usage the way the agent executor does. */
  service?: NativeWorkflowService;
  maxTokens: number[] = [];
  implementations = 0;
  convergences = 0;
  /** Host tools each review attempt was offered. */
  reviewTools: string[][] = [];
  private spec: Spec;
  constructor(private root: string, private behavior: Behavior = {}) {
    this.spec = {
      ...spec,
      criteria: Array.from({ length: behavior.criteria ?? 1 }, (_, i) => ({ ...spec.criteria[0], id: `AC-${String(i + 1).padStart(3, "0")}` })) as Spec["criteria"],
    };
  }
  private passing(evidence: string[], explanation: string) {
    return this.spec.criteria.map((c) => ({ criterionId: c.id, verdict: "pass" as const, evidenceIds: evidence, explanation }));
  }
  private leaveUnknownEffect(request: ExecutionRequest) {
    const store = this.service?.store;
    if (!store) throw new Error("No service");
    const id = store.prepareEffect(request.runId, request.attemptId, "file_patch", { path: "value.txt", root: "vanished-worktree" }, "a".repeat(64), "b".repeat(64));
    store.effectStatus(request.runId, id, "unknown");
  }
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    this.prompts.push(request.prompt);
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
      inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] };
    };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research":
        output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
        break;
      case "spec":
        
        output = this.behavior.renamedFeature ? { ...this.spec, featureId: "expense-report" } : this.spec;
        break;
      case "plan": {
        const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
        output = {
          schemaVersion: 1, markdown,
          taskGraph: {
            schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(this.spec), planHash: hashBytes(markdown),
            tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: this.spec.criteria.map((c) => c.id), dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
          },
        };
        break;
      }
      case "analysis":
        output = ++this.analyses <= (this.behavior.analysisFindings ?? 0)
          ? { schemaVersion: 1, inputHash: data.inputHash, verdict: "needs_revision", findings: [{ id: "F1", kind: this.behavior.findingKind ?? "coverage", refs: this.behavior.findingRefs ?? ["tasks.json"], description: "Task order unclear", blocking: true }] }
          : { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
        break;
      case "implementation":
        this.implementations++;
        if (this.behavior.unknownEffect === "task" && this.implementations === 1) this.leaveUnknownEffect(request);
        this.maxTokens.push(request.attemptTokens ?? 0);
        if (this.implementations <= (this.behavior.capped ?? 0)) {
          writeFileSync(join(this.root, "value.txt"), "rea");
          this.service?.store.artifact(request.runId, "usage", `attempts/${request.attemptId}/usage.json`, JSON.stringify({ schemaVersion: 1, profileId: request.profile.id, taskId: request.task?.id ?? null, maxSteps: request.maxSteps, maxTokens: 1000, stopReason: "submitted", finalizedBy: "tokens", totalTokens: 1000, steps: [] }));
          output = { schemaVersion: 1, taskId: request.task?.id, outcome: "blocked", summary: "Ran out of tokens", evidenceIds: [], unresolved: ["The value is only partly written"] };
          break;
        }
        writeFileSync(join(this.root, "value.txt"), this.implementations <= (this.behavior.broken ?? 0) ? "broken" : `ready${"\n".repeat(this.implementations)}`);
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      case "review":
        this.reviewTools.push(Object.keys(request.hostTools ?? {}));
        output = this.behavior.reviewVerdict === "changes_requested"
          ? {
              schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested", coverage: [],
              // An undefined field in reviewFinding drops the default.
              findings: [Object.fromEntries(Object.entries({ id: "F1", kind: "correctness", severity: "medium", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: null, symbol: null, evidenceIds: evidence, claim: "The change misses an edge case", impact: "A user sees the old value", suggestedFix: "Handle the edge case", repro: oldValueRepro, ...this.behavior.reviewFinding }).filter(([, value]) => value !== undefined))],
            }
          : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: this.passing(evidence, "Evidence checked"), findings: [] };
        break;
      case "convergence": {
        if (this.behavior.unknownEffect === "converge") this.leaveUnknownEffect(request);
        const round = ++this.convergences;
        output = this.behavior.unverifiable
          ? {
              schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "inconclusive",
              coverage: [{ criterionId: "AC-001", verdict: "inconclusive", evidenceIds: [], explanation: "Only the Windows run is evidenced; macOS and Linux execution remain unconfirmed." }, ...this.passing(evidence, "Command checked the value").slice(1)],
              findings: [],
            }
          : round <= (this.behavior.gaps ?? 0)
          ? {
              schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "changes_requested",
              coverage: [{ criterionId: "AC-001", verdict: "fail", evidenceIds: evidence, explanation: `Gap ${round}` }, ...this.passing(evidence, "Command checked the value").slice(1)],
              findings: [{ id: `G${round}`, kind: this.behavior.gapKind ?? "missing", severity: this.behavior.gapSeverity ?? "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: this.behavior.gapSymbols?.[round - 1] ?? this.behavior.gapSymbol ?? (this.behavior.gapSameLocation ? null : `symbol${round}`), ...(this.behavior.gapRepeatOf?.(round) !== undefined ? { repeatOf: this.behavior.gapRepeatOf(round) } : {}), ...(this.behavior.gapRepro ? { repro: oldValueRepro } : {}), evidenceIds: evidence, claim: `Gap number ${round} remains`, impact: "The criterion is not met", suggestedFix: `Close gap ${round}` }],
            }
          : { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: this.passing(evidence, "Command checked the value"), findings: [] };
        break;
      }
      case "report":
        output = { schemaVersion: 1, summary: "The value can be added", findings: [{ title: "No value yet", detail: "value.txt is missing", paths: [] }], recommendation: { kind: "proceed", text: "Add value.txt" }, openQuestions: [] };
        break;
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function setup(behavior: Behavior = {}, runPolicy: RunPolicy = policy) {
  const root = mkdtempSync(join(tmpdir(), "baked-workflow-v2-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new V2Executor(root, behavior);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: runPolicy } };
  const service = new NativeWorkflowService(root, config, executor);
  executor.service = service;
  cleanups.push(() => service.close());
  const define = (definition: WorkflowV2) => {
    mkdirSync(join(root, "baked", "workflows"), { recursive: true });
    writeFileSync(join(root, "baked", "workflows", `${definition.id}.json`), JSON.stringify(definition));
  };
  /** Writes a project gate; `confirm` records the user's review of it, as the CLI does. */
  const gate = (definition: Gate, confirm = true) => {
    mkdirSync(join(root, "baked", "gates"), { recursive: true });
    writeFileSync(join(root, "baked", "gates", `${definition.id}.json`), JSON.stringify(definition));
    if (confirm) confirmGates(root, loadGateLibrary(root, runPolicy), [definition.id]);
  };
  const start = (workflowId: string, prompt = "Create ready value") =>
    service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt, ownerLabel: "test", policy: runPolicy });
  const drive = (runId: string) => service.drive(runId, new AbortController().signal);
  const pending = (runId: string, kind: string) =>
    service.store.requests(runId).find((r) => r.kind === kind && r.status === "pending");
  const approve = async (runId: string) => {
    const request = pending(runId, "approval");
    if (!request) throw new Error("No pending approval");
    const run = await service.get(runId);
    return service.decide(runId, { commandId: newId(), expectedRevision: run.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
  };
  /** Drives to the end, approving every approval request on the way. */
  const complete = async (runId: string) => {
    for (let round = 0; round < 6; round++) {
      const snapshot = await drive(runId);
      if (snapshot.status !== "waiting" || !pending(runId, "approval")) return snapshot;
      await approve(runId);
    }
    return service.get(runId);
  };
  return { root, executor, service, define, gate, start, drive, approve, complete, pending };
}

const events = (service: NativeWorkflowService, runId: string): WorkflowEvent[] => service.store.events(runId, 0, 10000);
const ofType = <T extends WorkflowEvent["type"]>(list: WorkflowEvent[], type: T) =>
  list.filter((e): e is Extract<WorkflowEvent, { type: T }> => e.type === type);
const lastError = (service: NativeWorkflowService, runId: string) => {
  const artifact = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/")).at(-1);
  return artifact ? service.store.readArtifact(runId, artifact.id) : "";
};

/** Quick fix with the policy's check, as the shipped preset instantiates it. */
const quickFix = (patch: (definition: WorkflowV2) => WorkflowV2 = (d) => d): WorkflowV2 => {
  const preset = builtinPresets.get("quick-fix");
  if (!preset) throw new Error("quick-fix preset missing");
  return patch({ ...instantiatePreset(preset, policy), id: "custom-fix", preset: "custom" });
};
const commandGate = (id: string, args: string[], extra: Partial<Gate> = {}): Gate => ({
  schemaVersion: 1, id, description: `Gate ${id}`, required: true, scope: "feature", timeoutMs: 10000,
  retries: { max: 0, retryOn: [] }, evidence: { kind: "exit", keepOutputLines: 40, artifactPaths: [] },
  type: "command", command: { executable: "bun", args, cwd: ".", envNames: [], writes: [] },
  ...extra,
} as Gate);

describe("workflow v2 scheduler", () => {
  test("V2-05 the built-in sdd walked as a v2 definition matches the v1 scheduler", async () => {
    const trace = async (workflowId: string, prepare?: (fixture: ReturnType<typeof setup>) => void) => {
      const fixture = setup({ broken: 1 });
      prepare?.(fixture);
      const run = await fixture.start(workflowId);
      const final = await fixture.complete(run.runId);
      const definitionStages = new Set(sddWorkflow.stages.map((s) => s.id));
      const list = events(fixture.service, run.runId);
      return {
        status: final.status,
        states: ofType(list, "run.state_changed").map((e) => `${e.payload.from}>${e.payload.to}:${e.payload.reason}`),
        stages: ofType(list, "stage.started").map((e) => e.payload.stageId).filter((id) => definitionStages.has(id)),
        checks: fixture.service.store.checks(run.runId).map((c) => `${c.check_id}:${c.status}`),
        tasks: fixture.service.store.tasks(run.runId).map((t) => `${t.id}:${t.status}`),
        rounds: fixture.service.store.run(run.runId).repair_rounds,
        calls: fixture.executor.calls,
        // Corrections are appended when the repair transition is taken, after the stage step ends,
        // so artifact commits are compared by kind rather than by position.
        types: list.map((e) => e.type).filter((type) => !["transition.taken", "gate.finished", "artifact.committed"].includes(type)),
        artifacts: fixture.service.store.artifacts(run.runId).filter((a) => a.logical_path !== "definition/gates.json" && a.kind !== "state").map((a) => a.kind).sort(),
        transitions: ofType(list, "transition.taken").map((e) => e.payload.transitionId),
      };
    };
    const v1 = await trace("sdd");
    const v2 = await trace("sdd-v2", ({ define }) => define({ ...upgradeWorkflowV1(sddWorkflow, policy), id: "sdd-v2" }));
    expect(v1.status).toBe("completed");
    expect(v2.status).toBe("completed");
    expect(v2.states).toEqual(v1.states);
    expect(v2.stages).toEqual(v1.stages);
    expect(v2.checks).toEqual(v1.checks);
    expect(v2.tasks).toEqual(v1.tasks);
    expect(v2.rounds).toBe(v1.rounds);
    expect(v2.calls).toEqual(v1.calls);
    expect(v2.types).toEqual(v1.types);
    expect(v2.artifacts).toEqual(v1.artifacts);
    expect(v1.transitions).toEqual([]);
    expect(v2.transitions).toContain("checks-repair");
  }, 60000);

  test("V2-06 a state stored before v2 still parses and keeps the v1 stage index", () => {
    const { position: _p, report: _r, diff: _d, gateResults: _g, ...old } = RuntimeStateSchema.parse({
      prompt: "x", ownerLabel: "t", stageIndex: 4,
      manifest: { schemaVersion: 1, featureId: "fixture", workflowHash: "a".repeat(64), policyHash: "b".repeat(64), profileHashes: {}, skillHashes: {}, instructionHashes: [], constitutionHash: null, specHash: null, planHash: null, rootGraphHash: null, effectiveGraphHash: null, correctionHashes: [], baselineSnapshotId: null, dependencyContracts: [] },
      spec: null, plan: null, graph: null, rootGraph: null, research: null, analysisPassed: false, snapshotId: null, workspaceHash: null, expectedFiles: null, reviews: {}, convergence: null, approvalRoot: null, correctionHashes: [], published: {}, manualCriteria: {}, deferredCriteria: [], previousFindingSet: null, noProgressRounds: 0, verificationState: "not_verified", instructionText: "", frozenFiles: {},
    });
    const parsed = RuntimeStateSchema.parse(old);
    expect(parsed.position).toBeNull();
    expect(parsed.stageIndex).toBe(4);
    expect(parsed.gateResults).toEqual({});
  });

  test("quick fix completes without research, specification or review", async () => {
    const { start, complete, executor, service, define } = setup();
    define(quickFix());
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(final.status).toBe("completed");
    expect(executor.calls).toEqual(["plan", "implementation"]);
    const state = service.store.state(run.runId);
    expect(state.spec?.requirements[0]?.text).toBe("Create ready value");
    expect(state.spec?.criteria[0]?.method).toBe("automated");
    expect(state.position?.stageId).toBe("done");
    expect(state.gateResults.check?.status).toBe("passed");
    const completion = service.store.artifacts(run.runId).find((a) => a.logical_path === "completion.json");
    expect(completion).toBeDefined();
  }, 30000);

  test("the shipped quick-fix preset runs with the project's checks", async () => {
    const { start, complete, service } = setup();
    const run = await start("quick-fix");
    expect((await complete(run.runId)).status).toBe("completed");
    expect(service.store.checks(run.runId).map((c) => c.check_id)).toEqual(["check"]);
  }, 30000);

  test("the fix-ci preset hands the failing output to research and verifies with the same check", async () => {
    const loud = {
      ...valueCheck,
      args: ["-e", "const v = await Bun.file('value.txt').text().catch(() => ''); if (v.trim() !== 'ready') { console.log('expected ready, got nothing'); process.exit(1); }"],
    };
    const { start, complete, service, executor } = setup({}, { ...policy, checks: [loud] });
    const run = await start("fix-ci", "Fix the failing value check");
    expect((await complete(run.runId)).status).toBe("completed");
    expect(executor.calls).toEqual(["research", "plan", "implementation"]);
    expect(executor.prompts[0]).toContain("Required check check failed");
    expect(executor.prompts[0]).toContain("expected ready, got nothing");
    expect(service.store.checks(run.runId).map((c) => `${c.check_id}:${c.status}`)).toEqual([
      "check:failed",
      "check:passed",
    ]);
    const taken = ofType(events(service, run.runId), "transition.taken").map((e) => e.payload.transitionId);
    expect(taken[0]).toBe("reproduce-research");
    expect(taken.at(-1)).toBe("verify-done");
  }, 30000);

  test("the fix-ci preset ends without changes when the checks already pass", async () => {
    const { root, start, complete, executor, service } = setup();
    writeFileSync(join(root, "value.txt"), "ready");
    const run = await start("fix-ci", "Fix the failing value check");
    expect((await complete(run.runId)).status).toBe("completed");
    expect(executor.calls).toEqual([]);
    expect(service.store.checks(run.runId).map((c) => `${c.check_id}:${c.status}`)).toEqual(["check:passed"]);
  }, 30000);

  test("rejecting an approval with a note sends the resumed run back to specify with the note", async () => {
    const { start, drive, service, executor, pending } = setup();
    const run = await start("standard");
    expect((await drive(run.runId)).reason).toBe("approval");
    const first = pending(run.runId, "approval");
    if (!first) throw new Error("No pending approval");
    const waiting = await service.get(run.runId);
    const paused = await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "reject", requestId: first.id, explanation: "Implementing the CLI and its tests is in scope" });
    expect(paused.status).toBe("paused");
    await service.resume(run.runId, { commandId: newId(), expectedRevision: paused.revision });
    expect((await drive(run.runId)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "spec", "plan", "analysis"]);
    expect(executor.prompts[4]).toContain("Implementing the CLI and its tests is in scope");
    expect(service.store.state(run.runId).revisedRejections).toEqual([first.id]);
    const approvals = service.store.requests(run.runId).filter((r) => r.kind === "approval");
    expect(approvals.map((r) => r.status)).toEqual(["rejected", "pending"]);
  }, 30000);

  test("a plan finding from analysis goes back to the plan stage once before a person", async () => {
    const { start, drive, service, executor } = setup({ analysisFindings: 1 });
    const run = await start("standard");
    expect((await drive(run.runId)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "plan", "analysis"]);
    expect(executor.prompts[4]).toContain("Analysis findings on the plan");
    expect(service.store.state(run.runId).position?.visits.plan).toBe(2);
  }, 30000);

  test("under clarification: assume a spec finding from analysis goes back to specify", async () => {
    const { start, drive, service, executor } = setup(
      { analysisFindings: 1, findingKind: "ambiguity", findingRefs: ["spec.json:FR-001"] },
      { ...policy, clarification: "assume" },
    );
    const run = await start("standard");
    expect((await drive(run.runId)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "spec", "plan", "analysis"]);
    expect(executor.prompts[4]).toContain("Assumed:");
    expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
    const position = service.store.state(run.runId).position;
    expect(position?.visits.specify).toBe(2);
    expect(position?.stageId).toBe("approve");
  }, 30000);

  test("under clarification: assume a finding that survives the loop-backs is recorded as an assumption", async () => {
    const { start, drive, service, executor } = setup({ analysisFindings: 3 }, { ...policy, clarification: "assume" });
    const run = await start("standard");
    expect((await drive(run.runId)).reason).toBe("approval");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis", "plan", "analysis", "plan", "analysis"]);
    expect(service.store.requests(run.runId).some((r) => r.kind === "clarification")).toBe(false);
    expect(service.store.artifacts(run.runId).some((x) => x.logical_path === "assumptions/analysis.json")).toBe(true);
  }, 30000);

  test("under clarification: assume a scope finding that survives the loop-backs goes to a person", async () => {
    const { start, drive, executor } = setup(
      { analysisFindings: 3, findingKind: "scope", findingRefs: ["spec.json"] },
      { ...policy, clarification: "assume" },
    );
    const run = await start("standard");
    expect((await drive(run.runId)).reason).toBe("clarification");
    expect(executor.calls.filter((c) => c === "analysis").length).toBeGreaterThanOrEqual(2);
  }, 30000);

  test("without clarification: assume a spec finding from analysis goes to a person", async () => {
    const { start, drive, executor } = setup({ analysisFindings: 1, findingKind: "ambiguity", findingRefs: ["spec.json:FR-001"] });
    const run = await start("standard");
    expect((await drive(run.runId)).reason).toBe("clarification");
    expect(executor.calls).toEqual(["research", "spec", "plan", "analysis"]);
  }, 30000);

  // Runs de6cf1ab and 2fa658c0 used up their repair rounds on ever deeper medium findings while
  // every check passed. A medium finding after the first round is recorded, not repaired.
  test("a medium review finding after the first repair round does not start another", async () => {
    const { start, complete, service, executor } = setup({ reviewVerdict: "changes_requested" });
    const run = await start("standard");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(executor.calls.filter((c) => c === "review")).toHaveLength(2);
    expect(service.store.run(run.runId).repair_rounds).toBe(1);
  }, 30000);

  // Run 936ddfa5 blocked on "Coverage is incomplete" after round 1: the only finding for the
  // failing criteria was medium, below the floor. It still repairs, since acceptance needs a pass.
  test("a medium gap behind a failing criterion is repaired after the first round", async () => {
    const { start, complete, service } = setup({ gaps: 2, gapSeverity: "medium" }, { ...policy, maxConvergenceRounds: 3 });
    const run = await start("sdd");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.run(run.runId).convergence_rounds).toBe(2);
  }, 60000);

  // Bench round 08, propdrift eea2e0e9: AC-008 "confirmed on Windows, macOS, and Linux" came back
  // inconclusive with no finding twice and the run blocked with "Coverage is incomplete".
  test("an inconclusive automated criterion with no finding becomes a known limitation", async () => {
    const { start, complete, service } = setup({ unverifiable: true, criteria: 2 });
    const run = await start("sdd");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.run(run.runId).repair_rounds).toBe(0);
    expect(service.store.run(run.runId).convergence_rounds).toBe(0);
    const limitations = service.store.state(run.runId).limitations;
    expect(limitations.map((l) => [l.findingId, l.criterionIds, l.decidedBy])).toEqual([["unverified-AC-001", ["AC-001"], "notes"]]);
    expect(limitations[0]?.claim).toContain("macOS and Linux execution remain unconfirmed");
    expect(final.limitations).toEqual({ count: 1, ids: ["unverified-AC-001"] });
  }, 60000);

  test("a spec that renames the feature keeps the run's feature ID", async () => {
    const { start, complete, service } = setup({ renamedFeature: true });
    const run = await start("sdd");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.state(run.runId).spec?.featureId).toBe("fixture");
  }, 60000);

  test("an attempt that stops at its cap after editing continues once with larger caps", async () => {
    const { start, complete, service, executor } = setup({ capped: 1 });
    const run = await start("sdd");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(executor.maxTokens[1]).toBe(1500);
    expect(service.store.state(run.runId).taskContinuations).toEqual({ T001: 1 });
  }, 60000);

  test("a second capped attempt of the same task blocks the run", async () => {
    const { start, complete, service } = setup({ capped: 2 });
    const run = await start("sdd");
    const final = await complete(run.runId);
    expect(final.status).toBe("blocked");
    expect(lastError(service, run.runId)).toContain("did not complete its implementation");
  }, 60000);

  // Run de6cf1ab spent every repair round on ISO 8601 forms the spec never listed (#159).
  test("an inferred review finding is a note and starts no correction", async () => {
    const { start, complete, service, executor } = setup({
      reviewVerdict: "changes_requested",
      reviewFinding: { basis: "inferred" },
    });
    const run = await start("standard");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(executor.calls.filter((c) => c === "review")).toHaveLength(1);
    expect(service.store.run(run.runId).repair_rounds).toBe(0);
    expect(service.store.findings(run.runId)).toHaveLength(0);
  }, 30000);

  // Run 5b703388 corrected a regex claim that holds in Python but not in JavaScript (#155).
  test("a review finding whose repro does not show the claim is a note", async () => {
    const { start, complete, service, executor } = setup({
      reviewVerdict: "changes_requested",
      reviewFinding: { repro: { ...oldValueRepro, args: ["-e", "console.log('ready')"] } },
    });
    const run = await start("standard");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(executor.reviewTools[0]).toEqual(["run_repro"]);
    expect(service.store.run(run.runId).repair_rounds).toBe(0);
    expect(service.store.findings(run.runId)).toHaveLength(0);
    const record = service.store.artifacts(run.runId).find((a) => a.kind === "repro");
    expect(service.store.readArtifact(run.runId, record?.id ?? "")).toContain('"status":"refuted"');
  }, 30000);

  test("a correctness finding without a repro is a note", async () => {
    const { start, complete, service } = setup({
      reviewVerdict: "changes_requested",
      reviewFinding: { repro: undefined },
    });
    const run = await start("standard");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.run(run.runId).repair_rounds).toBe(0);
  }, 30000);

  test("an inferred security finding still starts a correction", async () => {
    const { start, complete, service } = setup({
      reviewVerdict: "changes_requested",
      reviewFinding: { kind: "security", basis: "inferred" },
    });
    const run = await start("standard");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.run(run.runId).repair_rounds).toBe(1);
  }, 30000);

  test("a failed check takes the bounded repair loop back to the tasks stage", async () => {
    const { start, complete, service, define } = setup({ broken: 1 });
    define(quickFix());
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    const taken = ofType(events(service, run.runId), "transition.taken").map((e) => `${e.payload.transitionId}:${e.payload.outcome}`);
    expect(taken).toEqual(["plan-approve:passed", "approve-implement:passed", "implement-checks:passed", "checks-repair:failed", "implement-checks:passed", "checks-done:passed"]);
    expect(service.store.state(run.runId).position?.loops).toEqual({ "checks-repair": 1 });
    expect(service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001", "T002"]);
  }, 30000);

  // A check whose fixer resolves what it reports passes without a repair task (#235).
  const fixer = (to: string) => ({
    executable: "bun",
    args: ["-e", `const f = process.argv.at(-1); await Bun.write(f, (await Bun.file(f).text()).replace('broken', '${to}'))`],
  });

  test("a failed check fixed by its fixer passes without a repair task, and undo sees the fix", async () => {
    const fixable: RunPolicy = { ...policy, checks: [{ ...valueCheck, fix: fixer("ready") }] };
    const { start, complete, service, define, root, executor } = setup({ broken: 1 }, fixable);
    const preset = builtinPresets.get("quick-fix");
    if (!preset) throw new Error("quick-fix preset missing");
    define({ ...instantiatePreset(preset, fixable), id: "custom-fix", preset: "custom" });
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(executor.implementations).toBe(1);
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");
    const taken = ofType(events(service, run.runId), "transition.taken").map((e) => e.payload.transitionId);
    expect(taken).not.toContain("checks-repair");
    expect(service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001"]);
    expect(service.store.checks(run.runId).map((c) => `${c.check_id}:${c.status}`)).toEqual(["check:failed", "check:passed"]);
    const fixes = service.store.effects(run.runId).filter((e) => e.kind === "file_patch" && JSON.parse(e.intent_json).tool === "apply_fix");
    expect(fixes.map((e) => JSON.parse(e.intent_json))).toEqual([{ path: "value.txt", tool: "apply_fix", checkId: "check", taskId: "T001" }]);
    expect(fixes[0]?.status).toBe("applied");
    // The fix belongs to T001: once the task is invalidated, undo restores the fixer's pre-image
    // (the fixture writes the task's own edit without the journal).
    service.store.transaction(() => service.store.taskStatus(run.runId, "T001", "invalidated"));
    expect(uncommittedEdits(service.store, run.runId).map((e) => e.id)).toEqual(fixes.map((e) => e.id));
    await service.undo(run.runId, { commandId: newId(), expectedRevision: (await service.get(run.runId)).revision });
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("broken");
  }, 30000);

  test("a failure the fixer cannot resolve still becomes a repair task", async () => {
    const fixable: RunPolicy = { ...policy, checks: [{ ...valueCheck, fix: fixer("still broken") }] };
    const { start, complete, service, define } = setup({ broken: 1 }, fixable);
    const preset = builtinPresets.get("quick-fix");
    if (!preset) throw new Error("quick-fix preset missing");
    define({ ...instantiatePreset(preset, fixable), id: "custom-fix", preset: "custom" });
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001", "T002"]);
    expect(service.store.checks(run.runId).map((c) => `${c.check_id}:${c.status}`)).toEqual(["check:failed", "check:failed", "check:passed"]);
  }, 30000);

  test("the v1 check stage runs the fixer before repairing", async () => {
    const fixable: RunPolicy = { ...policy, checks: [{ ...valueCheck, fix: fixer("ready") }] };
    const { start, complete, service, executor } = setup({ broken: 1 }, fixable);
    const run = await start("sdd");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(executor.implementations).toBe(1);
    expect(service.store.run(run.runId).repair_rounds).toBe(0);
  }, 60000);

  test("a failed check is repaired even when a later required check is inconclusive", async () => {
    // The slow check times out until the value is fixed, like a suite that cannot finish while
    // another check is red; the run repairs the failure instead of stopping on the timeout.
    const slow = { ...valueCheck, id: "slow", timeoutMs: 1000, args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') await Bun.sleep(5000)"] };
    const slowPolicy: RunPolicy = { ...policy, checks: [valueCheck, slow] };
    const { start, complete, service, define } = setup({ broken: 1 }, slowPolicy);
    const preset = builtinPresets.get("quick-fix");
    if (!preset) throw new Error("quick-fix preset missing");
    define({ ...instantiatePreset(preset, slowPolicy), id: "custom-fix", preset: "custom" });
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    const taken = ofType(events(service, run.runId), "transition.taken").map((e) => `${e.payload.transitionId}:${e.payload.outcome}`);
    expect(taken).toContain("checks-repair:failed");
    expect(service.store.checks(run.runId).map((c) => `${c.check_id}:${c.status}`)).toEqual(["check:failed", "slow:inconclusive", "check:passed", "slow:passed"]);
  }, 30000);

  test("V2-08 the visit cap stops a run that would loop on", async () => {
    const { start, complete, service, define } = setup({ broken: 5 });
    define(quickFix((d) => ({ ...d, limits: { maxStageVisits: 4 } })));
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(final.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("no_progress");
    expect(lastError(service, run.runId)).toContain("4 stage visits");
    // The rejected transition left no corrective task behind.
    expect(service.store.tasks(run.runId).map((t) => t.id)).toEqual(["T001"]);
  }, 30000);

  test("V2-08 a loop stops at its maxIterations", async () => {
    const loose = { ...policy, maxConvergenceRounds: 3 };
    const { start, complete, service, define } = setup({ gaps: 2 }, loose);
    const upgraded = upgradeWorkflowV1(sddWorkflow, loose);
    define({
      ...upgraded, id: "tight",
      transitions: upgraded.transitions.map((t) => (t.id === "converge-repair" ? { ...t, loop: { maxIterations: 1 } } : t)),
    });
    const run = await start("tight");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toContain("loop converge-repair reached its bound of 1");
    expect(final.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("no_progress");
    expect(lastError(service, run.runId)).toContain("loop converge-repair reached its bound of 1");
  }, 60000);

  test("V2-07 a branch by when picks the transition that matches the carried contract", async () => {
    const { start, complete, service, define } = setup();
    const upgraded = upgradeWorkflowV1(sddWorkflow, policy);
    // After learning, a passing convergence goes straight to done; anything else would loop back.
    define({
      ...upgraded, id: "branchy",
      transitions: [
        ...upgraded.transitions.filter((t) => t.id !== "converge-learn"),
        { id: "converge-skip-learn", from: "converge", to: "done", on: "passed", carries: "convergence", gates: [], when: { field: "$.verdict", equals: "pass" } },
        { id: "converge-learn", from: "converge", to: "learn", on: "passed", carries: "convergence", gates: [] },
      ],
    });
    const run = await start("branchy");
    expect((await complete(run.runId)).status).toBe("completed");
    const taken = ofType(events(service, run.runId), "transition.taken").map((e) => e.payload.transitionId);
    expect(taken.at(-1)).toBe("converge-skip-learn");
    expect(taken).not.toContain("learn-done");
  }, 60000);

  test("V2-09 advisory gates never block, retries are recorded and a late pass is flaky", async () => {
    const { start, complete, service, define, gate, root } = setup();
    const counter = join(root, "..", `${basename(root)}-counter`);
    cleanups.push(() => rmSync(counter, { force: true }));
    gate(commandGate("always-fails", ["-e", "process.exit(3)"], { required: false }));
    gate(commandGate("second-time", ["-e", `const f=${JSON.stringify(counter)};const n=Number(await Bun.file(f).text().catch(()=>"0"))+1;await Bun.write(f,String(n));process.exit(n>1?0:1)`], { retries: { max: 2, retryOn: ["failed"] } }));
    define(quickFix((d) => ({
      ...d,
      stages: d.stages.map((s) => (s.type === "check" ? { ...s, gates: [{ gateId: "always-fails" }, { gateId: "check" }, { gateId: "second-time" }] } : s)),
    })));
    const run = await start("custom-fix");
    expect((await complete(run.runId)).status).toBe("completed");
    const finished = ofType(events(service, run.runId), "gate.finished").map((e) => e.payload);
    // Required gates run first, in order; the advisory gate runs last and is only recorded.
    expect(finished.map((g) => `${g.gateId}:${g.status}:${g.mode}`)).toEqual(["check:passed:required", "second-time:passed:required", "always-fails:failed:advisory"]);
    expect(finished.find((g) => g.gateId === "second-time")).toMatchObject({ attempts: 2, flaky: true });
    expect(service.store.checks(run.runId).filter((c) => c.check_id === "second-time").map((c) => c.status)).toEqual(["failed", "passed"]);
  }, 30000);

  test("V2-09 transition gates stop at the first required failure and block", async () => {
    const { start, complete, service, define, gate } = setup();
    gate(commandGate("gate-fails", ["-e", "process.exit(1)"]));
    gate(commandGate("never-runs", ["-e", "process.exit(0)"]));
    define(quickFix((d) => ({
      ...d,
      transitions: d.transitions.map((t) => (t.id === "checks-done" ? { ...t, gates: [{ gateId: "gate-fails" }, { gateId: "never-runs" }] } : t)),
    })));
    const run = await start("custom-fix");
    const final = await complete(run.runId);
    expect(final.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("verification_failed");
    expect(service.store.checks(run.runId).map((c) => c.check_id)).toEqual(["check", "gate-fails"]);
  }, 30000);

  test("V2-09 a human gate on a transition waits for evidence and then lets the run finish", async () => {
    const { start, complete, service, define, gate, pending } = setup();
    gate({
      schemaVersion: 1, id: "signoff", description: "A person confirms the change", required: true, scope: "transition", timeoutMs: 3600000,
      retries: { max: 0, retryOn: [] }, evidence: { kind: "decision", keepOutputLines: 40, artifactPaths: [] },
      type: "human", human: { prompt: "Confirm the value looks right", answer: "evidence", bindsDigest: true },
    } as Gate);
    define(quickFix((d) => ({
      ...d,
      transitions: d.transitions.map((t) => (t.id === "checks-done" ? { ...t, gates: [{ gateId: "signoff" }] } : t)),
    })));
    const run = await start("custom-fix");
    const waiting = await complete(run.runId);
    expect(waiting.status).toBe("waiting");
    const request = pending(run.runId, "manual_evidence");
    const body = JSON.parse(request?.body_json ?? "{}") as { criterionId: string; question: string };
    expect(body.criterionId).toBe("gate-signoff");
    expect(body.question).toBe("Confirm the value looks right");
    const snapshot = await service.get(run.runId);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "manual-evidence", requestId: request?.id ?? "", criterionId: "gate-signoff", accepted: true, evidence: "Checked by hand" });
    expect((await complete(run.runId)).status).toBe("completed");
    expect(service.store.state(run.runId).gateResults.signoff?.status).toBe("passed");
  }, 30000);

  test("V2-10 the effective mode of a gate is part of the approval digest", async () => {
    const digests: string[] = [];
    for (const mode of ["required", "advisory"] as const) {
      const { start, drive, define, pending, service } = setup();
      define(quickFix((d) => ({
        ...d,
        stages: d.stages.map((s) => (s.type === "check" ? { ...s, gates: [{ gateId: "check", mode }] } : s)),
      })));
      const run = await start("custom-fix");
      await drive(run.runId);
      digests.push(pending(run.runId, "approval")?.digest ?? "");
      expect(JSON.parse(service.store.run(run.runId).policy_json).checks[0].required).toBe(mode === "required");
    }
    expect(digests[0]).toHaveLength(64);
    expect(digests[1]).not.toBe(digests[0]);
  }, 30000);

  test("a spike researches and reports without an approval or a file change", async () => {
    const { start, complete, executor, service, root } = setup();
    const run = await start("spike");
    expect((await complete(run.runId)).status).toBe("completed");
    expect(executor.calls).toEqual(["research", "report"]);
    expect(service.store.requests(run.runId)).toEqual([]);
    const completion = service.store.artifacts(run.runId).find((a) => a.logical_path === "completion.json");
    const body = JSON.parse(service.store.readArtifact(run.runId, completion?.id ?? "")) as { report: { recommendation: { kind: string } } };
    expect(body.report.recommendation.kind).toBe("proceed");
    expect(() => readFileSync(join(root, "value.txt"))).toThrow();
  }, 30000);

  test("review only reviews the working tree diff and reports findings without repairing", async () => {
    const { start, complete, executor, service, root } = setup({ reviewVerdict: "changes_requested" });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(root, "value.txt"), "old");
    git("add", ".");
    git("commit", "-qm", "base");
    writeFileSync(join(root, "value.txt"), "ready");
    const run = await start("review-only", "Review the value change");
    const final = await complete(run.runId);
    expect(final.status).toBe("completed");
    expect(executor.calls).toEqual(["review"]);
    const state = service.store.state(run.runId);
    expect(state.diff?.files).toEqual(["value.txt"]);
    expect(service.store.readArtifact(run.runId, state.diff?.artifactId ?? "")).toContain("+ready");
    expect(state.gateResults["security-review"]?.status).toBe("skipped");
    expect(state.gateResults["correctness-review"]?.status).toBe("failed");
    const taken = ofType(events(service, run.runId), "transition.taken").map((e) => e.payload.transitionId);
    expect(taken).toEqual(["review-findings"]);
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("ready");

  }, 30000);
});

describe("a stopped convergence asks for a decision", () => {
  const pendingConvergence = (service: NativeWorkflowService, runId: string) =>
    service.store.requests(runId).find((r) => r.kind === "convergence" && r.status === "pending");
  const decide = async (service: NativeWorkflowService, runId: string, kind: "accept" | "continue" | "reject") => {
    const request = pendingConvergence(service, runId);
    if (!request) throw new Error("No pending convergence request");
    const run = await service.get(runId);
    const command = { commandId: newId(), expectedRevision: run.revision };
    return service.decide(runId, command, kind === "reject" ? { kind, requestId: request.id, explanation: "Stop" } : { kind, requestId: request.id });
  };
  /** Three gaps against two allowed convergence rounds: the third review cannot start a repair. */
  const stopped = async (workflow: "sdd" | "v2-sdd", behavior: Behavior = { gaps: 3 }, runPolicy: RunPolicy = policy) => {
    const fixture = setup(behavior, runPolicy);
    fixture.define({ ...upgradeWorkflowV1(sddWorkflow, runPolicy), id: "v2-sdd" });
    const run = await fixture.start(workflow);
    const waiting = await fixture.complete(run.runId);
    return { ...fixture, run, waiting };
  };

  for (const workflow of ["sdd", "v2-sdd"] as const) {
    test(`${workflow}: the run waits for a decision instead of blocking`, async () => {
      const { service, run, waiting } = await stopped(workflow);
      expect(waiting.status).toBe("waiting");
      expect(service.store.run(run.runId).reason).toBe("no_progress");
      const body = JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}");
      expect(body.reason).toBe("rounds");
      expect(body.setting).toBe("maxConvergenceRounds");
      expect(body.findings.map((f: { claim: string }) => f.claim)).toEqual(["Gap number 3 remains"]);
      expect(body.criteria.failing.map((c: { id: string }) => c.id)).toEqual(["AC-001"]);
      expect(body.checksPassing).toBe(true);
      expect(service.store.run(run.runId).corrective_tasks).toBe(2);
    }, 60000);

    test(`${workflow}: accepting lists the findings as known limitations and completes the run`, async () => {
      const { service, run, complete } = await stopped(workflow);
      await decide(service, run.runId, "accept");
      const final = await complete(run.runId);
      expect(lastError(service, run.runId)).toBe("");
      expect(final.status).toBe("completed");
      const state = service.store.state(run.runId);
      expect(state.limitations.map((l) => [l.claim, l.decidedBy])).toEqual([["Gap number 3 remains", "user"]]);
      expect(service.store.run(run.runId).convergence_rounds).toBe(2);
      const report = runReport(service.store, run.runId);
      expect(report).toContain("## Known limitations");
      expect(report).toContain("Gap number 3 remains");
    }, 60000);

    test(`${workflow}: one more round repairs the findings and can complete the run`, async () => {
      const { service, run, complete, executor } = await stopped(workflow);
      await decide(service, run.runId, "continue");
      const final = await complete(run.runId);
      expect(lastError(service, run.runId)).toBe("");
      expect(final.status).toBe("completed");
      expect(service.store.run(run.runId).convergence_rounds).toBe(3);
      expect(service.store.state(run.runId).limitations).toEqual([]);
      expect(executor.convergences).toBe(4);
    }, 60000);

    test(`${workflow}: stopping leaves the run paused and a resume asks again`, async () => {
      const { service, run, drive } = await stopped(workflow, { gaps: 4 });
      const paused = await decide(service, run.runId, "reject");
      expect(paused.status).toBe("paused");
      expect(pendingConvergence(service, run.runId)).toBeUndefined();
      await service.resume(run.runId, { commandId: newId(), expectedRevision: paused.revision });
      expect((await drive(run.runId)).status).toBe("waiting");
      expect(pendingConvergence(service, run.runId)).toBeDefined();
    }, 60000);
  }

  test("the terminal accepts the findings and continues the run", async () => {
    const { service, run } = await stopped("sdd");
    const request = pendingConvergence(service, run.runId);
    const revision = (await service.get(run.runId)).revision;
    const result = (await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["accept", run.runId, "--request", request?.id ?? "", "--expected-revision", String(revision)]),
      new AbortController().signal,
    )) as { status: string };
    expect(result.status).toBe("completed");
    expect(service.store.state(run.runId).limitations).toHaveLength(1);
    // The status projection says so too, with the exit code unchanged.
    const snapshot = service.store.snapshot(run.runId);
    expect(snapshot.limitations.count).toBe(1);
    expect(snapshot.limitations.ids).toEqual(service.store.state(run.runId).limitations.map((l) => l.findingId));
  }, 60000);

  test("an approval decision is refused for a convergence request", async () => {
    const { service, run } = await stopped("sdd");
    const request = pendingConvergence(service, run.runId);
    const current = await service.get(run.runId);
    await expect(
      service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "approve", requestId: request?.id ?? "", digest: "0".repeat(64) }),
    ).rejects.toThrow();
  }, 60000);

  test("clarification assume accepts a low-severity residual when the checks pass", async () => {
    const assume = { ...policy, clarification: "assume" as const };
    const { service, run, waiting } = await stopped("sdd", { gaps: 3, gapSeverity: "medium", criteria: 5 }, assume);
    expect(lastError(service, run.runId)).toBe("");
    expect(waiting.status).toBe("completed");
    const state = service.store.state(run.runId);
    expect(state.limitations.map((l) => l.decidedBy)).toEqual(["assume"]);
    const request = service.store.requests(run.runId).find((r) => r.kind === "convergence");
    expect(request?.status).toBe("accepted");
    expect(request?.actor).toBe("auto-approval");
  }, 60000);

  test("clarification assume accepts a high finding that carries no reproduction", async () => {
    const assume = { ...policy, clarification: "assume" as const };
    const { waiting, service, run } = await stopped("sdd", { gaps: 3, criteria: 5 }, assume);
    expect(waiting.status).toBe("completed");
    expect(service.store.state(run.runId).limitations.map((l) => l.decidedBy)).toEqual(["assume"]);
  }, 60000);

  test("clarification assume still asks for a high finding with a reproduction and says why", async () => {
    const assume = { ...policy, clarification: "assume" as const };
    const { waiting, service, run } = await stopped("sdd", { gaps: 3, criteria: 5, gapRepro: true }, assume);
    expect(waiting.status).toBe("waiting");
    const body = JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}");
    expect(body.hostRule.decision).toBe("ask");
    expect(body.hostRule.why).toContain("high with a reproduction");
    expect(body.hostRule.rules.length).toBe(3);
  }, 60000);

  test("a repeat the reviewer names stops the run although file and symbol changed (md-site)", async () => {
    // md-site F-001 `buildSite / rewriteMarkdownLink` vs F-001-2 `buildSite`, and a file that moved: same defect.
    const { service, run, waiting } = await stopped("sdd", { gaps: 2, gapSymbols: ["buildSite", "markdownToHtml"], gapRepeatOf: (round) => (round === 2 ? "G1" : undefined) });
    expect(waiting.status).toBe("waiting");
    const body = JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}");
    expect(body.reason).toBe("contradiction");
    expect(body.contradictions[0]).toMatchObject({ findingId: "G2", earlierId: "G1", via: "repeatOf" });
  }, 60000);

  test("a finding the reviewer marks new does not stop the run on a shared location (jsonshape, expenses-py A)", async () => {
    const { service, run, waiting } = await stopped("sdd", { gaps: 2, gapSymbol: "parseValue", gapRepeatOf: () => null });
    expect(waiting.status).toBe("completed");
    expect(service.store.requests(run.runId).filter((r) => r.kind === "convergence")).toHaveLength(0);
    expect(service.store.run(run.runId).convergence_rounds).toBe(2);
  }, 60000);

  test("without repeatOf a symbol that shares a word still matches", async () => {
    const { service, run, waiting } = await stopped("sdd", { gaps: 2, gapSymbols: ["buildSite / rewriteMarkdownLink", "buildSite"] });
    expect(waiting.status).toBe("waiting");
    expect(JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}").contradictions[0].via).toBe("location");
  }, 60000);

  test("clarification assume repairs one more round on a contradiction before it judges, and shows the rule", async () => {
    const assume = { ...policy, clarification: "assume" as const };
    const { service, run, waiting } = await stopped("sdd", { gaps: 2, gapSymbol: "parseValue" }, assume);
    expect(lastError(service, run.runId)).toBe("");
    expect(waiting.status).toBe("completed");
    expect(service.store.state(run.runId).autoExtensions).toBe(1);
    expect(service.store.state(run.runId).limitations).toEqual([]);
    const request = service.store.requests(run.runId).find((r) => r.kind === "convergence");
    expect(request?.status).toBe("accepted");
    expect(request?.actor).toBe("auto-approval");
    const body = JSON.parse(request?.body_json ?? "{}");
    expect(body.reason).toBe("contradiction");
    expect(body.hostRule.decision).toBe("extend");
  }, 60000);

  test("the automatic extra round is granted once per run", async () => {
    const assume = { ...policy, clarification: "assume" as const };
    // Round 2 repeats round 1 (extended), then the rounds limit stops the third: a high finding with a reproduction asks.
    const { service, run, waiting } = await stopped("sdd", { gaps: 3, gapRepro: true, gapSymbol: "parseValue" }, assume);
    expect(waiting.status).toBe("waiting");
    expect(service.store.state(run.runId).autoExtensions).toBe(1);
    expect(JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}").hostRule.decision).toBe("ask");
  }, 60000);

  test("the terminal continues the run after one more round without --resume", async () => {
    const { service, run } = await stopped("sdd");
    const request = pendingConvergence(service, run.runId);
    const revision = (await service.get(run.runId)).revision;
    const result = (await executeWorkflowCommand(
      service,
      parseWorkflowArgs(["continue", run.runId, "--request", request?.id ?? "", "--expected-revision", String(revision)]),
      new AbortController().signal,
    )) as { status: string };
    expect(result.status).toBe("completed");
  }, 60000);

  test("a finding that reverses the fix of an earlier one on the same symbol is sent to a person", async () => {
    // Two rounds are allowed, so the limit is not what stops the run: the second gap names the
    // symbol the first repair changed for the same criterion.
    const { service, run, waiting } = await stopped("sdd", { gaps: 2, gapSymbol: "parseValue" });
    expect(waiting.status).toBe("waiting");
    const body = JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}");
    expect(body.reason).toBe("contradiction");
    expect(body.contradictions).toHaveLength(1);
    expect(body.contradictions[0].earlierClaim).toBe("Gap number 1 remains");
    expect(service.store.run(run.runId).convergence_rounds).toBe(1);
  }, 60000);

  test("a reworded finding on the same file and criterion is the second occurrence of a residual", async () => {
    // No symbol and a new claim and id each round: the location (criterion, file) is the key.
    const { service, run, waiting } = await stopped("sdd", { gaps: 2, gapSameLocation: true });
    expect(waiting.status).toBe("waiting");
    const body = JSON.parse(pendingConvergence(service, run.runId)?.body_json ?? "{}");
    expect(body.reason).toBe("contradiction");
    expect(body.contradictions[0].earlierId).not.toBe(body.contradictions[0].findingId);
  }, 60000);

  test("one more round repairs a contradicting finding without asking again", async () => {
    const { service, run, complete } = await stopped("sdd", { gaps: 2, gapSymbol: "parseValue" });
    await decide(service, run.runId, "continue");
    const final = await complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(service.store.requests(run.runId).filter((r) => r.kind === "convergence")).toHaveLength(1);
  }, 60000);
});

describe("an unknown effect at acceptance", () => {
  const recoveryRequests = (service: NativeWorkflowService, runId: string) => service.store.requests(runId).filter((r) => r.kind === "recovery");
  for (const workflow of ["sdd", "v2-sdd"] as const) {
    test(`${workflow}: an effect of a task attempt that a completed attempt superseded is settled and the run completes`, async () => {
      const fixture = setup({ unknownEffect: "task" });
      fixture.define({ ...upgradeWorkflowV1(sddWorkflow, policy), id: "v2-sdd" });
      const run = await fixture.start(workflow);
      const final = await fixture.complete(run.runId);
      expect(lastError(fixture.service, run.runId)).toBe("");
      expect(final.status).toBe("completed");
      expect(recoveryRequests(fixture.service, run.runId)).toEqual([]);
      expect(fixture.service.store.effects(run.runId).filter((e) => e.kind === "file_patch").map((e) => e.status)).toEqual(["failed"]);
      expect(fixture.service.store.artifacts(run.runId).some((a) => a.logical_path.startsWith("superseded-effects/"))).toBe(true);
    }, 60000);
  }

  test("an effect nothing superseded opens a recovery request at the stop, and recording it not applied finishes the run", async () => {
    const fixture = setup({ unknownEffect: "converge" });
    const run = await fixture.start("sdd");
    const state = await fixture.complete(run.runId);
    expect(state.status).toBe("waiting");
    expect(fixture.service.store.run(run.runId).reason).toBe("interrupted_effect");
    const request = recoveryRequests(fixture.service, run.runId).find((r) => r.status === "pending");
    expect(request).toBeDefined();
    const body = JSON.parse(request?.body_json ?? "{}");
    expect(body.stoppedAt).toBe("acceptance");
    expect(body.note).toContain("record-not-applied");
    await fixture.service.decide(run.runId, { commandId: newId(), expectedRevision: state.revision }, { kind: "recovery", requestId: request?.id ?? "", effectId: body.effectId, resolution: "record-not-applied", evidence: "The file does not contain the change" });
    const final = await fixture.complete(run.runId);
    expect(lastError(fixture.service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
  }, 60000);
});

describe("a low partial finding passes with notes", () => {
  for (const workflow of ["sdd", "v2-sdd"] as const) {
    test(`${workflow}: it starts no repair, completes the run and is listed in the report`, async () => {
      const fixture = setup({ gaps: 1, gapSeverity: "low", gapKind: "partial" });
      fixture.define({ ...upgradeWorkflowV1(sddWorkflow, policy), id: "v2-sdd" });
      const run = await fixture.start(workflow);
      const final = await fixture.complete(run.runId);
      expect(lastError(fixture.service, run.runId)).toBe("");
      expect(final.status).toBe("completed");
      const row = fixture.service.store.run(run.runId);
      expect([row.repair_rounds, row.convergence_rounds, row.corrective_tasks]).toEqual([0, 0, 0]);
      expect(fixture.executor.implementations).toBe(1);
      const state = fixture.service.store.state(run.runId);
      expect(state.limitations.map((l) => [l.claim, l.decidedBy, l.severity, l.kind])).toEqual([["Gap number 1 remains", "notes", "low", "partial"]]);
      expect(fixture.service.store.findings(run.runId).map((f) => f.status)).toEqual(["resolved"]);
      const report = runReport(fixture.service.store, run.runId);
      expect(report).toContain("## Known limitations");
      expect(report).toContain("notes rule (behavior verified)");
    }, 60000);
  }

  test("a low finding of another kind still starts a repair", async () => {
    const fixture = setup({ gaps: 1, gapSeverity: "low", gapKind: "missing" });
    const run = await fixture.start("sdd");
    const final = await fixture.complete(run.runId);
    expect(final.status).toBe("completed");
    expect(fixture.service.store.run(run.runId).convergence_rounds).toBe(1);
    expect(fixture.service.store.state(run.runId).limitations).toEqual([]);
  }, 60000);

  test("a medium partial finding still starts a repair", async () => {
    const fixture = setup({ gaps: 1, gapSeverity: "medium", gapKind: "partial" });
    const run = await fixture.start("sdd");
    const final = await fixture.complete(run.runId);
    expect(final.status).toBe("completed");
    expect(fixture.service.store.run(run.runId).convergence_rounds).toBe(1);
  }, 60000);
});

describe("passesWithNotes", () => {
  const finding = { id: "F1", kind: "partial", severity: "low", requirementIds: [], criterionIds: ["AC-001"], file: null, symbol: null, evidenceIds: ["E1"], claim: "c", impact: "i", suggestedFix: "f" } as const;
  const coverage = [{ criterionId: "AC-001", verdict: "fail" as const, evidenceIds: ["E1"], explanation: "x" }];
  test("needs passing checks, low severity, partial kind and evidence for each criterion", () => {
    expect(passesWithNotes(finding, coverage, true)).toBe(true);
    expect(passesWithNotes(finding, coverage, false)).toBe(false);
    expect(passesWithNotes({ ...finding, severity: "medium" }, coverage, true)).toBe(false);
    expect(passesWithNotes({ ...finding, kind: "correctness" }, coverage, true)).toBe(false);
    expect(passesWithNotes({ ...finding, criterionIds: [] }, coverage, true)).toBe(false);
    expect(passesWithNotes(finding, [{ ...coverage[0]!, evidenceIds: [] }], true)).toBe(false);
  });
  test("a medium partial finding passes only on a test or documentation file", () => {
    const medium = { ...finding, severity: "medium" as const };
    for (const file of ["tests/store.test.ts", "src/a.spec.ts", "test_cli.py", "README.md", "docs/usage.md"])
      expect(passesWithNotes({ ...medium, file }, coverage, true)).toBe(true);
    for (const file of [null, "src/store.ts", "src/latest.ts"])
      expect(passesWithNotes({ ...medium, file }, coverage, true)).toBe(false);
    expect(passesWithNotes({ ...medium, severity: "high", file: "README.md" }, coverage, true)).toBe(false);
  });
});

describe("project gates and protected definitions", () => {
  test("a project gate runs only after the user confirmed its current definition", async () => {
    const fixture = setup();
    const extra = commandGate("extra", ["-e", "process.exit(0)"]);
    fixture.gate(extra, false);
    fixture.define(quickFix((d) => ({
      ...d,
      stages: d.stages.map((s) => (s.type === "check" ? { ...s, gates: [{ gateId: "check" }, { gateId: "extra" }] } : s)),
    })));
    await expect(fixture.start("custom-fix")).rejects.toThrow(/extra: runs bun -e process.exit\(0\)[\s\S]*gates confirm extra/);
    const listed = executeDefinitionCommand(parseWorkflowArgs(["gates"]), fixture.root, policy).result as { gates: { id: string; confirmed?: boolean }[] };
    expect(listed.gates.find((g) => g.id === "extra")?.confirmed).toBe(false);
    executeDefinitionCommand(parseWorkflowArgs(["gates", "confirm", "extra"]), fixture.root, policy);
    const run = await fixture.start("custom-fix");
    expect(run.status).toBe("created");
    // A changed definition is a different gate and needs a new confirmation.
    fixture.gate({ ...extra, timeoutMs: 20000 } as Gate, false);
    await expect(fixture.start("custom-fix")).rejects.toThrow("gates confirm extra");
    executeDefinitionCommand(parseWorkflowArgs(["gates", "confirm", "--all"]), fixture.root, policy);
    expect((await fixture.start("custom-fix")).status).toBe("created");
  });

  test("a project gate that shadows a policy check is named as a replacement", async () => {
    const fixture = setup();
    fixture.gate(commandGate("check", ["-e", "process.exit(0)"]), false);
    fixture.define(quickFix());
    await expect(fixture.start("custom-fix")).rejects.toThrow("replaces the policy gate of the same ID");
  });

  test("V2-13 no profile may write workflow definitions, gates, profiles or skills", async () => {
    const fixture = setup();
    const run = await fixture.start("spike");
    const profile = builtinProfiles.find((p) => p.id === "implementer");
    if (!profile) throw new Error("implementer profile missing");
    const guard = new WorkflowToolPolicy(fixture.service.store, fixture.service.leases, run.runId, "attempt", profile, policy);
    for (const path of ["baked/workflows/quick.json", "baked/gates/tests.json", "baked/agents/x.json", "baked/skills/s/SKILL.md", "baked/constitution.md"])
      expect(() => guard.path(path)).toThrow("Protected workflow path");
    expect(guard.path("src/baked/workflows.ts")).toBe("src/baked/workflows.ts");
  });
});

describe("workflow v2 auto approval", () => {
  const limits = { enabled: true as const, maxTasks: 3, maxFiles: 5, allowedPaths: ["value.txt"], allowDelete: false, allowNewDependencies: false as const, maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens };
  const autoFix = (allowedPaths = limits.allowedPaths) => quickFix((d) => ({
    ...d,
    stages: d.stages.map((s) => (s.type === "approval" ? { ...s, decision: "auto" as const } : s)),
    autoApproval: { ...limits, allowedPaths },
  }));
  const confirmed = (fixture: ReturnType<typeof setup>, hash: string) =>
    fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "custom-fix", prompt: "Create ready value", ownerLabel: "test", policy, autoApprovalConfirmation: hash });

  test("V2-12 a definition with auto approval starts only after its limits are confirmed", async () => {
    const fixture = setup();
    fixture.define(autoFix());
    const refused = await fixture.start("custom-fix").catch((error: Error & { details?: { autoApprovalHash?: string } }) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("at most 3 tasks");
    const hash = (refused as { details: { autoApprovalHash: string } }).details.autoApprovalHash;
    await expect(confirmed(fixture, "0".repeat(64))).rejects.toThrow("Confirm these limits");
    const run = await confirmed(fixture, hash);
    expect(JSON.parse(fixture.service.store.run(run.runId).policy_json).autoApproval.limits.allowedPaths).toEqual(["value.txt"]);
  });

  test("V2-12 inside the limits the host approves with the digest a person would sign", async () => {
    const fixture = setup();
    fixture.define(autoFix());
    const hash = hashJson(autoFix().autoApproval);
    const run = await confirmed(fixture, hash);
    const final = await fixture.drive(run.runId);
    expect(final.status).toBe("completed");
    const approval = fixture.service.store.requests(run.runId).find((r) => r.kind === "approval");
    expect(approval?.status).toBe("accepted");
    expect(approval?.actor).toBe("auto-approval");
    expect(fixture.service.store.run(run.runId).approval_digest).toBe(approval?.digest ?? "");
  }, 30000);

  test("V2-12 outside the limits the run waits for a person", async () => {
    const fixture = setup();
    fixture.define(autoFix(["src/**"]));
    const run = await confirmed(fixture, hashJson(autoFix(["src/**"]).autoApproval));
    expect((await fixture.drive(run.runId)).status).toBe("waiting");
    const body = JSON.parse(fixture.pending(run.runId, "approval")?.body_json ?? "{}") as { autoApproval: { declined: string[] } };
    expect(body.autoApproval.declined).toContain("Limits: value.txt is outside the allowed paths");
  }, 30000);

  test("a human approval stage ignores auto approval in the project policy", async () => {
    const auto = { ...policy, autoApproval: { renewal: false, limits: { maxTasks: 3, maxFiles: 5, allowedPaths: ["**"], allowDelete: false, allowNewDependencies: false as const, maxTotalTokens: defaultWorkflowPolicy.maxTotalTokens } } };
    const fixture = setup({}, auto);
    fixture.define(quickFix());
    const run = await fixture.start("custom-fix");
    expect(JSON.parse(fixture.service.store.run(run.runId).policy_json).autoApproval).toBeNull();
    expect((await fixture.drive(run.runId)).status).toBe("waiting");
    expect(fixture.pending(run.runId, "approval")).toBeDefined();
  }, 30000);
});
