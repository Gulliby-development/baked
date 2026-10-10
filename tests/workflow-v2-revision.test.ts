import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest, RuntimeState } from "../src/core/workflows/types.js";
import type { Gate, WorkflowV2 } from "../src/core/workflows/v2/definition.js";
import { builtinPresets, instantiatePreset } from "../src/core/workflows/v2/definitions.js";
import { confirmGates, loadGateLibrary } from "../src/core/workflows/v2/library.js";
import { definitionRevisionProblems } from "../src/core/workflows/v2/revision.js";
import { autoApprovalHash } from "../src/core/workflows/v2/runtime.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const valueCheck = {
  id: "check",
  executable: "bun",
  args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [valueCheck] };

/** Plans one task that writes value.txt, implements it and passes every review. */
class FixtureExecutor implements AgentExecutor {
  calls: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      snapshotHash: string;
      spec: { featureId: string } | null;
      extra: { evidence?: { id: string }[] };
    };
    const spec = data.spec as Parameters<typeof hashJson>[0];
    let output: unknown;
    switch (request.profile.output) {
      case "plan": {
        const markdown =
          "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
        output = {
          schemaVersion: 1,
          markdown,
          taskGraph: {
            schemaVersion: 1,
            featureId: "fixture",
            revision: 1,
            specHash: hashJson(spec),
            planHash: hashBytes(markdown),
            tasks: [
              {
                id: "T001",
                title: "Create value",
                description: "Write ready",
                requirementIds: ["FR-001"],
                criterionIds: ["AC-001"],
                dependsOn: [],
                profileId: "implementer",
                writes: [{ path: "value.txt", action: "create" }],
                readHints: [],
                checkIds: [],
                origin: "planned",
                findingIds: [],
                rationale: "Required behavior",
              },
            ],
          },
        };
        break;
      }
      case "implementation":
        writeFileSync(join(this.root, "value.txt"), "ready\n");
        output = {
          schemaVersion: 1,
          taskId: request.task?.id,
          outcome: "implemented",
          summary: "Wrote value",
          evidenceIds: [],
          unresolved: [],
        };
        break;
      case "review": {
        const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
        output = {
          schemaVersion: 1,
          snapshotHash: data.snapshotHash,
          verdict: "pass",
          coverage: [
            {
              criterionId: "AC-001",
              verdict: "pass",
              evidenceIds: evidence,
              explanation: "Evidence checked",
            },
          ],
          findings: [],
        };
        break;
      }
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "baked-workflow-revision-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new FixtureExecutor(root);
  const config = {
    ...DEFAULT_CONFIG,
    defaultModel: "fixture/model",
    workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy },
  };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const artifacts = new WorkflowArtifacts(service);
  const definitionPath = (id: string) => join(root, "baked", "workflows", `${id}.json`);
  const define = (definition: WorkflowV2) => {
    mkdirSync(join(root, "baked", "workflows"), { recursive: true });
    writeFileSync(definitionPath(definition.id), JSON.stringify(definition));
  };
  const gate = (definition: Gate) => {
    mkdirSync(join(root, "baked", "gates"), { recursive: true });
    writeFileSync(join(root, "baked", "gates", `${definition.id}.json`), JSON.stringify(definition));
    confirmGates(root, loadGateLibrary(root, policy), [definition.id]);
  };
  const start = (workflowId: string) =>
    service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId,
      prompt: "Create ready value",
      ownerLabel: "test",
      policy,
    });
  const drive = (runId: string) => service.drive(runId, new AbortController().signal);
  const pending = (runId: string) =>
    service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  const approve = async (runId: string) => {
    const request = pending(runId);
    if (!request) throw new Error("No pending approval");
    const run = await service.get(runId);
    return service.decide(
      runId,
      { commandId: newId(), expectedRevision: run.revision },
      { kind: "approve", requestId: request.id, digest: request.digest },
    );
  };
  const complete = async (runId: string) => {
    for (let round = 0; round < 6; round++) {
      const snapshot = await drive(runId);
      if (snapshot.status !== "waiting" || !pending(runId)) return snapshot;
      await approve(runId);
    }
    return service.get(runId);
  };
  /** Stages a revised definition, as `candidate RUN_ID --workflow FILE` does. */
  const candidate = async (
    runId: string,
    definition: WorkflowV2,
    extra: { autoApprovalConfirmation?: string; path?: string } = {},
  ) =>
    artifacts.stageRevision(runId, {
      commandId: newId(),
      expectedInputHash: (await service.get(runId)).inputHash,
      definition,
      ...(extra.path ? { definitionPath: extra.path } : {}),
      ...(extra.autoApprovalConfirmation
        ? { autoApprovalConfirmation: extra.autoApprovalConfirmation }
        : {}),
    });
  const revise = async (runId: string, candidateHash: string) =>
    service.revise(
      runId,
      { commandId: newId(), expectedRevision: (await service.get(runId)).revision },
      candidateHash,
    );
  return {
    root,
    executor,
    service,
    define,
    definitionPath,
    gate,
    start,
    drive,
    pending,
    complete,
    candidate,
    revise,
  };
}

const quickFix = (patch: (definition: WorkflowV2) => WorkflowV2 = (d) => d): WorkflowV2 => {
  const preset = builtinPresets.get("quick-fix");
  if (!preset) throw new Error("quick-fix preset missing");
  return patch({ ...instantiatePreset(preset, policy), id: "custom-fix", preset: "custom" });
};
const commandGate = (id: string, args: string[]): Gate =>
  ({
    schemaVersion: 1,
    id,
    description: `Gate ${id}`,
    required: true,
    scope: "feature",
    timeoutMs: 10000,
    retries: { max: 0, retryOn: [] },
    evidence: { kind: "exit", keepOutputLines: 40, artifactPaths: [] },
    type: "command",
    command: { executable: "bun", args, cwd: ".", envNames: [], writes: [] },
  }) as Gate;
/** Quick fix with a review stage between the checks and completion. */
const withReview = (d: WorkflowV2): WorkflowV2 => ({
  ...d,
  stages: [
    ...d.stages,
    {
      id: "review",
      type: "review",
      consumes: ["implementation"],
      produces: "review",
      effects: "none",
      gates: [{ gateId: "correctness-review" }],
    },
  ],
  transitions: [
    ...d.transitions.filter((t) => t.id !== "checks-done"),
    { id: "checks-review", from: "checks", to: "review", on: "passed", carries: "gates", gates: [] },
    {
      id: "review-repair",
      from: "review",
      to: "implement",
      on: "changes_requested",
      carries: "review",
      gates: [],
      loop: { maxIterations: 2 },
    },
    { id: "review-done", from: "review", to: "done", on: "passed", carries: "review", gates: [] },
  ],
});
const position = (stageId: string, visits: Record<string, number>, outcome: "passed" | null = null) =>
  ({
    stageId,
    visits,
    loops: {},
    total: Object.values(visits).reduce((a, b) => a + b, 0),
    outcome,
    findings: [],
    repairKind: null,
  }) as NonNullable<RuntimeState["position"]>;
const faultOf = async (promise: Promise<unknown>): Promise<WorkflowFault> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkflowFault) return error;
    throw error;
  }
  throw new Error("Expected a workflow fault");
};

describe("V2-11 definition revision checks", () => {
  const current = quickFix();
  test("a revision that keeps the history and adds a later stage fits", () => {
    expect(
      definitionRevisionProblems(
        current,
        withReview(current),
        position("approve", { plan: 1, approve: 1 }),
        ["spec", "plan"],
        "approve",
      ),
    ).toEqual([]);
  });

  test("the current stage may not disappear or change its type", () => {
    const removed: WorkflowV2 = {
      ...current,
      stages: current.stages.filter((s) => s.id !== "checks"),
      transitions: current.transitions.filter((t) => t.from !== "checks" && t.to !== "checks"),
    };
    expect(
      definitionRevisionProblems(current, removed, position("checks", { plan: 1, approve: 1, implement: 1, checks: 1 }), [], "checks"),
    ).toContain("The current stage checks is not in the revised definition");
  });

  test("a completed stage may not disappear or change what it produces", () => {
    const renamed: WorkflowV2 = {
      ...current,
      entry: "draft",
      stages: current.stages.map((s) => (s.id === "plan" ? { ...s, id: "draft" } : s)),
      transitions: current.transitions.map((t) => (t.from === "plan" ? { ...t, from: "draft" } : t)),
    };
    const problems = definitionRevisionProblems(
      current,
      renamed,
      position("approve", { plan: 1, approve: 1 }),
      ["spec", "plan"],
      "approve",
    );
    expect(problems).toContain("The completed stage plan is not in the revised definition");
  });

  test("a consumer the run can no longer feed is rejected", () => {
    // A review stage that consumes research, which the run has passed without producing.
    const starved = withReview(current);
    const review = starved.stages.find((s) => s.id === "review");
    if (review) review.consumes = ["implementation", "research"];
    const problems = definitionRevisionProblems(
      current,
      starved,
      position("approve", { plan: 1, approve: 1 }),
      ["spec", "plan"],
      "approve",
    );
    expect(problems.some((p) => p.startsWith("review consumes research"))).toBe(true);
  });

  test("the workflow ID, its inputs and the visit budget are kept", () => {
    const problems = definitionRevisionProblems(
      current,
      { ...current, id: "other", inputs: ["diff"], limits: { maxStageVisits: 4 } },
      position("checks", { plan: 1, approve: 1, implement: 2, checks: 1 }),
      [],
      "checks",
    );
    expect(problems).toContain("A revision keeps the workflow ID custom-fix; start a new run to use other");
    expect(problems).toContain("A revision cannot change the inputs the run started with");
    expect(problems.some((p) => p.includes("more than maxStageVisits 4"))).toBe(true);
  });
});

describe("V2-11 revising a started run's definition", () => {
  test("an accepted revision supersedes the approval, needs a new one and runs the new stage", async () => {
    const { define, start, drive, pending, candidate, revise, complete, service, executor } = setup();
    define(quickFix());
    const run = await start("custom-fix");
    expect((await drive(run.runId)).status).toBe("waiting");
    const first = pending(run.runId);
    expect(first).toBeDefined();

    const staged = await candidate(run.runId, withReview(quickFix()));
    const revised = await revise(run.runId, staged.candidateHash);
    expect(revised.status).toBe("paused");
    expect(service.store.requests(run.runId).find((r) => r.id === first?.id)?.status).toBe("superseded");
    const stored = JSON.parse(service.store.run(run.runId).definition_json) as WorkflowV2;
    expect(stored.stages.map((s) => s.id)).toContain("review");
    const record = service.store.artifacts(run.runId).find((a) => a.kind === "definition-revision");
    expect(record).toBeDefined();
    expect(service.store.state(run.runId).manifest.workflowHash).toBe(hashJson(withReview(quickFix())));

    // The plan is approved again before anything is written.
    expect((await drive(run.runId)).status).toBe("waiting");
    const second = pending(run.runId);
    expect(second?.id).not.toBe(first?.id);
    const final = await complete(run.runId);
    expect(final.status).toBe("completed");
    expect(executor.calls).toContain("review");
  }, 60000);

  test("a run without a package keeps its stage and follows the edited definition file", async () => {
    const { define, definitionPath, start, candidate, revise, complete, service, executor, gate } = setup();
    gate(commandGate("extra-gate", ["-e", "process.exit(0)"]));
    define(quickFix());
    const run = await start("custom-fix");
    // The user edits the definition in place; the run notices only through a revision.
    const next = quickFix((d) => ({
      ...d,
      transitions: d.transitions.map((t) =>
        t.id === "checks-done" ? { ...t, gates: [{ gateId: "extra-gate" }] } : t,
      ),
    }));
    define(next);
    const staged = await candidate(run.runId, next, { path: definitionPath("custom-fix") });
    await revise(run.runId, staged.candidateHash);
    const state = service.store.state(run.runId);
    expect(state.position?.stageId).toBe("plan");
    expect(state.frozenFiles[definitionPath("custom-fix")]).toBeDefined();
    expect(Object.keys(state.frozenFiles).some((p) => p.endsWith("extra-gate.json"))).toBe(true);
    const final = await complete(run.runId);
    expect(final.status).toBe("completed");
    expect(executor.calls).toEqual(["plan", "implementation"]);
    expect(service.store.checks(run.runId).map((c) => c.check_id)).toContain("extra-gate");
  }, 60000);

  test("an edited definition file without a revision still stops the run", async () => {
    const { define, start, drive, service } = setup();
    define(quickFix());
    const run = await start("custom-fix");
    define(withReview(quickFix()));
    const snapshot = await drive(run.runId);
    expect(snapshot.status).toBe("blocked");
    expect(service.store.run(run.runId).reason).toBe("input_changed");
  }, 30000);

  test("a revision that drops the current stage is rejected with the reasons", async () => {
    const { define, start, drive, candidate, service } = setup();
    define(quickFix());
    const run = await start("custom-fix");
    await drive(run.runId);
    const before = service.store.run(run.runId).definition_json;
    // Still a valid definition, but the approval the run waits at is renamed.
    const broken = quickFix((d) => ({
      ...d,
      stages: d.stages.map((s) => (s.id === "approve" ? { ...s, id: "signoff" } : s)),
      transitions: d.transitions.map((t) => ({
        ...t,
        from: t.from === "approve" ? "signoff" : t.from,
        to: t.to === "approve" ? "signoff" : t.to,
      })),
    }));
    const fault = await faultOf(candidate(run.runId, broken));
    expect(fault.code).toBe("INVALID_DEFINITION");
    expect(fault.message).toContain("The current stage approve is not in the revised definition");
    expect(service.store.run(run.runId).definition_json).toBe(before);
  }, 30000);

  test("changed auto-approval limits need the operator's confirmation", async () => {
    const { define, start, drive, candidate, revise, service } = setup();
    define(quickFix());
    const run = await start("custom-fix");
    await drive(run.runId);
    const limits = {
      enabled: true as const,
      maxTasks: 3,
      maxFiles: 5,
      allowedPaths: ["value.txt"],
      allowDelete: false,
      allowNewDependencies: false as const,
      maxTotalTokens: 100000,
    };
    const auto = quickFix((d) => ({
      ...d,
      autoApproval: limits,
      stages: d.stages.map((s) => (s.type === "approval" ? { ...s, decision: "auto" as const } : s)),
    }));
    const fault = await faultOf(candidate(run.runId, auto));
    expect(fault.message).toContain("--confirm-auto-approval");
    const staged = await candidate(run.runId, auto, {
      autoApprovalConfirmation: autoApprovalHash(limits),
    });
    await revise(run.runId, staged.candidateHash);
    expect(JSON.parse(service.store.run(run.runId).policy_json).autoApproval).not.toBeNull();
    expect(service.store.artifacts(run.runId).some((a) => a.kind === "policy-revision")).toBe(true);
  }, 30000);

  test("a run of a schema 1 workflow keeps its definition", async () => {
    const { start, candidate } = setup();
    const run = await start("sdd");
    const fault = await faultOf(candidate(run.runId, quickFix((d) => ({ ...d, id: "sdd" }))));
    expect(fault.code).toBe("INVALID_DEFINITION");
    expect(fault.message).toContain("schema 1");
  });

  test("the CLI stages a definition revision with candidate --workflow", () => {
    const args = parseWorkflowArgs([
      "candidate",
      "RUN",
      "--workflow",
      "baked/workflows/custom-fix.json",
      "--confirm-auto-approval",
      "abc",
    ]);
    expect(args.flags.workflow).toBe("baked/workflows/custom-fix.json");
    expect(args.flags["confirm-auto-approval"]).toBe("abc");
  });
});
